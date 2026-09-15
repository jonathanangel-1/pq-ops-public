create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

-- These envelopes close every reducer input over its complete, ordered
-- evidence/version context. The base-table content hash is the envelope hash,
-- and the version identifier is derived from that same server-computed hash.

create table if not exists public.accepted_claim_envelopes (
  claim_version_id text primary key
    references public.accepted_claims(claim_version_id) on delete restrict,
  workspace_key text not null,
  envelope_hash text not null unique check (envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope_schema_version text not null,
  canonical_envelope jsonb not null check (jsonb_typeof(canonical_envelope) = 'object'),
  created_at timestamptz not null default now(),
  check (claim_version_id = 'claim:v1:' || envelope_hash)
);

create table if not exists public.observation_entity_link_envelopes (
  link_version_id text primary key
    references public.observation_entity_links(link_version_id) on delete restrict,
  workspace_key text not null,
  envelope_hash text not null unique check (envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope_schema_version text not null,
  canonical_envelope jsonb not null check (jsonb_typeof(canonical_envelope) = 'object'),
  created_at timestamptz not null default now(),
  check (link_version_id = 'link:v1:' || envelope_hash)
);

create table if not exists public.operational_workgroup_envelopes (
  workgroup_id text primary key
    references public.operational_workgroups_v2(workgroup_id) on delete restrict,
  workspace_key text not null,
  identity_key text not null,
  definition_hash text not null unique check (definition_hash ~ '^[0-9a-f]{64}$'),
  envelope_schema_version text not null,
  canonical_definition jsonb not null check (jsonb_typeof(canonical_definition) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_key, identity_key),
  check (workgroup_id = 'workgroup:v1:' || definition_hash)
);

create table if not exists public.operational_workgroup_membership_evidence (
  membership_version_id text not null
    references public.operational_workgroup_memberships(membership_version_id) on delete restrict,
  observation_id text not null
    references public.source_observations(observation_id) on delete restrict,
  evidence_role text not null
    check (evidence_role = any (array['primary', 'supporting', 'contradicting'])),
  evidence_span jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence_span) = 'object'),
  primary key (membership_version_id, observation_id)
);

create table if not exists public.operational_workgroup_membership_envelopes (
  membership_version_id text primary key
    references public.operational_workgroup_memberships(membership_version_id) on delete restrict,
  workspace_key text not null,
  workgroup_id text not null
    references public.operational_workgroups_v2(workgroup_id) on delete restrict,
  envelope_hash text not null unique check (envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope_schema_version text not null,
  canonical_envelope jsonb not null check (jsonb_typeof(canonical_envelope) = 'object'),
  created_at timestamptz not null default now(),
  check (membership_version_id = 'membership:v1:' || envelope_hash)
);

create index if not exists accepted_claim_envelopes_workspace_idx
  on public.accepted_claim_envelopes (workspace_key, created_at);
create index if not exists observation_entity_link_envelopes_workspace_idx
  on public.observation_entity_link_envelopes (workspace_key, created_at);
create index if not exists operational_workgroup_membership_evidence_observation_idx
  on public.operational_workgroup_membership_evidence (observation_id, membership_version_id);
create index if not exists operational_workgroup_membership_envelopes_workspace_idx
  on public.operational_workgroup_membership_envelopes (workspace_key, workgroup_id, created_at);

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'accepted_claim_envelopes',
    'observation_entity_link_envelopes',
    'operational_workgroup_envelopes',
    'operational_workgroup_membership_evidence',
    'operational_workgroup_membership_envelopes'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',
      v_table,
      v_table
    );
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('grant select on public.%I to service_role', v_table);
  end loop;
end;
$block$;

create or replace function private.canonical_truth_timestamp(p_value timestamptz)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD')
    || 'T'
    || to_char(p_value at time zone 'UTC', 'HH24:MI:SS.US')
    || 'Z';
$function$;

create or replace function private.truth_jsonb_has_only_keys(
  p_value jsonb,
  p_allowed_keys text[]
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from jsonb_object_keys(p_value) as supplied(key)
      where not (supplied.key = any (p_allowed_keys))
    );
$function$;

create or replace function private.authoritative_truth_input_hash(
  p_item_kind text,
  p_item_id text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_hash text;
begin
  case p_item_kind
    when 'accepted_claim' then
      select envelope.envelope_hash into v_hash
      from public.accepted_claim_envelopes envelope
      join public.accepted_claims claim
        on claim.claim_version_id = envelope.claim_version_id
       and claim.claim_content_hash = envelope.envelope_hash
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'),
         'sha256'
       ), 'hex')
      where envelope.claim_version_id = p_item_id;
    when 'entity_link' then
      select envelope.envelope_hash into v_hash
      from public.observation_entity_link_envelopes envelope
      join public.observation_entity_links entity_link
        on entity_link.link_version_id = envelope.link_version_id
       and entity_link.content_hash = envelope.envelope_hash
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'),
         'sha256'
       ), 'hex')
      where envelope.link_version_id = p_item_id;
    when 'workgroup_membership' then
      select envelope.envelope_hash into v_hash
      from public.operational_workgroup_membership_envelopes envelope
      join public.operational_workgroup_memberships membership
        on membership.membership_version_id = envelope.membership_version_id
       and membership.content_hash = envelope.envelope_hash
       and membership.workgroup_id = envelope.workgroup_id
       and envelope.envelope_hash = encode(extensions.digest(
         convert_to(envelope.canonical_envelope::text, 'UTF8'),
         'sha256'
       ), 'hex')
      join public.operational_workgroup_envelopes workgroup_envelope
        on workgroup_envelope.workgroup_id = envelope.workgroup_id
       and workgroup_envelope.workspace_key = envelope.workspace_key
       and workgroup_envelope.definition_hash = encode(extensions.digest(
         convert_to(workgroup_envelope.canonical_definition::text, 'UTF8'),
         'sha256'
       ), 'hex')
      where envelope.membership_version_id = p_item_id;
    else
      raise exception 'unsupported truth build input kind' using errcode = '22023';
  end case;
  if v_hash is null then
    raise exception 'authoritative truth build input is unavailable' using errcode = '23503';
  end if;
  return v_hash;
end;
$function$;

create or replace function private.append_observation_entity_link(
  p_workspace_key text,
  p_link jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_link_key text;
  v_version_no integer;
  v_previous_link_version_id text;
  v_previous_hash text := '';
  v_previous_link public.observation_entity_links%rowtype;
  v_observation public.source_observations%rowtype;
  v_confidence numeric;
  v_recorded_at timestamptz;
  v_envelope jsonb;
  v_envelope_hash text;
  v_link_version_id text;
  v_existing_envelope public.observation_entity_link_envelopes%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or jsonb_typeof(coalesce(p_link, 'null'::jsonb)) <> 'object' then
    raise exception 'observation entity link request is invalid' using errcode = '22023';
  end if;
  if not private.truth_jsonb_has_only_keys(p_link, array[
    'linkKey', 'versionNo', 'previousLinkVersionId', 'observationId',
    'entityType', 'entityKey', 'relationship', 'decision', 'confidence',
    'linkMethod', 'linkerVersion', 'evidenceSpan', 'recordedAt', 'schemaVersion'
  ]) then
    raise exception 'observation entity link contains unsupported fields' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'linkKey', 'observationId', 'entityType', 'entityKey', 'relationship',
      'decision', 'linkMethod', 'linkerVersion', 'recordedAt', 'schemaVersion'
    ]) as required_key
    where nullif(trim(coalesce(p_link->>required_key, '')), '') is null
  ) then
    raise exception 'observation entity link required fields are incomplete' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(p_link->'versionNo', 'null'::jsonb)) <> 'number'
    or coalesce(p_link->>'versionNo', '') !~ '^[1-9][0-9]*$'
    or length(p_link->>'versionNo') > 10 then
    raise exception 'observation entity link version is invalid' using errcode = '22023';
  end if;
  if (p_link->>'versionNo')::numeric > 2147483647 then
    raise exception 'observation entity link version is invalid' using errcode = '22023';
  end if;
  v_version_no := (p_link->>'versionNo')::integer;
  v_link_key := p_link->>'linkKey';
  v_previous_link_version_id := nullif(coalesce(p_link->>'previousLinkVersionId', ''), '');
  if p_link ? 'previousLinkVersionId'
    and jsonb_typeof(p_link->'previousLinkVersionId') not in ('string', 'null') then
    raise exception 'observation entity link previous identifier is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_link->'confidence', 'null'::jsonb)) <> 'number' then
    raise exception 'observation entity link confidence is invalid' using errcode = '22023';
  end if;
  v_confidence := (p_link->>'confidence')::numeric;
  if v_confidence < 0 or v_confidence > 1
    or v_confidence is distinct from round(v_confidence, 6) then
    raise exception 'observation entity link confidence is outside the canonical range'
      using errcode = '22023';
  end if;
  v_confidence := trim_scale(v_confidence);
  if jsonb_typeof(coalesce(p_link->'evidenceSpan', '{}'::jsonb)) <> 'object' then
    raise exception 'observation entity link evidence span must be an object'
      using errcode = '22023';
  end if;
  if not (p_link->>'decision' = any (array['linked', 'unlinked']))
    or not (p_link->>'linkMethod' = any (array['deterministic', 'model', 'operator'])) then
    raise exception 'observation entity link enum value is invalid' using errcode = '22023';
  end if;
  v_recorded_at := (p_link->>'recordedAt')::timestamptz;
  select * into v_observation
  from public.source_observations
  where observation_id = p_link->>'observationId'
    and workspace_key = p_workspace_key;
  if not found then
    raise exception 'observation entity link evidence is outside the workspace'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'entity-link:' || p_workspace_key || ':' || v_link_key,
    0
  ));
  if v_version_no = 1 then
    if v_previous_link_version_id is not null then
      raise exception 'observation entity link version one cannot have a previous version'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from public.observation_entity_links
      where link_key = v_link_key and version_no <> 1
    ) then
      raise exception 'observation entity link version chain does not start at one'
        using errcode = '23514';
    end if;
  else
    if v_previous_link_version_id is null then
      raise exception 'observation entity link version chain is incomplete'
        using errcode = '23514';
    end if;
    select prior.*
    into v_previous_link
    from public.observation_entity_links prior
    join public.observation_entity_link_envelopes envelope
      on envelope.link_version_id = prior.link_version_id
     and envelope.workspace_key = p_workspace_key
     and envelope.envelope_hash = prior.content_hash
    where prior.link_version_id = v_previous_link_version_id;
    if not found
      or v_previous_link.link_key is distinct from v_link_key
      or v_previous_link.version_no <> v_version_no - 1
      or v_previous_link.observation_id is distinct from v_observation.observation_id
      or v_previous_link.entity_type is distinct from p_link->>'entityType'
      or v_previous_link.entity_key is distinct from p_link->>'entityKey'
      or v_previous_link.relationship is distinct from p_link->>'relationship' then
      raise exception 'observation entity link previous version is not the exact chain predecessor'
        using errcode = '23514';
    end if;
    v_previous_hash := v_previous_link.content_hash;
  end if;

  v_envelope := jsonb_build_object(
    'envelopeSchemaVersion', 'observation-entity-link-envelope-v1',
    'workspaceKey', p_workspace_key,
    'link', jsonb_build_object(
      'linkKey', v_link_key,
      'versionNo', v_version_no,
      'previousLinkVersionId', coalesce(v_previous_link_version_id, ''),
      'previousLinkItemHash', v_previous_hash,
      'observationId', v_observation.observation_id,
      'observationContentHash', v_observation.content_hash,
      'entityType', p_link->>'entityType',
      'entityKey', p_link->>'entityKey',
      'relationship', p_link->>'relationship',
      'decision', p_link->>'decision',
      'confidence', v_confidence,
      'linkMethod', p_link->>'linkMethod',
      'linkerVersion', p_link->>'linkerVersion',
      'evidenceSpan', coalesce(p_link->'evidenceSpan', '{}'::jsonb),
      'recordedAt', private.canonical_truth_timestamp(v_recorded_at),
      'schemaVersion', p_link->>'schemaVersion'
    )
  );
  v_envelope_hash := encode(extensions.digest(
    convert_to(v_envelope::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_link_version_id := 'link:v1:' || v_envelope_hash;

  select * into v_existing_envelope
  from public.observation_entity_link_envelopes
  where link_version_id = v_link_version_id;
  if found then
    if v_existing_envelope.workspace_key is distinct from p_workspace_key
      or v_existing_envelope.canonical_envelope is distinct from v_envelope then
      raise exception 'observation entity link envelope hash collision' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'linkVersionId', v_link_version_id,
      'itemHash', v_envelope_hash,
      'workspaceKey', p_workspace_key,
      'versionNo', v_version_no
    );
  end if;
  if exists (
    select 1 from public.observation_entity_links
    where link_key = v_link_key and version_no = v_version_no
  ) then
    raise exception 'observation entity link logical version already has a different envelope'
      using errcode = '23505';
  end if;

  insert into public.observation_entity_links (
    link_version_id, link_key, version_no, previous_link_version_id,
    observation_id, entity_type, entity_key, relationship, decision,
    confidence, link_method, linker_version, evidence_span, recorded_at,
    content_hash
  ) values (
    v_link_version_id, v_link_key, v_version_no, v_previous_link_version_id,
    v_observation.observation_id, p_link->>'entityType', p_link->>'entityKey',
    p_link->>'relationship', p_link->>'decision', v_confidence,
    p_link->>'linkMethod', p_link->>'linkerVersion',
    coalesce(p_link->'evidenceSpan', '{}'::jsonb), v_recorded_at,
    v_envelope_hash
  );
  insert into public.observation_entity_link_envelopes (
    link_version_id, workspace_key, envelope_hash,
    envelope_schema_version, canonical_envelope
  ) values (
    v_link_version_id, p_workspace_key, v_envelope_hash,
    'observation-entity-link-envelope-v1', v_envelope
  );

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'linkVersionId', v_link_version_id,
    'itemHash', v_envelope_hash,
    'workspaceKey', p_workspace_key,
    'versionNo', v_version_no
  );
end;
$function$;

revoke all on function private.canonical_truth_timestamp(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_jsonb_has_only_keys(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.authoritative_truth_input_hash(text, text)
  from public, anon, authenticated, service_role;

create or replace function private.append_accepted_claim(
  p_workspace_key text,
  p_claim jsonb,
  p_evidence jsonb,
  p_supersessions jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claim_key text;
  v_version_no integer;
  v_previous_claim_version_id text;
  v_previous_hash text := '';
  v_previous_claim public.accepted_claims%rowtype;
  v_primary_observation public.source_observations%rowtype;
  v_confidence numeric;
  v_occurred_at timestamptz;
  v_recorded_at timestamptz;
  v_evidence_count integer;
  v_evidence_distinct_count integer;
  v_primary_count integer;
  v_evidence_manifest jsonb;
  v_supersession_count integer;
  v_supersession_distinct_count integer;
  v_supersession_manifest jsonb;
  v_envelope jsonb;
  v_envelope_hash text;
  v_claim_version_id text;
  v_existing_envelope public.accepted_claim_envelopes%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or jsonb_typeof(coalesce(p_claim, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_evidence, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_supersessions, 'null'::jsonb)) <> 'array' then
    raise exception 'accepted claim envelope request is invalid' using errcode = '22023';
  end if;
  if not private.truth_jsonb_has_only_keys(p_claim, array[
    'claimKey', 'versionNo', 'previousClaimVersionId', 'primaryObservationId',
    'subjectType', 'subjectKey', 'predicate', 'gate', 'polarity',
    'normalizedValue', 'occurredAt', 'confidence', 'confidenceLabel',
    'extractionMethod', 'extractorVersion', 'promptVersion', 'model',
    'acceptanceMethod', 'acceptancePolicyVersion', 'acceptedBy', 'decision',
    'evidenceSpan', 'recordedAt', 'schemaVersion'
  ]) then
    raise exception 'accepted claim contains unsupported fields' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'claimKey', 'primaryObservationId', 'subjectType', 'subjectKey',
      'predicate', 'gate', 'polarity', 'confidenceLabel', 'extractionMethod',
      'extractorVersion', 'acceptanceMethod', 'acceptancePolicyVersion',
      'acceptedBy', 'decision', 'recordedAt', 'schemaVersion'
    ]) as required_key
    where nullif(trim(coalesce(p_claim->>required_key, '')), '') is null
  ) then
    raise exception 'accepted claim required fields are incomplete' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(p_claim->'versionNo', 'null'::jsonb)) <> 'number'
    or coalesce(p_claim->>'versionNo', '') !~ '^[1-9][0-9]*$'
    or length(p_claim->>'versionNo') > 10 then
    raise exception 'accepted claim version is invalid' using errcode = '22023';
  end if;
  if (p_claim->>'versionNo')::numeric > 2147483647 then
    raise exception 'accepted claim version is invalid' using errcode = '22023';
  end if;
  v_version_no := (p_claim->>'versionNo')::integer;
  v_claim_key := p_claim->>'claimKey';
  v_previous_claim_version_id := nullif(coalesce(p_claim->>'previousClaimVersionId', ''), '');
  if p_claim ? 'previousClaimVersionId'
    and jsonb_typeof(p_claim->'previousClaimVersionId') not in ('string', 'null') then
    raise exception 'accepted claim previous version identifier is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_claim->'confidence', 'null'::jsonb)) <> 'number' then
    raise exception 'accepted claim confidence is invalid' using errcode = '22023';
  end if;
  v_confidence := (p_claim->>'confidence')::numeric;
  if v_confidence < 0 or v_confidence > 1
    or v_confidence is distinct from round(v_confidence, 6) then
    raise exception 'accepted claim confidence is outside the canonical range' using errcode = '22023';
  end if;
  v_confidence := trim_scale(v_confidence);
  if jsonb_typeof(coalesce(p_claim->'normalizedValue', '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_claim->'evidenceSpan', '{}'::jsonb)) <> 'object' then
    raise exception 'accepted claim values and evidence span must be objects' using errcode = '22023';
  end if;
  if p_claim ? 'occurredAt'
    and jsonb_typeof(p_claim->'occurredAt') not in ('string', 'null') then
    raise exception 'accepted claim occurredAt is invalid' using errcode = '22023';
  end if;
  if nullif(coalesce(p_claim->>'occurredAt', ''), '') is not null then
    v_occurred_at := (p_claim->>'occurredAt')::timestamptz;
  end if;
  v_recorded_at := (p_claim->>'recordedAt')::timestamptz;
  if not (p_claim->>'polarity' = any (array['positive', 'negative', 'requested', 'neutral', 'unknown']))
    or not (p_claim->>'extractionMethod' = any (array['deterministic', 'model', 'operator']))
    or not (p_claim->>'acceptanceMethod' = any (array['policy', 'operator']))
    or not (p_claim->>'decision' = any (array['accepted', 'revoked'])) then
    raise exception 'accepted claim enum value is invalid' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_evidence) item
    where jsonb_typeof(item) <> 'object'
  ) then
    raise exception 'accepted claim evidence entries must be objects' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_evidence) item
    where not private.truth_jsonb_has_only_keys(
      item,
      array['observationId', 'evidenceRole', 'evidenceSpan']
    )
      or nullif(trim(coalesce(item->>'observationId', '')), '') is null
      or not (coalesce(item->>'evidenceRole', '') = any (
        array['primary', 'supporting', 'contradicting']
      ))
      or jsonb_typeof(coalesce(item->'evidenceSpan', '{}'::jsonb)) <> 'object'
  ) then
    raise exception 'accepted claim evidence entry is invalid' using errcode = '23514';
  end if;
  select count(*)::integer,
         count(distinct (item->>'observationId'))::integer,
         count(*) filter (where item->>'evidenceRole' = 'primary')::integer
  into v_evidence_count, v_evidence_distinct_count, v_primary_count
  from jsonb_array_elements(p_evidence) item;
  if v_evidence_count = 0
    or v_evidence_count <> v_evidence_distinct_count
    or v_primary_count <> 1 then
    raise exception 'accepted claim requires a complete evidence set with one primary observation'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_evidence) item
    left join public.source_observations observation
      on observation.observation_id = item->>'observationId'
    where observation.observation_id is null
      or observation.workspace_key is distinct from p_workspace_key
  ) then
    raise exception 'accepted claim evidence is outside the workspace' using errcode = '23503';
  end if;
  select observation.* into v_primary_observation
  from jsonb_array_elements(p_evidence) item
  join public.source_observations observation
    on observation.observation_id = item->>'observationId'
  where item->>'evidenceRole' = 'primary';
  if v_primary_observation.observation_id is distinct from p_claim->>'primaryObservationId' then
    raise exception 'accepted claim primary evidence does not match primaryObservationId'
      using errcode = '23514';
  end if;
  select jsonb_agg(jsonb_build_object(
    'observationId', observation.observation_id,
    'observationContentHash', observation.content_hash,
    'evidenceRole', item->>'evidenceRole',
    'evidenceSpan', coalesce(item->'evidenceSpan', '{}'::jsonb)
  ) order by observation.observation_id, item->>'evidenceRole')
  into v_evidence_manifest
  from jsonb_array_elements(p_evidence) item
  join public.source_observations observation
    on observation.observation_id = item->>'observationId';

  if exists (
    select 1 from jsonb_array_elements(p_supersessions) item
    where jsonb_typeof(item) <> 'object'
  ) then
    raise exception 'accepted claim supersession entries must be objects' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_supersessions) item
    where not private.truth_jsonb_has_only_keys(
      item,
      array['supersededClaimVersionId', 'relationship', 'policyVersion']
    )
      or nullif(trim(coalesce(item->>'supersededClaimVersionId', '')), '') is null
      or not (coalesce(item->>'relationship', '') = any (
        array['corrects', 'resolves', 'contradicts']
      ))
      or nullif(trim(coalesce(item->>'policyVersion', '')), '') is null
  ) then
    raise exception 'accepted claim supersession entry is invalid' using errcode = '23514';
  end if;
  select count(*)::integer,
         count(distinct (item->>'supersededClaimVersionId'))::integer
  into v_supersession_count, v_supersession_distinct_count
  from jsonb_array_elements(p_supersessions) item;
  if v_supersession_count <> v_supersession_distinct_count then
    raise exception 'accepted claim supersession identities must be unique' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_supersessions) item
    left join public.accepted_claims superseded
      on superseded.claim_version_id = item->>'supersededClaimVersionId'
    left join public.accepted_claim_envelopes envelope
      on envelope.claim_version_id = superseded.claim_version_id
    where superseded.claim_version_id is null
      or envelope.claim_version_id is null
      or envelope.workspace_key is distinct from p_workspace_key
      or superseded.claim_content_hash is distinct from envelope.envelope_hash
      or (
        superseded.claim_key = v_claim_key
        and superseded.version_no >= v_version_no
      )
  ) then
    raise exception 'accepted claim supersession target is unavailable or outside the workspace'
      using errcode = '23503';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'supersededClaimVersionId', superseded.claim_version_id,
    'supersededItemHash', envelope.envelope_hash,
    'relationship', item->>'relationship',
    'policyVersion', item->>'policyVersion'
  ) order by superseded.claim_version_id), '[]'::jsonb)
  into v_supersession_manifest
  from jsonb_array_elements(p_supersessions) item
  join public.accepted_claims superseded
    on superseded.claim_version_id = item->>'supersededClaimVersionId'
  join public.accepted_claim_envelopes envelope
    on envelope.claim_version_id = superseded.claim_version_id;

  perform pg_advisory_xact_lock(hashtextextended(
    'accepted-claim:' || p_workspace_key || ':' || v_claim_key,
    0
  ));
  if v_version_no = 1 then
    if v_previous_claim_version_id is not null then
      raise exception 'accepted claim version one cannot have a previous version'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from public.accepted_claims
      where claim_key = v_claim_key and version_no <> 1
    ) then
      raise exception 'accepted claim version chain does not start at one' using errcode = '23514';
    end if;
  else
    if v_previous_claim_version_id is null then
      raise exception 'accepted claim version chain is incomplete' using errcode = '23514';
    end if;
    select previous.*
    into v_previous_claim
    from public.accepted_claims previous
    join public.accepted_claim_envelopes envelope
      on envelope.claim_version_id = previous.claim_version_id
     and envelope.workspace_key = p_workspace_key
     and envelope.envelope_hash = previous.claim_content_hash
    where previous.claim_version_id = v_previous_claim_version_id;
    if not found
      or v_previous_claim.claim_key is distinct from v_claim_key
      or v_previous_claim.version_no <> v_version_no - 1
      or v_previous_claim.subject_type is distinct from p_claim->>'subjectType'
      or v_previous_claim.subject_key is distinct from p_claim->>'subjectKey'
      or v_previous_claim.predicate is distinct from p_claim->>'predicate'
      or v_previous_claim.gate is distinct from p_claim->>'gate' then
      raise exception 'accepted claim previous version is not the exact chain predecessor'
        using errcode = '23514';
    end if;
    v_previous_hash := v_previous_claim.claim_content_hash;
  end if;

  v_envelope := jsonb_build_object(
    'envelopeSchemaVersion', 'accepted-claim-envelope-v1',
    'workspaceKey', p_workspace_key,
    'claim', jsonb_build_object(
      'claimKey', v_claim_key,
      'versionNo', v_version_no,
      'previousClaimVersionId', coalesce(v_previous_claim_version_id, ''),
      'previousClaimItemHash', v_previous_hash,
      'primaryObservationId', v_primary_observation.observation_id,
      'primaryObservationContentHash', v_primary_observation.content_hash,
      'subjectType', p_claim->>'subjectType',
      'subjectKey', p_claim->>'subjectKey',
      'predicate', p_claim->>'predicate',
      'gate', p_claim->>'gate',
      'polarity', p_claim->>'polarity',
      'normalizedValue', coalesce(p_claim->'normalizedValue', '{}'::jsonb),
      'occurredAt', case
        when v_occurred_at is null then null
        else private.canonical_truth_timestamp(v_occurred_at)
      end,
      'capturedAt', private.canonical_truth_timestamp(v_primary_observation.captured_at),
      'recordedAt', private.canonical_truth_timestamp(v_recorded_at),
      'confidence', v_confidence,
      'confidenceLabel', p_claim->>'confidenceLabel',
      'extractionMethod', p_claim->>'extractionMethod',
      'extractorVersion', p_claim->>'extractorVersion',
      'promptVersion', coalesce(p_claim->>'promptVersion', ''),
      'model', coalesce(p_claim->>'model', ''),
      'acceptanceMethod', p_claim->>'acceptanceMethod',
      'acceptancePolicyVersion', p_claim->>'acceptancePolicyVersion',
      'acceptedBy', p_claim->>'acceptedBy',
      'decision', p_claim->>'decision',
      'evidenceSpan', coalesce(p_claim->'evidenceSpan', '{}'::jsonb),
      'schemaVersion', p_claim->>'schemaVersion'
    ),
    'evidence', v_evidence_manifest,
    'supersessions', v_supersession_manifest
  );
  v_envelope_hash := encode(extensions.digest(
    convert_to(v_envelope::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_claim_version_id := 'claim:v1:' || v_envelope_hash;

  select * into v_existing_envelope
  from public.accepted_claim_envelopes
  where claim_version_id = v_claim_version_id;
  if found then
    if v_existing_envelope.workspace_key is distinct from p_workspace_key
      or v_existing_envelope.canonical_envelope is distinct from v_envelope then
      raise exception 'accepted claim envelope hash collision' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'claimVersionId', v_claim_version_id,
      'itemHash', v_envelope_hash,
      'workspaceKey', p_workspace_key,
      'versionNo', v_version_no,
      'evidenceCount', v_evidence_count,
      'supersessionCount', v_supersession_count
    );
  end if;
  if exists (
    select 1 from public.accepted_claims
    where claim_key = v_claim_key and version_no = v_version_no
  ) then
    raise exception 'accepted claim logical version already has a different envelope'
      using errcode = '23505';
  end if;

  insert into public.accepted_claims (
    claim_version_id, claim_key, version_no, previous_claim_version_id,
    primary_observation_id, subject_type, subject_key, predicate, gate,
    polarity, normalized_value, occurred_at, captured_at, recorded_at,
    confidence, confidence_label, extraction_method, extractor_version,
    prompt_version, model, acceptance_method, acceptance_policy_version,
    accepted_by, decision, evidence_span, claim_content_hash, schema_version
  ) values (
    v_claim_version_id, v_claim_key, v_version_no, v_previous_claim_version_id,
    v_primary_observation.observation_id, p_claim->>'subjectType',
    p_claim->>'subjectKey', p_claim->>'predicate', p_claim->>'gate',
    p_claim->>'polarity', coalesce(p_claim->'normalizedValue', '{}'::jsonb),
    v_occurred_at, v_primary_observation.captured_at, v_recorded_at,
    v_confidence, p_claim->>'confidenceLabel', p_claim->>'extractionMethod',
    p_claim->>'extractorVersion', coalesce(p_claim->>'promptVersion', ''),
    coalesce(p_claim->>'model', ''), p_claim->>'acceptanceMethod',
    p_claim->>'acceptancePolicyVersion', p_claim->>'acceptedBy',
    p_claim->>'decision', coalesce(p_claim->'evidenceSpan', '{}'::jsonb),
    v_envelope_hash, p_claim->>'schemaVersion'
  );

  insert into public.accepted_claim_evidence (
    claim_version_id, observation_id, evidence_role, evidence_span
  )
  select v_claim_version_id,
         item->>'observationId',
         item->>'evidenceRole',
         coalesce(item->'evidenceSpan', '{}'::jsonb)
  from jsonb_array_elements(p_evidence) item;

  insert into public.claim_supersessions (
    resolving_claim_version_id, superseded_claim_version_id,
    relationship, policy_version
  )
  select v_claim_version_id,
         item->>'supersededClaimVersionId',
         item->>'relationship',
         item->>'policyVersion'
  from jsonb_array_elements(p_supersessions) item;

  insert into public.accepted_claim_envelopes (
    claim_version_id, workspace_key, envelope_hash,
    envelope_schema_version, canonical_envelope
  ) values (
    v_claim_version_id, p_workspace_key, v_envelope_hash,
    'accepted-claim-envelope-v1', v_envelope
  );

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'claimVersionId', v_claim_version_id,
    'itemHash', v_envelope_hash,
    'workspaceKey', p_workspace_key,
    'versionNo', v_version_no,
    'evidenceCount', v_evidence_count,
    'supersessionCount', v_supersession_count
  );
end;
$function$;

create or replace function private.append_operational_workgroup_membership(
  p_workspace_key text,
  p_workgroup jsonb,
  p_membership jsonb,
  p_evidence jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_workgroup_confidence numeric;
  v_workgroup_created_at timestamptz;
  v_workgroup_definition jsonb;
  v_workgroup_hash text;
  v_workgroup_id text;
  v_existing_workgroup public.operational_workgroups_v2%rowtype;
  v_existing_workgroup_envelope public.operational_workgroup_envelopes%rowtype;
  v_workgroup_created boolean := false;
  v_membership_key text;
  v_version_no integer;
  v_previous_membership_version_id text;
  v_previous_hash text := '';
  v_previous_membership public.operational_workgroup_memberships%rowtype;
  v_membership_confidence numeric;
  v_membership_recorded_at timestamptz;
  v_primary_observation_id text;
  v_basis_observation_id text;
  v_evidence_count integer;
  v_evidence_distinct_count integer;
  v_primary_count integer;
  v_evidence_manifest jsonb;
  v_membership_envelope jsonb;
  v_membership_hash text;
  v_membership_version_id text;
  v_existing_membership_envelope public.operational_workgroup_membership_envelopes%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or jsonb_typeof(coalesce(p_workgroup, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_membership, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_evidence, 'null'::jsonb)) <> 'array' then
    raise exception 'operational workgroup membership request is invalid'
      using errcode = '22023';
  end if;
  if not private.truth_jsonb_has_only_keys(p_workgroup, array[
    'workgroupType', 'identityKey', 'identityBasis', 'createdMethod',
    'linkerVersion', 'initialConfidence', 'createdAt', 'schemaVersion'
  ]) then
    raise exception 'operational workgroup definition contains unsupported fields'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'workgroupType', 'identityKey', 'createdMethod', 'linkerVersion',
      'createdAt', 'schemaVersion'
    ]) as required_key
    where nullif(trim(coalesce(p_workgroup->>required_key, '')), '') is null
  ) then
    raise exception 'operational workgroup definition is incomplete' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(p_workgroup->'identityBasis', '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_workgroup->'initialConfidence', 'null'::jsonb)) <> 'number' then
    raise exception 'operational workgroup definition values are invalid'
      using errcode = '22023';
  end if;
  if not (p_workgroup->>'createdMethod' = any (array['deterministic', 'model', 'operator'])) then
    raise exception 'operational workgroup creation method is invalid' using errcode = '22023';
  end if;
  v_workgroup_confidence := (p_workgroup->>'initialConfidence')::numeric;
  if v_workgroup_confidence < 0 or v_workgroup_confidence > 1
    or v_workgroup_confidence is distinct from round(v_workgroup_confidence, 6) then
    raise exception 'operational workgroup confidence is outside the canonical range'
      using errcode = '22023';
  end if;
  v_workgroup_confidence := trim_scale(v_workgroup_confidence);
  v_workgroup_created_at := (p_workgroup->>'createdAt')::timestamptz;
  v_workgroup_definition := jsonb_build_object(
    'envelopeSchemaVersion', 'operational-workgroup-definition-envelope-v1',
    'workspaceKey', p_workspace_key,
    'workgroup', jsonb_build_object(
      'workgroupType', p_workgroup->>'workgroupType',
      'identityKey', p_workgroup->>'identityKey',
      'identityBasis', coalesce(p_workgroup->'identityBasis', '{}'::jsonb),
      'createdMethod', p_workgroup->>'createdMethod',
      'linkerVersion', p_workgroup->>'linkerVersion',
      'initialConfidence', v_workgroup_confidence,
      'createdAt', private.canonical_truth_timestamp(v_workgroup_created_at),
      'schemaVersion', p_workgroup->>'schemaVersion'
    )
  );
  v_workgroup_hash := encode(extensions.digest(
    convert_to(v_workgroup_definition::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_workgroup_id := 'workgroup:v1:' || v_workgroup_hash;

  if not private.truth_jsonb_has_only_keys(p_membership, array[
    'membershipKey', 'versionNo', 'previousMembershipVersionId',
    'memberType', 'memberKey', 'role', 'decision', 'confidence',
    'membershipMethod', 'linkerVersion', 'basisObservationId',
    'recordedAt', 'schemaVersion'
  ]) then
    raise exception 'operational workgroup membership contains unsupported fields'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'membershipKey', 'memberType', 'memberKey', 'role', 'decision',
      'membershipMethod', 'linkerVersion', 'recordedAt', 'schemaVersion'
    ]) as required_key
    where nullif(trim(coalesce(p_membership->>required_key, '')), '') is null
  ) then
    raise exception 'operational workgroup membership required fields are incomplete'
      using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(p_membership->'versionNo', 'null'::jsonb)) <> 'number'
    or coalesce(p_membership->>'versionNo', '') !~ '^[1-9][0-9]*$'
    or length(p_membership->>'versionNo') > 10 then
    raise exception 'operational workgroup membership version is invalid'
      using errcode = '22023';
  end if;
  if (p_membership->>'versionNo')::numeric > 2147483647 then
    raise exception 'operational workgroup membership version is invalid'
      using errcode = '22023';
  end if;
  v_version_no := (p_membership->>'versionNo')::integer;
  v_membership_key := p_membership->>'membershipKey';
  v_previous_membership_version_id := nullif(
    coalesce(p_membership->>'previousMembershipVersionId', ''),
    ''
  );
  if p_membership ? 'previousMembershipVersionId'
    and jsonb_typeof(p_membership->'previousMembershipVersionId') not in ('string', 'null') then
    raise exception 'operational workgroup previous membership identifier is invalid'
      using errcode = '22023';
  end if;
  v_basis_observation_id := nullif(coalesce(p_membership->>'basisObservationId', ''), '');
  if p_membership ? 'basisObservationId'
    and jsonb_typeof(p_membership->'basisObservationId') not in ('string', 'null') then
    raise exception 'operational workgroup basis observation identifier is invalid'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_membership->'confidence', 'null'::jsonb)) <> 'number' then
    raise exception 'operational workgroup membership confidence is invalid'
      using errcode = '22023';
  end if;
  v_membership_confidence := (p_membership->>'confidence')::numeric;
  if v_membership_confidence < 0 or v_membership_confidence > 1
    or v_membership_confidence is distinct from round(v_membership_confidence, 6) then
    raise exception 'operational workgroup membership confidence is outside the canonical range'
      using errcode = '22023';
  end if;
  v_membership_confidence := trim_scale(v_membership_confidence);
  if not (p_membership->>'decision' = any (array['added', 'removed']))
    or not (p_membership->>'membershipMethod' = any (
      array['deterministic', 'model', 'operator']
    )) then
    raise exception 'operational workgroup membership enum value is invalid'
      using errcode = '22023';
  end if;
  v_membership_recorded_at := (p_membership->>'recordedAt')::timestamptz;

  if exists (
    select 1 from jsonb_array_elements(p_evidence) item
    where jsonb_typeof(item) <> 'object'
  ) then
    raise exception 'operational workgroup evidence entries must be objects'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_evidence) item
    where not private.truth_jsonb_has_only_keys(
      item,
      array['observationId', 'evidenceRole', 'evidenceSpan']
    )
      or nullif(trim(coalesce(item->>'observationId', '')), '') is null
      or not (coalesce(item->>'evidenceRole', '') = any (
        array['primary', 'supporting', 'contradicting']
      ))
      or jsonb_typeof(coalesce(item->'evidenceSpan', '{}'::jsonb)) <> 'object'
  ) then
    raise exception 'operational workgroup evidence entry is invalid'
      using errcode = '23514';
  end if;
  select count(*)::integer,
         count(distinct (item->>'observationId'))::integer,
         count(*) filter (where item->>'evidenceRole' = 'primary')::integer
  into v_evidence_count, v_evidence_distinct_count, v_primary_count
  from jsonb_array_elements(p_evidence) item;
  if v_evidence_count = 0
    or v_evidence_count <> v_evidence_distinct_count
    or v_primary_count <> 1 then
    raise exception 'operational workgroup membership requires complete evidence with one primary'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_evidence) item
    left join public.source_observations observation
      on observation.observation_id = item->>'observationId'
    where observation.observation_id is null
      or observation.workspace_key is distinct from p_workspace_key
  ) then
    raise exception 'operational workgroup evidence is outside the workspace'
      using errcode = '23503';
  end if;
  select item->>'observationId' into v_primary_observation_id
  from jsonb_array_elements(p_evidence) item
  where item->>'evidenceRole' = 'primary';
  if v_basis_observation_id is not null and not exists (
    select 1 from jsonb_array_elements(p_evidence) item
    where item->>'observationId' = v_basis_observation_id
  ) then
    raise exception 'operational workgroup basis observation is outside its evidence envelope'
      using errcode = '23514';
  end if;
  select jsonb_agg(jsonb_build_object(
    'observationId', observation.observation_id,
    'observationContentHash', observation.content_hash,
    'evidenceRole', item->>'evidenceRole',
    'evidenceSpan', coalesce(item->'evidenceSpan', '{}'::jsonb)
  ) order by observation.observation_id, item->>'evidenceRole')
  into v_evidence_manifest
  from jsonb_array_elements(p_evidence) item
  join public.source_observations observation
    on observation.observation_id = item->>'observationId';

  perform pg_advisory_xact_lock(hashtextextended(
    'workgroup:' || p_workspace_key || ':' || (p_workgroup->>'identityKey'),
    0
  ));
  select * into v_existing_workgroup
  from public.operational_workgroups_v2
  where workspace_key = p_workspace_key
    and identity_key = p_workgroup->>'identityKey';
  if found then
    select * into v_existing_workgroup_envelope
    from public.operational_workgroup_envelopes
    where workgroup_id = v_existing_workgroup.workgroup_id;
    if not found
      or v_existing_workgroup.workgroup_id is distinct from v_workgroup_id
      or v_existing_workgroup_envelope.definition_hash is distinct from v_workgroup_hash
      or v_existing_workgroup_envelope.canonical_definition is distinct from v_workgroup_definition then
      raise exception 'operational workgroup identity already has a different immutable definition'
        using errcode = '23505';
    end if;
  else
    insert into public.operational_workgroups_v2 (
      workgroup_id, workspace_key, workgroup_type, identity_key,
      identity_basis, created_method, linker_version, initial_confidence,
      created_at
    ) values (
      v_workgroup_id, p_workspace_key, p_workgroup->>'workgroupType',
      p_workgroup->>'identityKey', coalesce(p_workgroup->'identityBasis', '{}'::jsonb),
      p_workgroup->>'createdMethod', p_workgroup->>'linkerVersion',
      v_workgroup_confidence, v_workgroup_created_at
    );
    insert into public.operational_workgroup_envelopes (
      workgroup_id, workspace_key, identity_key, definition_hash,
      envelope_schema_version, canonical_definition
    ) values (
      v_workgroup_id, p_workspace_key, p_workgroup->>'identityKey',
      v_workgroup_hash, 'operational-workgroup-definition-envelope-v1',
      v_workgroup_definition
    );
    v_workgroup_created := true;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'workgroup-membership:' || p_workspace_key || ':' || v_membership_key,
    0
  ));
  if v_version_no = 1 then
    if v_previous_membership_version_id is not null then
      raise exception 'workgroup membership version one cannot have a previous version'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from public.operational_workgroup_memberships
      where membership_key = v_membership_key and version_no <> 1
    ) then
      raise exception 'workgroup membership version chain does not start at one'
        using errcode = '23514';
    end if;
  else
    if v_previous_membership_version_id is null then
      raise exception 'workgroup membership version chain is incomplete'
        using errcode = '23514';
    end if;
    select prior.*
    into v_previous_membership
    from public.operational_workgroup_memberships prior
    join public.operational_workgroup_membership_envelopes envelope
      on envelope.membership_version_id = prior.membership_version_id
     and envelope.workspace_key = p_workspace_key
     and envelope.envelope_hash = prior.content_hash
    where prior.membership_version_id = v_previous_membership_version_id;
    if not found
      or v_previous_membership.membership_key is distinct from v_membership_key
      or v_previous_membership.version_no <> v_version_no - 1
      or v_previous_membership.workgroup_id is distinct from v_workgroup_id
      or v_previous_membership.member_type is distinct from p_membership->>'memberType'
      or v_previous_membership.member_key is distinct from p_membership->>'memberKey'
      or v_previous_membership.role is distinct from p_membership->>'role' then
      raise exception 'workgroup membership previous version is not the exact chain predecessor'
        using errcode = '23514';
    end if;
    v_previous_hash := v_previous_membership.content_hash;
  end if;

  v_membership_envelope := jsonb_build_object(
    'envelopeSchemaVersion', 'operational-workgroup-membership-envelope-v1',
    'workspaceKey', p_workspace_key,
    'workgroup', jsonb_build_object(
      'workgroupId', v_workgroup_id,
      'definitionHash', v_workgroup_hash
    ),
    'membership', jsonb_build_object(
      'membershipKey', v_membership_key,
      'versionNo', v_version_no,
      'previousMembershipVersionId', coalesce(v_previous_membership_version_id, ''),
      'previousMembershipItemHash', v_previous_hash,
      'memberType', p_membership->>'memberType',
      'memberKey', p_membership->>'memberKey',
      'role', p_membership->>'role',
      'decision', p_membership->>'decision',
      'confidence', v_membership_confidence,
      'membershipMethod', p_membership->>'membershipMethod',
      'linkerVersion', p_membership->>'linkerVersion',
      'primaryObservationId', v_primary_observation_id,
      'basisObservationId', coalesce(v_basis_observation_id, ''),
      'recordedAt', private.canonical_truth_timestamp(v_membership_recorded_at),
      'schemaVersion', p_membership->>'schemaVersion'
    ),
    'evidence', v_evidence_manifest
  );
  v_membership_hash := encode(extensions.digest(
    convert_to(v_membership_envelope::text, 'UTF8'),
    'sha256'
  ), 'hex');
  v_membership_version_id := 'membership:v1:' || v_membership_hash;

  select * into v_existing_membership_envelope
  from public.operational_workgroup_membership_envelopes
  where membership_version_id = v_membership_version_id;
  if found then
    if v_existing_membership_envelope.workspace_key is distinct from p_workspace_key
      or v_existing_membership_envelope.workgroup_id is distinct from v_workgroup_id
      or v_existing_membership_envelope.canonical_envelope is distinct from v_membership_envelope then
      raise exception 'workgroup membership envelope hash collision' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'workgroupCreated', false,
      'workgroupId', v_workgroup_id,
      'workgroupDefinitionHash', v_workgroup_hash,
      'membershipVersionId', v_membership_version_id,
      'itemHash', v_membership_hash,
      'workspaceKey', p_workspace_key,
      'versionNo', v_version_no,
      'evidenceCount', v_evidence_count
    );
  end if;
  if exists (
    select 1 from public.operational_workgroup_memberships
    where membership_key = v_membership_key and version_no = v_version_no
  ) then
    raise exception 'workgroup membership logical version already has a different envelope'
      using errcode = '23505';
  end if;

  insert into public.operational_workgroup_memberships (
    membership_version_id, membership_key, version_no,
    previous_membership_version_id, workgroup_id, member_type, member_key,
    observation_id, role, decision, confidence, membership_method,
    linker_version, basis_observation_id, recorded_at, content_hash
  ) values (
    v_membership_version_id, v_membership_key, v_version_no,
    v_previous_membership_version_id, v_workgroup_id,
    p_membership->>'memberType', p_membership->>'memberKey',
    v_primary_observation_id, p_membership->>'role', p_membership->>'decision',
    v_membership_confidence, p_membership->>'membershipMethod',
    p_membership->>'linkerVersion', v_basis_observation_id,
    v_membership_recorded_at, v_membership_hash
  );
  insert into public.operational_workgroup_membership_evidence (
    membership_version_id, observation_id, evidence_role, evidence_span
  )
  select v_membership_version_id,
         item->>'observationId',
         item->>'evidenceRole',
         coalesce(item->'evidenceSpan', '{}'::jsonb)
  from jsonb_array_elements(p_evidence) item;
  insert into public.operational_workgroup_membership_envelopes (
    membership_version_id, workspace_key, workgroup_id, envelope_hash,
    envelope_schema_version, canonical_envelope
  ) values (
    v_membership_version_id, p_workspace_key, v_workgroup_id,
    v_membership_hash, 'operational-workgroup-membership-envelope-v1',
    v_membership_envelope
  );

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'workgroupCreated', v_workgroup_created,
    'workgroupId', v_workgroup_id,
    'workgroupDefinitionHash', v_workgroup_hash,
    'membershipVersionId', v_membership_version_id,
    'itemHash', v_membership_hash,
    'workspaceKey', p_workspace_key,
    'versionNo', v_version_no,
    'evidenceCount', v_evidence_count
  );
end;
$function$;

create or replace function public.append_accepted_claim(
  p_workspace_key text,
  p_claim jsonb,
  p_evidence jsonb,
  p_supersessions jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.append_accepted_claim(
    p_workspace_key,
    p_claim,
    p_evidence,
    p_supersessions,
    p_sync_token
  );
$function$;

create or replace function public.append_observation_entity_link(
  p_workspace_key text,
  p_link jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.append_observation_entity_link(
    p_workspace_key,
    p_link,
    p_sync_token
  );
$function$;

create or replace function public.append_operational_workgroup_membership(
  p_workspace_key text,
  p_workgroup jsonb,
  p_membership jsonb,
  p_evidence jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.append_operational_workgroup_membership(
    p_workspace_key,
    p_workgroup,
    p_membership,
    p_evidence,
    p_sync_token
  );
$function$;

-- Every reducer-input row and its evidence can now be appended only by the
-- validating envelope functions. Security-definer implementations retain the
-- ability to perform their single atomic transaction.
revoke insert, update, delete, truncate on public.accepted_claims from service_role;
revoke insert, update, delete, truncate on public.accepted_claim_evidence from service_role;
revoke insert, update, delete, truncate on public.claim_supersessions from service_role;
revoke insert, update, delete, truncate on public.observation_entity_links from service_role;
revoke insert, update, delete, truncate on public.operational_workgroups_v2 from service_role;
revoke insert, update, delete, truncate on public.operational_workgroup_memberships from service_role;
revoke insert, update, delete, truncate
  on public.operational_workgroup_membership_evidence from service_role;
revoke insert, update, delete, truncate on public.accepted_claim_envelopes from service_role;
revoke insert, update, delete, truncate
  on public.observation_entity_link_envelopes from service_role;
revoke insert, update, delete, truncate
  on public.operational_workgroup_envelopes from service_role;
revoke insert, update, delete, truncate
  on public.operational_workgroup_membership_envelopes from service_role;

revoke all on function private.append_accepted_claim(text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function private.append_observation_entity_link(text, jsonb, text)
  from public, anon, authenticated;
revoke all on function private.append_operational_workgroup_membership(text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.append_accepted_claim(text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.append_observation_entity_link(text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.append_operational_workgroup_membership(text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.append_accepted_claim(text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function private.append_observation_entity_link(text, jsonb, text)
  to service_role;
grant execute on function private.append_operational_workgroup_membership(text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function public.append_accepted_claim(text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function public.append_observation_entity_link(text, jsonb, text)
  to service_role;
grant execute on function public.append_operational_workgroup_membership(text, jsonb, jsonb, jsonb, text)
  to service_role;

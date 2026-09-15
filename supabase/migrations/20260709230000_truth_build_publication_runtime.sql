create extension if not exists pgcrypto with schema extensions;

set check_function_bodies = off;

create schema if not exists private;

-- Durable coordination for one parity pair. A pair always owns one full and
-- one incremental build over the exact same, server-derived immutable input
-- manifest. The mutable fields are only the fenced lease and final status.
alter table public.truth_builds
  add column if not exists build_pair_id uuid,
  add column if not exists precedence_policy_version text not null default '',
  add column if not exists precedence_policy_hash text not null default '';

-- The earlier caller-supplied build RPC used this manifest-wide uniqueness
-- key. Pair ownership is the new idempotency boundary, so two independent
-- requests may prove the same cut without sharing mutable build rows.
alter table public.truth_builds
  drop constraint if exists truth_builds_input_manifest_hash_build_mode_channel_reducer_key;

create table if not exists public.truth_build_pair_runs (
  build_pair_id uuid primary key,
  workspace_key text not null,
  idempotency_key text not null,
  caller_request_hash text not null check (caller_request_hash ~ '^[0-9a-f]{64}$'),
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  build_channel text not null check (build_channel = any (array['shadow', 'candidate'])),
  publication_channel text not null check (publication_channel = any (array['shadow', 'production'])),
  trigger_name text not null,
  base_publication_id uuid references public.truth_publications(publication_id) on delete restrict,
  full_build_id uuid not null unique,
  incremental_build_id uuid not null unique,
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  claim_manifest_hash text not null check (claim_manifest_hash ~ '^[0-9a-f]{64}$'),
  link_manifest_hash text not null check (link_manifest_hash ~ '^[0-9a-f]{64}$'),
  workgroup_manifest_hash text not null check (workgroup_manifest_hash ~ '^[0-9a-f]{64}$'),
  workgroup_definition_manifest_hash text not null
    check (workgroup_definition_manifest_hash ~ '^[0-9a-f]{64}$'),
  extractor_set_version text not null,
  linker_version text not null,
  reducer_version text not null,
  packet_builder_version text not null,
  packet_schema_version text not null,
  precedence_policy_version text not null,
  precedence_policy_hash text not null check (precedence_policy_hash ~ '^[0-9a-f]{64}$'),
  source_watermark jsonb not null check (jsonb_typeof(source_watermark) = 'object'),
  bundle_row_count integer not null check (bundle_row_count >= 0),
  bundle_row_limit integer not null check (bundle_row_limit > 0),
  status text not null default 'running'
    check (status = any (array['running', 'succeeded', 'failed'])),
  lease_owner text not null,
  lease_fence bigint not null check (lease_fence > 0),
  lease_expires_at timestamptz not null,
  attempt_count integer not null default 1 check (attempt_count > 0),
  packet_hash text check (packet_hash is null or packet_hash ~ '^[0-9a-f]{64}$'),
  reducer_output_hash text
    check (reducer_output_hash is null or reducer_output_hash ~ '^[0-9a-f]{64}$'),
  reducer_packet_hash text
    check (reducer_packet_hash is null or reducer_packet_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash text check (semantic_hash is null or semantic_hash ~ '^[0-9a-f]{64}$'),
  error_code text not null default '',
  safe_error_detail text not null default '',
  started_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique (workspace_key, idempotency_key),
  check (full_build_id <> incremental_build_id),
  check (
    (build_channel = 'shadow' and publication_channel = 'shadow')
    or (build_channel = 'candidate' and publication_channel = 'production')
  )
);

create table if not exists public.truth_build_parity_receipts (
  build_pair_id uuid primary key
    references public.truth_build_pair_runs(build_pair_id) on delete restrict,
  full_build_id uuid not null references public.truth_builds(build_id) on delete restrict,
  incremental_build_id uuid not null references public.truth_builds(build_id) on delete restrict,
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  full_packet_hash text not null check (full_packet_hash ~ '^[0-9a-f]{64}$'),
  incremental_packet_hash text not null check (incremental_packet_hash ~ '^[0-9a-f]{64}$'),
  full_reducer_output_hash text not null
    check (full_reducer_output_hash ~ '^[0-9a-f]{64}$'),
  incremental_reducer_output_hash text not null
    check (incremental_reducer_output_hash ~ '^[0-9a-f]{64}$'),
  reducer_packet_hash text not null check (reducer_packet_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash text not null check (semantic_hash ~ '^[0-9a-f]{64}$'),
  exact_payload_equal boolean not null check (exact_payload_equal = true),
  citation_integrity_ok boolean not null check (citation_integrity_ok = true),
  source_cut_integrity_ok boolean not null check (source_cut_integrity_ok = true),
  checked_at timestamptz not null default clock_timestamp(),
  check (full_packet_hash = incremental_packet_hash),
  check (full_reducer_output_hash = incremental_reducer_output_hash)
);

create table if not exists public.truth_publication_payloads (
  publication_id uuid primary key
    references public.truth_publications(publication_id) on delete restrict,
  workspace_key text not null,
  channel text not null check (channel = any (array['shadow', 'production'])),
  publication_version bigint not null check (publication_version > 0),
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  packet_hash text not null check (packet_hash ~ '^[0-9a-f]{64}$'),
  reducer_packet_hash text not null check (reducer_packet_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash text not null check (semantic_hash ~ '^[0-9a-f]{64}$'),
  delivery_payload jsonb not null check (jsonb_typeof(delivery_payload) = 'object'),
  delivery_canonical_text text not null,
  delivery_payload_hash text not null check (delivery_payload_hash ~ '^[0-9a-f]{64}$'),
  active_index_payload jsonb not null check (jsonb_typeof(active_index_payload) = 'object'),
  active_index_hash text not null check (active_index_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, channel, publication_version)
);

create table if not exists public.truth_publication_requests (
  workspace_key text not null,
  channel text not null check (channel = any (array['shadow', 'production'])),
  publication_request_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  publication_id uuid not null
    references public.truth_publications(publication_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_key, channel, publication_request_key)
);

create or replace function private.truth_build_pair_receipt(
  p_pair public.truth_build_pair_runs,
  p_idempotent boolean,
  p_busy boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'ok', not p_busy,
    'status', case when p_busy then 'busy' else p_pair.status end,
    'code', case when p_busy then 'TRUTH_BUILD_BUSY' else null end,
    'idempotent', p_idempotent,
    'buildPairId', p_pair.build_pair_id,
    'workspaceKey', p_pair.workspace_key,
    'sourceCutId', p_pair.source_cut_id,
    'buildChannel', p_pair.build_channel,
    'publicationChannel', p_pair.publication_channel,
    'basePublicationId', p_pair.base_publication_id,
    'fullBuildId', p_pair.full_build_id,
    'incrementalBuildId', p_pair.incremental_build_id,
    'inputManifestHash', p_pair.input_manifest_hash,
    'bundleRowCount', p_pair.bundle_row_count,
    'bundleRowLimit', p_pair.bundle_row_limit,
    'leaseOwner', p_pair.lease_owner,
    'leaseFence', p_pair.lease_fence,
    'leaseExpiresAt', p_pair.lease_expires_at,
    'attemptCount', p_pair.attempt_count,
    'packetHash', p_pair.packet_hash,
    'reducerOutputHash', p_pair.reducer_output_hash,
    'reducerPacketHash', p_pair.reducer_packet_hash,
    'semanticHash', p_pair.semantic_hash,
    'errorCode', nullif(p_pair.error_code, ''),
    'safeErrorDetail', nullif(p_pair.safe_error_detail, ''),
    'finishedAt', p_pair.finished_at
  ));
$function$;

create or replace function private.require_truth_build_pair_lease(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint
)
returns public.truth_build_pair_runs
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
begin
  select * into v_pair
  from public.truth_build_pair_runs
  where build_pair_id = p_build_pair_id
  for update;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  if v_pair.status <> 'running'
    or v_pair.lease_owner is distinct from p_worker_id
    or v_pair.lease_fence is distinct from p_lease_fence
    or v_pair.lease_expires_at <= clock_timestamp() then
    raise exception 'truth build pair lease is stale' using errcode = '40001';
  end if;
  return v_pair;
end;
$function$;

create or replace function private.truth_build_bundle_from_inputs(
  p_build_pair_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_cut jsonb;
  v_claims jsonb;
  v_links jsonb;
  v_memberships jsonb;
  v_workgroups jsonb;
  v_evidence_observations jsonb;
  v_bundle jsonb;
  v_row_count integer;
begin
  select * into v_pair
  from public.truth_build_pair_runs
  where build_pair_id = p_build_pair_id;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  v_cut := private.require_exact_complete_source_cut(
    v_pair.workspace_key,
    v_pair.source_cut_id
  );

  if exists (
    select 1
    from public.truth_build_inputs input
    where input.build_id = v_pair.full_build_id
      and private.authoritative_truth_input_hash(input.item_kind, input.item_id)
        is distinct from input.item_hash
  ) or exists (
    (
      select item_kind, item_id, item_hash
      from public.truth_build_inputs
      where build_id = v_pair.full_build_id
      except
      select item_kind, item_id, item_hash
      from public.truth_build_inputs
      where build_id = v_pair.incremental_build_id
    ) union all (
      select item_kind, item_id, item_hash
      from public.truth_build_inputs
      where build_id = v_pair.incremental_build_id
      except
      select item_kind, item_id, item_hash
      from public.truth_build_inputs
      where build_id = v_pair.full_build_id
    )
  ) then
    raise exception 'truth build pair frozen inputs are corrupt or divergent'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'claimVersionId', envelope.claim_version_id,
    'envelopeHash', envelope.envelope_hash,
    'canonicalEnvelope', envelope.canonical_envelope
  ) order by envelope.claim_version_id), '[]'::jsonb)
  into v_claims
  from public.truth_build_inputs input
  join public.accepted_claim_envelopes envelope
    on input.item_kind = 'accepted_claim'
   and envelope.claim_version_id = input.item_id
   and envelope.envelope_hash = input.item_hash
  where input.build_id = v_pair.full_build_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'linkVersionId', envelope.link_version_id,
    'envelopeHash', envelope.envelope_hash,
    'canonicalEnvelope', envelope.canonical_envelope
  ) order by envelope.link_version_id), '[]'::jsonb)
  into v_links
  from public.truth_build_inputs input
  join public.observation_entity_link_envelopes envelope
    on input.item_kind = 'entity_link'
   and envelope.link_version_id = input.item_id
   and envelope.envelope_hash = input.item_hash
  where input.build_id = v_pair.full_build_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'membershipVersionId', envelope.membership_version_id,
    'envelopeHash', envelope.envelope_hash,
    'workgroupId', envelope.workgroup_id,
    'canonicalEnvelope', envelope.canonical_envelope
  ) order by envelope.membership_version_id), '[]'::jsonb)
  into v_memberships
  from public.truth_build_inputs input
  join public.operational_workgroup_membership_envelopes envelope
    on input.item_kind = 'workgroup_membership'
   and envelope.membership_version_id = input.item_id
   and envelope.envelope_hash = input.item_hash
  where input.build_id = v_pair.full_build_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'workgroupId', workgroup.workgroup_id,
    'definitionHash', workgroup.definition_hash,
    'canonicalDefinition', workgroup.canonical_definition
  ) order by workgroup.workgroup_id), '[]'::jsonb)
  into v_workgroups
  from public.operational_workgroup_envelopes workgroup
  where workgroup.workspace_key = v_pair.workspace_key
    and exists (
      select 1
      from jsonb_array_elements(v_memberships) membership
      where membership->>'workgroupId' = workgroup.workgroup_id
    );

  with evidence_ids as (
    select evidence.observation_id
    from public.truth_build_inputs input
    join public.accepted_claim_evidence evidence
      on input.item_kind = 'accepted_claim'
     and evidence.claim_version_id = input.item_id
    where input.build_id = v_pair.full_build_id
    union
    select entity_link.observation_id
    from public.truth_build_inputs input
    join public.observation_entity_links entity_link
      on input.item_kind = 'entity_link'
     and entity_link.link_version_id = input.item_id
    where input.build_id = v_pair.full_build_id
    union
    select evidence.observation_id
    from public.truth_build_inputs input
    join public.operational_workgroup_membership_evidence evidence
      on input.item_kind = 'workgroup_membership'
     and evidence.membership_version_id = input.item_id
    where input.build_id = v_pair.full_build_id
    union
    select membership.observation_id
    from public.truth_build_inputs input
    join public.operational_workgroup_memberships membership
      on input.item_kind = 'workgroup_membership'
     and membership.membership_version_id = input.item_id
    where input.build_id = v_pair.full_build_id
      and membership.observation_id is not null
    union
    select membership.basis_observation_id
    from public.truth_build_inputs input
    join public.operational_workgroup_memberships membership
      on input.item_kind = 'workgroup_membership'
     and membership.membership_version_id = input.item_id
    where input.build_id = v_pair.full_build_id
      and membership.basis_observation_id is not null
    union
    select citation.citation_id
    from private.truth_packet_citation_ids(v_claims, 'observation') citation
    union
    select citation.citation_id
    from private.truth_packet_citation_ids(v_links, 'observation') citation
    union
    select citation.citation_id
    from private.truth_packet_citation_ids(v_memberships, 'observation') citation
    union
    select citation.citation_id
    from private.truth_packet_citation_ids(v_workgroups, 'observation') citation
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'observationId', observation.observation_id,
    'contentHash', observation.content_hash
  ) order by observation.observation_id), '[]'::jsonb)
  into v_evidence_observations
  from evidence_ids evidence
  join public.source_observations observation
    on observation.observation_id = evidence.observation_id;

  -- Recheck all evidence closure at read time. Frozen identifiers are not
  -- enough if an implementation ever bypasses the authoritative envelope.
  if exists (
    select 1
    from jsonb_array_elements(v_evidence_observations) evidence
    where not private.source_observation_within_cut(
      v_pair.workspace_key,
      v_pair.source_cut_id,
      evidence->>'observationId',
      evidence->>'contentHash'
    )
  ) then
    raise exception 'truth build pair evidence escaped its exact source cut'
      using errcode = '23514';
  end if;

  v_row_count := jsonb_array_length(v_evidence_observations)
    + jsonb_array_length(v_claims)
    + jsonb_array_length(v_links)
    + jsonb_array_length(v_memberships)
    + jsonb_array_length(v_workgroups);
  if v_row_count <> v_pair.bundle_row_count
    or v_row_count > v_pair.bundle_row_limit then
    raise exception 'truth build bundle bound changed or would truncate'
      using errcode = '54000';
  end if;

  v_bundle := jsonb_build_object(
    'schemaVersion', 'relational-truth-build-bundle-v1',
    'buildPairId', v_pair.build_pair_id,
    'inputManifestHash', v_pair.input_manifest_hash,
    'sourceCut', jsonb_build_object(
      'sourceCutId', v_pair.source_cut_id,
      'manifestHash', v_cut->>'manifestHash',
      'completeness', 'complete',
      'sealedAt', v_cut->>'sealedAt',
      'journalObservationCount', (v_cut->>'observationCount')::integer,
      'partitionWitnessVersion', v_cut->'manifest'->>'partitionWitnessVersion',
      'cursorPartitions', v_cut->'manifest'->'cursors',
      'observations', v_evidence_observations
    ),
    'sourceWatermark', v_pair.source_watermark,
    'acceptedClaimEnvelopes', v_claims,
    'entityLinkEnvelopes', v_links,
    'workgroupDefinitions', v_workgroups,
    'workgroupMembershipEnvelopes', v_memberships,
    'bounds', jsonb_build_object(
      'rowCount', v_row_count,
      'rowLimit', v_pair.bundle_row_limit,
      'truncated', false
    )
  );
  return v_bundle;
end;
$function$;

create or replace function private.claim_truth_build_pair(
  p_workspace_key text,
  p_source_cut_id text,
  p_build_channel text,
  p_trigger_name text,
  p_idempotency_key text,
  p_worker_id text,
  p_lease_seconds integer,
  p_bundle_row_limit integer,
  p_versions jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_pair public.truth_build_pair_runs%rowtype;
  v_candidate jsonb;
  v_caller_request jsonb;
  v_caller_request_hash text;
  v_publication_channel text;
  v_base_publication_id uuid;
  v_pair_id uuid := gen_random_uuid();
  v_full_build_id uuid := gen_random_uuid();
  v_incremental_build_id uuid := gen_random_uuid();
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_source_cut_id, '')), '') is null
    or nullif(trim(coalesce(p_trigger_name, '')), '') is null
    or nullif(trim(coalesce(p_idempotency_key, '')), '') is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_build_channel is null
    or not (p_build_channel = any (array['shadow', 'candidate']))
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 1800
    or p_bundle_row_limit is null or p_bundle_row_limit < 1
    or p_bundle_row_limit > 100000 then
    raise exception 'truth build pair claim is invalid' using errcode = '22023';
  end if;
  if octet_length(p_workspace_key) > 200
    or octet_length(p_idempotency_key) > 500
    or octet_length(p_worker_id) > 500
    or octet_length(p_trigger_name) > 500 then
    raise exception 'truth build pair claim field is too long' using errcode = '22023';
  end if;

  v_publication_channel := case
    when p_build_channel = 'candidate' then 'production'
    else 'shadow'
  end;
  v_caller_request := jsonb_build_object(
    'schemaVersion', 'truth-build-pair-request-v1',
    'workspaceKey', p_workspace_key,
    'sourceCutId', p_source_cut_id,
    'buildChannel', p_build_channel,
    'triggerName', p_trigger_name,
    'bundleRowLimit', p_bundle_row_limit,
    'versions', p_versions
  );
  v_caller_request_hash := encode(extensions.digest(
    convert_to(v_caller_request::text, 'UTF8'), 'sha256'
  ), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-build-pair:' || p_workspace_key || ':' || p_idempotency_key,
    0
  ));
  select * into v_pair
  from public.truth_build_pair_runs
  where workspace_key = p_workspace_key
    and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_pair.caller_request_hash is distinct from v_caller_request_hash then
      raise exception 'truth build idempotency key has conflicting request content'
        using errcode = '23505';
    end if;
    if v_pair.status <> 'running' then
      return private.truth_build_pair_receipt(v_pair, true, false);
    end if;
    if v_pair.lease_expires_at > v_now then
      if v_pair.lease_owner = p_worker_id then
        return private.truth_build_pair_receipt(v_pair, true, false);
      end if;
      return private.truth_build_pair_receipt(v_pair, true, true);
    end if;
    update public.truth_build_pair_runs
    set lease_owner = p_worker_id,
        lease_fence = lease_fence + 1,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        attempt_count = attempt_count + 1,
        updated_at = v_now
    where build_pair_id = v_pair.build_pair_id
    returning * into v_pair;
    return private.truth_build_pair_receipt(v_pair, false, false);
  end if;

  v_candidate := private.derive_truth_build_candidate_manifest(
    p_workspace_key,
    p_source_cut_id,
    p_versions
  );
  if (v_candidate->>'bundleRowCount')::integer > p_bundle_row_limit then
    raise exception 'truth build bundle exceeds its declared row bound; no truncation is allowed'
      using errcode = '54000';
  end if;
  select head.publication_id into v_base_publication_id
  from public.truth_publication_heads head
  where head.workspace_key = p_workspace_key
    and head.channel = v_publication_channel;

  set constraints all deferred;
  insert into public.truth_build_pair_runs (
    build_pair_id, workspace_key, idempotency_key, caller_request_hash,
    source_cut_id, build_channel, publication_channel, trigger_name,
    base_publication_id, full_build_id, incremental_build_id,
    input_manifest_hash, claim_manifest_hash, link_manifest_hash,
    workgroup_manifest_hash, workgroup_definition_manifest_hash,
    extractor_set_version, linker_version, reducer_version,
    packet_builder_version, packet_schema_version,
    precedence_policy_version, precedence_policy_hash, source_watermark,
    bundle_row_count, bundle_row_limit, lease_owner, lease_fence,
    lease_expires_at
  ) values (
    v_pair_id, p_workspace_key, p_idempotency_key, v_caller_request_hash,
    p_source_cut_id, p_build_channel, v_publication_channel, p_trigger_name,
    v_base_publication_id, v_full_build_id, v_incremental_build_id,
    v_candidate->>'inputManifestHash', v_candidate->>'claimManifestHash',
    v_candidate->>'linkManifestHash', v_candidate->>'workgroupManifestHash',
    v_candidate->>'workgroupDefinitionManifestHash',
    v_candidate->>'extractorSetVersion', v_candidate->>'linkerVersion',
    p_versions->>'reducerVersion', p_versions->>'packetBuilderVersion',
    p_versions->>'packetSchemaVersion', p_versions->>'precedencePolicyVersion',
    p_versions->>'precedencePolicyHash', v_candidate->'sourceWatermark',
    (v_candidate->>'bundleRowCount')::integer, p_bundle_row_limit,
    p_worker_id, 1, v_now + make_interval(secs => p_lease_seconds)
  );

  insert into public.truth_builds (
    build_id, build_pair_id, workspace_key, source_cut_id, build_mode,
    channel, trigger_name, base_publication_id, input_manifest_hash,
    claim_manifest_hash, link_manifest_hash, workgroup_manifest_hash,
    extractor_set_version, linker_version, reducer_version,
    packet_builder_version, packet_schema_version,
    precedence_policy_version, precedence_policy_hash, source_watermark
  ) values
  (
    v_full_build_id, v_pair_id, p_workspace_key, p_source_cut_id, 'full',
    p_build_channel, p_trigger_name, null, v_candidate->>'inputManifestHash',
    v_candidate->>'claimManifestHash', v_candidate->>'linkManifestHash',
    v_candidate->>'workgroupManifestHash', v_candidate->>'extractorSetVersion',
    v_candidate->>'linkerVersion', p_versions->>'reducerVersion',
    p_versions->>'packetBuilderVersion', p_versions->>'packetSchemaVersion',
    p_versions->>'precedencePolicyVersion', p_versions->>'precedencePolicyHash',
    v_candidate->'sourceWatermark'
  ),
  (
    v_incremental_build_id, v_pair_id, p_workspace_key, p_source_cut_id,
    'incremental', p_build_channel, p_trigger_name, v_base_publication_id,
    v_candidate->>'inputManifestHash', v_candidate->>'claimManifestHash',
    v_candidate->>'linkManifestHash', v_candidate->>'workgroupManifestHash',
    v_candidate->>'extractorSetVersion', v_candidate->>'linkerVersion',
    p_versions->>'reducerVersion', p_versions->>'packetBuilderVersion',
    p_versions->>'packetSchemaVersion', p_versions->>'precedencePolicyVersion',
    p_versions->>'precedencePolicyHash', v_candidate->'sourceWatermark'
  );

  insert into public.truth_build_inputs (
    build_id, item_kind, item_id, item_hash, ordinal
  )
  select build_id,
         input.item_kind,
         input.item_id,
         input.item_hash,
         row_number() over (
           partition by build_id, input.item_kind order by input.item_id
         ) - 1
  from (values (v_full_build_id), (v_incremental_build_id)) builds(build_id)
  cross join lateral (
    select 'accepted_claim'::text as item_kind,
           item->>'itemId' as item_id,
           item->>'itemHash' as item_hash
    from jsonb_array_elements(v_candidate->'claimInputs') item
    union all
    select 'entity_link', item->>'itemId', item->>'itemHash'
    from jsonb_array_elements(v_candidate->'linkInputs') item
    union all
    select 'workgroup_membership', item->>'itemId', item->>'itemHash'
    from jsonb_array_elements(v_candidate->'workgroupMembershipInputs') item
  ) input;

  select * into v_pair
  from public.truth_build_pair_runs
  where build_pair_id = v_pair_id;
  return private.truth_build_pair_receipt(v_pair, false, false);
end;
$function$;

-- Retire the earlier caller-supplied publication authority. Keeping the
-- signature as a fail-closed tombstone avoids a stale deployed caller finding
-- an overloaded older implementation through PostgREST's schema cache.
create or replace function private.publish_truth_build_cas(
  p_build_id uuid,
  p_channel text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'legacy truth publication authority is retired; use parity-gated build-pair publication'
    using errcode = '42501';
end;
$function$;

create or replace function public.claim_truth_build_pair(
  p_workspace_key text,
  p_source_cut_id text,
  p_build_channel text,
  p_trigger_name text,
  p_idempotency_key text,
  p_worker_id text,
  p_lease_seconds integer,
  p_bundle_row_limit integer,
  p_versions jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.claim_truth_build_pair(
    p_workspace_key, p_source_cut_id, p_build_channel, p_trigger_name,
    p_idempotency_key, p_worker_id, p_lease_seconds,
    p_bundle_row_limit, p_versions, p_sync_token
  );
$function$;

create or replace function public.renew_truth_build_pair_lease(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_lease_seconds integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.renew_truth_build_pair_lease(
    p_build_pair_id, p_worker_id, p_lease_fence,
    p_lease_seconds, p_sync_token
  );
$function$;

create or replace function public.read_truth_build_bundle(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.read_truth_build_bundle(
    p_build_pair_id, p_worker_id, p_lease_fence, p_sync_token
  );
$function$;

create or replace function public.complete_truth_build_pair(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_full_packet jsonb,
  p_incremental_packet jsonb,
  p_full_semantic_hash text,
  p_incremental_semantic_hash text,
  p_full_validation_report jsonb,
  p_incremental_validation_report jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.complete_truth_build_pair(
    p_build_pair_id, p_worker_id, p_lease_fence,
    p_full_packet, p_incremental_packet,
    p_full_semantic_hash, p_incremental_semantic_hash,
    p_full_validation_report, p_incremental_validation_report,
    p_sync_token
  );
$function$;

create or replace function public.fail_truth_build_pair(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_error_code text,
  p_safe_error_detail text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.fail_truth_build_pair(
    p_build_pair_id, p_worker_id, p_lease_fence,
    p_error_code, p_safe_error_detail, p_sync_token
  );
$function$;

create or replace function public.publish_truth_build_pair_runtime_cas(
  p_build_pair_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_production_confirmation text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.publish_truth_build_pair_runtime_cas(
    p_build_pair_id, p_publication_request_key,
    p_expected_head_version, p_expected_head_packet_hash,
    p_publication_reason, p_publisher_version, p_published_by,
    p_production_confirmation, p_sync_token
  );
$function$;

create or replace function public.publish_truth_rollback_forward(
  p_workspace_key text,
  p_channel text,
  p_target_publication_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publisher_version text,
  p_published_by text,
  p_production_confirmation text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.publish_truth_rollback_forward(
    p_workspace_key, p_channel, p_target_publication_id,
    p_publication_request_key, p_expected_head_version,
    p_expected_head_packet_hash, p_publisher_version, p_published_by,
    p_production_confirmation, p_sync_token
  );
$function$;

create or replace function public.read_truth_publication_head_runtime(
  p_workspace_key text,
  p_channel text,
  p_max_payload_bytes integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.read_truth_publication_head_runtime(
    p_workspace_key, p_channel, p_max_payload_bytes, p_sync_token
  );
$function$;

alter table public.truth_build_pair_runs enable row level security;
alter table public.truth_build_parity_receipts enable row level security;
alter table public.truth_publication_payloads enable row level security;
alter table public.truth_publication_requests enable row level security;
alter table public.truth_build_pair_runs force row level security;
alter table public.truth_build_parity_receipts force row level security;
alter table public.truth_publication_payloads force row level security;
alter table public.truth_publication_requests force row level security;

revoke all on public.truth_build_pair_runs from public, anon, authenticated, service_role;
revoke all on public.truth_build_parity_receipts from public, anon, authenticated, service_role;
revoke all on public.truth_publication_payloads from public, anon, authenticated, service_role;
revoke all on public.truth_publication_requests from public, anon, authenticated, service_role;
grant select on public.truth_build_pair_runs to service_role;
grant select on public.truth_build_parity_receipts to service_role;
grant select on public.truth_publication_payloads to service_role;
grant select on public.truth_publication_requests to service_role;

-- Publisher credentials may invoke only the public token-checked boundary.
-- Direct table DML and every private implementation remain unavailable.
revoke insert, update, delete, truncate on public.truth_builds from service_role;
revoke insert, update, delete, truncate on public.truth_build_inputs from service_role;
revoke insert, update, delete, truncate on public.truth_publications from service_role;
revoke insert, update, delete, truncate on public.truth_publication_heads from service_role;

revoke all on function public.begin_truth_build(text, text, text, text, text, uuid, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_truth_build(uuid, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_truth_build_cas(uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.begin_truth_build(text, text, text, text, text, uuid, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_truth_build(uuid, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.publish_truth_build_cas(uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function public.claim_truth_build_pair(text, text, text, text, text, text, integer, integer, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.renew_truth_build_pair_lease(uuid, text, bigint, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_truth_build_bundle(uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_truth_build_pair(uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_truth_build_pair(uuid, text, bigint, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_truth_build_pair_runtime_cas(uuid, text, bigint, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_truth_rollback_forward(text, text, uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_truth_publication_head_runtime(text, text, integer, text)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_truth_build_pair(text, text, text, text, text, text, integer, integer, jsonb, text)
  to service_role;
grant execute on function public.renew_truth_build_pair_lease(uuid, text, bigint, integer, text)
  to service_role;
grant execute on function public.read_truth_build_bundle(uuid, text, bigint, text)
  to service_role;
grant execute on function public.complete_truth_build_pair(uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text)
  to service_role;
grant execute on function public.fail_truth_build_pair(uuid, text, bigint, text, text, text)
  to service_role;
grant execute on function public.publish_truth_build_pair_runtime_cas(uuid, text, bigint, text, text, text, text, text, text)
  to service_role;
grant execute on function public.publish_truth_rollback_forward(text, text, uuid, text, bigint, text, text, text, text, text)
  to service_role;
grant execute on function public.read_truth_publication_head_runtime(text, text, integer, text)
  to service_role;

create or replace function private.truth_publication_runtime_receipt(
  p_publication_id uuid,
  p_idempotent boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'ok', true,
    'idempotent', p_idempotent,
    'publicationId', publication.publication_id,
    'publicationVersion', publication.publication_version,
    'previousPublicationId', publication.previous_publication_id,
    'publicationReason', publication.publication_reason,
    'workspaceKey', publication.workspace_key,
    'channel', publication.channel,
    'buildId', publication.build_id,
    'sourceCutId', publication.source_cut_id,
    'packetHash', publication.packet_hash,
    'reducerPacketHash', payload.reducer_packet_hash,
    'semanticHash', publication.semantic_hash,
    'deliveryPayloadHash', publication.delivery_payload_hash,
    'activeIndexHash', payload.active_index_hash,
    'publishedAt', publication.published_at,
    'publicationAdapter', jsonb_build_object(
      'publicationId', publication.publication_id,
      'publicationVersion', publication.publication_version,
      'channel', publication.channel,
      'publishedAt', publication.published_at,
      'publisherVersion', publication.publisher_version,
      'sourceCutId', publication.source_cut_id,
      'packetHash', payload.reducer_packet_hash
    )
  )
  from public.truth_publications publication
  join public.truth_publication_payloads payload
    on payload.publication_id = publication.publication_id
  where publication.publication_id = p_publication_id;
$function$;

-- This is the single function in the schema that inserts a publication,
-- advances a head, and refreshes the compatibility delivery cache. Normal,
-- repair, and rollback-forward callers all pass through this authority.
create or replace function private.commit_truth_publication_runtime(
  p_workspace_key text,
  p_channel text,
  p_build_id uuid,
  p_source_cut_id text,
  p_packet jsonb,
  p_packet_hash text,
  p_reducer_packet_hash text,
  p_semantic_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_published_at_text text;
  v_existing_request public.truth_publication_requests%rowtype;
  v_existing_publication public.truth_publications%rowtype;
  v_head public.truth_publication_heads%rowtype;
  v_pair_base_publication_id uuid;
  v_build_belongs_to_pair boolean := false;
  v_publication_id uuid := gen_random_uuid();
  v_publication_version bigint;
  v_request_hash text;
  v_delivery_core jsonb;
  v_delivery_payload jsonb;
  v_delivery_payload_hash text;
  v_active_awbs jsonb;
  v_completed_awbs jsonb;
  v_active_index_core jsonb;
  v_active_index jsonb;
  v_active_index_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_channel is null or not (p_channel = any (array['shadow', 'production']))
    or p_publication_reason is null
    or not (p_publication_reason = any (array['normal', 'repair', 'rollback']))
    or p_expected_head_version is null or p_expected_head_version < 0
    or coalesce(p_expected_head_packet_hash, '') !~ '^(|[0-9a-f]{64})$'
    or coalesce(p_packet_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_reducer_packet_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_semantic_hash, '') !~ '^[0-9a-f]{64}$'
    or nullif(trim(coalesce(p_publisher_version, '')), '') is null
    or nullif(trim(coalesce(p_published_by, '')), '') is null
    or nullif(trim(coalesce(p_publication_request_key, '')), '') is null
    or jsonb_typeof(coalesce(p_packet, 'null'::jsonb)) <> 'object' then
    raise exception 'truth publication request is invalid' using errcode = '22023';
  end if;
  if octet_length(p_publication_request_key) > 500
    or octet_length(p_publisher_version) > 500
    or octet_length(p_published_by) > 500 then
    raise exception 'truth publication request field is too long' using errcode = '22023';
  end if;
  v_published_at_text := to_char(
    v_now at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  perform private.require_exact_complete_source_cut(p_workspace_key, p_source_cut_id);
  if p_packet_hash is distinct from encode(extensions.digest(
      convert_to(p_packet::text, 'UTF8'), 'sha256'
    ), 'hex')
    or p_reducer_packet_hash is distinct from p_packet->>'packetHash'
    or p_packet->'truthProvenance'->>'sourceCutId' is distinct from p_source_cut_id
    or p_packet->'truthProvenance'->>'reducerPacketHash'
      is distinct from p_reducer_packet_hash then
    raise exception 'truth publication packet identity is invalid' using errcode = '23514';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-publication-request-v2',
    'workspaceKey', p_workspace_key,
    'channel', p_channel,
    'buildId', p_build_id,
    'sourceCutId', p_source_cut_id,
    'packetHash', p_packet_hash,
    'semanticHash', p_semantic_hash,
    'publicationReason', p_publication_reason,
    'publisherVersion', p_publisher_version,
    'publishedBy', p_published_by,
    'expectedHeadVersion', p_expected_head_version,
    'expectedHeadPacketHash', coalesce(p_expected_head_packet_hash, '')
  )::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'truth-publication:' || p_workspace_key || ':' || p_channel,
    0
  ));
  select * into v_existing_request
  from public.truth_publication_requests request
  where request.workspace_key = p_workspace_key
    and request.channel = p_channel
    and request.publication_request_key = p_publication_request_key;
  if found then
    if v_existing_request.request_hash is distinct from v_request_hash then
      raise exception 'truth publication idempotency key has conflicting request content'
        using errcode = '23505';
    end if;
    return private.truth_publication_runtime_receipt(
      v_existing_request.publication_id,
      true
    );
  end if;

  if p_publication_reason <> 'rollback' then
    select * into v_existing_publication
    from public.truth_publications publication
    where publication.workspace_key = p_workspace_key
      and publication.channel = p_channel
      and publication.build_id = p_build_id
      and publication.publication_reason <> 'rollback';
    if found then
      insert into public.truth_publication_requests (
        workspace_key, channel, publication_request_key,
        request_hash, publication_id
      ) values (
        p_workspace_key, p_channel, p_publication_request_key,
        v_request_hash, v_existing_publication.publication_id
      );
      return private.truth_publication_runtime_receipt(
        v_existing_publication.publication_id,
        true
      );
    end if;
  end if;

  select * into v_head
  from public.truth_publication_heads head
  where head.workspace_key = p_workspace_key
    and head.channel = p_channel
  for update;
  if found then
    if v_head.publication_version is distinct from p_expected_head_version
      or v_head.packet_hash is distinct from coalesce(p_expected_head_packet_hash, '') then
      raise exception 'truth publication compare-and-swap failed' using errcode = '40001';
    end if;
    v_publication_version := v_head.publication_version + 1;
  else
    if p_expected_head_version <> 0
      or coalesce(p_expected_head_packet_hash, '') <> '' then
      raise exception 'truth publication compare-and-swap failed' using errcode = '40001';
    end if;
    v_publication_version := 1;
  end if;

  select true, pair.base_publication_id
  into v_build_belongs_to_pair, v_pair_base_publication_id
  from public.truth_build_pair_runs pair
  where pair.full_build_id = p_build_id;
  if coalesce(v_build_belongs_to_pair, false)
    and p_publication_reason <> 'rollback'
    and v_pair_base_publication_id is distinct from v_head.publication_id then
    raise exception 'truth build pair base is no longer the publication head'
      using errcode = '40001';
  end if;

  if p_publication_reason <> 'rollback'
    and v_head.publication_id is not null
    and exists (
      select 1
      from public.source_cut_cursors current_cursor
      left join public.source_cut_cursors candidate_cursor
        on candidate_cursor.source_cut_id = p_source_cut_id
       and candidate_cursor.source_system = current_cursor.source_system
       and candidate_cursor.connection_key = current_cursor.connection_key
      where current_cursor.source_cut_id = v_head.source_cut_id
        and (
          candidate_cursor.source_cut_id is null
          or candidate_cursor.through_cursor_version < current_cursor.through_cursor_version
          or (
            candidate_cursor.through_cursor_version = current_cursor.through_cursor_version
            and candidate_cursor.through_cursor_value is distinct from
              current_cursor.through_cursor_value
          )
        )
    ) then
    raise exception 'truth publication source cursor regression' using errcode = '23514';
  end if;

  if p_channel = 'production' and p_publication_reason <> 'rollback'
    and exists (
      select 1
      from public.source_cut_cursors cut_cursor
      left join public.source_cursors live_cursor
        on live_cursor.workspace_key = p_workspace_key
       and live_cursor.source_system = cut_cursor.source_system
       and live_cursor.connection_key = cut_cursor.connection_key
      where cut_cursor.source_cut_id = p_source_cut_id
        and (
          live_cursor.workspace_key is null
          or live_cursor.status <> 'live'
          or live_cursor.cursor_version is distinct from cut_cursor.through_cursor_version
          or live_cursor.cursor_value is distinct from cut_cursor.through_cursor_value
        )
    ) then
    raise exception 'production source cut is no longer the live source vector'
      using errcode = '40001';
  end if;
  if p_channel = 'production' and p_publication_reason <> 'rollback'
    and exists (
      select 1
      from public.gmail_completeness_gaps gap
      join public.source_cut_cursors cut_cursor
        on cut_cursor.source_cut_id = p_source_cut_id
       and cut_cursor.source_system = 'gmail'
       and cut_cursor.connection_key = gap.connection_key
      where gap.workspace_key = p_workspace_key
        and gap.status = 'open'
    ) then
    raise exception 'production source cut has an open Gmail completeness gap'
      using errcode = '23514';
  end if;

  v_completed_awbs := p_packet->'completedAwbs';
  v_active_awbs := p_packet->'activeAwbs';
  if jsonb_typeof(v_completed_awbs) <> 'array'
    or jsonb_typeof(v_active_awbs) <> 'array' then
    raise exception 'truth delivery packet lacks identifier-only active/completed indexes'
      using errcode = '23514';
  end if;

  v_delivery_core := p_packet || jsonb_build_object(
    'publicationId', v_publication_id,
    'publicationVersion', v_publication_version,
    'publicationChannel', p_channel,
    'publishedAt', v_published_at_text,
    'publisherVersion', p_publisher_version,
    'sourceCutId', p_source_cut_id
  );
  v_delivery_payload_hash := encode(extensions.digest(
    convert_to(v_delivery_core::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_delivery_payload := v_delivery_core || jsonb_build_object(
    'deliveryPayloadHash', v_delivery_payload_hash,
    'contentSignature', v_delivery_payload_hash
  );
  v_active_index_core := jsonb_build_object(
    'snapshotTime', v_now,
    'source', 'truth-publication-head',
    'writerVersion', 'active-awb-index-v2',
    'publicationId', v_publication_id,
    'publicationVersion', v_publication_version,
    'truthPacketContentSignature', v_delivery_payload_hash,
    'sourceCutId', p_source_cut_id,
    'activeAwbs', v_active_awbs,
    'completedAwbs', v_completed_awbs
  );
  v_active_index_hash := encode(extensions.digest(
    convert_to(v_active_index_core::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_active_index := v_active_index_core || jsonb_build_object(
    'contentSignature', v_active_index_hash
  );

  insert into public.truth_publications (
    publication_id, workspace_key, channel, publication_version, build_id,
    source_cut_id, previous_publication_id, publication_reason, packet_hash,
    delivery_payload_hash, semantic_hash, publisher_version, published_by,
    published_at
  ) values (
    v_publication_id, p_workspace_key, p_channel, v_publication_version,
    p_build_id, p_source_cut_id,
    case when v_head.publication_id is null then null else v_head.publication_id end,
    p_publication_reason, p_packet_hash, v_delivery_payload_hash,
    p_semantic_hash, p_publisher_version, p_published_by, v_now
  );
  insert into public.truth_publication_payloads (
    publication_id, workspace_key, channel, publication_version,
    source_cut_id, packet_hash, reducer_packet_hash, semantic_hash,
    delivery_payload, delivery_canonical_text, delivery_payload_hash,
    active_index_payload, active_index_hash
  ) values (
    v_publication_id, p_workspace_key, p_channel, v_publication_version,
    p_source_cut_id, p_packet_hash, p_reducer_packet_hash, p_semantic_hash,
    v_delivery_payload, v_delivery_payload::text, v_delivery_payload_hash,
    v_active_index, v_active_index_hash
  );
  insert into public.truth_publication_requests (
    workspace_key, channel, publication_request_key,
    request_hash, publication_id
  ) values (
    p_workspace_key, p_channel, p_publication_request_key,
    v_request_hash, v_publication_id
  );
  insert into public.truth_publication_heads (
    workspace_key, channel, publication_id, publication_version,
    packet_hash, delivery_payload_hash, source_cut_id, updated_at
  ) values (
    p_workspace_key, p_channel, v_publication_id, v_publication_version,
    p_packet_hash, v_delivery_payload_hash, p_source_cut_id, v_now
  ) on conflict (workspace_key, channel) do update
  set publication_id = excluded.publication_id,
      publication_version = excluded.publication_version,
      packet_hash = excluded.packet_hash,
      delivery_payload_hash = excluded.delivery_payload_hash,
      source_cut_id = excluded.source_cut_id,
      updated_at = excluded.updated_at;

  if p_channel = 'production' then
    insert into public.app_snapshots (snapshot_key, payload, updated_at)
    values ('shipment-truth-packets', v_delivery_payload, v_now)
    on conflict (snapshot_key) do update
    set payload = excluded.payload,
        updated_at = excluded.updated_at;
    insert into public.app_snapshot_metadata (
      snapshot_key, snapshot_time, updated_at, writer_version,
      content_signature, payload_bytes
    ) values (
      'shipment-truth-packets', v_delivery_payload->>'snapshotTime', v_now,
      p_publisher_version, v_delivery_payload_hash,
      pg_column_size(v_delivery_payload)::integer
    ) on conflict (snapshot_key) do update
    set snapshot_time = excluded.snapshot_time,
        updated_at = excluded.updated_at,
        writer_version = excluded.writer_version,
        content_signature = excluded.content_signature,
        payload_bytes = excluded.payload_bytes;
    insert into public.app_snapshots (snapshot_key, payload, updated_at)
    values ('active-awb-index', v_active_index, v_now)
    on conflict (snapshot_key) do update
    set payload = excluded.payload,
        updated_at = excluded.updated_at;
    insert into public.app_snapshot_metadata (
      snapshot_key, snapshot_time, updated_at, writer_version,
      content_signature, payload_bytes
    ) values (
      'active-awb-index', v_active_index->>'snapshotTime', v_now,
      'active-awb-index-v2', v_active_index_hash,
      pg_column_size(v_active_index)::integer
    ) on conflict (snapshot_key) do update
    set snapshot_time = excluded.snapshot_time,
        updated_at = excluded.updated_at,
        writer_version = excluded.writer_version,
        content_signature = excluded.content_signature,
        payload_bytes = excluded.payload_bytes;
  end if;

  return private.truth_publication_runtime_receipt(v_publication_id, false);
end;
$function$;

create or replace function private.publish_truth_build_pair_runtime_cas(
  p_build_pair_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publication_reason text,
  p_publisher_version text,
  p_published_by text,
  p_production_confirmation text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_build public.truth_builds%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_pair
  from public.truth_build_pair_runs
  where build_pair_id = p_build_pair_id;
  if not found or v_pair.status <> 'succeeded'
    or not exists (
      select 1
      from public.truth_build_parity_receipts parity
      where parity.build_pair_id = v_pair.build_pair_id
        and parity.exact_payload_equal
        and parity.citation_integrity_ok
        and parity.source_cut_integrity_ok
    ) then
    raise exception 'truth build pair lacks successful exact parity proof'
      using errcode = '23514';
  end if;
  if p_publication_reason is null
    or not (p_publication_reason = any (array['normal', 'repair'])) then
    raise exception 'build-pair publication reason must be normal or repair'
      using errcode = '22023';
  end if;
  if v_pair.publication_channel = 'production'
    and p_production_confirmation is distinct from
      'I_EXPLICITLY_AUTHORIZE_PRODUCTION_TRUTH_PUBLICATION' then
    raise exception 'production truth publication requires explicit confirmation'
      using errcode = '42501';
  end if;
  select * into v_build
  from public.truth_builds
  where build_id = v_pair.full_build_id
    and status = 'succeeded';
  if not found
    or v_build.packet_hash is distinct from v_pair.packet_hash
    or v_build.packet_payload is null then
    raise exception 'truth build pair full output is unavailable' using errcode = '23514';
  end if;

  return private.commit_truth_publication_runtime(
    v_pair.workspace_key,
    v_pair.publication_channel,
    v_build.build_id,
    v_pair.source_cut_id,
    v_build.packet_payload,
    v_pair.packet_hash,
    v_pair.reducer_packet_hash,
    v_pair.semantic_hash,
    p_publication_reason,
    p_publisher_version,
    p_published_by,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_sync_token
  );
end;
$function$;

create or replace function private.publish_truth_rollback_forward(
  p_workspace_key text,
  p_channel text,
  p_target_publication_id uuid,
  p_publication_request_key text,
  p_expected_head_version bigint,
  p_expected_head_packet_hash text,
  p_publisher_version text,
  p_published_by text,
  p_production_confirmation text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target public.truth_publications%rowtype;
  v_target_payload public.truth_publication_payloads%rowtype;
  v_target_build public.truth_builds%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_channel is null or not (p_channel = any (array['shadow', 'production'])) then
    raise exception 'rollback publication channel is invalid' using errcode = '22023';
  end if;
  if p_channel = 'production'
    and p_production_confirmation is distinct from
      'I_EXPLICITLY_AUTHORIZE_PRODUCTION_TRUTH_PUBLICATION' then
    raise exception 'production truth rollback requires explicit confirmation'
      using errcode = '42501';
  end if;
  select publication.* into v_target
  from public.truth_publications publication
  where publication.publication_id = p_target_publication_id
    and publication.workspace_key = p_workspace_key
    and publication.channel = p_channel;
  if not found then
    raise exception 'rollback target publication is unavailable' using errcode = '23503';
  end if;
  select payload.* into v_target_payload
  from public.truth_publication_payloads payload
  where payload.publication_id = v_target.publication_id;
  if not found then
    raise exception 'rollback target delivery payload is unavailable' using errcode = '23503';
  end if;
  if v_target.publication_version >= p_expected_head_version then
    raise exception 'rollback target must precede the current head version'
      using errcode = '23514';
  end if;
  select * into v_target_build
  from public.truth_builds
  where build_id = v_target.build_id
    and status = 'succeeded';
  if not found or v_target_build.packet_payload is null
    or v_target_build.packet_hash is distinct from v_target.packet_hash then
    raise exception 'rollback target build payload is unavailable' using errcode = '23514';
  end if;

  return private.commit_truth_publication_runtime(
    p_workspace_key,
    p_channel,
    v_target.build_id,
    v_target.source_cut_id,
    v_target_build.packet_payload,
    v_target.packet_hash,
    v_target_payload.reducer_packet_hash,
    v_target.semantic_hash,
    'rollback',
    p_publisher_version,
    p_published_by,
    p_publication_request_key,
    p_expected_head_version,
    p_expected_head_packet_hash,
    p_sync_token
  );
end;
$function$;

create or replace function private.read_truth_publication_head_runtime(
  p_workspace_key text,
  p_channel text,
  p_max_payload_bytes integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_head public.truth_publication_heads%rowtype;
  v_payload public.truth_publication_payloads%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_channel is null or not (p_channel = any (array['shadow', 'production']))
    or p_max_payload_bytes is null or p_max_payload_bytes < 1024
    or p_max_payload_bytes > 33554432 then
    raise exception 'truth publication head read bound is invalid' using errcode = '22023';
  end if;
  select * into v_head
  from public.truth_publication_heads head
  where head.workspace_key = p_workspace_key
    and head.channel = p_channel;
  if not found then
    return jsonb_build_object(
      'ok', true,
      'found', false,
      'workspaceKey', p_workspace_key,
      'channel', p_channel,
      'truncated', false
    );
  end if;
  select * into v_payload
  from public.truth_publication_payloads payload
  where payload.publication_id = v_head.publication_id;
  if not found
    or v_payload.delivery_payload_hash is distinct from v_head.delivery_payload_hash
    or v_payload.delivery_canonical_text is distinct from v_payload.delivery_payload::text
    or v_payload.delivery_payload_hash is distinct from encode(extensions.digest(
      convert_to((v_payload.delivery_payload - 'deliveryPayloadHash' - 'contentSignature')::text, 'UTF8'),
      'sha256'
    ), 'hex') then
    raise exception 'truth publication head payload integrity failed' using errcode = '23514';
  end if;
  if pg_column_size(v_payload.delivery_payload) > p_max_payload_bytes then
    raise exception 'truth publication head exceeds the caller read bound; truncation is forbidden'
      using errcode = '54000';
  end if;
  return jsonb_build_object(
    'ok', true,
    'found', true,
    'workspaceKey', p_workspace_key,
    'channel', p_channel,
    'publicationId', v_head.publication_id,
    'publicationVersion', v_head.publication_version,
    'sourceCutId', v_head.source_cut_id,
    'packetHash', v_head.packet_hash,
    'deliveryPayloadHash', v_head.delivery_payload_hash,
    'deliveryPayload', v_payload.delivery_payload,
    'activeIndexPayload', v_payload.active_index_payload,
    'payloadBytes', pg_column_size(v_payload.delivery_payload),
    'maxPayloadBytes', p_max_payload_bytes,
    'truncated', false
  );
end;
$function$;

create or replace function private.renew_truth_build_pair_lease(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_lease_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'truth build lease duration is invalid' using errcode = '22023';
  end if;
  v_pair := private.require_truth_build_pair_lease(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence
  );
  update public.truth_build_pair_runs
  set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  where build_pair_id = p_build_pair_id
  returning * into v_pair;
  return private.truth_build_pair_receipt(v_pair, false, false);
end;
$function$;

create or replace function private.read_truth_build_bundle(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_pair := private.require_truth_build_pair_lease(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence
  );
  return private.truth_build_bundle_from_inputs(v_pair.build_pair_id);
end;
$function$;

create or replace function private.fail_truth_build_pair(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_error_code text,
  p_safe_error_detail text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_detail text;
  v_now timestamptz := clock_timestamp();
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_pair
  from public.truth_build_pair_runs
  where build_pair_id = p_build_pair_id
  for update;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  if v_pair.status = 'failed' then
    return private.truth_build_pair_receipt(v_pair, true, false);
  end if;
  if v_pair.status <> 'running'
    or v_pair.lease_owner is distinct from p_worker_id
    or v_pair.lease_fence is distinct from p_lease_fence
    or v_pair.lease_expires_at <= v_now then
    raise exception 'truth build pair lease is stale' using errcode = '40001';
  end if;
  if nullif(trim(coalesce(p_error_code, '')), '') is null then
    raise exception 'truth build failure code is required' using errcode = '22023';
  end if;
  v_detail := left(regexp_replace(
    coalesce(p_safe_error_detail, ''),
    '[[:space:]]+',
    ' ',
    'g'
  ), 1000);

  update public.truth_builds
  set status = 'failed',
      validation_report = jsonb_build_object(
        'schemaVersion', 'truth-build-server-validation-v1',
        'ok', false,
        'errorCode', p_error_code
      ),
      error_code = p_error_code,
      error_detail = v_detail,
      finished_at = v_now
  where build_id = any (array[v_pair.full_build_id, v_pair.incremental_build_id])
    and status = 'running';

  update public.truth_build_pair_runs
  set status = 'failed',
      error_code = p_error_code,
      safe_error_detail = v_detail,
      finished_at = v_now,
      updated_at = v_now
  where build_pair_id = v_pair.build_pair_id
  returning * into v_pair;
  return private.truth_build_pair_receipt(v_pair, false, false);
end;
$function$;

create or replace function private.require_exact_complete_source_cut(
  p_workspace_key text,
  p_source_cut_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_cut public.source_cuts%rowtype;
  v_manifest_cursor_count integer;
begin
  select * into v_cut
  from public.source_cuts
  where source_cut_id = p_source_cut_id
    and workspace_key = p_workspace_key;
  if not found then
    raise exception 'truth build source cut is unavailable' using errcode = '23503';
  end if;
  if v_cut.completeness <> 'complete'
    or jsonb_typeof(v_cut.gaps) <> 'array'
    or jsonb_array_length(v_cut.gaps) <> 0
    or jsonb_typeof(v_cut.manifest) <> 'object'
    or v_cut.manifest_schema_version <> 'source-cut-manifest-v2'
    or v_cut.manifest->>'schemaVersion' <> 'source-cut-manifest-v2'
    or v_cut.manifest->>'partitionWitnessVersion' <> 'source-cut-partition-witness-v1'
    or v_cut.manifest ? 'observations'
    or jsonb_typeof(v_cut.manifest->'cursors') <> 'array'
    or jsonb_typeof(v_cut.manifest->'requiredSources') <> 'array' then
    raise exception 'truth build source cut is incomplete or malformed' using errcode = '23514';
  end if;
  if v_cut.manifest_hash is distinct from encode(extensions.digest(
      convert_to(v_cut.manifest::text, 'UTF8'), 'sha256'
    ), 'hex')
    or v_cut.source_cut_id is distinct from 'cut:v1:' || v_cut.manifest_hash
    or v_cut.manifest->>'workspaceKey' is distinct from p_workspace_key then
    raise exception 'truth build source cut identity is corrupt' using errcode = '23514';
  end if;

  if v_cut.observation_count is distinct from coalesce((
      select sum(cursor_row.observation_count)::integer
      from public.source_cut_cursors cursor_row
      where cursor_row.source_cut_id = v_cut.source_cut_id
    ), 0)
    or exists (
      select 1 from public.source_cut_observations membership
      where membership.source_cut_id = v_cut.source_cut_id
    ) then
    raise exception 'truth build source cut compact partition count is not exact'
      using errcode = '23514';
  end if;

  select count(*)::integer into v_manifest_cursor_count
  from jsonb_array_elements(v_cut.manifest->'cursors');
  if v_manifest_cursor_count = 0
    or v_manifest_cursor_count <> (
      select count(*)::integer
      from public.source_cut_cursors cursor_row
      where cursor_row.source_cut_id = v_cut.source_cut_id
    )
    or exists (
      select 1
      from jsonb_array_elements(v_cut.manifest->'cursors') item
      left join public.source_cut_cursors cursor_row
        on cursor_row.source_cut_id = v_cut.source_cut_id
       and cursor_row.source_system = item->>'sourceSystem'
       and cursor_row.connection_key = item->>'connectionKey'
      where cursor_row.source_cut_id is null
        or cursor_row.cursor_kind is distinct from item->>'cursorKind'
        or cursor_row.through_cursor_version is distinct from
          (item->>'throughCursorVersion')::bigint
        or cursor_row.through_cursor_value is distinct from item->>'throughCursorValue'
        or cursor_row.upstream_watermark is distinct from coalesce(item->>'upstreamWatermark', '')
        or cursor_row.source_snapshot_at is distinct from
          nullif(item->>'sourceSnapshotAt', '')::timestamptz
        or cursor_row.partition_hash is distinct from item->>'partitionHash'
        or cursor_row.observation_count is distinct from
          (item->>'observationCount')::integer
        or coalesce(item->>'emptyScope', '') not in ('true', 'false')
        or (item->>'emptyScope')::boolean is distinct from
          (cursor_row.observation_count = 0)
    )
    or exists (
      select 1
      from jsonb_array_elements(v_cut.manifest->'requiredSources') required_source
      left join public.source_cut_cursors cursor_row
        on cursor_row.source_cut_id = v_cut.source_cut_id
       and cursor_row.source_system = required_source->>'sourceSystem'
       and cursor_row.connection_key = required_source->>'connectionKey'
      where cursor_row.source_cut_id is null
    ) then
    raise exception 'truth build source cut cursor partition witness is not exact'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'sourceCutId', v_cut.source_cut_id,
    'manifestHash', v_cut.manifest_hash,
    'completeness', v_cut.completeness,
    'manifest', v_cut.manifest,
    'observationCount', v_cut.observation_count,
    'sealedAt', v_cut.sealed_at
  );
end;
$function$;

create or replace function private.derive_truth_build_candidate_manifest(
  p_workspace_key text,
  p_source_cut_id text,
  p_versions jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_cut jsonb;
  v_claim_inputs jsonb;
  v_link_inputs jsonb;
  v_membership_inputs jsonb;
  v_workgroup_definitions jsonb;
  v_extractor_versions jsonb;
  v_linker_versions jsonb;
  v_extractor_set_version text;
  v_linker_set_version text;
  v_claim_manifest_hash text;
  v_link_manifest_hash text;
  v_membership_manifest_hash text;
  v_workgroup_definition_manifest_hash text;
  v_input_manifest jsonb;
  v_input_manifest_hash text;
  v_source_watermark jsonb;
  v_bundle_row_count integer;
  v_evidence_observation_count integer;
begin
  v_cut := private.require_exact_complete_source_cut(p_workspace_key, p_source_cut_id);

  if jsonb_typeof(coalesce(p_versions, 'null'::jsonb)) <> 'object'
    or exists (
      select 1
      from unnest(array[
        'reducerVersion', 'packetBuilderVersion', 'packetSchemaVersion',
        'precedencePolicyVersion', 'precedencePolicyHash'
      ]) required_key
      where nullif(trim(coalesce(p_versions->>required_key, '')), '') is null
    )
    or exists (
      select 1 from jsonb_object_keys(p_versions) supplied_key
      where not (supplied_key = any (array[
        'reducerVersion', 'packetBuilderVersion', 'packetSchemaVersion',
        'precedencePolicyVersion', 'precedencePolicyHash'
      ]))
    )
    or coalesce(p_versions->>'precedencePolicyHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'truth build version vector is invalid' using errcode = '22023';
  end if;

  -- A candidate input is eligible only when its complete authoritative
  -- envelope exists and every evidence observation is inside the exact cut.
  with eligible as (
    select envelope.claim_version_id as item_id,
           envelope.envelope_hash as item_hash
    from public.accepted_claim_envelopes envelope
    join public.accepted_claims claim
      on claim.claim_version_id = envelope.claim_version_id
     and claim.claim_content_hash = envelope.envelope_hash
    where envelope.workspace_key = p_workspace_key
      and exists (
        select 1 from public.accepted_claim_evidence evidence
        where evidence.claim_version_id = claim.claim_version_id
          and evidence.evidence_role = 'primary'
      )
      and not exists (
        select 1
        from public.accepted_claim_evidence evidence
        left join public.source_observations evidence_observation
          on evidence_observation.observation_id = evidence.observation_id
        where evidence.claim_version_id = claim.claim_version_id
          and not private.source_observation_within_cut(
            p_workspace_key, p_source_cut_id, evidence.observation_id,
            evidence_observation.content_hash
          )
      )
      and not exists (
        select 1
        from private.truth_packet_citation_ids(
          envelope.canonical_envelope, 'observation'
        ) citation
        left join public.source_observations cited_observation
          on cited_observation.observation_id = citation.citation_id
        where not private.source_observation_within_cut(
          p_workspace_key, p_source_cut_id, citation.citation_id,
          cited_observation.content_hash
        )
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'itemHash', item_hash
  ) order by item_id), '[]'::jsonb)
  into v_claim_inputs
  from eligible;

  with eligible as (
    select envelope.link_version_id as item_id,
           envelope.envelope_hash as item_hash
    from public.observation_entity_link_envelopes envelope
    join public.observation_entity_links entity_link
      on entity_link.link_version_id = envelope.link_version_id
     and entity_link.content_hash = envelope.envelope_hash
    join public.source_observations evidence_observation
      on evidence_observation.observation_id = entity_link.observation_id
    where envelope.workspace_key = p_workspace_key
      and private.source_observation_within_cut(
        p_workspace_key, p_source_cut_id, entity_link.observation_id,
        evidence_observation.content_hash
      )
      and not exists (
        select 1
        from private.truth_packet_citation_ids(
          envelope.canonical_envelope, 'observation'
        ) citation
        left join public.source_observations cited_observation
          on cited_observation.observation_id = citation.citation_id
        where not private.source_observation_within_cut(
          p_workspace_key, p_source_cut_id, citation.citation_id,
          cited_observation.content_hash
        )
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'itemHash', item_hash
  ) order by item_id), '[]'::jsonb)
  into v_link_inputs
  from eligible;

  with eligible as (
    select envelope.membership_version_id as item_id,
           envelope.envelope_hash as item_hash,
           envelope.workgroup_id
    from public.operational_workgroup_membership_envelopes envelope
    join public.operational_workgroup_memberships membership
      on membership.membership_version_id = envelope.membership_version_id
     and membership.content_hash = envelope.envelope_hash
     and membership.workgroup_id = envelope.workgroup_id
    join public.operational_workgroup_envelopes workgroup
      on workgroup.workgroup_id = envelope.workgroup_id
     and workgroup.workspace_key = p_workspace_key
     and workgroup.workspace_key = envelope.workspace_key
    where envelope.workspace_key = p_workspace_key
      and exists (
        select 1
        from public.operational_workgroup_membership_evidence evidence
        where evidence.membership_version_id = membership.membership_version_id
          and evidence.evidence_role = 'primary'
      )
      and not exists (
        select 1
        from public.operational_workgroup_membership_evidence evidence
        left join public.source_observations evidence_observation
          on evidence_observation.observation_id = evidence.observation_id
        where evidence.membership_version_id = membership.membership_version_id
          and not private.source_observation_within_cut(
            p_workspace_key, p_source_cut_id, evidence.observation_id,
            evidence_observation.content_hash
          )
      )
      and not exists (
        select 1
        from (
          select citation.citation_id
          from private.truth_packet_citation_ids(
            envelope.canonical_envelope, 'observation'
          ) citation
          union
          select citation.citation_id
          from private.truth_packet_citation_ids(
            workgroup.canonical_definition, 'observation'
          ) citation
        ) cited
        left join public.source_observations cited_observation
          on cited_observation.observation_id = cited.citation_id
        where not private.source_observation_within_cut(
          p_workspace_key, p_source_cut_id, cited.citation_id,
          cited_observation.content_hash
        )
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'itemHash', item_hash
  ) order by item_id), '[]'::jsonb)
  into v_membership_inputs
  from eligible;

  select coalesce(jsonb_agg(jsonb_build_object(
    'workgroupId', workgroup.workgroup_id,
    'definitionHash', workgroup.definition_hash
  ) order by workgroup.workgroup_id), '[]'::jsonb)
  into v_workgroup_definitions
  from public.operational_workgroup_envelopes workgroup
  where workgroup.workspace_key = p_workspace_key
    and exists (
      select 1
      from jsonb_array_elements(v_membership_inputs) membership_input
      join public.operational_workgroup_membership_envelopes membership
        on membership.membership_version_id = membership_input->>'itemId'
      where membership.workgroup_id = workgroup.workgroup_id
    );

  -- Every version-chain and supersession edge must close inside the frozen
  -- candidate set. There is no partial-context or best-effort reduction.
  if exists (
    select 1
    from jsonb_array_elements(v_claim_inputs) item
    join public.accepted_claims claim
      on claim.claim_version_id = item->>'itemId'
    left join jsonb_array_elements(v_claim_inputs) prior
      on prior->>'itemId' = claim.previous_claim_version_id
    where claim.previous_claim_version_id is not null and prior is null
  ) or exists (
    select 1
    from jsonb_array_elements(v_claim_inputs) item
    join public.claim_supersessions supersession
      on supersession.resolving_claim_version_id = item->>'itemId'
    left join jsonb_array_elements(v_claim_inputs) target
      on target->>'itemId' = supersession.superseded_claim_version_id
    where target is null
  ) then
    raise exception 'accepted claim bundle is not recursively closed' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_link_inputs) item
    join public.observation_entity_links entity_link
      on entity_link.link_version_id = item->>'itemId'
    left join jsonb_array_elements(v_link_inputs) prior
      on prior->>'itemId' = entity_link.previous_link_version_id
    where entity_link.previous_link_version_id is not null and prior is null
  ) then
    raise exception 'entity-link bundle is not recursively closed' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_membership_inputs) item
    join public.operational_workgroup_memberships membership
      on membership.membership_version_id = item->>'itemId'
    left join jsonb_array_elements(v_membership_inputs) prior
      on prior->>'itemId' = membership.previous_membership_version_id
    where membership.previous_membership_version_id is not null and prior is null
  ) then
    raise exception 'workgroup membership bundle is not recursively closed' using errcode = '23514';
  end if;

  if exists (
    select 1
    from (
      select 'accepted_claim'::text as item_kind,
             item->>'itemId' as item_id,
             item->>'itemHash' as item_hash
      from jsonb_array_elements(v_claim_inputs) item
      union all
      select 'entity_link', item->>'itemId', item->>'itemHash'
      from jsonb_array_elements(v_link_inputs) item
      union all
      select 'workgroup_membership', item->>'itemId', item->>'itemHash'
      from jsonb_array_elements(v_membership_inputs) item
    ) candidate
    where private.authoritative_truth_input_hash(candidate.item_kind, candidate.item_id)
      is distinct from candidate.item_hash
  ) then
    raise exception 'truth build candidate envelope hash is not authoritative'
      using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(version_row order by version_row::text), '[]'::jsonb)
  into v_extractor_versions
  from (
    select distinct jsonb_build_object(
      'extractorVersion', claim.extractor_version,
      'promptVersion', claim.prompt_version,
      'model', claim.model
    ) as version_row
    from jsonb_array_elements(v_claim_inputs) item
    join public.accepted_claims claim
      on claim.claim_version_id = item->>'itemId'
  ) versions;

  select coalesce(jsonb_agg(version_row order by version_row::text), '[]'::jsonb)
  into v_linker_versions
  from (
    select distinct jsonb_build_object('linkerVersion', entity_link.linker_version) as version_row
    from jsonb_array_elements(v_link_inputs) item
    join public.observation_entity_links entity_link
      on entity_link.link_version_id = item->>'itemId'
    union
    select distinct jsonb_build_object('linkerVersion', membership.linker_version)
    from jsonb_array_elements(v_membership_inputs) item
    join public.operational_workgroup_memberships membership
      on membership.membership_version_id = item->>'itemId'
  ) versions;

  v_extractor_set_version := 'extractor-set:v1:' || encode(extensions.digest(
    convert_to(v_extractor_versions::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_linker_set_version := 'linker-set:v1:' || encode(extensions.digest(
    convert_to(v_linker_versions::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_claim_manifest_hash := encode(extensions.digest(
    convert_to(v_claim_inputs::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_link_manifest_hash := encode(extensions.digest(
    convert_to(v_link_inputs::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_membership_manifest_hash := encode(extensions.digest(
    convert_to(v_membership_inputs::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_workgroup_definition_manifest_hash := encode(extensions.digest(
    convert_to(v_workgroup_definitions::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_source_watermark := jsonb_build_object(
    'sourceCutId', p_source_cut_id,
    'manifestHash', v_cut->>'manifestHash',
    'completeness', 'complete',
    'cursors', v_cut->'manifest'->'cursors'
  );
  v_input_manifest := jsonb_build_object(
    'schemaVersion', 'truth-build-input-manifest-v2',
    'workspaceKey', p_workspace_key,
    'sourceCutId', p_source_cut_id,
    'sourceManifestHash', v_cut->>'manifestHash',
    'claims', v_claim_inputs,
    'entityLinks', v_link_inputs,
    'workgroupMemberships', v_membership_inputs,
    'workgroupDefinitions', v_workgroup_definitions,
    'extractorSetVersion', v_extractor_set_version,
    'linkerSetVersion', v_linker_set_version,
    'versions', p_versions
  );
  v_input_manifest_hash := encode(extensions.digest(
    convert_to(v_input_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  with evidence_ids as (
    select evidence.observation_id
    from jsonb_array_elements(v_claim_inputs) item
    join public.accepted_claim_evidence evidence
      on evidence.claim_version_id = item->>'itemId'
    union
    select entity_link.observation_id
    from jsonb_array_elements(v_link_inputs) item
    join public.observation_entity_links entity_link
      on entity_link.link_version_id = item->>'itemId'
    union
    select evidence.observation_id
    from jsonb_array_elements(v_membership_inputs) item
    join public.operational_workgroup_membership_evidence evidence
      on evidence.membership_version_id = item->>'itemId'
    union
    select membership.observation_id
    from jsonb_array_elements(v_membership_inputs) item
    join public.operational_workgroup_memberships membership
      on membership.membership_version_id = item->>'itemId'
    where membership.observation_id is not null
    union
    select membership.basis_observation_id
    from jsonb_array_elements(v_membership_inputs) item
    join public.operational_workgroup_memberships membership
      on membership.membership_version_id = item->>'itemId'
    where membership.basis_observation_id is not null
    union
    select citation.citation_id
    from jsonb_array_elements(v_claim_inputs) item
    join public.accepted_claim_envelopes envelope
      on envelope.claim_version_id = item->>'itemId'
    cross join lateral private.truth_packet_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from jsonb_array_elements(v_link_inputs) item
    join public.observation_entity_link_envelopes envelope
      on envelope.link_version_id = item->>'itemId'
    cross join lateral private.truth_packet_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from jsonb_array_elements(v_membership_inputs) item
    join public.operational_workgroup_membership_envelopes envelope
      on envelope.membership_version_id = item->>'itemId'
    cross join lateral private.truth_packet_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from jsonb_array_elements(v_workgroup_definitions) item
    join public.operational_workgroup_envelopes envelope
      on envelope.workgroup_id = item->>'workgroupId'
    cross join lateral private.truth_packet_citation_ids(
      envelope.canonical_definition, 'observation'
    ) citation
  )
  select count(*)::integer into v_evidence_observation_count from evidence_ids;

  v_bundle_row_count := v_evidence_observation_count
    + jsonb_array_length(v_claim_inputs)
    + jsonb_array_length(v_link_inputs)
    + jsonb_array_length(v_membership_inputs)
    + jsonb_array_length(v_workgroup_definitions);

  return jsonb_build_object(
    'inputManifest', v_input_manifest,
    'inputManifestHash', v_input_manifest_hash,
    'claimInputs', v_claim_inputs,
    'linkInputs', v_link_inputs,
    'workgroupMembershipInputs', v_membership_inputs,
    'workgroupDefinitions', v_workgroup_definitions,
    'claimManifestHash', v_claim_manifest_hash,
    'linkManifestHash', v_link_manifest_hash,
    'workgroupManifestHash', v_membership_manifest_hash,
    'workgroupDefinitionManifestHash', v_workgroup_definition_manifest_hash,
    'extractorSetVersion', v_extractor_set_version,
    'linkerVersion', v_linker_set_version,
    'sourceWatermark', v_source_watermark,
    'bundleRowCount', v_bundle_row_count
  );
end;
$function$;

alter table public.truth_builds
  drop constraint if exists truth_builds_build_pair_id_fkey;
alter table public.truth_builds
  add constraint truth_builds_build_pair_id_fkey
  foreign key (build_pair_id)
  references public.truth_build_pair_runs(build_pair_id)
  on delete restrict
  deferrable initially deferred;

alter table public.truth_build_pair_runs
  drop constraint if exists truth_build_pair_runs_full_build_id_fkey;
alter table public.truth_build_pair_runs
  add constraint truth_build_pair_runs_full_build_id_fkey
  foreign key (full_build_id)
  references public.truth_builds(build_id)
  on delete restrict
  deferrable initially deferred;

alter table public.truth_build_pair_runs
  drop constraint if exists truth_build_pair_runs_incremental_build_id_fkey;
alter table public.truth_build_pair_runs
  add constraint truth_build_pair_runs_incremental_build_id_fkey
  foreign key (incremental_build_id)
  references public.truth_builds(build_id)
  on delete restrict
  deferrable initially deferred;

create unique index if not exists truth_builds_pair_mode_unique
  on public.truth_builds (build_pair_id, build_mode)
  where build_pair_id is not null;

create index if not exists truth_build_pair_runs_claim_idx
  on public.truth_build_pair_runs (workspace_key, status, lease_expires_at, started_at);

-- The old uniqueness rule prevented publication-forward rollback because the
-- prior build could be published only once. Normal/repair publication remains
-- one-per-build; rollback is an explicit new event with a new request key.
alter table public.truth_publications
  drop constraint if exists truth_publications_workspace_key_channel_build_id_key;
create unique index if not exists truth_publications_normal_build_unique
  on public.truth_publications (workspace_key, channel, build_id)
  where publication_reason <> 'rollback';

create or replace function public.guard_truth_build_pair_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth build pair runs cannot be deleted' using errcode = '55000';
  end if;
  if old.status <> 'running' then
    raise exception 'final truth build pair runs are immutable' using errcode = '55000';
  end if;
  if row(
    new.build_pair_id, new.workspace_key, new.idempotency_key,
    new.caller_request_hash, new.source_cut_id, new.build_channel,
    new.publication_channel, new.trigger_name, new.base_publication_id,
    new.full_build_id, new.incremental_build_id, new.input_manifest_hash,
    new.claim_manifest_hash, new.link_manifest_hash,
    new.workgroup_manifest_hash, new.workgroup_definition_manifest_hash,
    new.extractor_set_version, new.linker_version, new.reducer_version,
    new.packet_builder_version, new.packet_schema_version,
    new.precedence_policy_version, new.precedence_policy_hash,
    new.source_watermark, new.bundle_row_count, new.bundle_row_limit,
    new.started_at
  ) is distinct from row(
    old.build_pair_id, old.workspace_key, old.idempotency_key,
    old.caller_request_hash, old.source_cut_id, old.build_channel,
    old.publication_channel, old.trigger_name, old.base_publication_id,
    old.full_build_id, old.incremental_build_id, old.input_manifest_hash,
    old.claim_manifest_hash, old.link_manifest_hash,
    old.workgroup_manifest_hash, old.workgroup_definition_manifest_hash,
    old.extractor_set_version, old.linker_version, old.reducer_version,
    old.packet_builder_version, old.packet_schema_version,
    old.precedence_policy_version, old.precedence_policy_hash,
    old.source_watermark, old.bundle_row_count, old.bundle_row_limit,
    old.started_at
  ) then
    raise exception 'truth build pair immutable manifest changed' using errcode = '55000';
  end if;
  if new.lease_fence < old.lease_fence
    or new.attempt_count < old.attempt_count then
    raise exception 'truth build pair lease fence regressed' using errcode = '55000';
  end if;
  if new.status = 'running' then
    if new.packet_hash is not null or new.reducer_output_hash is not null
      or new.reducer_packet_hash is not null
      or new.semantic_hash is not null or new.finished_at is not null
      or new.error_code <> '' then
      raise exception 'running truth build pair carries final state' using errcode = '23514';
    end if;
  elsif new.status = 'succeeded' then
    if new.packet_hash is null or new.reducer_output_hash is null
      or new.reducer_packet_hash is null
      or new.semantic_hash is null or new.finished_at is null
      or not exists (
        select 1 from public.truth_build_parity_receipts receipt
        where receipt.build_pair_id = old.build_pair_id
          and receipt.full_build_id = old.full_build_id
          and receipt.incremental_build_id = old.incremental_build_id
      ) then
      raise exception 'successful truth build pair lacks parity proof' using errcode = '23514';
    end if;
  elsif new.status = 'failed' then
    if nullif(trim(new.error_code), '') is null or new.finished_at is null then
      raise exception 'failed truth build pair lacks durable error evidence' using errcode = '23514';
    end if;
  else
    raise exception 'unsupported truth build pair transition' using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_build_pair_runs_guard
  on public.truth_build_pair_runs;
create trigger truth_build_pair_runs_guard
before update or delete on public.truth_build_pair_runs
for each row execute function public.guard_truth_build_pair_transition();

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'truth_build_parity_receipts',
    'truth_publication_payloads',
    'truth_publication_requests'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',
      v_table,
      v_table
    );
  end loop;
end;
$block$;

create or replace function private.truth_packet_citation_ids(
  p_packet jsonb,
  p_kind text
)
returns table(citation_id text)
language sql
immutable
security invoker
set search_path = ''
as $function$
  with recursive nodes(value) as (
    select p_packet
    union all
    select child.value
    from nodes parent
    cross join lateral (
      select object_child.value
      from jsonb_each(parent.value) object_child
      where jsonb_typeof(parent.value) = 'object'
      union all
      select array_child.value
      from jsonb_array_elements(parent.value) array_child
      where jsonb_typeof(parent.value) = 'array'
    ) child
  ), entries as (
    select entry.key, entry.value
    from nodes
    cross join lateral jsonb_each(nodes.value) entry
    where jsonb_typeof(nodes.value) = 'object'
  ), raw_ids as (
    select value #>> '{}' as citation_id
    from entries
    where jsonb_typeof(value) = 'string'
      and (
        (p_kind = 'claim' and lower(key) ~ 'claimversionid$')
        or (p_kind = 'observation' and lower(key) ~ 'observationid$')
      )
    union all
    select array_value #>> '{}'
    from entries
    cross join lateral jsonb_array_elements(entries.value) array_value
    where jsonb_typeof(entries.value) = 'array'
      and jsonb_typeof(array_value) = 'string'
      and (
        (p_kind = 'claim' and lower(key) ~ '(claimversionids|acceptedclaimids)$')
        or (p_kind = 'observation' and lower(key) ~ '(observationids|evidenceobservationids)$')
      )
  )
  select distinct raw_ids.citation_id
  from raw_ids
  where nullif(raw_ids.citation_id, '') is not null;
$function$;

create or replace function private.truth_packet_has_recursive_key(
  p_packet jsonb,
  p_key_pattern text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  with recursive nodes(value) as (
    select p_packet
    union all
    select child.value
    from nodes parent
    cross join lateral (
      select object_child.value
      from jsonb_each(parent.value) object_child
      where jsonb_typeof(parent.value) = 'object'
      union all
      select array_child.value
      from jsonb_array_elements(parent.value) array_child
      where jsonb_typeof(parent.value) = 'array'
    ) child
  )
  select exists (
    select 1
    from nodes
    cross join lateral jsonb_object_keys(nodes.value) supplied_key
    where jsonb_typeof(nodes.value) = 'object'
      and supplied_key ~* p_key_pattern
  );
$function$;

create or replace function private.complete_truth_build_pair(
  p_build_pair_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_full_packet jsonb,
  p_incremental_packet jsonb,
  p_full_semantic_hash text,
  p_incremental_semantic_hash text,
  p_full_validation_report jsonb,
  p_incremental_validation_report jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pair public.truth_build_pair_runs%rowtype;
  v_full_packet_hash text;
  v_incremental_packet_hash text;
  v_full_reducer_output jsonb;
  v_incremental_reducer_output jsonb;
  v_full_reducer_output_hash text;
  v_incremental_reducer_output_hash text;
  v_reducer_packet_hash text;
  v_now timestamptz := clock_timestamp();
  v_claim_input_count integer;
  v_citation_count integer;
  v_updated_build_count integer;
  v_server_validation jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_pair
  from public.truth_build_pair_runs
  where build_pair_id = p_build_pair_id
  for update;
  if not found then
    raise exception 'truth build pair is unavailable' using errcode = '23503';
  end if;
  v_full_reducer_output := p_full_validation_report->'internalReducerOutput';
  v_incremental_reducer_output := p_incremental_validation_report->'internalReducerOutput';
  if v_pair.status = 'succeeded' then
    v_full_packet_hash := encode(extensions.digest(
      convert_to(p_full_packet::text, 'UTF8'), 'sha256'
    ), 'hex');
    v_full_reducer_output_hash := encode(extensions.digest(
      convert_to(v_full_reducer_output::text, 'UTF8'), 'sha256'
    ), 'hex');
    if v_pair.packet_hash is distinct from v_full_packet_hash
      or v_pair.reducer_output_hash is distinct from v_full_reducer_output_hash
      or v_pair.reducer_packet_hash is distinct from v_full_reducer_output->>'packetHash'
      or v_pair.semantic_hash is distinct from p_full_semantic_hash then
      raise exception 'completed truth build pair retry has conflicting output'
        using errcode = '23505';
    end if;
    return private.truth_build_pair_receipt(v_pair, true, false);
  elsif v_pair.status = 'failed' then
    return private.truth_build_pair_receipt(v_pair, true, false);
  end if;
  v_pair := private.require_truth_build_pair_lease(
    p_build_pair_id,
    p_worker_id,
    p_lease_fence
  );

  if jsonb_typeof(coalesce(p_full_packet, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_incremental_packet, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_full_packet->'shipments', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_incremental_packet->'shipments', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(v_full_reducer_output, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(v_incremental_reducer_output, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(v_full_reducer_output->'shipments', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(v_incremental_reducer_output->'shipments', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(v_full_reducer_output->'acceptedClaimCitations', 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(v_incremental_reducer_output->'acceptedClaimCitations', 'null'::jsonb)) <> 'array' then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_PACKET_SCHEMA_INVALID',
      'Full and incremental delivery packets and internal reducer outputs have invalid schemas.',
      p_sync_token
    );
  end if;

  v_full_packet_hash := encode(extensions.digest(
    convert_to(p_full_packet::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_incremental_packet_hash := encode(extensions.digest(
    convert_to(p_incremental_packet::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_full_reducer_output_hash := encode(extensions.digest(
    convert_to(v_full_reducer_output::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_incremental_reducer_output_hash := encode(extensions.digest(
    convert_to(v_incremental_reducer_output::text, 'UTF8'), 'sha256'
  ), 'hex');
  if p_full_packet is distinct from p_incremental_packet
    or v_full_packet_hash is distinct from v_incremental_packet_hash
    or v_full_reducer_output is distinct from v_incremental_reducer_output
    or v_full_reducer_output_hash is distinct from v_incremental_reducer_output_hash
    or p_full_semantic_hash is distinct from p_incremental_semantic_hash then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_PARITY_MISMATCH',
      'Full and incremental reducer outputs or final delivery packets were not byte/hash equivalent.',
      p_sync_token
    );
  end if;
  if coalesce(p_full_semantic_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_incremental_semantic_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_full_reducer_output->>'packetHash', '') !~ '^[0-9a-f]{64}$'
    or v_full_reducer_output->>'packetHash'
      is distinct from v_incremental_reducer_output->>'packetHash'
    or p_full_packet->>'packetHash'
      is distinct from v_full_reducer_output->>'packetHash'
    or p_incremental_packet->>'packetHash'
      is distinct from v_incremental_reducer_output->>'packetHash' then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_HASH_INVALID',
      'Reducer packet and semantic hashes were absent, malformed, or divergent.',
      p_sync_token
    );
  end if;
  v_reducer_packet_hash := v_full_reducer_output->>'packetHash';

  if v_full_reducer_output->>'reducerVersion' is distinct from v_pair.reducer_version
    or v_full_reducer_output->'sourceCut'->>'sourceCutId' is distinct from v_pair.source_cut_id
    or v_full_reducer_output->'sourceCut'->>'manifestHash' is distinct from (
      select manifest_hash from public.source_cuts
      where source_cut_id = v_pair.source_cut_id
    )
    or v_full_reducer_output->'sourceCut'->>'completeness' is distinct from 'complete'
    or v_full_reducer_output->'sourceWatermark' is distinct from v_pair.source_watermark
    or v_full_reducer_output->'precedencePolicy'->>'policyVersion'
      is distinct from v_pair.precedence_policy_version
    or v_full_reducer_output->'precedencePolicy'->>'policyHash'
      is distinct from v_pair.precedence_policy_hash then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_IDENTITY_MISMATCH',
      'Reducer output did not match the frozen cut, schema, reducer, or precedence-policy identity.',
      p_sync_token
    );
  end if;
  if coalesce(p_full_packet->>'schemaVersion', p_full_packet->>'writerVersion', '')
      is distinct from v_pair.packet_schema_version
    or jsonb_typeof(coalesce(p_full_packet->'truthProvenance', 'null'::jsonb)) <> 'object'
    or p_full_packet->'truthProvenance'->>'schemaVersion'
      is distinct from 'relational-truth-delivery-provenance-v1'
    or p_full_packet->'truthProvenance'->>'sourceCutId'
      is distinct from v_pair.source_cut_id
    or p_full_packet->'truthProvenance'->>'reducerPacketHash'
      is distinct from v_reducer_packet_hash
    or p_full_packet->'truthProvenance'->>'inputManifestHash'
      is distinct from v_full_reducer_output->>'inputManifestHash'
    or p_full_packet->'truthProvenance'->>'reducerVersion'
      is distinct from v_pair.reducer_version
    or p_full_packet->'truthProvenance'->>'precedencePolicyVersion'
      is distinct from v_pair.precedence_policy_version
    or p_full_packet->'truthProvenance'->>'precedencePolicyHash'
      is distinct from v_pair.precedence_policy_hash
    or coalesce(p_full_packet->'truthProvenance'->>'acceptedClaimManifestHash', '')
      !~ '^[0-9a-f]{64}$' then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_DELIVERY_PROVENANCE_MISMATCH',
      'Final UI delivery packet is not cryptographically bound to the validated reducer output.',
      p_sync_token
    );
  end if;
  if private.truth_packet_has_recursive_key(
      v_full_reducer_output,
      '^(basePublication|basePublicationId|publicationId|publicationVersion|deliveryPayloadHash|contentSignature)$'
    ) or private.truth_packet_has_recursive_key(
      p_full_packet,
      '^(basePublication|basePublicationId|publicationId|publicationVersion|publicationChannel|publishedAt|deliveryPayloadHash|contentSignature)$'
    ) then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_FORBIDDEN_INPUT_OR_PUBLICATION_FIELD',
      'Reducer output contains a base-publication or publication-owned field.',
      p_sync_token
    );
  end if;

  if exists (
    select 1
    from private.truth_packet_citation_ids(v_full_reducer_output, 'claim') citation
    left join public.truth_build_inputs input
      on input.build_id = v_pair.full_build_id
     and input.item_kind = 'accepted_claim'
     and input.item_id = citation.citation_id
    where citation.citation_id !~ '^claim:v1:[0-9a-f]{64}$'
      or input.item_id is null
  ) then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_CITATION_ESCAPE',
      'Reducer output recursively cited a claim outside the accepted-claim input manifest.',
      p_sync_token
    );
  end if;
  if exists (
    with evidence_ids as (
      select evidence.observation_id
      from public.truth_build_inputs input
      join public.accepted_claim_evidence evidence
        on input.item_kind = 'accepted_claim'
       and evidence.claim_version_id = input.item_id
      where input.build_id = v_pair.full_build_id
      union
      select entity_link.observation_id
      from public.truth_build_inputs input
      join public.observation_entity_links entity_link
        on input.item_kind = 'entity_link'
       and entity_link.link_version_id = input.item_id
      where input.build_id = v_pair.full_build_id
      union
      select evidence.observation_id
      from public.truth_build_inputs input
      join public.operational_workgroup_membership_evidence evidence
        on input.item_kind = 'workgroup_membership'
       and evidence.membership_version_id = input.item_id
      where input.build_id = v_pair.full_build_id
      union
      select membership.observation_id
      from public.truth_build_inputs input
      join public.operational_workgroup_memberships membership
        on input.item_kind = 'workgroup_membership'
       and membership.membership_version_id = input.item_id
      where input.build_id = v_pair.full_build_id
        and membership.observation_id is not null
      union
      select membership.basis_observation_id
      from public.truth_build_inputs input
      join public.operational_workgroup_memberships membership
        on input.item_kind = 'workgroup_membership'
       and membership.membership_version_id = input.item_id
      where input.build_id = v_pair.full_build_id
        and membership.basis_observation_id is not null
      union
      select citation.citation_id
      from public.truth_build_inputs input
      join public.accepted_claim_envelopes envelope
        on input.item_kind = 'accepted_claim'
       and envelope.claim_version_id = input.item_id
      cross join lateral private.truth_packet_citation_ids(
        envelope.canonical_envelope, 'observation'
      ) citation
      where input.build_id = v_pair.full_build_id
      union
      select citation.citation_id
      from public.truth_build_inputs input
      join public.observation_entity_link_envelopes envelope
        on input.item_kind = 'entity_link'
       and envelope.link_version_id = input.item_id
      cross join lateral private.truth_packet_citation_ids(
        envelope.canonical_envelope, 'observation'
      ) citation
      where input.build_id = v_pair.full_build_id
      union
      select citation.citation_id
      from public.truth_build_inputs input
      join public.operational_workgroup_membership_envelopes envelope
        on input.item_kind = 'workgroup_membership'
       and envelope.membership_version_id = input.item_id
      cross join lateral private.truth_packet_citation_ids(
        envelope.canonical_envelope, 'observation'
      ) citation
      where input.build_id = v_pair.full_build_id
      union
      select citation.citation_id
      from public.truth_build_inputs input
      join public.operational_workgroup_membership_envelopes membership_envelope
        on input.item_kind = 'workgroup_membership'
       and membership_envelope.membership_version_id = input.item_id
      join public.operational_workgroup_envelopes workgroup
        on workgroup.workgroup_id = membership_envelope.workgroup_id
      cross join lateral private.truth_packet_citation_ids(
        workgroup.canonical_definition, 'observation'
      ) citation
      where input.build_id = v_pair.full_build_id
    )
    select 1
    from private.truth_packet_citation_ids(v_full_reducer_output, 'observation') citation
    left join evidence_ids closure
      on closure.observation_id = citation.citation_id
    left join public.source_observations evidence_observation
      on evidence_observation.observation_id = citation.citation_id
    where citation.citation_id !~ '^obs:v1:[0-9a-f]{64}$'
      or closure.observation_id is null
      or not private.source_observation_within_cut(
        v_pair.workspace_key, v_pair.source_cut_id, citation.citation_id,
        evidence_observation.content_hash
      )
  ) then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_EVIDENCE_ESCAPE',
      'Reducer output recursively cited evidence outside its frozen closure or exact source cut.',
      p_sync_token
    );
  end if;

  select count(*)::integer into v_claim_input_count
  from public.truth_build_inputs input
  where input.build_id = v_pair.full_build_id
    and input.item_kind = 'accepted_claim';
  select count(*)::integer into v_citation_count
  from jsonb_array_elements(v_full_reducer_output->'acceptedClaimCitations');
  if v_citation_count <> v_claim_input_count
    or v_citation_count <> (
      select count(distinct citation->>'claimVersionId')::integer
      from jsonb_array_elements(v_full_reducer_output->'acceptedClaimCitations') citation
    )
    or exists (
      select 1
      from jsonb_array_elements(v_full_reducer_output->'acceptedClaimCitations') citation
      left join public.truth_build_inputs input
        on input.build_id = v_pair.full_build_id
       and input.item_kind = 'accepted_claim'
       and input.item_id = citation->>'claimVersionId'
      where jsonb_typeof(citation) <> 'object'
        or input.item_id is null
        or citation->>'envelopeHash' is distinct from input.item_hash
        or jsonb_typeof(coalesce(citation->'evidenceObservationIds', 'null'::jsonb)) <> 'array'
        or exists (
          (
            select value #>> '{}' as observation_id
            from jsonb_array_elements(citation->'evidenceObservationIds') supplied(value)
            except
            select evidence.observation_id
            from public.accepted_claim_evidence evidence
            where evidence.claim_version_id = input.item_id
          ) union all (
            select evidence.observation_id
            from public.accepted_claim_evidence evidence
            where evidence.claim_version_id = input.item_id
            except
            select value #>> '{}'
            from jsonb_array_elements(citation->'evidenceObservationIds') supplied(value)
          )
        )
    ) then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_CITATION_MANIFEST_MISMATCH',
      'Accepted-claim citations did not exactly reproduce every authoritative claim and evidence envelope.',
      p_sync_token
    );
  end if;

  if jsonb_typeof(coalesce(p_full_validation_report, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_incremental_validation_report, 'null'::jsonb)) <> 'object'
    or coalesce((p_full_validation_report->>'schemaValid')::boolean, false) is not true
    or coalesce((p_incremental_validation_report->>'schemaValid')::boolean, false) is not true
    or coalesce((p_full_validation_report->>'deliveryIdentityValid')::boolean, false) is not true
    or coalesce((p_incremental_validation_report->>'deliveryIdentityValid')::boolean, false) is not true
    or p_full_validation_report->>'acceptedClaimManifestHash'
      is distinct from p_full_packet->'truthProvenance'->>'acceptedClaimManifestHash'
    or p_incremental_validation_report->>'acceptedClaimManifestHash'
      is distinct from p_incremental_packet->'truthProvenance'->>'acceptedClaimManifestHash'
    or coalesce(p_full_validation_report->>'deliveryPacketHash', '') !~ '^[0-9a-f]{64}$'
    or p_full_validation_report->>'deliveryPacketHash'
      is distinct from p_incremental_validation_report->>'deliveryPacketHash' then
    return private.fail_truth_build_pair(
      p_build_pair_id, p_worker_id, p_lease_fence,
      'BUILD_CALLER_SCHEMA_VALIDATION_MISSING',
      'The deterministic runner did not attest schema validation for both modes.',
      p_sync_token
    );
  end if;

  v_server_validation := jsonb_build_object(
    'schemaVersion', 'truth-build-server-validation-v1',
    'schemaValid', true,
    'exactSourceCut', true,
    'citationIntegrityOk', true,
    'inputBundleServerDerived', true,
    'internalReducerParity', true,
    'finalDeliveryParity', true,
    'basePublicationUsedAsEvidence', false,
    'reducerProvenance', jsonb_build_object(
      'packetHash', v_reducer_packet_hash,
      'outputHash', v_full_reducer_output_hash,
      'sourceCut', v_full_reducer_output->'sourceCut',
      'sourceWatermark', v_full_reducer_output->'sourceWatermark',
      'inputManifestHash', v_full_reducer_output->>'inputManifestHash',
      'precedencePolicy', v_full_reducer_output->'precedencePolicy',
      'acceptedClaimCitations', v_full_reducer_output->'acceptedClaimCitations',
      'supersessionsApplied', v_full_reducer_output->'supersessionsApplied',
      'workgroups', v_full_reducer_output->'workgroups'
    ),
    'fullRunnerReport', p_full_validation_report - 'internalReducerOutput',
    'incrementalRunnerReport', p_incremental_validation_report - 'internalReducerOutput'
  );

  insert into public.truth_build_parity_receipts (
    build_pair_id, full_build_id, incremental_build_id,
    input_manifest_hash, full_packet_hash, incremental_packet_hash,
    full_reducer_output_hash, incremental_reducer_output_hash,
    reducer_packet_hash, semantic_hash, exact_payload_equal,
    citation_integrity_ok, source_cut_integrity_ok
  ) values (
    v_pair.build_pair_id, v_pair.full_build_id, v_pair.incremental_build_id,
    v_pair.input_manifest_hash, v_full_packet_hash, v_incremental_packet_hash,
    v_full_reducer_output_hash, v_incremental_reducer_output_hash,
    v_reducer_packet_hash, p_full_semantic_hash, true, true, true
  );

  update public.truth_builds
  set status = 'succeeded',
      packet_hash = v_full_packet_hash,
      semantic_hash = p_full_semantic_hash,
      packet_canonical_text = p_full_packet::text,
      packet_payload = p_full_packet,
      validation_report = v_server_validation,
      finished_at = v_now
  where build_id = any (array[v_pair.full_build_id, v_pair.incremental_build_id])
    and status = 'running';
  get diagnostics v_updated_build_count = row_count;
  if v_updated_build_count <> 2 then
    raise exception 'truth build pair finalization lost its running builds'
      using errcode = '40001';
  end if;

  update public.truth_build_pair_runs
  set status = 'succeeded',
      packet_hash = v_full_packet_hash,
      reducer_output_hash = v_full_reducer_output_hash,
      reducer_packet_hash = v_reducer_packet_hash,
      semantic_hash = p_full_semantic_hash,
      finished_at = v_now,
      updated_at = v_now
  where build_pair_id = v_pair.build_pair_id
    and status = 'running'
  returning * into v_pair;
  if not found then
    raise exception 'truth build pair finalization was fenced' using errcode = '40001';
  end if;
  return private.truth_build_pair_receipt(v_pair, false, false);
end;
$function$;

revoke all on function private.require_exact_complete_source_cut(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.derive_truth_build_candidate_manifest(text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_pair_receipt(public.truth_build_pair_runs, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.require_truth_build_pair_lease(uuid, text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_build_bundle_from_inputs(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.claim_truth_build_pair(text, text, text, text, text, text, integer, integer, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.renew_truth_build_pair_lease(uuid, text, bigint, integer, text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_build_bundle(uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function private.fail_truth_build_pair(uuid, text, bigint, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_packet_citation_ids(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_packet_has_recursive_key(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_truth_build_pair(uuid, text, bigint, jsonb, jsonb, text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_publication_runtime_receipt(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.commit_truth_publication_runtime(text, text, uuid, text, jsonb, text, text, text, text, text, text, text, bigint, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.publish_truth_build_pair_runtime_cas(uuid, text, bigint, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.publish_truth_rollback_forward(text, text, uuid, text, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.read_truth_publication_head_runtime(text, text, integer, text)
  from public, anon, authenticated, service_role;

set check_function_bodies = on;

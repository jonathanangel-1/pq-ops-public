create extension if not exists pgcrypto with schema extensions;

-- Versioned claims, entity/workgroup graph, exact source cuts, deterministic
-- builds, atomic publications, and an audit-only witness store.

create table if not exists public.source_cuts (
  source_cut_id text primary key,
  workspace_key text not null,
  manifest_hash text not null unique check (manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null,
  completeness text not null check (completeness = any (array['complete', 'degraded'])),
  required_sources jsonb not null default '[]'::jsonb check (jsonb_typeof(required_sources) = 'array'),
  gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(gaps) = 'array'),
  observation_count integer not null check (observation_count >= 0),
  manifest_schema_version text not null,
  created_by text not null,
  sealed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.source_cut_cursors (
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  source_system text not null,
  connection_key text not null,
  cursor_kind text not null,
  through_cursor_version bigint not null check (through_cursor_version >= 0),
  through_cursor_value text not null default '',
  upstream_watermark text not null default '',
  source_snapshot_at timestamptz,
  observation_count integer not null check (observation_count >= 0),
  partition_hash text not null check (partition_hash ~ '^[0-9a-f]{64}$'),
  primary key (source_cut_id, source_system, connection_key)
);

create table if not exists public.source_cut_observations (
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  ordinal bigint not null check (ordinal >= 0),
  primary key (source_cut_id, observation_id),
  unique (source_cut_id, ordinal)
);

-- Compatibility-only table. Source-cut v2 deliberately leaves it empty: a
-- cut commits the complete journal with one count/hash witness per cursor
-- partition instead of copying every historical observation into every cut.

create or replace function private.source_cut_partition_witness(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_through_cursor_version bigint
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'observationCount', count(*)::integer,
    'partitionHash', encode(extensions.digest(
      convert_to(coalesce(jsonb_agg(jsonb_build_object(
        'observationId', observation.observation_id,
        'contentHash', observation.content_hash
      ) order by observation.observation_id), '[]'::jsonb)::text, 'UTF8'),
      'sha256'
    ), 'hex')
  )
  from public.source_observations observation
  join public.source_ingest_batches batch
    on batch.batch_id = observation.batch_id
   and batch.workspace_key = observation.workspace_key
   and batch.source_system = observation.source_system
   and batch.connection_key = observation.connection_key
   and batch.status = 'committed'
   and batch.committed_cursor_version is not null
   and batch.committed_cursor_version >= observation.source_cursor_version
  where observation.workspace_key = p_workspace_key
    and observation.source_system = p_source_system
    and observation.connection_key = p_connection_key
    and observation.source_cursor_version <= p_through_cursor_version;
$function$;

-- Pure immutable fence predicate. The table-reading wrapper below supplies
-- only append-only cut/observation rows plus the batch's committed state.
create or replace function private.source_observation_matches_cut_fence(
  p_cut jsonb,
  p_observation jsonb,
  p_batch jsonb,
  p_expected_content_hash text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select jsonb_typeof(p_cut) = 'object'
    and jsonb_typeof(p_observation) = 'object'
    and jsonb_typeof(p_batch) = 'object'
    and p_observation->>'observationId' ~ '^obs:v1:[0-9a-f]{64}$'
    and p_expected_content_hash ~ '^[0-9a-f]{64}$'
    and p_observation->>'contentHash' = p_expected_content_hash
    and p_observation->>'workspaceKey' = p_cut->>'workspaceKey'
    and p_observation->>'sourceSystem' = p_cut->>'sourceSystem'
    and p_observation->>'connectionKey' = p_cut->>'connectionKey'
    and (p_observation->>'sourceCursorVersion')::bigint <=
      (p_cut->>'throughCursorVersion')::bigint
    and p_batch->>'status' = 'committed'
    and p_batch->>'workspaceKey' = p_observation->>'workspaceKey'
    and p_batch->>'sourceSystem' = p_observation->>'sourceSystem'
    and p_batch->>'connectionKey' = p_observation->>'connectionKey'
    and coalesce(p_batch->>'committedCursorVersion', '') ~ '^[0-9]+$'
    and (p_batch->>'committedCursorVersion')::bigint >=
      (p_observation->>'sourceCursorVersion')::bigint;
$function$;

-- This is the sole table-reading cut-membership wrapper. PostgreSQL STABLE is
-- required because it reads relations; the actual fence comparison is the
-- immutable function above. Aggregate partition integrity is computed while
-- sealing and independently recomputed by the read-only audit runtime.
create or replace function private.source_observation_within_cut(
  p_workspace_key text,
  p_source_cut_id text,
  p_observation_id text,
  p_content_hash text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(exists (
    select 1
    from public.source_cuts source_cut
    join public.source_cut_cursors cut_cursor
      on cut_cursor.source_cut_id = source_cut.source_cut_id
    join public.source_observations observation
      on observation.observation_id = p_observation_id
    join public.source_ingest_batches batch
      on batch.batch_id = observation.batch_id
    where source_cut.source_cut_id = p_source_cut_id
      and source_cut.workspace_key = p_workspace_key
      and private.source_observation_matches_cut_fence(
        jsonb_build_object(
          'workspaceKey', source_cut.workspace_key,
          'sourceSystem', cut_cursor.source_system,
          'connectionKey', cut_cursor.connection_key,
          'throughCursorVersion', cut_cursor.through_cursor_version
        ),
        jsonb_build_object(
          'observationId', observation.observation_id,
          'workspaceKey', observation.workspace_key,
          'sourceSystem', observation.source_system,
          'connectionKey', observation.connection_key,
          'sourceCursorVersion', observation.source_cursor_version,
          'contentHash', observation.content_hash
        ),
        jsonb_build_object(
          'status', batch.status,
          'workspaceKey', batch.workspace_key,
          'sourceSystem', batch.source_system,
          'connectionKey', batch.connection_key,
          'committedCursorVersion', batch.committed_cursor_version
        ),
        p_content_hash
      )
  ), false);
$function$;

create table if not exists public.accepted_claims (
  claim_version_id text primary key,
  claim_key text not null,
  version_no integer not null check (version_no > 0),
  previous_claim_version_id text references public.accepted_claims(claim_version_id) on delete restrict,
  primary_observation_id text not null references public.source_observations(observation_id) on delete restrict,
  subject_type text not null,
  subject_key text not null,
  predicate text not null,
  gate text not null,
  polarity text not null check (polarity = any (array['positive', 'negative', 'requested', 'neutral', 'unknown'])),
  normalized_value jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  confidence_label text not null,
  extraction_method text not null check (extraction_method = any (array['deterministic', 'model', 'operator'])),
  extractor_version text not null,
  prompt_version text not null default '',
  model text not null default '',
  acceptance_method text not null check (acceptance_method = any (array['policy', 'operator'])),
  acceptance_policy_version text not null,
  accepted_by text not null,
  decision text not null check (decision = any (array['accepted', 'revoked'])),
  evidence_span jsonb not null default '{}'::jsonb,
  claim_content_hash text not null check (claim_content_hash ~ '^[0-9a-f]{64}$'),
  schema_version text not null,
  created_at timestamptz not null default now(),
  unique (claim_key, version_no)
);

create unique index if not exists accepted_claims_previous_unique
  on public.accepted_claims (previous_claim_version_id)
  where previous_claim_version_id is not null;

create table if not exists public.accepted_claim_evidence (
  claim_version_id text not null references public.accepted_claims(claim_version_id) on delete restrict,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  evidence_role text not null check (evidence_role = any (array['primary', 'supporting', 'contradicting'])),
  evidence_span jsonb not null default '{}'::jsonb,
  primary key (claim_version_id, observation_id, evidence_role)
);

create table if not exists public.claim_supersessions (
  resolving_claim_version_id text not null references public.accepted_claims(claim_version_id) on delete restrict,
  superseded_claim_version_id text not null references public.accepted_claims(claim_version_id) on delete restrict,
  relationship text not null check (relationship = any (array['corrects', 'resolves', 'contradicts'])),
  policy_version text not null,
  created_at timestamptz not null default now(),
  primary key (resolving_claim_version_id, superseded_claim_version_id),
  check (resolving_claim_version_id <> superseded_claim_version_id)
);

create table if not exists public.observation_entity_links (
  link_version_id text primary key,
  link_key text not null,
  version_no integer not null check (version_no > 0),
  previous_link_version_id text references public.observation_entity_links(link_version_id) on delete restrict,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  entity_type text not null,
  entity_key text not null,
  relationship text not null,
  decision text not null check (decision = any (array['linked', 'unlinked'])),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  link_method text not null check (link_method = any (array['deterministic', 'model', 'operator'])),
  linker_version text not null,
  evidence_span jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (link_key, version_no)
);

create unique index if not exists observation_entity_links_previous_unique
  on public.observation_entity_links (previous_link_version_id)
  where previous_link_version_id is not null;

create table if not exists public.operational_workgroups_v2 (
  workgroup_id text primary key,
  workspace_key text not null,
  workgroup_type text not null,
  identity_key text not null,
  identity_basis jsonb not null default '{}'::jsonb,
  created_method text not null check (created_method = any (array['deterministic', 'model', 'operator'])),
  linker_version text not null,
  initial_confidence numeric not null check (initial_confidence >= 0 and initial_confidence <= 1),
  created_at timestamptz not null default now(),
  unique (workspace_key, identity_key)
);

create table if not exists public.operational_workgroup_memberships (
  membership_version_id text primary key,
  membership_key text not null,
  version_no integer not null check (version_no > 0),
  previous_membership_version_id text references public.operational_workgroup_memberships(membership_version_id) on delete restrict,
  workgroup_id text not null references public.operational_workgroups_v2(workgroup_id) on delete restrict,
  member_type text not null,
  member_key text not null,
  observation_id text references public.source_observations(observation_id) on delete restrict,
  role text not null,
  decision text not null check (decision = any (array['added', 'removed'])),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  membership_method text not null check (membership_method = any (array['deterministic', 'model', 'operator'])),
  linker_version text not null,
  basis_observation_id text references public.source_observations(observation_id) on delete restrict,
  recorded_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (membership_key, version_no)
);

create unique index if not exists operational_workgroup_memberships_previous_unique
  on public.operational_workgroup_memberships (previous_membership_version_id)
  where previous_membership_version_id is not null;

create table if not exists public.truth_builds (
  build_id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  build_mode text not null check (build_mode = any (array['full', 'incremental'])),
  channel text not null check (channel = any (array['shadow', 'candidate'])),
  trigger_name text not null,
  base_publication_id uuid,
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  claim_manifest_hash text not null check (claim_manifest_hash ~ '^[0-9a-f]{64}$'),
  link_manifest_hash text not null check (link_manifest_hash ~ '^[0-9a-f]{64}$'),
  workgroup_manifest_hash text not null check (workgroup_manifest_hash ~ '^[0-9a-f]{64}$'),
  extractor_set_version text not null,
  linker_version text not null,
  reducer_version text not null,
  packet_builder_version text not null,
  packet_schema_version text not null,
  status text not null default 'running' check (status = any (array['running', 'succeeded', 'failed'])),
  packet_hash text check (packet_hash is null or packet_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash text check (semantic_hash is null or semantic_hash ~ '^[0-9a-f]{64}$'),
  packet_canonical_text text,
  packet_payload jsonb,
  source_watermark jsonb not null,
  validation_report jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_detail text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (input_manifest_hash, build_mode, channel, reducer_version, packet_builder_version)
);

create table if not exists public.truth_build_inputs (
  build_id uuid not null references public.truth_builds(build_id) on delete restrict,
  item_kind text not null check (item_kind = any (array['accepted_claim', 'entity_link', 'workgroup_membership'])),
  item_id text not null,
  item_hash text not null check (item_hash ~ '^[0-9a-f]{64}$'),
  ordinal bigint not null check (ordinal >= 0),
  primary key (build_id, item_kind, item_id),
  unique (build_id, item_kind, ordinal)
);

create table if not exists public.truth_publications (
  publication_id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  channel text not null check (channel = any (array['production', 'shadow'])),
  publication_version bigint not null check (publication_version > 0),
  build_id uuid not null references public.truth_builds(build_id) on delete restrict,
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  previous_publication_id uuid references public.truth_publications(publication_id) on delete restrict,
  publication_reason text not null check (publication_reason = any (array['normal', 'rollback', 'repair'])),
  packet_hash text not null check (packet_hash ~ '^[0-9a-f]{64}$'),
  delivery_payload_hash text not null check (delivery_payload_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash text not null check (semantic_hash ~ '^[0-9a-f]{64}$'),
  publisher_version text not null,
  published_by text not null,
  published_at timestamptz not null default now(),
  unique (workspace_key, channel, publication_version),
  unique (workspace_key, channel, build_id)
);

alter table public.truth_builds
  drop constraint if exists truth_builds_base_publication_id_fkey;
alter table public.truth_builds
  add constraint truth_builds_base_publication_id_fkey
  foreign key (base_publication_id) references public.truth_publications(publication_id) on delete restrict;

create table if not exists public.truth_publication_heads (
  workspace_key text not null,
  channel text not null check (channel = any (array['production', 'shadow'])),
  publication_id uuid not null references public.truth_publications(publication_id) on delete restrict,
  publication_version bigint not null check (publication_version > 0),
  packet_hash text not null check (packet_hash ~ '^[0-9a-f]{64}$'),
  delivery_payload_hash text not null check (delivery_payload_hash ~ '^[0-9a-f]{64}$'),
  source_cut_id text not null references public.source_cuts(source_cut_id) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (workspace_key, channel)
);

create table if not exists public.truth_audit_runs (
  audit_run_id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  source_cut_id text references public.source_cuts(source_cut_id) on delete restrict,
  packet_hash text,
  production_packet_hash text,
  audit_mode text not null check (audit_mode = any (array['delta', 'hourly', 'morning_full', 'browser_witness'])),
  status text not null default 'running' check (status = any (array['running', 'succeeded', 'failed'])),
  observer_version text not null,
  model_version text not null default '',
  mutates_operational_state boolean not null default false check (mutates_operational_state = false),
  metrics jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  error_detail text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.truth_audit_findings (
  finding_id text primary key,
  audit_run_id uuid not null references public.truth_audit_runs(audit_run_id) on delete restrict,
  workspace_key text not null,
  source_cut_id text,
  packet_hash text,
  production_packet_hash text,
  stage text not null,
  severity text not null check (severity = any (array['blocking', 'attention', 'informational'])),
  classification text not null,
  subject_type text not null default '',
  subject_key text not null default '',
  evidence_observation_ids text[] not null default '{}'::text[],
  detail jsonb not null default '{}'::jsonb,
  mutates_operational_state boolean not null default false check (mutates_operational_state = false),
  created_at timestamptz not null default now()
);

create index if not exists accepted_claims_subject_idx
  on public.accepted_claims (subject_type, subject_key, gate, occurred_at, captured_at);
create index if not exists accepted_claim_evidence_observation_idx
  on public.accepted_claim_evidence (observation_id, claim_version_id);
create index if not exists observation_entity_links_entity_idx
  on public.observation_entity_links (entity_type, entity_key, recorded_at);
create index if not exists operational_workgroup_memberships_member_idx
  on public.operational_workgroup_memberships (member_type, member_key, recorded_at);
create index if not exists truth_builds_cut_idx
  on public.truth_builds (source_cut_id, status, finished_at desc);
create index if not exists truth_publications_workspace_idx
  on public.truth_publications (workspace_key, channel, publication_version desc);
create index if not exists truth_audit_runs_recent_idx
  on public.truth_audit_runs (workspace_key, started_at desc);
create index if not exists truth_audit_findings_open_idx
  on public.truth_audit_findings (workspace_key, severity, created_at desc);

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'source_cuts', 'source_cut_cursors', 'source_cut_observations',
    'accepted_claims', 'accepted_claim_evidence', 'claim_supersessions',
    'observation_entity_links', 'operational_workgroups_v2',
    'operational_workgroup_memberships', 'truth_build_inputs',
    'truth_publications', 'truth_audit_findings'
  ] loop
    execute format('drop trigger if exists %I_immutable on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_immutable before update or delete on public.%I for each row execute function public.reject_immutable_truth_mutation()',
      v_table, v_table
    );
  end loop;
end;
$block$;

create or replace function public.guard_truth_build_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth_builds is append-only' using errcode = '55000';
  end if;
  if old.status <> 'running' then
    raise exception 'final truth builds are immutable' using errcode = '55000';
  end if;
  if row(
    new.workspace_key, new.source_cut_id, new.build_mode, new.channel,
    new.trigger_name, new.base_publication_id, new.input_manifest_hash,
    new.claim_manifest_hash, new.link_manifest_hash, new.workgroup_manifest_hash,
    new.extractor_set_version, new.linker_version, new.reducer_version,
    new.packet_builder_version, new.packet_schema_version, new.source_watermark,
    new.started_at
  ) is distinct from row(
    old.workspace_key, old.source_cut_id, old.build_mode, old.channel,
    old.trigger_name, old.base_publication_id, old.input_manifest_hash,
    old.claim_manifest_hash, old.link_manifest_hash, old.workgroup_manifest_hash,
    old.extractor_set_version, old.linker_version, old.reducer_version,
    old.packet_builder_version, old.packet_schema_version, old.source_watermark,
    old.started_at
  ) then
    raise exception 'truth build manifest fields are immutable' using errcode = '55000';
  end if;
  if new.status = 'succeeded' then
    if new.packet_hash is null or new.semantic_hash is null
      or new.packet_canonical_text is null or new.packet_payload is null
      or new.finished_at is null then
      raise exception 'successful truth build is incomplete' using errcode = '23514';
    end if;
  elsif new.status = 'failed' then
    if nullif(trim(coalesce(new.error_code, '')), '') is null or new.finished_at is null then
      raise exception 'failed truth build requires an error code and finish time' using errcode = '23514';
    end if;
  else
    raise exception 'truth build may only transition from running to a final state' using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_builds_guard on public.truth_builds;
create trigger truth_builds_guard
before update or delete on public.truth_builds
for each row execute function public.guard_truth_build_transition();

create or replace function public.guard_truth_build_input_insert()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_status text;
begin
  select build.status into v_status
  from public.truth_builds build
  where build.build_id = new.build_id
  for update;
  if not found or v_status <> 'running' then
    raise exception 'truth build inputs may only be inserted while the build is running' using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_build_inputs_insert_guard on public.truth_build_inputs;
create trigger truth_build_inputs_insert_guard
before insert on public.truth_build_inputs
for each row execute function public.guard_truth_build_input_insert();

create or replace function private.seal_source_cut(
  p_workspace_key text,
  p_manifest_schema_version text,
  p_required_sources jsonb,
  p_gaps jsonb,
  p_cursors jsonb,
  p_observations jsonb,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_required_sources jsonb;
  v_cursor_manifest jsonb;
  v_gaps jsonb;
  v_derived_gaps jsonb;
  v_manifest jsonb;
  v_manifest_hash text;
  v_source_cut_id text;
  v_completeness text;
  v_required_count integer;
  v_required_distinct_count integer;
  v_cursor_count integer;
  v_cursor_distinct_count integer;
  v_observation_count integer;
  v_existing public.source_cuts%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_manifest_schema_version is distinct from 'source-cut-manifest-v2'
    or nullif(trim(coalesce(p_created_by, '')), '') is null then
    raise exception 'source cut identity is incomplete' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_required_sources, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_gaps, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_cursors, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_observations, 'null'::jsonb)) <> 'array' then
    raise exception 'source cut manifests must be arrays' using errcode = '22023';
  end if;
  if jsonb_array_length(p_observations) <> 0 then
    raise exception 'source-cut v2 rejects caller-supplied observation manifests'
      using errcode = '23514';
  end if;

  select count(*)::integer,
         count(distinct (item->>'sourceSystem', item->>'connectionKey'))::integer
  into v_required_count, v_required_distinct_count
  from jsonb_array_elements(p_required_sources) item;
  if v_required_count = 0 or v_required_count <> v_required_distinct_count
    or exists (
      select 1 from jsonb_array_elements(p_required_sources) item
      where jsonb_typeof(item) <> 'object'
        or nullif(trim(coalesce(item->>'sourceSystem', '')), '') is null
        or nullif(trim(coalesce(item->>'connectionKey', '')), '') is null
    ) then
    raise exception 'source cut required-source vector is invalid' using errcode = '23514';
  end if;
  select coalesce(jsonb_agg(required_source order by source_system, connection_key), '[]'::jsonb)
  into v_required_sources
  from (
    select item->>'sourceSystem' as source_system,
           item->>'connectionKey' as connection_key,
           jsonb_build_object(
             'sourceSystem', item->>'sourceSystem',
             'connectionKey', item->>'connectionKey'
           ) as required_source
    from jsonb_array_elements(p_required_sources) item
  ) normalized;

  select count(*)::integer,
         count(distinct (item->>'sourceSystem', item->>'connectionKey'))::integer
  into v_cursor_count, v_cursor_distinct_count
  from jsonb_array_elements(p_cursors) item;
  if v_cursor_count = 0 or v_cursor_count <> v_cursor_distinct_count
    or exists (
      select 1 from jsonb_array_elements(p_cursors) item
      where jsonb_typeof(item) <> 'object'
        or nullif(trim(coalesce(item->>'sourceSystem', '')), '') is null
        or nullif(trim(coalesce(item->>'connectionKey', '')), '') is null
        or nullif(trim(coalesce(item->>'cursorKind', '')), '') is null
        or nullif(trim(coalesce(item->>'throughCursorValue', '')), '') is null
        or coalesce(item->>'throughCursorVersion', '') !~ '^[0-9]+$'
    ) then
    raise exception 'source cut cursor vector is invalid' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_required_sources) required_source
    left join jsonb_array_elements(p_cursors) cursor_item
      on cursor_item->>'sourceSystem' = required_source->>'sourceSystem'
     and cursor_item->>'connectionKey' = required_source->>'connectionKey'
    where cursor_item is null
  ) then
    raise exception 'source cut is missing a required cursor' using errcode = '23514';
  end if;
  if v_cursor_count <> v_required_count or exists (
    select 1
    from jsonb_array_elements(p_cursors) cursor_item
    left join jsonb_array_elements(v_required_sources) required_source
      on required_source->>'sourceSystem' = cursor_item->>'sourceSystem'
     and required_source->>'connectionKey' = cursor_item->>'connectionKey'
    where required_source is null
  ) then
    raise exception 'source cut cursor vector must exactly match required sources'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_cursors) cursor_item
    left join public.source_cursors cursor_row
      on cursor_row.workspace_key = p_workspace_key
     and cursor_row.source_system = cursor_item->>'sourceSystem'
     and cursor_row.connection_key = cursor_item->>'connectionKey'
    where cursor_row.workspace_key is null
      or cursor_row.cursor_kind is distinct from cursor_item->>'cursorKind'
      or cursor_row.cursor_version is distinct from (cursor_item->>'throughCursorVersion')::bigint
      or cursor_row.cursor_value is distinct from cursor_item->>'throughCursorValue'
  ) then
    raise exception 'source cut cursor does not match committed source state' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceSystem', cursor_item->>'sourceSystem',
    'connectionKey', cursor_item->>'connectionKey',
    'cursorKind', cursor_item->>'cursorKind',
    'throughCursorVersion', cursor_item->>'throughCursorVersion',
    'throughCursorValue', cursor_item->>'throughCursorValue',
    'upstreamWatermark', coalesce(cursor_item->>'upstreamWatermark', ''),
    'sourceSnapshotAt', coalesce(cursor_item->>'sourceSnapshotAt', ''),
    'observationCount', (partition.witness->>'observationCount')::integer,
    'partitionHash', partition.witness->>'partitionHash',
    'emptyScope', (partition.witness->>'observationCount')::integer = 0
  ) order by cursor_item->>'sourceSystem', cursor_item->>'connectionKey'), '[]'::jsonb)
  into v_cursor_manifest
  from jsonb_array_elements(p_cursors) cursor_item
  cross join lateral (
    select private.source_cut_partition_witness(
      p_workspace_key,
      cursor_item->>'sourceSystem',
      cursor_item->>'connectionKey',
      (cursor_item->>'throughCursorVersion')::bigint
    ) as witness
  ) partition;

  select coalesce(sum((item->>'observationCount')::integer), 0)::integer
  into v_observation_count
  from jsonb_array_elements(v_cursor_manifest) item;

  if exists (
    select 1 from jsonb_array_elements(p_gaps) gap
    where jsonb_typeof(gap) <> 'object'
  ) then
    raise exception 'source cut gaps must be objects' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb)
  into v_gaps
  from (select distinct item as gap from jsonb_array_elements(p_gaps) item) supplied;

  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb)
  into v_derived_gaps
  from (
    select jsonb_build_object(
      'gapType', 'SOURCE_CURSOR_NOT_LIVE',
      'sourceSystem', cursor_row.source_system,
      'connectionKey', cursor_row.connection_key,
      'status', cursor_row.status
    ) as gap
    from jsonb_array_elements(p_cursors) cursor_item
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = p_workspace_key
     and cursor_row.source_system = cursor_item->>'sourceSystem'
     and cursor_row.connection_key = cursor_item->>'connectionKey'
    where cursor_row.status <> 'live'
    union
    select jsonb_build_object(
      'gapType', gap.gap_type,
      'sourceSystem', 'gmail',
      'connectionKey', gap.connection_key,
      'gapId', gap.gap_id,
      'detectedAt', gap.detected_at
    )
    from public.gmail_completeness_gaps gap
    join jsonb_array_elements(p_cursors) cursor_item
      on cursor_item->>'sourceSystem' = 'gmail'
     and cursor_item->>'connectionKey' = gap.connection_key
    where gap.workspace_key = p_workspace_key and gap.status = 'open'
    union
    select jsonb_build_object(
      'gapType', 'SOURCE_PROCESSING_BACKLOG',
      'sourceSystem', job.source_system,
      'connectionKey', job.connection_key,
      'state', job.state,
      'count', count(*)
    )
    from public.source_processing_jobs job
    join jsonb_array_elements(p_cursors) cursor_item
      on cursor_item->>'sourceSystem' = job.source_system
     and cursor_item->>'connectionKey' = job.connection_key
    where job.workspace_key = p_workspace_key
      and job.state not in ('succeeded', 'superseded')
    group by job.source_system, job.connection_key, job.state
    union
    select jsonb_build_object(
      'gapType', 'SOURCE_INGEST_BATCH_UNCOMMITTED',
      'sourceSystem', batch.source_system,
      'connectionKey', batch.connection_key,
      'batchId', batch.batch_id,
      'status', batch.status,
      'expectedCursorVersion', batch.expected_cursor_version
    )
    from public.source_ingest_batches batch
    join jsonb_array_elements(p_cursors) cursor_item
      on cursor_item->>'sourceSystem' = batch.source_system
     and cursor_item->>'connectionKey' = batch.connection_key
    where batch.workspace_key = p_workspace_key
      and batch.status in ('running', 'failed')
      and batch.expected_cursor_version >=
        (cursor_item->>'throughCursorVersion')::bigint
    union
    select jsonb_build_object(
      'gapType', 'SOURCE_CURSOR_BATCH_FENCE_MISMATCH',
      'sourceSystem', cursor_row.source_system,
      'connectionKey', cursor_row.connection_key,
      'cursorVersion', cursor_row.cursor_version,
      'lastBatchId', cursor_row.last_batch_id
    )
    from jsonb_array_elements(p_cursors) cursor_item
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = p_workspace_key
     and cursor_row.source_system = cursor_item->>'sourceSystem'
     and cursor_row.connection_key = cursor_item->>'connectionKey'
    left join public.source_ingest_batches last_batch
      on last_batch.batch_id = cursor_row.last_batch_id
     and last_batch.workspace_key = cursor_row.workspace_key
     and last_batch.source_system = cursor_row.source_system
     and last_batch.connection_key = cursor_row.connection_key
     and last_batch.status = 'committed'
     and last_batch.committed_cursor_version = cursor_row.cursor_version
     and last_batch.committed_cursor_value = cursor_row.cursor_value
    where last_batch.batch_id is null
    union
    select jsonb_build_object(
      'gapType', 'SOURCE_JOURNAL_FENCE_MISMATCH',
      'sourceSystem', cursor_item->>'sourceSystem',
      'connectionKey', cursor_item->>'connectionKey',
      'count', count(*)
    )
    from jsonb_array_elements(p_cursors) cursor_item
    join public.source_observations observation
      on observation.workspace_key = p_workspace_key
     and observation.source_system = cursor_item->>'sourceSystem'
     and observation.connection_key = cursor_item->>'connectionKey'
     and observation.source_cursor_version <=
       (cursor_item->>'throughCursorVersion')::bigint
    left join public.source_ingest_batches batch
      on batch.batch_id = observation.batch_id
     and batch.workspace_key = observation.workspace_key
     and batch.source_system = observation.source_system
     and batch.connection_key = observation.connection_key
     and batch.status = 'committed'
     and batch.committed_cursor_version is not null
     and batch.committed_cursor_version >= observation.source_cursor_version
    where batch.batch_id is null
    group by cursor_item->>'sourceSystem', cursor_item->>'connectionKey'
  ) derived;
  select coalesce(jsonb_agg(gap order by gap::text), '[]'::jsonb)
  into v_gaps
  from (
    select distinct item as gap
    from jsonb_array_elements(coalesce(v_gaps, '[]'::jsonb) || coalesce(v_derived_gaps, '[]'::jsonb)) item
  ) combined;

  v_completeness := case when jsonb_array_length(v_gaps) = 0 then 'complete' else 'degraded' end;
  v_manifest := jsonb_build_object(
    'schemaVersion', p_manifest_schema_version,
    'partitionWitnessVersion', 'source-cut-partition-witness-v1',
    'workspaceKey', p_workspace_key,
    'requiredSources', v_required_sources,
    'gaps', v_gaps,
    'cursors', v_cursor_manifest
  );
  v_manifest_hash := encode(extensions.digest(convert_to(v_manifest::text, 'UTF8'), 'sha256'), 'hex');
  v_source_cut_id := 'cut:v1:' || v_manifest_hash;

  insert into public.source_cuts (
    source_cut_id, workspace_key, manifest_hash, manifest, completeness,
    required_sources, gaps, observation_count, manifest_schema_version, created_by
  ) values (
    v_source_cut_id, p_workspace_key, v_manifest_hash, v_manifest, v_completeness,
    v_required_sources, v_gaps, v_observation_count,
    p_manifest_schema_version, p_created_by
  ) on conflict (source_cut_id) do nothing;

  select * into v_existing from public.source_cuts where source_cut_id = v_source_cut_id;
  if not found or v_existing.manifest is distinct from v_manifest then
    raise exception 'source cut manifest identity conflict' using errcode = '23505';
  end if;

  insert into public.source_cut_cursors (
    source_cut_id, source_system, connection_key, cursor_kind,
    through_cursor_version, through_cursor_value, upstream_watermark,
    source_snapshot_at, observation_count, partition_hash
  )
  select v_source_cut_id,
         item->>'sourceSystem', item->>'connectionKey', item->>'cursorKind',
         (item->>'throughCursorVersion')::bigint, item->>'throughCursorValue',
         coalesce(item->>'upstreamWatermark', ''),
         nullif(item->>'sourceSnapshotAt', '')::timestamptz,
         (item->>'observationCount')::integer, item->>'partitionHash'
  from jsonb_array_elements(v_cursor_manifest) item
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true,
    'sourceCutId', v_source_cut_id,
    'manifestHash', v_manifest_hash,
    'completeness', v_completeness,
    'observationCount', v_observation_count,
    'gaps', v_gaps,
    'manifest', v_manifest
  );
end;
$function$;

create or replace function private.begin_truth_build(
  p_workspace_key text,
  p_source_cut_id text,
  p_build_mode text,
  p_channel text,
  p_trigger_name text,
  p_base_publication_id uuid,
  p_inputs jsonb,
  p_versions jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cut public.source_cuts%rowtype;
  v_build public.truth_builds%rowtype;
  v_claim_manifest jsonb;
  v_link_manifest jsonb;
  v_workgroup_manifest jsonb;
  v_claim_manifest_hash text;
  v_link_manifest_hash text;
  v_workgroup_manifest_hash text;
  v_input_manifest jsonb;
  v_input_manifest_hash text;
  v_source_watermark jsonb;
  v_input_count integer;
  v_input_distinct_count integer;
  v_target_channel text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_build_mode is null or not (p_build_mode = any (array['full', 'incremental']))
    or p_channel is null or not (p_channel = any (array['shadow', 'candidate']))
    or nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_trigger_name, '')), '') is null
    or jsonb_typeof(coalesce(p_inputs, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_versions, 'null'::jsonb)) <> 'object' then
    raise exception 'truth build request is invalid' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(array[
      'extractorSetVersion', 'linkerVersion', 'reducerVersion',
      'packetBuilderVersion', 'packetSchemaVersion'
    ]) version_key
    where nullif(trim(coalesce(p_versions->>version_key, '')), '') is null
  ) then
    raise exception 'truth build version vector is incomplete' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_versions) version_key
    where not (version_key = any (array[
      'extractorSetVersion', 'linkerVersion', 'reducerVersion',
      'packetBuilderVersion', 'packetSchemaVersion'
    ]))
  ) then
    raise exception 'truth build version vector contains unsupported keys' using errcode = '23514';
  end if;
  v_target_channel := case when p_channel = 'candidate' then 'production' else 'shadow' end;

  select * into v_cut
  from public.source_cuts
  where source_cut_id = p_source_cut_id and workspace_key = p_workspace_key;
  if not found then
    raise exception 'truth build source cut is unavailable' using errcode = '23503';
  end if;
  if p_build_mode = 'incremental' and p_base_publication_id is null then
    raise exception 'incremental truth build requires a base publication' using errcode = '23514';
  end if;
  if p_base_publication_id is not null and not exists (
    select 1 from public.truth_publications publication
    where publication.publication_id = p_base_publication_id
      and publication.workspace_key = p_workspace_key
      and publication.channel = v_target_channel
  ) then
    raise exception 'truth build base publication is unavailable' using errcode = '23503';
  end if;

  select count(*)::integer,
         count(distinct (item->>'itemKind', item->>'itemId'))::integer
  into v_input_count, v_input_distinct_count
  from jsonb_array_elements(p_inputs) item;
  if v_input_count <> v_input_distinct_count
    or exists (
      select 1 from jsonb_array_elements(p_inputs) item
      where jsonb_typeof(item) <> 'object'
        or not (coalesce(item->>'itemKind', '') = any (array[
          'accepted_claim', 'entity_link', 'workgroup_membership'
        ]))
        or nullif(trim(coalesce(item->>'itemId', '')), '') is null
        or coalesce(item->>'itemHash', '') !~ '^[0-9a-f]{64}$'
    ) then
    raise exception 'truth build input vector is invalid' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_inputs) item
    left join public.accepted_claims claim
      on item->>'itemKind' = 'accepted_claim'
     and claim.claim_version_id = item->>'itemId'
    left join public.accepted_claim_envelopes claim_envelope
      on claim_envelope.claim_version_id = claim.claim_version_id
     and claim_envelope.envelope_hash = claim.claim_content_hash
    left join public.observation_entity_links entity_link
      on item->>'itemKind' = 'entity_link'
     and entity_link.link_version_id = item->>'itemId'
    left join public.observation_entity_link_envelopes link_envelope
      on link_envelope.link_version_id = entity_link.link_version_id
     and link_envelope.envelope_hash = entity_link.content_hash
    left join public.operational_workgroup_memberships membership
      on item->>'itemKind' = 'workgroup_membership'
     and membership.membership_version_id = item->>'itemId'
    left join public.operational_workgroup_membership_envelopes membership_envelope
      on membership_envelope.membership_version_id = membership.membership_version_id
     and membership_envelope.envelope_hash = membership.content_hash
    left join public.operational_workgroup_envelopes workgroup_envelope
      on workgroup_envelope.workgroup_id = membership.workgroup_id
     and workgroup_envelope.workgroup_id = membership_envelope.workgroup_id
    where case item->>'itemKind'
      when 'accepted_claim' then claim.claim_version_id is null
        or claim_envelope.claim_version_id is null
        or claim_envelope.envelope_hash is distinct from item->>'itemHash'
      when 'entity_link' then entity_link.link_version_id is null
        or link_envelope.link_version_id is null
        or link_envelope.envelope_hash is distinct from item->>'itemHash'
      when 'workgroup_membership' then membership.membership_version_id is null
        or membership_envelope.membership_version_id is null
        or workgroup_envelope.workgroup_id is null
        or membership_envelope.envelope_hash is distinct from item->>'itemHash'
      else true
    end
  ) then
    raise exception 'truth build input identity or hash is invalid' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_inputs) item
    join public.accepted_claims claim
      on item->>'itemKind' = 'accepted_claim' and claim.claim_version_id = item->>'itemId'
    left join public.source_observations primary_observation
      on primary_observation.observation_id = claim.primary_observation_id
    where not private.source_observation_within_cut(
        p_workspace_key, p_source_cut_id, claim.primary_observation_id,
        primary_observation.content_hash
      )
      or not exists (
        select 1
        from public.accepted_claim_evidence evidence
        where evidence.claim_version_id = claim.claim_version_id
          and evidence.observation_id = claim.primary_observation_id
          and evidence.evidence_role = 'primary'
      )
      or exists (
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
  ) then
    raise exception 'truth build claim evidence is outside the source cut' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_inputs) item
    join public.observation_entity_links entity_link
      on item->>'itemKind' = 'entity_link' and entity_link.link_version_id = item->>'itemId'
    left join public.source_observations evidence_observation
      on evidence_observation.observation_id = entity_link.observation_id
    where not private.source_observation_within_cut(
      p_workspace_key, p_source_cut_id, entity_link.observation_id,
      evidence_observation.content_hash
    )
  ) then
    raise exception 'truth build entity-link evidence is outside the source cut' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_inputs) item
    join public.operational_workgroup_memberships membership
      on item->>'itemKind' = 'workgroup_membership'
     and membership.membership_version_id = item->>'itemId'
    join public.operational_workgroups_v2 workgroup
      on workgroup.workgroup_id = membership.workgroup_id
    where workgroup.workspace_key is distinct from p_workspace_key
      or (membership.observation_id is null and membership.basis_observation_id is null)
      or (membership.observation_id is not null and not private.source_observation_within_cut(
        p_workspace_key, p_source_cut_id, membership.observation_id,
        (select observation.content_hash from public.source_observations observation
         where observation.observation_id = membership.observation_id)
      ))
      or (membership.basis_observation_id is not null and not private.source_observation_within_cut(
        p_workspace_key, p_source_cut_id, membership.basis_observation_id,
        (select observation.content_hash from public.source_observations observation
         where observation.observation_id = membership.basis_observation_id)
      ))
  ) then
    raise exception 'truth build workgroup evidence is outside the source cut' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId', 'itemHash', item->>'itemHash'
  ) order by item->>'itemId'), '[]'::jsonb)
  into v_claim_manifest
  from jsonb_array_elements(p_inputs) item
  where item->>'itemKind' = 'accepted_claim';
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId', 'itemHash', item->>'itemHash'
  ) order by item->>'itemId'), '[]'::jsonb)
  into v_link_manifest
  from jsonb_array_elements(p_inputs) item
  where item->>'itemKind' = 'entity_link';
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item->>'itemId', 'itemHash', item->>'itemHash'
  ) order by item->>'itemId'), '[]'::jsonb)
  into v_workgroup_manifest
  from jsonb_array_elements(p_inputs) item
  where item->>'itemKind' = 'workgroup_membership';

  v_claim_manifest_hash := encode(extensions.digest(convert_to(v_claim_manifest::text, 'UTF8'), 'sha256'), 'hex');
  v_link_manifest_hash := encode(extensions.digest(convert_to(v_link_manifest::text, 'UTF8'), 'sha256'), 'hex');
  v_workgroup_manifest_hash := encode(extensions.digest(convert_to(v_workgroup_manifest::text, 'UTF8'), 'sha256'), 'hex');
  v_source_watermark := jsonb_build_object(
    'sourceCutId', v_cut.source_cut_id,
    'manifestHash', v_cut.manifest_hash,
    'completeness', v_cut.completeness,
    'cursors', v_cut.manifest->'cursors'
  );
  v_input_manifest := jsonb_build_object(
    'sourceCutId', v_cut.source_cut_id,
    'sourceManifestHash', v_cut.manifest_hash,
    'claimManifestHash', v_claim_manifest_hash,
    'linkManifestHash', v_link_manifest_hash,
    'workgroupManifestHash', v_workgroup_manifest_hash,
    'basePublicationId', coalesce(p_base_publication_id::text, ''),
    'versions', p_versions
  );
  v_input_manifest_hash := encode(extensions.digest(convert_to(v_input_manifest::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.truth_builds (
    workspace_key, source_cut_id, build_mode, channel, trigger_name,
    base_publication_id, input_manifest_hash, claim_manifest_hash,
    link_manifest_hash, workgroup_manifest_hash, extractor_set_version,
    linker_version, reducer_version, packet_builder_version,
    packet_schema_version, source_watermark
  ) values (
    p_workspace_key, p_source_cut_id, p_build_mode, p_channel, p_trigger_name,
    p_base_publication_id, v_input_manifest_hash, v_claim_manifest_hash,
    v_link_manifest_hash, v_workgroup_manifest_hash,
    p_versions->>'extractorSetVersion', p_versions->>'linkerVersion',
    p_versions->>'reducerVersion', p_versions->>'packetBuilderVersion',
    p_versions->>'packetSchemaVersion', v_source_watermark
  ) on conflict (
    input_manifest_hash, build_mode, channel, reducer_version, packet_builder_version
  ) do nothing;

  select * into v_build
  from public.truth_builds
  where input_manifest_hash = v_input_manifest_hash
    and build_mode = p_build_mode
    and channel = p_channel
    and reducer_version = p_versions->>'reducerVersion'
    and packet_builder_version = p_versions->>'packetBuilderVersion';
  if not found then
    raise exception 'truth build identity conflict' using errcode = '23505';
  end if;

  if v_build.status <> 'running' then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'buildId', v_build.build_id,
      'status', v_build.status,
      'sourceCutId', v_build.source_cut_id,
      'inputManifestHash', v_input_manifest_hash,
      'claimManifestHash', v_claim_manifest_hash,
      'linkManifestHash', v_link_manifest_hash,
      'workgroupManifestHash', v_workgroup_manifest_hash,
      'sourceWatermark', v_source_watermark
    );
  end if;

  insert into public.truth_build_inputs (build_id, item_kind, item_id, item_hash, ordinal)
  select v_build.build_id,
         item->>'itemKind', item->>'itemId', item->>'itemHash',
         row_number() over (partition by item->>'itemKind' order by item->>'itemId') - 1
  from jsonb_array_elements(p_inputs) item
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true,
    'buildId', v_build.build_id,
    'status', v_build.status,
    'sourceCutId', v_build.source_cut_id,
    'inputManifestHash', v_input_manifest_hash,
    'claimManifestHash', v_claim_manifest_hash,
    'linkManifestHash', v_link_manifest_hash,
    'workgroupManifestHash', v_workgroup_manifest_hash,
    'sourceWatermark', v_source_watermark
  );
end;
$function$;

create or replace function private.complete_truth_build(
  p_build_id uuid,
  p_packet_text text,
  p_semantic_hash text,
  p_validation_report jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_packet jsonb;
  v_packet_canonical_text text;
  v_packet_hash text;
  v_manifest jsonb;
  v_manifest_hash text;
  v_claim_manifest_hash text;
  v_link_manifest_hash text;
  v_workgroup_manifest_hash text;
  v_build public.truth_builds%rowtype;
  v_cut public.source_cuts%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_build
  from public.truth_builds
  where build_id = p_build_id
  for update;
  if not found or v_build.status <> 'running' then
    raise exception 'truth build unavailable or already final' using errcode = '40001';
  end if;
  select * into v_cut from public.source_cuts where source_cut_id = v_build.source_cut_id;
  if not found then
    raise exception 'truth build source cut is unavailable' using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.truth_build_inputs input
    left join public.accepted_claim_envelopes claim_envelope
      on input.item_kind = 'accepted_claim'
     and claim_envelope.claim_version_id = input.item_id
    left join public.observation_entity_link_envelopes link_envelope
      on input.item_kind = 'entity_link'
     and link_envelope.link_version_id = input.item_id
    left join public.operational_workgroup_membership_envelopes membership_envelope
      on input.item_kind = 'workgroup_membership'
     and membership_envelope.membership_version_id = input.item_id
    left join public.operational_workgroup_envelopes workgroup_envelope
      on workgroup_envelope.workgroup_id = membership_envelope.workgroup_id
    where input.build_id = p_build_id
      and case input.item_kind
        when 'accepted_claim' then claim_envelope.envelope_hash is distinct from input.item_hash
        when 'entity_link' then link_envelope.envelope_hash is distinct from input.item_hash
        when 'workgroup_membership' then membership_envelope.envelope_hash is distinct from input.item_hash
          or workgroup_envelope.workgroup_id is null
        else true
      end
  ) then
    raise exception 'truth build input lacks its immutable authoritative envelope' using errcode = '23514';
  end if;
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item_id, 'itemHash', item_hash
  ) order by item_id), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
  into v_claim_manifest_hash
  from public.truth_build_inputs
  where build_id = p_build_id and item_kind = 'accepted_claim';
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item_id, 'itemHash', item_hash
  ) order by item_id), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
  into v_link_manifest_hash
  from public.truth_build_inputs
  where build_id = p_build_id and item_kind = 'entity_link';
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'itemId', item_id, 'itemHash', item_hash
  ) order by item_id), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
  into v_workgroup_manifest_hash
  from public.truth_build_inputs
  where build_id = p_build_id and item_kind = 'workgroup_membership';
  v_manifest := jsonb_build_object(
    'sourceCutId', v_cut.source_cut_id,
    'sourceManifestHash', v_cut.manifest_hash,
    'claimManifestHash', v_claim_manifest_hash,
    'linkManifestHash', v_link_manifest_hash,
    'workgroupManifestHash', v_workgroup_manifest_hash,
    'basePublicationId', coalesce(v_build.base_publication_id::text, ''),
    'versions', jsonb_build_object(
      'extractorSetVersion', v_build.extractor_set_version,
      'linkerVersion', v_build.linker_version,
      'reducerVersion', v_build.reducer_version,
      'packetBuilderVersion', v_build.packet_builder_version,
      'packetSchemaVersion', v_build.packet_schema_version
    )
  );
  v_manifest_hash := encode(extensions.digest(convert_to(v_manifest::text, 'UTF8'), 'sha256'), 'hex');
  if v_build.claim_manifest_hash is distinct from v_claim_manifest_hash
    or v_build.link_manifest_hash is distinct from v_link_manifest_hash
    or v_build.workgroup_manifest_hash is distinct from v_workgroup_manifest_hash
    or v_build.input_manifest_hash is distinct from v_manifest_hash then
    raise exception 'truth build inputs changed after manifest creation' using errcode = '23514';
  end if;
  v_packet := p_packet_text::jsonb;
  if jsonb_typeof(v_packet) <> 'object'
    or jsonb_typeof(coalesce(v_packet->'shipments', 'null'::jsonb)) <> 'array' then
    raise exception 'truth packet must be an object with a shipments array' using errcode = '22023';
  end if;
  if v_packet ?| array['contentSignature', 'packetHash', 'deliveryPayloadHash', 'publicationId', 'publicationVersion'] then
    raise exception 'truth build packet contains publication-owned fields' using errcode = '23514';
  end if;
  if v_packet->>'sourceCutId' is distinct from v_build.source_cut_id
    or v_packet->'sourceWatermark' is distinct from v_build.source_watermark
    or v_packet->>'schemaVersion' is distinct from v_build.packet_schema_version then
    raise exception 'truth packet identity does not match its build manifest' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_packet->'shipments') shipment
    cross join lateral jsonb_array_elements(coalesce(
      shipment->'evidencePacket'->'sourceFacts', '[]'::jsonb
    )) source_fact
    left join public.truth_build_inputs input
      on input.build_id = p_build_id
     and input.item_kind = 'accepted_claim'
     and input.item_id = source_fact->>'id'
    where input.item_id is null
  ) then
    raise exception 'truth packet contains a source fact outside its accepted-claim manifest' using errcode = '23514';
  end if;
  -- PostgreSQL's jsonb rendering is the canonical stored representation used
  -- for the build hash. Whitespace/key-order differences in caller text cannot
  -- create multiple identities for the same stored packet.
  v_packet_canonical_text := v_packet::text;
  v_packet_hash := encode(extensions.digest(convert_to(v_packet_canonical_text, 'UTF8'), 'sha256'), 'hex');
  if p_semantic_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid semantic hash' using errcode = '22023';
  end if;
  if coalesce((p_validation_report->>'schemaValid')::boolean, false) is not true
    or coalesce((p_validation_report->>'citationIntegrityOk')::boolean, false) is not true then
    raise exception 'truth build validation incomplete' using errcode = '23514';
  end if;
  update public.truth_builds
  set status = 'succeeded',
      packet_hash = v_packet_hash,
      semantic_hash = p_semantic_hash,
      packet_canonical_text = v_packet_canonical_text,
      packet_payload = v_packet,
      validation_report = coalesce(p_validation_report, '{}'::jsonb),
      finished_at = clock_timestamp()
  where build_id = p_build_id and status = 'running'
  returning * into v_build;
  if not found then
    raise exception 'truth build unavailable or already final' using errcode = '40001';
  end if;
  return jsonb_build_object('ok', true, 'buildId', v_build.build_id, 'packetHash', v_packet_hash, 'semanticHash', p_semantic_hash);
end;
$function$;

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
declare
  v_build public.truth_builds%rowtype;
  v_cut public.source_cuts%rowtype;
  v_head public.truth_publication_heads%rowtype;
  v_publication public.truth_publications%rowtype;
  v_publication_id uuid := gen_random_uuid();
  v_version bigint;
  v_now timestamptz := clock_timestamp();
  v_published_payload jsonb;
  v_delivery_payload_hash text;
  v_active_index jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_channel is null or not (p_channel = any (array['production', 'shadow']))
    or p_publication_reason is null or not (p_publication_reason = any (array['normal', 'rollback', 'repair']))
    or p_expected_head_version is null or p_expected_head_version < 0
    or nullif(trim(coalesce(p_publisher_version, '')), '') is null
    or nullif(trim(coalesce(p_published_by, '')), '') is null then
    raise exception 'invalid truth publication request' using errcode = '22023';
  end if;
  select * into v_build from public.truth_builds where build_id = p_build_id for update;
  if not found or v_build.status <> 'succeeded' or v_build.packet_payload is null then
    raise exception 'truth build is not publishable' using errcode = '23514';
  end if;
  if (v_build.channel = 'candidate' and p_channel <> 'production')
    or (v_build.channel = 'shadow' and p_channel <> 'shadow') then
    raise exception 'truth build channel does not match publication channel' using errcode = '23514';
  end if;
  select * into v_cut from public.source_cuts where source_cut_id = v_build.source_cut_id;
  if not found or v_cut.completeness <> 'complete' or jsonb_array_length(v_cut.gaps) <> 0 then
    raise exception 'source cut is not complete' using errcode = '23514';
  end if;

  -- An already committed build is idempotent even if the caller's expected
  -- head describes the state from immediately before the successful request.
  select * into v_publication from public.truth_publications
  where workspace_key = v_build.workspace_key and channel = p_channel and build_id = p_build_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'publicationId', v_publication.publication_id,
      'publicationVersion', v_publication.publication_version,
      'packetHash', v_publication.packet_hash,
      'deliveryPayloadHash', v_publication.delivery_payload_hash,
      'semanticHash', v_publication.semantic_hash,
      'sourceCutId', v_publication.source_cut_id
    );
  end if;

  -- A missing head row cannot be locked with FOR UPDATE. Serialize initial
  -- publication and normal CAS on a workspace/channel-scoped advisory lock.
  perform pg_advisory_xact_lock(hashtextextended(v_build.workspace_key || ':' || p_channel, 0));
  select * into v_head from public.truth_publication_heads
  where workspace_key = v_build.workspace_key and channel = p_channel
  for update;
  if found then
    if v_head.publication_version is distinct from p_expected_head_version
      or v_head.packet_hash is distinct from coalesce(p_expected_head_packet_hash, '') then
      raise exception 'truth publication compare-and-swap failed' using errcode = '40001';
    end if;
    v_version := v_head.publication_version + 1;
  else
    if coalesce(p_expected_head_version, 0) <> 0
      or coalesce(p_expected_head_packet_hash, '') <> '' then
      raise exception 'truth publication compare-and-swap failed' using errcode = '40001';
    end if;
    v_version := 1;
  end if;

  if v_build.build_mode = 'incremental'
    and (v_head.publication_id is null or v_build.base_publication_id is distinct from v_head.publication_id) then
    raise exception 'incremental truth build base is not the current publication head' using errcode = '40001';
  end if;

  if v_head.publication_id is not null and exists (
    select 1
    from public.source_cut_cursors current_cursor
    left join public.source_cut_cursors candidate_cursor
      on candidate_cursor.source_cut_id = v_build.source_cut_id
     and candidate_cursor.source_system = current_cursor.source_system
     and candidate_cursor.connection_key = current_cursor.connection_key
    where current_cursor.source_cut_id = v_head.source_cut_id
      and (
        candidate_cursor.source_cut_id is null
        or candidate_cursor.through_cursor_version < current_cursor.through_cursor_version
        or (
          candidate_cursor.through_cursor_version = current_cursor.through_cursor_version
          and candidate_cursor.through_cursor_value is distinct from current_cursor.through_cursor_value
        )
      )
  ) then
    raise exception 'truth publication source cursor regression' using errcode = '23514';
  end if;

  if p_channel = 'production' and exists (
    select 1
    from public.source_cut_cursors cut_cursor
    left join public.source_cursors live_cursor
      on live_cursor.workspace_key = v_build.workspace_key
     and live_cursor.source_system = cut_cursor.source_system
     and live_cursor.connection_key = cut_cursor.connection_key
    where cut_cursor.source_cut_id = v_build.source_cut_id
      and (
        live_cursor.workspace_key is null
        or live_cursor.status <> 'live'
        or live_cursor.cursor_version is distinct from cut_cursor.through_cursor_version
        or live_cursor.cursor_value is distinct from cut_cursor.through_cursor_value
      )
  ) then
    raise exception 'production truth build source cut is no longer current' using errcode = '40001';
  end if;
  if p_channel = 'production' and exists (
    select 1
    from public.gmail_completeness_gaps gap
    join public.source_cut_cursors cut_cursor
      on cut_cursor.source_cut_id = v_build.source_cut_id
     and cut_cursor.source_system = 'gmail'
     and cut_cursor.connection_key = gap.connection_key
    where gap.workspace_key = v_build.workspace_key and gap.status = 'open'
  ) then
    raise exception 'production truth build has a newly opened Gmail completeness gap' using errcode = '23514';
  end if;

  v_published_payload := v_build.packet_payload || jsonb_build_object(
    'publicationId', v_publication_id,
    'publicationVersion', v_version,
    'publicationChannel', p_channel,
    'publicationReason', p_publication_reason,
    'publisherVersion', p_publisher_version,
    'sourceCutId', v_build.source_cut_id,
    'packetHash', v_build.packet_hash
  );
  v_delivery_payload_hash := encode(extensions.digest(
    convert_to(v_published_payload::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_published_payload := v_published_payload || jsonb_build_object(
    'deliveryPayloadHash', v_delivery_payload_hash,
    'contentSignature', v_delivery_payload_hash
  );

  insert into public.truth_publications (
    publication_id, workspace_key, channel, publication_version, build_id, source_cut_id,
    previous_publication_id, publication_reason, packet_hash, delivery_payload_hash, semantic_hash,
    publisher_version, published_by
  ) values (
    v_publication_id, v_build.workspace_key, p_channel, v_version, v_build.build_id, v_build.source_cut_id,
    case when v_head.publication_id is null then null else v_head.publication_id end,
    p_publication_reason, v_build.packet_hash, v_delivery_payload_hash, v_build.semantic_hash,
    p_publisher_version, p_published_by
  ) returning * into v_publication;

  insert into public.truth_publication_heads (
    workspace_key, channel, publication_id, publication_version, packet_hash,
    delivery_payload_hash, source_cut_id, updated_at
  ) values (
    v_build.workspace_key, p_channel, v_publication.publication_id, v_version,
    v_build.packet_hash, v_delivery_payload_hash, v_build.source_cut_id, v_now
  ) on conflict (workspace_key, channel) do update
  set publication_id = excluded.publication_id,
      publication_version = excluded.publication_version,
      packet_hash = excluded.packet_hash,
      delivery_payload_hash = excluded.delivery_payload_hash,
      source_cut_id = excluded.source_cut_id,
      updated_at = excluded.updated_at;

  if p_channel = 'production' then
    insert into public.app_snapshots (snapshot_key, payload, updated_at)
    values (
      'shipment-truth-packets',
      v_published_payload,
      v_now
    ) on conflict (snapshot_key) do update
    set payload = excluded.payload, updated_at = excluded.updated_at;

    insert into public.app_snapshot_metadata (
      snapshot_key, snapshot_time, updated_at, writer_version, content_signature, payload_bytes
    ) values (
      'shipment-truth-packets',
      nullif(v_build.packet_payload->>'snapshotTime', ''),
      v_now,
      nullif(v_build.packet_payload->>'writerVersion', ''),
      v_delivery_payload_hash,
      pg_column_size(v_published_payload)::integer
    ) on conflict (snapshot_key) do update
    set snapshot_time = excluded.snapshot_time,
        updated_at = excluded.updated_at,
        writer_version = excluded.writer_version,
        content_signature = excluded.content_signature,
        payload_bytes = excluded.payload_bytes;

    v_active_index := jsonb_build_object(
      'snapshotTime', v_build.packet_payload->>'snapshotTime',
      'source', 'truth-publication-head',
      'writerVersion', 'active-awb-index-v2',
      'publicationId', v_publication.publication_id,
      'publicationVersion', v_version,
      'truthPacketContentSignature', v_delivery_payload_hash,
      'sourceCutId', v_build.source_cut_id,
      'activeAwbs', coalesce(v_build.packet_payload->'activeAwbs', '[]'::jsonb),
      'completedAwbs', coalesce(v_build.packet_payload->'completedAwbs', '[]'::jsonb)
    );
    v_active_index := v_active_index || jsonb_build_object(
      'contentSignature', encode(extensions.digest(
        convert_to(v_active_index::text, 'UTF8'), 'sha256'
      ), 'hex')
    );
    insert into public.app_snapshots (snapshot_key, payload, updated_at)
    values ('active-awb-index', v_active_index, v_now)
    on conflict (snapshot_key) do update
    set payload = excluded.payload, updated_at = excluded.updated_at;

    insert into public.app_snapshot_metadata (
      snapshot_key, snapshot_time, updated_at, writer_version, content_signature, payload_bytes
    ) values (
      'active-awb-index',
      nullif(v_active_index->>'snapshotTime', ''),
      v_now,
      nullif(v_active_index->>'writerVersion', ''),
      nullif(v_active_index->>'contentSignature', ''),
      pg_column_size(v_active_index)::integer
    ) on conflict (snapshot_key) do update
    set snapshot_time = excluded.snapshot_time,
        updated_at = excluded.updated_at,
        writer_version = excluded.writer_version,
        content_signature = excluded.content_signature,
        payload_bytes = excluded.payload_bytes;
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'publicationId', v_publication.publication_id,
    'publicationVersion', v_version,
    'packetHash', v_build.packet_hash,
    'deliveryPayloadHash', v_delivery_payload_hash,
    'semanticHash', v_build.semantic_hash,
    'sourceCutId', v_build.source_cut_id
  );
end;
$function$;

create or replace function public.seal_source_cut(
  p_workspace_key text,
  p_manifest_schema_version text,
  p_required_sources jsonb,
  p_gaps jsonb,
  p_cursors jsonb,
  p_observations jsonb,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.seal_source_cut(
    p_workspace_key, p_manifest_schema_version, p_required_sources, p_gaps,
    p_cursors, p_observations, p_created_by, p_sync_token
  );
$function$;

create or replace function public.begin_truth_build(
  p_workspace_key text,
  p_source_cut_id text,
  p_build_mode text,
  p_channel text,
  p_trigger_name text,
  p_base_publication_id uuid,
  p_inputs jsonb,
  p_versions jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.begin_truth_build(
    p_workspace_key, p_source_cut_id, p_build_mode, p_channel, p_trigger_name,
    p_base_publication_id, p_inputs, p_versions, p_sync_token
  );
$function$;

create or replace function public.complete_truth_build(
  p_build_id uuid,
  p_packet_text text,
  p_semantic_hash text,
  p_validation_report jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.complete_truth_build(
    p_build_id, p_packet_text, p_semantic_hash, p_validation_report, p_sync_token
  );
$function$;

create or replace function public.publish_truth_build_cas(
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
language sql
security invoker
set search_path = ''
as $function$
  select private.publish_truth_build_cas(
    p_build_id, p_channel, p_expected_head_version, p_expected_head_packet_hash,
    p_publication_reason, p_publisher_version, p_published_by, p_sync_token
  );
$function$;

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'source_cuts', 'source_cut_cursors', 'source_cut_observations',
    'accepted_claims', 'accepted_claim_evidence', 'claim_supersessions',
    'observation_entity_links', 'operational_workgroups_v2',
    'operational_workgroup_memberships', 'truth_builds', 'truth_build_inputs',
    'truth_publications', 'truth_publication_heads', 'truth_audit_runs',
    'truth_audit_findings'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert on public.%I to service_role', v_table);
  end loop;
end;
$block$;

grant update on public.truth_audit_runs to service_role;

-- Sealed cuts, exact build manifests, and canonical publication history may
-- only be written through the validating security-definer RPCs below.
revoke insert, update, delete on public.source_cuts from service_role;
revoke insert, update, delete on public.source_cut_cursors from service_role;
revoke insert, update, delete on public.source_cut_observations from service_role;
revoke insert, update, delete on public.truth_builds from service_role;
revoke insert, update, delete on public.truth_build_inputs from service_role;
revoke insert, update, delete on public.truth_publications from service_role;
revoke insert, update, delete on public.truth_publication_heads from service_role;

revoke all on function public.seal_source_cut(text, text, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.begin_truth_build(text, text, text, text, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.complete_truth_build(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.publish_truth_build_cas(uuid, text, bigint, text, text, text, text, text) from public, anon, authenticated;
revoke all on function private.seal_source_cut(text, text, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function private.begin_truth_build(text, text, text, text, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.complete_truth_build(uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function private.publish_truth_build_cas(uuid, text, bigint, text, text, text, text, text) from public, anon, authenticated;
revoke all on function private.source_cut_partition_witness(text, text, text, bigint) from public, anon, authenticated;
revoke all on function private.source_observation_matches_cut_fence(jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.source_observation_within_cut(text, text, text, text) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.seal_source_cut(text, text, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;
grant execute on function private.begin_truth_build(text, text, text, text, text, uuid, jsonb, jsonb, text) to service_role;
grant execute on function private.complete_truth_build(uuid, text, text, jsonb, text) to service_role;
grant execute on function private.publish_truth_build_cas(uuid, text, bigint, text, text, text, text, text) to service_role;
grant execute on function public.seal_source_cut(text, text, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;
grant execute on function public.begin_truth_build(text, text, text, text, text, uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.complete_truth_build(uuid, text, text, jsonb, text) to service_role;
grant execute on function public.publish_truth_build_cas(uuid, text, bigint, text, text, text, text, text) to service_role;

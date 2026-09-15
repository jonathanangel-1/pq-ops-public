-- Transactional snapshots/deltas for non-Gmail sources. Gmail has a paginated
-- provider-event contract; TMS, tracking, and operator sources commit one
-- bounded provider response and its observations under the same cursor fence.
-- This migration is intentionally fail-closed: a source cursor cannot advance
-- unless provider completeness, observation coverage, and extraction-job
-- coverage are sealed together.

create or replace function private.source_snapshot_contract(p_source_system text)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case p_source_system
    when 'tms' then jsonb_build_object(
      'cursorKind', 'tms_snapshot_timestamp',
      'providerSchemaVersion', 'tms-detail-source-snapshot-v1',
      'observationSchemaVersion', 'tms-shipment-source-observation-v1',
      'sourceObjectType', 'tms_shipment_snapshot',
      'jobKind', 'tms_extract_claims'
    )
    when 'tracking' then jsonb_build_object(
      'cursorKind', 'tracking_snapshot_timestamp',
      'providerSchemaVersion', 'tracking-source-snapshot-v1',
      'observationSchemaVersion', 'tracking-source-observation-v1',
      'sourceObjectType', 'tracking_shipment_snapshot',
      'jobKind', 'tracking_extract_claims'
    )
    when 'operator' then jsonb_build_object(
      'cursorKind', 'operator_sequence',
      'providerSchemaVersion', 'operator-source-delta-v1',
      'observationSchemaVersion', 'operator-event-source-observation-v1',
      'sourceObjectType', 'operator_event',
      'jobKind', 'operator_extract_claims'
    )
    else null::jsonb
  end;
$function$;

create or replace function private.is_canonical_utc_millis(p_value text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_value is null
    or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    return false;
  end if;
  return to_char(
    p_value::timestamptz at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) = p_value;
exception when others then
  return false;
end;
$function$;

create or replace function private.source_snapshot_observation_manifest(p_observations jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    jsonb_agg(item - 'capturedAt' order by item->>'observationId'),
    '[]'::jsonb
  )
  from jsonb_array_elements(p_observations) item;
$function$;

create or replace function private.source_snapshot_job_manifest(p_jobs jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(jsonb_agg(item order by item->>'dedupeKey'), '[]'::jsonb)
  from jsonb_array_elements(p_jobs) item;
$function$;

create or replace function private.source_snapshot_payload_identity(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_next_cursor_value text,
  p_provider_manifest_hash text,
  p_observation_manifest_hash text,
  p_job_manifest_hash text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'source-snapshot-payload-identity-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', p_source_system,
    'connectionKey', p_connection_key,
    'nextCursorValue', p_next_cursor_value,
    'providerManifestHash', p_provider_manifest_hash,
    'observationManifestHash', p_observation_manifest_hash,
    'jobManifestHash', p_job_manifest_hash
  )::text, 'UTF8'), 'sha256'), 'hex');
$function$;

create or replace function private.tms_row_manifest_hash(p_rows jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  with rows as (
    select item
    from jsonb_array_elements(p_rows) item
  ), encoded as (
    select item->>'sourceObjectId' as source_object_id,
      octet_length(convert_to(coalesce(item->>'sourceObjectId', ''), 'UTF8'))::text || ':' || coalesce(item->>'sourceObjectId', '') ||
      octet_length(convert_to(coalesce(item->>'order', ''), 'UTF8'))::text || ':' || coalesce(item->>'order', '') ||
      octet_length(convert_to(coalesce(item->>'trackingNumber', ''), 'UTF8'))::text || ':' || coalesce(item->>'trackingNumber', '') ||
      octet_length(convert_to(coalesce(item->>'observationId', ''), 'UTF8'))::text || ':' || coalesce(item->>'observationId', '') ||
      octet_length(convert_to(coalesce(item->>'contentHash', ''), 'UTF8'))::text || ':' || coalesce(item->>'contentHash', '') as value
    from rows
  )
  select encode(extensions.digest(convert_to(
    coalesce(string_agg(value, '' order by source_object_id), ''),
    'UTF8'
  ), 'sha256'), 'hex')
  from encoded;
$function$;

create or replace function private.tracking_row_manifest_hash(p_rows jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  with rows as (
    select item
    from jsonb_array_elements(p_rows) item
  ), encoded as (
    select item->>'awb' as awb,
      octet_length(convert_to(coalesce(item->>'awb', ''), 'UTF8'))::text || ':' || coalesce(item->>'awb', '') ||
      octet_length(convert_to(coalesce(item->>'observationId', ''), 'UTF8'))::text || ':' || coalesce(item->>'observationId', '') ||
      octet_length(convert_to(coalesce(item->>'contentHash', ''), 'UTF8'))::text || ':' || coalesce(item->>'contentHash', '') ||
      octet_length(convert_to(coalesce(item->>'healthStatus', ''), 'UTF8'))::text || ':' || coalesce(item->>'healthStatus', '') ||
      octet_length(convert_to(coalesce(item->>'provenanceStatus', ''), 'UTF8'))::text || ':' || coalesce(item->>'provenanceStatus', '') as value
    from rows
  )
  select encode(extensions.digest(convert_to(
    coalesce(string_agg(value, '' order by awb), ''),
    'UTF8'
  ), 'sha256'), 'hex')
  from encoded;
$function$;

-- The operator adapter hashes stable JSON with alphabetically sorted object
-- keys and no insignificant whitespace. Event fields are constrained below to
-- canonical scalar strings, so this expression is the exact SQL equivalent.
create or replace function private.operator_event_manifest_hash(p_events jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  with encoded as (
    select ordinal,
      '{"contentHash":' || to_jsonb(coalesce(item->>'contentHash', ''))::text ||
      ',"eventId":' || to_jsonb(coalesce(item->>'eventId', ''))::text ||
      ',"observationId":' || to_jsonb(coalesce(item->>'observationId', ''))::text ||
      ',"sequence":' || to_jsonb(coalesce(item->>'sequence', ''))::text || '}' as value
    from jsonb_array_elements(p_events) with ordinality as event(item, ordinal)
  )
  select encode(extensions.digest(convert_to(
    case
      when count(*) = 0 then '[]'
      else '[' || string_agg(value, ',' order by ordinal) || ']'
    end,
    'UTF8'
  ), 'sha256'), 'hex')
  from encoded;
$function$;

create or replace function private.source_snapshot_failure_hash(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_cursor_version bigint,
  p_cursor_value text,
  p_batch_id uuid,
  p_failure_stage text,
  p_error_code text,
  p_safe_error_detail text,
  p_diagnostics jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'source-snapshot-failure-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', p_source_system,
    'connectionKey', p_connection_key,
    'cursorVersion', p_cursor_version,
    'cursorValue', p_cursor_value,
    'batchId', coalesce(p_batch_id::text, ''),
    'failureStage', p_failure_stage,
    'errorCode', p_error_code,
    'safeErrorDetail', p_safe_error_detail,
    'diagnostics', p_diagnostics
  )::text, 'UTF8'), 'sha256'), 'hex');
$function$;

-- Recovery is an explicit source-ingest mode, never an implicit status reset.
alter table public.source_ingest_batches
  drop constraint if exists source_ingest_batches_mode_check;
alter table public.source_ingest_batches
  add constraint source_ingest_batches_mode_check
  check (mode = any (array[
    'history', 'backfill', 'reconciliation', 'snapshot', 'snapshot_recovery'
  ]));

create table if not exists public.source_ingest_manifests (
  batch_id uuid primary key
    references public.source_ingest_batches(batch_id) on delete restrict,
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  next_cursor_value text not null,
  source_snapshot_at timestamptz not null,
  provider_manifest jsonb not null check (jsonb_typeof(provider_manifest) = 'object'),
  provider_manifest_hash text not null check (provider_manifest_hash ~ '^[0-9a-f]{64}$'),
  observation_manifest jsonb not null check (jsonb_typeof(observation_manifest) = 'array'),
  observation_manifest_hash text not null check (observation_manifest_hash ~ '^[0-9a-f]{64}$'),
  job_manifest jsonb not null check (jsonb_typeof(job_manifest) = 'array'),
  job_manifest_hash text not null check (job_manifest_hash ~ '^[0-9a-f]{64}$'),
  payload_identity_hash text not null unique check (payload_identity_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.source_ingest_batch_jobs (
  batch_id uuid not null
    references public.source_ingest_batches(batch_id) on delete restrict,
  job_id uuid not null
    references public.source_processing_jobs(job_id) on delete restrict,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, job_id),
  unique (batch_id, dedupe_key)
);

create table if not exists public.source_snapshot_failures (
  failure_id uuid primary key default gen_random_uuid(),
  failure_hash text not null unique check (failure_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  cursor_version bigint not null check (cursor_version >= 0),
  cursor_value text not null default '',
  batch_id uuid references public.source_ingest_batches(batch_id) on delete restrict,
  failure_stage text not null check (failure_stage = any (array['preflight', 'commit'])),
  error_code text not null,
  safe_error_detail text not null,
  diagnostics jsonb not null default '{}'::jsonb check (jsonb_typeof(diagnostics) = 'object'),
  recorded_by text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.source_snapshot_failure_resolutions (
  failure_id uuid primary key
    references public.source_snapshot_failures(failure_id) on delete restrict,
  resolved_by_batch_id uuid not null
    references public.source_ingest_batches(batch_id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp()
);

drop trigger if exists source_ingest_manifests_immutable
  on public.source_ingest_manifests;
create trigger source_ingest_manifests_immutable
before update or delete on public.source_ingest_manifests
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists source_ingest_batch_jobs_immutable
  on public.source_ingest_batch_jobs;
create trigger source_ingest_batch_jobs_immutable
before update or delete on public.source_ingest_batch_jobs
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists source_snapshot_failures_immutable
  on public.source_snapshot_failures;
create trigger source_snapshot_failures_immutable
before update or delete on public.source_snapshot_failures
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists source_snapshot_failure_resolutions_immutable
  on public.source_snapshot_failure_resolutions;
create trigger source_snapshot_failure_resolutions_immutable
before update or delete on public.source_snapshot_failure_resolutions
for each row execute function public.reject_immutable_truth_mutation();

create index if not exists source_ingest_manifests_scope_idx
  on public.source_ingest_manifests (
    workspace_key, source_system, connection_key, created_at desc
  );
create index if not exists source_snapshot_failures_scope_idx
  on public.source_snapshot_failures (
    workspace_key, source_system, connection_key, created_at desc
  );

create or replace function private.guard_generic_source_batch_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_contract jsonb;
begin
  v_contract := private.source_snapshot_contract(new.source_system);
  if v_contract is null then
    return new;
  end if;
  if new.mode not in ('snapshot', 'snapshot_recovery') then
    raise exception 'supported non-Gmail sources require snapshot or snapshot-recovery mode'
      using errcode = '23514';
  end if;
  select * into v_cursor
  from public.source_cursors
  where workspace_key = new.workspace_key
    and source_system = new.source_system
    and connection_key = new.connection_key;
  if not found or v_cursor.cursor_kind is distinct from v_contract->>'cursorKind'
    or (
      new.mode = 'snapshot' and not (
        v_cursor.status = 'live'
        or (
          v_cursor.status = 'backfill_required'
          and v_cursor.cursor_version = 0
          and v_cursor.cursor_value = ''
          and v_cursor.last_batch_id is null
        )
      )
    )
    or (
      new.mode = 'snapshot_recovery'
      and v_cursor.status not in ('error', 'reconcile_required')
    ) then
    raise exception 'source snapshot cursor state does not permit a new batch' using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists generic_source_batch_insert_guard on public.source_ingest_batches;
create trigger generic_source_batch_insert_guard
before insert on public.source_ingest_batches
for each row execute function private.guard_generic_source_batch_insert();

create or replace function private.guard_generic_source_cut_cursor_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_workspace_key text;
  v_cut_completeness text;
  v_cursor_status text;
  v_manifest public.source_ingest_manifests%rowtype;
begin
  if private.source_snapshot_contract(new.source_system) is null then
    return new;
  end if;
  select source_cut.workspace_key, source_cut.completeness
  into v_workspace_key, v_cut_completeness
  from public.source_cuts source_cut
  where source_cut.source_cut_id = new.source_cut_id;
  if not found then
    raise exception 'generic source cut lacks its sealed workspace' using errcode = '23514';
  end if;
  select manifest.* into v_manifest
  from public.source_ingest_batches batch
  join public.source_ingest_manifests manifest on manifest.batch_id = batch.batch_id
  where batch.workspace_key = v_workspace_key
    and batch.source_system = new.source_system
    and batch.connection_key = new.connection_key
    and batch.status = 'committed'
    and batch.committed_cursor_version = new.through_cursor_version
    and batch.committed_cursor_value = new.through_cursor_value;
  if not found
    or new.upstream_watermark is distinct from v_manifest.provider_manifest->>'upstreamWatermark'
    or new.source_snapshot_at is distinct from v_manifest.source_snapshot_at then
    raise exception 'source cut freshness does not match the committed provider manifest'
      using errcode = '23514';
  end if;
  select cursor.status into v_cursor_status
  from public.source_cursors cursor
  where cursor.workspace_key = v_workspace_key
    and cursor.source_system = new.source_system
    and cursor.connection_key = new.connection_key
    and cursor.cursor_version = new.through_cursor_version
    and cursor.cursor_value = new.through_cursor_value;
  if not found or (v_cut_completeness = 'complete' and v_cursor_status <> 'live') then
    raise exception 'complete source cut requires a currently live generic source cursor'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists generic_source_cut_cursor_insert_guard on public.source_cut_cursors;
create trigger generic_source_cut_cursor_insert_guard
before insert on public.source_cut_cursors
for each row execute function private.guard_generic_source_cut_cursor_insert();

create or replace function private.record_source_snapshot_preflight_failure(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_cursor_kind text,
  p_recorded_by text,
  p_error_code text,
  p_safe_error_detail text,
  p_diagnostics jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_contract jsonb;
  v_cursor public.source_cursors%rowtype;
  v_failure_id uuid;
  v_failure_hash text;
  v_idempotent boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_contract := private.source_snapshot_contract(p_source_system);
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or v_contract is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or p_cursor_kind is distinct from v_contract->>'cursorKind'
    or nullif(trim(coalesce(p_recorded_by, '')), '') is null
    or nullif(trim(coalesce(p_error_code, '')), '') is null
    or length(p_error_code) > 100
    or nullif(trim(coalesce(p_safe_error_detail, '')), '') is null
    or length(p_safe_error_detail) > 500
    or jsonb_typeof(coalesce(p_diagnostics, 'null'::jsonb)) <> 'object' then
    raise exception 'invalid source snapshot preflight-failure request' using errcode = '22023';
  end if;

  insert into public.source_cursors (
    workspace_key, source_system, connection_key, cursor_kind
  ) values (
    p_workspace_key, p_source_system, p_connection_key, p_cursor_kind
  ) on conflict (workspace_key, source_system, connection_key) do nothing;

  select * into v_cursor
  from public.source_cursors
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
  for update;
  if v_cursor.cursor_kind is distinct from p_cursor_kind then
    raise exception 'source cursor kind mismatch' using errcode = '23514';
  end if;
  if v_cursor.lease_expires_at is not null
    and v_cursor.lease_expires_at > v_now then
    raise exception 'source sync lease is active; preflight failure cannot replace it'
      using errcode = '40001';
  end if;

  v_failure_hash := private.source_snapshot_failure_hash(
    p_workspace_key, p_source_system, p_connection_key,
    v_cursor.cursor_version, v_cursor.cursor_value, null,
    'preflight', p_error_code, p_safe_error_detail, p_diagnostics
  );
  insert into public.source_snapshot_failures (
    failure_hash, workspace_key, source_system, connection_key,
    cursor_version, cursor_value, batch_id, failure_stage,
    error_code, safe_error_detail, diagnostics, recorded_by
  ) values (
    v_failure_hash, p_workspace_key, p_source_system, p_connection_key,
    v_cursor.cursor_version, v_cursor.cursor_value, null, 'preflight',
    p_error_code, p_safe_error_detail, p_diagnostics, p_recorded_by
  ) on conflict (failure_hash) do nothing
  returning failure_id into v_failure_id;
  if not found then
    v_idempotent := true;
    select failure_id into v_failure_id
    from public.source_snapshot_failures
    where failure_hash = v_failure_hash;
  end if;

  update public.source_ingest_batches
  set status = 'failed',
      error_code = p_error_code,
      error_detail = p_safe_error_detail,
      finished_at = v_now
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
    and status = 'running'
    and expected_cursor_version = v_cursor.cursor_version
    and expected_cursor_value is not distinct from v_cursor.cursor_value;

  update public.source_cursors
  set status = case when status = 'paused' then 'paused' else 'error' end,
      last_error_code = p_error_code,
      last_error_detail = p_safe_error_detail,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
  returning * into v_cursor;

  return jsonb_build_object(
    'ok', true,
    'idempotent', v_idempotent,
    'failureId', v_failure_id,
    'failureHash', v_failure_hash,
    'status', v_cursor.status,
    'cursorValue', v_cursor.cursor_value,
    'cursorVersion', v_cursor.cursor_version,
    'cursorAdvanced', false
  );
end;
$function$;

create or replace function private.recover_committed_source_snapshot(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_next_cursor_value text,
  p_provider_manifest jsonb,
  p_observations jsonb,
  p_jobs jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_manifest public.source_ingest_manifests%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_observation_manifest jsonb;
  v_job_manifest jsonb;
  v_provider_manifest_hash text;
  v_observation_manifest_hash text;
  v_job_manifest_hash text;
  v_payload_identity_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or private.source_snapshot_contract(p_source_system) is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or nullif(trim(coalesce(p_next_cursor_value, '')), '') is null
    or jsonb_typeof(coalesce(p_provider_manifest, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_observations, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_jobs, 'null'::jsonb)) <> 'array' then
    raise exception 'invalid source snapshot recovery request' using errcode = '22023';
  end if;

  v_observation_manifest := private.source_snapshot_observation_manifest(p_observations);
  v_job_manifest := private.source_snapshot_job_manifest(p_jobs);
  v_provider_manifest_hash := encode(extensions.digest(
    convert_to(p_provider_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_observation_manifest_hash := encode(extensions.digest(
    convert_to(v_observation_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_job_manifest_hash := encode(extensions.digest(
    convert_to(v_job_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_payload_identity_hash := private.source_snapshot_payload_identity(
    p_workspace_key, p_source_system, p_connection_key, p_next_cursor_value,
    v_provider_manifest_hash, v_observation_manifest_hash, v_job_manifest_hash
  );

  select * into v_manifest
  from public.source_ingest_manifests
  where payload_identity_hash = v_payload_identity_hash;
  if not found then
    return jsonb_build_object(
      'ok', true,
      'found', false,
      'payloadIdentityHash', v_payload_identity_hash
    );
  end if;
  if v_manifest.workspace_key is distinct from p_workspace_key
    or v_manifest.source_system is distinct from p_source_system
    or v_manifest.connection_key is distinct from p_connection_key
    or v_manifest.next_cursor_value is distinct from p_next_cursor_value
    or v_manifest.provider_manifest is distinct from p_provider_manifest
    or v_manifest.observation_manifest is distinct from v_observation_manifest
    or v_manifest.job_manifest is distinct from v_job_manifest then
    raise exception 'source snapshot payload identity collision' using errcode = '23505';
  end if;
  select * into v_batch
  from public.source_ingest_batches
  where batch_id = v_manifest.batch_id and status = 'committed';
  if not found then
    raise exception 'source snapshot recovery manifest is not committed' using errcode = '23514';
  end if;
  select * into v_cursor
  from public.source_cursors
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key;
  if not found
    or v_cursor.status <> 'live'
    or v_cursor.last_batch_id is distinct from v_batch.batch_id
    or v_cursor.cursor_version is distinct from v_batch.committed_cursor_version
    or v_cursor.cursor_value is distinct from v_batch.committed_cursor_value then
    return jsonb_build_object(
      'ok', true,
      'found', false,
      'requiresRecovery', true,
      'payloadIdentityHash', v_payload_identity_hash
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'found', true,
    'recovered', true,
    'idempotent', true,
    'payloadIdentityHash', v_payload_identity_hash,
    'batchId', v_batch.batch_id,
    'batchHash', v_batch.batch_hash,
    'committedCursorValue', v_batch.committed_cursor_value,
    'committedCursorVersion', v_batch.committed_cursor_version,
    'providerManifestHash', v_manifest.provider_manifest_hash,
    'observationManifestHash', v_manifest.observation_manifest_hash,
    'jobManifestHash', v_manifest.job_manifest_hash,
    'observationCount', v_batch.observation_count,
    'jobCount', v_batch.job_count
  );
end;
$function$;

create or replace function private.commit_source_snapshot_batch(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
  p_next_cursor_value text,
  p_provider_manifest jsonb,
  p_observations jsonb,
  p_jobs jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_batch public.source_ingest_batches%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_existing_manifest public.source_ingest_manifests%rowtype;
  v_recovered_manifest public.source_ingest_manifests%rowtype;
  v_recovered_batch public.source_ingest_batches%rowtype;
  v_contract jsonb;
  v_observation_count integer;
  v_observation_distinct_count integer;
  v_coordinate_distinct_count integer;
  v_job_count integer;
  v_job_distinct_count integer;
  v_job_observation_distinct_count integer;
  v_observation_manifest jsonb;
  v_job_manifest jsonb;
  v_provider_manifest_hash text;
  v_observation_manifest_hash text;
  v_job_manifest_hash text;
  v_payload_identity_hash text;
  v_batch_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_batch_id is null
    or nullif(trim(coalesce(p_owner_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_next_cursor_value, '')), '') is null
    or jsonb_typeof(coalesce(p_provider_manifest, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_observations, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_jobs, 'null'::jsonb)) <> 'array' then
    raise exception 'invalid source snapshot commit request' using errcode = '22023';
  end if;

  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id;
  if not found then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;
  v_contract := private.source_snapshot_contract(v_batch.source_system);
  if v_contract is null or v_batch.mode not in ('snapshot', 'snapshot_recovery') then
    raise exception 'source snapshot commit requires a supported non-Gmail snapshot batch'
      using errcode = '23514';
  end if;

  select count(*)::integer,
         count(distinct (item->>'observationId'))::integer,
         count(distinct jsonb_build_array(
           item->>'sourceObjectType', item->>'sourceObjectId',
           coalesce(item->>'sourceRevision', ''),
           coalesce(item->>'operation', 'content')
         ))::integer
  into v_observation_count, v_observation_distinct_count, v_coordinate_distinct_count
  from jsonb_array_elements(p_observations) item;
  select count(*)::integer,
         count(distinct (item->>'dedupeKey'))::integer,
         count(distinct (item->>'observationId'))::integer
  into v_job_count, v_job_distinct_count, v_job_observation_distinct_count
  from jsonb_array_elements(p_jobs) item;

  if v_observation_count <> v_observation_distinct_count
    or v_observation_count <> v_coordinate_distinct_count
    or v_job_count <> v_job_distinct_count
    or v_job_count <> v_job_observation_distinct_count
    or v_job_count <> v_observation_count then
    raise exception 'source snapshot requires unique one-to-one observation/job coverage'
      using errcode = '23514';
  end if;

  if p_provider_manifest->>'schemaVersion' is distinct from v_contract->>'providerSchemaVersion'
    or p_provider_manifest->'complete' is distinct from 'true'::jsonb
    or coalesce(p_provider_manifest->>'upstreamWatermark', '') is distinct from p_next_cursor_value
    or not private.is_canonical_utc_millis(p_provider_manifest->>'sourceSnapshotAt')
    or (v_batch.source_system <> 'operator'
      and p_provider_manifest->>'sourceSnapshotAt' is distinct from p_next_cursor_value)
    or jsonb_typeof(coalesce(p_provider_manifest->'recordCount', 'null'::jsonb)) <> 'number'
    or coalesce(p_provider_manifest->>'recordCount', '') !~ '^[0-9]+$'
    or length(coalesce(p_provider_manifest->>'recordCount', '')) > 10
    or (p_provider_manifest->>'recordCount')::numeric <> v_observation_count then
    raise exception 'source snapshot provider manifest is incomplete or inconsistent'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_observations) item
    where jsonb_typeof(item) <> 'object'
      or coalesce(item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
      or item->>'sourceObjectType' is distinct from v_contract->>'sourceObjectType'
      or nullif(trim(coalesce(item->>'sourceObjectId', '')), '') is null
      or nullif(trim(coalesce(item->>'sourceRevision', '')), '') is null
      or not (coalesce(item->>'operation', 'content') = any (array[
        'content', 'metadata_change', 'delete'
      ]))
      or coalesce(item->>'contentHash', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(coalesce(item->'normalizedPayload', '{}'::jsonb)) <> 'object'
      or coalesce(item->>'sourceFidelity', 'normalized_source') <> 'normalized_source'
      or item->>'schemaVersion' is distinct from v_contract->>'observationSchemaVersion'
      or (
        item ? 'rawObject'
        and jsonb_typeof(item->'rawObject') <> 'null'
        and (
          jsonb_typeof(item->'rawObject') <> 'object'
          or nullif(trim(coalesce(item->'rawObject'->>'bucket', '')), '') is null
          or nullif(trim(coalesce(item->'rawObject'->>'key', '')), '') is null
          or coalesce(item->'rawObject'->>'hash', '') !~ '^[0-9a-f]{64}$'
          or coalesce(item->'rawObject'->>'bytes', '') !~ '^[0-9]+$'
          or nullif(trim(coalesce(item->'rawObject'->>'contentType', '')), '') is null
        )
      )
  ) then
    raise exception 'source snapshot observation is invalid' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_jobs) item
    left join jsonb_array_elements(p_observations) observation
      on observation->>'observationId' = item->>'observationId'
    where jsonb_typeof(item) <> 'object'
      or nullif(trim(coalesce(item->>'dedupeKey', '')), '') is null
      or item->>'jobKind' is distinct from v_contract->>'jobKind'
      or coalesce(item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
      or observation is null
      or item->>'sourceObjectId' is distinct from observation->>'sourceObjectId'
      or coalesce(item->>'maxAttempts', '5') !~ '^[1-9][0-9]*$'
      or case
        when coalesce(item->>'maxAttempts', '5') ~ '^[1-9][0-9]*$'
          then coalesce(item->>'maxAttempts', '5')::numeric > 100
        else false
      end
      or jsonb_typeof(coalesce(item->'payload', '{}'::jsonb)) <> 'object'
      or coalesce(item->'payload', '{}'::jsonb) ?| array[
        'batchId', 'rootBatchId', 'rootJobId', 'parentJobId'
      ]
  ) then
    raise exception 'source snapshot processing job is invalid' using errcode = '23514';
  end if;

  if v_batch.source_system = 'tms' then
    if p_provider_manifest->>'sourceSnapshotKey' is distinct from 'tms-detail-snapshot'
      or coalesce(p_provider_manifest->>'visibleTaskCount', '') !~ '^[0-9]+$'
      or coalesce(p_provider_manifest->>'orderLinkCount', '') !~ '^[0-9]+$'
      or (p_provider_manifest->>'visibleTaskCount')::numeric <> v_observation_count
      or (p_provider_manifest->>'orderLinkCount')::numeric <> v_observation_count
      or jsonb_typeof(coalesce(p_provider_manifest->'detailPull', 'null'::jsonb)) <> 'object'
      or coalesce(p_provider_manifest->'detailPull'->>'attempted', '') !~ '^[0-9]+$'
      or coalesce(p_provider_manifest->'detailPull'->>'succeeded', '') !~ '^[0-9]+$'
      or coalesce(p_provider_manifest->'detailPull'->>'failed', '') !~ '^[0-9]+$'
      or (p_provider_manifest->'detailPull'->>'attempted')::numeric <> v_observation_count
      or (p_provider_manifest->'detailPull'->>'succeeded')::numeric <> v_observation_count
      or (p_provider_manifest->'detailPull'->>'failed')::numeric <> 0
      or jsonb_typeof(coalesce(p_provider_manifest->'scopeAudit', 'null'::jsonb)) <> 'object'
      or nullif(trim(coalesce(p_provider_manifest->'scopeAudit'->>'source', '')), '') is null
      or nullif(trim(coalesce(p_provider_manifest->'scopeAudit'->>'url', '')), '') is null
      or p_provider_manifest->'scopeAudit'->>'title' is distinct from 'Operations Log'
      or coalesce(p_provider_manifest->'scopeAudit'->>'url', '') !~* 'CurrentTab=0(&|$)'
      or coalesce(p_provider_manifest->'scopeAudit'->>'activeTab', '') !~* 'OPS[[:space:]]+TLV-US'
      or jsonb_typeof(coalesce(p_provider_manifest->'scopeAudit'->'filters', 'null'::jsonb)) <> 'object'
      or coalesce(p_provider_manifest->'scopeAudit'->>'visibleTaskCount', '') !~ '^[0-9]+$'
      or coalesce(p_provider_manifest->'scopeAudit'->>'orderLinkCount', '') !~ '^[0-9]+$'
      or coalesce(p_provider_manifest->'scopeAudit'->>'gridRows', '') !~ '^[0-9]+$'
      or coalesce(p_provider_manifest->'scopeAudit'->>'detailRows', '') !~ '^[0-9]+$'
      or (p_provider_manifest->'scopeAudit'->>'visibleTaskCount')::numeric <> v_observation_count
      or (p_provider_manifest->'scopeAudit'->>'orderLinkCount')::numeric <> v_observation_count
      or (p_provider_manifest->'scopeAudit'->>'gridRows')::numeric <> v_observation_count
      or (p_provider_manifest->'scopeAudit'->>'detailRows')::numeric <> v_observation_count
      or p_provider_manifest->>'rowManifestHashAlgorithm' is distinct from 'length-prefixed-utf8-v1'
      or coalesce(p_provider_manifest->>'rowManifestHash', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(coalesce(p_provider_manifest->'rows', 'null'::jsonb)) <> 'array' then
      raise exception 'TMS provider scope/detail completeness proof is invalid' using errcode = '23514';
    end if;
    if (select count(*) from jsonb_array_elements(p_provider_manifest->'rows')) <> v_observation_count
      or (select count(distinct item->>'sourceObjectId') from jsonb_array_elements(p_provider_manifest->'rows') item) <> v_observation_count
      or (select count(distinct item->>'observationId') from jsonb_array_elements(p_provider_manifest->'rows') item) <> v_observation_count
      or private.tms_row_manifest_hash(p_provider_manifest->'rows') is distinct from p_provider_manifest->>'rowManifestHash' then
      raise exception 'TMS row manifest count or hash is invalid' using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'rows') row_item
      left join jsonb_array_elements(p_observations) observation
        on observation->>'observationId' = row_item->>'observationId'
      left join jsonb_array_elements(p_jobs) job
        on job->>'observationId' = row_item->>'observationId'
      where jsonb_typeof(row_item) <> 'object'
        or nullif(trim(coalesce(row_item->>'sourceObjectId', '')), '') is null
        or nullif(trim(coalesce(row_item->>'order', '')), '') is null
        or nullif(trim(coalesce(row_item->>'trackingNumber', '')), '') is null
        or coalesce(row_item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
        or coalesce(row_item->>'contentHash', '') !~ '^[0-9a-f]{64}$'
        or observation is null or job is null
        or observation->>'sourceObjectId' is distinct from row_item->>'sourceObjectId'
        or observation->>'contentHash' is distinct from row_item->>'contentHash'
        or observation->>'sourceRevision' is distinct from 'snapshot:' || p_next_cursor_value
        or observation->>'sourceRecordedAt' is distinct from p_next_cursor_value
        or observation->'normalizedPayload'->>'schemaVersion' is distinct from v_contract->>'observationSchemaVersion'
        or observation->'normalizedPayload'->>'snapshotTime' is distinct from p_next_cursor_value
        or lower(coalesce(observation->'normalizedPayload'->'shipment'->>'shipmentGuid', ''))
          is distinct from row_item->>'sourceObjectId'
        or coalesce(
          nullif(trim(coalesce(observation->'normalizedPayload'->'shipment'->>'order', '')), ''),
          trim(coalesce(observation->'normalizedPayload'->'shipment'->>'shipmentNumber', ''))
        ) is distinct from row_item->>'order'
        or trim(coalesce(observation->'normalizedPayload'->'shipment'->>'trackingNumber', ''))
          is distinct from row_item->>'trackingNumber'
        or job->'payload'->>'schemaVersion' is distinct from 'tms-extract-claims-job-v1'
        or job->'payload'->>'sourceSnapshotTime' is distinct from p_next_cursor_value
        or job->'payload'->>'sourceObservationId' is distinct from row_item->>'observationId'
        or lower(coalesce(job->'payload'->>'shipmentGuid', '')) is distinct from row_item->>'sourceObjectId'
        or job->'payload'->>'order' is distinct from row_item->>'order'
        or job->'payload'->>'trackingNumber' is distinct from row_item->>'trackingNumber'
        or nullif(trim(coalesce(job->'payload'->>'extractorVersion', '')), '') is null
    ) then
      raise exception 'TMS row manifest is not fully mapped to observations and extraction jobs'
        using errcode = '23514';
    end if;
  elsif v_batch.source_system = 'tracking' then
    if p_provider_manifest->>'sourceSnapshotKey' is distinct from 'carrier-tracking-snapshot'
      or jsonb_typeof(coalesce(p_provider_manifest->'expectedAwbs', 'null'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(p_provider_manifest->'sourceDescriptions', 'null'::jsonb)) <> 'array'
      or jsonb_typeof(coalesce(p_provider_manifest->'healthCounts', 'null'::jsonb)) <> 'object'
      or p_provider_manifest->>'rowManifestHashAlgorithm' is distinct from 'length-prefixed-utf8-v1'
      or coalesce(p_provider_manifest->>'rowManifestHash', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(coalesce(p_provider_manifest->'rows', 'null'::jsonb)) <> 'array' then
      raise exception 'tracking provider scope/provenance completeness proof is invalid'
        using errcode = '23514';
    end if;
    if jsonb_array_length(p_provider_manifest->'sourceDescriptions') = 0
      or exists (
        select 1
        from jsonb_array_elements(p_provider_manifest->'sourceDescriptions') description
        where jsonb_typeof(description) <> 'string'
          or nullif(trim(description #>> '{}'), '') is null
      )
      or (
        select count(*)
        from jsonb_array_elements(p_provider_manifest->'sourceDescriptions')
      ) <> (
        select count(distinct description #>> '{}')
        from jsonb_array_elements(p_provider_manifest->'sourceDescriptions') description
      )
      or p_provider_manifest->'sourceDescriptions' is distinct from (
        select coalesce(jsonb_agg(description order by description #>> '{}'), '[]'::jsonb)
        from jsonb_array_elements(p_provider_manifest->'sourceDescriptions') description
      ) then
      raise exception 'tracking source descriptions must be a non-empty canonical unique witness'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'expectedAwbs') expected
      where jsonb_typeof(expected) <> 'string'
        or (expected #>> '{}') !~ '^[0-9]{11}$'
    )
      or (
        select count(*)
        from jsonb_array_elements(p_provider_manifest->'expectedAwbs')
      ) <> (
        select count(distinct expected #>> '{}')
        from jsonb_array_elements(p_provider_manifest->'expectedAwbs') expected
      )
      or p_provider_manifest->'expectedAwbs' is distinct from (
        select coalesce(jsonb_agg(expected order by expected #>> '{}'), '[]'::jsonb)
        from jsonb_array_elements(p_provider_manifest->'expectedAwbs') expected
      ) then
      raise exception 'tracking expected AWB scope must be explicit, canonical, and unique'
        using errcode = '23514';
    end if;
    if jsonb_array_length(p_provider_manifest->'expectedAwbs') <> v_observation_count
      or jsonb_array_length(p_provider_manifest->'rows') <> v_observation_count
      or (
        select count(distinct item->>'awb')
        from jsonb_array_elements(p_provider_manifest->'rows') item
      ) <> v_observation_count
      or (
        select count(distinct item->>'observationId')
        from jsonb_array_elements(p_provider_manifest->'rows') item
      ) <> v_observation_count
      or p_provider_manifest->'rows' is distinct from (
        select coalesce(jsonb_agg(item order by item->>'awb'), '[]'::jsonb)
        from jsonb_array_elements(p_provider_manifest->'rows') item
      )
      or private.tracking_row_manifest_hash(p_provider_manifest->'rows')
        is distinct from p_provider_manifest->>'rowManifestHash' then
      raise exception 'tracking expected scope, row count, order, or hash is invalid'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'rows') row_item
      left join jsonb_array_elements(p_provider_manifest->'expectedAwbs') expected
        on expected #>> '{}' = row_item->>'awb'
      where jsonb_typeof(row_item) <> 'object'
        or coalesce(row_item->>'awb', '') !~ '^[0-9]{11}$'
        or coalesce(row_item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
        or coalesce(row_item->>'contentHash', '') !~ '^[0-9a-f]{64}$'
        or not (coalesce(row_item->>'healthStatus', '') = any (array[
          'healthy', 'no_result', 'research_only',
          'insufficient_research_input', 'provider_failure'
        ]))
        or nullif(trim(coalesce(row_item->>'provenanceStatus', '')), '') is null
        or expected is null
    ) then
      raise exception 'tracking row manifest does not exactly cover the expected AWB scope'
        using errcode = '23514';
    end if;
    if p_provider_manifest->'healthCounts' is distinct from (
      select coalesce(jsonb_object_agg(status, to_jsonb(row_count)), '{}'::jsonb)
      from (
        select row_item->>'healthStatus' as status, count(*) as row_count
        from jsonb_array_elements(p_provider_manifest->'rows') row_item
        group by row_item->>'healthStatus'
      ) counts
    ) then
      raise exception 'tracking provider health counts do not match the sealed row manifest'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'rows') row_item
      left join jsonb_array_elements(p_observations) observation
        on observation->>'observationId' = row_item->>'observationId'
      left join jsonb_array_elements(p_jobs) job
        on job->>'observationId' = row_item->>'observationId'
      where observation is null or job is null
        or observation->>'sourceObjectId' is distinct from row_item->>'awb'
        or observation->>'contentHash' is distinct from row_item->>'contentHash'
        or observation->>'sourceRevision' is distinct from 'snapshot:' || p_next_cursor_value
        or observation->>'sourceRecordedAt' is distinct from p_next_cursor_value
        or observation->>'capturedAt' is distinct from p_next_cursor_value
        or observation->'normalizedPayload'->>'schemaVersion'
          is distinct from v_contract->>'observationSchemaVersion'
        or observation->'normalizedPayload'->>'snapshotTime' is distinct from p_next_cursor_value
        or observation->'normalizedPayload'->>'awb' is distinct from row_item->>'awb'
        or jsonb_typeof(coalesce(observation->'normalizedPayload'->'provenance', 'null'::jsonb)) <> 'object'
        or jsonb_typeof(coalesce(observation->'normalizedPayload'->'sourceHealth', 'null'::jsonb)) <> 'object'
        or observation->'normalizedPayload'->'sourceHealth'->>'status'
          is distinct from row_item->>'healthStatus'
        or observation->'normalizedPayload'->'provenance'->>'status'
          is distinct from row_item->>'provenanceStatus'
        or nullif(trim(coalesce(
          observation->'normalizedPayload'->'provenance'->>'sourceDescription', ''
        )), '') is null
        or not exists (
          select 1
          from jsonb_array_elements_text(p_provider_manifest->'sourceDescriptions') description(value)
          where description.value = observation->'normalizedPayload'->'provenance'->>'sourceDescription'
        )
        or not (coalesce(
          observation->'normalizedPayload'->'provenance'->>'sourceKind', ''
        ) = any (array['official_carrier_tracking', 'flight_status_research']))
        or observation->'normalizedPayload'->'sourceHealth'->'positiveEvidenceEligible'
          is distinct from to_jsonb(
            row_item->>'healthStatus' = 'healthy'
            and observation->'normalizedPayload'->'provenance'->>'sourceKind'
              = 'official_carrier_tracking'
          )
        or (
          row_item->>'healthStatus' <> 'healthy'
          and nullif(trim(coalesce(
            observation->'normalizedPayload'->'sourceHealth'->>'error', ''
          )), '') is null
        )
        or job->'payload'->>'schemaVersion' is distinct from 'tracking-extract-claims-job-v1'
        or job->'payload'->>'sourceSnapshotTime' is distinct from p_next_cursor_value
        or job->'payload'->>'sourceObservationId' is distinct from row_item->>'observationId'
        or job->'payload'->>'awb' is distinct from row_item->>'awb'
        or job->'payload'->>'contentHash' is distinct from row_item->>'contentHash'
        or job->'payload'->>'healthStatus' is distinct from row_item->>'healthStatus'
        or nullif(trim(coalesce(job->'payload'->>'extractorVersion', '')), '') is null
    ) then
      raise exception 'tracking scope rows are not fully bound to observations, provenance, health, and jobs'
        using errcode = '23514';
    end if;
  elsif v_batch.source_system = 'operator' then
    if p_provider_manifest->'appendOnly' is distinct from 'true'::jsonb
      or coalesce(p_provider_manifest->>'previousSequence', '') !~ '^(0|[1-9][0-9]*)$'
      or coalesce(p_provider_manifest->>'nextSequence', '') !~ '^(0|[1-9][0-9]*)$'
      or length(coalesce(p_provider_manifest->>'previousSequence', '')) > 16
      or length(coalesce(p_provider_manifest->>'nextSequence', '')) > 16
      or coalesce(p_provider_manifest->>'eventManifestHash', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(coalesce(p_provider_manifest->'events', 'null'::jsonb)) <> 'array'
      or p_provider_manifest->>'nextSequence' is distinct from p_next_cursor_value then
      raise exception 'operator append-only sequence manifest is invalid' using errcode = '23514';
    end if;
    if (p_provider_manifest->>'previousSequence')::numeric > 9007199254740991
      or (p_provider_manifest->>'nextSequence')::numeric > 9007199254740991
      or (p_provider_manifest->>'nextSequence')::numeric
        <> (p_provider_manifest->>'previousSequence')::numeric + v_observation_count
      or jsonb_array_length(p_provider_manifest->'events') <> v_observation_count
      or private.operator_event_manifest_hash(p_provider_manifest->'events')
        is distinct from p_provider_manifest->>'eventManifestHash' then
      raise exception 'operator event count, next sequence, or manifest hash is invalid'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'events') with ordinality as event(row_item, ordinal)
      where jsonb_typeof(row_item) <> 'object'
        or coalesce(row_item->>'eventId', '') !~ '^operator-event:v1:[0-9a-f]{64}$'
        or coalesce(row_item->>'sequence', '') !~ '^[1-9][0-9]*$'
        or length(coalesce(row_item->>'sequence', '')) > 16
        or coalesce(row_item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
        or coalesce(row_item->>'contentHash', '') !~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'operator event manifest row is invalid' using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'events') with ordinality as event(row_item, ordinal)
      where (row_item->>'sequence')::numeric > 9007199254740991
        or (row_item->>'sequence')::numeric
          <> (p_provider_manifest->>'previousSequence')::numeric + ordinal
    )
      or (
        select count(distinct row_item->>'eventId')
        from jsonb_array_elements(p_provider_manifest->'events') row_item
      ) <> v_observation_count
      or (
        select count(distinct row_item->>'sequence')
        from jsonb_array_elements(p_provider_manifest->'events') row_item
      ) <> v_observation_count
      or (
        select count(distinct row_item->>'observationId')
        from jsonb_array_elements(p_provider_manifest->'events') row_item
      ) <> v_observation_count then
      raise exception 'operator event manifest must be a unique contiguous sequence'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_provider_manifest->'events') row_item
      left join jsonb_array_elements(p_observations) observation
        on observation->>'observationId' = row_item->>'observationId'
      left join jsonb_array_elements(p_jobs) job
        on job->>'observationId' = row_item->>'observationId'
      where observation is null or job is null
        or observation->>'sourceObjectId' is distinct from row_item->>'eventId'
        or observation->>'sourceRevision'
          is distinct from ('sequence:' || (row_item->>'sequence'))
        or observation->>'contentHash' is distinct from row_item->>'contentHash'
        or observation->>'capturedAt' is distinct from p_provider_manifest->>'sourceSnapshotAt'
        or observation->'normalizedPayload'->>'schemaVersion'
          is distinct from v_contract->>'observationSchemaVersion'
        or observation->'normalizedPayload'->>'capturedAt'
          is distinct from p_provider_manifest->>'sourceSnapshotAt'
        or jsonb_typeof(coalesce(observation->'normalizedPayload'->'event', 'null'::jsonb)) <> 'object'
        or observation->'normalizedPayload'->'event'->>'schemaVersion'
          is distinct from 'operator-recorded-event-v1'
        or observation->'normalizedPayload'->'event'->>'eventId'
          is distinct from row_item->>'eventId'
        or observation->'normalizedPayload'->'event'->>'sequence'
          is distinct from row_item->>'sequence'
        or not private.is_canonical_utc_millis(
          observation->'normalizedPayload'->'event'->>'recordedAt'
        )
        or observation->>'sourceRecordedAt'
          is distinct from observation->'normalizedPayload'->'event'->>'recordedAt'
        or job->'payload'->>'schemaVersion' is distinct from 'operator-extract-claims-job-v1'
        or job->'payload'->>'sourceObservationId' is distinct from row_item->>'observationId'
        or job->'payload'->>'eventId' is distinct from row_item->>'eventId'
        or job->'payload'->>'eventSequence' is distinct from row_item->>'sequence'
        or job->'payload'->>'contentHash' is distinct from row_item->>'contentHash'
        or nullif(trim(coalesce(job->'payload'->>'extractorVersion', '')), '') is null
    ) then
      raise exception 'operator events are not fully bound to observations and extraction jobs'
        using errcode = '23514';
    end if;
  end if;

  v_observation_manifest := private.source_snapshot_observation_manifest(p_observations);
  v_job_manifest := private.source_snapshot_job_manifest(p_jobs);
  v_provider_manifest_hash := encode(extensions.digest(
    convert_to(p_provider_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_observation_manifest_hash := encode(extensions.digest(
    convert_to(v_observation_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_job_manifest_hash := encode(extensions.digest(
    convert_to(v_job_manifest::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_payload_identity_hash := private.source_snapshot_payload_identity(
    v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    p_next_cursor_value, v_provider_manifest_hash,
    v_observation_manifest_hash, v_job_manifest_hash
  );
  v_batch_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'workspaceKey', v_batch.workspace_key,
    'sourceSystem', v_batch.source_system,
    'connectionKey', v_batch.connection_key,
    'expectedCursorVersion', v_batch.expected_cursor_version,
    'expectedCursorValue', v_batch.expected_cursor_value,
    'committedCursorVersion', v_batch.expected_cursor_version + 1,
    'committedCursorValue', p_next_cursor_value,
    'payloadIdentityHash', v_payload_identity_hash
  )::text, 'UTF8'), 'sha256'), 'hex');

  if v_batch.status = 'committed' then
    select * into v_existing_manifest
    from public.source_ingest_manifests
    where batch_id = p_batch_id;
    if not found
      or v_batch.batch_hash is distinct from v_batch_hash
      or v_existing_manifest.payload_identity_hash is distinct from v_payload_identity_hash
      or v_existing_manifest.provider_manifest is distinct from p_provider_manifest
      or v_existing_manifest.observation_manifest is distinct from v_observation_manifest
      or v_existing_manifest.job_manifest is distinct from v_job_manifest then
      raise exception 'source snapshot commit replay conflicts with the committed batch'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'batchId', v_batch.batch_id,
      'batchHash', v_batch.batch_hash,
      'payloadIdentityHash', v_payload_identity_hash,
      'committedCursorValue', v_batch.committed_cursor_value,
      'committedCursorVersion', v_batch.committed_cursor_version,
      'providerManifestHash', v_existing_manifest.provider_manifest_hash,
      'observationManifestHash', v_existing_manifest.observation_manifest_hash,
      'jobManifestHash', v_existing_manifest.job_manifest_hash,
      'observationCount', v_batch.observation_count,
      'jobCount', v_batch.job_count
    );
  end if;

  select * into v_recovered_manifest
  from public.source_ingest_manifests
  where payload_identity_hash = v_payload_identity_hash;
  if found then
    if v_recovered_manifest.provider_manifest is distinct from p_provider_manifest
      or v_recovered_manifest.observation_manifest is distinct from v_observation_manifest
      or v_recovered_manifest.job_manifest is distinct from v_job_manifest then
      raise exception 'source snapshot payload identity collision' using errcode = '23505';
    end if;
    select * into v_recovered_batch
    from public.source_ingest_batches
    where batch_id = v_recovered_manifest.batch_id and status = 'committed';
    if not found then
      raise exception 'source snapshot recovery manifest is not committed' using errcode = '23514';
    end if;
  end if;

  -- All source writers acquire the cursor before the batch row.
  select * into v_cursor
  from public.source_cursors
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
  for update;
  if not found
    or v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at is null
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;
  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id
  for update;
  if not found or v_batch.status <> 'running'
    or v_batch.mode not in ('snapshot', 'snapshot_recovery')
    or v_cursor.cursor_version <> v_batch.expected_cursor_version
    or v_cursor.cursor_value is distinct from v_batch.expected_cursor_value then
    raise exception 'source snapshot batch or cursor compare-and-swap failed'
      using errcode = '40001';
  end if;
  if v_cursor.cursor_kind is distinct from v_contract->>'cursorKind'
    or (
      v_batch.mode = 'snapshot' and not (
        v_cursor.status = 'live'
        or (
          v_cursor.status = 'backfill_required'
          and v_cursor.cursor_version = 0
          and v_cursor.cursor_value = ''
          and v_cursor.last_batch_id is null
        )
      )
    )
    or (
      v_batch.mode = 'snapshot_recovery'
      and v_cursor.status not in ('error', 'reconcile_required')
    ) then
    raise exception 'source snapshot cursor kind or state is invalid' using errcode = '23514';
  end if;

  -- A response-lost restart may have created a new empty batch after the prior
  -- commit advanced the cursor. Supersede only that empty batch and return the
  -- exact prior receipt; never attach the same payload to a second batch.
  if v_recovered_batch.batch_id is not null
    and v_recovered_batch.batch_id <> p_batch_id
    and v_cursor.status = 'live'
    and v_cursor.last_batch_id is not distinct from v_recovered_batch.batch_id
    and v_cursor.cursor_version is not distinct from v_recovered_batch.committed_cursor_version
    and v_cursor.cursor_value is not distinct from v_recovered_batch.committed_cursor_value then
    update public.source_ingest_batches
    set status = 'superseded',
        error_code = 'DUPLICATE_COMMITTED_PAYLOAD',
        error_detail = 'An identical committed payload already exists; exact prior receipt returned.',
        finished_at = clock_timestamp()
    where batch_id = p_batch_id;
    update public.source_cursors
    set lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp()
    where workspace_key = v_batch.workspace_key
      and source_system = v_batch.source_system
      and connection_key = v_batch.connection_key
      and lease_owner = p_owner_id and lease_fence = p_lease_fence;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'recovered', true,
      'supersededBatchId', p_batch_id,
      'batchId', v_recovered_batch.batch_id,
      'batchHash', v_recovered_batch.batch_hash,
      'payloadIdentityHash', v_payload_identity_hash,
      'committedCursorValue', v_recovered_batch.committed_cursor_value,
      'committedCursorVersion', v_recovered_batch.committed_cursor_version,
      'providerManifestHash', v_recovered_manifest.provider_manifest_hash,
      'observationManifestHash', v_recovered_manifest.observation_manifest_hash,
      'jobManifestHash', v_recovered_manifest.job_manifest_hash,
      'observationCount', v_recovered_batch.observation_count,
      'jobCount', v_recovered_batch.job_count
    );
  end if;

  if v_cursor.cursor_kind = 'operator_sequence' then
    if p_next_cursor_value !~ '^(0|[1-9][0-9]*)$'
      or length(p_next_cursor_value) > 16
      or (v_cursor.cursor_value <> '' and (
        v_cursor.cursor_value !~ '^(0|[1-9][0-9]*)$'
        or length(v_cursor.cursor_value) > 16
      )) then
      raise exception 'operator sequence cursor is not canonical' using errcode = '23514';
    end if;
    if p_next_cursor_value::numeric > 9007199254740991
      or (v_cursor.cursor_value <> ''
        and v_cursor.cursor_value::numeric > 9007199254740991)
      or p_provider_manifest->>'previousSequence'
        is distinct from coalesce(nullif(v_cursor.cursor_value, ''), '0')
      or (v_cursor.cursor_value <> ''
        and private.gmail_history_id_at_least(v_cursor.cursor_value, p_next_cursor_value)) then
      raise exception 'operator sequence must continue exactly from the locked cursor and advance'
        using errcode = '23514';
    end if;
  else
    if not private.is_canonical_utc_millis(p_next_cursor_value)
      or (v_cursor.cursor_value <> '' and (
        not private.is_canonical_utc_millis(v_cursor.cursor_value)
        or p_next_cursor_value::timestamptz <= v_cursor.cursor_value::timestamptz
      )) then
      raise exception 'source timestamp cursor is invalid or did not advance' using errcode = '23514';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_observations) item
    join public.source_observations existing
      on existing.workspace_key = v_batch.workspace_key
     and existing.source_system = v_batch.source_system
     and existing.connection_key = v_batch.connection_key
     and existing.source_object_type = item->>'sourceObjectType'
     and existing.source_object_id = item->>'sourceObjectId'
     and existing.source_revision = item->>'sourceRevision'
     and existing.operation = coalesce(item->>'operation', 'content')
    where existing.observation_id is distinct from item->>'observationId'
      or existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source snapshot coordinate conflict' using errcode = '23505';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_observations) item
    join public.source_observations existing
      on existing.observation_id = item->>'observationId'
    where existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.source_object_type is distinct from item->>'sourceObjectType'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.source_revision is distinct from item->>'sourceRevision'
      or existing.operation is distinct from coalesce(item->>'operation', 'content')
      or existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source snapshot observation identity conflict' using errcode = '23505';
  end if;

  insert into public.source_observations (
    observation_id, workspace_key, source_system, connection_key,
    source_object_type, source_object_id, source_revision, operation,
    source_cursor_version, batch_id, content_hash, source_recorded_at,
    captured_at, normalized_payload, normalized_text,
    raw_object_bucket, raw_object_key, raw_object_version, raw_object_etag,
    raw_object_hash, raw_object_bytes, raw_content_type,
    source_fidelity, schema_version, retention_class
  )
  select
    item->>'observationId', v_batch.workspace_key, v_batch.source_system,
    v_batch.connection_key, item->>'sourceObjectType', item->>'sourceObjectId',
    item->>'sourceRevision', coalesce(item->>'operation', 'content'),
    v_batch.expected_cursor_version + 1, p_batch_id, item->>'contentHash',
    nullif(item->>'sourceRecordedAt', '')::timestamptz, clock_timestamp(),
    coalesce(item->'normalizedPayload', '{}'::jsonb),
    coalesce(item->>'normalizedText', ''),
    nullif(item->'rawObject'->>'bucket', ''),
    nullif(item->'rawObject'->>'key', ''),
    nullif(item->'rawObject'->>'version', ''),
    nullif(item->'rawObject'->>'etag', ''),
    nullif(item->'rawObject'->>'hash', ''),
    nullif(item->'rawObject'->>'bytes', '')::bigint,
    nullif(item->'rawObject'->>'contentType', ''),
    coalesce(item->>'sourceFidelity', 'normalized_source'),
    item->>'schemaVersion',
    coalesce(item->>'retentionClass', 'shipment-operations')
  from jsonb_array_elements(p_observations) item
  on conflict do nothing;

  if (
    select count(*)::integer
    from jsonb_array_elements(p_observations) item
    join public.source_observations observation
      on observation.observation_id = item->>'observationId'
     and observation.batch_id = p_batch_id
     and observation.source_cursor_version = v_batch.expected_cursor_version + 1
  ) <> v_observation_count then
    raise exception 'source snapshot observation persistence is incomplete' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_jobs) item
    join public.source_processing_jobs existing
      on existing.dedupe_key = item->>'dedupeKey'
    where existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.job_kind is distinct from item->>'jobKind'
      or existing.observation_id::text is distinct from item->>'observationId'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.max_attempts is distinct from coalesce((item->>'maxAttempts')::integer, 5)
      or existing.payload is distinct from (
        coalesce(item->'payload', '{}'::jsonb) || jsonb_build_object('batchId', p_batch_id::text)
      )
  ) then
    raise exception 'source snapshot processing job identity conflict' using errcode = '23505';
  end if;
  insert into public.source_processing_jobs (
    dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, max_attempts, payload
  )
  select item->>'dedupeKey', v_batch.workspace_key, v_batch.source_system,
         v_batch.connection_key, item->>'jobKind', item->>'observationId',
         item->>'sourceObjectId', coalesce((item->>'maxAttempts')::integer, 5),
         coalesce(item->'payload', '{}'::jsonb) || jsonb_build_object('batchId', p_batch_id::text)
  from jsonb_array_elements(p_jobs) item
  on conflict (dedupe_key) do nothing;

  -- Revalidate after ON CONFLICT. Different source cursors do not share a lock,
  -- so this second statement closes the cross-source dedupe-key race.
  if exists (
    select 1
    from jsonb_array_elements(p_jobs) item
    left join public.source_processing_jobs existing
      on existing.dedupe_key = item->>'dedupeKey'
    where existing.job_id is null
      or existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.job_kind is distinct from item->>'jobKind'
      or existing.observation_id::text is distinct from item->>'observationId'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.max_attempts is distinct from coalesce((item->>'maxAttempts')::integer, 5)
      or existing.payload is distinct from (
        coalesce(item->'payload', '{}'::jsonb) || jsonb_build_object('batchId', p_batch_id::text)
      )
  ) then
    raise exception 'source snapshot processing job identity conflict after insert'
      using errcode = '23505';
  end if;

  insert into public.source_ingest_batch_jobs (batch_id, job_id, dedupe_key)
  select p_batch_id, job.job_id, job.dedupe_key
  from jsonb_array_elements(p_jobs) item
  join public.source_processing_jobs job
    on job.dedupe_key = item->>'dedupeKey'
   and job.workspace_key = v_batch.workspace_key
   and job.source_system = v_batch.source_system
   and job.connection_key = v_batch.connection_key
   and job.observation_id::text = item->>'observationId'
   and job.source_object_id = item->>'sourceObjectId'
  on conflict do nothing;
  if (
    select count(*)::integer
    from public.source_ingest_batch_jobs membership
    where membership.batch_id = p_batch_id
  ) <> v_job_count then
    raise exception 'source snapshot processing-job persistence is incomplete'
      using errcode = '23514';
  end if;

  insert into public.source_ingest_manifests (
    batch_id, workspace_key, source_system, connection_key,
    next_cursor_value, source_snapshot_at,
    provider_manifest, provider_manifest_hash,
    observation_manifest, observation_manifest_hash,
    job_manifest, job_manifest_hash, payload_identity_hash
  ) values (
    p_batch_id, v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    p_next_cursor_value, (p_provider_manifest->>'sourceSnapshotAt')::timestamptz,
    p_provider_manifest, v_provider_manifest_hash,
    v_observation_manifest, v_observation_manifest_hash,
    v_job_manifest, v_job_manifest_hash, v_payload_identity_hash
  );

  update public.source_ingest_batches
  set status = 'committed',
      committed_cursor_version = expected_cursor_version + 1,
      committed_cursor_value = p_next_cursor_value,
      batch_hash = v_batch_hash,
      page_count = 1,
      observation_count = v_observation_count,
      job_count = v_job_count,
      committed_at = clock_timestamp(),
      finished_at = clock_timestamp()
  where batch_id = p_batch_id
  returning * into v_batch;

  update public.source_cursors
  set cursor_value = p_next_cursor_value,
      cursor_version = cursor_version + 1,
      status = 'live',
      last_batch_id = p_batch_id,
      last_committed_at = clock_timestamp(),
      last_error_code = '',
      last_error_detail = '',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
    and cursor_version = v_batch.expected_cursor_version
    and cursor_value is not distinct from v_batch.expected_cursor_value;
  if not found then
    raise exception 'source snapshot cursor compare-and-swap failed' using errcode = '40001';
  end if;

  if v_batch.mode = 'snapshot_recovery' then
    insert into public.source_snapshot_failure_resolutions (
      failure_id, resolved_by_batch_id
    )
    select failure.failure_id, p_batch_id
    from public.source_snapshot_failures failure
    where failure.workspace_key = v_batch.workspace_key
      and failure.source_system = v_batch.source_system
      and failure.connection_key = v_batch.connection_key
      and not exists (
        select 1
        from public.source_snapshot_failure_resolutions resolution
        where resolution.failure_id = failure.failure_id
      )
    on conflict (failure_id) do nothing;
  end if;

  return jsonb_build_object(
    'ok', true, 'idempotent', false, 'batchId', p_batch_id,
    'batchHash', v_batch_hash, 'payloadIdentityHash', v_payload_identity_hash,
    'committedCursorValue', p_next_cursor_value,
    'committedCursorVersion', v_batch.expected_cursor_version + 1,
    'providerManifestHash', v_provider_manifest_hash,
    'observationManifestHash', v_observation_manifest_hash,
    'jobManifestHash', v_job_manifest_hash,
    'observationCount', v_observation_count, 'jobCount', v_job_count
  );
end;
$function$;

create or replace function private.fail_source_snapshot_batch(
  p_batch_id uuid,
  p_owner_id text,
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
  v_batch public.source_ingest_batches%rowtype;
  v_cursor public.source_cursors%rowtype;
  v_failure_hash text;
  v_failure_id uuid;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_batch_id is null
    or nullif(trim(coalesce(p_owner_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_error_code, '')), '') is null
    or length(p_error_code) > 100
    or nullif(trim(coalesce(p_safe_error_detail, '')), '') is null
    or length(p_safe_error_detail) > 500 then
    raise exception 'invalid source snapshot failure request' using errcode = '22023';
  end if;
  select * into v_batch from public.source_ingest_batches where batch_id = p_batch_id;
  if not found or private.source_snapshot_contract(v_batch.source_system) is null then
    raise exception 'source snapshot batch unavailable' using errcode = '40001';
  end if;
  if v_batch.status = 'failed' then
    if v_batch.error_code is distinct from p_error_code
      or v_batch.error_detail is distinct from p_safe_error_detail then
      raise exception 'source snapshot failure replay conflicts' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'batchId', v_batch.batch_id,
      'status', v_batch.status, 'cursorValue', v_batch.expected_cursor_value,
      'cursorVersion', v_batch.expected_cursor_version,
      'errorCode', v_batch.error_code
    );
  end if;
  select * into v_cursor
  from public.source_cursors
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
  for update;
  if not found
    or v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at is null
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;
  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id
  for update;
  if not found or v_batch.status <> 'running'
    or v_cursor.cursor_version <> v_batch.expected_cursor_version
    or v_cursor.cursor_value is distinct from v_batch.expected_cursor_value then
    raise exception 'source snapshot failure compare-and-swap failed' using errcode = '40001';
  end if;
  update public.source_ingest_batches
  set status = 'failed', error_code = p_error_code,
      error_detail = p_safe_error_detail, finished_at = clock_timestamp()
  where batch_id = p_batch_id
  returning * into v_batch;
  v_failure_hash := private.source_snapshot_failure_hash(
    v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    v_batch.expected_cursor_version, v_batch.expected_cursor_value,
    v_batch.batch_id, 'commit', p_error_code, p_safe_error_detail, '{}'::jsonb
  );
  insert into public.source_snapshot_failures (
    failure_hash, workspace_key, source_system, connection_key,
    cursor_version, cursor_value, batch_id, failure_stage,
    error_code, safe_error_detail, diagnostics, recorded_by
  ) values (
    v_failure_hash, v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    v_batch.expected_cursor_version, v_batch.expected_cursor_value, v_batch.batch_id,
    'commit', p_error_code, p_safe_error_detail, '{}'::jsonb, p_owner_id
  ) on conflict (failure_hash) do nothing
  returning failure_id into v_failure_id;
  if not found then
    select failure_id into v_failure_id
    from public.source_snapshot_failures
    where failure_hash = v_failure_hash;
  end if;
  update public.source_cursors
  set status = case when status = 'paused' then 'paused' else 'error' end,
      last_error_code = p_error_code,
      last_error_detail = p_safe_error_detail,
      last_batch_id = v_batch.batch_id,
      lease_owner = null, lease_expires_at = null,
      updated_at = clock_timestamp()
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
    and cursor_version = v_batch.expected_cursor_version
    and cursor_value is not distinct from v_batch.expected_cursor_value
  returning * into v_cursor;
  if not found then
    raise exception 'source snapshot failure cursor compare-and-swap failed' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'ok', true, 'idempotent', false, 'batchId', v_batch.batch_id,
    'status', v_batch.status, 'cursorValue', v_batch.expected_cursor_value,
    'cursorVersion', v_batch.expected_cursor_version,
    'cursorStatus', v_cursor.status,
    'failureId', v_failure_id,
    'failureHash', v_failure_hash,
    'errorCode', v_batch.error_code
  );
end;
$function$;

create or replace function public.record_source_snapshot_preflight_failure(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_cursor_kind text,
  p_recorded_by text,
  p_error_code text,
  p_safe_error_detail text,
  p_diagnostics jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.record_source_snapshot_preflight_failure(
    p_workspace_key, p_source_system, p_connection_key, p_cursor_kind,
    p_recorded_by, p_error_code, p_safe_error_detail, p_diagnostics, p_sync_token
  );
$function$;

create or replace function public.recover_committed_source_snapshot(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_next_cursor_value text,
  p_provider_manifest jsonb,
  p_observations jsonb,
  p_jobs jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.recover_committed_source_snapshot(
    p_workspace_key, p_source_system, p_connection_key, p_next_cursor_value,
    p_provider_manifest, p_observations, p_jobs, p_sync_token
  );
$function$;

create or replace function public.commit_source_snapshot_batch(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
  p_next_cursor_value text,
  p_provider_manifest jsonb,
  p_observations jsonb,
  p_jobs jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.commit_source_snapshot_batch(
    p_batch_id, p_owner_id, p_lease_fence, p_next_cursor_value,
    p_provider_manifest, p_observations, p_jobs, p_sync_token
  );
$function$;

create or replace function public.fail_source_snapshot_batch(
  p_batch_id uuid,
  p_owner_id text,
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
  select private.fail_source_snapshot_batch(
    p_batch_id, p_owner_id, p_lease_fence,
    p_error_code, p_safe_error_detail, p_sync_token
  );
$function$;

alter table public.source_ingest_manifests enable row level security;
alter table public.source_ingest_manifests force row level security;
alter table public.source_ingest_batch_jobs enable row level security;
alter table public.source_ingest_batch_jobs force row level security;
alter table public.source_snapshot_failures enable row level security;
alter table public.source_snapshot_failures force row level security;
alter table public.source_snapshot_failure_resolutions enable row level security;
alter table public.source_snapshot_failure_resolutions force row level security;
revoke all on public.source_ingest_manifests from public, anon, authenticated;
revoke all on public.source_ingest_batch_jobs from public, anon, authenticated;
revoke all on public.source_snapshot_failures from public, anon, authenticated;
revoke all on public.source_snapshot_failure_resolutions from public, anon, authenticated;
grant select on public.source_ingest_manifests to service_role;
grant select on public.source_ingest_batch_jobs to service_role;
grant select on public.source_snapshot_failures to service_role;
grant select on public.source_snapshot_failure_resolutions to service_role;
revoke insert, update, delete on public.source_ingest_manifests from service_role;
revoke insert, update, delete on public.source_ingest_batch_jobs from service_role;
revoke insert, update, delete on public.source_snapshot_failures from service_role;
revoke insert, update, delete on public.source_snapshot_failure_resolutions from service_role;

revoke all on function private.source_snapshot_contract(text) from public, anon, authenticated, service_role;
revoke all on function private.is_canonical_utc_millis(text) from public, anon, authenticated, service_role;
revoke all on function private.source_snapshot_observation_manifest(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.source_snapshot_job_manifest(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.source_snapshot_payload_identity(text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.tms_row_manifest_hash(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.tracking_row_manifest_hash(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.operator_event_manifest_hash(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.source_snapshot_failure_hash(text, text, text, bigint, text, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_generic_source_batch_insert() from public, anon, authenticated, service_role;
revoke all on function private.guard_generic_source_cut_cursor_insert() from public, anon, authenticated, service_role;
revoke all on function private.record_source_snapshot_preflight_failure(text, text, text, text, text, text, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.recover_committed_source_snapshot(text, text, text, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.commit_source_snapshot_batch(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function private.fail_source_snapshot_batch(uuid, text, bigint, text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function public.record_source_snapshot_preflight_failure(text, text, text, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.recover_committed_source_snapshot(text, text, text, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.commit_source_snapshot_batch(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.fail_source_snapshot_batch(uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_source_snapshot_preflight_failure(text, text, text, text, text, text, text, jsonb, text)
  to service_role;
grant execute on function public.recover_committed_source_snapshot(text, text, text, text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function public.commit_source_snapshot_batch(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function public.fail_source_snapshot_batch(uuid, text, bigint, text, text, text)
  to service_role;

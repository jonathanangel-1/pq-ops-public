create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.valid_truth_sync_token(p_sync_token text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists (
    select 1
    from public.sync_tokens
    where token_name = 'local_snapshot_writer'
      and token_hash = encode(
        extensions.digest(convert_to(p_sync_token, 'UTF8'), 'sha256'),
        'hex'
      )
  );
$function$;

revoke all on function private.valid_truth_sync_token(text) from public, anon, authenticated;

create or replace function private.gmail_history_id_at_least(
  p_candidate text,
  p_floor text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  with normalized as (
    select
      coalesce(nullif(ltrim(p_candidate, '0'), ''), '0') as candidate,
      coalesce(nullif(ltrim(p_floor, '0'), ''), '0') as floor
  )
  select p_candidate ~ '^[0-9]+$'
    and p_floor ~ '^[0-9]+$'
    and (
      length(candidate) > length(floor)
      or (length(candidate) = length(floor) and candidate >= floor)
    )
  from normalized;
$function$;

revoke all on function private.gmail_history_id_at_least(text, text) from public, anon, authenticated;

-- Immutable mailbox/source journal. This migration is additive and does not
-- change the current snapshot pipeline. Runtime cutover is separately gated.

create table if not exists public.source_cursors (
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  cursor_kind text not null,
  cursor_value text not null default '',
  cursor_version bigint not null default 0 check (cursor_version >= 0),
  status text not null default 'backfill_required'
    check (status = any (array['live', 'backfill_required', 'reconcile_required', 'paused', 'error'])),
  last_batch_id uuid,
  last_committed_at timestamptz,
  last_error_code text not null default '',
  last_error_detail text not null default '',
  lease_owner text,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_key, source_system, connection_key)
);

create table if not exists public.source_ingest_batches (
  batch_id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  mode text not null check (mode = any (array['history', 'backfill', 'reconciliation', 'snapshot'])),
  trigger_name text not null default '',
  expected_cursor_version bigint not null check (expected_cursor_version >= 0),
  expected_cursor_value text not null default '',
  committed_cursor_version bigint,
  committed_cursor_value text,
  lease_owner text not null,
  lease_fence bigint not null check (lease_fence > 0),
  status text not null default 'running'
    check (status = any (array['running', 'committed', 'failed', 'superseded'])),
  batch_hash text check (batch_hash is null or batch_hash ~ '^[0-9a-f]{64}$'),
  page_count integer not null default 0 check (page_count >= 0),
  observation_count integer not null default 0 check (observation_count >= 0),
  job_count integer not null default 0 check (job_count >= 0),
  error_code text not null default '',
  error_detail text not null default '',
  started_at timestamptz not null default now(),
  committed_at timestamptz,
  finished_at timestamptz,
  unique (workspace_key, source_system, connection_key, committed_cursor_version),
  foreign key (workspace_key, source_system, connection_key)
    references public.source_cursors (workspace_key, source_system, connection_key)
    on delete restrict
);

alter table public.source_cursors
  drop constraint if exists source_cursors_last_batch_id_fkey;
alter table public.source_cursors
  add constraint source_cursors_last_batch_id_fkey
  foreign key (last_batch_id) references public.source_ingest_batches(batch_id) on delete restrict;

create table if not exists public.gmail_ingest_pages (
  batch_id uuid not null references public.source_ingest_batches(batch_id) on delete restrict,
  page_ordinal integer not null check (page_ordinal >= 0),
  request_page_token text not null default '',
  response_next_page_token text not null default '',
  response_mailbox_history_id text not null default '',
  first_history_id text not null default '',
  last_history_id text not null default '',
  provider_response jsonb not null check (jsonb_typeof(provider_response) = 'object'),
  provider_response_hash text not null check (provider_response_hash ~ '^[0-9a-f]{64}$'),
  provider_event_manifest jsonb not null check (jsonb_typeof(provider_event_manifest) = 'array'),
  event_count integer not null default 0 check (event_count >= 0),
  job_count integer not null default 0 check (job_count >= 0),
  event_digest text not null check (event_digest ~ '^[0-9a-f]{64}$'),
  is_final boolean not null default false,
  persisted_at timestamptz not null default now(),
  primary key (batch_id, page_ordinal)
);

create table if not exists public.source_observations (
  journal_seq bigint generated always as identity unique,
  observation_id text primary key check (observation_id ~ '^obs:v1:[0-9a-f]{64}$'),
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  source_object_type text not null,
  source_object_id text not null,
  source_revision text not null default '',
  operation text not null check (operation = any (array['content', 'metadata_change', 'delete'])),
  source_cursor_version bigint not null check (source_cursor_version >= 0),
  batch_id uuid not null references public.source_ingest_batches(batch_id) on delete restrict,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_recorded_at timestamptz,
  captured_at timestamptz not null default clock_timestamp(),
  normalized_payload jsonb not null default '{}'::jsonb,
  normalized_text text not null default '',
  raw_object_bucket text,
  raw_object_key text,
  raw_object_version text,
  raw_object_etag text,
  raw_object_hash text check (raw_object_hash is null or raw_object_hash ~ '^[0-9a-f]{64}$'),
  raw_object_bytes bigint check (raw_object_bytes is null or raw_object_bytes >= 0),
  raw_content_type text,
  source_fidelity text not null default 'normalized_source'
    check (source_fidelity = any (array['raw', 'normalized_source', 'legacy_projection'])),
  schema_version text not null,
  retention_class text not null default 'shipment-operations',
  created_at timestamptz not null default now(),
  check (
    (raw_object_bucket is null and raw_object_key is null and raw_object_hash is null and raw_object_bytes is null)
    or
    (nullif(raw_object_bucket, '') is not null and nullif(raw_object_key, '') is not null
      and raw_object_hash is not null and raw_object_bytes is not null)
  ),
  unique (
    workspace_key,
    source_system,
    connection_key,
    source_object_type,
    source_object_id,
    source_revision,
    operation
  )
);

create table if not exists public.source_processing_jobs (
  job_id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  job_kind text not null,
  observation_id text references public.source_observations(observation_id) on delete restrict,
  source_object_id text not null default '',
  state text not null default 'queued'
    check (state = any (array['queued', 'leased', 'retry_wait', 'succeeded', 'dead_letter', 'superseded'])),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  last_error_code text not null default '',
  safe_error_detail text not null default '',
  processor_version text not null default '',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Page membership is explicit rather than inferred from an observation's
-- original batch or a mutable job payload. This makes page replay auditable
-- even when an observation/job was first persisted by an earlier retry.
create table if not exists public.gmail_ingest_page_observations (
  batch_id uuid not null,
  page_ordinal integer not null,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (batch_id, page_ordinal, observation_id),
  foreign key (batch_id, page_ordinal)
    references public.gmail_ingest_pages(batch_id, page_ordinal) on delete restrict
);

create table if not exists public.gmail_ingest_page_jobs (
  batch_id uuid not null,
  page_ordinal integer not null,
  job_id uuid not null references public.source_processing_jobs(job_id) on delete restrict,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, page_ordinal, job_id),
  unique (batch_id, page_ordinal, dedupe_key),
  foreign key (batch_id, page_ordinal)
    references public.gmail_ingest_pages(batch_id, page_ordinal) on delete restrict
);

create table if not exists public.gmail_completeness_gaps (
  gap_id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  connection_key text not null,
  gap_type text not null,
  prior_cursor_value text not null default '',
  recovery_anchor_value text not null default '',
  detected_at timestamptz not null default now(),
  status text not null default 'open'
    check (status = any (array['open', 'reconciled_current_mailbox', 'adjudicated', 'closed'])),
  detail jsonb not null default '{}'::jsonb,
  closed_by_gap_id uuid references public.gmail_completeness_gaps(gap_id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists source_observations_cursor_idx
  on public.source_observations (workspace_key, source_system, connection_key, source_cursor_version, journal_seq);
create index if not exists source_observations_object_idx
  on public.source_observations (source_system, source_object_type, source_object_id, source_revision);
create index if not exists source_observations_content_hash_idx
  on public.source_observations (content_hash);
create index if not exists source_observations_source_time_idx
  on public.source_observations (source_recorded_at, captured_at);
create index if not exists source_processing_jobs_claim_idx
  on public.source_processing_jobs (available_at, created_at)
  where state in ('queued', 'retry_wait');
create index if not exists source_processing_jobs_dlq_idx
  on public.source_processing_jobs (updated_at desc)
  where state = 'dead_letter';
create unique index if not exists source_ingest_batches_hash_unique
  on public.source_ingest_batches (batch_hash)
  where batch_hash is not null;
create index if not exists gmail_ingest_page_observations_observation_idx
  on public.gmail_ingest_page_observations (observation_id, batch_id, page_ordinal);
create index if not exists gmail_ingest_page_jobs_job_idx
  on public.gmail_ingest_page_jobs (job_id, batch_id, page_ordinal);
create index if not exists gmail_completeness_gaps_open_idx
  on public.gmail_completeness_gaps (detected_at desc)
  where status = 'open';

create or replace function public.reject_immutable_truth_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$function$;

drop trigger if exists source_observations_immutable on public.source_observations;
create trigger source_observations_immutable
before update or delete on public.source_observations
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists gmail_ingest_pages_immutable on public.gmail_ingest_pages;
create trigger gmail_ingest_pages_immutable
before update or delete on public.gmail_ingest_pages
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists gmail_ingest_page_observations_immutable on public.gmail_ingest_page_observations;
create trigger gmail_ingest_page_observations_immutable
before update or delete on public.gmail_ingest_page_observations
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists gmail_ingest_page_jobs_immutable on public.gmail_ingest_page_jobs;
create trigger gmail_ingest_page_jobs_immutable
before update or delete on public.gmail_ingest_page_jobs
for each row execute function public.reject_immutable_truth_mutation();

create or replace function private.acquire_source_sync_lease(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_owner_id text,
  p_ttl_seconds integer,
  p_cursor_kind text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_now timestamptz := clock_timestamp();
  v_recovery_anchor_value text := '';
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(p_owner_id), '') is null or p_ttl_seconds < 15 or p_ttl_seconds > 900 then
    raise exception 'invalid source lease request' using errcode = '22023';
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

  if p_source_system = 'gmail' and v_cursor.status = 'reconcile_required' then
    select gap.recovery_anchor_value into v_recovery_anchor_value
    from public.gmail_completeness_gaps gap
    where gap.workspace_key = p_workspace_key
      and gap.connection_key = p_connection_key
      and gap.status = 'open'
      and gap.gap_type = 'HISTORY_EXPIRED'
      and gap.prior_cursor_value = v_cursor.cursor_value
    order by gap.detected_at desc
    limit 1;
    if nullif(v_recovery_anchor_value, '') is null then
      raise exception 'reconcile-required cursor lacks an open Gmail recovery anchor' using errcode = '23514';
    end if;
  end if;

  if v_cursor.lease_expires_at is not null
    and v_cursor.lease_expires_at > v_now then
    if v_cursor.lease_owner is distinct from p_owner_id then
      return jsonb_build_object(
        'ok', false,
        'code', 'LEASE_BUSY',
        'leaseOwner', v_cursor.lease_owner,
        'leaseExpiresAt', v_cursor.lease_expires_at,
        'cursorValue', v_cursor.cursor_value,
        'cursorVersion', v_cursor.cursor_version,
        'recoveryAnchorValue', v_recovery_anchor_value,
        'status', v_cursor.status
      );
    end if;
    update public.source_cursors
    set lease_expires_at = v_now + make_interval(secs => p_ttl_seconds),
        updated_at = v_now
    where workspace_key = p_workspace_key
      and source_system = p_source_system
      and connection_key = p_connection_key
    returning * into v_cursor;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'leaseOwner', v_cursor.lease_owner,
      'leaseFence', v_cursor.lease_fence,
      'leaseExpiresAt', v_cursor.lease_expires_at,
      'cursorKind', v_cursor.cursor_kind,
      'cursorValue', v_cursor.cursor_value,
      'cursorVersion', v_cursor.cursor_version,
      'recoveryAnchorValue', v_recovery_anchor_value,
      'status', v_cursor.status
    );
  end if;

  update public.source_cursors
  set lease_owner = p_owner_id,
      lease_fence = lease_fence + 1,
      lease_expires_at = v_now + make_interval(secs => p_ttl_seconds),
      updated_at = v_now
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
  returning * into v_cursor;

  return jsonb_build_object(
    'ok', true,
    'leaseOwner', v_cursor.lease_owner,
    'leaseFence', v_cursor.lease_fence,
    'leaseExpiresAt', v_cursor.lease_expires_at,
    'cursorKind', v_cursor.cursor_kind,
    'cursorValue', v_cursor.cursor_value,
    'cursorVersion', v_cursor.cursor_version,
    'recoveryAnchorValue', v_recovery_anchor_value,
    'status', v_cursor.status
  );
end;
$function$;

create or replace function private.renew_source_sync_lease(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_owner_id text,
  p_lease_fence bigint,
  p_ttl_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 900 then
    raise exception 'invalid source lease renewal' using errcode = '22023';
  end if;
  update public.source_cursors
  set lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds),
      updated_at = clock_timestamp()
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
    and lease_owner = p_owner_id
    and lease_fence = p_lease_fence
    and lease_expires_at > clock_timestamp()
  returning * into v_cursor;
  if not found then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;
  return jsonb_build_object('ok', true, 'leaseFence', v_cursor.lease_fence, 'leaseExpiresAt', v_cursor.lease_expires_at);
end;
$function$;

create or replace function private.begin_source_ingest_batch(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_owner_id text,
  p_lease_fence bigint,
  p_mode text,
  p_trigger_name text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_resume_page_token text := '';
  v_response_mailbox_history_id text := '';
  v_final_page_persisted boolean := false;
  v_recovery_anchor_value text := '';
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_cursor
  from public.source_cursors
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
  for update;
  if not found or v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;
  if p_source_system = 'gmail' and (
    (v_cursor.status = 'backfill_required' and p_mode <> 'backfill')
    or (v_cursor.status = 'live' and p_mode <> 'history')
    or (v_cursor.status = 'reconcile_required' and p_mode <> 'reconciliation')
    or v_cursor.status in ('paused', 'error')
  ) then
    raise exception 'Gmail ingest mode is invalid for the cursor state' using errcode = '23514';
  end if;
  if p_source_system = 'gmail' and v_cursor.status = 'reconcile_required' then
    select gap.recovery_anchor_value into v_recovery_anchor_value
    from public.gmail_completeness_gaps gap
    where gap.workspace_key = p_workspace_key
      and gap.connection_key = p_connection_key
      and gap.status = 'open'
      and gap.gap_type = 'HISTORY_EXPIRED'
      and gap.prior_cursor_value = v_cursor.cursor_value
    order by gap.detected_at desc
    limit 1;
    if nullif(v_recovery_anchor_value, '') is null then
      raise exception 'Gmail reconciliation lacks an open recovery anchor' using errcode = '23514';
    end if;
  end if;

  select * into v_batch
  from public.source_ingest_batches
  where workspace_key = p_workspace_key
    and source_system = p_source_system
    and connection_key = p_connection_key
    and status = 'running'
    and expected_cursor_version = v_cursor.cursor_version
    and expected_cursor_value = v_cursor.cursor_value
  order by started_at desc
  limit 1;

  if not found then
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value, lease_owner, lease_fence
    ) values (
      p_workspace_key, p_source_system, p_connection_key, p_mode, coalesce(p_trigger_name, ''),
      v_cursor.cursor_version, v_cursor.cursor_value, p_owner_id, p_lease_fence
    ) returning * into v_batch;
  elsif v_batch.mode is distinct from p_mode then
    raise exception 'running source batch mode mismatch' using errcode = '40001';
  end if;

  select response_next_page_token, response_mailbox_history_id, is_final
  into v_resume_page_token, v_response_mailbox_history_id, v_final_page_persisted
  from public.gmail_ingest_pages
  where batch_id = v_batch.batch_id
  order by page_ordinal desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'batchId', v_batch.batch_id,
    'mode', v_batch.mode,
    'status', v_batch.status,
    'startCursorValue', v_batch.expected_cursor_value,
    'startCursorVersion', v_batch.expected_cursor_version,
    'pageCount', v_batch.page_count,
    'resumePageToken', coalesce(v_resume_page_token, ''),
    'responseMailboxHistoryId', coalesce(v_response_mailbox_history_id, ''),
    'recoveryAnchorValue', v_recovery_anchor_value,
    'finalPagePersisted', coalesce(v_final_page_persisted, false)
  );
end;
$function$;

create or replace function private.append_gmail_ingest_page(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
  p_page jsonb,
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
  v_page_ordinal integer := coalesce((p_page->>'pageOrdinal')::integer, 0);
  v_event_digest text;
  v_provider_response jsonb := coalesce(p_page->'providerResponse', 'null'::jsonb);
  v_provider_response_hash text;
  v_provider_event_manifest jsonb := coalesce(p_page->'providerEvents', 'null'::jsonb);
  v_provider_event_count integer;
  v_provider_event_distinct_count integer;
  v_observation_manifest jsonb;
  v_job_manifest jsonb;
  v_observation_input_count integer;
  v_observation_distinct_count integer;
  v_job_input_count integer;
  v_job_distinct_count integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id;
  if not found then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;

  -- Every writer takes the cursor fence before the batch row. This makes lease
  -- replacement and page append mutually exclusive and keeps the same lock
  -- order as begin/commit, avoiding a stale writer or a cursor/batch deadlock.
  select * into v_cursor
  from public.source_cursors
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
  for update;
  if not found
    or v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;

  select * into v_batch
  from public.source_ingest_batches
  where batch_id = p_batch_id
  for update;
  if not found or v_batch.status <> 'running'
    or v_batch.expected_cursor_version <> v_cursor.cursor_version
    or v_batch.expected_cursor_value is distinct from v_cursor.cursor_value then
    raise exception 'source sync lease lost or batch unavailable' using errcode = '40001';
  end if;
  if v_batch.source_system <> 'gmail' then
    raise exception 'Gmail page append requires a Gmail source batch' using errcode = '23514';
  end if;
  if coalesce(p_page->>'responseMailboxHistoryId', '') !~ '^[0-9]+$'
    or (coalesce(p_page->>'firstHistoryId', '') <> '' and coalesce(p_page->>'firstHistoryId', '') !~ '^[0-9]+$')
    or (coalesce(p_page->>'lastHistoryId', '') <> '' and coalesce(p_page->>'lastHistoryId', '') !~ '^[0-9]+$') then
    raise exception 'Gmail page contains an invalid decimal history ID' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_observations, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_jobs, '[]'::jsonb)) <> 'array' then
    raise exception 'Gmail page observations and jobs must be arrays' using errcode = '22023';
  end if;
  if jsonb_typeof(v_provider_response) <> 'object'
    or jsonb_typeof(v_provider_event_manifest) <> 'array'
    or jsonb_typeof(coalesce(v_provider_response->'history', '[]'::jsonb)) <> 'array' then
    raise exception 'Gmail page requires a provider response and event manifest' using errcode = '22023';
  end if;
  if coalesce(v_provider_response->>'historyId', '') is distinct from coalesce(p_page->>'responseMailboxHistoryId', '')
    or coalesce(v_provider_response->>'nextPageToken', '') is distinct from coalesce(p_page->>'responseNextPageToken', '') then
    raise exception 'Gmail provider response does not match page cursor metadata' using errcode = '23514';
  end if;
  select count(*)::integer, count(distinct (item->>'observationId'))::integer
  into v_observation_input_count, v_observation_distinct_count
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item;
  select count(*)::integer, count(distinct (item->>'dedupeKey'))::integer
  into v_job_input_count, v_job_distinct_count
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item;
  select count(*)::integer, count(distinct (item->>'eventId'))::integer
  into v_provider_event_count, v_provider_event_distinct_count
  from jsonb_array_elements(v_provider_event_manifest) item;
  if v_observation_input_count <> v_observation_distinct_count
    or v_job_input_count <> v_job_distinct_count
    or v_provider_event_count <> v_provider_event_distinct_count
    or v_provider_event_count <> v_observation_input_count then
    raise exception 'Gmail page contains duplicate observation or job identities' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_provider_event_manifest) event
    where jsonb_typeof(event) <> 'object'
      or coalesce(event->>'eventId', '') !~ '^gmail-event:v1:[0-9a-f]{64}$'
      or coalesce(event->>'historyId', '') !~ '^[0-9]+$'
      or not (coalesce(event->>'eventType', '') = any (array[
        'message_added', 'message_deleted', 'labels_added', 'labels_removed',
        'message_discovered'
      ]))
      or nullif(event->>'messageId', '') is null
  ) then
    raise exception 'Gmail provider event manifest is invalid' using errcode = '23514';
  end if;
  if (v_batch.mode = 'history' and exists (
    select 1 from jsonb_array_elements(v_provider_event_manifest) event
    where event->>'eventType' = 'message_discovered'
  )) or (v_batch.mode in ('backfill', 'reconciliation') and exists (
    select 1 from jsonb_array_elements(v_provider_event_manifest) event
    where event->>'eventType' <> 'message_discovered'
  )) then
    raise exception 'Gmail provider event type is invalid for the ingest mode' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_provider_event_manifest) event
    where not (
      (event->>'eventType' = 'message_discovered' and exists (
        select 1 from jsonb_array_elements(coalesce(v_provider_response->'messages', '[]'::jsonb)) message
        where message->>'id' = event->>'messageId'
      ))
      or (event->>'eventType' <> 'message_discovered' and exists (
      select 1
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      where history->>'id' = event->>'historyId'
        and case event->>'eventType'
          when 'message_added' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'messagesAdded', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          when 'message_deleted' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'messagesDeleted', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          when 'labels_added' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'labelsAdded', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          when 'labels_removed' then exists (
            select 1 from jsonb_array_elements(coalesce(history->'labelsRemoved', '[]'::jsonb)) row
            where row->'message'->>'id' = event->>'messageId'
          )
          else false
        end
      ))
    )
  ) then
    raise exception 'Gmail event manifest contains an event absent from the provider response' using errcode = '23514';
  end if;
  if exists (
    with provider_events as (
      select history->>'id' as history_id, 'message_added'::text as event_type,
             row->'message'->>'id' as message_id
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'messagesAdded', '[]'::jsonb)) row
      union
      select history->>'id', 'message_deleted', row->'message'->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'messagesDeleted', '[]'::jsonb)) row
      union
      select history->>'id', 'labels_added', row->'message'->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'labelsAdded', '[]'::jsonb)) row
      union
      select history->>'id', 'labels_removed', row->'message'->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'history', '[]'::jsonb)) history
      cross join lateral jsonb_array_elements(coalesce(history->'labelsRemoved', '[]'::jsonb)) row
      union
      select coalesce(v_provider_response->>'historyId', ''), 'message_discovered', message->>'id'
      from jsonb_array_elements(coalesce(v_provider_response->'messages', '[]'::jsonb)) message
    )
    select 1
    from provider_events provider_event
    left join jsonb_array_elements(v_provider_event_manifest) event
      on event->>'historyId' = provider_event.history_id
     and event->>'eventType' = provider_event.event_type
     and event->>'messageId' = provider_event.message_id
    where event is null
  ) then
    raise exception 'Gmail provider response contains an unmapped event' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_provider_event_manifest) event
    left join jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) observation
      on observation->'normalizedPayload'->>'eventId' = event->>'eventId'
    where observation is null
      or observation->'normalizedPayload'->>'eventType' is distinct from event->>'eventType'
      or observation->'normalizedPayload'->>'historyId' is distinct from event->>'historyId'
      or observation->'normalizedPayload'->>'messageId' is distinct from event->>'messageId'
  ) or exists (
    select 1
    from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) observation
    left join jsonb_array_elements(v_provider_event_manifest) event
      on event->>'eventId' = observation->'normalizedPayload'->>'eventId'
    where event is null
  ) then
    raise exception 'Gmail provider events are not fully mapped to observations' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_provider_event_manifest) event
    join jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) observation
      on observation->'normalizedPayload'->>'eventId' = event->>'eventId'
    where event->>'eventType' in ('message_added', 'message_discovered')
      and not exists (
        select 1 from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) job
        where job->>'jobKind' = 'gmail_fetch_raw_message'
          and job->>'observationId' = observation->>'observationId'
          and job->>'sourceObjectId' = event->>'messageId'
      )
  ) then
    raise exception 'Gmail message-added event lacks a durable raw-fetch job' using errcode = '23514';
  end if;
  v_provider_response_hash := encode(extensions.digest(
    convert_to(v_provider_response::text, 'UTF8'), 'sha256'
  ), 'hex');
  select coalesce(jsonb_agg(item - 'capturedAt' order by item->>'observationId'), '[]'::jsonb)
  into v_observation_manifest
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item;
  select coalesce(jsonb_agg(item order by item->>'dedupeKey'), '[]'::jsonb)
  into v_job_manifest
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item;
  v_event_digest := encode(extensions.digest(convert_to(jsonb_build_object(
    'pageOrdinal', v_page_ordinal,
    'requestPageToken', coalesce(p_page->>'requestPageToken', ''),
    'responseNextPageToken', coalesce(p_page->>'responseNextPageToken', ''),
    'responseMailboxHistoryId', coalesce(p_page->>'responseMailboxHistoryId', ''),
    'firstHistoryId', coalesce(p_page->>'firstHistoryId', ''),
    'lastHistoryId', coalesce(p_page->>'lastHistoryId', ''),
    'isFinal', coalesce((p_page->>'isFinal')::boolean, false),
    'providerResponseHash', v_provider_response_hash,
    'providerEvents', v_provider_event_manifest,
    'observations', v_observation_manifest,
    'jobs', v_job_manifest
  )::text, 'UTF8'), 'sha256'), 'hex');

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
    join public.source_observations existing
      on existing.workspace_key = v_batch.workspace_key
     and existing.source_system = v_batch.source_system
     and existing.connection_key = v_batch.connection_key
     and existing.source_object_type = item->>'sourceObjectType'
     and existing.source_object_id = item->>'sourceObjectId'
     and existing.source_revision = coalesce(item->>'sourceRevision', '')
     and existing.operation = coalesce(item->>'operation', 'content')
    where existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source coordinate hash conflict' using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
    join public.source_observations existing
      on existing.observation_id = item->>'observationId'
    where existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.source_object_type is distinct from item->>'sourceObjectType'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.source_revision is distinct from coalesce(item->>'sourceRevision', '')
      or existing.operation is distinct from coalesce(item->>'operation', 'content')
      or existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source observation identity conflict' using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item
    join public.source_processing_jobs existing
      on existing.dedupe_key = item->>'dedupeKey'
    where existing.workspace_key is distinct from v_batch.workspace_key
      or existing.source_system is distinct from v_batch.source_system
      or existing.connection_key is distinct from v_batch.connection_key
      or existing.job_kind is distinct from item->>'jobKind'
      or existing.source_object_id is distinct from coalesce(item->>'sourceObjectId', '')
      or existing.observation_id::text is distinct from nullif(item->>'observationId', '')
  ) then
    raise exception 'source processing job identity conflict' using errcode = '23505';
  end if;

  insert into public.gmail_ingest_pages (
    batch_id, page_ordinal, request_page_token, response_next_page_token,
    response_mailbox_history_id, first_history_id, last_history_id,
    provider_response, provider_response_hash, provider_event_manifest,
    event_count, job_count, event_digest, is_final
  ) values (
    p_batch_id,
    v_page_ordinal,
    coalesce(p_page->>'requestPageToken', ''),
    coalesce(p_page->>'responseNextPageToken', ''),
    coalesce(p_page->>'responseMailboxHistoryId', ''),
    coalesce(p_page->>'firstHistoryId', ''),
    coalesce(p_page->>'lastHistoryId', ''),
    v_provider_response,
    v_provider_response_hash,
    v_provider_event_manifest,
    v_provider_event_count,
    v_job_input_count,
    v_event_digest,
    coalesce((p_page->>'isFinal')::boolean, false)
  ) on conflict (batch_id, page_ordinal) do nothing;

  if exists (
    select 1 from public.gmail_ingest_pages
    where batch_id = p_batch_id and page_ordinal = v_page_ordinal
      and (
        request_page_token is distinct from coalesce(p_page->>'requestPageToken', '')
        or response_next_page_token is distinct from coalesce(p_page->>'responseNextPageToken', '')
        or response_mailbox_history_id is distinct from coalesce(p_page->>'responseMailboxHistoryId', '')
        or first_history_id is distinct from coalesce(p_page->>'firstHistoryId', '')
        or last_history_id is distinct from coalesce(p_page->>'lastHistoryId', '')
        or provider_response_hash is distinct from v_provider_response_hash
        or provider_event_manifest is distinct from v_provider_event_manifest
        or event_count is distinct from v_provider_event_count
        or job_count is distinct from v_job_input_count
        or event_digest is distinct from v_event_digest
        or is_final is distinct from coalesce((p_page->>'isFinal')::boolean, false)
      )
  ) then
    raise exception 'Gmail page replay conflict' using errcode = '23505';
  end if;

  insert into public.source_observations (
    observation_id, workspace_key, source_system, connection_key,
    source_object_type, source_object_id, source_revision, operation,
    source_cursor_version, batch_id, content_hash, source_recorded_at,
    captured_at, normalized_payload, normalized_text, source_fidelity,
    schema_version
  )
  select
    item->>'observationId', v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    item->>'sourceObjectType', item->>'sourceObjectId', coalesce(item->>'sourceRevision', ''),
    coalesce(item->>'operation', 'content'), v_batch.expected_cursor_version + 1,
    p_batch_id, item->>'contentHash', nullif(item->>'sourceRecordedAt', '')::timestamptz,
    clock_timestamp(),
    coalesce(item->'normalizedPayload', '{}'::jsonb), coalesce(item->>'normalizedText', ''),
    coalesce(item->>'sourceFidelity', 'normalized_source'),
    coalesce(item->>'schemaVersion', 'source-observation-v1')
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
  on conflict do nothing;

  insert into public.gmail_ingest_page_observations (
    batch_id, page_ordinal, observation_id
  )
  select p_batch_id, v_page_ordinal, existing.observation_id
  from jsonb_array_elements(coalesce(p_observations, '[]'::jsonb)) item
  join public.source_observations existing
    on existing.observation_id = item->>'observationId'
  on conflict do nothing;

  if (
    select count(*)::integer
    from public.gmail_ingest_page_observations
    where batch_id = p_batch_id and page_ordinal = v_page_ordinal
  ) <> v_observation_input_count then
    raise exception 'Gmail page observation persistence is incomplete' using errcode = '23514';
  end if;

  insert into public.source_processing_jobs (
    dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, max_attempts, payload
  )
  select
    item->>'dedupeKey', v_batch.workspace_key, v_batch.source_system, v_batch.connection_key,
    item->>'jobKind', nullif(item->>'observationId', ''), coalesce(item->>'sourceObjectId', ''),
    coalesce((item->>'maxAttempts')::integer, 5),
    jsonb_set(coalesce(item->'payload', '{}'::jsonb), '{batchId}', to_jsonb(p_batch_id::text), true)
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item
  on conflict (dedupe_key) do nothing;

  insert into public.gmail_ingest_page_jobs (
    batch_id, page_ordinal, job_id, dedupe_key
  )
  select p_batch_id, v_page_ordinal, existing.job_id, existing.dedupe_key
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) item
  join public.source_processing_jobs existing
    on existing.dedupe_key = item->>'dedupeKey'
  on conflict do nothing;

  if (
    select count(*)::integer
    from public.gmail_ingest_page_jobs
    where batch_id = p_batch_id and page_ordinal = v_page_ordinal
  ) <> v_job_input_count then
    raise exception 'Gmail page job persistence is incomplete' using errcode = '23514';
  end if;

  update public.source_ingest_batches b
  set page_count = counts.page_count,
      observation_count = counts.observation_count,
      job_count = counts.job_count
  from (
    select
      (select count(*)::integer from public.gmail_ingest_pages where batch_id = p_batch_id) as page_count,
      (select count(distinct observation_id)::integer from public.gmail_ingest_page_observations where batch_id = p_batch_id) as observation_count,
      (select count(distinct job_id)::integer from public.gmail_ingest_page_jobs where batch_id = p_batch_id) as job_count
  ) counts
  where b.batch_id = p_batch_id;

  return jsonb_build_object(
    'ok', true,
    'batchId', p_batch_id,
    'pageOrdinal', v_page_ordinal,
    'eventDigest', v_event_digest,
    'observationCount', v_observation_input_count,
    'jobCount', v_job_input_count
  );
end;
$function$;

create or replace function private.commit_source_ingest_batch(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
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
  v_page_count integer;
  v_min_page integer;
  v_max_page integer;
  v_final_count integer;
  v_next_cursor text;
  v_batch_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_batch from public.source_ingest_batches
  where batch_id = p_batch_id;
  if not found then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;
  if v_batch.status = 'committed' then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'batchId', p_batch_id,
      'batchHash', v_batch.batch_hash,
      'committedCursorValue', v_batch.committed_cursor_value,
      'committedCursorVersion', v_batch.committed_cursor_version,
      'pageCount', v_batch.page_count,
      'observationCount', v_batch.observation_count,
      'jobCount', v_batch.job_count
    );
  end if;
  if v_batch.status <> 'running' then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;
  if v_batch.source_system <> 'gmail' then
    raise exception 'Gmail batch commit requires a Gmail source batch' using errcode = '23514';
  end if;

  -- Lock the cursor before the batch, matching append and begin. The first
  -- batch read only discovers the immutable source coordinates.
  select * into v_cursor from public.source_cursors
  where workspace_key = v_batch.workspace_key
    and source_system = v_batch.source_system
    and connection_key = v_batch.connection_key
  for update;
  if v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;

  select * into v_batch from public.source_ingest_batches
  where batch_id = p_batch_id for update;
  if not found then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;
  if v_batch.status = 'committed' then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'batchId', p_batch_id,
      'batchHash', v_batch.batch_hash,
      'committedCursorValue', v_batch.committed_cursor_value,
      'committedCursorVersion', v_batch.committed_cursor_version,
      'pageCount', v_batch.page_count,
      'observationCount', v_batch.observation_count,
      'jobCount', v_batch.job_count
    );
  end if;
  if v_batch.status <> 'running' then
    raise exception 'source ingest batch unavailable' using errcode = '40001';
  end if;
  if v_cursor.cursor_version <> v_batch.expected_cursor_version
    or v_cursor.cursor_value is distinct from v_batch.expected_cursor_value then
    raise exception 'source cursor compare-and-swap failed' using errcode = '40001';
  end if;

  select count(*)::integer, min(page_ordinal), max(page_ordinal),
         count(*) filter (where is_final)::integer
  into v_page_count, v_min_page, v_max_page, v_final_count
  from public.gmail_ingest_pages where batch_id = p_batch_id;
  if v_page_count = 0 or v_min_page <> 0 or v_max_page <> v_page_count - 1 or v_final_count <> 1 then
    raise exception 'Gmail history pagination is incomplete' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.gmail_ingest_pages page
    left join public.gmail_ingest_pages previous
      on previous.batch_id = page.batch_id
     and previous.page_ordinal = page.page_ordinal - 1
    where page.batch_id = p_batch_id
      and (
        (page.page_ordinal = 0 and page.request_page_token <> '')
        or (page.page_ordinal > 0 and (
          previous.page_ordinal is null
          or page.request_page_token is distinct from previous.response_next_page_token
        ))
        or (page.is_final and page.page_ordinal <> v_max_page)
        or (page.is_final and page.response_next_page_token <> '')
        or (not page.is_final and page.response_next_page_token = '')
      )
  ) then
    raise exception 'Gmail history page-token chain is invalid' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.gmail_ingest_pages page
    where page.batch_id = p_batch_id
      and (
        page.event_count <> (
          select count(*)::integer
          from public.gmail_ingest_page_observations member
          where member.batch_id = page.batch_id and member.page_ordinal = page.page_ordinal
        )
        or page.job_count <> (
          select count(*)::integer
          from public.gmail_ingest_page_jobs member
          where member.batch_id = page.batch_id and member.page_ordinal = page.page_ordinal
        )
      )
  ) then
    raise exception 'Gmail history page persistence is incomplete' using errcode = '23514';
  end if;
  select response_mailbox_history_id into v_next_cursor
  from public.gmail_ingest_pages
  where batch_id = p_batch_id and is_final
  order by page_ordinal desc limit 1;
  if nullif(v_next_cursor, '') is null then
    raise exception 'Gmail final page lacks mailbox history id' using errcode = '23514';
  end if;
  if v_next_cursor !~ '^[0-9]+$'
    or (v_batch.expected_cursor_value <> ''
      and not private.gmail_history_id_at_least(v_next_cursor, v_batch.expected_cursor_value)) then
    raise exception 'Gmail history cursor is invalid or regressed' using errcode = '23514';
  end if;
  if v_batch.mode = 'reconciliation' and not exists (
    select 1 from public.gmail_completeness_gaps gap
    where gap.workspace_key = v_batch.workspace_key
      and gap.connection_key = v_batch.connection_key
      and gap.status = 'open'
      and gap.gap_type = 'HISTORY_EXPIRED'
      and gap.prior_cursor_value = v_batch.expected_cursor_value
      and gap.recovery_anchor_value = v_next_cursor
  ) then
    raise exception 'Gmail reconciliation batch does not match an open history gap' using errcode = '23514';
  end if;

  select encode(extensions.digest(convert_to(jsonb_build_object(
    'workspaceKey', v_batch.workspace_key,
    'sourceSystem', v_batch.source_system,
    'connectionKey', v_batch.connection_key,
    'expectedCursorVersion', v_batch.expected_cursor_version,
    'expectedCursorValue', v_batch.expected_cursor_value,
    'committedCursorVersion', v_batch.expected_cursor_version + 1,
    'committedCursorValue', v_next_cursor,
    'pageDigests', jsonb_agg(event_digest order by page_ordinal)
  )::text, 'UTF8'), 'sha256'), 'hex')
  into v_batch_hash
  from public.gmail_ingest_pages where batch_id = p_batch_id;

  update public.source_ingest_batches
  set status = 'committed',
      committed_cursor_version = expected_cursor_version + 1,
      committed_cursor_value = v_next_cursor,
      batch_hash = v_batch_hash,
      committed_at = clock_timestamp(),
      finished_at = clock_timestamp()
  where batch_id = p_batch_id
  returning * into v_batch;

  update public.source_cursors
  set cursor_value = v_next_cursor,
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
    raise exception 'source cursor compare-and-swap failed' using errcode = '40001';
  end if;

  if v_batch.mode = 'reconciliation' then
    update public.gmail_completeness_gaps
    set status = 'reconciled_current_mailbox',
        detail = detail || jsonb_build_object(
          'reconciliationBatchId', p_batch_id,
          'reconciliationBatchHash', v_batch_hash,
          'reconciledCursorValue', v_next_cursor,
          'reconciledAt', clock_timestamp()
        )
    where workspace_key = v_batch.workspace_key
      and connection_key = v_batch.connection_key
      and status = 'open'
      and gap_type = 'HISTORY_EXPIRED'
      and prior_cursor_value = v_batch.expected_cursor_value
      and recovery_anchor_value = v_next_cursor;
  end if;

  return jsonb_build_object(
    'ok', true,
    'batchId', p_batch_id,
    'batchHash', v_batch_hash,
    'committedCursorValue', v_next_cursor,
    'committedCursorVersion', v_batch.expected_cursor_version + 1,
    'pageCount', v_page_count,
    'observationCount', v_batch.observation_count,
    'jobCount', v_batch.job_count
  );
end;
$function$;

create unique index if not exists gmail_completeness_gaps_open_identity_unique
  on public.gmail_completeness_gaps (workspace_key, connection_key, gap_type, prior_cursor_value)
  where status = 'open';

create or replace function private.mark_gmail_history_expired(
  p_workspace_key text,
  p_connection_key text,
  p_owner_id text,
  p_lease_fence bigint,
  p_prior_cursor_value text,
  p_recovery_anchor_value text,
  p_detail jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cursor public.source_cursors%rowtype;
  v_gap public.gmail_completeness_gaps%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  select * into v_cursor
  from public.source_cursors
  where workspace_key = p_workspace_key
    and source_system = 'gmail'
    and connection_key = p_connection_key
  for update;
  if not found
    or v_cursor.lease_owner is distinct from p_owner_id
    or v_cursor.lease_fence <> p_lease_fence
    or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'source sync lease lost' using errcode = '40001';
  end if;
  if v_cursor.cursor_value is distinct from coalesce(p_prior_cursor_value, '') then
    raise exception 'Gmail history expiration cursor mismatch' using errcode = '40001';
  end if;
  if nullif(trim(coalesce(p_recovery_anchor_value, '')), '') is null then
    raise exception 'Gmail history expiration requires a recovery anchor' using errcode = '22023';
  end if;
  if p_prior_cursor_value !~ '^[0-9]+$'
    or p_recovery_anchor_value !~ '^[0-9]+$'
    or not private.gmail_history_id_at_least(p_recovery_anchor_value, p_prior_cursor_value) then
    raise exception 'Gmail history expiration contains an invalid or regressed cursor' using errcode = '22023';
  end if;

  insert into public.gmail_completeness_gaps (
    workspace_key, connection_key, gap_type, prior_cursor_value,
    recovery_anchor_value, detail
  ) values (
    p_workspace_key, p_connection_key, 'HISTORY_EXPIRED', v_cursor.cursor_value,
    p_recovery_anchor_value, coalesce(p_detail, '{}'::jsonb)
  ) on conflict (workspace_key, connection_key, gap_type, prior_cursor_value)
    where status = 'open' do nothing;

  select * into v_gap
  from public.gmail_completeness_gaps
  where workspace_key = p_workspace_key
    and connection_key = p_connection_key
    and gap_type = 'HISTORY_EXPIRED'
    and prior_cursor_value = v_cursor.cursor_value
    and status = 'open'
  order by detected_at desc
  limit 1;

  update public.source_ingest_batches
  set status = 'failed',
      error_code = 'HISTORY_EXPIRED',
      error_detail = 'Gmail History API no longer retains the committed cursor.',
      finished_at = clock_timestamp()
  where workspace_key = p_workspace_key
    and source_system = 'gmail'
    and connection_key = p_connection_key
    and status = 'running'
    and expected_cursor_version = v_cursor.cursor_version
    and expected_cursor_value = v_cursor.cursor_value;

  update public.source_cursors
  set status = 'reconcile_required',
      last_error_code = 'HISTORY_EXPIRED',
      last_error_detail = 'Mailbox reconciliation is required before History continuity can resume.',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where workspace_key = p_workspace_key
    and source_system = 'gmail'
    and connection_key = p_connection_key;

  return jsonb_build_object(
    'ok', true,
    'code', 'HISTORY_EXPIRED',
    'gapId', v_gap.gap_id,
    'cursorValue', v_cursor.cursor_value,
    'cursorVersion', v_cursor.cursor_version,
    'recoveryAnchorValue', p_recovery_anchor_value,
    'status', 'reconcile_required'
  );
end;
$function$;

-- PostgREST-facing wrappers remain in the exposed public schema, but they run
-- with caller privileges and delegate to tightly granted private implementations.
create or replace function public.acquire_source_sync_lease(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_owner_id text,
  p_ttl_seconds integer,
  p_cursor_kind text,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.acquire_source_sync_lease(
    p_workspace_key, p_source_system, p_connection_key, p_owner_id,
    p_ttl_seconds, p_cursor_kind, p_sync_token
  );
$function$;

create or replace function public.renew_source_sync_lease(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_owner_id text,
  p_lease_fence bigint,
  p_ttl_seconds integer,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.renew_source_sync_lease(
    p_workspace_key, p_source_system, p_connection_key, p_owner_id,
    p_lease_fence, p_ttl_seconds, p_sync_token
  );
$function$;

create or replace function public.begin_source_ingest_batch(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_owner_id text,
  p_lease_fence bigint,
  p_mode text,
  p_trigger_name text,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.begin_source_ingest_batch(
    p_workspace_key, p_source_system, p_connection_key, p_owner_id,
    p_lease_fence, p_mode, p_trigger_name, p_sync_token
  );
$function$;

create or replace function public.append_gmail_ingest_page(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
  p_page jsonb,
  p_observations jsonb,
  p_jobs jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.append_gmail_ingest_page(
    p_batch_id, p_owner_id, p_lease_fence, p_page,
    p_observations, p_jobs, p_sync_token
  );
$function$;

create or replace function public.commit_source_ingest_batch(
  p_batch_id uuid,
  p_owner_id text,
  p_lease_fence bigint,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.commit_source_ingest_batch(
    p_batch_id, p_owner_id, p_lease_fence, p_sync_token
  );
$function$;

create or replace function public.mark_gmail_history_expired(
  p_workspace_key text,
  p_connection_key text,
  p_owner_id text,
  p_lease_fence bigint,
  p_prior_cursor_value text,
  p_recovery_anchor_value text,
  p_detail jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.mark_gmail_history_expired(
    p_workspace_key, p_connection_key, p_owner_id, p_lease_fence,
    p_prior_cursor_value, p_recovery_anchor_value, p_detail, p_sync_token
  );
$function$;

alter table public.source_cursors enable row level security;
alter table public.source_ingest_batches enable row level security;
alter table public.gmail_ingest_pages enable row level security;
alter table public.source_observations enable row level security;
alter table public.source_processing_jobs enable row level security;
alter table public.gmail_ingest_page_observations enable row level security;
alter table public.gmail_ingest_page_jobs enable row level security;
alter table public.gmail_completeness_gaps enable row level security;

alter table public.source_cursors force row level security;
alter table public.source_ingest_batches force row level security;
alter table public.gmail_ingest_pages force row level security;
alter table public.source_observations force row level security;
alter table public.source_processing_jobs force row level security;
alter table public.gmail_ingest_page_observations force row level security;
alter table public.gmail_ingest_page_jobs force row level security;
alter table public.gmail_completeness_gaps force row level security;

revoke all on public.source_cursors from public, anon, authenticated;
revoke all on public.source_ingest_batches from public, anon, authenticated;
revoke all on public.gmail_ingest_pages from public, anon, authenticated;
revoke all on public.source_observations from public, anon, authenticated;
revoke all on public.source_processing_jobs from public, anon, authenticated;
revoke all on public.gmail_ingest_page_observations from public, anon, authenticated;
revoke all on public.gmail_ingest_page_jobs from public, anon, authenticated;
revoke all on public.gmail_completeness_gaps from public, anon, authenticated;

grant select, insert, update on public.source_cursors to service_role;
grant select, insert, update on public.source_ingest_batches to service_role;
grant select, insert on public.gmail_ingest_pages to service_role;
grant select, insert on public.source_observations to service_role;
grant select, insert, update on public.source_processing_jobs to service_role;
grant select, insert on public.gmail_ingest_page_observations to service_role;
grant select, insert on public.gmail_ingest_page_jobs to service_role;
grant select, insert, update on public.gmail_completeness_gaps to service_role;

-- All writes cross the fenced, token-checked RPC boundary. The service role
-- may inspect the journal directly, but cannot bypass cursor/page invariants.
revoke insert, update, delete on public.source_cursors from service_role;
revoke insert, update, delete on public.source_ingest_batches from service_role;
revoke insert, update, delete on public.gmail_ingest_pages from service_role;
revoke insert, update, delete on public.source_observations from service_role;
revoke insert, update, delete on public.source_processing_jobs from service_role;
revoke insert, update, delete on public.gmail_ingest_page_observations from service_role;
revoke insert, update, delete on public.gmail_ingest_page_jobs from service_role;
revoke insert, update, delete on public.gmail_completeness_gaps from service_role;

revoke all on function public.acquire_source_sync_lease(text, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.renew_source_sync_lease(text, text, text, text, bigint, integer, text) from public, anon, authenticated;
revoke all on function public.begin_source_ingest_batch(text, text, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.append_gmail_ingest_page(uuid, text, bigint, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.commit_source_ingest_batch(uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.mark_gmail_history_expired(text, text, text, bigint, text, text, jsonb, text) from public, anon, authenticated;

revoke all on function private.acquire_source_sync_lease(text, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function private.renew_source_sync_lease(text, text, text, text, bigint, integer, text) from public, anon, authenticated;
revoke all on function private.begin_source_ingest_batch(text, text, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function private.append_gmail_ingest_page(uuid, text, bigint, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.commit_source_ingest_batch(uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function private.mark_gmail_history_expired(text, text, text, bigint, text, text, jsonb, text) from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.acquire_source_sync_lease(text, text, text, text, integer, text, text) to service_role;
grant execute on function private.renew_source_sync_lease(text, text, text, text, bigint, integer, text) to service_role;
grant execute on function private.begin_source_ingest_batch(text, text, text, text, bigint, text, text, text) to service_role;
grant execute on function private.append_gmail_ingest_page(uuid, text, bigint, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function private.commit_source_ingest_batch(uuid, text, bigint, text) to service_role;
grant execute on function private.mark_gmail_history_expired(text, text, text, bigint, text, text, jsonb, text) to service_role;
grant execute on function public.acquire_source_sync_lease(text, text, text, text, integer, text, text) to service_role;
grant execute on function public.renew_source_sync_lease(text, text, text, text, bigint, integer, text) to service_role;
grant execute on function public.begin_source_ingest_batch(text, text, text, text, bigint, text, text, text) to service_role;
grant execute on function public.append_gmail_ingest_page(uuid, text, bigint, jsonb, jsonb, jsonb, text) to service_role;
grant execute on function public.commit_source_ingest_batch(uuid, text, bigint, text) to service_role;
grant execute on function public.mark_gmail_history_expired(text, text, text, bigint, text, text, jsonb, text) to service_role;

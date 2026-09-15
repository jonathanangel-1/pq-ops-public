-- Durable execution for source-processing jobs. Jobs may only be claimed after
-- their root ingest batch commits. Completion appends immutable observations
-- and child-job lineage in the same transaction that marks the parent done.

revoke all on schema private from public, anon, authenticated;

create table if not exists public.source_processing_job_lineage (
  job_id uuid primary key references public.source_processing_jobs(job_id) on delete restrict,
  workspace_key text not null,
  source_system text not null,
  connection_key text not null,
  root_batch_id uuid not null references public.source_ingest_batches(batch_id) on delete restrict,
  parent_job_id uuid references public.source_processing_jobs(job_id) on delete restrict,
  root_job_id uuid not null references public.source_processing_jobs(job_id) on delete restrict,
  source_cursor_version bigint not null check (source_cursor_version > 0),
  source_cursor_value text not null,
  created_at timestamptz not null default now(),
  check (parent_job_id is null or parent_job_id <> job_id),
  check (
    (parent_job_id is null and root_job_id = job_id)
    or parent_job_id is not null
  )
);

create table if not exists public.source_processing_job_observations (
  job_id uuid not null references public.source_processing_jobs(job_id) on delete restrict,
  observation_id text not null references public.source_observations(observation_id) on delete restrict,
  ordinal bigint not null check (ordinal >= 0),
  created_at timestamptz not null default now(),
  primary key (job_id, observation_id),
  unique (job_id, ordinal)
);

create table if not exists public.source_processing_job_children (
  parent_job_id uuid not null references public.source_processing_jobs(job_id) on delete restrict,
  child_job_id uuid not null references public.source_processing_jobs(job_id) on delete restrict,
  ordinal bigint not null check (ordinal >= 0),
  created_at timestamptz not null default now(),
  primary key (parent_job_id, child_job_id),
  unique (parent_job_id, ordinal),
  check (parent_job_id <> child_job_id)
);

create index if not exists source_processing_jobs_scope_claim_idx
  on public.source_processing_jobs (
    workspace_key, source_system, connection_key, available_at, created_at, job_id
  )
  where state in ('queued', 'retry_wait');

create index if not exists source_processing_jobs_expired_lease_idx
  on public.source_processing_jobs (lease_expires_at, workspace_key, source_system, connection_key)
  where state = 'leased';

create index if not exists source_processing_job_lineage_root_idx
  on public.source_processing_job_lineage (root_batch_id, root_job_id, job_id);

create index if not exists source_processing_job_lineage_parent_idx
  on public.source_processing_job_lineage (parent_job_id, job_id)
  where parent_job_id is not null;

drop trigger if exists source_processing_job_lineage_immutable
  on public.source_processing_job_lineage;
create trigger source_processing_job_lineage_immutable
before update or delete on public.source_processing_job_lineage
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists source_processing_job_observations_immutable
  on public.source_processing_job_observations;
create trigger source_processing_job_observations_immutable
before update or delete on public.source_processing_job_observations
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists source_processing_job_children_immutable
  on public.source_processing_job_children;
create trigger source_processing_job_children_immutable
before update or delete on public.source_processing_job_children
for each row execute function public.reject_immutable_truth_mutation();

-- Establish immutable lineage for any already-committed root jobs. The batch ID
-- is accepted only when it also has an immutable page membership for the job;
-- the mutable payload alone is never sufficient lineage proof.
insert into public.source_processing_job_lineage (
  job_id, workspace_key, source_system, connection_key, root_batch_id,
  parent_job_id, root_job_id, source_cursor_version, source_cursor_value
)
select distinct
  job.job_id,
  job.workspace_key,
  job.source_system,
  job.connection_key,
  batch.batch_id,
  null::uuid,
  job.job_id,
  batch.committed_cursor_version,
  batch.committed_cursor_value
from public.source_processing_jobs job
join public.source_ingest_batches batch
  on batch.batch_id::text = job.payload->>'batchId'
 and batch.workspace_key = job.workspace_key
 and batch.source_system = job.source_system
 and batch.connection_key = job.connection_key
 and batch.status = 'committed'
 and batch.committed_cursor_version is not null
 and nullif(batch.committed_cursor_value, '') is not null
left join public.gmail_ingest_page_jobs page_job
  on page_job.job_id = job.job_id
 and page_job.batch_id = batch.batch_id
left join public.source_observations anchor
  on anchor.observation_id = job.observation_id
 and anchor.workspace_key = job.workspace_key
 and anchor.source_system = job.source_system
 and anchor.connection_key = job.connection_key
 and anchor.batch_id = batch.batch_id
where (
    (job.source_system = 'gmail' and page_job.job_id is not null)
    or (job.source_system <> 'gmail' and anchor.observation_id is not null)
  )
  and (job.source_system <> 'gmail' or batch.committed_cursor_value ~ '^[0-9]+$')
on conflict (job_id) do nothing;

create or replace function private.claim_source_processing_jobs(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_worker_id text,
  p_processor_version text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_kinds text[],
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_jobs jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_source_system, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or p_limit is null or p_limit < 1 or p_limit > 50
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900
    or exists (
      select 1 from unnest(coalesce(p_job_kinds, array[]::text[])) job_kind
      where nullif(trim(job_kind), '') is null
    ) then
    raise exception 'invalid source-processing claim request' using errcode = '22023';
  end if;

  -- Expiration consumes the attempt that was leased. A final expired attempt is
  -- dead-lettered; earlier attempts become eligible for a fenced retry.
  update public.source_processing_jobs job
  set state = case
        when job.attempt_count >= job.max_attempts then 'dead_letter'
        else 'retry_wait'
      end,
      available_at = case
        when job.attempt_count >= job.max_attempts then job.available_at
        else v_now
      end,
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = 'LEASE_EXPIRED',
      safe_error_detail = 'The prior processing lease expired before acknowledgement.',
      updated_at = v_now,
      completed_at = case
        when job.attempt_count >= job.max_attempts then v_now
        else null
      end
  where job.workspace_key = p_workspace_key
    and job.source_system = p_source_system
    and job.connection_key = p_connection_key
    and job.state = 'leased'
    and (job.lease_expires_at is null or job.lease_expires_at <= v_now);

  -- Jobs appended after this migration may not have lineage until their ingest
  -- batch commits. Establish it lazily from immutable page membership.
  insert into public.source_processing_job_lineage (
    job_id, workspace_key, source_system, connection_key, root_batch_id,
    parent_job_id, root_job_id, source_cursor_version, source_cursor_value
  )
  select distinct
    job.job_id,
    job.workspace_key,
    job.source_system,
    job.connection_key,
    batch.batch_id,
    null::uuid,
    job.job_id,
    batch.committed_cursor_version,
    batch.committed_cursor_value
  from public.source_processing_jobs job
  join public.source_ingest_batches batch
    on batch.batch_id::text = job.payload->>'batchId'
   and batch.workspace_key = job.workspace_key
   and batch.source_system = job.source_system
   and batch.connection_key = job.connection_key
   and batch.status = 'committed'
   and batch.committed_cursor_version is not null
   and nullif(batch.committed_cursor_value, '') is not null
  left join public.gmail_ingest_page_jobs page_job
    on page_job.job_id = job.job_id
   and page_job.batch_id = batch.batch_id
  left join public.source_observations anchor
    on anchor.observation_id = job.observation_id
   and anchor.workspace_key = job.workspace_key
   and anchor.source_system = job.source_system
   and anchor.connection_key = job.connection_key
   and anchor.batch_id = batch.batch_id
  where job.workspace_key = p_workspace_key
    and job.source_system = p_source_system
    and job.connection_key = p_connection_key
    and not exists (
      select 1 from public.source_processing_job_lineage lineage
      where lineage.job_id = job.job_id
    )
    and (
      (job.source_system = 'gmail' and page_job.job_id is not null)
      or (job.source_system <> 'gmail' and anchor.observation_id is not null)
    )
    and (job.source_system <> 'gmail' or batch.committed_cursor_value ~ '^[0-9]+$')
  on conflict (job_id) do nothing;

  with candidates as (
    select job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.job_id = job.job_id
     and lineage.workspace_key = job.workspace_key
     and lineage.source_system = job.source_system
     and lineage.connection_key = job.connection_key
    join public.source_ingest_batches batch
      on batch.batch_id = lineage.root_batch_id
     and batch.workspace_key = lineage.workspace_key
     and batch.source_system = lineage.source_system
     and batch.connection_key = lineage.connection_key
     and batch.status = 'committed'
     and batch.committed_cursor_version = lineage.source_cursor_version
     and batch.committed_cursor_value = lineage.source_cursor_value
    where job.workspace_key = p_workspace_key
      and job.source_system = p_source_system
      and job.connection_key = p_connection_key
      and job.state in ('queued', 'retry_wait')
      and job.available_at <= v_now
      and job.attempt_count < job.max_attempts
      and (
        coalesce(cardinality(p_job_kinds), 0) = 0
        or job.job_kind = any(p_job_kinds)
      )
      and (job.source_system <> 'gmail' or lineage.source_cursor_value ~ '^[0-9]+$')
    order by job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.source_processing_jobs job
    set state = 'leased',
        attempt_count = job.attempt_count + 1,
        lease_owner = p_worker_id,
        lease_fence = job.lease_fence + 1,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        last_error_code = '',
        safe_error_detail = '',
        processor_version = p_processor_version,
        updated_at = v_now,
        completed_at = null
    from candidates
    where job.job_id = candidates.job_id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', claimed.job_id,
    'dedupeKey', claimed.dedupe_key,
    'jobKind', claimed.job_kind,
    'observationId', claimed.observation_id,
    'sourceObjectId', claimed.source_object_id,
    'attemptCount', claimed.attempt_count,
    'maxAttempts', claimed.max_attempts,
    'leaseFence', claimed.lease_fence,
    'leaseExpiresAt', claimed.lease_expires_at,
    'processorVersion', claimed.processor_version,
    'payload', claimed.payload,
    'rootBatchId', lineage.root_batch_id,
    'rootJobId', lineage.root_job_id,
    'parentJobId', lineage.parent_job_id,
    'sourceCursorVersion', lineage.source_cursor_version,
    'sourceCursorValue', lineage.source_cursor_value
  ) order by claimed.available_at, claimed.created_at, claimed.job_id), '[]'::jsonb)
  into v_jobs
  from claimed
  join public.source_processing_job_lineage lineage
    on lineage.job_id = claimed.job_id;

  return jsonb_build_object(
    'ok', true,
    'workerId', p_worker_id,
    'processorVersion', p_processor_version,
    'leaseSeconds', p_lease_seconds,
    'claimedCount', jsonb_array_length(v_jobs),
    'jobs', v_jobs
  );
end;
$function$;

create or replace function private.complete_source_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_result jsonb,
  p_observations jsonb,
  p_child_jobs jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_anchor public.source_observations%rowtype;
  v_gmail_revision text;
  v_observation_count integer;
  v_observation_distinct_count integer;
  v_coordinate_distinct_count integer;
  v_child_count integer;
  v_child_distinct_count integer;
  v_observation_manifest jsonb;
  v_child_manifest jsonb;
  v_completion_hash text;
  v_result_observation_ids jsonb;
  v_child_job_receipts jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or jsonb_typeof(coalesce(p_result, 'null'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_observations, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_child_jobs, 'null'::jsonb)) <> 'array' then
    raise exception 'invalid source-processing completion request' using errcode = '22023';
  end if;
  if p_result ?| array[
    'completionHash', 'resultObservationIds', 'childJobs',
    'rootBatchId', 'sourceCursorVersion', 'sourceCursorValue'
  ] then
    raise exception 'source-processing result contains reserved receipt fields' using errcode = '22023';
  end if;

  select * into v_job
  from public.source_processing_jobs
  where job_id = p_job_id
  for update;
  if not found then
    raise exception 'source-processing job is unavailable' using errcode = '40001';
  end if;

  select * into v_lineage
  from public.source_processing_job_lineage
  where job_id = p_job_id;
  if not found
    or v_lineage.workspace_key is distinct from v_job.workspace_key
    or v_lineage.source_system is distinct from v_job.source_system
    or v_lineage.connection_key is distinct from v_job.connection_key then
    raise exception 'source-processing job lineage is invalid' using errcode = '23514';
  end if;

  select * into v_batch
  from public.source_ingest_batches
  where batch_id = v_lineage.root_batch_id
  for share;
  if not found
    or v_batch.workspace_key is distinct from v_job.workspace_key
    or v_batch.source_system is distinct from v_job.source_system
    or v_batch.connection_key is distinct from v_job.connection_key
    or v_batch.status <> 'committed'
    or v_batch.committed_cursor_version is distinct from v_lineage.source_cursor_version
    or v_batch.committed_cursor_value is distinct from v_lineage.source_cursor_value then
    raise exception 'source-processing root batch is not committed or lineage-safe' using errcode = '23514';
  end if;

  if v_job.observation_id is not null then
    select * into v_anchor
    from public.source_observations
    where observation_id = v_job.observation_id;
    if not found
      or v_anchor.workspace_key is distinct from v_job.workspace_key
      or v_anchor.source_system is distinct from v_job.source_system
      or v_anchor.connection_key is distinct from v_job.connection_key
      or v_anchor.batch_id is distinct from v_lineage.root_batch_id
      or v_anchor.source_cursor_version is distinct from v_lineage.source_cursor_version then
      raise exception 'source-processing anchor observation is outside root lineage' using errcode = '23514';
    end if;
  end if;

  if v_job.source_system = 'gmail' then
    if v_lineage.source_cursor_value !~ '^[0-9]+$' then
      raise exception 'Gmail source-processing lineage lacks a decimal cursor' using errcode = '23514';
    end if;
    v_gmail_revision := coalesce(
      case
        when v_anchor.source_revision ~ '^[0-9]+$' then v_anchor.source_revision
        else null
      end,
      case
        when coalesce(v_anchor.normalized_payload->>'historyId', '') ~ '^[0-9]+$'
          then v_anchor.normalized_payload->>'historyId'
        else null
      end,
      v_lineage.source_cursor_value
    );
    if v_gmail_revision !~ '^[0-9]+$'
      or not private.gmail_history_id_at_least(
        v_lineage.source_cursor_value,
        v_gmail_revision
      ) then
      raise exception 'Gmail result revision is outside committed cursor lineage' using errcode = '23514';
    end if;
  end if;

  select count(*)::integer,
         count(distinct (item->>'observationId'))::integer,
         count(distinct jsonb_build_array(
           item->>'sourceObjectType', item->>'sourceObjectId',
           coalesce(nullif(item->>'sourceRevision', ''), v_gmail_revision, ''),
           coalesce(item->>'operation', 'content')
         ))::integer
  into v_observation_count, v_observation_distinct_count, v_coordinate_distinct_count
  from jsonb_array_elements(p_observations) item;

  select count(*)::integer, count(distinct (item->>'dedupeKey'))::integer
  into v_child_count, v_child_distinct_count
  from jsonb_array_elements(p_child_jobs) item;

  if v_observation_count <> v_observation_distinct_count
    or v_observation_count <> v_coordinate_distinct_count
    or v_child_count <> v_child_distinct_count then
    raise exception 'source-processing result contains duplicate identities' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_observations) item
    where jsonb_typeof(item) <> 'object'
      or coalesce(item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
      or nullif(trim(coalesce(item->>'sourceObjectType', '')), '') is null
      or nullif(trim(coalesce(item->>'sourceObjectId', '')), '') is null
      or not (coalesce(item->>'operation', 'content') = any(array[
        'content', 'metadata_change', 'delete'
      ]))
      or coalesce(item->>'contentHash', '') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(coalesce(item->'normalizedPayload', '{}'::jsonb)) <> 'object'
      or not (coalesce(item->>'sourceFidelity', 'normalized_source') = any(array[
        'raw', 'normalized_source'
      ]))
      or nullif(trim(coalesce(item->>'schemaVersion', '')), '') is null
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
          or (
            item->'rawObject' ? 'version'
            and jsonb_typeof(item->'rawObject'->'version') not in ('string', 'null')
          )
          or (
            item->'rawObject' ? 'etag'
            and jsonb_typeof(item->'rawObject'->'etag') not in ('string', 'null')
          )
        )
      )
      or (
        v_job.source_system = 'gmail'
        and coalesce(nullif(item->>'sourceRevision', ''), v_gmail_revision)
          is distinct from v_gmail_revision
      )
  ) then
    raise exception 'source-processing result observation is invalid' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_child_jobs) item
    where jsonb_typeof(item) <> 'object'
      or nullif(trim(coalesce(item->>'dedupeKey', '')), '') is null
      or nullif(trim(coalesce(item->>'jobKind', '')), '') is null
      or coalesce(item->>'observationId', '') !~ '^obs:v1:[0-9a-f]{64}$'
      or nullif(trim(coalesce(item->>'sourceObjectId', '')), '') is null
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
    raise exception 'source-processing child job is invalid' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(item - 'capturedAt' order by item->>'observationId'), '[]'::jsonb)
  into v_observation_manifest
  from jsonb_array_elements(p_observations) item;
  select coalesce(jsonb_agg(item order by item->>'dedupeKey'), '[]'::jsonb)
  into v_child_manifest
  from jsonb_array_elements(p_child_jobs) item;
  v_completion_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'jobId', p_job_id,
    'leaseFence', p_lease_fence,
    'processorVersion', p_processor_version,
    'result', p_result,
    'observations', v_observation_manifest,
    'childJobs', v_child_manifest,
    'rootBatchId', v_lineage.root_batch_id,
    'sourceCursorVersion', v_lineage.source_cursor_version,
    'sourceCursorValue', v_lineage.source_cursor_value
  )::text, 'UTF8'), 'sha256'), 'hex');

  if v_job.state = 'succeeded' then
    if v_job.lease_fence = p_lease_fence
      and v_job.processor_version = p_processor_version
      and v_job.result->>'completionHash' = v_completion_hash then
      return jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'jobId', v_job.job_id,
        'state', v_job.state,
        'leaseFence', v_job.lease_fence,
        'completionHash', v_completion_hash,
        'resultObservationIds', coalesce(v_job.result->'resultObservationIds', '[]'::jsonb),
        'childJobs', coalesce(v_job.result->'childJobs', '[]'::jsonb),
        'rootBatchId', v_lineage.root_batch_id
      );
    end if;
    raise exception 'source-processing completion conflicts with committed result' using errcode = '23505';
  end if;

  if v_job.state <> 'leased'
    or v_job.lease_owner is distinct from p_worker_id
    or v_job.lease_fence <> p_lease_fence
    or v_job.lease_expires_at is null
    or v_job.lease_expires_at <= v_now
    or v_job.processor_version is distinct from p_processor_version then
    raise exception 'source-processing lease lost' using errcode = '40001';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_observations) item
    join public.source_observations existing
      on existing.workspace_key = v_job.workspace_key
     and existing.source_system = v_job.source_system
     and existing.connection_key = v_job.connection_key
     and existing.source_object_type = item->>'sourceObjectType'
     and existing.source_object_id = item->>'sourceObjectId'
     and existing.source_revision = case
       when v_job.source_system = 'gmail' then v_gmail_revision
       else coalesce(item->>'sourceRevision', '')
     end
     and existing.operation = coalesce(item->>'operation', 'content')
    where existing.observation_id is distinct from item->>'observationId'
       or existing.content_hash is distinct from item->>'contentHash'
  ) then
    raise exception 'source-processing result coordinate conflict' using errcode = '23505';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_observations) item
    join public.source_observations existing
      on existing.observation_id = item->>'observationId'
    where existing.workspace_key is distinct from v_job.workspace_key
      or existing.source_system is distinct from v_job.source_system
      or existing.connection_key is distinct from v_job.connection_key
      or existing.source_object_type is distinct from item->>'sourceObjectType'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.source_revision is distinct from case
        when v_job.source_system = 'gmail' then v_gmail_revision
        else coalesce(item->>'sourceRevision', '')
      end
      or existing.operation is distinct from coalesce(item->>'operation', 'content')
      or existing.source_cursor_version is distinct from v_lineage.source_cursor_version
      or existing.batch_id is distinct from v_lineage.root_batch_id
      or existing.content_hash is distinct from item->>'contentHash'
      or existing.source_recorded_at is distinct from nullif(item->>'sourceRecordedAt', '')::timestamptz
      or existing.normalized_payload is distinct from coalesce(item->'normalizedPayload', '{}'::jsonb)
      or existing.normalized_text is distinct from coalesce(item->>'normalizedText', '')
      or existing.raw_object_bucket is distinct from nullif(item->'rawObject'->>'bucket', '')
      or existing.raw_object_key is distinct from nullif(item->'rawObject'->>'key', '')
      or existing.raw_object_version is distinct from nullif(item->'rawObject'->>'version', '')
      or existing.raw_object_etag is distinct from nullif(item->'rawObject'->>'etag', '')
      or existing.raw_object_hash is distinct from nullif(item->'rawObject'->>'hash', '')
      or existing.raw_object_bytes is distinct from nullif(item->'rawObject'->>'bytes', '')::bigint
      or existing.raw_content_type is distinct from nullif(item->'rawObject'->>'contentType', '')
      or existing.source_fidelity is distinct from coalesce(item->>'sourceFidelity', 'normalized_source')
      or existing.schema_version is distinct from item->>'schemaVersion'
      or existing.retention_class is distinct from coalesce(item->>'retentionClass', 'shipment-operations')
  ) then
    raise exception 'source-processing observation identity conflict' using errcode = '23505';
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
    item->>'observationId',
    v_job.workspace_key,
    v_job.source_system,
    v_job.connection_key,
    item->>'sourceObjectType',
    item->>'sourceObjectId',
    case
      when v_job.source_system = 'gmail' then v_gmail_revision
      else coalesce(item->>'sourceRevision', '')
    end,
    coalesce(item->>'operation', 'content'),
    v_lineage.source_cursor_version,
    v_lineage.root_batch_id,
    item->>'contentHash',
    nullif(item->>'sourceRecordedAt', '')::timestamptz,
    v_now,
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

  insert into public.source_processing_job_observations (
    job_id, observation_id, ordinal
  )
  select p_job_id, existing.observation_id,
         row_number() over (order by existing.observation_id) - 1
  from jsonb_array_elements(p_observations) item
  join public.source_observations existing
    on existing.observation_id = item->>'observationId'
  on conflict do nothing;

  if (
    select count(*)::integer
    from public.source_processing_job_observations membership
    where membership.job_id = p_job_id
  ) <> v_observation_count then
    raise exception 'source-processing result observation persistence is incomplete' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_child_jobs) item
    left join public.source_observations anchor
      on anchor.observation_id = item->>'observationId'
    where anchor.observation_id is null
      or anchor.workspace_key is distinct from v_job.workspace_key
      or anchor.source_system is distinct from v_job.source_system
      or anchor.connection_key is distinct from v_job.connection_key
      or anchor.batch_id is distinct from v_lineage.root_batch_id
      or anchor.source_cursor_version is distinct from v_lineage.source_cursor_version
  ) then
    raise exception 'source-processing child anchor is outside root lineage' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_child_jobs) item
    join public.source_processing_jobs existing
      on existing.dedupe_key = item->>'dedupeKey'
    left join public.source_processing_job_lineage child_lineage
      on child_lineage.job_id = existing.job_id
    where existing.workspace_key is distinct from v_job.workspace_key
      or existing.source_system is distinct from v_job.source_system
      or existing.connection_key is distinct from v_job.connection_key
      or existing.job_kind is distinct from item->>'jobKind'
      or existing.observation_id::text is distinct from item->>'observationId'
      or existing.source_object_id is distinct from item->>'sourceObjectId'
      or existing.max_attempts is distinct from coalesce((item->>'maxAttempts')::integer, 5)
      or existing.payload is distinct from (
        coalesce(item->'payload', '{}'::jsonb) || jsonb_build_object(
          'batchId', v_lineage.root_batch_id::text,
          'rootBatchId', v_lineage.root_batch_id,
          'rootJobId', v_lineage.root_job_id,
          'parentJobId', p_job_id
        )
      )
      or child_lineage.job_id is null
      or child_lineage.root_batch_id is distinct from v_lineage.root_batch_id
      or child_lineage.root_job_id is distinct from v_lineage.root_job_id
      or child_lineage.parent_job_id is distinct from p_job_id
      or child_lineage.source_cursor_version is distinct from v_lineage.source_cursor_version
      or child_lineage.source_cursor_value is distinct from v_lineage.source_cursor_value
  ) then
    raise exception 'source-processing child job identity conflict' using errcode = '23505';
  end if;

  insert into public.source_processing_jobs (
    dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, max_attempts, payload
  )
  select
    item->>'dedupeKey',
    v_job.workspace_key,
    v_job.source_system,
    v_job.connection_key,
    item->>'jobKind',
    item->>'observationId',
    item->>'sourceObjectId',
    coalesce((item->>'maxAttempts')::integer, 5),
    coalesce(item->'payload', '{}'::jsonb) || jsonb_build_object(
      'batchId', v_lineage.root_batch_id::text,
      'rootBatchId', v_lineage.root_batch_id,
      'rootJobId', v_lineage.root_job_id,
      'parentJobId', p_job_id
    )
  from jsonb_array_elements(p_child_jobs) item
  on conflict (dedupe_key) do nothing;

  insert into public.source_processing_job_lineage (
    job_id, workspace_key, source_system, connection_key, root_batch_id,
    parent_job_id, root_job_id, source_cursor_version, source_cursor_value
  )
  select
    child.job_id,
    v_job.workspace_key,
    v_job.source_system,
    v_job.connection_key,
    v_lineage.root_batch_id,
    p_job_id,
    v_lineage.root_job_id,
    v_lineage.source_cursor_version,
    v_lineage.source_cursor_value
  from jsonb_array_elements(p_child_jobs) item
  join public.source_processing_jobs child
    on child.dedupe_key = item->>'dedupeKey'
  on conflict (job_id) do nothing;

  -- Recheck after the inserts so a concurrent dedupe-key winner cannot attach
  -- this parent to a child created under different lineage.
  if exists (
    select 1
    from jsonb_array_elements(p_child_jobs) item
    join public.source_processing_jobs child
      on child.dedupe_key = item->>'dedupeKey'
    left join public.source_processing_job_lineage child_lineage
      on child_lineage.job_id = child.job_id
    where child.workspace_key is distinct from v_job.workspace_key
      or child.source_system is distinct from v_job.source_system
      or child.connection_key is distinct from v_job.connection_key
      or child.job_kind is distinct from item->>'jobKind'
      or child.observation_id::text is distinct from item->>'observationId'
      or child.source_object_id is distinct from item->>'sourceObjectId'
      or child.max_attempts is distinct from coalesce((item->>'maxAttempts')::integer, 5)
      or child.payload is distinct from (
        coalesce(item->'payload', '{}'::jsonb) || jsonb_build_object(
          'batchId', v_lineage.root_batch_id::text,
          'rootBatchId', v_lineage.root_batch_id,
          'rootJobId', v_lineage.root_job_id,
          'parentJobId', p_job_id
        )
      )
      or child_lineage.job_id is null
      or child_lineage.workspace_key is distinct from v_job.workspace_key
      or child_lineage.source_system is distinct from v_job.source_system
      or child_lineage.connection_key is distinct from v_job.connection_key
      or child_lineage.root_batch_id is distinct from v_lineage.root_batch_id
      or child_lineage.root_job_id is distinct from v_lineage.root_job_id
      or child_lineage.parent_job_id is distinct from p_job_id
      or child_lineage.source_cursor_version is distinct from v_lineage.source_cursor_version
      or child_lineage.source_cursor_value is distinct from v_lineage.source_cursor_value
  ) then
    raise exception 'source-processing child job lineage conflict' using errcode = '23505';
  end if;

  insert into public.source_processing_job_children (
    parent_job_id, child_job_id, ordinal
  )
  select p_job_id, child.job_id,
         row_number() over (order by child.dedupe_key) - 1
  from jsonb_array_elements(p_child_jobs) item
  join public.source_processing_jobs child
    on child.dedupe_key = item->>'dedupeKey'
  on conflict do nothing;

  if (
    select count(*)::integer
    from public.source_processing_job_children membership
    where membership.parent_job_id = p_job_id
  ) <> v_child_count then
    raise exception 'source-processing child-job persistence is incomplete' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(membership.observation_id order by membership.ordinal), '[]'::jsonb)
  into v_result_observation_ids
  from public.source_processing_job_observations membership
  where membership.job_id = p_job_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', child.job_id,
    'dedupeKey', child.dedupe_key,
    'jobKind', child.job_kind,
    'observationId', child.observation_id
  ) order by membership.ordinal), '[]'::jsonb)
  into v_child_job_receipts
  from public.source_processing_job_children membership
  join public.source_processing_jobs child
    on child.job_id = membership.child_job_id
  where membership.parent_job_id = p_job_id;

  update public.source_processing_jobs
  set state = 'succeeded',
      lease_owner = null,
      lease_expires_at = null,
      result = p_result || jsonb_build_object(
        'completionHash', v_completion_hash,
        'resultObservationIds', v_result_observation_ids,
        'childJobs', v_child_job_receipts,
        'rootBatchId', v_lineage.root_batch_id,
        'sourceCursorVersion', v_lineage.source_cursor_version,
        'sourceCursorValue', v_lineage.source_cursor_value
      ),
      updated_at = v_now,
      completed_at = v_now
  where job_id = p_job_id
    and state = 'leased'
    and lease_owner = p_worker_id
    and lease_fence = p_lease_fence
    and lease_expires_at > v_now
    and processor_version = p_processor_version
  returning * into v_job;
  if not found then
    raise exception 'source-processing lease lost' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'jobId', v_job.job_id,
    'state', v_job.state,
    'attemptCount', v_job.attempt_count,
    'leaseFence', v_job.lease_fence,
    'completionHash', v_completion_hash,
    'resultObservationIds', v_result_observation_ids,
    'childJobs', v_child_job_receipts,
    'rootBatchId', v_lineage.root_batch_id,
    'sourceCursorVersion', v_lineage.source_cursor_version,
    'sourceCursorValue', v_lineage.source_cursor_value
  );
end;
$function$;

create or replace function private.fail_source_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_error_code text,
  p_safe_error_detail text,
  p_retry_after_seconds integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_job public.source_processing_jobs%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_batch public.source_ingest_batches%rowtype;
  v_backoff_seconds integer;
  v_next_state text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null
    or nullif(trim(coalesce(p_error_code, '')), '') is null
    or length(p_error_code) > 100
    or length(coalesce(p_safe_error_detail, '')) > 2000
    or p_retry_after_seconds is not null
      and (p_retry_after_seconds < 1 or p_retry_after_seconds > 86400) then
    raise exception 'invalid source-processing failure request' using errcode = '22023';
  end if;

  select * into v_job
  from public.source_processing_jobs
  where job_id = p_job_id
  for update;
  if not found then
    raise exception 'source-processing job is unavailable' using errcode = '40001';
  end if;

  select * into v_lineage
  from public.source_processing_job_lineage
  where job_id = p_job_id;
  select * into v_batch
  from public.source_ingest_batches
  where batch_id = v_lineage.root_batch_id
  for share;
  if v_lineage.job_id is null
    or v_lineage.workspace_key is distinct from v_job.workspace_key
    or v_lineage.source_system is distinct from v_job.source_system
    or v_lineage.connection_key is distinct from v_job.connection_key
    or v_batch.batch_id is null
    or v_batch.workspace_key is distinct from v_job.workspace_key
    or v_batch.source_system is distinct from v_job.source_system
    or v_batch.connection_key is distinct from v_job.connection_key
    or v_batch.status <> 'committed'
    or v_batch.committed_cursor_version is distinct from v_lineage.source_cursor_version
    or v_batch.committed_cursor_value is distinct from v_lineage.source_cursor_value
    or (v_job.source_system = 'gmail' and v_lineage.source_cursor_value !~ '^[0-9]+$') then
    raise exception 'source-processing failure lineage is invalid' using errcode = '23514';
  end if;

  if v_job.state in ('retry_wait', 'dead_letter')
    and v_job.lease_fence = p_lease_fence
    and v_job.processor_version = p_processor_version
    and v_job.last_error_code = p_error_code then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'jobId', v_job.job_id,
      'state', v_job.state,
      'attemptCount', v_job.attempt_count,
      'maxAttempts', v_job.max_attempts,
      'leaseFence', v_job.lease_fence,
      'availableAt', v_job.available_at,
      'completedAt', v_job.completed_at
    );
  end if;

  if v_job.state <> 'leased'
    or v_job.lease_owner is distinct from p_worker_id
    or v_job.lease_fence <> p_lease_fence
    or v_job.lease_expires_at is null
    or v_job.lease_expires_at <= v_now
    or v_job.processor_version is distinct from p_processor_version then
    raise exception 'source-processing lease lost' using errcode = '40001';
  end if;

  v_next_state := case
    when v_job.attempt_count >= v_job.max_attempts then 'dead_letter'
    else 'retry_wait'
  end;
  v_backoff_seconds := least(86400, greatest(
    coalesce(p_retry_after_seconds, 1),
    least(21600, (30 * power(
      2::numeric,
      least(greatest(v_job.attempt_count - 1, 0), 10)
    ))::integer)
  ));

  update public.source_processing_jobs
  set state = v_next_state,
      available_at = case
        when v_next_state = 'retry_wait' then v_now + make_interval(secs => v_backoff_seconds)
        else available_at
      end,
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = p_error_code,
      safe_error_detail = coalesce(p_safe_error_detail, ''),
      updated_at = v_now,
      completed_at = case when v_next_state = 'dead_letter' then v_now else null end
  where job_id = p_job_id
    and state = 'leased'
    and lease_owner = p_worker_id
    and lease_fence = p_lease_fence
    and lease_expires_at > v_now
    and processor_version = p_processor_version
  returning * into v_job;
  if not found then
    raise exception 'source-processing lease lost' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'jobId', v_job.job_id,
    'state', v_job.state,
    'attemptCount', v_job.attempt_count,
    'maxAttempts', v_job.max_attempts,
    'leaseFence', v_job.lease_fence,
    'backoffSeconds', case when v_job.state = 'retry_wait' then v_backoff_seconds else null end,
    'availableAt', v_job.available_at,
    'completedAt', v_job.completed_at
  );
end;
$function$;

-- PostgREST-facing wrappers run with caller privileges. Only service_role may
-- invoke them, and it may reach the private definer implementations solely via
-- the explicit grants at the end of this migration.
create or replace function public.claim_source_processing_jobs(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_worker_id text,
  p_processor_version text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_kinds text[],
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.claim_source_processing_jobs(
    p_workspace_key, p_source_system, p_connection_key, p_worker_id,
    p_processor_version, p_limit, p_lease_seconds, p_job_kinds, p_sync_token
  );
$function$;

create or replace function public.complete_source_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_result jsonb,
  p_observations jsonb,
  p_child_jobs jsonb,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.complete_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    p_result, p_observations, p_child_jobs, p_sync_token
  );
$function$;

create or replace function public.fail_source_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_error_code text,
  p_safe_error_detail text,
  p_retry_after_seconds integer,
  p_sync_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.fail_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    p_error_code, p_safe_error_detail, p_retry_after_seconds, p_sync_token
  );
$function$;

alter table public.source_processing_job_lineage enable row level security;
alter table public.source_processing_job_observations enable row level security;
alter table public.source_processing_job_children enable row level security;
alter table public.source_processing_job_lineage force row level security;
alter table public.source_processing_job_observations force row level security;
alter table public.source_processing_job_children force row level security;

revoke all on public.source_processing_job_lineage from public, anon, authenticated;
revoke all on public.source_processing_job_observations from public, anon, authenticated;
revoke all on public.source_processing_job_children from public, anon, authenticated;
grant select on public.source_processing_job_lineage to service_role;
grant select on public.source_processing_job_observations to service_role;
grant select on public.source_processing_job_children to service_role;
revoke insert, update, delete on public.source_processing_job_lineage from service_role;
revoke insert, update, delete on public.source_processing_job_observations from service_role;
revoke insert, update, delete on public.source_processing_job_children from service_role;

revoke all on function private.claim_source_processing_jobs(text, text, text, text, text, integer, integer, text[], text)
  from public, anon, authenticated;
revoke all on function private.complete_source_processing_job(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function private.fail_source_processing_job(uuid, text, bigint, text, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.claim_source_processing_jobs(text, text, text, text, text, integer, integer, text[], text)
  from public, anon, authenticated;
revoke all on function public.complete_source_processing_job(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.fail_source_processing_job(uuid, text, bigint, text, text, text, integer, text)
  from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.claim_source_processing_jobs(text, text, text, text, text, integer, integer, text[], text)
  to service_role;
grant execute on function private.complete_source_processing_job(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function private.fail_source_processing_job(uuid, text, bigint, text, text, text, integer, text)
  to service_role;
grant execute on function public.claim_source_processing_jobs(text, text, text, text, text, integer, integer, text[], text)
  to service_role;
grant execute on function public.complete_source_processing_job(uuid, text, bigint, text, jsonb, jsonb, jsonb, text)
  to service_role;
grant execute on function public.fail_source_processing_job(uuid, text, bigint, text, text, text, integer, text)
  to service_role;

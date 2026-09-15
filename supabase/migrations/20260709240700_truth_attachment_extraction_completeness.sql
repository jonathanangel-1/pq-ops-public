-- Unreadable Gmail attachments are source-completeness gaps, not successful
-- no-op jobs. This follow-on migration makes every incomplete extraction a
-- durable review/replay child, blocks new source cuts until exact resolution,
-- and exposes the unresolved inventory to the read-only audit witness across
-- later Gmail batches.

create unique index if not exists source_processing_jobs_workspace_job_uidx
  on public.source_processing_jobs (workspace_key, job_id);

create table if not exists public.gmail_attachment_extraction_resolutions (
  resolution_id text primary key
    check (resolution_id ~ '^attachment-resolution:v1:[0-9a-f]{64}$'),
  workspace_key text not null
    references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null,
  attachment_observation_id text not null,
  attachment_content_hash text not null
    check (attachment_content_hash ~ '^[0-9a-f]{64}$'),
  review_job_id uuid not null,
  decision text not null check (decision = any (array[
    'reviewed_non_operational',
    'operational_evidence_recorded'
  ])),
  resolution_evidence_observation_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(resolution_evidence_observation_ids) = 'array'),
  decided_by text not null,
  reason text not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null unique check (request_hash ~ '^[0-9a-f]{64}$'),
  canonical_request jsonb not null check (jsonb_typeof(canonical_request) = 'object'),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  canonical_receipt jsonb not null check (jsonb_typeof(canonical_receipt) = 'object'),
  schema_version text not null default 'gmail-attachment-extraction-resolution-v1',
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, attachment_observation_id),
  unique (workspace_key, idempotency_key_hash),
  foreign key (workspace_key, attachment_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, review_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  check (resolution_id = 'attachment-resolution:v1:' || request_hash),
  check (
    (decision = 'reviewed_non_operational'
      and jsonb_array_length(resolution_evidence_observation_ids) = 0)
    or
    (decision = 'operational_evidence_recorded'
      and jsonb_array_length(resolution_evidence_observation_ids) > 0)
  )
);

create index if not exists gmail_attachment_extraction_resolutions_target_idx
  on public.gmail_attachment_extraction_resolutions (
    workspace_key, connection_key, attachment_observation_id, created_at desc
  );

drop trigger if exists gmail_attachment_extraction_resolutions_immutable
  on public.gmail_attachment_extraction_resolutions;
create trigger gmail_attachment_extraction_resolutions_immutable
before update or delete on public.gmail_attachment_extraction_resolutions
for each row execute function public.reject_immutable_truth_mutation();

alter table public.gmail_attachment_extraction_resolutions enable row level security;
alter table public.gmail_attachment_extraction_resolutions force row level security;
revoke all on table public.gmail_attachment_extraction_resolutions
  from public, anon, authenticated;
grant select on table public.gmail_attachment_extraction_resolutions to service_role;
revoke insert, update, delete, truncate
  on table public.gmail_attachment_extraction_resolutions from service_role;

-- Backfill the review child that the v1 worker omitted. The immutable extracted
-- observation and its parent-job lineage are sufficient to reconstruct the
-- same review target without touching Gmail or raw object bytes.
with incomplete as (
  select
    parent.job_id as parent_job_id,
    parent.workspace_key,
    parent.source_system,
    parent.connection_key,
    parent.source_object_id,
    observation.observation_id,
    observation.content_hash,
    observation.normalized_payload,
    lineage.root_batch_id,
    lineage.root_job_id,
    lineage.source_cursor_version,
    lineage.source_cursor_value,
    'gmail:review-attachment-extraction:backfill:v1:' || encode(
      extensions.digest(convert_to(jsonb_build_object(
        'observationId', observation.observation_id,
        'contentHash', observation.content_hash
      )::text, 'UTF8'), 'sha256'),
      'hex'
    ) as dedupe_key
  from public.source_processing_jobs parent
  join public.source_processing_job_observations output
    on output.job_id = parent.job_id
  join public.source_observations observation
    on observation.observation_id = output.observation_id
   and observation.workspace_key = parent.workspace_key
   and observation.source_system = parent.source_system
   and observation.connection_key = parent.connection_key
  join public.source_processing_job_lineage lineage
    on lineage.job_id = parent.job_id
   and lineage.workspace_key = parent.workspace_key
   and lineage.source_system = parent.source_system
   and lineage.connection_key = parent.connection_key
  where parent.source_system = 'gmail'
    and parent.job_kind = 'gmail_extract_attachment'
    and parent.state = 'succeeded'
    and observation.source_object_type = 'gmail_attachment_extracted'
    and observation.normalized_payload->>'schemaVersion' = 'gmail-attachment-extracted-v1'
    and (
      observation.normalized_payload->'extraction'->>'status' <> 'extracted'
      or coalesce(
        (observation.normalized_payload->'extraction'->>'reviewRequired')::boolean,
        true
      )
    )
    and not exists (
      select 1
      from public.source_processing_job_children existing_link
      join public.source_processing_jobs existing_child
        on existing_child.job_id = existing_link.child_job_id
       and existing_child.job_kind = 'gmail_review_attachment_extraction'
       and existing_child.observation_id = observation.observation_id
      where existing_link.parent_job_id = parent.job_id
    )
), inserted_jobs as (
  insert into public.source_processing_jobs (
    dedupe_key, workspace_key, source_system, connection_key, job_kind,
    observation_id, source_object_id, max_attempts, payload
  )
  select
    incomplete.dedupe_key,
    incomplete.workspace_key,
    incomplete.source_system,
    incomplete.connection_key,
    'gmail_review_attachment_extraction',
    incomplete.observation_id,
    incomplete.normalized_payload->>'attachmentId',
    5,
    jsonb_build_object(
      'schemaVersion', 'gmail-review-attachment-extraction-job-v1',
      'attachmentObservationId', incomplete.observation_id,
      'attachmentObservationContentHash', incomplete.content_hash,
      'attachmentId', incomplete.normalized_payload->>'attachmentId',
      'messageId', incomplete.normalized_payload->'gmail'->>'messageId',
      'threadId', coalesce(incomplete.normalized_payload->'gmail'->>'threadId', ''),
      'historyId', incomplete.normalized_payload->'gmail'->>'historyId',
      'parentObservationId', incomplete.normalized_payload->>'parentObservationId',
      'rawSha256', incomplete.normalized_payload->>'rawSha256',
      'extractionStatus', incomplete.normalized_payload->'extraction'->>'status',
      'extractionMethod', incomplete.normalized_payload->'extraction'->>'method',
      'extractionProvenance', coalesce(
        incomplete.normalized_payload->'extraction'->>'provenance',
        'legacy_unspecified'
      ),
      'filename', coalesce(incomplete.normalized_payload->>'filename', ''),
      'mimeType', coalesce(incomplete.normalized_payload->>'mimeType', ''),
      'batchId', incomplete.root_batch_id::text,
      'rootBatchId', incomplete.root_batch_id,
      'rootJobId', incomplete.root_job_id,
      'parentJobId', incomplete.parent_job_id
    )
  from incomplete
  on conflict (dedupe_key) do nothing
  returning job_id
)
select count(*) from inserted_jobs;

insert into public.source_processing_job_lineage (
  job_id, workspace_key, source_system, connection_key, root_batch_id,
  parent_job_id, root_job_id, source_cursor_version, source_cursor_value
)
select
  review.job_id,
  parent_lineage.workspace_key,
  parent_lineage.source_system,
  parent_lineage.connection_key,
  parent_lineage.root_batch_id,
  parent.job_id,
  parent_lineage.root_job_id,
  parent_lineage.source_cursor_version,
  parent_lineage.source_cursor_value
from public.source_processing_jobs review
join public.source_observations observation
  on observation.observation_id = review.observation_id
join public.source_processing_job_observations output
  on output.observation_id = observation.observation_id
join public.source_processing_jobs parent
  on parent.job_id = output.job_id
 and parent.job_kind = 'gmail_extract_attachment'
join public.source_processing_job_lineage parent_lineage
  on parent_lineage.job_id = parent.job_id
where review.job_kind = 'gmail_review_attachment_extraction'
  and review.payload->>'schemaVersion' = 'gmail-review-attachment-extraction-job-v1'
  and review.workspace_key = parent.workspace_key
  and review.connection_key = parent.connection_key
on conflict (job_id) do nothing;

insert into public.source_processing_job_children (
  parent_job_id, child_job_id, ordinal
)
select
  parent.job_id,
  review.job_id,
  coalesce((
    select max(existing.ordinal) + 1
    from public.source_processing_job_children existing
    where existing.parent_job_id = parent.job_id
  ), 0)
from public.source_processing_jobs review
join public.source_processing_job_lineage review_lineage
  on review_lineage.job_id = review.job_id
join public.source_processing_jobs parent
  on parent.job_id = review_lineage.parent_job_id
where review.job_kind = 'gmail_review_attachment_extraction'
  and not exists (
    select 1
    from public.source_processing_job_children existing
    where existing.parent_job_id = parent.job_id
      and existing.child_job_id = review.job_id
  )
order by parent.job_id, review.job_id
on conflict do nothing;

create or replace function private.unresolved_gmail_attachment_extractions(
  p_workspace_key text
)
returns table (
  attachment_observation_id text,
  attachment_content_hash text,
  attachment_id text,
  connection_key text,
  source_cursor_version bigint,
  root_batch_id uuid,
  review_job_id uuid,
  review_job_state text,
  extraction_status text,
  extraction_method text,
  extraction_provenance text,
  filename text,
  mime_type text,
  raw_sha256 text,
  captured_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    observation.observation_id,
    observation.content_hash,
    observation.normalized_payload->>'attachmentId',
    observation.connection_key,
    observation.source_cursor_version,
    lineage.root_batch_id,
    review.job_id,
    coalesce(review.state, 'missing'),
    observation.normalized_payload->'extraction'->>'status',
    observation.normalized_payload->'extraction'->>'method',
    coalesce(
      observation.normalized_payload->'extraction'->>'provenance',
      'legacy_unspecified'
    ),
    coalesce(observation.normalized_payload->>'filename', ''),
    coalesce(observation.normalized_payload->>'mimeType', ''),
    coalesce(observation.normalized_payload->>'rawSha256', ''),
    observation.captured_at
  from public.source_processing_jobs parent
  join public.source_processing_job_observations output
    on output.job_id = parent.job_id
  join public.source_observations observation
    on observation.observation_id = output.observation_id
   and observation.workspace_key = parent.workspace_key
   and observation.source_system = parent.source_system
   and observation.connection_key = parent.connection_key
  join public.source_processing_job_lineage lineage
    on lineage.job_id = parent.job_id
  join public.source_ingest_batches batch
    on batch.batch_id = lineage.root_batch_id
   and batch.workspace_key = lineage.workspace_key
   and batch.source_system = lineage.source_system
   and batch.connection_key = lineage.connection_key
   and batch.status = 'committed'
  left join public.source_processing_job_children child_link
    on child_link.parent_job_id = parent.job_id
   and exists (
     select 1
     from public.source_processing_jobs child_job
     where child_job.job_id = child_link.child_job_id
       and child_job.job_kind = 'gmail_review_attachment_extraction'
   )
  left join public.source_processing_jobs review
    on review.job_id = child_link.child_job_id
   and review.job_kind = 'gmail_review_attachment_extraction'
   and review.observation_id = observation.observation_id
  where parent.workspace_key = p_workspace_key
    and parent.source_system = 'gmail'
    and parent.job_kind = 'gmail_extract_attachment'
    and parent.state = 'succeeded'
    and observation.source_object_type = 'gmail_attachment_extracted'
    and observation.normalized_payload->>'schemaVersion' = 'gmail-attachment-extracted-v1'
    and (
      observation.normalized_payload->'extraction'->>'status' <> 'extracted'
      or coalesce(
        (observation.normalized_payload->'extraction'->>'reviewRequired')::boolean,
        true
      )
    )
    and not exists (
      select 1
      from public.gmail_attachment_extraction_resolutions resolution
      where resolution.workspace_key = observation.workspace_key
        and resolution.attachment_observation_id = observation.observation_id
        and resolution.attachment_content_hash = observation.content_hash
    )
    and not exists (
      select 1
      from public.source_observations replacement
      join public.source_processing_job_observations replacement_output
        on replacement_output.observation_id = replacement.observation_id
      join public.source_processing_jobs replacement_job
        on replacement_job.job_id = replacement_output.job_id
       and replacement_job.workspace_key = replacement.workspace_key
       and replacement_job.source_system = replacement.source_system
       and replacement_job.connection_key = replacement.connection_key
       and replacement_job.job_kind = 'gmail_extract_attachment'
       and replacement_job.state = 'succeeded'
      where replacement.workspace_key = observation.workspace_key
        and replacement.source_system = 'gmail'
        and replacement.source_object_type = 'gmail_attachment_extracted'
        and replacement.observation_id <> observation.observation_id
        and replacement.journal_seq > observation.journal_seq
        and replacement.normalized_payload->>'schemaVersion' = 'gmail-attachment-extracted-v1'
        and replacement.normalized_payload->>'attachmentId'
          is not distinct from observation.normalized_payload->>'attachmentId'
        and replacement.normalized_payload->>'parentObservationId'
          is not distinct from observation.normalized_payload->>'parentObservationId'
        and replacement.normalized_payload->>'rawSha256'
          is not distinct from observation.normalized_payload->>'rawSha256'
        and replacement.normalized_payload->'extraction'->>'status' = 'extracted'
        and replacement.normalized_payload->'extraction'->>'provenance' = 'deterministic'
        and coalesce(
          (replacement.normalized_payload->'extraction'->>'reviewRequired')::boolean,
          true
        ) = false
        and exists (
          select 1
          from public.source_processing_job_children replacement_child_link
          join public.source_processing_jobs replacement_child
            on replacement_child.job_id = replacement_child_link.child_job_id
           and replacement_child.job_kind = 'gmail_extract_attachment_claims'
           and replacement_child.observation_id = replacement.observation_id
          where replacement_child_link.parent_job_id = replacement_job.job_id
        )
    )
  order by observation.captured_at, observation.observation_id;
$function$;

revoke all on function private.unresolved_gmail_attachment_extractions(text)
  from public, anon, authenticated, service_role;

create or replace function private.resolve_gmail_attachment_extraction(
  p_workspace_key text,
  p_attachment_observation_id text,
  p_expected_content_hash text,
  p_decision text,
  p_resolution_evidence_observation_ids jsonb,
  p_decided_by text,
  p_reason text,
  p_idempotency_key text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target record;
  v_review_job public.source_processing_jobs%rowtype;
  v_evidence_ids jsonb;
  v_evidence_count integer;
  v_distinct_evidence_count integer;
  v_idempotency_key_hash text;
  v_canonical_request jsonb;
  v_request_hash text;
  v_resolution_id text;
  v_canonical_receipt jsonb;
  v_receipt_hash text;
  v_existing public.gmail_attachment_extraction_resolutions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid attachment review authority' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or coalesce(p_attachment_observation_id, '') !~ '^obs:v1:[0-9a-f]{64}$'
    or coalesce(p_expected_content_hash, '') !~ '^[0-9a-f]{64}$'
    or p_decision <> all (array[
      'reviewed_non_operational',
      'operational_evidence_recorded'
    ])
    or jsonb_typeof(coalesce(p_resolution_evidence_observation_ids, 'null'::jsonb)) <> 'array'
    or nullif(trim(coalesce(p_decided_by, '')), '') is null
    or length(p_decided_by) > 200
    or nullif(trim(coalesce(p_reason, '')), '') is null
    or length(p_reason) > 2000
    or nullif(trim(coalesce(p_idempotency_key, '')), '') is null
    or length(p_idempotency_key) > 500 then
    raise exception 'attachment review request is invalid' using errcode = '22023';
  end if;

  -- Resolution changes both the durable unresolved inventory and the review
  -- job backlog. Take the cut lock before reading or locking either target.
  perform private.truth_source_cut_serialization_lock(p_workspace_key);

  select count(*)::integer, count(distinct item #>> '{}')::integer
  into v_evidence_count, v_distinct_evidence_count
  from jsonb_array_elements(p_resolution_evidence_observation_ids) item;
  if v_evidence_count <> v_distinct_evidence_count
    or exists (
      select 1 from jsonb_array_elements(p_resolution_evidence_observation_ids) item
      where jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~ '^obs:v1:[0-9a-f]{64}$'
    )
    or (p_decision = 'reviewed_non_operational' and v_evidence_count <> 0)
    or (p_decision = 'operational_evidence_recorded' and v_evidence_count = 0) then
    raise exception 'attachment review evidence is invalid' using errcode = '23514';
  end if;
  if v_evidence_count > 0 and (
    select count(*)::integer
    from jsonb_array_elements_text(p_resolution_evidence_observation_ids) item
    join public.source_observations evidence
      on evidence.observation_id = item
     and evidence.workspace_key = p_workspace_key
  ) <> v_evidence_count then
    raise exception 'attachment review evidence crosses workspace or is unavailable'
      using errcode = '23503';
  end if;

  select coalesce(jsonb_agg(item order by item), '[]'::jsonb)
  into v_evidence_ids
  from jsonb_array_elements_text(p_resolution_evidence_observation_ids) item;

  v_idempotency_key_hash := encode(extensions.digest(
    convert_to(p_idempotency_key, 'UTF8'), 'sha256'
  ), 'hex');
  v_canonical_request := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-extraction-resolution-request-v1',
    'workspaceKey', p_workspace_key,
    'attachmentObservationId', p_attachment_observation_id,
    'attachmentContentHash', p_expected_content_hash,
    'decision', p_decision,
    'resolutionEvidenceObservationIds', v_evidence_ids,
    'decidedBy', p_decided_by,
    'reason', p_reason,
    'idempotencyKeyHash', v_idempotency_key_hash
  );
  v_request_hash := encode(extensions.digest(
    convert_to(v_canonical_request::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_resolution_id := 'attachment-resolution:v1:' || v_request_hash;

  perform pg_advisory_xact_lock(hashtextextended(
    'attachment-review:' || p_workspace_key || ':' || p_attachment_observation_id,
    0
  ));
  select * into v_existing
  from public.gmail_attachment_extraction_resolutions resolution
  where resolution.workspace_key = p_workspace_key
    and resolution.idempotency_key_hash = v_idempotency_key_hash;
  if found then
    if v_existing.request_hash is distinct from v_request_hash then
      raise exception 'attachment review idempotency key was reused'
        using errcode = '23505';
    end if;
    return v_existing.canonical_receipt || jsonb_build_object('idempotent', true);
  end if;

  select * into v_target
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where unresolved.attachment_observation_id = p_attachment_observation_id
    and unresolved.attachment_content_hash = p_expected_content_hash;
  if not found then
    raise exception 'attachment review target is resolved, stale, or unavailable'
      using errcode = '40001';
  end if;
  if v_target.review_job_id is null then
    raise exception 'attachment review target lacks its durable review child'
      using errcode = '23514';
  end if;
  select * into v_review_job
  from public.source_processing_jobs job
  where job.job_id = v_target.review_job_id
    and job.workspace_key = p_workspace_key
    and job.job_kind = 'gmail_review_attachment_extraction'
    and job.observation_id = p_attachment_observation_id
  for update;
  if not found or v_review_job.state not in ('queued', 'retry_wait', 'dead_letter') then
    raise exception 'attachment review child is not available for explicit resolution'
      using errcode = '40001';
  end if;

  v_canonical_receipt := jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'schemaVersion', 'gmail-attachment-extraction-resolution-receipt-v1',
    'resolutionId', v_resolution_id,
    'workspaceKey', p_workspace_key,
    'attachmentObservationId', p_attachment_observation_id,
    'attachmentContentHash', p_expected_content_hash,
    'reviewJobId', v_review_job.job_id,
    'decision', p_decision,
    'resolutionEvidenceObservationIds', v_evidence_ids,
    'mutatesOperationalState', false
  );
  v_receipt_hash := encode(extensions.digest(
    convert_to(v_canonical_receipt::text, 'UTF8'), 'sha256'
  ), 'hex');

  insert into public.gmail_attachment_extraction_resolutions (
    resolution_id, workspace_key, connection_key,
    attachment_observation_id, attachment_content_hash, review_job_id,
    decision, resolution_evidence_observation_ids, decided_by, reason,
    idempotency_key_hash, request_hash, canonical_request,
    receipt_hash, canonical_receipt
  ) values (
    v_resolution_id, p_workspace_key, v_target.connection_key,
    p_attachment_observation_id, p_expected_content_hash, v_review_job.job_id,
    p_decision, v_evidence_ids, p_decided_by, p_reason,
    v_idempotency_key_hash, v_request_hash, v_canonical_request,
    v_receipt_hash, v_canonical_receipt
  );

  update public.source_processing_jobs
  set state = 'succeeded',
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = '',
      safe_error_detail = '',
      processor_version = 'gmail-attachment-review-resolution-v1',
      result = jsonb_build_object(
        'schemaVersion', 'gmail-attachment-review-job-result-v1',
        'resolutionId', v_resolution_id,
        'resolutionReceiptHash', v_receipt_hash,
        'decision', p_decision,
        'mutatesOperationalState', false
      ),
      updated_at = v_now,
      completed_at = v_now
  where job_id = v_review_job.job_id
    and state = v_review_job.state;
  if not found then
    raise exception 'attachment review child changed during resolution'
      using errcode = '40001';
  end if;

  return v_canonical_receipt;
end;
$function$;

create or replace function public.resolve_gmail_attachment_extraction(
  p_workspace_key text,
  p_attachment_observation_id text,
  p_expected_content_hash text,
  p_decision text,
  p_resolution_evidence_observation_ids jsonb,
  p_decided_by text,
  p_reason text,
  p_idempotency_key text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.resolve_gmail_attachment_extraction(
    p_workspace_key,
    p_attachment_observation_id,
    p_expected_content_hash,
    p_decision,
    p_resolution_evidence_observation_ids,
    p_decided_by,
    p_reason,
    p_idempotency_key,
    p_review_token,
    p_sync_token
  );
$function$;

revoke all on function private.resolve_gmail_attachment_extraction(
  text, text, text, text, jsonb, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_gmail_attachment_extraction(
  text, text, text, text, jsonb, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_gmail_attachment_extraction(
  text, text, text, text, jsonb, text, text, text, text, text
) to service_role;

-- A source cut is a transaction boundary, not a sequence of eventually
-- consistent reads. Every mutation that can change its partition witness,
-- completeness gaps, or review witness takes this workspace-scoped lock. The
-- cut takes the same lock before reading any of those surfaces. Transaction
-- advisory locks are re-entrant, so a compound review/materialization RPC can
-- cross several guarded tables without changing the lock order.
create or replace function private.truth_source_cut_serialization_lock(
  p_workspace_key text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null then
    raise exception 'source-cut serialization workspace is invalid'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-source-cut-serialization-v1:' || p_workspace_key,
    0
  ));
end;
$function$;

create or replace function private.truth_source_cut_serialization_lock_for_batch(
  p_batch_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workspace_key text;
begin
  select batch.workspace_key into v_workspace_key
  from public.source_ingest_batches batch
  where batch.batch_id = p_batch_id;
  if found then
    perform private.truth_source_cut_serialization_lock(v_workspace_key);
  end if;
end;
$function$;

create or replace function private.truth_source_cut_serialization_lock_for_job(
  p_job_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workspace_key text;
begin
  select job.workspace_key into v_workspace_key
  from public.source_processing_jobs job
  where job.job_id = p_job_id;
  if found then
    perform private.truth_source_cut_serialization_lock(v_workspace_key);
  end if;
end;
$function$;

revoke all on function private.truth_source_cut_serialization_lock(text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_source_cut_serialization_lock_for_batch(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_source_cut_serialization_lock_for_job(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.truth_source_cut_serialization_lock(text)
  to service_role;
grant execute on function private.truth_source_cut_serialization_lock_for_batch(uuid)
  to service_role;
grant execute on function private.truth_source_cut_serialization_lock_for_job(uuid)
  to service_role;

-- Storage-level guards are the exhaustive authority. The public entry locks
-- below establish advisory-before-row-lock ordering for cursor-owning RPCs;
-- these triggers also cover compound candidate/link/review materialization and
-- any future definer path that writes a cut-scoped artifact directly.
create or replace function private.guard_truth_source_cut_artifact_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row jsonb;
  v_old_row jsonb;
  v_workspace_key text;
begin
  if tg_op = 'UPDATE' then
    v_row := to_jsonb(new);
    v_old_row := to_jsonb(old);
  elsif tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;
  if tg_table_name = 'source_cursors' and tg_op = 'UPDATE'
    and jsonb_build_array(
      v_row->'workspace_key', v_row->'source_system', v_row->'connection_key',
      v_row->'cursor_kind', v_row->'cursor_value', v_row->'cursor_version',
      v_row->'status', v_row->'last_batch_id', v_row->'last_committed_at',
      v_row->'last_error_code', v_row->'last_error_detail'
    ) = jsonb_build_array(
      v_old_row->'workspace_key', v_old_row->'source_system', v_old_row->'connection_key',
      v_old_row->'cursor_kind', v_old_row->'cursor_value', v_old_row->'cursor_version',
      v_old_row->'status', v_old_row->'last_batch_id', v_old_row->'last_committed_at',
      v_old_row->'last_error_code', v_old_row->'last_error_detail'
    ) then
    return new;
  end if;
  if tg_table_name = 'source_processing_jobs' and tg_op = 'UPDATE'
    and jsonb_build_array(
      v_row->'workspace_key', v_row->'source_system', v_row->'connection_key',
      v_row->'job_kind', v_row->'observation_id',
      v_row->'source_object_id', v_row->'state'
    ) = jsonb_build_array(
      v_old_row->'workspace_key', v_old_row->'source_system', v_old_row->'connection_key',
      v_old_row->'job_kind', v_old_row->'observation_id',
      v_old_row->'source_object_id', v_old_row->'state'
    ) then
    return new;
  end if;
  v_workspace_key := nullif(v_row->>'workspace_key', '');
  if v_workspace_key is null then
    case tg_table_name
      when 'source_processing_job_observations' then
        select job.workspace_key into v_workspace_key
        from public.source_processing_jobs job
        where job.job_id = (v_row->>'job_id')::uuid;
      when 'source_processing_job_children' then
        select job.workspace_key into v_workspace_key
        from public.source_processing_jobs job
        where job.job_id = (v_row->>'parent_job_id')::uuid;
      when 'candidate_claim_decisions' then
        select candidate.workspace_key into v_workspace_key
        from public.candidate_claim_envelopes candidate
        where candidate.candidate_claim_version_id =
          v_row->>'candidate_claim_version_id';
      when 'candidate_claim_acceptance_bindings' then
        select candidate.workspace_key into v_workspace_key
        from public.candidate_claim_envelopes candidate
        where candidate.candidate_claim_version_id =
          v_row->>'candidate_claim_version_id';
      when 'truth_link_candidate_evidence' then
        select proposal.workspace_key into v_workspace_key
        from public.truth_link_candidate_proposals proposal
        where proposal.proposal_id = v_row->>'proposal_id';
      when 'truth_link_candidate_decisions' then
        select proposal.workspace_key into v_workspace_key
        from public.truth_link_candidate_proposals proposal
        where proposal.proposal_id = v_row->>'proposal_id';
      when 'truth_link_acceptance_bindings' then
        select proposal.workspace_key into v_workspace_key
        from public.truth_link_candidate_proposals proposal
        where proposal.proposal_id = v_row->>'proposal_id';
      else
        null;
    end case;
  end if;
  if v_workspace_key is null then
    raise exception 'cut-scoped artifact lacks a workspace serialization key'
      using errcode = '23514';
  end if;
  perform private.truth_source_cut_serialization_lock(v_workspace_key);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'source_cursors',
    'source_ingest_batches',
    'source_ingest_manifests',
    'source_observations',
    'source_processing_jobs',
    'source_processing_job_lineage',
    'source_processing_job_observations',
    'source_processing_job_children',
    'gmail_completeness_gaps',
    'candidate_claim_envelopes',
    'candidate_claim_job_manifests',
    'candidate_claim_decisions',
    'candidate_claim_acceptance_bindings',
    'truth_link_resolution_runs',
    'truth_link_candidate_proposals',
    'truth_link_candidate_evidence',
    'truth_link_candidate_decisions',
    'truth_link_acceptance_bindings',
    'accepted_claim_envelopes',
    'observation_entity_link_envelopes',
    'operational_workgroup_envelopes',
    'operational_workgroup_membership_envelopes',
    'truth_review_resolutions',
    'gmail_attachment_extraction_resolutions'
  ] loop
    execute format(
      'drop trigger if exists aa_truth_source_cut_serialization on public.%I',
      v_table
    );
    execute format(
      'create trigger aa_truth_source_cut_serialization before insert or update or delete on public.%I for each row execute function private.guard_truth_source_cut_artifact_mutation()',
      v_table
    );
  end loop;
end;
$block$;

revoke all on function private.guard_truth_source_cut_artifact_mutation()
  from public, anon, authenticated, service_role;

-- Cursor-owning entry points must take the advisory lock before their existing
-- cursor/batch row locks. This single order prevents writer/cut deadlocks.
create or replace function public.acquire_source_sync_lease(
  p_workspace_key text, p_source_system text, p_connection_key text,
  p_owner_id text, p_ttl_seconds integer, p_cursor_kind text, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  return private.acquire_source_sync_lease(
    p_workspace_key, p_source_system, p_connection_key, p_owner_id,
    p_ttl_seconds, p_cursor_kind, p_sync_token
  );
end;
$function$;

create or replace function public.begin_source_ingest_batch(
  p_workspace_key text, p_source_system text, p_connection_key text,
  p_owner_id text, p_lease_fence bigint, p_mode text,
  p_trigger_name text, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  return private.begin_source_ingest_batch(
    p_workspace_key, p_source_system, p_connection_key, p_owner_id,
    p_lease_fence, p_mode, p_trigger_name, p_sync_token
  );
end;
$function$;

create or replace function public.append_gmail_ingest_page(
  p_batch_id uuid, p_owner_id text, p_lease_fence bigint, p_page jsonb,
  p_observations jsonb, p_jobs jsonb, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock_for_batch(p_batch_id);
  return private.append_gmail_ingest_page(
    p_batch_id, p_owner_id, p_lease_fence, p_page,
    p_observations, p_jobs, p_sync_token
  );
end;
$function$;

create or replace function public.commit_source_ingest_batch(
  p_batch_id uuid, p_owner_id text, p_lease_fence bigint, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock_for_batch(p_batch_id);
  return private.commit_source_ingest_batch(
    p_batch_id, p_owner_id, p_lease_fence, p_sync_token
  );
end;
$function$;

create or replace function public.mark_gmail_history_expired(
  p_workspace_key text, p_connection_key text, p_owner_id text,
  p_lease_fence bigint, p_prior_cursor_value text,
  p_recovery_anchor_value text, p_detail jsonb, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  return private.mark_gmail_history_expired(
    p_workspace_key, p_connection_key, p_owner_id, p_lease_fence,
    p_prior_cursor_value, p_recovery_anchor_value, p_detail, p_sync_token
  );
end;
$function$;

create or replace function public.record_source_snapshot_preflight_failure(
  p_workspace_key text, p_source_system text, p_connection_key text,
  p_cursor_kind text, p_recorded_by text, p_error_code text,
  p_safe_error_detail text, p_diagnostics jsonb, p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  return private.record_source_snapshot_preflight_failure(
    p_workspace_key, p_source_system, p_connection_key, p_cursor_kind,
    p_recorded_by, p_error_code, p_safe_error_detail, p_diagnostics, p_sync_token
  );
end;
$function$;

create or replace function public.commit_source_snapshot_batch(
  p_batch_id uuid, p_owner_id text, p_lease_fence bigint,
  p_next_cursor_value text, p_provider_manifest jsonb,
  p_observations jsonb, p_jobs jsonb, p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock_for_batch(p_batch_id);
  return private.commit_source_snapshot_batch(
    p_batch_id, p_owner_id, p_lease_fence, p_next_cursor_value,
    p_provider_manifest, p_observations, p_jobs, p_sync_token
  );
end;
$function$;

create or replace function public.fail_source_snapshot_batch(
  p_batch_id uuid, p_owner_id text, p_lease_fence bigint,
  p_error_code text, p_safe_error_detail text, p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock_for_batch(p_batch_id);
  return private.fail_source_snapshot_batch(
    p_batch_id, p_owner_id, p_lease_fence,
    p_error_code, p_safe_error_detail, p_sync_token
  );
end;
$function$;

create or replace function public.record_operator_truth_event(
  p_workspace_key text, p_connection_key text, p_idempotency_key text,
  p_request jsonb, p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  return private.record_operator_truth_event(
    p_workspace_key, p_connection_key, p_idempotency_key,
    p_request, p_sync_token
  );
end;
$function$;

-- Job state is part of the cut's completeness witness. Claim, completion, and
-- failure therefore serialize at RPC entry; table guards cover internal/direct
-- definer paths as well.
create or replace function public.claim_source_processing_jobs(
  p_workspace_key text, p_source_system text, p_connection_key text,
  p_worker_id text, p_processor_version text, p_limit integer,
  p_lease_seconds integer, p_job_kinds text[], p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock(p_workspace_key);
  return private.claim_source_processing_jobs(
    p_workspace_key, p_source_system, p_connection_key, p_worker_id,
    p_processor_version, p_limit, p_lease_seconds, p_job_kinds, p_sync_token
  );
end;
$function$;

create or replace function public.complete_source_processing_job(
  p_job_id uuid, p_worker_id text, p_lease_fence bigint,
  p_processor_version text, p_result jsonb, p_observations jsonb,
  p_child_jobs jsonb, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock_for_job(p_job_id);
  return private.complete_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    p_result, p_observations, p_child_jobs, p_sync_token
  );
end;
$function$;

create or replace function public.fail_source_processing_job(
  p_job_id uuid, p_worker_id text, p_lease_fence bigint,
  p_processor_version text, p_error_code text, p_safe_error_detail text,
  p_retry_after_seconds integer, p_sync_token text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform private.truth_source_cut_serialization_lock_for_job(p_job_id);
  return private.fail_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    p_error_code, p_safe_error_detail, p_retry_after_seconds, p_sync_token
  );
end;
$function$;

-- The low-level legacy sealer remains callable by old verification/runtime
-- paths. Wrap it too so it cannot bypass attachment completeness or serialize
-- partition and backlog reads independently.
do $block$
begin
  if to_regprocedure(
    'private.seal_source_cut_pre_serialization_v1(text,text,jsonb,jsonb,jsonb,jsonb,text,text)'
  ) is null then
    alter function private.seal_source_cut(
      text, text, jsonb, jsonb, jsonb, jsonb, text, text
    ) rename to seal_source_cut_pre_serialization_v1;
  end if;
end;
$block$;

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
  v_unresolved_count bigint;
  v_oldest_at timestamptz;
  v_witness_hash text;
  v_attachment_gaps jsonb := '[]'::jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.truth_source_cut_serialization_lock(p_workspace_key);

  select
    count(*)::bigint,
    min(unresolved.captured_at),
    encode(extensions.digest(convert_to(coalesce(string_agg(
      unresolved.attachment_observation_id || ':' || unresolved.attachment_content_hash,
      ',' order by unresolved.attachment_observation_id
    ), ''), 'UTF8'), 'sha256'), 'hex')
  into v_unresolved_count, v_oldest_at, v_witness_hash
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved;
  if v_unresolved_count > 0 then
    v_attachment_gaps := jsonb_build_array(jsonb_build_object(
      'gapType', 'ATTACHMENT_EXTRACTION_REVIEW_PENDING',
      'sourceSystem', 'gmail',
      'count', v_unresolved_count,
      'oldestCapturedAt', private.canonical_truth_timestamp(v_oldest_at),
      'witnessHash', v_witness_hash
    ));
  end if;

  return private.seal_source_cut_pre_serialization_v1(
    p_workspace_key,
    p_manifest_schema_version,
    p_required_sources,
    coalesce(p_gaps, '[]'::jsonb) || v_attachment_gaps,
    p_cursors,
    p_observations,
    p_created_by,
    p_sync_token
  );
end;
$function$;

revoke all on function private.seal_source_cut_pre_serialization_v1(
  text, text, jsonb, jsonb, jsonb, jsonb, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.seal_source_cut(
  text, text, jsonb, jsonb, jsonb, jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.seal_source_cut(
  text, text, jsonb, jsonb, jsonb, jsonb, text, text
) to service_role;

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

-- Wrap the current cut coordinator before it can seal. Calling the old
-- implementation and then downgrading its receipt would already have created
-- an invalid durable cut, so the attachment witness is checked first.
do $block$
begin
  if to_regprocedure(
    'private.seal_current_source_cut_pre_attachment(text,text,text)'
  ) is null then
    alter function private.seal_current_source_cut(text, text, text)
      rename to seal_current_source_cut_pre_attachment;
  end if;
end
$block$;

create or replace function private.seal_current_source_cut(
  p_workspace_key text,
  p_created_by text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_unresolved_count bigint;
  v_oldest_at timestamptz;
  v_witness_hash text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_created_by, '')), '') is null then
    raise exception 'source-cut coordinator identity is incomplete' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.truth_workspaces workspace
    where workspace.workspace_key = p_workspace_key
      and workspace.status = 'active'
  ) then
    raise exception 'truth workspace is unavailable or disabled' using errcode = '23503';
  end if;

  -- Lock ordering is workspace advisory -> required-source registry/cursors.
  -- The wrapped coordinator below already takes row locks, so this must happen
  -- before its attachment, cursor, partition, and backlog reads.
  perform private.truth_source_cut_serialization_lock(p_workspace_key);

  select
    count(*)::bigint,
    min(unresolved.captured_at),
    encode(extensions.digest(convert_to(coalesce(string_agg(
      unresolved.attachment_observation_id || ':' || unresolved.attachment_content_hash,
      ',' order by unresolved.attachment_observation_id
    ), ''), 'UTF8'), 'sha256'), 'hex')
  into v_unresolved_count, v_oldest_at, v_witness_hash
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved;

  if v_unresolved_count > 0 then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'sourceCutId', null,
      'manifestHash', null,
      'completeness', 'degraded',
      'observationCount', 0,
      'gaps', jsonb_build_array(jsonb_build_object(
        'gapType', 'ATTACHMENT_EXTRACTION_REVIEW_PENDING',
        'sourceSystem', 'gmail',
        'count', v_unresolved_count,
        'oldestCapturedAt', private.canonical_truth_timestamp(v_oldest_at),
        'witnessHash', v_witness_hash
      )),
      'manifest', null
    );
  end if;

  return private.seal_current_source_cut_pre_attachment(
    p_workspace_key, p_created_by, p_sync_token
  );
end;
$function$;

revoke all on function private.seal_current_source_cut_pre_attachment(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.seal_current_source_cut(text, text, text)
  from public, anon, authenticated, service_role;

-- Extend the current bounded audit snapshot (including prior metadata wrappers)
-- with all unresolved attachment gaps, not only observations from the newest
-- Gmail ingest lineage.
do $block$
begin
  if to_regprocedure(
    'private.read_truth_audit_snapshot_pre_attachment(text,integer,text)'
  ) is null then
    alter function private.read_truth_audit_snapshot(text, integer, text)
      rename to read_truth_audit_snapshot_pre_attachment;
  end if;
end
$block$;

create or replace function private.read_truth_audit_snapshot(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '25s'
as $function$
declare
  v_snapshot jsonb;
  v_unresolved jsonb := '[]'::jsonb;
  v_unresolved_count bigint := 0;
  v_truncated boolean := false;
begin
  v_snapshot := private.read_truth_audit_snapshot_pre_attachment(
    p_workspace_key, p_row_limit, p_sync_token
  );

  with unresolved_base as (
    select *
    from private.unresolved_gmail_attachment_extractions(p_workspace_key)
  ), bounded_unresolved as (
    select *
    from unresolved_base
    order by captured_at, attachment_observation_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from unresolved_base),
    coalesce((
      select jsonb_agg(to_jsonb(row_value)
        order by row_value.captured_at, row_value.attachment_observation_id)
      from bounded_unresolved row_value
    ), '[]'::jsonb)
  into v_unresolved_count, v_unresolved;

  v_truncated := coalesce((v_snapshot #>> '{bounds,truncated}')::boolean, false)
    or v_unresolved_count > p_row_limit;
  v_snapshot := jsonb_set(
    v_snapshot,
    '{source,attachmentExtractionCompleteness}',
    jsonb_build_object(
      'schemaVersion', 'gmail-attachment-extraction-completeness-v1',
      'unresolvedCount', v_unresolved_count,
      'complete', v_unresolved_count = 0
    ),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{source,attachmentExtractionGaps}',
    v_unresolved,
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,counts,attachmentExtractionGaps}',
    to_jsonb(v_unresolved_count),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{bounds,truncated}',
    to_jsonb(v_truncated),
    true
  );
  return v_snapshot;
end;
$function$;

revoke all on function private.read_truth_audit_snapshot_pre_attachment(text, integer, text)
  from public, anon, authenticated, service_role, truth_audit_rpc_owner;
revoke all on function private.read_truth_audit_snapshot(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function private.read_truth_audit_snapshot(text, integer, text)
  to truth_audit_rpc_owner;

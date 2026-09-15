-- Durable, shadow-only model extraction for unresolved Gmail attachments.
--
-- The source review job remains the sole execution authority.  This migration
-- never reads raw bytes and never invokes a provider: it binds the private raw
-- object, reserves the existing workspace model budget, authorizes one exact
-- wire dispatch at a time, records the provider outcome, and atomically turns a
-- successful all-page transcription into a review-gated attachment observation
-- plus its deterministic claim child.  No path publishes operational truth.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
set check_function_bodies = off;

do $prerequisite$
begin
  if to_regclass('public.gmail_attachment_extraction_resolutions') is null
    or to_regclass('public.truth_model_workspace_accounts') is null
    or to_regclass('public.truth_model_workspace_daily_usage') is null
    or to_regclass('public.truth_model_pricing_policies') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.valid_truth_review_token(text)') is null
    or to_regprocedure('private.truth_model_usage_cost(text,bigint,bigint,bigint)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_shadow_model_commissioning_job_allowed(text,uuid)') is null
    or to_regprocedure('private.complete_source_processing_job(uuid,text,bigint,text,jsonb,jsonb,jsonb,text)') is null
    or to_regprocedure('private.unresolved_gmail_attachment_extractions(text)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'Gmail attachment model runtime prerequisites are unavailable'
      using errcode = '55000';
  end if;
end;
$prerequisite$;

create table if not exists public.gmail_attachment_model_requests (
  request_id text primary key
    check (request_id ~ '^gmail-attachment-model-request:v1:[0-9a-f]{64}$'),
  request_hash text not null unique check (request_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  connection_key text not null check (connection_key like 'shadow-%'),
  source_job_id uuid not null,
  root_batch_id uuid not null,
  source_observation_id text not null,
  source_observation_content_hash text not null
    check (source_observation_content_hash ~ '^[0-9a-f]{64}$'),
  source_attachment_id text not null,
  source_parent_observation_id text not null,
  source_message_id text not null,
  source_thread_id text not null default '',
  source_history_id text not null check (source_history_id ~ '^[0-9]+$'),
  filename text not null default '',
  mime_type text not null,
  raw_object_bucket text not null,
  raw_object_key text not null,
  raw_object_version text,
  raw_object_etag text,
  raw_sha256 text not null check (raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_bytes bigint not null check (raw_bytes between 1 and 52428799),
  raw_content_type text not null,
  request_body_hash text not null check (request_body_hash ~ '^[0-9a-f]{64}$'),
  request_body_bytes integer not null check (request_body_bytes between 1 and 78643200),
  model_snapshot text not null,
  prompt_version text not null,
  response_schema_version text not null,
  response_schema_hash text not null check (response_schema_hash ~ '^[0-9a-f]{64}$'),
  processing_config_version text not null,
  processing_config_hash text not null check (processing_config_hash ~ '^[0-9a-f]{64}$'),
  pricing_policy_id text not null references public.truth_model_pricing_policies(pricing_policy_id)
    on update restrict on delete restrict,
  pricing_policy_hash text not null check (pricing_policy_hash ~ '^[0-9a-f]{64}$'),
  max_input_tokens integer not null check (max_input_tokens = 390000),
  max_output_tokens integer not null check (max_output_tokens = 8192),
  max_attempts integer not null check (max_attempts = 3),
  state text not null default 'planned' check (state = any (array[
    'planned', 'reserved', 'in_flight', 'succeeded', 'review_required',
    'outcome_unknown'
  ])),
  reservation_date date,
  initial_reserved_input_tokens bigint not null default 0
    check (initial_reserved_input_tokens >= 0),
  initial_reserved_output_tokens bigint not null default 0
    check (initial_reserved_output_tokens >= 0),
  remaining_reserved_input_tokens bigint not null default 0
    check (remaining_reserved_input_tokens >= 0),
  remaining_reserved_output_tokens bigint not null default 0
    check (remaining_reserved_output_tokens >= 0),
  initial_reserved_microusd bigint not null default 0
    check (initial_reserved_microusd >= 0),
  remaining_reserved_microusd bigint not null default 0
    check (remaining_reserved_microusd >= 0),
  actual_input_tokens bigint not null default 0 check (actual_input_tokens >= 0),
  actual_cached_input_tokens bigint not null default 0
    check (actual_cached_input_tokens >= 0),
  actual_output_tokens bigint not null default 0 check (actual_output_tokens >= 0),
  actual_reasoning_tokens bigint not null default 0
    check (actual_reasoning_tokens >= 0),
  actual_total_tokens bigint not null default 0 check (actual_total_tokens >= 0),
  actual_microusd bigint not null default 0 check (actual_microusd >= 0),
  review_reason text not null default '',
  canonical_request jsonb not null check (jsonb_typeof(canonical_request) = 'object'),
  completion_observation_id text,
  completion_claim_job_id uuid,
  completion_resolution_id text,
  canonical_completion_receipt jsonb,
  completion_receipt_hash text,
  created_at timestamptz not null default clock_timestamp(),
  reserved_at timestamptz,
  provider_finalized_at timestamptz,
  evidence_finalized_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, source_job_id),
  unique (workspace_key, request_id),
  foreign key (workspace_key, root_batch_id)
    references public.source_ingest_batches(workspace_key, batch_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_job_id)
    references public.source_processing_jobs(workspace_key, job_id)
    on update restrict on delete restrict,
  foreign key (workspace_key, source_observation_id)
    references public.source_observations(workspace_key, observation_id)
    on update restrict on delete restrict,
  check (request_id = 'gmail-attachment-model-request:v1:' || request_hash),
  check (actual_cached_input_tokens <= actual_input_tokens),
  check (actual_reasoning_tokens <= actual_output_tokens),
  check (actual_total_tokens = actual_input_tokens + actual_output_tokens),
  check (remaining_reserved_input_tokens <= initial_reserved_input_tokens),
  check (remaining_reserved_output_tokens <= initial_reserved_output_tokens),
  check (remaining_reserved_microusd <= initial_reserved_microusd),
  check (
    (completion_observation_id is null and completion_claim_job_id is null
      and completion_resolution_id is null and canonical_completion_receipt is null
      and completion_receipt_hash is null and evidence_finalized_at is null)
    or
    (completion_observation_id ~ '^obs:v1:[0-9a-f]{64}$'
      and completion_claim_job_id is not null
      and completion_resolution_id ~ '^attachment-resolution:v1:[0-9a-f]{64}$'
      and jsonb_typeof(canonical_completion_receipt) = 'object'
      and completion_receipt_hash ~ '^[0-9a-f]{64}$'
      and evidence_finalized_at is not null)
  )
);

create table if not exists public.gmail_attachment_model_attempt_dispatches (
  dispatch_id text primary key
    check (dispatch_id ~ '^gmail-attachment-model-dispatch:v1:[0-9a-f]{64}$'),
  dispatch_hash text not null unique check (dispatch_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  request_id text not null,
  attempt_number integer not null check (attempt_number between 1 and 3),
  client_request_id text not null,
  request_body_hash text not null check (request_body_hash ~ '^[0-9a-f]{64}$'),
  request_body_bytes integer not null check (request_body_bytes between 1 and 78643200),
  authorization_worker_id text not null,
  authorization_lease_fence bigint not null check (authorization_lease_fence > 0),
  authorization_processor_version text not null,
  authorization_lease_expires_at timestamptz not null,
  canonical_dispatch jsonb not null check (jsonb_typeof(canonical_dispatch) = 'object'),
  dispatched_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, request_id, attempt_number),
  unique (workspace_key, client_request_id),
  unique (workspace_key, dispatch_id),
  unique (dispatch_id, request_id, workspace_key, attempt_number),
  foreign key (workspace_key, request_id)
    references public.gmail_attachment_model_requests(workspace_key, request_id)
    on update restrict on delete restrict,
  check (dispatch_id = 'gmail-attachment-model-dispatch:v1:' || dispatch_hash)
);

create table if not exists public.gmail_attachment_model_attempt_outcomes (
  outcome_id text primary key
    check (outcome_id ~ '^gmail-attachment-model-outcome:v1:[0-9a-f]{64}$'),
  outcome_hash text not null unique check (outcome_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  request_id text not null,
  dispatch_id text not null unique,
  attempt_number integer not null check (attempt_number between 1 and 3),
  provider_result_hash text not null unique check (provider_result_hash ~ '^[0-9a-f]{64}$'),
  classification text not null check (classification = any (array[
    'succeeded', 'refusal', 'incomplete', 'content_filter', 'malformed_output',
    'insufficient_quota', 'configuration_error', 'rate_limit_exceeded',
    'server_error', 'outcome_unknown'
  ])),
  request_sent boolean not null,
  retryable boolean not null,
  outcome_unknown boolean not null,
  billing_outcome_unknown boolean not null,
  http_status integer check (http_status is null or http_status between 100 and 599),
  request_body_hash text not null check (request_body_hash ~ '^[0-9a-f]{64}$'),
  request_body_bytes integer not null check (request_body_bytes between 1 and 78643200),
  provider_response_body_hash text not null default ''
    check (provider_response_body_hash = '' or provider_response_body_hash ~ '^[0-9a-f]{64}$'),
  provider_response_body_bytes integer not null default 0
    check (provider_response_body_bytes between 0 and 2097152),
  provider_response_id text not null default '',
  server_request_id text not null default '',
  actual_model text not null default '',
  provider_error_code text not null default '',
  incomplete_reason text not null default '',
  model_response jsonb,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  actual_microusd bigint not null default 0 check (actual_microusd >= 0),
  provider_result jsonb not null check (jsonb_typeof(provider_result) = 'object'),
  canonical_outcome jsonb not null check (jsonb_typeof(canonical_outcome) = 'object'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, request_id, attempt_number),
  unique (workspace_key, outcome_id),
  foreign key (workspace_key, request_id, attempt_number)
    references public.gmail_attachment_model_attempt_dispatches(
      workspace_key, request_id, attempt_number
    ) on update restrict on delete restrict,
  foreign key (dispatch_id, request_id, workspace_key, attempt_number)
    references public.gmail_attachment_model_attempt_dispatches(
      dispatch_id, request_id, workspace_key, attempt_number
    ) on update restrict on delete restrict,
  check (outcome_id = 'gmail-attachment-model-outcome:v1:' || outcome_hash),
  check (cached_input_tokens <= input_tokens),
  check (reasoning_tokens <= output_tokens),
  check (total_tokens = input_tokens + output_tokens),
  check (outcome_unknown = (classification = 'outcome_unknown')),
  check ((provider_response_body_hash = '' and provider_response_body_bytes = 0)
    or (provider_response_body_hash <> '' and provider_response_body_bytes > 0)),
  check ((classification = 'succeeded' and jsonb_typeof(model_response) = 'object')
    or (classification <> 'succeeded'))
);

create unique index if not exists gmail_attachment_model_outcome_provider_response_uidx
  on public.gmail_attachment_model_attempt_outcomes(provider_response_id)
  where provider_response_id <> '';
create unique index if not exists gmail_attachment_model_outcome_server_request_uidx
  on public.gmail_attachment_model_attempt_outcomes(server_request_id)
  where server_request_id <> '';
create index if not exists gmail_attachment_model_request_state_idx
  on public.gmail_attachment_model_requests(workspace_key, state, created_at, request_id);

create or replace function private.guard_gmail_attachment_model_request_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'Gmail attachment model requests cannot be deleted' using errcode = '55000';
  end if;
  if row(
      new.request_id, new.request_hash, new.workspace_key, new.connection_key,
      new.source_job_id, new.root_batch_id, new.source_observation_id,
      new.source_observation_content_hash, new.source_attachment_id,
      new.source_parent_observation_id, new.source_message_id, new.source_thread_id,
      new.source_history_id, new.filename, new.mime_type, new.raw_object_bucket,
      new.raw_object_key, new.raw_object_version, new.raw_object_etag, new.raw_sha256,
      new.raw_bytes, new.raw_content_type, new.request_body_hash, new.request_body_bytes,
      new.model_snapshot, new.prompt_version, new.response_schema_version,
      new.response_schema_hash, new.processing_config_version, new.processing_config_hash,
      new.pricing_policy_id, new.pricing_policy_hash, new.max_input_tokens,
      new.max_output_tokens, new.max_attempts, new.canonical_request, new.created_at
    ) is distinct from row(
      old.request_id, old.request_hash, old.workspace_key, old.connection_key,
      old.source_job_id, old.root_batch_id, old.source_observation_id,
      old.source_observation_content_hash, old.source_attachment_id,
      old.source_parent_observation_id, old.source_message_id, old.source_thread_id,
      old.source_history_id, old.filename, old.mime_type, old.raw_object_bucket,
      old.raw_object_key, old.raw_object_version, old.raw_object_etag, old.raw_sha256,
      old.raw_bytes, old.raw_content_type, old.request_body_hash, old.request_body_bytes,
      old.model_snapshot, old.prompt_version, old.response_schema_version,
      old.response_schema_hash, old.processing_config_version, old.processing_config_hash,
      old.pricing_policy_id, old.pricing_policy_hash, old.max_input_tokens,
      old.max_output_tokens, old.max_attempts, old.canonical_request, old.created_at
    )
    or new.actual_input_tokens < old.actual_input_tokens
    or new.actual_cached_input_tokens < old.actual_cached_input_tokens
    or new.actual_output_tokens < old.actual_output_tokens
    or new.actual_reasoning_tokens < old.actual_reasoning_tokens
    or new.actual_total_tokens < old.actual_total_tokens
    or new.actual_microusd < old.actual_microusd
    or (
      not (old.state = 'planned' and new.state = 'reserved')
      and (
        new.remaining_reserved_input_tokens > old.remaining_reserved_input_tokens
        or new.remaining_reserved_output_tokens > old.remaining_reserved_output_tokens
        or new.remaining_reserved_microusd > old.remaining_reserved_microusd
      )
    ) then
    raise exception 'Gmail attachment model request immutable or monotonic fields changed'
      using errcode = '55000';
  end if;
  if old.state = 'planned' and new.state = 'reserved' then
    if new.reservation_date is null or new.reserved_at is null
      or new.initial_reserved_input_tokens <= 0
      or new.initial_reserved_output_tokens <= 0
      or new.initial_reserved_microusd <= 0
      or new.remaining_reserved_input_tokens <> new.initial_reserved_input_tokens
      or new.remaining_reserved_output_tokens <> new.initial_reserved_output_tokens
      or new.remaining_reserved_microusd <> new.initial_reserved_microusd then
      raise exception 'Gmail attachment model request reservation is incomplete'
        using errcode = '55000';
    end if;
  elsif row(new.reservation_date, new.initial_reserved_input_tokens,
      new.initial_reserved_output_tokens, new.initial_reserved_microusd, new.reserved_at)
      is distinct from row(old.reservation_date, old.initial_reserved_input_tokens,
      old.initial_reserved_output_tokens, old.initial_reserved_microusd, old.reserved_at) then
    raise exception 'Gmail attachment model reservation identity changed'
      using errcode = '55000';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'planned' and new.state = any(array['reserved', 'review_required']))
    or (old.state = 'reserved' and new.state = any(array['in_flight', 'review_required']))
    or (old.state = 'in_flight' and new.state = any(array[
      'reserved', 'succeeded', 'review_required', 'outcome_unknown'
    ]))
  ) then
    raise exception 'Gmail attachment model request state transition is invalid'
      using errcode = '55000';
  end if;
  if row(new.completion_observation_id, new.completion_claim_job_id,
      new.completion_resolution_id, new.canonical_completion_receipt,
      new.completion_receipt_hash, new.evidence_finalized_at)
      is distinct from row(old.completion_observation_id, old.completion_claim_job_id,
      old.completion_resolution_id, old.canonical_completion_receipt,
      old.completion_receipt_hash, old.evidence_finalized_at)
    and not (
      old.completion_observation_id is null
      and new.completion_observation_id is not null
      and new.state = 'succeeded'
    ) then
    raise exception 'Gmail attachment model completion identity changed'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists gmail_attachment_model_request_guard
  on public.gmail_attachment_model_requests;
create trigger gmail_attachment_model_request_guard
before update or delete on public.gmail_attachment_model_requests
for each row execute function private.guard_gmail_attachment_model_request_update();

drop trigger if exists gmail_attachment_model_dispatch_immutable
  on public.gmail_attachment_model_attempt_dispatches;
create trigger gmail_attachment_model_dispatch_immutable
before update or delete on public.gmail_attachment_model_attempt_dispatches
for each row execute function public.reject_immutable_truth_mutation();

drop trigger if exists gmail_attachment_model_outcome_immutable
  on public.gmail_attachment_model_attempt_outcomes;
create trigger gmail_attachment_model_outcome_immutable
before update or delete on public.gmail_attachment_model_attempt_outcomes
for each row execute function public.reject_immutable_truth_mutation();

do $acl$
declare v_table text;
begin
  foreach v_table in array array[
    'gmail_attachment_model_requests',
    'gmail_attachment_model_attempt_dispatches',
    'gmail_attachment_model_attempt_outcomes'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select on table public.%I to service_role', v_table);
    execute format('revoke insert, update, delete, truncate on table public.%I from service_role', v_table);
  end loop;
end;
$acl$;

create or replace function private.require_live_truth_gmail_attachment_model_job(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text
)
returns public.source_processing_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_job public.source_processing_jobs%rowtype;
begin
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or p_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null then
    raise exception 'Gmail attachment model lease authority is invalid'
      using errcode = '22023';
  end if;
  if not private.truth_shadow_model_commissioning_job_allowed(
    p_workspace_key, p_job_id
  ) then
    raise exception 'Gmail attachment model job is outside the sealed shadow commissioning scope'
      using errcode = '42501';
  end if;
  select * into v_job
  from public.source_processing_jobs job
  where job.workspace_key = p_workspace_key
    and job.job_id = p_job_id
    and job.source_system = 'gmail'
    and job.connection_key like 'shadow-%'
    and job.job_kind = 'gmail_review_attachment_extraction'
    and job.state = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_fence = p_lease_fence
    and job.processor_version = p_processor_version
    and job.lease_expires_at is not null
    and job.lease_expires_at > clock_timestamp()
  for share;
  if not found then
    raise exception 'Gmail attachment model source job lease is stale or unavailable'
      using errcode = '40001';
  end if;
  return v_job;
end;
$function$;

create or replace function private.truth_gmail_attachment_model_request_receipt(
  p_request_id text,
  p_idempotent boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'ok', request.state <> all(array['review_required', 'outcome_unknown']),
    'idempotent', p_idempotent,
    'schemaVersion', 'gmail-attachment-model-request-receipt-v1',
    'workspaceKey', request.workspace_key,
    'jobId', request.source_job_id,
    'requestId', request.request_id,
    'requestHash', request.request_hash,
    'state', request.state,
    'observationId', request.source_observation_id,
    'observationContentHash', request.source_observation_content_hash,
    'rawSha256', request.raw_sha256,
    'requestBodyHash', request.request_body_hash,
    'requestBodyBytes', request.request_body_bytes,
    'modelSnapshot', request.model_snapshot,
    'promptVersion', request.prompt_version,
    'responseSchemaVersion', request.response_schema_version,
    'responseSchemaHash', request.response_schema_hash,
    'processingConfigVersion', request.processing_config_version,
    'processingConfigHash', request.processing_config_hash,
    'pricingPolicyId', request.pricing_policy_id,
    'pricingPolicyHash', request.pricing_policy_hash,
    'maxInputTokens', request.max_input_tokens,
    'maxOutputTokens', request.max_output_tokens,
    'maxAttempts', request.max_attempts,
    'attemptCount', (
      select count(*)::integer from public.gmail_attachment_model_attempt_dispatches dispatch
      where dispatch.request_id = request.request_id
    ),
    'reviewReason', request.review_reason,
    'reservedMicroUsd', request.remaining_reserved_microusd,
    'actualMicroUsd', request.actual_microusd,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  )
  from public.gmail_attachment_model_requests request
  where request.request_id = p_request_id;
$function$;

create or replace function private.truth_gmail_attachment_model_dispatch_receipt(
  p_dispatch_id text,
  p_idempotent boolean,
  p_send_authorized boolean
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
    'sendAuthorized', p_send_authorized,
    'schemaVersion', 'gmail-attachment-model-dispatch-receipt-v1',
    'workspaceKey', dispatch.workspace_key,
    'requestId', dispatch.request_id,
    'dispatchId', dispatch.dispatch_id,
    'attemptNumber', dispatch.attempt_number,
    'clientRequestId', dispatch.client_request_id,
    'requestBodyHash', dispatch.request_body_hash,
    'requestBodyBytes', dispatch.request_body_bytes,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  )
  from public.gmail_attachment_model_attempt_dispatches dispatch
  where dispatch.dispatch_id = p_dispatch_id;
$function$;

create or replace function private.load_truth_gmail_attachment_model_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_observation public.source_observations%rowtype;
  v_lineage public.source_processing_job_lineage%rowtype;
  v_target record;
  v_attachment_id text;
  v_parent_observation_id text;
  v_message_id text;
  v_thread_id text;
  v_history_id text;
  v_filename text;
  v_mime_type text;
  v_raw_sha256 text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  v_job := private.require_live_truth_gmail_attachment_model_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select * into v_observation
  from public.source_observations observation
  where observation.workspace_key = p_workspace_key
    and observation.observation_id = v_job.observation_id;
  select * into v_lineage
  from public.source_processing_job_lineage lineage
  where lineage.job_id = v_job.job_id;
  select * into v_target
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where unresolved.review_job_id = v_job.job_id
    and unresolved.attachment_observation_id = v_job.observation_id;

  if v_observation.observation_id is null
    or v_lineage.job_id is null
    or v_target.review_job_id is null
    or v_observation.source_system <> 'gmail'
    or v_observation.connection_key is distinct from v_job.connection_key
    or v_observation.source_object_type <> 'gmail_attachment_extracted'
    or v_observation.operation <> 'content'
    or v_observation.normalized_payload->>'schemaVersion'
      <> 'gmail-attachment-extracted-v1'
    or v_observation.content_hash is distinct from v_target.attachment_content_hash
    or v_lineage.workspace_key is distinct from v_job.workspace_key
    or v_lineage.source_system is distinct from v_job.source_system
    or v_lineage.connection_key is distinct from v_job.connection_key
    or v_lineage.root_batch_id is distinct from v_observation.batch_id
    or v_lineage.source_cursor_version is distinct from v_observation.source_cursor_version then
    raise exception 'Gmail attachment model context is stale or outside immutable lineage'
      using errcode = '23514';
  end if;

  v_attachment_id := coalesce(v_observation.normalized_payload->>'attachmentId', '');
  v_parent_observation_id := coalesce(
    v_observation.normalized_payload->>'parentObservationId', ''
  );
  v_message_id := coalesce(v_observation.normalized_payload->'gmail'->>'messageId', '');
  v_thread_id := coalesce(v_observation.normalized_payload->'gmail'->>'threadId', '');
  v_history_id := coalesce(v_observation.normalized_payload->'gmail'->>'historyId', '');
  v_filename := coalesce(v_observation.normalized_payload->>'filename', '');
  v_mime_type := coalesce(
    nullif(v_observation.normalized_payload->>'mimeType', ''),
    nullif(v_observation.raw_content_type, ''),
    ''
  );
  v_raw_sha256 := coalesce(v_observation.normalized_payload->>'rawSha256', '');

  if nullif(v_attachment_id, '') is null
    or v_parent_observation_id !~ '^obs:v1:[0-9a-f]{64}$'
    or nullif(v_message_id, '') is null
    or v_history_id !~ '^[0-9]+$'
    or nullif(v_mime_type, '') is null
    or v_raw_sha256 !~ '^[0-9a-f]{64}$'
    or v_raw_sha256 is distinct from v_observation.raw_object_hash
    or v_observation.raw_object_bucket is null
    or v_observation.raw_object_key is null
    or v_observation.raw_object_bytes is null
    or v_observation.raw_object_bytes < 1
    or v_observation.raw_object_bytes > 52428799
    or nullif(v_observation.raw_content_type, '') is null
    or v_job.payload->>'attachmentObservationId' is distinct from v_observation.observation_id
    or v_job.payload->>'attachmentObservationContentHash'
      is distinct from v_observation.content_hash
    or v_job.payload->>'rawSha256' is distinct from v_raw_sha256 then
    raise exception 'Gmail attachment model context lacks exact raw-object provenance'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'gmail-attachment-model-context-v1',
    'workspaceKey', p_workspace_key,
    'jobId', v_job.job_id,
    'workerId', p_worker_id,
    'leaseFence', p_lease_fence,
    'processorVersion', p_processor_version,
    'jobKind', v_job.job_kind,
    'connectionKey', v_job.connection_key,
    'rootBatchId', v_lineage.root_batch_id,
    'observationId', v_observation.observation_id,
    'observationContentHash', v_observation.content_hash,
    'attachmentId', v_attachment_id,
    'parentObservationId', v_parent_observation_id,
    'messageId', v_message_id,
    'threadId', v_thread_id,
    'historyId', v_history_id,
    'filename', v_filename,
    'mimeType', v_mime_type,
    'rawSha256', v_raw_sha256,
    'rawBytes', v_observation.raw_object_bytes,
    'rawObject', jsonb_strip_nulls(jsonb_build_object(
      'bucket', v_observation.raw_object_bucket,
      'key', v_observation.raw_object_key,
      'version', v_observation.raw_object_version,
      'etag', v_observation.raw_object_etag,
      'hash', v_observation.raw_object_hash,
      'bytes', v_observation.raw_object_bytes,
      'contentType', v_observation.raw_content_type
    )),
    'shadowOnly', true,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.load_truth_gmail_attachment_model_context(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.load_truth_gmail_attachment_model_context(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_sync_token
  );
$function$;

create or replace function private.create_truth_gmail_attachment_model_request(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_body_hash text,
  p_request_body_bytes integer,
  p_model_snapshot text,
  p_prompt_version text,
  p_response_schema_version text,
  p_response_schema_hash text,
  p_processing_config_version text,
  p_processing_config_hash text,
  p_max_input_tokens integer,
  p_max_output_tokens integer,
  p_max_attempts integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_policy public.truth_model_pricing_policies%rowtype;
  v_canonical jsonb;
  v_hash text;
  v_request_id text;
  v_existing public.gmail_attachment_model_requests%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if coalesce(p_request_body_hash, '') !~ '^[0-9a-f]{64}$'
    or p_request_body_bytes is null or p_request_body_bytes < 1
    or p_request_body_bytes > 78643200
    or p_model_snapshot is distinct from 'gpt-5-nano-2025-08-07'
    or p_prompt_version is distinct from 'gmail-attachment-operational-extraction-v1'
    or p_response_schema_version
      is distinct from 'gmail-attachment-model-extraction-result-v1'
    or p_response_schema_hash
      is distinct from 'f4cf82f32e2f66f325212bfb7e75657c6dd298d7f6e8fe4526dbda1fc8f84684'
    or p_processing_config_version
      is distinct from 'gmail-attachment-model-processing-config-v1'
    or p_processing_config_hash
      is distinct from '8d1b7f10f68ad9e953e57545835582f6da4e3a6f78d9c014bde176e74456cdd3'
    or p_max_input_tokens is distinct from 390000
    or p_max_output_tokens is distinct from 8192
    or p_max_attempts is distinct from 3 then
    raise exception 'Gmail attachment model request escapes pinned authority'
      using errcode = '23514';
  end if;

  v_context := private.load_truth_gmail_attachment_model_context(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_sync_token
  );
  select * into v_policy
  from public.truth_model_pricing_policies policy
  where policy.model_snapshot = p_model_snapshot
    and policy.transport = 'sync'
    and policy.pricing_version = 'openai-public-pricing-2026-07-09';
  if not found then
    raise exception 'Gmail attachment model pinned pricing policy is unavailable'
      using errcode = '23503';
  end if;

  v_canonical := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-model-request-v1',
    'workspaceKey', p_workspace_key,
    'connectionKey', v_context->>'connectionKey',
    'jobId', p_job_id,
    'rootBatchId', v_context->>'rootBatchId',
    'observationId', v_context->>'observationId',
    'observationContentHash', v_context->>'observationContentHash',
    'sourceAttachmentId', v_context->>'attachmentId',
    'sourceParentObservationId', v_context->>'parentObservationId',
    'sourceMessageId', v_context->>'messageId',
    'sourceThreadId', v_context->>'threadId',
    'sourceHistoryId', v_context->>'historyId',
    'filename', v_context->>'filename',
    'mimeType', v_context->>'mimeType',
    'rawObject', v_context->'rawObject',
    'requestBodyHash', p_request_body_hash,
    'requestBodyBytes', p_request_body_bytes,
    'modelSnapshot', p_model_snapshot,
    'promptVersion', p_prompt_version,
    'responseSchemaVersion', p_response_schema_version,
    'responseSchemaHash', p_response_schema_hash,
    'processingConfigVersion', p_processing_config_version,
    'processingConfigHash', p_processing_config_hash,
    'pricingPolicyId', v_policy.pricing_policy_id,
    'pricingPolicyHash', v_policy.policy_hash,
    'transport', 'sync',
    'maxInputTokens', p_max_input_tokens,
    'maxOutputTokens', p_max_output_tokens,
    'maxAttempts', p_max_attempts
  );
  v_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical), 'UTF8'
  ), 'sha256'), 'hex');
  v_request_id := 'gmail-attachment-model-request:v1:' || v_hash;

  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-attachment-model-request:' || p_workspace_key || ':' || p_job_id::text, 0
  ));
  select * into v_existing
  from public.gmail_attachment_model_requests request
  where request.workspace_key = p_workspace_key
    and request.source_job_id = p_job_id;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      raise exception 'Gmail attachment model request conflicts with its sealed source job'
        using errcode = '23505';
    end if;
    return private.truth_gmail_attachment_model_request_receipt(
      v_existing.request_id, true
    );
  end if;

  insert into public.gmail_attachment_model_requests (
    request_id, request_hash, workspace_key, connection_key, source_job_id,
    root_batch_id, source_observation_id, source_observation_content_hash,
    source_attachment_id, source_parent_observation_id, source_message_id,
    source_thread_id, source_history_id, filename, mime_type,
    raw_object_bucket, raw_object_key, raw_object_version, raw_object_etag,
    raw_sha256, raw_bytes, raw_content_type,
    request_body_hash, request_body_bytes, model_snapshot, prompt_version,
    response_schema_version, response_schema_hash, processing_config_version,
    processing_config_hash, pricing_policy_id, pricing_policy_hash,
    max_input_tokens, max_output_tokens, max_attempts, canonical_request
  ) values (
    v_request_id, v_hash, p_workspace_key, v_context->>'connectionKey', p_job_id,
    (v_context->>'rootBatchId')::uuid, v_context->>'observationId',
    v_context->>'observationContentHash', v_context->>'attachmentId',
    v_context->>'parentObservationId', v_context->>'messageId',
    v_context->>'threadId', v_context->>'historyId', v_context->>'filename',
    v_context->>'mimeType', v_context #>> '{rawObject,bucket}',
    v_context #>> '{rawObject,key}', nullif(v_context #>> '{rawObject,version}', ''),
    nullif(v_context #>> '{rawObject,etag}', ''), v_context->>'rawSha256',
    (v_context->>'rawBytes')::bigint, v_context #>> '{rawObject,contentType}',
    p_request_body_hash, p_request_body_bytes, p_model_snapshot, p_prompt_version,
    p_response_schema_version, p_response_schema_hash, p_processing_config_version,
    p_processing_config_hash, v_policy.pricing_policy_id, v_policy.policy_hash,
    p_max_input_tokens, p_max_output_tokens, p_max_attempts, v_canonical
  );
  return private.truth_gmail_attachment_model_request_receipt(v_request_id, false);
end;
$function$;

create or replace function public.create_truth_gmail_attachment_model_request(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_body_hash text,
  p_request_body_bytes integer,
  p_model_snapshot text,
  p_prompt_version text,
  p_response_schema_version text,
  p_response_schema_hash text,
  p_processing_config_version text,
  p_processing_config_hash text,
  p_max_input_tokens integer,
  p_max_output_tokens integer,
  p_max_attempts integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.create_truth_gmail_attachment_model_request(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_request_body_hash, p_request_body_bytes,
    p_model_snapshot, p_prompt_version, p_response_schema_version,
    p_response_schema_hash, p_processing_config_version,
    p_processing_config_hash, p_max_input_tokens, p_max_output_tokens,
    p_max_attempts, p_sync_token
  );
$function$;

create or replace function private.reserve_truth_gmail_attachment_model_request(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_usage_date date := (clock_timestamp() at time zone 'UTC')::date;
  v_request public.gmail_attachment_model_requests%rowtype;
  v_account public.truth_model_workspace_accounts%rowtype;
  v_daily public.truth_model_workspace_daily_usage%rowtype;
  v_per_attempt_microusd bigint;
  v_reserved_microusd bigint;
  v_reserved_input bigint;
  v_reserved_output bigint;
  v_reason text := '';
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  perform private.require_live_truth_gmail_attachment_model_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select * into v_request
  from public.gmail_attachment_model_requests request
  where request.workspace_key = p_workspace_key
    and request.request_id = p_request_id
    and request.source_job_id = p_job_id
  for update;
  if not found then
    raise exception 'Gmail attachment model request is unavailable'
      using errcode = '23503';
  end if;
  if v_request.state <> 'planned' then
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, true
    );
  end if;

  select * into v_account
  from public.truth_model_workspace_accounts account
  where account.workspace_key = p_workspace_key
  for update;
  if not found or v_account.status <> 'enabled' then
    update public.gmail_attachment_model_requests request
    set state = 'review_required',
        review_reason = 'MODEL_ACCOUNT_DISABLED',
        provider_finalized_at = v_now,
        updated_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, false
    );
  end if;

  insert into public.truth_model_workspace_daily_usage(workspace_key, usage_date)
  values (p_workspace_key, v_usage_date)
  on conflict (workspace_key, usage_date) do nothing;
  select * into v_daily
  from public.truth_model_workspace_daily_usage usage
  where usage.workspace_key = p_workspace_key
    and usage.usage_date = v_usage_date
  for update;

  v_per_attempt_microusd := private.truth_model_usage_cost(
    v_request.pricing_policy_id,
    v_request.max_input_tokens,
    0,
    v_request.max_output_tokens
  );
  v_reserved_microusd := v_per_attempt_microusd * v_request.max_attempts;
  v_reserved_input := v_request.max_input_tokens::bigint * v_request.max_attempts;
  v_reserved_output := v_request.max_output_tokens::bigint * v_request.max_attempts;
  if v_account.actual_microusd + v_account.reserved_microusd
      + v_reserved_microusd > v_account.lifetime_allocation_microusd then
    v_reason := 'MODEL_LIFETIME_BUDGET_EXHAUSTED';
  elsif v_daily.actual_microusd + v_daily.reserved_microusd
      + v_reserved_microusd > v_account.daily_ceiling_microusd then
    v_reason := 'MODEL_DAILY_BUDGET_EXHAUSTED';
  end if;
  if v_reason <> '' then
    update public.gmail_attachment_model_requests request
    set state = 'review_required', review_reason = v_reason,
        provider_finalized_at = v_now, updated_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, false
    );
  end if;

  update public.truth_model_workspace_accounts account
  set reserved_microusd = account.reserved_microusd + v_reserved_microusd,
      updated_at = v_now
  where account.workspace_key = p_workspace_key;
  update public.truth_model_workspace_daily_usage usage
  set reserved_input_tokens = usage.reserved_input_tokens + v_reserved_input,
      reserved_output_tokens = usage.reserved_output_tokens + v_reserved_output,
      reserved_microusd = usage.reserved_microusd + v_reserved_microusd,
      updated_at = v_now
  where usage.workspace_key = p_workspace_key
    and usage.usage_date = v_usage_date;
  update public.gmail_attachment_model_requests request
  set state = 'reserved', reservation_date = v_usage_date,
      initial_reserved_input_tokens = v_reserved_input,
      initial_reserved_output_tokens = v_reserved_output,
      remaining_reserved_input_tokens = v_reserved_input,
      remaining_reserved_output_tokens = v_reserved_output,
      initial_reserved_microusd = v_reserved_microusd,
      remaining_reserved_microusd = v_reserved_microusd,
      reserved_at = v_now,
      updated_at = v_now
  where request.request_id = v_request.request_id;
  return private.truth_gmail_attachment_model_request_receipt(
    v_request.request_id, false
  );
end;
$function$;

create or replace function public.reserve_truth_gmail_attachment_model_request(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.reserve_truth_gmail_attachment_model_request(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_request_id, p_sync_token
  );
$function$;

create or replace function private.begin_truth_gmail_attachment_model_attempt(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.gmail_attachment_model_requests%rowtype;
  v_dispatch public.gmail_attachment_model_attempt_dispatches%rowtype;
  v_account public.truth_model_workspace_accounts%rowtype;
  v_attempt_number integer;
  v_canonical jsonb;
  v_hash text;
  v_id text;
  v_client_request_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  perform private.require_live_truth_gmail_attachment_model_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select * into v_request
  from public.gmail_attachment_model_requests request
  where request.workspace_key = p_workspace_key
    and request.request_id = p_request_id
    and request.source_job_id = p_job_id
  for update;
  if not found then
    raise exception 'Gmail attachment model request is unavailable'
      using errcode = '23503';
  end if;

  if v_request.state = 'in_flight' then
    select dispatch.* into v_dispatch
    from public.gmail_attachment_model_attempt_dispatches dispatch
    left join public.gmail_attachment_model_attempt_outcomes outcome
      on outcome.dispatch_id = dispatch.dispatch_id
    where dispatch.request_id = v_request.request_id
      and outcome.outcome_id is null
    order by dispatch.attempt_number desc
    limit 1;
    if not found then
      raise exception 'Gmail attachment model in-flight request lacks its dispatch'
        using errcode = '23514';
    end if;
    -- The prior authorization might already have crossed the provider wire.
    -- Persist uncertainty and never mint or replay a second send authority.
    update public.gmail_attachment_model_requests request
    set state = 'outcome_unknown',
        review_reason = 'DISPATCH_REPLAY_OUTCOME_UNKNOWN',
        provider_finalized_at = v_now,
        updated_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, true
    ) || jsonb_build_object('sendAuthorized', false);
  end if;
  if v_request.state <> 'reserved' then
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, true
    ) || jsonb_build_object('sendAuthorized', false);
  end if;

  select * into v_account
  from public.truth_model_workspace_accounts account
  where account.workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'Gmail attachment model account disappeared after reservation'
      using errcode = '23514';
  end if;
  if v_account.status <> 'enabled' then
    if v_account.reserved_microusd < v_request.remaining_reserved_microusd then
      raise exception 'Gmail attachment model account reservation underflow'
        using errcode = '23514';
    end if;
    update public.truth_model_workspace_accounts account
    set reserved_microusd = account.reserved_microusd
          - v_request.remaining_reserved_microusd,
        updated_at = v_now
    where account.workspace_key = p_workspace_key;
    update public.truth_model_workspace_daily_usage usage
    set reserved_input_tokens = usage.reserved_input_tokens
          - v_request.remaining_reserved_input_tokens,
        reserved_output_tokens = usage.reserved_output_tokens
          - v_request.remaining_reserved_output_tokens,
        reserved_microusd = usage.reserved_microusd
          - v_request.remaining_reserved_microusd,
        updated_at = v_now
    where usage.workspace_key = p_workspace_key
      and usage.usage_date = v_request.reservation_date
      and usage.reserved_input_tokens >= v_request.remaining_reserved_input_tokens
      and usage.reserved_output_tokens >= v_request.remaining_reserved_output_tokens
      and usage.reserved_microusd >= v_request.remaining_reserved_microusd;
    if not found then
      raise exception 'Gmail attachment model daily reservation underflow'
        using errcode = '23514';
    end if;
    update public.gmail_attachment_model_requests request
    set state = 'review_required',
        review_reason = 'MODEL_ACCOUNT_DISABLED_BEFORE_SEND',
        remaining_reserved_input_tokens = 0,
        remaining_reserved_output_tokens = 0,
        remaining_reserved_microusd = 0,
        provider_finalized_at = v_now,
        updated_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, false
    ) || jsonb_build_object('sendAuthorized', false);
  end if;

  select count(*)::integer + 1 into v_attempt_number
  from public.gmail_attachment_model_attempt_dispatches dispatch
  where dispatch.request_id = v_request.request_id;
  if v_attempt_number > v_request.max_attempts then
    raise exception 'Gmail attachment model attempt cap is exhausted'
      using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.gmail_attachment_model_attempt_dispatches dispatch
    left join public.gmail_attachment_model_attempt_outcomes outcome
      on outcome.dispatch_id = dispatch.dispatch_id
    where dispatch.request_id = v_request.request_id
      and outcome.outcome_id is null
  ) then
    raise exception 'Gmail attachment model prior dispatch lacks a durable outcome'
      using errcode = '55000';
  end if;

  v_client_request_id := 'gmail-attachment-model-client:v1:' || encode(
    extensions.digest(convert_to(
      v_request.request_id || ':' || v_attempt_number::text, 'UTF8'
    ), 'sha256'), 'hex'
  );
  v_canonical := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-model-dispatch-v1',
    'workspaceKey', p_workspace_key,
    'requestId', v_request.request_id,
    'attemptNumber', v_attempt_number,
    'clientRequestId', v_client_request_id,
    'requestBodyHash', v_request.request_body_hash,
    'requestBodyBytes', v_request.request_body_bytes,
    'authorizationWorkerId', p_worker_id,
    'authorizationLeaseFence', p_lease_fence,
    'authorizationProcessorVersion', p_processor_version
  );
  v_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical), 'UTF8'
  ), 'sha256'), 'hex');
  v_id := 'gmail-attachment-model-dispatch:v1:' || v_hash;
  insert into public.gmail_attachment_model_attempt_dispatches (
    dispatch_id, dispatch_hash, workspace_key, request_id, attempt_number,
    client_request_id, request_body_hash, request_body_bytes,
    authorization_worker_id, authorization_lease_fence,
    authorization_processor_version, authorization_lease_expires_at,
    canonical_dispatch
  ) values (
    v_id, v_hash, p_workspace_key, v_request.request_id, v_attempt_number,
    v_client_request_id, v_request.request_body_hash, v_request.request_body_bytes,
    p_worker_id, p_lease_fence, p_processor_version,
    (select job.lease_expires_at from public.source_processing_jobs job
      where job.job_id = p_job_id),
    v_canonical
  ) returning * into v_dispatch;
  update public.gmail_attachment_model_requests request
  set state = 'in_flight', updated_at = v_now
  where request.request_id = v_request.request_id;
  return private.truth_gmail_attachment_model_dispatch_receipt(
    v_dispatch.dispatch_id, false, true
  );
end;
$function$;

create or replace function public.begin_truth_gmail_attachment_model_attempt(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.begin_truth_gmail_attachment_model_attempt(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_request_id, p_sync_token
  );
$function$;

create or replace function private.reconcile_truth_gmail_attachment_model_attempt(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_provider_result jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.gmail_attachment_model_requests%rowtype;
  v_dispatch public.gmail_attachment_model_attempt_dispatches%rowtype;
  v_existing public.gmail_attachment_model_attempt_outcomes%rowtype;
  v_provider_hash text;
  v_classification text;
  v_usage jsonb;
  v_model_response jsonb;
  v_input_tokens bigint := 0;
  v_cached_input_tokens bigint := 0;
  v_output_tokens bigint := 0;
  v_reasoning_tokens bigint := 0;
  v_total_tokens bigint := 0;
  v_cost bigint := 0;
  v_unknown boolean := false;
  v_known_zero_cost boolean := false;
  v_retryable boolean := false;
  v_terminal boolean := true;
  v_canonical jsonb;
  v_hash text;
  v_outcome_id text;
  v_reason text := '';
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  perform private.require_live_truth_gmail_attachment_model_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if jsonb_typeof(coalesce(p_provider_result, 'null'::jsonb)) <> 'object'
    or (select count(*) from jsonb_object_keys(p_provider_result)) <> 23
    or not (p_provider_result ?& array[
      'schemaVersion', 'classification', 'retryable', 'requestSent',
      'outcomeUnknown', 'billingOutcomeUnknown', 'requestId', 'dispatchId',
      'attemptNumber', 'clientRequestId', 'requestBodyHash', 'requestBodyBytes',
      'httpStatus', 'providerResponseBodyHash', 'providerResponseBodyBytes',
      'providerResponseId', 'serverRequestId', 'actualModel',
      'providerErrorCode', 'incompleteReason', 'usage', 'modelResponse',
      'providerResultHash'
    ])
    or p_provider_result->>'schemaVersion'
      is distinct from 'openai-gmail-attachment-model-attempt-v1'
    or jsonb_typeof(p_provider_result->'classification') <> 'string'
    or jsonb_typeof(p_provider_result->'retryable') <> 'boolean'
    or jsonb_typeof(p_provider_result->'requestSent') <> 'boolean'
    or jsonb_typeof(p_provider_result->'outcomeUnknown') <> 'boolean'
    or jsonb_typeof(p_provider_result->'billingOutcomeUnknown') <> 'boolean'
    or jsonb_typeof(p_provider_result->'requestId') <> 'string'
    or jsonb_typeof(p_provider_result->'dispatchId') <> 'string'
    or jsonb_typeof(p_provider_result->'attemptNumber') <> 'number'
    or (p_provider_result->>'attemptNumber') !~ '^[1-3]$'
    or jsonb_typeof(p_provider_result->'clientRequestId') <> 'string'
    or nullif(trim(p_provider_result->>'clientRequestId'), '') is null
    or jsonb_typeof(p_provider_result->'requestBodyHash') <> 'string'
    or coalesce(p_provider_result->>'requestBodyHash', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_provider_result->'requestBodyBytes') <> 'number'
    or (p_provider_result->>'requestBodyBytes') !~ '^[1-9][0-9]*$'
    or (p_provider_result->>'requestBodyBytes')::numeric > 78643200
    or jsonb_typeof(p_provider_result->'providerResponseBodyHash') <> 'string'
    or jsonb_typeof(p_provider_result->'providerResponseBodyBytes') <> 'number'
    or (p_provider_result->>'providerResponseBodyBytes') !~ '^[0-9]+$'
    or (p_provider_result->>'providerResponseBodyBytes')::numeric > 2097152
    or jsonb_typeof(p_provider_result->'providerResponseId') <> 'string'
    or jsonb_typeof(p_provider_result->'serverRequestId') <> 'string'
    or jsonb_typeof(p_provider_result->'actualModel') <> 'string'
    or jsonb_typeof(p_provider_result->'providerErrorCode') <> 'string'
    or jsonb_typeof(p_provider_result->'incompleteReason') <> 'string'
    or jsonb_typeof(p_provider_result->'providerResultHash') <> 'string'
    or coalesce(p_provider_result->>'providerResultHash', '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_provider_result->'usage') not in ('object', 'null')
    or jsonb_typeof(p_provider_result->'modelResponse') not in ('object', 'null')
    or jsonb_typeof(p_provider_result->'httpStatus') not in ('number', 'null') then
    raise exception 'Gmail attachment model provider result envelope is invalid'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_provider_result->'httpStatus') = 'number'
    and ((p_provider_result->>'httpStatus') !~ '^[1-5][0-9]{2}$') then
    raise exception 'Gmail attachment model HTTP status is invalid'
      using errcode = '22023';
  end if;

  v_provider_hash := encode(extensions.digest(convert_to(
    (p_provider_result - 'providerResultHash')::text, 'UTF8'
  ), 'sha256'), 'hex');
  if p_provider_result->>'providerResultHash' is distinct from v_provider_hash then
    raise exception 'Gmail attachment model provider result hash is invalid'
      using errcode = '23514';
  end if;
  v_classification := p_provider_result->>'classification';
  if v_classification <> all(array[
      'succeeded', 'refusal', 'incomplete', 'content_filter',
      'malformed_output', 'insufficient_quota', 'configuration_error',
      'rate_limit_exceeded', 'server_error', 'outcome_unknown'
    ]) then
    raise exception 'Gmail attachment model provider classification is invalid'
      using errcode = '22023';
  end if;

  select * into v_request
  from public.gmail_attachment_model_requests request
  where request.workspace_key = p_workspace_key
    and request.request_id = p_request_id
    and request.source_job_id = p_job_id
  for update;
  if not found then
    raise exception 'Gmail attachment model request is unavailable'
      using errcode = '23503';
  end if;
  select * into v_dispatch
  from public.gmail_attachment_model_attempt_dispatches dispatch
  where dispatch.workspace_key = p_workspace_key
    and dispatch.request_id = v_request.request_id
    and dispatch.dispatch_id = p_provider_result->>'dispatchId'
    and dispatch.attempt_number = (p_provider_result->>'attemptNumber')::integer;
  if not found then
    raise exception 'Gmail attachment model dispatch is unavailable'
      using errcode = '23503';
  end if;
  if p_provider_result->>'requestId' is distinct from v_request.request_id
    or p_provider_result->>'clientRequestId' is distinct from v_dispatch.client_request_id
    or p_provider_result->>'requestBodyHash' is distinct from v_request.request_body_hash
    or (p_provider_result->>'requestBodyBytes')::integer
      is distinct from v_request.request_body_bytes
    or v_dispatch.request_body_hash is distinct from v_request.request_body_hash
    or v_dispatch.request_body_bytes is distinct from v_request.request_body_bytes
    or v_dispatch.authorization_worker_id is distinct from p_worker_id
    or v_dispatch.authorization_lease_fence is distinct from p_lease_fence
    or v_dispatch.authorization_processor_version is distinct from p_processor_version then
    raise exception 'Gmail attachment model provider result differs from dispatch authority'
      using errcode = '23514';
  end if;

  select * into v_existing
  from public.gmail_attachment_model_attempt_outcomes outcome
  where outcome.dispatch_id = v_dispatch.dispatch_id;
  if found then
    if v_existing.provider_result_hash is distinct from v_provider_hash then
      raise exception 'Gmail attachment model outcome conflicts on replay'
        using errcode = '23505';
    end if;
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, true
    );
  end if;
  if v_request.state <> 'in_flight' then
    raise exception 'Gmail attachment model request is not awaiting this outcome'
      using errcode = '55000';
  end if;
  if (p_provider_result->>'requestSent')::boolean is not true then
    raise exception 'Gmail attachment model dispatched attempt cannot claim it was unsent'
      using errcode = '23514';
  end if;
  if not (
    (coalesce(p_provider_result->>'providerResponseBodyHash', '') = ''
      and (p_provider_result->>'providerResponseBodyBytes')::integer = 0)
    or
    (coalesce(p_provider_result->>'providerResponseBodyHash', '') ~ '^[0-9a-f]{64}$'
      and (p_provider_result->>'providerResponseBodyBytes')::integer > 0)
  ) then
    raise exception 'Gmail attachment model response body receipt is invalid'
      using errcode = '23514';
  end if;

  v_usage := p_provider_result->'usage';
  if jsonb_typeof(v_usage) = 'object' then
    if (select count(*) from jsonb_object_keys(v_usage)) <> 5
      or not (v_usage ?& array[
        'inputTokens', 'cachedInputTokens', 'outputTokens',
        'reasoningTokens', 'totalTokens'
      ])
      or exists (
        select 1
        from jsonb_each(v_usage) item
        where jsonb_typeof(item.value) <> 'number'
          or (item.value #>> '{}') !~ '^[0-9]+$'
      ) then
      raise exception 'Gmail attachment model usage receipt is invalid'
        using errcode = '23514';
    end if;
    v_input_tokens := (v_usage->>'inputTokens')::bigint;
    v_cached_input_tokens := (v_usage->>'cachedInputTokens')::bigint;
    v_output_tokens := (v_usage->>'outputTokens')::bigint;
    v_reasoning_tokens := (v_usage->>'reasoningTokens')::bigint;
    v_total_tokens := (v_usage->>'totalTokens')::bigint;
    if v_cached_input_tokens > v_input_tokens
      or v_reasoning_tokens > v_output_tokens
      or v_total_tokens <> v_input_tokens + v_output_tokens
      or v_total_tokens <= 0
      or v_input_tokens > v_request.max_input_tokens
      or v_output_tokens > v_request.max_output_tokens then
      raise exception 'Gmail attachment model usage exceeds its sealed bounds'
        using errcode = '23514';
    end if;
  end if;

  v_model_response := p_provider_result->'modelResponse';
  if jsonb_typeof(v_model_response) = 'object' then
    if (select count(*) from jsonb_object_keys(v_model_response)) <> 4
      or not (v_model_response ?& array[
        'schemaVersion', 'documentText', 'coverage', 'warnings'
      ])
      or v_model_response->>'schemaVersion'
        is distinct from 'gmail-attachment-model-extraction-result-v1'
      or jsonb_typeof(v_model_response->'documentText') <> 'string'
      or nullif(trim(v_model_response->>'documentText'), '') is null
      or char_length(v_model_response->>'documentText') > 30000
      or jsonb_typeof(v_model_response->'coverage') <> 'object'
      or (select count(*) from jsonb_object_keys(v_model_response->'coverage')) <> 3
      or not ((v_model_response->'coverage') ?& array[
        'assessedAllPages', 'pageCount', 'pagesAssessed'
      ])
      or jsonb_typeof(v_model_response #> '{coverage,assessedAllPages}') <> 'boolean'
      or jsonb_typeof(v_model_response #> '{coverage,pageCount}') <> 'number'
      or jsonb_typeof(v_model_response #> '{coverage,pagesAssessed}') <> 'number'
      or (v_model_response #>> '{coverage,pageCount}') !~ '^[1-9][0-9]*$'
      or (v_model_response #>> '{coverage,pagesAssessed}') !~ '^[1-9][0-9]*$'
      or (v_model_response #>> '{coverage,pageCount}')::integer > 1000
      or (v_model_response #>> '{coverage,pagesAssessed}')::integer > 1000
      or (v_model_response #>> '{coverage,pagesAssessed}')::integer
        > (v_model_response #>> '{coverage,pageCount}')::integer
      or (v_model_response #>> '{coverage,assessedAllPages}')::boolean
        is distinct from (
          (v_model_response #>> '{coverage,pagesAssessed}')::integer
          = (v_model_response #>> '{coverage,pageCount}')::integer
        )
      or jsonb_typeof(v_model_response->'warnings') <> 'array'
      or jsonb_array_length(v_model_response->'warnings') > 20
      or exists (
        select 1
        from jsonb_array_elements(v_model_response->'warnings') warning
        where jsonb_typeof(warning) <> 'string'
          or nullif(trim(warning #>> '{}'), '') is null
          or char_length(warning #>> '{}') > 500
      ) then
      raise exception 'Gmail attachment model normalized response is invalid'
        using errcode = '23514';
    end if;
  end if;
  if v_classification = 'succeeded' then
    if jsonb_typeof(v_usage) <> 'object'
      or jsonb_typeof(v_model_response) <> 'object'
      or (v_model_response #>> '{coverage,assessedAllPages}')::boolean is not true
      or p_provider_result->>'actualModel'
        is distinct from 'gpt-5-nano-2025-08-07'
      or nullif(trim(p_provider_result->>'providerResponseId'), '') is null
      or nullif(trim(p_provider_result->>'serverRequestId'), '') is null
      or jsonb_typeof(p_provider_result->'httpStatus') <> 'number'
      or (p_provider_result->>'httpStatus')::integer < 200
      or (p_provider_result->>'httpStatus')::integer > 299
      or coalesce(p_provider_result->>'providerResponseBodyHash', '') = ''
      or (p_provider_result->>'outcomeUnknown')::boolean
      or (p_provider_result->>'billingOutcomeUnknown')::boolean
      or (p_provider_result->>'retryable')::boolean then
      raise exception 'Successful Gmail attachment model result lacks exact all-page evidence'
        using errcode = '23514';
    end if;
  elsif v_classification = 'incomplete' then
    if jsonb_typeof(v_model_response) = 'object'
      and (v_model_response #>> '{coverage,assessedAllPages}')::boolean then
      raise exception 'Incomplete Gmail attachment model result claims complete coverage'
        using errcode = '23514';
    end if;
  elsif jsonb_typeof(v_model_response) <> 'null' then
    raise exception 'Non-success Gmail attachment model result carries extracted evidence'
      using errcode = '23514';
  end if;

  v_unknown := (p_provider_result->>'outcomeUnknown')::boolean
    or (p_provider_result->>'billingOutcomeUnknown')::boolean
    or v_classification = 'outcome_unknown'
    or (
      jsonb_typeof(v_usage) = 'object'
      and p_provider_result->>'actualModel'
        is distinct from 'gpt-5-nano-2025-08-07'
    );
  v_known_zero_cost := not v_unknown
    and jsonb_typeof(v_usage) = 'null'
    and v_classification = any(array[
      'content_filter', 'insufficient_quota', 'configuration_error',
      'rate_limit_exceeded'
    ])
    and jsonb_typeof(p_provider_result->'httpStatus') = 'number'
    and (p_provider_result->>'httpStatus')::integer = any(array[
      400, 401, 403, 404, 409, 422, 429
    ])
    and coalesce(p_provider_result->>'providerResponseBodyHash', '') <> ''
    and nullif(trim(p_provider_result->>'providerErrorCode'), '') is not null;
  if not v_unknown and jsonb_typeof(v_usage) = 'null' and not v_known_zero_cost then
    raise exception 'Gmail attachment model response lacks trustworthy billing evidence'
      using errcode = '23514';
  end if;
  if not v_unknown and not v_known_zero_cost then
    if nullif(trim(p_provider_result->>'actualModel'), '') is null
      or p_provider_result->>'actualModel'
        is distinct from 'gpt-5-nano-2025-08-07'
      or coalesce(p_provider_result->>'providerResponseBodyHash', '') = '' then
      raise exception 'Billed Gmail attachment model response lacks pinned identity'
        using errcode = '23514';
    end if;
    v_cost := private.truth_model_usage_cost(
      v_request.pricing_policy_id,
      v_input_tokens,
      v_cached_input_tokens,
      v_output_tokens
    );
  end if;
  if not v_unknown and (
    v_input_tokens > v_request.remaining_reserved_input_tokens
    or v_output_tokens > v_request.remaining_reserved_output_tokens
    or v_cost > v_request.remaining_reserved_microusd
  ) then
    raise exception 'Gmail attachment model usage exceeds its remaining reservation'
      using errcode = '23514';
  end if;

  v_retryable := not v_unknown
    and (p_provider_result->>'retryable')::boolean
    and v_classification = any(array['rate_limit_exceeded', 'server_error'])
    and v_dispatch.attempt_number < v_request.max_attempts;
  if (p_provider_result->>'retryable')::boolean
    and v_classification <> all(array['rate_limit_exceeded', 'server_error']) then
    raise exception 'Gmail attachment model retry flag escapes retryable classes'
      using errcode = '23514';
  end if;
  v_terminal := not v_retryable;
  if v_classification = 'succeeded' then
    v_reason := '';
  elsif v_retryable then
    v_reason := '';
  elsif (p_provider_result->>'retryable')::boolean
      and v_dispatch.attempt_number >= v_request.max_attempts then
    v_reason := 'MODEL_ATTEMPT_CAP_EXHAUSTED';
  else
    v_reason := upper(v_classification);
  end if;

  v_canonical := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-model-outcome-v1',
    'workspaceKey', p_workspace_key,
    'requestId', v_request.request_id,
    'dispatchId', v_dispatch.dispatch_id,
    'attemptNumber', v_dispatch.attempt_number,
    'providerResultHash', v_provider_hash,
    'classification', v_classification,
    'requestSent', (p_provider_result->>'requestSent')::boolean,
    'outcomeUnknown', (p_provider_result->>'outcomeUnknown')::boolean,
    'billingOutcomeUnknown', (p_provider_result->>'billingOutcomeUnknown')::boolean,
    'actualMicroUsd', v_cost
  );
  v_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_canonical), 'UTF8'
  ), 'sha256'), 'hex');
  v_outcome_id := 'gmail-attachment-model-outcome:v1:' || v_hash;
  insert into public.gmail_attachment_model_attempt_outcomes (
    outcome_id, outcome_hash, workspace_key, request_id, dispatch_id,
    attempt_number, provider_result_hash, classification, request_sent,
    retryable, outcome_unknown, billing_outcome_unknown, http_status,
    request_body_hash, request_body_bytes, provider_response_body_hash,
    provider_response_body_bytes, provider_response_id, server_request_id,
    actual_model, provider_error_code, incomplete_reason, model_response,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    total_tokens, actual_microusd, provider_result, canonical_outcome
  ) values (
    v_outcome_id, v_hash, p_workspace_key, v_request.request_id,
    v_dispatch.dispatch_id, v_dispatch.attempt_number, v_provider_hash,
    v_classification, (p_provider_result->>'requestSent')::boolean,
    (p_provider_result->>'retryable')::boolean,
    (p_provider_result->>'outcomeUnknown')::boolean,
    (p_provider_result->>'billingOutcomeUnknown')::boolean,
    nullif(p_provider_result->>'httpStatus', '')::integer,
    v_request.request_body_hash, v_request.request_body_bytes,
    p_provider_result->>'providerResponseBodyHash',
    (p_provider_result->>'providerResponseBodyBytes')::integer,
    p_provider_result->>'providerResponseId',
    p_provider_result->>'serverRequestId',
    p_provider_result->>'actualModel',
    p_provider_result->>'providerErrorCode',
    p_provider_result->>'incompleteReason',
    case when jsonb_typeof(v_model_response) = 'object'
      then v_model_response else null end,
    v_input_tokens, v_cached_input_tokens, v_output_tokens,
    v_reasoning_tokens, v_total_tokens, v_cost,
    p_provider_result, v_canonical
  );

  if v_unknown then
    update public.gmail_attachment_model_requests request
    set state = 'outcome_unknown',
        review_reason = case
          when jsonb_typeof(v_usage) = 'object'
            and p_provider_result->>'actualModel'
              is distinct from 'gpt-5-nano-2025-08-07'
            then 'ACTUAL_MODEL_MISMATCH'
          when (p_provider_result->>'billingOutcomeUnknown')::boolean
            then 'BILLING_OUTCOME_UNKNOWN'
          else 'PROVIDER_OUTCOME_UNKNOWN'
        end,
        provider_finalized_at = v_now,
        updated_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_gmail_attachment_model_request_receipt(
      v_request.request_id, false
    );
  end if;

  perform 1
  from public.truth_model_workspace_accounts account
  where account.workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'Gmail attachment model account is unavailable at settlement'
      using errcode = '23514';
  end if;
  perform 1
  from public.truth_model_workspace_daily_usage usage
  where usage.workspace_key = p_workspace_key
    and usage.usage_date = v_request.reservation_date
  for update;
  if not found then
    raise exception 'Gmail attachment model daily ledger is unavailable at settlement'
      using errcode = '23514';
  end if;

  if v_terminal then
    update public.truth_model_workspace_accounts account
    set reserved_microusd = account.reserved_microusd
          - v_request.remaining_reserved_microusd,
        actual_microusd = account.actual_microusd + v_cost,
        updated_at = v_now
    where account.workspace_key = p_workspace_key
      and account.reserved_microusd >= v_request.remaining_reserved_microusd;
    if not found then
      raise exception 'Gmail attachment model account settlement underflow'
        using errcode = '23514';
    end if;
    update public.truth_model_workspace_daily_usage usage
    set reserved_input_tokens = usage.reserved_input_tokens
          - v_request.remaining_reserved_input_tokens,
        reserved_output_tokens = usage.reserved_output_tokens
          - v_request.remaining_reserved_output_tokens,
        actual_input_tokens = usage.actual_input_tokens + v_input_tokens,
        actual_cached_input_tokens = usage.actual_cached_input_tokens
          + v_cached_input_tokens,
        actual_output_tokens = usage.actual_output_tokens + v_output_tokens,
        actual_reasoning_tokens = usage.actual_reasoning_tokens
          + v_reasoning_tokens,
        actual_total_tokens = usage.actual_total_tokens + v_total_tokens,
        reserved_microusd = usage.reserved_microusd
          - v_request.remaining_reserved_microusd,
        actual_microusd = usage.actual_microusd + v_cost,
        updated_at = v_now
    where usage.workspace_key = p_workspace_key
      and usage.usage_date = v_request.reservation_date
      and usage.reserved_input_tokens >= v_request.remaining_reserved_input_tokens
      and usage.reserved_output_tokens >= v_request.remaining_reserved_output_tokens
      and usage.reserved_microusd >= v_request.remaining_reserved_microusd;
    if not found then
      raise exception 'Gmail attachment model daily settlement underflow'
        using errcode = '23514';
    end if;
    update public.gmail_attachment_model_requests request
    set state = case when v_classification = 'succeeded'
          then 'succeeded' else 'review_required' end,
        remaining_reserved_input_tokens = 0,
        remaining_reserved_output_tokens = 0,
        remaining_reserved_microusd = 0,
        actual_input_tokens = request.actual_input_tokens + v_input_tokens,
        actual_cached_input_tokens = request.actual_cached_input_tokens
          + v_cached_input_tokens,
        actual_output_tokens = request.actual_output_tokens + v_output_tokens,
        actual_reasoning_tokens = request.actual_reasoning_tokens
          + v_reasoning_tokens,
        actual_total_tokens = request.actual_total_tokens + v_total_tokens,
        actual_microusd = request.actual_microusd + v_cost,
        review_reason = v_reason,
        provider_finalized_at = v_now,
        updated_at = v_now
    where request.request_id = v_request.request_id;
  else
    update public.truth_model_workspace_accounts account
    set reserved_microusd = account.reserved_microusd - v_cost,
        actual_microusd = account.actual_microusd + v_cost,
        updated_at = v_now
    where account.workspace_key = p_workspace_key
      and account.reserved_microusd >= v_cost;
    if not found then
      raise exception 'Gmail attachment model retry settlement underflow'
        using errcode = '23514';
    end if;
    update public.truth_model_workspace_daily_usage usage
    set reserved_input_tokens = usage.reserved_input_tokens - v_input_tokens,
        reserved_output_tokens = usage.reserved_output_tokens - v_output_tokens,
        actual_input_tokens = usage.actual_input_tokens + v_input_tokens,
        actual_cached_input_tokens = usage.actual_cached_input_tokens
          + v_cached_input_tokens,
        actual_output_tokens = usage.actual_output_tokens + v_output_tokens,
        actual_reasoning_tokens = usage.actual_reasoning_tokens
          + v_reasoning_tokens,
        actual_total_tokens = usage.actual_total_tokens + v_total_tokens,
        reserved_microusd = usage.reserved_microusd - v_cost,
        actual_microusd = usage.actual_microusd + v_cost,
        updated_at = v_now
    where usage.workspace_key = p_workspace_key
      and usage.usage_date = v_request.reservation_date
      and usage.reserved_input_tokens >= v_input_tokens
      and usage.reserved_output_tokens >= v_output_tokens
      and usage.reserved_microusd >= v_cost;
    if not found then
      raise exception 'Gmail attachment model daily retry settlement underflow'
        using errcode = '23514';
    end if;
    update public.gmail_attachment_model_requests request
    set state = 'reserved',
        remaining_reserved_input_tokens = request.remaining_reserved_input_tokens
          - v_input_tokens,
        remaining_reserved_output_tokens = request.remaining_reserved_output_tokens
          - v_output_tokens,
        remaining_reserved_microusd = request.remaining_reserved_microusd - v_cost,
        actual_input_tokens = request.actual_input_tokens + v_input_tokens,
        actual_cached_input_tokens = request.actual_cached_input_tokens
          + v_cached_input_tokens,
        actual_output_tokens = request.actual_output_tokens + v_output_tokens,
        actual_reasoning_tokens = request.actual_reasoning_tokens
          + v_reasoning_tokens,
        actual_total_tokens = request.actual_total_tokens + v_total_tokens,
        actual_microusd = request.actual_microusd + v_cost,
        updated_at = v_now
    where request.request_id = v_request.request_id;
  end if;
  return private.truth_gmail_attachment_model_request_receipt(
    v_request.request_id, false
  );
end;
$function$;

create or replace function public.reconcile_truth_gmail_attachment_model_attempt(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_provider_result jsonb,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.reconcile_truth_gmail_attachment_model_attempt(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_request_id, p_provider_result, p_sync_token
  );
$function$;

create or replace function private.complete_truth_gmail_attachment_model_extraction(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_decided_by text,
  p_reason text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.gmail_attachment_model_requests%rowtype;
  v_outcome public.gmail_attachment_model_attempt_outcomes%rowtype;
  v_source public.source_observations%rowtype;
  v_target record;
  v_derived_source_object_id text;
  v_normalized_payload jsonb;
  v_content_hash text;
  v_identity jsonb;
  v_observation_id text;
  v_observation jsonb;
  v_child_dedupe text;
  v_child_payload jsonb;
  v_child jsonb;
  v_result jsonb;
  v_completion jsonb;
  v_claim_job_id uuid;
  v_evidence_ids jsonb;
  v_idempotency_key text;
  v_idempotency_key_hash text;
  v_resolution_request jsonb;
  v_resolution_request_hash text;
  v_resolution_id text;
  v_resolution_receipt jsonb;
  v_resolution_receipt_hash text;
  v_completion_receipt jsonb;
  v_completion_receipt_hash text;
begin
  if not private.valid_truth_review_token(p_review_token)
    or not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid Gmail attachment model finalization authority'
      using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_decided_by, '')), '') is null
    or length(p_decided_by) > 200
    or nullif(trim(coalesce(p_reason, '')), '') is null
    or length(p_reason) > 2000 then
    raise exception 'Gmail attachment model finalization decision is invalid'
      using errcode = '22023';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if not private.truth_shadow_model_commissioning_job_allowed(
    p_workspace_key, p_job_id
  ) then
    raise exception 'Gmail attachment model job is outside the sealed shadow commissioning scope'
      using errcode = '42501';
  end if;
  select * into v_request
  from public.gmail_attachment_model_requests request
  where request.workspace_key = p_workspace_key
    and request.request_id = p_request_id
    and request.source_job_id = p_job_id;
  if not found then
    raise exception 'Gmail attachment model request is unavailable'
      using errcode = '23503';
  end if;
  if v_request.canonical_completion_receipt is not null then
    if v_request.canonical_completion_receipt->>'workspaceKey'
        is distinct from p_workspace_key
      or v_request.canonical_completion_receipt->>'jobId'
        is distinct from p_job_id::text
      or v_request.canonical_completion_receipt->>'requestId'
        is distinct from p_request_id then
      raise exception 'Gmail attachment model completion receipt conflicts on replay'
        using errcode = '23505';
    end if;
    return v_request.canonical_completion_receipt
      || jsonb_build_object('idempotent', true);
  end if;

  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-attachment-model-finalization:' || p_workspace_key || ':' || p_request_id,
    0
  ));
  perform private.require_live_truth_gmail_attachment_model_job(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  select * into v_request
  from public.gmail_attachment_model_requests request
  where request.workspace_key = p_workspace_key
    and request.request_id = p_request_id
    and request.source_job_id = p_job_id
  for update;
  if v_request.canonical_completion_receipt is not null then
    return v_request.canonical_completion_receipt
      || jsonb_build_object('idempotent', true);
  end if;
  if v_request.state <> 'succeeded'
    or v_request.remaining_reserved_input_tokens <> 0
    or v_request.remaining_reserved_output_tokens <> 0
    or v_request.remaining_reserved_microusd <> 0
    or v_request.provider_finalized_at is null then
    raise exception 'Gmail attachment model request is not a settled success'
      using errcode = '55000';
  end if;
  select outcome.* into v_outcome
  from public.gmail_attachment_model_attempt_outcomes outcome
  where outcome.workspace_key = p_workspace_key
    and outcome.request_id = v_request.request_id
    and outcome.classification = 'succeeded';
  if not found
    or v_outcome.actual_model is distinct from v_request.model_snapshot
    or v_outcome.provider_response_id = ''
    or v_outcome.server_request_id = ''
    or v_outcome.outcome_unknown
    or v_outcome.billing_outcome_unknown
    or jsonb_typeof(v_outcome.model_response) <> 'object'
    or v_outcome.model_response->>'schemaVersion'
      is distinct from v_request.response_schema_version
    or (v_outcome.model_response #>> '{coverage,assessedAllPages}')::boolean
      is not true
    or (v_outcome.model_response #>> '{coverage,pagesAssessed}')::integer
      is distinct from (v_outcome.model_response #>> '{coverage,pageCount}')::integer
    or v_outcome.provider_result->>'requestId' is distinct from v_request.request_id
    or v_outcome.provider_result->>'providerResultHash'
      is distinct from v_outcome.provider_result_hash then
    raise exception 'Gmail attachment model success lacks exact provider provenance'
      using errcode = '23514';
  end if;

  select * into v_source
  from public.source_observations observation
  where observation.workspace_key = p_workspace_key
    and observation.observation_id = v_request.source_observation_id;
  select * into v_target
  from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
  where unresolved.review_job_id = p_job_id
    and unresolved.attachment_observation_id = v_request.source_observation_id
    and unresolved.attachment_content_hash = v_request.source_observation_content_hash;
  if v_source.observation_id is null
    or v_target.review_job_id is null
    or v_source.connection_key is distinct from v_request.connection_key
    or v_source.content_hash is distinct from v_request.source_observation_content_hash
    or v_source.raw_object_bucket is distinct from v_request.raw_object_bucket
    or v_source.raw_object_key is distinct from v_request.raw_object_key
    or v_source.raw_object_hash is distinct from v_request.raw_sha256
    or v_source.raw_object_bytes is distinct from v_request.raw_bytes
    or v_source.raw_content_type is distinct from v_request.raw_content_type then
    raise exception 'Gmail attachment model source review target is stale or resolved'
      using errcode = '40001';
  end if;

  v_derived_source_object_id := 'gmail-attachment-model:v1:' || v_request.request_hash;
  v_normalized_payload := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-extracted-v1',
    'workerVersion', 'truth-gmail-attachment-model-runtime-v1',
    'gmail', jsonb_build_object(
      'messageId', v_request.source_message_id,
      'threadId', v_request.source_thread_id,
      'historyId', v_request.source_history_id
    ),
    'attachmentId', v_derived_source_object_id,
    'sourceAttachmentId', v_request.source_attachment_id,
    'parentObservationId', v_request.source_parent_observation_id,
    'filename', v_request.filename,
    'mimeType', v_request.mime_type,
    'metadata', coalesce(v_source.normalized_payload->'metadata', '{}'::jsonb),
    'rawSha256', v_request.raw_sha256,
    'rawBytes', v_request.raw_bytes,
    'extraction', jsonb_build_object(
      'status', 'extracted',
      'method', 'openai-responses-file-v1',
      'provenance', 'truth_attachment_model_runtime',
      'reviewRequired', true,
      'modelSnapshot', v_request.model_snapshot,
      'promptVersion', v_request.prompt_version,
      'responseSchemaVersion', v_request.response_schema_version,
      'requestId', v_request.request_id,
      'providerResponseId', v_outcome.provider_response_id,
      'providerResultHash', v_outcome.provider_result_hash,
      'attemptOutcomeId', v_outcome.outcome_id,
      'assessedAllPages', true,
      'pageCount', (v_outcome.model_response #>> '{coverage,pageCount}')::integer,
      'pagesAssessed', (v_outcome.model_response #>> '{coverage,pagesAssessed}')::integer,
      'warnings', v_outcome.model_response->'warnings',
      'reason', p_reason,
      'confidence', 0.9,
      'textBytes', octet_length(v_outcome.model_response->>'documentText')
    ),
    'classification', null,
    'text', v_outcome.model_response->>'documentText'
  );
  v_content_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_normalized_payload), 'UTF8'
  ), 'sha256'), 'hex');
  v_identity := jsonb_build_object(
    'schemaVersion', 'source-observation-identity-v1',
    'workspaceKey', p_workspace_key,
    'sourceSystem', 'gmail',
    'connectionKey', v_request.connection_key,
    'sourceObjectType', 'gmail_attachment_extracted',
    'sourceObjectId', v_derived_source_object_id,
    'sourceRevision', v_request.source_history_id,
    'operation', 'content',
    'contentHash', v_content_hash
  );
  v_observation_id := 'obs:v1:' || encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_identity), 'UTF8'
  ), 'sha256'), 'hex');
  v_observation := jsonb_build_object(
    'observationId', v_observation_id,
    'sourceObjectType', 'gmail_attachment_extracted',
    'sourceObjectId', v_derived_source_object_id,
    'sourceRevision', v_request.source_history_id,
    'operation', 'content',
    'contentHash', v_content_hash,
    'normalizedPayload', v_normalized_payload,
    'normalizedText', v_outcome.model_response->>'documentText',
    'rawObject', jsonb_strip_nulls(jsonb_build_object(
      'bucket', v_request.raw_object_bucket,
      'key', v_request.raw_object_key,
      'version', v_request.raw_object_version,
      'etag', v_request.raw_object_etag,
      'hash', v_request.raw_sha256,
      'bytes', v_request.raw_bytes,
      'contentType', v_request.raw_content_type
    )),
    'sourceFidelity', 'normalized_source',
    'schemaVersion', 'gmail-attachment-extracted-v1',
    'retentionClass', 'shipment-operations'
  );
  v_child_dedupe := 'gmail:extract-attachment-claims:v1:' || encode(
    extensions.digest(convert_to(private.truth_canonical_json_text(
      jsonb_build_object(
        'observationId', v_observation_id,
        'contentHash', v_content_hash
      )
    ), 'UTF8'), 'sha256'), 'hex'
  );
  v_child_payload := jsonb_build_object(
    'schemaVersion', 'gmail-extract-attachment-claims-job-v1',
    'attachmentObservationId', v_observation_id,
    'attachmentId', v_derived_source_object_id,
    'sourceAttachmentId', v_request.source_attachment_id,
    'messageId', v_request.source_message_id,
    'threadId', v_request.source_thread_id,
    'historyId', v_request.source_history_id,
    'parentObservationId', v_request.source_parent_observation_id,
    'contentHash', v_content_hash,
    'modelRequestId', v_request.request_id,
    'modelAttemptOutcomeId', v_outcome.outcome_id
  );
  v_child := jsonb_build_object(
    'dedupeKey', v_child_dedupe,
    'jobKind', 'gmail_extract_attachment_claims',
    'observationId', v_observation_id,
    'sourceObjectId', v_derived_source_object_id,
    'maxAttempts', 5,
    'payload', v_child_payload
  );
  v_result := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-model-review-result-v1',
    'requestId', v_request.request_id,
    'requestHash', v_request.request_hash,
    'attemptOutcomeId', v_outcome.outcome_id,
    'providerResponseId', v_outcome.provider_response_id,
    'providerResultHash', v_outcome.provider_result_hash,
    'sourceAttachmentObservationId', v_request.source_observation_id,
    'derivedObservationId', v_observation_id,
    'derivedObservationContentHash', v_content_hash,
    'decision', 'operational_evidence_recorded',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_completion := private.complete_source_processing_job(
    p_job_id, p_worker_id, p_lease_fence, p_processor_version,
    v_result, jsonb_build_array(v_observation), jsonb_build_array(v_child),
    p_sync_token
  );
  select (child->>'jobId')::uuid into v_claim_job_id
  from jsonb_array_elements(v_completion->'childJobs') child
  where child->>'jobKind' = 'gmail_extract_attachment_claims'
    and child->>'observationId' = v_observation_id;
  if v_claim_job_id is null then
    raise exception 'Gmail attachment model completion lacks its exact claim child'
      using errcode = '23514';
  end if;

  v_evidence_ids := jsonb_build_array(v_observation_id);
  v_idempotency_key := 'gmail-attachment-model-finalization:v1:' || v_request.request_id;
  v_idempotency_key_hash := encode(extensions.digest(convert_to(
    v_idempotency_key, 'UTF8'
  ), 'sha256'), 'hex');
  v_resolution_request := jsonb_build_object(
    'schemaVersion', 'gmail-attachment-extraction-resolution-request-v1',
    'workspaceKey', p_workspace_key,
    'attachmentObservationId', v_request.source_observation_id,
    'attachmentContentHash', v_request.source_observation_content_hash,
    'decision', 'operational_evidence_recorded',
    'resolutionEvidenceObservationIds', v_evidence_ids,
    'decidedBy', p_decided_by,
    'reason', p_reason,
    'idempotencyKeyHash', v_idempotency_key_hash
  );
  v_resolution_request_hash := encode(extensions.digest(convert_to(
    v_resolution_request::text, 'UTF8'
  ), 'sha256'), 'hex');
  v_resolution_id := 'attachment-resolution:v1:' || v_resolution_request_hash;
  v_resolution_receipt := jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'schemaVersion', 'gmail-attachment-extraction-resolution-receipt-v1',
    'resolutionId', v_resolution_id,
    'workspaceKey', p_workspace_key,
    'attachmentObservationId', v_request.source_observation_id,
    'attachmentContentHash', v_request.source_observation_content_hash,
    'reviewJobId', p_job_id,
    'decision', 'operational_evidence_recorded',
    'resolutionEvidenceObservationIds', v_evidence_ids,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_resolution_receipt_hash := encode(extensions.digest(convert_to(
    v_resolution_receipt::text, 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.gmail_attachment_extraction_resolutions (
    resolution_id, workspace_key, connection_key,
    attachment_observation_id, attachment_content_hash, review_job_id,
    decision, resolution_evidence_observation_ids, decided_by, reason,
    idempotency_key_hash, request_hash, canonical_request,
    receipt_hash, canonical_receipt
  ) values (
    v_resolution_id, p_workspace_key, v_request.connection_key,
    v_request.source_observation_id, v_request.source_observation_content_hash,
    p_job_id, 'operational_evidence_recorded', v_evidence_ids,
    p_decided_by, p_reason, v_idempotency_key_hash,
    v_resolution_request_hash, v_resolution_request,
    v_resolution_receipt_hash, v_resolution_receipt
  );

  v_completion_receipt := jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'schemaVersion', 'gmail-attachment-model-completion-receipt-v1',
    'workspaceKey', p_workspace_key,
    'jobId', p_job_id,
    'requestId', v_request.request_id,
    'observationId', v_observation_id,
    'observationContentHash', v_content_hash,
    'claimJobId', v_claim_job_id,
    'resolutionId', v_resolution_id,
    'decision', 'operational_evidence_recorded',
    'shadowOnly', true,
    'mutatesOperationalState', false,
    'productionPublicationAttempted', false
  );
  v_completion_receipt_hash := encode(extensions.digest(convert_to(
    v_completion_receipt::text, 'UTF8'
  ), 'sha256'), 'hex');
  update public.gmail_attachment_model_requests request
  set completion_observation_id = v_observation_id,
      completion_claim_job_id = v_claim_job_id,
      completion_resolution_id = v_resolution_id,
      canonical_completion_receipt = v_completion_receipt,
      completion_receipt_hash = v_completion_receipt_hash,
      evidence_finalized_at = v_now,
      updated_at = v_now
  where request.request_id = v_request.request_id
    and request.canonical_completion_receipt is null;
  if not found then
    raise exception 'Gmail attachment model completion changed during finalization'
      using errcode = '40001';
  end if;
  return v_completion_receipt;
end;
$function$;

create or replace function public.complete_truth_gmail_attachment_model_extraction(
  p_workspace_key text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_request_id text,
  p_decided_by text,
  p_reason text,
  p_review_token text,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.complete_truth_gmail_attachment_model_extraction(
    p_workspace_key, p_job_id, p_worker_id, p_lease_fence,
    p_processor_version, p_request_id, p_decided_by, p_reason,
    p_review_token, p_sync_token
  );
$function$;

do $candidate_guard_predecessor$
declare v_definition text;
begin
  if to_regprocedure('private.guard_gmail_model_candidate()') is null then
    raise exception 'Gmail model candidate guard predecessor is unavailable'
      using errcode = '55000';
  end if;
  select pg_get_functiondef('private.guard_gmail_model_candidate()'::regprocedure)
  into v_definition;
  if position('truth_attachment_model_runtime' in v_definition) = 0
    and (
      position('gmail_extract_message_model_claims' in v_definition) = 0
      or position('new.source_object_type <> ''gmail_message_parsed''' in v_definition) = 0
      or position('v_plan.prompt_version' in v_definition) = 0
      or position('acceptanceRecommendation,decision' in v_definition) = 0
      or position('acceptanceRecommendation,method' in v_definition) = 0
    ) then
    raise exception 'Gmail model candidate guard differs from the reviewed predecessor'
      using errcode = '23514';
  end if;
end;
$candidate_guard_predecessor$;

create or replace function private.guard_gmail_model_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan public.gmail_model_extraction_plans%rowtype;
  v_request public.gmail_attachment_model_requests%rowtype;
  v_outcome public.gmail_attachment_model_attempt_outcomes%rowtype;
  v_observation public.source_observations%rowtype;
  v_job public.source_processing_jobs%rowtype;
begin
  if new.extraction_method <> 'model' then
    return null;
  end if;

  if new.source_object_type = 'gmail_message_parsed' then
    -- Existing message-model authority is deliberately unchanged.
    select plan.* into v_plan
    from public.candidate_claim_job_lineage lineage
    join public.source_processing_job_lineage job_lineage
      on job_lineage.job_id = lineage.job_id
    join public.gmail_model_extraction_plans plan
      on plan.parent_job_id = job_lineage.parent_job_id
    join public.source_processing_jobs job
      on job.job_id = job_lineage.job_id
    where lineage.candidate_claim_version_id = new.candidate_claim_version_id
      and lineage.source_observation_id = new.source_observation_id
      and job.job_kind = 'gmail_extract_message_model_claims'
      and job.payload->>'modelPlanId' = plan.model_plan_id;
    if not found
      or new.extractor_candidate->>'extractorVersion'
        is distinct from v_plan.extractor_version
      or new.extractor_candidate->>'promptVersion'
        is distinct from v_plan.prompt_version
      or nullif(trim(coalesce(new.extractor_candidate->>'model', '')), '') is null
      or new.recommendation <> 'review'
      or new.ambiguity_status <> 'review'
      or new.extractor_candidate #>> '{acceptanceRecommendation,decision}'
        <> 'review'
      or new.extractor_candidate #>> '{acceptanceRecommendation,method}'
        <> 'operator' then
      raise exception 'model candidate is not bound to its sealed Gmail plan or forced-review boundary'
        using errcode = '23514';
    end if;
    return null;
  end if;

  if new.source_object_type <> 'gmail_attachment_extracted' then
    raise exception 'model candidate has no authorized Gmail source class'
      using errcode = '23514';
  end if;
  select request.* into v_request
  from public.candidate_claim_job_lineage lineage
  join public.source_processing_jobs job
    on job.workspace_key = new.workspace_key
   and job.job_id = lineage.job_id
  join public.source_processing_job_lineage job_lineage
    on job_lineage.workspace_key = job.workspace_key
   and job_lineage.job_id = job.job_id
  join public.gmail_attachment_model_requests request
    on request.workspace_key = job.workspace_key
   and request.source_job_id = job_lineage.parent_job_id
   and request.completion_observation_id = lineage.source_observation_id
   and request.completion_claim_job_id = job.job_id
  where lineage.candidate_claim_version_id = new.candidate_claim_version_id
    and lineage.source_observation_id = new.source_observation_id
    and job.source_system = 'gmail'
    and job.connection_key = request.connection_key
    and job.job_kind = 'gmail_extract_attachment_claims'
    and job.observation_id = lineage.source_observation_id
    and job.payload->>'schemaVersion'
      = 'gmail-extract-attachment-claims-job-v1'
    and job.payload->>'modelRequestId' = request.request_id;
  if not found then
    raise exception 'attachment model candidate lacks its exact finalized request lineage'
      using errcode = '23514';
  end if;
  select * into v_observation
  from public.source_observations observation
  where observation.workspace_key = new.workspace_key
    and observation.observation_id = new.source_observation_id;
  select * into v_job
  from public.source_processing_jobs job
  where job.workspace_key = new.workspace_key
    and job.job_id = v_request.completion_claim_job_id;
  select * into v_outcome
  from public.gmail_attachment_model_attempt_outcomes outcome
  where outcome.workspace_key = new.workspace_key
    and outcome.request_id = v_request.request_id
    and outcome.classification = 'succeeded';

  if v_observation.observation_id is null
    or v_job.job_id is null
    or v_outcome.outcome_id is null
    or not private.truth_shadow_model_commissioning_job_allowed(
      v_request.workspace_key, v_request.source_job_id
    )
    or v_request.state <> 'succeeded'
    or v_request.canonical_completion_receipt is null
    or v_request.completion_observation_id is distinct from new.source_observation_id
    or v_request.completion_claim_job_id is distinct from v_job.job_id
    or v_request.canonical_completion_receipt->>'observationId'
      is distinct from new.source_observation_id
    or v_request.canonical_completion_receipt->>'claimJobId'
      is distinct from v_job.job_id::text
    or v_request.canonical_completion_receipt->>'productionPublicationAttempted'
      is distinct from 'false'
    or not exists (
      select 1
      from public.gmail_attachment_extraction_resolutions resolution
      where resolution.workspace_key = v_request.workspace_key
        and resolution.resolution_id = v_request.completion_resolution_id
        and resolution.attachment_observation_id = v_request.source_observation_id
        and resolution.attachment_content_hash
          = v_request.source_observation_content_hash
        and resolution.review_job_id = v_request.source_job_id
        and resolution.decision = 'operational_evidence_recorded'
        and resolution.resolution_evidence_observation_ids
          = jsonb_build_array(new.source_observation_id)
    )
    or v_observation.source_system <> 'gmail'
    or v_observation.connection_key is distinct from v_request.connection_key
    or v_observation.source_object_type <> 'gmail_attachment_extracted'
    or v_observation.source_object_id
      is distinct from 'gmail-attachment-model:v1:' || v_request.request_hash
    or v_observation.operation <> 'content'
    or v_observation.content_hash is distinct from new.source_observation_content_hash
    or v_observation.content_hash is distinct from encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_observation.normalized_payload), 'UTF8'
    ), 'sha256'), 'hex')
    or v_observation.normalized_payload->>'schemaVersion'
      <> 'gmail-attachment-extracted-v1'
    or v_observation.normalized_payload->>'attachmentId'
      is distinct from v_observation.source_object_id
    or v_observation.normalized_payload->>'sourceAttachmentId'
      is distinct from v_request.source_attachment_id
    or v_observation.normalized_payload->>'rawSha256'
      is distinct from v_request.raw_sha256
    or v_observation.raw_object_bucket is distinct from v_request.raw_object_bucket
    or v_observation.raw_object_key is distinct from v_request.raw_object_key
    or v_observation.raw_object_hash is distinct from v_request.raw_sha256
    or v_observation.raw_object_bytes is distinct from v_request.raw_bytes
    or v_observation.normalized_payload->'extraction'->>'status' <> 'extracted'
    or v_observation.normalized_payload->'extraction'->>'method'
      <> 'openai-responses-file-v1'
    or v_observation.normalized_payload->'extraction'->>'provenance'
      <> 'truth_attachment_model_runtime'
    or jsonb_typeof(v_observation.normalized_payload->'extraction'->'reviewRequired')
      <> 'boolean'
    or (v_observation.normalized_payload->'extraction'->>'reviewRequired')::boolean
      is not true
    or v_observation.normalized_payload->'extraction'->>'modelSnapshot'
      is distinct from v_request.model_snapshot
    or v_observation.normalized_payload->'extraction'->>'promptVersion'
      is distinct from v_request.prompt_version
    or v_observation.normalized_payload->'extraction'->>'responseSchemaVersion'
      is distinct from v_request.response_schema_version
    or v_observation.normalized_payload->'extraction'->>'requestId'
      is distinct from v_request.request_id
    or v_observation.normalized_payload->'extraction'->>'providerResponseId'
      is distinct from v_outcome.provider_response_id
    or v_observation.normalized_payload->'extraction'->>'providerResultHash'
      is distinct from v_outcome.provider_result_hash
    or v_observation.normalized_payload->'extraction'->>'attemptOutcomeId'
      is distinct from v_outcome.outcome_id
    or (v_observation.normalized_payload->'extraction'->>'assessedAllPages')::boolean
      is not true
    or (v_observation.normalized_payload->'extraction'->>'pageCount')::integer
      is distinct from (v_outcome.model_response #>> '{coverage,pageCount}')::integer
    or (v_observation.normalized_payload->'extraction'->>'pagesAssessed')::integer
      is distinct from (v_outcome.model_response #>> '{coverage,pagesAssessed}')::integer
    or v_outcome.actual_model <> 'gpt-5-nano-2025-08-07'
    or v_outcome.outcome_unknown
    or v_outcome.billing_outcome_unknown
    or v_outcome.model_response->>'schemaVersion'
      <> 'gmail-attachment-model-extraction-result-v1'
    or v_job.job_kind <> 'gmail_extract_attachment_claims'
    or v_job.observation_id is distinct from v_observation.observation_id
    or v_job.source_object_id is distinct from v_observation.source_object_id
    or v_job.payload->>'modelAttemptOutcomeId' is distinct from v_outcome.outcome_id
    or new.source_review_required is not true
    or new.source_extraction_method <> 'openai-responses-file-v1'
    or new.extractor_candidate->>'extractionMethod' <> 'model'
    or new.extractor_candidate->>'model' <> 'gpt-5-nano-2025-08-07'
    or new.extractor_candidate->>'promptVersion'
      <> 'gmail-attachment-operational-extraction-v1'
    or new.extractor_candidate->>'sourceObservationId'
      is distinct from v_observation.observation_id
    or new.extractor_candidate->>'sourceObservationContentHash'
      is distinct from v_observation.content_hash
    or new.extractor_candidate->>'sourceMessageId'
      is distinct from v_request.source_message_id
    or new.extractor_candidate->>'sourceThreadId'
      is distinct from v_request.source_thread_id
    or new.recommendation <> 'review'
    or new.ambiguity_status <> 'review'
    or new.extractor_candidate #>> '{ambiguity,status}' <> 'review'
    or new.extractor_candidate #>> '{acceptanceRecommendation,decision}'
      <> 'review'
    or new.extractor_candidate #>> '{acceptanceRecommendation,method}'
      <> 'operator' then
    raise exception 'attachment model candidate is not bound to exact all-page evidence and forced review'
      using errcode = '23514';
  end if;
  return null;
end;
$function$;

do $function_acl$
declare
  v_private regprocedure;
  v_public regprocedure;
begin
  foreach v_private in array array[
    'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'::regprocedure,
    'private.truth_gmail_attachment_model_request_receipt(text,boolean)'::regprocedure,
    'private.truth_gmail_attachment_model_dispatch_receipt(text,boolean,boolean)'::regprocedure,
    'private.load_truth_gmail_attachment_model_context(text,uuid,text,bigint,text,text)'::regprocedure,
    'private.create_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,integer,text,text,text,text,text,text,integer,integer,integer,text)'::regprocedure,
    'private.reserve_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,text)'::regprocedure,
    'private.begin_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,text)'::regprocedure,
    'private.reconcile_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,jsonb,text)'::regprocedure,
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'::regprocedure,
    'private.guard_gmail_attachment_model_request_update()'::regprocedure,
    'private.guard_gmail_model_candidate()'::regprocedure
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_private
    );
  end loop;
  foreach v_public in array array[
    'public.load_truth_gmail_attachment_model_context(text,uuid,text,bigint,text,text)'::regprocedure,
    'public.create_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,integer,text,text,text,text,text,text,integer,integer,integer,text)'::regprocedure,
    'public.reserve_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,text)'::regprocedure,
    'public.begin_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,text)'::regprocedure,
    'public.reconcile_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,jsonb,text)'::regprocedure,
    'public.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'::regprocedure
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      v_public
    );
    execute format('grant execute on function %s to service_role', v_public);
  end loop;
end;
$function_acl$;

do $verify$
declare
  v_definition text;
  v_count integer;
begin
  if to_regclass('public.gmail_attachment_model_requests') is null
    or to_regclass('public.gmail_attachment_model_attempt_dispatches') is null
    or to_regclass('public.gmail_attachment_model_attempt_outcomes') is null then
    raise exception 'Gmail attachment model ledger tables are unavailable'
      using errcode = '23514';
  end if;
  select count(*) into v_count
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = any(array[
      'gmail_attachment_model_requests',
      'gmail_attachment_model_attempt_dispatches',
      'gmail_attachment_model_attempt_outcomes'
    ])
    and relation.relrowsecurity
    and relation.relforcerowsecurity;
  if v_count <> 3 then
    raise exception 'Gmail attachment model ledger RLS is not forced'
      using errcode = '23514';
  end if;
  if to_regprocedure(
      'public.load_truth_gmail_attachment_model_context(text,uuid,text,bigint,text,text)'
    ) is null
    or to_regprocedure(
      'public.create_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,integer,text,text,text,text,text,text,integer,integer,integer,text)'
    ) is null
    or to_regprocedure(
      'public.reserve_truth_gmail_attachment_model_request(text,uuid,text,bigint,text,text,text)'
    ) is null
    or to_regprocedure(
      'public.begin_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,text)'
    ) is null
    or to_regprocedure(
      'public.reconcile_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,jsonb,text)'
    ) is null
    or to_regprocedure(
      'public.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'
    ) is null then
    raise exception 'Gmail attachment model public RPC surface is incomplete'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.require_live_truth_gmail_attachment_model_job(text,uuid,text,bigint,text)'::regprocedure
  ) into v_definition;
  if position('truth_shadow_model_commissioning_job_allowed' in v_definition) = 0
    or position('gmail_review_attachment_extraction' in v_definition) = 0
    or position('lease_expires_at > clock_timestamp()' in v_definition) = 0 then
    raise exception 'Gmail attachment model lease scope guard is incomplete'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.reconcile_truth_gmail_attachment_model_attempt(text,uuid,text,bigint,text,text,jsonb,text)'::regprocedure
  ) into v_definition;
  if position('providerResultHash' in v_definition) = 0
    or position('truth_model_usage_cost' in v_definition) = 0
    or position('BILLING_OUTCOME_UNKNOWN' in v_definition) = 0
    or position('gpt-5-nano-2025-08-07' in v_definition) = 0 then
    raise exception 'Gmail attachment model reconciliation authority is incomplete'
      using errcode = '23514';
  end if;
  select pg_get_functiondef(
    'private.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  if position('operational_evidence_recorded' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0
    or position('truth_attachment_model_runtime' in v_definition) = 0
    or position('productionPublicationAttempted' in v_definition) = 0
    or position('truth_source_cut_mutation_lock(p_workspace_key)' in v_definition) = 0 then
    raise exception 'Gmail attachment model atomic evidence finalizer is incomplete'
      using errcode = '23514';
  end if;
  select pg_get_functiondef('private.guard_gmail_model_candidate()'::regprocedure)
  into v_definition;
  if position('gmail_extract_message_model_claims' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0
    or position('truth_attachment_model_runtime' in v_definition) = 0
    or position('openai-responses-file-v1' in v_definition) = 0
    or position('operational_evidence_recorded' in v_definition) = 0 then
    raise exception 'Gmail model candidate authorities are not disjoint and complete'
      using errcode = '23514';
  end if;
  if has_table_privilege('service_role', 'public.gmail_attachment_model_requests', 'INSERT')
    or has_table_privilege('service_role', 'public.gmail_attachment_model_requests', 'UPDATE')
    or has_table_privilege('anon', 'public.gmail_attachment_model_requests', 'SELECT')
    or has_function_privilege(
      'anon',
      'public.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.complete_truth_gmail_attachment_model_extraction(text,uuid,text,bigint,text,text,text,text,text,text)',
      'EXECUTE'
    ) then
    raise exception 'Gmail attachment model ACL boundary is invalid'
      using errcode = '23514';
  end if;
end;
$verify$;

set check_function_bodies = on;

-- Durable model-extraction request, budget, and crash-safety authority.
--
-- This migration performs no provider call and does not wire a source worker.
-- The normal truth sync token may create/reserve/reconcile requests, but only a
-- separate issuer token may enable or reconfigure a workspace model account.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
set check_function_bodies = off;

-- Remove draft arities so a database that saw a pre-checkpoint iteration cannot
-- retain a second PostgREST-visible overload with stale authorization rules.
drop function if exists public.create_truth_model_request(
  text, text, uuid, text, text, text, jsonb, text, text, text, text, text, text,
  text, text, integer, text, bigint, text, text
);
drop function if exists private.create_truth_model_request(
  text, text, uuid, text, text, text, jsonb, text, text, text, text, text, text,
  text, text, integer, text, bigint, text, text
);
drop function if exists public.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
);
drop function if exists private.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
);
drop function if exists public.reconcile_truth_model_sync_attempt(
  text, text, integer, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
);
drop function if exists private.reconcile_truth_model_sync_attempt(
  text, text, integer, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
);
drop function if exists public.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
);
drop function if exists private.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
);

create table if not exists public.truth_model_pricing_policies (
  pricing_policy_id text primary key
    check (pricing_policy_id ~ '^model-pricing:v1:[0-9a-f]{64}$'),
  policy_hash text not null unique check (policy_hash ~ '^[0-9a-f]{64}$'),
  model_snapshot text not null,
  transport text not null check (transport = any (array['sync', 'batch'])),
  input_microusd_per_million bigint not null check (input_microusd_per_million >= 0),
  cached_input_microusd_per_million bigint not null
    check (cached_input_microusd_per_million >= 0),
  output_microusd_per_million bigint not null check (output_microusd_per_million >= 0),
  pricing_version text not null,
  source_url text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (model_snapshot, transport, pricing_version),
  check (cached_input_microusd_per_million <= input_microusd_per_million)
);

create table if not exists public.truth_model_workspace_accounts (
  workspace_key text primary key references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  status text not null default 'disabled'
    check (status = any (array['disabled', 'enabled'])),
  lifetime_allocation_microusd bigint not null default 13000000
    check (lifetime_allocation_microusd > 0),
  daily_ceiling_microusd bigint not null default 2000000
    check (daily_ceiling_microusd > 0),
  reserved_microusd bigint not null default 0 check (reserved_microusd >= 0),
  actual_microusd bigint not null default 0 check (actual_microusd >= 0),
  configuration_version bigint not null default 0 check (configuration_version >= 0),
  configured_at timestamptz,
  configured_by text not null default '',
  configuration_reason text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (actual_microusd + reserved_microusd <= lifetime_allocation_microusd)
);

create table if not exists public.truth_model_account_configuration_requests (
  configuration_request_id text primary key
    check (configuration_request_id ~ '^model-account-config:v1:[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  configuration_request_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status = any (array['disabled', 'enabled'])),
  lifetime_allocation_microusd bigint not null,
  daily_ceiling_microusd bigint not null,
  configured_by text not null,
  configuration_reason text not null,
  configuration_version bigint not null check (configuration_version > 0),
  configured_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, configuration_request_key)
);

create table if not exists public.truth_model_workspace_daily_usage (
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  usage_date date not null,
  reserved_input_tokens bigint not null default 0 check (reserved_input_tokens >= 0),
  reserved_output_tokens bigint not null default 0 check (reserved_output_tokens >= 0),
  actual_input_tokens bigint not null default 0 check (actual_input_tokens >= 0),
  actual_cached_input_tokens bigint not null default 0
    check (actual_cached_input_tokens >= 0),
  actual_output_tokens bigint not null default 0 check (actual_output_tokens >= 0),
  actual_reasoning_tokens bigint not null default 0 check (actual_reasoning_tokens >= 0),
  actual_total_tokens bigint not null default 0 check (actual_total_tokens >= 0),
  reserved_microusd bigint not null default 0 check (reserved_microusd >= 0),
  actual_microusd bigint not null default 0 check (actual_microusd >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_key, usage_date),
  check (actual_cached_input_tokens <= actual_input_tokens),
  check (actual_reasoning_tokens <= actual_output_tokens)
);

create table if not exists public.truth_model_requests (
  request_id text primary key check (request_id ~ '^model-request:v1:[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  logical_request_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  source_job_id uuid not null,
  observation_id text not null,
  observation_content_hash text not null check (observation_content_hash ~ '^[0-9a-f]{64}$'),
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  request_payload_text text not null,
  request_payload_hash text not null check (request_payload_hash ~ '^[0-9a-f]{64}$'),
  request_payload_bytes integer not null check (request_payload_bytes > 0 and request_payload_bytes <= 1048576),
  model_snapshot text not null,
  prompt_version text not null,
  response_schema_version text not null,
  response_schema_hash text not null check (response_schema_hash ~ '^[0-9a-f]{64}$'),
  processing_config_version text not null,
  processing_config_hash text not null check (processing_config_hash ~ '^[0-9a-f]{64}$'),
  pricing_policy_id text not null references public.truth_model_pricing_policies(pricing_policy_id)
    on update restrict on delete restrict,
  pricing_policy_hash text not null check (pricing_policy_hash ~ '^[0-9a-f]{64}$'),
  transport text not null check (transport = any (array['sync', 'batch'])),
  max_input_tokens integer not null check (max_input_tokens > 0 and max_input_tokens <= 400000),
  max_output_tokens integer not null check (max_output_tokens > 0 and max_output_tokens <= 128000),
  max_attempts integer not null check (max_attempts = any (array[1, 3])),
  state text not null default 'planned' check (state = any (array[
    'planned', 'reserved', 'in_flight', 'succeeded', 'review_required',
    'outcome_unknown'
  ])),
  reservation_date date,
  initial_reserved_input_tokens bigint not null default 0,
  initial_reserved_output_tokens bigint not null default 0,
  remaining_reserved_input_tokens bigint not null default 0,
  remaining_reserved_output_tokens bigint not null default 0,
  initial_reserved_microusd bigint not null default 0,
  remaining_reserved_microusd bigint not null default 0,
  actual_input_tokens bigint not null default 0,
  actual_cached_input_tokens bigint not null default 0,
  actual_output_tokens bigint not null default 0,
  actual_reasoning_tokens bigint not null default 0,
  actual_total_tokens bigint not null default 0,
  actual_microusd bigint not null default 0,
  review_reason text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  reserved_at timestamptz,
  finalized_at timestamptz,
  unique (workspace_key, logical_request_key),
  unique (request_id, workspace_key),
  -- One extraction request belongs to one source job. A nano-to-mini
  -- escalation is represented by a separately leased child processing job.
  unique (source_job_id, workspace_key),
  foreign key (source_job_id, workspace_key)
    references public.source_processing_jobs(job_id, workspace_key)
    on update restrict on delete restrict,
  foreign key (observation_id, workspace_key)
    references public.source_observations(observation_id, workspace_key)
    on update restrict on delete restrict,
  check ((transport = 'sync' and max_attempts = 3) or (transport = 'batch' and max_attempts = 1)),
  check (max_input_tokens + max_output_tokens <= 400000),
  check (actual_cached_input_tokens <= actual_input_tokens),
  check (actual_reasoning_tokens <= actual_output_tokens),
  check (remaining_reserved_input_tokens <= initial_reserved_input_tokens),
  check (remaining_reserved_output_tokens <= initial_reserved_output_tokens),
  check (remaining_reserved_microusd <= initial_reserved_microusd)
);

create table if not exists public.truth_model_sync_attempt_dispatches (
  dispatch_id text primary key check (dispatch_id ~ '^model-dispatch:v1:[0-9a-f]{64}$'),
  request_id text not null references public.truth_model_requests(request_id)
    on update restrict on delete restrict,
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  attempt_number integer not null check (attempt_number between 1 and 3),
  client_request_id text not null,
  dispatch_hash text not null check (dispatch_hash ~ '^[0-9a-f]{64}$'),
  dispatched_at timestamptz not null default clock_timestamp(),
  unique (request_id, attempt_number),
  unique (workspace_key, client_request_id),
  unique (dispatch_id, request_id, workspace_key, attempt_number),
  foreign key (request_id, workspace_key)
    references public.truth_model_requests(request_id, workspace_key)
    on update restrict on delete restrict
);

create table if not exists public.truth_model_sync_attempt_outcomes (
  outcome_id text primary key check (outcome_id ~ '^model-outcome:v1:[0-9a-f]{64}$'),
  dispatch_id text not null unique references public.truth_model_sync_attempt_dispatches(dispatch_id)
    on update restrict on delete restrict,
  request_id text not null,
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  attempt_number integer not null check (attempt_number between 1 and 3),
  outcome_hash text not null check (outcome_hash ~ '^[0-9a-f]{64}$'),
  provider_result_hash text not null unique check (provider_result_hash ~ '^[0-9a-f]{64}$'),
  classification text not null check (classification = any (array[
    'success', 'pre_send_failure', 'rate_limited', 'rate_limited_usage_known',
    'server_error_usage_known', 'insufficient_quota',
    'refusal', 'content_filter', 'incomplete', 'malformed_output',
    'configuration_error', 'model_mismatch', 'outcome_unknown', 'billing_unknown'
  ])),
  request_sent boolean not null,
  http_status integer check (http_status is null or http_status between 100 and 599),
  request_body_hash text not null check (request_body_hash ~ '^[0-9a-f]{64}$'),
  request_body_bytes integer not null check (request_body_bytes > 0 and request_body_bytes <= 1048576),
  provider_response_body_hash text not null default ''
    check (provider_response_body_hash = '' or provider_response_body_hash ~ '^[0-9a-f]{64}$'),
  provider_response_body_bytes integer not null default 0
    check (provider_response_body_bytes >= 0 and provider_response_body_bytes <= 2097152),
  provider_error_code text not null default '',
  incomplete_reason text not null default '',
  outcome_unknown boolean not null,
  billing_outcome_unknown boolean not null,
  provider_response_id text not null default '',
  server_request_id text not null default '',
  actual_model text not null default '',
  normalized_result jsonb,
  normalized_result_hash text not null default ''
    check (normalized_result_hash = '' or normalized_result_hash ~ '^[0-9a-f]{64}$'),
  input_tokens bigint not null check (input_tokens >= 0),
  cached_input_tokens bigint not null check (cached_input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  reasoning_tokens bigint not null check (reasoning_tokens >= 0),
  total_tokens bigint not null check (total_tokens >= 0),
  actual_microusd bigint not null check (actual_microusd >= 0),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (request_id, attempt_number),
  foreign key (dispatch_id, request_id, workspace_key, attempt_number)
    references public.truth_model_sync_attempt_dispatches(
      dispatch_id, request_id, workspace_key, attempt_number
    ) on update restrict on delete restrict,
  check (cached_input_tokens <= input_tokens),
  check (reasoning_tokens <= output_tokens),
  check (total_tokens = input_tokens + output_tokens),
  check (outcome_unknown = (classification = 'outcome_unknown')),
  check (billing_outcome_unknown = (
    classification = any (array['billing_unknown', 'model_mismatch'])
  )),
  check ((provider_response_body_hash = '' and provider_response_body_bytes = 0)
    or (provider_response_body_hash <> '' and provider_response_body_bytes > 0)),
  check (request_sent or (
    http_status is null and provider_response_body_hash = ''
    and provider_response_body_bytes = 0 and provider_response_id = ''
    and server_request_id = ''
  )),
  check (
    (classification = 'success' and normalized_result is not null
      and jsonb_typeof(normalized_result) = 'object'
      and normalized_result_hash ~ '^[0-9a-f]{64}$')
    or (classification <> 'success' and normalized_result is null)
  )
);

alter table public.truth_model_sync_attempt_outcomes
  drop constraint if exists truth_model_success_result_required;
alter table public.truth_model_sync_attempt_outcomes
  add constraint truth_model_success_result_required
  check (classification <> 'success' or (
    normalized_result is not null
    and nullif(normalized_result->>'schemaVersion', '') is not null
    and jsonb_typeof(normalized_result->'claims') = 'array'
    and jsonb_array_length(normalized_result->'claims') between 1 and 50
  ));

create unique index if not exists truth_model_requests_workspace_identity_uidx
  on public.truth_model_requests(request_id, workspace_key);
create unique index if not exists truth_model_dispatch_scope_uidx
  on public.truth_model_sync_attempt_dispatches(
    dispatch_id, request_id, workspace_key, attempt_number
  );
create unique index if not exists truth_model_outcomes_provider_response_uidx
  on public.truth_model_sync_attempt_outcomes(provider_response_id)
  where provider_response_id <> '';
create unique index if not exists truth_model_outcomes_server_request_uidx
  on public.truth_model_sync_attempt_outcomes(server_request_id)
  where server_request_id <> '';
create index if not exists truth_model_requests_state_idx
  on public.truth_model_requests(workspace_key, state, created_at, request_id);

-- Every existing workspace starts disabled. Absence of an account for a later
-- workspace is also treated as disabled by the reservation RPC.
insert into public.truth_model_workspace_accounts (workspace_key)
select workspace.workspace_key from public.truth_workspaces workspace
on conflict (workspace_key) do nothing;

-- Pricing is pinned to immutable model snapshots and an explicit 2026-07-09
-- policy version. Rates are integer micro-USD per one million tokens.
do $block$
declare
  v_policy jsonb;
  v_hash text;
  v_row record;
begin
  for v_row in select * from (values
    ('gpt-5-nano-2025-08-07', 'sync', 50000::bigint, 5000::bigint, 400000::bigint),
    ('gpt-5-nano-2025-08-07', 'batch', 25000::bigint, 2500::bigint, 200000::bigint),
    ('gpt-5.4-mini-2026-03-17', 'sync', 750000::bigint, 75000::bigint, 4500000::bigint),
    ('gpt-5.4-mini-2026-03-17', 'batch', 375000::bigint, 37500::bigint, 2250000::bigint)
  ) as policies(model_snapshot, transport, input_rate, cached_rate, output_rate)
  loop
    v_policy := jsonb_build_object(
      'schemaVersion', 'truth-model-pricing-policy-v1',
      'modelSnapshot', v_row.model_snapshot,
      'transport', v_row.transport,
      'inputMicroUsdPerMillion', v_row.input_rate,
      'cachedInputMicroUsdPerMillion', v_row.cached_rate,
      'outputMicroUsdPerMillion', v_row.output_rate,
      'pricingVersion', 'openai-public-pricing-2026-07-09'
    );
    v_hash := encode(extensions.digest(convert_to(v_policy::text, 'UTF8'), 'sha256'), 'hex');
    insert into public.truth_model_pricing_policies (
      pricing_policy_id, policy_hash, model_snapshot, transport,
      input_microusd_per_million, cached_input_microusd_per_million,
      output_microusd_per_million, pricing_version, source_url
    ) values (
      'model-pricing:v1:' || v_hash, v_hash, v_row.model_snapshot, v_row.transport,
      v_row.input_rate, v_row.cached_rate, v_row.output_rate,
      'openai-public-pricing-2026-07-09',
      'https://developers.openai.com/api/docs/models/' ||
        case when v_row.model_snapshot like 'gpt-5-nano%' then 'gpt-5-nano' else 'gpt-5.4-mini' end
    ) on conflict (pricing_policy_id) do nothing;
    if not exists (
      select 1 from public.truth_model_pricing_policies policy
      where policy.pricing_policy_id = 'model-pricing:v1:' || v_hash
        and policy.policy_hash = v_hash
        and policy.model_snapshot = v_row.model_snapshot
        and policy.transport = v_row.transport
        and policy.input_microusd_per_million = v_row.input_rate
        and policy.cached_input_microusd_per_million = v_row.cached_rate
        and policy.output_microusd_per_million = v_row.output_rate
        and policy.pricing_version = 'openai-public-pricing-2026-07-09'
    ) then
      raise exception 'truth model pinned pricing policy conflicts with migration'
        using errcode = '23514';
    end if;
  end loop;
end;
$block$;

create or replace function private.valid_truth_model_account_issuer_token(
  p_issuer_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select length(coalesce(p_issuer_token, '')) between 32 and 4096
    and exists (
      select 1 from public.sync_tokens token
      where token.token_name = 'truth_model_account_issuer'
        and token.token_hash = encode(
          extensions.digest(convert_to(p_issuer_token, 'UTF8'), 'sha256'),
          'hex'
        )
    );
$function$;

create or replace function private.require_live_truth_model_source_job(
  p_workspace_key text,
  p_source_job_id uuid,
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
declare
  v_job public.source_processing_jobs%rowtype;
begin
  if p_source_job_id is null
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null then
    raise exception 'truth model source-job lease authority is invalid'
      using errcode = '22023';
  end if;
  select * into v_job from public.source_processing_jobs job
  where job.job_id = p_source_job_id
    and job.workspace_key = p_workspace_key
    and job.source_system = 'gmail'
    and job.job_kind = 'gmail_extract_message_model_claims'
    and job.state = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_fence = p_lease_fence
    and job.processor_version = p_processor_version
    and job.lease_expires_at is not null
    and job.lease_expires_at > clock_timestamp()
  for share;
  if not found then
    raise exception 'truth model source-job lease is stale, wrong-kind, or unavailable'
      using errcode = '40001';
  end if;
  return v_job;
end;
$function$;

create or replace function private.create_truth_model_request(
  p_workspace_key text,
  p_logical_request_key text,
  p_source_job_id uuid,
  p_observation_id text,
  p_observation_content_hash text,
  p_plan_hash text,
  p_request_payload jsonb,
  p_request_payload_text text,
  p_model_snapshot text,
  p_prompt_version text,
  p_response_schema_version text,
  p_response_schema_hash text,
  p_processing_config_version text,
  p_processing_config_hash text,
  p_pricing_policy_id text,
  p_transport text,
  p_max_output_tokens integer,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_job_lineage public.source_processing_job_lineage%rowtype;
  v_observation public.source_observations%rowtype;
  v_policy public.truth_model_pricing_policies%rowtype;
  v_existing public.truth_model_requests%rowtype;
  v_hash text;
  v_id text;
  v_max_attempts integer;
  v_request_payload_hash text;
  v_request_payload_bytes integer;
  v_max_input_tokens integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if nullif(trim(coalesce(p_logical_request_key, '')), '') is null
    or p_source_job_id is null
    or coalesce(p_observation_id, '') !~ '^obs:v1:[0-9a-f]{64}$'
    or coalesce(p_observation_content_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_plan_hash, '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(coalesce(p_request_payload, 'null'::jsonb)) <> 'object'
    or nullif(coalesce(p_request_payload_text, ''), '') is null
    or nullif(trim(coalesce(p_model_snapshot, '')), '') is null
    or nullif(trim(coalesce(p_prompt_version, '')), '') is null
    or nullif(trim(coalesce(p_response_schema_version, '')), '') is null
    or coalesce(p_response_schema_hash, '') !~ '^[0-9a-f]{64}$'
    or nullif(trim(coalesce(p_processing_config_version, '')), '') is null
    or coalesce(p_processing_config_hash, '') !~ '^[0-9a-f]{64}$'
    or p_transport is null or not (p_transport = any (array['sync', 'batch']))
    or p_max_output_tokens is null or p_max_output_tokens <= 0 or p_max_output_tokens > 128000
  then
    raise exception 'truth model logical request is invalid' using errcode = '22023';
  end if;
  if octet_length(p_logical_request_key) > 500
    or octet_length(p_model_snapshot) > 200
    or octet_length(p_prompt_version) > 500
    or octet_length(p_response_schema_version) > 500
    or octet_length(p_processing_config_version) > 500 then
    raise exception 'truth model logical request field is too long' using errcode = '22023';
  end if;
  v_job := private.require_live_truth_model_source_job(
    p_workspace_key, p_source_job_id, p_worker_id, p_lease_fence, p_processor_version
  );
  if jsonb_typeof(v_job.payload) <> 'object'
    or not private.truth_jsonb_has_only_keys(v_job.payload, array[
      'schemaVersion', 'modelPlanId', 'contextSealId', 'batchId',
      'rootBatchId', 'rootJobId', 'parentJobId'
    ])
    or v_job.payload->>'schemaVersion' is distinct from 'gmail-model-claims-job-v1'
    or v_job.payload->>'modelPlanId' is distinct from ('gmail-model-plan:v1:' || p_plan_hash)
    or coalesce(v_job.payload->>'contextSealId', '')
      !~ '^gmail-model-context:v1:[0-9a-f]{64}$' then
    raise exception 'truth model request is not bound to the leased Gmail model plan payload'
      using errcode = '23514';
  end if;
  select * into v_job_lineage from public.source_processing_job_lineage lineage
  where lineage.job_id = v_job.job_id;
  if not found or v_job_lineage.parent_job_id is null
    or v_job.payload->>'batchId' is distinct from v_job_lineage.root_batch_id::text
    or v_job.payload->>'rootBatchId' is distinct from v_job_lineage.root_batch_id::text
    or v_job.payload->>'rootJobId' is distinct from v_job_lineage.root_job_id::text
    or v_job.payload->>'parentJobId' is distinct from v_job_lineage.parent_job_id::text then
    raise exception 'truth model request source-job payload differs from immutable processing lineage'
      using errcode = '23514';
  end if;
  if v_job.observation_id is distinct from p_observation_id then
    raise exception 'truth model request source job is unavailable or targets another observation'
      using errcode = '23503';
  end if;
  select * into v_observation from public.source_observations observation
  where observation.observation_id = p_observation_id
    and observation.workspace_key = p_workspace_key;
  if not found or v_observation.content_hash is distinct from p_observation_content_hash then
    raise exception 'truth model request observation content identity is stale'
      using errcode = '23514';
  end if;
  select * into v_policy from public.truth_model_pricing_policies policy
  where policy.pricing_policy_id = p_pricing_policy_id;
  if not found or v_policy.model_snapshot is distinct from p_model_snapshot
    or v_policy.transport is distinct from p_transport then
    raise exception 'truth model request pricing policy does not match model and transport'
      using errcode = '23514';
  end if;
  begin
    if p_request_payload_text::jsonb is distinct from p_request_payload then
      raise exception 'exact truth model request text does not match request JSON'
        using errcode = '23514';
    end if;
  exception when invalid_text_representation then
    raise exception 'exact truth model request text is not valid JSON'
      using errcode = '22023';
  end;
  if p_request_payload->>'model' is distinct from p_model_snapshot
    or coalesce(p_request_payload->>'max_output_tokens', '') !~ '^[0-9]+$'
    or (p_request_payload->>'max_output_tokens')::integer is distinct from p_max_output_tokens
    or p_request_payload->'store' is distinct from 'false'::jsonb
    or coalesce(p_request_payload->'stream', 'false'::jsonb) is distinct from 'false'::jsonb
    or p_request_payload #>> '{metadata,model_plan_hash}' is distinct from p_plan_hash
    or p_request_payload #>> '{metadata,source_observation_id}' is distinct from p_observation_id
    or p_request_payload #>> '{metadata,source_content_hash}'
      is distinct from p_observation_content_hash
    or p_request_payload #>> '{metadata,prompt_version}' is distinct from p_prompt_version
    or p_request_payload #>> '{text,format,type}' is distinct from 'json_schema'
    or p_request_payload #>> '{text,format,strict}' is distinct from 'true'
    or nullif(trim(coalesce(p_request_payload->>'prompt_cache_key', '')), '') is null
    or encode(extensions.digest(convert_to(
      (p_request_payload #> '{text,format,schema}')::text, 'UTF8'
    ), 'sha256'), 'hex') is distinct from p_response_schema_hash then
    raise exception 'exact truth model request payload escapes declared model authority'
      using errcode = '23514';
  end if;
  v_request_payload_bytes := octet_length(p_request_payload_text);
  if v_request_payload_bytes <= 0 or v_request_payload_bytes > 400000
    or v_request_payload_bytes + p_max_output_tokens > 400000 then
    raise exception 'truth model canonical request exceeds the pinned model context bound'
      using errcode = '22023';
  end if;
  -- One token can never exceed the number of UTF-8 bytes in the exact canonical
  -- JSON request. Reserving one input token per byte is deliberately conservative.
  v_max_input_tokens := v_request_payload_bytes;
  v_request_payload_hash := encode(extensions.digest(
    convert_to(p_request_payload_text, 'UTF8'), 'sha256'
  ), 'hex');
  v_max_attempts := case when p_transport = 'sync' then 3 else 1 end;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-model-logical-request-v1',
    'workspaceKey', p_workspace_key,
    'logicalRequestKey', p_logical_request_key,
    'sourceJobId', p_source_job_id,
    'observationId', p_observation_id,
    'observationContentHash', p_observation_content_hash,
    'planHash', p_plan_hash,
    'requestPayloadHash', v_request_payload_hash,
    'requestPayloadBytes', v_request_payload_bytes,
    'modelSnapshot', p_model_snapshot,
    'promptVersion', p_prompt_version,
    'responseSchemaVersion', p_response_schema_version,
    'responseSchemaHash', p_response_schema_hash,
    'processingConfigVersion', p_processing_config_version,
    'processingConfigHash', p_processing_config_hash,
    'pricingPolicyId', p_pricing_policy_id,
    'pricingPolicyHash', v_policy.policy_hash,
    'transport', p_transport,
    'maxInputTokens', v_max_input_tokens,
    'maxOutputTokens', p_max_output_tokens,
    'maxAttempts', v_max_attempts
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_id := 'model-request:v1:' || v_hash;
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-model-request:' || p_workspace_key || ':' || p_logical_request_key, 0
  ));
  select * into v_existing from public.truth_model_requests request
  where request.workspace_key = p_workspace_key
    and request.logical_request_key = p_logical_request_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      raise exception 'truth model logical request key conflicts'
        using errcode = '23505';
    end if;
    return private.truth_model_request_receipt(v_existing.request_id, true);
  end if;
  insert into public.truth_model_requests (
    request_id, workspace_key, logical_request_key, request_hash,
    source_job_id, observation_id, observation_content_hash, plan_hash,
    request_payload, request_payload_text, request_payload_hash, request_payload_bytes,
    model_snapshot, prompt_version, response_schema_version, response_schema_hash,
    processing_config_version, processing_config_hash, pricing_policy_id,
    pricing_policy_hash, transport, max_input_tokens, max_output_tokens, max_attempts
  ) values (
    v_id, p_workspace_key, p_logical_request_key, v_hash,
    p_source_job_id, p_observation_id, p_observation_content_hash, p_plan_hash,
    p_request_payload, p_request_payload_text, v_request_payload_hash, v_request_payload_bytes,
    p_model_snapshot, p_prompt_version, p_response_schema_version, p_response_schema_hash,
    p_processing_config_version, p_processing_config_hash, p_pricing_policy_id,
    v_policy.policy_hash, p_transport, v_max_input_tokens, p_max_output_tokens, v_max_attempts
  );
  return private.truth_model_request_receipt(v_id, false);
end;
$function$;

create or replace function public.create_truth_model_request(
  p_workspace_key text,
  p_logical_request_key text,
  p_source_job_id uuid,
  p_observation_id text,
  p_observation_content_hash text,
  p_plan_hash text,
  p_request_payload jsonb,
  p_request_payload_text text,
  p_model_snapshot text,
  p_prompt_version text,
  p_response_schema_version text,
  p_response_schema_hash text,
  p_processing_config_version text,
  p_processing_config_hash text,
  p_pricing_policy_id text,
  p_transport text,
  p_max_output_tokens integer,
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
  select private.create_truth_model_request(
    p_workspace_key, p_logical_request_key, p_source_job_id, p_observation_id,
    p_observation_content_hash, p_plan_hash, p_request_payload, p_request_payload_text,
    p_model_snapshot, p_prompt_version,
    p_response_schema_version, p_response_schema_hash,
    p_processing_config_version, p_processing_config_hash,
    p_pricing_policy_id, p_transport, p_max_output_tokens,
    p_worker_id, p_lease_fence, p_processor_version,
    p_sync_token
  );
$function$;

create or replace function private.truth_model_usage_cost(
  p_pricing_policy_id text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_output_tokens bigint
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_policy public.truth_model_pricing_policies%rowtype;
  v_uncached bigint;
  v_cost numeric;
begin
  if p_input_tokens is null or p_input_tokens < 0
    or p_cached_input_tokens is null or p_cached_input_tokens < 0
    or p_cached_input_tokens > p_input_tokens
    or p_output_tokens is null or p_output_tokens < 0 then
    raise exception 'truth model usage token counts are invalid' using errcode = '22023';
  end if;
  select * into v_policy
  from public.truth_model_pricing_policies policy
  where policy.pricing_policy_id = p_pricing_policy_id;
  if not found then
    raise exception 'truth model pricing policy is unavailable' using errcode = '23503';
  end if;
  v_uncached := p_input_tokens - p_cached_input_tokens;
  v_cost := ceil((v_uncached::numeric * v_policy.input_microusd_per_million) / 1000000)
    + ceil((p_cached_input_tokens::numeric * v_policy.cached_input_microusd_per_million) / 1000000)
    + ceil((p_output_tokens::numeric * v_policy.output_microusd_per_million) / 1000000);
  if v_cost > 9223372036854775807::numeric then
    raise exception 'truth model usage cost overflow' using errcode = '22003';
  end if;
  return v_cost::bigint;
end;
$function$;

create or replace function private.truth_model_request_receipt(
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
    'ok', not (request.state = any (array['review_required', 'outcome_unknown'])),
    'idempotent', p_idempotent,
    'requestId', request.request_id,
    'workspaceKey', request.workspace_key,
    'logicalRequestKey', request.logical_request_key,
    'requestHash', request.request_hash,
    'sourceJobId', request.source_job_id,
    'observationId', request.observation_id,
    'observationContentHash', request.observation_content_hash,
    'planHash', request.plan_hash,
    'requestPayload', request.request_payload,
    'requestPayloadText', request.request_payload_text,
    'requestPayloadHash', request.request_payload_hash,
    'requestPayloadBytes', request.request_payload_bytes,
    'modelSnapshot', request.model_snapshot,
    'promptVersion', request.prompt_version,
    'responseSchemaVersion', request.response_schema_version,
    'responseSchemaHash', request.response_schema_hash,
    'processingConfigVersion', request.processing_config_version,
    'processingConfigHash', request.processing_config_hash,
    'pricingPolicyId', request.pricing_policy_id,
    'pricingPolicyHash', request.pricing_policy_hash,
    'transport', request.transport,
    'maxInputTokens', request.max_input_tokens,
    'maxOutputTokens', request.max_output_tokens,
    'maxAttempts', request.max_attempts,
    'state', request.state,
    'reservationDate', request.reservation_date,
    'initialReservedInputTokens', request.initial_reserved_input_tokens,
    'initialReservedOutputTokens', request.initial_reserved_output_tokens,
    'remainingReservedInputTokens', request.remaining_reserved_input_tokens,
    'remainingReservedOutputTokens', request.remaining_reserved_output_tokens,
    'initialReservedMicroUsd', request.initial_reserved_microusd,
    'remainingReservedMicroUsd', request.remaining_reserved_microusd,
    'actualInputTokens', request.actual_input_tokens,
    'actualCachedInputTokens', request.actual_cached_input_tokens,
    'actualOutputTokens', request.actual_output_tokens,
    'actualReasoningTokens', request.actual_reasoning_tokens,
    'actualTotalTokens', request.actual_total_tokens,
    'actualMicroUsd', request.actual_microusd,
    'attemptCount', (
      select count(*)::integer
      from public.truth_model_sync_attempt_dispatches dispatch
      where dispatch.request_id = request.request_id
    ),
    'reviewReason', request.review_reason,
    'createdAt', request.created_at,
    'reservedAt', request.reserved_at,
    'finalizedAt', request.finalized_at,
    'mutatesOperationalState', false
  )
  from public.truth_model_requests request
  where request.request_id = p_request_id;
$function$;

create or replace function private.guard_truth_model_account_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth model workspace accounts cannot be deleted' using errcode = '55000';
  end if;
  if new.workspace_key is distinct from old.workspace_key
    or new.created_at is distinct from old.created_at
    or new.actual_microusd < old.actual_microusd
    or new.actual_microusd + new.reserved_microusd > new.lifetime_allocation_microusd then
    raise exception 'truth model workspace account transition is invalid' using errcode = '55000';
  end if;
  if row(new.status, new.lifetime_allocation_microusd, new.daily_ceiling_microusd,
      new.configured_at, new.configured_by, new.configuration_reason)
      is distinct from
      row(old.status, old.lifetime_allocation_microusd, old.daily_ceiling_microusd,
      old.configured_at, old.configured_by, old.configuration_reason) then
    if new.configuration_version <> old.configuration_version + 1 then
      raise exception 'truth model account configuration version did not advance'
        using errcode = '55000';
    end if;
  elsif new.configuration_version is distinct from old.configuration_version then
    raise exception 'truth model account configuration version changed without configuration'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function private.guard_truth_model_daily_usage_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth model daily usage cannot be deleted' using errcode = '55000';
  end if;
  if new.workspace_key is distinct from old.workspace_key
    or new.usage_date is distinct from old.usage_date
    or new.actual_input_tokens < old.actual_input_tokens
    or new.actual_cached_input_tokens < old.actual_cached_input_tokens
    or new.actual_output_tokens < old.actual_output_tokens
    or new.actual_reasoning_tokens < old.actual_reasoning_tokens
    or new.actual_total_tokens < old.actual_total_tokens
    or new.actual_microusd < old.actual_microusd then
    raise exception 'truth model daily usage transition is invalid' using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function private.guard_truth_model_request_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'truth model requests cannot be deleted' using errcode = '55000';
  end if;
  if row(new.request_id, new.workspace_key, new.logical_request_key, new.request_hash,
      new.source_job_id, new.observation_id, new.observation_content_hash, new.plan_hash,
      new.request_payload, new.request_payload_text, new.request_payload_hash, new.request_payload_bytes,
      new.model_snapshot, new.prompt_version, new.response_schema_version,
      new.response_schema_hash, new.processing_config_version, new.processing_config_hash,
      new.pricing_policy_id, new.pricing_policy_hash, new.transport,
      new.max_input_tokens, new.max_output_tokens, new.max_attempts, new.created_at)
      is distinct from
      row(old.request_id, old.workspace_key, old.logical_request_key, old.request_hash,
      old.source_job_id, old.observation_id, old.observation_content_hash, old.plan_hash,
      old.request_payload, old.request_payload_text, old.request_payload_hash, old.request_payload_bytes,
      old.model_snapshot, old.prompt_version, old.response_schema_version,
      old.response_schema_hash, old.processing_config_version, old.processing_config_hash,
      old.pricing_policy_id, old.pricing_policy_hash, old.transport,
      old.max_input_tokens, old.max_output_tokens, old.max_attempts, old.created_at)
    or new.actual_input_tokens < old.actual_input_tokens
    or new.actual_cached_input_tokens < old.actual_cached_input_tokens
    or new.actual_output_tokens < old.actual_output_tokens
    or new.actual_reasoning_tokens < old.actual_reasoning_tokens
    or new.actual_total_tokens < old.actual_total_tokens
    or new.actual_microusd < old.actual_microusd then
    raise exception 'truth model request immutable or monotonic fields changed'
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
      raise exception 'truth model request initial reservation is incomplete'
        using errcode = '55000';
    end if;
  elsif row(new.reservation_date, new.initial_reserved_input_tokens,
      new.initial_reserved_output_tokens, new.initial_reserved_microusd, new.reserved_at)
      is distinct from row(old.reservation_date, old.initial_reserved_input_tokens,
      old.initial_reserved_output_tokens, old.initial_reserved_microusd, old.reserved_at)
    or new.remaining_reserved_input_tokens > old.remaining_reserved_input_tokens
    or new.remaining_reserved_output_tokens > old.remaining_reserved_output_tokens
    or new.remaining_reserved_microusd > old.remaining_reserved_microusd then
    raise exception 'truth model request reservation identity regressed'
      using errcode = '55000';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'planned' and new.state = any (array['reserved', 'review_required']))
    or (old.state = 'reserved' and new.state = any (array['in_flight', 'review_required']))
    or (old.state = 'in_flight' and new.state = any (array[
      'reserved', 'succeeded', 'review_required', 'outcome_unknown'
    ]))
  ) then
    raise exception 'truth model request state transition is invalid' using errcode = '55000';
  end if;
  return new;
end;
$function$;

create or replace function private.reserve_truth_model_request(
  p_workspace_key text,
  p_request_id text,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
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
  v_request public.truth_model_requests%rowtype;
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
  select * into v_request from public.truth_model_requests request
  where request.request_id = p_request_id and request.workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'truth model request is unavailable' using errcode = '23503';
  end if;
  perform private.require_live_truth_model_source_job(
    p_workspace_key, v_request.source_job_id, p_worker_id,
    p_lease_fence, p_processor_version
  );
  if v_request.state <> 'planned' then
    return private.truth_model_request_receipt(v_request.request_id, true);
  end if;
  -- Batch item submission/reconciliation is intentionally not enabled by this
  -- primitives checkpoint. Refuse before reservation so no money can strand.
  if v_request.transport = 'batch' then
    update public.truth_model_requests request
    set state = 'review_required', review_reason = 'BATCH_RUNTIME_NOT_ENABLED',
        finalized_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_model_request_receipt(v_request.request_id, false);
  end if;
  select * into v_account from public.truth_model_workspace_accounts account
  where account.workspace_key = p_workspace_key for update;
  if not found or v_account.status <> 'enabled' then
    update public.truth_model_requests request
    set state = 'review_required', review_reason = 'MODEL_ACCOUNT_DISABLED',
        finalized_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_model_request_receipt(v_request.request_id, false);
  end if;
  insert into public.truth_model_workspace_daily_usage(workspace_key, usage_date)
  values (p_workspace_key, v_usage_date)
  on conflict (workspace_key, usage_date) do nothing;
  select * into v_daily from public.truth_model_workspace_daily_usage usage
  where usage.workspace_key = p_workspace_key and usage.usage_date = v_usage_date
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
  if v_account.actual_microusd + v_account.reserved_microusd + v_reserved_microusd
      > v_account.lifetime_allocation_microusd then
    v_reason := 'MODEL_LIFETIME_BUDGET_EXHAUSTED';
  elsif v_daily.actual_microusd + v_daily.reserved_microusd + v_reserved_microusd
      > v_account.daily_ceiling_microusd then
    v_reason := 'MODEL_DAILY_BUDGET_EXHAUSTED';
  end if;
  if v_reason <> '' then
    update public.truth_model_requests request
    set state = 'review_required', review_reason = v_reason, finalized_at = v_now
    where request.request_id = v_request.request_id;
    return private.truth_model_request_receipt(v_request.request_id, false);
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
  where usage.workspace_key = p_workspace_key and usage.usage_date = v_usage_date;
  update public.truth_model_requests request
  set state = 'reserved', reservation_date = v_usage_date,
      initial_reserved_input_tokens = v_reserved_input,
      initial_reserved_output_tokens = v_reserved_output,
      remaining_reserved_input_tokens = v_reserved_input,
      remaining_reserved_output_tokens = v_reserved_output,
      initial_reserved_microusd = v_reserved_microusd,
      remaining_reserved_microusd = v_reserved_microusd,
      reserved_at = v_now
  where request.request_id = v_request.request_id;
  return private.truth_model_request_receipt(v_request.request_id, false);
end;
$function$;

create or replace function public.reserve_truth_model_request(
  p_workspace_key text,
  p_request_id text,
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
  select private.reserve_truth_model_request(
    p_workspace_key, p_request_id, p_worker_id, p_lease_fence,
    p_processor_version, p_sync_token
  );
$function$;

drop trigger if exists truth_model_pricing_immutable on public.truth_model_pricing_policies;
create trigger truth_model_pricing_immutable before update or delete
on public.truth_model_pricing_policies for each row
execute function public.reject_immutable_truth_mutation();
drop trigger if exists truth_model_account_configuration_immutable
  on public.truth_model_account_configuration_requests;
create trigger truth_model_account_configuration_immutable before update or delete
on public.truth_model_account_configuration_requests for each row
execute function public.reject_immutable_truth_mutation();
drop trigger if exists truth_model_dispatch_immutable
  on public.truth_model_sync_attempt_dispatches;
create trigger truth_model_dispatch_immutable before update or delete
on public.truth_model_sync_attempt_dispatches for each row
execute function public.reject_immutable_truth_mutation();
drop trigger if exists truth_model_outcome_immutable
  on public.truth_model_sync_attempt_outcomes;
create trigger truth_model_outcome_immutable before update or delete
on public.truth_model_sync_attempt_outcomes for each row
execute function public.reject_immutable_truth_mutation();
drop trigger if exists truth_model_account_guard on public.truth_model_workspace_accounts;
create trigger truth_model_account_guard before update or delete
on public.truth_model_workspace_accounts for each row
execute function private.guard_truth_model_account_update();
drop trigger if exists truth_model_daily_usage_guard
  on public.truth_model_workspace_daily_usage;
create trigger truth_model_daily_usage_guard before update or delete
on public.truth_model_workspace_daily_usage for each row
execute function private.guard_truth_model_daily_usage_update();
drop trigger if exists truth_model_request_guard on public.truth_model_requests;
create trigger truth_model_request_guard before update or delete
on public.truth_model_requests for each row
execute function private.guard_truth_model_request_update();

create or replace function private.configure_truth_model_account(
  p_workspace_key text,
  p_configuration_request_key text,
  p_status text,
  p_lifetime_allocation_microusd bigint,
  p_daily_ceiling_microusd bigint,
  p_configured_by text,
  p_configuration_reason text,
  p_issuer_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_id text;
  v_account public.truth_model_workspace_accounts%rowtype;
  v_existing public.truth_model_account_configuration_requests%rowtype;
begin
  if not private.valid_truth_model_account_issuer_token(p_issuer_token) then
    raise exception 'invalid truth model account issuer token' using errcode = '28000';
  end if;
  if p_status is null or not (p_status = any (array['disabled', 'enabled']))
    or nullif(trim(coalesce(p_configuration_request_key, '')), '') is null
    or nullif(trim(coalesce(p_configured_by, '')), '') is null
    or nullif(trim(coalesce(p_configuration_reason, '')), '') is null
    or p_lifetime_allocation_microusd is null or p_lifetime_allocation_microusd <= 0
    or p_daily_ceiling_microusd is null or p_daily_ceiling_microusd <= 0
    or p_daily_ceiling_microusd > p_lifetime_allocation_microusd then
    raise exception 'truth model account configuration is invalid' using errcode = '22023';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-model-account-configuration-v1',
    'workspaceKey', p_workspace_key,
    'configurationRequestKey', p_configuration_request_key,
    'status', p_status,
    'lifetimeAllocationMicroUsd', p_lifetime_allocation_microusd,
    'dailyCeilingMicroUsd', p_daily_ceiling_microusd,
    'configuredBy', p_configured_by,
    'configurationReason', p_configuration_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_id := 'model-account-config:v1:' || v_hash;
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-model-account-config:' || p_workspace_key || ':' || p_configuration_request_key, 0
  ));
  select * into v_existing
  from public.truth_model_account_configuration_requests request
  where request.workspace_key = p_workspace_key
    and request.configuration_request_key = p_configuration_request_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      raise exception 'truth model account configuration key conflicts'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'ok', true, 'idempotent', true,
      'configurationRequestId', v_existing.configuration_request_id,
      'workspaceKey', v_existing.workspace_key,
      'status', v_existing.status,
      'lifetimeAllocationMicroUsd', v_existing.lifetime_allocation_microusd,
      'dailyCeilingMicroUsd', v_existing.daily_ceiling_microusd,
      'configurationVersion', v_existing.configuration_version
    );
  end if;
  select * into v_account
  from public.truth_model_workspace_accounts account
  where account.workspace_key = p_workspace_key
  for update;
  if not found then
    insert into public.truth_model_workspace_accounts(workspace_key)
    values (p_workspace_key) returning * into v_account;
  end if;
  if p_lifetime_allocation_microusd < v_account.actual_microusd + v_account.reserved_microusd
    or p_daily_ceiling_microusd < (
      select coalesce(max(usage.actual_microusd + usage.reserved_microusd), 0)
      from public.truth_model_workspace_daily_usage usage
      where usage.workspace_key = p_workspace_key
    ) then
    raise exception 'truth model account configuration is below committed usage'
      using errcode = '23514';
  end if;
  update public.truth_model_workspace_accounts account
  set status = p_status,
      lifetime_allocation_microusd = p_lifetime_allocation_microusd,
      daily_ceiling_microusd = p_daily_ceiling_microusd,
      configuration_version = account.configuration_version + 1,
      configured_at = v_now,
      configured_by = p_configured_by,
      configuration_reason = p_configuration_reason,
      updated_at = v_now
  where account.workspace_key = p_workspace_key
  returning * into v_account;
  insert into public.truth_model_account_configuration_requests (
    configuration_request_id, workspace_key, configuration_request_key,
    request_hash, status, lifetime_allocation_microusd, daily_ceiling_microusd,
    configured_by, configuration_reason, configuration_version, configured_at
  ) values (
    v_id, p_workspace_key, p_configuration_request_key, v_hash, p_status,
    p_lifetime_allocation_microusd, p_daily_ceiling_microusd,
    p_configured_by, p_configuration_reason, v_account.configuration_version, v_now
  );
  return jsonb_build_object(
    'ok', true, 'idempotent', false, 'configurationRequestId', v_id,
    'workspaceKey', p_workspace_key, 'status', p_status,
    'lifetimeAllocationMicroUsd', p_lifetime_allocation_microusd,
    'dailyCeilingMicroUsd', p_daily_ceiling_microusd,
    'configurationVersion', v_account.configuration_version
  );
end;
$function$;

create or replace function public.configure_truth_model_account(
  p_workspace_key text,
  p_configuration_request_key text,
  p_status text,
  p_lifetime_allocation_microusd bigint,
  p_daily_ceiling_microusd bigint,
  p_configured_by text,
  p_configuration_reason text,
  p_issuer_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.configure_truth_model_account(
    p_workspace_key, p_configuration_request_key, p_status,
    p_lifetime_allocation_microusd, p_daily_ceiling_microusd,
    p_configured_by, p_configuration_reason, p_issuer_token
  );
$function$;

create or replace function private.truth_model_attempt_receipt(
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
  select jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'idempotent', p_idempotent,
    'sendAuthorized', p_send_authorized,
    'dispatchId', dispatch.dispatch_id,
    'requestId', dispatch.request_id,
    'workspaceKey', dispatch.workspace_key,
    'attemptNumber', dispatch.attempt_number,
    'clientRequestId', dispatch.client_request_id,
    'dispatchedAt', dispatch.dispatched_at,
    'classification', outcome.classification,
    'providerResultHash', outcome.provider_result_hash,
    'requestSent', outcome.request_sent,
    'httpStatus', outcome.http_status,
    'requestBodyHash', outcome.request_body_hash,
    'requestBodyBytes', outcome.request_body_bytes,
    'providerResponseBodyHash', outcome.provider_response_body_hash,
    'providerResponseBodyBytes', outcome.provider_response_body_bytes,
    'providerErrorCode', outcome.provider_error_code,
    'incompleteReason', outcome.incomplete_reason,
    'outcomeUnknown', outcome.outcome_unknown,
    'billingOutcomeUnknown', outcome.billing_outcome_unknown,
    'providerResponseId', outcome.provider_response_id,
    'serverRequestId', outcome.server_request_id,
    'actualModel', outcome.actual_model,
    'normalizedResult', outcome.normalized_result,
    'normalizedResultHash', outcome.normalized_result_hash,
    'inputTokens', outcome.input_tokens,
    'cachedInputTokens', outcome.cached_input_tokens,
    'outputTokens', outcome.output_tokens,
    'reasoningTokens', outcome.reasoning_tokens,
    'totalTokens', outcome.total_tokens,
    'actualMicroUsd', outcome.actual_microusd,
    'request', private.truth_model_request_receipt(dispatch.request_id, p_idempotent)
  )) || case when outcome.normalized_result is null then '{}'::jsonb
    else jsonb_build_object('normalizedResult', outcome.normalized_result) end
  from public.truth_model_sync_attempt_dispatches dispatch
  left join public.truth_model_sync_attempt_outcomes outcome
    on outcome.dispatch_id = dispatch.dispatch_id
  where dispatch.dispatch_id = p_dispatch_id;
$function$;

create or replace function private.begin_truth_model_sync_attempt(
  p_workspace_key text,
  p_request_id text,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.truth_model_requests%rowtype;
  v_dispatch public.truth_model_sync_attempt_dispatches%rowtype;
  v_account public.truth_model_workspace_accounts%rowtype;
  v_attempt_number integer;
  v_hash text;
  v_id text;
  v_client_request_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  select * into v_request from public.truth_model_requests request
  where request.request_id = p_request_id and request.workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'truth model request is unavailable' using errcode = '23503';
  end if;
  perform private.require_live_truth_model_source_job(
    p_workspace_key, v_request.source_job_id, p_worker_id,
    p_lease_fence, p_processor_version
  );
  if v_request.transport <> 'sync' then
    raise exception 'truth model sync attempt requires sync transport' using errcode = '22023';
  end if;
  if v_request.state = 'in_flight' then
    select dispatch.* into v_dispatch
    from public.truth_model_sync_attempt_dispatches dispatch
    left join public.truth_model_sync_attempt_outcomes outcome
      on outcome.dispatch_id = dispatch.dispatch_id
    where dispatch.request_id = v_request.request_id and outcome.outcome_id is null
    order by dispatch.attempt_number desc limit 1;
    if not found then
      raise exception 'truth model request has an in-flight state without a dispatch'
        using errcode = '23514';
    end if;
    -- A crash may have happened after POST. Return the durable identity but
    -- never authorize replay to send the same or a new HTTP request.
    return private.truth_model_attempt_receipt(v_dispatch.dispatch_id, true, false);
  end if;
  if v_request.state = 'outcome_unknown' then
    raise exception 'truth model request outcome is unknown; another attempt is forbidden'
      using errcode = '55000';
  end if;
  if v_request.state <> 'reserved' then
    raise exception 'truth model request is not reserved for an attempt'
      using errcode = '55000';
  end if;
  select * into v_account from public.truth_model_workspace_accounts account
  where account.workspace_key = p_workspace_key for update;
  if not found or v_account.status <> 'enabled' then
    if not found then
      raise exception 'truth model account disappeared after reservation'
        using errcode = '23514';
    end if;
    update public.truth_model_workspace_accounts account
    set reserved_microusd = account.reserved_microusd
          - v_request.remaining_reserved_microusd,
        updated_at = clock_timestamp()
    where account.workspace_key = p_workspace_key;
    update public.truth_model_workspace_daily_usage usage
    set reserved_input_tokens = usage.reserved_input_tokens
          - v_request.remaining_reserved_input_tokens,
        reserved_output_tokens = usage.reserved_output_tokens
          - v_request.remaining_reserved_output_tokens,
        reserved_microusd = usage.reserved_microusd
          - v_request.remaining_reserved_microusd,
        updated_at = clock_timestamp()
    where usage.workspace_key = p_workspace_key
      and usage.usage_date = v_request.reservation_date;
    update public.truth_model_requests request
    set state = 'review_required', review_reason = 'MODEL_ACCOUNT_DISABLED_BEFORE_SEND',
        remaining_reserved_input_tokens = 0,
        remaining_reserved_output_tokens = 0,
        remaining_reserved_microusd = 0,
        finalized_at = clock_timestamp()
    where request.request_id = v_request.request_id;
    return private.truth_model_request_receipt(v_request.request_id, false)
      || jsonb_build_object('sendAuthorized', false);
  end if;
  select count(*)::integer + 1 into v_attempt_number
  from public.truth_model_sync_attempt_dispatches dispatch
  where dispatch.request_id = v_request.request_id;
  if v_attempt_number > v_request.max_attempts then
    raise exception 'truth model sync attempt cap is exhausted' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.truth_model_sync_attempt_dispatches dispatch
    left join public.truth_model_sync_attempt_outcomes outcome
      on outcome.dispatch_id = dispatch.dispatch_id
    where dispatch.request_id = v_request.request_id and outcome.outcome_id is null
  ) then
    raise exception 'truth model prior attempt has no durable outcome' using errcode = '55000';
  end if;
  v_client_request_id := 'model-client:v1:' || encode(extensions.digest(
    convert_to(v_request.request_id || ':' || v_attempt_number::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-model-sync-dispatch-v1',
    'workspaceKey', p_workspace_key,
    'requestId', v_request.request_id,
    'attemptNumber', v_attempt_number,
    'clientRequestId', v_client_request_id
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_id := 'model-dispatch:v1:' || v_hash;
  insert into public.truth_model_sync_attempt_dispatches (
    dispatch_id, request_id, workspace_key, attempt_number,
    client_request_id, dispatch_hash
  ) values (
    v_id, v_request.request_id, p_workspace_key, v_attempt_number,
    v_client_request_id, v_hash
  ) returning * into v_dispatch;
  update public.truth_model_requests request set state = 'in_flight'
  where request.request_id = v_request.request_id;
  return private.truth_model_attempt_receipt(v_dispatch.dispatch_id, false, true);
end;
$function$;

create or replace function public.begin_truth_model_sync_attempt(
  p_workspace_key text,
  p_request_id text,
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
  select private.begin_truth_model_sync_attempt(
    p_workspace_key, p_request_id, p_worker_id, p_lease_fence,
    p_processor_version, p_sync_token
  );
$function$;

create or replace function private.reconcile_truth_model_sync_attempt(
  p_workspace_key text,
  p_request_id text,
  p_attempt_number integer,
  p_dispatch_id text,
  p_client_request_id text,
  p_provider_result_hash text,
  p_classification text,
  p_request_sent boolean,
  p_http_status integer,
  p_request_body_hash text,
  p_request_body_bytes integer,
  p_provider_response_body_hash text,
  p_provider_response_body_bytes integer,
  p_provider_error_code text,
  p_incomplete_reason text,
  p_provider_response_id text,
  p_server_request_id text,
  p_actual_model text,
  p_normalized_result jsonb,
  p_normalized_result_hash text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_output_tokens bigint,
  p_reasoning_tokens bigint,
  p_total_tokens bigint,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_request public.truth_model_requests%rowtype;
  v_dispatch public.truth_model_sync_attempt_dispatches%rowtype;
  v_existing public.truth_model_sync_attempt_outcomes%rowtype;
  v_hash text;
  v_id text;
  v_cost bigint := 0;
  v_retryable boolean;
  v_unknown boolean;
  v_zero_cost boolean;
  v_terminal boolean;
  v_reason text := '';
  v_result_hash text := coalesce(p_normalized_result_hash, '');
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if p_attempt_number is null or p_attempt_number < 1 or p_attempt_number > 3
    or coalesce(p_dispatch_id, '') !~ '^model-dispatch:v1:[0-9a-f]{64}$'
    or nullif(trim(coalesce(p_client_request_id, '')), '') is null
    or coalesce(p_provider_result_hash, '') !~ '^[0-9a-f]{64}$'
    or p_classification is null or not (p_classification = any (array[
      'success', 'pre_send_failure', 'rate_limited', 'rate_limited_usage_known',
      'server_error_usage_known', 'insufficient_quota', 'refusal',
      'content_filter', 'incomplete', 'malformed_output',
      'configuration_error', 'model_mismatch', 'outcome_unknown', 'billing_unknown'
    ])) then
    raise exception 'truth model attempt reconciliation is invalid' using errcode = '22023';
  end if;
  select * into v_request from public.truth_model_requests request
  where request.request_id = p_request_id and request.workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'truth model request is unavailable' using errcode = '23503';
  end if;
  select * into v_dispatch from public.truth_model_sync_attempt_dispatches dispatch
  where dispatch.request_id = v_request.request_id
    and dispatch.attempt_number = p_attempt_number
    and dispatch.dispatch_id = p_dispatch_id;
  if not found then
    raise exception 'truth model attempt dispatch is unavailable' using errcode = '23503';
  end if;
  if v_dispatch.client_request_id is distinct from p_client_request_id then
    raise exception 'truth model attempt client request identity differs from dispatch'
      using errcode = '23514';
  end if;
  v_unknown := p_classification = any (array[
    'outcome_unknown', 'billing_unknown', 'model_mismatch'
  ]);
  v_zero_cost := p_classification = any (array[
    'pre_send_failure', 'rate_limited', 'insufficient_quota', 'configuration_error'
  ]) or (
    p_classification = 'content_filter'
    and p_http_status = any (array[400, 403])
    and p_total_tokens = 0
  );
  v_retryable := p_classification = any (array[
    'pre_send_failure', 'rate_limited', 'rate_limited_usage_known',
    'server_error_usage_known'
  ]);
  if p_request_sent is null then
    raise exception 'truth model requestSent receipt is required' using errcode = '22023';
  end if;
  if coalesce(p_request_body_hash, '') is distinct from v_request.request_payload_hash
    or p_request_body_bytes is distinct from v_request.request_payload_bytes then
    raise exception 'truth model attempt request body differs from sealed wire request'
      using errcode = '23514';
  end if;
  if p_provider_response_body_bytes is null or p_provider_response_body_bytes < 0
    or p_provider_response_body_bytes > 2097152
    or not (
      (coalesce(p_provider_response_body_hash, '') = '' and p_provider_response_body_bytes = 0)
      or (coalesce(p_provider_response_body_hash, '') ~ '^[0-9a-f]{64}$'
        and p_provider_response_body_bytes > 0)
    ) then
    raise exception 'truth model provider response body receipt is invalid'
      using errcode = '22023';
  end if;
  if p_request_sent is not true then
    if p_classification <> all (array['pre_send_failure', 'configuration_error'])
      or p_http_status is not null
      or coalesce(p_provider_response_body_hash, '') <> ''
      or p_provider_response_body_bytes <> 0
      or coalesce(p_provider_response_id, '') <> ''
      or coalesce(p_server_request_id, '') <> '' then
      raise exception 'unsent truth model attempt carries provider evidence or unsafe class'
        using errcode = '23514';
    end if;
  elsif p_classification = 'pre_send_failure' then
    raise exception 'pre-send truth model classification cannot claim a transmitted request'
      using errcode = '23514';
  elsif p_classification = 'configuration_error' then
    if p_http_status is null or not (p_http_status = any (array[400, 401, 403, 404, 409, 422]))
      or coalesce(p_provider_response_body_hash, '') = ''
      or nullif(trim(coalesce(p_provider_error_code, '')), '') is null then
      raise exception 'zero-cost transmitted configuration error lacks exact non-billable evidence'
        using errcode = '23514';
    end if;
  elsif p_classification = 'outcome_unknown' then
    if p_http_status is not null then
      raise exception 'transport-unknown truth model outcome cannot claim HTTP status'
        using errcode = '23514';
    end if;
  elsif p_classification = 'billing_unknown' then
    if p_http_status is null and coalesce(p_provider_response_body_hash, '') = '' then
      raise exception 'billing-unknown truth model outcome lacks response evidence'
        using errcode = '23514';
    end if;
  elsif p_classification = any (array['rate_limited', 'rate_limited_usage_known']) then
    if p_http_status is distinct from 429 or nullif(trim(coalesce(p_provider_error_code, '')), '') is null then
      raise exception 'rate limit lacks exact 429 error evidence'
        using errcode = '23514';
    end if;
    if p_classification = 'rate_limited_usage_known'
      and (p_total_tokens is null or p_total_tokens <= 0
        or nullif(trim(coalesce(p_actual_model, '')), '') is null
        or coalesce(p_provider_response_body_hash, '') = ''
        or nullif(trim(coalesce(p_provider_response_id, '')), '') is null
        or nullif(trim(coalesce(p_server_request_id, '')), '') is null) then
      raise exception 'usage-known rate limit lacks trustworthy billed response identity'
        using errcode = '23514';
    end if;
  elsif p_classification = 'insufficient_quota' then
    if p_http_status is null or not (p_http_status = any (array[400, 429]))
      or coalesce(p_provider_error_code, '') !~
        '(insufficient_quota|billing_hard_limit|billing_not_active|credit)' then
      raise exception 'zero-cost insufficient quota lacks exact provider evidence'
        using errcode = '23514';
    end if;
  elsif p_classification = 'content_filter'
    and p_http_status = any (array[400, 403]) then
    if coalesce(p_provider_response_body_hash, '') = ''
      or nullif(trim(coalesce(p_provider_error_code, '')), '') is null then
      raise exception 'zero-cost provider content filter lacks exact rejection evidence'
        using errcode = '23514';
    end if;
  elsif p_classification = 'server_error_usage_known' then
    if p_http_status is null or p_http_status < 500 or p_http_status > 599 then
      raise exception 'usage-known server error lacks a 5xx status'
        using errcode = '23514';
    end if;
  elsif p_http_status is null or p_http_status < 200 or p_http_status > 299 then
    raise exception 'billable truth model outcome lacks a successful HTTP status'
      using errcode = '23514';
  end if;
  if not v_unknown and not v_zero_cost
    and coalesce(p_provider_response_body_hash, '') = '' then
    raise exception 'billable truth model outcome lacks immutable response body evidence'
      using errcode = '23514';
  end if;
  if p_input_tokens is null or p_input_tokens < 0
    or p_cached_input_tokens is null or p_cached_input_tokens < 0
    or p_cached_input_tokens > p_input_tokens
    or p_output_tokens is null or p_output_tokens < 0
    or p_reasoning_tokens is null or p_reasoning_tokens < 0
    or p_reasoning_tokens > p_output_tokens
    or p_total_tokens is null or p_total_tokens <> p_input_tokens + p_output_tokens then
    raise exception 'truth model attempt usage shape is invalid' using errcode = '22023';
  end if;
  if p_input_tokens > v_request.max_input_tokens
    or p_output_tokens > v_request.max_output_tokens then
    raise exception 'truth model attempt usage exceeds sealed per-attempt maxima'
      using errcode = '23514';
  end if;
  if ((v_unknown and p_classification <> 'model_mismatch') or v_zero_cost)
    and p_total_tokens <> 0 then
    raise exception 'unknown or explicit non-billable model outcome cannot claim usage'
      using errcode = '23514';
  end if;
  if p_classification = 'model_mismatch'
    and (p_total_tokens = 0
      or nullif(trim(coalesce(p_actual_model, '')), '') is null
      or p_actual_model is not distinct from v_request.model_snapshot
      or coalesce(p_provider_response_body_hash, '') = '') then
    raise exception 'model mismatch lacks a distinct actual model and trustworthy usage'
      using errcode = '23514';
  end if;
  if not v_unknown and not v_zero_cost and p_total_tokens = 0 then
    raise exception 'billable-capable model outcome without trustworthy usage must remain unknown'
      using errcode = '23514';
  end if;
  if p_classification = 'success' then
    if p_actual_model is distinct from v_request.model_snapshot
      or jsonb_typeof(coalesce(p_normalized_result, 'null'::jsonb)) <> 'object'
      or p_normalized_result->>'schemaVersion' is distinct from v_request.response_schema_version
      or jsonb_typeof(p_normalized_result->'claims') <> 'array'
      or jsonb_array_length(p_normalized_result->'claims') < 1
      or jsonb_array_length(p_normalized_result->'claims') > 50
      or pg_column_size(p_normalized_result) > 1048576 then
      raise exception 'successful truth model outcome has invalid model or result payload'
        using errcode = '23514';
    end if;
    v_result_hash := encode(extensions.digest(
      convert_to(p_normalized_result::text, 'UTF8'), 'sha256'
    ), 'hex');
    if coalesce(p_normalized_result_hash, '') is distinct from v_result_hash then
      raise exception 'truth model normalized result hash is invalid' using errcode = '23514';
    end if;
  elsif p_normalized_result is not null or coalesce(p_normalized_result_hash, '') <> '' then
    raise exception 'non-success truth model outcome cannot persist a normalized result'
      using errcode = '23514';
  end if;
  if not v_unknown and not v_zero_cost
    and nullif(trim(coalesce(p_actual_model, '')), '') is null then
    raise exception 'billable truth model outcome lacks actual model identity'
      using errcode = '23514';
  end if;
  if not v_unknown and not v_zero_cost and p_classification <> 'model_mismatch'
    and p_actual_model is distinct from v_request.model_snapshot then
    raise exception 'truth model billed response model differs from pinned snapshot'
      using errcode = '23514';
  end if;
  if p_classification = 'success'
    and (nullif(trim(coalesce(p_provider_response_id, '')), '') is null
      or nullif(trim(coalesce(p_server_request_id, '')), '') is null) then
    raise exception 'successful truth model outcome lacks provider request identities'
      using errcode = '23514';
  end if;
  if not v_unknown then
    v_cost := private.truth_model_usage_cost(
      v_request.pricing_policy_id, p_input_tokens, p_cached_input_tokens, p_output_tokens
    );
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-model-sync-outcome-v1',
    'dispatchId', v_dispatch.dispatch_id,
    'clientRequestId', v_dispatch.client_request_id,
    'providerResultHash', p_provider_result_hash,
    'requestId', v_request.request_id,
    'attemptNumber', p_attempt_number,
    'classification', p_classification,
    'requestSent', p_request_sent,
    'httpStatus', p_http_status,
    'requestBodyHash', p_request_body_hash,
    'requestBodyBytes', p_request_body_bytes,
    'providerResponseBodyHash', coalesce(p_provider_response_body_hash, ''),
    'providerResponseBodyBytes', p_provider_response_body_bytes,
    'providerErrorCode', coalesce(p_provider_error_code, ''),
    'incompleteReason', coalesce(p_incomplete_reason, ''),
    'providerResponseId', coalesce(p_provider_response_id, ''),
    'serverRequestId', coalesce(p_server_request_id, ''),
    'actualModel', coalesce(p_actual_model, ''),
    'normalizedResultHash', v_result_hash,
    'inputTokens', p_input_tokens,
    'cachedInputTokens', p_cached_input_tokens,
    'outputTokens', p_output_tokens,
    'reasoningTokens', p_reasoning_tokens,
    'totalTokens', p_total_tokens,
    'actualMicroUsd', v_cost
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_existing from public.truth_model_sync_attempt_outcomes outcome
  where outcome.dispatch_id = v_dispatch.dispatch_id;
  if found then
    if v_existing.outcome_hash is distinct from v_hash then
      raise exception 'truth model attempt outcome conflicts with durable reconciliation'
        using errcode = '23505';
    end if;
    return private.truth_model_attempt_receipt(v_dispatch.dispatch_id, true, false);
  end if;
  if v_request.state <> 'in_flight' then
    raise exception 'truth model request is not awaiting this attempt outcome'
      using errcode = '55000';
  end if;
  if v_unknown and exists (
    select 1 from public.truth_model_sync_attempt_outcomes outcome
    where outcome.request_id = v_request.request_id
      and outcome.attempt_number > p_attempt_number
  ) then
    raise exception 'truth model unknown outcome is not the latest attempt'
      using errcode = '23514';
  end if;
  if not v_unknown and (
    p_input_tokens > v_request.remaining_reserved_input_tokens
    or p_output_tokens > v_request.remaining_reserved_output_tokens
    or v_cost > v_request.remaining_reserved_microusd
  ) then
    raise exception 'truth model actual usage exceeds remaining conservative reservation'
      using errcode = '23514';
  end if;
  v_id := 'model-outcome:v1:' || v_hash;
  insert into public.truth_model_sync_attempt_outcomes (
    outcome_id, dispatch_id, request_id, workspace_key, attempt_number,
    outcome_hash, provider_result_hash, classification,
    request_sent, http_status, request_body_hash, request_body_bytes,
    provider_response_body_hash, provider_response_body_bytes,
    provider_error_code, incomplete_reason, outcome_unknown, billing_outcome_unknown,
    provider_response_id, server_request_id,
    actual_model, normalized_result, normalized_result_hash,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    total_tokens, actual_microusd
  ) values (
    v_id, v_dispatch.dispatch_id, v_request.request_id, p_workspace_key,
    p_attempt_number, v_hash, p_provider_result_hash, p_classification,
    p_request_sent, p_http_status, p_request_body_hash, p_request_body_bytes,
    coalesce(p_provider_response_body_hash, ''), p_provider_response_body_bytes,
    coalesce(p_provider_error_code, ''), coalesce(p_incomplete_reason, ''),
    p_classification = 'outcome_unknown',
    p_classification = any (array['billing_unknown', 'model_mismatch']),
    coalesce(p_provider_response_id, ''), coalesce(p_server_request_id, ''),
    coalesce(p_actual_model, ''), p_normalized_result, v_result_hash,
    p_input_tokens, p_cached_input_tokens, p_output_tokens, p_reasoning_tokens,
    p_total_tokens, v_cost
  );
  if v_unknown then
    update public.truth_model_requests request
    set state = case when p_classification = 'model_mismatch'
          then 'review_required' else 'outcome_unknown' end,
        review_reason = upper(p_classification),
        finalized_at = case when p_classification = 'model_mismatch'
          then v_now else request.finalized_at end
    where request.request_id = v_request.request_id;
    return private.truth_model_attempt_receipt(v_dispatch.dispatch_id, false, false);
  end if;
  -- Convert only trustworthy actual usage from reserved to actual. The rest of
  -- the max-attempt reservation remains held across response-confirmed retries.
  update public.truth_model_workspace_accounts account
  set reserved_microusd = account.reserved_microusd - v_cost,
      actual_microusd = account.actual_microusd + v_cost,
      updated_at = v_now
  where account.workspace_key = p_workspace_key;
  update public.truth_model_workspace_daily_usage usage
  set reserved_input_tokens = usage.reserved_input_tokens - p_input_tokens,
      reserved_output_tokens = usage.reserved_output_tokens - p_output_tokens,
      actual_input_tokens = usage.actual_input_tokens + p_input_tokens,
      actual_cached_input_tokens = usage.actual_cached_input_tokens + p_cached_input_tokens,
      actual_output_tokens = usage.actual_output_tokens + p_output_tokens,
      actual_reasoning_tokens = usage.actual_reasoning_tokens + p_reasoning_tokens,
      actual_total_tokens = usage.actual_total_tokens + p_total_tokens,
      reserved_microusd = usage.reserved_microusd - v_cost,
      actual_microusd = usage.actual_microusd + v_cost,
      updated_at = v_now
  where usage.workspace_key = p_workspace_key
    and usage.usage_date = v_request.reservation_date;
  v_terminal := not v_retryable or p_attempt_number >= v_request.max_attempts;
  if v_terminal then
    if p_classification = 'success' then
      v_reason := '';
    elsif v_retryable then
      v_reason := 'MODEL_ATTEMPT_CAP_EXHAUSTED';
    else
      v_reason := upper(p_classification);
    end if;
    update public.truth_model_workspace_accounts account
    set reserved_microusd = account.reserved_microusd
          - (v_request.remaining_reserved_microusd - v_cost),
        updated_at = v_now
    where account.workspace_key = p_workspace_key;
    update public.truth_model_workspace_daily_usage usage
    set reserved_input_tokens = usage.reserved_input_tokens
          - (v_request.remaining_reserved_input_tokens - p_input_tokens),
        reserved_output_tokens = usage.reserved_output_tokens
          - (v_request.remaining_reserved_output_tokens - p_output_tokens),
        reserved_microusd = usage.reserved_microusd
          - (v_request.remaining_reserved_microusd - v_cost),
        updated_at = v_now
    where usage.workspace_key = p_workspace_key
      and usage.usage_date = v_request.reservation_date;
    update public.truth_model_requests request
    set state = case when p_classification = 'success'
          then 'succeeded' else 'review_required' end,
        remaining_reserved_input_tokens = 0,
        remaining_reserved_output_tokens = 0,
        remaining_reserved_microusd = 0,
        actual_input_tokens = request.actual_input_tokens + p_input_tokens,
        actual_cached_input_tokens = request.actual_cached_input_tokens + p_cached_input_tokens,
        actual_output_tokens = request.actual_output_tokens + p_output_tokens,
        actual_reasoning_tokens = request.actual_reasoning_tokens + p_reasoning_tokens,
        actual_total_tokens = request.actual_total_tokens + p_total_tokens,
        actual_microusd = request.actual_microusd + v_cost,
        review_reason = v_reason,
        finalized_at = v_now
    where request.request_id = v_request.request_id;
  else
    update public.truth_model_requests request
    set state = 'reserved',
        remaining_reserved_input_tokens = request.remaining_reserved_input_tokens - p_input_tokens,
        remaining_reserved_output_tokens = request.remaining_reserved_output_tokens - p_output_tokens,
        remaining_reserved_microusd = request.remaining_reserved_microusd - v_cost,
        actual_input_tokens = request.actual_input_tokens + p_input_tokens,
        actual_cached_input_tokens = request.actual_cached_input_tokens + p_cached_input_tokens,
        actual_output_tokens = request.actual_output_tokens + p_output_tokens,
        actual_reasoning_tokens = request.actual_reasoning_tokens + p_reasoning_tokens,
        actual_total_tokens = request.actual_total_tokens + p_total_tokens,
        actual_microusd = request.actual_microusd + v_cost
    where request.request_id = v_request.request_id;
  end if;
  return private.truth_model_attempt_receipt(v_dispatch.dispatch_id, false, false);
end;
$function$;

create or replace function public.reconcile_truth_model_sync_attempt(
  p_workspace_key text,
  p_request_id text,
  p_attempt_number integer,
  p_dispatch_id text,
  p_client_request_id text,
  p_provider_result_hash text,
  p_classification text,
  p_request_sent boolean,
  p_http_status integer,
  p_request_body_hash text,
  p_request_body_bytes integer,
  p_provider_response_body_hash text,
  p_provider_response_body_bytes integer,
  p_provider_error_code text,
  p_incomplete_reason text,
  p_provider_response_id text,
  p_server_request_id text,
  p_actual_model text,
  p_normalized_result jsonb,
  p_normalized_result_hash text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_output_tokens bigint,
  p_reasoning_tokens bigint,
  p_total_tokens bigint,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.reconcile_truth_model_sync_attempt(
    p_workspace_key, p_request_id, p_attempt_number,
    p_dispatch_id, p_client_request_id, p_provider_result_hash, p_classification,
    p_request_sent, p_http_status, p_request_body_hash, p_request_body_bytes,
    p_provider_response_body_hash, p_provider_response_body_bytes,
    p_provider_error_code, p_incomplete_reason,
    p_provider_response_id, p_server_request_id, p_actual_model,
    p_normalized_result, p_normalized_result_hash, p_input_tokens,
    p_cached_input_tokens, p_output_tokens, p_reasoning_tokens,
    p_total_tokens, p_sync_token
  );
$function$;

create or replace function private.read_truth_model_request(
  p_workspace_key text,
  p_request_id text,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.truth_model_requests request
    where request.request_id = p_request_id and request.workspace_key = p_workspace_key
  ) then
    raise exception 'truth model request is unavailable' using errcode = '23503';
  end if;
  return private.truth_model_request_receipt(p_request_id, true) || jsonb_build_object(
    'attempts', coalesce((
      select jsonb_agg(private.truth_model_attempt_receipt(
        dispatch.dispatch_id, true, false
      ) - 'request' order by dispatch.attempt_number)
      from public.truth_model_sync_attempt_dispatches dispatch
      where dispatch.request_id = p_request_id
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.read_truth_model_request(
  p_workspace_key text,
  p_request_id text,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_truth_model_request(
    p_workspace_key, p_request_id, p_sync_token
  );
$function$;

alter table public.truth_model_pricing_policies enable row level security;
alter table public.truth_model_pricing_policies force row level security;
alter table public.truth_model_workspace_accounts enable row level security;
alter table public.truth_model_workspace_accounts force row level security;
alter table public.truth_model_account_configuration_requests enable row level security;
alter table public.truth_model_account_configuration_requests force row level security;
alter table public.truth_model_workspace_daily_usage enable row level security;
alter table public.truth_model_workspace_daily_usage force row level security;
alter table public.truth_model_requests enable row level security;
alter table public.truth_model_requests force row level security;
alter table public.truth_model_sync_attempt_dispatches enable row level security;
alter table public.truth_model_sync_attempt_dispatches force row level security;
alter table public.truth_model_sync_attempt_outcomes enable row level security;
alter table public.truth_model_sync_attempt_outcomes force row level security;

revoke all on table public.truth_model_pricing_policies
  from public, anon, authenticated, service_role;
revoke all on table public.truth_model_workspace_accounts
  from public, anon, authenticated, service_role;
revoke all on table public.truth_model_account_configuration_requests
  from public, anon, authenticated, service_role;
revoke all on table public.truth_model_workspace_daily_usage
  from public, anon, authenticated, service_role;
revoke all on table public.truth_model_requests
  from public, anon, authenticated, service_role;
revoke all on table public.truth_model_sync_attempt_dispatches
  from public, anon, authenticated, service_role;
revoke all on table public.truth_model_sync_attempt_outcomes
  from public, anon, authenticated, service_role;

revoke all on function private.valid_truth_model_account_issuer_token(text)
  from public, anon, authenticated, service_role;
revoke all on function private.require_live_truth_model_source_job(text, uuid, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_model_usage_cost(text, bigint, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_model_request_receipt(text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.truth_model_attempt_receipt(text, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_truth_model_account_update()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_truth_model_daily_usage_update()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_truth_model_request_update()
  from public, anon, authenticated, service_role;
revoke all on function private.configure_truth_model_account(
  text, text, text, bigint, bigint, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.create_truth_model_request(
  text, text, uuid, text, text, text, jsonb, text, text, text, text, text, text,
  text, text, text, integer, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.reserve_truth_model_request(
  text, text, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.begin_truth_model_sync_attempt(
  text, text, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
) from public, anon, authenticated, service_role;
revoke all on function private.read_truth_model_request(text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function public.configure_truth_model_account(
  text, text, text, bigint, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.create_truth_model_request(
  text, text, uuid, text, text, text, jsonb, text, text, text, text, text, text,
  text, text, text, integer, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.reserve_truth_model_request(
  text, text, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.begin_truth_model_sync_attempt(
  text, text, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
) from public, anon, authenticated;
revoke all on function public.read_truth_model_request(text, text, text)
  from public, anon, authenticated;

grant execute on function public.configure_truth_model_account(
  text, text, text, bigint, bigint, text, text, text
) to service_role;
grant execute on function public.create_truth_model_request(
  text, text, uuid, text, text, text, jsonb, text, text, text, text, text, text,
  text, text, text, integer, text, bigint, text, text
) to service_role;
grant execute on function public.reserve_truth_model_request(
  text, text, text, bigint, text, text
) to service_role;
grant execute on function public.begin_truth_model_sync_attempt(
  text, text, text, bigint, text, text
) to service_role;
grant execute on function public.reconcile_truth_model_sync_attempt(
  text, text, integer, text, text, text, text, boolean, integer, text, integer, text, integer,
  text, text, text, text, text, jsonb, text,
  bigint, bigint, bigint, bigint, bigint, text
) to service_role;
grant execute on function public.read_truth_model_request(text, text, text)
  to service_role;

set check_function_bodies = on;

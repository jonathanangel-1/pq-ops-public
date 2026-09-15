-- Crash recovery for a model dispatch whose external effect cannot be known.
--
-- A dispatch is authorized under one exact source-job lease fence. If that
-- fence is later replaced before an attempt outcome is durably reconciled, the
-- replacement worker may quarantine the dispatch. Quarantine is deliberately
-- not a provider outcome: it records neither requestSent nor a provider result,
-- keeps the complete conservative reservation held, and permanently prevents
-- another send for the logical request.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
set check_function_bodies = off;

drop function if exists public.quarantine_truth_model_sync_dispatch(
  text, text, text, text, text, text, bigint, text, text
);
drop function if exists private.quarantine_truth_model_sync_dispatch(
  text, text, text, text, text, text, bigint, text, text
);
drop function if exists public.find_truth_model_request_for_source_job(
  text, uuid, text, text, text, text, bigint, text, text
);
drop function if exists private.find_truth_model_request_for_source_job(
  text, uuid, text, text, text, text, bigint, text, text
);
drop function if exists public.read_truth_model_dispatch_recovery_status(
  text, uuid, text
);
drop function if exists private.read_truth_model_dispatch_recovery_status(
  text, uuid, text
);

alter table public.truth_model_sync_attempt_dispatches
  add column if not exists authorization_worker_id text,
  add column if not exists authorization_lease_fence bigint,
  add column if not exists authorization_processor_version text,
  add column if not exists authorization_lease_expires_at timestamptz;

alter table public.truth_model_sync_attempt_dispatches
  drop constraint if exists truth_model_dispatch_authorization_shape;
alter table public.truth_model_sync_attempt_dispatches
  add constraint truth_model_dispatch_authorization_shape check (
    (
      authorization_worker_id is null
      and authorization_lease_fence is null
      and authorization_processor_version is null
      and authorization_lease_expires_at is null
    ) or (
      nullif(trim(authorization_worker_id), '') is not null
      and authorization_lease_fence > 0
      and nullif(trim(authorization_processor_version), '') is not null
      and authorization_lease_expires_at is not null
    )
  );

create table if not exists public.truth_model_sync_dispatch_recoveries (
  recovery_id text primary key
    check (recovery_id ~ '^model-dispatch-recovery:v1:[0-9a-f]{64}$'),
  recovery_key text not null check (
    nullif(trim(recovery_key), '') is not null
    and octet_length(recovery_key) <= 500
  ),
  recovery_hash text not null unique check (recovery_hash ~ '^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict,
  request_id text not null,
  dispatch_id text not null unique,
  attempt_number integer not null check (attempt_number between 1 and 3),
  source_job_id uuid not null,
  recovery_reason text not null check (
    recovery_reason = 'STALE_DISPATCH_UNRECONCILED_AFTER_LEASE_REPLACEMENT'
  ),
  external_effect_state text not null default 'unknown_possible_post'
    check (external_effect_state = 'unknown_possible_post'),
  reservation_disposition text not null default 'held_conservatively'
    check (reservation_disposition = 'held_conservatively'),
  review_disposition text not null default 'non_resolvable_external_effect_uncertainty'
    check (review_disposition = 'non_resolvable_external_effect_uncertainty'),
  authorization_worker_id text,
  authorization_lease_fence bigint,
  authorization_processor_version text,
  authorization_lease_expires_at timestamptz,
  recovering_worker_id text not null check (nullif(trim(recovering_worker_id), '') is not null),
  recovering_lease_fence bigint not null check (recovering_lease_fence > 0),
  recovering_processor_version text not null
    check (nullif(trim(recovering_processor_version), '') is not null),
  held_reserved_input_tokens bigint not null check (held_reserved_input_tokens >= 0),
  held_reserved_output_tokens bigint not null check (held_reserved_output_tokens >= 0),
  held_reserved_microusd bigint not null check (held_reserved_microusd >= 0),
  dispatch_authorized_at timestamptz not null,
  recovered_at timestamptz not null default clock_timestamp(),
  unique (workspace_key, recovery_key),
  foreign key (dispatch_id, request_id, workspace_key, attempt_number)
    references public.truth_model_sync_attempt_dispatches(
      dispatch_id, request_id, workspace_key, attempt_number
    ) on update restrict on delete restrict,
  foreign key (request_id, workspace_key)
    references public.truth_model_requests(request_id, workspace_key)
    on update restrict on delete restrict,
  foreign key (source_job_id, workspace_key)
    references public.source_processing_jobs(job_id, workspace_key)
    on update restrict on delete restrict,
  check (
    (
      authorization_worker_id is null
      and authorization_lease_fence is null
      and authorization_processor_version is null
      and authorization_lease_expires_at is null
    ) or (
      nullif(trim(authorization_worker_id), '') is not null
      and authorization_lease_fence > 0
      and nullif(trim(authorization_processor_version), '') is not null
      and authorization_lease_expires_at is not null
    )
  )
);

create index if not exists truth_model_dispatch_recovery_request_idx
  on public.truth_model_sync_dispatch_recoveries(
    workspace_key, request_id, recovered_at, recovery_id
  );

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
    'dispatchHash', dispatch.dispatch_hash,
    'dispatchedAt', dispatch.dispatched_at,
    'authorizationWorkerId', dispatch.authorization_worker_id,
    'authorizationLeaseFence', dispatch.authorization_lease_fence,
    'authorizationProcessorVersion', dispatch.authorization_processor_version,
    'authorizationLeaseExpiresAt', dispatch.authorization_lease_expires_at,
    'outcomeHash', outcome.outcome_hash,
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
    'actualMicroUsd', outcome.actual_microusd
  )) || jsonb_strip_nulls(jsonb_build_object(
    'quarantined', recovery.recovery_id is not null,
    'recoveryId', recovery.recovery_id,
    'recoveryKey', recovery.recovery_key,
    'recoveryHash', recovery.recovery_hash,
    'recoveryReason', recovery.recovery_reason,
    'externalEffectState', recovery.external_effect_state,
    'reservationDisposition', recovery.reservation_disposition,
    'reviewDisposition', recovery.review_disposition,
    'heldReservedInputTokens', recovery.held_reserved_input_tokens,
    'heldReservedOutputTokens', recovery.held_reserved_output_tokens,
    'heldReservedMicroUsd', recovery.held_reserved_microusd,
    'recoveredAt', recovery.recovered_at,
    'request', private.truth_model_request_receipt(dispatch.request_id, p_idempotent)
  )) || case when recovery.recovery_id is null then '{}'::jsonb else jsonb_build_object(
    'recovery', jsonb_build_object(
      'ok', true,
      'idempotent', p_idempotent,
      'sendAuthorized', false,
      'quarantined', true,
      'schemaVersion', 'truth-model-dispatch-recovery-v1',
      'recoveryId', recovery.recovery_id,
      'recoveryKey', recovery.recovery_key,
      'recoveryHash', recovery.recovery_hash,
      'workspaceKey', recovery.workspace_key,
      'requestId', recovery.request_id,
      'dispatchId', recovery.dispatch_id,
      'attemptNumber', recovery.attempt_number,
      'sourceJobId', recovery.source_job_id,
      'recoveryReason', recovery.recovery_reason,
      'reviewReason', 'MODEL_DISPATCH_OUTCOME_UNKNOWN_QUARANTINED',
      'externalEffectState', recovery.external_effect_state,
      'reservationDisposition', recovery.reservation_disposition,
      'reviewDisposition', recovery.review_disposition,
      'authorizationWorkerId', recovery.authorization_worker_id,
      'authorizationLeaseFence', recovery.authorization_lease_fence,
      'authorizationProcessorVersion', recovery.authorization_processor_version,
      'authorizationLeaseExpiresAt', recovery.authorization_lease_expires_at,
      'recoveringWorkerId', recovery.recovering_worker_id,
      'recoveringLeaseFence', recovery.recovering_lease_fence,
      'recoveringProcessorVersion', recovery.recovering_processor_version,
      'heldReservedInputTokens', recovery.held_reserved_input_tokens,
      'heldReservedOutputTokens', recovery.held_reserved_output_tokens,
      'heldReservedMicroUsd', recovery.held_reserved_microusd,
      'dispatchAuthorizedAt', recovery.dispatch_authorized_at,
      'recoveredAt', recovery.recovered_at,
      'request', private.truth_model_request_receipt(recovery.request_id, p_idempotent)
    )
  ) end || case when outcome.normalized_result is null then '{}'::jsonb
    else jsonb_build_object('normalizedResult', outcome.normalized_result) end
  from public.truth_model_sync_attempt_dispatches dispatch
  left join public.truth_model_sync_attempt_outcomes outcome
    on outcome.dispatch_id = dispatch.dispatch_id
  left join public.truth_model_sync_dispatch_recoveries recovery
    on recovery.dispatch_id = dispatch.dispatch_id
  where dispatch.dispatch_id = p_dispatch_id;
$function$;

-- Replace begin so every new DB send authorization records the exact source-job
-- fence that made the dispatch eligible. Existing pre-migration dispatches
-- retain null authorization fields and can still be conservatively recovered.
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
  v_authorizing_job public.source_processing_jobs%rowtype;
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
  v_authorizing_job := private.require_live_truth_model_source_job(
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
  -- recovered_at is immutable audit metadata, not recovery identity. The RPC
  -- recomputes identity before its durable-row replay check, so including the
  -- new call's wall clock would make an exact replay conflict with itself.
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
    client_request_id, dispatch_hash,
    authorization_worker_id, authorization_lease_fence,
    authorization_processor_version, authorization_lease_expires_at
  ) values (
    v_id, v_request.request_id, p_workspace_key, v_attempt_number,
    v_client_request_id, v_hash,
    v_authorizing_job.lease_owner, v_authorizing_job.lease_fence,
    v_authorizing_job.processor_version, v_authorizing_job.lease_expires_at
  ) returning * into v_dispatch;
  update public.truth_model_requests request set state = 'in_flight'
  where request.request_id = v_request.request_id;
  return private.truth_model_attempt_receipt(v_dispatch.dispatch_id, false, true);
end;
$function$;

create or replace function private.truth_model_dispatch_recovery_receipt(
  p_recovery_id text,
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
    'sendAuthorized', false,
    'quarantined', true,
    'schemaVersion', 'truth-model-dispatch-recovery-v1',
    'recoveryId', recovery.recovery_id,
    'recoveryKey', recovery.recovery_key,
    'recoveryHash', recovery.recovery_hash,
    'workspaceKey', recovery.workspace_key,
    'requestId', recovery.request_id,
    'dispatchId', recovery.dispatch_id,
    'attemptNumber', recovery.attempt_number,
    'sourceJobId', recovery.source_job_id,
    'recoveryReason', recovery.recovery_reason,
    'reviewReason', 'MODEL_DISPATCH_OUTCOME_UNKNOWN_QUARANTINED',
    'externalEffectState', recovery.external_effect_state,
    'reservationDisposition', recovery.reservation_disposition,
    'reviewDisposition', recovery.review_disposition,
    'authorizationWorkerId', recovery.authorization_worker_id,
    'authorizationLeaseFence', recovery.authorization_lease_fence,
    'authorizationProcessorVersion', recovery.authorization_processor_version,
    'authorizationLeaseExpiresAt', recovery.authorization_lease_expires_at,
    'recoveringWorkerId', recovery.recovering_worker_id,
    'recoveringLeaseFence', recovery.recovering_lease_fence,
    'recoveringProcessorVersion', recovery.recovering_processor_version,
    'heldReservedInputTokens', recovery.held_reserved_input_tokens,
    'heldReservedOutputTokens', recovery.held_reserved_output_tokens,
    'heldReservedMicroUsd', recovery.held_reserved_microusd,
    'dispatchAuthorizedAt', recovery.dispatch_authorized_at,
    'recoveredAt', recovery.recovered_at,
    'request', private.truth_model_request_receipt(recovery.request_id, p_idempotent)
  )
  from public.truth_model_sync_dispatch_recoveries recovery
  where recovery.recovery_id = p_recovery_id;
$function$;

create or replace function private.quarantine_truth_model_sync_dispatch(
  p_workspace_key text,
  p_request_id text,
  p_dispatch_id text,
  p_recovery_key text,
  p_recovery_reason text,
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
  v_request public.truth_model_requests%rowtype;
  v_dispatch public.truth_model_sync_attempt_dispatches%rowtype;
  v_current_job public.source_processing_jobs%rowtype;
  v_existing public.truth_model_sync_dispatch_recoveries%rowtype;
  v_hash text;
  v_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if coalesce(p_request_id, '') !~ '^model-request:v1:[0-9a-f]{64}$'
    or coalesce(p_dispatch_id, '') !~ '^model-dispatch:v1:[0-9a-f]{64}$'
    or nullif(trim(coalesce(p_recovery_key, '')), '') is null
    or octet_length(p_recovery_key) > 500
    or p_recovery_reason is distinct from
      'STALE_DISPATCH_UNRECONCILED_AFTER_LEASE_REPLACEMENT'
    or nullif(trim(coalesce(p_worker_id, '')), '') is null
    or p_lease_fence is null or p_lease_fence <= 0
    or nullif(trim(coalesce(p_processor_version, '')), '') is null then
    raise exception 'truth model dispatch recovery request is invalid'
      using errcode = '22023';
  end if;
  select * into v_request from public.truth_model_requests request
  where request.request_id = p_request_id
    and request.workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'truth model request is unavailable' using errcode = '23503';
  end if;
  select * into v_dispatch from public.truth_model_sync_attempt_dispatches dispatch
  where dispatch.dispatch_id = p_dispatch_id
    and dispatch.request_id = v_request.request_id
    and dispatch.workspace_key = p_workspace_key;
  if not found then
    raise exception 'truth model attempt dispatch is unavailable' using errcode = '23503';
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'schemaVersion', 'truth-model-dispatch-recovery-v1',
    'workspaceKey', p_workspace_key,
    'requestId', v_request.request_id,
    'dispatchId', v_dispatch.dispatch_id,
    'attemptNumber', v_dispatch.attempt_number,
    'sourceJobId', v_request.source_job_id,
    'recoveryKey', p_recovery_key,
    'recoveryReason', p_recovery_reason,
    'externalEffectState', 'unknown_possible_post',
    'reservationDisposition', 'held_conservatively',
    'reviewDisposition', 'non_resolvable_external_effect_uncertainty',
    'authorizationWorkerId', v_dispatch.authorization_worker_id,
    'authorizationLeaseFence', v_dispatch.authorization_lease_fence,
    'authorizationProcessorVersion', v_dispatch.authorization_processor_version,
    'authorizationLeaseExpiresAt', v_dispatch.authorization_lease_expires_at,
    'recoveringWorkerId', p_worker_id,
    'recoveringLeaseFence', p_lease_fence,
    'recoveringProcessorVersion', p_processor_version,
    'heldReservedInputTokens', v_request.remaining_reserved_input_tokens,
    'heldReservedOutputTokens', v_request.remaining_reserved_output_tokens,
    'heldReservedMicroUsd', v_request.remaining_reserved_microusd,
    'dispatchAuthorizedAt', v_dispatch.dispatched_at
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_id := 'model-dispatch-recovery:v1:' || v_hash;

  select * into v_existing
  from public.truth_model_sync_dispatch_recoveries recovery
  where recovery.dispatch_id = v_dispatch.dispatch_id;
  if found then
    if v_existing.recovery_hash is distinct from v_hash then
      raise exception 'truth model dispatch recovery conflicts with durable quarantine'
        using errcode = '23505';
    end if;
    return private.truth_model_dispatch_recovery_receipt(v_existing.recovery_id, true);
  end if;
  select * into v_existing
  from public.truth_model_sync_dispatch_recoveries recovery
  where recovery.workspace_key = p_workspace_key
    and recovery.recovery_key = p_recovery_key;
  if found then
    raise exception 'truth model dispatch recovery key conflicts'
      using errcode = '23505';
  end if;

  v_current_job := private.require_live_truth_model_source_job(
    p_workspace_key, v_request.source_job_id, p_worker_id,
    p_lease_fence, p_processor_version
  );
  if v_request.state <> 'in_flight' then
    raise exception 'truth model request is not awaiting dispatch recovery'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.truth_model_sync_attempt_outcomes outcome
    where outcome.dispatch_id = v_dispatch.dispatch_id
  ) then
    raise exception 'truth model dispatch already has a durable provider outcome'
      using errcode = '55000';
  end if;
  if v_dispatch.authorization_lease_fence is not null
    and v_dispatch.authorization_worker_id is not distinct from v_current_job.lease_owner
    and v_dispatch.authorization_lease_fence is not distinct from v_current_job.lease_fence
    and v_dispatch.authorization_processor_version
      is not distinct from v_current_job.processor_version then
    raise exception 'truth model dispatch authorization is still current, not stale'
      using errcode = '55000';
  end if;

  insert into public.truth_model_sync_dispatch_recoveries (
    recovery_id, recovery_key, recovery_hash, workspace_key,
    request_id, dispatch_id, attempt_number, source_job_id,
    recovery_reason, external_effect_state, reservation_disposition,
    review_disposition, authorization_worker_id, authorization_lease_fence,
    authorization_processor_version, authorization_lease_expires_at,
    recovering_worker_id, recovering_lease_fence,
    recovering_processor_version, held_reserved_input_tokens,
    held_reserved_output_tokens, held_reserved_microusd,
    dispatch_authorized_at, recovered_at
  ) values (
    v_id, p_recovery_key, v_hash, p_workspace_key,
    v_request.request_id, v_dispatch.dispatch_id, v_dispatch.attempt_number,
    v_request.source_job_id, p_recovery_reason, 'unknown_possible_post',
    'held_conservatively', 'non_resolvable_external_effect_uncertainty',
    v_dispatch.authorization_worker_id, v_dispatch.authorization_lease_fence,
    v_dispatch.authorization_processor_version, v_dispatch.authorization_lease_expires_at,
    p_worker_id, p_lease_fence, p_processor_version,
    v_request.remaining_reserved_input_tokens,
    v_request.remaining_reserved_output_tokens,
    v_request.remaining_reserved_microusd, v_dispatch.dispatched_at, v_now
  );
  update public.truth_model_requests request
  set state = 'outcome_unknown',
      review_reason = 'MODEL_DISPATCH_OUTCOME_UNKNOWN_QUARANTINED',
      finalized_at = v_now
  where request.request_id = v_request.request_id;
  return private.truth_model_dispatch_recovery_receipt(v_id, false);
end;
$function$;

create or replace function public.quarantine_truth_model_sync_dispatch(
  p_workspace_key text,
  p_request_id text,
  p_dispatch_id text,
  p_recovery_key text,
  p_recovery_reason text,
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
  select private.quarantine_truth_model_sync_dispatch(
    p_workspace_key, p_request_id, p_dispatch_id,
    p_recovery_key, p_recovery_reason, p_worker_id,
    p_lease_fence, p_processor_version, p_sync_token
  );
$function$;

-- A worker must discover a durable request from the source-job authority, not
-- from a caller-selected request id. This lookup is deliberately fenced even
-- for a terminal request: the live model child proves the caller owns the exact
-- observation and sealed plan before any paid terminal receipt is replayed.
create or replace function private.find_truth_model_request_for_source_job(
  p_workspace_key text,
  p_source_job_id uuid,
  p_observation_id text,
  p_observation_content_hash text,
  p_plan_hash text,
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
  v_plan public.gmail_model_extraction_plans%rowtype;
  v_request public.truth_model_requests%rowtype;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if p_source_job_id is null
    or coalesce(p_observation_id, '') !~ '^obs:v1:[0-9a-f]{64}$'
    or coalesce(p_observation_content_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_plan_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'truth model source-job request lookup binding is invalid'
      using errcode = '22023';
  end if;

  v_job := private.require_live_truth_model_source_job(
    p_workspace_key, p_source_job_id, p_worker_id,
    p_lease_fence, p_processor_version
  );
  select plan.* into v_plan
  from public.source_processing_job_lineage lineage
  join public.gmail_model_extraction_plans plan
    on plan.workspace_key = lineage.workspace_key
   and plan.parent_job_id = lineage.parent_job_id
  join public.gmail_model_extraction_context_seals context_seal
    on context_seal.workspace_key = plan.workspace_key
   and context_seal.context_seal_id = plan.context_seal_id
   and context_seal.parent_job_id = plan.parent_job_id
   and context_seal.source_observation_id = plan.source_observation_id
   and context_seal.source_observation_content_hash = plan.source_observation_content_hash
  join public.source_observations observation
    on observation.workspace_key = plan.workspace_key
   and observation.observation_id = plan.source_observation_id
   and observation.content_hash = plan.source_observation_content_hash
  where lineage.workspace_key = p_workspace_key
    and lineage.job_id = p_source_job_id
    and v_job.payload->>'schemaVersion' = 'gmail-model-claims-job-v1'
    and v_job.payload->>'batchId' = lineage.root_batch_id::text
    and v_job.payload->>'rootBatchId' = lineage.root_batch_id::text
    and v_job.payload->>'rootJobId' = lineage.root_job_id::text
    and v_job.payload->>'parentJobId' = lineage.parent_job_id::text
    and plan.model_plan_id = v_job.payload->>'modelPlanId'
    and plan.context_seal_id = v_job.payload->>'contextSealId';
  if not found
    or v_job.source_system is distinct from 'gmail'
    or v_job.job_kind is distinct from 'gmail_extract_message_model_claims'
    or v_job.observation_id is distinct from p_observation_id
    or v_job.payload->>'parentJobId' is distinct from v_plan.parent_job_id::text
    or v_job.payload->>'modelPlanId' is distinct from 'gmail-model-plan:v1:' || p_plan_hash
    or v_plan.model_plan_hash is distinct from p_plan_hash
    or v_plan.source_observation_id is distinct from p_observation_id
    or v_plan.source_observation_content_hash is distinct from p_observation_content_hash
    or v_plan.planning_status is distinct from 'complete'
    or v_plan.execution_mode not in ('sync', 'batch', 'parked') then
    raise exception 'truth model source-job request lookup differs from sealed plan authority'
      using errcode = '23514';
  end if;

  select request.* into v_request
  from public.truth_model_requests request
  where request.workspace_key = p_workspace_key
    and request.source_job_id = p_source_job_id;
  if not found then
    return jsonb_build_object('ok', true, 'found', false, 'request', null);
  end if;
  if v_plan.execution_mode = 'parked' then
    raise exception 'parked Gmail model plan cannot have a durable model request'
      using errcode = '23514';
  end if;
  if v_request.observation_id is distinct from p_observation_id
    or v_request.observation_content_hash is distinct from p_observation_content_hash
    or v_request.plan_hash is distinct from p_plan_hash
    or v_request.request_payload is distinct from v_plan.expected_request_payload
    or v_request.request_payload_text is distinct from v_plan.expected_request_payload_text
    or v_request.request_payload_hash is distinct from v_plan.expected_request_payload_hash
    or v_request.request_payload_bytes is distinct from v_plan.expected_request_payload_bytes
    or v_request.model_snapshot is distinct from v_plan.expected_model_snapshot
    or v_request.prompt_version is distinct from v_plan.prompt_version
    or v_request.response_schema_version is distinct from v_plan.response_schema_version
    or v_request.response_schema_hash is distinct from v_plan.expected_response_schema_hash
    or v_request.transport is distinct from v_plan.execution_mode
    or v_request.max_output_tokens is distinct from v_plan.expected_max_output_tokens then
    raise exception 'durable truth model request differs from source-job lookup binding'
      using errcode = '23514';
  end if;
  return jsonb_build_object(
    'ok', true,
    'found', true,
    'request', private.read_truth_model_request(
      p_workspace_key, v_request.request_id, p_sync_token
    )
  );
end;
$function$;

create or replace function public.find_truth_model_request_for_source_job(
  p_workspace_key text,
  p_source_job_id uuid,
  p_observation_id text,
  p_observation_content_hash text,
  p_plan_hash text,
  p_worker_id text,
  p_lease_fence bigint,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select private.find_truth_model_request_for_source_job(
    p_workspace_key, p_source_job_id, p_observation_id,
    p_observation_content_hash, p_plan_hash, p_worker_id,
    p_lease_fence, p_processor_version, p_sync_token
  );
$function$;

-- Operational claim review and provider-account uncertainty are independent
-- authorities. This bounded read exposes at most one immutable quarantine for
-- one model child, including whether its operational review has separately
-- closed. It does not settle, release, or mutate the conservative spend hold.
create or replace function private.read_truth_model_dispatch_recovery_status(
  p_workspace_key text,
  p_source_job_id uuid,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_request public.truth_model_requests%rowtype;
  v_recovery public.truth_model_sync_dispatch_recoveries%rowtype;
  v_obligation_id text;
  v_resolution_id text;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  perform private.require_active_truth_workspace(p_workspace_key);
  if p_source_job_id is null or not exists (
    select 1 from public.source_processing_jobs job
    where job.workspace_key = p_workspace_key
      and job.job_id = p_source_job_id
      and job.source_system = 'gmail'
      and job.job_kind = 'gmail_extract_message_model_claims'
  ) then
    raise exception 'truth model recovery source job is unavailable or wrong-kind'
      using errcode = '23503';
  end if;

  select request.* into v_request
  from public.truth_model_requests request
  where request.workspace_key = p_workspace_key
    and request.source_job_id = p_source_job_id
    and exists (
      select 1 from public.truth_model_sync_dispatch_recoveries recovery
      where recovery.workspace_key = request.workspace_key
        and recovery.request_id = request.request_id
    );
  if not found then
    return jsonb_build_object(
      'ok', true,
      'found', false,
      'schemaVersion', 'truth-model-dispatch-recovery-status-v1',
      'workspaceKey', p_workspace_key,
      'sourceJobId', p_source_job_id,
      'externalEffectResolutionStatus', 'not_recorded',
      'operationalReviewResolved', false,
      'operationalReviewObligationId', '',
      'operationalReviewResolutionId', '',
      'recovery', null,
      'mutatesOperationalState', false
    );
  end if;
  select recovery.* into strict v_recovery
  from public.truth_model_sync_dispatch_recoveries recovery
  where recovery.workspace_key = v_request.workspace_key
    and recovery.request_id = v_request.request_id;
  if v_request.state is distinct from 'outcome_unknown'
    or v_request.review_reason is distinct from 'MODEL_DISPATCH_OUTCOME_UNKNOWN_QUARANTINED'
    or v_request.remaining_reserved_input_tokens
      is distinct from v_recovery.held_reserved_input_tokens
    or v_request.remaining_reserved_output_tokens
      is distinct from v_recovery.held_reserved_output_tokens
    or v_request.remaining_reserved_microusd
      is distinct from v_recovery.held_reserved_microusd
    or exists (
      select 1 from public.truth_model_sync_attempt_outcomes outcome
      where outcome.dispatch_id = v_recovery.dispatch_id
    ) then
    raise exception 'truth model recovery status differs from immutable quarantine authority'
      using errcode = '23514';
  end if;
  select obligation.obligation_id, resolution.resolution_id
    into v_obligation_id, v_resolution_id
  from public.gmail_model_extraction_review_obligations obligation
  left join public.gmail_model_extraction_review_resolutions resolution
    on resolution.workspace_key = obligation.workspace_key
   and resolution.obligation_id = obligation.obligation_id
  where obligation.workspace_key = p_workspace_key
    and obligation.model_child_job_id = p_source_job_id;

  return jsonb_build_object(
    'ok', true,
    'found', true,
    'schemaVersion', 'truth-model-dispatch-recovery-status-v1',
    'workspaceKey', p_workspace_key,
    'sourceJobId', p_source_job_id,
    'externalEffectResolutionStatus', 'unresolved',
    'operationalReviewResolved', v_resolution_id is not null,
    'operationalReviewObligationId', coalesce(v_obligation_id, ''),
    'operationalReviewResolutionId', coalesce(v_resolution_id, ''),
    'recovery', private.truth_model_dispatch_recovery_receipt(
      v_recovery.recovery_id, true
    ),
    'mutatesOperationalState', false
  );
end;
$function$;

create or replace function public.read_truth_model_dispatch_recovery_status(
  p_workspace_key text,
  p_source_job_id uuid,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_truth_model_dispatch_recovery_status(
    p_workspace_key, p_source_job_id, p_sync_token
  );
$function$;

create or replace function private.guard_truth_model_external_uncertainty()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if old.state = 'outcome_unknown' then
    raise exception 'truth model external-effect uncertainty is terminal and immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists truth_model_dispatch_recovery_immutable
  on public.truth_model_sync_dispatch_recoveries;
create trigger truth_model_dispatch_recovery_immutable before update or delete
on public.truth_model_sync_dispatch_recoveries for each row
execute function public.reject_immutable_truth_mutation();

drop trigger if exists truth_model_external_uncertainty_guard
  on public.truth_model_requests;
create trigger truth_model_external_uncertainty_guard before update or delete
on public.truth_model_requests for each row
execute function private.guard_truth_model_external_uncertainty();

-- Remove the prior over-broad guard on reapplication. Operational review may
-- close; the request terminal state, immutable recovery, conservative hold,
-- and recovery-status authority preserve provider-account uncertainty.
do $block$
begin
  if to_regclass('public.gmail_model_extraction_review_resolutions') is not null then
    drop trigger if exists gmail_model_review_external_uncertainty_guard
      on public.gmail_model_extraction_review_resolutions;
  end if;
end;
$block$;
drop function if exists private.guard_gmail_model_review_external_uncertainty();

alter table public.truth_model_sync_dispatch_recoveries enable row level security;
alter table public.truth_model_sync_dispatch_recoveries force row level security;

revoke all on table public.truth_model_sync_dispatch_recoveries
  from public, anon, authenticated, service_role;

revoke all on function private.truth_model_dispatch_recovery_receipt(text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.quarantine_truth_model_sync_dispatch(
  text, text, text, text, text, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.guard_truth_model_external_uncertainty()
  from public, anon, authenticated, service_role;
revoke all on function private.find_truth_model_request_for_source_job(
  text, uuid, text, text, text, text, bigint, text, text
) from public, anon, authenticated, service_role;
revoke all on function private.read_truth_model_dispatch_recovery_status(
  text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.quarantine_truth_model_sync_dispatch(
  text, text, text, text, text, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.find_truth_model_request_for_source_job(
  text, uuid, text, text, text, text, bigint, text, text
) from public, anon, authenticated;
revoke all on function public.read_truth_model_dispatch_recovery_status(
  text, uuid, text
) from public, anon, authenticated;

grant execute on function public.quarantine_truth_model_sync_dispatch(
  text, text, text, text, text, text, bigint, text, text
) to service_role;
grant execute on function public.find_truth_model_request_for_source_job(
  text, uuid, text, text, text, text, bigint, text, text
) to service_role;
grant execute on function public.read_truth_model_dispatch_recovery_status(
  text, uuid, text
) to service_role;

set check_function_bodies = on;

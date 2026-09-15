-- Version the primary Gmail message-model prompt so a POD promise remains
-- neutral/planned, then mint one append-only successor for each exact schema-v3
-- model_output_validation_failed review. No model call, candidate acceptance,
-- cut, build, publication, email, or freight mutation occurs here.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_wire text;
begin
  if to_regprocedure(
      'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'
    ) is null
    or to_regprocedure('private.gmail_model_response_schema_text_v1()') is null
    or to_regprocedure(
      'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v7(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regclass('public.truth_gmail_model_temperature_retry_authorizations') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'Gmail POD-promise prompt recovery prerequisites are unavailable'
      using errcode='55000';
  end if;
  if (to_regprocedure('private.truth_gmail_parent_allowed_pre_pod_v1(text,uuid)') is null)
      is distinct from
      (to_regprocedure('private.truth_gmail_parent_worker_pre_pod_v1(text,uuid,text,text)') is null)
    or (to_regprocedure('private.truth_gmail_parent_allowed_pre_pod_v1(text,uuid)') is null)
      is distinct from
      (to_regprocedure('private.truth_gmail_child_input_pre_pod_v1(text,text,uuid,text,text,jsonb)') is null) then
    raise exception 'Gmail POD-promise predecessor aliases are partial'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure
  ) into v_wire;
  if not ((position('gmail-claim-extraction-prompt-v3' in v_wire)>0
      and position('gmail-model-candidate-claims-v3' in v_wire)>0
      and position('gmail_model_candidate_claims_v3' in v_wire)>0
      and position('POD promise or future such as will send POD' in v_wire)=0)
    or (position('gmail-claim-extraction-prompt-v4' in v_wire)>0
      and position('gmail-model-candidate-claims-v4' in v_wire)>0
      and position('gmail_model_candidate_claims_v4' in v_wire)>0
      and position('POD promise or future such as will send POD' in v_wire)>0)) then
    raise exception 'Gmail model wire differs from reviewed prompt-v3/v4 contract'
      using errcode='23514';
  end if;
end;
$preflight$;

do $install_prompt_v4$
declare v_proc regprocedure; v_definition text; v_updated text;
begin
  foreach v_proc in array array[
    'private.gmail_model_response_schema_text_v1()'::regprocedure,
    'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'::regprocedure,
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure,
    'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_proc) into v_definition;
    if position('gmail-model-candidate-claims-v3' in v_definition)>0 then
      v_updated:=replace(
        v_definition,'gmail-model-candidate-claims-v3','gmail-model-candidate-claims-v4'
      );
      v_updated:=replace(
        v_updated,'gmail-claim-extraction-prompt-v3','gmail-claim-extraction-prompt-v4'
      );
    elsif position('gmail-model-candidate-claims-v4' in v_definition)>0 then
      v_updated:=v_definition;
    else
      raise exception 'Gmail model schema-v3/v4 marker missing from %',v_proc
        using errcode='23514';
    end if;
    if v_proc='private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure then
      v_updated:=replace(
        v_updated,'gmail_model_candidate_claims_v3','gmail_model_candidate_claims_v4'
      );
      v_updated:=replace(
        v_updated,'pikiio-gmail-action-prompt-v3-14f15e0b35e459ba',
        'pikiio-gmail-action-prompt-v4-6fb7a3eb3cc1a875'
      );
      v_updated:=replace(v_updated,
        'neither is completion. Every unresolved signal',
        'neither is completion. A POD promise or future such as will send POD after unloading is pod_received with neutral polarity and planned status; positive received requires source proof that the POD itself is attached, enclosed, provided, or received. Every unresolved signal'
      );
    end if;
    if position('gmail-model-candidate-claims-v3' in v_updated)>0
      or position('gmail-claim-extraction-prompt-v3' in v_updated)>0
      or (v_proc='private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure
        and (position('gmail_model_candidate_claims_v4' in v_updated)=0
          or position('pikiio-gmail-action-prompt-v4-6fb7a3eb3cc1a875' in v_updated)=0
          or position('POD promise or future such as will send POD' in v_updated)=0
          or position('"temperature"' in v_updated)>0)) then
      raise exception 'Gmail prompt-v4 wire rewrite is incomplete: %',v_proc
        using errcode='23514';
    end if;
    execute v_updated;
  end loop;
end;
$install_prompt_v4$;

create table if not exists public.truth_gmail_model_pod_prompt_retry_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-gmail-model-pod-prompt-retry-authorization:v1:'
      ||authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  run_token_hash text not null check(run_token_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  replay_id text not null unique,
  prior_temperature_authorization_id text not null unique,
  prior_temperature_parent_job_id uuid not null unique,
  prior_review_job_id uuid not null unique,
  prior_obligation_id text not null unique,
  prior_model_child_job_id uuid not null unique,
  prior_model_request_id text not null unique,
  prior_model_outcome_id text not null unique,
  source_observation_id text not null,
  source_observation_content_hash text not null check(
    source_observation_content_hash~'^[0-9a-f]{64}$'
  ),
  successor_payload_hash text not null check(successor_payload_hash~'^[0-9a-f]{64}$'),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v11-1a2edda3'
  ),
  canonical_authorization jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-model-pod-prompt-retry-authorization-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  authorized_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,authorization_id),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,prior_temperature_authorization_id)
    references public.truth_gmail_model_temperature_retry_authorizations(
      workspace_key,authorization_id
    ) on update restrict on delete restrict,
  check(authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_authorization->>'schemaVersion'=schema_version),
  check(canonical_authorization->>'workspaceKey'=workspace_key),
  check(canonical_authorization->>'connectionKey'=connection_key),
  check(canonical_authorization->>'sourceJobId'=source_job_id::text),
  check(canonical_authorization->>'rootBatchId'=root_batch_id::text),
  check(canonical_authorization->>'replayId'=replay_id),
  check(canonical_authorization->>'runTokenHash'=run_token_hash),
  check(canonical_authorization->>'reasonCode'='POD_PROMISE_NOT_RECEIPT'),
  check(canonical_authorization->>'activeProcessorVersion'=active_processor_version),
  check(canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_model_pod_prompt_retry_authorizations_immutable
  on public.truth_gmail_model_pod_prompt_retry_authorizations;
create trigger truth_gmail_model_pod_prompt_retry_authorizations_immutable
before update or delete on public.truth_gmail_model_pod_prompt_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_model_pod_prompt_retry_authorizations enable row level security;
alter table public.truth_gmail_model_pod_prompt_retry_authorizations force row level security;
revoke all on public.truth_gmail_model_pod_prompt_retry_authorizations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_model_pod_prompt_retry_authorizations to service_role;

do $alias_predecessors$
begin
  if to_regprocedure('private.truth_gmail_parent_allowed_pre_pod_v1(text,uuid)') is null then
    alter function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
      text,uuid
    ) rename to truth_gmail_parent_allowed_pre_pod_v1;
    alter function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
      text,uuid,text,text
    ) rename to truth_gmail_parent_worker_pre_pod_v1;
    alter function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
      text,text,uuid,text,text,jsonb
    ) rename to truth_gmail_child_input_pre_pod_v1;
  end if;
end;
$alias_predecessors$;

revoke all on function private.truth_gmail_parent_allowed_pre_pod_v1(text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function private.truth_gmail_parent_worker_pre_pod_v1(text,uuid,text,text)
  from public,anon,authenticated,service_role;
revoke all on function private.truth_gmail_child_input_pre_pod_v1(text,text,uuid,text,text,jsonb)
  from public,anon,authenticated,service_role;

create or replace function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select private.truth_gmail_parent_allowed_pre_pod_v1(
    p_workspace_key,p_parent_job_id
  ) or exists(
    select 1
    from public.truth_gmail_model_pod_prompt_retry_authorizations auth
    join public.truth_gmail_model_temperature_retry_authorizations prior_auth
      on prior_auth.workspace_key=auth.workspace_key
     and prior_auth.authorization_id=auth.prior_temperature_authorization_id
    join public.truth_shadow_gmail_model_commissioning_replays replay
      on replay.workspace_key=auth.workspace_key and replay.replay_id=auth.replay_id
    join public.source_processing_jobs job
      on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    where auth.workspace_key=p_workspace_key and auth.source_job_id=p_parent_job_id
      and auth.run_token_hash=
        '0000000000000000000000000000000000000000000000000000000000000008'
      and auth.authorization_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth.canonical_authorization),'UTF8'
      ),'sha256'),'hex')
      and prior_auth.source_job_id=auth.prior_temperature_parent_job_id
      and job.source_system='gmail' and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.observation_id=auth.source_observation_id
      and job.payload->>'modelPodPromptRetryVersion'=
        'truth-gmail-model-pod-prompt-retry-successor-v1'
      and job.payload->>'modelPodPromptRetryReplayId'=replay.replay_id
      and job.payload->>'modelPodPromptRetryPriorParentJobId'=
        auth.prior_temperature_parent_job_id::text
      and job.payload->>'shadowOnly'='false'
      and encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(job.payload),'UTF8'
      ),'sha256'),'hex')=auth.successor_payload_hash
      and lineage.root_batch_id=auth.root_batch_id
      and lineage.parent_job_id=replay.original_parent_job_id
      and lineage.root_job_id=replay.root_job_id
      and lineage.source_cursor_version=replay.source_cursor_version
      and lineage.source_cursor_value=replay.source_cursor_value
      and replay.connection_key='primary' and replay.shadow_only=false
      and replay.production_eligible=false
      and replay.production_publication_attempted=false
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key,replay.obligation_id
      )
      and private.truth_gmail_live_message_model_root_allowed_v1(
        job.workspace_key,job.connection_key,lineage.root_batch_id
      )
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=auth.workspace_key
          and epoch.root_batch_id=auth.root_batch_id)
      and not exists(select 1 from public.truth_shadow_root_source_cuts root_cut
        where root_cut.workspace_key=auth.workspace_key
          and root_cut.root_batch_id=auth.root_batch_id)
      and job.state not in ('dead_letter','superseded')
  );
$function$;

revoke all on function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  text,uuid
) from public,anon,authenticated,service_role;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select private.truth_gmail_parent_worker_pre_pod_v1(
    p_workspace_key,p_parent_job_id,p_worker_id,p_processor_version
  ) or exists(
    select 1
    from public.truth_gmail_model_pod_prompt_retry_authorizations auth
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=auth.workspace_key and lineage.job_id=auth.source_job_id
    where auth.workspace_key=p_workspace_key and auth.source_job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||lineage.root_batch_id::text
      and p_processor_version=auth.active_processor_version
      and auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v11-1a2edda3'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

create or replace function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  p_workspace_key text,p_parent_job_id text,p_child_job_id uuid,
  p_dedupe_key text,p_observation_id text,p_payload jsonb
) returns boolean
language sql stable security definer set search_path=''
set statement_timeout='150s' set lock_timeout='30s'
as $function$
  select private.truth_gmail_child_input_pre_pod_v1(
    p_workspace_key,p_parent_job_id,p_child_job_id,p_dedupe_key,
    p_observation_id,p_payload
  ) or exists(
    select 1
    from public.truth_gmail_model_pod_prompt_retry_authorizations auth
    join public.source_processing_jobs parent_job
      on parent_job.workspace_key=auth.workspace_key
     and parent_job.job_id=auth.source_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=parent_job.workspace_key
     and lineage.job_id=parent_job.job_id
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key=auth.workspace_key and plan.parent_job_id=auth.source_job_id
    where auth.workspace_key=p_workspace_key
      and auth.source_job_id::text=p_parent_job_id
      and p_child_job_id is not null
      and p_dedupe_key='gmail:model-claims:v1:'||plan.model_plan_hash
      and p_observation_id=parent_job.observation_id
      and jsonb_typeof(coalesce(p_payload,'null'::jsonb))='object'
      and private.truth_jsonb_has_only_keys(p_payload,array[
        'schemaVersion','modelPlanId','contextSealId','batchId',
        'rootBatchId','rootJobId','parentJobId'
      ])
      and (select count(*) from jsonb_object_keys(p_payload))=7
      and p_payload->>'schemaVersion'='gmail-model-claims-job-v1'
      and p_payload->>'modelPlanId'=plan.model_plan_id
      and p_payload->>'contextSealId'=plan.context_seal_id
      and p_payload->>'batchId'=auth.root_batch_id::text
      and p_payload->>'rootBatchId'=auth.root_batch_id::text
      and p_payload->>'rootJobId'=lineage.root_job_id::text
      and p_payload->>'parentJobId'=auth.source_job_id::text
      and plan.planning_status='complete' and plan.model_plan_id is not null
      and plan.model_plan_hash is not null and plan.model_plan is not null
      and plan.model_plan->>'promptVersion'='gmail-claim-extraction-prompt-v4'
      and plan.model_plan->>'responseSchemaVersion'=
        'gmail-model-candidate-claims-v4'
      and plan.execution_mode='sync'
      and plan.root_ingest_mode in ('history','cutover_delta_reconciliation')
      and private.truth_gmail_live_message_model_root_allowed_v1(
        auth.workspace_key,'primary',auth.root_batch_id
      )
      and private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
        auth.workspace_key,auth.source_job_id
      )
  );
$function$;

revoke all on function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  text,text,uuid,text,text,jsonb
) from public,anon,authenticated,service_role;

do $recover$
declare
  v_row record; v_core jsonb; v_core_hash text; v_new_job_id uuid;
  v_new_dedupe text; v_new_payload jsonb; v_payload_hash text;
  v_review_receipt jsonb; v_review_hash text; v_body jsonb; v_hash text;
  v_updated integer; v_recovered integer:=0;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-gmail-model-pod-prompt-retry-successor-v1',0
  ));

  for v_row in
    select replay.replay_id,replay.root_batch_id,replay.source_cursor_version,
      replay.source_cursor_value,replay.source_observation_id,
      replay.source_observation_content_hash,replay.original_parent_job_id,
      replay.root_job_id,prior_parent.job_id as prior_temperature_parent_job_id,
      prior_parent.source_object_id,prior_parent.max_attempts,
      prior_parent.payload as prior_parent_payload,
      prior_auth.authorization_id as prior_temperature_authorization_id,
      obligation.obligation_id as malformed_obligation_id,
      obligation.review_job_id as malformed_review_job_id,
      obligation.model_child_job_id as prior_model_child_job_id,
      request.request_id as prior_model_request_id,
      outcome.outcome_id as prior_model_outcome_id,
      model_plan.extraction_plan_id as prior_extraction_plan_id,
      model_plan.model_plan_id as prior_model_plan_id,
      outcome.provider_response_id,outcome.server_request_id,outcome.actual_model,
      outcome.actual_microusd
    from public.truth_gmail_model_temperature_retry_authorizations prior_auth
    join public.source_processing_jobs prior_parent
      on prior_parent.workspace_key=prior_auth.workspace_key
     and prior_parent.job_id=prior_auth.source_job_id
    join public.source_processing_job_lineage prior_lineage
      on prior_lineage.workspace_key=prior_parent.workspace_key
     and prior_lineage.job_id=prior_parent.job_id
     and prior_lineage.root_batch_id=prior_auth.root_batch_id
    join public.truth_shadow_gmail_model_commissioning_replays replay
      on replay.workspace_key=prior_auth.workspace_key
     and replay.replay_id=prior_auth.replay_id
    join public.gmail_model_extraction_plans model_plan
      on model_plan.workspace_key=prior_parent.workspace_key
     and model_plan.parent_job_id=prior_parent.job_id
     and model_plan.model_plan_id is not null
    join public.gmail_model_extraction_review_obligations obligation
      on obligation.workspace_key=model_plan.workspace_key
     and obligation.extraction_plan_id=model_plan.extraction_plan_id
     and obligation.model_plan_id=model_plan.model_plan_id
     and obligation.reason_code='MALFORMED_OUTPUT'
     and obligation.model_child_job_id is not null
    join public.gmail_model_extraction_review_intents intent
      on intent.workspace_key=obligation.workspace_key
     and intent.model_child_job_id=obligation.model_child_job_id
     and intent.model_plan_id=obligation.model_plan_id
     and intent.reason_code='MALFORMED_OUTPUT'
    join public.truth_model_requests request
      on request.workspace_key=intent.workspace_key
     and request.source_job_id=intent.model_child_job_id
     and request.state='review_required'
     and request.review_reason='MALFORMED_OUTPUT'
     and request.response_schema_version='gmail-model-candidate-claims-v3'
     and request.model_snapshot='gpt-5-nano-2025-08-07'
     and request.prompt_version='gmail-claim-extraction-prompt-v3'
     and request.actual_input_tokens>0 and request.actual_output_tokens>0
     and request.actual_total_tokens>0 and request.actual_microusd>0
     and request.remaining_reserved_microusd=0
     and not (request.request_payload ? 'temperature')
     and request.request_payload #>> '{text,format,name}'=
       'gmail_model_candidate_claims_v3'
    join public.truth_model_sync_attempt_outcomes outcome
      on outcome.workspace_key=request.workspace_key
     and outcome.request_id=request.request_id and outcome.attempt_number=1
     and outcome.classification='malformed_output'
     and outcome.request_sent=true and outcome.http_status=200
     and outcome.provider_error_code='model_output_validation_failed'
     and outcome.outcome_unknown=false and outcome.billing_outcome_unknown=false
     and nullif(trim(outcome.provider_response_id),'') is not null
     and nullif(trim(outcome.server_request_id),'') is not null
     and outcome.actual_model='gpt-5-nano-2025-08-07'
     and outcome.normalized_result is null
     and outcome.input_tokens=request.actual_input_tokens
     and outcome.cached_input_tokens=request.actual_cached_input_tokens
     and outcome.output_tokens=request.actual_output_tokens
     and outcome.reasoning_tokens=request.actual_reasoning_tokens
     and outcome.total_tokens=request.actual_total_tokens
     and outcome.actual_microusd=request.actual_microusd
     and outcome.actual_microusd>0
    join public.source_processing_jobs prior_child
      on prior_child.workspace_key=intent.workspace_key
     and prior_child.job_id=intent.model_child_job_id
     and prior_child.state='succeeded'
     and prior_child.result->>'outcome'='review_required'
     and prior_child.result->>'reviewReason'='MALFORMED_OUTPUT'
     and prior_child.result->>'modelRequestId'=request.request_id
    join public.source_processing_job_children prior_child_edge
      on prior_child_edge.parent_job_id=prior_parent.job_id
     and prior_child_edge.child_job_id=prior_child.job_id
    join public.source_processing_jobs prior_review
      on prior_review.workspace_key=obligation.workspace_key
     and prior_review.job_id=obligation.review_job_id
     and prior_review.state='waiting_runtime' and prior_review.attempt_count=0
     and prior_review.result='{}'::jsonb and prior_review.completed_at is null
     and prior_review.lease_owner is null and prior_review.lease_expires_at is null
     and prior_review.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED'
    where prior_auth.workspace_key='primary'
      and prior_auth.connection_key='primary'
      and prior_auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v10-fe957026'
      and prior_auth.canonical_authorization->>'reasonCode'=
        'GPT5_TEMPERATURE_UNSUPPORTED'
      and prior_parent.source_system='gmail' and prior_parent.connection_key='primary'
      and prior_parent.job_kind='gmail_extract_message_claims'
      and prior_parent.state='succeeded' and prior_parent.attempt_count=1
      and prior_parent.processor_version=
        'primary-message-model-drain-v1:parents-v10-fe957026'
      and prior_parent.result #>> '{truthPlan,modelPlanId}'=model_plan.model_plan_id
      and prior_parent.result #>> '{truthPlan,planningStatus}'='complete'
      and model_plan.model_plan->>'promptVersion'='gmail-claim-extraction-prompt-v3'
      and model_plan.model_plan->>'responseSchemaVersion'=
        'gmail-model-candidate-claims-v3'
      and replay.root_batch_id=prior_auth.root_batch_id
      and replay.source_observation_id=prior_auth.source_observation_id
      and replay.connection_key='primary' and replay.shadow_only=false
      and replay.production_eligible=false
      and replay.production_publication_attempted=false
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key,replay.obligation_id
      )
      and not exists(select 1 from public.truth_model_sync_attempt_outcomes other
        where other.workspace_key=request.workspace_key
          and other.request_id=request.request_id and other.attempt_number<>1)
      and not exists(select 1 from public.gmail_model_extraction_results result
        where result.workspace_key=request.workspace_key
          and result.model_plan_id=intent.model_plan_id)
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=prior_child.job_id)
      and not exists(select 1
        from public.truth_gmail_model_pod_prompt_retry_authorizations existing
        where existing.workspace_key=prior_auth.workspace_key
          and existing.prior_model_request_id=request.request_id)
    order by obligation.created_at,replay.replay_id
    for update of prior_review
  loop
    v_core:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-pod-prompt-retry-successor-v1',
      'workspaceKey','primary','connectionKey','primary',
      'rootBatchId',v_row.root_batch_id,'replayId',v_row.replay_id,
      'priorTemperatureAuthorizationId',v_row.prior_temperature_authorization_id,
      'priorTemperatureParentJobId',v_row.prior_temperature_parent_job_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'priorModelOutcomeId',v_row.prior_model_outcome_id,
      'priorMalformedReviewJobId',v_row.malformed_review_job_id,
      'priorMalformedObligationId',v_row.malformed_obligation_id,
      'sourceObservationId',v_row.source_observation_id,
      'sourceObservationContentHash',v_row.source_observation_content_hash,
      'promptVersion','gmail-claim-extraction-prompt-v4',
      'responseSchemaVersion','gmail-model-candidate-claims-v4',
      'reasonCode','POD_PROMISE_NOT_RECEIPT',
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000008',
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v11-1a2edda3',
      'productionPublicationAttempted',false
    );
    v_core_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_core),'UTF8'
    ),'sha256'),'hex');
    v_new_job_id:=(substr(v_core_hash,1,8)||'-'||substr(v_core_hash,9,4)||'-4'||
      substr(v_core_hash,14,3)||'-8'||substr(v_core_hash,18,3)||'-'||
      substr(v_core_hash,21,12))::uuid;
    v_new_dedupe:='truth-gmail-model-pod-prompt-retry-parent:v1:'||v_core_hash;
    v_new_payload:=v_row.prior_parent_payload||jsonb_build_object(
      'modelPodPromptRetryVersion','truth-gmail-model-pod-prompt-retry-successor-v1',
      'modelPodPromptRetryId','truth-gmail-model-pod-prompt-retry-successor:v1:'||v_core_hash,
      'modelPodPromptRetryReplayId',v_row.replay_id,
      'modelPodPromptRetryPriorParentJobId',v_row.prior_temperature_parent_job_id,
      'modelPodPromptRetryPriorRequestId',v_row.prior_model_request_id,
      'productionPublicationAttempted',false
    );
    v_payload_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_new_payload),'UTF8'
    ),'sha256'),'hex');
    v_review_receipt:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-pod-prompt-retry-review-supersession-v1',
      'status','superseded_by_pod_prompt_retry_parent',
      'workspaceKey','primary','rootBatchId',v_row.root_batch_id,
      'replayId',v_row.replay_id,'reviewJobId',v_row.malformed_review_job_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'priorProviderResponseId',v_row.provider_response_id,
      'priorProviderServerRequestId',v_row.server_request_id,
      'successorParentJobId',v_new_job_id,
      'reasonCode','POD_PROMISE_NOT_RECEIPT',
      'mutatesOperationalState',false,'productionPublicationAttempted',false
    );
    v_review_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_review_receipt),'UTF8'
    ),'sha256'),'hex');

    insert into public.source_processing_jobs(
      job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
      observation_id,source_object_id,state,attempt_count,max_attempts,
      available_at,lease_owner,lease_fence,lease_expires_at,last_error_code,
      safe_error_detail,processor_version,payload,result,created_at,updated_at,
      completed_at
    ) values(
      v_new_job_id,v_new_dedupe,'primary','gmail','primary',
      'gmail_extract_message_claims',v_row.source_observation_id,
      v_row.source_object_id,'waiting_runtime',0,v_row.max_attempts,clock_timestamp(),
      null,0,null,'GMAIL_MODEL_POD_PROMPT_RETRY_PENDING',
      'Awaiting immutable POD-promise prompt retry authorization.','',
      v_new_payload,'{}'::jsonb,clock_timestamp(),clock_timestamp(),null
    );
    insert into public.source_processing_job_lineage(
      job_id,workspace_key,source_system,connection_key,root_batch_id,
      parent_job_id,root_job_id,source_cursor_version,source_cursor_value
    ) values(
      v_new_job_id,'primary','gmail','primary',v_row.root_batch_id,
      v_row.original_parent_job_id,v_row.root_job_id,v_row.source_cursor_version,
      v_row.source_cursor_value
    );

    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-pod-prompt-retry-authorization-v1',
      'workspaceKey','primary','connectionKey','primary',
      'sourceJobId',v_new_job_id,'rootBatchId',v_row.root_batch_id,
      'replayId',v_row.replay_id,
      'priorTemperatureAuthorizationId',v_row.prior_temperature_authorization_id,
      'priorTemperatureParentJobId',v_row.prior_temperature_parent_job_id,
      'priorReviewJobId',v_row.malformed_review_job_id,
      'priorObligationId',v_row.malformed_obligation_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'priorModelOutcomeId',v_row.prior_model_outcome_id,
      'sourceObservationId',v_row.source_observation_id,
      'sourceObservationContentHash',v_row.source_observation_content_hash,
      'successorPayloadHash',v_payload_hash,
      'reviewSupersessionHash',v_review_hash,
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000008',
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v11-1a2edda3',
      'reasonCode','POD_PROMISE_NOT_RECEIPT',
      'providerCode','model_output_validation_failed','providerHttpStatus',200,
      'providerActualModel',v_row.actual_model,
      'providerActualMicrousd',v_row.actual_microusd,
      'modelCallsPerformed',false,'candidateClaimsAutoAccepted',false,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_model_pod_prompt_retry_authorizations(
      authorization_id,authorization_hash,run_token_hash,workspace_key,
      connection_key,source_job_id,root_batch_id,replay_id,
      prior_temperature_authorization_id,prior_temperature_parent_job_id,
      prior_review_job_id,prior_obligation_id,prior_model_child_job_id,
      prior_model_request_id,prior_model_outcome_id,source_observation_id,
      source_observation_content_hash,successor_payload_hash,
      active_processor_version,canonical_authorization,schema_version
    ) values(
      'truth-gmail-model-pod-prompt-retry-authorization:v1:'||v_hash,v_hash,
      v_body->>'runTokenHash','primary','primary',v_new_job_id,v_row.root_batch_id,
      v_row.replay_id,v_row.prior_temperature_authorization_id,
      v_row.prior_temperature_parent_job_id,v_row.malformed_review_job_id,
      v_row.malformed_obligation_id,v_row.prior_model_child_job_id,
      v_row.prior_model_request_id,v_row.prior_model_outcome_id,
      v_row.source_observation_id,v_row.source_observation_content_hash,
      v_payload_hash,'primary-message-model-drain-v1:parents-v11-1a2edda3',
      v_body,'truth-gmail-model-pod-prompt-retry-authorization-v1'
    );

    update public.source_processing_jobs successor
    set state='queued',available_at=clock_timestamp(),last_error_code='',
      safe_error_detail='',updated_at=clock_timestamp()
    where successor.workspace_key='primary' and successor.job_id=v_new_job_id
      and successor.state='waiting_runtime' and successor.attempt_count=0
      and successor.result='{}'::jsonb and successor.completed_at is null
      and successor.lease_owner is null and successor.lease_expires_at is null
      and exists(select 1
        from public.truth_gmail_model_pod_prompt_retry_authorizations auth
        where auth.workspace_key=successor.workspace_key
          and auth.source_job_id=successor.job_id
          and auth.successor_payload_hash=v_payload_hash);
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'POD-prompt retry parent could not enter its authorized queue'
        using errcode='40001';
    end if;

    update public.source_processing_jobs review_job
    set state='superseded',lease_owner=null,lease_expires_at=null,
      last_error_code='GMAIL_MODEL_POD_PROMPT_RETRY_AUTHORIZED',
      safe_error_detail='The malformed POD-promise review was superseded by one append-only prompt-v4 retry parent.',
      processor_version='truth-gmail-model-pod-prompt-retry-v1',
      result=v_review_receipt,updated_at=clock_timestamp(),
      completed_at=clock_timestamp()
    where review_job.workspace_key='primary'
      and review_job.job_id=v_row.malformed_review_job_id
      and review_job.state='waiting_runtime' and review_job.attempt_count=0
      and review_job.result='{}'::jsonb and review_job.completed_at is null
      and review_job.lease_owner is null and review_job.lease_expires_at is null
      and review_job.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED';
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'malformed review changed during POD-prompt retry authorization'
        using errcode='40001';
    end if;
    v_recovered:=v_recovered+1;
  end loop;

  if v_recovered>2 then
    raise exception 'POD-prompt retry recovery exceeded the bounded cohort'
      using errcode='54000';
  end if;
end;
$recover$;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v7(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='5s' set lock_timeout='1s'
as $function$
begin
  raise exception 'prompt-v3 temperature retry parent sealer v7 retired after semantic refusal'
    using errcode='42501';
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v7(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v7(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v8(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
    p_workspace_key,p_job_id,p_worker_id,p_processor_version
  ) then
    raise exception 'POD-prompt retry parent worker refused' using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_model_pod_prompt_retry_authorizations auth
      join public.source_processing_jobs job
        on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=auth.workspace_key and lineage.job_id=auth.source_job_id
       and lineage.root_batch_id=auth.root_batch_id
      where auth.workspace_key=p_workspace_key and auth.source_job_id=p_job_id
        and auth.active_processor_version=p_processor_version
        and auth.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence and job.attempt_count=1
        and job.processor_version=p_processor_version
        and not exists(select 1 from public.gmail_model_extraction_plans plan
          where plan.workspace_key=job.workspace_key and plan.parent_job_id=job.job_id)
        and not exists(select 1 from public.gmail_model_extraction_context_seals seal
          where seal.workspace_key=job.workspace_key and seal.parent_job_id=job.job_id)
        and not exists(select 1 from public.candidate_claim_job_manifests manifest
          where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
        and not exists(select 1 from public.candidate_claim_job_lineage candidate
          where candidate.job_id=job.job_id)
        and not exists(select 1 from public.source_processing_job_children child
          where child.parent_job_id=job.job_id)
    ) then
    raise exception 'POD-prompt retry parent token refused' using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v8(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v8(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare
  v_wire text; v_plan text; v_schema text; v_parent text; v_worker text;
  v_child text; v_v7 text; v_v8 text;
begin
  select pg_get_functiondef(
    'private.expected_gmail_model_wire_v1(jsonb,jsonb,text,jsonb,jsonb)'::regprocedure
  ) into v_wire;
  select pg_get_functiondef(
    'private.gmail_model_expected_plan_bytes_v1(public.source_observations,jsonb,jsonb,text)'::regprocedure
  ) into v_plan;
  select pg_get_functiondef(
    'private.gmail_model_response_schema_text_v1()'::regprocedure
  ) into v_schema;
  select pg_get_functiondef(
    'private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(text,uuid)'::regprocedure
  ) into v_parent;
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'::regprocedure
  ) into v_child;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v7(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v7;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v8(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v8;
  if position('gmail-claim-extraction-prompt-v4' in v_wire)=0
    or position('gmail-model-candidate-claims-v4' in v_wire)=0
    or position('gmail_model_candidate_claims_v4' in v_wire)=0
    or position('pikiio-gmail-action-prompt-v4-6fb7a3eb3cc1a875' in v_wire)=0
    or position('POD promise or future such as will send POD' in v_wire)=0
    or position('"temperature"' in v_wire)>0
    or position('gmail-claim-extraction-prompt-v4' in v_plan)=0
    or position('gmail-model-candidate-claims-v4' in v_plan)=0
    or position('gmail-model-candidate-claims-v4' in v_schema)=0
    or position('truth_gmail_model_pod_prompt_retry_authorizations' in v_parent)=0
    or position('parents-v11-1a2edda3' in v_worker)=0
    or position('truth_gmail_model_pod_prompt_retry_authorizations' in v_child)=0
    or position('sealer v7 retired after semantic refusal' in v_v7)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v7)>0
    or position('POD-prompt retry parent token refused' in v_v8)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v8)=0 then
    raise exception 'Gmail POD-promise prompt recovery is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1
    from public.truth_gmail_model_pod_prompt_retry_authorizations auth
    where auth.production_publication_attempted
      or auth.canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'Gmail POD-promise prompt recovery attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v8(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v8(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v8(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_model_pod_prompt_retry_authorizations',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'Gmail POD-promise prompt recovery ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_model_pod_prompt_retry_authorizations;

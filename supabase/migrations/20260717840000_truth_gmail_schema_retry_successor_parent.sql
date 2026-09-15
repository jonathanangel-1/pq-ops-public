-- Recover only zero-cost invalid_json_schema model reviews whose commissioned
-- parent already completed. Mint one new append-only parent, supersede the
-- exact configuration review, and bind the new parent to the schema-v2 worker.
-- No model call, candidate acceptance, cut, build, publication, email, or
-- freight mutation occurs in this migration or authorizer.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_definition text;
begin
  if to_regclass('public.truth_gmail_model_schema_retry_parent_authorizations') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regclass('public.gmail_model_extraction_review_obligations') is null
    or to_regclass('public.truth_model_requests') is null
    or to_regclass('public.truth_model_sync_attempt_outcomes') is null
    or to_regprocedure(
      'public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'schema-retry successor-parent prerequisites are unavailable'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_model_schema_retry_parent_authorizations) then
    raise exception 'v1 schema-retry authorizations already exist; refuse semantic rewrite'
      using errcode='23514';
  end if;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_definition;
  if position('schema-retry primary commissioned parent token refused' in v_definition)=0 then
    raise exception 'schema-retry parent v4 differs from reviewed predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

alter table public.truth_gmail_model_schema_retry_parent_authorizations
  drop constraint truth_gmail_model_schema_retry_p_active_processor_version_check;
alter table public.truth_gmail_model_schema_retry_parent_authorizations
  add constraint truth_gmail_model_schema_retry_p_active_processor_version_check
  check(active_processor_version=
    'primary-message-model-drain-v1:parents-v8-d0e09b75');

create or replace function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.truth_shadow_gmail_model_commissioning_scopes scope_row
      on scope_row.workspace_key=replay.workspace_key
     and scope_row.commissioning_scope_id=replay.commissioning_scope_id
    join public.source_processing_jobs successor
      on successor.workspace_key=replay.workspace_key
     and successor.job_id=replay.successor_parent_job_id
    where replay.workspace_key=p_workspace_key
      and replay.successor_parent_job_id=p_parent_job_id
      and successor.state not in ('dead_letter','superseded')
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key,replay.obligation_id
      )
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=replay.workspace_key
          and epoch.root_batch_id=replay.root_batch_id)
      and not exists(select 1 from public.truth_shadow_root_source_cuts root_cut
        where root_cut.workspace_key=replay.workspace_key
          and root_cut.root_batch_id=replay.root_batch_id)
      and not exists(select 1 from public.truth_builds build
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key=build.workspace_key
         and root_cut.source_cut_id=build.source_cut_id
        where root_cut.workspace_key=replay.workspace_key
          and root_cut.root_batch_id=replay.root_batch_id)
      and not exists(select 1 from public.truth_publications publication
        join public.truth_shadow_root_source_cuts root_cut
          on root_cut.workspace_key=publication.workspace_key
         and root_cut.source_cut_id=publication.source_cut_id
        where root_cut.workspace_key=replay.workspace_key
          and root_cut.root_batch_id=replay.root_batch_id)
  ) or exists(
    select 1
    from public.truth_gmail_model_schema_retry_parent_authorizations auth
    join public.source_processing_jobs job
      on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_shadow_gmail_model_commissioning_replays replay
      on replay.workspace_key=auth.workspace_key and replay.replay_id=auth.replay_id
    where auth.workspace_key=p_workspace_key and auth.source_job_id=p_parent_job_id
      and auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v8-d0e09b75'
      and auth.run_token_hash=
        '0000000000000000000000000000000000000000000000000000000000000006'
      and auth.authorization_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(auth.canonical_authorization),'UTF8'
      ),'sha256'),'hex')
      and auth.canonical_authorization->>'recoverySchemaVersion'=
        'truth-gmail-model-schema-retry-successor-v2'
      and auth.canonical_authorization->>'priorCommissionedSuccessorParentJobId'=
        replay.successor_parent_job_id::text
      and job.source_system='gmail' and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.observation_id=replay.source_observation_id
      and job.state not in ('dead_letter','superseded')
      and job.payload->>'modelSchemaRetryVersion'=
        'truth-gmail-model-schema-retry-successor-v2'
      and job.payload->>'modelSchemaRetryReplayId'=replay.replay_id
      and job.payload->>'modelSchemaRetryPriorParentJobId'=
        replay.successor_parent_job_id::text
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
  );
$function$;

revoke all on function private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
  text,uuid
) from public,anon,authenticated,service_role;

create or replace function private.truth_gmail_live_commissioned_parent_v1(
  p_workspace_key text,p_parent_job_id uuid
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    where job.workspace_key=p_workspace_key and job.job_id=p_parent_job_id
      and job.source_system='gmail' and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_claims'
      and job.payload->>'shadowOnly'='false'
      and private.truth_gmail_live_message_model_root_allowed_v1(
        job.workspace_key,job.connection_key,lineage.root_batch_id
      )
      and private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
        job.workspace_key,job.job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_v1(text,uuid)
  from public,anon,authenticated,service_role;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=p_workspace_key and lineage.job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||lineage.root_batch_id::text
      and p_processor_version='primary-message-model-drain-v1:parents-v8-d0e09b75'
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
  select exists(
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key=replay.workspace_key
     and plan.parent_job_id=replay.successor_parent_job_id
    where replay.workspace_key=p_workspace_key
      and replay.successor_parent_job_id::text=p_parent_job_id
      and p_child_job_id is not null
      and p_dedupe_key='gmail:model-claims:v1:'||plan.model_plan_hash
      and p_observation_id=replay.source_observation_id
      and jsonb_typeof(coalesce(p_payload,'null'::jsonb))='object'
      and private.truth_jsonb_has_only_keys(p_payload,array[
        'schemaVersion','modelPlanId','contextSealId','batchId',
        'rootBatchId','rootJobId','parentJobId'
      ])
      and (select count(*) from jsonb_object_keys(p_payload))=7
      and p_payload->>'schemaVersion'='gmail-model-claims-job-v1'
      and p_payload->>'modelPlanId'=plan.model_plan_id
      and p_payload->>'contextSealId'=plan.context_seal_id
      and p_payload->>'batchId'=replay.root_batch_id::text
      and p_payload->>'rootBatchId'=replay.root_batch_id::text
      and p_payload->>'rootJobId'=replay.root_job_id::text
      and p_payload->>'parentJobId'=replay.successor_parent_job_id::text
      and plan.planning_status='complete' and plan.model_plan_id is not null
      and plan.model_plan_hash is not null and plan.model_plan is not null
      and plan.execution_mode='sync'
      and ((replay.connection_key like 'shadow-%'
          and plan.root_ingest_mode in ('backfill','reconciliation'))
        or (replay.connection_key='primary' and replay.shadow_only=false
          and plan.root_ingest_mode in ('history','cutover_delta_reconciliation')
          and private.truth_gmail_live_message_model_root_allowed_v1(
            replay.workspace_key,replay.connection_key,replay.root_batch_id)))
      and private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
        replay.workspace_key,replay.successor_parent_job_id
      )
  ) or exists(
    select 1
    from public.truth_gmail_model_schema_retry_parent_authorizations auth
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

create or replace function private.authorize_truth_gmail_model_schema_retry_parents(
  p_workspace_key text,p_connection_key text,p_root_batch_id uuid,p_limit integer,
  p_review_token text,p_sync_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
declare
  v_row record; v_core jsonb; v_core_hash text; v_new_job_id uuid;
  v_new_dedupe text; v_new_payload jsonb; v_payload_hash text;
  v_review_receipt jsonb; v_review_hash text; v_body jsonb; v_hash text;
  v_new_items jsonb:='[]'::jsonb; v_all_items jsonb:='[]'::jsonb;
  v_updated integer; v_total integer;
begin
  if not private.valid_truth_sync_token(p_sync_token)
    or not private.valid_truth_review_token(p_review_token) then
    raise exception 'invalid truth authorization token' using errcode='28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_connection_key is distinct from 'primary'
    or p_root_batch_id is null or p_limit is null or p_limit<1 or p_limit>10 then
    raise exception 'schema-retry parent authorization scope is invalid'
      using errcode='22023';
  end if;
  perform private.truth_source_cut_mutation_lock(p_workspace_key);
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-gmail-model-schema-retry-successor-v2:'||p_root_batch_id::text,0
  ));

  for v_row in
    select replay.replay_id,replay.replay_hash,replay.commissioning_scope_id,
      replay.root_batch_id,replay.source_cursor_version,replay.source_cursor_value,
      replay.source_observation_id,replay.source_observation_content_hash,
      replay.original_parent_job_id,replay.root_job_id,
      commissioned.job_id as commissioned_parent_job_id,
      commissioned.source_object_id,commissioned.max_attempts,
      commissioned.payload as commissioned_payload,
      config_obligation.obligation_id as config_obligation_id,
      config_obligation.review_job_id as config_review_job_id,
      config_obligation.model_child_job_id as prior_model_child_job_id,
      request.request_id as prior_model_request_id,
      outcome.outcome_id as prior_model_outcome_id,
      model_plan.extraction_plan_id as prior_extraction_plan_id,
      model_plan.model_plan_id as prior_model_plan_id
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.source_processing_jobs commissioned
      on commissioned.workspace_key=replay.workspace_key
     and commissioned.job_id=replay.successor_parent_job_id
    join public.source_processing_job_lineage commissioned_lineage
      on commissioned_lineage.workspace_key=commissioned.workspace_key
     and commissioned_lineage.job_id=commissioned.job_id
    join public.gmail_model_extraction_plans model_plan
      on model_plan.workspace_key=commissioned.workspace_key
     and model_plan.parent_job_id=commissioned.job_id
     and model_plan.model_plan_id is not null
    join public.gmail_model_extraction_review_obligations config_obligation
      on config_obligation.workspace_key=model_plan.workspace_key
     and config_obligation.extraction_plan_id=model_plan.extraction_plan_id
     and config_obligation.model_plan_id=model_plan.model_plan_id
     and config_obligation.reason_code='CONFIGURATION_ERROR'
     and config_obligation.model_child_job_id is not null
    join public.gmail_model_extraction_review_intents intent
      on intent.workspace_key=config_obligation.workspace_key
     and intent.model_child_job_id=config_obligation.model_child_job_id
     and intent.model_plan_id=config_obligation.model_plan_id
     and intent.reason_code='CONFIGURATION_ERROR'
    join public.truth_model_requests request
      on request.workspace_key=intent.workspace_key
     and request.source_job_id=intent.model_child_job_id
     and request.state='review_required'
     and request.review_reason='CONFIGURATION_ERROR'
     and request.actual_microusd=0
    join public.truth_model_sync_attempt_outcomes outcome
      on outcome.workspace_key=request.workspace_key
     and outcome.request_id=request.request_id and outcome.attempt_number=1
     and outcome.classification='configuration_error'
     and outcome.request_sent=true and outcome.http_status=400
     and outcome.provider_error_code='invalid_json_schema'
     and outcome.outcome_unknown=false and outcome.billing_outcome_unknown=false
     and outcome.provider_response_id='' and outcome.actual_model=''
     and outcome.normalized_result is null and outcome.actual_microusd=0
    join public.source_processing_jobs prior_child
      on prior_child.workspace_key=intent.workspace_key
     and prior_child.job_id=intent.model_child_job_id
     and prior_child.state='succeeded'
     and prior_child.result->>'outcome'='review_required'
     and prior_child.result->>'reviewReason'='CONFIGURATION_ERROR'
     and prior_child.result->>'modelRequestId'=request.request_id
    join public.source_processing_job_children commissioned_child
      on commissioned_child.parent_job_id=commissioned.job_id
     and commissioned_child.child_job_id=prior_child.job_id
    join public.source_processing_jobs prior_review
      on prior_review.workspace_key=config_obligation.workspace_key
     and prior_review.job_id=config_obligation.review_job_id
     and prior_review.state='waiting_runtime' and prior_review.attempt_count=0
     and prior_review.result='{}'::jsonb and prior_review.completed_at is null
     and prior_review.lease_owner is null and prior_review.lease_expires_at is null
     and prior_review.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED'
    where replay.workspace_key=p_workspace_key
      and replay.connection_key=p_connection_key
      and replay.root_batch_id=p_root_batch_id
      and replay.shadow_only=false and replay.production_eligible=false
      and replay.production_publication_attempted=false
      and commissioned.source_system='gmail' and commissioned.connection_key='primary'
      and commissioned.job_kind='gmail_extract_message_claims'
      and commissioned.state='succeeded' and commissioned.completed_at is not null
      and commissioned.result #>> '{truthPlan,modelPlanId}'=model_plan.model_plan_id
      and commissioned.result #>> '{truthPlan,planningStatus}'='complete'
      and commissioned.payload=replay.successor_payload
      and commissioned.observation_id=replay.source_observation_id
      and commissioned_lineage.root_batch_id=replay.root_batch_id
      and commissioned_lineage.parent_job_id=replay.original_parent_job_id
      and commissioned_lineage.root_job_id=replay.root_job_id
      and commissioned_lineage.source_cursor_version=replay.source_cursor_version
      and commissioned_lineage.source_cursor_value=replay.source_cursor_value
      and replay.source_observation_content_hash=(select observation.content_hash
        from public.source_observations observation
        where observation.workspace_key=replay.workspace_key
          and observation.observation_id=replay.source_observation_id)
      and replay.replay_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_replay),'UTF8'
      ),'sha256'),'hex')
      and replay.receipt_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(replay.canonical_receipt),'UTF8'
      ),'sha256'),'hex')
      and not exists(select 1 from public.truth_model_sync_attempt_outcomes other
        where other.workspace_key=request.workspace_key
          and other.request_id=request.request_id and other.attempt_number<>1)
      and not exists(select 1 from public.gmail_model_extraction_results result
        where result.workspace_key=request.workspace_key
          and result.model_plan_id=intent.model_plan_id)
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=prior_child.job_id)
      and not exists(select 1
        from public.truth_gmail_model_schema_retry_parent_authorizations auth
        where auth.workspace_key=replay.workspace_key and auth.replay_id=replay.replay_id)
    order by config_obligation.created_at,replay.replay_id
    limit p_limit
    for update of prior_review
  loop
    v_core:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-schema-retry-successor-v2',
      'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
      'rootBatchId',v_row.root_batch_id,'replayId',v_row.replay_id,
      'priorCommissionedSuccessorParentJobId',v_row.commissioned_parent_job_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'priorModelOutcomeId',v_row.prior_model_outcome_id,
      'priorConfigReviewJobId',v_row.config_review_job_id,
      'priorConfigObligationId',v_row.config_obligation_id,
      'sourceObservationId',v_row.source_observation_id,
      'sourceObservationContentHash',v_row.source_observation_content_hash,
      'responseSchemaVersion','gmail-model-candidate-claims-v2',
      'reasonCode','PROVIDER_SCHEMA_UNIQUEITEMS_REFUSED',
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000006',
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v8-d0e09b75',
      'productionPublicationAttempted',false
    );
    v_core_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_core),'UTF8'
    ),'sha256'),'hex');
    v_new_job_id:=(substr(v_core_hash,1,8)||'-'||substr(v_core_hash,9,4)||'-4'||
      substr(v_core_hash,14,3)||'-8'||substr(v_core_hash,18,3)||'-'||
      substr(v_core_hash,21,12))::uuid;
    v_new_dedupe:='truth-gmail-model-schema-retry-parent:v2:'||v_core_hash;
    v_new_payload:=v_row.commissioned_payload||jsonb_build_object(
      'modelSchemaRetryVersion','truth-gmail-model-schema-retry-successor-v2',
      'modelSchemaRetryId','truth-gmail-model-schema-retry-successor:v2:'||v_core_hash,
      'modelSchemaRetryReplayId',v_row.replay_id,
      'modelSchemaRetryPriorParentJobId',v_row.commissioned_parent_job_id,
      'modelSchemaRetryPriorRequestId',v_row.prior_model_request_id,
      'productionPublicationAttempted',false
    );
    v_payload_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_new_payload),'UTF8'
    ),'sha256'),'hex');
    v_review_receipt:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-schema-retry-review-supersession-v2',
      'status','superseded_by_schema_v2_retry_parent',
      'workspaceKey',p_workspace_key,'rootBatchId',v_row.root_batch_id,
      'replayId',v_row.replay_id,'reviewJobId',v_row.config_review_job_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'successorParentJobId',v_new_job_id,
      'reasonCode','PROVIDER_SCHEMA_UNIQUEITEMS_REFUSED',
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
      v_new_job_id,v_new_dedupe,p_workspace_key,'gmail','primary',
      'gmail_extract_message_claims',v_row.source_observation_id,
      v_row.source_object_id,'waiting_runtime',0,v_row.max_attempts,clock_timestamp(),
      null,0,null,'GMAIL_MODEL_SCHEMA_V2_RETRY_PENDING',
      'Awaiting the immutable schema-v2 retry authorization.','',
      v_new_payload,'{}'::jsonb,clock_timestamp(),
      clock_timestamp(),null
    );
    insert into public.source_processing_job_lineage(
      job_id,workspace_key,source_system,connection_key,root_batch_id,
      parent_job_id,root_job_id,source_cursor_version,source_cursor_value
    ) values(
      v_new_job_id,p_workspace_key,'gmail','primary',v_row.root_batch_id,
      v_row.original_parent_job_id,v_row.root_job_id,v_row.source_cursor_version,
      v_row.source_cursor_value
    );

    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-schema-retry-parent-authorization-v1',
      'recoverySchemaVersion','truth-gmail-model-schema-retry-successor-v2',
      'workspaceKey',p_workspace_key,'connectionKey','primary',
      'sourceJobId',v_new_job_id,'rootBatchId',v_row.root_batch_id,
      'replayId',v_row.replay_id,
      'priorCommissionedSuccessorParentJobId',v_row.commissioned_parent_job_id,
      'priorReviewJobId',v_row.config_review_job_id,
      'priorObligationId',v_row.config_obligation_id,
      'priorModelChildJobId',v_row.prior_model_child_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'priorModelOutcomeId',v_row.prior_model_outcome_id,
      'sourceObservationId',v_row.source_observation_id,
      'sourceObservationContentHash',v_row.source_observation_content_hash,
      'successorPayloadHash',v_payload_hash,
      'reviewSupersessionHash',v_review_hash,
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000006',
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v8-d0e09b75',
      'reasonCode','PROVIDER_SCHEMA_UNIQUEITEMS_REFUSED',
      'providerCode','invalid_json_schema','providerHttpStatus',400,
      'providerActualMicrousd',0,'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_model_schema_retry_parent_authorizations(
      authorization_id,authorization_hash,run_token_hash,workspace_key,
      connection_key,source_job_id,root_batch_id,replay_id,prior_review_job_id,
      prior_obligation_id,prior_model_child_job_id,prior_model_request_id,
      prior_model_outcome_id,source_observation_id,source_observation_content_hash,
      successor_payload_hash,active_processor_version,canonical_authorization,
      schema_version
    ) values(
      'truth-gmail-model-schema-retry-parent-authorization:v1:'||v_hash,v_hash,
      v_body->>'runTokenHash',p_workspace_key,'primary',v_new_job_id,
      v_row.root_batch_id,v_row.replay_id,v_row.config_review_job_id,
      v_row.config_obligation_id,v_row.prior_model_child_job_id,
      v_row.prior_model_request_id,v_row.prior_model_outcome_id,
      v_row.source_observation_id,v_row.source_observation_content_hash,
      v_payload_hash,'primary-message-model-drain-v1:parents-v8-d0e09b75',
      v_body,'truth-gmail-model-schema-retry-parent-authorization-v1'
    );

    update public.source_processing_jobs successor
    set state='queued',available_at=clock_timestamp(),last_error_code='',
      safe_error_detail='',updated_at=clock_timestamp()
    where successor.workspace_key=p_workspace_key
      and successor.job_id=v_new_job_id and successor.state='waiting_runtime'
      and successor.attempt_count=0 and successor.result='{}'::jsonb
      and successor.completed_at is null and successor.lease_owner is null
      and successor.lease_expires_at is null
      and exists(select 1
        from public.truth_gmail_model_schema_retry_parent_authorizations auth
        where auth.workspace_key=successor.workspace_key
          and auth.source_job_id=successor.job_id
          and auth.successor_payload_hash=v_payload_hash
          and auth.active_processor_version=
            'primary-message-model-drain-v1:parents-v8-d0e09b75');
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'schema-v2 retry parent could not enter its authorized queue'
        using errcode='40001';
    end if;

    update public.source_processing_jobs review_job
    set state='superseded',lease_owner=null,lease_expires_at=null,
      last_error_code='GMAIL_MODEL_SCHEMA_V2_RETRY_AUTHORIZED',
      safe_error_detail='The zero-cost invalid schema review was superseded by one append-only schema-v2 retry parent.',
      processor_version='truth-gmail-model-schema-retry-v2',
      result=v_review_receipt,updated_at=clock_timestamp(),
      completed_at=clock_timestamp()
    where review_job.workspace_key=p_workspace_key
      and review_job.job_id=v_row.config_review_job_id
      and review_job.state='waiting_runtime' and review_job.attempt_count=0
      and review_job.result='{}'::jsonb and review_job.completed_at is null
      and review_job.lease_owner is null and review_job.lease_expires_at is null
      and review_job.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED';
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'configuration review changed during schema-v2 retry authorization'
        using errcode='40001';
    end if;

    v_new_items:=v_new_items||jsonb_build_array(jsonb_build_object(
      'authorizationId','truth-gmail-model-schema-retry-parent-authorization:v1:'||v_hash,
      'sourceJobId',v_new_job_id,'replayId',v_row.replay_id,
      'priorCommissionedSuccessorParentJobId',v_row.commissioned_parent_job_id,
      'priorModelRequestId',v_row.prior_model_request_id,
      'sourceObservationId',v_row.source_observation_id
    ));
  end loop;

  select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
    'authorizationId',auth.authorization_id,'sourceJobId',auth.source_job_id,
    'replayId',auth.replay_id,'priorModelRequestId',auth.prior_model_request_id,
    'sourceObservationId',auth.source_observation_id
  ) order by auth.authorized_at),'[]'::jsonb)
  into v_total,v_all_items
  from public.truth_gmail_model_schema_retry_parent_authorizations auth
  where auth.workspace_key=p_workspace_key and auth.root_batch_id=p_root_batch_id;

  return jsonb_build_object(
    'ok',true,'status',case when jsonb_array_length(v_new_items)>0
      then 'authorized' else 'unchanged' end,
    'schemaVersion','truth-gmail-model-schema-retry-parent-authorization-receipt-v2',
    'workspaceKey',p_workspace_key,'connectionKey',p_connection_key,
    'rootBatchId',p_root_batch_id,'authorizedCount',jsonb_array_length(v_new_items),
    'totalAuthorizationCount',v_total,'items',v_new_items,
    'allAuthorizations',v_all_items,'modelCallsPerformed',false,
    'candidateClaimsAutoAccepted',false,'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function private.authorize_truth_gmail_model_schema_retry_parents(
  text,text,uuid,integer,text,text
) from public,anon,authenticated,service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v4(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='5s' set lock_timeout='1s'
as $function$
begin
  raise exception 'schema-retry primary commissioned parent sealer v4 retired'
    using errcode='42501';
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v4(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v4(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v5(
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
    raise exception 'schema-v2 retry parent worker refused' using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_model_schema_retry_parent_authorizations auth
      join public.source_processing_jobs job
        on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=auth.workspace_key and lineage.job_id=auth.source_job_id
       and lineage.root_batch_id=auth.root_batch_id
      where auth.workspace_key=p_workspace_key and auth.source_job_id=p_job_id
        and auth.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and auth.active_processor_version=p_processor_version
        and auth.canonical_authorization->>'recoverySchemaVersion'=
          'truth-gmail-model-schema-retry-successor-v2'
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence and job.attempt_count=1
        and job.processor_version=p_processor_version
        and encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.payload),'UTF8'
        ),'sha256'),'hex')=auth.successor_payload_hash
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
    raise exception 'schema-v2 retry parent token refused' using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v5(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v5(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare v_worker text; v_parent text; v_child text; v_auth text; v_v4 text; v_v5 text;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(text,uuid)'::regprocedure
  ) into v_parent;
  select pg_get_functiondef(
    'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'::regprocedure
  ) into v_child;
  select pg_get_functiondef(
    'private.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)'::regprocedure
  ) into v_auth;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v4(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v4;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v5;
  if position('parents-v8-d0e09b75' in v_worker)=0
    or position('truth_gmail_model_schema_retry_parent_authorizations' in v_parent)=0
    or position('truth_gmail_model_schema_retry_parent_authorizations' in v_child)=0
    or position('truth-gmail-model-schema-retry-successor-v2' in v_auth)=0
    or position('schema-retry primary commissioned parent sealer v4 retired' in v_v4)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v4)>0
    or position('schema-v2 retry parent token refused' in v_v5)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v5)=0 then
    raise exception 'schema-v2 successor-parent recovery is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_model_schema_retry_parent_authorizations auth
    where auth.production_publication_attempted
      or auth.canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'schema-v2 successor-parent recovery attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.authorize_truth_gmail_model_schema_retry_parents(text,text,uuid,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) then
    raise exception 'schema-v2 successor-parent recovery ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_model_schema_retry_parent_authorizations;

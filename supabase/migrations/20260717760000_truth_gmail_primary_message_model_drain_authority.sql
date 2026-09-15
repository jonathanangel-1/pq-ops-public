-- Make the primary Gmail message-model commissioning chain singular:
-- commissioned parents are leased only by the exact tracked model-on drain,
-- live model children traverse the same input and claim authority, and the
-- deterministic cross-parent content-addressed collision receives one
-- immutable bounded retry authorization. This migration never executes a
-- model, accepts a claim, seals a cut, builds, or publishes truth.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_definition text;
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.truth_shadow_gmail_model_commissioning_replays') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regprocedure('private.truth_gmail_live_message_model_root_allowed_v1(text,text,uuid)') is null
    or to_regprocedure('private.truth_gmail_live_message_model_job_allowed_v1(text,uuid)') is null
    or to_regprocedure('private.truth_shadow_gmail_model_commissioning_replay_valid_v1(text,text)') is null
    or to_regprocedure('private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)') is null
    or to_regprocedure('private.truth_shadow_gmail_model_child_input_allowed_v3(text,text,uuid,text,text,jsonb)') is null
    or to_regprocedure('private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'primary message-model drain authority prerequisites are unavailable'
      using errcode='55000';
  end if;

  select lower(pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  )) into v_definition;
  if position('cheap_ordinary_claim_jobs as materialized' in v_definition)=0
    or position('for update of job skip locked' in v_definition)=0
    or position('truth_shadow_gmail_model_job_allowed_v3' in v_definition)=0 then
    raise exception 'source-processing claim selector differs from reviewed predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_live_commissioned_parent_v1(
  p_workspace_key text,p_parent_job_id uuid
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.truth_shadow_gmail_model_commissioning_replays replay
    join public.source_processing_jobs successor
      on successor.workspace_key=replay.workspace_key
     and successor.job_id=replay.successor_parent_job_id
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=successor.workspace_key
     and lineage.source_system=successor.source_system
     and lineage.connection_key=successor.connection_key
     and lineage.job_id=successor.job_id
    where replay.workspace_key=p_workspace_key
      and replay.successor_parent_job_id=p_parent_job_id
      and replay.connection_key='primary'
      and replay.shadow_only=false
      and replay.production_eligible=false
      and replay.production_publication_attempted=false
      and successor.source_system='gmail'
      and successor.connection_key='primary'
      and successor.job_kind='gmail_extract_message_claims'
      and successor.payload->>'modelCommissioningReplayId'=replay.replay_id
      and successor.payload->>'modelCommissioningScopeId'=replay.commissioning_scope_id
      and successor.payload->>'shadowOnly'='false'
      and lineage.root_batch_id=replay.root_batch_id
      and private.truth_gmail_live_message_model_root_allowed_v1(
        successor.workspace_key,successor.connection_key,lineage.root_batch_id
      )
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key,replay.obligation_id
      )
  );
$function$;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_job_lineage lineage
    where lineage.workspace_key=p_workspace_key
      and lineage.job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||lineage.root_batch_id::text
      and p_processor_version='primary-message-model-drain-v1:parents-v1'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_v1(text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

-- Reserve only actual commissioning successors. Ordinary primary Gmail claim
-- parents remain on the hosted deterministic worker.
do $rewrite_claim_selector$
declare
  v_signature regprocedure :=
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure;
  v_definition text;
  v_updated text;
  v_marker text := $marker$      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_extract_message_model_claims')$marker$;
  v_replacement text := $replacement$      and not (job.source_system = 'gmail'
        and job.job_kind = 'gmail_extract_message_model_claims')
      and not (
        job.source_system = 'gmail'
        and job.connection_key = 'primary'
        and job.job_kind = 'gmail_extract_message_claims'
        and private.truth_gmail_live_commissioned_parent_v1(
          job.workspace_key,job.job_id
        )
        and not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
          job.workspace_key,job.job_id,p_worker_id,p_processor_version
        )
      )$replacement$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_live_commissioned_parent_worker_allowed_v1' in v_definition)=0 then
    v_updated:=replace(v_definition,v_marker,v_replacement);
    if v_updated=v_definition then
      raise exception 'commissioned-parent claim reservation did not match reviewed selector'
        using errcode='23514';
    end if;
    execute v_updated;
  end if;
end;
$rewrite_claim_selector$;

-- The original child-input authority already proves exact replay, plan,
-- payload, lineage, and no accepted epoch/cut. Widen only its ingest-mode
-- predicate to the primary forward modes already admitted by 750000.
create or replace function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  p_workspace_key text,p_parent_job_id text,p_child_job_id uuid,
  p_dedupe_key text,p_observation_id text,p_payload jsonb
) returns boolean
language sql stable security definer set search_path=''
set statement_timeout='150s' set lock_timeout='30s'
as $function$
  select exists (
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
      and plan.planning_status='complete'
      and plan.model_plan_id is not null
      and plan.model_plan_hash is not null
      and plan.model_plan is not null
      and plan.execution_mode='sync'
      and (
        (replay.connection_key like 'shadow-%'
          and plan.root_ingest_mode in ('backfill','reconciliation'))
        or (replay.connection_key='primary'
          and replay.shadow_only=false
          and plan.root_ingest_mode in ('history','cutover_delta_reconciliation')
          and private.truth_gmail_live_message_model_root_allowed_v1(
            replay.workspace_key,replay.connection_key,replay.root_batch_id
          ))
      )
      and private.truth_shadow_gmail_model_commissioning_parent_allowed_v1(
        replay.workspace_key,replay.successor_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(
  text,text,uuid,text,text,jsonb
) from public,anon,authenticated,service_role;

create or replace function private.truth_gmail_live_plan_collision_id_v1(
  p_error_code text,p_safe_error_detail text
) returns text
language plpgsql immutable set search_path=''
as $function$
declare v_detail jsonb; v_plan_id text;
begin
  if p_error_code<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED' then return ''; end if;
  v_detail:=p_safe_error_detail::jsonb;
  if jsonb_typeof(v_detail)<>'object'
    or v_detail->>'schemaVersion'<>'truth-gmail-parent-planning-failure-v2'
    or v_detail->>'errorCode'<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or v_detail->>'underlyingCode'<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or v_detail->>'postgresCode'<>'23505'
    or v_detail->>'postgresMessage'<>'duplicate key value violates unique constraint "gmail_model_extraction_plans_pkey"'
    or v_detail->>'jobKind'<>'gmail_extract_message_claims' then return ''; end if;
  v_plan_id:=substring(v_detail->>'postgresDetail'
    from 'Key \(extraction_plan_id\)=\((gmail-extraction-plan:v1:[0-9a-f]{64})\) already exists\.');
  return coalesce(v_plan_id,'');
exception when others then return '';
end;
$function$;

revoke all on function private.truth_gmail_live_plan_collision_id_v1(text,text)
  from public,anon,authenticated,service_role;

create table if not exists public.truth_gmail_live_plan_collision_retry_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-gmail-live-plan-collision-retry:v1:'||authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  replay_id text not null,
  replay_hash text not null check(replay_hash~'^[0-9a-f]{64}$'),
  prior_extraction_plan_id text not null check(
    prior_extraction_plan_id~'^gmail-extraction-plan:v1:[0-9a-f]{64}$'
  ),
  prior_state text not null check(prior_state='dead_letter'),
  prior_attempt_count integer not null check(prior_attempt_count>=1),
  prior_max_attempts integer not null check(prior_max_attempts>=1),
  authorized_max_attempts integer not null check(
    authorized_max_attempts>=prior_attempt_count+3
  ),
  prior_lease_fence bigint not null check(prior_lease_fence>=1),
  prior_error_code text not null check(
    prior_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  prior_result_hash text not null check(prior_result_hash~'^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-plan-collision-retry-authorization-v1'
  ),
  production_publication_attempted boolean not null default false
    check(production_publication_attempted=false),
  authorized_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_authorization->>'schemaVersion'=schema_version),
  check(canonical_authorization->>'workspaceKey'=workspace_key),
  check(canonical_authorization->>'connectionKey'=connection_key),
  check(canonical_authorization->>'sourceJobId'=source_job_id::text),
  check(canonical_authorization->>'rootBatchId'=root_batch_id::text),
  check(canonical_authorization->>'replayId'=replay_id),
  check(canonical_authorization->>'replayHash'=replay_hash),
  check(canonical_authorization->>'priorExtractionPlanId'=prior_extraction_plan_id),
  check((canonical_authorization->>'priorAttemptCount')::integer=prior_attempt_count),
  check((canonical_authorization->>'authorizedMaxAttempts')::integer=authorized_max_attempts),
  check(canonical_authorization->>'reasonCode'='CONTENT_ADDRESSED_PLAN_CROSS_PARENT_COLLISION'),
  check(canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_plan_collision_retry_authorizations_immutable
  on public.truth_gmail_live_plan_collision_retry_authorizations;
create trigger truth_gmail_live_plan_collision_retry_authorizations_immutable
before update or delete on public.truth_gmail_live_plan_collision_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_plan_collision_retry_authorizations enable row level security;
alter table public.truth_gmail_live_plan_collision_retry_authorizations force row level security;
revoke all on public.truth_gmail_live_plan_collision_retry_authorizations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_plan_collision_retry_authorizations to service_role;

create table if not exists public.truth_gmail_live_model_child_activations (
  activation_id text primary key check(
    activation_id='truth-gmail-live-model-child-activation:v1:'||activation_hash
  ),
  activation_hash text not null unique check(activation_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  model_child_job_id uuid not null unique,
  parent_job_id uuid not null,
  root_batch_id uuid not null,
  prior_state text not null check(prior_state='waiting_runtime'),
  prior_attempt_count integer not null check(prior_attempt_count=0),
  prior_error_code text not null check(prior_error_code='GMAIL_MODEL_RUNTIME_DISABLED'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  canonical_activation jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-model-child-activation-v1'
  ),
  production_publication_attempted boolean not null default false
    check(production_publication_attempted=false),
  activated_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,model_child_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parent_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(activation_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_activation),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_activation->>'schemaVersion'=schema_version),
  check(canonical_activation->>'workspaceKey'=workspace_key),
  check(canonical_activation->>'connectionKey'=connection_key),
  check(canonical_activation->>'modelChildJobId'=model_child_job_id::text),
  check(canonical_activation->>'parentJobId'=parent_job_id::text),
  check(canonical_activation->>'rootBatchId'=root_batch_id::text),
  check(canonical_activation->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_model_child_activations_immutable
  on public.truth_gmail_live_model_child_activations;
create trigger truth_gmail_live_model_child_activations_immutable
before update or delete on public.truth_gmail_live_model_child_activations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_model_child_activations enable row level security;
alter table public.truth_gmail_live_model_child_activations force row level security;
revoke all on public.truth_gmail_live_model_child_activations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_model_child_activations to service_role;

do $recover_collisions$
declare
  v_job record;
  v_body jsonb;
  v_hash text;
  v_max integer;
  v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_job in
    select job.*,lineage.root_batch_id,replay.replay_id,replay.replay_hash,
      prior_plan.extraction_plan_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_shadow_gmail_model_commissioning_replays replay
      on replay.workspace_key=job.workspace_key
     and replay.successor_parent_job_id=job.job_id
    join public.gmail_model_extraction_plans prior_plan
      on prior_plan.workspace_key=replay.workspace_key
     and prior_plan.parent_job_id=replay.prior_parent_job_id
     and prior_plan.extraction_plan_id=
       private.truth_gmail_live_plan_collision_id_v1(
         job.last_error_code,job.safe_error_detail
       )
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter' and job.result='{}'::jsonb
      and job.lease_owner is null and job.lease_expires_at is null
      and replay.connection_key='primary' and replay.shadow_only=false
      and prior_plan.planning_status='review_required'
      and prior_plan.planning_failure_code='MODEL_RUNTIME_DISABLED'
      and prior_plan.model_plan_id is null
      and (job.safe_error_detail::jsonb)->>'postgresDetail'=
        'Key (extraction_plan_id)=('||prior_plan.extraction_plan_id||') already exists.'
      and private.truth_shadow_gmail_model_commissioning_replay_valid_v1(
        replay.workspace_key,replay.obligation_id
      )
      and not exists(select 1 from public.gmail_model_extraction_plans own_plan
        where own_plan.workspace_key=job.workspace_key and own_plan.parent_job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_manifests manifest
        where manifest.workspace_key=job.workspace_key and manifest.job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=job.job_id)
      and not exists(select 1 from public.source_processing_job_children child
        where child.parent_job_id=job.job_id)
      and not exists(select 1 from public.truth_shadow_claim_acceptance_epochs epoch
        where epoch.workspace_key=job.workspace_key and epoch.root_batch_id=lineage.root_batch_id)
      and not exists(select 1 from public.truth_shadow_root_source_cuts cut
        where cut.workspace_key=job.workspace_key and cut.root_batch_id=lineage.root_batch_id)
      and not exists(select 1 from public.truth_gmail_live_plan_collision_retry_authorizations prior
        where prior.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_max:=greatest(v_job.max_attempts,v_job.attempt_count+3);
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-live-plan-collision-retry-authorization-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'rootBatchId',v_job.root_batch_id,
      'replayId',v_job.replay_id,'replayHash',v_job.replay_hash,
      'priorExtractionPlanId',v_job.extraction_plan_id,
      'priorState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'authorizedMaxAttempts',v_max,
      'priorLeaseFence',v_job.lease_fence,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'priorResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex'),
      'reasonCode','CONTENT_ADDRESSED_PLAN_CROSS_PARENT_COLLISION',
      'claimedOnlyBy','primary-message-model-drain:parents:'||v_job.root_batch_id::text,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_live_plan_collision_retry_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,root_batch_id,replay_id,replay_hash,prior_extraction_plan_id,
      prior_state,prior_attempt_count,prior_max_attempts,authorized_max_attempts,
      prior_lease_fence,prior_error_code,prior_error_detail_hash,
      prior_payload_hash,prior_result_hash,canonical_authorization,schema_version
    ) values(
      'truth-gmail-live-plan-collision-retry:v1:'||v_hash,v_hash,
      v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.root_batch_id,
      v_job.replay_id,v_job.replay_hash,v_job.extraction_plan_id,v_job.state,
      v_job.attempt_count,v_job.max_attempts,v_max,v_job.lease_fence,
      v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body->>'priorResultHash',v_body,
      'truth-gmail-live-plan-collision-retry-authorization-v1'
    );
    update public.source_processing_jobs job set
      state='retry_wait',max_attempts=v_max,available_at=clock_timestamp(),
      lease_owner=null,lease_expires_at=null,completed_at=null,
      last_error_code='GMAIL_LIVE_PLAN_COLLISION_RETRY_AUTHORIZED',
      safe_error_detail='The exact cross-parent content-addressed plan collision is receipted; the tracked model-on primary parent worker owns the bounded retry.',
      updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state=v_job.state and job.attempt_count=v_job.attempt_count
      and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.result='{}'::jsonb and job.lease_owner is null
      and job.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then raise exception 'live plan-collision retry fence changed'
      using errcode='40001'; end if;
  end loop;
end;
$recover_collisions$;

do $activate_children$
declare v_child record; v_body jsonb; v_hash text; v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_child in
    select child.*,lineage.parent_job_id,lineage.root_batch_id
    from public.source_processing_jobs child
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=child.workspace_key and lineage.job_id=child.job_id
    where child.workspace_key='primary' and child.source_system='gmail'
      and child.connection_key='primary'
      and child.job_kind='gmail_extract_message_model_claims'
      and child.state='waiting_runtime' and child.attempt_count=0
      and child.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED'
      and child.result='{}'::jsonb and child.completed_at is null
      and child.lease_owner is null and child.lease_expires_at is null
      and private.truth_shadow_gmail_model_child_input_allowed_v3(
        child.workspace_key,child.payload->>'parentJobId',child.job_id,
        child.dedupe_key,child.observation_id,child.payload
      )
      and private.truth_gmail_live_message_model_job_allowed_v1(
        child.workspace_key,child.job_id
      )
      and not exists(select 1 from public.truth_gmail_live_model_child_activations prior
        where prior.model_child_job_id=child.job_id)
    order by child.job_id for update of child
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-live-model-child-activation-v1',
      'workspaceKey',v_child.workspace_key,'connectionKey',v_child.connection_key,
      'modelChildJobId',v_child.job_id,'parentJobId',v_child.parent_job_id,
      'rootBatchId',v_child.root_batch_id,'priorState',v_child.state,
      'priorAttemptCount',v_child.attempt_count,'priorErrorCode',v_child.last_error_code,
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_child.payload),'UTF8'),'sha256'),'hex'),
      'reasonCode','LIVE_COMMISSIONING_CHILD_INPUT_AUTHORITY_ALIGNED',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_gmail_live_model_child_activations(
      activation_id,activation_hash,workspace_key,connection_key,
      model_child_job_id,parent_job_id,root_batch_id,prior_state,
      prior_attempt_count,prior_error_code,prior_payload_hash,
      canonical_activation,schema_version
    ) values(
      'truth-gmail-live-model-child-activation:v1:'||v_hash,v_hash,
      v_child.workspace_key,v_child.connection_key,v_child.job_id,
      v_child.parent_job_id,v_child.root_batch_id,v_child.state,
      v_child.attempt_count,v_child.last_error_code,v_body->>'priorPayloadHash',
      v_body,'truth-gmail-live-model-child-activation-v1'
    );
    update public.source_processing_jobs child set
      state='queued',available_at=clock_timestamp(),last_error_code='',
      safe_error_detail='',updated_at=clock_timestamp()
    where child.workspace_key=v_child.workspace_key and child.job_id=v_child.job_id
      and child.state=v_child.state and child.attempt_count=v_child.attempt_count
      and child.lease_fence=v_child.lease_fence
      and child.last_error_code=v_child.last_error_code
      and child.safe_error_detail=v_child.safe_error_detail
      and child.payload=v_child.payload and child.result='{}'::jsonb
      and child.lease_owner is null and child.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then raise exception 'live model-child activation fence changed'
      using errcode='40001'; end if;
  end loop;
end;
$activate_children$;

analyze public.source_processing_jobs;
analyze public.truth_gmail_live_plan_collision_retry_authorizations;
analyze public.truth_gmail_live_model_child_activations;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_live_commissioned_parent_worker_allowed_v1' in v_definition)=0 then
    raise exception 'commissioned-parent claim reservation is absent' using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.truth_shadow_gmail_model_commissioning_child_input_allowed_v1(text,text,uuid,text,text,jsonb)'::regprocedure
  ) into v_definition;
  if position('cutover_delta_reconciliation' in v_definition)=0
    or position('truth_gmail_live_message_model_root_allowed_v1' in v_definition)=0 then
    raise exception 'live model-child input authority is absent' using errcode='55000';
  end if;
  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and private.truth_gmail_live_plan_collision_id_v1(
        job.last_error_code,job.safe_error_detail
      )<>''
      and private.truth_gmail_live_commissioned_parent_v1(job.workspace_key,job.job_id)
  ) then raise exception 'eligible commissioned plan collision remained dead-lettered'
    using errcode='55000'; end if;
  if exists(select 1 from public.truth_gmail_live_plan_collision_retry_authorizations auth
      where auth.production_publication_attempted
        or auth.canonical_authorization->>'productionPublicationAttempted'<>'false')
    or exists(select 1 from public.truth_gmail_live_model_child_activations activation
      where activation.production_publication_attempted
        or activation.canonical_activation->>'productionPublicationAttempted'<>'false') then
    raise exception 'primary message-model drain authority attempted publication'
      using errcode='55000';
  end if;
  if has_table_privilege('anon','public.truth_gmail_live_plan_collision_retry_authorizations','SELECT')
    or has_table_privilege('authenticated','public.truth_gmail_live_plan_collision_retry_authorizations','SELECT')
    or has_table_privilege('service_role','public.truth_gmail_live_plan_collision_retry_authorizations','INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('anon','public.truth_gmail_live_model_child_activations','SELECT')
    or has_table_privilege('authenticated','public.truth_gmail_live_model_child_activations','SELECT')
    or has_table_privilege('service_role','public.truth_gmail_live_model_child_activations','INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'primary message-model authority ledger ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

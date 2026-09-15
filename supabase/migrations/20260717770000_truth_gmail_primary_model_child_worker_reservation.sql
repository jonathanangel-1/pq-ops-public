-- Reserve primary live Gmail model children for the exact batch-scoped
-- model-on drain. The hosted model-off worker may continue to own shadow and
-- ordinary deterministic work, but it cannot consume a live child's attempts.
-- Recover already-consumed MODEL_RUNTIME_DISABLED attempts through one
-- immutable class-scoped receipt. This migration performs no provider call,
-- claim acceptance, source cut, build, publication, Gmail send, or TMS action.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_definition text;
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.truth_gmail_live_model_child_activations') is null
    or to_regclass('public.truth_model_requests') is null
    or to_regprocedure(
      'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_live_message_model_job_allowed_v1(text,uuid)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'primary model-child worker reservation prerequisites are unavailable'
      using errcode='55000';
  end if;

  select lower(pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  )) into v_definition;
  if position('cheap_message_model_claim_jobs as materialized' in v_definition)=0
    or position('admitted_message_model_claim_jobs as materialized' in v_definition)=0
    or position('truth_gmail_live_commissioned_parent_worker_allowed_v1' in v_definition)=0
    or position('for update of job skip locked' in v_definition)=0 then
    raise exception 'source-processing claim selector differs from reviewed 760000 predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_live_model_child_worker_allowed_v1(
  p_workspace_key text,p_child_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_jobs child
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=child.workspace_key
     and lineage.source_system=child.source_system
     and lineage.connection_key=child.connection_key
     and lineage.job_id=child.job_id
    where child.workspace_key=p_workspace_key
      and child.job_id=p_child_job_id
      and child.source_system='gmail'
      and child.connection_key='primary'
      and child.job_kind='gmail_extract_message_model_claims'
      and p_worker_id='primary-message-model-drain:claims:'||lineage.root_batch_id::text
      and p_processor_version='primary-message-model-drain-v1:claims-v2'
      and private.truth_gmail_live_message_model_job_allowed_v1(
        child.workspace_key,child.job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_model_child_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

-- The message-model CTE is separate from the ordinary parent CTE. Reserve a
-- live primary child at its actual admission point, after the existing stored
-- job proof and before the lease update increments attempt_count.
do $rewrite_claim_selector$
declare
  v_signature regprocedure :=
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure;
  v_definition text;
  v_updated text;
  v_marker text := $marker$    where private.truth_shadow_gmail_model_job_allowed_v3(
      p_workspace_key, candidate.job_id
    )$marker$;
  v_replacement text := $replacement$    where private.truth_shadow_gmail_model_job_allowed_v3(
      p_workspace_key, candidate.job_id
    )
      and (
        not private.truth_gmail_live_message_model_job_allowed_v1(
          p_workspace_key,candidate.job_id
        )
        or private.truth_gmail_live_model_child_worker_allowed_v1(
          p_workspace_key,candidate.job_id,p_worker_id,p_processor_version
        )
      )$replacement$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('truth_gmail_live_model_child_worker_allowed_v1' in v_definition)=0 then
    v_updated:=replace(v_definition,v_marker,v_replacement);
    if v_updated=v_definition then
      raise exception 'live model-child claim reservation did not match reviewed selector'
        using errcode='23514';
    end if;
    execute v_updated;
  end if;
end;
$rewrite_claim_selector$;

create or replace function private.truth_gmail_live_hosted_model_child_failure_v1(
  p_error_code text,p_safe_error_detail text,p_processor_version text
) returns boolean
language plpgsql immutable set search_path=''
as $function$
declare v_detail jsonb;
begin
  if p_error_code<>'MODEL_RUNTIME_DISABLED'
    or p_processor_version<>'hosted-truth-shadow-runtime-v2:gmail-model-claim-v1'
    or coalesce(p_safe_error_detail,'')='' then return false; end if;
  v_detail:=p_safe_error_detail::jsonb;
  return jsonb_typeof(v_detail)='object'
    and v_detail->>'schemaVersion'='truth-model-local-pending-v1'
    and v_detail->>'reasonCode'='MODEL_RUNTIME_DISABLED'
    and coalesce(v_detail->>'modelPlanId','')~'^gmail-model-plan:v1:[0-9a-f]{64}$'
    and coalesce(v_detail->>'sourceObservationId','')~'^obs:v1:[0-9a-f]{64}$';
exception when others then return false;
end;
$function$;

revoke all on function private.truth_gmail_live_hosted_model_child_failure_v1(
  text,text,text
) from public,anon,authenticated,service_role;

create unique index if not exists
  truth_gmail_live_model_child_activations_workspace_activation_key
  on public.truth_gmail_live_model_child_activations(workspace_key,activation_id);

create table if not exists public.truth_gmail_live_model_child_worker_race_recoveries (
  recovery_id text primary key check(
    recovery_id='truth-gmail-live-model-child-worker-race:v1:'||recovery_hash
  ),
  recovery_hash text not null unique check(recovery_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  model_child_job_id uuid not null unique,
  parent_job_id uuid not null,
  root_batch_id uuid not null,
  activation_id text not null unique,
  prior_state text not null check(prior_state='retry_wait'),
  prior_attempt_count integer not null check(prior_attempt_count between 1 and 100),
  prior_max_attempts integer not null check(prior_max_attempts>=prior_attempt_count),
  authorized_max_attempts integer not null check(
    authorized_max_attempts>=prior_attempt_count+3
  ),
  prior_lease_fence bigint not null check(prior_lease_fence>=prior_attempt_count),
  prior_processor_version text not null check(
    prior_processor_version='hosted-truth-shadow-runtime-v2:gmail-model-claim-v1'
  ),
  prior_error_code text not null check(prior_error_code='MODEL_RUNTIME_DISABLED'),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  canonical_recovery jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-model-child-worker-race-recovery-v1'
  ),
  production_publication_attempted boolean not null default false
    check(production_publication_attempted=false),
  recovered_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,model_child_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,parent_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,activation_id)
    references public.truth_gmail_live_model_child_activations(workspace_key,activation_id)
    on update restrict on delete restrict,
  check(recovery_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_recovery),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_recovery->>'workspaceKey'=workspace_key),
  check(canonical_recovery->>'connectionKey'=connection_key),
  check(canonical_recovery->>'modelChildJobId'=model_child_job_id::text),
  check(canonical_recovery->>'parentJobId'=parent_job_id::text),
  check(canonical_recovery->>'rootBatchId'=root_batch_id::text),
  check(canonical_recovery->>'activationId'=activation_id),
  check((canonical_recovery->>'priorAttemptCount')::integer=prior_attempt_count),
  check((canonical_recovery->>'authorizedMaxAttempts')::integer=authorized_max_attempts),
  check(canonical_recovery->>'reasonCode'='HOSTED_MODEL_OFF_WORKER_CLAIMED_LIVE_CHILD'),
  check(canonical_recovery->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_model_child_worker_race_recoveries_immutable
  on public.truth_gmail_live_model_child_worker_race_recoveries;
create trigger truth_gmail_live_model_child_worker_race_recoveries_immutable
before update or delete on public.truth_gmail_live_model_child_worker_race_recoveries
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_model_child_worker_race_recoveries enable row level security;
alter table public.truth_gmail_live_model_child_worker_race_recoveries force row level security;
revoke all on public.truth_gmail_live_model_child_worker_race_recoveries
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_model_child_worker_race_recoveries to service_role;

do $recover_worker_races$
declare
  v_job record;
  v_body jsonb;
  v_hash text;
  v_max integer;
  v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_job in
    select job.*,lineage.parent_job_id,lineage.root_batch_id,
      activation.activation_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key
     and lineage.source_system=job.source_system
     and lineage.connection_key=job.connection_key
     and lineage.job_id=job.job_id
    join public.truth_gmail_live_model_child_activations activation
      on activation.workspace_key=job.workspace_key
     and activation.model_child_job_id=job.job_id
     and activation.parent_job_id=lineage.parent_job_id
     and activation.root_batch_id=lineage.root_batch_id
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_extract_message_model_claims'
      and job.state='retry_wait'
      and job.attempt_count>0
      and job.attempt_count<job.max_attempts
      and job.lease_owner is null
      and job.lease_expires_at is null
      and job.result='{}'::jsonb
      and job.payload->>'rootBatchId'=lineage.root_batch_id::text
      and job.payload->>'parentJobId'=lineage.parent_job_id::text
      and activation.production_publication_attempted=false
      and private.truth_gmail_live_message_model_job_allowed_v1(
        job.workspace_key,job.job_id
      )
      and private.truth_gmail_live_hosted_model_child_failure_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      )
      and not exists(select 1 from public.truth_model_requests request
        where request.workspace_key=job.workspace_key
          and request.source_job_id=job.job_id)
      and not exists(select 1
        from public.truth_gmail_live_model_child_worker_race_recoveries prior
        where prior.model_child_job_id=job.job_id)
    order by job.job_id
    for update of job
  loop
    v_max:=greatest(v_job.max_attempts,v_job.attempt_count+3);
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-live-model-child-worker-race-recovery-v1',
      'workspaceKey',v_job.workspace_key,
      'connectionKey',v_job.connection_key,
      'modelChildJobId',v_job.job_id,
      'parentJobId',v_job.parent_job_id,
      'rootBatchId',v_job.root_batch_id,
      'activationId',v_job.activation_id,
      'priorState',v_job.state,
      'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_max,
      'priorLeaseFence',v_job.lease_fence,
      'priorProcessorVersion',v_job.processor_version,
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'
      ),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'
      ),'sha256'),'hex'),
      'reasonCode','HOSTED_MODEL_OFF_WORKER_CLAIMED_LIVE_CHILD',
      'claimedOnlyBy','primary-message-model-drain:claims:'||v_job.root_batch_id::text,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_live_model_child_worker_race_recoveries(
      recovery_id,recovery_hash,workspace_key,connection_key,
      model_child_job_id,parent_job_id,root_batch_id,activation_id,
      prior_state,prior_attempt_count,prior_max_attempts,authorized_max_attempts,
      prior_lease_fence,prior_processor_version,prior_error_code,
      prior_error_detail_hash,prior_payload_hash,canonical_recovery,
      schema_version
    ) values(
      'truth-gmail-live-model-child-worker-race:v1:'||v_hash,v_hash,
      v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.parent_job_id,
      v_job.root_batch_id,v_job.activation_id,v_job.state,v_job.attempt_count,
      v_job.max_attempts,v_max,v_job.lease_fence,v_job.processor_version,
      v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body,
      'truth-gmail-live-model-child-worker-race-recovery-v1'
    );
    update public.source_processing_jobs job set
      state='retry_wait',
      max_attempts=v_max,
      available_at=clock_timestamp(),
      lease_owner=null,
      lease_expires_at=null,
      completed_at=null,
      last_error_code='GMAIL_LIVE_MODEL_CHILD_WORKER_RACE_RECOVERED',
      safe_error_detail='Hosted model-off attempts are receipted; only the exact batch-scoped tracked model-on claims worker may lease this child.',
      updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key
      and job.job_id=v_job.job_id
      and job.state=v_job.state
      and job.attempt_count=v_job.attempt_count
      and job.max_attempts=v_job.max_attempts
      and job.lease_fence=v_job.lease_fence
      and job.processor_version=v_job.processor_version
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.payload=v_job.payload
      and job.result='{}'::jsonb
      and job.lease_owner is null
      and job.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'live model-child worker-race recovery fence changed'
        using errcode='40001';
    end if;
  end loop;
end;
$recover_worker_races$;

analyze public.truth_gmail_live_model_child_worker_race_recoveries;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_live_model_child_worker_allowed_v1' in v_definition)=0
    or position('truth_gmail_live_message_model_job_allowed_v1' in v_definition)=0
    or position('truth_gmail_live_commissioned_parent_worker_allowed_v1' in v_definition)=0 then
    raise exception 'primary parent/child claim reservation chain is incomplete'
      using errcode='55000';
  end if;
  if exists(
    select 1
    from public.source_processing_jobs job
    join public.truth_gmail_live_model_child_activations activation
      on activation.workspace_key=job.workspace_key
     and activation.model_child_job_id=job.job_id
    where job.workspace_key='primary'
      and job.state='retry_wait'
      and job.attempt_count>0
      and private.truth_gmail_live_hosted_model_child_failure_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      )
      and not exists(select 1
        from public.truth_gmail_live_model_child_worker_race_recoveries recovery
        where recovery.model_child_job_id=job.job_id)
  ) then
    raise exception 'eligible hosted model-child worker race remained unrecovered'
      using errcode='55000';
  end if;
  if exists(select 1
      from public.truth_gmail_live_model_child_worker_race_recoveries recovery
      where recovery.production_publication_attempted
        or recovery.canonical_recovery->>'productionPublicationAttempted'<>'false') then
    raise exception 'model-child worker-race recovery attempted publication'
      using errcode='55000';
  end if;
  if has_table_privilege(
      'anon','public.truth_gmail_live_model_child_worker_race_recoveries','SELECT'
    )
    or has_table_privilege(
      'authenticated','public.truth_gmail_live_model_child_worker_race_recoveries','SELECT'
    )
    or has_table_privilege(
      'service_role','public.truth_gmail_live_model_child_worker_race_recoveries',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'model-child worker-race recovery ledger ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

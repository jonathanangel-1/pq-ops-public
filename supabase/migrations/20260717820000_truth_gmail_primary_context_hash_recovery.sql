-- Repair the exact empty-output parent exhausted by the accepted-claim
-- microsecond hash mismatch. Retire the consumed v2 one-run route and admit
-- one new v3 call under a new secret digest and worker identity. This migration
-- does not call a model, accept a claim, cut a source, build, publish, send
-- Gmail, or mutate freight operations.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_v2_definition text;
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.truth_gmail_live_parent_one_run_authorizations') is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_v1(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'
    ) is null
    or to_regprocedure(
      'private.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'context-hash parent recovery prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v2_definition;
  if position('one-run primary commissioned parent token refused' in v_v2_definition)=0
    and position('primary commissioned parent sealer v2 retired' in v_v2_definition)=0 then
    raise exception 'one-run parent sealer v2 differs from reviewed authority'
      using errcode='23514';
  end if;
end;
$preflight$;

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
      and p_processor_version=
        'primary-message-model-drain-v1:parents-v6-ba915833'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

create or replace function private.truth_gmail_live_parent_v5_context_hash_timeout_v1(
  p_error_code text,p_safe_error_detail text,p_processor_version text
) returns boolean
language plpgsql immutable set search_path=''
as $function$
declare v_detail jsonb;
begin
  if p_error_code<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or p_processor_version<>'primary-message-model-drain-v1:parents-v5-f4a81077'
    or coalesce(p_safe_error_detail,'')='' then return false; end if;
  v_detail:=p_safe_error_detail::jsonb;
  return jsonb_typeof(v_detail)='object'
    and v_detail->>'schemaVersion'='truth-gmail-parent-planning-failure-v2'
    and v_detail->>'errorCode'='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingCode'='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingMessage'=
      'seal Gmail parent extraction plan failed: Supabase RPC failed: seal_gmail_primary_commissioned_model_extraction_plan_v2 504'
    and v_detail->>'postgresCode'=''
    and v_detail->>'postgresMessage'=
      'Supabase RPC failed: seal_gmail_primary_commissioned_model_extraction_plan_v2 504'
    and v_detail->>'postgresDetail'=''
    and v_detail->>'jobKind'='gmail_extract_message_claims';
exception when others then return false;
end;
$function$;

revoke all on function private.truth_gmail_live_parent_v5_context_hash_timeout_v1(
  text,text,text
) from public,anon,authenticated,service_role;

do $one_run_tenant_key$
begin
  if not exists(
    select 1 from pg_constraint
    where conname='truth_gmail_live_parent_one_run_authorizations_workspace_id_key'
      and conrelid='public.truth_gmail_live_parent_one_run_authorizations'::regclass
  ) then
    alter table public.truth_gmail_live_parent_one_run_authorizations
      add constraint truth_gmail_live_parent_one_run_authorizations_workspace_id_key
      unique(workspace_key,authorization_id);
  end if;
end;
$one_run_tenant_key$;

create table if not exists public.truth_gmail_live_parent_context_hash_recoveries (
  recovery_id text primary key check(
    recovery_id='truth-gmail-live-parent-context-hash-recovery:v1:'||recovery_hash
  ),
  recovery_hash text not null unique check(recovery_hash~'^[0-9a-f]{64}$'),
  run_token_hash text not null check(run_token_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  replay_id text not null,
  prior_authorization_id text not null,
  prior_state text not null check(prior_state='dead_letter'),
  prior_attempt_count integer not null check(prior_attempt_count>=1),
  prior_max_attempts integer not null check(prior_max_attempts=prior_attempt_count),
  authorized_max_attempts integer not null check(
    authorized_max_attempts=prior_attempt_count+1
  ),
  prior_lease_fence bigint not null check(prior_lease_fence>=prior_attempt_count),
  prior_processor_version text not null check(
    prior_processor_version='primary-message-model-drain-v1:parents-v5-f4a81077'
  ),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v6-ba915833'
  ),
  prior_error_code text not null check(
    prior_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  canonical_recovery jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-parent-context-hash-recovery-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  authorized_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,prior_authorization_id)
    references public.truth_gmail_live_parent_one_run_authorizations(
      workspace_key,authorization_id
    )
    on update restrict on delete restrict,
  check(recovery_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_recovery),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_recovery->>'schemaVersion'=schema_version),
  check(canonical_recovery->>'workspaceKey'=workspace_key),
  check(canonical_recovery->>'connectionKey'=connection_key),
  check(canonical_recovery->>'sourceJobId'=source_job_id::text),
  check(canonical_recovery->>'rootBatchId'=root_batch_id::text),
  check(canonical_recovery->>'replayId'=replay_id),
  check(canonical_recovery->>'priorAuthorizationId'=prior_authorization_id),
  check(canonical_recovery->>'runTokenHash'=run_token_hash),
  check((canonical_recovery->>'priorAttemptCount')::integer=prior_attempt_count),
  check((canonical_recovery->>'authorizedMaxAttempts')::integer=authorized_max_attempts),
  check(canonical_recovery->>'reasonCode'='ACCEPTED_CLAIM_MICROSECOND_HASH_MISMATCH'),
  check(canonical_recovery->>'activeProcessorVersion'=active_processor_version),
  check(canonical_recovery->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_parent_context_hash_recoveries_immutable
  on public.truth_gmail_live_parent_context_hash_recoveries;
create trigger truth_gmail_live_parent_context_hash_recoveries_immutable
before update or delete on public.truth_gmail_live_parent_context_hash_recoveries
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_parent_context_hash_recoveries enable row level security;
alter table public.truth_gmail_live_parent_context_hash_recoveries force row level security;
revoke all on public.truth_gmail_live_parent_context_hash_recoveries
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_parent_context_hash_recoveries to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v2(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='5s' set lock_timeout='1s'
as $function$
begin
  raise exception 'primary commissioned parent sealer v2 retired'
    using errcode='42501';
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v2(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v2(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v3(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
    p_workspace_key,p_job_id,p_worker_id,p_processor_version
  ) then
    raise exception 'context-hash primary commissioned parent worker refused'
      using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_live_parent_context_hash_recoveries recovery
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=recovery.workspace_key
       and lineage.job_id=recovery.source_job_id
       and lineage.root_batch_id=recovery.root_batch_id
      join public.truth_shadow_gmail_model_commissioning_replays replay
        on replay.workspace_key=recovery.workspace_key
       and replay.replay_id=recovery.replay_id
       and replay.successor_parent_job_id=recovery.source_job_id
      join public.source_processing_jobs job
        on job.workspace_key=recovery.workspace_key
       and job.job_id=recovery.source_job_id
      where recovery.workspace_key=p_workspace_key
        and recovery.source_job_id=p_job_id
        and recovery.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and recovery.active_processor_version=p_processor_version
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence
        and job.attempt_count=recovery.prior_attempt_count+1
        and job.max_attempts=recovery.authorized_max_attempts
        and job.processor_version=p_processor_version
        and encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.payload),'UTF8'
        ),'sha256'),'hex')=recovery.prior_payload_hash
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
    raise exception 'context-hash primary commissioned parent token refused'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v3(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v3(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $authorize_context_hash_recovery$
declare v_job record; v_body jsonb; v_hash text; v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_job in
    select job.*,lineage.root_batch_id,replay.replay_id,
      prior.authorization_id as prior_authorization_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_shadow_gmail_model_commissioning_replays replay
      on replay.workspace_key=job.workspace_key
     and replay.successor_parent_job_id=job.job_id
    join public.truth_gmail_live_parent_one_run_authorizations prior
      on prior.workspace_key=job.workspace_key and prior.source_job_id=job.job_id
     and prior.active_processor_version=job.processor_version
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter' and job.attempt_count=job.max_attempts
      and job.result='{}'::jsonb and job.completed_at is not null
      and job.lease_owner is null and job.lease_expires_at is null
      and private.truth_gmail_live_parent_v5_context_hash_timeout_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      )
      and private.truth_gmail_live_commissioned_parent_v1(job.workspace_key,job.job_id)
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
      and not exists(select 1 from public.truth_gmail_live_parent_context_hash_recoveries prior_recovery
        where prior_recovery.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-live-parent-context-hash-recovery-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'rootBatchId',v_job.root_batch_id,
      'replayId',v_job.replay_id,'priorAuthorizationId',v_job.prior_authorization_id,
      'priorState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_job.attempt_count+1,
      'priorLeaseFence',v_job.lease_fence,
      'priorProcessorVersion',v_job.processor_version,
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v6-ba915833',
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000001',
      'reasonCode','ACCEPTED_CLAIM_MICROSECOND_HASH_MISMATCH',
      'retiredRpc','seal_gmail_primary_commissioned_model_extraction_plan_v2',
      'activeRpc','seal_gmail_primary_commissioned_model_extraction_plan_v3',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_live_parent_context_hash_recoveries(
      recovery_id,recovery_hash,run_token_hash,workspace_key,connection_key,
      source_job_id,root_batch_id,replay_id,prior_authorization_id,prior_state,
      prior_attempt_count,prior_max_attempts,authorized_max_attempts,
      prior_lease_fence,prior_processor_version,active_processor_version,
      prior_error_code,prior_error_detail_hash,prior_payload_hash,
      canonical_recovery,schema_version
    ) values(
      'truth-gmail-live-parent-context-hash-recovery:v1:'||v_hash,v_hash,
      v_body->>'runTokenHash',v_job.workspace_key,v_job.connection_key,
      v_job.job_id,v_job.root_batch_id,v_job.replay_id,v_job.prior_authorization_id,
      v_job.state,v_job.attempt_count,v_job.max_attempts,v_job.attempt_count+1,
      v_job.lease_fence,v_job.processor_version,
      'primary-message-model-drain-v1:parents-v6-ba915833',
      v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body,
      'truth-gmail-live-parent-context-hash-recovery-v1'
    );
    update public.source_processing_jobs job set
      state='retry_wait',max_attempts=v_job.attempt_count+1,
      available_at=clock_timestamp(),lease_owner=null,lease_expires_at=null,
      completed_at=null,last_error_code='GMAIL_LIVE_PARENT_CONTEXT_HASH_REPAIR_AUTHORIZED',
      safe_error_detail=
        'The empty-output v2 context-hash refusal is receipted; the v3 one-run route owns one microsecond-safe recovery.',
      updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state=v_job.state and job.attempt_count=v_job.attempt_count
      and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.processor_version=v_job.processor_version
      and job.result='{}'::jsonb and job.lease_owner is null
      and job.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then raise exception 'context-hash parent recovery fence changed'
      using errcode='40001'; end if;
  end loop;
end;
$authorize_context_hash_recovery$;

do $verify$
declare v_worker text; v_v2 text; v_v3 text;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v2;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v3(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v3;
  if position('parents-v6-ba915833' in v_worker)=0
    or position('parents-v5-f4a81077' in v_worker)>0
    or position('primary commissioned parent sealer v2 retired' in v_v2)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v2)>0
    or position('context-hash primary commissioned parent token refused' in v_v3)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v3)=0 then
    raise exception 'context-hash parent recovery authority is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and private.truth_gmail_live_parent_v5_context_hash_timeout_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      ) and private.truth_gmail_live_commissioned_parent_v1(
        job.workspace_key,job.job_id
      )) then
    raise exception 'eligible context-hash parent remained dead-lettered'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_live_parent_context_hash_recoveries recovery
    where recovery.production_publication_attempted
      or recovery.canonical_recovery->>'productionPublicationAttempted'<>'false') then
    raise exception 'context-hash recovery attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v3(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v3(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v3(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_live_parent_context_hash_recoveries',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'context-hash parent recovery ACL is unsafe' using errcode='55000';
  end if;
end;
$verify$;

analyze public.source_processing_jobs;
analyze public.truth_gmail_live_parent_context_hash_recoveries;

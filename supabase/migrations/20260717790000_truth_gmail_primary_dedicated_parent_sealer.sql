-- Separate the primary commissioned parent sealer from the legacy PostgREST
-- route still being called by a stale background client. The legacy route
-- remains available for ordinary hosted parents but refuses all commissioned
-- parents. Recover only the exact empty-output parents-v2 504 dead-letter
-- class through an immutable receipt. No model call, claim acceptance, source
-- cut, build, publication, Gmail send, or TMS/manual mutation occurs here.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_worker_definition text; v_legacy_seal_definition text;
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.truth_gmail_live_parent_worker_handoffs') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
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
      'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'dedicated primary parent sealer prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker_definition;
  select pg_get_functiondef(
    'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_legacy_seal_definition;
  if position('primary-message-model-drain-v1:parents-v2' in v_worker_definition)=0
    and position('primary-message-model-drain-v1:parents-v3' in v_worker_definition)=0 then
    raise exception 'primary parent worker differs from reviewed handoff'
      using errcode='23514';
  end if;
  if position('truth_gmail_live_commissioned_parent_worker_allowed_v1' in v_legacy_seal_definition)=0
    and position('primary commissioned parent requires dedicated sealer' in v_legacy_seal_definition)=0 then
    raise exception 'legacy Gmail plan sealer differs from reviewed handoff'
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
      and p_processor_version='primary-message-model-drain-v1:parents-v3'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

-- Ordinary hosted parent workers keep the legacy route. Every primary
-- commissioned parent is rejected before the old route reaches the private
-- mutating sealer, regardless of its worker version.
create or replace function public.seal_gmail_model_extraction_plan(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if private.truth_gmail_live_commissioned_parent_v1(
    p_workspace_key,p_job_id
  ) then
    raise exception 'primary commissioned parent requires dedicated sealer'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_model_extraction_plan(
  text,uuid,text,bigint,text,jsonb,integer,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v1(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='60s' set lock_timeout='30s'
as $function$
begin
  if not private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
    p_workspace_key,p_job_id,p_worker_id,p_processor_version
  ) then
    raise exception 'dedicated primary commissioned parent worker refused'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v1(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v1(
  text,uuid,text,bigint,text,jsonb,integer,text
) to service_role;

create or replace function private.truth_gmail_live_parent_route_timeout_v1(
  p_error_code text,p_safe_error_detail text,p_processor_version text
) returns boolean
language plpgsql immutable set search_path=''
as $function$
declare v_detail jsonb;
begin
  if p_error_code<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or p_processor_version<>'primary-message-model-drain-v1:parents-v2'
    or coalesce(p_safe_error_detail,'')='' then return false; end if;
  v_detail:=p_safe_error_detail::jsonb;
  return jsonb_typeof(v_detail)='object'
    and v_detail->>'schemaVersion'='truth-gmail-parent-planning-failure-v2'
    and v_detail->>'errorCode'='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingCode'='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingMessage'=
      'seal Gmail parent extraction plan failed: Supabase RPC failed: seal_gmail_model_extraction_plan 504'
    and v_detail->>'postgresCode'=''
    and v_detail->>'postgresMessage'=
      'Supabase RPC failed: seal_gmail_model_extraction_plan 504'
    and v_detail->>'postgresDetail'=''
    and v_detail->>'jobKind'='gmail_extract_message_claims';
exception when others then return false;
end;
$function$;

revoke all on function private.truth_gmail_live_parent_route_timeout_v1(
  text,text,text
) from public,anon,authenticated,service_role;

create table if not exists public.truth_gmail_live_parent_seal_route_recoveries (
  recovery_id text primary key check(
    recovery_id='truth-gmail-live-parent-seal-route-recovery:v1:'||recovery_hash
  ),
  recovery_hash text not null unique check(recovery_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  replay_id text not null,
  prior_state text not null check(prior_state='dead_letter'),
  prior_attempt_count integer not null check(prior_attempt_count>=1),
  prior_max_attempts integer not null check(prior_max_attempts=prior_attempt_count),
  authorized_max_attempts integer not null check(
    authorized_max_attempts>=prior_attempt_count+3
  ),
  prior_lease_fence bigint not null check(prior_lease_fence>=prior_attempt_count),
  prior_processor_version text not null check(
    prior_processor_version='primary-message-model-drain-v1:parents-v2'
  ),
  prior_error_code text not null check(
    prior_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  canonical_recovery jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-parent-seal-route-recovery-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  recovered_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
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
  check((canonical_recovery->>'priorAttemptCount')::integer=prior_attempt_count),
  check((canonical_recovery->>'authorizedMaxAttempts')::integer=authorized_max_attempts),
  check(canonical_recovery->>'reasonCode'='LEGACY_SEAL_ROUTE_STARVATION'),
  check(canonical_recovery->>'dedicatedProcessorVersion'=
    'primary-message-model-drain-v1:parents-v3'),
  check(canonical_recovery->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_parent_seal_route_recoveries_immutable
  on public.truth_gmail_live_parent_seal_route_recoveries;
create trigger truth_gmail_live_parent_seal_route_recoveries_immutable
before update or delete on public.truth_gmail_live_parent_seal_route_recoveries
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_parent_seal_route_recoveries enable row level security;
alter table public.truth_gmail_live_parent_seal_route_recoveries force row level security;
revoke all on public.truth_gmail_live_parent_seal_route_recoveries
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_parent_seal_route_recoveries to service_role;

do $recover_route_timeouts$
declare v_job record; v_body jsonb; v_hash text; v_max integer; v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_job in
    select job.*,lineage.root_batch_id,replay.replay_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_shadow_gmail_model_commissioning_replays replay
      on replay.workspace_key=job.workspace_key
     and replay.successor_parent_job_id=job.job_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter' and job.attempt_count=job.max_attempts
      and job.result='{}'::jsonb and job.completed_at is not null
      and job.lease_owner is null and job.lease_expires_at is null
      and private.truth_gmail_live_parent_route_timeout_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      )
      and private.truth_gmail_live_commissioned_parent_v1(job.workspace_key,job.job_id)
      and exists(select 1 from public.truth_gmail_live_parent_worker_handoffs handoff
        where handoff.workspace_key=job.workspace_key
          and handoff.active_processor_version=
            'primary-message-model-drain-v1:parents-v2')
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
      and not exists(select 1 from public.truth_gmail_live_parent_seal_route_recoveries prior
        where prior.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_max:=greatest(v_job.max_attempts,v_job.attempt_count+3);
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-live-parent-seal-route-recovery-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'rootBatchId',v_job.root_batch_id,
      'replayId',v_job.replay_id,'priorState',v_job.state,
      'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
      'authorizedMaxAttempts',v_max,'priorLeaseFence',v_job.lease_fence,
      'priorProcessorVersion',v_job.processor_version,
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'reasonCode','LEGACY_SEAL_ROUTE_STARVATION',
      'dedicatedRpc','seal_gmail_primary_commissioned_model_extraction_plan_v1',
      'dedicatedProcessorVersion','primary-message-model-drain-v1:parents-v3',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_live_parent_seal_route_recoveries(
      recovery_id,recovery_hash,workspace_key,connection_key,source_job_id,
      root_batch_id,replay_id,prior_state,prior_attempt_count,prior_max_attempts,
      authorized_max_attempts,prior_lease_fence,prior_processor_version,
      prior_error_code,prior_error_detail_hash,prior_payload_hash,
      canonical_recovery,schema_version
    ) values(
      'truth-gmail-live-parent-seal-route-recovery:v1:'||v_hash,v_hash,
      v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.root_batch_id,
      v_job.replay_id,v_job.state,v_job.attempt_count,v_job.max_attempts,v_max,
      v_job.lease_fence,v_job.processor_version,v_job.last_error_code,
      v_body->>'priorErrorDetailHash',v_body->>'priorPayloadHash',v_body,
      'truth-gmail-live-parent-seal-route-recovery-v1'
    );
    update public.source_processing_jobs job set
      state='retry_wait',max_attempts=v_max,available_at=clock_timestamp(),
      lease_owner=null,lease_expires_at=null,completed_at=null,
      last_error_code='GMAIL_LIVE_PARENT_SEAL_ROUTE_RECOVERED',
      safe_error_detail=
        'The empty-output legacy-route 504 is receipted; the dedicated parents-v3 sealer owns the bounded recovery.',
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
    if v_updated<>1 then raise exception 'parent seal-route recovery fence changed'
      using errcode='40001'; end if;
  end loop;
end;
$recover_route_timeouts$;

do $verify$
declare v_worker_definition text; v_legacy_definition text; v_dedicated_definition text;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker_definition;
  select pg_get_functiondef(
    'public.seal_gmail_model_extraction_plan(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_legacy_definition;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_dedicated_definition;
  if position('primary-message-model-drain-v1:parents-v3' in v_worker_definition)=0
    or position('primary commissioned parent requires dedicated sealer' in v_legacy_definition)=0
    or position('dedicated primary commissioned parent worker refused' in v_dedicated_definition)=0
    or position('private.seal_gmail_model_extraction_plan' in v_dedicated_definition)=0 then
    raise exception 'dedicated primary commissioned parent sealer is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='dead_letter'
      and private.truth_gmail_live_parent_route_timeout_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      ) and private.truth_gmail_live_commissioned_parent_v1(
        job.workspace_key,job.job_id
      )) then
    raise exception 'eligible parent seal-route 504 remained dead-lettered'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_live_parent_seal_route_recoveries recovery
    where recovery.production_publication_attempted
      or recovery.canonical_recovery->>'productionPublicationAttempted'<>'false') then
    raise exception 'parent seal-route recovery attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)','EXECUTE'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_live_parent_seal_route_recoveries','INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'dedicated primary sealer ACL is unsafe' using errcode='55000';
  end if;
end;
$verify$;

analyze public.source_processing_jobs;
analyze public.truth_gmail_live_parent_seal_route_recoveries;

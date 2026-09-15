-- Retire the copyable dedicated parent-sealer v1 route. Admit one final
-- class-scoped recovery through v2 only when the ordinary sync/lease/worker
-- authority is accompanied by a one-run secret. Only the secret digest is
-- stored. No model call, claim acceptance, source cut, build, publication,
-- Gmail send, or freight mutation occurs in this migration.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_v1_definition text;
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.gmail_model_extraction_plans') is null
    or to_regclass('public.gmail_model_extraction_context_seals') is null
    or to_regclass('public.candidate_claim_job_manifests') is null
    or to_regclass('public.truth_gmail_live_parent_custom_plan_recoveries') is null
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
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'one-run primary Gmail parent sealer prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_v1_definition;
  if position('private.seal_gmail_model_extraction_plan' in v_v1_definition)=0
    and position('primary commissioned parent sealer v1 retired' in v_v1_definition)=0 then
    raise exception 'dedicated parent sealer v1 differs from reviewed authority'
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
        'primary-message-model-drain-v1:parents-v5-f4a81077'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

create or replace function private.truth_gmail_live_parent_v4_timeout_v1(
  p_error_code text,p_safe_error_detail text,p_processor_version text
) returns boolean
language plpgsql immutable set search_path=''
as $function$
declare v_detail jsonb;
begin
  if p_error_code<>'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    or p_processor_version<>'primary-message-model-drain-v1:parents-v4'
    or coalesce(p_safe_error_detail,'')='' then return false; end if;
  v_detail:=p_safe_error_detail::jsonb;
  return jsonb_typeof(v_detail)='object'
    and v_detail->>'schemaVersion'='truth-gmail-parent-planning-failure-v2'
    and v_detail->>'errorCode'='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingCode'='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
    and v_detail->>'underlyingMessage'=
      'seal Gmail parent extraction plan failed: Supabase RPC failed: seal_gmail_primary_commissioned_model_extraction_plan_v1 504'
    and v_detail->>'postgresCode'=''
    and v_detail->>'postgresMessage'=
      'Supabase RPC failed: seal_gmail_primary_commissioned_model_extraction_plan_v1 504'
    and v_detail->>'postgresDetail'=''
    and v_detail->>'jobKind'='gmail_extract_message_claims';
exception when others then return false;
end;
$function$;

revoke all on function private.truth_gmail_live_parent_v4_timeout_v1(
  text,text,text
) from public,anon,authenticated,service_role;

create table if not exists public.truth_gmail_live_parent_one_run_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-gmail-live-parent-one-run-authorization:v1:'
      ||authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  run_token_hash text not null check(run_token_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  replay_id text not null,
  prior_state text not null check(prior_state='retry_wait'),
  prior_attempt_count integer not null check(prior_attempt_count>=1),
  prior_max_attempts integer not null check(prior_max_attempts=prior_attempt_count+1),
  prior_lease_fence bigint not null check(prior_lease_fence>=prior_attempt_count),
  prior_processor_version text not null check(
    prior_processor_version='primary-message-model-drain-v1:parents-v4'
  ),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v5-f4a81077'
  ),
  prior_error_code text not null check(
    prior_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-live-parent-one-run-authorization-v1'
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
  check((canonical_authorization->>'priorAttemptCount')::integer=prior_attempt_count),
  check((canonical_authorization->>'priorMaxAttempts')::integer=prior_max_attempts),
  check(canonical_authorization->>'reasonCode'='COPYABLE_WORKER_IDENTITY_RETIRED'),
  check(canonical_authorization->>'activeProcessorVersion'=active_processor_version),
  check(canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_live_parent_one_run_authorizations_immutable
  on public.truth_gmail_live_parent_one_run_authorizations;
create trigger truth_gmail_live_parent_one_run_authorizations_immutable
before update or delete on public.truth_gmail_live_parent_one_run_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_live_parent_one_run_authorizations enable row level security;
alter table public.truth_gmail_live_parent_one_run_authorizations force row level security;
revoke all on public.truth_gmail_live_parent_one_run_authorizations
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_live_parent_one_run_authorizations to service_role;

-- The old endpoint is an unconditional tombstone. It cannot reach the private
-- sealer even when a caller copies a current-looking worker identity.
create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v1(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text
)
returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='5s' set lock_timeout='1s'
as $function$
begin
  raise exception 'primary commissioned parent sealer v1 retired'
    using errcode='42501';
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v1(
  text,uuid,text,bigint,text,jsonb,integer,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v1(
  text,uuid,text,bigint,text,jsonb,integer,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v2(
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
    raise exception 'one-run primary commissioned parent worker refused'
      using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_live_parent_one_run_authorizations auth_row
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=auth_row.workspace_key
       and lineage.job_id=auth_row.source_job_id
       and lineage.root_batch_id=auth_row.root_batch_id
      join public.truth_shadow_gmail_model_commissioning_replays replay
        on replay.workspace_key=auth_row.workspace_key
       and replay.replay_id=auth_row.replay_id
       and replay.successor_parent_job_id=auth_row.source_job_id
      join public.source_processing_jobs job
        on job.workspace_key=auth_row.workspace_key
       and job.job_id=auth_row.source_job_id
      where auth_row.workspace_key=p_workspace_key
        and auth_row.source_job_id=p_job_id
        and auth_row.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token,'UTF8'),'sha256'
        ),'hex')
        and auth_row.active_processor_version=p_processor_version
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence
        and job.attempt_count=auth_row.prior_attempt_count+1
        and job.max_attempts=auth_row.prior_max_attempts
        and job.processor_version=p_processor_version
        and encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(job.payload),'UTF8'
        ),'sha256'),'hex')=auth_row.prior_payload_hash
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
    raise exception 'one-run primary commissioned parent token refused'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v2(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v2(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $authorize_one_run$
declare v_job record; v_body jsonb; v_hash text; v_updated integer;
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
      and job.state='retry_wait' and job.attempt_count+1=job.max_attempts
      and job.result='{}'::jsonb and job.completed_at is null
      and job.lease_owner is null and job.lease_expires_at is null
      and private.truth_gmail_live_parent_v4_timeout_v1(
        job.last_error_code,job.safe_error_detail,job.processor_version
      )
      and private.truth_gmail_live_commissioned_parent_v1(job.workspace_key,job.job_id)
      and exists(select 1 from public.truth_gmail_live_parent_custom_plan_recoveries prior
        where prior.workspace_key=job.workspace_key and prior.source_job_id=job.job_id)
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
      and not exists(select 1 from public.truth_gmail_live_parent_one_run_authorizations prior
        where prior.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-live-parent-one-run-authorization-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'rootBatchId',v_job.root_batch_id,
      'replayId',v_job.replay_id,'priorState',v_job.state,
      'priorAttemptCount',v_job.attempt_count,'priorMaxAttempts',v_job.max_attempts,
      'priorLeaseFence',v_job.lease_fence,
      'priorProcessorVersion',v_job.processor_version,
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v5-f4a81077',
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'runTokenHash','0000000000000000000000000000000000000000000000000000000000000002',
      'reasonCode','COPYABLE_WORKER_IDENTITY_RETIRED',
      'retiredRpc','seal_gmail_primary_commissioned_model_extraction_plan_v1',
      'activeRpc','seal_gmail_primary_commissioned_model_extraction_plan_v2',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_live_parent_one_run_authorizations(
      authorization_id,authorization_hash,run_token_hash,workspace_key,
      connection_key,source_job_id,root_batch_id,replay_id,prior_state,
      prior_attempt_count,prior_max_attempts,prior_lease_fence,
      prior_processor_version,active_processor_version,prior_error_code,
      prior_error_detail_hash,prior_payload_hash,canonical_authorization,
      schema_version
    ) values(
      'truth-gmail-live-parent-one-run-authorization:v1:'||v_hash,v_hash,
      v_body->>'runTokenHash',v_job.workspace_key,v_job.connection_key,
      v_job.job_id,v_job.root_batch_id,v_job.replay_id,v_job.state,
      v_job.attempt_count,v_job.max_attempts,v_job.lease_fence,
      v_job.processor_version,
      'primary-message-model-drain-v1:parents-v5-f4a81077',
      v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body,
      'truth-gmail-live-parent-one-run-authorization-v1'
    );
    update public.source_processing_jobs job set
      available_at=clock_timestamp(),
      last_error_code='GMAIL_LIVE_PARENT_ONE_RUN_AUTHORIZED',
      safe_error_detail=
        'The empty-output parents-v4 504 is receipted; the final attempt requires the exact v2 one-run credential.',
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
    if v_updated<>1 then raise exception 'one-run parent authorization fence changed'
      using errcode='40001'; end if;
  end loop;
end;
$authorize_one_run$;

do $verify$
declare v_worker text; v_v1 text; v_v2 text;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v1(text,uuid,text,bigint,text,jsonb,integer,text)'::regprocedure
  ) into v_v1;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v2;
  if position('parents-v5-f4a81077' in v_worker)=0
    or position('parents-v4' in v_worker)>0
    or position('primary commissioned parent sealer v1 retired' in v_v1)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v1)>0
    or position('one-run primary commissioned parent token refused' in v_v2)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v2)=0 then
    raise exception 'one-run parent sealer authority is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_live_parent_one_run_authorizations auth_row
    where auth_row.production_publication_attempted
      or auth_row.canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'one-run parent authorization attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v2(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_live_parent_one_run_authorizations',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'one-run parent sealer ACL is unsafe' using errcode='55000';
  end if;
end;
$verify$;

analyze public.source_processing_jobs;
analyze public.truth_gmail_live_parent_one_run_authorizations;

-- Admit one exact retry for schema-v2 parents whose v5 token artifact was
-- hashed with its generator newline while the runtime correctly supplied the
-- normalized 64-hex credential. The receipt is append-only and attempt-bound.
-- This migration performs no model call, claim acceptance, cut, build,
-- publication, email, or freight mutation.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare v_definition text;
begin
  if to_regclass('public.truth_gmail_model_schema_retry_parent_authorizations') is null
    or to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'
    ) is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'schema-retry token normalization prerequisites are unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_definition;
  if position('schema-v2 retry parent token refused' in v_definition)=0 then
    raise exception 'schema-retry parent v5 differs from reviewed predecessor'
      using errcode='23514';
  end if;
end;
$preflight$;

do $workspace_fk$
begin
  if not exists(
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid=
      'public.truth_gmail_model_schema_retry_parent_authorizations'::regclass
      and constraint_row.conname=
        'truth_gmail_model_schema_retry_parent_auth_workspace_id_key'
  ) then
    alter table public.truth_gmail_model_schema_retry_parent_authorizations
      add constraint truth_gmail_model_schema_retry_parent_auth_workspace_id_key
      unique(workspace_key,authorization_id);
  end if;
end;
$workspace_fk$;

create table if not exists public.truth_gmail_model_schema_retry_token_recoveries (
  recovery_id text primary key check(
    recovery_id='truth-gmail-model-schema-retry-token-recovery:v1:'||recovery_hash
  ),
  recovery_hash text not null unique check(recovery_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='primary'),
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  authorization_id text not null unique,
  prior_state text not null check(prior_state='retry_wait'),
  prior_attempt_count integer not null check(prior_attempt_count=1),
  prior_max_attempts integer not null check(prior_max_attempts>=2),
  prior_lease_fence bigint not null check(prior_lease_fence=1),
  prior_processor_version text not null check(
    prior_processor_version='primary-message-model-drain-v1:parents-v8-d0e09b75'
  ),
  prior_error_code text not null check(
    prior_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
  ),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  token_normalization text not null check(token_normalization='hex64-plus-LF-v1'),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v9-d0e09b75lf'
  ),
  canonical_recovery jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-model-schema-retry-token-recovery-v1'
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
  foreign key(workspace_key,authorization_id)
    references public.truth_gmail_model_schema_retry_parent_authorizations(
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
  check(canonical_recovery->>'authorizationId'=authorization_id),
  check(canonical_recovery->>'tokenNormalization'=token_normalization),
  check(canonical_recovery->>'activeProcessorVersion'=active_processor_version),
  check(canonical_recovery->>'reasonCode'='SEALED_TOKEN_ARTIFACT_TRAILING_LF'),
  check(canonical_recovery->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_model_schema_retry_token_recoveries_immutable
  on public.truth_gmail_model_schema_retry_token_recoveries;
create trigger truth_gmail_model_schema_retry_token_recoveries_immutable
before update or delete on public.truth_gmail_model_schema_retry_token_recoveries
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_model_schema_retry_token_recoveries enable row level security;
alter table public.truth_gmail_model_schema_retry_token_recoveries force row level security;
revoke all on public.truth_gmail_model_schema_retry_token_recoveries
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_model_schema_retry_token_recoveries to service_role;

do $recover$
declare v_row record; v_body jsonb; v_hash text; v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');
  for v_row in
    select job.*,lineage.root_batch_id,auth.authorization_id,
      auth.authorization_hash,auth.run_token_hash
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
    join public.truth_gmail_model_schema_retry_parent_authorizations auth
      on auth.workspace_key=job.workspace_key and auth.source_job_id=job.job_id
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary' and job.job_kind='gmail_extract_message_claims'
      and job.state='retry_wait' and job.attempt_count=1
      and job.max_attempts>=2 and job.lease_fence=1
      and job.lease_owner is null and job.lease_expires_at is null
      and job.completed_at is null and job.result='{}'::jsonb
      and job.processor_version='primary-message-model-drain-v1:parents-v8-d0e09b75'
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'schemaVersion'=
        'truth-gmail-parent-planning-failure-v2'
      and job.safe_error_detail::jsonb->>'underlyingCode'=
        'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and job.safe_error_detail::jsonb->>'postgresCode'='42501'
      and job.safe_error_detail::jsonb->>'postgresMessage'=
        'schema-v2 retry parent token refused'
      and job.safe_error_detail::jsonb->>'jobKind'='gmail_extract_message_claims'
      and auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v8-d0e09b75'
      and auth.run_token_hash=
        '0000000000000000000000000000000000000000000000000000000000000006'
      and lineage.root_batch_id=auth.root_batch_id
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
      and not exists(select 1 from public.truth_gmail_model_schema_retry_token_recoveries prior
        where prior.workspace_key=job.workspace_key and prior.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-schema-retry-token-recovery-v1',
      'workspaceKey',v_row.workspace_key,'connectionKey',v_row.connection_key,
      'sourceJobId',v_row.job_id,'rootBatchId',v_row.root_batch_id,
      'authorizationId',v_row.authorization_id,
      'authorizationHash',v_row.authorization_hash,
      'priorState',v_row.state,'priorAttemptCount',v_row.attempt_count,
      'priorMaxAttempts',v_row.max_attempts,'priorLeaseFence',v_row.lease_fence,
      'priorProcessorVersion',v_row.processor_version,
      'priorErrorCode',v_row.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_row.safe_error_detail,'UTF8'
      ),'sha256'),'hex'),
      'sealedRunTokenHash',v_row.run_token_hash,
      'tokenNormalization','hex64-plus-LF-v1',
      'activeProcessorVersion','primary-message-model-drain-v1:parents-v9-d0e09b75lf',
      'authorizedAttemptCount',2,
      'reasonCode','SEALED_TOKEN_ARTIFACT_TRAILING_LF',
      'modelCallsPerformed',false,'candidateClaimsAutoAccepted',false,
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_model_schema_retry_token_recoveries(
      recovery_id,recovery_hash,workspace_key,connection_key,source_job_id,
      root_batch_id,authorization_id,prior_state,prior_attempt_count,
      prior_max_attempts,prior_lease_fence,prior_processor_version,
      prior_error_code,prior_error_detail_hash,token_normalization,
      active_processor_version,canonical_recovery,schema_version
    ) values(
      'truth-gmail-model-schema-retry-token-recovery:v1:'||v_hash,v_hash,
      v_row.workspace_key,v_row.connection_key,v_row.job_id,v_row.root_batch_id,
      v_row.authorization_id,v_row.state,v_row.attempt_count,v_row.max_attempts,
      v_row.lease_fence,v_row.processor_version,v_row.last_error_code,
      v_body->>'priorErrorDetailHash','hex64-plus-LF-v1',
      'primary-message-model-drain-v1:parents-v9-d0e09b75lf',v_body,
      'truth-gmail-model-schema-retry-token-recovery-v1'
    );
    update public.source_processing_jobs job
    set state='queued',available_at=clock_timestamp(),last_error_code='',
      safe_error_detail='',processor_version='',updated_at=clock_timestamp()
    where job.workspace_key=v_row.workspace_key and job.job_id=v_row.job_id
      and job.state='retry_wait' and job.attempt_count=v_row.attempt_count
      and job.lease_fence=v_row.lease_fence and job.result='{}'::jsonb
      and job.completed_at is null and job.lease_owner is null
      and job.lease_expires_at is null
      and exists(select 1
        from public.truth_gmail_model_schema_retry_token_recoveries recovery
        where recovery.workspace_key=job.workspace_key
          and recovery.source_job_id=job.job_id
          and recovery.recovery_hash=v_hash);
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'schema-retry token recovery could not requeue exact parent'
        using errcode='40001';
    end if;
  end loop;
end;
$recover$;

create or replace function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  p_workspace_key text,p_parent_job_id uuid,p_worker_id text,p_processor_version text
) returns boolean
language sql stable security definer set search_path=''
as $function$
  select exists(
    select 1
    from public.source_processing_job_lineage lineage
    join public.truth_gmail_model_schema_retry_token_recoveries recovery
      on recovery.workspace_key=lineage.workspace_key
     and recovery.source_job_id=lineage.job_id
    where lineage.workspace_key=p_workspace_key and lineage.job_id=p_parent_job_id
      and p_worker_id='primary-message-model-drain:parents:'||lineage.root_batch_id::text
      and p_processor_version=recovery.active_processor_version
      and recovery.active_processor_version=
        'primary-message-model-drain-v1:parents-v9-d0e09b75lf'
      and private.truth_gmail_live_commissioned_parent_v1(
        p_workspace_key,p_parent_job_id
      )
  );
$function$;

revoke all on function private.truth_gmail_live_commissioned_parent_worker_allowed_v1(
  text,uuid,text,text
) from public,anon,authenticated,service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v5(
  p_workspace_key text,p_job_id uuid,p_worker_id text,p_lease_fence bigint,
  p_processor_version text,p_extraction_plan jsonb,p_max_context_items integer,
  p_sync_token text,p_run_token text
) returns jsonb
language plpgsql security definer set search_path=''
set statement_timeout='5s' set lock_timeout='1s'
as $function$
begin
  raise exception 'schema-v2 retry parent sealer v5 retired after token normalization refusal'
    using errcode='42501';
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v5(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v5(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v6(
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
    raise exception 'schema-v2 normalized retry parent worker refused'
      using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_model_schema_retry_token_recoveries recovery
      join public.truth_gmail_model_schema_retry_parent_authorizations auth
        on auth.authorization_id=recovery.authorization_id
       and auth.workspace_key=recovery.workspace_key
       and auth.source_job_id=recovery.source_job_id
      join public.source_processing_jobs job
        on job.workspace_key=recovery.workspace_key and job.job_id=recovery.source_job_id
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=recovery.workspace_key and lineage.job_id=recovery.source_job_id
       and lineage.root_batch_id=recovery.root_batch_id
      where recovery.workspace_key=p_workspace_key and recovery.source_job_id=p_job_id
        and recovery.token_normalization='hex64-plus-LF-v1'
        and recovery.active_processor_version=p_processor_version
        and auth.run_token_hash=encode(extensions.digest(
          convert_to(p_run_token||chr(10),'UTF8'),'sha256'
        ),'hex')
        and job.state='leased' and job.lease_owner=p_worker_id
        and job.lease_fence=p_lease_fence
        and job.attempt_count=recovery.prior_attempt_count+1
        and job.attempt_count=2 and job.processor_version=p_processor_version
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
    raise exception 'schema-v2 normalized retry parent token refused'
      using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v6(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v6(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare v_worker text; v_v5 text; v_v6 text;
begin
  select pg_get_functiondef(
    'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'::regprocedure
  ) into v_worker;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v5(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v5;
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v6(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v6;
  if position('parents-v9-d0e09b75lf' in v_worker)=0
    or position('truth_gmail_model_schema_retry_token_recoveries' in v_worker)=0
    or position('sealer v5 retired after token normalization refusal' in v_v5)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v5)>0
    or position('hex64-plus-LF-v1' in v_v6)=0
    or position('p_run_token||chr(10)' in replace(v_v6,' ',''))=0
    or position('schema-v2 normalized retry parent token refused' in v_v6)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v6)=0 then
    raise exception 'schema-retry token normalization recovery is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_model_schema_retry_token_recoveries recovery
    where recovery.production_publication_attempted
      or recovery.canonical_recovery->>'productionPublicationAttempted'<>'false') then
    raise exception 'schema-retry token normalization attempted publication'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.seal_gmail_primary_commissioned_model_extraction_plan_v6(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.seal_gmail_primary_commissioned_model_extraction_plan_v6(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.seal_gmail_primary_commissioned_model_extraction_plan_v6(text,uuid,text,bigint,text,jsonb,integer,text,text)','EXECUTE'
    ) or has_table_privilege(
      'service_role','public.truth_gmail_model_schema_retry_token_recoveries',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'schema-retry token normalization ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_model_schema_retry_token_recoveries;

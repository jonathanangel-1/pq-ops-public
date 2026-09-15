-- Recover the exact two v12 modality parents whose attempt-two authorization
-- was refused because the canonical claim transition clears safe_error_detail
-- before the seal gate runs. This migration records the pre-lease failure in
-- an immutable receipt and permits attempt three only for that bounded cohort.
-- It performs no model call, candidate acceptance, cut, build, publication,
-- email, or freight mutation.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regprocedure(
      'public.seal_gmail_primary_commissioned_model_extraction_plan_v9(text,uuid,text,bigint,text,jsonb,integer,text,text)'
    ) is null
    or to_regclass('public.truth_gmail_model_modality_collision_retries') is null
    or to_regclass('public.truth_gmail_model_modality_retry_authorizations') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure(
      'private.truth_gmail_live_commissioned_parent_worker_allowed_v1(text,uuid,text,text)'
    ) is null then
    raise exception 'Gmail model modality lease retry prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_model_modality_lease_retries (
  retry_id text primary key check(
    retry_id='truth-gmail-model-modality-lease-retry:v1:'||retry_hash
  ),
  retry_hash text not null unique check(retry_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  authorization_id text not null unique,
  collision_retry_id text not null unique,
  source_job_id uuid not null unique,
  root_batch_id uuid not null,
  attempt_two_failure_safe_detail_hash text not null check(
    attempt_two_failure_safe_detail_hash~'^[0-9a-f]{64}$'
  ),
  run_token_hash text not null check(
    run_token_hash='0000000000000000000000000000000000000000000000000000000000000003'
  ),
  active_processor_version text not null check(
    active_processor_version='primary-message-model-drain-v1:parents-v12-39d43130'
  ),
  authorized_attempt integer not null check(authorized_attempt=3),
  canonical_retry jsonb not null,
  schema_version text not null check(
    schema_version='truth-gmail-model-modality-lease-retry-v1'
  ),
  production_publication_attempted boolean not null default false check(
    production_publication_attempted=false
  ),
  authorized_at timestamptz not null default clock_timestamp(),
  unique(workspace_key,retry_id),
  foreign key(workspace_key,authorization_id)
    references public.truth_gmail_model_modality_retry_authorizations(
      workspace_key,authorization_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key,collision_retry_id)
    references public.truth_gmail_model_modality_collision_retries(
      workspace_key,retry_id
    ) on update restrict on delete restrict,
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,root_batch_id)
    references public.source_ingest_batches(workspace_key,batch_id)
    on update restrict on delete restrict,
  check(retry_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_retry),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_retry->>'schemaVersion'=schema_version),
  check(canonical_retry->>'workspaceKey'=workspace_key),
  check(canonical_retry->>'authorizationId'=authorization_id),
  check(canonical_retry->>'collisionRetryId'=collision_retry_id),
  check(canonical_retry->>'sourceJobId'=source_job_id::text),
  check(canonical_retry->>'rootBatchId'=root_batch_id::text),
  check(canonical_retry->>'attemptTwoFailureSafeDetailHash'=
    attempt_two_failure_safe_detail_hash),
  check(canonical_retry->>'runTokenHash'=run_token_hash),
  check(canonical_retry->>'activeProcessorVersion'=active_processor_version),
  check((canonical_retry->>'authorizedAttempt')::integer=authorized_attempt),
  check(canonical_retry->>'reasonCode'='LEASE_CLEARED_PRIOR_FAILURE_DETAIL'),
  check(canonical_retry->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_model_modality_lease_retries_immutable
  on public.truth_gmail_model_modality_lease_retries;
create trigger truth_gmail_model_modality_lease_retries_immutable
before update or delete on public.truth_gmail_model_modality_lease_retries
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_model_modality_lease_retries enable row level security;
alter table public.truth_gmail_model_modality_lease_retries force row level security;
revoke all on public.truth_gmail_model_modality_lease_retries
  from public,anon,authenticated,service_role;
grant select on public.truth_gmail_model_modality_lease_retries to service_role;

do $authorize_retry$
declare v_row record; v_body jsonb; v_hash text; v_count integer:=0;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'truth-gmail-model-modality-lease-retry-v1',0
  ));
  for v_row in
    select auth.authorization_id,auth.source_job_id,auth.root_batch_id,
      auth.run_token_hash,auth.active_processor_version,
      collision.retry_id as collision_retry_id,
      encode(extensions.digest(convert_to(
        job.safe_error_detail,'UTF8'
      ),'sha256'),'hex') as safe_detail_hash
    from public.truth_gmail_model_modality_retry_authorizations auth
    join public.truth_gmail_model_modality_collision_retries collision
      on collision.workspace_key=auth.workspace_key
     and collision.authorization_id=auth.authorization_id
     and collision.source_job_id=auth.source_job_id
     and collision.root_batch_id=auth.root_batch_id
     and collision.authorized_attempt=2
    join public.source_processing_jobs job
      on job.workspace_key=auth.workspace_key and job.job_id=auth.source_job_id
    where auth.workspace_key='primary'
      and auth.active_processor_version=
        'primary-message-model-drain-v1:parents-v12-39d43130'
      and auth.run_token_hash=
        '0000000000000000000000000000000000000000000000000000000000000003'
      and job.state='retry_wait' and job.attempt_count=2
      and job.processor_version=auth.active_processor_version
      and job.last_error_code='TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and (job.safe_error_detail::jsonb)->>'schemaVersion'=
        'truth-gmail-parent-planning-failure-v2'
      and (job.safe_error_detail::jsonb)->>'underlyingCode'=
        'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED'
      and (job.safe_error_detail::jsonb)->>'postgresCode'='42501'
      and (job.safe_error_detail::jsonb)->>'postgresMessage'=
        'model-modality retry parent token refused'
      and (job.safe_error_detail::jsonb)->>'underlyingMessage'=
        'seal Gmail parent extraction plan failed: model-modality retry parent token refused'
      and collision.production_publication_attempted=false
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
      and not exists(select 1
        from public.truth_gmail_model_modality_lease_retries existing
        where existing.workspace_key=auth.workspace_key
          and existing.source_job_id=auth.source_job_id)
    order by auth.authorization_id
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-model-modality-lease-retry-v1',
      'workspaceKey','primary','authorizationId',v_row.authorization_id,
      'collisionRetryId',v_row.collision_retry_id,
      'sourceJobId',v_row.source_job_id,'rootBatchId',v_row.root_batch_id,
      'attemptTwoFailureSafeDetailHash',v_row.safe_detail_hash,
      'runTokenHash',v_row.run_token_hash,
      'activeProcessorVersion',v_row.active_processor_version,
      'authorizedAttempt',3,'reasonCode','LEASE_CLEARED_PRIOR_FAILURE_DETAIL',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    insert into public.truth_gmail_model_modality_lease_retries(
      retry_id,retry_hash,workspace_key,authorization_id,collision_retry_id,
      source_job_id,root_batch_id,attempt_two_failure_safe_detail_hash,
      run_token_hash,active_processor_version,authorized_attempt,
      canonical_retry,schema_version
    ) values(
      'truth-gmail-model-modality-lease-retry:v1:'||v_hash,v_hash,'primary',
      v_row.authorization_id,v_row.collision_retry_id,v_row.source_job_id,
      v_row.root_batch_id,v_row.safe_detail_hash,v_row.run_token_hash,
      v_row.active_processor_version,3,v_body,
      'truth-gmail-model-modality-lease-retry-v1'
    );
    v_count:=v_count+1;
  end loop;
  if v_count>2 then
    raise exception 'Gmail modality lease retry exceeded bounded cohort'
      using errcode='54000';
  end if;
end;
$authorize_retry$;

create or replace function public.seal_gmail_primary_commissioned_model_extraction_plan_v9(
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
    raise exception 'model-modality retry parent worker refused' using errcode='42501';
  end if;
  if coalesce(p_run_token,'')!~'^[0-9a-f]{64}$'
    or not exists(
      select 1
      from public.truth_gmail_model_modality_retry_authorizations auth
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
        and job.lease_fence=p_lease_fence and job.attempt_count in (1,2,3)
        and job.processor_version=p_processor_version
        and (job.attempt_count=1 or (job.attempt_count=2 and exists(
          select 1 from public.truth_gmail_model_modality_collision_retries retry
          where retry.workspace_key=auth.workspace_key
            and retry.authorization_id=auth.authorization_id
            and retry.source_job_id=job.job_id
            and retry.root_batch_id=auth.root_batch_id
            and retry.authorized_attempt=2
            and retry.run_token_hash=auth.run_token_hash
            and retry.active_processor_version=auth.active_processor_version
            and retry.production_publication_attempted=false
        )) or (job.attempt_count=3 and exists(
          select 1
          from public.truth_gmail_model_modality_lease_retries lease_retry
          join public.truth_gmail_model_modality_collision_retries collision
            on collision.retry_id=lease_retry.collision_retry_id
          where lease_retry.workspace_key=auth.workspace_key
            and lease_retry.authorization_id=auth.authorization_id
            and lease_retry.source_job_id=job.job_id
            and lease_retry.root_batch_id=auth.root_batch_id
            and lease_retry.authorized_attempt=3
            and lease_retry.run_token_hash=auth.run_token_hash
            and lease_retry.active_processor_version=auth.active_processor_version
            and lease_retry.production_publication_attempted=false
            and collision.workspace_key=lease_retry.workspace_key
            and collision.authorization_id=lease_retry.authorization_id
            and collision.source_job_id=lease_retry.source_job_id
            and collision.authorized_attempt=2
            and collision.production_publication_attempted=false
        )))
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
    raise exception 'model-modality retry parent token refused' using errcode='42501';
  end if;
  return private.seal_gmail_model_extraction_plan(
    p_workspace_key,p_job_id,p_worker_id,p_lease_fence,p_processor_version,
    p_extraction_plan,p_max_context_items,p_sync_token
  );
end;
$function$;

revoke all on function public.seal_gmail_primary_commissioned_model_extraction_plan_v9(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.seal_gmail_primary_commissioned_model_extraction_plan_v9(
  text,uuid,text,bigint,text,jsonb,integer,text,text
) to service_role;

do $verify$
declare v_v9 text;
begin
  select pg_get_functiondef(
    'public.seal_gmail_primary_commissioned_model_extraction_plan_v9(text,uuid,text,bigint,text,jsonb,integer,text,text)'::regprocedure
  ) into v_v9;
  if position('truth_gmail_model_modality_lease_retries' in v_v9)=0
    or position('job.attempt_count in (1,2,3)' in v_v9)=0
    or position('job.attempt_count=3' in v_v9)=0
    or position('private.seal_gmail_model_extraction_plan' in v_v9)=0 then
    raise exception 'Gmail model modality lease retry is incomplete'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_gmail_model_modality_lease_retries
    where production_publication_attempted
      or canonical_retry->>'productionPublicationAttempted'<>'false') then
    raise exception 'Gmail model modality lease retry attempted publication'
      using errcode='55000';
  end if;
  if has_table_privilege(
      'service_role','public.truth_gmail_model_modality_lease_retries',
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception 'Gmail model modality lease retry ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

analyze public.truth_gmail_model_modality_lease_retries;

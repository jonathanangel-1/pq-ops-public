-- Restore claim producers whose only failure was a statement timeout while
-- appending/sealing their candidate manifest during the July-19 overload.
-- This is retry authority, never evidence exclusion: the worker must still
-- execute and seal its real candidate set before acceptance can advance.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.truth_pending_acceptance_epoch_manifests') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'Gmail claim statement-timeout retry prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_gmail_claim_statement_timeout_retry_authorizations (
  authorization_id text primary key check (
    authorization_id='truth-gmail-claim-timeout-retry:v1:'||authorization_hash
  ),
  authorization_hash text not null unique check (authorization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check (workspace_key='primary'),
  connection_key text not null check (connection_key='primary'),
  source_job_id uuid not null unique,
  job_kind text not null check (job_kind=any(array[
    'gmail_extract_message_claims','gmail_extract_attachment_claims'
  ])),
  prior_state text not null check (prior_state='dead_letter'),
  prior_attempt_count integer not null check (prior_attempt_count>=0),
  prior_max_attempts integer not null check (prior_max_attempts>0),
  authorized_max_attempts integer not null check (
    authorized_max_attempts>=prior_max_attempts
    and authorized_max_attempts>=prior_attempt_count+3
  ),
  prior_lease_fence bigint not null check (prior_lease_fence>=0),
  prior_error_code text not null check (prior_error_code='TRUTH_CLAIM_JOB_FAILED'),
  prior_error_detail_hash text not null check (prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check (prior_payload_hash~'^[0-9a-f]{64}$'),
  prior_result_hash text not null check (prior_result_hash~'^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null check (jsonb_typeof(canonical_authorization)='object'),
  schema_version text not null check (
    schema_version='truth-gmail-claim-timeout-retry-authorization-v1'
  ),
  production_publication_attempted boolean not null default false
    check (production_publication_attempted=false),
  authorized_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check (authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check (canonical_authorization->>'schemaVersion'=schema_version),
  check (canonical_authorization->>'workspaceKey'=workspace_key),
  check (canonical_authorization->>'connectionKey'=connection_key),
  check (canonical_authorization->>'sourceJobId'=source_job_id::text),
  check (canonical_authorization->>'jobKind'=job_kind),
  check (canonical_authorization->>'priorState'=prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer=prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer=prior_max_attempts),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer=authorized_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint=prior_lease_fence),
  check (canonical_authorization->>'priorErrorCode'=prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash'=prior_error_detail_hash),
  check (canonical_authorization->>'priorPayloadHash'=prior_payload_hash),
  check (canonical_authorization->>'priorResultHash'=prior_result_hash),
  check (canonical_authorization->>'reasonCode'='CLAIM_APPEND_SEAL_STATEMENT_TIMEOUT_RETRY'),
  check (canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_gmail_claim_statement_timeout_retry_authorizations_immutable
  on public.truth_gmail_claim_statement_timeout_retry_authorizations;
create trigger truth_gmail_claim_statement_timeout_retry_authorizations_immutable
before update or delete on public.truth_gmail_claim_statement_timeout_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();
alter table public.truth_gmail_claim_statement_timeout_retry_authorizations enable row level security;
alter table public.truth_gmail_claim_statement_timeout_retry_authorizations force row level security;
revoke all on table public.truth_gmail_claim_statement_timeout_retry_authorizations
  from public,anon,authenticated,service_role;
grant select on table public.truth_gmail_claim_statement_timeout_retry_authorizations
  to service_role;

do $restore$
declare
  v_detail constant text :=
    'append and seal candidate claim job failed: canceling statement due to statement timeout';
  v_job public.source_processing_jobs%rowtype;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_max integer;
  v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');

  for v_job in
    select job.*
    from public.source_processing_jobs job
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind=any(array[
        'gmail_extract_message_claims','gmail_extract_attachment_claims'
      ])
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
      and job.safe_error_detail=v_detail
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
      and not exists(
        select 1
        from public.truth_gmail_claim_statement_timeout_retry_authorizations auth
        where auth.source_job_id=job.job_id
      )
    order by job.job_id
    for update of job
  loop
    v_max:=greatest(v_job.max_attempts,v_job.attempt_count+3);
    v_body:=jsonb_build_object(
      'schemaVersion','truth-gmail-claim-timeout-retry-authorization-v1',
      'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
      'sourceJobId',v_job.job_id,'jobKind',v_job.job_kind,
      'priorState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'authorizedMaxAttempts',v_max,
      'priorLeaseFence',v_job.lease_fence,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(
        convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'priorResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex'),
      'reasonCode','CLAIM_APPEND_SEAL_STATEMENT_TIMEOUT_RETRY',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    v_id:='truth-gmail-claim-timeout-retry:v1:'||v_hash;
    insert into public.truth_gmail_claim_statement_timeout_retry_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,job_kind,prior_state,prior_attempt_count,prior_max_attempts,
      authorized_max_attempts,prior_lease_fence,prior_error_code,
      prior_error_detail_hash,prior_payload_hash,prior_result_hash,
      canonical_authorization,schema_version
    ) values(
      v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
      v_job.job_kind,v_job.state,v_job.attempt_count,v_job.max_attempts,v_max,
      v_job.lease_fence,v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body->>'priorResultHash',v_body,
      'truth-gmail-claim-timeout-retry-authorization-v1'
    );
    update public.source_processing_jobs job
    set state='retry_wait',max_attempts=v_max,available_at=clock_timestamp(),
      lease_owner=null,lease_expires_at=null,completed_at=null,
      last_error_code='TRUTH_CLAIM_STATEMENT_TIMEOUT_RETRY_AUTHORIZED',
      safe_error_detail=
        'The prior claim append/seal attempt timed out during the July-19 overload; bounded retry is authorized.',
      updated_at=clock_timestamp()
    where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
      and job.state='dead_letter'
      and job.attempt_count=v_job.attempt_count and job.max_attempts=v_job.max_attempts
      and job.lease_fence=v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.result='{}'::jsonb
      and job.lease_owner is null and job.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'Gmail claim statement-timeout retry fence changed'
        using errcode='40001';
    end if;
  end loop;
end;
$restore$;

do $verify$
begin
  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind=any(array[
        'gmail_extract_message_claims','gmail_extract_attachment_claims'
      ])
      and job.state='dead_letter'
      and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
      and job.safe_error_detail=
        'append and seal candidate claim job failed: canceling statement due to statement timeout'
  ) or exists(
    select 1
    from public.truth_gmail_claim_statement_timeout_retry_authorizations auth
    where auth.production_publication_attempted
      or auth.canonical_authorization->>'productionPublicationAttempted'<>'false'
  ) then
    raise exception 'Gmail claim statement-timeout retry authorization is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;

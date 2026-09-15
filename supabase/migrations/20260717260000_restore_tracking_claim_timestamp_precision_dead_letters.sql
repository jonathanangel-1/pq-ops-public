-- Restore exhausted tracking claim jobs whose attempts were consumed by the
-- pre-20779b05 millisecond-only capturedAt parser. The immutable observation
-- timestamps were valid Postgres UTC text with 1-6 fractional digits; the
-- extractor contract, not the evidence, was defective.

do $preflight$
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.truth_workspaces') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'tracking timestamp-precision retry prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_tracking_claim_retry_authorizations (
  authorization_id text primary key check (
    authorization_id='truth-tracking-claim-retry:v1:'||authorization_hash
  ),
  authorization_hash text not null unique check (authorization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check (workspace_key='primary'),
  connection_key text not null check (connection_key='carrier-tracking-primary'),
  source_job_id uuid not null unique,
  prior_state text not null check (prior_state='dead_letter'),
  prior_attempt_count integer not null check (prior_attempt_count>=0),
  prior_max_attempts integer not null check (prior_max_attempts>0),
  authorized_max_attempts integer not null check (
    authorized_max_attempts=prior_attempt_count+3
  ),
  prior_lease_fence bigint not null check (prior_lease_fence>=0),
  prior_error_code text not null check (prior_error_code='TRACKING_CLAIM_INVALID_ARGUMENT'),
  prior_error_detail_hash text not null check (prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check (prior_payload_hash~'^[0-9a-f]{64}$'),
  prior_result_hash text not null check (prior_result_hash~'^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null check (jsonb_typeof(canonical_authorization)='object'),
  schema_version text not null check (
    schema_version='truth-tracking-claim-retry-authorization-v1'
  ),
  production_publication_attempted boolean not null default false
    check (production_publication_attempted=false),
  authorized_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  check (authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check (canonical_authorization->>'schemaVersion'=schema_version),
  check (canonical_authorization->>'workspaceKey'=workspace_key),
  check (canonical_authorization->>'connectionKey'=connection_key),
  check (canonical_authorization->>'sourceJobId'=source_job_id::text),
  check (canonical_authorization->>'priorState'=prior_state),
  check ((canonical_authorization->>'priorAttemptCount')::integer=prior_attempt_count),
  check ((canonical_authorization->>'priorMaxAttempts')::integer=prior_max_attempts),
  check ((canonical_authorization->>'authorizedMaxAttempts')::integer=authorized_max_attempts),
  check ((canonical_authorization->>'priorLeaseFence')::bigint=prior_lease_fence),
  check (canonical_authorization->>'priorErrorCode'=prior_error_code),
  check (canonical_authorization->>'priorErrorDetailHash'=prior_error_detail_hash),
  check (canonical_authorization->>'priorPayloadHash'=prior_payload_hash),
  check (canonical_authorization->>'priorResultHash'=prior_result_hash),
  check (canonical_authorization->>'reasonCode'='EXTRACTOR_TIMESTAMP_PRECISION_DEFECT_FIXED_20779B05'),
  check (canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_tracking_claim_retry_authorizations_immutable
  on public.truth_tracking_claim_retry_authorizations;
create trigger truth_tracking_claim_retry_authorizations_immutable
before update or delete on public.truth_tracking_claim_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_tracking_claim_retry_authorizations enable row level security;
alter table public.truth_tracking_claim_retry_authorizations force row level security;
revoke all on table public.truth_tracking_claim_retry_authorizations
  from public,anon,authenticated,service_role;
grant select on table public.truth_tracking_claim_retry_authorizations to service_role;

create index if not exists truth_tracking_claim_retry_authorizations_scope_idx
  on public.truth_tracking_claim_retry_authorizations(
    workspace_key,connection_key,source_job_id
  );

do $restore$
declare
  v_prefix constant text :=
    'Invalid tracking claim extraction observation.capturedAt: must be a canonical UTC timestamp with millisecond precision';
  v_job public.source_processing_jobs%rowtype;
  v_body jsonb;
  v_hash text;
  v_id text;
  v_max integer;
  v_updated integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');

  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary'
      and job.source_system='tracking'
      and job.connection_key='carrier-tracking-primary'
      and job.state='dead_letter'
      and not (
        job.job_kind='tracking_extract_claims'
        and job.last_error_code='TRACKING_CLAIM_INVALID_ARGUMENT'
        and position(v_prefix in job.safe_error_detail)=1
      )
  ) then
    raise exception 'tracking dead-letter exists outside timestamp-precision retry authority'
      using errcode='55000';
  end if;

  for v_job in
    select job.* from public.source_processing_jobs job
    where job.workspace_key='primary'
      and job.source_system='tracking'
      and job.connection_key='carrier-tracking-primary'
      and job.job_kind='tracking_extract_claims'
      and job.state='dead_letter'
      and job.last_error_code='TRACKING_CLAIM_INVALID_ARGUMENT'
      and position(v_prefix in job.safe_error_detail)=1
      and job.lease_owner is null and job.lease_expires_at is null
      and job.completed_at is not null and job.result='{}'::jsonb
      and not exists(select 1 from public.truth_tracking_claim_retry_authorizations auth
        where auth.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_max:=v_job.attempt_count+3;
    v_body:=jsonb_build_object(
      'schemaVersion','truth-tracking-claim-retry-authorization-v1',
      'workspaceKey','primary','connectionKey','carrier-tracking-primary',
      'sourceJobId',v_job.job_id,'jobKind',v_job.job_kind,
      'priorState',v_job.state,'priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'authorizedMaxAttempts',v_max,
      'priorLeaseFence',v_job.lease_fence,'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'priorResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex'),
      'reasonCode','EXTRACTOR_TIMESTAMP_PRECISION_DEFECT_FIXED_20779B05',
      'fixedCommit','20779b05','productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'
    ),'sha256'),'hex');
    v_id:='truth-tracking-claim-retry:v1:'||v_hash;
    insert into public.truth_tracking_claim_retry_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,prior_state,prior_attempt_count,prior_max_attempts,
      authorized_max_attempts,prior_lease_fence,prior_error_code,
      prior_error_detail_hash,prior_payload_hash,prior_result_hash,
      canonical_authorization,schema_version
    ) values(
      v_id,v_hash,'primary','carrier-tracking-primary',v_job.job_id,v_job.state,
      v_job.attempt_count,v_job.max_attempts,v_max,v_job.lease_fence,
      v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body->>'priorResultHash',v_body,
      'truth-tracking-claim-retry-authorization-v1'
    );
    update public.source_processing_jobs job
    set state='retry_wait',max_attempts=v_max,available_at=clock_timestamp(),
      lease_owner=null,lease_expires_at=null,completed_at=null,
      last_error_code='TRACKING_TIMESTAMP_PRECISION_RETRY_AUTHORIZED',
      safe_error_detail=
        'The exhausted attempt was caused by the pre-20779b05 timestamp precision defect; bounded retry is authorized.',
      updated_at=clock_timestamp()
    where job.job_id=v_job.job_id and job.state='dead_letter'
      and job.attempt_count=v_job.attempt_count and job.max_attempts=v_job.max_attempts
      and job.lease_fence=v_job.lease_fence and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail and job.result='{}'::jsonb
      and job.lease_owner is null and job.lease_expires_at is null;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'tracking timestamp-precision retry fence changed'
        using errcode='40001';
    end if;
  end loop;
end;
$restore$;

analyze public.source_processing_jobs;
analyze public.truth_tracking_claim_retry_authorizations;

do $verify$
begin
  if exists(select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='tracking'
      and job.connection_key='carrier-tracking-primary' and job.state='dead_letter') then
    raise exception 'tracking dead-letter remained after timestamp-precision restoration'
      using errcode='55000';
  end if;
  if exists(select 1 from public.truth_tracking_claim_retry_authorizations auth
    where auth.production_publication_attempted
      or auth.canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'tracking retry authority attempted production publication'
      using errcode='55000';
  end if;
  if has_table_privilege('anon','public.truth_tracking_claim_retry_authorizations','SELECT')
    or has_table_privilege('authenticated','public.truth_tracking_claim_retry_authorizations','SELECT')
    or has_table_privilege('service_role','public.truth_tracking_claim_retry_authorizations','INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'tracking retry authorization ACL is unsafe' using errcode='55000';
  end if;
end;
$verify$;

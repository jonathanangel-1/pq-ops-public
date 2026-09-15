-- Restore only the 22 exhausted TMS claim jobs whose attempts were consumed
-- before 8888ca4c preserved the ledger's exact 1-6 digit timestamp text. The
-- immutable observations are valid; this migration grants a bounded retry to
-- the ordinary worker and does not mint candidates, acceptance, or publication.

do $preflight$
begin
  if to_regclass('public.source_processing_jobs') is null
    or to_regclass('public.source_processing_job_lineage') is null
    or to_regclass('public.source_observations') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.truth_source_cut_mutation_lock(text)') is null then
    raise exception 'TMS timestamp-binding retry prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create table if not exists public.truth_tms_claim_timestamp_retry_authorizations (
  authorization_id text primary key check(
    authorization_id='truth-tms-claim-timestamp-retry:v1:'||authorization_hash
  ),
  authorization_hash text not null unique check(authorization_hash~'^[0-9a-f]{64}$'),
  workspace_key text not null references public.truth_workspaces(workspace_key)
    on update restrict on delete restrict check(workspace_key='primary'),
  connection_key text not null check(connection_key='couriercloud-ops-tlv-us'),
  source_job_id uuid not null unique,
  source_observation_id text not null,
  source_observation_content_hash text not null
    check(source_observation_content_hash~'^[0-9a-f]{64}$'),
  source_object_id text not null check(length(source_object_id)>0),
  root_batch_id uuid not null,
  source_cursor_version bigint not null check(source_cursor_version>0),
  source_cursor_value_hash text not null check(source_cursor_value_hash~'^[0-9a-f]{64}$'),
  prior_state text not null check(prior_state='dead_letter'),
  prior_attempt_count integer not null check(prior_attempt_count=5),
  prior_max_attempts integer not null check(prior_max_attempts=5),
  authorized_max_attempts integer not null check(authorized_max_attempts=8),
  prior_lease_fence bigint not null check(prior_lease_fence>=0),
  prior_completed_at timestamptz not null,
  prior_error_code text not null check(prior_error_code='TRUTH_CLAIM_JOB_FAILED'),
  prior_error_detail_hash text not null check(prior_error_detail_hash~'^[0-9a-f]{64}$'),
  prior_payload_hash text not null check(prior_payload_hash~'^[0-9a-f]{64}$'),
  prior_result_hash text not null check(prior_result_hash~'^[0-9a-f]{64}$'),
  canonical_authorization jsonb not null
    check(jsonb_typeof(canonical_authorization)='object'),
  schema_version text not null check(
    schema_version='truth-tms-claim-timestamp-retry-authorization-v1'
  ),
  production_publication_attempted boolean not null default false
    check(production_publication_attempted=false),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_key,source_job_id)
    references public.source_processing_jobs(workspace_key,job_id)
    on update restrict on delete restrict,
  foreign key(workspace_key,source_observation_id)
    references public.source_observations(workspace_key,observation_id)
    on update restrict on delete restrict,
  check(authorization_hash=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(canonical_authorization),'UTF8'
  ),'sha256'),'hex')),
  check(canonical_authorization->>'schemaVersion'=schema_version),
  check(canonical_authorization->>'workspaceKey'=workspace_key),
  check(canonical_authorization->>'connectionKey'=connection_key),
  check(canonical_authorization->>'sourceJobId'=source_job_id::text),
  check(canonical_authorization->>'sourceObservationId'=source_observation_id),
  check(canonical_authorization->>'sourceObservationContentHash'=
    source_observation_content_hash),
  check(canonical_authorization->>'sourceObjectId'=source_object_id),
  check(canonical_authorization->>'rootBatchId'=root_batch_id::text),
  check((canonical_authorization->>'sourceCursorVersion')::bigint=
    source_cursor_version),
  check(canonical_authorization->>'sourceCursorValueHash'=
    source_cursor_value_hash),
  check(canonical_authorization->>'priorState'=prior_state),
  check((canonical_authorization->>'priorAttemptCount')::integer=
    prior_attempt_count),
  check((canonical_authorization->>'priorMaxAttempts')::integer=
    prior_max_attempts),
  check((canonical_authorization->>'authorizedMaxAttempts')::integer=
    authorized_max_attempts),
  check((canonical_authorization->>'priorLeaseFence')::bigint=prior_lease_fence),
  check(canonical_authorization->>'priorCompletedAt'=to_char(
    prior_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )),
  check(canonical_authorization->>'priorErrorCode'=prior_error_code),
  check(canonical_authorization->>'priorErrorDetailHash'=prior_error_detail_hash),
  check(canonical_authorization->>'priorPayloadHash'=prior_payload_hash),
  check(canonical_authorization->>'priorResultHash'=prior_result_hash),
  check(canonical_authorization->>'reasonCode'=
    'TMS_EXACT_TIMESTAMP_BINDING_DEFECT_FIXED_8888CA4C'),
  check(canonical_authorization->>'fixedCommit'=
    '8888ca4c1bab16f66a527cf326993cece7af81dd'),
  check(canonical_authorization->>'productionPublicationAttempted'='false')
);

drop trigger if exists truth_tms_claim_timestamp_retry_authorizations_immutable
  on public.truth_tms_claim_timestamp_retry_authorizations;
create trigger truth_tms_claim_timestamp_retry_authorizations_immutable
before update or delete on public.truth_tms_claim_timestamp_retry_authorizations
for each row execute function public.reject_immutable_truth_mutation();

alter table public.truth_tms_claim_timestamp_retry_authorizations enable row level security;
alter table public.truth_tms_claim_timestamp_retry_authorizations force row level security;
revoke all on public.truth_tms_claim_timestamp_retry_authorizations
  from public,anon,authenticated,service_role;
grant select on public.truth_tms_claim_timestamp_retry_authorizations to service_role;

create index if not exists truth_tms_claim_timestamp_retry_scope_idx
  on public.truth_tms_claim_timestamp_retry_authorizations(
    workspace_key,connection_key,root_batch_id,source_job_id
  );

do $restore$
declare
  v_detail constant text :=
    'append and seal candidate claim job failed: candidate source capture time does not match the observation';
  v_job record;
  v_body jsonb;
  v_hash text;
  v_updated integer;
  v_target_count integer;
begin
  perform private.truth_source_cut_mutation_lock('primary');

  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='tms'
      and job.connection_key='couriercloud-ops-tlv-us'
      and job.state='dead_letter'
      and not(job.job_kind='tms_extract_claims'
        and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
        and job.safe_error_detail=v_detail
        and job.processor_version='hosted-truth-shadow-runtime-v2:tms-claim-v1'
        and job.created_at='2026-07-18T19:08:43.549374Z'::timestamptz)
  ) then
    raise exception 'TMS dead-letter exists outside exact timestamp-binding retry authority'
      using errcode='55000';
  end if;

  select count(*)::integer into v_target_count
  from public.source_processing_jobs job
  where job.workspace_key='primary' and job.source_system='tms'
    and job.connection_key='couriercloud-ops-tlv-us'
    and job.job_kind='tms_extract_claims' and job.state='dead_letter'
    and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
    and job.safe_error_detail=v_detail
    and job.processor_version='hosted-truth-shadow-runtime-v2:tms-claim-v1'
    and job.created_at='2026-07-18T19:08:43.549374Z'::timestamptz;
  if v_target_count>22 then
    raise exception 'TMS timestamp-binding retry exceeded bounded cohort: %',
      v_target_count using errcode='54000';
  end if;

  for v_job in
    select job.*,observation.content_hash as observation_content_hash,
      lineage.root_batch_id,lineage.source_cursor_version,
      lineage.source_cursor_value
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=job.workspace_key and lineage.job_id=job.job_id
     and lineage.source_system=job.source_system
     and lineage.connection_key=job.connection_key
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
     and observation.source_system=job.source_system
     and observation.connection_key=job.connection_key
     and observation.source_object_id=job.source_object_id
     and observation.batch_id=lineage.root_batch_id
     and observation.source_cursor_version=lineage.source_cursor_version
    where job.workspace_key='primary' and job.source_system='tms'
      and job.connection_key='couriercloud-ops-tlv-us'
      and job.job_kind='tms_extract_claims' and job.state='dead_letter'
      and job.last_error_code='TRUTH_CLAIM_JOB_FAILED'
      and job.safe_error_detail=v_detail
      and job.processor_version='hosted-truth-shadow-runtime-v2:tms-claim-v1'
      and job.created_at='2026-07-18T19:08:43.549374Z'::timestamptz
      and job.attempt_count=5 and job.max_attempts=5
      and job.lease_owner is null and job.lease_expires_at is null
      and job.completed_at is not null and job.result='{}'::jsonb
      and job.payload->>'schemaVersion'='tms-extract-claims-job-v1'
      and job.payload->>'sourceObservationId'=job.observation_id
      and job.payload->>'shipmentGuid'=job.source_object_id
      and job.payload->>'batchId'=lineage.root_batch_id::text
      and not exists(select 1 from public.candidate_claim_job_lineage candidate
        where candidate.job_id=job.job_id)
      and not exists(select 1 from public.candidate_claim_job_manifests manifest
        where manifest.job_id=job.job_id)
      and not exists(select 1 from public.truth_pending_acceptance_epoch_manifests member
        where member.workspace_key=job.workspace_key
          and member.source_job_id=job.job_id)
      and not exists(select 1
        from public.truth_tms_claim_timestamp_retry_authorizations auth
        where auth.source_job_id=job.job_id)
    order by job.job_id for update of job
  loop
    v_body:=jsonb_build_object(
      'schemaVersion','truth-tms-claim-timestamp-retry-authorization-v1',
      'workspaceKey','primary','connectionKey','couriercloud-ops-tlv-us',
      'sourceJobId',v_job.job_id,
      'sourceObservationId',v_job.observation_id,
      'sourceObservationContentHash',v_job.observation_content_hash,
      'sourceObjectId',v_job.source_object_id,
      'rootBatchId',v_job.root_batch_id,
      'sourceCursorVersion',v_job.source_cursor_version,
      'sourceCursorValueHash',encode(extensions.digest(convert_to(
        v_job.source_cursor_value,'UTF8'),'sha256'),'hex'),
      'priorState','dead_letter','priorAttemptCount',v_job.attempt_count,
      'priorMaxAttempts',v_job.max_attempts,'authorizedMaxAttempts',8,
      'priorLeaseFence',v_job.lease_fence,
      'priorCompletedAt',to_char(v_job.completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'priorErrorCode',v_job.last_error_code,
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.payload),'UTF8'),'sha256'),'hex'),
      'priorResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_job.result),'UTF8'),'sha256'),'hex'),
      'reasonCode','TMS_EXACT_TIMESTAMP_BINDING_DEFECT_FIXED_8888CA4C',
      'fixedCommit','8888ca4c1bab16f66a527cf326993cece7af81dd',
      'productionPublicationAttempted',false
    );
    v_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
    insert into public.truth_tms_claim_timestamp_retry_authorizations(
      authorization_id,authorization_hash,workspace_key,connection_key,
      source_job_id,source_observation_id,source_observation_content_hash,
      source_object_id,root_batch_id,source_cursor_version,
      source_cursor_value_hash,prior_state,prior_attempt_count,
      prior_max_attempts,authorized_max_attempts,prior_lease_fence,
      prior_completed_at,prior_error_code,prior_error_detail_hash,
      prior_payload_hash,prior_result_hash,canonical_authorization,schema_version
    ) values(
      'truth-tms-claim-timestamp-retry:v1:'||v_hash,v_hash,'primary',
      'couriercloud-ops-tlv-us',v_job.job_id,v_job.observation_id,
      v_job.observation_content_hash,v_job.source_object_id,v_job.root_batch_id,
      v_job.source_cursor_version,v_body->>'sourceCursorValueHash',
      'dead_letter',v_job.attempt_count,v_job.max_attempts,8,v_job.lease_fence,
      v_job.completed_at,v_job.last_error_code,v_body->>'priorErrorDetailHash',
      v_body->>'priorPayloadHash',v_body->>'priorResultHash',v_body,
      'truth-tms-claim-timestamp-retry-authorization-v1'
    );

    update public.source_processing_jobs job
    set state='retry_wait',max_attempts=8,available_at=clock_timestamp(),
      lease_owner=null,lease_expires_at=null,completed_at=null,
      last_error_code='TMS_TIMESTAMP_BINDING_RETRY_AUTHORIZED',
      safe_error_detail=
        'The exhausted attempts were caused by the pre-8888ca4c exact timestamp binding defect; bounded retry is authorized.',
      updated_at=clock_timestamp()
    where job.job_id=v_job.job_id and job.state='dead_letter'
      and job.attempt_count=v_job.attempt_count
      and job.max_attempts=v_job.max_attempts
      and job.lease_fence=v_job.lease_fence
      and job.last_error_code=v_job.last_error_code
      and job.safe_error_detail=v_job.safe_error_detail
      and job.payload=v_job.payload and job.result=v_job.result
      and job.lease_owner is null and job.lease_expires_at is null
      and job.completed_at=v_job.completed_at;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      raise exception 'TMS timestamp-binding retry fence changed'
        using errcode='40001';
    end if;
  end loop;

  if exists(
    select 1 from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='tms'
      and job.connection_key='couriercloud-ops-tlv-us'
      and job.state='dead_letter'
  ) then
    raise exception 'TMS timestamp-binding dead-letter remained after bounded restoration'
      using errcode='55000';
  end if;
end;
$restore$;

analyze public.source_processing_jobs;
analyze public.truth_tms_claim_timestamp_retry_authorizations;

do $verify$
begin
  if (select count(*) from public.truth_tms_claim_timestamp_retry_authorizations)>22
    or exists(select 1 from public.truth_tms_claim_timestamp_retry_authorizations auth
      where auth.production_publication_attempted
        or auth.canonical_authorization->>'productionPublicationAttempted'<>'false') then
    raise exception 'TMS timestamp-binding retry authority is unsafe'
      using errcode='55000';
  end if;
  if has_table_privilege('anon',
      'public.truth_tms_claim_timestamp_retry_authorizations','SELECT')
    or has_table_privilege('authenticated',
      'public.truth_tms_claim_timestamp_retry_authorizations','SELECT')
    or has_table_privilege('service_role',
      'public.truth_tms_claim_timestamp_retry_authorizations',
      'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'TMS timestamp-binding retry authorization ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

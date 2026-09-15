-- The dedicated primary attachment worker is already an allowed consumer of
-- immutable invalid-first-exhaustion lineage, but only the legacy local
-- processor could mint that lineage. Authorize the exact primary 5/5 shape
-- through a separate bounded authority and leave every other queue row alone.

create or replace function private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_body jsonb;
  v_hash text;
  v_updated integer;
  v_marker constant text :=
    'The exact primary attachment worker reached first invalid-argument exhaustion; one bounded current-wire replay cohort is authorized before review-open terminalization.';
begin
  select job.* into v_job
  from public.source_processing_jobs job
  where job.workspace_key='primary'
    and job.job_id=p_job_id
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.processor_version='primary-attachment-model-drain-v1:worker-v1'
    and job.state='dead_letter'
    and job.attempt_count=5
    and job.max_attempts=5
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and private.truth_gmail_attachment_worker_failure_v1(
      job.safe_error_detail,job.last_error_code
    )
    and job.lease_owner is null
    and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(select 1
      from public.gmail_attachment_model_requests request
      where request.workspace_key=job.workspace_key
        and request.source_job_id=job.job_id)
    and not exists(select 1
      from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
      where lineage.workspace_key=job.workspace_key
        and lineage.source_job_id=job.job_id)
    and not exists(select 1
      from public.truth_gmail_attachment_invalid_argument_terminalizations terminalization
      where terminalization.workspace_key=job.workspace_key
        and terminalization.source_job_id=job.job_id)
    and not exists(select 1
      from public.truth_gmail_attachment_cross_authority_invalid_terminalizations terminalization
      where terminalization.workspace_key=job.workspace_key
        and terminalization.source_job_id=job.job_id)
  for update of job;
  if not found then return false; end if;

  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-v1',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,
    'authorizedAttemptCount',v_job.attempt_count,
    'authorizedMaxAttempts',v_job.attempt_count+3,
    'authorizationErrorDetailHash',encode(extensions.digest(
      convert_to(v_marker,'UTF8'),'sha256'),'hex'),
    'reasonCode','ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    'captureAuthority','retry_authorization_transition_v2',
    'producerAuthority','primary_attachment_model_drain_v1',
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body),'UTF8'),'sha256'),'hex');
  insert into public.truth_gmail_attachment_invalid_argument_retry_lineage(
    lineage_id,lineage_hash,workspace_key,connection_key,source_job_id,
    authorized_attempt_count,authorized_max_attempts,
    authorization_error_detail_hash,canonical_lineage
  ) values(
    'truth-gmail-attachment-invalid-retry:v1:'||v_hash,v_hash,
    v_job.workspace_key,v_job.connection_key,v_job.job_id,v_job.attempt_count,
    v_job.attempt_count+3,v_body->>'authorizationErrorDetailHash',v_body
  );

  update public.source_processing_jobs job
  set state='retry_wait',max_attempts=v_job.attempt_count+3,
    processor_version='primary-attachment-invalid-drain-v1:worker-v1',
    available_at=clock_timestamp(),lease_owner=null,lease_expires_at=null,
    completed_at=null,
    last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    safe_error_detail=v_marker,updated_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state=v_job.state and job.attempt_count=v_job.attempt_count
    and job.max_attempts=v_job.max_attempts
    and job.lease_fence is not distinct from v_job.lease_fence
    and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail
    and job.processor_version=v_job.processor_version
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result=v_job.result;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'primary invalid-argument first-exhaustion fence changed: %',
      v_job.job_id using errcode='40001';
  end if;
  return true;
end;
$function$;

revoke all on function private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(uuid)
  from public,anon,authenticated,service_role;

create or replace function private.route_truth_gmail_primary_attachment_invalid_first_exhaustion_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  perform private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(
    new.job_id
  );
  return null;
end;
$function$;

revoke all on function private.route_truth_gmail_primary_attachment_invalid_first_exhaustion_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists truth_gmail_primary_attachment_invalid_first_exhaustion
  on public.source_processing_jobs;
create trigger truth_gmail_primary_attachment_invalid_first_exhaustion
after insert or update on public.source_processing_jobs
for each row when(
  new.workspace_key='primary' and new.source_system='gmail'
  and new.connection_key='primary'
  and new.job_kind='gmail_review_attachment_extraction'
  and new.processor_version='primary-attachment-model-drain-v1:worker-v1'
  and new.state='dead_letter' and new.attempt_count=5 and new.max_attempts=5
  and new.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
)
execute function private.route_truth_gmail_primary_attachment_invalid_first_exhaustion_v1();

do $backfill$
declare v_job record;
begin
  for v_job in
    select job.job_id
    from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.processor_version='primary-attachment-model-drain-v1:worker-v1'
      and job.state='dead_letter' and job.attempt_count=5 and job.max_attempts=5
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and private.truth_gmail_attachment_worker_failure_v1(
        job.safe_error_detail,job.last_error_code
      )
      and job.lease_owner is null and job.lease_expires_at is null
      and job.result='{}'::jsonb
    order by job.job_id
  loop
    perform private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(
      v_job.job_id
    );
  end loop;
end;
$backfill$;

do $verify$
declare v_function text; v_trigger text;
begin
  select pg_get_functiondef(
    'private.authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1(uuid)'::regprocedure
  ) into v_function;
  select pg_get_triggerdef(oid) into v_trigger
  from pg_trigger
  where tgrelid='public.source_processing_jobs'::regclass
    and tgname='truth_gmail_primary_attachment_invalid_first_exhaustion'
    and not tgisinternal;
  if v_function is null or v_trigger is null
    or position('primary-attachment-model-drain-v1:worker-v1' in v_function)=0
    or position('attempt_count' in v_function)=0
    or position('max_attempts' in v_function)=0
    or position('gmail_attachment_model_requests' in v_function)=0
    or position('retry_authorization_transition_v2' in v_function)=0
    or position('productionPublicationAttempted' in v_function)=0
    or position('primary-attachment-model-drain-v1:worker-v1' in v_trigger)=0
    or exists(select 1 from public.source_processing_jobs job
      where job.workspace_key='primary' and job.source_system='gmail'
        and job.connection_key='primary'
        and job.job_kind='gmail_review_attachment_extraction'
        and job.processor_version='primary-attachment-model-drain-v1:worker-v1'
        and job.state='dead_letter' and job.attempt_count=5 and job.max_attempts=5
        and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
        and private.truth_gmail_attachment_worker_failure_v1(
          job.safe_error_detail,job.last_error_code
        )
        and job.lease_owner is null and job.lease_expires_at is null
        and job.result='{}'::jsonb
        and not exists(select 1
          from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
          where lineage.workspace_key=job.workspace_key
            and lineage.source_job_id=job.job_id)) then
    raise exception 'primary attachment invalid first-exhaustion authority is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

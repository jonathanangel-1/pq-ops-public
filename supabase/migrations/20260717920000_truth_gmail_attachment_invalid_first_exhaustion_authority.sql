-- Turn the historical invalid-argument restoration into a durable runtime
-- authority. A late exact first exhaustion receives the same single +3 retry
-- cohort and immutable lineage as the original recovery. The fixed adapter
-- gets one bounded chance; a later exhaustion still terminates only through
-- the existing receipt-bound review-open path. No evidence is minted and no
-- production publication is attempted.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_invalid_argument_retry_lineage') is null
    or to_regclass('public.gmail_attachment_model_requests') is null
    or to_regprocedure('private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(uuid)') is null
    or to_regprocedure('private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(uuid)') is null
    or to_regprocedure('private.truth_gmail_attachment_worker_failure_v1(text,text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'late invalid-argument attachment authority prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function private.authorize_truth_gmail_attachment_invalid_first_exhaustion_v1(
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
    'The prior attempts ran under the adapter that sent the unsupported temperature parameter; the adapter is fixed and bounded retry is authorized.';
begin
  select job.* into v_job
  from public.source_processing_jobs job
  where job.workspace_key='primary'
    and job.job_id=p_job_id
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.processor_version='local-pipeline-v1:attach-model'
    and job.state='dead_letter'
    and job.attempt_count=5
    and job.max_attempts=5
    and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
    and private.truth_gmail_attachment_worker_failure_v1(
      job.safe_error_detail,job.last_error_code)
    and job.lease_owner is null
    and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(
      select 1 from public.gmail_attachment_model_requests request
      where request.workspace_key=job.workspace_key
        and request.source_job_id=job.job_id
    )
    and not exists(
      select 1 from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
      where lineage.workspace_key=job.workspace_key
        and lineage.source_job_id=job.job_id
    )
    and not exists(
      select 1 from public.truth_gmail_attachment_invalid_argument_terminalizations terminalization
      where terminalization.workspace_key=job.workspace_key
        and terminalization.source_job_id=job.job_id
    )
    and not exists(
      select 1 from public.truth_gmail_attachment_cross_authority_invalid_terminalizations terminalization
      where terminalization.workspace_key=job.workspace_key
        and terminalization.source_job_id=job.job_id
    )
  for update of job;
  if not found then return false; end if;

  -- This is the exact body independently recomputed by the existing marker
  -- transition trigger. Insert it first so authority exists before headroom.
  v_body:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-invalid-retry-lineage-v1',
    'workspaceKey',v_job.workspace_key,
    'connectionKey',v_job.connection_key,
    'sourceJobId',v_job.job_id,
    'authorizedAttemptCount',v_job.attempt_count,
    'authorizedMaxAttempts',v_job.attempt_count+3,
    'authorizationErrorDetailHash',encode(extensions.digest(
      convert_to(v_marker,'UTF8'),'sha256'),'hex'),
    'reasonCode','ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
    'captureAuthority','retry_authorization_transition_v2',
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
  set state='retry_wait',
      max_attempts=v_job.attempt_count+3,
      available_at=clock_timestamp(),
      lease_owner=null,
      lease_expires_at=null,
      completed_at=null,
      last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED',
      safe_error_detail=v_marker,
      updated_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key
    and job.job_id=v_job.job_id
    and job.state=v_job.state
    and job.attempt_count=v_job.attempt_count
    and job.max_attempts=v_job.max_attempts
    and job.lease_fence=v_job.lease_fence
    and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail
    and job.processor_version=v_job.processor_version
    and job.lease_owner is null
    and job.lease_expires_at is null
    and job.result=v_job.result;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'late invalid-argument attachment authority fence changed: %',
      v_job.job_id using errcode='40001';
  end if;
  return true;
end;
$function$;

revoke all on function private.authorize_truth_gmail_attachment_invalid_first_exhaustion_v1(uuid)
  from public,anon,authenticated,service_role;

-- Preserve every prior route and add only the exact first-exhaustion fallback
-- after both existing terminal authorities refuse the row.
create or replace function private.route_truth_gmail_attachment_documented_dead_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.last_error_code='ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED' then
    perform private.record_truth_gmail_attachment_invalid_retry_lineage_v1(new.job_id);
  elsif new.last_error_code='ATTACHMENT_MODEL_OUTCOME_UNKNOWN' then
    perform private.adopt_truth_gmail_attachment_outcome_unknown_v1(new.job_id);
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  elsif new.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT' then
    if not private.terminalize_truth_gmail_attachment_invalid_exhaustion_v1(new.job_id)
      and not private.terminalize_truth_gmail_attachment_cross_authority_invalid_v1(new.job_id) then
      perform private.authorize_truth_gmail_attachment_invalid_first_exhaustion_v1(new.job_id);
    end if;
  elsif new.last_error_code='TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED' then
    perform private.terminalize_truth_gmail_attachment_ledger_rpc_exhaustion_v1(new.job_id);
  else
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  end if;
  return null;
end;
$function$;

revoke all on function private.route_truth_gmail_attachment_documented_dead_v1()
  from public,anon,authenticated,service_role;

-- Class-scoped backfill. The function itself owns every invariant and fence.
do $backfill$
declare v_job record;
begin
  for v_job in
    select job.job_id
    from public.source_processing_jobs job
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.processor_version='local-pipeline-v1:attach-model'
      and job.state='dead_letter'
      and job.attempt_count=5
      and job.max_attempts=5
      and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
      and private.truth_gmail_attachment_worker_failure_v1(
        job.safe_error_detail,job.last_error_code)
      and job.lease_owner is null
      and job.lease_expires_at is null
      and job.result='{}'::jsonb
    order by job.job_id
  loop
    perform private.authorize_truth_gmail_attachment_invalid_first_exhaustion_v1(
      v_job.job_id
    );
  end loop;
end;
$backfill$;

do $verify$
declare v_router text;
begin
  select pg_get_functiondef(
    'private.route_truth_gmail_attachment_documented_dead_v1()'::regprocedure
  ) into v_router;
  if position('authorize_truth_gmail_attachment_invalid_first_exhaustion_v1' in v_router)=0
    or exists(
      select 1
      from public.source_processing_jobs job
      where job.workspace_key='primary'
        and job.source_system='gmail'
        and job.connection_key='primary'
        and job.job_kind='gmail_review_attachment_extraction'
        and job.processor_version='local-pipeline-v1:attach-model'
        and job.state='dead_letter'
        and job.attempt_count=5
        and job.max_attempts=5
        and job.last_error_code='OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT'
        and private.truth_gmail_attachment_worker_failure_v1(
          job.safe_error_detail,job.last_error_code)
        and job.lease_owner is null
        and job.lease_expires_at is null
        and job.result='{}'::jsonb
        and not exists(
          select 1 from public.gmail_attachment_model_requests request
          where request.workspace_key=job.workspace_key
            and request.source_job_id=job.job_id
        )
        and not exists(
          select 1
          from public.truth_gmail_attachment_invalid_argument_retry_lineage lineage
          where lineage.workspace_key=job.workspace_key
            and lineage.source_job_id=job.job_id
        )
    ) then
    raise exception 'late invalid-argument attachment authority is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

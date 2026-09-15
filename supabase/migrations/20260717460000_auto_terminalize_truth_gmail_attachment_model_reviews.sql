-- A model request in review_required/outcome_unknown is terminal for machine
-- extraction but remains open human work. Terminalize its producer immediately
-- from the worker's acknowledgement envelope so future live batches cannot
-- head-block acceptance while preserving the explicit review queue unchanged.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_model_job_terminalizations') is null
    or to_regclass('public.gmail_attachment_model_requests') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'automatic attachment-model review terminalization prerequisites are unavailable'
      using errcode='55000';
  end if;
end;
$preflight$;

-- 270000 admitted only queued/retry_wait because it was a one-time sweep.
-- PostgreSQL 17 represents NOT NULL separately; constrain this name-agnostic
-- rewrite to contype='c' so no system-generated NOT NULL name can be touched.
do $widen_prior_job_state$
declare
  v_constraint record;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid=
        'public.truth_gmail_attachment_model_job_terminalizations'::regclass
      and constraint_row.contype='c'
      and pg_get_constraintdef(constraint_row.oid) like '%prior_job_state%'
      and constraint_row.conname<>
        'truth_gmail_attachment_model_job_terminalizations_prior_state_check'
  loop
    execute format(
      'alter table public.truth_gmail_attachment_model_job_terminalizations drop constraint %I',
      v_constraint.conname
    );
  end loop;
  if not exists(
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid=
        'public.truth_gmail_attachment_model_job_terminalizations'::regclass
      and constraint_row.conname=
        'truth_gmail_attachment_model_job_terminalizations_prior_state_check'
  ) then
    alter table public.truth_gmail_attachment_model_job_terminalizations
      add constraint truth_gmail_attachment_model_job_terminalizations_prior_state_check
      check (prior_job_state=any(array['queued','retry_wait','dead_letter']));
  end if;
end;
$widen_prior_job_state$;

create or replace function private.terminalize_truth_gmail_attachment_model_review_job_v2(
  p_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.source_processing_jobs%rowtype;
  v_request public.gmail_attachment_model_requests%rowtype;
  v_ack jsonb;
  v_disposition text;
  v_reason text;
  v_terminalization jsonb;
  v_hash text;
  v_id text;
  v_result jsonb;
  v_updated integer;
begin
  select * into v_job
  from public.source_processing_jobs job
  where job.workspace_key='primary'
    and job.job_id=p_job_id
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state=any(array['queued','retry_wait','dead_letter'])
    and job.last_error_code=any(array[
      'ATTACHMENT_MODEL_REVIEW_REQUIRED','ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
    ])
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb
    and not exists(
      select 1
      from public.truth_gmail_attachment_model_job_terminalizations existing
      where existing.workspace_key=job.workspace_key
        and existing.source_job_id=job.job_id
    )
  for update;
  if not found then return false; end if;

  begin
    v_ack:=v_job.safe_error_detail::jsonb;
  exception when others then
    return false;
  end;
  if jsonb_typeof(v_ack)<>'object'
    or v_ack->>'schemaVersion'<>'truth-gmail-attachment-model-acknowledgement-v1'
    or v_ack->>'reasonCode'<>v_job.last_error_code
    or v_ack->>'productionPublicationAttempted'<>'false' then
    return false;
  end if;

  select * into v_request
  from public.gmail_attachment_model_requests request
  where request.workspace_key=v_job.workspace_key
    and request.source_job_id=v_job.job_id
    and request.request_id=v_ack->>'requestId'
    and request.connection_key=v_job.connection_key
    and request.state=any(array['review_required','outcome_unknown'])
  for update;
  if not found
    or v_ack->>'requestState'<>v_request.state
    or (v_request.state='review_required'
      and v_job.last_error_code<>'ATTACHMENT_MODEL_REVIEW_REQUIRED')
    or (v_request.state='outcome_unknown'
      and v_job.last_error_code<>'ATTACHMENT_MODEL_OUTCOME_UNKNOWN') then
    return false;
  end if;

  v_disposition:=case v_request.state
    when 'review_required' then 'operator_review_remains_open'
    else 'provider_outcome_unknown_review_remains_open' end;
  v_reason:=coalesce(nullif(v_request.review_reason,''),
    nullif(v_ack->>'classification',''),v_job.last_error_code);
  v_terminalization:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-model-job-terminalization-v1',
    'authorityVersion','truth-gmail-attachment-model-review-auto-terminalization-v2',
    'workspaceKey',v_job.workspace_key,'connectionKey',v_job.connection_key,
    'jobId',v_job.job_id,'requestId',v_request.request_id,
    'requestState',v_request.state,'disposition',v_disposition,
    'reviewReason',v_reason,'acknowledgementHash',encode(extensions.digest(
      convert_to(v_job.safe_error_detail,'UTF8'),'sha256'),'hex'),
    'priorJobState',v_job.state,'priorAttemptCount',v_job.attempt_count,
    'priorMaxAttempts',v_job.max_attempts,
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  v_hash:=encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_terminalization),'UTF8'
  ),'sha256'),'hex');
  v_id:='truth-gmail-attachment-model-job-terminalization:v1:'||v_hash;
  v_result:=jsonb_build_object(
    'schemaVersion','truth-gmail-attachment-model-review-boundary-result-v1',
    'terminalizationId',v_id,'terminalizationHash',v_hash,
    'requestId',v_request.request_id,'requestState',v_request.state,
    'reviewReason',v_reason,'disposition',v_disposition,
    'operatorReviewResolved',false,'operationalEvidenceMinted',false,
    'productionPublicationAttempted',false
  );
  insert into public.truth_gmail_attachment_model_job_terminalizations(
    terminalization_id,terminalization_hash,workspace_key,connection_key,
    source_job_id,request_id,request_state,disposition,prior_job_state,
    prior_attempt_count,prior_max_attempts,review_reason,
    canonical_terminalization,canonical_result
  ) values(
    v_id,v_hash,v_job.workspace_key,v_job.connection_key,v_job.job_id,
    v_request.request_id,v_request.state,v_disposition,v_job.state,
    v_job.attempt_count,v_job.max_attempts,v_reason,v_terminalization,v_result
  );
  update public.source_processing_jobs job
  set state='succeeded',lease_owner=null,lease_expires_at=null,
    last_error_code='',safe_error_detail='',
    processor_version='truth-gmail-attachment-model-review-auto-terminal-v2',
    result=v_result,updated_at=clock_timestamp(),completed_at=clock_timestamp()
  where job.workspace_key=v_job.workspace_key and job.job_id=v_job.job_id
    and job.state=v_job.state and job.attempt_count=v_job.attempt_count
    and job.max_attempts=v_job.max_attempts and job.lease_fence=v_job.lease_fence
    and job.last_error_code=v_job.last_error_code
    and job.safe_error_detail=v_job.safe_error_detail
    and job.lease_owner is null and job.lease_expires_at is null
    and job.result='{}'::jsonb;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'attachment-model review auto-terminalization fence changed'
      using errcode='40001';
  end if;
  return true;
end;
$function$;

revoke all on function private.terminalize_truth_gmail_attachment_model_review_job_v2(uuid)
  from public,anon,authenticated,service_role;

create or replace function private.route_truth_gmail_attachment_model_review_terminal_v2()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  perform private.terminalize_truth_gmail_attachment_model_review_job_v2(new.job_id);
  return null;
end;
$function$;
revoke all on function private.route_truth_gmail_attachment_model_review_terminal_v2()
  from public,anon,authenticated,service_role;

drop trigger if exists truth_gmail_attachment_model_review_auto_terminal
  on public.source_processing_jobs;
create trigger truth_gmail_attachment_model_review_auto_terminal
after insert or update on public.source_processing_jobs
for each row when (
  new.workspace_key='primary'
  and new.source_system='gmail'
  and new.connection_key='primary'
  and new.job_kind='gmail_review_attachment_extraction'
  and new.state=any(array['queued','retry_wait','dead_letter'])
  and new.last_error_code=any(array[
    'ATTACHMENT_MODEL_REVIEW_REQUIRED','ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
  ])
)
execute function private.route_truth_gmail_attachment_model_review_terminal_v2();

do $backfill$
declare v_job_id uuid;
begin
  for v_job_id in
    select job.job_id
    from public.source_processing_jobs job
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state=any(array['queued','retry_wait','dead_letter'])
      and job.last_error_code=any(array[
        'ATTACHMENT_MODEL_REVIEW_REQUIRED','ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
      ])
    order by job.job_id
  loop
    perform private.terminalize_truth_gmail_attachment_model_review_job_v2(v_job_id);
  end loop;
end;
$backfill$;

do $verify$
declare v_trigger_count integer;
begin
  select count(*)::integer into v_trigger_count
  from pg_trigger trigger_row
  where trigger_row.tgrelid='public.source_processing_jobs'::regclass
    and trigger_row.tgname='truth_gmail_attachment_model_review_auto_terminal'
    and not trigger_row.tgisinternal and trigger_row.tgenabled<>'D';
  if v_trigger_count<>1 or exists(
    select 1
    from public.source_processing_jobs job
    join public.gmail_attachment_model_requests request
      on request.workspace_key=job.workspace_key
     and request.source_job_id=job.job_id
     and request.request_id=job.safe_error_detail::jsonb->>'requestId'
    where job.workspace_key='primary' and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state=any(array['queued','retry_wait','dead_letter'])
      and job.last_error_code=any(array[
        'ATTACHMENT_MODEL_REVIEW_REQUIRED','ATTACHMENT_MODEL_OUTCOME_UNKNOWN'
      ])
      and job.safe_error_detail::jsonb->>'schemaVersion'
        ='truth-gmail-attachment-model-acknowledgement-v1'
      and request.state=any(array['review_required','outcome_unknown'])
      and job.safe_error_detail::jsonb->>'requestState'=request.state
  ) then
    raise exception 'automatic attachment-model review terminalization is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;

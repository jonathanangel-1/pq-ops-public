-- Claim ordinary primary forward model children from their exact root batch.
-- This bypasses the cron-shared generic selector without changing its planner,
-- timeout, or downstream model/review contracts.

create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_primary_forward_parent_authorizations') is null
    or to_regprocedure(
      'private.truth_gmail_live_message_model_job_allowed_v1(text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_live_model_child_worker_allowed_v1(text,uuid,text,text)'
    ) is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null then
    raise exception 'primary forward model-child claim prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function public.claim_truth_gmail_primary_forward_model_children(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_root_batch_id uuid,
  p_worker_id text,
  p_processor_version text,
  p_limit integer,
  p_lease_seconds integer,
  p_job_kinds text[],
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='20s'
set lock_timeout='5s'
as $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_jobs jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_source_system is distinct from 'gmail'
    or p_connection_key is distinct from 'primary'
    or p_root_batch_id is null
    or p_worker_id is distinct from
      'primary-message-model-drain:claims:'||p_root_batch_id::text
    or p_processor_version is distinct from
      'primary-message-model-drain-v1:claims-v2'
    or p_limit is null or p_limit<1 or p_limit>2
    or p_lease_seconds is null or p_lease_seconds<30 or p_lease_seconds>900
    or coalesce(cardinality(p_job_kinds),0)<>1
    or p_job_kinds[1] is distinct from
      'gmail_extract_message_model_claims' then
    raise exception 'invalid primary forward model-child claim request'
      using errcode='22023';
  end if;

  -- Recover only this worker's expired lease in this exact root. The expired
  -- attempt remains consumed, matching the canonical generic claim contract.
  update public.source_processing_jobs job
  set state=case when job.attempt_count>=job.max_attempts
        then 'dead_letter' else 'retry_wait' end,
      available_at=case when job.attempt_count>=job.max_attempts
        then job.available_at else v_now end,
      lease_owner=null,
      lease_expires_at=null,
      last_error_code='LEASE_EXPIRED',
      safe_error_detail='The prior primary forward model-child lease expired before acknowledgement.',
      updated_at=v_now,
      completed_at=case when job.attempt_count>=job.max_attempts then v_now else null end
  from public.source_processing_job_lineage lineage,
       public.truth_gmail_primary_forward_parent_authorizations auth
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_extract_message_model_claims'
    and job.state='leased'
    and job.lease_owner=p_worker_id
    and job.processor_version=p_processor_version
    and (job.lease_expires_at is null or job.lease_expires_at<=v_now)
    and lineage.workspace_key=job.workspace_key
    and lineage.job_id=job.job_id
    and lineage.root_batch_id=p_root_batch_id
    and auth.workspace_key=lineage.workspace_key
    and auth.parent_job_id=lineage.parent_job_id
    and auth.root_batch_id=lineage.root_batch_id
    and auth.production_publication_attempted=false;

  with candidates as materialized(
    select job.job_id
    from public.source_processing_job_lineage lineage
    join public.truth_gmail_primary_forward_parent_authorizations auth
      on auth.workspace_key=lineage.workspace_key
     and auth.parent_job_id=lineage.parent_job_id
     and auth.root_batch_id=lineage.root_batch_id
     and auth.production_publication_attempted=false
    join public.source_processing_jobs job
      on job.workspace_key=lineage.workspace_key
     and job.source_system=lineage.source_system
     and job.connection_key=lineage.connection_key
     and job.job_id=lineage.job_id
    join public.source_ingest_batches batch
      on batch.workspace_key=lineage.workspace_key
     and batch.source_system=lineage.source_system
     and batch.connection_key=lineage.connection_key
     and batch.batch_id=lineage.root_batch_id
     and batch.status='committed'
     and batch.committed_cursor_version=lineage.source_cursor_version
     and batch.committed_cursor_value=lineage.source_cursor_value
    where lineage.workspace_key='primary'
      and lineage.source_system='gmail'
      and lineage.connection_key='primary'
      and lineage.root_batch_id=p_root_batch_id
      and job.job_kind='gmail_extract_message_model_claims'
      and job.state in ('queued','retry_wait')
      and job.available_at<=v_now
      and job.attempt_count<job.max_attempts
      and job.payload->>'rootBatchId'=p_root_batch_id::text
      and job.payload->>'parentJobId'=auth.parent_job_id::text
      and private.truth_gmail_live_message_model_job_allowed_v1(
        job.workspace_key,job.job_id
      )
      and private.truth_gmail_live_model_child_worker_allowed_v1(
        job.workspace_key,job.job_id,p_worker_id,p_processor_version
      )
    order by job.available_at,job.created_at,job.job_id
    for update of job skip locked
    limit p_limit
  ), claimed as(
    update public.source_processing_jobs job
    set state='leased',
        attempt_count=job.attempt_count+1,
        lease_owner=p_worker_id,
        lease_fence=job.lease_fence+1,
        lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
        last_error_code='',
        safe_error_detail='',
        processor_version=p_processor_version,
        updated_at=v_now,
        completed_at=null
    from candidates
    where job.job_id=candidates.job_id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId',claimed.job_id,
    'dedupeKey',claimed.dedupe_key,
    'jobKind',claimed.job_kind,
    'observationId',claimed.observation_id,
    'sourceObjectId',claimed.source_object_id,
    'attemptCount',claimed.attempt_count,
    'maxAttempts',claimed.max_attempts,
    'leaseFence',claimed.lease_fence,
    'leaseExpiresAt',claimed.lease_expires_at,
    'processorVersion',claimed.processor_version,
    'payload',claimed.payload,
    'rootBatchId',lineage.root_batch_id,
    'rootJobId',lineage.root_job_id,
    'parentJobId',lineage.parent_job_id,
    'sourceCursorVersion',lineage.source_cursor_version,
    'sourceCursorValue',lineage.source_cursor_value
  ) order by claimed.available_at,claimed.created_at,claimed.job_id),'[]'::jsonb)
  into v_jobs
  from claimed
  join public.source_processing_job_lineage lineage
    on lineage.workspace_key=claimed.workspace_key
   and lineage.job_id=claimed.job_id;

  return jsonb_build_object(
    'ok',true,
    'workerId',p_worker_id,
    'processorVersion',p_processor_version,
    'rootBatchId',p_root_batch_id,
    'leaseSeconds',p_lease_seconds,
    'claimedCount',jsonb_array_length(v_jobs),
    'jobs',v_jobs,
    'candidateClaimsAutoAccepted',false,
    'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function public.claim_truth_gmail_primary_forward_model_children(
  text,text,text,uuid,text,text,integer,integer,text[],text
) from public,anon,authenticated;
grant execute on function public.claim_truth_gmail_primary_forward_model_children(
  text,text,text,uuid,text,text,integer,integer,text[],text
) to service_role;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'public.claim_truth_gmail_primary_forward_model_children(text,text,text,uuid,text,text,integer,integer,text[],text)'::regprocedure
  ) into v_definition;
  if position('lineage.root_batch_id=p_root_batch_id' in v_definition)=0
    or position('truth_gmail_primary_forward_parent_authorizations' in v_definition)=0
    or position('truth_gmail_live_message_model_job_allowed_v1' in v_definition)=0
    or position('truth_gmail_live_model_child_worker_allowed_v1' in v_definition)=0
    or position('for update of job skip locked' in v_definition)=0
    or position('candidateClaimsAutoAccepted' in v_definition)=0
    or position('productionPublicationAttempted' in v_definition)=0 then
    raise exception 'primary forward model-child claim route is incomplete'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.claim_truth_gmail_primary_forward_model_children(text,text,text,uuid,text,text,integer,integer,text[],text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.claim_truth_gmail_primary_forward_model_children(text,text,text,uuid,text,text,integer,integer,text[],text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.claim_truth_gmail_primary_forward_model_children(text,text,text,uuid,text,text,integer,integer,text[],text)','EXECUTE'
    ) then
    raise exception 'primary forward model-child claim ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

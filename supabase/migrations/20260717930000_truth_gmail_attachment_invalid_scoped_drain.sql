-- Give the takeover runner one dedicated claim route for the immutable
-- first-exhaustion cohort. The ordinary primary attachment queue remains
-- outside this route. Every downstream lease, model-ledger, completion,
-- failure, budget, and review operation stays on the canonical runtime.

create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_invalid_argument_retry_lineage') is null
    or to_regprocedure('private.truth_gmail_attachment_model_job_allowed_v2(text,uuid)') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null then
    raise exception 'scoped invalid-attachment drain prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function public.claim_truth_gmail_attachment_invalid_first_exhaustion_jobs(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
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
    or p_worker_id is distinct from 'primary-attachment-invalid-drain-v1'
    or p_processor_version is distinct from
      'primary-attachment-invalid-drain-v1:worker-v1'
    or p_limit is null or p_limit<1 or p_limit>5
    or p_lease_seconds is null or p_lease_seconds<30 or p_lease_seconds>900
    or coalesce(cardinality(p_job_kinds),0)<>1
    or p_job_kinds[1] is distinct from 'gmail_review_attachment_extraction' then
    raise exception 'invalid scoped invalid-attachment claim request'
      using errcode='22023';
  end if;

  -- Recover only an expired lease from this exact runner and cohort. The
  -- expired attempt remains consumed just like the canonical claim runtime.
  update public.source_processing_jobs job
  set state=case when job.attempt_count>=job.max_attempts
        then 'dead_letter' else 'retry_wait' end,
      available_at=case when job.attempt_count>=job.max_attempts
        then job.available_at else v_now end,
      lease_owner=null,
      lease_expires_at=null,
      last_error_code='LEASE_EXPIRED',
      safe_error_detail='The prior scoped invalid-attachment processing lease expired before acknowledgement.',
      updated_at=v_now,
      completed_at=case when job.attempt_count>=job.max_attempts then v_now else null end
  where job.workspace_key='primary'
    and job.source_system='gmail'
    and job.connection_key='primary'
    and job.job_kind='gmail_review_attachment_extraction'
    and job.state='leased'
    and job.lease_owner=p_worker_id
    and job.processor_version=p_processor_version
    and (job.lease_expires_at is null or job.lease_expires_at<=v_now)
    and exists(
      select 1
      from public.truth_gmail_attachment_invalid_argument_retry_lineage authority
      where authority.workspace_key=job.workspace_key
        and authority.source_job_id=job.job_id
        and authority.authorized_attempt_count=5
        and authority.authorized_max_attempts=8
        and authority.canonical_lineage->>'captureAuthority'=
          'retry_authorization_transition_v2'
        and authority.canonical_lineage->>'productionPublicationAttempted'='false'
    );

  with candidates as materialized (
    select job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage job_lineage
      on job_lineage.workspace_key=job.workspace_key
     and job_lineage.source_system=job.source_system
     and job_lineage.connection_key=job.connection_key
     and job_lineage.job_id=job.job_id
    join public.source_ingest_batches batch
      on batch.workspace_key=job_lineage.workspace_key
     and batch.source_system=job_lineage.source_system
     and batch.connection_key=job_lineage.connection_key
     and batch.batch_id=job_lineage.root_batch_id
     and batch.status='committed'
     and batch.committed_cursor_version=job_lineage.source_cursor_version
     and batch.committed_cursor_value=job_lineage.source_cursor_value
    join public.truth_gmail_attachment_invalid_argument_retry_lineage authority
      on authority.workspace_key=job.workspace_key
     and authority.source_job_id=job.job_id
     and authority.authorized_attempt_count=5
     and authority.authorized_max_attempts=8
     and authority.canonical_lineage->>'captureAuthority'=
       'retry_authorization_transition_v2'
     and authority.canonical_lineage->>'productionPublicationAttempted'='false'
    where job.workspace_key='primary'
      and job.source_system='gmail'
      and job.connection_key='primary'
      and job.job_kind='gmail_review_attachment_extraction'
      and job.state in ('queued','retry_wait')
      and job.available_at<=v_now
      and job.attempt_count>=5
      and job.attempt_count<job.max_attempts
      and job.max_attempts=8
      and job.processor_version in (
        'local-pipeline-v1:attach-model',
        'primary-attachment-invalid-drain-v1:worker-v1'
      )
      and private.truth_gmail_attachment_model_job_allowed_v2(
        job.workspace_key,job.job_id
      )
      and not exists(
        select 1
        from public.truth_gmail_attachment_invalid_argument_terminalizations terminalization
        where terminalization.workspace_key=job.workspace_key
          and terminalization.source_job_id=job.job_id
      )
      and not exists(
        select 1
        from public.truth_gmail_attachment_cross_authority_invalid_terminalizations terminalization
        where terminalization.workspace_key=job.workspace_key
          and terminalization.source_job_id=job.job_id
      )
    order by job.available_at,job.created_at,job.job_id
    for update of job skip locked
    limit p_limit
  ), claimed as (
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
    'rootBatchId',job_lineage.root_batch_id,
    'rootJobId',job_lineage.root_job_id,
    'parentJobId',job_lineage.parent_job_id,
    'sourceCursorVersion',job_lineage.source_cursor_version,
    'sourceCursorValue',job_lineage.source_cursor_value
  ) order by claimed.available_at,claimed.created_at,claimed.job_id),'[]'::jsonb)
  into v_jobs
  from claimed
  join public.source_processing_job_lineage job_lineage
    on job_lineage.workspace_key=claimed.workspace_key
   and job_lineage.job_id=claimed.job_id;

  return jsonb_build_object(
    'ok',true,
    'workerId',p_worker_id,
    'processorVersion',p_processor_version,
    'leaseSeconds',p_lease_seconds,
    'claimedCount',jsonb_array_length(v_jobs),
    'jobs',v_jobs,
    'scope','immutable_invalid_first_exhaustion_lineage',
    'candidateClaimsAutoAccepted',false,
    'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function public.claim_truth_gmail_attachment_invalid_first_exhaustion_jobs(
  text,text,text,text,text,integer,integer,text[],text
) from public,anon,authenticated;
grant execute on function public.claim_truth_gmail_attachment_invalid_first_exhaustion_jobs(
  text,text,text,text,text,integer,integer,text[],text
) to service_role;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'public.claim_truth_gmail_attachment_invalid_first_exhaustion_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
  ) into v_definition;
  if position('primary-attachment-invalid-drain-v1:worker-v1' in v_definition)=0
    or position('truth_gmail_attachment_invalid_argument_retry_lineage' in v_definition)=0
    or position('truth_gmail_attachment_model_job_allowed_v2' in v_definition)=0
    or position('candidateClaimsAutoAccepted' in v_definition)=0
    or position('productionPublicationAttempted' in v_definition)=0 then
    raise exception 'scoped invalid-attachment drain contract is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

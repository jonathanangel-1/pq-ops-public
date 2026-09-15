-- A zero-row claim can mean retry backoff, not drain. Expose one read-only,
-- exact-identity status receipt for the dedicated invalid-attachment runner.

create schema if not exists private;

do $preflight$
begin
  if to_regclass('public.truth_gmail_attachment_invalid_argument_retry_lineage') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null then
    raise exception 'scoped invalid-attachment status prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function public.read_truth_gmail_attachment_invalid_first_exhaustion_status(
  p_workspace_key text,
  p_source_system text,
  p_connection_key text,
  p_worker_id text,
  p_processor_version text,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_total integer;
  v_ready integer;
  v_future integer;
  v_leased integer;
  v_terminal integer;
  v_unexpected integer;
  v_next timestamptz;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode='28000';
  end if;
  if p_workspace_key is distinct from 'primary'
    or p_source_system is distinct from 'gmail'
    or p_connection_key is distinct from 'primary'
    or p_worker_id is distinct from 'primary-attachment-invalid-drain-v1'
    or p_processor_version is distinct from
      'primary-attachment-invalid-drain-v1:worker-v1' then
    raise exception 'invalid scoped invalid-attachment status request'
      using errcode='22023';
  end if;

  with cohort as materialized(
    select job.*,
      exists(select 1
        from public.truth_gmail_attachment_invalid_argument_terminalizations terminal
        where terminal.workspace_key=job.workspace_key
          and terminal.source_job_id=job.job_id
      ) or exists(select 1
        from public.truth_gmail_attachment_cross_authority_invalid_terminalizations terminal
        where terminal.workspace_key=job.workspace_key
          and terminal.source_job_id=job.job_id
      ) as terminal_receipted
    from public.source_processing_jobs job
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
  )
  select
    count(*)::integer,
    count(*) filter(where state in ('queued','retry_wait')
      and attempt_count<max_attempts and available_at<=v_now)::integer,
    count(*) filter(where state in ('queued','retry_wait')
      and attempt_count<max_attempts and available_at>v_now)::integer,
    count(*) filter(where state='leased' and attempt_count<=max_attempts)::integer,
    count(*) filter(where state in ('succeeded','superseded')
      and terminal_receipted)::integer,
    count(*) filter(where not(
      (state in ('queued','retry_wait') and attempt_count<max_attempts)
      or state='leased'
      or (state in ('succeeded','superseded') and terminal_receipted)
    ))::integer,
    min(available_at) filter(where state in ('queued','retry_wait')
      and attempt_count<max_attempts)
  into v_total,v_ready,v_future,v_leased,v_terminal,v_unexpected,v_next
  from cohort;

  return jsonb_build_object(
    'ok',true,
    'schemaVersion','truth-gmail-attachment-invalid-first-exhaustion-status-v1',
    'workerId',p_worker_id,
    'processorVersion',p_processor_version,
    'cohortCount',v_total,
    'pendingCount',v_ready+v_future+v_leased,
    'readyCount',v_ready,
    'futureRetryCount',v_future,
    'leasedCount',v_leased,
    'terminalCount',v_terminal,
    'unexpectedCount',v_unexpected,
    'nextAvailableAt',v_next,
    'candidateClaimsAutoAccepted',false,
    'productionPublicationAttempted',false
  );
end;
$function$;

revoke all on function public.read_truth_gmail_attachment_invalid_first_exhaustion_status(
  text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.read_truth_gmail_attachment_invalid_first_exhaustion_status(
  text,text,text,text,text,text
) to service_role;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'public.read_truth_gmail_attachment_invalid_first_exhaustion_status(text,text,text,text,text,text)'::regprocedure
  ) into v_definition;
  if position('truth_gmail_attachment_invalid_argument_retry_lineage' in v_definition)=0
    or position('pendingCount' in v_definition)=0
    or position('futureRetryCount' in v_definition)=0
    or position('unexpectedCount' in v_definition)=0
    or position('productionPublicationAttempted' in v_definition)=0 then
    raise exception 'scoped invalid-attachment status contract is incomplete'
      using errcode='55000';
  end if;
  if has_function_privilege(
      'anon','public.read_truth_gmail_attachment_invalid_first_exhaustion_status(text,text,text,text,text,text)','EXECUTE'
    ) or has_function_privilege(
      'authenticated','public.read_truth_gmail_attachment_invalid_first_exhaustion_status(text,text,text,text,text,text)','EXECUTE'
    ) or not has_function_privilege(
      'service_role','public.read_truth_gmail_attachment_invalid_first_exhaustion_status(text,text,text,text,text,text)','EXECUTE'
    ) then
    raise exception 'scoped invalid-attachment status ACL is unsafe'
      using errcode='55000';
  end if;
end;
$verify$;

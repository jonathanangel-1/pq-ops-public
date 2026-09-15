create or replace function public.queue_agent_job(
  p_sync_token text,
  p_job_type text,
  p_payload jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_priority integer default 50,
  p_max_attempts integer default 3
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  inserted_job public.agent_jobs;
  requested_dedupe_key text := nullif(p_dedupe_key, '');
  requested_priority integer := coalesce(p_priority, 50);
  requested_max_attempts integer := greatest(coalesce(p_max_attempts, 3), 1);
  is_source_backfill boolean := (
    p_job_type = 'email_refresh'
    and (
      lower(coalesce(p_payload->>'sourceBackfill', 'false')) = 'true'
      or coalesce(p_payload->>'source', '') = 'source-backfill-action'
    )
  );
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  if p_job_type = 'send_gmail_email' then
    raise exception 'beta draft mode blocks live Gmail send jobs; queue draft_gmail_email instead'
      using errcode = '22023';
  end if;

  if p_job_type not in (
    'send_tms_agt_alert',
    'complete_tms_pod_closeout',
    'draft_gmail_email',
    'email_refresh',
    'money_refresh',
    'eod_report',
    'full_refresh',
    'supabase_sync'
  ) then
    raise exception 'unsupported agent job type: %', p_job_type using errcode = '22023';
  end if;

  insert into public.agent_jobs (
    job_type,
    status,
    payload,
    dedupe_key,
    priority,
    max_attempts
  )
  values (
    p_job_type,
    'queued',
    coalesce(p_payload, '{}'::jsonb),
    requested_dedupe_key,
    requested_priority,
    requested_max_attempts
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning * into inserted_job;

  if inserted_job.id is null and is_source_backfill and requested_dedupe_key is not null then
    update public.agent_jobs
    set payload = coalesce(payload, '{}'::jsonb) || coalesce(p_payload, '{}'::jsonb),
        priority = least(priority, requested_priority),
        max_attempts = greatest(max_attempts, requested_max_attempts),
        status = case when status in ('failed', 'succeeded') then 'queued' else status end,
        available_at = case when status in ('queued', 'waiting_external', 'failed', 'succeeded') then now() else available_at end,
        locked_by = case when status in ('failed', 'succeeded') then null else locked_by end,
        locked_at = case when status in ('failed', 'succeeded') then null else locked_at end,
        completed_at = case when status in ('failed', 'succeeded') then null else completed_at end,
        last_error = case when status in ('failed', 'succeeded') then null else last_error end,
        updated_at = now()
    where dedupe_key = requested_dedupe_key
    returning * into inserted_job;
  end if;

  if inserted_job.id is null then
    select *
    into inserted_job
    from public.agent_jobs
    where dedupe_key = requested_dedupe_key
    order by created_at desc
    limit 1;
  end if;

  return inserted_job;
end;
$function$;

grant execute on function public.queue_agent_job(text, text, jsonb, text, integer, integer) to anon, authenticated;

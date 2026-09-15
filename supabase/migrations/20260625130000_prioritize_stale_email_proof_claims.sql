create or replace function public.claim_gmail_agent_job(p_worker_id text, p_sync_token text)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = public, extensions
as $function$
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  update public.agent_jobs
  set status = case when attempts < max_attempts then 'queued' else 'failed' end,
      locked_by = null,
      locked_at = null,
      available_at = now(),
      last_error = coalesce(last_error, 'Recovered stale Gmail running lock'),
      updated_at = now(),
      completed_at = case when attempts < max_attempts then null else now() end
  where status = 'running'
    and job_type in ('email_refresh', 'send_gmail_email', 'draft_gmail_email')
    and locked_at < now() - interval '15 minutes';

  return query
  with next_job as (
    select id
    from public.agent_jobs
    where status in ('queued', 'waiting_external')
      and job_type in ('email_refresh', 'send_gmail_email', 'draft_gmail_email')
      and available_at <= now()
    order by
      case
        when job_type = 'email_refresh' and payload->>'sourceBackfill' = 'true' then 0
        when job_type = 'email_refresh' and (
          payload->>'reason' = 'email-proof-stale'
          or payload->>'source' in ('dashboard', 'dashboard-auto', 'dashboard-manual')
          or payload->>'trigger' = 'manual-refresh-button'
        ) then 1
        when job_type = 'email_refresh' then 2
        else 3
      end,
      priority asc,
      case
        when job_type = 'email_refresh' and (
          payload->>'reason' = 'email-proof-stale'
          or payload->>'source' in ('dashboard', 'dashboard-auto', 'dashboard-manual')
          or payload->>'trigger' = 'manual-refresh-button'
        ) then created_at
        else null
      end desc,
      created_at asc
    for update skip locked
    limit 1
  )
  update public.agent_jobs jobs
  set status = 'running',
      attempts = attempts + 1,
      locked_by = p_worker_id,
      locked_at = now(),
      updated_at = now(),
      last_error = null
  from next_job
  where jobs.id = next_job.id
  returning jobs.*;
end;
$function$;

grant execute on function public.claim_gmail_agent_job(text, text) to anon, authenticated;

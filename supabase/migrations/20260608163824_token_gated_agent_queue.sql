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
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
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
    nullif(p_dedupe_key, ''),
    coalesce(p_priority, 50),
    greatest(coalesce(p_max_attempts, 3), 1)
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning * into inserted_job;

  if inserted_job.id is null then
    select *
    into inserted_job
    from public.agent_jobs
    where dedupe_key = p_dedupe_key
    order by created_at desc
    limit 1;
  end if;

  return inserted_job;
end;
$function$;

grant execute on function public.queue_agent_job(text, text, jsonb, text, integer, integer) to anon, authenticated;

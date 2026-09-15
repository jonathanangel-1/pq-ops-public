create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_snapshots (
  snapshot_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_tokens (
  token_name text primary key,
  token_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_jobs_status_check
    check (status = any (array[
      'queued'::text,
      'running'::text,
      'succeeded'::text,
      'failed'::text,
      'cancelled'::text,
      'waiting_external'::text
    ])),
  constraint agent_jobs_job_type_check
    check (job_type = any (array[
      'send_tms_agt_alert'::text,
      'send_gmail_email'::text,
      'email_refresh'::text,
      'eod_report'::text,
      'full_refresh'::text,
      'supabase_sync'::text
    ]))
);

create index if not exists agent_jobs_claim_idx
  on public.agent_jobs (priority, available_at, created_at)
  where status = 'queued';

create unique index if not exists agent_jobs_dedupe_key_unique
  on public.agent_jobs (dedupe_key)
  where dedupe_key is not null;

alter table public.app_snapshots enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.sync_tokens enable row level security;

drop policy if exists "dashboard snapshots are readable" on public.app_snapshots;
create policy "dashboard snapshots are readable"
  on public.app_snapshots
  for select
  to anon, authenticated
  using (true);

drop policy if exists "agent jobs are readable" on public.agent_jobs;
create policy "agent jobs are readable"
  on public.agent_jobs
  for select
  to anon, authenticated
  using (true);

drop policy if exists "agent jobs can be queued" on public.agent_jobs;
create policy "agent jobs can be queued"
  on public.agent_jobs
  for insert
  to anon, authenticated
  with check (
    status = 'queued'
    and job_type = any (array[
      'send_tms_agt_alert'::text,
      'email_refresh'::text,
      'full_refresh'::text,
      'supabase_sync'::text
    ])
  );

grant select on public.app_snapshots to anon, authenticated;
grant select, insert on public.agent_jobs to anon, authenticated;

create or replace function public.valid_sync_token(p_sync_token text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $function$
  select exists (
    select 1
    from public.sync_tokens
    where token_name = 'local_snapshot_writer'
      and token_hash = encode(extensions.digest(convert_to(p_sync_token, 'UTF8'), 'sha256'), 'hex')
  );
$function$;

create or replace function public.claim_agent_job(p_worker_id text, p_sync_token text)
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
      last_error = coalesce(last_error, 'Recovered stale running lock'),
      updated_at = now(),
      completed_at = case when attempts < max_attempts then null else now() end
  where status = 'running'
    and locked_at < now() - interval '15 minutes';

  return query
  with next_job as (
    select id
    from public.agent_jobs
    where status = 'queued'
      and job_type not in ('email_refresh', 'send_gmail_email')
      and available_at <= now()
    order by priority asc, created_at asc
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
    and job_type in ('email_refresh', 'send_gmail_email')
    and locked_at < now() - interval '15 minutes';

  return query
  with next_job as (
    select id
    from public.agent_jobs
    where status in ('queued', 'waiting_external')
      and job_type in ('email_refresh', 'send_gmail_email')
      and available_at <= now()
    order by priority asc, created_at asc
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

create or replace function public.complete_agent_job(
  p_job_id uuid,
  p_worker_id text,
  p_sync_token text,
  p_result jsonb default '{}'::jsonb
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  updated_job public.agent_jobs;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  update public.agent_jobs
  set status = 'succeeded',
      result = p_result,
      locked_by = null,
      locked_at = null,
      updated_at = now(),
      completed_at = now()
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id
  returning * into updated_job;

  if updated_job.id is null then
    raise exception 'job is not locked by this worker';
  end if;

  return updated_job;
end;
$function$;

create or replace function public.defer_agent_job(
  p_job_id uuid,
  p_worker_id text,
  p_sync_token text,
  p_result jsonb default '{}'::jsonb
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  updated_job public.agent_jobs;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  update public.agent_jobs
  set status = 'waiting_external',
      result = p_result,
      locked_by = null,
      locked_at = null,
      updated_at = now(),
      completed_at = null
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id
  returning * into updated_job;

  if updated_job.id is null then
    raise exception 'job is not locked by this worker';
  end if;

  return updated_job;
end;
$function$;

create or replace function public.fail_agent_job(
  p_job_id uuid,
  p_worker_id text,
  p_sync_token text,
  p_error text,
  p_retry_after_seconds integer default 60
)
returns public.agent_jobs
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  updated_job public.agent_jobs;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  update public.agent_jobs
  set status = case when attempts < max_attempts then 'queued' else 'failed' end,
      available_at = case when attempts < max_attempts then now() + make_interval(secs => greatest(p_retry_after_seconds, 1)) else available_at end,
      locked_by = null,
      locked_at = null,
      last_error = p_error,
      updated_at = now(),
      completed_at = case when attempts < max_attempts then null else now() end
  where id = p_job_id
    and status = 'running'
    and locked_by = p_worker_id
  returning * into updated_job;

  if updated_job.id is null then
    raise exception 'job is not locked by this worker';
  end if;

  return updated_job;
end;
$function$;

grant execute on function public.claim_agent_job(text, text) to anon, authenticated;
grant execute on function public.claim_gmail_agent_job(text, text) to anon, authenticated;
grant execute on function public.complete_agent_job(uuid, text, text, jsonb) to anon, authenticated;
grant execute on function public.defer_agent_job(uuid, text, text, jsonb) to anon, authenticated;
grant execute on function public.fail_agent_job(uuid, text, text, text, integer) to anon, authenticated;

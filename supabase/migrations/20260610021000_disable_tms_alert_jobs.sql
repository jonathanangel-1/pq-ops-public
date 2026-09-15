alter table public.agent_jobs
  drop constraint if exists agent_jobs_job_type_check;

alter table public.agent_jobs
  add constraint agent_jobs_job_type_check
  check (job_type = any (array[
    'send_gmail_email'::text,
    'draft_gmail_email'::text,
    'email_refresh'::text,
    'eod_report'::text,
    'full_refresh'::text,
    'supabase_sync'::text
  ]));

drop policy if exists "agent jobs can be queued" on public.agent_jobs;
create policy "agent jobs can be queued"
  on public.agent_jobs
  for insert
  to anon, authenticated
  with check (
    status = 'queued'
    and job_type = any (array[
      'draft_gmail_email'::text,
      'email_refresh'::text,
      'full_refresh'::text,
      'supabase_sync'::text
    ])
  );

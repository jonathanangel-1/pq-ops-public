alter table public.agent_jobs
  drop constraint if exists agent_jobs_job_type_check;

alter table public.agent_jobs
  add constraint agent_jobs_job_type_check
  check (job_type = any (array[
    'send_tms_agt_alert'::text,
    'send_gmail_email'::text,
    'email_refresh'::text,
    'eod_report'::text,
    'full_refresh'::text,
    'supabase_sync'::text
  ]));

create unique index if not exists agent_jobs_dedupe_key_unique
  on public.agent_jobs (dedupe_key)
  where dedupe_key is not null;

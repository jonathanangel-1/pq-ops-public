create or replace function public.read_app_snapshots(
  p_snapshot_keys text[],
  p_sync_token text
)
returns table (
  snapshot_key text,
  payload jsonb,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  allowed_snapshot_keys text[] := array[
    'shipment-truth-packets',
    'active-awb-index',
    'gmail-direct-state',
    'gmail-proof-snapshot',
    'gmail-refresh-health',
    'ops-brain-memory',
    'shipment-state',
    'shipment-events',
    'operator-notifications',
    'operational-fact-ledger',
    'companion-memory',
    'action-queue',
    'outbox-requests',
    'email-sync-requests',
    'money-sync-requests',
    'money-memory',
    'station-memory'
  ];
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  return query
  select s.snapshot_key, s.payload, s.updated_at
  from public.app_snapshots as s
  where s.snapshot_key = any(coalesce(p_snapshot_keys, array[]::text[]))
    and s.snapshot_key = any(allowed_snapshot_keys)
  order by s.snapshot_key;
end;
$function$;

create or replace function public.list_agent_job_summaries(
  p_limit integer,
  p_sync_token text
)
returns table (
  id uuid,
  job_type text,
  status text,
  action_id text,
  shipment_id text,
  awb text,
  outbox_request_id text,
  target_name text,
  target_email text,
  original_target_name text,
  original_target_email text,
  station_contact_missing boolean,
  reason text,
  subject text,
  type text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  last_error text,
  drafted boolean,
  sent boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  safe_limit integer := least(100, greatest(1, coalesce(p_limit, 60)));
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  return query
  select
    j.id,
    j.job_type,
    j.status,
    coalesce(j.payload ->> 'actionId', j.payload #>> '{action,id}', '') as action_id,
    coalesce(j.payload ->> 'shipmentId', j.payload #>> '{action,shipmentId}', '') as shipment_id,
    coalesce(j.payload ->> 'awb', j.payload #>> '{action,awb}', '') as awb,
    coalesce(j.payload ->> 'outboxRequestId', '') as outbox_request_id,
    coalesce(j.payload ->> 'targetName', j.payload #>> '{action,targetName}', '') as target_name,
    coalesce(j.payload ->> 'to', j.payload #>> '{action,targetEmail}', '') as target_email,
    coalesce(j.payload ->> 'originalTargetName', j.payload #>> '{action,originalTargetName}', '') as original_target_name,
    coalesce(j.payload ->> 'originalTargetEmail', j.payload #>> '{action,originalTargetEmail}', '') as original_target_email,
    lower(coalesce(j.payload ->> 'stationContactMissing', j.payload #>> '{action,stationContactMissing}', 'false')) = 'true'
      as station_contact_missing,
    coalesce(j.payload ->> 'reason', j.payload #>> '{action,reason}', '') as reason,
    coalesce(j.payload ->> 'subject', j.payload #>> '{action,subject}', '') as subject,
    coalesce(j.payload ->> 'type', j.payload #>> '{action,type}', j.job_type) as type,
    j.created_at,
    j.updated_at,
    j.completed_at,
    j.last_error,
    j.status = 'succeeded'
      and (
        j.job_type = 'draft_gmail_email'
        or lower(coalesce(j.result ->> 'drafted', 'false')) = 'true'
      ) as drafted,
    j.status = 'succeeded'
      and (
        lower(coalesce(j.result ->> 'sent', 'false')) = 'true'
        or j.job_type in ('send_tms_agt_alert', 'complete_tms_pod_closeout')
      ) as sent
  from public.agent_jobs as j
  where j.status = any (array[
    'queued'::text,
    'running'::text,
    'failed'::text,
    'waiting_external'::text,
    'succeeded'::text
  ])
  order by j.created_at desc
  limit safe_limit;
end;
$function$;

create or replace function public.recent_agent_jobs(
  p_job_type text,
  p_limit integer,
  p_sync_token text
)
returns table (
  id uuid,
  job_type text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  result jsonb,
  dedupe_key text
)
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  safe_limit integer := least(100, greatest(1, coalesce(p_limit, 20)));
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  return query
  select
    j.id,
    j.job_type,
    j.status,
    j.created_at,
    j.updated_at,
    j.locked_at,
    j.completed_at,
    j.last_error,
    j.result,
    j.dedupe_key
  from public.agent_jobs as j
  where j.job_type = p_job_type
  order by j.created_at desc
  limit safe_limit;
end;
$function$;

grant execute on function public.read_app_snapshots(text[], text) to anon, authenticated;
grant execute on function public.list_agent_job_summaries(integer, text) to anon, authenticated;
grant execute on function public.recent_agent_jobs(text, integer, text) to anon, authenticated;

drop policy if exists "dashboard snapshots are readable" on public.app_snapshots;
drop policy if exists "agent jobs are readable" on public.agent_jobs;
drop policy if exists "agent jobs can be queued" on public.agent_jobs;

revoke select on public.app_snapshots from anon, authenticated;
revoke select, insert on public.agent_jobs from anon, authenticated;
revoke select on public.agent_job_summaries from anon, authenticated;

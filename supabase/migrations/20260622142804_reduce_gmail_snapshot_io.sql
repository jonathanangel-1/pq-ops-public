create or replace function public.upsert_app_snapshot(
  p_snapshot_key text,
  p_payload jsonb,
  p_sync_token text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $function$
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  insert into public.app_snapshots (snapshot_key, payload, updated_at)
  values (p_snapshot_key, p_payload, now())
  on conflict (snapshot_key) do update
  set payload = excluded.payload,
      updated_at = excluded.updated_at
  where public.app_snapshots.payload is distinct from excluded.payload;
end;
$function$;

grant execute on function public.upsert_app_snapshot(text, jsonb, text) to anon, authenticated;

create index if not exists agent_jobs_dashboard_created_idx
  on public.agent_jobs (created_at desc)
  where status = any (array[
    'queued'::text,
    'running'::text,
    'failed'::text,
    'waiting_external'::text,
    'succeeded'::text
  ]);

create or replace view public.agent_job_summaries
with (security_invoker = true)
as
select
  id,
  job_type,
  status,
  coalesce(payload ->> 'actionId', payload #>> '{action,id}', '') as action_id,
  coalesce(payload ->> 'shipmentId', payload #>> '{action,shipmentId}', '') as shipment_id,
  coalesce(payload ->> 'awb', payload #>> '{action,awb}', '') as awb,
  coalesce(payload ->> 'outboxRequestId', '') as outbox_request_id,
  coalesce(payload ->> 'targetName', payload #>> '{action,targetName}', '') as target_name,
  coalesce(payload ->> 'to', payload #>> '{action,targetEmail}', '') as target_email,
  coalesce(payload ->> 'originalTargetName', payload #>> '{action,originalTargetName}', '') as original_target_name,
  coalesce(payload ->> 'originalTargetEmail', payload #>> '{action,originalTargetEmail}', '') as original_target_email,
  lower(coalesce(payload ->> 'stationContactMissing', payload #>> '{action,stationContactMissing}', 'false')) = 'true'
    as station_contact_missing,
  coalesce(payload ->> 'reason', payload #>> '{action,reason}', '') as reason,
  coalesce(payload ->> 'subject', payload #>> '{action,subject}', '') as subject,
  coalesce(payload ->> 'type', payload #>> '{action,type}', job_type) as type,
  created_at,
  updated_at,
  completed_at,
  last_error,
  status = 'succeeded'
    and (
      job_type = 'draft_gmail_email'
      or lower(coalesce(result ->> 'drafted', 'false')) = 'true'
    ) as drafted,
  status = 'succeeded'
    and (
      lower(coalesce(result ->> 'sent', 'false')) = 'true'
      or job_type in ('send_tms_agt_alert', 'complete_tms_pod_closeout')
    ) as sent
from public.agent_jobs;

revoke all on public.agent_job_summaries from anon, authenticated;
grant select on public.agent_job_summaries to anon, authenticated;

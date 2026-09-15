create or replace function public.read_app_snapshot_metadata(
  p_snapshot_keys text[],
  p_sync_token text
)
returns table (
  snapshot_key text,
  snapshot_time text,
  updated_at timestamptz,
  writer_version text,
  content_signature text
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
  select
    s.snapshot_key,
    nullif(s.payload ->> 'snapshotTime', '') as snapshot_time,
    s.updated_at,
    nullif(s.payload ->> 'writerVersion', '') as writer_version,
    nullif(s.payload ->> 'contentSignature', '') as content_signature
  from public.app_snapshots as s
  where s.snapshot_key = any(coalesce(p_snapshot_keys, array[]::text[]))
    and s.snapshot_key = any(allowed_snapshot_keys)
  order by s.snapshot_key;
end;
$function$;

revoke all on function public.read_app_snapshot_metadata(text[], text) from public;
grant execute on function public.read_app_snapshot_metadata(text[], text) to anon, authenticated;

-- Carrier tracking snapshots must be READABLE by the token-gated RPCs or the
-- gmail-refresh cron rebuild is structurally blind to the only source holding
-- a dated carrier ETA (INC-2026-07-05-ETA-SELF-FEEDBACK-AND-SEVERED-CARRIER-CHANNEL).
-- Writes already succeed (upsert_app_snapshot has no key allowlist); this
-- migration only extends the READ allowlists by the three carrier keys.
-- Redeclares the latest definitions of both read RPCs verbatim + three keys.

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
    'station-memory',
    'united-tracking-snapshot',
    'elal-tracking-snapshot',
    'other-tracking-snapshot'
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
    'station-memory',
    'united-tracking-snapshot',
    'elal-tracking-snapshot',
    'other-tracking-snapshot'
  ];
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  return query
  select
    m.snapshot_key,
    m.snapshot_time,
    m.updated_at,
    m.writer_version,
    m.content_signature
  from public.app_snapshot_metadata as m
  where m.snapshot_key = any(coalesce(p_snapshot_keys, array[]::text[]))
    and m.snapshot_key = any(allowed_snapshot_keys)
  order by m.snapshot_key;
end;
$function$;

revoke all on function public.read_app_snapshots(text[], text) from public;
revoke all on function public.read_app_snapshot_metadata(text[], text) from public;
grant execute on function public.read_app_snapshots(text[], text) to anon, authenticated;
grant execute on function public.read_app_snapshot_metadata(text[], text) to anon, authenticated;

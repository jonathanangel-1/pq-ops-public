create table if not exists public.app_snapshot_metadata (
  snapshot_key text primary key,
  snapshot_time text,
  updated_at timestamptz not null default now(),
  writer_version text,
  content_signature text,
  payload_bytes integer
);

insert into public.app_snapshot_metadata (
  snapshot_key,
  snapshot_time,
  updated_at,
  writer_version,
  content_signature,
  payload_bytes
)
select
  s.snapshot_key,
  nullif(s.payload ->> 'snapshotTime', '') as snapshot_time,
  s.updated_at,
  nullif(s.payload ->> 'writerVersion', '') as writer_version,
  nullif(s.payload ->> 'contentSignature', '') as content_signature,
  pg_column_size(s.payload)::integer as payload_bytes
from public.app_snapshots as s
on conflict (snapshot_key) do update
set snapshot_time = excluded.snapshot_time,
    updated_at = excluded.updated_at,
    writer_version = excluded.writer_version,
    content_signature = excluded.content_signature,
    payload_bytes = excluded.payload_bytes
where public.app_snapshot_metadata.snapshot_time is distinct from excluded.snapshot_time
  or public.app_snapshot_metadata.updated_at is distinct from excluded.updated_at
  or public.app_snapshot_metadata.writer_version is distinct from excluded.writer_version
  or public.app_snapshot_metadata.content_signature is distinct from excluded.content_signature
  or public.app_snapshot_metadata.payload_bytes is distinct from excluded.payload_bytes;

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
declare
  v_updated_at timestamptz := now();
  v_snapshot_time text := nullif(p_payload ->> 'snapshotTime', '');
  v_writer_version text := nullif(p_payload ->> 'writerVersion', '');
  v_content_signature text := nullif(p_payload ->> 'contentSignature', '');
  v_payload_bytes integer := pg_column_size(p_payload)::integer;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  with upserted as (
    insert into public.app_snapshots (snapshot_key, payload, updated_at)
    values (p_snapshot_key, p_payload, v_updated_at)
    on conflict (snapshot_key) do update
    set payload = excluded.payload,
        updated_at = excluded.updated_at
    where case
      when excluded.payload ? 'contentSignature'
      then coalesce(public.app_snapshots.payload->>'contentSignature', '')
        is distinct from excluded.payload->>'contentSignature'
      when public.app_snapshots.payload ? 'contentSignature'
      then true
      else public.app_snapshots.payload is distinct from excluded.payload
    end
    returning snapshot_key, updated_at
  )
  insert into public.app_snapshot_metadata (
    snapshot_key,
    snapshot_time,
    updated_at,
    writer_version,
    content_signature,
    payload_bytes
  )
  select
    upserted.snapshot_key,
    v_snapshot_time,
    upserted.updated_at,
    v_writer_version,
    v_content_signature,
    v_payload_bytes
  from upserted
  on conflict (snapshot_key) do update
  set snapshot_time = excluded.snapshot_time,
      updated_at = excluded.updated_at,
      writer_version = excluded.writer_version,
      content_signature = excluded.content_signature,
      payload_bytes = excluded.payload_bytes
  where public.app_snapshot_metadata.snapshot_time is distinct from excluded.snapshot_time
    or public.app_snapshot_metadata.updated_at is distinct from excluded.updated_at
    or public.app_snapshot_metadata.writer_version is distinct from excluded.writer_version
    or public.app_snapshot_metadata.content_signature is distinct from excluded.content_signature
    or public.app_snapshot_metadata.payload_bytes is distinct from excluded.payload_bytes;
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
    'station-memory'
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

alter table public.app_snapshot_metadata enable row level security;

revoke all on table public.app_snapshot_metadata from anon, authenticated;
revoke all on table public.app_snapshot_metadata from public;
revoke all on function public.read_app_snapshot_metadata(text[], text) from public;
revoke all on function public.upsert_app_snapshot(text, jsonb, text) from public;
grant execute on function public.read_app_snapshot_metadata(text[], text) to anon, authenticated;
grant execute on function public.upsert_app_snapshot(text, jsonb, text) to anon, authenticated;

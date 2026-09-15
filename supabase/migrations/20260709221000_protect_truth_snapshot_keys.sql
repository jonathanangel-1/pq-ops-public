-- Phase the production-authority handoff without freezing truth during shadow.
-- Ordinary snapshot keys retain their existing upsert and metadata semantics.
-- The two legacy production projections remain writable only until the first
-- relational production head exists. The legacy RPC and relational production
-- CAS share the same transaction advisory lock, so that first CAS publication
-- atomically becomes the sole production authority.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.upsert_app_snapshot(
  p_snapshot_key text,
  p_payload jsonb,
  p_sync_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_updated_at timestamptz := now();
  v_snapshot_time text := nullif(p_payload ->> 'snapshotTime', '');
  v_writer_version text := nullif(p_payload ->> 'writerVersion', '');
  v_content_signature text := nullif(p_payload ->> 'contentSignature', '');
  v_payload_bytes integer := pg_column_size(p_payload)::integer;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_snapshot_key = any (array['shipment-truth-packets', 'active-awb-index']) then
    perform pg_advisory_xact_lock(hashtextextended(
      'truth-publication:primary:production',
      0
    ));
    if exists (
      select 1
      from public.truth_publication_heads head
      where head.workspace_key = 'primary'
        and head.channel = 'production'
    ) then
      raise exception 'canonical truth snapshots require publish_truth_build_cas after relational production cutover'
        using errcode = '42501';
    end if;
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

create or replace function public.upsert_app_snapshot(
  p_snapshot_key text,
  p_payload jsonb,
  p_sync_token text
)
returns void
language sql
security invoker
set search_path = ''
as $function$
  select private.upsert_app_snapshot(p_snapshot_key, p_payload, p_sync_token);
$function$;

-- API roles may read through the existing locked-down read RPCs, but they may
-- not bypass the guarded upsert or delete a canonical projection directly.
revoke insert, update, delete, truncate on public.app_snapshots
  from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.app_snapshot_metadata
  from public, anon, authenticated, service_role;

revoke all on function private.upsert_app_snapshot(text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.upsert_app_snapshot(text, jsonb, text)
  from public, anon, authenticated;

-- Transitional compatibility: source-sync and legacy Gmail workers still use
-- the anon key plus the separate sync token for non-protected snapshots. Keep
-- that RPC contract during shadow migration, but do not restore direct table
-- DML. A later credential cutover can remove anon/authenticated from these
-- grants without changing the function contract.
grant usage on schema private to anon, authenticated, service_role;
grant execute on function private.upsert_app_snapshot(text, jsonb, text)
  to anon, authenticated, service_role;
grant execute on function public.upsert_app_snapshot(text, jsonb, text)
  to anon, authenticated, service_role;

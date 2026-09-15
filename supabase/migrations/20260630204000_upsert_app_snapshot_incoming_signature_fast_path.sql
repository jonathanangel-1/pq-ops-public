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
  where case
    when excluded.payload ? 'contentSignature'
    then coalesce(public.app_snapshots.payload->>'contentSignature', '')
      is distinct from excluded.payload->>'contentSignature'
    when public.app_snapshots.payload ? 'contentSignature'
    then true
    else public.app_snapshots.payload is distinct from excluded.payload
  end;
end;
$function$;

grant execute on function public.upsert_app_snapshot(text, jsonb, text) to anon, authenticated;

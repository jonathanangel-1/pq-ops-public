create table if not exists public.ops_station_contexts (
  station_context_id text primary key,
  airport_code text not null,
  airline text,
  handler_name text,
  station_email text,
  station_phone text,
  aliases jsonb not null default '[]'::jsonb,
  facts jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  snapshot_time timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ops_station_contexts enable row level security;

create index if not exists ops_station_contexts_airport_code_idx
  on public.ops_station_contexts (airport_code);

create or replace function public.sync_station_context_memory(p_payload jsonb, p_sync_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  station jsonb;
  snapshot_time timestamptz;
  v_station_id text;
  v_airport_code text;
  synced_stations integer := 0;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  snapshot_time := nullif(p_payload->>'snapshotTime', '')::timestamptz;

  for station in
    select value from jsonb_array_elements(coalesce(p_payload->'stations', '[]'::jsonb))
  loop
    v_station_id := nullif(trim(station->>'id'), '');
    v_airport_code := nullif(upper(trim(station->>'airport')), '');

    if v_station_id is null or v_airport_code is null then
      continue;
    end if;

    insert into public.ops_station_contexts (
      station_context_id,
      airport_code,
      airline,
      handler_name,
      station_email,
      station_phone,
      aliases,
      facts,
      context,
      snapshot_time,
      updated_at
    )
    values (
      v_station_id,
      v_airport_code,
      nullif(station->>'airline', ''),
      nullif(coalesce(station->>'stationName', station->>'handlerName'), ''),
      nullif(coalesce(station->>'stationEmail', station#>>'{contact,email}'), ''),
      nullif(coalesce(station->>'stationPhone', station#>>'{contact,phone}'), ''),
      coalesce(station->'aliases', '[]'::jsonb),
      coalesce(station->'facts', '[]'::jsonb),
      station,
      snapshot_time,
      now()
    )
    on conflict (station_context_id) do update
    set airport_code = excluded.airport_code,
        airline = coalesce(excluded.airline, ops_station_contexts.airline),
        handler_name = coalesce(excluded.handler_name, ops_station_contexts.handler_name),
        station_email = coalesce(excluded.station_email, ops_station_contexts.station_email),
        station_phone = coalesce(excluded.station_phone, ops_station_contexts.station_phone),
        aliases = excluded.aliases,
        facts = excluded.facts,
        context = excluded.context,
        snapshot_time = excluded.snapshot_time,
        updated_at = excluded.updated_at;

    synced_stations := synced_stations + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'stations', synced_stations,
    'syncedAt', now()
  );
end;
$function$;

grant execute on function public.sync_station_context_memory(jsonb, text) to anon, authenticated;

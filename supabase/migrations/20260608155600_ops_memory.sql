create table if not exists public.ops_clients (
  client_key text primary key,
  display_name text not null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_stations (
  airport_code text primary key,
  station_email text,
  station_phone text,
  handler_name text,
  handler_email text,
  handler_phone text,
  context jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_brokers (
  broker_key text primary key,
  broker_type text not null check (broker_type in ('customs', 'freight')),
  display_name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  context jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_shipments (
  awb text primary key,
  shipment_id text,
  station_code text references public.ops_stations (airport_code),
  client_key text references public.ops_clients (client_key),
  airline text,
  eta_text text,
  arrival_status text,
  clearance_status text,
  pickup_status text,
  ops_phase text,
  ops_label text,
  next_action text,
  consignee text,
  destination_address text,
  customs_broker_key text references public.ops_brokers (broker_key),
  freight_broker_key text references public.ops_brokers (broker_key),
  current_payload jsonb not null default '{}'::jsonb,
  snapshot_time timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ops_action_history (
  event_id text primary key,
  awb text not null references public.ops_shipments (awb) on delete cascade,
  action_id text,
  action_type text,
  label text,
  channel text,
  status text,
  target_name text,
  target_email text,
  cc text,
  subject text,
  summary text,
  event_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ops_clients enable row level security;
alter table public.ops_stations enable row level security;
alter table public.ops_brokers enable row level security;
alter table public.ops_shipments enable row level security;
alter table public.ops_action_history enable row level security;

create index if not exists ops_shipments_station_code_idx on public.ops_shipments (station_code);
create index if not exists ops_shipments_client_key_idx on public.ops_shipments (client_key);
create index if not exists ops_shipments_customs_broker_key_idx on public.ops_shipments (customs_broker_key);
create index if not exists ops_shipments_freight_broker_key_idx on public.ops_shipments (freight_broker_key);
create index if not exists ops_shipments_ops_phase_idx on public.ops_shipments (ops_phase);
create index if not exists ops_action_history_awb_event_at_idx on public.ops_action_history (awb, event_at desc);

create or replace function public.sync_ops_memory(p_payload jsonb, p_sync_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  shipment jsonb;
  event jsonb;
  snapshot_time timestamptz;
  v_awb_key text;
  v_station_key text;
  v_client_name text;
  v_client_key text;
  v_customs_name text;
  v_customs_key text;
  v_freight_name text;
  v_freight_key text;
  inserted_shipments integer := 0;
  inserted_events integer := 0;
begin
  if not exists (
    select 1
    from public.sync_tokens
    where token_name = 'local_snapshot_writer'
      and token_hash = encode(extensions.digest(convert_to(p_sync_token, 'UTF8'), 'sha256'), 'hex')
  ) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  snapshot_time := nullif(p_payload->>'snapshotTime', '')::timestamptz;

  for shipment in
    select value from jsonb_array_elements(coalesce(p_payload->'shipments', '[]'::jsonb))
  loop
    v_awb_key := nullif(trim(shipment->>'awb'), '');
    if v_awb_key is null then
      continue;
    end if;

    v_station_key := nullif(upper(trim(coalesce(shipment->>'station', shipment#>>'{delivery,airport}'))), '');
    v_client_name := nullif(trim(shipment->>'client'), '');
    v_client_key := nullif(lower(regexp_replace(coalesce(v_client_name, ''), '\s+', ' ', 'g')), '');
    v_customs_name := nullif(trim(shipment#>>'{customsBroker,broker}'), '');
    v_customs_key := case when v_customs_name is null then null else 'customs:' || lower(regexp_replace(v_customs_name, '\s+', ' ', 'g')) end;
    v_freight_name := nullif(trim(shipment#>>'{freightBroker,broker}'), '');
    v_freight_key := case when v_freight_name is null then null else 'freight:' || lower(regexp_replace(v_freight_name, '\s+', ' ', 'g')) end;

    if v_client_key is not null then
      insert into public.ops_clients (client_key, display_name, updated_at)
      values (v_client_key, v_client_name, now())
      on conflict (client_key) do update
      set display_name = excluded.display_name,
          updated_at = excluded.updated_at;
    end if;

    if v_station_key is not null then
      insert into public.ops_stations (
        airport_code,
        station_email,
        station_phone,
        handler_name,
        handler_email,
        handler_phone,
        context,
        updated_at
      )
      values (
        v_station_key,
        nullif(shipment->>'stationEmail', ''),
        nullif(shipment->>'stationPhone', ''),
        nullif(shipment#>>'{stationContext,handler}', ''),
        nullif(shipment#>>'{stationContext,email}', ''),
        nullif(shipment#>>'{stationContext,phone}', ''),
        coalesce(shipment->'stationContext', '{}'::jsonb),
        now()
      )
      on conflict (airport_code) do update
      set station_email = coalesce(excluded.station_email, ops_stations.station_email),
          station_phone = coalesce(excluded.station_phone, ops_stations.station_phone),
          handler_name = coalesce(excluded.handler_name, ops_stations.handler_name),
          handler_email = coalesce(excluded.handler_email, ops_stations.handler_email),
          handler_phone = coalesce(excluded.handler_phone, ops_stations.handler_phone),
          context = ops_stations.context || excluded.context,
          updated_at = excluded.updated_at;
    end if;

    if v_customs_key is not null then
      insert into public.ops_brokers (
        broker_key,
        broker_type,
        display_name,
        contact_name,
        contact_email,
        contact_phone,
        context,
        updated_at
      )
      values (
        v_customs_key,
        'customs',
        v_customs_name,
        nullif(shipment#>>'{customsBroker,contactName}', ''),
        nullif(shipment#>>'{customsBroker,contactEmail}', ''),
        nullif(shipment#>>'{customsBroker,contactPhone}', ''),
        coalesce(shipment->'customsBroker', '{}'::jsonb),
        now()
      )
      on conflict (broker_key) do update
      set display_name = excluded.display_name,
          contact_name = coalesce(excluded.contact_name, ops_brokers.contact_name),
          contact_email = coalesce(excluded.contact_email, ops_brokers.contact_email),
          contact_phone = coalesce(excluded.contact_phone, ops_brokers.contact_phone),
          context = ops_brokers.context || excluded.context,
          updated_at = excluded.updated_at;
    end if;

    if v_freight_key is not null then
      insert into public.ops_brokers (
        broker_key,
        broker_type,
        display_name,
        contact_email,
        contact_phone,
        context,
        updated_at
      )
      values (
        v_freight_key,
        'freight',
        v_freight_name,
        nullif(shipment#>>'{freightBroker,contactEmail}', ''),
        nullif(shipment#>>'{freightBroker,contactPhone}', ''),
        coalesce(shipment->'freightBroker', '{}'::jsonb),
        now()
      )
      on conflict (broker_key) do update
      set display_name = excluded.display_name,
          contact_email = coalesce(excluded.contact_email, ops_brokers.contact_email),
          contact_phone = coalesce(excluded.contact_phone, ops_brokers.contact_phone),
          context = ops_brokers.context || excluded.context,
          updated_at = excluded.updated_at;
    end if;

    insert into public.ops_shipments (
      awb,
      shipment_id,
      station_code,
      client_key,
      airline,
      eta_text,
      arrival_status,
      clearance_status,
      pickup_status,
      ops_phase,
      ops_label,
      next_action,
      consignee,
      destination_address,
      customs_broker_key,
      freight_broker_key,
      current_payload,
      snapshot_time,
      updated_at
    )
    values (
      v_awb_key,
      nullif(shipment->>'id', ''),
      v_station_key,
      v_client_key,
      nullif(shipment->>'airline', ''),
      nullif(shipment->>'eta', ''),
      nullif(shipment->>'arrivalStatus', ''),
      nullif(shipment->>'clearanceStatus', ''),
      nullif(shipment->>'pickupStatus', ''),
      nullif(shipment#>>'{opsState,phase}', ''),
      nullif(shipment#>>'{opsState,label}', ''),
      nullif(coalesce(shipment#>>'{opsState,nextAction}', shipment->>'nextAction'), ''),
      nullif(coalesce(shipment#>>'{delivery,consignee}', shipment->>'consignee'), ''),
      nullif(coalesce(shipment#>>'{delivery,fullAddress}', shipment->>'address'), ''),
      v_customs_key,
      v_freight_key,
      shipment,
      snapshot_time,
      now()
    )
    on conflict (awb) do update
    set shipment_id = excluded.shipment_id,
        station_code = excluded.station_code,
        client_key = excluded.client_key,
        airline = excluded.airline,
        eta_text = excluded.eta_text,
        arrival_status = excluded.arrival_status,
        clearance_status = excluded.clearance_status,
        pickup_status = excluded.pickup_status,
        ops_phase = excluded.ops_phase,
        ops_label = excluded.ops_label,
        next_action = excluded.next_action,
        consignee = excluded.consignee,
        destination_address = excluded.destination_address,
        customs_broker_key = excluded.customs_broker_key,
        freight_broker_key = excluded.freight_broker_key,
        current_payload = excluded.current_payload,
        snapshot_time = excluded.snapshot_time,
        updated_at = excluded.updated_at;

    inserted_shipments := inserted_shipments + 1;

    for event in
      select value from jsonb_array_elements(coalesce(shipment->'actionHistory', '[]'::jsonb))
    loop
      insert into public.ops_action_history (
        event_id,
        awb,
        action_id,
        action_type,
        label,
        channel,
        status,
        target_name,
        target_email,
        cc,
        subject,
        summary,
        event_at,
        payload,
        updated_at
      )
      values (
        coalesce(nullif(event->>'id', ''), v_awb_key || ':' || coalesce(event->>'actionId', md5(event::text))),
        v_awb_key,
        nullif(event->>'actionId', ''),
        nullif(event->>'type', ''),
        nullif(event->>'label', ''),
        nullif(event->>'channel', ''),
        nullif(event->>'status', ''),
        nullif(event->>'targetName', ''),
        nullif(event->>'targetEmail', ''),
        nullif(event->>'cc', ''),
        nullif(event->>'subject', ''),
        nullif(event->>'summary', ''),
        nullif(event->>'at', '')::timestamptz,
        event,
        now()
      )
      on conflict (event_id) do update
      set action_id = excluded.action_id,
          action_type = excluded.action_type,
          label = excluded.label,
          channel = excluded.channel,
          status = excluded.status,
          target_name = excluded.target_name,
          target_email = excluded.target_email,
          cc = excluded.cc,
          subject = excluded.subject,
          summary = excluded.summary,
          event_at = excluded.event_at,
          payload = excluded.payload,
          updated_at = excluded.updated_at;

      inserted_events := inserted_events + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'shipments', inserted_shipments,
    'actionEvents', inserted_events,
    'syncedAt', now()
  );
end;
$function$;

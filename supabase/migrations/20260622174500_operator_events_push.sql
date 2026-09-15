create extension if not exists pgcrypto with schema extensions;

create table if not exists public.operator_events (
  event_id text primary key,
  awb text not null,
  event_type text not null,
  severity text not null default 'work',
  status text not null default 'active',
  title text not null default '',
  subtitle text not null default '',
  message text not null default '',
  next_action text not null default '',
  occurred_at timestamptz not null default now(),
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz,
  handled_at timestamptz,
  snoozed_until timestamptz,
  source jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_events_severity_check
    check (severity = any (array['immediate'::text, 'urgent'::text, 'work'::text, 'today'::text, 'info'::text])),
  constraint operator_events_status_check
    check (status = any (array['active'::text, 'snoozed'::text, 'handled'::text, 'dismissed'::text]))
);

create table if not exists public.operator_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  label text not null default '',
  user_agent text not null default '',
  enabled boolean not null default true,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.operator_push_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references public.operator_events(event_id) on delete cascade,
  subscription_id uuid not null references public.operator_push_subscriptions(id) on delete cascade,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint operator_push_outbox_unique unique (event_id, subscription_id),
  constraint operator_push_outbox_status_check
    check (status = any (array['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text]))
);

create table if not exists public.operator_action_ledger (
  id uuid primary key default gen_random_uuid(),
  event_id text references public.operator_events(event_id) on delete set null,
  action_type text not null,
  actor text not null default 'operator',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists operator_events_awb_idx
  on public.operator_events (regexp_replace(awb, '\D', '', 'g'), occurred_at desc);

create index if not exists operator_events_active_idx
  on public.operator_events (status, severity, occurred_at desc)
  where status in ('active', 'snoozed');

create index if not exists operator_push_outbox_claim_idx
  on public.operator_push_outbox (status, created_at)
  where status in ('pending', 'failed');

create index if not exists operator_action_ledger_event_idx
  on public.operator_action_ledger (event_id, created_at desc);

alter table public.operator_events enable row level security;
alter table public.operator_push_subscriptions enable row level security;
alter table public.operator_push_outbox enable row level security;
alter table public.operator_action_ledger enable row level security;

revoke all on public.operator_events from anon, authenticated, public;
revoke all on public.operator_push_subscriptions from anon, authenticated, public;
revoke all on public.operator_push_outbox from anon, authenticated, public;
revoke all on public.operator_action_ledger from anon, authenticated, public;

grant select, insert, update, delete on public.operator_events to service_role;
grant select, insert, update, delete on public.operator_push_subscriptions to service_role;
grant select, insert, update, delete on public.operator_push_outbox to service_role;
grant select, insert, update, delete on public.operator_action_ledger to service_role;

create or replace function public.operator_event_is_pushable(p_event_type text, p_severity text)
returns boolean
language sql
immutable
as $function$
  select
    lower(coalesce(p_event_type, '')) = any (array[
      'morning-report',
      'pickup-location-requested',
      'pickup-docs-needed',
      'driver-waiting',
      'station-release-not-visible',
      'airline-transmission-blocker',
      'piece-count-mismatch',
      'storage-or-detention-cost',
      'pickup-onsite',
      'pickup-loaded',
      'delivered-pod-received',
      'delivered-pod-missing'
    ]);
$function$;

create or replace function public.upsert_operator_events(p_events jsonb, p_sync_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_event_count integer := 0;
  v_outbox_count integer := 0;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  with input_events as (
    select value as item
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
    where nullif(value->>'eventId', '') is not null
      and nullif(value->>'awb', '') is not null
  ),
  normalized as (
    select
      item->>'eventId' as event_id,
      item->>'awb' as awb,
      coalesce(nullif(item->>'eventType', ''), nullif(item->>'type', ''), 'operator-event') as event_type,
      coalesce(nullif(item->>'severity', ''), 'work') as severity,
      coalesce(nullif(item->>'status', ''), 'active') as status,
      coalesce(item->>'title', '') as title,
      coalesce(item->>'subtitle', '') as subtitle,
      coalesce(item->>'message', '') as message,
      coalesce(nullif(item->>'nextAction', ''), nullif(item->>'next_action', ''), '') as next_action,
      case
        when nullif(item->>'occurredAt', '') is null then now()
        else (item->>'occurredAt')::timestamptz
      end as occurred_at,
      case
        when nullif(item->>'createdAt', '') is null then now()
        else (item->>'createdAt')::timestamptz
      end as detected_at,
      coalesce(item->'source', '{}'::jsonb) as source,
      item as payload
    from input_events
  ),
  upserted as (
    insert into public.operator_events (
      event_id,
      awb,
      event_type,
      severity,
      status,
      title,
      subtitle,
      message,
      next_action,
      occurred_at,
      detected_at,
      last_seen_at,
      source,
      payload
    )
    select
      event_id,
      awb,
      event_type,
      severity,
      status,
      title,
      subtitle,
      message,
      next_action,
      occurred_at,
      detected_at,
      now(),
      source,
      payload
    from normalized
    on conflict (event_id) do update
    set awb = excluded.awb,
        event_type = excluded.event_type,
        severity = excluded.severity,
        status = case
          when public.operator_events.status in ('handled', 'dismissed') then public.operator_events.status
          when public.operator_events.status = 'snoozed'
            and public.operator_events.snoozed_until is not null
            and public.operator_events.snoozed_until > now()
            then public.operator_events.status
          else excluded.status
        end,
        title = excluded.title,
        subtitle = excluded.subtitle,
        message = excluded.message,
        next_action = excluded.next_action,
        occurred_at = excluded.occurred_at,
        detected_at = least(public.operator_events.detected_at, excluded.detected_at),
        last_seen_at = now(),
        source = excluded.source,
        payload = excluded.payload,
        updated_at = now()
    where public.operator_events.awb is distinct from excluded.awb
      or public.operator_events.event_type is distinct from excluded.event_type
      or public.operator_events.severity is distinct from excluded.severity
      or public.operator_events.status is distinct from excluded.status
      or public.operator_events.title is distinct from excluded.title
      or public.operator_events.subtitle is distinct from excluded.subtitle
      or public.operator_events.message is distinct from excluded.message
      or public.operator_events.next_action is distinct from excluded.next_action
      or public.operator_events.occurred_at is distinct from excluded.occurred_at
      or public.operator_events.source is distinct from excluded.source
      or public.operator_events.payload is distinct from excluded.payload
    returning event_id, event_type, severity, status
  ),
  queued as (
    insert into public.operator_push_outbox (event_id, subscription_id, status)
    select upserted.event_id, sub.id, 'pending'
    from upserted
    cross join public.operator_push_subscriptions sub
    where upserted.status = 'active'
      and sub.enabled
      and sub.revoked_at is null
      and public.operator_event_is_pushable(upserted.event_type, upserted.severity)
    on conflict (event_id, subscription_id) do nothing
    returning 1
  )
  select
    (select count(*) from upserted),
    (select count(*) from queued)
  into v_event_count, v_outbox_count;

  return jsonb_build_object(
    'ok', true,
    'eventCount', coalesce(v_event_count, 0),
    'queuedPushCount', coalesce(v_outbox_count, 0)
  );
end;
$function$;

create or replace function public.upsert_operator_push_subscription(p_subscription jsonb, p_sync_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_endpoint text := p_subscription->>'endpoint';
  v_p256dh text := p_subscription #>> '{keys,p256dh}';
  v_auth text := p_subscription #>> '{keys,auth}';
  v_device_id text;
  v_row public.operator_push_subscriptions;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(v_endpoint, '') is null or nullif(v_p256dh, '') is null or nullif(v_auth, '') is null then
    raise exception 'invalid push subscription' using errcode = '22023';
  end if;

  v_device_id := coalesce(
    nullif(p_subscription->>'deviceId', ''),
    encode(extensions.digest(convert_to(v_endpoint, 'UTF8'), 'sha256'), 'hex')
  );

  insert into public.operator_push_subscriptions (
    device_id,
    endpoint,
    p256dh,
    auth,
    label,
    user_agent,
    enabled,
    revoked_at,
    last_seen_at
  )
  values (
    v_device_id,
    v_endpoint,
    v_p256dh,
    v_auth,
    coalesce(p_subscription->>'label', ''),
    coalesce(p_subscription->>'userAgent', ''),
    true,
    null,
    now()
  )
  on conflict (endpoint) do update
  set device_id = excluded.device_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      label = excluded.label,
      user_agent = excluded.user_agent,
      enabled = true,
      revoked_at = null,
      last_seen_at = now(),
      updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'subscriptionId', v_row.id,
    'deviceId', v_row.device_id,
    'enabled', v_row.enabled
  );
end;
$function$;

create or replace function public.list_operator_events(p_sync_token text, p_limit integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_result jsonb;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'eventId', event_id,
      'id', event_id,
      'awb', awb,
      'eventType', event_type,
      'type', event_type,
      'severity', severity,
      'status', status,
      'title', title,
      'subtitle', subtitle,
      'message', message,
      'nextAction', next_action,
      'occurredAt', occurred_at,
      'createdAt', detected_at,
      'source', source,
      'payload', payload
    )
    order by occurred_at asc
  ), '[]'::jsonb)
  into v_result
  from (
    select *
    from public.operator_events
    where status = 'active'
       or (status = 'snoozed' and (snoozed_until is null or snoozed_until <= now()))
    order by occurred_at desc
    limit least(greatest(coalesce(p_limit, 40), 1), 100)
  ) events;

  return v_result;
end;
$function$;

create or replace function public.claim_operator_push_outbox(p_sync_token text, p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_result jsonb;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  with claimable as (
    select outbox.id
    from public.operator_push_outbox outbox
    join public.operator_events event on event.event_id = outbox.event_id
    join public.operator_push_subscriptions sub on sub.id = outbox.subscription_id
    where outbox.status in ('pending', 'failed')
      and outbox.attempt_count < outbox.max_attempts
      and event.status = 'active'
      and sub.enabled
      and sub.revoked_at is null
    order by outbox.created_at asc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update skip locked
  ),
  updated as (
    update public.operator_push_outbox outbox
    set status = 'sending',
        attempt_count = outbox.attempt_count + 1,
        last_error = null,
        updated_at = now()
    from claimable
    where outbox.id = claimable.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'outboxId', updated.id,
      'eventId', event.event_id,
      'subscriptionId', sub.id,
      'endpoint', sub.endpoint,
      'keys', jsonb_build_object('p256dh', sub.p256dh, 'auth', sub.auth),
      'attemptCount', updated.attempt_count,
      'event', jsonb_build_object(
        'eventId', event.event_id,
        'id', event.event_id,
        'awb', event.awb,
        'eventType', event.event_type,
        'type', event.event_type,
        'severity', event.severity,
        'title', event.title,
        'subtitle', event.subtitle,
        'message', event.message,
        'nextAction', event.next_action,
        'occurredAt', event.occurred_at,
        'source', event.source
      )
    )
    order by updated.created_at asc
  ), '[]'::jsonb)
  into v_result
  from updated
  join public.operator_events event on event.event_id = updated.event_id
  join public.operator_push_subscriptions sub on sub.id = updated.subscription_id;

  return v_result;
end;
$function$;

create or replace function public.complete_operator_push_outbox(
  p_outbox_id uuid,
  p_status text,
  p_error text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_status text := lower(coalesce(p_status, 'failed'));
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if v_status not in ('sent', 'failed', 'skipped') then
    raise exception 'invalid push outbox status' using errcode = '22023';
  end if;

  update public.operator_push_outbox
  set status = v_status,
      last_error = nullif(p_error, ''),
      sent_at = case when v_status = 'sent' then now() else sent_at end,
      updated_at = now()
  where id = p_outbox_id;

  return jsonb_build_object('ok', true, 'outboxId', p_outbox_id, 'status', v_status);
end;
$function$;

create or replace function public.record_operator_event_action(
  p_event_id text,
  p_action_type text,
  p_payload jsonb,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_action_type text := lower(coalesce(p_action_type, 'action'));
  v_status text;
  v_snoozed_until timestamptz;
  v_ledger_id uuid;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;

  insert into public.operator_action_ledger (event_id, action_type, payload)
  values (nullif(p_event_id, ''), v_action_type, coalesce(p_payload, '{}'::jsonb))
  returning id into v_ledger_id;

  if nullif(p_event_id, '') is not null then
    v_status := case
      when v_action_type in ('handled', 'dismissed', 'draft_created', 'document_generated', 'action_taken') then 'handled'
      when v_action_type = 'snoozed' then 'snoozed'
      else null
    end;

    if v_action_type = 'snoozed' and nullif(p_payload->>'snoozedUntil', '') is not null then
      v_snoozed_until := (p_payload->>'snoozedUntil')::timestamptz;
    end if;

    if v_status is not null then
      update public.operator_events
      set status = v_status,
          handled_at = case when v_status = 'handled' then now() else handled_at end,
          snoozed_until = case when v_status = 'snoozed' then v_snoozed_until else snoozed_until end,
          updated_at = now()
      where event_id = p_event_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'ledgerId', v_ledger_id,
    'eventId', p_event_id,
    'actionType', v_action_type
  );
end;
$function$;

grant execute on function public.operator_event_is_pushable(text, text) to anon, authenticated, service_role;
grant execute on function public.upsert_operator_events(jsonb, text) to anon, authenticated, service_role;
grant execute on function public.upsert_operator_push_subscription(jsonb, text) to anon, authenticated, service_role;
grant execute on function public.list_operator_events(text, integer) to anon, authenticated, service_role;
grant execute on function public.claim_operator_push_outbox(text, integer) to anon, authenticated, service_role;
grant execute on function public.complete_operator_push_outbox(uuid, text, text, text) to anon, authenticated, service_role;
grant execute on function public.record_operator_event_action(text, text, jsonb, text) to anon, authenticated, service_role;

create or replace function public.operator_event_is_pushable(p_event_type text, p_severity text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select
    lower(coalesce(p_event_type, '')) = any (array[
      'morning-report',
      'pickup-location-requested',
      'pickup-docs-needed',
      'driver-waiting',
      'station-cargo-not-found',
      'station-release-not-visible',
      'airline-transmission-blocker',
      'piece-count-mismatch',
      'storage-or-detention-cost',
      'pickup-onsite',
      'pickup-loaded',
      'delivered-pod-received',
      'delivered-pod-missing',
      'caught-customs-contested',
      'caught-arrival-unverified',
      'caught-arrival-source-conflict',
      'caught-dispatch-customs-unknown'
    ]);
$function$;

create or replace function public.revoke_operator_push_subscription(
  p_subscription_id uuid,
  p_outbox_id uuid,
  p_error text,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_subscription_count integer := 0;
  v_outbox_count integer := 0;
begin
  if not public.valid_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if p_subscription_id is null or p_outbox_id is null then
    raise exception 'subscription id and outbox id are required' using errcode = '22023';
  end if;

  update public.operator_push_subscriptions
  set enabled = false,
      revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  where id = p_subscription_id;
  get diagnostics v_subscription_count = row_count;

  if v_subscription_count <> 1 then
    raise exception 'push subscription not found' using errcode = 'P0002';
  end if;

  update public.operator_push_outbox
  set status = 'skipped',
      last_error = nullif(left(coalesce(p_error, ''), 2000), ''),
      updated_at = now()
  where id = p_outbox_id
    and subscription_id = p_subscription_id
    and status = 'sending';
  get diagnostics v_outbox_count = row_count;

  if v_outbox_count <> 1 then
    raise exception 'sending push outbox row not found for subscription' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'ok', true,
    'subscriptionId', p_subscription_id,
    'outboxId', p_outbox_id,
    'subscriptionRevoked', true,
    'outboxStatus', 'skipped'
  );
end;
$function$;

revoke execute on function public.operator_event_is_pushable(text, text) from public;
revoke execute on function public.revoke_operator_push_subscription(uuid, uuid, text, text) from public;
revoke execute on function public.revoke_operator_push_subscription(uuid, uuid, text, text) from anon, authenticated;

grant execute on function public.operator_event_is_pushable(text, text) to anon, authenticated, service_role;
grant execute on function public.revoke_operator_push_subscription(uuid, uuid, text, text) to anon, authenticated, service_role;

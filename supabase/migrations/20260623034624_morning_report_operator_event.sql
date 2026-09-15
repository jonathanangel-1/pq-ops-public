create or replace function public.operator_event_is_pushable(p_event_type text, p_severity text)
returns boolean
language sql
immutable
as $function$
  select
    lower(coalesce(p_event_type, '')) = any (array[
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
      'delivered-pod-missing',
      'morning-report'
    ]);
$function$;

grant execute on function public.operator_event_is_pushable(text, text) to anon, authenticated, service_role;

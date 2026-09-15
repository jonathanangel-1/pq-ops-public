-- Worker context is a provenance boundary.  Emit the same six-digit UTC
-- representation used by the candidate ledger's exact captured_at binding;
-- no tolerance or range comparison is introduced.
create or replace function private.truth_worker_canonical_millis(p_value timestamptz)
returns text language sql immutable security invoker set search_path=''
as $function$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$function$;

revoke all on function private.truth_worker_canonical_millis(timestamptz)
  from public,anon,authenticated,service_role;

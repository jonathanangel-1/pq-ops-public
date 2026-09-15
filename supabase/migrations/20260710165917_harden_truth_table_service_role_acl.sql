-- Harden the installed truth schema against direct service-role table control.
--
-- The reviewed truth migrations intentionally route writes through fenced RPCs,
-- but Supabase's managed service_role began with broader default table grants.
-- Earlier migrations revoked INSERT/UPDATE/DELETE while leaving TRUNCATE,
-- REFERENCES, TRIGGER, and MAINTAIN behind on some tables. Preserve only an
-- already-existing SELECT grant and remove every other direct table privilege.

do $block$
declare
  v_table record;
  v_had_select boolean;
begin
  for v_table in
    select cls.oid, cls.relname as table_name
    from pg_catalog.pg_class cls
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    where ns.nspname = 'public'
      and cls.relkind in ('r', 'p')
      and cls.relname ~ '^(source_|gmail_|accepted_|claim_|observation_|operational_|truth_|candidate_|operator_truth_)'
    order by cls.relname
  loop
    v_had_select := pg_catalog.has_table_privilege(
      'service_role',
      v_table.oid,
      'SELECT'
    );

    execute format(
      'revoke all privileges on table public.%I from service_role',
      v_table.table_name
    );

    if v_had_select then
      execute format(
        'grant select on table public.%I to service_role',
        v_table.table_name
      );
    end if;
  end loop;
end;
$block$;

-- Truth workspace registry and structural tenant isolation.
--
-- The truth migrations predate a durable workspace authority and therefore
-- treated workspace_key as an unchecked text label. This migration makes the
-- existing primary workspace explicit, validates every durable truth row
-- against that registry, and scopes references between workspace-bearing
-- truth tables so a child cannot point at another workspace's parent row.

create table if not exists public.truth_workspaces (
  workspace_key text primary key
    check (workspace_key ~ '^[a-z0-9][a-z0-9:_-]{0,127}$'),
  status text not null default 'active'
    check (status = any (array['active', 'disabled'])),
  registry_version text not null default 'truth-workspace-registry-v1',
  registered_at timestamptz not null default clock_timestamp()
);

-- `primary` is the only workspace identity established by the existing
-- product and migrations. Do not infer or auto-register any other key: adding
-- the foreign keys below must fail closed if pre-existing orphan keys exist.
insert into public.truth_workspaces (
  workspace_key,
  status,
  registry_version
) values (
  'primary',
  'active',
  'truth-workspace-registry-v1'
) on conflict (workspace_key) do nothing;

do $block$
declare
  v_primary public.truth_workspaces%rowtype;
begin
  select * into v_primary
  from public.truth_workspaces
  where workspace_key = 'primary';

  if not found
    or v_primary.status is distinct from 'active'
    or v_primary.registry_version is distinct from 'truth-workspace-registry-v1' then
    raise exception 'primary truth workspace registry contract mismatch'
      using errcode = '23514';
  end if;
end;
$block$;

-- Truth tables are deliberately selected by the namespaces established by
-- the 20260709200000..20260709230000 migration series. The loop discovers all
-- current workspace-bearing tables in those namespaces, including tables
-- added later in that series, while avoiding unrelated product tables.
do $block$
declare
  v_table record;
  v_constraint_name text;
begin
  for v_table in
    select cls.relname as table_name
    from pg_catalog.pg_class cls
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    join pg_catalog.pg_attribute workspace_column
      on workspace_column.attrelid = cls.oid
     and workspace_column.attname = 'workspace_key'
     and workspace_column.attnum > 0
     and not workspace_column.attisdropped
    where ns.nspname = 'public'
      and cls.relkind in ('r', 'p')
      and cls.relname <> 'truth_workspaces'
      and cls.relname ~ '^(source_|gmail_|accepted_|observation_|operational_|truth_|candidate_)'
    order by cls.relname
  loop
    v_constraint_name := 'truth_workspace_registry_' ||
      substr(md5(v_table.table_name), 1, 20);

    if not exists (
      select 1
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class child on child.oid = con.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child.relnamespace
      join pg_catalog.pg_class parent on parent.oid = con.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
      where con.contype = 'f'
        and child_ns.nspname = 'public'
        and child.relname = v_table.table_name
        and parent_ns.nspname = 'public'
        and parent.relname = 'truth_workspaces'
        and pg_catalog.pg_get_constraintdef(con.oid, true)
          like 'FOREIGN KEY (workspace_key) REFERENCES truth_workspaces(workspace_key)%'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (workspace_key) references public.truth_workspaces (workspace_key) on update restrict on delete restrict not deferrable',
        v_table.table_name,
        v_constraint_name
      );
    end if;
  end loop;
end;
$block$;

-- Strengthen every reference whose child and parent both carry a workspace.
-- The original key remains in place for compatibility; a parallel composite
-- key adds workspace_key, plus source_system/connection_key where both sides
-- expose those source-connection dimensions. Deferrability is preserved for
-- the intentionally circular truth-build pair relationship.
do $block$
declare
  v_fk record;
  v_scope_columns text[];
  v_child_columns text[];
  v_parent_columns text[];
  v_child_column_sql text;
  v_parent_column_sql text;
  v_parent_constraint_name text;
  v_child_constraint_name text;
  v_deferrability text;
begin
  for v_fk in
    select
      con.oid as constraint_oid,
      con.conname as constraint_name,
      con.conrelid as child_oid,
      con.confrelid as parent_oid,
      con.conkey as child_keys,
      con.confkey as parent_keys,
      con.condeferrable,
      con.condeferred,
      child.relname as child_table,
      parent.relname as parent_table
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class child on child.oid = con.conrelid
    join pg_catalog.pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_catalog.pg_class parent on parent.oid = con.confrelid
    join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    where con.contype = 'f'
      and child_ns.nspname = 'public'
      and parent_ns.nspname = 'public'
      and child.relkind in ('r', 'p')
      and parent.relkind in ('r', 'p')
      and child.relname <> 'truth_workspaces'
      and parent.relname <> 'truth_workspaces'
      and child.relname ~ '^(source_|gmail_|accepted_|observation_|operational_|truth_|candidate_)'
      and parent.relname ~ '^(source_|gmail_|accepted_|observation_|operational_|truth_|candidate_)'
      and exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = child.oid
          and a.attname = 'workspace_key'
          and a.attnum > 0
          and not a.attisdropped
      )
      and exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = parent.oid
          and a.attname = 'workspace_key'
          and a.attnum > 0
          and not a.attisdropped
      )
      and not exists (
        select 1
        from unnest(con.conkey) as child_key(attnum)
        join pg_catalog.pg_attribute a
          on a.attrelid = child.oid
         and a.attnum = child_key.attnum
        where a.attname = 'workspace_key'
      )
    order by child.relname, con.conname
  loop
    select array_agg(child_attribute.attname::text order by key_position.ordinality)
    into v_child_columns
    from unnest(v_fk.child_keys) with ordinality as key_position(attnum, ordinality)
    join pg_catalog.pg_attribute child_attribute
      on child_attribute.attrelid = v_fk.child_oid
     and child_attribute.attnum = key_position.attnum;

    select array_agg(parent_attribute.attname::text order by key_position.ordinality)
    into v_parent_columns
    from unnest(v_fk.parent_keys) with ordinality as key_position(attnum, ordinality)
    join pg_catalog.pg_attribute parent_attribute
      on parent_attribute.attrelid = v_fk.parent_oid
     and parent_attribute.attnum = key_position.attnum;

    v_scope_columns := array['workspace_key']::text[];
    if exists (
      select 1 from pg_catalog.pg_attribute child_attribute
      where child_attribute.attrelid = v_fk.child_oid
        and child_attribute.attname = 'source_system'
        and child_attribute.attnum > 0
        and not child_attribute.attisdropped
    ) and exists (
      select 1 from pg_catalog.pg_attribute parent_attribute
      where parent_attribute.attrelid = v_fk.parent_oid
        and parent_attribute.attname = 'source_system'
        and parent_attribute.attnum > 0
        and not parent_attribute.attisdropped
    ) then
      v_scope_columns := array_append(v_scope_columns, 'source_system');
    end if;
    if exists (
      select 1 from pg_catalog.pg_attribute child_attribute
      where child_attribute.attrelid = v_fk.child_oid
        and child_attribute.attname = 'connection_key'
        and child_attribute.attnum > 0
        and not child_attribute.attisdropped
    ) and exists (
      select 1 from pg_catalog.pg_attribute parent_attribute
      where parent_attribute.attrelid = v_fk.parent_oid
        and parent_attribute.attname = 'connection_key'
        and parent_attribute.attnum > 0
        and not parent_attribute.attisdropped
    ) then
      v_scope_columns := array_append(v_scope_columns, 'connection_key');
    end if;

    select array_agg(column_name)
    into v_scope_columns
    from unnest(v_scope_columns) as scope(column_name)
    where not (column_name = any (v_child_columns));

    if coalesce(array_length(v_scope_columns, 1), 0) = 0 then
      continue;
    end if;

    v_child_columns := v_child_columns || v_scope_columns;
    v_parent_columns := v_parent_columns || v_scope_columns;

    select string_agg(format('%I', column_name), ', ' order by ordinality)
    into v_child_column_sql
    from unnest(v_child_columns) with ordinality as columns(column_name, ordinality);

    select string_agg(format('%I', column_name), ', ' order by ordinality)
    into v_parent_column_sql
    from unnest(v_parent_columns) with ordinality as columns(column_name, ordinality);

    v_parent_constraint_name := 'truth_scope_parent_' || substr(md5(
      v_fk.parent_table || ':' || array_to_string(v_parent_columns, ',')
    ), 1, 20);
    v_child_constraint_name := 'truth_scope_child_' || substr(md5(
      v_fk.child_table || ':' || v_fk.constraint_name || ':' ||
      array_to_string(v_child_columns, ',')
    ), 1, 20);

    if not exists (
      select 1
      from pg_catalog.pg_constraint con
      where con.conrelid = v_fk.parent_oid
        and con.contype in ('p', 'u')
        and (
          select array_agg(attribute.attname::text order by key_position.ordinality)
          from unnest(con.conkey) with ordinality as key_position(attnum, ordinality)
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = con.conrelid
           and attribute.attnum = key_position.attnum
        ) = v_parent_columns
    ) then
      execute format(
        'alter table public.%I add constraint %I unique (%s)',
        v_fk.parent_table,
        v_parent_constraint_name,
        v_parent_column_sql
      );
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_constraint con
      where con.conrelid = v_fk.child_oid
        and con.confrelid = v_fk.parent_oid
        and con.contype = 'f'
        and (
          select array_agg(attribute.attname::text order by key_position.ordinality)
          from unnest(con.conkey) with ordinality as key_position(attnum, ordinality)
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = con.conrelid
           and attribute.attnum = key_position.attnum
        ) = v_child_columns
        and (
          select array_agg(attribute.attname::text order by key_position.ordinality)
          from unnest(con.confkey) with ordinality as key_position(attnum, ordinality)
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = con.confrelid
           and attribute.attnum = key_position.attnum
        ) = v_parent_columns
    ) then
      v_deferrability := case
        when v_fk.condeferrable and v_fk.condeferred
          then ' deferrable initially deferred'
        when v_fk.condeferrable
          then ' deferrable initially immediate'
        else ' not deferrable'
      end;

      execute format(
        'alter table public.%I add constraint %I foreign key (%s) references public.%I (%s) on update restrict on delete restrict%s',
        v_fk.child_table,
        v_child_constraint_name,
        v_child_column_sql,
        v_fk.parent_table,
        v_parent_column_sql,
        v_deferrability
      );
    end if;
  end loop;
end;
$block$;

alter table public.truth_workspaces enable row level security;
alter table public.truth_workspaces force row level security;

revoke all on public.truth_workspaces from public, anon, authenticated, service_role;
grant select on public.truth_workspaces to service_role;
revoke insert, update, delete, truncate on public.truth_workspaces from service_role;

-- Extend the shadow-channel root-cut registrar to the cutover live Gmail
-- connection. The cut remains an exact one-source vector and is quarantined to
-- shadow build/publication channels; this authority never publishes production.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

do $preflight$
declare
  v_register text;
  v_quarantine text;
begin
  if to_regclass('public.truth_shadow_root_source_cuts') is null then
    raise exception 'shadow root source-cut registry is unavailable'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.register_truth_shadow_root_source_cut(text)'::regprocedure
  ) into v_register;
  select pg_get_functiondef(
    'private.guard_truth_shadow_acceptance_quarantine()'::regprocedure
  ) into v_quarantine;
  if position('shadow Gmail source cut must be an exact one-source vector'
      in v_register)=0
    or position('shadow acceptance source cut cannot create candidate or production build authority'
      in v_quarantine)=0 then
    raise exception 'shadow root source-cut functions differ from reviewed contracts'
      using errcode='23514';
  end if;
end;
$preflight$;

-- Drop only the legacy connection-vocabulary check, without depending on its
-- environment-generated name. Preserve every unrelated invariant.
do $widen_connection_check$
declare
  v_constraint record;
begin
  if exists(select 1 from public.truth_shadow_root_source_cuts
    where connection_key<>'primary' and connection_key not like 'shadow-%') then
    raise exception 'unknown shadow root source-cut connection prevents widening'
      using errcode='23514';
  end if;
  for v_constraint in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid='public.truth_shadow_root_source_cuts'::regclass
      and constraint_row.contype='c'
      and pg_get_constraintdef(constraint_row.oid) ilike '%connection_key%'
      and pg_get_constraintdef(constraint_row.oid) ilike '%shadow-%'
      and constraint_row.conname<>
        'truth_shadow_root_source_cuts_connection_scope_check'
  loop
    execute format('alter table public.truth_shadow_root_source_cuts drop constraint %I',
      v_constraint.conname);
  end loop;
  if not exists(select 1 from pg_constraint constraint_row
    where constraint_row.conrelid='public.truth_shadow_root_source_cuts'::regclass
      and constraint_row.conname=
        'truth_shadow_root_source_cuts_connection_scope_check') then
    alter table public.truth_shadow_root_source_cuts
      add constraint truth_shadow_root_source_cuts_connection_scope_check
      check(connection_key='primary' or connection_key like 'shadow-%');
  end if;
end;
$widen_connection_check$;

do $rewrite_register$
declare
  v_signature regprocedure:=
    'private.register_truth_shadow_root_source_cut(text)'::regprocedure;
  v_definition text;
  v_old_cursor text:=$old$    and cursor_row.source_system = 'gmail'
    and cursor_row.connection_key like 'shadow-%';$old$;
  v_new_cursor text:=$new$    and cursor_row.source_system = 'gmail'
    and (
      cursor_row.connection_key like 'shadow-%'
      or cursor_row.connection_key = 'primary'
    );$new$;
  v_old_required text:=$old$  if exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key = v_cut.workspace_key
      and required_source.source_system = 'gmail'
      and required_source.connection_key = v_cursor.connection_key
  ) then$old$;
  v_new_required text:=$new$  -- The registered live Gmail connection is admitted only to this
  -- shadow-channel cut authority. All other registered canonical sources remain
  -- forbidden, and the exact one-source vector checks above remain unchanged.
  if v_cursor.connection_key <> 'primary' and exists (
    select 1
    from public.truth_required_sources required_source
    where required_source.workspace_key = v_cut.workspace_key
      and required_source.source_system = 'gmail'
      and required_source.connection_key = v_cursor.connection_key
  ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position($marker$cursor_row.connection_key = 'primary'$marker$
      in v_definition)=0 then
    if position(v_old_cursor in v_definition)=0
      or position(v_old_required in v_definition)=0 then
      raise exception 'primary Gmail root-cut register rewrite did not match installed function'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old_cursor,v_new_cursor);
    v_definition:=replace(v_definition,v_old_required,v_new_required);
    execute v_definition;
  end if;
end;
$rewrite_register$;

do $rewrite_quarantine$
declare
  v_signature regprocedure:=
    'private.guard_truth_shadow_acceptance_quarantine()'::regprocedure;
  v_definition text;
  v_old text:=$old$  select exists (
    select 1
    from public.source_cut_cursors cursor_row
    where cursor_row.source_cut_id = new.source_cut_id
      and cursor_row.connection_key like 'shadow-%'
  ) into v_has_shadow_cursor;$old$;
  v_new text:=$new$  -- Quarantine every cut registered by this authority, including primary.
  select exists (
    select 1
    from public.truth_shadow_root_source_cuts scope_row
    where scope_row.workspace_key = new.workspace_key
      and scope_row.source_cut_id = new.source_cut_id
  ) into v_has_shadow_cursor;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('Quarantine every cut registered by this authority' in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'primary Gmail root-cut quarantine rewrite did not match installed function'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite_quarantine$;

do $verify$
declare
  v_register text;
  v_seal text;
  v_quarantine text;
begin
  select pg_get_functiondef(
    'private.register_truth_shadow_root_source_cut(text)'::regprocedure
  ) into v_register;
  select pg_get_functiondef(
    'private.seal_truth_shadow_root_source_cut(text,text,text,text)'::regprocedure
  ) into v_seal;
  select pg_get_functiondef(
    'private.guard_truth_shadow_acceptance_quarantine()'::regprocedure
  ) into v_quarantine;
  if position($marker$cursor_row.connection_key = 'primary'$marker$
      in v_register)=0
    or position($marker$v_cursor.connection_key <> 'primary'$marker$
      in v_register)=0
    or position('jsonb_array_length(v_cut.required_sources) <> 1' in v_register)=0
    or position('shadow source cut cursor is not covered by an exact epoch head'
      in v_register)=0
    or position('private.register_truth_shadow_root_source_cut' in v_seal)=0
    or position('truth_shadow_root_source_cuts scope_row' in v_quarantine)=0
    or position('publication_channel' in v_quarantine)=0 then
    raise exception 'primary Gmail shadow root-cut admission is incomplete'
      using errcode='23514';
  end if;
  if not exists(select 1 from pg_constraint constraint_row
    where constraint_row.conrelid='public.truth_shadow_root_source_cuts'::regclass
      and constraint_row.conname='truth_shadow_root_source_cuts_connection_scope_check'
      and pg_get_constraintdef(constraint_row.oid) ilike '%primary%'
      and pg_get_constraintdef(constraint_row.oid) ilike '%shadow-%') then
    raise exception 'primary Gmail shadow root-cut connection constraint is incomplete'
      using errcode='23514';
  end if;
end;
$verify$;

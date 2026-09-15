-- Revision auto-resolution must inspect only materialization groups capable of
-- resolving an exact earlier unresolved obligation. The former time-only scan
-- rebuilt every group since genesis for every checkpoint target and eventually
-- exceeded the hosted statement budget. This migration changes selection and
-- access paths only; the proof-bound resolution authority remains byte-for-byte
-- inside the selected loop.

create index if not exists gmail_materialization_groups_revision_resolution_idx
  on public.gmail_message_materialization_groups(
    workspace_key,connection_key,message_id,source_cursor_version,group_id
  );

create index if not exists gmail_revision_obligations_resolution_scope_idx
  on public.gmail_message_revision_obligations(
    workspace_key,connection_key,message_id,source_cursor_version,obligation_id
  ) where reason_code<>'FETCH_POISON_QUARANTINED_REVIEW';

do $rewrite$
declare
  v_signature constant regprocedure :=
    'private.auto_resolve_gmail_revision_obligations_v1(text,text,uuid,text)'::regprocedure;
  v_definition text;
  v_old constant text := $old$where group_row.workspace_key=p_workspace_key
      and group_row.connection_key=p_connection_key
      and group_row.source_cursor_version>=v_epoch.genesis_source_cursor_version
      and group_row.source_cursor_version<=v_target.committed_cursor_version
    order by group_row.source_cursor_version,group_row.message_id,$old$;
  v_new constant text := $new$where group_row.workspace_key=p_workspace_key
      and group_row.connection_key=p_connection_key
      and group_row.source_cursor_version>=v_epoch.genesis_source_cursor_version
      and group_row.source_cursor_version<=v_target.committed_cursor_version
      -- gmail-checkpoint-auto-resolution-bounded-scope-v1
      and exists(
        select 1
        from public.gmail_message_revision_obligations candidate_obligation
        where candidate_obligation.workspace_key=p_workspace_key
          and candidate_obligation.connection_key=p_connection_key
          and candidate_obligation.message_id=group_row.message_id
          and candidate_obligation.source_cursor_version>=
            v_epoch.genesis_source_cursor_version
          and candidate_obligation.source_cursor_version<
            group_row.source_cursor_version
          and candidate_obligation.reason_code<>
            'FETCH_POISON_QUARANTINED_REVIEW'
          and not exists(
            select 1
            from public.gmail_message_revision_resolutions resolution
            where resolution.workspace_key=candidate_obligation.workspace_key
              and resolution.obligation_id=candidate_obligation.obligation_id
          )
      )
    order by group_row.source_cursor_version,group_row.message_id,$new$;
  v_count integer;
begin
  if to_regprocedure(v_signature::text) is null
    or to_regclass('public.gmail_message_materialization_groups') is null
    or to_regclass('public.gmail_message_revision_obligations') is null
    or to_regclass('public.gmail_message_revision_resolutions') is null then
    raise exception 'Gmail checkpoint auto-resolution prerequisites are missing'
      using errcode='55000';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;
  if position('gmail-checkpoint-auto-resolution-bounded-scope-v1' in v_definition)=0 then
    v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))
      / length(v_old);
    if v_count is distinct from 1 then
      raise exception 'Gmail checkpoint auto-resolution rewrite matched % sites',v_count
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite$;

do $verify$
declare
  v_definition text;
  v_group_index text;
  v_obligation_index text;
begin
  select pg_get_functiondef(
    'private.auto_resolve_gmail_revision_obligations_v1(text,text,uuid,text)'::regprocedure
  ) into v_definition;
  select pg_get_indexdef(
    'public.gmail_materialization_groups_revision_resolution_idx'::regclass
  ) into v_group_index;
  select pg_get_indexdef(
    'public.gmail_revision_obligations_resolution_scope_idx'::regclass
  ) into v_obligation_index;
  if position('gmail-checkpoint-auto-resolution-bounded-scope-v1' in v_definition)=0
    or position('candidate_obligation.message_id=group_row.message_id' in v_definition)=0
    or position('candidate_obligation.source_cursor_version<' in v_definition)=0
    or position('gmail_message_revision_resolutions resolution' in v_definition)=0
    or position('resolve_gmail_message_revision_obligation' in v_definition)=0
    or position('FETCH_POISON_QUARANTINED_REVIEW' in v_definition)=0 then
    raise exception 'Gmail checkpoint auto-resolution scope verification failed'
      using errcode='23514';
  end if;
  if v_group_index not like '%(workspace_key, connection_key, message_id, source_cursor_version, group_id)%'
    or v_obligation_index not like '%(workspace_key, connection_key, message_id, source_cursor_version, obligation_id)%'
    or v_obligation_index not like '%reason_code <>%FETCH_POISON_QUARANTINED_REVIEW%' then
    raise exception 'Gmail checkpoint auto-resolution indexes are invalid'
      using errcode='23514';
  end if;
  if exists(
    select 1
    from pg_catalog.pg_proc procedure
    cross join lateral unnest(coalesce(procedure.proconfig,array[]::text[])) setting
    where procedure.oid=
      'private.auto_resolve_gmail_revision_obligations_v1(text,text,uuid,text)'::regprocedure
      and setting~'^(enable_|plan_cache_mode|statement_timeout|lock_timeout|cpu_|random_page_cost)='
  ) then
    raise exception 'Gmail checkpoint auto-resolution added a planner/timeout override'
      using errcode='55000';
  end if;
end;
$verify$;

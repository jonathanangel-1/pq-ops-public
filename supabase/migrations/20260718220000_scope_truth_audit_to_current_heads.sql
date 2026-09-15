-- 20260718220000_scope_truth_audit_to_current_heads.sql
--
-- current-headed-build-scope-v1
-- Same-cut replacement builds are append-only historical receipts. The
-- current audit witness needs the builds referenced by current publication
-- heads and their exact input/envelope closure, not every superseded build
-- that happens to share the immutable source cut.

do $rewrite$
declare
  v_signature constant regprocedure :=
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;
  v_definition text;
  v_old constant text := $old$build.source_cut_id = target.source_cut_id
        or exists ($old$;
  v_new constant text := $new$exists ($new$;
  v_occurrences integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('current-headed-build-scope-v1' in v_definition)=0 then
    v_occurrences := (
      length(v_definition)-length(replace(v_definition,v_old,''))
    )/length(v_old);
    if v_occurrences is distinct from 1 then
      raise exception 'truth audit target-build scope differs from reviewed predecessor'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old,v_new);
    v_definition:=replace(
      v_definition,
      'target_builds_base as (',
      'target_builds_base as ( /* current-headed-build-scope-v1 */'
    );
    execute v_definition;
  end if;
end;
$rewrite$;

revoke all on function private.read_truth_audit_snapshot_core(
  text,integer,text
) from public,anon,authenticated,service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
  v_target_scope text;
begin
  select pg_get_functiondef(p.oid),p.proconfig
  into v_definition,v_config
  from pg_catalog.pg_proc p
  where p.oid=
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;
  v_target_scope:=substring(
    v_definition
    from position('target_builds_base as (' in v_definition)
    for position('target_build_inputs_base as (' in v_definition)
      - position('target_builds_base as (' in v_definition)
  );
  if position('current-headed-build-scope-v1' in v_definition)=0
    or position('build.source_cut_id = target.source_cut_id' in v_target_scope)>0
    or position('from public.truth_publication_heads head' in v_target_scope)=0
    or position('publication.build_id = build.build_id' in v_target_scope)=0
    or v_config is distinct from
      array['search_path=""','statement_timeout=25s']::text[] then
    raise exception 'truth audit current-head build scope verification failed'
      using errcode='55000';
  end if;
end;
$verify$;

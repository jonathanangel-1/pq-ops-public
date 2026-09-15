-- 20260718210000_expose_gmail_checkpoint_presence.sql
--
-- A durable checkpoint with documented terminal gaps is not missing work.
-- Expose checkpoint presence separately from checkpoint readiness so the
-- hosted coordinator does not count an idempotent checkpoint read-back as a
-- newly claimed action forever.

do $rewrite$
declare
  v_signature constant regprocedure :=
    'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'::regprocedure;
  v_definition text;
  v_old constant text := $old$'rootBatchId',bounded.batch_id,
    'checkpointReady',bounded.checkpoint_ready,$old$;
  v_new constant text := $new$'rootBatchId',bounded.batch_id,
    'checkpointPresent',bounded.checkpoint_id is not null,
    'checkpointReady',bounded.checkpoint_ready,$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position($needle$'checkpointPresent'$needle$ in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'Gmail claims-readiness frontier shape differs from reviewed predecessor'
        using errcode='23514';
    end if;
    v_definition:=replace(v_definition,v_old,v_new);
    execute v_definition;
  end if;
end;
$rewrite$;

revoke all on function private.read_gmail_claims_readiness_frontier_v1(
  text,text,integer,text
) from public,anon,authenticated,service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(p.oid),p.proconfig
  into v_definition,v_config
  from pg_catalog.pg_proc p
  where p.oid=
    'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'::regprocedure;
  if position($needle$'checkpointPresent',bounded.checkpoint_id is not null$needle$
      in v_definition)=0
    or position($needle$'checkpointReady',bounded.checkpoint_ready$needle$
      in v_definition)=0
    or v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege(
      'anon',
      'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)',
      'EXECUTE'
    ) then
    raise exception 'Gmail checkpoint-presence frontier verification failed'
      using errcode='55000';
  end if;
end;
$verify$;

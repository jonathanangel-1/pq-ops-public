-- Propagate the single cut-admission authority through every remaining
-- build/publication consumer.  Downstream stages must validate the frozen cut
-- receipt, not independently reinstate the retired gap-free-only predicate.

do $preflight$
begin
  if to_regprocedure('private.require_exact_complete_source_cut(text,text)') is null
    or to_regprocedure('private.derive_truth_build_shipment_metadata(text,text)') is null
    or to_regprocedure('private.publish_truth_build_cas(uuid,text,bigint,text,text,text,text,text)') is null
    or to_regprocedure('private.commit_truth_publication_runtime(text,text,uuid,text,jsonb,text,text,text,text,text,text,text,bigint,text,text)') is null then
    raise exception 'documented-cut downstream propagation prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

do $metadata$
declare
  v_signature constant text :=
    'private.derive_truth_build_shipment_metadata(text,text)';
  v_definition text;
  v_old constant text := $old$  if not exists (
    select 1 from public.source_cuts source_cut
    where source_cut.source_cut_id = p_source_cut_id
      and source_cut.workspace_key = p_workspace_key
      and source_cut.completeness = 'complete'
  ) then
    raise exception 'shipment metadata requires an exact complete source cut'
      using errcode = '23514';
  end if;$old$;
  v_new constant text := $new$  perform private.require_exact_complete_source_cut(
    p_workspace_key,
    p_source_cut_id
  );$new$;
begin
  select pg_get_functiondef(v_signature::regprocedure) into v_definition;
  if position('perform private.require_exact_complete_source_cut' in v_definition)=0 then
    if position(v_old in v_definition)=0
      or position(v_old in substring(v_definition from position(v_old in v_definition)+length(v_old)))>0 then
      raise exception 'shipment-metadata cut guard rewrite did not match exactly once'
        using errcode='55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$metadata$;

do $runtime_publication$
declare
  v_signature constant text :=
    'private.commit_truth_publication_runtime(text,text,uuid,text,jsonb,text,text,text,text,text,text,text,bigint,text,text)';
  v_definition text;
  v_old constant text := $old$  if not found or v_cut.completeness <> 'complete' or jsonb_array_length(v_cut.gaps) <> 0 then
    raise exception 'source cut is not complete' using errcode = '23514';
  end if;$old$;
  v_new constant text := $new$  if not found then
    raise exception 'source cut is unavailable' using errcode = '23503';
  end if;
  perform private.require_exact_complete_source_cut(
    v_build.workspace_key,
    v_build.source_cut_id
  );$new$;
begin
  select pg_get_functiondef(v_signature::regprocedure) into v_definition;
  if position('perform private.require_exact_complete_source_cut' in v_definition)=0 then
    if position(v_old in v_definition)=0
      or position(v_old in substring(v_definition from position(v_old in v_definition)+length(v_old)))>0 then
      raise exception 'runtime publication cut guard rewrite did not match exactly once'
        using errcode='55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$runtime_publication$;

do $verify$
declare
  v_metadata text;
  v_legacy text;
  v_runtime text;
begin
  select pg_get_functiondef(
    'private.derive_truth_build_shipment_metadata(text,text)'::regprocedure
  ) into v_metadata;
  select pg_get_functiondef(
    'private.publish_truth_build_cas(uuid,text,bigint,text,text,text,text,text)'::regprocedure
  ) into v_legacy;
  select pg_get_functiondef(
    'private.commit_truth_publication_runtime(text,text,uuid,text,jsonb,text,text,text,text,text,text,text,bigint,text,text)'::regprocedure
  ) into v_runtime;
  if position('require_exact_complete_source_cut' in v_metadata)=0
    or position('legacy truth publication authority is retired' in v_legacy)=0
    or position('require_exact_complete_source_cut' in v_runtime)=0
    or position('shipment metadata requires an exact complete source cut' in v_metadata)>0
    or position('v_cut.completeness <> ''complete''' in v_legacy)>0
    or position('v_cut.completeness <> ''complete''' in v_runtime)>0
    or position('truth_gmail_claims_readiness_parking_receipt_valid_v1' in v_runtime)=0
    or position('production source cut is no longer the live source vector' in v_runtime)=0 then
    raise exception 'documented-cut admission did not reach the complete build/publication chain'
      using errcode='55000';
  end if;
end;
$verify$;

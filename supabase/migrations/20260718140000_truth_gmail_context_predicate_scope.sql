-- Accepted truth is cross-source, but each extractor consumes a closed
-- predicate vocabulary. Project only current Gmail-capable predicates into
-- the immutable as-of Gmail planning/model context. TMS inventory membership
-- remains accepted truth and remains available to the relational reducer.

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.candidate_claim_predicate_registry') is null
    or to_regprocedure(
      'private.load_gmail_claim_context_as_of_link_cut_v1(text,uuid,text,bigint,text,integer,text)'
    ) is null then
    raise exception 'Gmail context predicate-scope prerequisites are missing'
      using errcode='55000';
  end if;
  select pg_get_functiondef(
    'private.load_gmail_claim_context_as_of_link_cut_v1(text,uuid,text,bigint,text,integer,text)'
      ::regprocedure
  ) into v_definition;
  if position('Gmail as-of claim context requires the fixed 64-item bound' in v_definition)=0
    or position('truth-claim-worker-context-receipt-v2' in v_definition)=0
    or position('private.truth_worker_context_hash(v_core)' in v_definition)=0 then
    raise exception 'Gmail as-of context loader differs from the reviewed runtime'
      using errcode='23514';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_context_predicate_eligible_v1(
  p_predicate text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $function$
  select exists(
    select 1
    from public.candidate_claim_predicate_registry registry
    where registry.predicate=p_predicate
      and registry.source_system='gmail'
      and registry.registry_version='pikiio-shipment-predicates-2026-07-09-v2'
      and registry.registry_hash=
        '9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e'
  );
$function$;

revoke all on function private.truth_gmail_context_predicate_eligible_v1(text)
  from public,anon,authenticated,service_role;

do $rewrite$
declare
  v_signature regprocedure :=
    'private.load_gmail_claim_context_as_of_link_cut_v1(text,uuid,text,bigint,text,integer,text)'
      ::regprocedure;
  v_definition text;
  v_old text := $old$  where claim.decision='accepted'
    and claim.recorded_at<=v_link_job.completed_at$old$;
  v_new text := $new$  where claim.decision='accepted'
    and private.truth_gmail_context_predicate_eligible_v1(claim.predicate)
    and claim.recorded_at<=v_link_job.completed_at$new$;
  v_matches integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_matches := (length(v_definition)-length(replace(v_definition,v_old,'')))
    / length(v_old);
  if v_matches<>2 then
    raise exception 'Gmail context predicate rewrite expected 2 matches, found %',
      v_matches using errcode='23514';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$rewrite$;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.load_gmail_claim_context_as_of_link_cut_v1(text,uuid,text,bigint,text,integer,text)'
      ::regprocedure
  ) into v_definition;
  if (length(v_definition)-length(replace(
      v_definition,
      'private.truth_gmail_context_predicate_eligible_v1(claim.predicate)',
      ''
    ))) / length(
      'private.truth_gmail_context_predicate_eligible_v1(claim.predicate)'
    ) <> 2
    or position('shipment_observed_in_tms' in v_definition)>0
    or position('acceptedClaimCount'',v_claim_count' in v_definition)=0
    or position('private.truth_worker_context_hash(v_core)' in v_definition)=0 then
    raise exception 'Gmail context predicate scope is incomplete or widened'
      using errcode='55000';
  end if;
  select proconfig into v_config from pg_catalog.pg_proc
  where oid=
    'private.load_gmail_claim_context_as_of_link_cut_v1(text,uuid,text,bigint,text,integer,text)'
      ::regprocedure;
  if v_config is null or not ('search_path=""'=any(v_config))
    or has_function_privilege('public',
      'private.truth_gmail_context_predicate_eligible_v1(text)','execute')
    or has_function_privilege('anon',
      'private.truth_gmail_context_predicate_eligible_v1(text)','execute')
    or has_function_privilege('authenticated',
      'private.truth_gmail_context_predicate_eligible_v1(text)','execute')
    or has_function_privilege('service_role',
      'private.truth_gmail_context_predicate_eligible_v1(text)','execute') then
    raise exception 'Gmail context predicate scope ACL/config is unsafe'
      using errcode='42501';
  end if;
end;
$verify$;

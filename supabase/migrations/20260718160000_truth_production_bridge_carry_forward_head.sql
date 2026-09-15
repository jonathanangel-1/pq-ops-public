-- A carry-forward head has two legitimate root identities: the current empty
-- live batch and the earlier evidence-bearing accepted epoch. The shadow scope
-- records the latter plus the current through-cursor. Teach the production
-- bridge to validate both roles without weakening either boundary.

do $rewrite$
declare
  v_signature regprocedure:=
    'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)'
      ::regprocedure;
  v_definition text;
  v_old text:=$old$  if coalesce((v_head->>'accepted')::boolean,false)<>true
    or v_head->>'rootBatchId'<>v_scope.root_batch_id::text
    or (v_head->>'sourceCursorVersion')::bigint<>v_gmail_cursor.cursor_version
    or v_head->>'sourceCursorValue'<>v_gmail_cursor.cursor_value then
    raise exception 'accepted Gmail ceremony head changed before production cut'
      using errcode='40001';
  end if;$old$;
  v_new text:=$new$  if coalesce((v_head->>'accepted')::boolean,false)<>true
    or (case
      when v_head->>'acceptanceMode'='zero_change_carry_forward' then (
        (v_head->>'acceptedRootBatchId') is distinct from
          v_scope.root_batch_id::text
        or coalesce((v_head->>'acceptedCursorVersion')::bigint,0)
          is distinct from coalesce(
            ((v_scope.acceptance_epoch_manifest->-1)
              ->>'sourceCursorVersion')::bigint,
            0
          )
        or (v_head->>'obligationId') is distinct from
          (v_scope.acceptance_epoch_manifest->-1)->>'obligationId'
      )
      else (v_head->>'rootBatchId') is distinct from
        v_scope.root_batch_id::text
    end)
    or (v_head->>'sourceCursorVersion')::bigint<>v_gmail_cursor.cursor_version
    or v_head->>'sourceCursorValue'<>v_gmail_cursor.cursor_value then
    raise exception 'accepted Gmail ceremony head changed before production cut'
      using errcode='40001';
  end if;$new$;
begin
  if to_regprocedure(v_signature::text) is null then
    raise exception 'production-cut bridge is unavailable' using errcode='55000';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;
  if position('acceptedRootBatchId' in v_definition)=0 then
    if position(v_old in v_definition)=0 then
      raise exception 'production-cut bridge head check differs from reviewed runtime'
        using errcode='23514';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end;
$rewrite$;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)'
      ::regprocedure
  ) into v_definition;
  select proconfig into v_config from pg_catalog.pg_proc
  where oid=
    'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)'
      ::regprocedure;
  if position('acceptedRootBatchId' in v_definition)=0
    or position('acceptedCursorVersion' in v_definition)=0
    or position('acceptance_epoch_manifest->-1' in v_definition)=0
    or position('zero_change_carry_forward' in v_definition)=0
    or position('accepted Gmail ceremony head changed before production cut'
      in v_definition)=0
    or position('v_head->>''rootBatchId''<>v_scope.root_batch_id::text'
      in v_definition)>0
    or v_config is null
    or not ('search_path=""'=any(v_config))
    or has_function_privilege(
      'public',
      'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'private.seal_truth_production_cut_from_accepted_gmail_v1(text,text,text,text)',
      'execute'
    )
    or position('insert into public.truth_builds' in v_definition)>0
    or position('insert into public.truth_publications' in v_definition)>0
    or position('insert into public.accepted_claims' in v_definition)>0 then
    raise exception 'production bridge carry-forward head validation is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

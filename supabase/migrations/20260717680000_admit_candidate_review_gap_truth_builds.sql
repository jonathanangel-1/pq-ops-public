-- Extend the documented degraded-cut build vocabulary with the immutable
-- candidate-review frontier already emitted by truth_review_gaps_for_source_cut.
-- This preserves the operator queue as pending work; it neither decides nor
-- materializes any candidate. SOURCE_PROCESSING_BACKLOG deliberately remains
-- undocumented and therefore build-blocking.

do $preflight$
begin
  if to_regprocedure('private.truth_build_documented_gap_exclusions_v1(text,text)') is null
    or to_regprocedure('private.truth_review_gaps_for_source_cut(text,jsonb)') is null then
    raise exception 'candidate-review truth-build gap prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

do $rewrite$
declare
  v_sig constant text := 'private.truth_build_documented_gap_exclusions_v1(text,text)';
  v_definition text;
  v_anchor constant text := $old$    elsif v_gap->>'gapType'='PARKED_BACKFILL_HISTORICAL_DRAIN' then$old$;
  v_replacement constant text := $new$    elsif v_gap->>'gapType'='CANDIDATE_CLAIM_REVIEW_PENDING' then
      if coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or exists (
          select 1 from jsonb_object_keys(v_gap) key
          where key<>all(array['gapType','count','witnessHash'])
        ) then
        raise exception 'candidate-review gap witness is malformed' using errcode='23514';
      end if;

      select value into strict v_review_gap
      from jsonb_array_elements(private.truth_review_gaps_for_source_cut(
        p_workspace_key,v_cut.manifest->'cursors'
      )) item(value)
      where value->>'gapType'='CANDIDATE_CLAIM_REVIEW_PENDING';
      if v_review_gap is distinct from v_gap then
        raise exception 'candidate-review gap is not the exact immutable operator-review frontier'
          using errcode='23514';
      end if;

      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','CANDIDATE_CLAIM_REVIEW_PENDING',
        'count',(v_gap->>'count')::bigint,
        'witnessHash',v_gap->>'witnessHash',
        'policyClass','immutable_candidate_envelope_pending_operator_adjudication',
        'reviewAuthority','truth_review_resolutions-v1',
        'operatorReviewResolved',false,
        'productionPublicationAttempted',false
      ));
    elsif v_gap->>'gapType'='PARKED_BACKFILL_HISTORICAL_DRAIN' then$new$;
begin
  select pg_get_functiondef(v_sig::regprocedure) into v_definition;
  if position('immutable_candidate_envelope_pending_operator_adjudication' in v_definition)=0 then
    if position(v_anchor in v_definition)=0
      or position(v_anchor in substring(v_definition from position(v_anchor in v_definition)+length(v_anchor)))>0 then
      raise exception 'candidate-review gap admission rewrite did not match exactly once'
        using errcode='55000';
    end if;
    v_definition:=replace(v_definition,
      '  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;',
      '  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;'||chr(10)||
      '  v_review_gap jsonb;');
    if position('v_review_gap jsonb;' in v_definition)=0 then
      raise exception 'candidate-review gap local binding rewrite did not match'
        using errcode='55000';
    end if;
    v_definition:=replace(v_definition,v_anchor,v_replacement);
    execute v_definition;
  end if;
end;
$rewrite$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.truth_build_documented_gap_exclusions_v1(text,text)'::regprocedure
  ) into v_definition;
  if position('CANDIDATE_CLAIM_REVIEW_PENDING' in v_definition)=0
    or position('truth_review_gaps_for_source_cut' in v_definition)=0
    or position('v_review_gap is distinct from v_gap' in v_definition)=0
    or position('immutable_candidate_envelope_pending_operator_adjudication' in v_definition)=0
    or position('SOURCE_PROCESSING_BACKLOG' in v_definition)>0 then
    raise exception 'candidate-review documented-gap admission is incomplete or over-broad'
      using errcode='55000';
  end if;
end;
$verify$;

-- Admit a sealed source cut to the relational build only when every degraded
-- gap is an immutable, independently re-provable policy exclusion.  This does
-- not close, rewrite, or call a gap complete.  The exact exclusion array is
-- frozen into the build source watermark, bundle, reducer output, build
-- receipt, and any later publication packet.  Unknown gaps remain fatal.

do $preflight$
begin
  if to_regprocedure('private.require_exact_complete_source_cut(text,text)') is null
    or to_regprocedure('private.derive_truth_build_candidate_manifest(text,text,jsonb)') is null
    or to_regprocedure('private.truth_build_bundle_from_inputs(uuid)') is null
    or to_regprocedure('private.truth_build_pair_receipt(public.truth_build_pair_runs,boolean,boolean)') is null
    or to_regprocedure('private.complete_truth_build_pair_pre_processing_watermark(uuid,text,bigint,jsonb,jsonb,text,text,jsonb,jsonb,text)') is null
    or to_regprocedure('private.unresolved_gmail_attachment_extractions(text)') is null
    or to_regprocedure('private.truth_gmail_claims_readiness_parking_receipt_valid_v1(public.truth_gmail_backfill_parking_receipts)') is null then
    raise exception 'documented-gap truth-build prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

create or replace function private.truth_build_documented_gap_exclusions_v1(
  p_workspace_key text,
  p_source_cut_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  v_cut public.source_cuts%rowtype;
  v_gap jsonb;
  v_exclusions jsonb := '[]'::jsonb;
  v_count bigint;
  v_oldest timestamptz;
  v_witness text;
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
begin
  select * into strict v_cut
  from public.source_cuts cut
  where cut.workspace_key=p_workspace_key
    and cut.source_cut_id=p_source_cut_id;

  if v_cut.completeness='complete' and v_cut.gaps='[]'::jsonb then
    return '[]'::jsonb;
  end if;
  if v_cut.completeness<>'degraded'
    or jsonb_typeof(v_cut.gaps)<>'array'
    or jsonb_array_length(v_cut.gaps)=0 then
    raise exception 'truth build source cut has no admissible documented gap boundary'
      using errcode='23514';
  end if;

  for v_gap in select value from jsonb_array_elements(v_cut.gaps) loop
    if jsonb_typeof(v_gap)<>'object' then
      raise exception 'truth build source cut gap is malformed' using errcode='23514';
    end if;

    if v_gap->>'gapType'='ATTACHMENT_EXTRACTION_REVIEW_PENDING' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or nullif(v_gap->>'oldestCapturedAt','') is null
        or exists (
          select 1 from jsonb_object_keys(v_gap) key
          where key<>all(array['gapType','sourceSystem','count','oldestCapturedAt','witnessHash'])
        ) then
        raise exception 'attachment-review gap witness is malformed' using errcode='23514';
      end if;

      select count(*)::bigint, min(unresolved.captured_at),
        encode(extensions.digest(convert_to(coalesce(string_agg(
          unresolved.attachment_observation_id||':'||unresolved.attachment_content_hash,
          ',' order by unresolved.attachment_observation_id
        ),''),'UTF8'),'sha256'),'hex')
      into v_count,v_oldest,v_witness
      from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved;

      if v_count<>(v_gap->>'count')::bigint
        or private.canonical_truth_timestamp(v_oldest) is distinct from v_gap->>'oldestCapturedAt'
        or v_witness is distinct from v_gap->>'witnessHash'
        or exists (
          select 1
          from private.unresolved_gmail_attachment_extractions(p_workspace_key) unresolved
          left join public.source_processing_jobs review
            on review.workspace_key=p_workspace_key
           and review.job_id=unresolved.review_job_id
          where not (
            (review.state='waiting_runtime'
              and review.last_error_code='GMAIL_MODEL_RUNTIME_DISABLED')
            or exists (
              select 1 from public.truth_gmail_attachment_model_job_terminalizations receipt
              where receipt.workspace_key=p_workspace_key
                and receipt.source_job_id=unresolved.review_job_id
                and receipt.canonical_terminalization->>'operatorReviewResolved'='false'
            )
            or exists (
              select 1 from public.truth_gmail_unsupported_attachment_review_terminalizations receipt
              where receipt.workspace_key=p_workspace_key
                and receipt.source_job_id=unresolved.review_job_id
                and receipt.canonical_terminalization->>'operatorReviewResolved'='false'
            )
            or exists (
              select 1 from public.truth_gmail_attachment_invalid_argument_terminalizations receipt
              where receipt.workspace_key=p_workspace_key
                and receipt.source_job_id=unresolved.review_job_id
                and receipt.canonical_terminalization->>'operatorReviewResolved'='false'
            )
            or exists (
              select 1 from public.truth_gmail_attachment_ledger_rpc_terminalizations receipt
              where receipt.workspace_key=p_workspace_key
                and receipt.source_job_id=unresolved.review_job_id
                and receipt.canonical_terminalization->>'operatorReviewResolved'='false'
            )
            or exists (
              select 1 from public.truth_gmail_attachment_cross_authority_invalid_terminalizations receipt
              where receipt.workspace_key=p_workspace_key
                and receipt.source_job_id=unresolved.review_job_id
                and receipt.canonical_terminalization->>'operatorReviewResolved'='false'
            )
            or exists (
              select 1
              from public.truth_gmail_backfill_parking_receipts parking
              where parking.workspace_key=p_workspace_key
                and parking.connection_key=unresolved.connection_key
                and parking.parked_batch_id=unresolved.root_batch_id
                and private.truth_gmail_claims_readiness_parking_receipt_valid_v1(parking)
            )
          )
        ) then
        raise exception 'attachment-review gap is not the exact documented policy-parked frontier'
          using errcode='23514';
      end if;

      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','ATTACHMENT_EXTRACTION_REVIEW_PENDING',
        'sourceSystem','gmail',
        'count',v_count,
        'oldestCapturedAt',private.canonical_truth_timestamp(v_oldest),
        'witnessHash',v_witness,
        'policyClass','model_runtime_disabled_or_receipted_operator_review',
        'productionPublicationAttempted',false
      ));
    elsif v_gap->>'gapType'='PARKED_BACKFILL_HISTORICAL_DRAIN' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'gapId','')!~'^[0-9a-f-]{36}$'
        or exists (
          select 1 from jsonb_object_keys(v_gap) key
          where key<>all(array['gapType','sourceSystem','connectionKey','gapId','detectedAt'])
        ) then
        raise exception 'parked-history gap witness is malformed' using errcode='23514';
      end if;
      select * into v_receipt
      from public.truth_gmail_backfill_parking_receipts receipt
      where receipt.workspace_key=p_workspace_key
        and receipt.connection_key=v_gap->>'connectionKey'
        and receipt.backfill_gap_id=(v_gap->>'gapId')::uuid;
      if not found
        or not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(v_receipt) then
        raise exception 'parked-history gap lacks its valid immutable parking receipt'
          using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','PARKED_BACKFILL_HISTORICAL_DRAIN',
        'sourceSystem','gmail',
        'connectionKey',v_receipt.connection_key,
        'gapId',v_receipt.backfill_gap_id,
        'count',v_receipt.observation_count,
        'witnessHash',v_receipt.receipt_hash,
        'policyClass','receipt_bound_parked_historical_backfill',
        'parkingReceiptId',v_receipt.receipt_id,
        'productionPublicationAttempted',false
      ));
    else
      raise exception 'truth build source cut contains an undocumented gap type: %',
        coalesce(v_gap->>'gapType','') using errcode='23514';
    end if;
  end loop;

  select coalesce(jsonb_agg(item order by item->>'gapType',item::text),'[]'::jsonb)
  into v_exclusions from jsonb_array_elements(v_exclusions) item;
  return v_exclusions;
end;
$function$;

revoke all on function private.truth_build_documented_gap_exclusions_v1(text,text)
  from public,anon,authenticated,service_role;

-- Preserve every compact-cut identity check; replace only the old empty-gap
-- admission predicate and enrich the returned authority envelope.
do $rewrite_require$
declare
  v_sig constant text:='private.require_exact_complete_source_cut(text,text)';
  v_def text;
  v_old text:=$old$if v_cut.completeness <> 'complete'
    or jsonb_typeof(v_cut.gaps) <> 'array'
    or jsonb_array_length(v_cut.gaps) <> 0$old$;
  v_new text:=$new$if not (
      (v_cut.completeness = 'complete' and jsonb_typeof(v_cut.gaps) = 'array'
        and jsonb_array_length(v_cut.gaps) = 0)
      or
      (v_cut.completeness = 'degraded' and jsonb_typeof(v_cut.gaps) = 'array'
        and jsonb_array_length(v_cut.gaps) > 0)
    )$new$;
begin
  select pg_get_functiondef(v_sig::regprocedure) into v_def;
  if position('truth_build_documented_gap_exclusions_v1' in v_def)=0 then
    if position(v_old in v_def)=0 then
      raise exception 'exact source-cut admission rewrite did not match' using errcode='55000';
    end if;
    v_def:=replace(v_def,v_old,v_new);
    v_def:=replace(v_def,
      '''completeness'', v_cut.completeness,',
      '''completeness'', v_cut.completeness,'||chr(10)||
      '    ''gaps'', v_cut.gaps,'||chr(10)||
      '    ''documentedGapExclusions'', private.truth_build_documented_gap_exclusions_v1(p_workspace_key,p_source_cut_id),'||chr(10)||
      '    ''documentedGapExclusionHash'', encode(extensions.digest(convert_to(private.truth_canonical_json_text(private.truth_build_documented_gap_exclusions_v1(p_workspace_key,p_source_cut_id)),''UTF8''),''sha256''),''hex''),');
    execute v_def;
  end if;
end;
$rewrite_require$;

do $wrap_derive$
begin
  if to_regprocedure('private.derive_truth_build_candidate_manifest_pre_documented_gaps_v1(text,text,jsonb)') is null then
    alter function private.derive_truth_build_candidate_manifest(text,text,jsonb)
      rename to derive_truth_build_candidate_manifest_pre_documented_gaps_v1;
  end if;
end;
$wrap_derive$;

create or replace function private.derive_truth_build_candidate_manifest(
  p_workspace_key text,p_source_cut_id text,p_versions jsonb
) returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_base jsonb; v_cut jsonb; v_watermark jsonb;
begin
  v_cut:=private.require_exact_complete_source_cut(p_workspace_key,p_source_cut_id);
  v_base:=private.derive_truth_build_candidate_manifest_pre_documented_gaps_v1(
    p_workspace_key,p_source_cut_id,p_versions);
  if v_cut->>'completeness'='complete' then
    return v_base;
  end if;
  v_watermark:=(v_base->'sourceWatermark')||jsonb_build_object(
    'completeness',v_cut->>'completeness',
    'documentedGapExclusions',v_cut->'documentedGapExclusions',
    'documentedGapExclusionHash',v_cut->>'documentedGapExclusionHash'
  );
  return v_base||jsonb_build_object('sourceWatermark',v_watermark);
end;
$function$;

do $wrap_bundle$
begin
  if to_regprocedure('private.truth_build_bundle_from_inputs_pre_documented_gaps_v1(uuid)') is null then
    alter function private.truth_build_bundle_from_inputs(uuid)
      rename to truth_build_bundle_from_inputs_pre_documented_gaps_v1;
  end if;
end;
$wrap_bundle$;

create or replace function private.truth_build_bundle_from_inputs(p_build_pair_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_pair public.truth_build_pair_runs%rowtype; v_base jsonb; v_cut jsonb;
begin
  select * into strict v_pair from public.truth_build_pair_runs where build_pair_id=p_build_pair_id;
  v_cut:=private.require_exact_complete_source_cut(v_pair.workspace_key,v_pair.source_cut_id);
  v_base:=private.truth_build_bundle_from_inputs_pre_documented_gaps_v1(p_build_pair_id);
  if v_cut->>'completeness'='complete' then
    return v_base;
  end if;
  return v_base||jsonb_build_object(
    'sourceCut',(v_base->'sourceCut')||jsonb_build_object(
      'completeness',v_cut->>'completeness',
      'gaps',v_cut->'gaps',
      'documentedGapExclusions',v_cut->'documentedGapExclusions',
      'documentedGapExclusionHash',v_cut->>'documentedGapExclusionHash'
    )
  );
end;
$function$;

do $wrap_receipt$
begin
  if to_regprocedure('private.truth_build_pair_receipt_pre_documented_gaps_v1(public.truth_build_pair_runs,boolean,boolean)') is null then
    alter function private.truth_build_pair_receipt(public.truth_build_pair_runs,boolean,boolean)
      rename to truth_build_pair_receipt_pre_documented_gaps_v1;
  end if;
end;
$wrap_receipt$;

create or replace function private.truth_build_pair_receipt(
  p_pair public.truth_build_pair_runs,p_idempotent boolean,p_busy boolean default false
) returns jsonb language sql stable security invoker set search_path='' as $function$
  select private.truth_build_pair_receipt_pre_documented_gaps_v1(
    p_pair,p_idempotent,p_busy
  )||case when p_pair.source_watermark->>'completeness'='degraded' then
    jsonb_build_object(
      'sourceWatermark',p_pair.source_watermark,
      'documentedGapExclusions',p_pair.source_watermark->'documentedGapExclusions',
      'documentedGapExclusionHash',p_pair.source_watermark->>'documentedGapExclusionHash',
      'productionPublicationAttempted',false
    ) else '{}'::jsonb end;
$function$;

-- Completion must compare the reducer to the frozen cut classification, not
-- to the retired literal "complete" vocabulary.
do $rewrite_complete$
declare v_sig constant text:='private.complete_truth_build_pair_pre_processing_watermark(uuid,text,bigint,jsonb,jsonb,text,text,jsonb,jsonb,text)'; v_def text;
begin
  select pg_get_functiondef(v_sig::regprocedure) into v_def;
  if position($new$v_pair.source_watermark->>'completeness'$new$ in v_def)=0 then
    if position($old$v_full_reducer_output->'sourceCut'->>'completeness' is distinct from 'complete'$old$ in v_def)=0 then
      raise exception 'truth-build completion cut identity rewrite did not match' using errcode='55000';
    end if;
    v_def:=replace(v_def,
      $old$v_full_reducer_output->'sourceCut'->>'completeness' is distinct from 'complete'$old$,
      $new$v_full_reducer_output->'sourceCut'->>'completeness'
      is distinct from v_pair.source_watermark->>'completeness'$new$);
    execute v_def;
  end if;
end;
$rewrite_complete$;

revoke all on function private.derive_truth_build_candidate_manifest_pre_documented_gaps_v1(text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.derive_truth_build_candidate_manifest(text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.truth_build_bundle_from_inputs_pre_documented_gaps_v1(uuid) from public,anon,authenticated,service_role;
revoke all on function private.truth_build_bundle_from_inputs(uuid) from public,anon,authenticated,service_role;
revoke all on function private.truth_build_pair_receipt_pre_documented_gaps_v1(public.truth_build_pair_runs,boolean,boolean) from public,anon,authenticated,service_role;
revoke all on function private.truth_build_pair_receipt(public.truth_build_pair_runs,boolean,boolean) from public,anon,authenticated,service_role;

do $verify$
declare v_require text; v_derive text; v_bundle text; v_complete text; v_receipt text;
begin
  select pg_get_functiondef('private.require_exact_complete_source_cut(text,text)'::regprocedure) into v_require;
  select pg_get_functiondef('private.derive_truth_build_candidate_manifest(text,text,jsonb)'::regprocedure) into v_derive;
  select pg_get_functiondef('private.truth_build_bundle_from_inputs(uuid)'::regprocedure) into v_bundle;
  select pg_get_functiondef('private.complete_truth_build_pair_pre_processing_watermark(uuid,text,bigint,jsonb,jsonb,text,text,jsonb,jsonb,text)'::regprocedure) into v_complete;
  select pg_get_functiondef('private.truth_build_pair_receipt(public.truth_build_pair_runs,boolean,boolean)'::regprocedure) into v_receipt;
  if position('truth_build_documented_gap_exclusions_v1' in v_require)=0
    or position('documentedGapExclusionHash' in v_derive)=0
    or position('documentedGapExclusions' in v_bundle)=0
    or position('source_watermark->>''completeness''' in v_complete)=0
    or position('documentedGapExclusions' in v_receipt)=0 then
    raise exception 'documented policy-gap truth-build rewrite is incomplete' using errcode='55000';
  end if;
end;
$verify$;

-- A source cut is an immutable snapshot, not a lease on future stillness.
-- Validate documented degraded gaps from the hash-bound cut-time manifest;
-- never recount mutable processing/review populations during a later build.

do $preflight$
begin
  if to_regprocedure('private.truth_build_documented_gap_exclusions_v1(text,text)') is null
    or to_regprocedure('private.truth_gmail_claims_readiness_parking_receipt_valid_v1(public.truth_gmail_backfill_parking_receipts)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null then
    raise exception 'cut-time documented-gap validation prerequisites are missing'
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
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_cut_gap_hash text;
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
    or jsonb_array_length(v_cut.gaps)=0
    or jsonb_typeof(v_cut.manifest)<>'object'
    or jsonb_typeof(v_cut.manifest->'gaps')<>'array'
    or v_cut.manifest->'gaps' is distinct from v_cut.gaps
    or v_cut.manifest_hash is distinct from encode(extensions.digest(
      convert_to(v_cut.manifest::text,'UTF8'),'sha256'),'hex')
    or v_cut.source_cut_id is distinct from 'cut:v1:'||v_cut.manifest_hash then
    raise exception 'truth build source cut has no valid immutable documented-gap boundary'
      using errcode='23514';
  end if;

  for v_gap in select value from jsonb_array_elements(v_cut.gaps) loop
    if jsonb_typeof(v_gap)<>'object' then
      raise exception 'truth build source cut gap is malformed' using errcode='23514';
    end if;
    v_cut_gap_hash:=encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(v_gap),'UTF8'),'sha256'),'hex');

    if v_gap->>'gapType'='ATTACHMENT_EXTRACTION_REVIEW_PENDING' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or nullif(v_gap->>'oldestCapturedAt','') is null
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','count','oldestCapturedAt','witnessHash'])) then
        raise exception 'attachment-review cut-time witness is malformed' using errcode='23514';
      end if;
      perform (v_gap->>'oldestCapturedAt')::timestamptz;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','sourceSystem','gmail',
        'count',(v_gap->>'count')::bigint,'oldestCapturedAt',v_gap->>'oldestCapturedAt',
        'witnessHash',v_gap->>'witnessHash','cutGapHash',v_cut_gap_hash,
        'policyClass','model_runtime_disabled_or_receipted_operator_review',
        'validationBasis','immutable_cut_time_witness',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='CANDIDATE_CLAIM_REVIEW_PENDING' then
      if coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','count','witnessHash'])) then
        raise exception 'candidate-review cut-time witness is malformed' using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','count',(v_gap->>'count')::bigint,
        'witnessHash',v_gap->>'witnessHash','cutGapHash',v_cut_gap_hash,
        'policyClass','immutable_candidate_envelope_pending_operator_adjudication',
        'reviewAuthority','truth_review_resolutions-v1','operatorReviewResolved',false,
        'validationBasis','immutable_cut_time_witness',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='MODEL_EXTRACTION_JOB_PENDING' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or nullif(v_gap->>'oldestCapturedAt','') is null
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','count','oldestCapturedAt','witnessHash'])) then
        raise exception 'model-extraction job cut-time witness is malformed' using errcode='23514';
      end if;
      perform (v_gap->>'oldestCapturedAt')::timestamptz;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','sourceSystem','gmail',
        'count',(v_gap->>'count')::bigint,'oldestCapturedAt',v_gap->>'oldestCapturedAt',
        'witnessHash',v_gap->>'witnessHash','cutGapHash',v_cut_gap_hash,
        'policyClass','model_runtime_disabled_post_flip_commissioning',
        'policyBlockerCode','GMAIL_MODEL_RUNTIME_DISABLED',
        'validationBasis','immutable_cut_time_witness',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='MODEL_EXTRACTION_REVIEW_PENDING' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or nullif(v_gap->>'oldestCapturedAt','') is null
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','count','oldestCapturedAt','witnessHash'])) then
        raise exception 'model-extraction review cut-time witness is malformed' using errcode='23514';
      end if;
      perform (v_gap->>'oldestCapturedAt')::timestamptz;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','sourceSystem','gmail',
        'count',(v_gap->>'count')::bigint,'oldestCapturedAt',v_gap->>'oldestCapturedAt',
        'witnessHash',v_gap->>'witnessHash','cutGapHash',v_cut_gap_hash,
        'policyClass','model_review_obligation_pending_operator_adjudication',
        'reviewAuthority','gmail_model_extraction_review_obligations-v1',
        'operatorReviewResolved',false,'validationBasis','immutable_cut_time_witness',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='LINK_WORKGROUP_REVIEW_PENDING' then
      if coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','count','witnessHash'])) then
        raise exception 'link/workgroup review cut-time witness is malformed' using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','count',(v_gap->>'count')::bigint,
        'witnessHash',v_gap->>'witnessHash','cutGapHash',v_cut_gap_hash,
        'policyClass','immutable_link_proposal_pending_operator_adjudication',
        'reviewAuthority','truth_link_candidate_decisions-v1','operatorReviewResolved',false,
        'validationBasis','immutable_cut_time_witness',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='SOURCE_JOURNAL_FENCE_MISMATCH' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'connectionKey','')=''
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','connectionKey','count'])) then
        raise exception 'source-journal fence cut-time witness is malformed' using errcode='23514';
      end if;
      select * into strict v_receipt
      from public.truth_gmail_backfill_parking_receipts receipt
      where receipt.workspace_key=p_workspace_key
        and receipt.connection_key=v_gap->>'connectionKey'
        and receipt.observation_count=(v_gap->>'count')::bigint
        and private.truth_gmail_claims_readiness_parking_receipt_valid_v1(receipt);
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','sourceSystem','gmail',
        'connectionKey',v_receipt.connection_key,'count',(v_gap->>'count')::bigint,
        'witnessHash',v_receipt.receipt_hash,'cutGapHash',v_cut_gap_hash,
        'policyClass','parked_historical_backfill_journal_fence',
        'parkingReceiptId',v_receipt.receipt_id,'parkedBatchId',v_receipt.parked_batch_id,
        'validationBasis','immutable_cut_time_witness_and_parking_receipt',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='SOURCE_PROCESSING_BACKLOG' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'connectionKey','')=''
        or v_gap->>'state'<>'waiting_runtime'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','connectionKey','state','count'])) then
        raise exception 'source-processing backlog is runnable, mutable, or malformed'
          using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType',v_gap->>'gapType','sourceSystem','gmail',
        'connectionKey',v_gap->>'connectionKey','state','waiting_runtime',
        'count',(v_gap->>'count')::bigint,'witnessHash',v_cut_gap_hash,
        'cutGapHash',v_cut_gap_hash,
        'policyClass','cut_time_waiting_runtime_policy_parks',
        'validationBasis','immutable_cut_time_witness',
        'productionPublicationAttempted',false));

    elsif v_gap->>'gapType'='PARKED_BACKFILL_HISTORICAL_DRAIN' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'connectionKey','')=''
        or coalesce(v_gap->>'gapId','')!~'^[0-9a-f-]{36}$'
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','connectionKey','gapId','detectedAt'])) then
        raise exception 'parked-history gap cut-time witness is malformed' using errcode='23514';
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
        'gapType',v_gap->>'gapType','sourceSystem','gmail',
        'connectionKey',v_receipt.connection_key,'gapId',v_receipt.backfill_gap_id,
        'count',v_receipt.observation_count,'witnessHash',v_receipt.receipt_hash,
        'cutGapHash',v_cut_gap_hash,
        'policyClass','receipt_bound_parked_historical_backfill',
        'parkingReceiptId',v_receipt.receipt_id,
        'validationBasis','immutable_cut_time_witness_and_parking_receipt',
        'productionPublicationAttempted',false));
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

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.truth_build_documented_gap_exclusions_v1(text,text)'::regprocedure
  ) into v_definition;
  if position('immutable_cut_time_witness' in v_definition)=0
    or position('v_cut.manifest->''gaps'' is distinct from v_cut.gaps' in v_definition)=0
    or position('unresolved_gmail_model_extraction_jobs' in v_definition)>0
    or position('unresolved_gmail_model_extraction_reviews' in v_definition)>0
    or position('truth_review_gaps_for_source_cut' in v_definition)>0
    or position('source_processing_job_within_source_cut' in v_definition)>0 then
    raise exception 'cut-time documented-gap validation rewrite is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

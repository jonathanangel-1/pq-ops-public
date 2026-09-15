-- Complete the proof-carrying degraded-cut vocabulary.  Every admitted gap is
-- recomputed against the immutable cut cursor.  Mutable runnable backlog is
-- never admitted; only exact waiting_runtime policy parks are represented as
-- exclusions.  No review is decided and no production publication occurs.

do $preflight$
begin
  if to_regprocedure('private.truth_build_documented_gap_exclusions_v1(text,text)') is null
    or to_regprocedure('private.truth_review_gaps_for_source_cut(text,jsonb)') is null
    or to_regprocedure('private.unresolved_gmail_model_extraction_jobs(text,jsonb)') is null
    or to_regprocedure('private.unresolved_gmail_model_extraction_reviews(text,jsonb)') is null
    or to_regprocedure('private.source_processing_job_within_source_cut(text,uuid,jsonb)') is null then
    raise exception 'definitive truth-build gap vocabulary prerequisites are missing'
      using errcode='55000';
  end if;
end;
$preflight$;

do $rewrite$
declare
  v_sig constant text := 'private.truth_build_documented_gap_exclusions_v1(text,text)';
  v_definition text;
  v_anchor constant text := $old$    elsif v_gap->>'gapType'='PARKED_BACKFILL_HISTORICAL_DRAIN' then$old$;
  v_replacement constant text := $new$    elsif v_gap->>'gapType'='MODEL_EXTRACTION_JOB_PENDING' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or nullif(v_gap->>'oldestCapturedAt','') is null
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','count','oldestCapturedAt','witnessHash'])) then
        raise exception 'model-extraction job gap witness is malformed' using errcode='23514';
      end if;
      select count(*)::bigint,min(unresolved.created_at),encode(extensions.digest(convert_to(
        coalesce(string_agg(unresolved.extraction_plan_id||':'||
          coalesce(unresolved.model_child_job_id::text,'missing')||':'||
          unresolved.model_child_job_state,',' order by unresolved.extraction_plan_id),''),
        'UTF8'),'sha256'),'hex')
      into v_count,v_oldest,v_witness
      from private.unresolved_gmail_model_extraction_jobs(
        p_workspace_key,v_cut.manifest->'cursors') unresolved;
      if v_count<>(v_gap->>'count')::bigint
        or private.canonical_truth_timestamp(v_oldest) is distinct from v_gap->>'oldestCapturedAt'
        or v_witness is distinct from v_gap->>'witnessHash'
        or exists(
          select 1
          from private.unresolved_gmail_model_extraction_jobs(
            p_workspace_key,v_cut.manifest->'cursors') unresolved
          left join public.source_processing_jobs child
            on child.workspace_key=p_workspace_key
           and child.job_id=unresolved.model_child_job_id
          where child.job_id is null
             or child.state<>'waiting_runtime'
             or child.last_error_code<>'GMAIL_MODEL_RUNTIME_DISABLED'
        ) then
        raise exception 'model-extraction job gap is not the exact disabled-runtime frontier'
          using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','MODEL_EXTRACTION_JOB_PENDING','sourceSystem','gmail',
        'count',v_count,'oldestCapturedAt',private.canonical_truth_timestamp(v_oldest),
        'witnessHash',v_witness,
        'policyClass','model_runtime_disabled_post_flip_commissioning',
        'policyBlockerCode','GMAIL_MODEL_RUNTIME_DISABLED',
        'productionPublicationAttempted',false));
    elsif v_gap->>'gapType'='MODEL_EXTRACTION_REVIEW_PENDING' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or nullif(v_gap->>'oldestCapturedAt','') is null
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','count','oldestCapturedAt','witnessHash'])) then
        raise exception 'model-extraction review gap witness is malformed' using errcode='23514';
      end if;
      select count(*)::bigint,min(unresolved.created_at),encode(extensions.digest(convert_to(
        coalesce(string_agg(unresolved.obligation_id||':'||unresolved.review_job_id::text||':'||
          unresolved.review_job_state,',' order by unresolved.obligation_id),''),
        'UTF8'),'sha256'),'hex')
      into v_count,v_oldest,v_witness
      from private.unresolved_gmail_model_extraction_reviews(
        p_workspace_key,v_cut.manifest->'cursors') unresolved;
      if v_count<>(v_gap->>'count')::bigint
        or private.canonical_truth_timestamp(v_oldest) is distinct from v_gap->>'oldestCapturedAt'
        or v_witness is distinct from v_gap->>'witnessHash' then
        raise exception 'model-extraction review gap differs from its immutable obligation frontier'
          using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','MODEL_EXTRACTION_REVIEW_PENDING','sourceSystem','gmail',
        'count',v_count,'oldestCapturedAt',private.canonical_truth_timestamp(v_oldest),
        'witnessHash',v_witness,
        'policyClass','model_review_obligation_pending_operator_adjudication',
        'reviewAuthority','gmail_model_extraction_review_obligations-v1',
        'operatorReviewResolved',false,'productionPublicationAttempted',false));
    elsif v_gap->>'gapType'='LINK_WORKGROUP_REVIEW_PENDING' then
      if coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or coalesce(v_gap->>'witnessHash','')!~'^[0-9a-f]{64}$'
        or exists(select 1 from jsonb_object_keys(v_gap) key
          where key<>all(array['gapType','count','witnessHash'])) then
        raise exception 'link/workgroup review gap witness is malformed' using errcode='23514';
      end if;
      select value into strict v_review_gap
      from jsonb_array_elements(private.truth_review_gaps_for_source_cut(
        p_workspace_key,v_cut.manifest->'cursors')) item(value)
      where value->>'gapType'='LINK_WORKGROUP_REVIEW_PENDING';
      if v_review_gap is distinct from v_gap then
        raise exception 'link/workgroup review gap differs from its operator-review frontier'
          using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','LINK_WORKGROUP_REVIEW_PENDING','count',(v_gap->>'count')::bigint,
        'witnessHash',v_gap->>'witnessHash',
        'policyClass','immutable_link_proposal_pending_operator_adjudication',
        'reviewAuthority','truth_link_candidate_decisions-v1',
        'operatorReviewResolved',false,'productionPublicationAttempted',false));
    elsif v_gap->>'gapType'='SOURCE_JOURNAL_FENCE_MISMATCH' then
      if v_gap->>'sourceSystem'<>'gmail'
        or coalesce(v_gap->>'connectionKey','')=''
        or coalesce(v_gap->>'count','')!~'^[1-9][0-9]*$'
        or exists(select 1 from jsonb_object_keys(v_gap) key where key<>all(
          array['gapType','sourceSystem','connectionKey','count'])) then
        raise exception 'source-journal fence gap witness is malformed' using errcode='23514';
      end if;
      select * into strict v_receipt
      from public.truth_gmail_backfill_parking_receipts receipt
      where receipt.workspace_key=p_workspace_key
        and receipt.connection_key=v_gap->>'connectionKey'
        and private.truth_gmail_claims_readiness_parking_receipt_valid_v1(receipt);
      select count(*)::bigint into v_count
      from public.source_observations observation
      left join public.source_ingest_batches batch
        on batch.batch_id=observation.batch_id
       and batch.workspace_key=observation.workspace_key
       and batch.source_system=observation.source_system
       and batch.connection_key=observation.connection_key
       and batch.status='committed'
       and batch.committed_cursor_version is not null
       and batch.committed_cursor_version>=observation.source_cursor_version
      where observation.workspace_key=p_workspace_key
        and observation.source_system='gmail'
        and observation.connection_key=v_gap->>'connectionKey'
        and observation.source_cursor_version<=(select (cursor_item->>'throughCursorVersion')::bigint
          from jsonb_array_elements(v_cut.manifest->'cursors') cursor_item
          where cursor_item->>'sourceSystem'='gmail'
            and cursor_item->>'connectionKey'=v_gap->>'connectionKey')
        and batch.batch_id is null;
      if v_count<>(v_gap->>'count')::bigint
        or v_count<>v_receipt.observation_count
        or exists(
          select 1 from public.source_observations observation
          left join public.source_ingest_batches batch on batch.batch_id=observation.batch_id
            and batch.workspace_key=observation.workspace_key
            and batch.source_system=observation.source_system
            and batch.connection_key=observation.connection_key
            and batch.status='committed'
            and batch.committed_cursor_version is not null
            and batch.committed_cursor_version>=observation.source_cursor_version
          where observation.workspace_key=p_workspace_key
            and observation.source_system='gmail'
            and observation.connection_key=v_gap->>'connectionKey'
            and observation.source_cursor_version<=(select (cursor_item->>'throughCursorVersion')::bigint
              from jsonb_array_elements(v_cut.manifest->'cursors') cursor_item
              where cursor_item->>'sourceSystem'='gmail'
                and cursor_item->>'connectionKey'=v_gap->>'connectionKey')
            and batch.batch_id is null
            and observation.batch_id is distinct from v_receipt.parked_batch_id
        ) then
        raise exception 'source-journal fence mismatch is not exactly the receipted parked backfill'
          using errcode='23514';
      end if;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','SOURCE_JOURNAL_FENCE_MISMATCH','sourceSystem','gmail',
        'connectionKey',v_receipt.connection_key,'count',v_count,
        'witnessHash',v_receipt.receipt_hash,
        'policyClass','parked_historical_backfill_journal_fence',
        'parkingReceiptId',v_receipt.receipt_id,
        'parkedBatchId',v_receipt.parked_batch_id,
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
      select count(*)::bigint,encode(extensions.digest(convert_to(coalesce(string_agg(
        job.job_id::text||':'||job.last_error_code,',' order by job.job_id),''),
        'UTF8'),'sha256'),'hex')
      into v_count,v_witness
      from public.source_processing_jobs job
      where job.workspace_key=p_workspace_key
        and job.source_system='gmail'
        and job.connection_key=v_gap->>'connectionKey'
        and job.state='waiting_runtime'
        and private.source_processing_job_within_source_cut(
          p_workspace_key,job.job_id,v_cut.manifest->'cursors');
      if v_count<>(v_gap->>'count')::bigint
        or exists(
          select 1 from public.source_processing_jobs job
          where job.workspace_key=p_workspace_key
            and job.source_system='gmail'
            and job.connection_key=v_gap->>'connectionKey'
            and job.state='waiting_runtime'
            and private.source_processing_job_within_source_cut(
              p_workspace_key,job.job_id,v_cut.manifest->'cursors')
            and job.last_error_code<>all(array[
              'GMAIL_MODEL_RUNTIME_DISABLED',
              'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED',
              'HISTORICAL_DRAIN_COORDINATOR_REQUIRED'])
        ) then
        raise exception 'source-processing backlog includes undocumented waiting-runtime work'
          using errcode='23514';
      end if;
      select coalesce(jsonb_agg(jsonb_build_object(
        'blockerCode',population.last_error_code,'count',population.count
      ) order by population.last_error_code),'[]'::jsonb)
      into v_policy_population
      from (
        select job.last_error_code,count(*)::bigint count
        from public.source_processing_jobs job
        where job.workspace_key=p_workspace_key and job.source_system='gmail'
          and job.connection_key=v_gap->>'connectionKey' and job.state='waiting_runtime'
          and private.source_processing_job_within_source_cut(
            p_workspace_key,job.job_id,v_cut.manifest->'cursors')
        group by job.last_error_code
      ) population;
      v_exclusions:=v_exclusions||jsonb_build_array(jsonb_build_object(
        'schemaVersion','truth-build-documented-gap-exclusion-v1',
        'gapType','SOURCE_PROCESSING_BACKLOG','sourceSystem','gmail',
        'connectionKey',v_gap->>'connectionKey','state','waiting_runtime',
        'count',v_count,'witnessHash',v_witness,
        'policyClass','explicit_waiting_runtime_policy_parks_only',
        'policyPopulation',v_policy_population,
        'productionPublicationAttempted',false));
    elsif v_gap->>'gapType'='PARKED_BACKFILL_HISTORICAL_DRAIN' then$new$;
begin
  select pg_get_functiondef(v_sig::regprocedure) into v_definition;
  if position('explicit_waiting_runtime_policy_parks_only' in v_definition)=0 then
    if position(v_anchor in v_definition)=0
      or position(v_anchor in substring(v_definition from position(v_anchor in v_definition)+length(v_anchor)))>0 then
      raise exception 'definitive gap vocabulary rewrite did not match exactly once'
        using errcode='55000';
    end if;
    v_definition:=replace(v_definition,'  v_review_gap jsonb;',
      '  v_review_gap jsonb;'||chr(10)||'  v_policy_population jsonb;');
    if position('v_policy_population jsonb;' in v_definition)=0 then
      raise exception 'definitive gap vocabulary local binding rewrite did not match'
        using errcode='55000';
    end if;
    execute replace(v_definition,v_anchor,v_replacement);
  end if;
end;
$rewrite$;

do $verify$
declare v_definition text;
begin
  select pg_get_functiondef(
    'private.truth_build_documented_gap_exclusions_v1(text,text)'::regprocedure
  ) into v_definition;
  if position('model_runtime_disabled_post_flip_commissioning' in v_definition)=0
    or position('model_review_obligation_pending_operator_adjudication' in v_definition)=0
    or position('immutable_link_proposal_pending_operator_adjudication' in v_definition)=0
    or position('parked_historical_backfill_journal_fence' in v_definition)=0
    or position('explicit_waiting_runtime_policy_parks_only' in v_definition)=0
    or position('job.state=''waiting_runtime''' in v_definition)=0
    or position('job.last_error_code<>all' in v_definition)=0 then
    raise exception 'definitive documented policy-gap vocabulary is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

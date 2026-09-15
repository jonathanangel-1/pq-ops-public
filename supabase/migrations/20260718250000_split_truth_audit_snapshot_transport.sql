-- 20260718250000_split_truth_audit_snapshot_transport.sql
--
-- split-truth-audit-snapshot-transport-v1
-- Keep the public audit reader on the restricted anonymous role's three-second
-- statement boundary without weakening or partially accepting its witness.
-- Additive RPCs carry the detached current processing, publication payload,
-- build/evidence closure, and later completeness witnesses. The repository
-- client binds and merges every receipt before audit evaluation.

do $clone_base$
declare
  v_source_signature constant regprocedure :=
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;
  v_definition text;
  v_cloned text;
  v_source_name constant text :=
    'FUNCTION private.read_truth_audit_snapshot_core(';
  v_target_name constant text :=
    'FUNCTION private.read_truth_audit_snapshot_base_core(';
  v_payload_gate constant text :=
    $gate$if to_regclass('public.truth_publication_payloads') is not null then$gate$;
  v_detached_gate constant text :=
    $gate$if false /* payload-detached-base-v1 */
      and to_regclass('public.truth_publication_payloads') is not null then$gate$;
  v_old_evidence constant text := $old$      'sourceCutEvidenceObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.observation_id) from bounded_cut_evidence_observations row_value), '[]'::jsonb),$old$;
  v_new_evidence constant text := $new$      'sourceCutEvidenceObservations', '[]'::jsonb, /* closure-detached-base-v1 */$new$;
  v_old_claims constant text := $old$      'acceptedClaimEnvelopes', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.claim_version_id) from bounded_accepted_envelopes row_value), '[]'::jsonb),$old$;
  v_new_claims constant text := $new$      'acceptedClaimEnvelopes', '[]'::jsonb,$new$;
  v_old_links constant text := $old$      'entityLinkEnvelopes', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.link_version_id) from bounded_link_envelopes row_value), '[]'::jsonb),$old$;
  v_new_links constant text := $new$      'entityLinkEnvelopes', '[]'::jsonb,$new$;
  v_old_inputs constant text := $old$      'buildInputs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.build_id, row_value.item_kind, row_value.ordinal) from bounded_build_inputs row_value), '[]'::jsonb),$old$;
  v_new_inputs constant text := $new$      'buildInputs', '[]'::jsonb,$new$;
  v_old_observations constant text := $old$      'observations', coalesce((select jsonb_agg(to_jsonb(row_value) - 'journal_seq' order by row_value.journal_seq) from bounded_observations row_value), '[]'::jsonb),$old$;
  v_new_observations constant text := $new$      'observations', '[]'::jsonb, /* processing-detached-base-v1 */$new$;
  v_old_jobs constant text := $old$      'jobs', coalesce((select jsonb_agg(to_jsonb(row_value) - 'created_at' order by row_value.created_at, row_value.job_id) from bounded_jobs row_value), '[]'::jsonb),$old$;
  v_new_jobs constant text := $new$      'jobs', '[]'::jsonb,$new$;
  v_old_lineage constant text := $old$      'jobLineage', coalesce((select jsonb_agg(to_jsonb(row_value) - 'root_batch_id' - 'root_job_id' order by row_value.root_batch_id, row_value.root_job_id, row_value.job_id) from bounded_job_lineage row_value), '[]'::jsonb),$old$;
  v_new_lineage constant text := $new$      'jobLineage', '[]'::jsonb,$new$;
  v_old_children constant text := $old$      'jobChildren', coalesce((select jsonb_agg(to_jsonb(row_value) - 'ordinal' order by row_value.parent_job_id, row_value.ordinal, row_value.child_job_id) from bounded_job_children row_value), '[]'::jsonb),$old$;
  v_new_children constant text := $new$      'jobChildren', '[]'::jsonb,$new$;
  v_old_job_observations constant text := $old$      'jobObservations', coalesce((select jsonb_agg(to_jsonb(row_value) - 'ordinal' order by row_value.job_id, row_value.ordinal, row_value.observation_id) from bounded_job_observations row_value), '[]'::jsonb),$old$;
  v_new_job_observations constant text := $new$      'jobObservations', '[]'::jsonb,$new$;
begin
  select pg_get_functiondef(v_source_signature) into v_definition;
  if position(v_source_name in v_definition)=0
    or position(v_payload_gate in v_definition)=0 then
    raise exception 'truth audit base core differs from reviewed predecessor'
      using errcode='23514';
  end if;
  v_cloned:=replace(v_definition,v_source_name,v_target_name);
  v_cloned:=replace(v_cloned,v_payload_gate,v_detached_gate);
  if position(v_old_evidence in v_cloned)=0
    or position(v_old_claims in v_cloned)=0
    or position(v_old_links in v_cloned)=0
    or position(v_old_inputs in v_cloned)=0
    or position(v_old_observations in v_cloned)=0
    or position(v_old_jobs in v_cloned)=0
    or position(v_old_lineage in v_cloned)=0
    or position(v_old_children in v_cloned)=0
    or position(v_old_job_observations in v_cloned)=0 then
    raise exception 'truth audit base closure projection differs from reviewed predecessor'
      using errcode='23514';
  end if;
  v_cloned:=replace(v_cloned,v_old_evidence,v_new_evidence);
  v_cloned:=replace(v_cloned,v_old_claims,v_new_claims);
  v_cloned:=replace(v_cloned,v_old_links,v_new_links);
  v_cloned:=replace(v_cloned,v_old_inputs,v_new_inputs);
  v_cloned:=replace(v_cloned,v_old_observations,v_new_observations);
  v_cloned:=replace(v_cloned,v_old_jobs,v_new_jobs);
  v_cloned:=replace(v_cloned,v_old_lineage,v_new_lineage);
  v_cloned:=replace(v_cloned,v_old_children,v_new_children);
  v_cloned:=replace(v_cloned,v_old_job_observations,v_new_job_observations);
  if position(v_target_name in v_cloned)=0
    or position('payload-detached-base-v1' in v_cloned)=0
    or position('closure-detached-base-v1' in v_cloned)=0
    or position('processing-detached-base-v1' in v_cloned)=0
    or position(v_old_evidence in v_cloned)>0
    or position(v_old_claims in v_cloned)>0
    or position(v_old_links in v_cloned)>0
    or position(v_old_inputs in v_cloned)>0
    or position(v_old_observations in v_cloned)>0
    or position(v_old_jobs in v_cloned)>0
    or position(v_old_lineage in v_cloned)>0
    or position(v_old_children in v_cloned)>0
    or position(v_old_job_observations in v_cloned)>0 then
    raise exception 'truth audit payload-detached base clone failed'
      using errcode='23514';
  end if;
  execute v_cloned;
end;
$clone_base$;

create or replace function private.read_truth_audit_snapshot_extensions(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='25s'
as $function$
declare
  v_source_cut_id text;
  v_attachment_gaps jsonb := '[]'::jsonb;
  v_attachment_count bigint := 0;
  v_metadata_envelopes jsonb := '[]'::jsonb;
  v_metadata_count bigint := 0;
  v_pairs jsonb := '[]'::jsonb;
  v_publications jsonb := '[]'::jsonb;
  v_pair_count bigint := 0;
  v_publication_count bigint := 0;
  v_pair_mismatch_count bigint := 0;
  v_publication_mismatch_count bigint := 0;
  v_legacy_count bigint := 0;
  v_model_jobs jsonb := '[]'::jsonb;
  v_model_reviews jsonb := '[]'::jsonb;
  v_model_job_count bigint := 0;
  v_model_review_count bigint := 0;
  v_truncated boolean := false;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or p_row_limit is null
    or p_row_limit < 100
    or p_row_limit > 50000 then
    raise exception 'invalid truth audit snapshot extension request'
      using errcode='22023';
  end if;

  select coalesce(
    (
      select cut.source_cut_id
      from public.source_cuts cut
      where cut.workspace_key=p_workspace_key
      order by cut.sealed_at desc,cut.source_cut_id desc
      limit 1
    ),
    (
      select head.source_cut_id
      from public.truth_publication_heads head
      where head.workspace_key=p_workspace_key
        and head.channel='production'
      limit 1
    )
  ) into v_source_cut_id;

  with unresolved_base as (
    select
      attachment_observation_id,
      attachment_id,
      review_job_id,
      extraction_status,
      extraction_method,
      extraction_provenance,
      filename,
      mime_type,
      review_job_state,
      captured_at
    from private.unresolved_gmail_attachment_extractions(p_workspace_key)
  ), bounded_unresolved as (
    select * from unresolved_base
    order by captured_at,attachment_observation_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from unresolved_base),
    coalesce((
      select jsonb_agg(
        to_jsonb(row_value)-'captured_at'
        order by row_value.captured_at,row_value.attachment_observation_id
      )
      from bounded_unresolved row_value
    ),'[]'::jsonb)
  into v_attachment_count,v_attachment_gaps;

  with target_build_ids as (
    select distinct publication.build_id
    from public.truth_publication_heads head
    join public.truth_publications publication
      on publication.publication_id=head.publication_id
     and publication.workspace_key=head.workspace_key
    where head.workspace_key=p_workspace_key
  ), metadata_base as (
    select envelope.*
    from public.truth_shipment_metadata_envelopes envelope
    where envelope.workspace_key=p_workspace_key
      and exists (
        select 1
        from public.truth_build_inputs input
        join target_build_ids target_build
          on target_build.build_id=input.build_id
        where input.item_kind='shipment_metadata'
          and input.item_id=envelope.metadata_version_id
          and input.item_hash=envelope.envelope_hash
      )
  ), bounded_metadata as (
    select * from metadata_base
    order by shipment_key,metadata_version_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from metadata_base),
    coalesce((
      select jsonb_agg(
        to_jsonb(row_value)
        order by row_value.shipment_key,row_value.metadata_version_id
      )
      from bounded_metadata row_value
    ),'[]'::jsonb)
  into v_metadata_count,v_metadata_envelopes;

  with pair_base as (
    select
      pair.build_pair_id,
      pair.status as pair_status,
      pair.source_cut_id,
      pair.input_manifest_hash,
      pair.processing_watermark_status,
      pair.processing_watermark_hash,
      pair.full_build_id,
      full_build.status as full_build_status,
      full_build.input_manifest_hash as full_input_manifest_hash,
      full_build.processing_watermark_status as full_watermark_status,
      full_build.processing_watermark_hash as full_watermark_hash,
      pair.incremental_build_id,
      incremental_build.status as incremental_build_status,
      incremental_build.input_manifest_hash as incremental_input_manifest_hash,
      incremental_build.processing_watermark_status as incremental_watermark_status,
      incremental_build.processing_watermark_hash as incremental_watermark_hash,
      parity.build_pair_id is not null as parity_present,
      parity.processing_watermark_status as parity_watermark_status,
      parity.processing_watermark_hash as parity_watermark_hash,
      case
        when pair.processing_watermark_status='legacy_unwatermarked'
          then 'legacy_unwatermarked'
        when full_build.build_id is null or incremental_build.build_id is null
          then 'missing_build'
        when pair.status='succeeded' and parity.build_pair_id is null
          then 'missing_parity'
        when pair.input_manifest_hash is distinct from full_build.input_manifest_hash
          or pair.input_manifest_hash is distinct from incremental_build.input_manifest_hash
          or pair.processing_watermark_status is distinct from full_build.processing_watermark_status
          or pair.processing_watermark_status is distinct from incremental_build.processing_watermark_status
          or pair.processing_watermark_hash is distinct from full_build.processing_watermark_hash
          or pair.processing_watermark_hash is distinct from incremental_build.processing_watermark_hash
          or (parity.build_pair_id is not null and (
            pair.processing_watermark_status is distinct from parity.processing_watermark_status
            or pair.processing_watermark_hash is distinct from parity.processing_watermark_hash
          )) then 'mismatch'
        else 'consistent'
      end as continuity_status
    from public.truth_build_pair_runs pair
    left join public.truth_builds full_build
      on full_build.build_id=pair.full_build_id
     and full_build.workspace_key=pair.workspace_key
    left join public.truth_builds incremental_build
      on incremental_build.build_id=pair.incremental_build_id
     and incremental_build.workspace_key=pair.workspace_key
    left join public.truth_build_parity_receipts parity
      on parity.build_pair_id=pair.build_pair_id
    where pair.workspace_key=p_workspace_key
      and pair.source_cut_id=v_source_cut_id
  ), bounded_pairs as (
    select * from pair_base order by build_pair_id limit p_row_limit
  )
  select
    (select count(*)::bigint from pair_base),
    (select count(*)::bigint from pair_base
      where continuity_status not in ('consistent','legacy_unwatermarked')),
    (select count(*)::bigint from pair_base
      where continuity_status='legacy_unwatermarked'),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'buildPairId',build_pair_id,
        'pairStatus',pair_status,
        'sourceCutId',source_cut_id,
        'inputManifestHash',input_manifest_hash,
        'processingWatermarkStatus',processing_watermark_status,
        'processingWatermarkHash',processing_watermark_hash,
        'fullBuild',jsonb_build_object(
          'buildId',full_build_id,
          'status',full_build_status,
          'inputManifestHash',full_input_manifest_hash,
          'processingWatermarkStatus',full_watermark_status,
          'processingWatermarkHash',full_watermark_hash
        ),
        'incrementalBuild',jsonb_build_object(
          'buildId',incremental_build_id,
          'status',incremental_build_status,
          'inputManifestHash',incremental_input_manifest_hash,
          'processingWatermarkStatus',incremental_watermark_status,
          'processingWatermarkHash',incremental_watermark_hash
        ),
        'parity',jsonb_build_object(
          'present',parity_present,
          'processingWatermarkStatus',parity_watermark_status,
          'processingWatermarkHash',parity_watermark_hash
        ),
        'continuityStatus',continuity_status
      ) order by build_pair_id)
      from bounded_pairs
    ),'[]'::jsonb)
  into v_pair_count,v_pair_mismatch_count,v_legacy_count,v_pairs;

  with publication_base as (
    select
      publication.publication_id,
      publication.publication_version,
      publication.channel,
      publication.build_id,
      publication.source_cut_id,
      publication.processing_watermark_status,
      publication.processing_watermark_hash,
      build.processing_watermark_status as build_watermark_status,
      build.processing_watermark_hash as build_watermark_hash,
      payload.processing_watermark_status as payload_watermark_status,
      payload.processing_watermark_hash as payload_watermark_hash,
      head.publication_id is not null as is_head,
      head.processing_watermark_status as head_watermark_status,
      head.processing_watermark_hash as head_watermark_hash,
      case
        when publication.processing_watermark_status='legacy_unwatermarked'
          then 'legacy_unwatermarked'
        when build.build_id is null or payload.publication_id is null
          then 'missing_artifact'
        when publication.processing_watermark_status is distinct from build.processing_watermark_status
          or publication.processing_watermark_status is distinct from payload.processing_watermark_status
          or publication.processing_watermark_hash is distinct from build.processing_watermark_hash
          or publication.processing_watermark_hash is distinct from payload.processing_watermark_hash
          or (head.publication_id is not null and (
            publication.processing_watermark_status is distinct from head.processing_watermark_status
            or publication.processing_watermark_hash is distinct from head.processing_watermark_hash
          )) then 'mismatch'
        else 'consistent'
      end as continuity_status
    from public.truth_publications publication
    left join public.truth_builds build
      on build.build_id=publication.build_id
     and build.workspace_key=publication.workspace_key
    left join public.truth_publication_payloads payload
      on payload.publication_id=publication.publication_id
    left join public.truth_publication_heads head
      on head.publication_id=publication.publication_id
     and head.workspace_key=publication.workspace_key
     and head.channel=publication.channel
    where publication.workspace_key=p_workspace_key
      and (
        publication.source_cut_id=v_source_cut_id
        or head.publication_id is not null
      )
  ), bounded_publications as (
    select * from publication_base
    order by channel,publication_version,publication_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from publication_base),
    (select count(*)::bigint from publication_base
      where continuity_status not in ('consistent','legacy_unwatermarked')),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'publicationId',publication_id,
        'publicationVersion',publication_version,
        'channel',channel,
        'buildId',build_id,
        'sourceCutId',source_cut_id,
        'processingWatermarkStatus',processing_watermark_status,
        'processingWatermarkHash',processing_watermark_hash,
        'buildProcessingWatermarkStatus',build_watermark_status,
        'buildProcessingWatermarkHash',build_watermark_hash,
        'payloadProcessingWatermarkStatus',payload_watermark_status,
        'payloadProcessingWatermarkHash',payload_watermark_hash,
        'isHead',is_head,
        'headProcessingWatermarkStatus',head_watermark_status,
        'headProcessingWatermarkHash',head_watermark_hash,
        'continuityStatus',continuity_status
      ) order by channel,publication_version,publication_id)
      from bounded_publications
    ),'[]'::jsonb)
  into v_publication_count,v_publication_mismatch_count,v_publications;

  with base as (
    select
      extraction_plan_id,
      model_plan_id,
      parent_job_id,
      model_child_job_id,
      source_observation_id,
      model_child_job_state,
      execution_mode,
      context_seal_id,
      created_at
    from private.unresolved_gmail_model_extraction_jobs(p_workspace_key)
  ), bounded as (
    select * from base order by created_at,extraction_plan_id limit p_row_limit
  )
  select
    (select count(*)::bigint from base),
    coalesce((
      select jsonb_agg(
        to_jsonb(row_value)-'created_at'
        order by row_value.created_at,row_value.extraction_plan_id
      ) from bounded row_value
    ),'[]'::jsonb)
  into v_model_job_count,v_model_jobs;

  with base as (
    select
      obligation_id,
      extraction_plan_id,
      review_job_id,
      model_plan_id,
      review_job_state,
      reason_code,
      safe_detail_hash,
      created_at
    from private.unresolved_gmail_model_extraction_reviews(p_workspace_key)
  ), bounded as (
    select * from base order by created_at,obligation_id limit p_row_limit
  )
  select
    (select count(*)::bigint from base),
    coalesce((
      select jsonb_agg(
        to_jsonb(row_value)-'created_at'
        order by row_value.created_at,row_value.obligation_id
      ) from bounded row_value
    ),'[]'::jsonb)
  into v_model_review_count,v_model_reviews;

  v_truncated := v_attachment_count>p_row_limit
    or v_metadata_count>p_row_limit
    or v_pair_count>p_row_limit
    or v_publication_count>p_row_limit
    or v_model_job_count>p_row_limit
    or v_model_review_count>p_row_limit;

  return jsonb_build_object(
    'schemaVersion','relational-truth-audit-snapshot-extensions-v1',
    'workspaceKey',p_workspace_key,
    'rowLimit',p_row_limit,
    'sourceCutId',v_source_cut_id,
    'bounds',jsonb_build_object(
      'counts',jsonb_build_object(
        'attachmentExtractionGaps',v_attachment_count,
        'shipmentMetadataEnvelopes',v_metadata_count,
        'processingWatermarkBuildPairs',v_pair_count,
        'processingWatermarkPublications',v_publication_count,
        'modelExtractionJobGaps',v_model_job_count,
        'modelExtractionReviewGaps',v_model_review_count
      ),
      'truncated',v_truncated
    ),
    'source',jsonb_build_object(
      'attachmentExtractionCompleteness',jsonb_build_object(
        'schemaVersion','gmail-attachment-extraction-completeness-v1',
        'unresolvedCount',v_attachment_count,
        'complete',v_attachment_count=0
      ),
      'attachmentExtractionGaps',v_attachment_gaps,
      'modelExtractionCompleteness',jsonb_build_object(
        'schemaVersion','gmail-model-extraction-completeness-v1',
        'pendingJobCount',v_model_job_count,
        'pendingReviewCount',v_model_review_count,
        'complete',(v_model_job_count+v_model_review_count)=0
      ),
      'modelExtractionJobGaps',v_model_jobs,
      'modelExtractionReviewGaps',v_model_reviews
    ),
    'canonical',jsonb_build_object(
      'shipmentMetadataEnvelopes',v_metadata_envelopes,
      'processingWatermarkContinuity',jsonb_build_object(
        'schemaVersion','truth-processing-watermark-continuity-v1',
        'sourceCutId',v_source_cut_id,
        'complete',v_pair_mismatch_count=0
          and v_publication_mismatch_count=0
          and v_legacy_count=0,
        'mismatchCount',v_pair_mismatch_count+v_publication_mismatch_count,
        'legacyUnwatermarkedPairCount',v_legacy_count,
        'buildPairs',v_pairs,
        'publications',v_publications
      )
    )
  );
end;
$function$;

create or replace function private.read_truth_audit_snapshot_processing(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='25s'
as $function$
declare
  v_source_cut_id text;
  v_batch_ids jsonb := '[]'::jsonb;
  v_observations jsonb := '[]'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
  v_lineage jsonb := '[]'::jsonb;
  v_children jsonb := '[]'::jsonb;
  v_job_observations jsonb := '[]'::jsonb;
  v_observation_count bigint := 0;
  v_job_count bigint := 0;
  v_lineage_count bigint := 0;
  v_children_count bigint := 0;
  v_job_observation_count bigint := 0;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or p_row_limit is null
    or p_row_limit<100
    or p_row_limit>50000 then
    raise exception 'invalid truth audit processing request' using errcode='22023';
  end if;

  select coalesce(
    (
      select cut.source_cut_id
      from public.source_cuts cut
      where cut.workspace_key=p_workspace_key
      order by cut.sealed_at desc,cut.source_cut_id desc
      limit 1
    ),
    (
      select head.source_cut_id
      from public.truth_publication_heads head
      where head.workspace_key=p_workspace_key
        and head.channel='production'
      limit 1
    )
  ) into v_source_cut_id;

  with current_batch_ids as (
    select distinct cursor.last_batch_id as batch_id
    from public.source_cursors cursor
    where cursor.workspace_key=p_workspace_key
      and cursor.last_batch_id is not null
  ), current_page_observations_base as (
    select membership.*
    from public.gmail_ingest_page_observations membership
    join current_batch_ids selected on selected.batch_id=membership.batch_id
  ), current_page_jobs_base as (
    select membership.*
    from public.gmail_ingest_page_jobs membership
    join current_batch_ids selected on selected.batch_id=membership.batch_id
  ), current_job_lineage_base as (
    select
      lineage.job_id,
      lineage.parent_job_id,
      lineage.root_batch_id,
      lineage.root_job_id
    from public.source_processing_job_lineage lineage
    join current_batch_ids selected on selected.batch_id=lineage.root_batch_id
  ), current_job_children_base as (
    select child.parent_job_id,child.child_job_id,child.ordinal
    from public.source_processing_job_children child
    where exists (
      select 1 from current_job_lineage_base lineage
      where lineage.job_id=child.parent_job_id
         or lineage.job_id=child.child_job_id
    )
  ), current_job_observations_base as (
    select output.job_id,output.observation_id,output.ordinal
    from public.source_processing_job_observations output
    join current_job_lineage_base lineage on lineage.job_id=output.job_id
  ), current_observations_base as (
    select
      observation.journal_seq,
      observation.observation_id,
      observation.source_object_type,
      observation.source_object_id,
      case
        when exists (
          select 1 from current_page_observations_base membership
          where membership.observation_id=observation.observation_id
        ) then observation.normalized_payload
        when observation.source_object_type='gmail_attachment_extracted' then
          jsonb_build_object(
            'schemaVersion',observation.normalized_payload->>'schemaVersion',
            'parentObservationId',observation.normalized_payload->>'parentObservationId',
            'attachmentId',observation.normalized_payload->>'attachmentId',
            'filename',observation.normalized_payload->>'filename',
            'mimeType',observation.normalized_payload->>'mimeType',
            'extraction',coalesce(observation.normalized_payload->'extraction','{}'::jsonb),
            'classification',observation.normalized_payload->'classification'
          )
        else '{}'::jsonb
      end as normalized_payload
    from public.source_observations observation
    where exists (
      select 1 from current_page_observations_base membership
      where membership.observation_id=observation.observation_id
    ) or exists (
      select 1 from current_job_observations_base output
      where output.observation_id=observation.observation_id
    )
  ), current_jobs_base as (
    select
      job.job_id,
      job.source_system,
      job.connection_key,
      job.job_kind,
      job.observation_id,
      job.source_object_id,
      job.state,
      case
        when job.job_kind='gmail_extract_message_model_claims' then
          jsonb_strip_nulls(jsonb_build_object(
            'modelPlanId',coalesce(
              job.payload->'modelPlanId',job.payload->'model_plan_id'
            )
          ))
        else '{}'::jsonb
      end as payload,
      case
        when job.job_kind in (
          'gmail_extract_message_claims',
          'gmail_extract_attachment_claims',
          'gmail_extract_message_model_claims',
          'tms_extract_claims',
          'tracking_extract_claims',
          'operator_extract_claims'
        ) then job.result
        else '{}'::jsonb
      end as result,
      job.created_at
    from public.source_processing_jobs job
    where job.workspace_key=p_workspace_key
      and (
        job.state in ('queued','leased','retry_wait','dead_letter')
        or exists (
          select 1 from current_page_jobs_base membership
          where membership.job_id=job.job_id
        )
        or exists (
          select 1 from current_job_lineage_base lineage
          where lineage.job_id=job.job_id
        )
      )
  ), bounded_observations as (
    select * from current_observations_base
    order by journal_seq limit p_row_limit
  ), bounded_jobs as (
    select * from current_jobs_base
    order by created_at,job_id limit p_row_limit
  ), bounded_lineage as (
    select * from current_job_lineage_base
    order by root_batch_id,root_job_id,job_id limit p_row_limit
  ), bounded_children as (
    select * from current_job_children_base
    order by parent_job_id,ordinal,child_job_id limit p_row_limit
  ), bounded_job_observations as (
    select * from current_job_observations_base
    order by job_id,ordinal,observation_id limit p_row_limit
  )
  select
    coalesce((select jsonb_agg(batch_id order by batch_id)
      from current_batch_ids),'[]'::jsonb),
    (select count(*)::bigint from current_observations_base),
    (select count(*)::bigint from current_jobs_base),
    (select count(*)::bigint from current_job_lineage_base),
    (select count(*)::bigint from current_job_children_base),
    (select count(*)::bigint from current_job_observations_base),
    coalesce((select jsonb_agg(to_jsonb(row_value)-'journal_seq'
      order by row_value.journal_seq) from bounded_observations row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)-'created_at'
      order by row_value.created_at,row_value.job_id) from bounded_jobs row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)-'root_batch_id'-'root_job_id'
      order by row_value.root_batch_id,row_value.root_job_id,row_value.job_id)
      from bounded_lineage row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)-'ordinal'
      order by row_value.parent_job_id,row_value.ordinal,row_value.child_job_id)
      from bounded_children row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)-'ordinal'
      order by row_value.job_id,row_value.ordinal,row_value.observation_id)
      from bounded_job_observations row_value),'[]'::jsonb)
  into
    v_batch_ids,
    v_observation_count,v_job_count,v_lineage_count,
    v_children_count,v_job_observation_count,
    v_observations,v_jobs,v_lineage,v_children,v_job_observations;

  return jsonb_build_object(
    'schemaVersion','relational-truth-audit-processing-v1',
    'workspaceKey',p_workspace_key,
    'rowLimit',p_row_limit,
    'sourceCutId',v_source_cut_id,
    'currentBatchIds',v_batch_ids,
    'bounds',jsonb_build_object(
      'counts',jsonb_build_object(
        'observations',v_observation_count,
        'jobs',v_job_count,
        'jobLineage',v_lineage_count,
        'jobChildren',v_children_count,
        'jobObservations',v_job_observation_count
      ),
      'truncated',v_observation_count>p_row_limit
        or v_job_count>p_row_limit
        or v_lineage_count>p_row_limit
        or v_children_count>p_row_limit
        or v_job_observation_count>p_row_limit
    ),
    'source',jsonb_build_object(
      'observations',v_observations,
      'jobs',v_jobs,
      'jobLineage',v_lineage,
      'jobChildren',v_children,
      'jobObservations',v_job_observations
    )
  );
end;
$function$;

create or replace function private.read_truth_audit_snapshot_closure(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='25s'
as $function$
declare
  v_source_cut_id text;
  v_build_inputs jsonb := '[]'::jsonb;
  v_claim_envelopes jsonb := '[]'::jsonb;
  v_link_envelopes jsonb := '[]'::jsonb;
  v_evidence_observations jsonb := '[]'::jsonb;
  v_build_input_count bigint := 0;
  v_claim_count bigint := 0;
  v_link_count bigint := 0;
  v_evidence_count bigint := 0;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or p_row_limit is null
    or p_row_limit<100
    or p_row_limit>50000 then
    raise exception 'invalid truth audit closure request' using errcode='22023';
  end if;

  select coalesce(
    (
      select cut.source_cut_id
      from public.source_cuts cut
      where cut.workspace_key=p_workspace_key
      order by cut.sealed_at desc,cut.source_cut_id desc
      limit 1
    ),
    (
      select head.source_cut_id
      from public.truth_publication_heads head
      where head.workspace_key=p_workspace_key
        and head.channel='production'
      limit 1
    )
  ) into v_source_cut_id;

  with target_builds_base as (
    select build.build_id,build.source_cut_id
    from public.truth_builds build
    where build.workspace_key=p_workspace_key
      and exists (
        select 1
        from public.truth_publication_heads head
        join public.truth_publications publication
          on publication.publication_id=head.publication_id
        where head.workspace_key=p_workspace_key
          and publication.build_id=build.build_id
      )
  ), target_build_inputs_base as (
    select input.*
    from public.truth_build_inputs input
    join target_builds_base build on build.build_id=input.build_id
  ), target_cut_build_inputs_base as (
    select input.*
    from target_build_inputs_base input
    join target_builds_base build on build.build_id=input.build_id
    where build.source_cut_id=v_source_cut_id
  ), target_evidence_ids_base as (
    select evidence.observation_id
    from target_cut_build_inputs_base input
    join public.accepted_claim_evidence evidence
      on input.item_kind='accepted_claim'
     and evidence.claim_version_id=input.item_id
    union
    select entity_link.observation_id
    from target_cut_build_inputs_base input
    join public.observation_entity_links entity_link
      on input.item_kind='entity_link'
     and entity_link.link_version_id=input.item_id
    union
    select evidence.observation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_membership_evidence evidence
      on input.item_kind='workgroup_membership'
     and evidence.membership_version_id=input.item_id
    union
    select membership.observation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_memberships membership
      on input.item_kind='workgroup_membership'
     and membership.membership_version_id=input.item_id
    where membership.observation_id is not null
    union
    select membership.basis_observation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_memberships membership
      on input.item_kind='workgroup_membership'
     and membership.membership_version_id=input.item_id
    where membership.basis_observation_id is not null
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_membership_envelopes envelope
      on input.item_kind='workgroup_membership'
     and envelope.membership_version_id=input.item_id
    cross join lateral private.truth_audit_citation_ids(
      envelope.canonical_envelope,'observation'
    ) citation
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.operational_workgroup_membership_envelopes membership_envelope
      on input.item_kind='workgroup_membership'
     and membership_envelope.membership_version_id=input.item_id
    join public.operational_workgroup_envelopes workgroup
      on workgroup.workgroup_id=membership_envelope.workgroup_id
    cross join lateral private.truth_audit_citation_ids(
      workgroup.canonical_definition,'observation'
    ) citation
  ), evidence_observations_base as (
    select
      v_source_cut_id as source_cut_id,
      observation.observation_id,
      observation.workspace_key,
      observation.source_system,
      observation.connection_key,
      observation.source_cursor_version,
      observation.batch_id,
      observation.content_hash,
      batch.status as batch_status,
      batch.workspace_key as batch_workspace_key,
      batch.source_system as batch_source_system,
      batch.connection_key as batch_connection_key,
      batch.committed_cursor_version,
      exists (
        select 1
        from public.source_cut_cursors cut_cursor
        where cut_cursor.source_cut_id=v_source_cut_id
          and cut_cursor.source_system=observation.source_system
          and cut_cursor.connection_key=observation.connection_key
          and observation.observation_id~'^obs:v1:[0-9a-f]{64}$'
          and observation.content_hash~'^[0-9a-f]{64}$'
          and observation.workspace_key=p_workspace_key
          and observation.source_cursor_version<=cut_cursor.through_cursor_version
          and batch.status='committed'
          and batch.workspace_key=observation.workspace_key
          and batch.source_system=observation.source_system
          and batch.connection_key=observation.connection_key
          and batch.committed_cursor_version>=observation.source_cursor_version
      ) as within_cut
    from target_evidence_ids_base evidence
    join public.source_observations observation
      on observation.observation_id=evidence.observation_id
    join public.source_ingest_batches batch
      on batch.batch_id=observation.batch_id
  ), accepted_envelopes_base as (
    select
      envelope.claim_version_id,
      envelope.envelope_hash,
      jsonb_build_object(
        'evidence',coalesce(envelope.canonical_envelope->'evidence','[]'::jsonb)
      ) as canonical_envelope
    from public.accepted_claim_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind='accepted_claim'
     and input.item_id=envelope.claim_version_id
  ), link_envelopes_base as (
    select
      envelope.link_version_id,
      envelope.envelope_hash,
      jsonb_build_array(
        envelope.canonical_envelope#>'{link,observationId}',
        envelope.canonical_envelope#>'{link,observationContentHash}'
      ) as canonical_envelope
    from public.observation_entity_link_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind='entity_link'
     and input.item_id=envelope.link_version_id
  ), bounded_inputs as (
    select * from target_build_inputs_base
    order by build_id,item_kind,ordinal
    limit p_row_limit
  ), bounded_claims as (
    select * from accepted_envelopes_base
    order by claim_version_id
    limit p_row_limit
  ), bounded_links as (
    select * from link_envelopes_base
    order by link_version_id
    limit p_row_limit
  ), bounded_evidence as (
    select * from evidence_observations_base
    order by observation_id
    limit p_row_limit
  )
  select
    (select count(*)::bigint from target_build_inputs_base),
    (select count(*)::bigint from accepted_envelopes_base),
    (select count(*)::bigint from link_envelopes_base),
    (select count(*)::bigint from evidence_observations_base),
    coalesce((select jsonb_agg(to_jsonb(row_value)
      order by row_value.build_id,row_value.item_kind,row_value.ordinal)
      from bounded_inputs row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)
      order by row_value.claim_version_id)
      from bounded_claims row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)
      order by row_value.link_version_id)
      from bounded_links row_value),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(row_value)
      order by row_value.observation_id)
      from bounded_evidence row_value),'[]'::jsonb)
  into
    v_build_input_count,v_claim_count,v_link_count,v_evidence_count,
    v_build_inputs,v_claim_envelopes,v_link_envelopes,v_evidence_observations;

  return jsonb_build_object(
    'schemaVersion','relational-truth-audit-closure-v1',
    'workspaceKey',p_workspace_key,
    'rowLimit',p_row_limit,
    'sourceCutId',v_source_cut_id,
    'bounds',jsonb_build_object(
      'counts',jsonb_build_object(
        'buildInputs',v_build_input_count,
        'acceptedClaimEnvelopes',v_claim_count,
        'entityLinkEnvelopes',v_link_count,
        'sourceCutEvidenceObservations',v_evidence_count
      ),
      'truncated',v_build_input_count>p_row_limit
        or v_claim_count>p_row_limit
        or v_link_count>p_row_limit
        or v_evidence_count>p_row_limit
    ),
    'canonical',jsonb_build_object(
      'buildInputs',v_build_inputs,
      'acceptedClaimEnvelopes',v_claim_envelopes,
      'entityLinkEnvelopes',v_link_envelopes,
      'sourceCutEvidenceObservations',v_evidence_observations
    )
  );
end;
$function$;

create or replace function private.read_truth_audit_snapshot_publication_payloads(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='25s'
as $function$
declare
  v_source_cut_id text;
  v_heads jsonb := '[]'::jsonb;
  v_payloads jsonb := '[]'::jsonb;
  v_payload_count bigint := 0;
  v_payload_bytes bigint := 0;
  v_payload_byte_limit constant bigint := 33554432;
begin
  if not private.valid_truth_audit_token(p_sync_token) then
    raise exception 'invalid truth audit token' using errcode='28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key,'')),'') is null
    or p_row_limit is null
    or p_row_limit<100
    or p_row_limit>50000 then
    raise exception 'invalid truth audit publication-payload request'
      using errcode='22023';
  end if;

  select coalesce(
    (
      select cut.source_cut_id
      from public.source_cuts cut
      where cut.workspace_key=p_workspace_key
      order by cut.sealed_at desc,cut.source_cut_id desc
      limit 1
    ),
    (
      select head.source_cut_id
      from public.truth_publication_heads head
      where head.workspace_key=p_workspace_key
        and head.channel='production'
      limit 1
    )
  ) into v_source_cut_id;

  select coalesce(
    jsonb_agg(to_jsonb(head) order by head.channel),
    '[]'::jsonb
  ) into v_heads
  from public.truth_publication_heads head
  where head.workspace_key=p_workspace_key;

  select
    count(*)::bigint,
    coalesce(sum(pg_column_size(to_jsonb(payload))),0)::bigint
  into v_payload_count,v_payload_bytes
  from public.truth_publication_payloads payload
  join public.truth_publication_heads head
    on head.publication_id=payload.publication_id
   and head.workspace_key=payload.workspace_key
   and head.channel=payload.channel
  where payload.workspace_key=p_workspace_key;

  if v_payload_count<=p_row_limit
    and v_payload_bytes<=v_payload_byte_limit then
    select coalesce(
      jsonb_agg(to_jsonb(selected) order by selected.channel),
      '[]'::jsonb
    ) into v_payloads
    from (
      select payload.*
      from public.truth_publication_payloads payload
      join public.truth_publication_heads head
        on head.publication_id=payload.publication_id
       and head.workspace_key=payload.workspace_key
       and head.channel=payload.channel
      where payload.workspace_key=p_workspace_key
      order by payload.channel
      limit p_row_limit
    ) selected;
  end if;

  return jsonb_build_object(
    'schemaVersion','relational-truth-audit-publication-payloads-v1',
    'workspaceKey',p_workspace_key,
    'rowLimit',p_row_limit,
    'sourceCutId',v_source_cut_id,
    'publicationHeads',v_heads,
    'publicationPayloads',v_payloads,
    'publicationPayloadCount',v_payload_count,
    'publicationPayloadBytes',v_payload_bytes,
    'publicationPayloadByteLimit',v_payload_byte_limit,
    'truncated',v_payload_count>p_row_limit
      or v_payload_bytes>v_payload_byte_limit
  );
end;
$function$;

create or replace function public.read_truth_audit_snapshot_base(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select private.read_truth_audit_snapshot_base_core(
    p_workspace_key,p_row_limit,p_sync_token
  );
$function$;

create or replace function public.read_truth_audit_snapshot_publication_payloads(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select private.read_truth_audit_snapshot_publication_payloads(
    p_workspace_key,p_row_limit,p_sync_token
  );
$function$;

create or replace function public.read_truth_audit_snapshot_closure(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select private.read_truth_audit_snapshot_closure(
    p_workspace_key,p_row_limit,p_sync_token
  );
$function$;

create or replace function public.read_truth_audit_snapshot_processing(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select private.read_truth_audit_snapshot_processing(
    p_workspace_key,p_row_limit,p_sync_token
  );
$function$;

create or replace function public.read_truth_audit_snapshot_extensions(
  p_workspace_key text,
  p_row_limit integer,
  p_sync_token text
)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select private.read_truth_audit_snapshot_extensions(
    p_workspace_key,p_row_limit,p_sync_token
  );
$function$;

grant create on schema public to truth_audit_rpc_owner;
alter function public.read_truth_audit_snapshot_base(text,integer,text)
  owner to truth_audit_rpc_owner;
alter function public.read_truth_audit_snapshot_publication_payloads(text,integer,text)
  owner to truth_audit_rpc_owner;
alter function public.read_truth_audit_snapshot_closure(text,integer,text)
  owner to truth_audit_rpc_owner;
alter function public.read_truth_audit_snapshot_processing(text,integer,text)
  owner to truth_audit_rpc_owner;
alter function public.read_truth_audit_snapshot_extensions(text,integer,text)
  owner to truth_audit_rpc_owner;
revoke create on schema public from truth_audit_rpc_owner;

revoke all on function private.read_truth_audit_snapshot_base_core(
  text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function private.read_truth_audit_snapshot_publication_payloads(
  text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function private.read_truth_audit_snapshot_closure(
  text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function private.read_truth_audit_snapshot_processing(
  text,integer,text
) from public,anon,authenticated,service_role;
revoke all on function private.read_truth_audit_snapshot_extensions(
  text,integer,text
) from public,anon,authenticated,service_role;
grant execute on function private.read_truth_audit_snapshot_base_core(
  text,integer,text
) to truth_audit_rpc_owner;
grant execute on function private.read_truth_audit_snapshot_publication_payloads(
  text,integer,text
) to truth_audit_rpc_owner;
grant execute on function private.read_truth_audit_snapshot_closure(
  text,integer,text
) to truth_audit_rpc_owner;
grant execute on function private.read_truth_audit_snapshot_processing(
  text,integer,text
) to truth_audit_rpc_owner;
grant execute on function private.read_truth_audit_snapshot_extensions(
  text,integer,text
) to truth_audit_rpc_owner;

revoke all on function public.read_truth_audit_snapshot_base(text,integer,text)
  from public,authenticated,service_role;
revoke all on function public.read_truth_audit_snapshot_publication_payloads(text,integer,text)
  from public,authenticated,service_role;
revoke all on function public.read_truth_audit_snapshot_closure(text,integer,text)
  from public,authenticated,service_role;
revoke all on function public.read_truth_audit_snapshot_processing(text,integer,text)
  from public,authenticated,service_role;
revoke all on function public.read_truth_audit_snapshot_extensions(text,integer,text)
  from public,authenticated,service_role;
grant execute on function public.read_truth_audit_snapshot_base(text,integer,text)
  to anon;
grant execute on function public.read_truth_audit_snapshot_publication_payloads(text,integer,text)
  to anon;
grant execute on function public.read_truth_audit_snapshot_closure(text,integer,text)
  to anon;
grant execute on function public.read_truth_audit_snapshot_processing(text,integer,text)
  to anon;
grant execute on function public.read_truth_audit_snapshot_extensions(text,integer,text)
  to anon;

do $verify$
declare
  v_base_definition text;
  v_extension_definition text;
begin
  select pg_get_functiondef(
    'public.read_truth_audit_snapshot_base(text,integer,text)'::regprocedure
  ) into v_base_definition;
  select pg_get_functiondef(
    'private.read_truth_audit_snapshot_extensions(text,integer,text)'::regprocedure
  ) into v_extension_definition;

  if position('read_truth_audit_snapshot_base_core' in v_base_definition)=0
    or position('split-truth-audit-snapshot-transport-v1'
      in pg_get_functiondef(
        'public.read_truth_audit_snapshot_base(text,integer,text)'::regprocedure
      ))>0
    or position('read_truth_audit_snapshot_pre_attachment'
      in v_extension_definition)>0
    or position('read_truth_audit_snapshot_core' in v_extension_definition)>0
    or position('relational-truth-audit-snapshot-extensions-v1'
      in v_extension_definition)=0
    or has_function_privilege(
      'authenticated','public.read_truth_audit_snapshot_base(text,integer,text)','EXECUTE'
    )
    or has_function_privilege(
      'service_role','public.read_truth_audit_snapshot_extensions(text,integer,text)','EXECUTE'
    )
    or not has_function_privilege(
      'anon','public.read_truth_audit_snapshot_base(text,integer,text)','EXECUTE'
    )
    or not has_function_privilege(
      'anon','public.read_truth_audit_snapshot_publication_payloads(text,integer,text)','EXECUTE'
    )
    or not has_function_privilege(
      'anon','public.read_truth_audit_snapshot_closure(text,integer,text)','EXECUTE'
    )
    or not has_function_privilege(
      'anon','public.read_truth_audit_snapshot_processing(text,integer,text)','EXECUTE'
    )
    or not has_function_privilege(
      'anon','public.read_truth_audit_snapshot_extensions(text,integer,text)','EXECUTE'
    ) then
    raise exception 'split truth audit snapshot transport is incomplete'
      using errcode='55000';
  end if;
end;
$verify$;

-- 20260718010000_bound_truth_audit_snapshot_transport.sql
--
-- Keep the token-gated anon audit RPC inside its intentional three-second
-- statement budget. The core snapshot previously serialized packet bodies the
-- auditor did not consume in shadow mode. Preserve every audited identity and
-- full production-cache verification while removing those unused transports.

do $preflight$
declare
  v_anon_config text[];
begin
  if to_regprocedure(
    'private.read_truth_audit_snapshot_core(text,integer,text)'
  ) is null then
    raise exception 'truth audit core snapshot function is unavailable'
      using errcode = '23514';
  end if;

  select rolconfig into v_anon_config
  from pg_roles
  where rolname = 'anon';

  -- The hermetic verifier creates an unconfigured local anon role. Production
  -- carries the reviewed three-second setting; refuse only an explicit drift.
  if v_anon_config is not null
    and not ('statement_timeout=3s' = any(v_anon_config)) then
    raise exception 'anon statement timeout differs from the reviewed three-second boundary'
      using errcode = '23514';
  end if;
end;
$preflight$;

do $rewrite$
declare
  v_signature constant regprocedure :=
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;
  v_definition text;
  v_rewritten text;
  v_old_builds constant text := $old_builds$  target_builds_base as (
    select build.*
    from public.truth_builds build, parameters p, target
    where build.workspace_key = p.workspace_key
      and (
        build.source_cut_id = target.source_cut_id
        or exists (
          select 1
          from public.truth_publication_heads head
          join public.truth_publications publication
            on publication.publication_id = head.publication_id
          where head.workspace_key = p.workspace_key
            and publication.build_id = build.build_id
        )
      )
  ),$old_builds$;
  v_new_builds constant text := $new_builds$  target_builds_base as (
    select
      build.build_id,
      build.workspace_key,
      build.source_cut_id,
      build.build_mode,
      build.channel,
      build.trigger_name,
      build.base_publication_id,
      build.input_manifest_hash,
      build.claim_manifest_hash,
      build.link_manifest_hash,
      build.workgroup_manifest_hash,
      build.extractor_set_version,
      build.linker_version,
      build.reducer_version,
      build.packet_builder_version,
      build.packet_schema_version,
      build.status,
      build.packet_hash,
      build.semantic_hash,
      build.error_code,
      build.error_detail,
      build.started_at,
      build.finished_at,
      build.build_pair_id,
      build.precedence_policy_version,
      build.precedence_policy_hash,
      build.shipment_metadata_manifest_hash,
      build.processing_watermark_status,
      build.processing_watermark_hash
    from public.truth_builds build, parameters p, target
    where build.workspace_key = p.workspace_key
      and (
        build.source_cut_id = target.source_cut_id
        or exists (
          select 1
          from public.truth_publication_heads head
          join public.truth_publications publication
            on publication.publication_id = head.publication_id
          where head.workspace_key = p.workspace_key
            and publication.build_id = build.build_id
        )
      )
  ),$new_builds$;
  v_old_cache constant text := $old_cache$  cache_snapshots_base as (
    select snapshot.*
    from public.app_snapshots snapshot
    where snapshot.snapshot_key in ('shipment-truth-packets', 'active-awb-index')
  ),$old_cache$;
  v_new_cache constant text := $new_cache$  cache_snapshots_base as (
    select
      snapshot.snapshot_key,
      case
        when exists (
          select 1
          from heads_base head
          where head.channel = 'production'
        ) then snapshot.payload
        else jsonb_strip_nulls(jsonb_build_object(
          'publicationId', coalesce(
            snapshot.payload->'publicationId',
            snapshot.payload->'publication_id'
          ),
          'publicationVersion', coalesce(
            snapshot.payload->'publicationVersion',
            snapshot.payload->'publication_version'
          ),
          'publicationChannel', coalesce(
            snapshot.payload->'publicationChannel',
            snapshot.payload->'publication_channel'
          ),
          'sourceCutId', coalesce(
            snapshot.payload->'sourceCutId',
            snapshot.payload->'source_cut_id'
          ),
          'packetHash', coalesce(
            snapshot.payload->'packetHash',
            snapshot.payload->'packet_hash'
          ),
          'deliveryPayloadHash', coalesce(
            snapshot.payload->'deliveryPayloadHash',
            snapshot.payload->'delivery_payload_hash'
          ),
          'contentSignature', coalesce(
            snapshot.payload->'contentSignature',
            snapshot.payload->'content_signature'
          ),
          'truthPacketContentSignature', coalesce(
            snapshot.payload->'truthPacketContentSignature',
            snapshot.payload->'truth_packet_content_signature'
          ),
          'writerVersion', coalesce(
            snapshot.payload->'writerVersion',
            snapshot.payload->'writer_version'
          )
        ))
      end as payload,
      snapshot.updated_at
    from public.app_snapshots snapshot
    where snapshot.snapshot_key in ('shipment-truth-packets', 'active-awb-index')
  ),$new_cache$;
  v_old_jobs constant text := $old_jobs$  current_jobs_base as (
    select job.*
    from public.source_processing_jobs job, parameters p
    where job.workspace_key = p.workspace_key
      and (
        job.state in ('queued', 'leased', 'retry_wait', 'dead_letter')
        or exists (
          select 1
          from current_page_jobs_base membership
          where membership.job_id = job.job_id
        )
        or exists (
          select 1
          from current_job_lineage_base lineage
          where lineage.job_id = job.job_id
        )
      )
  ),$old_jobs$;
  v_new_jobs constant text := $new_jobs$  current_jobs_base as (
    select
      job.job_id,
      job.source_system,
      job.connection_key,
      job.job_kind,
      job.observation_id,
      job.source_object_id,
      job.state,
      case
        when job.job_kind = 'gmail_extract_message_model_claims'
          then jsonb_strip_nulls(jsonb_build_object(
            'modelPlanId', coalesce(
              job.payload->'modelPlanId',
              job.payload->'model_plan_id'
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
    from public.source_processing_jobs job, parameters p
    where job.workspace_key = p.workspace_key
      and (
        job.state in ('queued', 'leased', 'retry_wait', 'dead_letter')
        or exists (
          select 1
          from current_page_jobs_base membership
          where membership.job_id = job.job_id
        )
        or exists (
          select 1
          from current_job_lineage_base lineage
          where lineage.job_id = job.job_id
        )
      )
  ),$new_jobs$;
  v_old_claim_envelopes constant text := $old_claim_envelopes$  accepted_envelopes_base as (
    select envelope.*
    from public.accepted_claim_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'accepted_claim'
     and input.item_id = envelope.claim_version_id
  ),$old_claim_envelopes$;
  v_new_claim_envelopes constant text := $new_claim_envelopes$  accepted_envelopes_base as (
    select
      envelope.claim_version_id,
      envelope.envelope_hash,
      jsonb_build_object(
        'evidence', coalesce(envelope.canonical_envelope->'evidence', '[]'::jsonb)
      ) as canonical_envelope
    from public.accepted_claim_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'accepted_claim'
     and input.item_id = envelope.claim_version_id
  ),$new_claim_envelopes$;
  v_old_link_envelopes constant text := $old_link_envelopes$  link_envelopes_base as (
    select envelope.*
    from public.observation_entity_link_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'entity_link'
     and input.item_id = envelope.link_version_id
  ),$old_link_envelopes$;
  v_new_link_envelopes constant text := $new_link_envelopes$  link_envelopes_base as (
    select
      envelope.link_version_id,
      envelope.envelope_hash,
      jsonb_build_array(
        envelope.canonical_envelope#>'{link,observationId}',
        envelope.canonical_envelope#>'{link,observationContentHash}'
      ) as canonical_envelope
    from public.observation_entity_link_envelopes envelope
    join target_build_inputs_base input
      on input.item_kind = 'entity_link'
     and input.item_id = envelope.link_version_id
  ),$new_link_envelopes$;
  v_old_redundant_citations constant text := $old_redundant_citations$    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.accepted_claim_envelopes envelope
      on input.item_kind = 'accepted_claim'
     and envelope.claim_version_id = input.item_id
    cross join lateral private.truth_audit_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
    union
    select citation.citation_id
    from target_cut_build_inputs_base input
    join public.observation_entity_link_envelopes envelope
      on input.item_kind = 'entity_link'
     and envelope.link_version_id = input.item_id
    cross join lateral private.truth_audit_citation_ids(
      envelope.canonical_envelope, 'observation'
    ) citation
$old_redundant_citations$;
  v_new_redundant_citations constant text := $new_redundant_citations$    -- Accepted-claim evidence and entity-link rows above are the canonical
    -- observation citations. Avoid reparsing the same immutable envelopes.
$new_redundant_citations$;
  v_old_within_cut constant text := $old_within_cut$      private.source_observation_within_cut(
        p.workspace_key,
        target.source_cut_id,
        observation.observation_id,
        observation.content_hash
      ) as within_cut$old_within_cut$;
  v_new_within_cut constant text := $new_within_cut$      exists (
        select 1
        from public.source_cut_cursors cut_cursor
        where cut_cursor.source_cut_id = target.source_cut_id
          and cut_cursor.source_system = observation.source_system
          and cut_cursor.connection_key = observation.connection_key
          and observation.observation_id ~ '^obs:v1:[0-9a-f]{64}$'
          and observation.content_hash ~ '^[0-9a-f]{64}$'
          and observation.workspace_key = p.workspace_key
          and observation.source_cursor_version <= cut_cursor.through_cursor_version
          and batch.status = 'committed'
          and batch.workspace_key = observation.workspace_key
          and batch.source_system = observation.source_system
          and batch.connection_key = observation.connection_key
          and batch.committed_cursor_version >= observation.source_cursor_version
      ) as within_cut$new_within_cut$;
  v_old_lineage_projection constant text := $old_lineage_projection$  current_job_lineage_base as (
    select lineage.*
    from public.source_processing_job_lineage lineage
    join current_batch_ids selected on selected.batch_id = lineage.root_batch_id
  ),
  current_job_children_base as (
    select child.*
    from public.source_processing_job_children child
    where exists (
      select 1
      from current_job_lineage_base lineage
      where lineage.job_id = child.parent_job_id
         or lineage.job_id = child.child_job_id
    )
  ),
  current_job_observations_base as (
    select output.*
    from public.source_processing_job_observations output
    join current_job_lineage_base lineage on lineage.job_id = output.job_id
  ),$old_lineage_projection$;
  v_new_lineage_projection constant text := $new_lineage_projection$  current_job_lineage_base as (
    select
      lineage.job_id,
      lineage.parent_job_id,
      lineage.root_batch_id,
      lineage.root_job_id
    from public.source_processing_job_lineage lineage
    join current_batch_ids selected on selected.batch_id = lineage.root_batch_id
  ),
  current_job_children_base as (
    select child.parent_job_id, child.child_job_id, child.ordinal
    from public.source_processing_job_children child
    where exists (
      select 1
      from current_job_lineage_base lineage
      where lineage.job_id = child.parent_job_id
         or lineage.job_id = child.child_job_id
    )
  ),
  current_job_observations_base as (
    select output.job_id, output.observation_id, output.ordinal
    from public.source_processing_job_observations output
    join current_job_lineage_base lineage on lineage.job_id = output.job_id
  ),$new_lineage_projection$;
  v_old_observation_projection constant text := $old_observation_projection$    select
      observation.journal_seq,
      observation.observation_id,
      observation.workspace_key,
      observation.source_system,
      observation.connection_key,
      observation.source_object_type,
      observation.source_object_id,
      observation.source_revision,
      observation.operation,
      observation.source_cursor_version,
      observation.batch_id,
      observation.content_hash,
      observation.source_recorded_at,
      observation.captured_at,
      case
        when exists (
          select 1
          from current_page_observations_base membership
          where membership.observation_id = observation.observation_id
        ) then observation.normalized_payload
        when observation.source_object_type = 'gmail_attachment_extracted' then
          jsonb_build_object(
            'schemaVersion', observation.normalized_payload->>'schemaVersion',
            'parentObservationId', observation.normalized_payload->>'parentObservationId',
            'attachmentId', observation.normalized_payload->>'attachmentId',
            'filename', observation.normalized_payload->>'filename',
            'mimeType', observation.normalized_payload->>'mimeType',
            'extraction', coalesce(observation.normalized_payload->'extraction', '{}'::jsonb),
            'classification', observation.normalized_payload->'classification'
          )
        else jsonb_build_object(
          'schemaVersion', observation.schema_version,
          'payloadHash', encode(extensions.digest(
            convert_to(observation.normalized_payload::text, 'UTF8'),
            'sha256'
          ), 'hex'),
          'payloadBytes', pg_column_size(observation.normalized_payload)
        )
      end as normalized_payload,
      ''::text as normalized_text,
      observation.raw_object_bucket,
      observation.raw_object_key,
      observation.raw_object_version,
      observation.raw_object_etag,
      observation.raw_object_hash,
      observation.raw_object_bytes,
      observation.raw_content_type,
      observation.source_fidelity,
      observation.schema_version,
      observation.retention_class,
      observation.created_at
$old_observation_projection$;
  v_new_observation_projection constant text := $new_observation_projection$    select
      observation.journal_seq,
      observation.observation_id,
      observation.source_object_type,
      observation.source_object_id,
      case
        when exists (
          select 1
          from current_page_observations_base membership
          where membership.observation_id = observation.observation_id
        ) then observation.normalized_payload
        when observation.source_object_type = 'gmail_attachment_extracted' then
          jsonb_build_object(
            'schemaVersion', observation.normalized_payload->>'schemaVersion',
            'parentObservationId', observation.normalized_payload->>'parentObservationId',
            'attachmentId', observation.normalized_payload->>'attachmentId',
            'filename', observation.normalized_payload->>'filename',
            'mimeType', observation.normalized_payload->>'mimeType',
            'extraction', coalesce(observation.normalized_payload->'extraction', '{}'::jsonb),
            'classification', observation.normalized_payload->'classification'
          )
        else '{}'::jsonb
      end as normalized_payload
$new_observation_projection$;
  v_old_final_projection constant text := $old_final_projection$      'observations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.journal_seq) from bounded_observations row_value), '[]'::jsonb),
      'jobs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.created_at, row_value.job_id) from bounded_jobs row_value), '[]'::jsonb),
      'pageObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal, row_value.observation_id) from bounded_page_observations row_value), '[]'::jsonb),
      'pageJobs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal, row_value.job_id) from bounded_page_jobs row_value), '[]'::jsonb),
      'jobLineage', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.root_batch_id, row_value.root_job_id, row_value.job_id) from bounded_job_lineage row_value), '[]'::jsonb),
      'jobChildren', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.parent_job_id, row_value.ordinal, row_value.child_job_id) from bounded_job_children row_value), '[]'::jsonb),
      'jobObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.job_id, row_value.ordinal, row_value.observation_id) from bounded_job_observations row_value), '[]'::jsonb),$old_final_projection$;
  v_new_final_projection constant text := $new_final_projection$      'observations', coalesce((select jsonb_agg(to_jsonb(row_value) - 'journal_seq' order by row_value.journal_seq) from bounded_observations row_value), '[]'::jsonb),
      'jobs', coalesce((select jsonb_agg(to_jsonb(row_value) - 'created_at' order by row_value.created_at, row_value.job_id) from bounded_jobs row_value), '[]'::jsonb),
      'pageObservations', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal, row_value.observation_id) from bounded_page_observations row_value), '[]'::jsonb),
      'pageJobs', coalesce((select jsonb_agg(to_jsonb(row_value) order by row_value.batch_id, row_value.page_ordinal, row_value.job_id) from bounded_page_jobs row_value), '[]'::jsonb),
      'jobLineage', coalesce((select jsonb_agg(to_jsonb(row_value) - 'root_batch_id' - 'root_job_id' order by row_value.root_batch_id, row_value.root_job_id, row_value.job_id) from bounded_job_lineage row_value), '[]'::jsonb),
      'jobChildren', coalesce((select jsonb_agg(to_jsonb(row_value) - 'ordinal' order by row_value.parent_job_id, row_value.ordinal, row_value.child_job_id) from bounded_job_children row_value), '[]'::jsonb),
      'jobObservations', coalesce((select jsonb_agg(to_jsonb(row_value) - 'ordinal' order by row_value.job_id, row_value.ordinal, row_value.observation_id) from bounded_job_observations row_value), '[]'::jsonb),$new_final_projection$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_rewritten := v_definition;

  if position('current-headed-build-scope-v1' in v_rewritten) = 0
    and position(v_new_builds in v_rewritten) = 0 then
    if position(v_old_builds in v_rewritten) = 0 then
      raise exception 'truth audit build projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old_builds, v_new_builds);
  end if;

  if position('source-verified-compact-v1' in v_rewritten) = 0
    and position(v_new_cache in v_rewritten) = 0 then
    if position(v_old_cache in v_rewritten) = 0 then
      raise exception 'truth audit cache projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old_cache, v_new_cache);
  end if;

  if position(v_new_jobs in v_rewritten) = 0 then
    if position(v_old_jobs in v_rewritten) = 0 then
      raise exception 'truth audit job projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old_jobs, v_new_jobs);
  end if;

  if position(v_new_claim_envelopes in v_rewritten) = 0 then
    if position(v_old_claim_envelopes in v_rewritten) = 0 then
      raise exception 'truth audit claim-envelope projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(
      v_rewritten,
      v_old_claim_envelopes,
      v_new_claim_envelopes
    );
  end if;

  if position(v_new_link_envelopes in v_rewritten) = 0 then
    if position(v_old_link_envelopes in v_rewritten) = 0 then
      raise exception 'truth audit link-envelope projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(
      v_rewritten,
      v_old_link_envelopes,
      v_new_link_envelopes
    );
  end if;

  if position(v_new_redundant_citations in v_rewritten) = 0 then
    if position(v_old_redundant_citations in v_rewritten) = 0 then
      raise exception 'truth audit citation projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(
      v_rewritten,
      v_old_redundant_citations,
      v_new_redundant_citations
    );
  end if;

  if position(v_new_within_cut in v_rewritten) = 0 then
    if position(v_old_within_cut in v_rewritten) = 0 then
      raise exception 'truth audit source-cut witness differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old_within_cut, v_new_within_cut);
  end if;

  if position(v_new_lineage_projection in v_rewritten) = 0 then
    if position(v_old_lineage_projection in v_rewritten) = 0 then
      raise exception 'truth audit lineage projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(
      v_rewritten,
      v_old_lineage_projection,
      v_new_lineage_projection
    );
  end if;

  if position(v_new_observation_projection in v_rewritten) = 0 then
    if position(v_old_observation_projection in v_rewritten) = 0 then
      raise exception 'truth audit observation projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(
      v_rewritten,
      v_old_observation_projection,
      v_new_observation_projection
    );
  end if;

  if position(v_new_final_projection in v_rewritten) = 0 then
    if position(v_old_final_projection in v_rewritten) = 0 then
      raise exception 'truth audit final projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_rewritten := replace(v_rewritten, v_old_final_projection, v_new_final_projection);
  end if;

  if (position('current-headed-build-scope-v1' in v_rewritten) = 0 and (
      position(v_old_builds in v_rewritten) > 0
      or position(v_new_builds in v_rewritten) = 0
    ))
    or (position('source-verified-compact-v1' in v_rewritten) = 0 and (
      position(v_old_cache in v_rewritten) > 0
      or position(v_new_cache in v_rewritten) = 0
    ))
    or position(v_old_jobs in v_rewritten) > 0
    or position(v_new_jobs in v_rewritten) = 0
    or position(v_old_claim_envelopes in v_rewritten) > 0
    or position(v_new_claim_envelopes in v_rewritten) = 0
    or position(v_old_link_envelopes in v_rewritten) > 0
    or position(v_new_link_envelopes in v_rewritten) = 0
    or position(v_old_redundant_citations in v_rewritten) > 0
    or position(v_new_redundant_citations in v_rewritten) = 0
    or position(v_old_within_cut in v_rewritten) > 0
    or position(v_new_within_cut in v_rewritten) = 0
    or position(v_old_lineage_projection in v_rewritten) > 0
    or position(v_new_lineage_projection in v_rewritten) = 0
    or position(v_old_observation_projection in v_rewritten) > 0
    or position(v_new_observation_projection in v_rewritten) = 0
    or position(v_old_final_projection in v_rewritten) > 0
    or position(v_new_final_projection in v_rewritten) = 0 then
    raise exception 'truth audit bounded transport rewrite did not apply exactly'
      using errcode = '23514';
  end if;

  if v_rewritten <> v_definition then
    execute v_rewritten;
  end if;
end;
$rewrite$;

do $rewrite_gap_transport$
declare
  v_attachment_signature constant regprocedure :=
    'private.read_truth_audit_snapshot_pre_processing_watermark(text,integer,text)'::regprocedure;
  v_model_signature constant regprocedure :=
    'private.read_truth_audit_snapshot(text,integer,text)'::regprocedure;
  v_attachment_definition text;
  v_model_definition text;
  v_old_attachment constant text := $old_attachment$  with unresolved_base as (
    select *
    from private.unresolved_gmail_attachment_extractions(p_workspace_key)
  ), bounded_unresolved as ($old_attachment$;
  v_new_attachment constant text := $new_attachment$  with unresolved_base as (
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
  ), bounded_unresolved as ($new_attachment$;
  v_old_model_jobs constant text := $old_model_jobs$  with base as(select * from private.unresolved_gmail_model_extraction_jobs(p_workspace_key)),
  bounded as($old_model_jobs$;
  v_new_model_jobs constant text := $new_model_jobs$  with base as(select
    extraction_plan_id,
    model_plan_id,
    parent_job_id,
    model_child_job_id,
    source_observation_id,
    model_child_job_state,
    execution_mode,
    context_seal_id,
    created_at
    from private.unresolved_gmail_model_extraction_jobs(p_workspace_key)),
  bounded as($new_model_jobs$;
  v_old_model_reviews constant text := $old_model_reviews$  with base as(select * from private.unresolved_gmail_model_extraction_reviews(p_workspace_key)),
  bounded as($old_model_reviews$;
  v_new_model_reviews constant text := $new_model_reviews$  with base as(select
    obligation_id,
    extraction_plan_id,
    review_job_id,
    model_plan_id,
    review_job_state,
    reason_code,
    safe_detail_hash,
    created_at
    from private.unresolved_gmail_model_extraction_reviews(p_workspace_key)),
  bounded as($new_model_reviews$;
  v_old_attachment_json constant text := $old_attachment_json$select jsonb_agg(to_jsonb(row_value)
        order by row_value.captured_at, row_value.attachment_observation_id)$old_attachment_json$;
  v_new_attachment_json constant text := $new_attachment_json$select jsonb_agg(to_jsonb(row_value) - 'captured_at'
        order by row_value.captured_at, row_value.attachment_observation_id)$new_attachment_json$;
  v_old_model_job_json constant text := $old_model_job_json$select jsonb_agg(to_jsonb(row_value)
    order by row_value.created_at,row_value.extraction_plan_id)$old_model_job_json$;
  v_new_model_job_json constant text := $new_model_job_json$select jsonb_agg(to_jsonb(row_value) - 'created_at'
    order by row_value.created_at,row_value.extraction_plan_id)$new_model_job_json$;
  v_old_model_review_json constant text := $old_model_review_json$select jsonb_agg(to_jsonb(row_value)
    order by row_value.created_at,row_value.obligation_id)$old_model_review_json$;
  v_new_model_review_json constant text := $new_model_review_json$select jsonb_agg(to_jsonb(row_value) - 'created_at'
    order by row_value.created_at,row_value.obligation_id)$new_model_review_json$;
begin
  select pg_get_functiondef(v_attachment_signature)
  into v_attachment_definition;
  if position(v_new_attachment in v_attachment_definition) = 0 then
    if position(v_old_attachment in v_attachment_definition) = 0 then
      raise exception 'truth audit attachment-gap projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_attachment_definition := replace(
      v_attachment_definition,
      v_old_attachment,
      v_new_attachment
    );
  end if;
  if position(v_new_attachment_json in v_attachment_definition) = 0 then
    if position(v_old_attachment_json in v_attachment_definition) = 0 then
      raise exception 'truth audit attachment-gap JSON differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_attachment_definition := replace(
      v_attachment_definition,
      v_old_attachment_json,
      v_new_attachment_json
    );
  end if;
  if position(v_old_attachment in v_attachment_definition) > 0
    or position(v_new_attachment in v_attachment_definition) = 0
    or position(v_old_attachment_json in v_attachment_definition) > 0
    or position(v_new_attachment_json in v_attachment_definition) = 0 then
    raise exception 'truth audit attachment-gap transport rewrite did not apply exactly'
      using errcode = '23514';
  end if;
  execute v_attachment_definition;

  select pg_get_functiondef(v_model_signature)
  into v_model_definition;
  if position(v_new_model_jobs in v_model_definition) = 0 then
    if position(v_old_model_jobs in v_model_definition) = 0 then
      raise exception 'truth audit model-job projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_model_definition := replace(v_model_definition, v_old_model_jobs, v_new_model_jobs);
  end if;
  if position(v_new_model_reviews in v_model_definition) = 0 then
    if position(v_old_model_reviews in v_model_definition) = 0 then
      raise exception 'truth audit model-review projection differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_model_definition := replace(
      v_model_definition,
      v_old_model_reviews,
      v_new_model_reviews
    );
  end if;
  if position(v_new_model_job_json in v_model_definition) = 0 then
    if position(v_old_model_job_json in v_model_definition) = 0 then
      raise exception 'truth audit model-job JSON differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_model_definition := replace(
      v_model_definition,
      v_old_model_job_json,
      v_new_model_job_json
    );
  end if;
  if position(v_new_model_review_json in v_model_definition) = 0 then
    if position(v_old_model_review_json in v_model_definition) = 0 then
      raise exception 'truth audit model-review JSON differs from the reviewed predecessor'
        using errcode = '23514';
    end if;
    v_model_definition := replace(
      v_model_definition,
      v_old_model_review_json,
      v_new_model_review_json
    );
  end if;
  if position(v_old_model_jobs in v_model_definition) > 0
    or position(v_new_model_jobs in v_model_definition) = 0
    or position(v_old_model_reviews in v_model_definition) > 0
    or position(v_new_model_reviews in v_model_definition) = 0
    or position(v_old_model_job_json in v_model_definition) > 0
    or position(v_new_model_job_json in v_model_definition) = 0
    or position(v_old_model_review_json in v_model_definition) > 0
    or position(v_new_model_review_json in v_model_definition) = 0 then
    raise exception 'truth audit model-gap transport rewrite did not apply exactly'
      using errcode = '23514';
  end if;
  execute v_model_definition;
end;
$rewrite_gap_transport$;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(p.oid), p.proconfig
  into v_definition, v_config
  from pg_proc p
  where p.oid =
    'private.read_truth_audit_snapshot_core(text,integer,text)'::regprocedure;

  if position('select build.*' in v_definition) > 0
    or position('select snapshot.*' in v_definition) > 0
    or position('select job.*' in v_definition) > 0
    or position('build.processing_watermark_hash' in v_definition) = 0
    or position('build.shipment_metadata_manifest_hash' in v_definition) = 0
    or position('jsonb_strip_nulls(jsonb_build_object(' in v_definition) = 0
    or position($needle$head.channel = 'production'$needle$ in v_definition) = 0
    or (position('source-verified-compact-v1' in v_definition) = 0
      and position('then snapshot.payload' in v_definition) = 0)
    or position($needle$job.job_kind = 'gmail_extract_message_model_claims'$needle$ in v_definition) = 0
    or position($needle$'operator_extract_claims'$needle$ in v_definition) = 0
    or position($needle$envelope.canonical_envelope->'evidence'$needle$ in v_definition) = 0
    or position($needle$jsonb_build_array($needle$ in v_definition) = 0
    or position($needle$envelope.canonical_envelope#>'{link,observationId}'$needle$ in v_definition) = 0
    or position('Avoid reparsing the same immutable envelopes' in v_definition) = 0
    or position('private.source_observation_within_cut(' in v_definition) > 0
    or position('from public.source_cut_cursors cut_cursor' in v_definition) = 0
    or position('lineage.root_job_id' in v_definition) = 0
    or position('select output.job_id, output.observation_id' in v_definition) = 0
    or position($needle$else '{}'::jsonb$needle$ in v_definition) = 0
    or position($needle$to_jsonb(row_value) - 'root_batch_id' - 'root_job_id'$needle$ in v_definition) = 0
    or coalesce(not ('search_path=""' = any(v_config)), true) then
    raise exception 'truth audit core failed bounded transport verification'
      using errcode = '23514';
  end if;
end;
$verify$;

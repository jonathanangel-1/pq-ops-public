-- Complete the source-wide acceptance architecture for deterministic generic
-- evidence. Generic claim workers already stop at immutable candidate
-- envelopes and the source-cut guard already requires a completed acceptance
-- epoch. This migration lets the existing oldest-first coordinator consume
-- only exact registered TMS, tracking, and operator batches. It adds no build,
-- publication, model, or operational authority.

do $preflight$
declare
  v_definition text;
begin
  if to_regclass('public.truth_shadow_claim_acceptance_epochs') is null
    or to_regclass('public.truth_pending_acceptance_epochs') is null
    or to_regclass('public.source_ingest_manifests') is null
    or to_regprocedure('private.run_truth_shadow_claim_acceptance_epoch(text,text,text)') is null
    or to_regprocedure('private.truth_tms_policy_candidate_eligible(jsonb)') is null
    or to_regprocedure('private.truth_tracking_policy_candidate_eligible(jsonb,jsonb)') is null
    or to_regprocedure('private.truth_operator_policy_candidate_eligible(jsonb,jsonb)') is null then
    raise exception 'generic source acceptance prerequisites are missing'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('truth-shadow-claim-acceptance-epoch-v2' in v_definition) = 0
    or position('private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)' in v_definition) = 0
    or position('truth_shadow_review_decision_adoption_v1' in v_definition) = 0
    or position('EARLIER_ACCEPTANCE_EPOCH_INCOMPLETE' in v_definition) = 0 then
    raise exception 'acceptance coordinator differs from the reviewed mixed-authority runtime'
      using errcode = '23514';
  end if;
end;
$preflight$;

create or replace function private.truth_generic_acceptance_scope_valid_v1(
  p_pending public.truth_pending_acceptance_epochs
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_contract jsonb;
begin
  if p_pending.workspace_key is distinct from 'primary'
    or p_pending.schema_version is distinct from
      'pending-acceptance-epoch-obligation-v1'
    or p_pending.obligation_id is distinct from
      'pending-acceptance-epoch:v1:' || p_pending.obligation_hash
    or p_pending.obligation_hash is distinct from encode(extensions.digest(
      convert_to(private.truth_canonical_json_text(
        p_pending.canonical_obligation
      ), 'UTF8'), 'sha256'
    ), 'hex')
    or p_pending.canonical_obligation is distinct from jsonb_build_object(
      'schemaVersion', 'pending-acceptance-epoch-obligation-v1',
      'workspaceKey', p_pending.workspace_key,
      'sourceSystem', p_pending.source_system,
      'connectionKey', p_pending.connection_key,
      'rootBatchId', p_pending.root_batch_id,
      'sourceCursorVersion', p_pending.source_cursor_version,
      'sourceCursorValue', p_pending.source_cursor_value,
      'blockerCode', 'ACCEPTANCE_EPOCH_COORDINATOR_REQUIRED'
    )
    or not (
      (p_pending.source_system = 'tms'
        and p_pending.connection_key = 'couriercloud-ops-tlv-us')
      or (p_pending.source_system = 'tracking'
        and p_pending.connection_key = 'carrier-tracking-primary')
      or (p_pending.source_system = 'operator'
        and p_pending.connection_key = 'operator-phone-primary')
    ) then
    return false;
  end if;

  v_contract := private.source_snapshot_contract(p_pending.source_system);
  if v_contract is null then
    return false;
  end if;

  return exists (
      select 1
      from public.truth_required_sources required_source
      where required_source.workspace_key = p_pending.workspace_key
        and required_source.source_system = p_pending.source_system
        and required_source.connection_key = p_pending.connection_key
        and required_source.cursor_kind = v_contract->>'cursorKind'
        and required_source.registry_version = 'truth-required-sources-v1'
    )
    and exists (
      select 1
      from public.source_ingest_batches batch
      join public.source_ingest_manifests manifest
        on manifest.batch_id = batch.batch_id
       and manifest.workspace_key = batch.workspace_key
       and manifest.source_system = batch.source_system
       and manifest.connection_key = batch.connection_key
      where batch.workspace_key = p_pending.workspace_key
        and batch.batch_id = p_pending.root_batch_id
        and batch.source_system = p_pending.source_system
        and batch.connection_key = p_pending.connection_key
        and batch.status = 'committed'
        and batch.mode in ('snapshot', 'snapshot_recovery')
        and batch.committed_cursor_version = p_pending.source_cursor_version
        and batch.committed_cursor_value = p_pending.source_cursor_value
        and manifest.next_cursor_value = p_pending.source_cursor_value
        and manifest.provider_manifest_hash ~ '^[0-9a-f]{64}$'
        and manifest.observation_manifest_hash ~ '^[0-9a-f]{64}$'
        and manifest.job_manifest_hash ~ '^[0-9a-f]{64}$'
        and manifest.payload_identity_hash =
          private.source_snapshot_payload_identity(
            batch.workspace_key,
            batch.source_system,
            batch.connection_key,
            manifest.next_cursor_value,
            manifest.provider_manifest_hash,
            manifest.observation_manifest_hash,
            manifest.job_manifest_hash
          )
        and batch.observation_count = jsonb_array_length(
          manifest.observation_manifest
        )
        and batch.job_count = jsonb_array_length(manifest.job_manifest)
    )
    and exists (
      select 1
      from public.source_cursors cursor_row
      where cursor_row.workspace_key = p_pending.workspace_key
        and cursor_row.source_system = p_pending.source_system
        and cursor_row.connection_key = p_pending.connection_key
        and cursor_row.cursor_kind = v_contract->>'cursorKind'
        and cursor_row.status = 'live'
        and cursor_row.cursor_version >= p_pending.source_cursor_version
    );
end;
$function$;

revoke all on function private.truth_generic_acceptance_scope_valid_v1(
  public.truth_pending_acceptance_epochs
) from public, anon, authenticated, service_role;

-- The table name is retained for compatibility. Its rows remain quarantined,
-- non-production acceptance receipts; widen only the exact source pairs that
-- the coordinator can independently prove above.
do $acceptance_source_scope$
declare
  v_constraint text;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.truth_shadow_claim_acceptance_epochs'::regclass
      and constraint_row.contype = 'c'
      and (
        pg_get_constraintdef(constraint_row.oid) ~ '\msource_system\M'
        or pg_get_constraintdef(constraint_row.oid) ~ '\mconnection_key\M'
      )
  loop
    execute format(
      'alter table public.truth_shadow_claim_acceptance_epochs drop constraint %I',
      v_constraint
    );
  end loop;
  alter table public.truth_shadow_claim_acceptance_epochs
    add constraint truth_shadow_claim_acceptance_epochs_source_scope_v3_check
    check (
      (source_system = 'gmail'
        and (connection_key = 'primary' or connection_key like 'shadow-%'))
      or (source_system = 'tms'
        and connection_key = 'couriercloud-ops-tlv-us')
      or (source_system = 'tracking'
        and connection_key = 'carrier-tracking-primary')
      or (source_system = 'operator'
        and connection_key = 'operator-phone-primary')
    );
end;
$acceptance_source_scope$;

do $rewrite_scope_gate$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  if v_pending.source_system <> 'gmail'
    or not (
      (
        v_pending.connection_key like 'shadow-%'
        and not exists (
          select 1
          from public.truth_required_sources required_source
          where required_source.workspace_key = v_pending.workspace_key
            and required_source.source_system = v_pending.source_system
            and required_source.connection_key = v_pending.connection_key
        )
      )
      or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)
    ) then$old$;
  v_new text := $new$  if not (
      (
        v_pending.source_system = 'gmail'
        and (
          (
            v_pending.connection_key like 'shadow-%'
            and not exists (
              select 1
              from public.truth_required_sources required_source
              where required_source.workspace_key = v_pending.workspace_key
                and required_source.source_system = v_pending.source_system
                and required_source.connection_key = v_pending.connection_key
            )
          )
          or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)
        )
      )
      or private.truth_generic_acceptance_scope_valid_v1(v_pending)
    ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'generic acceptance source-scope rewrite did not match reviewed runtime'
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_scope_gate$;

do $rewrite_cursor_gate$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$      or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)
    ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'SHADOW_ROOT_CURSOR_NOT_CURRENT',$old$;
  v_new text := $new$      or private.truth_gmail_live_acceptance_scope_valid_v1(v_pending)
      or private.truth_generic_acceptance_scope_valid_v1(v_pending)
    ) then
    return jsonb_build_object(
      'ok', true,
      'status', 'not_ready',
      'obligationId', p_obligation_id,
      'reasonCode', 'SHADOW_ROOT_CURSOR_NOT_CURRENT',$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'generic acceptance cursor-scope rewrite did not match reviewed runtime'
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_cursor_gate$;

do $rewrite_gmail_frontier_gate$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$  if not exists (
      select 1
      from public.gmail_parse_checkpoints checkpoint
      where checkpoint.workspace_key = p_workspace_key
        and checkpoint.root_batch_id = v_pending.root_batch_id
        and checkpoint.connection_key = v_pending.connection_key
        and checkpoint.source_cursor_version = v_pending.source_cursor_version
        and checkpoint.source_cursor_value = v_pending.source_cursor_value
    ) or not exists (
      select 1
      from public.truth_gmail_link_epochs link_epoch
      join public.truth_gmail_link_epoch_seals link_seal
        on link_seal.workspace_key = link_epoch.workspace_key
       and link_seal.epoch_id = link_epoch.epoch_id
      where link_epoch.workspace_key = p_workspace_key
        and link_epoch.root_batch_id = v_pending.root_batch_id
        and link_epoch.connection_key = v_pending.connection_key
    ) then$old$;
  v_new text := $new$  if v_pending.source_system = 'gmail' and (
    not exists (
      select 1
      from public.gmail_parse_checkpoints checkpoint
      where checkpoint.workspace_key = p_workspace_key
        and checkpoint.root_batch_id = v_pending.root_batch_id
        and checkpoint.connection_key = v_pending.connection_key
        and checkpoint.source_cursor_version = v_pending.source_cursor_version
        and checkpoint.source_cursor_value = v_pending.source_cursor_value
    ) or not exists (
      select 1
      from public.truth_gmail_link_epochs link_epoch
      join public.truth_gmail_link_epoch_seals link_seal
        on link_seal.workspace_key = link_epoch.workspace_key
       and link_seal.epoch_id = link_epoch.epoch_id
      where link_epoch.workspace_key = p_workspace_key
        and link_epoch.root_batch_id = v_pending.root_batch_id
        and link_epoch.connection_key = v_pending.connection_key
    )
  ) then$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'generic acceptance Gmail-frontier rewrite did not match reviewed runtime'
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_gmail_frontier_gate$;

do $rewrite_claim_job_scope$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$    and job.job_kind = any(array[
      'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
    ])
    and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
      job.workspace_key, job.job_id
    )
    -- EXPLICIT_ATTACHMENT_RESOLUTION_CLAIM_COVERAGE_V1
    and not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
      job.workspace_key, job.job_id
    )$old$;
  v_new text := $new$    and job.job_kind = any(array[
      'gmail_extract_message_claims', 'gmail_extract_attachment_claims',
      'tms_extract_claims', 'tracking_extract_claims', 'operator_extract_claims'
    ])
    and (
      v_pending.source_system <> 'gmail'
      or (
        not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
          job.workspace_key, job.job_id
        )
        -- EXPLICIT_ATTACHMENT_RESOLUTION_CLAIM_COVERAGE_V1
        and not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
          job.workspace_key, job.job_id
        )
      )
    )$new$;
  v_matches integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_matches := (length(v_definition) - length(replace(v_definition, v_old, '')))
    / length(v_old);
  if v_matches <> 1 then
    raise exception 'generic acceptance claim-job count rewrite expected 1 match, found %', v_matches
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_claim_job_scope$;

do $rewrite_claim_job_completeness_scope$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$        and job.job_kind = any(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims'
        ])
        and not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
          job.workspace_key, job.job_id
        )
        and not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
          job.workspace_key, job.job_id
        )$old$;
  v_new text := $new$        and job.job_kind = any(array[
          'gmail_extract_message_claims', 'gmail_extract_attachment_claims',
          'tms_extract_claims', 'tracking_extract_claims', 'operator_extract_claims'
        ])
        and (
          v_pending.source_system <> 'gmail'
          or (
            not private.truth_shadow_is_reconciled_stale_gmail_claim_v1(
              job.workspace_key, job.job_id
            )
            and not private.truth_shadow_gmail_attachment_claim_resolution_covered_v1(
              job.workspace_key, job.job_id
            )
          )
        )$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'generic acceptance claim-job completeness rewrite did not match reviewed runtime'
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_claim_job_completeness_scope$;

do $rewrite_candidate_payload$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$      observation.captured_at as observation_captured_at,
      observation.journal_seq$old$;
  v_new text := $new$      observation.captured_at as observation_captured_at,
      observation.journal_seq,
      observation.normalized_payload as source_payload$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'generic acceptance candidate-payload rewrite did not match reviewed runtime'
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_candidate_payload$;

do $rewrite_policy_gate$
declare
  v_signature regprocedure :=
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  v_definition text;
  v_old text := $old$      and v_candidate.source_object_type = any(array[
        'gmail_message_parsed', 'gmail_attachment_extracted'
      ])
      and (
        v_candidate.source_object_type <> 'gmail_attachment_extracted'
        or v_candidate.source_extraction_method = any(array[
          'pdf-text+quality-v1', 'utf8-text-v1', 'html-to-text-v1'
        ])
      )
      and exists (
        select 1
        from public.candidate_claim_predicate_registry registry
        where registry.predicate = v_candidate_body->>'predicate'
          and registry.extractor_version = v_candidate_body->>'extractorVersion'
          and registry.source_system = 'gmail'
          and registry.gate = v_candidate_body->>'gate'
          and registry.acceptance_policy_version =
            v_candidate.recommendation_policy_version
          and registry.statuses->>(v_candidate_body->>'polarity') =
            v_candidate_body->'normalizedValue'->>'status'
          and registry.effects->>(v_candidate_body->>'polarity') =
            v_candidate_body->'normalizedValue'->>'effect'
      );$old$;
  v_new text := $new$      and (
        (
          v_pending.source_system = 'gmail'
          and v_candidate.source_object_type = any(array[
            'gmail_message_parsed', 'gmail_attachment_extracted'
          ])
          and (
            v_candidate.source_object_type <> 'gmail_attachment_extracted'
            or v_candidate.source_extraction_method = any(array[
              'pdf-text+quality-v1', 'utf8-text-v1', 'html-to-text-v1'
            ])
          )
        )
        or (
          v_pending.source_system = 'tms'
          and v_candidate.source_object_type = 'tms_shipment_snapshot'
          and private.truth_tms_policy_candidate_eligible(v_candidate_body)
        )
        or (
          v_pending.source_system = 'tracking'
          and v_candidate.source_object_type = 'tracking_shipment_snapshot'
          and private.truth_tracking_policy_candidate_eligible(
            v_candidate_body, v_candidate.source_payload
          )
        )
        or (
          v_pending.source_system = 'operator'
          and v_candidate.source_object_type = 'operator_event'
          and private.truth_operator_policy_candidate_eligible(
            v_candidate_body, v_candidate.source_payload
          )
        )
      )
      and exists (
        select 1
        from public.candidate_claim_predicate_registry registry
        where registry.predicate = v_candidate_body->>'predicate'
          and registry.extractor_version = v_candidate_body->>'extractorVersion'
          and registry.source_system = v_pending.source_system
          and registry.gate = v_candidate_body->>'gate'
          and registry.acceptance_policy_version =
            v_candidate.recommendation_policy_version
          and registry.statuses->>(v_candidate_body->>'polarity') =
            v_candidate_body->'normalizedValue'->>'status'
          and registry.effects->>(v_candidate_body->>'polarity') =
            v_candidate_body->'normalizedValue'->>'effect'
      );$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'generic acceptance policy-gate rewrite did not match reviewed runtime'
      using errcode = '23514';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$rewrite_policy_gate$;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  select pg_get_functiondef(
    'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('private.truth_generic_acceptance_scope_valid_v1(v_pending)' in v_definition) = 0
    or position('''tms_extract_claims'', ''tracking_extract_claims'', ''operator_extract_claims''' in v_definition) = 0
    or position('private.truth_tms_policy_candidate_eligible(v_candidate_body)' in v_definition) = 0
    or position('private.truth_tracking_policy_candidate_eligible(' in v_definition) = 0
    or position('private.truth_operator_policy_candidate_eligible(' in v_definition) = 0
    or position('registry.source_system = v_pending.source_system' in v_definition) = 0
    or position('EARLIER_ACCEPTANCE_EPOCH_INCOMPLETE' in v_definition) = 0
    or position('truth-source-cut-serialization-v1:' in v_definition) = 0 then
    raise exception 'generic source acceptance adapter is incomplete or weakened'
      using errcode = '55000';
  end if;
  select proconfig into v_config
  from pg_catalog.pg_proc
  where oid = 'private.run_truth_shadow_claim_acceptance_epoch(text,text,text)'::regprocedure;
  if v_config is null or not ('search_path=""' = any(v_config)) then
    raise exception 'generic source acceptance coordinator lost its empty search_path'
      using errcode = '55000';
  end if;
  if has_function_privilege('public',
      'private.truth_generic_acceptance_scope_valid_v1(public.truth_pending_acceptance_epochs)',
      'EXECUTE')
    or has_function_privilege('anon',
      'private.truth_generic_acceptance_scope_valid_v1(public.truth_pending_acceptance_epochs)',
      'EXECUTE')
    or has_function_privilege('authenticated',
      'private.truth_generic_acceptance_scope_valid_v1(public.truth_pending_acceptance_epochs)',
      'EXECUTE')
    or has_function_privilege('service_role',
      'private.truth_generic_acceptance_scope_valid_v1(public.truth_pending_acceptance_epochs)',
      'EXECUTE') then
    raise exception 'generic acceptance scope helper privileges widened'
      using errcode = '42501';
  end if;
end;
$verify$;

-- Hosted Gmail claims-readiness spine.
--
-- The exact primary-mailbox mega-backfill was parked by 20260717170000.  Its
-- immutable receipt and two explicit completeness gaps are an honest boundary,
-- not proof that the parked observations were processed.  This migration lets
-- committed Gmail history batches strictly after that boundary form their own
-- parse/checkpoint chain, then exposes a read-only oldest-first frontier for the
-- hosted checkpoint -> link epoch -> claim-admission coordinator.
--
-- The exception is deliberately non-generic: it is bound to one parked batch,
-- one scope, one cutover history ID, the canonical receipt hash, and both gap
-- receipts.  Ordinary full-mailbox epoch doctrine remains fail-closed.  This
-- migration never publishes and does not alter either link-epoch authority.

do $preflight$
begin
  if to_regclass('public.truth_gmail_backfill_parking_receipts') is null
    or to_regclass('public.gmail_parse_processing_epochs') is null
    or to_regclass('public.gmail_parse_checkpoints') is null
    or to_regclass('public.truth_gmail_link_epochs') is null
    or to_regclass('public.truth_gmail_link_epoch_members') is null
    or to_regclass('public.truth_gmail_link_epoch_seals') is null
    or to_regprocedure('private.valid_truth_sync_token(text)') is null
    or to_regprocedure('private.truth_canonical_json_text(jsonb)') is null
    or to_regprocedure('private.gmail_history_id_at_least(text,text)') is null
    or to_regprocedure(
      'private.ensure_gmail_parse_checkpoint_chain_v1(text,text,uuid,integer)'
    ) is null
    or to_regprocedure(
      'private.auto_resolve_gmail_revision_obligations_v1(text,text,uuid,text)'
    ) is null
    or to_regprocedure(
      'public.open_truth_gmail_link_epoch(text,uuid,text)'
    ) is null
    or to_regprocedure(
      'public.seal_truth_gmail_link_epoch(text,text,text)'
    ) is null then
    raise exception 'Gmail claims-readiness spine prerequisites are missing'
      using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
  p_receipt public.truth_gmail_backfill_parking_receipts
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    p_receipt.receipt_id =
      'truth-gmail-backfill-parking:v1:' || p_receipt.receipt_hash
    and p_receipt.receipt_hash = encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(p_receipt.canonical_receipt),
      'UTF8'
    ), 'sha256'), 'hex')
    and p_receipt.workspace_key = 'primary'
    and p_receipt.source_system = 'gmail'
    and p_receipt.connection_key = 'primary'
    and p_receipt.parked_batch_id =
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid
    and p_receipt.coordinator_job_id =
      '5ae52e8d-dd30-582b-aef3-1ebdc65f0970'::uuid
    and p_receipt.persisted_anchor_history_id = '19571223'
    and p_receipt.cutover_history_id = '19640268'
    and p_receipt.resumed_cursor_version = p_receipt.prior_cursor_version + 1
    and p_receipt.page_count = 2190
    and p_receipt.observation_count = 218989
    and p_receipt.job_count = 0
    and p_receipt.schema_version =
      'truth-gmail-backfill-parking-receipt-v1'
    and p_receipt.canonical_receipt->>'schemaVersion' =
      'truth-gmail-backfill-parking-receipt-v1'
    and p_receipt.canonical_receipt->>'authorityVersion' =
      'truth-gmail-primary-ingest-forward-unblock-v1'
    and p_receipt.canonical_receipt->>'workspaceKey' = p_receipt.workspace_key
    and p_receipt.canonical_receipt->>'sourceSystem' = p_receipt.source_system
    and p_receipt.canonical_receipt->>'connectionKey' = p_receipt.connection_key
    and p_receipt.canonical_receipt->>'parkedBatchId' =
      p_receipt.parked_batch_id::text
    and p_receipt.canonical_receipt->>'pageCount' =
      p_receipt.page_count::text
    and p_receipt.canonical_receipt->>'observationCount' =
      p_receipt.observation_count::text
    and p_receipt.canonical_receipt->>'jobCount' = '0'
    and p_receipt.canonical_receipt#>>'{persistedAnchor,historyId}' =
      p_receipt.persisted_anchor_history_id
    and p_receipt.canonical_receipt#>>'{resumedCursor,version}' =
      p_receipt.resumed_cursor_version::text
    and p_receipt.canonical_receipt#>>'{resumedCursor,value}' =
      p_receipt.cutover_history_id
    and p_receipt.canonical_receipt->>'coordinatorJobId' =
      p_receipt.coordinator_job_id::text
    and p_receipt.canonical_receipt->>'coverageDisposition' =
      'immutable_backfill_parked_pending_bounded_historical_adoption'
    and p_receipt.canonical_receipt->>'productionPublicationAttempted' = 'false',
    false
  );
$function$;

revoke all on function
  private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
    public.truth_gmail_backfill_parking_receipts
  ) from public, anon, authenticated, service_role;

create or replace function private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
  p_epoch public.gmail_parse_processing_epochs
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_boundary jsonb;
  v_boundary_hash text;
begin
  if p_epoch.workspace_key is distinct from 'primary'
    or p_epoch.connection_key is distinct from 'primary'
    or p_epoch.schema_version is distinct from
      'gmail-parse-processing-epoch-v1'
    or p_epoch.canonical_epoch->>'schemaVersion' is distinct from
      'gmail-parse-processing-epoch-v1'
    or p_epoch.canonical_epoch->>'genesisAuthorityVersion' is distinct from
      'truth-gmail-claims-readiness-spine-v1'
    or p_epoch.canonical_epoch->>'policyVersion' is distinct from
      'truth-gmail-parked-forward-claims-readiness-policy-v1'
    or p_epoch.canonical_epoch->>'workspaceKey' is distinct from
      p_epoch.workspace_key
    or p_epoch.canonical_epoch->>'connectionKey' is distinct from
      p_epoch.connection_key
    or p_epoch.canonical_epoch->>'genesisRootBatchId' is distinct from
      p_epoch.genesis_root_batch_id::text
    or p_epoch.canonical_epoch->>'genesisSourceCursorVersion' is distinct from
      p_epoch.genesis_source_cursor_version::text
    or p_epoch.canonical_epoch->>'genesisSourceCursorValue' is distinct from
      p_epoch.genesis_source_cursor_value
    or p_epoch.canonical_epoch->>'genesisMode' is distinct from 'history'
    or p_epoch.canonical_epoch->>'legacyBatchCount' is distinct from
      p_epoch.legacy_batch_count::text
    or p_epoch.canonical_epoch->>'legacyBatchManifestHash' is distinct from
      p_epoch.legacy_batch_manifest_hash
    or p_epoch.canonical_epoch->>'genesisRouteSealId' is distinct from
      p_epoch.genesis_route_seal_id
    or p_epoch.canonical_epoch->>'genesisRouteSealHash' is distinct from
      p_epoch.genesis_route_seal_hash
    or p_epoch.canonical_epoch->>'productionPublicationAttempted'
      is distinct from 'false' then
    return false;
  end if;

  v_boundary := p_epoch.canonical_epoch->'parkedCompletenessBoundary';
  if jsonb_typeof(v_boundary) is distinct from 'object' then
    return false;
  end if;
  v_boundary_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_boundary), 'UTF8'
  ), 'sha256'), 'hex');
  if p_epoch.canonical_epoch->>'parkedCompletenessBoundaryHash'
      is distinct from v_boundary_hash
    or v_boundary->>'schemaVersion' is distinct from
      'truth-gmail-parked-completeness-boundary-v1'
    or v_boundary->>'authorityVersion' is distinct from
      'truth-gmail-claims-readiness-spine-v1'
    or v_boundary->>'parkedBatchId' is distinct from
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'
    or v_boundary->>'cutoverHistoryId' is distinct from '19640268'
    or v_boundary->>'productionPublicationAttempted' is distinct from 'false'
    or v_boundary->>'processingDisposition' is distinct from
      'parked_history_accounted_by_explicit_gaps_not_claimed_processed' then
    return false;
  end if;

  select * into v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.receipt_id = v_boundary->>'parkingReceiptId'
    and receipt.receipt_hash = v_boundary->>'parkingReceiptHash'
    and receipt.parked_batch_id =
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
  return found
    and private.truth_gmail_claims_readiness_parking_receipt_valid_v1(v_receipt)
    and v_boundary->>'backfillGapId' = v_receipt.backfill_gap_id::text
    and v_boundary->>'cutoverDeltaGapId' =
      v_receipt.cutover_delta_gap_id::text
    and v_boundary->>'coordinatorJobId' =
      v_receipt.coordinator_job_id::text
    and v_boundary->>'persistedAnchorHistoryId' =
      v_receipt.persisted_anchor_history_id
    and v_boundary->>'cutoverHistoryId' = v_receipt.cutover_history_id
    and v_boundary->>'resumedCursorVersion' =
      v_receipt.resumed_cursor_version::text;
end;
$function$;

revoke all on function
  private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
    public.gmail_parse_processing_epochs
  ) from public, anon, authenticated, service_role;

create or replace function private.ensure_truth_gmail_claims_readiness_epoch_v1(
  p_workspace_key text,
  p_connection_key text,
  p_target_batch_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_expected_batch_id constant uuid :=
    '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
  v_expected_job_id constant uuid :=
    '5ae52e8d-dd30-582b-aef3-1ebdc65f0970'::uuid;
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_parked public.source_ingest_batches%rowtype;
  v_target public.source_ingest_batches%rowtype;
  v_genesis public.source_ingest_batches%rowtype;
  v_route public.gmail_batch_materialization_route_seals%rowtype;
  v_backfill_gap public.gmail_completeness_gaps%rowtype;
  v_cutover_gap public.gmail_completeness_gaps%rowtype;
  v_coordinator public.source_processing_jobs%rowtype;
  v_existing public.gmail_parse_processing_epochs%rowtype;
  v_gap_manifest jsonb;
  v_gap_manifest_hash text;
  v_boundary jsonb;
  v_boundary_hash text;
  v_legacy_manifest jsonb;
  v_legacy_hash text;
  v_body jsonb;
  v_hash text;
  v_id text;
begin
  select * into v_existing
  from public.gmail_parse_processing_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.connection_key = p_connection_key;
  if found then
    if v_existing.canonical_epoch->>'genesisAuthorityVersion' =
        'truth-gmail-claims-readiness-spine-v1'
      and not private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
        v_existing
      ) then
      raise exception 'Gmail claims-readiness boundary epoch failed read-back'
        using errcode = '23514';
    end if;
    return jsonb_build_object(
      'status', 'ready',
      'idempotent', true,
      'epochId', v_existing.epoch_id,
      'epochHash', v_existing.epoch_hash,
      'genesisRootBatchId', v_existing.genesis_root_batch_id,
      'productionPublicationAttempted', false
    );
  end if;

  if p_workspace_key is distinct from 'primary'
    or p_connection_key is distinct from 'primary' then
    return jsonb_build_object(
      'status', 'not_applicable',
      'productionPublicationAttempted', false
    );
  end if;

  select * into v_receipt
  from public.truth_gmail_backfill_parking_receipts receipt
  where receipt.parked_batch_id = v_expected_batch_id;
  if not found then
    return jsonb_build_object(
      'status', 'not_applicable',
      'productionPublicationAttempted', false
    );
  end if;
  if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
    v_receipt
  ) then
    raise exception 'exact Gmail parking receipt failed canonical read-back'
      using errcode = '23514';
  end if;

  select * into strict v_parked
  from public.source_ingest_batches batch
  where batch.batch_id = v_expected_batch_id
    and batch.workspace_key = 'primary'
    and batch.source_system = 'gmail'
    and batch.connection_key = 'primary';
  if v_parked.mode is distinct from 'backfill'
    or v_parked.status is distinct from 'superseded'
    or v_parked.error_code is distinct from
      'GMAIL_BACKFILL_PARKED_FOR_BOUNDED_HISTORICAL_DRAIN'
    or v_parked.page_count is distinct from 2190
    or v_parked.observation_count is distinct from 218989
    or v_parked.job_count is distinct from 0
    or v_parked.committed_cursor_version is not null
    or v_parked.committed_cursor_value is not null
    or v_parked.batch_hash is not null then
    raise exception 'exact Gmail parked batch differs from parking authority'
      using errcode = '23514';
  end if;

  select * into strict v_backfill_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_receipt.backfill_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary';
  select * into strict v_cutover_gap
  from public.gmail_completeness_gaps gap
  where gap.gap_id = v_receipt.cutover_delta_gap_id
    and gap.workspace_key = 'primary'
    and gap.connection_key = 'primary';
  if v_backfill_gap.gap_type is distinct from
      'PARKED_BACKFILL_HISTORICAL_DRAIN'
    or v_backfill_gap.status is distinct from 'open'
    or v_backfill_gap.recovery_anchor_value is distinct from
      v_receipt.persisted_anchor_history_id
    or v_backfill_gap.detected_at is distinct from v_receipt.parked_at
    or v_backfill_gap.detail->>'parkingReceiptId' is distinct from
      v_receipt.receipt_id
    or v_backfill_gap.detail->>'parkingReceiptHash' is distinct from
      v_receipt.receipt_hash
    or v_backfill_gap.detail->>'parkedBatchId' is distinct from
      v_expected_batch_id::text
    or v_backfill_gap.detail->>'productionPublicationAttempted'
      is distinct from 'false'
    or v_cutover_gap.gap_type is distinct from
      'GMAIL_CUTOVER_DELTA_RECONCILIATION'
    or v_cutover_gap.status is distinct from 'open'
    or v_cutover_gap.prior_cursor_value is distinct from
      v_receipt.persisted_anchor_history_id
    or v_cutover_gap.recovery_anchor_value is distinct from
      v_receipt.cutover_history_id
    or v_cutover_gap.detected_at is distinct from v_receipt.parked_at
    or v_cutover_gap.detail->>'parkingReceiptId' is distinct from
      v_receipt.receipt_id
    or v_cutover_gap.detail->>'parkingReceiptHash' is distinct from
      v_receipt.receipt_hash
    or v_cutover_gap.detail->>'parkedBatchId' is distinct from
      v_expected_batch_id::text
    or v_cutover_gap.detail->>'productionPublicationAttempted'
      is distinct from 'false'
    or not coalesce((
      v_receipt.canonical_receipt->'completenessGaps'
      @> jsonb_build_array(jsonb_build_object(
        'gapId', v_backfill_gap.gap_id,
        'gapType', v_backfill_gap.gap_type,
        'priorCursorValue', v_backfill_gap.prior_cursor_value,
        'recoveryAnchorValue', v_backfill_gap.recovery_anchor_value
      ))
    ), false)
    or not coalesce((
      v_receipt.canonical_receipt->'completenessGaps'
      @> jsonb_build_array(jsonb_build_object(
        'gapId', v_cutover_gap.gap_id,
        'gapType', v_cutover_gap.gap_type,
        'priorCursorValue', v_cutover_gap.prior_cursor_value,
        'recoveryAnchorValue', v_cutover_gap.recovery_anchor_value
      ))
    ), false) then
    raise exception 'Gmail parked completeness-gap boundary is invalid'
      using errcode = '23514';
  end if;

  select * into strict v_coordinator
  from public.source_processing_jobs job
  where job.job_id = v_expected_job_id
    and job.workspace_key = 'primary'
    and job.source_system = 'gmail'
    and job.connection_key = 'primary'
    and job.job_kind = 'truth_drain_parked_gmail_backfill';
  if v_coordinator.source_object_id is distinct from v_expected_batch_id::text
    or v_coordinator.payload->>'parkingReceiptId' is distinct from
      v_receipt.receipt_id
    or v_coordinator.payload->>'parkingReceiptHash' is distinct from
      v_receipt.receipt_hash
    or v_coordinator.payload->>'backfillGapId' is distinct from
      v_receipt.backfill_gap_id::text
    or v_coordinator.payload->>'cutoverDeltaGapId' is distinct from
      v_receipt.cutover_delta_gap_id::text then
    raise exception 'Gmail parked drain coordinator proof is invalid'
      using errcode = '23514';
  end if;

  select * into strict v_target
  from public.source_ingest_batches batch
  where batch.batch_id = p_target_batch_id
    and batch.workspace_key = p_workspace_key
    and batch.source_system = 'gmail'
    and batch.connection_key = p_connection_key
    and batch.status = 'committed'
    and batch.batch_hash ~ '^[0-9a-f]{64}$'
    and batch.committed_cursor_version is not null
    and batch.committed_cursor_value ~ '^[0-9]+$';
  if v_target.committed_cursor_version <= v_receipt.resumed_cursor_version
    or not coalesce(private.gmail_history_id_at_least(
      v_target.committed_cursor_value,
      v_receipt.cutover_history_id
    ), false) then
    return jsonb_build_object(
      'status', 'not_ready',
      'targetBatchId', p_target_batch_id,
      'reasonCode', 'TARGET_PRECEDES_PARKED_COMPLETENESS_BOUNDARY',
      'productionPublicationAttempted', false
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'gmail-parse-checkpoint:' || p_workspace_key || ':' || p_connection_key,
    0
  ));
  select * into v_existing
  from public.gmail_parse_processing_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.connection_key = p_connection_key;
  if found then
    if v_existing.canonical_epoch->>'genesisAuthorityVersion' =
        'truth-gmail-claims-readiness-spine-v1'
      and not private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
        v_existing
      ) then
      raise exception 'Gmail claims-readiness boundary epoch conflicts'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'ready',
      'idempotent', true,
      'epochId', v_existing.epoch_id,
      'epochHash', v_existing.epoch_hash,
      'genesisRootBatchId', v_existing.genesis_root_batch_id,
      'productionPublicationAttempted', false
    );
  end if;

  select * into strict v_genesis
  from public.source_ingest_batches batch
  where batch.workspace_key = p_workspace_key
    and batch.source_system = 'gmail'
    and batch.connection_key = p_connection_key
    and batch.status = 'committed'
    and batch.batch_hash ~ '^[0-9a-f]{64}$'
    and batch.committed_cursor_version > v_receipt.resumed_cursor_version
    and batch.committed_cursor_version <= v_target.committed_cursor_version
  order by batch.committed_cursor_version, batch.batch_id
  limit 1;
  if v_genesis.mode is distinct from 'history'
    or v_genesis.committed_cursor_value !~ '^[0-9]+$'
    or not coalesce(private.gmail_history_id_at_least(
      v_genesis.committed_cursor_value,
      v_receipt.cutover_history_id
    ), false)
    or v_genesis.expected_cursor_version < v_receipt.resumed_cursor_version
    or v_genesis.started_at < v_receipt.parked_at then
    raise exception 'Gmail forward processing genesis is outside parked boundary'
      using errcode = '23514';
  end if;
  select * into v_route
  from public.gmail_batch_materialization_route_seals route
  where route.workspace_key = p_workspace_key
    and route.root_batch_id = v_genesis.batch_id
    and route.connection_key = p_connection_key;
  if not found then
    return jsonb_build_object(
      'status', 'not_ready',
      'targetBatchId', p_target_batch_id,
      'reasonCode', 'GMAIL_FORWARD_GENESIS_ROUTE_SEAL_REQUIRED',
      'productionPublicationAttempted', false
    );
  end if;

  v_gap_manifest := jsonb_build_array(
    jsonb_build_object(
      'gapId', v_backfill_gap.gap_id,
      'gapType', v_backfill_gap.gap_type,
      'statusAtBoundary', v_backfill_gap.status,
      'priorCursorValue', v_backfill_gap.prior_cursor_value,
      'recoveryAnchorValue', v_backfill_gap.recovery_anchor_value,
      'detectedAt', private.canonical_truth_timestamp(
        v_backfill_gap.detected_at
      ),
      'detailHash', encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_backfill_gap.detail), 'UTF8'
      ), 'sha256'), 'hex')
    ),
    jsonb_build_object(
      'gapId', v_cutover_gap.gap_id,
      'gapType', v_cutover_gap.gap_type,
      'statusAtBoundary', v_cutover_gap.status,
      'priorCursorValue', v_cutover_gap.prior_cursor_value,
      'recoveryAnchorValue', v_cutover_gap.recovery_anchor_value,
      'detectedAt', private.canonical_truth_timestamp(
        v_cutover_gap.detected_at
      ),
      'detailHash', encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(v_cutover_gap.detail), 'UTF8'
      ), 'sha256'), 'hex')
    )
  );
  v_gap_manifest_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_gap_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_boundary := jsonb_build_object(
    'schemaVersion', 'truth-gmail-parked-completeness-boundary-v1',
    'authorityVersion', 'truth-gmail-claims-readiness-spine-v1',
    'workspaceKey', p_workspace_key,
    'connectionKey', p_connection_key,
    'parkingReceiptId', v_receipt.receipt_id,
    'parkingReceiptHash', v_receipt.receipt_hash,
    'parkedBatchId', v_receipt.parked_batch_id,
    'backfillGapId', v_receipt.backfill_gap_id,
    'cutoverDeltaGapId', v_receipt.cutover_delta_gap_id,
    'coordinatorJobId', v_receipt.coordinator_job_id,
    'persistedAnchorHistoryId', v_receipt.persisted_anchor_history_id,
    'cutoverHistoryId', v_receipt.cutover_history_id,
    'resumedCursorVersion', v_receipt.resumed_cursor_version,
    'pageCount', v_receipt.page_count,
    'observationCount', v_receipt.observation_count,
    'gapManifest', v_gap_manifest,
    'gapManifestHash', v_gap_manifest_hash,
    'processingDisposition',
      'parked_history_accounted_by_explicit_gaps_not_claimed_processed',
    'productionPublicationAttempted', false
  );
  v_boundary_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_boundary), 'UTF8'
  ), 'sha256'), 'hex');
  v_legacy_manifest := jsonb_build_array(jsonb_build_object(
    'boundaryKind', 'parked_backfill_completeness_receipt',
    'parkingReceiptId', v_receipt.receipt_id,
    'parkingReceiptHash', v_receipt.receipt_hash,
    'parkedCompletenessBoundaryHash', v_boundary_hash,
    'processingDisposition',
      'excluded_from_forward_checkpoint_chain_with_explicit_open_gaps'
  ));
  v_legacy_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_legacy_manifest), 'UTF8'
  ), 'sha256'), 'hex');
  v_body := jsonb_build_object(
    'schemaVersion', 'gmail-parse-processing-epoch-v1',
    'genesisAuthorityVersion', 'truth-gmail-claims-readiness-spine-v1',
    'workspaceKey', p_workspace_key,
    'connectionKey', p_connection_key,
    'genesisRootBatchId', v_genesis.batch_id,
    'genesisRootBatchHash', v_genesis.batch_hash,
    'genesisSourceCursorVersion', v_genesis.committed_cursor_version,
    'genesisSourceCursorValue', v_genesis.committed_cursor_value,
    'genesisMode', v_genesis.mode,
    'genesisRouteSealId', v_route.seal_id,
    'genesisRouteSealHash', v_route.seal_hash,
    'legacyBatchCount', 1,
    'legacyBatchManifestHash', v_legacy_hash,
    'parkedCompletenessBoundary', v_boundary,
    'parkedCompletenessBoundaryHash', v_boundary_hash,
    'policyVersion',
      'truth-gmail-parked-forward-claims-readiness-policy-v1',
    'productionPublicationAttempted', false
  );
  v_hash := encode(extensions.digest(convert_to(
    private.truth_canonical_json_text(v_body), 'UTF8'
  ), 'sha256'), 'hex');
  v_id := 'gmail-parse-processing-epoch:v1:' || v_hash;
  insert into public.gmail_parse_processing_epochs(
    workspace_key, connection_key, epoch_id, genesis_root_batch_id,
    genesis_source_cursor_version, genesis_source_cursor_value,
    legacy_batch_count, legacy_batch_manifest_hash,
    genesis_route_seal_id, genesis_route_seal_hash,
    canonical_epoch, epoch_hash, schema_version
  ) values (
    p_workspace_key, p_connection_key, v_id, v_genesis.batch_id,
    v_genesis.committed_cursor_version, v_genesis.committed_cursor_value,
    1, v_legacy_hash, v_route.seal_id, v_route.seal_hash,
    v_body, v_hash, 'gmail-parse-processing-epoch-v1'
  ) on conflict (workspace_key, connection_key) do nothing;
  select * into strict v_existing
  from public.gmail_parse_processing_epochs epoch
  where epoch.workspace_key = p_workspace_key
    and epoch.connection_key = p_connection_key;
  if v_existing.canonical_epoch is distinct from v_body
    or not private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(
      v_existing
    ) then
    raise exception 'Gmail claims-readiness boundary epoch conflicts on replay'
      using errcode = '23505';
  end if;
  return jsonb_build_object(
    'status', 'ready',
    'idempotent', false,
    'epochId', v_existing.epoch_id,
    'epochHash', v_existing.epoch_hash,
    'genesisRootBatchId', v_existing.genesis_root_batch_id,
    'parkingReceiptId', v_receipt.receipt_id,
    'parkingReceiptHash', v_receipt.receipt_hash,
    'parkedCompletenessBoundaryHash', v_boundary_hash,
    'productionPublicationAttempted', false
  );
end;
$function$;

revoke all on function private.ensure_truth_gmail_claims_readiness_epoch_v1(
  text, text, uuid
) from public, anon, authenticated, service_role;

-- Compose the special history genesis into the existing chain validator.  The
-- matcher intentionally replaces only the single generic mode predicate, so it
-- also composes with the later historical-drain draft if migrations are tested
-- chronologically in the working tree.
do $rewrite_checkpoint_history_genesis$
declare
  v_signature regprocedure :=
    'private.ensure_gmail_parse_checkpoint_chain_v1(text,text,uuid,integer)'::regprocedure;
  v_definition text;
  v_old text := $old$mode in ('backfill','reconciliation')$old$;
  v_new text := $new$(mode in ('backfill','reconciliation') or (
      mode='history'
      and private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(v_epoch)
    ))$new$;
  v_occurrences integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(
    'truth_gmail_claims_readiness_boundary_epoch_valid_v1(v_epoch)'
    in v_definition
  ) = 0 then
    v_occurrences := (
      length(v_definition) - length(replace(v_definition, v_old, ''))
    ) / length(v_old);
    if v_occurrences is distinct from 1 then
      raise exception 'Gmail checkpoint genesis-mode rewrite was incomplete'
        using errcode = '55000';
    end if;
    execute replace(v_definition, v_old, v_new);
  end if;
end;
$rewrite_checkpoint_history_genesis$;

create or replace function private.ensure_gmail_parse_checkpoint(
  p_workspace_key text,
  p_connection_key text,
  p_target_batch_id uuid,
  p_max_batches integer,
  p_sync_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_boundary jsonb;
  v_auto jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  v_boundary := private.ensure_truth_gmail_claims_readiness_epoch_v1(
    p_workspace_key,
    p_connection_key,
    p_target_batch_id
  );
  if v_boundary->>'status' = 'not_ready' then
    return v_boundary;
  end if;
  v_auto := private.auto_resolve_gmail_revision_obligations_v1(
    p_workspace_key,
    p_connection_key,
    p_target_batch_id,
    p_sync_token
  );
  if v_auto->>'status' = 'not_ready' then
    return v_auto;
  end if;
  return private.ensure_gmail_parse_checkpoint_chain_v1(
    p_workspace_key,
    p_connection_key,
    p_target_batch_id,
    p_max_batches
  );
end;
$function$;

create or replace function private.read_gmail_claims_readiness_frontier_v1(
  p_workspace_key text,
  p_connection_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_receipt public.truth_gmail_backfill_parking_receipts%rowtype;
  v_floor bigint;
  v_batches jsonb;
begin
  if not private.valid_truth_sync_token(p_sync_token) then
    raise exception 'invalid sync token' using errcode = '28000';
  end if;
  if nullif(trim(coalesce(p_workspace_key, '')), '') is null
    or nullif(trim(coalesce(p_connection_key, '')), '') is null
    or p_limit is null
    or p_limit < 1
    or p_limit > 25 then
    raise exception 'invalid Gmail claims-readiness frontier request'
      using errcode = '22023';
  end if;

  if p_workspace_key = 'primary' and p_connection_key = 'primary' then
    select * into v_receipt
    from public.truth_gmail_backfill_parking_receipts receipt
    where receipt.parked_batch_id =
      '118506f6-7c7b-4bb9-8f62-9a743513a8ca'::uuid;
    if found then
      if not private.truth_gmail_claims_readiness_parking_receipt_valid_v1(
        v_receipt
      ) then
        raise exception 'exact Gmail parking receipt failed frontier read-back'
          using errcode = '23514';
      end if;
      v_floor := v_receipt.resumed_cursor_version;
    end if;
  end if;

  with bounded as materialized (
    select batch.batch_id,
           batch.committed_cursor_version,
           batch.committed_cursor_value
    from public.source_ingest_batches batch
    where batch.workspace_key = p_workspace_key
      and batch.source_system = 'gmail'
      and batch.connection_key = p_connection_key
      and batch.status = 'committed'
      and batch.batch_hash ~ '^[0-9a-f]{64}$'
      and batch.committed_cursor_version is not null
      and batch.committed_cursor_value ~ '^[0-9]+$'
      and (v_floor is null or batch.committed_cursor_version > v_floor)
      and not exists (
        select 1
        from public.truth_gmail_link_epochs epoch
        join public.truth_gmail_link_epoch_seals seal
          on seal.workspace_key = epoch.workspace_key
         and seal.epoch_id = epoch.epoch_id
        where epoch.workspace_key = batch.workspace_key
          and epoch.root_batch_id = batch.batch_id
      )
    order by batch.committed_cursor_version, batch.batch_id
    limit p_limit
  ), shaped as (
    select bounded.batch_id,
           bounded.committed_cursor_version,
           coalesce(
             checkpoint.terminal_gap_count = 0
             and processing_epoch.epoch_id = checkpoint.processing_epoch_id
             and processing_epoch.epoch_hash = checkpoint.processing_epoch_hash,
             false
           ) as checkpoint_ready,
           epoch.epoch_id,
           seal.epoch_id is not null as epoch_sealed,
           coalesce(
             epoch.epoch_id is not null
             and seal.epoch_id is null
             and jobs.job_count = jobs.terminal_count
             and jobs.job_count = jobs.succeeded_count
             and jobs.job_count = members.member_count
             and members.member_count = checkpoint.member_count,
             false
           ) as ready_to_seal
    from bounded
    left join public.gmail_parse_checkpoints checkpoint
      on checkpoint.workspace_key = p_workspace_key
     and checkpoint.root_batch_id = bounded.batch_id
     and checkpoint.connection_key = p_connection_key
     and checkpoint.source_cursor_version = bounded.committed_cursor_version
     and checkpoint.source_cursor_value = bounded.committed_cursor_value
    left join public.gmail_parse_processing_epochs processing_epoch
      on processing_epoch.workspace_key = checkpoint.workspace_key
     and processing_epoch.connection_key = checkpoint.connection_key
    left join public.truth_gmail_link_epochs epoch
      on epoch.workspace_key = p_workspace_key
     and epoch.root_batch_id = bounded.batch_id
     and epoch.connection_key = p_connection_key
    left join public.truth_gmail_link_epoch_seals seal
      on seal.workspace_key = epoch.workspace_key
     and seal.epoch_id = epoch.epoch_id
    left join lateral (
      select count(*)::bigint as job_count,
             count(*) filter (where job.state in (
               'succeeded', 'dead_letter', 'superseded'
             ))::bigint as terminal_count,
             count(*) filter (where job.state = 'succeeded')::bigint
               as succeeded_count
      from public.source_processing_job_lineage lineage
      join public.source_processing_jobs job
        on job.job_id = lineage.job_id
       and job.workspace_key = lineage.workspace_key
      where lineage.workspace_key = p_workspace_key
        and lineage.source_system = 'gmail'
        and lineage.connection_key = p_connection_key
        and lineage.root_batch_id = bounded.batch_id
        and job.source_system = 'gmail'
        and job.connection_key = p_connection_key
        and job.job_kind = 'gmail_resolve_entity_links'
    ) jobs on true
    left join lateral (
      select count(*)::bigint as member_count
      from public.truth_gmail_link_epoch_members member
      where member.workspace_key = p_workspace_key
        and member.epoch_id = epoch.epoch_id
    ) members on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'rootBatchId', shaped.batch_id,
    'checkpointReady', shaped.checkpoint_ready,
    'epochId', shaped.epoch_id,
    'epochSealed', shaped.epoch_sealed,
    'readyToSeal', shaped.ready_to_seal
  ) order by shaped.committed_cursor_version, shaped.batch_id), '[]'::jsonb)
  into v_batches
  from shaped;

  return jsonb_build_object(
    'ok', true,
    'batches', v_batches,
    'productionPublicationAttempted', false
  );
end;
$function$;

create or replace function public.read_gmail_claims_readiness_frontier(
  p_workspace_key text,
  p_connection_key text,
  p_limit integer,
  p_sync_token text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.read_gmail_claims_readiness_frontier_v1(
    p_workspace_key,
    p_connection_key,
    p_limit,
    p_sync_token
  );
$function$;

revoke all on function private.ensure_gmail_parse_checkpoint(
  text, text, uuid, integer, text
) from public, anon, authenticated, service_role;
revoke all on function private.ensure_gmail_parse_checkpoint_chain_v1(
  text, text, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function private.read_gmail_claims_readiness_frontier_v1(
  text, text, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.read_gmail_claims_readiness_frontier(
  text, text, integer, text
) from public, anon, authenticated;
grant execute on function public.read_gmail_claims_readiness_frontier(
  text, text, integer, text
) to service_role;

do $verify$
declare
  v_definition text;
  v_config text[];
begin
  if to_regprocedure(
      'public.read_gmail_claims_readiness_frontier(text,text,integer,text)'
    ) is null
    or to_regprocedure(
      'private.read_gmail_claims_readiness_frontier_v1(text,text,integer,text)'
    ) is null
    or to_regprocedure(
      'private.ensure_truth_gmail_claims_readiness_epoch_v1(text,text,uuid)'
    ) is null
    or to_regprocedure(
      'private.truth_gmail_claims_readiness_boundary_epoch_valid_v1(public.gmail_parse_processing_epochs)'
    ) is null then
    raise exception 'Gmail claims-readiness spine functions are missing'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'private.ensure_gmail_parse_checkpoint_chain_v1(text,text,uuid,integer)'::regprocedure
  ) into v_definition;
  if position(
      'truth_gmail_claims_readiness_boundary_epoch_valid_v1(v_epoch)'
      in v_definition
    ) = 0
    or position('mode=''history''' in v_definition) = 0 then
    raise exception 'Gmail checkpoint boundary rewrite failed verification'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'private.ensure_gmail_parse_checkpoint(text,text,uuid,integer,text)'::regprocedure
  ) into v_definition;
  if position('ensure_truth_gmail_claims_readiness_epoch_v1' in v_definition) = 0
    or position('auto_resolve_gmail_revision_obligations_v1' in v_definition) = 0
    or position('ensure_gmail_parse_checkpoint_chain_v1' in v_definition) = 0 then
    raise exception 'Gmail checkpoint wrapper rewrite failed verification'
      using errcode = '55000';
  end if;

  select proconfig into v_config
  from pg_catalog.pg_proc
  where oid =
    'public.read_gmail_claims_readiness_frontier(text,text,integer,text)'::regprocedure;
  if v_config is distinct from array['search_path=""']::text[]
    or has_function_privilege(
      'anon',
      'public.read_gmail_claims_readiness_frontier(text,text,integer,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.read_gmail_claims_readiness_frontier(text,text,integer,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.read_gmail_claims_readiness_frontier(text,text,integer,text)',
      'EXECUTE'
    ) then
    raise exception 'Gmail claims-readiness frontier ACL/config is invalid'
      using errcode = '55000';
  end if;

  select pg_get_functiondef(
    'public.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure
  ) into v_definition;
  if position('private.open_truth_gmail_link_epoch' in v_definition) = 0 then
    raise exception 'Gmail link-epoch open authority was unexpectedly changed'
      using errcode = '55000';
  end if;
  select pg_get_functiondef(
    'private.seal_truth_gmail_link_epoch(text,text,text)'::regprocedure
  ) into v_definition;
  if position('job.state=''succeeded''' in v_definition) = 0
    or position('gmail_extract_message_claims' in v_definition) = 0
    or position('gmail_extract_attachment_claims' in v_definition) = 0 then
    raise exception 'Gmail link-epoch seal preconditions changed unexpectedly'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure
    cross join lateral unnest(coalesce(procedure.proconfig, array[]::text[])) setting
    where procedure.oid = any(array[
      'public.ensure_gmail_parse_checkpoint(text,text,uuid,integer,text)'::regprocedure,
      'private.ensure_gmail_parse_checkpoint(text,text,uuid,integer,text)'::regprocedure,
      'public.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure,
      'private.open_truth_gmail_link_epoch(text,uuid,text)'::regprocedure,
      'public.seal_truth_gmail_link_epoch(text,text,text)'::regprocedure,
      'private.seal_truth_gmail_link_epoch(text,text,text)'::regprocedure
    ]::oid[])
      and setting ~ '^(enable_|plan_cache_mode|statement_timeout|lock_timeout|cpu_|random_page_cost)='
  ) then
    raise exception 'claims-readiness cron path contains a planner/timeout override'
      using errcode = '55000';
  end if;

  if position('shipment-truth-packets' in lower(pg_get_functiondef(
      'public.read_gmail_claims_readiness_frontier(text,text,integer,text)'::regprocedure
    ))) > 0
    or position('truth_publications' in lower(pg_get_functiondef(
      'private.ensure_truth_gmail_claims_readiness_epoch_v1(text,text,uuid)'::regprocedure
    ))) > 0 then
    raise exception 'Gmail claims-readiness spine references publication state'
      using errcode = '55000';
  end if;
end;
$verify$;

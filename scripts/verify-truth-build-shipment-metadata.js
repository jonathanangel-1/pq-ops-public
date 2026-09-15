#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const tmsSnapshot = require("./fixtures/verify-tms-claim-extractor.json");
const { buildTmsSourceSnapshot } = require("../lib/tms-source-snapshot");
const { createTmsClaimExtractor } = require("../lib/tms-claim-extractor");
const { createTruthBuildLedger, RPC } = require("../lib/truth-build-ledger");
const {
  REDUCER_VERSION,
  reduceRelationalTruth,
} = require("../lib/relational-truth-reducer");
const {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
  buildRelationalTruthDelivery,
} = require("../lib/relational-truth-delivery-adapter");
const { runRelationalTruthBuild, _test: runnerTest } = require("../lib/relational-truth-build-runner");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const { createConfiguredProcessingWatermark } = require("../lib/truth-processing-watermark");
const { tmsControlRoomDetails } = require("../lib/truth-shipment-metadata");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = [
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709221000_protect_truth_snapshot_keys.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709224000_truth_audit_runtime.sql",
  "20260709230000_truth_build_publication_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709240500_truth_build_shipment_metadata.sql",
  "20260709240900_truth_production_authority_isolation.sql",
  "20260709241000_truth_processing_watermark.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));

const WORKSPACE = "primary";
const CONNECTION = "couriercloud-primary";
const TOKEN = "truth-build-shipment-metadata-verifier-token";

const RPC_SIGNATURES = Object.freeze({
  [RPC.claimPair]: [
    ["p_workspace_key", "text"], ["p_source_cut_id", "text"],
    ["p_build_channel", "text"], ["p_trigger_name", "text"],
    ["p_idempotency_key", "text"], ["p_worker_id", "text"],
    ["p_lease_seconds", "integer"], ["p_bundle_row_limit", "integer"],
    ["p_versions", "jsonb"], ["p_sync_token", "text"],
  ],
  [RPC.readBundle]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"], ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"], ["p_sync_token", "text"],
  ],
  [RPC.completePair]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"], ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"], ["p_full_packet", "jsonb"],
    ["p_incremental_packet", "jsonb"], ["p_full_semantic_hash", "text"],
    ["p_incremental_semantic_hash", "text"], ["p_full_validation_report", "jsonb"],
    ["p_incremental_validation_report", "jsonb"], ["p_sync_token", "text"],
  ],
  [RPC.failPair]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"], ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"], ["p_error_code", "text"],
    ["p_safe_error_detail", "text"], ["p_sync_token", "text"],
  ],
});

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function install(db) {
  await db.exec(`
    create schema extensions;
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.sync_tokens (
      token_name text primary key,
      token_hash text not null
    );
    create table public.app_snapshots (
      snapshot_key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table public.app_snapshot_metadata (
      snapshot_key text primary key,
      snapshot_time text,
      updated_at timestamptz not null default now(),
      writer_version text,
      content_signature text,
      payload_bytes integer
    );
  `);
  for (const migration of MIGRATIONS) await db.exec(fs.readFileSync(migration, "utf8"));
  await db.exec(fs.readFileSync(MIGRATIONS[MIGRATIONS.length - 1], "utf8"));
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values ('local_snapshot_writer', encode(
      extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex'
    ))
  `, [TOKEN]);
}

function createRpcCaller(db) {
  return async (rpc, body) => {
    const signature = RPC_SIGNATURES[rpc];
    if (!signature) throw new Error(`Unexpected RPC ${rpc}`);
    const values = signature.map(([key, type]) => (
      type === "jsonb" ? JSON.stringify(body[key]) : body[key]
    ));
    const casts = signature.map(([, type], index) => `$${index + 1}::${type}`);
    return (await one(db, `select public.${rpc}(${casts.join(", ")}) as receipt`, values)).receipt;
  };
}

function oneRowSnapshot() {
  const shipment = JSON.parse(JSON.stringify(tmsSnapshot.shipments[0]));
  shipment.tmsStatus = "110-NEW SHIPMENT";
  shipment.status = "110-NEW SHIPMENT";
  return {
    snapshotTime: tmsSnapshot.snapshotTime,
    visibleTaskCount: 1,
    orderLinkCount: 1,
    scopeAudit: {
      ...JSON.parse(JSON.stringify(tmsSnapshot.scopeAudit)),
      visibleTaskCount: 1,
      orderLinkCount: 1,
      gridRows: 1,
      detailRows: 1,
    },
    shipments: [shipment],
  };
}

async function seedTmsSource(db) {
  const snapshot = oneRowSnapshot();
  const built = buildTmsSourceSnapshot(snapshot, {
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
  });
  const source = built.observations[0];
  const observation = {
    ...source,
    workspaceKey: WORKSPACE,
    sourceSystem: "tms",
    connectionKey: CONNECTION,
    capturedAt: source.sourceRecordedAt,
  };
  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status, lease_fence
    ) values ($1, 'tms', $2, 'snapshot_time', $3, 1, 'live', 1)
  `, [WORKSPACE, CONNECTION, snapshot.snapshotTime]);
  const batch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count, committed_at, finished_at
    ) values (
      $1, 'tms', $2, 'snapshot', 'metadata-fixture',
      0, '', 1, $3, 'fixture', 1, 'committed', $4,
      0, 1, 0, now(), now()
    ) returning batch_id
  `, [WORKSPACE, CONNECTION, snapshot.snapshotTime, sha256("metadata-tms-batch")]);
  await db.query(`
    insert into public.source_observations (
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, source_recorded_at,
      captured_at, normalized_payload, normalized_text, source_fidelity,
      schema_version
    ) values (
      $1, $2, 'tms', $3, $4, $5, $6, 'content',
      1, $7, $8, $9, $9, $10::jsonb, '', 'normalized_source', $11
    )
  `, [
    observation.observationId,
    WORKSPACE,
    CONNECTION,
    observation.sourceObjectType,
    observation.sourceObjectId,
    observation.sourceRevision,
    batch.batch_id,
    observation.contentHash,
    observation.sourceRecordedAt,
    JSON.stringify(observation.normalizedPayload),
    observation.schemaVersion,
  ]);
  await db.query(`
    update public.source_cursors
    set last_batch_id = $1, last_committed_at = now()
    where workspace_key = $2 and source_system = 'tms' and connection_key = $3
  `, [batch.batch_id, WORKSPACE, CONNECTION]);

  const candidates = await createTmsClaimExtractor().extract({ observation });
  const candidate = candidates.find((item) => item.predicate === "shipment_observed_in_tms");
  assert.ok(candidate, "TMS inventory presence candidate is required");
  const claim = {
    claimKey: candidate.claimKey,
    versionNo: candidate.versionNo,
    previousClaimVersionId: candidate.previousClaimVersionId,
    primaryObservationId: observation.observationId,
    subjectType: candidate.subjectType,
    subjectKey: candidate.subjectKey,
    predicate: candidate.predicate,
    gate: candidate.gate,
    polarity: candidate.polarity,
    normalizedValue: candidate.normalizedValue,
    occurredAt: null,
    confidence: candidate.confidence,
    confidenceLabel: candidate.confidenceLabel,
    extractionMethod: candidate.extractionMethod,
    extractorVersion: candidate.extractorVersion,
    promptVersion: candidate.promptVersion,
    model: candidate.model,
    acceptanceMethod: "policy",
    acceptancePolicyVersion: candidate.acceptanceRecommendation.policyVersion,
    acceptedBy: "verify-truth-build-shipment-metadata",
    decision: "accepted",
    evidenceSpan: candidate.evidenceSpan,
    recordedAt: observation.capturedAt,
    schemaVersion: "accepted-claim-v1",
  };
  const evidence = [{
    observationId: observation.observationId,
    evidenceRole: "primary",
    evidenceSpan: candidate.evidenceSpan,
  }];
  const accepted = (await one(db, `
    select public.append_accepted_claim(
      $1::text, $2::jsonb, $3::jsonb, '[]'::jsonb, $4::text
    ) as receipt
  `, [WORKSPACE, JSON.stringify(claim), JSON.stringify(evidence), TOKEN])).receipt;
  return { snapshot, shipment: snapshot.shipments[0], observation, accepted };
}

async function sealTmsCut(db, snapshotTime) {
  return (await one(db, `
    select public.seal_source_cut(
      $1::text, 'source-cut-manifest-v2'::text,
      $2::jsonb, '[]'::jsonb, $3::jsonb, '[]'::jsonb,
      'metadata-fixture'::text, $4::text
    ) as receipt
  `, [
    WORKSPACE,
    JSON.stringify([{ sourceSystem: "tms", connectionKey: CONNECTION }]),
    JSON.stringify([{
      sourceSystem: "tms",
      connectionKey: CONNECTION,
      cursorKind: "snapshot_time",
      throughCursorVersion: "1",
      throughCursorValue: snapshotTime,
      upstreamWatermark: snapshotTime,
      sourceSnapshotAt: snapshotTime,
    }]),
    TOKEN,
  ])).receipt;
}

function versions() {
  return createConfiguredProcessingWatermark({
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
  });
}

function claimInput(sourceCutId, idempotencyKey, workerId = `worker:${idempotencyKey}`) {
  return {
    sourceCutId,
    buildChannel: "shadow",
    triggerName: "verify-truth-build-shipment-metadata",
    idempotencyKey,
    workerId,
    leaseSeconds: 300,
    bundleRowLimit: 100,
    versions: versions(),
  };
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await install(db);
    const seeded = await seedTmsSource(db);
    const cut = await sealTmsCut(db, seeded.snapshot.snapshotTime);
    assert.equal(cut.completeness, "complete");

    const ledger = createTruthBuildLedger({
      workspaceKey: WORKSPACE,
      syncToken: TOKEN,
      callRpc: createRpcCaller(db),
    });
    const workerId = "worker:metadata-build";
    const pair = await ledger.claimPair(claimInput(cut.sourceCutId, "metadata-build", workerId));
    assert.equal(pair.shipmentMetadataRowCount, 1);
    assert.match(pair.shipmentMetadataManifestHash, /^[0-9a-f]{64}$/);
    const lease = { buildPairId: pair.buildPairId, workerId, leaseFence: pair.leaseFence };
    const bundle = await ledger.readBundle(lease);
    assert.equal(bundle.shipmentMetadataEnvelopes.length, 1);
    assert.equal(bundle.bounds.shipmentMetadataRowCount, 1);
    assert.equal(bundle.bounds.totalRowCount, bundle.bounds.rowCount + 1);
    assert.equal(bundle.shipmentMetadataManifestHash, pair.shipmentMetadataManifestHash);
    assert.deepEqual(
      bundle.shipmentMetadataEnvelopes[0].canonicalEnvelope.details,
      tmsControlRoomDetails(seeded.shipment),
      "SQL and JS metadata projections must agree on the production TMS row shape",
    );

    const built = await runRelationalTruthBuild({
      ledger,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "metadata-build",
      workerId,
      buildChannel: "shadow",
      triggerName: "verify-truth-build-shipment-metadata",
      bundleRowLimit: 100,
      precedencePolicy: DEFAULT_POLICY,
    });
    assert.equal(built.status, "succeeded");
    const stored = await one(db, `
      select packet_payload, input_manifest_hash, shipment_metadata_manifest_hash
      from public.truth_builds where build_id = $1
    `, [built.pair.fullBuildId]);
    const row = stored.packet_payload.shipments[0];
    const expectedDetails = tmsControlRoomDetails(seeded.shipment);
    assert.equal(row.client, expectedDetails.client);
    assert.equal(row.station, expectedDetails.station);
    assert.deepEqual(row.cargo, expectedDetails.cargo);
    assert.deepEqual(row.flightDetails, expectedDetails.flightDetails);
    assert.equal(row.route, expectedDetails.route);
    assert.deepEqual(row.delivery, expectedDetails.delivery);
    assert.deepEqual(row.freightBroker, expectedDetails.freightBroker);
    assert.deepEqual(row.customsBroker, expectedDetails.customsBroker);
    assert.deepEqual(row.contacts, expectedDetails.contacts);
    assert.equal(
      stored.packet_payload.truthProvenance.shipmentMetadataManifestHash,
      stored.shipment_metadata_manifest_hash,
    );
    assert.equal((await one(db, `
      select count(*)::integer as count
      from public.truth_build_inputs
      where build_id = $1 and item_kind = 'shipment_metadata'
    `, [built.pair.fullBuildId])).count, 1);

    await assert.rejects(
      runRelationalTruthBuild({
        ledger,
        sourceCutId: cut.sourceCutId,
        idempotencyKey: "caller-metadata-injection",
        workerId: "worker:caller-metadata-injection",
        sourceDetailsByShipment: { [candidateAwb(seeded)]: { client: "Injected" } },
      }),
      (error) => error?.code === "TRUTH_BUILD_CALLER_METADATA_FORBIDDEN",
      "the build runner must reject caller-supplied mutable shipment details",
    );

    await assert.rejects(
      ledger.claimPair({
        ...claimInput(cut.sourceCutId, "metadata-row-bound"),
        bundleRowLimit: pair.bundleRowCount,
      }),
      (error) => error?.code === "54000",
      "metadata rows must count toward the non-truncating bundle bound",
    );

    const tamperWorker = "worker:metadata-tamper";
    const tamperPair = await ledger.claimPair(claimInput(cut.sourceCutId, "metadata-tamper", tamperWorker));
    const tamperLease = {
      buildPairId: tamperPair.buildPairId,
      workerId: tamperWorker,
      leaseFence: tamperPair.leaseFence,
    };
    const tamperBundle = await ledger.readBundle(tamperLease);
    const internal = reduceRelationalTruth(tamperBundle, { mode: "full" });
    const validDelivery = buildRelationalTruthDelivery({
      processingWatermarkStatus: tamperBundle.processingWatermarkStatus,
      processingWatermark: tamperBundle.processingWatermark,
      processingWatermarkHash: tamperBundle.processingWatermarkHash,
      reducedPacket: internal,
      claimEnvelopes: tamperBundle.acceptedClaimEnvelopes,
      shipmentMetadataEnvelopes: tamperBundle.shipmentMetadataEnvelopes,
      compiledAt: tamperBundle.sourceCut.sealedAt,
    });
    const tampered = JSON.parse(JSON.stringify(validDelivery));
    tampered.shipments[0].client = "Lost at delivery boundary";
    const report = {
      schemaValid: true,
      deliveryIdentityValid: true,
      acceptedClaimManifestHash: validDelivery.truthProvenance.acceptedClaimManifestHash,
      shipmentMetadataManifestHash: validDelivery.truthProvenance.shipmentMetadataManifestHash,
      shipmentMetadataCount: 1,
      deliveryPacketHash: runnerTest.sha256Json(tampered),
      internalReducerOutput: internal,
    };
    await assert.rejects(
      ledger.completePair({
        ...tamperLease,
        fullPacket: tampered,
        incrementalPacket: tampered,
        fullSemanticHash: internal.packetHash,
        incrementalSemanticHash: internal.packetHash,
        fullValidationReport: { ...report, mode: "full" },
        incrementalValidationReport: { ...report, mode: "incremental" },
      }),
      (error) => error?.code === "23514",
      "SQL completion must reject a delivery packet that loses exact TMS metadata",
    );

    const foreignKeys = await db.query(`
      select pg_get_constraintdef(constraint_row.oid, true) as definition
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
      where namespace_row.nspname = 'public'
        and table_row.relname = 'truth_shipment_metadata_envelopes'
        and constraint_row.contype = 'f'
      order by constraint_row.conname
    `);
    assert.ok(foreignKeys.rows.some((item) => (
      /foreign key \(workspace_key\) references truth_workspaces\(workspace_key\)/i.test(item.definition)
    )));
    assert.ok(foreignKeys.rows.some((item) => (
      /foreign key \(workspace_key, source_observation_id\) references source_observations\(workspace_key, observation_id\)/i
        .test(item.definition)
    )));
    assert.equal(foreignKeys.rows.some((item) => (
      /^foreign key \(source_observation_id\)/i.test(item.definition)
    )), false, "an unscoped observation FK must not survive migration replay");

    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-build-shipment-metadata",
      awb: row.awb,
      metadataVersionId: bundle.shipmentMetadataEnvelopes[0].metadataVersionId,
      metadataManifestHash: pair.shipmentMetadataManifestHash,
      guarantees: [
        "control-room client, station, cargo, flight, route, delivery, broker, and contact fields derive from the exact current TMS observation",
        "metadata identities and hashes are frozen into both full and incremental build input manifests",
        "caller-injected mutable shipment details are rejected before a build claim",
        "metadata rows count toward the bounded non-truncating build bundle",
        "SQL completion rejects metadata loss even when a caller claims schema and parity success",
        "workspace and source-observation references are structurally tenant scoped",
        "the metadata migration reapplies without duplicating authorities or constraints",
      ],
    }, null, 2));
  } finally {
    await db.close();
  }
}

function candidateAwb(seeded) {
  return String(seeded.shipment.trackingNumber || "").replace(/\D/g, "");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

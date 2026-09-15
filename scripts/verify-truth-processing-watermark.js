#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const {
  REDUCER_VERSION,
  reduceRelationalTruth,
} = require("../lib/relational-truth-reducer");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const { createTruthBuildLedger, RPC } = require("../lib/truth-build-ledger");
const { runRelationalTruthBuild } = require("../lib/relational-truth-build-runner");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const WATERMARK_MIGRATION = "20260709241000_truth_processing_watermark.sql";
const MIGRATION_NAMES = Object.freeze([
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709221000_protect_truth_snapshot_keys.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709223000_truth_generic_source_ingestion.sql",
  "20260709224000_truth_audit_runtime.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
  "20260709226000_truth_link_workgroup_runtime.sql",
  "20260709230000_truth_build_publication_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709232000_truth_private_evidence_bucket.sql",
  "20260709233000_truth_worker_context_runtime.sql",
  "20260709234000_truth_source_cut_coordinator.sql",
  "20260709235000_truth_tracking_scope_authority.sql",
  "20260709236000_truth_operator_event_authority.sql",
  "20260709237000_truth_audit_status_read.sql",
  "20260709238000_truth_tms_inventory_presence_policy.sql",
  "20260709239000_truth_source_chronology.sql",
  "20260709239500_truth_claim_context_chronology.sql",
  "20260709240000_truth_review_resolution.sql",
  "20260709240500_truth_build_shipment_metadata.sql",
  "20260709240600_truth_audit_shipment_metadata.sql",
  "20260709240700_truth_attachment_extraction_completeness.sql",
  "20260709240800_truth_audit_expired_running_status.sql",
  "20260709240900_truth_production_authority_isolation.sql",
  WATERMARK_MIGRATION,
]);

const TOKEN = "truth-processing-watermark-test-token-v1";
const AUDIT_TOKEN = "truth-processing-watermark-audit-token-v1";
const ISSUER_TOKEN = "truth-processing-watermark-issuer-token-v1";
const WORKSPACE = "primary";
const AWB = "01680000083";
const DELIVERY_SCHEMA_VERSION = "shipment-truth-packet-v2";
const DELIVERY_BUILDER_VERSION = "watermark-delivery-builder-v1";

const RPC_SIGNATURES = Object.freeze({
  [RPC.claimPair]: [
    ["p_workspace_key", "text"], ["p_source_cut_id", "text"],
    ["p_build_channel", "text"], ["p_trigger_name", "text"],
    ["p_idempotency_key", "text"], ["p_worker_id", "text"],
    ["p_lease_seconds", "integer"], ["p_bundle_row_limit", "integer"],
    ["p_versions", "jsonb"], ["p_sync_token", "text"],
  ],
  [RPC.renewLease]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"], ["p_lease_fence", "bigint"],
    ["p_lease_seconds", "integer"], ["p_sync_token", "text"],
  ],
  [RPC.readBundle]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"], ["p_lease_fence", "bigint"],
    ["p_sync_token", "text"],
  ],
  [RPC.completePair]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"], ["p_lease_fence", "bigint"],
    ["p_full_packet", "jsonb"], ["p_incremental_packet", "jsonb"],
    ["p_full_semantic_hash", "text"], ["p_incremental_semantic_hash", "text"],
    ["p_full_validation_report", "jsonb"],
    ["p_incremental_validation_report", "jsonb"], ["p_sync_token", "text"],
  ],
  [RPC.failPair]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"], ["p_lease_fence", "bigint"],
    ["p_error_code", "text"], ["p_safe_error_detail", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.publishPair]: [
    ["p_workspace_key", "text"], ["p_build_pair_id", "uuid"],
    ["p_publication_request_key", "text"], ["p_expected_head_version", "bigint"],
    ["p_expected_head_packet_hash", "text"], ["p_publication_reason", "text"],
    ["p_publisher_version", "text"], ["p_published_by", "text"],
    ["p_production_approval_id", "uuid"],
    ["p_production_approval_credential", "text"], ["p_sync_token", "text"],
  ],
  [RPC.rollbackForward]: [
    ["p_workspace_key", "text"], ["p_channel", "text"],
    ["p_target_publication_id", "uuid"], ["p_publication_request_key", "text"],
    ["p_expected_head_version", "bigint"], ["p_expected_head_packet_hash", "text"],
    ["p_publisher_version", "text"], ["p_published_by", "text"],
    ["p_production_approval_id", "uuid"],
    ["p_production_approval_credential", "text"], ["p_sync_token", "text"],
  ],
  [RPC.readHead]: [
    ["p_workspace_key", "text"], ["p_channel", "text"],
    ["p_max_payload_bytes", "integer"], ["p_sync_token", "text"],
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

function createDbRpcCaller(db) {
  return async (rpc, body) => {
    const signature = RPC_SIGNATURES[rpc];
    if (!signature) throw new Error(`Unexpected truth-build RPC ${rpc}`);
    const values = signature.map(([key, type]) => (
      type === "jsonb" ? JSON.stringify(body[key]) : body[key]
    ));
    const casts = signature.map(([, type], index) => `$${index + 1}::${type}`);
    return (await one(
      db,
      `select public.${rpc}(${casts.join(", ")}) as receipt`,
      values,
    )).receipt;
  };
}

async function expectSqlState(promise, expectedCode, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, expectedCode, `${label}: ${error?.message || error}`);
    return true;
  }, label);
}

async function createDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
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
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null
    );
    alter table storage.objects enable row level security;
  `);
  return db;
}

async function applyMigration(db, name) {
  await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8"));
}

async function installThrough409(db) {
  for (const name of MIGRATION_NAMES.slice(0, -1)) await applyMigration(db, name);
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values
      ('local_snapshot_writer', encode(
        extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex'
      )),
      ('truth_audit_runtime', encode(
        extensions.digest(convert_to($2::text, 'UTF8'), 'sha256'), 'hex'
      )),
      ('truth_production_approval_issuer', encode(
        extensions.digest(convert_to($3::text, 'UTF8'), 'sha256'), 'hex'
      ))
  `, [TOKEN, AUDIT_TOKEN, ISSUER_TOKEN]);
}

async function seedObservation(db, {
  workspaceKey,
  suffix,
  normalizedText = "Shipment evidence fixture",
}) {
  const connectionKey = `gmail-${suffix}`;
  const cursorValue = "1";
  const contentHash = sha256(`content:${workspaceKey}:${suffix}`);
  const observationId = `obs:v1:${sha256(`observation:${workspaceKey}:${suffix}`)}`;
  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status, lease_fence
    ) values ($1, 'gmail', $2, 'gmail_history_id', $3, 1, 'live', 1)
  `, [workspaceKey, connectionKey, cursorValue]);
  const batch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count, committed_at, finished_at
    ) values (
      $1, 'gmail', $2, 'snapshot', 'processing-watermark-fixture',
      0, '', 1, $3, 'fixture', 1, 'committed', $4,
      0, 1, 0, now(), now()
    ) returning batch_id
  `, [workspaceKey, connectionKey, cursorValue, sha256(`batch:${workspaceKey}:${suffix}`)]);
  await db.query(`
    insert into public.source_observations (
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, source_recorded_at,
      captured_at, normalized_payload, normalized_text, source_fidelity,
      schema_version
    ) values (
      $1, $2, 'gmail', $3, 'gmail_message', $4, '1', 'content',
      1, $5, $6, '2026-07-09T12:00:00.000Z',
      '2026-07-09T12:00:01.000Z', '{}'::jsonb, $7,
      'normalized_source', 'source-observation-v1'
    )
  `, [
    observationId,
    workspaceKey,
    connectionKey,
    `message-${suffix}`,
    batch.batch_id,
    contentHash,
    normalizedText,
  ]);
  await db.query(`
    update public.source_cursors
    set last_batch_id = $1, last_committed_at = now()
    where workspace_key = $2 and source_system = 'gmail' and connection_key = $3
  `, [batch.batch_id, workspaceKey, connectionKey]);
  return { observationId, contentHash, connectionKey, cursorValue };
}

async function appendClaim(db, {
  workspaceKey,
  observationId,
  suffix,
  gate = "arrival",
  predicate = "arrival_confirmed",
  extractionMethod = "deterministic",
  extractorVersion = "fixture-extractor-v1",
  promptVersion = "",
  model = "",
  acceptanceMethod = "policy",
  acceptancePolicyVersion = "fixture-acceptance-v1",
}) {
  const claim = {
    claimKey: `shipment:${AWB}:${gate}:${suffix}`,
    versionNo: 1,
    previousClaimVersionId: null,
    primaryObservationId: observationId,
    subjectType: "shipment",
    subjectKey: AWB,
    predicate,
    gate,
    polarity: "positive",
    normalizedValue: { completed: true, sourceClass: "gmail_parsed_message" },
    occurredAt: "2026-07-09T12:00:00.000Z",
    confidence: 0.98,
    confidenceLabel: "high",
    extractionMethod,
    extractorVersion,
    promptVersion,
    model,
    acceptanceMethod,
    acceptancePolicyVersion,
    acceptedBy: "processing-watermark-verifier",
    decision: "accepted",
    evidenceSpan: { field: "body", text: `${gate} confirmed` },
    recordedAt: "2026-07-09T12:00:02.000Z",
    schemaVersion: "accepted-claim-v1",
  };
  const evidence = [{
    observationId,
    evidenceRole: "primary",
    evidenceSpan: claim.evidenceSpan,
  }];
  return (await one(db, `
    select public.append_accepted_claim(
      $1::text, $2::jsonb, $3::jsonb, '[]'::jsonb, $4::text
    ) as receipt
  `, [workspaceKey, JSON.stringify(claim), JSON.stringify(evidence), TOKEN])).receipt;
}

async function appendLinkAndWorkgroup(db, { workspaceKey, observationId, suffix }) {
  const link = {
    linkKey: `link:${workspaceKey}:${suffix}`,
    versionNo: 1,
    previousLinkVersionId: null,
    observationId,
    entityType: "shipment",
    entityKey: AWB,
    relationship: "applies_to",
    decision: "linked",
    confidence: 0.99,
    linkMethod: "model",
    linkerVersion: "fixture-entity-linker-v2",
    evidenceSpan: { field: "body", text: AWB },
    recordedAt: "2026-07-09T12:00:03.000Z",
    schemaVersion: "observation-entity-link-v1",
  };
  await one(db, `
    select public.append_observation_entity_link(
      $1::text, $2::jsonb, $3::text
    ) as receipt
  `, [workspaceKey, JSON.stringify(link), TOKEN]);
  const workgroup = {
    workgroupType: "pickup_execution",
    identityKey: `workgroup:${workspaceKey}:${suffix}`,
    identityBasis: { broker: "fixture" },
    createdMethod: "operator",
    linkerVersion: "fixture-workgroup-creator-v3",
    initialConfidence: 0.97,
    createdAt: "2026-07-09T12:00:03.000Z",
    schemaVersion: "operational-workgroup-v1",
  };
  const membership = {
    membershipKey: `membership:${workspaceKey}:${suffix}`,
    versionNo: 1,
    previousMembershipVersionId: null,
    memberType: "shipment",
    memberKey: AWB,
    role: "shipment",
    decision: "added",
    confidence: 0.96,
    membershipMethod: "deterministic",
    linkerVersion: "fixture-membership-linker-v4",
    basisObservationId: observationId,
    recordedAt: "2026-07-09T12:00:04.000Z",
    schemaVersion: "operational-workgroup-membership-v1",
  };
  const evidence = [{
    observationId,
    evidenceRole: "primary",
    evidenceSpan: { field: "body", text: AWB },
  }];
  await one(db, `
    select public.append_operational_workgroup_membership(
      $1::text, $2::jsonb, $3::jsonb, $4::jsonb, $5::text
    ) as receipt
  `, [
    workspaceKey,
    JSON.stringify(workgroup),
    JSON.stringify(membership),
    JSON.stringify(evidence),
    TOKEN,
  ]);
}

async function sealCut(db, { workspaceKey, connectionKey, cursorValue }) {
  return (await one(db, `
    select public.seal_source_cut(
      $1::text,
      'source-cut-manifest-v2'::text,
      $2::jsonb,
      '[]'::jsonb,
      $3::jsonb,
      '[]'::jsonb,
      'processing-watermark-fixture'::text,
      $4::text
    ) as receipt
  `, [
    workspaceKey,
    JSON.stringify([{ sourceSystem: "gmail", connectionKey }]),
    JSON.stringify([{
      sourceSystem: "gmail",
      connectionKey,
      cursorKind: "gmail_history_id",
      throughCursorVersion: "1",
      throughCursorValue: cursorValue,
      upstreamWatermark: cursorValue,
      sourceSnapshotAt: "2026-07-09T12:00:01.000Z",
    }]),
    TOKEN,
  ])).receipt;
}

function legacyVersions() {
  return {
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
  };
}

function configuredVersions(overrides = {}) {
  const configSnapshotHash = overrides.configSnapshotHash || sha256("watermark-config-v1");
  return {
    model: "deterministic-only-v1",
    promptVersion: "deterministic-only-v1",
    extractorVersion: `configured-extractor-set:v1:${sha256("extractor-config-v1")}`,
    entityLinkerVersion: `configured-linker-set:v1:${sha256("linker-config-v1")}`,
    acceptancePolicyVersion: `configured-acceptance-policy-set:v1:${sha256("acceptance-config-v1")}`,
    configSnapshotVersion: `truth-processing-config-snapshot:v1:${configSnapshotHash}`,
    configSnapshotHash,
    ...legacyVersions(),
    ...overrides,
  };
}

async function claimPair(db, {
  workspaceKey,
  sourceCutId,
  idempotencyKey,
  workerId,
  versions,
  buildChannel = "candidate",
}) {
  return (await one(db, `
    select public.claim_truth_build_pair(
      $1::text, $2::text, $3::text, 'processing-watermark-verifier'::text,
      $4::text, $5::text, 300::integer, 1000::integer,
      $6::jsonb, $7::text
    ) as receipt
  `, [
    workspaceKey,
    sourceCutId,
    buildChannel,
    idempotencyKey,
    workerId,
    JSON.stringify(versions),
    TOKEN,
  ])).receipt;
}

async function readBundle(db, { workspaceKey, pair, workerId }) {
  return (await one(db, `
    select public.read_truth_build_bundle(
      $1::text, $2::uuid, $3::text, $4::bigint, $5::text
    ) as receipt
  `, [workspaceKey, pair.buildPairId, workerId, pair.leaseFence, TOKEN])).receipt;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalize(value[key]),
  ]));
}

function sha256Json(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function buildDelivery({ reducedPacket, bundle }) {
  const acceptedClaimManifestHash = sha256Json(
    bundle.acceptedClaimEnvelopes.map((item) => ({
      claimVersionId: item.claimVersionId,
      envelopeHash: item.envelopeHash,
    })).sort((left, right) => left.claimVersionId.localeCompare(right.claimVersionId)),
  );
  const shipments = reducedPacket.shipments.map((row) => ({
    awb: row.shipmentKey,
    truthPacketRole: "active",
    evidencePacket: {
      sourceFacts: row.acceptedClaimIds.map((id) => ({ id })),
      unknowns: [],
      contradictions: row.contradictions,
    },
    truthPacket: {
      currentState: row.currentState.value,
      stateReason: row.currentState.reason,
      gates: row.gates.map((gate) => ({
        gate: gate.gate,
        status: gate.status,
        sourceFactIds: gate.claimVersionIds,
        reason: gate.reason,
      })),
      sourceFactIds: row.acceptedClaimIds,
      contradictions: row.contradictions,
      unknowns: row.gates.filter((gate) => gate.status === "unknown").map((gate) => gate.gate),
    },
  }));
  const activeAwbs = shipments.map((shipment) => shipment.awb).sort();
  return {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    writerVersion: DELIVERY_SCHEMA_VERSION,
    snapshotTime: bundle.sourceCut.sealedAt,
    sourceOfTruth: "relational accepted claims",
    counts: { shipments: shipments.length, active: activeAwbs.length, completed: 0 },
    activeAwbs,
    completedAwbs: [],
    shipments,
    packetHash: reducedPacket.packetHash,
    truthProvenance: {
      schemaVersion: "relational-truth-delivery-provenance-v1",
      sourceCutId: reducedPacket.sourceCut.sourceCutId,
      reducerPacketHash: reducedPacket.packetHash,
      inputManifestHash: reducedPacket.inputManifestHash,
      reducerVersion: reducedPacket.reducerVersion,
      precedencePolicyVersion: reducedPacket.precedencePolicy.policyVersion,
      precedencePolicyHash: reducedPacket.precedencePolicy.policyHash,
      acceptedClaimManifestHash,
      shipmentMetadataManifestHash: reducedPacket.shipmentMetadataManifestHash,
      processingWatermarkStatus: bundle.processingWatermarkStatus,
      processingWatermark: bundle.processingWatermark,
      processingWatermarkHash: bundle.processingWatermarkHash,
    },
  };
}

async function buildArtifacts(db, { workspaceKey, pair, workerId, legacy = false }) {
  const bundle = await readBundle(db, { workspaceKey, pair, workerId });
  const full = reduceRelationalTruth(bundle, { mode: "full" });
  const incremental = reduceRelationalTruth(bundle, { mode: "incremental" });
  assert.deepEqual(full, incremental, "full/incremental reducer output must be exact");
  const fullDelivery = buildDelivery({ reducedPacket: full, bundle });
  const incrementalDelivery = JSON.parse(JSON.stringify(fullDelivery));
  if (legacy) {
    delete fullDelivery.truthProvenance.processingWatermarkStatus;
    delete fullDelivery.truthProvenance.processingWatermark;
    delete fullDelivery.truthProvenance.processingWatermarkHash;
    delete incrementalDelivery.truthProvenance.processingWatermarkStatus;
    delete incrementalDelivery.truthProvenance.processingWatermark;
    delete incrementalDelivery.truthProvenance.processingWatermarkHash;
  }
  const report = {
    schemaValid: true,
    deliveryIdentityValid: true,
    acceptedClaimManifestHash: fullDelivery.truthProvenance.acceptedClaimManifestHash,
    shipmentMetadataManifestHash: fullDelivery.truthProvenance.shipmentMetadataManifestHash,
    shipmentMetadataCount: bundle.shipmentMetadataEnvelopes.length,
    deliveryPacketHash: sha256Json(fullDelivery),
    internalReducerOutput: full,
  };
  return {
    bundle,
    full,
    incremental,
    fullDelivery,
    incrementalDelivery,
    fullReport: report,
    incrementalReport: JSON.parse(JSON.stringify(report)),
    semanticHash: sha256Json({ shipments: full.shipments }),
  };
}

async function completePair(db, { workspaceKey, pair, workerId, artifacts }) {
  return (await one(db, `
    select public.complete_truth_build_pair(
      $1::text, $2::uuid, $3::text, $4::bigint,
      $5::jsonb, $6::jsonb, $7::text, $7::text,
      $8::jsonb, $9::jsonb, $10::text
    ) as receipt
  `, [
    workspaceKey,
    pair.buildPairId,
    workerId,
    pair.leaseFence,
    JSON.stringify(artifacts.fullDelivery),
    JSON.stringify(artifacts.incrementalDelivery),
    artifacts.semanticHash,
    JSON.stringify(artifacts.fullReport),
    JSON.stringify(artifacts.incrementalReport),
    TOKEN,
  ])).receipt;
}

async function issueApproval(db, {
  operation,
  buildPairId = null,
  targetPublicationId = null,
  approvalRequestKey,
  publicationRequestKey,
  expectedHeadVersion,
  expectedHeadPacketHash,
  publicationReason,
  publisherVersion,
  publishedBy,
  credential,
}) {
  return (await one(db, `
    select public.issue_truth_production_publication_approval(
      $1::text, $2::text, $3::uuid, $4::uuid, $5::text, $6::text,
      $7::bigint, $8::text, $9::text, $10::text, $11::text,
      'watermark-verifier'::text, 'local regression'::text,
      (clock_timestamp() + interval '10 minutes')::timestamptz,
      $12::text, $13::text
    ) as receipt
  `, [
    WORKSPACE,
    operation,
    buildPairId,
    targetPublicationId,
    approvalRequestKey,
    publicationRequestKey,
    expectedHeadVersion,
    expectedHeadPacketHash,
    publicationReason,
    publisherVersion,
    publishedBy,
    credential,
    ISSUER_TOKEN,
  ])).receipt;
}

async function publishPair(db, {
  pair,
  requestKey,
  expectedHeadVersion,
  expectedHeadPacketHash,
  approval,
  credential,
  publisherVersion = "watermark-publisher-v1",
}) {
  return (await one(db, `
    select public.publish_truth_build_pair_runtime_cas(
      $1::text, $2::uuid, $3::text, $4::bigint, $5::text,
      'normal'::text, $6::text,
      'watermark-verifier'::text, $7::uuid, $8::text, $9::text
    ) as receipt
  `, [
    WORKSPACE,
    pair.buildPairId,
    requestKey,
    expectedHeadVersion,
    expectedHeadPacketHash,
    publisherVersion,
    approval.approvalId,
    credential,
    TOKEN,
  ])).receipt;
}

async function readHead(db) {
  return (await one(db, `
    select public.read_truth_publication_head_runtime(
      $1::text, 'production'::text, 33554432::integer, $2::text
    ) as receipt
  `, [WORKSPACE, TOKEN])).receipt;
}

async function seedVariantWorkspace(db, {
  workspaceKey,
  suffix,
  model,
  promptVersion,
  acceptancePolicyVersion,
}) {
  await db.query(`
    insert into public.truth_workspaces (workspace_key, status, registry_version)
    values ($1, 'active', 'truth-workspace-registry-v1')
  `, [workspaceKey]);
  const source = await seedObservation(db, { workspaceKey, suffix });
  await appendClaim(db, {
    workspaceKey,
    observationId: source.observationId,
    suffix,
    extractionMethod: "model",
    extractorVersion: "variant-model-extractor-v1",
    promptVersion,
    model,
    acceptanceMethod: "operator",
    acceptancePolicyVersion,
  });
  const cut = await sealCut(db, { workspaceKey, ...source });
  const pair = await claimPair(db, {
    workspaceKey,
    sourceCutId: cut.sourceCutId,
    idempotencyKey: `variant:${suffix}`,
    workerId: `worker:variant:${suffix}`,
    versions: configuredVersions(),
  });
  return pair;
}

async function verifyMigrationReplay() {
  const db = await createDatabase();
  try {
    for (let pass = 1; pass <= 2; pass += 1) {
      for (const name of MIGRATION_NAMES) await applyMigration(db, name);
    }
  } finally {
    await db.close();
  }
}

async function main() {
  const db = await createDatabase();
  const checks = [];
  try {
    await installThrough409(db);
    checks.push("pre-410 schema installed");

    const source = await seedObservation(db, {
      workspaceKey: WORKSPACE,
      suffix: "primary",
      normalizedText: "Shipment arrived and customs released for shared pickup workgroup",
    });
    await appendClaim(db, {
      workspaceKey: WORKSPACE,
      observationId: source.observationId,
      suffix: "deterministic",
    });
    await appendClaim(db, {
      workspaceKey: WORKSPACE,
      observationId: source.observationId,
      suffix: "model",
      gate: "customs",
      predicate: "customs_release",
      extractionMethod: "model",
      extractorVersion: "fixture-model-extractor-v2",
      promptVersion: "fixture-model-prompt-v3",
      model: "fixture-model-v4",
      acceptanceMethod: "operator",
      acceptancePolicyVersion: "fixture-model-review-policy-v5",
    });
    await appendLinkAndWorkgroup(db, {
      workspaceKey: WORKSPACE,
      observationId: source.observationId,
      suffix: "primary",
    });
    const cut = await sealCut(db, { workspaceKey: WORKSPACE, ...source });

    const legacyWorker = "worker:legacy-production";
    const legacyPair = await claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "legacy-production-pair",
      workerId: legacyWorker,
      versions: legacyVersions(),
    });
    const legacyArtifacts = await buildArtifacts(db, {
      workspaceKey: WORKSPACE,
      pair: legacyPair,
      workerId: legacyWorker,
      legacy: true,
    });
    const legacyComplete = await completePair(db, {
      workspaceKey: WORKSPACE,
      pair: legacyPair,
      workerId: legacyWorker,
      artifacts: legacyArtifacts,
    });
    assert.equal(legacyComplete.status, "succeeded");
    const legacyCredential = "legacy-production-approval-credential";
    const legacyApproval = await issueApproval(db, {
      operation: "build_pair_publish",
      buildPairId: legacyPair.buildPairId,
      approvalRequestKey: "legacy-production-approval",
      publicationRequestKey: "legacy-production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "legacy-publisher-v1",
      publishedBy: "watermark-verifier",
      credential: legacyCredential,
    });
    const legacyPublication = await publishPair(db, {
      pair: legacyPair,
      requestKey: "legacy-production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      approval: legacyApproval,
      credential: legacyCredential,
      publisherVersion: "legacy-publisher-v1",
    });
    assert.equal(legacyPublication.publicationVersion, 1);
    checks.push("legacy production fixture created before migration");

    await applyMigration(db, WATERMARK_MIGRATION);
    await applyMigration(db, WATERMARK_MIGRATION);
    const legacyState = await one(db, `
      select
        pair.processing_watermark_status as pair_status,
        pair.processing_watermark is null as pair_null,
        bool_and(build.processing_watermark_status = 'legacy_unwatermarked') as builds_legacy,
        bool_and(build.processing_watermark is null) as builds_null,
        parity.processing_watermark_status as parity_status,
        publication.processing_watermark_status as publication_status,
        head.processing_watermark_status as head_status,
        payload.processing_watermark_status as payload_status
      from public.truth_build_pair_runs pair
      join public.truth_builds build on build.build_pair_id = pair.build_pair_id
      join public.truth_build_parity_receipts parity on parity.build_pair_id = pair.build_pair_id
      join public.truth_publications publication on publication.build_id = pair.full_build_id
      join public.truth_publication_heads head on head.publication_id = publication.publication_id
      join public.truth_publication_payloads payload on payload.publication_id = publication.publication_id
      where pair.build_pair_id = $1
      group by pair.processing_watermark_status, pair.processing_watermark,
        parity.processing_watermark_status, publication.processing_watermark_status,
        head.processing_watermark_status, payload.processing_watermark_status
    `, [legacyPair.buildPairId]);
    assert.deepEqual(legacyState, {
      pair_status: "legacy_unwatermarked",
      pair_null: true,
      builds_legacy: true,
      builds_null: true,
      parity_status: "legacy_unwatermarked",
      publication_status: "legacy_unwatermarked",
      head_status: "legacy_unwatermarked",
      payload_status: "legacy_unwatermarked",
    });
    checks.push("legacy rows remain explicitly unwatermarked");

    const ledger = createTruthBuildLedger({
      workspaceKey: WORKSPACE,
      syncToken: TOKEN,
      callRpc: createDbRpcCaller(db),
    });
    const readableLegacyHead = await ledger.readHead({
      channel: "production",
      maxPayloadBytes: 33554432,
    });
    assert.equal(readableLegacyHead.found, true);
    assert.equal(readableLegacyHead.publicationId, legacyPublication.publicationId);
    assert.equal(readableLegacyHead.processingWatermarkStatus, "legacy_unwatermarked");
    assert.equal(readableLegacyHead.processingWatermark, null);
    assert.equal(readableLegacyHead.processingWatermarkHash, null);

    const handoffOptions = {
      ledger,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "standard-ledger-legacy-head-handoff",
      workerId: "worker:standard-ledger-handoff",
      buildChannel: "candidate",
      triggerName: "verify-truth-processing-watermark",
      bundleRowLimit: 1000,
      precedencePolicy: DEFAULT_POLICY,
    };
    const handoffBuild = await runRelationalTruthBuild(handoffOptions);
    assert.equal(handoffBuild.status, "succeeded");
    assert.equal(handoffBuild.publication, null);
    const handoffCredential = "standard-handoff-production-approval-credential-0001";
    const handoffRequestKey = "standard-handoff-production-publication";
    const handoffApproval = await issueApproval(db, {
      operation: "build_pair_publish",
      buildPairId: handoffBuild.pair.buildPairId,
      approvalRequestKey: "standard-handoff-production-approval",
      publicationRequestKey: handoffRequestKey,
      expectedHeadVersion: readableLegacyHead.publicationVersion,
      expectedHeadPacketHash: readableLegacyHead.packetHash,
      publicationReason: "normal",
      publisherVersion: "standard-handoff-publisher-v1",
      publishedBy: "watermark-verifier",
      credential: handoffCredential,
    });
    const handoffPublished = await runRelationalTruthBuild({
      ...handoffOptions,
      publication: {
        publicationRequestKey: handoffRequestKey,
        publicationReason: "normal",
        publisherVersion: "standard-handoff-publisher-v1",
        publishedBy: "watermark-verifier",
        productionApproval: {
          approvalId: handoffApproval.approvalId,
          credential: handoffCredential,
        },
      },
    });
    assert.equal(handoffPublished.status, "succeeded");
    assert.equal(handoffPublished.recovered, true);
    assert.equal(handoffPublished.publication.publicationVersion, 2);
    assert.equal(
      handoffPublished.publication.previousPublicationId,
      legacyPublication.publicationId,
    );
    assert.equal(
      handoffPublished.publication.processingWatermarkStatus,
      "watermarked",
    );
    checks.push("legacy head reads explicitly and standard ledger/runner advances v+1");

    const baseConfigured = configuredVersions();
    const baseWorker = "worker:watermarked-production";
    const pair = await claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "watermarked-production-pair",
      workerId: baseWorker,
      versions: baseConfigured,
    });
    assert.equal(pair.processingWatermarkStatus, "watermarked");
    assert.match(pair.processingWatermarkHash, /^[0-9a-f]{64}$/);
    const watermark = pair.processingWatermark;
    assert.deepEqual(Object.keys(watermark).sort(), ["configured", "observed", "schemaVersion"]);
    assert.deepEqual(Object.keys(watermark.observed).sort(), [
      "claimProcessors",
      "entityLinkers",
      "extractorSetVersion",
      "linkerSetVersion",
      "workgroupCreators",
      "workgroupMembershipLinkers",
    ]);
    assert.ok(watermark.observed.claimProcessors.some((item) => (
      item.extractionMethod === "deterministic"
      && item.model === "deterministic:none"
      && item.promptVersion === "deterministic:none"
    )), "deterministic empty model/prompt must normalize to explicit sentinels");
    assert.ok(watermark.observed.claimProcessors.some((item) => (
      item.extractionMethod === "model"
      && item.model === "fixture-model-v4"
      && item.promptVersion === "fixture-model-prompt-v3"
      && item.acceptancePolicyVersion === "fixture-model-review-policy-v5"
    )), "non-empty model claim identities must be preserved");
    assert.deepEqual(watermark.observed.entityLinkers, [{
      linkMethod: "model",
      linkerVersion: "fixture-entity-linker-v2",
    }]);
    assert.deepEqual(watermark.observed.workgroupCreators, [{
      createdMethod: "operator",
      linkerVersion: "fixture-workgroup-creator-v3",
    }]);
    assert.deepEqual(watermark.observed.workgroupMembershipLinkers, [{
      membershipMethod: "deterministic",
      linkerVersion: "fixture-membership-linker-v4",
    }]);
    const postgresCanonical = await one(db, "select $1::jsonb::text as value", [JSON.stringify(watermark)]);
    assert.equal(sha256(postgresCanonical.value), pair.processingWatermarkHash);
    checks.push("configured and DB-derived observed vector canonicalized");

    const reverseConfigured = Object.fromEntries(Object.entries(baseConfigured).reverse());
    const reordered = await claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "watermark-reordered-config",
      workerId: "worker:reordered",
      versions: reverseConfigured,
    });
    assert.equal(reordered.processingWatermarkHash, pair.processingWatermarkHash);
    assert.equal(reordered.inputManifestHash, pair.inputManifestHash);

    const logicalVariations = [
      ["model", "deterministic-only-v2"],
      ["promptVersion", "deterministic-only-prompt-v2"],
      ["extractorVersion", `configured-extractor-set:v1:${sha256("extractor-config-v2")}`],
      ["entityLinkerVersion", `configured-linker-set:v1:${sha256("linker-config-v2")}`],
      ["acceptancePolicyVersion", `configured-acceptance-policy-set:v1:${sha256("acceptance-config-v2")}`],
      ["reducerVersion", `${REDUCER_VERSION}+watermark-variation`],
      ["packetBuilderVersion", `${DELIVERY_BUILDER_VERSION}+variation`],
      ["packetSchemaVersion", `${DELIVERY_SCHEMA_VERSION}+variation`],
      ["precedencePolicyVersion", `${DEFAULT_POLICY.policyVersion}+variation`],
      ["precedencePolicyHash", "f".repeat(64)],
    ];
    for (const [key, value] of logicalVariations) {
      const varied = await claimPair(db, {
        workspaceKey: WORKSPACE,
        sourceCutId: cut.sourceCutId,
        idempotencyKey: `configured-variation:${key}`,
        workerId: `worker:variation:${key}`,
        versions: configuredVersions({ [key]: value }),
      });
      assert.notEqual(varied.processingWatermarkHash, pair.processingWatermarkHash, key);
      assert.notEqual(varied.inputManifestHash, pair.inputManifestHash, key);
    }
    const nextConfigHash = sha256("watermark-config-v2");
    const variedConfigSnapshot = await claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "configured-variation:config-snapshot",
      workerId: "worker:variation:config-snapshot",
      versions: configuredVersions({
        configSnapshotHash: nextConfigHash,
        configSnapshotVersion: `truth-processing-config-snapshot:v1:${nextConfigHash}`,
      }),
    });
    assert.notEqual(variedConfigSnapshot.processingWatermarkHash, pair.processingWatermarkHash);
    checks.push("configured vector rotation and key-order invariance proven");

    const missing = { ...baseConfigured };
    delete missing.promptVersion;
    await expectSqlState(claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "invalid:missing",
      workerId: "worker:invalid:missing",
      versions: missing,
    }), "22023", "missing configured key fails closed");
    await expectSqlState(claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "invalid:extra-observed",
      workerId: "worker:invalid:extra-observed",
      versions: { ...baseConfigured, observed: {} },
    }), "22023", "caller-supplied observed set fails closed");
    await expectSqlState(claimPair(db, {
      workspaceKey: WORKSPACE,
      sourceCutId: cut.sourceCutId,
      idempotencyKey: "invalid:config-version",
      workerId: "worker:invalid:config-version",
      versions: { ...baseConfigured, configSnapshotVersion: "mutable-name" },
    }), "22023", "non-content-addressed config version fails closed");
    checks.push("missing extra blank and malformed configured vectors rejected");

    const artifacts = await buildArtifacts(db, {
      workspaceKey: WORKSPACE,
      pair,
      workerId: baseWorker,
    });
    assert.equal(artifacts.bundle.processingWatermarkHash, pair.processingWatermarkHash);
    const adversarial = JSON.parse(JSON.stringify(artifacts));
    const wrongManifest = "e".repeat(64);
    adversarial.full.inputManifestHash = wrongManifest;
    adversarial.incremental.inputManifestHash = wrongManifest;
    adversarial.fullReport.internalReducerOutput.inputManifestHash = wrongManifest;
    adversarial.incrementalReport.internalReducerOutput.inputManifestHash = wrongManifest;
    adversarial.fullDelivery.truthProvenance.inputManifestHash = wrongManifest;
    adversarial.incrementalDelivery.truthProvenance.inputManifestHash = wrongManifest;
    await expectSqlState(completePair(db, {
      workspaceKey: WORKSPACE,
      pair,
      workerId: baseWorker,
      artifacts: adversarial,
    }), "23514", "reducer-local manifest cannot escape the pair manifest");
    const completed = await completePair(db, {
      workspaceKey: WORKSPACE,
      pair,
      workerId: baseWorker,
      artifacts,
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.processingWatermarkHash, pair.processingWatermarkHash);
    const persisted = await one(db, `
      select
        bool_and(build.processing_watermark_hash = pair.processing_watermark_hash) as builds_match,
        parity.processing_watermark_hash = pair.processing_watermark_hash as parity_matches,
        bool_and(build.input_manifest_hash = pair.input_manifest_hash) as manifests_match
      from public.truth_build_pair_runs pair
      join public.truth_builds build on build.build_pair_id = pair.build_pair_id
      join public.truth_build_parity_receipts parity on parity.build_pair_id = pair.build_pair_id
      where pair.build_pair_id = $1
      group by parity.processing_watermark_hash, pair.processing_watermark_hash
    `, [pair.buildPairId]);
    assert.deepEqual(persisted, {
      builds_match: true,
      parity_matches: true,
      manifests_match: true,
    });
    checks.push("full incremental parity and pair manifest continuity proven");

    const publication = handoffPublished.publication;
    const handoffPair = handoffPublished.pair;
    assert.equal(publication.processingWatermarkHash, handoffPair.processingWatermarkHash);
    assert.equal(
      publication.publicationAdapter.processingWatermarkHash,
      handoffPair.processingWatermarkHash,
    );
    const head = await readHead(db);
    assert.equal(head.found, true);
    assert.equal(head.processingWatermarkHash, handoffPair.processingWatermarkHash);
    assert.equal(
      head.deliveryPayload.processingWatermarkHash,
      handoffPair.processingWatermarkHash,
    );
    assert.equal(head.deliveryPayload.deliveryPayloadHash, head.deliveryPayloadHash);
    const cache = await one(db, `
      select payload->>'processingWatermarkHash' as watermark_hash,
             payload->>'contentSignature' as content_signature
      from public.app_snapshots where snapshot_key = 'shipment-truth-packets'
    `);
    assert.equal(cache.watermark_hash, handoffPair.processingWatermarkHash);
    assert.equal(cache.content_signature, head.deliveryPayloadHash);
    checks.push("publication receipt delivery head and compatibility cache share watermark");

    const rollbackCredential = "legacy-rollback-approval-credential";
    const rollbackRequestKey = "legacy-rollback-request";
    const rollbackApproval = await issueApproval(db, {
      operation: "rollback_forward",
      targetPublicationId: legacyPublication.publicationId,
      approvalRequestKey: "legacy-rollback-approval",
      publicationRequestKey: rollbackRequestKey,
      expectedHeadVersion: head.publicationVersion,
      expectedHeadPacketHash: head.packetHash,
      publicationReason: "rollback",
      publisherVersion: "watermark-publisher-v1",
      publishedBy: "watermark-verifier",
      credential: rollbackCredential,
    });
    await expectSqlState(one(db, `
      select public.publish_truth_rollback_forward(
        $1::text, 'production'::text, $2::uuid, $3::text,
        $4::bigint, $5::text, 'watermark-publisher-v1'::text,
        'watermark-verifier'::text, $6::uuid, $7::text, $8::text
      ) as receipt
    `, [
      WORKSPACE,
      legacyPublication.publicationId,
      rollbackRequestKey,
      head.publicationVersion,
      head.packetHash,
      rollbackApproval.approvalId,
      rollbackCredential,
      TOKEN,
    ]), "23514", "legacy target cannot be laundered by rollback-forward");
    const rollbackState = await one(db, `
      select approval.status, approval.consumed_publication_id,
             head.publication_id, head.publication_version
      from public.truth_production_publication_approvals approval
      cross join public.truth_publication_heads head
      where approval.approval_id = $1
        and head.workspace_key = $2 and head.channel = 'production'
    `, [rollbackApproval.approvalId, WORKSPACE]);
    assert.equal(rollbackState.status, "issued");
    assert.equal(rollbackState.consumed_publication_id, null);
    assert.equal(rollbackState.publication_id, head.publicationId);
    assert.equal(Number(rollbackState.publication_version), head.publicationVersion);
    checks.push("legacy rollback rejected without head advance or approval consumption");

    const baseVariant = await seedVariantWorkspace(db, {
      workspaceKey: "variant-base",
      suffix: "variant-base",
      model: "model-a",
      promptVersion: "prompt-a",
      acceptancePolicyVersion: "policy-a",
    });
    for (const variant of [
      ["variant-model", "model-b", "prompt-a", "policy-a"],
      ["variant-prompt", "model-a", "prompt-b", "policy-a"],
      ["variant-policy", "model-a", "prompt-a", "policy-b"],
    ]) {
      const derived = await seedVariantWorkspace(db, {
        workspaceKey: variant[0],
        suffix: variant[0],
        model: variant[1],
        promptVersion: variant[2],
        acceptancePolicyVersion: variant[3],
      });
      assert.notEqual(
        derived.processingWatermark.observed.extractorSetVersion,
        baseVariant.processingWatermark.observed.extractorSetVersion,
      );
      assert.notEqual(derived.processingWatermarkHash, baseVariant.processingWatermarkHash);
    }
    await db.query(`
      insert into public.truth_workspaces (workspace_key, status, registry_version)
      values ('variant-blank-model', 'active', 'truth-workspace-registry-v1')
    `);
    const blankSource = await seedObservation(db, {
      workspaceKey: "variant-blank-model",
      suffix: "variant-blank-model",
    });
    await appendClaim(db, {
      workspaceKey: "variant-blank-model",
      observationId: blankSource.observationId,
      suffix: "blank-model",
      extractionMethod: "model",
      model: "",
      promptVersion: "",
      acceptanceMethod: "operator",
    });
    const blankCut = await sealCut(db, {
      workspaceKey: "variant-blank-model",
      ...blankSource,
    });
    await expectSqlState(claimPair(db, {
      workspaceKey: "variant-blank-model",
      sourceCutId: blankCut.sourceCutId,
      idempotencyKey: "blank-model-pair",
      workerId: "worker:blank-model",
      versions: configuredVersions(),
    }), "23514", "model claim with blank model/prompt fails closed");
    checks.push("observed model prompt and acceptance-policy rotations proven");

    const auditSnapshot = (await one(db, `
      select public.read_truth_audit_snapshot(
        $1::text, 100::integer, $2::text
      ) as receipt
    `, [WORKSPACE, AUDIT_TOKEN])).receipt;
    const continuity = auditSnapshot.canonical.processingWatermarkContinuity;
    assert.ok(continuity.buildPairs.some((item) => (
      item.buildPairId === pair.buildPairId
      && item.continuityStatus === "consistent"
      && item.parity.processingWatermarkHash === pair.processingWatermarkHash
    )));
    assert.ok(continuity.publications.some((item) => (
      item.publicationId === publication.publicationId
      && item.continuityStatus === "consistent"
    )));
    assert.ok(continuity.legacyUnwatermarkedPairCount >= 1);
    assert.equal(continuity.mismatchCount, 0);
    checks.push("bounded audit snapshot exposes pair-build-parity-publication continuity");

    await expectSqlState(db.query(`
      update public.truth_builds set processing_watermark_hash = $1
      where build_id = $2
    `, ["0".repeat(64), pair.fullBuildId]), "55000", "succeeded build watermark immutable");
    await expectSqlState(db.query(`
      update public.truth_build_parity_receipts set processing_watermark_hash = $1
      where build_pair_id = $2
    `, ["0".repeat(64), pair.buildPairId]), "55000", "parity watermark immutable");
    await expectSqlState(db.query(`
      update public.truth_publications set processing_watermark_hash = $1
      where publication_id = $2
    `, ["0".repeat(64), publication.publicationId]), "55000", "publication watermark immutable");
    await expectSqlState(db.query(`
      update public.truth_publication_payloads set processing_watermark_hash = $1
      where publication_id = $2
    `, ["0".repeat(64), publication.publicationId]), "55000", "payload watermark immutable");
    await expectSqlState(db.query(`
      update public.truth_build_pair_runs set processing_watermark_hash = $1
      where build_pair_id = $2
    `, ["0".repeat(64), reordered.buildPairId]), "55000", "running pair watermark immutable");
    checks.push("processing watermark immutable fields are guarded");

    const beforeReapply = await one(db, `
      select processing_watermark_hash from public.truth_publications
      where publication_id = $1
    `, [publication.publicationId]);
    await applyMigration(db, WATERMARK_MIGRATION);
    const afterReapply = await one(db, `
      select processing_watermark_hash from public.truth_publications
      where publication_id = $1
    `, [publication.publicationId]);
    assert.deepEqual(afterReapply, beforeReapply);
    checks.push("migration reapplies over populated state without relabeling");

    const privileges = await one(db, `
      select
        has_table_privilege('anon', 'public.truth_publications', 'SELECT') as anon_select,
        has_table_privilege('authenticated', 'public.truth_builds', 'SELECT') as auth_select,
        has_table_privilege('service_role', 'public.truth_publications', 'INSERT') as service_insert
    `);
    assert.deepEqual(privileges, {
      anon_select: false,
      auth_select: false,
      service_insert: false,
    });
    checks.push("existing RLS and direct-DML security boundary retained");
  } finally {
    await db.close();
  }

  await verifyMigrationReplay();
  checks.push("all truth migrations apply and reapply in timestamp order");
  console.log(`Truth processing watermark verification passed (${checks.length} checks)`);
  for (const check of checks) console.log(`- ${check}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

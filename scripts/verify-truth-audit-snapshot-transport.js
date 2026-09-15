#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _test: auditorTest } = require("../lib/relational-truth-auditor");
const { _test: ledgerTest } = require("../lib/truth-audit-ledger");

const ROOT = path.resolve(__dirname, "..");
const baseMigration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718010000_bound_truth_audit_snapshot_transport.sql",
), "utf8");
const currentHeadMigration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718220000_scope_truth_audit_to_current_heads.sql",
), "utf8");
const compactCacheMigration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718230000_compact_production_cache_audit_witness.sql",
), "utf8");
const boundedModelReviewMigration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718240000_bound_model_review_commissioning_witness.sql",
), "utf8");
const splitTransportMigration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718250000_split_truth_audit_snapshot_transport.sql",
), "utf8");
const migration = [
  baseMigration,
  currentHeadMigration,
  compactCacheMigration,
  boundedModelReviewMigration,
  splitTransportMigration,
].join("\n");
const incident = fs.readFileSync(path.join(
  ROOT,
  "YLYI/08_Incidents/INC-2026-07-22-TRUTH-AUDIT-SNAPSHOT-EXCEEDS-ANON-BUDGET.md",
), "utf8");
const backtests = fs.readFileSync(path.join(
  ROOT,
  "YLYI/07_Backtest_Cases/Backtest_Cases.md",
), "utf8");

for (const required of [
  "statement_timeout=3s",
  "truth audit build projection differs from the reviewed predecessor",
  "truth audit cache projection differs from the reviewed predecessor",
  "truth audit job projection differs from the reviewed predecessor",
  "truth audit lineage projection differs from the reviewed predecessor",
  "truth audit observation projection differs from the reviewed predecessor",
  "truth audit attachment-gap transport rewrite did not apply exactly",
  "truth audit model-gap transport rewrite did not apply exactly",
  "build.input_manifest_hash",
  "build.processing_watermark_status",
  "build.processing_watermark_hash",
  "build.shipment_metadata_manifest_hash",
  "head.channel = 'production'",
  "then snapshot.payload",
  "jsonb_strip_nulls(jsonb_build_object(",
  "snapshot.payload->'publicationId'",
  "snapshot.payload->'publicationChannel'",
  "snapshot.payload->'contentSignature'",
  "snapshot.payload->'writerVersion'",
  "job.job_kind = 'gmail_extract_message_model_claims'",
  "'operator_extract_claims'",
  "jsonb_build_array(",
  "to_jsonb(row_value) - 'root_batch_id' - 'root_job_id'",
  "from public.source_cut_cursors cut_cursor",
  "current-headed-build-scope-v1",
  "publication.build_id = build.build_id",
  "source-verified-compact-v1",
  "payloadHashVerifiedAtSource",
  "valid_commissioning_replays as materialized",
  "replay.workspace_key,replay.obligation_id",
  "split-truth-audit-snapshot-transport-v1",
  "public.read_truth_audit_snapshot_base",
  "public.read_truth_audit_snapshot_publication_payloads",
  "public.read_truth_audit_snapshot_closure",
  "public.read_truth_audit_snapshot_processing",
  "public.read_truth_audit_snapshot_extensions",
  "relational-truth-audit-snapshot-extensions-v1",
]) {
  assert.ok(migration.includes(required), `transport migration is missing ${required}`);
}

const newBuildProjection = baseMigration.match(
  /v_new_builds constant text := \$new_builds\$([\s\S]*?)\$new_builds\$/,
)?.[1] || "";
for (const forbidden of [
  "build.packet_canonical_text",
  "build.packet_payload",
  "build.validation_report",
  "build.source_watermark",
  "build.processing_watermark,",
]) {
  assert.equal(newBuildProjection.includes(forbidden), false,
    `bounded build projection must omit ${forbidden}`);
}

assert.equal(/\b(?:insert|update|delete|truncate|alter\s+role)\b/i.test(migration), false,
  "transport migration must not mutate rows or widen a database role");
assert.match(incident, /24,934,888/);
assert.match(backtests, /BT-2026-07-22-TRUTH-AUDIT-SNAPSHOT-BOUNDED-TRANSPORT/);
assert.equal(currentHeadMigration.includes("build.source_cut_id = target.source_cut_id"), true,
  "the rewrite must pin and remove the reviewed same-cut predecessor predicate");
assert.match(currentHeadMigration, /replace\(v_definition,v_old,v_new\)/);
assert.equal(compactCacheMigration.includes("then snapshot.payload"), true,
  "the compact rewrite must pin and remove the reviewed full-cache branch");
assert.equal(
  boundedModelReviewMigration.includes(
    "truth_shadow_gmail_model_commissioning_replay_valid_v1(\n        obligation.workspace_key",
  ),
  false,
  "the expensive commissioning validator must not run for every obligation",
);
const extensionFunctionBody = splitTransportMigration.match(
  /create or replace function private\.read_truth_audit_snapshot_extensions\([\s\S]*?\n\$function\$;/,
)?.[0] || "";
assert.equal(
  extensionFunctionBody.includes("read_truth_audit_snapshot_core"),
  false,
  "the extension RPC must not recursively rebuild the base snapshot",
);
assert.match(splitTransportMigration, /payload-detached-base-v1/);
assert.match(splitTransportMigration, /read_truth_audit_snapshot_base_core/);
assert.match(splitTransportMigration, /grant execute on function public\.read_truth_audit_snapshot_base/);
assert.match(splitTransportMigration, /grant execute on function public\.read_truth_audit_snapshot_publication_payloads/);
assert.match(splitTransportMigration, /grant execute on function public\.read_truth_audit_snapshot_closure/);
assert.match(splitTransportMigration, /grant execute on function public\.read_truth_audit_snapshot_processing/);
assert.match(splitTransportMigration, /grant execute on function public\.read_truth_audit_snapshot_extensions/);

assert.equal(auditorTest.sourceVerifiedCompactCache({
  cacheWitnessMode: "source-verified-compact-v1",
  payloadHashVerifiedAtSource: true,
}), true, "an exact source-verified cache witness must be accepted");
for (const invalidWitness of [
  { cacheWitnessMode: "source-verified-compact-v1" },
  { cacheWitnessMode: "source-verified-compact-v1", payloadHashVerifiedAtSource: false },
  { cacheWitnessMode: "source-verified-compact-v0", payloadHashVerifiedAtSource: true },
]) {
  assert.equal(auditorTest.sourceVerifiedCompactCache(invalidWitness), false,
    "a missing, false, or foreign cache witness must fail closed");
}

const compactObservationId = `obs:v1:${"a".repeat(64)}`;
const compactContentHash = "b".repeat(64);
const compactReferences = auditorTest.collectObservationReferences([
  compactObservationId,
  compactContentHash,
]);
assert.deepEqual([...compactReferences.entries()], [[compactObservationId, compactContentHash]],
  "auditor must preserve the content hash carried by a compact observation tuple");

const sourceCutId = `cut:v1:${"c".repeat(64)}`;
const baseReceipt = {
  schemaVersion: "relational-truth-audit-snapshot-v1",
  workspaceKey: "primary",
  capturedAt: "2026-07-22T23:00:00.000Z",
  bounds: { rowLimit: 20000, counts: { cursors: 4 }, truncated: false },
  source: { cursors: [] },
  canonical: { currentSourceCutId: sourceCutId },
};
baseReceipt.canonical.publicationHeads = [];
baseReceipt.canonical.publicationPayloads = [];
Object.assign(baseReceipt.bounds.counts, {
  acceptedClaimEnvelopes: 0,
  buildInputs: 0,
  entityLinkEnvelopes: 0,
  publicationPayloads: 0,
  sourceCutEvidenceObservations: 0,
  jobChildren: 0,
  jobLineage: 0,
  jobObservations: 0,
  jobs: 0,
  observations: 0,
});
baseReceipt.source.ingestBatches = [];
Object.assign(baseReceipt.source, {
  jobChildren: [],
  jobLineage: [],
  jobObservations: [],
  jobs: [],
  observations: [],
});
Object.assign(baseReceipt.canonical, {
  acceptedClaimEnvelopes: [],
  buildInputs: [],
  entityLinkEnvelopes: [],
  sourceCutEvidenceObservations: [],
});
baseReceipt.bounds.publicationPayloadBytes = 0;
baseReceipt.bounds.publicationPayloadByteLimit = 33554432;
const publicationReceipt = {
  schemaVersion: "relational-truth-audit-publication-payloads-v1",
  workspaceKey: "primary",
  rowLimit: 20000,
  sourceCutId,
  publicationHeads: [],
  publicationPayloads: [],
  publicationPayloadCount: 0,
  publicationPayloadBytes: 0,
  publicationPayloadByteLimit: 33554432,
  truncated: false,
};
const closureReceipt = {
  schemaVersion: "relational-truth-audit-closure-v1",
  workspaceKey: "primary",
  rowLimit: 20000,
  sourceCutId,
  bounds: {
    counts: {
      acceptedClaimEnvelopes: 0,
      buildInputs: 0,
      entityLinkEnvelopes: 0,
      sourceCutEvidenceObservations: 0,
    },
    truncated: false,
  },
  canonical: {
    acceptedClaimEnvelopes: [],
    buildInputs: [],
    entityLinkEnvelopes: [],
    sourceCutEvidenceObservations: [],
  },
};
const processingReceipt = {
  schemaVersion: "relational-truth-audit-processing-v1",
  workspaceKey: "primary",
  rowLimit: 20000,
  sourceCutId,
  currentBatchIds: [],
  bounds: {
    counts: {
      jobChildren: 0,
      jobLineage: 0,
      jobObservations: 0,
      jobs: 0,
      observations: 0,
    },
    truncated: false,
  },
  source: {
    jobChildren: [],
    jobLineage: [],
    jobObservations: [],
    jobs: [],
    observations: [],
  },
};
const extensionReceipt = {
  schemaVersion: "relational-truth-audit-snapshot-extensions-v1",
  workspaceKey: "primary",
  rowLimit: 20000,
  sourceCutId,
  bounds: {
    counts: {
      attachmentExtractionGaps: 0,
      modelExtractionJobGaps: 0,
      modelExtractionReviewGaps: 0,
      processingWatermarkBuildPairs: 0,
      processingWatermarkPublications: 0,
      shipmentMetadataEnvelopes: 0,
    },
    truncated: false,
  },
  source: {
    attachmentExtractionCompleteness: {
      schemaVersion: "gmail-attachment-extraction-completeness-v1",
      unresolvedCount: 0,
      complete: true,
    },
    attachmentExtractionGaps: [],
    modelExtractionCompleteness: {
      schemaVersion: "gmail-model-extraction-completeness-v1",
      pendingJobCount: 0,
      pendingReviewCount: 0,
      complete: true,
    },
    modelExtractionJobGaps: [],
    modelExtractionReviewGaps: [],
  },
  canonical: {
    shipmentMetadataEnvelopes: [],
    processingWatermarkContinuity: {
      schemaVersion: "truth-processing-watermark-continuity-v1",
      sourceCutId,
      complete: true,
      mismatchCount: 0,
      legacyUnwatermarkedPairCount: 0,
      buildPairs: [],
      publications: [],
    },
  },
};
const mergedReceipt = ledgerTest.mergeSnapshotReceipts(
  baseReceipt,
  publicationReceipt,
  processingReceipt,
  closureReceipt,
  extensionReceipt,
  { rowLimit: 20000 },
);
assert.equal(mergedReceipt.source.attachmentExtractionCompleteness.complete, true);
assert.equal(mergedReceipt.canonical.processingWatermarkContinuity.complete, true);
assert.equal(mergedReceipt.bounds.counts.cursors, 4);
assert.equal(mergedReceipt.bounds.counts.modelExtractionReviewGaps, 0);
for (const invalidExtension of [
  { ...extensionReceipt, workspaceKey: "foreign" },
  { ...extensionReceipt, sourceCutId: `cut:v1:${"d".repeat(64)}` },
  { ...extensionReceipt, rowLimit: 19999 },
  { ...extensionReceipt, bounds: { ...extensionReceipt.bounds, truncated: true } },
]) {
  assert.throws(
    () => ledgerTest.mergeSnapshotReceipts(
      baseReceipt,
      publicationReceipt,
      processingReceipt,
      closureReceipt,
      invalidExtension,
      { rowLimit: 20000 },
    ),
    /Invalid truth-audit snapshot extension/,
    "a mismatched or internally inconsistent extension receipt must fail closed",
  );
}
assert.throws(
  () => ledgerTest.mergeSnapshotReceipts(
    baseReceipt,
    { ...publicationReceipt, sourceCutId: `cut:v1:${"e".repeat(64)}` },
    processingReceipt,
    closureReceipt,
    extensionReceipt,
    { rowLimit: 20000 },
  ),
  /Invalid truth-audit snapshot extension/,
  "a mismatched publication-payload receipt must fail closed",
);
assert.throws(
  () => ledgerTest.mergeSnapshotReceipts(
    baseReceipt,
    publicationReceipt,
    processingReceipt,
    { ...closureReceipt, sourceCutId: `cut:v1:${"f".repeat(64)}` },
    extensionReceipt,
    { rowLimit: 20000 },
  ),
  /Invalid truth-audit snapshot extension/,
  "a mismatched closure receipt must fail closed",
);
assert.throws(
  () => ledgerTest.mergeSnapshotReceipts(
    baseReceipt,
    publicationReceipt,
    { ...processingReceipt, currentBatchIds: ["foreign"] },
    closureReceipt,
    extensionReceipt,
    { rowLimit: 20000 },
  ),
  /Invalid truth-audit snapshot extension/,
  "a mismatched processing receipt must fail closed",
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-audit-snapshot-transport",
  preservesAnonTimeout: true,
  preservesCanonicalProductionPayload: true,
  omitsUnusedBuildPacketBodies: true,
  scopesBuildClosureToCurrentHeads: true,
  compactProductionCacheWitness: true,
  boundedModelReviewCommissioningWitness: true,
  splitBoundSnapshotTransport: true,
  compactObservationTuplePreservesHash: true,
  mutatesOperationalState: false,
}, null, 2)}\n`);

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RPC, createSourceSnapshotLedger } = require("../lib/source-snapshot-ledger");
const {
  TrackingSourceSnapshotError,
  buildTrackingSourceSnapshot,
  inspectTrackingSourceSnapshot,
} = require("../lib/tracking-source-snapshot");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "verify-tracking-source-snapshot.json");
const SCOPE_TOKEN = `tracking-scope:v1:${"a".repeat(64)}`;

function fixtures() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
}

async function main() {
  const snapshots = fixtures();
  const before = clone(snapshots);
  const expectedAwbs = snapshots.flatMap((snapshot) => snapshot.tracking.map((row) => row.awb));
  const buildOptions = {
    workspaceKey: "primary",
    connectionKey: "carrier-tracking-primary",
    expectedAwbs,
    scopeToken: SCOPE_TOKEN,
  };
  const built = buildTrackingSourceSnapshot(snapshots, buildOptions);
  assert.deepEqual(snapshots, before, "tracking adapter mutated source fixtures");
  assert.ok(snapshots.every((snapshot) => !Object.isFrozen(snapshot)), "tracking adapter froze source fixtures");
  assert.equal(built.observations.length, 25);
  assert.equal(built.jobs.length, 25);
  assert.equal(built.providerManifest.recordCount, 25);
  assert.deepEqual(built.providerManifest.expectedAwbs,
    expectedAwbs.map((awb) => awb.replace(/\D/g, "")).sort());
  assert.equal(built.providerManifest.scopeToken, SCOPE_TOKEN);
  assert.equal(built.nextCursorValue, "2026-07-09T17:11:29.921Z");
  assert.deepEqual(built.providerManifest.healthCounts, {
    healthy: 9,
    insufficient_research_input: 1,
    no_result: 3,
    research_only: 12,
  });
  assert.match(built.payloadIdentity, /^tracking-source-snapshot:v1:[0-9a-f]{64}$/);
  assert.equal(built.mutatesOperationalState, false);
  assert.equal(built.reducesTruth, false);
  assert.equal(built.publishesTruth, false);
  assert.equal(Object.isFrozen(built), true);
  assert.equal(new Set(built.observations.map((row) => row.sourceObjectId)).size, 25);
  for (const observation of built.observations) {
    assert.match(observation.observationId, /^obs:v1:[0-9a-f]{64}$/);
    assert.match(observation.sourceObjectId, /^[0-9]{11}$/);
    assert.equal(observation.sourceObjectType, "tracking_shipment_snapshot");
    assert.equal(observation.sourceRevision, `snapshot:${built.nextCursorValue}`);
    assert.equal(observation.sourceRecordedAt, built.nextCursorValue);
    assert.equal(observation.normalizedPayload.awb, observation.sourceObjectId);
    assert.ok(observation.normalizedPayload.provenance.status);
  }
  for (const job of built.jobs) {
    assert.equal(job.jobKind, "tracking_extract_claims");
    assert.ok(built.observations.some((row) => row.observationId === job.observationId));
    assert.equal(job.sourceObjectId, job.payload.awb);
    assert.equal(job.payload.sourceObservationId, job.observationId);
    assert.equal(job.payload.contentHash,
      built.observations.find((row) => row.observationId === job.observationId).contentHash);
  }

  const healthRows = Object.fromEntries(built.observations.map((row) => [row.sourceObjectId, row.normalizedPayload.sourceHealth]));
  assert.equal(healthRows["01680000143"].status, "no_result");
  assert.equal(healthRows["01680000143"].positiveEvidenceEligible, false);
  assert.equal(healthRows["11480000274"].status, "research_only");
  assert.equal(healthRows["11480000274"].positiveEvidenceEligible, false);
  assert.equal(healthRows["70080000314"].status, "insufficient_research_input");
  assert.equal(healthRows["70080000314"].error,
    "No flight number was available in the TMS detail fields. Search Gmail/pre-alert for the flight before trusting movement state.");

  const reordered = fixtures().reverse().map((snapshot) => {
    const reversed = reverseObjectKeys(snapshot);
    reversed.tracking.reverse();
    return reversed;
  });
  const replay = buildTrackingSourceSnapshot(reordered, reverseObjectKeys(buildOptions));
  assert.deepEqual(replay, built, "provider, row, or object-key order changed deterministic replay");
  const reissuedScope = buildTrackingSourceSnapshot(fixtures(), {
    ...buildOptions,
    scopeToken: `tracking-scope:v1:${"b".repeat(64)}`,
  });
  assert.notEqual(
    reissuedScope.payloadIdentity,
    built.payloadIdentity,
    "scope-token identity must be sealed into the tracking payload identity",
  );
  assert.deepEqual(
    reissuedScope.observations,
    built.observations,
    "scope authorization must not rewrite immutable carrier observations",
  );

  const duplicate = fixtures();
  duplicate[1].tracking[0].awb = duplicate[0].tracking[0].awb;
  const duplicateDiagnostics = inspectTrackingSourceSnapshot(duplicate);
  assert.equal(duplicateDiagnostics.complete, false);
  assert.ok(duplicateDiagnostics.issues.some((item) => item.code === "tracking_awb_duplicate"));
  assert.throws(
    () => buildTrackingSourceSnapshot(duplicate, {
      connectionKey: "carrier-tracking-primary",
      expectedAwbs,
    }),
    (error) => error instanceof TrackingSourceSnapshotError
      && error.code === "TRACKING_SOURCE_SNAPSHOT_INCOMPLETE",
  );

  const incomplete = fixtures();
  incomplete[0].tracking[0].title = "";
  assert.throws(
    () => buildTrackingSourceSnapshot(incomplete, {
      connectionKey: "carrier-tracking-primary",
      expectedAwbs,
    }),
    (error) => error.diagnostics.issues.some((item) => item.code === "direct_tracking_provenance_missing"),
  );

  const missingScope = fixtures();
  missingScope[0].tracking.pop();
  assert.throws(
    () => buildTrackingSourceSnapshot(missingScope, buildOptions),
    (error) => error.diagnostics.issues.some((item) => item.code === "tracking_scope_incomplete"),
  );

  assert.throws(
    () => buildTrackingSourceSnapshot(fixtures(), { connectionKey: "carrier-tracking-primary" }),
    (error) => error instanceof TrackingSourceSnapshotError
      && error.diagnostics.issues.some((item) => item.code === "expected_awbs_missing"),
    "implicit tracking scope must never be inferred from returned rows",
  );
  assert.throws(
    () => buildTrackingSourceSnapshot(fixtures(), {
      connectionKey: "carrier-tracking-primary",
      expectedAwbs,
      scopeToken: "caller-invented-scope",
    }),
    (error) => error instanceof TrackingSourceSnapshotError
      && error.code === "TRACKING_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    "tracking adapter must reject malformed scope-token identities",
  );

  const emptySnapshot = [{
    snapshotTime: "2026-07-09T18:00:00.000Z",
    source: "explicit empty tracking scope verifier",
    recordCount: 0,
    tracking: [],
  }];
  const explicitEmpty = buildTrackingSourceSnapshot(emptySnapshot, {
    connectionKey: "carrier-tracking-empty",
    expectedAwbs: [],
  });
  assert.deepEqual(explicitEmpty.providerManifest.expectedAwbs, []);
  assert.equal(explicitEmpty.providerManifest.recordCount, 0);

  let fetchCalls = 0;
  const priorFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden in tracking source verification");
  };
  try {
    const calls = [];
    const ledger = createSourceSnapshotLedger({
      workspaceKey: "primary",
      sourceSystem: "tracking",
      connectionKey: "carrier-tracking-primary",
      syncToken: "verify-only",
      callRpc: async (rpc, body) => {
        calls.push({ rpc, body });
        assert.equal(rpc, RPC.recoverCommittedSnapshot);
        return { ok: true, found: false, payloadIdentityHash: "a".repeat(64) };
      },
    });
    const receipt = await ledger.recoverCommittedSnapshot({
      nextCursorValue: built.nextCursorValue,
      providerManifest: built.providerManifest,
      observations: built.observations,
      jobs: built.jobs,
    });
    assert.equal(receipt.ok, true);
    assert.equal(calls.length, 1, "generic source ledger did not accept tracking contract");
  } finally {
    global.fetch = priorFetch;
  }
  assert.equal(fetchCalls, 0);

  console.log(JSON.stringify({
    ok: true,
    fixtureRows: built.observations.length,
    healthCounts: built.providerManifest.healthCounts,
    guarantees: [
      "one immutable observation and extraction job per unique AWB",
      "all provider files share one canonical cursor timestamp",
      "direct URL/title/status provenance is mandatory",
      "no-result and research failures remain durable source-health evidence",
      "incomplete or duplicate pulls fail before generic-ledger commit",
      "requested AWB scope is mandatory and independently sealed in the provider manifest",
      "a supplied server-issued scope token is identity-validated and sealed into payload identity",
      "an empty requested scope must be explicit and is never inferred from an empty response",
      "replay is independent of provider, row, and JSON key ordering",
      "adapter performs no network or operational mutation",
    ],
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

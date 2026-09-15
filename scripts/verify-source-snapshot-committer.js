#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { commitBuiltSourceSnapshot } = require("../lib/source-snapshot-committer");

function built(sourceSystem = "tracking") {
  const nextCursorValue = sourceSystem === "operator" ? "42" : "2026-07-09T20:00:00.000Z";
  return {
    sourceSystem,
    workspaceKey: "primary",
    connectionKey: "primary",
    nextCursorValue,
    payloadIdentity: `${sourceSystem}-source-${sourceSystem === "operator" ? "delta" : "snapshot"}:v1:${"a".repeat(64)}`,
    providerManifest: {
      schemaVersion: `${sourceSystem}-fixture-v1`,
      complete: true,
      upstreamWatermark: nextCursorValue,
      sourceSnapshotAt: "2026-07-09T20:00:00.000Z",
      recordCount: 1,
    },
    observations: [{ observationId: `obs:v1:${"b".repeat(64)}` }],
    jobs: [{ dedupeKey: `${sourceSystem}:fixture` }],
    diagnostics: { complete: true },
  };
}

function ledger(options = {}) {
  const calls = [];
  let recoveryCount = 0;
  return {
    calls,
    scope: { workspaceKey: "primary", sourceSystem: options.sourceSystem || "tracking", connectionKey: "primary" },
    async recoverCommittedSnapshot(input) {
      calls.push(["recover", structuredClone(input)]);
      recoveryCount += 1;
      if (options.preflightRecovered || (options.ambiguousRecovered && recoveryCount > 1)) {
        return { ok: true, found: true, batchId: "recovered", committedCursorValue: input.nextCursorValue };
      }
      return { ok: true, found: false };
    },
    async acquireLease(input) {
      calls.push(["lease", structuredClone(input)]);
      return options.lease || { ok: true, status: options.leaseStatus || "live", leaseFence: 3 };
    },
    async beginSnapshotBatch(input) {
      calls.push(["begin", structuredClone(input)]);
      return { ok: true, batchId: "batch-1", status: "running" };
    },
    async commitSnapshotBatch(input) {
      calls.push(["commit", structuredClone(input)]);
      if (options.commitError) throw options.commitError;
      return { ok: true, batchId: "batch-1", committedCursorValue: input.nextCursorValue };
    },
    async failSnapshotBatch(input) {
      calls.push(["fail", structuredClone(input)]);
      return { ok: true, batchId: input.batchId, status: "failed" };
    },
  };
}

async function main() {
  const happyLedger = ledger();
  const happy = await commitBuiltSourceSnapshot({
    builtSnapshot: built(),
    ledger: happyLedger,
    ownerId: "fixture-worker",
    triggerName: "fixture",
  });
  assert.equal(happy.ok, true);
  assert.equal(happy.recovered, false);
  assert.deepEqual(happyLedger.calls.map(([name]) => name), ["recover", "lease", "begin", "commit"]);
  assert.equal(happy.mutatesOperationalState, false);
  assert.equal(happy.reducesTruth, false);
  assert.equal(happy.publishesTruth, false);

  const recoveredLedger = ledger({ preflightRecovered: true });
  const recovered = await commitBuiltSourceSnapshot({
    builtSnapshot: built(),
    ledger: recoveredLedger,
    ownerId: "fixture-worker",
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.recoveryStage, "preflight");
  assert.deepEqual(recoveredLedger.calls.map(([name]) => name), ["recover"]);

  const ambiguousError = Object.assign(new Error("lost response"), {
    code: "SOURCE_SNAPSHOT_LEDGER_INVALID_RECEIPT",
  });
  const ambiguousLedger = ledger({ commitError: ambiguousError, ambiguousRecovered: true });
  const ambiguous = await commitBuiltSourceSnapshot({
    builtSnapshot: built(),
    ledger: ambiguousLedger,
    ownerId: "fixture-worker",
  });
  assert.equal(ambiguous.recovered, true);
  assert.equal(ambiguous.recoveryStage, "ambiguous-commit");
  assert.deepEqual(ambiguousLedger.calls.map(([name]) => name), ["recover", "lease", "begin", "commit", "recover"]);

  const rejectedError = Object.assign(new Error("constraint rejected"), { code: "23514" });
  const rejectedLedger = ledger({ commitError: rejectedError });
  await assert.rejects(
    () => commitBuiltSourceSnapshot({
      builtSnapshot: built(),
      ledger: rejectedLedger,
      ownerId: "fixture-worker",
    }),
    (error) => error === rejectedError && error.failureReceipt?.status === "failed",
  );
  assert.deepEqual(rejectedLedger.calls.map(([name]) => name), ["recover", "lease", "begin", "commit", "fail"]);

  const busyLedger = ledger({ lease: { ok: false, code: "LEASE_BUSY" } });
  await assert.rejects(
    () => commitBuiltSourceSnapshot({
      builtSnapshot: built(),
      ledger: busyLedger,
      ownerId: "fixture-worker",
    }),
    (error) => error?.code === "LEASE_BUSY" && error.retryable === true,
  );
  assert.deepEqual(busyLedger.calls.map(([name]) => name), ["recover", "lease"]);

  const recoveryModeLedger = ledger({ sourceSystem: "operator", leaseStatus: "reconcile_required" });
  await commitBuiltSourceSnapshot({
    builtSnapshot: built("operator"),
    ledger: recoveryModeLedger,
    ownerId: "operator-worker",
    recoveryTriggerName: "operator-recovery",
  });
  assert.equal(recoveryModeLedger.calls.find(([name]) => name === "begin")[1].recoveryMode, true);
  assert.equal(recoveryModeLedger.calls.find(([name]) => name === "begin")[1].triggerName, "operator-recovery");

  const mismatchedLedger = ledger({ sourceSystem: "tms" });
  await assert.rejects(
    () => commitBuiltSourceSnapshot({
      builtSnapshot: built("tracking"),
      ledger: mismatchedLedger,
      ownerId: "fixture-worker",
    }),
    (error) => error?.code === "SOURCE_SNAPSHOT_COMMIT_SCOPE_MISMATCH",
  );
  assert.equal(mismatchedLedger.calls.length, 0);

  await assert.rejects(
    () => commitBuiltSourceSnapshot({
      builtSnapshot: { ...built(), providerManifest: { ...built().providerManifest, recordCount: 0 } },
      ledger: ledger(),
      ownerId: "fixture-worker",
    }),
    (error) => error?.code === "SOURCE_SNAPSHOT_COMMIT_INVALID_ARGUMENT",
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "source-snapshot-committer",
    cases: 8,
    guarantees: [
      "preflight replay recovers without acquiring a duplicate lease",
      "source scope and exact observation/job counts fail closed",
      "cursor and observations commit in one fenced snapshot transaction",
      "ambiguous commits reconcile before any retry",
      "definitive failures create a durable failure witness",
      "the committer never reduces or publishes shipment truth",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

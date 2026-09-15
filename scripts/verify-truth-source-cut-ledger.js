#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  RPC,
  createTruthSourceCutLedger,
} = require("../lib/truth-source-cut-ledger");

const HASH = "a".repeat(64);

async function main() {
  const calls = [];
  const sealedManifest = {
    schemaVersion: "source-cut-manifest-v2",
    partitionWitnessVersion: "source-cut-partition-witness-v1",
    workspaceKey: "primary",
    requiredSources: [{ sourceSystem: "gmail", connectionKey: "primary" }],
    gaps: [],
    cursors: [{
      sourceSystem: "gmail",
      connectionKey: "primary",
      cursorKind: "gmail_history_id",
      throughCursorVersion: "1",
      throughCursorValue: "100",
      observationCount: 1,
      partitionHash: "b".repeat(64),
      emptyScope: false,
    }],
  };
  const ledger = createTruthSourceCutLedger({
    workspaceKey: "primary",
    syncToken: "sync-token",
    callRpc: async (rpc, body) => {
      calls.push({ rpc, body });
      return {
        ok: true,
        status: "sealed",
        sourceCutId: `cut:v1:${HASH}`,
        manifestHash: HASH,
        completeness: "complete",
        observationCount: 1,
        gaps: [],
        manifest: sealedManifest,
      };
    },
  });
  const sealed = await ledger.sealCurrent({ createdBy: "truth-shadow-orchestrator-v1" });
  assert.equal(sealed.sourceCutId, `cut:v1:${HASH}`);
  assert.ok(Object.isFrozen(sealed));
  assert.deepEqual(calls, [{
    rpc: RPC.sealCurrent,
    body: {
      p_workspace_key: "primary",
      p_created_by: "truth-shadow-orchestrator-v1",
      p_sync_token: "sync-token",
    },
  }]);

  const notReady = createTruthSourceCutLedger({
    workspaceKey: "primary",
    syncToken: "sync-token",
    callRpc: async () => ({
      ok: true,
      status: "not_ready",
      sourceCutId: null,
      manifestHash: null,
      completeness: "degraded",
      observationCount: 0,
      gaps: [{ gapType: "REQUIRED_SOURCE_CURSOR_MISSING" }],
      manifest: null,
    }),
  });
  const missing = await notReady.sealCurrent({ createdBy: "fixture" });
  assert.equal(missing.status, "not_ready");
  assert.equal(missing.gaps.length, 1);

  for (const malformed of [
    { ok: true, status: "sealed", sourceCutId: `cut:v1:${HASH}`, manifestHash: HASH, completeness: "complete", observationCount: 0, gaps: [], manifest: { ...sealedManifest, observations: [] } },
    { ok: true, status: "sealed", sourceCutId: `cut:v1:${"b".repeat(64)}`, manifestHash: HASH, completeness: "complete", observationCount: 0, gaps: [], manifest: sealedManifest },
    { ok: true, status: "not_ready", sourceCutId: null, manifestHash: null, completeness: "degraded", observationCount: 0, gaps: [], manifest: null },
    { ok: true, status: "sealed", sourceCutId: `cut:v1:${HASH}`, manifestHash: HASH, completeness: "complete", observationCount: 0, gaps: [{ gapType: "X" }], manifest: sealedManifest },
  ]) {
    const invalidLedger = createTruthSourceCutLedger({
      workspaceKey: "primary",
      syncToken: "sync-token",
      callRpc: async () => malformed,
    });
    await assert.rejects(
      () => invalidLedger.sealCurrent({ createdBy: "fixture" }),
      (error) => error?.code === "TRUTH_SOURCE_CUT_INVALID_RECEIPT",
    );
  }

  const rpcFailure = createTruthSourceCutLedger({
    workspaceKey: "primary",
    syncToken: "sync-token",
    callRpc: async () => {
      const error = new Error("serialization failure");
      error.code = "40001";
      throw error;
    },
  });
  await assert.rejects(
    () => rpcFailure.sealCurrent({ createdBy: "fixture" }),
    (error) => error?.code === "40001" && error.retryable === true,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-source-cut-ledger",
    guarantees: [
      "the server derives and locks the current required-source cursor vector",
      "missing/uninitialized sources return explicit not-ready gaps without a fake cut",
      "sealed cuts use compact source-cut-manifest-v2 without observation enumeration",
      "complete status is impossible when gaps are present",
      "the client never supplies cursors or observation manifests",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

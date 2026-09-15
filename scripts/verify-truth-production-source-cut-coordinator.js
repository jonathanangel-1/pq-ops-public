#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  RPC,
  createTruthProductionSourceCutCoordinator,
} = require("../lib/truth-production-source-cut-coordinator");

const HASH = "a".repeat(64);
const SHADOW_HASH = "b".repeat(64);
const CUT_ID = `cut:v1:${HASH}`;
const SHADOW_CUT_ID = `cut:v1:${SHADOW_HASH}`;
const OBLIGATION_ID = `pending-acceptance-epoch:v1:${"c".repeat(64)}`;
const TOKEN = "sync-token-at-least-sixteen-bytes";

function shadowReceipt() {
  return {
    ok: true,
    status: "degraded",
    sourceCutId: SHADOW_CUT_ID,
    manifestHash: SHADOW_HASH,
    manifest: { schemaVersion: "source-cut-manifest-v2" },
    completeness: "degraded",
    observationCount: 100,
    gaps: [{ gapType: "CANDIDATE_CLAIM_REVIEW_PENDING" }],
    scopeReceiptId: `truth-shadow-root-source-cut:v1:${"d".repeat(64)}`,
    scopeReceiptHash: "e".repeat(64),
    acceptanceEpochManifestHash: "f".repeat(64),
    publicationChannel: "shadow",
    shadowOnly: true,
    productionEligible: false,
    productionPublicationAttempted: false,
    publishesTruth: false,
    performsActions: false,
  };
}

function bridgeReceipt(overrides = {}) {
  return {
    ok: true,
    status: "bridged",
    sourceCutId: CUT_ID,
    productionSourceCutId: CUT_ID,
    shadowSourceCutId: SHADOW_CUT_ID,
    manifestHash: HASH,
    manifest: { schemaVersion: "source-cut-manifest-v2" },
    completeness: "degraded",
    observationCount: 120,
    gaps: [{ gapType: "CANDIDATE_CLAIM_REVIEW_PENDING" }],
    bridgeId: `truth-production-cut-acceptance-bridge:v1:${"1".repeat(64)}`,
    bridgeHash: "2".repeat(64),
    productionEligible: true,
    productionPublicationAttempted: false,
    publishesTruth: false,
    performsActions: false,
    ...overrides,
  };
}

async function main() {
  const calls = [];
  const coordinator = createTruthProductionSourceCutCoordinator({
    workspaceKey: "primary",
    syncToken: TOKEN,
    async callRpc(rpc, body) {
      calls.push([rpc, body]);
      if (rpc === RPC.readHead) return {
        ok: true,
        accepted: true,
        obligationId: OBLIGATION_ID,
        sourceCursorVersion: 10,
      };
      if (rpc === RPC.sealAcceptedGmail) return shadowReceipt();
      if (rpc === RPC.bridgeProduction) return bridgeReceipt();
      throw new Error(`unexpected RPC ${rpc}`);
    },
  });
  const receipt = await coordinator.sealCurrent({ createdBy: "truth-shadow-orchestrator-v1:cron" });
  assert.deepEqual(calls.map(([rpc]) => rpc), [
    RPC.readHead,
    RPC.sealAcceptedGmail,
    RPC.bridgeProduction,
  ]);
  assert.equal(calls[1][1].p_obligation_id, OBLIGATION_ID);
  assert.equal(calls[2][1].p_shadow_source_cut_id, SHADOW_CUT_ID);
  assert.equal(receipt.status, "sealed");
  assert.equal(receipt.bridgeStatus, "bridged");
  assert.equal(receipt.sourceCutId, CUT_ID);
  assert.equal(receipt.productionSourceCutId, CUT_ID);
  assert.equal(receipt.shadowSourceCutId, SHADOW_CUT_ID);
  assert.equal(receipt.productionEligible, true);
  assert.equal(receipt.productionPublicationAttempted, false);

  let unavailableCalls = 0;
  const unavailable = createTruthProductionSourceCutCoordinator({
    syncToken: TOKEN,
    async callRpc() {
      unavailableCalls += 1;
      return { ok: true, accepted: false, obligationId: "", sourceCursorVersion: 11 };
    },
  });
  const unavailableReceipt = await unavailable.sealCurrent({ createdBy: "test" });
  assert.equal(unavailableCalls, 1);
  assert.equal(unavailableReceipt.status, "not_ready");
  assert.equal(unavailableReceipt.sourceCutId, null);
  assert.equal(unavailableReceipt.gaps[0].gapType, "GMAIL_ACCEPTED_HEAD_UNAVAILABLE");

  const malformed = createTruthProductionSourceCutCoordinator({
    syncToken: TOKEN,
    async callRpc(rpc) {
      if (rpc === RPC.readHead) return { ok: true, accepted: true, obligationId: OBLIGATION_ID };
      if (rpc === RPC.sealAcceptedGmail) return shadowReceipt();
      return bridgeReceipt({ productionEligible: false });
    },
  });
  await assert.rejects(
    () => malformed.sealCurrent({ createdBy: "test" }),
    (error) => error?.code === "TRUTH_PRODUCTION_SOURCE_CUT_INVALID_RECEIPT"
      && error.stage === "production_bridge",
  );

  assert.throws(
    () => createTruthProductionSourceCutCoordinator({ workspaceKey: "foreign", syncToken: TOKEN, callRpc() {} }),
    (error) => error?.code === "TRUTH_PRODUCTION_SOURCE_CUT_INVALID_ARGUMENT",
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-production-source-cut-coordinator",
    exactAcceptedGmailHeadRequired: true,
    exactFourSourceBridgeRequired: true,
    documentedDegradedCutReturned: true,
    productionPublicationAttempted: false,
    performsActions: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

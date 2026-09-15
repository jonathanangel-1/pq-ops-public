#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  _test: {
    lateAcceptanceRetryDelayMs,
    rpcTimeoutMs,
    runLateModelAcceptance,
  },
} = require("./run-local-truth-gmail-slice");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = "primary";
const CONNECTION = "shadow-current-awbs-20260710-c475a8ca";
const ROOT_BATCH = "cd12fa59-d02b-462b-a9c8-ed11f93e41f4";

function hash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function succeededReceipt() {
  const lateAcceptanceReceiptHash = hash("late-model-acceptance-receipt");
  return {
    ok: true,
    status: "succeeded",
    lateAcceptanceId: `truth-shadow-late-model-acceptance:v1:${lateAcceptanceReceiptHash}`,
    lateAcceptanceReceiptHash,
    predecessorEpochId: `truth-shadow-acceptance-epoch:v1:${hash("predecessor-epoch")}`,
    authorizationCount: 10,
    candidateCount: 4,
    acceptedCount: 3,
    rejectedCount: 1,
    shadowOnly: true,
    publicationChannel: "shadow",
    publishesTruth: false,
    productionPublicationAttempted: false,
  };
}

function context(receipts, overrides = {}) {
  const calls = [];
  const waits = [];
  return {
    calls,
    waits,
    ctx: {
      reviewToken: "review-token",
      syncToken: "sync-token",
      random: () => 0.5,
      async wait(delayMs) {
        waits.push(delayMs);
      },
      async callRpc(rpc, body, options) {
        calls.push({ rpc, body, options });
        assert.equal(rpc, "run_truth_shadow_late_model_acceptance");
        assert.deepEqual(body, {
          p_workspace_key: WORKSPACE,
          p_connection_key: CONNECTION,
          p_root_batch_id: ROOT_BATCH,
          p_review_token: "review-token",
          p_sync_token: "sync-token",
        });
        assert.deepEqual(options, { timeoutMs: 300000 });
        assert.ok(receipts.length > 0, "late-model acceptance made an unexpected RPC");
        return receipts.shift();
      },
      ...overrides,
    },
  };
}

async function main() {
  assert.equal(rpcTimeoutMs("run_truth_shadow_late_model_acceptance"), 300000);
  assert.equal(rpcTimeoutMs("create_truth_shadow_stale_gmail_model_review"), 120000);
  assert.equal(lateAcceptanceRetryDelayMs(1, () => 0.5), 375);
  assert.equal(lateAcceptanceRetryDelayMs(2, () => 0.5), 625);
  assert.equal(lateAcceptanceRetryDelayMs(50, () => 1), 5250);

  const immediate = context([succeededReceipt()]);
  const immediateReceipt = await runLateModelAcceptance(immediate.ctx, 3);
  assert.equal(immediateReceipt.status, "succeeded");
  assert.equal(immediateReceipt.attempts.length, 1);
  assert.equal(immediate.calls.length, 1);
  assert.deepEqual(immediate.waits, []);

  const retried = context([
    {
      ok: true,
      status: "busy",
      retryable: true,
      reason: "SOURCE_CUT_SERIALIZATION_BUSY",
      productionPublicationAttempted: false,
    },
    {
      ok: true,
      status: "busy",
      retryable: true,
      reason: "SOURCE_CUT_SERIALIZATION_BUSY",
      productionPublicationAttempted: false,
    },
    succeededReceipt(),
  ]);
  const retriedReceipt = await runLateModelAcceptance(retried.ctx, 3);
  assert.equal(retriedReceipt.attempts.length, 3);
  assert.deepEqual(retried.waits, [375, 625]);

  const notReady = context([{
    ok: false,
    status: "not_ready",
    reason: "LATE_MODEL_CHILD_FRONTIER_OPEN",
    productionPublicationAttempted: false,
  }]);
  await assert.rejects(
    () => runLateModelAcceptance(notReady.ctx, 5),
    (error) => error.code === "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_NOT_READY"
      && error.receipt.reason === "LATE_MODEL_CHILD_FRONTIER_OPEN",
  );
  assert.equal(notReady.calls.length, 1);
  assert.deepEqual(notReady.waits, []);

  const boundedBusy = context([{
    ok: true,
    status: "busy",
    retryable: true,
    productionPublicationAttempted: false,
  }]);
  await assert.rejects(
    () => runLateModelAcceptance(boundedBusy.ctx, 1),
    (error) => error.code === "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_BUSY",
  );
  assert.deepEqual(boundedBusy.waits, []);

  const unsafe = context([{ ...succeededReceipt(), productionPublicationAttempted: true }]);
  await assert.rejects(
    () => runLateModelAcceptance(unsafe.ctx, 1),
    (error) => error.code === "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_UNSAFE",
  );

  const invalid = context([{ ...succeededReceipt(), publicationChannel: "production" }]);
  await assert.rejects(
    () => runLateModelAcceptance(invalid.ctx, 1),
    (error) => error.code === "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_INVALID",
  );

  const source = fs.readFileSync(path.join(ROOT, "scripts/run-local-truth-gmail-slice.js"), "utf8");
  assert.match(source, /phase === "late-model-acceptance"/);
  assert.match(source, /reviewRequired: modelOn \|\| modelFreeAuthorityPhase/);
  assert.match(source, /if \(modelFreeAuthorityPhase && modelOn\)/);
  assert.doesNotMatch(source, /LATE_MODEL_ACCEPTANCE_RPC[\s\S]{0,200}shipment-truth-packets/);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-shadow-late-model-cli",
    checks: [
      "exact scope, review-token, and sync-token RPC binding",
      "300-second client deadline",
      "bounded busy retry with exponential backoff and jitter",
      "not-ready fail-closed handling",
      "immutable receipt identity and shadow-only guard",
      "model-free phase wiring",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

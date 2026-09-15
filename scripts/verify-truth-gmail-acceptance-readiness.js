"use strict";
// Fixture verifier for the hosted acceptance coordinator: ready batch runs
// acceptance (reviews queue, nothing force-accepted), busy skips, not-ready
// skips, already-accepted skips, publication contract enforced, only the two
// declared RPCs ever called.
const assert = require("node:assert");
const {
  createGmailAcceptanceReadinessCoordinator,
  RECONCILE_RPC,
  FRONTIER_RPC,
  ACCEPTANCE_RPC,
} = require("../lib/truth-gmail-acceptance-readiness");

const WS = "primary", CONN = "primary", SYNC = "sync-fixture";
const B = (n) => `52450391-0fd3-4f9b-898a-a908e8ef097${n}`;
const OB = (n) => "pending-acceptance-epoch:v1:" + String(n).repeat(64);

(async () => {
  const calls = [];
  const callRpc = async (rpc, body) => {
    calls.push(rpc);
    assert.ok([RECONCILE_RPC, FRONTIER_RPC, ACCEPTANCE_RPC].includes(rpc), "unexpected rpc " + rpc);
    if (rpc === RECONCILE_RPC) {
      return { ok: true, reconciledCount: 0, items: [], productionPublicationAttempted: false };
    }
    if (rpc === FRONTIER_RPC) {
      return { ok: true, productionPublicationAttempted: false, batches: [
        { rootBatchId: B(1), obligationId: OB(1), acceptanceComplete: false, readyToRun: true },
        { rootBatchId: B(2), obligationId: OB(2), acceptanceComplete: false, readyToRun: true },
        { rootBatchId: B(3), obligationId: null, acceptanceComplete: false, readyToRun: false },
        { rootBatchId: B(4), obligationId: OB(4), acceptanceComplete: true, readyToRun: false },
      ] };
    }
    if (body.p_obligation_id === OB(1)) {
      return { status: "succeeded", acceptedCount: 5, rejectedCount: 1, reviewCount: 2, productionPublicationAttempted: false };
    }
    return { status: "busy", retryable: true, productionPublicationAttempted: false };
  };
  const c = createGmailAcceptanceReadinessCoordinator({ workspaceKey: WS, connectionKey: CONN, syncToken: SYNC, callRpc, batchLimit: 4 });
  const r = await c.runOnce();
  assert.equal(r.claimedCount, 1);
  assert.deepEqual(r.actions[0], { rootBatchId: B(1), obligationId: OB(1), acceptedCount: 5, rejectedCount: 1, reviewCount: 2 });
  assert.deepEqual(r.skips.map(s => s.reasonCode).sort(), ["ALREADY_ACCEPTED", "NOT_READY", "SERIALIZATION_BUSY"]);
  assert.equal(r.failedCount, 0);
  assert.equal(r.productionPublicationAttempted, false);

  // Publication-contract violation is a recorded failure, not silent.
  const bad = createGmailAcceptanceReadinessCoordinator({ workspaceKey: WS, connectionKey: CONN, syncToken: SYNC,
    callRpc: async (rpc) => {
      if (rpc === RECONCILE_RPC) {
        return { ok: true, reconciledCount: 0, items: [], productionPublicationAttempted: false };
      }
      return rpc === FRONTIER_RPC
        ? { ok: true, productionPublicationAttempted: false, batches: [{ rootBatchId: B(5), obligationId: OB(5), acceptanceComplete: false, readyToRun: true }] }
        : { status: "succeeded", productionPublicationAttempted: true };
    } });
  const rb = await bad.runOnce();
  assert.equal(rb.failedCount, 1);
  assert.equal(rb.failures[0].errorCode, "TRUTH_GMAIL_ACCEPTANCE_PUBLICATION_CONTRACT_VIOLATED");

  // Contract refusals.
  let threw = 0;
  try { createGmailAcceptanceReadinessCoordinator({ workspaceKey: WS, connectionKey: CONN, syncToken: SYNC }); } catch { threw++; }
  const badFrontier = createGmailAcceptanceReadinessCoordinator({ workspaceKey: WS, connectionKey: CONN, syncToken: SYNC,
    callRpc: async (rpc) => rpc === RECONCILE_RPC
      ? { ok: true, reconciledCount: 0, items: [], productionPublicationAttempted: false }
      : { ok: true, batches: [], productionPublicationAttempted: true } });
  try { await badFrontier.runOnce(); } catch (e) { assert.equal(e.code, "TRUTH_GMAIL_ACCEPTANCE_READINESS_FRONTIER_INVALID"); threw++; }
  assert.equal(threw, 2);

  console.log(JSON.stringify({ ok: true, verifier: "truth-gmail-acceptance-readiness",
    checks: ["ready batch accepted w/ review queue counts", "busy/not-ready/already skips", "publication contract enforced", "callRpc + frontier contract refusals"] }, null, 2));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

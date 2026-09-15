"use strict";

// Fixture verifier for the hosted claims-readiness coordinator. Mocks callRpc
// and walks the full ladder the way live ticks will: checkpoint not_ready ->
// checkpoint -> epoch open -> seal refused while links run -> seal. Proves
// worker-receipt shape, bounded batches, fail-soft per-batch errors, and that
// no RPC outside the declared four is ever invoked.

const assert = require("node:assert");
const {
  createGmailClaimsReadinessCoordinator,
  RECONCILE_RPC,
  FRONTIER_RPC,
  CHECKPOINT_RPC,
  EPOCH_OPEN_RPC,
  EPOCH_SEAL_RPC,
} = require("../lib/truth-gmail-claims-readiness");

const WS = "primary";
const CONN = "primary";
const SYNC = "sync-token-fixture";
const B1 = "52450391-0fd3-4f9b-898a-a908e8ef0975";
const B2 = "934afcb0-dd5c-4744-af36-45a4b964bda1";
const B3 = "ed182ab6-f224-4d46-b9dc-192b6e866f78";

function frontierReceipt(batches) {
  return { ok: true, batches, productionPublicationAttempted: false };
}

function reconciliationReceipt(items = []) {
  return { ok: true, reconciledCount: items.length, items, productionPublicationAttempted: false };
}

async function scenarioFullLadder() {
  const calls = [];
  // Simulated evolving server state across rounds.
  const state = {
    [B1]: { checkpointPresent: false, checkpointReady: false, epochId: null, epochSealed: false, readyToSeal: false, checkpointAttempts: 0 },
  };
  const callRpc = async (rpc, body) => {
    calls.push([rpc, body]);
    assert.ok([RECONCILE_RPC, FRONTIER_RPC, CHECKPOINT_RPC, EPOCH_OPEN_RPC, EPOCH_SEAL_RPC].includes(rpc), `unexpected rpc ${rpc}`);
    if (rpc === RECONCILE_RPC) return reconciliationReceipt();
    if (rpc === FRONTIER_RPC) {
      assert.equal(body.p_workspace_key, WS);
      assert.equal(body.p_connection_key, CONN);
      assert.equal(body.p_sync_token, SYNC);
      const s = state[B1];
      return frontierReceipt([{ rootBatchId: B1, ...s }]);
    }
    if (rpc === CHECKPOINT_RPC) {
      const s = state[B1];
      s.checkpointAttempts += 1;
      if (s.checkpointAttempts === 1) return { status: "not_ready", reasonCode: "FULL_MAILBOX_PROCESSING_EPOCH_REQUIRED" };
      s.checkpointPresent = true;
      s.checkpointReady = true;
      return {
        status: "ready",
        checkpointId: `gmail-parse-checkpoint:v1:${"a".repeat(64)}`,
        checkpointHash: "a".repeat(64),
      };
    }
    if (rpc === EPOCH_OPEN_RPC) {
      assert.equal(body.p_root_batch_id, B1);
      state[B1].epochId = "gmail-link-epoch:v1:aaaa";
      return { ok: true, epochId: state[B1].epochId };
    }
    if (rpc === EPOCH_SEAL_RPC) {
      assert.equal(body.p_epoch_id, "gmail-link-epoch:v1:aaaa");
      state[B1].epochSealed = true;
      return { ok: true, sealed: true };
    }
    throw new Error("unreachable");
  };

  const coordinator = createGmailClaimsReadinessCoordinator({
    workspaceKey: WS, connectionKey: CONN, syncToken: SYNC, callRpc,
  });

  // Round 1: checkpoint refused (parked-history boundary not yet accepted) -> recorded skip, drained.
  let r = await coordinator.runOnce();
  assert.equal(r.claimedCount, 0);
  assert.equal(r.skips.length, 1);
  assert.equal(r.skips[0].reasonCode, "FULL_MAILBOX_PROCESSING_EPOCH_REQUIRED");
  assert.equal(r.drained, true);

  // Round 2: checkpoint succeeds.
  r = await coordinator.runOnce();
  assert.deepEqual(r.actions.map((a) => a.step), ["checkpoint"]);
  assert.equal(r.drained, false);

  // Round 3: epoch opens.
  r = await coordinator.runOnce();
  assert.deepEqual(r.actions.map((a) => a.step), ["epoch_open"]);

  // Round 4: links still running -> seal refused as a skip, drained this round.
  r = await coordinator.runOnce();
  assert.equal(r.claimedCount, 0);
  assert.equal(r.skips[0].reasonCode, "LINK_JOBS_NOT_TERMINAL");

  // Links finish; round 5 seals.
  state[B1].readyToSeal = true;
  r = await coordinator.runOnce();
  assert.deepEqual(r.actions.map((a) => a.step), ["epoch_seal"]);

  // Round 6: nothing left.
  r = await coordinator.runOnce();
  assert.equal(r.claimedCount, 0);
  assert.equal(r.skips[0].reasonCode, "ALREADY_SEALED");
  assert.equal(r.productionPublicationAttempted, false);
  assert.equal(r.mutatesOperationalState, false);

  const mutationCalls = calls.filter(([rpc]) => ![RECONCILE_RPC, FRONTIER_RPC].includes(rpc));
  assert.deepEqual(mutationCalls.map(([rpc]) => rpc), [CHECKPOINT_RPC, CHECKPOINT_RPC, EPOCH_OPEN_RPC, EPOCH_SEAL_RPC]);
  return "full ladder: refusal-skip, checkpoint, open, seal-when-ready, terminal drain";
}

async function scenarioFailSoftAndBounds() {
  const callRpc = async (rpc) => {
    if (rpc === RECONCILE_RPC) return reconciliationReceipt();
    if (rpc === FRONTIER_RPC) {
      return frontierReceipt([
        { rootBatchId: B1, checkpointPresent: true, checkpointReady: true, epochId: null, epochSealed: false, readyToSeal: false },
        { rootBatchId: B2, checkpointPresent: true, checkpointReady: true, epochId: null, epochSealed: false, readyToSeal: false },
        { rootBatchId: B3, checkpointPresent: true, checkpointReady: true, epochId: "gmail-link-epoch:v1:cccc", epochSealed: false, readyToSeal: true },
      ]);
    }
    if (rpc === EPOCH_OPEN_RPC) {
      const err = new Error("sealed Gmail parent extraction plan conflicts with retry input");
      err.code = "23505";
      throw err;
    }
    if (rpc === EPOCH_SEAL_RPC) return { ok: true };
    throw new Error("unexpected rpc " + rpc);
  };
  const coordinator = createGmailClaimsReadinessCoordinator({
    workspaceKey: WS, connectionKey: CONN, syncToken: SYNC, callRpc, batchLimit: 3,
  });
  const r = await coordinator.runOnce();
  // Two open failures recorded per-batch; the third batch still seals.
  assert.equal(r.failedCount, 2);
  assert.equal(r.claimedCount, 3);
  assert.equal(r.failures[0].errorCode, "23505");
  assert.deepEqual(r.actions.map((a) => a.step), ["epoch_seal"]);
  assert.equal(r.drained, false);
  return "fail-soft: per-batch errors recorded, remaining batches still advance";
}

async function scenarioContractRefusals() {
  let threw = 0;
  try {
    createGmailClaimsReadinessCoordinator({ workspaceKey: WS, connectionKey: CONN, syncToken: SYNC });
  } catch (error) {
    assert.match(String(error.message), /callRpc/);
    threw += 1;
  }
  const badFrontier = createGmailClaimsReadinessCoordinator({
    workspaceKey: WS, connectionKey: CONN, syncToken: SYNC,
    callRpc: async (rpc) => rpc === RECONCILE_RPC
      ? reconciliationReceipt()
      : ({ ok: true, batches: [], productionPublicationAttempted: true }),
  });
  try {
    await badFrontier.runOnce();
  } catch (error) {
    assert.equal(error.code, "TRUTH_GMAIL_CLAIMS_READINESS_FRONTIER_INVALID");
    threw += 1;
  }
  assert.equal(threw, 2);
  return "contract: callRpc required; frontier receipts validated incl. publication flag";
}

async function scenarioDeadLinkReconciliationPrecedesFrontier() {
  const calls = [];
  const coordinator = createGmailClaimsReadinessCoordinator({
    workspaceKey: WS, connectionKey: CONN, syncToken: SYNC,
    callRpc: async (rpc) => {
      calls.push(rpc);
      if (rpc === RECONCILE_RPC) return reconciliationReceipt([
        { rootBatchId: B1, disposition: "missing_anchor_excluded" },
      ]);
      if (rpc === FRONTIER_RPC) return frontierReceipt([
        { rootBatchId: B1, checkpointPresent: true, checkpointReady: true, epochId: "gmail-link-epoch:v1:aaaa", epochSealed: false, readyToSeal: true },
      ]);
      if (rpc === EPOCH_SEAL_RPC) return { ok: true, productionPublicationAttempted: false };
      throw new Error(`unexpected rpc ${rpc}`);
    },
  });
  const receipt = await coordinator.runOnce();
  assert.deepEqual(calls, [RECONCILE_RPC, FRONTIER_RPC, EPOCH_SEAL_RPC]);
  assert.deepEqual(receipt.actions.map((item) => item.step), ["dead_link_reconcile", "epoch_seal"]);
  assert.equal(receipt.claimedCount, 2);
  assert.equal(receipt.productionPublicationAttempted, false);
  return "dead-link reconciliation: proof-bound disposition runs before the frontier and seal";
}

async function scenarioExistingCheckpointGapDrains() {
  const calls = [];
  const coordinator = createGmailClaimsReadinessCoordinator({
    workspaceKey: WS, connectionKey: CONN, syncToken: SYNC,
    callRpc: async (rpc) => {
      calls.push(rpc);
      if (rpc === RECONCILE_RPC) return reconciliationReceipt();
      if (rpc === FRONTIER_RPC) return frontierReceipt([{
        rootBatchId: B1,
        checkpointPresent: true,
        checkpointReady: false,
        epochId: null,
        epochSealed: false,
        readyToSeal: false,
      }]);
      throw new Error(`unexpected rpc ${rpc}`);
    },
  });
  const receipt = await coordinator.runOnce();
  assert.deepEqual(calls, [RECONCILE_RPC, FRONTIER_RPC]);
  assert.equal(receipt.claimedCount, 0);
  assert.equal(receipt.drained, true);
  assert.equal(receipt.skips[0].reasonCode, "CHECKPOINT_TERMINAL_GAPS");
  return "present checkpoint gap: named skip drains without idempotent re-ensure";
}

async function scenarioMalformedCheckpointRefused() {
  const coordinator = createGmailClaimsReadinessCoordinator({
    workspaceKey: WS, connectionKey: CONN, syncToken: SYNC,
    callRpc: async (rpc) => {
      if (rpc === RECONCILE_RPC) return reconciliationReceipt();
      if (rpc === FRONTIER_RPC) return frontierReceipt([{
        rootBatchId: B1,
        checkpointPresent: false,
        checkpointReady: false,
        epochId: null,
        epochSealed: false,
        readyToSeal: false,
      }]);
      if (rpc === CHECKPOINT_RPC) return { status: "ready", checkpointId: "wrong" };
      throw new Error(`unexpected rpc ${rpc}`);
    },
  });
  const receipt = await coordinator.runOnce();
  assert.equal(receipt.claimedCount, 1);
  assert.equal(receipt.failedCount, 1);
  assert.equal(receipt.failures[0].errorCode, "TRUTH_GMAIL_CLAIMS_READINESS_CHECKPOINT_INVALID");
  return "checkpoint receipt: malformed ready identity becomes a reconciled worker failure";
}

(async () => {
  const results = [];
  results.push(await scenarioFullLadder());
  results.push(await scenarioFailSoftAndBounds());
  results.push(await scenarioContractRefusals());
  results.push(await scenarioDeadLinkReconciliationPrecedesFrontier());
  results.push(await scenarioExistingCheckpointGapDrains());
  results.push(await scenarioMalformedCheckpointRefused());
  console.log(JSON.stringify({ ok: true, verifier: "truth-gmail-claims-readiness", checks: results }, null, 2));
})().catch((error) => {
  console.error("verify:truth-gmail-claims-readiness FAILED:", error.message);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  RPC,
  createTruthTrackingScopeLedger,
} = require("../lib/truth-tracking-scope-ledger");

const TOKEN = `tracking-scope:v1:${"a".repeat(64)}`;
const RECEIPT = {
  ok: true,
  schemaVersion: "truth-tracking-scope-receipt-v1",
  scopeToken: TOKEN,
  workspaceKey: "primary",
  tmsConnectionKey: "couriercloud-ops-tlv-us",
  trackingConnectionKey: "carrier-tracking-primary",
  tmsCursorVersion: 4,
  tmsCursorValue: "2026-07-09T20:00:00.000Z",
  expectedAwbs: ["01680000083", "11480000300"],
  expectedAwbCount: 2,
  expectedAwbsHash: "b".repeat(64),
  issuedAt: "2026-07-09T20:00:01.000Z",
  expiresAt: "2026-07-09T20:15:01.000Z",
};

async function main() {
  const calls = [];
  const ledger = createTruthTrackingScopeLedger({
    workspaceKey: "primary",
    syncToken: "sync-token",
    callRpc: async (rpc, body) => {
      calls.push({ rpc, body });
      return RECEIPT;
    },
  });
  const issued = await ledger.issue({ issuedBy: "tracking-collector", ttlSeconds: 900 });
  assert.deepEqual(issued.expectedAwbs, RECEIPT.expectedAwbs);
  assert.ok(Object.isFrozen(issued));
  const read = await ledger.read({ scopeToken: TOKEN });
  assert.equal(read.scopeToken, TOKEN);
  assert.deepEqual(calls, [{
    rpc: RPC.issue,
    body: {
      p_workspace_key: "primary",
      p_ttl_seconds: 900,
      p_issued_by: "tracking-collector",
      p_sync_token: "sync-token",
    },
  }, {
    rpc: RPC.read,
    body: {
      p_workspace_key: "primary",
      p_scope_token: TOKEN,
      p_sync_token: "sync-token",
    },
  }]);

  for (const invalidReceipt of [
    { ...RECEIPT, expectedAwbs: [...RECEIPT.expectedAwbs].reverse() },
    { ...RECEIPT, expectedAwbCount: 1 },
    { ...RECEIPT, scopeToken: "caller-supplied" },
    { ...RECEIPT, expiresAt: RECEIPT.issuedAt },
  ]) {
    const invalid = createTruthTrackingScopeLedger({
      workspaceKey: "primary",
      syncToken: "sync-token",
      callRpc: async () => invalidReceipt,
    });
    await assert.rejects(
      () => invalid.issue({ issuedBy: "fixture" }),
      (error) => error?.code === "TRUTH_TRACKING_SCOPE_INVALID_RECEIPT",
    );
  }

  await assert.rejects(
    () => ledger.read({ scopeToken: `tracking-scope:v1:${"z".repeat(64)}` }),
    (error) => error?.code === "TRUTH_TRACKING_SCOPE_INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => ledger.issue({ issuedBy: "fixture", ttlSeconds: 10 }),
    (error) => error?.code === "TRUTH_TRACKING_SCOPE_INVALID_ARGUMENT",
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-tracking-scope-ledger",
    guarantees: [
      "expected AWBs come from a server-issued TMS cursor-bound scope",
      "scope receipts are exact, sorted, unique, bounded, and expiring",
      "the tracking collector cannot substitute a caller-chosen scope token",
      "a stale TMS cursor makes the issued scope unusable",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

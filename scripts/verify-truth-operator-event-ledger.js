#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  RPC,
  createTruthOperatorEventLedger,
} = require("../lib/truth-operator-event-ledger");

const WORKSPACE = "primary";
const CONNECTION = "operator-phone-primary";
const TOKEN = "operator-event-ledger-sync-token";
const KEY = "A".repeat(32);

function receipt(overrides = {}) {
  return {
    ok: true,
    schemaVersion: "truth-operator-event-receipt-v1",
    status: "recorded",
    requestId: `operator-request:v1:${"1".repeat(64)}`,
    requestHash: "2".repeat(64),
    workspaceKey: WORKSPACE,
    sourceSystem: "operator",
    connectionKey: CONNECTION,
    eventId: `operator-event:v1:${"3".repeat(64)}`,
    eventSequence: "1",
    observationId: `obs:v1:${"4".repeat(64)}`,
    jobId: "10000000-0000-4000-8000-000000000001",
    batchId: "10000000-0000-4000-8000-000000000002",
    sourceCursorVersion: 1,
    capturedAt: "2026-07-09T15:00:00.000Z",
    mutatesOperationalState: false,
    reducesTruth: false,
    publishesTruth: false,
    ...overrides,
  };
}

async function main() {
  const calls = [];
  const ledger = createTruthOperatorEventLedger({
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
    syncToken: TOKEN,
    callRpc: async (rpc, body, options) => {
      calls.push({ rpc, body, options });
      return receipt();
    },
    rpcOptions: { timeoutMs: 5000 },
  });
  const request = { schemaVersion: "operator-truth-event-request-v1", eventType: "assertion" };
  const result = await ledger.record({ idempotencyKey: KEY, request });
  assert.deepEqual(ledger.scope, {
    workspaceKey: WORKSPACE,
    sourceSystem: "operator",
    connectionKey: CONNECTION,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rpc, RPC.record);
  assert.deepEqual(calls[0].body, {
    p_workspace_key: WORKSPACE,
    p_connection_key: CONNECTION,
    p_idempotency_key: KEY,
    p_request: request,
    p_sync_token: TOKEN,
  });
  assert.deepEqual(calls[0].options, { timeoutMs: 5000 });

  await assert.rejects(
    ledger.record({ idempotencyKey: "weak", request }),
    (error) => error?.code === "TRUTH_OPERATOR_EVENT_LEDGER_INVALID_ARGUMENT",
  );
  await assert.rejects(
    ledger.record({ idempotencyKey: KEY, request: { value: "x".repeat(33000) } }),
    (error) => error?.code === "TRUTH_OPERATOR_EVENT_LEDGER_INVALID_ARGUMENT",
  );

  const wrongScope = createTruthOperatorEventLedger({
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
    syncToken: TOKEN,
    callRpc: async () => receipt({ connectionKey: "caller-invented" }),
  });
  await assert.rejects(
    wrongScope.record({ idempotencyKey: KEY, request }),
    (error) => error?.code === "TRUTH_OPERATOR_EVENT_LEDGER_INVALID_RECEIPT",
  );

  const transport = createTruthOperatorEventLedger({
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
    syncToken: TOKEN,
    callRpc: async () => {
      const error = new Error("network timeout after commit");
      error.status = 504;
      throw error;
    },
  });
  await assert.rejects(
    transport.record({ idempotencyKey: KEY, request }),
    (error) => error?.retryable === true
      && error?.outcomeUnknown === true
      && error?.safeToRetryWithSameIdempotencyKey === true,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-event-ledger",
    checks: 14,
    guarantees: [
      "the RPC scope and sync token are server-owned ledger configuration",
      "only strong bounded idempotency keys and bounded JSON requests are sent",
      "receipts must prove the exact operator workspace/connection and no action/publication side effects",
      "ambiguous transport failures are explicitly safe only for same-key retry",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

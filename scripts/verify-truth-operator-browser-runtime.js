#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { REGISTRY } = require("../lib/truth-predicate-registry");
const {
  COMMAND_SCHEMA_VERSION,
  TruthOperatorBrowserRuntimeError,
  createTruthOperatorBrowserRuntime,
  normalizeCommand,
  _test,
} = require("../lib/truth-operator-browser-runtime");

const PARENT_KEY = "browser-operation-parent-key-000001";
const RECORDED_BY = { operatorId: "operator:alex", name: "Alex Morgan" };

function command(overrides = {}) {
  return {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    command: "delivery_completed_with_pod",
    subject: { awb: "01680000156" },
    occurredAt: "2026-07-09T15:00:00.000Z",
    contact: { name: "Jeff", organization: "Juniper Logistics" },
    reference: { proof: "Phone call at 11:00 ET", note: "Receiver signed." },
    ...overrides,
  };
}

async function main() {
  const calls = [];
  const runtime = createTruthOperatorBrowserRuntime({
    recordedBy: RECORDED_BY,
    runtime: {
      record: async (input) => {
        calls.push(input);
        return {
          eventId: `operator-event:v1:${String(calls.length).repeat(64)}`,
          eventSequence: String(calls.length),
          observationId: `obs:v1:${String(calls.length + 2).repeat(64)}`,
        };
      },
    },
  });
  const result = await runtime.recordCommand({ idempotencyKey: PARENT_KEY, command: command() });
  assert.equal(result.status, "recorded");
  assert.equal(result.assertionCount, 2);
  assert.equal(result.mutatesOperationalState, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.assertion.predicate, "delivery_completed");
  assert.equal(calls[0].request.assertion.polarity, "positive");
  assert.equal(calls[1].request.assertion.predicate, "pod_received");
  assert.equal(calls[1].request.assertion.polarity, "positive");
  for (const call of calls) {
    assert.deepEqual(call.request.recordedBy, RECORDED_BY, "browser must not supply operator identity");
    assert.equal(call.request.contact.channel, "phone");
    assert.equal(call.request.assertion.contractVersion, REGISTRY.registryVersion);
    assert.deepEqual(Object.keys(call.request.assertion.value).sort(), ["effect", "status"]);
    assert.match(call.idempotencyKey, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);

  const replayCalls = [];
  const replayRuntime = createTruthOperatorBrowserRuntime({
    recordedBy: RECORDED_BY,
    runtime: { record: async (input) => { replayCalls.push(input); return { eventId: "replay" }; } },
  });
  await replayRuntime.recordCommand({ idempotencyKey: PARENT_KEY, command: command() });
  assert.deepEqual(
    replayCalls.map((item) => item.idempotencyKey),
    calls.map((item) => item.idempotencyKey),
    "same parent operation must derive the same child idempotency keys",
  );
  assert.deepEqual(replayCalls.map((item) => item.request), calls.map((item) => item.request));

  const feeCalls = [];
  await createTruthOperatorBrowserRuntime({
    recordedBy: RECORDED_BY,
    runtime: { record: async (input) => { feeCalls.push(input); return { ok: true }; } },
  }).recordCommand({
    idempotencyKey: "fee-operation-parent-key-00000001",
    command: command({ command: "station_fees_paid" }),
  });
  assert.deepEqual(feeCalls.map((item) => [item.request.assertion.predicate, item.request.assertion.polarity]), [
    ["station_fees_due", "negative"],
    ["station_fees_paid", "positive"],
  ]);

  assert.throws(
    () => normalizeCommand(command({ command: "broker_approved" })),
    /not a supported structured phone-truth command/,
  );
  assert.throws(
    () => normalizeCommand({ ...command(), recordedBy: RECORDED_BY }),
    /must contain exactly/,
    "caller-supplied identity must be rejected as an extra field",
  );
  assert.throws(
    () => normalizeCommand(command({ subject: { awb: "016-80000156" } })),
    /too long|eleven digits/,
  );

  const partialCalls = [];
  const partialRuntime = createTruthOperatorBrowserRuntime({
    recordedBy: RECORDED_BY,
    runtime: {
      record: async (input) => {
        partialCalls.push(input);
        if (partialCalls.length === 2) {
          const error = new Error("timeout after commit");
          error.retryable = true;
          error.outcomeUnknown = true;
          throw error;
        }
        return { eventId: "first-recorded" };
      },
    },
  });
  await assert.rejects(
    partialRuntime.recordCommand({ idempotencyKey: PARENT_KEY, command: command() }),
    (error) => {
      assert.ok(error instanceof TruthOperatorBrowserRuntimeError);
      assert.equal(error.code, "TRUTH_OPERATOR_BROWSER_PARTIAL_OR_FAILED");
      assert.equal(error.failedAssertionIndex, 1);
      assert.deepEqual(error.completedReceipts, [{ eventId: "first-recorded" }]);
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.safeToRetryWithSameIdempotencyKey, true);
      return true;
    },
  );

  const firstAssertion = normalizeCommand(command()).policy.assertions[0];
  assert.equal(
    _test.childIdempotencyKey(PARENT_KEY, firstAssertion, 0),
    calls[0].idempotencyKey,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-browser-runtime",
    checks: 30,
    guarantees: [
      "browser commands map through a closed product allowlist to registry-pinned assertions",
      "operator identity, assertion values, contact channel, and child idempotency keys are server-owned",
      "multi-assertion outcomes are replayable and expose partial/ambiguous completion without pretending success",
      "unsupported/free-text decisions and caller-supplied identity fail closed",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

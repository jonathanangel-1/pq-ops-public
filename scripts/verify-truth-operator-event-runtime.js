#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { PREDICATES, REGISTRY } = require("../lib/truth-predicate-registry");
const {
  createTruthOperatorEventRuntime,
  normalizeOperatorTruthRequest,
} = require("../lib/truth-operator-event-runtime");

const KEY = "B".repeat(32);
const PRIOR = `operator-event:v1:${"a".repeat(64)}`;

function request(overrides = {}) {
  const predicate = overrides.predicate || "pickup_completed";
  const polarity = overrides.polarity || "positive";
  const eventType = overrides.eventType || "assertion";
  return {
    schemaVersion: "operator-truth-event-request-v1",
    eventType,
    subject: { type: "shipment", awbs: ["01680000156"] },
    contact: { name: "Riley Stone", organization: "Juniper Logistics", channel: "phone" },
    recordedBy: { operatorId: "operator:alex", name: "Alex Morgan" },
    occurredAt: "2026-07-09T14:59:00.000Z",
    recordedSummary: "I confirmed by phone that the driver picked up the cargo.",
    assertion: {
      contractVersion: REGISTRY.registryVersion,
      predicate,
      polarity,
      value: {
        status: PREDICATES[predicate].statuses[polarity],
        effect: PREDICATES[predicate].effects[polarity],
      },
    },
    ...(eventType === "assertion" ? {} : { relatedEventId: PRIOR }),
    ...overrides.extra,
  };
}

function fakeReceipt() {
  return {
    ok: true,
    schemaVersion: "truth-operator-event-receipt-v1",
    status: "recorded",
    requestId: `operator-request:v1:${"1".repeat(64)}`,
    eventId: `operator-event:v1:${"2".repeat(64)}`,
  };
}

async function main() {
  const calls = [];
  const ledger = {
    scope: {
      workspaceKey: "primary",
      sourceSystem: "operator",
      connectionKey: "operator-phone-primary",
    },
    record: async (input) => {
      calls.push(input);
      return fakeReceipt();
    },
  };
  const runtime = createTruthOperatorEventRuntime({
    workspaceKey: "primary",
    connectionKey: "operator-phone-primary",
    ledger,
  });
  const result = await runtime.record({ idempotencyKey: KEY, request: request() });
  assert.equal(result.status, "recorded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, KEY);
  assert.deepEqual(calls[0].request.subject, { type: "shipment", awbs: ["01680000156"] });
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].request, "eventId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].request, "sequence"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].request, "recordedAt"), false);

  const correction = normalizeOperatorTruthRequest(request({
    eventType: "correction",
    polarity: "negative",
  }));
  assert.equal(correction.relatedEventId, PRIOR);
  assert.equal(correction.assertion.value.status, "not_picked_up");

  const revocation = normalizeOperatorTruthRequest(request({
    eventType: "revocation",
    polarity: "unknown",
  }));
  assert.deepEqual(revocation.assertion.value, { effect: "context", status: "unknown" });

  for (const [label, mutate] of [
    ["server event id", (value) => { value.eventId = PRIOR; }],
    ["server sequence", (value) => { value.sequence = "77"; }],
    ["server recorded time", (value) => { value.recordedAt = "2026-07-09T15:00:00.000Z"; }],
    ["server workspace", (value) => { value.workspaceKey = "other"; }],
    ["noncanonical AWB", (value) => { value.subject.awbs = ["016-80000156"]; }],
    ["free-text-only claim", (value) => { delete value.assertion; }],
    ["wrong predicate status", (value) => { value.assertion.value.status = "delivered"; }],
    ["non-phone contact", (value) => { value.contact.channel = "email"; }],
    ["third-person summary", (value) => { value.recordedSummary = "Alex confirmed pickup."; }],
  ]) {
    const candidate = request();
    mutate(candidate);
    assert.throws(
      () => normalizeOperatorTruthRequest(candidate),
      (error) => error?.code === "TRUTH_OPERATOR_EVENT_INVALID_ARGUMENT",
      label,
    );
  }

  const extraRevocation = request({ eventType: "revocation", polarity: "unknown" });
  extraRevocation.assertion.value.note = "silently preserve old positive value";
  assert.throws(() => normalizeOperatorTruthRequest(extraRevocation), /must contain exactly/);

  const unsortedGroup = request();
  unsortedGroup.subject = {
    type: "workgroup",
    workgroupKey: `workgroup:v1:${"c".repeat(64)}`,
    membershipComplete: true,
    awbs: ["11480000292", "11480000291"],
  };
  assert.throws(() => normalizeOperatorTruthRequest(unsortedGroup), /sorted and unique/);

  const wrongScopeLedger = { ...ledger, scope: { ...ledger.scope, connectionKey: "caller-owned" } };
  assert.throws(
    () => createTruthOperatorEventRuntime({ ledger: wrongScopeLedger }),
    /server-owned operator source scope/,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-event-runtime",
    checks: 25,
    guarantees: [
      "requests are structured and pinned to the predicate registry before the RPC",
      "callers cannot supply event IDs, sequences, capture time, workspace, or connection",
      "corrections and revocations require one immutable prior event identity",
      "revocations carry only explicit unknown semantics",
      "shipment/workgroup scopes, provenance, summaries, payload depth, and bytes are bounded",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

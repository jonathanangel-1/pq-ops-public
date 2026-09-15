"use strict";
const assert = require("node:assert/strict");
const { demoSnapshot } = require("./scenarios");
const { factTypeFromText } = require("../lib/ops-fact-ledger");

const data = demoSnapshot("2026-01-01T12:00:00Z");
assert.equal(data.shipments.length, 3);
assert.equal(new Set(data.shipments.map(row => row.awb)).size, 3);
for (const row of data.shipments) {
  assert.ok(row.evidencePacket.sourceFacts.length > 0, "Synthetic email must become source evidence");
  assert.ok(row.truthPacket, "Actual truth builder must return a packet");
  assert.equal(row.completed, false, "Missing proof must not close a shipment");
  assert.ok(row.evidencePacket.sourceFacts.every(fact => fact.sourceRef.messageId.startsWith("demo-")));
}
assert.notEqual(factTypeFromText("POD will follow after delivery"), "pod_received", "A promise is not received proof");
assert.equal(factTypeFromText("Signed POD attached"), "pod_received", "Received proof must be recognized");
console.log("PASS: synthetic inventory → email evidence → actual truth builder → open proof gates");

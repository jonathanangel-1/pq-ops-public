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

const { sourceFactEligible } = require("../lib/source-fact-contract");
const { buildEvidencePacket } = require("../lib/operator-truth-packet");
const { classifyOperatorAgency, classifyOperatorAgencyForRow } = require("../lib/operator-agency");
const [release, pickup, delivery] = data.shipments;
const gate = (row, name) => row.truthPacket.gates.find(item => item.gate === name);
assert.equal(gate(release, "arrival").status, "true");
assert.equal(gate(release, "fees").status, "true");
assert.equal(gate(release, "customs").status, "unknown");
assert.equal(gate(pickup, "customs").status, "true");
assert.equal(gate(pickup, "fees").status, "true");
assert.equal(gate(pickup, "pickup").status, "unknown", "Pickup planning is not completed pickup");
assert.equal(gate(delivery, "delivery").status, "true");
assert.equal(gate(delivery, "pod").status, "unknown", "Reported delivery is not signed POD");
assert.equal(delivery.truthPacket.operatorAgency.countsAsWork, true, "Missing POD must remain operator work");
assert.equal(classifyOperatorAgencyForRow(delivery, delivery.truthPacket).countsAsWork, true);
assert.equal(classifyOperatorAgency({state:"delivered", podStatus:"true"}).countsAsWork, false);
assert.equal(classifyOperatorAgency({state:"closed"}).countsAsWork, false);
for (const source of ["canonical-shipment-pipeline", "truth-packet", "ui-projection", "action-planner"]) {
  const projection = { ...release.facts[0], id: `derived-${source}`, sourceSystem: source, type: "pod_received", evidence: "Signed POD attached" };
  assert.equal(sourceFactEligible(projection), false, "A copied Gmail pointer cannot authorize a generated conclusion");
  const packet = buildEvidencePacket({ ...release, evidencePacket: undefined, facts: [...release.facts, projection] });
  assert.equal(packet.sourceFacts.some(fact => fact.type === "pod_received"), false, "Projection must not reenter evidence");
}
console.log("PASS: coherent release/pickup/POD scenarios, closeout work, and rejection of self-generated evidence");

assert.equal(classifyOperatorAgency({state: "delivered", podStatus: "true", contradictions: [{claim: "Delivery disputed"}]}).agency, "needs_human_decision", "A POD must not hide an unresolved delivery contradiction");

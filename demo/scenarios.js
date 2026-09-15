"use strict";

const { attachOperatorPackets } = require("../lib/operator-truth-packet");

// Independent invented cases. Gate inputs and their email evidence agree;
// the original packet builder still reconciles them and classifies the work.
function demoSnapshot(now = new Date().toISOString()) {
  const specifications = [
    { awb: "016-90000001", client: "Demo Orchard Imports", station: "EWR", phase: "release-needed",
      summary: "Cargo is on hand; customs release is not yet confirmed.", nextAction: "Request customs release evidence", events: [
        ["arrival", "arrival-confirmed", "Cargo is on hand at the destination station."],
        ["fees", "ground-fees-paid", "Station confirms ground handling fees paid; no balance remains."],
      ] },
    { awb: "016-90000002", client: "Demo Harbor Components", station: "ORD", phase: "dispatch-ready",
      summary: "Cargo is on hand, customs released and station fees paid; arrange pickup.", nextAction: "Prepare a pickup request for review", events: [
        ["arrival", "arrival-confirmed", "Cargo is on hand at the destination station."],
        ["customs", "customs-release-received", "Customs release received; cargo is released for pickup."],
        ["fees", "ground-fees-paid", "Station confirms ground handling fees paid; no balance remains."],
      ] },
    { awb: "016-90000003", client: "Demo Meadow Supplies", station: "BOS", phase: "pod-needed",
      summary: "Carrier confirms delivery; signed proof of delivery is still missing.", nextAction: "Request signed proof of delivery", events: [
        ["arrival", "arrival-confirmed", "Cargo is on hand at the destination station."],
        ["customs", "customs-release-received", "Customs release received; cargo is released for pickup."],
        ["fees", "ground-fees-paid", "Station confirms ground handling fees paid; no balance remains."],
        ["dispatch", "dispatch-confirmed", "Carrier dispatch accepted the pickup assignment."],
        ["pickup", "pickup-confirmed", "Carrier confirms cargo picked up from the station."],
        ["delivery", "delivery-reported", "Carrier confirms shipment delivered to consignee. POD will follow."],
      ] },
  ];
  const shipments = specifications.map((spec, index) => {
    const { awb, client, station, phase, summary, nextAction } = spec;
    const sourceEvents = spec.events.map(([gate, type, evidence], eventIndex) => ({
      id: `demo-event-${index + 1}-${eventIndex + 1}`, awb, gate, type, label: type,
      summary: evidence, evidence, at: now, observedAt: now,
      threadId: `demo-thread-${index + 1}`, messageId: `demo-message-${index + 1}-${eventIndex + 1}`,
      subject: `Fictional shipment update ${awb}`, from: "station@handler.example", to: "ops@forwarder.example",
      sourceSystem: "gmail", confidence: "high", evidenceKind: "direct", synthetic: true,
    }));
    const gates = Object.fromEntries(["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"].map(name => {
      const fact = sourceEvents.find(event => event.gate === name);
      return [name, { name, status: fact ? "done" : "pending", label: name,
        evidence: fact?.evidence || "No confirmation in this synthetic scenario",
        confidence: fact ? "high" : "low", source: "synthetic-demo", at: now }];
    }));
    return { id: `demo-shipment-${index + 1}`, awb, client, station, route: `TLV → ${station}`,
      cargo: { pieces: String(index + 2), weight: String(100 + index * 50), weightUom: "KG", source: "synthetic-demo" },
      delivery: { consignee: client, fullAddress: `${100 + index} Example Avenue, Example City` },
      currentState: summary, nextAction, completed: false, truthPacketRole: "active", synthetic: true,
      arrivalStatus: "arrived",
      pickupStatus: index === 2 ? "airport-picked-up" : index === 1 ? "ready" : "pending", deliveryStatus: index === 2 ? "reported" : "pending",
      opsState: { phase, label: summary, summary, nextAction, gates },
      sourceEvents, facts: sourceEvents, sourceProof: [],
      freightBroker: { broker: "Demo Ground Logistics", status: index === 2 ? "freight-delivered-pod-needed" : "pending", evidence: [] },
      customsBroker: { broker: "Demo Customs", status: index === 0 ? "pending" : "released" },
    };
  });
  return { ok: true, synthetic: true, source: "shipment-truth-packets", writerVersion: "shipment-truth-packets-v1-demo",
    sourceOfTruth: "Invented examples processed by the actual evidence/truth packet builders. No live status claims.",
    snapshotTime: now, activeAwbs: shipments.map(row => row.awb), counts: { active: shipments.length, completed: 0 },
    shipments: attachOperatorPackets(shipments, { snapshotTime: now }) };
}

module.exports = { demoSnapshot };

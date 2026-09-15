"use strict";

const { attachOperatorPackets } = require("../lib/operator-truth-packet");

// Independent invented cases. No source operational snapshot is imported.
function demoSnapshot(now = new Date().toISOString()) {
  const specifications = [
    ["016-90000001", "Demo Orchard Imports", "EWR", "arrival-confirmed", "Cargo is on hand; customs release is not yet confirmed.", "Request customs release evidence"],
    ["016-90000002", "Demo Harbor Components", "ORD", "customs-released", "Customs release received; arrange pickup.", "Prepare a pickup request for review"],
    ["016-90000003", "Demo Meadow Supplies", "BOS", "delivery-reported", "Delivery reported; signed proof of delivery is still missing.", "Request signed proof of delivery"],
  ];
  const shipments = specifications.map(([awb, client, station, type, summary, nextAction], index) => {
    const id = `demo-shipment-${index + 1}`;
    const sourceEvents = [{ id: `demo-event-${index + 1}`, awb, type, label: type,
      summary, evidence: summary, at: now, observedAt: now,
      threadId: `demo-thread-${index + 1}`, messageId: `demo-message-${index + 1}`,
      subject: `Fictional shipment update ${awb}`, from: "station@handler.example", to: "ops@forwarder.example",
      sourceSystem: "gmail", confidence: "high", evidenceKind: "direct", synthetic: true }];
    const gates = Object.fromEntries(["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"].map(name => [name, {
      name, status: name === "arrival" || name === "customs" && index > 0 ? "confirmed" : "pending",
      label: name, evidence: name === "arrival" ? "Invented handler confirmation" : "No confirmation in this synthetic scenario",
      confidence: "low", source: "synthetic-demo", at: now,
    }]));
    return { id, awb, client, station, route: `TLV → ${station}`, cargo: { pieces: String(index + 2), weight: String(100 + index * 50), weightUom: "KG", source: "synthetic-demo" },
      delivery: { consignee: client, fullAddress: `${100 + index} Example Avenue, Example City` },
      currentState: summary, nextAction, completed: false, truthPacketRole: "active", synthetic: true,
      pickupStatus: index === 2 ? "picked-up" : "pending", deliveryStatus: index === 2 ? "reported" : "pending",
      opsState: { phase: index === 0 ? "release-needed" : index === 1 ? "dispatch-ready" : "pod-needed", label: summary, summary, nextAction, gates },
      sourceEvents, facts: sourceEvents, sourceProof: [], freightBroker: { broker: "Demo Ground Logistics", status: "pending", evidence: [] },
      customsBroker: { broker: "Demo Customs", status: index === 0 ? "pending" : "released" },
    };
  });
  return { ok: true, synthetic: true, source: "shipment-truth-packets", writerVersion: "shipment-truth-packets-v1-demo",
    sourceOfTruth: "Invented examples processed by the actual evidence/truth packet builders. No live status claims.",
    snapshotTime: now, activeAwbs: shipments.map(row => row.awb), counts: { active: shipments.length, completed: 0 },
    shipments: attachOperatorPackets(shipments, { snapshotTime: now }) };
}

module.exports = { demoSnapshot };

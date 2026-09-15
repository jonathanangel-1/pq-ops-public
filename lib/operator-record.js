"use strict";

// Operator-recorded truth (anchor case 016-80000156: "it was picked up").
//
// When the operator records a shipment event, that record is FIRST-CLASS
// truth, not a note for the next refresh:
//   1. classifyOperatorRecord() turns free text into one structured event
//      (or asks for classification instead of guessing).
//   2. buildOperatorRecordFact() emits a source fact whose claim carries both
//      the operator's words and canonical vocabulary the truth predicates
//      already understand, with provenance ("Operator record: … — recorded by
//      Alex").
//   3. applyOperatorRecordToShipment() augments the shipment row (fact + gate
//      + phase) so the packet can rebuild IMMEDIATELY. Operator records
//      outrank weak inferred facts, but never silently override hard
//      contradictory evidence: when the packet holds a hard conflicting
//      blocker, the gate overlay is withheld and the conflict surfaces as a
//      contradiction/needs-decision instead.

const OPERATOR_EVENTS = [
  "pickup_confirmed",
  "delivered",
  "pod_received",
  "release_received",
  "fees_paid",
  "broker_confirmed",
  "docs_sent",
  "waiting_no_action",
  "disregard",
  "unclassified",
];

// Later-lifecycle events win when a note mentions several ("picked up and
// delivered, POD attached" -> pod_received).
const EVENT_DEFINITIONS = [
  {
    eventType: "pod_received",
    test: (t) => /\b(?:pod|proof of delivery)\b[^.;\n]{0,60}\b(?:received|attached|uploaded|signed|sent|provided|in hand)\b/i.test(t) ||
      /\b(?:received|got|have)\b[^.;\n]{0,40}\b(?:the )?(?:pod|proof of delivery)\b/i.test(t),
    gate: "pod",
    phase: "closed",
    label: "POD received",
    claim: (t) => `Operator record: POD received — proof of delivery received. "${t}"`,
  },
  {
    eventType: "delivered",
    test: (t) => /\b(?:delivered|delivery (?:was )?(?:complete|completed|done))\b/i.test(t) &&
      !/\b(?:will (?:be )?deliver|delivering|deliver(?:y)? (?:today|tomorrow|scheduled)|out for delivery)\b/i.test(t),
    gate: "delivery",
    phase: "delivered",
    label: "Delivered",
    claim: (t) => `Operator record: delivered — the cargo was delivered. "${t}"`,
  },
  {
    eventType: "pickup_confirmed",
    test: (t) => /\b(?:picked(?:\s+it)?\s+up|it was picked up|pickup (?:is )?(?:complete|completed|done|confirmed)|driver (?:loaded|picked up)|recovered|collected the (?:cargo|freight))\b/i.test(t),
    gate: "pickup",
    phase: "picked-up",
    label: "Picked up",
    claim: (t) => `Operator record: cargo picked up — driver picked up the cargo. "${t}"`,
  },
  {
    eventType: "release_received",
    test: (t) => /\b(?:release[d]?(?: received)?|customs (?:cleared|release[d]?)|cleared customs|delivery order (?:received|issued)|d\/?o (?:received|issued|in hand)|1c\b)\b/i.test(t) &&
      !/\b(?:waiting|pending|need|not (?:yet )?released)\b/i.test(t),
    gate: "customs",
    phase: "",
    label: "Release received",
    claim: (t) => `Operator record: customs release received — cargo is now released; delivery order received. "${t}"`,
  },
  {
    eventType: "fees_paid",
    test: (t) => /\b(?:fees?|storage|handling|cargosprint|cvf)\b[^.;\n]{0,50}\b(?:paid|payment (?:made|sent|delivered))\b/i.test(t) ||
      /\bpaid\b[^.;\n]{0,50}\b(?:fees?|storage|handling|cargosprint|cvf)\b/i.test(t),
    gate: "fees",
    phase: "",
    label: "Fees paid",
    // Vocabulary the fee ledger's sentence-scoped payment predicate recognizes;
    // the operator's exact wording rides along, so "$230 paid" stays machine-readable.
    claim: (t) => `Operator record: ground handling fees paid. "${t}"`,
  },
  {
    eventType: "broker_confirmed",
    test: (t) => /\b(?:broker|carrier|trucker)\b[^.;\n]{0,50}\b(?:confirmed|accepted|awarded|booked)\b/i.test(t) ||
      /\bawarded (?:to|the pickup)\b/i.test(t),
    gate: "dispatch",
    phase: "",
    label: "Broker confirmed",
    claim: (t) => `Operator record: pickup broker confirmed the pickup. "${t}"`,
  },
  {
    eventType: "docs_sent",
    test: (t) => /\b(?:docs?|documents|paperwork|3461|7501|it copy|in-?bond copy|pre[- ]?alert)\b[^.;\n]{0,50}\b(?:sent|forwarded|emailed|provided|shared)\b/i.test(t) ||
      /\b(?:sent|forwarded|emailed)\b[^.;\n]{0,50}\b(?:the )?(?:docs?|documents|paperwork|3461|7501)\b/i.test(t),
    gate: "",
    phase: "",
    label: "Docs sent",
    claim: (t) => `Operator record: documents sent — the requested documents were sent. "${t}"`,
  },
];

function classifyOperatorRecord(text = "") {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return { eventType: "unclassified", needsClassification: true, label: "Unclassified", gate: "", phase: "" };
  if (/\b(?:wrong|ignore|disregard|mistake|scratch that|never ?mind|not correct|delete that)\b/i.test(value)) {
    return { eventType: "disregard", needsClassification: false, label: "Disregard", gate: "", phase: "" };
  }
  for (const definition of EVENT_DEFINITIONS) {
    if (definition.test(value)) {
      return {
        eventType: definition.eventType,
        needsClassification: false,
        label: definition.label,
        gate: definition.gate,
        phase: definition.phase,
        claim: definition.claim(value),
      };
    }
  }
  if (/\b(?:waiting|no action|nothing to do|hold (?:off|for now)|stand ?by|monitor)\b/i.test(value)) {
    return { eventType: "waiting_no_action", needsClassification: false, label: "Waiting / no action", gate: "", phase: "" };
  }
  // Do not guess: an unmatched note stays a note and the caller must ask.
  return { eventType: "unclassified", needsClassification: true, label: "Unclassified", gate: "", phase: "" };
}

function buildOperatorRecordFact(record, { awb = "", text = "", at = new Date().toISOString(), operator = "Alex" } = {}) {
  if (!record || record.needsClassification || ["waiting_no_action", "disregard", "unclassified"].includes(record.eventType)) return null;
  const claim = record.claim || `Operator record: ${record.label}. "${text}"`;
  return {
    type: "operator_record",
    label: record.label,
    actor: `${operator} (operator)`,
    claim,
    summary: claim,
    note: claim,
    at,
    observedAt: at,
    source: "operator_record",
    sourceSystem: "operator_record",
    confidence: "operator-confirmed",
    operatorEvent: record.eventType,
    awb,
  };
}

// Hard contradictory evidence the record must NOT silently override: the
// packet says the cargo physically cannot have moved. The fact still lands
// (the reconciler will emit the contradiction); only the gate overlay is
// withheld.
function hardContradiction(record, packet = {}) {
  const blocker = packet.operationalBlocker || {};
  if (["pickup_confirmed", "delivered"].includes(record.eventType)) {
    if (blocker.type === "customs_hold") return "The truth packet still shows a customs hold — cargo should not be movable.";
    if (blocker.type === "fees_due" && Number(packet.feeLedger?.remainingBalance) > 0) {
      return `The truth packet shows a proven unpaid balance ($${packet.feeLedger.remainingBalance}) — the station should not have released the cargo.`;
    }
  }
  return "";
}

function applyOperatorRecordToShipment(row = {}, record, { text = "", at = new Date().toISOString(), operator = "Alex" } = {}) {
  const fact = buildOperatorRecordFact(record, { awb: row.awb || row.id || "", text, at, operator });
  if (!fact) return { shipment: row, fact: null, gateApplied: false, contradiction: "" };
  const contradiction = hardContradiction(record, row.truthPacket || {});
  const gates = { ...(row.opsState?.gates || {}) };
  let gateApplied = false;
  if (record.gate && !contradiction) {
    gates[record.gate] = {
      ...(gates[record.gate] || {}),
      status: "done",
      evidence: `${record.label} recorded by ${operator} at ${at}.`,
      at,
      source: "operator_record",
    };
    gateApplied = true;
  }
  const shipment = {
    ...row,
    facts: [...(Array.isArray(row.facts) ? row.facts : []), fact],
    opsState: {
      ...(row.opsState || {}),
      updatedAt: at,
      ...(record.phase && !contradiction ? { phase: record.phase } : {}),
      gates,
    },
  };
  return { shipment, fact, gateApplied, contradiction };
}

module.exports = {
  OPERATOR_EVENTS,
  classifyOperatorRecord,
  buildOperatorRecordFact,
  applyOperatorRecordToShipment,
};

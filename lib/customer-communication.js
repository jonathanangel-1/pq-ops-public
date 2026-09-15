"use strict";

// External-communication policy layer — SEPARATE from internal ops actions.
//
// We are the IMPORT side. Customers ask about delivery time, pickup, release,
// POD, ETA, or whether anything is needed from them. They get externally safe
// truth only: never internal fee amounts or broker costs (unless the customer
// must approve/pay), never blame, never quote negotiation, never station
// confusion, never internal uncertainty phrased as chaos.
//
// Every draft is concise, professional, and never overpromises: expected
// times are "expected", commitments are "we will update you by", and
// export-side questions are answered honestly as monitoring-import.

const INTERNAL_DOMAINS = ["partner-116.example"];
const STATION_DOMAIN_HINTS = /(?:swissport|wfs\.aero|forwardair|alliance|unitedhq|united\.com|delta\.com|elal|challenge|maestro|menzies|dnata|aa\.com|lufthansa|cargo)/i;

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");
}

function emailDomain(value = "") {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  return at > -1 ? email.slice(at + 1) : "";
}

// customer_consignee | customs_broker | pickup_broker | station_handler | internal
function classifyAudience(participant = {}, shipment = {}) {
  const email = normalizeEmail(participant.email || participant);
  if (!email) return "customer_consignee";
  const domain = emailDomain(email);
  if (INTERNAL_DOMAINS.some((internal) => domain === internal || domain.endsWith(`.${internal}`))) return "internal";
  const customsEmail = normalizeEmail(shipment.customsBroker?.contactEmail || shipment.customsBroker?.email || "");
  if (customsEmail && customsEmail === email) return "customs_broker";
  const pickupEmail = normalizeEmail(shipment.freightBroker?.contactEmail || shipment.freightBroker?.email || "");
  if (pickupEmail && pickupEmail === email) return "pickup_broker";
  const stationEmail = normalizeEmail(shipment.station?.email || shipment.contacts?.station?.email || "");
  if ((stationEmail && stationEmail === email) || STATION_DOMAIN_HINTS.test(domain)) return "station_handler";
  return "customer_consignee";
}

function packetState(shipment = {}) {
  return String(
    shipment.truthPacket?.resolvedCurrentState ||
    shipment.truthPacket?.currentState ||
    shipment.currentState ||
    "",
  ).toLowerCase().replace(/[\s-]+/g, "_");
}

function gateStatus(shipment = {}, name = "") {
  const packetGate = (shipment.truthPacket?.gates || []).find((gate) => gate.gate === name);
  if (packetGate) return String(packetGate.status || "").toLowerCase();
  return String(shipment.opsState?.gates?.[name]?.status || "").toLowerCase();
}

const GATE_DONE = new Set(["done", "true", "released", "cleared", "paid", "delivered", "picked-up", "recovered"]);

// The externally safe view of one shipment. Everything a customer reply may
// use comes from here — and ONLY from here.
function customerSafeTruth(shipment = {}) {
  const state = packetState(shipment);
  const released = GATE_DONE.has(gateStatus(shipment, "customs"));
  const pickedUp = GATE_DONE.has(gateStatus(shipment, "pickup")) ||
    ["picked_up", "out_for_delivery", "delivered", "pod_needed", "closed"].includes(state);
  const delivered = ["delivered", "closed"].includes(state) || GATE_DONE.has(gateStatus(shipment, "pod"));
  const arrived = pickedUp || delivered || released ||
    ["arrived", "arrived_not_available", "ready_for_pickup", "customs_hold", "fees_due", "release_needed", "pod_needed"].includes(state) ||
    GATE_DONE.has(gateStatus(shipment, "arrival"));
  const exportSide = ["pre_arrival", "in_transit", "booked", "exception"].includes(state) && !arrived;
  const waitText = String(shipment.truthPacket?.operationalBlocker?.reason || "");
  const receiverClosed = /receiver|consignee|closed|holiday|cannot receive/i.test(waitText);
  // Internal TMS shorthand ("RECOVER WED 06:45", "ARRIVE THU 12:15") must
  // never reach a customer. Only a parseable calendar date qualifies, and the
  // trailing station code is stripped.
  const rawEta = String(shipment.eta || shipment.liveTracking?.scheduledArrival || "").trim();
  const etaCleaned = rawEta.replace(/\s+[A-Z]{3}\s*$/, "").replace(/\s*\/\s*/, " ").trim();
  const eta = /^[A-Z][a-z]/.test(rawEta) && Number.isFinite(Date.parse(etaCleaned)) ? etaCleaned : "";
  return {
    awb: shipment.awb || "",
    arrived,
    released,
    pickedUp,
    delivered,
    exportSide,
    receiverClosed,
    eta,
    deliveryPlan: pickedUp && !delivered
      ? (receiverClosed ? "delivery-waits-on-receiver" : "out-for-delivery")
      : "",
    podAvailable: delivered,
  };
}

// Internal words that must never reach a customer draft.
const UNSAFE_PATTERN = /\$\s?\d|₪|\bquote(?:s|d)?\b|\bcargosprint\b|\brate\b|\bfee(?:s)?\b|\bdemurrage\b|\bstorage charge\b|\bbroker\b|\bblame|\bmistake|\bconfus|\bno idea\b|\bmess\b|\bpedimento\b|\binbond\b|\babi\b/i;

function assertCustomerSafe(body) {
  return !UNSAFE_PATTERN.test(String(body || ""));
}

// delivery_time | picked_up | any_update | pod_request | cleared | why_delayed |
// charges | export_status | none
function detectCustomerQuestion(text = "") {
  const clean = String(text || "").toLowerCase();
  if (!clean.trim()) return "none";
  if (/\bpod\b|proof of delivery|delivery (?:receipt|confirmation)/.test(clean)) return "pod_request";
  if (/how much|charges?|cost|invoice|price|לשלם|עלות/.test(clean)) return "charges";
  if (/why.*(?:delay|late|holding|stuck)|(?:delay|late).*why|מתעכב|למה.*עיכוב/.test(clean)) return "why_delayed";
  if (/\bcleared?\b|customs|release|שוחרר|מכס/.test(clean)) return "cleared";
  if (/picked ?up|collect(?:ed)?|נאסף/.test(clean)) return "picked_up";
  if (/when.*(?:deliver|arriv)|deliver.*when|eta|delivery (?:date|time)|יגיע|מתי/.test(clean)) return "delivery_time";
  if (/export|origin|departed|flight from|טיסה/.test(clean)) return "export_status";
  if (/any update|status|update on|מה קורה|עדכון/.test(clean)) return "any_update";
  return "none";
}

function line(strings) {
  return strings.filter(Boolean).join(" ");
}

function statusSentence(truth) {
  if (truth.delivered) return "Your shipment has been delivered.";
  if (truth.pickedUp && truth.receiverClosed) {
    return "Your shipment was picked up and delivery is scheduled for the next business day the receiving site is open.";
  }
  if (truth.pickedUp) return "Your shipment was picked up and is out for final delivery.";
  if (truth.released) return "Your shipment has cleared customs and we are arranging pickup and delivery.";
  if (truth.arrived) return "Your shipment has arrived at the destination station and release is in process.";
  if (truth.exportSide) return "Your shipment has not yet reached import handling; we are monitoring and will take over the moment it arrives.";
  return "We are coordinating your shipment's import handling.";
}

function nextUpdateSentence(truth) {
  if (truth.delivered) return "";
  if (truth.eta) return `Current expected timing: ${truth.eta}.`;
  return "We will update you as soon as there is a confirmed time.";
}

// One customer question -> one safe, concise draft.
function draftCustomerReply(question, shipment = {}) {
  const truth = customerSafeTruth(shipment);
  const paragraphs = [];
  switch (question) {
    case "delivery_time":
      paragraphs.push(statusSentence(truth), nextUpdateSentence(truth));
      break;
    case "picked_up":
      paragraphs.push(
        truth.pickedUp
          ? "Yes — the shipment has been picked up."
          : truth.released
            ? "Not yet — it has cleared customs and pickup is being arranged now."
            : "Not yet — it is still in import handling before pickup.",
        nextUpdateSentence(truth),
      );
      break;
    case "any_update":
      paragraphs.push(statusSentence(truth), nextUpdateSentence(truth));
      break;
    case "pod_request":
      paragraphs.push(
        truth.podAvailable
          ? "The shipment has been delivered — the signed proof of delivery is attached."
          : "The shipment has not been delivered yet; we will send the proof of delivery as soon as delivery is completed.",
      );
      break;
    case "cleared":
      paragraphs.push(
        truth.released
          ? "Yes — customs clearance is complete."
          : truth.arrived
            ? "Clearance is in process; we are coordinating release and will confirm as soon as it clears."
            : "The shipment has not reached customs processing yet; we will confirm once clearance completes.",
        truth.released && !truth.delivered ? nextUpdateSentence(truth) : "",
      );
      break;
    case "why_delayed":
      paragraphs.push(
        truth.receiverClosed
          ? "Delivery is waiting for the receiving site to reopen; we will deliver on the first open business day."
          : "We are coordinating release and delivery and will update you with a confirmed time shortly.",
        nextUpdateSentence(truth),
      );
      break;
    case "charges": {
      const customerPayable = Boolean(shipment.customerPayable || shipment.truthPacket?.feeLedger?.customerPayable);
      paragraphs.push(
        customerPayable
          ? "There is a charge on this shipment that needs your approval — we will send the exact breakdown separately."
          : "Import handling charges are being settled under our arrangement; nothing is needed from your side.",
      );
      break;
    }
    case "export_status":
      paragraphs.push(
        "We handle the import side; export movement is still pending upstream. We are monitoring and will take over the moment it arrives.",
      );
      break;
    default:
      return { question: "none", blocked: true, reason: "No customer question detected.", body: "" };
  }
  const body = paragraphs.filter(Boolean).join(" ");
  if (!assertCustomerSafe(body)) {
    return { question, blocked: true, reason: "Draft contained internal detail; refusing to expose it.", body: "" };
  }
  return { question, blocked: false, body, audience: "customer_consignee" };
}

const PROACTIVE_KINDS = [
  "arrived_release_pending",
  "released_arranging_pickup",
  "picked_up_out_for_delivery",
  "delivered_pod_attached",
  "delayed_consignee_closed",
  "waiting_on_customer_doc",
];

function proactiveCustomerUpdate(kind, shipment = {}, extra = {}) {
  const truth = customerSafeTruth(shipment);
  const bodies = {
    arrived_release_pending: line([
      "Your shipment has arrived at the destination station and customs release is in process.",
      nextUpdateSentence(truth),
    ]),
    released_arranging_pickup: line([
      "Your shipment has cleared customs and we are arranging pickup and final delivery.",
      nextUpdateSentence(truth),
    ]),
    picked_up_out_for_delivery: line([
      "Your shipment was picked up and is out for final delivery.",
      nextUpdateSentence(truth),
    ]),
    delivered_pod_attached: "Your shipment has been delivered — the signed proof of delivery is attached.",
    delayed_consignee_closed: line([
      "Your shipment was picked up; the receiving site is currently closed, so delivery will complete on the first open business day.",
      "We will confirm as soon as it is delivered.",
    ]),
    waiting_on_customer_doc: line([
      `To continue we need ${extra.needed || "one document"} from your side.`,
      "Everything else is ready; we will proceed the moment it arrives.",
    ]),
  };
  const body = bodies[kind] || "";
  if (!body) return { kind, blocked: true, reason: `Unknown update kind "${kind}".`, body: "" };
  if (!assertCustomerSafe(body)) return { kind, blocked: true, reason: "Draft contained internal detail.", body: "" };
  return { kind, blocked: false, body, audience: "customer_consignee" };
}

module.exports = {
  classifyAudience,
  customerSafeTruth,
  detectCustomerQuestion,
  draftCustomerReply,
  proactiveCustomerUpdate,
  assertCustomerSafe,
  PROACTIVE_KINDS,
};

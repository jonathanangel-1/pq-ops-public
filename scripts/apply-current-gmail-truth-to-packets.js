#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildCanonicalActionPlan } = require("../lib/action-planner");
const { platformExecutableAction } = require("../lib/platform-action");
const { buildOperatorTruthPacket } = require("../lib/operator-truth-packet");

const ROOT_DIR = path.resolve(__dirname, "..");
const SNAPSHOT_TIME = new Date().toISOString();
const WRITER_SUFFIX = "manual-current-gmail-truth";

const TRUE_GATE_STATUSES = new Set([
  "arrived",
  "available",
  "cleared",
  "delivered",
  "done",
  "found",
  "inferred",
  "paid",
  "picked-up",
  "pod-found",
  "received",
  "released",
  "sent",
  "broker-alerted",
  "broker-awarded",
  "dispatched",
  "offline-inferred",
]);

const UNKNOWN_GATE_STATUSES = new Set([
  "unknown",
  "waiting",
  "pending",
  "missing",
  "needed",
  "due",
]);

function readJson(fileName, fallback = null) {
  const fullPath = path.join(ROOT_DIR, fileName);
  if (!fs.existsSync(fullPath)) return fallback;
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function readJsonLines(fileName) {
  const fullPath = path.join(ROOT_DIR, fileName);
  if (!fs.existsSync(fullPath)) return [];
  return fs.readFileSync(fullPath, "utf8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function memoryContacts(memory = {}) {
  return Array.isArray(memory.contacts) ? memory.contacts : Array.isArray(memory.stations) ? memory.stations : [];
}

function writeJson(fileName, value) {
  fs.writeFileSync(path.join(ROOT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function displayAwb(value) {
  const awb = normalizeAwb(value);
  return awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : awb;
}

function inferredAirlineFromAwb(value) {
  return normalizeAwb(value).startsWith("016") ? "United" : "";
}

function stationMemoryContextForRow(row = {}, stationMemory = {}) {
  const airport = String(row.station || row.airport || row.destination || row.flightDetails?.destination || row.tms?.destination || "")
    .trim()
    .toUpperCase();
  if (!airport) return null;
  const airline = String(row.airline || inferredAirlineFromAwb(row.awb || row.id || row.shipmentId) || "")
    .trim()
    .toLowerCase();
  const contacts = memoryContacts(stationMemory);
  const candidates = contacts
    .filter((contact) => String(contact.airport || "").trim().toUpperCase() === airport)
    .map((contact) => {
      const aliasText = [
        contact.airline,
        contact.handlerName,
        contact.stationName,
        contact.stationEmail,
        ...(contact.aliases || []),
      ].join(" ").toLowerCase();
      let score = 0;
      if (contact.stationEmail) score += 20;
      if (contact.stationPhone) score += 5;
      if (String(contact.confidence || "").toLowerCase() === "high") score += 5;
      if (airline && aliasText.includes(airline)) score += 20;
      if (airline && String(contact.airline || "").toLowerCase() === airline) score += 20;
      return { contact, score };
    })
    .filter((candidate) => candidate.score >= 20)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0]?.contact;
  if (!best) return null;
  return {
    rememberedAt: best.updatedAt || stationMemory.snapshotTime || SNAPSHOT_TIME,
    source: best.source || stationMemory.source || "Known PQ station memory",
    stationMemory: best,
    stations: [best],
    storage: best.storage,
  };
}

function storageFactForRow(row = {}) {
  const storage = row.operationalMemory?.storage || row.stationContext?.storage;
  if (!storage || String(storage.status || "").toLowerCase() !== "known") return null;
  const parts = [
    storage.lastFreeDay ? `last free day ${storage.lastFreeDay}` : "",
    storage.storageStartsAt ? `storage starts ${storage.storageStartsAt}` : "",
    storage.storageAccruingSince ? `storage accruing since ${storage.storageAccruingSince}` : "",
    storage.lastFreeDayRule ? `last free day rule: ${storage.lastFreeDayRule}` : "",
    storage.dailyStorageRate ? `rate: ${storage.dailyStorageRate}` : "",
    storage.freeStorage ? `free storage: ${storage.freeStorage}` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  return {
    type: "storage",
    label: "Storage memory",
    summary: `Storage memory: ${parts.join("; ")}.`,
    note: storage.source || row.stationContext?.source || "station-memory",
    at: row.stationContext?.rememberedAt || row.stationContext?.stationMemory?.updatedAt || SNAPSHOT_TIME,
    source: storage.source || row.stationContext?.source || "station-memory",
  };
}

function factKey(fact = {}) {
  return [
    fact.type || "",
    fact.summary || "",
    fact.source || "",
    fact.at || "",
  ].join("|").toLowerCase();
}

function factsWithStorageFact(row = {}) {
  const facts = Array.isArray(row.factLedger) ? row.factLedger : [];
  const storageFact = storageFactForRow(row);
  if (!storageFact) return facts;
  const key = factKey(storageFact);
  if (facts.some((fact) => factKey(fact) === key || fact.type === "storage" && fact.summary === storageFact.summary)) return facts;
  return [...facts, storageFact];
}

const TERMINAL_NEXT_ACTION = "No action; POD is in memory.";

// Terminal truth must retire downstream action language. Carried-over contact/broker/reasoning
// blobs from the previously-active row can still say "Confirm pickup ..." — scrub them so a
// completed packet never leaks a stale executable action.
function retireStaleActionTextForCompletedRow(row = {}) {
  const TERMINAL_LABEL = "Delivered; POD received";
  const scrub = (holder) => {
    if (!holder || typeof holder !== "object") return;
    if (typeof holder.nextAction === "string" && holder.nextAction && holder.nextAction !== TERMINAL_NEXT_ACTION) {
      holder.nextAction = TERMINAL_NEXT_ACTION;
    }
    // Broker/relationship status text captured while the shipment was active describes
    // active work (pickup plans, storage watching). Terminal rows must not display it.
    if (typeof holder.brokerStatus === "string" && holder.brokerStatus && !/^delivered\b/i.test(holder.brokerStatus)) {
      holder.brokerStatus = `${TERMINAL_LABEL}.`;
    }
  };
  for (const contact of Object.values(row.contacts || {})) scrub(contact);
  scrub(row.customsBroker);
  scrub(row.freightBroker);
  scrub(row.stationContext);
  if (row.reasoning && typeof row.reasoning === "object") {
    scrub(row.reasoning);
    row.reasoning.label = TERMINAL_LABEL;
    if (typeof row.reasoning.reason === "string") {
      row.reasoning.reason = String(row.currentState || `${TERMINAL_LABEL}.`);
    }
  }
}

function completedStationContext(context = null) {
  if (!context) return context;
  const stripPickupBroker = (station = {}) => {
    const { pickupBroker, ...rest } = station || {};
    return rest;
  };
  return {
    ...context,
    stationMemory: context.stationMemory ? stripPickupBroker(context.stationMemory) : context.stationMemory,
    stations: (context.stations || []).map(stripPickupBroker),
  };
}

function signature(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function appendUniqueSuffix(value, suffix) {
  const parts = String(value || "shipment-truth-packets-v1").split("+").filter(Boolean);
  const base = parts.shift() || "shipment-truth-packets-v1";
  return [base, ...new Set([...parts, suffix])].join("+");
}

function manualReasoningClassForPhase(phase = "") {
  const normalized = String(phase || "").toLowerCase();
  if (["delivered", "completed", "closeout"].includes(normalized)) return "closed";
  if (["ready-for-pickup", "dispatch-ready", "ready-execution"].includes(normalized)) return "ready-execution";
  if (["pod-needed", "delivered-pod-pending", "pickup-scheduled", "driver-onsite", "picked-up", "out-for-delivery"].includes(normalized)) return "post-pickup";
  if (["pre-arrival", "arrival-watch", "in-transit", "transit", "not-arrived"].includes(normalized)) return "pre-arrival";
  if (["release-needed", "fees-needed", "customs-hold", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "not-ready"].includes(normalized)) return "blocked-work";
  if (["exception", "delivery-blocked", "wrong-consignee-delivery", "wrong-delivery", "transfer-exception", "cargo-not-found", "pickup-blocked", "loading-blocked"].includes(normalized)) return "true-exception";
  return "";
}

function rowTruthPacketGateStatus(row = {}, gateName = "") {
  const objectGate = row.opsState?.gates?.[gateName]?.status || row.canonical?.gates?.[gateName]?.status;
  if (objectGate) return String(objectGate).toLowerCase();
  const truthGate = (row.truthPacket?.gates || []).find((gate) => String(gate.gate || "").toLowerCase() === gateName);
  return String(truthGate?.rawStatus || truthGate?.status || "").toLowerCase();
}

function legacyArrivalStatusFromTruth(row = {}) {
  const lifecycle = String(row.truthPacket?.physicalLifecycle?.status || "").toLowerCase();
  if (["closed", "delivered", "out_for_delivery", "picked_up", "pickup_scheduled", "arrived"].includes(lifecycle)) return "arrived";
  if (["in_transit", "pre_arrival", "not_arrived", "arrival_watch"].includes(lifecycle)) return "not-arrived";
  const arrival = rowTruthPacketGateStatus(row, "arrival");
  if (TRUE_GATE_STATUSES.has(arrival)) return "arrived";
  if (UNKNOWN_GATE_STATUSES.has(arrival) || ["not-arrived", "in-transit", "transit", "waiting"].includes(arrival)) return "not-arrived";
  return row.arrivalStatus || "";
}

function legacyPickupStatusFromTruth(row = {}) {
  const lifecycle = String(row.truthPacket?.physicalLifecycle?.status || "").toLowerCase();
  if (["closed", "delivered", "out_for_delivery", "picked_up"].includes(lifecycle)) return "picked-up";
  if (lifecycle === "pickup_scheduled") {
    const pickup = rowTruthPacketGateStatus(row, "pickup");
    return pickup && pickup !== "unknown" ? pickup : "scheduled";
  }
  if (["in_transit", "pre_arrival", "not_arrived", "arrival_watch", "arrived"].includes(lifecycle)) {
    const pickup = rowTruthPacketGateStatus(row, "pickup");
    return pickup && !TRUE_GATE_STATUSES.has(pickup) ? pickup : "pending";
  }
  return row.pickupStatus || "";
}

function legacyDeliveryStatusFromTruth(row = {}) {
  const lifecycle = String(row.truthPacket?.physicalLifecycle?.status || "").toLowerCase();
  if (["closed", "delivered"].includes(lifecycle)) return "delivered";
  if (lifecycle === "out_for_delivery") return "scheduled";
  const delivery = rowTruthPacketGateStatus(row, "delivery");
  if (["delivered", "reported", "done"].includes(delivery)) return "delivered";
  if (["waiting", "pending", "unknown", "not-applicable"].includes(delivery)) return "";
  return row.deliveryStatus || "";
}

function normalizeLegacyProjectionFromTruth(row = {}) {
  return {
    ...row,
    arrivalStatus: legacyArrivalStatusFromTruth(row),
    pickupStatus: legacyPickupStatusFromTruth(row),
    deliveryStatus: legacyDeliveryStatusFromTruth(row),
  };
}

function actionCounts(actions = [], previousCounts = {}) {
  return {
    ...(previousCounts || {}),
    actions: actions.length,
    highPriority: actions.filter((action) => /^(?:immediate|urgent|high)$/i.test(String(action.priority || action.urgency || ""))).length,
    missingRecipients: actions.filter((action) => !(action.to || action.recipient || action.recipientEmail || action.email)).length,
    l2Actions: actions.filter((action) => action.autonomy?.level === "L2").length,
    draftOnlyActions: actions.filter((action) =>
      action.autonomy?.mode === "draft-only" || action.safety?.mode === "draft-only"
    ).length,
    tmsOperatorActions: actions.filter((action) =>
      action.autonomy?.mode === "operator-approved-tms" || action.safety?.mode === "operator-approved-tms"
    ).length,
    internalOperatorActions: actions.filter((action) =>
      action.autonomy?.mode === "operator-approved-internal" || action.safety?.mode === "operator-approved-internal"
    ).length,
    humanApprovalActions: actions.filter((action) => action.autonomy?.requiresHumanApproval === true).length,
    liveExecutionActions: actions.filter((action) => action.autonomy?.liveExecution === true).length,
  };
}

function actionPriorityRank(action = {}) {
  return {
    critical: 0,
    urgent: 0,
    high: 1,
    medium: 2,
    normal: 3,
    low: 4,
  }[String(action.priority || "normal").toLowerCase()] ?? 3;
}

function actionSortTier(action = {}) {
  if (Number.isFinite(Number(action.sortTier))) return Number(action.sortTier);
  if (action.workstream === "execution") return 0;
  if (action.workstream === "decision") return 1;
  if (action.workstream === "truth-repair") return 2;
  if (action.workstream === "economics") return 3;
  return 4;
}

function compareActionQueueOrder(left = {}, right = {}) {
  return actionPriorityRank(left) - actionPriorityRank(right) ||
    actionSortTier(left) - actionSortTier(right) ||
    String(left.awb || "").localeCompare(String(right.awb || "")) ||
    String(left.type || "").localeCompare(String(right.type || ""));
}

function actionAwb(action = {}) {
  return normalizeAwb(action.awb || action.normalizedAwb || action.shipmentAwb || action.mawb || action.shipmentId || "");
}

function stationMemoryMatches(shipments = []) {
  return shipments.filter((shipment) =>
    shipment.stationContext?.rememberedAt ||
      shipment.stationContext?.stationMemory ||
      shipment.stationContext?.stations?.length ||
      shipment.stationContext?.source === "Known PQ station memory"
  ).length;
}

function latestEvidence(fixture = {}) {
  return (fixture.decisiveEvidence || [])
    .filter((item) => item && item.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1) || fixture.decisiveEvidence?.at(-1) || {};
}

function eventAt(fixture = {}) {
  return latestEvidence(fixture).at || SNAPSHOT_TIME;
}

function gateFromFixture(fixture, gateName, fallbackStatus) {
  const evidence = latestEvidence(fixture);
  const status = expectedGateStatus(fixture, gateName, fallbackStatus);
  const genericPendingEvidence = UNKNOWN_GATE_STATUSES.has(status.toLowerCase()) && status.toLowerCase() !== "due"
    ? `${gateName} ${status}`
    : "";
  return {
    name: gateName,
    status,
    label: gateName,
    evidence: genericPendingEvidence || fixture.manualTruth || evidence.summary || `${gateName} inferred from manual Gmail truth.`,
    confidence: "manual-gmail-truth",
    source: "manual-gmail-truth",
    at: evidence.at || SNAPSHOT_TIME,
    threadId: evidence.threadId || "",
    messageId: evidence.messageId || "",
  };
}

function gateTruthStatus(status) {
  const raw = String(status || "").toLowerCase();
  if (TRUE_GATE_STATUSES.has(raw)) return "true";
  if (["blocked", "customs-hold", "hold", "exam-hold", "exception", "problem"].includes(raw)) return "blocked";
  if (UNKNOWN_GATE_STATUSES.has(raw)) return "unknown";
  return raw || "unknown";
}

function phasePreferredGateStatuses(phase = "", gateName = "") {
  const key = `${String(phase || "").toLowerCase()}:${String(gateName || "").toLowerCase()}`;
  return {
    "customs-hold:customs": ["customs-hold", "blocked", "hold", "exam-hold", "pending", "waiting"],
    "customs-hold:pickup": ["blocked", "waiting", "unknown"],
    "release-needed:customs": ["pending", "needed", "waiting", "missing", "unknown"],
    "release-needed:pickup": ["waiting", "blocked", "unknown"],
    "fees-needed:fees": ["due", "pending", "unpaid"],
    "ready-for-pickup:customs": ["released", "cleared", "done"],
    "ready-for-pickup:fees": ["paid", "done"],
    "ready-for-pickup:dispatch": ["broker-awarded", "dispatched", "done", "sent", "broker-alerted", "quote-received", "quotes-in", "unknown"],
    "pod-needed:pickup": ["picked-up", "done", "inferred"],
    "pod-needed:pod": ["pending", "waiting"],
    "picked-up:pickup": ["picked-up", "done", "inferred"],
    "picked-up:pod": ["pending", "waiting"],
    "delivered:delivery": ["delivered", "done"],
    "delivered:pod": ["received", "done", "pod-found", "found"],
    "pre-arrival:arrival": ["not-arrived", "waiting", "unknown"],
    "exception:arrival": ["not-arrived", "waiting", "unknown"],
    "pickup-docs-needed:arrival": ["not-arrived", "waiting", "unknown"],
    "pickup-docs-needed:customs": ["unknown", "waiting", "pending"],
    "pickup-docs-needed:dispatch": ["waiting", "unknown"],
    "pickup-docs-needed:pickup": ["blocked", "waiting", "pending", "unknown"],
  }[key] || [];
}

function expectedGateStatus(fixture = {}, gateName = "", fallbackStatus = "") {
  const allowed = (fixture.expectedGates?.[gateName] || [])
    .map((status) => String(status || "").toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return String(fallbackStatus || "unknown");
  const preferred = phasePreferredGateStatuses(fixture.expectedPhase, gateName);
  return preferred.find((status) => allowed.includes(status)) || allowed[0] || String(fallbackStatus || "unknown");
}

function primaryGateStatus(gates = {}, name, fallback = "") {
  return String(gates?.[name]?.status || fallback || "").toLowerCase();
}

function unknownsFromGates(gates = {}) {
  return Object.entries(gates)
    .filter(([, gate]) => UNKNOWN_GATE_STATUSES.has(String(gate?.status || "").toLowerCase()))
    .map(([name, gate]) => ({
      gate: name,
      reason: gate?.evidence || gate?.status || "unknown",
    }));
}

function compactUnknownsForRow(row = {}, gates = {}, phase = "") {
  if (String(phase || "").toLowerCase() === "delivered") return [];
  return unknownsFromGates(gates)
    .filter((item, index, all) => all.findIndex((candidate) => String(candidate.gate || "") === String(item.gate || "")) === index);
}

function sourceFactFromEvidence(fixture, evidence, type) {
  const awb = normalizeAwb(fixture.awb);
  return {
    id: [awb, "manual-gmail-truth", evidence.threadId, evidence.messageId, type].filter(Boolean).join(":"),
    awbs: [awb],
    type,
    sourceSystem: "gmail",
    sourceRef: {
      threadId: evidence.threadId || "",
      messageId: evidence.messageId || "",
      source: "manual-gmail-truth",
    },
    observedAt: evidence.at || SNAPSHOT_TIME,
    capturedAt: SNAPSHOT_TIME,
    actor: "manual Gmail review",
    claim: evidence.summary || fixture.manualTruth || type,
    confidenceInput: "manual-gmail-truth",
    rawSnippet: evidence.summary || fixture.manualTruth || "",
  };
}

function manualCurrentGmailTruthSourceFact(fact = {}) {
  return fact.sourceRef?.source === "manual-gmail-truth" ||
    fact.confidenceInput === "manual-gmail-truth" ||
    /manual[-_]gmail[-_]truth/i.test(`${fact.id || ""} ${fact.type || ""} ${fact.source || ""}`);
}

function fixtureForbiddenSourceFact(fixture = {}, fact = {}) {
  const text = JSON.stringify(fact || {});
  return (fixture.mustNotInclude || []).some((term) => {
    const value = String(term || "").trim();
    return value && text.toLowerCase().includes(value.toLowerCase());
  });
}

function sourceFactsForFixture(fixture, extraTypes = []) {
  const types = extraTypes.length ? extraTypes : ["manual_gmail_truth"];
  return (fixture.decisiveEvidence || []).flatMap((item) =>
    (item.sourceFactTypes || types).map((type) => sourceFactFromEvidence(fixture, item, type)),
  );
}

function evidenceProof(fixture) {
  return (fixture.decisiveEvidence || []).map((evidence) => ({
    label: "manual-gmail-truth",
    note: evidence.summary || fixture.manualTruth || "",
    at: evidence.at || SNAPSHOT_TIME,
    threadId: evidence.threadId || "",
    messageId: evidence.messageId || "",
    source: "manual-gmail-truth",
  }));
}

function phaseSummary(phase = "") {
  return {
    "arrival-incomplete": "Arrival incomplete",
    "customs-hold": "Customs hold",
    "delivery-blocked": "Delivery blocked",
    "delivered": "Delivered; POD received",
    "fees-needed": "Fees needed",
    "in-transit": "In transit",
    "pickup-blocked": "Pickup blocked",
    "pickup-scheduled": "Pickup scheduled",
    "pod-needed": "Picked up; POD needed",
    "pre-arrival": "Pre-arrival",
    "ready-for-pickup": "Ready for pickup",
    "release-needed": "Release needed",
  }[String(phase || "").toLowerCase()] || String(phase || "").replace(/-/g, " ");
}

function manualNextAction(fixture) {
  if (fixture.expectedNextAction) return fixture.expectedNextAction;
  const dispatch = fixture.expectedDispatch || {};
  const phase = String(fixture.expectedPhase || "").toLowerCase();
  const feeStatus = String((fixture.expectedGates?.fees || [])[0] || "").toLowerCase();
  const broker = dispatch.broker || "the pickup broker";
  const dispatchStatus = String((fixture.expectedGates?.dispatch || [])[0] || dispatch.status || "").toLowerCase();
  if (phase === "delivered") return "No action; POD is in memory.";
  if (phase === "fees-needed" || ["due", "pending", "unpaid"].includes(feeStatus)) {
    return `Confirm/pay ground handling or storage fees${dispatch.broker ? `, keep ${dispatch.broker} as pickup broker` : ""}, then track pickup execution and POD.`;
  }
  if (["broker-awarded", "done", "sent", "dispatched"].includes(dispatchStatus)) {
    return `Confirm pickup execution with ${broker}; collect loaded proof and POD.`;
  }
  if (dispatchStatus === "broker-alerted") {
    return `Confirm ${broker} pickup acceptance/execution and collect loaded proof/POD.`;
  }
  if (["quote-received", "quotes-in"].includes(dispatchStatus)) {
    return `Approve/award ${broker}${dispatch.amount ? ` at ${dispatch.amount}` : ""} or choose another pickup broker; then track pickup execution and POD.`;
  }
  if (phase === "ready-for-pickup") return "Confirm pickup broker/dispatch path.";
  if (phase === "release-needed") return "Find the release/DO source before chasing customs.";
  return "Review manual Gmail truth and continue from the canonical state.";
}

function freightBrokerFromFixture(fixture, base = {}) {
  const dispatch = fixture.expectedDispatch || {};
  const broker = dispatch.broker || "";
  if (!broker) {
    const fixtureDispatchStatuses = fixture.expectedGates?.dispatch || [];
    if (fixtureDispatchStatuses.length) return undefined;
    return base.freightBroker;
  }
  const status = String((fixture.expectedGates?.dispatch || [])[0] || dispatch.status || "").toLowerCase();
  if (["quote-received", "quotes-in"].includes(status)) {
    return {
      broker,
      status: "quote-received",
      brokerStatus: "pickup-quote-received",
      pickupPlan: dispatch.evidence || `${broker} quoted pickup${dispatch.amount ? ` at ${dispatch.amount}` : ""}.`,
      nextAction: manualNextAction(fixture),
      contactEmail: dispatch.contactEmail || "",
      rate: dispatch.amount || "",
      source: "manual-gmail-truth",
      evidence: evidenceProof(fixture),
    };
  }
  if (status === "broker-alerted") {
    return {
      broker,
      status: "alert-sent",
      brokerStatus: "pickup-alert-sent",
      pickupPlan: dispatch.evidence || `${broker} received the pickup/inbound alert.`,
      nextAction: manualNextAction(fixture),
      contactEmail: dispatch.contactEmail || "",
      rate: dispatch.amount || "",
      source: "manual-gmail-truth",
      evidence: evidenceProof(fixture),
    };
  }
  return {
    broker,
    status: "freight-awarded",
    brokerStatus: "pickup-owner-confirmed",
    pickupPlan: dispatch.evidence || `${broker} is the confirmed pickup owner.`,
    nextAction: manualNextAction(fixture),
    contactEmail: dispatch.contactEmail || "",
    rate: dispatch.amount || "",
    source: "manual-gmail-truth",
    evidence: evidenceProof(fixture),
  };
}

function customsBrokerFromFixture(fixture, base = {}, gates = {}) {
  const expected = fixture.expectedCustomsBroker || {};
  const gateStatus = primaryGateStatus(gates, "customs");
  const broker = expected.broker || base.customsBroker?.broker || base.contacts?.customs?.name || "";
  const status = String(expected.status || "").trim() ||
    (["done", "released", "cleared"].includes(gateStatus) ? "customs-cleared" : "") ||
    (["blocked", "customs-hold", "hold", "exam-hold"].includes(gateStatus) ? "customs-hold" : "") ||
    (["pending", "waiting"].includes(gateStatus) ? "customs-pending" : "") ||
    base.customsBroker?.status ||
    "";
  if (!broker && !status) return base.customsBroker;
  const evidence = expected.evidence || fixture.manualTruth || latestEvidence(fixture).summary || "";
  return {
    ...(base.customsBroker || {}),
    broker,
    status,
    brokerStatus: expected.brokerStatus || evidence,
    nextAction: expected.nextAction || manualNextAction(fixture),
    contactEmail: expected.contactEmail || base.customsBroker?.contactEmail || base.contacts?.customs?.email || "",
    source: "manual-gmail-truth",
    evidence: evidenceProof(fixture),
  };
}

function manualCoverageForFixture(fixture = {}) {
  const evidence = latestEvidence(fixture);
  const at = evidence.at || SNAPSHOT_TIME;
  return {
    awb: displayAwb(fixture.awb),
    status: "manual-reviewed",
    problem: false,
    reason: "Manual Gmail review applied to the canonical truth packet.",
    latestReadMessageAt: at,
    latestProofMessageAt: at,
    requiredEventTypes: [],
  };
}

function timeMs(value = "") {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function coverageWithFreshnessPolicy(coverage = {}) {
  const latestReadAtMs = timeMs(coverage.latestReadMessageAt);
  const latestProofAtMs = timeMs(coverage.latestProofMessageAt);
  if (
    latestReadAtMs &&
    latestProofAtMs &&
    latestReadAtMs > latestProofAtMs + 60 * 1000
  ) {
    return {
      ...coverage,
      status: "manual-review-stale-proof",
      problem: true,
      reason:
        "Manual review is newer than the represented Gmail proof; rerun canonical Gmail ingestion before trusting this row.",
    };
  }
  if (latestReadAtMs && !latestProofAtMs) {
    return {
      ...coverage,
      status: "manual-review-without-proof",
      problem: true,
      reason:
        "Manual review did not leave a represented Gmail proof timestamp; rerun canonical Gmail ingestion before trusting this row.",
    };
  }
  return coverage;
}

function applyCoverageFreshness(baseFreshness = {}, coverage = null, extra = {}) {
  if (!coverage) return { ...(baseFreshness || {}), ...extra };
  return {
    ...(baseFreshness || {}),
    ...extra,
    gmailCoverageStatus: coverage.status || "",
    gmailCoverageProblem: Boolean(coverage.problem),
    gmailCoverageReason: coverage.problem ? coverage.reason || "" : "",
    gmailLatestReadMessageAt: coverage.latestReadMessageAt || "",
    gmailLatestProofMessageAt: coverage.latestProofMessageAt || "",
    manualReviewSyncedAt: SNAPSHOT_TIME,
    staleSources: coverage.problem
      ? [...new Set([...(baseFreshness?.staleSources || []), "gmail"])]
      : (baseFreshness?.staleSources || []).filter((source) => source !== "gmail"),
  };
}

function applyManualReviewCoverage(row = {}, auditItem = {}, audit = {}) {
  const awb = normalizeAwb(row.awb || row.id || auditItem.awb);
  if (!awb) return row;
  const capturedAt = audit.capturedAt || SNAPSHOT_TIME;
  const existingCoverage = row.gmailCoverage || {};
  const representedProofAt = auditItem.latestProofMessageAt || row.lastEmail?.at || row.evidencePacket?.freshness?.gmailSyncedAt || "";
  const shouldRecomputeCoverage =
    !existingCoverage.status ||
      (
        String(existingCoverage.status || "").toLowerCase() === "manual-review-stale-proof" &&
        !auditItem.latestReadMessageAt
      );
  const coverage = coverageWithFreshnessPolicy(shouldRecomputeCoverage
    ? {
        awb: displayAwb(awb),
        status: "manual-reviewed",
        problem: false,
        reason: auditItem.reason || "Manual Gmail active-inventory review found no newer terminal state change.",
        reviewedAt: capturedAt,
        latestReadMessageAt: auditItem.latestReadMessageAt || representedProofAt,
        latestProofMessageAt: representedProofAt,
        requiredEventTypes: [],
      }
    : existingCoverage);
  return {
    ...row,
    gmailCoverage: coverage,
    evidencePacket: row.evidencePacket
      ? {
          ...row.evidencePacket,
          freshness: applyCoverageFreshness(row.evidencePacket.freshness, coverage, {
            manualReviewSyncedAt: capturedAt,
          }),
        }
      : row.evidencePacket,
    truthPacket: row.truthPacket
      ? {
          ...row.truthPacket,
          freshness: applyCoverageFreshness(row.truthPacket.freshness, coverage, {
            manualReviewSyncedAt: capturedAt,
          }),
        }
      : row.truthPacket,
  };
}

function truthPacketGates(gates = {}, sourceFactIds = []) {
  return Object.entries(gates).map(([name, gate]) => ({
    gate: name,
    status: gateTruthStatus(gate.status),
    rawStatus: gate.status,
    confidence: gate.confidence,
    sourceFactIds,
    reason: gate.evidence,
    updatedAt: gate.at,
  }));
}

function activeRow(fixture, base = {}, stationMemory = {}) {
  const awb = normalizeAwb(fixture.awb);
  const display = displayAwb(fixture.awb);
  const phase = String(fixture.expectedPhase || "unknown").toLowerCase();
  const phaseSourceFactTypes = {
    "pickup-docs-needed": ["exception_pickup_docs_needed"],
    "awb-copy-needed": ["exception_awb_copy_needed"],
    "pickup-location-requested": ["exception_pickup_location_requested"],
  }[phase] || [];
  const sourceFacts = sourceFactsForFixture(fixture, [
    "manual_gmail_truth",
    ...phaseSourceFactTypes,
    ...(fixture.expectedDispatch?.broker ? ["broker_awarded"] : []),
    ...(fixture.expectedCustomsBroker?.broker ? ["customs_broker_relationship"] : []),
  ]);
  const sourceFactIds = sourceFacts.map((fact) => fact.id);
  const gates = {
    arrival: gateFromFixture(fixture, "arrival", "unknown"),
    customs: gateFromFixture(fixture, "customs", "unknown"),
    fees: gateFromFixture(fixture, "fees", "unknown"),
    dispatch: gateFromFixture(fixture, "dispatch", "unknown"),
    pickup: gateFromFixture(fixture, "pickup", "unknown"),
    delivery: gateFromFixture(fixture, "delivery", "unknown"),
    pod: gateFromFixture(fixture, "pod", "unknown"),
  };
  const dispatch = fixture.expectedDispatch || {};
  if (dispatch.broker) {
    gates.dispatch.broker = dispatch.broker;
    gates.dispatch.selectedBroker = dispatch.broker;
    gates.dispatch.contactEmail = dispatch.contactEmail || "";
    gates.dispatch.amount = dispatch.amount || "";
    gates.dispatch.evidence = dispatch.evidence || gates.dispatch.evidence;
  }
  const nextAction = manualNextAction(fixture);
  const summary = `${phaseSummary(phase)}. ${fixture.manualTruth || ""}`.trim();
  const freightBroker = freightBrokerFromFixture(fixture, base);
  const customsBroker = customsBrokerFromFixture(fixture, base, gates);
  const coverage = manualCoverageForFixture(fixture);
  const cargo = {
    pieces: base.cargo?.pieces || base.tms?.pieces || base.pieces || "source-gap",
    weight: base.cargo?.weight || base.tms?.weight || base.weight || "source-gap",
    weightUom: base.cargo?.weightUom || base.tms?.weightUom || base.weightUom || "source-gap",
    dimensions: base.cargo?.dimensions || base.tms?.dimensions || base.dimensions || "",
    dims: base.cargo?.dims || base.tms?.dims || base.dims || "",
    source: base.cargo?.source || base.tms?.source || "manual-gmail-truth",
  };
  const tms = {
    ...(base.tms || {}),
    order: base.tms?.order || base.id || base.shipmentId || awb,
    pieces: base.tms?.pieces || cargo.pieces,
    weight: base.tms?.weight || cargo.weight,
    weightUom: base.tms?.weightUom || cargo.weightUom,
    flight: base.tms?.flight || base.flightDetails?.primaryFlight || base.flight || "source-gap",
    tmsFlight: base.tms?.tmsFlight || base.flightDetails?.tmsFlight || base.flight || "source-gap",
    route: base.tms?.route || base.flightDetails?.route || base.route || "source-gap",
  };
  const flightDetails = {
    ...(base.flightDetails || {}),
    primaryFlight: base.flightDetails?.primaryFlight || tms.flight,
    tmsFlight: base.flightDetails?.tmsFlight || tms.tmsFlight,
    route: base.flightDetails?.route || tms.route,
  };
  const delivery = {
    ...(base.delivery || {}),
    fullAddress: base.delivery?.fullAddress || base.deliveryAddress || base.destinationAddress || "source-gap",
  };
  const freshness = {
    ...applyCoverageFreshness(base.evidencePacket?.freshness || {}, coverage, {
      gmailSyncedAt: eventAt(fixture),
      manualTruthSyncedAt: SNAPSHOT_TIME,
      hasGmailEvidence: true,
    }),
  };
  const evidencePacket = {
    ...(base.evidencePacket || {}),
    freshness,
    sourceFacts: [
      ...sourceFacts,
      ...((base.evidencePacket?.sourceFacts || []).filter((fact) =>
        !manualCurrentGmailTruthSourceFact(fact) &&
          !fixtureForbiddenSourceFact(fixture, fact) &&
          !sourceFacts.some((candidate) => candidate.id === fact.id)
      )),
    ],
  };
  const row = {
    ...base,
    awb: display,
    id: String(base.id || base.shipmentId || awb),
    currentState: summary,
    nextAction,
    stage: phase,
    completed: false,
    deliveredAt: "",
    deliveryStatus: base.deliveryStatus || "",
    pickupStatus: gates.pickup.status === "done" ? "picked-up" : gates.pickup.status || base.pickupStatus || "",
    clearanceStatus: TRUE_GATE_STATUSES.has(String(gates.customs.status || "").toLowerCase()) ? "released" : base.clearanceStatus || "",
    operationalRisk: {
      level: "none",
      type: "",
      reason: "",
      action: "",
      evidence: "",
      source: "manual-gmail-truth",
    },
    contacts: freightBroker
      ? { ...(base.contacts || {}), freight: freightBroker, ...(customsBroker ? { customs: customsBroker } : {}) }
      : customsBroker
        ? { ...(base.contacts || {}), customs: customsBroker }
        : base.contacts,
    cargo,
    tms,
    flightDetails,
    route: base.route || tms.route,
    delivery,
    customsBroker,
    freightBroker,
    opsState: {
      ...(base.opsState || {}),
      phase,
      label: phaseSummary(phase),
      summary,
      nextAction,
      urgency: base.opsState?.urgency || "",
      gates,
      exceptions: [],
      events: (fixture.decisiveEvidence || []).map((evidence) => ({
        awb,
        type: "manual-gmail-truth",
        at: evidence.at || SNAPSHOT_TIME,
        threadId: evidence.threadId || "",
        messageId: evidence.messageId || "",
        summary: evidence.summary || fixture.manualTruth || "",
        evidence: fixture.manualTruth || evidence.summary || "",
        confidence: "manual-gmail-truth",
      })),
      operationalRisk: {
        level: "none",
        type: "",
        reason: "",
        action: "",
        evidence: "",
        source: "manual-gmail-truth",
      },
    },
    lastEmail: {
      at: latestEvidence(fixture).at || SNAPSHOT_TIME,
      threadId: latestEvidence(fixture).threadId || "",
      messageId: latestEvidence(fixture).messageId || "",
      summary: latestEvidence(fixture).summary || fixture.manualTruth || "Manual Gmail truth applied.",
    },
    emailValidation: {
      status: phase,
      summary,
      nextAction,
      proof: evidenceProof(fixture),
      events: evidencePacket.sourceFacts.map((fact) => ({
        awb,
        type: fact.type,
        at: fact.observedAt,
        threadId: fact.sourceRef?.threadId || "",
        messageId: fact.sourceRef?.messageId || "",
        summary: fact.claim || "",
        evidence: fact.rawSnippet || "",
        confidence: "manual-gmail-truth",
      })),
    },
    reasoning: {
      ...(base.reasoning || {}),
      source: "manual-gmail-truth",
      phase,
      className: manualReasoningClassForPhase(phase),
      label: phaseSummary(phase),
      reason: fixture.manualTruth || summary,
      nextAction,
      summary,
      evidence: evidenceProof(fixture).map((item) => item.note).filter(Boolean),
    },
    gmailCoverage: coverage,
    facts: [
      {
        type: "manual-gmail-truth",
        summary: fixture.manualTruth || summary,
        at: eventAt(fixture),
      },
    ],
    factLedger: sourceFacts.map((fact) => ({
      type: fact.type,
      label: fact.type,
      summary: fact.claim,
      note: fact.rawSnippet,
      at: fact.observedAt,
      threadId: fact.sourceRef.threadId,
      messageId: fact.sourceRef.messageId,
      source: "manual-gmail-truth",
    })),
    canonical: {
      source: "manual-gmail-truth",
      phase,
      currentState: summary,
      nextAction,
      gates,
    },
    evidencePacket,
    truthPacket: {
      ...(base.truthPacket || {}),
      currentState: phase,
      phase,
      stateConfidence: "high",
      stateReason: fixture.manualTruth || summary,
      nextAction,
      compiledAt: SNAPSHOT_TIME,
      freshness: {
        ...(base.truthPacket?.freshness || {}),
        ...freshness,
      },
      gates: truthPacketGates(gates, sourceFactIds),
      unknowns: compactUnknownsForRow(base, gates, phase),
    },
    canonicalAuthority: true,
    _truthPacketSource: "shipment-truth-packets",
    _truthPacketSnapshotTime: SNAPSHOT_TIME,
    truthPacketRole: "active",
    recommendedActions: [],
    actionHistory: [],
  };
  const rebuiltPacket = buildOperatorTruthPacket(row, {});
  const rememberedStationContext = stationMemoryContextForRow(row, stationMemory);
  if (rememberedStationContext) {
    row.stationContext = rememberedStationContext;
    row.stationEmail = rememberedStationContext.stationMemory?.stationEmail || row.stationEmail || "";
    row.stationPhone = rememberedStationContext.stationMemory?.stationPhone || row.stationPhone || "";
    row.contacts = {
      ...(row.contacts || {}),
      station: {
        ...(row.contacts?.station || {}),
        name: rememberedStationContext.stationMemory?.handlerName || rememberedStationContext.stationMemory?.stationName || "",
        stationEmail: rememberedStationContext.stationMemory?.stationEmail || "",
        email: rememberedStationContext.stationMemory?.stationEmail || "",
        stationPhone: rememberedStationContext.stationMemory?.stationPhone || "",
        phone: rememberedStationContext.stationMemory?.stationPhone || "",
        source: rememberedStationContext.source,
      },
    };
  }
  row.truthPacket = {
    ...row.truthPacket,
    physicalLifecycle: rebuiltPacket.physicalLifecycle,
    operationalBlocker: rebuiltPacket.operationalBlocker,
    feeLedger: rebuiltPacket.feeLedger,
    documentRequestBlocker: rebuiltPacket.documentRequestBlocker,
    contradictions: rebuiltPacket.contradictions,
    sourceFactIds: rebuiltPacket.sourceFactIds,
  };
  return normalizeLegacyProjectionFromTruth(row);
}

function activeFixtureAction(fixture, row = {}) {
  const awb = normalizeAwb(fixture.awb);
  const nextAction = manualNextAction(fixture);
  if (!awb || !nextAction || /^no action\b/i.test(nextAction)) return null;
  const dispatch = fixture.expectedDispatch || {};
  const feeStatus = String((fixture.expectedGates?.fees || [])[0] || "").toLowerCase();
  const feesDue = String(fixture.expectedPhase || "").toLowerCase() === "fees-needed" ||
    ["due", "pending", "unpaid"].includes(feeStatus);
  const targetName = feesDue ? "Operator" : dispatch.broker || "Operator";
  const body = [
    `State: ${row.currentState || fixture.manualTruth || phaseSummary(fixture.expectedPhase)}`,
    "",
    "Recommended next steps:",
    `- ${nextAction}`,
  ].join("\n");
  return {
    id: `${awb}-manual-current-truth-action`,
    shipmentId: row.id || awb,
    awb: displayAwb(awb),
    type: feesDue ? "station-fee-confirmation" : "operator-state-check",
    label: nextAction,
    channel: "platform",
    execution: "operator-approved-internal",
    status: "suggested",
    priority: "high",
    targetName,
    targetEmail: feesDue ? "" : dispatch.contactEmail || "",
    subject: `${displayAwb(awb)} - ${nextAction}`,
    problem: row.currentState || fixture.manualTruth || phaseSummary(fixture.expectedPhase),
    reason: row.currentState || fixture.manualTruth || phaseSummary(fixture.expectedPhase),
    nextAction,
    body,
    timing: {
      stage: feesDue ? "fees-needed" : "manual-current-gmail-truth",
      trigger: feesDue ? "ground-fees-due" : "manual-current-truth-active-state",
      phase: fixture.expectedPhase || "",
    },
    evidence: (fixture.decisiveEvidence || []).map((item) => item.summary || "").filter(Boolean),
    postActionExpectedFact: feesDue
      ? "Operator records station fee amount/receipt or blocker, then pickup execution can continue with the assigned broker."
      : "Operator records pickup execution, loaded proof, delivery, POD, or the next broker reply.",
    canonicalPlannerVersion: "canonical-action-planner-v1",
    actionPlanId: `${awb}-manual-current-truth-action-plan`,
    actionPlanRole: "primary",
    eligibility: "eligible",
    actionEligibility: "eligible",
    blockedReason: "",
    sourceFactIds: (row.evidencePacket?.sourceFacts || []).map((fact) => fact.id).filter(Boolean).slice(0, 20),
    idempotencyKey: `canonical-action-planner-v1:${awb}:manual-current-truth-action`,
    workstream: feesDue ? "station" : "execution",
    sortTier: 1,
    relationshipsUsed: [
      row.station ? `station:${row.station}` : "",
      dispatch.broker ? `pickup-broker:${dispatch.broker}` : "",
    ].filter(Boolean),
    autonomy: {
      level: "L2",
      mode: "operator-approved-internal",
      label: "Save state outcome",
      requiresHumanApproval: true,
      liveExecution: true,
      transport: "operator-note",
    },
    safety: {
      mode: "operator-approved-internal",
      originalChannel: "platform",
      autonomyLevel: "L2",
      autonomyMode: "operator-approved-internal",
      internalTransport: "operator-note",
      note: "Operator-approved internal action. No outbound Gmail or CourierCloud mutation is performed.",
    },
    betaContract: {
      mode: "operator-approved-internal",
      autonomyLevel: "L2",
      requiresHumanApproval: true,
      liveExecution: true,
      internalTransport: "operator-note",
    },
    createdAt: SNAPSHOT_TIME,
    updatedAt: SNAPSHOT_TIME,
  };
}

function terminalRow(fixture, base = {}, stationMemory = {}) {
  const awb = normalizeAwb(fixture.awb);
  const display = displayAwb(fixture.awb);
  const evidence = latestEvidence(fixture);
  const sourceFacts = sourceFactsForFixture(fixture, ["delivery_reported", "pod_received"]);
  const gates = {
    arrival: gateFromFixture(fixture, "arrival", "done"),
    customs: gateFromFixture(fixture, "customs", "unknown-offline"),
    fees: gateFromFixture(fixture, "fees", "unknown-offline"),
    dispatch: gateFromFixture(fixture, "dispatch", "offline-inferred"),
    pickup: gateFromFixture(fixture, "pickup", "inferred"),
    delivery: gateFromFixture(fixture, "delivery", "delivered"),
    pod: gateFromFixture(fixture, "pod", "received"),
  };
  const terminalEvents = [
    {
      awb,
      type: "delivered-reported",
      at: evidence.at || SNAPSHOT_TIME,
      threadId: evidence.threadId || "",
      messageId: evidence.messageId || "",
      summary: "Delivery was reported by manual Gmail truth.",
      evidence: fixture.manualTruth || evidence.summary || "",
      confidence: "manual-gmail-truth",
    },
    {
      awb,
      type: "pod-received",
      at: evidence.at || SNAPSHOT_TIME,
      threadId: evidence.threadId || "",
      messageId: evidence.messageId || "",
      summary: "Delivery/POD evidence was received by manual Gmail truth.",
      evidence: fixture.manualTruth || evidence.summary || "",
      confidence: "manual-gmail-truth",
    },
  ];
  const deliveryAddress = base.delivery?.fullAddress || base.deliveryAddress || "Completed shipment delivery address is not available in local archive.";
  const cargo = {
    pieces: base.cargo?.pieces || base.tms?.pieces || base.pieces || "source-gap",
    weight: base.cargo?.weight || base.tms?.weight || base.weight || "source-gap",
    weightUom: base.cargo?.weightUom || base.tms?.weightUom || base.weightUom || "source-gap",
    dimensions: base.cargo?.dimensions || base.tms?.dimensions || base.dimensions || "",
    dims: base.cargo?.dims || base.tms?.dims || base.dims || "",
    source: base.cargo?.source || "manual-gmail-truth",
  };
  const tms = {
    ...(base.tms || {}),
    order: base.tms?.order || base.id || base.shipmentId || awb,
    pieces: base.tms?.pieces || cargo.pieces,
    weight: base.tms?.weight || cargo.weight,
    weightUom: base.tms?.weightUom || cargo.weightUom,
    flight: base.tms?.flight || base.flightDetails?.primaryFlight || "source-gap",
    tmsFlight: base.tms?.tmsFlight || base.flightDetails?.tmsFlight || base.flight || "source-gap",
    route: base.tms?.route || base.flightDetails?.route || base.route || "source-gap",
  };
  const dispatch = fixture.expectedDispatch || {};
  const terminalFreightBroker = dispatch.broker || base.freightBroker?.broker
    ? {
        broker: dispatch.broker || base.freightBroker?.broker || "",
        status: "freight-completed",
        brokerStatus: "delivery-pod-complete",
        pickupPlan: "Pickup/delivery execution is complete.",
        nextAction: "No action; POD is in memory.",
        contactEmail: dispatch.contactEmail || base.freightBroker?.contactEmail || "",
        rate: dispatch.amount || base.freightBroker?.rate || "",
        source: "manual-gmail-truth",
        evidence: evidenceProof(fixture),
      }
    : undefined;
  const row = {
    ...base,
    awb: display,
    id: String(base.id || base.shipmentId || awb),
    client: base.client || "manual Gmail truth fixture",
    consignee: base.consignee || base.delivery?.consignee || "",
    station: base.station || base.destination || "",
    eta: "Delivered; POD received",
    cargo,
    tms,
    flightDetails: {
      ...(base.flightDetails || {}),
      primaryFlight: base.flightDetails?.primaryFlight || tms.flight,
      tmsFlight: base.flightDetails?.tmsFlight || tms.tmsFlight,
      route: base.flightDetails?.route || tms.route,
      etaHint: "Delivered; POD received",
      recoveryHint: "Delivered; POD received",
      source: base.flightDetails?.source || "manual-gmail-truth",
    },
    route: base.route || tms.route,
    delivery: {
      ...(base.delivery || {}),
      fullAddress: deliveryAddress,
      source: base.delivery?.source || "manual-gmail-truth",
    },
    contacts: terminalFreightBroker
      ? {
          ...(base.contacts || {}),
          freight: terminalFreightBroker,
        }
      : base.contacts,
    freightBroker: terminalFreightBroker || base.freightBroker,
    stage: "delivered",
    currentState: `Delivered; POD received. ${fixture.manualTruth || ""}`.trim(),
    nextAction: "No action; POD is in memory.",
    storage: null,
    operationalRisk: {
      level: "none",
      type: "",
      reason: "",
      action: "",
      evidence: "",
      source: "manual-gmail-truth",
    },
    deliveryStatus: "delivered",
    deliveredAt: evidence.at || base.deliveredAt || base.completedAt || SNAPSHOT_TIME,
    pickupStatus: "picked-up",
    completed: true,
    opsState: {
      ...(base.opsState || {}),
      phase: "delivered",
      label: "Delivered; POD received",
      summary: `Delivered; POD received. ${fixture.manualTruth || ""}`.trim(),
      nextAction: "No action; POD is in memory.",
      urgency: "closed",
      gates,
      exceptions: [],
      events: terminalEvents,
      operationalRisk: {
        level: "none",
        type: "",
        reason: "",
        action: "",
        evidence: "",
        source: "manual-gmail-truth",
      },
    },
    lastEmail: {
      at: evidence.at || SNAPSHOT_TIME,
      threadId: evidence.threadId || "",
      messageId: evidence.messageId || "",
      summary: evidence.summary || fixture.manualTruth || "Delivered/POD truth confirmed by manual Gmail review.",
    },
    emailValidation: {
      status: "delivered",
      summary: fixture.manualTruth || "Delivered/POD truth confirmed by manual Gmail review.",
      nextAction: "No action; POD is in memory.",
      proof: evidenceProof(fixture),
      events: terminalEvents,
    },
    reasoning: {
      ...(base.reasoning || {}),
      source: "manual-gmail-truth",
      summary: fixture.manualTruth || "Delivered/POD truth confirmed by manual Gmail review.",
      evidence: evidenceProof(fixture).map((item) => item.note).filter(Boolean),
    },
    facts: [
      {
        type: "manual-gmail-truth",
        summary: fixture.manualTruth || "Delivered/POD truth confirmed.",
        at: evidence.at || SNAPSHOT_TIME,
        threadId: evidence.threadId || "",
        messageId: evidence.messageId || "",
      },
    ],
    factLedger: sourceFacts.map((fact) => ({
      type: fact.type,
      label: fact.type,
      summary: fact.claim,
      note: fact.rawSnippet,
      at: fact.observedAt,
      threadId: fact.sourceRef.threadId,
      messageId: fact.sourceRef.messageId,
      source: "manual-gmail-truth",
    })),
    canonical: {
      source: "manual-gmail-truth",
      phase: "delivered",
      currentState: "Delivered; POD received.",
      nextAction: "No action; POD is in memory.",
      gates,
    },
    evidencePacket: {
      ...(base.evidencePacket || {}),
      freshness: {
        ...(base.evidencePacket?.freshness || {}),
        gmailSyncedAt: evidence.at || SNAPSHOT_TIME,
        manualTruthSyncedAt: SNAPSHOT_TIME,
        hasGmailEvidence: true,
        staleSources: (base.evidencePacket?.freshness?.staleSources || []).filter((source) => source !== "gmail"),
      },
      sourceFacts,
    },
    truthPacket: {
      ...(base.truthPacket || {}),
      currentState: "delivered",
      phase: "delivered",
      stateConfidence: "high",
      stateReason: fixture.manualTruth || "Delivered/POD truth confirmed by manual Gmail review.",
      nextAction: "No action; POD is in memory.",
      compiledAt: SNAPSHOT_TIME,
      freshness: {
        ...(base.truthPacket?.freshness || {}),
        gmailSyncedAt: evidence.at || SNAPSHOT_TIME,
        manualTruthSyncedAt: SNAPSHOT_TIME,
        hasGmailEvidence: true,
        staleSources: (base.truthPacket?.freshness?.staleSources || []).filter((source) => source !== "gmail"),
      },
      gates: truthPacketGates(gates, sourceFacts.map((fact) => fact.id)),
      unknowns: [],
    },
    canonicalAuthority: true,
    _truthPacketSource: "shipment-truth-packets",
    _truthPacketSnapshotTime: SNAPSHOT_TIME,
    truthPacketRole: "completed",
    recommendedActions: [],
    actionHistory: [],
  };
  retireStaleActionTextForCompletedRow(row);
  const rebuiltPacket = buildOperatorTruthPacket(row, {});
  const rememberedStationContext = stationMemoryContextForRow(row, stationMemory);
  if (rememberedStationContext) {
    row.stationContext = rememberedStationContext;
    row.stationEmail = rememberedStationContext.stationMemory?.stationEmail || row.stationEmail || "";
    row.stationPhone = rememberedStationContext.stationMemory?.stationPhone || row.stationPhone || "";
    row.contacts = {
      ...(row.contacts || {}),
      station: {
        ...(row.contacts?.station || {}),
        name: rememberedStationContext.stationMemory?.handlerName || rememberedStationContext.stationMemory?.stationName || "",
        stationEmail: rememberedStationContext.stationMemory?.stationEmail || "",
        email: rememberedStationContext.stationMemory?.stationEmail || "",
        stationPhone: rememberedStationContext.stationMemory?.stationPhone || "",
        phone: rememberedStationContext.stationMemory?.stationPhone || "",
        source: rememberedStationContext.source,
      },
    };
  }
  row.truthPacket = {
    ...row.truthPacket,
    physicalLifecycle: rebuiltPacket.physicalLifecycle,
    operationalBlocker: rebuiltPacket.operationalBlocker,
    feeLedger: rebuiltPacket.feeLedger,
    documentRequestBlocker: rebuiltPacket.documentRequestBlocker,
    contradictions: rebuiltPacket.contradictions,
    sourceFactIds: rebuiltPacket.sourceFactIds,
  };
  return row;
}

function normalizeTruthPacketAuthority(row = {}, stationMemory = {}) {
  const phase = String(row.opsState?.phase || row.stage || row.truthPacket?.phase || row.currentState || "").toLowerCase();
  const role = row.truthPacketRole ||
    (row.completed || phase === "delivered" || phase === "closed" || phase === "completed" ? "completed" : "active");
  let nextRow = {
    ...row,
  };
  const rememberedStationContext = stationMemoryContextForRow(nextRow, stationMemory);
  if (rememberedStationContext && !(nextRow.stationContext?.stations || []).length) {
    nextRow.stationContext = rememberedStationContext;
  }
  if (rememberedStationContext && !nextRow.stationEmail) {
    nextRow.stationEmail = rememberedStationContext.stationMemory?.stationEmail || "";
  }
  if (rememberedStationContext && !nextRow.stationPhone) {
    nextRow.stationPhone = rememberedStationContext.stationMemory?.stationPhone || "";
  }
  if (role === "completed") {
    nextRow.stationContext = completedStationContext(nextRow.stationContext);
  }
  nextRow.factLedger = factsWithStorageFact(nextRow);
  nextRow = {
    ...nextRow,
    canonicalAuthority: true,
    _truthPacketSource: "shipment-truth-packets",
    _truthPacketSnapshotTime: row._truthPacketSnapshotTime || SNAPSHOT_TIME,
    truthPacketRole: role,
    truthPacket: {
      ...(row.truthPacket || {}),
      currentState: row.truthPacket?.currentState || phase || row.stage || row.currentState || "unknown",
      phase: row.truthPacket?.phase || phase || row.stage || "",
    },
  };
  return normalizeLegacyProjectionFromTruth(nextRow);
}

function main() {
  const packets = readJson("shipment-truth-packets.json", { shipments: [] });
  const stationMemory = readJson("station-memory.json", { contacts: [] });
  const fixtures = readJson("data/manual-gmail-truth/current-awbs.json", { shipments: [] });
  const audit = readJson("data/manual-gmail-truth/past-24h-state-changing-emails.json", {});
  const completedRows = readJsonLines("completed-shipments.jsonl");
  const completedByAwb = new Map(completedRows.map((row) => [normalizeAwb(row.awb || row.shipmentId), row]));
  const rowsByAwb = new Map((packets.shipments || []).map((row) => [normalizeAwb(row.awb || row.id || row.shipmentId), row]));
  const terminalFixtures = (fixtures.shipments || []).filter((fixture) => fixture.expectedPhase === "delivered");
  const activeFixtures = (fixtures.shipments || []).filter((fixture) => fixture.expectedPhase && fixture.expectedPhase !== "delivered");
  const terminalAwbs = new Set(terminalFixtures.map((fixture) => normalizeAwb(fixture.awb)));
  const activeFixtureByAwb = new Map(activeFixtures.map((fixture) => [normalizeAwb(fixture.awb), fixture]));
  const nextRowsByAwb = new Map(rowsByAwb);

  for (const fixture of activeFixtures) {
    const awb = normalizeAwb(fixture.awb);
    const base = rowsByAwb.get(awb) || {};
    nextRowsByAwb.set(awb, activeRow(fixture, base, stationMemory));
  }

  for (const fixture of terminalFixtures) {
    const awb = normalizeAwb(fixture.awb);
    const base = rowsByAwb.get(awb) || completedByAwb.get(awb) || {};
    nextRowsByAwb.set(awb, terminalRow(fixture, base, stationMemory));
  }

  for (const item of audit.reviewedActiveRowsWithoutManualTerminalChange || []) {
    const awb = normalizeAwb(item.awb);
    if (!awb || terminalAwbs.has(awb)) continue;
    const row = nextRowsByAwb.get(awb);
    if (!row) continue;
    nextRowsByAwb.set(awb, applyManualReviewCoverage(row, item, audit));
  }

  const shipments = [...nextRowsByAwb.values()]
    .map((row) => normalizeTruthPacketAuthority(row, stationMemory))
    .sort((a, b) => normalizeAwb(a.awb || a.id).localeCompare(normalizeAwb(b.awb || b.id)));
  // Primary executable action must attach BEFORE the packet write — rows serialize here.
  // Recipient/thread/cc decisions read real message rosters from the proof snapshot.
  const gmailProofForActions = readJson("gmail-proof-snapshot.json", { proofs: [] });
  const gmailProofByAwb = new Map(
    (gmailProofForActions.proofs || []).map((proof) => [normalizeAwb(proof.awb || proof.normalizedAwb), proof]),
  );
  for (let index = 0; index < shipments.length; index += 1) {
    const row = shipments[index];
    if (String(row.truthPacketRole || "active").toLowerCase() !== "active") continue;
    const plan = buildCanonicalActionPlan(row, row.recommendedActions || [], { gmailProofByAwb });
    shipments[index] = { ...row, primaryAction: platformExecutableAction(plan.primaryAction, row) };
    nextRowsByAwb.set(normalizeAwb(row.awb || row.id), shipments[index]);
  }
  const activeShipments = shipments.filter((row) => String(row.truthPacketRole || "active").toLowerCase() === "active");
  const completedShipments = shipments.filter((row) => String(row.truthPacketRole || "").toLowerCase() === "completed");
  const completedAwbs = new Set(completedShipments.map((row) => normalizeAwb(row.awb || row.id)).filter(Boolean));
  const nextPackets = {
    ...packets,
    snapshotTime: SNAPSHOT_TIME,
    sourceOfTruth: "Canonical shipment truth packets are the only operational state authority. Manual current-Gmail truth may close terminal packets or repair active gate relationships until hosted Gmail OAuth publishes the same evidence with per-AWB newest-message coverage.",
    writerVersion: appendUniqueSuffix(packets.writerVersion || "shipment-truth-packets-v1", WRITER_SUFFIX),
    counts: {
      ...(packets.counts || {}),
      shipments: shipments.length,
      activeShipments: activeShipments.length,
      completedShipments: completedShipments.length,
      evidenceOnlyShipments: shipments.filter((row) => String(row.truthPacketRole || "").toLowerCase() === "evidence-only").length,
      stationMemoryMatches: stationMemoryMatches(activeShipments),
      manualCurrentTruthActiveShipments: activeFixtures.length,
      manualCurrentTruthCompletedShipments: terminalFixtures.length,
      manualPast24hReviewedActiveShipments: (audit.reviewedActiveRowsWithoutManualTerminalChange || []).length,
    },
    activeAwbs: activeShipments.map((row) => normalizeAwb(row.awb || row.id)).filter(Boolean).sort(),
    completedAwbs: [...completedAwbs].sort(),
    shipments,
  };
  nextPackets.contentSignature = signature(nextPackets);
  writeJson("shipment-truth-packets.json", nextPackets);

  const queue = readJson("action-queue.json", { actions: [] });
  const originalActionCount = (queue.actions || []).length;
  const fixtureActionCandidates = new Map();
  const actions = [];
  for (const action of queue.actions || []) {
    const awb = actionAwb(action);
    if (terminalAwbs.has(awb)) continue;
    if (activeFixtureByAwb.has(awb)) {
      if (!fixtureActionCandidates.has(awb)) fixtureActionCandidates.set(awb, []);
      fixtureActionCandidates.get(awb).push(action);
      continue;
    }
    actions.push(action);
  }
  const filteredActionCount = actions.length;
  for (const [awb, fixture] of activeFixtureByAwb) {
    const row = nextRowsByAwb.get(awb);
    const plan = buildCanonicalActionPlan(row, fixtureActionCandidates.get(awb) || [], { gmailProofByAwb });
    const plannedActions = (plan.actions || []).filter(Boolean);
    if (plannedActions.length) {
      actions.push(...plannedActions);
      continue;
    }
    const fallbackAction = activeFixtureAction(fixture, row);
    if (fallbackAction) actions.push(fallbackAction);
  }
  const orderedActions = actions.slice().sort(compareActionQueueOrder);
  const nextQueue = {
    ...queue,
    snapshotTime: SNAPSHOT_TIME,
    source: appendUniqueSuffix(queue.source || "action-queue", `${WRITER_SUFFIX}-prune`),
    counts: actionCounts(orderedActions, queue.counts),
    actions: orderedActions,
    prunedByManualCurrentTruth: originalActionCount - filteredActionCount,
    addedByManualCurrentTruth: actions.length - filteredActionCount,
  };
  nextQueue.contentSignature = signature(nextQueue);
  writeJson("action-queue.json", nextQueue);

  console.log(JSON.stringify({
    ok: true,
    activeApplied: activeFixtures.length,
    completedApplied: terminalFixtures.length,
    packetShipments: shipments.length,
    activeShipments: activeShipments.length,
    completedShipments: completedShipments.length,
    prunedActions: nextQueue.prunedByManualCurrentTruth,
    addedActions: nextQueue.addedByManualCurrentTruth,
  }, null, 2));
}

main();

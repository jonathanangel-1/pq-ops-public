"use strict";

// Urgent operational interrupts (driver-on-site lane).
//
// A message like "driver is on site but cannot pick up because X" is an
// INTERRUPT, not inbox noise: it must become the top recommended work, show a
// non-destructive toast, and carry a specific prepared action. One interrupt
// per shipment; a later pickup confirmation or "all good" supersedes it.

const { classifyDeliveryWaitText, deliveryWaitForShipment } = require("./delivery-wait");

const CAUSES = [
  {
    cause: "fees",
    pattern: /\b(?:fees?|charges?|payment|cargosprint|storage|balance)\b[^.;\n]{0,90}\b(?:due|unpaid|not (?:been )?paid|required|must be paid|before (?:release|pickup)|outstanding)\b|\bbecause of (?:the )?fees?\b/i,
    title: (awb) => `Driver stuck at pickup — ${awb}: fees blocking release`,
    preparedAction: "Call the station now — confirm the fee balance and get it paid/verified before the driver leaves.",
    audience: "station",
  },
  {
    cause: "cargo-unavailable",
    pattern: /\b(?:cargo|freight|shipment|pieces?|pcs?)\b[^.;\n]{0,90}\b(?:not (?:found|on hand|located|available|releasable)|missing|can'?t (?:be )?(?:found|located)|cannot (?:be )?(?:found|located)|unavailable)\b/i,
    title: (awb) => `Driver stuck at pickup — ${awb}: cargo not available`,
    preparedAction: "Call the station now — locate the cargo and confirm on-hand while the driver waits.",
    audience: "station",
  },
  {
    cause: "docs-release",
    pattern: /\b(?:release|d\/?o|delivery order|docs?|paperwork|clearance)\b[^.;\n]{0,90}\b(?:missing|not (?:visible|received|available|in hand|in (?:the )?system)|can'?t see|cannot see|needed|required|doesn'?t (?:have|show))\b|\b(?:no|without)\s+(?:release|d\/?o|delivery order)\b/i,
    title: (awb) => `Driver stuck at pickup — ${awb}: release/docs not there`,
    preparedAction: "Send/confirm the release and delivery order with the station and broker right now.",
    audience: "broker",
  },
];

function driverOnSiteText(text = "") {
  return /\b(?:driver|truck(?:er)?|carrier)\b[^.;\n]{0,120}\b(?:on[-\s]?site|onsite|at (?:the )?(?:airport|station|terminal|warehouse|cargo|pick[-\s]?up)|waiting|standby|sitting)\b/i.test(text) ||
    /\b(?:i am|i'?m|we are|we'?re)\s+(?:on[-\s]?site|onsite|at (?:the )?(?:station|terminal|warehouse|airport))\b/i.test(text);
}

function pickupBlockedText(text = "") {
  return /\b(?:cannot|can'?t|unable to|not able to|won'?t let|refus(?:ed|ing)|blocked from|being turned away)\b[^.;\n]{0,80}\b(?:pick|load|recover|collect|release)\b/i.test(text) ||
    /\b(?:cannot|can'?t) pick(?: it| this)? up\b/i.test(text) ||
    /\bpickup (?:is )?(?:blocked|refused|denied)\b/i.test(text);
}

function resolutionText(text = "") {
  return (/\b(?:picked(?:\s+it)?\s+up|pickup (?:complete|completed|done|confirmed)|driver (?:is )?loaded|loaded and|recovered|collected)\b/i.test(text) &&
    !/\b(?:cannot|can'?t|unable|not)\b[^.;\n]{0,40}\b(?:pick|load)\b/i.test(text)) ||
    /\b(?:all good|all set|we'?re good|sorted|resolved|issue (?:is )?(?:resolved|fixed|cleared)|never ?mind|false alarm)\b/i.test(text);
}

function factTimeMs(fact = {}) {
  const parsed = Date.parse(fact.observedAt || fact.capturedAt || fact.at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function factText(fact = {}) {
  return [fact.claim, fact.rawSnippet, fact.summary, fact.note].filter(Boolean).join(" ");
}

function shipmentFacts(row = {}) {
  const pools = [
    ...(Array.isArray(row.evidencePacket?.sourceFacts) ? row.evidencePacket.sourceFacts : []),
    ...(Array.isArray(row.facts) ? row.facts : []),
  ];
  return pools;
}

// One interrupt per shipment: the latest unresolved driver-stuck event, or
// null when none exists / a later confirmation superseded it.
function classifyUrgentInterrupt(row = {}) {
  const awb = row.awb || row.id || "";
  const facts = shipmentFacts(row);
  let interruptFact = null;
  let resolutionAt = 0;
  for (const fact of facts) {
    const text = factText(fact);
    if (!text) continue;
    if (resolutionText(text)) {
      resolutionAt = Math.max(resolutionAt, factTimeMs(fact));
      continue;
    }
    if (driverOnSiteText(text) && pickupBlockedText(text)) {
      if (!interruptFact || factTimeMs(fact) > factTimeMs(interruptFact)) interruptFact = fact;
    }
  }
  // The truth packet itself can resolve the interrupt (pickup gate done or a
  // post-pickup state), whatever the fact timestamps say.
  const packetState = String(row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || "").toLowerCase();
  const pickupDone = ["picked_up", "out_for_delivery", "delivered", "closed"].includes(packetState);
  if (!interruptFact || pickupDone) return null;
  if (resolutionAt && resolutionAt >= factTimeMs(interruptFact)) return null;

  const text = factText(interruptFact);
  const matched = CAUSES.find((candidate) => candidate.pattern.test(text));
  const awbKey = String(awb).replace(/\D/g, "");
  const cause = matched?.cause || "unknown";
  return {
    id: `ui:${awbKey}:driver-stuck:${cause}`,
    awb,
    kind: "driver-stuck",
    cause,
    urgent: true,
    title: matched ? matched.title(awb) : `Driver stuck at pickup — ${awb}`,
    message: text.slice(0, 200),
    preparedAction: matched?.preparedAction ||
      "Call the driver/broker back now — find out exactly what is blocking the pickup.",
    audience: matched?.audience || "driver",
    at: interruptFact.observedAt || interruptFact.at || "",
    sourceFactId: interruptFact.id || "",
  };
}

// ---------------------------------------------------------------------------
// Severity model: critical / high / normal / quiet.
// Critical visibly interrupts (toast, cadence-managed); high tops Today's
// Work quietly; normal stays grouped; quiet stays in Waiting/FYI. Export-side
// / pre-import issues never interrupt.
// ---------------------------------------------------------------------------

function hoursUntil(iso, now) {
  // Production rows carry operator ETA text ("Jul 06, 2026 / 10:00 AM ELP"),
  // not ISO — the raw parse returned NaN and silently killed the
  // arriving-within-24h urgency class (same cleanup as planning-ahead).
  const text = String(iso || "").trim();
  let target = Date.parse(text);
  if (!Number.isFinite(target) && text) {
    target = Date.parse(text.replace(/\s+[A-Z]{3}\s*$/, "").replace(/\s*\/\s*/, " ").trim());
  }
  const base = Date.parse(now || "") || Date.now();
  if (!Number.isFinite(target)) return null;
  return (target - base) / 3600000;
}

function shipmentEtaIso(row = {}) {
  return row.eta || row.flightDetails?.eta || row.route?.eta || row.opsState?.eta || "";
}

// Severity may read raw fact text ONLY for signals that are recent and
// unresolved. Old mentions stay history/evidence — they never drive severity
// (live case 016-80000156: an aged wrong-consignee mention kept flagging a
// picked-up shipment critical).
const SEVERITY_SIGNAL_RECENT_HOURS = 48;

function lifecycleResolutionText(text = "") {
  return resolutionText(text) ||
    /\b(?:delivered|delivery (?:was )?(?:complete|completed)|pod (?:received|attached|signed|uploaded)|proof of delivery (?:received|attached|signed)|re[- ]?delivered|recovered and delivered)\b/i.test(text);
}

function operatorRecordResolutionFact(fact = {}) {
  return String(fact.type || "") === "operator_record" &&
    ["pickup_confirmed", "delivered", "pod_received"].includes(String(fact.operatorEvent || ""));
}

// Latest fact matching `pattern`, unless it is stale (older than the recency
// window) or superseded by ANY later lifecycle-resolution evidence: a
// pickup/delivery/POD fact, an operator record, or a lifecycle gate that
// advanced at/after the signal.
function unresolvedRecentSignal(row = {}, pattern, now = new Date().toISOString()) {
  const facts = shipmentFacts(row);
  let trigger = null;
  for (const fact of facts) {
    const text = factText(fact);
    if (text && pattern.test(text) && (!trigger || factTimeMs(fact) > factTimeMs(trigger))) trigger = fact;
  }
  if (!trigger) return null;
  const triggerMs = factTimeMs(trigger);
  const nowMs = Date.parse(now) || Date.now();
  if (nowMs - triggerMs > SEVERITY_SIGNAL_RECENT_HOURS * 3600000) return null;
  for (const fact of facts) {
    if (factTimeMs(fact) < triggerMs) continue;
    if (fact === trigger) continue;
    if (operatorRecordResolutionFact(fact) || lifecycleResolutionText(factText(fact))) return null;
  }
  const gates = Array.isArray(row.truthPacket?.gates) ? row.truthPacket.gates : [];
  const lifecycleGateAdvanced = gates.some((gate) =>
    ["pickup", "delivery", "pod"].includes(gate.gate) &&
    gate.status === "true" &&
    (Date.parse(gate.updatedAt || gate.at || "") || 0) >= triggerMs);
  if (lifecycleGateAdvanced) return null;
  return trigger;
}

// stationMeta is the Part-E contract (lib/station-metadata.js) — optional
// today, consumed when the metadata database exists.
function assessShipmentSeverity(row = {}, { now = new Date().toISOString(), stationMeta = null } = {}) {
  const packet = row.truthPacket || {};
  const state = String(packet.resolvedCurrentState || packet.currentState || "").toLowerCase().replace(/-/g, "_");
  const blocker = packet.operationalBlocker || {};
  const agency = row.operatorAgency || packet.operatorAgency || null;
  const interrupt = classifyUrgentInterrupt(row);

  // CRITICAL — visibly interrupt. Severity prefers current packet state and
  // unresolved signals; raw fact text counts only when recent AND unresolved.
  if (interrupt) return { level: "critical", reason: interrupt.title, interrupt };
  const failedDelivery = ["delivered", "closed"].includes(state)
    ? null
    : unresolvedRecentSignal(row, /\b(?:wrong (?:consignee|address|customer|recipient)|delivered by mistake|failed delivery|delivery (?:failed|refused)|receiver (?:closed|refused))\b/i, now);
  // A scheduled closure ("receiver closed until Monday", holiday) is a
  // delivery WAIT, never a failed delivery.
  const failedDeliveryIsWait = failedDelivery && classifyDeliveryWaitText(factText(failedDelivery), failedDelivery.observedAt || failedDelivery.at || "");
  if (failedDelivery && !failedDeliveryIsWait) {
    return { level: "critical", reason: "Wrong/failed delivery reported — recover it now.", sourceFactId: failedDelivery.id || "" };
  }
  const hardBlocker = ["customs_hold", "release_needed"].includes(blocker.type) ||
    (blocker.type === "fees_due" && Number(packet.feeLedger?.remainingBalance) > 0);
  const arrived = ["arrived_not_available", "customs_hold", "ready_for_pickup"].includes(state);
  // Storage/LFD urgency only matters while the cargo is still sitting there —
  // after pickup/delivery an old storage warning is history, not risk.
  const lfdUrgent = (arrived && unresolvedRecentSignal(row, /\b(?:last free day|lfd)\b[^.;\n]{0,60}\b(?:today|tomorrow|passed|expired|was)\b|\bstorage (?:has )?(?:started|accru(?:ing|ed)|begins today)\b/i, now)) ||
    (stationMeta?.freeStorageEndsAt ? (hoursUntil(stationMeta.freeStorageEndsAt, now) ?? 99) <= 24 : false);
  if (arrived && hardBlocker && lfdUrgent) {
    return { level: "critical", reason: "Arrived with a hard blocker and storage/LFD is burning — act now." };
  }

  // QUIET — export-side / waiting / monitoring never interrupts.
  if (agency && agency.countsAsWork === false) {
    return { level: "quiet", reason: agency.reason || "Waiting — no import action possible." };
  }

  // HIGH — top of Today's Work, without screaming.
  if (arrived && hardBlocker) {
    return { level: "high", reason: "Arrived and blocked — release it before storage starts." };
  }
  // Post-pickup delivery wait: cost accruing (driver waiting / detention)
  // tops the board; a scheduled closure is normal work with the right plan.
  if (["picked_up", "out_for_delivery"].includes(state)) {
    const wait = deliveryWaitForShipment(row);
    if (wait && (wait.driverWaiting || wait.waitingCost)) {
      return { level: "high", reason: wait.driverWaiting ? "Driver waiting at the delivery — detention accruing." : "Waiting/storage cost is accruing until delivery resumes." };
    }
  }
  const etaHours = hoursUntil(shipmentEtaIso(row), now);
  if (etaHours != null && etaHours >= 0 && etaHours <= 24) {
    const customsDone = (packet.gates || []).some((gate) => gate.gate === "customs" && gate.status === "true");
    const dispatchDone = (packet.gates || []).some((gate) => gate.gate === "dispatch" && gate.status === "true");
    if (!customsDone || !dispatchDone) {
      return { level: "high", reason: `Arrives within ${Math.max(1, Math.round(etaHours))}h and ${!customsDone ? "release" : "pickup path"} is not ready.` };
    }
  }
  if (agency?.agency === "needs_human_decision") {
    return { level: "high", reason: "A decision is being asked of us." };
  }

  return { level: "normal", reason: "Routine work." };
}

module.exports = {
  classifyUrgentInterrupt,
  assessShipmentSeverity,
};

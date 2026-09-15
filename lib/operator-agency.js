"use strict";

// Operator-agency classification (import-desk scope).
//
// The board must show only work the IMPORT operator can actually do now.
// Every shipment lands in exactly one agency class:
//
//   actionable_by_us_now      the import team can move this shipment forward
//   waiting_on_external_party we already asked; the ball is with someone else
//   not_import_scope_yet      export-side / pre-departure uncertainty — the
//                             cargo has not entered import control
//   monitor_only              nothing is wrong and nothing needs us
//   needs_human_decision      contradictory truth a human must resolve
//
// Core rules (live case 016-80000142: export split "Only 5 pcs were Built for
// LY845/01", pre-US-arrival, export agent asked to advise — that is NOT a
// call for the import desk):
//   - Export-side / revised-flight / pre-departure uncertainty before cargo
//     enters import control is monitor/wait, never active import work.
//   - An ETA passing means nothing while departure/export movement is
//     unconfirmed.
//   - Truth-gathering and pickup pre-planning stay actionable pre-arrival;
//     station status-chasing does not, until departure is confirmed.

const AGENCY = {
  ACTIONABLE: "actionable_by_us_now",
  WAITING_EXTERNAL: "waiting_on_external_party",
  NOT_IMPORT_SCOPE: "not_import_scope_yet",
  MONITOR: "monitor_only",
  NEEDS_DECISION: "needs_human_decision",
};

const PRE_ARRIVAL_STATES = new Set([
  "in_transit", "in-transit", "pre_arrival", "pre-arrival", "not_arrived", "not-arrived", "booked", "export",
]);

const TERMINAL_STATES = new Set(["closed", "pod_received", "completed"]);

// Pre-arrival work the import desk genuinely can do: gather truth and
// pre-plan the pickup. Status-chasing a station about cargo that may not have
// flown is not on this list.
const PREARRIVAL_ACTIONABLE_ACTION_TYPES = new Set([
  "prearrival-quote-decision", "quote-review", "quote-followup", "broker-award",
  "source-backfill", "carrier-tracking-refresh", "money-context-review",
]);

function normalizedState(value = "") {
  return String(value || "").trim().toLowerCase().replace(/-/g, "_");
}

function exportUncertaintyText(text = "") {
  return /\b(?:another split|shipment split|split as follow|split\/offload|offload(?:ed)?|rebook(?:ed)?|revised flight|revised departure|pre[- ]?us[- ]?arrival|customs is not involved yet|only\s+\d+\s*(?:pcs?|pieces?)\s+(?:were\s+)?built)\b/i.test(text);
}

function departureConfirmedText(text = "") {
  return /\b(?:departed|atd\b|flew|uplift(?:ed)?|on[- ]board|boarded|wheels[- ]up)\b/i.test(text) &&
    !/\b(?:not (?:yet )?departed|departure (?:is )?unconfirmed)\b/i.test(text);
}

function askedExternalPartyText(text = "") {
  return /\b(?:we asked|asked the (?:station|handler|export|carrier|agent)|please advise|pls advise|awaiting (?:reply|response|confirmation|revised)|waiting for (?:the )?(?:station|handler|carrier|export|agent)\b)/i.test(text);
}

// input: { state, phase, blockerType, blockerStatus, mustAskHuman,
//          contradictions, factsText, actionType }
function classifyOperatorAgency(input = {}) {
  const state = normalizedState(input.state || input.phase);
  const blockerType = String(input.blockerType || "").trim();
  const text = String(input.factsText || "");
  const contradictions = Array.isArray(input.contradictions) ? input.contradictions : [];
  const actionType = String(input.actionType || "").trim();

  if (TERMINAL_STATES.has(state)) {
    return {
      agency: AGENCY.MONITOR,
      reason: "Delivered and closed — history only.",
      countsAsWork: false,
    };
  }

  // Contradictions that carry their own resolution step ARE our work; a bare
  // mustAskHuman / unresolvable conflict is a human decision first.
  const unresolvableContradiction = contradictions.some((row) => !row?.resolutionAction);
  if (unresolvableContradiction || (input.mustAskHuman === true && !contradictions.length)) {
    return {
      agency: AGENCY.NEEDS_DECISION,
      reason: "Two sources disagree about this shipment — a human call is needed before acting.",
      countsAsWork: true,
    };
  }

  // Physical delivery does not close the paperwork. Keep POD collection on
  // the work board until signed proof is present, including an unknown gate.
  if (state === "delivered") {
    const podReceived = ["true", "done", "received"].includes(String(input.podStatus || "").toLowerCase());
    return podReceived
      ? { agency: AGENCY.MONITOR, reason: "Delivery and signed POD are confirmed.", countsAsWork: false }
      : { agency: AGENCY.ACTIONABLE, reason: "Delivery is reported; collect signed POD before closeout.", countsAsWork: true };
  }

  const preArrival = PRE_ARRIVAL_STATES.has(state);
  const exportUncertainty = blockerType === "movement_split" || exportUncertaintyText(text);
  const askedExternal = askedExternalPartyText(text);

  // Export-side / revised-movement uncertainty outranks everything pre-import:
  // pieces and timing are unknown, so import planning would plan the wrong world.
  if (preArrival && exportUncertainty) {
    return {
      agency: askedExternal ? AGENCY.WAITING_EXTERNAL : AGENCY.NOT_IMPORT_SCOPE,
      reason: "Waiting on revised departure/arrival — no import action yet.",
      countsAsWork: false,
    };
  }

  if (preArrival) {
    // Truth-gathering and pickup pre-planning stay real import work.
    if (PREARRIVAL_ACTIONABLE_ACTION_TYPES.has(actionType)) {
      return {
        agency: AGENCY.ACTIONABLE,
        reason: "Pre-arrival planning the import desk can do now.",
        countsAsWork: true,
      };
    }
    // ETA passed alone is not enough while departure is unconfirmed.
    if (!departureConfirmedText(text)) {
      return {
        agency: askedExternal ? AGENCY.WAITING_EXTERNAL : AGENCY.NOT_IMPORT_SCOPE,
        reason: askedExternal
          ? "We asked for on-hand confirmation — departure is still unconfirmed, so there is no new import move."
          : "Departure/export movement is unconfirmed — the freight has not entered import control yet.",
        countsAsWork: false,
      };
    }
    // Departure confirmed and ETA history says it should be here: asking the
    // destination station is genuine import work.
    return {
      agency: AGENCY.ACTIONABLE,
      reason: "Departure is confirmed — confirming arrival/availability with the destination station is our move.",
      countsAsWork: true,
    };
  }

  // Picked up with no delivery/POD proof yet: tracking delivery and
  // collecting the POD is always our move.
  if (["picked_up", "out_for_delivery"].includes(state)) {
    return {
      agency: AGENCY.ACTIONABLE,
      reason: "Picked up — tracking delivery and collecting the POD is our move.",
      countsAsWork: true,
    };
  }

  // Post-arrival: an active blocker or planner action is import work by
  // definition (fees, customs, docs, pickup, dispatch, POD follow-up).
  if ((blockerType && blockerType !== "none") || actionType) {
    return {
      agency: AGENCY.ACTIONABLE,
      reason: "The freight is under import control and this step moves it forward.",
      countsAsWork: true,
    };
  }

  return {
    agency: AGENCY.MONITOR,
    reason: "Nothing needs the import desk right now.",
    countsAsWork: false,
  };
}

// Convenience wrapper for a shipment row + its truth packet.
function classifyOperatorAgencyForRow(row = {}, packet = {}, action = null) {
  const facts = Array.isArray(row.evidencePacket?.sourceFacts) ? row.evidencePacket.sourceFacts : [];
  const factsText = [
    ...facts.map((fact) => `${fact.claim || ""} ${fact.rawSnippet || ""}`),
    (packet.operationalBlocker || {}).reason || "",
    row.opsState?.nextAction || row.nextAction || "",
    // Canonical truth statements carry proof that never lands in sourceFacts on
    // production rows ("DO already banked, freight departed LY843/29") — without
    // them a departed shipment reads as export-side and gets silenced.
    packet.nextAction?.summary || "",
    row.customsBroker?.nextAction || "",
    row.customsBroker?.brokerStatus || "",
    row.freightBroker?.nextAction || "",
    row.freightBroker?.brokerStatus || "",
  ].join(" ");
  return classifyOperatorAgency({
    state: packet.resolvedCurrentState || packet.currentState || row.currentState,
    phase: row.opsState?.phase,
    blockerType: (packet.operationalBlocker || {}).type,
    blockerStatus: (packet.operationalBlocker || {}).status,
    mustAskHuman: packet.mustAskHuman,
    contradictions: packet.contradictions,
    factsText,
    actionType: (action || row.primaryAction || {}).type || "",
    podStatus: (packet.gates || []).find((gate) => gate.gate === "pod")?.status,
  });
}

module.exports = {
  AGENCY,
  classifyOperatorAgency,
  classifyOperatorAgencyForRow,
};

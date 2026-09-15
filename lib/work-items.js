"use strict";

// Canonical work items (Lane 4 of the production-stack plan) — ADDITIVE model.
//
// One derived array that will eventually drive the desktop badge, Today's
// Work, the inbox tray, and the cockpit highlight. Nothing in the UI consumes
// it yet; it ships behind verifiers first.
//
// Vocabulary:
//   signal     = a raw source fact. Lives in the truth packet, never here.
//   work item  = an unresolved issue that needs the operator (or is explicitly
//                waiting on the world). Derived, never stored as truth.
//   history    = resolved evidence. Work items whose resolvesWhen predicate is
//                already satisfied publish as closed states, not open work.
//
// Contract:
//   - id is deterministic: wi:{awbKey}:{dimension}. Same truth in → same ids
//     out, across processes and runs. No timestamps or randomness in ids.
//   - states: action-needed | needs-decision | draft-ready | waiting |
//     needs-classification | resolved | superseded | completed | dismissed | fyi
//   - every item carries operator-language title/reason, sourceFactIds
//     provenance, and a resolvesWhen predicate description.
//   - COUNT IDENTITY: the badge, Today's Work, and the inbox tray must all be
//     computed from THIS array via countIdentity(); they can never disagree.

const { classifyOperatorAgencyForRow } = require("./operator-agency");
const { classifyUrgentInterrupt } = require("./urgent-interrupts");

const OPEN_STATES = new Set(["action-needed", "needs-decision", "draft-ready", "needs-classification"]);
const WAITING_STATES = new Set(["waiting"]);
const CLOSED_STATES = new Set(["resolved", "superseded", "completed", "dismissed", "fyi"]);

function awbKeyOf(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function workItemId(awb, dimension) {
  return `wi:${awbKeyOf(awb)}:${dimension}`;
}

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

const BLOCKER_DIMENSIONS = {
  fees_due: "fees",
  fee_verification: "fee-verification",
  customs_hold: "customs",
  document_request: "docs",
  pickup_blocked: "pickup",
  delivery_recovery: "delivery-recovery",
  movement_split: "movement",
  release_needed: "release",
};

function blockerDimension(type = "") {
  if (BLOCKER_DIMENSIONS[type]) return BLOCKER_DIMENSIONS[type];
  if (/^dispatch/.test(type)) return "dispatch";
  return type ? type.replace(/_/g, "-") : "";
}

function blockerWorkItem(row, packet, now) {
  const blocker = packet.operationalBlocker || {};
  const type = clean(blocker.type);
  if (!type || type === "none") return null;
  const dimension = blockerDimension(type);
  const advisory = clean(blocker.status) === "advisory";
  return {
    id: workItemId(row.awb || row.id, dimension),
    awb: row.awb || "",
    dimension,
    state: advisory ? "action-needed" : "action-needed",
    severity: advisory ? "info" : clean(blocker.severity) || "attention",
    title: clean(blocker.label) || "Needs attention",
    reason: clean(blocker.reason),
    sourceFactIds: Array.isArray(blocker.sourceFactIds) ? blocker.sourceFactIds.slice(0, 8) : [],
    resolvesWhen: advisory
      ? "The fee amount is verified against the visible charge (or a receipt lands)."
      : `The ${dimension} blocker clears in the truth packet.`,
    kind: "blocker",
    advisory,
    updatedAt: clean(packet.updatedAt || row.opsState?.updatedAt || "") || now,
  };
}

function contradictionWorkItems(row, packet, now) {
  return (packet.contradictions || []).map((contradiction) => {
    const rawKey = clean(contradiction.dimension || contradiction.id || "conflict")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const dimension = `decision-${rawKey}`;
    const requiresAction = contradiction.requiresAction === true;
    return {
      id: workItemId(row.awb || row.id, dimension),
      awb: row.awb || "",
      dimension,
      state: requiresAction ? "action-needed" : "needs-decision",
      severity: clean(contradiction.severity) || "attention",
      title: clean(contradiction.operatorMessage) || "Two sources disagree — pick the truth",
      reason: clean(contradiction.claim),
      sourceFactIds: Array.isArray(contradiction.sourceFactIds) ? contradiction.sourceFactIds.slice(0, 8) : [],
      resolvesWhen: "The contradiction resolves (newer proof lands or the operator decides).",
      kind: "contradiction",
      updatedAt: clean(packet.updatedAt || "") || now,
    };
  });
}

function actionWorkItem(row, packet, action, now) {
  if (!action || !clean(action.type)) return null;
  // Truth-blocked shipments surface their blocker/decision items instead; the
  // planner's primary becomes a work item only when it is genuinely the next
  // move (draft ready to approve, or an operator step with no open decision).
  const drafted = Boolean(action.gmailDraftId || clean(action.status) === "drafted" || clean(action.draftStatus) === "drafted");
  const dimension = `action-${clean(action.type).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return {
    id: workItemId(row.awb || row.id, dimension),
    awb: row.awb || "",
    dimension,
    state: drafted ? "draft-ready" : "action-needed",
    severity: clean(action.priority) === "high" ? "attention" : "normal",
    title: clean(action.label || action.title) || "Take the next step",
    reason: clean(action.whyNow || action.reason),
    sourceFactIds: Array.isArray(action.sourceFactIds) ? action.sourceFactIds.slice(0, 8) : [],
    actionId: action.id || "",
    resolvesWhen: drafted
      ? "The operator approves (sends) or dismisses the draft."
      : "The action completes or the shipment state moves past it.",
    kind: "action",
    updatedAt: clean(action.updatedAt || "") || now,
  };
}

function terminalWorkItem(row, packet, now) {
  const state = clean(packet.resolvedCurrentState || packet.currentState).toLowerCase();
  if (!/^(?:closed|delivered|pod_received|completed)$/.test(state)) return null;
  return {
    id: workItemId(row.awb || row.id, "closeout"),
    awb: row.awb || "",
    dimension: "closeout",
    state: "completed",
    severity: "none",
    title: "Delivered and closed",
    reason: clean(packet.stateReason || ""),
    sourceFactIds: [],
    resolvesWhen: "Already resolved — kept as history.",
    kind: "history",
    updatedAt: clean(packet.updatedAt || "") || now,
  };
}

// One shipment → its work items. `plan` is optional (the planner's primary
// action, when the caller has it).
function workItemsForShipment(row = {}, packet = {}, plan = null, now = new Date().toISOString()) {
  const items = [];
  const hasActionableContradiction = (packet.contradictions || [])
    .some((contradiction) => contradiction?.requiresAction === true);
  const closed = terminalWorkItem(row, packet, now);
  if (closed && !hasActionableContradiction) return [closed];

  // An urgent interrupt (driver stuck at pickup) is THE work item for the
  // shipment — it outranks everything, including agency quieting.
  const interrupt = classifyUrgentInterrupt({ ...row, truthPacket: packet });
  if (interrupt) {
    return [{
      id: `wi:${awbKeyOf(row.awb || row.id)}:interrupt-${interrupt.cause}`,
      awb: row.awb || "",
      dimension: `interrupt-${interrupt.cause}`,
      state: "action-needed",
      severity: "urgent",
      title: interrupt.title,
      reason: interrupt.message,
      nextStep: interrupt.preparedAction,
      sourceFactIds: [interrupt.sourceFactId].filter(Boolean),
      resolvesWhen: "Pickup is confirmed, or a later message says the issue is resolved.",
      kind: "interrupt",
      interrupt,
      updatedAt: interrupt.at || now,
    }];
  }

  // Import-desk agency: export-side/waiting/monitor shipments are visible but
  // QUIET — one waiting item, never counted as work the operator can do now.
  // Packet agency is published before the downstream action planner runs. A
  // later primary action is therefore stronger projection-time evidence: run
  // agency again with that action instead of letting a provisional packet
  // `monitor_only` verdict suppress the exact work we are about to expose.
  // Pre-arrival and terminal rules still win inside the classifier.
  const agency = plan && clean(plan.type)
    ? classifyOperatorAgencyForRow(row, packet, plan)
    : packet.operatorAgency || classifyOperatorAgencyForRow(row, packet, null);
  if (agency && agency.countsAsWork === false && !hasActionableContradiction) {
    return [{
      id: workItemId(row.awb || row.id, `agency-${String(agency.agency || "waiting").replace(/_/g, "-")}`),
      awb: row.awb || "",
      dimension: `agency-${String(agency.agency || "waiting").replace(/_/g, "-")}`,
      state: "waiting",
      severity: "none",
      title: agency.agency === "monitor_only" ? "Nothing to do — monitoring" : "Waiting — no import action yet",
      reason: clean(agency.reason),
      sourceFactIds: [],
      resolvesWhen: "The shipment enters import control or the external party answers.",
      kind: "agency-wait",
      agency: agency.agency,
      updatedAt: now,
    }];
  }

  const blockerItem = blockerWorkItem(row, packet, now);
  if (blockerItem) items.push(blockerItem);
  items.push(...contradictionWorkItems(row, packet, now));
  if (packet.mustAskHuman === true && !items.some((item) => item.kind === "contradiction")) {
    items.push({
      id: workItemId(row.awb || row.id, "decision-must-ask"),
      awb: row.awb || "",
      dimension: "decision-must-ask",
      state: "needs-decision",
      severity: "attention",
      title: "The packet needs a human call",
      reason: "The truth packet is flagged mustAskHuman without a specific contradiction row.",
      sourceFactIds: [],
      resolvesWhen: "The flag clears on the next truth publish.",
      kind: "contradiction",
      updatedAt: now,
    });
  }
  const actionItem = actionWorkItem(row, packet, plan, now);
  if (actionItem) {
    // The planner's primary is by construction the next move on the shipment's
    // blocking issue. When an open truth item exists, the action is that
    // item's NEXT STEP, not a second work item — one unresolved issue, one row.
    const host = items.find((item) => item.kind === "blocker" && OPEN_STATES.has(item.state)) ||
      items.find((item) => OPEN_STATES.has(item.state));
    if (host) {
      host.actionId = actionItem.actionId || host.actionId || "";
      host.nextStep = actionItem.title;
      host.nextStepState = actionItem.state; // draft-ready when a draft awaits approval
      if (actionItem.state === "draft-ready") host.state = "draft-ready";
    } else if (!items.some((item) => item.id === actionItem.id)) {
      items.push(actionItem);
    }
  }

  if (!items.length) {
    const stateValue = clean(packet.resolvedCurrentState || packet.currentState);
    items.push({
      id: workItemId(row.awb || row.id, "watch"),
      awb: row.awb || "",
      dimension: "watch",
      state: "waiting",
      severity: "none",
      title: stateValue === "in_transit" ? "On its way — nothing to do yet" : "No open work",
      reason: clean(packet.stateReason || ""),
      sourceFactIds: [],
      resolvesWhen: "The shipment reaches a state that needs the operator.",
      kind: "watch",
      updatedAt: now,
    });
  }
  return items;
}

// The whole board. `shipments` are packet-bearing rows (row.truthPacket) or
// pairs provided via options.packets/options.plans keyed by awbKey.
function buildWorkItems(shipments = [], options = {}) {
  const now = clean(options.now) || new Date().toISOString();
  const seen = new Map();
  for (const row of shipments) {
    const key = awbKeyOf(row.awb || row.id);
    const packet = (options.packets && options.packets[key]) || row.truthPacket || {};
    const plan = (options.plans && options.plans[key]) || null;
    for (const item of workItemsForShipment(row, packet, plan, now)) {
      // One item per deterministic id; the first (highest-precedence) wins.
      if (!seen.has(item.id)) seen.set(item.id, item);
    }
  }
  const workItems = [...seen.values()];
  return { snapshotTime: now, workItems, counts: countIdentity(workItems) };
}

// COUNT IDENTITY: every surface derives from the one array. If the badge and
// Today's Work ever disagree, the bug is in the caller, not the data.
function countIdentity(workItems = []) {
  const open = workItems.filter((item) => OPEN_STATES.has(item.state));
  const waiting = workItems.filter((item) => WAITING_STATES.has(item.state));
  const history = workItems.filter((item) => CLOSED_STATES.has(item.state));
  return {
    badge: open.length,
    todaysWork: open.length,
    inboxTray: open.length,
    open: open.length,
    needsDecision: open.filter((item) => item.state === "needs-decision").length,
    draftsReady: open.filter((item) => item.state === "draft-ready").length,
    waiting: waiting.length,
    history: history.length,
    total: workItems.length,
  };
}

module.exports = {
  OPEN_STATES,
  WAITING_STATES,
  CLOSED_STATES,
  awbKeyOf,
  workItemId,
  workItemsForShipment,
  buildWorkItems,
  countIdentity,
};

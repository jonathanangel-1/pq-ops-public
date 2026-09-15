"use strict";

const { normalizeAwb } = require("./awb");

const TERMINAL_ACTION_STATUSES = new Set([
  "sent",
  "drafted",
  "completed",
  "closed",
  "cancelled",
  "canceled",
  "dismissed",
  "failed",
]);

function roleForTruthPacket(row = {}) {
  return String(row.truthPacketRole || row.role || "active").toLowerCase();
}

function phaseForTruthPacket(row = {}) {
  return String(
    row.stage ||
      row.phase ||
      row.opsState?.phase ||
      row.truthPacket?.currentState ||
      row.currentState ||
      "",
  ).toLowerCase().replace(/_/g, "-");
}

function gateStatusForTruthPacket(row = {}, gateName = "") {
  const gates = row.opsState?.gates || {};
  const gate = gates[gateName] ||
    row.truthPacket?.gates?.find?.((item) => String(item.gate || item.name || "").toLowerCase() === gateName) ||
    {};
  return String(gate.status || "").toLowerCase().replace(/_/g, "-");
}

function truthPacketIsCompleted(row = {}) {
  const role = roleForTruthPacket(row);
  const phase = phaseForTruthPacket(row);
  return Boolean(
    row.completed ||
      role === "completed" ||
      ["delivered", "completed", "closed"].includes(phase),
  );
}

function truthPacketReachedPickupOrLater(row = {}) {
  const phase = phaseForTruthPacket(row);
  const pickup = gateStatusForTruthPacket(row, "pickup");
  const delivery = gateStatusForTruthPacket(row, "delivery");
  const pod = gateStatusForTruthPacket(row, "pod");
  return Boolean(
    ["picked-up", "delivery-scheduled", "pod-needed", "delivered", "completed", "closed"].includes(phase) ||
      ["done", "picked-up", "loaded", "complete", "completed"].includes(pickup) ||
      ["scheduled", "done", "delivered", "completed"].includes(delivery) ||
      ["done", "received", "pod-found", "found"].includes(pod),
  );
}

function truthPacketIsActive(row = {}) {
  return roleForTruthPacket(row) === "active" && !truthPacketIsCompleted(row);
}

function truthPacketAwb(row = {}) {
  return normalizeAwb(row.awb || row.id || row.shipmentId || row.mawb || "");
}

function truthPacketAwbSets(snapshot = {}) {
  const rows = Array.isArray(snapshot.shipments) ? snapshot.shipments : [];
  const completed = new Set(
    [
      ...(Array.isArray(snapshot.completedAwbs) ? snapshot.completedAwbs : []),
      ...rows.filter(truthPacketIsCompleted).map(truthPacketAwb),
    ].map(normalizeAwb).filter(Boolean),
  );
  const active = new Set(
    [
      ...(Array.isArray(snapshot.activeAwbs) ? snapshot.activeAwbs : []),
      ...rows.filter(truthPacketIsActive).map(truthPacketAwb),
    ]
      .map(normalizeAwb)
      .filter((awb) => awb && !completed.has(awb)),
  );
  return { active, completed };
}

function actionAwb(action = {}) {
  return normalizeAwb(action.awb || action.shipmentAwb || action.mawb || action.shipmentId || "");
}

function actionIsTerminal(action = {}) {
  const status = String(action.status || "").toLowerCase();
  return TERMINAL_ACTION_STATUSES.has(status) ||
    Boolean(action.sentAt || action.draftedAt || action.completedAt || action.gmailMessageId || action.gmailDraftId);
}

function actionIsLiveProposal(action = {}) {
  return !actionIsTerminal(action);
}

function actionText(action = {}) {
  const evidence = Array.isArray(action.evidence)
    ? action.evidence
    : [action.evidence].filter(Boolean);
  return [
    action.label,
    action.reason,
    action.problem,
    action.nextAction,
    action.body,
    action.subject,
    action.timing?.phase,
    ...evidence,
  ].filter(Boolean).join(" ");
}

function actionContradictsAdvancedPickupTruth(action = {}, row = {}) {
  if (!truthPacketReachedPickupOrLater(row)) return false;
  const text = actionText(action);
  if (!text) return false;
  const isPrePickupBlocker =
    /\b(?:cargo|freight|shipment)\b[^.;\n]{0,100}\b(?:not\s+found|not\s+located|located|found|actually\s+located)\b/i.test(text) ||
    /\bconfirm\s+whether\b[^.;\n]{0,120}\b(?:cargo|freight|shipment|picked\s+up|pickup|loaded)\b/i.test(text) ||
    /\bcall\b[^.;\n]{0,80}\b(?:station|pickup\s+broker|carrier|driver)\b[^.;\n]{0,120}\b(?:located|picked\s+up|pickup|loaded|blocker)\b/i.test(text) ||
    /\b(?:driver\s+waiting|pickup\s+blocked|station\s+cannot\s+see|release\s+not\s+visible|cargo\s+not\s+found|loading\s+stalls?)\b/i.test(text);
  const stillRelevantPodAction = /\b(?:pod|proof\s+of\s+delivery|final\s+delivery|signed\s+receipt)\b/i.test(text) &&
    !/\b(?:cargo|freight|shipment)\b[^.;\n]{0,100}\b(?:not\s+found|not\s+located|actually\s+located)\b/i.test(text);
  return isPrePickupBlocker && !stillRelevantPodAction;
}

function actionCounts(actions = [], previous = {}) {
  return {
    ...previous,
    actions: actions.length,
    highPriority: actions.filter((action) => action.priority === "high").length,
    missingRecipients: actions.filter((action) =>
      action.missing?.length &&
        !["platform", "companion", "ops-brain"].includes(String(action.channel || "").toLowerCase())
    ).length,
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
    stationConfirmations: actions.filter((action) => action.type === "station-confirmation").length,
    quoteRequests: actions.filter((action) => action.type === "quote-request").length,
    brokerAwards: actions.filter((action) => action.type === "broker-award").length,
    customsFollowups: actions.filter((action) => action.type === "customs-followup").length,
  };
}

function pruneActionQueueAgainstTruthPackets(actionQueue = {}, truthPackets = {}, now = new Date()) {
  const { active, completed } = truthPacketAwbSets(truthPackets);
  const rowsByAwb = new Map((truthPackets.shipments || [])
    .map((row) => [truthPacketAwb(row), row])
    .filter(([awb]) => awb));
  const actions = Array.isArray(actionQueue.actions) ? actionQueue.actions : [];
  const prunedActionIds = [];
  const prunedAwbs = new Set();
  const kept = actions.filter((action) => {
    if (!actionIsLiveProposal(action)) return true;
    const awb = actionAwb(action);
    if (!awb) return true;
    const completedWithoutActiveWork = completed.has(awb) && !active.has(awb);
    const noLongerActiveWork = active.size > 0 && !active.has(awb);
    const contradictedByAdvancedPickup = actionContradictsAdvancedPickupTruth(action, rowsByAwb.get(awb) || {});
    if (!completedWithoutActiveWork && !noLongerActiveWork && !contradictedByAdvancedPickup) return true;
    prunedActionIds.push(action.id || `${awb}:${action.type || "action"}:${action.label || ""}`);
    prunedAwbs.add(awb);
    return false;
  });

  const counts = actionCounts(kept, actionQueue.counts || {});
  const countsChanged = JSON.stringify(counts) !== JSON.stringify(actionQueue.counts || {});
  if (kept.length === actions.length && !countsChanged) {
    return {
      changed: false,
      payload: actionQueue,
      prunedActionIds: [],
      prunedAwbs: [],
    };
  }

  return {
    changed: true,
    payload: {
      ...actionQueue,
      snapshotTime: now.toISOString(),
      counts,
      prunedAgainstTruthSnapshotTime: truthPackets.snapshotTime || "",
      prunedActionIds: prunedActionIds.length ? prunedActionIds : actionQueue.prunedActionIds || [],
      prunedAwbs: prunedAwbs.size ? [...prunedAwbs].sort() : actionQueue.prunedAwbs || [],
      actions: kept,
    },
    prunedActionIds,
    prunedAwbs: [...prunedAwbs].sort(),
  };
}

module.exports = {
  actionAwb,
  actionContradictsAdvancedPickupTruth,
  actionIsLiveProposal,
  pruneActionQueueAgainstTruthPackets,
  truthPacketAwbSets,
};

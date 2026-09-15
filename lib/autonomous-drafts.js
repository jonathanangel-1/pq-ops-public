"use strict";

const {
  actionIntentKey,
  draftIntentKey,
  draftPayloadForAction,
  publicOutboxRequest,
  validateDraftableAction,
} = require("./action-safety");

const AUTONOMOUS_DRAFT_ACTION_TYPES = new Set([
  "broker-status-followup",
  "customer-update",
  "customs-followup",
  "dispatch-pickup-followup",
  "pod-followup",
  "quote-followup",
  "quote-request",
  "station-confirmation",
  "storage-risk",
]);

const ACTIVE_OUTBOX_STATUSES = new Set([
  "queued",
  "running",
  "waiting_external",
  "drafted",
  "sent",
  "succeeded",
]);

function normalizeStatus(value) {
  return String(value || "").toLowerCase();
}

function actionHasActiveOutbox(action, outboxRequests = []) {
  return (outboxRequests || []).some((request) => {
    const requestActionId = request.actionId || request.id;
    return requestActionId === action.id && ACTIVE_OUTBOX_STATUSES.has(normalizeStatus(request.status));
  });
}

function autonomousDraftTrigger(action) {
  if (action?.timing?.trigger) {
    const stage = action.timing.stage ? `${action.timing.stage}: ` : "";
    return `${stage}${action.timing.trigger}`;
  }
  switch (action.type) {
    case "quote-request":
      return action.label === "Prep pickup quote"
        ? "ETA within 48 hours; rates should be ready before cargo arrives."
        : "Cargo is ready/near ready and pickup broker quotes are needed.";
    case "quote-followup":
      return "Quote request already went out and no broker rate is known yet.";
    case "customs-followup":
      return "Shipment is near arrival or arrived, but clearance/release proof is not final.";
    case "customer-update":
      return "Customer asked for shipment status; reply only with delivery timing or customs issue.";
    case "station-confirmation":
      return "Arrival/status needs station confirmation.";
    case "storage-risk":
      return "Storage or last-free-day risk is active.";
    case "pod-followup":
      return "Delivery/pickup proof is missing and POD follow-up is needed.";
    case "dispatch-pickup-followup":
    case "broker-status-followup":
      return "Pickup/linehaul owner needs status confirmation.";
    default:
      return action.reason || "The AI operator selected this as the next draft.";
  }
}

function autonomousDedupeKey(action) {
  return actionIntentKey(action, "auto") || draftIntentKey(action.id, "auto");
}

function actionIsAutonomousDraftCandidate(action, outboxRequests = []) {
  if (!action || !AUTONOMOUS_DRAFT_ACTION_TYPES.has(action.type)) return false;
  if (normalizeStatus(action.status) !== "suggested") return false;
  if (action.stationContactMissing || action.podContactMissing) return false;
  if ((action.missing || []).length) return false;
  if (actionHasActiveOutbox(action, outboxRequests)) return false;
  return !validateDraftableAction(action.id, action);
}

function selectAutonomousDraftActions(actions = [], outboxRequests = []) {
  return (actions || []).filter((action) => actionIsAutonomousDraftCandidate(action, outboxRequests));
}

function autonomousDraftRequest(action, now, agentJob = null) {
  const outboxRequestId = `${action.id}-${Date.parse(now)}`;
  const draftPlan = draftPayloadForAction(action, outboxRequestId, now);
  const automation = {
    mode: "autonomous",
    trigger: autonomousDraftTrigger(action),
    queuedAt: now,
  };
  draftPlan.payload.queuedBy = "ai-operator";
  draftPlan.payload.automation = automation;
  return {
    draftPlan,
    request: {
      ...publicOutboxRequest(action, now, draftPlan, agentJob),
      queuedBy: "ai-operator",
      automation,
    },
  };
}

function applyAutonomousDraftResults(actionQueue, outbox, results, now) {
  const resultByActionId = new Map(results.map((result) => [result.action.id, result]));
  const actions = (actionQueue.actions || []).map((action) => {
    const result = resultByActionId.get(action.id);
    if (!result) return action;
    return {
      ...action,
      status: "queued",
      queuedAt: now,
      queuedBy: "ai-operator",
      automation: result.request.automation,
      outboxRequestId: result.request.id,
      agentJobId: result.request.agentJobId || null,
    };
  });
  const requests = [
    ...results.map((result) => result.request),
    ...(outbox.requests || []).filter((request) => !resultByActionId.has(request.actionId || request.id)),
  ].slice(0, 200);

  return {
    actionQueue: {
      ...actionQueue,
      snapshotTime: now,
      counts: {
        ...(actionQueue.counts || {}),
        queued: actions.filter((action) => normalizeStatus(action.status) === "queued").length,
        drafted: actions.filter((action) => normalizeStatus(action.status) === "drafted").length,
        sent: actions.filter((action) => normalizeStatus(action.status) === "sent").length,
      },
      actions,
    },
    outbox: {
      ...outbox,
      snapshotTime: now,
      requests,
    },
  };
}

module.exports = {
  autonomousDedupeKey,
  autonomousDraftRequest,
  autonomousDraftTrigger,
  selectAutonomousDraftActions,
  applyAutonomousDraftResults,
};

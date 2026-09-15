"use strict";

const { queueAgentJob } = require("./supabase-agent");
const {
  operatorApprovedInternalContract,
  safetyForInternalAction,
} = require("./action-safety");

const MONEY_REFRESH_PRIORITY = 2;

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function isMoneyContextAction(action) {
  return Boolean(action && action.type === "money-context-review" && ["platform", "companion", "ops-brain"].includes(String(action.channel || "").toLowerCase()));
}

function moneyRefreshRequestForAction(action, now = new Date().toISOString()) {
  const awb = action?.awb || action?.shipmentAwb || "";
  const normalizedAwb = normalizeAwb(awb);
  const missingFields = Array.isArray(action?.missingMoneyFields) ? action.missingMoneyFields : action?.costContext?.missing || [];
  return {
    id: `${action.id || `money-refresh-${normalizedAwb}`}-${Date.parse(now) || Date.now()}`,
    actionId: action.id || "",
    shipmentId: action.shipmentId || action.id || "",
    awb,
    normalizedAwb,
    type: "money-refresh",
    label: action.label || "Refresh shipment economics",
    status: "queued",
    queuedAt: now,
    requestedAt: now,
    source: "ops-brain-money-refresh",
    orderLink: action.orderLink || "",
    order: action.order || action.shipmentId || "",
    missingFields,
    reason: action.reason || action.problem || "",
    expectedOutput: [
      "Open the CourierCloud order costs/billing sections for the shipment",
      "Extract customer charge, vendor cost, freight quote/award, and visible station/vendor payments",
      "Write durable money-memory for the AWB when values are found",
      "Run npm run refresh and publish snapshots after economics truth is written",
    ],
    autonomy: {
      level: "L2",
      mode: "operator-approved-internal",
      requiresHumanApproval: true,
      liveExecution: true,
      transport: "money_refresh",
    },
    safety: safetyForInternalAction(
      "money_refresh",
      "Money refresh queues CourierCloud economics extraction only. No outbound email or TMS mutation is created.",
    ),
    betaContract: operatorApprovedInternalContract("money_refresh"),
  };
}

function validateMoneyContextAction(actionId, action) {
  if (!action) return "Action not found";
  if (!isMoneyContextAction(action)) return "Action is not a money-context platform action";
  if (actionId && action.id && actionId !== action.id) return "Action id mismatch";
  if (!normalizeAwb(action.awb || action.shipmentAwb)) return "Money refresh requires AWB";
  if (!action.orderLink && !action.shipmentId) return "Money refresh requires CourierCloud order context";
  return "";
}

async function queueMoneyRefreshAgentJob(action, request, options = {}) {
  const payload = {
    source: "money-context-action",
    actionId: action.id || "",
    awbs: [request.awb],
    moneyRefresh: true,
    orderLink: request.orderLink,
    order: request.order,
    missingFields: request.missingFields,
    requestedAt: request.requestedAt,
    expectedOutput: request.expectedOutput,
    betaContract: operatorApprovedInternalContract("money_refresh"),
  };
  const dedupeKey = options.dedupeKey || `money-refresh:${request.normalizedAwb}:${request.missingFields.join("-") || "economics"}`;
  return queueAgentJob("money_refresh", payload, {
    dedupeKey,
    priority: MONEY_REFRESH_PRIORITY,
    maxAttempts: 2,
  });
}

async function handleMoneyContextAction(actionId, action, { dryRun = false, now = new Date().toISOString(), queueJob = true } = {}) {
  const validationError = validateMoneyContextAction(actionId, action);
  if (validationError) {
    return {
      statusCode: validationError === "Action not found" ? 404 : 409,
      body: { error: validationError },
    };
  }
  const request = moneyRefreshRequestForAction(action, now);
  if (dryRun) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        dryRun: true,
        queued: false,
        wouldQueue: true,
        direct: false,
        jobType: "money_refresh",
        request: { ...request, status: "validated", queuedAt: null },
        safety: safetyForInternalAction(
          "money_refresh",
          "Money refresh queues CourierCloud economics extraction only. No outbound email or TMS mutation is created.",
        ),
      },
    };
  }
  if (!queueJob) {
    return {
      statusCode: 202,
      body: {
        ok: true,
        queued: false,
        recorded: true,
        direct: false,
        jobType: "money_refresh",
        request,
        safety: safetyForInternalAction(
          "money_refresh",
          "Money refresh request recorded locally. No outbound email or TMS mutation was created.",
        ),
      },
    };
  }
  const queueResult = await queueMoneyRefreshAgentJob(action, request);
  return {
    statusCode: 202,
    body: {
      ok: true,
      queued: Boolean(queueResult?.job?.id),
      duplicate: Boolean(queueResult?.duplicate),
      direct: false,
      jobType: "money_refresh",
      request: {
        ...request,
        agentJobId: queueResult?.job?.id || null,
        duplicate: Boolean(queueResult?.duplicate),
      },
      safety: safetyForInternalAction(
        "money_refresh",
        "Queued money refresh as a CourierCloud economics extraction intent. No outbound email or TMS mutation was created.",
      ),
    },
  };
}

module.exports = {
  handleMoneyContextAction,
  isMoneyContextAction,
  moneyRefreshRequestForAction,
  normalizeAwb,
  validateMoneyContextAction,
  MONEY_REFRESH_PRIORITY,
};

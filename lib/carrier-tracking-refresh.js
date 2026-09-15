"use strict";

const { queueAgentJob } = require("./supabase-agent");
const {
  operatorApprovedInternalContract,
  safetyForInternalAction,
} = require("./action-safety");

const TRACKING_REFRESH_PRIORITY = 2;

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function isCarrierTrackingRefreshAction(action) {
  return Boolean(
    action &&
      action.type === "carrier-tracking-refresh" &&
      ["platform", "companion", "ops-brain"].includes(String(action.channel || "").toLowerCase()),
  );
}

function directUnitedTrackingSupported(action = {}) {
  const normalizedAwb = normalizeAwb(action.awb || action.shipmentAwb || "");
  const carrierText = `${action.carrier || ""} ${action.liveTracking?.source || ""}`;
  return normalizedAwb.startsWith("016") || /\bunited\b/i.test(carrierText);
}

function actionNeedsFlightIntelligence(action = {}) {
  const text = [
    action.flightIntelligenceRequired,
    action.liveTracking?.requiresFlightIntelligence,
    action.trackingException?.type,
    action.problem,
    action.reason,
    action.nextAction,
    action.body,
  ].filter(Boolean).join(" ");
  if (/flight[-\s]?intelligence|flight status|public flight/i.test(text)) return true;
  return !directUnitedTrackingSupported(action);
}

function dedupeBucket(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return String(now || "").slice(0, 16);
  date.setUTCSeconds(0, 0);
  return date.toISOString().slice(0, 16);
}

function carrierTrackingRefreshRequestForAction(action, now = new Date().toISOString()) {
  const awb = action?.awb || action?.shipmentAwb || "";
  const normalizedAwb = normalizeAwb(awb);
  const flightIntelligenceRequired = actionNeedsFlightIntelligence(action);
  const flightDetails = action.flightDetails || action.liveTracking?.flightDetails || null;
  const publicFlightStatus = action.publicFlightStatus || action.liveTracking?.publicFlightStatus || null;
  return {
    id: `${action.id || `carrier-tracking-refresh-${normalizedAwb}`}-${Date.parse(now) || Date.now()}`,
    actionId: action.id || "",
    shipmentId: action.shipmentId || action.id || "",
    awb,
    normalizedAwb,
    type: "carrier-tracking-refresh",
    label: action.label || (flightIntelligenceRequired ? "Check flight status" : "Verify movement"),
    status: "queued",
    queuedAt: now,
    requestedAt: now,
    source: "ops-brain-movement-verification",
    carrier: action.carrier || action.liveTracking?.source || "",
    station: action.station || "",
    orderLink: action.orderLink || "",
    reason: action.reason || action.problem || "",
    trackingError: action.trackingError || action.liveTracking?.error || "",
    movementVerification: true,
    flightIntelligenceRequired,
    flightDetails,
    flights: action.flights || action.liveTracking?.flights || flightDetails?.flights || [],
    tmsFlight: action.tmsFlight || action.liveTracking?.tmsFlight || flightDetails?.tmsFlight || "",
    route: action.route || action.liveTracking?.route || flightDetails?.route || "",
    publicFlightStatus,
    expectedOutput: [
      "For United AWBs, refresh United Cargo movement from the official United flow",
      "For non-United AWBs, use TMS/Gmail flight details plus public flight-status research instead of weak carrier cargo pages",
      "Do not run Gmail ingestion and do not mutate CourierCloud/TMS",
      "Write movement-verification snapshots with flight candidates, public lookup result, and source-quality notes",
      "Run npm run refresh and publish snapshots after movement truth is updated",
      "If flight status is known but station/on-hand proof is missing, keep the shipment source-unverified and preserve the operator repair action",
    ],
    autonomy: {
      level: "L2",
      mode: "operator-approved-internal",
      requiresHumanApproval: true,
      liveExecution: true,
      transport: "tracking_refresh",
    },
    safety: safetyForInternalAction(
      "tracking_refresh",
      "Movement verification queues United tracking or flight-status research only. No outbound email or TMS mutation is created.",
    ),
    betaContract: operatorApprovedInternalContract("tracking_refresh"),
  };
}

function validateCarrierTrackingRefreshAction(actionId, action) {
  if (!action) return "Action not found";
  if (!isCarrierTrackingRefreshAction(action)) return "Action is not a carrier-tracking platform action";
  if (actionId && action.id && actionId !== action.id) return "Action id mismatch";
  if (!normalizeAwb(action.awb || action.shipmentAwb)) return "Movement verification requires AWB";
  return "";
}

async function queueCarrierTrackingRefreshAgentJob(action, request, options = {}) {
  const payload = {
    source: "movement-verification-action",
    actionId: action.id || "",
    awbs: [request.awb],
    trackingRefresh: true,
    movementVerification: true,
    flightIntelligenceRequired: request.flightIntelligenceRequired,
    carrier: request.carrier,
    station: request.station,
    orderLink: request.orderLink,
    trackingError: request.trackingError,
    flightDetails: request.flightDetails,
    flights: request.flights,
    tmsFlight: request.tmsFlight,
    route: request.route,
    publicFlightStatus: request.publicFlightStatus,
    requestedAt: request.requestedAt,
    expectedOutput: request.expectedOutput,
    betaContract: operatorApprovedInternalContract("tracking_refresh"),
  };
  const dedupeKey = options.dedupeKey || `tracking-refresh:${request.normalizedAwb}:${dedupeBucket(request.requestedAt)}`;
  return queueAgentJob("tracking_refresh", payload, {
    dedupeKey,
    priority: TRACKING_REFRESH_PRIORITY,
    maxAttempts: 2,
  });
}

async function handleCarrierTrackingRefreshAction(actionId, action, { dryRun = false, now = new Date().toISOString(), queueJob = true } = {}) {
  const validationError = validateCarrierTrackingRefreshAction(actionId, action);
  if (validationError) {
    return {
      statusCode: validationError === "Action not found" ? 404 : 409,
      body: { error: validationError },
    };
  }
  const request = carrierTrackingRefreshRequestForAction(action, now);
  if (dryRun) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        dryRun: true,
        queued: false,
        wouldQueue: true,
        direct: false,
        jobType: "tracking_refresh",
        request: { ...request, status: "validated", queuedAt: null },
        safety: safetyForInternalAction(
          "tracking_refresh",
          "Movement verification queues United tracking or flight-status research only. No outbound email or TMS mutation is created.",
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
        jobType: "tracking_refresh",
        request,
        safety: safetyForInternalAction(
          "tracking_refresh",
          "Movement verification request recorded locally. No outbound email or TMS mutation was created.",
        ),
      },
    };
  }
  const queueResult = await queueCarrierTrackingRefreshAgentJob(action, request);
  return {
    statusCode: 202,
    body: {
      ok: true,
      queued: Boolean(queueResult?.job?.id),
      duplicate: Boolean(queueResult?.duplicate),
      direct: false,
      jobType: "tracking_refresh",
      request: {
        ...request,
        agentJobId: queueResult?.job?.id || null,
        duplicate: Boolean(queueResult?.duplicate),
      },
      safety: safetyForInternalAction(
        "tracking_refresh",
        "Queued movement verification as a United-tracking or flight-status research intent. No outbound email or TMS mutation was created.",
      ),
    },
  };
}

module.exports = {
  TRACKING_REFRESH_PRIORITY,
  carrierTrackingRefreshRequestForAction,
  handleCarrierTrackingRefreshAction,
  isCarrierTrackingRefreshAction,
  normalizeAwb,
  validateCarrierTrackingRefreshAction,
};

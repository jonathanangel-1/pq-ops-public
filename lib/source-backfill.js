"use strict";

const { queueAgentJob } = require("./supabase-agent");
const {
  CANONICAL_GMAIL_INGESTION_PIPELINE,
  canonicalGmailIngestionPolicy,
  legacyGmailIngestionAllowed,
} = require("./gmail-ingestion-authority");
const {
  operatorApprovedInternalContract,
  safetyForInternalAction,
} = require("./action-safety");

const DEFAULT_LOOKBACK_DAYS = 120;
const SOURCE_BACKFILL_PRIORITY = 1;
const LEGACY_SOURCE_BACKFILL_JOB_TYPE = "email_refresh";

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function isSourceBackfillAction(action) {
  return Boolean(action && action.type === "source-backfill" && ["platform", "companion", "ops-brain"].includes(String(action.channel || "").toLowerCase()));
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function missingStagesForAction(action = {}) {
  const explicitStages = unique([
    ...(action.sourceCoverage?.missingPreDeliveryStages || []),
    ...(action.missingPreDeliveryStages || []),
  ]).map((stage) => stage.toLowerCase());
  if (explicitStages.length) return explicitStages;
  return unique(
    String(action.problem || action.reason || action.body || "")
      .match(/\b(?:arrival|customs|fees|quote|dispatch|pickup|delivery|pod|closeout)\b/gi) || [],
  ).map((stage) => stage.toLowerCase());
}

function lookbackDaysForAction(action = {}) {
  const explicit = Number(action.lookbackDays || action.sourceCoverage?.lookbackDays || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(365, Math.max(7, Math.round(explicit)));
  const envValue = Number(process.env.PQ_GMAIL_SOURCE_BACKFILL_LOOKBACK_DAYS || process.env.PQ_GMAIL_COMPLETED_BACKFILL_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS);
  return Number.isFinite(envValue) && envValue > 0 ? Math.min(365, Math.max(7, Math.round(envValue))) : DEFAULT_LOOKBACK_DAYS;
}

function sourceBackfillRequestForAction(action, now = new Date().toISOString()) {
  const awb = action?.awb || action?.shipmentAwb || "";
  const normalizedAwb = normalizeAwb(awb);
  const missingStages = missingStagesForAction(action);
  const lookbackDays = lookbackDaysForAction(action);
  return {
    id: `${action.id || `source-backfill-${normalizedAwb}`}-${Date.parse(now) || Date.now()}`,
    actionId: action.id || "",
    shipmentId: action.shipmentId || action.id || "",
    awb,
    normalizedAwb,
    type: "source-backfill",
    label: action.label || "Backfill shipment source trail",
    status: "queued",
    queuedAt: now,
    requestedAt: now,
    mailbox: "contact-052@demo-freight.example",
    source: "ops-brain-source-backfill",
    lookbackDays,
    missingStages,
    sourceCoverage: action.sourceCoverage || null,
    reason: action.reason || action.problem || "",
    expectedOutput: [
      "Search exact AWB, undashed AWB, and suffix-only AWB across Gmail/TMS history",
      "Attach arrival, release/DO, fee/payment, dispatch/award, pickup, delivery, POD, and closeout evidence by stage",
      "Extract and attach broker/station contacts and source threads when the blocker is a missing owner or contact",
      "Merge evidence into gmail-proof-snapshot and completed shipment sourceCoverage",
      "Run npm run refresh and npm run verify:historical-replay after evidence is written",
    ],
    autonomy: {
      level: "L2",
      mode: "operator-approved-internal",
      requiresHumanApproval: true,
      liveExecution: true,
      transport: CANONICAL_GMAIL_INGESTION_PIPELINE,
    },
    safety: safetyForInternalAction(
      CANONICAL_GMAIL_INGESTION_PIPELINE,
      "Source backfill records Gmail source debt for the canonical direct-ingestion lane. No outbound email or TMS mutation is created.",
    ),
    betaContract: operatorApprovedInternalContract(CANONICAL_GMAIL_INGESTION_PIPELINE),
  };
}

function validateSourceBackfillAction(actionId, action) {
  if (!action) return "Action not found";
  if (!isSourceBackfillAction(action)) return "Action is not a source-backfill platform action";
  if (actionId && action.id && actionId !== action.id) return "Action id mismatch";
  if (!normalizeAwb(action.awb || action.shipmentAwb)) return "Source backfill requires AWB";
  return "";
}

async function queueSourceBackfillAgentJob(action, request, options = {}) {
  if (!legacyGmailIngestionAllowed(options)) {
    const policy = canonicalGmailIngestionPolicy();
    throw new Error(
      `source-backfill legacy ${LEGACY_SOURCE_BACKFILL_JOB_TYPE} queue is quarantined. ` +
        `Use ${policy.canonicalPipeline} for production truth, or enable the explicit legacy development backfill flag.`,
    );
  }
  const payload = {
    source: "source-backfill-action",
    actionId: action.id || "",
    awbs: [request.awb],
    sourceBackfill: true,
    lookbackDays: request.lookbackDays,
    missingStages: request.missingStages,
    betaContract: operatorApprovedInternalContract(LEGACY_SOURCE_BACKFILL_JOB_TYPE),
    requestedAt: request.requestedAt,
    expectedOutput: request.expectedOutput,
  };
  const dedupeKey = options.dedupeKey || `source-backfill:${request.normalizedAwb}:${request.missingStages.join("-") || "lifecycle"}`;
  return queueAgentJob(LEGACY_SOURCE_BACKFILL_JOB_TYPE, payload, {
    dedupeKey,
    priority: SOURCE_BACKFILL_PRIORITY,
    maxAttempts: 2,
  });
}

function canonicalSourceBackfillBody(request, { dryRun = false, now = new Date().toISOString() } = {}) {
  const policy = canonicalGmailIngestionPolicy();
  return {
    ok: true,
    dryRun,
    queued: false,
    wouldQueue: false,
    recorded: !dryRun,
    cronOwned: true,
    direct: false,
    jobType: policy.canonicalPipeline,
    legacyJobType: LEGACY_SOURCE_BACKFILL_JOB_TYPE,
    canonicalPipeline: policy.canonicalPipeline,
    request: {
      ...request,
      status: dryRun ? "validated" : "cron-owned",
      queuedAt: null,
      recordedAt: dryRun ? null : now,
      canonicalPipeline: policy.canonicalPipeline,
    },
    safety: safetyForInternalAction(
      policy.canonicalPipeline,
      "Canonical Gmail OAuth ingestion owns source proof repair. This action records the need for source evidence; it does not queue a legacy email_refresh job, send email, or mutate TMS.",
    ),
  };
}

async function handleSourceBackfillAction(actionId, action, { dryRun = false, now = new Date().toISOString(), queueJob = true } = {}) {
  const validationError = validateSourceBackfillAction(actionId, action);
  if (validationError) {
    return {
      statusCode: validationError === "Action not found" ? 404 : 409,
      body: { error: validationError },
    };
  }
  const request = sourceBackfillRequestForAction(action, now);
  if (dryRun) {
    return {
      statusCode: 200,
      body: canonicalSourceBackfillBody(request, { dryRun: true, now }),
    };
  }
  if (!queueJob) {
    return {
      statusCode: 202,
      body: canonicalSourceBackfillBody(request, { dryRun: false, now }),
    };
  }
  if (!legacyGmailIngestionAllowed()) {
    return {
      statusCode: 202,
      body: canonicalSourceBackfillBody(request, { dryRun: false, now }),
    };
  }
  const queueResult = await queueSourceBackfillAgentJob(action, request);
  return {
    statusCode: 202,
    body: {
      ok: true,
      queued: Boolean(queueResult?.job?.id),
      duplicate: Boolean(queueResult?.duplicate),
      direct: false,
      jobType: LEGACY_SOURCE_BACKFILL_JOB_TYPE,
      legacyJobType: LEGACY_SOURCE_BACKFILL_JOB_TYPE,
      request: {
        ...request,
        agentJobId: queueResult?.job?.id || null,
        duplicate: Boolean(queueResult?.duplicate),
      },
      safety: safetyForInternalAction(
        LEGACY_SOURCE_BACKFILL_JOB_TYPE,
        "Queued source backfill as an explicit legacy Gmail refresh intent. No outbound email or TMS mutation was created.",
      ),
    },
  };
}

module.exports = {
  handleSourceBackfillAction,
  isSourceBackfillAction,
  lookbackDaysForAction,
  missingStagesForAction,
  normalizeAwb,
  sourceBackfillRequestForAction,
  validateSourceBackfillAction,
  SOURCE_BACKFILL_PRIORITY,
};

"use strict";

const crypto = require("node:crypto");
const {
  RUNTIME_VERSION,
  createHostedTruthShadowRuntime,
} = require("../../lib/hosted-truth-shadow-runtime");
const {
  PRODUCER_LANES,
  normalizeAuditProducerContext,
} = require("../../lib/truth-audit-ledger");
const {
  ORCHESTRATOR_VERSION,
  SHADOW_CHANNEL,
} = require("../../lib/truth-shadow-orchestrator");
const { PINNED_MODEL } = require("../../lib/openai-gmail-model-extractor");
const {
  createRuntimeDeadline,
  isAbortError,
} = require("../../lib/runtime-deadline");

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function authorizationHeader(request) {
  return String(request?.headers?.authorization || request?.headers?.Authorization || "");
}

function secretMatches(request, secret) {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const supplied = Buffer.from(authorizationHeader(request), "utf8");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^truth-shadow-run:v1:[0-9a-f]{64}$/;
const SOURCE_CUT_ID_RE = /^(?:source-)?cut:v1:[0-9a-f]{64}$/;
const TERMINAL_KEYS = Object.freeze([
  "finishedAt",
  "incompleteReasons",
  "mutatesOperationalState",
  "ok",
  "operationalEffectsAttempted",
  "orchestratorVersion",
  "producerContext",
  "productionPublicationAttempted",
  "publicationChannel",
  "runId",
  "sourceCutId",
  "stages",
  "startedAt",
  "status",
  "workerFailureCount",
  "workerRounds",
  "workspaceKey",
].sort());
const ALLOWED_STAGE_KEYS = new Set([
  "audit",
  "gmailBackfill",
  "gmailIncremental",
  "shadowBuild",
  "sourceCut",
  "workerRounds",
]);
const MODEL_PROVIDER_STATUSES = new Set([
  "adapter_configuration_error",
  "disabled",
  "missing_fetch",
  "missing_or_invalid_key",
  "ready",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalJson(value[key]);
    return output;
  }, {});
}

function gapHash(gaps) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalJson(gaps)), "utf8")
    .digest("hex");
}

function terminalReceiptError(reason, code = "TRUTH_SHADOW_RUNTIME_RECEIPT_INVALID") {
  const error = new Error(`Truth shadow runtime returned an invalid terminal receipt: ${reason}`);
  error.code = code;
  error.stage = "runtime_receipt";
  return error;
}

function syncDisposition(value) {
  const status = String(value?.status || "");
  if (["committed", "no_changes"].includes(status)) return "ready";
  if (status === "backfill_required") return "backfill";
  if (status === "reconcile_required") return "reconciliation";
  if (["lease_busy", "lease_lost"].includes(status)) return "busy";
  if (["partial", "source_not_ready"].includes(status)) return "yield";
  return "";
}

function exactShadowPublicationChannel(result) {
  const build = result?.stages?.shadowBuild;
  const publication = build?.publication;
  const adapter = publication?.publicationAdapter;
  const exact = build?.status === "succeeded"
    && isPlainObject(publication)
    && publication.ok === true
    && publication.channel === SHADOW_CHANNEL
    && UUID_RE.test(String(publication.publicationId || ""))
    && UUID_RE.test(String(publication.buildId || ""))
    && Number.isSafeInteger(publication.publicationVersion)
    && publication.publicationVersion > 0
    && SOURCE_CUT_ID_RE.test(String(publication.sourceCutId || ""))
    && publication.sourceCutId === result.sourceCutId
    && [
      "packetHash",
      "reducerPacketHash",
      "semanticHash",
      "deliveryPayloadHash",
      "activeIndexHash",
    ].every((field) => HASH_RE.test(String(publication[field] || "")))
    && isPlainObject(adapter)
    && adapter.publicationId === publication.publicationId
    && adapter.publicationVersion === publication.publicationVersion
    && adapter.channel === publication.channel
    && adapter.sourceCutId === publication.sourceCutId
    && adapter.packetHash === publication.reducerPacketHash;
  return exact ? SHADOW_CHANNEL : null;
}

function assertTerminalReceipt(value) {
  if (!isPlainObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(TERMINAL_KEYS)
      || value.ok !== true
      || !["succeeded", "degraded", "busy", "failed"].includes(value.status)
      || value.orchestratorVersion !== ORCHESTRATOR_VERSION
      || value.workspaceKey !== "primary"
      || !RUN_ID_RE.test(String(value.runId || ""))
      || !Number.isFinite(Date.parse(String(value.startedAt || "")))
      || !Number.isFinite(Date.parse(String(value.finishedAt || "")))
      || Date.parse(value.finishedAt) < Date.parse(value.startedAt)
      || !Number.isSafeInteger(value.workerRounds) || value.workerRounds < 0 || value.workerRounds > 100
      || !Number.isSafeInteger(value.workerFailureCount) || value.workerFailureCount < 0
      || !Array.isArray(value.incompleteReasons) || value.incompleteReasons.length > 1000
      || value.incompleteReasons.some((reason) => (
        typeof reason !== "string" || !reason || reason.trim() !== reason
        || Buffer.byteLength(reason, "utf8") > 1000
      ))
      || (value.sourceCutId !== null && !SOURCE_CUT_ID_RE.test(String(value.sourceCutId || "")))
      || value.operationalEffectsAttempted !== false
      || value.productionPublicationAttempted !== false
      || value.mutatesOperationalState !== false
      || !isPlainObject(value.stages)) {
    throw terminalReceiptError("top-level identity, counters, or no-mutation contract is invalid");
  }
  if (value.status === "failed") {
    throw terminalReceiptError("the orchestrator reported a failed producer", "TRUTH_SHADOW_RUNTIME_REPORTED_FAILURE");
  }
  const stageKeys = Object.keys(value.stages);
  if (stageKeys.some((key) => !ALLOWED_STAGE_KEYS.has(key))
      || !stageKeys.includes("gmailIncremental")
      || !stageKeys.includes("workerRounds")
      || !stageKeys.includes("audit")
      || !Array.isArray(value.stages.workerRounds)
      || value.stages.workerRounds.length !== value.workerRounds) {
    throw terminalReceiptError("stage inventory does not match the terminal worker rounds");
  }

  let producerContext;
  try {
    producerContext = normalizeAuditProducerContext(value.producerContext, {
      expectedLane: PRODUCER_LANES.shadow,
    });
  } catch {
    throw terminalReceiptError("producer context is invalid");
  }
  if (producerContext.workerRounds !== value.workerRounds
      || producerContext.workerFailureCount !== value.workerFailureCount
      || producerContext.sourceCutId !== (value.sourceCutId || "")
      || (value.status === "succeeded" && producerContext.producerStatus !== "succeeded")
      || (value.status === "busy" && producerContext.producerStatus !== "busy")
      || (value.status === "degraded"
        && !["succeeded", "degraded"].includes(producerContext.producerStatus))
      || (value.status === "succeeded" && value.incompleteReasons.length !== 0)
      || (value.status === "degraded" && value.incompleteReasons.length === 0)) {
    throw terminalReceiptError("outer status differs from the producer context");
  }

  const incrementalDisposition = syncDisposition(value.stages.gmailIncremental);
  const backfill = value.stages.gmailBackfill;
  let finalSyncDisposition = incrementalDisposition;
  if (["backfill", "reconciliation"].includes(incrementalDisposition)) {
    finalSyncDisposition = backfill === undefined ? "yield" : syncDisposition(backfill);
  } else if (backfill !== undefined) {
    throw terminalReceiptError("Gmail backfill stage lacks incremental backfill authority");
  }
  if (!finalSyncDisposition || ["backfill", "reconciliation"].includes(finalSyncDisposition)
      || finalSyncDisposition !== producerContext.gmailSyncDisposition) {
    throw terminalReceiptError("Gmail sync stages differ from the producer disposition");
  }

  let observedWorkerFailures = 0;
  for (const [index, round] of value.stages.workerRounds.entries()) {
    if (!isPlainObject(round)
        || JSON.stringify(Object.keys(round).sort())
          !== JSON.stringify(["claimedCount", "round", "workers"])
        || round.round !== index + 1
        || !Number.isSafeInteger(round.claimedCount) || round.claimedCount < 0
        || !Array.isArray(round.workers)) {
      throw terminalReceiptError("worker-round receipt is malformed or out of order");
    }
    let roundClaimedCount = 0;
    for (const worker of round.workers) {
      const receipt = worker?.receipt;
      if (!isPlainObject(worker) || typeof worker.name !== "string" || !worker.name
          || !isPlainObject(receipt)
          || !Number.isSafeInteger(receipt.claimedCount) || receipt.claimedCount < 0
          || !Number.isSafeInteger(receipt.succeededCount) || receipt.succeededCount < 0
          || !Number.isSafeInteger(receipt.failedCount) || receipt.failedCount < 0
          || receipt.succeededCount + receipt.failedCount !== receipt.claimedCount) {
        throw terminalReceiptError("worker receipt counts are malformed or do not reconcile");
      }
      roundClaimedCount += receipt.claimedCount;
      observedWorkerFailures += receipt.failedCount;
    }
    if (roundClaimedCount !== round.claimedCount) {
      throw terminalReceiptError("worker-round claimed count does not reconcile");
    }
  }
  const observedWorkersDrained = value.workerRounds > 0
    && value.stages.workerRounds.at(-1).claimedCount === 0;
  if (observedWorkerFailures !== value.workerFailureCount
      || producerContext.workersDrained !== observedWorkersDrained) {
    throw terminalReceiptError("worker-round inventory differs from terminal completeness");
  }

  const cut = value.stages.sourceCut;
  if (producerContext.sourceCutStatus === "not_run") {
    if (cut !== undefined || value.sourceCutId !== null
        || producerContext.sourceCutCompleteness !== "not_run"
        || producerContext.sourceGapCount !== 0
        || producerContext.sourceGapsHash !== gapHash([])) {
      throw terminalReceiptError("a not-run source cut cannot expose a cut stage or identity");
    }
  } else {
    const cutStatus = isPlainObject(cut) ? String(cut.status || "sealed") : "";
    if (!isPlainObject(cut)
        || cutStatus !== producerContext.sourceCutStatus
        || (cut.sourceCutId || "") !== producerContext.sourceCutId
        || cut.completeness !== producerContext.sourceCutCompleteness
        || !Array.isArray(cut.gaps)
        || cut.gaps.length !== producerContext.sourceGapCount
        || gapHash(cut.gaps) !== producerContext.sourceGapsHash) {
      throw terminalReceiptError("source-cut stage differs from its producer context");
    }
  }

  const build = value.stages.shadowBuild;
  if (producerContext.shadowBuildStatus === "not_run") {
    if (build !== undefined) throw terminalReceiptError("a not-run shadow build cannot expose a build stage");
  } else if (!isPlainObject(build) || build.status !== producerContext.shadowBuildStatus) {
    throw terminalReceiptError("shadow-build stage differs from its producer context");
  }
  const publicationChannel = exactShadowPublicationChannel(value);
  if (value.publicationChannel !== publicationChannel
      || (build?.status === "succeeded" && publicationChannel !== SHADOW_CHANNEL)) {
    throw terminalReceiptError("publication channel lacks an exact successful shadow receipt");
  }

  const audit = value.stages.audit;
  const auditSucceeded = isPlainObject(audit)
    && audit.ok === true
    && audit.status === "succeeded"
    && UUID_RE.test(String(audit.auditRunId || ""))
    && audit.mutatesOperationalState === false
    && sameJson(audit.producerContext, producerContext)
    && typeof audit.agreement === "boolean"
    && typeof audit.blockingAgreement === "boolean"
    && Number.isSafeInteger(audit.findingCount)
    && audit.findingCount >= 0;
  const auditBusy = isPlainObject(audit)
    && audit.ok === true
    && audit.status === "busy"
    && UUID_RE.test(String(audit.auditRunId || ""))
    && audit.mutatesOperationalState === false;
  if (!auditSucceeded && !auditBusy) {
    throw terminalReceiptError("terminal audit stage is missing, crossed, or malformed");
  }
  if (value.status === "succeeded" && (
    !auditSucceeded || audit.agreement !== true
    || audit.blockingAgreement !== true || audit.findingCount !== 0
  )) {
    throw terminalReceiptError("successful terminal status lacks a clean exact audit");
  }
  return value;
}

function safeCode(error) {
  return String(error?.code || "TRUTH_SHADOW_REFRESH_FAILED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 100) || "TRUTH_SHADOW_REFRESH_FAILED";
}

function safeError(error) {
  return String(error?.message || "Truth shadow refresh failed")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function summarize(result, configuration) {
  const audit = result?.stages?.audit || {};
  const build = result?.stages?.shadowBuild || {};
  const cut = result?.stages?.sourceCut || {};
  return Object.freeze({
    ok: result?.ok === true,
    status: String(result?.status || "unknown"),
    runId: result?.runId || null,
    runtimeVersion: RUNTIME_VERSION,
    orchestratorVersion: result?.orchestratorVersion || null,
    workspaceKey: result?.workspaceKey || "primary",
    startedAt: result?.startedAt || null,
    finishedAt: result?.finishedAt || null,
    sourceCutId: result?.sourceCutId || null,
    sourceCutCompleteness: cut.completeness || null,
    sourceGapCount: Array.isArray(cut.gaps) ? cut.gaps.length : null,
    shadowBuildStatus: build.status || null,
    shadowPublicationChannel: exactShadowPublicationChannel(result),
    workerRounds: Number(result?.workerRounds || 0),
    workerFailureCount: Number(result?.workerFailureCount || 0),
    incompleteReasons: Array.isArray(result?.incompleteReasons)
      ? result.incompleteReasons.slice(0, 100).map(String)
      : [],
    audit: {
      auditRunId: audit.auditRunId || null,
      status: audit.status || null,
      agreement: audit.agreement ?? null,
      blockingAgreement: audit.blockingAgreement ?? null,
      findingCount: Number(audit.findingCount || 0),
      findingsTruncated: audit.findingsTruncated === true,
    },
    capabilities: {
      gmailIngestPaused: configuration?.gmailIngestPaused === true,
      modelConfigured: configuration?.modelConfigured === true,
      modelRuntimeEnabled: configuration?.modelRuntimeEnabled === true,
      modelProviderStatus: MODEL_PROVIDER_STATUSES.has(configuration?.modelProviderStatus)
        ? configuration.modelProviderStatus
        : null,
      modelSnapshot: configuration?.modelSnapshot === PINNED_MODEL ? PINNED_MODEL : null,
      modelExecutionAuthority: configuration?.modelExecutionAuthority
        === "sealed_request_budget_and_dispatch"
        ? "sealed_request_budget_and_dispatch"
        : null,
      documentExtractorConfigured: configuration?.documentExtractorConfigured === true,
      requireModelForAmbiguity: configuration?.requireModelForAmbiguity !== false,
    },
    operationalEffectsAttempted: false,
    productionPublicationAttempted: false,
    mutatesOperationalState: false,
  });
}

function createTruthShadowRefreshHandler(options = {}) {
  const env = options.env || process.env;
  const runtimeFactory = options.createRuntime || createHostedTruthShadowRuntime;
  const respond = options.sendJson || sendJson;
  const now = options.now || Date.now;
  const randomUUID = options.randomUUID || crypto.randomUUID;

  return async function truthShadowRefreshHandler(request, response) {
    if (request.method !== "GET" && request.method !== "POST") {
      respond(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    if (!env.CRON_SECRET) {
      respond(response, 503, {
        ok: false,
        status: "not-configured",
        error: "CRON_SECRET is required for the truth-shadow endpoint.",
        mutatesOperationalState: false,
      });
      return;
    }
    if (!secretMatches(request, env.CRON_SECRET)) {
      respond(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }
    if (env.PQ_TRUTH_SHADOW_DISABLED === "1"
        || env.PQ_CRON_SUPABASE_PAUSED === "1"
        || env.PQ_SUPABASE_WRITES_DISABLED === "1") {
      respond(response, 200, {
        ok: true,
        status: "disabled",
        paused: true,
        reason: "Truth shadow is paused by PQ_TRUTH_SHADOW_DISABLED/PQ_CRON_SUPABASE_PAUSED/PQ_SUPABASE_WRITES_DISABLED.",
        productionPublicationAttempted: false,
        mutatesOperationalState: false,
      });
      return;
    }

    let deadline = null;
    try {
      const startedAtMs = Number(now());
      if (!Number.isFinite(startedAtMs)) throw new Error("Runtime clock returned a non-finite timestamp");
      const budgetMs = boundedInteger(env.PQ_TRUTH_SHADOW_RUNTIME_BUDGET_MS, 270_000, 30_000, 285_000);
      const requestedReserveMs = boundedInteger(
        env.PQ_TRUTH_SHADOW_RESPONSE_RESERVE_MS,
        15_000,
        5_000,
        60_000,
      );
      const responseReserveMs = Math.min(requestedReserveMs, budgetMs - 5_000);
      deadline = createRuntimeDeadline({
        deadlineAtMs: startedAtMs + budgetMs,
        responseReserveMs,
        now,
        stage: "truth shadow refresh",
      });
      const requestIdentity = String(request?.headers?.["x-vercel-id"] || randomUUID()).slice(0, 200);
      const runtime = runtimeFactory({
        env,
        signal: deadline.signal,
        deadlineAtMs: deadline.workDeadlineAtMs,
      });
      const result = assertTerminalReceipt(await runtime.run({
        ownerId: `vercel-cron:${requestIdentity}`,
        deadlineAtMs: deadline.workDeadlineAtMs,
        signal: deadline.signal,
      }));
      const body = summarize(result, runtime.configuration);
      console.log(JSON.stringify({
        event: "truth-shadow-refresh",
        status: body.status,
        runId: body.runId,
        sourceCutId: body.sourceCutId,
        shadowBuildStatus: body.shadowBuildStatus,
        workerFailureCount: body.workerFailureCount,
        auditRunId: body.audit.auditRunId,
        auditAgreement: body.audit.agreement,
        auditFindingCount: body.audit.findingCount,
        productionPublicationAttempted: false,
      }));
      respond(response, 200, body);
    } catch (error) {
      const deadlineFailure = isAbortError(error, deadline?.signal);
      respond(response, deadlineFailure ? 504 : 500, {
        ok: false,
        status: "failed",
        code: safeCode(error),
        stage: error?.stage || null,
        error: safeError(error),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        deadlineExceeded: deadlineFailure || error?.deadlineExceeded === true,
        productionPublicationAttempted: false,
        mutatesOperationalState: false,
      });
    } finally {
      deadline?.close();
    }
  };
}

const handler = createTruthShadowRefreshHandler();

module.exports = handler;
module.exports._test = Object.freeze({
  boundedInteger,
  assertTerminalReceipt,
  createTruthShadowRefreshHandler,
  exactShadowPublicationChannel,
  syncDisposition,
  safeCode,
  safeError,
  secretMatches,
  summarize,
});

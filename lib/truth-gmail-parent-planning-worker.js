"use strict";

const {
  EXTRACTOR_VERSION,
  planGmailClaimExtraction,
} = require("./gmail-claim-extractor");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");
const { buildPlanningFailurePlan } = require("./truth-gmail-model-plan-ledger");

const JOB_KIND = "gmail_extract_message_claims";
const RESULT_SCHEMA_VERSION = "truth-gmail-parent-planning-worker-result-v1";
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBSERVATION_RE = /^obs:v1:[0-9a-f]{64}$/;
const EXTRACTION_PLAN_RE = /^gmail-extraction-plan:v1:[0-9a-f]{64}$/;
const MODEL_PLAN_RE = /^gmail-model-plan:v1:[0-9a-f]{64}$/;
const REASON_RE = /^[A-Z][A-Z0-9_]{2,99}$/;
const ROOT_INGEST_MODES = Object.freeze([
  "history",
  "backfill",
  "reconciliation",
  "cutover_delta_reconciliation",
  "snapshot",
  "snapshot_recovery",
]);
const STALE_PLAN_CONFLICT_MESSAGE = "sealed Gmail extraction plan conflicts with retry input";
const PLAN_CONFIG = Object.freeze({
  dateOrder: "MDY",
  maxModelConfidence: 0.9,
});

class TruthGmailParentPlanningWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthGmailParentPlanningWorkerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthGmailParentPlanningWorkerError(
    `Invalid Gmail parent-planning worker argument ${field}: ${reason}`,
    { code: "TRUTH_GMAIL_PARENT_PLANNER_INVALID_ARGUMENT", field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value, field, maximumBytes = 4096) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalidArgument(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalidArgument(field, "is too long");
  }
  return value;
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireMethod(value, method, field) {
  if (!value || typeof value[method] !== "function") {
    throw invalidArgument(field, `must expose ${method}()`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function safeErrorCode(error) {
  const candidate = String(error?.code || "TRUTH_GMAIL_PARENT_PLANNING_FAILED").toUpperCase();
  return REASON_RE.test(candidate) ? candidate : "TRUTH_GMAIL_PARENT_PLANNING_FAILED";
}

function safeFailureDetail(error, errorCode, jobKind) {
  const cause = error?.cause && typeof error.cause === "object" ? error.cause : null;
  let body = cause?.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
  return JSON.stringify({
    schemaVersion: "truth-gmail-parent-planning-failure-v2",
    errorCode,
    underlyingCode: clean(error?.code),
    underlyingMessage: clean(error?.message),
    postgresCode: clean(cause?.code || body?.code),
    postgresMessage: clean(cause?.message || body?.message),
    postgresDetail: clean(body?.details),
    jobKind: String(jobKind || ""),
  });
}

function postgresErrorReceipt(error) {
  const candidates = [error, error?.cause, error?.cause?.cause];
  let fallback = { code: "", message: "" };
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    let body = candidate.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    const code = String(body?.code || candidate.code || "");
    const message = String(body?.message || candidate.message || "");
    if (code === "23505" && message === STALE_PLAN_CONFLICT_MESSAGE) return { code, message };
    if (!fallback.code && !fallback.message && (code || message)) fallback = { code, message };
  }
  return fallback;
}

function isStalePlanSealConflict(error) {
  const receipt = postgresErrorReceipt(error);
  return error?.operation === "seal Gmail parent extraction plan"
    && receipt.code === "23505"
    && receipt.message === STALE_PLAN_CONFLICT_MESSAGE;
}

function normalizeJob(value) {
  if (!isPlainObject(value) || value.jobKind !== JOB_KIND
      || !UUID_RE.test(String(value.jobId || ""))) {
    throw new TruthGmailParentPlanningWorkerError(
      "Claimed Gmail parent-planning job is invalid or has the wrong kind",
      { code: "TRUTH_GMAIL_PARENT_PLANNING_JOB_INVALID" },
    );
  }
  integer(value.leaseFence, "job.leaseFence", { minimum: 1 });
  return value;
}

function normalizePlanningContext(value, job, identity) {
  const sharedInvalid = !isPlainObject(value)
    || value.parentJobId !== job.jobId
    || value.sourceObservationId !== job.observationId
    || value.workerId !== identity.workerId
    || value.leaseFence !== job.leaseFence
    || value.processorVersion !== identity.processorVersion
    || !["ready", "review_required"].includes(value.status)
    || !OBSERVATION_RE.test(String(value.sourceObservationId || ""))
    || !HASH_RE.test(String(value.sourceObservationContentHash || ""))
    || !isPlainObject(value.observation)
    || value.observation.observationId !== value.sourceObservationId
    || value.observation.contentHash !== value.sourceObservationContentHash;
  if (sharedInvalid) {
    throw new TruthGmailParentPlanningWorkerError(
      "Gmail plan ledger returned a mismatched parent planning context",
      { code: "TRUTH_GMAIL_PARENT_PLANNING_CONTEXT_INVALID", retryable: true },
    );
  }
  if (value.status === "ready") {
    if (!isPlainObject(value.claimContext)
        || typeof value.observation.normalizedText !== "string"
        || !Array.isArray(value.claimContext.acceptedClaims)
        || (value.claimContext.workgroupContext !== null
          && !isPlainObject(value.claimContext.workgroupContext))
        || value.reasonCode !== "" || value.safeDetailHash !== "") {
      throw new TruthGmailParentPlanningWorkerError(
        "Ready Gmail parent planning context lacks exact immutable evidence",
        { code: "TRUTH_GMAIL_PARENT_PLANNING_CONTEXT_INVALID", retryable: true },
      );
    }
  } else if (value.claimContext !== null
      || !REASON_RE.test(String(value.reasonCode || ""))
      || !HASH_RE.test(String(value.safeDetailHash || ""))) {
    throw new TruthGmailParentPlanningWorkerError(
      "Review-required Gmail planning context lacks server-authored failure authority",
      { code: "TRUTH_GMAIL_PARENT_PLANNING_CONTEXT_INVALID", retryable: true },
    );
  }
  return value;
}

function normalizePlanReceipt(value, job, extractionPlan) {
  if (!isPlainObject(value) || value.parentJobId !== job.jobId
      || value.extractionPlanId !== extractionPlan.extractionPlanId
      || value.extractionPlanHash !== extractionPlan.extractionPlanHash
      || !EXTRACTION_PLAN_RE.test(String(value.extractionPlanId || ""))
      || !HASH_RE.test(String(value.planSealHash || ""))
      || !HASH_RE.test(String(value.deterministicManifestHash || ""))
      || !HASH_RE.test(String(value.plannedDeterministicCandidateSetHash || ""))
      || !Number.isSafeInteger(value.deterministicCandidateCount)
      || !Number.isSafeInteger(value.materializedDeterministicCandidateCount)
      || value.deterministicCandidateCount !== extractionPlan.deterministicCandidates.length
      || value.materializedDeterministicCandidateCount < 0
      || value.materializedDeterministicCandidateCount > value.deterministicCandidateCount
      || !["complete", "review_required"].includes(value.planningStatus)
      || (value.modelPlanId !== "" && !MODEL_PLAN_RE.test(String(value.modelPlanId || "")))) {
    throw new TruthGmailParentPlanningWorkerError(
      "Gmail plan ledger returned a mismatched atomic plan seal",
      { code: "TRUTH_GMAIL_PARENT_PLAN_SEAL_INVALID", retryable: true },
    );
  }
  const expectedModelPlanId = extractionPlan.modelPlan?.modelPlanId || "";
  if (value.modelPlanId !== expectedModelPlanId
      || (value.planningStatus === "complete"
        && value.materializedDeterministicCandidateCount !== value.deterministicCandidateCount)
      || (value.planningStatus === "review_required"
        && value.materializedDeterministicCandidateCount !== 0)) {
    throw new TruthGmailParentPlanningWorkerError(
      "Gmail plan seal differs from the requested complete or review plan",
      { code: "TRUTH_GMAIL_PARENT_PLAN_SEAL_INVALID", retryable: true },
    );
  }
  return value;
}

function normalizeResumedPlanReceipt(value, job) {
  const sharedInvalid = !isPlainObject(value)
    || value.ok !== true
    || value.schemaVersion !== "gmail-sealed-model-parent-resume-receipt-v1"
    || value.workspaceKey !== "primary"
    || value.parentJobId !== job.jobId
    || value.shadowOnly !== true
    || value.mutatesOperationalState !== false
    || value.productionPublicationAttempted !== false
    || !["not_resumable", "resumed_sealed_model_plan"].includes(value.status);
  if (sharedInvalid) {
    throw new TruthGmailParentPlanningWorkerError(
      "Gmail plan ledger returned an invalid sealed-parent resume receipt",
      { code: "TRUTH_GMAIL_PARENT_PLAN_RESUME_INVALID", retryable: true },
    );
  }
  if (value.status === "not_resumable") return null;
  if (!EXTRACTION_PLAN_RE.test(String(value.extractionPlanId || ""))
      || value.extractionPlanId !== `gmail-extraction-plan:v1:${value.extractionPlanHash}`
      || !HASH_RE.test(String(value.extractionPlanHash || ""))
      || !HASH_RE.test(String(value.deterministicManifestHash || ""))
      || !Number.isSafeInteger(value.deterministicCandidateCount)
      || !Number.isSafeInteger(value.materializedDeterministicCandidateCount)
      || value.deterministicCandidateCount < 0
      || value.deterministicCandidateCount > 2000
      || value.materializedDeterministicCandidateCount < 0
      || value.materializedDeterministicCandidateCount > 50
      || value.materializedDeterministicCandidateCount !== value.deterministicCandidateCount
      || !HASH_RE.test(String(value.plannedDeterministicCandidateSetHash || ""))
      || !/^gmail-model-context:v1:[0-9a-f]{64}$/.test(String(value.contextSealId || ""))
      || !MODEL_PLAN_RE.test(String(value.modelPlanId || ""))
      || !["sync", "batch", "parked"].includes(value.executionMode)
      || !ROOT_INGEST_MODES.includes(value.rootIngestMode)
      || value.planningStatus !== "complete"
      || value.planningFailureCode !== ""
      || !HASH_RE.test(String(value.planSealHash || ""))) {
    throw new TruthGmailParentPlanningWorkerError(
      "Gmail plan ledger did not return one complete self-owned model plan",
      { code: "TRUTH_GMAIL_PARENT_PLAN_RESUME_INVALID", retryable: true },
    );
  }
  return value;
}

function normalizePlanReconciliationReceipt(value, job, extractionPlan) {
  if (!isPlainObject(value)
      || value.ok !== true
      || value.status !== "requeued_current_plan"
      || value.schemaVersion !== "gmail-stale-extraction-plan-reconciliation-receipt-v1"
      || value.staleParentJobId !== job.jobId
      || !UUID_RE.test(String(value.successorJobId || ""))
      || value.expectedExtractionPlanId !== extractionPlan.extractionPlanId
      || value.expectedExtractionPlanHash !== extractionPlan.extractionPlanHash
      || value.deterministicCandidateCount !== extractionPlan.deterministicCandidates.length
      || value.shadowOnly !== true
      || value.mutatesOperationalState !== false
      || value.productionPublicationAttempted !== false) {
    throw new TruthGmailParentPlanningWorkerError(
      "Gmail plan reconciliation did not prove one exact shadow-only successor",
      { code: "TRUTH_GMAIL_PARENT_PLAN_RECONCILIATION_INVALID", retryable: true },
    );
  }
  return value;
}

function planFromContext(context, modelRuntimeEnabled) {
  if (context.status === "review_required") {
    return buildPlanningFailurePlan({
      observation: context.observation,
      extractorVersion: EXTRACTOR_VERSION,
      code: context.reasonCode,
      detailHash: context.safeDetailHash,
    });
  }
  return planGmailClaimExtraction({
    observation: context.observation,
    workgroupContext: context.claimContext.workgroupContext,
    acceptedClaims: context.claimContext.acceptedClaims,
  }, { ...PLAN_CONFIG, modelRuntimeEnabled });
}

function createTruthGmailParentPlanningWorker(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const jobLedger = requireMethod(options.jobLedger, "claimJobs", "jobLedger");
  requireMethod(jobLedger, "renewJob", "jobLedger");
  requireMethod(jobLedger, "failJob", "jobLedger");
  const planLedger = requireMethod(options.planLedger, "loadParentPlanningContext", "planLedger");
  requireMethod(planLedger, "resumeSealedParentPlan", "planLedger");
  requireMethod(planLedger, "sealParentPlan", "planLedger");
  requireMethod(planLedger, "reconcileStaleParentPlan", "planLedger");
  const completionWorker = requireMethod(options.completionWorker, "processJob", "completionWorker");
  const workerId = string(options.workerId, "workerId", 500);
  const processorVersion = string(options.processorVersion, "processorVersion", 500);
  if ((completionWorker.workerId && completionWorker.workerId !== workerId)
      || (completionWorker.processorVersion && completionWorker.processorVersion !== processorVersion)) {
    throw invalidArgument(
      "completionWorker",
      "must use the same worker identity and processor version as the parent planner",
    );
  }
  const leaseSeconds = integer(options.leaseSeconds ?? 300, "leaseSeconds", {
    minimum: 30,
    maximum: 900,
  });
  const retryAfterSeconds = integer(options.retryAfterSeconds ?? 30, "retryAfterSeconds", {
    minimum: 0,
    maximum: 86_400,
  });
  const modelRuntimeEnabled = options.modelRuntimeEnabled !== false;
  const sealedShadowResumeEnabled = modelRuntimeEnabled
    && String(jobLedger.scope?.connectionKey || "").startsWith("shadow-");
  const identity = Object.freeze({ workerId, processorVersion });

  function fenced(job) {
    return {
      jobId: job.jobId,
      workerId,
      leaseFence: job.leaseFence,
      processorVersion,
    };
  }

  function assertRuntime(runtime, stage) {
    throwIfAborted(runtime.signal, { stage, deadlineAtMs: runtime.deadlineAtMs });
  }

  async function processJob(rawJob, runtime = {}) {
    const job = normalizeJob(rawJob);
    let planReceipt;
    // A present model plan was already independently validated and sealed by
    // PostgreSQL. In model-on shadow mode that immutable self-owned artifact
    // wins over a fresh extraction-code derivation: resume it under the lease,
    // then let ordinary parent completion release the exact stored model child.
    // Null-model and malformed legacy plans remain outside this authority and
    // continue through the explicit runtime-disabled reconciliation path.
    if (sealedShadowResumeEnabled) {
      assertRuntime(runtime, `Gmail sealed model parent resume ${job.jobId}`);
      planReceipt = normalizeResumedPlanReceipt(
        await planLedger.resumeSealedParentPlan(fenced(job)),
        job,
      );
    }
    if (!planReceipt) {
      assertRuntime(runtime, `Gmail parent planning context ${job.jobId}`);
      const context = normalizePlanningContext(
        await planLedger.loadParentPlanningContext(fenced(job)),
        job,
        identity,
      );
      const extractionPlan = planFromContext(context, modelRuntimeEnabled);
      let effectivePlan = extractionPlan;
      assertRuntime(runtime, `Gmail parent planning lease renewal ${job.jobId}`);
      await jobLedger.renewJob({ ...fenced(job), leaseSeconds });
      assertRuntime(runtime, `Gmail parent plan seal ${job.jobId}`);
      try {
        planReceipt = normalizePlanReceipt(
          await planLedger.sealParentPlan({ ...fenced(job), extractionPlan: effectivePlan }),
          job,
          effectivePlan,
        );
      } catch (error) {
        if (!isStalePlanSealConflict(error)) throw error;

        // A commissioning replay can encounter a complete null-model seal from
        // an earlier deterministic attempt. Reconciliation deliberately accepts
        // only the exact MODEL_RUNTIME_DISABLED envelope, so derive that envelope
        // from the same immutable server context. If it is already the sealed
        // plan, resume and complete it idempotently; otherwise quarantine the
        // stale manifest and create the content-addressed successor. A later
        // commissioning pass can then issue a fresh model-bound replay.
        const reviewPlan = extractionPlan.schemaVersion === "gmail-claim-extraction-plan-failure-v2"
          && extractionPlan.planningFailure?.code === "MODEL_RUNTIME_DISABLED"
          ? extractionPlan
          : planFromContext(context, false);
        if (reviewPlan.schemaVersion !== "gmail-claim-extraction-plan-failure-v2"
            || reviewPlan.planningFailure?.code !== "MODEL_RUNTIME_DISABLED") throw error;

        if (reviewPlan !== extractionPlan) {
          try {
            assertRuntime(runtime, `Gmail runtime-disabled parent plan resume ${job.jobId}`);
            planReceipt = normalizePlanReceipt(
              await planLedger.sealParentPlan({
                ...fenced(job),
                extractionPlan: reviewPlan,
              }),
              job,
              reviewPlan,
            );
            effectivePlan = reviewPlan;
          } catch (reviewError) {
            if (!isStalePlanSealConflict(reviewError)) throw reviewError;
          }
        }

        if (!planReceipt) {
          assertRuntime(runtime, `Gmail stale parent plan reconciliation ${job.jobId}`);
          const reconciliation = normalizePlanReconciliationReceipt(
            await planLedger.reconcileStaleParentPlan({
              ...fenced(job),
              extractionPlan: reviewPlan,
            }),
            job,
            reviewPlan,
          );
          return deepFreeze({
            ok: true,
            jobId: job.jobId,
            schemaVersion: RESULT_SCHEMA_VERSION,
            planningStatus: "requeued_current_plan",
            extractionPlanId: reviewPlan.extractionPlanId,
            modelPlanId: "",
            candidateCount: 0,
            reconciliation,
          });
        }
        // Continue below when the exact runtime-disabled manifest already
        // existed; the parent still needs its ordinary fenced completion receipt.
      }
    } else {
      assertRuntime(runtime, `Gmail resumed parent lease renewal ${job.jobId}`);
      await jobLedger.renewJob({ ...fenced(job), leaseSeconds });
    }

    // The atomic plan sealer owns candidate materialization. The existing claim
    // worker then sees that exact sealed set, applies the established policy
    // acceptance boundary, and completes with childJobs:[]; SQL alone derives
    // the model or review child from the seal in the same completion transaction.
    assertRuntime(runtime, `Gmail sealed parent completion ${job.jobId}`);
    const completion = await completionWorker.processJob(job, runtime);
    if (!isPlainObject(completion) || completion.ok !== true
        || completion.jobId !== job.jobId || !isPlainObject(completion.result)
        || completion.result.candidateCount !== planReceipt.materializedDeterministicCandidateCount) {
      throw new TruthGmailParentPlanningWorkerError(
        "Gmail parent completion differs from the materialized deterministic manifest",
        { code: "TRUTH_GMAIL_PARENT_COMPLETION_INVALID", retryable: true },
      );
    }
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      schemaVersion: RESULT_SCHEMA_VERSION,
      planningStatus: planReceipt.planningStatus,
      extractionPlanId: planReceipt.extractionPlanId,
      modelPlanId: planReceipt.modelPlanId,
      candidateCount: planReceipt.materializedDeterministicCandidateCount,
      planReceipt,
      completion,
    });
  }

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("runOnce", "must be an object");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) {
      throw invalidArgument("signal", "must be an AbortSignal or null");
    }
    const limit = integer(input.limit ?? 10, "limit", { minimum: 1, maximum: 50 });
    throwIfAborted(signal, {
      stage: "Gmail parent-planning job claim",
      deadlineAtMs: input.deadlineAtMs,
    });
    const claim = await jobLedger.claimJobs({
      workerId,
      processorVersion,
      limit,
      leaseSeconds,
      jobKinds: [JOB_KIND],
    });
    if (!Array.isArray(claim?.jobs)) {
      throw new TruthGmailParentPlanningWorkerError(
        "Source-processing ledger returned an invalid Gmail parent claim receipt",
        { code: "TRUTH_GMAIL_PARENT_PLANNING_JOB_CLAIM_INVALID" },
      );
    }
    const jobs = [];
    for (const rawJob of claim.jobs) {
      try {
        jobs.push(await processJob(rawJob, { signal, deadlineAtMs: input.deadlineAtMs }));
      } catch (error) {
        if (error?.outcomeUnknown === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `Gmail parent planning job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `Gmail parent planning job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        const job = isPlainObject(rawJob) ? rawJob : {};
        const errorCode = safeErrorCode(error);
        let failureReceipt;
        try {
          failureReceipt = await jobLedger.failJob({
            ...fenced(job),
            errorCode,
            safeErrorDetail: safeFailureDetail(error, errorCode, job.jobKind),
            retryAfterSeconds,
          });
        } catch (acknowledgementError) {
          if (acknowledgementError?.outcomeUnknown === true
              || isAbortError(acknowledgementError, signal)) {
            throw asOutcomeUnknownError(acknowledgementError, {
              signal,
              stage: `Gmail parent planning failure acknowledgement ${job.jobId || "unknown"}`,
              deadlineAtMs: input.deadlineAtMs,
            });
          }
          throw acknowledgementError;
        }
        jobs.push(deepFreeze({
          ok: false,
          jobId: String(job.jobId || ""),
          errorCode,
          failureReceipt,
        }));
      }
    }
    const succeededCount = jobs.filter((job) => job.ok).length;
    return deepFreeze({
      ok: jobs.every((job) => job.ok),
      claimedCount: claim.jobs.length,
      succeededCount,
      failedCount: jobs.length - succeededCount,
      requeuedCount: jobs.filter((job) => job.planningStatus === "requeued_current_plan").length,
      jobs,
    });
  }

  return Object.freeze({
    jobKind: JOB_KIND,
    workerId,
    processorVersion,
    planConfig: PLAN_CONFIG,
    processJob,
    runOnce,
  });
}

module.exports = Object.freeze({
  JOB_KIND,
  PLAN_CONFIG,
  RESULT_SCHEMA_VERSION,
  TruthGmailParentPlanningWorkerError,
  createTruthGmailParentPlanningWorker,
  _test: Object.freeze({
    normalizeJob,
    normalizePlanReceipt,
    normalizeResumedPlanReceipt,
    normalizePlanReconciliationReceipt,
    normalizePlanningContext,
    planFromContext,
    isStalePlanSealConflict,
    safeErrorCode,
    safeFailureDetail,
  }),
});

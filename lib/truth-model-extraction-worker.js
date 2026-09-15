"use strict";

const crypto = require("node:crypto");
const { postgresJsonbText } = require("./postgres-jsonb");
const {
  MODEL_RESPONSE_JSON_SCHEMA,
  completeGmailModelExtraction,
  materializeGmailModelInput,
} = require("./gmail-claim-extractor");
const {
  DISPATCH_RECOVERY_REASON,
  DISPATCH_RECOVERY_REVIEW_REASON,
} = require("./truth-model-request-ledger");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");

const JOB_KIND = "gmail_extract_message_model_claims";
const RESULT_SCHEMA_VERSION = "truth-model-extraction-worker-result-v1";
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_PLAN_RE = /^gmail-model-plan:v1:[0-9a-f]{64}$/;
const MODEL_REQUEST_RE = /^model-request:v1:[0-9a-f]{64}$/;
const MODEL_DISPATCH_RE = /^model-dispatch:v1:[0-9a-f]{64}$/;
const REASON_RE = /^[A-Z][A-Z0-9_]{2,99}$/;
const STALE_TIME_BINDING_MESSAGE =
  "Invalid Gmail claim extraction argument modelPlan: source identity does not match its immutable observation";
const REQUEST_STATES = new Set([
  "planned",
  "reserved",
  "in_flight",
  "succeeded",
  "review_required",
  "outcome_unknown",
]);
const RECOVERY_PROVIDER_FACT_FIELDS = Object.freeze([
  "outcomeHash",
  "classification",
  "providerResultHash",
  "requestSent",
  "httpStatus",
  "requestBodyHash",
  "requestBodyBytes",
  "providerResponseBodyHash",
  "providerResponseBodyBytes",
  "providerErrorCode",
  "incompleteReason",
  "outcomeUnknown",
  "billingOutcomeUnknown",
  "providerResponseId",
  "serverRequestId",
  "actualModel",
  "normalizedResult",
  "normalizedResultHash",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "actualMicroUsd",
  "usage",
]);

class TruthModelExtractionWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthModelExtractionWorkerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthModelExtractionWorkerError(
    `Invalid truth model-extraction worker argument ${field}: ${reason}`,
    { code: "TRUTH_MODEL_EXTRACTION_WORKER_INVALID_ARGUMENT", field },
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

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 40) throw invalidArgument(field, "exceeds maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalidArgument(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) result[key] = cloneJson(value[key], `${field}.${key}`, depth + 1);
    }
    return result;
  }
  throw invalidArgument(field, "must contain JSON-compatible data only");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(canonicalize(value)));
}

function sha256Jsonb(value) {
  return sha256Text(postgresJsonbText(value));
}

function safeReason(value, fallback) {
  const candidate = String(value || "").toUpperCase();
  return REASON_RE.test(candidate) ? candidate : fallback;
}

function safeErrorCode(error) {
  return safeReason(error?.code, "TRUTH_MODEL_EXTRACTION_JOB_FAILED");
}

function normalizeJob(value) {
  if (!isPlainObject(value)) {
    throw new TruthModelExtractionWorkerError("Claimed model-extraction job must be an object", {
      code: "TRUTH_MODEL_EXTRACTION_JOB_INVALID",
    });
  }
  if (value.jobKind !== JOB_KIND) {
    throw new TruthModelExtractionWorkerError(`Unsupported model-extraction job kind ${value.jobKind}`, {
      code: "TRUTH_MODEL_EXTRACTION_JOB_KIND_UNSUPPORTED",
    });
  }
  if (!UUID_RE.test(String(value.jobId || ""))) {
    throw new TruthModelExtractionWorkerError("Claimed model-extraction job lacks a UUID identity", {
      code: "TRUTH_MODEL_EXTRACTION_JOB_INVALID",
    });
  }
  integer(value.leaseFence, "job.leaseFence", { minimum: 1 });
  return value;
}

function normalizeContext(value, job) {
  if (!isPlainObject(value) || value.jobId !== job.jobId || value.jobKind !== JOB_KIND
      || value.leaseFence !== job.leaseFence || !MODEL_PLAN_RE.test(String(value.modelPlanId || ""))
      || !["sync", "batch", "parked"].includes(value.executionMode)
      || !isPlainObject(value.modelPlan) || value.modelPlan.modelPlanId !== value.modelPlanId
      || !isPlainObject(value.observation) || typeof value.observation.normalizedText !== "string"
      || value.modelPlan.sourceObservationId !== value.observation.observationId
      || value.modelPlan.sourceObservationContentHash !== value.observation.contentHash
      || typeof value.processingConfigVersion !== "string" || !value.processingConfigVersion
      || !HASH_RE.test(String(value.processingConfigHash || ""))
      || !Array.isArray(value.acceptedClaims)) {
    throw new TruthModelExtractionWorkerError(
      "Model-plan ledger returned mismatched or incomplete sealed context",
      { code: "TRUTH_MODEL_EXTRACTION_CONTEXT_INVALID" },
    );
  }
  return value;
}

function normalizePreparedRequest(value, context) {
  if (!isPlainObject(value) || !isPlainObject(value.requestBody)
      || typeof value.requestBodyText !== "string" || value.requestBodyText.length < 1
      || !Number.isSafeInteger(value.requestBodyBytes) || value.requestBodyBytes < 1
      || !HASH_RE.test(String(value.requestBodyHash || ""))
      || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1
      || typeof value.requestedModel !== "string" || !value.requestedModel
      || typeof value.promptVersion !== "string" || !value.promptVersion
      || typeof value.responseSchemaVersion !== "string" || !value.responseSchemaVersion
      || value.modelPlanHash !== context.modelPlan.modelPlanHash
      || value.sourceObservationId !== context.observation.observationId
      || value.sourceObservationContentHash !== context.observation.contentHash
      || value.requestBodyText !== JSON.stringify(value.requestBody)
      || Buffer.byteLength(value.requestBodyText, "utf8") !== value.requestBodyBytes
      || sha256Text(value.requestBodyText) !== value.requestBodyHash) {
    throw new TruthModelExtractionWorkerError("Provider adapter returned an invalid sealed request", {
      code: "TRUTH_MODEL_EXTRACTION_PREPARED_REQUEST_INVALID",
    });
  }
  return value;
}

function requestFromReceipt(value) {
  if (isPlainObject(value?.request)) return value.request;
  return value;
}

function requestState(value) {
  const request = requestFromReceipt(value);
  return isPlainObject(request) && REQUEST_STATES.has(request.state) ? request.state : "";
}

function requestId(value) {
  const request = requestFromReceipt(value);
  const id = String(request?.requestId || value?.requestId || "");
  return MODEL_REQUEST_RE.test(id) ? id : "";
}

function latestSuccessfulAttempt(readReceipt) {
  const attempts = Array.isArray(readReceipt?.attempts) ? readReceipt.attempts : [];
  return [...attempts].reverse().find((attempt) => (
    attempt?.classification === "success"
      && isPlainObject(attempt.normalizedResult)
      && typeof attempt.providerResponseId === "string" && attempt.providerResponseId
      && typeof attempt.actualModel === "string" && attempt.actualModel
  )) || null;
}

function latestUnreconciledAttempt(readReceipt) {
  const attempts = Array.isArray(readReceipt?.attempts) ? readReceipt.attempts : [];
  return [...attempts].reverse().find((attempt) => (
    MODEL_DISPATCH_RE.test(String(attempt?.dispatchId || ""))
      && MODEL_REQUEST_RE.test(String(attempt?.requestId || ""))
      && Number.isSafeInteger(attempt?.attemptNumber)
      && attempt.attemptNumber >= 1 && attempt.attemptNumber <= 3
      && typeof attempt?.clientRequestId === "string" && attempt.clientRequestId
      && !attempt.classification
      && !isPlainObject(attempt.normalizedResult)
  )) || null;
}

function successfulOutcome(value) {
  if (isPlainObject(value?.normalizedResult)
      && typeof value.providerResponseId === "string" && value.providerResponseId
      && typeof value.actualModel === "string" && value.actualModel) {
    return value;
  }
  return latestSuccessfulAttempt(value);
}

function recoveryStateError(reason) {
  return new TruthModelExtractionWorkerError(
    `Model dispatch recovery cannot proceed: ${reason}`,
    {
      code: "TRUTH_MODEL_RECOVERY_STATE_INVALID",
      retryable: true,
    },
  );
}

function forcedReviewCandidates(candidates, context, model) {
  return Array.isArray(candidates) && candidates.length >= 1 && candidates.length <= 50
    && candidates.every((candidate) => (
      isPlainObject(candidate)
      && candidate.extractionMethod === "model"
      && candidate.model === model
      && candidate.promptVersion === context.modelPlan.promptVersion
      && candidate.sourceObservationId === context.observation.observationId
      && candidate.sourceObservationContentHash === context.observation.contentHash
      && candidate.ambiguity?.status === "review"
      && candidate.acceptanceRecommendation?.decision === "review"
      && candidate.acceptanceRecommendation?.method === "operator"
    ));
}

function validateRequestLookup(value, expected) {
  const request = value?.request;
  const invalidEnvelope = !isPlainObject(value)
    || value.ok !== true
    || typeof value.found !== "boolean"
    || (value.found === false && request !== null)
    || (value.found === true && !isPlainObject(request));
  const invalidRequest = value?.found === true && (
    !MODEL_REQUEST_RE.test(String(request.requestId || ""))
    || !REQUEST_STATES.has(request.state)
    || request.workspaceKey !== expected.workspaceKey
    || request.sourceJobId !== expected.sourceJobId
    || request.observationId !== expected.observationId
    || request.observationContentHash !== expected.observationContentHash
    || request.planHash !== expected.planHash
    || !Array.isArray(request.attempts)
  );
  if (invalidEnvelope || invalidRequest) {
    throw new TruthModelExtractionWorkerError(
      "Model request source-job lookup returned a mismatched receipt",
      {
        code: "TRUTH_MODEL_REQUEST_LOOKUP_INVALID",
        retryable: true,
      },
    );
  }
  return value;
}

function validateRecoveryReceipt(value, expected) {
  const request = value?.request;
  const heldInput = value?.heldReservedInputTokens;
  const heldOutput = value?.heldReservedOutputTokens;
  const heldMicroUsd = value?.heldReservedMicroUsd;
  const authorizationWorkerId = expected.authorizationWorkerId ?? null;
  const authorizationLeaseFence = expected.authorizationLeaseFence ?? null;
  const authorizationProcessorVersion = expected.authorizationProcessorVersion ?? null;
  const authorizationLeaseExpiresAt = expected.authorizationLeaseExpiresAt ?? null;
  const authorization = [
    authorizationWorkerId,
    authorizationLeaseFence,
    authorizationProcessorVersion,
    authorizationLeaseExpiresAt,
  ];
  const hasAuthorization = authorization.some((item) => item !== null);
  const authorizationValid = !hasAuthorization || (
    typeof authorizationWorkerId === "string" && authorizationWorkerId
    && Number.isSafeInteger(authorizationLeaseFence) && authorizationLeaseFence >= 1
    && typeof authorizationProcessorVersion === "string" && authorizationProcessorVersion
    && typeof authorizationLeaseExpiresAt === "string"
    && Number.isFinite(Date.parse(authorizationLeaseExpiresAt))
    && expected.leaseFence > authorizationLeaseFence
  );
  const dispatchAuthorizedAtMs = Date.parse(String(value?.dispatchAuthorizedAt || ""));
  const recoveredAtMs = Date.parse(String(value?.recoveredAt || ""));
  const expectedRecoveryHash = isPlainObject(value) ? sha256Jsonb({
    schemaVersion: "truth-model-dispatch-recovery-v1",
    workspaceKey: expected.workspaceKey,
    requestId: expected.requestId,
    dispatchId: expected.dispatchId,
    attemptNumber: expected.attemptNumber,
    sourceJobId: expected.jobId,
    recoveryKey: expected.recoveryKey,
    recoveryReason: DISPATCH_RECOVERY_REASON,
    externalEffectState: "unknown_possible_post",
    reservationDisposition: "held_conservatively",
    reviewDisposition: "non_resolvable_external_effect_uncertainty",
    authorizationWorkerId,
    authorizationLeaseFence,
    authorizationProcessorVersion,
    authorizationLeaseExpiresAt,
    recoveringWorkerId: expected.workerId,
    recoveringLeaseFence: expected.leaseFence,
    recoveringProcessorVersion: expected.processorVersion,
    heldReservedInputTokens: heldInput,
    heldReservedOutputTokens: heldOutput,
    heldReservedMicroUsd: heldMicroUsd,
    dispatchAuthorizedAt: expected.dispatchedAt,
  }) : "";
  const invalid = !isPlainObject(value)
    || value.ok !== true
    || typeof value.idempotent !== "boolean"
    || value.sendAuthorized !== false
    || value.quarantined !== true
    || value.schemaVersion !== "truth-model-dispatch-recovery-v1"
    || !/^model-dispatch-recovery:v1:[0-9a-f]{64}$/.test(String(value.recoveryId || ""))
    || !HASH_RE.test(String(value.recoveryHash || ""))
    || value.recoveryHash !== expectedRecoveryHash
    || value.recoveryId !== `model-dispatch-recovery:v1:${value.recoveryHash}`
    || value.workspaceKey !== expected.workspaceKey
    || value.recoveryKey !== expected.recoveryKey
    || value.requestId !== expected.requestId
    || value.dispatchId !== expected.dispatchId
    || value.attemptNumber !== expected.attemptNumber
    || value.sourceJobId !== expected.jobId
    || value.recoveryReason !== DISPATCH_RECOVERY_REASON
    || value.reviewReason !== DISPATCH_RECOVERY_REVIEW_REASON
    || value.externalEffectState !== "unknown_possible_post"
    || value.reservationDisposition !== "held_conservatively"
    || value.reviewDisposition !== "non_resolvable_external_effect_uncertainty"
    || value.recoveringWorkerId !== expected.workerId
    || value.recoveringLeaseFence !== expected.leaseFence
    || value.recoveringProcessorVersion !== expected.processorVersion
    || !authorizationValid
    || value.dispatchAuthorizedAt !== expected.dispatchedAt
    || !Number.isFinite(dispatchAuthorizedAtMs)
    || !Number.isFinite(recoveredAtMs)
    || recoveredAtMs < dispatchAuthorizedAtMs
    || (hasAuthorization && Date.parse(authorizationLeaseExpiresAt) < dispatchAuthorizedAtMs)
    || !Number.isSafeInteger(heldInput) || heldInput < 0
    || !Number.isSafeInteger(heldOutput) || heldOutput < 0
    || !Number.isSafeInteger(heldMicroUsd) || heldMicroUsd <= 0
    || !isPlainObject(request)
    || request.requestId !== expected.requestId
    || request.workspaceKey !== expected.workspaceKey
    || request.sourceJobId !== expected.jobId
    || request.observationId !== expected.observationId
    || request.observationContentHash !== expected.observationContentHash
    || request.planHash !== expected.planHash
    || request.state !== "outcome_unknown"
    || request.ok !== false
    || request.reviewReason !== DISPATCH_RECOVERY_REVIEW_REASON
    || request.remainingReservedInputTokens !== heldInput
    || request.remainingReservedOutputTokens !== heldOutput
    || request.remainingReservedMicroUsd !== heldMicroUsd
    || RECOVERY_PROVIDER_FACT_FIELDS.some((field) => (
      Object.prototype.hasOwnProperty.call(value, field)
    ));
  if (invalid) {
    throw new TruthModelExtractionWorkerError(
      "Model dispatch recovery returned an invalid or nonterminal receipt",
      {
        code: "TRUTH_MODEL_RECOVERY_RECEIPT_INVALID",
        retryable: true,
      },
    );
  }
  return value;
}

function createTruthModelExtractionWorker(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const jobLedger = requireMethod(options.jobLedger, "claimJobs", "jobLedger");
  requireMethod(jobLedger, "renewJob", "jobLedger");
  requireMethod(jobLedger, "completeJob", "jobLedger");
  requireMethod(jobLedger, "failJob", "jobLedger");
  const planLedger = requireMethod(options.planLedger, "loadModelContext", "planLedger");
  requireMethod(planLedger, "recordSuccessfulResult", "planLedger");
  requireMethod(planLedger, "createReviewIntent", "planLedger");
  requireMethod(planLedger, "createStaleTimeBindingReviewIntent", "planLedger");
  const modelRequestLedger = requireMethod(options.modelRequestLedger, "createRequest", "modelRequestLedger");
  requireMethod(modelRequestLedger, "reserveRequest", "modelRequestLedger");
  requireMethod(modelRequestLedger, "beginSyncAttempt", "modelRequestLedger");
  requireMethod(modelRequestLedger, "reconcileProviderAttempt", "modelRequestLedger");
  requireMethod(modelRequestLedger, "readRequest", "modelRequestLedger");
  requireMethod(modelRequestLedger, "recoverUnknownAttempt", "modelRequestLedger");
  requireMethod(modelRequestLedger, "findRequestForSourceJob", "modelRequestLedger");

  const providerAdapter = options.providerAdapter ?? null;
  if (providerAdapter !== null) {
    requireMethod(providerAdapter, "prepareRequest", "providerAdapter");
    requireMethod(providerAdapter, "executeAuthorizedAttempt", "providerAdapter");
  }
  const recoverUnknownAttempt = modelRequestLedger.recoverUnknownAttempt.bind(modelRequestLedger);
  const findRequestForSourceJob = modelRequestLedger.findRequestForSourceJob.bind(modelRequestLedger);
  const runtimeEnabled = options.runtimeEnabled === undefined ? true : options.runtimeEnabled;
  if (typeof runtimeEnabled !== "boolean") throw invalidArgument("runtimeEnabled", "must be boolean");
  const workerId = string(options.workerId, "workerId", 500);
  const processorVersion = string(options.processorVersion, "processorVersion", 500);
  const hasExpectedConfigVersion = options.expectedProcessingConfigVersion !== undefined;
  const hasExpectedConfigHash = options.expectedProcessingConfigHash !== undefined;
  if (hasExpectedConfigVersion !== hasExpectedConfigHash) {
    throw invalidArgument(
      "expectedProcessingConfig",
      "version and hash must either both be supplied or both be omitted",
    );
  }
  const expectedProcessingConfigVersion = hasExpectedConfigVersion
    ? string(options.expectedProcessingConfigVersion, "expectedProcessingConfigVersion", 500)
    : null;
  const expectedProcessingConfigHash = hasExpectedConfigHash
    ? string(options.expectedProcessingConfigHash, "expectedProcessingConfigHash", 64)
    : null;
  if (expectedProcessingConfigHash !== null && !HASH_RE.test(expectedProcessingConfigHash)) {
    throw invalidArgument("expectedProcessingConfigHash", "must be lowercase SHA-256 hex");
  }
  if (options.processingConfigVersion !== undefined || options.processingConfigHash !== undefined) {
    throw invalidArgument(
      "processingConfigVersion|processingConfigHash",
      "caller-selected processing authority is forbidden; use optional expectedProcessingConfig assertions",
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
  const responseSchemaHash = sha256Jsonb(MODEL_RESPONSE_JSON_SCHEMA);

  function fenced(job) {
    return {
      jobId: job.jobId,
      workerId,
      leaseFence: job.leaseFence,
      processorVersion,
    };
  }

  function assertRuntime(runtime, stage, outcomeUnknown = false) {
    throwIfAborted(runtime.signal, {
      stage,
      deadlineAtMs: runtime.deadlineAtMs,
      outcomeUnknown,
    });
  }

  async function renew(job, runtime, stage) {
    assertRuntime(runtime, stage);
    return jobLedger.renewJob({ ...fenced(job), leaseSeconds });
  }

  function reviewDetail(job, context, reasonCode, fields = {}) {
    return sha256Json({
      schemaVersion: "truth-model-extraction-review-detail-v1",
      jobId: job.jobId,
      modelPlanId: context.modelPlanId,
      sourceObservationId: context.observation.observationId,
      reasonCode,
      requestId: MODEL_REQUEST_RE.test(String(fields.requestId || "")) ? fields.requestId : "",
      requestState: REQUEST_STATES.has(fields.requestState) ? fields.requestState : "",
    });
  }

  async function finishReview(job, context, reason, fields = {}, runtime = {}) {
    const reasonCode = safeReason(reason, "MODEL_REQUEST_REVIEW_REQUIRED");
    const planAuthorized = reasonCode === "MODEL_EXECUTION_PARKED"
      && context.executionMode === "parked"
      && !fields.requestId;
    const requestAuthorized = MODEL_REQUEST_RE.test(String(fields.requestId || ""))
      && new Set(["review_required", "outcome_unknown"]).has(fields.requestState);
    if (!planAuthorized && !requestAuthorized) {
      throw new TruthModelExtractionWorkerError(
        "Model review intent lacks sealed plan or terminal request authority",
        {
          code: "TRUTH_MODEL_REVIEW_AUTHORITY_INVALID",
          retryable: true,
        },
      );
    }
    const safeDetailHash = reviewDetail(job, context, reasonCode, fields);
    await renew(job, runtime, `model review-intent lease renewal ${job.jobId}`);
    assertRuntime(runtime, `model review-intent write ${job.jobId}`);
    const reviewIntent = await planLedger.createReviewIntent({
      ...fenced(job),
      modelPlanId: context.modelPlanId,
      reasonCode,
      safeDetailHash,
    });
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      processorVersion,
      jobKind: JOB_KIND,
      sourceObservationId: context.observation.observationId,
      modelPlanId: context.modelPlanId,
      executionMode: context.executionMode,
      outcome: "review_required",
      reviewReason: reasonCode,
      safeDetailHash,
      modelRequestId: MODEL_REQUEST_RE.test(String(fields.requestId || "")) ? fields.requestId : "",
      candidateCount: 0,
    };
    await renew(job, runtime, `model review completion lease renewal ${job.jobId}`);
    assertRuntime(runtime, `model review completion ${job.jobId}`);
    const completion = await jobLedger.completeJob({
      ...fenced(job),
      result,
      observations: [],
      childJobs: [],
    });
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      outcome: "review_required",
      reviewIntent,
      completion,
      result,
    });
  }

  async function finishStaleTimeBindingReview(job, context, runtime = {}) {
    await renew(job, runtime, `stale-bound model review-intent lease renewal ${job.jobId}`);
    assertRuntime(runtime, `stale-bound model review-intent write ${job.jobId}`);
    const reviewIntent = await planLedger.createStaleTimeBindingReviewIntent({
      ...fenced(job),
      modelPlanId: context.modelPlanId,
    });
    const reasonCode = reviewIntent.reasonCode;
    const safeDetailHash = reviewIntent.safeDetailHash;
    if (reasonCode !== "STALE_IMMUTABLE_SOURCE_TIME_BINDING"
      || !HASH_RE.test(String(safeDetailHash || ""))) {
      throw new TruthModelExtractionWorkerError(
        "Stale-bound model review authority returned an invalid proof",
        { code: "TRUTH_MODEL_REVIEW_AUTHORITY_INVALID", retryable: true },
      );
    }
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      processorVersion,
      jobKind: JOB_KIND,
      sourceObservationId: context.observation.observationId,
      modelPlanId: context.modelPlanId,
      executionMode: context.executionMode,
      outcome: "review_required",
      reviewReason: reasonCode,
      safeDetailHash,
      modelRequestId: "",
      candidateCount: 0,
    };
    await renew(job, runtime, `stale-bound model review completion lease renewal ${job.jobId}`);
    assertRuntime(runtime, `stale-bound model review completion ${job.jobId}`);
    const completion = await jobLedger.completeJob({
      ...fenced(job),
      result,
      observations: [],
      childJobs: [],
    });
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      outcome: "review_required",
      reviewIntent,
      completion,
      result,
    });
  }

  async function finishSuccess(job, context, requestReceipt, outcomeReceipt, runtime = {}) {
    const id = requestId(requestReceipt) || requestId(outcomeReceipt);
    if (!id) {
      throw new TruthModelExtractionWorkerError("Successful model request lacks its durable identity", {
        code: "TRUTH_MODEL_EXTRACTION_SUCCESS_RECEIPT_INVALID",
      });
    }
    let outcome = successfulOutcome(outcomeReceipt);
    if (!outcome) {
      assertRuntime(runtime, `model successful request read ${job.jobId}`);
      const read = await modelRequestLedger.readRequest({ requestId: id });
      outcome = successfulOutcome(read);
    }
    if (!outcome) {
      return scheduleLocalPending(job, context, "MODEL_SUCCESS_EVIDENCE_UNAVAILABLE", runtime);
    }
    let candidates;
    try {
      candidates = completeGmailModelExtraction({
        modelPlan: context.modelPlan,
        modelResponse: cloneJson(outcome.normalizedResult, "normalizedResult"),
        model: string(outcome.actualModel, "actualModel", 200),
        observation: context.observation,
        workgroupContext: context.workgroupContext,
        acceptedClaims: context.acceptedClaims,
      });
    } catch (cause) {
      return scheduleLocalPending(job, context, "MODEL_SUCCEEDED_OUTPUT_INVALID", runtime);
    }
    if (!forcedReviewCandidates(candidates, context, outcome.actualModel)) {
      return scheduleLocalPending(job, context, "MODEL_OUTPUT_FORCED_REVIEW_INVALID", runtime);
    }
    await renew(job, runtime, `model result lease renewal ${job.jobId}`);
    assertRuntime(runtime, `model result write ${job.jobId}`);
    const modelResult = await planLedger.recordSuccessfulResult({
      ...fenced(job),
      modelPlanId: context.modelPlanId,
      modelRequestId: id,
      providerResponseId: string(outcome.providerResponseId, "providerResponseId", 500),
      candidates,
    });
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      processorVersion,
      jobKind: JOB_KIND,
      sourceObservationId: context.observation.observationId,
      modelPlanId: context.modelPlanId,
      executionMode: context.executionMode,
      outcome: "succeeded",
      modelRequestId: id,
      providerResponseId: outcome.providerResponseId,
      model: outcome.actualModel,
      promptVersion: context.modelPlan.promptVersion,
      candidateCount: candidates.length,
      candidateManifestHash: String(modelResult.candidateManifestHash || ""),
    };
    await renew(job, runtime, `model success completion lease renewal ${job.jobId}`);
    assertRuntime(runtime, `model success completion ${job.jobId}`);
    const completion = await jobLedger.completeJob({
      ...fenced(job),
      result,
      observations: [],
      childJobs: [],
    });
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      outcome: "succeeded",
      modelResult,
      completion,
      result,
    });
  }

  async function scheduleDurableRetry(job, context, requestReceipt, runtime = {}) {
    const id = requestId(requestReceipt);
    assertRuntime(runtime, `model durable retry acknowledgement ${job.jobId}`);
    const failureReceipt = await jobLedger.failJob({
      ...fenced(job),
      errorCode: "MODEL_PROVIDER_RETRY_RESERVED",
      safeErrorDetail: JSON.stringify(canonicalize({
        schemaVersion: "truth-model-retry-detail-v1",
        modelPlanId: context.modelPlanId,
        modelRequestId: id,
        requestState: "reserved",
      })),
      retryAfterSeconds,
    });
    return deepFreeze({
      ok: false,
      retryScheduled: true,
      jobId: job.jobId,
      outcome: "retry_reserved",
      modelRequestId: id,
      failureReceipt,
    });
  }

  async function scheduleLocalPending(job, context, reason, runtime = {}) {
    const errorCode = safeReason(reason, "MODEL_RUNTIME_CONFIGURATION_PENDING");
    assertRuntime(runtime, `model local pending acknowledgement ${job.jobId}`);
    const failureReceipt = await jobLedger.failJob({
      ...fenced(job),
      errorCode,
      safeErrorDetail: JSON.stringify(canonicalize({
        schemaVersion: "truth-model-local-pending-v1",
        modelPlanId: context.modelPlanId,
        sourceObservationId: context.observation.observationId,
        reasonCode: errorCode,
      })),
      retryAfterSeconds,
    });
    return deepFreeze({
      ok: false,
      retryScheduled: true,
      jobId: job.jobId,
      outcome: "local_configuration_pending",
      reasonCode: errorCode,
      failureReceipt,
    });
  }

  async function routeTerminalRequest(job, context, receipt, runtime = {}) {
    const request = requestFromReceipt(receipt);
    const state = requestState(receipt);
    const id = requestId(receipt);
    if (state === "succeeded") return finishSuccess(job, context, request, receipt, runtime);
    if (state === "review_required") {
      if (!REASON_RE.test(String(request.reviewReason || ""))) {
        throw recoveryStateError("review-required request lacks its exact durable reason");
      }
      return finishReview(job, context, request.reviewReason, {
        requestId: id,
        requestState: state,
        classification: receipt?.classification,
      }, runtime);
    }
    if (state === "outcome_unknown") {
      if (!REASON_RE.test(String(request.reviewReason || ""))) {
        throw recoveryStateError("outcome-unknown request lacks its exact durable reason");
      }
      return finishReview(job, context, request.reviewReason, {
        requestId: id,
        requestState: state,
        classification: receipt?.classification,
      }, runtime);
    }
    if (state === "reserved" && receipt?.classification) {
      return scheduleDurableRetry(job, context, request, runtime);
    }
    return null;
  }

  async function recoverInFlight(job, context, receipt, runtime = {}, recoveryOptions = {}) {
    let effectiveReceipt = receipt;
    let request = requestFromReceipt(effectiveReceipt);
    let id = requestId(effectiveReceipt);
    if (requestState(effectiveReceipt) !== "in_flight") {
      throw recoveryStateError("the durable request is not in flight");
    }
    if (recoveryOptions.forceRead === true
        || !MODEL_DISPATCH_RE.test(String(effectiveReceipt?.dispatchId || ""))) {
      if (recoveryOptions.ignoreRuntimeAbort !== true) {
        assertRuntime(runtime, `model in-flight dispatch read ${job.jobId}`);
      }
      const read = await modelRequestLedger.readRequest({ requestId: id });
      const terminal = await routeTerminalRequest(job, context, read, runtime);
      if (terminal) return terminal;
      if (requestState(read) === "reserved") {
        return scheduleDurableRetry(job, context, requestFromReceipt(read), runtime);
      }
      if (requestState(read) !== "in_flight") {
        throw recoveryStateError("the dispatch read returned a nonterminal state");
      }
      const unresolvedAttempt = latestUnreconciledAttempt(read);
      if (!unresolvedAttempt) {
        throw recoveryStateError("the in-flight request has no exact unreconciled dispatch");
      }
      request = requestFromReceipt(read);
      id = requestId(read);
      effectiveReceipt = { ...unresolvedAttempt, request };
    }
    const recoveryFields = {
      ...fenced(job),
      requestId: id,
      dispatchId: String(effectiveReceipt?.dispatchId || ""),
      recoveryKey: `model-dispatch-recovery:v1:${sha256Json({
        schemaVersion: "truth-model-dispatch-recovery-key-v1",
        jobId: job.jobId,
        modelPlanId: context.modelPlanId,
        requestId: id,
        dispatchId: String(effectiveReceipt?.dispatchId || ""),
      })}`,
      recoveryReason: DISPATCH_RECOVERY_REASON,
    };
    if (recoveryOptions.ignoreRuntimeAbort !== true) {
      assertRuntime(runtime, `model in-flight recovery ${job.jobId}`);
    }
    const recovered = validateRecoveryReceipt(
      await recoverUnknownAttempt(recoveryFields),
      {
        ...fenced(job),
        workspaceKey: context.workspaceKey,
        observationId: context.observation.observationId,
        observationContentHash: context.observation.contentHash,
        planHash: context.modelPlan.modelPlanHash,
        requestId: id,
        dispatchId: recoveryFields.dispatchId,
        attemptNumber: effectiveReceipt.attemptNumber,
        recoveryKey: recoveryFields.recoveryKey,
        dispatchedAt: effectiveReceipt.dispatchedAt,
        authorizationWorkerId: effectiveReceipt.authorizationWorkerId,
        authorizationLeaseFence: effectiveReceipt.authorizationLeaseFence,
        authorizationProcessorVersion: effectiveReceipt.authorizationProcessorVersion,
        authorizationLeaseExpiresAt: effectiveReceipt.authorizationLeaseExpiresAt,
      },
    );
    return finishReview(job, context, DISPATCH_RECOVERY_REVIEW_REASON, {
      requestId: id,
      requestState: "outcome_unknown",
      dispatchId: effectiveReceipt?.dispatchId,
      classification: DISPATCH_RECOVERY_REVIEW_REASON,
    }, runtime);
  }

  async function recoverAfterAuthorizedAttemptFailure(job, context, attempt, cause, runtime = {}) {
    try {
      return await recoverInFlight(job, context, attempt, runtime, {
        forceRead: true,
        ignoreRuntimeAbort: true,
      });
    } catch (recoveryError) {
      const uncertaintyCause = isAbortError(cause, runtime.signal) ? cause : recoveryError || cause;
      throw asOutcomeUnknownError(uncertaintyCause, {
        signal: runtime.signal,
        stage: `authorized model dispatch ${attempt.dispatchId}`,
        deadlineAtMs: runtime.deadlineAtMs,
        code: "TRUTH_MODEL_AUTHORIZED_DISPATCH_OUTCOME_UNKNOWN",
      });
    }
  }

  async function readRequestAfterDispatch(attempt, cause) {
    let read;
    try {
      // Do not consult the runtime deadline between provider return and the
      // immediate durable read/reconciliation path. The call may have spent
      // money; observing its ledger state outranks the response deadline.
      read = await modelRequestLedger.readRequest({ requestId: attempt.requestId });
    } catch (readCause) {
      throw new TruthModelExtractionWorkerError(
        "Provider attempt was sent but its durable reconciliation cannot be observed",
        {
          code: "TRUTH_MODEL_RECONCILIATION_OUTCOME_UNKNOWN",
          outcomeUnknown: true,
          postDispatch: true,
          cause: readCause || cause,
        },
      );
    }
    return read;
  }

  async function readAfterReconciliationFailure(
    job,
    context,
    attempt,
    providerResult,
    firstError,
    runtime = {},
  ) {
    let read = await readRequestAfterDispatch(attempt, firstError);
    const terminal = await routeTerminalRequest(job, context, read, runtime);
    if (terminal) return terminal;
    if (requestState(read) === "reserved") {
      return scheduleDurableRetry(job, context, requestFromReceipt(read), runtime);
    }
    if (requestState(read) === "in_flight") {
      // The first RPC may have failed before committing. The exact sealed
      // provider result is still in memory, so retry only that idempotent
      // reconciliation once. This never authorizes or performs another POST.
      let retried;
      try {
        retried = await modelRequestLedger.reconcileProviderAttempt({
          requestId: attempt.requestId,
          attemptNumber: attempt.attemptNumber,
          dispatchId: attempt.dispatchId,
          clientRequestId: attempt.clientRequestId,
          providerResult,
        });
      } catch (secondError) {
        read = await readRequestAfterDispatch(attempt, secondError);
        const recoveredTerminal = await routeTerminalRequest(job, context, read, runtime);
        if (recoveredTerminal) return recoveredTerminal;
        if (requestState(read) === "reserved") {
          return scheduleDurableRetry(job, context, requestFromReceipt(read), runtime);
        }
        return recoverInFlight(job, context, {
          ...attempt,
          request: requestFromReceipt(read),
        }, runtime);
      }
      const retriedTerminal = await routeTerminalRequest(job, context, retried, runtime);
      if (retriedTerminal) return retriedTerminal;
      if (requestState(retried) === "reserved") {
        return scheduleDurableRetry(job, context, requestFromReceipt(retried), runtime);
      }
      return recoverInFlight(job, context, retried, runtime);
    }
    return scheduleLocalPending(job, context, "MODEL_RECONCILIATION_STATE_INVALID", runtime);
  }

  async function processJob(rawJob, runtime = {}) {
    const job = normalizeJob(rawJob);
    assertRuntime(runtime, `model extraction job ${job.jobId}`);
    const context = normalizeContext(
      await planLedger.loadModelContext(fenced(job)),
      job,
    );
    assertRuntime(runtime, `model request source-job lookup ${job.jobId}`);
    const lookup = validateRequestLookup(
      await findRequestForSourceJob({
        sourceJobId: job.jobId,
        observationId: context.observation.observationId,
        observationContentHash: context.observation.contentHash,
        planHash: context.modelPlan.modelPlanHash,
        leaseFence: job.leaseFence,
      }),
      {
        workspaceKey: context.workspaceKey,
        sourceJobId: job.jobId,
        observationId: context.observation.observationId,
        observationContentHash: context.observation.contentHash,
        planHash: context.modelPlan.modelPlanHash,
      },
    );
    let request = lookup.found ? lookup.request : null;
    if (request) {
      const persistedTerminal = await routeTerminalRequest(job, context, request, runtime);
      if (persistedTerminal) return persistedTerminal;
      if (requestState(request) === "in_flight") {
        return recoverInFlight(job, context, request, runtime);
      }
    }

    // A local expected value is only a no-new-send assertion. Persisted paid
    // terminal or uncertain work is recovered first from the sealed context;
    // the assertion can never become an alternate request authority or hide a
    // durable provider outcome after a restart.
    if (expectedProcessingConfigVersion !== null && (
      context.processingConfigVersion !== expectedProcessingConfigVersion
      || context.processingConfigHash !== expectedProcessingConfigHash
    )) {
      throw new TruthModelExtractionWorkerError(
        "Sealed model context differs from the local processing-config assertion",
        {
          code: "TRUTH_MODEL_PROCESSING_CONFIG_ASSERTION_FAILED",
          retryable: false,
        },
      );
    }

    if (!runtimeEnabled) {
      return scheduleLocalPending(job, context, "MODEL_RUNTIME_DISABLED", runtime);
    }
    if (context.executionMode === "parked") {
      return finishReview(job, context, "MODEL_EXECUTION_PARKED", {}, runtime);
    }
    if (providerAdapter === null) {
      return scheduleLocalPending(job, context, "MODEL_PROVIDER_NOT_CONFIGURED", runtime);
    }

    let modelInput;
    let prepared;
    try {
      modelInput = materializeGmailModelInput({
        modelPlan: context.modelPlan,
        observation: context.observation,
        workgroupContext: context.workgroupContext,
        acceptedClaims: context.acceptedClaims,
      });
      assertRuntime(runtime, `model request preparation ${job.jobId}`);
      prepared = normalizePreparedRequest(providerAdapter.prepareRequest(modelInput, context), context);
    } catch (cause) {
      if (cause?.code === "GMAIL_CLAIM_INVALID_ARGUMENT"
        && cause?.field === "modelPlan"
        && cause?.message === STALE_TIME_BINDING_MESSAGE) {
        return finishStaleTimeBindingReview(job, context, runtime);
      }
      return scheduleLocalPending(job, context, "MODEL_REQUEST_CONFIGURATION_ERROR", runtime);
    }

    if (!request) {
      assertRuntime(runtime, `model request creation ${job.jobId}`);
      const logicalRequestHash = sha256Json({
        schemaVersion: "truth-model-logical-request-v1",
        modelPlanId: context.modelPlanId,
        executionMode: context.executionMode,
        requestedModel: prepared.requestedModel,
        promptVersion: prepared.promptVersion,
        responseSchemaVersion: prepared.responseSchemaVersion,
        processingConfigVersion: context.processingConfigVersion,
        processingConfigHash: context.processingConfigHash,
      });
      request = await modelRequestLedger.createRequest({
        logicalRequestKey: `gmail-model-request:v1:${logicalRequestHash}`,
        sourceJobId: job.jobId,
        observationId: context.observation.observationId,
        observationContentHash: context.observation.contentHash,
        planHash: context.modelPlan.modelPlanHash,
        requestBody: prepared.requestBody,
        requestBodyText: prepared.requestBodyText,
        requestBodyHash: prepared.requestBodyHash,
        requestBodyBytes: prepared.requestBodyBytes,
        modelSnapshot: prepared.requestedModel,
        promptVersion: prepared.promptVersion,
        responseSchemaVersion: prepared.responseSchemaVersion,
        responseSchemaHash,
        processingConfigVersion: context.processingConfigVersion,
        processingConfigHash: context.processingConfigHash,
        transport: context.executionMode === "batch" ? "batch" : "sync",
        maxOutputTokens: prepared.maxOutputTokens,
        leaseFence: job.leaseFence,
      });
    }
    let terminal = await routeTerminalRequest(job, context, request, runtime);
    if (terminal) return terminal;
    if (requestState(request) === "in_flight") {
      return recoverInFlight(job, context, request, runtime);
    }
    if (requestState(request) === "planned") {
      assertRuntime(runtime, `model budget reservation ${job.jobId}`);
      request = await modelRequestLedger.reserveRequest({
        requestId: requestId(request),
        leaseFence: job.leaseFence,
      });
      terminal = await routeTerminalRequest(job, context, request, runtime);
      if (terminal) return terminal;
    }

    if (context.executionMode === "batch") {
      return scheduleLocalPending(job, context, "MODEL_BATCH_REQUEST_PENDING", runtime);
    }
    if (requestState(request) === "in_flight") {
      return recoverInFlight(job, context, request, runtime);
    }
    if (requestState(request) !== "reserved") {
      return scheduleLocalPending(job, context, "MODEL_REQUEST_STATE_INVALID", runtime);
    }

    await renew(job, runtime, `model dispatch lease renewal ${job.jobId}`);
    assertRuntime(runtime, `model dispatch authorization ${job.jobId}`);
    const attempt = await modelRequestLedger.beginSyncAttempt({
      requestId: requestId(request),
      leaseFence: job.leaseFence,
    });
    terminal = await routeTerminalRequest(job, context, attempt, runtime);
    if (terminal) return terminal;
    if (attempt?.sendAuthorized !== true) {
      return recoverInFlight(job, context, attempt, runtime);
    }
    if (!MODEL_DISPATCH_RE.test(String(attempt.dispatchId || ""))
        || !MODEL_REQUEST_RE.test(String(attempt.requestId || ""))
        || !Number.isSafeInteger(attempt.attemptNumber)
        || typeof attempt.clientRequestId !== "string" || !attempt.clientRequestId) {
      throw new TruthModelExtractionWorkerError("Model ledger returned an invalid send authorization", {
        code: "TRUTH_MODEL_SEND_AUTHORIZATION_INVALID",
      });
    }

    // A processJob invocation owns exactly one leased dispatch opportunity.
    // The adapter's durable method itself also consumes the dispatch receipt
    // before its first await. No compatibility extract()/executeAttempt() path
    // is reachable from this worker.
    let providerResult;
    try {
      providerResult = await providerAdapter.executeAuthorizedAttempt(attempt, modelInput, {
        ...context,
        signal: runtime.signal || null,
        deadlineAtMs: runtime.deadlineAtMs || null,
      });
    } catch (cause) {
      return recoverAfterAuthorizedAttemptFailure(job, context, attempt, cause, runtime);
    }

    let reconciled;
    try {
      // Immediate reconciliation intentionally has no abort/deadline gate.
      reconciled = await modelRequestLedger.reconcileProviderAttempt({
        requestId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        dispatchId: attempt.dispatchId,
        clientRequestId: attempt.clientRequestId,
        providerResult,
      });
    } catch (reconciliationError) {
      return readAfterReconciliationFailure(
        job,
        context,
        attempt,
        providerResult,
        reconciliationError,
        runtime,
      );
    }
    terminal = await routeTerminalRequest(job, context, reconciled, runtime);
    if (terminal) return terminal;
    if (requestState(reconciled) === "reserved") {
      return scheduleDurableRetry(job, context, requestFromReceipt(reconciled), runtime);
    }
    if (requestState(reconciled) === "in_flight") {
      return recoverInFlight(job, context, reconciled, runtime);
    }
    return scheduleLocalPending(job, context, "MODEL_RECONCILIATION_STATE_INVALID", runtime);
  }

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("runOnce", "must be an object");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) {
      throw invalidArgument("signal", "must be an AbortSignal or null");
    }
    const limit = integer(input.limit ?? 10, "limit", { minimum: 1, maximum: 50 });
    throwIfAborted(signal, {
      stage: "model extraction worker claim",
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
      throw new TruthModelExtractionWorkerError(
        "Source-processing ledger returned an invalid model-job claim receipt",
        { code: "TRUTH_MODEL_EXTRACTION_JOB_CLAIM_INVALID" },
      );
    }
    const jobs = [];
    for (const rawJob of claim.jobs) {
      try {
        jobs.push(await processJob(rawJob, { signal, deadlineAtMs: input.deadlineAtMs }));
      } catch (error) {
        if (error?.outcomeUnknown === true || error?.postDispatch === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `model extraction job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `model extraction job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        const job = isPlainObject(rawJob) ? rawJob : {};
        let failureReceipt = null;
        let failureAcknowledgementError = null;
        try {
          throwIfAborted(signal, {
            stage: `model extraction failure acknowledgement ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
          failureReceipt = await jobLedger.failJob({
            ...fenced(job),
            errorCode: safeErrorCode(error),
            safeErrorDetail: JSON.stringify(canonicalize({
              schemaVersion: "truth-model-worker-failure-v1",
              errorCode: safeErrorCode(error),
              jobKind: String(job.jobKind || ""),
            })),
            retryAfterSeconds,
          });
        } catch (acknowledgementError) {
          if (acknowledgementError?.outcomeUnknown === true
              || isAbortError(acknowledgementError, signal)) {
            throw asOutcomeUnknownError(acknowledgementError, {
              signal,
              stage: `model extraction failure acknowledgement ${rawJob?.jobId || "unknown"}`,
              deadlineAtMs: input.deadlineAtMs,
            });
          }
          failureAcknowledgementError = { code: safeErrorCode(acknowledgementError) };
        }
        jobs.push(deepFreeze({
          ok: false,
          jobId: String(job.jobId || ""),
          errorCode: safeErrorCode(error),
          failureReceipt,
          failureAcknowledgementError,
        }));
      }
    }
    const succeededCount = jobs.filter((job) => job.ok).length;
    const reviewCount = jobs.filter((job) => job.outcome === "review_required").length;
    const modelSuccessCount = jobs.filter((job) => job.outcome === "succeeded").length;
    const retryScheduledCount = jobs.filter((job) => job.retryScheduled === true).length;
    return deepFreeze({
      ok: jobs.every((job) => job.ok),
      claimedCount: claim.jobs.length,
      succeededCount,
      failedCount: jobs.length - succeededCount,
      modelSuccessCount,
      reviewCount,
      retryScheduledCount,
      jobs,
    });
  }

  return Object.freeze({
    jobKind: JOB_KIND,
    workerId,
    processorVersion,
    processingConfigAuthority: "sealed_model_context",
    expectedProcessingConfigVersion,
    expectedProcessingConfigHash,
    responseSchemaHash,
    processJob,
    runOnce,
  });
}

module.exports = Object.freeze({
  JOB_KIND,
  RESULT_SCHEMA_VERSION,
  TruthModelExtractionWorkerError,
  createTruthModelExtractionWorker,
  _test: Object.freeze({
    forcedReviewCandidates,
    latestSuccessfulAttempt,
    latestUnreconciledAttempt,
    normalizePreparedRequest,
    requestFromReceipt,
    requestState,
    reviewReason: safeReason,
    sha256Json,
    sha256Jsonb,
    validateRequestLookup,
    validateRecoveryReceipt,
  }),
});

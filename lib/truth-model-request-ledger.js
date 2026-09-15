"use strict";

const crypto = require("node:crypto");
const { postgresJsonbText } = require("./postgres-jsonb");
const {
  CLASSIFICATIONS: PROVIDER_CLASSIFICATIONS,
  RESULT_SCHEMA_VERSION: PROVIDER_RESULT_SCHEMA_VERSION,
  validateAttemptResult,
  validateModelResponseEnvelope,
} = require("./openai-gmail-model-extractor");

const HASH_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^model-request:v1:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RPC = Object.freeze({
  configureAccount: "configure_truth_model_account",
  createRequest: "create_truth_model_request",
  reserveRequest: "reserve_truth_model_request",
  beginSyncAttempt: "begin_truth_model_sync_attempt",
  reconcileSyncAttempt: "reconcile_truth_model_sync_attempt",
  recoverUnknownAttempt: "quarantine_truth_model_sync_dispatch",
  findRequestForSourceJob: "find_truth_model_request_for_source_job",
  readRecoveryStatus: "read_truth_model_dispatch_recovery_status",
  readRequest: "read_truth_model_request",
});

const DISPATCH_RECOVERY_REASON = "STALE_DISPATCH_UNRECONCILED_AFTER_LEASE_REPLACEMENT";
const DISPATCH_RECOVERY_REVIEW_REASON = "MODEL_DISPATCH_OUTCOME_UNKNOWN_QUARANTINED";
const RECOVERY_RECEIPT_KEYS = Object.freeze([
  "attemptNumber", "authorizationLeaseExpiresAt", "authorizationLeaseFence",
  "authorizationProcessorVersion", "authorizationWorkerId", "dispatchAuthorizedAt",
  "dispatchId", "externalEffectState", "heldReservedInputTokens",
  "heldReservedMicroUsd", "heldReservedOutputTokens", "idempotent", "ok",
  "quarantined", "recoveredAt", "recoveringLeaseFence",
  "recoveringProcessorVersion", "recoveringWorkerId", "recoveryHash", "recoveryId",
  "recoveryKey", "recoveryReason", "request", "requestId", "reservationDisposition",
  "reviewDisposition", "reviewReason", "schemaVersion", "sendAuthorized",
  "sourceJobId", "workspaceKey",
].sort());

const PRICING_VERSION = "openai-public-pricing-2026-07-09";
const PROVIDER_CLASSIFICATION_SET = new Set(Object.values(PROVIDER_CLASSIFICATIONS));
const DB_NATIVE_PROVIDER_CLASSIFICATIONS = Object.freeze({
  [PROVIDER_CLASSIFICATIONS.REFUSAL]: "refusal",
  [PROVIDER_CLASSIFICATIONS.INCOMPLETE]: "incomplete",
  [PROVIDER_CLASSIFICATIONS.CONTENT_FILTER]: "content_filter",
  [PROVIDER_CLASSIFICATIONS.MALFORMED_OUTPUT]: "malformed_output",
});
const DB_ATTEMPT_CLASSIFICATIONS = new Set([
  "success", "pre_send_failure", "rate_limited", "rate_limited_usage_known",
  "server_error_usage_known", "insufficient_quota", "refusal", "content_filter",
  "incomplete", "malformed_output", "configuration_error", "model_mismatch",
  "outcome_unknown", "billing_unknown",
]);
const DB_RETRYABLE_CLASSIFICATIONS = new Set([
  "pre_send_failure", "rate_limited", "rate_limited_usage_known",
  "server_error_usage_known",
]);
const DB_UNKNOWN_CLASSIFICATIONS = new Set([
  "outcome_unknown", "billing_unknown", "model_mismatch",
]);
const PROVABLY_NONBILLABLE_HTTP = new Set([400, 401, 403, 404, 409, 422]);
const PRICING_SOURCE = Object.freeze({
  "gpt-5-nano-2025-08-07": Object.freeze({
    sync: Object.freeze([50000, 5000, 400000]),
    batch: Object.freeze([25000, 2500, 200000]),
  }),
  "gpt-5.4-mini-2026-03-17": Object.freeze({
    sync: Object.freeze([750000, 75000, 4500000]),
    batch: Object.freeze([375000, 37500, 2250000]),
  }),
});

class TruthModelRequestLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthModelRequestLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthModelRequestLedgerError(`Invalid truth model ledger ${field}: ${reason}`, {
    code: "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, maximumBytes = 4096) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw invalid(field, "is too long");
  return value;
}

function hash(value, field) {
  const normalized = text(value, field, 64);
  if (!HASH_RE.test(normalized)) throw invalid(field, "must be lowercase SHA-256 hex");
  return normalized;
}

function uuid(value, field) {
  const normalized = text(value, field, 100);
  if (!UUID_RE.test(normalized)) throw invalid(field, "must be a canonical lowercase UUID");
  return normalized;
}

function optionalText(value, field, maximumBytes = 4096) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim() !== value) {
    throw invalid(field, "must be an empty string or a trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw invalid(field, "is too long");
  return value;
}

function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function cloneJson(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, cloneJson(item, `${field}.${key}`)]));
  }
  throw invalid(field, "must contain JSON-compatible data only");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sha256Jsonb(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(value), "utf8").digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizedProviderUsage(value) {
  if (value === null || value === undefined) {
    return Object.freeze({
      known: false,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });
  }
  if (!isPlainObject(value)) throw invalid("providerResult.usage", "must be an object or null");
  const usage = {
    known: true,
    inputTokens: integer(value.inputTokens, "providerResult.usage.inputTokens"),
    cachedInputTokens: integer(value.cachedInputTokens, "providerResult.usage.cachedInputTokens"),
    outputTokens: integer(value.outputTokens, "providerResult.usage.outputTokens"),
    reasoningTokens: integer(value.reasoningTokens, "providerResult.usage.reasoningTokens"),
    totalTokens: integer(value.totalTokens, "providerResult.usage.totalTokens"),
  };
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningTokens > usage.outputTokens ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw invalid("providerResult.usage", "has an inconsistent token shape");
  }
  return Object.freeze(usage);
}

function mapProviderResultToReconciliation(providerResult, expectedAttemptNumber) {
  try {
    providerResult = validateAttemptResult(providerResult);
  } catch (cause) {
    throw new TruthModelRequestLedgerError("Invalid sealed provider attempt result", {
      code: "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT",
      field: "providerResult",
      cause,
    });
  }
  if (!isPlainObject(providerResult) || providerResult.schemaVersion !== PROVIDER_RESULT_SCHEMA_VERSION ||
      !Array.isArray(providerResult.attempts) || providerResult.attempts.length !== 1) {
    throw invalid("providerResult", "must be one sealed OpenAI extractor attempt result");
  }
  const attempt = providerResult.attempts[0];
  if (!isPlainObject(attempt)) throw invalid("providerResult.attempts[0]", "must be an object");
  const providerClassification = text(attempt.classification, "providerResult.classification", 100);
  if (!PROVIDER_CLASSIFICATION_SET.has(providerClassification) ||
      providerResult.classification !== providerClassification) {
    throw invalid("providerResult.classification", "is unknown or differs from its attempt receipt");
  }
  const attemptNumber = integer(attempt.attemptNo, "providerResult.attemptNo", 1, 3);
  if (expectedAttemptNumber !== undefined &&
      integer(expectedAttemptNumber, "attemptNumber", 1, 3) !== attemptNumber) {
    throw invalid("attemptNumber", "does not match the provider attempt receipt");
  }
  const clientRequestId = text(attempt.clientRequestId, "providerResult.clientRequestId", 500);
  if (!/^[\x21-\x7e]+$/.test(clientRequestId)) {
    throw invalid("providerResult.clientRequestId", "must contain visible ASCII only");
  }
  if (typeof attempt.requestSent !== "boolean" || typeof attempt.outcomeUnknown !== "boolean" ||
      typeof attempt.billingOutcomeUnknown !== "boolean") {
    throw invalid("providerResult", "must carry explicit send and unknown-outcome flags");
  }
  const httpStatus = attempt.httpStatus === undefined || attempt.httpStatus === null
    ? null : integer(attempt.httpStatus, "providerResult.httpStatus", 100, 599);
  const requestBodyHash = hash(attempt.requestBodyHash, "providerResult.requestBodyHash");
  const requestBodyBytes = integer(
    attempt.requestBodyBytes, "providerResult.requestBodyBytes", 1, 1048576,
  );
  const providerResponseBodyHash = optionalText(
    attempt.providerResponseBodyHash, "providerResult.providerResponseBodyHash", 64,
  );
  const providerResponseBodyBytes = integer(
    attempt.providerResponseBodyBytes ?? 0,
    "providerResult.providerResponseBodyBytes",
    0,
    2097152,
  );
  if ((providerResponseBodyHash === "") !== (providerResponseBodyBytes === 0) ||
      (providerResponseBodyHash !== "" && !HASH_RE.test(providerResponseBodyHash))) {
    throw invalid("providerResult.providerResponseBodyHash", "does not match its byte receipt");
  }
  const usage = normalizedProviderUsage(attempt.usage);
  const hasUsage = usage.known && usage.totalTokens > 0;
  const responseEvidence = httpStatus !== null || providerResponseBodyHash !== "";
  const unknownClassification = responseEvidence ? "billing_unknown" : "outcome_unknown";
  const providerErrorCode = optionalText(
    attempt.providerErrorCode, "providerResult.providerErrorCode", 500,
  );
  let classification;
  let normalizedResult = null;

  if (attempt.billingOutcomeUnknown || attempt.outcomeUnknown) {
    if (hasUsage) throw invalid("providerResult", "cannot be usage-known and outcome-unknown");
    classification = unknownClassification;
  } else if (providerClassification === PROVIDER_CLASSIFICATIONS.SUCCEEDED) {
    if (!attempt.requestSent || !hasUsage || !isPlainObject(providerResult.modelResponse)) {
      throw invalid("providerResult", "successful extraction lacks sent, usage, or model result evidence");
    }
    classification = "success";
    try {
      normalizedResult = validateModelResponseEnvelope(providerResult.modelResponse);
    } catch (cause) {
      throw new TruthModelRequestLedgerError("Invalid providerResult.modelResponse", {
        code: "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT",
        field: "providerResult.modelResponse",
        cause,
      });
    }
  } else if (providerClassification === PROVIDER_CLASSIFICATIONS.RATE_LIMIT_EXCEEDED) {
    classification = hasUsage ? "rate_limited_usage_known" : "rate_limited";
  } else if (providerClassification === PROVIDER_CLASSIFICATIONS.INSUFFICIENT_QUOTA) {
    if (hasUsage) throw invalid("providerResult", "quota failure cannot discard reported usage");
    classification = "insufficient_quota";
  } else if (providerClassification === PROVIDER_CLASSIFICATIONS.SERVER_ERROR) {
    classification = hasUsage ? "server_error_usage_known" : unknownClassification;
  } else if (providerClassification === PROVIDER_CLASSIFICATIONS.CONFIGURATION_ERROR) {
    if (providerErrorCode === "actual_model_mismatch") {
      if (!hasUsage) throw invalid("providerResult", "model mismatch lacks trustworthy usage");
      classification = "model_mismatch";
    } else if (!attempt.requestSent ||
        (PROVABLY_NONBILLABLE_HTTP.has(httpStatus) && !hasUsage)) {
      if (hasUsage) throw invalid("providerResult", "configuration failure cannot discard reported usage");
      classification = "configuration_error";
    } else if (!hasUsage) {
      classification = unknownClassification;
    } else {
      throw invalid("providerResult", "configuration failure has unclassified reported usage");
    }
  } else if (DB_NATIVE_PROVIDER_CLASSIFICATIONS[providerClassification]) {
    if (hasUsage) {
      classification = DB_NATIVE_PROVIDER_CLASSIFICATIONS[providerClassification];
    } else if (providerClassification === PROVIDER_CLASSIFICATIONS.CONTENT_FILTER &&
        new Set([400, 403]).has(httpStatus) && providerResponseBodyHash && providerErrorCode) {
      classification = "content_filter";
    } else {
      classification = unknownClassification;
    }
  } else if (providerClassification === PROVIDER_CLASSIFICATIONS.OUTCOME_UNKNOWN) {
    if (hasUsage) throw invalid("providerResult", "unknown outcome cannot carry reported usage");
    classification = unknownClassification;
  } else {
    throw invalid("providerResult.classification", "has no exhaustive database mapping");
  }

  return Object.freeze({
    dispatchId: providerResult.dispatchId,
    requestId: providerResult.requestId,
    providerResultHash: providerResult.normalizedResultHash,
    attemptNumber,
    clientRequestId,
    classification,
    requestSent: attempt.requestSent,
    httpStatus,
    requestBodyHash,
    requestBodyBytes,
    providerResponseBodyHash,
    providerResponseBodyBytes,
    providerErrorCode: new Set(["rate_limited", "rate_limited_usage_known"]).has(classification) &&
        !providerErrorCode
      ? "http_429" : providerErrorCode,
    incompleteReason: optionalText(
      attempt.incompleteReason, "providerResult.incompleteReason", 1000,
    ),
    providerResponseId: optionalText(
      attempt.providerResponseId, "providerResult.providerResponseId", 500,
    ),
    serverRequestId: optionalText(
      attempt.serverRequestId, "providerResult.serverRequestId", 500,
    ),
    actualModel: optionalText(attempt.actualModel, "providerResult.actualModel", 200),
    normalizedResult,
    usage,
  });
}

function pricingPolicy(modelSnapshot, transport) {
  const model = text(modelSnapshot, "modelSnapshot", 200);
  const mode = text(transport, "transport", 20);
  const rates = PRICING_SOURCE[model]?.[mode];
  if (!rates) throw invalid("pricingPolicy", "model snapshot and transport are not pinned");
  const [inputRate, cachedRate, outputRate] = rates;
  const policy = {
    schemaVersion: "truth-model-pricing-policy-v1",
    modelSnapshot: model,
    transport: mode,
    inputMicroUsdPerMillion: inputRate,
    cachedInputMicroUsdPerMillion: cachedRate,
    outputMicroUsdPerMillion: outputRate,
    pricingVersion: PRICING_VERSION,
  };
  const policyHash = sha256Jsonb(policy);
  return deepFreeze({
    ...policy,
    policyHash,
    pricingPolicyId: `model-pricing:v1:${policyHash}`,
  });
}

function receiptError(operation, detail = "") {
  return new TruthModelRequestLedgerError(
    `Invalid ${operation} receipt${detail ? `: ${detail}` : ""}`,
    { code: "TRUTH_MODEL_LEDGER_INVALID_RECEIPT", operation },
  );
}

function validateRequestReceipt(value, operation) {
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(String(value?.requestPayloadText || ""));
  } catch {
    parsedPayload = null;
  }
  const state = String(value?.state || "");
  const numericFields = [
    "requestPayloadBytes", "maxInputTokens", "maxOutputTokens", "maxAttempts",
    "initialReservedInputTokens", "initialReservedOutputTokens",
    "remainingReservedInputTokens", "remainingReservedOutputTokens",
    "initialReservedMicroUsd", "remainingReservedMicroUsd", "actualInputTokens",
    "actualCachedInputTokens", "actualOutputTokens", "actualReasoningTokens",
    "actualTotalTokens", "actualMicroUsd", "attemptCount",
  ];
  if (!isPlainObject(value) || typeof value.ok !== "boolean" || typeof value.idempotent !== "boolean" ||
      !REQUEST_ID_RE.test(String(value.requestId || "")) ||
      !["planned", "reserved", "in_flight", "succeeded", "review_required", "outcome_unknown"].includes(state) ||
      typeof value.workspaceKey !== "string" || !value.workspaceKey ||
      typeof value.logicalRequestKey !== "string" || !value.logicalRequestKey ||
      !HASH_RE.test(String(value.requestHash || "")) ||
      !/^[0-9a-f-]{36}$/.test(String(value.sourceJobId || "")) ||
      !/^obs:v1:[0-9a-f]{64}$/.test(String(value.observationId || "")) ||
      !HASH_RE.test(String(value.observationContentHash || "")) ||
      !HASH_RE.test(String(value.planHash || "")) ||
      typeof value.modelSnapshot !== "string" || !value.modelSnapshot ||
      typeof value.promptVersion !== "string" || !value.promptVersion ||
      typeof value.responseSchemaVersion !== "string" || !value.responseSchemaVersion ||
      !HASH_RE.test(String(value.responseSchemaHash || "")) ||
      typeof value.processingConfigVersion !== "string" || !value.processingConfigVersion ||
      !HASH_RE.test(String(value.processingConfigHash || "")) ||
      !/^model-pricing:v1:[0-9a-f]{64}$/.test(String(value.pricingPolicyId || "")) ||
      !HASH_RE.test(String(value.pricingPolicyHash || "")) ||
      !["sync", "batch"].includes(value.transport) ||
      numericFields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0) ||
      !Number.isSafeInteger(value.maxInputTokens) || value.maxInputTokens < 1 ||
      !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 ||
      value.maxInputTokens + value.maxOutputTokens > 400000 ||
      ![1, 3].includes(value.maxAttempts) || !isPlainObject(value.requestPayload) ||
      typeof value.requestPayloadText !== "string" ||
      Buffer.byteLength(value.requestPayloadText, "utf8") !== value.requestPayloadBytes ||
      sha256Text(value.requestPayloadText) !== value.requestPayloadHash ||
      !isPlainObject(parsedPayload) || sha256Jsonb(parsedPayload) !== sha256Jsonb(value.requestPayload) ||
      !HASH_RE.test(String(value.requestPayloadHash || "")) ||
      value.requestPayloadBytes !== value.maxInputTokens ||
      value.attemptCount > value.maxAttempts ||
      value.actualCachedInputTokens > value.actualInputTokens ||
      value.actualReasoningTokens > value.actualOutputTokens ||
      value.actualTotalTokens !== value.actualInputTokens + value.actualOutputTokens ||
      value.remainingReservedInputTokens > value.initialReservedInputTokens ||
      value.remainingReservedOutputTokens > value.initialReservedOutputTokens ||
      value.remainingReservedMicroUsd > value.initialReservedMicroUsd ||
      typeof value.reviewReason !== "string" || value.mutatesOperationalState !== false ||
      value.ok !== !new Set(["review_required", "outcome_unknown"]).has(state) ||
      (value.transport === "sync" ? value.maxAttempts !== 3 : value.maxAttempts !== 1)) {
    throw receiptError(operation, "request shape or counters are inconsistent");
  }
  const payload = value.requestPayload;
  if (payload.model !== value.modelSnapshot || payload.store !== false ||
      payload.stream === true || payload.max_output_tokens !== value.maxOutputTokens ||
      payload?.metadata?.model_plan_hash !== value.planHash ||
      payload?.metadata?.source_observation_id !== value.observationId ||
      payload?.metadata?.source_content_hash !== value.observationContentHash ||
      payload?.metadata?.prompt_version !== value.promptVersion ||
      payload?.text?.format?.type !== "json_schema" ||
      payload?.text?.format?.strict !== true || !isPlainObject(payload?.text?.format?.schema) ||
      sha256Jsonb(payload.text.format.schema) !== value.responseSchemaHash) {
    throw receiptError(operation, "sealed request payload differs from its authority fields");
  }
  let policy;
  try {
    policy = pricingPolicy(value.modelSnapshot, value.transport);
  } catch {
    throw receiptError(operation, "pricing policy is not pinned");
  }
  if (value.pricingPolicyId !== policy.pricingPolicyId ||
      value.pricingPolicyHash !== policy.policyHash) {
    throw receiptError(operation, "pricing policy identity differs from the pinned policy");
  }
  const expectedRequestHash = sha256Jsonb({
    schemaVersion: "truth-model-logical-request-v1",
    workspaceKey: value.workspaceKey,
    logicalRequestKey: value.logicalRequestKey,
    sourceJobId: value.sourceJobId,
    observationId: value.observationId,
    observationContentHash: value.observationContentHash,
    planHash: value.planHash,
    requestPayloadHash: value.requestPayloadHash,
    requestPayloadBytes: value.requestPayloadBytes,
    modelSnapshot: value.modelSnapshot,
    promptVersion: value.promptVersion,
    responseSchemaVersion: value.responseSchemaVersion,
    responseSchemaHash: value.responseSchemaHash,
    processingConfigVersion: value.processingConfigVersion,
    processingConfigHash: value.processingConfigHash,
    pricingPolicyId: value.pricingPolicyId,
    pricingPolicyHash: value.pricingPolicyHash,
    transport: value.transport,
    maxInputTokens: value.maxInputTokens,
    maxOutputTokens: value.maxOutputTokens,
    maxAttempts: value.maxAttempts,
  });
  if (value.requestHash !== expectedRequestHash ||
      value.requestId !== `model-request:v1:${expectedRequestHash}`) {
    throw receiptError(operation, "request identity hash is invalid");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateAttemptReceipt(value, operation) {
  if (!isPlainObject(value) || value.ok !== true || typeof value.idempotent !== "boolean" ||
      typeof value.sendAuthorized !== "boolean" || !/^model-dispatch:v1:[0-9a-f]{64}$/.test(String(value.dispatchId || "")) ||
      !REQUEST_ID_RE.test(String(value.requestId || "")) ||
      !Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1 || value.attemptNumber > 3 ||
      !/^model-client:v1:[0-9a-f]{64}$/.test(String(value.clientRequestId || "")) ||
      !isPlainObject(value.request)) {
    throw new TruthModelRequestLedgerError(`Invalid ${operation} attempt receipt`, {
      code: "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  validateRequestReceipt(value.request, operation);
  if (value.sendAuthorized && value.idempotent) {
    throw new TruthModelRequestLedgerError(`${operation} replay cannot authorize a send`, {
      code: "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validatePersistedAttemptReceipt(value, request, index, operation) {
  const attemptNumber = index + 1;
  if (!isPlainObject(value) || value.ok !== true || value.idempotent !== true ||
      value.sendAuthorized !== false || value.requestId !== request.requestId ||
      value.workspaceKey !== request.workspaceKey || value.attemptNumber !== attemptNumber ||
      !/^model-client:v1:[0-9a-f]{64}$/.test(String(value.clientRequestId || "")) ||
      !/^model-dispatch:v1:[0-9a-f]{64}$/.test(String(value.dispatchId || "")) ||
      !HASH_RE.test(String(value.dispatchHash || "")) ||
      typeof value.dispatchedAt !== "string" || !value.dispatchedAt ||
      typeof value.quarantined !== "boolean") {
    throw receiptError(operation, `attempt ${attemptNumber} dispatch shape is invalid`);
  }
  const expectedClientRequestId = `model-client:v1:${sha256Text(
    `${request.requestId}:${attemptNumber}`,
  )}`;
  const expectedDispatchHash = sha256Jsonb({
    schemaVersion: "truth-model-sync-dispatch-v1",
    workspaceKey: request.workspaceKey,
    requestId: request.requestId,
    attemptNumber,
    clientRequestId: expectedClientRequestId,
  });
  if (value.clientRequestId !== expectedClientRequestId ||
      value.dispatchHash !== expectedDispatchHash ||
      value.dispatchId !== `model-dispatch:v1:${expectedDispatchHash}`) {
    throw receiptError(operation, `attempt ${attemptNumber} dispatch identity hash is invalid`);
  }
  const authorizationFields = [
    value.authorizationWorkerId,
    value.authorizationLeaseFence,
    value.authorizationProcessorVersion,
    value.authorizationLeaseExpiresAt,
  ];
  const hasAuthorization = authorizationFields.some((item) => item !== undefined);
  if (hasAuthorization && (
    typeof value.authorizationWorkerId !== "string" || !value.authorizationWorkerId ||
    !Number.isSafeInteger(value.authorizationLeaseFence) || value.authorizationLeaseFence < 1 ||
    typeof value.authorizationProcessorVersion !== "string" ||
      !value.authorizationProcessorVersion ||
    typeof value.authorizationLeaseExpiresAt !== "string" || !value.authorizationLeaseExpiresAt
  )) {
    throw receiptError(operation, `attempt ${attemptNumber} authorization fence is incomplete`);
  }

  const hasOutcome = value.classification !== undefined;
  if (value.quarantined && hasOutcome) {
    throw receiptError(operation, `attempt ${attemptNumber} cannot be both recovered and reconciled`);
  }
  const providerFactFields = [
    "outcomeHash", "classification", "providerResultHash", "requestSent", "httpStatus",
    "requestBodyHash", "requestBodyBytes", "providerResponseBodyHash",
    "providerResponseBodyBytes", "providerErrorCode", "incompleteReason",
    "outcomeUnknown", "billingOutcomeUnknown", "providerResponseId", "serverRequestId",
    "actualModel", "normalizedResult", "normalizedResultHash", "inputTokens",
    "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "actualMicroUsd",
  ];
  if (value.quarantined) {
    let recovery;
    try {
      recovery = validateRecoveryReceipt(value.recovery, operation, {
        workspaceKey: request.workspaceKey,
        requestId: request.requestId,
        dispatchId: value.dispatchId,
        sourceJobId: request.sourceJobId,
        attemptNumber,
        recoveryReason: DISPATCH_RECOVERY_REASON,
        authorizationWorkerId: value.authorizationWorkerId ?? null,
        authorizationLeaseFence: value.authorizationLeaseFence ?? null,
        authorizationProcessorVersion: value.authorizationProcessorVersion ?? null,
        authorizationLeaseExpiresAt: value.authorizationLeaseExpiresAt ?? null,
        dispatchAuthorizedAt: value.dispatchedAt,
      });
    } catch {
      throw receiptError(operation, `attempt ${attemptNumber} recovery authority is invalid`);
    }
    if (providerFactFields.some((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
        !/^model-dispatch-recovery:v1:[0-9a-f]{64}$/.test(String(value.recoveryId || "")) ||
        typeof value.recoveryKey !== "string" || !value.recoveryKey ||
        !HASH_RE.test(String(value.recoveryHash || "")) ||
        value.recoveryId !== `model-dispatch-recovery:v1:${value.recoveryHash}` ||
        value.recoveryReason !== DISPATCH_RECOVERY_REASON ||
        value.externalEffectState !== "unknown_possible_post" ||
        value.reservationDisposition !== "held_conservatively" ||
        value.reviewDisposition !== "non_resolvable_external_effect_uncertainty" ||
        !Number.isSafeInteger(value.heldReservedInputTokens) ||
          value.heldReservedInputTokens < 0 ||
        !Number.isSafeInteger(value.heldReservedOutputTokens) ||
          value.heldReservedOutputTokens < 0 ||
        !Number.isSafeInteger(value.heldReservedMicroUsd) || value.heldReservedMicroUsd <= 0 ||
        value.heldReservedInputTokens !== request.remainingReservedInputTokens ||
        value.heldReservedOutputTokens !== request.remainingReservedOutputTokens ||
        value.heldReservedMicroUsd !== request.remainingReservedMicroUsd ||
        typeof value.recoveredAt !== "string" || !value.recoveredAt ||
        recovery.recoveryId !== value.recoveryId ||
        recovery.recoveryKey !== value.recoveryKey ||
        recovery.recoveryHash !== value.recoveryHash ||
        recovery.recoveryReason !== value.recoveryReason ||
        recovery.externalEffectState !== value.externalEffectState ||
        recovery.reservationDisposition !== value.reservationDisposition ||
        recovery.reviewDisposition !== value.reviewDisposition ||
        recovery.heldReservedInputTokens !== value.heldReservedInputTokens ||
        recovery.heldReservedOutputTokens !== value.heldReservedOutputTokens ||
        recovery.heldReservedMicroUsd !== value.heldReservedMicroUsd ||
        recovery.recoveredAt !== value.recoveredAt) {
      throw receiptError(operation, `attempt ${attemptNumber} recovery receipt is invalid`);
    }
    return Object.freeze({ kind: "recovery", classification: "" });
  }
  if (Object.prototype.hasOwnProperty.call(value, "recovery")) {
    throw receiptError(operation, `attempt ${attemptNumber} carries a recovery without quarantine`);
  }
  if (!hasOutcome) {
    if (providerFactFields.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
      throw receiptError(operation, `attempt ${attemptNumber} pending dispatch carries provider facts`);
    }
    return Object.freeze({ kind: "pending", classification: "" });
  }
  if (!DB_ATTEMPT_CLASSIFICATIONS.has(value.classification) ||
      !HASH_RE.test(String(value.outcomeHash || "")) ||
      !HASH_RE.test(String(value.providerResultHash || "")) ||
      typeof value.requestSent !== "boolean" ||
      value.requestBodyHash !== request.requestPayloadHash ||
      value.requestBodyBytes !== request.requestPayloadBytes ||
      typeof value.providerResponseBodyHash !== "string" ||
      !Number.isSafeInteger(value.providerResponseBodyBytes) ||
      value.providerResponseBodyBytes < 0 || value.providerResponseBodyBytes > 2097152 ||
      ((value.providerResponseBodyHash === "") !== (value.providerResponseBodyBytes === 0)) ||
      (value.providerResponseBodyHash !== "" && !HASH_RE.test(value.providerResponseBodyHash)) ||
      typeof value.providerErrorCode !== "string" || typeof value.incompleteReason !== "string" ||
      typeof value.outcomeUnknown !== "boolean" || typeof value.billingOutcomeUnknown !== "boolean" ||
      typeof value.providerResponseId !== "string" || typeof value.serverRequestId !== "string" ||
      typeof value.actualModel !== "string" || typeof value.normalizedResultHash !== "string") {
    throw receiptError(operation, `attempt ${attemptNumber} outcome shape is invalid`);
  }
  const httpStatus = value.httpStatus === undefined ? null : value.httpStatus;
  if (httpStatus !== null && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw receiptError(operation, `attempt ${attemptNumber} HTTP status is invalid`);
  }
  const usageFields = [
    "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
    "totalTokens", "actualMicroUsd",
  ];
  if (usageFields.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0) ||
      value.cachedInputTokens > value.inputTokens || value.reasoningTokens > value.outputTokens ||
      value.totalTokens !== value.inputTokens + value.outputTokens ||
      value.inputTokens > request.maxInputTokens || value.outputTokens > request.maxOutputTokens ||
      value.outcomeUnknown !== (value.classification === "outcome_unknown") ||
      value.billingOutcomeUnknown !== new Set(["billing_unknown", "model_mismatch"])
        .has(value.classification)) {
    throw receiptError(operation, `attempt ${attemptNumber} usage or unknown flags are invalid`);
  }
  const policy = PRICING_SOURCE[request.modelSnapshot]?.[request.transport];
  const [inputRate, cachedRate, outputRate] = policy || [];
  const expectedCost = DB_UNKNOWN_CLASSIFICATIONS.has(value.classification) ? 0
    : Math.ceil(((value.inputTokens - value.cachedInputTokens) * inputRate) / 1000000)
      + Math.ceil((value.cachedInputTokens * cachedRate) / 1000000)
      + Math.ceil((value.outputTokens * outputRate) / 1000000);
  if (!policy || value.actualMicroUsd !== expectedCost) {
    throw receiptError(operation, `attempt ${attemptNumber} cost differs from pinned usage`);
  }
  let normalizedResultHash = "";
  if (value.classification === "success") {
    let envelope;
    try {
      envelope = validateModelResponseEnvelope(value.normalizedResult);
    } catch {
      throw receiptError(operation, `attempt ${attemptNumber} success envelope is invalid`);
    }
    normalizedResultHash = sha256Jsonb(envelope);
    if (value.normalizedResultHash !== normalizedResultHash || value.requestSent !== true ||
        httpStatus === null || httpStatus < 200 || httpStatus > 299 || value.totalTokens <= 0 ||
        value.actualModel !== request.modelSnapshot || !value.providerResponseId ||
        !value.serverRequestId || !value.providerResponseBodyHash) {
      throw receiptError(operation, `attempt ${attemptNumber} success proof is incomplete`);
    }
  } else if (Object.prototype.hasOwnProperty.call(value, "normalizedResult") ||
      value.normalizedResultHash !== "") {
    throw receiptError(operation, `attempt ${attemptNumber} non-success carries a model result`);
  }
  if (!value.requestSent && (httpStatus !== null || value.providerResponseBodyHash ||
      value.providerResponseId || value.serverRequestId)) {
    throw receiptError(operation, `attempt ${attemptNumber} unsent outcome carries provider evidence`);
  }
  const expectedOutcomeHash = sha256Jsonb({
    schemaVersion: "truth-model-sync-outcome-v1",
    dispatchId: value.dispatchId,
    clientRequestId: value.clientRequestId,
    providerResultHash: value.providerResultHash,
    requestId: request.requestId,
    attemptNumber,
    classification: value.classification,
    requestSent: value.requestSent,
    httpStatus,
    requestBodyHash: value.requestBodyHash,
    requestBodyBytes: value.requestBodyBytes,
    providerResponseBodyHash: value.providerResponseBodyHash,
    providerResponseBodyBytes: value.providerResponseBodyBytes,
    providerErrorCode: value.providerErrorCode,
    incompleteReason: value.incompleteReason,
    providerResponseId: value.providerResponseId,
    serverRequestId: value.serverRequestId,
    actualModel: value.actualModel,
    normalizedResultHash,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    reasoningTokens: value.reasoningTokens,
    totalTokens: value.totalTokens,
    actualMicroUsd: value.actualMicroUsd,
  });
  if (value.outcomeHash !== expectedOutcomeHash) {
    throw receiptError(operation, `attempt ${attemptNumber} full outcome hash is invalid`);
  }
  return Object.freeze({
    kind: "outcome",
    classification: value.classification,
    providerResponseId: value.providerResponseId,
    serverRequestId: value.serverRequestId,
    charged: !DB_UNKNOWN_CLASSIFICATIONS.has(value.classification),
    usage: Object.freeze({
      inputTokens: value.inputTokens,
      cachedInputTokens: value.cachedInputTokens,
      outputTokens: value.outputTokens,
      reasoningTokens: value.reasoningTokens,
      totalTokens: value.totalTokens,
      actualMicroUsd: value.actualMicroUsd,
    }),
  });
}

function validateReadRequestReceipt(value, operation, expected = null) {
  validateRequestReceipt(value, operation);
  if (expected && (!isPlainObject(expected) ||
      (expected.workspaceKey !== undefined && value.workspaceKey !== expected.workspaceKey) ||
      (expected.requestId !== undefined && value.requestId !== expected.requestId) ||
      (expected.sourceJobId !== undefined && value.sourceJobId !== expected.sourceJobId))) {
    throw receiptError(operation, "request differs from the exact read binding");
  }
  if (!Array.isArray(value.attempts) || value.attempts.length > 3 ||
      value.attempts.length !== value.attemptCount) {
    throw receiptError(operation, "attempt ledger count is invalid");
  }
  const seenDispatches = new Set();
  const seenClients = new Set();
  const seenProviderIds = new Set();
  const seenServerIds = new Set();
  const summaries = value.attempts.map((attempt, index) => {
    const summary = validatePersistedAttemptReceipt(attempt, value, index, operation);
    if (seenDispatches.has(attempt.dispatchId) || seenClients.has(attempt.clientRequestId)) {
      throw receiptError(operation, "attempt dispatch or client identity is duplicated");
    }
    seenDispatches.add(attempt.dispatchId);
    seenClients.add(attempt.clientRequestId);
    for (const [id, seen, label] of [
      [summary.providerResponseId, seenProviderIds, "provider"],
      [summary.serverRequestId, seenServerIds, "server"],
    ]) {
      if (!id) continue;
      if (seen.has(id)) throw receiptError(operation, `${label} response identity is duplicated`);
      seen.add(id);
    }
    return summary;
  });
  const pendingIndexes = summaries.flatMap((summary, index) => (
    summary.kind === "pending" ? [index] : []
  ));
  if (pendingIndexes.length > 1 ||
      (pendingIndexes.length === 1 && pendingIndexes[0] !== summaries.length - 1)) {
    throw receiptError(operation, "only the latest attempt may lack a terminal receipt");
  }
  const recoveryIndexes = summaries.flatMap((summary, index) => (
    summary.kind === "recovery" ? [index] : []
  ));
  if (recoveryIndexes.length > 1 ||
      (recoveryIndexes.length === 1 && recoveryIndexes[0] !== summaries.length - 1)) {
    throw receiptError(operation, "only the latest attempt may be quarantined");
  }
  const successes = summaries.filter((summary) => summary.classification === "success");
  if (successes.length > 1 || (successes.length === 1 &&
      summaries[summaries.length - 1]?.classification !== "success")) {
    throw receiptError(operation, "success must be the one terminal final attempt");
  }
  const last = summaries[summaries.length - 1];
  if (value.state === "planned" && summaries.length !== 0 ||
      value.state === "in_flight" && last?.kind !== "pending" ||
      value.state === "succeeded" && last?.classification !== "success" ||
      value.state === "outcome_unknown" && !(
        last?.kind === "recovery" || new Set(["outcome_unknown", "billing_unknown"])
          .has(last?.classification)
      ) || value.state === "reserved" && last && !(
        last.kind === "outcome" && DB_RETRYABLE_CLASSIFICATIONS.has(last.classification) &&
        summaries.length < value.maxAttempts
      ) || value.state === "review_required" && (
        last?.kind === "pending" || last?.kind === "recovery" || last?.classification === "success"
      )) {
    throw receiptError(operation, "request state differs from its ordered attempt ledger");
  }
  if (value.state === "succeeded" && (
      value.remainingReservedInputTokens !== 0 || value.remainingReservedOutputTokens !== 0 ||
      value.remainingReservedMicroUsd !== 0 || !value.finalizedAt
  )) {
    throw receiptError(operation, "successful request did not release its reservation");
  }
  if (value.state === "outcome_unknown" && value.remainingReservedMicroUsd <= 0) {
    throw receiptError(operation, "unknown external outcome did not retain its reservation");
  }
  const charged = summaries.filter((summary) => summary.kind === "outcome" && summary.charged);
  const aggregate = charged.reduce((total, summary) => ({
    inputTokens: total.inputTokens + summary.usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + summary.usage.cachedInputTokens,
    outputTokens: total.outputTokens + summary.usage.outputTokens,
    reasoningTokens: total.reasoningTokens + summary.usage.reasoningTokens,
    totalTokens: total.totalTokens + summary.usage.totalTokens,
    actualMicroUsd: total.actualMicroUsd + summary.usage.actualMicroUsd,
  }), {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    reasoningTokens: 0, totalTokens: 0, actualMicroUsd: 0,
  });
  if (aggregate.inputTokens !== value.actualInputTokens ||
      aggregate.cachedInputTokens !== value.actualCachedInputTokens ||
      aggregate.outputTokens !== value.actualOutputTokens ||
      aggregate.reasoningTokens !== value.actualReasoningTokens ||
      aggregate.totalTokens !== value.actualTotalTokens ||
      aggregate.actualMicroUsd !== value.actualMicroUsd) {
    throw receiptError(operation, "request aggregate usage differs from its attempt ledger");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateFindRequestReceipt(value, expected, operation) {
  const keys = isPlainObject(value) ? Object.keys(value).sort() : [];
  if (!isPlainObject(value) || value.ok !== true || typeof value.found !== "boolean" ||
      keys.join(",") !== "found,ok,request" ||
      !Object.prototype.hasOwnProperty.call(value, "request") ||
      (value.found === false && value.request !== null) ||
      (value.found === true && !isPlainObject(value.request))) {
    throw receiptError(operation, "source-job lookup wrapper is invalid");
  }
  if (!value.found) return deepFreeze(cloneJson(value, `${operation}.receipt`));
  const request = validateReadRequestReceipt(value.request, operation, expected);
  if (request.workspaceKey !== expected.workspaceKey ||
      request.sourceJobId !== expected.sourceJobId ||
      request.observationId !== expected.observationId ||
      request.observationContentHash !== expected.observationContentHash ||
      request.planHash !== expected.planHash) {
    throw receiptError(operation, "durable request differs from requested source-job binding");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function recoveryIdentityPayload(value) {
  // recoveredAt is immutable audit metadata but deliberately not identity;
  // the database recovery RPC must preserve one hash across wall-clock replays.
  return {
    schemaVersion: value.schemaVersion,
    workspaceKey: value.workspaceKey,
    requestId: value.requestId,
    dispatchId: value.dispatchId,
    attemptNumber: value.attemptNumber,
    sourceJobId: value.sourceJobId,
    recoveryKey: value.recoveryKey,
    recoveryReason: value.recoveryReason,
    externalEffectState: value.externalEffectState,
    reservationDisposition: value.reservationDisposition,
    reviewDisposition: value.reviewDisposition,
    authorizationWorkerId: value.authorizationWorkerId,
    authorizationLeaseFence: value.authorizationLeaseFence,
    authorizationProcessorVersion: value.authorizationProcessorVersion,
    authorizationLeaseExpiresAt: value.authorizationLeaseExpiresAt,
    recoveringWorkerId: value.recoveringWorkerId,
    recoveringLeaseFence: value.recoveringLeaseFence,
    recoveringProcessorVersion: value.recoveringProcessorVersion,
    heldReservedInputTokens: value.heldReservedInputTokens,
    heldReservedOutputTokens: value.heldReservedOutputTokens,
    heldReservedMicroUsd: value.heldReservedMicroUsd,
    dispatchAuthorizedAt: value.dispatchAuthorizedAt,
  };
}

function validateRecoveryReceipt(value, operation, expected = null) {
  const forbiddenProviderFacts = [
    "classification", "providerResultHash", "requestSent", "httpStatus",
    "requestBodyHash", "requestBodyBytes", "providerResponseBodyHash",
    "providerResponseBodyBytes", "providerErrorCode", "incompleteReason",
    "providerResponseId", "serverRequestId", "actualModel", "normalizedResult",
    "normalizedResultHash", "inputTokens", "cachedInputTokens", "outputTokens",
    "reasoningTokens", "totalTokens", "actualMicroUsd", "usage",
  ];
  const keys = isPlainObject(value) ? Object.keys(value).sort() : [];
  const authorization = isPlainObject(value) ? [
    value.authorizationWorkerId,
    value.authorizationLeaseFence,
    value.authorizationProcessorVersion,
    value.authorizationLeaseExpiresAt,
  ] : [];
  const authorizationAbsent = authorization.length === 4 &&
    authorization.every((field) => field === null);
  const authorizationComplete = authorization.length === 4 &&
    typeof value.authorizationWorkerId === "string" && value.authorizationWorkerId.length > 0 &&
    Number.isSafeInteger(value.authorizationLeaseFence) && value.authorizationLeaseFence > 0 &&
    typeof value.authorizationProcessorVersion === "string" &&
      value.authorizationProcessorVersion.length > 0 &&
    typeof value.authorizationLeaseExpiresAt === "string" &&
      Number.isFinite(Date.parse(value.authorizationLeaseExpiresAt));
  const dispatchAuthorizedAtMs = Date.parse(String(value?.dispatchAuthorizedAt || ""));
  const recoveredAtMs = Date.parse(String(value?.recoveredAt || ""));
  const authorizationExpiresAtMs = authorizationComplete
    ? Date.parse(value.authorizationLeaseExpiresAt) : null;
  const expectedHash = isPlainObject(value) && keys.length === RECOVERY_RECEIPT_KEYS.length
    ? sha256Jsonb(recoveryIdentityPayload(value)) : "";
  if (!isPlainObject(value) || value.ok !== true || typeof value.idempotent !== "boolean" ||
      keys.join(",") !== RECOVERY_RECEIPT_KEYS.join(",") ||
      value.sendAuthorized !== false || value.quarantined !== true ||
      value.schemaVersion !== "truth-model-dispatch-recovery-v1" ||
      !/^model-dispatch-recovery:v1:[0-9a-f]{64}$/.test(String(value.recoveryId || "")) ||
      !HASH_RE.test(String(value.recoveryHash || "")) ||
      value.recoveryHash !== expectedHash ||
      value.recoveryId !== `model-dispatch-recovery:v1:${expectedHash}` ||
      typeof value.recoveryKey !== "string" || !value.recoveryKey ||
      value.recoveryKey.trim() !== value.recoveryKey ||
      Buffer.byteLength(value.recoveryKey, "utf8") > 500 ||
      typeof value.workspaceKey !== "string" || !value.workspaceKey ||
      !/^model-dispatch:v1:[0-9a-f]{64}$/.test(String(value.dispatchId || "")) ||
      !REQUEST_ID_RE.test(String(value.requestId || "")) ||
      !UUID_RE.test(String(value.sourceJobId || "")) ||
      !Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1 ||
      value.attemptNumber > 3 || value.recoveryReason !== DISPATCH_RECOVERY_REASON ||
      value.reviewReason !== DISPATCH_RECOVERY_REVIEW_REASON ||
      value.externalEffectState !== "unknown_possible_post" ||
      value.reservationDisposition !== "held_conservatively" ||
      value.reviewDisposition !== "non_resolvable_external_effect_uncertainty" ||
      (!authorizationAbsent && !authorizationComplete) ||
      typeof value.recoveringWorkerId !== "string" || !value.recoveringWorkerId ||
      !Number.isSafeInteger(value.recoveringLeaseFence) || value.recoveringLeaseFence < 1 ||
      typeof value.recoveringProcessorVersion !== "string" ||
        !value.recoveringProcessorVersion ||
      !Number.isFinite(dispatchAuthorizedAtMs) || !Number.isFinite(recoveredAtMs) ||
      recoveredAtMs < dispatchAuthorizedAtMs ||
      (authorizationComplete && (
        authorizationExpiresAtMs < dispatchAuthorizedAtMs ||
        value.recoveringLeaseFence <= value.authorizationLeaseFence
      )) ||
      !Number.isSafeInteger(value.heldReservedInputTokens) || value.heldReservedInputTokens < 0 ||
      !Number.isSafeInteger(value.heldReservedOutputTokens) || value.heldReservedOutputTokens < 0 ||
      !Number.isSafeInteger(value.heldReservedMicroUsd) || value.heldReservedMicroUsd <= 0 ||
      !isPlainObject(value.request) ||
      forbiddenProviderFacts.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new TruthModelRequestLedgerError(`Invalid ${operation} recovery receipt`, {
      code: "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  const request = validateRequestReceipt(value.request, operation);
  if (request.requestId !== value.requestId || request.workspaceKey !== value.workspaceKey ||
      request.sourceJobId !== value.sourceJobId || request.state !== "outcome_unknown" ||
      request.idempotent !== value.idempotent || request.attemptCount !== value.attemptNumber ||
      value.request.ok !== false || value.request.reviewReason !== DISPATCH_RECOVERY_REVIEW_REASON ||
      value.request.remainingReservedInputTokens !== value.heldReservedInputTokens ||
      value.request.remainingReservedOutputTokens !== value.heldReservedOutputTokens ||
      value.request.remainingReservedMicroUsd !== value.heldReservedMicroUsd) {
    throw new TruthModelRequestLedgerError(`${operation} recovery differs from held request`, {
      code: "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  const differsFromExpected = expected && (!isPlainObject(expected) ||
    (expected.workspaceKey !== undefined && value.workspaceKey !== expected.workspaceKey) ||
    (expected.requestId !== undefined && value.requestId !== expected.requestId) ||
    (expected.dispatchId !== undefined && value.dispatchId !== expected.dispatchId) ||
    (expected.sourceJobId !== undefined && value.sourceJobId !== expected.sourceJobId) ||
    (expected.attemptNumber !== undefined && value.attemptNumber !== expected.attemptNumber) ||
    (expected.recoveryKey !== undefined && value.recoveryKey !== expected.recoveryKey) ||
    (expected.recoveryReason !== undefined && value.recoveryReason !== expected.recoveryReason) ||
    (expected.authorizationWorkerId !== undefined &&
      value.authorizationWorkerId !== expected.authorizationWorkerId) ||
    (expected.authorizationLeaseFence !== undefined &&
      value.authorizationLeaseFence !== expected.authorizationLeaseFence) ||
    (expected.authorizationProcessorVersion !== undefined &&
      value.authorizationProcessorVersion !== expected.authorizationProcessorVersion) ||
    (expected.authorizationLeaseExpiresAt !== undefined &&
      value.authorizationLeaseExpiresAt !== expected.authorizationLeaseExpiresAt) ||
    (expected.dispatchAuthorizedAt !== undefined &&
      value.dispatchAuthorizedAt !== expected.dispatchAuthorizedAt) ||
    (expected.workerId !== undefined && value.recoveringWorkerId !== expected.workerId) ||
    (expected.leaseFence !== undefined && value.recoveringLeaseFence !== expected.leaseFence) ||
    (expected.processorVersion !== undefined &&
      value.recoveringProcessorVersion !== expected.processorVersion));
  if (differsFromExpected) {
    throw receiptError(operation, "recovery receipt differs from exact invocation binding");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateRecoveryStatusReceipt(value, expected, operation) {
  const obligationId = String(value?.operationalReviewObligationId || "");
  const resolutionId = String(value?.operationalReviewResolutionId || "");
  const keys = isPlainObject(value) ? Object.keys(value).sort() : [];
  if (!isPlainObject(value) || value.ok !== true || typeof value.found !== "boolean" ||
      keys.join(",") !== [
        "externalEffectResolutionStatus", "found", "mutatesOperationalState", "ok",
        "operationalReviewObligationId", "operationalReviewResolutionId",
        "operationalReviewResolved", "recovery", "schemaVersion", "sourceJobId",
        "workspaceKey",
      ].sort().join(",") ||
      value.schemaVersion !== "truth-model-dispatch-recovery-status-v1" ||
      value.workspaceKey !== expected.workspaceKey || value.sourceJobId !== expected.sourceJobId ||
      typeof value.operationalReviewResolved !== "boolean" ||
      value.mutatesOperationalState !== false ||
      !Object.prototype.hasOwnProperty.call(value, "recovery") ||
      (obligationId !== "" && !/^gmail-model-review:v1:[0-9a-f]{64}$/.test(obligationId)) ||
      (resolutionId !== "" &&
        !/^gmail-model-review-resolution:v1:[0-9a-f]{64}$/.test(resolutionId)) ||
      value.operationalReviewResolved !== (resolutionId !== "") ||
      (resolutionId !== "" && obligationId === "")) {
    throw receiptError(operation, "recovery-status wrapper is invalid");
  }
  if (!value.found) {
    if (value.externalEffectResolutionStatus !== "not_recorded" || value.recovery !== null ||
        value.operationalReviewResolved || obligationId !== "" || resolutionId !== "") {
      throw receiptError(operation, "absent recovery status carries durable recovery facts");
    }
    return deepFreeze(cloneJson(value, `${operation}.receipt`));
  }
  if (value.externalEffectResolutionStatus !== "unresolved" ||
      !isPlainObject(value.recovery)) {
    throw receiptError(operation, "durable recovery is not independently unresolved");
  }
  const recovery = validateRecoveryReceipt(value.recovery, operation);
  if (recovery.workspaceKey !== expected.workspaceKey ||
      recovery.sourceJobId !== expected.sourceJobId ||
      recovery.request.workspaceKey !== expected.workspaceKey ||
      recovery.request.sourceJobId !== expected.sourceJobId) {
    throw receiptError(operation, "recovery status crosses its source-job binding");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthModelRequestLedgerError) return error;
  return new TruthModelRequestLedgerError(`Truth model ${operation} failed: ${error?.message || error}`, {
    code: String(error?.code || "TRUTH_MODEL_LEDGER_RPC_FAILED"),
    operation,
    rpc,
    retryable: new Set(["40001", "40P01", "55P03", "57014"]).has(String(error?.code || "")),
    cause: error instanceof Error ? error : undefined,
  });
}

function createInvoker(options) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalid("options.callRpc", "must be a function");
  const rpcOptions = cloneJson(options.rpcOptions || {}, "options.rpcOptions");
  return async (operation, rpc, body, validator) => {
    try {
      const value = await callRpc(rpc, body, rpcOptions);
      return validator(value, operation);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
  };
}

function createTruthModelRequestLedger(options = {}) {
  const invoke = createInvoker(options);
  const workspaceKey = text(options.workspaceKey || "primary", "options.workspaceKey", 128);
  const syncToken = text(options.syncToken, "options.syncToken", 4096);
  const workerId = text(options.workerId, "options.workerId", 500);
  const processorVersion = text(options.processorVersion, "options.processorVersion", 500);
  const lease = (input) => ({
    p_worker_id: workerId,
    p_lease_fence: integer(input.leaseFence, "leaseFence", 1),
    p_processor_version: processorVersion,
  });

  async function createRequest(input = {}) {
    if (!isPlainObject(input)) throw invalid("createRequest", "must be an object");
    const requestPayload = cloneJson(
      input.requestPayload ?? input.requestBody,
      input.requestPayload === undefined ? "requestBody" : "requestPayload",
    );
    if (!isPlainObject(requestPayload)) throw invalid("requestPayload", "must be an object");
    const suppliedPayloadText = input.requestPayloadText ?? input.requestBodyText;
    const requestPayloadText = suppliedPayloadText === undefined
      ? JSON.stringify(requestPayload)
      : suppliedPayloadText;
    if (typeof requestPayloadText !== "string" || requestPayloadText.length === 0) {
      throw invalid("requestPayloadText", "must be exact non-empty JSON wire text");
    }
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(requestPayloadText);
    } catch {
      throw invalid("requestPayloadText", "must be valid JSON wire text");
    }
    if (!isPlainObject(parsedPayload) || sha256Jsonb(parsedPayload) !== sha256Jsonb(requestPayload)) {
      throw invalid("requestPayloadText", "must encode the same JSON object as requestPayload");
    }
    if (requestPayloadText !== JSON.stringify(requestPayload)) {
      throw invalid("requestPayloadText", "must equal the deterministic provider JSON serialization");
    }
    const payloadBytes = Buffer.byteLength(requestPayloadText, "utf8");
    const payloadHash = sha256Text(requestPayloadText);
    if (input.requestBodyHash !== undefined && hash(input.requestBodyHash, "requestBodyHash") !== payloadHash) {
      throw invalid("requestBodyHash", "does not match exact requestPayloadText");
    }
    if (input.requestBodyBytes !== undefined &&
        integer(input.requestBodyBytes, "requestBodyBytes", 1, 1048576) !== payloadBytes) {
      throw invalid("requestBodyBytes", "does not match exact requestPayloadText");
    }
    const maxOutputTokens = integer(input.maxOutputTokens, "maxOutputTokens", 1, 128000);
    if (payloadBytes < 1 || payloadBytes + maxOutputTokens > 400000) {
      throw invalid("requestPayload", "UTF-8 byte upper bound plus max output exceeds 400000 tokens");
    }
    const transport = text(input.transport || "sync", "transport", 20);
    if (!new Set(["sync", "batch"]).has(transport)) throw invalid("transport", "must be sync or batch");
    const modelSnapshot = text(input.modelSnapshot, "modelSnapshot", 200);
    const policy = pricingPolicy(modelSnapshot, transport);
    return invoke("create request", RPC.createRequest, {
      p_workspace_key: workspaceKey,
      p_logical_request_key: text(input.logicalRequestKey, "logicalRequestKey", 500),
      p_source_job_id: text(input.sourceJobId, "sourceJobId", 100),
      p_observation_id: text(input.observationId, "observationId", 100),
      p_observation_content_hash: hash(input.observationContentHash, "observationContentHash"),
      p_plan_hash: hash(input.planHash, "planHash"),
      p_request_payload: requestPayload,
      p_request_payload_text: requestPayloadText,
      p_model_snapshot: modelSnapshot,
      p_prompt_version: text(input.promptVersion, "promptVersion", 500),
      p_response_schema_version: text(input.responseSchemaVersion, "responseSchemaVersion", 500),
      p_response_schema_hash: hash(input.responseSchemaHash, "responseSchemaHash"),
      p_processing_config_version: text(input.processingConfigVersion, "processingConfigVersion", 500),
      p_processing_config_hash: hash(input.processingConfigHash, "processingConfigHash"),
      p_pricing_policy_id: policy.pricingPolicyId,
      p_transport: transport,
      p_max_output_tokens: maxOutputTokens,
      ...lease(input),
      p_sync_token: syncToken,
    }, validateRequestReceipt);
  }

  async function reserveRequest(input = {}) {
    if (!isPlainObject(input)) throw invalid("reserveRequest", "must be an object");
    return invoke("reserve request", RPC.reserveRequest, {
      p_workspace_key: workspaceKey,
      p_request_id: text(input.requestId, "requestId", 100),
      ...lease(input),
      p_sync_token: syncToken,
    }, validateRequestReceipt);
  }

  async function beginSyncAttempt(input = {}) {
    if (!isPlainObject(input)) throw invalid("beginSyncAttempt", "must be an object");
    return invoke("begin sync attempt", RPC.beginSyncAttempt, {
      p_workspace_key: workspaceKey,
      p_request_id: text(input.requestId, "requestId", 100),
      ...lease(input),
      p_sync_token: syncToken,
    }, (value, operation) => {
      if (value?.sendAuthorized === false && !value?.dispatchId) {
        return validateRequestReceipt(value, operation);
      }
      return validateAttemptReceipt(value, operation);
    });
  }

  async function reconcileProviderAttempt(input = {}) {
    if (!isPlainObject(input)) throw invalid("reconcileProviderAttempt", "must be an object");
    const forbidden = [
      "classification", "requestSent", "httpStatus", "requestBodyHash", "requestBodyBytes",
      "providerResponseBodyHash", "providerResponseBodyBytes", "providerErrorCode",
      "incompleteReason", "providerResponseId", "serverRequestId", "actualModel",
      "normalizedResult", "usage",
    ].find((field) => input[field] !== undefined);
    if (forbidden) {
      throw invalid(forbidden, "must come only from the sealed providerResult");
    }
    const provider = mapProviderResultToReconciliation(
      input.providerResult,
      input.attemptNumber,
    );
    const clientRequestId = text(input.clientRequestId, "clientRequestId", 500);
    if (clientRequestId !== provider.clientRequestId) {
      throw invalid("clientRequestId", "differs from the sealed provider attempt receipt");
    }
    const dispatchId = text(input.dispatchId, "dispatchId", 100);
    if (!/^model-dispatch:v1:[0-9a-f]{64}$/.test(dispatchId)) {
      throw invalid("dispatchId", "must be a DB-minted model dispatch identity");
    }
    const requestId = text(input.requestId, "requestId", 100);
    if (provider.requestId !== requestId || provider.dispatchId !== dispatchId) {
      throw invalid("providerResult", "request or dispatch identity differs from DB authorization");
    }
    const normalizedResultHash = provider.normalizedResult === null
      ? "" : sha256Jsonb(provider.normalizedResult);
    return invoke("reconcile sync attempt", RPC.reconcileSyncAttempt, {
      p_workspace_key: workspaceKey,
      p_request_id: requestId,
      p_attempt_number: provider.attemptNumber,
      p_dispatch_id: dispatchId,
      p_client_request_id: clientRequestId,
      p_provider_result_hash: provider.providerResultHash,
      p_classification: provider.classification,
      p_request_sent: provider.requestSent,
      p_http_status: provider.httpStatus,
      p_request_body_hash: provider.requestBodyHash,
      p_request_body_bytes: provider.requestBodyBytes,
      p_provider_response_body_hash: provider.providerResponseBodyHash,
      p_provider_response_body_bytes: provider.providerResponseBodyBytes,
      p_provider_error_code: provider.providerErrorCode,
      p_incomplete_reason: provider.incompleteReason,
      p_provider_response_id: provider.providerResponseId,
      p_server_request_id: provider.serverRequestId,
      p_actual_model: provider.actualModel,
      p_normalized_result: provider.normalizedResult,
      p_normalized_result_hash: normalizedResultHash,
      p_input_tokens: provider.usage.inputTokens,
      p_cached_input_tokens: provider.usage.cachedInputTokens,
      p_output_tokens: provider.usage.outputTokens,
      p_reasoning_tokens: provider.usage.reasoningTokens,
      p_total_tokens: provider.usage.totalTokens,
      p_sync_token: syncToken,
    }, validateAttemptReceipt);
  }

  async function recoverUnknownAttempt(input = {}) {
    if (!isPlainObject(input)) throw invalid("recoverUnknownAttempt", "must be an object");
    const dispatchId = text(input.dispatchId, "dispatchId", 100);
    if (!/^model-dispatch:v1:[0-9a-f]{64}$/.test(dispatchId)) {
      throw invalid("dispatchId", "must be a DB-minted model dispatch identity");
    }
    const recoveryReason = input.recoveryReason === undefined
      ? DISPATCH_RECOVERY_REASON
      : text(input.recoveryReason, "recoveryReason", 100);
    if (recoveryReason !== DISPATCH_RECOVERY_REASON) {
      throw invalid("recoveryReason", "must preserve external-effect uncertainty");
    }
    const requestId = text(input.requestId, "requestId", 100);
    const recoveryKey = text(input.recoveryKey, "recoveryKey", 500);
    const leaseFields = lease(input);
    const binding = Object.freeze({
      workspaceKey,
      requestId,
      dispatchId,
      recoveryKey,
      recoveryReason,
      workerId,
      leaseFence: leaseFields.p_lease_fence,
      processorVersion,
    });
    return invoke("recover unknown attempt", RPC.recoverUnknownAttempt, {
      p_workspace_key: workspaceKey,
      p_request_id: requestId,
      p_dispatch_id: dispatchId,
      p_recovery_key: recoveryKey,
      p_recovery_reason: recoveryReason,
      ...leaseFields,
      p_sync_token: syncToken,
    }, (value, operation) => validateRecoveryReceipt(value, operation, binding));
  }

  async function findRequestForSourceJob(input = {}) {
    if (!isPlainObject(input)) throw invalid("findRequestForSourceJob", "must be an object");
    if (input.requestId !== undefined) {
      throw invalid("requestId", "must not be supplied to source-job request discovery");
    }
    const binding = Object.freeze({
      workspaceKey,
      sourceJobId: uuid(input.sourceJobId, "sourceJobId"),
      observationId: text(input.observationId, "observationId", 100),
      observationContentHash: hash(input.observationContentHash, "observationContentHash"),
      planHash: hash(input.planHash, "planHash"),
    });
    if (!/^obs:v1:[0-9a-f]{64}$/.test(binding.observationId)) {
      throw invalid("observationId", "must be a source observation identity");
    }
    return invoke("find request for source job", RPC.findRequestForSourceJob, {
      p_workspace_key: workspaceKey,
      p_source_job_id: binding.sourceJobId,
      p_observation_id: binding.observationId,
      p_observation_content_hash: binding.observationContentHash,
      p_plan_hash: binding.planHash,
      ...lease(input),
      p_sync_token: syncToken,
    }, (value, operation) => validateFindRequestReceipt(value, binding, operation));
  }

  async function readRecoveryStatus(input = {}) {
    if (!isPlainObject(input)) throw invalid("readRecoveryStatus", "must be an object");
    const sourceJobId = uuid(input.sourceJobId, "sourceJobId");
    const binding = Object.freeze({ workspaceKey, sourceJobId });
    return invoke("read dispatch recovery status", RPC.readRecoveryStatus, {
      p_workspace_key: workspaceKey,
      p_source_job_id: sourceJobId,
      p_sync_token: syncToken,
    }, (value, operation) => validateRecoveryStatusReceipt(value, binding, operation));
  }

  async function readRequest(input = {}) {
    if (!isPlainObject(input)) throw invalid("readRequest", "must be an object");
    const requestId = text(input.requestId, "requestId", 100);
    return invoke("read request", RPC.readRequest, {
      p_workspace_key: workspaceKey,
      p_request_id: requestId,
      p_sync_token: syncToken,
    }, (value, operation) => validateReadRequestReceipt(value, operation, {
      workspaceKey,
      requestId,
    }));
  }

  return Object.freeze({
    workspaceKey,
    workerId,
    processorVersion,
    createRequest,
    reserveRequest,
    beginSyncAttempt,
    reconcileProviderAttempt,
    recoverUnknownAttempt,
    findRequestForSourceJob,
    readRecoveryStatus,
    readRequest,
  });
}

function createTruthModelAccountIssuer(options = {}) {
  const invoke = createInvoker(options);
  const workspaceKey = text(options.workspaceKey || "primary", "options.workspaceKey", 128);
  const issuerToken = text(options.issuerToken, "options.issuerToken", 4096);
  return Object.freeze({
    workspaceKey,
    async configure(input = {}) {
      if (!isPlainObject(input)) throw invalid("configure", "must be an object");
      return invoke("configure account", RPC.configureAccount, {
        p_workspace_key: workspaceKey,
        p_configuration_request_key: text(input.configurationRequestKey, "configurationRequestKey", 500),
        p_status: input.enabled === true ? "enabled" : "disabled",
        p_lifetime_allocation_microusd: integer(input.lifetimeAllocationMicroUsd, "lifetimeAllocationMicroUsd", 1),
        p_daily_ceiling_microusd: integer(input.dailyCeilingMicroUsd, "dailyCeilingMicroUsd", 1),
        p_configured_by: text(input.configuredBy, "configuredBy", 500),
        p_configuration_reason: text(input.configurationReason, "configurationReason", 2000),
        p_issuer_token: issuerToken,
      }, (value, operation) => {
        if (!isPlainObject(value) || value.ok !== true || typeof value.idempotent !== "boolean" ||
            !["enabled", "disabled"].includes(value.status)) {
          throw new TruthModelRequestLedgerError(`Invalid ${operation} receipt`, {
            code: "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
            operation,
          });
        }
        return deepFreeze(cloneJson(value));
      });
    },
  });
}

module.exports = Object.freeze({
  DISPATCH_RECOVERY_REASON,
  DISPATCH_RECOVERY_REVIEW_REASON,
  PRICING_SOURCE,
  PRICING_VERSION,
  RPC,
  TruthModelRequestLedgerError,
  createTruthModelAccountIssuer,
  createTruthModelRequestLedger,
  pricingPolicy,
  _test: Object.freeze({
    cloneJson,
    mapProviderResultToReconciliation,
    sha256Jsonb,
    sha256Text,
    recoveryIdentityPayload,
    validateAttemptReceipt,
    validateFindRequestReceipt,
    validateRecoveryReceipt,
    validateRecoveryStatusReceipt,
    validateReadRequestReceipt,
    validateRequestReceipt,
  }),
});

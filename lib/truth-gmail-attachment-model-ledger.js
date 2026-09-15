"use strict";

const {
  PROCESSING_CONFIG_HASH,
  PROCESSING_CONFIG_VERSION,
  PROMPT_VERSION,
  RESPONSE_SCHEMA_HASH,
  RESPONSE_SCHEMA_VERSION,
  PINNED_MODEL,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_ATTEMPTS,
  validateAttemptResult,
} = require("./openai-gmail-attachment-model-extractor");

const RPC = Object.freeze({
  loadContext: "load_truth_gmail_attachment_model_context",
  adoptPrior: "adopt_truth_gmail_attachment_model_replay",
  createRequest: "create_truth_gmail_attachment_model_request",
  reserveRequest: "reserve_truth_gmail_attachment_model_request",
  beginAttempt: "begin_truth_gmail_attachment_model_attempt",
  reconcileAttempt: "reconcile_truth_gmail_attachment_model_attempt",
  completeExtraction: "complete_truth_gmail_attachment_model_extraction",
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const OBSERVATION_RE = /^obs:v1:[0-9a-f]{64}$/;
const REQUEST_RE = /^gmail-attachment-model-request:v1:[0-9a-f]{64}$/;
const DISPATCH_RE = /^gmail-attachment-model-dispatch:v1:[0-9a-f]{64}$/;
const REQUEST_STATES = new Set([
  "planned", "reserved", "in_flight", "succeeded", "review_required", "outcome_unknown",
]);
const ADOPTION_RE = /^truth-gmail-attachment-replay-adoption:v1:[0-9a-f]{64}$/;

class TruthGmailAttachmentModelLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthGmailAttachmentModelLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthGmailAttachmentModelLedgerError(
    `Invalid Gmail attachment model ledger ${field}: ${reason}`,
    { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_ARGUMENT", field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, field = "value") {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) {
      throw new Error("unbounded");
    }
    return JSON.parse(serialized);
  } catch {
    throw invalid(field, "must be bounded JSON");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function text(value, field, maximumBytes = 4096) {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalid(field, "must be a non-empty bounded trimmed string");
  }
  return value;
}

function uuid(value, field) {
  const normalized = text(value, field, 100);
  if (!UUID_RE.test(normalized)) throw invalid(field, "must be a UUID");
  return normalized;
}

function hash(value, field) {
  const normalized = text(value, field, 64);
  if (!HASH_RE.test(normalized)) throw invalid(field, "must be lowercase SHA-256 hex");
  return normalized;
}

function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function validateRawObject(value, operation) {
  if (!isPlainObject(value) || typeof value.bucket !== "string" || !value.bucket ||
      typeof value.key !== "string" || !value.key ||
      !HASH_RE.test(String(value.hash || "")) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
      typeof value.contentType !== "string" || !value.contentType) {
    throw new TruthGmailAttachmentModelLedgerError(
      `${operation} returned an invalid immutable raw-object binding`,
      { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT", operation },
    );
  }
  return deepFreeze(cloneJson(value, `${operation}.rawObject`));
}

function validateContext(value, operation, expected) {
  if (!isPlainObject(value) || value.ok !== true ||
      value.schemaVersion !== "gmail-attachment-model-context-v1" ||
      value.workspaceKey !== expected.workspaceKey || value.jobId !== expected.jobId ||
      value.workerId !== expected.workerId || value.leaseFence !== expected.leaseFence ||
      value.processorVersion !== expected.processorVersion ||
      value.jobKind !== "gmail_review_attachment_extraction" ||
      !OBSERVATION_RE.test(String(value.observationId || "")) ||
      !HASH_RE.test(String(value.observationContentHash || "")) ||
      !UUID_RE.test(String(value.rootBatchId || "")) ||
      typeof value.connectionKey !== "string" ||
      // 20260717240000 admits the live connection alongside shadow
      // commissioning; either way the model lane itself never publishes, so
      // shadowOnly stays true.
      !(value.connectionKey.startsWith("shadow-") || value.connectionKey === "primary") ||
      typeof value.attachmentId !== "string" || !value.attachmentId ||
      typeof value.filename !== "string" || typeof value.mimeType !== "string" || !value.mimeType ||
      value.shadowOnly !== true || value.productionPublicationAttempted !== false) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} returned an invalid context`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  const result = cloneJson(value, `${operation}.receipt`);
  result.rawObject = validateRawObject(result.rawObject, operation);
  if (result.rawObject.hash !== result.rawSha256 || result.rawObject.bytes !== result.rawBytes) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} raw-object facts conflict`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  return deepFreeze(result);
}

function validateRequest(value, operation, expected = {}) {
  if (!isPlainObject(value) || typeof value.ok !== "boolean" ||
      typeof value.idempotent !== "boolean" ||
      value.schemaVersion !== "gmail-attachment-model-request-receipt-v1" ||
      value.workspaceKey !== expected.workspaceKey ||
      (expected.jobId !== undefined && value.jobId !== expected.jobId) ||
      !REQUEST_RE.test(String(value.requestId || "")) || !HASH_RE.test(String(value.requestHash || "")) ||
      !REQUEST_STATES.has(value.state) || !OBSERVATION_RE.test(String(value.observationId || "")) ||
      !HASH_RE.test(String(value.observationContentHash || "")) ||
      !HASH_RE.test(String(value.rawSha256 || "")) ||
      !HASH_RE.test(String(value.requestBodyHash || "")) ||
      !Number.isSafeInteger(value.requestBodyBytes) || value.requestBodyBytes < 1 ||
      value.modelSnapshot !== PINNED_MODEL || value.promptVersion !== PROMPT_VERSION ||
      value.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
      value.responseSchemaHash !== RESPONSE_SCHEMA_HASH ||
      value.processingConfigVersion !== PROCESSING_CONFIG_VERSION ||
      value.processingConfigHash !== PROCESSING_CONFIG_HASH ||
      value.maxInputTokens !== MAX_INPUT_TOKENS || value.maxOutputTokens !== MAX_OUTPUT_TOKENS ||
      value.maxAttempts !== MAX_ATTEMPTS || typeof value.reviewReason !== "string" ||
      !Number.isSafeInteger(value.reservedMicroUsd) || value.reservedMicroUsd < 0 ||
      !Number.isSafeInteger(value.actualMicroUsd) || value.actualMicroUsd < 0 ||
      value.mutatesOperationalState !== false || value.productionPublicationAttempted !== false) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} returned an invalid request receipt`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  if (expected.requestId !== undefined && value.requestId !== expected.requestId ||
      expected.requestBodyHash !== undefined && value.requestBodyHash !== expected.requestBodyHash ||
      expected.requestBodyBytes !== undefined && value.requestBodyBytes !== expected.requestBodyBytes) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} request binding changed`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateAdoption(value, operation, expected) {
  if (!isPlainObject(value) || value.ok !== true || typeof value.adopted !== "boolean" ||
      value.schemaVersion !== "truth-gmail-attachment-replay-adoption-receipt-v1" ||
      value.workspaceKey !== expected.workspaceKey || value.jobId !== expected.jobId ||
      value.workerId !== expected.workerId || value.leaseFence !== expected.leaseFence ||
      value.processorVersion !== expected.processorVersion ||
      value.candidateClaimsAutoAccepted !== false ||
      value.modelRequestCreated !== false || value.modelBudgetReserved !== false ||
      value.providerDispatchAttempted !== false ||
      value.productionPublicationAttempted !== false) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} returned an invalid adoption receipt`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  if (value.adopted === true && (
    !ADOPTION_RE.test(String(value.adoptionId || "")) ||
    !HASH_RE.test(String(value.adoptionHash || "")) ||
    !UUID_RE.test(String(value.priorJobId || "")) ||
    !REQUEST_RE.test(String(value.priorRequestId || "")) ||
    !["prior_operational_evidence_recorded", "prior_operator_review_remains_open"]
      .includes(String(value.disposition || ""))
  )) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} returned an incomplete adoption`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  if (value.adopted === false && (
    value.adoptionId !== null || value.adoptionHash !== null ||
    value.priorJobId !== null || value.priorRequestId !== null ||
    value.disposition !== null
  )) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} returned a conflicting non-adoption`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateDispatch(value, operation, expected) {
  if (!isPlainObject(value) || value.ok !== true || typeof value.idempotent !== "boolean" ||
      typeof value.sendAuthorized !== "boolean" ||
      value.schemaVersion !== "gmail-attachment-model-dispatch-receipt-v1" ||
      value.workspaceKey !== expected.workspaceKey || value.requestId !== expected.requestId ||
      !DISPATCH_RE.test(String(value.dispatchId || "")) ||
      !Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1 ||
      value.attemptNumber > MAX_ATTEMPTS || typeof value.clientRequestId !== "string" ||
      !value.clientRequestId || value.requestBodyHash !== expected.requestBodyHash ||
      value.requestBodyBytes !== expected.requestBodyBytes ||
      value.mutatesOperationalState !== false || value.productionPublicationAttempted !== false) {
    throw new TruthGmailAttachmentModelLedgerError(`${operation} returned an invalid dispatch`, {
      code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT",
      operation,
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthGmailAttachmentModelLedgerError) return error;
  return new TruthGmailAttachmentModelLedgerError(
    `Gmail attachment model ${operation} failed: ${error?.message || error}`,
    {
      code: String(error?.code || "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_RPC_FAILED"),
      operation,
      rpc,
      retryable: new Set(["40001", "40P01", "55P03", "57014"]).has(String(error?.code || "")),
      cause: error instanceof Error ? error : undefined,
    },
  );
}

function createTruthGmailAttachmentModelLedger(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || "primary", "options.workspaceKey", 128);
  const syncToken = text(options.syncToken, "options.syncToken", 4096);
  const reviewToken = text(options.reviewToken, "options.reviewToken", 4096);
  const workerId = text(options.workerId, "options.workerId", 500);
  const processorVersion = text(options.processorVersion, "options.processorVersion", 500);
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalid("options.callRpc", "must be a function");
  const rpcOptions = cloneJson(options.rpcOptions || {}, "options.rpcOptions");

  const invoke = async (operation, rpc, body, validator) => {
    try { return validator(await callRpc(rpc, body, rpcOptions), operation); }
    catch (error) { throw normalizeRpcError(error, operation, rpc); }
  };
  const lease = (input) => ({
    p_job_id: uuid(input.jobId, "jobId"),
    p_worker_id: workerId,
    p_lease_fence: integer(input.leaseFence, "leaseFence", 1),
    p_processor_version: processorVersion,
  });

  async function loadContext(input = {}) {
    const fields = lease(input);
    const expected = {
      workspaceKey,
      jobId: fields.p_job_id,
      workerId,
      leaseFence: fields.p_lease_fence,
      processorVersion,
    };
    return invoke("load context", RPC.loadContext, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_sync_token: syncToken,
    }, (value, operation) => validateContext(value, operation, expected));
  }

  async function adoptPrior(input = {}) {
    const fields = lease(input);
    const expected = {
      workspaceKey,
      jobId: fields.p_job_id,
      workerId,
      leaseFence: fields.p_lease_fence,
      processorVersion,
    };
    return invoke("adopt prior replay", RPC.adoptPrior, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_model_snapshot: PINNED_MODEL,
      p_prompt_version: PROMPT_VERSION,
      p_response_schema_version: RESPONSE_SCHEMA_VERSION,
      p_response_schema_hash: RESPONSE_SCHEMA_HASH,
      p_processing_config_version: PROCESSING_CONFIG_VERSION,
      p_processing_config_hash: PROCESSING_CONFIG_HASH,
      p_sync_token: syncToken,
    }, (value, operation) => validateAdoption(value, operation, expected));
  }

  async function createRequest(input = {}) {
    const fields = lease(input);
    const expected = {
      workspaceKey,
      jobId: fields.p_job_id,
      requestBodyHash: hash(input.requestBodyHash, "requestBodyHash"),
      requestBodyBytes: integer(input.requestBodyBytes, "requestBodyBytes", 1, 75 * 1024 * 1024),
    };
    return invoke("create request", RPC.createRequest, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_request_body_hash: expected.requestBodyHash,
      p_request_body_bytes: expected.requestBodyBytes,
      p_model_snapshot: PINNED_MODEL,
      p_prompt_version: PROMPT_VERSION,
      p_response_schema_version: RESPONSE_SCHEMA_VERSION,
      p_response_schema_hash: RESPONSE_SCHEMA_HASH,
      p_processing_config_version: PROCESSING_CONFIG_VERSION,
      p_processing_config_hash: PROCESSING_CONFIG_HASH,
      p_max_input_tokens: MAX_INPUT_TOKENS,
      p_max_output_tokens: MAX_OUTPUT_TOKENS,
      p_max_attempts: MAX_ATTEMPTS,
      p_sync_token: syncToken,
    }, (value, operation) => validateRequest(value, operation, expected));
  }

  async function reserveRequest(input = {}) {
    const fields = lease(input);
    const requestId = text(input.requestId, "requestId", 100);
    return invoke("reserve request", RPC.reserveRequest, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_request_id: requestId,
      p_sync_token: syncToken,
    }, (value, operation) => validateRequest(value, operation, { workspaceKey, requestId }));
  }

  async function beginAttempt(input = {}) {
    const fields = lease(input);
    const expected = {
      workspaceKey,
      requestId: text(input.requestId, "requestId", 100),
      requestBodyHash: hash(input.requestBodyHash, "requestBodyHash"),
      requestBodyBytes: integer(input.requestBodyBytes, "requestBodyBytes", 1, 75 * 1024 * 1024),
    };
    return invoke("begin attempt", RPC.beginAttempt, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_request_id: expected.requestId,
      p_sync_token: syncToken,
    }, (value, operation) => {
      if (value?.sendAuthorized === false && !value?.dispatchId) {
        return validateRequest(value, operation, { workspaceKey, requestId: expected.requestId });
      }
      return validateDispatch(value, operation, expected);
    });
  }

  async function reconcileAttempt(input = {}) {
    const fields = lease(input);
    const providerResult = validateAttemptResult(input.providerResult);
    const requestId = text(input.requestId, "requestId", 100);
    if (providerResult.requestId !== requestId) {
      throw invalid("providerResult.requestId", "differs from requestId");
    }
    return invoke("reconcile attempt", RPC.reconcileAttempt, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_request_id: requestId,
      p_provider_result: providerResult,
      p_sync_token: syncToken,
    }, (value, operation) => validateRequest(value, operation, { workspaceKey, requestId }));
  }

  async function completeExtraction(input = {}) {
    const fields = lease(input);
    const requestId = text(input.requestId, "requestId", 100);
    return invoke("complete extraction", RPC.completeExtraction, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_request_id: requestId,
      p_decided_by: text(input.decidedBy || workerId, "decidedBy", 200),
      p_reason: text(
        input.reason || "Pinned model extraction recorded exact evidence from immutable attachment bytes.",
        "reason",
        2000,
      ),
      p_review_token: reviewToken,
      p_sync_token: syncToken,
    }, (value, operation) => {
      if (!isPlainObject(value) || value.ok !== true || typeof value.idempotent !== "boolean" ||
          value.schemaVersion !== "gmail-attachment-model-completion-receipt-v1" ||
          value.workspaceKey !== workspaceKey || value.jobId !== fields.p_job_id ||
          value.requestId !== requestId || !OBSERVATION_RE.test(String(value.observationId || "")) ||
          !UUID_RE.test(String(value.claimJobId || "")) ||
          value.decision !== "operational_evidence_recorded" ||
          value.shadowOnly !== true || value.mutatesOperationalState !== false ||
          value.productionPublicationAttempted !== false) {
        throw new TruthGmailAttachmentModelLedgerError(
          `${operation} returned an invalid atomic completion`,
          { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_LEDGER_INVALID_RECEIPT", operation },
        );
      }
      return deepFreeze(cloneJson(value, `${operation}.receipt`));
    });
  }

  return Object.freeze({
    workspaceKey,
    workerId,
    processorVersion,
    loadContext,
    adoptPrior,
    createRequest,
    reserveRequest,
    beginAttempt,
    reconcileAttempt,
    completeExtraction,
  });
}

module.exports = Object.freeze({
  RPC,
  TruthGmailAttachmentModelLedgerError,
  createTruthGmailAttachmentModelLedger,
  _test: Object.freeze({
    cloneJson,
    validateContext,
    validateAdoption,
    validateDispatch,
    validateRequest,
    validateRawObject,
  }),
});

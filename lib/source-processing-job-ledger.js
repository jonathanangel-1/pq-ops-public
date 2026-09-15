"use strict";

const RPC = Object.freeze({
  claim: "claim_source_processing_jobs",
  renew: "renew_source_processing_job_lease",
  complete: "complete_source_processing_job",
  completeGmailMessageRevisionMaterialization: "complete_gmail_message_revision_materialization",
  completeGmailMessageRevisionObligation: "complete_gmail_message_revision_obligation",
  fail: "fail_source_processing_job",
});
const DEFAULT_CLAIM_LOCK_RETRY_DELAYS_MS = Object.freeze([100, 300, 900]);
const HASH_RE = /^[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GMAIL_REVISION_OBLIGATION_REASONS = new Set([
  "PROVIDER_HISTORY_ID_MISSING",
  "PROVIDER_HISTORY_ID_MALFORMED",
  "PROVIDER_HISTORY_ID_AHEAD_OF_COMMITTED_CUT",
  "PROVIDER_HISTORY_ID_BEHIND_TRIGGER",
  "PROVIDER_MESSAGE_DELETED_UNAVAILABLE",
  "FETCH_POISON_QUARANTINED_REVIEW",
]);
const GMAIL_MATERIALIZATION_DISPOSITIONS = new Set([
  "first_materialized",
  "prior_exact_revision_reobserved",
]);
const GENERIC_COMPLETION_RECEIPT_KEYS = Object.freeze([
  "ok", "idempotent", "jobId", "state", "attemptCount", "leaseFence",
  "completionHash", "resultObservationIds", "childJobs", "rootBatchId",
  "sourceCursorVersion", "sourceCursorValue",
]);
const MATERIALIZATION_RECEIPT_KEYS = Object.freeze([
  ...GENERIC_COMPLETION_RECEIPT_KEYS,
  "materializationReceiptId", "materializationReceiptHash", "materializationDisposition",
  "materializationGroupId", "materializationGroupHash", "evidenceOwnerGroupId",
  "evidenceOwnerGroupHash", "evidenceOwnerSourceCursorVersion",
  "evidenceOwnerSourceCursorValue", "providerMessageHistoryId", "rawObservationId",
  "rawObservationContentHash", "parseJobId",
]);
const REVISION_OBLIGATION_RECEIPT_KEYS = Object.freeze([
  ...GENERIC_COMPLETION_RECEIPT_KEYS,
  "obligationId", "obligationHash", "reasonCode",
]);

class SourceProcessingJobLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "SourceProcessingJobLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new SourceProcessingJobLedgerError(`Invalid source-processing job argument ${field}: ${reason}`, {
    code: "SOURCE_PROCESSING_JOB_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, field, reason) {
  return new SourceProcessingJobLedgerError(`Invalid ${operation} receipt ${field}: ${reason}`, {
    code: "SOURCE_PROCESSING_JOB_INVALID_RECEIPT",
    operation,
    field,
  });
}

function invalidWriteReceipt(operation, field, reason) {
  const error = invalidReceipt(operation, field, reason);
  error.retryable = true;
  error.outcomeUnknown = true;
  error.receiptInvalid = true;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value, field, { allowEmpty = false, allowWhitespace = false, maxBytes = 8192 } = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (!allowWhitespace && value.trim() !== value) {
    throw invalidArgument(field, "must not contain surrounding whitespace");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalidArgument(field, "is too long");
  return value;
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function hash(value, field) {
  const result = string(value, field);
  if (!HASH_RE.test(result)) throw invalidArgument(field, "must be lowercase SHA-256 hex");
  return result;
}

function observationId(value, field) {
  const result = string(value, field);
  if (!OBSERVATION_ID_RE.test(result)) throw invalidArgument(field, "must be an obs:v1 SHA-256 identity");
  return result;
}

function uuid(value, field) {
  const result = string(value, field);
  if (!UUID_RE.test(result)) throw invalidArgument(field, "must be a UUID");
  return result;
}

function cloneJson(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = cloneJson(item, `${field}.${key}`);
    }
    return result;
  }
  throw invalidArgument(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeClaimLockRetryDelays(value) {
  if (!Array.isArray(value) || value.length > 5) {
    throw invalidArgument("claimLockRetryDelaysMs", "must be an array of at most five delays");
  }
  return value.map((delay, index) => integer(
    delay,
    `claimLockRetryDelaysMs[${index}]`,
    { minimum: 0, maximum: 10_000 },
  ));
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof SourceProcessingJobLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  let body = {};
  try {
    body = typeof cause.body === "string" ? JSON.parse(cause.body) : cause.body || {};
  } catch {
    body = {};
  }
  const code = String(cause.code || body.code || "SOURCE_PROCESSING_JOB_RPC_FAILED");
  const status = Number(cause.status ?? cause.statusCode);
  return new SourceProcessingJobLedgerError(`${operation} failed: ${cause.message}`, {
    code,
    operation,
    rpc,
    status: Number.isFinite(status) ? status : null,
    retryable: typeof cause.retryable === "boolean"
      ? cause.retryable
      : code === "40001" || status === 408 || status === 409 || status === 429 || status >= 500,
    deadlineExceeded: cause.deadlineExceeded === true,
    outcomeUnknown: cause.outcomeUnknown === true,
    cause,
  });
}

function receipt(value, operation) {
  if (!isPlainObject(value) || typeof value.ok !== "boolean") {
    throw invalidReceipt(operation, "result", "must be an object with boolean ok");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function requireReceiptExactKeys(value, expected, operation) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length
      || actual.some((key, index) => key !== required[index])) {
    throw invalidWriteReceipt(operation, "result", "must contain the exact receipt keys");
  }
}

function decimalString(value, field) {
  const result = string(value, field);
  if (!/^\d+$/.test(result)) throw invalidArgument(field, "must be an exact decimal string");
  return result;
}

function assertWriteReceipt(condition, operation, field, reason) {
  if (!condition) throw invalidWriteReceipt(operation, field, reason);
}

function normalizeRawObject(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  return {
    bucket: string(value.bucket, `${field}.bucket`),
    key: string(value.key, `${field}.key`),
    version: string(value.version ?? "", `${field}.version`, { allowEmpty: true }),
    etag: string(value.etag ?? "", `${field}.etag`, { allowEmpty: true }),
    hash: hash(value.hash, `${field}.hash`),
    bytes: integer(value.bytes, `${field}.bytes`),
    contentType: string(value.contentType ?? "application/octet-stream", `${field}.contentType`),
  };
}

function normalizeObservation(value, index) {
  const field = `observations[${index}]`;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  const operation = string(value.operation ?? "content", `${field}.operation`);
  if (!["content", "metadata_change", "delete"].includes(operation)) {
    throw invalidArgument(`${field}.operation`, "is unsupported");
  }
  const sourceFidelity = string(value.sourceFidelity ?? "normalized_source", `${field}.sourceFidelity`);
  if (!["raw", "normalized_source", "legacy_projection"].includes(sourceFidelity)) {
    throw invalidArgument(`${field}.sourceFidelity`, "is unsupported");
  }
  const normalized = {
    observationId: observationId(value.observationId, `${field}.observationId`),
    sourceObjectType: string(value.sourceObjectType, `${field}.sourceObjectType`),
    sourceObjectId: string(value.sourceObjectId, `${field}.sourceObjectId`),
    sourceRevision: string(value.sourceRevision ?? "", `${field}.sourceRevision`, { allowEmpty: true }),
    operation,
    contentHash: hash(value.contentHash, `${field}.contentHash`),
    normalizedPayload: cloneJson(value.normalizedPayload ?? {}, `${field}.normalizedPayload`),
    normalizedText: string(value.normalizedText ?? "", `${field}.normalizedText`, {
      allowEmpty: true,
      allowWhitespace: true,
      maxBytes: 16 * 1024 * 1024,
    }),
    sourceFidelity,
    schemaVersion: string(value.schemaVersion, `${field}.schemaVersion`),
    retentionClass: string(value.retentionClass ?? "shipment-operations", `${field}.retentionClass`),
  };
  if (value.sourceRecordedAt !== undefined && value.sourceRecordedAt !== null) {
    normalized.sourceRecordedAt = string(value.sourceRecordedAt, `${field}.sourceRecordedAt`, { allowEmpty: true });
  }
  const rawObject = normalizeRawObject(value.rawObject, `${field}.rawObject`);
  if (rawObject) normalized.rawObject = rawObject;
  return normalized;
}

function normalizeChildJob(value, index) {
  const field = `childJobs[${index}]`;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  return {
    dedupeKey: string(value.dedupeKey, `${field}.dedupeKey`),
    jobKind: string(value.jobKind, `${field}.jobKind`),
    observationId: observationId(value.observationId, `${field}.observationId`),
    sourceObjectId: string(value.sourceObjectId ?? "", `${field}.sourceObjectId`, { allowEmpty: true }),
    maxAttempts: integer(value.maxAttempts ?? 5, `${field}.maxAttempts`, { minimum: 1, maximum: 100 }),
    payload: cloneJson(value.payload ?? {}, `${field}.payload`),
  };
}

function safeErrorDetail(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function createSourceProcessingJobLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = string(options.workspaceKey ?? "primary", "workspaceKey");
  const sourceSystem = string(options.sourceSystem, "sourceSystem");
  const connectionKey = string(options.connectionKey, "connectionKey");
  const syncToken = string(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken");
  const rpcOptions = cloneJson(options.rpcOptions ?? {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");
  const claimLockRetryDelaysMs = normalizeClaimLockRetryDelays(
    options.claimLockRetryDelaysMs ?? DEFAULT_CLAIM_LOCK_RETRY_DELAYS_MS,
  );
  const waitForRetry = options.waitForRetry ?? wait;
  if (typeof waitForRetry !== "function") {
    throw invalidArgument("waitForRetry", "must be a function");
  }

  async function invoke(operation, rpc, body) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return receipt(value, operation);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function claimJobs(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("claimJobs", "must be an object");
    const workerId = string(input.workerId, "workerId");
    const processorVersion = string(input.processorVersion, "processorVersion");
    const limit = integer(input.limit ?? 10, "limit", { minimum: 1, maximum: 50 });
    const leaseSeconds = integer(input.leaseSeconds ?? 120, "leaseSeconds", { minimum: 30, maximum: 900 });
    const jobKinds = input.jobKinds === undefined || input.jobKinds === null
      ? []
      : Array.isArray(input.jobKinds)
        ? [...new Set(input.jobKinds.map((item, index) => string(item, `jobKinds[${index}]`)))].sort()
        : (() => { throw invalidArgument("jobKinds", "must be an array"); })();
    const body = {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_worker_id: workerId,
      p_processor_version: processorVersion,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
      p_job_kinds: jobKinds,
      p_sync_token: syncToken,
    };
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await invoke("claim source-processing jobs", RPC.claim, body);
        break;
      } catch (error) {
        const knownRolledBackLockFailure = error?.code === "55P03"
          && error?.outcomeUnknown !== true
          && error?.deadlineExceeded !== true;
        if (!knownRolledBackLockFailure || attempt >= claimLockRetryDelaysMs.length) {
          if (knownRolledBackLockFailure) error.retryable = true;
          throw error;
        }
        await waitForRetry(claimLockRetryDelaysMs[attempt]);
      }
    }
    if (!Array.isArray(result.jobs)) throw invalidReceipt("claim source-processing jobs", "jobs", "must be an array");
    if (!Number.isSafeInteger(result.claimedCount) || result.claimedCount !== result.jobs.length) {
      throw invalidReceipt("claim source-processing jobs", "claimedCount", "must equal jobs.length");
    }
    for (const [index, job] of result.jobs.entries()) {
      if (!isPlainObject(job)) throw invalidReceipt("claim source-processing jobs", `jobs[${index}]`, "must be an object");
      if (!UUID_RE.test(String(job.jobId || ""))) throw invalidReceipt("claim source-processing jobs", `jobs[${index}].jobId`, "must be a UUID");
      if (!Number.isSafeInteger(job.leaseFence) || job.leaseFence < 1) {
        throw invalidReceipt("claim source-processing jobs", `jobs[${index}].leaseFence`, "must be positive integer");
      }
      if (typeof job.sourceCursorValue !== "string") {
        throw invalidReceipt("claim source-processing jobs", `jobs[${index}].sourceCursorValue`, "must be a string");
      }
    }
    return result;
  }

  async function completeJob(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("completeJob", "must be an object");
    const observations = Array.isArray(input.observations)
      ? input.observations.map(normalizeObservation)
      : (() => { throw invalidArgument("observations", "must be an array"); })();
    const childJobs = Array.isArray(input.childJobs)
      ? input.childJobs.map(normalizeChildJob)
      : (() => { throw invalidArgument("childJobs", "must be an array"); })();
    return invoke("complete source-processing job", RPC.complete, {
      p_job_id: uuid(input.jobId, "jobId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_processor_version: string(input.processorVersion, "processorVersion"),
      p_result: cloneJson(input.result ?? {}, "result"),
      p_observations: observations,
      p_child_jobs: childJobs,
      p_sync_token: syncToken,
    });
  }

  async function renewJob(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("renewJob", "must be an object");
    return invoke("renew source-processing job lease", RPC.renew, {
      p_job_id: uuid(input.jobId, "jobId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_processor_version: string(input.processorVersion, "processorVersion"),
      p_lease_seconds: integer(input.leaseSeconds ?? 900, "leaseSeconds", {
        minimum: 30,
        maximum: 900,
      }),
      p_sync_token: syncToken,
    });
  }

  async function completeGmailMessageRevisionMaterialization(input = {}) {
    if (!isPlainObject(input)) {
      throw invalidArgument("completeGmailMessageRevisionMaterialization", "must be an object");
    }
    if (sourceSystem !== "gmail") {
      throw invalidArgument("sourceSystem", "must be gmail for message materialization");
    }
    const operation = "complete Gmail message-revision materialization";
    const jobId = uuid(input.jobId, "jobId");
    const workerId = string(input.workerId, "workerId");
    const leaseFence = integer(input.leaseFence, "leaseFence", { minimum: 1 });
    const processorVersion = string(input.processorVersion, "processorVersion");
    const resultValue = cloneJson(input.result, "result");
    if (!isPlainObject(resultValue)) throw invalidArgument("result", "must be an object");
    const expectedResultKeys = [
      "schemaVersion", "materializationGroupId", "messageId",
      "providerMessageHistoryId", "rawSha256", "rawBytes",
    ];
    if (Object.keys(resultValue).sort().join("|") !== expectedResultKeys.sort().join("|")) {
      throw invalidArgument("result", "must contain the exact materialization result keys");
    }
    if (resultValue.schemaVersion !== "gmail-message-revision-materialization-result-v1"
        || !/^gmail-materialization-group:v1:[0-9a-f]{64}$/.test(resultValue.materializationGroupId)
        || typeof resultValue.messageId !== "string" || !resultValue.messageId
        || !/^\d+$/.test(resultValue.providerMessageHistoryId)
        || !HASH_RE.test(resultValue.rawSha256)
        || !Number.isSafeInteger(resultValue.rawBytes) || resultValue.rawBytes < 1) {
      throw invalidArgument("result", "has invalid materialization result values");
    }
    const rawObservation = normalizeObservation(input.rawObservation, 0);
    const parseChild = normalizeChildJob(input.parseChild, 0);
    if (rawObservation.sourceObjectType !== "gmail_message_raw"
        || rawObservation.sourceObjectId !== resultValue.messageId
        || rawObservation.sourceRevision !== resultValue.providerMessageHistoryId
        || rawObservation.contentHash !== resultValue.rawSha256
        || rawObservation.schemaVersion !== "gmail-raw-message-v2"
        || rawObservation.rawObject?.hash !== resultValue.rawSha256
        || rawObservation.rawObject?.bytes !== resultValue.rawBytes
        || parseChild.jobKind !== "gmail_parse_rfc822"
        || parseChild.observationId !== rawObservation.observationId
        || parseChild.sourceObjectId !== resultValue.messageId
        || parseChild.payload?.providerMessageHistoryId !== resultValue.providerMessageHistoryId
        || parseChild.payload?.rawObservationId !== rawObservation.observationId
        || parseChild.payload?.rawObservationContentHash !== rawObservation.contentHash) {
      throw invalidArgument("materialization evidence", "does not match the provider revision result");
    }
    const value = await invoke(operation, RPC.completeGmailMessageRevisionMaterialization, {
      p_workspace_key: workspaceKey,
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_fence: leaseFence,
      p_processor_version: processorVersion,
      p_result: resultValue,
      p_raw_observation: rawObservation,
      p_parse_child: parseChild,
      p_sync_token: syncToken,
    });
    requireReceiptExactKeys(value, MATERIALIZATION_RECEIPT_KEYS, operation);
    const disposition = String(value.materializationDisposition || "");
    assertWriteReceipt(value.ok === true, operation, "ok", "must be true");
    assertWriteReceipt(value.jobId === jobId, operation, "jobId", "must equal the requested job");
    assertWriteReceipt(value.state === "succeeded", operation, "state", "must be succeeded");
    assertWriteReceipt(value.leaseFence === leaseFence, operation, "leaseFence", "must equal the fenced write");
    assertWriteReceipt(HASH_RE.test(String(value.completionHash || "")), operation,
      "completionHash", "must be lowercase SHA-256 hex");
    assertWriteReceipt(UUID_RE.test(String(value.rootBatchId || "")), operation,
      "rootBatchId", "must be a UUID");
    assertWriteReceipt(Number.isSafeInteger(value.sourceCursorVersion) && value.sourceCursorVersion > 0,
      operation, "sourceCursorVersion", "must be a positive integer");
    assertWriteReceipt(/^\d+$/.test(String(value.sourceCursorValue || "")), operation,
      "sourceCursorValue", "must be an exact decimal string");
    if (input.rootBatchId !== undefined) {
      assertWriteReceipt(value.rootBatchId === input.rootBatchId, operation,
        "rootBatchId", "does not match the claimed authority");
    }
    if (input.sourceCursorVersion !== undefined) {
      assertWriteReceipt(value.sourceCursorVersion === input.sourceCursorVersion, operation,
        "sourceCursorVersion", "does not match the claimed authority");
    }
    if (input.sourceCursorValue !== undefined) {
      assertWriteReceipt(value.sourceCursorValue === input.sourceCursorValue, operation,
        "sourceCursorValue", "does not match the claimed authority");
    }
    assertWriteReceipt(GMAIL_MATERIALIZATION_DISPOSITIONS.has(disposition), operation,
      "materializationDisposition", "is unsupported");
    for (const [idField, hashField, prefix] of [
      ["materializationReceiptId", "materializationReceiptHash", "gmail-materialization-receipt:v1:"],
      ["materializationGroupId", "materializationGroupHash", "gmail-materialization-group:v1:"],
      ["evidenceOwnerGroupId", "evidenceOwnerGroupHash", "gmail-materialization-group:v1:"],
    ]) {
      const digest = String(value[hashField] || "");
      assertWriteReceipt(HASH_RE.test(digest) && value[idField] === `${prefix}${digest}`,
        operation, idField, "must bind its exact hash");
    }
    assertWriteReceipt(value.materializationGroupId === resultValue.materializationGroupId,
      operation, "materializationGroupId", "does not match the result group");
    assertWriteReceipt(/^\d+$/.test(String(value.evidenceOwnerSourceCursorValue || ""))
        && Number.isSafeInteger(value.evidenceOwnerSourceCursorVersion)
        && value.evidenceOwnerSourceCursorVersion > 0,
    operation, "evidenceOwnerSourceCursorVersion", "has invalid owner chronology");
    assertWriteReceipt(value.providerMessageHistoryId === resultValue.providerMessageHistoryId,
      operation, "providerMessageHistoryId", "does not match the provider result");
    assertWriteReceipt(value.rawObservationId === rawObservation.observationId
        && value.rawObservationContentHash === rawObservation.contentHash,
    operation, "rawObservationId", "does not match the intrinsic raw evidence");
    assertWriteReceipt(UUID_RE.test(String(value.parseJobId || "")), operation,
      "parseJobId", "must be a UUID");
    assertWriteReceipt(Array.isArray(value.resultObservationIds)
        && value.resultObservationIds.length === 1
        && value.resultObservationIds[0] === rawObservation.observationId,
    operation, "resultObservationIds", "must contain the intrinsic raw observation");
    assertWriteReceipt(Array.isArray(value.childJobs), operation, "childJobs", "must be an array");
    if (disposition === "first_materialized") {
      assertWriteReceipt(value.childJobs.length === 1
          && value.childJobs[0]?.jobId === value.parseJobId,
      operation, "childJobs", "must contain the first parse child");
      assertWriteReceipt(value.evidenceOwnerGroupId === value.materializationGroupId
          && value.evidenceOwnerGroupHash === value.materializationGroupHash
          && value.evidenceOwnerSourceCursorVersion === value.sourceCursorVersion
          && value.evidenceOwnerSourceCursorValue === value.sourceCursorValue,
      operation, "evidenceOwnerGroupId", "must equal the first materialization group");
    } else {
      assertWriteReceipt(value.childJobs.length === 0, operation,
        "childJobs", "must be empty for prior exact reobservation");
      assertWriteReceipt(value.evidenceOwnerGroupId !== value.materializationGroupId
          && value.evidenceOwnerSourceCursorVersion < value.sourceCursorVersion,
      operation, "evidenceOwnerGroupId", "must be an earlier materialization group");
    }
    return value;
  }

  async function completeGmailMessageRevisionObligation(input = {}) {
    if (!isPlainObject(input)) {
      throw invalidArgument("completeGmailMessageRevisionObligation", "must be an object");
    }
    if (sourceSystem !== "gmail") {
      throw invalidArgument("sourceSystem", "must be gmail for a message-revision obligation");
    }
    const reasonCode = string(input.reasonCode, "reasonCode");
    if (!GMAIL_REVISION_OBLIGATION_REASONS.has(reasonCode)) {
      throw invalidArgument("reasonCode", "is not a supported Gmail revision-obligation reason");
    }
    const providerHistoryValue = input.providerHistoryValue === undefined
      ? null
      : cloneJson(input.providerHistoryValue, "providerHistoryValue");
    if (Buffer.byteLength(JSON.stringify(providerHistoryValue), "utf8") > 220) {
      throw invalidArgument("providerHistoryValue", "is too long");
    }
    const operation = "complete Gmail message-revision obligation";
    const jobId = uuid(input.jobId, "jobId");
    const leaseFence = integer(input.leaseFence, "leaseFence", { minimum: 1 });
    const result = await invoke(
      operation,
      RPC.completeGmailMessageRevisionObligation,
      {
        p_workspace_key: workspaceKey,
        p_job_id: jobId,
        p_worker_id: string(input.workerId, "workerId"),
        p_lease_fence: leaseFence,
        p_processor_version: string(input.processorVersion, "processorVersion"),
        p_reason_code: reasonCode,
        p_provider_history_value: providerHistoryValue,
        p_sync_token: syncToken,
      },
    );
    requireReceiptExactKeys(result, REVISION_OBLIGATION_RECEIPT_KEYS, operation);
    assertWriteReceipt(result.ok === true, operation, "ok", "must be true");
    assertWriteReceipt(result.jobId === jobId, operation, "jobId", "must equal the requested job");
    assertWriteReceipt(result.state === "succeeded", operation, "state", "must be succeeded");
    assertWriteReceipt(result.leaseFence === leaseFence, operation,
      "leaseFence", "must equal the fenced write");
    assertWriteReceipt(HASH_RE.test(String(result.completionHash || "")), operation,
      "completionHash", "must be lowercase SHA-256 hex");
    assertWriteReceipt(UUID_RE.test(String(result.rootBatchId || "")), operation,
      "rootBatchId", "must be a UUID");
    assertWriteReceipt(Number.isSafeInteger(result.sourceCursorVersion)
        && result.sourceCursorVersion > 0, operation,
    "sourceCursorVersion", "must be a positive integer");
    assertWriteReceipt(/^\d+$/.test(String(result.sourceCursorValue || "")), operation,
      "sourceCursorValue", "must be an exact decimal string");
    if (input.rootBatchId !== undefined) {
      assertWriteReceipt(result.rootBatchId === input.rootBatchId, operation,
        "rootBatchId", "does not match the claimed authority");
    }
    if (input.sourceCursorVersion !== undefined) {
      assertWriteReceipt(result.sourceCursorVersion === input.sourceCursorVersion, operation,
        "sourceCursorVersion", "does not match the claimed authority");
    }
    if (input.sourceCursorValue !== undefined) {
      assertWriteReceipt(result.sourceCursorValue === input.sourceCursorValue, operation,
        "sourceCursorValue", "does not match the claimed authority");
    }
    assertWriteReceipt(Array.isArray(result.resultObservationIds)
        && result.resultObservationIds.length === 0, operation,
    "resultObservationIds", "must be empty");
    assertWriteReceipt(Array.isArray(result.childJobs) && result.childJobs.length === 0,
      operation, "childJobs", "must be empty");
    if (!HASH_RE.test(String(result.obligationHash || ""))
        || result.obligationId
          !== `gmail-message-revision-obligation:v1:${result.obligationHash}`) {
      throw invalidWriteReceipt(
        operation,
        "obligationId",
        "must be a content-addressed Gmail revision obligation",
      );
    }
    if (result.reasonCode !== reasonCode) {
      throw invalidWriteReceipt(
        operation,
        "reasonCode",
        "must equal the requested reason",
      );
    }
    return result;
  }

  async function failJob(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("failJob", "must be an object");
    const detail = safeErrorDetail(input.safeErrorDetail);
    return invoke("fail source-processing job", RPC.fail, {
      p_job_id: uuid(input.jobId, "jobId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_processor_version: string(input.processorVersion, "processorVersion"),
      p_error_code: string(input.errorCode, "errorCode"),
      p_safe_error_detail: detail,
      p_retry_after_seconds: input.retryAfterSeconds === undefined || input.retryAfterSeconds === null
        ? null
        : integer(input.retryAfterSeconds, "retryAfterSeconds", { minimum: 1, maximum: 86400 }),
      p_sync_token: syncToken,
    });
  }

  return Object.freeze({
    scope: Object.freeze({ workspaceKey, sourceSystem, connectionKey }),
    claimJobs,
    renewJob,
    completeJob,
    completeGmailMessageRevisionMaterialization,
    completeGmailMessageRevisionObligation,
    failJob,
  });
}

module.exports = {
  RPC,
  DEFAULT_CLAIM_LOCK_RETRY_DELAYS_MS,
  GMAIL_MATERIALIZATION_DISPOSITIONS,
  GMAIL_REVISION_OBLIGATION_REASONS,
  SourceProcessingJobLedgerError,
  createSourceProcessingJobLedger,
  safeErrorDetail,
  _test: {
    cloneJson,
    normalizeChildJob,
    normalizeClaimLockRetryDelays,
    normalizeObservation,
    normalizeRpcError,
  },
};

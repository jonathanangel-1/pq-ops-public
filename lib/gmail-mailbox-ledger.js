"use strict";

const DEFAULT_WORKSPACE_KEY = "primary";
const DEFAULT_SOURCE_SYSTEM = "gmail";
const DEFAULT_CURSOR_KIND = "gmail_history_id";
const DEFAULT_LEASE_TTL_SECONDS = 120;

const RPC = Object.freeze({
  acquireLease: "acquire_source_sync_lease",
  renewLease: "renew_source_sync_lease",
  beginBatch: "begin_source_ingest_batch",
  appendPage: "append_gmail_ingest_page",
  commitBatch: "commit_source_ingest_batch",
  markHistoryExpired: "mark_gmail_history_expired",
});

const BATCH_MODES = new Set(["history", "backfill", "reconciliation", "snapshot"]);
const OBSERVATION_OPERATIONS = new Set(["content", "metadata_change", "delete"]);
const SOURCE_FIDELITIES = new Set(["raw", "normalized_source", "legacy_projection"]);

class GmailMailboxLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailMailboxLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailMailboxLedgerError(`Invalid Gmail mailbox ledger argument ${field}: ${reason}`, {
    code: "GMAIL_MAILBOX_LEDGER_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, rpc, field, reason) {
  return new GmailMailboxLedgerError(`Invalid ${rpc} receipt ${field}: ${reason}`, {
    code: "GMAIL_MAILBOX_LEDGER_INVALID_RECEIPT",
    operation,
    rpc,
    field,
  });
}

function requireString(value, field, options = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!options.allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (!options.allowWhitespace && value.trim() !== value) {
    throw invalidArgument(field, "must not have leading or trailing whitespace");
  }
  return value;
}

function optionalString(value, field, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return requireString(value, field, { allowEmpty: true });
}

function requireSafeInteger(value, field, options = {}) {
  if (!Number.isSafeInteger(value)) throw invalidArgument(field, "must be a safe integer");
  const minimum = options.minimum ?? 0;
  if (value < minimum) throw invalidArgument(field, `must be at least ${minimum}`);
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw invalidArgument(field, "must be a boolean");
  return value;
}

function requireHash(value, field) {
  const hash = requireString(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw invalidArgument(field, "must be a lowercase SHA-256 hex digest");
  return hash;
}

function requireObservationId(value, field) {
  const id = requireString(value, field);
  if (!/^obs:v1:[0-9a-f]{64}$/.test(id)) {
    throw invalidArgument(field, "must be an obs:v1 SHA-256 identity");
  }
  return id;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value, field) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJsonValue(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item, `${field}.${key}`)]),
    );
  }
  throw invalidArgument(field, "must contain only JSON-compatible values");
}

function requireRecord(value, field) {
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function parseRpcErrorBody(body) {
  if (isPlainObject(body)) return body;
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function inferRetryable(error, normalizedCode = "") {
  if (typeof error?.retryable === "boolean") return error.retryable;
  const status = Number(error?.status ?? error?.statusCode);
  const code = String(normalizedCode || error?.code || "");
  const message = String(error?.message || "");
  return code === "40001" || status === 408 || status === 409 || status === 429 || status >= 500 ||
    error?.name === "AbortError" || /\b(?:timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i.test(message);
}

function normalizeLedgerRpcError(error, context = {}) {
  if (error instanceof GmailMailboxLedgerError) return error;
  const original = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  const parsedBody = parseRpcErrorBody(original.body);
  const originalCode = original.code ?? parsedBody.code;
  const rpcCode = originalCode === undefined || originalCode === null || originalCode === ""
    ? "GMAIL_MAILBOX_LEDGER_RPC_FAILED"
    : String(originalCode);
  return new GmailMailboxLedgerError(
    `${context.operation || "mailbox ledger operation"} failed: ${original.message}`,
    {
      code: rpcCode,
      operation: context.operation || "",
      rpc: context.rpc || "",
      status: original.status,
      statusCode: original.statusCode,
      body: original.body,
      details: original.details ?? parsedBody.details,
      hint: original.hint ?? parsedBody.hint,
      retryable: typeof original.retryable === "boolean"
        ? original.retryable
        : inferRetryable(original, rpcCode),
      deadlineExceeded: original.deadlineExceeded === true,
      outcomeUnknown: original.outcomeUnknown === true,
      rpcMessage: original.message,
      cause: original,
    },
  );
}

function immutableReceipt(result, operation, rpc) {
  if (!isPlainObject(result)) throw invalidReceipt(operation, rpc, "result", "must be an object");
  if (typeof result.ok !== "boolean") throw invalidReceipt(operation, rpc, "ok", "must be a boolean");
  let receipt;
  try {
    receipt = cloneJsonValue(result, `${rpc}.receipt`);
  } catch (error) {
    if (error?.code === "GMAIL_MAILBOX_LEDGER_INVALID_ARGUMENT") {
      throw invalidReceipt(operation, rpc, error.field || "result", "must contain only JSON-compatible values");
    }
    throw error;
  }
  return deepFreeze(receipt);
}

function assertReceiptString(receipt, operation, rpc, field, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
    if (options.optional) return;
    throw invalidReceipt(operation, rpc, field, "is required");
  }
  if (typeof receipt[field] !== "string") {
    throw invalidReceipt(operation, rpc, field, "must be a string; numeric Gmail IDs are forbidden");
  }
  if (!options.allowEmpty && receipt[field].length === 0) {
    throw invalidReceipt(operation, rpc, field, "must not be empty");
  }
}

function assertReceiptInteger(receipt, operation, rpc, field, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
    if (options.optional) return;
    throw invalidReceipt(operation, rpc, field, "is required");
  }
  if (!Number.isSafeInteger(receipt[field]) || receipt[field] < (options.minimum ?? 0)) {
    throw invalidReceipt(operation, rpc, field, "must be a non-negative safe integer");
  }
}

function assertMaterializationRoutes(receipt, operation, rpc) {
  const routes = receipt.materializationRoutes;
  if (!isPlainObject(routes)) {
    throw invalidReceipt(operation, rpc, "materializationRoutes", "must be an object");
  }
  const expectedKeys = [
    "ok", "idempotent", "sealId", "sealHash", "routeManifestHash",
    "routeCount", "materializationCount", "deletedCount",
  ].sort();
  const actualKeys = Object.keys(routes).sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw invalidReceipt(operation, rpc, "materializationRoutes", "must contain the exact route receipt keys");
  }
  if (routes.ok !== true || typeof routes.idempotent !== "boolean") {
    throw invalidReceipt(operation, rpc, "materializationRoutes.ok", "must be true with boolean idempotent");
  }
  for (const field of ["sealHash", "routeManifestHash"]) {
    if (typeof routes[field] !== "string" || !/^[0-9a-f]{64}$/.test(routes[field])) {
      throw invalidReceipt(operation, rpc, `materializationRoutes.${field}`, "must be lowercase SHA-256 hex");
    }
  }
  if (routes.sealId !== `gmail-materialization-route-seal:v1:${routes.sealHash}`) {
    throw invalidReceipt(operation, rpc, "materializationRoutes.sealId", "must bind the exact seal hash");
  }
  for (const field of ["routeCount", "materializationCount", "deletedCount"]) {
    if (!Number.isSafeInteger(routes[field]) || routes[field] < 0) {
      throw invalidReceipt(operation, rpc, `materializationRoutes.${field}`, "must be a non-negative integer");
    }
  }
  if (routes.routeCount !== routes.materializationCount + routes.deletedCount) {
    throw invalidReceipt(operation, rpc, "materializationRoutes.routeCount", "must equal materialized plus deleted routes");
  }
}

function normalizePage(pageInput) {
  const page = requireRecord(pageInput, "page");
  const providerResponse = cloneJsonValue(page.providerResponse, "page.providerResponse");
  const providerEvents = cloneJsonValue(page.providerEvents, "page.providerEvents");
  if (!isPlainObject(providerResponse)) throw invalidArgument("page.providerResponse", "must be an object");
  if (!Array.isArray(providerEvents)) throw invalidArgument("page.providerEvents", "must be an array");
  return {
    pageOrdinal: requireSafeInteger(page.pageOrdinal, "page.pageOrdinal"),
    requestPageToken: optionalString(page.requestPageToken, "page.requestPageToken"),
    responseNextPageToken: optionalString(page.responseNextPageToken, "page.responseNextPageToken"),
    responseMailboxHistoryId: requireString(
      page.responseMailboxHistoryId,
      "page.responseMailboxHistoryId",
    ),
    firstHistoryId: optionalString(page.firstHistoryId, "page.firstHistoryId"),
    lastHistoryId: optionalString(page.lastHistoryId, "page.lastHistoryId"),
    eventDigest: requireHash(page.eventDigest, "page.eventDigest"),
    providerResponse,
    providerEvents,
    isFinal: requireBoolean(page.isFinal, "page.isFinal"),
  };
}

function normalizeObservation(input, index) {
  const observation = requireRecord(input, `observations[${index}]`);
  const operation = optionalString(observation.operation, `observations[${index}].operation`, "content");
  if (!OBSERVATION_OPERATIONS.has(operation)) {
    throw invalidArgument(`observations[${index}].operation`, "is not a supported observation operation");
  }
  const sourceFidelity = optionalString(
    observation.sourceFidelity,
    `observations[${index}].sourceFidelity`,
    "normalized_source",
  );
  if (!SOURCE_FIDELITIES.has(sourceFidelity)) {
    throw invalidArgument(`observations[${index}].sourceFidelity`, "is not a supported source fidelity");
  }
  const normalized = {
    observationId: requireObservationId(observation.observationId, `observations[${index}].observationId`),
    sourceObjectType: requireString(observation.sourceObjectType, `observations[${index}].sourceObjectType`),
    sourceObjectId: requireString(observation.sourceObjectId, `observations[${index}].sourceObjectId`),
    sourceRevision: optionalString(observation.sourceRevision, `observations[${index}].sourceRevision`),
    operation,
    contentHash: requireHash(observation.contentHash, `observations[${index}].contentHash`),
    normalizedPayload: cloneJsonValue(observation.normalizedPayload ?? {}, `observations[${index}].normalizedPayload`),
    normalizedText: optionalString(observation.normalizedText, `observations[${index}].normalizedText`),
    sourceFidelity,
    schemaVersion: optionalString(
      observation.schemaVersion,
      `observations[${index}].schemaVersion`,
      "source-observation-v1",
    ),
  };
  if (observation.sourceRecordedAt !== undefined && observation.sourceRecordedAt !== null) {
    normalized.sourceRecordedAt = requireString(
      observation.sourceRecordedAt,
      `observations[${index}].sourceRecordedAt`,
      { allowEmpty: true },
    );
  }
  if (observation.capturedAt !== undefined && observation.capturedAt !== null) {
    normalized.capturedAt = requireString(observation.capturedAt, `observations[${index}].capturedAt`);
  }
  return normalized;
}

function normalizeJob(input, index) {
  const job = requireRecord(input, `jobs[${index}]`);
  const normalized = {
    dedupeKey: requireString(job.dedupeKey, `jobs[${index}].dedupeKey`),
    jobKind: requireString(job.jobKind, `jobs[${index}].jobKind`),
    sourceObjectId: optionalString(job.sourceObjectId, `jobs[${index}].sourceObjectId`),
    maxAttempts: job.maxAttempts === undefined
      ? 5
      : requireSafeInteger(job.maxAttempts, `jobs[${index}].maxAttempts`, { minimum: 1 }),
    payload: cloneJsonValue(job.payload ?? {}, `jobs[${index}].payload`),
  };
  if (job.observationId !== undefined && job.observationId !== null && job.observationId !== "") {
    normalized.observationId = requireObservationId(job.observationId, `jobs[${index}].observationId`);
  } else {
    normalized.observationId = "";
  }
  return normalized;
}

function createGmailMailboxLedger(inputOptions = {}) {
  const options = requireRecord(inputOptions, "options");
  const workspaceKey = requireString(options.workspaceKey ?? DEFAULT_WORKSPACE_KEY, "workspaceKey");
  const sourceSystem = requireString(options.sourceSystem ?? DEFAULT_SOURCE_SYSTEM, "sourceSystem");
  if (sourceSystem !== "gmail") throw invalidArgument("sourceSystem", "must be gmail");
  const connectionKey = requireString(options.connectionKey, "connectionKey");
  const syncToken = requireString(
    options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "",
    "syncToken",
  );
  const rpcOptions = cloneJsonValue(options.rpcOptions ?? {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");

  async function invoke(operation, rpc, body, validateReceipt) {
    let result;
    try {
      result = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeLedgerRpcError(error, { operation, rpc });
    }
    try {
      const receipt = immutableReceipt(result, operation, rpc);
      validateReceipt(receipt);
      return receipt;
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function acquireLease(input = {}) {
    input = requireRecord(input, "acquireLease input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const ttlSeconds = input.ttlSeconds === undefined
      ? DEFAULT_LEASE_TTL_SECONDS
      : requireSafeInteger(input.ttlSeconds, "ttlSeconds", { minimum: 15 });
    if (ttlSeconds > 900) throw invalidArgument("ttlSeconds", "must not exceed 900");
    const cursorKind = requireString(input.cursorKind ?? DEFAULT_CURSOR_KIND, "cursorKind");
    return invoke("acquire lease", RPC.acquireLease, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_ttl_seconds: ttlSeconds,
      p_cursor_kind: cursorKind,
      p_sync_token: syncToken,
    }, (receipt) => {
      assertReceiptString(receipt, "acquire lease", RPC.acquireLease, "cursorValue", { allowEmpty: true });
      assertReceiptString(receipt, "acquire lease", RPC.acquireLease, "recoveryAnchorValue", {
        allowEmpty: true,
        optional: true,
      });
      assertReceiptInteger(receipt, "acquire lease", RPC.acquireLease, "cursorVersion");
      if (receipt.ok) assertReceiptInteger(receipt, "acquire lease", RPC.acquireLease, "leaseFence", { minimum: 1 });
      if (!receipt.ok) assertReceiptString(receipt, "acquire lease", RPC.acquireLease, "code");
    });
  }

  async function renewLease(input = {}) {
    input = requireRecord(input, "renewLease input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireSafeInteger(input.leaseFence, "leaseFence", { minimum: 1 });
    const ttlSeconds = input.ttlSeconds === undefined
      ? DEFAULT_LEASE_TTL_SECONDS
      : requireSafeInteger(input.ttlSeconds, "ttlSeconds", { minimum: 15 });
    if (ttlSeconds > 900) throw invalidArgument("ttlSeconds", "must not exceed 900");
    return invoke("renew lease", RPC.renewLease, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_ttl_seconds: ttlSeconds,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (receipt.ok) assertReceiptInteger(receipt, "renew lease", RPC.renewLease, "leaseFence", { minimum: 1 });
    });
  }

  async function beginBatch(input = {}) {
    input = requireRecord(input, "beginBatch input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireSafeInteger(input.leaseFence, "leaseFence", { minimum: 1 });
    const mode = requireString(input.mode, "mode");
    if (!BATCH_MODES.has(mode)) throw invalidArgument("mode", "is not a supported ingest mode");
    const triggerName = optionalString(input.triggerName, "triggerName");
    return invoke("begin batch", RPC.beginBatch, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_mode: mode,
      p_trigger_name: triggerName,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) return;
      assertReceiptString(receipt, "begin batch", RPC.beginBatch, "batchId");
      assertReceiptString(receipt, "begin batch", RPC.beginBatch, "startCursorValue", { allowEmpty: true });
      assertReceiptInteger(receipt, "begin batch", RPC.beginBatch, "startCursorVersion");
      assertReceiptInteger(receipt, "begin batch", RPC.beginBatch, "pageCount");
      assertReceiptString(receipt, "begin batch", RPC.beginBatch, "resumePageToken", { allowEmpty: true });
      assertReceiptString(receipt, "begin batch", RPC.beginBatch, "responseMailboxHistoryId", { allowEmpty: true });
      assertReceiptString(receipt, "begin batch", RPC.beginBatch, "recoveryAnchorValue", {
        allowEmpty: true,
        optional: true,
      });
      if (typeof receipt.finalPagePersisted !== "boolean") {
        throw invalidReceipt("begin batch", RPC.beginBatch, "finalPagePersisted", "must be a boolean");
      }
    });
  }

  async function appendPage(input = {}) {
    input = requireRecord(input, "appendPage input");
    const batchId = requireString(input.batchId, "batchId");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireSafeInteger(input.leaseFence, "leaseFence", { minimum: 1 });
    if (!Array.isArray(input.observations)) throw invalidArgument("observations", "must be an array");
    if (!Array.isArray(input.jobs)) throw invalidArgument("jobs", "must be an array");
    if (input.jobs.length !== 0) {
      throw invalidArgument("jobs", "must be empty; committed-root routing is server-authored");
    }
    const page = normalizePage(input.page);
    const observations = input.observations.map(normalizeObservation);
    const jobs = input.jobs.map(normalizeJob);
    return invoke("append Gmail page", RPC.appendPage, {
      p_batch_id: batchId,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_page: page,
      p_observations: observations,
      p_jobs: jobs,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) return;
      assertReceiptString(receipt, "append Gmail page", RPC.appendPage, "batchId");
      assertReceiptInteger(receipt, "append Gmail page", RPC.appendPage, "pageOrdinal");
      if (receipt.batchId !== batchId) {
        throw invalidReceipt("append Gmail page", RPC.appendPage, "batchId", "must match the requested batch");
      }
      if (receipt.pageOrdinal !== page.pageOrdinal) {
        throw invalidReceipt("append Gmail page", RPC.appendPage, "pageOrdinal", "must match the requested page");
      }
      assertReceiptString(receipt, "append Gmail page", RPC.appendPage, "eventDigest");
      if (!/^[0-9a-f]{64}$/.test(receipt.eventDigest)) {
        throw invalidReceipt("append Gmail page", RPC.appendPage, "eventDigest", "must be a lowercase SHA-256 hex digest");
      }
      assertReceiptInteger(receipt, "append Gmail page", RPC.appendPage, "observationCount");
      assertReceiptInteger(receipt, "append Gmail page", RPC.appendPage, "jobCount");
    });
  }

  async function commitBatch(input = {}) {
    input = requireRecord(input, "commitBatch input");
    const batchId = requireString(input.batchId, "batchId");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireSafeInteger(input.leaseFence, "leaseFence", { minimum: 1 });
    return invoke("commit cursor", RPC.commitBatch, {
      p_batch_id: batchId,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) return;
      assertReceiptString(receipt, "commit cursor", RPC.commitBatch, "batchId");
      if (receipt.batchId !== batchId) {
        throw invalidReceipt("commit cursor", RPC.commitBatch, "batchId", "must match the requested batch");
      }
      assertReceiptString(receipt, "commit cursor", RPC.commitBatch, "batchHash");
      if (!/^[0-9a-f]{64}$/.test(receipt.batchHash)) {
        throw invalidReceipt("commit cursor", RPC.commitBatch, "batchHash", "must be a lowercase SHA-256 hex digest");
      }
      assertReceiptString(receipt, "commit cursor", RPC.commitBatch, "committedCursorValue");
      assertReceiptInteger(receipt, "commit cursor", RPC.commitBatch, "committedCursorVersion");
      assertReceiptInteger(receipt, "commit cursor", RPC.commitBatch, "pageCount");
      assertReceiptInteger(receipt, "commit cursor", RPC.commitBatch, "observationCount");
      assertReceiptInteger(receipt, "commit cursor", RPC.commitBatch, "jobCount");
      if (receipt.jobCount !== 0) {
        throw invalidReceipt("commit cursor", RPC.commitBatch, "jobCount", "must be zero for observations-only Gmail pages");
      }
      assertMaterializationRoutes(receipt, "commit cursor", RPC.commitBatch);
    });
  }

  async function markHistoryExpired(input = {}) {
    input = requireRecord(input, "markHistoryExpired input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireSafeInteger(input.leaseFence, "leaseFence", { minimum: 1 });
    const priorCursorValue = requireString(input.priorCursorValue, "priorCursorValue");
    const recoveryAnchorValue = requireString(input.recoveryAnchorValue, "recoveryAnchorValue");
    const detail = cloneJsonValue(input.detail ?? {}, "detail");
    if (!isPlainObject(detail)) throw invalidArgument("detail", "must be an object");
    return invoke("mark Gmail history expired", RPC.markHistoryExpired, {
      p_workspace_key: workspaceKey,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_prior_cursor_value: priorCursorValue,
      p_recovery_anchor_value: recoveryAnchorValue,
      p_detail: detail,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) return;
      assertReceiptString(receipt, "mark Gmail history expired", RPC.markHistoryExpired, "gapId");
      assertReceiptString(receipt, "mark Gmail history expired", RPC.markHistoryExpired, "cursorValue");
      assertReceiptInteger(receipt, "mark Gmail history expired", RPC.markHistoryExpired, "cursorVersion");
      assertReceiptString(receipt, "mark Gmail history expired", RPC.markHistoryExpired, "recoveryAnchorValue");
      assertReceiptString(receipt, "mark Gmail history expired", RPC.markHistoryExpired, "status");
    });
  }

  return Object.freeze({
    scope: deepFreeze({ workspaceKey, sourceSystem, connectionKey, cursorKind: DEFAULT_CURSOR_KIND }),
    acquireLease,
    renewLease,
    beginBatch,
    appendPage,
    commitBatch,
    markHistoryExpired,
  });
}

module.exports = {
  DEFAULT_CURSOR_KIND,
  DEFAULT_LEASE_TTL_SECONDS,
  GmailMailboxLedgerError,
  RPC,
  createGmailMailboxLedger,
  normalizeLedgerRpcError,
  _test: {
    immutableReceipt,
    normalizeJob,
    normalizeObservation,
    normalizePage,
  },
};

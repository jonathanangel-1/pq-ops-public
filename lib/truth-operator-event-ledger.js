"use strict";

const RPC = Object.freeze({ record: "record_operator_truth_event" });
const DEFAULT_WORKSPACE_KEY = "primary";
const DEFAULT_CONNECTION_KEY = "operator-phone-primary";
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const REQUEST_ID_RE = /^operator-request:v1:[0-9a-f]{64}$/;
const EVENT_ID_RE = /^operator-event:v1:[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class TruthOperatorEventLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthOperatorEventLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthOperatorEventLedgerError(`Invalid operator-event ledger ${field}: ${reason}`, {
    code: "TRUTH_OPERATOR_EVENT_LEDGER_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, { maxBytes = 8192 } = {}) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 24) throw invalid(field, "exceeds maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalid(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) output[key] = cloneJson(value[key], `${field}.${key}`, depth + 1);
    }
    return output;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalTimestamp(value) {
  return typeof value === "string"
    && TIMESTAMP_RE.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateReceipt(value, scope) {
  if (!isPlainObject(value)
      || value.ok !== true
      || value.schemaVersion !== "truth-operator-event-receipt-v1"
      || value.status !== "recorded"
      || value.workspaceKey !== scope.workspaceKey
      || value.sourceSystem !== "operator"
      || value.connectionKey !== scope.connectionKey
      || !REQUEST_ID_RE.test(String(value.requestId || ""))
      || !HASH_RE.test(String(value.requestHash || ""))
      || !EVENT_ID_RE.test(String(value.eventId || ""))
      || !/^[1-9][0-9]{0,15}$/.test(String(value.eventSequence || ""))
      || Number(value.eventSequence) > Number.MAX_SAFE_INTEGER
      || !OBSERVATION_ID_RE.test(String(value.observationId || ""))
      || !UUID_RE.test(String(value.jobId || ""))
      || !UUID_RE.test(String(value.batchId || ""))
      || !Number.isSafeInteger(value.sourceCursorVersion)
      || value.sourceCursorVersion < 1
      || !canonicalTimestamp(value.capturedAt)
      || value.mutatesOperationalState !== false
      || value.reducesTruth !== false
      || value.publishesTruth !== false) {
    throw new TruthOperatorEventLedgerError("Operator-event RPC returned an invalid receipt", {
      code: "TRUTH_OPERATOR_EVENT_LEDGER_INVALID_RECEIPT",
    });
  }
  return deepFreeze(cloneJson(value, "receipt"));
}

function normalizeError(error, operation) {
  if (error instanceof TruthOperatorEventLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown operator-event RPC failure"));
  const status = Number(cause.status ?? cause.statusCode);
  const code = String(cause.code || "TRUTH_OPERATOR_EVENT_RPC_FAILED");
  const transportFailure = status === 408 || status === 429 || status >= 500
    || /\b(?:timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up)\b/i.test(cause.message);
  return new TruthOperatorEventLedgerError(`${operation} failed: ${cause.message}`, {
    code,
    operation,
    status: Number.isFinite(status) ? status : null,
    retryable: typeof cause.retryable === "boolean"
      ? cause.retryable
      : code === "40001" || transportFailure,
    deadlineExceeded: cause.deadlineExceeded === true,
    outcomeUnknown: cause.outcomeUnknown === true || transportFailure,
    safeToRetryWithSameIdempotencyKey: true,
    cause,
  });
}

function createTruthOperatorEventLedger(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || DEFAULT_WORKSPACE_KEY, "workspaceKey", { maxBytes: 128 });
  const connectionKey = text(options.connectionKey || DEFAULT_CONNECTION_KEY, "connectionKey", { maxBytes: 200 });
  const syncToken = text(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", {
    maxBytes: 4096,
  });
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalid("callRpc", "must be a function");
  const rpcOptions = options.rpcOptions === undefined
    ? {}
    : cloneJson(options.rpcOptions, "rpcOptions");
  if (!isPlainObject(rpcOptions)) throw invalid("rpcOptions", "must be an object");
  const scope = deepFreeze({ workspaceKey, sourceSystem: "operator", connectionKey });

  async function record(input = {}) {
    if (!isPlainObject(input)) throw invalid("record", "must be an object");
    const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", { maxBytes: 128 });
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw invalid("idempotencyKey", "must be 32-128 base64url characters");
    }
    if (!isPlainObject(input.request)) throw invalid("request", "must be an object");
    const request = cloneJson(input.request, "request");
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > 32768) {
      throw invalid("request", "must not exceed 32 KiB");
    }
    let receipt;
    try {
      receipt = await callRpc(RPC.record, {
        p_workspace_key: workspaceKey,
        p_connection_key: connectionKey,
        p_idempotency_key: idempotencyKey,
        p_request: request,
        p_sync_token: syncToken,
      }, rpcOptions);
    } catch (error) {
      throw normalizeError(error, "record operator truth event");
    }
    try {
      return validateReceipt(receipt, scope);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      error.safeToRetryWithSameIdempotencyKey = true;
      throw error;
    }
  }

  return Object.freeze({ scope, record });
}

module.exports = Object.freeze({
  DEFAULT_CONNECTION_KEY,
  DEFAULT_WORKSPACE_KEY,
  IDEMPOTENCY_KEY_RE,
  RPC,
  TruthOperatorEventLedgerError,
  createTruthOperatorEventLedger,
  _test: Object.freeze({ cloneJson, normalizeError, validateReceipt }),
});

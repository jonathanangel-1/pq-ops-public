"use strict";

const RPC = Object.freeze({
  issue: "issue_truth_tracking_scope",
  read: "read_truth_tracking_scope",
});
const TOKEN_RE = /^tracking-scope:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const AWB_RE = /^[0-9]{11}$/;

class TruthTrackingScopeLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthTrackingScopeLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthTrackingScopeLedgerError(`Invalid tracking scope ${field}: ${reason}`, {
    code: "TRUTH_TRACKING_SCOPE_INVALID_ARGUMENT",
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
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw invalid(`${field}.${key}`, "is forbidden");
      if (value[key] !== undefined) result[key] = cloneJson(value[key], `${field}.${key}`, depth + 1);
    }
    return result;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateReceipt(value) {
  if (!isPlainObject(value) || value.ok !== true
      || value.schemaVersion !== "truth-tracking-scope-receipt-v1"
      || !TOKEN_RE.test(String(value.scopeToken || ""))
      || !HASH_RE.test(String(value.expectedAwbsHash || ""))
      || !Array.isArray(value.expectedAwbs)
      || value.expectedAwbCount !== value.expectedAwbs.length
      || !Number.isSafeInteger(value.tmsCursorVersion) || value.tmsCursorVersion < 0
      || !Number.isFinite(Date.parse(String(value.issuedAt || "")))
      || !Number.isFinite(Date.parse(String(value.expiresAt || "")))
      || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    throw new TruthTrackingScopeLedgerError("Tracking scope RPC returned an invalid receipt", {
      code: "TRUTH_TRACKING_SCOPE_INVALID_RECEIPT",
    });
  }
  const expected = [...new Set(value.expectedAwbs)];
  if (expected.length !== value.expectedAwbs.length
      || expected.some((awb) => !AWB_RE.test(awb))
      || JSON.stringify([...expected].sort()) !== JSON.stringify(value.expectedAwbs)) {
    throw new TruthTrackingScopeLedgerError("Tracking scope AWBs are not exact, sorted, and unique", {
      code: "TRUTH_TRACKING_SCOPE_INVALID_RECEIPT",
    });
  }
  for (const field of ["workspaceKey", "tmsConnectionKey", "trackingConnectionKey", "tmsCursorValue"]) {
    text(value[field], `receipt.${field}`);
  }
  return deepFreeze(cloneJson(value, "receipt"));
}

function normalizeError(error, operation) {
  if (error instanceof TruthTrackingScopeLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown tracking scope failure"));
  const status = Number(cause.status ?? cause.statusCode);
  const code = String(cause.code || "TRUTH_TRACKING_SCOPE_RPC_FAILED");
  return new TruthTrackingScopeLedgerError(`${operation} failed: ${cause.message}`, {
    code,
    operation,
    status: Number.isFinite(status) ? status : null,
    retryable: typeof cause.retryable === "boolean"
      ? cause.retryable
      : code === "40001" || status === 408 || status === 409 || status === 429 || status >= 500,
    deadlineExceeded: cause.deadlineExceeded === true,
    outcomeUnknown: cause.outcomeUnknown === true,
    cause,
  });
}

function createTruthTrackingScopeLedger(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || "primary", "workspaceKey", { maxBytes: 128 });
  const syncToken = text(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", { maxBytes: 4096 });
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalid("callRpc", "must be a function");
  const rpcOptions = isPlainObject(options.rpcOptions) ? cloneJson(options.rpcOptions, "rpcOptions") : {};

  async function invoke(operation, rpc, body) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeError(error, operation);
    }
    try {
      return validateReceipt(value);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function issue(input = {}) {
    if (!isPlainObject(input)) throw invalid("issue", "must be an object");
    const ttlSeconds = input.ttlSeconds ?? 900;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
      throw invalid("ttlSeconds", "must be an integer from 60 through 3600");
    }
    return invoke("issue tracking scope", RPC.issue, {
      p_workspace_key: workspaceKey,
      p_ttl_seconds: ttlSeconds,
      p_issued_by: text(input.issuedBy, "issuedBy", { maxBytes: 500 }),
      p_sync_token: syncToken,
    });
  }

  async function read(input = {}) {
    if (!isPlainObject(input)) throw invalid("read", "must be an object");
    const scopeToken = text(input.scopeToken, "scopeToken");
    if (!TOKEN_RE.test(scopeToken)) throw invalid("scopeToken", "is not a tracking-scope:v1 identity");
    return invoke("read tracking scope", RPC.read, {
      p_workspace_key: workspaceKey,
      p_scope_token: scopeToken,
      p_sync_token: syncToken,
    });
  }

  return Object.freeze({ workspaceKey, issue, read });
}

module.exports = Object.freeze({
  RPC,
  TruthTrackingScopeLedgerError,
  createTruthTrackingScopeLedger,
  _test: Object.freeze({ normalizeError, validateReceipt }),
});

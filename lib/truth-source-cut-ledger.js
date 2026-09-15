"use strict";

const RPC = Object.freeze({ sealCurrent: "seal_current_source_cut" });
const CUT_ID_RE = /^cut:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

class TruthSourceCutLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthSourceCutLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthSourceCutLedgerError(`Invalid truth source-cut ${field}: ${reason}`, {
    code: "TRUTH_SOURCE_CUT_INVALID_ARGUMENT",
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

function parseBody(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeError(error, operation) {
  if (error instanceof TruthSourceCutLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown source-cut RPC failure"));
  const body = parseBody(cause.body);
  const status = Number(cause.status ?? cause.statusCode);
  const code = String(cause.code || body.code || "TRUTH_SOURCE_CUT_RPC_FAILED");
  return new TruthSourceCutLedgerError(`${operation} failed: ${cause.message}`, {
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

function validateReceipt(value) {
  if (!isPlainObject(value) || value.ok !== true
      || !["sealed", "not_ready"].includes(value.status)
      || !["complete", "degraded"].includes(value.completeness)
      || !Array.isArray(value.gaps)
      || !Number.isSafeInteger(value.observationCount) || value.observationCount < 0) {
    throw new TruthSourceCutLedgerError("Source-cut coordinator returned an invalid receipt", {
      code: "TRUTH_SOURCE_CUT_INVALID_RECEIPT",
    });
  }
  if (value.status === "not_ready") {
    if (value.sourceCutId !== null || value.manifestHash !== null || value.manifest !== null
        || value.completeness !== "degraded" || value.gaps.length === 0) {
      throw new TruthSourceCutLedgerError("Not-ready source-cut receipt is not fail-closed", {
        code: "TRUTH_SOURCE_CUT_INVALID_RECEIPT",
      });
    }
  } else {
    if (!CUT_ID_RE.test(String(value.sourceCutId || ""))
        || !HASH_RE.test(String(value.manifestHash || ""))
        || value.sourceCutId !== `cut:v1:${value.manifestHash}`
        || !isPlainObject(value.manifest)
        || value.manifest.schemaVersion !== "source-cut-manifest-v2"
        || Object.prototype.hasOwnProperty.call(value.manifest, "observations")) {
      throw new TruthSourceCutLedgerError("Sealed source-cut receipt identity is invalid", {
        code: "TRUTH_SOURCE_CUT_INVALID_RECEIPT",
      });
    }
    if ((value.completeness === "complete") !== (value.gaps.length === 0)) {
      throw new TruthSourceCutLedgerError("Sealed source-cut completeness disagrees with its gaps", {
        code: "TRUTH_SOURCE_CUT_INVALID_RECEIPT",
      });
    }
  }
  return deepFreeze(cloneJson(value, "receipt"));
}

function createTruthSourceCutLedger(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || "primary", "workspaceKey", { maxBytes: 128 });
  const syncToken = text(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", {
    maxBytes: 4096,
  });
  const rpcOptions = cloneJson(options.rpcOptions || {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalid("callRpc", "must be a function");

  async function sealCurrent(input = {}) {
    if (!isPlainObject(input)) throw invalid("sealCurrent", "must be an object");
    const createdBy = text(input.createdBy, "createdBy", { maxBytes: 500 });
    let value;
    try {
      value = await callRpc(RPC.sealCurrent, {
        p_workspace_key: workspaceKey,
        p_created_by: createdBy,
        p_sync_token: syncToken,
      }, rpcOptions);
    } catch (error) {
      throw normalizeError(error, "seal current source cut");
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

  return Object.freeze({ workspaceKey, sealCurrent });
}

module.exports = Object.freeze({
  RPC,
  TruthSourceCutLedgerError,
  createTruthSourceCutLedger,
  _test: Object.freeze({ normalizeError, validateReceipt }),
});

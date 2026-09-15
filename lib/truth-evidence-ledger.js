"use strict";

const RPC = Object.freeze({
  appendAcceptedClaim: "append_accepted_claim",
  appendEntityLink: "append_observation_entity_link",
  appendWorkgroupMembership: "append_operational_workgroup_membership",
});
const HASH_RE = /^[0-9a-f]{64}$/;
const IDENTITIES = Object.freeze({
  claimVersionId: /^claim:v1:[0-9a-f]{64}$/,
  linkVersionId: /^link:v1:[0-9a-f]{64}$/,
  workgroupId: /^workgroup:v1:[0-9a-f]{64}$/,
  membershipVersionId: /^membership:v1:[0-9a-f]{64}$/,
});

class TruthEvidenceLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthEvidenceLedgerError";
    Object.assign(this, fields);
    if (fields.code === "TRUTH_EVIDENCE_INVALID_RECEIPT"
        && !/^(?:read|get)\b/i.test(String(fields.operation || ""))) {
      this.retryable = true;
      this.outcomeUnknown = true;
      this.receiptInvalid = true;
    }
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthEvidenceLedgerError(`Invalid truth evidence argument ${field}: ${reason}`, {
    code: "TRUTH_EVIDENCE_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalidArgument(field, "must be a non-empty trimmed string");
  }
  return value;
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

function parseBody(body) {
  if (isPlainObject(body)) return body;
  if (typeof body !== "string") return {};
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthEvidenceLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  const body = parseBody(cause.body);
  const code = String(cause.code || body.code || "TRUTH_EVIDENCE_RPC_FAILED");
  const status = Number(cause.status ?? cause.statusCode);
  return new TruthEvidenceLedgerError(`${operation} failed: ${cause.message}`, {
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

function normalizeEvidence(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw invalidArgument(field, "must be a non-empty array");
  const rows = value.map((item, index) => {
    if (!isPlainObject(item)) throw invalidArgument(`${field}[${index}]`, "must be an object");
    return cloneJson(item, `${field}[${index}]`);
  });
  rows.sort((left, right) =>
    String(left.observationId || "").localeCompare(String(right.observationId || "")) ||
    String(left.evidenceRole || "").localeCompare(String(right.evidenceRole || "")));
  return rows;
}

function normalizeOptionalArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidArgument(field, "must be an array");
  return value.map((item, index) => cloneJson(item, `${field}[${index}]`));
}

function validateReceipt(value, operation, identityField) {
  if (!isPlainObject(value) || value.ok !== true) {
    throw new TruthEvidenceLedgerError(`Invalid ${operation} receipt`, {
      code: "TRUTH_EVIDENCE_INVALID_RECEIPT",
      operation,
    });
  }
  if (!IDENTITIES[identityField].test(String(value[identityField] || ""))) {
    throw new TruthEvidenceLedgerError(`Invalid ${operation} receipt ${identityField}`, {
      code: "TRUTH_EVIDENCE_INVALID_RECEIPT",
      operation,
      field: identityField,
    });
  }
  if (!HASH_RE.test(String(value.itemHash || ""))) {
    throw new TruthEvidenceLedgerError(`Invalid ${operation} receipt itemHash`, {
      code: "TRUTH_EVIDENCE_INVALID_RECEIPT",
      operation,
      field: "itemHash",
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function createTruthEvidenceLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = requireString(options.workspaceKey ?? "primary", "workspaceKey");
  const syncToken = requireString(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  const rpcOptions = cloneJson(options.rpcOptions ?? {}, "rpcOptions");
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");

  async function invoke(operation, rpc, body, identityField) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return validateReceipt(value, operation, identityField);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function appendAcceptedClaim(input = {}) {
    if (!isPlainObject(input) || !isPlainObject(input.claim)) {
      throw invalidArgument("appendAcceptedClaim", "requires a claim object");
    }
    return invoke("append accepted claim", RPC.appendAcceptedClaim, {
      p_workspace_key: workspaceKey,
      p_claim: cloneJson(input.claim, "claim"),
      p_evidence: normalizeEvidence(input.evidence, "evidence"),
      p_supersessions: normalizeOptionalArray(input.supersessions, "supersessions")
        .sort((left, right) => String(left.supersededClaimVersionId || "")
          .localeCompare(String(right.supersededClaimVersionId || ""))),
      p_sync_token: syncToken,
    }, "claimVersionId");
  }

  async function appendEntityLink(input = {}) {
    if (!isPlainObject(input) || !isPlainObject(input.link)) {
      throw invalidArgument("appendEntityLink", "requires a link object");
    }
    return invoke("append observation entity link", RPC.appendEntityLink, {
      p_workspace_key: workspaceKey,
      p_link: cloneJson(input.link, "link"),
      p_sync_token: syncToken,
    }, "linkVersionId");
  }

  async function appendWorkgroupMembership(input = {}) {
    if (!isPlainObject(input) || !isPlainObject(input.workgroup) || !isPlainObject(input.membership)) {
      throw invalidArgument("appendWorkgroupMembership", "requires workgroup and membership objects");
    }
    const result = await invoke("append operational workgroup membership", RPC.appendWorkgroupMembership, {
      p_workspace_key: workspaceKey,
      p_workgroup: cloneJson(input.workgroup, "workgroup"),
      p_membership: cloneJson(input.membership, "membership"),
      p_evidence: normalizeEvidence(input.evidence, "evidence"),
      p_sync_token: syncToken,
    }, "membershipVersionId");
    if (!IDENTITIES.workgroupId.test(String(result.workgroupId || ""))) {
      throw new TruthEvidenceLedgerError("Invalid workgroup membership receipt workgroupId", {
        code: "TRUTH_EVIDENCE_INVALID_RECEIPT",
        operation: "append operational workgroup membership",
        field: "workgroupId",
      });
    }
    return result;
  }

  return Object.freeze({
    workspaceKey,
    appendAcceptedClaim,
    appendEntityLink,
    appendWorkgroupMembership,
  });
}

module.exports = {
  RPC,
  TruthEvidenceLedgerError,
  createTruthEvidenceLedger,
  _test: {
    cloneJson,
    normalizeEvidence,
    normalizeRpcError,
    validateReceipt,
  },
};

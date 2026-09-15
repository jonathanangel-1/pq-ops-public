"use strict";

const RPC = Object.freeze({
  appendResolution: "append_truth_link_resolution",
  appendDecision: "append_truth_link_candidate_decision",
  bindAcceptance: "bind_truth_link_candidate_acceptance",
  appendOperatorDecision: "append_operator_truth_link_candidate_decision",
  bindOperatorAcceptance: "bind_operator_truth_link_candidate_acceptance",
  resolveReview: "resolve_truth_review",
});

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITIES = Object.freeze({
  resolutionRunId: /^link-resolution:v1:[0-9a-f]{64}$/,
  proposalId: /^link-proposal:v1:[0-9a-f]{64}$/,
  decisionVersionId: /^link-decision:v1:[0-9a-f]{64}$/,
  bindingId: /^link-acceptance:v1:[0-9a-f]{64}$/,
  linkVersionId: /^link:v1:[0-9a-f]{64}$/,
  workgroupId: /^workgroup:v1:[0-9a-f]{64}$/,
  membershipVersionId: /^membership:v1:[0-9a-f]{64}$/,
  reviewResolutionId: /^review-resolution:v1:[0-9a-f]{64}$/,
});
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;

class TruthLinkLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthLinkLedgerError";
    Object.assign(this, fields);
    if (fields.code === "TRUTH_LINK_INVALID_RECEIPT"
        && !/^(?:read|get)\b/i.test(String(fields.operation || ""))) {
      this.retryable = true;
      this.outcomeUnknown = true;
      this.receiptInvalid = true;
    }
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthLinkLedgerError(`Invalid truth-link argument ${field}: ${reason}`, {
    code: "TRUTH_LINK_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value, field, { allowEmpty = false, maxBytes = 8192 } = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not contain surrounding whitespace");
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalidArgument(field, "is too long");
  return value;
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function identity(value, field, pattern) {
  const result = string(value, field);
  if (!pattern.test(result)) throw invalidArgument(field, "has an invalid server identity");
  return result;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 32) throw invalidArgument(field, "exceeds the maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
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
  throw invalidArgument(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthLinkLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  let body = {};
  try {
    body = typeof cause.body === "string" ? JSON.parse(cause.body) : cause.body || {};
  } catch {
    body = {};
  }
  const code = String(cause.code || body.code || "TRUTH_LINK_RPC_FAILED");
  const status = Number(cause.status ?? cause.statusCode);
  return new TruthLinkLedgerError(`${operation} failed: ${cause.message}`, {
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

function jobFields(input) {
  return {
    p_job_id: identity(input.jobId, "jobId", UUID_RE),
    p_worker_id: string(input.workerId, "workerId"),
    p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
    p_processor_version: string(input.processorVersion, "processorVersion"),
  };
}

function validateBaseReceipt(value, operation, identityField, pattern) {
  if (!isPlainObject(value) || value.ok !== true) {
    throw new TruthLinkLedgerError(`Invalid ${operation} receipt`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "result",
    });
  }
  if (!pattern.test(String(value[identityField] || ""))) {
    throw new TruthLinkLedgerError(`Invalid ${operation} receipt ${identityField}`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: identityField,
    });
  }
  if (!HASH_RE.test(String(value.itemHash || ""))) {
    throw new TruthLinkLedgerError(`Invalid ${operation} receipt itemHash`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "itemHash",
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function normalizeDecision(value, expectedMethod) {
  if (!isPlainObject(value)) throw invalidArgument("decision", "must be an object");
  const decision = cloneJson(value, "decision");
  integer(decision.decisionNo, "decision.decisionNo", { minimum: 1, maximum: 2_147_483_647 });
  if (decision.previousDecisionVersionId !== null && decision.previousDecisionVersionId !== undefined) {
    identity(decision.previousDecisionVersionId, "decision.previousDecisionVersionId", IDENTITIES.decisionVersionId);
  }
  if (!["accept", "review", "reject"].includes(decision.decision)) {
    throw invalidArgument("decision.decision", "is unsupported");
  }
  if (decision.method !== expectedMethod) {
    throw invalidArgument("decision.method", `must be ${expectedMethod}`);
  }
  string(decision.policyVersion, "decision.policyVersion");
  string(decision.decidedBy, "decision.decidedBy");
  if (!Array.isArray(decision.reasons) || decision.reasons.length === 0) {
    throw invalidArgument("decision.reasons", "must be a non-empty array");
  }
  decision.reasons.forEach((reason, index) => string(reason, `decision.reasons[${index}]`));
  return decision;
}

function validateAcceptedRequest(result, operation) {
  if (result.decision !== "accept") {
    if (result.acceptedItemRequest !== null && result.acceptedItemRequest !== undefined) {
      throw new TruthLinkLedgerError(`Invalid ${operation} non-accept request`, {
        code: "TRUTH_LINK_INVALID_RECEIPT",
        operation,
        field: "acceptedItemRequest",
      });
    }
    return result;
  }
  const request = result.acceptedItemRequest;
  if (!isPlainObject(request) || !["entity_link", "workgroup", "workgroup_membership"].includes(request.acceptedKind)) {
    throw new TruthLinkLedgerError(`Invalid ${operation} accepted item request`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "acceptedItemRequest",
    });
  }
  if (request.acceptedKind === "entity_link" && !isPlainObject(request.link)) {
    throw new TruthLinkLedgerError(`Invalid ${operation} entity-link request`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "acceptedItemRequest.link",
    });
  }
  if (request.acceptedKind === "workgroup" && !isPlainObject(request.workgroup)) {
    throw new TruthLinkLedgerError(`Invalid ${operation} workgroup request`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "acceptedItemRequest.workgroup",
    });
  }
  if (request.acceptedKind === "workgroup_membership" && (
    !isPlainObject(request.workgroup)
    || !isPlainObject(request.membership)
    || !Array.isArray(request.evidence)
    || request.evidence.length === 0
  )) {
    throw new TruthLinkLedgerError(`Invalid ${operation} membership request`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "acceptedItemRequest",
    });
  }
  return result;
}

function validateReviewReceipt(value, operation, expectedTargetId) {
  if (!isPlainObject(value) || value.ok !== true
    || value.targetKind !== "link_proposal" || value.targetId !== expectedTargetId
    || !IDENTITIES.reviewResolutionId.test(String(value.reviewResolutionId || ""))
    || !IDENTITIES.decisionVersionId.test(String(value.decisionVersionId || ""))
    || !HASH_RE.test(String(value.decisionItemHash || ""))
    || !HASH_RE.test(String(value.reviewItemHash || ""))
    || !["accept", "reject"].includes(value.decision)) {
    throw new TruthLinkLedgerError(`Invalid ${operation} receipt`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "result",
    });
  }
  if (value.decision === "accept") {
    const acceptedKind = String(value.acceptedKind || "");
    const pattern = acceptedKind === "entity_link"
      ? IDENTITIES.linkVersionId
      : acceptedKind === "workgroup"
        ? IDENTITIES.workgroupId
        : acceptedKind === "workgroup_membership"
          ? IDENTITIES.membershipVersionId
          : null;
    if (!pattern || !pattern.test(String(value.acceptedItemId || ""))
      || !HASH_RE.test(String(value.acceptedItemHash || ""))
      || !IDENTITIES.bindingId.test(String(value.bindingId || ""))
      || !HASH_RE.test(String(value.bindingItemHash || ""))) {
      throw new TruthLinkLedgerError(`Invalid ${operation} acceptance receipt`, {
        code: "TRUTH_LINK_INVALID_RECEIPT",
        operation,
        field: "acceptance",
      });
    }
  } else if (value.acceptedKind !== "" || value.acceptedItemId !== ""
    || value.acceptedItemHash !== "" || value.bindingId !== "" || value.bindingItemHash !== "") {
    throw new TruthLinkLedgerError(`Invalid ${operation} rejection receipt`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "acceptance",
    });
  }
  if (value.mutatesOperationalState !== false || value.publishesTruth !== false
    || value.performsActions !== false) {
    throw new TruthLinkLedgerError(`Invalid ${operation} safety receipt`, {
      code: "TRUTH_LINK_INVALID_RECEIPT",
      operation,
      field: "safety",
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function createTruthLinkLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = string(options.workspaceKey ?? "primary", "workspaceKey");
  const syncToken = string(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken");
  const operatorDecisionToken = options.operatorDecisionToken
    ?? process.env.PQ_TRUTH_LINK_OPERATOR_DECISION_TOKEN
    ?? null;
  const reviewToken = options.reviewToken ?? process.env.PQ_TRUTH_REVIEW_TOKEN ?? null;
  const rpcOptions = cloneJson(options.rpcOptions ?? {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");

  async function invoke(operation, rpc, body, identityField, pattern) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return validateBaseReceipt(value, operation, identityField, pattern);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function appendResolution(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("appendResolution", "must be an object");
    if (!Array.isArray(input.contextManifest) || input.contextManifest.length === 0) {
      throw invalidArgument("contextManifest", "must be a non-empty array");
    }
    if (!isPlainObject(input.resolution)) throw invalidArgument("resolution", "must be an object");
    if (!Array.isArray(input.proposals)) throw invalidArgument("proposals", "must be an array");
    const result = await invoke("append truth-link resolution", RPC.appendResolution, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_context_manifest: cloneJson(input.contextManifest, "contextManifest"),
      p_resolution: cloneJson(input.resolution, "resolution"),
      p_proposals: cloneJson(input.proposals, "proposals"),
      p_sync_token: syncToken,
    }, "resolutionRunId", IDENTITIES.resolutionRunId);
    if (!Array.isArray(result.proposals) || result.proposalCount !== result.proposals.length) {
      throw new TruthLinkLedgerError("Invalid append truth-link resolution proposal receipt", {
        code: "TRUTH_LINK_INVALID_RECEIPT",
        operation: "append truth-link resolution",
        field: "proposals",
      });
    }
    for (const proposal of result.proposals) {
      if (!IDENTITIES.proposalId.test(String(proposal?.proposalId || ""))
        || !HASH_RE.test(String(proposal?.itemHash || ""))) {
        throw new TruthLinkLedgerError("Invalid append truth-link resolution proposal identity", {
          code: "TRUTH_LINK_INVALID_RECEIPT",
          operation: "append truth-link resolution",
          field: "proposals",
        });
      }
    }
    return result;
  }

  async function appendDecision(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("appendDecision", "must be an object");
    const result = await invoke("append truth-link candidate decision", RPC.appendDecision, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_proposal_id: identity(input.proposalId, "proposalId", IDENTITIES.proposalId),
      p_decision: normalizeDecision(input.decision, "policy"),
      p_sync_token: syncToken,
    }, "decisionVersionId", IDENTITIES.decisionVersionId);
    return deepFreeze(validateAcceptedRequest(result, "append truth-link candidate decision"));
  }

  async function appendOperatorDecision(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("appendOperatorDecision", "must be an object");
    const result = await invoke("append operator truth-link candidate decision", RPC.appendOperatorDecision, {
      p_workspace_key: workspaceKey,
      p_proposal_id: identity(input.proposalId, "proposalId", IDENTITIES.proposalId),
      p_decision: normalizeDecision(input.decision, "operator"),
      p_operator_token: string(operatorDecisionToken, "operatorDecisionToken"),
    }, "decisionVersionId", IDENTITIES.decisionVersionId);
    return deepFreeze(validateAcceptedRequest(result, "append operator truth-link candidate decision"));
  }

  async function bindAcceptance(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("bindAcceptance", "must be an object");
    return invoke("bind truth-link candidate acceptance", RPC.bindAcceptance, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_proposal_id: identity(input.proposalId, "proposalId", IDENTITIES.proposalId),
      p_decision_version_id: identity(
        input.decisionVersionId,
        "decisionVersionId",
        IDENTITIES.decisionVersionId,
      ),
      p_accepted_item_id: string(input.acceptedItemId, "acceptedItemId"),
      p_sync_token: syncToken,
    }, "bindingId", IDENTITIES.bindingId);
  }

  async function bindOperatorAcceptance(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("bindOperatorAcceptance", "must be an object");
    return invoke("bind operator truth-link candidate acceptance", RPC.bindOperatorAcceptance, {
      p_workspace_key: workspaceKey,
      p_proposal_id: identity(input.proposalId, "proposalId", IDENTITIES.proposalId),
      p_decision_version_id: identity(
        input.decisionVersionId,
        "decisionVersionId",
        IDENTITIES.decisionVersionId,
      ),
      p_accepted_item_id: string(input.acceptedItemId, "acceptedItemId"),
      p_operator_token: string(operatorDecisionToken, "operatorDecisionToken"),
    }, "bindingId", IDENTITIES.bindingId);
  }

  async function resolveReview(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("resolveReview", "must be an object");
    const targetId = identity(input.targetId, "targetId", IDENTITIES.proposalId);
    const expectedTargetHash = string(input.expectedTargetHash, "expectedTargetHash");
    if (!HASH_RE.test(expectedTargetHash)) {
      throw invalidArgument("expectedTargetHash", "must be lowercase SHA-256 hex");
    }
    const expectedPreviousDecisionVersionId = input.expectedPreviousDecisionVersionId === ""
      ? ""
      : identity(
        input.expectedPreviousDecisionVersionId,
        "expectedPreviousDecisionVersionId",
        IDENTITIES.decisionVersionId,
      );
    const decision = string(input.decision, "decision");
    if (!["accept", "reject"].includes(decision)) {
      throw invalidArgument("decision", "must be accept or reject");
    }
    const idempotencyKey = string(input.idempotencyKey, "idempotencyKey", { maxBytes: 128 });
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw invalidArgument("idempotencyKey", "must be 32-128 base64url characters");
    }
    const body = {
      p_workspace_key: workspaceKey,
      p_target_kind: "link_proposal",
      p_target_id: targetId,
      p_expected_target_hash: expectedTargetHash,
      p_expected_previous_decision_version_id: expectedPreviousDecisionVersionId,
      p_decision: decision,
      p_policy_version: string(input.policyVersion, "policyVersion"),
      p_decided_by: string(input.decidedBy, "decidedBy"),
      p_reason: string(input.reason, "reason", { maxBytes: 2000 }),
      p_idempotency_key: idempotencyKey,
      p_review_token: string(reviewToken, "reviewToken"),
      p_sync_token: syncToken,
    };
    let result;
    try {
      result = await callRpc(RPC.resolveReview, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, "resolve truth-link review", RPC.resolveReview);
    }
    try {
      return validateReviewReceipt(result, "resolve truth-link review", targetId);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  return Object.freeze({
    workspaceKey,
    appendResolution,
    appendDecision,
    appendOperatorDecision,
    bindAcceptance,
    bindOperatorAcceptance,
    resolveReview,
  });
}

module.exports = {
  IDENTITIES,
  RPC,
  TruthLinkLedgerError,
  createTruthLinkLedger,
  _test: {
    cloneJson,
    normalizeDecision,
    normalizeRpcError,
    validateAcceptedRequest,
    validateBaseReceipt,
    validateReviewReceipt,
  },
};

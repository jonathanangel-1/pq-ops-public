"use strict";

const crypto = require("node:crypto");

const RPC = Object.freeze({
  appendCandidate: "append_candidate_claim",
  appendAndSealJob: "append_and_seal_candidate_claim_job",
  sealJobManifest: "seal_candidate_claim_job_manifest",
  getJobState: "get_candidate_claim_job_state",
  appendDecision: "append_candidate_claim_decision",
  bindAcceptance: "bind_candidate_claim_acceptance",
  appendOperatorDecision: "append_operator_candidate_claim_decision",
  bindOperatorAcceptance: "bind_operator_candidate_claim_acceptance",
  recordPolicyRecommendation: "record_candidate_claim_policy_recommendation",
  authorizePolicyCorrection: "authorize_candidate_claim_policy_correction",
  resolveReview: "resolve_truth_review",
  readReviewQueue: "read_truth_review_queue",
});

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITIES = Object.freeze({
  candidateClaimVersionId: /^candidate:v1:[0-9a-f]{64}$/,
  decisionVersionId: /^candidate-decision:v1:[0-9a-f]{64}$/,
  bindingId: /^candidate-acceptance:v1:[0-9a-f]{64}$/,
  acceptedClaimVersionId: /^claim:v1:[0-9a-f]{64}$/,
  reviewResolutionId: /^review-resolution:v1:[0-9a-f]{64}$/,
});
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;

class TruthCandidateLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthCandidateLedgerError";
    Object.assign(this, fields);
    if (fields.code === "TRUTH_CANDIDATE_INVALID_RECEIPT"
        && !/^(?:read|get)\b/i.test(String(fields.operation || ""))) {
      this.retryable = true;
      this.outcomeUnknown = true;
      this.receiptInvalid = true;
    }
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthCandidateLedgerError(`Invalid truth-candidate argument ${field}: ${reason}`, {
    code: "TRUTH_CANDIDATE_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, field, reason) {
  return new TruthCandidateLedgerError(`Invalid ${operation} receipt ${field}: ${reason}`, {
    code: "TRUTH_CANDIDATE_INVALID_RECEIPT",
    operation,
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

function uuid(value, field) {
  const result = string(value, field);
  if (!UUID_RE.test(result)) throw invalidArgument(field, "must be a UUID");
  return result;
}

function identity(value, field, pattern) {
  const result = string(value, field);
  if (!pattern.test(result)) throw invalidArgument(field, "has an invalid server identity");
  return result;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 24) throw invalidArgument(field, "exceeds the maximum JSON depth");
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

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function normalizeCandidate(candidate) {
  if (!isPlainObject(candidate)) throw invalidArgument("candidate", "must be an object");
  const normalized = cloneJson(candidate, "candidate");
  const candidateClaimVersionId = identity(
    normalized.candidateClaimVersionId,
    "candidate.candidateClaimVersionId",
    IDENTITIES.candidateClaimVersionId,
  );
  const candidateHash = string(normalized.candidateHash, "candidate.candidateHash");
  if (!HASH_RE.test(candidateHash)) {
    throw invalidArgument("candidate.candidateHash", "must be lowercase SHA-256 hex");
  }
  if (candidateClaimVersionId !== `candidate:v1:${candidateHash}`) {
    throw invalidArgument("candidate.candidateClaimVersionId", "does not match candidateHash");
  }
  delete normalized.candidateClaimVersionId;
  delete normalized.candidateHash;
  if (sha256Json(normalized) !== candidateHash) {
    throw invalidArgument("candidate.candidateHash", "does not match the immutable extractor candidate");
  }
  return deepFreeze(normalized);
}

function normalizeDecision(decision) {
  if (!isPlainObject(decision)) throw invalidArgument("decision", "must be an object");
  const normalized = cloneJson(decision, "decision");
  integer(normalized.decisionNo, "decision.decisionNo", { minimum: 1, maximum: 2_147_483_647 });
  if (normalized.previousDecisionVersionId !== null && normalized.previousDecisionVersionId !== undefined) {
    identity(
      normalized.previousDecisionVersionId,
      "decision.previousDecisionVersionId",
      IDENTITIES.decisionVersionId,
    );
  }
  if (!["accept", "review", "reject"].includes(normalized.decision)) {
    throw invalidArgument("decision.decision", "is unsupported");
  }
  if (!["policy", "operator"].includes(normalized.method)) {
    throw invalidArgument("decision.method", "is unsupported");
  }
  string(normalized.policyVersion, "decision.policyVersion");
  string(normalized.decidedBy, "decision.decidedBy");
  if (!Array.isArray(normalized.reasons) || normalized.reasons.length === 0) {
    throw invalidArgument("decision.reasons", "must be a non-empty array");
  }
  normalized.reasons.forEach((reason, index) => string(reason, `decision.reasons[${index}]`));
  return deepFreeze(normalized);
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
  if (error instanceof TruthCandidateLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  const body = parseBody(cause.body);
  const code = String(cause.code || body.code || "TRUTH_CANDIDATE_RPC_FAILED");
  const status = Number(cause.status ?? cause.statusCode);
  return new TruthCandidateLedgerError(`${operation} failed: ${cause.message}`, {
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

function validateReceipt(value, operation, identityField, pattern) {
  if (!isPlainObject(value) || value.ok !== true) {
    throw invalidReceipt(operation, "result", "must be an object with ok=true");
  }
  if (!pattern.test(String(value[identityField] || ""))) {
    throw invalidReceipt(operation, identityField, "has an invalid server-derived identity");
  }
  if (!HASH_RE.test(String(value.itemHash || ""))) {
    throw invalidReceipt(operation, "itemHash", "must be lowercase SHA-256 hex");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateReviewReceipt(value, operation, expectedTargetKind, expectedTargetId) {
  if (!isPlainObject(value) || value.ok !== true) {
    throw invalidReceipt(operation, "result", "must be an object with ok=true");
  }
  if (!IDENTITIES.reviewResolutionId.test(String(value.reviewResolutionId || ""))) {
    throw invalidReceipt(operation, "reviewResolutionId", "has an invalid server-derived identity");
  }
  if (value.targetKind !== expectedTargetKind || value.targetId !== expectedTargetId) {
    throw invalidReceipt(operation, "target", "does not match the requested review target");
  }
  if (!["accept", "reject"].includes(value.decision)) {
    throw invalidReceipt(operation, "decision", "must be terminal");
  }
  if (!IDENTITIES.decisionVersionId.test(String(value.decisionVersionId || ""))) {
    throw invalidReceipt(operation, "decisionVersionId", "has an invalid server-derived identity");
  }
  if (!HASH_RE.test(String(value.decisionItemHash || ""))) {
    throw invalidReceipt(operation, "decisionItemHash", "must be lowercase SHA-256 hex");
  }
  if (!HASH_RE.test(String(value.reviewItemHash || ""))) {
    throw invalidReceipt(operation, "reviewItemHash", "must be lowercase SHA-256 hex");
  }
  if (value.decision === "accept") {
    if (value.acceptedKind !== "accepted_claim"
      || !IDENTITIES.acceptedClaimVersionId.test(String(value.acceptedItemId || ""))
      || !HASH_RE.test(String(value.acceptedItemHash || ""))
      || !IDENTITIES.bindingId.test(String(value.bindingId || ""))
      || !HASH_RE.test(String(value.bindingItemHash || ""))) {
      throw invalidReceipt(operation, "acceptance", "must contain the exact accepted claim and binding receipt");
    }
  } else if (value.acceptedKind !== "" || value.acceptedItemId !== "" || value.acceptedItemHash !== ""
    || value.bindingId !== "" || value.bindingItemHash !== "") {
    throw invalidReceipt(operation, "acceptance", "must be empty for rejection");
  }
  if (value.mutatesOperationalState !== false || value.publishesTruth !== false
    || value.performsActions !== false) {
    throw invalidReceipt(operation, "safety", "must prove the review path cannot publish or perform actions");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateReviewQueue(value, operation, expectedTargetKind) {
  if (!isPlainObject(value) || value.ok !== true || !Array.isArray(value.items)
    || !Number.isSafeInteger(value.totalCount) || value.totalCount < value.items.length
    || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100
    || value.items.length > value.limit) {
    throw invalidReceipt(operation, "result", "must contain a bounded review queue");
  }
  for (const [index, item] of value.items.entries()) {
    if (!isPlainObject(item) || !["candidate_claim", "link_proposal"].includes(item.targetKind)
      || (expectedTargetKind && item.targetKind !== expectedTargetKind)
      || typeof item.targetId !== "string" || typeof item.targetItemHash !== "string"
      || !HASH_RE.test(item.targetItemHash)
      || !Number.isSafeInteger(item.nextDecisionNo) || item.nextDecisionNo < 1) {
      throw invalidReceipt(operation, `items[${index}]`, "has an invalid review target");
    }
  }
  if (value.mutatesOperationalState !== false) {
    throw invalidReceipt(operation, "mutatesOperationalState", "must be false");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateJobStateReceipt(value, operation) {
  if (!isPlainObject(value) || value.ok !== true || typeof value.sealed !== "boolean") {
    throw invalidReceipt(operation, "result", "must contain ok=true and boolean sealed");
  }
  if (!Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0
    || !Array.isArray(value.candidates) || value.candidates.length !== value.candidateCount) {
    throw invalidReceipt(operation, "candidates", "must match candidateCount");
  }
  if (value.sealed) {
    if (!HASH_RE.test(String(value.manifestHash || ""))) {
      throw invalidReceipt(operation, "manifestHash", "must be lowercase SHA-256 hex when sealed");
    }
  } else if (value.manifestHash !== "" || value.candidateCount !== 0) {
    throw invalidReceipt(operation, "manifestHash", "unsealed state must be empty");
  }
  const candidates = value.candidates.map((row, index) => {
    if (!isPlainObject(row) || !isPlainObject(row.candidate)) {
      throw invalidReceipt(operation, `candidates[${index}]`, "must contain a candidate object");
    }
    const candidateClaimVersionId = String(row.candidateClaimVersionId || "");
    const itemHash = String(row.itemHash || "");
    if (!IDENTITIES.candidateClaimVersionId.test(candidateClaimVersionId)
      || !HASH_RE.test(itemHash)
      || candidateClaimVersionId !== `candidate:v1:${itemHash}`) {
      throw invalidReceipt(operation, `candidates[${index}]`, "has an invalid server candidate identity");
    }
    const base = cloneJson(row.candidate, `${operation}.candidates[${index}].candidate`);
    const candidateHash = sha256Json(base);
    return {
      candidateClaimVersionId,
      itemHash,
      candidate: deepFreeze({
        candidateClaimVersionId: `candidate:v1:${candidateHash}`,
        candidateHash,
        ...base,
      }),
    };
  });
  candidates.sort((left, right) => left.candidateClaimVersionId.localeCompare(right.candidateClaimVersionId));
  return deepFreeze({
    ...cloneJson(value, `${operation}.receipt`),
    candidates,
  });
}

function validateManifestReceipt(value, operation) {
  if (!isPlainObject(value) || value.ok !== true
    || !HASH_RE.test(String(value.manifestHash || ""))
    || !Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0
    || !Array.isArray(value.candidates) || value.candidates.length !== value.candidateCount) {
    throw invalidReceipt(operation, "result", "must contain a complete sealed manifest receipt");
  }
  for (const [index, candidate] of value.candidates.entries()) {
    if (!isPlainObject(candidate)
      || !IDENTITIES.candidateClaimVersionId.test(String(candidate.candidateClaimVersionId || ""))
      || !HASH_RE.test(String(candidate.itemHash || ""))
      || candidate.candidateClaimVersionId !== `candidate:v1:${candidate.itemHash}`) {
      throw invalidReceipt(operation, `candidates[${index}]`, "has an invalid server candidate identity");
    }
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateBatchReceipt(value, operation, expectedCount) {
  const manifest = validateManifestReceipt(value, operation);
  if (!Array.isArray(value.candidateReceipts)
    || value.candidateReceipts.length !== expectedCount
    || value.candidateCount !== expectedCount) {
    throw invalidReceipt(operation, "candidateReceipts", "must match the submitted candidate batch");
  }
  for (const [index, receipt] of value.candidateReceipts.entries()) {
    if (!isPlainObject(receipt)
      || !IDENTITIES.candidateClaimVersionId.test(String(receipt.candidateClaimVersionId || ""))
      || !HASH_RE.test(String(receipt.itemHash || ""))
      || receipt.candidateClaimVersionId !== `candidate:v1:${receipt.itemHash}`) {
      throw invalidReceipt(operation, `candidateReceipts[${index}]`, "has an invalid server candidate identity");
    }
  }
  return manifest;
}

function jobFields(input) {
  return {
    p_job_id: uuid(input.jobId, "jobId"),
    p_worker_id: string(input.workerId, "workerId"),
    p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
    p_processor_version: string(input.processorVersion, "processorVersion"),
  };
}

function createTruthCandidateLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = string(options.workspaceKey ?? "primary", "workspaceKey");
  const syncToken = string(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken");
  const operatorDecisionToken = options.operatorDecisionToken
    ?? process.env.PQ_CANDIDATE_OPERATOR_DECISION_TOKEN
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
      return validateReceipt(value, operation, identityField, pattern);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function invokeJobState(operation, rpc, body) {
    try {
      return validateJobStateReceipt(await callRpc(rpc, body, rpcOptions), operation);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
  }

  async function invokeManifest(operation, rpc, body) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return validateManifestReceipt(value, operation);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function invokeBatch(operation, rpc, body, expectedCount) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return validateBatchReceipt(value, operation, expectedCount);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function appendCandidate(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("appendCandidate", "must be an object");
    return invoke("append candidate claim", RPC.appendCandidate, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidate: normalizeCandidate(input.candidate),
      p_sync_token: syncToken,
    }, "candidateClaimVersionId", IDENTITIES.candidateClaimVersionId);
  }

  async function sealJobCandidates(input = {}) {
    if (!isPlainObject(input) || !Array.isArray(input.candidates)) {
      throw invalidArgument("sealJobCandidates", "requires a candidates array");
    }
    const candidates = input.candidates.map((candidate, index) => {
      if (!isPlainObject(candidate)) throw invalidArgument(`candidates[${index}]`, "must be an object");
      const candidateClaimVersionId = identity(
        candidate.candidateClaimVersionId,
        `candidates[${index}].candidateClaimVersionId`,
        IDENTITIES.candidateClaimVersionId,
      );
      const itemHash = string(candidate.itemHash, `candidates[${index}].itemHash`);
      if (!HASH_RE.test(itemHash) || candidateClaimVersionId !== `candidate:v1:${itemHash}`) {
        throw invalidArgument(`candidates[${index}]`, "candidate identity and itemHash do not match");
      }
      return { candidateClaimVersionId, itemHash };
    }).sort((left, right) => left.candidateClaimVersionId.localeCompare(right.candidateClaimVersionId));
    return invokeManifest("seal candidate claim job manifest", RPC.sealJobManifest, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidates: candidates,
      p_sync_token: syncToken,
    });
  }

  async function appendAndSealJobCandidates(input = {}) {
    if (!isPlainObject(input) || !Array.isArray(input.candidates)) {
      throw invalidArgument("appendAndSealJobCandidates", "requires a candidates array");
    }
    if (input.candidates.length > 50) {
      throw invalidArgument("candidates", "must contain at most fifty candidates");
    }
    const candidates = input.candidates.map((candidate) => normalizeCandidate(candidate));
    return invokeBatch("append and seal candidate claim job", RPC.appendAndSealJob, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidates: candidates,
      p_sync_token: syncToken,
    }, candidates.length);
  }

  async function getJobState(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("getJobState", "must be an object");
    return invokeJobState("get candidate claim job state", RPC.getJobState, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_sync_token: syncToken,
    });
  }

  async function appendDecision(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("appendDecision", "must be an object");
    const decision = normalizeDecision(input.decision);
    if (decision.method !== "policy") {
      throw invalidArgument("decision.method", "worker-fenced decisions must use policy; use appendOperatorDecision for operator adjudication");
    }
    const result = await invoke("append candidate claim decision", RPC.appendDecision, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidate_claim_version_id: identity(
        input.candidateClaimVersionId,
        "candidateClaimVersionId",
        IDENTITIES.candidateClaimVersionId,
      ),
      p_decision: decision,
      p_sync_token: syncToken,
    }, "decisionVersionId", IDENTITIES.decisionVersionId);
    if (result.decision === "accept") {
      if (!isPlainObject(result.acceptedClaimRequest)
        || !isPlainObject(result.acceptedClaimRequest.claim)
        || !Array.isArray(result.acceptedClaimRequest.evidence)
        || !Array.isArray(result.acceptedClaimRequest.supersessions)) {
        throw invalidReceipt(
          "append candidate claim decision",
          "acceptedClaimRequest",
          "must contain claim, evidence, and supersessions",
        );
      }
    } else if (result.acceptedClaimRequest !== null && result.acceptedClaimRequest !== undefined) {
      throw invalidReceipt(
        "append candidate claim decision",
        "acceptedClaimRequest",
        "must be absent for non-accept decisions",
      );
    }
    return result;
  }

  async function authorizePolicyAcceptance(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("authorizePolicyAcceptance", "must be an object");
    return appendDecision({
      ...input,
      decision: {
        decisionNo: 1,
        previousDecisionVersionId: null,
        decision: "accept",
        method: "policy",
        policyVersion: string(input.policyVersion, "policyVersion"),
        decidedBy: string(input.decidedBy, "decidedBy"),
        reasons: ["deterministic candidate passed the exact configured acceptance policy"],
      },
    });
  }

  async function bindAcceptance(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("bindAcceptance", "must be an object");
    const result = await invoke("bind candidate claim acceptance", RPC.bindAcceptance, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidate_claim_version_id: identity(
        input.candidateClaimVersionId,
        "candidateClaimVersionId",
        IDENTITIES.candidateClaimVersionId,
      ),
      p_decision_version_id: identity(
        input.decisionVersionId,
        "decisionVersionId",
        IDENTITIES.decisionVersionId,
      ),
      p_accepted_claim_version_id: identity(
        input.acceptedClaimVersionId,
        "acceptedClaimVersionId",
        IDENTITIES.acceptedClaimVersionId,
      ),
      p_sync_token: syncToken,
    }, "bindingId", IDENTITIES.bindingId);
    if (result.acceptedClaimVersionId !== input.acceptedClaimVersionId) {
      throw invalidReceipt(
        "bind candidate claim acceptance",
        "acceptedClaimVersionId",
        "does not match the requested accepted claim",
      );
    }
    return result;
  }

  function requireOperatorToken() {
    return string(operatorDecisionToken, "operatorDecisionToken");
  }

  async function appendOperatorDecision(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("appendOperatorDecision", "must be an object");
    const decision = normalizeDecision(input.decision);
    if (decision.method !== "operator") {
      throw invalidArgument("decision.method", "operator adjudication must use operator");
    }
    const result = await invoke("append operator candidate claim decision", RPC.appendOperatorDecision, {
      p_workspace_key: workspaceKey,
      p_candidate_claim_version_id: identity(
        input.candidateClaimVersionId,
        "candidateClaimVersionId",
        IDENTITIES.candidateClaimVersionId,
      ),
      p_decision: decision,
      p_operator_token: requireOperatorToken(),
    }, "decisionVersionId", IDENTITIES.decisionVersionId);
    if (result.decision === "accept") {
      if (!isPlainObject(result.acceptedClaimRequest)
        || !isPlainObject(result.acceptedClaimRequest.claim)
        || !Array.isArray(result.acceptedClaimRequest.evidence)
        || !Array.isArray(result.acceptedClaimRequest.supersessions)) {
        throw invalidReceipt(
          "append operator candidate claim decision",
          "acceptedClaimRequest",
          "must contain claim, evidence, and supersessions",
        );
      }
    } else if (result.acceptedClaimRequest !== null && result.acceptedClaimRequest !== undefined) {
      throw invalidReceipt(
        "append operator candidate claim decision",
        "acceptedClaimRequest",
        "must be absent for non-accept decisions",
      );
    }
    return result;
  }

  async function recordPolicyRecommendation(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("recordPolicyRecommendation", "must be an object");
    const result = await invoke("record candidate claim policy recommendation", RPC.recordPolicyRecommendation, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidate_claim_version_id: identity(
        input.candidateClaimVersionId,
        "candidateClaimVersionId",
        IDENTITIES.candidateClaimVersionId,
      ),
      p_sync_token: syncToken,
    }, "decisionVersionId", IDENTITIES.decisionVersionId);
    if (!["review", "reject"].includes(result.decision)
      || (result.acceptedClaimRequest !== null && result.acceptedClaimRequest !== undefined)) {
      throw invalidReceipt(
        "record candidate claim policy recommendation",
        "decision",
        "must be a non-accepting review or terminal rejection",
      );
    }
    return result;
  }

  async function authorizePolicyCorrection(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("authorizePolicyCorrection", "must be an object");
    const result = await invoke("authorize candidate claim policy correction", RPC.authorizePolicyCorrection, {
      p_workspace_key: workspaceKey,
      ...jobFields(input),
      p_candidate_claim_version_id: identity(
        input.candidateClaimVersionId,
        "candidateClaimVersionId",
        IDENTITIES.candidateClaimVersionId,
      ),
      p_sync_token: syncToken,
    }, "decisionVersionId", IDENTITIES.decisionVersionId);
    if (result.decision !== "accept"
      || !isPlainObject(result.acceptedClaimRequest)
      || !isPlainObject(result.acceptedClaimRequest.claim)
      || !Array.isArray(result.acceptedClaimRequest.evidence)
      || !Array.isArray(result.acceptedClaimRequest.supersessions)
      || result.acceptedClaimRequest.supersessions.length === 0) {
      throw invalidReceipt(
        "authorize candidate claim policy correction",
        "acceptedClaimRequest",
        "must contain an evidence-bound claim and at least one exact supersession",
      );
    }
    return result;
  }

  function requireReviewToken() {
    return string(reviewToken, "reviewToken");
  }

  async function resolveReview(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("resolveReview", "must be an object");
    const targetId = identity(
      input.targetId,
      "targetId",
      IDENTITIES.candidateClaimVersionId,
    );
    const idempotencyKey = string(input.idempotencyKey, "idempotencyKey", { maxBytes: 128 });
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw invalidArgument("idempotencyKey", "must be 32-128 base64url characters");
    }
    const expectedPreviousDecisionVersionId = input.expectedPreviousDecisionVersionId === ""
      ? ""
      : identity(
        input.expectedPreviousDecisionVersionId,
        "expectedPreviousDecisionVersionId",
        IDENTITIES.decisionVersionId,
      );
    const body = {
      p_workspace_key: workspaceKey,
      p_target_kind: "candidate_claim",
      p_target_id: targetId,
      p_expected_target_hash: string(input.expectedTargetHash, "expectedTargetHash"),
      p_expected_previous_decision_version_id: expectedPreviousDecisionVersionId,
      p_decision: string(input.decision, "decision"),
      p_policy_version: string(input.policyVersion, "policyVersion"),
      p_decided_by: string(input.decidedBy, "decidedBy"),
      p_reason: string(input.reason, "reason", { maxBytes: 2000 }),
      p_idempotency_key: idempotencyKey,
      p_review_token: requireReviewToken(),
      p_sync_token: syncToken,
    };
    if (!HASH_RE.test(body.p_expected_target_hash)) {
      throw invalidArgument("expectedTargetHash", "must be lowercase SHA-256 hex");
    }
    if (!["accept", "reject"].includes(body.p_decision)) {
      throw invalidArgument("decision", "must be accept or reject");
    }
    let result;
    try {
      result = await callRpc(RPC.resolveReview, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, "resolve candidate claim review", RPC.resolveReview);
    }
    try {
      return validateReviewReceipt(result, "resolve candidate claim review", "candidate_claim", targetId);
    } catch (error) {
      error.retryable = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function readReviewQueue(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("readReviewQueue", "must be an object");
    const targetKind = input.targetKind ?? "";
    if (!["", "candidate_claim", "link_proposal"].includes(targetKind)) {
      throw invalidArgument("targetKind", "must be empty, candidate_claim, or link_proposal");
    }
    const limit = integer(input.limit ?? 50, "limit", { minimum: 1, maximum: 100 });
    try {
      const result = await callRpc(RPC.readReviewQueue, {
        p_workspace_key: workspaceKey,
        p_target_kind: targetKind,
        p_limit: limit,
        p_review_token: requireReviewToken(),
      }, rpcOptions);
      return validateReviewQueue(result, "read truth review queue", targetKind);
    } catch (error) {
      throw normalizeRpcError(error, "read truth review queue", RPC.readReviewQueue);
    }
  }

  async function bindOperatorAcceptance(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("bindOperatorAcceptance", "must be an object");
    const result = await invoke("bind operator candidate claim acceptance", RPC.bindOperatorAcceptance, {
      p_workspace_key: workspaceKey,
      p_candidate_claim_version_id: identity(
        input.candidateClaimVersionId,
        "candidateClaimVersionId",
        IDENTITIES.candidateClaimVersionId,
      ),
      p_decision_version_id: identity(
        input.decisionVersionId,
        "decisionVersionId",
        IDENTITIES.decisionVersionId,
      ),
      p_accepted_claim_version_id: identity(
        input.acceptedClaimVersionId,
        "acceptedClaimVersionId",
        IDENTITIES.acceptedClaimVersionId,
      ),
      p_operator_token: requireOperatorToken(),
    }, "bindingId", IDENTITIES.bindingId);
    if (result.acceptedClaimVersionId !== input.acceptedClaimVersionId) {
      throw invalidReceipt(
        "bind operator candidate claim acceptance",
        "acceptedClaimVersionId",
        "does not match the requested accepted claim",
      );
    }
    return result;
  }

  return Object.freeze({
    workspaceKey,
    appendCandidate,
    appendAndSealJobCandidates,
    sealJobCandidates,
    getJobState,
    appendDecision,
    authorizePolicyAcceptance,
    bindAcceptance,
    recordPolicyRecommendation,
    authorizePolicyCorrection,
    appendOperatorDecision,
    bindOperatorAcceptance,
    resolveReview,
    readReviewQueue,
  });
}

module.exports = {
  IDENTITIES,
  RPC,
  TruthCandidateLedgerError,
  createTruthCandidateLedger,
  _test: {
    canonicalize,
    cloneJson,
    normalizeCandidate,
    normalizeDecision,
    normalizeRpcError,
    validateReviewQueue,
    validateReviewReceipt,
    sha256Json,
    validateJobStateReceipt,
    validateBatchReceipt,
    validateManifestReceipt,
    validateReceipt,
  },
};

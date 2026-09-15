"use strict";

const { createTruthCandidateLedger } = require("./truth-candidate-ledger");
const { createTruthLinkLedger } = require("./truth-link-ledger");

const RUNTIME_VERSION = "truth-review-runtime-v1";
const REQUEST_SCHEMA_VERSION = "truth-review-decision-request-v1";
const POLICY_VERSION = "truth-review-resolution-v1";
const HASH_RE = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_RE = /^candidate:v1:[0-9a-f]{64}$/;
const LINK_PROPOSAL_ID_RE = /^link-proposal:v1:[0-9a-f]{64}$/;
const CANDIDATE_DECISION_ID_RE = /^candidate-decision:v1:[0-9a-f]{64}$/;
const LINK_DECISION_ID_RE = /^link-decision:v1:[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;

class TruthReviewRuntimeError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthReviewRuntimeError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthReviewRuntimeError(`Invalid truth review ${field}: ${reason}`, {
    code: "TRUTH_REVIEW_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, field, maxBytes = 8192, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.trim() !== value || (!allowEmpty && value.length === 0)) {
    throw invalid(field, allowEmpty ? "must be a trimmed string" : "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) throw invalid(field, "must be an object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw invalid(field, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function normalizeDecisionRequest(value) {
  exactKeys(value, [
    "schemaVersion",
    "targetKind",
    "targetId",
    "expectedTargetHash",
    "expectedPreviousDecisionVersionId",
    "decision",
    "decidedBy",
    "reason",
  ], "request");
  if (value.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    throw invalid("request.schemaVersion", `must equal ${REQUEST_SCHEMA_VERSION}`);
  }
  const targetKind = boundedText(value.targetKind, "request.targetKind", 32);
  if (!["candidate_claim", "link_proposal"].includes(targetKind)) {
    throw invalid("request.targetKind", "must be candidate_claim or link_proposal");
  }
  const targetId = boundedText(value.targetId, "request.targetId", 128);
  const targetPattern = targetKind === "candidate_claim" ? CANDIDATE_ID_RE : LINK_PROPOSAL_ID_RE;
  if (!targetPattern.test(targetId)) throw invalid("request.targetId", "does not match targetKind");
  const expectedTargetHash = boundedText(value.expectedTargetHash, "request.expectedTargetHash", 64);
  if (!HASH_RE.test(expectedTargetHash)) {
    throw invalid("request.expectedTargetHash", "must be lowercase SHA-256 hex");
  }
  const previous = boundedText(
    value.expectedPreviousDecisionVersionId,
    "request.expectedPreviousDecisionVersionId",
    96,
    { allowEmpty: true },
  );
  const previousPattern = targetKind === "candidate_claim"
    ? CANDIDATE_DECISION_ID_RE
    : LINK_DECISION_ID_RE;
  if (previous && !previousPattern.test(previous)) {
    throw invalid("request.expectedPreviousDecisionVersionId", "does not match targetKind");
  }
  const decision = boundedText(value.decision, "request.decision", 16);
  if (!["accept", "reject"].includes(decision)) {
    throw invalid("request.decision", "must be accept or reject");
  }
  return Object.freeze({
    schemaVersion: REQUEST_SCHEMA_VERSION,
    targetKind,
    targetId,
    expectedTargetHash,
    expectedPreviousDecisionVersionId: previous,
    decision,
    decidedBy: boundedText(value.decidedBy, "request.decidedBy", 200),
    reason: boundedText(value.reason, "request.reason", 2000),
  });
}

function normalizeListRequest(value = {}) {
  if (!isPlainObject(value)) throw invalid("list", "must be an object");
  const allowed = new Set(["targetKind", "limit"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalid("list", "contains unsupported fields");
  }
  const targetKind = value.targetKind ?? "";
  if (!["", "candidate_claim", "link_proposal"].includes(targetKind)) {
    throw invalid("list.targetKind", "must be empty, candidate_claim, or link_proposal");
  }
  const limit = value.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw invalid("list.limit", "must be an integer from 1 through 100");
  }
  return Object.freeze({ targetKind, limit });
}

function createTruthReviewRuntime(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = boundedText(options.workspaceKey || "primary", "workspaceKey", 128);
  const policyVersion = boundedText(options.policyVersion || POLICY_VERSION, "policyVersion", 200);
  const common = {
    workspaceKey,
    reviewToken: options.reviewToken,
    syncToken: options.syncToken,
    callRpc: options.callRpc,
    rpcOptions: options.rpcOptions,
  };
  const candidateLedger = options.candidateLedger || createTruthCandidateLedger(common);
  const linkLedger = options.linkLedger || createTruthLinkLedger(common);
  if (candidateLedger?.workspaceKey !== workspaceKey
    || typeof candidateLedger.readReviewQueue !== "function"
    || typeof candidateLedger.resolveReview !== "function") {
    throw invalid("candidateLedger", "must expose the exact workspace review queue and candidate resolver");
  }
  if (linkLedger?.workspaceKey !== workspaceKey || typeof linkLedger.resolveReview !== "function") {
    throw invalid("linkLedger", "must expose the exact workspace link resolver");
  }

  async function list(input = {}) {
    const request = normalizeListRequest(input);
    return candidateLedger.readReviewQueue(request);
  }

  async function resolve(input = {}) {
    if (!isPlainObject(input)) throw invalid("resolve", "must be an object");
    const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 128);
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw invalid("idempotencyKey", "must be 32-128 base64url characters");
    }
    const request = normalizeDecisionRequest(input.request);
    const ledger = request.targetKind === "candidate_claim" ? candidateLedger : linkLedger;
    try {
      return await ledger.resolveReview({
        ...request,
        idempotencyKey,
        policyVersion,
      });
    } catch (error) {
      if (error instanceof TruthReviewRuntimeError) throw error;
      throw new TruthReviewRuntimeError(`Truth review resolution failed: ${error?.message || String(error)}`, {
        code: String(error?.code || "TRUTH_REVIEW_RESOLUTION_FAILED"),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        safeToRetryWithSameIdempotencyKey: true,
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    workspaceKey,
    policyVersion,
    list,
    resolve,
  });
}

module.exports = Object.freeze({
  IDEMPOTENCY_KEY_RE,
  POLICY_VERSION,
  REQUEST_SCHEMA_VERSION,
  RUNTIME_VERSION,
  TruthReviewRuntimeError,
  createTruthReviewRuntime,
  normalizeDecisionRequest,
  normalizeListRequest,
  _test: Object.freeze({ boundedText, exactKeys, isPlainObject }),
});

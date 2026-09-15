"use strict";

const crypto = require("node:crypto");
const { postgresJsonbText } = require("./postgres-jsonb");

const RPC = Object.freeze({
  loadParentPlanningContext: "load_gmail_parent_planning_context",
  resumeSealedParentPlan: "resume_truth_shadow_gmail_sealed_model_parent",
  sealParentPlan: "seal_gmail_model_extraction_plan",
  reconcileStaleParentPlan: "reconcile_stale_shadow_gmail_extraction_plan",
  loadModelContext: "load_gmail_model_extraction_context",
  recordResult: "record_gmail_model_extraction_result",
  createReview: "create_gmail_model_extraction_review",
  createStaleTimeBindingReview: "create_truth_shadow_stale_gmail_model_review",
  resolveReview: "resolve_gmail_model_extraction_review",
});

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBSERVATION_RE = /^obs:v1:[0-9a-f]{64}$/;
const EXTRACTION_PLAN_RE = /^gmail-extraction-plan:v1:[0-9a-f]{64}$/;
const MODEL_PLAN_RE = /^gmail-model-plan:v1:[0-9a-f]{64}$/;
const CONTEXT_SEAL_RE = /^gmail-model-context:v1:[0-9a-f]{64}$/;
const MODEL_REQUEST_RE = /^model-request:v1:[0-9a-f]{64}$/;
const CANDIDATE_RE = /^candidate:v1:[0-9a-f]{64}$/;
const REVIEW_INTENT_RE = /^gmail-model-review-intent:v1:[0-9a-f]{64}$/;
const REVIEW_OBLIGATION_RE = /^gmail-model-review:v1:[0-9a-f]{64}$/;
const REVIEW_RESOLUTION_RE = /^gmail-model-review-resolution:v1:[0-9a-f]{64}$/;
const PLAN_RECONCILIATION_RE = /^gmail-plan-reconciliation:v1:[0-9a-f]{64}$/;
const REASON_RE = /^[A-Z][A-Z0-9_]{2,99}$/;
const ROOT_INGEST_MODES = Object.freeze([
  "history",
  "backfill",
  "reconciliation",
  "cutover_delta_reconciliation",
  "snapshot",
  "snapshot_recovery",
]);
const PLANNING_BOUNDS = Object.freeze({
  acceptedClaims: 64,
  linkedObservations: 32,
  linkedThreads: 16,
  workgroupMemberships: 64,
  sourceTextBytes: 65536,
});

class TruthGmailModelPlanLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthGmailModelPlanLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthGmailModelPlanLedgerError(`Invalid Gmail model-plan argument ${field}: ${reason}`, {
    code: "TRUTH_GMAIL_MODEL_PLAN_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, field, reason) {
  return new TruthGmailModelPlanLedgerError(`Invalid ${operation} receipt ${field}: ${reason}`, {
    code: "TRUTH_GMAIL_MODEL_PLAN_INVALID_RECEIPT",
    operation,
    field,
    retryable: !/^(?:load|read)\b/.test(operation),
    outcomeUnknown: !/^(?:load|read)\b/.test(operation),
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 40) throw invalidArgument(field, "exceeds maximum JSON depth");
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
  throw invalidArgument(field, "must contain JSON-compatible values only");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function text(value, field, maximum = 8192, { empty = false } = {}) {
  if (typeof value !== "string" || value.trim() !== value || (!empty && !value)
    || Buffer.byteLength(value, "utf8") > maximum) {
    throw invalidArgument(field, `must be a${empty ? "" : " non-empty"} trimmed string of at most ${maximum} bytes`);
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function match(value, field, pattern) {
  const result = text(value, field, 512);
  if (!pattern.test(result)) throw invalidArgument(field, "has an invalid content-addressed identity");
  return result;
}

function exactKeys(value, expected, field, operation) {
  if (!isPlainObject(value)) throw invalidReceipt(operation, field, "must be an object");
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    throw invalidReceipt(operation, field, `must contain exactly ${keys.join(", ")}`);
  }
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function postgresHash(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(value), "utf8").digest("hex");
}

function normalizeError(error, operation, rpc) {
  if (error instanceof TruthGmailModelPlanLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  const status = Number(cause.status ?? cause.statusCode);
  const code = String(cause.code || "TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED");
  return new TruthGmailModelPlanLedgerError(`${operation} failed: ${cause.message}`, {
    code,
    operation,
    rpc,
    status: Number.isFinite(status) ? status : null,
    retryable: typeof cause.retryable === "boolean" ? cause.retryable
      : code === "40001" || code === "54000" || status === 408 || status === 409
        || status === 429 || status >= 500,
    deadlineExceeded: cause.deadlineExceeded === true,
    outcomeUnknown: cause.outcomeUnknown === true,
    cause,
  });
}

function jobFields(input) {
  if (!isPlainObject(input)) throw invalidArgument("job", "must be an object");
  return {
    p_job_id: match(input.jobId, "jobId", UUID_RE),
    p_worker_id: text(input.workerId, "workerId", 500),
    p_lease_fence: integer(input.leaseFence, "leaseFence", 1, Number.MAX_SAFE_INTEGER),
    p_processor_version: text(input.processorVersion, "processorVersion", 500),
  };
}

function normalizeCandidate(candidate, field) {
  if (!isPlainObject(candidate)) throw invalidArgument(field, "must be an object");
  const value = cloneJson(candidate, field);
  const id = match(value.candidateClaimVersionId, `${field}.candidateClaimVersionId`, CANDIDATE_RE);
  const hash = match(value.candidateHash, `${field}.candidateHash`, HASH_RE);
  if (id !== `candidate:v1:${hash}`) throw invalidArgument(field, "candidate identity differs from hash");
  delete value.candidateClaimVersionId;
  delete value.candidateHash;
  if (sha256Json(value) !== hash) throw invalidArgument(field, "candidate hash differs from canonical body");
  return { candidateClaimVersionId: id, candidateHash: hash, ...value };
}

function normalizeCoverageWitness(value, field, candidates) {
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  const expected = ["candidateClaimVersionId", "predicate", "signalSpan", "coverageSpan"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected.sort())) {
    throw invalidArgument(field, "must contain one exact deterministic coverage witness");
  }
  const candidateClaimVersionId = match(
    value.candidateClaimVersionId,
    `${field}.candidateClaimVersionId`,
    CANDIDATE_RE,
  );
  const candidate = candidates.find((item) => item.candidateClaimVersionId === candidateClaimVersionId);
  if (!candidate || candidate.extractionMethod !== "deterministic"
    || candidate.predicate !== value.predicate) {
    throw invalidArgument(field, "does not identify its deterministic candidate and predicate");
  }
  const normalizeSpan = (span, spanField) => {
    if (!isPlainObject(span)
      || JSON.stringify(Object.keys(span).sort()) !== JSON.stringify(["end", "quoteHash", "start"])) {
      throw invalidArgument(spanField, "must contain exact bounded span identity");
    }
    return {
      start: integer(span.start, `${spanField}.start`, 0, Number.MAX_SAFE_INTEGER),
      end: integer(span.end, `${spanField}.end`, 1, Number.MAX_SAFE_INTEGER),
      quoteHash: match(span.quoteHash, `${spanField}.quoteHash`, HASH_RE),
    };
  };
  const signalSpan = normalizeSpan(value.signalSpan, `${field}.signalSpan`);
  const coverageSpan = normalizeSpan(value.coverageSpan, `${field}.coverageSpan`);
  if (signalSpan.end <= signalSpan.start || coverageSpan.end <= coverageSpan.start
    || signalSpan.start < coverageSpan.start || signalSpan.end > coverageSpan.end) {
    throw invalidArgument(field, "signal span must be contained by its deterministic coverage span");
  }
  return { candidateClaimVersionId, predicate: value.predicate, signalSpan, coverageSpan };
}

function normalizeExtractionPlan(value) {
  if (!isPlainObject(value)) throw invalidArgument("extractionPlan", "must be an object");
  const plan = cloneJson(value, "extractionPlan");
  const expected = [
    "extractionPlanId", "extractionPlanHash", "schemaVersion", "sourceObservationId",
    "sourceObservationContentHash", "extractorVersion", "deterministicCandidates",
    "deterministicCoverage", "modelPlan",
  ];
  if (plan.schemaVersion === "gmail-claim-extraction-plan-failure-v2") expected.push("planningFailure");
  if (JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(expected.sort())) {
    throw invalidArgument("extractionPlan", "contains unsupported or missing fields");
  }
  match(plan.extractionPlanId, "extractionPlan.extractionPlanId", EXTRACTION_PLAN_RE);
  match(plan.extractionPlanHash, "extractionPlan.extractionPlanHash", HASH_RE);
  match(plan.sourceObservationId, "extractionPlan.sourceObservationId", OBSERVATION_RE);
  match(plan.sourceObservationContentHash, "extractionPlan.sourceObservationContentHash", HASH_RE);
  text(plan.extractorVersion, "extractionPlan.extractorVersion", 500);
  const candidateLimit = plan.schemaVersion === "gmail-claim-extraction-plan-failure-v2" ? 2000 : 50;
  if (!Array.isArray(plan.deterministicCandidates)
    || plan.deterministicCandidates.length > candidateLimit) {
    throw invalidArgument(
      "extractionPlan.deterministicCandidates",
      `must contain at most ${candidateLimit} candidates`,
    );
  }
  plan.deterministicCandidates = plan.deterministicCandidates.map((item, index) => (
    normalizeCandidate(item, `extractionPlan.deterministicCandidates[${index}]`)
  ));
  if (!Array.isArray(plan.deterministicCoverage)
    || plan.deterministicCoverage.length !== plan.deterministicCandidates.length) {
    throw invalidArgument("extractionPlan.deterministicCoverage", "must cover every deterministic candidate exactly once");
  }
  plan.deterministicCoverage = plan.deterministicCoverage.map((item, index) => (
    normalizeCoverageWitness(item, `extractionPlan.deterministicCoverage[${index}]`, plan.deterministicCandidates)
  ));
  if (new Set(plan.deterministicCoverage.map((item) => item.candidateClaimVersionId)).size
      !== plan.deterministicCoverage.length) {
    throw invalidArgument("extractionPlan.deterministicCoverage", "must identify unique deterministic candidates");
  }
  if (plan.schemaVersion === "gmail-claim-extraction-plan-failure-v2") {
    if (plan.modelPlan !== null || !isPlainObject(plan.planningFailure)
      || JSON.stringify(Object.keys(plan.planningFailure).sort()) !== JSON.stringify(["code", "detailHash"])
      || !REASON_RE.test(String(plan.planningFailure.code || ""))
      || !HASH_RE.test(String(plan.planningFailure.detailHash || ""))) {
      throw invalidArgument("extractionPlan.planningFailure", "must be a bounded review-required planning failure");
    }
  } else if (plan.schemaVersion !== "gmail-claim-extraction-plan-v3") {
    throw invalidArgument("extractionPlan.schemaVersion", "is unsupported");
  } else if (plan.modelPlan !== null) {
    const modelPlanKeys = [
      "modelPlanId", "modelPlanHash", "schemaVersion", "sourceObservationId",
      "sourceObservationContentHash", "sourceMessageId", "sourceThreadId", "sourceCapturedAt",
      "sourceRecordedAt", "sourceMessageDate", "extractorVersion", "promptVersion",
      "responseSchemaVersion", "config", "workgroupContextHash", "acceptedClaimsContextHash",
      "modelInput",
    ].sort();
    if (!isPlainObject(plan.modelPlan)
      || JSON.stringify(Object.keys(plan.modelPlan).sort()) !== JSON.stringify(modelPlanKeys)
      || plan.modelPlan.schemaVersion !== "gmail-model-extraction-plan-v2"
      || !MODEL_PLAN_RE.test(String(plan.modelPlan.modelPlanId || ""))
      || !HASH_RE.test(String(plan.modelPlan.modelPlanHash || ""))
      || plan.modelPlan.modelPlanId !== `gmail-model-plan:v1:${plan.modelPlan.modelPlanHash}`
      || plan.modelPlan.sourceObservationId !== plan.sourceObservationId
      || plan.modelPlan.sourceObservationContentHash !== plan.sourceObservationContentHash
      || plan.modelPlan.extractorVersion !== plan.extractorVersion
      || !isPlainObject(plan.modelPlan.config)
      || !isPlainObject(plan.modelPlan.modelInput)
      || !HASH_RE.test(String(plan.modelPlan.workgroupContextHash || ""))
      || !HASH_RE.test(String(plan.modelPlan.acceptedClaimsContextHash || ""))
      || !HASH_RE.test(String(plan.modelPlan.modelInput.normalizedTextHash || ""))
      || typeof plan.modelPlan.promptVersion !== "string" || !plan.modelPlan.promptVersion
      || typeof plan.modelPlan.responseSchemaVersion !== "string" || !plan.modelPlan.responseSchemaVersion
      || Buffer.byteLength(JSON.stringify(plan.modelPlan), "utf8") > 524288) {
      throw invalidArgument("extractionPlan.modelPlan", "is not a bounded immutable Gmail model plan");
    }
    const { modelPlanId, modelPlanHash, ...modelPlanBody } = plan.modelPlan;
    if (sha256Json(modelPlanBody) !== modelPlanHash) {
      throw invalidArgument("extractionPlan.modelPlan.modelPlanHash", "differs from canonical content");
    }
  }
  const { extractionPlanId, extractionPlanHash, ...body } = plan;
  if (extractionPlanId !== `gmail-extraction-plan:v1:${extractionPlanHash}`
    || sha256Json(body) !== extractionPlanHash) {
    throw invalidArgument("extractionPlan.extractionPlanHash", "differs from canonical content");
  }
  return deepFreeze({ extractionPlanId, extractionPlanHash, ...body });
}

function buildPlanningFailurePlan(input = {}) {
  if (!isPlainObject(input)) throw invalidArgument("planningFailure", "must be an object");
  const observation = input.observation;
  if (!isPlainObject(observation)) throw invalidArgument("planningFailure.observation", "must be an object");
  const deterministicCandidates = (input.deterministicCandidates || []).map((candidate, index) => (
    normalizeCandidate(candidate, `planningFailure.deterministicCandidates[${index}]`)
  ));
  if (deterministicCandidates.length > 2000) {
    throw invalidArgument("planningFailure.deterministicCandidates", "exceeds 2000");
  }
  const deterministicCoverage = (input.deterministicCoverage || []).map((item, index) => (
    normalizeCoverageWitness(item, `planningFailure.deterministicCoverage[${index}]`, deterministicCandidates)
  ));
  if (deterministicCoverage.length !== deterministicCandidates.length) {
    throw invalidArgument("planningFailure.deterministicCoverage", "must cover every deterministic candidate");
  }
  const body = {
    schemaVersion: "gmail-claim-extraction-plan-failure-v2",
    sourceObservationId: match(observation.observationId, "planningFailure.observation.observationId", OBSERVATION_RE),
    sourceObservationContentHash: match(observation.contentHash, "planningFailure.observation.contentHash", HASH_RE),
    extractorVersion: text(input.extractorVersion, "planningFailure.extractorVersion", 500),
    deterministicCandidates,
    deterministicCoverage,
    modelPlan: null,
    planningFailure: {
      code: match(input.code, "planningFailure.code", REASON_RE),
      detailHash: match(input.detailHash, "planningFailure.detailHash", HASH_RE),
    },
  };
  const extractionPlanHash = sha256Json(body);
  return deepFreeze({
    extractionPlanId: `gmail-extraction-plan:v1:${extractionPlanHash}`,
    extractionPlanHash,
    ...body,
  });
}

function validatePlanReceipt(value, operation, workspaceKey, jobId, expectedPlan) {
  exactKeys(value, [
    "ok", "idempotent", "schemaVersion", "workspaceKey", "parentJobId",
    "extractionPlanId", "extractionPlanHash", "deterministicManifestHash",
    "deterministicCandidateCount", "materializedDeterministicCandidateCount",
    "plannedDeterministicCandidateSetHash", "contextSealId", "modelPlanId", "executionMode",
    "rootIngestMode", "planningStatus", "planningFailureCode", "planSealHash",
    "mutatesOperationalState",
  ], "result", operation);
  if (value.ok !== true || typeof value.idempotent !== "boolean"
    || value.schemaVersion !== "gmail-model-extraction-plan-receipt-v1"
    || value.workspaceKey !== workspaceKey || value.parentJobId !== jobId
    || value.extractionPlanId !== expectedPlan.extractionPlanId
    || value.extractionPlanHash !== expectedPlan.extractionPlanHash
    || !HASH_RE.test(String(value.deterministicManifestHash || ""))
    || value.deterministicCandidateCount !== expectedPlan.deterministicCandidates.length
    || value.materializedDeterministicCandidateCount !== (
      expectedPlan.schemaVersion === "gmail-claim-extraction-plan-failure-v2"
        ? 0
        : expectedPlan.deterministicCandidates.length
    )
    || value.plannedDeterministicCandidateSetHash
      !== sha256Json(expectedPlan.deterministicCandidates)
    || !CONTEXT_SEAL_RE.test(String(value.contextSealId || ""))
    || !["none", "sync", "batch", "parked"].includes(value.executionMode)
    || !ROOT_INGEST_MODES.includes(value.rootIngestMode)
    || !["complete", "review_required"].includes(value.planningStatus)
    || !HASH_RE.test(String(value.planSealHash || ""))
    || value.mutatesOperationalState !== false) {
    throw invalidReceipt(operation, "result", "does not match the sealed parent request");
  }
  if (value.modelPlanId && !MODEL_PLAN_RE.test(value.modelPlanId)) {
    throw invalidReceipt(operation, "modelPlanId", "is invalid");
  }
  const expectedModelPlanId = expectedPlan.modelPlan?.modelPlanId || "";
  if (value.modelPlanId !== expectedModelPlanId) {
    throw invalidReceipt(operation, "modelPlanId", "differs from the requested immutable plan");
  }
  if (expectedPlan.schemaVersion === "gmail-claim-extraction-plan-failure-v2") {
    if (value.planningStatus !== "review_required"
      || value.executionMode !== "none"
      || value.planningFailureCode !== expectedPlan.planningFailure.code) {
      throw invalidReceipt(operation, "planningFailureCode", "must expose the durable review reason");
    }
  } else if (value.planningStatus !== "complete" || value.planningFailureCode !== ""
    || (expectedModelPlanId === "" && value.executionMode !== "none")
    || (expectedModelPlanId !== "" && value.executionMode === "none")) {
    throw invalidReceipt(operation, "planningStatus", "differs from the requested complete plan");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateResumedPlanReceipt(value, operation, workspaceKey, jobId) {
  exactKeys(value, [
    "ok", "status", "schemaVersion", "workspaceKey", "parentJobId",
    "extractionPlanId", "extractionPlanHash", "deterministicManifestHash",
    "deterministicCandidateCount", "materializedDeterministicCandidateCount",
    "plannedDeterministicCandidateSetHash", "contextSealId", "modelPlanId",
    "executionMode", "rootIngestMode", "planningStatus", "planningFailureCode",
    "planSealHash", "shadowOnly", "mutatesOperationalState",
    "productionPublicationAttempted",
  ], "result", operation);
  if (value.ok !== true
    || value.schemaVersion !== "gmail-sealed-model-parent-resume-receipt-v1"
    || value.workspaceKey !== workspaceKey
    || value.parentJobId !== jobId
    || value.shadowOnly !== true
    || value.mutatesOperationalState !== false
    || value.productionPublicationAttempted !== false
    || !["not_resumable", "resumed_sealed_model_plan"].includes(value.status)) {
    throw invalidReceipt(operation, "result", "does not match the fenced shadow resume contract");
  }
  if (value.status === "not_resumable") {
    if (value.extractionPlanId !== "" || value.extractionPlanHash !== ""
      || value.deterministicManifestHash !== ""
      || value.deterministicCandidateCount !== 0
      || value.materializedDeterministicCandidateCount !== 0
      || value.plannedDeterministicCandidateSetHash !== ""
      || value.contextSealId !== "" || value.modelPlanId !== ""
      || value.executionMode !== "none" || value.rootIngestMode !== ""
      || value.planningStatus !== "" || value.planningFailureCode !== ""
      || value.planSealHash !== "") {
      throw invalidReceipt(operation, "result", "leaks or invents a non-resumable plan");
    }
    return deepFreeze(cloneJson(value, `${operation}.receipt`));
  }
  if (!EXTRACTION_PLAN_RE.test(String(value.extractionPlanId || ""))
    || !HASH_RE.test(String(value.extractionPlanHash || ""))
    || value.extractionPlanId !== `gmail-extraction-plan:v1:${value.extractionPlanHash}`
    || !HASH_RE.test(String(value.deterministicManifestHash || ""))
    || !Number.isSafeInteger(value.deterministicCandidateCount)
    || value.deterministicCandidateCount < 0 || value.deterministicCandidateCount > 2000
    || !Number.isSafeInteger(value.materializedDeterministicCandidateCount)
    || value.materializedDeterministicCandidateCount < 0
    || value.materializedDeterministicCandidateCount > 50
    || value.materializedDeterministicCandidateCount !== value.deterministicCandidateCount
    || !HASH_RE.test(String(value.plannedDeterministicCandidateSetHash || ""))
    || !CONTEXT_SEAL_RE.test(String(value.contextSealId || ""))
    || !MODEL_PLAN_RE.test(String(value.modelPlanId || ""))
    || !["sync", "batch", "parked"].includes(value.executionMode)
    || !ROOT_INGEST_MODES.includes(value.rootIngestMode)
    || value.planningStatus !== "complete" || value.planningFailureCode !== ""
    || !HASH_RE.test(String(value.planSealHash || ""))) {
    throw invalidReceipt(operation, "result", "is not one complete self-owned model plan");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validatePlanReconciliationReceipt(value, operation, expected) {
  exactKeys(value, [
    "ok", "idempotent", "status", "schemaVersion", "workspaceKey",
    "staleParentJobId", "successorJobId", "reconciliationId", "reconciliationHash",
    "staleExtractionPlanId", "staleExtractionPlanHash", "expectedExtractionPlanId",
    "expectedExtractionPlanHash", "deterministicCandidateCount",
    "plannedDeterministicCandidateSetHash", "shadowOnly", "mutatesOperationalState",
    "productionPublicationAttempted",
  ], "result", operation);
  if (value.ok !== true || typeof value.idempotent !== "boolean"
    || value.status !== "requeued_current_plan"
    || value.schemaVersion !== "gmail-stale-extraction-plan-reconciliation-receipt-v1"
    || value.workspaceKey !== expected.workspaceKey
    || value.staleParentJobId !== expected.jobId
    || !UUID_RE.test(String(value.successorJobId || ""))
    || !PLAN_RECONCILIATION_RE.test(String(value.reconciliationId || ""))
    || !HASH_RE.test(String(value.reconciliationHash || ""))
    || value.reconciliationId !== `gmail-plan-reconciliation:v1:${value.reconciliationHash}`
    || !EXTRACTION_PLAN_RE.test(String(value.staleExtractionPlanId || ""))
    || !HASH_RE.test(String(value.staleExtractionPlanHash || ""))
    || value.staleExtractionPlanId !== `gmail-extraction-plan:v1:${value.staleExtractionPlanHash}`
    || value.expectedExtractionPlanId !== expected.plan.extractionPlanId
    || value.expectedExtractionPlanHash !== expected.plan.extractionPlanHash
    || value.deterministicCandidateCount !== expected.plan.deterministicCandidates.length
    || value.plannedDeterministicCandidateSetHash
      !== sha256Json(expected.plan.deterministicCandidates)
    || value.shadowOnly !== true
    || value.mutatesOperationalState !== false
    || value.productionPublicationAttempted !== false) {
    throw invalidReceipt(operation, "result", "does not prove one exact shadow-only successor");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateParentPlanningContext(value, operation, expected) {
  exactKeys(value, [
    "ok", "schemaVersion", "workspaceKey", "parentJobId", "workerId", "leaseFence",
    "processorVersion", "status", "sourceObservationId", "sourceObservationContentHash",
    "claimContext", "claimContextHash", "observation", "bounds", "failureDimension",
    "reasonCode", "safeDetailHash", "mutatesOperationalState", "planningContextHash",
  ], "result", operation);
  const core = cloneJson(value, `${operation}.receipt`);
  delete core.ok;
  delete core.planningContextHash;
  if (value.ok !== true || value.schemaVersion !== "gmail-parent-planning-context-receipt-v1"
    || value.workspaceKey !== expected.workspaceKey || value.parentJobId !== expected.jobId
    || value.workerId !== expected.workerId || value.leaseFence !== expected.leaseFence
    || value.processorVersion !== expected.processorVersion
    || !["ready", "review_required"].includes(value.status)
    || !OBSERVATION_RE.test(String(value.sourceObservationId || ""))
    || !HASH_RE.test(String(value.sourceObservationContentHash || ""))
    || !isPlainObject(value.bounds)
    || JSON.stringify(Object.keys(value.bounds).sort())
      !== JSON.stringify(Object.keys(PLANNING_BOUNDS).sort())
    || Object.entries(PLANNING_BOUNDS).some(([key, bound]) => value.bounds[key] !== bound)
    || value.mutatesOperationalState !== false
    || !HASH_RE.test(String(value.planningContextHash || ""))
    || postgresHash(core) !== value.planningContextHash) {
    throw invalidReceipt(operation, "result", "does not match the fixed parent planning context contract");
  }
  if (value.status === "review_required") {
    if (value.claimContext !== null || value.claimContextHash !== ""
      || !isPlainObject(value.observation)
      || JSON.stringify(Object.keys(value.observation).sort())
        !== JSON.stringify(["contentHash", "observationId"])
      || value.observation.observationId !== value.sourceObservationId
      || value.observation.contentHash !== value.sourceObservationContentHash
      || !["source_text_bytes", "claim_or_workgroup_collection", "linked_observations",
        "linked_threads", "workgroup_memberships", "ambiguous_workgroups"].includes(value.failureDimension)
      || !(
        (value.failureDimension === "ambiguous_workgroups"
          && value.reasonCode === "MODEL_CONTEXT_WORKGROUP_AMBIGUOUS")
        || (value.failureDimension !== "ambiguous_workgroups"
          && value.reasonCode === "MODEL_PLAN_BOUNDS_EXCEEDED")
      )
      || !HASH_RE.test(String(value.safeDetailHash || ""))) {
      throw invalidReceipt(operation, "result", "is not a bounded planning-review receipt");
    }
  } else {
    if (!isPlainObject(value.claimContext)
      || value.claimContext.schemaVersion !== "truth-claim-worker-context-receipt-v2"
      || value.claimContextHash !== value.claimContext.contextHash
      || !HASH_RE.test(String(value.claimContextHash || ""))
      || !Array.isArray(value.claimContext.acceptedClaims)
      || value.claimContext.acceptedClaims.length > PLANNING_BOUNDS.acceptedClaims
      || !isPlainObject(value.observation)
      || value.observation.observationId !== value.sourceObservationId
      || value.observation.contentHash !== value.sourceObservationContentHash
      || typeof value.observation.normalizedText !== "string"
      || Buffer.byteLength(value.observation.normalizedText, "utf8") > PLANNING_BOUNDS.sourceTextBytes
      || value.failureDimension !== "" || value.reasonCode !== "" || value.safeDetailHash !== "") {
      throw invalidReceipt(operation, "result", "is not exact bounded planning evidence");
    }
    if (value.claimContext.workgroupContext !== null) {
      if (!isPlainObject(value.claimContext.workgroupContext)
        || !Array.isArray(value.claimContext.workgroupContext.linkedObservationIds)
        || value.claimContext.workgroupContext.linkedObservationIds.length > PLANNING_BOUNDS.linkedObservations
        || !Array.isArray(value.claimContext.workgroupContext.linkedThreadIds)
        || value.claimContext.workgroupContext.linkedThreadIds.length > PLANNING_BOUNDS.linkedThreads) {
        throw invalidReceipt(operation, "claimContext", "exceeds the fixed cross-thread bounds");
      }
    }
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateModelContext(value, operation, expected) {
  exactKeys(value, [
    "schemaVersion", "workspaceKey", "jobId", "jobKind", "workerId", "leaseFence",
    "processorVersion", "extractionPlanId", "modelPlanId", "executionMode", "rootIngestMode",
    "contextSealId", "contextSealHash", "deterministicManifestHash", "modelPlan", "observation",
    "processingConfigVersion", "processingConfigHash",
    "workgroupContext", "acceptedClaims", "contextObservationMembership", "workgroupMembership",
    "ok", "contextHash",
  ], "result", operation);
  const core = cloneJson(value, `${operation}.receipt`);
  delete core.ok;
  delete core.contextHash;
  if (value.ok !== true || value.schemaVersion !== "gmail-model-extraction-context-receipt-v1"
    || value.workspaceKey !== expected.workspaceKey || value.jobId !== expected.jobId
    || value.jobKind !== "gmail_extract_message_model_claims"
    || value.workerId !== expected.workerId || value.leaseFence !== expected.leaseFence
    || value.processorVersion !== expected.processorVersion
    || !EXTRACTION_PLAN_RE.test(String(value.extractionPlanId || ""))
    || !MODEL_PLAN_RE.test(String(value.modelPlanId || ""))
    || !["sync", "batch", "parked"].includes(value.executionMode)
    || !ROOT_INGEST_MODES.includes(value.rootIngestMode)
    || !CONTEXT_SEAL_RE.test(String(value.contextSealId || ""))
    || !HASH_RE.test(String(value.contextSealHash || ""))
    || value.contextSealId !== `gmail-model-context:v1:${value.contextSealHash}`
    || !HASH_RE.test(String(value.deterministicManifestHash || ""))
    || value.processingConfigVersion !== "truth-model-processing-config-v1"
    || value.processingConfigHash
      !== "6f7405ff0735b445dc43240927df7c0b193a7639892b4660c82f2ee087b625e4"
    || !HASH_RE.test(String(value.contextHash || ""))
    || postgresHash(core) !== value.contextHash) {
    throw invalidReceipt(operation, "result", "does not match the exact fenced model child context");
  }
  if (!isPlainObject(value.modelPlan)
    || value.modelPlan.modelPlanId !== value.modelPlanId
    || value.modelPlan.modelPlanHash !== value.modelPlanId.slice("gmail-model-plan:v1:".length)) {
    throw invalidReceipt(operation, "modelPlan", "does not match the sealed model identity");
  }
  const { modelPlanId, modelPlanHash, ...modelBody } = value.modelPlan;
  if (sha256Json(modelBody) !== modelPlanHash) {
    throw invalidReceipt(operation, "modelPlan.modelPlanHash", "differs from canonical content");
  }
  if (!isPlainObject(value.observation) || !OBSERVATION_RE.test(String(value.observation.observationId || ""))
    || !HASH_RE.test(String(value.observation.contentHash || ""))
    || typeof value.observation.normalizedText !== "string"
    || Buffer.byteLength(value.observation.normalizedText, "utf8") > 65536
    || value.observation.observationId !== value.modelPlan.sourceObservationId
    || value.observation.contentHash !== value.modelPlan.sourceObservationContentHash
    || !isPlainObject(value.modelPlan.modelInput)
    || value.modelPlan.modelInput.normalizedTextHash
      !== crypto.createHash("sha256").update(value.observation.normalizedText, "utf8").digest("hex")) {
    throw invalidReceipt(operation, "observation", "is not bounded immutable Gmail evidence");
  }
  if (!Array.isArray(value.acceptedClaims) || value.acceptedClaims.length > 64
    || !Array.isArray(value.contextObservationMembership) || value.contextObservationMembership.length > 32
    || !Array.isArray(value.workgroupMembership) || value.workgroupMembership.length > 64) {
    throw invalidReceipt(operation, "context", "exceeds a durable model replay bound");
  }
  if (value.workgroupContext !== null) {
    if (!isPlainObject(value.workgroupContext)
      || !Array.isArray(value.workgroupContext.linkedThreadIds)
      || value.workgroupContext.linkedThreadIds.length > 16
      || !Array.isArray(value.workgroupContext.linkedObservationIds)
      || value.workgroupContext.linkedObservationIds.length > 32) {
      throw invalidReceipt(operation, "workgroupContext", "exceeds cross-thread model context bounds");
    }
  }
  const acceptedClaimsForPlan = value.acceptedClaims.map((claim) => {
    const normalized = cloneJson(claim, "acceptedClaims");
    delete normalized.itemHash;
    return normalized;
  });
  if (value.modelPlan.workgroupContextHash !== sha256Json(value.workgroupContext)
    || value.modelPlan.acceptedClaimsContextHash !== sha256Json(acceptedClaimsForPlan)) {
    throw invalidReceipt(operation, "context", "differs from the model plan context hashes");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateResultReceipt(value, operation, expected) {
  exactKeys(value, [
    "ok", "idempotent", "schemaVersion", "workspaceKey", "modelPlanId", "modelChildJobId",
    "modelRequestId", "providerResponseId", "modelAttemptOutcomeId", "providerResultHash",
    "normalizedResultHash", "candidateManifestHash", "candidateCount", "model", "promptVersion",
    "mutatesOperationalState", "publishesTruth",
  ], "result", operation);
  if (value.ok !== true || typeof value.idempotent !== "boolean"
    || value.schemaVersion !== "gmail-model-extraction-result-receipt-v1"
    || value.workspaceKey !== expected.workspaceKey || value.modelPlanId !== expected.modelPlanId
    || value.modelChildJobId !== expected.jobId || value.modelRequestId !== expected.modelRequestId
    || value.providerResponseId !== expected.providerResponseId
    || !/^model-outcome:v1:[0-9a-f]{64}$/.test(String(value.modelAttemptOutcomeId || ""))
    || !HASH_RE.test(String(value.providerResultHash || ""))
    || !HASH_RE.test(String(value.normalizedResultHash || ""))
    || !HASH_RE.test(String(value.candidateManifestHash || ""))
    || value.candidateCount !== expected.candidateCount
    || value.model !== expected.model || value.promptVersion !== expected.promptVersion
    || value.mutatesOperationalState !== false || value.publishesTruth !== false) {
    throw invalidReceipt(operation, "result", "does not match the successful model request");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateIntentReceipt(value, operation, expected) {
  exactKeys(value, [
    "ok", "idempotent", "schemaVersion", "workspaceKey", "modelPlanId", "modelChildJobId",
    "intentId", "reasonCode", "safeDetailHash", "mutatesOperationalState", "publishesTruth",
  ], "result", operation);
  if (value.ok !== true || typeof value.idempotent !== "boolean"
    || value.schemaVersion !== "gmail-model-extraction-review-intent-receipt-v1"
    || value.workspaceKey !== expected.workspaceKey || value.modelPlanId !== expected.modelPlanId
    || value.modelChildJobId !== expected.jobId || !REVIEW_INTENT_RE.test(String(value.intentId || ""))
    || value.reasonCode !== expected.reasonCode || value.safeDetailHash !== expected.safeDetailHash
    || value.mutatesOperationalState !== false || value.publishesTruth !== false) {
    throw invalidReceipt(operation, "result", "does not match the terminal review intent");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateResolutionReceipt(value, operation, expected) {
  exactKeys(value, [
    "ok", "idempotent", "schemaVersion", "resolutionId", "workspaceKey", "obligationId",
    "extractionPlanId", "modelPlanId", "reviewJobId", "decision",
    "resolutionEvidenceObservationIds", "mutatesOperationalState", "publishesTruth",
  ], "result", operation);
  if (value.ok !== true || typeof value.idempotent !== "boolean"
    || value.schemaVersion !== "gmail-model-extraction-review-resolution-receipt-v1"
    || !REVIEW_RESOLUTION_RE.test(String(value.resolutionId || ""))
    || value.workspaceKey !== expected.workspaceKey || value.obligationId !== expected.obligationId
    || !EXTRACTION_PLAN_RE.test(String(value.extractionPlanId || ""))
    || (value.modelPlanId && !MODEL_PLAN_RE.test(value.modelPlanId))
    || !UUID_RE.test(String(value.reviewJobId || "")) || value.decision !== expected.decision
    || !Array.isArray(value.resolutionEvidenceObservationIds)
    || JSON.stringify(value.resolutionEvidenceObservationIds) !== JSON.stringify(expected.evidence)
    || value.mutatesOperationalState !== false || value.publishesTruth !== false) {
    throw invalidReceipt(operation, "result", "does not match the exact review resolution");
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function createTruthGmailModelPlanLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = text(options.workspaceKey ?? "primary", "workspaceKey", 200);
  const syncToken = text(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", 4096);
  const rawReviewToken = options.reviewToken ?? process.env.PQ_TRUTH_REVIEW_TOKEN ?? null;
  const reviewToken = rawReviewToken === null ? null : text(rawReviewToken, "reviewToken", 4096);
  const maxContextItems = integer(options.maxContextItems ?? 64, "maxContextItems", 64, 64);
  const rpcOptions = cloneJson(options.rpcOptions ?? {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");

  async function invoke(operation, rpc, body, validate) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeError(error, operation, rpc);
    }
    try {
      return validate(value);
    } catch (error) {
      throw normalizeError(error, operation, rpc);
    }
  }

  async function sealParentPlan(input = {}) {
    const operation = "seal Gmail parent extraction plan";
    const fields = jobFields(input);
    const plan = normalizeExtractionPlan(input.extractionPlan);
    return invoke(operation, RPC.sealParentPlan, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_extraction_plan: plan,
      p_max_context_items: maxContextItems,
      p_sync_token: syncToken,
    }, (value) => validatePlanReceipt(value, operation, workspaceKey, fields.p_job_id, plan));
  }

  async function resumeSealedParentPlan(input = {}) {
    const operation = "read sealed shadow Gmail model parent";
    const fields = jobFields(input);
    return invoke(operation, RPC.resumeSealedParentPlan, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_sync_token: syncToken,
    }, (value) => validateResumedPlanReceipt(
      value,
      operation,
      workspaceKey,
      fields.p_job_id,
    ));
  }

  async function reconcileStaleParentPlan(input = {}) {
    const operation = "reconcile stale shadow Gmail extraction plan";
    const fields = jobFields(input);
    const plan = normalizeExtractionPlan(input.extractionPlan);
    return invoke(operation, RPC.reconcileStaleParentPlan, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_extraction_plan: plan,
      p_sync_token: syncToken,
    }, (value) => validatePlanReconciliationReceipt(value, operation, {
      workspaceKey,
      jobId: fields.p_job_id,
      plan,
    }));
  }

  async function loadParentPlanningContext(input = {}) {
    const operation = "load Gmail parent planning context";
    const fields = jobFields(input);
    return invoke(operation, RPC.loadParentPlanningContext, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_sync_token: syncToken,
    }, (value) => validateParentPlanningContext(value, operation, {
      workspaceKey,
      jobId: fields.p_job_id,
      workerId: fields.p_worker_id,
      leaseFence: fields.p_lease_fence,
      processorVersion: fields.p_processor_version,
    }));
  }

  async function loadModelContext(input = {}) {
    const operation = "load Gmail model extraction context";
    const fields = jobFields(input);
    return invoke(operation, RPC.loadModelContext, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_max_items: maxContextItems,
      p_sync_token: syncToken,
    }, (value) => validateModelContext(value, operation, {
      workspaceKey,
      jobId: fields.p_job_id,
      workerId: fields.p_worker_id,
      leaseFence: fields.p_lease_fence,
      processorVersion: fields.p_processor_version,
    }));
  }

  async function recordSuccessfulResult(input = {}) {
    const operation = "record Gmail model extraction result";
    const fields = jobFields(input);
    const modelPlanId = match(input.modelPlanId, "modelPlanId", MODEL_PLAN_RE);
    const modelRequestId = match(input.modelRequestId, "modelRequestId", MODEL_REQUEST_RE);
    const providerResponseId = text(input.providerResponseId, "providerResponseId", 500);
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 50) {
      throw invalidArgument("candidates", "must contain 1 through 50 candidates");
    }
    const candidates = input.candidates.map((candidate, index) => normalizeCandidate(candidate, `candidates[${index}]`));
    const models = new Set(candidates.map((candidate) => candidate.model));
    const promptVersions = new Set(candidates.map((candidate) => candidate.promptVersion));
    if (models.size !== 1 || promptVersions.size !== 1
      || typeof candidates[0].model !== "string" || !candidates[0].model
      || typeof candidates[0].promptVersion !== "string" || !candidates[0].promptVersion) {
      throw invalidArgument("candidates", "must share one exact non-empty model and prompt identity");
    }
    return invoke(operation, RPC.recordResult, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_model_plan_id: modelPlanId,
      p_model_request_id: modelRequestId,
      p_provider_response_id: providerResponseId,
      p_candidates: candidates,
      p_sync_token: syncToken,
    }, (value) => validateResultReceipt(value, operation, {
      workspaceKey,
      jobId: fields.p_job_id,
      modelPlanId,
      modelRequestId,
      providerResponseId,
      candidateCount: candidates.length,
      model: candidates[0].model,
      promptVersion: candidates[0].promptVersion,
    }));
  }

  async function createReviewIntent(input = {}) {
    const operation = "create Gmail model extraction review intent";
    const fields = jobFields(input);
    const modelPlanId = match(input.modelPlanId, "modelPlanId", MODEL_PLAN_RE);
    const reasonCode = match(input.reasonCode, "reasonCode", REASON_RE);
    const safeDetailHash = match(input.safeDetailHash, "safeDetailHash", HASH_RE);
    return invoke(operation, RPC.createReview, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_model_plan_id: modelPlanId,
      p_reason_code: reasonCode,
      p_safe_detail_hash: safeDetailHash,
      p_sync_token: syncToken,
    }, (value) => validateIntentReceipt(value, operation, {
      workspaceKey,
      jobId: fields.p_job_id,
      modelPlanId,
      reasonCode,
      safeDetailHash,
    }));
  }

  async function createStaleTimeBindingReviewIntent(input = {}) {
    const operation = "create stale-bound Gmail model extraction review intent";
    const fields = jobFields(input);
    const modelPlanId = match(input.modelPlanId, "modelPlanId", MODEL_PLAN_RE);
    return invoke(operation, RPC.createStaleTimeBindingReview, {
      p_workspace_key: workspaceKey,
      ...fields,
      p_model_plan_id: modelPlanId,
      p_sync_token: syncToken,
    }, (value) => {
      if (!isPlainObject(value)
        || value.reasonCode !== "STALE_IMMUTABLE_SOURCE_TIME_BINDING"
        || !HASH_RE.test(String(value.safeDetailHash || ""))) {
        throw invalidReceipt(operation, "result", "does not carry the server-derived stale-binding proof");
      }
      return validateIntentReceipt(value, operation, {
        workspaceKey,
        jobId: fields.p_job_id,
        modelPlanId,
        reasonCode: value.reasonCode,
        safeDetailHash: value.safeDetailHash,
      });
    });
  }

  async function resolveReview(input = {}) {
    const operation = "resolve Gmail model extraction review";
    if (typeof reviewToken !== "string" || !reviewToken) {
      throw invalidArgument("reviewToken", "is required for explicit review resolution");
    }
    const obligationId = match(input.obligationId, "obligationId", REVIEW_OBLIGATION_RE);
    if (!["reviewed_no_additional_claims", "operational_evidence_recorded"].includes(input.decision)) {
      throw invalidArgument("decision", "is unsupported");
    }
    const evidence = input.resolutionEvidenceObservationIds ?? [];
    if (!Array.isArray(evidence) || evidence.length > 64) throw invalidArgument("resolutionEvidenceObservationIds", "must contain at most 64 IDs");
    const normalizedEvidence = [...new Set(evidence.map((item, index) => (
      match(item, `resolutionEvidenceObservationIds[${index}]`, OBSERVATION_RE)
    )))].sort();
    if (normalizedEvidence.length !== evidence.length) throw invalidArgument("resolutionEvidenceObservationIds", "must be unique");
    const decision = input.decision;
    if ((decision === "reviewed_no_additional_claims") !== (normalizedEvidence.length === 0)) {
      throw invalidArgument("resolutionEvidenceObservationIds", "does not match the review decision");
    }
    return invoke(operation, RPC.resolveReview, {
      p_workspace_key: workspaceKey,
      p_obligation_id: obligationId,
      p_decision: decision,
      p_resolution_evidence_observation_ids: normalizedEvidence,
      p_decided_by: text(input.decidedBy, "decidedBy", 200),
      p_reason: text(input.reason, "reason", 2000),
      p_idempotency_key: text(input.idempotencyKey, "idempotencyKey", 500),
      p_review_token: reviewToken,
      p_sync_token: syncToken,
    }, (value) => validateResolutionReceipt(value, operation, {
      workspaceKey,
      obligationId,
      decision,
      evidence: normalizedEvidence,
    }));
  }

  return Object.freeze({
    workspaceKey,
    maxContextItems,
    loadParentPlanningContext,
    resumeSealedParentPlan,
    sealParentPlan,
    reconcileStaleParentPlan,
    loadModelContext,
    recordSuccessfulResult,
    createReviewIntent,
    createStaleTimeBindingReviewIntent,
    resolveReview,
  });
}

module.exports = {
  RPC,
  TruthGmailModelPlanLedgerError,
  buildPlanningFailurePlan,
  createTruthGmailModelPlanLedger,
  _test: {
    canonicalize,
    normalizeCandidate,
    normalizeExtractionPlan,
    postgresHash,
    postgresJsonbText,
    sha256Json,
    validateParentPlanningContext,
    validateModelContext,
    validatePlanReceipt,
    validateResumedPlanReceipt,
    validatePlanReconciliationReceipt,
  },
};

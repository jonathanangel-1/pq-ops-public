"use strict";

const crypto = require("node:crypto");
const { isAbortSignal, throwIfAborted } = require("./runtime-deadline");
const {
  PRODUCER_CONTEXT_SCHEMA_VERSION,
  PRODUCER_LANES,
  normalizeAuditProducerContext,
} = require("./truth-audit-ledger");

const ORCHESTRATOR_VERSION = "truth-shadow-orchestrator-v1";
const SHADOW_CHANNEL = "shadow";
const DEFAULT_MAX_WORKER_ROUNDS = 8;
const DEFAULT_WORKER_LIMIT = 10;
const DEFAULT_DEADLINE_BUFFER_MS = 15_000;
const DEFAULT_AUDIT_RESERVE_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINDING_ID_RE = /^truth-audit:v1:[0-9a-f]{64}$/;
const SOURCE_CUT_ID_RE = /^(?:source-)?cut:v1:[0-9a-f]{64}$/;
const PRODUCTION_CUT_ID_RE = /^cut:v1:[0-9a-f]{64}$/;
const PRODUCTION_BRIDGE_ID_RE = /^truth-production-cut-acceptance-bridge:v1:[0-9a-f]{64}$/;
const AUDIT_STAGES = new Set([
  "source_cursor",
  "gmail_ingest",
  "processing",
  "source_cut",
  "build_inputs",
  "build_parity",
  "publication",
  "production",
]);
const AUDIT_SEVERITIES = new Set(["blocking", "attention", "informational"]);

class TruthShadowOrchestratorError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthShadowOrchestratorError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthShadowOrchestratorError(`Invalid truth-shadow ${field}: ${reason}`, {
    code: "TRUTH_SHADOW_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  return value;
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
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
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalid(`${field}.${key}`, "is forbidden");
      }
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

function dependency(value, field, methods) {
  if (!value || typeof value !== "object") throw invalid(field, "must be an object");
  for (const method of methods) {
    if (typeof value[method] !== "function") throw invalid(`${field}.${method}`, "must be a function");
  }
  return value;
}

function safeCode(error, fallback = "TRUTH_SHADOW_STAGE_FAILED") {
  const value = String(error?.code || fallback).toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
  return value || fallback;
}

function stageError(stage, error) {
  if (error instanceof TruthShadowOrchestratorError && error.stage) return error;
  return new TruthShadowOrchestratorError(
    `Truth-shadow stage ${stage} failed: ${error?.message || String(error)}`,
    {
      code: safeCode(error),
      stage,
      retryable: error?.retryable === true,
      outcomeUnknown: error?.outcomeUnknown === true,
      cause: error instanceof Error ? error : new Error(String(error)),
    },
  );
}

function runIdentity({ workspaceKey, ownerId, startedAt }) {
  const hash = crypto.createHash("sha256")
    .update(JSON.stringify({ workspaceKey, ownerId, startedAt, version: ORCHESTRATOR_VERSION }), "utf8")
    .digest("hex");
  return `truth-shadow-run:v1:${hash}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalJson(value[key]);
    return output;
  }, {});
}

function exactGapHash(gaps) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalJson(gaps)), "utf8")
    .digest("hex");
}

function shadowProducerContext(input = {}) {
  const gaps = Array.isArray(input.sourceCut?.gaps) ? input.sourceCut.gaps : [];
  const context = {
    schemaVersion: PRODUCER_CONTEXT_SCHEMA_VERSION,
    producerLane: PRODUCER_LANES.shadow,
    producerStatus: input.producerStatus,
    gmailSyncDisposition: input.gmailSyncDisposition,
    workerRounds: input.workerRounds,
    workersDrained: input.workersDrained,
    workerFailureCount: input.workerFailureCount,
    sourceCutStatus: input.sourceCut
      ? String(input.sourceCut.status || "sealed")
      : "not_run",
    sourceCutId: input.sourceCut?.sourceCutId || "",
    sourceCutCompleteness: input.sourceCut?.completeness || "not_run",
    sourceGapCount: gaps.length,
    sourceGapsHash: exactGapHash(gaps),
    shadowBuildStatus: input.shadowBuild?.status || "not_run",
    failureStage: input.failureStage || "",
    failureCode: input.failureCode || "",
  };
  return normalizeAuditProducerContext(context, { expectedLane: PRODUCER_LANES.shadow });
}

function normalizeWorker(raw, index) {
  if (!isPlainObject(raw)) throw invalid(`workers[${index}]`, "must be an object");
  const name = text(raw.name, `workers[${index}].name`);
  if (typeof raw.runOnce !== "function") throw invalid(`workers[${index}].runOnce`, "must be a function");
  return Object.freeze({ name, runOnce: raw.runOnce });
}

function normalizeWorkerReceipt(value, name) {
  if (!isPlainObject(value)) {
    throw new TruthShadowOrchestratorError(`Worker ${name} returned a non-object receipt`, {
      code: "TRUTH_SHADOW_WORKER_RECEIPT_INVALID",
      stage: `worker:${name}`,
    });
  }
  const claimedCount = Number(value.claimedCount ?? 0);
  const succeededCount = Number(value.succeededCount ?? 0);
  const failedCount = Number(value.failedCount ?? 0);
  for (const [field, candidate] of Object.entries({ claimedCount, succeededCount, failedCount })) {
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      throw new TruthShadowOrchestratorError(`Worker ${name} returned invalid ${field}`, {
        code: "TRUTH_SHADOW_WORKER_RECEIPT_INVALID",
        stage: `worker:${name}`,
        field,
      });
    }
  }
  if (succeededCount + failedCount !== claimedCount) {
    throw new TruthShadowOrchestratorError(`Worker ${name} counts do not reconcile`, {
      code: "TRUTH_SHADOW_WORKER_RECEIPT_INVALID",
      stage: `worker:${name}`,
    });
  }
  return deepFreeze({
    ...cloneJson(value, `worker.${name}.receipt`),
    claimedCount,
    succeededCount,
    failedCount,
  });
}

function syncDisposition(receipt) {
  const status = String(receipt?.status || "");
  if (["committed", "no_changes"].includes(status)) return "ready";
  if (status === "backfill_required") return "backfill";
  if (status === "reconcile_required") return "reconciliation";
  if (["lease_busy", "lease_lost"].includes(status)) return "busy";
  if (["partial", "source_not_ready"].includes(status)) return "yield";
  throw new TruthShadowOrchestratorError(`Unsupported Gmail sync status ${status || "<empty>"}`, {
    code: "TRUTH_SHADOW_GMAIL_SYNC_RECEIPT_INVALID",
    stage: "gmail_sync",
  });
}

function assertSyncReceipt(value, stage) {
  if (!isPlainObject(value) || typeof value.status !== "string") {
    throw new TruthShadowOrchestratorError(`${stage} returned an invalid receipt`, {
      code: "TRUTH_SHADOW_GMAIL_SYNC_RECEIPT_INVALID",
      stage,
    });
  }
  return deepFreeze(cloneJson(value, stage));
}

function isProductionBridgeCut(value) {
  return isPlainObject(value)
    && value.productionEligible === true
    && value.productionPublicationAttempted === false
    && value.publishesTruth === false
    && value.performsActions === false
    && PRODUCTION_CUT_ID_RE.test(String(value.sourceCutId || ""))
    && value.productionSourceCutId === value.sourceCutId
    && PRODUCTION_CUT_ID_RE.test(String(value.shadowSourceCutId || ""))
    && value.shadowSourceCutId !== value.sourceCutId
    && PRODUCTION_BRIDGE_ID_RE.test(String(value.bridgeId || ""))
    && HASH_RE.test(String(value.bridgeHash || ""));
}

function assertCutReceipt(value) {
  if (!isPlainObject(value) || value.ok !== true
      || !["sealed", "not_ready"].includes(value.status || "sealed")
      || !["complete", "degraded"].includes(value.completeness)) {
    throw new TruthShadowOrchestratorError("Source-cut coordinator returned an invalid receipt", {
      code: "TRUTH_SHADOW_SOURCE_CUT_RECEIPT_INVALID",
      stage: "source_cut",
    });
  }
  const notReady = value.status === "not_ready";
  if ((!notReady && (typeof value.sourceCutId !== "string" || !/^cut:v1:[0-9a-f]{64}$/.test(value.sourceCutId)))
      || (notReady && value.sourceCutId !== null)) {
    throw new TruthShadowOrchestratorError("Source-cut coordinator returned an invalid sourceCutId", {
      code: "TRUTH_SHADOW_SOURCE_CUT_RECEIPT_INVALID",
      stage: "source_cut",
    });
  }
  if (!Array.isArray(value.gaps)) {
    throw new TruthShadowOrchestratorError("Source-cut coordinator omitted its exact gap list", {
      code: "TRUTH_SHADOW_SOURCE_CUT_RECEIPT_INVALID",
      stage: "source_cut",
    });
  }
  if (notReady && (value.completeness !== "degraded" || value.gaps.length === 0)) {
    throw new TruthShadowOrchestratorError("Not-ready source-cut receipt must expose one or more gaps", {
      code: "TRUTH_SHADOW_SOURCE_CUT_RECEIPT_INVALID",
      stage: "source_cut",
    });
  }
  if (value.productionEligible === true && !isProductionBridgeCut(value)) {
    throw new TruthShadowOrchestratorError("Production-eligible source cut lacks its exact bridge receipt", {
      code: "TRUTH_SHADOW_SOURCE_CUT_RECEIPT_INVALID",
      stage: "source_cut",
    });
  }
  return deepFreeze(cloneJson(value, "sourceCut"));
}

function assertShadowBuild(value, expectedSourceCutId) {
  if (!isPlainObject(value) || !["busy", "failed", "succeeded"].includes(value.status)) {
    throw new TruthShadowOrchestratorError("Shadow builder returned an invalid receipt", {
      code: "TRUTH_SHADOW_BUILD_RECEIPT_INVALID",
      stage: "shadow_build",
    });
  }
  const channel = value.publication?.channel || value.publication?.publicationAdapter?.channel || "";
  if (channel && channel !== SHADOW_CHANNEL) {
    throw new TruthShadowOrchestratorError("Shadow builder attempted a non-shadow publication", {
      code: "TRUTH_SHADOW_PRODUCTION_PUBLICATION_FORBIDDEN",
      stage: "shadow_build",
      channel,
    });
  }
  if (value.status === "succeeded") {
    const publication = value.publication;
    const adapter = publication?.publicationAdapter;
    const exactIdentity = isPlainObject(publication)
      && publication.ok === true
      && publication.channel === SHADOW_CHANNEL
      && UUID_RE.test(String(publication.publicationId || ""))
      && UUID_RE.test(String(publication.buildId || ""))
      && Number.isSafeInteger(publication.publicationVersion)
      && publication.publicationVersion > 0
      && publication.sourceCutId === expectedSourceCutId
      && HASH_RE.test(String(publication.packetHash || ""))
      && HASH_RE.test(String(publication.reducerPacketHash || ""))
      && HASH_RE.test(String(publication.semanticHash || ""))
      && HASH_RE.test(String(publication.deliveryPayloadHash || ""))
      && HASH_RE.test(String(publication.activeIndexHash || ""))
      && isPlainObject(adapter)
      && adapter.publicationId === publication.publicationId
      && adapter.publicationVersion === publication.publicationVersion
      && adapter.channel === publication.channel
      && adapter.sourceCutId === publication.sourceCutId
      && adapter.packetHash === publication.reducerPacketHash;
    if (!exactIdentity) {
      throw new TruthShadowOrchestratorError(
        "A successful shadow build omitted its exact publication receipt",
        {
          code: "TRUTH_SHADOW_BUILD_RECEIPT_INVALID",
          stage: "shadow_build",
        },
      );
    }
  }
  return deepFreeze(cloneJson(value, "build"));
}

function invalidAuditReceipt(reason) {
  throw new TruthShadowOrchestratorError(`Truth auditor returned an invalid receipt: ${reason}`, {
    code: "TRUTH_SHADOW_AUDIT_RECEIPT_INVALID",
    stage: "audit",
  });
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function nonnegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function boundedAuditString(value, { allowEmpty = false, maximumBytes = 8192 } = {}) {
  return typeof value === "string"
    && value.trim() === value
    && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validateAuditFinding(finding) {
  const keys = [
    "classification",
    "detail",
    "evidenceIdCount",
    "evidenceIds",
    "evidenceObservationIdCount",
    "evidenceObservationIds",
    "findingId",
    "mutatesOperationalState",
    "severity",
    "stage",
    "subjectKey",
    "subjectType",
  ];
  if (!exactKeys(finding, keys)
      || !FINDING_ID_RE.test(String(finding.findingId || ""))
      || !AUDIT_STAGES.has(finding.stage)
      || !AUDIT_SEVERITIES.has(finding.severity)
      || !boundedAuditString(finding.classification, { maximumBytes: 200 })
      || !boundedAuditString(finding.subjectType, { allowEmpty: true, maximumBytes: 200 })
      || !boundedAuditString(finding.subjectKey, { allowEmpty: true })
      || !Array.isArray(finding.evidenceIds)
      || !Array.isArray(finding.evidenceObservationIds)
      || !nonnegativeInteger(finding.evidenceIdCount, 1_000_000)
      || !nonnegativeInteger(finding.evidenceObservationIdCount, 1_000_000)
      || finding.evidenceIds.length !== Math.min(25, finding.evidenceIdCount)
      || finding.evidenceObservationIds.length !== Math.min(25, finding.evidenceObservationIdCount)
      || finding.evidenceIds.some((id) => !boundedAuditString(id))
      || finding.evidenceObservationIds.some((id) => !boundedAuditString(id))
      || finding.mutatesOperationalState !== false) {
    invalidAuditReceipt("finding summary is malformed or unbounded");
  }
}

function validateProductionWitness(witness) {
  if (!isPlainObject(witness) || witness.schemaVersion !== "production-truth-witness-v2") {
    invalidAuditReceipt("production witness is missing or unsupported");
  }
  const commonKeys = [
    "deliveryPayloadHash",
    "exactSnapshotHash",
    "fullPayloadHashVerifiedAtSource",
    "missingRelationalFields",
    "mode",
    "mutatesOperationalState",
    "observedAt",
    "origin",
    "packetHash",
    "path",
    "payloadBytes",
    "processingWatermarkHash",
    "processingWatermarkStatus",
    "publicationId",
    "publicationVersion",
    "relationalIdentityPresent",
    "schemaVersion",
    "semanticHashIndependentlyRecomputed",
    "semanticWitnessHash",
    "sourceCutId",
    "sourcePayloadBytes",
  ];
  const expectedKeys = witness.mode === "legacy-shadow"
    ? [...commonKeys, "reportedLegacyContentSignature"]
    : commonKeys;
  let origin;
  try { origin = new URL(String(witness.origin || "")); } catch { origin = null; }
  const relational = witness.mode === "relational" || witness.mode === "relational-legacy";
  if (!exactKeys(witness, expectedKeys)
      || !["legacy-shadow", "relational", "relational-legacy"].includes(witness.mode)
      || !origin
      || origin.protocol !== "https:"
      || origin.username
      || origin.password
      || witness.path !== "/api/truth/production-witness"
      || !Number.isFinite(Date.parse(String(witness.observedAt || "")))
      || !nonnegativeInteger(witness.payloadBytes, 32 * 1024 * 1024)
      || !HASH_RE.test(String(witness.deliveryPayloadHash || ""))
      || !HASH_RE.test(String(witness.exactSnapshotHash || ""))
      || !HASH_RE.test(String(witness.semanticWitnessHash || ""))
      || (witness.sourcePayloadBytes !== null
        && !nonnegativeInteger(witness.sourcePayloadBytes, 32 * 1024 * 1024))
      || !Array.isArray(witness.missingRelationalFields)
      || witness.missingRelationalFields.length > 25
      || witness.missingRelationalFields.some((field) => !boundedAuditString(field, { maximumBytes: 100 }))
      || witness.semanticHashIndependentlyRecomputed !== true
      || witness.mutatesOperationalState !== false
      || !boundedAuditString(witness.processingWatermarkStatus, { maximumBytes: 100 })
      || (witness.processingWatermarkHash !== null
        && !HASH_RE.test(String(witness.processingWatermarkHash || "")))) {
    invalidAuditReceipt("production witness identity is invalid or unbounded");
  }
  if (relational) {
    if (!UUID_RE.test(String(witness.publicationId || ""))
        || !Number.isSafeInteger(witness.publicationVersion)
        || witness.publicationVersion < 1
        || !SOURCE_CUT_ID_RE.test(String(witness.sourceCutId || ""))
        || !HASH_RE.test(String(witness.packetHash || ""))
        || witness.relationalIdentityPresent !== true
        || witness.fullPayloadHashVerifiedAtSource !== true
        || witness.missingRelationalFields.length !== 0) {
      invalidAuditReceipt("relational production witness identity is incomplete");
    }
  } else if (witness.publicationId !== ""
      || witness.publicationVersion !== null
      || (witness.packetHash !== "" && !HASH_RE.test(String(witness.packetHash || "")))
      || witness.relationalIdentityPresent !== false
      || witness.fullPayloadHashVerifiedAtSource !== false
      || !boundedAuditString(witness.reportedLegacyContentSignature, { allowEmpty: true })) {
    invalidAuditReceipt("legacy production witness claims relational authority");
  }
}

function assertAuditReceipt(value, expectedProducerContext, expectedAuditMode) {
  const busyKeys = [
    "agreement",
    "auditRunId",
    "blockingAgreement",
    "code",
    "findingCount",
    "findings",
    "leaseExpiresAt",
    "mutatesOperationalState",
    "ok",
    "skipped",
    "status",
  ];
  if (isPlainObject(value) && value.status === "busy") {
    if (!exactKeys(value, busyKeys)
        || value.ok !== true
        || value.skipped !== true
        || value.code !== "AUDIT_BUSY"
        || !UUID_RE.test(String(value.auditRunId || ""))
        || (value.leaseExpiresAt !== null
          && !Number.isFinite(Date.parse(String(value.leaseExpiresAt || ""))))
        || value.agreement !== null
        || value.blockingAgreement !== null
        || value.findingCount !== 0
        || !Array.isArray(value.findings)
        || value.findings.length !== 0
        || value.mutatesOperationalState !== false) {
      invalidAuditReceipt("busy receipt does not match AUDIT_BUSY");
    }
    return deepFreeze(cloneJson(value, "audit"));
  }

  const successKeys = [
    "agreement",
    "auditRunId",
    "blockingAgreement",
    "counts",
    "findingCount",
    "findings",
    "findingsTruncated",
    "inputDigest",
    "mutatesOperationalState",
    "ok",
    "producerContext",
    "productionWitness",
    "reconciliation",
    "status",
  ];
  if (!exactKeys(value, successKeys)
      || value.ok !== true
      || value.status !== "succeeded"
      || !UUID_RE.test(String(value.auditRunId || ""))
      || typeof value.agreement !== "boolean"
      || typeof value.blockingAgreement !== "boolean"
      || !nonnegativeInteger(value.findingCount, 5000)
      || !Array.isArray(value.findings)
      || value.findings.length > 200
      || (value.findingCount > 0 && value.findings.length === 0)
      || value.findingCount < value.findings.length
      || typeof value.findingsTruncated !== "boolean"
      || value.findingsTruncated !== (value.findingCount > value.findings.length)
      || !HASH_RE.test(String(value.inputDigest || ""))
      || value.mutatesOperationalState !== false) {
    invalidAuditReceipt("success receipt shape is invalid or unbounded");
  }

  const counts = value.counts;
  if (!exactKeys(counts, ["attention", "blocking", "byStage", "informational", "productionComparison"])
      || !nonnegativeInteger(counts.blocking, 5000)
      || !nonnegativeInteger(counts.attention, 5000)
      || !nonnegativeInteger(counts.informational, 5000)
      || counts.blocking + counts.attention + counts.informational !== value.findingCount
      || !isPlainObject(counts.byStage)
      || !isPlainObject(counts.productionComparison)
      || Object.keys(counts.byStage).some((stage) => !AUDIT_STAGES.has(stage))
      || Object.values(counts.byStage).some((count) => !nonnegativeInteger(count, 5000))
      || Object.values(counts.byStage).reduce((sum, count) => sum + count, 0) !== value.findingCount
      || value.agreement !== (value.findingCount === 0)
      || value.blockingAgreement !== (counts.blocking === 0)) {
    invalidAuditReceipt("finding counts or agreement booleans do not reconcile");
  }

  value.findings.forEach(validateAuditFinding);
  const summarizedCounts = value.findings.reduce((summary, finding) => {
    summary[finding.severity] += 1;
    summary.byStage[finding.stage] = (summary.byStage[finding.stage] || 0) + 1;
    return summary;
  }, { blocking: 0, attention: 0, informational: 0, byStage: {} });
  for (const severity of AUDIT_SEVERITIES) {
    if (summarizedCounts[severity] > counts[severity]) {
      invalidAuditReceipt("finding summary exceeds authoritative severity counts");
    }
  }
  for (const [stage, count] of Object.entries(summarizedCounts.byStage)) {
    if (count > Number(counts.byStage[stage] || 0)) {
      invalidAuditReceipt("finding summary exceeds authoritative stage counts");
    }
  }

  const reconciliation = value.reconciliation;
  const expectedIntervalSeconds = expectedAuditMode === "delta" ? 300 : 900;
  if (!exactKeys(reconciliation, [
    "expectedIntervalSeconds",
    "missedExpectedRun",
    "previousAuditRunId",
    "reconciliationFrom",
    "scheduleGapSeconds",
  ])
      || (reconciliation.previousAuditRunId !== null
        && !UUID_RE.test(String(reconciliation.previousAuditRunId || "")))
      || (reconciliation.reconciliationFrom !== null
        && !Number.isFinite(Date.parse(String(reconciliation.reconciliationFrom || ""))))
      || (reconciliation.scheduleGapSeconds !== null
        && !nonnegativeInteger(reconciliation.scheduleGapSeconds, 31_536_000))
      || typeof reconciliation.missedExpectedRun !== "boolean"
      || reconciliation.expectedIntervalSeconds !== expectedIntervalSeconds) {
    invalidAuditReceipt("reconciliation witness is invalid");
  }

  let normalizedContext;
  try {
    normalizedContext = normalizeAuditProducerContext(value.producerContext, {
      expectedLane: PRODUCER_LANES.shadow,
    });
  } catch {
    invalidAuditReceipt("producer context is invalid");
  }
  if (JSON.stringify(canonicalJson(normalizedContext)) !==
      JSON.stringify(canonicalJson(expectedProducerContext))) {
    invalidAuditReceipt("producer context does not equal the audit request");
  }
  validateProductionWitness(value.productionWitness);

  let cloned;
  try { cloned = cloneJson(value, "audit"); } catch {
    invalidAuditReceipt("receipt is not bounded JSON");
  }
  return deepFreeze(cloned);
}

function createTruthShadowOrchestrator(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || "primary", "workspaceKey");
  const gmail = dependency(options.gmail, "gmail", ["runIncremental", "runBackfill"]);
  const sourceCut = dependency(options.sourceCut, "sourceCut", ["sealCurrent"]);
  const build = dependency(options.build, "build", ["run"]);
  const audit = dependency(options.audit, "audit", ["run"]);
  if (!Array.isArray(options.workers) || options.workers.length === 0) {
    throw invalid("workers", "must be a non-empty array");
  }
  const workers = options.workers.map(normalizeWorker);
  const workerNames = workers.map((worker) => worker.name);
  if (new Set(workerNames).size !== workerNames.length) throw invalid("workers", "names must be unique");
  const maxWorkerRounds = integer(options.maxWorkerRounds ?? DEFAULT_MAX_WORKER_ROUNDS, "maxWorkerRounds", {
    minimum: 1,
    maximum: 100,
  });
  const workerLimit = integer(options.workerLimit ?? DEFAULT_WORKER_LIMIT, "workerLimit", {
    minimum: 1,
    maximum: 50,
  });
  const deadlineBufferMs = integer(options.deadlineBufferMs ?? DEFAULT_DEADLINE_BUFFER_MS, "deadlineBufferMs", {
    minimum: 1_000,
    maximum: 120_000,
  });
  const auditReserveMs = integer(options.auditReserveMs ?? DEFAULT_AUDIT_RESERVE_MS, "auditReserveMs", {
    minimum: 5_000,
    maximum: 120_000,
  });
  const now = options.now || Date.now;
  if (typeof now !== "function") throw invalid("now", "must be a function");

  function remaining(deadlineAtMs) {
    return deadlineAtMs - Number(now());
  }

  async function runAudit(auditMode, producerContext, signal, deadlineAtMs) {
    try {
      throwIfAborted(signal, { stage: "truth shadow audit", deadlineAtMs, now });
      return assertAuditReceipt(
        await audit.run({ auditMode, producerContext, signal, deadlineAtMs }),
        producerContext,
        auditMode,
      );
    } catch (error) {
      throw stageError("audit", error);
    }
  }

  async function attachDiagnosticAudit(failure, state, signal, auditDeadlineAtMs) {
    const producerContext = shadowProducerContext({
      producerStatus: "failed",
      gmailSyncDisposition: state.gmailSyncDisposition,
      workerRounds: state.workerRounds,
      workersDrained: state.workersDrained,
      workerFailureCount: state.workerFailureCount,
      sourceCut: state.sourceCut,
      shadowBuild: state.shadowBuild,
      failureStage: String(failure.stage || "orchestration"),
      failureCode: safeCode(failure, "TRUTH_SHADOW_STAGE_FAILED"),
    });
    failure.diagnosticAuditAttempted = true;
    failure.producerContext = producerContext;
    try {
      failure.diagnosticAudit = await runAudit(
        "delta",
        producerContext,
        signal,
        auditDeadlineAtMs,
      );
    } catch (auditError) {
      failure.diagnosticAuditError = {
        code: safeCode(auditError, "TRUTH_SHADOW_DIAGNOSTIC_AUDIT_FAILED"),
        stage: String(auditError?.stage || "audit"),
        retryable: auditError?.retryable === true,
        outcomeUnknown: auditError?.outcomeUnknown === true,
      };
    }
    return failure;
  }

  async function run(input = {}) {
    if (!isPlainObject(input)) throw invalid("run", "must be an object");
    const ownerId = text(input.ownerId, "run.ownerId");
    const startedAtMs = Number(now());
    if (!Number.isFinite(startedAtMs)) throw invalid("now", "must return finite epoch milliseconds");
    const deadlineAtMs = Number(input.deadlineAtMs);
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= startedAtMs) {
      throw invalid("run.deadlineAtMs", "must be a future finite epoch-millisecond value");
    }
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) throw invalid("run.signal", "must be an AbortSignal or null");
    throwIfAborted(signal, { stage: "truth shadow start", deadlineAtMs, now });
    const auditDeadlineAtMs = deadlineAtMs - deadlineBufferMs;
    const producerDeadlineAtMs = auditDeadlineAtMs - auditReserveMs;
    if (producerDeadlineAtMs <= startedAtMs) {
      throw invalid(
        "run.deadlineAtMs",
        "must leave time for the configured audit reserve and deadline buffer",
      );
    }
    const startedAt = new Date(startedAtMs).toISOString();
    const runId = runIdentity({ workspaceKey, ownerId, startedAt });
    const stageResults = {};
    let syncReady = false;
    let orchestrationDisposition = "ready";
    let gmailFailureStage = "gmail_sync";

    try {
      throwIfAborted(signal, { stage: "truth shadow Gmail incremental", deadlineAtMs: producerDeadlineAtMs, now });
      const incremental = assertSyncReceipt(await gmail.runIncremental({
        ownerId,
        triggerName: `${ORCHESTRATOR_VERSION}:incremental`,
        deadlineAtMs: producerDeadlineAtMs,
        signal,
      }), "gmail_sync");
      stageResults.gmailIncremental = incremental;
      const disposition = syncDisposition(incremental);
      if (disposition === "backfill" || disposition === "reconciliation") {
        if (remaining(producerDeadlineAtMs) <= 0) {
          orchestrationDisposition = "yield";
        } else {
          gmailFailureStage = "gmail_backfill";
          throwIfAborted(signal, { stage: "truth shadow Gmail backfill", deadlineAtMs: producerDeadlineAtMs, now });
          const backfill = assertSyncReceipt(await gmail.runBackfill({
            ownerId,
            mode: disposition,
            triggerName: `${ORCHESTRATOR_VERSION}:${disposition}`,
            deadlineAtMs: producerDeadlineAtMs,
            signal,
          }), "gmail_backfill");
          stageResults.gmailBackfill = backfill;
          orchestrationDisposition = syncDisposition(backfill);
          syncReady = orchestrationDisposition === "ready";
        }
      } else {
        orchestrationDisposition = disposition;
        syncReady = disposition === "ready";
      }
    } catch (error) {
      const syncFailure = stageError(gmailFailureStage, error);
      await attachDiagnosticAudit(syncFailure, {
        gmailSyncDisposition: "failed",
        workerRounds: 0,
        workersDrained: false,
        workerFailureCount: 0,
        sourceCut: null,
        shadowBuild: null,
      }, signal, auditDeadlineAtMs);
      throw syncFailure;
    }

    const workerRounds = [];
    let drained = false;
    let workerFailureCount = 0;
    if (orchestrationDisposition !== "busy") {
      for (let round = 1; round <= maxWorkerRounds; round += 1) {
        if (remaining(producerDeadlineAtMs) <= 0) break;
        const receipts = [];
        let claimedThisRound = 0;
        for (const worker of workers) {
          if (remaining(producerDeadlineAtMs) <= 0) break;
          try {
            throwIfAborted(signal, {
              stage: `truth shadow worker ${worker.name}`,
              deadlineAtMs: producerDeadlineAtMs,
              now,
            });
            const receipt = normalizeWorkerReceipt(await worker.runOnce({
              limit: workerLimit,
              signal,
              deadlineAtMs: producerDeadlineAtMs,
            }), worker.name);
            receipts.push({ name: worker.name, receipt });
            claimedThisRound += receipt.claimedCount;
            workerFailureCount += receipt.failedCount;
          } catch (error) {
            const workerFailure = stageError(`worker:${worker.name}`, error);
            await attachDiagnosticAudit(workerFailure, {
              gmailSyncDisposition: orchestrationDisposition,
              workerRounds: workerRounds.length,
              workersDrained: false,
              workerFailureCount,
              sourceCut: null,
              shadowBuild: null,
            }, signal, auditDeadlineAtMs);
            throw workerFailure;
          }
        }
        workerRounds.push({ round, claimedCount: claimedThisRound, workers: receipts });
        if (claimedThisRound === 0) {
          drained = true;
          break;
        }
      }
    }
    stageResults.workerRounds = deepFreeze(cloneJson(workerRounds, "workerRounds"));

    let cut = null;
    let buildReceipt = null;
    if (syncReady && drained && workerFailureCount === 0 && remaining(producerDeadlineAtMs) > 0) {
      try {
        throwIfAborted(signal, { stage: "truth shadow source cut", deadlineAtMs: producerDeadlineAtMs, now });
        cut = assertCutReceipt(await sourceCut.sealCurrent({
          createdBy: `${ORCHESTRATOR_VERSION}:${ownerId}`,
          runId,
          signal,
          deadlineAtMs: producerDeadlineAtMs,
        }));
        stageResults.sourceCut = cut;
      } catch (error) {
        const cutFailure = stageError("source_cut", error);
        await attachDiagnosticAudit(cutFailure, {
          gmailSyncDisposition: orchestrationDisposition,
          workerRounds: workerRounds.length,
          workersDrained: drained,
          workerFailureCount,
          sourceCut: null,
          shadowBuild: null,
        }, signal, auditDeadlineAtMs);
        throw cutFailure;
      }
      const buildEligible = cut.completeness === "complete" || isProductionBridgeCut(cut);
      if (buildEligible && remaining(producerDeadlineAtMs) > 0) {
        try {
          throwIfAborted(signal, { stage: "truth shadow build", deadlineAtMs: producerDeadlineAtMs, now });
          buildReceipt = assertShadowBuild(await build.run({
            sourceCutId: cut.sourceCutId,
            buildChannel: SHADOW_CHANNEL,
            publicationChannel: SHADOW_CHANNEL,
            idempotencyKey: `shadow:${cut.sourceCutId}`,
            triggerName: ORCHESTRATOR_VERSION,
            publicationReason: "continuous source-to-production truth comparison",
            productionConfirmation: null,
            signal,
            deadlineAtMs: producerDeadlineAtMs,
          }), cut.sourceCutId);
          stageResults.shadowBuild = buildReceipt;
        } catch (error) {
          const buildFailure = stageError("shadow_build", error);
          await attachDiagnosticAudit(buildFailure, {
            gmailSyncDisposition: orchestrationDisposition,
            workerRounds: workerRounds.length,
            workersDrained: drained,
            workerFailureCount,
            sourceCut: cut,
            shadowBuild: null,
          }, signal, auditDeadlineAtMs);
          throw buildFailure;
        }
      }
    }

    const incompleteReasons = [];
    if (!syncReady) incompleteReasons.push(`gmail_sync:${orchestrationDisposition}`);
    if (!drained) incompleteReasons.push("worker_backlog_not_drained");
    if (workerFailureCount > 0) incompleteReasons.push(`worker_failures:${workerFailureCount}`);
    if (syncReady && drained && workerFailureCount === 0 && !cut) incompleteReasons.push("source_cut:not_run");
    if (cut?.status === "not_ready") incompleteReasons.push(`source_cut_not_ready:${cut.gaps.length}`);
    else if (cut?.completeness === "degraded") incompleteReasons.push(`source_cut_gaps:${cut.gaps.length}`);
    if (cut?.completeness === "complete" && buildReceipt?.status !== "succeeded") {
      incompleteReasons.push(`shadow_build:${buildReceipt?.status || "not_run"}`);
    }
    if (buildReceipt?.production && buildReceipt.production.status !== "succeeded") {
      incompleteReasons.push(`production_build:${buildReceipt.production.status}`);
    }
    const productionBuildFailed = buildReceipt?.production?.status === "failed";
    const failedBuild = buildReceipt?.status === "failed" || productionBuildFailed;
    const producerStatus = failedBuild
      ? "failed"
      : orchestrationDisposition === "busy"
      ? "busy"
      : incompleteReasons.length ? "degraded" : "succeeded";
    const producerContext = shadowProducerContext({
      producerStatus,
      gmailSyncDisposition: orchestrationDisposition,
      workerRounds: workerRounds.length,
      workersDrained: drained,
      workerFailureCount,
      sourceCut: cut,
      shadowBuild: buildReceipt,
      failureStage: failedBuild ? productionBuildFailed ? "production_build" : "shadow_build" : "",
      failureCode: failedBuild
        ? productionBuildFailed
          ? safeCode(buildReceipt.production, "TRUTH_PRODUCTION_BUILD_FAILED")
          : safeCode(buildReceipt, "TRUTH_SHADOW_BUILD_FAILED")
        : "",
    });

    // The durable audit schema deliberately has a small, versioned mode enum.
    // Continuous shadow runs are delta audits; do not invent a cron-local mode
    // that the database cannot persist or reconcile.
    const auditReceipt = await runAudit(
      "delta",
      producerContext,
      signal,
      auditDeadlineAtMs,
    );
    stageResults.audit = auditReceipt;
    if (auditReceipt.status !== "succeeded") {
      incompleteReasons.push(`audit:${auditReceipt.status}`);
    }
    if (auditReceipt.status === "succeeded" && (
      auditReceipt.agreement !== true
      || auditReceipt.blockingAgreement !== true
      || auditReceipt.findingCount !== 0
    )) {
      incompleteReasons.push(`audit_findings:${auditReceipt.findingCount}`);
    }
    const status = producerStatus === "failed"
      ? "failed"
      : orchestrationDisposition === "busy"
      ? "busy"
      : incompleteReasons.length ? "degraded" : "succeeded";
    return deepFreeze({
      ok: true,
      status,
      runId,
      workspaceKey,
      orchestratorVersion: ORCHESTRATOR_VERSION,
      startedAt,
      finishedAt: new Date(Number(now())).toISOString(),
      sourceCutId: cut?.sourceCutId || null,
      producerContext,
      publicationChannel: buildReceipt?.publication?.channel || null,
      incompleteReasons,
      workerFailureCount,
      workerRounds: workerRounds.length,
      operationalEffectsAttempted: false,
      productionPublicationAttempted: buildReceipt?.productionPublicationAttempted === true,
      mutatesOperationalState: false,
      stages: stageResults,
    });
  }

  return Object.freeze({
    orchestratorVersion: ORCHESTRATOR_VERSION,
    workspaceKey,
    run,
  });
}

module.exports = Object.freeze({
  DEFAULT_AUDIT_RESERVE_MS,
  DEFAULT_DEADLINE_BUFFER_MS,
  DEFAULT_MAX_WORKER_ROUNDS,
  DEFAULT_WORKER_LIMIT,
  ORCHESTRATOR_VERSION,
  SHADOW_CHANNEL,
  TruthShadowOrchestratorError,
  createTruthShadowOrchestrator,
  _test: Object.freeze({
    assertAuditReceipt,
    assertCutReceipt,
    assertShadowBuild,
    exactGapHash,
    isProductionBridgeCut,
    normalizeWorkerReceipt,
    runIdentity,
    safeCode,
    shadowProducerContext,
    syncDisposition,
  }),
});

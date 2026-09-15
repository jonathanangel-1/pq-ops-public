"use strict";

const {
  asDeadlineError,
  asOutcomeUnknownError,
  createAbortScope,
  isAbortError,
  throwIfAborted,
} = require("./runtime-deadline");

const AUDIT_RPC = Object.freeze({
  readSnapshot: "read_truth_audit_snapshot",
  readSnapshotBase: "read_truth_audit_snapshot_base",
  readSnapshotPublicationPayloads: "read_truth_audit_snapshot_publication_payloads",
  readSnapshotClosure: "read_truth_audit_snapshot_closure",
  readSnapshotProcessing: "read_truth_audit_snapshot_processing",
  readSnapshotExtensions: "read_truth_audit_snapshot_extensions",
  readStatus: "read_truth_audit_status",
  beginRun: "begin_truth_audit_run",
  completeRun: "complete_truth_audit_run",
  failRun: "fail_truth_audit_run",
});

const ALLOWED_RPC = new Set(Object.values(AUDIT_RPC));
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINDING_ID_RE = /^truth-audit:v1:[0-9a-f]{64}$/;
const SOURCE_CUT_ID_RE = /^(?:source-)?cut:v1:[0-9a-f]{64}$/;
const AUDIT_MODES = new Set(["delta", "hourly"]);
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
const PRODUCER_CONTEXT_SCHEMA_VERSION = "truth-audit-producer-context-v1";
const PRODUCER_LANES = Object.freeze({
  shadow: "truth-shadow",
  standalone: "standalone-audit",
});
const PRODUCER_CONTEXT_KEYS = Object.freeze([
  "failureCode",
  "failureStage",
  "gmailSyncDisposition",
  "producerLane",
  "producerStatus",
  "schemaVersion",
  "shadowBuildStatus",
  "sourceCutCompleteness",
  "sourceCutId",
  "sourceCutStatus",
  "sourceGapCount",
  "sourceGapsHash",
  "workerFailureCount",
  "workerRounds",
  "workersDrained",
]);

class TruthAuditLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthAuditLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthAuditLedgerError(`Invalid truth-audit ledger argument ${field}: ${reason}`, {
    code: "TRUTH_AUDIT_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value, field, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const maxBytes = options.maxBytes || 8192;
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && !value) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not contain surrounding whitespace");
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalidArgument(field, "is too long");
  return value;
}

function optionalHash(value, field) {
  const normalized = requireString(value ?? "", field, { allowEmpty: true });
  if (normalized && !HASH_RE.test(normalized)) {
    throw invalidArgument(field, "must be empty or lowercase SHA-256 hex");
  }
  return normalized;
}

function requireHash(value, field) {
  const normalized = requireString(value, field);
  if (!HASH_RE.test(normalized)) throw invalidArgument(field, "must be lowercase SHA-256 hex");
  return normalized;
}

function requireUuid(value, field) {
  const normalized = requireString(value, field);
  if (!UUID_RE.test(normalized)) throw invalidArgument(field, "must be a UUID");
  return normalized;
}

function cloneJson(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = cloneJson(item, `${field}.${key}`);
    }
    return output;
  }
  throw invalidArgument(field, "must contain only JSON-compatible data");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function producerContextInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw invalidArgument(field, `must be an integer from 0 through ${maximum}`);
  }
  return value;
}

function normalizeAuditProducerContext(value, options = {}) {
  if (!isPlainObject(value)) throw invalidArgument("producerContext", "must be an object");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(PRODUCER_CONTEXT_KEYS)) {
    throw invalidArgument("producerContext", "must contain the exact versioned producer-context fields");
  }
  const context = {
    schemaVersion: requireString(value.schemaVersion, "producerContext.schemaVersion", { maxBytes: 100 }),
    producerLane: requireString(value.producerLane, "producerContext.producerLane", { maxBytes: 100 }),
    producerStatus: requireString(value.producerStatus, "producerContext.producerStatus", { maxBytes: 100 }),
    gmailSyncDisposition: requireString(
      value.gmailSyncDisposition,
      "producerContext.gmailSyncDisposition",
      { maxBytes: 100 },
    ),
    workerRounds: producerContextInteger(value.workerRounds, "producerContext.workerRounds", 100),
    workersDrained: value.workersDrained,
    workerFailureCount: producerContextInteger(
      value.workerFailureCount,
      "producerContext.workerFailureCount",
      1_000_000,
    ),
    sourceCutStatus: requireString(value.sourceCutStatus, "producerContext.sourceCutStatus", { maxBytes: 100 }),
    sourceCutId: requireString(value.sourceCutId, "producerContext.sourceCutId", {
      allowEmpty: true,
      maxBytes: 100,
    }),
    sourceCutCompleteness: requireString(
      value.sourceCutCompleteness,
      "producerContext.sourceCutCompleteness",
      { maxBytes: 100 },
    ),
    sourceGapCount: producerContextInteger(value.sourceGapCount, "producerContext.sourceGapCount", 5000),
    sourceGapsHash: requireString(value.sourceGapsHash, "producerContext.sourceGapsHash", {
      allowEmpty: true,
      maxBytes: 64,
    }),
    shadowBuildStatus: requireString(
      value.shadowBuildStatus,
      "producerContext.shadowBuildStatus",
      { maxBytes: 100 },
    ),
    failureStage: requireString(value.failureStage, "producerContext.failureStage", {
      allowEmpty: true,
      maxBytes: 100,
    }),
    failureCode: requireString(value.failureCode, "producerContext.failureCode", {
      allowEmpty: true,
      maxBytes: 100,
    }),
  };
  if (context.schemaVersion !== PRODUCER_CONTEXT_SCHEMA_VERSION) {
    throw invalidArgument("producerContext.schemaVersion", "is unsupported");
  }
  if (typeof context.workersDrained !== "boolean") {
    throw invalidArgument("producerContext.workersDrained", "must be a boolean");
  }
  if (options.expectedLane && context.producerLane !== options.expectedLane) {
    throw invalidArgument("producerContext.producerLane", `must equal ${options.expectedLane}`);
  }

  if (context.producerLane === PRODUCER_LANES.standalone) {
    const exact = context.producerStatus === "ready"
      && context.gmailSyncDisposition === "not_applicable"
      && context.workerRounds === 0
      && context.workersDrained === true
      && context.workerFailureCount === 0
      && context.sourceCutStatus === "not_applicable"
      && context.sourceCutId === ""
      && context.sourceCutCompleteness === "not_applicable"
      && context.sourceGapCount === 0
      && context.sourceGapsHash === ""
      && context.shadowBuildStatus === "not_applicable"
      && context.failureStage === ""
      && context.failureCode === "";
    if (!exact) throw invalidArgument("producerContext", "has invalid standalone-audit fields");
  } else if (context.producerLane === PRODUCER_LANES.shadow) {
    if (!["succeeded", "degraded", "failed", "busy"].includes(context.producerStatus)) {
      throw invalidArgument("producerContext.producerStatus", "is unsupported for truth-shadow");
    }
    if (!["ready", "yield", "busy", "failed"].includes(context.gmailSyncDisposition)) {
      throw invalidArgument("producerContext.gmailSyncDisposition", "is unsupported for truth-shadow");
    }
    if (!["sealed", "not_ready", "not_run"].includes(context.sourceCutStatus)) {
      throw invalidArgument("producerContext.sourceCutStatus", "is unsupported for truth-shadow");
    }
    if (!["complete", "degraded", "not_run"].includes(context.sourceCutCompleteness)) {
      throw invalidArgument("producerContext.sourceCutCompleteness", "is unsupported for truth-shadow");
    }
    if (!["succeeded", "busy", "failed", "not_run"].includes(context.shadowBuildStatus)) {
      throw invalidArgument("producerContext.shadowBuildStatus", "is unsupported for truth-shadow");
    }
    if (!HASH_RE.test(context.sourceGapsHash)) {
      throw invalidArgument("producerContext.sourceGapsHash", "must bind the exact gap inventory");
    }
    if (context.sourceCutStatus === "sealed" && !SOURCE_CUT_ID_RE.test(context.sourceCutId)) {
      throw invalidArgument("producerContext.sourceCutId", "must identify the sealed source cut");
    }
    if (context.sourceCutStatus !== "sealed" && context.sourceCutId !== "") {
      throw invalidArgument("producerContext.sourceCutId", "must be empty when no source cut was sealed");
    }
    if (context.producerStatus === "failed") {
      if (!context.failureStage || !/^[A-Z0-9_]{3,100}$/.test(context.failureCode)) {
        throw invalidArgument("producerContext", "failed truth-shadow context requires a stage and safe code");
      }
    } else if (context.failureStage || context.failureCode) {
      throw invalidArgument("producerContext", "non-failed truth-shadow context cannot carry failure fields");
    }
    if (context.producerStatus === "succeeded") {
      const exactSuccess = context.gmailSyncDisposition === "ready"
        && context.workersDrained === true
        && context.workerFailureCount === 0
        && context.sourceCutStatus === "sealed"
        && context.sourceCutCompleteness === "complete"
        && context.sourceGapCount === 0
        && context.shadowBuildStatus === "succeeded";
      if (!exactSuccess) throw invalidArgument("producerContext", "successful truth-shadow context is incomplete");
    }
  } else {
    throw invalidArgument("producerContext.producerLane", "is unsupported");
  }
  return deepFreeze(context);
}

function standaloneAuditProducerContext() {
  return normalizeAuditProducerContext({
    schemaVersion: PRODUCER_CONTEXT_SCHEMA_VERSION,
    producerLane: PRODUCER_LANES.standalone,
    producerStatus: "ready",
    gmailSyncDisposition: "not_applicable",
    workerRounds: 0,
    workersDrained: true,
    workerFailureCount: 0,
    sourceCutStatus: "not_applicable",
    sourceCutId: "",
    sourceCutCompleteness: "not_applicable",
    sourceGapCount: 0,
    sourceGapsHash: "",
    shadowBuildStatus: "not_applicable",
    failureStage: "",
    failureCode: "",
  }, { expectedLane: PRODUCER_LANES.standalone });
}

function decodeJwtRole(apiKey) {
  const segments = String(apiKey || "").split(".");
  if (segments.length !== 3) return "";
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    return String(payload?.role || "");
  } catch {
    return "";
  }
}

function requireAuditApiKey(value) {
  const apiKey = requireString(value, "apiKey", { maxBytes: 16384 });
  const jwtRole = decodeJwtRole(apiKey);
  if (/^sb_secret_/i.test(apiKey) || ["service_role", "supabase_admin", "postgres"].includes(jwtRole)) {
    throw invalidArgument("apiKey", "must be an anon or publishable key, never a privileged secret key");
  }
  return apiKey;
}

function normalizeSupabaseUrl(value) {
  const raw = requireString(value, "supabaseUrl", { maxBytes: 2048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidArgument("supabaseUrl", "must be an absolute URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalidArgument("supabaseUrl", "must be a credential-free HTTPS origin");
  }
  return url.origin;
}

function clampTimeoutMs(value) {
  const timeoutMs = Number(value ?? 8000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30000) {
    throw invalidArgument("timeoutMs", "must be an integer from 250 through 30000");
  }
  return timeoutMs;
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthAuditLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown audit RPC failure"));
  let body = {};
  try {
    body = typeof cause.body === "string" ? JSON.parse(cause.body) : cause.body || {};
  } catch {
    body = {};
  }
  const status = Number(cause.status ?? cause.statusCode);
  const code = String(cause.code || body.code || "TRUTH_AUDIT_RPC_FAILED");
  return new TruthAuditLedgerError(`${operation} failed: ${cause.message}`, {
    code,
    operation,
    rpc,
    status: Number.isFinite(status) ? status : null,
    retryable: code === "40001" || status === 408 || status === 409 || status === 429 || status >= 500,
    deadlineExceeded: cause.deadlineExceeded === true,
    outcomeUnknown: cause.outcomeUnknown === true,
    cause,
  });
}

function structuredPostgrestErrorReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const code = String(value.code || "");
  const message = String(value.message || value.error || "");
  return Boolean(message) && (/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code));
}

function createDefaultRpcCaller(options = {}) {
  const supabaseUrl = normalizeSupabaseUrl(options.supabaseUrl ?? process.env.PQ_SUPABASE_URL ?? "");
  const apiKey = requireAuditApiKey(options.apiKey ?? process.env.PQ_SUPABASE_ANON_KEY ?? "");
  const fetchImpl = options.fetchImpl || global.fetch;
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  const signal = options.signal || null;
  const deadlineAtMs = options.deadlineAtMs ?? null;
  if (typeof fetchImpl !== "function") throw invalidArgument("fetchImpl", "must be a function");

  return async function callAuditRpc(rpc, body) {
    if (!ALLOWED_RPC.has(rpc)) throw invalidArgument("rpc", "is outside the truth-audit allowlist");
    const outcomeUnknown = [AUDIT_RPC.beginRun, AUDIT_RPC.completeRun, AUDIT_RPC.failRun].includes(rpc);
    const stage = `truth audit RPC ${rpc}`;
    throwIfAborted(signal, { stage, deadlineAtMs, outcomeUnknown: false });
    const scope = createAbortScope({ signal, timeoutMs, stage, outcomeUnknown });
    try {
      let response;
      try {
        response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${rpc}`, {
          method: "POST",
          redirect: "error",
          signal: scope.signal,
          headers: {
            apikey: apiKey,
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (!outcomeUnknown || isAbortError(error, scope.signal)) throw error;
        throw asOutcomeUnknownError(error, {
          stage: `${stage} transport`,
          deadlineAtMs,
          code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
        });
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        if (!response.ok) {
          const known = new Error(`Truth-audit RPC ${rpc} failed: ${response.status}`);
          known.status = response.status;
          if (outcomeUnknown && Number(response.status) >= 500) {
            throw asOutcomeUnknownError(error, {
              stage: `${stage} gateway receipt`,
              deadlineAtMs,
              code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
            });
          }
          throw known;
        }
        if (!outcomeUnknown) throw error;
        throw asOutcomeUnknownError(error, {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
        });
      }
      if (!response.ok) {
        let result = null;
        try { result = text ? JSON.parse(text) : null; } catch { /* deterministic HTTP rejection */ }
        const error = new Error(result?.message || result?.error || `Truth-audit RPC ${rpc} failed`);
        error.status = response.status;
        error.body = text;
        error.code = result?.code;
        if (outcomeUnknown && Number(response.status) >= 500 && !structuredPostgrestErrorReceipt(result)) {
          throw asOutcomeUnknownError(error, {
            stage: `${stage} gateway receipt`,
            deadlineAtMs,
            code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
          });
        }
        throw error;
      }
      const declaredBytes = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > 32 * 1024 * 1024) {
        const error = new TruthAuditLedgerError("Truth-audit RPC declared a response larger than 32 MiB", {
          code: "TRUTH_AUDIT_RPC_RESPONSE_TOO_LARGE",
          rpc,
        });
        if (outcomeUnknown) throw asOutcomeUnknownError(error, {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
        });
        throw error;
      }
      if (Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) {
        const error = new TruthAuditLedgerError("Truth-audit RPC response exceeded 32 MiB", {
          code: "TRUTH_AUDIT_RPC_RESPONSE_TOO_LARGE",
          rpc,
        });
        if (outcomeUnknown) throw asOutcomeUnknownError(error, {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
        });
        throw error;
      }
      if (!text && outcomeUnknown) {
        throw asOutcomeUnknownError(new Error(`Truth-audit RPC ${rpc} returned an empty success receipt`), {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
        });
      }
      let result = null;
      try {
        result = text ? JSON.parse(text) : null;
      } catch (cause) {
        if (outcomeUnknown) throw asOutcomeUnknownError(cause, {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "TRUTH_AUDIT_RPC_OUTCOME_UNKNOWN",
        });
        throw new TruthAuditLedgerError("Truth-audit RPC returned invalid JSON", {
          code: "TRUTH_AUDIT_RPC_INVALID_JSON",
          rpc,
          cause,
        });
      }
      return result;
    } catch (error) {
      if (isAbortError(error, scope.signal)) {
        throw asDeadlineError(error, {
          signal: scope.signal,
          stage,
          deadlineAtMs,
          outcomeUnknown,
        });
      }
      throw error;
    } finally {
      scope.cleanup();
    }
  };
}

function validateSnapshot(value) {
  if (!isPlainObject(value) || value.schemaVersion !== "relational-truth-audit-snapshot-v1") {
    throw new TruthAuditLedgerError("Invalid truth-audit snapshot receipt", {
      code: "TRUTH_AUDIT_INVALID_RECEIPT",
      operation: "read snapshot",
    });
  }
  if (!isPlainObject(value.bounds) || typeof value.bounds.truncated !== "boolean") {
    throw new TruthAuditLedgerError("Truth-audit snapshot is missing its bound witness", {
      code: "TRUTH_AUDIT_INVALID_RECEIPT",
      operation: "read snapshot",
    });
  }
  return deepFreeze(cloneJson(value, "snapshot"));
}

const SNAPSHOT_EXTENSION_COUNT_KEYS = Object.freeze([
  "attachmentExtractionGaps",
  "modelExtractionJobGaps",
  "modelExtractionReviewGaps",
  "processingWatermarkBuildPairs",
  "processingWatermarkPublications",
  "shipmentMetadataEnvelopes",
]);
const SNAPSHOT_CLOSURE_KEYS = Object.freeze([
  "acceptedClaimEnvelopes",
  "buildInputs",
  "entityLinkEnvelopes",
  "sourceCutEvidenceObservations",
]);
const SNAPSHOT_PROCESSING_KEYS = Object.freeze([
  "jobChildren",
  "jobLineage",
  "jobObservations",
  "jobs",
  "observations",
]);

function invalidSnapshotExtension(field, reason) {
  return new TruthAuditLedgerError(`Invalid truth-audit snapshot extension ${field}: ${reason}`, {
    code: "TRUTH_AUDIT_INVALID_RECEIPT",
    operation: "read snapshot extensions",
    field,
  });
}

function exactSnapshotExtensionKeys(value, expected, field) {
  if (!isPlainObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw invalidSnapshotExtension(field, "has an unexpected field set");
  }
}

function validateSnapshotExtensions(value, options = {}) {
  exactSnapshotExtensionKeys(value, [
    "bounds",
    "canonical",
    "rowLimit",
    "schemaVersion",
    "source",
    "sourceCutId",
    "workspaceKey",
  ], "receipt");
  if (value.schemaVersion !== "relational-truth-audit-snapshot-extensions-v1") {
    throw invalidSnapshotExtension("schemaVersion", "is unsupported");
  }
  if (value.workspaceKey !== options.workspaceKey
      || value.rowLimit !== options.rowLimit
      || value.sourceCutId !== options.sourceCutId) {
    throw invalidSnapshotExtension("binding", "does not match the base snapshot");
  }
  exactSnapshotExtensionKeys(value.bounds, ["counts", "truncated"], "bounds");
  exactSnapshotExtensionKeys(value.bounds.counts, SNAPSHOT_EXTENSION_COUNT_KEYS, "bounds.counts");
  if (typeof value.bounds.truncated !== "boolean") {
    throw invalidSnapshotExtension("bounds.truncated", "must be a boolean");
  }
  for (const key of SNAPSHOT_EXTENSION_COUNT_KEYS) {
    if (!Number.isSafeInteger(value.bounds.counts[key]) || value.bounds.counts[key] < 0) {
      throw invalidSnapshotExtension(`bounds.counts.${key}`, "must be a non-negative integer");
    }
  }
  exactSnapshotExtensionKeys(value.source, [
    "attachmentExtractionCompleteness",
    "attachmentExtractionGaps",
    "modelExtractionCompleteness",
    "modelExtractionJobGaps",
    "modelExtractionReviewGaps",
  ], "source");
  exactSnapshotExtensionKeys(
    value.canonical,
    ["processingWatermarkContinuity", "shipmentMetadataEnvelopes"],
    "canonical",
  );
  const arrays = [
    ["attachmentExtractionGaps", value.source.attachmentExtractionGaps],
    ["modelExtractionJobGaps", value.source.modelExtractionJobGaps],
    ["modelExtractionReviewGaps", value.source.modelExtractionReviewGaps],
    ["processingWatermarkBuildPairs", value.canonical.processingWatermarkContinuity?.buildPairs],
    ["processingWatermarkPublications", value.canonical.processingWatermarkContinuity?.publications],
    ["shipmentMetadataEnvelopes", value.canonical.shipmentMetadataEnvelopes],
  ];
  for (const [key, rows] of arrays) {
    if (!Array.isArray(rows)
        || rows.length > value.rowLimit
        || rows.length > value.bounds.counts[key]) {
      throw invalidSnapshotExtension(key, "does not reconcile to its bound");
    }
  }
  const attachment = value.source.attachmentExtractionCompleteness;
  if (!isPlainObject(attachment)
      || attachment.schemaVersion !== "gmail-attachment-extraction-completeness-v1"
      || attachment.unresolvedCount !== value.bounds.counts.attachmentExtractionGaps
      || attachment.complete !== (attachment.unresolvedCount === 0)) {
    throw invalidSnapshotExtension("source.attachmentExtractionCompleteness", "is inconsistent");
  }
  const model = value.source.modelExtractionCompleteness;
  if (!isPlainObject(model)
      || model.schemaVersion !== "gmail-model-extraction-completeness-v1"
      || model.pendingJobCount !== value.bounds.counts.modelExtractionJobGaps
      || model.pendingReviewCount !== value.bounds.counts.modelExtractionReviewGaps
      || model.complete !== (model.pendingJobCount + model.pendingReviewCount === 0)) {
    throw invalidSnapshotExtension("source.modelExtractionCompleteness", "is inconsistent");
  }
  const watermark = value.canonical.processingWatermarkContinuity;
  if (!isPlainObject(watermark)
      || watermark.schemaVersion !== "truth-processing-watermark-continuity-v1"
      || watermark.sourceCutId !== value.sourceCutId
      || !Number.isSafeInteger(watermark.mismatchCount)
      || watermark.mismatchCount < 0
      || !Number.isSafeInteger(watermark.legacyUnwatermarkedPairCount)
      || watermark.legacyUnwatermarkedPairCount < 0
      || typeof watermark.complete !== "boolean") {
    throw invalidSnapshotExtension("canonical.processingWatermarkContinuity", "is invalid");
  }
  const expectedTruncated = SNAPSHOT_EXTENSION_COUNT_KEYS.some(
    (key) => value.bounds.counts[key] > value.rowLimit,
  );
  if (value.bounds.truncated !== expectedTruncated) {
    throw invalidSnapshotExtension("bounds.truncated", "does not reconcile to the counts");
  }
  return deepFreeze(cloneJson(value, "snapshotExtensions"));
}

function validateSnapshotPublicationPayloads(value, options = {}) {
  exactSnapshotExtensionKeys(value, [
    "publicationHeads",
    "publicationPayloadByteLimit",
    "publicationPayloadBytes",
    "publicationPayloadCount",
    "publicationPayloads",
    "rowLimit",
    "schemaVersion",
    "sourceCutId",
    "truncated",
    "workspaceKey",
  ], "publicationPayloads");
  if (value.schemaVersion !== "relational-truth-audit-publication-payloads-v1"
      || value.workspaceKey !== options.workspaceKey
      || value.rowLimit !== options.rowLimit
      || value.sourceCutId !== options.sourceCutId) {
    throw invalidSnapshotExtension("publicationPayloads.binding", "does not match the base snapshot");
  }
  if (!Array.isArray(value.publicationHeads)
      || JSON.stringify(value.publicationHeads) !== JSON.stringify(options.publicationHeads)) {
    throw invalidSnapshotExtension("publicationPayloads.publicationHeads", "changed from the base snapshot");
  }
  for (const field of ["publicationPayloadCount", "publicationPayloadBytes", "publicationPayloadByteLimit"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw invalidSnapshotExtension(`publicationPayloads.${field}`, "must be a non-negative integer");
    }
  }
  if (value.publicationPayloadByteLimit !== 32 * 1024 * 1024
      || typeof value.truncated !== "boolean"
      || !Array.isArray(value.publicationPayloads)) {
    throw invalidSnapshotExtension("publicationPayloads", "has an invalid bound");
  }
  const expectedTruncated = value.publicationPayloadCount > value.rowLimit
    || value.publicationPayloadBytes > value.publicationPayloadByteLimit;
  if (value.truncated !== expectedTruncated
      || (!value.truncated && value.publicationPayloads.length !== value.publicationPayloadCount)
      || (value.truncated && value.publicationPayloads.length !== 0)) {
    throw invalidSnapshotExtension("publicationPayloads.truncated", "does not reconcile to the payload inventory");
  }
  return deepFreeze(cloneJson(value, "snapshotPublicationPayloads"));
}

function validateSnapshotClosure(value, options = {}) {
  exactSnapshotExtensionKeys(value, [
    "bounds",
    "canonical",
    "rowLimit",
    "schemaVersion",
    "sourceCutId",
    "workspaceKey",
  ], "closure");
  if (value.schemaVersion !== "relational-truth-audit-closure-v1"
      || value.workspaceKey !== options.workspaceKey
      || value.rowLimit !== options.rowLimit
      || value.sourceCutId !== options.sourceCutId) {
    throw invalidSnapshotExtension("closure.binding", "does not match the base snapshot");
  }
  exactSnapshotExtensionKeys(value.bounds, ["counts", "truncated"], "closure.bounds");
  exactSnapshotExtensionKeys(value.bounds.counts, SNAPSHOT_CLOSURE_KEYS, "closure.bounds.counts");
  exactSnapshotExtensionKeys(value.canonical, SNAPSHOT_CLOSURE_KEYS, "closure.canonical");
  for (const key of SNAPSHOT_CLOSURE_KEYS) {
    const count = value.bounds.counts[key];
    const rows = value.canonical[key];
    if (!Number.isSafeInteger(count)
        || count < 0
        || count !== options.baseCounts?.[key]
        || !Array.isArray(rows)
        || rows.length > value.rowLimit
        || rows.length > count) {
      throw invalidSnapshotExtension(`closure.${key}`, "does not reconcile to the base bound");
    }
  }
  const expectedTruncated = SNAPSHOT_CLOSURE_KEYS.some(
    (key) => value.bounds.counts[key] > value.rowLimit,
  );
  if (value.bounds.truncated !== expectedTruncated) {
    throw invalidSnapshotExtension("closure.bounds.truncated", "does not reconcile to the counts");
  }
  return deepFreeze(cloneJson(value, "snapshotClosure"));
}

function validateSnapshotProcessing(value, options = {}) {
  exactSnapshotExtensionKeys(value, [
    "bounds",
    "currentBatchIds",
    "rowLimit",
    "schemaVersion",
    "source",
    "sourceCutId",
    "workspaceKey",
  ], "processing");
  if (value.schemaVersion !== "relational-truth-audit-processing-v1"
      || value.workspaceKey !== options.workspaceKey
      || value.rowLimit !== options.rowLimit
      || value.sourceCutId !== options.sourceCutId) {
    throw invalidSnapshotExtension("processing.binding", "does not match the base snapshot");
  }
  if (!Array.isArray(value.currentBatchIds)
      || JSON.stringify([...value.currentBatchIds].sort()) !== JSON.stringify(options.currentBatchIds)) {
    throw invalidSnapshotExtension("processing.currentBatchIds", "changed from the base snapshot");
  }
  exactSnapshotExtensionKeys(value.bounds, ["counts", "truncated"], "processing.bounds");
  exactSnapshotExtensionKeys(value.bounds.counts, SNAPSHOT_PROCESSING_KEYS, "processing.bounds.counts");
  exactSnapshotExtensionKeys(value.source, SNAPSHOT_PROCESSING_KEYS, "processing.source");
  for (const key of SNAPSHOT_PROCESSING_KEYS) {
    const count = value.bounds.counts[key];
    const rows = value.source[key];
    if (!Number.isSafeInteger(count)
        || count < 0
        || count !== options.baseCounts?.[key]
        || !Array.isArray(rows)
        || rows.length > value.rowLimit
        || rows.length > count) {
      throw invalidSnapshotExtension(`processing.${key}`, "does not reconcile to the base bound");
    }
  }
  const expectedTruncated = SNAPSHOT_PROCESSING_KEYS.some(
    (key) => value.bounds.counts[key] > value.rowLimit,
  );
  if (value.bounds.truncated !== expectedTruncated) {
    throw invalidSnapshotExtension("processing.bounds.truncated", "does not reconcile to the counts");
  }
  return deepFreeze(cloneJson(value, "snapshotProcessing"));
}

function mergeSnapshotReceipts(
  baseValue,
  publicationValue,
  processingValue,
  closureValue,
  extensionValue,
  options = {},
) {
  const base = validateSnapshot(baseValue);
  const rowLimit = options.rowLimit ?? base.bounds.rowLimit;
  if (!Number.isSafeInteger(rowLimit) || base.bounds.rowLimit !== rowLimit) {
    throw invalidSnapshotExtension("rowLimit", "does not match the requested base bound");
  }
  const sourceCutId = String(base.canonical?.currentSourceCutId || "");
  const publication = validateSnapshotPublicationPayloads(publicationValue, {
    workspaceKey: base.workspaceKey,
    rowLimit,
    sourceCutId,
    publicationHeads: base.canonical?.publicationHeads,
  });
  const processing = validateSnapshotProcessing(processingValue, {
    workspaceKey: base.workspaceKey,
    rowLimit,
    sourceCutId,
    baseCounts: base.bounds.counts,
    currentBatchIds: (base.source?.ingestBatches || [])
      .map((batch) => String(batch.batch_id || ""))
      .filter(Boolean)
      .sort(),
  });
  const closure = validateSnapshotClosure(closureValue, {
    workspaceKey: base.workspaceKey,
    rowLimit,
    sourceCutId,
    baseCounts: base.bounds.counts,
  });
  const extension = validateSnapshotExtensions(extensionValue, {
    workspaceKey: base.workspaceKey,
    rowLimit,
    sourceCutId,
  });
  const merged = cloneJson(base, "snapshotBase");
  merged.canonical.publicationPayloads = cloneJson(
    publication.publicationPayloads,
    "snapshotPublicationPayloads.publicationPayloads",
  );
  merged.bounds.counts.publicationPayloads = publication.publicationPayloadCount;
  merged.bounds.publicationPayloadBytes = publication.publicationPayloadBytes;
  merged.bounds.publicationPayloadByteLimit = publication.publicationPayloadByteLimit;
  merged.bounds.truncated = merged.bounds.truncated || publication.truncated;
  for (const key of SNAPSHOT_PROCESSING_KEYS) {
    merged.source[key] = cloneJson(processing.source[key], `snapshotProcessing.source.${key}`);
  }
  merged.bounds.truncated = merged.bounds.truncated || processing.bounds.truncated;
  for (const key of SNAPSHOT_CLOSURE_KEYS) {
    merged.canonical[key] = cloneJson(closure.canonical[key], `snapshotClosure.canonical.${key}`);
  }
  merged.bounds.truncated = merged.bounds.truncated || closure.bounds.truncated;
  merged.source = { ...merged.source, ...cloneJson(extension.source, "snapshotExtensions.source") };
  merged.canonical = {
    ...merged.canonical,
    ...cloneJson(extension.canonical, "snapshotExtensions.canonical"),
  };
  merged.bounds.counts = {
    ...merged.bounds.counts,
    ...cloneJson(extension.bounds.counts, "snapshotExtensions.bounds.counts"),
  };
  merged.bounds.truncated = merged.bounds.truncated || extension.bounds.truncated;
  return validateSnapshot(merged);
}

const STATUS_HEALTH_VALUES = new Set([
  "never_run",
  "running",
  "failed",
  "stale",
  "regressions",
  "degraded",
  "attention",
  "healthy",
]);

const STATUS_TOP_KEYS = Object.freeze([
  "counts",
  "findingCount",
  "findings",
  "findingsTruncated",
  "health",
  "lanes",
  "mutatesOperationalState",
  "ok",
  "policy",
  "schemaVersion",
  "stale",
  "workspaceKey",
]);
const STATUS_LANE_KEYS = Object.freeze([
  "auditMode",
  "counts",
  "expectedIntervalSeconds",
  "findingCount",
  "findings",
  "findingsTruncated",
  "health",
  "lastSuccessfulFinishedAt",
  "latestCompleted",
  "latestRun",
  "latestSuccess",
  "mutatesOperationalState",
  "producerContextValid",
  "producerLane",
  "producerStatus",
  "schemaVersion",
  "secondsSinceLastSuccess",
  "secondsSinceLatestRun",
  "stale",
  "staleAfterSeconds",
]);
const STATUS_RUN_KEYS = Object.freeze([
  "auditMode",
  "auditRunId",
  "errorCode",
  "errorDetail",
  "expectedIntervalSeconds",
  "finishedAt",
  "leaseExpired",
  "leaseExpiresAt",
  "metrics",
  "modelVersion",
  "mutatesOperationalState",
  "observerVersion",
  "packetHash",
  "producerContext",
  "producerContextValid",
  "productionPacketHash",
  "sourceCutId",
  "startedAt",
  "status",
]);
const STATUS_SUCCESS_KEYS = Object.freeze([
  "auditMode",
  "auditRunId",
  "expectedIntervalSeconds",
  "finishedAt",
  "mutatesOperationalState",
  "producerContext",
  "producerContextValid",
  "status",
]);

function invalidStatusReceipt(field, reason) {
  return new TruthAuditLedgerError(`Invalid truth-audit status receipt ${field}: ${reason}`, {
    code: "TRUTH_AUDIT_INVALID_RECEIPT",
    operation: "read status",
    field,
  });
}

function exactStatusKeys(value, expected, field) {
  if (!isPlainObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw invalidStatusReceipt(field, "has an unexpected field set");
  }
}

function nonNegativeStatusInteger(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidStatusReceipt(field, "must be a non-negative integer");
  }
}

function canonicalStatusJson(value) {
  if (Array.isArray(value)) return value.map(canonicalStatusJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalStatusJson(value[key]);
    return output;
  }, {});
}

function statusFindingInventory(findings) {
  return findings.map((finding) => JSON.stringify(canonicalStatusJson(finding))).sort();
}

function validateStatusCounts(counts, field) {
  exactStatusKeys(counts, ["attention", "blocking", "informational"], field);
  for (const severity of AUDIT_SEVERITIES) {
    if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0) {
      throw invalidStatusReceipt(`${field}.${severity}`, "must be a non-negative integer");
    }
  }
}

function validateStatusRun(run, field, laneHealth, laneStale, expectedLane, expectedAuditMode, expectedInterval) {
  if (run === null) return;
  exactStatusKeys(run, STATUS_RUN_KEYS, field);
  if (!isPlainObject(run)
      || !UUID_RE.test(String(run.auditRunId || ""))
      || !["running", "succeeded", "failed"].includes(run.status)
      || run.auditMode !== expectedAuditMode
      || run.expectedIntervalSeconds !== expectedInterval
      || run.mutatesOperationalState !== false
      || typeof run.producerContextValid !== "boolean"
      || !isPlainObject(run.metrics)) {
    throw invalidStatusReceipt(field, "is invalid");
  }
  if (run.producerContext !== null) {
    try {
      normalizeAuditProducerContext(run.producerContext, { expectedLane });
    } catch (cause) {
      throw invalidStatusReceipt(`${field}.producerContext`, cause.message);
    }
  }
  if (run.producerContextValid && run.producerContext === null) {
    throw invalidStatusReceipt(`${field}.producerContext`, "cannot be null when declared valid");
  }
  if (!run.producerContextValid && run.producerContext !== null) {
    throw invalidStatusReceipt(`${field}.producerContext`, "must be redacted when invalid");
  }
  if (!run.producerContextValid && Object.hasOwn(run.metrics, "producerContext")) {
    throw invalidStatusReceipt(`${field}.metrics.producerContext`, "must be absent when metadata is invalid");
  }
  if (run.status !== "running" && run.producerContextValid) {
    const metricContext = run.metrics?.producerContext;
    if (JSON.stringify(canonicalStatusJson(metricContext)) !==
        JSON.stringify(canonicalStatusJson(run.producerContext))) {
      throw invalidStatusReceipt(`${field}.metrics.producerContext`, "does not match the bound producer context");
    }
  }
  if (run.status === "running" && (
    typeof run.leaseExpiresAt !== "string"
    || !run.leaseExpiresAt
    || typeof run.leaseExpired !== "boolean"
    || (run.leaseExpired && (laneHealth !== "stale" || laneStale !== true))
  )) {
    throw invalidStatusReceipt(`${field}.leaseExpiresAt`, "is invalid for a running audit");
  }
}

function validateLatestSuccess(success, field, expectedLane, expectedAuditMode, expectedIntervalSeconds) {
  if (success === null) return;
  exactStatusKeys(success, STATUS_SUCCESS_KEYS, field);
  if (!UUID_RE.test(String(success.auditRunId || ""))
      || success.auditMode !== expectedAuditMode
      || success.expectedIntervalSeconds !== expectedIntervalSeconds
      || success.status !== "succeeded"
      || typeof success.finishedAt !== "string"
      || !success.finishedAt
      || success.producerContextValid !== true
      || success.mutatesOperationalState !== false) {
    throw invalidStatusReceipt(field, "is invalid");
  }
  let context;
  try {
    context = normalizeAuditProducerContext(success.producerContext, { expectedLane });
  } catch (cause) {
    throw invalidStatusReceipt(`${field}.producerContext`, cause.message);
  }
  const successDisposition = expectedLane === PRODUCER_LANES.shadow ? "succeeded" : "ready";
  if (context.producerStatus !== successDisposition) {
    throw invalidStatusReceipt(`${field}.producerContext.producerStatus`, "is not a successful lane disposition");
  }
}

function completedProducerDisposition(lane) {
  const completed = lane.latestCompleted;
  if (!completed) return null;
  if (completed.status === "failed" || !completed.producerContextValid) return "failed";
  return completed.producerContext.producerStatus;
}

function expectedLaneHealth(lane) {
  if (lane.latestRun === null) return "never_run";
  if (lane.latestRun.status === "failed") return "failed";
  if (!lane.producerContextValid) return "failed";
  if (lane.stale) return "stale";
  if (lane.producerStatus === "failed") return "failed";
  if (["degraded", "busy"].includes(lane.producerStatus)) return "degraded";
  const completedDisposition = completedProducerDisposition(lane);
  if (lane.latestRun.status === "running" && completedDisposition === "failed") return "failed";
  if (lane.latestRun.status === "running" && ["degraded", "busy"].includes(completedDisposition)) {
    return "degraded";
  }
  const boundDisposition = lane.latestRun.producerContext?.producerStatus;
  if (boundDisposition === "failed") return "failed";
  if (["degraded", "busy"].includes(boundDisposition)) return "degraded";
  if (lane.counts.blocking > 0) return "regressions";
  if (lane.counts.attention > 0) return "attention";
  if (lane.latestRun.status === "running") return "running";
  return "healthy";
}

function worstLaneHealth(lanes) {
  const order = ["failed", "stale", "never_run", "regressions", "degraded", "running", "attention", "healthy"];
  return order.find((health) => lanes.some((lane) => lane.health === health)) || "failed";
}

function validateLaneStatus(
  lane,
  expectedLane,
  expectedIntervalSeconds,
  staleAfterSeconds,
  field,
  findingLimit = 50,
) {
  exactStatusKeys(lane, STATUS_LANE_KEYS, field);
  const expectedAuditMode = expectedLane === PRODUCER_LANES.shadow ? "delta" : "hourly";
  if (!isPlainObject(lane)
      || lane.schemaVersion !== "truth-audit-lane-status-v1"
      || lane.producerLane !== expectedLane
      || lane.auditMode !== expectedAuditMode
      || !STATUS_HEALTH_VALUES.has(lane.health)
      || typeof lane.stale !== "boolean"
      || lane.expectedIntervalSeconds !== expectedIntervalSeconds
      || lane.staleAfterSeconds !== staleAfterSeconds
      || !Number.isSafeInteger(lane.findingCount)
      || lane.findingCount < 0
      || !Array.isArray(lane.findings)
      || lane.findingCount < lane.findings.length
      || typeof lane.findingsTruncated !== "boolean"
      || typeof lane.producerContextValid !== "boolean"
      || lane.mutatesOperationalState !== false) {
    throw invalidStatusReceipt(field, "is invalid");
  }
  validateStatusCounts(lane.counts, `${field}.counts`);
  if (lane.findingCount !== Object.values(lane.counts).reduce((sum, count) => sum + count, 0)
      || lane.findings.length !== Math.min(findingLimit, lane.findingCount)
      || lane.findingsTruncated !== (lane.findingCount > lane.findings.length)) {
    throw invalidStatusReceipt(field, "finding counts do not reconcile");
  }
  validateStatusRun(
    lane.latestRun,
    `${field}.latestRun`,
    lane.health,
    lane.stale,
    expectedLane,
    expectedAuditMode,
    expectedIntervalSeconds,
  );
  validateStatusRun(
    lane.latestCompleted,
    `${field}.latestCompleted`,
    lane.health,
    lane.stale,
    expectedLane,
    expectedAuditMode,
    expectedIntervalSeconds,
  );
  if (lane.latestCompleted !== null && lane.latestCompleted.status === "running") {
    throw invalidStatusReceipt(`${field}.latestCompleted`, "must be a final run");
  }
  validateLatestSuccess(
    lane.latestSuccess,
    `${field}.latestSuccess`,
    expectedLane,
    expectedAuditMode,
    expectedIntervalSeconds,
  );
  nonNegativeStatusInteger(lane.secondsSinceLatestRun, `${field}.secondsSinceLatestRun`, { nullable: true });
  nonNegativeStatusInteger(lane.secondsSinceLastSuccess, `${field}.secondsSinceLastSuccess`, { nullable: true });
  if ((lane.latestRun === null) !== (lane.secondsSinceLatestRun === null)
      || (lane.latestSuccess === null) !== (lane.secondsSinceLastSuccess === null)
      || lane.lastSuccessfulFinishedAt !== (lane.latestSuccess?.finishedAt ?? null)) {
    throw invalidStatusReceipt(field, "run and success ages do not reconcile");
  }
  const expectedProducerStatus = lane.latestRun === null
    ? "never_run"
    : !lane.producerContextValid
      ? "metadata_missing"
      : lane.latestRun.status === "running"
        ? "running"
        : lane.latestRun.status === "failed"
          ? "failed"
          : lane.latestRun.producerContext.producerStatus;
  if (lane.producerStatus !== expectedProducerStatus
      || lane.producerContextValid !== (lane.latestRun?.producerContextValid ?? false)) {
    throw invalidStatusReceipt(field, "producer disposition does not match the latest run");
  }
  if (lane.latestRun?.status !== "running" && (
    lane.latestCompleted?.auditRunId !== lane.latestRun?.auditRunId
  )) {
    throw invalidStatusReceipt(`${field}.latestCompleted`, "must equal the latest final run");
  }
  if (lane.latestCompleted === null && lane.findingCount !== 0) {
    throw invalidStatusReceipt(field, "cannot expose findings without a completed run");
  }
  lane.findings.forEach((finding, index) => {
    try { normalizeFinding(finding, index); } catch (cause) {
      throw invalidStatusReceipt(`${field}.findings[${index}]`, cause.message);
    }
  });
  for (let index = 1; index < lane.findings.length; index += 1) {
    if (compareStatusFindings(lane.findings[index - 1], lane.findings[index]) > 0) {
      throw invalidStatusReceipt(`${field}.findings`, "must use deterministic severity ordering");
    }
  }
  if (lane.latestRun === null && (lane.health !== "never_run" || lane.stale !== true)) {
    throw invalidStatusReceipt(field, "must fail closed when the lane has never run");
  }
  if (lane.health !== expectedLaneHealth(lane)) {
    throw invalidStatusReceipt(`${field}.health`, "does not match the deterministic lane policy");
  }
}

function statusFindingRank(finding) {
  return [
    { blocking: 0, attention: 1, informational: 2 }[finding.severity] ?? 3,
    String(finding.stage || ""),
    String(finding.classification || ""),
    String(finding.subjectKey || ""),
    String(finding.findingId || ""),
  ];
}

function compareStatusFindings(left, right) {
  const leftRank = statusFindingRank(left);
  const rightRank = statusFindingRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] < rightRank[index]) return -1;
    if (leftRank[index] > rightRank[index]) return 1;
  }
  return 0;
}

function validateStatus(value, options = {}) {
  const findingLimit = Number(options.findingLimit ?? 50);
  if (!Number.isSafeInteger(findingLimit) || findingLimit < 1 || findingLimit > 200) {
    throw invalidStatusReceipt("findingLimit", "is invalid");
  }
  exactStatusKeys(value, STATUS_TOP_KEYS, "status");
  if (!isPlainObject(value)
      || value.schemaVersion !== "truth-audit-status-v2"
      || value.ok !== true
      || typeof value.workspaceKey !== "string"
      || !value.workspaceKey
      || value.workspaceKey.trim() !== value.workspaceKey
      || (options.expectedWorkspaceKey && value.workspaceKey !== options.expectedWorkspaceKey)
      || !STATUS_HEALTH_VALUES.has(value.health)
      || typeof value.stale !== "boolean"
      || value.mutatesOperationalState !== false
      || !isPlainObject(value.lanes)
      || !isPlainObject(value.policy)
      || value.policy.schemaVersion !== "truth-audit-lane-status-policy-v1"
      || !Array.isArray(value.findings)
      || !Number.isSafeInteger(value.findingCount)
      || value.findingCount < value.findings.length
      || typeof value.findingsTruncated !== "boolean") {
    throw new TruthAuditLedgerError("Invalid truth-audit status receipt", {
      code: "TRUTH_AUDIT_INVALID_RECEIPT",
      operation: "read status",
    });
  }
  exactStatusKeys(value.policy, ["lanes", "schemaVersion"], "policy");
  exactStatusKeys(value.policy.lanes, [PRODUCER_LANES.shadow, PRODUCER_LANES.standalone], "policy.lanes");
  const expectedPolicies = {
    [PRODUCER_LANES.shadow]: { auditMode: "delta", expectedIntervalSeconds: 300, staleAfterSeconds: 600 },
    [PRODUCER_LANES.standalone]: { auditMode: "hourly", expectedIntervalSeconds: 900, staleAfterSeconds: 1800 },
  };
  for (const [laneName, expectedPolicy] of Object.entries(expectedPolicies)) {
    exactStatusKeys(
      value.policy.lanes[laneName],
      ["auditMode", "expectedIntervalSeconds", "staleAfterSeconds"],
      `policy.lanes.${laneName}`,
    );
    if (Object.entries(expectedPolicy).some(([key, expected]) => value.policy.lanes[laneName][key] !== expected)) {
      throw invalidStatusReceipt(`policy.lanes.${laneName}`, "does not match the versioned threshold policy");
    }
  }
  validateStatusCounts(value.counts, "counts");
  validateLaneStatus(
    value.lanes[PRODUCER_LANES.shadow],
    PRODUCER_LANES.shadow,
    300,
    600,
    `lanes.${PRODUCER_LANES.shadow}`,
    findingLimit,
  );
  validateLaneStatus(
    value.lanes[PRODUCER_LANES.standalone],
    PRODUCER_LANES.standalone,
    900,
    1800,
    `lanes.${PRODUCER_LANES.standalone}`,
    findingLimit,
  );
  if (Object.keys(value.lanes).sort().join(",") !==
      [PRODUCER_LANES.standalone, PRODUCER_LANES.shadow].sort().join(",")) {
    throw invalidStatusReceipt("lanes", "must contain only the two required producer lanes");
  }
  const laneValues = [value.lanes[PRODUCER_LANES.shadow], value.lanes[PRODUCER_LANES.standalone]];
  const expectedCounts = Object.fromEntries([...AUDIT_SEVERITIES].map((severity) => [
    severity,
    laneValues.reduce((sum, lane) => sum + lane.counts[severity], 0),
  ]));
  const expectedFindingCount = laneValues.reduce((sum, lane) => sum + lane.findingCount, 0);
  const expectedFindings = laneValues.flatMap((lane) => lane.findings)
    .sort(compareStatusFindings)
    .slice(0, findingLimit);
  if (value.health !== worstLaneHealth(laneValues)
      || value.stale !== laneValues.some((lane) => lane.stale === true)
      || Object.entries(expectedCounts).some(([severity, count]) => value.counts[severity] !== count)
      || value.findingCount !== expectedFindingCount
      || value.findings.length !== Math.min(findingLimit, expectedFindingCount)
      || value.findingsTruncated !== (expectedFindingCount > value.findings.length)
      || JSON.stringify(statusFindingInventory(value.findings)) !==
        JSON.stringify(statusFindingInventory(expectedFindings))) {
    throw invalidStatusReceipt("status", "does not reconcile exactly to both producer lanes");
  }
  value.findings.forEach((finding, index) => {
    try { normalizeFinding(finding, index); } catch (cause) {
      throw invalidStatusReceipt(`findings[${index}]`, cause.message);
    }
  });
  for (let index = 1; index < value.findings.length; index += 1) {
    if (compareStatusFindings(value.findings[index - 1], value.findings[index]) > 0) {
      throw invalidStatusReceipt("findings", "must use deterministic cross-lane ordering");
    }
  }
  return deepFreeze(cloneJson(value, "status"));
}

function validateRunReceipt(value, operation, expectedStatus) {
  if (!isPlainObject(value) || value.ok !== true || value.status !== expectedStatus ||
      !UUID_RE.test(String(value.auditRunId || "")) || value.mutatesOperationalState !== false) {
    throw new TruthAuditLedgerError(`Invalid truth-audit ${operation} receipt`, {
      code: "TRUTH_AUDIT_INVALID_RECEIPT",
      operation,
    });
  }
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateBeginReceipt(value) {
  if (isPlainObject(value) && value.ok === true && value.status === "busy" &&
      value.skipped === true && value.code === "AUDIT_BUSY" &&
      UUID_RE.test(String(value.auditRunId || "")) && value.mutatesOperationalState === false) {
    return deepFreeze(cloneJson(value, "begin run.receipt"));
  }
  return validateRunReceipt(value, "begin run", "running");
}

function normalizeStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidArgument(field, "must be an array");
  return [...new Set(value.map((item, index) => requireString(item, `${field}[${index}]`, {
    maxBytes: 8192,
  })))].sort();
}

function normalizeFinding(value, index) {
  const field = `findings[${index}]`;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  const findingId = requireString(value.findingId, `${field}.findingId`);
  if (!FINDING_ID_RE.test(findingId)) throw invalidArgument(`${field}.findingId`, "is invalid");
  const stage = requireString(value.stage, `${field}.stage`);
  if (!AUDIT_STAGES.has(stage)) throw invalidArgument(`${field}.stage`, "is unsupported");
  const severity = requireString(value.severity, `${field}.severity`);
  if (!AUDIT_SEVERITIES.has(severity)) throw invalidArgument(`${field}.severity`, "is unsupported");
  if (value.mutatesOperationalState !== false) {
    throw invalidArgument(`${field}.mutatesOperationalState`, "must be false");
  }
  return {
    findingId,
    stage,
    severity,
    classification: requireString(value.classification, `${field}.classification`, { maxBytes: 200 }),
    subjectType: requireString(value.subjectType ?? "", `${field}.subjectType`, {
      allowEmpty: true,
      maxBytes: 200,
    }),
    subjectKey: requireString(value.subjectKey ?? "", `${field}.subjectKey`, {
      allowEmpty: true,
      maxBytes: 8192,
    }),
    evidenceIds: normalizeStringArray(value.evidenceIds, `${field}.evidenceIds`),
    evidenceObservationIds: normalizeStringArray(
      value.evidenceObservationIds,
      `${field}.evidenceObservationIds`,
    ),
    detail: cloneJson(value.detail ?? {}, `${field}.detail`),
    mutatesOperationalState: false,
  };
}

function safeErrorDetail(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function createTruthAuditLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const allowedOptions = new Set([
    "workspaceKey",
    "auditToken",
    "callRpc",
    "supabaseUrl",
    "apiKey",
    "fetchImpl",
    "timeoutMs",
    "signal",
    "deadlineAtMs",
    "writesDisabled",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw invalidArgument(key, "is not an audit-ledger dependency");
  }
  const workspaceKey = requireString(options.workspaceKey ?? "primary", "workspaceKey", { maxBytes: 200 });
  const auditToken = requireString(
    options.auditToken ?? process.env.PQ_TRUTH_AUDIT_TOKEN ?? "",
    "auditToken",
    { maxBytes: 4096 },
  );
  if (auditToken.length < 16) throw invalidArgument("auditToken", "must contain at least 16 characters");
  if (options.writesDisabled !== undefined && typeof options.writesDisabled !== "boolean") {
    throw invalidArgument("writesDisabled", "must be a boolean");
  }
  // A caller may add a stricter local pause but may never override the process
  // kill switch from true to false.
  const writesDisabled = process.env.PQ_SUPABASE_WRITES_DISABLED === "1"
    || options.writesDisabled === true;
  const callRpc = options.callRpc || createDefaultRpcCaller(options);
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");

  function assertAuditWritesEnabled(operation) {
    if (!writesDisabled) return;
    throw new TruthAuditLedgerError(`Truth-audit ${operation} is disabled by PQ_SUPABASE_WRITES_DISABLED`, {
      code: "TRUTH_AUDIT_WRITES_DISABLED",
      operation,
      retryable: false,
    });
  }

  async function invoke(operation, rpc, body, validator) {
    let value;
    try {
      value = await callRpc(rpc, body);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return validator(value);
    } catch (error) {
      if ([AUDIT_RPC.beginRun, AUDIT_RPC.completeRun, AUDIT_RPC.failRun].includes(rpc)) {
        error.retryable = true;
        error.outcomeUnknown = true;
        error.receiptInvalid = true;
      }
      throw error;
    }
  }

  async function readSnapshot(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("readSnapshot", "must be an object");
    const rowLimit = Number(input.rowLimit ?? 20000);
    if (!Number.isSafeInteger(rowLimit) || rowLimit < 100 || rowLimit > 50000) {
      throw invalidArgument("rowLimit", "must be an integer from 100 through 50000");
    }
    const body = {
      p_workspace_key: workspaceKey,
      p_row_limit: rowLimit,
      p_sync_token: auditToken,
    };
    const base = await invoke(
      "read snapshot base",
      AUDIT_RPC.readSnapshotBase,
      body,
      validateSnapshot,
    );
    const publicationPayloads = await invoke(
      "read snapshot publication payloads",
      AUDIT_RPC.readSnapshotPublicationPayloads,
      body,
      (value) => validateSnapshotPublicationPayloads(value, {
        workspaceKey,
        rowLimit,
        sourceCutId: String(base.canonical?.currentSourceCutId || ""),
        publicationHeads: base.canonical?.publicationHeads,
      }),
    );
    const processing = await invoke(
      "read snapshot processing",
      AUDIT_RPC.readSnapshotProcessing,
      body,
      (value) => validateSnapshotProcessing(value, {
        workspaceKey,
        rowLimit,
        sourceCutId: String(base.canonical?.currentSourceCutId || ""),
        baseCounts: base.bounds.counts,
        currentBatchIds: (base.source?.ingestBatches || [])
          .map((batch) => String(batch.batch_id || ""))
          .filter(Boolean)
          .sort(),
      }),
    );
    const closure = await invoke(
      "read snapshot closure",
      AUDIT_RPC.readSnapshotClosure,
      body,
      (value) => validateSnapshotClosure(value, {
        workspaceKey,
        rowLimit,
        sourceCutId: String(base.canonical?.currentSourceCutId || ""),
        baseCounts: base.bounds.counts,
      }),
    );
    const extensions = await invoke(
      "read snapshot extensions",
      AUDIT_RPC.readSnapshotExtensions,
      body,
      (value) => validateSnapshotExtensions(value, {
        workspaceKey,
        rowLimit,
        sourceCutId: String(base.canonical?.currentSourceCutId || ""),
      }),
    );
    return mergeSnapshotReceipts(
      base,
      publicationPayloads,
      processing,
      closure,
      extensions,
      { rowLimit },
    );
  }

  async function readStatus(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("readStatus", "must be an object");
    const findingLimit = Number(input.findingLimit ?? 50);
    if (!Number.isSafeInteger(findingLimit) || findingLimit < 1 || findingLimit > 200) {
      throw invalidArgument("findingLimit", "must be an integer from 1 through 200");
    }
    return invoke("read status", AUDIT_RPC.readStatus, {
      p_workspace_key: workspaceKey,
      p_finding_limit: findingLimit,
      p_sync_token: auditToken,
    }, (value) => validateStatus(value, { findingLimit, expectedWorkspaceKey: workspaceKey }));
  }

  async function beginRun(input = {}) {
    assertAuditWritesEnabled("begin run");
    if (!isPlainObject(input)) throw invalidArgument("beginRun", "must be an object");
    const auditMode = requireString(input.auditMode ?? "hourly", "auditMode");
    if (!AUDIT_MODES.has(auditMode)) throw invalidArgument("auditMode", "is unsupported");
    const expectedLane = auditMode === "delta" ? PRODUCER_LANES.shadow : PRODUCER_LANES.standalone;
    const producerContext = normalizeAuditProducerContext(
      input.producerContext ?? (expectedLane === PRODUCER_LANES.standalone
        ? standaloneAuditProducerContext()
        : null),
      { expectedLane },
    );
    const leaseSeconds = Number(input.leaseSeconds ?? 300);
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw invalidArgument("leaseSeconds", "must be an integer from 30 through 900");
    }
    const expectedIntervalSeconds = Number(input.expectedIntervalSeconds ?? (
      auditMode === "delta" ? 300 : auditMode === "hourly" ? 900 : 3600
    ));
    if (!Number.isSafeInteger(expectedIntervalSeconds) ||
        expectedIntervalSeconds < 60 || expectedIntervalSeconds > 86400) {
      throw invalidArgument("expectedIntervalSeconds", "must be an integer from 60 through 86400");
    }
    if ((auditMode === "delta" && expectedIntervalSeconds !== 300)
        || (auditMode === "hourly" && expectedIntervalSeconds !== 900)) {
      throw invalidArgument(
        "expectedIntervalSeconds",
        auditMode === "delta"
          ? "must equal the five-minute truth-shadow policy"
          : "must equal the fifteen-minute standalone-audit policy",
      );
    }
    return invoke("begin run", AUDIT_RPC.beginRun, {
      p_workspace_key: workspaceKey,
      p_audit_mode: auditMode,
      p_observer_version: requireString(input.observerVersion, "observerVersion", { maxBytes: 200 }),
      p_model_version: requireString(input.modelVersion ?? "", "modelVersion", {
        allowEmpty: true,
        maxBytes: 200,
      }),
      p_lease_seconds: leaseSeconds,
      p_expected_interval_seconds: expectedIntervalSeconds,
      p_producer_context: producerContext,
      p_sync_token: auditToken,
    }, validateBeginReceipt);
  }

  async function completeRun(input = {}) {
    assertAuditWritesEnabled("complete run");
    if (!isPlainObject(input)) throw invalidArgument("completeRun", "must be an object");
    const sourceCutId = requireString(input.sourceCutId ?? "", "sourceCutId", { allowEmpty: true });
    if (sourceCutId && !SOURCE_CUT_ID_RE.test(sourceCutId)) {
      throw invalidArgument("sourceCutId", "is invalid");
    }
    if (!Array.isArray(input.findings) || input.findings.length > 5000) {
      throw invalidArgument("findings", "must be an array of at most 5000 entries");
    }
    const findings = input.findings.map(normalizeFinding);
    if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) {
      throw invalidArgument("findings", "must not repeat a finding ID in one run");
    }
    return invoke("complete run", AUDIT_RPC.completeRun, {
      p_audit_run_id: requireUuid(input.auditRunId, "auditRunId"),
      p_source_cut_id: sourceCutId,
      p_packet_hash: optionalHash(input.packetHash, "packetHash"),
      p_production_packet_hash: optionalHash(input.productionPacketHash, "productionPacketHash"),
      p_input_digest: requireHash(input.inputDigest, "inputDigest"),
      p_metrics: cloneJson(input.metrics ?? {}, "metrics"),
      p_findings: findings,
      p_sync_token: auditToken,
    }, (value) => validateRunReceipt(value, "complete run", "succeeded"));
  }

  async function failRun(input = {}) {
    assertAuditWritesEnabled("fail run");
    if (!isPlainObject(input)) throw invalidArgument("failRun", "must be an object");
    const errorCode = requireString(input.errorCode, "errorCode", { maxBytes: 100 });
    if (!/^[A-Z0-9_]{3,100}$/.test(errorCode)) throw invalidArgument("errorCode", "is invalid");
    return invoke("fail run", AUDIT_RPC.failRun, {
      p_audit_run_id: requireUuid(input.auditRunId, "auditRunId"),
      p_error_code: errorCode,
      p_safe_error_detail: safeErrorDetail(input.safeErrorDetail),
      p_sync_token: auditToken,
    }, (value) => validateRunReceipt(value, "fail run", "failed"));
  }

  return Object.freeze({
    workspaceKey,
    readSnapshot,
    readStatus,
    beginRun,
    completeRun,
    failRun,
  });
}

module.exports = Object.freeze({
  AUDIT_RPC,
  PRODUCER_CONTEXT_SCHEMA_VERSION,
  PRODUCER_LANES,
  TruthAuditLedgerError,
  createTruthAuditLedger,
  normalizeAuditProducerContext,
  standaloneAuditProducerContext,
  _test: Object.freeze({
    cloneJson,
    decodeJwtRole,
    normalizeFinding,
    createDefaultRpcCaller,
    mergeSnapshotReceipts,
    requireAuditApiKey,
    safeErrorDetail,
    validateLaneStatus,
    validateSnapshotClosure,
    validateSnapshotPublicationPayloads,
    validateSnapshotProcessing,
    validateSnapshotExtensions,
    validateStatus,
  }),
});

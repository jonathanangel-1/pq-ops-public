"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const {
  OBSERVER_VERSION,
  createRelationalTruthAuditor,
} = require("./relational-truth-auditor");
const { postgresJsonbText } = require("./postgres-jsonb");
const {
  PRODUCER_LANES,
  createTruthAuditLedger,
  normalizeAuditProducerContext,
  standaloneAuditProducerContext,
} = require("./truth-audit-ledger");
const {
  LEGACY_UNWATERMARKED_STATUS,
  validateProcessingWatermarkFields,
} = require("./truth-processing-watermark");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  createAbortScope,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");

const HASH_RE = /^[0-9a-f]{64}$/;
const PRODUCTION_SNAPSHOT_PATH = "/api/truth/production-witness";
const PRODUCTION_WITNESS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WITNESS_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const PROTECTION_BYPASS_RE = /^[A-Za-z0-9_-]{16,256}$/;

class RelationalTruthAuditRunError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "RelationalTruthAuditRunError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new RelationalTruthAuditRunError(`Invalid relational truth-audit argument ${field}: ${reason}`, {
    code: "TRUTH_AUDIT_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
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

function normalizePublicHttpsOrigin(value, field = "productionOrigin") {
  const raw = text(value);
  if (!raw) throw invalidArgument(field, "is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidArgument(field, "must be an absolute URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash ||
      hostname === "localhost" || hostname.endsWith(".local") || net.isIP(hostname) !== 0) {
    throw invalidArgument(field, "must be a credential-free public HTTPS origin using a DNS hostname");
  }
  return url.origin;
}

function clampFetchTimeout(value) {
  const timeoutMs = Number(value ?? 5000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15000) {
    throw invalidArgument("productionTimeoutMs", "must be an integer from 250 through 15000");
  }
  return timeoutMs;
}

function normalizeWitnessToken(value) {
  const token = String(value || "");
  if (!WITNESS_TOKEN_RE.test(token)) {
    throw invalidArgument(
      "productionWitnessToken",
      "must be a 32-128 character base64url secret",
    );
  }
  return token;
}

function normalizeProtectionBypassSecret(value) {
  const secret = String(value || "");
  if (!PROTECTION_BYPASS_RE.test(secret)) {
    throw invalidArgument(
      "productionProtectionBypassSecret",
      "must be a 16-256 character base64url secret",
    );
  }
  return secret;
}

function hashDeliveryPayload(payload) {
  if (!isPlainObject(payload)) throw invalidArgument("productionSnapshot", "must be an object");
  const preimage = cloneJson(payload, "productionSnapshot");
  delete preimage.deliveryPayloadHash;
  delete preimage.contentSignature;
  return crypto.createHash("sha256").update(postgresJsonbText(preimage), "utf8").digest("hex");
}

async function fetchProductionWitness(options) {
  const {
    fetchImpl,
    productionOrigin,
    timeoutMs,
    now,
    requireRelationalWitness,
    productionWitnessToken,
    productionProtectionBypassSecret,
    maxShipmentRows = 50000,
    signal = null,
  } = options;
  const requestUrl = `${productionOrigin}${PRODUCTION_SNAPSHOT_PATH}`;
  throwIfAborted(signal, { stage: "production truth witness" });
  const scope = createAbortScope({
    signal,
    timeoutMs,
    stage: "production truth witness",
  });
  try {
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "error",
      signal: scope.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${productionWitnessToken}`,
        "x-vercel-protection-bypass": productionProtectionBypassSecret,
      },
    });
    const declaredBytes = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > PRODUCTION_WITNESS_MAX_RESPONSE_BYTES) {
      throw new RelationalTruthAuditRunError("Production truth witness declared a response larger than 2 MiB", {
        code: "TRUTH_AUDIT_PRODUCTION_RESPONSE_TOO_LARGE",
      });
    }
    const raw = await response.text();
    const payloadBytes = Buffer.byteLength(raw, "utf8");
    if (payloadBytes > PRODUCTION_WITNESS_MAX_RESPONSE_BYTES) {
      throw new RelationalTruthAuditRunError("Production truth witness exceeded 2 MiB", {
        code: "TRUTH_AUDIT_PRODUCTION_RESPONSE_TOO_LARGE",
      });
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch (cause) {
      throw new RelationalTruthAuditRunError("Production truth witness returned invalid JSON", {
        code: "TRUTH_AUDIT_PRODUCTION_INVALID_JSON",
        cause,
      });
    }
    if (!response.ok || !isPlainObject(body) || body.ok !== true) {
      throw new RelationalTruthAuditRunError(
        `Production truth witness failed with HTTP ${response.status}`,
        { code: "TRUTH_AUDIT_PRODUCTION_HTTP_FAILED", status: response.status },
      );
    }
    if (text(body.schemaVersion) !== "production-truth-witness-response-v2") {
      throw new RelationalTruthAuditRunError("Production truth witness schema is unsupported", {
        code: "TRUTH_AUDIT_PRODUCTION_SCHEMA_UNSUPPORTED",
      });
    }
    const snapshot = body.semanticSnapshot;
    const sourceReceipt = body.sourceReceipt;
    if (!isPlainObject(snapshot) || !isPlainObject(sourceReceipt)) {
      throw new RelationalTruthAuditRunError("Production truth witness omitted its compact semantic receipt", {
        code: "TRUTH_AUDIT_PRODUCTION_SNAPSHOT_MISSING",
      });
    }
    if (text(snapshot.schemaVersion) !== "production-truth-semantic-witness-v1" ||
        text(sourceReceipt.schemaVersion) !== "production-truth-source-receipt-v1") {
      throw new RelationalTruthAuditRunError("Production truth witness inner schema is unsupported", {
        code: "TRUTH_AUDIT_PRODUCTION_SCHEMA_UNSUPPORTED",
      });
    }
    const reportedSemanticHash = text(body.semanticWitnessHash);
    const recomputedSemanticHash = crypto.createHash("sha256")
      .update(postgresJsonbText(snapshot), "utf8")
      .digest("hex");
    if (!HASH_RE.test(reportedSemanticHash) || recomputedSemanticHash !== reportedSemanticHash) {
      throw new RelationalTruthAuditRunError("Production truth semantic witness failed independent hash verification", {
        code: "TRUTH_AUDIT_PRODUCTION_SEMANTIC_HASH_INVALID",
        reportedSemanticHash,
        recomputedSemanticHash,
      });
    }
    const productionShipments = Array.isArray(snapshot.shipments) ? snapshot.shipments : [];
    if (!Number.isSafeInteger(maxShipmentRows) || maxShipmentRows < 1 || maxShipmentRows > 50000) {
      throw invalidArgument("maxShipmentRows", "must be an integer from 1 through 50000");
    }
    if (productionShipments.length > maxShipmentRows) {
      throw new RelationalTruthAuditRunError("Production truth witness exceeded its shipment row bound", {
        code: "TRUTH_AUDIT_PRODUCTION_ROW_BOUND_EXCEEDED",
        shipmentCount: productionShipments.length,
        maxShipmentRows,
      });
    }
    const observedAt = text(body.observedAt) || now().toISOString();
    const mode = text(body.mode);
    const publicationIdentityPresent = sourceReceipt.relationalIdentityPresent === true;
    const relationalRequired = requireRelationalWitness === true || publicationIdentityPresent;
    const requiredFields = [
      "publicationId",
      "publicationVersion",
      "sourceCutId",
      "packetHash",
      "deliveryPayloadHash",
      "contentSignature",
    ];
    const missingRelationalFields = requiredFields.filter((field) => {
      if (field === "publicationVersion") return !(Number(sourceReceipt[field]) > 0);
      return !text(sourceReceipt[field]);
    });
    if (relationalRequired && missingRelationalFields.length) {
      throw new RelationalTruthAuditRunError("Production truth witness has an incomplete relational publication identity", {
        code: "TRUTH_AUDIT_PRODUCTION_RELATIONAL_IDENTITY_INCOMPLETE",
        missingRelationalFields,
      });
    }

    if (!relationalRequired) {
      if (mode !== "legacy-shadow" || publicationIdentityPresent) {
        throw new RelationalTruthAuditRunError("Production truth witness legacy mode is inconsistent", {
          code: "TRUTH_AUDIT_PRODUCTION_MODE_INVALID",
        });
      }
      const legacyPayloadHash = text(sourceReceipt.recomputedDeliveryPayloadHash);
      const exactSnapshotHash = text(sourceReceipt.exactSourceSnapshotHash);
      if (!HASH_RE.test(legacyPayloadHash) || !HASH_RE.test(exactSnapshotHash)) {
        throw new RelationalTruthAuditRunError("Production truth witness legacy receipt is invalid", {
          code: "TRUTH_AUDIT_PRODUCTION_HASH_INVALID",
        });
      }
      let processingWatermark;
      try {
        processingWatermark = validateProcessingWatermarkFields(sourceReceipt, {
          field: "productionWitness.sourceReceipt",
          allowLegacy: true,
        });
      } catch (cause) {
        throw new RelationalTruthAuditRunError("Production legacy witness has an invalid processing status", {
          code: "TRUTH_AUDIT_PRODUCTION_PROCESSING_WATERMARK_INVALID",
          cause,
        });
      }
      if (processingWatermark.status !== LEGACY_UNWATERMARKED_STATUS ||
          text(snapshot.processingWatermarkStatus) !== LEGACY_UNWATERMARKED_STATUS ||
          snapshot.processingWatermarkHash !== null) {
        throw new RelationalTruthAuditRunError("Production legacy witness is not explicitly unwatermarked", {
          code: "TRUTH_AUDIT_PRODUCTION_PROCESSING_WATERMARK_INVALID",
        });
      }
      return deepFreeze({
        sourceCutId: text(sourceReceipt.sourceCutId),
        observedDeliveryPayloadHash: legacyPayloadHash,
        snapshot: cloneJson(snapshot, "productionSnapshot"),
        witness: {
          schemaVersion: "production-truth-witness-v2",
          mode: "legacy-shadow",
          origin: productionOrigin,
          path: PRODUCTION_SNAPSHOT_PATH,
          observedAt,
          payloadBytes,
          publicationId: "",
          publicationVersion: null,
          sourceCutId: text(sourceReceipt.sourceCutId),
          packetHash: HASH_RE.test(text(sourceReceipt.packetHash)) ? text(sourceReceipt.packetHash) : "",
          deliveryPayloadHash: legacyPayloadHash,
          exactSnapshotHash,
          semanticWitnessHash: recomputedSemanticHash,
          sourcePayloadBytes: Number(sourceReceipt.sourcePayloadBytes) || null,
          reportedLegacyContentSignature: text(sourceReceipt.reportedContentSignature),
          relationalIdentityPresent: false,
          missingRelationalFields,
          semanticHashIndependentlyRecomputed: true,
          fullPayloadHashVerifiedAtSource: false,
          processingWatermarkStatus: processingWatermark.status,
          processingWatermarkHash: null,
          mutatesOperationalState: false,
        },
      });
    }

    const reportedDeliveryHash = text(sourceReceipt.reportedDeliveryPayloadHash);
    const contentSignature = text(sourceReceipt.reportedContentSignature);
    const recomputedDeliveryHash = text(sourceReceipt.recomputedDeliveryPayloadHash);
    let processingWatermark;
    try {
      processingWatermark = validateProcessingWatermarkFields(sourceReceipt, {
        field: "productionWitness.sourceReceipt",
        allowLegacy: mode === "relational-legacy",
      });
    } catch (cause) {
      throw new RelationalTruthAuditRunError("Production witness has an invalid processing watermark", {
        code: "TRUTH_AUDIT_PRODUCTION_PROCESSING_WATERMARK_INVALID",
        cause,
      });
    }
    if (!new Set(["relational", "relational-legacy"]).has(mode) ||
        (mode === "relational" && processingWatermark.status !== "watermarked") ||
        (mode === "relational-legacy" &&
          processingWatermark.status !== LEGACY_UNWATERMARKED_STATUS)) {
      throw new RelationalTruthAuditRunError("Production relational witness mode and watermark disagree", {
        code: "TRUTH_AUDIT_PRODUCTION_PROCESSING_WATERMARK_INVALID",
      });
    }
    const receiptIdentityMatches = [
      "publicationId",
      "publicationVersion",
      "publicationChannel",
      "sourceCutId",
      "packetHash",
      "deliveryPayloadHash",
      "contentSignature",
      "processingWatermarkStatus",
      "processingWatermarkHash",
    ].every((field) => String(snapshot[field] ?? "") === String(sourceReceipt[field] ?? ""));
    if (sourceReceipt.fullPayloadHashVerifiedAtSource !== true ||
        !receiptIdentityMatches || !HASH_RE.test(reportedDeliveryHash) ||
        contentSignature !== reportedDeliveryHash || recomputedDeliveryHash !== reportedDeliveryHash) {
      throw new RelationalTruthAuditRunError("Production truth witness failed delivery-hash receipt verification", {
        code: "TRUTH_AUDIT_PRODUCTION_HASH_INVALID",
        reportedDeliveryHash,
        recomputedDeliveryHash,
      });
    }
    const packetHash = text(sourceReceipt.packetHash);
    if (!HASH_RE.test(packetHash)) {
      throw new RelationalTruthAuditRunError("Production truth witness has an invalid packet hash", {
        code: "TRUTH_AUDIT_PRODUCTION_PACKET_HASH_INVALID",
      });
    }
    return deepFreeze({
      sourceCutId: text(sourceReceipt.sourceCutId),
      observedDeliveryPayloadHash: recomputedDeliveryHash,
      snapshot: cloneJson(snapshot, "productionSnapshot"),
      witness: {
        schemaVersion: "production-truth-witness-v2",
        mode,
        origin: productionOrigin,
        path: PRODUCTION_SNAPSHOT_PATH,
        observedAt,
        payloadBytes,
        publicationId: text(sourceReceipt.publicationId),
        publicationVersion: Number(sourceReceipt.publicationVersion),
        sourceCutId: text(sourceReceipt.sourceCutId),
        packetHash,
        deliveryPayloadHash: recomputedDeliveryHash,
        exactSnapshotHash: text(sourceReceipt.exactSourceSnapshotHash),
        semanticWitnessHash: recomputedSemanticHash,
        sourcePayloadBytes: Number(sourceReceipt.sourcePayloadBytes) || null,
        relationalIdentityPresent: true,
        missingRelationalFields: [],
        semanticHashIndependentlyRecomputed: true,
        fullPayloadHashVerifiedAtSource: true,
        processingWatermarkStatus: processingWatermark.status,
        processingWatermarkHash: processingWatermark.watermarkHash,
        mutatesOperationalState: false,
      },
    });
  } catch (error) {
    if (isAbortError(error, scope.signal)) {
      if (signal?.aborted) {
        throw asDeadlineError(error, { signal, stage: "production truth witness" });
      }
      throw new RelationalTruthAuditRunError("Production truth witness timed out", {
        code: "TRUTH_AUDIT_PRODUCTION_TIMEOUT",
        cause: error,
      });
    }
    throw error;
  } finally {
    scope.cleanup();
  }
}

function rowField(row, camel, snake) {
  if (!row || typeof row !== "object") return "";
  return row[camel] ?? row[snake] ?? "";
}

function publicationHeadForWitness(snapshot, witnessMode) {
  const heads = snapshot?.canonical?.publicationHeads;
  if (!Array.isArray(heads)) return null;
  const channel = witnessMode === "legacy-shadow" ? "shadow" : "production";
  return heads.find((head) => text(rowField(head, "channel", "channel")) === channel) || null;
}

function safeFailureDetail(error) {
  return String(error instanceof Error ? error.message : error || "Unknown truth-audit failure")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function safeFailureCode(error) {
  const supplied = text(error?.code).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (/^[A-Z0-9_]{3,100}$/.test(supplied)) return supplied;
  return "TRUTH_AUDIT_RUN_FAILED";
}

function boundedFindingSummary(findings, limit) {
  return findings.slice(0, limit).map((finding) => {
    const evidenceIds = Array.isArray(finding.evidenceIds) ? finding.evidenceIds : [];
    const evidenceObservationIds = Array.isArray(finding.evidenceObservationIds)
      ? finding.evidenceObservationIds
      : [];
    const detail = cloneJson(finding.detail ?? {}, "finding.detail");
    const serializedDetail = JSON.stringify(detail);
    return {
      findingId: text(finding.findingId),
      stage: text(finding.stage),
      severity: text(finding.severity),
      classification: text(finding.classification),
      subjectType: text(finding.subjectType),
      subjectKey: text(finding.subjectKey),
      evidenceIds: evidenceIds.slice(0, 25).map(text),
      evidenceIdCount: evidenceIds.length,
      evidenceObservationIds: evidenceObservationIds.slice(0, 25).map(text),
      evidenceObservationIdCount: evidenceObservationIds.length,
      detail: Buffer.byteLength(serializedDetail, "utf8") <= 2048
        ? detail
        : {
            omitted: true,
            bytes: Buffer.byteLength(serializedDetail, "utf8"),
            sha256: crypto.createHash("sha256").update(serializedDetail, "utf8").digest("hex"),
          },
      mutatesOperationalState: false,
    };
  });
}

function assertAuditLedger(ledger) {
  if (!ledger || typeof ledger !== "object") throw invalidArgument("ledger", "must be an object");
  for (const method of ["readSnapshot", "beginRun", "completeRun", "failRun"]) {
    if (typeof ledger[method] !== "function") throw invalidArgument(`ledger.${method}`, "must be a function");
  }
  for (const [key, value] of Object.entries(ledger)) {
    if (typeof value === "function" && /(?:gmail|tms|tracking|action|publish|sourceWrite|canonicalWrite)/i.test(key)) {
      throw invalidArgument(`ledger.${key}`, "operational/source clients are forbidden");
    }
  }
  return ledger;
}

function createRelationalTruthAuditRunner(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const allowedOptions = new Set([
    "ledger",
    "auditor",
    "fetchImpl",
    "productionOrigin",
    "allowedProductionOrigins",
    "productionTimeoutMs",
    "productionWitnessToken",
    "productionProtectionBypassSecret",
    "rowLimit",
    "leaseSeconds",
    "expectedIntervalSeconds",
    "requireRelationalWitness",
    "findingSummaryLimit",
    "now",
    "signal",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw invalidArgument(key, "is not an audit-runner dependency");
  }

  const ledger = assertAuditLedger(options.ledger || createTruthAuditLedger());
  const auditor = options.auditor || createRelationalTruthAuditor();
  if (!auditor || typeof auditor.audit !== "function") throw invalidArgument("auditor", "must expose audit(snapshot)");
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") throw invalidArgument("fetchImpl", "must be a function");
  const productionOrigin = normalizePublicHttpsOrigin(
    options.productionOrigin ?? process.env.PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN ?? "",
  );
  const allowedOriginsInput = options.allowedProductionOrigins ?? [productionOrigin];
  if (!Array.isArray(allowedOriginsInput) || allowedOriginsInput.length === 0) {
    throw invalidArgument("allowedProductionOrigins", "must be a non-empty array");
  }
  const allowedOrigins = new Set(allowedOriginsInput.map((origin, index) =>
    normalizePublicHttpsOrigin(origin, `allowedProductionOrigins[${index}]`)));
  if (!allowedOrigins.has(productionOrigin)) {
    throw invalidArgument("productionOrigin", "is not in the explicit production-origin allowlist");
  }
  const productionTimeoutMs = clampFetchTimeout(options.productionTimeoutMs);
  const productionWitnessToken = normalizeWitnessToken(
    options.productionWitnessToken ?? process.env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN,
  );
  const productionProtectionBypassSecret = normalizeProtectionBypassSecret(
    options.productionProtectionBypassSecret ??
      process.env.PQ_TRUTH_PROTECTION_BYPASS_SECRET ??
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  );
  const rowLimit = Number(options.rowLimit ?? 20000);
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 100 || rowLimit > 50000) {
    throw invalidArgument("rowLimit", "must be an integer from 100 through 50000");
  }
  const leaseSeconds = Number(options.leaseSeconds ?? 300);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
    throw invalidArgument("leaseSeconds", "must be an integer from 30 through 900");
  }
  const configuredExpectedIntervalSeconds = options.expectedIntervalSeconds === undefined
    ? null
    : Number(options.expectedIntervalSeconds);
  if (configuredExpectedIntervalSeconds !== null && (
    !Number.isSafeInteger(configuredExpectedIntervalSeconds)
    || configuredExpectedIntervalSeconds < 60
    || configuredExpectedIntervalSeconds > 86400
  )) {
    throw invalidArgument("expectedIntervalSeconds", "must be an integer from 60 through 86400");
  }
  const requireRelationalWitness = options.requireRelationalWitness === true;
  const findingSummaryLimit = Number(options.findingSummaryLimit ?? 50);
  if (!Number.isSafeInteger(findingSummaryLimit) || findingSummaryLimit < 1 || findingSummaryLimit > 200) {
    throw invalidArgument("findingSummaryLimit", "must be an integer from 1 through 200");
  }
  const now = options.now || (() => new Date());
  if (typeof now !== "function") throw invalidArgument("now", "must be a function");
  const defaultSignal = options.signal ?? null;
  if (defaultSignal !== null && !isAbortSignal(defaultSignal)) {
    throw invalidArgument("signal", "must be an AbortSignal or null");
  }

  async function run(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("run", "must be an object");
    const signal = input.signal ?? defaultSignal;
    if (signal !== null && !isAbortSignal(signal)) throw invalidArgument("run.signal", "must be an AbortSignal or null");
    const hasDeadline = input.deadlineAtMs !== undefined
      && input.deadlineAtMs !== null
      && input.deadlineAtMs !== "";
    const deadlineAtMs = hasDeadline && Number.isFinite(Number(input.deadlineAtMs))
      ? Number(input.deadlineAtMs)
      : null;
    const auditMode = text(input.auditMode || "hourly");
    if (!["delta", "hourly"].includes(auditMode)) {
      throw invalidArgument("run.auditMode", "must be delta or hourly for this producer-bound runner");
    }
    const policyExpectedIntervalSeconds = auditMode === "delta"
      ? 300
      : auditMode === "hourly" ? 900 : 3600;
    if (configuredExpectedIntervalSeconds !== null
        && configuredExpectedIntervalSeconds !== policyExpectedIntervalSeconds) {
      throw invalidArgument(
        "expectedIntervalSeconds",
        `must equal ${policyExpectedIntervalSeconds} for ${auditMode} audit mode`,
      );
    }
    const expectedIntervalSeconds = policyExpectedIntervalSeconds;
    const expectedProducerLane = auditMode === "delta"
      ? PRODUCER_LANES.shadow
      : PRODUCER_LANES.standalone;
    const producerContext = normalizeAuditProducerContext(
      input.producerContext ?? (expectedProducerLane === PRODUCER_LANES.standalone
        ? standaloneAuditProducerContext()
        : null),
      { expectedLane: expectedProducerLane },
    );
    throwIfAborted(signal, { stage: "truth audit begin", deadlineAtMs, now });
    let begun;
    try {
      begun = await ledger.beginRun({
        auditMode,
        observerVersion: OBSERVER_VERSION,
        modelVersion: "",
        leaseSeconds,
        expectedIntervalSeconds,
        producerContext,
      });
    } catch (error) {
      if (isAbortError(error, signal) || error?.outcomeUnknown) {
        throw asDeadlineError(error, {
          signal,
          stage: "truth audit begin",
          deadlineAtMs,
          outcomeUnknown: true,
        });
      }
      throw error;
    }
    const auditRunId = begun.auditRunId;
    if (begun.status === "busy" && begun.code === "AUDIT_BUSY") {
      return deepFreeze({
        ok: true,
        skipped: true,
        status: "busy",
        code: "AUDIT_BUSY",
        auditRunId,
        leaseExpiresAt: begun.leaseExpiresAt || null,
        agreement: null,
        blockingAgreement: null,
        findingCount: 0,
        findings: [],
        mutatesOperationalState: false,
      });
    }
    let completionStarted = false;
    try {
      throwIfAborted(signal, { stage: "truth audit snapshot read", deadlineAtMs, now });
      const relationalSnapshot = await ledger.readSnapshot({ rowLimit });
      if (relationalSnapshot.workspaceKey !== ledger.workspaceKey) {
        throw new RelationalTruthAuditRunError("Audit snapshot workspace does not match the audit ledger", {
          code: "TRUTH_AUDIT_WORKSPACE_MISMATCH",
        });
      }
      if (relationalSnapshot.bounds?.truncated === true) {
        throw new RelationalTruthAuditRunError("Audit snapshot exceeded its relational row bound", {
          code: "TRUTH_AUDIT_SNAPSHOT_TRUNCATED",
        });
      }
      const production = await fetchProductionWitness({
        fetchImpl,
        productionOrigin,
        timeoutMs: productionTimeoutMs,
        now,
        requireRelationalWitness,
        productionWitnessToken,
        productionProtectionBypassSecret,
        maxShipmentRows: rowLimit,
        signal,
      });
      const auditInput = {
        ...cloneJson(relationalSnapshot, "relationalSnapshot"),
        production: {
          sourceCutId: production.sourceCutId,
          observedDeliveryPayloadHash: production.observedDeliveryPayloadHash,
          witnessMode: production.witness.mode,
          exactSnapshotHash: production.witness.exactSnapshotHash || "",
          semanticWitnessHash: production.witness.semanticWitnessHash || "",
          fullPayloadHashVerifiedAtSource:
            production.witness.fullPayloadHashVerifiedAtSource === true,
          payloadBytes: production.witness.payloadBytes,
          snapshot: production.snapshot,
        },
      };
      const report = auditor.audit(auditInput);
      if (!isPlainObject(report) || report.mutatesOperationalState !== false || !Array.isArray(report.findings)) {
        throw new RelationalTruthAuditRunError("Relational truth auditor returned an invalid report", {
          code: "TRUTH_AUDIT_REPORT_INVALID",
        });
      }
      const head = publicationHeadForWitness(relationalSnapshot, production.witness.mode);
      const sourceCutId = text(relationalSnapshot.canonical?.currentSourceCutId);
      const packetHash = text(rowField(head, "packetHash", "packet_hash"));
      const productionPacketHash = text(production.snapshot.packetHash);
      const persistedProductionPacketHash = production.witness.mode !== "legacy-shadow"
        ? productionPacketHash
        : "";
      const metrics = {
        schemaVersion: "relational-truth-audit-metrics-v1",
        agreement: report.findings.length === 0,
        blockingAgreement: report.ok === true,
        counts: cloneJson(report.counts, "report.counts"),
        snapshotBounds: cloneJson(relationalSnapshot.bounds, "snapshot.bounds"),
        productionWitness: production.witness,
        producerContext,
        reconciliation: {
          previousAuditRunId: begun.previousAuditRunId || null,
          reconciliationFrom: begun.reconciliationFrom || null,
          scheduleGapSeconds: begun.scheduleGapSeconds ?? null,
          missedExpectedRun: begun.missedExpectedRun === true,
          expectedIntervalSeconds,
        },
        mutatesOperationalState: false,
      };
      throwIfAborted(signal, { stage: "truth audit completion", deadlineAtMs, now });
      completionStarted = true;
      const completion = await ledger.completeRun({
        auditRunId,
        sourceCutId,
        packetHash,
        productionPacketHash: persistedProductionPacketHash,
        inputDigest: report.inputDigest,
        metrics,
        findings: report.findings,
      });
      const findingSummary = boundedFindingSummary(report.findings, findingSummaryLimit);
      return deepFreeze({
        ok: true,
        auditRunId,
        status: completion.status,
        agreement: report.findings.length === 0,
        blockingAgreement: report.ok === true,
        counts: cloneJson(report.counts, "report.counts"),
        findingCount: report.findings.length,
        findings: findingSummary,
        findingsTruncated: report.findings.length > findingSummary.length,
        inputDigest: report.inputDigest,
        reconciliation: metrics.reconciliation,
        productionWitness: production.witness,
        producerContext,
        mutatesOperationalState: false,
      });
    } catch (error) {
      const runtimeExpired = signal?.aborted === true || (
        deadlineAtMs !== null && Number.isFinite(deadlineAtMs) && Number(now()) >= deadlineAtMs
      );
      const ambiguous = error?.outcomeUnknown === true || (completionStarted && isAbortError(error, signal));
      const normalizedError = (runtimeExpired || ambiguous)
        ? asDeadlineError(error, {
            signal,
            stage: completionStarted ? "truth audit completion" : "truth audit",
            deadlineAtMs,
            outcomeUnknown: ambiguous,
          })
        : error;
      if (!runtimeExpired && !ambiguous) {
        throwIfAborted(signal, {
          stage: "truth audit failure acknowledgement",
          deadlineAtMs,
          now,
        });
        try {
          await ledger.failRun({
            auditRunId,
            errorCode: safeFailureCode(normalizedError),
            safeErrorDetail: safeFailureDetail(normalizedError),
          });
        } catch (failureRecordingError) {
          if (failureRecordingError?.outcomeUnknown === true
              || isAbortError(failureRecordingError, signal)) {
            const unknown = asOutcomeUnknownError(failureRecordingError, {
              signal,
              stage: "truth audit failure acknowledgement",
              deadlineAtMs,
            });
            unknown.auditRunId = auditRunId;
            throw unknown;
          }
          normalizedError.auditFailureRecordingError = safeFailureDetail(failureRecordingError);
        }
      }
      normalizedError.auditRunId = auditRunId;
      throw normalizedError;
    }
  }

  return Object.freeze({
    productionOrigin,
    run,
  });
}

module.exports = Object.freeze({
  PRODUCTION_SNAPSHOT_PATH,
  PRODUCTION_WITNESS_MAX_RESPONSE_BYTES,
  RelationalTruthAuditRunError,
  createRelationalTruthAuditRunner,
  _test: Object.freeze({
    boundedFindingSummary,
    fetchProductionWitness,
    hashDeliveryPayload,
    normalizeWitnessToken,
    normalizeProtectionBypassSecret,
    normalizePublicHttpsOrigin,
    publicationHeadForWitness,
    safeFailureCode,
    safeFailureDetail,
  }),
});

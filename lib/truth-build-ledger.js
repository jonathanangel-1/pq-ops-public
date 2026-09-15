"use strict";

const crypto = require("node:crypto");

const {
  normalizeConfiguredProcessingWatermark,
  validateProcessingWatermarkFields,
} = require("./truth-processing-watermark");

const RPC = Object.freeze({
  claimPair: "claim_truth_build_pair",
  renewLease: "renew_truth_build_pair_lease",
  readBundle: "read_truth_build_bundle",
  completePair: "complete_truth_build_pair",
  failPair: "fail_truth_build_pair",
  publishPair: "publish_truth_build_pair_runtime_cas",
  issueProductionApproval: "issue_truth_production_publication_approval",
  rollbackForward: "publish_truth_rollback_forward",
  readHead: "read_truth_publication_head_runtime",
});
const MUTATING_RPC = new Set([
  RPC.claimPair,
  RPC.renewLease,
  RPC.completePair,
  RPC.failPair,
  RPC.publishPair,
  RPC.issueProductionApproval,
  RPC.rollbackForward,
]);

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_CUT_ID_RE = /^cut:v1:[0-9a-f]{64}$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

class TruthBuildLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthBuildLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthBuildLedgerError(`Invalid truth-build ledger argument ${field}: ${reason}`, {
    code: "TRUTH_BUILD_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, field, reason) {
  return new TruthBuildLedgerError(`Invalid truth-build ${operation} receipt ${field}: ${reason}`, {
    code: "TRUTH_BUILD_INVALID_RECEIPT",
    operation,
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value, field, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const maxBytes = options.maxBytes ?? 8192;
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

function hash(value, field, { allowEmpty = false } = {}) {
  const result = string(value ?? "", field, { allowEmpty });
  if (result || !allowEmpty) {
    if (!HASH_RE.test(result)) throw invalidArgument(field, "must be lowercase SHA-256 hex");
  }
  return result;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 32) throw invalidArgument(field, "exceeds the maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
  }
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
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

function parseBody(body) {
  if (isPlainObject(body)) return body;
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthBuildLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown truth-build RPC failure"));
  const body = parseBody(cause.body);
  const status = Number(cause.status ?? cause.statusCode);
  const code = String(cause.code || body.code || "TRUTH_BUILD_RPC_FAILED");
  return new TruthBuildLedgerError(`${operation} failed: ${cause.message}`, {
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

function requireUuidReceipt(value, operation, field) {
  if (!UUID_RE.test(String(value || ""))) throw invalidReceipt(operation, field, "must be a UUID");
}

function requireHashReceipt(value, operation, field, options = {}) {
  if (options.allowNull && (value === null || value === undefined)) return;
  if (options.allowEmpty && value === "") return;
  if (!HASH_RE.test(String(value || ""))) {
    throw invalidReceipt(operation, field, "must be lowercase SHA-256 hex");
  }
}

function requireProcessingWatermark(value, operation, options = {}) {
  try {
    return validateProcessingWatermarkFields(value, {
      field: `${operation}.receipt`,
      ...options,
    });
  } catch (cause) {
    throw invalidReceipt(
      operation,
      cause?.field || "processingWatermark",
      cause?.message || "is invalid",
    );
  }
}

function validatePairReceipt(value, operation, options = {}) {
  if (!isPlainObject(value) || typeof value.ok !== "boolean") {
    throw invalidReceipt(operation, "result", "must be an object with boolean ok");
  }
  if (!["busy", "running", "succeeded", "failed"].includes(value.status)) {
    throw invalidReceipt(operation, "status", "is unsupported");
  }
  if (value.status === "busy") {
    if (value.ok !== false || value.code !== "TRUTH_BUILD_BUSY") {
      throw invalidReceipt(operation, "busy", "must fail closed with TRUTH_BUILD_BUSY");
    }
  } else if (value.ok !== true) {
    throw invalidReceipt(operation, "ok", "must be true for a non-busy receipt");
  }
  requireUuidReceipt(value.buildPairId, operation, "buildPairId");
  requireUuidReceipt(value.fullBuildId, operation, "fullBuildId");
  requireUuidReceipt(value.incrementalBuildId, operation, "incrementalBuildId");
  requireHashReceipt(value.inputManifestHash, operation, "inputManifestHash");
  requireHashReceipt(value.shipmentMetadataManifestHash, operation, "shipmentMetadataManifestHash");
  if (!SOURCE_CUT_ID_RE.test(String(value.sourceCutId || ""))) {
    throw invalidReceipt(operation, "sourceCutId", "must be cut:v1:<sha256>");
  }
  if (!Number.isSafeInteger(value.leaseFence) || value.leaseFence < 1) {
    throw invalidReceipt(operation, "leaseFence", "must be a positive integer");
  }
  if (!Number.isSafeInteger(value.bundleRowCount) ||
      !Number.isSafeInteger(value.shipmentMetadataRowCount) ||
      !Number.isSafeInteger(value.bundleRowLimit) ||
      value.bundleRowCount < 0 || value.shipmentMetadataRowCount < 0 ||
      value.bundleRowCount + value.shipmentMetadataRowCount > value.bundleRowLimit) {
    throw invalidReceipt(operation, "bundleRowCount", "must be within the non-truncating bound");
  }
  if (value.status === "succeeded") {
    requireHashReceipt(value.packetHash, operation, "packetHash");
    requireHashReceipt(value.reducerOutputHash, operation, "reducerOutputHash");
    requireHashReceipt(value.reducerPacketHash, operation, "reducerPacketHash");
    requireHashReceipt(value.semanticHash, operation, "semanticHash");
  }
  if (value.status === "failed" && typeof value.errorCode !== "string") {
    throw invalidReceipt(operation, "errorCode", "must be present for failed pairs");
  }
  requireProcessingWatermark(value, operation, {
    expectedConfigured: options.expectedConfigured,
  });
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateBundle(value) {
  if (!isPlainObject(value) || value.schemaVersion !== "relational-truth-build-bundle-v1") {
    throw invalidReceipt("read bundle", "schemaVersion", "is unsupported");
  }
  requireUuidReceipt(value.buildPairId, "read bundle", "buildPairId");
  requireHashReceipt(value.inputManifestHash, "read bundle", "inputManifestHash");
  const cutCompleteness = value.sourceCut?.completeness;
  const documentedExclusions = value.sourceCut?.documentedGapExclusions;
  const documentedExclusionHash = value.sourceCut?.documentedGapExclusionHash;
  const degradedCutIsWitnessed = cutCompleteness === "degraded" &&
    Array.isArray(documentedExclusions) && documentedExclusions.length > 0 &&
    HASH_RE.test(String(documentedExclusionHash || "")) &&
    sha256Json(documentedExclusions) === documentedExclusionHash &&
    stableJson(documentedExclusions) === stableJson(value.sourceWatermark?.documentedGapExclusions) &&
    documentedExclusionHash === value.sourceWatermark?.documentedGapExclusionHash;
  if (!isPlainObject(value.sourceCut) ||
      (cutCompleteness !== "complete" && !degradedCutIsWitnessed) ||
      !SOURCE_CUT_ID_RE.test(String(value.sourceCut.sourceCutId || "")) ||
      !HASH_RE.test(String(value.sourceCut.manifestHash || "")) ||
      !Number.isFinite(Date.parse(String(value.sourceCut.sealedAt || ""))) ||
      !Array.isArray(value.sourceCut.observations)) {
    throw invalidReceipt("read bundle", "sourceCut", "must be exact and complete or carry a frozen documented-gap witness");
  }
  for (const field of [
    "acceptedClaimEnvelopes",
    "entityLinkEnvelopes",
    "workgroupDefinitions",
    "workgroupMembershipEnvelopes",
    "shipmentMetadataEnvelopes",
  ]) {
    if (!Array.isArray(value[field])) throw invalidReceipt("read bundle", field, "must be an array");
  }
  requireHashReceipt(value.shipmentMetadataManifestHash, "read bundle", "shipmentMetadataManifestHash");
  if (!isPlainObject(value.bounds) || value.bounds.truncated !== false ||
      !Number.isSafeInteger(value.bounds.rowCount) ||
      !Number.isSafeInteger(value.bounds.shipmentMetadataRowCount) ||
      !Number.isSafeInteger(value.bounds.totalRowCount) ||
      !Number.isSafeInteger(value.bounds.rowLimit) ||
      value.bounds.totalRowCount > value.bounds.rowLimit) {
    throw invalidReceipt("read bundle", "bounds", "must prove a complete non-truncated read");
  }
  const countedBaseRows = value.sourceCut.observations.length + value.acceptedClaimEnvelopes.length +
    value.entityLinkEnvelopes.length + value.workgroupDefinitions.length +
    value.workgroupMembershipEnvelopes.length;
  if (countedBaseRows !== value.bounds.rowCount ||
      value.shipmentMetadataEnvelopes.length !== value.bounds.shipmentMetadataRowCount ||
      countedBaseRows + value.shipmentMetadataEnvelopes.length !== value.bounds.totalRowCount) {
    throw invalidReceipt("read bundle", "bounds.rowCount", "does not equal returned rows");
  }
  requireProcessingWatermark(value, "read bundle");
  return deepFreeze(cloneJson(value, "bundle"));
}

function validatePublicationReceipt(value, operation) {
  if (!isPlainObject(value) || value.ok !== true) {
    throw invalidReceipt(operation, "result", "must be an object with ok=true");
  }
  requireUuidReceipt(value.publicationId, operation, "publicationId");
  requireUuidReceipt(value.buildId, operation, "buildId");
  requireHashReceipt(value.packetHash, operation, "packetHash");
  requireHashReceipt(value.reducerPacketHash, operation, "reducerPacketHash");
  requireHashReceipt(value.semanticHash, operation, "semanticHash");
  requireHashReceipt(value.deliveryPayloadHash, operation, "deliveryPayloadHash");
  requireHashReceipt(value.activeIndexHash, operation, "activeIndexHash");
  if (!isPlainObject(value.publicationAdapter) ||
      value.publicationAdapter.publicationId !== value.publicationId ||
      value.publicationAdapter.publicationVersion !== value.publicationVersion ||
      value.publicationAdapter.channel !== value.channel ||
      value.publicationAdapter.sourceCutId !== value.sourceCutId ||
      value.publicationAdapter.packetHash !== value.reducerPacketHash) {
    throw invalidReceipt(operation, "publicationAdapter", "does not bind the delivery finalizer identity");
  }
  if (!Number.isSafeInteger(value.publicationVersion) || value.publicationVersion < 1) {
    throw invalidReceipt(operation, "publicationVersion", "must be positive");
  }
  requireProcessingWatermark(value, operation);
  return deepFreeze(cloneJson(value, `${operation}.receipt`));
}

function validateHeadReceipt(value) {
  if (!isPlainObject(value) || value.ok !== true || typeof value.found !== "boolean" ||
      value.truncated !== false) {
    throw invalidReceipt("read publication head", "result", "must be a non-truncated head receipt");
  }
  if (value.found) {
    requireUuidReceipt(value.publicationId, "read publication head", "publicationId");
    requireHashReceipt(value.packetHash, "read publication head", "packetHash");
    requireHashReceipt(value.deliveryPayloadHash, "read publication head", "deliveryPayloadHash");
    if (!isPlainObject(value.deliveryPayload) || !isPlainObject(value.activeIndexPayload)) {
      throw invalidReceipt("read publication head", "deliveryPayload", "must include immutable delivery objects");
    }
    if (!Number.isSafeInteger(value.payloadBytes) || value.payloadBytes > value.maxPayloadBytes) {
      throw invalidReceipt("read publication head", "payloadBytes", "exceeds its declared bound");
    }
    requireProcessingWatermark(value, "read publication head", { allowLegacy: true });
  } else {
    requireProcessingWatermark(value, "read publication head", { allowEmpty: true });
  }
  return deepFreeze(cloneJson(value, "head.receipt"));
}

function validateProductionApprovalReceipt(value) {
  if (!isPlainObject(value) || value.ok !== true || value.operation !== "build_pair_publish" ||
      value.status !== "issued") {
    throw invalidReceipt("issue production approval", "result", "must be an issued build-pair approval");
  }
  requireUuidReceipt(value.approvalId, "issue production approval", "approvalId");
  requireUuidReceipt(value.buildPairId, "issue production approval", "buildPairId");
  if (!Number.isSafeInteger(value.expectedHeadVersion) || value.expectedHeadVersion < 0) {
    throw invalidReceipt("issue production approval", "expectedHeadVersion", "must be non-negative");
  }
  requireHashReceipt(value.expectedHeadPacketHash ?? "", "issue production approval", "expectedHeadPacketHash", {
    allowEmpty: true,
  });
  return deepFreeze(cloneJson(value, "productionApproval.receipt"));
}

function normalizeVersions(value) {
  try {
    return normalizeConfiguredProcessingWatermark(value, "versions");
  } catch (cause) {
    if (cause?.code === "TRUTH_PROCESSING_WATERMARK_INVALID") {
      throw invalidArgument(cause.field || "versions", cause.message);
    }
    throw cause;
  }
}

function normalizeProductionApproval(value, field = "productionApproval") {
  if (value === undefined || value === null) {
    return Object.freeze({ approvalId: null, credential: "" });
  }
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  for (const key of Object.keys(value)) {
    if (!["approvalId", "credential"].includes(key)) {
      throw invalidArgument(`${field}.${key}`, "is unsupported");
    }
  }
  const approvalId = uuid(value.approvalId, `${field}.approvalId`);
  const credential = string(value.credential, `${field}.credential`, { maxBytes: 4096 });
  if (Buffer.byteLength(credential, "utf8") < 32) {
    throw invalidArgument(`${field}.credential`, "must be at least 32 bytes");
  }
  return Object.freeze({ approvalId, credential });
}

function createTruthBuildLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = string(options.workspaceKey ?? "primary", "workspaceKey", { maxBytes: 200 });
  const syncToken = string(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", {
    maxBytes: 4096,
  });
  const rpcOptions = cloneJson(options.rpcOptions ?? {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");

  async function invoke(operation, rpc, body, validator) {
    let value;
    try {
      value = await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
    try {
      return validator(value);
    } catch (error) {
      if (MUTATING_RPC.has(rpc)) {
        error.retryable = true;
        error.outcomeUnknown = true;
        error.receiptInvalid = true;
      }
      throw error;
    }
  }

  async function claimPair(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("claimPair", "must be an object");
    const buildChannel = string(input.buildChannel ?? "shadow", "buildChannel");
    if (!["shadow", "candidate"].includes(buildChannel)) {
      throw invalidArgument("buildChannel", "must be shadow or candidate");
    }
    const sourceCutId = string(input.sourceCutId, "sourceCutId");
    if (!SOURCE_CUT_ID_RE.test(sourceCutId)) throw invalidArgument("sourceCutId", "must be cut:v1:<sha256>");
    const versions = normalizeVersions(input.versions);
    return invoke("claim pair", RPC.claimPair, {
      p_workspace_key: workspaceKey,
      p_source_cut_id: sourceCutId,
      p_build_channel: buildChannel,
      p_trigger_name: string(input.triggerName ?? "relational-truth-build-runner", "triggerName", { maxBytes: 500 }),
      p_idempotency_key: string(input.idempotencyKey, "idempotencyKey", { maxBytes: 500 }),
      p_worker_id: string(input.workerId, "workerId", { maxBytes: 500 }),
      p_lease_seconds: integer(input.leaseSeconds ?? 300, "leaseSeconds", { minimum: 30, maximum: 1800 }),
      p_bundle_row_limit: integer(input.bundleRowLimit ?? 25000, "bundleRowLimit", { minimum: 1, maximum: 100000 }),
      p_versions: versions,
      p_sync_token: syncToken,
    }, (value) => validatePairReceipt(value, "claim pair", { expectedConfigured: versions }));
  }

  async function renewLease(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("renewLease", "must be an object");
    return invoke("renew lease", RPC.renewLease, {
      p_workspace_key: workspaceKey,
      p_build_pair_id: uuid(input.buildPairId, "buildPairId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_lease_seconds: integer(input.leaseSeconds ?? 300, "leaseSeconds", { minimum: 30, maximum: 1800 }),
      p_sync_token: syncToken,
    }, (value) => validatePairReceipt(value, "renew lease"));
  }

  async function readBundle(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("readBundle", "must be an object");
    return invoke("read bundle", RPC.readBundle, {
      p_workspace_key: workspaceKey,
      p_build_pair_id: uuid(input.buildPairId, "buildPairId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_sync_token: syncToken,
    }, validateBundle);
  }

  async function completePair(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("completePair", "must be an object");
    return invoke("complete pair", RPC.completePair, {
      p_workspace_key: workspaceKey,
      p_build_pair_id: uuid(input.buildPairId, "buildPairId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_full_packet: cloneJson(input.fullPacket, "fullPacket"),
      p_incremental_packet: cloneJson(input.incrementalPacket, "incrementalPacket"),
      p_full_semantic_hash: hash(input.fullSemanticHash, "fullSemanticHash"),
      p_incremental_semantic_hash: hash(input.incrementalSemanticHash, "incrementalSemanticHash"),
      p_full_validation_report: cloneJson(input.fullValidationReport, "fullValidationReport"),
      p_incremental_validation_report: cloneJson(input.incrementalValidationReport, "incrementalValidationReport"),
      p_sync_token: syncToken,
    }, (value) => validatePairReceipt(value, "complete pair"));
  }

  async function failPair(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("failPair", "must be an object");
    return invoke("fail pair", RPC.failPair, {
      p_workspace_key: workspaceKey,
      p_build_pair_id: uuid(input.buildPairId, "buildPairId"),
      p_worker_id: string(input.workerId, "workerId"),
      p_lease_fence: integer(input.leaseFence, "leaseFence", { minimum: 1 }),
      p_error_code: string(input.errorCode, "errorCode", { maxBytes: 200 }),
      p_safe_error_detail: safeErrorDetail(input.safeErrorDetail),
      p_sync_token: syncToken,
    }, (value) => validatePairReceipt(value, "fail pair"));
  }

  async function publishPair(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("publishPair", "must be an object");
    if (input.allowProduction === true) {
      throw invalidArgument(
        "allowProduction",
        "is retired; provide a separately issued productionApproval capability",
      );
    }
    const approval = normalizeProductionApproval(input.productionApproval);
    return invoke("publish pair", RPC.publishPair, {
      p_workspace_key: workspaceKey,
      p_build_pair_id: uuid(input.buildPairId, "buildPairId"),
      p_publication_request_key: string(input.publicationRequestKey, "publicationRequestKey", { maxBytes: 500 }),
      p_expected_head_version: integer(input.expectedHeadVersion ?? 0, "expectedHeadVersion"),
      p_expected_head_packet_hash: hash(input.expectedHeadPacketHash ?? "", "expectedHeadPacketHash", { allowEmpty: true }),
      p_publication_reason: string(input.publicationReason ?? "normal", "publicationReason"),
      p_publisher_version: string(input.publisherVersion, "publisherVersion", { maxBytes: 500 }),
      p_published_by: string(input.publishedBy, "publishedBy", { maxBytes: 500 }),
      p_production_approval_id: approval.approvalId,
      p_production_approval_credential: approval.credential,
      p_sync_token: syncToken,
    }, (value) => validatePublicationReceipt(value, "publish pair"));
  }

  async function issueProductionApproval(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("issueProductionApproval", "must be an object");
    const credential = string(input.credential, "credential", { maxBytes: 4096 });
    if (Buffer.byteLength(credential, "utf8") < 32) {
      throw invalidArgument("credential", "must be at least 32 bytes");
    }
    return invoke("issue production approval", RPC.issueProductionApproval, {
      p_workspace_key: workspaceKey,
      p_operation: "build_pair_publish",
      p_build_pair_id: uuid(input.buildPairId, "buildPairId"),
      p_target_publication_id: null,
      p_approval_request_key: string(input.approvalRequestKey, "approvalRequestKey", { maxBytes: 500 }),
      p_publication_request_key: string(input.publicationRequestKey, "publicationRequestKey", { maxBytes: 500 }),
      p_expected_head_version: integer(input.expectedHeadVersion, "expectedHeadVersion"),
      p_expected_head_packet_hash: hash(input.expectedHeadPacketHash ?? "", "expectedHeadPacketHash", { allowEmpty: true }),
      p_publication_reason: string(input.publicationReason ?? "normal", "publicationReason"),
      p_publisher_version: string(input.publisherVersion, "publisherVersion", { maxBytes: 500 }),
      p_published_by: string(input.publishedBy, "publishedBy", { maxBytes: 500 }),
      p_approved_by: string(input.approvedBy, "approvedBy", { maxBytes: 500 }),
      p_approval_reason: string(input.approvalReason, "approvalReason", { maxBytes: 2000 }),
      p_expires_at: string(input.expiresAt, "expiresAt", { maxBytes: 100 }),
      p_approval_credential: credential,
      p_issuer_token: string(input.issuerToken, "issuerToken", { maxBytes: 4096 }),
    }, validateProductionApprovalReceipt);
  }

  async function rollbackForward(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("rollbackForward", "must be an object");
    const channel = string(input.channel ?? "shadow", "channel");
    if (!["shadow", "production"].includes(channel)) throw invalidArgument("channel", "is unsupported");
    if (input.allowProduction === true) {
      throw invalidArgument(
        "allowProduction",
        "is retired; provide a separately issued productionApproval capability",
      );
    }
    const approval = normalizeProductionApproval(input.productionApproval);
    return invoke("rollback forward", RPC.rollbackForward, {
      p_workspace_key: workspaceKey,
      p_channel: channel,
      p_target_publication_id: uuid(input.targetPublicationId, "targetPublicationId"),
      p_publication_request_key: string(input.publicationRequestKey, "publicationRequestKey", { maxBytes: 500 }),
      p_expected_head_version: integer(input.expectedHeadVersion, "expectedHeadVersion", { minimum: 1 }),
      p_expected_head_packet_hash: hash(input.expectedHeadPacketHash, "expectedHeadPacketHash"),
      p_publisher_version: string(input.publisherVersion, "publisherVersion", { maxBytes: 500 }),
      p_published_by: string(input.publishedBy, "publishedBy", { maxBytes: 500 }),
      p_production_approval_id: approval.approvalId,
      p_production_approval_credential: approval.credential,
      p_sync_token: syncToken,
    }, (value) => validatePublicationReceipt(value, "rollback forward"));
  }

  async function readHead(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("readHead", "must be an object");
    const channel = string(input.channel ?? "shadow", "channel");
    if (!["shadow", "production"].includes(channel)) throw invalidArgument("channel", "is unsupported");
    return invoke("read publication head", RPC.readHead, {
      p_workspace_key: workspaceKey,
      p_channel: channel,
      p_max_payload_bytes: integer(input.maxPayloadBytes ?? 32 * 1024 * 1024, "maxPayloadBytes", {
        minimum: 1024,
        maximum: 32 * 1024 * 1024,
      }),
      p_sync_token: syncToken,
    }, validateHeadReceipt);
  }

  return Object.freeze({
    scope: Object.freeze({ workspaceKey }),
    claimPair,
    renewLease,
    readBundle,
    completePair,
    failPair,
    issueProductionApproval,
    publishPair,
    rollbackForward,
    readHead,
  });
}

module.exports = {
  RPC,
  TruthBuildLedgerError,
  createTruthBuildLedger,
  safeErrorDetail,
  _test: {
    cloneJson,
    normalizeProductionApproval,
    normalizeRpcError,
    normalizeVersions,
    validateBundle,
    validateHeadReceipt,
    validatePairReceipt,
    validateProductionApprovalReceipt,
    validatePublicationReceipt,
  },
};

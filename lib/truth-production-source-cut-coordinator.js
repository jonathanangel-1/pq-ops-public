"use strict";

const RPC = Object.freeze({
  readHead: "read_truth_ceremony_gmail_head",
  sealAcceptedGmail: "seal_truth_shadow_root_source_cut",
  bridgeProduction: "seal_truth_production_cut_from_accepted_gmail_v1",
});
const CUT_ID_RE = /^cut:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const OBLIGATION_ID_RE = /^pending-acceptance-epoch:v1:[0-9a-f]{64}$/;
const BRIDGE_ID_RE = /^truth-production-cut-acceptance-bridge:v1:[0-9a-f]{64}$/;
const SCOPE_ID_RE = /^truth-shadow-root-source-cut:v1:[0-9a-f]{64}$/;

class TruthProductionSourceCutCoordinatorError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthProductionSourceCutCoordinatorError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthProductionSourceCutCoordinatorError(
    `Invalid production source-cut ${field}: ${reason}`,
    { code: "TRUTH_PRODUCTION_SOURCE_CUT_INVALID_ARGUMENT", field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, { maximumBytes = 8192 } = {}) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw invalid(field, "is too long");
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

function unavailableGap(head, reasonCode) {
  const cursorVersion = Number(head?.sourceCursorVersion || 0);
  return deepFreeze({
    ok: true,
    status: "not_ready",
    sourceCutId: null,
    manifestHash: null,
    manifest: null,
    completeness: "degraded",
    observationCount: 0,
    gaps: [{
      gapType: reasonCode,
      sourceSystem: "gmail",
      connectionKey: "primary",
      sourceCursorVersion: Number.isSafeInteger(cursorVersion) && cursorVersion >= 0
        ? cursorVersion
        : 0,
    }],
    productionEligible: false,
    productionPublicationAttempted: false,
    publishesTruth: false,
    performsActions: false,
  });
}

function receiptError(message, fields = {}) {
  return new TruthProductionSourceCutCoordinatorError(message, {
    code: "TRUTH_PRODUCTION_SOURCE_CUT_INVALID_RECEIPT",
    receiptInvalid: true,
    retryable: true,
    outcomeUnknown: true,
    ...fields,
  });
}

function validateAcceptedGmailCut(value) {
  if (!isPlainObject(value) || value.ok !== true
      || !CUT_ID_RE.test(String(value.sourceCutId || ""))
      || !HASH_RE.test(String(value.manifestHash || ""))
      || value.sourceCutId !== `cut:v1:${value.manifestHash}`
      || !isPlainObject(value.manifest)
      || !["complete", "degraded"].includes(value.completeness)
      || !Array.isArray(value.gaps)
      || !Number.isSafeInteger(value.observationCount) || value.observationCount < 0
      || !SCOPE_ID_RE.test(String(value.scopeReceiptId || ""))
      || !HASH_RE.test(String(value.scopeReceiptHash || ""))
      || !HASH_RE.test(String(value.acceptanceEpochManifestHash || ""))
      || value.publicationChannel !== "shadow"
      || value.shadowOnly !== true
      || value.productionEligible !== false
      || value.productionPublicationAttempted !== false
      || value.publishesTruth !== false
      || value.performsActions !== false) {
    throw receiptError("Accepted Gmail source-cut receipt is invalid", { stage: "accepted_gmail_cut" });
  }
  return value;
}

function validateProductionBridge(value, shadowSourceCutId) {
  const productionSourceCutId = String(value?.productionSourceCutId || "");
  if (!isPlainObject(value) || value.ok !== true
      || !["bridged", "already_bridged"].includes(value.status)
      || !CUT_ID_RE.test(productionSourceCutId)
      || value.sourceCutId !== productionSourceCutId
      || value.shadowSourceCutId !== shadowSourceCutId
      || productionSourceCutId === shadowSourceCutId
      || !BRIDGE_ID_RE.test(String(value.bridgeId || ""))
      || !HASH_RE.test(String(value.bridgeHash || ""))
      || !HASH_RE.test(String(value.manifestHash || ""))
      || value.sourceCutId !== `cut:v1:${value.manifestHash}`
      || !isPlainObject(value.manifest)
      || !["complete", "degraded"].includes(value.completeness)
      || !Array.isArray(value.gaps)
      || !Number.isSafeInteger(value.observationCount) || value.observationCount < 0
      || value.productionEligible !== true
      || value.productionPublicationAttempted !== false
      || value.publishesTruth !== false
      || value.performsActions !== false) {
    throw receiptError("Production source-cut bridge receipt is invalid", { stage: "production_bridge" });
  }
  return deepFreeze({
    ...cloneJson(value, "productionBridge"),
    status: "sealed",
    bridgeStatus: value.status,
    sourceCutId: productionSourceCutId,
    productionSourceCutId,
    shadowSourceCutId,
  });
}

function normalizeError(error, operation) {
  if (error instanceof TruthProductionSourceCutCoordinatorError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown source-cut failure"));
  return new TruthProductionSourceCutCoordinatorError(`${operation} failed: ${cause.message}`, {
    code: String(cause.code || "TRUTH_PRODUCTION_SOURCE_CUT_RPC_FAILED"),
    operation,
    retryable: cause.retryable === true || ["40001", "55P03", "57014"].includes(cause.code),
    outcomeUnknown: cause.outcomeUnknown === true,
    cause,
  });
}

function createTruthProductionSourceCutCoordinator(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || "primary", "workspaceKey", { maximumBytes: 128 });
  if (workspaceKey !== "primary") throw invalid("workspaceKey", "must equal primary");
  const syncToken = text(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", {
    maximumBytes: 4096,
  });
  const callRpc = options.callRpc;
  if (typeof callRpc !== "function") throw invalid("callRpc", "must be a function");

  async function sealCurrent(input = {}) {
    if (!isPlainObject(input)) throw invalid("sealCurrent", "must be an object");
    const createdBy = text(input.createdBy, "createdBy", { maximumBytes: 500 });
    let head;
    try {
      head = await callRpc(RPC.readHead, {
        p_workspace_key: workspaceKey,
        p_sync_token: syncToken,
      });
    } catch (error) {
      throw normalizeError(error, "read accepted Gmail head");
    }
    if (!isPlainObject(head) || head.ok !== true) {
      throw receiptError("Accepted Gmail head receipt is invalid", { stage: "accepted_gmail_head" });
    }
    if (head.accepted !== true || !OBLIGATION_ID_RE.test(String(head.obligationId || ""))) {
      return unavailableGap(head, "GMAIL_ACCEPTED_HEAD_UNAVAILABLE");
    }

    let shadowCut;
    try {
      shadowCut = await callRpc(RPC.sealAcceptedGmail, {
        p_workspace_key: workspaceKey,
        p_obligation_id: head.obligationId,
        p_created_by: `${createdBy}:accepted-gmail`,
        p_sync_token: syncToken,
      });
    } catch (error) {
      throw normalizeError(error, "seal accepted Gmail source cut");
    }
    if (shadowCut?.status === "busy") return unavailableGap(head, "SOURCE_CUT_SERIALIZATION_BUSY");
    validateAcceptedGmailCut(shadowCut);

    let bridge;
    try {
      bridge = await callRpc(RPC.bridgeProduction, {
        p_workspace_key: workspaceKey,
        p_shadow_source_cut_id: shadowCut.sourceCutId,
        p_created_by: `${createdBy}:production-bridge`,
        p_sync_token: syncToken,
      });
    } catch (error) {
      throw normalizeError(error, "bridge accepted Gmail cut to production sources");
    }
    if (bridge?.status === "busy") return unavailableGap(head, "SOURCE_CUT_SERIALIZATION_BUSY");
    return validateProductionBridge(bridge, shadowCut.sourceCutId);
  }

  return Object.freeze({ workspaceKey, sealCurrent });
}

module.exports = Object.freeze({
  RPC,
  TruthProductionSourceCutCoordinatorError,
  createTruthProductionSourceCutCoordinator,
  _test: Object.freeze({
    unavailableGap,
    validateAcceptedGmailCut,
    validateProductionBridge,
  }),
});

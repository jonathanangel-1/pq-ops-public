"use strict";

// RPC-only wrapper for bounded non-Gmail source snapshots. The RPC transport is
// mandatory dependency injection: this module has no Supabase, HTTP, source,
// TMS, tracking, operator, reducer, action, or publisher fallback.

const DEFAULT_WORKSPACE_KEY = "primary";
const DEFAULT_LEASE_TTL_SECONDS = 120;
const SOURCE_SYSTEMS = new Set(["tms", "tracking", "operator"]);
const SOURCE_FIDELITIES = new Set(["raw", "normalized_source"]);
const OBSERVATION_OPERATIONS = new Set(["content", "metadata_change", "delete"]);
const CURSOR_KIND_BY_SOURCE = Object.freeze({
  tms: "tms_snapshot_timestamp",
  tracking: "tracking_snapshot_timestamp",
  operator: "operator_sequence",
});
const SOURCE_CONTRACTS = Object.freeze({
  tms: Object.freeze({
    cursorKind: CURSOR_KIND_BY_SOURCE.tms,
    providerSchemaVersion: "tms-detail-source-snapshot-v1",
    observationSchemaVersion: "tms-shipment-source-observation-v1",
    sourceObjectType: "tms_shipment_snapshot",
    jobKind: "tms_extract_claims",
  }),
  tracking: Object.freeze({
    cursorKind: CURSOR_KIND_BY_SOURCE.tracking,
    providerSchemaVersion: "tracking-source-snapshot-v1",
    observationSchemaVersion: "tracking-source-observation-v1",
    sourceObjectType: "tracking_shipment_snapshot",
    jobKind: "tracking_extract_claims",
  }),
  operator: Object.freeze({
    cursorKind: CURSOR_KIND_BY_SOURCE.operator,
    providerSchemaVersion: "operator-source-delta-v1",
    observationSchemaVersion: "operator-event-source-observation-v1",
    sourceObjectType: "operator_event",
    jobKind: "operator_extract_claims",
  }),
});
const RPC = Object.freeze({
  recordPreflightFailure: "record_source_snapshot_preflight_failure",
  acquireLease: "acquire_source_sync_lease",
  renewLease: "renew_source_sync_lease",
  beginSnapshotBatch: "begin_source_ingest_batch",
  recoverCommittedSnapshot: "recover_committed_source_snapshot",
  commitSnapshotBatch: "commit_source_snapshot_batch",
  failSnapshotBatch: "fail_source_snapshot_batch",
});

class SourceSnapshotLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "SourceSnapshotLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new SourceSnapshotLedgerError(`Invalid source snapshot ledger argument ${field}: ${reason}`, {
    code: "SOURCE_SNAPSHOT_LEDGER_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, rpc, field, reason) {
  return new SourceSnapshotLedgerError(`Invalid ${rpc} receipt ${field}: ${reason}`, {
    code: "SOURCE_SNAPSHOT_LEDGER_INVALID_RECEIPT",
    operation,
    rpc,
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, field) {
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  return value;
}

function requireString(value, field, options = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!options.allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not have leading or trailing whitespace");
  return value;
}

function optionalString(value, field, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return requireString(value, field, { allowEmpty: true });
}

function requireInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidArgument(field, `must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function requireHash(value, field) {
  const hash = requireString(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw invalidArgument(field, "must be a lowercase SHA-256 hex digest");
  }
  return hash;
}

function requireCanonicalUtcTimestamp(value, field) {
  const timestamp = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw invalidArgument(field, "must be a canonical UTC timestamp with millisecond precision");
  }
  return timestamp;
}

function requireObservationId(value, field) {
  const id = requireString(value, field);
  if (!/^obs:v1:[0-9a-f]{64}$/.test(id)) {
    throw invalidArgument(field, "must be an obs:v1 SHA-256 identity");
  }
  return id;
}

function cloneJson(value, field) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${field}.${key}`)]));
  }
  throw invalidArgument(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function normalizeError(error, context) {
  if (error instanceof SourceSnapshotLedgerError) return error;
  const original = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  const status = Number(original.status ?? original.statusCode);
  const code = original.code === undefined || original.code === null || original.code === ""
    ? "SOURCE_SNAPSHOT_LEDGER_RPC_FAILED"
    : String(original.code);
  const sqlState = /^[0-9A-Z]{5}$/.test(code);
  const transportFailure = !sqlState && (
    status === 408 || status === 429 || status >= 500 ||
    /\b(?:timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network)\b/i.test(original.message)
  );
  return new SourceSnapshotLedgerError(`${context.operation} failed: ${original.message}`, {
    code,
    operation: context.operation,
    rpc: context.rpc,
    status: original.status,
    statusCode: original.statusCode,
    body: original.body,
    details: original.details,
    hint: original.hint,
    retryable: typeof original.retryable === "boolean"
      ? original.retryable
      : code === "40001" || status === 408 || status === 409 || status === 429 || status >= 500 ||
        /\b(?:timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i.test(original.message),
    ambiguousOutcome: typeof original.ambiguousOutcome === "boolean"
      ? original.ambiguousOutcome
      : original.outcomeUnknown === true || transportFailure,
    deadlineExceeded: original.deadlineExceeded === true,
    outcomeUnknown: original.outcomeUnknown === true,
    cause: original,
  });
}

function immutableReceipt(result, operation, rpc) {
  if (!isPlainObject(result)) throw invalidReceipt(operation, rpc, "result", "must be an object");
  if (typeof result.ok !== "boolean") throw invalidReceipt(operation, rpc, "ok", "must be a boolean");
  let cloned;
  try {
    cloned = cloneJson(result, `${rpc}.receipt`);
  } catch (error) {
    if (error instanceof SourceSnapshotLedgerError) {
      throw invalidReceipt(operation, rpc, error.field || "result", "must contain only JSON-compatible values");
    }
    throw error;
  }
  return deepFreeze(cloned);
}

function receiptString(receipt, operation, rpc, field, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
    if (options.optional) return "";
    throw invalidReceipt(operation, rpc, field, "is required");
  }
  if (typeof receipt[field] !== "string") throw invalidReceipt(operation, rpc, field, "must be a string");
  if (!options.allowEmpty && !receipt[field]) throw invalidReceipt(operation, rpc, field, "must not be empty");
  return receipt[field];
}

function receiptInteger(receipt, operation, rpc, field, minimum = 0) {
  if (!Object.prototype.hasOwnProperty.call(receipt, field) ||
      !Number.isSafeInteger(receipt[field]) || receipt[field] < minimum) {
    throw invalidReceipt(operation, rpc, field, `must be a safe integer of at least ${minimum}`);
  }
  return receipt[field];
}

function receiptTimestamp(receipt, operation, rpc, field) {
  const value = receiptString(receipt, operation, rpc, field);
  if (!Number.isFinite(Date.parse(value))) throw invalidReceipt(operation, rpc, field, "must be an ISO timestamp");
  return value;
}

function normalizeRawObject(value, field) {
  if (value === undefined || value === null) return undefined;
  const raw = requireRecord(value, field);
  const output = {
    bucket: requireString(raw.bucket, `${field}.bucket`),
    key: requireString(raw.key, `${field}.key`),
    hash: requireHash(raw.hash, `${field}.hash`),
    bytes: requireInteger(raw.bytes, `${field}.bytes`),
    contentType: requireString(raw.contentType, `${field}.contentType`),
  };
  if (raw.version !== undefined) output.version = optionalString(raw.version, `${field}.version`);
  if (raw.etag !== undefined) output.etag = optionalString(raw.etag, `${field}.etag`);
  return output;
}

function normalizeObservation(input, index, contract) {
  const field = `observations[${index}]`;
  const observation = requireRecord(input, field);
  const operation = optionalString(observation.operation, `${field}.operation`, "content");
  if (!OBSERVATION_OPERATIONS.has(operation)) throw invalidArgument(`${field}.operation`, "is unsupported");
  const sourceFidelity = optionalString(observation.sourceFidelity, `${field}.sourceFidelity`, "normalized_source");
  if (!SOURCE_FIDELITIES.has(sourceFidelity)) throw invalidArgument(`${field}.sourceFidelity`, "is unsupported");
  const normalized = {
    observationId: requireObservationId(observation.observationId, `${field}.observationId`),
    sourceObjectType: requireString(observation.sourceObjectType, `${field}.sourceObjectType`),
    sourceObjectId: requireString(observation.sourceObjectId, `${field}.sourceObjectId`),
    sourceRevision: requireString(observation.sourceRevision, `${field}.sourceRevision`),
    operation,
    contentHash: requireHash(observation.contentHash, `${field}.contentHash`),
    normalizedPayload: cloneJson(observation.normalizedPayload ?? {}, `${field}.normalizedPayload`),
    normalizedText: optionalString(observation.normalizedText, `${field}.normalizedText`),
    sourceFidelity,
    schemaVersion: requireString(observation.schemaVersion, `${field}.schemaVersion`),
  };
  if (normalized.sourceObjectType !== contract.sourceObjectType) {
    throw invalidArgument(`${field}.sourceObjectType`, `must be ${contract.sourceObjectType}`);
  }
  if (normalized.schemaVersion !== contract.observationSchemaVersion) {
    throw invalidArgument(`${field}.schemaVersion`, `must be ${contract.observationSchemaVersion}`);
  }
  if (!isPlainObject(normalized.normalizedPayload)) {
    throw invalidArgument(`${field}.normalizedPayload`, "must be an object");
  }
  if (observation.sourceRecordedAt !== undefined) {
    normalized.sourceRecordedAt = requireString(observation.sourceRecordedAt, `${field}.sourceRecordedAt`, { allowEmpty: true });
    if (normalized.sourceRecordedAt && !Number.isFinite(Date.parse(normalized.sourceRecordedAt))) {
      throw invalidArgument(`${field}.sourceRecordedAt`, "must be an ISO timestamp");
    }
  }
  if (observation.capturedAt !== undefined) {
    normalized.capturedAt = requireString(observation.capturedAt, `${field}.capturedAt`);
    if (!Number.isFinite(Date.parse(normalized.capturedAt))) {
      throw invalidArgument(`${field}.capturedAt`, "must be an ISO timestamp");
    }
  }
  const rawObject = normalizeRawObject(observation.rawObject, `${field}.rawObject`);
  if (rawObject) normalized.rawObject = rawObject;
  if (observation.retentionClass !== undefined) {
    normalized.retentionClass = requireString(observation.retentionClass, `${field}.retentionClass`);
  }
  return normalized;
}

function normalizeJob(input, index, contract) {
  const field = `jobs[${index}]`;
  const job = requireRecord(input, field);
  const payload = cloneJson(job.payload ?? {}, `${field}.payload`);
  if (!isPlainObject(payload)) throw invalidArgument(`${field}.payload`, "must be an object");
  for (const forbidden of ["batchId", "rootBatchId", "rootJobId", "parentJobId"]) {
    if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
      throw invalidArgument(`${field}.payload.${forbidden}`, "is server-owned");
    }
  }
  const maxAttempts = job.maxAttempts === undefined ? 5 : requireInteger(job.maxAttempts, `${field}.maxAttempts`, 1);
  if (maxAttempts > 100) throw invalidArgument(`${field}.maxAttempts`, "must not exceed 100");
  const normalized = {
    dedupeKey: requireString(job.dedupeKey, `${field}.dedupeKey`),
    jobKind: requireString(job.jobKind, `${field}.jobKind`),
    observationId: requireObservationId(job.observationId, `${field}.observationId`),
    sourceObjectId: requireString(job.sourceObjectId, `${field}.sourceObjectId`),
    maxAttempts,
    payload,
  };
  if (normalized.jobKind !== contract.jobKind) {
    throw invalidArgument(`${field}.jobKind`, `must be ${contract.jobKind}`);
  }
  return normalized;
}

function normalizeProviderManifest(value, contract, field = "providerManifest") {
  const manifest = cloneJson(value, field);
  if (!isPlainObject(manifest)) throw invalidArgument(field, "must be an object");
  if (requireString(manifest.schemaVersion, `${field}.schemaVersion`) !== contract.providerSchemaVersion) {
    throw invalidArgument(`${field}.schemaVersion`, `must be ${contract.providerSchemaVersion}`);
  }
  if (manifest.complete !== true) throw invalidArgument(`${field}.complete`, "must be true");
  requireString(manifest.upstreamWatermark, `${field}.upstreamWatermark`);
  requireCanonicalUtcTimestamp(manifest.sourceSnapshotAt, `${field}.sourceSnapshotAt`);
  requireInteger(manifest.recordCount, `${field}.recordCount`);
  return manifest;
}

function normalizeSnapshotPayload(input, { sourceSystem, contract }) {
  const nextCursorValue = requireString(input.nextCursorValue, "nextCursorValue");
  if (!Array.isArray(input.observations)) throw invalidArgument("observations", "must be an array");
  if (!Array.isArray(input.jobs)) throw invalidArgument("jobs", "must be an array");
  if (sourceSystem === "operator") {
    if (!/^[0-9]+$/.test(nextCursorValue)) {
      throw invalidArgument("nextCursorValue", "must be a decimal operator sequence");
    }
  } else {
    requireCanonicalUtcTimestamp(nextCursorValue, "nextCursorValue");
  }

  const providerManifest = normalizeProviderManifest(input.providerManifest, contract);
  const observations = input.observations
    .map((item, index) => normalizeObservation(item, index, contract))
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  const jobs = input.jobs
    .map((item, index) => normalizeJob(item, index, contract))
    .sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));

  if (providerManifest.upstreamWatermark !== nextCursorValue) {
    throw invalidArgument("providerManifest.upstreamWatermark", "must equal nextCursorValue");
  }
  if (sourceSystem !== "operator" && providerManifest.sourceSnapshotAt !== nextCursorValue) {
    throw invalidArgument("providerManifest.sourceSnapshotAt", "must equal nextCursorValue for snapshot sources");
  }
  if (providerManifest.recordCount !== observations.length) {
    throw invalidArgument("providerManifest.recordCount", "must equal observations.length");
  }
  if (new Set(observations.map((item) => item.observationId)).size !== observations.length) {
    throw invalidArgument("observations", "must have unique identities");
  }
  const coordinates = observations.map((item) => [
    item.sourceObjectType,
    item.sourceObjectId,
    item.sourceRevision,
    item.operation,
  ].join("\u0000"));
  if (new Set(coordinates).size !== coordinates.length) {
    throw invalidArgument("observations", "must have unique source coordinates");
  }
  if (new Set(jobs.map((item) => item.dedupeKey)).size !== jobs.length) {
    throw invalidArgument("jobs", "must have unique dedupe keys");
  }
  if (jobs.length !== observations.length ||
      new Set(jobs.map((item) => item.observationId)).size !== jobs.length) {
    throw invalidArgument("jobs", "must provide exactly one extraction job per observation");
  }
  const observationsById = new Map(observations.map((item) => [item.observationId, item]));
  for (const [index, job] of jobs.entries()) {
    const observation = observationsById.get(job.observationId);
    if (!observation) throw invalidArgument(`jobs[${index}].observationId`, "must reference the same snapshot");
    if (job.sourceObjectId !== observation.sourceObjectId) {
      throw invalidArgument(`jobs[${index}].sourceObjectId`, "must match its observation sourceObjectId");
    }
  }
  if (sourceSystem === "tms") {
    for (const [index, observation] of observations.entries()) {
      if (observation.sourceRevision !== `snapshot:${nextCursorValue}`) {
        throw invalidArgument(`observations[${index}].sourceRevision`, "must identify the exact TMS snapshot");
      }
      if (observation.sourceRecordedAt !== nextCursorValue) {
        throw invalidArgument(`observations[${index}].sourceRecordedAt`, "must equal the TMS snapshot cursor");
      }
    }
  }
  return { nextCursorValue, providerManifest, observations, jobs };
}

function createSourceSnapshotLedger(inputOptions = {}) {
  const options = requireRecord(inputOptions, "options");
  const workspaceKey = requireString(options.workspaceKey ?? DEFAULT_WORKSPACE_KEY, "workspaceKey");
  const sourceSystem = requireString(options.sourceSystem, "sourceSystem");
  if (!SOURCE_SYSTEMS.has(sourceSystem)) {
    throw invalidArgument("sourceSystem", "must be tms, tracking, or operator");
  }
  const contract = SOURCE_CONTRACTS[sourceSystem];
  const connectionKey = requireString(options.connectionKey, "connectionKey");
  const cursorKind = requireString(options.cursorKind ?? contract.cursorKind, "cursorKind");
  if (cursorKind !== contract.cursorKind) {
    throw invalidArgument("cursorKind", `must be ${contract.cursorKind} for ${sourceSystem}`);
  }
  const syncToken = requireString(options.syncToken, "syncToken");
  const callRpc = options.callRpc;
  if (typeof callRpc !== "function") {
    throw invalidArgument("callRpc", "must be an explicitly injected function; no live fallback exists");
  }
  const rpcOptions = deepFreeze(cloneJson(options.rpcOptions ?? {}, "rpcOptions"));
  if (!isPlainObject(rpcOptions)) throw invalidArgument("rpcOptions", "must be an object");

  async function invoke(operation, rpc, body, validate) {
    let result;
    try {
      result = await callRpc(rpc, deepFreeze(body), rpcOptions);
    } catch (error) {
      throw normalizeError(error, { operation, rpc });
    }
    try {
      const receipt = immutableReceipt(result, operation, rpc);
      validate(receipt);
      return receipt;
    } catch (error) {
      error.retryable = true;
      error.ambiguousOutcome = true;
      error.outcomeUnknown = true;
      error.receiptInvalid = true;
      throw error;
    }
  }

  async function acquireLease(input = {}) {
    input = requireRecord(input, "acquireLease input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const ttlSeconds = input.ttlSeconds === undefined
      ? DEFAULT_LEASE_TTL_SECONDS
      : requireInteger(input.ttlSeconds, "ttlSeconds", 15);
    if (ttlSeconds > 900) throw invalidArgument("ttlSeconds", "must not exceed 900");
    return invoke("acquire source snapshot lease", RPC.acquireLease, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_ttl_seconds: ttlSeconds,
      p_cursor_kind: cursorKind,
      p_sync_token: syncToken,
    }, (receipt) => {
      receiptString(receipt, "acquire source snapshot lease", RPC.acquireLease, "cursorValue", { allowEmpty: true });
      receiptInteger(receipt, "acquire source snapshot lease", RPC.acquireLease, "cursorVersion");
      receiptString(receipt, "acquire source snapshot lease", RPC.acquireLease, "status");
      if (!receipt.ok) {
        receiptString(receipt, "acquire source snapshot lease", RPC.acquireLease, "code");
        return;
      }
      if (receiptString(receipt, "acquire source snapshot lease", RPC.acquireLease, "leaseOwner") !== ownerId) {
        throw invalidReceipt("acquire source snapshot lease", RPC.acquireLease, "leaseOwner", "does not match requester");
      }
      receiptInteger(receipt, "acquire source snapshot lease", RPC.acquireLease, "leaseFence", 1);
      receiptTimestamp(receipt, "acquire source snapshot lease", RPC.acquireLease, "leaseExpiresAt");
      if (receiptString(receipt, "acquire source snapshot lease", RPC.acquireLease, "cursorKind") !== cursorKind) {
        throw invalidReceipt("acquire source snapshot lease", RPC.acquireLease, "cursorKind", "does not match scope");
      }
    });
  }

  async function recordPreflightFailure(input = {}) {
    input = requireRecord(input, "recordPreflightFailure input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const errorCode = requireString(input.errorCode, "errorCode");
    const safeErrorDetail = requireString(input.safeErrorDetail, "safeErrorDetail");
    const diagnostics = cloneJson(input.diagnostics ?? {}, "diagnostics");
    if (!isPlainObject(diagnostics)) throw invalidArgument("diagnostics", "must be an object");
    return invoke("record source snapshot preflight failure", RPC.recordPreflightFailure, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_cursor_kind: cursorKind,
      p_recorded_by: ownerId,
      p_error_code: errorCode,
      p_safe_error_detail: safeErrorDetail,
      p_diagnostics: diagnostics,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) {
        receiptString(receipt, "record source snapshot preflight failure", RPC.recordPreflightFailure, "code");
        return;
      }
      receiptString(receipt, "record source snapshot preflight failure", RPC.recordPreflightFailure, "failureId");
      const failureHash = receiptString(receipt, "record source snapshot preflight failure", RPC.recordPreflightFailure, "failureHash");
      if (!/^[0-9a-f]{64}$/.test(failureHash)) {
        throw invalidReceipt("record source snapshot preflight failure", RPC.recordPreflightFailure, "failureHash", "must be a SHA-256 digest");
      }
      receiptString(receipt, "record source snapshot preflight failure", RPC.recordPreflightFailure, "status");
      receiptString(receipt, "record source snapshot preflight failure", RPC.recordPreflightFailure, "cursorValue", { allowEmpty: true });
      receiptInteger(receipt, "record source snapshot preflight failure", RPC.recordPreflightFailure, "cursorVersion");
      if (receipt.cursorAdvanced !== false) {
        throw invalidReceipt("record source snapshot preflight failure", RPC.recordPreflightFailure, "cursorAdvanced", "must be false");
      }
    });
  }

  async function renewLease(input = {}) {
    input = requireRecord(input, "renewLease input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireInteger(input.leaseFence, "leaseFence", 1);
    const ttlSeconds = input.ttlSeconds === undefined
      ? DEFAULT_LEASE_TTL_SECONDS
      : requireInteger(input.ttlSeconds, "ttlSeconds", 15);
    if (ttlSeconds > 900) throw invalidArgument("ttlSeconds", "must not exceed 900");
    return invoke("renew source snapshot lease", RPC.renewLease, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_ttl_seconds: ttlSeconds,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) {
        receiptString(receipt, "renew source snapshot lease", RPC.renewLease, "code");
        return;
      }
      if (receiptInteger(receipt, "renew source snapshot lease", RPC.renewLease, "leaseFence", 1) !== leaseFence) {
        throw invalidReceipt("renew source snapshot lease", RPC.renewLease, "leaseFence", "does not match request");
      }
      receiptTimestamp(receipt, "renew source snapshot lease", RPC.renewLease, "leaseExpiresAt");
    });
  }

  async function beginSnapshotBatch(input = {}) {
    input = requireRecord(input, "beginSnapshotBatch input");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireInteger(input.leaseFence, "leaseFence", 1);
    const triggerName = optionalString(input.triggerName, "triggerName");
    const mode = input.recoveryMode === true ? "snapshot_recovery" : "snapshot";
    return invoke("begin source snapshot batch", RPC.beginSnapshotBatch, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_mode: mode,
      p_trigger_name: triggerName,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) {
        receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "code");
        return;
      }
      receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "batchId");
      if (receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "mode") !== mode) {
        throw invalidReceipt("begin source snapshot batch", RPC.beginSnapshotBatch, "mode", `must be ${mode}`);
      }
      if (receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "status") !== "running") {
        throw invalidReceipt("begin source snapshot batch", RPC.beginSnapshotBatch, "status", "must be running");
      }
      receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "startCursorValue", { allowEmpty: true });
      receiptInteger(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "startCursorVersion");
      if (receiptInteger(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "pageCount") !== 0) {
        throw invalidReceipt("begin source snapshot batch", RPC.beginSnapshotBatch, "pageCount", "must be zero before atomic commit");
      }
      if (receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "resumePageToken", { allowEmpty: true }) !== "" ||
          receiptString(receipt, "begin source snapshot batch", RPC.beginSnapshotBatch, "responseMailboxHistoryId", { allowEmpty: true }) !== "" ||
          receipt.finalPagePersisted !== false) {
        throw invalidReceipt("begin source snapshot batch", RPC.beginSnapshotBatch, "Gmail pagination fields", "must be empty for snapshots");
      }
    });
  }

  async function recoverCommittedSnapshot(input = {}) {
    input = requireRecord(input, "recoverCommittedSnapshot input");
    const snapshot = normalizeSnapshotPayload(input, { sourceSystem, contract });
    return invoke("recover committed source snapshot", RPC.recoverCommittedSnapshot, {
      p_workspace_key: workspaceKey,
      p_source_system: sourceSystem,
      p_connection_key: connectionKey,
      p_next_cursor_value: snapshot.nextCursorValue,
      p_provider_manifest: snapshot.providerManifest,
      p_observations: snapshot.observations,
      p_jobs: snapshot.jobs,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) {
        receiptString(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "code");
        return;
      }
      if (typeof receipt.found !== "boolean") {
        throw invalidReceipt("recover committed source snapshot", RPC.recoverCommittedSnapshot, "found", "must be a boolean");
      }
      const payloadIdentityHash = receiptString(
        receipt,
        "recover committed source snapshot",
        RPC.recoverCommittedSnapshot,
        "payloadIdentityHash",
      );
      if (!/^[0-9a-f]{64}$/.test(payloadIdentityHash)) {
        throw invalidReceipt(
          "recover committed source snapshot",
          RPC.recoverCommittedSnapshot,
          "payloadIdentityHash",
          "must be a lowercase SHA-256 digest",
        );
      }
      if (!receipt.found) return;
      receiptString(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "batchId");
      const batchHash = receiptString(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "batchHash");
      if (!/^[0-9a-f]{64}$/.test(batchHash)) {
        throw invalidReceipt("recover committed source snapshot", RPC.recoverCommittedSnapshot, "batchHash", "must be a SHA-256 digest");
      }
      if (receiptString(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "committedCursorValue") !== snapshot.nextCursorValue) {
        throw invalidReceipt("recover committed source snapshot", RPC.recoverCommittedSnapshot, "committedCursorValue", "does not match payload");
      }
      receiptInteger(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "committedCursorVersion", 1);
      if (receiptInteger(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "observationCount") !== snapshot.observations.length ||
          receiptInteger(receipt, "recover committed source snapshot", RPC.recoverCommittedSnapshot, "jobCount") !== snapshot.jobs.length) {
        throw invalidReceipt("recover committed source snapshot", RPC.recoverCommittedSnapshot, "counts", "do not match payload");
      }
    });
  }

  async function commitSnapshotBatch(input = {}) {
    input = requireRecord(input, "commitSnapshotBatch input");
    const batchId = requireString(input.batchId, "batchId");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireInteger(input.leaseFence, "leaseFence", 1);
    const { nextCursorValue, providerManifest, observations, jobs } = normalizeSnapshotPayload(input, {
      sourceSystem,
      contract,
    });
    return invoke("commit source snapshot batch", RPC.commitSnapshotBatch, {
      p_batch_id: batchId,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_next_cursor_value: nextCursorValue,
      p_provider_manifest: providerManifest,
      p_observations: observations,
      p_jobs: jobs,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) {
        receiptString(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "code");
        return;
      }
      if (receiptString(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "batchId") !== batchId) {
        throw invalidReceipt("commit source snapshot batch", RPC.commitSnapshotBatch, "batchId", "does not match request");
      }
      receiptString(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "batchHash");
      if (!/^[0-9a-f]{64}$/.test(receipt.batchHash)) {
        throw invalidReceipt("commit source snapshot batch", RPC.commitSnapshotBatch, "batchHash", "must be a lowercase SHA-256 digest");
      }
      if (receiptString(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "committedCursorValue") !== nextCursorValue) {
        throw invalidReceipt("commit source snapshot batch", RPC.commitSnapshotBatch, "committedCursorValue", "does not match request");
      }
      receiptInteger(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "committedCursorVersion", 1);
      if (receiptInteger(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "observationCount") !== observations.length) {
        throw invalidReceipt("commit source snapshot batch", RPC.commitSnapshotBatch, "observationCount", "does not match request");
      }
      if (receiptInteger(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, "jobCount") !== jobs.length) {
        throw invalidReceipt("commit source snapshot batch", RPC.commitSnapshotBatch, "jobCount", "does not match request");
      }
      for (const field of ["providerManifestHash", "observationManifestHash", "jobManifestHash"]) {
        if (!receipt.idempotent || Object.prototype.hasOwnProperty.call(receipt, field)) {
          const value = receiptString(receipt, "commit source snapshot batch", RPC.commitSnapshotBatch, field);
          if (!/^[0-9a-f]{64}$/.test(value)) {
            throw invalidReceipt("commit source snapshot batch", RPC.commitSnapshotBatch, field, "must be a lowercase SHA-256 digest");
          }
        }
      }
    });
  }

  async function failSnapshotBatch(input = {}) {
    input = requireRecord(input, "failSnapshotBatch input");
    const batchId = requireString(input.batchId, "batchId");
    const ownerId = requireString(input.ownerId, "ownerId");
    const leaseFence = requireInteger(input.leaseFence, "leaseFence", 1);
    const errorCode = requireString(input.errorCode, "errorCode");
    const safeErrorDetail = requireString(input.safeErrorDetail, "safeErrorDetail");
    return invoke("fail source snapshot batch", RPC.failSnapshotBatch, {
      p_batch_id: batchId,
      p_owner_id: ownerId,
      p_lease_fence: leaseFence,
      p_error_code: errorCode,
      p_safe_error_detail: safeErrorDetail,
      p_sync_token: syncToken,
    }, (receipt) => {
      if (!receipt.ok) {
        receiptString(receipt, "fail source snapshot batch", RPC.failSnapshotBatch, "code");
        return;
      }
      if (receiptString(receipt, "fail source snapshot batch", RPC.failSnapshotBatch, "batchId") !== batchId) {
        throw invalidReceipt("fail source snapshot batch", RPC.failSnapshotBatch, "batchId", "does not match request");
      }
      if (receiptString(receipt, "fail source snapshot batch", RPC.failSnapshotBatch, "status") !== "failed") {
        throw invalidReceipt("fail source snapshot batch", RPC.failSnapshotBatch, "status", "must be failed");
      }
      receiptInteger(receipt, "fail source snapshot batch", RPC.failSnapshotBatch, "cursorVersion");
      receiptString(receipt, "fail source snapshot batch", RPC.failSnapshotBatch, "cursorValue", { allowEmpty: true });
    });
  }

  return Object.freeze({
    scope: deepFreeze({ workspaceKey, sourceSystem, connectionKey, cursorKind }),
    recordPreflightFailure,
    acquireLease,
    renewLease,
    beginSnapshotBatch,
    recoverCommittedSnapshot,
    commitSnapshotBatch,
    failSnapshotBatch,
  });
}

module.exports = Object.freeze({
  CURSOR_KIND_BY_SOURCE,
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_WORKSPACE_KEY,
  RPC,
  SOURCE_CONTRACTS,
  SOURCE_SYSTEMS,
  SourceSnapshotLedgerError,
  createSourceSnapshotLedger,
  normalizeError,
});

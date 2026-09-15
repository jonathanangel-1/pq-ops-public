"use strict";

const crypto = require("node:crypto");

const RPC = Object.freeze({
  loadObservation: "load_truth_worker_observation",
  loadClaimContext: "load_truth_claim_worker_context",
  loadLinkContext: "load_truth_link_worker_context",
});

const CLAIM_JOB_KINDS = new Set([
  "gmail_extract_message_claims",
  "gmail_extract_attachment_claims",
  "tms_extract_claims",
  "tracking_extract_claims",
  "operator_extract_claims",
]);
const LINK_JOB_KIND = "gmail_resolve_entity_links";
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const CLAIM_VERSION_ID_RE = /^claim:v1:[0-9a-f]{64}$/;
const WORKGROUP_ID_RE = /^workgroup:v1:[0-9a-f]{64}$/;
const OPERATOR_EVENT_ID_RE = /^operator-event:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AWB_RE = /^[0-9]{11}$/;

const OBSERVATION_CONTRACTS = Object.freeze({
  gmail_extract_message_claims: Object.freeze({
    sourceSystem: "gmail",
    sourceObjectType: "gmail_message_parsed",
    payloadSchemaVersion: "gmail-parsed-message-v2",
  }),
  gmail_extract_attachment_claims: Object.freeze({
    sourceSystem: "gmail",
    sourceObjectType: "gmail_attachment_extracted",
    payloadSchemaVersion: "gmail-attachment-extracted-v1",
  }),
  tms_extract_claims: Object.freeze({
    sourceSystem: "tms",
    sourceObjectType: "tms_shipment_snapshot",
    payloadSchemaVersion: "tms-shipment-source-observation-v1",
  }),
  tracking_extract_claims: Object.freeze({
    sourceSystem: "tracking",
    sourceObjectType: "tracking_shipment_snapshot",
    payloadSchemaVersion: "tracking-source-observation-v1",
  }),
  operator_extract_claims: Object.freeze({
    sourceSystem: "operator",
    sourceObjectType: "operator_event",
    payloadSchemaVersion: "operator-event-source-observation-v1",
  }),
  [LINK_JOB_KIND]: Object.freeze({
    sourceSystem: "gmail",
    sourceObjectType: "gmail_message_parsed",
    payloadSchemaVersion: "gmail-parsed-message-v2",
  }),
});

class TruthWorkerContextLedgerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthWorkerContextLedgerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthWorkerContextLedgerError(`Invalid truth-worker context argument ${field}: ${reason}`, {
    code: "TRUTH_WORKER_CONTEXT_INVALID_ARGUMENT",
    field,
  });
}

function invalidReceipt(operation, field, reason) {
  return new TruthWorkerContextLedgerError(
    `Invalid ${operation} receipt ${field}: ${reason}`,
    {
      code: "TRUTH_WORKER_CONTEXT_INVALID_RECEIPT",
      operation,
      field,
    },
  );
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

function exactKeys(value, keys, field, operation = "truth-worker context") {
  if (!isPlainObject(value)) throw invalidReceipt(operation, field, "must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw invalidReceipt(operation, field, `must contain exactly ${expected.join(", ")}`);
  }
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 40) throw invalidArgument(field, "exceeds the maximum JSON depth");
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
      if (value[key] !== undefined) {
        result[key] = cloneJson(value[key], `${field}.${key}`, depth + 1);
      }
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

function postgresKeyCompare(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length;
  return Buffer.compare(leftBytes, rightBytes);
}

function postgresJsonbText(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(", ")}]`;
  if (!isPlainObject(value)) throw invalidArgument("receipt", "must contain only JSON values");
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(postgresKeyCompare)
    .map((key) => `${JSON.stringify(key)}: ${postgresJsonbText(value[key])}`)
    .join(", ")}}`;
}

function sha256Json(value) {
  if (value === null || typeof value !== "object") {
    return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  }
  const canonicalize = (item) => {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(canonicalize);
    return Object.keys(item).sort().reduce((output, key) => {
      if (item[key] !== undefined) output[key] = canonicalize(item[key]);
      return output;
    }, {});
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function receiptHash(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(value), "utf8").digest("hex");
}

function normalizeRpcError(error, operation, rpc) {
  if (error instanceof TruthWorkerContextLedgerError) return error;
  const cause = error instanceof Error ? error : new Error(String(error || "Unknown RPC failure"));
  let body = {};
  try {
    body = typeof cause.body === "string" ? JSON.parse(cause.body) : cause.body || {};
  } catch {
    body = {};
  }
  const sqlState = String(cause.code || body.code || "");
  const code = sqlState === "55000" && operation === "load truth-claim worker context"
    ? "TRUTH_WORKER_CONTEXT_NOT_READY"
    : sqlState || "TRUTH_WORKER_CONTEXT_RPC_FAILED";
  const status = Number(cause.status ?? cause.statusCode);
  return new TruthWorkerContextLedgerError(`${operation} failed: ${cause.message}`, {
    code,
    operation,
    rpc,
    status: Number.isFinite(status) ? status : null,
    sqlState: sqlState || null,
    retryable: typeof cause.retryable === "boolean"
      ? cause.retryable
      : code === "40001" || code === "54000"
        || code === "TRUTH_WORKER_CONTEXT_NOT_READY"
        || status === 408 || status === 409 || status === 429 || status >= 500,
    deadlineExceeded: cause.deadlineExceeded === true,
    outcomeUnknown: cause.outcomeUnknown === true,
    cause,
  });
}

function timestamp(value, field, operation) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw invalidReceipt(operation, field, "must be a canonical UTC timestamp or null");
  }
  return value;
}

function sortedUniqueStrings(value, field, operation, {
  pattern = null,
  allowEmpty = true,
  maximum = 2000,
} = {}) {
  if (!Array.isArray(value)) throw invalidReceipt(operation, field, "must be an array");
  if (!allowEmpty && value.length === 0) throw invalidReceipt(operation, field, "must not be empty");
  if (value.length > maximum) throw invalidReceipt(operation, field, `must contain at most ${maximum} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string" || !value[index] || value[index].trim() !== value[index]) {
      throw invalidReceipt(operation, `${field}[${index}]`, "must be a non-empty trimmed string");
    }
    if (pattern && !pattern.test(value[index])) {
      throw invalidReceipt(operation, `${field}[${index}]`, "has an invalid identity");
    }
  }
  const sorted = [...new Set(value)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(sorted) !== JSON.stringify(value)) {
    throw invalidReceipt(operation, field, "must be sorted and unique");
  }
  return value;
}

function normalizeJob(value, allowedKinds, configuredProcessorVersion) {
  if (!isPlainObject(value)) throw invalidArgument("job", "must be an object");
  const job = {
    jobId: string(value.jobId, "job.jobId"),
    jobKind: string(value.jobKind, "job.jobKind"),
    observationId: string(value.observationId, "job.observationId"),
    sourceObjectId: string(value.sourceObjectId, "job.sourceObjectId"),
    leaseFence: integer(value.leaseFence, "job.leaseFence", { minimum: 1 }),
  };
  if (!UUID_RE.test(job.jobId)) throw invalidArgument("job.jobId", "must be a UUID");
  if (!allowedKinds.has(job.jobKind)) throw invalidArgument("job.jobKind", "is unsupported by this loader");
  if (!OBSERVATION_ID_RE.test(job.observationId)) {
    throw invalidArgument("job.observationId", "must be an immutable observation identity");
  }
  if (value.processorVersion !== undefined
    && value.processorVersion !== configuredProcessorVersion) {
    throw invalidArgument("job.processorVersion", "does not match the configured processor");
  }
  return job;
}

function validateReceiptEnvelope(value, operation, expected, expectedSchema, keys) {
  exactKeys(value, keys, "result", operation);
  if (value.ok !== true
    || value.schemaVersion !== expectedSchema
    || value.workspaceKey !== expected.workspaceKey
    || value.jobId !== expected.job.jobId
    || value.jobKind !== expected.job.jobKind
    || value.workerId !== expected.workerId
    || value.leaseFence !== expected.job.leaseFence
    || value.processorVersion !== expected.processorVersion
    || !HASH_RE.test(String(value.contextHash || ""))) {
    throw invalidReceipt(operation, "result", "does not match the exact fenced request");
  }
  const core = cloneJson(value, `${operation}.receipt`);
  delete core.ok;
  delete core.contextHash;
  if (receiptHash(core) !== value.contextHash) {
    throw invalidReceipt(operation, "contextHash", "does not hash the returned server context");
  }
  return core;
}

function validateObservation(value, job, operation, { link = false } = {}) {
  const contract = OBSERVATION_CONTRACTS[job.jobKind];
  const keys = link
    ? [
      "capturedAt", "contentHash", "observationId", "parsedMessage", "sourceObjectId",
      "sourceObjectType", "sourceRecordedAt", "sourceSystem",
    ]
    : [
      "capturedAt", "connectionKey", "contentHash", "journalSequence", "normalizedPayload",
      "normalizedText", "observationId", "operation", "schemaVersion", "sourceFidelity",
      "sourceObjectId", "sourceObjectType", "sourceRecordedAt", "sourceRevision", "sourceSystem",
    ];
  exactKeys(value, keys, "observation", operation);
  const payload = link ? value.parsedMessage : value.normalizedPayload;
  if (value.observationId !== job.observationId && !link
    || !OBSERVATION_ID_RE.test(String(value.observationId || ""))
    || value.sourceSystem !== contract.sourceSystem
    || value.sourceObjectType !== contract.sourceObjectType
    || (!link && value.sourceObjectId !== job.sourceObjectId)
    || !HASH_RE.test(String(value.contentHash || ""))
    || !isPlainObject(payload)
    || payload.schemaVersion !== contract.payloadSchemaVersion
    || sha256Json(payload) !== value.contentHash) {
    throw invalidReceipt(operation, "observation", "does not match immutable source evidence");
  }
  if (link) {
    if (payload?.gmail?.messageId !== value.sourceObjectId) {
      throw invalidReceipt(operation, "observation.sourceObjectId", "does not match parsed Gmail identity");
    }
  } else {
    if (value.operation !== "content" || typeof value.normalizedText !== "string") {
      throw invalidReceipt(operation, "observation", "must be a content observation with normalized text");
    }
    integer(value.journalSequence, "observation.journalSequence", { minimum: 1 });
    if (job.jobKind === "tracking_extract_claims") {
      const awb = String(payload.awb || "").replace(/\D/g, "");
      if (!AWB_RE.test(awb) || value.sourceObjectId !== awb) {
        throw invalidReceipt(operation, "observation.sourceObjectId",
          "must equal the structured tracking AWB");
      }
    }
    if (job.jobKind === "operator_extract_claims"
      && value.sourceObjectId !== payload?.event?.eventId) {
      throw invalidReceipt(operation, "observation.sourceObjectId",
        "must equal the immutable operator event identity");
    }
  }
  timestamp(value.sourceRecordedAt, "observation.sourceRecordedAt", operation);
  timestamp(value.capturedAt, "observation.capturedAt", operation);
  return value;
}

function validateClaim(value, index, operation) {
  const field = `acceptedClaims[${index}]`;
  exactKeys(value, [
    "appliesToAwbs", "claimKey", "claimVersionId", "gate", "itemHash", "normalizedValue",
    "occurredAt", "capturedAt", "sourceRecordedAt", "polarity", "predicate",
    "subjectKey", "subjectType", "versionNo",
  ], field, operation);
  if (!CLAIM_VERSION_ID_RE.test(String(value.claimVersionId || ""))
    || !HASH_RE.test(String(value.itemHash || ""))
    || value.claimVersionId !== `claim:v1:${value.itemHash}`
    || typeof value.claimKey !== "string" || !value.claimKey
    || !Number.isSafeInteger(value.versionNo) || value.versionNo < 1
    || !["shipment", "workgroup"].includes(value.subjectType)
    || typeof value.subjectKey !== "string" || !value.subjectKey
    || typeof value.predicate !== "string" || !value.predicate
    || typeof value.gate !== "string" || !value.gate
    || typeof value.polarity !== "string" || !value.polarity
    || !isPlainObject(value.normalizedValue)) {
    throw invalidReceipt(operation, field, "is not an immutable accepted-claim projection");
  }
  sortedUniqueStrings(value.appliesToAwbs, `${field}.appliesToAwbs`, operation, { pattern: AWB_RE });
  if (value.subjectType === "shipment"
    && (!AWB_RE.test(value.subjectKey) || !value.appliesToAwbs.includes(value.subjectKey))) {
    throw invalidReceipt(operation, field, "shipment subject must be present in appliesToAwbs");
  }
  if (value.subjectType === "workgroup" && !WORKGROUP_ID_RE.test(value.subjectKey)) {
    throw invalidReceipt(operation, field, "workgroup subject is invalid");
  }
  timestamp(value.occurredAt, `${field}.occurredAt`, operation);
  if (timestamp(value.capturedAt, `${field}.capturedAt`, operation) === null) {
    throw invalidReceipt(operation, `${field}.capturedAt`, "must not be null");
  }
  timestamp(value.sourceRecordedAt, `${field}.sourceRecordedAt`, operation);
  return value;
}

function validateWorkgroupContext(value, operation, maximum) {
  if (value === null) return null;
  exactKeys(value, [
    "linkedObservationIds", "linkedThreadIds", "memberAwbs", "observationAwbs", "workgroupId",
  ], "workgroupContext", operation);
  if (!WORKGROUP_ID_RE.test(String(value.workgroupId || ""))) {
    throw invalidReceipt(operation, "workgroupContext.workgroupId", "is invalid");
  }
  sortedUniqueStrings(value.memberAwbs, "workgroupContext.memberAwbs", operation, {
    pattern: AWB_RE,
    allowEmpty: false,
    maximum,
  });
  if (value.memberAwbs.length < 2) {
    throw invalidReceipt(operation, "workgroupContext.memberAwbs", "must contain at least two shipments");
  }
  sortedUniqueStrings(value.observationAwbs, "workgroupContext.observationAwbs", operation, {
    pattern: AWB_RE,
    maximum,
  });
  if (value.observationAwbs.some((awb) => !value.memberAwbs.includes(awb))) {
    throw invalidReceipt(operation, "workgroupContext.observationAwbs", "must be a subset of memberAwbs");
  }
  sortedUniqueStrings(value.linkedThreadIds, "workgroupContext.linkedThreadIds", operation, { maximum });
  sortedUniqueStrings(value.linkedObservationIds, "workgroupContext.linkedObservationIds", operation, {
    pattern: OBSERVATION_ID_RE,
    allowEmpty: false,
    maximum,
  });
  return value;
}

function createTruthWorkerContextLedger(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const workspaceKey = string(options.workspaceKey ?? "primary", "workspaceKey");
  const workerId = string(options.workerId, "workerId");
  const processorVersion = string(options.processorVersion, "processorVersion");
  const syncToken = string(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken");
  const maxClaimItems = integer(options.maxClaimItems ?? 500, "maxClaimItems", {
    minimum: 1,
    maximum: 2000,
  });
  const maxLinkObservations = integer(options.maxLinkObservations ?? 250, "maxLinkObservations", {
    minimum: 1,
    maximum: 2000,
  });
  const linkWindowSeconds = integer(options.linkWindowSeconds ?? 86_400, "linkWindowSeconds", {
    minimum: 60,
    maximum: 604_800,
  });
  if (!Array.isArray(options.internalDomains ?? ["partner-116.example"])) {
    throw invalidArgument("internalDomains", "must be an array");
  }
  const internalDomains = [...new Set((options.internalDomains ?? ["partner-116.example"]).map((domain, index) => {
    const normalized = string(domain, `internalDomains[${index}]`).toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalized)) {
      throw invalidArgument(`internalDomains[${index}]`, "must be a normalized domain");
    }
    return normalized;
  }))].sort();
  const rpcOptions = cloneJson(options.rpcOptions ?? {}, "rpcOptions");
  const callRpc = options.callRpc || ((...args) => require("./supabase-agent").callSupabaseRpc(...args));
  if (typeof callRpc !== "function") throw invalidArgument("callRpc", "must be a function");
  const claimContextCache = new Map();

  async function invoke(operation, rpc, body) {
    try {
      return await callRpc(rpc, body, rpcOptions);
    } catch (error) {
      throw normalizeRpcError(error, operation, rpc);
    }
  }

  function expected(job) {
    return { workspaceKey, workerId, processorVersion, job };
  }

  function fencedBody(job) {
    return {
      p_workspace_key: workspaceKey,
      p_job_id: job.jobId,
      p_worker_id: workerId,
      p_lease_fence: job.leaseFence,
      p_processor_version: processorVersion,
      p_sync_token: syncToken,
    };
  }

  async function loadObservation(rawJob) {
    const operation = "load truth-worker observation";
    const job = normalizeJob(rawJob, CLAIM_JOB_KINDS, processorVersion);
    const value = await invoke(operation, RPC.loadObservation, fencedBody(job));
    validateReceiptEnvelope(value, operation, expected(job), "truth-worker-observation-receipt-v1", [
      "contextHash", "jobId", "jobKind", "leaseFence", "observation", "ok",
      "processorVersion", "schemaVersion", "workerId", "workspaceKey",
    ]);
    validateObservation(value.observation, job, operation);
    return deepFreeze(cloneJson(value.observation, "observation"));
  }

  async function fetchClaimContext(job) {
    const operation = "load truth-claim worker context";
    const value = await invoke(operation, RPC.loadClaimContext, {
      ...fencedBody(job),
      p_max_items: maxClaimItems,
    });
    validateReceiptEnvelope(value, operation, expected(job), "truth-claim-worker-context-receipt-v2", [
      "acceptedClaims", "contextBound", "contextHash", "jobId", "jobKind", "leaseFence",
      "ok", "processorVersion", "schemaVersion", "workerId", "workgroupContext", "workspaceKey",
    ]);
    exactKeys(value.contextBound, [
      "acceptedClaimCount", "basis", "journalSequenceInclusive", "linkedObservationCount",
      "maximumItemsPerCollection", "operatorRelatedEventId", "operatorRelatedObservationId",
      "sourceObservationContentHash", "sourceObservationId", "subjectAwbs", "workgroupId",
    ], "contextBound", operation);
    const bound = value.contextBound;
    if (bound.basis !== "immutable-subject-and-workgroup-membership"
      || bound.sourceObservationId !== job.observationId
      || !HASH_RE.test(String(bound.sourceObservationContentHash || ""))
      || !Number.isSafeInteger(bound.journalSequenceInclusive)
      || bound.journalSequenceInclusive < 1
      || bound.maximumItemsPerCollection !== maxClaimItems
      || !Number.isSafeInteger(bound.acceptedClaimCount) || bound.acceptedClaimCount < 0
      || !Number.isSafeInteger(bound.linkedObservationCount) || bound.linkedObservationCount < 0
      || typeof bound.workgroupId !== "string"
      || typeof bound.operatorRelatedEventId !== "string"
      || typeof bound.operatorRelatedObservationId !== "string") {
      throw invalidReceipt(operation, "contextBound", "does not match the exact immutable subject bound");
    }
    if (bound.operatorRelatedEventId
      && (!OPERATOR_EVENT_ID_RE.test(bound.operatorRelatedEventId)
        || !OBSERVATION_ID_RE.test(bound.operatorRelatedObservationId))) {
      throw invalidReceipt(operation, "contextBound.operatorRelatedEventId",
        "must identify one exact prior operator observation");
    }
    if (!bound.operatorRelatedEventId && bound.operatorRelatedObservationId) {
      throw invalidReceipt(operation, "contextBound.operatorRelatedObservationId",
        "cannot exist without a related operator event");
    }
    sortedUniqueStrings(bound.subjectAwbs, "contextBound.subjectAwbs", operation, {
      pattern: AWB_RE,
      maximum: maxClaimItems,
    });
    if (!Array.isArray(value.acceptedClaims)
      || value.acceptedClaims.length !== bound.acceptedClaimCount
      || value.acceptedClaims.length > maxClaimItems) {
      throw invalidReceipt(operation, "acceptedClaims", "does not match its explicit count and bound");
    }
    value.acceptedClaims.forEach((claim, index) => validateClaim(claim, index, operation));
    const sortedClaims = [...value.acceptedClaims].sort((left, right) => (
      left.claimKey.localeCompare(right.claimKey)
      || left.versionNo - right.versionNo
      || left.claimVersionId.localeCompare(right.claimVersionId)
    ));
    if (JSON.stringify(sortedClaims) !== JSON.stringify(value.acceptedClaims)
      || new Set(value.acceptedClaims.map((claim) => claim.claimVersionId)).size
        !== value.acceptedClaims.length) {
      throw invalidReceipt(operation, "acceptedClaims", "must be ordered and unique");
    }
    validateWorkgroupContext(value.workgroupContext, operation, maxClaimItems);
    if ((value.workgroupContext?.workgroupId || "") !== bound.workgroupId
      || (value.workgroupContext?.linkedObservationIds.length || 0) !== bound.linkedObservationCount) {
      throw invalidReceipt(operation, "workgroupContext", "does not match its returned context bound");
    }
    return deepFreeze({
      contextHash: value.contextHash,
      contextBound: cloneJson(bound),
      workgroupContext: cloneJson(value.workgroupContext),
      acceptedClaims: cloneJson(value.acceptedClaims),
    });
  }

  async function loadClaimContext(rawJob) {
    const job = normalizeJob(rawJob, CLAIM_JOB_KINDS, processorVersion);
    const key = [job.jobId, job.leaseFence, workerId, processorVersion].join(":");
    if (!claimContextCache.has(key)) {
      const pending = fetchClaimContext(job).catch((error) => {
        claimContextCache.delete(key);
        throw error;
      });
      claimContextCache.set(key, pending);
    }
    return claimContextCache.get(key);
  }

  async function loadWorkgroupContext(job) {
    return (await loadClaimContext(job)).workgroupContext;
  }

  async function loadAcceptedClaims(job) {
    return (await loadClaimContext(job)).acceptedClaims;
  }

  async function loadLinkContext(rawJob) {
    const operation = "load truth-link worker context";
    const job = normalizeJob(rawJob, new Set([LINK_JOB_KIND]), processorVersion);
    const value = await invoke(operation, RPC.loadLinkContext, {
      ...fencedBody(job),
      p_max_observations: maxLinkObservations,
      p_window_seconds: linkWindowSeconds,
      p_internal_domains: internalDomains,
    });
    validateReceiptEnvelope(value, operation, expected(job), "truth-link-worker-context-receipt-v1", [
      "contextBound", "contextHash", "contradictions", "currentWorkgroups", "jobId", "jobKind",
      "knownBrokers", "knownShipments", "leaseFence", "observations", "ok", "processorVersion",
      "schemaVersion", "workerId", "workspaceKey",
    ]);
    exactKeys(value.contextBound, [
      "anchorContentHash", "anchorObservationId", "anchorSourceTime", "basis",
      "candidateObservationCount", "internalDomains", "journalSequenceInclusive",
      "maximumObservations", "windowEndInclusive", "windowSecondsEachDirection",
      "windowStartInclusive",
    ], "contextBound", operation);
    const bound = value.contextBound;
    if (bound.basis !== "anchor-time-and-external-participant-at-journal-sequence"
      || bound.anchorObservationId !== job.observationId
      || !HASH_RE.test(String(bound.anchorContentHash || ""))
      || !Number.isSafeInteger(bound.journalSequenceInclusive) || bound.journalSequenceInclusive < 1
      || bound.maximumObservations !== maxLinkObservations
      || bound.windowSecondsEachDirection !== linkWindowSeconds
      || !Number.isSafeInteger(bound.candidateObservationCount)
      || bound.candidateObservationCount < 1
      || JSON.stringify(bound.internalDomains) !== JSON.stringify(internalDomains)) {
      throw invalidReceipt(operation, "contextBound", "does not match the exact requested journal/time bound");
    }
    timestamp(bound.anchorSourceTime, "contextBound.anchorSourceTime", operation);
    timestamp(bound.windowStartInclusive, "contextBound.windowStartInclusive", operation);
    timestamp(bound.windowEndInclusive, "contextBound.windowEndInclusive", operation);
    if (!Array.isArray(value.observations)
      || value.observations.length !== bound.candidateObservationCount
      || value.observations.length > maxLinkObservations
      || value.observations[0]?.observationId !== job.observationId) {
      throw invalidReceipt(operation, "observations", "must contain its anchor first and match its explicit bound");
    }
    const contextIds = new Set();
    for (let index = 0; index < value.observations.length; index += 1) {
      const observation = value.observations[index];
      validateObservation(observation, job, operation, { link: true });
      if (contextIds.has(observation.observationId)) {
        throw invalidReceipt(operation, `observations[${index}].observationId`, "must be unique");
      }
      contextIds.add(observation.observationId);
    }
    if (value.observations[0].contentHash !== bound.anchorContentHash) {
      throw invalidReceipt(operation, "contextBound.anchorContentHash", "does not match its anchor");
    }
    sortedUniqueStrings(value.knownShipments, "knownShipments", operation, {
      pattern: AWB_RE,
      maximum: 2000,
    });
    sortedUniqueStrings(value.knownBrokers, "knownBrokers", operation, { maximum: 2000 });
    if (!Array.isArray(value.currentWorkgroups) || value.currentWorkgroups.length > 2000) {
      throw invalidReceipt(operation, "currentWorkgroups", "must be a bounded array");
    }
    const workgroupKeys = [];
    for (let index = 0; index < value.currentWorkgroups.length; index += 1) {
      const field = `currentWorkgroups[${index}]`;
      const workgroup = value.currentWorkgroups[index];
      exactKeys(workgroup, ["brokerKeys", "identityKey", "purposes", "shipmentKeys"], field, operation);
      string(workgroup.identityKey, `${field}.identityKey`);
      sortedUniqueStrings(workgroup.shipmentKeys, `${field}.shipmentKeys`, operation, {
        pattern: AWB_RE,
        maximum: 2000,
      });
      sortedUniqueStrings(workgroup.brokerKeys, `${field}.brokerKeys`, operation, { maximum: 2000 });
      sortedUniqueStrings(workgroup.purposes, `${field}.purposes`, operation, { maximum: 2000 });
      workgroupKeys.push(workgroup.identityKey);
    }
    if (JSON.stringify([...workgroupKeys].sort()) !== JSON.stringify(workgroupKeys)
      || new Set(workgroupKeys).size !== workgroupKeys.length) {
      throw invalidReceipt(operation, "currentWorkgroups", "must be ordered and unique");
    }
    if (!Array.isArray(value.contradictions) || value.contradictions.length > 2000) {
      throw invalidReceipt(operation, "contradictions", "must be a bounded array");
    }
    for (let index = 0; index < value.contradictions.length; index += 1) {
      const field = `contradictions[${index}]`;
      const contradiction = value.contradictions[index];
      exactKeys(contradiction, [
        "candidateKey", "entityKey", "observationId", "reason", "workgroupIdentityKey",
      ], field, operation);
      for (const key of ["candidateKey", "entityKey", "observationId", "workgroupIdentityKey"]) {
        if (typeof contradiction[key] !== "string" || contradiction[key].trim() !== contradiction[key]) {
          throw invalidReceipt(operation, `${field}.${key}`, "must be a trimmed string");
        }
      }
      if (!contradiction.candidateKey && !contradiction.entityKey
        && !contradiction.observationId && !contradiction.workgroupIdentityKey) {
        throw invalidReceipt(operation, field, "must identify the contradicted item");
      }
      string(contradiction.reason, `${field}.reason`);
      if (contradiction.observationId && !OBSERVATION_ID_RE.test(contradiction.observationId)) {
        throw invalidReceipt(operation, `${field}.observationId`, "is invalid");
      }
    }
    return deepFreeze({
      observations: cloneJson(value.observations),
      knownShipments: cloneJson(value.knownShipments),
      knownBrokers: cloneJson(value.knownBrokers),
      currentWorkgroups: cloneJson(value.currentWorkgroups),
      contradictions: cloneJson(value.contradictions),
      contextBound: cloneJson(value.contextBound),
      contextHash: value.contextHash,
    });
  }

  return Object.freeze({
    workspaceKey,
    workerId,
    processorVersion,
    maxClaimItems,
    maxLinkObservations,
    linkWindowSeconds,
    internalDomains: Object.freeze([...internalDomains]),
    loadObservation,
    loadClaimContext,
    loadWorkgroupContext,
    loadAcceptedClaims,
    loadLinkContext,
    loadContext: loadLinkContext,
  });
}

module.exports = {
  CLAIM_JOB_KINDS,
  LINK_JOB_KIND,
  OBSERVATION_CONTRACTS,
  RPC,
  TruthWorkerContextLedgerError,
  createTruthWorkerContextLedger,
  _test: {
    cloneJson,
    normalizeJob,
    postgresJsonbText,
    receiptHash,
    sha256Json,
    validateClaim,
    validateObservation,
    validateReceiptEnvelope,
    validateWorkgroupContext,
  },
};

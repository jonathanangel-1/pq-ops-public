"use strict";

const { PREDICATES, REGISTRY } = require("./truth-predicate-registry");
const {
  DEFAULT_CONNECTION_KEY,
  IDEMPOTENCY_KEY_RE,
  createTruthOperatorEventLedger,
} = require("./truth-operator-event-ledger");

const RUNTIME_VERSION = "truth-operator-event-runtime-v1";
const REQUEST_SCHEMA_VERSION = "operator-truth-event-request-v1";
const EVENT_TYPES = new Set(["assertion", "correction", "revocation"]);
const POLARITIES = new Set(["positive", "negative", "requested", "neutral", "unknown"]);
const AWB_RE = /^[0-9]{11}$/;
const WORKGROUP_RE = /^workgroup:v1:[0-9a-f]{64}$/;
const EVENT_ID_RE = /^operator-event:v1:[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class TruthOperatorEventRuntimeError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthOperatorEventRuntimeError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthOperatorEventRuntimeError(`Invalid operator truth event ${field}: ${reason}`, {
    code: "TRUTH_OPERATOR_EVENT_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, field, maxBytes) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function canonicalize(value, field = "value", depth = 0) {
  if (depth > 16) throw invalid(field, "exceeds maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${field}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalid(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) output[key] = canonicalize(value[key], `${field}.${key}`, depth + 1);
    }
    return output;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) throw invalid(field, "must be an object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw invalid(field, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function canonicalTimestamp(value, field) {
  const timestamp = boundedText(value, field, 64);
  if (!TIMESTAMP_RE.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp))
      || new Date(timestamp).toISOString() !== timestamp) {
    throw invalid(field, "must be canonical UTC with millisecond precision");
  }
  return timestamp;
}

function normalizeSubject(value) {
  if (!isPlainObject(value)) throw invalid("request.subject", "must be an object");
  const type = boundedText(value.type, "request.subject.type", 32);
  if (type === "shipment") exactKeys(value, ["type", "awbs"], "request.subject");
  else if (type === "workgroup") {
    exactKeys(value, ["type", "workgroupKey", "membershipComplete", "awbs"], "request.subject");
  } else throw invalid("request.subject.type", "must be shipment or workgroup");
  if (!Array.isArray(value.awbs) || value.awbs.length < 1 || value.awbs.length > 100) {
    throw invalid("request.subject.awbs", "must contain 1-100 canonical AWBs");
  }
  const awbs = value.awbs.map((awb, index) => {
    const candidate = boundedText(awb, `request.subject.awbs[${index}]`, 11);
    if (!AWB_RE.test(candidate)) throw invalid(`request.subject.awbs[${index}]`, "must be eleven digits");
    return candidate;
  });
  if (new Set(awbs).size !== awbs.length || JSON.stringify([...awbs].sort()) !== JSON.stringify(awbs)) {
    throw invalid("request.subject.awbs", "must be sorted and unique");
  }
  if (type === "shipment") {
    if (awbs.length !== 1) throw invalid("request.subject.awbs", "shipment scope requires exactly one AWB");
    return { type, awbs };
  }
  const workgroupKey = boundedText(value.workgroupKey, "request.subject.workgroupKey", 128);
  if (!WORKGROUP_RE.test(workgroupKey)) throw invalid("request.subject.workgroupKey", "must be a workgroup:v1 identity");
  if (value.membershipComplete !== true || awbs.length < 2) {
    throw invalid("request.subject", "workgroup scope requires a complete multi-AWB membership");
  }
  return { type, workgroupKey, membershipComplete: true, awbs };
}

function normalizeAssertion(value, eventType) {
  exactKeys(value, ["contractVersion", "predicate", "polarity", "value"], "request.assertion");
  const contractVersion = boundedText(value.contractVersion, "request.assertion.contractVersion", 200);
  if (contractVersion !== REGISTRY.registryVersion) {
    throw invalid("request.assertion.contractVersion", `must equal ${REGISTRY.registryVersion}`);
  }
  const predicate = boundedText(value.predicate, "request.assertion.predicate", 100);
  const polarity = boundedText(value.polarity, "request.assertion.polarity", 32);
  const policy = PREDICATES[predicate];
  if (!policy || !POLARITIES.has(polarity)) {
    throw invalid("request.assertion", "contains an unsupported predicate or polarity");
  }
  if (!isPlainObject(value.value)) throw invalid("request.assertion.value", "must be an object");
  const normalizedValue = canonicalize(value.value, "request.assertion.value");
  if (Buffer.byteLength(JSON.stringify(normalizedValue), "utf8") > 8192) {
    throw invalid("request.assertion.value", "must not exceed 8 KiB");
  }
  if (normalizedValue.status !== policy.statuses[polarity]
      || normalizedValue.effect !== policy.effects[polarity]) {
    throw invalid("request.assertion.value", "does not match the predicate/polarity status and effect");
  }
  if (eventType === "revocation") {
    exactKeys(normalizedValue, ["status", "effect"], "request.assertion.value");
    if (polarity !== "unknown") throw invalid("request.assertion.polarity", "revocation must be unknown");
  }
  return { contractVersion, predicate, polarity, value: normalizedValue };
}

function normalizeOperatorTruthRequest(value) {
  if (!isPlainObject(value)) throw invalid("request", "must be an object");
  const eventType = boundedText(value.eventType, "request.eventType", 32);
  if (!EVENT_TYPES.has(eventType)) throw invalid("request.eventType", "is unsupported");
  const keys = [
    "schemaVersion", "eventType", "subject", "contact", "recordedBy",
    "occurredAt", "recordedSummary", "assertion",
  ];
  if (eventType !== "assertion") keys.push("relatedEventId");
  exactKeys(value, keys, "request");
  if (value.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    throw invalid("request.schemaVersion", `must equal ${REQUEST_SCHEMA_VERSION}`);
  }
  const subject = normalizeSubject(value.subject);
  exactKeys(value.contact, ["name", "organization", "channel"], "request.contact");
  const contact = {
    name: boundedText(value.contact.name, "request.contact.name", 200),
    organization: boundedText(value.contact.organization, "request.contact.organization", 300),
    channel: boundedText(value.contact.channel, "request.contact.channel", 32),
  };
  if (contact.channel !== "phone") throw invalid("request.contact.channel", "must equal phone");
  exactKeys(value.recordedBy, ["operatorId", "name"], "request.recordedBy");
  const recordedBy = {
    operatorId: boundedText(value.recordedBy.operatorId, "request.recordedBy.operatorId", 200),
    name: boundedText(value.recordedBy.name, "request.recordedBy.name", 200),
  };
  const occurredAt = canonicalTimestamp(value.occurredAt, "request.occurredAt");
  const recordedSummary = boundedText(value.recordedSummary, "request.recordedSummary", 2000);
  if (!/^(?:I|We)(?:\s|$)/.test(recordedSummary)) {
    throw invalid("request.recordedSummary", "must be a first-person record beginning with I or We");
  }
  const assertion = normalizeAssertion(value.assertion, eventType);
  const normalized = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    eventType,
    subject,
    contact,
    recordedBy,
    occurredAt,
    recordedSummary,
    assertion,
  };
  if (eventType !== "assertion") {
    const relatedEventId = boundedText(value.relatedEventId, "request.relatedEventId", 128);
    if (!EVENT_ID_RE.test(relatedEventId)) {
      throw invalid("request.relatedEventId", "must be an operator-event:v1 identity");
    }
    normalized.relatedEventId = relatedEventId;
  }
  const canonical = canonicalize(normalized, "request");
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > 32768) {
    throw invalid("request", "must not exceed 32 KiB");
  }
  return canonical;
}

function createTruthOperatorEventRuntime(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = boundedText(options.workspaceKey || "primary", "workspaceKey", 128);
  const connectionKey = boundedText(options.connectionKey || DEFAULT_CONNECTION_KEY, "connectionKey", 200);
  const buildLedger = options.createLedger || ((ledgerOptions) => createTruthOperatorEventLedger(ledgerOptions));
  if (typeof buildLedger !== "function") throw invalid("createLedger", "must be a function");
  const ledger = options.ledger || buildLedger({
    workspaceKey,
    connectionKey,
    syncToken: options.syncToken,
    callRpc: options.callRpc,
    rpcOptions: options.rpcOptions,
  });
  if (!ledger || typeof ledger.record !== "function"
      || ledger.scope?.workspaceKey !== workspaceKey
      || ledger.scope?.sourceSystem !== "operator"
      || ledger.scope?.connectionKey !== connectionKey) {
    throw invalid("ledger", "must expose the exact server-owned operator source scope");
  }

  async function record(input = {}) {
    if (!isPlainObject(input)) throw invalid("record", "must be an object");
    const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 128);
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw invalid("idempotencyKey", "must be 32-128 base64url characters");
    }
    const request = normalizeOperatorTruthRequest(input.request);
    try {
      return await ledger.record({ idempotencyKey, request });
    } catch (error) {
      if (error instanceof TruthOperatorEventRuntimeError) throw error;
      throw new TruthOperatorEventRuntimeError(`Operator truth event recording failed: ${error?.message || String(error)}`, {
        code: String(error?.code || "TRUTH_OPERATOR_EVENT_RECORD_FAILED"),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        safeToRetryWithSameIdempotencyKey: true,
        cause: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return Object.freeze({ runtimeVersion: RUNTIME_VERSION, workspaceKey, connectionKey, record });
}

module.exports = Object.freeze({
  REQUEST_SCHEMA_VERSION,
  RUNTIME_VERSION,
  TruthOperatorEventRuntimeError,
  createTruthOperatorEventRuntime,
  normalizeOperatorTruthRequest,
  _test: Object.freeze({ canonicalize, exactKeys, normalizeAssertion, normalizeSubject }),
});

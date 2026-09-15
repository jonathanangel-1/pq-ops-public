"use strict";

const MATERIALIZATION_JOB_KIND = "gmail_materialize_message_revision";
const MATERIALIZATION_JOB_SCHEMA_VERSION = "gmail-materialize-message-revision-job-v1";
const MATERIALIZATION_AUTHORITY_SCHEMA_VERSION = "gmail-materialization-claim-authority-v1";
const MATERIALIZER_VERSION = "gmail-message-revision-materializer-v1";
const RAW_MESSAGE_SCHEMA_VERSION = "gmail-raw-message-v2";
const MATERIALIZATION_RESULT_SCHEMA_VERSION = "gmail-message-revision-materialization-result-v1";
const PARSE_JOB_SCHEMA_VERSION = "gmail-parse-rfc822-job-v2";
const PARSE_RESULT_SCHEMA_VERSION = "gmail-parse-result-v2";
const ATTACHMENT_SCHEMA_VERSION = "gmail-attachment-v2";

const TRIGGER_KINDS = Object.freeze({
  HISTORY_EVENT: "history_event",
  MAILBOX_DISCOVERY: "mailbox_discovery",
});
const MATERIALIZATION_JOB_KEYS = Object.freeze([
  "schemaVersion", "groupId", "messageId", "materializerVersion", "requestedFormat",
]);
const MATERIALIZATION_AUTHORITY_KEYS = Object.freeze([
  "schemaVersion", "groupId", "groupHash", "routeSealId", "routeSealHash",
  "rootBatchId", "rootBatchHash", "connectionKey", "sourceCursorVersion",
  "sourceCursorValue", "messageId", "threadId", "selectedTrigger",
  "coverageManifestId", "coverageManifestHash", "coverageCount", "materializerVersion",
]);
const MATERIALIZATION_TRIGGER_KEYS = Object.freeze([
  "observationId", "contentHash", "kind", "eventType", "historyId",
]);
const HISTORY_EVENT_TYPES = new Set(["message_added", "labels_added", "labels_removed"]);
const DISCOVERY_EVENT_TYPES = new Set(["message_discovered"]);
const HASH_RE = /^[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class GmailMessageRevisionContractError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "GmailMessageRevisionContractError";
    this.code = "GMAIL_MESSAGE_REVISION_CONTRACT_INVALID";
    Object.assign(this, fields);
  }
}

function invalid(field, reason) {
  throw new GmailMessageRevisionContractError(
    `Invalid Gmail message-revision contract field ${field}: ${reason}`,
    { field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") invalid(field, "must be a string");
  if (!allowEmpty && value.length === 0) invalid(field, "must not be empty");
  if (value.trim() !== value) invalid(field, "must not contain surrounding whitespace");
  return value;
}

function decimal(value, field) {
  const result = string(value, field);
  if (!/^\d+$/.test(result)) invalid(field, "must be an exact decimal string");
  return result;
}

function hash(value, field) {
  const result = string(value, field);
  if (!HASH_RE.test(result)) invalid(field, "must be lowercase SHA-256 hex");
  return result;
}

function observationId(value, field) {
  const result = string(value, field);
  if (!OBSERVATION_ID_RE.test(result)) invalid(field, "must be an obs:v1 identity");
  return result;
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) invalid(field, "must be an object");
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length
    || actual.some((key, index) => key !== required[index])) {
    invalid(field, `must contain exactly: ${required.join(", ")}`);
  }
}

function compareDecimal(leftValue, rightValue) {
  const left = leftValue.replace(/^0+(?=\d)/, "");
  const right = rightValue.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function normalizeTrigger(input = {}) {
  if (!isPlainObject(input)) invalid("input", "must be an object");
  const triggerKind = string(input.triggerKind, "triggerKind");
  if (!Object.values(TRIGGER_KINDS).includes(triggerKind)) {
    invalid("triggerKind", "must be history_event or mailbox_discovery");
  }
  const triggerEventType = string(input.triggerEventType, "triggerEventType");
  const allowedTypes = triggerKind === TRIGGER_KINDS.HISTORY_EVENT
    ? HISTORY_EVENT_TYPES
    : DISCOVERY_EVENT_TYPES;
  if (!allowedTypes.has(triggerEventType)) {
    invalid("triggerEventType", `is invalid for ${triggerKind}`);
  }
  return {
    workspaceKey: string(input.workspaceKey, "workspaceKey"),
    connectionKey: string(input.connectionKey, "connectionKey"),
    messageId: string(input.messageId, "messageId"),
    threadId: string(input.threadId ?? "", "threadId", { allowEmpty: true }),
    triggerObservationId: observationId(input.triggerObservationId, "triggerObservationId"),
    triggerObservationContentHash: hash(
      input.triggerObservationContentHash,
      "triggerObservationContentHash",
    ),
    triggerKind,
    triggerEventType,
    triggerHistoryId: decimal(input.triggerHistoryId, "triggerHistoryId"),
    materializerVersion: string(
      input.materializerVersion ?? MATERIALIZER_VERSION,
      "materializerVersion",
    ),
    requestedFormat: string(input.requestedFormat ?? "raw", "requestedFormat"),
  };
}

function normalizeMaterializationJobPayload(value) {
  exactKeys(value, MATERIALIZATION_JOB_KEYS, "job.payload");
  const groupId = string(value.groupId, "job.payload.groupId");
  if (!/^gmail-materialization-group:v1:[0-9a-f]{64}$/.test(groupId)) {
    invalid("job.payload.groupId", "must be a content-addressed materialization group");
  }
  const normalized = {
    schemaVersion: string(value.schemaVersion, "job.payload.schemaVersion"),
    groupId,
    messageId: string(value.messageId, "job.payload.messageId"),
    materializerVersion: string(value.materializerVersion, "job.payload.materializerVersion"),
    requestedFormat: string(value.requestedFormat, "job.payload.requestedFormat"),
  };
  if (normalized.schemaVersion !== MATERIALIZATION_JOB_SCHEMA_VERSION
      || normalized.materializerVersion !== MATERIALIZER_VERSION
      || normalized.requestedFormat !== "raw") {
    invalid("job.payload", "has an unsupported materialization contract version");
  }
  return Object.freeze(normalized);
}

function normalizeMaterializationAuthority(value, expected = {}) {
  exactKeys(value, MATERIALIZATION_AUTHORITY_KEYS, "job.materializationAuthority");
  const groupHash = hash(value.groupHash, "job.materializationAuthority.groupHash");
  const routeSealHash = hash(value.routeSealHash, "job.materializationAuthority.routeSealHash");
  const rootBatchHash = hash(value.rootBatchHash, "job.materializationAuthority.rootBatchHash");
  const coverageManifestHash = hash(
    value.coverageManifestHash,
    "job.materializationAuthority.coverageManifestHash",
  );
  const selected = value.selectedTrigger;
  exactKeys(selected, MATERIALIZATION_TRIGGER_KEYS, "job.materializationAuthority.selectedTrigger");
  const normalized = {
    schemaVersion: string(value.schemaVersion, "job.materializationAuthority.schemaVersion"),
    groupId: string(value.groupId, "job.materializationAuthority.groupId"),
    groupHash,
    routeSealId: string(value.routeSealId, "job.materializationAuthority.routeSealId"),
    routeSealHash,
    rootBatchId: string(value.rootBatchId, "job.materializationAuthority.rootBatchId"),
    rootBatchHash,
    connectionKey: string(value.connectionKey, "job.materializationAuthority.connectionKey"),
    sourceCursorVersion: value.sourceCursorVersion,
    sourceCursorValue: decimal(
      value.sourceCursorValue,
      "job.materializationAuthority.sourceCursorValue",
    ),
    messageId: string(value.messageId, "job.materializationAuthority.messageId"),
    threadId: string(value.threadId, "job.materializationAuthority.threadId", { allowEmpty: true }),
    selectedTrigger: Object.freeze({
      observationId: observationId(
        selected.observationId,
        "job.materializationAuthority.selectedTrigger.observationId",
      ),
      contentHash: hash(
        selected.contentHash,
        "job.materializationAuthority.selectedTrigger.contentHash",
      ),
      kind: string(selected.kind, "job.materializationAuthority.selectedTrigger.kind"),
      eventType: string(
        selected.eventType,
        "job.materializationAuthority.selectedTrigger.eventType",
      ),
      historyId: decimal(
        selected.historyId,
        "job.materializationAuthority.selectedTrigger.historyId",
      ),
    }),
    coverageManifestId: string(
      value.coverageManifestId,
      "job.materializationAuthority.coverageManifestId",
    ),
    coverageManifestHash,
    coverageCount: value.coverageCount,
    materializerVersion: string(
      value.materializerVersion,
      "job.materializationAuthority.materializerVersion",
    ),
  };
  if (normalized.schemaVersion !== MATERIALIZATION_AUTHORITY_SCHEMA_VERSION
      || normalized.groupId !== `gmail-materialization-group:v1:${groupHash}`
      || normalized.routeSealId !== `gmail-materialization-route-seal:v1:${routeSealHash}`
      || !UUID_RE.test(normalized.rootBatchId)
      || !Number.isSafeInteger(normalized.sourceCursorVersion)
      || normalized.sourceCursorVersion < 1
      || !Number.isSafeInteger(normalized.coverageCount)
      || normalized.coverageCount < 1
      || normalized.materializerVersion !== MATERIALIZER_VERSION
      || !normalized.coverageManifestId.endsWith(coverageManifestHash)) {
    invalid("job.materializationAuthority", "has invalid content-addressed authority fields");
  }
  normalizeTrigger({
    workspaceKey: "authority-validation",
    connectionKey: normalized.connectionKey,
    messageId: normalized.messageId,
    threadId: normalized.threadId,
    triggerObservationId: normalized.selectedTrigger.observationId,
    triggerObservationContentHash: normalized.selectedTrigger.contentHash,
    triggerKind: normalized.selectedTrigger.kind,
    triggerEventType: normalized.selectedTrigger.eventType,
    triggerHistoryId: normalized.selectedTrigger.historyId,
    materializerVersion: normalized.materializerVersion,
    requestedFormat: "raw",
  });
  if (compareDecimal(normalized.selectedTrigger.historyId, normalized.sourceCursorValue) > 0) {
    invalid("job.materializationAuthority.selectedTrigger", "is ahead of the committed cursor");
  }
  for (const [field, actual] of [
    ["groupId", normalized.groupId],
    ["rootBatchId", normalized.rootBatchId],
    ["connectionKey", normalized.connectionKey],
    ["sourceCursorVersion", normalized.sourceCursorVersion],
    ["sourceCursorValue", normalized.sourceCursorValue],
    ["messageId", normalized.messageId],
  ]) {
    if (expected[field] !== undefined && expected[field] !== actual) {
      invalid(`job.materializationAuthority.${field}`, "does not match the claimed job lineage");
    }
  }
  return Object.freeze(normalized);
}

module.exports = {
  ATTACHMENT_SCHEMA_VERSION,
  DISCOVERY_EVENT_TYPES,
  GmailMessageRevisionContractError,
  HISTORY_EVENT_TYPES,
  MATERIALIZATION_JOB_KIND,
  MATERIALIZATION_JOB_KEYS,
  MATERIALIZATION_JOB_SCHEMA_VERSION,
  MATERIALIZATION_AUTHORITY_KEYS,
  MATERIALIZATION_AUTHORITY_SCHEMA_VERSION,
  MATERIALIZATION_TRIGGER_KEYS,
  MATERIALIZER_VERSION,
  MATERIALIZATION_RESULT_SCHEMA_VERSION,
  PARSE_JOB_SCHEMA_VERSION,
  PARSE_RESULT_SCHEMA_VERSION,
  RAW_MESSAGE_SCHEMA_VERSION,
  TRIGGER_KINDS,
  normalizeMaterializationAuthority,
  normalizeMaterializationJobPayload,
  normalizeTrigger,
};

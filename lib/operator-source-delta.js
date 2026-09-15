"use strict";

// Append-only adapter for operator-recorded phone/in-person truth. Every event
// has a content-derived immutable identity and exact monotonically contiguous
// sequence. Corrections and revocations are new linked events; prior source
// events are never edited or deleted here.

const crypto = require("node:crypto");
const { PREDICATES, REGISTRY: PREDICATE_REGISTRY } = require("./truth-predicate-registry");

const DEFAULT_WORKSPACE_KEY = "primary";
const DEFAULT_EXTRACTOR_VERSION =
  `operator-claim-extractor-v1+predicates:${PREDICATE_REGISTRY.registryHash}`;
const DELTA_SCHEMA_VERSION = "operator-source-delta-v1";
const OBSERVATION_SCHEMA_VERSION = "operator-event-source-observation-v1";
const EVENT_SCHEMA_VERSION = "operator-recorded-event-v1";
const JOB_SCHEMA_VERSION = "operator-extract-claims-job-v1";
const EVENT_ID_RE = /^operator-event:v1:[0-9a-f]{64}$/;
const WORKGROUP_ID_RE = /^workgroup:v1:[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POLARITIES = new Set(["positive", "negative", "requested", "neutral", "unknown"]);
const EVENT_TYPES = new Set(["assertion", "correction", "revocation"]);

class OperatorSourceDeltaError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "OperatorSourceDeltaError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalize(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new OperatorSourceDeltaError(`${path}.${key} is forbidden`, {
          code: "OPERATOR_SOURCE_DELTA_INVALID_JSON",
          path: `${path}.${key}`,
        });
      }
      if (value[key] !== undefined) output[key] = canonicalize(value[key], `${path}.${key}`);
    }
    return output;
  }
  throw new OperatorSourceDeltaError(`${path} must contain only JSON-compatible values`, {
    code: "OPERATOR_SOURCE_DELTA_INVALID_JSON",
    path,
  });
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value), "utf8")
    .digest("hex");
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function canonicalTimestamp(value) {
  const result = text(value);
  return CANONICAL_TIMESTAMP_RE.test(result)
    && Number.isFinite(Date.parse(result))
    && new Date(result).toISOString() === result
    ? result
    : "";
}

function normalizeAwb(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits : "";
}

function parseSequence(value) {
  const string = typeof value === "number" ? String(value) : text(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(string)) return null;
  const number = Number(string);
  return Number.isSafeInteger(number) && number >= 0 ? { string, number } : null;
}

function issue(code, path, message, evidenceIds = []) {
  return {
    code,
    path,
    message,
    evidenceIds: [...new Set(evidenceIds.map(text).filter(Boolean))].sort(),
  };
}

function eventIdentityPreimage(event) {
  if (!isPlainObject(event)) return event;
  const copy = { ...event };
  delete copy.eventId;
  return canonicalize(copy, "eventIdentity");
}

function deriveOperatorEventId(event) {
  return `operator-event:v1:${sha256(eventIdentityPreimage(event))}`;
}

function inspectOperatorSourceDelta(delta, options = {}) {
  const issues = [];
  if (!isPlainObject(delta)) {
    return deepFreeze({
      complete: false,
      code: "OPERATOR_SOURCE_DELTA_INCOMPLETE",
      capturedAt: "",
      previousSequence: "",
      nextSequence: "",
      eventCount: 0,
      events: [],
      issues: [issue("delta_not_object", "delta", "Operator delta must be an object.")],
      mutatesOperationalState: false,
    });
  }
  if (delta.schemaVersion !== undefined && delta.schemaVersion !== DELTA_SCHEMA_VERSION) {
    issues.push(issue("delta_schema_invalid", "delta.schemaVersion", `schemaVersion must be ${DELTA_SCHEMA_VERSION}.`, [delta.schemaVersion]));
  }
  const capturedAt = canonicalTimestamp(delta.capturedAt);
  if (!capturedAt) {
    issues.push(issue(
      "delta_captured_at_invalid",
      "delta.capturedAt",
      "capturedAt must be a canonical UTC timestamp with millisecond precision.",
      [delta.capturedAt],
    ));
  }
  const previous = parseSequence(delta.previousSequence);
  if (!previous) {
    issues.push(issue(
      "delta_previous_sequence_invalid",
      "delta.previousSequence",
      "previousSequence must be a canonical non-negative decimal sequence.",
      [delta.previousSequence],
    ));
  }
  if (!Array.isArray(delta.events)) {
    issues.push(issue("delta_events_missing", "delta.events", "events must be an array."));
  }
  const events = [];
  const eventIds = new Map();
  for (const [index, rawEvent] of (Array.isArray(delta.events) ? delta.events : []).entries()) {
    const path = `delta.events[${index}]`;
    if (!isPlainObject(rawEvent)) {
      issues.push(issue("operator_event_invalid", path, "Each operator event must be an object."));
      continue;
    }
    const event = canonicalize(rawEvent, path);
    const sequence = parseSequence(event.sequence);
    const expected = previous ? previous.number + index + 1 : null;
    if (!sequence || sequence.number !== expected) {
      issues.push(issue(
        "operator_sequence_not_contiguous",
        `${path}.sequence`,
        "Events must be supplied in exact gap-free order immediately after previousSequence.",
        [`expected:${expected}`, `actual:${event.sequence}`],
      ));
    }
    const eventId = text(event.eventId);
    if (!EVENT_ID_RE.test(eventId) || eventId !== deriveOperatorEventId(event)) {
      issues.push(issue(
        "operator_event_identity_invalid",
        `${path}.eventId`,
        "eventId must be the content-derived immutable operator-event:v1 identity.",
        [eventId],
      ));
    } else if (eventIds.has(eventId)) {
      issues.push(issue(
        "operator_event_identity_duplicate",
        `${path}.eventId`,
        "Operator event identities must be unique.",
        [eventId, eventIds.get(eventId)],
      ));
    } else {
      eventIds.set(eventId, path);
    }
    if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
      issues.push(issue("operator_event_schema_invalid", `${path}.schemaVersion`, `schemaVersion must be ${EVENT_SCHEMA_VERSION}.`, [eventId]));
    }
    const eventType = text(event.eventType);
    if (!EVENT_TYPES.has(eventType)) {
      issues.push(issue("operator_event_type_invalid", `${path}.eventType`, "eventType must be assertion, correction, or revocation.", [eventId]));
    }
    const subject = isPlainObject(event.subject) ? event.subject : null;
    if (!subject || !["shipment", "workgroup"].includes(subject.type)) {
      issues.push(issue("operator_subject_invalid", `${path}.subject`, "subject.type must be shipment or workgroup.", [eventId]));
    }
    const awbs = Array.isArray(subject?.awbs) ? subject.awbs.map(normalizeAwb) : [];
    if (Array.isArray(subject?.awbs)
      && (awbs.some((awb) => !awb) || new Set(awbs).size !== awbs.length)) {
      issues.push(issue("operator_subject_awbs_invalid", `${path}.subject.awbs`, "Subject AWBs must be unique eleven-digit identities.", [eventId]));
    }
    if (subject?.type === "shipment" && awbs.length !== 1) {
      issues.push(issue("operator_shipment_scope_invalid", `${path}.subject.awbs`, "Shipment scope requires exactly one AWB.", [eventId]));
    }
    if (subject?.type === "workgroup" && !WORKGROUP_ID_RE.test(text(subject.workgroupKey))) {
      issues.push(issue("operator_workgroup_key_missing", `${path}.subject.workgroupKey`, "Workgroup scope requires a workgroup:v1 immutable identity.", [eventId]));
    }
    // A workgroup with no member list is retained but must be review-gated by
    // the extractor; this avoids inventing group membership at ingestion.
    const contact = isPlainObject(event.contact) ? event.contact : null;
    if (!contact || !text(contact.name) || !text(contact.organization)) {
      issues.push(issue("operator_contact_incomplete", `${path}.contact`, "Contact name and organization are both required.", [eventId]));
    }
    const recordedBy = isPlainObject(event.recordedBy) ? event.recordedBy : null;
    if (!recordedBy || !text(recordedBy.operatorId) || !text(recordedBy.name)) {
      issues.push(issue("operator_recorder_incomplete", `${path}.recordedBy`, "Recorder operator identity and name are required.", [eventId]));
    }
    const occurredAt = canonicalTimestamp(event.occurredAt);
    const recordedAt = canonicalTimestamp(event.recordedAt);
    if (!occurredAt) issues.push(issue("operator_occurred_at_invalid", `${path}.occurredAt`, "occurredAt must be canonical UTC.", [eventId]));
    if (!recordedAt) issues.push(issue("operator_recorded_at_invalid", `${path}.recordedAt`, "recordedAt must be canonical UTC.", [eventId]));
    if (occurredAt && recordedAt && Date.parse(occurredAt) > Date.parse(recordedAt)) {
      issues.push(issue("operator_time_order_invalid", path, "occurredAt must not be later than recordedAt.", [eventId]));
    }
    if (recordedAt && capturedAt && Date.parse(recordedAt) > Date.parse(capturedAt)) {
      issues.push(issue("operator_capture_order_invalid", path, "recordedAt must not be later than delta capturedAt.", [eventId]));
    }
    const summary = typeof event.recordedSummary === "string" ? event.recordedSummary : "";
    if (!summary || summary.trim() !== summary || !/^(?:I|We)\b/.test(summary)) {
      issues.push(issue(
        "operator_summary_not_first_person",
        `${path}.recordedSummary`,
        "recordedSummary must preserve a trimmed first-person record beginning with I or We.",
        [eventId],
      ));
    }
    const assertion = isPlainObject(event.assertion) ? event.assertion : null;
    const predicate = text(assertion?.predicate);
    const polarity = text(assertion?.polarity);
    const policy = PREDICATES[predicate];
    if (!assertion || !policy || !POLARITIES.has(polarity) || !isPlainObject(assertion.value)) {
      issues.push(issue(
        "operator_assertion_incomplete",
        `${path}.assertion`,
        "A structured registered predicate, polarity, and object value are required; free text is never sufficient.",
        [eventId, predicate, polarity],
      ));
    } else {
      if (assertion.contractVersion !== PREDICATE_REGISTRY.registryVersion) {
        issues.push(issue(
          "operator_predicate_contract_unpinned",
          `${path}.assertion.contractVersion`,
          "The assertion must pin the active predicate registry version.",
          [eventId, assertion.contractVersion],
        ));
      }
      if (assertion.value.status !== policy.statuses[polarity]
        || assertion.value.effect !== policy.effects[polarity]) {
        issues.push(issue(
          "operator_assertion_value_invalid",
          `${path}.assertion.value`,
          "Assertion status/effect must exactly match the pinned predicate and polarity contract.",
          [eventId, predicate, polarity],
        ));
      }
    }
    const relation = isPlainObject(event.relatedEvent) ? event.relatedEvent : null;
    if (eventType === "assertion" && relation) {
      issues.push(issue("operator_assertion_relation_forbidden", `${path}.relatedEvent`, "A first assertion must not rewrite or link a prior event.", [eventId]));
    }
    if (["correction", "revocation"].includes(eventType)) {
      const relatedSequence = parseSequence(relation?.sequence);
      const expectedRelation = eventType === "correction" ? "corrects" : "revokes";
      if (!relation || relation.relation !== expectedRelation || !EVENT_ID_RE.test(text(relation.eventId))
        || !relatedSequence || !sequence || relatedSequence.number >= sequence.number
        || relation.eventId === eventId) {
        issues.push(issue(
          "operator_prior_event_link_invalid",
          `${path}.relatedEvent`,
          `${eventType} must be a new event linked to an earlier immutable event identity and sequence.`,
          [eventId, relation?.eventId, relation?.sequence],
        ));
      }
    }
    if (eventType === "revocation" && assertion
      && (polarity !== "unknown"
        || assertion.value.status !== policy?.statuses.unknown
        || assertion.value.effect !== policy?.effects.unknown)) {
      issues.push(issue(
        "operator_revocation_semantics_invalid",
        `${path}.assertion`,
        "A revocation must append an explicit unknown assertion; it cannot silently delete or invert prior truth.",
        [eventId, predicate, polarity],
      ));
    }
    events.push(event);
  }
  const expectedFirstSequence = options.expectedFirstSequence === undefined
    ? null
    : parseSequence(options.expectedFirstSequence);
  if (options.expectedFirstSequence !== undefined
    && (!expectedFirstSequence || !previous || expectedFirstSequence.number !== previous.number + 1)) {
    issues.push(issue(
      "operator_expected_sequence_mismatch",
      "options.expectedFirstSequence",
      "expectedFirstSequence must be exactly previousSequence + 1.",
      [options.expectedFirstSequence, delta.previousSequence],
    ));
  }
  issues.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
  const nextSequence = previous
    ? String(previous.number + events.length)
    : "";
  return deepFreeze({
    complete: issues.length === 0,
    code: issues.length ? "OPERATOR_SOURCE_DELTA_INCOMPLETE" : "OPERATOR_SOURCE_DELTA_COMPLETE",
    capturedAt,
    previousSequence: previous?.string || "",
    nextSequence,
    eventCount: events.length,
    events,
    issues,
    mutatesOperationalState: false,
  });
}

function requireBuildOptions(input = {}) {
  if (!isPlainObject(input)) {
    throw new OperatorSourceDeltaError("Operator source delta options must be an object", {
      code: "OPERATOR_SOURCE_DELTA_INVALID_OPTIONS",
    });
  }
  const workspaceKey = text(input.workspaceKey || DEFAULT_WORKSPACE_KEY);
  const connectionKey = text(input.connectionKey);
  const extractorVersion = text(input.extractorVersion || DEFAULT_EXTRACTOR_VERSION);
  if (!workspaceKey || !connectionKey || !extractorVersion) {
    throw new OperatorSourceDeltaError("workspaceKey, connectionKey, and extractorVersion are required", {
      code: "OPERATOR_SOURCE_DELTA_INVALID_OPTIONS",
    });
  }
  return { workspaceKey, connectionKey, extractorVersion };
}

function buildOperatorSourceDelta(delta, inputOptions = {}) {
  const diagnostics = inspectOperatorSourceDelta(delta, inputOptions);
  if (!diagnostics.complete) {
    throw new OperatorSourceDeltaError("Operator delta is structurally incomplete; cursor commit is forbidden", {
      code: diagnostics.code,
      diagnostics,
    });
  }
  const options = requireBuildOptions(inputOptions);
  const observations = [];
  const jobs = [];
  const manifestEvents = [];
  for (const event of diagnostics.events) {
    const eventSequence = parseSequence(event.sequence).string;
    const normalizedPayload = canonicalize({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      capturedAt: diagnostics.capturedAt,
      event,
    });
    const contentHash = sha256(normalizedPayload);
    const sourceObjectId = event.eventId;
    const sourceRevision = `sequence:${eventSequence}`;
    const observationIdentity = {
      schemaVersion: "source-observation-identity-v1",
      workspaceKey: options.workspaceKey,
      sourceSystem: "operator",
      connectionKey: options.connectionKey,
      sourceObjectType: "operator_event",
      sourceObjectId,
      sourceRevision,
      operation: "content",
      contentHash,
    };
    const observationId = `obs:v1:${sha256(observationIdentity)}`;
    const observation = {
      observationId,
      sourceObjectType: observationIdentity.sourceObjectType,
      sourceObjectId,
      sourceRevision,
      operation: "content",
      contentHash,
      sourceRecordedAt: event.recordedAt,
      capturedAt: diagnostics.capturedAt,
      normalizedPayload,
      normalizedText: event.recordedSummary,
      sourceFidelity: "normalized_source",
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      retentionClass: "shipment-operations",
    };
    const jobKind = "operator_extract_claims";
    const dedupeKey = `operator:extract-claims:v1:${sha256({
      jobKind,
      observationId,
      extractorVersion: options.extractorVersion,
    })}`;
    const job = {
      dedupeKey,
      jobKind,
      observationId,
      sourceObjectId,
      maxAttempts: 5,
      payload: canonicalize({
        schemaVersion: JOB_SCHEMA_VERSION,
        sourceObservationId: observationId,
        eventId: sourceObjectId,
        eventSequence,
        contentHash,
        extractorVersion: options.extractorVersion,
      }),
    };
    observations.push(observation);
    jobs.push(job);
    manifestEvents.push({ eventId: sourceObjectId, sequence: eventSequence, observationId, contentHash });
  }
  observations.sort((left, right) => left.observationId.localeCompare(right.observationId));
  jobs.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
  const providerManifest = canonicalize({
    schemaVersion: DELTA_SCHEMA_VERSION,
    complete: true,
    upstreamWatermark: diagnostics.nextSequence,
    sourceSnapshotAt: diagnostics.capturedAt,
    recordCount: observations.length,
    previousSequence: diagnostics.previousSequence,
    nextSequence: diagnostics.nextSequence,
    eventManifestHash: sha256(manifestEvents),
    events: manifestEvents,
    appendOnly: true,
  });
  const payloadIdentity = sha256({
    nextCursorValue: diagnostics.nextSequence,
    providerManifest,
    observations,
    jobs,
  });
  return deepFreeze({
    sourceSystem: "operator",
    workspaceKey: options.workspaceKey,
    connectionKey: options.connectionKey,
    nextCursorValue: diagnostics.nextSequence,
    providerManifest,
    observations,
    jobs,
    payloadIdentity: `operator-source-delta:v1:${payloadIdentity}`,
    diagnostics,
    mutatesOperationalState: false,
    reducesTruth: false,
    publishesTruth: false,
  });
}

module.exports = Object.freeze({
  DEFAULT_EXTRACTOR_VERSION,
  DELTA_SCHEMA_VERSION,
  EVENT_ID_RE,
  EVENT_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  OperatorSourceDeltaError,
  buildOperatorSourceDelta,
  deriveOperatorEventId,
  inspectOperatorSourceDelta,
  _test: Object.freeze({ canonicalize, normalizeAwb, parseSequence, sha256, stableJson }),
});

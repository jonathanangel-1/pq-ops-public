"use strict";

// Pure extraction from append-only operator events. The extractor never reads
// free text to invent a fact: candidates are derived only from the structured,
// registry-pinned assertion and cite that exact immutable field. Contact,
// recorder, summary, timestamps, and correction/revocation linkage remain in
// the source observation reached by sourceObservationId/contentHash.

const crypto = require("node:crypto");
const { PREDICATES, REGISTRY: PREDICATE_REGISTRY } = require("./truth-predicate-registry");

const SCHEMA_VERSION = "operator-candidate-claim-v1";
const EXTRACTOR_VERSION = `operator-claim-extractor-v1+predicates:${PREDICATE_REGISTRY.registryHash}`;
const ACCEPTANCE_POLICY_VERSION = `operator-candidate-acceptance-v1+${PREDICATE_REGISTRY.registryVersion}`;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const EVENT_ID_RE = /^operator-event:v1:[0-9a-f]{64}$/;
const WORKGROUP_ID_RE = /^workgroup:v1:[0-9a-f]{64}$/;
const CLAIM_VERSION_ID_RE = /^claim:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POLARITIES = new Set(["positive", "negative", "requested", "neutral", "unknown"]);

class OperatorClaimExtractorError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "OperatorClaimExtractorError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new OperatorClaimExtractorError(`Invalid operator claim extraction ${field}: ${reason}`, {
    code: "OPERATOR_CLAIM_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw invalid(`${field}.${key}`, "is forbidden");
      if (value[key] !== undefined) output[key] = canonicalize(value[key], `${field}.${key}`);
    }
    return output;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function canonicalTimestamp(value) {
  const result = text(value);
  return TIMESTAMP_RE.test(result)
    && Number.isFinite(Date.parse(result))
    && new Date(result).toISOString() === result
    ? result
    : "";
}

function normalizeAwb(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits : "";
}

function eventIdentityPreimage(event) {
  if (!isPlainObject(event)) return event;
  const copy = { ...event };
  delete copy.eventId;
  return canonicalize(copy, "eventIdentity");
}

function expectedEventId(event) {
  return `operator-event:v1:${sha256Json(eventIdentityPreimage(event))}`;
}

function structuredSpan(path, value) {
  const canonicalValue = canonicalize(value, "evidenceValue");
  return {
    kind: "structured_field",
    path: [...path],
    valueHash: sha256Json(canonicalValue),
    valuePreview: text(typeof canonicalValue === "string" ? canonicalValue : stableJson(canonicalValue)).slice(0, 500),
  };
}

function normalizeObservation(value) {
  if (!isPlainObject(value)) throw invalid("observation", "must be an object");
  const observationId = text(value.observationId);
  if (!OBSERVATION_ID_RE.test(observationId)) throw invalid("observation.observationId", "must be obs:v1:<sha256>");
  if (value.sourceSystem !== "operator" || value.sourceObjectType !== "operator_event") {
    throw invalid("observation.source", "must be an operator event");
  }
  if (value.operation !== undefined && value.operation !== "content") {
    throw invalid("observation.operation", "must equal content");
  }
  const contentHash = text(value.contentHash);
  if (!HASH_RE.test(contentHash)) throw invalid("observation.contentHash", "must be lowercase SHA-256 hex");
  const normalizedPayload = canonicalize(value.normalizedPayload, "observation.normalizedPayload");
  if (normalizedPayload?.schemaVersion !== "operator-event-source-observation-v1"
    || !isPlainObject(normalizedPayload.event)) {
    throw invalid("observation.normalizedPayload", "must be an operator-event-source-observation-v1 payload");
  }
  if (sha256Json(normalizedPayload) !== contentHash) {
    throw invalid("observation.contentHash", "does not match the immutable normalized payload");
  }
  const event = normalizedPayload.event;
  if (text(value.sourceObjectId) !== text(event.eventId)) {
    throw invalid("observation.sourceObjectId", "must equal event.eventId");
  }
  return deepFreeze({
    observationId,
    contentHash,
    sourceObjectId: text(value.sourceObjectId),
    capturedAt: canonicalTimestamp(value.capturedAt || normalizedPayload.capturedAt),
    normalizedPayload,
    event,
  });
}

function normalizeAcceptedClaims(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("acceptedClaims", "must be an array");
  return value.map((claim, index) => {
    if (!isPlainObject(claim)) throw invalid(`acceptedClaims[${index}]`, "must be an object");
    const claimVersionId = text(claim.claimVersionId);
    if (!CLAIM_VERSION_ID_RE.test(claimVersionId)) throw invalid(`acceptedClaims[${index}].claimVersionId`, "is invalid");
    const versionNo = Number(claim.versionNo);
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) throw invalid(`acceptedClaims[${index}].versionNo`, "must be positive");
    return {
      claimVersionId,
      claimKey: text(claim.claimKey),
      versionNo,
      polarity: text(claim.polarity),
      normalizedValue: canonicalize(claim.normalizedValue || {}),
    };
  });
}

function assessOperatorObservation(input) {
  const observation = normalizeObservation(input);
  const event = observation.event;
  const assertion = isPlainObject(event.assertion) ? event.assertion : null;
  if (!assertion) {
    return deepFreeze({
      candidateSafe: false,
      reviewRequired: true,
      noStructuredAssertion: true,
      reasons: ["structured assertion is absent; free text cannot produce operator truth"],
      observation,
    });
  }
  const predicate = text(assertion.predicate);
  const polarity = text(assertion.polarity);
  const policy = PREDICATES[predicate];
  const contractSafe = Boolean(policy && POLARITIES.has(polarity) && isPlainObject(assertion.value)
    && assertion.value.status === policy.statuses[polarity]
    && assertion.value.effect === policy.effects[polarity]);
  if (!contractSafe) {
    return deepFreeze({
      candidateSafe: false,
      reviewRequired: true,
      noStructuredAssertion: false,
      reasons: ["structured assertion is outside the predicate/polarity/status/effect contract"],
      observation,
      predicate,
      polarity,
    });
  }
  const reasons = [];
  const eventId = text(event.eventId);
  if (!EVENT_ID_RE.test(eventId) || expectedEventId(event) !== eventId) reasons.push("immutable event identity is incomplete");
  const contact = isPlainObject(event.contact) ? event.contact : {};
  if (!text(contact.name) || !text(contact.organization)) reasons.push("contact name or organization is incomplete");
  const recordedBy = isPlainObject(event.recordedBy) ? event.recordedBy : {};
  if (!text(recordedBy.operatorId) || !text(recordedBy.name)) reasons.push("operator recorder provenance is incomplete");
  const occurredAt = canonicalTimestamp(event.occurredAt);
  const recordedAt = canonicalTimestamp(event.recordedAt);
  if (!occurredAt || !recordedAt || Date.parse(occurredAt) > Date.parse(recordedAt)) reasons.push("event timestamps are incomplete or inconsistent");
  if (assertion.contractVersion !== PREDICATE_REGISTRY.registryVersion) reasons.push("predicate contract version is incomplete or stale");
  const summary = typeof event.recordedSummary === "string" ? event.recordedSummary : "";
  if (!summary || summary.trim() !== summary || !/^(?:I|We)\b/.test(summary)) reasons.push("exact first-person recorded summary is incomplete");
  const subject = isPlainObject(event.subject) ? event.subject : {};
  const awbs = Array.isArray(subject.awbs)
    ? subject.awbs.map(normalizeAwb).filter(Boolean).sort()
    : [];
  if (!awbs.length || new Set(awbs).size !== awbs.length) reasons.push("AWB membership is empty, invalid, or duplicated");
  if (subject.type === "shipment" && awbs.length !== 1) reasons.push("shipment scope does not contain exactly one AWB");
  if (subject.type === "workgroup") {
    if (!WORKGROUP_ID_RE.test(text(subject.workgroupKey))) reasons.push("workgroup identity is incomplete");
    if (subject.membershipComplete !== true) reasons.push("workgroup member list is not explicitly complete");
  } else if (subject.type !== "shipment") {
    reasons.push("subject scope is incomplete");
  }
  const eventType = text(event.eventType);
  if (["correction", "revocation"].includes(eventType)) {
    const relation = isPlainObject(event.relatedEvent) ? event.relatedEvent : {};
    const expectedRelation = eventType === "correction" ? "corrects" : "revokes";
    const sequence = Number(event.sequence);
    const priorSequence = Number(relation.sequence);
    if (relation.relation !== expectedRelation || !EVENT_ID_RE.test(text(relation.eventId))
      || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(priorSequence)
      || priorSequence >= sequence || relation.eventId === eventId) {
      reasons.push(`${eventType} does not link an earlier immutable event`);
    }
  } else if (eventType !== "assertion") {
    reasons.push("operator event type is incomplete");
  }
  if (eventType === "revocation" && polarity !== "unknown") {
    reasons.push("revocation must append an explicit unknown assertion");
  }
  const candidateShapeSafe = awbs.length > 0
    && (subject.type === "shipment" || (subject.type === "workgroup" && WORKGROUP_ID_RE.test(text(subject.workgroupKey))));
  return deepFreeze({
    candidateSafe: candidateShapeSafe,
    reviewRequired: reasons.length > 0,
    noStructuredAssertion: false,
    reasons,
    observation,
    predicate,
    polarity,
    policy,
    assertion,
    subject,
    awbs,
    occurredAt: occurredAt || null,
  });
}

function contradictionFor(assessment, acceptedClaims, claimKey) {
  const relevant = acceptedClaims.filter((claim) => claim.claimKey === claimKey);
  const duplicate = relevant.filter((claim) => claim.polarity === assessment.polarity
    && stableJson(claim.normalizedValue) === stableJson(assessment.assertion.value));
  const opposite = relevant.filter((claim) => (
    (claim.polarity === "positive" && assessment.polarity === "negative")
    || (claim.polarity === "negative" && assessment.polarity === "positive")
  ));
  if (duplicate.length) return { duplicate: true, status: "none", ids: duplicate.map((item) => item.claimVersionId).sort() };
  if (opposite.length) return { duplicate: false, status: "known", ids: opposite.map((item) => item.claimVersionId).sort() };
  return { duplicate: false, status: "none", ids: [] };
}

function finalizeAssessment(assessment, acceptedClaims) {
  const { observation, subject, awbs, predicate, polarity, policy, assertion } = assessment;
  const subjectType = subject.type;
  const subjectKey = subjectType === "shipment" ? awbs[0] : text(subject.workgroupKey);
  const claimKey = `${subjectType}:${subjectKey}:${predicate}`;
  const chain = acceptedClaims.filter((claim) => claim.claimKey === claimKey)
    .sort((left, right) => left.versionNo - right.versionNo);
  const previous = chain.at(-1) || null;
  const contradiction = contradictionFor(assessment, acceptedClaims, claimKey);
  const reasons = [...assessment.reasons];
  if (contradiction.status === "known") reasons.push("candidate conflicts with accepted evidence");
  let decision = reasons.length ? "review" : "accept";
  let method = reasons.length ? "operator" : "policy";
  let decisionReasons = reasons.length
    ? reasons
    : ["complete append-only operator event passed the pinned structured-assertion policy"];
  if (contradiction.duplicate) {
    decision = "reject";
    method = "operator";
    decisionReasons = ["equivalent accepted claim already exists"];
  }
  const base = {
    schemaVersion: SCHEMA_VERSION,
    claimKey,
    versionNo: (previous?.versionNo || 0) + 1,
    previousClaimVersionId: previous?.claimVersionId || null,
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    sourceObjectType: "operator_event",
    sourceObjectId: observation.sourceObjectId,
    sourceCapturedAt: observation.capturedAt || null,
    subjectType,
    subjectKey,
    appliesToAwbs: awbs,
    predicate,
    gate: policy.gate,
    polarity,
    normalizedValue: canonicalize(assertion.value, "assertion.value"),
    occurredAt: assessment.occurredAt,
    confidence: 1,
    confidenceLabel: "high",
    evidenceSpan: structuredSpan(["event", "assertion"], assertion),
    extractionMethod: "deterministic",
    extractorVersion: EXTRACTOR_VERSION,
    model: "",
    promptVersion: "",
    ambiguity: {
      status: assessment.reviewRequired ? "review" : "none",
      reasons: [...assessment.reasons],
    },
    contradiction: {
      status: contradiction.status,
      acceptedClaimVersionIds: contradiction.ids,
      reasons: contradiction.status === "known" ? ["accepted evidence asserts the opposite polarity"] : [],
    },
    acceptanceRecommendation: {
      decision,
      method,
      policyVersion: ACCEPTANCE_POLICY_VERSION,
      reasons: decisionReasons,
    },
  };
  const candidateHash = sha256Json(base);
  return deepFreeze({
    candidateClaimVersionId: `candidate:v1:${candidateHash}`,
    candidateHash,
    ...base,
  });
}

function createOperatorClaimExtractor(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  async function extract(input = {}) {
    if (!isPlainObject(input)) throw invalid("input", "must be an object");
    const assessment = assessOperatorObservation(input.observation);
    if (!assessment.candidateSafe) return deepFreeze([]);
    const acceptedClaims = normalizeAcceptedClaims(input.acceptedClaims);
    return deepFreeze([finalizeAssessment(assessment, acceptedClaims)]);
  }
  return Object.freeze({ extract });
}

module.exports = Object.freeze({
  ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION,
  SCHEMA_VERSION,
  OperatorClaimExtractorError,
  assessOperatorObservation,
  createOperatorClaimExtractor,
  _test: Object.freeze({
    canonicalize,
    expectedEventId,
    normalizeObservation,
    sha256Json,
    stableJson,
    structuredSpan,
  }),
});

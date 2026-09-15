"use strict";

// Pure, deterministic extraction from immutable tracking observations. Only
// exact official-carrier event codes can produce candidates. Flight-search
// snippets, no-result rows, and provider failures remain source evidence and
// source-health only.

const crypto = require("node:crypto");
const { PREDICATES, REGISTRY: PREDICATE_REGISTRY } = require("./truth-predicate-registry");

const SCHEMA_VERSION = "tracking-candidate-claim-v1";
const EXTRACTOR_VERSION = `tracking-claim-extractor-v1+predicates:${PREDICATE_REGISTRY.registryHash}`;
const ACCEPTANCE_POLICY_VERSION = `tracking-candidate-acceptance-v1+${PREDICATE_REGISTRY.registryVersion}`;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const CLAIM_VERSION_ID_RE = /^claim:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ARRIVAL_CODES = new Set(["ARR", "RCF", "AWD"]);
const MOVEMENT_CODES = new Set(["DEP", "IN_TRANSIT", "IN-TRANSIT", "IN TRANSIT"]);
const FORBIDDEN_COMPLETION_CODES = new Set(["DLV", "DELIVERED", "POD", "AIRPORT_RELEASE", "RELEASED"]);

class TrackingClaimExtractorError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TrackingClaimExtractorError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TrackingClaimExtractorError(`Invalid tracking claim extraction ${field}: ${reason}`, {
    code: "TRACKING_CLAIM_INVALID_ARGUMENT",
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

function normalizeAwb(value, field = "awb") {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 11) throw invalid(field, "must contain exactly eleven digits");
  return digits;
}

function normalizeTimestamp(value, field) {
  const raw = text(value);
  // Preserve the ledger's exact timestamp text. A Date round-trip truncates
  // Postgres microseconds to milliseconds and the candidate seal then refuses
  // the binding — the same class fixed for the Gmail lane in 20260717070000
  // and for the TMS extractor.
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
    || !Number.isFinite(Date.parse(raw))) {
    throw invalid(field, "must be a canonical UTC timestamp with millisecond precision");
  }
  return raw;
}

function structuredSpan(path, value) {
  if (!Array.isArray(path) || !path.length || path.some((item) => typeof item !== "string" || !item)) {
    throw invalid("evidencePath", "must be a non-empty string array");
  }
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
  if (value.sourceSystem !== "tracking" || value.sourceObjectType !== "tracking_shipment_snapshot") {
    throw invalid("observation.source", "must be a tracking shipment snapshot");
  }
  if (value.operation !== undefined && value.operation !== "content") {
    throw invalid("observation.operation", "must equal content");
  }
  const contentHash = text(value.contentHash);
  if (!HASH_RE.test(contentHash)) throw invalid("observation.contentHash", "must be lowercase SHA-256 hex");
  const normalizedPayload = canonicalize(value.normalizedPayload, "observation.normalizedPayload");
  if (normalizedPayload?.schemaVersion !== "tracking-source-observation-v1"
    || !isPlainObject(normalizedPayload.tracking)
    || !isPlainObject(normalizedPayload.provenance)
    || !isPlainObject(normalizedPayload.sourceHealth)) {
    throw invalid("observation.normalizedPayload", "must be a tracking-source-observation-v1 payload");
  }
  if (sha256Json(normalizedPayload) !== contentHash) {
    throw invalid("observation.contentHash", "does not match the immutable normalized payload");
  }
  const snapshotTime = normalizeTimestamp(normalizedPayload.snapshotTime, "observation.normalizedPayload.snapshotTime");
  const awb = normalizeAwb(normalizedPayload.awb, "observation.normalizedPayload.awb");
  const sourceObjectId = text(value.sourceObjectId);
  if (sourceObjectId !== awb) throw invalid("observation.sourceObjectId", "must equal the normalized AWB");
  const capturedAt = normalizeTimestamp(value.capturedAt || snapshotTime, "observation.capturedAt");
  return deepFreeze({
    observationId,
    contentHash,
    sourceObjectId,
    normalizedPayload,
    tracking: normalizedPayload.tracking,
    provenance: normalizedPayload.provenance,
    sourceHealth: normalizedPayload.sourceHealth,
    snapshotTime,
    capturedAt,
    awb,
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

function providerEvent(observation) {
  const tracking = observation.tracking;
  const latest = isPlainObject(tracking.latestEvent) ? tracking.latestEvent : {};
  const candidates = [
    { value: latest.code, path: ["tracking", "latestEvent", "code"], event: latest },
    { value: tracking.summaryCode, path: ["tracking", "summaryCode"], event: latest },
    { value: tracking.status, path: ["tracking", "status"], event: latest },
  ];
  const selected = candidates.find((item) => text(item.value));
  if (!selected) return null;
  return {
    code: text(selected.value).toUpperCase().replace(/\s+/g, " "),
    path: selected.path,
    event: selected.event,
  };
}

function assessTrackingObservation(input) {
  const observation = normalizeObservation(input);
  const event = providerEvent(observation);
  const reasons = [];
  if (observation.sourceHealth.positiveEvidenceEligible !== true) {
    reasons.push(`source health is ${text(observation.sourceHealth.status) || "unknown"}`);
  }
  if (observation.provenance.sourceKind !== "official_carrier_tracking") {
    reasons.push("source is flight-status research rather than direct carrier tracking");
  }
  if (!text(observation.provenance.url) || !text(observation.provenance.title) || !text(observation.provenance.status)) {
    reasons.push("direct provider URL/title/status provenance is incomplete");
  }
  if (!event) reasons.push("no explicit provider event code exists");
  const code = event?.code || "";
  let semanticClass = "context_only";
  if (ARRIVAL_CODES.has(code)) semanticClass = "arrival_or_availability";
  if (MOVEMENT_CODES.has(code)) semanticClass = "movement";
  if (FORBIDDEN_COMPLETION_CODES.has(code)) semanticClass = "airport_or_provider_completion_only";
  return deepFreeze({
    eligible: reasons.length === 0 && (ARRIVAL_CODES.has(code) || MOVEMENT_CODES.has(code)),
    awb: observation.awb,
    eventCode: code,
    semanticClass,
    reasons,
    observation,
    event,
  });
}

function draftFromAssessment(assessment) {
  const { observation, event } = assessment;
  const eventCode = event.code;
  const isArrival = ARRIVAL_CODES.has(eventCode);
  if (!isArrival && !MOVEMENT_CODES.has(eventCode)) return null;
  const predicate = isArrival ? "arrival_confirmed" : "transport_in_transit";
  const policy = PREDICATES[predicate];
  return {
    predicate,
    gate: policy.gate,
    polarity: "positive",
    normalizedValue: {
      status: policy.statuses.positive,
      effect: policy.effects.positive,
      sourceClass: "tracking",
      responsibleActor: "carrier_tracking",
      evidenceDirectness: "direct_provider_event",
      carrier: text(observation.normalizedPayload.carrier),
      eventCode,
      eventDescription: text(event.event.description),
      station: text(event.event.station),
      eventTimeLocal: text(event.event.timeLocal),
    },
    evidenceSpan: structuredSpan(event.path, event.event.code || eventCode),
    confidence: isArrival ? 0.96 : 0.95,
  };
}

function contradictionFor(draft, acceptedClaims, claimKey) {
  const relevant = acceptedClaims.filter((claim) => claim.claimKey === claimKey);
  const duplicate = relevant.filter((claim) => claim.polarity === draft.polarity
    && stableJson(claim.normalizedValue) === stableJson(draft.normalizedValue));
  const opposite = relevant.filter((claim) => (
    (claim.polarity === "positive" && draft.polarity === "negative")
    || (claim.polarity === "negative" && draft.polarity === "positive")
  ));
  if (duplicate.length) return { duplicate: true, status: "none", ids: duplicate.map((item) => item.claimVersionId).sort() };
  if (opposite.length) return { duplicate: false, status: "known", ids: opposite.map((item) => item.claimVersionId).sort() };
  return { duplicate: false, status: "none", ids: [] };
}

function finalizeDraft(draft, observation, acceptedClaims) {
  const claimKey = `shipment:${observation.awb}:${draft.predicate}`;
  const chain = acceptedClaims.filter((claim) => claim.claimKey === claimKey)
    .sort((left, right) => left.versionNo - right.versionNo);
  const previous = chain.at(-1) || null;
  const contradiction = contradictionFor(draft, acceptedClaims, claimKey);
  let decision = "accept";
  let method = "policy";
  let reasons = ["exact direct-carrier event code passed the pinned tracking policy"];
  if (contradiction.duplicate) {
    decision = "reject";
    method = "operator";
    reasons = ["equivalent accepted claim already exists"];
  } else if (contradiction.status === "known") {
    decision = "review";
    method = "operator";
    reasons = ["candidate conflicts with accepted evidence"];
  }
  const base = {
    schemaVersion: SCHEMA_VERSION,
    claimKey,
    versionNo: (previous?.versionNo || 0) + 1,
    previousClaimVersionId: previous?.claimVersionId || null,
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    sourceObjectType: "tracking_shipment_snapshot",
    sourceObjectId: observation.sourceObjectId,
    sourceCapturedAt: observation.capturedAt,
    subjectType: "shipment",
    subjectKey: observation.awb,
    appliesToAwbs: [observation.awb],
    predicate: draft.predicate,
    gate: draft.gate,
    polarity: draft.polarity,
    normalizedValue: draft.normalizedValue,
    occurredAt: null,
    confidence: draft.confidence,
    confidenceLabel: "high",
    evidenceSpan: draft.evidenceSpan,
    extractionMethod: "deterministic",
    extractorVersion: EXTRACTOR_VERSION,
    model: "",
    promptVersion: "",
    ambiguity: { status: "none", reasons: [] },
    contradiction: {
      status: contradiction.status,
      acceptedClaimVersionIds: contradiction.ids,
      reasons: contradiction.status === "known" ? ["accepted evidence asserts the opposite polarity"] : [],
    },
    acceptanceRecommendation: {
      decision,
      method,
      policyVersion: ACCEPTANCE_POLICY_VERSION,
      reasons,
    },
  };
  const candidateHash = sha256Json(base);
  return deepFreeze({
    candidateClaimVersionId: `candidate:v1:${candidateHash}`,
    candidateHash,
    ...base,
  });
}

function createTrackingClaimExtractor(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  async function extract(input = {}) {
    if (!isPlainObject(input)) throw invalid("input", "must be an object");
    const assessment = assessTrackingObservation(input.observation);
    if (!assessment.eligible) return deepFreeze([]);
    const draft = draftFromAssessment(assessment);
    if (!draft) return deepFreeze([]);
    const acceptedClaims = normalizeAcceptedClaims(input.acceptedClaims);
    return deepFreeze([finalizeDraft(draft, assessment.observation, acceptedClaims)]);
  }
  return Object.freeze({ extract });
}

module.exports = Object.freeze({
  ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION,
  SCHEMA_VERSION,
  TrackingClaimExtractorError,
  assessTrackingObservation,
  createTrackingClaimExtractor,
  _test: Object.freeze({
    ARRIVAL_CODES,
    FORBIDDEN_COMPLETION_CODES,
    MOVEMENT_CODES,
    canonicalize,
    normalizeObservation,
    providerEvent,
    sha256Json,
    stableJson,
    structuredSpan,
  }),
});

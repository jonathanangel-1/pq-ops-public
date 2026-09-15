"use strict";

const crypto = require("node:crypto");
const {
  REGISTRY: PREDICATE_REGISTRY,
  TMS_PREDICATES: PREDICATES,
} = require("./truth-predicate-registry");
const { resolveTemporalExpression } = require("./truth-temporal-resolver");

const SCHEMA_VERSION = "tms-candidate-claim-v1";
const EXTRACTOR_VERSION = `tms-claim-extractor-v1+predicates:${PREDICATE_REGISTRY.registryHash}`;
const ACCEPTANCE_POLICY_VERSION = `tms-candidate-acceptance-v1+${PREDICATE_REGISTRY.registryVersion}`;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const CLAIM_VERSION_ID_RE = /^claim:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

class TmsClaimExtractorError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TmsClaimExtractorError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TmsClaimExtractorError(`Invalid TMS claim extraction ${field}: ${reason}`, {
    code: "TMS_CLAIM_INVALID_ARGUMENT",
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
  for (const item of Object.values(value)) deepFreeze(item);
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
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw invalid(field, "must be a timestamp");
  // Preserve the ledger's exact timestamp text. A Date round-trip truncates
  // Postgres microseconds to milliseconds and the candidate seal then refuses:
  // "candidate source capture time does not match the observation" — the same
  // binding class fixed for the Gmail lane in 20260717070000.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    return raw;
  }
  return new Date(timestamp).toISOString();
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
  if (value.sourceSystem !== "tms" || value.sourceObjectType !== "tms_shipment_snapshot") {
    throw invalid("observation.source", "must be a TMS shipment snapshot");
  }
  if (value.operation !== undefined && value.operation !== "content") {
    throw invalid("observation.operation", "must equal content");
  }
  const contentHash = text(value.contentHash);
  if (!HASH_RE.test(contentHash)) throw invalid("observation.contentHash", "must be lowercase SHA-256 hex");
  const normalizedPayload = canonicalize(value.normalizedPayload, "observation.normalizedPayload");
  if (normalizedPayload?.schemaVersion !== "tms-shipment-source-observation-v1"
    || !isPlainObject(normalizedPayload.shipment)) {
    throw invalid("observation.normalizedPayload", "must be a tms-shipment-source-observation-v1 payload");
  }
  if (sha256Json(normalizedPayload) !== contentHash) {
    throw invalid("observation.contentHash", "does not match the immutable normalized payload");
  }
  const snapshotTime = normalizeTimestamp(normalizedPayload.snapshotTime, "observation.normalizedPayload.snapshotTime");
  const shipment = normalizedPayload.shipment;
  const sourceObjectId = text(value.sourceObjectId || shipment.shipmentGuid).toLowerCase();
  if (!sourceObjectId || sourceObjectId !== text(shipment.shipmentGuid).toLowerCase()) {
    throw invalid("observation.sourceObjectId", "must match shipmentGuid");
  }
  const awb = normalizeAwb(shipment.trackingNumber, "observation.normalizedPayload.shipment.trackingNumber");
  const capturedAt = normalizeTimestamp(value.capturedAt || snapshotTime, "observation.capturedAt");
  return deepFreeze({ observationId, contentHash, normalizedPayload, snapshotTime, shipment, sourceObjectId, awb, capturedAt });
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
      subjectType: text(claim.subjectType),
      subjectKey: text(claim.subjectKey),
      predicate: text(claim.predicate),
      polarity: text(claim.polarity),
      normalizedValue: canonicalize(claim.normalizedValue || {}),
    };
  });
}

function statusRuleDrafts(observation) {
  const status = text(observation.shipment.tmsStatus || observation.shipment.status);
  const normalized = status.toUpperCase();
  const drafts = [];
  const baseValue = {
    sourceClass: "tms",
    responsibleActor: "automated_system",
    evidenceDirectness: "operational_summary",
    tmsStatus: status,
    statusCode: Number(normalized.match(/^(\d{3})/)?.[1] || 0) || null,
  };
  const statusSpan = structuredSpan(["shipment", observation.shipment.tmsStatus ? "tmsStatus" : "status"], status);
  const arrivalProven = /\b(?:280-ARR@DEST|ARR@DEST|ARRIVED?\s+AT\s+DEST|295-CUSTOMS\s+REL|CUSTOMS\s+REL|320-OUT\s+FOR\s+DEL|OUT\s+FOR\s+DEL(?:IVERY)?)\b/i.test(status);
  if (arrivalProven) {
    drafts.push({
      predicate: "arrival_confirmed",
      gate: "arrival",
      polarity: "positive",
      normalizedValue: { ...baseValue, status: PREDICATES.arrival_confirmed.statuses.positive, effect: "complete" },
      evidenceSpan: statusSpan,
      confidence: 0.94,
      reviewOnly: false,
      ambiguityReasons: [],
    });
  }
  if (/\b(?:320-OUT\s+FOR\s+DEL|OUT\s+FOR\s+DEL(?:IVERY)?|OFD)\b/i.test(status)) {
    drafts.push({
      predicate: "out_for_delivery",
      gate: "delivery",
      polarity: "positive",
      normalizedValue: { ...baseValue, status: PREDICATES.out_for_delivery.statuses.positive, effect: "context" },
      evidenceSpan: statusSpan,
      confidence: 0.95,
      reviewOnly: false,
      ambiguityReasons: [],
    });
  }
  if (/\b(?:240-DROPPED@A\/L|DROPPED\s*(?:AT|@)\s*(?:THE\s+)?A\/L|270-INTRANSIT|IN[-\s]?TRANSIT|275-CONF\s+ONBOAR|CONF(?:IRMED)?\s+ON\s*BOARD)\b/i.test(status)) {
    drafts.push({
      predicate: "transport_in_transit",
      gate: "arrival",
      polarity: "positive",
      normalizedValue: { ...baseValue, status: PREDICATES.transport_in_transit.statuses.positive, effect: "context" },
      evidenceSpan: statusSpan,
      confidence: 0.95,
      reviewOnly: false,
      ambiguityReasons: [],
    });
  }
  return drafts;
}

function inventoryPresenceDraft(observation) {
  const statusField = observation.shipment.tmsStatus ? "tmsStatus" : "status";
  const status = text(observation.shipment[statusField]);
  if (!status) {
    throw invalid(
      `observation.normalizedPayload.shipment.${statusField}`,
      "must be non-empty before the TMS row can enter an accepted source cut",
    );
  }
  const normalized = status.toUpperCase();
  return {
    predicate: "shipment_observed_in_tms",
    gate: "context",
    polarity: "neutral",
    normalizedValue: {
      status: PREDICATES.shipment_observed_in_tms.statuses.neutral,
      effect: PREDICATES.shipment_observed_in_tms.effects.neutral,
      sourceClass: "tms",
      responsibleActor: "automated_system",
      evidenceDirectness: "operational_summary",
      tmsStatus: status,
      statusCode: Number(normalized.match(/^(\d{3})/)?.[1] || 0) || null,
    },
    evidenceSpan: structuredSpan(["shipment", statusField], status),
    confidence: 1,
    reviewOnly: false,
    ambiguityReasons: [],
  };
}

function explicitFieldDrafts(observation, dateOrder) {
  const shipment = observation.shipment;
  const drafts = [];
  const addSensitive = ({ predicate, gate, fieldName, value, status, effect, extra = {} }) => {
    if (!text(value)) return;
    const temporal = resolveTemporalExpression({
      text: text(value),
      messageDate: observation.snapshotTime,
      capturedAt: observation.capturedAt,
      effect,
      dateOrder,
    });
    drafts.push({
      predicate,
      gate,
      polarity: "positive",
      normalizedValue: {
        status,
        effect,
        sourceClass: "tms",
        responsibleActor: "automated_system",
        evidenceDirectness: "direct_system_event",
        tmsField: fieldName,
        tmsFieldValue: text(value),
        ...(temporal.status !== "none" ? {
          temporal: {
            resolverVersion: temporal.resolverVersion,
            status: temporal.status,
            occurredOn: temporal.occurredOn,
            basis: temporal.basis,
            expression: temporal.expression,
            confidence: temporal.confidence,
          },
        } : {}),
        ...extra,
      },
      occurredAt: temporal.occurredAt,
      evidenceSpan: structuredSpan(["shipment", fieldName], value),
      confidence: 0.9,
      reviewOnly: true,
      ambiguityReasons: ["TMS actual-state fields require cross-source or operator validation before promotion"],
    });
  };
  addSensitive({
    predicate: "customs_release",
    gate: "customs",
    fieldName: "customsActualRelease",
    value: shipment.customsActualRelease,
    status: PREDICATES.customs_release.statuses.positive,
    effect: "complete",
  });
  addSensitive({
    predicate: "delivery_completed",
    gate: "delivery",
    fieldName: "deliveryActualArrivalDate",
    value: shipment.deliveryActualArrivalDate,
    status: PREDICATES.delivery_completed.statuses.positive,
    effect: "complete",
    extra: { deliveryActualArrivalTime: text(shipment.deliveryActualArrivalTime) },
  });
  addSensitive({
    predicate: "pod_received",
    gate: "pod",
    fieldName: "podSignature",
    value: shipment.podSignature,
    status: PREDICATES.pod_received.statuses.positive,
    effect: "complete",
  });
  return drafts;
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
  let decision = draft.reviewOnly ? "review" : "accept";
  let reasons = draft.reviewOnly
    ? ["sensitive TMS completion fields require cross-source or operator validation"]
    : ["exact TMS status mapping passed the versioned deterministic source policy"];
  if (contradiction.duplicate) {
    decision = "reject";
    reasons = ["equivalent accepted claim already exists"];
  } else if (contradiction.status === "known") {
    decision = "review";
    reasons = ["candidate conflicts with accepted evidence"];
  }
  const base = {
    schemaVersion: SCHEMA_VERSION,
    claimKey,
    versionNo: (previous?.versionNo || 0) + 1,
    previousClaimVersionId: previous?.claimVersionId || null,
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    sourceObjectType: "tms_shipment_snapshot",
    sourceObjectId: observation.sourceObjectId,
    sourceCapturedAt: observation.capturedAt,
    subjectType: "shipment",
    subjectKey: observation.awb,
    appliesToAwbs: [observation.awb],
    predicate: draft.predicate,
    gate: draft.gate,
    polarity: draft.polarity,
    normalizedValue: draft.normalizedValue,
    occurredAt: draft.occurredAt || null,
    confidence: draft.confidence,
    confidenceLabel: draft.confidence >= 0.9 ? "high" : "medium",
    evidenceSpan: draft.evidenceSpan,
    extractionMethod: "deterministic",
    extractorVersion: EXTRACTOR_VERSION,
    model: "",
    promptVersion: "",
    ambiguity: {
      status: draft.ambiguityReasons.length ? "review" : "none",
      reasons: [...draft.ambiguityReasons],
    },
    contradiction: {
      status: contradiction.status,
      acceptedClaimVersionIds: contradiction.ids,
      reasons: contradiction.status === "known" ? ["accepted evidence asserts the opposite polarity"] : [],
    },
    acceptanceRecommendation: {
      decision,
      method: decision === "accept" ? "policy" : "operator",
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

function createTmsClaimExtractor(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const dateOrder = String(options.dateOrder ?? "MDY").toUpperCase();
  if (!["MDY", "DMY"].includes(dateOrder)) throw invalid("options.dateOrder", "must be MDY or DMY");
  async function extract(input = {}) {
    if (!isPlainObject(input)) throw invalid("input", "must be an object");
    const observation = normalizeObservation(input.observation);
    const acceptedClaims = normalizeAcceptedClaims(input.acceptedClaims);
    const drafts = [
      inventoryPresenceDraft(observation),
      ...statusRuleDrafts(observation),
      ...explicitFieldDrafts(observation, dateOrder),
    ];
    const unique = new Map();
    for (const draft of drafts) {
      const key = sha256Json({
        predicate: draft.predicate,
        normalizedValue: draft.normalizedValue,
        evidenceSpan: draft.evidenceSpan,
      });
      if (!unique.has(key)) unique.set(key, draft);
    }
    return deepFreeze([...unique.values()]
      .map((draft) => finalizeDraft(draft, observation, acceptedClaims))
      .sort((left, right) => left.predicate.localeCompare(right.predicate)
        || left.candidateClaimVersionId.localeCompare(right.candidateClaimVersionId)));
  }
  return Object.freeze({ extract });
}

module.exports = {
  ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION,
  SCHEMA_VERSION,
  TmsClaimExtractorError,
  createTmsClaimExtractor,
  _test: {
    canonicalize,
    normalizeAwb,
    normalizeObservation,
    inventoryPresenceDraft,
    sha256Json,
    stableJson,
    statusRuleDrafts,
    structuredSpan,
  },
};

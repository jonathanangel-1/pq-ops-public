"use strict";

const crypto = require("node:crypto");
const {
  DEFAULT_POLICY,
  claimEventTime: precedenceEventTime,
  compareClaimPriority: compareByPrecedencePolicy,
  explainPriority,
  priorityVector,
  validatePolicy,
} = require("./truth-precedence-policy");
const { normalizeShipmentMetadataEnvelopes } = require("./truth-shipment-metadata");
const {
  CommercialConversationContractError,
  deriveCommercialConversation,
} = require("./commercial-conversation-contract");

const REDUCER_VERSION = "relational-truth-reducer-v3.1-commercial-legacy-value-exclusion";
const PACKET_SCHEMA_VERSION = "relational-shipment-truth-packet-v3-commercial-conversation";
const SHA256_RE = /^[0-9a-f]{64}$/;

// Compatibility export only. Resolution itself is driven by the complete,
// versioned policy artifact rather than this one-dimensional view.
const EVIDENCE_PRECEDENCE = DEFAULT_POLICY.sourceClasses;

const MILESTONE_GATES = Object.freeze([
  "arrival",
  "customs",
  "fees",
  "dispatch",
  "pickup",
  "delivery",
  "pod",
]);

const GATE_ALIASES = Object.freeze({
  arrived: "arrival",
  arrival: "arrival",
  available: "arrival",
  customs: "customs",
  customs_release: "customs",
  customs_released: "customs",
  release: "customs",
  fees: "fees",
  station_fees: "fees",
  station_paid: "fees",
  broker: "dispatch",
  broker_awarded: "dispatch",
  dispatch: "dispatch",
  pickup: "pickup",
  picked_up: "pickup",
  delivery: "delivery",
  delivered: "delivery",
  pod: "pod",
  pod_received: "pod",
  context: "context",
});

const REQUEST_OR_PLAN_PATTERN = /(?:^|_)(?:request(?:ed)?|plan(?:ned)?|schedule(?:d)?|expected|intent|future|ask(?:ed)?|quote_needed|follow_up)(?:_|$)/i;
const BLOCKING_PREDICATE_PATTERN = /(?:not_arrived|arrival_unconfirmed|cargo_not_found|customs_hold|release_missing|not_released|fees?_due|payment_missing|broker_missing|dispatch_blocked|pickup_blocked|not_picked_up|delivery_blocked|wrong_consignee|not_delivered|pod_missing|pod_not_received|exception)/i;
const COMPLETION_PREDICATE_PATTERN = /(?:arrival_confirmed|arrived|on_hand|available_confirmed|customs_release|released|fees?_paid|payment_received|broker_awarded|broker_confirmed|dispatch_confirmed|pickup_completed|picked_up|loaded|out_for_delivery|delivery_completed|delivered|pod_received|proof_of_delivery_received|closed)/i;

class RelationalTruthReducerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "RelationalTruthReducerError";
    this.code = fields.code || "RELATIONAL_TRUTH_REDUCER_FAILED";
    this.field = fields.field || "";
    this.cause = fields.cause || this.cause;
  }
}

function invalidArgument(field, reason, code = "RELATIONAL_TRUTH_REDUCER_INVALID_ARGUMENT") {
  return new RelationalTruthReducerError(`Invalid relational truth bundle ${field}: ${reason}`, {
    code,
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArgument("canonicalValue", "contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw invalidArgument("canonicalValue", "contains a non-JSON value");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedToken(value) {
  return clean(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function sortedUnique(values) {
  return [...new Set((values || []).filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));
}

function normalizeShipmentKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits : clean(value);
}

function isCanonicalTimestamp(value) {
  const raw = clean(value);
  const parsed = Date.parse(raw);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(raw)
    && Number.isFinite(parsed);
}

function canonicalTimestampKey(value) {
  return isCanonicalTimestamp(value) ? new Date(Date.parse(clean(value))).toISOString() : "";
}

function parseTime(value) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function requireObject(value, field) {
  if (!isPlainObject(value)) throw invalidArgument(field, "must be a plain object");
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw invalidArgument(field, "must be an array");
  return value;
}

function requireHash(value, field) {
  const hash = clean(value).toLowerCase();
  if (!SHA256_RE.test(hash)) throw invalidArgument(field, "must be lowercase SHA-256 hex");
  return hash;
}

function canonicalEnvelopeFrom(item, fields) {
  for (const field of fields) {
    if (isPlainObject(item?.[field])) return item[field];
  }
  return item;
}

function normalizeSourceCut(bundle) {
  const raw = requireObject(bundle.sourceCut, "sourceCut");
  const sourceCutId = clean(raw.sourceCutId || raw.source_cut_id);
  const manifestHash = requireHash(raw.manifestHash || raw.manifest_hash, "sourceCut.manifestHash");
  const completeness = normalizedToken(raw.completeness || "complete");
  if (!sourceCutId) throw invalidArgument("sourceCut.sourceCutId", "must not be empty");
  const sourceWatermark = canonicalize(
    bundle.sourceWatermark
    || raw.sourceWatermark
    || raw.watermark
    || { cursors: raw.cursors || [] },
  );
  const documentedGapExclusions = raw.documentedGapExclusions
    || sourceWatermark.documentedGapExclusions
    || [];
  const documentedGapExclusionHash = clean(
    raw.documentedGapExclusionHash || sourceWatermark.documentedGapExclusionHash,
  ).toLowerCase();
  if (completeness === "complete") {
    if (documentedGapExclusions.length !== 0 || documentedGapExclusionHash) {
      throw invalidArgument("sourceCut.documentedGapExclusions", "must be empty for a complete cut");
    }
  } else if (completeness === "degraded") {
    requireArray(documentedGapExclusions, "sourceCut.documentedGapExclusions");
    if (documentedGapExclusions.length === 0
      || !SHA256_RE.test(documentedGapExclusionHash)
      || sha256Json(documentedGapExclusions) !== documentedGapExclusionHash
      || stableJson(documentedGapExclusions)
        !== stableJson(sourceWatermark.documentedGapExclusions)
      || documentedGapExclusionHash !== sourceWatermark.documentedGapExclusionHash) {
      throw invalidArgument(
        "sourceCut.documentedGapExclusions",
        "must match the frozen policy exclusion witness",
        "RELATIONAL_TRUTH_SOURCE_CUT_INCOMPLETE",
      );
    }
  } else {
    throw invalidArgument(
      "sourceCut.completeness",
      "must be complete or carry a documented degraded-cut exclusion witness",
      "RELATIONAL_TRUTH_SOURCE_CUT_INCOMPLETE",
    );
  }
  const observations = raw.observations
    || raw.observationManifest
    || raw.observation_manifest
    || raw.manifest?.observations
    || raw.canonicalManifest?.observations
    || raw.canonical_manifest?.observations;
  requireArray(observations, "sourceCut.observations");
  const observationRows = observations.map((item, index) => {
    requireObject(item, `sourceCut.observations[${index}]`);
    const observationId = clean(item.observationId || item.observation_id);
    const contentHash = requireHash(
      item.contentHash || item.content_hash,
      `sourceCut.observations[${index}].contentHash`,
    );
    if (!/^obs:v1:[0-9a-f]{64}$/.test(observationId)) {
      throw invalidArgument(`sourceCut.observations[${index}].observationId`, "must be obs:v1:<sha256>");
    }
    return { observationId, contentHash };
  }).sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (new Set(observationRows.map((item) => item.observationId)).size !== observationRows.length) {
    throw invalidArgument("sourceCut.observations", "contains duplicate observation IDs");
  }
  return {
    sourceCutId,
    manifestHash,
    completeness,
    sourceWatermark,
    observations: observationRows,
    observationIds: new Set(observationRows.map((item) => item.observationId)),
  };
}

function sourceClassAlias(value) {
  const token = normalizedToken(value);
  if (!token) return "";
  if (["operator", "operator_phone", "operator_note", "operator_event", "phone_truth"].includes(token)) {
    return "operator";
  }
  if ([
    "direct_document",
    "document",
    "gmail_attachment",
    "attachment",
    "pod",
    "pod_document",
    "direct_document_or_pod",
  ].includes(token)) return "direct_document_or_pod";
  if (["gmail", "gmail_message", "gmail_parsed_message", "email", "parsed_email"].includes(token)) {
    return "gmail_parsed_message";
  }
  if (["tms", "couriercloud", "tms_record"].includes(token)) return "tms";
  if (["tracking", "carrier_tracking", "flight_tracking"].includes(token)) return "tracking";
  return "";
}

function sourceClassForClaim(claim, evidence) {
  const normalizedValue = isPlainObject(claim.normalizedValue) ? claim.normalizedValue : {};
  for (const value of [
    normalizedValue.sourceClass,
    normalizedValue.evidenceClass,
    normalizedValue.sourceSystem,
    normalizedValue.sourceType,
    claim.sourceClass,
    claim.sourceSystem,
  ]) {
    const sourceClass = sourceClassAlias(value);
    if (sourceClass) return sourceClass;
  }
  if (normalizedToken(claim.extractionMethod) === "operator") return "operator";
  const evidenceSpans = [claim.evidenceSpan, ...evidence.map((item) => item.evidenceSpan)].filter(isPlainObject);
  if (evidenceSpans.some((span) => (
    clean(span.attachmentId)
    || clean(span.documentKind)
    || /attachment|document|pod/i.test(clean(span.field))
  ))) return "direct_document_or_pod";
  // Accepted-claim envelopes intentionally cite immutable observations by ID
  // instead of repeating mutable source rows. The extractor identity is also
  // sealed into the accepted claim, so it is the deterministic fallback for
  // source class when an evidence span has no optional field label (the normal
  // shape for MESSAGE-model and several deterministic Gmail candidates).
  const extractorVersion = normalizedToken(claim.extractorVersion || claim.extractor_version);
  if (/^gmail_claim_extractor(?:_|$)/.test(extractorVersion)) return "gmail_parsed_message";
  if (/^tms_claim_extractor(?:_|$)/.test(extractorVersion)) return "tms";
  if (/^tracking_claim_extractor(?:_|$)/.test(extractorVersion)) return "tracking";
  if (evidenceSpans.some((span) => /subject|text|body|header/i.test(clean(span.field)))) {
    return "gmail_parsed_message";
  }
  return "unknown";
}

function normalizeClaimEnvelopes(rawItems, sourceCut) {
  const items = requireArray(rawItems, "acceptedClaimEnvelopes");
  const byId = new Map();
  items.forEach((item, index) => {
    requireObject(item, `acceptedClaimEnvelopes[${index}]`);
    const envelope = canonicalEnvelopeFrom(item, ["canonicalEnvelope", "canonical_envelope", "envelope"]);
    const claim = requireObject(envelope.claim || item.claim, `acceptedClaimEnvelopes[${index}].claim`);
    const evidence = requireArray(envelope.evidence || item.evidence || [], `acceptedClaimEnvelopes[${index}].evidence`)
      .map((entry, evidenceIndex) => {
        requireObject(entry, `acceptedClaimEnvelopes[${index}].evidence[${evidenceIndex}]`);
        const observationId = clean(entry.observationId || entry.observation_id);
        if (!sourceCut.observationIds.has(observationId)) {
          throw invalidArgument(
            `acceptedClaimEnvelopes[${index}].evidence[${evidenceIndex}].observationId`,
            "is outside the sealed source cut",
            "RELATIONAL_TRUTH_CITATION_OUTSIDE_SOURCE_CUT",
          );
        }
        return {
          observationId,
          evidenceRole: normalizedToken(entry.evidenceRole || entry.evidence_role || "supporting"),
          evidenceSpan: canonicalize(entry.evidenceSpan || entry.evidence_span || {}),
        };
      }).sort((left, right) => (
        left.observationId.localeCompare(right.observationId)
        || left.evidenceRole.localeCompare(right.evidenceRole)
      ));
    if (!evidence.length) {
      throw invalidArgument(`acceptedClaimEnvelopes[${index}].evidence`, "must cite at least one observation");
    }
    const canonicalHash = sha256Json(envelope);
    const envelopeHash = clean(item.envelopeHash || item.envelope_hash || item.itemHash || item.item_hash)
      || canonicalHash;
    requireHash(envelopeHash, `acceptedClaimEnvelopes[${index}].envelopeHash`);
    const claimVersionId = clean(item.claimVersionId || item.claim_version_id)
      || `claim:v1:${envelopeHash}`;
    if (!/^claim:v1:[0-9a-f]{64}$/.test(claimVersionId)) {
      throw invalidArgument(`acceptedClaimEnvelopes[${index}].claimVersionId`, "must be claim:v1:<sha256>");
    }
    const supersessions = requireArray(
      envelope.supersessions || item.supersessions || [],
      `acceptedClaimEnvelopes[${index}].supersessions`,
    ).map((entry, supersessionIndex) => {
      requireObject(entry, `acceptedClaimEnvelopes[${index}].supersessions[${supersessionIndex}]`);
      const supersededClaimVersionId = clean(
        entry.supersededClaimVersionId || entry.superseded_claim_version_id,
      );
      if (!/^claim:v1:[0-9a-f]{64}$/.test(supersededClaimVersionId)) {
        throw invalidArgument(
          `acceptedClaimEnvelopes[${index}].supersessions[${supersessionIndex}]`,
          "has an invalid superseded claim ID",
        );
      }
      return {
        supersededClaimVersionId,
        relationship: normalizedToken(entry.relationship),
        policyVersion: clean(entry.policyVersion || entry.policy_version),
      };
    }).sort((left, right) => left.supersededClaimVersionId.localeCompare(right.supersededClaimVersionId));
    const sourceClass = sourceClassForClaim(claim, evidence);
    const normalizedClaim = {
      claimVersionId,
      envelopeHash,
      claimKey: clean(claim.claimKey || claim.claim_key || claimVersionId),
      versionNo: Number(claim.versionNo || claim.version_no || 1),
      previousClaimVersionId: clean(claim.previousClaimVersionId || claim.previous_claim_version_id),
      subjectType: normalizedToken(claim.subjectType || claim.subject_type),
      subjectKey: clean(claim.subjectKey || claim.subject_key),
      predicate: normalizedToken(claim.predicate),
      gate: normalizedToken(claim.gate),
      polarity: normalizedToken(claim.polarity || "neutral"),
      normalizedValue: canonicalize(claim.normalizedValue || claim.normalized_value || {}),
      occurredAt: clean(claim.occurredAt || claim.occurred_at) || null,
      capturedAt: clean(claim.capturedAt || claim.captured_at) || null,
      recordedAt: clean(claim.recordedAt || claim.recorded_at) || null,
      confidence: Number(claim.confidence ?? 0),
      confidenceLabel: normalizedToken(claim.confidenceLabel || claim.confidence_label),
      extractionMethod: normalizedToken(claim.extractionMethod || claim.extraction_method),
      acceptanceMethod: normalizedToken(claim.acceptanceMethod || claim.acceptance_method),
      decision: normalizedToken(claim.decision || "accepted"),
      evidence,
      supersessions,
      sourceClass,
      sourceRank: EVIDENCE_PRECEDENCE[sourceClass].rank,
    };
    if (!normalizedClaim.subjectType || !normalizedClaim.subjectKey || !normalizedClaim.predicate) {
      throw invalidArgument(`acceptedClaimEnvelopes[${index}].claim`, "is missing subject or predicate identity");
    }
    if (normalizedClaim.predicate === "shipment_observed_in_tms") {
      const value = normalizedClaim.normalizedValue;
      const valueKeys = Object.keys(value).sort();
      const expectedKeys = [
        "effect",
        "evidenceDirectness",
        "responsibleActor",
        "sourceClass",
        "status",
        "statusCode",
        "tmsStatus",
      ].sort();
      const exactAwb = String(normalizedClaim.subjectKey || "").replace(/\D/g, "");
      const structuredStatusCitation = evidence.some((entry) => (
        entry.evidenceSpan?.kind === "structured_field"
        && [
          stableJson(["shipment", "tmsStatus"]),
          stableJson(["shipment", "status"]),
        ].includes(stableJson(entry.evidenceSpan.path))
      ));
      if (normalizedClaim.subjectType !== "shipment"
        || normalizedClaim.sourceClass !== "tms"
        || normalizedClaim.gate !== "context"
        || normalizedClaim.polarity !== "neutral"
        || normalizedClaim.acceptanceMethod !== "policy"
        || normalizedClaim.confidence !== 1
        || stableJson(valueKeys) !== stableJson(expectedKeys)
        || value.status !== "observed"
        || value.effect !== "context"
        || value.sourceClass !== "tms"
        || value.responsibleActor !== "automated_system"
        || value.evidenceDirectness !== "operational_summary"
        || !clean(value.tmsStatus)
        || !(value.statusCode === null || (Number.isSafeInteger(value.statusCode) && value.statusCode >= 100))
        || !isCanonicalTimestamp(normalizedClaim.capturedAt)
        || exactAwb.length !== 11
        || !structuredStatusCitation) {
        throw invalidArgument(
          `acceptedClaimEnvelopes[${index}].claim`,
          "contains an invalid or semantically widened TMS inventory-presence claim",
          "RELATIONAL_TRUTH_TMS_INVENTORY_CLAIM_INVALID",
        );
      }
    }
    if (!Number.isFinite(normalizedClaim.confidence) || normalizedClaim.confidence < 0 || normalizedClaim.confidence > 1) {
      throw invalidArgument(`acceptedClaimEnvelopes[${index}].claim.confidence`, "must be between zero and one");
    }
    const existing = byId.get(claimVersionId);
    if (existing && stableJson(existing) !== stableJson(normalizedClaim)) {
      throw invalidArgument(
        `acceptedClaimEnvelopes[${index}]`,
        "repeats a claim ID with conflicting immutable content",
        "RELATIONAL_TRUTH_ENVELOPE_CONFLICT",
      );
    }
    byId.set(claimVersionId, normalizedClaim);
  });
  const claims = [...byId.values()].sort((left, right) => left.claimVersionId.localeCompare(right.claimVersionId));
  for (const claim of claims) {
    for (const supersession of claim.supersessions) {
      if (!byId.has(supersession.supersededClaimVersionId)) {
        throw invalidArgument(
          `claim ${claim.claimVersionId}.supersessions`,
          `references unavailable claim ${supersession.supersededClaimVersionId}`,
          "RELATIONAL_TRUTH_CITATION_NOT_CLOSED",
        );
      }
      if (supersession.supersededClaimVersionId === claim.claimVersionId) {
        throw invalidArgument(`claim ${claim.claimVersionId}.supersessions`, "cannot supersede itself");
      }
    }
  }
  return claims;
}

function normalizeLinkEnvelopes(rawItems, sourceCut) {
  const items = requireArray(rawItems || [], "entityLinkEnvelopes");
  const byId = new Map();
  items.forEach((item, index) => {
    requireObject(item, `entityLinkEnvelopes[${index}]`);
    const envelope = canonicalEnvelopeFrom(item, ["canonicalEnvelope", "canonical_envelope", "envelope"]);
    const link = requireObject(envelope.link || item.link, `entityLinkEnvelopes[${index}].link`);
    const observationId = clean(link.observationId || link.observation_id);
    if (!sourceCut.observationIds.has(observationId)) {
      throw invalidArgument(
        `entityLinkEnvelopes[${index}].link.observationId`,
        "is outside the sealed source cut",
        "RELATIONAL_TRUTH_CITATION_OUTSIDE_SOURCE_CUT",
      );
    }
    const envelopeHash = clean(item.envelopeHash || item.envelope_hash || item.itemHash || item.item_hash)
      || sha256Json(envelope);
    requireHash(envelopeHash, `entityLinkEnvelopes[${index}].envelopeHash`);
    const linkVersionId = clean(item.linkVersionId || item.link_version_id) || `link:v1:${envelopeHash}`;
    if (!/^link:v1:[0-9a-f]{64}$/.test(linkVersionId)) {
      throw invalidArgument(`entityLinkEnvelopes[${index}].linkVersionId`, "must be link:v1:<sha256>");
    }
    const normalized = {
      linkVersionId,
      envelopeHash,
      observationId,
      entityType: normalizedToken(link.entityType || link.entity_type),
      entityKey: clean(link.entityKey || link.entity_key),
      relationship: normalizedToken(link.relationship),
      decision: normalizedToken(link.decision || "linked"),
      confidence: Number(link.confidence ?? 0),
      recordedAt: clean(link.recordedAt || link.recorded_at) || null,
    };
    const existing = byId.get(linkVersionId);
    if (existing && stableJson(existing) !== stableJson(normalized)) {
      throw invalidArgument(`entityLinkEnvelopes[${index}]`, "conflicts with an existing link envelope");
    }
    byId.set(linkVersionId, normalized);
  });
  return [...byId.values()].sort((left, right) => left.linkVersionId.localeCompare(right.linkVersionId));
}

function normalizeWorkgroupDefinitions(rawItems) {
  const items = requireArray(rawItems || [], "workgroupDefinitions");
  const byId = new Map();
  items.forEach((item, index) => {
    requireObject(item, `workgroupDefinitions[${index}]`);
    const envelope = canonicalEnvelopeFrom(item, [
      "canonicalDefinition",
      "canonical_definition",
      "canonicalEnvelope",
      "canonical_envelope",
      "envelope",
    ]);
    const workgroup = requireObject(envelope.workgroup || item.workgroup, `workgroupDefinitions[${index}].workgroup`);
    const definitionHash = clean(item.definitionHash || item.definition_hash || item.envelopeHash || item.envelope_hash)
      || sha256Json(envelope);
    requireHash(definitionHash, `workgroupDefinitions[${index}].definitionHash`);
    const workgroupId = clean(item.workgroupId || item.workgroup_id) || `workgroup:v1:${definitionHash}`;
    if (!/^workgroup:v1:[0-9a-f]{64}$/.test(workgroupId)) {
      throw invalidArgument(`workgroupDefinitions[${index}].workgroupId`, "must be workgroup:v1:<sha256>");
    }
    const normalized = {
      workgroupId,
      definitionHash,
      workgroupType: normalizedToken(workgroup.workgroupType || workgroup.workgroup_type),
      identityKey: clean(workgroup.identityKey || workgroup.identity_key),
      identityBasis: canonicalize(workgroup.identityBasis || workgroup.identity_basis || {}),
      initialConfidence: Number(workgroup.initialConfidence ?? workgroup.initial_confidence ?? 0),
    };
    const existing = byId.get(workgroupId);
    if (existing && stableJson(existing) !== stableJson(normalized)) {
      throw invalidArgument(`workgroupDefinitions[${index}]`, "conflicts with an existing workgroup definition");
    }
    byId.set(workgroupId, normalized);
  });
  return [...byId.values()].sort((left, right) => left.workgroupId.localeCompare(right.workgroupId));
}

function normalizeWorkgroupMemberships(rawItems, sourceCut, workgroups) {
  const items = requireArray(rawItems || [], "workgroupMembershipEnvelopes");
  const workgroupIds = new Set(workgroups.map((item) => item.workgroupId));
  const all = [];
  items.forEach((item, index) => {
    requireObject(item, `workgroupMembershipEnvelopes[${index}]`);
    const envelope = canonicalEnvelopeFrom(item, ["canonicalEnvelope", "canonical_envelope", "envelope"]);
    const membership = requireObject(
      envelope.membership || item.membership,
      `workgroupMembershipEnvelopes[${index}].membership`,
    );
    const workgroupId = clean(
      envelope.workgroup?.workgroupId
      || envelope.workgroup?.workgroup_id
      || item.workgroupId
      || item.workgroup_id,
    );
    if (!workgroupIds.has(workgroupId)) {
      throw invalidArgument(`workgroupMembershipEnvelopes[${index}].workgroupId`, "has no immutable definition");
    }
    const evidence = requireArray(envelope.evidence || item.evidence || [], `workgroupMembershipEnvelopes[${index}].evidence`)
      .map((entry, evidenceIndex) => {
        requireObject(entry, `workgroupMembershipEnvelopes[${index}].evidence[${evidenceIndex}]`);
        const observationId = clean(entry.observationId || entry.observation_id);
        if (!sourceCut.observationIds.has(observationId)) {
          throw invalidArgument(
            `workgroupMembershipEnvelopes[${index}].evidence[${evidenceIndex}]`,
            "is outside the sealed source cut",
            "RELATIONAL_TRUTH_CITATION_OUTSIDE_SOURCE_CUT",
          );
        }
        return observationId;
      });
    if (!evidence.length) throw invalidArgument(`workgroupMembershipEnvelopes[${index}].evidence`, "must not be empty");
    const envelopeHash = clean(item.envelopeHash || item.envelope_hash || item.itemHash || item.item_hash)
      || sha256Json(envelope);
    requireHash(envelopeHash, `workgroupMembershipEnvelopes[${index}].envelopeHash`);
    const membershipVersionId = clean(item.membershipVersionId || item.membership_version_id)
      || `membership:v1:${envelopeHash}`;
    if (!/^membership:v1:[0-9a-f]{64}$/.test(membershipVersionId)) {
      throw invalidArgument(`workgroupMembershipEnvelopes[${index}].membershipVersionId`, "must be membership:v1:<sha256>");
    }
    all.push({
      membershipVersionId,
      envelopeHash,
      membershipKey: clean(membership.membershipKey || membership.membership_key || membershipVersionId),
      versionNo: Number(membership.versionNo || membership.version_no || 1),
      workgroupId,
      memberType: normalizedToken(membership.memberType || membership.member_type),
      memberKey: clean(membership.memberKey || membership.member_key),
      role: normalizedToken(membership.role),
      decision: normalizedToken(membership.decision || "added"),
      confidence: Number(membership.confidence ?? 0),
      recordedAt: clean(membership.recordedAt || membership.recorded_at) || null,
      evidenceObservationIds: sortedUnique(evidence),
    });
  });
  const latestByKey = new Map();
  for (const membership of all.sort((left, right) => (
    left.membershipKey.localeCompare(right.membershipKey)
    || left.versionNo - right.versionNo
    || left.membershipVersionId.localeCompare(right.membershipVersionId)
  ))) {
    const existing = latestByKey.get(membership.membershipKey);
    if (existing && existing.versionNo === membership.versionNo && stableJson(existing) !== stableJson(membership)) {
      throw invalidArgument("workgroupMembershipEnvelopes", "contains conflicting logical membership versions");
    }
    if (!existing || membership.versionNo >= existing.versionNo) latestByKey.set(membership.membershipKey, membership);
  }
  return [...latestByKey.values()]
    .filter((membership) => membership.decision === "added")
    .sort((left, right) => left.membershipVersionId.localeCompare(right.membershipVersionId));
}

function canonicalGate(value) {
  return GATE_ALIASES[normalizedToken(value)] || "context";
}

function claimEffect(claim) {
  const value = claim.normalizedValue || {};
  const speechAct = normalizedToken(value.speechAct || value.communicativeAct || value.temporality);
  if (
    claim.polarity === "requested"
    || ["request", "question", "plan", "future", "intent", "proposal"].includes(speechAct)
    || REQUEST_OR_PLAN_PATTERN.test(claim.predicate)
  ) return "request";
  const explicitEffect = normalizedToken(value.effect);
  if (["complete", "completed", "true"].includes(explicitEffect)) return "complete";
  if (["block", "blocked", "negative", "false"].includes(explicitEffect)) return "block";
  if (["request", "requested", "plan", "context", "neutral", "unknown"].includes(explicitEffect)) {
    return explicitEffect === "request" || explicitEffect === "requested" || explicitEffect === "plan"
      ? "request"
      : "context";
  }
  if (BLOCKING_PREDICATE_PATTERN.test(claim.predicate) || claim.polarity === "negative") return "block";
  if (
    claim.polarity === "positive"
    && (value.completed === true || COMPLETION_PREDICATE_PATTERN.test(claim.predicate))
  ) return "complete";
  return "context";
}

function claimEventTime(claim, policy = DEFAULT_POLICY) {
  return precedenceEventTime(claim, policy);
}

function compareClaimPriority(left, right, policy = DEFAULT_POLICY) {
  return compareByPrecedencePolicy(left, right, policy);
}

function resolutionBasis(winner, loser, policy = DEFAULT_POLICY) {
  return explainPriority(winner, loser, policy).decisiveCriterion;
}

function claimCitation(claim, policy = DEFAULT_POLICY) {
  const vector = priorityVector(claim, policy);
  return {
    claimVersionId: claim.claimVersionId,
    envelopeHash: claim.envelopeHash,
    evidenceObservationIds: claim.evidence.map((item) => item.observationId),
    sourceClass: claim.sourceClass,
    sourceRank: vector.source_class,
    responsibleActor: vector.metadata.actor,
    evidenceDirectness: vector.metadata.directness,
  };
}

function contradictionRecord(shipmentKey, gate, claims, winner, reason) {
  const claimVersionIds = sortedUnique(claims.map((claim) => claim.claimVersionId));
  const core = {
    shipmentKey,
    gate,
    claimVersionIds,
    winnerClaimVersionId: winner.claimVersionId,
    resolution: reason,
    visible: true,
  };
  return { contradictionId: `contradiction:v1:${sha256Json(core)}`, ...core };
}

function reduceDirectGate(shipmentKey, gate, claims, policy) {
  const gateClaims = claims.filter((claim) => canonicalGate(claim.gate) === gate);
  const requests = gateClaims.filter((claim) => claim.effect === "request");
  const contenders = gateClaims.filter((claim) => claim.effect === "complete" || claim.effect === "block")
    .sort((left, right) => compareClaimPriority(left, right, policy));
  if (!contenders.length) {
    const requestIds = sortedUnique(requests.map((claim) => claim.claimVersionId));
    return {
      gate: {
        gate,
        status: "unknown",
        confidence: "unknown",
        reason: requestIds.length
          ? "Only requests or plans exist; no completion evidence was accepted."
          : "No accepted claim proves or disproves this gate.",
        claimVersionIds: requestIds,
        winnerClaimVersionId: null,
        basis: requestIds.length ? "request_is_not_completion" : "missing_accepted_claim",
        inferredFromGate: null,
      },
      requests,
      contradictions: [],
      contenders,
    };
  }
  const winner = contenders[contenders.length - 1];
  const opposing = contenders.filter((claim) => claim.effect !== winner.effect);
  const sameEffect = contenders.filter((claim) => claim.effect === winner.effect);
  const contradictions = opposing.length
    ? [contradictionRecord(
      shipmentKey,
      gate,
      [...opposing, winner],
      winner,
      resolutionBasis(winner, opposing[opposing.length - 1], policy),
    )]
    : [];
  return {
    gate: {
      gate,
      status: winner.effect === "complete" ? "true" : "blocked",
      confidence: winner.confidenceLabel || (winner.confidence >= 0.9 ? "high" : winner.confidence >= 0.65 ? "medium" : "low"),
      reason: winner.effect === "complete"
        ? `Accepted claim ${winner.predicate} is the current completion evidence.`
        : `Accepted claim ${winner.predicate} is the current blocker evidence.`,
      claimVersionIds: sortedUnique(sameEffect.map((claim) => claim.claimVersionId)),
      winnerClaimVersionId: winner.claimVersionId,
      opposingClaimVersionIds: sortedUnique(opposing.map((claim) => claim.claimVersionId)),
      basis: opposing.length ? resolutionBasis(winner, opposing[opposing.length - 1], policy) : "unopposed_accepted_claim",
      inferredFromGate: null,
    },
    requests,
    contradictions,
    contenders,
  };
}

function monotonicGateClosure(shipmentKey, reducedByGate, policy) {
  let highestTrueIndex = -1;
  for (let index = 0; index < MILESTONE_GATES.length; index += 1) {
    if (reducedByGate.get(MILESTONE_GATES[index]).gate.status === "true") highestTrueIndex = index;
  }
  if (highestTrueIndex <= 0) return [];
  const downstreamGateName = MILESTONE_GATES[highestTrueIndex];
  const downstreamGate = reducedByGate.get(downstreamGateName).gate;
  const addedContradictions = [];
  for (let index = 0; index < highestTrueIndex; index += 1) {
    const gateName = MILESTONE_GATES[index];
    const reduced = reducedByGate.get(gateName);
    if (reduced.gate.status === "true") continue;
    const prior = { ...reduced.gate };
    reduced.gate = {
      ...reduced.gate,
      status: "true",
      confidence: downstreamGate.confidence === "high" ? "medium" : downstreamGate.confidence,
      reason: `The later ${downstreamGateName} milestone proves this earlier gate was operationally passed.`,
      claimVersionIds: downstreamGate.claimVersionIds,
      winnerClaimVersionId: downstreamGate.winnerClaimVersionId,
      opposingClaimVersionIds: sortedUnique([
        ...(prior.opposingClaimVersionIds || []),
        ...(prior.status === "blocked" ? prior.claimVersionIds : []),
      ]),
      basis: "downstream_milestone",
      inferredFromGate: downstreamGateName,
      directGateStatus: prior.status,
    };
    if (prior.status === "blocked") {
      const blockerClaims = reduced.contenders.filter((claim) => claim.effect === "block");
      const downstreamWinner = [...reducedByGate.get(downstreamGateName).contenders]
        .filter((claim) => claim.effect === "complete")
        .sort((left, right) => compareClaimPriority(left, right, policy))
        .pop();
      if (blockerClaims.length && downstreamWinner) {
        addedContradictions.push(contradictionRecord(
          shipmentKey,
          gateName,
          [...blockerClaims, downstreamWinner],
          downstreamWinner,
          "downstream_milestone",
        ));
      }
    }
  }
  return addedContradictions;
}

function currentStateFor(gates, exceptions) {
  const highestTrue = [...gates].reverse().find((gate) => gate.status === "true");
  const stateByGate = {
    arrival: "arrived",
    customs: "released",
    fees: "fees_clear",
    dispatch: "dispatch_ready",
    pickup: "picked_up",
    delivery: "delivered",
    pod: "pod_received",
  };
  const activeExceptions = exceptions.filter((exception) => exception.status === "active");
  if (activeExceptions.length) {
    return {
      value: "exception",
      reason: "Current accepted blocker evidence requires operator attention.",
      claimVersionIds: sortedUnique(activeExceptions.flatMap((exception) => exception.claimVersionIds)),
    };
  }
  if (!highestTrue) {
    return { value: "unknown", reason: "No milestone completion is supported.", claimVersionIds: [] };
  }
  return {
    value: stateByGate[highestTrue.gate],
    reason: `The ${highestTrue.gate} gate is the latest supported milestone.`,
    claimVersionIds: highestTrue.claimVersionIds,
  };
}

function reduceShipment(shipmentKey, scopedClaims, supersessionsApplied, policy) {
  const reducedByGate = new Map();
  for (const gate of MILESTONE_GATES) {
    reducedByGate.set(gate, reduceDirectGate(shipmentKey, gate, scopedClaims, policy));
  }
  const monotonicContradictions = monotonicGateClosure(shipmentKey, reducedByGate, policy);
  const gates = MILESTONE_GATES.map((gate) => reducedByGate.get(gate).gate);
  const contradictionMap = new Map();
  for (const contradiction of [
    ...MILESTONE_GATES.flatMap((gate) => reducedByGate.get(gate).contradictions),
    ...monotonicContradictions,
  ]) contradictionMap.set(contradiction.contradictionId, contradiction);
  const contradictions = [...contradictionMap.values()].sort((left, right) => (
    left.contradictionId.localeCompare(right.contradictionId)
  ));
  const exceptions = [];
  for (const gate of MILESTONE_GATES) {
    const reduced = reducedByGate.get(gate);
    for (const blocker of reduced.contenders.filter((claim) => claim.effect === "block")) {
      const gateConclusion = reduced.gate;
      const active = gateConclusion.status === "blocked" && gateConclusion.winnerClaimVersionId === blocker.claimVersionId;
      const core = {
        shipmentKey,
        gate,
        predicate: blocker.predicate,
        status: active ? "active" : "visible_resolved_or_conflicting",
        claimVersionIds: sortedUnique([blocker.claimVersionId, ...(gateConclusion.claimVersionIds || [])]),
        propagatedFromWorkgroupId: blocker.propagatedFromWorkgroupId || null,
      };
      exceptions.push({ exceptionId: `exception:v1:${sha256Json(core)}`, ...core });
    }
  }
  exceptions.sort((left, right) => left.exceptionId.localeCompare(right.exceptionId));
  const openRequests = MILESTONE_GATES.flatMap((gate) => reducedByGate.get(gate).requests.map((claim) => ({
    gate,
    predicate: claim.predicate,
    claimVersionIds: [claim.claimVersionId],
    status: reducedByGate.get(gate).gate.status === "true" ? "historical_or_satisfied" : "open",
    propagatedFromWorkgroupId: claim.propagatedFromWorkgroupId || null,
  }))).sort((left, right) => (
    left.gate.localeCompare(right.gate) || left.claimVersionIds[0].localeCompare(right.claimVersionIds[0])
  ));
  const contextClaims = scopedClaims.filter((claim) => claim.effect === "context").map((claim) => ({
    predicate: claim.predicate,
    gate: canonicalGate(claim.gate),
    claimVersionIds: [claim.claimVersionId],
    propagatedFromWorkgroupId: claim.propagatedFromWorkgroupId || null,
  })).sort((left, right) => (
    left.gate.localeCompare(right.gate) || left.claimVersionIds[0].localeCompare(right.claimVersionIds[0])
  ));
  const relevantSupersessions = supersessionsApplied.filter((item) => (
    scopedClaims.some((claim) => claim.claimVersionId === item.resolvingClaimVersionId)
    || scopedClaims.some((claim) => claim.claimVersionId === item.supersededClaimVersionId)
  ));
  const currentState = currentStateFor(gates, exceptions);
  let commercialConversation;
  try {
    commercialConversation = deriveCommercialConversation(scopedClaims);
  } catch (cause) {
    if (!(cause instanceof CommercialConversationContractError)) throw cause;
    throw invalidArgument(
      `shipment ${shipmentKey}.commercialConversation`,
      cause.message,
      cause.code,
    );
  }
  return {
    shipmentKey,
    currentState,
    gates,
    exceptions,
    contradictions,
    openRequests,
    contextClaims,
    commercialConversation,
    acceptedClaimIds: sortedUnique(scopedClaims.map((claim) => claim.claimVersionId)),
    supersessionsApplied: relevantSupersessions,
  };
}

function normalizeBundle(bundle) {
  requireObject(bundle, "bundle");
  const inputManifestHash = requireHash(bundle.inputManifestHash, "inputManifestHash");
  const hasProcessingWatermark = bundle.processingWatermarkStatus !== undefined
    || bundle.processingWatermark !== undefined
    || bundle.processingWatermarkHash !== undefined;
  const processingWatermarkStatus = hasProcessingWatermark
    ? clean(bundle.processingWatermarkStatus)
    : "";
  const processingWatermark = hasProcessingWatermark
    ? canonicalize(requireObject(bundle.processingWatermark, "processingWatermark"))
    : null;
  const processingWatermarkHash = hasProcessingWatermark
    ? requireHash(bundle.processingWatermarkHash, "processingWatermarkHash")
    : "";
  const sourceCut = normalizeSourceCut(bundle);
  const claims = normalizeClaimEnvelopes(bundle.acceptedClaimEnvelopes || [], sourceCut);
  const links = normalizeLinkEnvelopes(bundle.entityLinkEnvelopes || [], sourceCut);
  const workgroups = normalizeWorkgroupDefinitions(bundle.workgroupDefinitions || []);
  const memberships = normalizeWorkgroupMemberships(
    bundle.workgroupMembershipEnvelopes || [],
    sourceCut,
    workgroups,
  );
  let shipmentMetadata;
  try {
    shipmentMetadata = normalizeShipmentMetadataEnvelopes(
      bundle.shipmentMetadataEnvelopes || [],
      {
        sourceCut,
        expectedManifestHash: bundle.shipmentMetadataManifestHash,
      },
    );
  } catch (cause) {
    throw invalidArgument(
      "shipmentMetadataEnvelopes",
      cause?.message || "is invalid",
      cause?.code || "RELATIONAL_TRUTH_SHIPMENT_METADATA_INVALID",
    );
  }
  return {
    inputManifestHash,
    processingWatermarkStatus,
    processingWatermark,
    processingWatermarkHash,
    sourceCut,
    claims,
    links,
    workgroups,
    memberships,
    shipmentMetadata,
  };
}

function assertNoSupersessionCycle(claims) {
  const edges = new Map(claims.map((claim) => [
    claim.claimVersionId,
    claim.supersessions.map((item) => item.supersededClaimVersionId),
  ]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw invalidArgument("acceptedClaimEnvelopes", "contains a supersession cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of edges.get(id) || []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
}

function activeClaimsAndSupersessions(claims) {
  assertNoSupersessionCycle(claims);
  const acceptedResolvers = claims.filter((claim) => claim.decision === "accepted");
  const superseded = new Set(acceptedResolvers.flatMap((claim) => (
    claim.supersessions.map((item) => item.supersededClaimVersionId)
  )));
  const supersessionsApplied = acceptedResolvers.flatMap((claim) => claim.supersessions.map((item) => ({
    resolvingClaimVersionId: claim.claimVersionId,
    supersededClaimVersionId: item.supersededClaimVersionId,
    relationship: item.relationship,
    policyVersion: item.policyVersion,
    claimVersionIds: sortedUnique([claim.claimVersionId, item.supersededClaimVersionId]),
  }))).sort((left, right) => (
    left.resolvingClaimVersionId.localeCompare(right.resolvingClaimVersionId)
    || left.supersededClaimVersionId.localeCompare(right.supersededClaimVersionId)
  ));
  return {
    activeClaims: claims.filter((claim) => claim.decision === "accepted" && !superseded.has(claim.claimVersionId)),
    supersessionsApplied,
  };
}

function tmsSnapshotWatermarks(sourceWatermark) {
  const values = [];
  const cursors = Array.isArray(sourceWatermark?.cursors) ? sourceWatermark.cursors : [];
  for (const cursor of cursors) {
    if (normalizedToken(cursor?.sourceSystem || cursor?.source_system) !== "tms") continue;
    const value = clean(
      cursor?.throughCursorValue
      || cursor?.through_cursor_value
      || cursor?.cursorValue
      || cursor?.cursor_value
      || cursor?.value,
    );
    if (value) values.push(canonicalTimestampKey(value) || value);
  }
  if (isPlainObject(sourceWatermark?.tms)) {
    const value = clean(
      sourceWatermark.tms.throughCursorValue
      || sourceWatermark.tms.through_cursor_value
      || sourceWatermark.tms.cursorValue
      || sourceWatermark.tms.cursor_value
      || sourceWatermark.tms.value,
    );
    if (value) values.push(canonicalTimestampKey(value) || value);
  }
  return new Set(sortedUnique(values));
}

function currentAcceptedClaims(activeClaims, sourceWatermark) {
  const inventoryClaims = activeClaims.filter((claim) => claim.predicate === "shipment_observed_in_tms");
  if (!inventoryClaims.length) return activeClaims;
  const watermarks = tmsSnapshotWatermarks(sourceWatermark);
  if (!watermarks.size) {
    throw invalidArgument(
      "sourceWatermark",
      "must include the exact TMS snapshot cursor when TMS inventory claims are present",
      "RELATIONAL_TRUTH_TMS_INVENTORY_WATERMARK_MISSING",
    );
  }
  const currentPresence = inventoryClaims.filter((claim) => (
    // Inventory presence is an event at the immutable TMS snapshot clock.
    // Source-chronology append authority records that effective source time as
    // occurredAt; capturedAt is persistence time and can lag during replay.
    // Keep capturedAt only as a legacy-envelope fallback.
    watermarks.has(canonicalTimestampKey(claim.occurredAt || claim.capturedAt))
  ));
  const byShipment = new Map();
  for (const claim of currentPresence) {
    const awb = normalizeShipmentKey(claim.subjectKey);
    if (!byShipment.has(awb)) byShipment.set(awb, []);
    byShipment.get(awb).push(claim);
  }
  for (const [awb, claims] of byShipment) {
    if (claims.length !== 1) {
      throw invalidArgument(
        "acceptedClaimEnvelopes",
        `contains ${claims.length} current TMS inventory claims for AWB ${awb}`,
        "RELATIONAL_TRUTH_TMS_INVENTORY_DUPLICATE_AWB",
      );
    }
  }
  const currentIds = new Set(currentPresence.map((claim) => claim.claimVersionId));
  return activeClaims.filter((claim) => (
    claim.predicate !== "shipment_observed_in_tms" || currentIds.has(claim.claimVersionId)
  ));
}

function inputManifest(normalized) {
  return {
    sourceCutId: normalized.sourceCut.sourceCutId,
    sourceCutManifestHash: normalized.sourceCut.manifestHash,
    sourceWatermark: normalized.sourceCut.sourceWatermark,
    acceptedClaims: normalized.claims.map((claim) => ({
      claimVersionId: claim.claimVersionId,
      envelopeHash: claim.envelopeHash,
    })),
    entityLinks: normalized.links.map((link) => ({
      linkVersionId: link.linkVersionId,
      envelopeHash: link.envelopeHash,
    })),
    workgroups: normalized.workgroups.map((workgroup) => ({
      workgroupId: workgroup.workgroupId,
      definitionHash: workgroup.definitionHash,
    })),
    workgroupMemberships: normalized.memberships.map((membership) => ({
      membershipVersionId: membership.membershipVersionId,
      envelopeHash: membership.envelopeHash,
    })),
    shipmentMetadata: normalized.shipmentMetadata.manifest,
    shipmentMetadataManifestHash: normalized.shipmentMetadata.manifestHash,
  };
}

function reduceRelationalTruth(bundle, options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be a plain object");
  const mode = normalizedToken(options.mode || bundle?.buildMode || "full");
  if (!["full", "incremental"].includes(mode)) {
    throw invalidArgument("options.mode", "must be full or incremental");
  }
  let precedencePolicy;
  try {
    precedencePolicy = options.precedencePolicy
      ? validatePolicy(options.precedencePolicy)
      : DEFAULT_POLICY;
  } catch (cause) {
    throw invalidArgument(
      "options.precedencePolicy",
      cause?.message || "is invalid",
      "RELATIONAL_TRUTH_PRECEDENCE_POLICY_INVALID",
    );
  }
  // Incremental mode deliberately recomputes from the complete immutable
  // bundle for now. The optional base publication is never an evidence input.
  const normalized = normalizeBundle(bundle);
  const manifest = inputManifest(normalized);
  const reducerInputManifestHash = sha256Json(manifest);
  const { activeClaims, supersessionsApplied } = activeClaimsAndSupersessions(normalized.claims);
  const reducerClaims = currentAcceptedClaims(activeClaims, normalized.sourceCut.sourceWatermark);
  const currentTmsPresenceShipments = sortedUnique(reducerClaims
    .filter((claim) => claim.predicate === "shipment_observed_in_tms")
    .map((claim) => normalizeShipmentKey(claim.subjectKey)));
  const metadataShipments = normalized.shipmentMetadata.rows.map((row) => row.shipmentKey).sort();
  if (stableJson(currentTmsPresenceShipments) !== stableJson(metadataShipments)) {
    throw invalidArgument(
      "shipmentMetadataEnvelopes",
      "must contain exactly one cut-bound metadata envelope for every current TMS inventory claim",
      "RELATIONAL_TRUTH_SHIPMENT_METADATA_INVENTORY_MISMATCH",
    );
  }
  const workgroupById = new Map(normalized.workgroups.map((workgroup) => [workgroup.workgroupId, workgroup]));
  const shipmentMembersByWorkgroup = new Map();
  for (const membership of normalized.memberships) {
    if (membership.memberType !== "shipment") continue;
    if (!shipmentMembersByWorkgroup.has(membership.workgroupId)) {
      shipmentMembersByWorkgroup.set(membership.workgroupId, []);
    }
    shipmentMembersByWorkgroup.get(membership.workgroupId).push(normalizeShipmentKey(membership.memberKey));
  }
  for (const [workgroupId, members] of shipmentMembersByWorkgroup.entries()) {
    shipmentMembersByWorkgroup.set(workgroupId, sortedUnique(members));
  }

  const claimsByShipment = new Map();
  const addScopedClaim = (shipmentKey, claim, propagatedFromWorkgroupId = null) => {
    const key = normalizeShipmentKey(shipmentKey);
    if (!key) return;
    if (!claimsByShipment.has(key)) claimsByShipment.set(key, []);
    claimsByShipment.get(key).push({
      ...claim,
      gate: canonicalGate(claim.gate),
      effect: claimEffect(claim),
      propagatedFromWorkgroupId,
    });
  };
  for (const claim of reducerClaims) {
    if (claim.subjectType === "shipment") {
      addScopedClaim(claim.subjectKey, claim);
      continue;
    }
    if (claim.subjectType !== "workgroup") continue;
    const workgroup = workgroupById.get(claim.subjectKey)
      || normalized.workgroups.find((candidate) => candidate.identityKey === claim.subjectKey);
    if (!workgroup) {
      throw invalidArgument(
        `claim ${claim.claimVersionId}.subjectKey`,
        "references an unavailable workgroup",
        "RELATIONAL_TRUTH_WORKGROUP_NOT_FOUND",
      );
    }
    for (const shipmentKey of shipmentMembersByWorkgroup.get(workgroup.workgroupId) || []) {
      addScopedClaim(shipmentKey, claim, workgroup.workgroupId);
    }
  }
  for (const link of normalized.links) {
    if (link.decision === "linked" && link.entityType === "shipment") {
      const key = normalizeShipmentKey(link.entityKey);
      if (key && !claimsByShipment.has(key)) claimsByShipment.set(key, []);
    }
  }
  for (const members of shipmentMembersByWorkgroup.values()) {
    for (const shipmentKey of members) if (!claimsByShipment.has(shipmentKey)) claimsByShipment.set(shipmentKey, []);
  }

  const shipments = [...claimsByShipment.entries()].map(([shipmentKey, claims]) => (
    reduceShipment(
      shipmentKey,
      claims.sort((left, right) => left.claimVersionId.localeCompare(right.claimVersionId)),
      supersessionsApplied,
      precedencePolicy,
    )
  )).sort((left, right) => left.shipmentKey.localeCompare(right.shipmentKey));
  const activeClaimIds = new Set(reducerClaims.map((claim) => claim.claimVersionId));
  const workgroupOutput = normalized.workgroups.map((workgroup) => ({
    workgroupId: workgroup.workgroupId,
    workgroupType: workgroup.workgroupType,
    identityKey: workgroup.identityKey,
    shipmentKeys: shipmentMembersByWorkgroup.get(workgroup.workgroupId) || [],
    claimVersionIds: reducerClaims
      .filter((claim) => claim.subjectType === "workgroup" && (
        claim.subjectKey === workgroup.workgroupId || claim.subjectKey === workgroup.identityKey
      ))
      .map((claim) => claim.claimVersionId)
      .sort(),
  })).sort((left, right) => left.workgroupId.localeCompare(right.workgroupId));
  const payloadCore = {
    schemaVersion: PACKET_SCHEMA_VERSION,
    reducerVersion: REDUCER_VERSION,
    sourceCut: {
      sourceCutId: normalized.sourceCut.sourceCutId,
      manifestHash: normalized.sourceCut.manifestHash,
      completeness: normalized.sourceCut.completeness,
    },
    sourceWatermark: normalized.sourceCut.sourceWatermark,
    inputManifestHash: normalized.inputManifestHash,
    reducerInputManifestHash,
    ...(normalized.processingWatermarkStatus ? {
      processingWatermarkStatus: normalized.processingWatermarkStatus,
      processingWatermark: normalized.processingWatermark,
      processingWatermarkHash: normalized.processingWatermarkHash,
    } : {}),
    precedencePolicy: {
      schemaVersion: precedencePolicy.schemaVersion,
      policyVersion: precedencePolicy.policyVersion,
      policyHash: precedencePolicy.policyHash,
      comparisonOrder: ["explicit_supersession", ...precedencePolicy.criteria],
      sourceClasses: precedencePolicy.sourceClasses,
      milestoneOrder: MILESTONE_GATES,
      requestsAndPlansCompleteGates: false,
    },
    acceptedClaimCitations: normalized.claims
      .map((claim) => ({
        ...claimCitation(claim, precedencePolicy),
        activeReducerInput: activeClaimIds.has(claim.claimVersionId),
      }))
      .sort((left, right) => left.claimVersionId.localeCompare(right.claimVersionId)),
    shipmentMetadataManifestHash: normalized.shipmentMetadata.manifestHash,
    shipmentMetadataCitations: normalized.shipmentMetadata.rows.map((row) => ({
      metadataVersionId: row.metadataVersionId,
      envelopeHash: row.envelopeHash,
      shipmentKey: row.shipmentKey,
      sourceObservationId: row.sourceObservationId,
      sourceObservationContentHash: row.sourceObservationContentHash,
    })),
    supersessionsApplied,
    workgroups: workgroupOutput,
    shipments,
  };
  return Object.freeze({
    ...payloadCore,
    packetHash: sha256Json(payloadCore),
  });
}

module.exports = {
  EVIDENCE_PRECEDENCE,
  MILESTONE_GATES,
  PACKET_SCHEMA_VERSION,
  REDUCER_VERSION,
  RelationalTruthReducerError,
  reduceRelationalTruth,
  _test: {
    canonicalGate,
    canonicalTimestampKey,
    canonicalize,
    claimEffect,
    compareClaimPriority,
    normalizeBundle,
    currentAcceptedClaims,
    resolutionBasis,
    sha256Json,
    sourceClassForClaim,
    stableJson,
    tmsSnapshotWatermarks,
  },
};

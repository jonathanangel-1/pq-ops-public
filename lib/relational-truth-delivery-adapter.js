"use strict";

const crypto = require("node:crypto");
const { postgresJsonbText } = require("./postgres-jsonb");
const { normalizeShipmentMetadataEnvelopes } = require("./truth-shipment-metadata");
const { evaluateCommercialDeadlines } = require("./commercial-conversation-contract");
const {
  validateProcessingWatermarkFields,
} = require("./truth-processing-watermark");

const DELIVERY_SCHEMA_VERSION = "shipment-truth-packets-relational-v5-public-certification";
const PROVENANCE_SCHEMA_VERSION = "relational-truth-delivery-provenance-v1";
const DELIVERY_BUILDER_VERSION = "relational-truth-delivery-adapter-v5-public-certification";
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GATE_ORDER = Object.freeze(["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"]);

class RelationalTruthDeliveryError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "RelationalTruthDeliveryError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new RelationalTruthDeliveryError(`Invalid relational truth delivery ${field}: ${reason}`, {
    code: "RELATIONAL_TRUTH_DELIVERY_INVALID",
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

function sha256PostgresJsonb(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(canonicalize(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
}

function requireHash(value, field) {
  const hash = text(value);
  if (!HASH_RE.test(hash)) throw invalid(field, "must be lowercase SHA-256 hex");
  return hash;
}

function requireProcessingWatermark(value, field) {
  try {
    return validateProcessingWatermarkFields(value, { field });
  } catch (cause) {
    throw invalid(cause?.field || field, cause?.message || "is invalid");
  }
}

function requireSameProcessingWatermark(left, right, field) {
  if (left.status !== right.status || left.watermarkHash !== right.watermarkHash ||
      stableJson(left.watermark) !== stableJson(right.watermark)) {
    throw invalid(field, "does not match the server-derived build watermark");
  }
}

function isoTimestamp(value, field) {
  const raw = text(value);
  const parsed = Date.parse(raw);
  if (!raw || !Number.isFinite(parsed)) throw invalid(field, "must be a timestamp");
  return new Date(parsed).toISOString();
}

function normalizeShipmentKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 11) throw invalid("shipmentKey", "must contain exactly eleven digits");
  return digits;
}

function displayAwb(value) {
  const digits = normalizeShipmentKey(value);
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function cloneDetails(value) {
  if (value === undefined || value === null) return {};
  return canonicalize(value, "shipmentMetadata.details");
}

function normalizedClaimEnvelopeRows(value) {
  if (!Array.isArray(value)) throw invalid("claimEnvelopes", "must be an array");
  const result = new Map();
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) throw invalid(`claimEnvelopes[${index}]`, "must be an object");
    const claimVersionId = text(item.claimVersionId || item.claim_version_id);
    if (!/^claim:v1:[0-9a-f]{64}$/.test(claimVersionId)) {
      throw invalid(`claimEnvelopes[${index}].claimVersionId`, "is invalid");
    }
    const canonicalEnvelope = item.canonicalEnvelope || item.canonical_envelope || item.envelope || item;
    const claim = canonicalEnvelope.claim || item.claim || {};
    const evidence = Array.isArray(canonicalEnvelope.evidence || item.evidence)
      ? canonicalEnvelope.evidence || item.evidence
      : [];
    result.set(claimVersionId, { claimVersionId, claim: canonicalize(claim), evidence: canonicalize(evidence) });
  }
  return result;
}

function verifyReducedPacket(packet) {
  if (!isPlainObject(packet)) throw invalid("reducedPacket", "must be an object");
  const packetHash = requireHash(packet.packetHash, "reducedPacket.packetHash");
  const preimage = canonicalize(packet);
  delete preimage.packetHash;
  if (sha256Json(preimage) !== packetHash) throw invalid("reducedPacket.packetHash", "does not match its canonical payload");
  const exclusions = packet.sourceWatermark?.documentedGapExclusions;
  const exclusionHash = packet.sourceWatermark?.documentedGapExclusionHash;
  const documentedDegradedCut = packet.sourceCut?.completeness === "degraded"
    && Array.isArray(exclusions) && exclusions.length > 0
    && /^[0-9a-f]{64}$/.test(String(exclusionHash || ""))
    && sha256Json(exclusions) === exclusionHash;
  if (!isPlainObject(packet.sourceCut)
    || (packet.sourceCut.completeness !== "complete" && !documentedDegradedCut)) {
    throw invalid("reducedPacket.sourceCut", "must be complete or carry a frozen documented-gap witness");
  }
  if (!Array.isArray(packet.shipments) || !Array.isArray(packet.acceptedClaimCitations)) {
    throw invalid("reducedPacket", "must contain shipments and acceptedClaimCitations arrays");
  }
  return packetHash;
}

function gateByName(shipment) {
  return new Map((Array.isArray(shipment.gates) ? shipment.gates : []).map((gate) => [text(gate.gate), gate]));
}

function rawGateStatus(gate) {
  const status = text(gate?.status);
  if (status === "true") return "done";
  if (status === "blocked") return "blocked";
  if (status === "contradicted") return "contradicted";
  return "unknown";
}

function nextActionForShipment(shipment, gates) {
  const activeException = (shipment.exceptions || []).find((item) => item.status === "active");
  if (activeException) {
    return {
      label: `Resolve ${text(activeException.gate) || "shipment"} exception: ${text(activeException.predicate) || "conflicting evidence"}.`,
      sourceFactIds: [...new Set(activeException.claimVersionIds || [])].sort(),
    };
  }
  const actionByGate = {
    arrival: "Verify destination arrival/on-hand status.",
    customs: "Obtain or verify customs release and delivery order.",
    fees: "Verify station fees and payment status.",
    dispatch: "Confirm broker, carrier, and driver dispatch.",
    pickup: "Confirm pickup or recovery completion.",
    delivery: "Confirm final delivery status.",
    pod: "Collect and verify signed POD.",
  };
  const unresolved = GATE_ORDER.map((name) => gates.get(name)).find((gate) => gate?.status !== "true");
  if (!unresolved) return { label: "No action; all shipment gates are evidenced.", sourceFactIds: [] };
  return {
    label: actionByGate[unresolved.gate] || "Review shipment truth.",
    sourceFactIds: [...new Set([
      ...(unresolved.claimVersionIds || []),
      ...(unresolved.opposingClaimVersionIds || []),
    ])].sort(),
  };
}

function claimSummary(claim) {
  const value = isPlainObject(claim.normalizedValue) ? claim.normalizedValue : {};
  const status = text(value.status || value.effect || claim.polarity);
  return `${text(claim.predicate) || "accepted claim"}${status ? `: ${status}` : ""}`;
}

function publicSourceSystem(sourceClass = "") {
  if (sourceClass === "gmail_parsed_message") return "gmail";
  if (sourceClass === "direct_document_or_pod") return "gmail_attachment";
  return sourceClass || "unknown";
}

function sourceCursor(sourceWatermark = {}, sourceSystem = "") {
  const cursors = Array.isArray(sourceWatermark.cursors) ? sourceWatermark.cursors : [];
  const cursor = cursors.find((item) => text(item.sourceSystem) === sourceSystem) || null;
  if (cursor) return cursor;
  const legacy = sourceWatermark[sourceSystem];
  return isPlainObject(legacy) ? legacy : null;
}

function cursorSnapshotTime(cursor = null) {
  if (!cursor) return "";
  const raw = text(
    cursor.sourceSnapshotAt || cursor.snapshotTime || cursor.upstreamWatermark || cursor.throughCursorValue,
  );
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function sameInstant(left = "", right = "") {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function latestFactTime(facts = []) {
  return facts.map((fact) => text(fact.observedAt || fact.capturedAt))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .pop() || "";
}

function sourceFactsForShipment(shipment, citations, envelopeMap) {
  return [...new Set(shipment.acceptedClaimIds || [])].sort().map((claimVersionId) => {
    const citation = citations.get(claimVersionId) || {};
    const envelope = envelopeMap.get(claimVersionId) || { claim: {}, evidence: [] };
    const claim = envelope.claim;
    const evidenceObservationIds = Array.isArray(citation.evidenceObservationIds)
      ? citation.evidenceObservationIds
      : envelope.evidence.map((item) => text(item.observationId || item.observation_id)).filter(Boolean);
    const primarySpan = claim.evidenceSpan || claim.evidence_span || envelope.evidence[0]?.evidenceSpan || {};
    const sourceClass = text(citation.sourceClass) || text(claim.sourceSystem) || "unknown";
    return {
      id: claimVersionId,
      awbs: [shipment.shipmentKey],
      type: text(claim.predicate) || "accepted_claim",
      sourceSystem: publicSourceSystem(sourceClass),
      sourceClass,
      sourceRef: {
        observationIds: [...new Set(evidenceObservationIds)].sort(),
        threadId: text(claim.sourceThreadId),
        messageId: text(claim.sourceMessageId),
        attachmentId: text(primarySpan.attachmentId),
      },
      observedAt: text(claim.occurredAt || claim.occurred_at),
      capturedAt: text(claim.capturedAt || claim.captured_at || claim.sourceCapturedAt),
      actor: text(claim.normalizedValue?.responsibleActor || citation.responsibleActor),
      claim: claimSummary(claim),
      confidenceInput: text(claim.confidenceLabel || claim.confidence_label) || "unknown",
      rawSnippet: text(primarySpan.quote || primarySpan.valuePreview).slice(0, 500),
    };
  });
}

function innerGate(gate) {
  return {
    gate: gate.gate,
    status: gate.status,
    rawStatus: rawGateStatus(gate),
    confidence: text(gate.confidence) || "unknown",
    sourceFactIds: [...new Set(gate.claimVersionIds || [])].sort(),
    reason: text(gate.reason),
    updatedAt: "",
  };
}

function shipmentDeliveryRow(shipment, context) {
  const shipmentKey = normalizeShipmentKey(shipment.shipmentKey);
  const gates = gateByName(shipment);
  const sourceFacts = sourceFactsForShipment(shipment, context.citations, context.envelopes);
  const gmailFacts = sourceFacts.filter((fact) => ["gmail", "gmail_attachment"].includes(fact.sourceSystem));
  const nextAction = nextActionForShipment(shipment, gates);
  const state = text(shipment.currentState?.value) || "unknown";
  const completed = gates.get("delivery")?.status === "true" && gates.get("pod")?.status === "true";
  const metadata = context.metadataByShipment.get(shipmentKey) || null;
  const sourceDetails = cloneDetails(metadata?.details || {});
  const gateArray = GATE_ORDER.map((name) => innerGate(gates.get(name) || {
    gate: name,
    status: "unknown",
    confidence: "unknown",
    claimVersionIds: [],
    reason: "No accepted claim proves or disproves this gate.",
  }));
  const activeException = (shipment.exceptions || []).find((item) => item.status === "active") || null;
  const physicalLifecycle = {
    status: state,
    label: state.replace(/_/g, " "),
    sourceFactIds: [...new Set(shipment.currentState?.claimVersionIds || [])].sort(),
    reason: text(shipment.currentState?.reason),
  };
  const operationalBlocker = activeException ? {
    type: text(activeException.predicate) || "exception",
    status: "blocked",
    label: text(activeException.gate) || "Shipment exception",
    severity: "attention",
    sourceFactIds: [...new Set(activeException.claimVersionIds || [])].sort(),
    reason: `Accepted ${text(activeException.predicate) || "blocker"} evidence is active.`,
  } : {
    type: "none",
    status: "clear",
    label: "No active blocker",
    severity: "none",
    sourceFactIds: [],
    reason: "No accepted blocker currently wins a shipment gate.",
  };
  const unknowns = gateArray.filter((gate) => gate.status === "unknown").map((gate) => ({
    gate: gate.gate,
    reason: gate.reason,
  }));
  let commercialConversation;
  try {
    commercialConversation = evaluateCommercialDeadlines(
      shipment.commercialConversation,
      context.compiledAt,
    );
  } catch (cause) {
    throw invalid("shipment.commercialConversation", cause?.message || "is invalid");
  }
  const truthPacket = {
    shipmentId: shipmentKey,
    awbs: [shipmentKey],
    compiledAt: context.compiledAt,
    currentState: state,
    resolvedCurrentState: state,
    stateConfidence: activeException ? "disputed" : "evidence_bound",
    stateReason: text(shipment.currentState?.reason),
    physicalLifecycle,
    operationalBlocker,
    feeLedger: {
      status: gates.get("fees")?.status === "true" ? "settled" : gates.get("fees")?.status === "blocked" ? "due" : "unknown",
      reason: text(gates.get("fees")?.reason),
      sourceFactIds: [...new Set(gates.get("fees")?.claimVersionIds || [])].sort(),
    },
    documentRequestBlocker: {
      type: (shipment.openRequests || []).length ? "open_request" : "none",
      status: (shipment.openRequests || []).some((item) => item.status === "open") ? "open" : "clear",
      reason: (shipment.openRequests || []).filter((item) => item.status === "open")
        .map((item) => text(item.predicate)).filter(Boolean).join(", "),
      sourceFactIds: [...new Set((shipment.openRequests || []).flatMap((item) => item.claimVersionIds || []))].sort(),
    },
    commercialConversation,
    gates: gateArray,
    contradictions: (shipment.contradictions || []).map((item) => ({
      id: text(item.contradictionId),
      claim: `Conflicting accepted claims for ${text(item.gate)} resolved by ${text(item.resolution)}.`,
      severity: "attention",
      operatorMessage: "Review the cited source evidence before acting on the losing claim.",
      resolutionAction: "review_truth_evidence",
      sourceFactIds: [...new Set(item.claimVersionIds || [])].sort(),
      winnerSourceFactId: text(item.winnerClaimVersionId),
    })),
    unknowns,
    exceptions: (shipment.exceptions || []).map((item) => ({
      id: text(item.exceptionId),
      gate: text(item.gate),
      type: text(item.predicate),
      status: text(item.status),
      sourceFactIds: [...new Set(item.claimVersionIds || [])].sort(),
    })),
    nextAction,
  };
  return {
    id: shipmentKey,
    awb: displayAwb(shipmentKey),
    order: text(sourceDetails.orderId),
    shipmentNumber: text(sourceDetails.orderId),
    client: text(sourceDetails.client),
    station: text(sourceDetails.station || sourceDetails.destination),
    origin: text(sourceDetails.origin),
    destination: text(sourceDetails.destination),
    airline: text(sourceDetails.airline),
    cargo: cloneDetails(sourceDetails.cargo || {}),
    flightDetails: cloneDetails(sourceDetails.flightDetails || {}),
    route: text(sourceDetails.route),
    delivery: cloneDetails(sourceDetails.delivery || {}),
    commercialConversation,
    currentState: state,
    nextAction: nextAction.label,
    pickupStatus: gates.get("pickup")?.status === "true" ? "picked up" : rawGateStatus(gates.get("pickup")),
    deliveryStatus: gates.get("delivery")?.status === "true" ? "delivered" : rawGateStatus(gates.get("delivery")),
    completed,
    completedAt: completed ? context.compiledAt : "",
    deliveredAt: gates.get("delivery")?.status === "true" ? context.compiledAt : "",
    freightBroker: cloneDetails(sourceDetails.freightBroker || {}),
    customsBroker: cloneDetails(sourceDetails.customsBroker || {}),
    contacts: cloneDetails(sourceDetails.contacts || {}),
    opsState: {
      phase: state,
      label: state.replace(/_/g, " "),
      summary: text(shipment.currentState?.reason),
      nextAction: nextAction.label,
      gates: Object.fromEntries(gateArray.map((gate) => [gate.gate, {
        name: gate.gate,
        status: gate.rawStatus,
        label: gate.gate,
        evidence: gate.reason,
        confidence: gate.confidence,
        source: "relational-accepted-claims",
        at: "",
      }])),
    },
    sourceEvents: [],
    sourceProof: sourceFacts,
    sourceCoverage: {
      completeSourceCut: context.completeSourceCut,
      sourceCutCompleteness: context.sourceCutCompleteness,
      sourceCutId: context.sourceCutId,
      acceptedClaimCount: sourceFacts.length,
      relationalCoverage: {
        schemaVersion: "relational-row-source-coverage-v1",
        sourceCutId: context.sourceCutId,
        sourceCutCompleteness: context.sourceCutCompleteness,
        acceptedClaimCount: sourceFacts.length,
        acceptedGmailClaimCount: gmailFacts.length,
        gmailCursorVersion: text(context.gmailCursor?.throughCursorVersion || context.gmailCursor?.cursorVersion),
        gmailCursorValue: text(
          context.gmailCursor?.throughCursorValue || context.gmailCursor?.upstreamWatermark || context.gmailCursor?.historyId,
        ),
        processingWatermarkStatus: context.processingWatermark.status,
        processingWatermarkHash: context.processingWatermark.watermarkHash,
      },
      contradictionCount: (shipment.contradictions || []).length,
      unknownGateCount: unknowns.length,
      shipmentMetadataVersionId: metadata?.metadataVersionId || "",
      shipmentMetadataObservationId: metadata?.sourceObservationId || "",
      shipmentMetadataSnapshotTime: metadata?.snapshotTime || "",
    },
    gmailCoverage: {
      status: gmailFacts.length ? "covered" : "relational-cut-covered",
      problem: false,
      reason: gmailFacts.length
        ? "Accepted Gmail evidence is bound to the exact relational source cut."
        : "The exact relational Gmail cut is present; this row makes no Gmail-dependent state claim.",
      sourceCutId: context.sourceCutId,
      latestProofMessageAt: latestFactTime(gmailFacts),
      acceptedClaimCount: gmailFacts.length,
      relational: true,
    },
    evidencePacket: {
      schemaVersion: "relational-evidence-packet-v1",
      sourceFacts,
      freshness: {
        hasGmailEvidence: gmailFacts.length > 0,
        gmailCoverageStatus: gmailFacts.length ? "covered" : "relational-cut-covered",
        gmailCoverageProblem: false,
      },
      unknowns,
      contradictions: truthPacket.contradictions,
    },
    canonicalAuthority: {
      source: "relational-truth-ledger",
      sourceCutId: context.sourceCutId,
      reducerPacketHash: context.reducerPacketHash,
      inputManifestHash: context.inputManifestHash,
      processingWatermarkStatus: context.processingWatermark.status,
      processingWatermarkHash: context.processingWatermark.watermarkHash,
    },
    _truthPacketSource: "relational-truth-ledger",
    _truthPacketSnapshotTime: context.compiledAt,
    truthPacketRole: completed ? "completed" : "active",
    truthPacket,
    recommendedActions: [],
    actionHistory: [],
  };
}

function buildRelationalTruthDelivery(input = {}) {
  if (!isPlainObject(input)) throw invalid("input", "must be an object");
  if (Object.hasOwn(input, "sourceDetailsByShipment")) {
    throw invalid(
      "sourceDetailsByShipment",
      "caller-supplied shipment metadata is forbidden; use the sealed build-bundle envelopes",
    );
  }
  const reducedPacket = input.reducedPacket;
  const reducerPacketHash = verifyReducedPacket(reducedPacket);
  const processingWatermark = requireProcessingWatermark(input, "input");
  const reducerProcessingWatermark = requireProcessingWatermark(reducedPacket, "reducedPacket");
  requireSameProcessingWatermark(
    processingWatermark,
    reducerProcessingWatermark,
    "reducedPacket.processingWatermark",
  );
  const compiledAt = isoTimestamp(input.compiledAt, "compiledAt");
  const envelopes = normalizedClaimEnvelopeRows(input.claimEnvelopes || []);
  const citations = new Map(reducedPacket.acceptedClaimCitations.map((citation, index) => {
    const id = text(citation.claimVersionId);
    if (!/^claim:v1:[0-9a-f]{64}$/.test(id)) throw invalid(`acceptedClaimCitations[${index}]`, "has invalid claim ID");
    return [id, citation];
  }));
  let shipmentMetadata;
  try {
    shipmentMetadata = normalizeShipmentMetadataEnvelopes(
      input.shipmentMetadataEnvelopes || [],
      { expectedManifestHash: reducedPacket.shipmentMetadataManifestHash },
    );
  } catch (cause) {
    throw invalid("shipmentMetadataEnvelopes", cause?.message || "is invalid");
  }
  const reducedMetadataCitations = Array.isArray(reducedPacket.shipmentMetadataCitations)
    ? reducedPacket.shipmentMetadataCitations.map((row) => ({
      metadataVersionId: text(row.metadataVersionId),
      envelopeHash: text(row.envelopeHash),
      shipmentKey: text(row.shipmentKey),
      sourceObservationId: text(row.sourceObservationId),
      sourceObservationContentHash: text(row.sourceObservationContentHash),
    })).sort((left, right) => left.metadataVersionId.localeCompare(right.metadataVersionId))
    : [];
  const suppliedMetadataCitations = shipmentMetadata.rows.map((row) => ({
    metadataVersionId: row.metadataVersionId,
    envelopeHash: row.envelopeHash,
    shipmentKey: row.shipmentKey,
    sourceObservationId: row.sourceObservationId,
    sourceObservationContentHash: row.sourceObservationContentHash,
  })).sort((left, right) => left.metadataVersionId.localeCompare(right.metadataVersionId));
  if (stableJson(reducedMetadataCitations) !== stableJson(suppliedMetadataCitations)) {
    throw invalid("shipmentMetadataEnvelopes", "do not exactly match reducer metadata citations");
  }
  for (const shipment of reducedPacket.shipments) {
    for (const claimVersionId of shipment.acceptedClaimIds || []) {
      if (!citations.has(claimVersionId)) throw invalid("reducedPacket.shipments.acceptedClaimIds", `citation is missing for ${claimVersionId}`);
    }
  }
  const acceptedClaimManifestHash = sha256Json([...citations.values()].map((citation) => ({
    claimVersionId: citation.claimVersionId,
    envelopeHash: citation.envelopeHash,
    activeReducerInput: citation.activeReducerInput === true,
  })).sort((left, right) => left.claimVersionId.localeCompare(right.claimVersionId)));
  const exclusions = reducedPacket.sourceWatermark?.documentedGapExclusions || [];
  const exclusionHash = reducedPacket.sourceWatermark?.documentedGapExclusionHash || "";
  const documentedDegradedCut = reducedPacket.sourceCut.completeness === "degraded";
  const sourceCutId = text(reducedPacket.sourceCut.sourceCutId);
  if (!sourceCutId) throw invalid("reducedPacket.sourceCut.sourceCutId", "must not be empty");
  const truthProvenance = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    sourceCutId,
    reducerPacketHash,
    inputManifestHash: requireHash(reducedPacket.inputManifestHash, "reducedPacket.inputManifestHash"),
    reducerVersion: text(reducedPacket.reducerVersion),
    precedencePolicyVersion: text(reducedPacket.precedencePolicy?.policyVersion),
    precedencePolicyHash: requireHash(reducedPacket.precedencePolicy?.policyHash, "reducedPacket.precedencePolicy.policyHash"),
    acceptedClaimManifestHash,
    shipmentMetadataManifestHash: requireHash(
      reducedPacket.shipmentMetadataManifestHash,
      "reducedPacket.shipmentMetadataManifestHash",
    ),
    processingWatermarkStatus: processingWatermark.status,
    processingWatermark: processingWatermark.watermark,
    processingWatermarkHash: processingWatermark.watermarkHash,
    ...(documentedDegradedCut ? {
      sourceCutCompleteness: "degraded",
      documentedGapExclusions: canonicalize(exclusions),
      documentedGapExclusionHash: exclusionHash,
    } : {}),
  };
  if (!truthProvenance.reducerVersion || !truthProvenance.precedencePolicyVersion) {
    throw invalid("truthProvenance", "requires reducer and precedence-policy versions");
  }
  const context = {
    compiledAt,
    citations,
    envelopes,
    metadataByShipment: shipmentMetadata.byShipment,
    sourceCutId,
    reducerPacketHash,
    inputManifestHash: truthProvenance.inputManifestHash,
    processingWatermark,
    sourceCutCompleteness: documentedDegradedCut ? "degraded" : "complete",
    completeSourceCut: !documentedDegradedCut,
    gmailCursor: sourceCursor(reducedPacket.sourceWatermark || {}, "gmail"),
  };
  const shipments = reducedPacket.shipments
    .filter((shipment) => (
      (Array.isArray(shipment.acceptedClaimIds) && shipment.acceptedClaimIds.length > 0)
      || shipmentMetadata.byShipment.has(normalizeShipmentKey(shipment.shipmentKey))
    ))
    .map((shipment) => shipmentDeliveryRow(shipment, context))
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeAwbs = shipments.filter((shipment) => !shipment.completed).map((shipment) => shipment.awb).sort();
  const completedAwbs = shipments.filter((shipment) => shipment.completed).map((shipment) => shipment.awb).sort();
  const tmsCursor = sourceCursor(reducedPacket.sourceWatermark || {}, "tms");
  const tmsSnapshotTime = cursorSnapshotTime(tmsCursor);
  const tmsActiveAwbs = shipments.filter((shipment) => (
    sameInstant(shipment.sourceCoverage?.shipmentMetadataSnapshotTime, tmsSnapshotTime)
    && (shipment.sourceProof || []).some((fact) => (
      fact.type === "shipment_observed_in_tms"
      && fact.sourceSystem === "tms"
      && sameInstant(fact.observedAt || fact.capturedAt, tmsSnapshotTime)
    ))
  )).map((shipment) => shipment.awb).sort();
  const delivery = {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    snapshotTime: compiledAt,
    sourceOfTruth: "relational-truth-ledger",
    writerVersion: DELIVERY_BUILDER_VERSION,
    packetHash: reducerPacketHash,
    counts: { total: shipments.length, active: activeAwbs.length, completed: completedAwbs.length },
    activeAwbs,
    completedAwbs,
    sourceAudit: {
      sourceCutId,
      tmsActiveAwbs,
      tmsSnapshotTime,
      sourceCutManifestHash: text(reducedPacket.sourceCut.manifestHash),
      completeSourceCut: !documentedDegradedCut,
      ...(documentedDegradedCut ? {
        sourceCutCompleteness: "degraded",
        documentedGapExclusions: canonicalize(exclusions),
        documentedGapExclusionHash: exclusionHash,
      } : {}),
      reducerVersion: truthProvenance.reducerVersion,
      deliveryBuilderVersion: DELIVERY_BUILDER_VERSION,
      precedencePolicyVersion: truthProvenance.precedencePolicyVersion,
      precedencePolicyHash: truthProvenance.precedencePolicyHash,
      sourceWatermark: canonicalize(reducedPacket.sourceWatermark || {}),
      processingWatermarkStatus: processingWatermark.status,
      processingWatermarkHash: processingWatermark.watermarkHash,
    },
    processingWatermarkStatus: processingWatermark.status,
    processingWatermark: processingWatermark.watermark,
    processingWatermarkHash: processingWatermark.watermarkHash,
    truthProvenance,
    shipments,
  };
  return deepFreeze(delivery);
}

function deliveryPayloadHash(deliveryPacket) {
  if (!isPlainObject(deliveryPacket)) throw invalid("deliveryPacket", "must be an object");
  const preimage = canonicalize(deliveryPacket);
  delete preimage.deliveryPayloadHash;
  delete preimage.contentSignature;
  return sha256PostgresJsonb(preimage);
}

function finalizePublishedTruthDelivery(input = {}) {
  if (!isPlainObject(input) || !isPlainObject(input.deliveryPacket) || !isPlainObject(input.publication)) {
    throw invalid("input", "requires deliveryPacket and publication objects");
  }
  const packet = canonicalize(input.deliveryPacket, "deliveryPacket");
  const packetProcessingWatermark = requireProcessingWatermark(packet, "deliveryPacket");
  const publicationProcessingWatermark = requireProcessingWatermark(input.publication, "publication");
  requireSameProcessingWatermark(
    packetProcessingWatermark,
    publicationProcessingWatermark,
    "publication.processingWatermark",
  );
  if (packet.deliveryPayloadHash !== undefined || packet.contentSignature !== undefined) {
    throw invalid("deliveryPacket", "must not already contain publication delivery hashes");
  }
  const publicationId = text(input.publication.publicationId);
  if (!UUID_RE.test(publicationId)) throw invalid("publication.publicationId", "must be a UUID");
  const publicationVersion = Number(input.publication.publicationVersion);
  if (!Number.isSafeInteger(publicationVersion) || publicationVersion < 1) {
    throw invalid("publication.publicationVersion", "must be a positive integer");
  }
  const publicationChannel = text(input.publication.channel);
  if (!new Set(["shadow", "production"]).has(publicationChannel)) {
    throw invalid("publication.channel", "must be shadow or production");
  }
  const sourceCutId = text(input.publication.sourceCutId);
  const packetHash = requireHash(input.publication.packetHash, "publication.packetHash");
  if (sourceCutId !== text(packet.truthProvenance?.sourceCutId) || packetHash !== text(packet.packetHash)) {
    throw invalid("publication", "does not match delivery truth provenance");
  }
  const preimage = {
    ...packet,
    publicationId,
    publicationVersion,
    publicationChannel,
    publishedAt: isoTimestamp(input.publication.publishedAt, "publication.publishedAt"),
    publisherVersion: text(input.publication.publisherVersion),
    sourceCutId,
  };
  if (!preimage.publisherVersion) throw invalid("publication.publisherVersion", "must not be empty");
  const hash = deliveryPayloadHash(preimage);
  return deepFreeze({ ...preimage, deliveryPayloadHash: hash, contentSignature: hash });
}

module.exports = {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
  PROVENANCE_SCHEMA_VERSION,
  RelationalTruthDeliveryError,
  buildRelationalTruthDelivery,
  deliveryPayloadHash,
  finalizePublishedTruthDelivery,
  _test: {
    canonicalize,
    displayAwb,
    sha256Json,
    sha256PostgresJsonb,
    stableJson,
  },
};

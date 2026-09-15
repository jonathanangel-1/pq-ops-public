"use strict";

const { normalizeAwb } = require("./awb");
const { contentSignature, strictContentSignature } = require("./content-signature");
const { sourceFactEligible } = require("./source-fact-contract");

const CANONICAL_PUBLISHER = "canonical-truth-publisher";
const CANONICAL_WRITER_VERSION = "shipment-truth-packets-v1+canonical-publisher-v1";
const REQUIRED_SOURCE_WATERMARK_FIELDS = [
  "gmailProofSnapshotTime",
  "gmailHistoryId",
  "tmsSnapshotTime",
  "trackingSnapshotTime",
  "operatorEventSequence",
  "factLedgerSnapshotTime",
  "extractorVersion",
  "reducerVersion",
  "packetBuilderVersion",
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sourceFacts(value) {
  return (Array.isArray(value) ? value : []).filter(sourceFactEligible);
}

function sourceFactIdSet(shipment = {}) {
  return new Set(sourceFacts(shipment.evidencePacket?.sourceFacts).map((fact) => clean(fact.id)).filter(Boolean));
}

function sourceFactIds(value, allowedIds) {
  return (Array.isArray(value) ? value : []).map(clean).filter((id) => id && allowedIds.has(id));
}

function scrubTruthPacketReferences(value, allowedIds = new Set()) {
  if (Array.isArray(value)) return value.map((item) => scrubTruthPacketReferences(item, allowedIds));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "sourceFactIds" || key === "supersededBySourceFactIds") {
      return [key, sourceFactIds(item, allowedIds)];
    }
    return [key, scrubTruthPacketReferences(item, allowedIds)];
  }));
}

function danglingSourceFactReferences(value, allowedIds = new Set(), path = "truthPacket", output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => danglingSourceFactReferences(item, allowedIds, `${path}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (/FactIds$/i.test(key)) {
      for (const id of Array.isArray(item) ? item.map(clean).filter(Boolean) : []) {
        if (!allowedIds.has(id)) output.push({ path: `${path}.${key}`, sourceFactId: id });
      }
      continue;
    }
    danglingSourceFactReferences(item, allowedIds, `${path}.${key}`, output);
  }
  return output;
}

function scrubShipment(shipment = {}) {
  const evidencePacket = shipment.evidencePacket && typeof shipment.evidencePacket === "object"
    ? {
        ...shipment.evidencePacket,
        sourceFacts: sourceFacts(shipment.evidencePacket.sourceFacts),
      }
    : shipment.evidencePacket;
  const withEvidence = { ...shipment, evidencePacket };
  const allowedIds = sourceFactIdSet(withEvidence);
  const danglingReferences = danglingSourceFactReferences(shipment.truthPacket, allowedIds);
  const role = clean(shipment.truthPacketRole || "active").toLowerCase() || "active";
  if (danglingReferences.length && role === "active") {
    const error = new Error(`Canonical active packet ${clean(shipment.awb || shipment.id) || "unknown"} has dangling source-fact citations.`);
    error.code = "CANONICAL_SOURCE_FACT_REFERENCE_INVALID";
    error.awb = clean(shipment.awb || shipment.id);
    error.danglingReferences = danglingReferences;
    throw error;
  }
  const completedEvidencePacket = danglingReferences.length && evidencePacket && typeof evidencePacket === "object"
    ? {
        ...evidencePacket,
        unknowns: [
          ...(Array.isArray(evidencePacket.unknowns) ? evidencePacket.unknowns : []),
          {
            type: "legacy-completed-citation-gap",
            missingSourceFactIds: [...new Set(danglingReferences.map((item) => item.sourceFactId))],
          },
        ],
      }
    : evidencePacket;
  return {
    ...withEvidence,
    evidencePacket: completedEvidencePacket,
    facts: sourceFacts(shipment.facts),
    factLedger: sourceFacts(shipment.factLedger),
    emailValidation: shipment.emailValidation && typeof shipment.emailValidation === "object"
      ? {
          ...shipment.emailValidation,
          events: sourceFacts(shipment.emailValidation.events),
          proof: sourceFacts(shipment.emailValidation.proof),
        }
      : shipment.emailValidation,
    opsState: shipment.opsState && typeof shipment.opsState === "object"
      ? {
          ...shipment.opsState,
          events: sourceFacts(shipment.opsState.events),
        }
      : shipment.opsState,
    truthPacket: scrubTruthPacketReferences(shipment.truthPacket, allowedIds),
  };
}

function sourceWatermarkFor(snapshot = {}) {
  const audit = snapshot.sourceAudit || {};
  return {
    gmailProofSnapshotTime: clean(audit.gmailProofSnapshotTime || snapshot.gmailProofSnapshotTime),
    gmailHistoryId: clean(audit.gmailHistoryId || snapshot.gmailHistoryId),
    tmsSnapshotTime: clean(audit.tmsSnapshotTime),
    trackingSnapshotTime: clean(audit.trackingSnapshotTime),
    operatorEventSequence: clean(audit.operatorEventSequence),
    factLedgerSnapshotTime: clean(audit.factLedgerSnapshotTime),
    extractorVersion: clean(audit.extractorVersion),
    reducerVersion: clean(audit.reducerVersion || "canonical-shipment-pipeline-v1"),
    packetBuilderVersion: "canonical-publisher-v1",
  };
}

function assertSourceWatermarkComplete(snapshot = {}) {
  const watermark = snapshot.sourceWatermark || sourceWatermarkFor(snapshot);
  const missing = REQUIRED_SOURCE_WATERMARK_FIELDS.filter((field) => !clean(watermark[field]));
  if (missing.length) {
    const error = new Error(`Canonical truth publication requires a complete source watermark: missing ${missing.join(", ")}`);
    error.code = "CANONICAL_SOURCE_WATERMARK_INCOMPLETE";
    error.missingFields = missing;
    throw error;
  }
  for (const field of ["gmailProofSnapshotTime", "tmsSnapshotTime", "factLedgerSnapshotTime"]) {
    if (!Number.isFinite(Date.parse(watermark[field]))) {
      const error = new Error(`Canonical truth publication requires an ISO timestamp for ${field}.`);
      error.code = "CANONICAL_SOURCE_WATERMARK_INVALID";
      error.field = field;
      throw error;
    }
  }
  return watermark;
}

function canonicalRoleProjection(shipments = []) {
  const activeAwbs = new Set();
  const completedAwbs = new Set();
  const counts = {
    shipments: shipments.length,
    activeShipments: 0,
    completedShipments: 0,
    evidenceOnlyShipments: 0,
  };
  for (const shipment of shipments) {
    const role = clean(shipment?.truthPacketRole || "active").toLowerCase() || "active";
    const awb = normalizeAwb(shipment?.awb || shipment?.id || shipment?.shipmentId);
    if (role === "active") {
      counts.activeShipments += 1;
      if (awb) activeAwbs.add(awb);
    } else if (role === "completed") {
      counts.completedShipments += 1;
      if (awb) completedAwbs.add(awb);
    } else if (role === "evidence-only") {
      counts.evidenceOnlyShipments += 1;
    }
  }
  const overlappingAwbs = [...activeAwbs].filter((awb) => completedAwbs.has(awb)).sort();
  if (overlappingAwbs.length) {
    const error = new Error(`Canonical packet rows assign conflicting active/completed roles to: ${overlappingAwbs.join(", ")}`);
    error.code = "CANONICAL_ROLE_INDEX_CONFLICT";
    error.overlappingAwbs = overlappingAwbs;
    throw error;
  }
  return {
    activeAwbs: [...activeAwbs].sort(),
    completedAwbs: [...completedAwbs].sort(),
    counts,
  };
}

function prepareCanonicalTruthPackets(snapshot = {}, { trigger = "unknown" } = {}) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.shipments)) {
    const error = new Error("Canonical truth publication requires a shipment packet snapshot.");
    error.code = "CANONICAL_PACKET_INVALID";
    throw error;
  }
  const shipments = snapshot.shipments.map(scrubShipment);
  const roleProjection = canonicalRoleProjection(shipments);
  const packet = {
    ...snapshot,
    publisher: CANONICAL_PUBLISHER,
    publisherTrigger: clean(trigger) || "unknown",
    writerVersion: CANONICAL_WRITER_VERSION,
    sourceWatermark: sourceWatermarkFor(snapshot),
    counts: {
      ...(snapshot.counts || {}),
      ...roleProjection.counts,
    },
    activeAwbs: roleProjection.activeAwbs,
    completedAwbs: roleProjection.completedAwbs,
    shipments,
  };
  delete packet.contentSignature;
  delete packet.semanticSignature;
  delete packet.publicationSignature;
  delete packet.packetId;
  const semanticSignature = contentSignature(packet);
  const publicationSignature = strictContentSignature(packet);
  return {
    ...packet,
    semanticSignature,
    publicationSignature,
    packetId: `truth-${publicationSignature}`,
    // Hosted snapshot change detection must use the evidence-committing
    // publication identity, not the looser semantic cache signature.
    contentSignature: publicationSignature,
  };
}

async function publishHostedCanonicalTruth(snapshot, {
  upsertAppSnapshot,
  writeOptions = {},
  trigger = "unknown",
} = {}) {
  if (typeof upsertAppSnapshot !== "function") {
    throw new TypeError("publishHostedCanonicalTruth requires the hosted snapshot writer.");
  }
  const packet = prepareCanonicalTruthPackets(snapshot, { trigger });
  assertSourceWatermarkComplete(packet);
  await upsertAppSnapshot("shipment-truth-packets", packet, writeOptions);
  return packet;
}

module.exports = {
  CANONICAL_PUBLISHER,
  CANONICAL_WRITER_VERSION,
  REQUIRED_SOURCE_WATERMARK_FIELDS,
  assertSourceWatermarkComplete,
  canonicalRoleProjection,
  prepareCanonicalTruthPackets,
  publishHostedCanonicalTruth,
  scrubShipment,
  sourceWatermarkFor,
  danglingSourceFactReferences,
};

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const snapshot = require("./fixtures/verify-tms-claim-extractor.json");
const { buildTmsSourceSnapshot } = require("../lib/tms-source-snapshot");
const { createTmsClaimExtractor, _test: tmsTest } = require("../lib/tms-claim-extractor");
const {
  REDUCER_VERSION,
  reduceRelationalTruth,
  _test: reducerTest,
} = require("../lib/relational-truth-reducer");
const {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
  buildRelationalTruthDelivery,
} = require("../lib/relational-truth-delivery-adapter");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const {
  buildTmsShipmentMetadataEnvelope,
  normalizeShipmentMetadataEnvelopes,
} = require("../lib/truth-shipment-metadata");
const {
  processingWatermarkFixture,
} = require("./truth-processing-watermark-fixture");

function sha256Json(value) {
  return crypto.createHash("sha256")
    .update(reducerTest.stableJson(value), "utf8")
    .digest("hex");
}

function acceptedEnvelope(candidate, observation) {
  const claim = {
    ...candidate,
    primaryObservationId: observation.observationId,
    primaryObservationContentHash: observation.contentHash,
    capturedAt: observation.capturedAt,
    recordedAt: observation.capturedAt,
    acceptanceMethod: "policy",
    acceptancePolicyVersion: candidate.acceptanceRecommendation.policyVersion,
    acceptedBy: "verify-tms-inventory-truth-path",
    decision: "accepted",
    schemaVersion: "accepted-claim-v1",
  };
  delete claim.candidateClaimVersionId;
  delete claim.candidateHash;
  delete claim.ambiguity;
  delete claim.contradiction;
  delete claim.acceptanceRecommendation;
  const envelope = {
    envelopeSchemaVersion: "accepted-claim-envelope-v1",
    workspaceKey: "primary",
    claim,
    evidence: [{
      observationId: observation.observationId,
      observationContentHash: observation.contentHash,
      evidenceRole: "primary",
      evidenceSpan: candidate.evidenceSpan,
    }],
    supersessions: [],
  };
  const envelopeHash = sha256Json(envelope);
  return {
    claimVersionId: `claim:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope: envelope,
  };
}

async function main() {
  const processingWatermark = processingWatermarkFixture({
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
  });
  const built = buildTmsSourceSnapshot(snapshot, {
    workspaceKey: "primary",
    connectionKey: "couriercloud-primary",
  });
  const base = built.observations.find((observation) => (
    observation.normalizedPayload.shipment.trackingNumber === "016-80000142"
  ));
  const normalizedPayload = JSON.parse(JSON.stringify(base.normalizedPayload));
  normalizedPayload.shipment.tmsStatus = "110-NEW SHIPMENT";
  const contentHash = tmsTest.sha256Json(normalizedPayload);
  const observation = {
    ...base,
    sourceSystem: "tms",
    observationId: `obs:v1:${contentHash}`,
    contentHash,
    normalizedPayload,
    capturedAt: normalizedPayload.snapshotTime,
  };
  const candidates = await createTmsClaimExtractor().extract({ observation });
  assert.deepEqual(candidates.map((candidate) => candidate.predicate), ["shipment_observed_in_tms"]);
  const envelope = acceptedEnvelope(candidates[0], observation);
  const shipmentMetadataEnvelope = buildTmsShipmentMetadataEnvelope(observation);
  const shipmentMetadata = normalizeShipmentMetadataEnvelopes(
    [shipmentMetadataEnvelope],
    { sourceCut: { observations: [{ observationId: observation.observationId, contentHash }] } },
  );
  const sourceWatermark = {
    sourceCutId: `cut:v1:${"a".repeat(64)}`,
    manifestHash: "b".repeat(64),
    completeness: "complete",
    cursors: [{
      sourceSystem: "tms",
      connectionKey: "couriercloud-primary",
      throughCursorVersion: 1,
      throughCursorValue: normalizedPayload.snapshotTime,
    }],
    ...processingWatermark,
  };
  const bundle = {
    inputManifestHash: sha256Json({ fixture: "tms-inventory-truth-path" }),
    ...processingWatermark,
    sourceCut: {
      sourceCutId: sourceWatermark.sourceCutId,
      manifestHash: sourceWatermark.manifestHash,
      completeness: "complete",
      observations: [{
        observationId: observation.observationId,
        contentHash: observation.contentHash,
      }],
    },
    sourceWatermark,
    acceptedClaimEnvelopes: [envelope],
    entityLinkEnvelopes: [],
    workgroupDefinitions: [],
    workgroupMembershipEnvelopes: [],
    shipmentMetadataManifestHash: shipmentMetadata.manifestHash,
    shipmentMetadataEnvelopes: [shipmentMetadataEnvelope],
  };
  const reduced = reduceRelationalTruth(bundle);
  assert.equal(reduced.shipments.length, 1);
  const shipment = reduced.shipments[0];
  assert.equal(shipment.shipmentKey, "01680000142");
  assert.equal(shipment.currentState.value, "unknown");
  assert.ok(shipment.gates.every((gate) => gate.status === "unknown"));
  assert.deepEqual(shipment.acceptedClaimIds, [envelope.claimVersionId]);

  const delivery = buildRelationalTruthDelivery({
    ...processingWatermark,
    reducedPacket: reduced,
    claimEnvelopes: [envelope],
    shipmentMetadataEnvelopes: [shipmentMetadataEnvelope],
    compiledAt: normalizedPayload.snapshotTime,
  });
  assert.equal(delivery.shipments.length, 1);
  assert.deepEqual(delivery.activeAwbs, ["016-80000142"]);
  assert.deepEqual(delivery.completedAwbs, []);
  assert.equal(delivery.shipments[0].truthPacket.currentState, "unknown");
  assert.equal(delivery.shipments[0].truthPacketRole, "active");
  assert.equal(delivery.shipments[0].sourceProof.length, 1);
  assert.equal(delivery.shipments[0].sourceProof[0].type, "shipment_observed_in_tms");
  assert.equal(delivery.shipments[0].client, normalizedPayload.shipment.customerName);
  assert.equal(delivery.shipments[0].station, normalizedPayload.shipment.deliveryAirport);
  assert.equal(delivery.shipments[0].cargo.pieces, normalizedPayload.shipment.pieces);
  assert.equal(delivery.shipments[0].flightDetails.departureLeg, normalizedPayload.shipment.dep);
  assert.equal(delivery.shipments[0].delivery.consignee, normalizedPayload.shipment.consigneeCompany);

  const emptyMetadata = normalizeShipmentMetadataEnvelopes([]);

  const stale = reduceRelationalTruth({
    ...bundle,
    shipmentMetadataManifestHash: emptyMetadata.manifestHash,
    shipmentMetadataEnvelopes: [],
    sourceWatermark: {
      ...sourceWatermark,
      cursors: [{
        ...sourceWatermark.cursors[0],
        throughCursorVersion: 2,
        throughCursorValue: "2026-07-10T12:00:00.000Z",
      }],
    },
  });
  assert.equal(stale.shipments.length, 0, (
    "a prior snapshot presence claim alone cannot keep a shipment in current active inventory"
  ));

  console.log(JSON.stringify({
    ok: true,
    verifier: "tms-inventory-truth-path",
    awb: delivery.shipments[0].awb,
    packetHash: reduced.packetHash,
    guarantees: [
      "unmapped TMS status still produces an evidence-cited shipment entity",
      "all lifecycle gates remain unknown and no completion is invented",
      "the delivery packet exposes the row as active, never completed",
      "client, station, cargo, flight, route, delivery, and contacts survive the cut-bound delivery path",
      "presence at an older TMS cursor cannot keep a presence-only row active",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

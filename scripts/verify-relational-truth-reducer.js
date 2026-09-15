#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  EVIDENCE_PRECEDENCE,
  MILESTONE_GATES,
  REDUCER_VERSION,
  reduceRelationalTruth,
  _test,
} = require("../lib/relational-truth-reducer");
const {
  normalizeShipmentMetadataEnvelopes,
  sha256PostgresJsonb,
} = require("../lib/truth-shipment-metadata");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function verifyExtractorSourceClassFallback() {
  const evidence = [{ evidenceSpan: { quote: "sealed source text" } }];
  assert.equal(_test.sourceClassForClaim({
    extractorVersion: "gmail-claim-extractor-v8-model-modality-signal-anchor",
  }, evidence), "gmail_parsed_message");
  assert.equal(_test.sourceClassForClaim({
    extractorVersion: "tms-claim-extractor-v1",
  }, evidence), "tms");
  assert.equal(_test.sourceClassForClaim({
    extractorVersion: "tracking-claim-extractor-v1",
  }, evidence), "tracking");
  assert.equal(_test.sourceClassForClaim({
    extractorVersion: "gmail-claim-extractor-v8-model-modality-signal-anchor",
  }, [{ evidenceSpan: { attachmentId: "sealed-pod.pdf" } }]), "direct_document_or_pod",
  "an explicit attachment citation remains stronger than the Gmail message-lane fallback");
  assert.equal(_test.sourceClassForClaim({
    extractorVersion: "unregistered-extractor-v1",
  }, evidence), "unknown", "arbitrary extractor names cannot claim a stronger source class");
}

function observationId(label) {
  return `obs:v1:${sha256(`observation:${label}`)}`;
}

function claimEnvelope({
  label,
  subjectType = "shipment",
  subjectKey,
  predicate,
  gate,
  polarity = "positive",
  sourceClass = "gmail_parsed_message",
  occurredAt,
  capturedAt = occurredAt,
  recordedAt = capturedAt,
  confidence = 0.95,
  effect,
  speechAct,
  supersedes = [],
  decision = "accepted",
}) {
  const primaryObservationId = observationId(label);
  const normalizedValue = { sourceClass };
  if (effect) normalizedValue.effect = effect;
  if (speechAct) normalizedValue.speechAct = speechAct;
  const envelope = {
    envelopeSchemaVersion: "accepted-claim-envelope-v1",
    workspaceKey: "primary",
    claim: {
      claimKey: `claim-key:${label}`,
      versionNo: 1,
      previousClaimVersionId: "",
      primaryObservationId,
      primaryObservationContentHash: sha256(`observation-content:${label}`),
      subjectType,
      subjectKey,
      predicate,
      gate,
      polarity,
      normalizedValue,
      occurredAt,
      capturedAt,
      recordedAt,
      confidence,
      confidenceLabel: confidence >= 0.9 ? "high" : "medium",
      extractionMethod: sourceClass === "operator" ? "operator" : "deterministic",
      extractorVersion: "fixture-extractor-v1",
      promptVersion: "",
      model: "",
      acceptanceMethod: "policy",
      acceptancePolicyVersion: "fixture-policy-v1",
      acceptedBy: "fixture",
      decision,
      evidenceSpan: { field: sourceClass === "direct_document_or_pod" ? "attachment" : "text" },
      schemaVersion: "accepted-claim-v1",
    },
    evidence: [{
      observationId: primaryObservationId,
      observationContentHash: sha256(`observation-content:${label}`),
      evidenceRole: "primary",
      evidenceSpan: { field: sourceClass === "direct_document_or_pod" ? "attachment" : "text" },
    }],
    supersessions: supersedes.map((target) => ({
      supersededClaimVersionId: target,
      supersededItemHash: target.slice("claim:v1:".length),
      relationship: "corrects",
      policyVersion: "fixture-supersession-v1",
    })),
  };
  const envelopeHash = sha256(_test.stableJson(envelope));
  return {
    claimVersionId: `claim:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope: envelope,
  };
}

function tmsPresenceEnvelope({
  label,
  subjectKey,
  snapshotTime,
  occurredAt = snapshotTime,
  capturedAt = snapshotTime,
  shipmentGuid,
}) {
  const primaryObservationId = observationId(label);
  const observationContentHash = sha256(`observation-content:${label}`);
  const normalizedValue = {
    status: "observed",
    effect: "context",
    sourceClass: "tms",
    responsibleActor: "automated_system",
    evidenceDirectness: "operational_summary",
    tmsStatus: "110-NEW SHIPMENT",
    statusCode: 110,
  };
  const evidenceSpan = {
    kind: "structured_field",
    path: ["shipment", "tmsStatus"],
    valueHash: sha256(JSON.stringify(normalizedValue.tmsStatus)),
    valuePreview: normalizedValue.tmsStatus,
  };
  const envelope = {
    envelopeSchemaVersion: "accepted-claim-envelope-v1",
    workspaceKey: "primary",
    claim: {
      claimKey: `shipment:${subjectKey}:shipment_observed_in_tms`,
      versionNo: 1,
      previousClaimVersionId: "",
      primaryObservationId,
      primaryObservationContentHash: observationContentHash,
      subjectType: "shipment",
      subjectKey,
      predicate: "shipment_observed_in_tms",
      gate: "context",
      polarity: "neutral",
      normalizedValue,
      occurredAt,
      capturedAt,
      recordedAt: capturedAt,
      confidence: 1,
      confidenceLabel: "high",
      extractionMethod: "deterministic",
      extractorVersion: "tms-claim-extractor-fixture-v1",
      promptVersion: "",
      model: "",
      acceptanceMethod: "policy",
      acceptancePolicyVersion: "tms-inventory-fixture-v1",
      acceptedBy: "fixture",
      decision: "accepted",
      evidenceSpan,
      schemaVersion: "accepted-claim-v1",
    },
    evidence: [{
      observationId: primaryObservationId,
      observationContentHash,
      evidenceRole: "primary",
      evidenceSpan,
    }],
    supersessions: [],
  };
  const envelopeHash = sha256(_test.stableJson(envelope));
  return {
    claimVersionId: `claim:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope: envelope,
  };
}

function tmsMetadataEnvelope({ claimEnvelope, shipmentKey, snapshotTime, client = "Fixture client" }) {
  const sourceObservationId = claimEnvelope.canonicalEnvelope.claim.primaryObservationId;
  const sourceObservationContentHash = claimEnvelope.canonicalEnvelope.claim.primaryObservationContentHash;
  const canonicalEnvelope = {
    schemaVersion: "tms-shipment-control-room-metadata-v1",
    workspaceKey: "primary",
    sourceSystem: "tms",
    shipmentKey,
    sourceObservationId,
    sourceObservationContentHash,
    sourceRecordedAt: snapshotTime,
    snapshotTime,
    details: {
      schemaVersion: "tms-control-room-details-v1",
      client,
      station: "JFK",
      route: "TLV-JFK",
      cargo: { pieces: "2" },
      flightDetails: { primaryFlight: "LY001" },
      delivery: { consignee: client },
      freightBroker: { broker: "" },
      customsBroker: { broker: "" },
      contacts: {},
    },
  };
  const envelopeHash = sha256PostgresJsonb(canonicalEnvelope);
  return {
    metadataVersionId: `shipment-metadata:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope,
  };
}

function entityLinkEnvelope({ label, shipmentKey }) {
  const linkedObservationId = observationId(label);
  const envelope = {
    envelopeSchemaVersion: "observation-entity-link-envelope-v1",
    workspaceKey: "primary",
    link: {
      linkKey: `link-key:${label}`,
      versionNo: 1,
      previousLinkVersionId: "",
      observationId: linkedObservationId,
      entityType: "shipment",
      entityKey: shipmentKey,
      relationship: "mentions",
      decision: "linked",
      confidence: 1,
      linkMethod: "deterministic",
      linkerVersion: "fixture-linker-v1",
      evidenceSpan: { field: "subject" },
      recordedAt: "2026-07-09T08:00:00.000Z",
      schemaVersion: "observation-entity-link-v1",
    },
  };
  const envelopeHash = sha256(_test.stableJson(envelope));
  return {
    linkVersionId: `link:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope: envelope,
  };
}

function workgroupDefinition({ label, shipmentKeys }) {
  const identityBasis = {
    shipmentKeys: [...shipmentKeys].sort(),
    brokerKeys: ["broker:fixture"],
    purposes: ["pickup_execution"],
  };
  const envelope = {
    envelopeSchemaVersion: "operational-workgroup-definition-envelope-v1",
    workspaceKey: "primary",
    workgroup: {
      workgroupType: "pickup",
      identityKey: `identity:${sha256(_test.stableJson(identityBasis))}`,
      identityBasis,
      createdMethod: "deterministic",
      linkerVersion: "fixture-linker-v1",
      initialConfidence: 0.85,
      createdAt: "2026-07-09T08:00:00.000Z",
      schemaVersion: "operational-workgroup-v1",
    },
  };
  const definitionHash = sha256(_test.stableJson(envelope));
  return {
    workgroupId: `workgroup:v1:${definitionHash}`,
    definitionHash,
    canonicalDefinition: envelope,
  };
}

function workgroupMembership({ workgroup, shipmentKey, index }) {
  const label = `workgroup-member-${index}-${shipmentKey}`;
  const memberObservationId = observationId(label);
  const envelope = {
    envelopeSchemaVersion: "operational-workgroup-membership-envelope-v1",
    workspaceKey: "primary",
    workgroup: {
      workgroupId: workgroup.workgroupId,
      definitionHash: workgroup.definitionHash,
    },
    membership: {
      membershipKey: `membership:${workgroup.workgroupId}:${shipmentKey}`,
      versionNo: 1,
      previousMembershipVersionId: "",
      memberType: "shipment",
      memberKey: shipmentKey,
      role: "shared_execution_shipment",
      decision: "added",
      confidence: 0.85,
      membershipMethod: "deterministic",
      linkerVersion: "fixture-linker-v1",
      primaryObservationId: memberObservationId,
      basisObservationId: memberObservationId,
      recordedAt: "2026-07-09T08:00:00.000Z",
      schemaVersion: "workgroup-membership-v1",
    },
    evidence: [{
      observationId: memberObservationId,
      evidenceRole: "primary",
      evidenceSpan: { field: "subject", text: shipmentKey },
    }],
  };
  const envelopeHash = sha256(_test.stableJson(envelope));
  return {
    membershipVersionId: `membership:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope: envelope,
  };
}

function observationsFor({ claims, links, memberships }) {
  const rows = new Map();
  for (const item of claims) {
    for (const evidence of item.canonicalEnvelope.evidence) {
      rows.set(evidence.observationId, {
        observationId: evidence.observationId,
        contentHash: evidence.observationContentHash,
      });
    }
  }
  for (const item of links) {
    const observation = item.canonicalEnvelope.link.observationId;
    rows.set(observation, {
      observationId: observation,
      contentHash: sha256(`linked-observation:${observation}`),
    });
  }
  for (const item of memberships) {
    for (const evidence of item.canonicalEnvelope.evidence) {
      rows.set(evidence.observationId, {
        observationId: evidence.observationId,
        contentHash: sha256(`membership-observation:${evidence.observationId}`),
      });
    }
  }
  return [...rows.values()].sort((left, right) => left.observationId.localeCompare(right.observationId));
}

function bundle({
  claims,
  links = [],
  workgroups = [],
  memberships = [],
  shipmentMetadataEnvelopes = [],
  sourceWatermark = null,
  inputManifestHash = sha256("db-authoritative-input-manifest"),
}) {
  const observations = observationsFor({ claims, links, memberships });
  const manifestHash = sha256(_test.stableJson(observations));
  const metadata = normalizeShipmentMetadataEnvelopes(shipmentMetadataEnvelopes, {
    sourceCut: { observations },
  });
  return {
    inputManifestHash,
    sourceCut: {
      sourceCutId: `cut:v1:${manifestHash}`,
      manifestHash,
      completeness: "complete",
      observations,
    },
    sourceWatermark: sourceWatermark || {
      gmail: { cursorVersion: 12, value: "200" },
      tms: { cursorVersion: 4, value: "snapshot-4" },
      tracking: { cursorVersion: 2, value: "snapshot-2" },
      operator: { cursorVersion: 8, value: "8" },
    },
    acceptedClaimEnvelopes: claims,
    entityLinkEnvelopes: links,
    workgroupDefinitions: workgroups,
    workgroupMembershipEnvelopes: memberships,
    shipmentMetadataManifestHash: metadata.manifestHash,
    shipmentMetadataEnvelopes,
  };
}

function verifyTmsInventoryPresence() {
  const currentSnapshot = "2026-07-09T16:00:00.000Z";
  const priorSnapshot = "2026-07-09T15:00:00.000Z";
  const shipmentKey = "01680000205";
  const current = tmsPresenceEnvelope({
    label: "tms-inventory-current",
    subjectKey: shipmentKey,
    snapshotTime: currentSnapshot,
    capturedAt: "2026-07-09T16:17:43.000000Z",
    shipmentGuid: "10000000-0000-4000-8000-000000000001",
  });
  const prior = tmsPresenceEnvelope({
    label: "tms-inventory-prior",
    subjectKey: shipmentKey,
    snapshotTime: priorSnapshot,
    shipmentGuid: "10000000-0000-4000-8000-000000000001",
  });
  const currentMetadata = tmsMetadataEnvelope({
    claimEnvelope: current,
    shipmentKey,
    snapshotTime: currentSnapshot,
  });
  const sourceWatermark = {
    sourceCutId: `cut:v1:${"1".repeat(64)}`,
    completeness: "complete",
    cursors: [{
      sourceSystem: "tms",
      connectionKey: "couriercloud-primary",
      throughCursorValue: currentSnapshot,
      throughCursorVersion: 2,
    }],
  };
  const packet = reduceRelationalTruth(bundle({
    claims: [prior, current],
    shipmentMetadataEnvelopes: [currentMetadata],
    sourceWatermark,
  }));
  const row = shipment(packet, shipmentKey);
  assert.ok(row.gates.every((item) => item.status === "unknown"), (
    "TMS inventory membership must not invent lifecycle or gate completion"
  ));
  assert.equal(row.currentState.value, "unknown");
  assert.deepEqual(row.acceptedClaimIds, [current.claimVersionId], (
    "source-time presence at the sealed TMS cursor must win even when persistence occurs later"
  ));
  assert.ok(row.contextClaims.some((item) => (
    item.predicate === "shipment_observed_in_tms"
      && item.claimVersionIds.includes(current.claimVersionId)
  )));
  assert.equal(
    packet.acceptedClaimCitations.find((item) => item.claimVersionId === prior.claimVersionId)?.activeReducerInput,
    false,
    "stale TMS presence remains citable history but cannot keep a presence-only shipment active",
  );

  const staleOnly = reduceRelationalTruth(bundle({ claims: [prior], sourceWatermark }));
  assert.equal(staleOnly.shipments.length, 0, (
    "a shipment absent from the current TMS snapshot must not survive solely on stale presence"
  ));

  const duplicate = tmsPresenceEnvelope({
    label: "tms-inventory-current-duplicate",
    subjectKey: shipmentKey,
    snapshotTime: currentSnapshot,
    shipmentGuid: "10000000-0000-4000-8000-000000000002",
  });
  assert.throws(
    () => reduceRelationalTruth(bundle({
      claims: [current, duplicate],
      shipmentMetadataEnvelopes: [currentMetadata],
      sourceWatermark,
    })),
    (error) => error?.code === "RELATIONAL_TRUTH_TMS_INVENTORY_DUPLICATE_AWB",
    "duplicate AWBs in the current TMS inventory must fail closed",
  );

  const malformed = JSON.parse(JSON.stringify(current));
  malformed.canonicalEnvelope.claim.subjectKey = "not-an-awb";
  assert.throws(
    () => reduceRelationalTruth(bundle({ claims: [malformed], sourceWatermark })),
    (error) => error?.code === "RELATIONAL_TRUTH_TMS_INVENTORY_CLAIM_INVALID",
    "malformed inventory AWBs must fail closed",
  );
}

function shipment(packet, shipmentKey) {
  const row = packet.shipments.find((item) => item.shipmentKey === shipmentKey);
  assert.ok(row, `Missing shipment ${shipmentKey}`);
  return row;
}

function gate(row, gateName) {
  const result = row.gates.find((item) => item.gate === gateName);
  assert.ok(result, `Missing ${gateName} gate for ${row.shipmentKey}`);
  return result;
}

function referencedClaimIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => referencedClaimIds(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (/ClaimVersionId$/i.test(key) && typeof item === "string" && item) output.add(item);
    if ((/ClaimVersionIds$/i.test(key) || key === "acceptedClaimIds") && Array.isArray(item)) {
      item.filter(Boolean).forEach((id) => output.add(id));
    }
    referencedClaimIds(item, output);
  }
  return output;
}

function buildFixture() {
  const sameTime = "2026-07-09T09:00:00.000Z";
  const precedenceShipment = "11100000001";
  const precedenceClaims = [
    claimEnvelope({
      label: "precedence-tracking-complete",
      subjectKey: precedenceShipment,
      predicate: "arrival_confirmed",
      gate: "arrival",
      sourceClass: "tracking",
      occurredAt: sameTime,
    }),
    claimEnvelope({
      label: "precedence-tms-block",
      subjectKey: precedenceShipment,
      predicate: "not_arrived",
      gate: "arrival",
      polarity: "negative",
      sourceClass: "tms",
      occurredAt: sameTime,
    }),
    claimEnvelope({
      label: "precedence-gmail-complete",
      subjectKey: precedenceShipment,
      predicate: "arrival_confirmed",
      gate: "arrival",
      sourceClass: "gmail_parsed_message",
      occurredAt: sameTime,
    }),
    claimEnvelope({
      label: "precedence-document-block",
      subjectKey: precedenceShipment,
      predicate: "not_arrived",
      gate: "arrival",
      polarity: "negative",
      sourceClass: "direct_document_or_pod",
      occurredAt: sameTime,
    }),
    claimEnvelope({
      label: "precedence-operator-complete",
      subjectKey: precedenceShipment,
      predicate: "arrival_confirmed",
      gate: "arrival",
      sourceClass: "operator",
      occurredAt: sameTime,
    }),
  ];

  const documentShipment = "11100000002";
  const gmailBlock = claimEnvelope({
    label: "document-vs-gmail-block",
    subjectKey: documentShipment,
    predicate: "customs_hold",
    gate: "customs",
    sourceClass: "gmail_parsed_message",
    occurredAt: sameTime,
  });
  const documentRelease = claimEnvelope({
    label: "document-vs-gmail-release",
    subjectKey: documentShipment,
    predicate: "customs_release_received",
    gate: "customs",
    sourceClass: "direct_document_or_pod",
    occurredAt: sameTime,
  });

  const laterEventShipment = "11100000003";
  const oldOperatorBlock = claimEnvelope({
    label: "later-event-old-operator-block",
    subjectKey: laterEventShipment,
    predicate: "not_arrived",
    gate: "arrival",
    polarity: "negative",
    sourceClass: "operator",
    occurredAt: "2026-07-09T09:00:00.000Z",
  });
  const laterTrackingArrival = claimEnvelope({
    label: "later-event-tracking-complete",
    subjectKey: laterEventShipment,
    predicate: "arrival_confirmed",
    gate: "arrival",
    sourceClass: "tracking",
    occurredAt: "2026-07-09T10:00:00.000Z",
  });

  const correctionShipment = "11100000004";
  const incorrectDelivery = claimEnvelope({
    label: "superseded-incorrect-delivery",
    subjectKey: correctionShipment,
    predicate: "delivery_completed",
    gate: "delivery",
    sourceClass: "direct_document_or_pod",
    occurredAt: "2026-07-09T12:00:00.000Z",
  });
  const deliveryCorrection = claimEnvelope({
    label: "explicit-delivery-correction",
    subjectKey: correctionShipment,
    predicate: "delivery_not_completed",
    gate: "delivery",
    polarity: "negative",
    sourceClass: "gmail_parsed_message",
    occurredAt: "2026-07-09T08:00:00.000Z",
    supersedes: [incorrectDelivery.claimVersionId],
  });

  const requestShipment = "11100000005";
  const pickupComplete = claimEnvelope({
    label: "pickup-complete-before-request",
    subjectKey: requestShipment,
    predicate: "pickup_completed",
    gate: "pickup",
    sourceClass: "gmail_parsed_message",
    occurredAt: "2026-07-09T09:00:00.000Z",
  });
  const pickupRequest = claimEnvelope({
    label: "pickup-request-after-completion",
    subjectKey: requestShipment,
    predicate: "pickup_requested",
    gate: "pickup",
    polarity: "requested",
    sourceClass: "operator",
    occurredAt: "2026-07-09T13:00:00.000Z",
    speechAct: "request",
  });

  const workgroupShipments = [
    "22200000001",
    "22200000002",
    "22200000003",
    "22200000004",
    "22200000005",
  ];
  const workgroup = workgroupDefinition({ label: "five-awb-pickup", shipmentKeys: workgroupShipments });
  const workgroupClaim = claimEnvelope({
    label: "five-awb-workgroup-pickup-complete",
    subjectType: "workgroup",
    subjectKey: workgroup.workgroupId,
    predicate: "pickup_completed",
    gate: "pickup",
    sourceClass: "gmail_parsed_message",
    occurredAt: "2026-07-09T15:00:00.000Z",
  });
  const memberships = workgroupShipments.map((shipmentKey, index) => workgroupMembership({
    workgroup,
    shipmentKey,
    index,
  }));

  const unknownShipment = "33300000001";
  const unknownShipmentLink = entityLinkEnvelope({
    label: "linked-shipment-with-no-claims",
    shipmentKey: unknownShipment,
  });
  const claims = [
    ...precedenceClaims,
    gmailBlock,
    documentRelease,
    oldOperatorBlock,
    laterTrackingArrival,
    incorrectDelivery,
    deliveryCorrection,
    pickupComplete,
    pickupRequest,
    workgroupClaim,
  ];
  const input = bundle({
    claims,
    links: [unknownShipmentLink],
    workgroups: [workgroup],
    memberships,
  });
  return {
    input,
    claims,
    precedenceShipment,
    precedenceWinner: precedenceClaims[4],
    documentShipment,
    documentRelease,
    laterEventShipment,
    laterTrackingArrival,
    correctionShipment,
    incorrectDelivery,
    deliveryCorrection,
    requestShipment,
    pickupComplete,
    pickupRequest,
    workgroup,
    workgroupClaim,
    workgroupShipments,
    unknownShipment,
  };
}

function verifyReducer() {
  const fixture = buildFixture();
  const inputBefore = JSON.parse(JSON.stringify(fixture.input));
  const full = reduceRelationalTruth(fixture.input, { mode: "full" });
  assert.deepEqual(fixture.input, inputBefore, "Pure reduction must not mutate immutable input envelopes");
  assert.equal(full.inputManifestHash, fixture.input.inputManifestHash, (
    "reducer output must preserve the database-authoritative build input manifest hash"
  ));
  assert.match(full.reducerInputManifestHash, /^[0-9a-f]{64}$/);
  assert.notEqual(full.reducerInputManifestHash, full.inputManifestHash, (
    "the reducer-local closure identity must not be relabeled as the database build manifest"
  ));
  const alternateDatabaseManifest = reduceRelationalTruth({
    ...fixture.input,
    inputManifestHash: sha256("different-db-authoritative-input-manifest"),
  }, { mode: "full" });
  assert.equal(alternateDatabaseManifest.reducerInputManifestHash, full.reducerInputManifestHash, (
    "changing only the database build identity must not change the reducer-local closure identity"
  ));
  assert.notEqual(alternateDatabaseManifest.packetHash, full.packetHash, (
    "the database-authoritative manifest must remain committed by the reducer packet hash"
  ));

  assert.equal(EVIDENCE_PRECEDENCE.operator.rank, 500);
  assert.ok(EVIDENCE_PRECEDENCE.operator.rank > EVIDENCE_PRECEDENCE.direct_document_or_pod.rank);
  assert.ok(EVIDENCE_PRECEDENCE.direct_document_or_pod.rank > EVIDENCE_PRECEDENCE.gmail_parsed_message.rank);
  assert.ok(EVIDENCE_PRECEDENCE.gmail_parsed_message.rank > EVIDENCE_PRECEDENCE.tms.rank);
  assert.ok(EVIDENCE_PRECEDENCE.tms.rank > EVIDENCE_PRECEDENCE.tracking.rank);

  const precedenceRow = shipment(full, fixture.precedenceShipment);
  assert.equal(gate(precedenceRow, "arrival").status, "true");
  assert.equal(gate(precedenceRow, "arrival").winnerClaimVersionId, fixture.precedenceWinner.claimVersionId);
  assert.equal(gate(precedenceRow, "arrival").basis, "source_class");
  assert.ok(precedenceRow.contradictions.some((item) => item.resolution === "source_class"));

  const documentRow = shipment(full, fixture.documentShipment);
  assert.equal(gate(documentRow, "customs").status, "true");
  assert.equal(gate(documentRow, "customs").winnerClaimVersionId, fixture.documentRelease.claimVersionId);
  assert.equal(gate(documentRow, "customs").basis, "source_class");

  const laterEventRow = shipment(full, fixture.laterEventShipment);
  assert.equal(gate(laterEventRow, "arrival").status, "true");
  assert.equal(gate(laterEventRow, "arrival").winnerClaimVersionId, fixture.laterTrackingArrival.claimVersionId);
  assert.equal(gate(laterEventRow, "arrival").basis, "event_time");
  assert.ok(laterEventRow.contradictions.some((item) => item.resolution === "event_time"));

  const correctedRow = shipment(full, fixture.correctionShipment);
  assert.equal(gate(correctedRow, "delivery").status, "blocked");
  assert.equal(gate(correctedRow, "delivery").winnerClaimVersionId, fixture.deliveryCorrection.claimVersionId);
  assert.ok(!correctedRow.acceptedClaimIds.includes(fixture.incorrectDelivery.claimVersionId));
  assert.ok(full.supersessionsApplied.some((item) => (
    item.resolvingClaimVersionId === fixture.deliveryCorrection.claimVersionId
    && item.supersededClaimVersionId === fixture.incorrectDelivery.claimVersionId
  )), "Explicit supersession must be applied before temporal/source comparison");

  const requestRow = shipment(full, fixture.requestShipment);
  assert.equal(gate(requestRow, "pickup").status, "true");
  assert.equal(gate(requestRow, "pickup").winnerClaimVersionId, fixture.pickupComplete.claimVersionId);
  assert.notEqual(gate(requestRow, "pickup").winnerClaimVersionId, fixture.pickupRequest.claimVersionId);
  assert.ok(requestRow.openRequests.some((item) => (
    item.claimVersionIds.includes(fixture.pickupRequest.claimVersionId)
    && item.status === "historical_or_satisfied"
  )), "A request remains visible but can never become completion truth");

  const propagatedCitations = [];
  for (const shipmentKey of fixture.workgroupShipments) {
    const row = shipment(full, shipmentKey);
    const pickupGate = gate(row, "pickup");
    assert.equal(pickupGate.status, "true");
    assert.deepEqual(pickupGate.claimVersionIds, [fixture.workgroupClaim.claimVersionId]);
    propagatedCitations.push(_test.stableJson(pickupGate.claimVersionIds));
    for (const priorGate of ["arrival", "customs", "fees", "dispatch"]) {
      const inferred = gate(row, priorGate);
      assert.equal(inferred.status, "true");
      assert.equal(inferred.basis, "downstream_milestone");
      assert.deepEqual(inferred.claimVersionIds, [fixture.workgroupClaim.claimVersionId]);
    }
  }
  assert.equal(new Set(propagatedCitations).size, 1, (
    "One workgroup-scoped claim must propagate to all five shipments with identical claim citations"
  ));
  const outputWorkgroup = full.workgroups.find((item) => item.workgroupId === fixture.workgroup.workgroupId);
  assert.deepEqual(outputWorkgroup.shipmentKeys, fixture.workgroupShipments);
  assert.deepEqual(outputWorkgroup.claimVersionIds, [fixture.workgroupClaim.claimVersionId]);

  const unknownRow = shipment(full, fixture.unknownShipment);
  assert.equal(unknownRow.gates.length, MILESTONE_GATES.length);
  assert.ok(unknownRow.gates.every((item) => item.status === "unknown"));
  assert.equal(unknownRow.currentState.value, "unknown");

  const allowedClaimIds = new Set(fixture.claims.map((item) => item.claimVersionId));
  const references = referencedClaimIds(full);
  for (const claimId of references) {
    assert.ok(allowedClaimIds.has(claimId), `Packet contains a dangling claim citation: ${claimId}`);
  }
  for (const row of full.shipments) {
    for (const gateConclusion of row.gates) {
      if (gateConclusion.status !== "unknown") {
        assert.ok(gateConclusion.claimVersionIds.length > 0, (
          `Non-unknown ${row.shipmentKey}/${gateConclusion.gate} conclusion lacks accepted-claim citations`
        ));
      }
    }
  }
  const citationIds = new Set(full.acceptedClaimCitations.map((item) => item.claimVersionId));
  assert.deepEqual([...citationIds].sort(), [...allowedClaimIds].sort());
  const sourceObservationIds = new Set(fixture.input.sourceCut.observations.map((item) => item.observationId));
  for (const citation of full.acceptedClaimCitations) {
    assert.ok(citation.evidenceObservationIds.length > 0);
    assert.ok(citation.evidenceObservationIds.every((id) => sourceObservationIds.has(id)));
  }

  const shuffled = JSON.parse(JSON.stringify(fixture.input));
  shuffled.sourceCut.observations.reverse();
  shuffled.acceptedClaimEnvelopes.reverse();
  shuffled.entityLinkEnvelopes.reverse();
  shuffled.workgroupDefinitions.reverse();
  shuffled.workgroupMembershipEnvelopes.reverse();
  const reordered = reduceRelationalTruth(shuffled, { mode: "full" });
  assert.deepEqual(reordered, full, "Input order must not change packet bytes or hash");

  const incrementalInput = {
    ...fixture.input,
    basePublication: {
      publicationId: "publication:v1:ignored-materialized-result",
      packetHash: "0".repeat(64),
      payload: { stale: true },
    },
  };
  const incremental = reduceRelationalTruth(incrementalInput, { mode: "incremental" });
  assert.deepEqual(incremental, full, (
    "Full and incremental modes must produce byte-identical payloads from the same immutable bundle"
  ));

  const { packetHash, ...hashPayload } = full;
  assert.equal(packetHash, _test.sha256Json(hashPayload));
  assert.equal(full.reducerVersion, REDUCER_VERSION);
  assert.ok(!Object.hasOwn(full, "buildMode"));
  assert.ok(!_test.stableJson(full).includes("ignored-materialized-result"), (
    "The optional base publication must never enter reducer evidence or packet output"
  ));

  return full;
}

function main() {
  verifyExtractorSourceClassFallback();
  verifyTmsInventoryPresence();
  const packet = verifyReducer();
  console.log(JSON.stringify({
    ok: true,
    verifier: "verify-relational-truth-reducer",
    reducerVersion: REDUCER_VERSION,
    packetHash: packet.packetHash,
    shipmentCount: packet.shipments.length,
    workgroupCount: packet.workgroups.length,
    acceptedClaimCitationCount: packet.acceptedClaimCitations.length,
    checks: [
      "declared operator > document/POD > Gmail > TMS > tracking precedence",
      "later real-world event wins before same-time source precedence",
      "explicit correction/supersession is applied first",
      "requests and plans never become completion truth",
      "five-AWB workgroup propagation preserves identical accepted-claim citations",
      "monotonic earlier gates cite the downstream milestone that proves them",
      "missing gates are explicit unknowns and contradictions/exceptions remain visible",
      "all conclusion citations close over accepted claim envelopes and sealed observations",
      "input ordering is deterministic and full/incremental outputs are byte-identical",
      "base publications never become reducer evidence",
      "database-authoritative input manifest identity is preserved separately from reducer-local closure",
      "current exact-cut TMS inventory materializes unknown-gate shipments without inventing state",
      "stale presence does not keep a presence-only shipment active",
      "duplicate and malformed TMS inventory AWBs fail closed",
      "sealed extractor identity supplies source class when optional span labels are absent",
    ],
  }, null, 2));
}

main();

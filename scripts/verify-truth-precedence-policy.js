#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_POLICY,
  compareClaimPriority,
  explainPriority,
  priorityVector,
  validatePolicy,
} = require("../lib/truth-precedence-policy");

function claim(overrides = {}) {
  return {
    claimVersionId: `claim:v1:${"a".repeat(64)}`,
    subjectType: "shipment",
    gate: "customs",
    sourceClass: "gmail_parsed_message",
    normalizedValue: {
      responsibleActor: "broker",
      evidenceDirectness: "direct",
    },
    occurredAt: "2026-07-09T12:00:00.000Z",
    capturedAt: "2026-07-09T12:01:00.000Z",
    recordedAt: "2026-07-09T12:02:00.000Z",
    confidence: 0.95,
    ...overrides,
  };
}

function main() {
  assert.equal(DEFAULT_POLICY.schemaVersion, "truth-precedence-policy-v1");
  assert.match(DEFAULT_POLICY.policyHash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_POLICY.sourceClasses));

  const olderOperator = claim({
    claimVersionId: `claim:v1:${"b".repeat(64)}`,
    sourceClass: "operator",
    occurredAt: "2026-07-09T11:00:00.000Z",
    capturedAt: "2026-07-09T12:30:00.000Z",
    normalizedValue: { responsibleActor: "operator", evidenceDirectness: "direct" },
  });
  const newerStationDocument = claim({
    claimVersionId: `claim:v1:${"c".repeat(64)}`,
    sourceClass: "direct_document_or_pod",
    occurredAt: "2026-07-09T12:00:00.000Z",
    normalizedValue: { responsibleActor: "station", evidenceDirectness: "document" },
  });
  assert.ok(compareClaimPriority(newerStationDocument, olderOperator) > 0,
    "newer event meaning beats a later-captured stale operator note");
  assert.equal(explainPriority(newerStationDocument, olderOperator).decisiveCriterion, "event_time");

  const sameTimeBroker = claim({
    claimVersionId: `claim:v1:${"d".repeat(64)}`,
    normalizedValue: { responsibleActor: "broker", evidenceDirectness: "direct" },
  });
  const sameTimeGenericCarrier = claim({
    claimVersionId: `claim:v1:${"e".repeat(64)}`,
    sourceClass: "operator",
    normalizedValue: { responsibleActor: "carrier", evidenceDirectness: "direct" },
  });
  assert.ok(compareClaimPriority(sameTimeBroker, sameTimeGenericCarrier) > 0,
    "customs broker responsibility beats generic carrier commentary for customs at equal time");
  assert.equal(explainPriority(sameTimeBroker, sameTimeGenericCarrier).decisiveCriterion, "responsible_actor");

  const signedPod = claim({
    claimVersionId: `claim:v1:${"f".repeat(64)}`,
    gate: "pod",
    sourceClass: "direct_document_or_pod",
    normalizedValue: { responsibleActor: "consignee", evidenceDirectness: "signed_pod" },
  });
  const emailPodSummary = claim({
    claimVersionId: `claim:v1:${"1".repeat(64)}`,
    gate: "pod",
    normalizedValue: { responsibleActor: "carrier", evidenceDirectness: "email_summary" },
  });
  assert.ok(compareClaimPriority(signedPod, emailPodSummary) > 0);
  assert.equal(priorityVector(signedPod).metadata.directness, "signed_document");

  const workgroupClaim = claim({
    claimVersionId: `claim:v1:${"2".repeat(64)}`,
    subjectType: "workgroup",
  });
  const shipmentClaim = claim({
    claimVersionId: `claim:v1:${"3".repeat(64)}`,
    subjectType: "shipment",
  });
  assert.ok(compareClaimPriority(shipmentClaim, workgroupClaim) > 0,
    "an exact-shipment exception beats group context at the same event time");

  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, policyHash: undefined, criteria: ["event_time"] }),
    /must contain every supported criterion/);
  assert.throws(() => validatePolicy({
    ...JSON.parse(JSON.stringify(DEFAULT_POLICY)),
    policyHash: undefined,
    sourceClasses: { ...DEFAULT_POLICY.sourceClasses, gmail_parsed_message: { rank: -1, label: "bad" } },
  }), /bounded non-negative integer/);

  console.log(JSON.stringify({
    ok: true,
    policyVersion: DEFAULT_POLICY.policyVersion,
    policyHash: DEFAULT_POLICY.policyHash,
    criteria: DEFAULT_POLICY.criteria,
  }));
}

main();

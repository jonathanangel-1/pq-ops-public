#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { buildOperatorSourceDelta, deriveOperatorEventId } = require("../lib/operator-source-delta");
const {
  _test,
  assessOperatorObservation,
  createOperatorClaimExtractor,
} = require("../lib/operator-claim-extractor");
const { fixtureDelta } = require("./verify-operator-source-delta");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function wrap(observation) {
  return { ...observation, sourceSystem: "operator" };
}

function bySequence(rows, sequence) {
  return rows.find((row) => row.normalizedPayload.event.sequence === String(sequence));
}

function mutateObservation(observation, mutate) {
  const changed = clone(observation);
  mutate(changed.normalizedPayload.event);
  changed.normalizedPayload.event.eventId = deriveOperatorEventId(changed.normalizedPayload.event);
  changed.sourceObjectId = changed.normalizedPayload.event.eventId;
  changed.contentHash = _test.sha256Json(changed.normalizedPayload);
  return changed;
}

function resolvePath(root, path) {
  return path.reduce((value, key) => value?.[key], root);
}

async function main() {
  const built = buildOperatorSourceDelta(fixtureDelta(), {
    connectionKey: "operator-phone-journal",
    expectedFirstSequence: "41",
  });
  const rows = built.observations.map(wrap);
  const extractor = createOperatorClaimExtractor();
  let fetchCalls = 0;
  const priorFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden in operator claim extraction");
  };
  try {
    const assertion = await extractor.extract({ observation: bySequence(rows, 41) });
    const correction = await extractor.extract({ observation: bySequence(rows, 42) });
    const revocation = await extractor.extract({ observation: bySequence(rows, 43) });
    const group = await extractor.extract({ observation: bySequence(rows, 44) });
    assert.equal(assertion.length, 1);
    assert.equal(assertion[0].predicate, "arrival_confirmed");
    assert.equal(assertion[0].polarity, "positive");
    assert.equal(assertion[0].acceptanceRecommendation.decision, "accept");
    assert.equal(correction[0].predicate, "arrival_confirmed");
    assert.equal(correction[0].polarity, "negative");
    assert.equal(correction[0].acceptanceRecommendation.decision, "accept");
    assert.equal(revocation[0].predicate, "arrival_confirmed");
    assert.equal(revocation[0].polarity, "unknown");
    assert.equal(revocation[0].normalizedValue.status, "unknown");
    assert.equal(revocation[0].acceptanceRecommendation.decision, "accept");
    assert.equal(group[0].subjectType, "workgroup");
    assert.match(group[0].subjectKey, /^workgroup:v1:[0-9a-f]{64}$/);
    assert.deepEqual(group[0].appliesToAwbs, ["01680000158", "01680000160"]);
    assert.equal(group[0].predicate, "station_fees_paid");
    assert.equal(group[0].acceptanceRecommendation.decision, "accept");

    const standardKeys = new Set([
      "candidateClaimVersionId", "candidateHash", "schemaVersion", "claimKey", "versionNo",
      "previousClaimVersionId", "sourceObservationId", "sourceObservationContentHash",
      "sourceObjectType", "sourceObjectId", "sourceCapturedAt", "subjectType", "subjectKey",
      "appliesToAwbs", "predicate", "gate", "polarity", "normalizedValue", "occurredAt",
      "confidence", "confidenceLabel", "evidenceSpan", "extractionMethod", "extractorVersion",
      "model", "promptVersion", "ambiguity", "contradiction", "acceptanceRecommendation",
    ]);
    for (const candidate of [...assertion, ...correction, ...revocation, ...group]) {
      assert.match(candidate.candidateClaimVersionId, /^candidate:v1:[0-9a-f]{64}$/);
      assert.equal(candidate.schemaVersion, "operator-candidate-claim-v1");
      assert.equal(candidate.sourceObjectType, "operator_event");
      assert.equal(candidate.extractionMethod, "deterministic");
      assert.equal(candidate.model, "");
      assert.equal(candidate.promptVersion, "");
      assert.ok(Object.keys(candidate).every((key) => standardKeys.has(key)),
        `candidate added a field outside the standard candidate envelope: ${Object.keys(candidate)}`);
      const observation = rows.find((row) => row.observationId === candidate.sourceObservationId);
      assert.ok(observation, "candidate lost its operator source observation");
      assert.equal(candidate.sourceObservationContentHash, observation.contentHash);
      const sourceEvent = observation.normalizedPayload.event;
      assert.ok(sourceEvent.contact.name && sourceEvent.contact.organization);
      assert.ok(sourceEvent.recordedBy.operatorId && sourceEvent.recordedBy.name);
      assert.ok(sourceEvent.recordedSummary.startsWith("I "));
      const cited = resolvePath(observation.normalizedPayload, candidate.evidenceSpan.path);
      assert.deepEqual(cited, sourceEvent.assertion);
      assert.equal(candidate.evidenceSpan.valueHash, _test.sha256Json(cited));
      assert.deepEqual(candidate.normalizedValue, sourceEvent.assertion.value,
        "extractor changed or augmented the structured operator assertion");
    }

    const freeTextOnly = mutateObservation(bySequence(rows, 41), (event) => {
      delete event.assertion;
      event.recordedSummary = "I confirmed arrival, but supplied no structured assertion.";
    });
    const freeTextAssessment = assessOperatorObservation(freeTextOnly);
    assert.equal(freeTextAssessment.noStructuredAssertion, true);
    assert.deepEqual(await extractor.extract({ observation: freeTextOnly }), [],
      "free text minted operator truth");

    const incompleteGroup = mutateObservation(bySequence(rows, 44), (event) => {
      event.subject.membershipComplete = false;
    });
    const [groupReview] = await extractor.extract({ observation: incompleteGroup });
    assert.equal(groupReview.acceptanceRecommendation.decision, "review");
    assert.ok(groupReview.ambiguity.reasons.some((reason) => /member list/.test(reason)));

    const incompleteContact = mutateObservation(bySequence(rows, 41), (event) => {
      event.contact.organization = "";
    });
    const [contactReview] = await extractor.extract({ observation: incompleteContact });
    assert.equal(contactReview.acceptanceRecommendation.decision, "review");
    assert.ok(contactReview.ambiguity.reasons.some((reason) => /contact/.test(reason)));

    const incompleteTimestamp = mutateObservation(bySequence(rows, 41), (event) => {
      event.occurredAt = "";
    });
    const [timestampReview] = await extractor.extract({ observation: incompleteTimestamp });
    assert.equal(timestampReview.acceptanceRecommendation.decision, "review");
    assert.equal(timestampReview.occurredAt, null);
    assert.ok(timestampReview.ambiguity.reasons.some((reason) => /timestamps/.test(reason)));

    const staleContract = mutateObservation(bySequence(rows, 41), (event) => {
      event.assertion.contractVersion = "stale-predicate-contract";
    });
    const [contractReview] = await extractor.extract({ observation: staleContract });
    assert.equal(contractReview.acceptanceRecommendation.decision, "review");
    assert.ok(contractReview.ambiguity.reasons.some((reason) => /contract version/.test(reason)));

    const narrativeContradiction = mutateObservation(bySequence(rows, 41), (event) => {
      event.recordedSummary = "I wrote a contradictory narrative, but the structured assertion still records arrival.";
    });
    const [narrativeCandidate] = await extractor.extract({ observation: narrativeContradiction });
    assert.equal(narrativeCandidate.predicate, "arrival_confirmed");
    assert.equal(narrativeCandidate.polarity, "positive");
    assert.deepEqual(narrativeCandidate.normalizedValue, assertion[0].normalizedValue,
      "free-text narrative influenced the structured assertion result");

    const prior = [{
      claimVersionId: `claim:v1:${"c".repeat(64)}`,
      claimKey: "shipment:01680000160:arrival_confirmed",
      versionNo: 1,
      polarity: "positive",
      normalizedValue: assertion[0].normalizedValue,
    }];
    const [correctionConflict] = await extractor.extract({
      observation: bySequence(rows, 42),
      acceptedClaims: prior,
    });
    assert.equal(correctionConflict.versionNo, 2);
    assert.equal(correctionConflict.previousClaimVersionId, prior[0].claimVersionId);
    assert.equal(correctionConflict.contradiction.status, "known");
    assert.equal(correctionConflict.acceptanceRecommendation.decision, "review");

    const replay = await extractor.extract({ observation: bySequence(rows, 41) });
    assert.deepEqual(replay, assertion, "operator extraction did not replay deterministically");
  } finally {
    global.fetch = priorFetch;
  }
  assert.equal(fetchCalls, 0);

  console.log(JSON.stringify({
    ok: true,
    events: rows.length,
    guarantees: [
      "only the structured registry-pinned assertion can mint a candidate",
      "free-text-only call notes mint no truth",
      "candidate uses the standard claim envelope and exact registry status/effect",
      "candidate cites the complete structured assertion by exact field path and content hash",
      "operator contact, recorder, timestamps, summary, and correction lineage remain reachable through immutable source provenance",
      "complete shipment/workgroup assertions may be recommended; incomplete scope, contact, time, or contract is review-gated",
      "correction and revocation are extracted from new append-only source events",
      "extractor is deterministic and performs no network access",
    ],
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

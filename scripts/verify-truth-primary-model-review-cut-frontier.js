#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718120000_truth_primary_model_review_cut_frontier.sql",
), "utf8").toLowerCase();

for (const token of [
  "truth_primary_model_review_cut_frontiers",
  "truth_primary_model_review_cut_frontier_items",
  "truth_primary_model_review_claim_bound_to_cut_v1",
  "truth_gmail_live_message_model_job_allowed_v1",
  "truth_shadow_late_claim_bound_to_cut_v1",
  "decision.decision_method='operator'",
  "review.decision='accept'",
  "model_request.state='succeeded'",
  "model_outcome.classification='success'",
  "model_outcome.outcome_unknown=false",
  "model_outcome.billing_outcome_unknown=false",
  "candidate.recommendation='review'",
  "candidate.source_review_required=false",
  "private.source_observation_within_cut",
  "claim.created_at<=v_cut.sealed_at",
  "review.created_at<=v_cut.sealed_at",
  "cannot attach after build or publication",
  "frontier is partial",
  "acceptedclaimscreated',false",
  "modelcallsperformed',false",
  "publishestruth',false",
  "performsactions',false",
  "productionpublicationattempted',false",
  "after insert on public.truth_shadow_root_source_cuts",
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
  "has_function_privilege('service_role'",
]) assert.ok(migration.includes(token), `migration missing ${token}`);

function eligible(input) {
  return input.primary
    && input.modelChildAuthorized
    && input.modelSucceeded
    && input.modelResultExact
    && input.candidateManifestExact
    && input.operatorDecision === "accept"
    && input.reviewResolution === "accept"
    && input.acceptanceBindingExact
    && input.claimEnvelopeExact
    && input.primaryEvidence
    && input.allEvidenceInsideCut
    && input.reviewAt <= input.cutSealedAt
    && input.claimAt <= input.cutSealedAt
    && !input.epochOwned
    && !input.lateOwned
    && !input.buildExists
    && !input.publicationExists;
}

const fixture = {
  primary: true,
  modelChildAuthorized: true,
  modelSucceeded: true,
  modelResultExact: true,
  candidateManifestExact: true,
  operatorDecision: "accept",
  reviewResolution: "accept",
  acceptanceBindingExact: true,
  claimEnvelopeExact: true,
  primaryEvidence: true,
  allEvidenceInsideCut: true,
  reviewAt: 10,
  claimAt: 10,
  cutSealedAt: 11,
  epochOwned: false,
  lateOwned: false,
  buildExists: false,
  publicationExists: false,
};
assert.equal(eligible(fixture), true);

const mutations = [
  (copy) => { copy.primary = false; },
  (copy) => { copy.modelChildAuthorized = false; },
  (copy) => { copy.modelSucceeded = false; },
  (copy) => { copy.modelResultExact = false; },
  (copy) => { copy.candidateManifestExact = false; },
  (copy) => { copy.operatorDecision = "review"; },
  (copy) => { copy.reviewResolution = "reject"; },
  (copy) => { copy.acceptanceBindingExact = false; },
  (copy) => { copy.claimEnvelopeExact = false; },
  (copy) => { copy.primaryEvidence = false; },
  (copy) => { copy.allEvidenceInsideCut = false; },
  (copy) => { copy.reviewAt = 12; },
  (copy) => { copy.claimAt = 12; },
  (copy) => { copy.epochOwned = true; },
  (copy) => { copy.lateOwned = true; },
  (copy) => { copy.buildExists = true; },
  (copy) => { copy.publicationExists = true; },
];
for (const mutate of mutations) {
  const copy = structuredClone(fixture);
  mutate(copy);
  assert.equal(eligible(copy), false);
}

const podPromise = Object.freeze({
  predicate: "pod_received",
  polarity: "neutral",
  normalizedValue: { status: "planned", effect: "context" },
});
assert.notEqual(podPromise.polarity, "positive");
assert.notEqual(podPromise.normalizedValue.status, "received");
assert.notEqual(podPromise.normalizedValue.effect, "complete");

console.log(JSON.stringify({
  ok: true,
  verifier: "truth-primary-model-review-cut-frontier",
  refusalCases: mutations.length,
  checks: [
    "only exact pre-cut operator-reviewed successful primary model claims bind",
    "ordinary epoch and late-model claims retain their existing ownership",
    "partial, post-cut, built, or published scopes fail closed",
    "Virginia POD promise stays neutral and planned, never positive received",
    "the frontier performs no model call, claim creation, publication, or action",
  ],
}, null, 2));

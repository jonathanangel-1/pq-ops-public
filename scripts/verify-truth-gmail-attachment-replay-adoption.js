#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createTruthGmailAttachmentModelWorker,
} = require("../lib/truth-gmail-attachment-model-worker");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718090000_truth_gmail_attachment_replay_adoption.sql",
), "utf8").toLowerCase();

for (const token of [
  "truth_gmail_attachment_replay_adoptions",
  "v_prior_count<>1",
  "request.raw_sha256=v_job.payload->>'rawsha256'",
  "request.source_message_id=v_job.payload->>'messageid'",
  "request.source_attachment_id=v_job.payload->>'attachmentid'",
  "request.state=any(array['succeeded','review_required'])",
  "outcome.outcome_unknown=false",
  "prior_operator_review_remains_open",
  "candidateclaimsautoaccepted',false",
  "modelrequestcreated',false",
  "modelbudgetreserved',false",
  "providerdispatchattempted',false",
  "productionpublicationattempted',false",
  "truth_source_cut_mutation_lock",
  ") to service_role",
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
]) assert.ok(migration.includes(token), `migration missing ${token}`);

const job = Object.freeze({
  jobId: "11111111-1111-4111-8111-111111111111",
  jobKind: "gmail_review_attachment_extraction",
  leaseFence: 7,
});
const context = Object.freeze({ rawObject: { key: "never-read" } });
const adopted = Object.freeze({
  ok: true,
  adopted: true,
  disposition: "prior_operator_review_remains_open",
  productionPublicationAttempted: false,
});
const calls = [];
const worker = createTruthGmailAttachmentModelWorker({
  jobLedger: {
    claimJobs: async () => ({ jobs: [job] }),
    renewJob: async () => { calls.push("renew"); return {}; },
    failJob: async () => { throw new Error("adoption must not fail"); },
  },
  modelLedger: {
    loadContext: async () => { calls.push("context"); return context; },
    adoptPrior: async () => { calls.push("adopt"); return adopted; },
    createRequest: async () => { throw new Error("adoption must not create request"); },
    reserveRequest: async () => { throw new Error("adoption must not reserve budget"); },
    beginAttempt: async () => { throw new Error("adoption must not dispatch"); },
    reconcileAttempt: async () => { throw new Error("adoption must not reconcile"); },
    completeExtraction: async () => { throw new Error("adoption must not duplicate evidence"); },
  },
  rawStore: {
    getRawObject: async () => { throw new Error("adoption must not reload bytes"); },
  },
  providerAdapter: {
    prepareRequest: () => { throw new Error("adoption must not prepare provider request"); },
    executeAuthorizedAttempt: async () => { throw new Error("adoption must not call provider"); },
  },
  workerId: "primary-attachment-model-drain-v1",
  processorVersion: "primary-attachment-model-drain-v1:worker-v1",
});

(async () => {
  const receipt = await worker.runOnce({ limit: 1 });
  assert.deepEqual(calls, ["context", "adopt"]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.claimedCount, 1);
  assert.equal(receipt.succeededCount, 1);
  assert.equal(receipt.reviewCount, 1);
  assert.equal(receipt.reservedMicroUsd, 0);
  assert.equal(receipt.actualMicroUsd, 0);
  assert.equal(receipt.jobs[0].adopted, true);
  assert.equal(receipt.productionPublicationAttempted, false);
  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-gmail-attachment-replay-adoption",
    checks: [
      "exact prior completion is resolved before raw load or request creation",
      "review-required disposition remains review-required",
      "adoption spends and publishes nothing",
      "SQL authority requires one exact stable-content prior outcome",
    ],
  }, null, 2));
})().catch((error) => {
  console.error(`verify:truth-gmail-attachment-replay-adoption FAILED: ${error.message}`);
  process.exit(1);
});

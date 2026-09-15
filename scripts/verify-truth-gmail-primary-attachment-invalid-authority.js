#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root,
  "supabase/migrations/20260718060000_authorize_primary_attachment_invalid_first_exhaustion.sql"), "utf8");
const incident = fs.readFileSync(path.join(root,
  "YLYI/08_Incidents/INC-2026-07-22-LATE-INVALID-ATTACHMENT-JOBS-HEAD-BLOCK-ACCEPTANCE.md"), "utf8");
const backtests = fs.readFileSync(path.join(root, "YLYI/07_Backtest_Cases/Backtest_Cases.md"), "utf8");

for (const required of [
  "authorize_truth_gmail_primary_attachment_invalid_first_exhaustion_v1",
  "primary-attachment-model-drain-v1:worker-v1",
  "job.state='dead_letter'",
  "job.attempt_count=5",
  "job.max_attempts=5",
  "OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT",
  "truth_gmail_attachment_worker_failure_v1",
  "job.lease_owner is null",
  "job.result='{}'::jsonb",
  "from public.gmail_attachment_model_requests request",
  "truth_gmail_attachment_invalid_argument_retry_lineage",
  "authorizedMaxAttempts',v_job.attempt_count+3",
  "captureAuthority','retry_authorization_transition_v2",
  "producerAuthority','primary_attachment_model_drain_v1",
  "productionPublicationAttempted',false",
  "truth_gmail_primary_attachment_invalid_first_exhaustion",
]) assert.ok(migration.includes(required), `primary invalid authority missing ${required}`);

for (const forbidden of [
  /insert into public\.accepted_claims/i,
  /insert into public\.candidate_claims/i,
  /insert into public\.truth_builds/i,
  /insert into public\.truth_publications/i,
  /gmail_send/i,
]) assert.equal(forbidden.test(migration), false,
  `primary invalid authority touches forbidden surface ${forbidden}`);

function eligible(job) {
  return job.processorVersion === "primary-attachment-model-drain-v1:worker-v1"
    && job.state === "dead_letter" && job.attemptCount === 5
    && job.maxAttempts === 5 && job.errorCode === "OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT"
    && job.workerEnvelope === true && !job.leaseOwner && !job.leaseExpiresAt
    && job.emptyResult === true && job.modelRequests === 0
    && job.retryLineage === 0 && job.terminalizations === 0;
}
const base = { processorVersion: "primary-attachment-model-drain-v1:worker-v1",
  state: "dead_letter", attemptCount: 5, maxAttempts: 5,
  errorCode: "OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT", workerEnvelope: true,
  leaseOwner: null, leaseExpiresAt: null, emptyResult: true, modelRequests: 0,
  retryLineage: 0, terminalizations: 0 };
assert.equal(eligible(base), true);
assert.equal(eligible({ ...base, processorVersion: "unknown" }), false);
assert.equal(eligible({ ...base, attemptCount: 4 }), false);
assert.equal(eligible({ ...base, maxAttempts: 8 }), false);
assert.equal(eligible({ ...base, leaseOwner: "worker" }), false);
assert.equal(eligible({ ...base, modelRequests: 1 }), false);
assert.equal(eligible({ ...base, retryLineage: 1 }), false);

assert.match(incident, /primary-worker first exhaustion omitted/i);
assert.match(backtests, /primary-attachment-model-drain-v1:worker-v1/);
process.stdout.write(`${JSON.stringify({ ok: true,
  verifier: "truth-gmail-primary-attachment-invalid-authority",
  exactPrimaryProcessorOnly: true, boundedAttempts: "5-to-8",
  immutableLineageBeforeRetry: true, candidateClaimsAutoAccepted: false,
  productionPublicationAttempted: false }, null, 2)}\n`);

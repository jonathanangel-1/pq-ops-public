#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migrationName =
  "20260717920000_truth_gmail_attachment_invalid_first_exhaustion_authority.sql";
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations", migrationName),
  "utf8",
);
const stack = fs.readFileSync(
  path.join(root, "scripts/verify-truth-full-migration-stack.js"),
  "utf8",
);

for (const expected of [
  "authorize_truth_gmail_attachment_invalid_first_exhaustion_v1",
  "job.processor_version='local-pipeline-v1:attach-model'",
  "job.attempt_count=5",
  "job.max_attempts=5",
  "private.truth_gmail_attachment_worker_failure_v1",
  "not exists(\n      select 1 from public.gmail_attachment_model_requests",
  "authorizedMaxAttempts',v_job.attempt_count+3",
  "captureAuthority','retry_authorization_transition_v2'",
  "insert into public.truth_gmail_attachment_invalid_argument_retry_lineage",
  "ATTACHMENT_MODEL_INVALID_ARGUMENT_RETRY_AUTHORIZED",
  "terminalize_truth_gmail_attachment_invalid_exhaustion_v1",
  "terminalize_truth_gmail_attachment_cross_authority_invalid_v1",
  "productionPublicationAttempted',false",
]) {
  assert.ok(migration.includes(expected), `migration is missing ${expected}`);
}

const receiptInsert = migration.indexOf(
  "insert into public.truth_gmail_attachment_invalid_argument_retry_lineage",
);
const retryUpdate = migration.indexOf("update public.source_processing_jobs job");
assert.ok(receiptInsert >= 0 && retryUpdate > receiptInsert,
  "retry authority receipt must be inserted before job headroom is granted");
assert.ok(migration.includes("for update of job"),
  "authority must lock the exact exhausted row");
assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(migration),
  "migration must be class-scoped, not job- or batch-ID scoped");
assert.ok(!/insert\s+into\s+public\.(accepted_claim|truth_build|truth_publication|candidate_claim)/i.test(migration),
  "migration must not mint claims, builds, publications, or candidates");
assert.ok(!/truth_model_workspace_(accounts|daily_usage)/i.test(migration),
  "migration must not alter model budget ledgers");

for (const fixtureProof of [
  migrationName,
  "lateRuntimeInvalidJob",
  "lateWrongProcessorJob",
  "lateFirstExhaustionAuthorized",
]) {
  assert.ok(stack.includes(fixtureProof),
    `full-stack runtime regression is missing ${fixtureProof}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-gmail-attachment-invalid-first-exhaustion-authority",
  migration: migrationName,
  receiptBeforeMutation: true,
  classScoped: true,
  runtimeRegressionRegistered: true,
  publicationAttempted: false,
}, null, 2)}\n`);

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migrationName =
  "20260718080000_release_post_seal_gmail_claim_children.sql";
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations", migrationName),
  "utf8",
);
const stack = fs.readFileSync(
  path.join(root, "scripts/verify-truth-full-migration-stack.js"),
  "utf8",
);

for (const expected of [
  "truth_gmail_post_seal_claim_releases",
  "release_truth_gmail_post_seal_claim_v1",
  "route_truth_gmail_post_seal_claim_lineage_v1",
  "after insert on public.source_processing_job_lineage",
  "GMAIL_POST_SEAL_LINEAGE_RELEASE",
  "job.last_error_code='GMAIL_LINK_EPOCH_SEAL_REQUIRED'",
  "job.state='waiting_runtime' and job.attempt_count=0",
  "job.lease_fence=0",
  "job.processor_version='' and job.result='{}'::jsonb",
  "not exists(select 1 from public.candidate_claim_job_manifests",
  "where (job.state='waiting_runtime'",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
]) {
  assert.ok(migration.includes(expected), `migration is missing ${expected}`);
}

const receipt = migration.indexOf(
  "insert into public.truth_gmail_post_seal_claim_releases",
);
const release = migration.indexOf(
  "update public.source_processing_jobs job",
  receipt,
);
assert.ok(receipt >= 0 && release > receipt,
  "post-seal release receipt must be inserted before the job is queued");
assert.ok(migration.includes("for update of job"),
  "post-seal release must fence the exact source job");
assert.equal(
  /insert\s+into\s+public\.(accepted_claim|candidate_claim|truth_build|truth_publication|truth_model_workspace)/i
    .test(migration),
  false,
  "post-seal release must not mint claims, candidates, builds, publications, or budget writes",
);
assert.ok(stack.includes(migrationName),
  "full migration-stack verifier must apply the post-seal release migration");

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-gmail-post-seal-claim-release",
  migration: migrationName,
  receiptBeforeRelease: true,
  lineageBound: true,
  productionPublicationAttempted: false,
}, null, 2)}\n`);

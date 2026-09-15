#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _test } = require("./run-primary-attachment-invalid-drain");

const root = path.resolve(__dirname, "..");
const migrationName =
  "20260717930000_truth_gmail_attachment_invalid_scoped_drain.sql";
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations", migrationName),
  "utf8",
);
const statusMigrationName =
  "20260717950000_truth_gmail_attachment_invalid_scoped_status.sql";
const statusMigration = fs.readFileSync(
  path.join(root, "supabase/migrations", statusMigrationName),
  "utf8",
);
const runner = fs.readFileSync(
  path.join(root, "scripts/run-primary-attachment-invalid-drain.js"),
  "utf8",
);
const stack = fs.readFileSync(
  path.join(root, "scripts/verify-truth-full-migration-stack.js"),
  "utf8",
);

for (const expected of [
  "claim_truth_gmail_attachment_invalid_first_exhaustion_jobs",
  "primary-attachment-invalid-drain-v1:worker-v1",
  "truth_gmail_attachment_invalid_argument_retry_lineage authority",
  "authorized_attempt_count=5",
  "authorized_max_attempts=8",
  "truth_gmail_attachment_model_job_allowed_v2",
  "for update of job skip locked",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
]) assert.ok(migration.includes(expected), `scoped claim migration is missing ${expected}`);

assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(migration),
  "scoped claim authority must not hard-code job or batch IDs");
assert.ok(!/insert\s+into\s+public\.(accepted_claim|candidate_claim|truth_build|truth_publication)/i.test(migration),
  "scoped claim authority must not create truth or publication output");
assert.ok(!/truth_model_workspace_(accounts|daily_usage)/i.test(migration),
  "scoped claim authority must not change model budgets");

for (const expected of [
  "read_truth_gmail_attachment_invalid_first_exhaustion_status",
  "pendingCount",
  "futureRetryCount",
  "unexpectedCount",
  "nextAvailableAt",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
]) assert.ok(statusMigration.includes(expected), `scoped status migration is missing ${expected}`);
assert.ok(!/\b(insert|update|delete)\s+(into|public\.|from)/i.test(statusMigration),
  "scoped status receipt must remain read-only");

const calls = [];
const rpc = _test.createScopedRpc({
  callRpc: async (name, body, options) => {
    calls.push({ name, body, options });
    return { ok: true };
  },
});
(async () => {
  await rpc("claim_source_processing_jobs", { p_limit: 2 });
  await rpc("renew_source_processing_job_lease", { p_job_id: "fixture" });
  await rpc(_test.SCOPED_STATUS_RPC, {});
  assert.equal(calls[0].name, _test.SCOPED_CLAIM_RPC,
    "only the claim call must map to the scoped authority");
  assert.equal(calls[1].name, "renew_source_processing_job_lease",
    "canonical downstream RPCs must remain unchanged");
  assert.equal(calls[2].name, _test.SCOPED_STATUS_RPC,
    "the read-only status RPC must remain distinct from claim mapping");
  assert.deepEqual(calls[0].options.retryDelaysMs, [],
    "mutating scoped calls must not retry after outcome-unknown transport");
  for (const expected of [
    "createTruthGmailAttachmentModelWorker",
    "createTruthGmailAttachmentModelLedger",
    "createServerTruthRawObjectStore",
    "createOpenAIGmailAttachmentModelExtractor",
    "AbortSignal.timeout(120_000)",
    "finalStatus.pendingCount === 0",
    "finalStatus.unexpectedCount === 0",
    "candidateClaimsAutoAccepted: false",
    "productionPublicationAttempted: false",
  ]) assert.ok(runner.includes(expected), `bounded runner is missing ${expected}`);
  for (const expected of [migrationName, statusMigrationName, "lateUnrelatedAttachmentJob",
    "dedicatedInvalidClaimScoped"]) {
    assert.ok(stack.includes(expected), `full-stack proof is missing ${expected}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "primary-attachment-invalid-drain",
    scopedClaimRpc: _test.SCOPED_CLAIM_RPC,
    scopedStatusRpc: _test.SCOPED_STATUS_RPC,
    genericQueueClaimed: false,
    providerTimeoutMs: 120000,
    candidateClaimsAutoAccepted: false,
    productionPublicationAttempted: false,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

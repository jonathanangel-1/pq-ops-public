#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root,
  "supabase/migrations/20260718070000_bind_primary_attachment_invalid_scoped_worker.sql"), "utf8");
const authority = fs.readFileSync(path.join(root,
  "supabase/migrations/20260718060000_authorize_primary_attachment_invalid_first_exhaustion.sql"), "utf8");
const claim = fs.readFileSync(path.join(root,
  "supabase/migrations/20260717930000_truth_gmail_attachment_invalid_scoped_drain.sql"), "utf8");

for (const required of [
  "truth_gmail_primary_attachment_invalid_worker_handoffs",
  "prior_processor_version='primary-attachment-model-drain-v1:worker-v1'",
  "next_processor_version='primary-attachment-invalid-drain-v1:worker-v1'",
  "retryLineageHash",
  "PRIMARY_ATTACHMENT_INVALID_SCOPED_WORKER_HANDOFF",
  "candidateClaimsAutoAccepted',false",
  "productionPublicationAttempted',false",
  "processor_version='primary-attachment-invalid-drain-v1:worker-v1'",
]) assert.ok(migration.includes(required), `handoff migration missing ${required}`);

assert.match(authority,
  /set state='retry_wait',max_attempts=v_job\.attempt_count\+3,\n\s+processor_version='primary-attachment-invalid-drain-v1:worker-v1'/);
assert.ok(claim.includes("p_processor_version is distinct from\n      'primary-attachment-invalid-drain-v1:worker-v1'"));
assert.ok(claim.includes("authority.canonical_lineage->>'captureAuthority'=\n       'retry_authorization_transition_v2'"));
assert.equal(/insert into public\.accepted_claims/i.test(migration), false);
assert.equal(/insert into public\.truth_publications/i.test(migration), false);

process.stdout.write(`${JSON.stringify({ ok: true,
  verifier: "truth-gmail-primary-attachment-invalid-handoff",
  oldProcessor: "primary-attachment-model-drain-v1:worker-v1",
  newProcessor: "primary-attachment-invalid-drain-v1:worker-v1",
  immutableHandoffReceipt: true, genericQueueBroadened: false,
  productionPublicationAttempted: false }, null, 2)}\n`);

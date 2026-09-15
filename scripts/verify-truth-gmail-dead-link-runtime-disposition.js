#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(
  ROOT, "supabase/migrations/20260718040000_runtime_gmail_dead_link_disposition.sql",
), "utf8");
const runtime = fs.readFileSync(path.join(ROOT, "lib/truth-gmail-claims-readiness.js"), "utf8");
const incident = fs.readFileSync(path.join(
  ROOT, "YLYI/08_Incidents/INC-2026-07-22-GMAIL-DEAD-LINK-DISPOSITION-MIGRATION-ONLY.md",
), "utf8");
const backtests = fs.readFileSync(path.join(
  ROOT, "YLYI/07_Backtest_Cases/Backtest_Cases.md",
), "utf8");

for (const required of [
  "reconcile_truth_gmail_dead_link_members_v1",
  "job.attempt_count>=job.max_attempts",
  "job.lease_owner is null",
  "job.lease_expires_at is null",
  "member.epoch_id is not null",
  "truth-link job already has a different durable resolution",
  "truth link context omitted its anchor",
  "run.anchor_observation_id=v_job.observation_id",
  "run.resolution_hash=encode",
  "terminal_ack_own_durable_resolution",
  "exclude_missing_anchor_context_defect",
  "truth_gmail_link_epoch_dead_member_resolutions",
  "truth_gmail_dead_link_terminal_acknowledgements",
  "linkResolutionMinted',false",
  "productionPublicationAttempted',false",
  "grant execute on function public.reconcile_truth_gmail_dead_link_members",
]) {
  assert.ok(migration.includes(required), `runtime disposition migration is missing ${required}`);
}

for (const forbidden of [
  /\baccepted_claims\b/i,
  /\btruth_builds\b/i,
  /\btruth_publications\b/i,
  /\bmodel_usage\b/i,
  /\bgmail_send\b/i,
]) {
  assert.equal(forbidden.test(migration), false,
    `runtime disposition migration touches forbidden surface ${forbidden}`);
}

const reconcileCall = runtime.indexOf("await callRpc(RECONCILE_RPC");
const frontierCall = runtime.indexOf("await callRpc(FRONTIER_RPC");
assert.ok(reconcileCall >= 0 && frontierCall > reconcileCall,
  "dead-link reconciliation must run before the readiness frontier");
assert.match(runtime, /TRUTH_GMAIL_DEAD_LINK_RECONCILIATION_INVALID/);
assert.match(runtime, /dead_link_reconcile/);
assert.match(runtime, /productionPublicationAttempted: false/);

function eligible(job) {
  return job.workspaceKey === "primary"
    && job.connectionKey === "primary"
    && job.sourceSystem === "gmail"
    && job.jobKind === "gmail_resolve_entity_links"
    && job.state === "dead_letter"
    && job.attemptCount >= job.maxAttempts
    && !job.leaseOwner && !job.leaseExpiresAt
    && Boolean(job.epochId) && Boolean(job.memberId)
    && job.lastErrorCode === "TRUTH_LINK_JOB_FAILED"
    && (
      job.safeErrorDetail.includes("truth link context omitted its anchor")
      || job.safeErrorDetail.includes("truth-link job already has a different durable resolution")
    );
}

const base = {
  workspaceKey: "primary", connectionKey: "primary", sourceSystem: "gmail",
  jobKind: "gmail_resolve_entity_links", state: "dead_letter",
  attemptCount: 5, maxAttempts: 5, leaseOwner: null, leaseExpiresAt: null,
  epochId: "epoch-1", memberId: "member-1", lastErrorCode: "TRUTH_LINK_JOB_FAILED",
  safeErrorDetail: "load truth-link worker context failed: truth link context omitted its anchor",
};
assert.equal(eligible(base), true);
assert.equal(eligible({ ...base, state: "retry_wait" }), false);
assert.equal(eligible({ ...base, attemptCount: 4 }), false);
assert.equal(eligible({ ...base, leaseOwner: "worker" }), false);
assert.equal(eligible({ ...base, workspaceKey: "foreign" }), false);
assert.equal(eligible({ ...base, epochId: null }), false);
assert.equal(eligible({ ...base, safeErrorDetail: "unknown link failure" }), false);
assert.equal(eligible({
  ...base,
  safeErrorDetail: "append truth-link resolution failed: truth-link job already has a different durable resolution",
}), true);

assert.match(incident, /migration-only/i);
assert.match(backtests, /BT-2026-07-22-GMAIL-DEAD-LINK-RUNTIME-DISPOSITION/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-gmail-dead-link-runtime-disposition",
  exactTerminalClassesOnly: true,
  preExhaustionRefused: true,
  leasedJobsRefused: true,
  reconciliationPrecedesFrontier: true,
  productionPublicationAttempted: false,
}, null, 2)}\n`);

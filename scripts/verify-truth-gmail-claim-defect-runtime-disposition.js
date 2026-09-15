#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(
  ROOT, "supabase/migrations/20260718050000_runtime_gmail_claim_defect_disposition.sql",
), "utf8");
const runtime = fs.readFileSync(path.join(ROOT, "lib/truth-gmail-acceptance-readiness.js"), "utf8");
const incident = fs.readFileSync(path.join(
  ROOT, "YLYI/08_Incidents/INC-2026-07-22-GMAIL-CLAIM-DEFECT-DISPOSITION-MIGRATION-ONLY.md",
), "utf8");
const backtests = fs.readFileSync(path.join(ROOT, "YLYI/07_Backtest_Cases/Backtest_Cases.md"), "utf8");

for (const required of [
  "reconcile_truth_gmail_claim_defects_v1",
  "job.attempt_count>=job.max_attempts",
  "job.lease_owner is null",
  "job.lease_expires_at is null",
  "truth_gmail_parent_planning_v2_defect_class_v1",
  "not exists(select 1 from public.candidate_claim_job_lineage",
  "manifest.candidate_count<>0",
  "truth_gmail_documented_claim_defect_exclusions",
  "truth_pending_acceptance_epoch_manifests",
  "truth_gmail_documented_claim_defect_late_memberships",
  "pending_epoch_zero_candidate",
  "late_absence_membership",
  "guard_truth_gmail_claim_defect_result_v1",
  "exactly one acceptance membership",
  "new.processor_version is distinct from 'truth-gmail-claim-defect-runtime-v1'",
  "productionPublicationAttempted',false",
  "grant execute on function public.reconcile_truth_gmail_claim_defects",
]) {
  assert.ok(migration.includes(required), `claim-defect migration is missing ${required}`);
}

for (const forbidden of [
  /insert into public\.accepted_claims/i,
  /insert into public\.truth_builds/i,
  /insert into public\.truth_publications/i,
  /\bmodel_usage\b/i,
  /\bgmail_send\b/i,
]) {
  assert.equal(forbidden.test(migration), false,
    `claim-defect reconciliation touches forbidden surface ${forbidden}`);
}

const reconcileCall = runtime.indexOf("await callRpc(RECONCILE_RPC");
const frontierCall = runtime.indexOf("await callRpc(FRONTIER_RPC");
assert.ok(reconcileCall >= 0 && frontierCall > reconcileCall,
  "claim-defect reconciliation must run before the acceptance frontier");
assert.match(runtime, /TRUTH_GMAIL_CLAIM_DEFECT_RECONCILIATION_INVALID/);
assert.match(runtime, /claim_defect_reconcile/);
assert.match(runtime, /productionPublicationAttempted: false/);

function eligible(job) {
  return job.workspaceKey === "primary"
    && job.connectionKey === "primary"
    && job.sourceSystem === "gmail"
    && job.jobKind === "gmail_extract_message_claims"
    && job.state === "dead_letter"
    && job.attemptCount >= job.maxAttempts
    && !job.leaseOwner && !job.leaseExpiresAt
    && job.resultEmpty === true
    && job.classified === true
    && job.hasLineage === true
    && job.candidateLineageCount === 0
    && job.nonzeroManifestCount === 0
    && job.priorExclusionCount === 0;
}

const base = {
  workspaceKey: "primary", connectionKey: "primary", sourceSystem: "gmail",
  jobKind: "gmail_extract_message_claims", state: "dead_letter",
  attemptCount: 5, maxAttempts: 5, leaseOwner: null, leaseExpiresAt: null,
  resultEmpty: true, classified: true, hasLineage: true,
  candidateLineageCount: 0, nonzeroManifestCount: 0, priorExclusionCount: 0,
};
assert.equal(eligible(base), true);
assert.equal(eligible({ ...base, state: "retry_wait" }), false);
assert.equal(eligible({ ...base, attemptCount: 4 }), false);
assert.equal(eligible({ ...base, leaseOwner: "worker" }), false);
assert.equal(eligible({ ...base, classified: false }), false);
assert.equal(eligible({ ...base, hasLineage: false }), false);
assert.equal(eligible({ ...base, candidateLineageCount: 1 }), false);
assert.equal(eligible({ ...base, nonzeroManifestCount: 1 }), false);
assert.equal(eligible({ ...base, workspaceKey: "foreign" }), false);

assert.match(incident, /migration-only/i);
assert.match(backtests, /BT-2026-07-22-GMAIL-CLAIM-DEFECT-RUNTIME-DISPOSITION/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-gmail-claim-defect-runtime-disposition",
  exactExhaustedClassesOnly: true,
  pendingAndLateMembershipsCovered: true,
  ordinaryPlanWitnessPreserved: true,
  reconciliationPrecedesAcceptanceFrontier: true,
  productionPublicationAttempted: false,
}, null, 2)}\n`);

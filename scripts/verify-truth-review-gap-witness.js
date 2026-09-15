#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718190000_bound_truth_review_gap_witness.sql",
), "utf8");
const incident = fs.readFileSync(path.join(
  ROOT,
  "YLYI/08_Incidents/INC-2026-07-22-RELATIONAL-PUBLICATION-FAILS-BOARD-CERTIFICATION.md",
), "utf8");
const backtests = fs.readFileSync(path.join(
  ROOT,
  "YLYI/07_Backtest_Cases/Backtest_Cases.md",
), "utf8");

for (const required of [
  "reconciled_stale_candidates as materialized",
  "gmail_stale_extraction_plan_reconciliations",
  "truth_shadow_is_reconciled_stale_candidate_v1",
  "latest_candidate_decisions as materialized",
  "scoped_link_ids as materialized",
  "latest_link_decisions as materialized",
  "CANDIDATE_CLAIM_REVIEW_PENDING",
  "LINK_WORKGROUP_REVIEW_PENDING",
  "string_agg(",
  "'sha256'",
]) {
  assert.ok(migration.includes(required), `review-gap migration is missing ${required}`);
}

const functionBody = migration.match(/as \$function\$([\s\S]*?)\$function\$;/)?.[1] || "";
assert.equal(functionBody.includes("left join lateral"), false,
  "bounded review-gap witness must not restore per-row latest-decision probes");
assert.equal(functionBody.includes(
  "and not private.truth_shadow_is_reconciled_stale_candidate_v1("), false,
"candidate scan must not invoke the reconciliation proof for every candidate");
assert.equal(/\b(?:insert|update|delete|truncate)\b/i.test(migration), false,
  "review-gap migration must not mutate operational rows");
assert.match(incident, /166\s+seconds/);
assert.match(backtests, /inside the hosted RPC budget/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-review-gap-witness",
  staleCandidatePrefilteredByImmutableLedger: true,
  latestDecisionsMaterializedOnce: true,
  witnessContractPreserved: true,
  mutatesOperationalRows: false,
}, null, 2)}\n`);

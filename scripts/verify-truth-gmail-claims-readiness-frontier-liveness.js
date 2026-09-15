#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = [
  "supabase/migrations/20260718020000_prioritize_actionable_gmail_claims_readiness.sql",
  "supabase/migrations/20260718210000_expose_gmail_checkpoint_presence.sql",
].map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
const incident = fs.readFileSync(path.join(
  ROOT,
  "YLYI/08_Incidents/INC-2026-07-22-GMAIL-CLAIMS-READINESS-FRONTIER-STARVATION.md",
), "utf8");
const backtests = fs.readFileSync(path.join(
  ROOT,
  "YLYI/07_Backtest_Cases/Backtest_Cases.md",
), "utf8");

for (const required of [
  "truth-gmail-claims-readiness-frontier-liveness-v1",
  "truth_gmail_parse_checkpoint_late_parse_reconciliations",
  "truth_gmail_parse_absence_resolutions",
  "truth_gmail_link_epoch_dead_member_resolutions",
  "truth_gmail_live_dead_letter_authorizations",
  "when shaped.ready_to_seal then 0",
  "when shaped.checkpoint_ready and shaped.epoch_id is null then 1",
  "when shaped.checkpoint_id is null then 2",
  "when shaped.epoch_id is not null then 3",
  "order by readiness_phase,committed_cursor_version,batch_id",
  "limit p_limit",
  "productionPublicationAttempted',false",
  "'checkpointPresent',bounded.checkpoint_id is not null",
]) {
  assert.ok(migration.includes(required), `liveness migration is missing ${required}`);
}

const rankedPosition = migration.indexOf("), ranked as (");
const boundedPosition = migration.indexOf("), bounded as materialized (");
const limitPosition = migration.indexOf("limit p_limit", boundedPosition);
assert.ok(rankedPosition > 0 && boundedPosition > rankedPosition && limitPosition > boundedPosition,
  "the bound must be applied only after executable-phase classification");

for (const forbidden of [
  /\binsert\s+into\s+public\./i,
  /\bupdate\s+public\./i,
  /\bdelete\s+from\s+public\./i,
  /\btruncate\b/i,
  /\balter\s+role\b/i,
  /truth_publications/i,
  /accepted_claims/i,
  /shipment-truth-packets/i,
]) {
  assert.equal(forbidden.test(migration), false,
    `readiness selection migration contains forbidden mutation/publication surface ${forbidden}`);
}

function phase(row) {
  if (row.readyToSeal) return 0;
  if (row.checkpointReady && !row.epochId) return 1;
  if (!row.checkpointId) return 2;
  if (row.epochId) return 3;
  return 4;
}

const rows = [
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `gap-${index}`,
    cursor: index + 1,
    checkpointId: `checkpoint-gap-${index}`,
    checkpointReady: false,
    epochId: null,
    readyToSeal: false,
  })),
  { id: "epoch-wait", cursor: 8, checkpointId: "checkpoint-8",
    checkpointReady: true, epochId: "epoch-8", readyToSeal: false },
  { id: "checkpoint-ready-old", cursor: 9, checkpointId: "checkpoint-9",
    checkpointReady: true, epochId: null, readyToSeal: false },
  { id: "checkpoint-ready-new", cursor: 10, checkpointId: "checkpoint-10",
    checkpointReady: true, epochId: null, readyToSeal: false },
  { id: "checkpoint-missing", cursor: 11, checkpointId: null,
    checkpointReady: false, epochId: null, readyToSeal: false },
  { id: "seal-ready", cursor: 12, checkpointId: "checkpoint-12",
    checkpointReady: true, epochId: "epoch-12", readyToSeal: true },
];
const bounded = rows.slice().sort((left, right) =>
  phase(left) - phase(right) || left.cursor - right.cursor || left.id.localeCompare(right.id)
).slice(0, 5);
assert.deepEqual(bounded.map((row) => row.id), [
  "seal-ready",
  "checkpoint-ready-old",
  "checkpoint-ready-new",
  "checkpoint-missing",
  "epoch-wait",
]);
assert.equal(bounded.some((row) => row.id.startsWith("gap-")), false,
  "unresolved historical gaps must not consume an executable slot");

assert.match(incident, /553 checkpoint-complete batches/);
assert.match(backtests, /BT-2026-07-22-GMAIL-CLAIMS-READINESS-FRONTIER-LIVENESS/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-gmail-claims-readiness-frontier-liveness",
  appliesLimitAfterExecutableRanking: true,
  preservesChronologyWithinPhase: true,
  unresolvedGapsRemainFailClosed: true,
  mutatesOperationalState: false,
  productionPublicationAttempted: false,
}, null, 2)}\n`);

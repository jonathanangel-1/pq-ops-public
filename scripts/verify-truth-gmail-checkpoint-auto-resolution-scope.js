#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260718030000_bound_gmail_checkpoint_auto_resolution_scope.sql",
), "utf8");
const incident = fs.readFileSync(path.join(
  ROOT,
  "YLYI/08_Incidents/INC-2026-07-22-GMAIL-CHECKPOINT-AUTO-RESOLUTION-UNBOUNDED-SCAN.md",
), "utf8");
const backtests = fs.readFileSync(path.join(
  ROOT,
  "YLYI/07_Backtest_Cases/Backtest_Cases.md",
), "utf8");

for (const required of [
  "gmail-checkpoint-auto-resolution-bounded-scope-v1",
  "gmail_materialization_groups_revision_resolution_idx",
  "gmail_revision_obligations_resolution_scope_idx",
  "candidate_obligation.workspace_key=p_workspace_key",
  "candidate_obligation.connection_key=p_connection_key",
  "candidate_obligation.message_id=group_row.message_id",
  "candidate_obligation.source_cursor_version<",
  "group_row.source_cursor_version",
  "candidate_obligation.reason_code<>",
  "FETCH_POISON_QUARANTINED_REVIEW",
  "gmail_message_revision_resolutions resolution",
  "resolution.obligation_id=candidate_obligation.obligation_id",
  "resolve_gmail_message_revision_obligation",
]) {
  assert.ok(migration.includes(required), `auto-resolution migration is missing ${required}`);
}

const oldLoop = migration.match(/v_old constant text := \$old\$([\s\S]*?)\$old\$/)?.[1] || "";
const newLoop = migration.match(/v_new constant text := \$new\$([\s\S]*?)\$new\$/)?.[1] || "";
assert.equal(oldLoop.includes("candidate_obligation"), false);
assert.ok(newLoop.includes("and exists("));
assert.ok(newLoop.indexOf("and exists(") < newLoop.indexOf("order by group_row.source_cursor_version"),
  "obligation scope must filter groups before chronological iteration");

for (const forbidden of [
  /\bupdate\s+public\./i,
  /\bdelete\s+from\s+public\./i,
  /\binsert\s+into\s+public\./i,
  /\btruncate\b/i,
  /\balter\s+role\b/i,
  /truth_publications/i,
  /accepted_claims/i,
]) {
  assert.equal(forbidden.test(migration), false,
    `auto-resolution selection migration contains forbidden state surface ${forbidden}`);
}

function canResolve(group, obligation, genesisCursor) {
  return group.workspaceKey === obligation.workspaceKey
    && group.connectionKey === obligation.connectionKey
    && group.messageId === obligation.messageId
    && obligation.sourceCursorVersion >= genesisCursor
    && obligation.sourceCursorVersion < group.sourceCursorVersion
    && obligation.reasonCode !== "FETCH_POISON_QUARANTINED_REVIEW"
    && obligation.resolved !== true;
}

const obligation = {
  workspaceKey: "primary", connectionKey: "primary", messageId: "message-1",
  sourceCursorVersion: 100, reasonCode: "PROVIDER_REVISION_AHEAD", resolved: false,
};
assert.equal(canResolve({ ...obligation, sourceCursorVersion: 101 }, obligation, 1), true);
assert.equal(canResolve({ ...obligation, messageId: "unrelated", sourceCursorVersion: 101 }, obligation, 1), false);
assert.equal(canResolve({ ...obligation, sourceCursorVersion: 100 }, obligation, 1), false);
assert.equal(canResolve({ ...obligation, sourceCursorVersion: 99 }, obligation, 1), false);
assert.equal(canResolve({ ...obligation, sourceCursorVersion: 101 }, { ...obligation, resolved: true }, 1), false);
assert.equal(canResolve({ ...obligation, sourceCursorVersion: 101 }, {
  ...obligation, reasonCode: "FETCH_POISON_QUARANTINED_REVIEW",
}, 1), false);

assert.match(incident, /1,377 Gmail materialization groups/);
assert.match(backtests, /BT-2026-07-22-GMAIL-CHECKPOINT-AUTO-RESOLUTION-BOUNDED-SCOPE/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-gmail-checkpoint-auto-resolution-scope",
  scansOnlyPotentialResolvingGroups: true,
  preservesStrictLaterCursor: true,
  preservesPoisonExclusion: true,
  mutatesOperationalState: false,
  productionPublicationAttempted: false,
}, null, 2)}\n`);

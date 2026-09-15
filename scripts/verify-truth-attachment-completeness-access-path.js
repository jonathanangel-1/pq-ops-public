#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migrationPath = path.join(
  ROOT,
  "supabase/migrations/20260718000000_fix_attachment_completeness_audit_access_path.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");
const incident = fs.readFileSync(path.join(
  ROOT,
  "YLYI/08_Incidents/INC-2026-07-22-ATTACHMENT-COMPLETENESS-AUDIT-TIMEOUT.md",
), "utf8");
const backtests = fs.readFileSync(
  path.join(ROOT, "YLYI/07_Backtest_Cases/Backtest_Cases.md"),
  "utf8",
);

for (const required of [
  "private.unresolved_gmail_attachment_extractions(text)",
  "source_observations_gmail_attachment_replacement_idx",
  "replacement.normalized_payload #>> '{extraction,reviewRequired}'",
  ") = 'false'",
  "= observation.normalized_payload->>'attachmentId'",
  "= observation.normalized_payload->>'parentObservationId'",
  "= observation.normalized_payload->>'rawSha256'",
  "attachment completeness helper differs from the reviewed predicate predecessor",
  "attachment completeness helper differs from the reviewed identity predecessor",
  "attachment completeness access-path rewrite did not apply exactly",
]) {
  assert.ok(migration.includes(required), `access-path migration is missing ${required}`);
}
assert.equal(
  /replacement\.normalized_payload->'extraction'->>'reviewRequired'\)::boolean[\s\S]*?= false/.test(
    migration.split("v_new constant text", 1)[0],
  ),
  true,
  "the migration must pin the exact boolean-cast predecessor",
);
assert.equal(
  /\b(?:insert|update|delete|truncate)\b/i.test(migration),
  false,
  "the access-path migration must not mutate production rows",
);
assert.equal(/\b(?:drop|create)\s+index\b/i.test(migration), false,
  "the existing reviewed partial index must be reused, not replaced");

function indexedPredicate(reviewRequired) {
  const jsonText = reviewRequired === undefined || reviewRequired === null
    ? "true"
    : String(reviewRequired);
  return jsonText === "false";
}

for (const value of [undefined, null, true, "true", "TRUE", "bogus", 0, 1, "0", "1"]) {
  assert.equal(indexedPredicate(value), false,
    `${String(value)} must remain unresolved by the fail-closed predicate`);
}
for (const value of [false, "false"]) {
  assert.equal(indexedPredicate(value), true,
    `${String(value)} must match the exact indexed false text`);
}

assert.match(incident, /purpose-built partial\s+index/);
assert.match(backtests, /BT-2026-07-22-ATTACHMENT-COMPLETENESS-AUDIT-ACCESS-PATH/);

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "truth-attachment-completeness-access-path",
  failClosedPredicate: true,
  reusesExistingPartialIndex: true,
  mutatesOperationalState: false,
  productionPublicationAttempted: false,
}, null, 2)}\n`);

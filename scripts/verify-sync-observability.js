#!/usr/bin/env node
"use strict";

// Sync-request observability verifier: queued / claimed / success / fail /
// stuck / stale-fallback states, operator language, and the lock rule.

const { deriveSyncRequestState, CLAIM_WINDOW_MINUTES } = require("../lib/sync-observability");

let checks = 0;
function ok(condition, label) {
  checks += 1;
  if (!condition) {
    console.error(`FAIL - ${label}`);
    process.exit(1);
  }
  console.log(`ok - ${label}`);
}

const NOW = "2026-07-04T18:00:00.000Z";
const minutesAgo = (m) => new Date(Date.parse(NOW) - m * 60000).toISOString();

// Queued inside the claim window.
const queued = deriveSyncRequestState({
  request: { status: "queued", queuedAt: minutesAgo(3) },
  now: NOW,
});
ok(queued.state === "queued" && queued.tone === "warn" && !queued.lockActions,
  `queued: recent request reports queued (got ${queued.state})`);

// Queued past the claim window = stuck, said plainly.
const stuck = deriveSyncRequestState({
  request: { status: "queued", queuedAt: minutesAgo(CLAIM_WINDOW_MINUTES + 5) },
  now: NOW,
});
ok(stuck.state === "stuck-unclaimed" && stuck.tone === "bad",
  `stuck: unclaimed past the window reports stuck (got ${stuck.state})`);
ok(/worker isn't picking it up/i.test(stuck.title),
  "stuck: the title says the worker is not picking it up");

// Claimed/running.
const claimed = deriveSyncRequestState({
  request: { status: "running", queuedAt: minutesAgo(9), claimedAt: minutesAgo(4) },
  now: NOW,
});
ok(claimed.state === "claimed" && !claimed.lockActions,
  `claimed: a claimed request reports claimed (got ${claimed.state})`);

// Running far too long = stuck too.
const stalled = deriveSyncRequestState({
  request: { status: "running", claimedAt: minutesAgo(40) },
  now: NOW,
});
ok(stalled.state === "stuck-unclaimed",
  `stalled: a 40m-old running request reports stuck (got ${stalled.state})`);

// Success + no new mail: "checked X ago, no new mail since Y".
const noNewMail = deriveSyncRequestState({
  refreshHealth: { lastRunStatus: "success", ageMinutes: 4, snapshotTime: minutesAgo(4) },
  proofSnapshotTime: minutesAgo(120),
  now: NOW,
});
ok(noNewMail.state === "checked-no-new-mail" && noNewMail.tone === "ok",
  `success: fresh run with old proof reports checked-no-new-mail (got ${noNewMail.state})`);
ok(/Checked .* no new mail since/i.test(`${noNewMail.title} ${noNewMail.sub}`),
  "success: the message says checked X ago, no new mail since Y");

// Success + proof advanced this run: new mail.
const newMail = deriveSyncRequestState({
  refreshHealth: { lastRunStatus: "success", ageMinutes: 4, snapshotTime: minutesAgo(4) },
  proofSnapshotTime: minutesAgo(3),
  now: NOW,
});
ok(newMail.state === "checked-new-mail",
  `success: proof landing with the run reports new mail (got ${newMail.state})`);

// Failed run, with its phase in operator words.
const failed = deriveSyncRequestState({
  refreshHealth: { lastRunStatus: "failed", lastFailedPhase: "hosted-persistence", ageMinutes: 6, snapshotTime: minutesAgo(6) },
  proofSnapshotTime: minutesAgo(60),
  now: NOW,
});
ok(failed.state === "failed" && failed.tone === "bad",
  `failed: a failed run reports failed (got ${failed.state})`);

// Bundled fallback: loud, and the ONLY state that locks actions.
const fallback = deriveSyncRequestState({
  hostedReadFallback: { at: NOW, error: "hosted snapshot read timed out", source: "bundled-repo-files" },
  bundledSnapshotTime: minutesAgo(60 * 26),
  now: NOW,
});
ok(fallback.state === "stale-fallback" && fallback.tone === "bad" && fallback.lockActions === true,
  `fallback: bundled backup reports stale-fallback with lockActions (got ${fallback.state})`);
ok(/backup copy/i.test(fallback.title) && /locked/i.test(fallback.sub),
  "fallback: the message says backup copy and that actions are locked");
const fallbackOutranks = deriveSyncRequestState({
  request: { status: "queued", queuedAt: minutesAgo(1) },
  refreshHealth: { lastRunStatus: "success", ageMinutes: 2, snapshotTime: minutesAgo(2) },
  hostedReadFallback: { at: NOW, error: "read failed" },
  now: NOW,
});
ok(fallbackOutranks.state === "stale-fallback",
  "fallback: outranks every other signal");

// Only the fallback locks.
for (const candidate of [queued, stuck, claimed, stalled, noNewMail, newMail, failed]) {
  ok(candidate.lockActions === false, `lock rule: ${candidate.state} does not lock actions`);
}

// No pipeline jargon on the operator surface.
for (const candidate of [queued, stuck, claimed, stalled, noNewMail, newMail, failed, fallback]) {
  const text = `${candidate.title} ${candidate.sub}`;
  ok(!/\b(?:canonical|packet|supabase|snapshot key|degraded|cron)\b/i.test(text),
    `language: ${candidate.state} message stays in operator words`);
}

// A days-old unclaimed request whose work a later successful run already did
// is superseded — report the run, not a forever-red stuck pill (live case:
// email-sync-1782877681395, queued 3 days, cron refreshed 800+ times since).
const superseded = deriveSyncRequestState({
  request: { status: "queued", queuedAt: minutesAgo(3 * 24 * 60) },
  refreshHealth: { lastRunStatus: "success", ageMinutes: 4, snapshotTime: minutesAgo(4) },
  proofSnapshotTime: minutesAgo(120),
  now: NOW,
});
ok(superseded.state === "checked-no-new-mail",
  `superseded: a later successful run outranks a stale open request (got ${superseded.state})`);

// Multi-day ages read as days, not hundreds of hours.
const oldStuck = deriveSyncRequestState({
  request: { status: "queued", queuedAt: minutesAgo(3 * 24 * 60) },
  now: NOW,
});
ok(/\d+ days ago/.test(oldStuck.sub),
  `ages: multi-day ages render as days (got "${oldStuck.sub}")`);

// Unknown when nothing is observable.
const unknown = deriveSyncRequestState({ now: NOW });
ok(unknown.state === "unknown" && unknown.lockActions === false,
  `unknown: no data reports unknown (got ${unknown.state})`);

console.log(JSON.stringify({ ok: true, checks }, null, 0));

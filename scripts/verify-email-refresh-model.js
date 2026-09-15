#!/usr/bin/env node
"use strict";

// ONE production email-refresh model (P0, 2026-07-09):
// - Gmail refresh runs through cron or the authenticated server-to-server
//   /api/email-refresh/run-now route, never an unauthenticated browser POST.
// - Old-but-verified-unchanged proof is NOT stale (refresh-health certifies).
// - Fleet/shipment locks key on per-row source certification, not proof age.
// - Stale local retry chrome clears once health proves a newer success.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const cronSource = fs.readFileSync(path.join(ROOT, "api/cron/gmail-refresh.js"), "utf8");
const runNowSource = fs.readFileSync(path.join(ROOT, "api/email-refresh/run-now.js"), "utf8");

let checks = 0;
function ok(condition, label) {
  checks += 1;
  if (!condition) {
    console.error(`FAIL - ${label}`);
    process.exit(1);
  }
  console.log(`ok - ${label}`);
}

// 1. The run-now endpoint reuses the REAL production refresh handler.
ok(/require\("\.\.\/cron\/gmail-refresh"\)/.test(runNowSource), "run-now reuses the cron gmail-refresh handler (one refresh model)");
ok(/force=1/.test(runNowSource), "run-now forces an explicit operator refresh");
ok(/Bearer \$\{secret\}/.test(runNowSource), "run-now authorizes the hosted path server-side");
ok(/PQ_EMAIL_REFRESH_RUN_NOW_TOKEN/.test(runNowSource) && /tokenMatches\(bearer\(request\), routeSecret\)/.test(runNowSource),
  "run-now requires an independent inbound route bearer before using CRON_SECRET");

// 2. Outcome classification is truthful and total.
const { classifyOutcome } = require("../api/email-refresh/run-now.js")._test;
assert.deepStrictEqual(classifyOutcome({ ok: true, changed: true, updated: 16 }).outcome, "updated");
assert.deepStrictEqual(classifyOutcome({ ok: true, changed: false, truthPacketsChanged: false }).outcome, "no-new-mail");
assert.deepStrictEqual(classifyOutcome({ ok: true, paused: true, reason: "disabled" }).outcome, "blocked");
assert.deepStrictEqual(classifyOutcome({ ok: false, phase: "gmail-list" }).outcome, "failed");
assert.deepStrictEqual(classifyOutcome({ ok: false, phase: "gmail-list" }).phase, "gmail-list");
ok(true, "classifyOutcome: updated / no-new-mail / blocked / failed-at-phase are all reachable and truthful");

// 3. Operator force bypasses the active-hours window; the window only rations cron.
ok(/if \(!forcedRefresh && !isActiveRefreshWindow\(now\)\)/.test(cronSource), "force=1 refreshes outside active hours for explicit operator runs");

// 4. The public/static browser mutation path is retired until an operator
// session can authorize it. Server credentials must never enter app.js.
ok(!appSource.includes('fetch("/api/email-refresh/run-now"'), "browser never POSTs the protected run-now endpoint");
ok(!appSource.includes("data-retry-gmail-refresh"), "browser exposes no unauthenticated Gmail mutation control");
ok(!appSource.includes("PQ_EMAIL_REFRESH_RUN_NOW_TOKEN"), "route authorization token is absent from browser source");
ok(appSource.includes('data-refresh-authority="server-only"') && appSource.includes("Automatic email sync only"),
  "UI labels email refresh as server automation only");
ok(appSource.includes("refreshButton.disabled = state.refresh.running || !manualRefreshAuthorized") &&
    appSource.includes('refreshButton.dataset.refreshAuthority = manualRefreshAuthorized ? "local-operator" : "server-only"') &&
    !appSource.includes("manual-full-refresh"),
  "the general production refresh control is disabled instead of queueing an unauthenticated full-refresh job");

// 5. Production never records fake legacy queue entries.
ok(/async function maybeQueueStaleEmailProofRefresh[\s\S]{0,400}if \(!canUseLocalApi\(\)\) return \{ requested: false, reason: "cron-owned" \};/.test(appSource),
  "auto proof-queue is local-dev only; production records no fake queued state");
ok(appSource.includes("manual refresh requires a signed-in operator session"),
  "manual refresh stays disabled until a real operator session authority exists");

// 6. Freshness semantics: verified-unchanged is not stale.
ok(appSource.includes('const runFresh = (health.status === "live" || payloadLive) && !refreshFailed;'),
  "globalProofFreshness treats a live health status with successful runs as fresh");
ok(appSource.includes("function payloadSourceHealthLive") &&
    appSource.includes('health.status === "live"') &&
    appSource.includes("payloadLive && Number.isFinite(payloadAgeMinutes)") &&
    appSource.includes('const runFresh = (health.status === "live" || payloadLive) && !refreshFailed;'),
  "globalProofFreshness treats a live shipment payload sourceHealth as fresh when /api/truth/health times out");
ok(/const staleProof = proof \? Boolean\(proof\.stale\) && !runFresh/.test(appSource),
  "an old proof snapshot verified by fresh successful runs is NOT stale");

// 7. Shipment/fleet locks key on per-row source certification, not proof age.
const gapFn = appSource.slice(appSource.indexOf("function shipmentHasSourceGap"), appSource.indexOf("function shipmentSourceGapReason"));
ok(gapFn.includes("sourceCertification") && !/proofAge|ageMinutes|GMAIL_PROOF_STALE/.test(gapFn),
  "shipmentHasSourceGap reads certified row signals, never raw proof age");

// 8. Browser source has no credential-shaped workaround for the retired path.
ok(!/authorization:\s*`Bearer/.test(appSource) && !/x-vercel-protection-bypass/i.test(appSource),
  "browser source contains neither route Bearer nor Vercel bypass headers");

// 9. No fake cron-watch states remain in the machine.
ok(!/waiting_for_cron|nextRunMs/.test(appSource), "no passive queued/waiting-for-cron machine states remain");

console.log(JSON.stringify({ ok: true, checks }));

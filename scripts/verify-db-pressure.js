#!/usr/bin/env node
"use strict";

// DB-pressure invariants. Source-contract checks (same style as verify-ops-brain-companion)
// plus behavioral checks for the write guard. These protect the Supabase IO/connection budget
// WITHOUT weakening truth: evidence capture is untouched; only transport/dedup/lazy-read
// behavior is pinned.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT_DIR, relative), "utf8");

function main() {
  const supabaseAgent = read("lib/supabase-agent.js");
  const truthHealth = read("lib/truth-health.js");
  const ingest = read("lib/gmail-direct-ingest.js");
  const shipmentsApi = read("api/brain/shipments.js");
  const companion = read("lib/ops-brain-companion.js");

  // 1. Write guard: writes fail fast on open circuit, mark the circuit on failure, and are
  //    hard-pausable without a deploy.
  assert.match(supabaseAgent, /function guardSupabaseWrite\(/, "Supabase writes must have a pressure guard");
  assert.match(supabaseAgent, /PQ_SUPABASE_WRITES_DISABLED/, "Supabase writes must be pausable via PQ_SUPABASE_WRITES_DISABLED");
  assert.match(supabaseAgent, /guardSupabaseWrite[\s\S]*supabaseReadCircuitHealth\(\)\.open[\s\S]*supabaseReadCircuitError\(\)/, "Open circuit must fail writes fast");
  assert.match(supabaseAgent, /withSupabaseWriteCircuit[\s\S]*markSupabaseReadFailure\(error\)/, "Write failures must open the shared circuit");
  assert.match(supabaseAgent, /upsertAppSnapshot[\s\S]{0,600}withSupabaseWriteCircuit/, "upsertAppSnapshot must run inside the write circuit");
  assert.match(supabaseAgent, /queueAgentJob[\s\S]{0,200}guardSupabaseWrite/, "queueAgentJob must run behind the write guard");
  assert.match(supabaseAgent, /upsertOpsFactLedger[\s\S]{0,300}withSupabaseWriteCircuit/, "upsertOpsFactLedger must run inside the write circuit");

  // 2. Board render must not fetch the multi-MB gmail proof payload.
  assert.match(shipmentsApi, /readOpsBrainMemory\(rootDir, process\.env, \{ includeGmailProof: false \}\)/, "Board render must skip the gmail-proof payload");
  assert.match(companion, /includeGmailProof[\s\S]*gmail-proof-lazy/, "Hosted memory must support the lazy gmail-proof mode");
  assert.match(companion, /proof:\$\{options\.includeGmailProof === false \? "lazy" : "eager"\}/, "Memory cache identity must include the lazy/eager proof mode");
  assert.match(companion, /PIKIIO_HOSTED_TRUTH_SNAPSHOT_TIMEOUT_MS/, "Canonical truth reads must have a dedicated hosted timeout");
  assert.match(
    companion,
    /loadHostedSnapshot\(config, "shipment-truth-packets", \{ timeoutMs: HOSTED_TRUTH_SNAPSHOT_TIMEOUT_MS \}\)/,
    "The mandatory multi-megabyte truth packet must not use the short optional-snapshot timeout",
  );

  // 3. Truth health must classify hosted truth metadata-first: signature-verified bundle rows
  //    replace the payload fetch; payload read remains only for mismatch/absence.
  assert.match(truthHealth, /hostedMatchesLocalBundle/, "Truth health must support metadata-signature verification against the bundle");
  assert.match(truthHealth, /hostedMatchesLocalBundle\)[\s\S]{0,300}payload: localTruth/, "Signature match must certify from bundle rows without a payload fetch");
  assert.match(truthHealth, /payloadReadSkipped: hostedMatchesLocalBundle/, "Health must expose when the payload read was skipped");
  assert.match(truthHealth, /payloadReadAttempts/, "Health must expose bounded payload-read recovery attempts");
  assert.match(truthHealth, /PQ_TRUTH_HEALTH_SUPABASE_RECOVERY_TIMEOUT_MS/, "Health payload recovery must have a dedicated bounded timeout");

  // 4. Unchanged snapshots must not travel: derived writes are signature-gated on their OWN
  //    content (no proofChanged force), truth-packets/action-queue/proof writes stay gated.
  assert.doesNotMatch(
    ingest.slice(ingest.indexOf("const derivedSnapshotWrites")),
    /^\s*const derivedSnapshotWrites[\s\S]{0,200}proofChanged \|\|/,
    "Derived snapshot writes must be gated by their own contentSignature, not forced by proofChanged",
  );
  assert.match(ingest, /if \(proofChanged\) \{[\s\S]{0,160}upsertAppSnapshot\("gmail-proof-snapshot"/, "Proof snapshot write must stay signature-gated");
  assert.match(ingest, /if \(truthPacketsChanged\) \{[\s\S]{0,1200}publishHostedCanonicalTruth/, "Canonical publisher call must stay change-gated");
  assert.ok(
    ingest.indexOf('upsertAppSnapshot("gmail-proof-snapshot"') < ingest.indexOf("await publishHostedCanonicalTruth(") &&
      ingest.indexOf("await publishHostedCanonicalTruth(") < ingest.indexOf('upsertAppSnapshot("gmail-direct-state"'),
    "Gmail refresh writes must persist proof before promoted truth and direct-state last to prevent partial stale-proof truth",
  );

  // 5. Every Supabase-touching cron must have an emergency pause switch plus the global pause.
  const cronFlags = [
    ["api/cron/gmail-refresh.js", "PQ_GMAIL_REFRESH_DISABLED"],
    ["api/cron/autonomous-drafts.js", "PQ_AUTONOMOUS_DRAFTS_DISABLED"],
    ["api/cron/eod-report.js", "PQ_EOD_REPORT_DISABLED"],
    ["api/cron/morning-refresh.js", "PQ_MORNING_REFRESH_DISABLED"],
    ["api/cron/morning-operator-report.js", "PQ_MORNING_REPORT_DISABLED"],
  ];
  for (const [file, flag] of cronFlags) {
    const source = read(file);
    assert.ok(source.includes(flag), `${file} must honor ${flag}`);
    assert.ok(source.includes("PQ_CRON_SUPABASE_PAUSED"), `${file} must honor the global PQ_CRON_SUPABASE_PAUSED pause`);
  }

  // 6. Behavioral: the write guard actually blocks and reports.
  const agent = require("../lib/supabase-agent");
  process.env.PQ_SUPABASE_WRITES_DISABLED = "1";
  process.env.PQ_SUPABASE_URL = process.env.PQ_SUPABASE_URL || "https://example.supabase.co";
  process.env.PQ_SUPABASE_SYNC_TOKEN = process.env.PQ_SUPABASE_SYNC_TOKEN || "test-token";
  return agent.upsertAppSnapshot("db-pressure-test", { ok: true })
    .then(() => {
      throw new Error("upsertAppSnapshot must fail fast when writes are disabled");
    })
    .catch((error) => {
      assert.ok(error && error.writesDisabled === true, `Writes-disabled failure must be explicit, got: ${error && error.message}`);
    })
    .finally(() => {
      delete process.env.PQ_SUPABASE_WRITES_DISABLED;
    })
    .then(async () => {
      const calls = [];
      const recovered = await require("../lib/truth-health")._test.loadHostedTruthPayloadRows({
        timeoutMs: 900,
        recoveryTimeoutMs: 1800,
        wait: async () => {},
        loadRows: async (_keys, options) => {
          calls.push(options);
          if (calls.length === 1) {
            const error = new Error("Runtime deadline expired before Supabase RPC read_app_snapshots could complete.");
            error.code = "TRUTH_RUNTIME_DEADLINE_EXCEEDED";
            error.deadlineExceeded = true;
            throw error;
          }
          return [{ snapshot_key: "shipment-truth-packets", payload: { ok: true } }];
        },
      });
      assert.equal(recovered.attempts, 2, "Truth health must make exactly one recovery attempt after a payload deadline");
      assert.equal(recovered.recoveryUsed, true, "Truth health must report when recovery was used");
      assert.deepEqual(calls.map((call) => [call.timeoutMs, call.useCircuitBreaker]), [[900, true], [1800, false]],
        "Recovery must keep the fast first deadline and bypass the opened circuit only for one bounded retry");
    })
    .then(() => {
      console.log(JSON.stringify({
        ok: true,
        checked: [
          "write-guard-circuit-and-pause",
          "board-lazy-gmail-proof",
          "canonical-truth-dedicated-read-timeout",
          "memory-cache-proof-mode-identity",
          "truth-health-metadata-first",
          "truth-health-bounded-payload-recovery",
          "derived-writes-own-signature-gating",
          "cron-emergency-pause-switches",
          "writes-disabled-behavioral",
        ],
      }, null, 2));
    });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

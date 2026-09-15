#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VERIFIERS = Object.freeze([
  "verify-truth-foundation-syntax.js",
  "verify-canonical-publisher.js",
  "verify-gmail-api-client.js",
  "verify-gmail-mailbox-ledger.js",
  "verify-gmail-incremental-sync.js",
  "verify-gmail-mailbox-backfill.js",
  "verify-gmail-scoped-shadow-backfill.js",
  "verify-gmail-rfc822-parser.js",
  "verify-gmail-evidence-worker.js",
  "verify-gmail-attachment-worker.js",
  "verify-truth-attachment-extraction-completeness.js",
  "verify-truth-runtime-deadlines.js",
  "verify-gmail-claim-extractor.js",
  "verify-openai-gmail-model-extractor.js",
  "verify-openai-truth-model-batch.js",
  "verify-truth-model-usage-ledger.js",
  "verify-truth-model-plan-runtime.js",
  "verify-truth-model-extraction-worker.js",
  "verify-truth-gmail-parent-planning-worker.js",
  "verify-gmail-cross-thread-linker.js",
  "verify-truth-link-worker.js",
  "verify-source-processing-job-ledger.js",
  "verify-tms-source-snapshot.js",
  "verify-tms-claim-extractor.js",
  "verify-truth-tms-inventory-presence-policy.js",
  "verify-tms-inventory-truth-path.js",
  "verify-tracking-source-snapshot.js",
  "verify-tracking-claim-extractor.js",
  "verify-operator-source-delta.js",
  "verify-operator-claim-extractor.js",
  "verify-source-snapshot-committer.js",
  "verify-truth-generic-source-contracts.js",
  "verify-truth-evidence-ledger.js",
  "verify-truth-claim-worker.js",
  "verify-truth-worker-context-runtime.js",
  "verify-truth-source-chronology.js",
  "verify-truth-source-cut-ledger.js",
  "verify-truth-source-cut-coordinator.js",
  "verify-truth-tracking-scope-ledger.js",
  "verify-truth-tracking-scope-authority.js",
  "verify-truth-tracking-scope-api.js",
  "verify-truth-source-ingest-runtime.js",
  "verify-truth-source-ingest-api.js",
  "verify-truth-source-ingest-client.js",
  "verify-truth-source-edge-sync.js",
  "verify-truth-shadow-orchestrator.js",
  "verify-hosted-truth-shadow-runtime.js",
  "verify-truth-shadow-refresh-api.js",
  "verify-truth-audit-status.js",
  "verify-truth-review-runtime.js",
  "verify-truth-review-api.js",
  "verify-truth-review-resolution.js",
  "verify-truth-production-witness.js",
  "verify-truth-processing-watermark.js",
  "verify-truth-processing-watermark-runtime.js",
  "verify-truth-operator-event-authority.js",
  "verify-truth-operator-event-ledger.js",
  "verify-truth-operator-event-runtime.js",
  "verify-truth-operator-event-api.js",
  "verify-truth-operator-browser-runtime.js",
  "verify-truth-operator-browser-api.js",
  "verify-truth-operator-browser-ui.js",
  "verify-truth-raw-object-store.js",
  "verify-truth-private-evidence-bucket.js",
  "verify-truth-workspace-registry.js",
  "verify-truth-relational-contract.js",
  "verify-relational-truth-reducer.js",
  "verify-relational-truth-delivery-adapter.js",
  "verify-truth-build-shipment-metadata.js",
  "verify-relational-truth-build-runtime.js",
  "verify-relational-truth-auditor.js",
  "verify-relational-truth-audit-runtime.js",
  "verify-truth-precedence-policy.js",
  "verify-truth-predicate-registry.js",
  "verify-truth-temporal-resolver.js",
  "verify-protected-origin-auth.js",
  "verify-automation-contracts.js",
  "verify-truth-claim-query-plan.js",
  "verify-truth-shadow-model-prepare-query-plan.js",
  "verify-truth-gmail-resumed-model-child-admission.js",
  "verify-truth-gmail-resumed-model-terminal-authority.js",
  "verify-truth-shadow-late-model-acceptance.js",
  "verify-truth-shadow-late-model-cli.js",
  "verify-truth-shadow-link-sample-acceptance.js",
  "verify-truth-shadow-link-sample-cli.js",
  "verify-truth-full-migration-stack.js",
]);

function main() {
  const startedAt = Date.now();
  const results = [];
  for (const verifier of VERIFIERS) {
    const absolutePath = path.join(ROOT, "scripts", verifier);
    assert.ok(fs.existsSync(absolutePath), `Missing truth-foundation verifier ${verifier}`);
    const verifierStartedAt = Date.now();
    const run = spawnSync(process.execPath, [absolutePath], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Date.now() - verifierStartedAt;
    if (run.status !== 0 || run.error) {
      if (run.stdout) process.stdout.write(run.stdout);
      if (run.stderr) process.stderr.write(run.stderr);
      const error = run.error || new Error(`${verifier} exited ${run.status}`);
      error.verifier = verifier;
      throw error;
    }
    results.push({ verifier, durationMs });
    process.stdout.write(`[truth-foundation] PASS ${verifier} (${durationMs} ms)\n`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "truth-foundation",
    verifierCount: results.length,
    durationMs: Date.now() - startedAt,
    liveCalls: 0,
    productionPublications: 0,
    results,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[truth-foundation] FAIL ${error.verifier || "release gate"}: ${error.stack || error}\n`);
  process.exitCode = 1;
}

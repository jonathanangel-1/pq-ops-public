#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  JOB_KIND,
} = require("../lib/truth-gmail-attachment-model-worker");
const {
  PINNED_MODEL,
  PROCESSING_CONFIG,
  PROCESSING_CONFIG_HASH,
  PROCESSING_CONFIG_VERSION,
  prepareRequest,
} = require("../lib/openai-gmail-attachment-model-extractor");
const {
  drainWorker,
  _test,
} = require("./run-primary-attachment-model-drain");

const ROOT = path.resolve(__dirname, "..");
const runner = fs.readFileSync(
  path.join(ROOT, "scripts/run-primary-attachment-model-drain.js"),
  "utf8",
);
const incident = fs.readFileSync(
  path.join(ROOT, "YLYI/08_Incidents/INC-2026-07-22-PRIMARY-ATTACHMENT-MODEL-RUNTIME-ORPHANED.md"),
  "utf8",
);
const backtests = fs.readFileSync(
  path.join(ROOT, "YLYI/07_Backtest_Cases/Backtest_Cases.md"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260717990000_truth_gmail_attachment_minimal_reasoning_wire.sql"),
  "utf8",
);

function receipt(fields = {}) {
  const jobs = fields.jobs || [];
  return {
    ok: fields.ok ?? true,
    claimedCount: jobs.length,
    succeededCount: fields.succeededCount || 0,
    failedCount: fields.failedCount || 0,
    reviewCount: fields.reviewCount || 0,
    requeuedCount: fields.requeuedCount || 0,
    reservedMicroUsd: fields.reservedMicroUsd || 0,
    actualMicroUsd: fields.actualMicroUsd || 0,
    jobs,
    productionPublicationAttempted: false,
  };
}

async function verifyObservedRetryDrain() {
  let nowMs = Date.parse("2026-07-22T09:30:00.000Z");
  const waits = [];
  const fixtures = [
    receipt({
      ok: false,
      failedCount: 1,
      jobs: [{
        ok: false,
        jobId: "10000000-0000-4000-8000-000000000001",
        errorCode: "OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT",
        failureReceipt: {
          state: "retry_wait",
          availableAt: new Date(nowMs + 5_000).toISOString(),
        },
      }],
    }),
    receipt(),
    receipt({
      succeededCount: 1,
      reservedMicroUsd: 100,
      actualMicroUsd: 75,
      jobs: [{
        ok: true,
        jobId: "10000000-0000-4000-8000-000000000001",
        outcome: "succeeded",
      }],
    }),
    receipt(),
  ];
  const worker = {
    jobKind: JOB_KIND,
    async runOnce(input) {
      assert.deepEqual(input, { limit: 5 });
      return fixtures.shift();
    },
  };
  const result = await drainWorker({
    worker,
    rounds: 10,
    limit: 5,
    now: () => nowMs,
    wait: async (delayMs) => { waits.push(delayMs); nowMs += delayMs; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.drained, true);
  assert.equal(result.claimedCount, 2);
  assert.equal(result.succeededCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.actualMicroUsd, 75);
  assert.equal(result.pendingObservedRetryCount, 0);
  assert.equal(waits.length, 1,
    "a zero claim with an observed retry must wait instead of reporting drained");
  assert.ok(waits[0] >= 5_000 && waits[0] <= 5_100);
}

async function verifyUnexpectedFailureStops() {
  const worker = {
    jobKind: JOB_KIND,
    async runOnce() {
      return receipt({
        ok: false,
        failedCount: 1,
        jobs: [{
          ok: false,
          jobId: "10000000-0000-4000-8000-000000000002",
          errorCode: "ATTACHMENT_MODEL_OUTCOME_UNKNOWN",
          failureReceipt: { state: "retry_wait" },
        }],
      });
    },
  };
  await assert.rejects(
    drainWorker({ worker, rounds: 1, limit: 1 }),
    (error) => error?.code === "PRIMARY_ATTACHMENT_MODEL_DRAIN_UNEXPECTED_FAILURE",
  );
}

function verifyProviderWire() {
  const bytes = Buffer.from("primary attachment drain fixture", "utf8");
  const prepared = prepareRequest({
    bytes,
    rawSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    filename: "fixture.png",
    mimeType: "image/png",
    sourceObservationId: `obs:v1:${"a".repeat(64)}`,
    sourceObservationContentHash: "b".repeat(64),
  });
  assert.equal(prepared.requestBody.model, PINNED_MODEL);
  assert.deepEqual(prepared.requestBody.reasoning, { effort: "minimal" });
  assert.equal(Object.hasOwn(prepared.requestBody, "temperature"), false);
  assert.equal(prepared.requestBody.store, false);
  assert.equal(prepared.requestBody.text.format.strict, true);
  assert.equal(prepared.requestBody.text.format.type, "json_schema");
  assert.equal(PROCESSING_CONFIG_VERSION, "gmail-attachment-model-processing-config-v2");
  assert.equal(PROCESSING_CONFIG.reasoningEffort, "minimal");
  assert.equal(PROCESSING_CONFIG_HASH,
    "ef97ded848a80bd68d394d602b3767816234e55cce79b93ebf7560dd4715fd25");
}

(async () => {
  for (const expected of [
    "createSourceProcessingJobLedger",
    "createTruthGmailAttachmentModelLedger",
    "createTruthGmailAttachmentModelWorker",
    "createServerTruthRawObjectStore",
    "createOpenAIGmailAttachmentModelExtractor",
    "jobKinds: Object.freeze([JOB_KIND])",
    "PQ_TRUTH_MODEL_RUNTIME_ENABLED=1",
    "AbortSignal.timeout(PROVIDER_TIMEOUT_MS)",
    "candidateClaimsAutoAccepted: false",
    "mutatesOperationalState: false",
    "productionPublicationAttempted: false",
  ]) assert.ok(runner.includes(expected), `primary attachment runner is missing ${expected}`);
  assert.ok(!runner.includes("claim_truth_gmail_attachment_invalid_first_exhaustion_jobs"),
    "the generic primary runner must not use the invalid-exhaustion-only claim route");
  assert.ok(incident.includes("160 `gmail_review_attachment_extraction`"));
  assert.ok(backtests.includes("BT-2026-07-22-PRIMARY-ATTACHMENT-MODEL-RUNTIME-OWNERSHIP"));
  for (const expected of [
    "private.create_truth_gmail_attachment_model_request",
    "gmail-attachment-model-processing-config-v1",
    "gmail-attachment-model-processing-config-v2",
    "8d1b7f10f68ad9e953e57545835582f6da4e3a6f78d9c014bde176e74456cdd3",
    "ef97ded848a80bd68d394d602b3767816234e55cce79b93ebf7560dd4715fd25",
  ]) assert.ok(migration.includes(expected), `minimal-reasoning migration is missing ${expected}`);
  assert.ok(!/\b(insert|update|delete)\s+(into|public\.|from)/i.test(migration),
    "minimal-reasoning authority must not mutate production rows");
  assert.equal(_test.PROVIDER_TIMEOUT_MS, 120_000);
  assert.equal(_test.MAX_OBSERVED_RETRY_WAIT_MS, 60_000);
  await verifyObservedRetryDrain();
  await verifyUnexpectedFailureStops();
  verifyProviderWire();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "primary-attachment-model-drain",
    jobKind: JOB_KIND,
    providerTimeoutMs: _test.PROVIDER_TIMEOUT_MS,
    minimalReasoning: true,
    candidateClaimsAutoAccepted: false,
    mutatesOperationalState: false,
    productionPublicationAttempted: false,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

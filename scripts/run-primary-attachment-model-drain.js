#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { callSupabaseRpc } = require("../lib/supabase-agent");
const { createSourceProcessingJobLedger } = require("../lib/source-processing-job-ledger");
const {
  createOpenAIGmailAttachmentModelExtractor,
} = require("../lib/openai-gmail-attachment-model-extractor");
const {
  createTruthGmailAttachmentModelLedger,
} = require("../lib/truth-gmail-attachment-model-ledger");
const {
  createTruthGmailAttachmentModelWorker,
  JOB_KIND,
} = require("../lib/truth-gmail-attachment-model-worker");
const {
  createServerTruthRawObjectStore,
} = require("../lib/truth-raw-object-store-factory");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = "primary";
const SOURCE_SYSTEM = "gmail";
const CONNECTION = "primary";
const VERSION = "primary-attachment-model-drain-v1";
const WORKER_ID = VERSION;
const PROCESSOR_VERSION = `${VERSION}:worker-v1`;
const PROVIDER_TIMEOUT_MS = 120_000;
const MAX_OBSERVED_RETRY_WAIT_MS = 60_000;
const EXPECTED_REVIEW_FAILURES = new Set([
  "OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT",
]);

function arg(name, fallback = "") {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}
function flag(name) { return process.argv.includes(name); }
function integer(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return parsed;
}
function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(ROOT, fileName);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
}

function providerFetch(url, init = {}) {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return globalThis.fetch(url, { ...init, signal });
}

function failureState(job) {
  return String(job?.failureReceipt?.state || "");
}

function retryAvailableAtMs(job, nowMs) {
  const parsed = Date.parse(String(job?.failureReceipt?.availableAt || ""));
  return Number.isFinite(parsed) ? parsed : nowMs + 5_000;
}

function assertWorkerReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || receipt.productionPublicationAttempted !== false
      || !Array.isArray(receipt.jobs)
      || !Number.isSafeInteger(receipt.claimedCount)
      || receipt.claimedCount !== receipt.jobs.length
      || !Number.isSafeInteger(receipt.succeededCount)
      || !Number.isSafeInteger(receipt.failedCount)
      || !Number.isSafeInteger(receipt.reviewCount)
      || !Number.isSafeInteger(receipt.reservedMicroUsd)
      || !Number.isSafeInteger(receipt.actualMicroUsd)) {
    throw Object.assign(new Error("attachment worker returned an invalid bounded receipt"), {
      code: "PRIMARY_ATTACHMENT_MODEL_DRAIN_RECEIPT_INVALID",
    });
  }
}

async function drainWorker(options = {}) {
  const worker = options.worker;
  if (!worker || typeof worker.runOnce !== "function" || worker.jobKind !== JOB_KIND) {
    throw new Error("the canonical attachment-model worker is required");
  }
  const rounds = integer(options.rounds, "rounds", 1, 5_000);
  const limit = integer(options.limit, "limit", 1, 10);
  const sleep = options.wait || wait;
  const now = options.now || Date.now;
  const retryWaitCeilingMs = integer(
    options.retryWaitCeilingMs ?? MAX_OBSERVED_RETRY_WAIT_MS,
    "retryWaitCeilingMs",
    1,
    MAX_OBSERVED_RETRY_WAIT_MS,
  );
  const observedRetries = new Map();
  const summaries = [];
  const totals = {
    claimedCount: 0,
    succeededCount: 0,
    reviewCount: 0,
    failedCount: 0,
    reservedMicroUsd: 0,
    actualMicroUsd: 0,
  };
  let drained = false;
  let incompleteReason = "round_limit";

  for (let round = 1; round <= rounds; round += 1) {
    const receipt = await worker.runOnce({ limit });
    assertWorkerReceipt(receipt);
    for (const field of Object.keys(totals)) totals[field] += receipt[field];

    const failures = [];
    for (const job of receipt.jobs) {
      const jobId = String(job?.jobId || "");
      if (!jobId) {
        throw Object.assign(new Error("attachment worker returned a job without an identity"), {
          code: "PRIMARY_ATTACHMENT_MODEL_DRAIN_RECEIPT_INVALID",
        });
      }
      if (job.ok === false) {
        const errorCode = String(job.errorCode || "");
        const state = failureState(job);
        failures.push({ jobId, errorCode, state });
        if (!EXPECTED_REVIEW_FAILURES.has(errorCode)
            || !["retry_wait", "dead_letter", "succeeded"].includes(state)) {
          throw Object.assign(
            new Error(`unexpected primary attachment failure ${errorCode || "unknown"}`),
            { code: "PRIMARY_ATTACHMENT_MODEL_DRAIN_UNEXPECTED_FAILURE", job },
          );
        }
        if (state === "retry_wait") {
          observedRetries.set(jobId, retryAvailableAtMs(job, now()));
        } else {
          observedRetries.delete(jobId);
        }
      } else {
        observedRetries.delete(jobId);
      }
    }

    summaries.push(Object.freeze({
      round,
      claimedCount: receipt.claimedCount,
      succeededCount: receipt.succeededCount,
      reviewCount: receipt.reviewCount,
      failedCount: receipt.failedCount,
      reservedMicroUsd: receipt.reservedMicroUsd,
      actualMicroUsd: receipt.actualMicroUsd,
      observedRetryCount: observedRetries.size,
      failures,
    }));

    if (receipt.claimedCount > 0) continue;
    if (observedRetries.size === 0) {
      drained = true;
      incompleteReason = "";
      break;
    }
    const nextAvailableAt = Math.min(...observedRetries.values());
    const delayMs = Math.max(0, nextAvailableAt - now() + 100);
    if (delayMs > retryWaitCeilingMs) {
      incompleteReason = "observed_retry_backoff_exceeds_bound";
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return Object.freeze({
    ok: drained,
    version: VERSION,
    workerId: WORKER_ID,
    processorVersion: PROCESSOR_VERSION,
    workspaceKey: WORKSPACE,
    sourceSystem: SOURCE_SYSTEM,
    connectionKey: CONNECTION,
    jobKinds: Object.freeze([JOB_KIND]),
    rounds: summaries.length,
    drained,
    incompleteReason,
    pendingObservedRetryCount: observedRetries.size,
    ...totals,
    summaries: Object.freeze(summaries),
    modelSpendAuthority: "truth-model-database-ledgers",
    candidateClaimsAutoAccepted: false,
    mutatesOperationalState: false,
    productionPublicationAttempted: false,
  });
}

function buildWorker(options = {}) {
  if (process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED !== "1") {
    throw new Error("PQ_TRUTH_MODEL_RUNTIME_ENABLED=1 is required");
  }
  const syncToken = required("PQ_SUPABASE_SYNC_TOKEN");
  const reviewToken = required("PQ_TRUTH_REVIEW_TOKEN");
  const apiKey = required("OPENAI_API_KEY");
  const supabaseUrl = required("PQ_SUPABASE_URL");
  const serviceRoleKey = required("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const rpcBase = options.callRpc || callSupabaseRpc;
  const rpc = (name, body, rpcOptions = {}) => rpcBase(name, body, {
    ...rpcOptions,
    timeoutMs: Object.prototype.hasOwnProperty.call(rpcOptions, "timeoutMs")
      ? rpcOptions.timeoutMs
      : 120_000,
    retryDelaysMs: [],
  });
  const jobLedger = createSourceProcessingJobLedger({
    workspaceKey: WORKSPACE,
    sourceSystem: SOURCE_SYSTEM,
    connectionKey: CONNECTION,
    syncToken,
    callRpc: rpc,
    claimLockRetryDelaysMs: [],
  });
  const modelLedger = createTruthGmailAttachmentModelLedger({
    workspaceKey: WORKSPACE,
    syncToken,
    reviewToken,
    workerId: WORKER_ID,
    processorVersion: PROCESSOR_VERSION,
    callRpc: rpc,
  });
  return createTruthGmailAttachmentModelWorker({
    jobLedger,
    modelLedger,
    rawStore: createServerTruthRawObjectStore({
      env: process.env,
      supabaseUrl,
      serviceRoleKey,
    }),
    providerAdapter: createOpenAIGmailAttachmentModelExtractor({
      apiKey,
      fetchImpl: providerFetch,
    }),
    workerId: WORKER_ID,
    processorVersion: PROCESSOR_VERSION,
    leaseSeconds: 900,
    retryAfterSeconds: 5,
  });
}

async function main() {
  loadLocalEnv();
  if (!flag("--execute")) throw new Error("--execute is required");
  const receipt = await drainWorker({
    worker: buildWorker(),
    rounds: integer(arg("--max-rounds", "500"), "--max-rounds", 1, 5_000),
    limit: integer(arg("--limit", "5"), "--limit", 1, 10),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.ok) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    version: VERSION,
    code: error.code || "PRIMARY_ATTACHMENT_MODEL_DRAIN_FAILED",
    message: String(error.message || error).slice(0, 500),
    jobId: String(error?.job?.jobId || ""),
    candidateClaimsAutoAccepted: false,
    mutatesOperationalState: false,
    productionPublicationAttempted: false,
  }, null, 2)}\n`);
  process.exitCode = 1;
});

module.exports = Object.freeze({
  buildWorker,
  drainWorker,
  _test: Object.freeze({
    EXPECTED_REVIEW_FAILURES,
    MAX_OBSERVED_RETRY_WAIT_MS,
    PROCESSOR_VERSION,
    PROVIDER_TIMEOUT_MS,
    VERSION,
    WORKER_ID,
    assertWorkerReceipt,
    failureState,
    retryAvailableAtMs,
  }),
});

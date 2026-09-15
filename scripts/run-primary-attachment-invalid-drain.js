#!/usr/bin/env node
"use strict";

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
const CONNECTION = "primary";
const VERSION = "primary-attachment-invalid-drain-v1";
const WORKER_ID = VERSION;
const PROCESSOR_VERSION = `${VERSION}:worker-v1`;
const SCOPED_CLAIM_RPC =
  "claim_truth_gmail_attachment_invalid_first_exhaustion_jobs";
const SCOPED_STATUS_RPC =
  "read_truth_gmail_attachment_invalid_first_exhaustion_status";
const EXPECTED_FAILURE = "OPENAI_GMAIL_ATTACHMENT_MODEL_INVALID_ARGUMENT";

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

function createScopedRpc(options = {}) {
  const callRpc = options.callRpc || callSupabaseRpc;
  return (name, body, rpcOptions = {}) => callRpc(
    name === "claim_source_processing_jobs" ? SCOPED_CLAIM_RPC : name,
    body,
    {
      ...rpcOptions,
      timeoutMs: Object.prototype.hasOwnProperty.call(rpcOptions, "timeoutMs")
        ? rpcOptions.timeoutMs
        : 120_000,
      retryDelaysMs: [],
    },
  );
}

function providerFetch(url, init = {}) {
  const timeout = AbortSignal.timeout(120_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return globalThis.fetch(url, { ...init, signal });
}

async function run(options = {}) {
  if (process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED !== "1") {
    throw new Error("PQ_TRUTH_MODEL_RUNTIME_ENABLED=1 is required");
  }
  const rounds = integer(options.rounds, "--max-rounds", 1, 20);
  const limit = integer(options.limit, "--limit", 1, 5);
  const syncToken = required("PQ_SUPABASE_SYNC_TOKEN");
  const reviewToken = required("PQ_TRUTH_REVIEW_TOKEN");
  const apiKey = required("OPENAI_API_KEY");
  const supabaseUrl = required("PQ_SUPABASE_URL");
  const serviceRoleKey = required("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const rpc = createScopedRpc(options);
  const jobLedger = createSourceProcessingJobLedger({
    workspaceKey: WORKSPACE,
    sourceSystem: "gmail",
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
  const worker = createTruthGmailAttachmentModelWorker({
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
  if (worker.jobKind !== JOB_KIND || JOB_KIND !== "gmail_review_attachment_extraction") {
    throw new Error("attachment-model job-kind contract changed");
  }

  const receipts = [];
  let drained = false;
  let finalStatus = null;
  for (let round = 1; round <= rounds; round += 1) {
    const receipt = await worker.runOnce({ limit });
    receipts.push(receipt);
    if (receipt.claimedCount === 0) {
      finalStatus = await rpc(SCOPED_STATUS_RPC, {
        p_workspace_key: WORKSPACE,
        p_source_system: "gmail",
        p_connection_key: CONNECTION,
        p_worker_id: WORKER_ID,
        p_processor_version: PROCESSOR_VERSION,
        p_sync_token: syncToken,
      });
      if (!finalStatus || finalStatus.ok !== true
          || finalStatus.productionPublicationAttempted !== false
          || !Number.isSafeInteger(finalStatus.pendingCount)
          || !Number.isSafeInteger(finalStatus.unexpectedCount)) {
        throw new Error("scoped attachment drain status receipt is invalid");
      }
      drained = finalStatus.pendingCount === 0
        && finalStatus.unexpectedCount === 0;
      break;
    }
    const unexpected = receipt.jobs.filter((job) => (
      job.ok !== true && job.errorCode !== EXPECTED_FAILURE
    ));
    if (unexpected.length) {
      throw Object.assign(
        new Error("scoped attachment drain encountered an unexpected failure class"),
        { code: "PRIMARY_ATTACHMENT_INVALID_DRAIN_UNEXPECTED_FAILURE", receipt },
      );
    }
    if (receipt.failedCount > 0) await wait(5_250);
  }
  return Object.freeze({
    ok: drained,
    version: VERSION,
    workerId: WORKER_ID,
    processorVersion: PROCESSOR_VERSION,
    scope: "immutable_invalid_first_exhaustion_lineage",
    rounds: receipts.length,
    claimedCount: receipts.reduce((sum, item) => sum + item.claimedCount, 0),
    succeededCount: receipts.reduce((sum, item) => sum + item.succeededCount, 0),
    reviewCount: receipts.reduce((sum, item) => sum + item.reviewCount, 0),
    failedCount: receipts.reduce((sum, item) => sum + item.failedCount, 0),
    pendingCount: Number(finalStatus?.pendingCount ?? 0),
    unexpectedCount: Number(finalStatus?.unexpectedCount ?? 0),
    nextAvailableAt: finalStatus?.nextAvailableAt ?? null,
    finalStatus,
    receipts,
    candidateClaimsAutoAccepted: false,
    productionPublicationAttempted: false,
  });
}

async function main() {
  if (!flag("--execute")) throw new Error("--execute is required");
  const receipt = await run({
    rounds: integer(arg("--max-rounds", "10"), "--max-rounds", 1, 20),
    limit: integer(arg("--limit", "5"), "--limit", 1, 5),
  });
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.ok) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    version: VERSION,
    code: error.code || "PRIMARY_ATTACHMENT_INVALID_DRAIN_FAILED",
    message: String(error.message || error).slice(0, 500),
    receipt: error.receipt || null,
    candidateClaimsAutoAccepted: false,
    productionPublicationAttempted: false,
  }, null, 2));
  process.exitCode = 1;
});

module.exports = Object.freeze({
  _test: Object.freeze({
    ROOT,
    VERSION,
    WORKER_ID,
    PROCESSOR_VERSION,
    SCOPED_CLAIM_RPC,
    SCOPED_STATUS_RPC,
    createScopedRpc,
  }),
});

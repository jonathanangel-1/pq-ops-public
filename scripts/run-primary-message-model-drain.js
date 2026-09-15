#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { callSupabaseRpc } = require("../lib/supabase-agent");
const {
  createGmailClaimExtractor,
  ACCEPTANCE_POLICY_VERSION,
} = require("../lib/gmail-claim-extractor");
const { createSourceProcessingJobLedger } = require("../lib/source-processing-job-ledger");
const { createTruthGmailModelPlanLedger } = require("../lib/truth-gmail-model-plan-ledger");
const { createTruthGmailParentPlanningWorker } = require("../lib/truth-gmail-parent-planning-worker");
const { createTruthModelRequestLedger } = require("../lib/truth-model-request-ledger");
const { createTruthModelExtractionWorker, JOB_KIND: MESSAGE_MODEL_JOB_KIND } = require("../lib/truth-model-extraction-worker");
const { createOpenAIGmailModelExtractor } = require("../lib/openai-gmail-model-extractor");
const { createTruthCandidateLedger } = require("../lib/truth-candidate-ledger");
const { createTruthClaimWorker, JOB_KIND: MESSAGE_PARENT_JOB_KIND } = require("../lib/truth-claim-worker");
const { createTruthEvidenceLedger } = require("../lib/truth-evidence-ledger");
const { DEFAULT_PROCESSING_CONFIG } = require("../lib/truth-processing-watermark");
const { createTruthWorkerContextLedger } = require("../lib/truth-worker-context-ledger");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = "primary";
const CONNECTION = "primary";
const VERSION = "primary-message-model-drain-v1";
const PRIMARY_FORWARD_CHILD_CLAIM_RPC = "claim_truth_gmail_primary_forward_model_children";
const PRIMARY_FORWARD_REVIEW_READ_RPC = "read_truth_gmail_primary_forward_candidate_reviews";

function arg(name, fallback = "") {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
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
function batches() {
  const values = process.argv.filter((value) => value.startsWith("--batch="))
    .map((value) => value.slice(8));
  const single = arg("--batch", "");
  if (single && !values.includes(single)) values.push(single);
  for (const value of values) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error(`invalid --batch: ${value}`);
  }
  return [...new Set(values)];
}
function safePath(relative) {
  const absolute = path.resolve(ROOT, relative);
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error("artifact path must remain inside the repo");
  return absolute;
}
function createDrainRpc(options = {}) {
  const callRpc = options.callRpc || callSupabaseRpc;
  return function drainRpc(name, body, rpcOptions = {}) {
    return callRpc(name, body, {
      ...rpcOptions,
      timeoutMs: Object.prototype.hasOwnProperty.call(rpcOptions, "timeoutMs")
        ? rpcOptions.timeoutMs
        : 300_000,
      // A transport timeout is outcome-unknown: PostgreSQL may still be
      // executing after PostgREST returns. Never fan out a mutating RPC.
      retryDelaysMs: [],
    });
  };
}
function createClaimsRpc(rootBatchId, options = {}) {
  const callRpc = createDrainRpc(options);
  return function claimsRpc(name, body, rpcOptions = {}) {
    if (name !== "claim_source_processing_jobs") {
      return callRpc(name, body, rpcOptions);
    }
    return callRpc(PRIMARY_FORWARD_CHILD_CLAIM_RPC, {
      ...body,
      p_root_batch_id: rootBatchId,
    }, rpcOptions);
  };
}
function createReviewReadRpc(options = {}) {
  const callRpc = createDrainRpc(options);
  return function reviewReadRpc(name, body, rpcOptions = {}) {
    return callRpc(
      name === "read_truth_shadow_model_commissioning_reviews"
        ? PRIMARY_FORWARD_REVIEW_READ_RPC
        : name,
      body,
      rpcOptions,
    );
  };
}
const rpc = createDrainRpc();
function assertSafe(receipt, label) {
  if (!receipt || receipt.ok !== true || receipt.productionPublicationAttempted !== false) {
    throw new Error(`${label} returned an invalid authority receipt`);
  }
  return receipt;
}

async function discoverBatches(limit) {
  const url = required("PQ_SUPABASE_URL").replace(/\/$/, "");
  const key = required("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const query = new URLSearchParams({
    select: "source_processing_job_lineage!inner(root_batch_id)",
    workspace_key: "eq.primary",
    source_system: "eq.gmail",
    connection_key: "eq.primary",
    job_kind: "in.(gmail_extract_message_model_claims,gmail_review_model_extraction)",
    state: "in.(waiting_runtime,queued,retry_wait)",
    order: "created_at.asc",
    limit: String(limit),
  });
  const response = await fetch(`${url}/rest/v1/source_processing_jobs?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`batch discovery failed (${response.status})`);
  const rows = await response.json();
  return [...new Set(rows.flatMap((row) => row.source_processing_job_lineage || [])
    .map((lineage) => lineage.root_batch_id).filter(Boolean))];
}

async function prepare(rootBatches, limit, reviewToken, syncToken) {
  const receipts = [];
  for (const batch of rootBatches) {
    const receipt = assertSafe(await rpc("prepare_truth_shadow_gmail_model_commissioning", {
      p_workspace_key: WORKSPACE, p_connection_key: CONNECTION, p_root_batch_id: batch,
      p_limit: limit, p_review_token: reviewToken, p_sync_token: syncToken,
    }), `prepare ${batch}`);
    if (receipt.shadowOnly !== false) throw new Error(`prepare ${batch} falsely claimed shadowOnly`);
    receipts.push(receipt);
  }
  return receipts;
}

async function authorizeSchemaRetryParents(rootBatches, limit, reviewToken, syncToken) {
  if (!rootBatches.length) throw new Error("--batch is required for the schema-retry-authorize phase");
  const receipts = [];
  for (const batch of rootBatches) {
    receipts.push(assertSafe(await rpc("authorize_truth_gmail_model_schema_retry_parents", {
      p_workspace_key: WORKSPACE,
      p_connection_key: CONNECTION,
      p_root_batch_id: batch,
      p_limit: limit,
      p_review_token: reviewToken,
      p_sync_token: syncToken,
    }), `schema retry parent authorization ${batch}`));
  }
  return receipts;
}

async function readReviews(batch, limit, reviewToken, syncToken) {
  const callRpc = createReviewReadRpc();
  return assertSafe(await callRpc("read_truth_shadow_model_commissioning_reviews", {
    p_workspace_key: WORKSPACE, p_connection_key: CONNECTION, p_root_batch_id: batch,
    p_limit: limit, p_review_token: reviewToken, p_sync_token: syncToken,
  }), `review read ${batch}`);
}

async function exportReviews(rootBatches, limit, reviewToken, syncToken, output) {
  const pages = [];
  for (const batch of rootBatches) pages.push({ batch, receipt: await readReviews(batch, limit, reviewToken, syncToken) });
  const artifact = {
    schemaVersion: "truth-primary-message-model-commissioning-decisions-v1",
    workspaceKey: WORKSPACE, connectionKey: CONNECTION,
    instructions: "Read every cited source. Set each decision to accept or reject with a specific reason. This reviews commissioning plans only; it does not accept candidate claims.",
    batches: pages.map(({ batch, receipt }) => ({ rootBatchId: batch, decisions: receipt.items.map((item) => ({
      targetId: item.targetId, targetItemHash: item.targetItemHash,
      expectedPreviousDecisionVersionId: item.previousDecisionVersionId || "",
      decision: "", reason: "", sourceObservationId: item.sourceObservationId, candidate: item.candidate,
    })) })),
    productionPublicationAttempted: false,
  };
  if (output) fs.writeFileSync(safePath(output), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  return output ? { ok: true, output: safePath(output), pageCount: pages.length, productionPublicationAttempted: false } : artifact;
}

async function applyReviews(file, reviewToken, syncToken) {
  const artifact = JSON.parse(fs.readFileSync(safePath(file), "utf8"));
  if (artifact.schemaVersion !== "truth-primary-message-model-commissioning-decisions-v1"
      || artifact.workspaceKey !== WORKSPACE || artifact.connectionKey !== CONNECTION
      || !Array.isArray(artifact.batches)) throw new Error("decision artifact has the wrong scope");
  const ledger = createTruthCandidateLedger({ workspaceKey: WORKSPACE, syncToken, reviewToken, callRpc: rpc });
  const receipts = [];
  for (const batch of artifact.batches) for (const decision of batch.decisions || []) {
    if (!["accept", "reject"].includes(decision.decision) || !String(decision.reason || "").trim()) {
      throw new Error(`incomplete operator decision for ${decision.targetId || "unknown target"}`);
    }
    const key = crypto.createHash("sha256").update(JSON.stringify({ batch: batch.rootBatchId, ...decision })).digest("hex");
    receipts.push(await ledger.resolveReview({
      targetId: decision.targetId, expectedTargetHash: decision.targetItemHash,
      expectedPreviousDecisionVersionId: decision.expectedPreviousDecisionVersionId || "",
      decision: decision.decision, policyVersion: "truth-shadow-model-commissioning-review-v1",
      decidedBy: "operator:truth-primary-message-model-commissioning", reason: decision.reason.trim(),
      idempotencyKey: `truth_primary_message_model_review_${key}`,
    }));
  }
  return { ok: true, appliedCount: receipts.length, receipts, productionPublicationAttempted: false };
}

async function runParents(rootBatches, rounds, limit, syncToken) {
  if (process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED !== "1") {
    throw new Error("PQ_TRUTH_MODEL_RUNTIME_ENABLED=1 is required");
  }
  if (!rootBatches.length) throw new Error("--batch is required for the parents phase");
  const parentRunToken = required("PQ_PRIMARY_PARENT_RUN_TOKEN");
  const receipts = [];
  for (const batch of rootBatches) {
    const callRpc = rpc;
    const jobLedger = createSourceProcessingJobLedger({
      workspaceKey: WORKSPACE,
      sourceSystem: "gmail",
      connectionKey: CONNECTION,
      syncToken,
      callRpc,
    });
    const identity = {
      workerId: `primary-message-model-drain:parents:${batch}`,
      processorVersion: `${VERSION}:parents-v13-36b25f2b`,
    };
    const context = createTruthWorkerContextLedger({
      workspaceKey: WORKSPACE,
      syncToken,
      ...identity,
      modelRuntimeEnabled: true,
      internalDomains: DEFAULT_PROCESSING_CONFIG.internalDomains,
      callRpc,
    });
    const candidateLedger = createTruthCandidateLedger({
      workspaceKey: WORKSPACE,
      syncToken,
      callRpc,
    });
    const evidenceLedger = createTruthEvidenceLedger({
      workspaceKey: WORKSPACE,
      syncToken,
      callRpc,
    });
    const extractor = createGmailClaimExtractor({
      dateOrder: "MDY",
      requireModelForAmbiguity: true,
      maxModelConfidence: 0.9,
    });
    const completionWorker = createTruthClaimWorker({
      jobLedger,
      candidateLedger,
      evidenceLedger,
      extractor,
      loadObservation: context.loadObservation,
      loadWorkgroupContext: context.loadWorkgroupContext,
      loadAcceptedClaims: context.loadAcceptedClaims,
      ...identity,
      policyVersion: ACCEPTANCE_POLICY_VERSION,
      policyVersions: { [MESSAGE_PARENT_JOB_KIND]: ACCEPTANCE_POLICY_VERSION },
      leaseSeconds: 900,
    });
    const parentPlanRpc = (name, body, options) => {
      const isPlanSeal = name === "seal_gmail_model_extraction_plan";
      return callRpc(
        isPlanSeal
          ? "seal_gmail_primary_commissioned_model_extraction_plan_v10"
          : name,
        isPlanSeal ? { ...body, p_run_token: parentRunToken } : body,
        options,
      );
    };
    const planLedger = createTruthGmailModelPlanLedger({
      workspaceKey: WORKSPACE,
      syncToken,
      callRpc: parentPlanRpc,
    });
    const worker = createTruthGmailParentPlanningWorker({
      jobLedger,
      planLedger,
      completionWorker,
      ...identity,
      modelRuntimeEnabled: true,
      leaseSeconds: 900,
      retryAfterSeconds: 5,
    });
    if (worker.jobKind !== MESSAGE_PARENT_JOB_KIND
        || MESSAGE_PARENT_JOB_KIND !== "gmail_extract_message_claims") {
      throw new Error("message parent worker job-kind contract changed");
    }
    const batchReceipts = [];
    for (let round = 1; round <= rounds; round += 1) {
      const receipt = await worker.runOnce({ limit });
      batchReceipts.push(receipt);
      if (!receipt.ok) {
        throw Object.assign(new Error("message parent worker reported a failed job"), { receipt });
      }
      if (receipt.claimedCount === 0) break;
    }
    receipts.push({ rootBatchId: batch, workerId: identity.workerId, receipts: batchReceipts });
  }
  return {
    ok: true,
    batches: receipts,
    modelCallsPerformed: false,
    candidateClaimsAutoAccepted: false,
    productionPublicationAttempted: false,
  };
}

async function runClaims(rootBatches, rounds, limit, syncToken) {
  if (process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED !== "1") throw new Error("PQ_TRUTH_MODEL_RUNTIME_ENABLED=1 is required");
  if (!rootBatches.length) throw new Error("--batch is required for the claims phase");
  const apiKey = required("OPENAI_API_KEY");
  const batches = [];
  for (const batch of rootBatches) {
    const callRpc = createClaimsRpc(batch);
    const jobLedger = createSourceProcessingJobLedger({ workspaceKey: WORKSPACE, sourceSystem: "gmail", connectionKey: CONNECTION, syncToken, callRpc });
    const planLedger = createTruthGmailModelPlanLedger({ workspaceKey: WORKSPACE, syncToken, callRpc });
    const identity = {
      workerId: `primary-message-model-drain:claims:${batch}`,
      processorVersion: `${VERSION}:claims-v2`,
    };
    const requestLedger = createTruthModelRequestLedger({ workspaceKey: WORKSPACE, syncToken, ...identity, callRpc });
    const worker = createTruthModelExtractionWorker({
      jobLedger, planLedger, modelRequestLedger: requestLedger,
      // Hard provider timeout: a hung OpenAI call must never hold a job lease
      // open-ended (audit 2026-07-22).
      providerAdapter: createOpenAIGmailModelExtractor({
        apiKey,
        fetchImpl: (url, init = {}) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(120_000) }),
      }),
      runtimeEnabled: true, ...identity, leaseSeconds: 900, retryAfterSeconds: 5,
    });
    if (worker.jobKind !== MESSAGE_MODEL_JOB_KIND || MESSAGE_MODEL_JOB_KIND !== "gmail_extract_message_model_claims") {
      throw new Error("message-model worker job-kind contract changed");
    }
    const receipts = [];
    for (let round = 1; round <= rounds; round += 1) {
      const receipt = await worker.runOnce({ limit }); receipts.push(receipt);
      if (receipt.claimedCount === 0) break;
      if (!receipt.ok) throw Object.assign(new Error("message-model worker reported a failed job"), { receipt });
    }
    batches.push({ rootBatchId: batch, workerId: identity.workerId, receipts });
  }
  return { ok: true, batches, candidateClaimsAutoAccepted: false, productionPublicationAttempted: false };
}

async function main() {
  if (!flag("--execute")) throw new Error("--execute is required");
  const phase = arg("--phase");
  if (!["prepare", "schema-retry-authorize", "parents", "review-export", "review-apply", "claims"].includes(phase)) throw new Error("unsupported --phase");
  const limit = integer(arg("--limit", "10"), "--limit", 1, 50);
  const rounds = integer(arg("--max-rounds", "1"), "--max-rounds", 1, 500);
  const syncToken = required("PQ_SUPABASE_SYNC_TOKEN");
  const reviewToken = ["parents", "claims"].includes(phase) ? "" : required("PQ_TRUTH_REVIEW_TOKEN");
  let rootBatches = batches();
  if (!rootBatches.length && !["schema-retry-authorize", "parents", "review-apply", "claims"].includes(phase)) rootBatches = await discoverBatches(Math.min(500, limit * rounds));
  let receipt;
  if (phase === "prepare") receipt = await prepare(rootBatches, limit, reviewToken, syncToken);
  if (phase === "schema-retry-authorize") receipt = await authorizeSchemaRetryParents(rootBatches, limit, reviewToken, syncToken);
  if (phase === "parents") receipt = await runParents(rootBatches, rounds, limit, syncToken);
  if (phase === "review-export") receipt = await exportReviews(rootBatches, limit, reviewToken, syncToken, arg("--output"));
  if (phase === "review-apply") receipt = await applyReviews(arg("--decision-file"), reviewToken, syncToken);
  if (phase === "claims") receipt = await runClaims(rootBatches, rounds, Math.min(limit, 2), syncToken);
  console.log(JSON.stringify({ ok: true, version: VERSION, phase, connectionKey: CONNECTION, rootBatches, receipt, productionPublicationAttempted: false }, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, version: VERSION, code: error.code || "PRIMARY_MESSAGE_MODEL_DRAIN_FAILED", message: String(error.message || error).slice(0, 500), receipt: error.receipt || null, productionPublicationAttempted: false }, null, 2));
  process.exitCode = 1;
});

module.exports = Object.freeze({
  _test: {
    batches,
    assertSafe,
    safePath,
    createDrainRpc,
    createClaimsRpc,
    PRIMARY_FORWARD_CHILD_CLAIM_RPC,
    createReviewReadRpc,
    PRIMARY_FORWARD_REVIEW_READ_RPC,
  },
});

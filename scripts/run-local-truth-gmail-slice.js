#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { callSupabaseRpc } = require("../lib/supabase-agent");
const { createGmailApiClient } = require("../lib/gmail-api-client");
const { createGmailAttachmentWorker, CLAIM_JOB_KIND: ATTACHMENT_CLAIM_JOB_KIND } = require("../lib/gmail-attachment-worker");
const {
  createGmailClaimExtractor,
  ACCEPTANCE_POLICY_VERSION,
  PROMPT_VERSION: GMAIL_PROMPT_VERSION,
} = require("../lib/gmail-claim-extractor");
const { createGmailEvidenceWorker } = require("../lib/gmail-evidence-worker");
const { createGmailMailboxLedger } = require("../lib/gmail-mailbox-ledger");
const { runGmailScopedShadowBackfill } = require("../lib/gmail-scoped-shadow-backfill");
const { createSourceProcessingJobLedger } = require("../lib/source-processing-job-ledger");
const {
  createOpenAIGmailModelExtractor,
  PINNED_MODEL: GMAIL_MODEL_SNAPSHOT,
} = require("../lib/openai-gmail-model-extractor");
const {
  createOpenAIGmailAttachmentModelExtractor,
} = require("../lib/openai-gmail-attachment-model-extractor");
const { createTruthCandidateLedger } = require("../lib/truth-candidate-ledger");
const { createTruthBuildLedger, RPC: BUILD_RPC } = require("../lib/truth-build-ledger");
const { createTruthClaimWorker, JOB_KIND: GMAIL_CLAIM_JOB_KIND } = require("../lib/truth-claim-worker");
const { createTruthEvidenceLedger } = require("../lib/truth-evidence-ledger");
const { createTruthGmailModelPlanLedger } = require("../lib/truth-gmail-model-plan-ledger");
const { createTruthGmailParentPlanningWorker } = require("../lib/truth-gmail-parent-planning-worker");
const {
  createTruthGmailAttachmentModelLedger,
} = require("../lib/truth-gmail-attachment-model-ledger");
const {
  createTruthGmailAttachmentModelWorker,
} = require("../lib/truth-gmail-attachment-model-worker");
const { createTruthLinkLedger } = require("../lib/truth-link-ledger");
const { createTruthLinkWorker } = require("../lib/truth-link-worker");
const { createTruthModelExtractionWorker } = require("../lib/truth-model-extraction-worker");
const { createTruthModelRequestLedger } = require("../lib/truth-model-request-ledger");
const { DEFAULT_PROCESSING_CONFIG } = require("../lib/truth-processing-watermark");
const { runRelationalTruthBuild } = require("../lib/relational-truth-build-runner");
const { createServerTruthRawObjectStore } = require("../lib/truth-raw-object-store-factory");
const { createTruthWorkerContextLedger } = require("../lib/truth-worker-context-ledger");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(ROOT, "data/manual-gmail-truth/current-awbs.json");
const CONNECTION_KEY = "shadow-current-awbs-20260710-c475a8ca";
const ROOT_BATCH_ID = "cd12fa59-d02b-462b-a9c8-ed11f93e41f4";
const RUNTIME_VERSION = "local-truth-gmail-exact-message-slice-v1";
const WORKSPACE_KEY = "primary";
const CLAIM_RPC = "claim_source_processing_jobs";
const DEFAULT_RPC_TIMEOUT_MS = 20_000;
const MAX_RPC_TIMEOUT_MS = 30_000;
const MIN_CLAIM_RPC_TIMEOUT_MS = 65_000;
const DEFAULT_CLAIM_RPC_TIMEOUT_MS = 70_000;
const MAX_CLAIM_RPC_TIMEOUT_MS = 75_000;
const CLAIM_WORK_RPC_TIMEOUT_MS = 120_000;
const CLAIM_WORK_RPCS = new Set([
  "load_gmail_parent_planning_context",
  "resume_truth_shadow_gmail_sealed_model_parent",
  "seal_gmail_model_extraction_plan",
  "reconcile_stale_shadow_gmail_extraction_plan",
  "create_truth_shadow_stale_gmail_model_review",
  "load_truth_worker_observation",
  "load_truth_claim_worker_context",
  "get_candidate_claim_job_state",
  "append_and_seal_candidate_claim_job",
  "renew_source_processing_job_lease",
  "complete_source_processing_job",
  "fail_source_processing_job",
]);
const ACCEPTANCE_RPC = "run_truth_shadow_claim_acceptance_epoch";
const LATE_MODEL_ACCEPTANCE_RPC = "run_truth_shadow_late_model_acceptance";
const SHADOW_SOURCE_CUT_RPC = "seal_truth_shadow_root_source_cut";
const MODEL_PREPARE_RPC = "prepare_truth_shadow_gmail_model_commissioning";
const MODEL_REVIEW_QUEUE_RPC = "read_truth_shadow_model_commissioning_reviews";
const LINK_SAMPLE_OPEN_RPC = "open_truth_shadow_link_sample_acceptance";
const LINK_SAMPLE_READ_RPC = "read_truth_shadow_link_sample_acceptance";
const LINK_SAMPLE_RESOLVE_RPC = "resolve_truth_shadow_link_sample_review";
const LINK_SAMPLE_AUTHORIZE_RPC = "authorize_truth_shadow_link_sample_acceptance";
const LINK_SAMPLE_RUN_RPC = "run_truth_shadow_link_sample_acceptance";
const LONG_RPC_TIMEOUT_MS = 300_000;

function argument(name, fallback = "") {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function integer(value, field, fallback, minimum, maximum) {
  const candidate = value === "" || value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function rpcTimeoutMs(rpc, requestedTimeoutMs) {
  const isClaim = rpc === CLAIM_RPC;
  const isClaimWork = CLAIM_WORK_RPCS.has(rpc);
  const isLong = new Set([
    ACCEPTANCE_RPC,
    LATE_MODEL_ACCEPTANCE_RPC,
    SHADOW_SOURCE_CUT_RPC,
    MODEL_PREPARE_RPC,
    MODEL_REVIEW_QUEUE_RPC,
    LINK_SAMPLE_OPEN_RPC,
    LINK_SAMPLE_READ_RPC,
    LINK_SAMPLE_RESOLVE_RPC,
    LINK_SAMPLE_AUTHORIZE_RPC,
    LINK_SAMPLE_RUN_RPC,
    BUILD_RPC.claimPair,
    BUILD_RPC.renewLease,
    BUILD_RPC.readBundle,
    BUILD_RPC.completePair,
    BUILD_RPC.failPair,
  ]).has(rpc);
  const fallback = isClaim ? DEFAULT_CLAIM_RPC_TIMEOUT_MS
    : isClaimWork ? CLAIM_WORK_RPC_TIMEOUT_MS
      : isLong ? LONG_RPC_TIMEOUT_MS
      : DEFAULT_RPC_TIMEOUT_MS;
  const maximum = isClaim ? MAX_CLAIM_RPC_TIMEOUT_MS
    : isClaimWork ? CLAIM_WORK_RPC_TIMEOUT_MS
      : isLong ? LONG_RPC_TIMEOUT_MS
      : MAX_RPC_TIMEOUT_MS;
  const minimum = isClaim ? MIN_CLAIM_RPC_TIMEOUT_MS : 1;
  const candidate = requestedTimeoutMs === undefined ? fallback : Number(requestedTimeoutMs);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error("slice RPC timeout must be a positive finite number");
  }
  return Math.min(maximum, Math.max(minimum, Math.round(candidate)));
}

function loadLocalEnv({ modelOn = false } = {}) {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(ROOT, fileName);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || process.env[match[1]] || (match[1] === "OPENAI_API_KEY" && !modelOn)) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  if (!modelOn) delete process.env.OPENAI_API_KEY;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required local runtime environment ${name}`);
  return value;
}

function fixedJobKindsLedger(jobLedger, jobKinds) {
  const allowed = Object.freeze([...new Set(jobKinds)].sort());
  return Object.freeze({
    scope: jobLedger.scope,
    claimJobs(input = {}) {
      return jobLedger.claimJobs({ ...input, jobKinds: allowed });
    },
    renewJob: jobLedger.renewJob.bind(jobLedger),
    completeJob: jobLedger.completeJob.bind(jobLedger),
    failJob: jobLedger.failJob.bind(jobLedger),
  });
}

function attachmentClaimDrainLimits(limits) {
  return { ...limits, limit: 1, deferFailure: true };
}

async function drain(name, runOnce, { limit, maxRounds, deferFailure = false }) {
  const rounds = [];
  const pendingRetryJobIds = new Set();
  const retryAvailableAtMs = new Map();
  let unresolvedRetrySignal = false;
  for (let round = 1; round <= maxRounds; round += 1) {
    const receipt = await runOnce({ limit });
    const summary = {
      round,
      workerOk: receipt?.ok !== false,
      claimedCount: Number(receipt?.claimedCount || 0),
      succeededCount: Number(receipt?.succeededCount || 0),
      failedCount: Number(receipt?.failedCount || 0),
      requeuedCount: Number(receipt?.requeuedCount || receipt?.retryScheduledCount || 0),
      acceptedCount: Number(receipt?.acceptedCount || 0),
      reviewCount: Number(receipt?.reviewCount || 0),
      pendingCount: Number(receipt?.pendingCount || 0),
      failures: (Array.isArray(receipt?.jobs) ? receipt.jobs : [])
        .filter((job) => job?.ok === false)
        .slice(0, 20)
        .map((job) => ({
          jobId: typeof job?.jobId === "string" ? job.jobId : "",
          errorCode: typeof job?.errorCode === "string" ? job.errorCode : "",
          failureState: typeof job?.failureReceipt?.state === "string"
            ? job.failureReceipt.state
            : "",
          failureAcknowledgementCode:
            typeof job?.failureAcknowledgementError?.code === "string"
              ? job.failureAcknowledgementError.code
              : "",
        })),
    };
    let identifiedRetryCount = 0;
    for (const job of Array.isArray(receipt?.jobs) ? receipt.jobs : []) {
      const jobId = typeof job?.jobId === "string" ? job.jobId : "";
      if (!jobId) continue;
      const retrying = job.retryScheduled === true
        || job.planningStatus === "requeued_current_plan";
      if (retrying) {
        pendingRetryJobIds.add(jobId);
        const availableAtMs = Date.parse(String(job?.failureReceipt?.availableAt || ""));
        retryAvailableAtMs.set(
          jobId,
          Number.isFinite(availableAtMs) ? availableAtMs : Date.now(),
        );
        identifiedRetryCount += 1;
      } else {
        pendingRetryJobIds.delete(jobId);
        retryAvailableAtMs.delete(jobId);
      }
    }
    summary.hardFailedCount = Math.max(0, summary.failedCount - identifiedRetryCount);
    summary.ok = summary.hardFailedCount === 0
      && (summary.workerOk || identifiedRetryCount > 0);
    if (summary.requeuedCount > identifiedRetryCount) unresolvedRetrySignal = true;
    rounds.push(summary);
    if (summary.claimedCount === 0) {
      if (pendingRetryJobIds.size > 0 && round < maxRounds) {
        const nextAvailableAtMs = Math.min(
          ...[...pendingRetryJobIds].map((jobId) => retryAvailableAtMs.get(jobId) || Date.now()),
        );
        const delayMs = Math.max(0, nextAvailableAtMs - Date.now() + 100);
        if (delayMs <= 60_000) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      }
      break;
    }
  }
  const failedCount = rounds.reduce((sum, item) => sum + item.failedCount, 0);
  const requeuedCount = rounds.reduce((sum, item) => sum + item.requeuedCount, 0);
  const hardFailedCount = rounds.reduce((sum, item) => sum + item.hardFailedCount, 0);
  const ok = hardFailedCount === 0 && rounds.every((item) => item.ok);
  const queueObservedEmpty = rounds.at(-1)?.claimedCount === 0;
  const result = {
    ok,
    name,
    rounds,
    claimedCount: rounds.reduce((sum, item) => sum + item.claimedCount, 0),
    succeededCount: rounds.reduce((sum, item) => sum + item.succeededCount, 0),
    failedCount,
    hardFailedCount,
    requeuedCount,
    acceptedCount: rounds.reduce((sum, item) => sum + item.acceptedCount, 0),
    reviewCount: rounds.reduce((sum, item) => sum + item.reviewCount, 0),
    pendingCount: rounds.reduce((sum, item) => sum + item.pendingCount, 0),
    retryPendingJobIds: [...pendingRetryJobIds].sort(),
    unresolvedRetrySignal,
    maxRoundsExhausted: !queueObservedEmpty,
    drained: ok && queueObservedEmpty && pendingRetryJobIds.size === 0
      && unresolvedRetrySignal === false,
  };
  if (!ok && !deferFailure) {
    const error = new Error(`${name} worker reported one or more failed deterministic jobs`);
    error.code = "LOCAL_TRUTH_GMAIL_WORKER_FAILED";
    error.receipt = result;
    throw error;
  }
  if (!result.drained && !deferFailure) {
    const error = new Error(`${name} worker did not reach a terminal scoped frontier`);
    error.code = "LOCAL_TRUTH_GMAIL_DRAIN_INCOMPLETE";
    error.receipt = result;
    throw error;
  }
  return result;
}

function runtime({ modelOn = false, reviewRequired = modelOn } = {}) {
  const expectedModelFlag = modelOn ? "1" : "0";
  if (String(process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED || "") !== expectedModelFlag) {
    throw new Error(`PQ_TRUTH_MODEL_RUNTIME_ENABLED must be explicitly set to ${expectedModelFlag}`);
  }
  if (!modelOn && process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY must not enter the deterministic local slice process");
  }
  const syncToken = requiredEnv("PQ_SUPABASE_SYNC_TOKEN");
  const reviewToken = reviewRequired ? requiredEnv("PQ_TRUTH_REVIEW_TOKEN") : "";
  const openAiApiKey = modelOn ? requiredEnv("OPENAI_API_KEY") : "";
  const supabaseUrl = requiredEnv("PQ_SUPABASE_URL");
  const serviceRoleKey = requiredEnv("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const callRpc = (rpc, body, options = {}) => callSupabaseRpc(rpc, body, {
    ...options,
    // The hosted claim authority has an operator-approved 60-second statement
    // budget. Its HTTP receipt must remain outside that boundary; all other
    // slice RPCs retain their tighter diagnostic envelope.
    timeoutMs: rpcTimeoutMs(rpc, options.timeoutMs),
    retryDelaysMs: [],
  });
  const gmailClient = createGmailApiClient({
    env: process.env,
    connectionKey: CONNECTION_KEY,
    maxRetries: 3,
    timeoutMs: 20_000,
  });
  const mailboxLedger = createGmailMailboxLedger({
    workspaceKey: WORKSPACE_KEY,
    connectionKey: CONNECTION_KEY,
    syncToken,
    callRpc,
  });
  const jobLedger = createSourceProcessingJobLedger({
    workspaceKey: WORKSPACE_KEY,
    sourceSystem: "gmail",
    connectionKey: CONNECTION_KEY,
    syncToken,
    callRpc,
  });
  const rawStore = createServerTruthRawObjectStore({
    env: process.env,
    supabaseUrl,
    serviceRoleKey,
  });
  return {
    syncToken,
    reviewToken,
    openAiApiKey,
    modelOn,
    callRpc,
    gmailClient,
    mailboxLedger,
    jobLedger,
    rawStore,
  };
}

async function discover(ctx) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  return runGmailScopedShadowBackfill({
    fixture,
    gmailClient: ctx.gmailClient,
    ledger: ctx.mailboxLedger,
    connectionKey: CONNECTION_KEY,
    ownerId: "local-truth-gmail-slice:discovery",
    expectedShipmentCount: 30,
    metadataConcurrency: 8,
    modelRuntimeEnabled: ctx.modelOn,
  });
}

async function evidence(ctx, limits) {
  const worker = createGmailEvidenceWorker({
    gmailClient: ctx.gmailClient,
    rawStore: ctx.rawStore,
    jobLedger: ctx.jobLedger,
  });
  return drain("gmail-evidence", (input) => worker.run({
    ...input,
    workerId: "local-truth-gmail-slice:evidence",
    processorVersion: `${RUNTIME_VERSION}:evidence-v1`,
    leaseSeconds: 900,
  }), limits);
}

async function attachments(ctx, limits) {
  const worker = createGmailAttachmentWorker({ rawStore: ctx.rawStore, jobLedger: ctx.jobLedger });
  return drain("gmail-attachments", (input) => worker.run({
    ...input,
    workerId: "local-truth-gmail-slice:attachments",
    processorVersion: `${RUNTIME_VERSION}:attachments-v1`,
    leaseSeconds: 900,
  }), limits);
}

async function links(ctx, limits) {
  const workerId = "local-truth-gmail-slice:links";
  const processorVersion = `${RUNTIME_VERSION}:links-v1`;
  const evidenceLedger = createTruthEvidenceLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    callRpc: ctx.callRpc,
  });
  const linkLedger = createTruthLinkLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    callRpc: ctx.callRpc,
  });
  const context = createTruthWorkerContextLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    workerId,
    processorVersion,
    internalDomains: DEFAULT_PROCESSING_CONFIG.internalDomains,
    callRpc: ctx.callRpc,
  });
  const worker = createTruthLinkWorker({
    jobLedger: ctx.jobLedger,
    linkLedger,
    evidenceLedger,
    loadContext: context.loadLinkContext,
    workerId,
    processorVersion,
    policyVersion: "truth-link-policy-v1",
    leaseSeconds: 900,
  });
  return drain("gmail-links", (input) => worker.runOnce(input), limits);
}

function assertEpochReceipt(receipt, operation) {
  if (!receipt || receipt.ok !== true
    || !/^gmail-link-epoch:v1:[0-9a-f]{64}$/.test(String(receipt.epochId || ""))
    || !/^[0-9a-f]{64}$/.test(String(receipt.epochHash || ""))
    || receipt.mutatesOperationalState !== false
    || receipt.publishesTruth !== false
    || receipt.performsActions !== false) {
    throw new Error(`${operation} returned an invalid or unsafe link-epoch receipt`);
  }
  return receipt;
}

async function openLinkEpoch(ctx) {
  const receipt = await ctx.callRpc("open_truth_gmail_link_epoch", {
    p_workspace_key: WORKSPACE_KEY,
    p_root_batch_id: ROOT_BATCH_ID,
    p_sync_token: ctx.syncToken,
  });
  return assertEpochReceipt(receipt, "open link epoch");
}

async function sealLinkEpoch(ctx) {
  const opened = await openLinkEpoch(ctx);
  const receipt = await ctx.callRpc("seal_truth_gmail_link_epoch", {
    p_workspace_key: WORKSPACE_KEY,
    p_epoch_id: opened.epochId,
    p_sync_token: ctx.syncToken,
  });
  return assertEpochReceipt(receipt, "seal link epoch");
}

async function claims(ctx, limits) {
  const evidenceLedger = createTruthEvidenceLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    callRpc: ctx.callRpc,
  });
  const candidateLedger = createTruthCandidateLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    callRpc: ctx.callRpc,
  });
  const extractor = createGmailClaimExtractor({
    dateOrder: "MDY",
    requireModelForAmbiguity: true,
    maxModelConfidence: 0.9,
  });
  const parentIdentity = {
    workerId: "local-truth-gmail-slice:parent-claims",
    processorVersion: `${RUNTIME_VERSION}:parent-claims-v1`,
  };
  const parentContext = createTruthWorkerContextLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    ...parentIdentity,
    modelRuntimeEnabled: ctx.modelOn,
    internalDomains: DEFAULT_PROCESSING_CONFIG.internalDomains,
    callRpc: ctx.callRpc,
  });
  const completion = createTruthClaimWorker({
    jobLedger: ctx.jobLedger,
    candidateLedger,
    evidenceLedger,
    extractor,
    loadObservation: parentContext.loadObservation,
    loadWorkgroupContext: parentContext.loadWorkgroupContext,
    loadAcceptedClaims: parentContext.loadAcceptedClaims,
    ...parentIdentity,
    policyVersion: ACCEPTANCE_POLICY_VERSION,
    policyVersions: { [GMAIL_CLAIM_JOB_KIND]: ACCEPTANCE_POLICY_VERSION },
    leaseSeconds: 900,
  });
  const planLedger = createTruthGmailModelPlanLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    callRpc: ctx.callRpc,
  });
  const parent = createTruthGmailParentPlanningWorker({
    jobLedger: ctx.jobLedger,
    planLedger,
    completionWorker: completion,
    ...parentIdentity,
    modelRuntimeEnabled: ctx.modelOn,
    leaseSeconds: 900,
  });
  const parentReceipt = await drain(
    "gmail-parent-plans",
    (input) => parent.runOnce(input),
    { ...limits, deferFailure: true },
  );

  let messageModelReceipt = null;
  let attachmentModelReceipt = null;
  if (ctx.modelOn) {
    const messageModelIdentity = {
      workerId: "local-truth-gmail-slice:message-model-claims",
      processorVersion: `${RUNTIME_VERSION}:message-model-claims-v1`,
    };
    const messageProvider = createOpenAIGmailModelExtractor({
      apiKey: ctx.openAiApiKey,
      fetchImpl: globalThis.fetch,
    });
    const messageRequestLedger = createTruthModelRequestLedger({
      workspaceKey: WORKSPACE_KEY,
      syncToken: ctx.syncToken,
      ...messageModelIdentity,
      callRpc: ctx.callRpc,
    });
    const messageModelWorker = createTruthModelExtractionWorker({
      jobLedger: ctx.jobLedger,
      planLedger,
      modelRequestLedger: messageRequestLedger,
      providerAdapter: messageProvider,
      runtimeEnabled: true,
      ...messageModelIdentity,
      leaseSeconds: 900,
      retryAfterSeconds: 5,
    });
    messageModelReceipt = await drain(
      "gmail-message-model-claims",
      (input) => messageModelWorker.runOnce(input),
      { ...limits, limit: Math.min(limits.limit, 2), deferFailure: true },
    );

    const attachmentModelIdentity = {
      workerId: "local-truth-gmail-slice:attachment-model-extraction",
      processorVersion: `${RUNTIME_VERSION}:attachment-model-extraction-v1`,
    };
    const attachmentProvider = createOpenAIGmailAttachmentModelExtractor({
      apiKey: ctx.openAiApiKey,
      fetchImpl: globalThis.fetch,
    });
    const attachmentModelLedger = createTruthGmailAttachmentModelLedger({
      workspaceKey: WORKSPACE_KEY,
      syncToken: ctx.syncToken,
      reviewToken: ctx.reviewToken,
      ...attachmentModelIdentity,
      callRpc: ctx.callRpc,
    });
    const attachmentModelWorker = createTruthGmailAttachmentModelWorker({
      jobLedger: fixedJobKindsLedger(ctx.jobLedger, ["gmail_review_attachment_extraction"]),
      modelLedger: attachmentModelLedger,
      rawStore: ctx.rawStore,
      providerAdapter: attachmentProvider,
      ...attachmentModelIdentity,
      leaseSeconds: 900,
      retryAfterSeconds: 5,
    });
    attachmentModelReceipt = await drain(
      "gmail-attachment-model-extraction",
      (input) => attachmentModelWorker.runOnce(input),
      { ...limits, limit: Math.min(limits.limit, 5), deferFailure: true },
    );
  }

  const attachmentIdentity = {
    workerId: "local-truth-gmail-slice:attachment-claims",
    processorVersion: `${RUNTIME_VERSION}:attachment-claims-v1`,
  };
  const attachmentContext = createTruthWorkerContextLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    ...attachmentIdentity,
    internalDomains: DEFAULT_PROCESSING_CONFIG.internalDomains,
    callRpc: ctx.callRpc,
  });
  const attachmentWorker = createTruthClaimWorker({
    jobLedger: fixedJobKindsLedger(ctx.jobLedger, [ATTACHMENT_CLAIM_JOB_KIND]),
    candidateLedger,
    evidenceLedger,
    extractor,
    loadObservation: attachmentContext.loadObservation,
    loadWorkgroupContext: attachmentContext.loadWorkgroupContext,
    loadAcceptedClaims: attachmentContext.loadAcceptedClaims,
    ...attachmentIdentity,
    policyVersion: ACCEPTANCE_POLICY_VERSION,
    policyVersions: { [ATTACHMENT_CLAIM_JOB_KIND]: ACCEPTANCE_POLICY_VERSION },
    leaseSeconds: 900,
  });
  const attachmentReceipt = await drain(
    "gmail-attachment-claims",
    (input) => attachmentWorker.runOnce(input),
    // One attachment context can be materially larger than a message context.
    // Claim one fence at a time so a client deadline cannot abandon a whole
    // leased batch without recording per-job outcomes.
    attachmentClaimDrainLimits(limits),
  );
  const receipts = [parentReceipt, messageModelReceipt, attachmentModelReceipt, attachmentReceipt]
    .filter(Boolean);
  if (receipts.some((receipt) => receipt.hardFailedCount > 0)) {
    const error = new Error("Gmail claim workers reported one or more unhandled job failures");
    error.code = "LOCAL_TRUTH_GMAIL_WORKER_FAILED";
    error.receipt = {
      name: "gmail-claims",
      parent: parentReceipt,
      messageModel: messageModelReceipt,
      attachmentModel: attachmentModelReceipt,
      attachments: attachmentReceipt,
      productionPublicationAttempted: false,
    };
    throw error;
  }
  if (receipts.some((receipt) => receipt.drained !== true)) {
    const error = new Error("Gmail claim workers did not reach a terminal scoped frontier");
    error.code = "LOCAL_TRUTH_GMAIL_CLAIMS_INCOMPLETE";
    error.receipt = {
      name: "gmail-claims",
      parent: parentReceipt,
      messageModel: messageModelReceipt,
      attachmentModel: attachmentModelReceipt,
      attachments: attachmentReceipt,
      productionPublicationAttempted: false,
    };
    throw error;
  }
  return {
    parent: parentReceipt,
    messageModel: messageModelReceipt,
    attachmentModel: attachmentModelReceipt,
    attachments: attachmentReceipt,
    modelSpendAuthority: "truth-model-database-ledgers",
    productionPublicationAttempted: false,
  };
}

function requireModelOn(ctx, operation) {
  if (ctx.modelOn !== true) {
    throw new Error(`${operation} requires --model-on and PQ_TRUTH_MODEL_RUNTIME_ENABLED=1`);
  }
}

async function prepareModelCommissioning(ctx, limits) {
  requireModelOn(ctx, "model commissioning");
  const receipt = await ctx.callRpc(MODEL_PREPARE_RPC, {
    p_workspace_key: WORKSPACE_KEY,
    p_connection_key: CONNECTION_KEY,
    p_root_batch_id: ROOT_BATCH_ID,
    p_limit: Math.min(limits.limit, 100),
    p_review_token: ctx.reviewToken,
    p_sync_token: ctx.syncToken,
  });
  if (!receipt || receipt.ok !== true || receipt.shadowOnly !== true
      || receipt.productionPublicationAttempted !== false) {
    throw new Error("model commissioning returned an invalid or unsafe scope receipt");
  }
  return receipt;
}

async function readCommissioningReviews(ctx, limit = 100) {
  requireModelOn(ctx, "commissioning review read");
  const receipt = await ctx.callRpc(MODEL_REVIEW_QUEUE_RPC, {
    p_workspace_key: WORKSPACE_KEY,
    p_connection_key: CONNECTION_KEY,
    p_root_batch_id: ROOT_BATCH_ID,
    p_limit: Math.min(limit, 100),
    p_review_token: ctx.reviewToken,
    p_sync_token: ctx.syncToken,
  });
  if (!receipt || receipt.ok !== true || !Array.isArray(receipt.items)
      || receipt.workspaceKey !== WORKSPACE_KEY || receipt.connectionKey !== CONNECTION_KEY
      || receipt.rootBatchId !== ROOT_BATCH_ID || receipt.mutatesOperationalState !== false
      || receipt.productionPublicationAttempted !== false) {
    throw new Error("scoped commissioning review read returned an invalid receipt");
  }
  return receipt;
}

async function exportCommissioningReviews(ctx, outputPath) {
  const receipt = await readCommissioningReviews(ctx, 100);
  const artifact = {
    schemaVersion: "truth-shadow-model-commissioning-decisions-v1",
    workspaceKey: WORKSPACE_KEY,
    connectionKey: CONNECTION_KEY,
    rootBatchId: ROOT_BATCH_ID,
    instructions: "Inspect every candidate and its exact citation. Set decision to accept or reject and write a specific reason. Never bulk-accept unread evidence.",
    totalCount: receipt.totalCount,
    decisions: receipt.items.map((item) => ({
      targetId: item.targetId,
      targetItemHash: item.targetItemHash,
      expectedPreviousDecisionVersionId: item.previousDecisionVersionId || "",
      decision: "",
      reason: "",
      sourceObservationId: item.sourceObservationId,
      candidate: item.candidate,
    })),
    productionPublicationAttempted: false,
  };
  if (outputPath) {
    const absolute = path.resolve(ROOT, outputPath);
    if (!absolute.startsWith(`${ROOT}${path.sep}`)) {
      throw new Error("--output must remain inside the repository workspace");
    }
    fs.writeFileSync(absolute, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    return { ...receipt, outputPath: absolute, decisionArtifactWritten: true };
  }
  return { ...receipt, decisionArtifact: artifact };
}

function loadDecisionArtifact(relativePath) {
  if (!relativePath) throw new Error("--decision-file is required for review-apply");
  const absolute = path.resolve(ROOT, relativePath);
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("--decision-file must remain inside the repository workspace");
  }
  const artifact = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (!artifact || artifact.schemaVersion !== "truth-shadow-model-commissioning-decisions-v1"
      || artifact.workspaceKey !== WORKSPACE_KEY || artifact.connectionKey !== CONNECTION_KEY
      || artifact.rootBatchId !== ROOT_BATCH_ID || !Array.isArray(artifact.decisions)) {
    throw new Error("commissioning decision file has the wrong immutable scope");
  }
  const decisions = new Map();
  for (const item of artifact.decisions) {
    if (!item || !/^candidate:v1:[0-9a-f]{64}$/.test(String(item.targetId || ""))
        || !/^[0-9a-f]{64}$/.test(String(item.targetItemHash || ""))
        || !["accept", "reject"].includes(item.decision)
        || typeof item.reason !== "string" || !item.reason.trim()
        || item.reason.trim() !== item.reason || Buffer.byteLength(item.reason, "utf8") > 2000
        || decisions.has(item.targetId)) {
      throw new Error("every decision must be unique, terminal, hash-bound, and specifically reasoned");
    }
    decisions.set(item.targetId, item);
  }
  return { absolute, decisions };
}

async function applyCommissioningReviews(ctx, relativePath, maxRounds) {
  requireModelOn(ctx, "commissioning review application");
  const artifact = loadDecisionArtifact(relativePath);
  const candidateLedger = createTruthCandidateLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    reviewToken: ctx.reviewToken,
    callRpc: ctx.callRpc,
  });
  const receipts = [];
  const used = new Set();
  for (let round = 1; round <= maxRounds; round += 1) {
    const queue = await readCommissioningReviews(ctx, 100);
    if (queue.items.length === 0) break;
    let matchedThisRound = 0;
    for (const target of queue.items) {
      const decision = artifact.decisions.get(target.targetId);
      if (!decision) continue;
      if (decision.targetItemHash !== target.targetItemHash
          || String(decision.expectedPreviousDecisionVersionId || "") !==
            String(target.previousDecisionVersionId || "")) {
        throw new Error(`decision for ${target.targetId} is stale or hash-mismatched`);
      }
      const idempotencyHash = crypto.createHash("sha256").update(JSON.stringify({
        schemaVersion: "truth-shadow-model-commissioning-review-key-v1",
        workspaceKey: WORKSPACE_KEY,
        rootBatchId: ROOT_BATCH_ID,
        targetId: target.targetId,
        targetItemHash: target.targetItemHash,
        decision: decision.decision,
        reason: decision.reason,
      }), "utf8").digest("hex");
      receipts.push(await candidateLedger.resolveReview({
        targetId: target.targetId,
        expectedTargetHash: target.targetItemHash,
        expectedPreviousDecisionVersionId: target.previousDecisionVersionId || "",
        decision: decision.decision,
        policyVersion: "truth-shadow-model-commissioning-review-v1",
        decidedBy: "operator:truth-shadow-model-commissioning",
        reason: decision.reason,
        idempotencyKey: `truth_shadow_model_review_${idempotencyHash}`,
      }));
      used.add(target.targetId);
      matchedThisRound += 1;
    }
    // The scoped reader intentionally returns at most 100 unresolved targets.
    // A decision artifact is therefore one immutable operator-reviewed page,
    // not an implicit verdict over the unseen remainder.  Stop after this page
    // and let the operator export/read the next one.
    if (matchedThisRound === 0 || used.size === artifact.decisions.size) break;
  }
  const remaining = await readCommissioningReviews(ctx, 100);
  const unused = [...artifact.decisions.keys()].filter((targetId) => !used.has(targetId));
  if (unused.length) {
    throw new Error(`decision file contains ${unused.length} targets outside the current scoped review queue`);
  }
  return {
    ok: true,
    appliedCount: receipts.length,
    acceptedCount: receipts.filter((receipt) => receipt.decision === "accept").length,
    rejectedCount: receipts.filter((receipt) => receipt.decision === "reject").length,
    remainingCount: remaining.totalCount,
    reviewComplete: remaining.totalCount === 0,
    nextBatchRequired: remaining.totalCount > 0,
    receipts,
    productionPublicationAttempted: false,
  };
}

function assertLinkSamplePlanId(planId) {
  if (!/^truth-shadow-link-sample-plan:v1:[0-9a-f]{64}$/.test(String(planId || ""))) {
    throw new Error("--plan-id must be a truth-shadow-link-sample-plan:v1:<sha256> identity");
  }
  return planId;
}

function assertLinkSampleReceipt(receipt, operation, statuses) {
  if (!receipt || typeof receipt !== "object"
      || !statuses.includes(receipt.status)
      || receipt.productionPublicationAttempted !== false
      || !/^truth-shadow-link-sample-plan:v1:[0-9a-f]{64}$/.test(String(receipt.planId || ""))) {
    const error = new Error(`${operation} returned an invalid or unsafe receipt`);
    error.code = "TRUTH_SHADOW_LINK_SAMPLE_INVALID_RECEIPT";
    error.receipt = receipt || null;
    throw error;
  }
  return receipt;
}

async function openLinkSample(ctx) {
  const receipt = await ctx.callRpc(LINK_SAMPLE_OPEN_RPC, {
    p_workspace_key: WORKSPACE_KEY,
    p_connection_key: CONNECTION_KEY,
    p_root_batch_id: ROOT_BATCH_ID,
    p_review_token: ctx.reviewToken,
    p_sync_token: ctx.syncToken,
  }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
  assertLinkSampleReceipt(receipt, "open shadow link sample", ["opened"]);
  if (receipt.ok !== true
      || !/^[0-9a-f]{64}$/.test(String(receipt.planHash || ""))
      || !Number.isSafeInteger(receipt.populationCount) || receipt.populationCount < 1
      || !Number.isSafeInteger(receipt.sampleCount) || receipt.sampleCount < 1
      || receipt.sampleCount > receipt.populationCount) {
    throw new Error("open shadow link sample returned invalid immutable population counts");
  }
  return receipt;
}

async function readLinkSamplePage(ctx, planId, afterSampleOrdinal = 0, limit = 10) {
  assertLinkSamplePlanId(planId);
  const receipt = await ctx.callRpc(LINK_SAMPLE_READ_RPC, {
    p_workspace_key: WORKSPACE_KEY,
    p_plan_id: planId,
    p_after_sample_ordinal: afterSampleOrdinal,
    p_limit: Math.min(limit, 10),
    p_review_token: ctx.reviewToken,
    p_sync_token: ctx.syncToken,
  }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
  assertLinkSampleReceipt(receipt, "read shadow link sample", ["read"]);
  if (receipt.ok !== true || receipt.planId !== planId
      || !/^[0-9a-f]{64}$/.test(String(receipt.planHash || ""))
      || !Number.isSafeInteger(receipt.populationCount) || receipt.populationCount < 1
      || !Number.isSafeInteger(receipt.sampleCount) || receipt.sampleCount < 1
      || receipt.sampleCount > receipt.populationCount
      || !Array.isArray(receipt.items)) {
    throw new Error("read shadow link sample returned an invalid immutable page");
  }
  return receipt;
}

async function exportLinkSample(ctx, planId, outputPath) {
  assertLinkSamplePlanId(planId);
  const pages = [];
  const items = [];
  const proposalIds = new Set();
  let afterSampleOrdinal = 0;
  let identity = null;
  while (identity === null || items.length < identity.sampleCount) {
    const page = await readLinkSamplePage(ctx, planId, afterSampleOrdinal, 10);
    const pageIdentity = {
      planHash: page.planHash,
      populationCount: page.populationCount,
      sampleCount: page.sampleCount,
      stratumCount: page.stratumCount,
    };
    if (identity && JSON.stringify(pageIdentity) !== JSON.stringify(identity)) {
      throw new Error("shadow link sample identity changed while it was being read");
    }
    identity ||= pageIdentity;
    pages.push(page);
    if (page.items.length === 0) break;
    for (const item of page.items) {
      if (!item || !Number.isSafeInteger(item.sampleOrdinal)
          || item.sampleOrdinal !== afterSampleOrdinal + 1
          || !/^link-proposal:v1:[0-9a-f]{64}$/.test(String(item.proposalId || ""))
          || !/^[0-9a-f]{64}$/.test(String(item.proposalHash || ""))
          || !/^link-decision:v1:[0-9a-f]{64}$/.test(String(item.expectedPreviousDecisionVersionId || ""))
          || !/^[0-9a-f]{64}$/.test(String(item.expectedPreviousDecisionHash || ""))
          || !/^[0-9a-f]{64}$/.test(String(item.evidenceManifestHash || ""))
          || !Array.isArray(item.evidence) || proposalIds.has(item.proposalId)) {
        throw new Error("shadow link sample page contains an invalid, duplicate, or non-contiguous item");
      }
      if (item.resolution !== null) {
        throw new Error("shadow link sample already has decisions; retain and replay the original decision artifact");
      }
      proposalIds.add(item.proposalId);
      items.push(item);
      afterSampleOrdinal = item.sampleOrdinal;
    }
  }
  if (!identity || items.length !== identity.sampleCount) {
    throw new Error("shadow link sample export did not read the complete sealed sample");
  }
  const artifact = {
    schemaVersion: "truth-shadow-link-sample-decisions-v1",
    workspaceKey: WORKSPACE_KEY,
    connectionKey: CONNECTION_KEY,
    rootBatchId: ROOT_BATCH_ID,
    planId,
    planHash: identity.planHash,
    populationCount: identity.populationCount,
    sampleCount: identity.sampleCount,
    stratumCount: identity.stratumCount,
    instructions: "Read every sampled observation in full. Set each decision to accept or reject and give a specific evidence-based reason. One rejection prevents sampled-policy authorization for the unsampled population.",
    decisions: items.map((item) => ({
      sampleOrdinal: item.sampleOrdinal,
      proposalId: item.proposalId,
      proposalHash: item.proposalHash,
      expectedPreviousDecisionVersionId: item.expectedPreviousDecisionVersionId,
      expectedPreviousDecisionHash: item.expectedPreviousDecisionHash,
      evidenceManifestHash: item.evidenceManifestHash,
      stratum: item.stratum,
      sampleRankHash: item.sampleRankHash,
      candidate: item.candidate,
      evidence: item.evidence,
      decision: "",
      reason: "",
    })),
    productionPublicationAttempted: false,
  };
  if (outputPath) {
    const absolute = path.resolve(ROOT, outputPath);
    if (!absolute.startsWith(`${ROOT}${path.sep}`)) {
      throw new Error("--output must remain inside the repository workspace");
    }
    fs.writeFileSync(absolute, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    return {
      ok: true,
      status: "exported",
      planId,
      sampleCount: items.length,
      pageCount: pages.length,
      outputPath: absolute,
      decisionArtifactWritten: true,
      productionPublicationAttempted: false,
    };
  }
  return {
    ok: true,
    status: "exported",
    planId,
    sampleCount: items.length,
    pageCount: pages.length,
    decisionArtifact: artifact,
    productionPublicationAttempted: false,
  };
}

function loadLinkSampleDecisionArtifact(relativePath) {
  if (!relativePath) throw new Error("--decision-file is required for link-sample-apply");
  const absolute = path.resolve(ROOT, relativePath);
  if (!absolute.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("--decision-file must remain inside the repository workspace");
  }
  const artifact = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (!artifact || artifact.schemaVersion !== "truth-shadow-link-sample-decisions-v1"
      || artifact.workspaceKey !== WORKSPACE_KEY || artifact.connectionKey !== CONNECTION_KEY
      || artifact.rootBatchId !== ROOT_BATCH_ID
      || !/^truth-shadow-link-sample-plan:v1:[0-9a-f]{64}$/.test(String(artifact.planId || ""))
      || !/^[0-9a-f]{64}$/.test(String(artifact.planHash || ""))
      || artifact.productionPublicationAttempted !== false
      || !Number.isSafeInteger(artifact.populationCount) || artifact.populationCount < 1
      || !Number.isSafeInteger(artifact.sampleCount) || artifact.sampleCount < 1
      || artifact.sampleCount > artifact.populationCount
      || !Array.isArray(artifact.decisions)
      || artifact.decisions.length !== artifact.sampleCount) {
    throw new Error("link sample decision file has the wrong immutable scope or population");
  }
  const proposalIds = new Set();
  const decisions = artifact.decisions.map((item, index) => {
    if (!item || item.sampleOrdinal !== index + 1
        || !/^link-proposal:v1:[0-9a-f]{64}$/.test(String(item.proposalId || ""))
        || !/^[0-9a-f]{64}$/.test(String(item.proposalHash || ""))
        || !/^link-decision:v1:[0-9a-f]{64}$/.test(String(item.expectedPreviousDecisionVersionId || ""))
        || !/^[0-9a-f]{64}$/.test(String(item.expectedPreviousDecisionHash || ""))
        || !/^[0-9a-f]{64}$/.test(String(item.evidenceManifestHash || ""))
        || !["accept", "reject"].includes(item.decision)
        || typeof item.reason !== "string" || !item.reason.trim()
        || item.reason.trim() !== item.reason || Buffer.byteLength(item.reason, "utf8") > 2000
        || proposalIds.has(item.proposalId)) {
      throw new Error("every sampled link decision must be unique, terminal, contiguous, hash-bound, and specifically reasoned");
    }
    proposalIds.add(item.proposalId);
    return item;
  });
  return { absolute, artifact, decisions };
}

async function applyLinkSampleReviews(ctx, relativePath) {
  const { artifact, decisions } = loadLinkSampleDecisionArtifact(relativePath);
  const receipts = [];
  for (const decision of decisions) {
    const idempotencyHash = crypto.createHash("sha256").update(JSON.stringify({
      schemaVersion: "truth-shadow-link-sample-review-key-v1",
      workspaceKey: WORKSPACE_KEY,
      planId: artifact.planId,
      proposalId: decision.proposalId,
      proposalHash: decision.proposalHash,
      expectedPreviousDecisionVersionId: decision.expectedPreviousDecisionVersionId,
      decision: decision.decision,
      reason: decision.reason,
    }), "utf8").digest("hex");
    const receipt = await ctx.callRpc(LINK_SAMPLE_RESOLVE_RPC, {
      p_workspace_key: WORKSPACE_KEY,
      p_plan_id: artifact.planId,
      p_proposal_id: decision.proposalId,
      p_expected_proposal_hash: decision.proposalHash,
      p_expected_previous_decision_version_id: decision.expectedPreviousDecisionVersionId,
      p_decision: decision.decision,
      p_decided_by: "operator:truth-shadow-link-sample",
      p_reason: decision.reason,
      p_idempotency_key: `truth_shadow_link_sample_${idempotencyHash}`,
      p_review_token: ctx.reviewToken,
      p_sync_token: ctx.syncToken,
    }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
    if (!receipt || receipt.ok !== true || receipt.planId !== artifact.planId
        || receipt.targetId !== decision.proposalId
        || receipt.targetItemHash !== decision.proposalHash
        || receipt.decision !== decision.decision
        || receipt.productionPublicationAttempted !== false) {
      const error = new Error(`sample review for ${decision.proposalId} returned an invalid or unsafe receipt`);
      error.code = "TRUTH_SHADOW_LINK_SAMPLE_REVIEW_FAILED";
      error.receipt = receipt || null;
      throw error;
    }
    receipts.push(receipt);
  }
  return {
    ok: true,
    status: "reviewed",
    planId: artifact.planId,
    reviewedCount: receipts.length,
    acceptedCount: receipts.filter((receipt) => receipt.decision === "accept").length,
    rejectedCount: receipts.filter((receipt) => receipt.decision === "reject").length,
    productionPublicationAttempted: false,
    receipts,
  };
}

async function authorizeLinkSample(ctx, planId, attestationReason) {
  assertLinkSamplePlanId(planId);
  if (typeof attestationReason !== "string" || attestationReason.trim() !== attestationReason
      || attestationReason.length < 20 || Buffer.byteLength(attestationReason, "utf8") > 2000) {
    throw new Error("--attestation must be a specific 20-2000 byte operator statement");
  }
  const receipt = await ctx.callRpc(LINK_SAMPLE_AUTHORIZE_RPC, {
    p_workspace_key: WORKSPACE_KEY,
    p_plan_id: planId,
    p_authorized_by: "operator:truth-shadow-link-sample",
    p_attestation_reason: attestationReason,
    p_review_token: ctx.reviewToken,
    p_sync_token: ctx.syncToken,
  }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
  if (receipt?.status === "not_ready") {
    const error = new Error(`link sample cannot authorize: ${receipt.reason || "unknown reason"}`);
    error.code = "TRUTH_SHADOW_LINK_SAMPLE_NOT_READY";
    error.receipt = receipt;
    throw error;
  }
  assertLinkSampleReceipt(receipt, "authorize shadow link sample", ["authorized"]);
  if (receipt.ok !== true || receipt.planId !== planId
      || !/^truth-shadow-link-sample-authorization:v1:[0-9a-f]{64}$/.test(String(receipt.authorizationId || ""))
      || !/^[0-9a-f]{64}$/.test(String(receipt.authorizationHash || ""))) {
    throw new Error("authorize shadow link sample returned an invalid immutable authorization");
  }
  return receipt;
}

async function runLinkSampleAcceptance(ctx, planId, limit, maxRounds) {
  assertLinkSamplePlanId(planId);
  const attempts = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    const receipt = await ctx.callRpc(LINK_SAMPLE_RUN_RPC, {
      p_workspace_key: WORKSPACE_KEY,
      p_plan_id: planId,
      p_limit: limit,
      p_sync_token: ctx.syncToken,
    }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
    assertLinkSampleReceipt(receipt, "run shadow link sample", ["progress", "succeeded", "not_ready"]);
    attempts.push(receipt);
    if (receipt.status === "succeeded") {
      if (receipt.ok !== true || receipt.planId !== planId
          || !/^truth-shadow-link-sample-seal:v1:[0-9a-f]{64}$/.test(String(receipt.sealId || ""))
          || !/^[0-9a-f]{64}$/.test(String(receipt.sealHash || ""))) {
        throw new Error("run shadow link sample returned an invalid immutable seal");
      }
      return { ...receipt, attempts };
    }
    if (receipt.status === "not_ready") {
      const error = new Error(`link sample cannot run: ${receipt.reason || "unknown reason"}`);
      error.code = "TRUTH_SHADOW_LINK_SAMPLE_NOT_READY";
      error.receipt = receipt;
      throw error;
    }
    if (receipt.ok !== true || receipt.planId !== planId
        || !Number.isSafeInteger(receipt.processedCount) || receipt.processedCount < 1
        || !Number.isSafeInteger(receipt.remainingCount) || receipt.remainingCount < 1) {
      const error = new Error("link sample policy runtime made no safe forward progress");
      error.code = "TRUTH_SHADOW_LINK_SAMPLE_STALLED";
      error.receipt = receipt;
      throw error;
    }
  }
  const error = new Error("link sample policy runtime exceeded the bounded round count");
  error.code = "TRUTH_SHADOW_LINK_SAMPLE_INCOMPLETE";
  error.receipt = attempts.at(-1) || null;
  throw error;
}

async function runAcceptanceEpoch(ctx, obligationId, maxRounds) {
  if (!/^pending-acceptance-epoch:v1:[0-9a-f]{64}$/.test(obligationId)) {
    throw new Error("--obligation-id must be a pending-acceptance-epoch:v1:<sha256> identity");
  }
  const attempts = [];
  for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
    const receipt = await ctx.callRpc(ACCEPTANCE_RPC, {
      p_workspace_key: WORKSPACE_KEY,
      p_obligation_id: obligationId,
      p_sync_token: ctx.syncToken,
    }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
    attempts.push(receipt);
    if (receipt?.status === "succeeded") {
      if (receipt.productionPublicationAttempted !== false) {
        throw new Error("acceptance epoch violated the shadow-only publication contract");
      }
      return { ...receipt, attempts };
    }
    if (receipt?.status !== "busy") {
      const error = new Error(`acceptance epoch is ${receipt?.status || "invalid"}: ${receipt?.reason || receipt?.reasonCode || "unknown reason"}`);
      error.code = "TRUTH_SHADOW_ACCEPTANCE_NOT_READY";
      error.receipt = receipt;
      throw error;
    }
  }
  const error = new Error("acceptance epoch remained busy through the bounded retry count");
  error.code = "TRUTH_SHADOW_ACCEPTANCE_BUSY";
  error.receipt = attempts.at(-1) || null;
  throw error;
}

function lateAcceptanceRetryDelayMs(attempt, random = Math.random) {
  const boundedAttempt = Math.max(1, Math.min(6, Number(attempt) || 1));
  const baseMs = Math.min(5_000, 250 * (2 ** (boundedAttempt - 1)));
  const jitterMs = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 250);
  return baseMs + jitterMs;
}

async function runLateModelAcceptance(ctx, maxRounds) {
  const attempts = [];
  const wait = typeof ctx.wait === "function"
    ? ctx.wait
    : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const random = typeof ctx.random === "function" ? ctx.random : Math.random;
  for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
    const receipt = await ctx.callRpc(LATE_MODEL_ACCEPTANCE_RPC, {
      p_workspace_key: WORKSPACE_KEY,
      p_connection_key: CONNECTION_KEY,
      p_root_batch_id: ROOT_BATCH_ID,
      p_review_token: ctx.reviewToken,
      p_sync_token: ctx.syncToken,
    }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
    attempts.push(receipt);
    if (receipt?.productionPublicationAttempted !== false) {
      const error = new Error("late-model acceptance violated the shadow-only publication contract");
      error.code = "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_UNSAFE";
      error.receipt = receipt || null;
      throw error;
    }
    if (receipt?.status === "succeeded") {
      if (receipt.ok !== true || receipt.shadowOnly !== true
          || receipt.publicationChannel !== "shadow" || receipt.publishesTruth !== false
          || !/^truth-shadow-late-model-acceptance:v1:[0-9a-f]{64}$/.test(String(receipt.lateAcceptanceId || ""))
          || !/^[0-9a-f]{64}$/.test(String(receipt.lateAcceptanceReceiptHash || ""))
          || !/^truth-shadow-acceptance-epoch:v1:[0-9a-f]{64}$/.test(String(receipt.predecessorEpochId || ""))) {
        const error = new Error("late-model acceptance returned an invalid immutable shadow receipt");
        error.code = "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_INVALID";
        error.receipt = receipt;
        throw error;
      }
      return { ...receipt, attempts };
    }
    if (receipt?.status === "not_ready") {
      const error = new Error(`late-model acceptance is not ready: ${receipt.reason || receipt.reasonCode || "unknown reason"}`);
      error.code = "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_NOT_READY";
      error.receipt = receipt;
      throw error;
    }
    if (receipt?.status !== "busy" || receipt.ok !== true || receipt.retryable !== true) {
      const error = new Error(`late-model acceptance is ${receipt?.status || "invalid"}`);
      error.code = "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_INVALID";
      error.receipt = receipt || null;
      throw error;
    }
    if (attempt < maxRounds) {
      await wait(lateAcceptanceRetryDelayMs(attempt, random));
    }
  }
  const error = new Error("late-model acceptance remained busy through the bounded retry count");
  error.code = "TRUTH_SHADOW_LATE_MODEL_ACCEPTANCE_BUSY";
  error.receipt = attempts.at(-1) || null;
  throw error;
}

async function sealShadowSourceCut(ctx, obligationId) {
  if (!/^pending-acceptance-epoch:v1:[0-9a-f]{64}$/.test(obligationId)) {
    throw new Error("--obligation-id must be a pending-acceptance-epoch:v1:<sha256> identity");
  }
  const receipt = await ctx.callRpc(SHADOW_SOURCE_CUT_RPC, {
    p_workspace_key: WORKSPACE_KEY,
    p_obligation_id: obligationId,
    p_created_by: "local-truth-gmail-slice:shadow-source-cut",
    p_sync_token: ctx.syncToken,
  }, { timeoutMs: LONG_RPC_TIMEOUT_MS });
  if (!receipt || receipt.ok !== true || receipt.status !== "ready"
      || receipt.shadowOnly !== true || receipt.publicationChannel !== "shadow"
      || receipt.productionPublicationAttempted !== false || receipt.publishesTruth !== false) {
    const error = new Error(`shadow source cut is not ready: ${receipt?.status || "invalid"}`);
    error.code = "TRUTH_SHADOW_SOURCE_CUT_NOT_READY";
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

async function buildShadowSourceCut(ctx, sourceCutId) {
  if (!/^cut:v1:[0-9a-f]{64}$/.test(sourceCutId)) {
    throw new Error("--source-cut-id must be a cut:v1:<sha256> identity");
  }
  const ledger = createTruthBuildLedger({
    workspaceKey: WORKSPACE_KEY,
    syncToken: ctx.syncToken,
    callRpc: ctx.callRpc,
  });
  const receipt = await runRelationalTruthBuild({
    ledger,
    workerId: "local-truth-gmail-slice:shadow-build",
    sourceCutId,
    buildChannel: "shadow",
    triggerName: "local-truth-gmail-slice:shadow-build",
    idempotencyKey: `local-truth-gmail-slice:shadow-build:${sourceCutId}`,
    model: GMAIL_MODEL_SNAPSHOT,
    modelProvider: "openai-responses",
    promptVersion: GMAIL_PROMPT_VERSION,
    processingConfig: DEFAULT_PROCESSING_CONFIG,
    leaseSeconds: 900,
    bundleRowLimit: 100000,
    deadlineAtMs: Date.now() + LONG_RPC_TIMEOUT_MS,
    // Deliberately omit publication. This creates and completes only the two
    // relational shadow builds; it cannot advance even the shadow head and has
    // no production/live-board publication capability.
  });
  if (!receipt || receipt.status !== "succeeded"
      || receipt.pair?.buildChannel !== "shadow"
      || receipt.pair?.publicationChannel !== "shadow"
      || receipt.publication !== null) {
    const error = new Error(`shadow build did not complete safely: ${receipt?.status || "invalid"}`);
    error.code = "TRUTH_SHADOW_BUILD_NOT_SUCCEEDED";
    error.receipt = receipt || null;
    throw error;
  }
  return {
    ...receipt,
    publicationAttempted: false,
    productionPublicationAttempted: false,
  };
}

async function main() {
  const modelOn = hasFlag("--model-on");
  loadLocalEnv({ modelOn });
  const phase = argument("--phase");
  const linkSamplePhase = new Set([
    "link-sample-open", "link-sample-export", "link-sample-apply",
    "link-sample-authorize", "link-sample-run",
  ]).has(phase);
  const modelFreeAuthorityPhase = linkSamplePhase || phase === "late-model-acceptance";
  if (modelFreeAuthorityPhase && modelOn) {
    throw new Error("the requested shadow authority is model-free; omit --model-on and set PQ_TRUTH_MODEL_RUNTIME_ENABLED=0");
  }
  if (!hasFlag("--execute")) throw new Error("--execute is required for the approved relational shadow mutation");
  if (!new Set([
    "discover", "evidence", "attachments", "link-epoch-open", "links", "link-epoch-seal", "claims",
    "model-prepare", "review-export", "review-apply", "acceptance", "late-model-acceptance", "shadow-source-cut",
    "shadow-build", "link-sample-open", "link-sample-export", "link-sample-apply",
    "link-sample-authorize", "link-sample-run",
  ]).has(phase)) {
    throw new Error("--phase is not a supported local truth Gmail commissioning phase");
  }
  const limits = {
    limit: integer(argument("--limit", "5"), "--limit", 5, 1, phase === "link-sample-run" ? 50 : 20),
    maxRounds: integer(argument("--max-rounds", "1"), "--max-rounds", 1, 1, 500),
  };
  const ctx = runtime({ modelOn, reviewRequired: modelOn || modelFreeAuthorityPhase });
  let receipt;
  if (phase === "discover") receipt = await discover(ctx);
  if (phase === "evidence") receipt = await evidence(ctx, limits);
  if (phase === "attachments") receipt = await attachments(ctx, limits);
  if (phase === "link-epoch-open") receipt = await openLinkEpoch(ctx);
  if (phase === "links") receipt = await links(ctx, limits);
  if (phase === "link-epoch-seal") receipt = await sealLinkEpoch(ctx);
  if (phase === "claims") receipt = await claims(ctx, limits);
  if (phase === "model-prepare") receipt = await prepareModelCommissioning(ctx, limits);
  if (phase === "review-export") {
    receipt = await exportCommissioningReviews(ctx, argument("--output", ""));
  }
  if (phase === "review-apply") {
    receipt = await applyCommissioningReviews(
      ctx,
      argument("--decision-file", ""),
      limits.maxRounds,
    );
  }
  if (phase === "link-sample-open") receipt = await openLinkSample(ctx);
  if (phase === "link-sample-export") {
    receipt = await exportLinkSample(
      ctx,
      argument("--plan-id", ""),
      argument("--output", ""),
    );
  }
  if (phase === "link-sample-apply") {
    receipt = await applyLinkSampleReviews(ctx, argument("--decision-file", ""));
  }
  if (phase === "link-sample-authorize") {
    receipt = await authorizeLinkSample(
      ctx,
      argument("--plan-id", ""),
      argument("--attestation", ""),
    );
  }
  if (phase === "link-sample-run") {
    receipt = await runLinkSampleAcceptance(
      ctx,
      argument("--plan-id", ""),
      limits.limit,
      limits.maxRounds,
    );
  }
  if (phase === "acceptance") {
    receipt = await runAcceptanceEpoch(
      ctx,
      argument("--obligation-id", ""),
      limits.maxRounds,
    );
  }
  if (phase === "late-model-acceptance") {
    receipt = await runLateModelAcceptance(ctx, limits.maxRounds);
  }
  if (phase === "shadow-source-cut") {
    receipt = await sealShadowSourceCut(ctx, argument("--obligation-id", ""));
  }
  if (phase === "shadow-build") {
    receipt = await buildShadowSourceCut(ctx, argument("--source-cut-id", ""));
  }
  console.log(JSON.stringify({
    ok: true,
    runtimeVersion: RUNTIME_VERSION,
    runtimeMode: "local",
    phase,
    connectionKey: CONNECTION_KEY,
    modelRuntimeEnabled: modelOn,
    openAiKeyPresentInProcess: modelOn && Boolean(process.env.OPENAI_API_KEY),
    productionPublicationAttempted: false,
    receipt,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      runtimeVersion: RUNTIME_VERSION,
      code: String(error?.code || "LOCAL_TRUTH_GMAIL_SLICE_FAILED"),
      message: String(error?.message || error).replace(/\s+/g, " ").slice(0, 500),
      receipt: error?.receipt || null,
      modelRuntimeEnabled: hasFlag("--model-on"),
      productionPublicationAttempted: false,
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  _test: Object.freeze({
    applyLinkSampleReviews,
    attachmentClaimDrainLimits,
    applyCommissioningReviews,
    assertLinkSamplePlanId,
    authorizeLinkSample,
    buildShadowSourceCut,
    drain,
    exportCommissioningReviews,
    exportLinkSample,
    loadDecisionArtifact,
    loadLinkSampleDecisionArtifact,
    openLinkSample,
    readLinkSamplePage,
    rpcTimeoutMs,
    runAcceptanceEpoch,
    lateAcceptanceRetryDelayMs,
    runLateModelAcceptance,
    runLinkSampleAcceptance,
    sealShadowSourceCut,
  }),
});

"use strict";

const crypto = require("node:crypto");

const { createGmailApiClient } = require("./gmail-api-client");
const { createGmailAttachmentWorker } = require("./gmail-attachment-worker");
const {
  createGmailClaimExtractor,
  ACCEPTANCE_POLICY_VERSION: GMAIL_ACCEPTANCE_POLICY_VERSION,
  PROMPT_VERSION: GMAIL_PROMPT_VERSION,
} = require("./gmail-claim-extractor");
const { createGmailEvidenceWorker } = require("./gmail-evidence-worker");
const { createGmailClaimsReadinessCoordinator } = require("./truth-gmail-claims-readiness");
const { createGmailAcceptanceReadinessCoordinator } = require("./truth-gmail-acceptance-readiness");
const {
  createGenericAcceptanceReadinessCoordinator,
} = require("./truth-generic-acceptance-readiness");
const { createGmailIncrementalSync } = require("./gmail-incremental-sync");
const { createGmailMailboxBackfill } = require("./gmail-mailbox-backfill");
const { createGmailMailboxLedger } = require("./gmail-mailbox-ledger");
const {
  PINNED_MODEL: GMAIL_MODEL_SNAPSHOT,
  createOpenAIGmailModelExtractor,
} = require("./openai-gmail-model-extractor");
const {
  createOpenAIGmailAttachmentModelExtractor,
} = require("./openai-gmail-attachment-model-extractor");
const { callSupabaseRpc } = require("./supabase-agent");
const { createRelationalTruthAuditRunner } = require("./relational-truth-audit-runner");
const { runRelationalTruthBuild } = require("./relational-truth-build-runner");
const { REDUCER_VERSION } = require("./relational-truth-reducer");
const {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
} = require("./relational-truth-delivery-adapter");
const { createSourceProcessingJobLedger } = require("./source-processing-job-ledger");
const { createTruthAuditLedger } = require("./truth-audit-ledger");
const { createTruthBuildLedger } = require("./truth-build-ledger");
const { createTruthCandidateLedger } = require("./truth-candidate-ledger");
const {
  ATTACHMENT_JOB_KIND: GMAIL_ATTACHMENT_CLAIM_JOB_KIND,
  JOB_KIND: GMAIL_CLAIM_JOB_KIND,
  OPERATOR_JOB_KIND,
  TMS_JOB_KIND,
  TRACKING_JOB_KIND,
  createTruthClaimWorker,
} = require("./truth-claim-worker");
const { createTruthEvidenceLedger } = require("./truth-evidence-ledger");
const { createTruthGmailModelPlanLedger } = require("./truth-gmail-model-plan-ledger");
const {
  createTruthGmailAttachmentModelLedger,
} = require("./truth-gmail-attachment-model-ledger");
const {
  JOB_KIND: GMAIL_ATTACHMENT_MODEL_JOB_KIND,
  createTruthGmailAttachmentModelWorker,
} = require("./truth-gmail-attachment-model-worker");
const {
  PLAN_CONFIG: GMAIL_MODEL_PLAN_CONFIG,
  createTruthGmailParentPlanningWorker,
} = require("./truth-gmail-parent-planning-worker");
const { createTruthLinkLedger } = require("./truth-link-ledger");
const { createTruthLinkWorker } = require("./truth-link-worker");
const { createTruthModelExtractionWorker } = require("./truth-model-extraction-worker");
const { createTruthModelRequestLedger } = require("./truth-model-request-ledger");
const { createServerTruthRawObjectStore } = require("./truth-raw-object-store-factory");
const { createTruthShadowOrchestrator } = require("./truth-shadow-orchestrator");
const { createTruthSourceCutLedger } = require("./truth-source-cut-ledger");
const {
  createTruthProductionSourceCutCoordinator,
} = require("./truth-production-source-cut-coordinator");
const { createTruthWorkerContextLedger } = require("./truth-worker-context-ledger");
const { DEFAULT_POLICY } = require("./truth-precedence-policy");
const {
  DEFAULT_PROCESSING_CONFIG,
  createConfiguredProcessingWatermark,
  normalizeProcessingConfig,
} = require("./truth-processing-watermark");
const { isAbortSignal, throwIfAborted } = require("./runtime-deadline");
const {
  createTmsClaimExtractor,
  ACCEPTANCE_POLICY_VERSION: TMS_ACCEPTANCE_POLICY_VERSION,
} = require("./tms-claim-extractor");
const {
  createTrackingClaimExtractor,
  ACCEPTANCE_POLICY_VERSION: TRACKING_ACCEPTANCE_POLICY_VERSION,
} = require("./tracking-claim-extractor");
const {
  createOperatorClaimExtractor,
  ACCEPTANCE_POLICY_VERSION: OPERATOR_ACCEPTANCE_POLICY_VERSION,
} = require("./operator-claim-extractor");

const RUNTIME_VERSION = "hosted-truth-shadow-runtime-v2";
const WORKSPACE_KEY = "primary";
const CONNECTIONS = Object.freeze({
  gmail: "primary",
  tms: "couriercloud-ops-tlv-us",
  tracking: "carrier-tracking-primary",
  operator: "operator-phone-primary",
});
const CLAIM_SOURCES = Object.freeze(Object.keys(CONNECTIONS));
const DEFAULT_INTERNAL_DOMAINS = DEFAULT_PROCESSING_CONFIG.internalDomains;
const CLAIM_POLICY_VERSIONS = Object.freeze({
  gmail: GMAIL_ACCEPTANCE_POLICY_VERSION,
  tms: TMS_ACCEPTANCE_POLICY_VERSION,
  tracking: TRACKING_ACCEPTANCE_POLICY_VERSION,
  operator: OPERATOR_ACCEPTANCE_POLICY_VERSION,
});
const SOURCE_CLAIM_JOB_KINDS = Object.freeze({
  gmail: GMAIL_CLAIM_JOB_KIND,
  tms: TMS_JOB_KIND,
  tracking: TRACKING_JOB_KIND,
  operator: OPERATOR_JOB_KIND,
});

const PROCESSORS = Object.freeze({
  gmailEvidence: `${RUNTIME_VERSION}:gmail-evidence-v1`,
  gmailAttachment: `${RUNTIME_VERSION}:gmail-attachment-v1`,
  gmailLink: `${RUNTIME_VERSION}:gmail-link-v1`,
  gmailClaim: `${RUNTIME_VERSION}:gmail-parent-plan-v1`,
  gmailAttachmentClaim: `${RUNTIME_VERSION}:gmail-attachment-claim-v1`,
  gmailAttachmentModel: `${RUNTIME_VERSION}:gmail-attachment-model-v1`,
  gmailModelClaim: `${RUNTIME_VERSION}:gmail-model-claim-v1`,
  tmsClaim: `${RUNTIME_VERSION}:tms-claim-v1`,
  trackingClaim: `${RUNTIME_VERSION}:tracking-claim-v1`,
  operatorClaim: `${RUNTIME_VERSION}:operator-claim-v1`,
  build: `${RUNTIME_VERSION}:build-v1`,
});

class HostedTruthShadowRuntimeError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "HostedTruthShadowRuntimeError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new HostedTruthShadowRuntimeError(`Invalid hosted truth-shadow ${field}: ${reason}`, {
    code: "HOSTED_TRUTH_SHADOW_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, { minimumBytes = 1, maximumBytes = 8192 } = {}) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw invalid(field, "must be a trimmed string");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw invalid(field, `must contain ${minimumBytes} through ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function envText(env, name, options = {}) {
  return text(env[name] ?? "", `env.${name}`, options);
}

function integer(value, field, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function decimal(value, field, fallback, minimumExclusive, maximumInclusive) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate <= minimumExclusive || candidate > maximumInclusive ||
      Number(candidate.toFixed(6)) !== candidate) {
    throw invalid(
      field,
      `must be greater than ${minimumExclusive}, at most ${maximumInclusive}, and use no more than six decimals`,
    );
  }
  return candidate;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw invalid("environment boolean", "must be 1, 0, true, or false");
}

function modelApiKey(value) {
  if (typeof value !== "string" || !value || value.trim() !== value) return null;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 20 && bytes <= 4096 ? value : null;
}

function modelProviderReady(value) {
  return Boolean(value)
    && typeof value.prepareRequest === "function"
    && typeof value.executeAuthorizedAttempt === "function";
}

function ceremonyPausedGmailSyncReceipt(mode) {
  return Object.freeze({
    status: "no_changes",
    mode,
    reasonCode: "TRUTH_CEREMONY_GMAIL_INGEST_PAUSED",
    sourceCursorMutated: false,
    sourceBatchCreated: false,
    productionPublicationAttempted: false,
    mutatesOperationalState: false,
  });
}

function internalDomains(value) {
  const raw = String(value || "").trim();
  const values = raw ? raw.split(",") : [...DEFAULT_INTERNAL_DOMAINS];
  const domains = [...new Set(values.map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
  if (!domains.length || domains.some((domain) => !/^[a-z0-9.-]+$/.test(domain))) {
    throw invalid("env.PQ_TRUTH_INTERNAL_DOMAINS", "must be a comma-separated normalized domain list");
  }
  return Object.freeze(domains);
}

function requireFactory(factories, name) {
  if (typeof factories[name] !== "function") throw invalid(`factories.${name}`, "must be a function");
  return factories[name];
}

const DEFAULT_FACTORIES = Object.freeze({
  createGmailApiClient,
  createGmailAttachmentWorker,
  createGmailClaimExtractor,
  createGmailEvidenceWorker,
  createGmailIncrementalSync,
  createGmailMailboxBackfill,
  createGmailMailboxLedger,
  createOpenAIGmailAttachmentModelExtractor,
  createOpenAIGmailModelExtractor,
  createRelationalTruthAuditRunner,
  createServerTruthRawObjectStore,
  createSourceProcessingJobLedger,
  createTruthAuditLedger,
  createTruthBuildLedger,
  createTruthCandidateLedger,
  createTruthClaimWorker,
  createTruthEvidenceLedger,
  createTruthGmailAttachmentModelLedger,
  createTruthGmailAttachmentModelWorker,
  createTruthGmailModelPlanLedger,
  createTruthGmailParentPlanningWorker,
  createTruthLinkLedger,
  createTruthLinkWorker,
  createTruthModelExtractionWorker,
  createTruthModelRequestLedger,
  createTruthProductionSourceCutCoordinator,
  createTruthShadowOrchestrator,
  createTruthSourceCutLedger,
  createTruthWorkerContextLedger,
  createTmsClaimExtractor,
  createTrackingClaimExtractor,
  createOperatorClaimExtractor,
  runRelationalTruthBuild,
});

function workerAdapter(name, worker, method, fixed = {}) {
  if (!worker || typeof worker[method] !== "function") {
    throw invalid(`worker.${name}`, `must expose ${method}()`);
  }
  return Object.freeze({
    name,
    runOnce(input = {}) {
      return worker[method]({ ...fixed, ...input });
    },
  });
}

function claimWorkerIdentity(sourceSystem) {
  const processorKey = `${sourceSystem}Claim`;
  return Object.freeze({
    workerId: `truth-shadow:${sourceSystem}-claims`,
    processorVersion: PROCESSORS[processorKey],
  });
}

function fixedJobKindsLedger(jobLedger, jobKinds) {
  if (!jobLedger || !Array.isArray(jobKinds) || !jobKinds.length) {
    throw invalid("fixedJobKindsLedger", "requires a job ledger and at least one job kind");
  }
  const allowed = Object.freeze([...new Set(jobKinds)].sort());
  for (const method of ["claimJobs", "renewJob", "completeJob", "failJob"]) {
    if (typeof jobLedger[method] !== "function") {
      throw invalid("fixedJobKindsLedger", `job ledger must expose ${method}()`);
    }
  }
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

function gmailAttachmentClaimIdentity() {
  return Object.freeze({
    workerId: "truth-shadow:gmail-attachment-claims",
    processorVersion: PROCESSORS.gmailAttachmentClaim,
  });
}

function gmailAttachmentModelIdentity() {
  return Object.freeze({
    workerId: "truth-shadow:gmail-attachment-model",
    processorVersion: PROCESSORS.gmailAttachmentModel,
  });
}

function gmailModelClaimIdentity() {
  return Object.freeze({
    workerId: "truth-shadow:gmail-model-claims",
    processorVersion: PROCESSORS.gmailModelClaim,
  });
}

function createHostedTruthShadowRuntime(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const env = options.env || process.env;
  if (!env || typeof env !== "object") throw invalid("env", "must be an object");
  const factories = { ...DEFAULT_FACTORIES, ...(options.factories || {}) };
  for (const name of Object.keys(DEFAULT_FACTORIES)) requireFactory(factories, name);
  const signal = options.signal ?? null;
  if (signal !== null && !isAbortSignal(signal)) throw invalid("signal", "must be an AbortSignal or null");
  const hasDeadline = options.deadlineAtMs !== undefined
    && options.deadlineAtMs !== null
    && options.deadlineAtMs !== "";
  const deadlineAtMs = hasDeadline ? Number(options.deadlineAtMs) : null;
  if (hasDeadline && !Number.isFinite(deadlineAtMs)) {
    throw invalid("deadlineAtMs", "must be finite epoch milliseconds or null");
  }
  const rpcTimeoutMs = integer(
    env.PQ_TRUTH_RPC_TIMEOUT_MS,
    "env.PQ_TRUTH_RPC_TIMEOUT_MS",
    20_000,
    250,
    30_000,
  );
  const callTruthRpc = (rpc, body, rpcOptions = {}) => callSupabaseRpc(rpc, body, {
    ...rpcOptions,
    timeoutMs: Math.min(Number(rpcOptions.timeoutMs || rpcTimeoutMs), rpcTimeoutMs),
    retryDelaysMs: [],
    signal,
    deadlineAtMs: rpcOptions.deadlineAtMs ?? deadlineAtMs,
    outcomeUnknownOnAbort: !/^(?:read|get)_/.test(String(rpc)),
    outcomeUnknownOnTransportFailure: !/^(?:read|get)_/.test(String(rpc)),
  });

  const workspaceKey = text(options.workspaceKey || env.PQ_TRUTH_WORKSPACE || WORKSPACE_KEY, "workspaceKey", {
    maximumBytes: 128,
  });
  if (workspaceKey !== WORKSPACE_KEY) {
    throw invalid("workspaceKey", `must equal the migrated workspace ${WORKSPACE_KEY}`);
  }
  const syncToken = envText(env, "PQ_SUPABASE_SYNC_TOKEN", { minimumBytes: 16, maximumBytes: 4096 });
  const auditToken = envText(env, "PQ_TRUTH_AUDIT_TOKEN", { minimumBytes: 16, maximumBytes: 4096 });
  const supabaseUrl = envText(env, "PQ_SUPABASE_URL", { maximumBytes: 2048 });
  const serviceRoleKey = envText(env, "PQ_SUPABASE_SERVICE_ROLE_KEY", { minimumBytes: 16, maximumBytes: 8192 });
  const anonKey = envText(env, "PQ_SUPABASE_ANON_KEY", { minimumBytes: 16, maximumBytes: 8192 });
  const productionOrigin = envText(env, "PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN", { maximumBytes: 2048 });
  const productionWitnessToken = envText(env, "PQ_TRUTH_PRODUCTION_WITNESS_TOKEN", {
    minimumBytes: 32,
    maximumBytes: 128,
  });
  const productionProtectionBypassSecret = text(
    env.PQ_TRUTH_PROTECTION_BYPASS_SECRET || env.VERCEL_AUTOMATION_BYPASS_SECRET || "",
    "env.PQ_TRUTH_PROTECTION_BYPASS_SECRET|VERCEL_AUTOMATION_BYPASS_SECRET",
    { minimumBytes: 16, maximumBytes: 256 },
  );
  const domains = internalDomains(env.PQ_TRUTH_INTERNAL_DOMAINS);
  const workerLimit = integer(env.PQ_TRUTH_SHADOW_WORKER_LIMIT, "env.PQ_TRUTH_SHADOW_WORKER_LIMIT", 10, 1, 50);
  const maxWorkerRounds = integer(
    env.PQ_TRUTH_SHADOW_MAX_WORKER_ROUNDS,
    "env.PQ_TRUTH_SHADOW_MAX_WORKER_ROUNDS",
    8,
    1,
    100,
  );
  const workerLeaseSeconds = integer(
    env.PQ_TRUTH_SHADOW_WORKER_LEASE_SECONDS,
    "env.PQ_TRUTH_SHADOW_WORKER_LEASE_SECONDS",
    300,
    30,
    900,
  );
  const gmailMaxPages = integer(env.PQ_TRUTH_GMAIL_MAX_PAGES, "env.PQ_TRUTH_GMAIL_MAX_PAGES", 20, 1, 1000);
  const gmailMaxResults = integer(
    env.PQ_TRUTH_GMAIL_MAX_RESULTS,
    "env.PQ_TRUTH_GMAIL_MAX_RESULTS",
    100,
    1,
    500,
  );
  const dateOrder = text(env.PQ_TRUTH_DATE_ORDER || "MDY", "env.PQ_TRUTH_DATE_ORDER", { maximumBytes: 3 }).toUpperCase();
  if (!["MDY", "DMY"].includes(dateOrder)) throw invalid("env.PQ_TRUTH_DATE_ORDER", "must be MDY or DMY");
  const requireModelForAmbiguity = booleanFromEnv(env.PQ_TRUTH_REQUIRE_MODEL_FOR_AMBIGUITY, true);
  const maxModelConfidence = decimal(
    env.PQ_TRUTH_MODEL_MAX_CONFIDENCE,
    "env.PQ_TRUTH_MODEL_MAX_CONFIDENCE",
    DEFAULT_PROCESSING_CONFIG.maxModelConfidence,
    0,
    0.95,
  );
  if (dateOrder !== GMAIL_MODEL_PLAN_CONFIG.dateOrder
      || maxModelConfidence !== GMAIL_MODEL_PLAN_CONFIG.maxModelConfidence
      || requireModelForAmbiguity !== true) {
    throw invalid(
      "model planning configuration",
      `must equal the frozen authority ${GMAIL_MODEL_PLAN_CONFIG.dateOrder}/`
        + `${GMAIL_MODEL_PLAN_CONFIG.maxModelConfidence}/requireModelForAmbiguity=true`,
    );
  }
  const processingConfig = normalizeProcessingConfig({
    dateOrder,
    requireModelForAmbiguity,
    maxModelConfidence,
    internalDomains: domains,
  });
  if (options.modelExtractor !== undefined) {
    throw invalid(
      "modelExtractor",
      "legacy inline model extraction is retired; use the durable parent/model worker graph",
    );
  }
  const modelRuntimeEnabled = booleanFromEnv(env.PQ_TRUTH_MODEL_RUNTIME_ENABLED, false);
  const gmailIngestPaused = booleanFromEnv(env.PQ_TRUTH_CEREMONY_INGEST_PAUSED, false);
  const configuredModel = String(env.PQ_TRUTH_EXTRACTION_MODEL || "").trim();
  if (configuredModel && configuredModel !== GMAIL_MODEL_SNAPSHOT) {
    throw invalid(
      "env.PQ_TRUTH_EXTRACTION_MODEL",
      `must equal the pinned snapshot ${GMAIL_MODEL_SNAPSHOT}`,
    );
  }
  let modelProviderAdapter = null;
  let modelProviderStatus = modelRuntimeEnabled ? "missing_or_invalid_key" : "disabled";
  let attachmentModelProviderAdapter = null;
  let attachmentModelProviderStatus = modelRuntimeEnabled ? "missing_or_invalid_key" : "disabled";
  if (modelRuntimeEnabled) {
    const apiKey = modelApiKey(env.OPENAI_API_KEY);
    const fetchImpl = Object.prototype.hasOwnProperty.call(options, "fetchImpl")
      ? options.fetchImpl
      : globalThis.fetch;
    if (apiKey && typeof fetchImpl !== "function") {
      modelProviderStatus = "missing_fetch";
      attachmentModelProviderStatus = "missing_fetch";
    } else if (apiKey) {
      try {
        const adapter = factories.createOpenAIGmailModelExtractor({ apiKey, fetchImpl });
        if (modelProviderReady(adapter)) {
          modelProviderAdapter = adapter;
          modelProviderStatus = "ready";
        } else {
          modelProviderStatus = "adapter_configuration_error";
        }
      } catch {
        // Provider configuration is a model-job dependency, not authority to
        // stop Gmail attachment, TMS, tracking, operator, or audit workers.
        // The dedicated model worker records MODEL_PROVIDER_NOT_CONFIGURED on
        // its bounded source-processing lease while every other lane remains
        // reachable and source-cut completeness stays red.
        modelProviderStatus = "adapter_configuration_error";
      }
      try {
        const adapter = factories.createOpenAIGmailAttachmentModelExtractor({ apiKey, fetchImpl });
        if (modelProviderReady(adapter)) {
          attachmentModelProviderAdapter = adapter;
          attachmentModelProviderStatus = "ready";
        } else {
          attachmentModelProviderStatus = "adapter_configuration_error";
        }
      } catch {
        attachmentModelProviderStatus = "adapter_configuration_error";
      }
    }
  }
  const documentExtractor = options.documentExtractor ?? null;
  if (documentExtractor !== null && typeof documentExtractor !== "function") {
    throw invalid("documentExtractor", "must be a function or null");
  }
  const processingWatermarkConfigured = createConfiguredProcessingWatermark({
    model: GMAIL_MODEL_SNAPSHOT,
    modelProvider: "openai-responses",
    promptVersion: GMAIL_PROMPT_VERSION,
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
    processingConfig,
  });

  const gmailClient = factories.createGmailApiClient({
    env,
    connectionKey: CONNECTIONS.gmail,
    signal,
    deadlineAtMs,
  });
  const mailboxLedger = factories.createGmailMailboxLedger({
    workspaceKey,
    connectionKey: CONNECTIONS.gmail,
    syncToken,
    callRpc: callTruthRpc,
  });
  const incremental = factories.createGmailIncrementalSync({
    gmailClient,
    ledger: mailboxLedger,
    maxPages: gmailMaxPages,
    maxResults: gmailMaxResults,
  });
  const backfill = factories.createGmailMailboxBackfill({
    gmailClient,
    ledger: mailboxLedger,
    maxPages: gmailMaxPages,
    maxResults: gmailMaxResults,
  });
  if (!incremental || typeof incremental.run !== "function" || !backfill || typeof backfill.run !== "function") {
    throw invalid("gmail sync", "factories must return run-capable incremental and backfill components");
  }

  const rawStore = factories.createServerTruthRawObjectStore({
    env,
    supabaseUrl,
    serviceRoleKey,
    signal,
    deadlineAtMs,
  });
  const jobLedgers = Object.fromEntries(CLAIM_SOURCES.map((sourceSystem) => [
    sourceSystem,
    factories.createSourceProcessingJobLedger({
      workspaceKey,
      sourceSystem,
      connectionKey: CONNECTIONS[sourceSystem],
      syncToken,
      callRpc: callTruthRpc,
    }),
  ]));
  const evidenceLedger = factories.createTruthEvidenceLedger({ workspaceKey, syncToken, callRpc: callTruthRpc });
  const candidateLedger = factories.createTruthCandidateLedger({ workspaceKey, syncToken, callRpc: callTruthRpc });
  const linkLedger = factories.createTruthLinkLedger({ workspaceKey, syncToken, callRpc: callTruthRpc });

  const evidenceWorker = factories.createGmailEvidenceWorker({
    gmailClient,
    rawStore,
    jobLedger: jobLedgers.gmail,
  });
  const attachmentWorker = factories.createGmailAttachmentWorker({
    rawStore,
    jobLedger: jobLedgers.gmail,
    documentExtractor,
  });

  const linkIdentity = {
    workerId: "truth-shadow:gmail-links",
    processorVersion: PROCESSORS.gmailLink,
  };
  const linkContext = factories.createTruthWorkerContextLedger({
    workspaceKey,
    syncToken,
    ...linkIdentity,
    internalDomains: domains,
    callRpc: callTruthRpc,
  });
  const linkWorker = factories.createTruthLinkWorker({
    jobLedger: jobLedgers.gmail,
    linkLedger,
    evidenceLedger,
    loadContext: linkContext.loadLinkContext,
    ...linkIdentity,
    policyVersion: "truth-link-policy-v1",
    leaseSeconds: workerLeaseSeconds,
  });

  const claimExtractors = Object.freeze({
    gmail: factories.createGmailClaimExtractor({
      dateOrder,
      requireModelForAmbiguity,
      maxModelConfidence,
    }),
    tms: factories.createTmsClaimExtractor({ dateOrder }),
    tracking: factories.createTrackingClaimExtractor(),
    operator: factories.createOperatorClaimExtractor(),
  });

  const modelPlanLedger = factories.createTruthGmailModelPlanLedger({
    workspaceKey,
    syncToken,
    reviewToken: env.PQ_TRUTH_REVIEW_TOKEN,
    callRpc: callTruthRpc,
  });
  const gmailParentIdentity = claimWorkerIdentity("gmail");
  const gmailParentContext = factories.createTruthWorkerContextLedger({
    workspaceKey,
    syncToken,
    ...gmailParentIdentity,
    internalDomains: domains,
    callRpc: callTruthRpc,
  });
  const gmailParentCompletionWorker = factories.createTruthClaimWorker({
    jobLedger: jobLedgers.gmail,
    candidateLedger,
    evidenceLedger,
    extractor: claimExtractors.gmail,
    loadObservation: gmailParentContext.loadObservation,
    loadWorkgroupContext: gmailParentContext.loadWorkgroupContext,
    loadAcceptedClaims: gmailParentContext.loadAcceptedClaims,
    ...gmailParentIdentity,
    policyVersion: CLAIM_POLICY_VERSIONS.gmail,
    policyVersions: {
      [GMAIL_CLAIM_JOB_KIND]: CLAIM_POLICY_VERSIONS.gmail,
    },
    leaseSeconds: workerLeaseSeconds,
  });
  const gmailParentPlanningWorker = factories.createTruthGmailParentPlanningWorker({
    jobLedger: jobLedgers.gmail,
    planLedger: modelPlanLedger,
    completionWorker: gmailParentCompletionWorker,
    ...gmailParentIdentity,
    leaseSeconds: workerLeaseSeconds,
  });

  const gmailAttachmentIdentity = gmailAttachmentClaimIdentity();
  const gmailAttachmentContext = factories.createTruthWorkerContextLedger({
    workspaceKey,
    syncToken,
    ...gmailAttachmentIdentity,
    internalDomains: domains,
    callRpc: callTruthRpc,
  });
  const gmailAttachmentClaimWorker = factories.createTruthClaimWorker({
    jobLedger: fixedJobKindsLedger(jobLedgers.gmail, [GMAIL_ATTACHMENT_CLAIM_JOB_KIND]),
    candidateLedger,
    evidenceLedger,
    extractor: claimExtractors.gmail,
    loadObservation: gmailAttachmentContext.loadObservation,
    loadWorkgroupContext: gmailAttachmentContext.loadWorkgroupContext,
    loadAcceptedClaims: gmailAttachmentContext.loadAcceptedClaims,
    ...gmailAttachmentIdentity,
    policyVersion: CLAIM_POLICY_VERSIONS.gmail,
    policyVersions: {
      [GMAIL_ATTACHMENT_CLAIM_JOB_KIND]: CLAIM_POLICY_VERSIONS.gmail,
    },
    leaseSeconds: workerLeaseSeconds,
  });

  const attachmentModelIdentity = gmailAttachmentModelIdentity();
  const attachmentModelWorkers = [];
  if (attachmentModelProviderAdapter) {
    const attachmentModelLedger = factories.createTruthGmailAttachmentModelLedger({
      workspaceKey,
      syncToken,
      reviewToken: env.PQ_TRUTH_REVIEW_TOKEN,
      ...attachmentModelIdentity,
      callRpc: callTruthRpc,
    });
    const attachmentModelWorker = factories.createTruthGmailAttachmentModelWorker({
      jobLedger: fixedJobKindsLedger(jobLedgers.gmail, [GMAIL_ATTACHMENT_MODEL_JOB_KIND]),
      modelLedger: attachmentModelLedger,
      rawStore,
      providerAdapter: attachmentModelProviderAdapter,
      ...attachmentModelIdentity,
      leaseSeconds: workerLeaseSeconds,
      retryAfterSeconds: 5,
    });
    attachmentModelWorkers.push(
      workerAdapter("gmail-attachment-model", attachmentModelWorker, "runOnce"),
    );
  }

  const modelIdentity = gmailModelClaimIdentity();
  const modelRequestLedger = factories.createTruthModelRequestLedger({
    workspaceKey,
    syncToken,
    ...modelIdentity,
    callRpc: callTruthRpc,
  });
  const gmailModelClaimWorker = factories.createTruthModelExtractionWorker({
    jobLedger: jobLedgers.gmail,
    planLedger: modelPlanLedger,
    modelRequestLedger,
    providerAdapter: modelProviderAdapter,
    runtimeEnabled: modelRuntimeEnabled,
    ...modelIdentity,
    leaseSeconds: workerLeaseSeconds,
  });

  const claimWorkers = CLAIM_SOURCES.filter((sourceSystem) => sourceSystem !== "gmail").map((sourceSystem) => {
    const identity = claimWorkerIdentity(sourceSystem);
    const context = factories.createTruthWorkerContextLedger({
      workspaceKey,
      syncToken,
      ...identity,
      internalDomains: domains,
      callRpc: callTruthRpc,
    });
    const worker = factories.createTruthClaimWorker({
      jobLedger: jobLedgers[sourceSystem],
      candidateLedger,
      evidenceLedger,
      extractor: claimExtractors.gmail,
      extractors: {
        [SOURCE_CLAIM_JOB_KINDS[sourceSystem]]: claimExtractors[sourceSystem],
      },
      loadObservation: context.loadObservation,
      loadWorkgroupContext: context.loadWorkgroupContext,
      loadAcceptedClaims: context.loadAcceptedClaims,
      ...identity,
      policyVersion: CLAIM_POLICY_VERSIONS.gmail,
      policyVersions: {
        [SOURCE_CLAIM_JOB_KINDS[sourceSystem]]: CLAIM_POLICY_VERSIONS[sourceSystem],
      },
      leaseSeconds: workerLeaseSeconds,
    });
    return workerAdapter(`${sourceSystem}-claims`, worker, "runOnce");
  });

  const productionPublishEnabled = booleanFromEnv(env.PQ_TRUTH_PRODUCTION_PUBLISH_ENABLED, false);
  const productionApprovalIssuerToken = typeof env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN === "string"
    && env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN.trim() === env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN
    && Buffer.byteLength(env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN, "utf8") >= 32
    ? env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN
    : null;
  const productionPublicationAllowed = productionPublishEnabled && Boolean(productionApprovalIssuerToken);
  const sourceCutLedger = productionPublicationAllowed
    ? factories.createTruthProductionSourceCutCoordinator({ workspaceKey, syncToken, callRpc: callTruthRpc })
    : factories.createTruthSourceCutLedger({ workspaceKey, syncToken, callRpc: callTruthRpc });
  const buildLedger = factories.createTruthBuildLedger({ workspaceKey, syncToken, callRpc: callTruthRpc });
  const auditLedger = factories.createTruthAuditLedger({
    workspaceKey,
    auditToken,
    supabaseUrl,
    apiKey: anonKey,
    signal,
    deadlineAtMs,
  });
  const auditRunner = factories.createRelationalTruthAuditRunner({
    ledger: auditLedger,
    productionOrigin,
    productionWitnessToken,
    productionProtectionBypassSecret,
    allowedProductionOrigins: [productionOrigin],
    expectedIntervalSeconds: 300,
    requireRelationalWitness: false,
    signal,
  });

  const build = Object.freeze({
    async run(input = {}) {
      if (!isPlainObject(input)
          || input.buildChannel !== "shadow"
          || input.publicationChannel !== "shadow"
          || input.productionConfirmation !== null) {
        throw new HostedTruthShadowRuntimeError("Hosted shadow build attempted to escape the shadow channel", {
          code: "HOSTED_TRUTH_SHADOW_PRODUCTION_PUBLICATION_FORBIDDEN",
        });
      }
      const shadowReceipt = await factories.runRelationalTruthBuild({
        ledger: buildLedger,
        workerId: "truth-shadow:build",
        sourceCutId: input.sourceCutId,
        buildChannel: "shadow",
        triggerName: input.triggerName,
        idempotencyKey: input.idempotencyKey,
        model: GMAIL_MODEL_SNAPSHOT,
        modelProvider: "openai-responses",
        promptVersion: GMAIL_PROMPT_VERSION,
        processingConfig,
        processingWatermarkConfigured,
        publication: {
          publicationRequestKey: `shadow-publication:${input.sourceCutId}`,
          publicationReason: "normal",
          publisherVersion: PROCESSORS.build,
          publishedBy: "truth-shadow:build",
          allowProduction: false,
        },
        signal: input.signal || signal,
        deadlineAtMs: input.deadlineAtMs,
      });
      if (!productionPublishEnabled) return shadowReceipt;
      if (!productionApprovalIssuerToken) {
        return Object.freeze({
          ...shadowReceipt,
          productionPublicationAttempted: false,
          production: Object.freeze({
            status: "refused",
            code: "HOSTED_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN_REQUIRED",
          }),
        });
      }
      try {
        const currentProductionHead = await buildLedger.readHead({ channel: "production" });
        if (currentProductionHead.found === true && currentProductionHead.sourceCutId === input.sourceCutId) {
          return Object.freeze({
            ...shadowReceipt,
            productionPublicationAttempted: false,
            production: Object.freeze({
              status: "succeeded",
              recovered: true,
              alreadyCurrent: true,
              publication: currentProductionHead,
            }),
          });
        }
      } catch (error) {
        return Object.freeze({
          ...shadowReceipt,
          productionPublicationAttempted: false,
          production: Object.freeze({
            status: "failed",
            code: String(error?.code || "HOSTED_TRUTH_PRODUCTION_HEAD_READ_FAILED")
              .toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80),
            retryable: error?.retryable === true,
          }),
        });
      }
      const publicationRequestKey = `production-publication:${input.sourceCutId}`;
      let productionReceipt;
      try {
        productionReceipt = await factories.runRelationalTruthBuild({
          ledger: buildLedger,
          workerId: "truth-production:build",
          sourceCutId: input.sourceCutId,
          buildChannel: "candidate",
          triggerName: input.triggerName,
          idempotencyKey: `candidate:${input.sourceCutId}`,
          model: GMAIL_MODEL_SNAPSHOT,
          modelProvider: "openai-responses",
          promptVersion: GMAIL_PROMPT_VERSION,
          processingConfig,
          processingWatermarkConfigured,
          publication: {
            publicationRequestKey,
            publicationReason: "normal",
            publisherVersion: PROCESSORS.build,
            publishedBy: "truth-production:build",
            issueProductionApproval: async (authority) => {
              const credential = crypto.randomBytes(32).toString("base64url");
              const approval = await buildLedger.issueProductionApproval({
                buildPairId: authority.pair.buildPairId,
                approvalRequestKey: `hosted-production:${input.sourceCutId}:${crypto.randomUUID()}`,
                publicationRequestKey: authority.publicationRequestKey,
                expectedHeadVersion: authority.expectedHeadVersion,
                expectedHeadPacketHash: authority.expectedHeadPacketHash,
                publicationReason: authority.publicationReason,
                publisherVersion: authority.publisherVersion,
                publishedBy: authority.publishedBy,
                approvedBy: "hosted-truth-production-runtime",
                approvalReason: "env-gated compressed cutover publication",
                expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                credential,
                issuerToken: productionApprovalIssuerToken,
              });
              return { approvalId: approval.approvalId, credential };
            },
          },
          signal: input.signal || signal,
          deadlineAtMs: input.deadlineAtMs,
        });
      } catch (error) {
        productionReceipt = Object.freeze({
          status: "failed",
          code: String(error?.code || "HOSTED_TRUTH_PRODUCTION_PUBLICATION_FAILED")
            .toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80),
          retryable: error?.retryable === true,
          outcomeUnknown: error?.outcomeUnknown === true,
        });
      }
      return Object.freeze({
        ...shadowReceipt,
        productionPublicationAttempted: true,
        production: productionReceipt,
      });
    },
  });

  // Claims-readiness spine (checkpoint -> link-epoch open -> seal) runs first
  // each round so gated link/claim jobs unlock within the same tick. Default
  // OFF until the spine migration installs read_gmail_claims_readiness_frontier
  // and the gap-aware checkpoint boundary; flipping the flag is the enablement.
  const claimsReadinessEnabled = booleanFromEnv(env.PQ_TRUTH_CLAIMS_READINESS_ENABLED, false);
  const claimsReadinessWorkers = claimsReadinessEnabled
    ? [workerAdapter("gmail-claims-readiness", createGmailClaimsReadinessCoordinator({
        workspaceKey,
        connectionKey: CONNECTIONS.gmail,
        syncToken,
        callRpc: callTruthRpc,
      }), "runOnce")]
    : [];

  // Hosted acceptance coordinator: runs sealed candidate frontiers through the
  // canonical acceptance epoch. Default OFF until the acceptance-frontier
  // migration installs read_gmail_acceptance_readiness_frontier.
  const acceptanceReadinessEnabled = booleanFromEnv(env.PQ_TRUTH_ACCEPTANCE_COORDINATOR_ENABLED, false);
  const acceptanceReadinessWorkers = acceptanceReadinessEnabled
    ? [workerAdapter("gmail-acceptance-readiness", createGmailAcceptanceReadinessCoordinator({
        workspaceKey,
        connectionKey: CONNECTIONS.gmail,
        syncToken,
        callRpc: callTruthRpc,
      }), "runOnce")]
    : [];
  const genericAcceptanceReadinessWorkers = acceptanceReadinessEnabled
    ? [workerAdapter("generic-acceptance-readiness", createGenericAcceptanceReadinessCoordinator({
        workspaceKey,
        syncToken,
        callRpc: callTruthRpc,
      }), "runOnce")]
    : [];

  const workers = [
    ...claimsReadinessWorkers,
    ...acceptanceReadinessWorkers,
    ...genericAcceptanceReadinessWorkers,
    workerAdapter("gmail-evidence", evidenceWorker, "run", {
      workerId: "truth-shadow:gmail-evidence",
      processorVersion: PROCESSORS.gmailEvidence,
      leaseSeconds: workerLeaseSeconds,
    }),
    workerAdapter("gmail-attachments", attachmentWorker, "run", {
      workerId: "truth-shadow:gmail-attachments",
      processorVersion: PROCESSORS.gmailAttachment,
      leaseSeconds: workerLeaseSeconds,
    }),
    workerAdapter("gmail-links", linkWorker, "runOnce"),
    workerAdapter("gmail-parent-plans", gmailParentPlanningWorker, "runOnce"),
    workerAdapter("gmail-model-claims", gmailModelClaimWorker, "runOnce"),
    ...attachmentModelWorkers,
    workerAdapter("gmail-attachment-claims", gmailAttachmentClaimWorker, "runOnce"),
    ...claimWorkers,
  ];

  const orchestrator = factories.createTruthShadowOrchestrator({
    workspaceKey,
    gmail: {
      runIncremental: (input) => gmailIngestPaused
        ? Promise.resolve(ceremonyPausedGmailSyncReceipt("incremental"))
        : incremental.run(input),
      runBackfill: (input) => gmailIngestPaused
        ? Promise.resolve(ceremonyPausedGmailSyncReceipt("backfill"))
        : backfill.run(input),
    },
    workers,
    sourceCut: sourceCutLedger,
    build,
    audit: auditRunner,
    workerLimit,
    maxWorkerRounds,
  });
  if (!orchestrator || typeof orchestrator.run !== "function") {
    throw invalid("orchestrator", "factory must return an object exposing run()");
  }

  return Object.freeze({
    runtimeVersion: RUNTIME_VERSION,
    workspaceKey,
    configuration: Object.freeze({
      connections: CONNECTIONS,
      internalDomains: domains,
      workerLimit,
      maxWorkerRounds,
      gmailMaxPages,
      gmailMaxResults,
      dateOrder,
      requireModelForAmbiguity,
      maxModelConfidence,
      modelConfigured: Boolean(modelProviderAdapter),
      modelRuntimeEnabled,
      gmailIngestPaused,
      modelProviderStatus,
      attachmentModelConfigured: Boolean(attachmentModelProviderAdapter),
      attachmentModelProviderStatus,
      modelSnapshot: GMAIL_MODEL_SNAPSHOT,
      modelPromptVersion: GMAIL_PROMPT_VERSION,
      modelExecutionAuthority: "sealed_request_budget_and_dispatch",
      documentExtractorConfigured: Boolean(documentExtractor),
      productionPublicationAllowed,
    }),
    run(input = {}) {
      const runDeadlineAtMs = input.deadlineAtMs ?? deadlineAtMs;
      throwIfAborted(signal, {
        stage: "hosted truth-shadow runtime",
        deadlineAtMs: runDeadlineAtMs,
      });
      return orchestrator.run({
        ...input,
        signal: input.signal || signal,
        deadlineAtMs: runDeadlineAtMs,
      });
    },
  });
}

module.exports = Object.freeze({
  CONNECTIONS,
  CLAIM_POLICY_VERSIONS,
  SOURCE_CLAIM_JOB_KINDS,
  DEFAULT_INTERNAL_DOMAINS,
  HostedTruthShadowRuntimeError,
  PROCESSORS,
  RUNTIME_VERSION,
  WORKSPACE_KEY,
  createHostedTruthShadowRuntime,
  _test: Object.freeze({
    booleanFromEnv,
    ceremonyPausedGmailSyncReceipt,
    claimWorkerIdentity,
    decimal,
    fixedJobKindsLedger,
    gmailAttachmentClaimIdentity,
    gmailAttachmentModelIdentity,
    gmailModelClaimIdentity,
    integer,
    internalDomains,
    modelApiKey,
    modelProviderReady,
    workerAdapter,
  }),
});

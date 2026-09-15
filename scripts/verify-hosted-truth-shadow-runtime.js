#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  CONFIGURED_KEYS,
} = require("../lib/truth-processing-watermark");
const { PROMPT_VERSION: GMAIL_PROMPT_VERSION } = require("../lib/gmail-claim-extractor");
const { PINNED_MODEL: GMAIL_MODEL_SNAPSHOT } = require("../lib/openai-gmail-model-extractor");
const { ATTACHMENT_JOB_KIND: GMAIL_ATTACHMENT_CLAIM_JOB_KIND } = require("../lib/truth-claim-worker");
const {
  CLAIM_POLICY_VERSIONS,
  CONNECTIONS,
  SOURCE_CLAIM_JOB_KINDS,
  RUNTIME_VERSION,
  createHostedTruthShadowRuntime,
} = require("../lib/hosted-truth-shadow-runtime");

const CUT_ID = `cut:v1:${"a".repeat(64)}`;

function testEnv(overrides = {}) {
  return {
    PQ_SUPABASE_SYNC_TOKEN: "sync-token-at-least-sixteen-bytes",
    PQ_TRUTH_AUDIT_TOKEN: "audit-token-at-least-sixteen-bytes",
    PQ_SUPABASE_URL: "https://example.supabase.co",
    PQ_SUPABASE_SERVICE_ROLE_KEY: "service-role-key-at-least-sixteen-bytes",
    PQ_SUPABASE_ANON_KEY: "anon-key-at-least-sixteen-bytes",
    PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN: "https://pq-ops-demo.example",
    PQ_TRUTH_PRODUCTION_WITNESS_TOKEN: "production_witness_token_for_shadow_tests_12345",
    PQ_TRUTH_PROTECTION_BYPASS_SECRET: "vercel_protection_bypass_for_shadow_tests",
    ...overrides,
  };
}

function harness() {
  const calls = [];
  let orchestratorOptions = null;
  const factories = {
    createGmailApiClient(options) {
      calls.push(["gmail-client", options]);
      return { kind: "gmail-client" };
    },
    createGmailMailboxLedger(options) {
      calls.push(["mailbox-ledger", options]);
      return { kind: "mailbox-ledger" };
    },
    createGmailIncrementalSync(options) {
      calls.push(["incremental", options]);
      return { async run(input) { calls.push(["incremental.run", input]); return { status: "committed" }; } };
    },
    createGmailMailboxBackfill(options) {
      calls.push(["backfill", options]);
      return { async run(input) { calls.push(["backfill.run", input]); return { status: "committed" }; } };
    },
    createServerTruthRawObjectStore(options) {
      calls.push(["raw-store", options]);
      return { kind: "raw-store" };
    },
    createSourceProcessingJobLedger(options) {
      calls.push(["job-ledger", options]);
      return {
        scope: options,
        async claimJobs(input) { calls.push([`job-ledger.claim:${options.sourceSystem}`, input]); return { jobs: [] }; },
        async renewJob(input) { calls.push([`job-ledger.renew:${options.sourceSystem}`, input]); return { ok: true }; },
        async completeJob(input) { calls.push([`job-ledger.complete:${options.sourceSystem}`, input]); return { ok: true }; },
        async failJob(input) { calls.push([`job-ledger.fail:${options.sourceSystem}`, input]); return { ok: true }; },
      };
    },
    createTruthEvidenceLedger(options) {
      calls.push(["evidence-ledger", options]);
      return {};
    },
    createTruthCandidateLedger(options) {
      calls.push(["candidate-ledger", options]);
      return {};
    },
    createTruthLinkLedger(options) {
      calls.push(["link-ledger", options]);
      return {};
    },
    createGmailEvidenceWorker(options) {
      calls.push(["evidence-worker", options]);
      return { async run(input) { calls.push(["evidence-worker.run", input]); return emptyWorkerReceipt(); } };
    },
    createGmailAttachmentWorker(options) {
      calls.push(["attachment-worker", options]);
      return { async run(input) { calls.push(["attachment-worker.run", input]); return emptyWorkerReceipt(); } };
    },
    createTruthWorkerContextLedger(options) {
      calls.push(["context-ledger", options]);
      return {
        loadObservation: async () => ({}),
        loadWorkgroupContext: async () => null,
        loadAcceptedClaims: async () => [],
        loadLinkContext: async () => ({}),
      };
    },
    createTruthLinkWorker(options) {
      calls.push(["link-worker", options]);
      return { async runOnce(input) { calls.push(["link-worker.run", input]); return emptyWorkerReceipt(); } };
    },
    createOpenAIGmailModelExtractor(options) {
      calls.push(["model-provider", options]);
      return {
        prepareRequest() { throw new Error("hosted composition verifier must not prepare a provider request"); },
        async executeAuthorizedAttempt() {
          throw new Error("hosted composition verifier must not call the provider");
        },
      };
    },
    createOpenAIGmailAttachmentModelExtractor(options) {
      calls.push(["attachment-model-provider", options]);
      return {
        prepareRequest() {
          throw new Error("hosted composition verifier must not prepare an attachment request");
        },
        async executeAuthorizedAttempt() {
          throw new Error("hosted composition verifier must not call the attachment provider");
        },
      };
    },
    createGmailClaimExtractor(options) {
      calls.push(["gmail-extractor", options]);
      return { sourceSystem: "gmail", extract: async () => [] };
    },
    createTmsClaimExtractor(options) {
      calls.push(["tms-extractor", options]);
      return { sourceSystem: "tms", extract: async () => [] };
    },
    createTrackingClaimExtractor(options) {
      calls.push(["tracking-extractor", options]);
      return { sourceSystem: "tracking", extract: async () => [] };
    },
    createOperatorClaimExtractor(options) {
      calls.push(["operator-extractor", options]);
      return { sourceSystem: "operator", extract: async () => [] };
    },
    createTruthClaimWorker(options) {
      calls.push(["claim-worker", options]);
      return {
        workerId: options.workerId,
        processorVersion: options.processorVersion,
        async processJob(input) {
          calls.push([`claim-worker.process:${options.workerId}`, input]);
          return { ok: true, jobId: input.jobId, result: { candidateCount: 0 } };
        },
        async runOnce(input) {
          calls.push([`claim-worker.run:${options.workerId}`, input]);
          return emptyWorkerReceipt();
        },
      };
    },
    createTruthGmailModelPlanLedger(options) {
      calls.push(["model-plan-ledger", options]);
      return { kind: "model-plan-ledger" };
    },
    createTruthGmailParentPlanningWorker(options) {
      calls.push(["parent-planner", options]);
      return {
        async runOnce(input) {
          calls.push(["parent-planner.run", input]);
          return emptyWorkerReceipt();
        },
      };
    },
    createTruthGmailAttachmentModelLedger(options) {
      calls.push(["attachment-model-ledger", options]);
      return { kind: "attachment-model-ledger" };
    },
    createTruthGmailAttachmentModelWorker(options) {
      calls.push(["attachment-model-worker", options]);
      return {
        async runOnce(input) {
          calls.push(["attachment-model-worker.run", input]);
          return emptyWorkerReceipt();
        },
      };
    },
    createTruthModelRequestLedger(options) {
      calls.push(["model-request-ledger", options]);
      return { kind: "model-request-ledger" };
    },
    createTruthModelExtractionWorker(options) {
      calls.push(["model-worker", options]);
      return {
        async runOnce(input) {
          calls.push(["model-worker.run", input]);
          if (options.runtimeEnabled === true && options.providerAdapter === null) {
            return {
              ok: false,
              claimedCount: 1,
              succeededCount: 0,
              failedCount: 1,
              retryScheduledCount: 1,
              jobs: [{
                ok: false,
                outcome: "local_configuration_pending",
                reasonCode: "MODEL_PROVIDER_NOT_CONFIGURED",
              }],
            };
          }
          return emptyWorkerReceipt();
        },
      };
    },
    createTruthSourceCutLedger(options) {
      calls.push(["source-cut-ledger", options]);
      return { sealCurrent: async () => ({}) };
    },
    createTruthProductionSourceCutCoordinator(options) {
      calls.push(["production-source-cut-coordinator", options]);
      return { sealCurrent: async () => ({}) };
    },
    createTruthBuildLedger(options) {
      calls.push(["build-ledger", options]);
      return {
        kind: "build-ledger",
        async issueProductionApproval(input) {
          calls.push(["build-ledger.issue-production-approval", input]);
          return { approvalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
        },
        async readHead(input) {
          calls.push(["build-ledger.read-head", input]);
          return { ok: true, found: false, sourceCutId: null };
        },
      };
    },
    createTruthAuditLedger(options) {
      calls.push(["audit-ledger", options]);
      return { kind: "audit-ledger" };
    },
    createRelationalTruthAuditRunner(options) {
      calls.push(["audit-runner", options]);
      return { run: async () => ({}) };
    },
    async runRelationalTruthBuild(options) {
      calls.push(["relational-build.run", options]);
      if (options.buildChannel === "candidate") {
        const approval = await options.publication.issueProductionApproval({
          pair: { buildPairId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          expectedHeadVersion: 3,
          expectedHeadPacketHash: "b".repeat(64),
          publicationRequestKey: options.publication.publicationRequestKey,
          publicationReason: options.publication.publicationReason,
          publisherVersion: options.publication.publisherVersion,
          publishedBy: options.publication.publishedBy,
        });
        calls.push(["relational-build.production-approval", approval]);
        return { status: "succeeded", publication: { channel: "production" } };
      }
      return { status: "succeeded", publication: { channel: "shadow" } };
    },
    createTruthShadowOrchestrator(options) {
      calls.push(["orchestrator", options]);
      orchestratorOptions = options;
      return {
        async run(input) {
          calls.push(["orchestrator.run", input]);
          return { ok: true, status: "succeeded", mutatesOperationalState: false };
        },
      };
    },
  };
  return { calls, factories, getOrchestratorOptions: () => orchestratorOptions };
}

function emptyWorkerReceipt() {
  return { ok: true, claimedCount: 0, succeededCount: 0, failedCount: 0 };
}

async function main() {
  const h = harness();
  const env = testEnv({
    PQ_TRUTH_INTERNAL_DOMAINS: "partner-116.example,internal.partner-116.example,partner-116.example",
    PQ_TRUTH_DATE_ORDER: "MDY",
    PQ_TRUTH_REQUIRE_MODEL_FOR_AMBIGUITY: "true",
    PQ_TRUTH_MODEL_MAX_CONFIDENCE: "0.9",
    PQ_TRUTH_SHADOW_WORKER_LIMIT: "7",
    PQ_TRUTH_SHADOW_MAX_WORKER_ROUNDS: "9",
    PQ_TRUTH_GMAIL_MAX_PAGES: "25",
    PQ_TRUTH_GMAIL_MAX_RESULTS: "200",
  });
  const runtime = createHostedTruthShadowRuntime({ env, factories: h.factories });
  assert.equal(runtime.runtimeVersion, RUNTIME_VERSION);
  assert.equal(runtime.workspaceKey, "primary");
  assert.deepEqual(runtime.configuration.connections, CONNECTIONS);
  assert.deepEqual(runtime.configuration.internalDomains, ["internal.partner-116.example", "partner-116.example"]);
  assert.equal(runtime.configuration.workerLimit, 7);
  assert.equal(runtime.configuration.maxWorkerRounds, 9);
  assert.equal(runtime.configuration.gmailMaxPages, 25);
  assert.equal(runtime.configuration.gmailMaxResults, 200);
  assert.equal(runtime.configuration.dateOrder, "MDY");
  assert.equal(runtime.configuration.requireModelForAmbiguity, true);
  assert.equal(runtime.configuration.maxModelConfidence, 0.9);
  assert.equal(runtime.configuration.modelConfigured, false);
  assert.equal(runtime.configuration.modelRuntimeEnabled, false);
  assert.equal(runtime.configuration.gmailIngestPaused, false);
  assert.equal(runtime.configuration.modelProviderStatus, "disabled");
  assert.equal(runtime.configuration.attachmentModelConfigured, false);
  assert.equal(runtime.configuration.attachmentModelProviderStatus, "disabled");
  assert.equal(runtime.configuration.modelSnapshot, GMAIL_MODEL_SNAPSHOT);
  assert.equal(runtime.configuration.modelPromptVersion, GMAIL_PROMPT_VERSION);
  assert.equal(runtime.configuration.modelExecutionAuthority, "sealed_request_budget_and_dispatch");
  assert.equal(runtime.configuration.documentExtractorConfigured, false);
  assert.equal(runtime.configuration.productionPublicationAllowed, false);
  const serializedConfiguration = JSON.stringify(runtime.configuration);
  for (const secret of [
    env.PQ_SUPABASE_SYNC_TOKEN,
    env.PQ_TRUTH_AUDIT_TOKEN,
    env.PQ_SUPABASE_SERVICE_ROLE_KEY,
    env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN,
    env.PQ_TRUTH_PROTECTION_BYPASS_SECRET,
  ]) {
    assert.equal(serializedConfiguration.includes(secret), false, "runtime configuration must not expose secrets");
  }

  const jobScopes = h.calls.filter(([name]) => name === "job-ledger").map(([, options]) => ({
    sourceSystem: options.sourceSystem,
    connectionKey: options.connectionKey,
  }));
  assert.deepEqual(jobScopes, Object.entries(CONNECTIONS).map(([sourceSystem, connectionKey]) => ({
    sourceSystem,
    connectionKey,
  })));
  const orchestrator = h.getOrchestratorOptions();
  assert.equal(orchestrator.workerLimit, 7);
  assert.equal(orchestrator.maxWorkerRounds, 9);
  const ordinarySync = await orchestrator.gmail.runIncremental({ ownerId: "ordinary-sync" });
  assert.equal(ordinarySync.status, "committed");
  assert.ok(h.calls.some(([name]) => name === "incremental.run"));
  const auditRunnerOptions = h.calls.find(([name]) => name === "audit-runner")[1];
  assert.equal(auditRunnerOptions.productionWitnessToken, env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN);
  assert.equal(
    auditRunnerOptions.productionProtectionBypassSecret,
    env.PQ_TRUTH_PROTECTION_BYPASS_SECRET,
  );
  assert.deepEqual(orchestrator.workers.map((worker) => worker.name), [
    "gmail-evidence",
    "gmail-attachments",
    "gmail-links",
    "gmail-parent-plans",
    "gmail-model-claims",
    "gmail-attachment-claims",
    "tms-claims",
    "tracking-claims",
    "operator-claims",
  ]);

  const pausedHarness = harness();
  const pausedRuntime = createHostedTruthShadowRuntime({
    env: testEnv({ PQ_TRUTH_CEREMONY_INGEST_PAUSED: "1" }),
    factories: pausedHarness.factories,
  });
  assert.equal(pausedRuntime.configuration.gmailIngestPaused, true);
  const pausedOrchestrator = pausedHarness.getOrchestratorOptions();
  const pausedIncremental = await pausedOrchestrator.gmail.runIncremental({ ownerId: "paused" });
  const pausedBackfill = await pausedOrchestrator.gmail.runBackfill({ ownerId: "paused" });
  for (const [mode, receipt] of [
    ["incremental", pausedIncremental],
    ["backfill", pausedBackfill],
  ]) {
    assert.deepEqual(receipt, {
      status: "no_changes",
      mode,
      reasonCode: "TRUTH_CEREMONY_GMAIL_INGEST_PAUSED",
      sourceCursorMutated: false,
      sourceBatchCreated: false,
      productionPublicationAttempted: false,
      mutatesOperationalState: false,
    });
  }
  assert.equal(
    pausedHarness.calls.some(([name]) => name === "incremental.run" || name === "backfill.run"),
    false,
    "ceremony pause must not call Gmail ingestion",
  );
  assert.deepEqual(
    pausedOrchestrator.workers.map((worker) => worker.name),
    orchestrator.workers.map((worker) => worker.name),
    "ceremony pause must preserve every worker",
  );
  const gmailExtractorOptions = h.calls.find(([name]) => name === "gmail-extractor")[1];
  assert.equal(gmailExtractorOptions.dateOrder, "MDY");
  assert.equal(gmailExtractorOptions.requireModelForAmbiguity, true);
  assert.equal(gmailExtractorOptions.maxModelConfidence, 0.9);
  assert.equal(Object.prototype.hasOwnProperty.call(gmailExtractorOptions, "modelExtractor"), false);
  await Promise.all(orchestrator.workers.map((worker) => worker.runOnce({ limit: 4 })));
  assert.equal(h.calls.find(([name]) => name === "evidence-worker.run")[1].workerId, "truth-shadow:gmail-evidence");
  assert.equal(h.calls.find(([name]) => name === "attachment-worker.run")[1].limit, 4);
  assert.equal(h.calls.find(([name]) => name === "link-worker.run")[1].limit, 4);
  assert.equal(h.calls.find(([name]) => name === "parent-planner.run")[1].limit, 4);
  assert.equal(h.calls.find(([name]) => name === "model-worker.run")[1].limit, 4);
  assert.equal(
    h.calls.find(([name]) => name === "claim-worker.run:truth-shadow:gmail-attachment-claims")[1].limit,
    4,
  );
  const parentPlannerOptions = h.calls.find(([name]) => name === "parent-planner")[1];
  assert.equal(parentPlannerOptions.workerId, "truth-shadow:gmail-claims");
  assert.equal(parentPlannerOptions.completionWorker.workerId, "truth-shadow:gmail-claims");
  assert.equal(parentPlannerOptions.jobLedger.scope.sourceSystem, "gmail");
  const modelWorkerOptions = h.calls.find(([name]) => name === "model-worker")[1];
  assert.equal(modelWorkerOptions.workerId, "truth-shadow:gmail-model-claims");
  assert.equal(modelWorkerOptions.runtimeEnabled, false);
  assert.equal(modelWorkerOptions.providerAdapter, null);
  assert.equal(modelWorkerOptions.planLedger, parentPlannerOptions.planLedger);
  const attachmentClaimOptions = h.calls
    .filter(([name]) => name === "claim-worker")
    .map(([, options]) => options)
    .find((options) => options.workerId === "truth-shadow:gmail-attachment-claims");
  await attachmentClaimOptions.jobLedger.claimJobs({ jobKinds: ["gmail_extract_message_claims"] });
  assert.deepEqual(
    h.calls.find(([name]) => name === "job-ledger.claim:gmail")[1].jobKinds,
    [GMAIL_ATTACHMENT_CLAIM_JOB_KIND],
    "the attachment claim worker cannot steal a deterministic Gmail parent",
  );
  for (const sourceSystem of ["tms", "tracking", "operator"]) {
    assert.equal(
      h.calls.find(([name]) => name === `claim-worker.run:truth-shadow:${sourceSystem}-claims`)[1].limit,
      4,
    );
    const workerOptions = h.calls
      .filter(([name]) => name === "claim-worker")
      .map(([, options]) => options)
      .find((options) => options.workerId === `truth-shadow:${sourceSystem}-claims`);
    const jobKind = SOURCE_CLAIM_JOB_KINDS[sourceSystem];
    assert.equal(workerOptions.extractor.sourceSystem, "gmail");
    assert.equal(workerOptions.extractors[jobKind].sourceSystem, sourceSystem);
    assert.equal(workerOptions.policyVersion, CLAIM_POLICY_VERSIONS.gmail);
    assert.equal(workerOptions.policyVersions[jobKind], CLAIM_POLICY_VERSIONS[sourceSystem]);
  }

  await assert.rejects(
    () => orchestrator.build.run({
      sourceCutId: CUT_ID,
      buildChannel: "candidate",
      publicationChannel: "production",
      productionConfirmation: "publish",
    }),
    /escape the shadow channel/,
  );
  const buildResult = await orchestrator.build.run({
    sourceCutId: CUT_ID,
    buildChannel: "shadow",
    publicationChannel: "shadow",
    idempotencyKey: `shadow:${CUT_ID}`,
    triggerName: RUNTIME_VERSION,
    publicationReason: "continuous comparison",
    productionConfirmation: null,
  });
  assert.equal(buildResult.publication.channel, "shadow");
  const buildCall = h.calls.find(([name]) => name === "relational-build.run")[1];
  assert.equal(buildCall.buildChannel, "shadow");
  assert.equal(buildCall.publication.allowProduction, false);
  assert.equal(buildCall.publication.publicationRequestKey, `shadow-publication:${CUT_ID}`);
  assert.equal(buildCall.publication.publicationReason, "normal");
  assert.equal(buildCall.publication.publishedBy, "truth-shadow:build");
  assert.equal(buildCall.model, GMAIL_MODEL_SNAPSHOT);
  assert.equal(buildCall.modelProvider, "openai-responses");
  assert.equal(buildCall.promptVersion, GMAIL_PROMPT_VERSION);
  assert.deepEqual(
    Object.keys(buildCall.processingWatermarkConfigured).sort(),
    [...CONFIGURED_KEYS].sort(),
  );
  assert.equal(
    buildCall.processingWatermarkConfigured.model,
    GMAIL_MODEL_SNAPSHOT,
  );
  assert.equal(
    buildCall.processingWatermarkConfigured.promptVersion,
    GMAIL_PROMPT_VERSION,
  );
  assert.equal(
    buildCall.processingWatermarkConfigured.configSnapshotVersion,
    `truth-processing-config-snapshot:v1:${buildCall.processingWatermarkConfigured.configSnapshotHash}`,
  );
  assert.deepEqual(buildCall.processingConfig, {
    dateOrder: "MDY",
    requireModelForAmbiguity: true,
    maxModelConfidence: 0.9,
    internalDomains: ["internal.partner-116.example", "partner-116.example"],
  });

  const missingIssuerHarness = harness();
  const missingIssuerRuntime = createHostedTruthShadowRuntime({
    env: testEnv({ PQ_TRUTH_PRODUCTION_PUBLISH_ENABLED: "1" }),
    factories: missingIssuerHarness.factories,
  });
  assert.equal(missingIssuerRuntime.configuration.productionPublicationAllowed, false);
  const missingIssuerResult = await missingIssuerHarness.getOrchestratorOptions().build.run({
    sourceCutId: CUT_ID,
    buildChannel: "shadow",
    publicationChannel: "shadow",
    idempotencyKey: `shadow:${CUT_ID}`,
    triggerName: RUNTIME_VERSION,
    publicationReason: "continuous comparison",
    productionConfirmation: null,
  });
  assert.equal(missingIssuerResult.production.status, "refused");
  assert.equal(missingIssuerResult.production.code, "HOSTED_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN_REQUIRED");
  assert.equal(missingIssuerResult.productionPublicationAttempted, false);
  assert.equal(
    missingIssuerHarness.calls.filter(([name]) => name === "relational-build.run").length,
    1,
    "missing production authority must not alter the completed shadow invocation",
  );

  const productionHarness = harness();
  const productionRuntime = createHostedTruthShadowRuntime({
    env: testEnv({
      PQ_TRUTH_PRODUCTION_PUBLISH_ENABLED: "1",
      PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN: "issuer-token-at-least-thirty-two-bytes-long",
    }),
    factories: productionHarness.factories,
  });
  assert.equal(productionRuntime.configuration.productionPublicationAllowed, true);
  assert.ok(productionHarness.calls.some(([name]) => name === "production-source-cut-coordinator"));
  assert.equal(productionHarness.calls.some(([name]) => name === "source-cut-ledger"), false);
  const productionResult = await productionHarness.getOrchestratorOptions().build.run({
    sourceCutId: CUT_ID,
    buildChannel: "shadow",
    publicationChannel: "shadow",
    idempotencyKey: `shadow:${CUT_ID}`,
    triggerName: RUNTIME_VERSION,
    publicationReason: "continuous comparison",
    productionConfirmation: null,
  });
  assert.equal(productionResult.publication.channel, "shadow");
  assert.equal(productionResult.production.publication.channel, "production");
  assert.equal(productionResult.productionPublicationAttempted, true);
  const productionCalls = productionHarness.calls.filter(([name]) => name === "relational-build.run");
  assert.deepEqual(productionCalls.map(([, options]) => options.buildChannel), ["shadow", "candidate"]);
  assert.equal(productionCalls[0][1].publication.publicationReason, "normal");
  assert.equal(productionCalls[1][1].publication.publicationReason, "normal");
  const approvalCall = productionHarness.calls.find(([name]) => name === "build-ledger.issue-production-approval")[1];
  assert.equal(approvalCall.expectedHeadVersion, 3);
  assert.equal(approvalCall.expectedHeadPacketHash, "b".repeat(64));
  assert.ok(Buffer.byteLength(approvalCall.credential, "utf8") >= 32);
  assert.equal(approvalCall.issuerToken, "issuer-token-at-least-thirty-two-bytes-long");

  const result = await runtime.run({ ownerId: "cron:test", deadlineAtMs: Date.now() + 30_000 });
  assert.equal(result.status, "succeeded");
  assert.equal(h.calls.at(-1)[0], "orchestrator.run");

  const fakeModelKey = "sk-fake-hosted-model-runtime-never-live-123456789";
  let liveCalls = 0;
  const enabledHarness = harness();
  const enabledRuntime = createHostedTruthShadowRuntime({
    env: testEnv({
      PQ_TRUTH_MODEL_RUNTIME_ENABLED: "1",
      OPENAI_API_KEY: fakeModelKey,
    }),
    factories: enabledHarness.factories,
    fetchImpl: async () => {
      liveCalls += 1;
      throw new Error("hosted runtime verifier forbids live model calls");
    },
  });
  assert.equal(enabledRuntime.configuration.modelRuntimeEnabled, true);
  assert.equal(enabledRuntime.configuration.modelConfigured, true);
  assert.equal(enabledRuntime.configuration.modelProviderStatus, "ready");
  assert.equal(enabledRuntime.configuration.attachmentModelConfigured, true);
  assert.equal(enabledRuntime.configuration.attachmentModelProviderStatus, "ready");
  assert.equal(JSON.stringify(enabledRuntime.configuration).includes(fakeModelKey), false);
  const providerOptions = enabledHarness.calls.find(([name]) => name === "model-provider")[1];
  assert.equal(providerOptions.apiKey, fakeModelKey);
  const enabledModelWorker = enabledHarness.calls.find(([name]) => name === "model-worker")[1];
  assert.equal(enabledModelWorker.runtimeEnabled, true);
  assert.equal(enabledModelWorker.providerAdapter !== null, true);
  const attachmentProviderOptions = enabledHarness.calls
    .find(([name]) => name === "attachment-model-provider")[1];
  assert.equal(attachmentProviderOptions.apiKey, fakeModelKey);
  const attachmentModelWorker = enabledHarness.calls
    .find(([name]) => name === "attachment-model-worker")[1];
  assert.equal(attachmentModelWorker.providerAdapter !== null, true);
  assert.equal(attachmentModelWorker.rawStore.kind, "raw-store");
  await attachmentModelWorker.jobLedger.claimJobs({ limit: 2 });
  const attachmentClaim = enabledHarness.calls
    .find(([name]) => name === "job-ledger.claim:gmail");
  assert.deepEqual(attachmentClaim[1].jobKinds, ["gmail_review_attachment_extraction"]);
  const enabledWorkers = enabledHarness.getOrchestratorOptions().workers;
  assert.ok(enabledWorkers.some((worker) => worker.name === "gmail-attachment-model"));
  assert.equal(liveCalls, 0, "composition must not call the provider");

  assert.throws(
    () => createHostedTruthShadowRuntime({ env: testEnv({ PQ_SUPABASE_SYNC_TOKEN: "short" }), factories: h.factories }),
    /PQ_SUPABASE_SYNC_TOKEN/,
  );
  assert.throws(
    () => createHostedTruthShadowRuntime({ env: testEnv({ PQ_TRUTH_WORKSPACE: "tenant-b" }), factories: h.factories }),
    /must equal the migrated workspace primary/,
  );
  assert.throws(
    () => createHostedTruthShadowRuntime({ env: testEnv({ PQ_TRUTH_REQUIRE_MODEL_FOR_AMBIGUITY: "maybe" }), factories: h.factories }),
    /must be 1, 0, true, or false/,
  );
  assert.throws(
    () => createHostedTruthShadowRuntime({
      env: testEnv({ PQ_TRUTH_CEREMONY_INGEST_PAUSED: "maybe" }),
      factories: h.factories,
    }),
    /must be 1, 0, true, or false/,
  );
  assert.throws(
    () => createHostedTruthShadowRuntime({ env: testEnv({ PQ_TRUTH_MODEL_MAX_CONFIDENCE: "0.951" }), factories: h.factories }),
    /at most 0.95/,
  );
  for (const overrides of [
    { PQ_TRUTH_DATE_ORDER: "DMY" },
    { PQ_TRUTH_REQUIRE_MODEL_FOR_AMBIGUITY: "false" },
    { PQ_TRUTH_MODEL_MAX_CONFIDENCE: "0.85" },
  ]) {
    assert.throws(
      () => createHostedTruthShadowRuntime({ env: testEnv(overrides), factories: h.factories }),
      /frozen authority/,
    );
  }
  const missingProviderHarness = harness();
  const missingProviderRuntime = createHostedTruthShadowRuntime({
    env: testEnv({ PQ_TRUTH_MODEL_RUNTIME_ENABLED: "1" }),
    factories: missingProviderHarness.factories,
  });
  assert.equal(missingProviderRuntime.configuration.modelRuntimeEnabled, true);
  assert.equal(missingProviderRuntime.configuration.modelConfigured, false);
  assert.equal(missingProviderRuntime.configuration.modelProviderStatus, "missing_or_invalid_key");
  assert.equal(missingProviderRuntime.configuration.attachmentModelConfigured, false);
  assert.equal(
    missingProviderRuntime.configuration.attachmentModelProviderStatus,
    "missing_or_invalid_key",
  );
  assert.equal(
    missingProviderHarness.calls.some(([name]) => name === "model-provider"),
    false,
    "a missing key cannot construct or call a provider",
  );
  const missingProviderWorkers = missingProviderHarness.getOrchestratorOptions().workers;
  const missingProviderReceipts = await Promise.all(
    missingProviderWorkers.map((worker) => worker.runOnce({ limit: 3 })),
  );
  const missingModelIndex = missingProviderWorkers.findIndex((worker) => worker.name === "gmail-model-claims");
  assert.equal(
    missingProviderReceipts[missingModelIndex].jobs[0].reasonCode,
    "MODEL_PROVIDER_NOT_CONFIGURED",
  );
  assert.equal(
    missingProviderWorkers.some((worker) => worker.name === "gmail-attachment-model"),
    false,
    "missing attachment provider must not claim attachment-model jobs",
  );
  for (const workerName of [
    "gmail-evidence",
    "gmail-attachments",
    "gmail-links",
    "gmail-parent-plans",
    "gmail-attachment-claims",
    "tms-claims",
    "tracking-claims",
    "operator-claims",
  ]) {
    const index = missingProviderWorkers.findIndex((worker) => worker.name === workerName);
    assert.equal(missingProviderReceipts[index].ok, true, `${workerName} remains reachable without a model key`);
  }
  assert.equal(liveCalls, 0, "missing-provider composition performs zero model calls");

  const missingFetchHarness = harness();
  const missingFetchRuntime = createHostedTruthShadowRuntime({
    env: testEnv({
      PQ_TRUTH_MODEL_RUNTIME_ENABLED: "1",
      OPENAI_API_KEY: fakeModelKey,
    }),
    factories: missingFetchHarness.factories,
    fetchImpl: null,
  });
  assert.equal(missingFetchRuntime.configuration.modelConfigured, false);
  assert.equal(missingFetchRuntime.configuration.modelProviderStatus, "missing_fetch");
  assert.equal(missingFetchRuntime.configuration.attachmentModelProviderStatus, "missing_fetch");
  assert.equal(missingFetchRuntime.configuration.attachmentModelConfigured, false);
  assert.equal(missingFetchHarness.calls.some(([name]) => name === "model-provider"), false);

  const adapterErrorHarness = harness();
  const adapterErrorRuntime = createHostedTruthShadowRuntime({
    env: testEnv({
      PQ_TRUTH_MODEL_RUNTIME_ENABLED: "1",
      OPENAI_API_KEY: fakeModelKey,
    }),
    factories: {
      ...adapterErrorHarness.factories,
      createOpenAIGmailModelExtractor() {
        throw new Error("fake local provider adapter configuration failure");
      },
    },
    fetchImpl: async () => { throw new Error("unreachable"); },
  });
  assert.equal(adapterErrorRuntime.configuration.modelConfigured, false);
  assert.equal(adapterErrorRuntime.configuration.modelProviderStatus, "adapter_configuration_error");
  assert.throws(
    () => createHostedTruthShadowRuntime({
      env: testEnv({ PQ_TRUTH_EXTRACTION_MODEL: "gpt-unpinned" }),
      factories: h.factories,
    }),
    /must equal the pinned snapshot/,
  );
  assert.throws(
    () => createHostedTruthShadowRuntime({
      env: testEnv(),
      factories: h.factories,
      modelExtractor: async () => [],
    }),
    /legacy inline model extraction is retired/,
  );

  console.log("hosted truth-shadow runtime verification passed (durable model worker graph, missing-provider lane isolation, exact source scopes, secret hygiene, zero live calls, shadow-only publication)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

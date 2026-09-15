#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_AUDIT_RESERVE_MS,
  ORCHESTRATOR_VERSION,
  createTruthShadowOrchestrator,
  _test: orchestratorTest,
} = require("../lib/truth-shadow-orchestrator");

const CUT_ID = `cut:v1:${"a".repeat(64)}`;
const PUBLICATION_ID = "40000000-0000-4000-8000-000000000001";
const BUILD_ID = "40000000-0000-4000-8000-000000000002";
const AUDIT_RUN_ID = "40000000-0000-4000-8000-000000000003";

function successfulPublication(overrides = {}) {
  const base = {
    ok: true,
    publicationId: PUBLICATION_ID,
    buildId: BUILD_ID,
    publicationVersion: 1,
    channel: "shadow",
    sourceCutId: CUT_ID,
    packetHash: "1".repeat(64),
    reducerPacketHash: "2".repeat(64),
    semanticHash: "3".repeat(64),
    deliveryPayloadHash: "4".repeat(64),
    activeIndexHash: "5".repeat(64),
  };
  const publication = { ...base, ...overrides };
  publication.publicationAdapter = overrides.publicationAdapter || {
    publicationId: publication.publicationId,
    publicationVersion: publication.publicationVersion,
    channel: publication.channel,
    sourceCutId: publication.sourceCutId,
    packetHash: publication.reducerPacketHash,
  };
  return publication;
}

function auditFinding(index, overrides = {}) {
  return {
    findingId: `truth-audit:v1:${index.toString(16).padStart(64, "0")}`,
    stage: "production",
    severity: "blocking",
    classification: "production_hash_mismatch",
    subjectType: "production_api",
    subjectKey: `shipment-truth-${index}`,
    evidenceIds: ["1".repeat(64)],
    evidenceIdCount: 1,
    evidenceObservationIds: [],
    evidenceObservationIdCount: 0,
    detail: { index },
    mutatesOperationalState: false,
    ...overrides,
  };
}

function successfulAuditReceipt(input, overrides = {}) {
  return {
    ok: true,
    auditRunId: AUDIT_RUN_ID,
    status: "succeeded",
    agreement: true,
    blockingAgreement: true,
    counts: {
      blocking: 0,
      attention: 0,
      informational: 0,
      byStage: {},
      productionComparison: {},
    },
    findingCount: 0,
    findings: [],
    findingsTruncated: false,
    inputDigest: "6".repeat(64),
    reconciliation: {
      previousAuditRunId: null,
      reconciliationFrom: null,
      scheduleGapSeconds: null,
      missedExpectedRun: false,
      expectedIntervalSeconds: 300,
    },
    productionWitness: {
      schemaVersion: "production-truth-witness-v2",
      mode: "relational",
      origin: "https://pikiio.example",
      path: "/api/truth/production-witness",
      observedAt: "2026-07-09T20:00:00.000Z",
      payloadBytes: 100,
      publicationId: PUBLICATION_ID,
      publicationVersion: 1,
      sourceCutId: CUT_ID,
      packetHash: "1".repeat(64),
      deliveryPayloadHash: "2".repeat(64),
      exactSnapshotHash: "3".repeat(64),
      semanticWitnessHash: "4".repeat(64),
      sourcePayloadBytes: 100,
      relationalIdentityPresent: true,
      missingRelationalFields: [],
      semanticHashIndependentlyRecomputed: true,
      fullPayloadHashVerifiedAtSource: true,
      processingWatermarkStatus: "watermarked",
      processingWatermarkHash: "5".repeat(64),
      mutatesOperationalState: false,
    },
    producerContext: input.producerContext,
    mutatesOperationalState: false,
    ...overrides,
  };
}

function busyAuditReceipt(overrides = {}) {
  return {
    ok: true,
    skipped: true,
    status: "busy",
    code: "AUDIT_BUSY",
    auditRunId: AUDIT_RUN_ID,
    leaseExpiresAt: "2026-07-09T20:05:00.000Z",
    agreement: null,
    blockingAgreement: null,
    findingCount: 0,
    findings: [],
    mutatesOperationalState: false,
    ...overrides,
  };
}

function clock(start = Date.parse("2026-07-09T20:00:00.000Z")) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
    deadline: (ms = 300_000) => value + ms,
  };
}

function receipt({ claimed = 0, failed = 0 } = {}) {
  return {
    ok: failed === 0,
    claimedCount: claimed,
    succeededCount: claimed - failed,
    failedCount: failed,
    jobs: [],
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const time = overrides.time || clock();
  const queues = new Map(Object.entries(overrides.workerQueues || {
    evidence: [receipt(), receipt()],
    attachments: [receipt(), receipt()],
    links: [receipt(), receipt()],
    claims: [receipt(), receipt()],
  }));
  const gmail = {
    async runIncremental(input) {
      calls.push(["gmail.incremental", input]);
      if (overrides.incrementalError) throw overrides.incrementalError;
      return overrides.incremental || { ok: true, status: "committed", committedCursorValue: "100" };
    },
    async runBackfill(input) {
      calls.push(["gmail.backfill", input]);
      if (overrides.backfillError) throw overrides.backfillError;
      return overrides.backfill || { ok: true, status: "committed", committedCursorValue: "100" };
    },
  };
  const workers = [...queues.entries()].map(([name, items]) => ({
    name,
    async runOnce(input) {
      calls.push([`worker.${name}`, input]);
      if (overrides.workerAdvanceMs) time.advance(overrides.workerAdvanceMs);
      if (overrides.workerErrors?.[name]) throw overrides.workerErrors[name];
      return items.shift() || receipt();
    },
  }));
  const sourceCut = {
    async sealCurrent(input) {
      calls.push(["cut.seal", input]);
      if (overrides.cutError) throw overrides.cutError;
      return overrides.cut || {
        ok: true,
        sourceCutId: CUT_ID,
        completeness: "complete",
        gaps: [],
      };
    },
  };
  const build = {
    async run(input) {
      calls.push(["build.run", input]);
      if (overrides.buildError) throw overrides.buildError;
      return overrides.build || {
        status: "succeeded",
        publication: successfulPublication(),
      };
    },
  };
  const audit = {
    async run(input) {
      calls.push(["audit.run", input]);
      if (overrides.auditRaw !== undefined) {
        return typeof overrides.auditRaw === "function"
          ? overrides.auditRaw(input)
          : overrides.auditRaw;
      }
      return successfulAuditReceipt(input, overrides.audit || {});
    },
  };
  return {
    calls,
    time,
    orchestrator: createTruthShadowOrchestrator({
      workspaceKey: "primary",
      gmail,
      workers,
      sourceCut,
      build,
      audit,
      maxWorkerRounds: overrides.maxWorkerRounds || 4,
      workerLimit: 7,
      deadlineBufferMs: 5_000,
      auditReserveMs: overrides.auditReserveMs ?? DEFAULT_AUDIT_RESERVE_MS,
      now: time.now,
    }),
  };
}

async function main() {
  const happy = fixture({
    workerQueues: {
      evidence: [receipt({ claimed: 2 }), receipt()],
      attachments: [receipt({ claimed: 1 }), receipt()],
      links: [receipt({ claimed: 2 }), receipt()],
      claims: [receipt({ claimed: 3 }), receipt()],
    },
  });
  const happyResult = await happy.orchestrator.run({ ownerId: "cron:fixture", deadlineAtMs: happy.time.deadline() });
  assert.equal(happyResult.status, "succeeded");
  assert.equal(happyResult.sourceCutId, CUT_ID);
  assert.equal(happyResult.productionPublicationAttempted, false);
  assert.equal(happyResult.operationalEffectsAttempted, false);
  assert.equal(happyResult.mutatesOperationalState, false);
  assert.equal(happyResult.workerRounds, 2);
  const buildInput = happy.calls.find(([name]) => name === "build.run")[1];
  assert.equal(buildInput.buildChannel, "shadow");
  assert.equal(buildInput.publicationChannel, "shadow");
  assert.equal(buildInput.productionConfirmation, null);
  assert.equal(buildInput.idempotencyKey, `shadow:${CUT_ID}`);
  assert.ok(happy.calls.findIndex(([name]) => name === "cut.seal")
    < happy.calls.findIndex(([name]) => name === "build.run"));
  assert.ok(happy.calls.findIndex(([name]) => name === "build.run")
    < happy.calls.findIndex(([name]) => name === "audit.run"));
  const happyAuditInput = happy.calls.find(([name]) => name === "audit.run")[1];
  assert.equal(happyAuditInput.auditMode, "delta");
  assert.deepEqual(happyAuditInput.producerContext, happyResult.producerContext);
  assert.equal(happyAuditInput.producerContext.producerLane, "truth-shadow");
  assert.equal(happyAuditInput.producerContext.producerStatus, "succeeded");
  assert.equal(happyAuditInput.producerContext.gmailSyncDisposition, "ready");
  assert.equal(happyAuditInput.producerContext.workerRounds, 2);
  assert.equal(happyAuditInput.producerContext.workersDrained, true);
  assert.equal(happyAuditInput.producerContext.workerFailureCount, 0);
  assert.equal(happyAuditInput.producerContext.sourceCutStatus, "sealed");
  assert.equal(happyAuditInput.producerContext.sourceCutCompleteness, "complete");
  assert.equal(happyAuditInput.producerContext.sourceGapCount, 0);
  assert.match(happyAuditInput.producerContext.sourceGapsHash, /^[0-9a-f]{64}$/);
  assert.equal(happyAuditInput.producerContext.shadowBuildStatus, "succeeded");

  const backfill = fixture({
    incremental: { ok: false, status: "backfill_required" },
    backfill: { ok: true, status: "committed", committedCursorValue: "200" },
  });
  const backfillResult = await backfill.orchestrator.run({
    ownerId: "cron:backfill",
    deadlineAtMs: backfill.time.deadline(),
  });
  assert.equal(backfillResult.status, "succeeded");
  assert.equal(backfill.calls.filter(([name]) => name === "gmail.backfill").length, 1);
  assert.equal(backfill.calls.find(([name]) => name === "gmail.backfill")[1].mode, "backfill");

  const reconcile = fixture({
    incremental: { ok: false, status: "reconcile_required" },
    backfill: { ok: true, status: "partial", reason: "page_budget" },
  });
  const reconcileResult = await reconcile.orchestrator.run({
    ownerId: "cron:reconcile",
    deadlineAtMs: reconcile.time.deadline(),
  });
  assert.equal(reconcileResult.status, "degraded");
  assert.ok(reconcileResult.incompleteReasons.includes("gmail_sync:yield"));
  assert.equal(reconcile.calls.some(([name]) => name === "cut.seal"), false);
  assert.equal(reconcile.calls.some(([name]) => name === "build.run"), false);
  assert.equal(reconcile.calls.at(-1)[0], "audit.run", "audit still witnesses a partial source run");
  assert.equal(reconcile.calls.find(([name]) => name === "gmail.backfill")[1].mode, "reconciliation");
  assert.equal(
    reconcile.calls.find(([name]) => name === "audit.run")[1].producerContext.producerStatus,
    "degraded",
  );

  const busy = fixture({ incremental: { ok: false, status: "lease_busy" } });
  const busyResult = await busy.orchestrator.run({ ownerId: "cron:busy", deadlineAtMs: busy.time.deadline() });
  assert.equal(busyResult.status, "busy");
  assert.equal(busy.calls.some(([name]) => name.startsWith("worker.")), false);
  assert.equal(busy.calls.some(([name]) => name === "cut.seal"), false);
  assert.equal(busy.calls.at(-1)[0], "audit.run");
  assert.equal(busy.calls.at(-1)[1].producerContext.producerStatus, "busy");

  const syncCrash = new Error("gmail provider transport failed");
  syncCrash.code = "GMAIL_PROVIDER_FAILED";
  const preAuditFailure = fixture({ incrementalError: syncCrash });
  await assert.rejects(
    () => preAuditFailure.orchestrator.run({
      ownerId: "cron:pre-audit-failure",
      deadlineAtMs: preAuditFailure.time.deadline(),
    }),
    (error) => {
      assert.equal(error?.stage, "gmail_sync");
      assert.equal(error?.diagnosticAuditAttempted, true);
      assert.equal(error?.diagnosticAudit?.status, "succeeded");
      return true;
    },
  );
  assert.deepEqual(preAuditFailure.calls.map(([name]) => name), ["gmail.incremental", "audit.run"]);
  const failedProducer = preAuditFailure.calls[1][1].producerContext;
  assert.equal(failedProducer.producerLane, "truth-shadow");
  assert.equal(failedProducer.producerStatus, "failed");
  assert.equal(failedProducer.gmailSyncDisposition, "failed");
  assert.equal(failedProducer.workerRounds, 0);
  assert.equal(failedProducer.workersDrained, false);
  assert.equal(failedProducer.sourceCutStatus, "not_run");
  assert.equal(failedProducer.shadowBuildStatus, "not_run");
  assert.equal(failedProducer.failureStage, "gmail_sync");
  assert.equal(failedProducer.failureCode, "GMAIL_PROVIDER_FAILED");

  const failure = fixture({
    workerQueues: {
      evidence: [receipt({ claimed: 1, failed: 1 }), receipt()],
      attachments: [receipt(), receipt()],
      links: [receipt(), receipt()],
      claims: [receipt(), receipt()],
    },
  });
  const failureResult = await failure.orchestrator.run({
    ownerId: "cron:failure",
    deadlineAtMs: failure.time.deadline(),
  });
  assert.equal(failureResult.status, "degraded");
  assert.equal(failureResult.workerFailureCount, 1);
  assert.equal(failure.calls.some(([name]) => name === "cut.seal"), false);
  assert.equal(failure.calls.some(([name]) => name === "build.run"), false);
  assert.equal(failure.calls.find(([name]) => name === "audit.run")[1].producerContext.workerFailureCount, 1);

  const backlog = fixture({
    maxWorkerRounds: 2,
    workerQueues: {
      evidence: [receipt({ claimed: 1 }), receipt({ claimed: 1 })],
      attachments: [receipt(), receipt()],
      links: [receipt(), receipt()],
      claims: [receipt(), receipt()],
    },
  });
  const backlogResult = await backlog.orchestrator.run({
    ownerId: "cron:backlog",
    deadlineAtMs: backlog.time.deadline(),
  });
  assert.equal(backlogResult.status, "degraded");
  assert.ok(backlogResult.incompleteReasons.includes("worker_backlog_not_drained"));
  assert.equal(backlog.calls.some(([name]) => name === "cut.seal"), false);

  const reservedAudit = fixture({
    maxWorkerRounds: 4,
    auditReserveMs: 30_000,
    workerAdvanceMs: 12_500,
    workerQueues: {
      evidence: [receipt({ claimed: 1 })],
      attachments: [receipt({ claimed: 1 })],
      links: [receipt({ claimed: 1 })],
      claims: [receipt({ claimed: 1 })],
    },
  });
  const reserveStartedAtMs = reservedAudit.time.now();
  const reserveDeadlineAtMs = reserveStartedAtMs + 60_000;
  const reservedAuditResult = await reservedAudit.orchestrator.run({
    ownerId: "cron:audit-reserve",
    deadlineAtMs: reserveDeadlineAtMs,
  });
  const reservedWorkerCalls = reservedAudit.calls.filter(([name]) => name.startsWith("worker."));
  const reservedAuditCall = reservedAudit.calls.find(([name]) => name === "audit.run");
  assert.equal(reservedAuditResult.status, "degraded");
  assert.ok(reservedAuditResult.incompleteReasons.includes("worker_backlog_not_drained"));
  assert.equal(reservedWorkerCalls.length, 2, "producer work must stop at its dedicated deadline");
  assert.ok(reservedWorkerCalls.every(([, input]) =>
    input.deadlineAtMs === reserveStartedAtMs + 25_000));
  assert.equal(reservedAudit.calls.some(([name]) => name === "cut.seal"), false);
  assert.equal(reservedAudit.calls.some(([name]) => name === "build.run"), false);
  assert.equal(reservedAuditCall[1].deadlineAtMs, reserveStartedAtMs + 55_000);
  assert.equal(
    reservedAuditCall[1].deadlineAtMs - reservedAudit.time.now(),
    30_000,
    "the terminal audit must retain the entire protected reserve",
  );

  const degradedCut = fixture({
    cut: {
      ok: true,
      sourceCutId: `cut:v1:${"b".repeat(64)}`,
      completeness: "degraded",
      gaps: [{ gapType: "SOURCE_PROCESSING_BACKLOG" }],
    },
  });
  const degradedResult = await degradedCut.orchestrator.run({
    ownerId: "cron:degraded-cut",
    deadlineAtMs: degradedCut.time.deadline(),
  });
  assert.equal(degradedResult.status, "degraded");
  assert.equal(degradedCut.calls.some(([name]) => name === "build.run"), false);
  assert.ok(degradedResult.incompleteReasons.includes("source_cut_gaps:1"));

  const productionCutId = `cut:v1:${"b".repeat(64)}`;
  const bridgedDegradedCut = fixture({
    cut: {
      ok: true,
      status: "sealed",
      sourceCutId: productionCutId,
      productionSourceCutId: productionCutId,
      shadowSourceCutId: `cut:v1:${"c".repeat(64)}`,
      bridgeId: `truth-production-cut-acceptance-bridge:v1:${"d".repeat(64)}`,
      bridgeHash: "e".repeat(64),
      completeness: "degraded",
      gaps: [{ gapType: "CANDIDATE_CLAIM_REVIEW_PENDING" }],
      productionEligible: true,
      productionPublicationAttempted: false,
      publishesTruth: false,
      performsActions: false,
    },
    build: {
      status: "succeeded",
      publication: successfulPublication({ sourceCutId: productionCutId }),
    },
  });
  const bridgedResult = await bridgedDegradedCut.orchestrator.run({
    ownerId: "cron:bridged-degraded-cut",
    deadlineAtMs: bridgedDegradedCut.time.deadline(),
  });
  assert.equal(bridgedResult.status, "degraded");
  assert.equal(bridgedDegradedCut.calls.some(([name]) => name === "build.run"), true);
  assert.equal(
    bridgedDegradedCut.calls.find(([name]) => name === "build.run")[1].sourceCutId,
    productionCutId,
  );
  assert.ok(bridgedResult.incompleteReasons.includes("source_cut_gaps:1"));

  const malformedBridgeCut = fixture({
    cut: {
      ok: true,
      status: "sealed",
      sourceCutId: productionCutId,
      productionSourceCutId: productionCutId,
      completeness: "degraded",
      gaps: [{ gapType: "CANDIDATE_CLAIM_REVIEW_PENDING" }],
      productionEligible: true,
      productionPublicationAttempted: false,
      publishesTruth: false,
      performsActions: false,
    },
  });
  await assert.rejects(
    () => malformedBridgeCut.orchestrator.run({
      ownerId: "cron:malformed-production-bridge",
      deadlineAtMs: malformedBridgeCut.time.deadline(),
    }),
    (error) => error?.code === "TRUTH_SHADOW_SOURCE_CUT_RECEIPT_INVALID"
      && error.stage === "source_cut"
      && error.diagnosticAuditAttempted === true,
  );
  assert.equal(malformedBridgeCut.calls.some(([name]) => name === "build.run"), false);

  const notReadyCut = fixture({
    cut: {
      ok: true,
      status: "not_ready",
      sourceCutId: null,
      completeness: "degraded",
      gaps: [{ gapType: "REQUIRED_SOURCE_CURSOR_MISSING" }],
    },
  });
  const notReadyResult = await notReadyCut.orchestrator.run({
    ownerId: "cron:not-ready-cut",
    deadlineAtMs: notReadyCut.time.deadline(),
  });
  assert.equal(notReadyResult.status, "degraded");
  assert.equal(notReadyResult.sourceCutId, null);
  assert.ok(notReadyResult.incompleteReasons.includes("source_cut_not_ready:1"));
  assert.equal(notReadyCut.calls.some(([name]) => name === "build.run"), false);

  const mismatchFindings = Array.from({ length: 4 }, (_, index) => auditFinding(index + 1));
  const auditMismatch = fixture({
    audit: {
      agreement: false,
      blockingAgreement: false,
      counts: {
        blocking: 4,
        attention: 0,
        informational: 0,
        byStage: { production: 4 },
        productionComparison: {},
      },
      findingCount: 4,
      findings: mismatchFindings,
      findingsTruncated: false,
    },
  });
  const mismatchResult = await auditMismatch.orchestrator.run({
    ownerId: "cron:mismatch",
    deadlineAtMs: auditMismatch.time.deadline(),
  });
  assert.equal(mismatchResult.status, "degraded");
  assert.ok(mismatchResult.incompleteReasons.includes("audit_findings:4"));

  assert.throws(
    () => orchestratorTest.assertAuditReceipt(
      { status: "succeeded", mutatesOperationalState: false },
      happyResult.producerContext,
      "delta",
    ),
    (error) => error?.code === "TRUTH_SHADOW_AUDIT_RECEIPT_INVALID" && error.stage === "audit",
  );

  const auditBusy = fixture({ auditRaw: busyAuditReceipt() });
  const auditBusyResult = await auditBusy.orchestrator.run({
    ownerId: "cron:audit-busy",
    deadlineAtMs: auditBusy.time.deadline(),
  });
  assert.equal(auditBusyResult.status, "degraded");
  assert.ok(auditBusyResult.incompleteReasons.includes("audit:busy"));

  const malformedAudits = [
    ["missing-contract", () => ({ status: "succeeded", mutatesOperationalState: false })],
    ["null-agreement", (input) => successfulAuditReceipt(input, { agreement: null })],
    ["negative-findings", (input) => successfulAuditReceipt(input, { findingCount: -1 })],
    ["null-context", (input) => successfulAuditReceipt(input, { producerContext: null })],
    ["mismatched-context", (input) => successfulAuditReceipt(input, {
      producerContext: { ...input.producerContext, producerStatus: "degraded" },
    })],
    ["mismatched-counts", (input) => successfulAuditReceipt(input, {
      counts: {
        blocking: 1,
        attention: 0,
        informational: 0,
        byStage: {},
        productionComparison: {},
      },
    })],
    ["missing-witness", (input) => successfulAuditReceipt(input, { productionWitness: null })],
    ["bad-digest", (input) => successfulAuditReceipt(input, { inputDigest: "not-a-hash" })],
    ["wrong-cadence", (input) => successfulAuditReceipt(input, {
      reconciliation: {
        previousAuditRunId: null,
        reconciliationFrom: null,
        scheduleGapSeconds: null,
        missedExpectedRun: false,
        expectedIntervalSeconds: 900,
      },
    })],
    ["malformed-busy", () => busyAuditReceipt({ skipped: false })],
  ];
  for (const [label, auditRaw] of malformedAudits) {
    const malformed = fixture({ auditRaw });
    await assert.rejects(
      () => malformed.orchestrator.run({
        ownerId: `cron:malformed-audit:${label}`,
        deadlineAtMs: malformed.time.deadline(),
      }),
      (error) => error?.code === "TRUTH_SHADOW_AUDIT_RECEIPT_INVALID"
        && error.stage === "audit",
      `${label} must fail closed at the audit receipt boundary`,
    );
    assert.equal(malformed.calls.at(-1)[0], "audit.run");
  }

  const productionAttempt = fixture({
    build: { status: "succeeded", publication: successfulPublication({ channel: "production" }) },
  });
  await assert.rejects(
    () => productionAttempt.orchestrator.run({
      ownerId: "cron:production-attempt",
      deadlineAtMs: productionAttempt.time.deadline(),
    }),
    (error) => error?.code === "TRUTH_SHADOW_PRODUCTION_PUBLICATION_FORBIDDEN"
      && error.stage === "shadow_build",
  );

  for (const [label, build] of [
    ["missing-publication", { status: "succeeded" }],
    ["empty-publication", { status: "succeeded", publication: {} }],
  ]) {
    const invalidSuccess = fixture({ build });
    await assert.rejects(
      () => invalidSuccess.orchestrator.run({
        ownerId: `cron:${label}`,
        deadlineAtMs: invalidSuccess.time.deadline(),
      }),
      (error) => error?.code === "TRUTH_SHADOW_BUILD_RECEIPT_INVALID"
        && error.stage === "shadow_build"
        && error.diagnosticAuditAttempted === true,
    );
    assert.deepEqual(
      invalidSuccess.calls.slice(-3).map(([name]) => name),
      ["cut.seal", "build.run", "audit.run"],
    );
    assert.equal(invalidSuccess.calls.at(-1)[1].producerContext.producerStatus, "failed");
  }

  const malformedWorker = fixture({
    workerQueues: {
      evidence: [{ claimedCount: 2, succeededCount: 2, failedCount: 1 }],
      attachments: [receipt()],
      links: [receipt()],
      claims: [receipt()],
    },
  });
  await assert.rejects(
    () => malformedWorker.orchestrator.run({
      ownerId: "cron:malformed-worker",
      deadlineAtMs: malformedWorker.time.deadline(),
    }),
    (error) => error?.code === "TRUTH_SHADOW_WORKER_RECEIPT_INVALID"
      && error.stage === "worker:evidence"
      && error.diagnosticAuditAttempted === true,
  );
  assert.equal(malformedWorker.calls.at(-1)[0], "audit.run");
  assert.equal(malformedWorker.calls.at(-1)[1].producerContext.producerStatus, "failed");
  assert.equal(malformedWorker.calls.at(-1)[1].producerContext.failureStage, "worker:evidence");

  const workerCrashError = new Error("worker provider crashed");
  workerCrashError.code = "WORKER_PROVIDER_CRASHED";
  const workerCrash = fixture({ workerErrors: { links: workerCrashError } });
  await assert.rejects(
    () => workerCrash.orchestrator.run({
      ownerId: "cron:worker-crash",
      deadlineAtMs: workerCrash.time.deadline(),
    }),
    (error) => error?.stage === "worker:links"
      && error.diagnosticAuditAttempted === true
      && error.diagnosticAudit?.status === "succeeded",
  );
  const workerCrashAudit = workerCrash.calls.at(-1);
  assert.equal(workerCrashAudit[0], "audit.run");
  assert.equal(workerCrashAudit[1].producerContext.failureCode, "WORKER_PROVIDER_CRASHED");
  assert.equal(workerCrash.calls.some(([name]) => name === "cut.seal"), false);

  const cutCrashError = new Error("source cut crashed");
  cutCrashError.code = "SOURCE_CUT_CRASHED";
  const cutCrash = fixture({ cutError: cutCrashError });
  await assert.rejects(
    () => cutCrash.orchestrator.run({
      ownerId: "cron:cut-crash",
      deadlineAtMs: cutCrash.time.deadline(),
    }),
    (error) => error?.stage === "source_cut"
      && error.diagnosticAuditAttempted === true
      && error.producerContext?.workersDrained === true,
  );
  assert.deepEqual(cutCrash.calls.slice(-2).map(([name]) => name), ["cut.seal", "audit.run"]);
  assert.equal(cutCrash.calls.at(-1)[1].producerContext.sourceCutStatus, "not_run");
  assert.equal(cutCrash.calls.some(([name]) => name === "build.run"), false);

  const buildCrashError = new Error("shadow build crashed");
  buildCrashError.code = "SHADOW_BUILD_CRASHED";
  const buildCrash = fixture({ buildError: buildCrashError });
  await assert.rejects(
    () => buildCrash.orchestrator.run({
      ownerId: "cron:build-crash",
      deadlineAtMs: buildCrash.time.deadline(),
    }),
    (error) => error?.stage === "shadow_build"
      && error.diagnosticAuditAttempted === true
      && error.producerContext?.sourceCutId === CUT_ID,
  );
  assert.deepEqual(buildCrash.calls.slice(-3).map(([name]) => name), ["cut.seal", "build.run", "audit.run"]);
  assert.equal(buildCrash.calls.at(-1)[1].producerContext.failureCode, "SHADOW_BUILD_CRASHED");

  const returnedBuildFailure = fixture({
    build: { status: "failed", code: "SHADOW_BUILD_REJECTED" },
  });
  const returnedBuildFailureResult = await returnedBuildFailure.orchestrator.run({
    ownerId: "cron:returned-build-failure",
    deadlineAtMs: returnedBuildFailure.time.deadline(),
  });
  assert.equal(returnedBuildFailureResult.status, "failed");
  assert.equal(returnedBuildFailureResult.producerContext.producerStatus, "failed");
  assert.equal(returnedBuildFailureResult.producerContext.failureStage, "shadow_build");
  assert.equal(returnedBuildFailureResult.producerContext.failureCode, "SHADOW_BUILD_REJECTED");
  assert.equal(returnedBuildFailure.calls.filter(([name]) => name === "audit.run").length, 1);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-shadow-orchestrator",
    orchestratorVersion: ORCHESTRATOR_VERSION,
    cases: 21 + malformedAudits.length,
    guarantees: [
      "resumable Gmail sync/backfill gates source-cut sealing",
      "workers drain in bounded deterministic rounds",
      "producer work cannot consume the terminal audit reserve",
      "failures and backlog forbid a canonical build",
      "ordinary degraded cuts remain diagnostic and unpublishable",
      "an exact production bridge can build its documented-degraded cut",
      "every pre-audit producer failure attempts one producer-bound diagnostic audit",
      "successful builds require an exact shadow publication identity",
      "malformed or context-substituted audit receipts cannot produce green orchestration",
      "every terminal path runs the read-only production audit",
      "only the shadow publication channel is accepted",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  AUDIT_RPC,
  PRODUCER_CONTEXT_SCHEMA_VERSION,
  PRODUCER_LANES,
  TruthAuditLedgerError,
  createTruthAuditLedger,
  normalizeAuditProducerContext,
  standaloneAuditProducerContext,
} = require("../lib/truth-audit-ledger");
const { createTruthAuditStatusHandler } = require("../api/truth/audit-status")._test;
const { healthExitCode, readTruthAuditStatus } = require("./read-truth-audit-status");

const AUDIT_RUN_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];
const FINDING_ID = `truth-audit:v1:${"a".repeat(64)}`;
const OBSERVATION_ID = `obs:v1:${"b".repeat(64)}`;

function shadowProducerContext(overrides = {}) {
  return normalizeAuditProducerContext({
    schemaVersion: PRODUCER_CONTEXT_SCHEMA_VERSION,
    producerLane: PRODUCER_LANES.shadow,
    producerStatus: "succeeded",
    gmailSyncDisposition: "ready",
    workerRounds: 2,
    workersDrained: true,
    workerFailureCount: 0,
    sourceCutStatus: "sealed",
    sourceCutId: `cut:v1:${"c".repeat(64)}`,
    sourceCutCompleteness: "complete",
    sourceGapCount: 0,
    sourceGapsHash: "d".repeat(64),
    shadowBuildStatus: "succeeded",
    failureStage: "",
    failureCode: "",
    ...overrides,
  }, { expectedLane: PRODUCER_LANES.shadow });
}

function finding(overrides = {}) {
  return {
    findingId: FINDING_ID,
    stage: "production",
    severity: "blocking",
    classification: "production_shipment_semantic_mismatch",
    subjectType: "shipment",
    subjectKey: "01680000083",
    evidenceIds: ["publication:fixture"],
    evidenceObservationIds: [OBSERVATION_ID],
    detail: { mismatchFields: ["gates.customs"] },
    createdAt: "2026-07-09T20:00:10.000Z",
    mutatesOperationalState: false,
    ...overrides,
  };
}

function latestRun({
  lane,
  runId,
  status = "succeeded",
  producerContext,
  expectedIntervalSeconds,
  leaseExpired = false,
  metrics,
} = {}) {
  const auditMode = lane === PRODUCER_LANES.shadow ? "delta" : "hourly";
  return {
    auditRunId: runId,
    auditMode,
    status,
    sourceCutId: lane === PRODUCER_LANES.shadow ? `cut:v1:${"c".repeat(64)}` : "",
    packetHash: "d".repeat(64),
    productionPacketHash: "",
    observerVersion: "relational-truth-auditor-v1",
    modelVersion: "",
    startedAt: "2026-07-09T20:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-07-09T20:00:10.000Z",
    leaseExpiresAt: leaseExpired
      ? "2026-07-09T19:59:00.000Z"
      : "2026-07-09T20:05:00.000Z",
    leaseExpired,
    expectedIntervalSeconds,
    errorCode: status === "failed" ? "VERIFY_FAILED" : "",
    errorDetail: status === "failed" ? "bounded failure" : "",
    metrics: metrics ?? (status === "running" ? {} : { producerContext }),
    producerContext,
    producerContextValid: producerContext !== null,
    mutatesOperationalState: false,
  };
}

function latestSuccess(run) {
  if (!run || run.status !== "succeeded" || !run.producerContextValid) return null;
  const expectedDisposition = run.producerContext.producerLane === PRODUCER_LANES.shadow
    ? "succeeded"
    : "ready";
  if (run.producerContext.producerStatus !== expectedDisposition) return null;
  return {
    auditRunId: run.auditRunId,
    auditMode: run.auditMode,
    status: "succeeded",
    finishedAt: run.finishedAt,
    expectedIntervalSeconds: run.expectedIntervalSeconds,
    producerContext: run.producerContext,
    producerContextValid: true,
    mutatesOperationalState: false,
  };
}

function laneReceipt({
  lane,
  health = "healthy",
  stale = false,
  status = "succeeded",
  producerContext,
  findings = [],
  runId,
  leaseExpired = false,
  producerContextValid = true,
  latestCompleted: completedOverride,
} = {}) {
  const shadow = lane === PRODUCER_LANES.shadow;
  const expectedIntervalSeconds = shadow ? 300 : 900;
  const staleAfterSeconds = shadow ? 600 : 1800;
  const context = producerContextValid
    ? (producerContext || (shadow ? shadowProducerContext() : standaloneAuditProducerContext()))
    : null;
  const run = latestRun({
    lane,
    runId,
    status,
    producerContext: context,
    expectedIntervalSeconds,
    leaseExpired,
    metrics: producerContextValid && status !== "running" ? { producerContext: context } : {},
  });
  const counts = {
    blocking: findings.filter((item) => item.severity === "blocking").length,
    attention: findings.filter((item) => item.severity === "attention").length,
    informational: findings.filter((item) => item.severity === "informational").length,
  };
  const success = latestSuccess(run);
  const completed = completedOverride === undefined
    ? (status === "running" ? null : run)
    : completedOverride;
  const producerStatus = !producerContextValid
    ? "metadata_missing"
    : status === "running"
      ? "running"
      : status === "failed"
        ? "failed"
        : context.producerStatus;
  return {
    schemaVersion: "truth-audit-lane-status-v1",
    producerLane: lane,
    auditMode: shadow ? "delta" : "hourly",
    health,
    stale,
    expectedIntervalSeconds,
    staleAfterSeconds,
    latestRun: run,
    latestCompleted: completed,
    latestSuccess: success,
    lastSuccessfulFinishedAt: success?.finishedAt ?? null,
    secondsSinceLastSuccess: success ? 10 : null,
    secondsSinceLatestRun: 10,
    producerStatus,
    producerContextValid,
    findingCount: findings.length,
    findingsTruncated: false,
    counts,
    findings,
    mutatesOperationalState: false,
  };
}

function healthRank(health) {
  return ["failed", "stale", "never_run", "regressions", "degraded", "running", "attention", "healthy"]
    .indexOf(health);
}

function statusReceipt({ shadow, standalone, findingLimit = 50, overrides = {} } = {}) {
  const shadowLane = shadow || laneReceipt({
    lane: PRODUCER_LANES.shadow,
    health: "regressions",
    findings: [finding()],
    runId: AUDIT_RUN_IDS[0],
  });
  const standaloneLane = standalone || laneReceipt({
    lane: PRODUCER_LANES.standalone,
    health: "healthy",
    runId: AUDIT_RUN_IDS[1],
  });
  const laneValues = [shadowLane, standaloneLane];
  const severityRank = { blocking: 0, attention: 1, informational: 2 };
  const findings = laneValues.flatMap((lane) => lane.findings)
    .sort((left, right) => {
      for (const [leftValue, rightValue] of [
        [severityRank[left.severity], severityRank[right.severity]],
        [left.stage, right.stage],
        [left.classification, right.classification],
        [left.subjectKey, right.subjectKey],
        [left.findingId, right.findingId],
      ]) {
        if (leftValue < rightValue) return -1;
        if (leftValue > rightValue) return 1;
      }
      return 0;
    })
    .slice(0, findingLimit);
  const counts = {
    blocking: laneValues.reduce((sum, lane) => sum + lane.counts.blocking, 0),
    attention: laneValues.reduce((sum, lane) => sum + lane.counts.attention, 0),
    informational: laneValues.reduce((sum, lane) => sum + lane.counts.informational, 0),
  };
  return {
    schemaVersion: "truth-audit-status-v2",
    ok: true,
    workspaceKey: "primary",
    health: laneValues.slice().sort((left, right) => healthRank(left.health) - healthRank(right.health))[0].health,
    stale: laneValues.some((lane) => lane.stale),
    policy: {
      schemaVersion: "truth-audit-lane-status-policy-v1",
      lanes: {
        [PRODUCER_LANES.shadow]: {
          auditMode: "delta",
          expectedIntervalSeconds: 300,
          staleAfterSeconds: 600,
        },
        [PRODUCER_LANES.standalone]: {
          auditMode: "hourly",
          expectedIntervalSeconds: 900,
          staleAfterSeconds: 1800,
        },
      },
    },
    lanes: {
      [PRODUCER_LANES.shadow]: shadowLane,
      [PRODUCER_LANES.standalone]: standaloneLane,
    },
    findingCount: laneValues.reduce((sum, lane) => sum + lane.findingCount, 0),
    findingsTruncated: laneValues.reduce((sum, lane) => sum + lane.findingCount, 0) > findings.length,
    counts,
    findings,
    mutatesOperationalState: false,
    ...overrides,
  };
}

function responseHarness() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value) { this.body = String(value || ""); },
    json() { return JSON.parse(this.body); },
  };
}

async function invoke(handler, {
  method = "GET",
  url = "/api/truth/audit-status?limit=25",
  authorization = "Bearer status-token-at-least-sixteen-bytes",
} = {}) {
  const response = responseHarness();
  await handler({ method, url, headers: { authorization } }, response);
  return response;
}

function ledgerForReceipt(receipt) {
  return createTruthAuditLedger({
    workspaceKey: "primary",
    auditToken: "audit-token-at-least-sixteen-bytes",
    callRpc: async () => receipt,
  });
}

async function assertInvalid(receipt, label) {
  await assert.rejects(
    () => ledgerForReceipt(receipt).readStatus(),
    (error) => error instanceof TruthAuditLedgerError && error.code === "TRUTH_AUDIT_INVALID_RECEIPT",
    label,
  );
}

async function main() {
  const calls = [];
  const ledger = createTruthAuditLedger({
    workspaceKey: "primary",
    auditToken: "audit-token-at-least-sixteen-bytes",
    callRpc: async (rpc, body) => {
      calls.push({ rpc, body });
      return statusReceipt();
    },
  });
  const status = await ledger.readStatus({ findingLimit: 25 });
  assert.equal(status.health, "regressions");
  assert.equal(status.lanes[PRODUCER_LANES.shadow].health, "regressions");
  assert.equal(status.lanes[PRODUCER_LANES.standalone].health, "healthy");
  assert.equal(status.findings[0].classification, "production_shipment_semantic_mismatch");
  assert.equal(status.mutatesOperationalState, false);
  assert.equal(Object.isFrozen(status), true);
  assert.equal(calls[0].rpc, AUDIT_RPC.readStatus);
  assert.deepEqual(calls[0].body, {
    p_workspace_key: "primary",
    p_finding_limit: 25,
    p_sync_token: "audit-token-at-least-sixteen-bytes",
  });
  await assert.rejects(() => ledger.readStatus({ findingLimit: 0 }), /findingLimit/);

  const staleShadow = laneReceipt({
    lane: PRODUCER_LANES.shadow,
    health: "stale",
    stale: true,
    runId: AUDIT_RUN_IDS[0],
  });
  const cleanStandalone = laneReceipt({
    lane: PRODUCER_LANES.standalone,
    health: "healthy",
    runId: AUDIT_RUN_IDS[1],
  });
  const staleStatus = await ledgerForReceipt(statusReceipt({
    shadow: staleShadow,
    standalone: cleanStandalone,
  })).readStatus();
  assert.equal(staleStatus.health, "stale");
  assert.equal(healthExitCode(staleStatus), 2);

  const degradedContext = shadowProducerContext({
    producerStatus: "degraded",
    workersDrained: false,
    sourceCutStatus: "not_run",
    sourceCutId: "",
    sourceCutCompleteness: "not_run",
    shadowBuildStatus: "not_run",
  });
  const degradedStatus = await ledgerForReceipt(statusReceipt({
    shadow: laneReceipt({
      lane: PRODUCER_LANES.shadow,
      health: "degraded",
      producerContext: degradedContext,
      runId: AUDIT_RUN_IDS[0],
    }),
    standalone: cleanStandalone,
  })).readStatus();
  assert.equal(degradedStatus.health, "degraded");
  assert.equal(healthExitCode(degradedStatus), 2);

  const failedStatus = await ledgerForReceipt(statusReceipt({
    shadow: laneReceipt({
      lane: PRODUCER_LANES.shadow,
      health: "failed",
      status: "failed",
      producerContext: shadowProducerContext({
        producerStatus: "failed",
        gmailSyncDisposition: "failed",
        workerRounds: 0,
        workersDrained: false,
        sourceCutStatus: "not_run",
        sourceCutId: "",
        sourceCutCompleteness: "not_run",
        shadowBuildStatus: "not_run",
        failureStage: "gmail_sync",
        failureCode: "GMAIL_SYNC_FAILED",
      }),
      runId: AUDIT_RUN_IDS[0],
    }),
    standalone: cleanStandalone,
  })).readStatus();
  assert.equal(failedStatus.health, "failed");

  const legacyMissing = statusReceipt({
    shadow: laneReceipt({
      lane: PRODUCER_LANES.shadow,
      health: "failed",
      producerContextValid: false,
      runId: AUDIT_RUN_IDS[0],
    }),
    standalone: cleanStandalone,
  });
  const legacy = await ledgerForReceipt(legacyMissing).readStatus();
  assert.equal(legacy.lanes[PRODUCER_LANES.shadow].producerStatus, "metadata_missing");
  assert.equal(legacy.health, "failed");

  await assertInvalid(statusReceipt({ overrides: { health: "healthy" } }), "top health cannot mask shadow regression");
  await assertInvalid(statusReceipt({ overrides: { stale: true } }), "top stale must reconcile");
  await assertInvalid(statusReceipt({ overrides: { counts: { blocking: 0, attention: 0, informational: 0 } } }), "top counts must reconcile");
  await assertInvalid(statusReceipt({ overrides: { findings: [] } }), "top finding inventory must reconcile");
  const badPolicy = statusReceipt();
  badPolicy.policy.lanes[PRODUCER_LANES.shadow].staleAfterSeconds = 601;
  await assertInvalid(badPolicy, "policy thresholds are exact");
  const badLatestRun = statusReceipt();
  badLatestRun.lanes[PRODUCER_LANES.shadow].latestRun.expectedIntervalSeconds = 301;
  await assertInvalid(badLatestRun, "latest run cadence is exact");
  const badLatestSuccess = statusReceipt();
  badLatestSuccess.lanes[PRODUCER_LANES.shadow].latestSuccess.expectedIntervalSeconds = 301;
  await assertInvalid(badLatestSuccess, "latest success cadence is exact");
  const extraTopField = statusReceipt();
  extraTopField.legacyHealth = "healthy";
  await assertInvalid(extraTopField, "top-level field set is exact");

  const expiredRunningShadow = laneReceipt({
    lane: PRODUCER_LANES.shadow,
    health: "stale",
    stale: true,
    status: "running",
    leaseExpired: true,
    runId: AUDIT_RUN_IDS[2],
  });
  const expired = await ledgerForReceipt(statusReceipt({
    shadow: expiredRunningShadow,
    standalone: cleanStandalone,
  })).readStatus();
  assert.equal(expired.lanes[PRODUCER_LANES.shadow].latestRun.leaseExpired, true);
  assert.equal(expired.health, "stale");

  const priorShadowContext = shadowProducerContext();
  const priorRegressionRun = latestRun({
    lane: PRODUCER_LANES.shadow,
    runId: AUDIT_RUN_IDS[0],
    producerContext: priorShadowContext,
    expectedIntervalSeconds: 300,
  });
  const runningOverRegression = laneReceipt({
    lane: PRODUCER_LANES.shadow,
    health: "regressions",
    status: "running",
    runId: AUDIT_RUN_IDS[2],
    findings: [finding()],
    latestCompleted: priorRegressionRun,
  });
  runningOverRegression.latestSuccess = latestSuccess(priorRegressionRun);
  runningOverRegression.lastSuccessfulFinishedAt = priorRegressionRun.finishedAt;
  runningOverRegression.secondsSinceLastSuccess = 20;
  const preserved = await ledgerForReceipt(statusReceipt({
    shadow: runningOverRegression,
    standalone: cleanStandalone,
  })).readStatus();
  assert.equal(preserved.health, "regressions");
  assert.equal(preserved.lanes[PRODUCER_LANES.shadow].latestRun.status, "running");
  assert.equal(
    preserved.lanes[PRODUCER_LANES.shadow].latestCompleted.auditRunId,
    priorRegressionRun.auditRunId,
  );

  const hiddenCompleted = structuredClone(statusReceipt({
    shadow: runningOverRegression,
    standalone: cleanStandalone,
  }));
  hiddenCompleted.lanes[PRODUCER_LANES.shadow].latestCompleted = null;
  await assertInvalid(hiddenCompleted, "a fresh run cannot erase the latest completed outcome");
  const badCompletedCadence = structuredClone(statusReceipt({
    shadow: runningOverRegression,
    standalone: cleanStandalone,
  }));
  badCompletedCadence.lanes[PRODUCER_LANES.shadow].latestCompleted.expectedIntervalSeconds = 301;
  await assertInvalid(badCompletedCadence, "latest completed cadence is exact");
  const forgedLegacyMetrics = statusReceipt({
    shadow: laneReceipt({
      lane: PRODUCER_LANES.shadow,
      health: "failed",
      producerContextValid: false,
      runId: AUDIT_RUN_IDS[0],
    }),
    standalone: cleanStandalone,
  });
  forgedLegacyMetrics.lanes[PRODUCER_LANES.shadow].latestRun.metrics.producerContext = { forged: true };
  forgedLegacyMetrics.lanes[PRODUCER_LANES.shadow].latestCompleted.metrics.producerContext = { forged: true };
  await assertInvalid(forgedLegacyMetrics, "legacy invalid metadata cannot expose a forged metric context");

  const standaloneAttention = finding({
    findingId: `truth-audit:v1:${"e".repeat(64)}`,
    severity: "attention",
    classification: "standalone_attention",
  });
  const globalBoundReceipt = statusReceipt({
    shadow: laneReceipt({
      lane: PRODUCER_LANES.shadow,
      health: "regressions",
      findings: [finding()],
      runId: AUDIT_RUN_IDS[0],
    }),
    standalone: laneReceipt({
      lane: PRODUCER_LANES.standalone,
      health: "attention",
      findings: [standaloneAttention],
      runId: AUDIT_RUN_IDS[1],
    }),
    findingLimit: 1,
  });
  const globallyBound = await ledgerForReceipt(globalBoundReceipt).readStatus({ findingLimit: 1 });
  assert.equal(globallyBound.findingCount, 2);
  assert.equal(globallyBound.findings.length, 1);
  assert.equal(globallyBound.findingsTruncated, true);

  const env = {
    PQ_TRUTH_AUDIT_STATUS_TOKEN: "status-token-at-least-sixteen-bytes",
    PQ_TRUTH_AUDIT_TOKEN: "audit-token-at-least-sixteen-bytes",
    PQ_SUPABASE_URL: "https://example.supabase.co",
    PQ_SUPABASE_ANON_KEY: "anon-key-at-least-sixteen-bytes",
  };
  const apiCalls = [];
  const handler = createTruthAuditStatusHandler({
    env,
    createLedger(options) {
      apiCalls.push(["create", options]);
      return {
        async readStatus(input) {
          apiCalls.push(["read", input]);
          return statusReceipt();
        },
      };
    },
  });
  const success = await invoke(handler);
  assert.equal(success.statusCode, 200);
  assert.equal(success.json().schemaVersion, "truth-audit-status-v2");
  assert.equal(success.json().health, "regressions");
  assert.equal(apiCalls[1][1].findingLimit, 25);
  assert.equal(success.headers["cache-control"], "no-store");
  assert.equal((await invoke(handler, { authorization: "Bearer wrong" })).statusCode, 401);
  assert.equal((await invoke(handler, { method: "POST" })).statusCode, 405);
  assert.equal((await invoke(createTruthAuditStatusHandler({ env: {} }))).statusCode, 503);
  const disabled = await invoke(createTruthAuditStatusHandler({
    env: { ...env, PQ_TRUTH_AUDIT_STATUS_DISABLED: "1" },
  }));
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabled.json().status, "disabled");

  const failedApi = await invoke(createTruthAuditStatusHandler({
    env,
    createLedger() {
      return {
        async readStatus() {
          const error = new Error("authorization=secret-value\nfailed");
          error.code = "STATUS_READ_FAILED";
          throw error;
        },
      };
    },
  }));
  assert.equal(failedApi.statusCode, 500);
  assert.equal(failedApi.body.includes("secret-value"), false);

  assert.equal(healthExitCode("healthy"), 0);
  assert.equal(healthExitCode("attention"), 0);
  assert.equal(healthExitCode("regressions"), 2);
  assert.equal(healthExitCode("degraded"), 2);
  assert.equal(healthExitCode("stale"), 2);
  assert.equal(healthExitCode("running"), 0);
  assert.equal(healthExitCode(statusReceipt()), 2);
  const maliciousTopGreen = statusReceipt({ overrides: { health: "healthy" } });
  assert.equal(healthExitCode(maliciousTopGreen), 2, "CLI inspects unhealthy lanes even before receipt validation");
  const cliStatus = await readTruthAuditStatus({
    env,
    findingLimit: 7,
    createLedger(options) {
      assert.equal(options.auditToken, env.PQ_TRUTH_AUDIT_TOKEN);
      return { readStatus: async (input) => ({ ...statusReceipt(), requestedLimit: input.findingLimit }) };
    },
  });
  assert.equal(cliStatus.requestedLimit, 7);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-audit-status-v2",
    lanes: [PRODUCER_LANES.shadow, PRODUCER_LANES.standalone],
    adversarialReceipts: 11,
    guarantees: [
      "lane policy, cadence, producer context, latest run, latest completed, and latest success are exact",
      "top health, staleness, counts, and finding inventory reconcile to both lanes",
      "one clean lane cannot mask stale, degraded, failed, or regressing sibling state",
      "legacy metadata absence is visible and fails closed",
      "the status API and CLI remain bounded and read-only",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

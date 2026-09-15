"use strict";

const {
  authorized,
  loadAppSnapshot,
  queueAgentJob,
  sendJson,
  upsertAppSnapshot,
} = require("../../lib/supabase-agent");
const {
  applyAutonomousDraftResults,
  autonomousDedupeKey,
  autonomousDraftRequest,
  selectAutonomousDraftActions,
} = require("../../lib/autonomous-drafts");

const SNAPSHOT_TIMEOUT_MS = 900;

function isDryRun(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("dryRun") === "1";
}

function draftsDisabled() {
  return process.env.PQ_AUTONOMOUS_DRAFTS_DISABLED === "1" || process.env.PQ_CRON_SUPABASE_PAUSED === "1";
}

async function loadRequiredSnapshot(snapshotKey, fallback) {
  try {
    return {
      ok: true,
      snapshot: await loadAppSnapshot(snapshotKey, fallback, {
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
        retryDelaysMs: [],
      }),
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      snapshot: fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function persistencePausedResult(source, error) {
  const result = {
    ok: false,
    paused: true,
    status: "persistence-paused",
    source,
    queued: 0,
    candidates: 0,
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    error,
    at: new Date().toISOString(),
  };
  console.warn(JSON.stringify({
    route: "autonomous-drafts",
    event: "persistence-paused",
    ...result,
  }));
  return result;
}

async function queueAutonomousDrafts({ dryRun = false } = {}) {
  const actionQueueResult = await loadRequiredSnapshot("action-queue", { actions: [] });
  if (!actionQueueResult.ok) {
    return persistencePausedResult("action-queue", actionQueueResult.error);
  }
  const outboxFallback = {
    sourceOfTruth:
      "Dashboard-created outbox requests are draft intents. The agent/Gmail transport must create drafts and mark them ready for human approval.",
    requests: [],
  };
  const outboxResult = await loadRequiredSnapshot("outbox-requests", outboxFallback);
  if (!outboxResult.ok) {
    return persistencePausedResult("outbox-requests", outboxResult.error);
  }
  const actionQueue = actionQueueResult.snapshot;
  const outbox = outboxResult.snapshot;
  const candidates = selectAutonomousDraftActions(actionQueue.actions || [], outbox.requests || []);
  const now = new Date().toISOString();

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      queued: 0,
      candidates: candidates.map((action) => ({
        actionId: action.id,
        awb: action.awb,
        type: action.type,
        targetName: action.targetName,
      })),
    };
  }

  const results = [];
  for (const action of candidates) {
    const preview = autonomousDraftRequest(action, now, null);
    const queueResult = await queueAgentJob(preview.draftPlan.jobType, preview.draftPlan.payload, {
      dedupeKey: autonomousDedupeKey(action),
      priority: action.priority === "high" ? 15 : 55,
      maxAttempts: 2,
    });
    const { draftPlan, request } = autonomousDraftRequest(action, now, queueResult.job || null);
    results.push({
      action,
      draftPlan,
      request: {
        ...request,
        agentJobId: queueResult.job?.id || null,
        duplicate: queueResult.duplicate || false,
      },
      queueResult,
    });
  }

  if (results.length) {
    const patched = applyAutonomousDraftResults(actionQueue, outbox, results, now);
    await Promise.all([
      upsertAppSnapshot("action-queue", patched.actionQueue),
      upsertAppSnapshot("outbox-requests", patched.outbox),
    ]);
  }

  return {
    ok: true,
    dryRun: false,
    queued: results.length,
    candidates: candidates.length,
    drafts: results.map((result) => ({
      actionId: result.action.id,
      awb: result.action.awb,
      type: result.action.type,
      targetName: result.action.targetName,
      agentJobId: result.request.agentJobId,
      duplicate: result.request.duplicate || false,
    })),
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const dryRun = isDryRun(request);
  if (!dryRun && !authorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  if (draftsDisabled()) {
    sendJson(response, 200, {
      ok: true,
      paused: true,
      status: "disabled",
      queued: 0,
      candidates: 0,
      reason: "Autonomous drafts are disabled by PQ_AUTONOMOUS_DRAFTS_DISABLED to protect Supabase availability.",
    });
    return;
  }

  try {
    sendJson(response, 200, await queueAutonomousDrafts({ dryRun }));
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

module.exports.queueAutonomousDrafts = queueAutonomousDrafts;

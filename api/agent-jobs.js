"use strict";

const { readJsonBody } = require("../lib/api-utils");
const {
  listAgentJobSummaries,
  queueAgentJob,
  sendJson,
} = require("../lib/supabase-agent");
const {
  canonicalGmailIngestionPolicy,
} = require("../lib/gmail-ingestion-authority");

const ALLOWED_BROWSER_JOB_TYPES = new Set([
  "full_refresh",
]);
const CANONICAL_INGESTION_OWNED_JOB_TYPES = new Set([
  "email_refresh",
]);

function requestLimit(request) {
  const url = new URL(request.url || "/", "http://localhost");
  const value = Number(url.searchParams.get("limit") || 60);
  if (!Number.isFinite(value)) return 60;
  return Math.min(100, Math.max(1, value));
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanDedupeKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return key ? key.slice(0, 220) : null;
}

function cleanPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function handleGet(request, response) {
  const timeoutMs = Number(process.env.PQ_AGENT_JOBS_TIMEOUT_MS || 900);
  try {
    const jobs = await listAgentJobSummaries(requestLimit(request), {
      timeoutMs,
      retryDelaysMs: [],
    });
    sendJson(response, 200, {
      ok: true,
      source: "agent_job_summaries",
      timeoutMs,
      snapshotTime: new Date().toISOString(),
      jobs,
    });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      source: "agent_job_summaries",
      status: "degraded",
      timeoutMs,
      snapshotTime: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      jobs: [],
    });
  }
}

async function handlePost(request, response) {
  const timeoutMs = Number(process.env.PQ_AGENT_QUEUE_TIMEOUT_MS || 2500);
  try {
    const body = await readJsonBody(request);
    const jobType = String(body.jobType || body.job_type || "").trim();
    if (CANONICAL_INGESTION_OWNED_JOB_TYPES.has(jobType)) {
      const policy = canonicalGmailIngestionPolicy();
      sendJson(response, 409, {
        ok: false,
        error: "legacy-gmail-ingestion-quarantined",
        queued: false,
        jobType,
        canonicalPipeline: policy.canonicalPipeline,
        rule: policy.rule,
        allowedJobTypes: Array.from(ALLOWED_BROWSER_JOB_TYPES),
      });
      return;
    }
    if (!ALLOWED_BROWSER_JOB_TYPES.has(jobType)) {
      sendJson(response, 400, {
        ok: false,
        error: "Unsupported dashboard job type",
        allowedJobTypes: Array.from(ALLOWED_BROWSER_JOB_TYPES),
      });
      return;
    }
    const result = await queueAgentJob(jobType, cleanPayload(body.payload), {
      dedupeKey: cleanDedupeKey(body.dedupeKey || body.dedupe_key),
      priority: clampInteger(body.priority, 50, 1, 200),
      maxAttempts: clampInteger(body.maxAttempts || body.max_attempts, 3, 1, 5),
      timeoutMs,
      retryDelaysMs: [],
    });
    sendJson(response, 200, {
      ok: true,
      source: "agent_jobs",
      timeoutMs,
      snapshotTime: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      source: "agent_jobs",
      status: "degraded",
      timeoutMs,
      snapshotTime: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      queued: false,
      duplicate: false,
      job: null,
    });
  }
}

module.exports = async function handler(request, response) {
  if (request.method === "GET") {
    await handleGet(request, response);
    return;
  }

  if (request.method === "POST") {
    await handlePost(request, response);
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
};

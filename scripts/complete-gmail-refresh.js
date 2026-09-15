#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { runOpsSync } = require("../ops-sync");
const {
  assertLegacyGmailIngestionAllowed,
  legacyGmailIngestionChildEnv,
} = require("../lib/gmail-ingestion-authority");

const ROOT_DIR = path.resolve(__dirname, "..");

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function relativeResultPath(value) {
  const resultPath = value || "gmail-enrichment-update.json";
  return path.isAbsolute(resultPath) ? path.relative(ROOT_DIR, resultPath) : resultPath;
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT_DIR, relativePath), "utf8"));
}

function parseCommandJson(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  return JSON.parse(text);
}

function runNodeScript(script, args = []) {
  const output = execFileSync(process.execPath, [path.join(ROOT_DIR, script), ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: legacyGmailIngestionChildEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseCommandJson(output);
}

async function completeLocalEmailSyncRequest(jobId, resultPath, counts, workerId) {
  if (!jobId) return { skipped: true, reason: "no job id" };
  const queuePath = path.join(ROOT_DIR, "email-sync-requests.json");
  let queue = null;
  try {
    queue = JSON.parse(await fs.readFile(queuePath, "utf8"));
  } catch {
    return { skipped: true, reason: "email-sync-requests.json missing" };
  }
  const requests = Array.isArray(queue.requests) ? queue.requests : [];
  const index = requests.findIndex((request) => request?.id === jobId);
  if (index === -1) return { skipped: true, reason: "request not found" };
  const now = new Date().toISOString();
  requests[index] = {
    ...requests[index],
    status: "completed",
    completedAt: now,
    resultPath,
    counts,
    workerId: workerId || requests[index].lockedBy || "",
  };
  await fs.writeFile(queuePath, `${JSON.stringify({ ...queue, snapshotTime: now, requests }, null, 2)}\n`);
  return { completed: true, requestId: jobId };
}

function validateEnrichmentUpdate(update = {}) {
  const counts = {
    proofs: Array.isArray(update.proofs) ? update.proofs.length : 0,
    dispatches: Array.isArray(update.dispatches) ? update.dispatches.length : 0,
    brokers: Array.isArray(update.brokers) ? update.brokers.length : 0,
    facts: Array.isArray(update.facts) ? update.facts.length : 0,
  };
  const total = counts.proofs + counts.dispatches + counts.brokers + counts.facts;
  if (!total) {
    throw new Error("gmail-enrichment update is empty; refusing to complete refresh without durable shipment truth");
  }
  return counts;
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function coveredAwbs(update = {}) {
  const covered = new Set();
  for (const collection of [update.proofs, update.dispatches, update.brokers, update.facts]) {
    for (const record of collection || []) {
      const key = normalizeAwb(record?.awb || record?.normalizedAwb);
      if (key) covered.add(key);
    }
  }
  return covered;
}

function skippedAwbs(update = {}) {
  const skipped = new Set();
  const items = [
    ...(update.audit?.skippedAwbs || []),
    ...(update.audit?.skippedAWBs || []),
    ...(update.audit?.skipped || []),
  ];
  for (const item of items) {
    const key = normalizeAwb(typeof item === "string" ? item : item?.awb || item?.normalizedAwb);
    if (key) skipped.add(key);
  }
  return skipped;
}

async function localEmailSyncRequest(jobId) {
  if (!jobId) return null;
  try {
    const queue = await readJson("email-sync-requests.json");
    return (queue.requests || []).find((request) => request?.id === jobId) || null;
  } catch {
    return null;
  }
}

function requestedAwbs(request = {}) {
  request = request || {};
  return [...new Set([
    request.awb,
    ...(request.awbs || []),
  ].map(normalizeAwb).filter(Boolean))];
}

function validateRequestedAwbCoverage(update = {}, expectedAwbs = []) {
  const expected = [...new Set((expectedAwbs || []).map(normalizeAwb).filter(Boolean))];
  if (!expected.length) return [];
  const covered = coveredAwbs(update);
  const skipped = skippedAwbs(update);
  const missing = expected.filter((awb) => !covered.has(awb) && !skipped.has(awb));
  if (missing.length) {
    throw new Error(`gmail-enrichment update is missing requested AWB coverage: ${missing.join(", ")}`);
  }
  return missing;
}

async function rebuildLocalTruth() {
  return runOpsSync({
    rootDir: ROOT_DIR,
    onProgress: () => {},
  });
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/complete-gmail-refresh.js");
  const resultPath = relativeResultPath(argValue("--result", "gmail-enrichment-update.json"));
  const update = await readJson(resultPath);
  const explicitJobId = argValue("--job-id", "");
  const jobId = explicitJobId || update.jobId || "";
  const localRequest = await localEmailSyncRequest(jobId);
  const counts = validateEnrichmentUpdate(update);
  validateRequestedAwbCoverage(update, requestedAwbs(localRequest));
  const workerId = argValue("--worker-id", update.workerId || "");
  const dryRun = hasFlag("--dry-run");
  const skipSync = hasFlag("--skip-sync");
  const skipComplete = hasFlag("--skip-complete") || !jobId || !isUuid(jobId);

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      resultPath,
      jobId: jobId || null,
      counts,
      steps: [
        "merge-gmail-enrichment",
        "rebuild-ops-sync",
        ...(skipSync ? [] : ["sync-supabase-snapshots"]),
        "complete-local-email-sync-request",
        ...(skipComplete ? [] : ["complete-agent-job"]),
      ],
      skipCompleteReason: skipComplete
        ? hasFlag("--skip-complete")
          ? "skip-complete flag"
          : !jobId
          ? "no job id"
          : "job id is not a Supabase UUID; local email-sync request completion still applies"
        : "",
    }, null, 2));
    return;
  }

  const merged = runNodeScript("scripts/merge-gmail-enrichment.js", [resultPath]);
  const refreshed = await rebuildLocalTruth();
  const synced = skipSync
    ? { skipped: true }
    : runNodeScript("scripts/sync-supabase-snapshots.js");
  const completed = skipComplete
    ? { skipped: true, reason: hasFlag("--skip-complete") ? "skip-complete flag" : !jobId ? "no job id" : "job id is not a Supabase UUID; local email-sync request completion still applies" }
    : runNodeScript("scripts/gmail-job.js", [
      "complete",
      "--job-id",
      jobId,
      "--result",
      resultPath,
      ...(workerId ? ["--worker-id", workerId] : []),
    ]);
  const localRequestCompleted = await completeLocalEmailSyncRequest(jobId, resultPath, counts, workerId);

  console.log(JSON.stringify({
    ok: true,
    resultPath,
    jobId: jobId || null,
    counts,
    merged,
    refreshed,
    synced,
    completed,
    localRequestCompleted,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  isUuid,
  relativeResultPath,
  requestedAwbs,
  validateEnrichmentUpdate,
  validateRequestedAwbCoverage,
};

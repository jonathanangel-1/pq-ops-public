#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
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

async function loadDotEnvLocal() {
  try {
    const content = await fs.readFile(path.join(ROOT_DIR, ".env.local"), "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    });
  } catch {
    // Env can be supplied by the caller.
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function headers() {
  const key = requireEnv("PQ_SUPABASE_ANON_KEY");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

async function rest(pathname, searchParams = {}) {
  const url = new URL(`${requireEnv("PQ_SUPABASE_URL")}/rest/v1/${pathname}`);
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await fetch(url, { headers: headers() });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${pathname} lookup failed: ${response.status} ${text}`);
  return payload;
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAvailable(job, now = Date.now()) {
  const availableAt = timestamp(job.available_at);
  return !availableAt || availableAt <= now;
}

function runGmailJob(args) {
  const output = execFileSync(process.execPath, [path.join(ROOT_DIR, "scripts", "gmail-job.js"), ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: legacyGmailIngestionChildEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

async function writeContextArtifact(fileName, claim) {
  if (!fileName) return null;
  const relativePath = path.isAbsolute(fileName) ? path.relative(ROOT_DIR, fileName) : fileName;
  const outputPath = path.join(ROOT_DIR, relativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(claim, null, 2)}\n`);
  return relativePath;
}

function summarizeClaim(claim, contextFile = null) {
  const queryCount = Array.isArray(claim.queries)
    ? claim.queries.reduce((count, shipment) => count + (shipment.suggestedQueries?.length || 0), 0)
    : 0;
  return {
    ok: true,
    claimed: Boolean(claim.claimed),
    workerId: claim.workerId || null,
    job: claim.job
      ? {
          id: claim.job.id,
          job_type: claim.job.job_type,
          status: claim.job.status,
          priority: claim.job.priority,
          attempts: claim.job.attempts,
          max_attempts: claim.job.max_attempts,
          payload: {
            awbs: claim.job.payload?.awbs || [],
            sourceBackfill: Boolean(claim.job.payload?.sourceBackfill),
            lookbackDays: claim.job.payload?.lookbackDays || null,
          },
        }
      : null,
    shipmentCount: claim.shipmentCount || 0,
    activeShipmentCount: claim.activeShipmentCount || 0,
    sourceBackfillShipmentCount: claim.sourceBackfillShipmentCount || 0,
    queryCount,
    outputFile: claim.outputContract?.file || null,
    completionCommand: claim.outputContract?.completionCommand || null,
    contextFile,
  };
}

async function pendingRefreshJobs() {
  return rest("agent_jobs", {
    select: "id,status,created_at,updated_at,available_at,locked_by,locked_at,last_error",
    job_type: "eq.email_refresh",
    status: "in.(queued,waiting_external,running)",
    order: "created_at.desc",
    limit: "20",
  });
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/claim-gmail-refresh.js");
  await loadDotEnvLocal();
  const jobs = await pendingRefreshJobs();
  const running = jobs.find((job) => job.status === "running");
  if (running) {
    console.log(JSON.stringify({
      ok: true,
      claimed: false,
      reason: "Email refresh is already running",
      runningJobId: running.id,
      lockedBy: running.locked_by,
    }, null, 2));
    return;
  }

  const claimable = jobs.filter((job) => ["queued", "waiting_external"].includes(job.status) && isAvailable(job));
  if (!claimable.length) {
    console.log(JSON.stringify({
      ok: true,
      claimed: false,
      reason: "No claimable email_refresh job",
      pendingRefreshCount: jobs.length,
      nextAvailableAt: jobs[0]?.available_at || null,
    }, null, 2));
    return;
  }

  const claim = runGmailJob(["claim"]);
  const jobType = claim.job?.job_type || "";
  if (!claim.claimed || jobType === "email_refresh") {
    const contextFile = await writeContextArtifact(argValue("--context-file"), claim);
    console.log(JSON.stringify(
      hasFlag("--summary") || contextFile ? summarizeClaim(claim, contextFile) : claim,
      null,
      2
    ));
    return;
  }

  runGmailJob([
    "fail",
    "--job-id",
    claim.job.id,
    "--worker-id",
    claim.workerId,
    "--error",
    "refresh-only-claim-released-non-refresh-job",
  ]);
  console.log(JSON.stringify({
    ok: true,
    claimed: false,
    reason: "Released unexpected non-refresh Gmail job",
    releasedJobId: claim.job.id,
    releasedJobType: jobType,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

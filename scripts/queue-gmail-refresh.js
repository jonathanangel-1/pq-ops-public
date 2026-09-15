#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  assertBetaSafeJobType,
  betaDraftModeContract,
} = require("../lib/supabase-agent");
const {
  assertLegacyGmailIngestionAllowed,
} = require("../lib/gmail-ingestion-authority");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INTERVAL_MINUTES = 30;

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

function headers(extra = {}) {
  const key = requireEnv("PQ_SUPABASE_ANON_KEY");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function activeSnapshotAgeMs(active, now) {
  const snapshotTime = Date.parse(active?.snapshotTime || "");
  if (!Number.isFinite(snapshotTime)) return Infinity;
  return now.getTime() - snapshotTime;
}

async function fetchRecentEmailJobs() {
  const url = new URL(`${requireEnv("PQ_SUPABASE_URL")}/rest/v1/agent_jobs`);
  url.searchParams.set("select", "id,status,created_at,updated_at,locked_at,completed_at,last_error");
  url.searchParams.set("job_type", "eq.email_refresh");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "20");
  const response = await fetch(url, { headers: headers() });
  const text = await response.text();
  if (!response.ok) throw new Error(`email_refresh lookup failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : [];
}

function staleJobAgeMs(job, now) {
  const timestamp = Date.parse(job.locked_at || job.updated_at || job.created_at || "");
  return Number.isFinite(timestamp) ? now.getTime() - timestamp : Infinity;
}

function staleJobThresholdMs(intervalMinutes) {
  return Math.max(30, Math.max(1, intervalMinutes) * 3) * 60 * 1000;
}

function isStaleInFlightJob(job, intervalMinutes, now) {
  if (!["queued", "running", "waiting_external"].includes(job.status)) return false;
  return staleJobAgeMs(job, now) > staleJobThresholdMs(intervalMinutes);
}

function shouldQueue(jobs, intervalMinutes, now) {
  const inFlight = jobs.find(
    (job) => ["queued", "running", "waiting_external"].includes(job.status) && !isStaleInFlightJob(job, intervalMinutes, now),
  );
  if (inFlight) {
    return {
      queue: false,
      reason: `Existing ${inFlight.status} email refresh job`,
      job: inFlight,
    };
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  const lastSuccess = jobs.find((job) => job.status === "succeeded" && job.completed_at);
  if (lastSuccess) {
    const completedAt = Date.parse(lastSuccess.completed_at);
    if (Number.isFinite(completedAt) && now.getTime() - completedAt < intervalMs) {
      return {
        queue: false,
        reason: `Last email refresh succeeded less than ${intervalMinutes} minutes ago`,
        job: lastSuccess,
      };
    }
  }

  return { queue: true };
}

async function createEmailRefreshJob(awbs, intervalMinutes, now) {
  assertBetaSafeJobType("email_refresh");
  const bucket = Math.floor(now.getTime() / (intervalMinutes * 60 * 1000));
  const body = {
    job_type: "email_refresh",
    status: "queued",
    payload: {
      source: "auto-gmail-refresh",
      cadenceMinutes: intervalMinutes,
      awbs,
      betaContract: betaDraftModeContract(),
      requestedAt: now.toISOString(),
    },
    dedupe_key: `auto:gmail-refresh:${bucket}`,
    priority: 5,
    max_attempts: 2,
  };

  const response = await fetch(`${requireEnv("PQ_SUPABASE_URL")}/rest/v1/agent_jobs`, {
    method: "POST",
    headers: headers({ prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 409) {
    return { queued: false, duplicate: true, reason: "Refresh already queued for this interval" };
  }
  if (!response.ok) throw new Error(`email_refresh insert failed: ${response.status} ${text}`);
  const rows = text ? JSON.parse(text) : [];
  return { queued: true, job: Array.isArray(rows) ? rows[0] : rows };
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/queue-gmail-refresh.js");
  await loadDotEnvLocal();
  const now = new Date();
  const intervalMinutes = Number(argValue("--interval-minutes", String(DEFAULT_INTERVAL_MINUTES)));
  const active = await readJson("shipment-truth-packets.json", { shipments: [] });
  const snapshotAgeMs = activeSnapshotAgeMs(active, now);
  const awbs = [
    ...new Set((active.shipments || [])
      .filter((shipment) => !shipment.truthPacketRole || shipment.truthPacketRole === "active")
      .map((shipment) => shipment.awb)
      .filter(Boolean)),
  ].filter((awb) => normalizeAwb(awb));

  if (!awbs.length) {
    console.log(JSON.stringify({ ok: true, queued: false, reason: "No active AWBs found" }, null, 2));
    return;
  }

  const jobs = await fetchRecentEmailJobs();
  const decision = shouldQueue(jobs, intervalMinutes, now);
  if (!decision.queue) {
    console.log(JSON.stringify({ ok: true, queued: false, ...decision }, null, 2));
    return;
  }

  if (hasFlag("--dry-run")) {
    console.log(JSON.stringify({
      ok: true,
      queued: false,
      dryRun: true,
      reason: "Would queue auto Gmail refresh",
      awbCount: awbs.length,
      snapshotRefreshed: false,
      snapshotPolicy: "gmail-queue-never-runs-tms-or-carrier-tracking",
      activeSnapshotAgeMs: snapshotAgeMs,
      cadenceMinutes: intervalMinutes,
      betaContract: betaDraftModeContract(),
    }, null, 2));
    return;
  }

  const result = await createEmailRefreshJob(awbs, intervalMinutes, now);
  console.log(JSON.stringify({
    ok: true,
    awbCount: awbs.length,
    snapshotRefreshed: false,
    snapshotPolicy: "gmail-queue-never-runs-tms-or-carrier-tracking",
    activeSnapshotAgeMs: snapshotAgeMs,
    activeSnapshotTime: active.snapshotTime || null,
    cadenceMinutes: intervalMinutes,
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

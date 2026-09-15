"use strict";

const {
  authorized,
  betaDraftModeContract,
  loadActiveAwbs,
  localDateParts,
  queueAgentJob,
  recentJobs,
  sendJson,
} = require("../../lib/supabase-agent");

const TIME_ZONE = "America/New_York";
const MORNING_REFRESH_HOUR = 6;

function isDryRun(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("dryRun") === "1";
}

function forceRun(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("force") === "1";
}

function localRunKey(now) {
  const parts = localDateParts(now, TIME_ZONE);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function alreadyQueuedToday(jobs, dateKey) {
  return jobs.find((job) => job.dedupe_key === `morning-full-refresh:${dateKey}`);
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

  // Emergency pause: this cron reads/queues against hosted Supabase; it must be stoppable
  // without a deploy when the database is under pressure.
  if (process.env.PQ_MORNING_REFRESH_DISABLED === "1" || process.env.PQ_CRON_SUPABASE_PAUSED === "1") {
    sendJson(response, 200, {
      ok: true,
      status: "disabled",
      reason: "Morning refresh cron is paused by PQ_MORNING_REFRESH_DISABLED/PQ_CRON_SUPABASE_PAUSED to protect Supabase availability.",
    });
    return;
  }

  try {
    const now = new Date();
    const local = localRunKey(now);
    const forced = forceRun(request);
    const [{ awbs, snapshotTime }, jobs] = await Promise.all([
      loadActiveAwbs(),
      recentJobs("full_refresh", 30),
    ]);

    if (!forced && local.hour !== MORNING_REFRESH_HOUR) {
      sendJson(response, 200, {
        ok: true,
        queued: false,
        reason: `Outside ${MORNING_REFRESH_HOUR}:00 ${TIME_ZONE}`,
        local,
        awbCount: awbs.length,
      });
      return;
    }

    const existing = alreadyQueuedToday(jobs, local.dateKey);
    if (existing) {
      sendJson(response, 200, {
        ok: true,
        queued: false,
        reason: "Morning refresh already queued today",
        job: existing,
        local,
      });
      return;
    }

    const job = {
      jobType: "full_refresh",
      dedupeKey: `morning-full-refresh:${local.dateKey}`,
      localDate: local.dateKey,
      timeZone: TIME_ZONE,
      awbCount: awbs.length,
      snapshotTime,
      betaContract: betaDraftModeContract(),
    };

    if (dryRun) {
      sendJson(response, 200, { ok: true, queued: false, dryRun: true, ...job });
      return;
    }

    const result = await queueAgentJob(
      "full_refresh",
      {
        source: "vercel-cron-morning-refresh",
        localDate: local.dateKey,
        timeZone: TIME_ZONE,
        awbs,
        snapshotTime,
        betaContract: job.betaContract,
        requestedAt: now.toISOString(),
      },
      {
        dedupeKey: job.dedupeKey,
        priority: 20,
        maxAttempts: 2,
      },
    );

    sendJson(response, 200, { ok: true, ...job, ...result });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

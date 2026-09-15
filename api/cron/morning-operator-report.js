"use strict";

const path = require("node:path");
const { buildMorningOperatorReport, TIME_ZONE } = require("../../lib/morning-operator-report");
const { deliverPendingOperatorPushes, upsertOperatorEvents } = require("../../lib/operator-events");
const { authorized, localDateParts, sendJson } = require("../../lib/supabase-agent");

const MORNING_REPORT_HOUR = 7;

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
  if (process.env.PQ_MORNING_REPORT_DISABLED === "1" || process.env.PQ_CRON_SUPABASE_PAUSED === "1") {
    sendJson(response, 200, {
      ok: true,
      status: "disabled",
      reason: "Morning operator report cron is paused by PQ_MORNING_REPORT_DISABLED/PQ_CRON_SUPABASE_PAUSED to protect Supabase availability.",
    });
    return;
  }

  try {
    const now = new Date();
    const local = localRunKey(now);
    const forced = forceRun(request);
    if (!forced && local.hour !== MORNING_REPORT_HOUR) {
      sendJson(response, 200, {
        ok: true,
        queued: false,
        reason: `Outside ${MORNING_REPORT_HOUR}:00 ${TIME_ZONE}`,
        local,
      });
      return;
    }

    const built = await buildMorningOperatorReport({
      rootDir: path.join(__dirname, "../.."),
      now,
      localDate: local.dateKey,
      timeZone: TIME_ZONE,
      env: process.env,
    });

    if (dryRun) {
      sendJson(response, 200, {
        ok: true,
        dryRun: true,
        queued: false,
        local,
        event: built.event,
        report: built.report,
      });
      return;
    }

    const eventResult = await upsertOperatorEvents([built.event]);
    const pushResult = await deliverPendingOperatorPushes({ limit: 10 });
    sendJson(response, 200, {
      ok: true,
      queued: Boolean(eventResult?.queuedPushCount),
      local,
      eventResult,
      pushResult,
      event: {
        eventId: built.event.eventId,
        title: built.event.title,
        message: built.event.message,
        nextAction: built.event.nextAction,
      },
      report: built.report,
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

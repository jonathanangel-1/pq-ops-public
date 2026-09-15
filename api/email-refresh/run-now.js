"use strict";

// Operator-triggered email refresh — ONE production refresh model.
//
// This route is server-to-server only. A protected-origin caller must cross
// Vercel Deployment Protection and then present PQ_EMAIL_REFRESH_RUN_NOW_TOKEN.
// The route invokes the exact same Gmail refresh handler as the cron, using
// CRON_SECRET only inside the server. Browser callers are deliberately retired
// until the product has real operator-session authorization.
//
// Guard: if a successful run finished moments ago, say so instead of burning
// a duplicate Gmail pass — that is still a truthful "checked, no new mail".

const crypto = require("node:crypto");
const cronHandler = require("../cron/gmail-refresh");
const { loadAppSnapshotMetadataRows, sendJson } = require("../../lib/supabase-agent");

const RECENT_RUN_SECONDS = 45;

function bearer(request) {
  const header = String(request?.headers?.authorization || request?.headers?.Authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const supplied = Buffer.from(actual, "utf8");
  const configured = Buffer.from(expected, "utf8");
  return supplied.length === configured.length && crypto.timingSafeEqual(supplied, configured);
}

function safeDetail(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|access_token|refresh_token|client_secret|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

async function lastSuccessfulRunSecondsAgo(loadMetadata = loadAppSnapshotMetadataRows) {
  try {
    const rows = await loadMetadata(["gmail-refresh-health"], { timeoutMs: 1200, retryDelaysMs: [] });
    const row = (rows || [])[0];
    if (!row) return null;
    const writer = String(row.writer_version || row.writerVersion || "");
    if (!/\+status-success/.test(writer)) return null;
    const at = Date.parse(row.snapshot_time || row.snapshotTime || row.updated_at || "");
    if (!Number.isFinite(at)) return null;
    return Math.round((Date.now() - at) / 1000);
  } catch {
    return null;
  }
}

function classifyOutcome(cronBody) {
  if (!cronBody || cronBody.ok === false) {
    return { outcome: "failed", phase: cronBody?.phase || cronBody?.failedPhase || "unknown", reason: cronBody?.error || "Refresh failed." };
  }
  if (cronBody.paused || cronBody.skipped) {
    return { outcome: "blocked", reason: cronBody.reason || "Refresh is paused or outside its active window." };
  }
  if (cronBody.changed || cronBody.truthPacketsChanged) {
    return { outcome: "updated", reason: "New email evidence was found and applied to shipment truth." };
  }
  return { outcome: "no-new-mail", reason: "Gmail was checked; no new email changed shipment truth." };
}

function createRunNowHandler(options = {}) {
  const env = options.env || process.env;
  const runCron = options.cronHandler || cronHandler;
  const loadMetadata = options.loadMetadata || loadAppSnapshotMetadataRows;
  const respond = options.sendJson || sendJson;

  return async function handler(request, response) {
    response.setHeader?.("cache-control", "private, no-store");
    if (request.method !== "POST") {
      respond(response, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Method not allowed" });
      return;
    }

    const routeSecret = String(env.PQ_EMAIL_REFRESH_RUN_NOW_TOKEN || "");
    if (routeSecret.length < 32) {
      respond(response, 503, {
        ok: false,
        outcome: "blocked",
        code: "EMAIL_REFRESH_RUN_NOW_NOT_CONFIGURED",
        reason: "The server-to-server email refresh route is not configured.",
      });
      return;
    }
    if (!tokenMatches(bearer(request), routeSecret)) {
      respond(response, 401, {
        ok: false,
        outcome: "blocked",
        code: "EMAIL_REFRESH_RUN_NOW_UNAUTHORIZED",
        reason: "Unauthorized",
      });
      return;
    }

    const secret = String(env.CRON_SECRET || "");
    if (!secret) {
      respond(response, 503, {
        ok: false,
        outcome: "blocked",
        code: "EMAIL_REFRESH_CRON_NOT_CONFIGURED",
        reason: "The internal Gmail refresh authority is not configured.",
      });
      return;
    }

  const requestUrl = new URL(request.url || "/", "http://localhost");
  const forced = ["1", "true", "yes"].includes(String(requestUrl.searchParams.get("force") || "").toLowerCase());
  const trigger = String(requestUrl.searchParams.get("trigger") || "operator-run-now").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "operator-run-now";
  const recentSeconds = forced ? null : await lastSuccessfulRunSecondsAgo(loadMetadata);
  if (!forced && recentSeconds !== null && recentSeconds < RECENT_RUN_SECONDS) {
    respond(response, 200, {
      ok: true,
      ranNow: false,
      outcome: "no-new-mail",
      reason: `A successful refresh finished ${recentSeconds}s ago; Gmail is already current.`,
      lastRunSecondsAgo: recentSeconds,
    });
    return;
  }

  // Run the REAL production refresh handler in-process with server-side
  // authorization. force=1 bypasses the active-hours window for an explicit
  // operator request.
  const syntheticRequest = {
    method: "POST",
    url: `/api/cron/gmail-refresh?force=1&trigger=${encodeURIComponent(trigger)}`,
    headers: { authorization: `Bearer ${secret}` },
  };
  let statusCode = 0;
  let body = null;
  const syntheticResponse = {
    statusCode: 200,
    setHeader() {},
    end(payload) {
      statusCode = this.statusCode;
      try { body = JSON.parse(String(payload || "{}")); } catch { body = null; }
    },
  };
  const startedAt = new Date().toISOString();
  try {
    await runCron(syntheticRequest, syntheticResponse);
  } catch (error) {
    respond(response, 200, {
      ok: false,
      ranNow: true,
      outcome: "failed",
      phase: "handler",
      reason: safeDetail(error instanceof Error ? error.message : String(error)),
      startedAt,
    });
    return;
  }
  const classified = classifyOutcome(statusCode >= 200 && statusCode < 300 ? body : { ok: false, ...(body || {}) });
  respond(response, 200, {
    ok: classified.outcome !== "failed",
    ranNow: true,
    forced,
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...classified,
    refresh: body ? {
      changed: Boolean(body.changed),
      updated: body.updated ?? null,
      truthPacketsChanged: Boolean(body.truthPacketsChanged),
      gmailCoverageStatus: body.gmailCoverageStatus || null,
      gmailCoverageProblemCount: body.gmailCoverageProblemCount ?? null,
      tmsSnapshotWrites: body.tmsSnapshotWrites || [],
      heavySnapshotWrites: body.heavySnapshotWrites || [],
      snapshotLoadWarnings: body.snapshotLoadWarnings || [],
      hostedSnapshotReadsSkipped: Boolean(body.hostedSnapshotReadsSkipped),
      truthPacketActiveShipmentCount: body.truthPacketActiveShipmentCount ?? null,
      phase: body.phase || null,
    } : null,
    });
  };
}

const handler = createRunNowHandler();

module.exports = handler;

module.exports._test = {
  RECENT_RUN_SECONDS,
  bearer,
  classifyOutcome,
  createRunNowHandler,
  safeDetail,
  tokenMatches,
};

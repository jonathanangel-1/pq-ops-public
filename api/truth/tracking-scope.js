"use strict";

const crypto = require("node:crypto");
const { createTruthTrackingScopeLedger } = require("../../lib/truth-tracking-scope-ledger");

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function bearer(request) {
  const header = String(request?.headers?.authorization || request?.headers?.Authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function secretMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createTrackingScopeHandler(options = {}) {
  const env = options.env || process.env;
  const createLedger = options.createLedger || ((ledgerOptions) => createTruthTrackingScopeLedger(ledgerOptions));
  const respond = options.sendJson || sendJson;
  return async function trackingScopeHandler(request, response) {
    if (request.method !== "POST") {
      respond(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const expected = String(env.PQ_TRUTH_TRACKING_INGEST_TOKEN || "");
    if (expected.length < 16 || !secretMatches(bearer(request), expected)) {
      respond(response, expected.length < 16 ? 503 : 401, {
        ok: false,
        code: expected.length < 16 ? "TRUTH_TRACKING_SCOPE_NOT_CONFIGURED" : "TRUTH_TRACKING_SCOPE_UNAUTHORIZED",
        error: expected.length < 16 ? "Tracking scope authority is not configured" : "Unauthorized",
      });
      return;
    }
    if (env.PQ_TRUTH_SOURCE_INGEST_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1") {
      respond(response, 503, {
        ok: false,
        code: "TRUTH_TRACKING_SCOPE_DISABLED",
        error: "Truth source ingestion is paused.",
      });
      return;
    }
    try {
      const ledger = createLedger({
        workspaceKey: env.PQ_TRUTH_WORKSPACE || "primary",
        syncToken: env.PQ_SUPABASE_SYNC_TOKEN,
      });
      const result = await ledger.issue({
        ttlSeconds: Number(env.PQ_TRUTH_TRACKING_SCOPE_TTL_SECONDS || 900),
        issuedBy: "hosted-tracking-collector-v1",
      });
      respond(response, 200, result);
    } catch (error) {
      respond(response, error?.retryable ? 503 : 422, {
        ok: false,
        code: error?.code || "TRUTH_TRACKING_SCOPE_FAILED",
        error: error instanceof Error ? error.message : String(error),
        retryable: error?.retryable === true,
      });
    }
  };
}

const handler = createTrackingScopeHandler();
module.exports = handler;
module.exports._test = Object.freeze({ createTrackingScopeHandler, secretMatches });

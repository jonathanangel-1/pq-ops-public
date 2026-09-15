"use strict";

const crypto = require("node:crypto");
const { createTruthAuditLedger } = require("../../lib/truth-audit-ledger");

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
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

function findingLimit(request) {
  const url = new URL(request?.url || "/", "http://localhost");
  const value = Number(url.searchParams.get("limit") || 50);
  return Number.isSafeInteger(value) && value >= 1 && value <= 200 ? value : 50;
}

function safeError(error) {
  return String(error?.message || "Truth audit status failed")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function createTruthAuditStatusHandler(options = {}) {
  const env = options.env || process.env;
  const createLedger = options.createLedger || ((ledgerOptions) => createTruthAuditLedger(ledgerOptions));
  const respond = options.sendJson || sendJson;

  return async function truthAuditStatusHandler(request, response) {
    if (request.method !== "GET") {
      respond(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const expected = String(env.PQ_TRUTH_AUDIT_STATUS_TOKEN || "");
    if (expected.length < 16 || !secretMatches(bearer(request), expected)) {
      respond(response, expected.length < 16 ? 503 : 401, {
        ok: false,
        code: expected.length < 16 ? "TRUTH_AUDIT_STATUS_NOT_CONFIGURED" : "TRUTH_AUDIT_STATUS_UNAUTHORIZED",
        error: expected.length < 16 ? "Truth audit status access is not configured" : "Unauthorized",
        mutatesOperationalState: false,
      });
      return;
    }
    if (env.PQ_TRUTH_AUDIT_STATUS_DISABLED === "1") {
      respond(response, 503, {
        ok: false,
        status: "disabled",
        code: "TRUTH_AUDIT_STATUS_DISABLED",
        error: "Truth audit status access is paused.",
        mutatesOperationalState: false,
      });
      return;
    }
    try {
      const ledger = createLedger({
        workspaceKey: env.PQ_TRUTH_AUDIT_WORKSPACE || "primary",
        auditToken: env.PQ_TRUTH_AUDIT_TOKEN,
        supabaseUrl: env.PQ_SUPABASE_URL,
        apiKey: env.PQ_SUPABASE_ANON_KEY,
      });
      const result = await ledger.readStatus({ findingLimit: findingLimit(request) });
      respond(response, 200, result);
    } catch (error) {
      respond(response, error?.retryable ? 503 : 500, {
        ok: false,
        status: "failed",
        code: error?.code || "TRUTH_AUDIT_STATUS_FAILED",
        error: safeError(error),
        retryable: error?.retryable === true,
        mutatesOperationalState: false,
      });
    }
  };
}

const handler = createTruthAuditStatusHandler();
module.exports = handler;
module.exports._test = Object.freeze({
  createTruthAuditStatusHandler,
  findingLimit,
  safeError,
  secretMatches,
});

"use strict";

const crypto = require("node:crypto");
const { createRelationalTruthAuditRunner } = require("../../lib/relational-truth-audit-runner");
const {
  createTruthAuditLedger,
  standaloneAuditProducerContext,
} = require("../../lib/truth-audit-ledger");
const { createRuntimeDeadline, isAbortError } = require("../../lib/runtime-deadline");

const WITNESS_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const PROTECTION_BYPASS_RE = /^[A-Za-z0-9_-]{16,256}$/;

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function authorizationHeader(request) {
  return String(request?.headers?.authorization || request?.headers?.Authorization || "");
}

function secretMatches(request, secret) {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const supplied = Buffer.from(authorizationHeader(request), "utf8");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return Number(value);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) return fallback;
  return candidate;
}

function safeCode(error) {
  return String(error?.code || "TRUTH_AUDIT_RUN_FAILED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 100) || "TRUTH_AUDIT_RUN_FAILED";
}

function safeError(error) {
  return String(error?.message || "Truth audit failed")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function createTruthAuditCronHandler(options = {}) {
  const env = options.env || process.env;
  const buildLedger = options.createLedger || createTruthAuditLedger;
  const buildRunner = options.createRunner || createRelationalTruthAuditRunner;
  const respond = options.sendJson || sendJson;
  const now = options.now || Date.now;

  return async function truthAuditCronHandler(request, response) {
    if (request.method !== "GET" && request.method !== "POST") {
      respond(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    if (!env.CRON_SECRET) {
      respond(response, 503, {
        ok: false,
        status: "not-configured",
        error: "CRON_SECRET is required for the truth-audit endpoint.",
      });
      return;
    }
    if (!secretMatches(request, env.CRON_SECRET)) {
      respond(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (env.PQ_TRUTH_AUDIT_DISABLED === "1"
        || env.PQ_CRON_SUPABASE_PAUSED === "1"
        || env.PQ_SUPABASE_WRITES_DISABLED === "1") {
      respond(response, 200, {
        ok: true,
        status: "disabled",
        paused: true,
        reason: "Truth audit is paused by PQ_TRUTH_AUDIT_DISABLED/PQ_CRON_SUPABASE_PAUSED/PQ_SUPABASE_WRITES_DISABLED.",
        mutatesOperationalState: false,
      });
      return;
    }
    if (!WITNESS_TOKEN_RE.test(String(env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN || ""))) {
      respond(response, 503, {
        ok: false,
        status: "not-configured",
        error: "PQ_TRUTH_PRODUCTION_WITNESS_TOKEN is required for the truth-audit endpoint.",
        mutatesOperationalState: false,
      });
      return;
    }
    const productionProtectionBypassSecret = String(
      env.PQ_TRUTH_PROTECTION_BYPASS_SECRET || env.VERCEL_AUTOMATION_BYPASS_SECRET || "",
    );
    if (!PROTECTION_BYPASS_RE.test(productionProtectionBypassSecret)) {
      respond(response, 503, {
        ok: false,
        status: "not-configured",
        error: "A Vercel production-protection bypass secret is required for the truth-audit endpoint.",
        mutatesOperationalState: false,
      });
      return;
    }

    let deadline = null;
    try {
      const startedAtMs = Number(now());
      if (!Number.isFinite(startedAtMs)) throw new Error("Runtime clock returned a non-finite timestamp");
      const budgetMs = boundedInteger(env.PQ_TRUTH_AUDIT_RUNTIME_BUDGET_MS, 270_000, 30_000, 285_000);
      const requestedReserveMs = boundedInteger(
        env.PQ_TRUTH_AUDIT_RESPONSE_RESERVE_MS,
        15_000,
        5_000,
        60_000,
      );
      deadline = createRuntimeDeadline({
        deadlineAtMs: startedAtMs + budgetMs,
        responseReserveMs: Math.min(requestedReserveMs, budgetMs - 5_000),
        now,
        stage: "standalone truth audit",
      });
      const ledger = buildLedger({
        workspaceKey: env.PQ_TRUTH_AUDIT_WORKSPACE || "primary",
        auditToken: env.PQ_TRUTH_AUDIT_TOKEN,
        supabaseUrl: env.PQ_SUPABASE_URL,
        apiKey: env.PQ_SUPABASE_ANON_KEY,
        timeoutMs: optionalInteger(env.PQ_TRUTH_AUDIT_RPC_TIMEOUT_MS),
        writesDisabled: env.PQ_SUPABASE_WRITES_DISABLED === "1",
        signal: deadline.signal,
      });
      const runner = buildRunner({
        ledger,
        productionOrigin: env.PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN,
        productionWitnessToken: env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN,
        productionProtectionBypassSecret,
        allowedProductionOrigins: [env.PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN],
        productionTimeoutMs: optionalInteger(env.PQ_TRUTH_AUDIT_PRODUCTION_TIMEOUT_MS),
        rowLimit: optionalInteger(env.PQ_TRUTH_AUDIT_ROW_LIMIT),
        leaseSeconds: optionalInteger(env.PQ_TRUTH_AUDIT_LEASE_SECONDS),
        expectedIntervalSeconds: optionalInteger(env.PQ_TRUTH_AUDIT_EXPECTED_INTERVAL_SECONDS),
        findingSummaryLimit: optionalInteger(env.PQ_TRUTH_AUDIT_FINDING_SUMMARY_LIMIT),
        requireRelationalWitness: env.PQ_TRUTH_AUDIT_REQUIRE_RELATIONAL_WITNESS === "1",
        signal: deadline.signal,
      });
      const result = await runner.run({
        auditMode: "hourly",
        producerContext: standaloneAuditProducerContext(),
        signal: deadline.signal,
        deadlineAtMs: deadline.workDeadlineAtMs,
      });
      console.log(JSON.stringify({
        event: "truth-audit-run",
        auditRunId: result.auditRunId || null,
        status: result.status,
        skipped: result.skipped === true,
        agreement: result.agreement,
        blockingAgreement: result.blockingAgreement,
        counts: result.counts || null,
        findingCount: result.findingCount || 0,
        mutatesOperationalState: false,
      }));
      respond(response, 200, result);
    } catch (error) {
      const deadlineFailure = isAbortError(error, deadline?.signal);
      respond(response, deadlineFailure ? 504 : 500, {
        ok: false,
        status: "failed",
        auditRunId: error?.auditRunId || null,
        code: safeCode(error),
        error: safeError(error),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        deadlineExceeded: deadlineFailure || error?.deadlineExceeded === true,
        mutatesOperationalState: false,
      });
    } finally {
      deadline?.close();
    }
  };
}

const handler = createTruthAuditCronHandler();

module.exports = handler;
module.exports._test = Object.freeze({
  createTruthAuditCronHandler,
  boundedInteger,
  safeCode,
  safeError,
  secretMatches,
});

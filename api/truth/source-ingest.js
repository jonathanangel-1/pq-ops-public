"use strict";

const crypto = require("node:crypto");
const { createTruthSourceIngestRuntime } = require("../../lib/truth-source-ingest-runtime");
const { callSupabaseRpc } = require("../../lib/supabase-agent");

// The snapshot ledger refuses to run without an explicitly injected RPC
// caller. This route is the hosted boundary where liveness is a deliberate
// choice: bounded timeout, no retries, mutation calls report outcome-unknown
// on transport failure instead of guessing.
const INGEST_RPC_TIMEOUT_MS = 20_000;
const liveIngestCallRpc = (rpc, body, rpcOptions = {}) => callSupabaseRpc(rpc, body, {
  ...rpcOptions,
  timeoutMs: Math.min(Number(rpcOptions.timeoutMs || INGEST_RPC_TIMEOUT_MS), INGEST_RPC_TIMEOUT_MS),
  retryDelaysMs: [],
  outcomeUnknownOnAbort: !/^(?:read|get)_/.test(String(rpc)),
  outcomeUnknownOnTransportFailure: !/^(?:read|get)_/.test(String(rpc)),
});

// Vercel rejects function request bodies above 4.5 MB before this handler can
// run. Keep the application contract below that platform boundary so callers
// receive a deterministic local/API failure instead of an opaque edge error.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TOKEN_ENV = Object.freeze({
  tms: "PQ_TRUTH_TMS_INGEST_TOKEN",
  tracking: "PQ_TRUTH_TRACKING_INGEST_TOKEN",
});

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sourceFromRequest(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return String(url.searchParams.get("source") || "").trim().toLowerCase();
}

function bearer(request) {
  const header = String(request?.headers?.authorization || request?.headers?.Authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bodyObject(request) {
  let value = request.body;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds the 4 MiB source-ingest limit");
      error.code = "TRUTH_SOURCE_INGEST_BODY_TOO_LARGE";
      throw error;
    }
    value = JSON.parse(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Request body must be a JSON object");
    error.code = "TRUTH_SOURCE_INGEST_BODY_INVALID";
    throw error;
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encodedBytes > MAX_BODY_BYTES) {
    const error = new Error("Request body exceeds the 4 MiB source-ingest limit");
    error.code = "TRUTH_SOURCE_INGEST_BODY_TOO_LARGE";
    throw error;
  }
  return value;
}

function createSourceIngestHandler(options = {}) {
  const env = options.env || process.env;
  const buildRuntime = options.createRuntime || ((runtimeOptions) => createTruthSourceIngestRuntime(runtimeOptions));
  const respond = options.sendJson || sendJson;

  return async function sourceIngestHandler(request, response) {
    if (request.method !== "POST") {
      respond(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const sourceSystem = sourceFromRequest(request);
    if (sourceSystem === "operator") {
      respond(response, 410, {
        ok: false,
        code: "TRUTH_OPERATOR_EVENT_ENDPOINT_REQUIRED",
        error: "Operator truth must use the server-authoritative /api/truth/operator-event endpoint.",
        mutatesOperationalState: false,
      });
      return;
    }
    const tokenName = TOKEN_ENV[sourceSystem];
    if (!tokenName) {
      respond(response, 400, { ok: false, code: "TRUTH_SOURCE_INGEST_SOURCE_UNSUPPORTED", error: "Unsupported source" });
      return;
    }
    const expectedToken = String(env[tokenName] || "");
    if (expectedToken.length < 16 || !tokenMatches(bearer(request), expectedToken)) {
      respond(response, expectedToken.length < 16 ? 503 : 401, {
        ok: false,
        code: expectedToken.length < 16 ? "TRUTH_SOURCE_INGEST_NOT_CONFIGURED" : "TRUTH_SOURCE_INGEST_UNAUTHORIZED",
        error: expectedToken.length < 16 ? `${tokenName} is not configured` : "Unauthorized",
      });
      return;
    }
    if (env.PQ_TRUTH_SOURCE_INGEST_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1") {
      respond(response, 503, {
        ok: false,
        status: "disabled",
        code: "TRUTH_SOURCE_INGEST_DISABLED",
        error: "Truth source ingestion is paused.",
      });
      return;
    }
    let body;
    try {
      body = bodyObject(request);
    } catch (error) {
      respond(response, error?.code === "TRUTH_SOURCE_INGEST_BODY_TOO_LARGE" ? 413 : 400, {
        ok: false,
        code: error?.code || "TRUTH_SOURCE_INGEST_BODY_INVALID",
        error: error?.message || "Invalid request body",
      });
      return;
    }
    try {
      const runtime = buildRuntime({
        workspaceKey: env.PQ_TRUTH_WORKSPACE || "primary",
        syncToken: env.PQ_SUPABASE_SYNC_TOKEN,
        callRpc: liveIngestCallRpc,
      });
      const result = await runtime.ingest({
        sourceSystem,
        payload: body,
        scopeToken: sourceSystem === "tracking" ? String(body.scopeToken || "") : undefined,
        ownerId: `${RUNTIME_OWNER_PREFIX}:${sourceSystem}`,
      });
      console.log(JSON.stringify({
        event: "truth-source-ingest",
        sourceSystem,
        payloadIdentity: result.payloadIdentity,
        recovered: result.recovered,
        observationCount: result.observationCount,
        jobCount: result.jobCount,
        mutatesOperationalState: false,
      }));
      respond(response, 200, result);
    } catch (error) {
      const status = error?.code === "LEASE_BUSY" || error?.code === "40001" ? 409
        : error?.retryable ? 503 : 422;
      respond(response, status, {
        ok: false,
        sourceSystem,
        stage: error?.stage || "unknown",
        code: error?.code || "TRUTH_SOURCE_INGEST_FAILED",
        error: error instanceof Error ? error.message : String(error),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        mutatesOperationalState: false,
      });
    }
  };
}

const RUNTIME_OWNER_PREFIX = "hosted-truth-source-ingest-v1";
const handler = createSourceIngestHandler();

module.exports = handler;
module.exports._test = Object.freeze({
  MAX_BODY_BYTES,
  RUNTIME_OWNER_PREFIX,
  TOKEN_ENV,
  bodyObject,
  createSourceIngestHandler,
  sourceFromRequest,
  tokenMatches,
});

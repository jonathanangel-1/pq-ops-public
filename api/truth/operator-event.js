"use strict";

const crypto = require("node:crypto");
const { createTruthOperatorEventRuntime } = require("../../lib/truth-operator-event-runtime");
const { IDEMPOTENCY_KEY_RE } = require("../../lib/truth-operator-event-ledger");

const MAX_BODY_BYTES = 32 * 1024;
const TOKEN_ENV = "PQ_TRUTH_OPERATOR_EVENT_TOKEN";
const CONNECTION_KEY = "operator-phone-primary";

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

function idempotencyKey(request) {
  const value = String(request?.headers?.["idempotency-key"] || request?.headers?.["Idempotency-Key"] || "");
  return IDEMPOTENCY_KEY_RE.test(value) ? value : "";
}

function bodyObject(request) {
  let body = request.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 32 KiB");
      error.code = "TRUTH_OPERATOR_EVENT_BODY_TOO_LARGE";
      throw error;
    }
    body = JSON.parse(body);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Request body must be a JSON object");
    error.code = "TRUTH_OPERATOR_EVENT_BODY_INVALID";
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    const error = new Error("Request body exceeds 32 KiB");
    error.code = "TRUTH_OPERATOR_EVENT_BODY_TOO_LARGE";
    throw error;
  }
  return body;
}

function errorStatus(error) {
  if (error?.code === "23505" || error?.code === "23503" || error?.code === "23514") return 409;
  if (error?.code === "40001") return 409;
  if (error?.code === "28000" || error?.retryable || error?.outcomeUnknown) return 503;
  if (error?.code === "TRUTH_OPERATOR_EVENT_INVALID_ARGUMENT"
      || error?.code === "TRUTH_OPERATOR_EVENT_LEDGER_INVALID_ARGUMENT") return 400;
  return 422;
}

function createOperatorEventHandler(options = {}) {
  const env = options.env || process.env;
  const buildRuntime = options.createRuntime || ((runtimeOptions) => createTruthOperatorEventRuntime(runtimeOptions));
  const respond = options.sendJson || sendJson;
  return async function operatorEventHandler(request, response) {
    if (request.method !== "POST") {
      respond(response, 405, { ok: false, code: "TRUTH_OPERATOR_EVENT_METHOD_NOT_ALLOWED", error: "Method not allowed" });
      return;
    }
    const expectedToken = String(env[TOKEN_ENV] || "");
    if (expectedToken.length < 32 || !secretMatches(bearer(request), expectedToken)) {
      respond(response, expectedToken.length < 32 ? 503 : 401, {
        ok: false,
        code: expectedToken.length < 32
          ? "TRUTH_OPERATOR_EVENT_NOT_CONFIGURED"
          : "TRUTH_OPERATOR_EVENT_UNAUTHORIZED",
        error: expectedToken.length < 32 ? "Operator truth ingress is not configured" : "Unauthorized",
      });
      return;
    }
    if (env.PQ_TRUTH_SOURCE_INGEST_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1") {
      respond(response, 503, {
        ok: false,
        code: "TRUTH_OPERATOR_EVENT_DISABLED",
        error: "Operator truth ingestion is paused.",
      });
      return;
    }
    const key = idempotencyKey(request);
    if (!key) {
      respond(response, 400, {
        ok: false,
        code: "TRUTH_OPERATOR_EVENT_IDEMPOTENCY_REQUIRED",
        error: "A 32-128 character base64url Idempotency-Key header is required.",
      });
      return;
    }
    let body;
    try {
      body = bodyObject(request);
    } catch (error) {
      respond(response, error?.code === "TRUTH_OPERATOR_EVENT_BODY_TOO_LARGE" ? 413 : 400, {
        ok: false,
        code: error?.code || "TRUTH_OPERATOR_EVENT_BODY_INVALID",
        error: error?.message || "Invalid request body",
      });
      return;
    }
    try {
      const runtime = buildRuntime({
        workspaceKey: env.PQ_TRUTH_WORKSPACE || "primary",
        connectionKey: CONNECTION_KEY,
        syncToken: env.PQ_SUPABASE_SYNC_TOKEN,
      });
      const result = await runtime.record({ idempotencyKey: key, request: body });
      console.log(JSON.stringify({
        event: "truth-operator-event-recorded",
        requestId: result.requestId,
        eventId: result.eventId,
        eventSequence: result.eventSequence,
        observationId: result.observationId,
        mutatesOperationalState: false,
      }));
      respond(response, 200, result);
    } catch (error) {
      respond(response, errorStatus(error), {
        ok: false,
        code: error?.code || "TRUTH_OPERATOR_EVENT_FAILED",
        error: error instanceof Error ? error.message : String(error),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        safeToRetryWithSameIdempotencyKey: true,
        mutatesOperationalState: false,
      });
    }
  };
}

const handler = createOperatorEventHandler();
module.exports = handler;
module.exports._test = Object.freeze({
  CONNECTION_KEY,
  MAX_BODY_BYTES,
  TOKEN_ENV,
  bodyObject,
  createOperatorEventHandler,
  errorStatus,
  idempotencyKey,
  secretMatches,
});

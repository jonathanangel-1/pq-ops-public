"use strict";

const { createTruthOperatorEventRuntime } = require("../../lib/truth-operator-event-runtime");
const { IDEMPOTENCY_KEY_RE } = require("../../lib/truth-operator-event-ledger");
const { createTruthOperatorBrowserRuntime } = require("../../lib/truth-operator-browser-runtime");

const MAX_BODY_BYTES = 16 * 1024;
const CSRF_HEADER = "x-pikiio-operator-csrf";
const CSRF_VALUE = "structured-phone-truth-v1";
const ENABLED_ENV = "PQ_TRUTH_BROWSER_OPERATOR_EVENT_ENABLED";
const AUTHORITY_ENV = "PQ_TRUTH_BROWSER_OPERATOR_AUTHORITY";
const AUTHORITY_VALUE = "vercel-authentication-all";
const ORIGIN_ENV = "PQ_TRUTH_BROWSER_OPERATOR_ORIGIN";
const OPERATOR_ID_ENV = "PQ_TRUTH_BROWSER_OPERATOR_ID";
const OPERATOR_NAME_ENV = "PQ_TRUTH_BROWSER_OPERATOR_NAME";

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function header(request, name) {
  return String(request?.headers?.[name] || request?.headers?.[name.toLowerCase()] || "").trim();
}

function idempotencyKey(request) {
  const value = header(request, "idempotency-key");
  return IDEMPOTENCY_KEY_RE.test(value) ? value : "";
}

function configuredOrigin(env) {
  const value = String(env[ORIGIN_ENV] || "").trim();
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(local && env.VERCEL_ENV !== "production")) return null;
    return url;
  } catch {
    return null;
  }
}

function configuration(env) {
  const origin = configuredOrigin(env);
  const operatorId = String(env[OPERATOR_ID_ENV] || "").trim();
  const operatorName = String(env[OPERATOR_NAME_ENV] || "").trim();
  if (env[ENABLED_ENV] !== "1"
      || env[AUTHORITY_ENV] !== AUTHORITY_VALUE
      || !origin
      || !operatorId
      || !operatorName) return null;
  return { origin, recordedBy: { operatorId, name: operatorName } };
}

function requestOrigin(request) {
  const host = header(request, "x-forwarded-host").split(",")[0].trim()
    || header(request, "host").split(",")[0].trim();
  const protocol = header(request, "x-forwarded-proto").split(",")[0].trim()
    || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return host ? `${protocol}://${host}` : "";
}

function browserAuthorityValid(request, config) {
  return header(request, "origin") === config.origin.origin
    && requestOrigin(request) === config.origin.origin
    && header(request, "sec-fetch-site") === "same-origin"
    && header(request, CSRF_HEADER) === CSRF_VALUE
    && /^application\/json(?:\s*;|$)/i.test(header(request, "content-type"));
}

async function bodyObject(request) {
  let body = request.body;
  if (body === undefined && request && typeof request[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("Request body exceeds 16 KiB");
        error.code = "TRUTH_OPERATOR_BROWSER_BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(value);
    }
    body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}";
  }
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 16 KiB");
      error.code = "TRUTH_OPERATOR_BROWSER_BODY_TOO_LARGE";
      throw error;
    }
    body = JSON.parse(body);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Request body must be a JSON object");
    error.code = "TRUTH_OPERATOR_BROWSER_BODY_INVALID";
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    const error = new Error("Request body exceeds 16 KiB");
    error.code = "TRUTH_OPERATOR_BROWSER_BODY_TOO_LARGE";
    throw error;
  }
  return body;
}

function errorStatus(error) {
  if (error?.code === "TRUTH_OPERATOR_BROWSER_INVALID_ARGUMENT") return 400;
  if (error?.code === "23505" || error?.code === "23503" || error?.code === "23514" || error?.code === "40001") return 409;
  if (error?.retryable || error?.outcomeUnknown || error?.code === "TRUTH_OPERATOR_BROWSER_PARTIAL_OR_FAILED") return 503;
  return 422;
}

function createOperatorBrowserEventHandler(options = {}) {
  const env = options.env || process.env;
  const buildOperatorRuntime = options.createOperatorRuntime
    || ((runtimeOptions) => createTruthOperatorEventRuntime(runtimeOptions));
  const buildBrowserRuntime = options.createBrowserRuntime
    || ((runtimeOptions) => createTruthOperatorBrowserRuntime(runtimeOptions));
  const respond = options.sendJson || sendJson;
  return async function operatorBrowserEventHandler(request, response) {
    if (request.method !== "POST") {
      respond(response, 405, { ok: false, code: "TRUTH_OPERATOR_BROWSER_METHOD_NOT_ALLOWED", error: "Method not allowed" });
      return;
    }
    const config = configuration(env);
    if (!config) {
      respond(response, 503, {
        ok: false,
        code: "TRUTH_OPERATOR_BROWSER_NOT_CONFIGURED",
        error: "Browser operator truth is disabled until Vercel Authentication protects every deployment and the exact operator origin and identity are configured.",
      });
      return;
    }
    if (!browserAuthorityValid(request, config)) {
      respond(response, 403, {
        ok: false,
        code: "TRUTH_OPERATOR_BROWSER_FORBIDDEN",
        error: "Same-origin protected browser authority is required.",
      });
      return;
    }
    if (env.PQ_TRUTH_SOURCE_INGEST_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1") {
      respond(response, 503, {
        ok: false,
        code: "TRUTH_OPERATOR_BROWSER_DISABLED",
        error: "Operator truth ingestion is paused.",
      });
      return;
    }
    const key = idempotencyKey(request);
    if (!key) {
      respond(response, 400, {
        ok: false,
        code: "TRUTH_OPERATOR_BROWSER_IDEMPOTENCY_REQUIRED",
        error: "A stable 32-128 character base64url Idempotency-Key header is required.",
      });
      return;
    }
    let body;
    try {
      body = await bodyObject(request);
    } catch (error) {
      respond(response, error?.code === "TRUTH_OPERATOR_BROWSER_BODY_TOO_LARGE" ? 413 : 400, {
        ok: false,
        code: error?.code || "TRUTH_OPERATOR_BROWSER_BODY_INVALID",
        error: error?.message || "Invalid request body",
      });
      return;
    }
    try {
      const operatorRuntime = buildOperatorRuntime({
        workspaceKey: env.PQ_TRUTH_WORKSPACE || "primary",
        connectionKey: "operator-phone-primary",
        syncToken: env.PQ_SUPABASE_SYNC_TOKEN,
      });
      const browserRuntime = buildBrowserRuntime({ runtime: operatorRuntime, recordedBy: config.recordedBy });
      const result = await browserRuntime.recordCommand({ idempotencyKey: key, command: body });
      respond(response, 200, result);
    } catch (error) {
      respond(response, errorStatus(error), {
        ok: false,
        code: error?.code || "TRUTH_OPERATOR_BROWSER_FAILED",
        error: error instanceof Error ? error.message : String(error),
        failedAssertionIndex: Number.isInteger(error?.failedAssertionIndex) ? error.failedAssertionIndex : null,
        completedReceipts: Array.isArray(error?.completedReceipts) ? error.completedReceipts : [],
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        safeToRetryWithSameIdempotencyKey: true,
        mutatesOperationalState: false,
      });
    }
  };
}

const handler = createOperatorBrowserEventHandler();
module.exports = handler;
module.exports._test = Object.freeze({
  AUTHORITY_ENV,
  AUTHORITY_VALUE,
  CSRF_HEADER,
  CSRF_VALUE,
  ENABLED_ENV,
  MAX_BODY_BYTES,
  OPERATOR_ID_ENV,
  OPERATOR_NAME_ENV,
  ORIGIN_ENV,
  bodyObject,
  browserAuthorityValid,
  configuration,
  createOperatorBrowserEventHandler,
  errorStatus,
  idempotencyKey,
  requestOrigin,
});

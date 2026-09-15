"use strict";

const crypto = require("node:crypto");
const {
  IDEMPOTENCY_KEY_RE,
  createTruthReviewRuntime,
} = require("../../lib/truth-review-runtime");

const TOKEN_ENV = "PQ_TRUTH_REVIEW_TOKEN";
const MAX_BODY_BYTES = 16 * 1024;

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

function idempotencyKey(request) {
  const value = String(request?.headers?.["idempotency-key"] || request?.headers?.["Idempotency-Key"] || "");
  return IDEMPOTENCY_KEY_RE.test(value) ? value : "";
}

function bodyObject(request) {
  let body = request.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 16 KiB");
      error.code = "TRUTH_REVIEW_BODY_TOO_LARGE";
      throw error;
    }
    body = JSON.parse(body);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Request body must be a JSON object");
    error.code = "TRUTH_REVIEW_BODY_INVALID";
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    const error = new Error("Request body exceeds 16 KiB");
    error.code = "TRUTH_REVIEW_BODY_TOO_LARGE";
    throw error;
  }
  return body;
}

function listInput(request) {
  const url = new URL(request?.url || "/", "http://localhost");
  const targetKind = url.searchParams.get("targetKind") || "";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  return { targetKind, limit };
}

function safeError(error) {
  return String(error?.message || "Truth review failed")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function errorStatus(error) {
  if (error?.code === "23505" || error?.code === "23503" || error?.code === "23514"
    || error?.code === "40001" || error?.code === "55000") return 409;
  if (error?.code === "28000" || error?.retryable || error?.outcomeUnknown) return 503;
  if (error?.code === "TRUTH_REVIEW_INVALID_ARGUMENT"
    || error?.code === "TRUTH_CANDIDATE_INVALID_ARGUMENT"
    || error?.code === "TRUTH_LINK_INVALID_ARGUMENT") return 400;
  return 422;
}

function createTruthReviewHandler(options = {}) {
  const env = options.env || process.env;
  const buildRuntime = options.createRuntime || ((runtimeOptions) => createTruthReviewRuntime(runtimeOptions));
  const respond = options.sendJson || sendJson;

  return async function truthReviewHandler(request, response) {
    if (!["GET", "POST"].includes(request.method)) {
      respond(response, 405, {
        ok: false,
        code: "TRUTH_REVIEW_METHOD_NOT_ALLOWED",
        error: "Method not allowed",
        mutatesOperationalState: false,
      });
      return;
    }
    const expectedToken = String(env[TOKEN_ENV] || "");
    if (expectedToken.length < 32 || !secretMatches(bearer(request), expectedToken)) {
      respond(response, expectedToken.length < 32 ? 503 : 401, {
        ok: false,
        code: expectedToken.length < 32 ? "TRUTH_REVIEW_NOT_CONFIGURED" : "TRUTH_REVIEW_UNAUTHORIZED",
        error: expectedToken.length < 32 ? "Truth review access is not configured" : "Unauthorized",
        mutatesOperationalState: false,
      });
      return;
    }
    if (env.PQ_TRUTH_REVIEW_DISABLED === "1") {
      respond(response, 503, {
        ok: false,
        code: "TRUTH_REVIEW_DISABLED",
        error: "Truth review access is paused.",
        mutatesOperationalState: false,
      });
      return;
    }
    if (request.method === "POST"
      && (env.PQ_SUPABASE_WRITES_DISABLED === "1" || env.PQ_TRUTH_REVIEW_WRITES_DISABLED === "1")) {
      respond(response, 503, {
        ok: false,
        code: "TRUTH_REVIEW_WRITES_DISABLED",
        error: "Truth review decisions are paused.",
        mutatesOperationalState: false,
      });
      return;
    }

    const runtime = buildRuntime({
      workspaceKey: env.PQ_TRUTH_WORKSPACE || "primary",
      reviewToken: expectedToken,
      syncToken: env.PQ_SUPABASE_SYNC_TOKEN,
    });
    try {
      if (request.method === "GET") {
        const result = await runtime.list(listInput(request));
        respond(response, 200, result);
        return;
      }
      const key = idempotencyKey(request);
      if (!key) {
        respond(response, 400, {
          ok: false,
          code: "TRUTH_REVIEW_IDEMPOTENCY_REQUIRED",
          error: "A 32-128 character base64url Idempotency-Key header is required.",
          mutatesOperationalState: false,
        });
        return;
      }
      let body;
      try {
        body = bodyObject(request);
      } catch (error) {
        respond(response, error?.code === "TRUTH_REVIEW_BODY_TOO_LARGE" ? 413 : 400, {
          ok: false,
          code: error?.code || "TRUTH_REVIEW_BODY_INVALID",
          error: error?.message || "Invalid request body",
          mutatesOperationalState: false,
        });
        return;
      }
      const result = await runtime.resolve({ idempotencyKey: key, request: body });
      console.log(JSON.stringify({
        event: "truth-review-resolved",
        reviewResolutionId: result.reviewResolutionId,
        targetKind: result.targetKind,
        targetId: result.targetId,
        decision: result.decision,
        mutatesOperationalState: false,
        publishesTruth: false,
        performsActions: false,
      }));
      respond(response, 200, result);
    } catch (error) {
      respond(response, errorStatus(error), {
        ok: false,
        code: error?.code || "TRUTH_REVIEW_FAILED",
        error: safeError(error),
        retryable: error?.retryable === true,
        outcomeUnknown: error?.outcomeUnknown === true,
        safeToRetryWithSameIdempotencyKey: request.method === "POST",
        mutatesOperationalState: false,
        publishesTruth: false,
        performsActions: false,
      });
    }
  };
}

const handler = createTruthReviewHandler();
module.exports = handler;
module.exports._test = Object.freeze({
  MAX_BODY_BYTES,
  TOKEN_ENV,
  bodyObject,
  createTruthReviewHandler,
  errorStatus,
  idempotencyKey,
  listInput,
  safeError,
  secretMatches,
});

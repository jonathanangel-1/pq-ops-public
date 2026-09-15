"use strict";

// Server-only HTTP boundary for calls into a Vercel-protected Pikiio origin.
// Callers must provide two independent credentials:
//   1. Vercel's automation bypass, which crosses Deployment Protection.
//   2. A route-specific Bearer token, which authorizes the application route.
// This module must never be imported by app.js or another browser bundle.

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

class ProtectedOriginClientError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "ProtectedOriginClientError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new ProtectedOriginClientError(`Invalid protected-origin client ${field}: ${reason}`, {
    code: "PROTECTED_ORIGIN_INVALID_ARGUMENT",
    field,
    retryable: false,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value, field, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function boundedSecret(value, field, { minimumBytes = 16, maximumBytes = 4096 } = {}) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw invalid(field, "must be a trimmed server-only string");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw invalid(field, `must contain ${minimumBytes} through ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (cause) {
    throw invalid("origin", "must be an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if ((!loopback && parsed.protocol !== "https:")
      || (loopback && !["http:", "https:"].includes(parsed.protocol))
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) {
    throw invalid("origin", "must be a credential-free HTTPS origin (HTTP only for loopback)");
  }
  return Object.freeze({ origin: parsed.origin, loopback });
}

function normalizePathname(value) {
  if (typeof value !== "string"
      || value.trim() !== value
      || !value.startsWith("/")
      || value.startsWith("//")
      || /[\r\n\0]/.test(value)) {
    throw invalid("pathname", "must be a same-origin absolute path");
  }
  let parsed;
  try {
    parsed = new URL(value, "https://protected-origin.invalid");
  } catch (cause) {
    throw invalid("pathname", "must be a valid same-origin path");
  }
  if (parsed.origin !== "https://protected-origin.invalid") {
    throw invalid("pathname", "must not name another origin");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function safeDetail(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|access_token|refresh_token|client_secret|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/\b(x-vercel-protection-bypass|protection_bypass|bypass_secret)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function createServerProtectedOriginClient(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const allowed = new Set([
    "origin",
    "protectionBypassSecret",
    "fetchImpl",
    "timeoutMs",
    "maxResponseBytes",
    "clientVersion",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw invalid(key, "is not a protected-origin dependency");
  }

  const normalized = normalizeOrigin(options.origin);
  const protectionBypassSecret = normalized.loopback && !options.protectionBypassSecret
    ? ""
    : boundedSecret(options.protectionBypassSecret, "protectionBypassSecret", {
        minimumBytes: 16,
        maximumBytes: 256,
      });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw invalid("fetchImpl", "must be a function");
  const defaultTimeoutMs = boundedInteger(
    options.timeoutMs,
    "timeoutMs",
    DEFAULT_TIMEOUT_MS,
    1_000,
    300_000,
  );
  const defaultMaxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    "maxResponseBytes",
    DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    4 * 1024 * 1024,
  );
  const clientVersion = String(options.clientVersion || "pikiio-protected-origin-v1")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 100);

  async function requestJson(input = {}) {
    if (!isPlainObject(input)) throw invalid("request", "must be an object");
    const pathname = normalizePathname(input.pathname);
    const authorizationToken = boundedSecret(input.authorizationToken, "authorizationToken", {
      minimumBytes: 16,
      maximumBytes: 4096,
    });
    const method = String(input.method || "GET").toUpperCase();
    if (!["GET", "POST"].includes(method)) throw invalid("method", "must be GET or POST");
    if (method === "GET" && input.body !== undefined) throw invalid("body", "is not allowed for GET");
    const timeoutMs = boundedInteger(input.timeoutMs, "request.timeoutMs", defaultTimeoutMs, 1_000, 300_000);
    const maxResponseBytes = boundedInteger(
      input.maxResponseBytes,
      "request.maxResponseBytes",
      defaultMaxResponseBytes,
      1024,
      4 * 1024 * 1024,
    );
    const maxRequestBytes = input.maxRequestBytes === undefined
      ? null
      : boundedInteger(input.maxRequestBytes, "request.maxRequestBytes", null, 1024, 4 * 1024 * 1024);
    const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (serialized === undefined && input.body !== undefined) throw invalid("body", "must be JSON serializable");
    if (maxRequestBytes !== null && Buffer.byteLength(serialized || "", "utf8") > maxRequestBytes) {
      throw new ProtectedOriginClientError(`Protected-origin request exceeds ${maxRequestBytes} UTF-8 bytes`, {
        code: "PROTECTED_ORIGIN_REQUEST_TOO_LARGE",
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${normalized.origin}${pathname}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${authorizationToken}`,
          ...(serialized === undefined ? {} : { "content-type": "application/json" }),
          ...(protectionBypassSecret ? { "x-vercel-protection-bypass": protectionBypassSecret } : {}),
          "x-pikiio-server-client": clientVersion,
        },
        ...(serialized === undefined ? {} : { body: serialized }),
        signal: controller.signal,
      });
      const declaredBytes = Number(response.headers?.get?.("content-length") || 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
        throw new ProtectedOriginClientError(`Protected-origin response exceeds ${maxResponseBytes} bytes`, {
          code: "PROTECTED_ORIGIN_RESPONSE_TOO_LARGE",
          status: response.status,
          retryable: false,
        });
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > maxResponseBytes) {
        throw new ProtectedOriginClientError(`Protected-origin response exceeds ${maxResponseBytes} bytes`, {
          code: "PROTECTED_ORIGIN_RESPONSE_TOO_LARGE",
          status: response.status,
          retryable: false,
        });
      }
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (cause) {
        throw new ProtectedOriginClientError(`Protected-origin returned invalid JSON (${response.status})`, {
          code: "PROTECTED_ORIGIN_RESPONSE_INVALID",
          status: response.status,
          retryable: response.ok,
          cause,
        });
      }
      return Object.freeze({ ok: response.ok, status: response.status, body });
    } catch (cause) {
      if (cause instanceof ProtectedOriginClientError) throw cause;
      const timedOut = cause?.name === "AbortError";
      throw new ProtectedOriginClientError(
        timedOut
          ? `Protected-origin request timed out after ${timeoutMs}ms`
          : `Protected-origin transport failed: ${safeDetail(cause?.message || cause)}`,
        {
          code: timedOut ? "PROTECTED_ORIGIN_TIMEOUT" : "PROTECTED_ORIGIN_TRANSPORT_FAILED",
          retryable: true,
          outcomeUnknown: method !== "GET",
          cause,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Neither application authorization nor the Vercel bypass is exposed on
  // the returned object. The closure is the only credential holder.
  return Object.freeze({
    origin: normalized.origin,
    requestJson,
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  ProtectedOriginClientError,
  createServerProtectedOriginClient,
  _test: Object.freeze({
    boundedSecret,
    normalizeOrigin,
    normalizePathname,
    safeDetail,
  }),
});

"use strict";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
// Must remain aligned with api/truth/source-ingest.js and below Vercel's
// 4.5 MB function request-body limit.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CLIENT_VERSION = "truth-source-ingest-client-v1";

class TruthSourceIngestClientError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthSourceIngestClientError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthSourceIngestClientError(`Invalid truth source-ingest client ${field}: ${reason}`, {
    code: "TRUTH_SOURCE_INGEST_CLIENT_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, { minimumBytes = 1, maximumBytes = 8192 } = {}) {
  if (typeof value !== "string" || value.trim() !== value) throw invalid(field, "must be a trimmed string");
  const size = Buffer.byteLength(value, "utf8");
  if (size < minimumBytes || size > maximumBytes) {
    throw invalid(field, `must contain ${minimumBytes} through ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(text(value, "origin", { maximumBytes: 2048 }));
  } catch (cause) {
    if (cause instanceof TruthSourceIngestClientError) throw cause;
    throw invalid("origin", "must be an absolute URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:")
      || (local && !["http:", "https:"].includes(url.protocol))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalid("origin", "must be a credential-free HTTPS origin (HTTP only for loopback)");
  }
  return url.origin;
}

function boundedInteger(value, field, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function retryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function safeDetail(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/\b(x-vercel-protection-bypass|protection_bypass|bypass_secret)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

async function readBoundedJson(response, operation) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new TruthSourceIngestClientError(`${operation} response exceeds 1 MiB`, {
      code: "TRUTH_SOURCE_INGEST_RESPONSE_TOO_LARGE",
      operation,
      retryable: false,
    });
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new TruthSourceIngestClientError(`${operation} response exceeds 1 MiB`, {
      code: "TRUTH_SOURCE_INGEST_RESPONSE_TOO_LARGE",
      operation,
      retryable: false,
    });
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new TruthSourceIngestClientError(`${operation} returned invalid JSON`, {
      code: "TRUTH_SOURCE_INGEST_RESPONSE_INVALID",
      operation,
      retryable: response.ok,
      cause,
    });
  }
}

function createTruthSourceIngestClient(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const env = options.env || process.env;
  const origin = normalizeOrigin(
    options.origin
      || env.PQ_TRUTH_SOURCE_INGEST_ORIGIN
      || env.PQ_PRODUCTION_BASE_URL
      || env.PIKIIO_PUBLIC_BASE_URL
      || "",
  );
  const tmsToken = text(options.tmsToken || env.PQ_TRUTH_TMS_INGEST_TOKEN || "", "tmsToken", {
    minimumBytes: 16,
    maximumBytes: 4096,
  });
  const trackingToken = text(
    options.trackingToken || env.PQ_TRUTH_TRACKING_INGEST_TOKEN || "",
    "trackingToken",
    { minimumBytes: 16, maximumBytes: 4096 },
  );
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname);
  const rawProtectionBypass = options.protectionBypassSecret
    || env.PQ_TRUTH_PROTECTION_BYPASS_SECRET
    || env.VERCEL_AUTOMATION_BYPASS_SECRET
    || "";
  const protectionBypassSecret = loopback && !rawProtectionBypass
    ? ""
    : text(rawProtectionBypass, "protectionBypassSecret", {
        minimumBytes: 16,
        maximumBytes: 256,
      });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw invalid("fetchImpl", "must be a function");
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = boundedInteger(options.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS, 1_000, 300_000);
  const maxRetries = boundedInteger(options.maxRetries, "maxRetries", DEFAULT_MAX_RETRIES, 0, 8);

  async function request(operation, pathname, token, payload) {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw invalid("payload", "must be JSON serializable");
    const requestBytes = Buffer.byteLength(serialized, "utf8");
    if (requestBytes > MAX_REQUEST_BYTES) {
      throw new TruthSourceIngestClientError(`${operation} request exceeds the 4 MiB source-ingest limit`, {
        code: "TRUTH_SOURCE_INGEST_REQUEST_TOO_LARGE",
        operation,
        requestBytes,
        maximumBytes: MAX_REQUEST_BYTES,
        retryable: false,
        outcomeUnknown: false,
      });
    }
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${origin}${pathname}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-pikiio-truth-client": CLIENT_VERSION,
            ...(protectionBypassSecret
              ? { "x-vercel-protection-bypass": protectionBypassSecret }
              : {}),
          },
          body: serialized,
          signal: controller.signal,
        });
        const body = await readBoundedJson(response, operation);
        if (response.ok && body?.ok !== false) return body;
        const retryable = retryableStatus(response.status) || body?.retryable === true || body?.outcomeUnknown === true;
        if (retryable && attempt < maxRetries) {
          attempt += 1;
          await sleep(Math.min(10_000, 500 * (2 ** (attempt - 1))));
          continue;
        }
        throw new TruthSourceIngestClientError(
          `${operation} failed with HTTP ${response.status}: ${safeDetail(body?.error || body?.code || "request rejected")}`,
          {
            code: String(body?.code || "TRUTH_SOURCE_INGEST_HTTP_FAILED"),
            operation,
            status: response.status,
            retryable,
            outcomeUnknown: body?.outcomeUnknown === true,
          },
        );
      } catch (cause) {
        if (cause instanceof TruthSourceIngestClientError) throw cause;
        const retryable = cause?.name === "AbortError" || cause instanceof TypeError;
        if (retryable && attempt < maxRetries) {
          attempt += 1;
          await sleep(Math.min(10_000, 500 * (2 ** (attempt - 1))));
          continue;
        }
        throw new TruthSourceIngestClientError(`${operation} transport failed: ${safeDetail(cause?.message || cause)}`, {
          code: cause?.name === "AbortError" ? "TRUTH_SOURCE_INGEST_TIMEOUT" : "TRUTH_SOURCE_INGEST_TRANSPORT_FAILED",
          operation,
          retryable,
          outcomeUnknown: true,
          cause,
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function ingestTms(snapshot) {
    if (!isPlainObject(snapshot)) throw invalid("tmsSnapshot", "must be an object");
    return request("TMS truth-source ingest", "/api/truth/source-ingest?source=tms", tmsToken, { snapshot });
  }

  async function issueTrackingScope() {
    const result = await request("tracking scope issuance", "/api/truth/tracking-scope", trackingToken, {});
    if (!/^tracking-scope:v1:[0-9a-f]{64}$/.test(String(result.scopeToken || ""))
        || !Array.isArray(result.expectedAwbs)) {
      throw new TruthSourceIngestClientError("Tracking scope authority returned an invalid receipt", {
        code: "TRUTH_TRACKING_SCOPE_RECEIPT_INVALID",
        operation: "tracking scope issuance",
        retryable: false,
      });
    }
    return result;
  }

  async function ingestTracking(snapshots, scope) {
    if (!Array.isArray(snapshots) || !snapshots.every(isPlainObject)) {
      throw invalid("trackingSnapshots", "must be an array of objects");
    }
    if (!isPlainObject(scope) || !/^tracking-scope:v1:[0-9a-f]{64}$/.test(String(scope.scopeToken || ""))) {
      throw invalid("trackingScope", "must be a server-issued scope receipt");
    }
    return request(
      "tracking truth-source ingest",
      "/api/truth/source-ingest?source=tracking",
      trackingToken,
      { scopeToken: scope.scopeToken, snapshot: { snapshots } },
    );
  }

  async function ingestMorningSources(input = {}) {
    if (!isPlainObject(input)) throw invalid("input", "must be an object");
    const tms = await ingestTms(input.tmsSnapshot);
    const scope = await issueTrackingScope();
    const tracking = await ingestTracking(input.trackingSnapshots, scope);
    return Object.freeze({
      ok: true,
      clientVersion: CLIENT_VERSION,
      tms: {
        payloadIdentity: tms.payloadIdentity || null,
        committedCursorValue: tms.committedCursorValue || null,
        observationCount: Number(tms.observationCount || 0),
        jobCount: Number(tms.jobCount || 0),
        recovered: tms.recovered === true,
      },
      trackingScope: {
        tmsCursorValue: scope.tmsCursorValue || null,
        expectedAwbCount: scope.expectedAwbs.length,
        expiresAt: scope.expiresAt || null,
      },
      tracking: {
        payloadIdentity: tracking.payloadIdentity || null,
        committedCursorValue: tracking.committedCursorValue || null,
        observationCount: Number(tracking.observationCount || 0),
        jobCount: Number(tracking.jobCount || 0),
        recovered: tracking.recovered === true,
      },
      publishesTruth: false,
      mutatesOperationalState: false,
    });
  }

  return Object.freeze({
    clientVersion: CLIENT_VERSION,
    origin,
    ingestTms,
    issueTrackingScope,
    ingestTracking,
    ingestMorningSources,
  });
}

module.exports = Object.freeze({
  CLIENT_VERSION,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  TruthSourceIngestClientError,
  createTruthSourceIngestClient,
  _test: Object.freeze({
    boundedInteger,
    normalizeOrigin,
    readBoundedJson,
    retryableStatus,
    safeDetail,
  }),
});

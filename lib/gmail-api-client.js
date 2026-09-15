"use strict";

const {
  loadStoredGmailRefreshToken: defaultLoadStoredGmailRefreshToken,
  recordGmailOAuthRefreshResult: defaultRecordGmailOAuthRefreshResult,
} = require("./gmail-oauth-store");
const {
  abortableSleep,
  asDeadlineError,
  composeAbortSignals,
  createAbortScope,
  isAbortError,
  throwIfAborted,
} = require("./runtime-deadline");

const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;
const ABSOLUTE_MAX_RETRIES = 10;

const GMAIL_ERROR_KINDS = Object.freeze({
  AUTH: "auth",
  CONFIG: "config",
  FORBIDDEN: "forbidden",
  HISTORY_GAP: "history-gap",
  INVALID_REQUEST: "invalid-request",
  NETWORK: "network",
  NOT_FOUND: "not-found",
  PROTOCOL: "protocol",
  RATE_LIMIT: "rate-limit",
  SERVER: "server",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
});

// Gmail documents rate-limit and backend reasons as safe to retry with backoff.
// Unknown 403 reasons fail closed: retrying a policy or permission denial will not
// repair it and can hide a permanently incomplete mailbox.
const RETRYABLE_403_REASONS = new Set([
  "backenderror",
  "concurrentlimitexceeded",
  "quotaexceeded",
  "ratelimitexceeded",
  "userratelimitexceeded",
]);

const NON_RETRYABLE_403_REASONS = new Set([
  "accessnotconfigured",
  "dailylimitexceeded",
  "domainpolicy",
  "forbidden",
  "insufficientpermissions",
]);

function envValue(value) {
  const raw = String(value || "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function asStringId(value) {
  return value === undefined || value === null ? "" : String(value);
}

function redactSensitiveText(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets) {
    const token = String(secret || "");
    if (token.length >= 4) text = text.split(token).join("[redacted]");
  }
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|id_token|authorization)=([^\s&;,]+)/gi, "$1=[redacted]")
    .slice(0, 500);
}

class GmailApiError extends Error {
  constructor(message, {
    code = "GMAIL_API_ERROR",
    kind = GMAIL_ERROR_KINDS.UNKNOWN,
    status = null,
    reason = "",
    retryable = false,
    operation = "",
    attempts = 0,
    retries = 0,
    authRefreshUsed = false,
    deadlineExceeded = false,
    outcomeUnknown = false,
    details = {},
    cause,
  } = {}) {
    super(redactSensitiveText(message) || "Gmail request failed", cause ? { cause } : undefined);
    this.name = "GmailApiError";
    this.code = code;
    this.kind = kind;
    this.status = status === null || status === undefined || status === ""
      ? null
      : Number.isFinite(Number(status)) ? Number(status) : null;
    this.reason = String(reason || "");
    this.retryable = Boolean(retryable);
    this.operation = String(operation || "");
    this.attempts = Number(attempts || 0);
    this.retries = Number(retries || 0);
    this.authRefreshUsed = Boolean(authRefreshUsed);
    this.deadlineExceeded = Boolean(deadlineExceeded);
    this.outcomeUnknown = Boolean(outcomeUnknown);
    this.details = sanitizeDetails(details);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      kind: this.kind,
      message: this.message,
      status: this.status,
      reason: this.reason,
      retryable: this.retryable,
      operation: this.operation,
      attempts: this.attempts,
      retries: this.retries,
      authRefreshUsed: this.authRefreshUsed,
      deadlineExceeded: this.deadlineExceeded,
      outcomeUnknown: this.outcomeUnknown,
      details: this.details,
    };
  }
}

function sanitizeDetails(details = {}) {
  const allowed = {};
  for (const key of ["googleMessage", "googleStatus", "retryAfterMs", "timeoutMs"]) {
    if (details[key] === undefined || details[key] === null || details[key] === "") continue;
    allowed[key] = typeof details[key] === "string"
      ? redactSensitiveText(details[key])
      : details[key];
  }
  return allowed;
}

function extractGoogleError(payload = {}) {
  const envelope = payload && typeof payload === "object" ? payload.error : null;
  if (typeof envelope === "string") {
    return { message: envelope, reason: envelope, googleStatus: "" };
  }
  const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
  const details = Array.isArray(envelope?.details) ? envelope.details : [];
  const reason = [
    ...errors.map((item) => item?.reason),
    ...details.map((item) => item?.reason || item?.metadata?.reason),
    envelope?.reason,
  ].find(Boolean) || "";
  return {
    message: envelope?.message || payload?.error_description || "",
    reason: String(reason || payload?.error || ""),
    googleStatus: String(envelope?.status || ""),
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(String(name).toLowerCase()) || "";
  const target = String(name).toLowerCase();
  const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === target);
  return entry ? entry[1] : "";
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw) * 1000));
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Number(nowMs || 0)) : 0;
}

function httpErrorFor({ status, payload, operation, retryAfterMs = 0, secrets = [] }) {
  const google = extractGoogleError(payload);
  const reason = redactSensitiveText(google.reason, secrets);
  const normalizedReason = reason.toLowerCase();
  const googleMessage = redactSensitiveText(google.message, secrets);
  const common = {
    status,
    reason,
    operation,
    details: {
      googleMessage,
      googleStatus: google.googleStatus,
      retryAfterMs,
    },
  };

  if (status === 401) {
    return new GmailApiError(googleMessage || "Gmail rejected the access token", {
      ...common,
      code: "GMAIL_UNAUTHORIZED",
      kind: GMAIL_ERROR_KINDS.AUTH,
      retryable: false,
    });
  }
  if (status === 403) {
    const retryable = RETRYABLE_403_REASONS.has(normalizedReason);
    return new GmailApiError(googleMessage || "Gmail denied the request", {
      ...common,
      code: retryable ? "GMAIL_FORBIDDEN_RETRYABLE" : "GMAIL_FORBIDDEN",
      kind: retryable ? GMAIL_ERROR_KINDS.RATE_LIMIT : GMAIL_ERROR_KINDS.FORBIDDEN,
      retryable,
    });
  }
  if (status === 429) {
    return new GmailApiError(googleMessage || "Gmail rate limit exceeded", {
      ...common,
      code: "GMAIL_RATE_LIMITED",
      kind: GMAIL_ERROR_KINDS.RATE_LIMIT,
      retryable: true,
    });
  }
  if (status === 404 && operation === "history.list") {
    return new GmailApiError(googleMessage || "Gmail history cursor is no longer available", {
      ...common,
      code: "GMAIL_HISTORY_CURSOR_EXPIRED",
      kind: GMAIL_ERROR_KINDS.HISTORY_GAP,
      retryable: false,
    });
  }
  if (status === 404) {
    return new GmailApiError(googleMessage || "Gmail resource was not found", {
      ...common,
      code: "GMAIL_NOT_FOUND",
      kind: GMAIL_ERROR_KINDS.NOT_FOUND,
      retryable: false,
    });
  }
  if (status === 408) {
    return new GmailApiError(googleMessage || "Gmail request timed out", {
      ...common,
      code: "GMAIL_TIMEOUT",
      kind: GMAIL_ERROR_KINDS.TIMEOUT,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new GmailApiError(googleMessage || `Gmail server error (${status})`, {
      ...common,
      code: "GMAIL_SERVER_ERROR",
      kind: GMAIL_ERROR_KINDS.SERVER,
      retryable: true,
    });
  }
  if (status >= 400 && status < 500) {
    return new GmailApiError(googleMessage || `Gmail request rejected (${status})`, {
      ...common,
      code: "GMAIL_INVALID_REQUEST",
      kind: GMAIL_ERROR_KINDS.INVALID_REQUEST,
      retryable: false,
    });
  }
  return new GmailApiError(googleMessage || `Unexpected Gmail response (${status})`, {
    ...common,
    code: "GMAIL_HTTP_ERROR",
    kind: GMAIL_ERROR_KINDS.UNKNOWN,
    retryable: false,
  });
}

function normalizeMessageReference(message = {}) {
  if (!message || typeof message !== "object") return message;
  return {
    ...message,
    ...(message.id === undefined ? {} : { id: asStringId(message.id) }),
    ...(message.threadId === undefined ? {} : { threadId: asStringId(message.threadId) }),
  };
}

function normalizeHistoryEntry(entry = {}) {
  const normalizeEventRows = (rows) => Array.isArray(rows)
    ? rows.map((row) => ({ ...row, message: normalizeMessageReference(row?.message || {}) }))
    : rows;
  return {
    ...entry,
    ...(entry.id === undefined ? {} : { id: asStringId(entry.id) }),
    ...(Array.isArray(entry.messages) ? { messages: entry.messages.map(normalizeMessageReference) } : {}),
    ...(Array.isArray(entry.messagesAdded) ? { messagesAdded: normalizeEventRows(entry.messagesAdded) } : {}),
    ...(Array.isArray(entry.messagesDeleted) ? { messagesDeleted: normalizeEventRows(entry.messagesDeleted) } : {}),
    ...(Array.isArray(entry.labelsAdded) ? { labelsAdded: normalizeEventRows(entry.labelsAdded) } : {}),
    ...(Array.isArray(entry.labelsRemoved) ? { labelsRemoved: normalizeEventRows(entry.labelsRemoved) } : {}),
  };
}

function normalizeProfile(payload = {}) {
  return {
    ...payload,
    ...(payload.historyId === undefined ? {} : { historyId: asStringId(payload.historyId) }),
  };
}

function normalizeHistoryResponse(payload = {}) {
  return {
    ...payload,
    ...(payload.historyId === undefined ? {} : { historyId: asStringId(payload.historyId) }),
    history: Array.isArray(payload.history) ? payload.history.map(normalizeHistoryEntry) : [],
  };
}

function normalizeMessageList(payload = {}) {
  return {
    ...payload,
    messages: Array.isArray(payload.messages) ? payload.messages.map(normalizeMessageReference) : [],
  };
}

function normalizeMessage(payload = {}) {
  return {
    ...payload,
    ...(payload.id === undefined ? {} : { id: asStringId(payload.id) }),
    ...(payload.threadId === undefined ? {} : { threadId: asStringId(payload.threadId) }),
    ...(payload.historyId === undefined ? {} : { historyId: asStringId(payload.historyId) }),
    ...(payload.internalDate === undefined ? {} : { internalDate: asStringId(payload.internalDate) }),
    ...(payload.payload && typeof payload.payload === "object" ? { payload: normalizeMessagePart(payload.payload) } : {}),
  };
}

function normalizeMessagePart(part = {}) {
  return {
    ...part,
    ...(part.body && typeof part.body === "object" ? {
      body: {
        ...part.body,
        ...(part.body.attachmentId === undefined ? {} : { attachmentId: asStringId(part.body.attachmentId) }),
      },
    } : {}),
    ...(Array.isArray(part.parts) ? { parts: part.parts.map(normalizeMessagePart) } : {}),
  };
}

function normalizeAttachment(payload = {}) {
  return {
    ...payload,
    ...(payload.attachmentId === undefined ? {} : { attachmentId: asStringId(payload.attachmentId) }),
  };
}

function appendQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function requiredString(value, field, operation) {
  const result = asStringId(value).trim();
  if (result) return result;
  throw new GmailApiError(`${field} is required`, {
    code: "GMAIL_INVALID_ARGUMENT",
    kind: GMAIL_ERROR_KINDS.INVALID_REQUEST,
    retryable: false,
    operation,
  });
}

function createGmailApiClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new GmailApiError("A fetch implementation is required", {
      code: "GMAIL_CLIENT_CONFIG_INVALID",
      kind: GMAIL_ERROR_KINDS.CONFIG,
    });
  }

  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random || Math.random;
  const now = options.now || Date.now;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000);
  const maxRetries = clampInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, ABSOLUTE_MAX_RETRIES);
  const baseBackoffMs = clampInteger(options.baseBackoffMs, DEFAULT_BASE_BACKOFF_MS, 0, 60_000);
  const maxBackoffMs = clampInteger(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, 0, 300_000);
  const maxRetryAfterMs = clampInteger(options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS, 0, 600_000);
  const user = envValue(options.user || env.GMAIL_USER || env.GMAIL_USER_EMAIL) || "me";
  const connectionKey = envValue(options.connectionKey || env.GMAIL_OAUTH_CONNECTION_KEY || env.PQ_GMAIL_OAUTH_CONNECTION_KEY) || "primary";
  const loadStoredGmailRefreshToken = options.loadStoredGmailRefreshToken || defaultLoadStoredGmailRefreshToken;
  const recordGmailOAuthRefreshResult = options.recordGmailOAuthRefreshResult || defaultRecordGmailOAuthRefreshResult;
  const customRefreshAccessToken = options.refreshAccessToken;
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : null;
  const runSignal = options.signal || null;
  const deadlineAtMs = options.deadlineAtMs ?? null;

  let accessToken = envValue(options.initialAccessToken);
  let tokenRefreshPromise = null;

  function tokenConfig() {
    return {
      clientId: envValue(env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID),
      clientSecret: envValue(env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET),
      refreshToken: envValue(env.GMAIL_REFRESH_TOKEN || env.GOOGLE_GMAIL_REFRESH_TOKEN),
    };
  }

  function retryDelay(retryNumber, retryAfterMs = 0) {
    const cap = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, retryNumber - 1)));
    const jitter = cap > 0 ? Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * cap) : 0;
    return Math.min(maxRetryAfterMs, Math.max(0, retryAfterMs)) + jitter;
  }

  async function fetchWithTimeout(url, init, operation, requestSignal = null) {
    const parent = composeAbortSignals([runSignal, requestSignal, init?.signal]);
    const scope = createAbortScope({
      signal: parent.signal,
      timeoutMs,
      now,
      setTimeoutImpl,
      clearTimeoutImpl,
      stage: `Gmail ${operation}`,
    });
    let responseHandedOff = false;
    const cleanup = () => {
      scope.cleanup();
      parent.cleanup();
    };
    const normalizeTransportError = (error) => {
      if (runSignal?.aborted || requestSignal?.aborted) {
        return asDeadlineError(error, {
          signal: scope.signal,
          stage: `Gmail ${operation}`,
        });
      }
      if (isAbortError(error, scope.signal)) {
        return new GmailApiError(`Gmail ${operation} timed out`, {
          code: "GMAIL_TIMEOUT",
          kind: GMAIL_ERROR_KINDS.TIMEOUT,
          retryable: true,
          operation,
          details: { timeoutMs },
          cause: error,
        });
      }
      return new GmailApiError(`Gmail ${operation} network request failed`, {
        code: "GMAIL_NETWORK_ERROR",
        kind: GMAIL_ERROR_KINDS.NETWORK,
        retryable: true,
        operation,
        cause: error,
      });
    };
    try {
      // A run-level cancellation must prevent transport from starting. A
      // per-request timeout may already be aborted in deterministic tests; in
      // that case fetch receives the aborted signal and performs no I/O.
      throwIfAborted(parent.signal, { stage: `Gmail ${operation}`, deadlineAtMs });
      const response = await fetchImpl(url, { ...init, signal: scope.signal });
      responseHandedOff = true;
      return new Proxy(response, {
        get(target, property) {
          if (property === "text") {
            return async (...args) => {
              try {
                return await target.text(...args);
              } catch (error) {
                throw normalizeTransportError(error);
              } finally {
                cleanup();
              }
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch (error) {
      throw normalizeTransportError(error);
    } finally {
      if (!responseHandedOff) cleanup();
    }
  }

  async function responsePayload(response, operation) {
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      if (error instanceof GmailApiError || isAbortError(error)) throw error;
      throw new GmailApiError(`Gmail ${operation} response could not be read`, {
        code: "GMAIL_RESPONSE_UNREADABLE",
        kind: GMAIL_ERROR_KINDS.PROTOCOL,
        retryable: true,
        operation,
        cause: error,
      });
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new GmailApiError(`Gmail ${operation} returned invalid JSON`, {
        code: "GMAIL_RESPONSE_INVALID",
        kind: GMAIL_ERROR_KINDS.PROTOCOL,
        retryable: true,
        operation,
        cause: error,
      });
    }
  }

  async function waitBeforeRetry(error, retryNumber, retryAfterMs = 0, requestSignal = null) {
    const delayMs = retryDelay(retryNumber, retryAfterMs);
    if (onRetry) {
      await onRetry({
        operation: error.operation,
        code: error.code,
        kind: error.kind,
        status: error.status,
        reason: error.reason,
        retryNumber,
        delayMs,
      });
    }
    if (delayMs > 0) {
      const combined = composeAbortSignals([runSignal, requestSignal]);
      try {
        if (combined.signal) {
          await abortableSleep(delayMs, combined.signal, {
            stage: `Gmail ${error.operation} retry wait`,
            deadlineAtMs,
          });
        } else {
          await sleep(delayMs);
        }
      } finally {
        combined.cleanup();
      }
    }
  }

  async function defaultRefreshAccessToken() {
    const cfg = tokenConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new GmailApiError("Missing Gmail OAuth client credentials", {
        code: "GMAIL_OAUTH_CONFIG_MISSING",
        kind: GMAIL_ERROR_KINDS.CONFIG,
        retryable: false,
        operation: "oauth.refresh",
      });
    }

    let refreshToken = cfg.refreshToken;
    let tokenSource = refreshToken ? "static-env" : "stored-oauth";
    if (!refreshToken) {
      try {
        const stored = await loadStoredGmailRefreshToken({ connectionKey, env, signal: runSignal });
        refreshToken = envValue(stored?.refreshToken);
      } catch (error) {
        throw new GmailApiError("Stored Gmail OAuth refresh token is unavailable", {
          code: "GMAIL_OAUTH_TOKEN_UNAVAILABLE",
          kind: GMAIL_ERROR_KINDS.CONFIG,
          retryable: false,
          operation: "oauth.refresh",
          cause: error,
        });
      }
    }
    if (!refreshToken) {
      throw new GmailApiError("Missing Gmail OAuth refresh token", {
        code: "GMAIL_OAUTH_TOKEN_UNAVAILABLE",
        kind: GMAIL_ERROR_KINDS.CONFIG,
        retryable: false,
        operation: "oauth.refresh",
      });
    }

    const secrets = [cfg.clientSecret, refreshToken];
    let retryCount = 0;
    try {
      while (true) {
        let response;
        try {
          response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: cfg.clientId,
              client_secret: cfg.clientSecret,
              refresh_token: refreshToken,
              grant_type: "refresh_token",
            }),
          }, "oauth.refresh");
        } catch (error) {
          if (isAbortError(error, runSignal)) throw error;
          if (error.retryable && retryCount < maxRetries) {
            retryCount += 1;
            await waitBeforeRetry(error, retryCount);
            continue;
          }
          throw error;
        }

        let payload;
        try {
          payload = await responsePayload(response, "oauth.refresh");
        } catch (error) {
          if (isAbortError(error, runSignal)) throw error;
          if (error.retryable && retryCount < maxRetries) {
            retryCount += 1;
            await waitBeforeRetry(error, retryCount);
            continue;
          }
          throw error;
        }
        if (response.ok && payload.access_token) {
          if (tokenSource === "stored-oauth") {
            await recordGmailOAuthRefreshResult({ ok: true, connectionKey, env, signal: runSignal });
          }
          return {
            accessToken: String(payload.access_token),
            tokenSource,
          };
        }

        const retryAfterMs = Math.min(maxRetryAfterMs, parseRetryAfterMs(headerValue(response.headers, "retry-after"), now()));
        const classified = httpErrorFor({
          status: Number(response.status || 0),
          payload,
          operation: "oauth.refresh",
          retryAfterMs,
          secrets,
        });
        const oauthError = new GmailApiError(classified.message || "Google OAuth token refresh failed", {
          code: "GMAIL_OAUTH_REFRESH_FAILED",
          kind: classified.kind,
          status: classified.status,
          reason: classified.reason,
          retryable: classified.retryable,
          operation: "oauth.refresh",
          retries: retryCount,
          details: classified.details,
          cause: classified,
        });
        if (oauthError.retryable && retryCount < maxRetries) {
          retryCount += 1;
          await waitBeforeRetry(oauthError, retryCount, retryAfterMs);
          continue;
        }
        throw oauthError;
      }
    } catch (error) {
      if (isAbortError(error, runSignal)) throw error;
      const safeError = error instanceof GmailApiError
        ? error
        : new GmailApiError("Google OAuth token refresh failed", {
          code: "GMAIL_OAUTH_REFRESH_FAILED",
          kind: GMAIL_ERROR_KINDS.AUTH,
          retryable: false,
          operation: "oauth.refresh",
          cause: error,
        });
      if (tokenSource === "stored-oauth" && !runSignal?.aborted) {
        await recordGmailOAuthRefreshResult({
          ok: false,
          error: redactSensitiveText(safeError.message, secrets),
          connectionKey,
          env,
          signal: runSignal,
        });
      }
      throw safeError;
    }
  }

  async function refreshToken(reason) {
    let result;
    try {
      result = customRefreshAccessToken
        ? await customRefreshAccessToken({ reason, connectionKey, env, signal: runSignal })
        : await defaultRefreshAccessToken();
    } catch (error) {
      if (isAbortError(error, runSignal)) throw error;
      if (error instanceof GmailApiError) throw error;
      throw new GmailApiError("Gmail access token refresh failed", {
        code: "GMAIL_OAUTH_REFRESH_FAILED",
        kind: GMAIL_ERROR_KINDS.AUTH,
        retryable: false,
        operation: "oauth.refresh",
        cause: error,
      });
    }
    const nextToken = envValue(typeof result === "string" ? result : result?.accessToken);
    if (!nextToken) {
      throw new GmailApiError("Gmail token provider returned no access token", {
        code: "GMAIL_OAUTH_REFRESH_FAILED",
        kind: GMAIL_ERROR_KINDS.AUTH,
        retryable: false,
        operation: "oauth.refresh",
      });
    }
    return nextToken;
  }

  async function getAccessToken({ forceRefresh = false, reason = "initial" } = {}) {
    if (forceRefresh) accessToken = "";
    if (accessToken) return accessToken;
    if (!tokenRefreshPromise) {
      tokenRefreshPromise = refreshToken(reason)
        .then((token) => {
          accessToken = token;
          return token;
        })
        .finally(() => {
          tokenRefreshPromise = null;
        });
    }
    return tokenRefreshPromise;
  }

  async function apiRequest(operation, pathname, query = {}, requestOptions = {}) {
    const url = appendQuery(new URL(`${GMAIL_API_ROOT}/${encodeURIComponent(user)}${pathname}`), query);
    const requestSignal = requestOptions.signal || null;
    const combined = composeAbortSignals([runSignal, requestSignal]);
    let retries = 0;
    let attempts = 0;
    let authRefreshUsed = false;

    try {
      while (true) {
        throwIfAborted(combined.signal, { stage: `Gmail ${operation}`, deadlineAtMs });
        const token = await getAccessToken({ reason: attempts ? "retry" : "initial" });
        attempts += 1;
        let response;
        try {
          response = await fetchWithTimeout(url, {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
            },
          }, operation, combined.signal);
        } catch (error) {
          if (isAbortError(error, combined.signal)) throw error;
          error.attempts = attempts;
          error.retries = retries;
          error.authRefreshUsed = authRefreshUsed;
          if (error.retryable && retries < maxRetries) {
            retries += 1;
            await waitBeforeRetry(error, retries, 0, combined.signal);
            continue;
          }
          throw error;
        }

        let payload;
        try {
          payload = await responsePayload(response, operation);
        } catch (error) {
          if (isAbortError(error, combined.signal)) throw error;
          error.attempts = attempts;
          error.retries = retries;
          error.authRefreshUsed = authRefreshUsed;
          if (error.retryable && retries < maxRetries) {
            retries += 1;
            await waitBeforeRetry(error, retries, 0, combined.signal);
            continue;
          }
          throw error;
        }

        if (response.ok) return payload;

        const retryAfterMs = Math.min(maxRetryAfterMs, parseRetryAfterMs(headerValue(response.headers, "retry-after"), now()));
        const error = httpErrorFor({
          status: Number(response.status || 0),
          payload,
          operation,
          retryAfterMs,
          secrets: [token],
        });
        error.attempts = attempts;
        error.retries = retries;
        error.authRefreshUsed = authRefreshUsed;

        if (response.status === 401 && !authRefreshUsed) {
          authRefreshUsed = true;
          await getAccessToken({ forceRefresh: true, reason: "unauthorized" });
          continue;
        }
        if (error.retryable && retries < maxRetries) {
          retries += 1;
          await waitBeforeRetry(error, retries, retryAfterMs, combined.signal);
          continue;
        }
        throw error;
      }
    } finally {
      combined.cleanup();
    }
  }

  async function getProfile(options = {}) {
    return normalizeProfile(await apiRequest("profile.get", "/profile", {}, options));
  }

  async function listHistory({ startHistoryId, pageToken, maxResults, labelId, historyTypes, signal } = {}) {
    const cursor = requiredString(startHistoryId, "startHistoryId", "history.list");
    return normalizeHistoryResponse(await apiRequest("history.list", "/history", {
      startHistoryId: cursor,
      pageToken,
      maxResults,
      labelId,
      historyTypes,
    }, { signal }));
  }

  async function listMessages({ pageToken, maxResults, q, labelIds, includeSpamTrash, signal } = {}) {
    return normalizeMessageList(await apiRequest("messages.list", "/messages", {
      pageToken,
      maxResults,
      q,
      labelIds,
      ...(includeSpamTrash === undefined ? {} : { includeSpamTrash: Boolean(includeSpamTrash) }),
    }, { signal }));
  }

  async function getMessageRaw(messageId, options = {}) {
    const id = requiredString(messageId, "messageId", "messages.get.raw");
    return normalizeMessage(await apiRequest(
      "messages.get.raw",
      `/messages/${encodeURIComponent(id)}`,
      { format: "raw" },
      options,
    ));
  }

  async function getMessageMetadata(messageId, { metadataHeaders = [], signal } = {}) {
    const id = requiredString(messageId, "messageId", "messages.get.metadata");
    return normalizeMessage(await apiRequest("messages.get.metadata", `/messages/${encodeURIComponent(id)}`, {
      format: "metadata",
      metadataHeaders,
    }, { signal }));
  }

  async function getAttachment(messageId, attachmentId, options = {}) {
    const message = requiredString(messageId, "messageId", "attachments.get");
    const attachment = requiredString(attachmentId, "attachmentId", "attachments.get");
    return normalizeAttachment(await apiRequest(
      "attachments.get",
      `/messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(attachment)}`,
      {},
      options,
    ));
  }

  return Object.freeze({
    getAttachment,
    getMessageMetadata,
    getMessageRaw,
    getProfile,
    listHistory,
    listMessages,
  });
}

module.exports = {
  ABSOLUTE_MAX_RETRIES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  GMAIL_ERROR_KINDS,
  GmailApiError,
  NON_RETRYABLE_403_REASONS,
  RETRYABLE_403_REASONS,
  createGmailApiClient,
  parseRetryAfterMs,
  redactSensitiveText,
  _test: {
    asStringId,
    extractGoogleError,
    httpErrorFor,
    normalizeHistoryResponse,
    normalizeAttachment,
    normalizeMessage,
    normalizeMessageList,
    normalizeProfile,
  },
};

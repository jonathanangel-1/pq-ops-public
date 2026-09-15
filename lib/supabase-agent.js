"use strict";

const { normalizeAwb, normalizeAwbFrom } = require("./awb");
const {
  abortableSleep,
  asDeadlineError,
  asOutcomeUnknownError,
  composeAbortSignals,
  isAbortError,
  throwIfAborted,
} = require("./runtime-deadline");

const JOB_TABLE = "agent_jobs";
const SNAPSHOT_TABLE = "app_snapshots";
const TMS_REVIEW_EMAIL = "contact-053@demo-freight.example";
const SUPABASE_RETRY_DELAYS_MS = [1000, 2000, 4000];
const SUPABASE_REQUEST_TIMEOUT_MS = Number(process.env.PQ_SUPABASE_REQUEST_TIMEOUT_MS || 8000);
const LIGHT_SNAPSHOT_TIMEOUT_MS = Number(process.env.PQ_SUPABASE_LIGHT_SNAPSHOT_TIMEOUT_MS || 1200);
const configuredCanonicalInventoryTimeoutMs = Number(process.env.PIKIIO_HOSTED_TRUTH_SNAPSHOT_TIMEOUT_MS || 6000);
const CANONICAL_INVENTORY_TIMEOUT_MS = Number.isFinite(configuredCanonicalInventoryTimeoutMs) && configuredCanonicalInventoryTimeoutMs > 0
  ? Math.max(LIGHT_SNAPSHOT_TIMEOUT_MS, configuredCanonicalInventoryTimeoutMs)
  : Math.max(LIGHT_SNAPSHOT_TIMEOUT_MS, 6000);
const SUPABASE_DIAGNOSTIC_TIMEOUT_MS = Number(process.env.PQ_SUPABASE_DIAGNOSTIC_TIMEOUT_MS || 15000);
const SUPABASE_DIAGNOSTIC_MAX_TIMEOUT_MS = 30000;
const SUPABASE_READ_CIRCUIT_OPEN_MS = Number(process.env.PQ_SUPABASE_READ_CIRCUIT_OPEN_MS || 60000);
let supabaseReadCircuit = {
  openUntil: 0,
  openedAt: "",
  lastError: "",
};

function supabaseEnv() {
  const url = process.env.PQ_SUPABASE_URL;
  const serviceRoleKey = process.env.PQ_SUPABASE_SERVICE_ROLE_KEY || "";
  const anonKey = process.env.PQ_SUPABASE_ANON_KEY || "";
  const key = serviceRoleKey || anonKey;
  if (!url || !key) throw new Error("Missing Supabase environment");
  return { url, key, serviceRoleKey, syncToken: process.env.PQ_SUPABASE_SYNC_TOKEN || "" };
}

function headers(extra = {}) {
  const { key } = supabaseEnv();
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableSupabaseFailure(status, text = "") {
  const code = Number(status);
  const body = String(text || "");
  if ([520, 521, 522, 523, 524].includes(code)) return true;
  if (!Number.isFinite(code) && /\b(?:fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(body)) return true;
  return [500, 502, 503, 504].includes(code) &&
    /\b(?:57014|PGRST002|schema cache|statement timeout|canceling statement due to statement timeout|timeout|temporarily unavailable|database is unavailable|web server is down|unknown connection issue)\b/i.test(body);
}

function structuredPostgrestErrorReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const code = String(value.code || "");
  const message = String(value.message || value.error || "");
  return Boolean(message) && (/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code));
}

function supabaseSchemaOrRouteMissing(error) {
  const status = Number(error?.status);
  const body = String(error?.body || error?.message || "");
  return status === 404 ||
    /\b(?:PGRST202|PGRST204|schema cache|could not find|does not exist|not found)\b/i.test(body);
}

function supabaseReadCircuitHealth(nowMs = Date.now()) {
  const open = supabaseReadCircuit.openUntil > nowMs;
  return {
    open,
    openedAt: supabaseReadCircuit.openedAt || null,
    openUntil: open ? new Date(supabaseReadCircuit.openUntil).toISOString() : null,
    retryAfterMs: open ? Math.max(0, supabaseReadCircuit.openUntil - nowMs) : 0,
    lastError: supabaseReadCircuit.lastError || "",
  };
}

function shouldOpenSupabaseReadCircuit(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (error?.name === "AbortError" || /\b(?:aborted|timeout|timed out)\b/i.test(message)) return true;
  return retryableSupabaseFailure(error?.status, error?.body || message);
}

function markSupabaseReadSuccess() {
  supabaseReadCircuit = { openUntil: 0, openedAt: "", lastError: "" };
}

function markSupabaseReadFailure(error) {
  if (!shouldOpenSupabaseReadCircuit(error)) return;
  const nowMs = Date.now();
  const message = error instanceof Error ? error.message : String(error || "");
  supabaseReadCircuit = {
    openUntil: nowMs + Math.max(1000, SUPABASE_READ_CIRCUIT_OPEN_MS || 60000),
    openedAt: new Date(nowMs).toISOString(),
    lastError: message,
  };
}

function supabaseReadCircuitError() {
  const health = supabaseReadCircuitHealth();
  const error = new Error(
    `Supabase read circuit is open after recent hosted persistence failure; retry after ${Math.ceil((health.retryAfterMs || 0) / 1000)}s.`,
  );
  error.status = 503;
  error.circuitOpen = true;
  error.body = health.lastError;
  return error;
}

// Write-side pressure guard. Writes were previously unguarded: during a hosted outage every
// cron/API write would independently wait out its full timeout+retries against a dead origin.
// Writes now fail fast while the shared circuit is open, mark the circuit on timeout-class
// failures, and can be hard-paused with PQ_SUPABASE_WRITES_DISABLED=1 (fail fast + loud —
// callers already surface persistence failures as degraded health, never silently).
function guardSupabaseWrite(label) {
  if (process.env.PQ_SUPABASE_WRITES_DISABLED === "1") {
    const error = new Error(`Supabase writes are disabled by PQ_SUPABASE_WRITES_DISABLED (${label}).`);
    error.status = 503;
    error.writesDisabled = true;
    throw error;
  }
  if (supabaseReadCircuitHealth().open) throw supabaseReadCircuitError();
}

async function withSupabaseWriteCircuit(label, run) {
  guardSupabaseWrite(label);
  try {
    return await run();
  } catch (error) {
    // A timed-out write is the same origin failure as a timed-out read: open the shared
    // circuit so every subsequent read/write fails fast instead of stacking timeouts.
    markSupabaseReadFailure(error);
    throw error;
  }
}

function retryHeaders(attempt = 0) {
  return attempt > 0 ? { "x-retry-count": String(attempt) } : {};
}

function supabaseFetchOptions(options = {}, timeoutMs = SUPABASE_REQUEST_TIMEOUT_MS) {
  const effectiveTimeoutMs = Number(timeoutMs);
  let timeoutSignal = null;
  if (
    Number.isFinite(effectiveTimeoutMs) &&
    effectiveTimeoutMs > 0 &&
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  }
  const composed = composeAbortSignals([options.signal, timeoutSignal]);
  return composed.signal ? { ...options, signal: composed.signal } : options;
}

function clampDiagnosticTimeoutMs(value, fallback = SUPABASE_DIAGNOSTIC_TIMEOUT_MS) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : Number(fallback);
  if (!Number.isFinite(base)) return 15000;
  return Math.min(SUPABASE_DIAGNOSTIC_MAX_TIMEOUT_MS, Math.max(1000, Math.round(base)));
}

function diagnosticProbeTimeouts(totalTimeoutMs) {
  const totalMs = clampDiagnosticTimeoutMs(totalTimeoutMs);
  return {
    totalMs,
    optionsMs: Math.min(2500, Math.max(750, Math.floor(totalMs * 0.25))),
    metadataMs: Math.min(totalMs, Math.max(1000, totalMs - 750)),
  };
}

function truncateDiagnosticText(value, maxLength = 500) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function selectedDiagnosticFields(value = {}) {
  const allowed = [
    "code",
    "message",
    "hint",
    "details",
    "error",
    "error_code",
    "error_category",
    "retry_after",
    "owner_action_required",
    "ray_id",
    "timestamp",
  ];
  return allowed.reduce((acc, key) => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return acc;
    const fieldValue = value[key];
    if (typeof fieldValue === "string") acc[key] = truncateDiagnosticText(fieldValue);
    else if (typeof fieldValue === "number" || typeof fieldValue === "boolean" || fieldValue === null) acc[key] = fieldValue;
    return acc;
  }, {});
}

function sanitizeSupabaseDiagnosticBody(text = "") {
  if (!text) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text: truncateDiagnosticText(text, 300) };
  }
  if (Array.isArray(parsed)) {
    const latestUpdatedAt = parsed
      .map((row) => String(row?.updated_at || ""))
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    return {
      rowCount: parsed.length,
      snapshotKeys: parsed
        .map((row) => String(row?.snapshot_key || ""))
        .filter(Boolean)
        .slice(0, 5),
      latestUpdatedAt,
    };
  }
  if (parsed && typeof parsed === "object") return selectedDiagnosticFields(parsed);
  return { valueType: typeof parsed };
}

function classifySupabaseProbeResult(probe = {}) {
  const status = Number(probe.status);
  const body = probe.body && typeof probe.body === "object" ? probe.body : {};
  const errorMessage = String(probe.error || body.message || body.error || "");
  if (probe.ok) return "ok";
  if ([520, 521, 522, 523, 524].includes(status) || body.error_category === "origin") return "cloudflare-origin";
  if (probe.errorName === "AbortError" || /\b(?:abort|timeout|timed out)\b/i.test(errorMessage)) return "timeout";
  if (!Number.isFinite(status) && /\b(?:fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(errorMessage)) return "network";
  if (status === 401 || status === 403) return "auth-or-permission";
  if (body.code === "42501" || /\bpermission denied\b/i.test(errorMessage)) return "postgres-permission";
  if (status === 404 || /\b(?:schema cache|could not find|does not exist)\b/i.test(errorMessage)) return "schema-or-route";
  if (status >= 500) return "hosted-error";
  return "api-error";
}

function diagnosticGuidance(category) {
  switch (category) {
    case "ok":
      return "Hosted Supabase persistence answered a keyed metadata read; rerun Gmail refresh before trusting stale local fallback.";
    case "cloudflare-origin":
      return "Supabase edge was reachable, but the project origin/database did not answer. Keep Gmail refresh paused and resolve hosted Supabase availability before publishing live truth.";
    case "timeout":
      return "Hosted Supabase did not answer inside the diagnostic timeout. Keep normal health fail-fast and retry only after the database path recovers.";
    case "auth-or-permission":
    case "postgres-permission":
      return "Hosted Supabase answered but rejected the read. Check Data API grants/RLS/API key configuration before rerunning ingestion.";
    case "schema-or-route":
      return "Hosted Supabase answered but the expected snapshot table/API route was unavailable. Check migrations and Data API exposure.";
    case "not-configured":
      return "Supabase persistence is not configured in this runtime; Gmail ingestion cannot publish live hosted truth.";
    default:
      return "Hosted Supabase persistence is degraded; do not treat bundled shipment truth as live until a keyed snapshot read succeeds.";
  }
}

async function runSupabaseDiagnosticProbe(label, pathname, query = {}, options = {}) {
  const { url } = supabaseEnv();
  const requestUrl = new URL(`${url}${pathname}`);
  Object.entries(query).forEach(([key, value]) => requestUrl.searchParams.set(key, value));
  const timeoutMs = clampDiagnosticTimeoutMs(options.timeoutMs);
  const method = options.method || "GET";
  const startedAt = Date.now();
  try {
    const response = await fetch(requestUrl, supabaseFetchOptions({
      method,
      headers: options.auth === false
        ? { accept: "application/json" }
        : headers({ accept: "application/json" }),
      body: options.body ? JSON.stringify(options.body) : undefined,
    }, timeoutMs));
    const text = await response.text();
    const body = sanitizeSupabaseDiagnosticBody(text);
    const probe = {
      label,
      method,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      body,
    };
    return {
      ...probe,
      category: classifySupabaseProbeResult(probe),
    };
  } catch (error) {
    const probe = {
      label,
      method,
      ok: false,
      status: null,
      statusText: "",
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      errorName: error?.name || "",
      error: truncateDiagnosticText(error instanceof Error ? error.message : String(error), 500),
      body: null,
    };
    return {
      ...probe,
      category: classifySupabaseProbeResult(probe),
    };
  }
}

async function diagnoseHostedPersistence(options = {}) {
  const checkedAt = new Date();
  const timeoutMs = clampDiagnosticTimeoutMs(options.timeoutMs);
  let env = null;
  try {
    env = supabaseEnv();
  } catch (error) {
    return {
      ok: false,
      status: "degraded",
      category: "not-configured",
      checkedAt: checkedAt.toISOString(),
      timeoutMs,
      mutatesState: false,
      diagnosticOnly: true,
      probes: [],
      error: error instanceof Error ? error.message : String(error),
      circuit: supabaseReadCircuitHealth(checkedAt.getTime()),
      operatorGuidance: diagnosticGuidance("not-configured"),
    };
  }

  const table = process.env.PQ_SNAPSHOT_TABLE || SNAPSHOT_TABLE;
  const probeTimeouts = diagnosticProbeTimeouts(timeoutMs);
  const probeJobs = [
    runSupabaseDiagnosticProbe(
      "postgrest-options",
      "/rest/v1/rpc/upsert_app_snapshot",
      {},
      { method: "OPTIONS", auth: false, timeoutMs: probeTimeouts.optionsMs },
    ),
    runSupabaseDiagnosticProbe(
      "app-snapshots-keyed-metadata",
      `/rest/v1/${table}`,
      {
        select: "snapshot_key,updated_at",
        snapshot_key: "eq.shipment-truth-packets",
        limit: "1",
      },
      { timeoutMs: probeTimeouts.metadataMs },
    ),
  ];
  if (env.syncToken) {
    probeJobs.push(runSupabaseDiagnosticProbe(
      "rpc-app-snapshot-metadata",
      "/rest/v1/rpc/read_app_snapshot_metadata",
      {},
      {
        method: "POST",
        timeoutMs: probeTimeouts.metadataMs,
        body: {
          p_snapshot_keys: ["shipment-truth-packets"],
          p_sync_token: env.syncToken,
        },
      },
    ));
  }
  const probes = await Promise.all(probeJobs);

  const primary = probes.find((probe) => probe.label === "rpc-app-snapshot-metadata" && probe.ok) ||
    probes.find((probe) => probe.label === "app-snapshots-keyed-metadata") ||
    probes.at(-1) ||
    null;
  const category = primary?.category || "api-error";
  return {
    ok: Boolean(primary?.ok),
    status: primary?.ok ? "ok" : "degraded",
    category,
    checkedAt: checkedAt.toISOString(),
    timeoutMs: probeTimeouts.totalMs,
    probeTimeouts,
    mutatesState: false,
    diagnosticOnly: true,
    endpoint: "hosted-supabase-app-snapshots-metadata",
    authenticatedProbe: Boolean(env.key),
    probes,
    circuit: supabaseReadCircuitHealth(checkedAt.getTime()),
    operatorGuidance: diagnosticGuidance(category),
  };
}

async function withSupabaseRetry(label, fn, retryDelaysMs = SUPABASE_RETRY_DELAYS_MS, options = {}) {
  const retryDelays = Array.isArray(retryDelaysMs) ? retryDelaysMs : SUPABASE_RETRY_DELAYS_MS;
  const signal = options.signal || null;
  const outcomeUnknown = options.outcomeUnknownOnAbort === true;
  const deadlineAtMs = options.deadlineAtMs ?? null;
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    throwIfAborted(signal, { stage: label, deadlineAtMs, outcomeUnknown });
    try {
      return await fn(attempt);
    } catch (error) {
      if (error?.outcomeUnknown === true) throw error;
      if (isAbortError(error, signal)) {
        throw asDeadlineError(error, { signal, stage: label, deadlineAtMs, outcomeUnknown });
      }
      lastError = error;
      const canRetry = retryableSupabaseFailure(error.status, error.body || error.message);
      if (!canRetry || attempt >= retryDelays.length) break;
      await abortableSleep(retryDelays[attempt], signal, {
        stage: `${label} retry wait`,
        deadlineAtMs,
        outcomeUnknown: false,
      });
    }
  }
  throw lastError || new Error(`Supabase request failed: ${label}`);
}

function localDateParts(date = new Date(), timeZone = "America/New_York") {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
}

const BLOCKED_BETA_LIVE_JOB_TYPES = new Set(["send_gmail_email"]);

function assertBetaSafeJobType(jobType) {
  if (BLOCKED_BETA_LIVE_JOB_TYPES.has(jobType)) {
    throw new Error(`Beta draft mode blocks ${jobType} jobs; queue draft_gmail_email instead.`);
  }
}

function betaDraftModeContract() {
  return {
    mode: "draft-only",
    autonomyLevel: "L2",
    requiresHumanApproval: true,
    liveExecution: false,
    gmailTransport: "draft_gmail_email",
    tmsTransport: "operator-approved-tms",
    tmsTransports: ["send_tms_agt_alert", "complete_tms_pod_closeout"],
    tmsReviewEmail: TMS_REVIEW_EMAIL,
  };
}

async function fetchJson(pathname, query = {}, options = {}) {
  const { url } = supabaseEnv();
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : SUPABASE_RETRY_DELAYS_MS;
  const timeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs")
    ? options.timeoutMs
    : SUPABASE_REQUEST_TIMEOUT_MS;
  if (options.useCircuitBreaker !== false && supabaseReadCircuitHealth().open) {
    throw supabaseReadCircuitError();
  }
  try {
    const result = await withSupabaseRetry(`fetch ${pathname}`, async (attempt) => {
      const requestUrl = new URL(`${url}${pathname}`);
      Object.entries(query).forEach(([key, value]) => requestUrl.searchParams.set(key, value));
      const response = await fetch(requestUrl, supabaseFetchOptions({
        headers: headers(retryHeaders(attempt)),
        signal: options.signal,
      }, timeoutMs));
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Supabase request failed: ${response.status} ${text}`);
        error.status = response.status;
        error.body = text;
        throw error;
      }
      return text ? JSON.parse(text) : null;
    }, retryDelays, { signal: options.signal });
    markSupabaseReadSuccess();
    return result;
  } catch (error) {
    markSupabaseReadFailure(error);
    throw error;
  }
}

async function callSupabaseRpc(functionName, body = {}, options = {}) {
  const { url } = supabaseEnv();
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : SUPABASE_RETRY_DELAYS_MS;
  const timeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs") ? options.timeoutMs : SUPABASE_REQUEST_TIMEOUT_MS;
  const stage = `Supabase RPC ${functionName}`;
  const outcomeUnknown = options.outcomeUnknownOnAbort === true
    || options.outcomeUnknownOnTransportFailure === true;
  const deadlineAtMs = options.deadlineAtMs ?? null;
  throwIfAborted(options.signal, { stage, deadlineAtMs, outcomeUnknown });
  try {
    return await withSupabaseRetry(`rpc ${functionName}`, async (attempt) => {
      throwIfAborted(options.signal, { stage, deadlineAtMs, outcomeUnknown });
      let response;
      try {
        response = await fetch(`${url}/rest/v1/rpc/${functionName}`, supabaseFetchOptions({
          method: "POST",
          headers: headers(retryHeaders(attempt)),
          body: JSON.stringify(body),
          signal: options.signal,
        }, timeoutMs));
      } catch (error) {
        if (!outcomeUnknown || isAbortError(error, options.signal)) throw error;
        throw asOutcomeUnknownError(error, {
          stage: `${stage} transport`,
          deadlineAtMs,
          code: "SUPABASE_RPC_OUTCOME_UNKNOWN",
        });
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        if (!outcomeUnknown) throw error;
        throw asOutcomeUnknownError(error, {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "SUPABASE_RPC_OUTCOME_UNKNOWN",
        });
      }
      if (!response.ok) {
        let result = null;
        try {
          result = text ? JSON.parse(text) : null;
        } catch {
          // A 4xx is a known rejection. An unstructured 5xx is handled below as a lost gateway receipt.
        }
        const error = new Error(result?.message || result?.error || `Supabase RPC failed: ${functionName} ${response.status}`);
        error.status = response.status;
        error.body = text;
        if (outcomeUnknown && Number(response.status) >= 500 && !structuredPostgrestErrorReceipt(result)) {
          throw asOutcomeUnknownError(error, {
            stage: `${stage} gateway receipt`,
            deadlineAtMs,
            code: "SUPABASE_RPC_OUTCOME_UNKNOWN",
          });
        }
        throw error;
      }
      if (!text) {
        if (!outcomeUnknown) return null;
        throw asOutcomeUnknownError(
          new Error(`Supabase RPC ${functionName} returned an empty success receipt`),
          {
            stage: `${stage} response receipt`,
            deadlineAtMs,
            code: "SUPABASE_RPC_OUTCOME_UNKNOWN",
          },
        );
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        if (!outcomeUnknown) throw error;
        throw asOutcomeUnknownError(error, {
          stage: `${stage} response receipt`,
          deadlineAtMs,
          code: "SUPABASE_RPC_OUTCOME_UNKNOWN",
        });
      }
    }, retryDelays, {
      signal: options.signal,
      outcomeUnknownOnAbort: outcomeUnknown,
      deadlineAtMs,
    });
  } catch (error) {
    if (error?.outcomeUnknown === true) throw error;
    if (isAbortError(error, options.signal)) {
      throw asDeadlineError(error, {
        signal: options.signal,
        stage,
        deadlineAtMs,
        outcomeUnknown,
      });
    }
    throw error;
  }
}

async function callSupabaseReadRpc(functionName, body = {}, options = {}) {
  if (options.useCircuitBreaker !== false && supabaseReadCircuitHealth().open) {
    throw supabaseReadCircuitError();
  }
  try {
    const result = await callSupabaseRpc(functionName, body, options);
    markSupabaseReadSuccess();
    return result;
  } catch (error) {
    markSupabaseReadFailure(error);
    throw error;
  }
}

function shouldUseSyncTokenRpc(options = {}) {
  if (options.useSyncTokenRpc === false) return false;
  return Boolean(supabaseEnv().syncToken);
}

function legacySupabaseReadFallbackAllowed(options = {}) {
  if (options.allowLegacyTableReadFallback === true) return true;
  if (options.allowLegacyTableReadFallback === false) return false;
  return process.env.PQ_ALLOW_LEGACY_SUPABASE_READ_FALLBACK === "1" || !supabaseEnv().syncToken;
}

function requiredReadRpcMissingError(functionName, error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const required = new Error(
    `Required Supabase read RPC ${functionName} is unavailable; refusing legacy direct table read fallback. Apply the hosted read-lockdown migrations or set PQ_ALLOW_LEGACY_SUPABASE_READ_FALLBACK=1 only for local migration recovery.`,
  );
  required.status = error?.status || 503;
  required.body = error?.body || message;
  required.cause = error;
  required.rpcMissing = true;
  return required;
}

async function loadAppSnapshotRowsViaSyncRpc(keys = [], options = {}) {
  const { syncToken } = supabaseEnv();
  return callSupabaseReadRpc("read_app_snapshots", {
    p_snapshot_keys: keys,
    p_sync_token: syncToken,
  }, options);
}

async function loadAppSnapshotMetadataRowsViaSyncRpc(keys = [], options = {}) {
  const { syncToken } = supabaseEnv();
  return callSupabaseReadRpc("read_app_snapshot_metadata", {
    p_snapshot_keys: keys,
    p_sync_token: syncToken,
  }, options);
}

function normalizeSnapshotMetadataRow(row = {}) {
  return {
    snapshot_key: row.snapshot_key || "",
    snapshot_time: row.snapshot_time || row.snapshotTime || null,
    updated_at: row.updated_at || row.updatedAt || null,
    writer_version: row.writer_version || row.writerVersion || "",
    content_signature: row.content_signature || row.contentSignature || "",
  };
}

async function loadAppSnapshotMetadataRows(snapshotKeys = [], options = {}) {
  const keys = Array.from(new Set((Array.isArray(snapshotKeys) ? snapshotKeys : [snapshotKeys])
    .map((key) => String(key || "").trim())
    .filter(Boolean)));
  if (!keys.length) return [];
  if (shouldUseSyncTokenRpc(options)) {
    try {
      const rpcRows = await loadAppSnapshotMetadataRowsViaSyncRpc(keys, options);
      return (Array.isArray(rpcRows) ? rpcRows : []).map(normalizeSnapshotMetadataRow);
    } catch (error) {
      if (!supabaseSchemaOrRouteMissing(error)) throw error;
      if (!legacySupabaseReadFallbackAllowed(options)) {
        throw requiredReadRpcMissingError("read_app_snapshot_metadata", error);
      }
    }
  }
  const table = process.env.PQ_SNAPSHOT_TABLE || SNAPSHOT_TABLE;
  const rows = await fetchJson(`/rest/v1/${table}`, {
    select: "snapshot_key,updated_at",
    snapshot_key: `in.(${keys.join(",")})`,
  }, options);
  return (Array.isArray(rows) ? rows : []).map(normalizeSnapshotMetadataRow);
}

async function loadAppSnapshotRows(snapshotKeys = [], options = {}) {
  const keys = Array.from(new Set((Array.isArray(snapshotKeys) ? snapshotKeys : [snapshotKeys])
    .map((key) => String(key || "").trim())
    .filter(Boolean)));
  if (!keys.length) return [];
  if (shouldUseSyncTokenRpc(options)) {
    try {
      const rpcRows = await loadAppSnapshotRowsViaSyncRpc(keys, options);
      return Array.isArray(rpcRows) ? rpcRows : [];
    } catch (error) {
      if (!supabaseSchemaOrRouteMissing(error)) throw error;
      if (!legacySupabaseReadFallbackAllowed(options)) {
        throw requiredReadRpcMissingError("read_app_snapshots", error);
      }
    }
  }
  const table = process.env.PQ_SNAPSHOT_TABLE || SNAPSHOT_TABLE;
  const rows = await fetchJson(`/rest/v1/${table}`, {
    select: "snapshot_key,payload,updated_at",
    snapshot_key: `in.(${keys.join(",")})`,
  }, options);
  return Array.isArray(rows) ? rows : [];
}

async function loadAppSnapshot(snapshotKey, fallback = {}, options = {}) {
  const rows = await loadAppSnapshotRows([snapshotKey], options);
  const payload = Array.isArray(rows) ? rows[0]?.payload : rows?.payload;
  return payload || fallback;
}

async function upsertAppSnapshot(snapshotKey, payload, options = {}) {
  guardSupabaseWrite(`upsert snapshot ${snapshotKey}`);
  const { url, syncToken } = supabaseEnv();
  if (!syncToken) throw new Error("Missing PQ_SUPABASE_SYNC_TOKEN");
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : SUPABASE_RETRY_DELAYS_MS;
  const timeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs") ? options.timeoutMs : SUPABASE_REQUEST_TIMEOUT_MS;
  return withSupabaseWriteCircuit(`upsert snapshot ${snapshotKey}`, () => withSupabaseRetry(`upsert snapshot ${snapshotKey}`, async (attempt) => {
    const response = await fetch(`${url}/rest/v1/rpc/upsert_app_snapshot`, supabaseFetchOptions({
      method: "POST",
      headers: headers(retryHeaders(attempt)),
      body: JSON.stringify({
        p_snapshot_key: snapshotKey,
        p_payload: payload,
        p_sync_token: syncToken,
      }),
    }, timeoutMs));
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Snapshot upsert failed for ${snapshotKey}: ${response.status} ${text}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }, retryDelays));
}

async function upsertOpsFactLedger(payload, options = {}) {
  const { syncToken } = supabaseEnv();
  if (!syncToken) throw new Error("Missing PQ_SUPABASE_SYNC_TOKEN");
  return withSupabaseWriteCircuit("upsert ops fact ledger", () => callSupabaseRpc("upsert_ops_fact_ledger", {
    p_payload: payload || {},
    p_sync_token: syncToken,
  }, options));
}

function snapshotLoadWarning(snapshotKey, error, fallbackSource) {
  return {
    type: "snapshot-load-failed",
    snapshotKey,
    fallbackSource,
    message: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  };
}

function snapshotReadSkippedWarning(snapshotKey, fallbackSource, reason = "hosted-read-skipped") {
  return {
    type: "snapshot-read-skipped",
    snapshotKey,
    fallbackSource,
    reason,
    message: "Hosted snapshot read skipped after an upstream persistence check failed; using local fallback.",
    at: new Date().toISOString(),
  };
}

function warningText(warning) {
  if (typeof warning === "string") return warning;
  if (!warning || typeof warning !== "object") return String(warning || "");
  return [
    warning.type,
    warning.snapshotKey,
    warning.fallbackSource,
    warning.reason,
    warning.message,
  ].filter(Boolean).join(" ");
}

async function optionalSnapshot(snapshotKey, fallback, warnings, options = {}) {
  try {
    return await loadAppSnapshot(snapshotKey, fallback, {
      timeoutMs: options.timeoutMs || LIGHT_SNAPSHOT_TIMEOUT_MS,
      retryDelaysMs: Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : [],
    });
  } catch (error) {
    warnings.push(snapshotLoadWarning(snapshotKey, error, "empty-fallback"));
    return fallback;
  }
}

function selectProductionSource({ activeAwbIndex = null, hostedTruthPackets = null } = {}) {
  const hostedRows = Array.isArray(hostedTruthPackets?.shipments) ? hostedTruthPackets.shipments : [];
  if (!hostedRows.length) {
    return {
      awbs: [],
      canPublish: false,
      source: "unavailable",
      payload: { shipments: [] },
    };
  }
  const indexAwbs = (activeAwbIndex?.activeAwbs || []).map(normalizeAwb).filter(Boolean);
  const packetAwbs = hostedRows
    .filter((shipment) => !shipment.truthPacketRole || String(shipment.truthPacketRole).toLowerCase() === "active")
    .map((shipment) => normalizeAwb(shipment.awb))
    .filter(Boolean);
  const indexSignature = String(activeAwbIndex?.truthPacketContentSignature || "");
  const packetSignature = String(hostedTruthPackets?.contentSignature || "");
  const indexMatchesPacket = Boolean(
    indexAwbs.length && indexSignature && packetSignature && indexSignature === packetSignature
  );
  return {
    awbs: [...new Set(indexMatchesPacket ? indexAwbs : packetAwbs)],
    canPublish: true,
    source: indexMatchesPacket
      ? "active-awb-index+hosted-shipment-truth-packets"
      : indexAwbs.length
        ? "hosted-shipment-truth-packets+stale-index-ignored"
        : "hosted-shipment-truth-packets",
    activeAwbIndexStale: Boolean(indexAwbs.length && !indexMatchesPacket),
    payload: hostedTruthPackets,
  };
}

async function loadActiveAwbs(options = {}) {
  const now = new Date();
  const warnings = [];
  const includeSupplementalAwbs = Boolean(
    options.includeSupplementalAwbs ||
      process.env.PQ_GMAIL_REFRESH_INCLUDE_SUPPLEMENTAL_AWBS === "1"
  );
  let activeAwbIndex = null;
  let hostedTruthPackets = null;
  const skipHostedReads = Boolean(options.skipHostedReads);
  if (skipHostedReads) {
    warnings.push(snapshotReadSkippedWarning(
      "active-awb-index",
      "no-truth-fallback",
      options.skipReason || "hosted-read-fallback",
    ));
  } else {
    try {
      // Canonical inventory is one atomic source-selection input. Read the
      // small index and multi-megabyte truth packet in one keyed RPC under the
      // dedicated canonical timeout; two light reads let an index timeout open
      // the circuit before the mandatory truth packet could even be attempted.
      const canonicalRows = await loadAppSnapshotRows([
        "active-awb-index",
        "shipment-truth-packets",
      ], {
        timeoutMs: CANONICAL_INVENTORY_TIMEOUT_MS,
        retryDelaysMs: [],
      });
      const canonicalByKey = new Map((Array.isArray(canonicalRows) ? canonicalRows : [])
        .map((row) => [String(row?.snapshot_key || ""), row?.payload || null]));
      activeAwbIndex = canonicalByKey.get("active-awb-index") || null;
      hostedTruthPackets = canonicalByKey.get("shipment-truth-packets") || null;
      if (!activeAwbIndex) {
        warnings.push(snapshotLoadWarning(
          "active-awb-index",
          new Error("Hosted active-awb-index row is missing from the canonical inventory read."),
          "no-truth-fallback",
        ));
      }
      if (!hostedTruthPackets) {
        warnings.push(snapshotLoadWarning(
          "shipment-truth-packets",
          new Error("Hosted shipment-truth-packets row is missing from the canonical inventory read."),
          "no-truth-fallback",
        ));
      }
    } catch (error) {
      warnings.push(snapshotLoadWarning("active-awb-index", error, "no-truth-fallback"));
      warnings.push(snapshotLoadWarning("shipment-truth-packets", error, "no-truth-fallback"));
    }
  }
  const sourceSelection = selectProductionSource({ activeAwbIndex, hostedTruthPackets });
  const payload = sourceSelection.payload;
  const activeAwbSource = sourceSelection.source;
  const hostedTruthUnavailable = !sourceSelection.canPublish;
  const [brain, shipmentState, companionMemory, stationMemory, unitedTracking, elalTracking, otherTracking] = hostedTruthUnavailable
    ? [
        { shipments: [], completed: [] },
        { shipments: [] },
        { operatorNotes: [] },
        { contacts: [] },
        { tracking: [] },
        { tracking: [] },
        { tracking: [] },
      ]
    : await Promise.all([
        optionalSnapshot("ops-brain-memory", { shipments: [], completed: [] }, warnings),
        optionalSnapshot("shipment-state", { shipments: [] }, warnings),
        // Operator-recorded truth is FIRST-CLASS: the companion-memory
        // snapshot is tiny, and a silent 1.2s-timeout fallback here meant
        // recorded pickups never became durable truth (anchor 016-80000163).
        // Give it a real timeout + retries; if it still fails, the warning
        // below travels into the written packets so nothing degrades silently.
        optionalSnapshot("companion-memory", { operatorNotes: [] }, warnings, {
          timeoutMs: Number(process.env.PQ_COMPANION_MEMORY_TIMEOUT_MS || 5000),
          retryDelaysMs: [500, 1500],
        }),
        // Operator-taught station contacts share the companion-memory rule:
        // a silent fallback here means a save never retires its action
        // (INC-2026-07-05-STATION-MEMORY-SAVE-UNBOUND-AND-UNAPPLIED).
        optionalSnapshot("station-memory", { contacts: [] }, warnings, {
          timeoutMs: Number(process.env.PQ_COMPANION_MEMORY_TIMEOUT_MS || 5000),
          retryDelaysMs: [500, 1500],
        }),
        optionalSnapshot("united-tracking-snapshot", { tracking: [] }, warnings),
        optionalSnapshot("elal-tracking-snapshot", { tracking: [] }, warnings),
        optionalSnapshot("other-tracking-snapshot", { tracking: [] }, warnings),
      ]);
  if (warnings.some((warning) => warningText(warning).includes("companion-memory"))) {
    warnings.push("Operator notes were unavailable this refresh — operator-recorded truth may be delayed until the next successful cycle.");
  }
  if (warnings.some((warning) => warningText(warning).includes("station-memory"))) {
    warnings.push("Station memory was unavailable this refresh — operator-taught station contacts may be delayed until the next successful cycle.");
  }
  const activeShipments = (payload?.shipments || []).filter((shipment) =>
    !shipment.truthPacketRole || shipment.truthPacketRole === "active"
  );
  const brainOpen = brain?.shipments || [];
  const brainCompleted = brain?.completed || [];
  const sourceBackfillCandidates = includeSupplementalAwbs
    ? brainCompleted.filter((shipment) =>
        sourceCoverageNeedsBackfill(shipment) && !shouldRefreshGmailForShipment(shipment)
      )
    : [];
  const sourceBackfillLimit = Math.max(0, Number(process.env.PQ_GMAIL_SOURCE_BACKFILL_AWB_LIMIT || 6) || 6);
  const sourceBackfillShipments = sourceBackfillCandidates.slice(0, sourceBackfillLimit);
  const stateRows = shipmentState?.shipments || [];
  const operatorNotes = companionMemory?.operatorNotes || [];
  const supplementalAwbs = includeSupplementalAwbs
    ? [
        ...brainOpen.filter(shouldRefreshGmailForShipment).map((shipment) => shipment.awb),
        ...brainCompleted.filter(shouldRefreshGmailForShipment).map((shipment) => shipment.awb),
        ...sourceBackfillShipments.map((shipment) => shipment.awb),
        ...stateRows.filter(shouldRefreshGmailForShipment).map((shipment) => shipment.awb),
        ...operatorNotes
          .filter((note) => shouldRefreshGmailForOperatorNote(note, now))
          .map((note) => normalizeAwbFrom(note.awb, note.shipmentAwb, note.text, note.summary)),
      ]
    : [];
  const awbs = [...new Set([
    ...sourceSelection.awbs,
    ...supplementalAwbs,
  ].map((awb) => normalizeAwb(awb)).filter(Boolean))];
  return {
    awbs,
    canPublish: sourceSelection.canPublish,
    snapshotTime: payload?.snapshotTime || null,
    snapshots: {
      active: payload,
      brain,
      shipmentState,
      companionMemory,
      stationMemory,
      carrierTrackingSnapshots: [unitedTracking, elalTracking, otherTracking],
    },
    sourceCounts: {
      activeAwbIndex: activeAwbIndex?.counts?.activeShipments || (activeAwbIndex?.activeAwbs || []).length || 0,
      active: activeShipments.length,
      brainOpen: brainOpen.length,
      brainCompleted: brainCompleted.length,
      sourceBackfillCandidates: sourceBackfillCandidates.length,
      sourceBackfillIncluded: sourceBackfillShipments.length,
      shipmentState: stateRows.length,
      operatorNotes: operatorNotes.length,
      operatorNoteRefreshCandidates: operatorNotes.filter((note) => shouldRefreshGmailForOperatorNote(note)).length,
      supplementalAwbsIncluded: includeSupplementalAwbs ? supplementalAwbs.length : 0,
    },
    recommendedLookbackDays: sourceBackfillShipments.length
      ? Math.max(7, Number(process.env.PQ_GMAIL_SOURCE_BACKFILL_LOOKBACK_DAYS || process.env.PQ_GMAIL_COMPLETED_BACKFILL_LOOKBACK_DAYS || 120) || 120)
      : null,
    activeAwbSource,
    sourceTruthWarnings: warnings,
  };
}

function sourceCoverageNeedsBackfill(shipment = {}) {
  const coverage = shipment.sourceCoverage || shipment.completion?.sourceCoverage || {};
  return Boolean(
    normalizeAwb(shipment.awb) &&
      (
        coverage.needsHistoricalBackfill ||
        coverage.completeness === "final-proof-only" ||
        (Array.isArray(coverage.missingPreDeliveryStages) && coverage.missingPreDeliveryStages.length > 0)
      )
  );
}

function shouldRefreshGmailForShipment(shipment = {}) {
  const text = [
    shipment.awb,
    shipment.stage,
    shipment.currentState,
    shipment.nextAction,
    shipment.arrivalStatus,
    shipment.clearanceStatus,
    shipment.pickupStatus,
    shipment.deliveryStatus,
    shipment.pod?.status,
    shipment.opsState?.phase,
    shipment.opsState?.gates?.pod?.status,
    shipment.opsState?.gates?.delivery?.status,
    shipment.freightBroker?.status,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.deliveryPlan,
    shipment.customsBroker?.status,
    ...(shipment.facts || []).map((fact) => `${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`),
  ].filter(Boolean).join(" ");
  if (!normalizeAwb(shipment.awb)) return false;
  if (/\b(?:pod|proof of delivery|delivery proof|signed proof)\b[^.;\n]{0,80}\b(?:pending|missing|needed|not received|not found|request|collect|follow[-\s]?up)\b/i.test(text)) return true;
  if (/\b(?:pending|missing|needed|not received|not found|request|collect|follow[-\s]?up)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|signed proof)\b/i.test(text)) return true;
  if (/\b(?:signed-pod-pending|delivered-pod-pending|pod-needed|pickup-onsite|driver-onsite|pickup-blocked|arrival-incomplete|customs-hold|release-needed|ready-for-pickup|pre-arrival)\b/i.test(text)) return true;
  if (/\b(?:delivered|completed)\b/i.test(text) && /\b(?:pod|proof of delivery|delivery proof)\b/i.test(text)) {
    return !/\b(?:pod[-\s]?(?:found|received|attached|done)|proof of delivery (?:attached|received)|delivered-pod-received|delivered-pod-found|freight-delivered-pod-found)\b/i.test(text);
  }
  return !shipment.completed && !/\b(?:completed|delivered)\b/i.test(String(shipment.opsState?.phase || ""));
}

function shouldRefreshGmailForOperatorNote(note = {}, now = new Date()) {
  const referenceTime = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const awb = normalizeAwbFrom(note.awb, note.shipmentAwb, note.text, note.summary);
  if (!awb) return false;
  const text = [
    note.status,
    note.purpose,
    note.text,
    note.summary,
    ...(Array.isArray(note.facts) ? note.facts.map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.status || ""}`) : []),
  ].filter(Boolean).join(" ");
  if (/\b(?:closed|complete|completed|done|resolved)\b/i.test(String(note.status || ""))) return false;
  if (/\b(?:pod|proof of delivery)\b.{0,60}\b(?:found|received|attached|uploaded|signed|provided)\b/i.test(text)) return false;
  const observedAt = Date.parse(note.updatedAt || note.createdAt || note.at || "");
  if (!Number.isFinite(observedAt)) return /\b(?:pending|missing|needed|requested|waiting|blocked|not released|not arrived|pod|delivery order|d\/?o|pickup|driver|station)\b/i.test(text);
  const lookbackDays = Math.max(1, Number(process.env.PQ_OPERATOR_NOTE_ACTIVE_LOOKBACK_DAYS || 14) || 14);
  return referenceTime.getTime() - observedAt <= lookbackDays * 24 * 60 * 60 * 1000;
}

async function recentJobs(jobType, limit = 20) {
  if (shouldUseSyncTokenRpc()) {
    try {
      const { syncToken } = supabaseEnv();
      const rows = await callSupabaseReadRpc("recent_agent_jobs", {
        p_job_type: jobType,
        p_limit: Math.min(100, Math.max(1, Number(limit) || 20)),
        p_sync_token: syncToken,
      });
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      if (!supabaseSchemaOrRouteMissing(error)) throw error;
      if (!legacySupabaseReadFallbackAllowed()) {
        throw requiredReadRpcMissingError("recent_agent_jobs", error);
      }
    }
  }
  const table = process.env.PQ_AGENT_JOB_TABLE || JOB_TABLE;
  return fetchJson(`/rest/v1/${table}`, {
    select: "id,job_type,status,created_at,updated_at,locked_at,completed_at,last_error,result,dedupe_key",
    job_type: `eq.${jobType}`,
    order: "created_at.desc",
    limit: String(limit),
  });
}

function normalizeAgentJobSummary(row) {
  if (!row || typeof row !== "object") return row;
  const existingPayload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const payload = {
    ...existingPayload,
    actionId: existingPayload.actionId || row.action_id || "",
    shipmentId: existingPayload.shipmentId || row.shipment_id || "",
    awb: existingPayload.awb || row.awb || "",
    outboxRequestId: existingPayload.outboxRequestId || row.outbox_request_id || "",
    targetName: existingPayload.targetName || row.target_name || "",
    to: existingPayload.to || row.target_email || "",
    originalTargetName: existingPayload.originalTargetName || row.original_target_name || "",
    originalTargetEmail: existingPayload.originalTargetEmail || row.original_target_email || "",
    stationContactMissing: Boolean(existingPayload.stationContactMissing || row.station_contact_missing),
    reason: existingPayload.reason || row.reason || "",
    subject: existingPayload.subject || row.subject || "",
    type: existingPayload.type || row.type || row.job_type || "",
  };
  return {
    ...row,
    payload,
    result: row.status === "succeeded"
      ? {
          drafted: Boolean(row.drafted),
          sent: Boolean(row.sent),
        }
      : row.result || null,
  };
}

async function listAgentJobSummaries(limit = 60, options = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 60));
  const fields = [
    "id",
    "job_type",
    "status",
    "action_id",
    "shipment_id",
    "awb",
    "outbox_request_id",
    "target_name",
    "target_email",
    "original_target_name",
    "original_target_email",
    "station_contact_missing",
    "reason",
    "subject",
    "type",
    "created_at",
    "updated_at",
    "completed_at",
    "last_error",
    "drafted",
    "sent",
  ].join(",");
  if (shouldUseSyncTokenRpc(options)) {
    try {
      const { syncToken } = supabaseEnv();
      const rows = await callSupabaseReadRpc("list_agent_job_summaries", {
        p_limit: safeLimit,
        p_sync_token: syncToken,
      }, {
        timeoutMs: Object.prototype.hasOwnProperty.call(options, "timeoutMs")
          ? options.timeoutMs
          : LIGHT_SNAPSHOT_TIMEOUT_MS,
        retryDelaysMs: Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : [],
      });
      return (Array.isArray(rows) ? rows : []).map(normalizeAgentJobSummary);
    } catch (error) {
      if (!supabaseSchemaOrRouteMissing(error)) throw error;
      if (!legacySupabaseReadFallbackAllowed(options)) {
        throw requiredReadRpcMissingError("list_agent_job_summaries", error);
      }
    }
  }
  const table = process.env.PQ_AGENT_JOB_SUMMARY_TABLE || "agent_job_summaries";
  const rows = await fetchJson(`/rest/v1/${table}`, {
    select: fields,
    status: "in.(queued,running,failed,waiting_external,succeeded)",
    order: "created_at.desc",
    limit: String(safeLimit),
  }, {
    timeoutMs: Object.prototype.hasOwnProperty.call(options, "timeoutMs")
      ? options.timeoutMs
      : LIGHT_SNAPSHOT_TIMEOUT_MS,
    retryDelaysMs: Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : [],
  });
  return (Array.isArray(rows) ? rows : []).map(normalizeAgentJobSummary);
}

function staleJobAgeMs(job, now) {
  const timestamp = Date.parse(job.locked_at || job.updated_at || job.created_at || "");
  return Number.isFinite(timestamp) ? now.getTime() - timestamp : Infinity;
}

function staleJobThresholdMs(intervalMinutes) {
  return Math.max(30, Math.max(1, intervalMinutes) * 3) * 60 * 1000;
}

function isStaleInFlightJob(job, intervalMinutes, now = new Date()) {
  if (!["queued", "running", "waiting_external"].includes(job.status)) return false;
  return staleJobAgeMs(job, now) > staleJobThresholdMs(intervalMinutes);
}

function shouldQueueByInterval(jobs, intervalMinutes, now = new Date()) {
  const inFlight = jobs.find(
    (job) => ["queued", "running", "waiting_external"].includes(job.status) && !isStaleInFlightJob(job, intervalMinutes, now),
  );
  if (inFlight) {
    return {
      queue: false,
      reason: `Existing ${inFlight.status} job`,
      job: inFlight,
    };
  }

  const lastSuccess = jobs.find((job) => job.status === "succeeded" && job.completed_at);
  if (lastSuccess) {
    const completedAt = Date.parse(lastSuccess.completed_at);
    if (Number.isFinite(completedAt) && now.getTime() - completedAt < intervalMinutes * 60 * 1000) {
      return {
        queue: false,
        reason: `Last successful job is newer than ${intervalMinutes} minutes`,
        job: lastSuccess,
      };
    }
  }

  return { queue: true };
}

async function queueAgentJob(jobType, payload, options = {}) {
  assertBetaSafeJobType(jobType);
  guardSupabaseWrite(`queue agent job ${jobType}`);
  const { url, serviceRoleKey, syncToken } = supabaseEnv();
  const table = process.env.PQ_AGENT_JOB_TABLE || JOB_TABLE;
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : SUPABASE_RETRY_DELAYS_MS;
  const timeoutMs = Object.prototype.hasOwnProperty.call(options, "timeoutMs")
    ? options.timeoutMs
    : SUPABASE_REQUEST_TIMEOUT_MS;

  if (syncToken) {
    return withSupabaseRetry(`queue agent job ${jobType}`, async (attempt) => {
      const response = await fetch(`${url}/rest/v1/rpc/queue_agent_job`, supabaseFetchOptions({
        method: "POST",
        headers: headers(retryHeaders(attempt)),
        body: JSON.stringify({
          p_sync_token: syncToken,
          p_job_type: jobType,
          p_payload: payload || {},
          p_dedupe_key: options.dedupeKey || null,
          p_priority: options.priority || 50,
          p_max_attempts: options.maxAttempts || 3,
        }),
      }, timeoutMs));
      const text = await response.text();
      const result = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(result?.message || result?.error || `Agent queue failed: ${response.status}`);
        error.status = response.status;
        error.body = text;
        throw error;
      }
      return {
        queued: Boolean(result?.id),
        duplicate: Boolean(options.dedupeKey && result?.dedupe_key === options.dedupeKey && result?.created_at !== result?.updated_at),
        job: result,
      };
    }, retryDelays);
  }

  return withSupabaseRetry(`queue agent job ${jobType}`, async (attempt) => {
    const response = await fetch(`${url}/rest/v1/${table}`, supabaseFetchOptions({
      method: "POST",
      headers: headers({ prefer: "return=representation", ...retryHeaders(attempt) }),
      body: JSON.stringify({
        job_type: jobType,
        status: "queued",
        payload,
        dedupe_key: options.dedupeKey || null,
        priority: options.priority || 50,
        max_attempts: options.maxAttempts || 3,
      }),
    }, timeoutMs));
    const text = await response.text();
    if (response.status === 409) return { queued: false, duplicate: true, reason: "Duplicate job" };
    const result = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(result?.message || result?.error || `Agent queue failed: ${response.status}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { queued: true, job: Array.isArray(result) ? result[0] : result };
  }, retryDelays);
}

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.authorization === `Bearer ${secret}`;
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  // Minified: the board payload is polled continuously; 2-space indentation
  // added ~35% bytes and stringify/parse work for zero information.
  response.end(JSON.stringify(body));
}

module.exports = {
  authorized,
  assertBetaSafeJobType,
  betaDraftModeContract,
  callSupabaseRpc,
  diagnoseHostedPersistence,
  loadAppSnapshot,
  loadAppSnapshotMetadataRows,
  loadAppSnapshotRows,
  loadActiveAwbs,
  isStaleInFlightJob,
  listAgentJobSummaries,
  localDateParts,
  queueAgentJob,
  recentJobs,
  sendJson,
  selectProductionSource,
  shouldQueueByInterval,
  shouldRefreshGmailForOperatorNote,
  supabaseReadCircuitHealth,
  upsertAppSnapshot,
  upsertOpsFactLedger,
  _test: {
    clampDiagnosticTimeoutMs,
    classifySupabaseProbeResult,
    diagnosticProbeTimeouts,
    diagnosticGuidance,
    sanitizeSupabaseDiagnosticBody,
  },
};

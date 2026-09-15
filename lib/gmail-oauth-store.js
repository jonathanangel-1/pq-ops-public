"use strict";

const crypto = require("node:crypto");
const { formatAwb, normalizeAwb } = require("./awb");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  createAbortScope,
  isAbortError,
  throwIfAborted,
} = require("./runtime-deadline");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_OAUTH_TABLE = "gmail_oauth_connections";
const DEFAULT_CONNECTION_KEY = "primary";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];
const TOKEN_AAD = "pikiio:gmail-oauth-refresh-token:v1";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_OAUTH_STORE_TIMEOUT_MS = 20_000;

function envValue(value) {
  const raw = String(value || "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function oauthEnv(env = process.env) {
  const clientId = envValue(env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID);
  const clientSecret = envValue(env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET);
  const serviceRoleKey = envValue(env.PQ_SUPABASE_SERVICE_ROLE_KEY);
  const supabaseUrl = envValue(env.PQ_SUPABASE_URL);
  const tokenEncryptionKey = envValue(env.GMAIL_OAUTH_TOKEN_ENCRYPTION_KEY || env.PQ_GMAIL_OAUTH_TOKEN_ENCRYPTION_KEY);
  const stateSecret = envValue(env.GMAIL_OAUTH_STATE_SECRET || env.PQ_GMAIL_OAUTH_STATE_SECRET || env.CRON_SECRET);
  const connectionKey = envValue(env.GMAIL_OAUTH_CONNECTION_KEY || env.PQ_GMAIL_OAUTH_CONNECTION_KEY) || DEFAULT_CONNECTION_KEY;
  const redirectUri = envValue(env.GMAIL_OAUTH_REDIRECT_URI || env.PQ_GMAIL_OAUTH_REDIRECT_URI);
  const userHint = envValue(env.GMAIL_USER_EMAIL || env.GMAIL_USER);
  return {
    clientId,
    clientSecret,
    serviceRoleKey,
    supabaseUrl,
    tokenEncryptionKey,
    stateSecret,
    connectionKey,
    redirectUri,
    userHint,
    storeConfigured: Boolean(supabaseUrl && serviceRoleKey && tokenEncryptionKey),
    oauthConfigured: Boolean(clientId && clientSecret && supabaseUrl && serviceRoleKey && tokenEncryptionKey),
  };
}

function gmailOAuthStoreConfigured(env = process.env) {
  return oauthEnv(env).storeConfigured;
}

function gmailOAuthConfigured(env = process.env) {
  return oauthEnv(env).oauthConfigured;
}

function missingOAuthConfig(env = process.env, redirectUri = "") {
  const cfg = oauthEnv(env);
  return [
    cfg.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
    cfg.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
    cfg.supabaseUrl ? "" : "PQ_SUPABASE_URL",
    cfg.serviceRoleKey ? "" : "PQ_SUPABASE_SERVICE_ROLE_KEY",
    cfg.tokenEncryptionKey ? "" : "GMAIL_OAUTH_TOKEN_ENCRYPTION_KEY",
    (redirectUri || cfg.redirectUri) ? "" : "GMAIL_OAUTH_REDIRECT_URI or request host",
    cfg.stateSecret ? "" : "GMAIL_OAUTH_STATE_SECRET or CRON_SECRET",
  ].filter(Boolean);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function redactSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return "[redacted]";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function encryptionKey(secret) {
  const raw = envValue(secret);
  if (!raw) throw new Error("Missing Gmail OAuth token encryption key");
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to a deterministic KDF for deploy-friendly secret strings.
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encryptRefreshToken(refreshToken, env = process.env) {
  const cfg = oauthEnv(env);
  const token = envValue(refreshToken);
  if (!token) throw new Error("Missing Gmail refresh token");
  const key = encryptionKey(cfg.tokenEncryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(TOKEN_AAD, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    aad: TOKEN_AAD,
    iv: base64url(iv),
    tag: base64url(tag),
    ciphertext: base64url(ciphertext),
    keyDigest: sha256Hex(cfg.tokenEncryptionKey).slice(0, 16),
  };
}

function decryptRefreshToken(encrypted, env = process.env) {
  const cfg = oauthEnv(env);
  if (!encrypted || encrypted.alg !== "aes-256-gcm") throw new Error("Unsupported Gmail OAuth token envelope");
  const key = encryptionKey(cfg.tokenEncryptionKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromBase64url(encrypted.iv));
  decipher.setAAD(Buffer.from(encrypted.aad || TOKEN_AAD, "utf8"));
  decipher.setAuthTag(fromBase64url(encrypted.tag));
  return Buffer.concat([
    decipher.update(fromBase64url(encrypted.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

function signOAuthState(payload, env = process.env) {
  const cfg = oauthEnv(env);
  if (!cfg.stateSecret) throw new Error("Missing Gmail OAuth state secret");
  const body = base64url(JSON.stringify({ v: 1, iat: Date.now(), ...payload }));
  const sig = crypto.createHmac("sha256", cfg.stateSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyOAuthState(state, env = process.env, now = Date.now()) {
  const cfg = oauthEnv(env);
  if (!cfg.stateSecret) throw new Error("Missing Gmail OAuth state secret");
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) throw new Error("Invalid OAuth state");
  const expected = crypto.createHmac("sha256", cfg.stateSecret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid OAuth state signature");
  }
  const payload = JSON.parse(fromBase64url(body).toString("utf8"));
  if (!payload.iat || now - Number(payload.iat) > STATE_MAX_AGE_MS) throw new Error("Expired OAuth state");
  return payload;
}

function requestOrigin(request, env = process.env) {
  const configured = envValue(env.PIKIIO_PUBLIC_BASE_URL || env.PUBLIC_BASE_URL || env.VERCEL_PROJECT_PRODUCTION_URL);
  if (configured) return configured.replace(/\/$/, "");
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || request.headers.host;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "https";
  if (!host) return "";
  return `${proto}://${host}`;
}

function redirectUriForRequest(request, env = process.env) {
  const cfg = oauthEnv(env);
  if (cfg.redirectUri) return cfg.redirectUri;
  const origin = requestOrigin(request, env);
  return origin ? `${origin}/api/gmail/oauth/callback` : "";
}

function buildGmailOAuthUrl({ redirectUri, returnTo = "", connectionKey = DEFAULT_CONNECTION_KEY } = {}, env = process.env) {
  const cfg = oauthEnv(env);
  const missing = missingOAuthConfig(env, redirectUri);
  if (missing.length) throw new Error(`Missing Gmail OAuth config: ${missing.join(", ")}`);
  const scope = DEFAULT_SCOPES.join(" ");
  const state = signOAuthState({
    provider: "gmail",
    connectionKey: connectionKey || cfg.connectionKey,
    redirectUri,
    returnTo,
    scope,
  }, env);
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  if (cfg.userHint) url.searchParams.set("login_hint", cfg.userHint);
  return {
    authorizationUrl: url.toString(),
    redirectUri,
    scope: DEFAULT_SCOPES,
    stateExpiresInSeconds: Math.floor(STATE_MAX_AGE_MS / 1000),
  };
}

function supabaseHeaders(env = process.env, extra = {}) {
  const cfg = oauthEnv(env);
  if (!cfg.supabaseUrl || !cfg.serviceRoleKey) throw new Error("Missing Supabase service-role environment");
  return {
    apikey: cfg.serviceRoleKey,
    authorization: `Bearer ${cfg.serviceRoleKey}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function deadlineFetch(url, init = {}, options = {}) {
  const stage = options.stage || "Gmail OAuth request";
  const outcomeUnknown = options.outcomeUnknown === true;
  throwIfAborted(options.signal, { stage, outcomeUnknown: false });
  const scope = createAbortScope({
    signal: options.signal,
    timeoutMs: Number(options.timeoutMs || DEFAULT_OAUTH_STORE_TIMEOUT_MS),
    stage,
    outcomeUnknown,
  });
  let responseHandedOff = false;
  const normalizeTransportError = (error) => {
    if (isAbortError(error, scope.signal)) {
      return asDeadlineError(error, { signal: scope.signal, stage, outcomeUnknown });
    }
    if (outcomeUnknown) {
      return asOutcomeUnknownError(error, {
        stage,
        code: "GMAIL_OAUTH_STORE_OUTCOME_UNKNOWN",
      });
    }
    return error;
  };
  try {
    const response = await fetch(url, { ...init, signal: scope.signal });
    responseHandedOff = true;
    return new Proxy(response, {
      get(target, property) {
        if (["text", "json", "arrayBuffer", "blob", "formData"].includes(property)
            && typeof target[property] === "function") {
          return async (...args) => {
            try {
              return await target[property](...args);
            } catch (error) {
              throw normalizeTransportError(error);
            } finally {
              scope.cleanup();
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
    if (!responseHandedOff) scope.cleanup();
  }
}

async function supabaseRequest(pathname, {
  method = "GET",
  body = null,
  env = process.env,
  headers = {},
  signal = null,
  timeoutMs = DEFAULT_OAUTH_STORE_TIMEOUT_MS,
} = {}) {
  const cfg = oauthEnv(env);
  if (!cfg.supabaseUrl) throw new Error("Missing PQ_SUPABASE_URL");
  const outcomeUnknown = method !== "GET" && method !== "HEAD";
  const response = await deadlineFetch(`${cfg.supabaseUrl}${pathname}`, {
    method,
    headers: supabaseHeaders(env, headers),
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  }, {
    signal,
    timeoutMs,
    stage: `Gmail OAuth store ${method} ${pathname.split("?")[0]}`,
    outcomeUnknown,
  });
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (!response.ok || !outcomeUnknown) throw error;
    throw asOutcomeUnknownError(error, {
      stage: `Gmail OAuth store ${method} response receipt`,
      code: "GMAIL_OAUTH_STORE_OUTCOME_UNKNOWN",
    });
  }
  if (!response.ok) {
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* deterministic HTTP rejection */ }
    const error = new Error(payload?.message || payload?.error || `Supabase request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!text && outcomeUnknown) {
    throw asOutcomeUnknownError(new Error("Gmail OAuth store returned an empty success receipt"), {
      stage: `Gmail OAuth store ${method} response receipt`,
      code: "GMAIL_OAUTH_STORE_OUTCOME_UNKNOWN",
    });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!outcomeUnknown) throw error;
    throw asOutcomeUnknownError(error, {
      stage: `Gmail OAuth store ${method} response receipt`,
      code: "GMAIL_OAUTH_STORE_OUTCOME_UNKNOWN",
    });
  }
}

async function supabaseSelect(table, query = {}, env = process.env, options = {}) {
  const url = new URL(`/rest/v1/${table}`, "http://local");
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return supabaseRequest(`${url.pathname}${url.search}`, { env, ...options });
}

async function exchangeGmailOAuthCode({ code, redirectUri, signal }, env = process.env, options = {}) {
  const cfg = oauthEnv(env);
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Missing Gmail OAuth client config");
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await deadlineFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, {
    signal: signal || options.signal,
    timeoutMs: options.timeoutMs,
    stage: "Gmail OAuth code exchange",
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google OAuth token exchange failed: ${response.status}`);
  }
  return payload;
}

async function fetchGmailProfile(accessToken, options = {}) {
  const response = await deadlineFetch(GMAIL_PROFILE_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    stage: "Gmail OAuth profile read",
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error?.message || `Gmail profile failed: ${response.status}`);
  return payload;
}

function publicConnection(row = {}) {
  return {
    provider: row.provider || "gmail",
    connectionKey: row.connection_key || "",
    accountEmail: row.account_email || "",
    status: row.status || "unknown",
    scopes: row.scopes || [],
    token: row.token_redacted || (row.encrypted_refresh_token ? "[encrypted:redacted]" : ""),
    connectedAt: row.connected_at || null,
    updatedAt: row.updated_at || null,
    lastTokenRefreshAt: row.last_token_refresh_at || null,
    lastTokenRefreshError: row.last_token_refresh_error || "",
    revokedAt: row.revoked_at || null,
  };
}

async function storeGmailOAuthConnection({
  tokenPayload,
  profile = {},
  connectionKey = DEFAULT_CONNECTION_KEY,
  signal = null,
}, env = process.env) {
  if (!tokenPayload?.refresh_token) {
    throw new Error("Google did not return a refresh token; restart with prompt=consent or revoke the old grant first.");
  }
  const cfg = oauthEnv(env);
  const refreshToken = envValue(tokenPayload.refresh_token);
  const now = new Date().toISOString();
  const row = {
    provider: "gmail",
    connection_key: connectionKey || cfg.connectionKey,
    account_email: profile.emailAddress || cfg.userHint || "",
    status: "connected",
    scopes: String(tokenPayload.scope || "").split(/\s+/).filter(Boolean),
    encrypted_refresh_token: encryptRefreshToken(refreshToken, env),
    token_fingerprint: sha256Hex(refreshToken),
    token_redacted: redactSecret(refreshToken),
    connected_at: now,
    updated_at: now,
    revoked_at: null,
    last_token_refresh_error: null,
    last_profile: {
      emailAddress: profile.emailAddress || "",
      messagesTotal: Number(profile.messagesTotal || 0),
      threadsTotal: Number(profile.threadsTotal || 0),
      historyId: profile.historyId || "",
    },
  };
  const result = await supabaseRequest(`/rest/v1/${GMAIL_OAUTH_TABLE}?on_conflict=provider,connection_key`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=representation" },
    body: [row],
    env,
    signal,
  });
  return publicConnection(Array.isArray(result) ? result[0] : result);
}

async function loadStoredGmailConnection({ connectionKey = DEFAULT_CONNECTION_KEY, env = process.env, signal = null } = {}) {
  const cfg = oauthEnv(env);
  if (!cfg.storeConfigured) throw new Error("Stored Gmail OAuth is not configured");
  const rows = await supabaseSelect(GMAIL_OAUTH_TABLE, {
    select: "provider,connection_key,account_email,status,scopes,encrypted_refresh_token,token_redacted,connected_at,updated_at,last_token_refresh_at,last_token_refresh_error,revoked_at,last_profile",
    provider: "eq.gmail",
    connection_key: `eq.${connectionKey || cfg.connectionKey}`,
    status: "eq.connected",
    revoked_at: "is.null",
    limit: "1",
  }, env, { signal });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadStoredGmailRefreshToken({ connectionKey = DEFAULT_CONNECTION_KEY, env = process.env, signal = null } = {}) {
  const row = await loadStoredGmailConnection({ connectionKey, env, signal });
  if (!row?.encrypted_refresh_token) throw new Error("No connected stored Gmail OAuth refresh token found");
  return {
    refreshToken: decryptRefreshToken(row.encrypted_refresh_token, env),
    connection: publicConnection(row),
    accountEmail: row.account_email || "",
  };
}

async function recordGmailOAuthRefreshResult({
  ok,
  error = "",
  connectionKey = DEFAULT_CONNECTION_KEY,
  env = process.env,
  signal = null,
} = {}) {
  const cfg = oauthEnv(env);
  if (!cfg.storeConfigured) return null;
  const now = new Date().toISOString();
  const body = {
    ...(ok ? { last_token_refresh_at: now } : {}),
    last_token_refresh_error: ok ? null : String(error || "Gmail OAuth token refresh failed").slice(0, 1000),
    updated_at: now,
  };
  return supabaseRequest(`/rest/v1/${GMAIL_OAUTH_TABLE}?provider=eq.gmail&connection_key=eq.${encodeURIComponent(connectionKey || cfg.connectionKey)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body,
    env,
    signal,
  }).catch((requestError) => {
    if (isAbortError(requestError, signal)) throw requestError;
    return null;
  });
}

async function loadGmailOAuthStatus(env = process.env) {
  const cfg = oauthEnv(env);
  const status = {
    configured: cfg.oauthConfigured,
    storeConfigured: cfg.storeConfigured,
    connectionKey: cfg.connectionKey,
    missing: missingOAuthConfig(env, cfg.redirectUri || "request-derived").filter((item) => item !== "GMAIL_OAUTH_REDIRECT_URI or request host"),
    connection: null,
    error: "",
  };
  if (!cfg.storeConfigured) return status;
  try {
    const row = await loadStoredGmailConnection({ connectionKey: cfg.connectionKey, env });
    status.connection = row ? publicConnection(row) : null;
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
  return status;
}

function ageMinutes(timestamp, now = new Date()) {
  const parsed = Date.parse(timestamp || "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 60000));
}

async function loadSnapshot(snapshotKey, fallback = {}, env = process.env) {
  const rows = await supabaseSelect("app_snapshots", {
    select: "payload,updated_at",
    snapshot_key: `eq.${snapshotKey}`,
    limit: "1",
  }, env);
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    payload: row?.payload || fallback,
    updatedAt: row?.updated_at || null,
  };
}

async function loadGmailFreshness(env = process.env, now = new Date()) {
  const staleAfterMinutes = Math.max(1, Number(env.PQ_GMAIL_STATUS_STALE_MINUTES || DEFAULT_STALE_MINUTES) || DEFAULT_STALE_MINUTES);
  const result = {
    ok: false,
    staleAfterMinutes,
    state: null,
    proof: null,
    error: "",
  };
  try {
    const [state, proof] = await Promise.all([
      loadSnapshot("gmail-direct-state", {}, env),
      loadSnapshot("gmail-proof-snapshot", { proofs: [] }, env),
    ]);
    const stateTime = state.payload?.snapshotTime || state.updatedAt;
    const proofTime = proof.payload?.snapshotTime || proof.updatedAt;
    const stateAgeMinutes = ageMinutes(stateTime, now);
    const proofAgeMinutes = ageMinutes(proofTime, now);
    result.ok = true;
    result.state = {
      snapshotTime: stateTime || null,
      updatedAt: state.updatedAt,
      ageMinutes: stateAgeMinutes,
      stale: stateAgeMinutes === null ? true : stateAgeMinutes > staleAfterMinutes,
      writerVersion: state.payload?.writerVersion || "",
      changed: Boolean(state.payload?.changed),
      updatedAwbCount: Array.isArray(state.payload?.updatedAwbs) ? state.payload.updatedAwbs.length : 0,
      readThreadCount: Array.isArray(state.payload?.readThreadIds) ? state.payload.readThreadIds.length : 0,
      queryCount: Array.isArray(state.payload?.searchedQueries) ? state.payload.searchedQueries.length : Number(state.payload?.queryCount || 0),
      lastError: state.payload?.lastRunError || state.payload?.error || "",
    };
    result.proof = {
      snapshotTime: proofTime || null,
      updatedAt: proof.updatedAt,
      ageMinutes: proofAgeMinutes,
      stale: proofAgeMinutes === null ? true : proofAgeMinutes > staleAfterMinutes,
      writerVersion: proof.payload?.writerVersion || "",
      proofCount: Array.isArray(proof.payload?.proofs) ? proof.payload.proofs.length : 0,
    };
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function itemMatchesAwb(item, awb) {
  const normalized = normalizeAwb(awb);
  if (!normalized) return false;
  const direct = normalizeAwb(item?.awb || item?.shipmentAwb || item?.waybill || "");
  if (direct && direct === normalized) return true;
  const awbs = [
    ...(Array.isArray(item?.awbs) ? item.awbs : []),
    ...(Array.isArray(item?.shipmentAwbs) ? item.shipmentAwbs : []),
    ...(Array.isArray(item?.payload?.appliesToAwbs) ? item.payload.appliesToAwbs : []),
  ];
  return awbs.some((value) => normalizeAwb(value) === normalized);
}

function cap(items, limit = 50) {
  return (items || []).slice(0, limit);
}

async function loadGmailEvidencePacket(awb, env = process.env, now = new Date()) {
  const normalized = normalizeAwb(awb);
  if (!normalized) throw new Error("A valid AWB is required");
  const dashed = formatAwb(normalized);
  const [freshness, proofSnapshot, eventsSnapshot, stateSnapshot, factSnapshot] = await Promise.all([
    loadGmailFreshness(env, now).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
    loadSnapshot("gmail-proof-snapshot", { proofs: [] }, env).catch(() => ({ payload: { proofs: [] }, updatedAt: null })),
    loadSnapshot("shipment-events", { events: [] }, env).catch(() => ({ payload: { events: [] }, updatedAt: null })),
    loadSnapshot("shipment-state", { shipments: [] }, env).catch(() => ({ payload: { shipments: [] }, updatedAt: null })),
    loadSnapshot("operational-fact-ledger", { facts: [], evidenceDocuments: [], workgroups: [] }, env).catch(() => ({ payload: { facts: [], evidenceDocuments: [], workgroups: [] }, updatedAt: null })),
  ]);

  const opsRows = await Promise.all([
    supabaseSelect("ops_shipments", {
      select: "awb,shipment_id,ops_phase,ops_label,next_action,current_payload,snapshot_time,updated_at",
      or: `(awb.eq.${normalized},awb.eq.${dashed})`,
      limit: "2",
    }, env).catch(() => []),
    supabaseSelect("ops_facts", {
      select: "fact_id,awb,fact_type,gate,polarity,confidence,confidence_label,summary,evidence_text,source_type,thread_id,message_id,attachment_id,occurred_at,observed_at,payload",
      or: `(awb.eq.${normalized},awb.eq.${dashed})`,
      order: "observed_at.desc",
      limit: "50",
    }, env).catch(() => []),
    supabaseSelect("ops_evidence_documents", {
      select: "evidence_id,source_type,source_id,awb,thread_id,message_id,attachment_id,filename,mime_type,text_preview,observed_at,payload",
      or: `(awb.eq.${normalized},awb.eq.${dashed})`,
      order: "observed_at.desc",
      limit: "50",
    }, env).catch(() => []),
  ]);

  const proof = (proofSnapshot.payload?.proofs || []).find((item) => itemMatchesAwb(item, normalized)) || null;
  const events = (eventsSnapshot.payload?.events || []).filter((item) => itemMatchesAwb(item, normalized));
  const shipmentStates = (stateSnapshot.payload?.shipments || []).filter((item) => itemMatchesAwb(item, normalized));
  const ledgerFacts = (factSnapshot.payload?.facts || []).filter((item) => itemMatchesAwb(item, normalized));
  const ledgerDocuments = (factSnapshot.payload?.evidenceDocuments || []).filter((item) => itemMatchesAwb(item, normalized));
  return {
    shipmentId: opsRows[0]?.[0]?.shipment_id || shipmentStates[0]?.shipmentId || "",
    awbs: [dashed],
    compiledAt: now.toISOString(),
    freshness,
    sourceFacts: cap([...(opsRows[1] || []), ...ledgerFacts], 80),
    threads: cap(proof?.gmailSearchAudit || proof?.emailValidation?.threads || [], 40),
    attachments: cap([...(opsRows[2] || []), ...(proof?.gmailAttachmentAudit || []), ...ledgerDocuments], 80),
    gmailProof: proof,
    shipmentEvents: cap(events, 80),
    shipmentState: shipmentStates[0] || null,
    opsShipment: opsRows[0]?.[0] || null,
    unknowns: proof ? [] : ["No Gmail proof snapshot row matched this AWB."],
  };
}

module.exports = {
  DEFAULT_SCOPES,
  buildGmailOAuthUrl,
  decryptRefreshToken,
  encryptRefreshToken,
  exchangeGmailOAuthCode,
  fetchGmailProfile,
  gmailOAuthConfigured,
  gmailOAuthStoreConfigured,
  loadGmailEvidencePacket,
  loadGmailFreshness,
  loadGmailOAuthStatus,
  loadStoredGmailConnection,
  loadStoredGmailRefreshToken,
  missingOAuthConfig,
  oauthEnv,
  recordGmailOAuthRefreshResult,
  redactSecret,
  redirectUriForRequest,
  requestOrigin,
  sha256Hex,
  signOAuthState,
  storeGmailOAuthConnection,
  verifyOAuthState,
  _test: Object.freeze({ deadlineFetch, supabaseRequest }),
};

"use strict";

const { createClient: defaultCreateClient } = require("@supabase/supabase-js");
const { createTruthRawObjectStore } = require("./truth-raw-object-store");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  createAbortScope,
  isAbortError,
  throwIfAborted,
} = require("./runtime-deadline");

const TRUTH_EVIDENCE_BUCKET = "pikiio-truth-evidence-v1";
const DEFAULT_STORAGE_TIMEOUT_MS = 20_000;

class TruthRawObjectStoreFactoryError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "TruthRawObjectStoreFactoryError";
    this.code = fields.code || "TRUTH_RAW_OBJECT_STORE_FACTORY_FAILED";
    this.field = fields.field || "";
  }
}

function invalid(field, reason) {
  return new TruthRawObjectStoreFactoryError(`Invalid raw-object runtime ${field}: ${reason}`, {
    code: "TRUTH_RAW_OBJECT_STORE_FACTORY_INVALID_ARGUMENT",
    field,
  });
}

function string(value, field, options = {}) {
  if (typeof value !== "string" || (!options.allowEmpty && !value) || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  return value;
}

function decodeJwtRole(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return "";
  try {
    return String(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.role || "");
  } catch {
    return "";
  }
}

function requireServerSecret(value) {
  const secret = string(value, "serviceRoleKey");
  const role = decodeJwtRole(secret);
  if (/^sb_publishable_/i.test(secret) || role === "anon" || role === "authenticated") {
    throw invalid("serviceRoleKey", "must be a server-only secret/service-role key, never a publishable or user key");
  }
  if (!/^sb_secret_/i.test(secret) && role !== "service_role") {
    throw invalid("serviceRoleKey", "must prove the service_role JWT role or use a Supabase sb_secret key");
  }
  return secret;
}

function normalizeOrigin(value) {
  const raw = string(value, "supabaseUrl");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("supabaseUrl", "must be an absolute URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:")
      || (local && !["http:", "https:"].includes(url.protocol))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalid("supabaseUrl", "must be a credential-free HTTPS origin (HTTP is allowed only for loopback development)");
  }
  return url.origin;
}

function storageTimeoutMs(value) {
  const timeoutMs = Number(value ?? DEFAULT_STORAGE_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) {
    throw invalid("timeoutMs", "must be an integer from 250 through 120000");
  }
  return timeoutMs;
}

function createDeadlineFetch(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw invalid("fetchImpl", "must be a function");
  const signal = options.signal || null;
  const deadlineAtMs = options.deadlineAtMs ?? null;
  const timeoutMs = storageTimeoutMs(options.timeoutMs);
  return async function deadlineStorageFetch(url, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const outcomeUnknown = !["GET", "HEAD", "OPTIONS"].includes(method);
    const stage = `truth raw Storage ${method}`;
    throwIfAborted(signal, { stage, deadlineAtMs, outcomeUnknown: false });
    const scope = createAbortScope({
      signal,
      timeoutMs,
      stage,
      outcomeUnknown,
    });
    let responseHandedOff = false;
    const normalizeTransportError = (error) => {
      if (isAbortError(error, scope.signal)) {
        return asDeadlineError(error, {
          signal: scope.signal,
          stage,
          deadlineAtMs,
          outcomeUnknown,
        });
      }
      if (outcomeUnknown) {
        return asOutcomeUnknownError(error, {
          stage,
          deadlineAtMs,
          code: "TRUTH_RAW_STORAGE_OUTCOME_UNKNOWN",
        });
      }
      return error;
    };
    try {
      const response = await fetchImpl(url, { ...init, signal: scope.signal });
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
  };
}

function createServerTruthRawObjectStore(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw invalid("options", "must be an object");
  }
  const env = options.env || process.env;
  const supabaseUrl = normalizeOrigin(options.supabaseUrl ?? env.PQ_SUPABASE_URL ?? "");
  const serviceRoleKey = requireServerSecret(
    options.serviceRoleKey ?? env.PQ_SUPABASE_SERVICE_ROLE_KEY ?? "",
  );
  const configuredBucket = options.bucket ?? env.PQ_TRUTH_EVIDENCE_BUCKET ?? TRUTH_EVIDENCE_BUCKET;
  if (configuredBucket !== TRUTH_EVIDENCE_BUCKET) {
    throw invalid("bucket", `must match the migrated private bucket ${TRUTH_EVIDENCE_BUCKET}`);
  }
  const createClient = options.createClient || defaultCreateClient;
  if (typeof createClient !== "function") throw invalid("createClient", "must be a function");
  const signal = options.signal || null;
  const deadlineFetch = createDeadlineFetch({
    fetchImpl: options.fetchImpl,
    signal,
    deadlineAtMs: options.deadlineAtMs,
    timeoutMs: options.timeoutMs ?? env.PQ_TRUTH_STORAGE_TIMEOUT_MS,
  });
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-client-info": "pikiio-truth-evidence-runtime-v1" },
      fetch: deadlineFetch,
    },
  });
  if (!client || typeof client !== "object" || !client.storage) {
    throw new TruthRawObjectStoreFactoryError("Supabase server client did not expose Storage", {
      code: "TRUTH_RAW_OBJECT_STORE_FACTORY_INVALID_CLIENT",
    });
  }
  return createTruthRawObjectStore({
    storage: client.storage,
    bucket: TRUTH_EVIDENCE_BUCKET,
    signal,
    deadlineAtMs: options.deadlineAtMs,
  });
}

module.exports = {
  TRUTH_EVIDENCE_BUCKET,
  TruthRawObjectStoreFactoryError,
  createServerTruthRawObjectStore,
  _test: { createDeadlineFetch, decodeJwtRole, normalizeOrigin, requireServerSecret, storageTimeoutMs },
};

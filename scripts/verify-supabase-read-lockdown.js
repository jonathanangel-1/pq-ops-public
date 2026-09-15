#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 6000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: process.env.PQ_VERIFY_BASE_URL || "https://pq-ops-demo.example",
    timeoutMs: Number(process.env.PQ_VERIFY_LOCKDOWN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    strict: false,
  };
  for (const arg of argv) {
    if (arg === "--strict") args.strict = true;
    else if (arg.startsWith("--base-url=")) args.baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = DEFAULT_TIMEOUT_MS;
  args.baseUrl = String(args.baseUrl || "").replace(/\/+$/, "");
  return args;
}

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const local = loadDotEnvFile(path.join(ROOT_DIR, ".env.local"));
  return local[name] || "";
}

function classifyProbe(result = {}) {
  const status = Number(result.status);
  const error = String(result.error || result.body?.message || result.body?.error || "");
  if (result.timeout) return "timeout";
  if (!Number.isFinite(status) && /\b(?:fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(error)) return "network";
  if (status === 401 || status === 403) return "denied";
  if ([520, 521, 522, 523, 524].includes(status)) return "cloudflare-origin";
  if (status >= 500) return "hosted-error";
  if (status >= 200 && status < 300) return "open";
  if (status === 404) return "not-found";
  return "other";
}

async function probe(label, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { text: text.slice(0, 180) };
    }
    const result = {
      label,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      body,
    };
    return {
      ...result,
      category: classifyProbe(result),
    };
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const result = {
      label,
      status: null,
      elapsedMs: Date.now() - startedAt,
      timeout,
      error: error instanceof Error ? error.message : String(error),
    };
    return {
      ...result,
      category: classifyProbe(result),
    };
  }
}

function directSupabaseUrl(supabaseUrl, table, query = {}) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/${table}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function directHeaders(anonKey) {
  return {
    apikey: anonKey,
    authorization: `Bearer ${anonKey}`,
    accept: "application/json",
  };
}

function wrapperSummary(probeResult = {}) {
  const body = probeResult.body || {};
  return {
    status: probeResult.status,
    category: probeResult.category,
    ok: body.ok,
    source: body.source || "",
    degradedStatus: body.status || "",
    error: body.error || "",
  };
}

const UNAVAILABLE_CATEGORIES = new Set(["timeout", "network", "cloudflare-origin", "hosted-error"]);
const PROTECTED_DIRECT_CATEGORIES = new Set(["denied", "not-found"]);

function directBrowserReadStatus({ directDenied, directProtected, directOpen, directUnavailable, hasSupabaseEnv }) {
  if (!hasSupabaseEnv) return "not-configured";
  if (directDenied) return "denied";
  if (directProtected) return "protected";
  if (directOpen) return "open";
  if (directUnavailable) return "unavailable";
  return "unknown";
}

function migrationLikelyApplied({ directDenied, directProtected, directOpen, directUnavailable }) {
  if (directDenied || directProtected) return true;
  if (directOpen) return false;
  if (directUnavailable) return null;
  return null;
}

function hostedConnectivityStatus({ directUnavailable, wrappersReachable, wrappersOk }) {
  if (wrappersOk) return "ok";
  if (directUnavailable && wrappersReachable) return "database-read-timeout";
  if (directUnavailable) return "unavailable";
  if (wrappersReachable) return "degraded";
  return "unknown";
}

async function main() {
  const args = parseArgs();
  const supabaseUrl = envValue("PQ_SUPABASE_URL");
  const anonKey = envValue("PQ_SUPABASE_ANON_KEY");
  const hasSupabaseEnv = Boolean(supabaseUrl && anonKey);
  const directProbeJobs = [];

  if (hasSupabaseEnv) {
    directProbeJobs.push(probe(
      "direct-app-snapshots-select",
      directSupabaseUrl(supabaseUrl, "app_snapshots", {
        select: "snapshot_key,updated_at",
        snapshot_key: "eq.shipment-truth-packets",
        limit: "1",
      }),
      { headers: directHeaders(anonKey) },
      args.timeoutMs,
    ));
    directProbeJobs.push(probe(
      "direct-agent-job-summaries-select",
      directSupabaseUrl(supabaseUrl, "agent_job_summaries", {
        select: "id,created_at",
        limit: "1",
      }),
      { headers: directHeaders(anonKey) },
      args.timeoutMs,
    ));
    directProbeJobs.push(probe(
      "direct-app-snapshot-metadata-select",
      directSupabaseUrl(supabaseUrl, "app_snapshot_metadata", {
        select: "snapshot_key,updated_at",
        limit: "1",
      }),
      { headers: directHeaders(anonKey) },
      args.timeoutMs,
    ));
  }

  const wrapperProbeJobs = [
    probe(
      "wrapper-snapshots",
      `${args.baseUrl}/api/snapshots?keys=shipment-truth-packets&metadata=1`,
      { headers: { accept: "application/json", "cache-control": "no-cache" } },
      args.timeoutMs,
    ),
    probe(
      "wrapper-agent-jobs",
      `${args.baseUrl}/api/agent-jobs?limit=3`,
      { headers: { accept: "application/json", "cache-control": "no-cache" } },
      args.timeoutMs,
    ),
  ];
  const [directProbes, wrapperProbes] = await Promise.all([
    Promise.all(directProbeJobs),
    Promise.all(wrapperProbeJobs),
  ]);

  const directDenied = directProbes.length > 0 && directProbes.every((item) => item.category === "denied");
  const directProtected = directProbes.length > 0 && directProbes.every((item) => PROTECTED_DIRECT_CATEGORIES.has(item.category));
  const directOpen = directProbes.some((item) => item.category === "open");
  const directUnavailable = directProbes.some((item) => UNAVAILABLE_CATEGORIES.has(item.category));
  const wrappersReachable = wrapperProbes.every((item) => item.status === 200);
  const wrappersOk = wrapperProbes.every((item) => item.body?.ok === true);
  const pending = !directProtected || !wrappersOk;
  const directBrowserReads = directBrowserReadStatus({
    directDenied,
    directProtected,
    directOpen,
    directUnavailable,
    hasSupabaseEnv,
  });
  const migrationStatus = migrationLikelyApplied({
    directDenied,
    directProtected,
    directOpen,
    directUnavailable,
  });
  const hostedConnectivity = hostedConnectivityStatus({
    directUnavailable,
    wrappersReachable,
    wrappersOk,
  });

  const result = {
    ok: directProtected && wrappersReachable && (wrappersOk || directUnavailable),
    strictOk: directProtected && wrappersOk,
    strict: args.strict,
    checkedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    hasSupabaseEnv,
    summary: {
      directBrowserReads,
      hostedWrappers: wrappersOk ? "ok" : wrappersReachable ? "degraded" : "unreachable",
      migrationLikelyApplied: migrationStatus,
      migrationStatus: migrationStatus === null ? "unknown" : migrationStatus ? "likely-applied" : "likely-missing",
      hostedConnectivity,
      pending,
    },
    directProbes: directProbes.map((item) => ({
      label: item.label,
      status: item.status,
      elapsedMs: item.elapsedMs,
      category: item.category,
      rowCount: Array.isArray(item.body) ? item.body.length : undefined,
      error: item.error || item.body?.message || item.body?.error || "",
    })),
    wrapperProbes: wrapperProbes.map((item) => ({
      label: item.label,
      elapsedMs: item.elapsedMs,
      ...wrapperSummary(item),
    })),
  };

  console.log(JSON.stringify(result, null, 2));
  if (args.strict && !result.strictOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

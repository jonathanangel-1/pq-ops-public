#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "production-truth-readiness");
const ARTIFACT_PATH = path.join(ARTIFACT_DIR, "latest.json");
const DEFAULT_BASE_URL = process.env.PQ_VERIFY_BASE_URL || "https://pq-ops-demo.example";
const DEFAULT_TIMEOUT_MS = 10000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: Number(process.env.PQ_VERIFY_TRUTH_READINESS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    reportOnly: false,
    skipBeta: false,
    skipHosted: false,
    liveGmailOverlayAwbs: [],
    liveGmailOverlayToken: process.env.PQ_VERIFY_CRON_SECRET || process.env.CRON_SECRET || "",
  };
  for (const arg of argv) {
    if (arg === "--report-only") args.reportOnly = true;
    else if (arg === "--skip-beta") args.skipBeta = true;
    else if (arg === "--skip-hosted") args.skipHosted = true;
    else if (arg.startsWith("--base-url=")) args.baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg.startsWith("--live-gmail-overlay-awbs=")) {
      args.liveGmailOverlayAwbs = arg
        .slice("--live-gmail-overlay-awbs=".length)
        .split(/[,\s]+/)
        .map((awb) => awb.replace(/\D/g, ""))
        .filter(Boolean);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = DEFAULT_TIMEOUT_MS;
  args.baseUrl = String(args.baseUrl || "").replace(/\/+$/, "");
  return args;
}

function truncate(value = "", maxLength = 2400) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function runCommand(check) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(check.command, check.args || [], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        ...check,
        ok: false,
        exitCode: null,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    });
    child.on("close", (code) => {
      resolve({
        ...check,
        ok: code === 0,
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    });
  });
}

function parseLastJsonObject(text = "") {
  const source = String(text || "");
  for (let index = source.lastIndexOf("{"); index >= 0; index = source.lastIndexOf("{", index - 1)) {
    const candidate = source.slice(index).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function summarizeCommandResult(check = {}) {
  const parsed = parseLastJsonObject(check.stdout || "");
  if (!parsed || typeof parsed !== "object") return {};
  if (check.id === "local-snapshot-metadata-sidecar") {
    return {
      ok: parsed.ok,
      migration: parsed.migration || "",
      checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    };
  }
  if (check.id === "hosted-supabase-read-lockdown") {
    return {
      ok: parsed.ok,
      strictOk: parsed.strictOk,
      directBrowserReads: parsed.summary?.directBrowserReads || "",
      hostedWrappers: parsed.summary?.hostedWrappers || "",
      migrationLikelyApplied: parsed.summary?.migrationLikelyApplied,
      migrationStatus: parsed.summary?.migrationStatus || "",
      hostedConnectivity: parsed.summary?.hostedConnectivity || "",
      pending: parsed.summary?.pending,
      directProbes: Array.isArray(parsed.directProbes)
        ? parsed.directProbes.map((probe) => ({
            label: probe.label,
            status: probe.status,
            category: probe.category,
            elapsedMs: probe.elapsedMs,
            error: probe.error || "",
          }))
        : [],
      wrapperProbes: Array.isArray(parsed.wrapperProbes)
        ? parsed.wrapperProbes.map((probe) => ({
            label: probe.label,
            status: probe.status,
            category: probe.category,
            ok: probe.ok,
            degradedStatus: probe.degradedStatus || "",
            error: probe.error || "",
          }))
        : [],
    };
  }
  return {
    ok: parsed.ok,
    status: parsed.status || "",
    summary: parsed.summary || undefined,
  };
}

async function httpProbe(label, url, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { text: truncate(text, 600) };
    }
    return {
      id: label,
      kind: "http",
      url,
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      body,
    };
  } catch (error) {
    return {
      id: label,
      kind: "http",
      url,
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function authorizedHttpProbe(label, url, timeoutMs, token) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { text: truncate(text, 600) };
    }
    return {
      id: label,
      kind: "http",
      url,
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      body,
    };
  } catch (error) {
    return {
      id: label,
      kind: "http",
      url,
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function shipmentRows(body = {}) {
  if (Array.isArray(body.shipments)) return body.shipments;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.rows)) return body.rows;
  return [];
}

function sourceGapRows(rows = []) {
  return rows.filter((row) => {
    const certification = String(row.sourceCertification?.status || "").toLowerCase();
    const phase = String(row.opsState?.phase || row.reasoning?.phase || "").toLowerCase();
    const className = String(row.reasoning?.className || "").toLowerCase();
    return certification === "source-gap" || phase === "source-gap" || className === "source-gap";
  });
}

function evaluateTruthHealth(probe = {}) {
  const body = probe.body || {};
  const truth = body.truth || {};
  const status = String(body.status || "").toLowerCase();
  const ok = probe.ok && body.ok === true && status === "live";
  const { body: _body, ...safeProbe } = probe;
  return {
    ...safeProbe,
    ok,
    readiness: ok ? "pass" : "fail",
    summary: {
      bodyOk: body.ok,
      status: body.status || "",
      warnings: Array.isArray(body.warnings) ? body.warnings.slice(0, 8) : [],
      operatorGuidance: body.operatorGuidance || "",
      truth: {
        source: truth.source || "",
        snapshotTime: truth.snapshotTime || "",
        ageMinutes: truth.ageMinutes,
        stale: truth.stale,
        activeAwbCount: truth.activeAwbCount,
      },
      hostedPersistence: {
        ok: body.hostedPersistence?.ok,
        status: body.hostedPersistence?.status || "",
        category: body.hostedPersistence?.diagnostic?.category || "",
      },
      rowCertification: truth.rowCertification || body.rowCertification || body.sourceHealth?.rowCertification || null,
    },
  };
}

function evaluateShipmentProjection(probe = {}) {
  const body = probe.body || {};
  const rows = shipmentRows(body);
  const gaps = sourceGapRows(rows);
  const sourceHealth = body.sourceHealth || {};
  const ok = probe.ok &&
    body.ok === true &&
    rows.length > 0 &&
    gaps.length === 0 &&
    String(sourceHealth.status || "").toLowerCase() === "live";
  const { body: _body, ...safeProbe } = probe;
  return {
    ...safeProbe,
    ok,
    readiness: ok ? "pass" : "fail",
    summary: {
      bodyOk: body.ok,
      source: body.source || "",
      sourceHealthStatus: sourceHealth.status || "",
      snapshotTime: body.snapshotTime || "",
      shipmentCount: rows.length,
      sourceGapCount: gaps.length,
      sourceGapAwbs: gaps.map((row) => row.awb || row.id || "").filter(Boolean).slice(0, 20),
      warnings: [
        ...(Array.isArray(body.sourceTruthWarnings) ? body.sourceTruthWarnings : []),
        ...(Array.isArray(sourceHealth.warnings) ? sourceHealth.warnings : []),
      ].filter(Boolean).slice(0, 8),
    },
  };
}

function evaluateLiveGmailOverlayAuthorization(probe = {}) {
  const body = probe.body || {};
  const ok = probe.status === 401 &&
    body &&
    body.ok === false &&
    String(body.error || "").toLowerCase() === "unauthorized";
  const { body: _body, ...safeProbe } = probe;
  return {
    ...safeProbe,
    ok,
    readiness: ok ? "pass" : "fail",
    summary: {
      status: probe.status,
      bodyOk: body.ok,
      error: body.error || "",
      expected: "Unauthenticated live Gmail overlay requests must return 401 Unauthorized.",
    },
  };
}

function evaluatePublicLiveGmailFallbackQuarantine(probe = {}) {
  const body = probe.body || {};
  const source = String(body.source || "");
  const ok = probe.ok &&
    body.ok === true &&
    body.liveGmailOverlay !== true &&
    body.publicLiveGmailFallback !== true &&
    body.persisted !== false &&
    !/public-live-gmail-fallback/i.test(source);
  const { body: _body, ...safeProbe } = probe;
  return {
    ...safeProbe,
    ok,
    readiness: ok ? "pass" : "fail",
    summary: {
      status: probe.status,
      bodyOk: body.ok,
      source,
      sourceHealthStatus: body.sourceHealth?.status || "",
      liveGmailOverlay: body.liveGmailOverlay,
      publicLiveGmailFallback: body.publicLiveGmailFallback,
      persisted: body.persisted,
      shipmentCount: shipmentRows(body).length,
      expected: "Public liveGmailFallback requests must be ignored/quarantined and must not run live Gmail overlay truth.",
      error: body.error || "",
    },
  };
}

function evaluateAuthorizedLiveGmailOverlay(probe = {}) {
  const body = probe.body || {};
  const rows = shipmentRows(body);
  const ok = probe.ok &&
    body.ok === true &&
    body.liveGmailOverlay === true &&
    body.persisted === false &&
    String(body.projectionScope || "") === "requested-awbs" &&
    rows.length > 0;
  const { body: _body, ...safeProbe } = probe;
  return {
    ...safeProbe,
    required: false,
    ok,
    readiness: ok ? "pass" : "diagnostic-fail",
    summary: {
      bodyOk: body.ok,
      source: body.source || "",
      projectionScope: body.projectionScope || "",
      liveGmailOverlay: body.liveGmailOverlay,
      persisted: body.persisted,
      requestedAwbCount: body.requestedAwbCount,
      shipmentCount: rows.length,
      sourceHealthStatus: body.sourceHealth?.status || "",
      direct: {
        ok: body.direct?.ok,
        updated: body.direct?.updated,
        threadCount: body.direct?.threadCount,
        queryCount: body.direct?.queryCount,
        gmailCoverageStatus: body.direct?.gmailCoverageStatus || "",
        gmailCoverageProblemCount: body.direct?.gmailCoverageProblemCount,
      },
      awbs: rows.map((row) => row.awb || row.id || "").filter(Boolean).slice(0, 20),
      error: body.error || "",
    },
  };
}

function requiredCommands(args) {
  const commands = [{
    id: "local-snapshot-metadata-sidecar",
    kind: "command",
    required: true,
    layer: "local-hosted-persistence-contract",
    command: "npm",
    args: ["run", "verify:snapshot-metadata-sidecar"],
  }];
  if (!args.skipBeta) {
    commands.push({
      id: "local-beta-truth-suite",
      kind: "command",
      required: true,
      layer: "local-regression-suite",
      command: "npm",
      args: ["run", "verify:beta"],
    });
  } else {
    commands.push({
      id: "local-gmail-direct-boundary",
      kind: "command",
      required: true,
      layer: "local-gmail-ingestion-boundary",
      command: "npm",
      args: ["run", "verify:gmail-direct"],
    });
  }
  if (!args.skipHosted) {
    commands.push({
      id: "hosted-supabase-read-lockdown",
      kind: "command",
      required: true,
      layer: "hosted-persistence-authorization",
      command: "npm",
      args: [
        "run",
        "verify:supabase-lockdown",
        "--",
        "--strict",
        `--base-url=${args.baseUrl}`,
        `--timeout-ms=${args.timeoutMs}`,
      ],
    });
  }
  return commands;
}

function skippedChecks(args) {
  const checks = [];
  if (args.skipBeta) {
    checks.push({
      id: "local-beta-truth-suite",
      kind: "command",
      required: false,
      layer: "local-regression-suite",
      ok: false,
      readiness: "skipped",
      skipped: true,
      summary: {
        reason: "--skip-beta was provided; this run is diagnostic and cannot prove final production truth readiness.",
      },
    });
  }
  if (args.skipHosted) {
    checks.push({
      id: "hosted-production-readiness",
      kind: "http",
      required: false,
      layer: "production-runtime",
      ok: false,
      readiness: "skipped",
      skipped: true,
      summary: {
        reason: "--skip-hosted was provided; this run is local-only and cannot prove final production truth readiness.",
      },
    });
  }
  return checks;
}

async function main() {
  const args = parseArgs();
  const startedAt = new Date();
  const commandChecks = [];
  for (const check of requiredCommands(args)) {
    const result = await runCommand(check);
    commandChecks.push({
      ...result,
      summary: summarizeCommandResult(result),
    });
  }

  const hostedChecks = [];
  if (!args.skipHosted) {
    const liveGmailOverlayAuth = await httpProbe(
      "production-live-gmail-overlay-auth",
      `${args.baseUrl}/api/brain/shipments?liveGmail=1&awbs=114-80000243&ts=${Date.now()}`,
      args.timeoutMs,
    );
    hostedChecks.push(evaluateLiveGmailOverlayAuthorization(liveGmailOverlayAuth));

    const publicFallbackQuarantine = await httpProbe(
      "production-public-live-gmail-fallback-quarantine",
      `${args.baseUrl}/api/brain/shipments?liveGmailFallback=1&ts=${Date.now()}`,
      args.timeoutMs,
    );
    hostedChecks.push(evaluatePublicLiveGmailFallbackQuarantine(publicFallbackQuarantine));

    if (args.liveGmailOverlayAwbs.length) {
      if (args.liveGmailOverlayToken) {
        const authorizedOverlay = await authorizedHttpProbe(
          "production-live-gmail-overlay-readonly",
          `${args.baseUrl}/api/brain/shipments?liveGmail=1&awbs=${encodeURIComponent(args.liveGmailOverlayAwbs.join(","))}&lookbackDays=14&maxThreads=120&maxAttachmentPdfs=1&ts=${Date.now()}`,
          Math.max(args.timeoutMs, 60000),
          args.liveGmailOverlayToken,
        );
        hostedChecks.push(evaluateAuthorizedLiveGmailOverlay(authorizedOverlay));
      } else {
        hostedChecks.push({
          id: "production-live-gmail-overlay-readonly",
          kind: "http",
          required: false,
          ok: false,
          readiness: "skipped",
          status: null,
          summary: {
            requestedAwbs: args.liveGmailOverlayAwbs,
            reason: "Set PQ_VERIFY_CRON_SECRET or CRON_SECRET to run the authenticated read-only live Gmail overlay probe.",
          },
        });
      }
    }

    const truthHealth = await httpProbe(
      "production-truth-health",
      `${args.baseUrl}/api/truth/health?diagnostic=1&diagnosticTimeoutMs=${args.timeoutMs}&ts=${Date.now()}`,
      args.timeoutMs + 1000,
    );
    hostedChecks.push(evaluateTruthHealth(truthHealth));

    const shipments = await httpProbe(
      "production-shipment-projection",
      `${args.baseUrl}/api/brain/shipments?ts=${Date.now()}`,
      args.timeoutMs,
    );
    hostedChecks.push(evaluateShipmentProjection(shipments));
  }

  const checks = [...commandChecks, ...skippedChecks(args), ...hostedChecks];
  const failures = checks.filter((check) => check.required !== false && !check.ok);
  const checksOk = failures.length === 0;
  const finalReadinessEligible = !args.reportOnly && !args.skipBeta && !args.skipHosted;
  const ready = checksOk && finalReadinessEligible;
  const artifact = {
    ok: ready,
    checksOk,
    finalReadinessEligible,
    status: ready ? "ready" : checksOk ? "diagnostic-only" : "not-ready",
    reportOnly: args.reportOnly,
    evidenceMode: {
      reportOnly: args.reportOnly,
      skipBeta: args.skipBeta,
      skipHosted: args.skipHosted,
      liveGmailOverlayAwbCount: args.liveGmailOverlayAwbs.length,
      finalReadinessEligible,
    },
    checkedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    baseUrl: args.baseUrl,
    mutatesState: false,
    source: "production-truth-readiness-v1",
    definitionOfDone: [
      "Local snapshot metadata sidecar migration contract passes.",
      "Local YLYI/truth/action/UI regression suite passes.",
      "Public shipment reads cannot trigger a live Gmail fallback; the live Gmail overlay is authorized, explicit, and non-persisted.",
      "Hosted Supabase direct browser reads are denied/unexposed and server wrappers answer through the sync-token path.",
      "Admin live Gmail overlay is denied without authorization and cannot become public persisted truth.",
      "Public liveGmailFallback requests are quarantined and cannot run a second live Gmail truth path.",
      "Optional authenticated live Gmail overlay probe is read-only and labeled non-persisted when explicitly requested.",
      "Production truth health is live, not degraded or emergency bundled.",
      "Production shipment projection has active rows and no source-gap certifications.",
    ],
    blockers: failures.map((check) => ({
      id: check.id,
      layer: check.layer || check.kind || "",
      status: check.status ?? check.exitCode ?? null,
      summary: check.summary || summarizeCommandResult(check),
      error: check.error || check.stderr || "",
    })),
    checks,
  };

  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
  if (!artifact.ok && !args.reportOnly) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    status: "error",
    source: "production-truth-readiness-v1",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createTruthAuditLedger } = require("../lib/truth-audit-ledger");

const ROOT_DIR = path.resolve(__dirname, "..");

async function loadDotEnvLocal(env = process.env) {
  for (const fileName of [".env.local", ".env"]) {
    try {
      const content = await fs.readFile(path.join(ROOT_DIR, fileName), "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!match || env[match[1]]) continue;
        env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function healthExitCode(value) {
  const status = value && typeof value === "object" ? value : null;
  const health = String(status ? status.health : value || "");
  const lanes = status?.lanes && typeof status.lanes === "object"
    ? Object.values(status.lanes)
    : [];
  const unhealthy = new Set(["regressions", "degraded", "failed", "stale", "never_run"]);
  if (status?.stale === true || unhealthy.has(health)
      || lanes.some((lane) => lane?.stale === true || unhealthy.has(String(lane?.health || "")))) return 2;
  return 0;
}

async function readTruthAuditStatus(options = {}) {
  const env = options.env || process.env;
  const createLedger = options.createLedger || createTruthAuditLedger;
  const findingLimit = Number(options.findingLimit ?? env.PQ_TRUTH_AUDIT_STATUS_LIMIT ?? 50);
  const ledger = createLedger({
    workspaceKey: env.PQ_TRUTH_AUDIT_WORKSPACE || "primary",
    auditToken: env.PQ_TRUTH_AUDIT_TOKEN,
    supabaseUrl: env.PQ_SUPABASE_URL,
    apiKey: env.PQ_SUPABASE_ANON_KEY,
  });
  return ledger.readStatus({ findingLimit });
}

async function main() {
  await loadDotEnvLocal();
  const result = await readTruthAuditStatus();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = healthExitCode(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      status: "failed",
      code: error?.code || "TRUTH_AUDIT_STATUS_READ_FAILED",
      error: error instanceof Error ? error.message : String(error),
      mutatesOperationalState: false,
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  healthExitCode,
  loadDotEnvLocal,
  readTruthAuditStatus,
});

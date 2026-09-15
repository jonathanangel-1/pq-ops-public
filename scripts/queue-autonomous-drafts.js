#!/usr/bin/env node
"use strict";

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  applyAutonomousDraftResults,
  autonomousDedupeKey,
  autonomousDraftRequest,
  selectAutonomousDraftActions,
} = require("../lib/autonomous-drafts");
const { queueAgentJob } = require("../lib/supabase-agent");

const ROOT_DIR = path.resolve(__dirname, "..");

function loadDotEnvLocal() {
  for (const fileName of [".env.local", ".env"]) {
    const envPath = path.join(ROOT_DIR, fileName);
    if (!fsSync.existsSync(envPath)) continue;
    const content = fsSync.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(fileName, value) {
  await fs.writeFile(path.join(ROOT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

function runNodeScript(scriptPath, args = [], timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd: ROOT_DIR, timeout, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let payload = null;
        try {
          payload = JSON.parse(stdout || "{}");
        } catch {
          payload = null;
        }
        if (error) {
          reject(new Error(payload?.error || payload?.reason || stderr || error.message));
          return;
        }
        resolve(payload || { ok: true });
      },
    );
  });
}

async function main() {
  loadDotEnvLocal();
  const dryRun = process.argv.includes("--dry-run");
  const [actionQueue, outbox] = await Promise.all([
    readJson("action-queue.json", { actions: [] }),
    readJson("outbox-requests.json", {
      sourceOfTruth:
        "Dashboard-created outbox requests are draft intents. The agent/Gmail transport must create drafts and mark them ready for human approval.",
      requests: [],
    }),
  ]);

  const candidates = selectAutonomousDraftActions(actionQueue.actions || [], outbox.requests || []);
  const now = new Date().toISOString();
  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      queued: false,
      candidates: candidates.map((action) => ({
        actionId: action.id,
        awb: action.awb,
        type: action.type,
        targetName: action.targetName,
      })),
    }, null, 2));
    return;
  }

  const results = [];
  for (const action of candidates) {
    const preview = autonomousDraftRequest(action, now, null);
    const queueResult = await queueAgentJob(preview.draftPlan.jobType, preview.draftPlan.payload, {
      dedupeKey: autonomousDedupeKey(action),
      priority: action.priority === "high" ? 15 : 55,
      maxAttempts: 2,
    });
    const { draftPlan, request } = autonomousDraftRequest(action, now, queueResult.job || null);
    results.push({
      action,
      draftPlan,
      request: {
        ...request,
        agentJobId: queueResult.job?.id || null,
        duplicate: queueResult.duplicate || false,
      },
      queueResult,
    });
  }

  if (results.length) {
    const patched = applyAutonomousDraftResults(actionQueue, outbox, results, now);
    await Promise.all([
      writeJson("action-queue.json", patched.actionQueue),
      writeJson("outbox-requests.json", patched.outbox),
    ]);
    await runNodeScript("scripts/sync-supabase-snapshots.js");
  }

  console.log(JSON.stringify({
    ok: true,
    queued: results.length,
    candidates: candidates.length,
    drafts: results.map((result) => ({
      actionId: result.action.id,
      awb: result.action.awb,
      type: result.action.type,
      targetName: result.action.targetName,
      agentJobId: result.request.agentJobId,
      duplicate: result.request.duplicate || false,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});

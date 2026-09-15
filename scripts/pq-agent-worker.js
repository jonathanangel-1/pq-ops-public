#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  actionFromOutboxRequest,
  draftPayloadForAction,
  validateDraftableAction,
} = require("../lib/action-safety");
const {
  canonicalGmailIngestionPolicy,
  legacyGmailIngestionAllowed,
} = require("../lib/gmail-ingestion-authority");
const { upsertMoneyMemory } = require("../lib/money-memory-store");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOCK_PATH = path.join(ROOT_DIR, ".pq-agent-worker.lock");
const DEFAULT_POLL_MS = 15000;
const HEAVY_REFRESH_TIME_ZONE = "America/New_York";
const HEAVY_REFRESH_WINDOWS = [
  { label: "morning", startHour: 5, endHour: 7 },
  { label: "evening", startHour: 18, endHour: 20 },
];

const flags = new Set(process.argv.slice(2));
const once = flags.has("--once");
const watch = flags.has("--watch") || !once;
const workerId = `${os.hostname()}-${process.pid}`;

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const pollMs = Number(argValue("--poll-ms", process.env.PQ_AGENT_POLL_MS || DEFAULT_POLL_MS));

function localTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HEAVY_REFRESH_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    label: `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} ${HEAVY_REFRESH_TIME_ZONE}`,
  };
}

function heavyRefreshWindow(date = new Date()) {
  const local = localTimeParts(date);
  const matchedWindow = HEAVY_REFRESH_WINDOWS.find((window) => local.hour >= window.startHour && local.hour < window.endHour);
  const allowedWindows = HEAVY_REFRESH_WINDOWS.map(
    (window) => `${String(window.startHour).padStart(2, "0")}:00-${String(window.endHour).padStart(2, "0")}:00`,
  ).join(", ");
  return {
    allowed: Boolean(matchedWindow),
    window: matchedWindow?.label || "",
    localTime: local.label,
    allowedWindows,
    timeZone: HEAVY_REFRESH_TIME_ZONE,
  };
}

async function workerScriptMtimeMs() {
  const stats = await fs.stat(__filename);
  return stats.mtimeMs;
}

async function shouldRestartForUpdatedWorker(startedMtimeMs) {
  try {
    return (await workerScriptMtimeMs()) !== startedMtimeMs;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] worker self-check failed: ${error.message}`);
    return false;
  }
}

async function loadDotEnvLocal() {
  try {
    const content = await fs.readFile(path.join(ROOT_DIR, ".env.local"), "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    });
  } catch {
    // The worker can also be configured entirely through process env.
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function supabaseUrl(pathname) {
  return `${requireEnv("PQ_SUPABASE_URL")}${pathname}`;
}

function supabaseHeaders() {
  const key = requireEnv("PQ_SUPABASE_ANON_KEY");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

async function rpc(name, body) {
  const response = await fetch(supabaseUrl(`/rest/v1/rpc/${name}`), {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${text}`);
  }
  return payload;
}

function runNodeScript(scriptPath, args = [], timeout = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: ROOT_DIR,
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let json = null;
        try {
          json = JSON.parse(stdout || "{}");
        } catch {
          json = null;
        }

        if (error) {
          reject(new Error(json?.error || json?.reason || stderr || error.message));
          return;
        }

        resolve(json || { ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
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

async function markActionCompleted(actionId, result) {
  if (!actionId) return;
  const actionQueue = await readJson("action-queue.json", { actions: [] });
  const now = new Date().toISOString();
  const status = result?.drafted ? "drafted" : result?.sent ? "sent" : "queued";
  let touched = false;
  const actions = (actionQueue.actions || []).map((action) => {
    if (action.id !== actionId) return action;
    touched = true;
    return {
      ...action,
      status,
      draftedAt: status === "drafted" ? result.createdAt || now : action.draftedAt || "",
      sentAt: status === "sent" ? result.sentAt || now : action.sentAt || "",
      executionResult: result,
    };
  });

  if (!touched) return;
  await writeJson("action-queue.json", {
    ...actionQueue,
    counts: {
      ...(actionQueue.counts || {}),
      queued: actions.filter((action) => action.status === "queued").length,
      drafted: actions.filter((action) => action.status === "drafted").length,
      sent: actions.filter((action) => action.status === "sent").length,
    },
    actions,
  });
}

async function syncSnapshots() {
  return runNodeScript("scripts/sync-supabase-snapshots.js", [], 120000);
}

async function findAgentJobByDedupeKey(dedupeKey) {
  if (!dedupeKey) return null;
  const response = await fetch(
    `${supabaseUrl("/rest/v1/agent_jobs")}?select=*&dedupe_key=eq.${encodeURIComponent(dedupeKey)}&order=created_at.desc&limit=1`,
    {
      method: "GET",
      headers: supabaseHeaders(),
    },
  );
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`agent job lookup failed: ${response.status} ${text}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

const blockedBetaLiveJobTypes = new Set(["send_gmail_email"]);

async function insertAgentJob(jobType, payload, options = {}) {
  if (blockedBetaLiveJobTypes.has(jobType)) {
    throw new Error(`Beta draft mode blocks ${jobType} jobs; queue draft_gmail_email instead.`);
  }
  const response = await fetch(supabaseUrl("/rest/v1/agent_jobs"), {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      prefer: "return=representation",
    },
    body: JSON.stringify({
      job_type: jobType,
      status: "queued",
      payload,
      dedupe_key: options.dedupeKey || null,
      priority: options.priority || 50,
      max_attempts: options.maxAttempts || 3,
    }),
  });
  const text = await response.text();
  if (response.status === 409) {
    return { queued: false, duplicate: true, job: await findAgentJobByDedupeKey(options.dedupeKey) };
  }
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`agent job insert failed: ${response.status} ${text}`);
  return { queued: true, job: Array.isArray(rows) ? rows[0] : rows };
}

async function markOutboxRequestQueued(requestId, draftJobResult) {
  if (!requestId) return null;
  const outbox = await readJson("outbox-requests.json", { requests: [] });
  const now = new Date().toISOString();
  let patchedRequest = null;
  const requests = (outbox.requests || []).map((request) => {
    if (request.id !== requestId) return request;
    patchedRequest = {
      ...request,
      status: "queued",
      updatedAt: now,
      agentJobId: draftJobResult.job?.id || request.agentJobId || "",
      duplicate: draftJobResult.duplicate || false,
    };
    return patchedRequest;
  });
  if (!patchedRequest) return null;
  await writeJson("outbox-requests.json", {
    ...outbox,
    snapshotTime: now,
    requests,
  });
  return patchedRequest;
}

async function markOutboxRequestFailed(requestId, reason) {
  if (!requestId) return null;
  const outbox = await readJson("outbox-requests.json", { requests: [] });
  const now = new Date().toISOString();
  let patchedRequest = null;
  const requests = (outbox.requests || []).map((request) => {
    if (request.id !== requestId) return request;
    patchedRequest = {
      ...request,
      status: "failed",
      updatedAt: now,
      failedAt: now,
      completedAt: now,
      lastError: reason,
    };
    return patchedRequest;
  });
  if (!patchedRequest) return null;
  await writeJson("outbox-requests.json", {
    ...outbox,
    snapshotTime: now,
    requests,
  });
  return patchedRequest;
}

async function markOutboxRequestCompleted(requestId, result) {
  if (!requestId) return null;
  const outbox = await readJson("outbox-requests.json", { requests: [] });
  const now = new Date().toISOString();
  let patchedRequest = null;
  const requests = (outbox.requests || []).map((request) => {
    if (request.id !== requestId) return request;
    patchedRequest = {
      ...request,
      status: result?.sent ? "sent" : "succeeded",
      updatedAt: now,
      completedAt: result?.sentAt || now,
      sentAt: result?.sentAt || request.sentAt || "",
      executionResult: result || {},
    };
    return patchedRequest;
  });
  if (!patchedRequest) return null;
  await writeJson("outbox-requests.json", {
    ...outbox,
    snapshotTime: now,
    requests,
  });
  return patchedRequest;
}

async function handleFullRefresh() {
  const refreshWindow = heavyRefreshWindow();
  if (!refreshWindow.allowed) {
    return {
      skipped: true,
      reason: "full_refresh outside heavy refresh window",
      ...refreshWindow,
    };
  }

  const tmsAccess = await runNodeScript("scripts/tms-access.js", ["--json"], 120000);
  if (tmsAccess.title !== "Operations Log") {
    throw new Error(`CourierCloud opened the wrong page: ${tmsAccess.title || "unknown"}`);
  }
  const liveRefresh = await runNodeScript("scripts/live-refresh.js", ["all"], 20 * 60 * 1000);
  const refresh = await runNodeScript(
    "-e",
    [
      "require('./ops-sync').runOpsSync({ rootDir: __dirname }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exit(1); })",
    ],
    10 * 60 * 1000,
  );
  const supabaseSync = await syncSnapshots();
  return { tmsAccess, liveRefresh, refresh, supabaseSync };
}

async function handleEodReport(job) {
  const fullRefresh = await handleFullRefresh();
  const report = await runNodeScript("eod-report.js", [], 120000);
  const outbox = await readJson("outbox-requests.json", { requests: [] });
  const request = (outbox.requests || []).find((item) => item.id === report.emailRequestId);
  if (!request?.to) {
    const failedRequest = await markOutboxRequestFailed(
      request?.id || report.emailRequestId,
      "PQ_EOD_REPORT_EMAIL_TO is missing or report outbox request was not found",
    );
    const supabaseSync = await syncSnapshots();
    return {
      report,
      fullRefresh,
      supabaseSync,
      emailQueued: false,
      reason: "PQ_EOD_REPORT_EMAIL_TO is missing or report outbox request was not found",
      failedRequest,
    };
  }

  const action = actionFromOutboxRequest(request);
  const validationError = validateDraftableAction(action?.id || "", action);
  if (validationError) throw new Error(`EOD report draft is not queueable: ${validationError}`);
  const requestedAt = new Date().toISOString();
  const draftPlan = draftPayloadForAction(action, request.id, requestedAt);
  const draftJob = await insertAgentJob(
    draftPlan.jobType,
    {
      ...draftPlan.payload,
      source: "eod_report",
    },
    {
      dedupeKey: `draft-gmail:eod-report:${job.payload?.localDate || new Date().toISOString().slice(0, 10)}`,
      priority: 25,
      maxAttempts: 2,
    },
  );
  const queuedRequest = await markOutboxRequestQueued(request.id, draftJob);
  const supabaseSync = await syncSnapshots();
  return { report, fullRefresh, supabaseSync, emailQueued: true, draftJob, queuedRequest };
}

async function handleEmailRefresh(job) {
  if (!legacyGmailIngestionAllowed()) {
    const policy = canonicalGmailIngestionPolicy();
    return {
      quarantined: true,
      waitingFor: policy.canonicalPipeline,
      reason:
        "Legacy email_refresh jobs are no longer a production ingestion lane. Hosted Gmail OAuth direct ingestion owns shipment-truth freshness.",
      requested: job.payload || {},
    };
  }
  return {
    waitingFor: "Codex Gmail connector",
    reason:
      "The local Node worker cannot directly access the Codex Gmail connector. The scheduled Codex automation must read Gmail threads, rebuild snapshots, and run npm run supabase:sync.",
    requested: job.payload || {},
  };
}

async function handleSendGmailEmail(job) {
  return {
    waitingFor: "Codex Gmail connector",
    reason:
      "Beta draft mode is active. The Gmail processor must convert this legacy send job into a Gmail draft and complete it with a draft result.",
    betaDraftMode: {
      convertedFrom: "send_gmail_email",
    },
    requested: {
      actionId: job.payload?.actionId || "",
      awb: job.payload?.awb || "",
      to: job.payload?.to || "",
      cc: job.payload?.cc || "",
      subject: job.payload?.subject || "",
    },
  };
}

async function handleDraftGmailEmail(job) {
  return {
    waitingFor: "Codex Gmail connector",
    reason:
      "The local Node worker cannot directly access the Codex Gmail connector. The Gmail processor must create a draft from the exact queued payload and complete this job.",
    requested: {
      actionId: job.payload?.actionId || "",
      awb: job.payload?.awb || "",
      to: job.payload?.to || "",
      cc: job.payload?.cc || "",
      subject: job.payload?.subject || "",
    },
  };
}

async function handleSendTmsAgtAlert(job) {
  const payload = job.payload || {};
  const payloadPath = path.join(ROOT_DIR, `.tms-agt-alert-${job.id}.json`);
  await fs.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
  try {
    const result = await runNodeScript(
      "scripts/tms-send-agt-alert.js",
      ["--payload-file", payloadPath],
      5 * 60 * 1000,
    );
    if (!result?.sent) {
      throw new Error(result?.error || "CourierCloud AGT alert was not sent");
    }
    await markActionCompleted(payload.actionId, result);
    const completedRequest = await markOutboxRequestCompleted(payload.outboxRequestId, result);
    const supabaseSync = await syncSnapshots();
    return {
      ...result,
      completedRequest,
      supabaseSync,
    };
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => {});
  }
}

async function handleCompleteTmsPodCloseout(job) {
  const payload = job.payload || {};
  const payloadPath = path.join(ROOT_DIR, `.tms-pod-closeout-${job.id}.json`);
  await fs.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
  try {
    const result = await runNodeScript(
      "scripts/tms-complete-pod-closeout.js",
      ["--payload-file", payloadPath],
      5 * 60 * 1000,
    );
    if (!result?.completed) {
      throw new Error(result?.error || "CourierCloud POD closeout was not completed");
    }
    await markActionCompleted(payload.actionId, result);
    const completedRequest = await markOutboxRequestCompleted(payload.outboxRequestId, result);
    const supabaseSync = await syncSnapshots();
    return {
      ...result,
      completedRequest,
      supabaseSync,
    };
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => {});
  }
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function moneyValueKnown(value) {
  return Boolean(String(value || "").trim());
}

function findTmsMoneyDetail(details = [], awb) {
  const awbKey = normalizeAwb(awb);
  if (!awbKey) return null;
  return details.find((detail) => {
    const candidates = [
      detail.awb,
      detail.trackingNumber,
      detail.accountNumber,
      detail.reference,
      detail.order,
      detail.shipmentNumber,
    ].map(normalizeAwb).filter(Boolean);
    return candidates.includes(awbKey);
  }) || null;
}

async function handleMoneyRefresh(job) {
  const payload = job.payload || {};
  const requestedAwbs = [
    payload.awb,
    ...(Array.isArray(payload.awbs) ? payload.awbs : []),
  ].filter(Boolean);
  if (!requestedAwbs.length) throw new Error("money_refresh job requires at least one AWB");

  const liveRefresh = await runNodeScript("scripts/live-refresh.js", ["tms", "--skip-access-gate"], 20 * 60 * 1000);
  const tmsDetail = await readJson("tms-detail-snapshot.json", { shipments: [] });
  const moneyMemory = await readJson("money-memory.json", { records: [] });
  let nextMoneyMemory = moneyMemory;
  const saved = [];
  const missing = [];
  const blocked = [];

  for (const awb of requestedAwbs) {
    const detail = findTmsMoneyDetail(tmsDetail.shipments || [], awb);
    if (!detail) {
      const missingRecord = { awb, reason: "No matching CourierCloud detail row found" };
      missing.push(missingRecord);
      nextMoneyMemory = upsertMoneyMemory(nextMoneyMemory, {
        awb,
        source: "CourierCloud money refresh job",
        confidence: "blocked",
        status: "not-found",
        missingFields: payload.missingFields || ["customer charge", "vendor cost"],
        checkedAt: new Date().toISOString(),
        extractionError: missingRecord.reason,
        extractionAudit: {
          requestedAwb: awb,
          requestedAwbs,
          checkedSnapshot: "tms-detail-snapshot.json",
        },
        note: `${missingRecord.reason}; manual CourierCloud billing/cost review is required.`,
      });
      blocked.push(nextMoneyMemory.savedRecord);
      continue;
    }
    const customerCharge = detail.customerCharge || detail.billingTotal || "";
    const vendorCost = detail.vendorCost || detail.costTotal || "";
    if (!moneyValueKnown(customerCharge) && !moneyValueKnown(vendorCost)) {
      const missingRecord = {
        awb,
        reason: "CourierCloud detail opened, but customer charge/vendor cost were not visible to the extractor",
        moneyFieldAudit: detail.moneyFieldAudit || [],
      };
      missing.push(missingRecord);
      nextMoneyMemory = upsertMoneyMemory(nextMoneyMemory, {
        awb,
        customerCharge,
        vendorCost,
        freightQuoteOrAward: "",
        source: "CourierCloud money refresh job",
        confidence: "blocked",
        status: "not-visible",
        order: detail.order || detail.shipmentNumber || payload.order || "",
        missingFields: payload.missingFields || ["customer charge", "vendor cost"],
        checkedAt: new Date().toISOString(),
        extractionError: missingRecord.reason,
        extractionAudit: detail.moneyExtractionAudit || {
          moneyFieldAudit: detail.moneyFieldAudit || [],
          moneyTabAudit: detail.moneyTabAudit || [],
        },
        note: `${missingRecord.reason} for order ${detail.order || detail.shipmentNumber || payload.order || ""}; open Charges, Costs, and Billing manually or ask accounting to confirm.`,
      });
      blocked.push(nextMoneyMemory.savedRecord);
      continue;
    }
    nextMoneyMemory = upsertMoneyMemory(nextMoneyMemory, {
      awb,
      customerCharge,
      vendorCost,
      freightQuoteOrAward: "",
      source: "CourierCloud money refresh job",
      confidence: moneyValueKnown(customerCharge) && moneyValueKnown(vendorCost) ? "high" : "medium",
      order: detail.order || detail.shipmentNumber || payload.order || "",
      checkedAt: new Date().toISOString(),
      extractionAudit: detail.moneyExtractionAudit || null,
      note: `Extracted from CourierCloud order ${detail.order || detail.shipmentNumber || payload.order || ""}`.trim(),
    });
    saved.push(nextMoneyMemory.savedRecord);
  }

  await writeJson("money-memory.json", nextMoneyMemory);
  const refresh = await runNodeScript(
    "-e",
    [
      "require('./ops-sync').runOpsSync({ rootDir: __dirname }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exit(1); })",
    ],
    10 * 60 * 1000,
  );
  const supabaseSync = await syncSnapshots();
  return {
    moneyRefreshed: saved.length > 0,
    moneyChecked: true,
    awbs: requestedAwbs,
    saved,
    blocked,
    missing,
    liveRefresh,
    refresh,
    supabaseSync,
  };
}

async function handleTrackingRefresh(job) {
  const payload = job.payload || {};
  const requestedAwbs = [
    payload.awb,
    ...(Array.isArray(payload.awbs) ? payload.awbs : []),
  ].filter(Boolean);
  if (!requestedAwbs.length) throw new Error("tracking_refresh job requires at least one AWB");

  const liveRefresh = await runNodeScript("scripts/live-refresh.js", ["tracking", "--skip-access-gate"], 20 * 60 * 1000);
  const refresh = await runNodeScript(
    "-e",
    [
      "require('./ops-sync').runOpsSync({ rootDir: __dirname }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exit(1); })",
    ],
    10 * 60 * 1000,
  );
  const supabaseSync = await syncSnapshots();
  const attempted = [
    ...(liveRefresh?.tracking?.failures || []).map((failure) => failure.awb),
    ...(requestedAwbs || []),
  ].filter(Boolean);
  return {
    movementVerificationRan: true,
    trackingRefreshed: true,
    awbs: requestedAwbs,
    attempted: [...new Set(attempted)],
    liveRefresh,
    refresh,
    supabaseSync,
  };
}

async function handleJob(job) {
  if (job.job_type === "full_refresh") return handleFullRefresh(job);
  if (job.job_type === "eod_report") return handleEodReport(job);
  if (job.job_type === "supabase_sync") return syncSnapshots();
  if (job.job_type === "email_refresh") return handleEmailRefresh(job);
  if (job.job_type === "send_gmail_email") return handleSendGmailEmail(job);
  if (job.job_type === "draft_gmail_email") return handleDraftGmailEmail(job);
  if (job.job_type === "send_tms_agt_alert") return handleSendTmsAgtAlert(job);
  if (job.job_type === "complete_tms_pod_closeout") return handleCompleteTmsPodCloseout(job);
  if (job.job_type === "money_refresh") return handleMoneyRefresh(job);
  if (job.job_type === "tracking_refresh") return handleTrackingRefresh(job);
  throw new Error(`Unsupported job type: ${job.job_type}`);
}

async function claimJob() {
  const jobs = await rpc("claim_agent_job", {
    p_worker_id: workerId,
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
  });
  return Array.isArray(jobs) ? jobs[0] : null;
}

async function completeJob(job, result) {
  await rpc("complete_agent_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
    p_result: result || {},
  });
}

async function deferJob(job, result) {
  await rpc("defer_agent_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
    p_result: result || {},
  });
}

async function failJob(job, error) {
  await rpc("fail_agent_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
    p_error: error instanceof Error ? error.message : String(error),
    p_retry_after_seconds: 60,
  });
}

async function processOneJob() {
  const job = await claimJob();
  if (!job) return false;
  console.log(`[${new Date().toISOString()}] claimed ${job.job_type} ${job.id}`);

  try {
    const result = await handleJob(job);
    if (result?.quarantined) {
      await completeJob(job, result);
      console.log(`[${new Date().toISOString()}] quarantined ${job.id}`);
    } else if (["email_refresh", "send_gmail_email", "draft_gmail_email"].includes(job.job_type)) {
      await deferJob(job, result);
      console.log(`[${new Date().toISOString()}] waiting_external ${job.id}`);
    } else {
      await completeJob(job, result);
      console.log(`[${new Date().toISOString()}] completed ${job.id}`);
    }
  } catch (error) {
    await failJob(job, error);
    console.error(`[${new Date().toISOString()}] failed ${job.id}: ${error.message}`);
  }

  return true;
}

async function withLocalLock(fn) {
  let lockHandle = null;
  try {
    lockHandle = await fs.open(LOCK_PATH, "wx");
    await lockHandle.writeFile(JSON.stringify({ workerId, pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    let stale = false;
    try {
      const lock = JSON.parse(await fs.readFile(LOCK_PATH, "utf8"));
      if (lock?.pid) {
        try {
          process.kill(lock.pid, 0);
        } catch {
          stale = true;
        }
      }
    } catch {
      stale = true;
    }

    if (!stale) {
      throw new Error(`Another local PQ agent worker appears to be running (${LOCK_PATH}).`);
    }

    await fs.rm(LOCK_PATH, { force: true });
    lockHandle = await fs.open(LOCK_PATH, "wx");
    await lockHandle.writeFile(JSON.stringify({ workerId, pid: process.pid, startedAt: new Date().toISOString() }));
  }

  try {
    return await fn();
  } finally {
    await lockHandle?.close().catch(() => {});
    await fs.rm(LOCK_PATH, { force: true }).catch(() => {});
  }
}

async function main() {
  await loadDotEnvLocal();
  requireEnv("PQ_SUPABASE_URL");
  requireEnv("PQ_SUPABASE_ANON_KEY");
  requireEnv("PQ_SUPABASE_SYNC_TOKEN");
  const startedMtimeMs = await workerScriptMtimeMs();

  await withLocalLock(async () => {
    if (once) {
      const processed = await processOneJob();
      console.log(JSON.stringify({ ok: true, workerId, processed }, null, 2));
      return;
    }

    console.log(`[${new Date().toISOString()}] PQ agent worker started as ${workerId}`);
    while (watch) {
      if (await shouldRestartForUpdatedWorker(startedMtimeMs)) {
        console.log(`[${new Date().toISOString()}] worker script changed; exiting for launchd restart`);
        return;
      }
      const processed = await processOneJob();
      if (!processed) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

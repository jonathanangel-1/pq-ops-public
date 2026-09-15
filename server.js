const http = require("node:http");
const { execFile } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runOpsSync } = require("./ops-sync");
const {
  actionFromOutboxRequest,
  actionIntentKey,
  actionWithOperatorDraftOverrides,
  draftIntentKey,
  draftPayloadForAction,
  providedActionCanQueue,
  publicOutboxRequest,
  validateDraftableAction,
} = require("./lib/action-safety");
const { answerOpsBrainQuestion, publicBrainAnswer } = require("./lib/ops-brain-companion");
const {
  assertBetaSafeJobType,
  loadAppSnapshot,
  upsertAppSnapshot,
} = require("./lib/supabase-agent");
const {
  classifyOperatorUpdate,
  emptyCompanionMemory,
} = require("./lib/companion-memory-store");
const {
  createGmailDraft,
  gmailDirectAvailable,
} = require("./lib/gmail-direct-ingest");
const {
  handleSourceBackfillAction,
  isSourceBackfillAction,
} = require("./lib/source-backfill");
const {
  handleMoneyContextAction,
  isMoneyContextAction,
} = require("./lib/money-refresh");
const {
  handleCarrierTrackingRefreshAction,
  isCarrierTrackingRefreshAction,
} = require("./lib/carrier-tracking-refresh");
const {
  generateDeliveryOrderForAction,
  materializeDraftAttachmentsForAction,
} = require("./lib/delivery-order-action");
const { upsertStationMemory } = require("./lib/station-memory-store");
const { upsertMoneyMemory } = require("./lib/money-memory-store");
const { upsertBrokerContactMemory } = require("./lib/broker-contact-memory");
const operatorEventsApi = require("./api/operator/events");
const operatorEventActionApi = require("./api/operator/events/action");
const operatorPushConfigApi = require("./api/operator/push/config");
const operatorPushDrainApi = require("./api/operator/push/drain");
const operatorPushSubscribeApi = require("./api/operator/push/subscribe");
const gmailOAuthStartApi = require("./api/gmail/oauth/start");
const gmailOAuthCallbackApi = require("./api/gmail/oauth/callback");
const gmailStatusApi = require("./api/gmail/status");
const gmailEvidenceApi = require("./api/gmail/evidence");
const brainShipmentsApi = require("./api/brain/shipments");
const truthHealthApi = require("./api/truth/health");
const operatorBrowserEventApi = require("./api/truth/operator-browser-event");

const ROOT_DIR = __dirname;
const LOCAL_ENV_SKIP_KEYS = new Set(["VERCEL", "VERCEL_ENV", "NOW_REGION"]);
const REAL_VERCEL_RUNTIME = Boolean(process.env.VERCEL_URL || process.env.VERCEL_REGION);

for (const envFile of [".env.local", ".env"]) {
  const envPath = path.join(ROOT_DIR, envFile);
  if (!fsSync.existsSync(envPath)) continue;
  const content = fsSync.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    if (LOCAL_ENV_SKIP_KEYS.has(match[1])) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

if (!REAL_VERCEL_RUNTIME) {
  for (const key of LOCAL_ENV_SKIP_KEYS) delete process.env[key];
}

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const TIME_ZONE = "America/New_York";
const DAILY_REFRESH_HOUR = 5;
const ENABLE_LOCAL_SNAPSHOT_CRON = process.env.ENABLE_LOCAL_SNAPSHOT_CRON === "1";
const ACTION_QUEUE_PATH = path.join(ROOT_DIR, "action-queue.json");
const OUTBOX_PATH = path.join(ROOT_DIR, "outbox-requests.json");
const EMAIL_SYNC_REQUESTS_PATH = path.join(ROOT_DIR, "email-sync-requests.json");
const MONEY_SYNC_REQUESTS_PATH = path.join(ROOT_DIR, "money-sync-requests.json");
const TRACKING_SYNC_REQUESTS_PATH = path.join(ROOT_DIR, "tracking-sync-requests.json");
const STATION_MEMORY_PATH = path.join(ROOT_DIR, "station-memory.json");
const MONEY_MEMORY_PATH = path.join(ROOT_DIR, "money-memory.json");
const COMPANION_MEMORY_PATH = path.join(ROOT_DIR, "companion-memory.json");
const SYNC_SUPABASE_AFTER_REFRESH = process.env.SYNC_SUPABASE_AFTER_REFRESH !== "0";
const HOSTED_GMAIL_IMPORT_SNAPSHOTS = [
  ["gmail-proof-snapshot", "gmail-proof-snapshot.json"],
  ["shipment-events", "shipment-events.json"],
  ["shipment-state", "shipment-state.json"],
  ["operator-notifications", "operator-notifications.json"],
  ["broker-dispatch-snapshot", "broker-dispatch-snapshot.json"],
  ["customs-broker-snapshot", "customs-broker-snapshot.json"],
  ["eod-report-facts", "eod-report-facts.json"],
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

const refreshState = {
  state: "idle",
  currentStep: null,
  startedAt: null,
  finishedAt: null,
  lastRun: null,
  lastError: null,
  nextRun: null,
  log: [],
};

function nowInTimeZone() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
  );
}

function nextDailyRefresh() {
  const localNow = nowInTimeZone();
  const targetLocal = new Date(localNow);
  targetLocal.setHours(DAILY_REFRESH_HOUR, 0, 0, 0);
  if (targetLocal <= localNow) targetLocal.setDate(targetLocal.getDate() + 1);
  return new Date(Date.now() + (targetLocal.getTime() - localNow.getTime()));
}

function scheduleNextRun() {
  const nextRun = nextDailyRefresh();
  refreshState.nextRun = nextRun.toISOString();
  const delay = Math.max(1000, nextRun.getTime() - Date.now());
  setTimeout(async () => {
    await startRefresh("cron");
    scheduleNextRun();
  }, delay);
}

function runJsonScript(scriptPath, args = [], timeout = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: ROOT_DIR,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let payload = null;
        try {
          payload = JSON.parse(stdout || "{}");
        } catch {
          payload = null;
        }

        if (error || !payload?.ok) {
          reject(new Error(payload?.reason || payload?.error || stderr || error?.message || `${scriptPath} failed`));
          return;
        }

        resolve(payload);
      },
    );
  });
}

function supabaseReady() {
  return Boolean(process.env.PQ_SUPABASE_URL && (process.env.PQ_SUPABASE_SERVICE_ROLE_KEY || process.env.PQ_SUPABASE_ANON_KEY));
}

async function queueSupabaseAgentJob(jobType, payload, options = {}) {
  assertBetaSafeJobType(jobType);
  if (!supabaseReady()) return null;
  const serviceRoleKey = process.env.PQ_SUPABASE_SERVICE_ROLE_KEY || "";
  const supabaseKey = serviceRoleKey || process.env.PQ_SUPABASE_ANON_KEY;

  if (process.env.PQ_SUPABASE_SYNC_TOKEN) {
    const response = await fetch(`${process.env.PQ_SUPABASE_URL}/rest/v1/rpc/queue_agent_job`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_sync_token: process.env.PQ_SUPABASE_SYNC_TOKEN,
        p_job_type: jobType,
        p_payload: payload || {},
        p_dedupe_key: options.dedupeKey || null,
        p_priority: options.priority || 50,
        p_max_attempts: options.maxAttempts || 3,
      }),
    });
    const text = await response.text();
    const result = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(result?.message || result?.error || `Agent queue failed: ${response.status}`);
    return {
      queued: Boolean(result?.id),
      duplicate: Boolean(options.dedupeKey && result?.dedupe_key === options.dedupeKey && result?.created_at !== result?.updated_at),
      job: result,
    };
  }

  const response = await fetch(`${process.env.PQ_SUPABASE_URL}/rest/v1/agent_jobs`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      "content-type": "application/json",
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
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 409) return { duplicate: true, job: null };
    throw new Error(result?.message || result?.error || `Agent queue failed: ${response.status}`);
  }
  return { queued: true, job: Array.isArray(result) ? result[0] : result };
}

async function syncSupabaseSnapshots() {
  if (!SYNC_SUPABASE_AFTER_REFRESH) return null;
  return runJsonScript("scripts/sync-supabase-snapshots.js", [], 120000);
}

function logProgress(event) {
  refreshState.currentStep = event;
  refreshState.log = [
    {
      at: new Date().toISOString(),
      ...event,
    },
    ...refreshState.log,
  ].slice(0, 20);
}

async function startRefresh(trigger) {
  if (refreshState.state === "running") {
    return { accepted: false, reason: "Refresh already running", status: refreshState };
  }

  refreshState.state = "running";
  refreshState.startedAt = new Date().toISOString();
  refreshState.finishedAt = null;
  refreshState.lastError = null;
  refreshState.log = [];
  logProgress({ step: "queued", label: `Refresh started by ${trigger}`, completed: 0, total: 5 });

  try {
    logProgress({ step: "tms-access", label: "Opening CourierCloud with saved Chrome login", completed: 0, total: 8 });
    const tmsAccess = await runJsonScript("scripts/tms-access.js", ["--json"], 120000);
    if (tmsAccess.title !== "Operations Log") {
      throw new Error(`CourierCloud opened the wrong page: ${tmsAccess.title || "unknown"}`);
    }

    logProgress({ step: "live", label: "Refreshing live TMS and carrier tracking", completed: 1, total: 8 });
    const liveRefresh = await runJsonScript("scripts/live-refresh.js", ["all"], 20 * 60 * 1000);

    logProgress({ step: "dashboard", label: "Rebuilding dashboard from live source snapshots", completed: 5, total: 8 });
    const result = await runOpsSync({
      rootDir: ROOT_DIR,
      onProgress: logProgress,
    });
    logProgress({ step: "supabase", label: "Publishing hosted dashboard snapshot", completed: 7, total: 8 });
    const supabaseSync = await syncSupabaseSnapshots();
    refreshState.state = "idle";
    refreshState.finishedAt = new Date().toISOString();
    refreshState.lastRun = { trigger, tmsAccess, liveRefresh, supabaseSync, ...result };
    return { accepted: true, status: refreshState };
  } catch (error) {
    refreshState.state = "error";
    refreshState.finishedAt = new Date().toISOString();
    refreshState.lastError = error instanceof Error ? error.message : String(error);
    return { accepted: true, status: refreshState };
  }
}

async function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function saveStationMemory(entry) {
  const now = new Date().toISOString();
  const current = await readJson(STATION_MEMORY_PATH, {
    snapshotTime: now,
    source: "operator-station-memory",
    contacts: [],
  });
  const next = upsertStationMemory(current, entry, now);
  await writeJson(STATION_MEMORY_PATH, {
    snapshotTime: next.snapshotTime,
    source: next.source,
    contacts: next.contacts,
  });

  const refresh = await runOpsSync({
    rootDir: ROOT_DIR,
    onProgress: logProgress,
  });
  const supabaseSync = await syncSupabaseSnapshots();
  return {
    ok: true,
    entry: next.savedEntry,
    memoryCount: next.savedCount,
    refresh,
    supabaseSync,
  };
}

async function saveMoneyMemory(entry) {
  const now = new Date().toISOString();
  const current = await readJson(MONEY_MEMORY_PATH, {
    snapshotTime: now,
    source: "operator-money-memory",
    records: [],
  });
  const next = upsertMoneyMemory(current, entry, now);
  await writeJson(MONEY_MEMORY_PATH, {
    snapshotTime: next.snapshotTime,
    source: next.source,
    records: next.records,
  });

  const refresh = await runOpsSync({
    rootDir: ROOT_DIR,
    onProgress: logProgress,
  });
  const supabaseSync = await syncSupabaseSnapshots();
  return {
    ok: true,
    record: next.savedRecord,
    memoryCount: next.savedCount,
    refresh,
    supabaseSync,
  };
}

async function saveBrokerContactMemory(entry) {
  const now = new Date().toISOString();
  const current = await readJson(COMPANION_MEMORY_PATH, emptyCompanionMemory(now));
  const next = upsertBrokerContactMemory(current, entry, now);
  await writeJson(COMPANION_MEMORY_PATH, {
    snapshotTime: next.snapshotTime,
    source: next.source,
    operatorNotes: next.operatorNotes,
    resolvedConflicts: next.resolvedConflicts || [],
    alertStates: next.alertStates || [],
  });

  const refresh = await runOpsSync({
    rootDir: ROOT_DIR,
    onProgress: logProgress,
  });
  const supabaseSync = await syncSupabaseSnapshots();
  return {
    ok: true,
    note: next.savedNote,
    memoryCount: next.savedCount,
    refresh,
    supabaseSync,
  };
}

async function saveOperatorNoteMemory() {
  const error = new Error("Free-text operator-note mutation is retired; use protected structured phone truth.");
  error.statusCode = 410;
  error.code = "LEGACY_OPERATOR_NOTE_RETIRED";
  throw error;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => ({
      role: message?.role || "",
      content: message?.content || message?.text || message?.title || "",
      createdAt: message?.createdAt || message?.timestamp || "",
      context: message?.context || {},
      awb: message?.awb || message?.shipmentAwb || "",
      shipmentIds: Array.isArray(message?.shipmentIds) ? message.shipmentIds : [],
    }))
    .filter((message) => message.role && message.content);
}

function historyFromRequestBody(body) {
  const explicit = normalizeMessages(body?.history);
  if (explicit.length) return explicit;
  return normalizeMessages(body?.messages).slice(0, -1);
}

function latestBrainContext(body, history) {
  const candidates = [
    body?.context,
    body?.shipment,
    body?.awb ? { awb: body.awb } : null,
    ...history.slice().reverse().map((message) => ({
      ...(message.context || {}),
      awb: message.awb || message.context?.awb || message.shipmentIds?.[0] || "",
    })),
  ];
  return candidates.find((candidate) => candidate && (candidate.awb || candidate.station || candidate.topic)) || {};
}

function detectLocalOperatorUpdate(question, context) {
  const update = classifyOperatorUpdate(question, context);
  return update.kind === "operator-update"
    ? { ...update, persisted: false, canonicalTruthRecorded: false }
    : update;
}

function brainQuestionFromRequestBody(body) {
  const direct = String(body?.question || body?.message || "").trim();
  if (direct) return direct;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    if (message.role && message.role !== "user") continue;
    const content = String(message.content || message.text || "").trim();
    if (content) return content;
  }
  return "";
}

function publicAttachment(attachment) {
  return {
    fileName: attachment.fileName || attachment.filename || "",
    contentType: attachment.contentType || attachment.mimeType || "",
    kind: attachment.kind || "",
    awb: attachment.awb || "",
    carrierName: attachment.carrierName || "",
    size: Number(attachment.size || 0) || 0,
  };
}

async function attachGeneratedDocuments(action, draftPlan) {
  if (draftPlan.jobType !== "draft_gmail_email") return [];
  const result = await materializeDraftAttachmentsForAction(action);
  if (!result.attachments.length) return [];
  draftPlan.payload.attachmentFiles = [
    ...(draftPlan.payload.attachmentFiles || []),
    ...result.attachments,
  ];
  draftPlan.payload.attachments = [
    ...(draftPlan.payload.attachments || []),
    ...result.attachments.map(publicAttachment),
  ];
  return result.generated || [];
}

async function queueActionSend(actionId, providedAction = null, { dryRun = false, allowProvidedAction = false, dedupeKey = "" } = {}) {
  if (isSourceBackfillAction(providedAction)) {
    const result = await handleSourceBackfillAction(actionId, providedAction, {
      dryRun,
      queueJob: supabaseReady(),
    });
    if (!dryRun && result.body?.request && !supabaseReady()) {
      const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
        sourceOfTruth:
          "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
        requests: [],
      });
      const request = {
        ...result.body.request,
        status: "queued",
        note: "Local source-backfill request recorded because Supabase job queue is unavailable.",
      };
      const requests = [request, ...(queue.requests || []).filter((item) => item.id !== request.id)].slice(0, 100);
      await writeJson(EMAIL_SYNC_REQUESTS_PATH, {
        ...queue,
        snapshotTime: request.queuedAt,
        requests,
      });
      return {
        ...result,
        body: {
          ...result.body,
          queued: false,
          recorded: true,
          request,
        },
      };
    }
    return result;
  }
  if (isMoneyContextAction(providedAction)) {
    let result;
    try {
      result = await handleMoneyContextAction(actionId, providedAction, {
        dryRun,
        queueJob: supabaseReady(),
      });
    } catch (error) {
      if (
        dryRun ||
        !supabaseReady() ||
        !/unsupported agent job type:\s*money_refresh/i.test(error instanceof Error ? error.message : String(error))
      ) {
        throw error;
      }
      result = await handleMoneyContextAction(actionId, providedAction, {
        dryRun: false,
        queueJob: false,
      });
    }
    if (!dryRun && result.body?.request && (!supabaseReady() || result.body?.recorded)) {
      const queue = await readJson(MONEY_SYNC_REQUESTS_PATH, {
        sourceOfTruth:
          "Dashboard-created money sync requests are work intents. Codex/CourierCloud automation must read TMS economics and mark them complete.",
        requests: [],
      });
      const request = {
        ...result.body.request,
        status: "queued",
        note: "Local money refresh request recorded because Supabase job queue is unavailable.",
      };
      const requests = [request, ...(queue.requests || []).filter((item) => item.id !== request.id)].slice(0, 100);
      await writeJson(MONEY_SYNC_REQUESTS_PATH, {
        ...queue,
        snapshotTime: request.queuedAt,
        requests,
      });
      return {
        ...result,
        body: {
          ...result.body,
          queued: false,
          recorded: true,
          request,
        },
      };
    }
    return result;
  }
  if (isCarrierTrackingRefreshAction(providedAction)) {
    let result;
    try {
      result = await handleCarrierTrackingRefreshAction(actionId, providedAction, {
        dryRun,
        queueJob: supabaseReady(),
      });
    } catch (error) {
      if (
        dryRun ||
        !supabaseReady() ||
        !/unsupported agent job type:\s*tracking_refresh/i.test(error instanceof Error ? error.message : String(error))
      ) {
        throw error;
      }
      result = await handleCarrierTrackingRefreshAction(actionId, providedAction, {
        dryRun: false,
        queueJob: false,
      });
    }
    if (!dryRun && result.body?.request && (!supabaseReady() || result.body?.recorded)) {
      const queue = await readJson(TRACKING_SYNC_REQUESTS_PATH, {
        sourceOfTruth:
          "Dashboard-created tracking sync requests are work intents. Codex/CourierCloud automation must refresh carrier pages and mark them complete.",
        requests: [],
      });
      const request = {
        ...result.body.request,
        status: "queued",
        note: "Local carrier tracking refresh request recorded because Supabase job queue is unavailable.",
      };
      const requests = [request, ...(queue.requests || []).filter((item) => item.id !== request.id)].slice(0, 100);
      await writeJson(TRACKING_SYNC_REQUESTS_PATH, {
        ...queue,
        snapshotTime: request.queuedAt,
        requests,
      });
      return {
        ...result,
        body: {
          ...result.body,
          queued: false,
          recorded: true,
          request,
        },
      };
    }
    return result;
  }
  const actionQueue = await readJson(ACTION_QUEUE_PATH, { actions: [] });
  const storedAction = (actionQueue.actions || []).find((item) => item.id === actionId);
  const action = (storedAction ? actionWithOperatorDraftOverrides(storedAction, providedAction) : null) ||
    (providedActionCanQueue(actionId, providedAction) ? providedAction : null) ||
    (dryRun || allowProvidedAction ? providedAction : null);

  const validationError = validateDraftableAction(actionId, action);
  if (validationError) {
    return {
      statusCode: validationError === "Action not found" ? 404 : 409,
      body: { error: validationError, missing: action?.missing || [] },
    };
  }

  const now = new Date().toISOString();
  const outboxRequestId = `${action.id}-${Date.parse(now)}`;
  const draftPlan = draftPayloadForAction(action, outboxRequestId, now);
  let agentJob = null;

  if (dryRun) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        dryRun: true,
        queued: false,
        wouldQueue: true,
        jobType: draftPlan.jobType,
        safety: draftPlan.safety,
        request: {
          ...publicOutboxRequest(action, now, draftPlan, null),
          status: "validated",
          queuedAt: null,
        },
      },
    };
  }

  const outbox = await readJson(OUTBOX_PATH, {
    sourceOfTruth:
      "Dashboard-created outbox requests are draft intents. The agent/Gmail transport must create drafts and mark them ready for human approval.",
    requests: [],
  });

  const generatedAttachments = await attachGeneratedDocuments(action, draftPlan);

  if (draftPlan.jobType === "draft_gmail_email" && gmailDirectAvailable()) {
    const gmailDraft = await createGmailDraft(draftPlan.payload);
    const publicRequest = {
      ...publicOutboxRequest(action, now, draftPlan, null),
      status: "drafted",
      queuedAt: null,
      draftedAt: now,
      agentJobId: null,
      gmailDraftId: gmailDraft.draftId || "",
      gmailMessageId: gmailDraft.messageId || "",
      gmailThreadId: gmailDraft.threadId || draftPlan.payload.conversation?.threadId || "",
      generatedAttachments,
    };
    const existingActions = actionQueue.actions || [];
    const hasExistingAction = existingActions.some((item) => item.id === actionId);
    const nextAction = {
      ...action,
      status: "drafted",
      queuedAt: "",
      draftedAt: now,
      outboxRequestId: publicRequest.id,
      agentJobId: null,
      gmailDraftId: publicRequest.gmailDraftId,
      generatedAttachments,
    };
    const actions = hasExistingAction
      ? existingActions.map((item) => (item.id === actionId ? { ...item, ...nextAction } : item))
      : [nextAction, ...existingActions];
    const nextRequests = [
      publicRequest,
      ...(outbox.requests || []).filter((item) => item.id !== publicRequest.id),
    ].slice(0, 200);

    await Promise.all([
      writeJson(ACTION_QUEUE_PATH, {
        ...actionQueue,
        snapshotTime: now,
        counts: {
          ...(actionQueue.counts || {}),
          queued: actions.filter((item) => item.status === "queued").length,
          drafted: actions.filter((item) => item.status === "drafted").length,
          sent: actions.filter((item) => item.status === "sent").length,
        },
        actions,
      }),
      writeJson(OUTBOX_PATH, {
        ...outbox,
        snapshotTime: now,
        requests: nextRequests,
      }),
    ]);

    return {
      statusCode: 201,
      body: {
        queued: false,
        drafted: true,
        dryRun: false,
        direct: true,
        jobType: draftPlan.jobType,
        request: publicRequest,
        gmailDraft,
        generatedAttachments,
        safety: draftPlan.safety,
      },
    };
  }

  agentJob = await queueSupabaseAgentJob(
    draftPlan.jobType,
    draftPlan.payload,
    {
      dedupeKey: dedupeKey || actionIntentKey(action) || draftIntentKey(action.id),
      priority: action.priority === "high" ? 15 : 55,
      maxAttempts: 2,
    },
  );

  if (!agentJob?.job?.id && !agentJob?.duplicate) {
    return {
      statusCode: 503,
      body: {
        error: `${draftPlan.jobType} job was not queued`,
        reason: supabaseReady()
          ? "Supabase returned no job id"
          : "Server is missing Supabase environment for action queue",
      },
    };
  }
  const publicRequest = {
    ...publicOutboxRequest(action, now, draftPlan, agentJob?.job || null),
    agentJobId: agentJob?.job?.id || null,
    duplicate: agentJob?.duplicate || false,
    generatedAttachments,
  };
  const nextRequests = [publicRequest, ...(outbox.requests || [])].slice(0, 200);

  const existingActions = actionQueue.actions || [];
  const hasExistingAction = existingActions.some((item) => item.id === actionId);
  actionQueue.actions = hasExistingAction
    ? existingActions.map((item) =>
        item.id === actionId
          ? {
              ...item,
              status: "queued",
              queuedAt: now,
              outboxRequestId: publicRequest.id,
              agentJobId: agentJob?.job?.id || null,
            }
          : item,
      )
    : [
        {
          ...action,
          status: "queued",
          queuedAt: now,
          outboxRequestId: publicRequest.id,
          agentJobId: agentJob?.job?.id || null,
        },
        ...existingActions,
      ];

  await Promise.all([
    writeJson(ACTION_QUEUE_PATH, {
      ...actionQueue,
      snapshotTime: now,
      counts: {
        ...(actionQueue.counts || {}),
        queued: actionQueue.actions.filter((item) => item.status === "queued").length,
        drafted: actionQueue.actions.filter((item) => item.status === "drafted").length,
        sent: actionQueue.actions.filter((item) => item.status === "sent").length,
      },
      actions: actionQueue.actions,
    }),
    writeJson(OUTBOX_PATH, {
      ...outbox,
      snapshotTime: now,
      requests: nextRequests,
    }),
  ]);

  return {
    statusCode: 202,
    body: {
      queued: true,
      dryRun: false,
      jobType: draftPlan.jobType,
      request: publicRequest,
      generatedAttachments,
      safety: draftPlan.safety,
    },
  };
}

async function retryOutboxRequest(requestId, { dryRun = false, providedRequest = null } = {}) {
  const outbox = await readJson(OUTBOX_PATH, { requests: [] });
  const request = (outbox.requests || []).find((item) => item.id === requestId) ||
    (dryRun && providedRequest?.id === requestId ? providedRequest : null);
  if (!request) return { statusCode: 404, body: { error: "Outbox request not found" } };
  if (request.status !== "failed") {
    return {
      statusCode: 409,
      body: { error: "Only failed draft requests can be retried" },
    };
  }
  const action = actionFromOutboxRequest(request);
  return queueActionSend(action?.id || request.actionId || request.id, action, {
    dryRun,
    allowProvidedAction: true,
    dedupeKey: draftIntentKey(request.id, "retry"),
  });
}

async function queueEmailRefresh(options = {}) {
  const now = new Date().toISOString();
  const source = options.source || "dashboard";
  const trigger = options.trigger || "";
  const activeSnapshot = await readJson(path.join(ROOT_DIR, "shipment-truth-packets.json"), {
    snapshotTime: null,
    shipments: [],
  });
  const proofSnapshot = await readJson(path.join(ROOT_DIR, "gmail-proof-snapshot.json"), {
    snapshotTime: null,
    writerVersion: "",
  });
  const awbs = [...new Set((activeSnapshot.shipments || [])
    .filter((shipment) => !shipment.truthPacketRole || shipment.truthPacketRole === "active")
    .map((shipment) => shipment.awb)
    .filter(Boolean))];
  const proofSnapshotTime = proofSnapshot.snapshotTime || null;
  const proofAgeMs = proofSnapshotTime ? Date.now() - Date.parse(proofSnapshotTime) : NaN;
  const proofAgeMinutes = Number.isFinite(proofAgeMs) ? Math.max(0, Math.round(proofAgeMs / 60000)) : null;
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const activeStatuses = new Set(["queued", "running", "waiting_external"]);
  const recentAutoCooldownMs = 15 * 60 * 1000;
  const existing = (queue.requests || []).find((item) =>
    item?.type === "gmail-proof-refresh" &&
    item.proofSnapshotTime === proofSnapshotTime &&
    (
      activeStatuses.has(String(item.status || "").toLowerCase()) ||
      (
        source === "dashboard-auto" &&
        item.source === "dashboard-auto" &&
        Number.isFinite(Date.parse(item.queuedAt || item.createdAt || "")) &&
        Date.parse(now) - Date.parse(item.queuedAt || item.createdAt || "") < recentAutoCooldownMs
      )
    )
  );
  if (existing) {
    return { queued: false, alreadyQueued: true, request: existing };
  }
  const request = {
    id: `email-sync-${Date.parse(now)}`,
    type: "gmail-proof-refresh",
    reason: "email-proof-stale",
    source,
    trigger,
    status: "queued",
    queuedAt: now,
    snapshotTime: activeSnapshot.snapshotTime || null,
    proofSnapshotTime,
    proofWriterVersion: proofSnapshot.writerVersion || "",
    proofAgeMinutes,
    mailbox: "contact-052@demo-freight.example",
    lookback: "30 days before each shipment departure/ready date through now",
    awbs,
    expectedOutput: [
      "Update gmail-proof-snapshot.json",
      "Update broker-dispatch-snapshot.json",
      "Update customs-broker-snapshot.json",
      "Update eod-report-facts.json when same-day events are found",
      "Run npm run refresh after Gmail evidence is written",
    ],
    note:
      "The local web app cannot directly use the Codex Gmail connector. This request is for the Codex agent or scheduled automation to process.",
  };
  const requests = [request, ...(queue.requests || [])].slice(0, 100);
  await writeJson(EMAIL_SYNC_REQUESTS_PATH, {
    ...queue,
    snapshotTime: now,
    requests,
  });
  return { queued: true, request };
}

async function claimLocalEmailSyncRequest(options = {}) {
  const args = ["--summary"];
  if (options.requestId) args.push("--request-id", options.requestId);
  const result = await runJsonScript("scripts/claim-email-sync-request.js", args, 120000);
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const requestId = result.request?.id || options.requestId || "";
  const request = (queue.requests || []).find((item) => item?.id === requestId) || result.request || null;
  return {
    ...result,
    request,
    queueSnapshotTime: queue.snapshotTime || "",
  };
}

function resolveLocalArtifactPath(fileName) {
  const relative = String(fileName || "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(ROOT_DIR, relative);
  if (resolved !== ROOT_DIR && !resolved.startsWith(`${ROOT_DIR}${path.sep}`)) {
    throw new Error("Email proof context path is outside the app workspace");
  }
  return resolved;
}

function summarizeEmailSyncContext(context = {}, request = {}, contextFile = "") {
  const queries = Array.isArray(context.queries) ? context.queries : [];
  const queryCount = queries.reduce((count, shipment) => count + (shipment.suggestedQueries?.length || 0), 0);
  const sampleQueries = [];
  for (const shipment of queries) {
    for (const query of shipment.suggestedQueries || []) {
      sampleQueries.push({ awb: shipment.awb || shipment.normalizedAwb || "", query });
      if (sampleQueries.length >= 6) break;
    }
    if (sampleQueries.length >= 6) break;
  }
  const awbs = request.awbs || context.request?.awbs || context.job?.payload?.awbs || queries.map((item) => item.awb).filter(Boolean);
  return {
    ok: true,
    found: true,
    request: {
      id: request.id || context.request?.id || context.job?.id || "",
      type: request.type || context.request?.type || "gmail-proof-refresh",
      status: request.status || context.request?.status || context.job?.status || "",
      queuedAt: request.queuedAt || context.request?.queuedAt || context.job?.created_at || "",
      claimedAt: request.claimedAt || context.request?.claimedAt || "",
      lockedBy: request.lockedBy || context.request?.lockedBy || "",
      contextFile,
      awbs,
    },
    packet: {
      contextFile,
      mailbox: context.mailbox || request.mailbox || "",
      workerId: context.workerId || request.lockedBy || "",
      shipmentCount: context.shipmentCount || awbs.length || 0,
      activeShipmentCount: context.activeShipmentCount || 0,
      sourceBackfillShipmentCount: context.sourceBackfillShipmentCount || 0,
      queryCount,
      sampleQueries,
      outputFile: context.outputContract?.file || request.outputFile || "",
      completionCommand: context.outputContract?.completionCommand || request.completionCommand || "",
      expectedOutput: request.expectedOutput || context.request?.expectedOutput || context.job?.payload?.expectedOutput || [],
    },
  };
}

async function readLocalEmailSyncContext(options = {}) {
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const requestId = String(options.requestId || "").trim();
  const request = (queue.requests || []).find((item) => item?.id === requestId) || null;
  if (!request) return { ok: false, found: false, error: "Email proof request not found" };
  if (!request.contextFile) {
    return {
      ok: true,
      found: false,
      request,
      reason: "Email proof context packet has not been generated yet",
    };
  }
  const contextPath = resolveLocalArtifactPath(request.contextFile);
  const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
  return summarizeEmailSyncContext(context, request, request.contextFile);
}

async function completeLocalEmailSyncFromOutput(options = {}) {
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const requestId = String(options.requestId || "").trim();
  const request = (queue.requests || []).find((item) => item?.id === requestId) || null;
  if (!request) throw new Error("Email proof request not found");
  const resultPath = request.outputFile || "gmail-enrichment-update.json";
  const args = ["--job-id", request.id, "--result", resultPath];
  const workerId = request.lockedBy || request.workerId || "";
  if (workerId) args.push("--worker-id", workerId);
  if (!supabaseReady()) args.push("--skip-sync");
  const result = await runJsonScript("scripts/complete-gmail-refresh.js", args, 15 * 60 * 1000);
  const refreshedQueue = await readJson(EMAIL_SYNC_REQUESTS_PATH, { requests: [] });
  const completedRequest = (refreshedQueue.requests || []).find((item) => item?.id === request.id) || request;
  return {
    ...result,
    request: completedRequest,
    queueSnapshotTime: refreshedQueue.snapshotTime || "",
    skippedSupabaseSync: !supabaseReady(),
  };
}

async function runLocalEmailSyncRequest(options = {}) {
  const args = ["--summary", "--complete"];
  if (options.requestId) args.push("--request-id", options.requestId);
  const result = await runJsonScript("scripts/run-email-sync-request.js", args, 20 * 60 * 1000);
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const requestId = result.request?.id || options.requestId || "";
  const request = (queue.requests || []).find((item) => item?.id === requestId) || result.request || null;
  return {
    ...result,
    request,
    queueSnapshotTime: queue.snapshotTime || "",
  };
}

function envText(value) {
  const raw = String(value || "").trim();
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function hostedGmailRefreshConfig() {
  const candidates = [
    ["PQ_HOSTED_BASE_URL", process.env.PQ_HOSTED_BASE_URL],
    ["PIKIIO_HOSTED_BASE_URL", process.env.PIKIIO_HOSTED_BASE_URL],
    ["VERCEL_PROJECT_PRODUCTION_URL", process.env.VERCEL_PROJECT_PRODUCTION_URL],
    ["VERCEL_URL", process.env.VERCEL_URL],
  ];
  const [baseUrlSource, rawBaseUrl] = candidates.find(([, value]) => envText(value)) || ["", ""];
  const raw = envText(rawBaseUrl).replace(/\/+$/, "");
  const baseUrl = raw
    ? /^https?:\/\//i.test(raw)
      ? raw
      : `https://${raw}`
    : "";
  const cronSecret = envText(process.env.CRON_SECRET);
  const missing = [
    baseUrl ? "" : "PQ_HOSTED_BASE_URL or PIKIIO_HOSTED_BASE_URL or VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL",
    cronSecret ? "" : "CRON_SECRET",
  ].filter(Boolean);
  return {
    available: missing.length === 0,
    baseUrl,
    baseUrlSource,
    hasCronSecret: Boolean(cronSecret),
    cronSecret,
    missing,
  };
}

async function updateLocalEmailSyncRequest(requestId, patch) {
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const now = new Date().toISOString();
  const requests = (queue.requests || []).map((request) =>
    request?.id === requestId ? { ...request, ...patch } : request
  );
  await writeJson(EMAIL_SYNC_REQUESTS_PATH, { ...queue, snapshotTime: now, requests });
  return requests.find((request) => request?.id === requestId) || null;
}

function publicHostedGmailResult(payload = {}) {
  return {
    ok: Boolean(payload.ok),
    direct: Boolean(payload.direct),
    awbCount: payload.awbCount || 0,
    updated: payload.updated || 0,
    threadCount: payload.threadCount || 0,
    queryCount: payload.queryCount || 0,
    attachmentAuditCount: payload.attachmentAuditCount || 0,
    shipmentEventCount: payload.shipmentEventCount || 0,
    shipmentStateCount: payload.shipmentStateCount || 0,
    operatorNotificationCount: payload.operatorNotificationCount || 0,
    updatedAwbs: payload.updatedAwbs || [],
    heavySnapshotWrites: payload.heavySnapshotWrites || [],
    skippedHeavySnapshotWrites: payload.skippedHeavySnapshotWrites || [],
    freshnessPolicy: payload.freshnessPolicy || "",
    snapshotPolicy: payload.snapshotPolicy || "",
    error: payload.error || "",
    phase: payload.phase || "",
  };
}

function usefulHostedSnapshotPayload(payload) {
  return Boolean(payload && typeof payload === "object" && Object.keys(payload).length);
}

function publicHostedImportResult(result = {}) {
  return {
    ok: Boolean(result.ok),
    importedSnapshots: result.importedSnapshots || [],
    missingSnapshots: result.missingSnapshots || [],
    importedAt: result.importedAt || "",
    dashboardSnapshotTime: result.refresh?.finishedAt || result.importedAt || "",
    activeShipmentCount: result.refresh?.activeShipmentCount || 0,
    actionCount: result.refresh?.actionCount || 0,
    supabaseSynced: Boolean(result.supabaseSync && result.supabaseSync.skipped !== true),
    supabaseSkipped: Boolean(result.supabaseSync?.skipped),
    supabaseError: result.supabaseSync?.error || "",
    error: result.error || "",
  };
}

async function importHostedGmailSnapshotsAndRebuild() {
  if (!supabaseReady()) {
    throw new Error("Hosted Gmail refreshed, but local import is missing PQ_SUPABASE_URL and PQ_SUPABASE_SERVICE_ROLE_KEY or PQ_SUPABASE_ANON_KEY");
  }

  const importedSnapshots = [];
  const missingSnapshots = [];
  for (const [snapshotKey, fileName] of HOSTED_GMAIL_IMPORT_SNAPSHOTS) {
    const payload = await loadAppSnapshot(snapshotKey, null);
    if (!usefulHostedSnapshotPayload(payload)) {
      missingSnapshots.push(snapshotKey);
      continue;
    }
    await writeJson(path.join(ROOT_DIR, fileName), payload);
    importedSnapshots.push(snapshotKey);
  }

  if (!importedSnapshots.includes("gmail-proof-snapshot")) {
    throw new Error("Hosted Gmail refreshed, but no hosted gmail-proof-snapshot was available to import locally");
  }

  logProgress({ step: "hosted-gmail-import", label: "Imported hosted Gmail proof into local control room", completed: 1, total: 2 });
  const refresh = await runOpsSync({
    rootDir: ROOT_DIR,
    onProgress: logProgress,
  });
  logProgress({ step: "hosted-gmail-rebuild", label: "Rebuilt local control room from hosted Gmail proof", completed: 2, total: 2 });
  let supabaseSync = null;
  try {
    supabaseSync = await syncSupabaseSnapshots();
  } catch (error) {
    supabaseSync = {
      skipped: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    importedAt: new Date().toISOString(),
    importedSnapshots,
    missingSnapshots,
    refresh,
    supabaseSync,
  };
}

async function runHostedEmailSyncRefresh(options = {}) {
  const queue = await readJson(EMAIL_SYNC_REQUESTS_PATH, {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
  const requestId = String(options.requestId || "").trim();
  const request = (queue.requests || []).find((item) => item?.id === requestId) || null;
  if (!request) return { ok: true, executed: false, blocked: true, reason: "Email proof request not found" };

  const config = hostedGmailRefreshConfig();
  const publicConfig = {
    available: config.available,
    baseUrl: config.baseUrl,
    baseUrlSource: config.baseUrlSource,
    hasCronSecret: config.hasCronSecret,
    missing: config.missing,
  };
  if (!config.available) {
    const reason = `Hosted Gmail refresh is not configured: ${config.missing.join(", ")}`;
    const patched = options.dryRun ? request : await updateLocalEmailSyncRequest(request.id, {
      hostedRunStatus: "blocked",
      hostedRunAt: new Date().toISOString(),
      lastHostedRunError: reason,
      hostedGmailConfig: publicConfig,
    });
    return { ok: true, executed: false, blocked: true, dryRun: Boolean(options.dryRun), request: patched, reason, hostedGmailConfig: publicConfig };
  }

  const awbs = [...new Set((request.awbs || [request.awb]).filter(Boolean))];
  const url = new URL(`${config.baseUrl}/api/cron/gmail-refresh.js`);
  if (awbs.length) url.searchParams.set("awbs", awbs.join(","));
  if (options.dryRun) {
    return {
      ok: true,
      executed: false,
      blocked: false,
      dryRun: true,
      request,
      reason: "Would run hosted Gmail refresh for this packet",
      hostedGmailConfig: publicConfig,
      hostedUrl: url.toString(),
      awbCount: awbs.length,
    };
  }

  const startedAt = new Date().toISOString();
  await updateLocalEmailSyncRequest(request.id, {
    hostedRunStatus: "running",
    hostedRunAt: startedAt,
    lastHostedRunError: "",
    hostedGmailConfig: publicConfig,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.cronSecret}`,
      "content-type": "application/json",
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  const publicResult = publicHostedGmailResult(payload);
  if (!response.ok || payload.error || payload.ok === false) {
    const reason = payload.error || `Hosted Gmail refresh failed: ${response.status}`;
    const patched = await updateLocalEmailSyncRequest(request.id, {
      hostedRunStatus: "blocked",
      hostedCompletedAt: new Date().toISOString(),
      lastHostedRunError: reason,
      hostedGmailResult: publicResult,
    });
    return { ok: true, executed: true, blocked: true, request: patched, reason, hosted: publicResult };
  }
  const patched = await updateLocalEmailSyncRequest(request.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    completedBy: "hosted-gmail-refresh",
    hostedRunStatus: "completed",
    hostedCompletedAt: new Date().toISOString(),
    lastHostedRunError: "",
    hostedGmailResult: publicResult,
  });
  let imported = null;
  try {
    imported = await importHostedGmailSnapshotsAndRebuild();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const blocked = await updateLocalEmailSyncRequest(request.id, {
      status: "waiting_external",
      hostedRunStatus: "completed",
      hostedImportStatus: "blocked",
      hostedImportAt: new Date().toISOString(),
      lastHostedImportError: reason,
      hostedGmailResult: publicResult,
    });
    return {
      ok: true,
      executed: true,
      blocked: true,
      request: blocked,
      reason,
      hosted: publicResult,
      hostedImport: publicHostedImportResult({ ok: false, error: reason }),
    };
  }
  const completed = await updateLocalEmailSyncRequest(request.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    completedBy: "hosted-gmail-refresh",
    hostedRunStatus: "completed",
    hostedImportStatus: "completed",
    hostedImportAt: imported.importedAt,
    lastHostedRunError: "",
    lastHostedImportError: "",
    hostedGmailResult: publicResult,
    hostedImportResult: publicHostedImportResult(imported),
  });
  return {
    ok: true,
    executed: true,
    blocked: false,
    completed: true,
    request: completed || patched,
    hosted: publicResult,
    hostedImport: publicHostedImportResult(imported),
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalizedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, normalizedPath);

  if (!filePath.startsWith(ROOT_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const requestPath = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;

  if (requestPath === "/api/local-runtime" && request.method === "GET") {
    await sendJson(response, 200, {
      ok: true,
      app: "pq-ops-dashboard",
      rootDir: ROOT_DIR,
      pid: process.pid,
      port: PORT,
      codeSignature: process.env.PIKIIO_AUDIT_CODE_SIGNATURE || "",
      localRuntime: true,
      platformFlags: {
        VERCEL: Boolean(process.env.VERCEL),
        VERCEL_ENV: Boolean(process.env.VERCEL_ENV),
        NOW_REGION: Boolean(process.env.NOW_REGION),
      },
    });
    return;
  }

  if (requestPath === "/api/refresh" && request.method === "POST") {
    startRefresh("manual");
    await sendJson(response, 202, refreshState);
    return;
  }

  if (requestPath === "/api/refresh/status" && request.method === "GET") {
    await sendJson(response, 200, refreshState);
    return;
  }

  if (requestPath === "/api/actions/send" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      const dryRun = body.dryRun === true || new URL(request.url, `http://${request.headers.host || "localhost"}`).searchParams.get("dryRun") === "1";
      const result = await queueActionSend(body.actionId, body.action || null, { dryRun });
      await sendJson(response, result.statusCode, result.body);
    } catch (error) {
      await sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/delivery-order" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      const dryRun = body.dryRun === true || new URL(request.url, `http://${request.headers.host || "localhost"}`).searchParams.get("dryRun") === "1";
      const result = await generateDeliveryOrderForAction(body.actionId || body.action?.id || "", body.action || null, {
        dryRun,
      });
      await sendJson(response, result.statusCode, result.body);
    } catch (error) {
      await sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/outbox/retry" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      const dryRun = body.dryRun === true || new URL(request.url, `http://${request.headers.host || "localhost"}`).searchParams.get("dryRun") === "1";
      const result = await retryOutboxRequest(body.requestId || body.outboxRequestId || "", {
        dryRun,
        providedRequest: body.request || null,
      });
      await sendJson(response, result.statusCode, result.body);
    } catch (error) {
      await sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/email-refresh" && request.method === "POST") {
    const body = await readRequestJson(request).catch(() => ({}));
    await sendJson(response, 202, await queueEmailRefresh({
      source: body.source || "dashboard",
      trigger: body.trigger || "",
    }));
    return;
  }

  if (requestPath === "/api/email-refresh/claim" && request.method === "POST") {
    try {
      const body = await readRequestJson(request).catch(() => ({}));
      await sendJson(response, 200, await claimLocalEmailSyncRequest({
        requestId: body.requestId || body.id || "",
      }));
    } catch (error) {
      await sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/email-refresh/context" && request.method === "GET") {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const result = await readLocalEmailSyncContext({
        requestId: url.searchParams.get("requestId") || url.searchParams.get("id") || "",
      });
      await sendJson(response, result.ok === false ? 404 : 200, result);
    } catch (error) {
      await sendJson(response, 400, { ok: false, found: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/email-refresh/complete" && request.method === "POST") {
    try {
      const body = await readRequestJson(request).catch(() => ({}));
      await sendJson(response, 200, await completeLocalEmailSyncFromOutput({
        requestId: body.requestId || body.id || "",
      }));
    } catch (error) {
      await sendJson(response, 200, { ok: false, blocked: true, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/email-refresh/run" && request.method === "POST") {
    try {
      const body = await readRequestJson(request).catch(() => ({}));
      await sendJson(response, 200, await runLocalEmailSyncRequest({
        requestId: body.requestId || body.id || "",
      }));
    } catch (error) {
      await sendJson(response, 200, { ok: false, blocked: true, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/email-refresh/hosted-run" && request.method === "POST") {
    try {
      const body = await readRequestJson(request).catch(() => ({}));
      await sendJson(response, 200, await runHostedEmailSyncRefresh({
        requestId: body.requestId || body.id || "",
        dryRun: body.dryRun === true,
      }));
    } catch (error) {
      await sendJson(response, 200, { ok: false, blocked: true, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/outbox" && request.method === "GET") {
    await sendJson(response, 200, await readJson(OUTBOX_PATH, { requests: [] }));
    return;
  }

  if (requestPath === "/api/operator/events") {
    await operatorEventsApi(request, response);
    return;
  }

  if (requestPath === "/api/operator/events/action") {
    await operatorEventActionApi(request, response);
    return;
  }

  if (requestPath === "/api/operator/push/config") {
    await operatorPushConfigApi(request, response);
    return;
  }

  if (requestPath === "/api/operator/push/subscribe") {
    await operatorPushSubscribeApi(request, response);
    return;
  }

  if (requestPath === "/api/operator/push/drain") {
    await operatorPushDrainApi(request, response);
    return;
  }

  if (requestPath === "/api/gmail/oauth/start" || requestPath === "/api/gmail/oauth/start.js") {
    await gmailOAuthStartApi(request, response);
    return;
  }

  if (requestPath === "/api/gmail/oauth/callback" || requestPath === "/api/gmail/oauth/callback.js") {
    await gmailOAuthCallbackApi(request, response);
    return;
  }

  if (requestPath === "/api/gmail/status" || requestPath === "/api/gmail/status.js") {
    await gmailStatusApi(request, response);
    return;
  }

  if (requestPath === "/api/gmail/evidence" || requestPath === "/api/gmail/evidence.js") {
    await gmailEvidenceApi(request, response);
    return;
  }

  if (requestPath === "/api/brain/shipments" || requestPath === "/api/brain/shipments.js") {
    await brainShipmentsApi(request, response);
    return;
  }

  if (requestPath === "/api/truth/health" || requestPath === "/api/truth/health.js") {
    await truthHealthApi(request, response);
    return;
  }

  if (requestPath === "/api/truth/operator-browser-event" || requestPath === "/api/truth/operator-browser-event.js") {
    await operatorBrowserEventApi(request, response);
    return;
  }

  if (requestPath === "/api/brain/chat" && request.method === "POST") {
    const startedAt = Date.now();
    try {
      const body = await readRequestJson(request);
      const question = brainQuestionFromRequestBody(body);
      const history = historyFromRequestBody(body);
      const context = latestBrainContext(body, history);
      const operatorUpdate = detectLocalOperatorUpdate(question, context);
      const result = await answerOpsBrainQuestion({
        rootDir: ROOT_DIR,
        question,
        history,
        context,
        sessionState: body.sessionState,
        clarificationOptionId: body.clarificationOptionId,
        env: {
          ...process.env,
          VERCEL: "",
          VERCEL_ENV: "",
          NOW_REGION: "",
        },
      });
      const answer = publicBrainAnswer(result.answer);
      if (operatorUpdate.kind === "operator-update") {
        answer.operatorTruthCapture = {
          status: "not-recorded",
          awb: operatorUpdate.awb,
          reason: "Free text is conversation context only. Record shipment facts with a protected structured phone-truth control.",
        };
        const durationMs = Date.now() - startedAt;
        if (durationMs > 2000) {
          console.warn("[brain-chat] slow answer", {
            durationMs,
            topic: answer?.context?.topic || "",
            hasAwb: Boolean(answer?.context?.awb),
            questionLength: String(question || "").length,
          });
        }
        await sendJson(response, 200, { ok: result.ok, answer });
        return;
      }
      const durationMs = Date.now() - startedAt;
      if (durationMs > 2000) {
        console.warn("[brain-chat] slow answer", {
          durationMs,
          topic: answer?.context?.topic || "",
          hasAwb: Boolean(answer?.context?.awb),
          questionLength: String(question || "").length,
        });
      }
      await sendJson(response, 200, { ok: result.ok, answer: publicBrainAnswer(result.answer) });
    } catch (error) {
      console.error("[brain-chat] failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      await sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/station-memory" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      await sendJson(response, 200, await saveStationMemory(body.entry || body));
    } catch (error) {
      await sendJson(response, error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/money-memory" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      await sendJson(response, 200, await saveMoneyMemory(body.entry || body));
    } catch (error) {
      await sendJson(response, error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (requestPath === "/api/broker-contact" && request.method === "POST") {
    try {
      const body = await readRequestJson(request);
      await sendJson(response, 200, await saveBrokerContactMemory(body.entry || body));
    } catch (error) {
      await sendJson(response, error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if ((requestPath === "/api/operator-note" || requestPath === "/api/operator-note.js") && request.method === "POST") {
    try {
      await saveOperatorNoteMemory();
    } catch (error) {
      await sendJson(response, error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  await serveStatic(request, response);
});

function localNetworkUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}/`);
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`PQ Ops Dashboard running at http://127.0.0.1:${PORT}/`);
    localNetworkUrls().forEach((url) => console.log(`Phone/local network URL: ${url}`));
    if (ENABLE_LOCAL_SNAPSHOT_CRON) {
      scheduleNextRun();
      console.log(`Local full-stack refresh scheduled for ${DAILY_REFRESH_HOUR}:00 AM ${TIME_ZONE}`);
    } else {
      console.log("Local full-stack cron disabled; use Codex automation for scheduled refresh.");
    }
  });
}

module.exports = {
  queueActionSend,
  retryOutboxRequest,
  saveBrokerContactMemory,
  saveOperatorNoteMemory,
  saveStationMemory,
};

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { runOpsSync } = require("../ops-sync");

const {
  answerOpsBrainQuestion,
  controlRoomPlan,
  gateState,
  mergeShipments,
  normalizeAwb,
  publicBrainAnswer,
  readLocalMemory,
  readOpsBrainMemory,
} = require("../lib/ops-brain-companion");
const {
  gmailDirectEnv,
  runDirectGmailRefresh,
  _test: gmailDirectTest,
} = require("../lib/gmail-direct-ingest");
const {
  actionPacketProfile,
  auditActionLayer,
} = require("./action-layer-loop");
const {
  eventPushAllowed,
  operatorEventsFromNotificationsSnapshot,
} = require("../lib/operator-events");

const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "operator-truth-loop");
const LOCAL_URL = process.env.PIKIIO_AUDIT_APP_URL || "http://127.0.0.1:4173/";
const DEFAULT_LOCAL_APP_PORT = Number(new URL(LOCAL_URL).port || 4173);
const CHROME_BIN =
  process.env.PQ_TMS_CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const AUTOMATION_PROFILE =
  process.env.PQ_TMS_AUTOMATION_CHROME_PROFILE ||
  path.join(os.homedir(), ".pq-tms-chrome-profile");
const PORT = Number(process.env.PQ_TMS_CHROME_PORT || 9223);
const LOCAL_ENV_SKIP_KEYS = new Set(["VERCEL", "VERCEL_ENV", "NOW_REGION"]);
const AUDIT_SIGNATURE_FILES = [
  "server.js",
  "app.js",
  "lib/ops-brain-companion.js",
  "lib/supabase-agent.js",
];
const AUDIT_CODE_SIGNATURE = currentAuditCodeSignature();
const EXPECTED_APP_RUNTIME_VERSION = currentAppRuntimeVersion();
let latestProgressEntry = null;
let shutdownArtifactWritten = false;

function currentAuditCodeSignature() {
  return AUDIT_SIGNATURE_FILES.map((relativePath) => {
    try {
      const stat = fs.statSync(path.join(ROOT_DIR, relativePath));
      return `${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
      return `${relativePath}:missing`;
    }
  }).join("|");
}

function currentAppRuntimeVersion() {
  try {
    const source = fs.readFileSync(path.join(ROOT_DIR, "app.js"), "utf8");
    const match = source.match(/PIKIIO_APP_RUNTIME_VERSION\s*=\s*"([^"]+)"/);
    return match?.[1] || "ops-loop-v12";
  } catch {
    return "ops-loop-v12";
  }
}

function parseArgs(argv) {
  const options = {
    cycles: 1,
    passes: 1,
    lookbackDays: 30,
    maxThreads: 220,
    maxAttachmentPdfs: 80,
    gmailSource: process.env.PIKIIO_AUDIT_GMAIL_SOURCE || "auto",
    memorySource: process.env.PIKIIO_AUDIT_MEMORY_SOURCE || "hosted",
    hostedProofMaxAgeMinutes: Number(process.env.PIKIIO_AUDIT_HOSTED_PROOF_MAX_AGE_MINUTES || 30),
    freshMaxAgeMinutes: Number(process.env.PIKIIO_AUDIT_FRESH_MAX_AGE_MINUTES || 180),
    requireFreshInventory: process.env.PIKIIO_AUDIT_REQUIRE_FRESH_INVENTORY === "1",
    deepQuestions: process.env.PIKIIO_AUDIT_DEEP_QUESTIONS === "1",
    goal: process.env.PIKIIO_AUDIT_GOAL === "1",
    goalStablePasses: Number(process.env.PIKIIO_AUDIT_GOAL_STABLE_PASSES || 2),
    goalMaxMinutes: Number(process.env.PIKIIO_AUDIT_GOAL_MAX_MINUTES || 45),
    goalMaxAttempts: Number(process.env.PIKIIO_AUDIT_GOAL_MAX_ATTEMPTS || 0),
    goalRefreshSources: process.env.PIKIIO_AUDIT_GOAL_REFRESH_SOURCES === "1",
    syncDashboardAfterPass: process.env.PIKIIO_AUDIT_SYNC_DASHBOARD_AFTER_PASS === "1",
    browserTimeoutMs: Number(process.env.PIKIIO_AUDIT_BROWSER_TIMEOUT_MS || 20 * 60 * 1000),
    skipBrowser: false,
    exitZero: false,
    awbs: [],
  };
  for (const arg of argv) {
    if (arg === "--skip-browser") options.skipBrowser = true;
    else if (arg === "--exit-zero") options.exitZero = true;
    else if (arg === "--deep-questions") options.deepQuestions = true;
    else if (arg === "--goal") options.goal = true;
    else if (arg === "--goal-refresh-sources") options.goalRefreshSources = true;
    else if (arg === "--sync-dashboard-after-pass") options.syncDashboardAfterPass = true;
    else if (arg === "--require-fresh-inventory") options.requireFreshInventory = true;
    else if (arg.startsWith("--cycles=")) options.cycles = Number(arg.slice("--cycles=".length));
    else if (arg.startsWith("--passes=")) options.passes = Number(arg.slice("--passes=".length));
    else if (arg.startsWith("--lookback-days=")) options.lookbackDays = Number(arg.slice("--lookback-days=".length));
    else if (arg.startsWith("--max-threads=")) options.maxThreads = Number(arg.slice("--max-threads=".length));
    else if (arg.startsWith("--max-attachment-pdfs=")) options.maxAttachmentPdfs = Number(arg.slice("--max-attachment-pdfs=".length));
    else if (arg.startsWith("--gmail-source=")) options.gmailSource = arg.slice("--gmail-source=".length);
    else if (arg.startsWith("--memory-source=")) options.memorySource = arg.slice("--memory-source=".length);
    else if (arg.startsWith("--hosted-proof-max-age-minutes=")) options.hostedProofMaxAgeMinutes = Number(arg.slice("--hosted-proof-max-age-minutes=".length));
    else if (arg.startsWith("--fresh-max-age-minutes=")) options.freshMaxAgeMinutes = Number(arg.slice("--fresh-max-age-minutes=".length));
    else if (arg.startsWith("--goal-stable-passes=")) options.goalStablePasses = Number(arg.slice("--goal-stable-passes=".length));
    else if (arg.startsWith("--goal-max-minutes=")) options.goalMaxMinutes = Number(arg.slice("--goal-max-minutes=".length));
    else if (arg.startsWith("--goal-max-attempts=")) options.goalMaxAttempts = Number(arg.slice("--goal-max-attempts=".length));
    else if (arg.startsWith("--browser-timeout-ms=")) options.browserTimeoutMs = Number(arg.slice("--browser-timeout-ms=".length));
    else if (arg.startsWith("--awb=")) options.awbs.push(...arg.slice("--awb=".length).split(",").map((item) => item.trim()).filter(Boolean));
    else throw new Error(`Unknown option ${arg}`);
  }
  options.cycles = Math.max(1, options.cycles || 1);
  options.passes = Math.max(1, options.passes || 1);
  if (!["auto", "local", "hosted-fresh"].includes(options.gmailSource)) {
    throw new Error(`--gmail-source must be auto, local, or hosted-fresh; got ${options.gmailSource}`);
  }
  if (!["hosted", "local-merged"].includes(options.memorySource)) {
    throw new Error(`--memory-source must be hosted or local-merged; got ${options.memorySource}`);
  }
  options.hostedProofMaxAgeMinutes = Math.max(1, options.hostedProofMaxAgeMinutes || 30);
  options.freshMaxAgeMinutes = Math.max(1, options.freshMaxAgeMinutes || 180);
  options.goalStablePasses = Math.max(1, options.goalStablePasses || 2);
  options.goalMaxMinutes = Math.max(1, options.goalMaxMinutes || 45);
  options.goalMaxAttempts = Math.max(0, options.goalMaxAttempts || 0);
  options.browserTimeoutMs = Math.max(30000, options.browserTimeoutMs || 20 * 60 * 1000);
  if (options.goal) {
    options.memorySource = options.memorySource === "hosted" ? "local-merged" : options.memorySource;
    options.gmailSource = options.gmailSource === "auto" ? "hosted-fresh" : options.gmailSource;
    options.requireFreshInventory = true;
    options.deepQuestions = true;
    options.skipBrowser = false;
  }
  return options;
}

function loadLocalEnv(rootDir, env = process.env) {
  for (const fileName of [".env.local", ".env"]) {
    const envPath = path.join(rootDir, fileName);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || env[match[1]]) continue;
      if (LOCAL_ENV_SKIP_KEYS.has(match[1])) continue;
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
}

function localRuntimeEnv(env = process.env) {
  const next = { ...env };
  if (!next.VERCEL_URL && !next.VERCEL_REGION) {
    for (const key of LOCAL_ENV_SKIP_KEYS) delete next[key];
  }
  return next;
}

function displayAwb(value) {
  const awb = normalizeAwb(value);
  return awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : String(value || "");
}

function compact(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function factRowText(fact) {
  if (!fact) return "";
  if (typeof fact === "string") return fact;
  return [
    fact.type,
    fact.label,
    fact.summary,
    fact.note,
    fact.evidence,
    fact.status,
    fact.nextAction,
    fact.broker,
    fact.selectedBroker,
    fact.contactEmail,
    fact.amount,
    fact.extractedText,
  ].filter(Boolean).join(" ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function shipmentOrderId(shipment = {}) {
  return String(
    shipment.id ||
      shipment.order ||
      shipment.tmsOrder ||
      shipment.shipmentId ||
      shipment.shipmentNumber ||
      shipment.tms?.order ||
      "",
  ).trim();
}

function activeTruthPacketRows(memory = {}) {
  return (memory.truthPackets?.shipments || [])
    .filter((shipment) =>
      normalizeAwb(shipment.awb || shipment.trackingNumber) &&
      (!shipment.truthPacketRole || shipment.truthPacketRole === "active") &&
      !shipment.completed
    );
}

function activeShipmentRows(memory = {}) {
  const packetRows = activeTruthPacketRows(memory);
  if (packetRows.length) return packetRows;
  return (memory.active?.shipments || [])
    .filter((shipment) => normalizeAwb(shipment.awb || shipment.trackingNumber));
}

function progress(message) {
  if (process.env.PIKIIO_AUDIT_QUIET === "1") return;
  process.stderr.write(`[operator-truth-loop] ${message}\n`);
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const entry = { at: new Date().toISOString(), pid: process.pid, message };
    latestProgressEntry = entry;
    fs.writeFileSync(path.join(ARTIFACT_DIR, "current-progress.json"), `${JSON.stringify(entry, null, 2)}\n`);
    fs.appendFileSync(path.join(ARTIFACT_DIR, "progress-ledger.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    // Progress artifacts are diagnostic only.
  }
}

function writeInterruptedArtifact(reason, code = "interrupted") {
  if (shutdownArtifactWritten) return;
  shutdownArtifactWritten = true;
  const at = new Date().toISOString();
  const artifact = {
    ok: false,
    rootDir: ROOT_DIR,
    mode: "operator-truth-gmail-proof-no-live-writes",
    fatal: {
      layer: "verifier-infrastructure",
      code,
      message: reason,
    },
    final: {
      ok: false,
      counts: { openShipments: 0, inventoryShipments: 0, passed: 0, failed: 0, issues: 1 },
      sourceFreshness: {
        status: "live-source-unavailable",
        generatedAt: at,
        blockers: [{
          source: "operator-truth-loop",
          command: "node scripts/shipment-truth-audit-loop.js",
          reason,
        }],
        staleSources: [],
        rows: [],
      },
      inventoryStatus: { ok: false },
      browser: { issues: [{ layer: "verifier-infrastructure", code, message: reason }] },
      notifications: { issues: [] },
      rows: [],
      failedRows: [],
      inventory: [],
    },
    goal: {
      ok: false,
      status: "interrupted",
      stablePasses: 0,
      requiredStablePasses: 1,
      nextGap: {
        status: "interrupted",
        layer: "verifier-infrastructure",
        code,
        message: reason,
      },
      history: [],
    },
    interrupted: {
      at,
      pid: process.pid,
      reason,
      lastProgress: latestProgressEntry,
    },
  };
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, "latest-interrupted.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    fs.writeFileSync(path.join(ARTIFACT_DIR, "latest.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    fs.writeFileSync(path.join(ARTIFACT_DIR, "latest.md"), `# Operator Truth Loop\nResult: FAIL\n\nVerifier infrastructure interrupted: ${reason}\n\nLast progress: ${latestProgressEntry?.message || "(none)"}\n`);
    fs.appendFileSync(path.join(ARTIFACT_DIR, "progress-ledger.jsonl"), `${JSON.stringify({ at, pid: process.pid, message: `interrupted: ${reason}` })}\n`);
  } catch {
    // Best effort only; process is already exiting.
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function readJsonIfExists(fileName, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

function operatorNotificationConditionKey(notification = {}) {
  const awb = normalizeAwb(notification.awb || notification.source?.awb || notification.subtitle || "");
  const type = String(notification.type || notification.eventType || "operator-event").toLowerCase().trim();
  return awb && type ? `${awb}:${type}` : String(notification.id || "");
}

function genericNotificationText(value = {}) {
  return /\bShipment needs attention\b|unclassified-operational-exception|generic|does not match a named exception|decide the operator move/i
    .test(`${value.eventType || value.type || ""} ${value.title || ""} ${value.message || ""} ${value.nextAction || ""}`);
}

function notificationAudit(snapshot = {}, now = new Date()) {
  const notifications = Array.isArray(snapshot?.notifications) ? snapshot.notifications : [];
  const byType = {};
  const semanticDuplicates = [];
  const seen = new Map();
  for (const notification of notifications) {
    const type = String(notification.type || notification.eventType || "operator-event");
    byType[type] = (byType[type] || 0) + 1;
    const key = operatorNotificationConditionKey(notification);
    if (key && seen.has(key)) {
      semanticDuplicates.push({
        key,
        firstId: seen.get(key).id || "",
        duplicateId: notification.id || "",
        message: compact(notification.message || "", 180),
      });
    }
    if (key) seen.set(key, notification);
  }
  const operatorEvents = operatorEventsFromNotificationsSnapshot({ notifications }, now);
  const pushable = operatorEvents.filter((event) => eventPushAllowed(event));
  const genericPushable = pushable.filter(genericNotificationText);
  const genericActive = notifications.filter(genericNotificationText);
  const snapshotAgeHours = snapshot?.snapshotTime
    ? Math.max(0, (now.getTime() - dateMs(snapshot.snapshotTime)) / 36e5)
    : null;
  const issues = [];
  if (semanticDuplicates.length) {
    issues.push({
      layer: "notification-quality",
      code: "semantic-duplicate-notifications",
      message: `${semanticDuplicates.length} notification condition(s) repeat by AWB/type.`,
    });
  }
  if (genericPushable.length) {
    issues.push({
      layer: "notification-quality",
      code: "generic-pushable-notifications",
      message: `${genericPushable.length} pushable notification(s) use generic/low-confidence text.`,
    });
  }
  return {
    snapshotTime: snapshot?.snapshotTime || "",
    snapshotAgeHours: snapshotAgeHours === null ? null : Number(snapshotAgeHours.toFixed(1)),
    notificationCount: notifications.length,
    operatorEventCount: operatorEvents.length,
    pushableCount: pushable.length,
    genericActiveCount: genericActive.length,
    genericPushableCount: genericPushable.length,
    typeCounts: byType,
    semanticDuplicates,
    genericPushable: genericPushable.map((event) => ({
      awb: event.awb || "",
      type: event.eventType || event.type || "",
      severity: event.severity || "",
      title: event.title || "",
      message: compact(event.message || "", 180),
      nextAction: compact(event.nextAction || "", 180),
    })),
    issues,
  };
}

function latestEvent(events = [], types = []) {
  const wanted = new Set(types);
  return events
    .filter((event) => wanted.has(String(event.type || "")))
    .sort((a, b) => dateMs(b.at || b.updatedAt) - dateMs(a.at || a.updatedAt))[0] || null;
}

function allProofEvents(proof = {}) {
  return [
    ...(proof.events || []),
    ...(proof.proof || []).map((item) => ({
      ...item,
      type: item.type || item.kind || item.label || "",
      summary: item.summary || item.note || item.label || "",
      at: item.at || item.date || proof.latestEventAt || "",
    })),
  ];
}

function truthPhaseFromException(exception = {}) {
  const type = normalizedPhase(exception.type || exception.exceptionType || exception.impact || "");
  if (["station-cargo-not-found", "driver-waiting"].includes(type)) return "pickup-blocked";
  if (type === "loading-problem") return "loading-blocked";
  if (["customs-hold", "inbond-rejected", "broker-release-pending", "station-release-not-visible", "airline-transmission-blocker"].includes(type)) return "customs-hold";
  if (type === "pickup-docs-needed") return "pickup-docs-needed";
  if (type === "awb-copy-needed") return "awb-copy-needed";
  if (type === "pickup-location-requested") return "pickup-location-requested";
  if (type === "delivery-facility-closed" || type === "storage-needed-after-delivery-blocker") return "delivery-blocked";
  return type || "exception";
}

function truthFromProof(proof = {}) {
  if (!proof?.awb) return null;
  let state = null;
  try {
    state = gmailDirectTest.shipmentStateFromProof(proof, new Date());
  } catch {
    state = null;
  }
  const events = allProofEvents(proof);
  const pod = latestEvent(events, ["pod-received"]);
  const delivered = latestEvent(events, ["delivered-reported"]);
  const podPending = latestEvent(events, ["pod-pending"]);
  const pickupConfirmed = latestEvent(events, ["pickup-confirmed"]);
  const pickupScheduled = latestEvent(events, ["pickup-scheduled"]);
  const pickupOnsite = latestEvent(events, ["pickup-onsite"]);
  const pickupDocsSent = latestEvent(events, ["pickup-docs-sent"]);
  const release = latestEvent(events, ["release-confirmed", "customs-release", "release-received"]);
  const arrival = latestEvent(events, ["arrival-notice-received", "arrival-confirmed"]);
  const exception = (state?.exceptions || [])
    .slice()
    .sort((a, b) => dateMs(b.at || b.updatedAt) - dateMs(a.at || a.updatedAt))[0] || null;
  const latestAirportExecution = [pickupConfirmed, pickupOnsite, pickupDocsSent]
    .filter(Boolean)
    .sort((a, b) => dateMs(b.at || b.updatedAt) - dateMs(a.at || a.updatedAt))[0] || null;
  const exceptionIsCurrent = exception && (
    !latestAirportExecution ||
    dateMs(exception.at || exception.updatedAt) >= dateMs(latestAirportExecution.at || latestAirportExecution.updatedAt)
  );
  let phase = "unknown";
  let nextAction = proof.nextAction || state?.nextAction || "";
  if (pod || state?.gates?.pod?.status === "received") {
    phase = "pod-received";
    nextAction = "No POD request; close out only if TMS still needs POD.";
  } else if (delivered || state?.gates?.delivery?.status === "delivered") {
    phase = podPending ? "delivered-pod-pending" : "delivered";
    nextAction = "Request signed POD from the pickup/delivery thread.";
  } else if (pickupConfirmed || ["picked-up", "inferred"].includes(state?.gates?.pickup?.status)) {
    phase = "picked-up";
    nextAction = "Track final delivery and collect POD.";
  } else if (pickupOnsite || state?.gates?.pickup?.status === "onsite") {
    phase = "pickup-onsite";
    nextAction = pickupOnsite?.nextAction || "Monitor loading, capture detention time if it waits, then collect pickup proof.";
  } else if (exceptionIsCurrent) {
    phase = truthPhaseFromException(exception);
    nextAction = exception.nextAction || nextAction || "Resolve the operational blocker in the thread.";
  } else if (pickupScheduled || state?.gates?.pickup?.status === "scheduled") {
    phase = "pickup-scheduled";
    nextAction = "Follow up at the scheduled pickup time; do not mark picked up yet.";
  } else if (release || state?.gates?.customs?.status === "released") {
    phase = "released";
    nextAction = "Confirm pickup broker/recovery plan.";
  } else if (arrival || state?.gates?.arrival?.status === "arrived") {
    phase = "arrived";
    nextAction = "Confirm release/fees/pickup path.";
  }
  const evidence = [pod, delivered, podPending, pickupConfirmed, pickupScheduled, pickupOnsite, pickupDocsSent, exception, release, arrival]
    .filter(Boolean)
    .map((event) => ({
      type: event.type || "",
      at: event.at || event.updatedAt || "",
      from: event.from || "",
      subject: event.subject || "",
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      summary: compact(event.summary || event.evidence || event.nextAction || "", 260),
    }));
  return {
    awb: displayAwb(proof.awb),
    normalizedAwb: normalizeAwb(proof.awb),
    phase,
    nextAction,
    latestEventAt: proof.latestEventAt || evidence[0]?.at || "",
    summary: proof.summary || state?.summary || "",
    evidence,
    gates: state?.gates || {},
    exceptionCount: state?.exceptions?.length || 0,
    attachmentAuditCount: proof.gmailAttachmentAudit?.length || proof.attachmentAudit?.length || 0,
  };
}

function customsRecordEvidenceSegments(record = {}) {
  return [
    record.status,
    record.broker,
    record.contactName,
    record.contactEmail,
    record.releaseProof,
    record.nextAction,
    ...(record.evidence || []).map((item) => [
      item.label,
      item.status,
      item.note,
      item.summary,
      item.evidence,
      item.nextAction,
    ].filter(Boolean).join(" ")),
  ].filter(Boolean);
}

function hasExplicitCustomsHoldText(text) {
  return /\b(customs[-\s]?hold|exam|examination|intensive|not released|not cleared|release denied|cannot pick|blocked by customs)\b|\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b.{0,160}\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b|\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b.{0,160}\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b|\barriv(?:e|ed)\s+i\.?t\.?\s+to\s+port\b/i.test(
    String(text || ""),
  );
}

function customsRecordHasExplicitHold(record = {}) {
  return hasExplicitCustomsHoldText(customsRecordEvidenceSegments(record).join(" "));
}

function customsRecordIsResolved(record = {}) {
  const text = customsRecordEvidenceSegments(record).join(" ");
  if (customsRecordHasExplicitHold(record)) return false;
  return /\b(?:customs[-\s]?(?:released|cleared)|released[-\s]?do|release[-\s]?do|do[-\s]?received|98[-\s]?released|release[-\s]?instructions[-\s]?attached|customs-release-attachment-received|customs-released-do-received|customs-cleared-do-received)\b/i.test(text);
}

function customsTruthFromRecord(record = {}, snapshotTime = "") {
  const key = normalizeAwb(record.awb || record.mawb);
  if (!key) return null;
  const explicitHold = customsRecordHasExplicitHold(record);
  const resolved = customsRecordIsResolved(record);
  if (!explicitHold && !resolved) return null;
  const evidence = (record.evidence || []).slice(0, 5).map((item) => ({
    type: explicitHold ? "customs-hold" : "customs-release",
    at: item.at || item.updatedAt || snapshotTime || "",
    from: record.broker || item.from || "customs-broker-snapshot",
    subject: item.subject || "",
    threadId: item.threadId || "",
    messageId: item.messageId || "",
    summary: compact(item.note || item.summary || item.evidence || item.label || record.releaseProof || record.status || "", 260),
  }));
  const summary = compact(
    record.releaseProof ||
      evidence[0]?.summary ||
      record.nextAction ||
      record.status ||
      (explicitHold ? "Customs/inbond is blocking pickup." : "Customs release/DO is confirmed."),
    260,
  );
  return {
    awb: displayAwb(key),
    normalizedAwb: key,
    source: "customs-broker-snapshot",
    phase: explicitHold ? "customs-hold" : "released",
    nextAction: explicitHold
      ? record.nextAction || "Resolve the customs/inbond rejection before dispatching pickup."
      : record.nextAction || "Confirm pickup broker/recovery plan.",
    latestEventAt: evidence[0]?.at || snapshotTime || "",
    summary,
    evidence,
    gates: {
      customs: {
        status: explicitHold ? "blocked" : "released",
      },
    },
    exceptionCount: explicitHold ? 1 : 0,
    attachmentAuditCount: 0,
  };
}

function shipmentEvidenceRows(shipment = {}) {
  const facts = [
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
    ...(shipment.emailValidation?.proof || []),
  ];
  const rows = facts
    .map((fact) => ({
      type: fact.type || fact.label || "memory",
      at: fact.at || fact.date || shipment.lastEmail?.at || "",
      from: fact.from || fact.source || "",
      subject: fact.subject || "",
      threadId: fact.threadId || "",
      messageId: fact.messageId || "",
      summary: compact(fact.summary || fact.note || fact.evidence || fact.label || "", 260),
    }))
    .filter((fact) => fact.summary || fact.type);
  if (shipment.lastEmail?.summary) {
    rows.push({
      type: "last-email",
      at: shipment.lastEmail.at || "",
      from: shipment.lastEmail.source || "",
      subject: "",
      threadId: shipment.lastEmail.threadId || "",
      messageId: shipment.lastEmail.messageId || "",
      summary: compact(shipment.lastEmail.summary, 260),
    });
  }
  return rows;
}

function truthFromShipmentMemory(shipment = {}) {
  const awb = shipment.awb || shipment.id || "";
  if (!normalizeAwb(awb)) return null;
  const evidence = shipmentEvidenceRows(shipment);
  const canonicalPhase = normalizedPhase(shipment.opsState?.phase || "");
  const customsGate = shipment.opsState?.gates?.customs || shipment.gates?.customs || {};
  const customsStatus = normalizedPhase(customsGate.status || "");
  if (canonicalPhase === "customs-hold" || ["blocked", "customs-hold", "hold", "exam-hold"].includes(customsStatus)) {
    const customsEvidence = [
      customsGate.evidence,
      customsGate.summary,
      ...(shipment.opsState?.exceptions || []).map((item) => factRowText(item)),
      ...evidence.map((item) => `${item.type} ${item.summary}`),
    ].filter(Boolean).join(" ");
    return {
      awb: displayAwb(awb),
      normalizedAwb: normalizeAwb(awb),
      source: shipment._mergeSource === "truth-packet" ? "shipment-truth-packet" : "brain-thread-memory",
      phase: "customs-hold",
      nextAction: shipment.opsState?.nextAction || shipment.nextAction || "Monitor the customs broker thread; do not dispatch pickup until release/DO is visible.",
      latestEventAt: shipment.opsState?.gates?.customs?.at || shipment.lastEmail?.at || evidence[0]?.at || "",
      summary: compact(customsEvidence || shipment.currentState || shipment.opsState?.summary || "Customs/government hold is active.", 260),
      evidence: evidence.slice(0, 8),
      gates: shipment.opsState?.gates || {},
      exceptionCount: shipment.opsState?.exceptions?.length || 0,
      attachmentAuditCount: 0,
    };
  }
  const text = [
    shipment.currentState,
    shipment.nextAction,
    shipment.stage,
    shipment.pickupStatus,
    shipment.pod?.status,
    shipment.podStatus,
    shipment.closeoutStatus,
    shipment.completion?.podStatus,
    shipment.completion?.closeoutStatus,
    shipment.freightBroker?.status,
    shipment.freightStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.brokerStatus,
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...evidence.map((item) => `${item.type} ${item.summary}`),
  ].join(" ");
  let phase = "unknown";
  let nextAction = shipment.nextAction || "";
  const podNotDelivered = /^(?:not-delivered|not delivered|missing|pending|none|no)$/i.test(String(shipment.pod?.status || shipment.podStatus || ""));
  const pickupProofNegative = /\b(?:not picked up|pickup is not proven|pickup proof is still open|pickup\/delivery proof is still open|wait for actual pickup proof|do not mark picked up yet|pickup remains blocked|not complete|pickup pending|pickup scheduled|scheduled pickup|delivery scheduled|scheduled delivery|planned pickup|planned delivery|will deliver|delivery tomorrow)\b/i.test(text);
  const deliveryProofNegative = podNotDelivered || /\b(?:not delivered|no delivery proof|delivery proof is still open|pickup\/delivery proof is still open|pod pending|pod missing|proof of delivery pending|wait for actual delivery proof|delivery scheduled|scheduled delivery|planned delivery|will deliver|delivery tomorrow)\b/i.test(text);
  const deliveredEvidence =
    !deliveryProofNegative &&
    (/\b(?:delivered to|delivery completed|completed delivery|was delivered|has been delivered|freight delivered)\b/i.test(text) ||
      shipment.pickupStatus === "delivered");
  const podPendingEvidence =
    /\b(?:signed[-\s]?pod[-\s]?pending|pod pending|pod is pending|pod missing|proof of delivery pending|delivery proof missing)\b/i.test(text);
  if (/\b(?:pod[-\s]?(?:found|received|attached|done)|proof of delivery (?:attached|received)|delivered-pod-received|delivered-pod-found|freight-delivered-pod-found)\b/i.test(text)) {
    phase = "pod-received";
    nextAction = "No POD request; close out only if TMS still needs POD.";
  } else if (deliveredEvidence && podPendingEvidence) {
    phase = "delivered-pod-pending";
    nextAction = "Collect the signed POD/proof of delivery.";
  } else if (deliveredEvidence) {
    phase = "delivered";
    nextAction = "Verify POD status before closing the shipment.";
  } else if (!pickupProofNegative && /\b(?:picked up|pickup confirmed|recovered|loaded and rolling|airport picked up)\b/i.test(text)) {
    phase = "picked-up";
    nextAction = "Track final delivery and collect POD.";
  } else if (/\b(?:driver onsite|carrier onsite|checking in|on site for pickup)\b/i.test(text)) {
    phase = "pickup-onsite";
    nextAction = "Monitor pickup, capture blockers/detention, then collect pickup proof.";
  }
  if (phase === "unknown") return null;
  return {
    awb: displayAwb(awb),
    normalizedAwb: normalizeAwb(awb),
    source: shipment.completed ? "brain-completed-thread-memory" : "brain-thread-memory",
    phase,
    nextAction,
    latestEventAt: shipment.lastEmail?.at || evidence[0]?.at || shipment.pod?.deliveredAt || shipment.eta || "",
    summary: shipment.currentState || shipment.lastEmail?.summary || evidence[0]?.summary || "",
    evidence: evidence.slice(0, 8),
    gates: {},
    exceptionCount: 0,
    attachmentAuditCount: 0,
  };
}

function truthPhaseRank(phase) {
  return {
    unknown: 0,
    "pre-arrival": 1,
    arrived: 2,
    released: 3,
    "customs-hold": 3,
    "release-needed": 3,
    "broker-release-pending": 3,
    "inbond-rejected": 3,
    "storage-or-detention-cost": 3,
    "pickup-docs-needed": 3,
    "awb-copy-needed": 3,
    "unclassified-operational-exception": 2,
    "pickup-scheduled": 4,
    "pickup-onsite": 5,
    "driver-onsite": 5,
    "driver-waiting": 5,
    "pickup-blocked": 6,
    "station-cargo-not-found": 6,
    "loading-blocked": 6,
    "loading-problem": 6,
    "delivery-blocked": 6,
    "picked-up": 7,
    "out-for-delivery": 8,
    delivered: 9,
    "delivered-pod-pending": 9,
    "pod-received": 10,
  }[normalizedPhase(phase)] || 0;
}

function blockingTruthPhase(phase) {
  return [
    "customs-hold",
    "release-needed",
    "broker-release-pending",
    "inbond-rejected",
    "pickup-docs-needed",
    "awb-copy-needed",
    "pickup-onsite",
    "driver-onsite",
    "driver-waiting",
    "pickup-blocked",
    "station-cargo-not-found",
    "loading-blocked",
    "loading-problem",
    "delivery-blocked",
    "storage-or-detention-cost",
  ].includes(normalizedPhase(phase));
}

function terminalTruthPhase(phase) {
  return [
    "picked-up",
    "out-for-delivery",
    "delivered",
    "delivered-pod-pending",
    "pod-received",
  ].includes(normalizedPhase(phase));
}

function shouldUseMemoryTruth(existing, incoming) {
  if (!incoming) return false;
  if (/^brain-(?:completed-)?thread-memory$/i.test(String(incoming.source || ""))) {
    return !existing || normalizedPhase(existing.phase) === "unknown";
  }
  if (!existing) return true;
  if (normalizedPhase(existing.phase) === "unknown") return true;
  if (blockingTruthPhase(incoming.phase) && !terminalTruthPhase(existing.phase)) return true;
  if (blockingTruthPhase(existing.phase) && !terminalTruthPhase(incoming.phase)) return false;
  return truthPhaseRank(incoming.phase) > truthPhaseRank(existing.phase);
}

function snapshotAgeMinutes(snapshotTime, now = new Date()) {
  const parsed = Date.parse(snapshotTime || "");
  if (!Number.isFinite(parsed)) return Infinity;
  return Math.max(0, (now.getTime() - parsed) / 60000);
}

function fileFreshness(fileName, now = new Date()) {
  const absolutePath = path.join(ROOT_DIR, fileName);
  try {
    const stat = fs.statSync(absolutePath);
    return {
      fileName,
      exists: true,
      mtime: stat.mtime.toISOString(),
      ageMinutes: Math.max(0, (now.getTime() - stat.mtime.getTime()) / 60000),
    };
  } catch {
    return {
      fileName,
      exists: false,
      mtime: "",
      ageMinutes: Infinity,
    };
  }
}

function sourceFreshnessRow(name, snapshotTime, maxAgeMinutes, now = new Date(), fileName = "") {
  const snapshotAge = snapshotAgeMinutes(snapshotTime, now);
  const file = fileName ? fileFreshness(fileName, now) : null;
  const bestAge = Number.isFinite(snapshotAge)
    ? snapshotAge
    : file?.exists && Number.isFinite(file.ageMinutes)
      ? file.ageMinutes
      : Infinity;
  return {
    name,
    snapshotTime: snapshotTime || "",
    fileName: file?.fileName || "",
    fileMtime: file?.mtime || "",
    ageMinutes: Number.isFinite(bestAge) ? Math.round(bestAge) : null,
    snapshotAgeMinutes: Number.isFinite(snapshotAge) ? Math.round(snapshotAge) : null,
    fileAgeMinutes: file?.exists && Number.isFinite(file.ageMinutes) ? Math.round(file.ageMinutes) : null,
    fresh: Number.isFinite(bestAge) && bestAge <= maxAgeMinutes,
  };
}

function buildSourceFreshness({ memory, gmail, tms, maxAgeMinutes, now = new Date() }) {
  const activeRows = activeTruthPacketRows(memory);
  const tmsOrders = Array.isArray(tms?.orders) ? tms.orders.map((order) => String(order || "").trim()).filter(Boolean) : [];
  const activeOrders = activeRows.map(shipmentOrderId).filter(Boolean);
  const tmsOrderSet = new Set(tmsOrders);
  const activeOrderSet = new Set(activeOrders);
  const liveMissingFromActive = tmsOrders.filter((order) => !activeOrderSet.has(order));
  const activeMissingFromLive = tmsOrders.length
    ? activeOrders.filter((order) => !tmsOrderSet.has(order))
    : [];
  const rows = [
    sourceFreshnessRow("shipment-truth-packets", memory.truthPackets?.snapshotTime, maxAgeMinutes, now, "shipment-truth-packets.json"),
    sourceFreshnessRow("tms-detail-snapshot", readJsonIfExists("tms-detail-snapshot.json", {})?.snapshotTime, maxAgeMinutes, now, "tms-detail-snapshot.json"),
    sourceFreshnessRow("tms-grid-snapshot", readJsonIfExists("tms-grid-snapshot.json", {})?.snapshotTime, maxAgeMinutes, now, "tms-grid-snapshot.json"),
    sourceFreshnessRow("gmail-proof-snapshot", memory.gmailProof?.snapshotTime || gmail.snapshotTime, maxAgeMinutes, now, "gmail-proof-snapshot.json"),
    sourceFreshnessRow("shipment-state", memory.shipmentState?.snapshotTime, maxAgeMinutes, now, "shipment-state.json"),
    sourceFreshnessRow("shipment-events", memory.shipmentEvents?.snapshotTime, maxAgeMinutes, now, "shipment-events.json"),
    sourceFreshnessRow("operator-notifications", memory.operatorNotifications?.snapshotTime, maxAgeMinutes, now, "operator-notifications.json"),
  ];
  const blockers = [];
  if (!tms?.ok) {
    blockers.push({
      source: "tms",
      command: "npm run tms:access:json",
      reason: tms?.reason || tms?.error || "TMS access probe failed",
    });
  }
  if (!gmail?.ok) {
    blockers.push({
      source: "gmail",
      command: "node scripts/shipment-truth-audit-loop.js --gmail-source=hosted-fresh",
      reason: gmail?.error || "Gmail proof audit failed",
    });
  }
  const mismatches = [];
  if (tms?.ok && Number.isFinite(Number(tms.numberOfTasks)) && activeRows.length !== Number(tms.numberOfTasks)) {
    mismatches.push({
      source: "tms-active-count",
      liveTmsCount: Number(tms.numberOfTasks),
      activeInventoryCount: activeRows.length,
      reason: `Live CourierCloud Ops Log has ${tms.numberOfTasks} active tasks, but shipment-truth-packets has ${activeRows.length}.`,
    });
  }
  if (tms?.ok && tmsOrders.length && (liveMissingFromActive.length || activeMissingFromLive.length)) {
    mismatches.push({
      source: "tms-active-orders",
      liveMissingFromActive,
      activeMissingFromLive,
      reason: "Active inventory order membership does not match the live CourierCloud Ops Log.",
    });
  }
  const stale = rows.filter((row) => !row.fresh);
  const requiredFresh = rows.filter((row) => ["shipment-truth-packets", "tms-detail-snapshot", "gmail-proof-snapshot"].includes(row.name));
  const requiredStale = requiredFresh.filter((row) => !row.fresh);
  const status = blockers.length
    ? "live-source-unavailable"
    : mismatches.length
      ? "fresh-audit-failed"
      : requiredStale.length
      ? "stale-audit-secondary"
      : "fresh-audit-passed";
  return {
    status,
    maxAgeMinutes,
    generatedAt: now.toISOString(),
    rows,
    staleSources: stale.map((row) => row.name),
    blockers,
    mismatches,
  };
}

function riskFromShipment(shipment = {}, plan = {}, truth = null, issues = []) {
  const text = [
    plan.phase,
    plan.label,
    plan.headline,
    plan.nextAction,
    shipment.risk,
    shipment.riskLevel,
    shipment.operationalRisk?.level,
    shipment.operationalRisk?.reason,
    shipment.opsState?.risk?.level,
    shipment.opsState?.risk?.reason,
    truth?.phase,
    truth?.summary,
  ].join(" ");
  let level = "normal";
  if (issues.length || /\b(customs hold|storage|exception|blocked|urgent|critical|risk|accruing|fee due|fees due|missing|overdue)\b/i.test(text)) {
    level = "high";
  } else if (/\b(waiting|pending|release|do|pickup|scheduled|arrived)\b/i.test(text)) {
    level = "medium";
  }
  return {
    level,
    reason: compact(shipment.operationalRisk?.reason || shipment.opsState?.risk?.reason || plan.headline || plan.label || truth?.summary || "", 220),
  };
}

function collectWorkgroupHints({ shipment = {}, truth = null, proof = null, serverAnswers = [], browserAnswers = [] }) {
  const evidence = [
    ...(truth?.evidence || []),
    ...(proof?.events || []),
    ...(proof?.proof || []),
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
    ...(shipment.operatorNotes || []),
  ];
  const relatedAwbs = unique([
    ...(shipment.relatedAwbs || []),
    ...(shipment.workgroupAwbs || []),
    ...evidence.flatMap((item) => item.relatedAwbs || item.awbs || []),
    ...serverAnswers.flatMap((entry) => (entry.answer.items || []).map((item) => item.awb)),
    ...browserAnswers.flatMap((entry) => (entry.items || []).map((item) => item.awb)),
  ]).map(displayAwb);
  return {
    threadIds: unique(evidence.map((item) => item.threadId || item.gmailThreadId || item.sourceThreadId)),
    messageIds: unique(evidence.map((item) => item.messageId || item.gmailMessageId)),
    workgroupIds: unique([shipment.workgroupId, shipment.deliveryGroupId, shipment.groupId, ...(evidence.map((item) => item.workgroupId || item.groupId))]),
    relatedAwbs: relatedAwbs.filter((awb) => normalizeAwb(awb) && normalizeAwb(awb) !== normalizeAwb(shipment.awb)),
  };
}

function suggestedCommunicationAction(row = {}, boardPlan = {}, actionAuditRow = null) {
  const action = (boardPlan.actionsReady || [])[0]
    || (row.serverAnswers || []).flatMap((entry) => entry.actions || [])[0]
    || null;
  if (action) {
    return compact([
      action.label || action.id || "Action",
      action.channel ? `via ${action.channel}` : "",
      action.targetName ? `to ${action.targetName}` : "",
      action.blockedReason ? `blocked: ${action.blockedReason}` : "",
    ].filter(Boolean).join(" "), 220);
  }
  if (actionAuditRow?.brain?.nextAction) return compact(actionAuditRow.brain.nextAction, 220);
  return compact(boardPlan.nextAction || row.truth?.nextAction || row.current?.nextAction || "No action", 220);
}

function buildInventoryRow({ row, shipment, proof, boardPlan, actionAuditRow }) {
  const risk = riskFromShipment(shipment, boardPlan, row.truth, row.issues || []);
  const uncertaintyReasons = [];
  if (!row.truth) uncertaintyReasons.push("missing-evidence-truth");
  if (!row.proofCoverage?.foundFreshProof && !row.proofCoverage?.foundTmsTruth) uncertaintyReasons.push("missing-fresh-proof-or-tms-truth");
  if (row.issues?.length) uncertaintyReasons.push(...row.issues.map((issue) => issue.code));
  if (String(row.current?.phase || "").includes("unknown")) uncertaintyReasons.push("unknown-canonical-phase");
  const evidence = (row.truth?.evidence || []).slice(0, 5).map((item) => ({
    type: item.type || "",
    at: item.at || item.updatedAt || "",
    from: item.from || "",
    subject: item.subject || "",
    threadId: item.threadId || "",
    messageId: item.messageId || "",
    summary: compact(item.summary || item.evidence || "", 220),
  }));
  return {
    awb: row.awb,
    normalizedAwb: row.normalizedAwb,
    shipmentId: shipment.id || shipment.shipmentId || shipment.tms?.order || "",
    tmsOrder: shipment.tms?.order || shipment.order || shipment.id || "",
    station: row.station || shipment.station || shipment.airport || "Unknown",
    carrier: row.airline || shipment.airline || shipment.carrier || "Unknown",
    consignee: row.client || shipment.client || shipment.consignee || "Unknown",
    canonicalState: row.current,
    risk,
    nextAction: compact(row.current?.nextAction || row.truth?.nextAction || "No action", 260),
    suggestedCommunicationAction: suggestedCommunicationAction(row, boardPlan, actionAuditRow),
    evidenceSource: {
      source: row.proofCoverage?.truthSource || row.truth?.source || "missing",
      latestEventAt: row.truth?.latestEventAt || proof?.latestEventAt || "",
      foundFreshProof: Boolean(row.proofCoverage?.foundFreshProof),
      foundTmsTruth: Boolean(row.proofCoverage?.foundTmsTruth),
      evidenceCount: row.proofCoverage?.evidenceCount || evidence.length,
      evidence,
    },
    uncertainty: {
      flag: uncertaintyReasons.length > 0,
      reasons: unique(uncertaintyReasons),
    },
    relatedWorkgroupHints: collectWorkgroupHints({
      shipment,
      truth: row.truth,
      proof,
      serverAnswers: row.serverAnswers,
      browserAnswers: row.browserAnswers,
    }),
    consistency: {
      passed: Boolean(row.passed),
      issueCount: row.issues?.length || 0,
      serverAnswerCount: row.serverAnswers?.length || 0,
      browserAnswerCount: row.browserAnswers?.length || 0,
      actionCriticalIssueCount: row.actionAudit?.criticalIssueCount || 0,
    },
  };
}

function inventoryAudit(inventory = [], expectedActiveAwbs = [], options = {}) {
  const byAwb = new Map();
  const byOrder = new Map();
  const malformedAwbs = [];
  const duplicates = [];
  const duplicateOrders = [];
  const missingRequired = [];
  const expected = new Set(expectedActiveAwbs.map(normalizeAwb).filter(Boolean));
  const expectedOrders = new Set((options.expectedActiveOrders || []).map((order) => String(order || "").trim()).filter(Boolean));
  const requiredFields = [
    "awb",
    "normalizedAwb",
    "station",
    "carrier",
    "consignee",
    "canonicalState",
    "risk",
    "nextAction",
    "suggestedCommunicationAction",
    "evidenceSource",
    "uncertainty",
    "relatedWorkgroupHints",
  ];
  for (const item of inventory) {
    const key = normalizeAwb(item.normalizedAwb || item.awb);
    if (!key || key.length !== 11) malformedAwbs.push(item.awb || item.normalizedAwb || "");
    if (key && byAwb.has(key)) duplicates.push(displayAwb(key));
    if (key) byAwb.set(key, item);
    const order = String(item.tmsOrder || item.shipmentId || "").trim();
    if (order) {
      if (byOrder.has(order)) duplicateOrders.push(order);
      byOrder.set(order, item);
    }
    const missing = requiredFields.filter((field) => item[field] === undefined || item[field] === null || item[field] === "");
    if (missing.length) missingRequired.push({ awb: item.awb || "", missing });
  }
  const actual = new Set([...byAwb.keys()].filter(Boolean));
  const actualOrders = new Set([...byOrder.keys()].filter(Boolean));
  const missingActiveAwbs = [...expected].filter((awb) => !actual.has(awb)).map(displayAwb);
  const extraNonActiveAwbs = expected.size
    ? [...actual].filter((awb) => !expected.has(awb)).map(displayAwb)
    : [];
  const missingLiveTmsOrders = expectedOrders.size
    ? [...expectedOrders].filter((order) => !actualOrders.has(order))
    : [];
  const extraNonLiveTmsOrders = expectedOrders.size
    ? [...actualOrders].filter((order) => !expectedOrders.has(order))
    : [];
  return {
    ok: !malformedAwbs.length && !duplicates.length && !duplicateOrders.length && !missingRequired.length && !missingActiveAwbs.length && !extraNonActiveAwbs.length && !missingLiveTmsOrders.length && !extraNonLiveTmsOrders.length,
    count: inventory.length,
    expectedActiveCount: expected.size || inventory.length,
    expectedLiveTmsOrderCount: expectedOrders.size || null,
    malformedAwbs,
    duplicates: unique(duplicates),
    duplicateOrders: unique(duplicateOrders),
    missingRequired,
    missingActiveAwbs,
    extraNonActiveAwbs,
    missingLiveTmsOrders,
    extraNonLiveTmsOrders,
  };
}

function hostedGmailProofFromMemory(memory, awbs, options, reason = "") {
  const gmailProof = memory.gmailProof || {};
  const ageMinutes = snapshotAgeMinutes(gmailProof.snapshotTime);
  const maxAgeMinutes = options.hostedProofMaxAgeMinutes;
  const writerVersion = String(gmailProof.writerVersion || "");
  if (!Array.isArray(gmailProof.proofs) || !gmailProof.proofs.length) {
    throw new Error("Hosted Gmail proof snapshot is empty; live Gmail truth cannot be established.");
  }
  if (!/^gmail-direct/i.test(writerVersion)) {
    throw new Error(`Hosted Gmail proof snapshot writer is ${writerVersion || "unknown"}, not gmail-direct.`);
  }
  if (!Number.isFinite(ageMinutes) || ageMinutes > maxAgeMinutes) {
    throw new Error(`Hosted Gmail proof snapshot is stale (${Math.round(ageMinutes)}m old, max ${maxAgeMinutes}m); fill local Gmail OAuth or refresh production first.`);
  }
  const wanted = new Set(awbs.map(normalizeAwb).filter(Boolean));
  const proofs = gmailProof.proofs.filter((proof) => !wanted.size || wanted.has(normalizeAwb(proof.awb)));
  return {
    ok: true,
    dryRun: true,
    source: "hosted-gmail-proof-snapshot",
    fallback: reason || "local-gmail-oauth-unavailable",
    snapshotTime: gmailProof.snapshotTime || "",
    writerVersion,
    snapshotAgeMinutes: Math.round(ageMinutes),
    proofs,
    updated: 0,
    threadCount: unique(proofs.flatMap((proof) => (proof.threads || []).concat((proof.events || []).map((event) => event.threadId)))).length,
    queryCount: 0,
    attachmentAuditCount: proofs.reduce((sum, proof) => sum + ((proof.gmailAttachmentAudit || proof.attachmentAudit || []).length), 0),
    shipmentEventCount: Array.isArray(memory.shipmentEvents?.events) ? memory.shipmentEvents.events.length : 0,
    shipmentStateCount: Array.isArray(memory.shipmentState?.shipments) ? memory.shipmentState.shipments.length : 0,
    operatorNotificationCount: Array.isArray(memory.operatorNotifications?.notifications) ? memory.operatorNotifications.notifications.length : 0,
    updatedAwbs: proofs.map((proof) => displayAwb(proof.awb)),
    shipmentEvents: memory.shipmentEvents,
    shipmentState: memory.shipmentState,
    operatorNotifications: memory.operatorNotifications,
  };
}

async function auditGmailProof(memory, awbs, options) {
  const cfg = gmailDirectEnv(process.env);
  if (options.gmailSource !== "hosted-fresh" && cfg.available) {
    return runDirectGmailRefresh({
      awbs,
      lookbackDays: options.lookbackDays,
      maxThreads: options.maxThreads,
      maxAttachmentPdfs: options.maxAttachmentPdfs,
      write: false,
      includeProofs: true,
    });
  }
  if (options.gmailSource === "local") {
    throw new Error("Local Gmail OAuth env is unavailable: set GMAIL_CLIENT_ID/GOOGLE_CLIENT_ID, GMAIL_CLIENT_SECRET/GOOGLE_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.");
  }
  return hostedGmailProofFromMemory(
    memory,
    awbs,
    options,
    cfg.available ? "requested-hosted-fresh" : "local-gmail-oauth-unavailable",
  );
}

function truthEvidenceText(truth = {}) {
  return [
    truth.source,
    truth.phase,
    truth.summary,
    truth.nextAction,
    ...(truth.evidence || []).map((event) => `${event.type} ${event.summary}`),
  ].join(" ");
}

function operatorSafeEvidenceText(value) {
  return String(value || "")
    .replace(/\bCarrier page loaded\b/gi, "Carrier tracking page opened")
    .replace(/\bUnited Cargo page loaded\b/gi, "United Cargo tracking page opened");
}

function tmsStatusCode(detail = {}) {
  const match = String(detail?.tmsStatus || detail?.status || "").match(/\b(\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

function hasTmsDeliveryActual(detail = {}) {
  return Boolean(
    String(detail?.deliveryActualArrivalDate || "").trim() ||
      String(detail?.deliveryActualArrivalTime || "").trim(),
  );
}

function hasTmsCompletionEvidence(detail = {}) {
  return tmsStatusCode(detail) >= 380 ||
    hasTmsDeliveryActual(detail) ||
    Boolean(String(detail?.podSignature || "").trim());
}

function tmsTruthFromDetail(detail = {}, tracking = null, snapshotTime = "") {
  const awb = detail.trackingNumber || detail.awb || "";
  if (!normalizeAwb(awb)) return null;
  const status = `${detail.tmsStatus || ""} ${detail.status || ""}`.trim();
  const nextTask = detail.nextTask || "";
  const trackingStatus = `${tracking?.status || ""} ${tracking?.summaryStatus || ""} ${tracking?.summaryCode || ""}`.trim();
  const text = `${status} ${nextTask} ${trackingStatus}`;
  let phase = "unknown";
  let nextAction = "Verify latest email thread and update the next operational action.";
  if (hasTmsCompletionEvidence(detail) || /\b(?:POD|DLV|DELIVERED)\b/i.test(text)) {
    phase = detail.podSignature || hasTmsDeliveryActual(detail) ? "delivered" : "delivered-pod-pending";
    nextAction = phase === "delivered"
      ? "No action; direct TMS delivery/POD evidence closes this shipment."
      : "Collect/verify POD unless POD proof is already attached.";
  } else {
    return null;
  }
  const summaryParts = [
    status ? `TMS ${status}` : "",
    detail.podSignature ? `POD signed by ${detail.podSignature}` : "",
    [detail.deliveryActualArrivalDate, detail.deliveryActualArrivalTime].filter(Boolean).length
      ? `delivery actual ${[detail.deliveryActualArrivalDate, detail.deliveryActualArrivalTime].filter(Boolean).join(" ")}`
      : "",
    nextTask ? `next ${nextTask}` : "",
    tracking?.ok ? `tracking ${tracking.status || tracking.summaryStatus || "ok"}` : tracking?.error ? `tracking unavailable: ${operatorSafeEvidenceText(tracking.error)}` : "",
  ].filter(Boolean);
  return {
    awb: displayAwb(awb),
    normalizedAwb: normalizeAwb(awb),
    source: tracking?.ok ? "tms-detail+carrier-tracking" : "tms-detail",
    phase,
    nextAction,
    latestEventAt: snapshotTime || detail.snapshotTime || "",
    summary: summaryParts.join("; "),
    evidence: [
      {
        type: "tms-detail",
        at: snapshotTime || detail.snapshotTime || "",
        from: "CourierCloud",
        subject: detail.order || "",
        threadId: "",
        messageId: "",
        summary: compact(summaryParts.join("; "), 260),
      },
    ],
    gates: {},
    exceptionCount: 0,
    attachmentAuditCount: 0,
  };
}

function loadTmsTruths() {
  const detailSnapshot = readJsonIfExists("tms-detail-snapshot.json", { shipments: [] });
  const trackingSnapshots = [
    readJsonIfExists("united-tracking-snapshot.json", { tracking: [] }),
    readJsonIfExists("elal-tracking-snapshot.json", { tracking: [] }),
    readJsonIfExists("other-tracking-snapshot.json", { tracking: [] }),
  ];
  const trackingByAwb = new Map();
  for (const snapshot of trackingSnapshots) {
    for (const record of snapshot?.tracking || []) {
      const key = normalizeAwb(record.awb);
      if (!key) continue;
      trackingByAwb.set(key, record);
    }
  }
  const rows = [];
  for (const detail of detailSnapshot?.shipments || []) {
    const key = normalizeAwb(detail.trackingNumber || detail.awb);
    if (!key) continue;
    const truth = tmsTruthFromDetail(detail, trackingByAwb.get(key), detailSnapshot.snapshotTime);
    if (truth) rows.push(truth);
  }
  return rows;
}

function loadCustomsTruths() {
  const snapshot = readJsonIfExists("customs-broker-snapshot.json", { brokers: [] });
  return (snapshot.brokers || [])
    .map((record) => customsTruthFromRecord(record, snapshot.snapshotTime || ""))
    .filter(Boolean);
}

function shouldUseCustomsTruth(existing, incoming) {
  if (!incoming) return false;
  if (!existing) return true;
  const existingPhase = normalizedPhase(existing.phase);
  if (normalizedPhase(incoming.phase) === "customs-hold") {
    return ["unknown", "pre-arrival", "arrived", "released", "customs-hold"].includes(existingPhase);
  }
  return shouldUseMemoryTruth(existing, incoming);
}

function answerText(answer = {}) {
  return compact([
    answer.title,
    answer.subtitle,
    answer.answer,
    answer.nextAction,
    answer.plan?.phase,
    answer.plan?.label,
    answer.plan?.headline,
    answer.plan?.nextAction,
    ...(answer.facts || []),
    ...(answer.items || []).map((item) => `${item.awb || ""} ${item.title || ""} ${item.action || ""}`),
    ...(answer.actions || []).map((action) => `${action.label || ""} ${action.targetName || ""} ${action.blockedReason || ""}`),
  ].join(" "), 6000);
}

function answerCurrentText(answer = {}) {
  return [
    answer.title,
    answer.subtitle,
    answer.answer,
    answer.nextAction,
    answer.plan?.phase,
    answer.plan?.label,
    answer.plan?.headline,
    answer.plan?.nextAction,
  ].join(" ");
}

function browserAnswerText(answer = {}) {
  return compact([
    answer.title,
    answer.subtitle,
    answer.content,
    answer.text,
    answer.nextAction,
    ...(answer.items || []).map((item) => `${item.awb || ""} ${item.title || ""} ${item.action || ""}`),
    ...(answer.actions || []).map((action) => `${action.label || ""} ${action.targetName || ""} ${action.blockedReason || ""}`),
  ].join(" "), 6000);
}

function openQuestionAnswerText(answer = {}, layer = "") {
  if (layer === "ui-rendering") {
    return [
      answer.title,
      answer.subtitle,
      answer.content,
      answer.text,
      answer.nextAction,
    ].join(" ");
  }
  return answerCurrentText(answer.answer || answer);
}

function stationDetailSignature(text) {
  const value = String(text || "");
  const stationName = value.match(/\bStation:\s*([^\n.]+?)(?:\s+Email:|\s+Phone:|$)/i)?.[1]
    || value.match(/\bStation:\s*([^\n.]+)/i)?.[1]
    || "";
  const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = value.match(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/)?.[0] || "";
  const normalize = (item) => String(item || "")
    .toLowerCase()
    .replace(/\b(?:email|phone|not confirmed|not in memory|unknown)\b/g, "")
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    stationName: normalize(stationName),
    email: normalize(email),
    phone: phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""),
  };
}

function answerLooksRegressedToMissing(text) {
  const value = String(text || "");
  if (/\b(?:Arrived|Customs:\s*released|Release\/DO confirmed|POD found|POD received|Delivered|Picked up)\b/i.test(value)) return false;
  return /\b(?:No direct hit|I do not see a matching active shipment|no matching active shipment|no open shipment|verify shipment id)\b/i.test(value);
}

function openQuestionsForAwb(awb) {
  const display = displayAwb(awb);
  return [
    `was ${display} picked up?`,
    `is ${display} released?`,
    `what station is ${display} in?`,
    `can I have the station details for ${display}?`,
    `what exactly is the problem with ${display}?`,
    `what did you see that caused the problem on ${display}?`,
  ];
}

function questionsForAwb(awb, options = {}) {
  const base = [
    `what about ${displayAwb(awb)}?`,
    `what needs action on ${displayAwb(awb)}?`,
  ];
  return options.deepQuestions ? [...base, ...openQuestionsForAwb(awb)] : base;
}

function browserQuestionsForAwbs(awbs = [], options = {}) {
  const baseQuestions = awbs.flatMap((awb) => questionsForAwb(awb, { ...options, deepQuestions: false }));
  if (!options.deepQuestions) return baseQuestions;
  const maxDeepAwbs = Math.max(1, Number(process.env.PIKIIO_AUDIT_BROWSER_DEEP_AWBS || 8) || 8);
  const deepQuestions = awbs
    .slice(0, maxDeepAwbs)
    .flatMap((awb) => openQuestionsForAwb(awb));
  return [...baseQuestions, ...deepQuestions];
}

function openQuestionKind(question) {
  const text = String(question || "").toLowerCase();
  if (/picked up|pickup|recovered|loaded/.test(text)) return "pickup";
  if (/released|release|clearance|customs|d\/?o|delivery order/.test(text)) return "release";
  if (/station details|station contact|station phone|station email/.test(text)) return "station-details";
  if (/\bstation\b|where/.test(text)) return "station";
  if (/what did you see|caused|cause|why|evidence|proof/.test(text)) return "evidence";
  if (/problem|wrong|issue|blocker/.test(text)) return "problem";
  return "";
}

function textHasPickupDone(text) {
  return /\b(?:picked\s*up|pickup complete|recovered|driver (?:is )?(?:now )?loaded|loaded and (?:will|is|en route|rolling))\b/i.test(text);
}

function textHasPickupNotDone(text) {
  return /\b(?:not picked up|pickup (?:is )?not (?:complete|proven)|physical pickup is not proven|do not treat pickup as complete|not loaded|scheduled|onsite|on site|waiting|driver waiting|pickup pending)\b/i.test(text);
}

function textHasReleaseDone(text) {
  const value = String(text || "");
  if (textHasReleaseMissing(value)) return false;
  return /\b(?:release\/?d\.?o (?:is )?confirmed|release\/?do (?:is )?confirmed|customs:?\s*released|customs released|customs cleared|release confirmed|released|cleared|1c\s+(?:posted|confirmed|entered)|d\/?o (?:attached|issued|confirmed)|delivery order (?:attached|issued|confirmed))\b/i.test(value);
}

function textHasReleaseMissing(text) {
  return /\b(?:not released|not cleared|not confirmed yet|release (?:is )?(?:not confirmed|missing|pending|needed)|no release|without release|customs pending|clearance pending|d\/?o (?:missing|pending|needed|not confirmed)|delivery order (?:missing|pending|needed|not confirmed))\b/i.test(text);
}

function textHasEvidence(text) {
  return /\b(?:because|saw|email|thread|gmail|tms|proof|evidence|confirmed|reported|sent|arrival|release|pickup|storage|pod|station|customs|notice|loaded|onsite)\b/i.test(text);
}

function truthPickupState(truth = {}, canonical = {}) {
  const status = String(truth.gates?.pickup?.status || "").toLowerCase();
  const phase = normalizedPhase(truth.phase);
  if (["done", "picked-up", "loaded", "recovered", "inferred"].includes(status) || ["picked-up", "delivered", "delivered-pod-pending", "pod-received"].includes(phase) || canonical.gates?.pickedUp) return "done";
  if (["scheduled", "planned", "deferred"].includes(status) || phase === "pickup-scheduled" || canonical.gates?.pickupScheduled) return "scheduled";
  if (["driver-onsite", "onsite"].includes(status) || phase === "pickup-onsite" || normalizedPhase(canonical.phase) === "driver-onsite") return "onsite";
  return "not-done";
}

function truthReleaseState(truth = {}, canonical = {}) {
  const status = String(truth.gates?.customs?.status || "").toLowerCase();
  const phase = normalizedPhase(truth.phase);
  if (["blocked", "customs-hold", "hold", "exam-hold"].includes(status) || canonical.gates?.customHold || phase === "customs-hold") return "blocked";
  if (["done", "released", "cleared"].includes(status) || canonical.gates?.customsBrokerRelease || ["released", "pickup-scheduled", "pickup-onsite", "picked-up", "delivered", "delivered-pod-pending", "pod-received"].includes(phase)) return "released";
  return "missing";
}

function validateOpenQuestionAnswer({ answer, truth, canonical, shipment, layer }) {
  const issues = [];
  const question = answer.question || "";
  const kind = openQuestionKind(question);
  if (!kind) return issues;
  const text = openQuestionAnswerText(answer, layer);
  const compactText = compact(text, 220);
  const add = (code, message) => issues.push({ layer, code, message, question, text: compactText });
  if (!String(text || "").trim() || answerLooksRegressedToMissing(text) || /\bWhich AWB\b/i.test(text)) {
    add("open-question-useless-answer", `${question} did not produce a usable shipment answer.`);
    return issues;
  }

  if (kind === "pickup") {
    const pickupState = truthPickupState(truth, canonical);
    const saysNotDone = textHasPickupNotDone(text);
    const saysDone = textHasPickupDone(text) && !saysNotDone;
    if (pickupState === "done" && saysNotDone) {
      add("open-question-pickup-understated", `${question} says pickup is not complete, but truth/current state says pickup is complete.`);
    }
    if (pickupState !== "done" && saysDone && !saysNotDone) {
      add("open-question-pickup-overstated", `${question} says pickup is complete, but truth/current state is ${pickupState}.`);
    }
  }

  if (kind === "release") {
    const releaseState = truthReleaseState(truth, canonical);
    const missingEvidence = textHasReleaseMissing(text);
    const positiveEvidence = textHasReleaseDone(text) && !missingEvidence;
    const saysReleased = positiveEvidence && !missingEvidence;
    const saysMissing = missingEvidence && !saysReleased;
    if (releaseState === "released" && saysMissing) {
      add("open-question-release-understated", `${question} says release/DO is missing, but truth/current state says release is done.`);
    }
    if (releaseState !== "released" && saysReleased && !saysMissing) {
      add("open-question-release-overstated", `${question} says release/DO is done, but truth/current state is ${releaseState}.`);
    }
  }

  if (kind === "station" || kind === "station-details") {
    const station = String(shipment?.station || shipment?.airport || "").trim();
    const stationContact = [
      shipment?.opsState?.metadata?.stationContact?.name,
      shipment?.stationContact?.name,
      shipment?.contacts?.station?.handlerName,
      shipment?.contacts?.station?.stationName,
    ].filter(Boolean).join(" ");
    const stationText = `${station} ${stationContact}`.trim();
    if (station && !new RegExp(`\\b${station.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text) && (!stationContact || !text.toLowerCase().includes(stationContact.toLowerCase().slice(0, 8)))) {
      add("open-question-station-missing", `${question} did not name the expected station ${stationText || station}.`);
    }
    if (!stationDetailSignature(text).stationName) {
      add("open-question-station-detail-missing", `${question} did not render an explicit station handler/contact answer.`);
    }
    if (kind === "station-details" && !/\b(?:@|email|phone|call|\d{3}[-). ]?\d{3}[-. ]?\d{4}|station details|contact)\b/i.test(text)) {
      add("open-question-station-details-thin", `${question} did not provide station contact/detail wording.`);
    }
  }

  if ((kind === "problem" || kind === "evidence") && !textHasEvidence(text)) {
    add("open-question-no-evidence", `${question} did not explain the evidence/source behind the state.`);
  }

  return issues;
}

function normalizedPhase(value) {
  return String(value || "").toLowerCase().replace(/_/g, "-").trim();
}

function phaseIsStaleBeforeArrival(phase) {
  return /^(?:pre-arrival|arrival-unverified|not-arrived|unknown|missing)$/.test(normalizedPhase(phase));
}

function truthRequiresArrivalOrBeyond(phase) {
  return [
    "arrived",
    "pickup-scheduled",
    "pickup-onsite",
    "driver-onsite",
    "pickup-blocked",
    "loading-blocked",
    "picked-up",
    "out-for-delivery",
    "delivered",
    "delivered-pod-pending",
    "pod-received",
  ].includes(normalizedPhase(phase));
}

function truthCompatibleWithCurrentPhase(truthPhase, currentPhase) {
  const truth = normalizedPhase(truthPhase);
  const current = normalizedPhase(currentPhase);
  if (!truth || truth === "unknown") return true;
  if (truthRequiresArrivalOrBeyond(truth) && phaseIsStaleBeforeArrival(current)) return false;
  if (truth === "released") {
    return !["customs-hold", "release-needed"].includes(current);
  }
  if (blockingTruthPhase(truth)) {
    if (truth === "customs-hold") return ["customs-hold", "release-needed"].includes(current);
    if (truth === "pickup-docs-needed" || truth === "awb-copy-needed") return ["pickup-docs-needed", "awb-copy-needed", "dispatch-ready"].includes(current);
    if (truth === "pickup-onsite" || truth === "driver-onsite") return ["driver-onsite", "pickup-onsite"].includes(current);
    if (truth === "pickup-blocked" || truth === "station-cargo-not-found") return ["pickup-blocked", "station-cargo-not-found"].includes(current);
    if (truth === "loading-blocked" || truth === "loading-problem") return ["loading-blocked", "pickup-blocked"].includes(current);
    if (truth === "delivery-blocked") return ["delivery-blocked", "out-for-delivery", "delivered-pod-pending"].includes(current);
  }
  if (truth === "pickup-scheduled") {
    return ["pickup-scheduled", "driver-onsite", "pod-needed", "out-for-delivery", "delivered-pod-pending", "delivered"].includes(current);
  }
  if (truth === "pickup-onsite") {
    return ["driver-onsite", "pod-needed", "out-for-delivery", "delivered-pod-pending", "delivered"].includes(current);
  }
  if (truth === "picked-up") {
    return ["pod-needed", "out-for-delivery", "delivered-pod-pending", "delivered"].includes(current);
  }
  if (truth === "out-for-delivery") {
    return ["out-for-delivery", "delivered-pod-pending", "delivered"].includes(current);
  }
  if (truth === "delivered-pod-pending") {
    return ["delivered-pod-pending", "delivered"].includes(current);
  }
  if (truth === "pod-received") {
    return current === "delivered";
  }
  return true;
}

function canonicalSummary(shipment, plan) {
  const gates = gateState(shipment);
  return {
    phase: plan?.phase || "",
    label: plan?.label || "",
    nextAction: plan?.nextAction || "",
    gates: {
      arrived: Boolean(gates.arrived),
      pickedUp: Boolean(gates.pickedUp),
      pickupScheduled: Boolean(gates.pickupScheduled),
      deliveryReported: Boolean(gates.deliveryReported),
      podReceived: Boolean(gates.podReceived),
      podPending: Boolean(gates.podPending),
      customsBrokerRelease: Boolean(gates.customsBrokerRelease),
      customHold: Boolean(gates.customsHold),
    },
  };
}

function shipmentGateValue(shipment = {}, name = "") {
  return shipment.opsState?.gates?.[name] || shipment.gates?.[name] || {};
}

function gateStatusText(shipment = {}, name = "") {
  return String(shipmentGateValue(shipment, name).status || "").toLowerCase();
}

function cleanDispatchOwnerName(value) {
  const name = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .replace(/^(?:done|sent|broker[-\s]?awarded|awarded|dispatched)\s+/i, "")
    .replace(/\b(?:broker|carrier|dispatch|pickup|quote|rate|status request)\b$/i, "")
    .trim();
  if (!name || /^(?:broker|carrier|pickup broker|dispatch|unknown|not found)$/i.test(name)) return "";
  return name;
}

function dispatchOwnerFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const patterns = [
    /\b([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+(?:was\s+)?(?:approved|awarded|selected|confirmed)\s+for\s+pickup\b/i,
    /\b(?:approved|awarded|selected|confirmed)\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+for\s+pickup\b/i,
    /\b(?:pickup|recovery)\s+(?:with|to|by)\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)(?:\s+(?:at|for|on)\b|[.;,]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const owner = cleanDispatchOwnerName(match?.[1]);
    if (owner) return owner;
  }
  return "";
}

function shipmentFactRows(shipment = {}) {
  return [
    ...(Array.isArray(shipment.facts) ? shipment.facts : []),
    ...(Array.isArray(shipment.factLedger) ? shipment.factLedger : []),
    ...(Array.isArray(shipment.opsState?.events) ? shipment.opsState.events : []),
    ...(Array.isArray(shipment.emailValidation?.events) ? shipment.emailValidation.events : []),
    ...(Array.isArray(shipment.emailValidation?.proof) ? shipment.emailValidation.proof : []),
  ];
}

function dispatchOwnerFromShipment(shipment = {}) {
  const dispatch = shipmentGateValue(shipment, "dispatch");
  const direct = cleanDispatchOwnerName(dispatch.broker || dispatch.selectedBroker || dispatch.pickupOwner || "") ||
    dispatchOwnerFromText(`${dispatch.evidence || ""} ${dispatch.summary || ""}`);
  if (direct) return direct;
  return shipmentFactRows(shipment)
    .map((fact) => {
      const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
      if (!/\b(?:broker[-_ ]?awarded|pickup[-_ ]?broker[-_ ]?awarded|dispatch)\b/i.test(text)) return "";
      return cleanDispatchOwnerName(fact.broker || fact.selectedBroker || "") || dispatchOwnerFromText(text);
    })
    .find(Boolean) || "";
}

function publicPickupOwnerName(shipment = {}) {
  const freight = shipment.freightBroker || {};
  return cleanDispatchOwnerName(freight.broker || freight.contactName || freight.contactEmail || "");
}

function boardActionText(boardPlan = {}) {
  return [
    boardPlan.phase,
    boardPlan.label,
    boardPlan.headline,
    boardPlan.nextAction,
    ...(boardPlan.actionsReady || []).map((action) => `${action.label || ""} ${action.type || ""} ${action.reason || ""} ${action.problem || ""} ${action.nextAction || ""}`),
  ].filter(Boolean).join(" ");
}

function semanticProjectionIssues({ shipment, boardPlan, boardText }) {
  const issues = [];
  const dispatchStatus = gateStatusText(shipment, "dispatch");
  if (!["done", "broker-awarded", "awarded", "sent", "dispatched"].includes(dispatchStatus)) return issues;
  const owner = dispatchOwnerFromShipment(shipment);
  if (!owner) return issues;
  const visibleOwner = publicPickupOwnerName(shipment);
  if (!visibleOwner) {
    issues.push({
      layer: "canonical-state-promotion",
      code: "dispatch-owner-not-promoted",
      message: `Dispatch gate proves ${owner} owns pickup, but public shipment truth has no freight/pickup owner.`,
      owner,
    });
  }
  const text = `${boardText || ""} ${boardActionText(boardPlan)}`;
  if (/\b(?:confirm pickup broker\/dispatch path|pickup owner is missing|confirm who owns pickup|no pickup broker\/dispatch owner)\b/i.test(text)) {
    issues.push({
      layer: "action-generation",
      code: "dispatch-owner-action-regressed-to-owner-discovery",
      message: `Dispatch gate proves ${owner} owns pickup, but the visible action still asks the operator to discover the pickup owner.`,
      owner,
    });
  }
  return issues;
}

function classifyMismatches({ truth, shipment, boardPlan, actionAuditRow, serverAnswers, browserAnswers }) {
  const issues = [];
  const canonical = canonicalSummary(shipment, boardPlan);
  const combinedServerText = serverAnswers.map((entry) => answerText(entry.answer)).join(" ");
  const combinedBrowserText = browserAnswers.map(browserAnswerText).join(" ");
  const boardText = `${boardPlan?.phase || ""} ${boardPlan?.label || ""} ${boardPlan?.headline || ""} ${boardPlan?.nextAction || ""}`;

  const add = (layer, code, message, extra = {}) => issues.push({ layer, code, message, ...extra });

  for (const issue of semanticProjectionIssues({ shipment, boardPlan, boardText })) {
    add(issue.layer, issue.code, issue.message, issue);
  }

  if (!truth) {
    add("source-truth", "missing-fresh-email-proof", "No fresh Gmail proof was gathered in this audit window.");
  } else if (!truthCompatibleWithCurrentPhase(truth.phase, canonical.phase)) {
    add("canonical-state-promotion", "truth-current-phase-mismatch", `Fresh truth is ${truth.phase}, but canonical/board phase is ${canonical.phase || "unknown"}.`);
  } else if (truth.phase === "pod-received") {
    if (!canonical.gates.podReceived && /delivered-pod-pending|pod-needed|pod pending|request pod/i.test(boardText)) {
      add("canonical-state-promotion", "pod-proof-not-promoted", "Fresh Gmail truth has POD received, but canonical/board still asks for POD.");
    }
    if (/pod pending|request pod|pod missing|collect pod/i.test(combinedServerText) && !/no pod request|pod is already|pod found|pod received/i.test(combinedServerText)) {
      add("brain-source-selection", "server-answer-asks-for-pod-after-pod", "Server answer still asks for POD after POD evidence.");
    }
    if (/pod pending|request pod|pod missing|collect pod/i.test(combinedBrowserText) && !/pod found|pod received|already in/i.test(combinedBrowserText)) {
      add("ui-rendering", "browser-answer-asks-for-pod-after-pod", "Browser answer still asks for POD after POD evidence.");
    }
  } else if (truth.phase === "pickup-scheduled") {
    if (/\b(driver is heading|on his way|heading to pickup|picked up|recovered|loaded)\b/i.test(boardText) && !/scheduled|tomorrow|do not treat/i.test(boardText)) {
      add("canonical-state-promotion", "scheduled-pickup-promoted-too-far", "Pickup scheduled evidence is being rendered as active/complete pickup.");
    }
    if (/\bdriver is heading|picked up|loaded|recovered\b/i.test(combinedServerText) && !/scheduled|do not treat/i.test(combinedServerText)) {
      add("brain-source-selection", "server-pickup-scheduled-too-strong", "Server answer overstates scheduled pickup as active/complete pickup.");
    }
  } else if (truth.phase === "delivered-pod-pending") {
    if (!canonical.gates.deliveryReported) {
      add("canonical-state-promotion", "delivery-report-not-promoted", "Fresh email reports delivery, but canonical delivery gate is not set.");
    }
  } else if (truth.phase === "customs-hold") {
    if (!canonical.gates.customHold && normalizedPhase(canonical.phase) !== "customs-hold") {
      add("canonical-state-promotion", "customs-blocker-not-promoted", "Fresh customs/inbond truth is blocked, but canonical/board still allows downstream dispatch.");
    }
    const positiveDispatchInstruction =
      /\b(?:send\/confirm the release packet|dispatch pickup|confirm pickup broker|delivery order email|ready for pickup)\b/i.test(boardText) &&
      !/\b(?:do not|don't|pause|hold|stop|not)\b.{0,80}\b(?:dispatch|release[-\s]?packet|pickup)|\bonly resume\b.{0,100}\b(?:dispatch|pickup)|\buntil\b.{0,100}\b(?:release|d\/?o|customs)/i.test(boardText);
    if (positiveDispatchInstruction) {
      add("canonical-state-promotion", "customs-blocker-shows-dispatch-action", "Customs/inbond blocker is current, but the board still exposes a release/dispatch instruction.");
    }
  } else if (truth.phase === "released") {
    if (!canonical.gates.customsBrokerRelease) {
      add("canonical-state-promotion", "release-not-promoted", "Fresh email has release/DO evidence, but canonical customs release gate is not set.");
    }
  } else if (truth.phase === "pre-arrival") {
    if (!/pre-arrival/i.test(canonical.phase) && canonical.gates.arrived && !/arrived/i.test(truth.summary || "")) {
      add("canonical-state-promotion", "pre-arrival-promoted-too-far", "TMS/truth source says shipment is pre-arrival, but canonical state has already promoted arrival.");
    }
  } else if (truth.phase === "arrived") {
    if (!canonical.gates.arrived) {
      add("canonical-state-promotion", "arrival-not-promoted", "TMS/truth source says arrived at destination, but canonical arrival gate is not set.");
    }
  }

  for (const answer of serverAnswers) {
    const text = answerCurrentText(answer.answer);
    if (answerLooksRegressedToMissing(text) && /arrived|released|picked-up|delivered|pod-received|pod pending/i.test(truth?.phase || "")) {
      add("brain-source-selection", "server-answer-regressed-to-not-arrived", `${answer.question} regressed to not-arrived/no-match despite newer truth.`);
    }
    for (const issue of validateOpenQuestionAnswer({ answer, truth, canonical, shipment, layer: "brain-source-selection" })) {
      add(issue.layer, issue.code, issue.message, { question: issue.question, answer: issue.text });
    }
  }

  for (const answer of browserAnswers) {
    const text = browserAnswerText(answer);
    if (answerLooksRegressedToMissing(text) && /arrived|released|picked-up|delivered|pod-received|pod pending/i.test(truth?.phase || "")) {
      add("ui-rendering", "browser-answer-regressed-to-not-arrived", `${answer.question} regressed to not-arrived/no-match despite newer truth.`);
    }
    for (const issue of validateOpenQuestionAnswer({ answer, truth, canonical, shipment, layer: "ui-rendering" })) {
      add(issue.layer, issue.code, issue.message, { question: issue.question, answer: issue.text });
    }
  }

  const stationServerAnswers = serverAnswers.filter((entry) => ["station", "station-details"].includes(openQuestionKind(entry.question)));
  const stationBrowserAnswers = browserAnswers.filter((entry) => ["station", "station-details"].includes(openQuestionKind(entry.question)));
  const browserStationSignatures = stationBrowserAnswers.map((entry) => stationDetailSignature(entry.content || browserAnswerText(entry)));
  for (const serverAnswer of stationServerAnswers) {
    const browserAnswer = stationBrowserAnswers.find((entry) => entry.question === serverAnswer.question);
    if (!browserAnswer) continue;
    const serverSig = stationDetailSignature(answerText(serverAnswer.answer));
    const browserSig = stationDetailSignature(browserAnswer.content || browserAnswerText(browserAnswer));
    const anyBrowserStationMatch = browserStationSignatures.some((signature) => signature.stationName === serverSig.stationName);
    if (serverSig.stationName && !browserSig.stationName && !anyBrowserStationMatch) {
      add("ui-rendering", "station-detail-server-browser-mismatch", `${serverAnswer.question} did not render the canonical station handler/contact in the browser.`, {
        question: serverAnswer.question,
        serverStation: serverSig.stationName,
        browserStation: "",
      });
    }
    if (serverSig.stationName && browserSig.stationName && serverSig.stationName !== browserSig.stationName) {
      add("ui-rendering", "station-detail-server-browser-mismatch", `${serverAnswer.question} rendered a different station handler/contact than the canonical API answer.`, {
        question: serverAnswer.question,
        serverStation: serverSig.stationName,
        browserStation: browserSig.stationName,
      });
    }
    if (serverSig.email && browserSig.email && serverSig.email !== browserSig.email) {
      add("ui-rendering", "station-email-server-browser-mismatch", `${serverAnswer.question} rendered a different station email than the canonical API answer.`, {
        question: serverAnswer.question,
        serverEmail: serverSig.email,
        browserEmail: browserSig.email,
      });
    }
    if (serverSig.phone && browserSig.phone && serverSig.phone !== browserSig.phone) {
      add("ui-rendering", "station-phone-server-browser-mismatch", `${serverAnswer.question} rendered a different station phone than the canonical API answer.`, {
        question: serverAnswer.question,
        serverPhone: serverSig.phone,
        browserPhone: browserSig.phone,
      });
    }
  }

  for (const issue of actionAuditRow?.issues || []) {
    if (issue.severity !== "critical") continue;
    add("action-generation", issue.code, issue.message, {
      action: issue.action || "",
      channel: issue.channel || "",
      type: issue.type || "",
    });
  }

  const unsafeActions = [...(boardPlan?.actionsReady || [])].filter((action) => {
    const profile = actionPacketProfile(action);
    return !profile.ready;
  });
  for (const action of unsafeActions) {
    add("action-generation", "not-ready-action-visible", `Action "${action.label || action.id}" is visible but not executable.`, {
      action: action.label || action.id || "",
      missing: action.missing || action.preflight?.missing || [],
    });
  }

  return issues;
}

async function serverAnswersForShipment(memory, awb, options = {}) {
  if (options.skipBrowser && process.env.PIKIIO_AUDIT_SERVER_ANSWERS_WHEN_SKIP_BROWSER !== "1") return [];
  const questions = questionsForAwb(awb, options);
  const answers = [];
  for (const question of questions) {
    const result = await answerOpsBrainQuestion({ rootDir: ROOT_DIR, question, memory });
    answers.push({ question, source: result.source || "", answer: publicBrainAnswer(result.answer) });
  }
  return answers;
}

function execJson(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout || 60000,
      env: localRuntimeEnv(process.env),
    });
    return JSON.parse(output);
  } catch (error) {
    return {
      ok: false,
      error: error.stderr?.toString?.() || error.message,
    };
  }
}

async function probeTms() {
  return execJson(process.execPath, [path.join(ROOT_DIR, "scripts", "tms-access.js"), "--json"], { timeout: 90000 });
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const client = String(url || "").startsWith("https:") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode || 0));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${url}`)));
    req.on("error", reject);
  });
}

function httpJsonUrl(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const client = String(url || "").startsWith("https:") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${url} returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error(`${url} returned non-JSON: ${error.message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${url}`)));
    req.on("error", reject);
  });
}

function isLocalAuditUrl(url = LOCAL_URL) {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isProductionAuditUrl(url = LOCAL_URL) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      (
        parsed.hostname === "pq-ops-demo.example" ||
        /^pikiio-app(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(parsed.hostname)
      );
  } catch {
    return false;
  }
}

async function localRuntimeProof(url) {
  const proof = await httpJsonUrl(new URL("/api/local-runtime", url).toString(), 1500);
  if (proof?.app !== "pq-ops-dashboard") {
    throw new Error(`Unexpected local runtime app: ${proof?.app || "unknown"}`);
  }
  if (path.resolve(proof.rootDir || "") !== ROOT_DIR) {
    throw new Error(`Local runtime root mismatch: ${proof.rootDir || "(missing)"} !== ${ROOT_DIR}`);
  }
  if (proof.codeSignature !== AUDIT_CODE_SIGNATURE) {
    const error = new Error(`Local runtime code signature mismatch: ${proof.codeSignature || "(missing)"} !== ${AUDIT_CODE_SIGNATURE}`);
    error.code = proof.codeSignature ? "LOCAL_RUNTIME_CODE_MISMATCH" : "LOCAL_RUNTIME_UNSIGNED";
    error.proof = proof;
    throw error;
  }
  return proof;
}

function localRuntimeRejectionSummary(error) {
  const proof = error?.proof || null;
  return {
    code: error?.code || "LOCAL_RUNTIME_REJECTED",
    message: error?.message || String(error),
    rootDir: proof?.rootDir || "",
    pid: proof?.pid || null,
    port: proof?.port || null,
    hasCodeSignature: Boolean(proof?.codeSignature),
    platformFlags: proof?.platformFlags || {},
  };
}

function auditUrlForPort(port) {
  const parsed = new URL(LOCAL_URL);
  parsed.hostname = parsed.hostname || "127.0.0.1";
  parsed.port = String(port);
  return parsed.toString();
}

async function startLocalServerOnPort(port) {
  const logPath = path.join(ARTIFACT_DIR, `local-server-${port}.log`);
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT_DIR,
    detached: true,
    env: { ...localRuntimeEnv(process.env), PORT: String(port), HOST: "127.0.0.1", PIKIIO_AUDIT_CODE_SIGNATURE: AUDIT_CODE_SIGNATURE },
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.closeSync(out);
  return { child, logPath };
}

async function waitForLocalRuntime(url, timeoutMs = 10000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await localRuntimeProof(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error(`Local runtime did not become ready at ${url}`);
}

async function ensureLocalServer() {
  if (!isLocalAuditUrl()) {
    const status = await httpGet(LOCAL_URL, 5000).catch((error) => {
      throw new Error(`Remote audit URL unavailable: ${LOCAL_URL} (${error.message || error})`);
    });
    if (status >= 200 && status < 500) {
      return { started: false, reused: true, remote: true, url: LOCAL_URL, status };
    }
    throw new Error(`Remote audit URL returned ${status}: ${LOCAL_URL}`);
  }
  let bypassedLocalRuntime = null;
  try {
    const proof = await localRuntimeProof(LOCAL_URL);
    return { started: false, reused: true, url: LOCAL_URL, status: 200, proof };
  } catch (error) {
    bypassedLocalRuntime = localRuntimeRejectionSummary(error);
    if (error?.code === "LOCAL_RUNTIME_UNSIGNED") {
      progress(`local server probe found unsigned developer runtime at ${LOCAL_URL}; starting signed audit runtime instead`);
    } else {
      progress(`local server probe rejected ${LOCAL_URL}: ${error.message || error}`);
    }
  }
  const portSpan = Math.max(20, Number(process.env.PIKIIO_AUDIT_PORT_SPAN || 80));
  const ports = unique([
    String(DEFAULT_LOCAL_APP_PORT),
    ...Array.from({ length: portSpan }, (_, index) => String(DEFAULT_LOCAL_APP_PORT + index + 1)),
    ...Array.from({ length: 20 }, (_, index) => String(4300 + index)),
  ]).map(Number);
  const failures = [];
  for (const port of ports) {
    const url = auditUrlForPort(port);
    let occupied = false;
    try {
      const status = await httpGet(url, 700);
      occupied = status >= 200 && status < 500;
      if (status >= 200 && status < 500) {
        try {
          const proof = await localRuntimeProof(url);
          return { started: false, reused: true, url, status, proof };
        } catch (proofError) {
          failures.push(`${url} occupied by incompatible runtime: ${proofError.message}`);
          continue;
        }
      }
      failures.push(`${url} returned ${status}`);
      continue;
    } catch (existingError) {
      // No compatible server is listening; try to own this port.
    }
    if (occupied) continue;
    const { child, logPath } = await startLocalServerOnPort(port);
    try {
      const proof = await waitForLocalRuntime(url, 10000);
      return { started: true, reused: false, url, status: 200, pid: child.pid, logPath, proof, bypassedLocalRuntime };
    } catch (startError) {
      failures.push(`${url}: ${startError.message}; see ${logPath}`);
    }
  }
  throw new Error(`Local server did not start or prove repo runtime. Attempts: ${failures.join(" | ") || "none"}`);
}

async function stopOwnedLocalServer(server) {
  if (!server?.started || !server.pid) return;
  try {
    process.kill(server.pid, "SIGTERM");
    server.stopped = true;
  } catch (error) {
    server.stopped = false;
    server.stopError = error?.message || String(error);
  }
}

function requestJson(method, requestPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: requestPath, method, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Chrome DevTools ${method} ${requestPath} returned ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Chrome DevTools response was not JSON: ${error.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Chrome DevTools timed out on ${method} ${requestPath}`)));
    req.on("error", reject);
    req.end();
  });
}

async function devToolsReady() {
  try {
    await requestJson("GET", "/json/version", 1000);
    return true;
  } catch {
    return false;
  }
}

async function ensureChrome() {
  if (await devToolsReady()) return { started: false, port: PORT };
  fs.mkdirSync(AUTOMATION_PROFILE, { recursive: true });
  for (const name of fs.readdirSync(AUTOMATION_PROFILE)) {
    if (name.startsWith("Singleton")) fs.rmSync(path.join(AUTOMATION_PROFILE, name), { force: true, recursive: true });
  }
  const logPath = path.join(ARTIFACT_DIR, "chrome.log");
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${AUTOMATION_PROFILE}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  fs.closeSync(out);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await devToolsReady()) return { started: true, port: PORT, logPath };
  }
  throw new Error(`Chrome DevTools did not start; see ${logPath}`);
}

async function openPage(url) {
  const encoded = encodeURIComponent(url);
  try {
    return await requestJson("PUT", `/json/new?${encoded}`);
  } catch {
    return requestJson("GET", `/json/new?${encoded}`);
  }
}

function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id) return;
    const waiter = pending.get(payload.id);
    if (!waiter) return;
    pending.delete(payload.id);
    if (payload.error) waiter.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else waiter.resolve(payload.result);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    async command(method, params = {}) {
      await opened;
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, Number(process.env.PIKIIO_AUDIT_CDP_TIMEOUT_MS || 90000));
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      ws.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    async close() {
      await opened.catch(() => {});
      ws.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(cdp, expression).catch(() => false);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${expression.slice(0, 120)}`);
}

async function closeTab(page) {
  if (!page?.id) return;
  try {
    await requestJson("GET", `/json/close/${encodeURIComponent(page.id)}`);
  } catch {
    // Best effort.
  }
}

async function browserAudit(awbs, options = {}) {
  if (options.skipBrowser) return { skipped: true, answers: [], buttons: {}, issues: [] };
  const server = await ensureLocalServer();
  await ensureChrome();
  const auditUrl = new URL(server.url || LOCAL_URL);
  auditUrl.searchParams.set("audit", String(Date.now()));
  const page = await openPage(auditUrl.toString());
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  const answers = [];
  const operatorFlows = [];
  const issues = [];
  const waitForAssistantDone = () => waitFor(cdp, `(() => {
    const history = (window.state && Array.isArray(window.state.opsBrainChatHistory))
      ? window.state.opsBrainChatHistory
      : JSON.parse(localStorage.getItem("pikiio-ops-brain-chat") || "[]");
    const last = history[history.length - 1] || {};
    const messages = Array.from(document.querySelectorAll(".ops-brain-message"));
    const lastMessage = messages[messages.length - 1];
    const domAssistantDone = lastMessage &&
      lastMessage.classList.contains("assistant") &&
      !lastMessage.classList.contains("typing") &&
      (lastMessage.innerText || "").trim().length > 0;
    return (last.role === "assistant" || domAssistantDone) &&
      !window.state?.opsBrainThinkingQuestion &&
      !document.querySelector(".ops-brain-message.typing");
  })()`, 60000);
  const historyLength = () => evaluate(cdp, `(() => document.querySelectorAll(".ops-brain-message.assistant").length)()`);
  const waitForQuestionRendered = (question, timeoutMs = 15000) => waitFor(cdp, `(() => {
    const question = ${JSON.stringify(question)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const normalizeAwb = (value) => String(value || "").replace(/\\D/g, "");
    const expected = normalize(question);
    const history = (window.state && Array.isArray(window.state.opsBrainChatHistory))
      ? window.state.opsBrainChatHistory
      : JSON.parse(localStorage.getItem("pikiio-ops-brain-chat") || "[]");
    let answer = null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index] || {};
      if (message.role !== "user" || normalize(message.content) !== expected) continue;
      for (let answerIndex = index + 1; answerIndex < history.length; answerIndex += 1) {
        const item = history[answerIndex] || {};
        if (item.role === "user") break;
        if (item.role === "assistant" && !item.notificationId) {
          answer = item;
          break;
        }
      }
      break;
    }
    if (!answer) return false;
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const assistantForQuestion = (scope) => {
      const messages = Array.from(scope.querySelectorAll(".ops-brain-message"));
      let userIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const node = messages[index];
        if (!node.classList.contains("user")) continue;
        if (normalize(node.innerText || "").includes(expected)) {
          userIndex = index;
          break;
        }
      }
      if (userIndex < 0) return null;
      for (let index = userIndex + 1; index < messages.length; index += 1) {
        const node = messages[index];
        if (node.classList.contains("user")) break;
        if (node.classList.contains("assistant") && !node.classList.contains("typing")) return node;
      }
      return null;
    };
    const chats = Array.from(document.querySelectorAll(".ops-brain-chat")).filter(visible);
    const chatScope = chats.find((chat) => assistantForQuestion(chat)) || chats[chats.length - 1] || document;
    const latestAssistant = assistantForQuestion(chatScope) || Array.from(chatScope.querySelectorAll(".ops-brain-message.assistant")).pop();
    if (!latestAssistant || latestAssistant.classList.contains("typing")) return false;
    const items = answer.allItems || answer.items || [];
    if (items.length) {
      const expectedAwbs = items.slice(0, Math.min(3, items.length)).map((item) => normalizeAwb(item.awb)).filter(Boolean);
      const renderedAwbs = Array.from(latestAssistant.querySelectorAll("[data-brain-awb]"))
        .map((node) => normalizeAwb(node.dataset.brainAwb || node.innerText || ""))
        .filter(Boolean);
      return expectedAwbs.length > 0 && expectedAwbs.every((awb) => renderedAwbs.includes(awb));
    }
    const text = normalize(latestAssistant.innerText || "");
    const needles = [answer.title, answer.subtitle, answer.content, answer.answer]
      .map(normalize)
      .filter((value) => value.length >= 8)
      .map((value) => value.slice(0, Math.min(48, value.length)));
    return needles.length ? needles.some((needle) => text.includes(needle)) : text.length > 0;
  })()`, timeoutMs);
  const waitForNewAssistantAnswer = (beforeLength, expectedAwb = "", timeoutMs = 60000) => waitFor(cdp, `(() => {
    const beforeLength = ${Number(beforeLength || 0)};
    const expectedAwb = ${JSON.stringify(normalizeAwb(expectedAwb || ""))};
    const history = (window.state && Array.isArray(window.state.opsBrainChatHistory))
      ? window.state.opsBrainChatHistory
      : JSON.parse(localStorage.getItem("pikiio-ops-brain-chat") || "[]");
    const last = history[history.length - 1] || {};
    const messages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
    const lastMessage = messages[messages.length - 1];
    const latestText = [
      last.title || "",
      last.subtitle || "",
      last.content || "",
      last.answer || "",
      lastMessage?.innerText || "",
    ].join(" ");
    const digits = latestText.replace(/\\D/g, "");
    const domDone = lastMessage &&
      messages.length > beforeLength &&
      !lastMessage.classList.contains("typing") &&
      (lastMessage.innerText || "").trim().length > 0;
    const done = (
      (last.role === "assistant" && history.length > beforeLength) ||
      domDone
    ) &&
      !window.state?.opsBrainThinkingQuestion &&
      !document.querySelector(".ops-brain-message.typing") &&
      (latestText || "").trim().length > 0;
    return done && (!expectedAwb || digits.includes(expectedAwb));
  })()`, timeoutMs);
  const captureUiSnapshot = (label, question) => evaluate(cdp, `(() => {
    const label = ${JSON.stringify(label)};
    const question = ${JSON.stringify(question)};
    const history = (window.state && Array.isArray(window.state.opsBrainChatHistory))
      ? window.state.opsBrainChatHistory
      : JSON.parse(localStorage.getItem("pikiio-ops-brain-chat") || "[]");
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const compactText = (value, max = 3000) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
    const expected = normalize(question);
    let last = {};
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index] || {};
      if (message.role !== "user" || normalize(message.content) !== expected) continue;
      for (let answerIndex = index + 1; answerIndex < history.length; answerIndex += 1) {
        const item = history[answerIndex] || {};
        if (item.role === "user") break;
        if (item.role === "assistant" && !item.notificationId) {
          last = item;
          break;
        }
      }
      break;
    }
    const matchedHistory = Boolean(last.role);
    if (!matchedHistory && !/^operator-question/.test(label)) last = history[history.length - 1] || {};
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const assistantForQuestion = (scope) => {
      const messages = Array.from(scope.querySelectorAll(".ops-brain-message"));
      let userIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const node = messages[index];
        if (!node.classList.contains("user")) continue;
        if (normalize(node.innerText || "").includes(expected)) {
          userIndex = index;
          break;
        }
      }
      if (userIndex < 0) return null;
      for (let index = userIndex + 1; index < messages.length; index += 1) {
        const node = messages[index];
        if (node.classList.contains("user")) break;
        if (node.classList.contains("assistant") && !node.classList.contains("typing")) return node;
      }
      return null;
    };
    const chats = Array.from(document.querySelectorAll(".ops-brain-chat")).filter(visible);
    const chatScope = chats.find((chat) => assistantForQuestion(chat)) || chats[chats.length - 1] || document;
    const assistantMessages = Array.from(chatScope.querySelectorAll(".ops-brain-message.assistant"));
    const latestAssistant = assistantForQuestion(chatScope) || assistantMessages[assistantMessages.length - 1] || chatScope;
    const count = (selector) => latestAssistant.querySelectorAll(selector).length;
    const globalCount = (selector) => document.querySelectorAll(selector).length;
	    const text = chatScope?.innerText || "";
	    const latestText = latestAssistant?.innerText || "";
	    const domLines = latestText.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
	    const domTitle = latestText.match(/\\b\\d{3}[-\\s]?\\d{8}\\b/)?.[0] || domLines[0] || "";
    const overflow = Array.from(chatScope.querySelectorAll(".ops-brain-message, .ops-brain-result-row, .ops-brain-action-card, .draft-preview, .mini-button, .awb-copy-button"))
      .filter(visible)
      .filter((node) => node.scrollWidth > node.clientWidth + 3 || node.scrollHeight > node.clientHeight + 6)
      .map((node) => ({
        className: node.className || node.tagName,
        text: (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 140),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }))
      .slice(0, 20);
    const latestRows = Array.from(latestAssistant.querySelectorAll("[data-brain-shipment-id]"))
      .map((node, index) => ({
        index,
        shipmentId: node.dataset.brainShipmentId || "",
        awb: (node.dataset.brainAwb || (node.innerText || "").match(/\\b\\d{3}[-\\s]?\\d{8}\\b/)?.[0] || "").replace(/\\s+/g, ""),
        text: (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 220),
        rowActionCount: node.querySelectorAll("[data-ops-brain-row-action]").length,
        rowHandleActionCount: node.querySelectorAll("[data-handle-ops-brain-action]").length,
        rowPreviewActionCount: node.querySelectorAll("[data-preview-action]").length,
        rowGenerateDocumentCount: node.querySelectorAll("[data-generate-document-action]").length,
      }))
      .filter((row) => row.awb || row.shipmentId);
    const buttons = Array.from(latestAssistant.querySelectorAll("button, a[href^='tel:']"))
      .filter(visible)
      .map((node) => ({
        text: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 100),
        selector: node.matches("a[href^='tel:']") ? "tel" : node.dataset.previewAction ? "preview" : node.dataset.handleOpsBrainAction ? "platform-update" : node.dataset.closeActionPreview ? "close-preview" : node.dataset.copyAwb ? "copy-awb" : node.dataset.brainQuestion ? "suggestion" : node.dataset.clearOpsBrainChat !== undefined ? "clear-chat" : "button",
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
        href: node.getAttribute("href") || "",
      }));
    return {
	      label,
	      question,
	      matchedHistory,
	      title: last.title || domTitle,
	      subtitle: last.subtitle || "",
	      content: compactText(last.content || latestText, 3000),
      text: compactText(text, 5000),
      latestText: compactText(latestText, 5000),
      itemCount: (last.allItems || last.items || []).length,
      domItemCount: latestRows.length,
      domItems: latestRows.slice(0, 40),
      items: (last.allItems || last.items || []).map((item) => ({
        id: item.id || "",
        awb: item.awb || "",
        title: item.title || "",
        action: item.action || "",
      })).slice(0, 40),
      actionCount: (last.actions || []).length,
      actions: (last.actions || []).map((action) => ({
        id: action.id || "",
        label: action.label || "",
        type: action.type || "",
        channel: action.channel || "",
        targetName: action.targetName || "",
        targetEmail: action.targetEmail || "",
        blockedReason: action.blockedReason || action.preflight?.reason || "",
      })).slice(0, 20),
      counts: {
        suggestions: count("[data-brain-question]"),
        resultRows: count("[data-brain-shipment-id]"),
        copyAwb: count("[data-copy-awb]"),
        previewAction: count("[data-preview-action]"),
        rowAction: count("[data-ops-brain-row-action]"),
        handleAction: count("[data-handle-ops-brain-action]"),
        closePreview: count("[data-close-action-preview]"),
        confirmAction: count("[data-confirm-action]"),
        generateDocument: count("[data-generate-document-action]"),
        phoneLinks: count("a[href^='tel:']"),
        draftPreview: count("[data-draft-preview]"),
        clearChat: count("[data-clear-ops-brain-chat]"),
      },
      globalCounts: {
        suggestions: globalCount("[data-brain-question]"),
        resultRows: globalCount("[data-brain-shipment-id]"),
        copyAwb: globalCount("[data-copy-awb]"),
        previewAction: globalCount("[data-preview-action]"),
        rowAction: globalCount("[data-ops-brain-row-action]"),
        clearChat: globalCount("[data-clear-ops-brain-chat]"),
      },
      buttons,
      overflow,
    };
  })()`);
  const submitQuestion = async (question) => {
    const result = await evaluate(cdp, `(() => new Promise((resolve) => {
      const question = ${JSON.stringify(question)};
      const expectedAwb = ${JSON.stringify(normalizeAwb(question))};
	      const started = Date.now();
	      const startedIso = new Date(started).toISOString();
	      let lastSubmitAttempt = 0;
      const submitNow = () => {
        lastSubmitAttempt = Date.now();
        if (typeof submitOpsBrainQuestion === "function") {
          submitOpsBrainQuestion(question);
          return "submitOpsBrainQuestion";
        }
        const input = document.querySelector("[data-ops-brain-input]");
        const form = document.querySelector("[data-ops-brain-form]");
        if (input && form) {
          input.value = question;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          return "form";
        }
        return "none";
      };
	      const doneState = () => {
	        const history = (window.state && Array.isArray(window.state.opsBrainChatHistory))
	          ? window.state.opsBrainChatHistory
	          : JSON.parse(localStorage.getItem("pikiio-ops-brain-chat") || "[]");
	        const last = history[history.length - 1] || {};
	        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
	        const expected = normalize(question);
	        const compactText = (value, max = 1200) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
	        const compactAction = (action = {}) => ({
	          id: compactText(action.id || "", 120),
	          label: compactText(action.label || "", 180),
	          type: compactText(action.type || "", 80),
	          channel: compactText(action.channel || "", 80),
	          targetName: compactText(action.targetName || "", 180),
	          targetEmail: compactText(action.targetEmail || "", 180),
	          readiness: compactText(action.readiness || action.preflight?.status || "", 80),
	          blockedReason: compactText(action.blockedReason || action.preflight?.reason || "", 240),
	        });
	        const compactItem = (item = {}) => ({
	          id: compactText(item.id || "", 120),
	          awb: compactText(item.awb || "", 40),
	          title: compactText(item.title || "", 220),
	          action: compactText(item.action || "", 260),
	        });
	        let lastQuestionIndex = -1;
	        let lastQuestionCreatedAt = 0;
	        for (let index = history.length - 1; index >= 0; index -= 1) {
	          const message = history[index] || {};
	          if (message.role === "user" && normalize(message.content) === expected) {
	            lastQuestionIndex = index;
	            lastQuestionCreatedAt = Date.parse(message.createdAt || "") || 0;
	            break;
	          }
	        }
	        let answerMessage = null;
	        if (lastQuestionIndex >= 0) {
	          for (let index = lastQuestionIndex + 1; index < history.length; index += 1) {
	            const item = history[index] || {};
	            if (item.role === "user") break;
	            if (item.role === "assistant" && !item.notificationId) {
	              answerMessage = item;
	              break;
	            }
	          }
	        }
	        const messages = Array.from(document.querySelectorAll(".ops-brain-message"));
	        const lastMessage = messages[messages.length - 1];
	        const latestUser = Array.from(document.querySelectorAll(".ops-brain-message.user")).pop();
	        const latestUserMatches = normalize(latestUser?.innerText || "").includes(expected);
	        const assistantMessages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
	        const latestAssistant = assistantMessages[assistantMessages.length - 1];
	        const typing = Boolean(document.querySelector(".ops-brain-message.typing"));
	        const latestAssistantText = (latestAssistant?.innerText || "").replace(/\\s+/g, " ").trim();
	        const latestText = [
          answerMessage?.title || "",
          answerMessage?.subtitle || "",
          answerMessage?.content || "",
          answerMessage?.answer || "",
          latestAssistantText,
        ].join(" ");
	        const latestDigits = latestText.replace(/\\D/g, "");
	        const answerCreatedAt = Date.parse(answerMessage?.createdAt || "") || 0;
	        const startedAt = Date.parse(startedIso) || started;
	        const historyAnsweredExpectedQuestion = Boolean(answerMessage) &&
	          answerCreatedAt >= Math.max(startedAt - 1000, lastQuestionCreatedAt - 1000);
	        const answerMatchesAwb = !expectedAwb || latestDigits.includes(expectedAwb);
	        const snapshot = answerMessage || last;
	        return {
	          done: historyAnsweredExpectedQuestion &&
	            answerMatchesAwb &&
	            !window.state?.opsBrainThinkingQuestion &&
	            !typing,
          historyLength: history.length,
          lastQuestionIndex,
          typing,
          lastRole: last.role || "",
          lastTitle: last.title || "",
          answerRole: answerMessage?.role || "",
          answerTitle: answerMessage?.title || "",
          lastSnapshot: {
            role: snapshot.role || "",
            title: compactText(snapshot.title || "", 220),
            subtitle: compactText(snapshot.subtitle || "", 320),
            content: compactText(snapshot.content || "", 2000),
            answer: compactText(snapshot.answer || "", 2000),
            nextAction: compactText(snapshot.nextAction || "", 320),
            actions: (snapshot.actions || []).slice(0, 20).map(compactAction),
            items: (snapshot.items || []).slice(0, 40).map(compactItem),
            allItems: (snapshot.allItems || []).slice(0, 40).map(compactItem),
            createdAt: snapshot.createdAt || "",
            notificationId: snapshot.notificationId || "",
          },
          answer: historyAnsweredExpectedQuestion ? {
            title: compactText(answerMessage.title || "", 220),
            subtitle: compactText(answerMessage.subtitle || "", 320),
            content: compactText(answerMessage.content || "", 2000),
            answer: compactText(answerMessage.answer || "", 2000),
            nextAction: compactText(answerMessage.nextAction || "", 320),
            actions: (answerMessage.actions || []).slice(0, 20).map(compactAction),
            items: (answerMessage.items || []).slice(0, 40).map(compactItem),
            allItems: (answerMessage.allItems || []).slice(0, 40).map(compactItem),
            createdAt: answerMessage.createdAt || "",
          } : null,
          expectedAwb,
          latestDigits: latestDigits.slice(0, 240),
          latestAssistantText: latestAssistantText.slice(0, 180),
          domText: (lastMessage?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 180),
        };
      };
      clearOpsBrainChat();
      if (typeof render === "function") render();
      submitNow();
      setTimeout(() => {
        const state = doneState();
        if (
          state.lastQuestionIndex < 0 &&
          !window.state?.opsBrainThinkingQuestion &&
          !state.typing &&
          typeof submitOpsBrainQuestion === "function"
        ) {
          submitNow();
        }
      }, 1000);
      const timer = setInterval(() => {
        const state = doneState();
        if (
          !state.done &&
          (state.lastQuestionIndex < 0 || state.lastRole !== "assistant") &&
          Date.now() - started > 1500 &&
          Date.now() - lastSubmitAttempt > 1500 &&
          !window.state?.opsBrainThinkingQuestion &&
          !state.typing
        ) {
          submitNow();
        }
        if (state.done || Date.now() - started > 70000) {
          clearInterval(timer);
          resolve({ ...state, elapsed: Date.now() - started, lastSubmitAttemptAge: Date.now() - lastSubmitAttempt });
        }
      }, 250);
    }))()`);
    if (!result?.done) {
      throw new Error(`Timed out waiting for assistant answer to ${question}: ${JSON.stringify(result || {})}`);
    }
    return result;
  };
  const submitQuestionBounded = (question, timeoutMs = Number(process.env.PIKIIO_AUDIT_SUBMIT_QUESTION_TIMEOUT_MS || 90000)) =>
    withTimeout(submitQuestion(question), timeoutMs, `Timed out submitting Ops Brain question: ${question}`);
  const previewFirstAction = async () => evaluate(cdp, `(() => new Promise((resolve) => {
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    const result = { clicked: false, previewVisible: false, closeClicked: false, closed: false, error: "" };
    (async () => {
      const messages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
      const scope = messages[messages.length - 1] || document;
      const button = scope.querySelector("[data-preview-action]:not([disabled])");
      if (!button) return resolve(result);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      result.clicked = true;
      await sleep(1200);
      const latestMessages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
      const latestScope = latestMessages[latestMessages.length - 1] || document;
      result.previewVisible = Boolean(latestScope.querySelector("[data-draft-preview]"));
      const close = latestScope.querySelector("[data-close-action-preview]");
      if (close) {
        close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        result.closeClicked = true;
        await sleep(300);
        const closedMessages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
        const closedScope = closedMessages[closedMessages.length - 1] || document;
        result.closed = !closedScope.querySelector("[data-draft-preview]");
      }
      resolve(result);
    })().catch((error) => {
      result.error = error.message || String(error);
      resolve(result);
    });
  }))()`);
  const clickCopyAwb = async () => evaluate(cdp, `(() => {
    const messages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
    const scope = messages[messages.length - 1] || document;
    const button = scope.querySelector("[data-copy-awb]");
    if (!button) return { clicked: false, reason: "not found" };
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { clicked: true, awb: button.dataset.copyAwb || "", aria: button.getAttribute("aria-label") || "" };
  })()`);
  try {
    await cdp.command("Page.enable");
    await cdp.command("Runtime.enable");
    await cdp.command("Network.enable");
    await cdp.command("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.command("Emulation.setDeviceMetricsOverride", {
      width: Number(process.env.PIKIIO_AUDIT_VIEWPORT_WIDTH || 430),
      height: Number(process.env.PIKIIO_AUDIT_VIEWPORT_HEIGHT || 932),
      deviceScaleFactor: Number(process.env.PIKIIO_AUDIT_DEVICE_SCALE_FACTOR || 2),
      mobile: true,
    }).catch(() => {});
    await cdp.command("Network.clearBrowserCache").catch(() => {});
    await evaluate(cdp, `(() => Promise.all([
      navigator.serviceWorker?.getRegistrations?.()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => null),
      window.caches?.keys?.()
        .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
        .catch(() => null)
    ]).then(() => {
      try {
        for (const key of Object.keys(localStorage || {})) {
          if (/^(?:pikiio-|pq-|ops-)/i.test(key)) localStorage.removeItem(key);
        }
      } catch (error) {}
      return true;
    }).catch(() => true))()`).catch(() => {});
    await cdp.command("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.readyState === 'complete'", 20000);
    await waitFor(cdp, "typeof opsBrainAnswer === 'function' && typeof submitOpsBrainQuestion === 'function'", 30000);
    const appRuntimeVersion = await evaluate(cdp, "window.PIKIIO_APP_RUNTIME_VERSION || ''");
    if (appRuntimeVersion !== EXPECTED_APP_RUNTIME_VERSION) {
      throw new Error(`Browser loaded stale app runtime ${appRuntimeVersion || "(missing)"}, expected ${EXPECTED_APP_RUNTIME_VERSION}`);
    }
    await evaluate(cdp, `(() => { try { state.filter = "brain"; render(); } catch (error) {} return true; })()`);
    await waitFor(cdp, "Boolean(document.querySelector('[data-ops-brain-form]'))", 10000);
    await waitFor(cdp, `(() => {
      try {
        const stateReady = typeof state !== "undefined" &&
          Array.isArray(state.shipments) &&
          state.shipments.length > 0 &&
          Boolean(state.snapshotTime);
        const domReady = Boolean(document.querySelector("[data-ops-brain-form]")) &&
          (document.querySelectorAll("[data-brain-question], .cargo-card, [data-brain-shipment-id]").length > 0);
        return stateReady || domReady;
      } catch {
        return false;
      }
    })()`, 60000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await evaluate(cdp, `(() => {
      try {
        state.pushAlertPromptDismissed = true;
        if (typeof persistPushPromptDismissed === "function") persistPushPromptDismissed();
        const notifications = typeof activeOperatorNotifications === "function" ? activeOperatorNotifications() : [];
        for (const notification of notifications) {
          if (typeof operatorNotificationSeenKey === "function") state.seenOperatorNotifications.add(operatorNotificationSeenKey(notification));
          else if (notification.id) state.seenOperatorNotifications.add(notification.id);
        }
        if (typeof persistSeenOperatorNotifications === "function") persistSeenOperatorNotifications();
        clearOpsBrainChat();
        render();
      } catch (error) {}
      return true;
    })()`);
    const initialButtons = await evaluate(cdp, `(() => {
      const count = (selector) => document.querySelectorAll(selector).length;
      return {
        brainSuggestions: count("[data-brain-question]"),
        copyAwb: count("[data-copy-awb]"),
        previewAction: count("[data-preview-action]"),
        rowAction: count("[data-ops-brain-row-action]"),
        handleAction: count("[data-handle-ops-brain-action]"),
        confirmAction: count("[data-confirm-action]"),
        generateDocument: count("[data-generate-document-action]"),
        phoneLinks: count("a[href^='tel:']"),
        brainShipmentRows: count("[data-brain-shipment-id]"),
        expandResults: count("[data-expand-ops-brain-results]"),
        clearChat: count("[data-clear-ops-brain-chat]")
      };
    })()`);
    const initialSafeClicks = await evaluate(cdp, `(() => {
      const results = [];
      function clickFirst(selector, label) {
        const node = document.querySelector(selector);
        if (!node) {
          results.push({ label, ok: false, reason: "not found" });
          return;
        }
        node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        results.push({ label, ok: true });
      }
      clickFirst("[data-copy-awb]", "copy-awb");
      clickFirst("[data-expand-ops-brain-results]", "expand-results");
      return results;
    })()`);
    const suggestedQuestions = await evaluate(cdp, `(() => Array.from(document.querySelectorAll("[data-brain-question]"))
      .map((node) => node.dataset.brainQuestion || node.innerText || "")
      .map((text) => text.replace(/\\s+/g, " ").trim())
      .filter(Boolean))()`);
    const operatorQuestions = unique([
      "Good morning. What needs my attention?",
      "What pickups are scheduled today?",
      "What is out for delivery today?",
      "Who is waiting on release/DO?",
      "How many shipments are released?",
      "How many shipments are arrived?",
      ...(suggestedQuestions || []),
    ]).slice(0, 12);
    for (let questionIndex = 0; questionIndex < operatorQuestions.length; questionIndex += 1) {
      const question = operatorQuestions[questionIndex];
      progress(`UI question ${questionIndex + 1}/${operatorQuestions.length}: ${question}`);
      const submitResult = await submitQuestionBounded(question);
      let renderError = "";
      try {
        await waitForQuestionRendered(question);
      } catch (error) {
        renderError = error.message || String(error);
      }
      const flow = await captureUiSnapshot("operator-question", question);
      flow.latencyMs = submitResult?.elapsed || 0;
      flow.renderError = renderError;
      const expand = await evaluate(cdp, `(() => {
        const buttons = Array.from(document.querySelectorAll("[data-expand-ops-brain-results]"));
        for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return buttons.length;
      })()`);
      if (expand) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        flow.afterExpand = await captureUiSnapshot("operator-question-expanded", question);
      }
      const rows = await evaluate(cdp, `(() => {
        const question = ${JSON.stringify(question)};
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const expected = normalize(question);
        const assistantForQuestion = (scope) => {
          const messages = Array.from(scope.querySelectorAll(".ops-brain-message"));
          let userIndex = -1;
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const node = messages[index];
            if (!node.classList.contains("user")) continue;
            if (normalize(node.innerText || "").includes(expected)) {
              userIndex = index;
              break;
            }
          }
          if (userIndex < 0) return null;
          for (let index = userIndex + 1; index < messages.length; index += 1) {
            const node = messages[index];
            if (node.classList.contains("user")) break;
            if (node.classList.contains("assistant") && !node.classList.contains("typing")) return node;
          }
          return null;
        };
        const messages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
        const scope = assistantForQuestion(document) || messages[messages.length - 1] || document;
        return Array.from(scope.querySelectorAll("[data-brain-shipment-id]"))
          .map((node, index) => ({
          index,
          shipmentId: node.dataset.brainShipmentId || "",
          awb: (node.dataset.brainAwb || (node.innerText || "").match(/\\b\\d{3}[-\\s]?\\d{8}\\b/)?.[0] || "").replace(/\\s+/g, ""),
          text: (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 220),
        }))
          .filter((row) => row.awb || row.shipmentId);
      })()`);
      flow.rowClicks = [];
      const rowsToOpen = rows.slice(0, Number(process.env.PIKIIO_AUDIT_MAX_ROW_CLICKS_PER_FLOW || 3));
      for (let rowIndex = 0; rowIndex < rowsToOpen.length; rowIndex += 1) {
        const row = rowsToOpen[rowIndex];
        progress(`UI row: ${row.awb || row.shipmentId || row.index}`);
        try {
          if (rowIndex > 0) {
            await submitQuestionBounded(question);
            await waitForQuestionRendered(question).catch(() => {});
            await evaluate(cdp, `(() => {
              const buttons = Array.from(document.querySelectorAll("[data-expand-ops-brain-results]"));
              for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              return true;
            })()`).catch(() => false);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const beforeRowClickLength = await historyLength();
          const clicked = await withTimeout(evaluate(cdp, `(() => {
            const question = ${JSON.stringify(question)};
            const wantedAwb = ${JSON.stringify(normalizeAwb(row.awb || ""))};
            const wantedId = ${JSON.stringify(row.shipmentId || "")};
            const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
            const expected = normalize(question);
            const assistantForQuestion = (scope) => {
              const messages = Array.from(scope.querySelectorAll(".ops-brain-message"));
              let userIndex = -1;
              for (let index = messages.length - 1; index >= 0; index -= 1) {
                const node = messages[index];
                if (!node.classList.contains("user")) continue;
                if (normalize(node.innerText || "").includes(expected)) {
                  userIndex = index;
                  break;
                }
              }
              if (userIndex < 0) return null;
              for (let index = userIndex + 1; index < messages.length; index += 1) {
                const node = messages[index];
                if (node.classList.contains("user")) break;
                if (node.classList.contains("assistant") && !node.classList.contains("typing")) return node;
              }
              return null;
            };
            const matchingAssistant = assistantForQuestion(document);
            const messages = Array.from(document.querySelectorAll(".ops-brain-message.assistant")).reverse();
            const rows = [
              ...(matchingAssistant ? Array.from(matchingAssistant.querySelectorAll("[data-brain-shipment-id]")) : []),
              ...messages.flatMap((scope) => Array.from(scope.querySelectorAll("[data-brain-shipment-id]"))),
              ...Array.from(document.querySelectorAll("[data-brain-shipment-id]")),
            ];
            const row = rows.find((node) => {
              const textAwb = ((node.dataset.brainAwb || node.innerText || "").match(/\\b\\d{3}[-\\s]?\\d{8}\\b/)?.[0] || "").replace(/\\D/g, "");
              return (wantedAwb && textAwb === wantedAwb) || (wantedId && node.dataset.brainShipmentId === wantedId);
            });
            if (!row) return false;
            row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
          })()`), Number(process.env.PIKIIO_AUDIT_ROW_CLICK_EVAL_TIMEOUT_MS || 8000), `row click ${row.awb || row.shipmentId || row.index}`);
          if (!clicked) {
            flow.rowClicks.push({ ...row, clicked: false, reason: "row disappeared" });
            continue;
          }
          try {
            await waitForNewAssistantAnswer(beforeRowClickLength, row.awb || "", Number(process.env.PIKIIO_AUDIT_ROW_CLICK_TIMEOUT_MS || 20000));
          } catch (error) {
            flow.rowClicks.push({ ...row, clicked: false, reason: `no detail answer: ${error.message}` });
            continue;
          }
          const rowQuestion = row.awb ? `what about ${row.awb}?` : (row.shipmentId || "");
          const detail = await captureUiSnapshot("shipment-row-opened", rowQuestion);
          const preview = await previewFirstAction();
          const copy = await clickCopyAwb();
          const afterClose = await captureUiSnapshot("shipment-row-after-preview-close", rowQuestion);
          flow.rowClicks.push({
            ...row,
            clicked: true,
            detail,
            preview,
            copy,
            afterCloseCounts: afterClose.counts,
          });
          await submitQuestionBounded(question);
          const expandedAgain = await evaluate(cdp, `(() => {
            const buttons = Array.from(document.querySelectorAll("[data-expand-ops-brain-results]"));
            for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return buttons.length;
          })()`);
          if (expandedAgain) await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          flow.rowClicks.push({
            ...row,
            clicked: false,
            reason: `row automation error: ${error.message || String(error)}`,
          });
          continue;
        }
      }
      if (rows.length > rowsToOpen.length) {
        flow.rowClicks.push({
          skipped: true,
          reason: `bounded row-click audit opened ${rowsToOpen.length}/${rows.length} rows`,
          remainingRows: rows.length - rowsToOpen.length,
        });
      }
      operatorFlows.push(flow);
    }
    const questions = browserQuestionsForAwbs(awbs, options);
    const maxExactInteractions = Number(process.env.PIKIIO_AUDIT_MAX_EXACT_INTERACTIONS || 24);
    let exactInteractionsUsed = 0;
    for (const question of questions) {
      progress(`UI exact question: ${question}`);
      try {
        let submitError = "";
        let submitResult = null;
        try {
          submitResult = await submitQuestionBounded(question);
          await waitForQuestionRendered(question).catch(() => {});
        } catch (error) {
          submitError = error.message || String(error);
        }
        const answer = await withTimeout(evaluate(cdp, `(() => {
          const history = (window.state && Array.isArray(window.state.opsBrainChatHistory))
            ? window.state.opsBrainChatHistory
            : JSON.parse(localStorage.getItem("pikiio-ops-brain-chat") || "[]");
          const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
	          const expected = normalize(${JSON.stringify(question)});
	          let last = null;
	          for (let index = history.length - 1; index >= 0; index -= 1) {
	            const message = history[index] || {};
	            if (message.role !== "user" || normalize(message.content) !== expected) continue;
	            const userCreatedAt = Date.parse(message.createdAt || "") || 0;
	            for (let answerIndex = index + 1; answerIndex < history.length; answerIndex += 1) {
	              const item = history[answerIndex] || {};
	              if (item.role === "user") break;
	              if (item.role !== "assistant" || item.notificationId) continue;
	              const answerCreatedAt = Date.parse(item.createdAt || "") || 0;
	              if (answerCreatedAt && userCreatedAt && answerCreatedAt < userCreatedAt - 1000) continue;
	              last = item;
	              break;
	            }
	            break;
	          }
	          const visibleChats = Array.from(document.querySelectorAll(".ops-brain-chat")).filter((node) => {
	            const rect = node.getBoundingClientRect();
	            const style = window.getComputedStyle(node);
	            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	          });
            const assistantForQuestion = (scope) => {
              const messages = Array.from(scope.querySelectorAll(".ops-brain-message"));
              let userIndex = -1;
              for (let index = messages.length - 1; index >= 0; index -= 1) {
                const node = messages[index];
                if (!node.classList.contains("user")) continue;
                if (normalize(node.innerText || "").includes(expected)) {
                  userIndex = index;
                  break;
                }
              }
              if (userIndex < 0) return null;
              for (let index = userIndex + 1; index < messages.length; index += 1) {
                const node = messages[index];
                if (node.classList.contains("user")) break;
                if (node.classList.contains("assistant") && !node.classList.contains("typing")) return node;
              }
              return null;
            };
	          const assistantMessages = Array.from(document.querySelectorAll(".ops-brain-message.assistant"));
            const latestAssistant = visibleChats.map((chat) => assistantForQuestion(chat)).find(Boolean) ||
              assistantForQuestion(document) ||
              assistantMessages[assistantMessages.length - 1] ||
              null;
	          const latestAssistantText = latestAssistant?.innerText || "";
	          const visibleQuestionMatched = Boolean(latestAssistant);
	          if (!last) {
	            const domTitle = latestAssistantText.match(/\\b\\d{3}[-\\s]?\\d{8}\\b/)?.[0] ||
	              latestAssistantText.split(/\\n+/).map((line) => line.trim()).find(Boolean) ||
	              "";
	            if (visibleQuestionMatched && latestAssistantText.trim()) {
	              const latestAssistantScope = latestAssistant || document;
	              return {
	                question: ${JSON.stringify(question)},
	                captureSource: "dom-rendered-answer",
	                domOnly: true,
	                title: domTitle,
	                subtitle: "",
	                content: latestAssistantText.replace(/\\s+/g, " ").trim().slice(0, 3000),
	                text: latestAssistantText.replace(/\\s+/g, " ").trim().slice(0, 5000),
	                actions: Array.from(latestAssistantScope.querySelectorAll("[data-preview-action], [data-confirm-action], [data-generate-document-action], a[href^='tel:']"))
	                  .map((node) => ({
	                    label: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim(),
	                    channel: node.matches("a[href^='tel:']") ? "phone" : "",
	                    targetName: "",
	                    readiness: node.disabled || node.getAttribute("aria-disabled") === "true" ? "disabled" : "ready",
	                    blockedReason: ""
	                  })),
	                items: Array.from(latestAssistantScope.querySelectorAll("[data-brain-shipment-id]"))
	                  .map((node) => ({
	                    awb: node.dataset.brainAwb || (node.innerText || "").match(/\\b\\d{3}[-\\s]?\\d{8}\\b/)?.[0] || "",
	                    title: "",
	                    action: (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 220)
	                  }))
	              };
	            }
	            return {
	              question: ${JSON.stringify(question)},
	              missing: true,
              title: "",
              subtitle: "",
              content: "",
              text: latestAssistantText.replace(/\\s+/g, " ").trim().slice(0, 5000),
              actions: [],
              items: []
            };
          }
	          const structuredText = [
	            last.title || "",
	            last.subtitle || "",
	            last.content || "",
	            last.answer || "",
	          ].join(" ").replace(/\s+/g, " ").trim();
	          const text = (structuredText || latestAssistantText).replace(/\s+/g, " ").trim().slice(0, 5000);
          return {
            question: ${JSON.stringify(question)},
            title: last.title || "",
            subtitle: last.subtitle || "",
            content: String(last.content || last.answer || "").replace(/\\s+/g, " ").trim().slice(0, 3000),
            text,
            actions: (last.actions || []).map((action) => ({
              label: action.label || "",
              channel: action.channel || "",
              targetName: action.targetName || "",
              readiness: action.readiness || action.preflight?.status || "",
              blockedReason: action.blockedReason || action.preflight?.reason || ""
            })),
            items: (last.items || []).map((item) => ({
              awb: item.awb || "",
              title: item.title || "",
              action: item.action || ""
            }))
          };
        })()`), Number(process.env.PIKIIO_AUDIT_EXACT_EVAL_TIMEOUT_MS || 10000), `exact answer ${question}`);
        if (answer.missing) {
          const submittedAnswer = submitResult?.answer || (submitResult?.done ? submitResult?.lastSnapshot : null) || null;
          const submittedText = [
            submittedAnswer?.title || "",
            submittedAnswer?.subtitle || "",
            submittedAnswer?.content || "",
            submittedAnswer?.answer || "",
            submittedAnswer?.nextAction || "",
          ].join(" ").replace(/\s+/g, " ").trim();
          if (submittedText) {
            Object.assign(answer, {
              missing: false,
              captureSource: "submit-result-answer",
              title: submittedAnswer.title || "",
              subtitle: submittedAnswer.subtitle || "",
              content: String(submittedAnswer.content || submittedAnswer.answer || "").replace(/\s+/g, " ").trim().slice(0, 3000),
              text: submittedText.slice(0, 5000),
              actions: (submittedAnswer.actions || []).map((action) => ({
                label: action.label || "",
                channel: action.channel || "",
                targetName: action.targetName || "",
                readiness: action.readiness || action.preflight?.status || "",
                blockedReason: action.blockedReason || action.preflight?.reason || "",
              })),
              items: (submittedAnswer.allItems || submittedAnswer.items || []).map((item) => ({
                awb: item.awb || "",
                title: item.title || "",
                action: item.action || "",
              })),
            });
          } else {
            throw new Error(`No matching assistant answer captured for ${question}`);
          }
        }
        if (submitError) answer.submitError = submitError;
        if (submitResult && !answer.submit) {
          answer.submit = {
            done: Boolean(submitResult.done),
            elapsed: submitResult.elapsed || 0,
            historyLength: submitResult.historyLength || 0,
            lastQuestionIndex: submitResult.lastQuestionIndex,
            lastRole: submitResult.lastRole || "",
            lastTitle: submitResult.lastTitle || "",
            latestAssistantText: submitResult.latestAssistantText || "",
          };
        }
        const shouldAuditControls = exactInteractionsUsed < maxExactInteractions && (
          (answer.actions || []).length > 0 ||
          /\b(?:what about|needs action|station details|problem)\b/i.test(question)
        );
        const interaction = shouldAuditControls ? await withTimeout(evaluate(cdp, `(() => new Promise((resolve) => {
          const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
          const count = (selector) => document.querySelectorAll(selector).length;
          const details = (selector) => Array.from(document.querySelectorAll(selector)).map((node) => ({
            text: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("title") || "").trim(),
            disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
            href: node.getAttribute("href") || "",
          }));
          const snapshot = () => ({
            brainSuggestions: count("[data-brain-question]"),
            copyAwb: count("[data-copy-awb]"),
            previewAction: count("[data-preview-action]"),
            rowAction: count("[data-ops-brain-row-action]"),
            handleAction: count("[data-handle-ops-brain-action]"),
            confirmAction: count("[data-confirm-action]"),
            generateDocument: count("[data-generate-document-action]"),
            phoneLinks: count("a[href^='tel:']"),
            brainShipmentRows: count("[data-brain-shipment-id]"),
            expandResults: count("[data-expand-ops-brain-results]"),
            clearChat: count("[data-clear-ops-brain-chat]"),
          });
          const result = {
            question: ${JSON.stringify(question)},
            countsBefore: snapshot(),
            countsAfter: null,
            safeClicks: [],
            dryRunOnly: [],
          };
          function clickFirst(selector, label) {
            const node = document.querySelector(selector);
            if (!node) {
              result.safeClicks.push({ label, ok: false, reason: "not found" });
              return false;
            }
            if (node.disabled || node.getAttribute("aria-disabled") === "true") {
              result.safeClicks.push({ label, ok: false, reason: "disabled" });
              return false;
            }
            node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            result.safeClicks.push({ label, ok: true });
            return true;
          }
          (async () => {
            clickFirst("[data-copy-awb]", "copy-awb");
            clickFirst("[data-expand-ops-brain-results]", "expand-results");
            if (clickFirst("[data-preview-action]", "preview-action")) await sleep(900);
            result.countsAfter = snapshot();
            result.dryRunOnly = [
              ...details("[data-confirm-action]").map((item) => ({ label: "confirm-action", ...item })),
              ...details("[data-generate-document-action]").map((item) => ({ label: "generate-document", ...item })),
              ...details("a[href^='tel:']").map((item) => ({ label: "phone-link", ...item })),
            ];
            resolve(result);
          })().catch((error) => resolve({ ...result, error: error.message || String(error), countsAfter: snapshot() }));
        }))()`), Number(process.env.PIKIIO_AUDIT_EXACT_INTERACTION_TIMEOUT_MS || 12000), `exact controls ${question}`) : {
          skipped: true,
          reason: "bounded exact-control audit",
          countsBefore: {},
          countsAfter: {},
          safeClicks: [],
          dryRunOnly: [],
        };
        if (shouldAuditControls) exactInteractionsUsed += 1;
        answer.uiInteraction = interaction;
        answers.push(answer);
      } catch (error) {
        answers.push({
          question,
          title: "",
          subtitle: "",
          content: "",
          text: "",
          actions: [],
          items: [],
          uiInteraction: {
            error: error.message || String(error),
            countsBefore: {},
            countsAfter: {},
            safeClicks: [],
            dryRunOnly: [],
          },
        });
      }
    }
    const buttonSnapshots = [initialButtons, ...answers.map((answer) => answer.uiInteraction?.countsBefore || {}), ...answers.map((answer) => answer.uiInteraction?.countsAfter || {})];
    const buttons = buttonSnapshots.reduce((totals, snapshot) => {
      for (const [key, value] of Object.entries(snapshot || {})) totals[key] = Math.max(totals[key] || 0, Number(value) || 0);
      return totals;
    }, {});
    const safeClicks = [
      ...(initialSafeClicks || []),
      ...answers.flatMap((answer) => answer.uiInteraction?.safeClicks || []),
    ];
    const dryRunOnly = answers.flatMap((answer) => answer.uiInteraction?.dryRunOnly || []);
    for (const flow of operatorFlows) {
      const snapshots = [flow, flow.afterExpand].filter(Boolean);
      if (Number(flow.latencyMs || 0) > 20000) {
        issues.push({
          layer: "ui-operator-flow",
          code: "slow-operator-answer",
          message: `${flow.question || "Operator question"} took ${Math.round(flow.latencyMs / 1000)}s to answer.`,
        });
      }
      if (flow.renderError) {
        issues.push({
          layer: "ui-operator-flow",
          code: "operator-answer-not-rendered",
          message: `${flow.question || "Operator question"} answered internally but did not render the matching visible UI in time: ${flow.renderError}`,
        });
      }
      for (const snapshot of snapshots) {
        if (!snapshot.title && !snapshot.content && !snapshot.text) {
          issues.push({ layer: "ui-operator-flow", code: "blank-answer", message: `${snapshot.question || flow.question} produced a blank answer.` });
        }
        if (snapshot.overflow?.length) {
          issues.push({
            layer: "ui-rendering",
            code: "visible-text-overflow",
            message: `${snapshot.question || flow.question} has ${snapshot.overflow.length} visibly overflowing element(s).`,
            examples: snapshot.overflow.slice(0, 3),
          });
        }
      }
      const visibleItemCount = Number(flow.itemCount || 0) ||
        Number(flow.domItemCount || 0) ||
        Number(flow.counts?.resultRows || 0) ||
        Number(flow.afterExpand?.itemCount || 0) ||
        Number(flow.afterExpand?.domItemCount || 0) ||
        Number(flow.afterExpand?.counts?.resultRows || 0);
      const visibleActionControlCount = [
        flow.counts?.previewAction,
        flow.counts?.generateDocument,
        flow.counts?.rowAction,
        flow.counts?.handleAction,
        flow.counts?.phoneLinks,
        flow.afterExpand?.counts?.previewAction,
        flow.afterExpand?.counts?.generateDocument,
        flow.afterExpand?.counts?.rowAction,
        flow.afterExpand?.counts?.handleAction,
        flow.afterExpand?.counts?.phoneLinks,
      ].reduce((sum, value) => sum + (Number(value) || 0), 0);
      if (visibleItemCount && Number(flow.actionCount || 0) > 0 && !visibleActionControlCount) {
        issues.push({
          layer: "ui-actions",
          code: "list-actions-hidden",
          message: `${flow.question || "Result list"} had ${flow.actionCount} backend action packet(s), but no visible action controls.`,
        });
      }
      if (visibleItemCount && Number(flow.actionCount || 0) > 0) {
        const rowActionCount = Number(flow.counts?.rowAction || 0) + Number(flow.afterExpand?.counts?.rowAction || 0);
        if (!rowActionCount) {
          issues.push({
            layer: "ui-actions",
            code: "list-row-actions-missing",
            message: `${flow.question || "Result list"} had ${flow.actionCount} backend action packet(s), but no row-level action controls.`,
          });
        }
      }
      if (flow.afterExpand?.domItems?.length && Number(flow.afterExpand?.actionCount || 0) > 0) {
        const missingExpandedRowActions = flow.afterExpand.domItems
          .filter((row) => /\b(?:needed|ready|blocked|push|customs hold|ground fees|dispatch|release|pickup|pod|confirm|find)\b/i.test(row.text || ""))
          .filter((row) => Number(row.rowActionCount || 0) === 0)
          .map((row) => ({ awb: row.awb || "", text: compact(row.text || "", 180) }));
        if (missingExpandedRowActions.length) {
          issues.push({
            layer: "ui-actions",
            code: "expanded-row-actions-missing",
            message: `${flow.question || "Expanded result list"} had actionable expanded rows without row-level controls.`,
            examples: missingExpandedRowActions.slice(0, 5),
          });
        }
      }
      const concreteShipmentAnswer = Boolean(
        normalizeAwb(flow.title || "") ||
        normalizeAwb(`${flow.latestText || ""} ${flow.content || ""}`),
      );
      if (/good morning|attention/i.test(flow.question || "") && !visibleItemCount && !concreteShipmentAnswer && !/no urgent|no shipment|nothing/i.test(flow.latestText || flow.text || "")) {
        issues.push({ layer: "ui-operator-flow", code: "morning-flow-no-items", message: "Morning attention question did not produce items or a clear empty-state." });
      }
      if (/pickup/i.test(flow.question || "") && !/pickup|no .*pickup/i.test(flow.latestText || flow.text || "")) {
        issues.push({ layer: "ui-operator-flow", code: "pickup-flow-unclear", message: "Pickup question did not produce pickup wording or a clear empty-state." });
      }
      if (/\bhow many\b/i.test(flow.question || "")) {
        const aggregateText = flow.latestText || flow.text || flow.content || "";
        if (!/\b\d+\b/.test(aggregateText)) {
          issues.push({ layer: "ui-operator-flow", code: "aggregate-count-missing", message: `${flow.question} did not produce a numeric count.` });
        }
        if (aggregateText.length > 900) {
          issues.push({ layer: "ui-operator-flow", code: "aggregate-answer-too-long", message: `${flow.question} produced a long answer instead of a concise computed count.` });
        }
      }
      const rowClicks = (flow.rowClicks || []).filter((rowClick) => !rowClick.skipped);
      const successfulRowClickCount = rowClicks.filter((rowClick) => rowClick.clicked).length;
      if (visibleItemCount && rowClicks.length && !successfulRowClickCount) {
        issues.push({ layer: "ui-operator-flow", code: "shipment-row-not-clickable", message: `${flow.question || "Result list"} had shipment rows but none could be opened.` });
      }
      for (const rowClick of rowClicks) {
        if (rowClick.skipped) continue;
        const detail = rowClick.detail || {};
        if (!rowClick.clicked && !successfulRowClickCount) {
          issues.push({ layer: "ui-operator-flow", code: "shipment-row-not-clickable", message: `Shipment row ${rowClick.awb || rowClick.shipmentId || rowClick.index} could not be opened.` });
        }
        const rowAwb = normalizeAwb(rowClick.awb || "");
        const detailAwbText = `${detail.title || ""} ${detail.content || ""} ${detail.latestText || ""}`;
        if (rowClick.clicked && rowAwb && !detailAwbText.replace(/\D/g, "").includes(rowAwb)) {
          issues.push({
            layer: "ui-operator-flow",
            code: "shipment-row-opened-wrong-awb",
            message: `Shipment row ${rowClick.awb || rowClick.shipmentId || rowClick.index} opened a different AWB response.`,
          });
        }
        if (detail.overflow?.length) {
          issues.push({
            layer: "ui-rendering",
            code: "shipment-detail-overflow",
            message: `Shipment row ${rowClick.awb || rowClick.shipmentId || rowClick.index} opened with overflowing UI text.`,
            examples: detail.overflow.slice(0, 3),
          });
        }
        if ((detail.counts?.previewAction || 0) > 0 && rowClick.preview?.clicked && !rowClick.preview?.previewVisible) {
          issues.push({ layer: "ui-actions", code: "preview-did-not-open", message: `Preview did not open for ${rowClick.awb || rowClick.shipmentId || rowClick.index}.` });
        }
        if (rowClick.preview?.previewVisible && !rowClick.preview?.closed) {
          issues.push({ layer: "ui-actions", code: "preview-did-not-close", message: `Preview did not close for ${rowClick.awb || rowClick.shipmentId || rowClick.index}.` });
        }
        if ((detail.counts?.copyAwb || 0) > 0 && !rowClick.copy?.clicked) {
          issues.push({ layer: "ui-actions", code: "copy-awb-not-clickable", message: `Copy AWB control was present but did not click for ${rowClick.awb || rowClick.shipmentId || rowClick.index}.` });
        }
        for (const button of detail.buttons || []) {
          if (button.selector === "tel" && !/^tel:\+?\d/.test(button.href || "")) {
            issues.push({ layer: "ui-actions", code: "bad-phone-link", message: `Phone action has invalid tel link: ${button.href || "(missing)"}` });
          }
        }
      }
    }
    let screenshotPath = "";
    try {
      const screenshot = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      screenshotPath = path.join(ARTIFACT_DIR, "latest-ui.png");
      await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data || "", "base64"));
    } catch {
      screenshotPath = "";
    }
    return { skipped: false, server, buttons, safeClicks, dryRunOnly, answers, operatorFlows, screenshotPath, issues };
  } catch (error) {
    issues.push({ layer: "ui-automation", code: "browser-audit-failed", message: error.message });
    return { skipped: false, server, answers, operatorFlows, buttons: {}, issues };
  } finally {
    await cdp.close().catch(() => {});
    await closeTab(page);
    await stopOwnedLocalServer(server);
  }
}

function groupBrowserAnswers(browser, awb) {
  const key = normalizeAwb(awb);
  return (browser.answers || []).filter((answer) => normalizeAwb(answer.question) === key);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function runCycle(options, cycle) {
  progress(`cycle ${cycle}: loading memory and open shipments`);
  const memoryEnv = options.memorySource === "hosted"
    ? { ...process.env, VERCEL: process.env.VERCEL || "1" }
    : localRuntimeEnv(process.env);
  const memory = await readOpsBrainMemory(ROOT_DIR, memoryEnv);
  const activeMemory = options.memorySource === "local-merged"
    ? await readLocalMemory(ROOT_DIR)
    : memory;
  const allKnownShipments = mergeShipments(memory)
    .filter((shipment) => normalizeAwb(shipment.awb));
  const mergedByAwb = new Map(allKnownShipments.map((shipment) => [normalizeAwb(shipment.awb), shipment]));
  const activeRecords = activeShipmentRows(activeMemory).length
    ? activeShipmentRows(activeMemory)
    : activeShipmentRows(memory);
  const activeRecordByAwb = new Map(activeRecords.map((shipment) => [normalizeAwb(shipment.awb || shipment.trackingNumber), shipment]));
  const activeAwbs = unique(activeRecords.map((shipment) => displayAwb(shipment.awb || shipment.trackingNumber)));
  const only = new Set(options.awbs.map(normalizeAwb).filter(Boolean));
  let shipments = only.size
    ? unique([...only].map(displayAwb)).map((awb) => {
      const key = normalizeAwb(awb);
      const activeRecord = activeRecordByAwb.get(key);
      return mergedByAwb.get(key) || (activeRecord ? { ...activeRecord, awb: activeRecord.awb || activeRecord.trackingNumber || awb } : null) || { awb };
    })
    : activeAwbs.map((awb) => {
      const key = normalizeAwb(awb);
      const activeRecord = activeRecordByAwb.get(key);
      return mergedByAwb.get(key) || (activeRecord ? { ...activeRecord, awb: activeRecord.awb || activeRecord.trackingNumber || awb } : null) || { awb };
    });
  progress(`cycle ${cycle}: probing TMS`);
  const tms = await probeTms();
  let auditedActiveRecords = activeRecords;
  if (!only.size && tms?.ok && Array.isArray(tms.orders) && tms.orders.length) {
    const liveOrderSet = new Set(tms.orders.map((order) => String(order || "").trim()).filter(Boolean));
    auditedActiveRecords = activeRecords.filter((shipment) => liveOrderSet.has(shipmentOrderId(shipment)));
    const liveAwbSet = new Set(auditedActiveRecords.map((shipment) => normalizeAwb(shipment.awb || shipment.trackingNumber)).filter(Boolean));
    shipments = shipments.filter((shipment) => {
      const key = normalizeAwb(shipment.awb);
      const activeRecord = activeRecordByAwb.get(key);
      return liveAwbSet.has(key) || liveOrderSet.has(shipmentOrderId(shipment)) || liveOrderSet.has(shipmentOrderId(activeRecord));
    });
  }
  const awbs = unique(shipments.map((shipment) => displayAwb(shipment.awb)));
  progress(`cycle ${cycle}: reading Gmail proof (${options.gmailSource})`);
  const gmail = await auditGmailProof(memory, awbs, options);
  const proofByAwb = new Map((gmail.proofs || []).map((proof) => [normalizeAwb(proof.awb), proof]));
  const tmsTruths = loadTmsTruths()
    .filter((truth) => awbs.some((awb) => normalizeAwb(awb) === normalizeAwb(truth.awb)));
  const customsTruths = loadCustomsTruths()
    .filter((truth) => awbs.some((awb) => normalizeAwb(awb) === normalizeAwb(truth.awb)));
  const truthByAwb = new Map();
  for (const truth of tmsTruths) truthByAwb.set(normalizeAwb(truth.awb), truth);
  for (const truth of customsTruths) {
    const key = normalizeAwb(truth.awb);
    if (shouldUseCustomsTruth(truthByAwb.get(key), truth)) {
      truthByAwb.set(key, truth);
    }
  }
  for (const shipment of allKnownShipments) {
    const key = normalizeAwb(shipment.awb);
    if (!key || (only.size && !only.has(key))) continue;
    const memoryTruth = truthFromShipmentMemory(shipment);
    if (shouldUseMemoryTruth(truthByAwb.get(key), memoryTruth)) {
      truthByAwb.set(key, memoryTruth);
    }
  }
  for (const proof of gmail.proofs || []) {
    const key = normalizeAwb(proof.awb);
    const proofTruth = truthFromProof(proof);
    if (shouldUseMemoryTruth(truthByAwb.get(key), proofTruth)) {
      truthByAwb.set(key, proofTruth);
    }
  }
  const generatedNotificationSnapshot = gmailDirectTest.buildOperatorNotificationsSnapshot(
    uniqueProofs([...(memory.gmailProof?.proofs || []), ...(gmail.proofs || [])]),
    new Date(),
  );
  const auditMemory = {
    ...memory,
    active: {
      ...(activeMemory.active || memory.active || {}),
      shipments: auditedActiveRecords,
    },
    gmailProof: {
      ...(memory.gmailProof || {}),
      proofs: uniqueProofs([...(memory.gmailProof?.proofs || []), ...(gmail.proofs || [])]),
    },
    shipmentEvents: gmail.shipmentEvents || memory.shipmentEvents,
    shipmentState: gmail.shipmentState || memory.shipmentState,
    operatorNotifications: generatedNotificationSnapshot,
  };
  const notifications = notificationAudit(generatedNotificationSnapshot || {}, new Date());
  const persistedNotifications = notificationAudit(memory.operatorNotifications || {}, new Date());
  const actionAudit = auditActionLayer(auditMemory, { awbs });
  const actionRows = new Map(actionAudit.rows.map((row) => [normalizeAwb(row.awb), row]));
  progress(`cycle ${cycle}: running browser/UI audit`);
  let browser;
  try {
    browser = await withTimeout(
      browserAudit(awbs, options),
      options.browserTimeoutMs,
      `Browser/UI audit exceeded ${Math.round(options.browserTimeoutMs / 1000)}s`,
    );
  } catch (error) {
    browser = {
      skipped: false,
      server: null,
      buttons: {},
      operatorFlows: [],
      screenshotPath: "",
      safeClicks: [],
      dryRunOnly: [],
      answers: [],
      issues: [{
        layer: "ui-automation",
        code: "browser-audit-timeout-or-failure",
        message: error.message || String(error),
      }],
    };
  }
  const rows = [];
  const inventory = [];
  for (const shipment of shipments) {
    const key = normalizeAwb(shipment.awb);
    const proof = proofByAwb.get(key) || null;
    const truth = truthByAwb.get(key) || null;
    const mergedShipment = mergeShipments(auditMemory).find((item) => normalizeAwb(item.awb) === key) || shipment;
    const boardPlan = controlRoomPlan(mergedShipment, auditMemory.actions);
    const serverAnswers = await serverAnswersForShipment(auditMemory, shipment.awb, options);
    const browserAnswers = groupBrowserAnswers(browser, shipment.awb);
    const actionAuditRow = actionRows.get(key);
    const issues = classifyMismatches({ truth, shipment: mergedShipment, boardPlan, actionAuditRow, serverAnswers, browserAnswers });
    const row = {
      awb: displayAwb(shipment.awb),
      normalizedAwb: key,
      station: shipment.station || shipment.airport || "",
      airline: shipment.airline || "",
      client: shipment.client || shipment.consignee || "",
      truth,
      current: canonicalSummary(mergedShipment, boardPlan),
      serverAnswers: serverAnswers.map((entry) => ({
        question: entry.question,
        source: entry.source,
        title: entry.answer.title || "",
        subtitle: entry.answer.subtitle || "",
        answer: compact(entry.answer.answer || "", 260),
        nextAction: compact(entry.answer.nextAction || entry.answer.plan?.nextAction || "", 260),
        actions: (entry.answer.actions || []).map((action) => ({
          label: action.label || "",
          channel: action.channel || "",
          targetName: action.targetName || "",
          readiness: action.readiness || action.preflight?.status || "",
          blockedReason: action.blockedReason || action.preflight?.reason || "",
        })),
      })),
      browserAnswers: browserAnswers.map((entry) => ({
        question: entry.question,
        captureSource: entry.captureSource || (entry.domOnly ? "dom-only" : ""),
        captureError: entry.uiInteraction?.error || "",
        submit: entry.submit || null,
        title: entry.title || "",
        subtitle: entry.subtitle || "",
        content: compact(entry.content || "", 260),
        text: compact(entry.text || "", 260),
        actions: entry.actions || [],
        items: entry.items || [],
      })),
      actionAudit: actionAuditRow ? {
        boardPhase: actionAuditRow.board.phase,
        brainPhase: actionAuditRow.brain.phase,
        criticalIssueCount: actionAuditRow.criticalIssueCount,
        issues: actionAuditRow.issues,
      } : null,
      proofCoverage: {
        foundFreshProof: Boolean(proof),
        foundTmsTruth: Boolean(!proof && truth?.source?.startsWith("tms-detail")),
        truthSource: truth?.source || (proof ? "gmail-proof" : ""),
        attachmentAuditCount: truth?.attachmentAuditCount || 0,
        evidenceCount: truth?.evidence?.length || 0,
      },
      issues,
      passed: issues.length === 0,
    };
    rows.push(row);
    inventory.push(buildInventoryRow({ row, shipment: mergedShipment, proof, boardPlan, actionAuditRow }));
  }
  const failedRows = rows.filter((row) => !row.passed);
  const sourceFreshness = buildSourceFreshness({
    memory: auditMemory,
    gmail,
    tms,
    maxAgeMinutes: options.freshMaxAgeMinutes,
    now: new Date(),
  });
  const inventoryStatus = inventoryAudit(inventory, only.size ? [...only] : awbs, {
    expectedActiveOrders: !only.size && Array.isArray(tms.orders) ? tms.orders : [],
  });
  const freshInventoryOk = sourceFreshness.status === "fresh-audit-passed" && inventoryStatus.ok;
  const freshnessIssues = [];
  if (!inventoryStatus.ok) {
    freshnessIssues.push({
      layer: "inventory",
      code: "inventory-shape-invalid",
      message: `Inventory has ${inventoryStatus.malformedAwbs.length} malformed AWB(s), ${inventoryStatus.duplicates.length} duplicate AWB(s), ${inventoryStatus.duplicateOrders?.length || 0} duplicate order(s), ${inventoryStatus.missingRequired.length} row(s) with missing required fields, ${inventoryStatus.missingActiveAwbs.length} missing active AWB(s), ${inventoryStatus.extraNonActiveAwbs.length} extra non-active AWB(s), ${inventoryStatus.missingLiveTmsOrders?.length || 0} missing live TMS order(s), and ${inventoryStatus.extraNonLiveTmsOrders?.length || 0} extra non-live TMS order(s).`,
    });
  }
  if (options.requireFreshInventory && sourceFreshness.status !== "fresh-audit-passed") {
    freshnessIssues.push({
      layer: "source-freshness",
      code: sourceFreshness.status,
      message: sourceFreshness.blockers.length
        ? `Live source unavailable: ${sourceFreshness.blockers.map((item) => `${item.source}: ${item.reason}`).join("; ")}`
        : `Required source(s) are stale: ${sourceFreshness.staleSources.join(", ")}`,
    });
  }
  return {
    cycle,
    ok: failedRows.length === 0
      && !browser.issues?.length
      && !notifications.issues?.length
      && inventoryStatus.ok
      && (!options.requireFreshInventory || freshInventoryOk),
    startedAt: new Date().toISOString(),
    tms,
    gmail: {
      ok: gmail.ok,
      dryRun: gmail.dryRun,
      updated: gmail.updated,
      threadCount: gmail.threadCount,
      queryCount: gmail.queryCount,
      attachmentAuditCount: gmail.attachmentAuditCount,
      shipmentEventCount: gmail.shipmentEventCount,
      shipmentStateCount: gmail.shipmentStateCount,
      operatorNotificationCount: gmail.operatorNotificationCount,
      fallback: gmail.fallback || "",
      source: gmail.source || "local-direct-gmail",
      snapshotTime: gmail.snapshotTime || "",
      writerVersion: gmail.writerVersion || "",
      snapshotAgeMinutes: gmail.snapshotAgeMinutes ?? null,
      error: gmail.error || "",
      updatedAwbs: gmail.updatedAwbs || [],
    },
    browser: {
      skipped: browser.skipped,
      server: browser.server,
      buttons: browser.buttons,
      operatorFlows: browser.operatorFlows || [],
      screenshotPath: browser.screenshotPath || "",
      safeClicks: browser.safeClicks,
      dryRunOnly: browser.dryRunOnly || [],
      issues: browser.issues || [],
    },
    notifications,
    persistedNotifications,
    sourceFreshness,
    inventoryStatus,
    freshnessIssues,
    counts: {
      openShipments: shipments.length,
      inventoryShipments: inventory.length,
      freshProofs: gmail.proofs?.length || 0,
      tmsTruths: tmsTruths.length,
      passed: rows.filter((row) => row.passed).length,
      failed: failedRows.length,
      issues: rows.reduce((sum, row) => sum + row.issues.length, 0) + (browser.issues?.length || 0) + (notifications.issues?.length || 0) + freshnessIssues.length,
      actionCriticalShipments: actionAudit.counts.criticalShipments,
      actionCriticalIssues: actionAudit.counts.criticalIssues,
    },
    inventory,
    rows,
    failedRows,
  };
}

function uniqueProofs(proofs) {
  const byAwb = new Map();
  for (const proof of proofs || []) {
    const key = normalizeAwb(proof.awb);
    if (!key) continue;
    const previous = byAwb.get(key);
    if (!previous || dateMs(proof.latestEventAt || proof.snapshotTime) >= dateMs(previous.latestEventAt || previous.snapshotTime)) {
      byAwb.set(key, proof);
    }
  }
  return [...byAwb.values()];
}

async function writeArtifacts(result) {
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(ARTIFACT_DIR, `${stamp}.json`);
  const latestJsonPath = path.join(ARTIFACT_DIR, "latest.json");
  const latestMdPath = path.join(ARTIFACT_DIR, "latest.md");
  const auditInventoryJsonPath = path.join(ARTIFACT_DIR, "latest-audit-inventory.json");
  const auditInventoryMdPath = path.join(ARTIFACT_DIR, "latest-audit-inventory.md");
  await fsp.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  await fsp.writeFile(latestJsonPath, `${JSON.stringify(result, null, 2)}\n`);
  await fsp.writeFile(latestMdPath, textReport(result));
  await fsp.writeFile(auditInventoryJsonPath, `${JSON.stringify({
    ok: result.final?.inventoryStatus?.ok && result.final?.sourceFreshness?.status === "fresh-audit-passed",
    generatedAt: result.final?.sourceFreshness?.generatedAt || new Date().toISOString(),
    sourceFreshness: result.final?.sourceFreshness || null,
    inventoryStatus: result.final?.inventoryStatus || null,
    shipments: result.final?.inventory || [],
  }, null, 2)}\n`);
  await fsp.writeFile(auditInventoryMdPath, inventoryReport(result));
  return { jsonPath, latestJsonPath, latestMdPath, auditInventoryJsonPath, auditInventoryMdPath };
}

function inventoryReport(result) {
  const final = result.final || {};
  const freshness = final.sourceFreshness || {};
  const lines = [
    `# PQ Active Shipment Truth Inventory`,
    ``,
    `Status: ${freshness.status || "unknown"}`,
    `Generated: ${freshness.generatedAt || ""}`,
    `Shipments: ${(final.inventory || []).length}`,
    `Inventory shape: ${final.inventoryStatus?.ok ? "PASS" : "FAIL"}`,
    ``,
  ];
  if (freshness.blockers?.length) {
    lines.push(`## Live Source Blockers`, ``);
    for (const blocker of freshness.blockers) {
      lines.push(`- ${blocker.source}: ${blocker.reason} (command: ${blocker.command})`);
    }
    lines.push(``);
  }
  if (freshness.staleSources?.length) {
    lines.push(`## Stale Sources`, ``);
    for (const source of freshness.staleSources) lines.push(`- ${source}`);
    lines.push(``);
  }
  lines.push(`## Shipments`, ``);
  for (const item of final.inventory || []) {
    const uncertainty = item.uncertainty?.flag ? `uncertain: ${item.uncertainty.reasons.join(", ")}` : "certain";
    const related = item.relatedWorkgroupHints?.relatedAwbs?.length
      ? ` related=${item.relatedWorkgroupHints.relatedAwbs.join(", ")}`
      : "";
    lines.push(`### ${item.awb} ${item.station} ${item.carrier}`);
    lines.push(`- Consignee: ${item.consignee}`);
    lines.push(`- State: ${item.canonicalState?.phase || ""} / ${item.canonicalState?.label || ""}`);
    lines.push(`- Risk: ${item.risk?.level || ""} - ${item.risk?.reason || ""}`);
    lines.push(`- Next action: ${item.nextAction || ""}`);
    lines.push(`- Suggested communication/action: ${item.suggestedCommunicationAction || ""}`);
    lines.push(`- Evidence: ${item.evidenceSource?.source || ""} (${item.evidenceSource?.latestEventAt || ""})`);
    lines.push(`- Uncertainty: ${uncertainty}${related}`);
    lines.push(``);
  }
  return `${lines.join("\n")}\n`;
}

function textReport(result) {
  const final = result.final;
  const gmailLine = final.gmail?.ok
    ? `${final.gmail.threadCount} threads, ${final.gmail.attachmentAuditCount} attachments audited (${final.gmail.source || "local-direct-gmail"}${final.gmail.snapshotAgeMinutes != null ? `, age ${final.gmail.snapshotAgeMinutes}m` : ""})`
    : "failed";
  const lines = [
    `# Operator Truth Loop`,
    ``,
    `Result: ${result.ok ? "PASS" : "FAIL"}`,
    result.goal
      ? `Goal stable passes: ${result.goal.stablePasses || 0}/${result.goal.requiredStablePasses || 0}`
      : `Cycles: ${result.cycles}`,
    result.goal
      ? `Goal status: ${result.goal.status || "unknown"}`
      : `Required consecutive passes: ${result.requiredPasses || 1}`,
    result.fatal ? `Fatal: [${result.fatal.layer}] ${result.fatal.code}: ${result.fatal.message}` : "",
    `Open shipments: ${final.counts.openShipments}`,
    `Inventory shipments: ${final.counts.inventoryShipments || 0}`,
    `Source freshness: ${final.sourceFreshness?.status || "unknown"}`,
    `Freshness max age: ${final.sourceFreshness?.maxAgeMinutes || "?"}m`,
    `Fresh Gmail proofs: ${final.counts.freshProofs}`,
    `TMS truth rows: ${final.counts.tmsTruths || 0}`,
    `Passed: ${final.counts.passed}`,
    `Failed: ${final.counts.failed}`,
    `Issues: ${final.counts.issues}`,
    `TMS: ${final.tms?.ok ? "available" : `unavailable (${final.tms?.reason || final.tms?.error || "unknown"})`}`,
    `Gmail: ${gmailLine}`,
    `Notifications: ${final.notifications?.notificationCount || 0} active, ${final.notifications?.pushableCount || 0} pushable, ${final.notifications?.genericPushableCount || 0} generic-pushable`,
    final.persistedNotifications?.notificationCount
      ? `Persisted notifications: ${final.persistedNotifications.notificationCount} active, ${final.persistedNotifications.genericPushableCount || 0} generic-pushable, age ${final.persistedNotifications.snapshotAgeHours ?? "?"}h`
      : "",
    `Browser buttons: ${final.browser?.skipped ? "skipped" : JSON.stringify(final.browser?.buttons || {})}`,
    `Operator UI flows: ${final.browser?.skipped ? "skipped" : (final.browser?.operatorFlows || []).length}`,
    `Deep open questions: ${final.browser?.skipped ? "skipped" : (result.deepQuestions ? "enabled" : "disabled")}`,
    `Browser dry-run-only controls: ${final.browser?.skipped ? "skipped" : (final.browser?.dryRunOnly || []).length}`,
    result.dashboardSync
      ? `Dashboard sync: ${result.dashboardSync.skipped ? "skipped" : result.dashboardSync.ok ? `applied (${result.dashboardSync.activeShipmentCount || 0} shipments, ${result.dashboardSync.actionCount || 0} actions)` : `failed (${result.dashboardSync.error || `${result.dashboardSync.phaseMismatches?.length || 0} phase mismatch(es)`})`}`
      : "",
    final.browser?.screenshotPath ? `Browser screenshot: ${final.browser.screenshotPath}` : "",
    ``,
  ].filter((line) => line !== "");
  if (final.notifications?.issues?.length) {
    lines.push(`## Notification Issues`, ``);
    for (const issue of final.notifications.issues) {
      lines.push(`- [${issue.layer}] ${issue.code}: ${issue.message}`);
    }
    lines.push(``);
  }
  if (final.freshnessIssues?.length) {
    lines.push(`## Freshness / Inventory Issues`, ``);
    for (const issue of final.freshnessIssues) {
      lines.push(`- [${issue.layer}] ${issue.code}: ${issue.message}`);
    }
    lines.push(``);
  }
  if (final.browser?.issues?.length) {
    lines.push(`## UI Issues`, ``);
    for (const issue of final.browser.issues) {
      lines.push(`- [${issue.layer}] ${issue.code}: ${issue.message}`);
    }
    lines.push(``);
  }
  if (final.failedRows.length) {
    lines.push(`## Failures`, ``);
    for (const row of final.failedRows) {
      lines.push(`### ${row.awb} ${row.station || ""} ${row.airline || ""}`);
      lines.push(`Truth: ${row.truth?.phase || "missing"}${row.truth?.source ? ` (${row.truth.source})` : ""} - ${compact(row.truth?.nextAction || row.truth?.summary || "", 160)}`);
      lines.push(`Current: ${row.current.phase} - ${compact(row.current.nextAction, 160)}`);
      for (const issue of row.issues) {
        lines.push(`- [${issue.layer}] ${issue.code}: ${issue.message}`);
      }
      lines.push(``);
    }
  }
  lines.push(`## Shipments`, ``);
  for (const row of final.rows) {
    lines.push(`- ${row.passed ? "PASS" : "FAIL"} ${row.awb} ${row.station || ""}: truth=${row.truth?.phase || "missing"}${row.truth?.source ? `/${row.truth.source}` : ""} current=${row.current.phase}`);
  }
  lines.push(``);
  return `${lines.join("\n")}\n`;
}

function tailText(value, max = 4000) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(text.length - max);
}

function goalGapFromResult(result = {}) {
  const final = result.final || {};
  if (result.fatal) {
    return {
      status: "blocked",
      layer: result.fatal.layer || "operator-truth-loop",
      code: result.fatal.code || "fatal",
      message: result.fatal.message || "Fatal audit failure.",
    };
  }
  if (final.sourceFreshness?.status === "live-source-unavailable") {
    const blocker = final.sourceFreshness.blockers?.[0] || {};
    return {
      status: "blocked",
      layer: "source-freshness",
      code: "live-source-unavailable",
      message: `${blocker.source || "live source"} unavailable: ${blocker.reason || "unknown"}`,
      command: blocker.command || "",
    };
  }
  if (final.sourceFreshness?.status === "stale-audit-secondary") {
    return {
      status: "needs-refresh",
      layer: "source-freshness",
      code: "stale-audit-secondary",
      message: `Required source(s) stale: ${(final.sourceFreshness.staleSources || []).join(", ") || "unknown"}`,
    };
  }
  if (final.inventoryStatus && !final.inventoryStatus.ok) {
    return {
      status: "needs-source-fix",
      layer: "inventory",
      code: "inventory-shape-invalid",
      message: `Inventory invalid: ${final.inventoryStatus.count || 0} rows, ${final.inventoryStatus.duplicates?.length || 0} duplicates, ${final.inventoryStatus.missingActiveAwbs?.length || 0} missing active AWBs, ${final.inventoryStatus.extraNonActiveAwbs?.length || 0} extra non-active AWBs.`,
    };
  }
  if (final.browser?.issues?.length) {
    const issue = final.browser.issues[0];
    return {
      status: "needs-ui-fix",
      layer: issue.layer || "ui",
      code: issue.code || "browser-issue",
      message: issue.message || "Browser/UI proof failed.",
    };
  }
  if (final.notifications?.issues?.length) {
    const issue = final.notifications.issues[0];
    return {
      status: "needs-notification-fix",
      layer: issue.layer || "notifications",
      code: issue.code || "notification-issue",
      message: issue.message || "Notification sanity proof failed.",
    };
  }
  if (final.failedRows?.length) {
    const row = final.failedRows[0];
    const issue = row.issues?.[0] || {};
    return {
      status: "needs-source-fix",
      layer: issue.layer || "canonical-state",
      code: issue.code || "shipment-mismatch",
      message: `${row.awb || "shipment"}: ${issue.message || "Shipment truth mismatch."}`,
      awb: row.awb || "",
    };
  }
  if (result.ok) {
    return {
      status: "passed",
      layer: "acceptance",
      code: "local-proof-pass",
      message: "Fresh inventory, canonical/API/UI/action/notification proof passed for this attempt.",
    };
  }
  return {
    status: "needs-investigation",
    layer: "operator-truth-loop",
    code: "unknown-failure",
    message: "Audit failed without a classified issue.",
  };
}

async function appendGoalLedger(entry) {
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  await fsp.appendFile(path.join(ARTIFACT_DIR, "goal-ledger.jsonl"), `${JSON.stringify(entry)}\n`);
  await fsp.writeFile(path.join(ARTIFACT_DIR, "latest-goal.json"), `${JSON.stringify(entry, null, 2)}\n`);
}

function runGoalCommand(label, command, args, timeoutMs) {
  const startedAt = new Date().toISOString();
  progress(`goal source refresh: ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    label,
    command: [command, ...args].join(" "),
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal || "",
    error: result.error?.message || "",
    stdoutTail: tailText(result.stdout || "", 4000),
    stderrTail: tailText(result.stderr || "", 4000),
  };
}

async function refreshGoalSourcesIfRequested(options, attempt) {
  if (!options.goalRefreshSources || attempt !== 1) return [];
  const commands = [
    runGoalCommand("live TMS/carrier refresh", process.execPath, [path.join(ROOT_DIR, "scripts", "live-refresh.js"), "all"], 25 * 60 * 1000),
    runGoalCommand("local ops snapshot rebuild", process.execPath, ["-e", "require('./ops-sync').runOpsSync({ rootDir: __dirname, onProgress: (event) => console.log(event.label) }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); })"], 15 * 60 * 1000),
  ];
  const refreshArtifact = {
    at: new Date().toISOString(),
    attempt,
    commands,
    ok: commands.every((command) => command.ok),
  };
  await fsp.writeFile(path.join(ARTIFACT_DIR, "latest-source-refresh.json"), `${JSON.stringify(refreshArtifact, null, 2)}\n`);
  return commands;
}

async function runBoundedAudit(options) {
  const cycles = [];
  let consecutivePasses = 0;
  let runError = null;
  for (let index = 0; index < options.cycles; index += 1) {
    let cycle;
    try {
      cycle = await runCycle(options, index + 1);
    } catch (error) {
      runError = error instanceof Error ? error : new Error(String(error));
      cycle = {
        cycle: index + 1,
        ok: false,
        startedAt: new Date().toISOString(),
        fatal: {
          layer: /gmail-token-refresh|Missing Gmail OAuth env/i.test(runError.message) ? "live-gmail" : "operator-truth-loop",
          code: /Missing Gmail OAuth env/i.test(runError.message) ? "missing-gmail-oauth-env" : "run-cycle-failed",
          message: runError.message,
        },
        tms: null,
        gmail: {
          ok: false,
          dryRun: true,
          error: runError.message,
          updated: 0,
          threadCount: 0,
          queryCount: 0,
          attachmentAuditCount: 0,
          shipmentEventCount: 0,
          shipmentStateCount: 0,
          operatorNotificationCount: 0,
          updatedAwbs: [],
        },
        browser: {
          skipped: true,
          issues: [],
        },
        notifications: {
          notificationCount: 0,
          pushableCount: 0,
          genericPushableCount: 0,
          issues: [],
        },
        persistedNotifications: {
          notificationCount: 0,
          genericPushableCount: 0,
        },
        sourceFreshness: {
          status: "live-source-unavailable",
          maxAgeMinutes: options.freshMaxAgeMinutes,
          generatedAt: new Date().toISOString(),
          rows: [],
          staleSources: [],
          blockers: [{
            source: /gmail-token-refresh|Missing Gmail OAuth env/i.test(runError.message) ? "gmail" : "operator-truth-loop",
            command: "node scripts/shipment-truth-audit-loop.js",
            reason: runError.message,
          }],
        },
        inventoryStatus: {
          ok: false,
          count: 0,
          malformedAwbs: [],
          duplicates: [],
          missingRequired: [],
        },
        freshnessIssues: [{
          layer: "operator-truth-loop",
          code: "run-cycle-failed",
          message: runError.message,
        }],
        counts: {
          openShipments: 0,
          inventoryShipments: 0,
          freshProofs: 0,
          tmsTruths: 0,
          passed: 0,
          failed: 0,
          issues: 1,
          actionCriticalShipments: 0,
          actionCriticalIssues: 0,
        },
        inventory: [],
        rows: [],
        failedRows: [],
      };
    }
    cycles.push(cycle);
    consecutivePasses = cycle.ok ? consecutivePasses + 1 : 0;
    if (consecutivePasses >= options.passes) break;
    if (!cycle.ok) break;
  }
  const final = cycles[cycles.length - 1];
  const result = {
    ok: Boolean(final?.ok) && consecutivePasses >= options.passes,
    rootDir: ROOT_DIR,
    mode: "operator-truth-gmail-proof-no-live-writes",
    gmailSource: options.gmailSource,
    memorySource: options.memorySource,
    hostedProofMaxAgeMinutes: options.hostedProofMaxAgeMinutes,
    freshMaxAgeMinutes: options.freshMaxAgeMinutes,
    requireFreshInventory: options.requireFreshInventory,
    deepQuestions: options.deepQuestions,
    cycles: cycles.length,
    requiredPasses: options.passes,
    consecutivePasses,
    fatal: cycles.find((cycle) => cycle.fatal)?.fatal || null,
    final,
    history: cycles,
  };
  result.artifacts = await writeArtifacts(result);
  result.dashboardSync = await syncDashboardAfterFreshPass(result, options);
  if (result.dashboardSync && !result.dashboardSync.ok) {
    result.ok = false;
    if (result.final) {
      result.final.freshnessIssues = [
        ...(result.final.freshnessIssues || []),
        {
          layer: "dashboard-sync",
          code: "dashboard-sync-after-pass-failed",
          message: result.dashboardSync.skipped
            ? result.dashboardSync.reason || "Dashboard sync skipped after audit."
            : result.dashboardSync.error || `${result.dashboardSync.phaseMismatches?.length || 0} phase mismatch(es) remained after dashboard rebuild.`,
        },
      ];
      if (result.final.counts) result.final.counts.issues = (result.final.counts.issues || 0) + 1;
    }
  }
  if (result.dashboardSync) {
    result.artifacts = await writeArtifacts(result);
  }
  return result;
}

function dashboardRebuildPhaseMismatches(inventory = []) {
  const active = readJsonIfExists("shipment-truth-packets.json", { shipments: [] });
  const activeByAwb = new Map((active.shipments || []).map((shipment) => [normalizeAwb(shipment.awb || shipment.trackingNumber), shipment]));
  return (inventory || [])
    .map((item) => {
      const key = normalizeAwb(item.awb || item.normalizedAwb);
      const activeShipment = activeByAwb.get(key);
      const dashboardPhase = activeShipment?.opsState?.phase || "";
      const inventoryPhase = item.canonicalState?.phase || "";
      if (!key || !inventoryPhase || dashboardPhase === inventoryPhase) return null;
      return {
        awb: displayAwb(item.awb || item.normalizedAwb),
        dashboardPhase,
        inventoryPhase,
      };
    })
    .filter(Boolean);
}

async function syncDashboardAfterFreshPass(result, options) {
  if (!options.syncDashboardAfterPass) return null;
  const final = result.final || {};
  if (!result.ok || final.sourceFreshness?.status !== "fresh-audit-passed" || !final.inventoryStatus?.ok) {
    return {
      ok: false,
      skipped: true,
      reason: "Audit did not produce a passing fresh inventory.",
    };
  }

  const startedAt = new Date().toISOString();
  progress("dashboard sync: applying fresh control-room inventory");
  try {
    const refresh = await runOpsSync({
      rootDir: ROOT_DIR,
      onProgress: (event) => progress(`dashboard sync: ${event.label || event.step || "refresh"}`),
    });
    const mismatches = dashboardRebuildPhaseMismatches(final.inventory || []);
    const actionQueue = readJsonIfExists("action-queue.json", { actions: [] });
    const active = readJsonIfExists("shipment-truth-packets.json", { shipments: [] });
    const payload = {
      ok: mismatches.length === 0,
      skipped: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      refresh,
      activeShipmentCount: active.shipments?.length || 0,
      actionCount: actionQueue.actions?.length || 0,
      phaseMismatches: mismatches,
    };
    if (!payload.ok) {
      progress(`dashboard sync: phase mismatch after rebuild (${mismatches.length})`);
    }
    await fsp.writeFile(path.join(ARTIFACT_DIR, "latest-dashboard-sync.json"), `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  } catch (error) {
    const payload = {
      ok: false,
      skipped: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await fsp.writeFile(path.join(ARTIFACT_DIR, "latest-dashboard-sync.json"), `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
}

async function runGoalAudit(options) {
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  const startedAt = Date.now();
  const history = [];
  const maxAttempts = options.goalMaxAttempts || Infinity;
  let stablePasses = 0;
  let finalResult = null;
  for (let attempt = 1; stablePasses < options.goalStablePasses; attempt += 1) {
    if (attempt > maxAttempts || Date.now() - startedAt > options.goalMaxMinutes * 60000) {
      const timeoutResult = finalResult || {
        ok: false,
        final: {
          counts: { openShipments: 0, inventoryShipments: 0, passed: 0, failed: 0, issues: 1 },
          sourceFreshness: {
            status: "live-source-unavailable",
            generatedAt: new Date().toISOString(),
            blockers: [{
              source: "goal-runner",
              command: "node scripts/shipment-truth-audit-loop.js --goal",
              reason: `Goal runner exceeded ${options.goalMaxMinutes} minutes or ${options.goalMaxAttempts || "unbounded"} attempts.`,
            }],
          },
          inventoryStatus: { ok: false },
          inventory: [],
          rows: [],
          failedRows: [],
        },
      };
      timeoutResult.goal = {
        ok: false,
        status: "blocked",
        stablePasses,
        requiredStablePasses: options.goalStablePasses,
        nextGap: {
          status: "blocked",
          layer: "goal-runner",
          code: "goal-runner-budget-exceeded",
          message: `Goal runner exceeded ${options.goalMaxMinutes} minutes or ${options.goalMaxAttempts || "unbounded"} attempts.`,
        },
        history,
      };
      timeoutResult.artifacts = await writeArtifacts(timeoutResult);
      await appendGoalLedger({ at: new Date().toISOString(), event: "goal-budget-exceeded", goal: timeoutResult.goal, artifacts: timeoutResult.artifacts });
      return timeoutResult;
    }

    const attemptStartedAt = new Date().toISOString();
    await appendGoalLedger({
      at: attemptStartedAt,
      event: "attempt-start",
      attempt,
      pid: process.pid,
      stablePasses,
      requiredStablePasses: options.goalStablePasses,
      acceptance: [
        "fresh-active-inventory",
        "canonical-db-api-ui-consistency",
        "operator-flows-and-actions",
        "notification-sanity",
        "browser-proof",
      ],
    });
    const refreshCommands = await refreshGoalSourcesIfRequested(options, attempt);
    const passOptions = { ...options, cycles: 1, passes: 1, requireFreshInventory: true, deepQuestions: true, skipBrowser: false };
    finalResult = await runBoundedAudit(passOptions);
    const nextGap = goalGapFromResult(finalResult);
    stablePasses = finalResult.ok ? stablePasses + 1 : 0;
    const attemptEntry = {
      at: new Date().toISOString(),
      event: "attempt-finish",
      attempt,
      startedAt: attemptStartedAt,
      ok: finalResult.ok,
      stablePasses,
      requiredStablePasses: options.goalStablePasses,
      refreshCommands,
      counts: finalResult.final?.counts || {},
      sourceFreshness: finalResult.final?.sourceFreshness?.status || "unknown",
      inventoryOk: Boolean(finalResult.final?.inventoryStatus?.ok),
      browserIssueCount: finalResult.final?.browser?.issues?.length || 0,
      failedRows: (finalResult.final?.failedRows || []).map((row) => ({
        awb: row.awb,
        issues: (row.issues || []).map((issue) => `${issue.layer}:${issue.code}`),
      })),
      nextGap,
      artifacts: finalResult.artifacts,
    };
    history.push(attemptEntry);
    await appendGoalLedger(attemptEntry);

    if (!finalResult.ok) {
      finalResult.goal = {
        ok: false,
        status: nextGap.status,
        stablePasses,
        requiredStablePasses: options.goalStablePasses,
        nextGap,
        history,
      };
      finalResult.artifacts = await writeArtifacts(finalResult);
      await appendGoalLedger({ at: new Date().toISOString(), event: "goal-needs-codex-fix", goal: finalResult.goal, artifacts: finalResult.artifacts });
      return finalResult;
    }
  }

  const productionProof = isProductionAuditUrl();
  finalResult.goal = {
    ok: true,
    status: productionProof ? "production-stable-checkpoint" : "local-stable-checkpoint",
    stablePasses,
    requiredStablePasses: options.goalStablePasses,
    nextGap: productionProof ? null : {
      status: "needs-production-verification",
      layer: "deployment",
      code: "production-proof-required",
      message: "Local goal proof passed consecutively; commit/push/deploy and run production proof before declaring complete.",
    },
    history,
  };
  finalResult.artifacts = await writeArtifacts(finalResult);
  await appendGoalLedger({ at: new Date().toISOString(), event: productionProof ? "production-stable-checkpoint" : "local-stable-checkpoint", goal: finalResult.goal, artifacts: finalResult.artifacts });
  return finalResult;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadLocalEnv(ROOT_DIR);
  const result = options.goal ? await runGoalAudit(options) : await runBoundedAudit(options);
    process.stdout.write(`${textReport(result)}Artifacts:\n- ${result.artifacts.latestJsonPath}\n- ${result.artifacts.latestMdPath}\n- ${result.artifacts.auditInventoryJsonPath}\n- ${result.artifacts.auditInventoryMdPath}\n`);
  if (result.goal) {
    process.stdout.write(`Goal status: ${result.goal.status}\n`);
    if (result.goal.nextGap) {
      process.stdout.write(`Next gap: [${result.goal.nextGap.layer}] ${result.goal.nextGap.code}: ${result.goal.nextGap.message}\n`);
    }
  }
  if (!result.ok && !options.exitZero) process.exitCode = 1;
}

if (require.main === module) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      writeInterruptedArtifact(`Received ${signal} before the audit reached a final verdict.`, signal.toLowerCase());
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  process.once("uncaughtException", (error) => {
    writeInterruptedArtifact(error?.stack || error?.message || String(error), "uncaught-exception");
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
  process.once("unhandledRejection", (error) => {
    writeInterruptedArtifact(error?.stack || error?.message || String(error), "unhandled-rejection");
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
  main().catch((error) => {
    writeInterruptedArtifact(error?.stack || error?.message || String(error), "main-failed");
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  runCycle,
  truthFromProof,
  truthFromShipmentMemory,
};

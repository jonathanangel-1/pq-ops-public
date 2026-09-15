"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  controlRoomPlan,
  mergeShipments,
  normalizeAwb,
  readLocalMemory,
  readOpsBrainMemory,
} = require("../lib/ops-brain-companion");
const {
  draftPayloadForAction,
  validateDraftableAction,
} = require("../lib/action-safety");
const { isCanonicalPlannerAction } = require("../lib/action-planner");

const DEFAULT_MAX_CYCLES = 1;
const NO_ACTION_PHASES = new Set([
  "delivered",
  "completed",
  "pre-arrival",
  "delivery-scheduled",
]);
const BLOCKED_NOTE_PHASES = new Set([
  "arrival-unverified",
  "storage-risk",
  "release-needed",
  "fees-needed",
  "arrival-incomplete",
  "pickup-blocked",
  "loading-blocked",
  "delivery-blocked",
  "conflict",
]);
const ACTION_REQUIRED_PHASES = new Set([
  ...BLOCKED_NOTE_PHASES,
  "approval-needed",
  "dispatch-ready",
  "delivered-pod-pending",
  "out-for-delivery",
  "pod-needed",
  "picked-up",
  "broker-awarded",
  "ready-for-pickup",
]);

function loadLocalEnv(rootDir, env = process.env) {
  for (const fileName of [".env.local", ".env"]) {
    const envPath = path.join(rootDir, fileName);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || env[match[1]]) continue;
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
}

function compact(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function displayAwb(value) {
  const awb = normalizeAwb(value);
  return awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : String(value || "");
}

function hasDatePhoneContactContamination(value) {
  const text = String(value || "");
  return (
    /\b(?:call|phone)\b[^.\n]{0,90}\bat\s+20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:\D|$)/i.test(text) ||
    /\b(?:call|phone)\b[^.\n]{0,90}\bat\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*[.,;:]?\s*\d{1,5}\b/i.test(text) ||
    /\b(?:call|phone)\b[^.\n]{0,90}\bat\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\s*[.,;:]?\s*\d{1,5}\b/i.test(text)
  );
}

function actionThreadOk(action) {
  if (action.threadPolicy !== "reply_existing") return true;
  return Boolean(
    action.replyMessageId ||
      action.conversation?.replyMessageId ||
      action.conversation?.threadId
  );
}

function usableEmailTarget(value) {
  const text = String(value || "").trim();
  return Boolean(
    text &&
      !/\b(?:unknown|not found|missing|n\/a|none)\b/i.test(text) &&
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
  );
}

function actionPacketProfile(action) {
  const channel = String(action?.channel || "").toLowerCase();
  const missing = [];
  const warnings = [];
  if (!action) {
    return {
      ready: false,
      kind: "missing-action",
      channel: "",
      label: "",
      missing: ["action packet"],
      warnings: [],
    };
  }

  if (hasDatePhoneContactContamination([
    action.label,
    action.reason,
    action.nextAction,
    action.body,
  ].filter(Boolean).join(" "))) {
    missing.push("valid station phone");
  }

  if (channel === "gmail") {
    if (!usableEmailTarget(action.targetEmail)) missing.push("recipient email");
    if (!action.subject) missing.push("draft subject");
    if (!action.body) missing.push("draft body");
    if (!actionThreadOk(action)) missing.push("reply thread");
    if (action.threadPolicy === "start_new" && action.type !== "quote-request") {
      warnings.push("starts new email instead of replying to an existing thread");
    }
    return {
      ready: missing.length === 0,
      kind: action.threadPolicy === "reply_existing" ? "same-thread-email-draft" : "new-email-draft",
      channel,
      type: action.type || "",
      label: action.label || "",
      targetName: action.targetName || "",
      threadPolicy: action.threadPolicy || "",
      threadTopic: action.threadTopic || "",
      missing,
      warnings,
    };
  }

  if (channel === "phone") {
    if (!(action.targetPhone || action.phone)) missing.push("phone number");
    if (!(action.body || action.nextAction)) missing.push("call script");
    return {
      ready: missing.length === 0,
      kind: "phone-call",
      channel,
      type: action.type || "",
      label: action.label || "",
      targetName: action.targetName || "",
      missing,
      warnings,
    };
  }

  if (channel === "platform") {
    if (!(action.problem || action.body || action.nextAction)) missing.push("operator prompt");
    return {
      ready: missing.length === 0,
      kind: "operator-state-check",
      channel,
      type: action.type || "",
      label: action.label || "",
      targetName: action.targetName || "",
      missing,
      warnings,
    };
  }

  if (channel === "couriercloud" || channel === "couriercloud-tms" || channel === "tms") {
    if (!(action.orderLink || action.tmsIntent)) missing.push("TMS target");
    return {
      ready: missing.length === 0,
      kind: "operator-approved-tms-action",
      channel,
      type: action.type || "",
      label: action.label || "",
      targetName: action.targetName || "",
      missing,
      warnings,
    };
  }

  if (channel === "document") {
    if (!(action.documentIntent || action.body || action.nextAction)) missing.push("document intent");
    return {
      ready: missing.length === 0,
      kind: "document-action",
      channel,
      type: action.type || "",
      label: action.label || "",
      targetName: action.targetName || "",
      missing,
      warnings,
    };
  }

  if (!channel) missing.push("action channel");
  return {
    ready: missing.length === 0,
    kind: channel || "unknown-action",
    channel,
    type: action.type || "",
    label: action.label || "",
    targetName: action.targetName || "",
    missing,
    warnings,
  };
}

function actionDraftContractIssues(action) {
  const issues = [];
  const channel = String(action?.channel || "").toLowerCase();
  if (!action || channel === "platform") return issues;
  if (channel === "document") {
    if (!(action.documentIntent || action.body || action.nextAction)) {
      issues.push("document action is missing its document intent/body");
    }
    return issues;
  }

  const validationError = validateDraftableAction(action.id, action);
  if (validationError) {
    issues.push(validationError);
    return issues;
  }

  let draftPlan = null;
  try {
    draftPlan = draftPayloadForAction(action, `${action.id}-loop-dry-run`, new Date().toISOString());
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return issues;
  }

  if (!draftPlan?.jobType) issues.push("draft plan is missing job type");
  if (channel === "gmail") {
    const payload = draftPlan.payload || {};
    if (draftPlan.jobType !== "draft_gmail_email") issues.push(`unexpected Gmail job type ${draftPlan.jobType}`);
    if (!usableEmailTarget(payload.to)) issues.push("draft payload is missing recipient email");
    if (!payload.subject) issues.push("draft payload is missing subject");
    if (!payload.body) issues.push("draft payload is missing body");
    if (action.threadPolicy === "reply_existing" && !(payload.replyMessageId || payload.conversation?.replyMessageId || payload.conversation?.threadId)) {
      issues.push("draft payload lost same-thread reply metadata");
    }
  }
  if ((channel === "couriercloud" || channel === "couriercloud-tms" || channel === "tms") && !(draftPlan.payload?.orderLink || draftPlan.payload?.tmsIntent)) {
    issues.push("TMS payload is missing order link/intent");
  }
  return issues;
}

function planText(plan) {
  return [
    plan?.phase,
    plan?.label,
    plan?.headline,
    plan?.blocker,
    plan?.nextAction,
    plan?.storage,
    plan?.quote,
    ...(plan?.actionsReady || []).map((action) => [action.label, action.reason, action.nextAction, action.body].filter(Boolean).join(" ")),
  ].filter(Boolean).join(" ");
}

function manualPickupExecutionProofPlan(plan) {
  const text = planText(plan);
  return /^(?:dispatch-ready|ready-for-pickup)$/i.test(String(plan?.phase || "")) &&
    /\bconfirm pickup execution\b/i.test(text) &&
    /\b(?:loaded proof|pickup proof)\b/i.test(text) &&
    /\bpod\b/i.test(text) &&
    !/\b(?:draft|email|send|approve|award|call)\b/i.test(text);
}

function planNeedsExecutableAction(plan) {
  if (!plan || NO_ACTION_PHASES.has(plan.phase)) return false;
  if (manualPickupExecutionProofPlan(plan)) return false;
  if (ACTION_REQUIRED_PHASES.has(plan.phase)) return true;
  if (Number(plan.urgency || 0) >= 50) return true;
  return /\b(?:request|collect|approve|award|confirm|call|email|push|follow up|follow-up|draft|send)\b/i.test(plan.nextAction || "");
}

function classifyPlanOutcome(plan, profiles) {
  const ready = profiles.filter((profile) => profile.ready);
  if (ready.length) {
    return {
      ok: true,
      kind: ready[0].kind,
      readyActions: ready.length,
      detail: ready[0].label,
    };
  }
  if (NO_ACTION_PHASES.has(plan.phase)) {
    return {
      ok: true,
      kind: "no-action-needed",
      readyActions: 0,
      detail: plan.label || plan.phase,
    };
  }
  if (BLOCKED_NOTE_PHASES.has(plan.phase) && (plan.blocker || plan.headline) && plan.nextAction && !planNeedsExecutableAction(plan)) {
    return {
      ok: true,
      kind: "blocked-evidence-note",
      readyActions: 0,
      detail: compact(plan.nextAction),
    };
  }
  return {
    ok: false,
    kind: "missing-executable-action",
    readyActions: 0,
    detail: compact(plan.nextAction || plan.headline || plan.label),
  };
}

function pushIssue(issues, severity, code, message, extra = {}) {
  issues.push({
    severity,
    code,
    message,
    ...extra,
  });
}

function auditPlan(plan, mode) {
  const issues = [];
  const profiles = (plan.actionsReady || []).map(actionPacketProfile);
  const outcome = classifyPlanOutcome(plan, profiles);
  const hasCanonicalPlannerAction = (plan.actionsReady || []).some(isCanonicalPlannerAction);

  if (hasDatePhoneContactContamination(planText(plan))) {
    pushIssue(
      issues,
      "critical",
      "date-as-phone-contact",
      `${mode} plan contains a date-shaped value where a phone number should be.`,
    );
  }

  profiles.forEach((profile) => {
    if (profile.missing.length) {
      pushIssue(
        issues,
        "critical",
        "incomplete-action-packet",
        `${mode} ${profile.kind} is missing ${profile.missing.join(", ")}.`,
        { action: profile.label, channel: profile.channel, type: profile.type },
      );
    }
    profile.warnings.forEach((warning) => {
      pushIssue(
        issues,
        "warning",
        "action-thread-warning",
        `${mode} ${profile.kind} ${warning}.`,
        { action: profile.label, channel: profile.channel, type: profile.type },
      );
    });
  });

  (plan.actionsReady || []).forEach((action) => {
    actionDraftContractIssues(action).forEach((issue) => {
      pushIssue(
        issues,
        "critical",
        "draft-contract-failed",
        `${mode} action cannot pass the draft/send contract: ${issue}.`,
        { action: action.label || action.id || "", channel: action.channel || "", type: action.type || "" },
      );
    });
  });

  if (!outcome.ok && planNeedsExecutableAction(plan)) {
    pushIssue(
      issues,
      "critical",
      "missing-executable-action",
      `${mode} plan needs an executable action, but only has "${outcome.detail || "no next action"}".`,
    );
  }

  if ((plan.actionsReady || []).length && !hasCanonicalPlannerAction && planNeedsExecutableAction(plan)) {
    pushIssue(
      issues,
      "critical",
      "non-canonical-action-layer",
      `${mode} plan surfaced actions that were not produced by the canonical action planner.`,
    );
  }

  return {
    outcome,
    actions: profiles,
    issues,
  };
}

function auditShipment(shipment, memory) {
  const actionContext = memory.actions || { actions: [], outboxRequests: [] };
  const explicitQuestionContext = {
    ...actionContext,
    question: `what needs action on ${shipment.awb}`,
  };
  const boardPlan = controlRoomPlan(shipment, actionContext);
  const brainPlan = controlRoomPlan(shipment, explicitQuestionContext);
  const board = auditPlan(boardPlan, "board");
  const brain = auditPlan(brainPlan, "brain");
  const issues = [...board.issues, ...brain.issues];
  const criticalIssues = issues.filter((issue) => issue.severity === "critical");
  return {
    awb: shipment.awb,
    normalizedAwb: normalizeAwb(shipment.awb),
    station: shipment.station || shipment.airport || "",
    airline: shipment.airline || "",
    client: shipment.client || shipment.consignee || "",
    completed: Boolean(shipment.completed),
    board: {
      phase: boardPlan.phase,
      label: boardPlan.label,
      urgency: boardPlan.urgency,
      nextAction: boardPlan.nextAction,
      outcome: board.outcome,
      actions: board.actions,
      actionPackets: boardPlan.actionsReady || [],
    },
    brain: {
      phase: brainPlan.phase,
      label: brainPlan.label,
      urgency: brainPlan.urgency,
      nextAction: brainPlan.nextAction,
      outcome: brain.outcome,
      actions: brain.actions,
      actionPackets: brainPlan.actionsReady || [],
    },
    issues,
    criticalIssueCount: criticalIssues.length,
  };
}

function localApiUrl(url, pathname) {
  const base = new URL(url);
  return new URL(pathname, `${base.protocol}//${base.host}`).toString();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function apiDryRunAction(apiUrl, action) {
  const channel = String(action?.channel || "").toLowerCase();
  const endpoint = channel === "document"
    ? localApiUrl(apiUrl, "/api/delivery-order?dryRun=1")
    : localApiUrl(apiUrl, "/api/actions/send?dryRun=1");
  const { response, payload } = await postJson(endpoint, {
    actionId: action.id,
    action,
    dryRun: true,
  });
  if (!response.ok || !payload?.dryRun) {
    throw new Error(payload?.error || `API dry-run failed with ${response.status}`);
  }
  if (channel === "gmail") {
    const request = payload.request || {};
    if (!usableEmailTarget(request.to)) throw new Error("API dry-run lost recipient email");
    if (!request.subject) throw new Error("API dry-run lost subject");
    if (!request.body) throw new Error("API dry-run lost body");
    if (action.threadPolicy === "reply_existing" && !(request.replyMessageId || request.conversation?.replyMessageId || request.conversation?.threadId)) {
      throw new Error("API dry-run lost same-thread reply metadata");
    }
  }
  return payload;
}

async function applyApiDryRunChecks(audit, options = {}) {
  if (!options.apiUrl) return audit;
  for (const row of audit.rows) {
    for (const mode of ["board", "brain"]) {
      const action = (row[mode]?.actionPackets || []).find((item) =>
        ["gmail", "couriercloud", "couriercloud-tms", "tms", "document"].includes(String(item.channel || "").toLowerCase()) &&
        !actionPacketProfile(item).missing.length
      );
      if (!action) continue;
      try {
        await apiDryRunAction(options.apiUrl, action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushIssue(
          row.issues,
          "critical",
          "api-dry-run-failed",
          `${mode} action failed the real API dry-run path: ${message}.`,
          { action: action.label || action.id || "", channel: action.channel || "", type: action.type || "" },
        );
      }
    }
    row.criticalIssueCount = row.issues.filter((issue) => issue.severity === "critical").length;
  }
  const criticalRows = audit.rows.filter((row) => row.criticalIssueCount);
  const warningRows = audit.rows.filter((row) => !row.criticalIssueCount && row.issues.some((issue) => issue.severity === "warning"));
  return {
    ...audit,
    ok: criticalRows.length === 0,
    counts: {
      ...audit.counts,
      criticalShipments: criticalRows.length,
      warningShipments: warningRows.length,
      criticalIssues: criticalRows.reduce((sum, row) => sum + row.criticalIssueCount, 0),
    },
    criticalRows,
    warningRows,
  };
}

function auditActionLayer(memory, options = {}) {
  const onlyAwbs = new Set((options.awbs || []).map(normalizeAwb).filter(Boolean));
  const shipments = mergeShipments(memory)
    .filter((shipment) => normalizeAwb(shipment.awb))
    .filter((shipment) => !onlyAwbs.size || onlyAwbs.has(normalizeAwb(shipment.awb)))
    .filter((shipment) => options.includeCompleted || !shipment.completed);
  const rows = shipments.map((shipment) => auditShipment(shipment, memory));
  const criticalRows = rows.filter((row) => row.criticalIssueCount);
  const warningRows = rows.filter((row) => !row.criticalIssueCount && row.issues.some((issue) => issue.severity === "warning"));
  const outcomeCounts = rows.reduce((acc, row) => {
    acc[row.brain.outcome.kind] = (acc[row.brain.outcome.kind] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: criticalRows.length === 0,
    counts: {
      shipments: rows.length,
      criticalShipments: criticalRows.length,
      warningShipments: warningRows.length,
      criticalIssues: criticalRows.reduce((sum, row) => sum + row.criticalIssueCount, 0),
      outcomeCounts,
    },
    rows,
    criticalRows,
    warningRows,
  };
}

async function loadMemory(rootDir, options = {}) {
  return options.local
    ? readLocalMemory(rootDir)
    : readOpsBrainMemory(rootDir, options.env || process.env);
}

async function maybeRefreshGmail(memory, options) {
  if (!options.refreshGmail) return null;
  const { runDirectGmailRefresh } = require("../lib/gmail-direct-ingest");
  const activeAwbs = mergeShipments(memory)
    .filter((shipment) => !shipment.completed)
    .map((shipment) => shipment.awb)
    .filter(Boolean);
  return runDirectGmailRefresh({
    awbs: options.awbs?.length ? options.awbs : activeAwbs,
    lookbackDays: options.lookbackDays,
    maxThreads: options.maxThreads,
    maxAttachmentPdfs: options.maxAttachmentPdfs,
    write: Boolean(options.writeRefresh),
    env: options.env || process.env,
  });
}

async function maybeRunSync(rootDir, options) {
  if (!options.sync) return null;
  const { runOpsSync } = require("../ops-sync");
  const events = [];
  const result = await runOpsSync({
    rootDir,
    onProgress: (event) => events.push(event),
  });
  return { ...result, events };
}

async function runActionLayerLoop(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "..");
  const maxCycles = Math.max(1, Number(options.cycles || DEFAULT_MAX_CYCLES));
  loadLocalEnv(rootDir, options.env || process.env);
  const cycles = [];
  let lastMemory = null;

  for (let index = 0; index < maxCycles; index += 1) {
    const cycleNumber = index + 1;
    const beforeMemory = await loadMemory(rootDir, options);
    const gmailRefresh = await maybeRefreshGmail(beforeMemory, options);
    const sync = await maybeRunSync(rootDir, options);
    lastMemory = gmailRefresh?.updated && options.writeRefresh || sync
      ? await loadMemory(rootDir, options)
      : beforeMemory;
    const audit = await applyApiDryRunChecks(auditActionLayer(lastMemory, options), options);
    cycles.push({
      cycle: cycleNumber,
      gmailRefresh,
      sync,
      audit,
    });
    if (audit.ok) break;
    if (!options.refreshGmail && !options.sync) break;
    if (gmailRefresh && !options.writeRefresh && !options.sync) break;
  }

  const finalCycle = cycles[cycles.length - 1] || {};
  const finalAudit = finalCycle.audit || auditActionLayer(lastMemory || { brain: { shipments: [] } }, options);
  return {
    ok: finalAudit.ok,
    rootDir,
    source: options.local ? "local" : "hosted-or-local-fallback",
    cycles: cycles.length,
    final: finalAudit,
    history: cycles,
  };
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg === "--local") options.local = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--exit-zero") options.exitZero = true;
    else if (arg === "--include-completed") options.includeCompleted = true;
    else if (arg === "--refresh-gmail") options.refreshGmail = true;
    else if (arg === "--write-refresh") options.writeRefresh = true;
    else if (arg === "--sync") options.sync = true;
    else if (arg.startsWith("--cycles=")) options.cycles = Number(arg.slice("--cycles=".length));
    else if (arg.startsWith("--lookback-days=")) options.lookbackDays = Number(arg.slice("--lookback-days=".length));
    else if (arg.startsWith("--max-threads=")) options.maxThreads = Number(arg.slice("--max-threads=".length));
    else if (arg.startsWith("--max-attachment-pdfs=")) options.maxAttachmentPdfs = Number(arg.slice("--max-attachment-pdfs=".length));
    else if (arg.startsWith("--api-url=")) options.apiUrl = arg.slice("--api-url=".length);
    else if (arg.startsWith("--awb=")) {
      options.awbs = [...(options.awbs || []), ...arg.slice("--awb=".length).split(",").map((item) => item.trim()).filter(Boolean)];
    } else if (arg.startsWith("--root=")) {
      options.rootDir = path.resolve(arg.slice("--root=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function textReport(result) {
  const final = result.final;
  const lines = [
    `Action layer loop ${result.ok ? "passed" : "failed"} after ${result.cycles} cycle${result.cycles === 1 ? "" : "s"}.`,
    `Source: ${result.source}`,
    `Shipments checked: ${final.counts.shipments}`,
    `Critical shipments: ${final.counts.criticalShipments}`,
    `Critical issues: ${final.counts.criticalIssues}`,
    `Outcomes: ${Object.entries(final.counts.outcomeCounts).map(([key, count]) => `${key}=${count}`).join(", ") || "none"}`,
  ];
  if (final.criticalRows.length) {
    lines.push("", "Critical:");
    for (const row of final.criticalRows.slice(0, 25)) {
      lines.push(`- ${displayAwb(row.awb)} ${row.station || ""} ${row.brain.phase}: ${row.brain.outcome.kind} (${compact(row.brain.nextAction, 120)})`);
      for (const issue of row.issues.filter((item) => item.severity === "critical").slice(0, 3)) {
        lines.push(`  ${issue.code}: ${issue.message}`);
      }
    }
    if (final.criticalRows.length > 25) lines.push(`- ... ${final.criticalRows.length - 25} more critical shipments`);
  }
  if (final.warningRows.length) {
    lines.push("", "Warnings:");
    for (const row of final.warningRows.slice(0, 10)) {
      const warning = row.issues.find((item) => item.severity === "warning");
      lines.push(`- ${displayAwb(row.awb)} ${row.brain.phase}: ${warning?.message || "warning"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (require.main === module) {
  const cliOptions = parseArgs(process.argv.slice(2));
  runActionLayerLoop(cliOptions)
    .then((result) => {
      process.stdout.write(result.final && result.history?.[0]?.audit && cliOptions.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : textReport(result));
      if (!result.ok && !cliOptions.exitZero) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  actionPacketProfile,
  auditActionLayer,
  auditShipment,
  hasDatePhoneContactContamination,
  runActionLayerLoop,
};

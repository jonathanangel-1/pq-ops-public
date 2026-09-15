#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const cronHandlers = {
  autonomousDrafts: require("../api/cron/autonomous-drafts"),
  eod: require("../api/cron/eod-report"),
  gmail: require("../api/cron/gmail-refresh"),
  morning: require("../api/cron/morning-refresh"),
  morningOperatorReport: require("../api/cron/morning-operator-report"),
  truthAudit: require("../api/cron/truth-audit"),
  truthShadow: require("../api/cron/truth-shadow-refresh"),
};
const { betaDraftModeContract } = require("../lib/supabase-agent");
const {
  CANONICAL_HEARTBEAT_PROMPT_PATH,
  DEFAULT_ACTIVATION_RECEIPT_PATH,
  DEFAULT_QUALITY_RECEIPT_PATH,
  currentHead,
  expectedHeartbeatAutomationContract,
  selectActivePhase,
  stableJson,
  validateHeartbeatActivationReceipt,
} = require("../lib/pikiio-agent-governance");

const AUTOMATION_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "automations");
const ROOT_DIR = path.resolve(__dirname, "..");
const TMS_REVIEW_EMAIL = "contact-053@demo-freight.example";
const PACKAGE_PATH = path.join(ROOT_DIR, "package.json");
const VERCEL_CONFIG_PATH = path.join(ROOT_DIR, "vercel.json");
const MORNING_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "morning-refresh.js");
const MORNING_OPERATOR_REPORT_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "morning-operator-report.js");
const EOD_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "eod-report.js");
const GMAIL_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "gmail-refresh.js");
const AUTONOMOUS_DRAFTS_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "autonomous-drafts.js");
const TRUTH_AUDIT_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "truth-audit.js");
const TRUTH_SHADOW_CRON_PATH = path.join(ROOT_DIR, "api", "cron", "truth-shadow-refresh.js");
const TRUTH_PRODUCTION_WITNESS_PATH = path.join(ROOT_DIR, "api", "truth", "production-witness.js");
const PIKIIO_PHASE_LEDGER_PATH = path.join(
  ROOT_DIR,
  "YLYI",
  "00_Product_Contract",
  "Pikiio_Agent_Phases.json",
);
const PIKIIO_HEARTBEAT_PROMPT_PATH = path.join(
  ROOT_DIR,
  "YLYI",
  "05_Agent_Runbooks",
  "Pikiio_Governed_Builder_Heartbeat_Prompt.md",
);
const PIKIIO_HEARTBEAT_ID = "pikiio-governed-builder-heartbeat";
const PIKIIO_HEARTBEAT_LEASE_COMMANDS = Object.freeze([
  "npm run pikiio:writer-lease -- acquire --run-id=<unique-run-id> --automation-id=pikiio-governed-builder-heartbeat --lease-ms=900000",
  "npm run pikiio:writer-lease -- assert --handle=<private-handle-path-from-acquire>",
  "npm run pikiio:writer-lease -- renew --handle=<private-handle-path-from-acquire>",
  "npm run pikiio:writer-lease -- assert --handle=<private-handle-path-from-acquire>",
  "npm run pikiio:writer-lease -- release --handle=<private-handle-path-from-acquire>",
]);
const GMAIL_QUEUE_PATH = path.join(ROOT_DIR, "scripts", "queue-gmail-refresh.js");
const GMAIL_REFRESH_CLAIM_PATH = path.join(ROOT_DIR, "scripts", "claim-gmail-refresh.js");
const AUTONOMOUS_DRAFTS_QUEUE_PATH = path.join(ROOT_DIR, "scripts", "queue-autonomous-drafts.js");
const AGENT_WORKER_PATH = path.join(ROOT_DIR, "scripts", "pq-agent-worker.js");
const MORNING_REFRESH_SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "run-morning-refresh.js");
const SYNC_SNAPSHOTS_PATH = path.join(ROOT_DIR, "scripts", "sync-supabase-snapshots.js");
const GMAIL_CLAIM_PRIORITY_MIGRATION_PATH = path.join(ROOT_DIR, "supabase", "migrations", "20260625130000_prioritize_stale_email_proof_claims.sql");

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exit(1);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readCanonicalPikiioHeartbeatPrompt(filePath = PIKIIO_HEARTBEAT_PROMPT_PATH) {
  const source = readFile(filePath);
  assert(!source.includes("\r"), "Canonical heartbeat prompt must use LF newlines", {
    file: path.relative(ROOT_DIR, filePath),
  });
  return source.endsWith("\n") ? source.slice(0, -1) : source;
}

function extractPikiioHeartbeatLeaseCommands(prompt) {
  return Array.from(
    String(prompt).matchAll(
      /^`(npm run pikiio:writer-lease -- [^`\r\n]+)`$/gm,
    ),
    (match) => match[1],
  );
}

function validatePikiioHeartbeatPrompt(prompt) {
  const source = String(prompt);
  const errors = [];
  const leaseCommands = extractPikiioHeartbeatLeaseCommands(source);

  if (!source || source !== source.trim()) {
    errors.push("heartbeat prompt must be nonempty with no leading/trailing whitespace");
  }
  if (source.includes("\r")) {
    errors.push("heartbeat prompt must use LF newlines");
  }
  if (
    leaseCommands.length !== PIKIIO_HEARTBEAT_LEASE_COMMANDS.length ||
    leaseCommands.some(
      (command, index) => command !== PIKIIO_HEARTBEAT_LEASE_COMMANDS[index],
    )
  ) {
    errors.push("heartbeat lease commands or their order do not match the pinned contract");
  }

  const acquire = leaseCommands[0] || "";
  if (
    acquire.includes("--phase") ||
    acquire.includes("--lane") ||
    acquire.includes("--handle") ||
    acquire.includes("--goal-objective") ||
    acquire.includes("--goal-thread-id")
  ) {
    errors.push("heartbeat acquisition must not override ledger or capability scope");
  }
  for (const command of leaseCommands.slice(1)) {
    if (
      !command.includes("--handle=<private-handle-path-from-acquire>") ||
      command.includes("--run-id") ||
      command.includes("--phase") ||
      command.includes("--lane") ||
      command.includes("--automation-id") ||
      command.includes("--lease-ms")
    ) {
      errors.push("heartbeat control commands must carry only the private handle argument");
      break;
    }
  }

  const requiredExactText = [
    "Require an active goal, its exact objective, and its exact task ID.",
    "Require exactly one active phase",
    "a completely clean checkout before requesting write authority",
    "valid, unexpired, transition-bound activation receipt for the current active phase",
    "The phase and lane are selected only by Pikiio_Agent_Phases.json",
    "Never read, copy, print, log, persist, summarize, commit, upload, or include in a run receipt the handle file contents, capability bytes",
    "Production is categorically disabled for this heartbeat.",
    "Do not run pikiio:production.",
    "Production requires a separate, explicit user-approved ceremony outside this automation.",
    "Unchanged polling stays silent.",
  ];
  for (const text of requiredExactText) {
    if (!source.includes(text)) {
      errors.push(`heartbeat prompt is missing pinned text: ${text}`);
    }
  }

  for (const command of [
    "npm run pikiio:goal-guard",
    "npm run pikiio:dirty-guard",
    "node scripts/verify-automation-contracts.js",
  ]) {
    if (!source.includes(command)) {
      errors.push(`heartbeat prompt is missing preflight command: ${command}`);
    }
  }

  if (
    /`[^`\r\n]*(?:pikiio:production|--production-action)[^`\r\n]*`/.test(
      source,
    )
  ) {
    errors.push("heartbeat prompt must not contain an executable production command");
  }

  return {
    valid: errors.length === 0,
    errors,
    sha256: sha256(source),
    leaseCommands,
  };
}

function comparePikiioHeartbeatPrompt(configuredPrompt, canonicalPrompt) {
  const validation = validatePikiioHeartbeatPrompt(canonicalPrompt);
  const configured = String(configuredPrompt);
  return {
    valid: validation.valid && configured === canonicalPrompt,
    errors: [
      ...validation.errors,
      ...(configured === canonicalPrompt
        ? []
        : ["configured heartbeat prompt differs from the canonical prompt"]),
    ],
    configuredSha256: sha256(configured),
    canonicalSha256: sha256(canonicalPrompt),
  };
}

function validatePikiioHeartbeatLedgerContract(ledger, canonicalPrompt) {
  const expected = expectedHeartbeatAutomationContract(
    ledger?.codexGoal?.threadId,
  );
  const errors = [];
  if (stableJson(ledger?.automationContract) !== stableJson(expected)) {
    errors.push("phase ledger automationContract differs from the immutable contract");
  }
  const promptValidation = validatePikiioHeartbeatPrompt(canonicalPrompt);
  if (!promptValidation.valid) errors.push(...promptValidation.errors);
  if (ledger?.automationContract?.promptPath !== CANONICAL_HEARTBEAT_PROMPT_PATH) {
    errors.push("phase ledger heartbeat prompt path is not canonical");
  }
  if (
    ledger?.automationContract?.promptSha256 !== promptValidation.sha256
  ) {
    errors.push("phase ledger heartbeat prompt hash does not match canonical content");
  }
  return {
    valid: errors.length === 0,
    errors,
    expected,
    promptSha256: promptValidation.sha256,
  };
}

function readAutomation(id) {
  const filePath = path.join(AUTOMATION_DIR, id, "automation.toml");
  if (!fs.existsSync(filePath)) return null;
  const source = fs.readFileSync(filePath, "utf8");
  const field = (name) => {
    const match = source.match(new RegExp(`^${name}\\s*=\\s*\"((?:\\\\.|[^\"\\\\])*)\"`, "m"));
    return match ? JSON.parse(`"${match[1]}"`) : "";
  };
  return {
    id,
    filePath,
    source,
    kind: field("kind"),
    status: field("status"),
    rrule: field("rrule"),
    prompt: field("prompt"),
    targetThreadId: field("target_thread_id"),
  };
}

function assertAutomation(id, expectedStatus = "ACTIVE") {
  const automation = readAutomation(id);
  assert(automation, "Expected Codex automation is missing", { id, automationDir: AUTOMATION_DIR });
  assert(automation.status === expectedStatus, "Automation status changed", {
    id,
    status: automation.status,
    expectedStatus,
  });
  return automation;
}

function verifyGmailProcessor() {
  const automation = assertAutomation("pq-gmail-job-processor", "PAUSED");
  const prompt = automation.prompt;
  const lowerPrompt = prompt.toLowerCase();
  assert(automation.kind === "cron", "Gmail processor must run in fresh cron contexts, not one long-lived thread heartbeat", {
    kind: automation.kind,
  });
  assert(automation.rrule === "RRULE:FREQ=DAILY;BYHOUR=6;BYMINUTE=0;BYSECOND=0", "Paused Gmail fallback schedule changed", {
    rrule: automation.rrule,
  });
  assert(!automation.source.includes("target_thread_id"), "Gmail processor must not target a persistent thread", {
    id: automation.id,
  });
  assert(lowerPrompt.includes("vercel direct gmail cron"), "Paused Gmail processor must point to the Vercel direct Gmail lane");
  assert(lowerPrompt.includes("should not process email_refresh"), "Paused Gmail processor must not imply active Codex Gmail processing");
  verifyFixPushCleanContract(automation);
  return automation;
}

function verifyDailyCron(id, expectedRrule, requiredPromptText, expectedStatus = "ACTIVE", options = {}) {
  const automation = options.optional && !readAutomation(id)
    ? null
    : assertAutomation(id, expectedStatus);
  if (!automation) {
    return {
      id,
      status: "MISSING",
      rrule: "",
      optional: true,
    };
  }
  const lowerPrompt = automation.prompt.toLowerCase();
  assert(automation.kind === "cron", "Daily automation must stay cron-backed", {
    id,
    kind: automation.kind,
  });
  assert(automation.rrule === expectedRrule, "Daily automation schedule changed", {
    id,
    rrule: automation.rrule,
    expectedRrule,
  });
  for (const text of requiredPromptText) {
    assert(lowerPrompt.includes(String(text).toLowerCase()), "Daily automation prompt is missing required beta contract text", {
      id,
      text,
    });
  }
  assert(!/draft\/test artifact|test artifact/i.test(automation.prompt), "Daily automation prompt must use review-draft language, not test-artifact language", {
    id,
  });
  return automation;
}

function verifyFixPushCleanContract(automation) {
  const prompt = String(automation?.prompt || "");
  const lowerPrompt = prompt.toLowerCase();
  for (const text of [
    "deterministic repo bugs",
    "update the matching YLYI incident/backtest before code edits",
    "npm run verify:beta",
    "commit the repo changes",
    "push the current branch to the remote",
    "production deploys",
  ]) {
    assert(lowerPrompt.includes(text.toLowerCase()), "Pikiio automation must fix deterministic bugs, then commit/push and clean the worktree after verification", {
      id: automation.id,
      text,
    });
  }
  assert(
    lowerPrompt.includes("require explicit user approval") ||
      lowerPrompt.includes("require explicit human approval"),
    "Pikiio automation must say irreversible production/live actions require explicit approval",
    { id: automation.id },
  );
  assert(
    lowerPrompt.includes("leave the repo worktree clean") ||
      lowerPrompt.includes("leave the worktree clean"),
    "Pikiio automation must require a clean worktree after verified repo fixes",
    { id: automation.id },
  );
}

function verifyPikiioBuilderHeartbeat() {
  const ledger = JSON.parse(readFile(PIKIIO_PHASE_LEDGER_PATH));
  const automation = readAutomation(PIKIIO_HEARTBEAT_ID);
  assert(automation, "Expected Codex automation is missing", {
    id: PIKIIO_HEARTBEAT_ID,
  });
  const canonicalPrompt = readCanonicalPikiioHeartbeatPrompt();
  const ledgerContract = validatePikiioHeartbeatLedgerContract(
    ledger,
    canonicalPrompt,
  );
  assert(
    ledgerContract.valid,
    "Pikiio phase ledger does not bind the exact heartbeat contract",
    { errors: ledgerContract.errors },
  );
  const promptComparison = comparePikiioHeartbeatPrompt(
    automation.prompt,
    canonicalPrompt,
  );
  assert(
    promptComparison.valid,
    "Pikiio heartbeat prompt is not the exact checked-in governance contract",
    {
      errors: promptComparison.errors,
      configuredSha256: promptComparison.configuredSha256,
      canonicalSha256: promptComparison.canonicalSha256,
      canonicalPath: path.relative(ROOT_DIR, PIKIIO_HEARTBEAT_PROMPT_PATH),
    },
  );
  assert(
    ["ACTIVE", "PAUSED"].includes(automation.status),
    "Pikiio builder heartbeat status must be ACTIVE or PAUSED",
    { status: automation.status },
  );
  assert(
    automation.id === ledger.automationContract.id &&
      automation.kind === ledger.automationContract.kind &&
      automation.rrule === ledger.automationContract.rrule &&
      automation.targetThreadId === ledger.automationContract.targetThreadId,
    "Configured heartbeat identity, kind, cadence, or task differs from the ledger",
    {
      configured: {
        id: automation.id,
        kind: automation.kind,
        rrule: automation.rrule,
        targetThreadId: automation.targetThreadId,
      },
      ledger: ledger.automationContract,
    },
  );
  if (ledger.activePhaseId === "GOV-00") {
    assert(
      automation.status === ledger.automationContract.statusBeforeActivation,
      "Pikiio builder must remain paused while GOV-00 is active",
    );
  } else if (automation.status === "ACTIVE") {
    const governancePhase = ledger.phases.find((phase) => phase.id === "GOV-00");
    assert(
      ["complete", "promoted"].includes(governancePhase?.status),
      "An active builder requires terminal GOV-00",
      { governanceStatus: governancePhase?.status },
    );
    assert(
      fs.existsSync(DEFAULT_ACTIVATION_RECEIPT_PATH) &&
        fs.existsSync(DEFAULT_QUALITY_RECEIPT_PATH),
      "An active builder requires activation and strict quality receipts",
      {
        activationReceiptPath: DEFAULT_ACTIVATION_RECEIPT_PATH,
        qualityReceiptPath: DEFAULT_QUALITY_RECEIPT_PATH,
      },
    );
    const activationReceipt = JSON.parse(
      readFile(DEFAULT_ACTIVATION_RECEIPT_PATH),
    );
    const qualityReceipt = JSON.parse(readFile(DEFAULT_QUALITY_RECEIPT_PATH));
    const activation = validateHeartbeatActivationReceipt(activationReceipt, {
      ledger,
      phase: selectActivePhase(ledger),
      head: currentHead(ROOT_DIR),
      qualityReceipt,
      repoRoot: ROOT_DIR,
    });
    assert(
      activation.valid,
      "Active builder activation receipt is stale, mismatched, or invalid",
      { errors: activation.errors },
    );
  }
  const lowerPrompt = canonicalPrompt.toLowerCase();
  assert(automation.kind === "heartbeat", "Pikiio builder must use the current task heartbeat", {
    kind: automation.kind,
  });
  assert(
    automation.rrule === "FREQ=MINUTELY;INTERVAL=20",
    "Pikiio builder heartbeat cadence changed",
    { rrule: automation.rrule },
  );
  assert(
    automation.targetThreadId === "019f79d1-bd5e-7822-8876-9ebc0d1c78d1",
    "Pikiio builder heartbeat must remain attached to the governed goal task",
    { targetThreadId: automation.targetThreadId },
  );
  for (const text of [
    "pikiio_agent_phases.json",
    "npm run pikiio:goal-guard",
    "npm run pikiio:dirty-guard",
    "pikiio:writer-lease",
    "pikiio:run-receipt",
    "exactly one",
    "one mutation class",
    "05:45",
    "morning refresh",
    "natural",
    "degraded truth",
    "run receipt",
    "quality gauntlet",
    "executable gherkin",
    "changed-code coverage",
    "mutation testing",
    "never weaken a test",
    "do not send gmail",
    "do not mutate tms",
    "do not approve freight",
    "do not release cargo",
    "do not book carriers",
    "do not approve drivers",
    "do not upload operational documents",
    "do not auto-accept ambiguous model claims",
  ]) {
    assert(
      lowerPrompt.includes(text),
      "Pikiio heartbeat is missing a required governance instruction",
      { text },
    );
  }
  assert(
    lowerPrompt.includes("acquire") &&
      lowerPrompt.includes("renew") &&
      lowerPrompt.includes("release"),
    "Pikiio heartbeat must explicitly manage the global writer lease lifecycle",
  );
  assert(
    lowerPrompt.includes("unchanged") && lowerPrompt.includes("silent"),
    "Unchanged heartbeat polling must stay silent",
  );
  const memoryPath = path.join(
    AUTOMATION_DIR,
    "pikiio-governed-builder-heartbeat",
    "memory.md",
  );
  assert(fs.existsSync(memoryPath), "Pikiio heartbeat continuity memory is missing", {
    memoryPath,
  });
  const memory = readFile(memoryPath);
  assert(
    memory.includes("pikiio-agent-heartbeat-memory-v1") &&
      memory.includes("append-only") &&
      memory.includes("exact next action"),
    "Pikiio heartbeat memory must carry an append-only continuity contract",
  );
  return {
    id: automation.id,
    status: automation.status,
    rrule: automation.rrule,
    activePhaseId: ledger.activePhaseId,
  };
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function verifyLocalMorningRefreshContract() {
  const packageJson = JSON.parse(readFile(PACKAGE_PATH));
  assert(packageJson.scripts?.["morning:refresh"] === "node scripts/run-morning-refresh.js", "Package scripts must expose the local morning refresh runner", {
    script: packageJson.scripts?.["morning:refresh"],
  });
  assert(packageJson.scripts?.["supabase:sync:sources"] === "node scripts/sync-supabase-snapshots.js", "Package scripts must expose source-only snapshot sync", {
    script: packageJson.scripts?.["supabase:sync:sources"],
  });
  assert(
    packageJson.scripts?.["truth:wait:relational-morning"]
      === "node scripts/wait-for-relational-morning-publication.js",
    "Package scripts must expose the read-only relational morning publication gate",
    { script: packageJson.scripts?.["truth:wait:relational-morning"] },
  );
  assert(packageJson.scripts?.["hosted:canonical-refresh"] === "node scripts/run-hosted-canonical-refresh.js", "Package scripts must expose the sole hosted canonical refresh", {
    script: packageJson.scripts?.["hosted:canonical-refresh"],
  });
  assert(packageJson.scripts?.["supabase:sync:truth"] === undefined, "The competing local truth publication alias must be removed");

  const runner = readFile(MORNING_REFRESH_SCRIPT_PATH);
  const sourceSyncIndex = runner.indexOf('runNpmScript("supabase:sync:sources"');
  const canonicalPublishIndex = runner.indexOf('runNpmScript("truth:wait:relational-morning"');
  const draftSafetyIndex = runner.indexOf('runNpmScript("verify:draft-safety"');
  const automationIndex = runner.indexOf('runNpmScript("verify:automations"');
  assert(
    sourceSyncIndex !== -1 && canonicalPublishIndex !== -1 && draftSafetyIndex !== -1 && automationIndex !== -1 &&
      sourceSyncIndex < canonicalPublishIndex && canonicalPublishIndex < draftSafetyIndex && draftSafetyIndex < automationIndex,
    "Morning refresh must commit source truth, read back relational production, then run draft safety and automation contracts in that order",
    {
    file: path.relative(ROOT_DIR, MORNING_REFRESH_SCRIPT_PATH),
    },
  );
  assert(
    runner.includes("truthPublished") &&
      runner.includes("source-sync") &&
      runner.includes("blockedAt") &&
      runner.includes("canonical-publisher") &&
      runner.includes("validateTruthLedgerReceipt") &&
      runner.includes('"committed"') &&
      !runner.includes('runNpmScript("refresh"') &&
      !runner.includes('runNpmScript("supabase:sync:truth"') &&
      !runner.includes('runNpmScript("hosted:canonical-refresh"') &&
      !runner.includes('runNpmScript("truth:refresh:local"') &&
      runner.includes("process.exitCode = result.truthPublished ? 2 : 1"),
    "Morning refresh must require the committed ledger receipt, stop on relational read-back failure, and never invoke legacy or competing truth publishers",
    { file: path.relative(ROOT_DIR, MORNING_REFRESH_SCRIPT_PATH) },
  );

  const hostedRefreshSource = readFile(path.join(ROOT_DIR, "scripts", "run-hosted-canonical-refresh.js"));
  assert(
    hostedRefreshSource.includes("/api/email-refresh/run-now?force=1") &&
      hostedRefreshSource.includes("/api/snapshots?keys=shipment-truth-packets&metadata=1") &&
      hostedRefreshSource.includes("createServerProtectedOriginClient") &&
      hostedRefreshSource.includes("PQ_EMAIL_REFRESH_RUN_NOW_TOKEN") &&
      hostedRefreshSource.includes("PQ_TRUTH_PROTECTION_BYPASS_SECRET") &&
      hostedRefreshSource.includes("VERCEL_AUTOMATION_BYPASS_SECRET") &&
      hostedRefreshSource.includes("canonical-publisher-v1") &&
      hostedRefreshSource.includes("HOSTED_CANONICAL_READBACK_STALE"),
    "Morning hosted refresh must cross Vercel protection, use route-specific authorization, force the canonical publisher, and prove a fresh packet by metadata read-back",
    { file: "scripts/run-hosted-canonical-refresh.js" },
  );
  const runNowSource = readFile(path.join(ROOT_DIR, "api", "email-refresh", "run-now.js"));
  assert(
    runNowSource.includes("PQ_EMAIL_REFRESH_RUN_NOW_TOKEN") &&
      runNowSource.includes("tokenMatches(bearer(request), routeSecret)") &&
      runNowSource.includes("EMAIL_REFRESH_RUN_NOW_UNAUTHORIZED") &&
      runNowSource.includes("private, no-store"),
    "Server-to-server email refresh must authenticate the inbound request before using internal cron authority",
    { file: "api/email-refresh/run-now.js" },
  );

  const syncSource = readFile(SYNC_SNAPSHOTS_PATH);
  assert(
    syncSource.includes("SOURCE_SNAPSHOTS") &&
      syncSource.includes("FORBIDDEN_DERIVED_KEYS") &&
      syncSource.includes("SOURCE_SYNC_DERIVED_KEY_FORBIDDEN") &&
      !syncSource.includes('["shipment-truth-packets", "shipment-truth-packets.json"]'),
    "Supabase sync must publish source snapshots only and reject canonical/derived keys",
    { file: path.relative(ROOT_DIR, SYNC_SNAPSHOTS_PATH) },
  );
}

async function callCronHandler(handler, url, headers = {}) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = url;
  request.headers = headers;

  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(content) {
        try {
          resolve({
            statusCode: this.statusCode,
            body: content ? JSON.parse(content) : null,
          });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(handler(request, response)).catch(reject);
  });
}

function verifyVercelCronContracts() {
  const betaContract = betaDraftModeContract();
  assert(betaContract.mode === "draft-only", "Hosted beta contract must stay draft-only", {
    betaContract,
  });
  assert(betaContract.requiresHumanApproval === true, "Hosted beta contract must require human approval", {
    betaContract,
  });
  assert(betaContract.liveExecution === false, "Hosted beta contract must forbid live execution", {
    betaContract,
  });
  assert(betaContract.gmailTransport === "draft_gmail_email", "Hosted Gmail transport must stay draft-only", {
    betaContract,
  });
  assert(betaContract.tmsTransport === "operator-approved-tms", "Hosted TMS transport must stay operator-approved", {
    betaContract,
  });
  assert(
    Array.isArray(betaContract.tmsTransports) &&
      betaContract.tmsTransports.includes("send_tms_agt_alert") &&
      betaContract.tmsTransports.includes("complete_tms_pod_closeout"),
    "Hosted TMS transport allowlist must include broker alerts and POD closeout",
    { betaContract },
  );
  assert(betaContract.tmsReviewEmail === TMS_REVIEW_EMAIL, "Hosted TMS review inbox changed", {
    betaContract,
  });

  const vercel = JSON.parse(readFile(VERCEL_CONFIG_PATH));
  const crons = new Map((vercel.crons || []).map((cron) => [cron.path, cron.schedule]));
  assert(crons.get("/api/cron/gmail-refresh.js") === "*/5 * * * *", "Hosted Gmail refresh cron must run every five minutes while Supabase IO is constrained", {
    schedule: crons.get("/api/cron/gmail-refresh.js"),
  });
  assert(crons.get("/api/cron/autonomous-drafts.js") === "*/15 * * * *", "Hosted autonomous draft cron cadence changed", {
    schedule: crons.get("/api/cron/autonomous-drafts.js"),
  });
  assert(crons.get("/api/cron/morning-refresh.js") === "0 10 * * *", "Hosted morning cron must wake at 6am New York during the demo window", {
    schedule: crons.get("/api/cron/morning-refresh.js"),
  });
  assert(crons.get("/api/cron/morning-operator-report.js") === "0 11,12 * * *", "Hosted morning operator report cron must cover 7am New York in EST/EDT", {
    schedule: crons.get("/api/cron/morning-operator-report.js"),
  });
  assert(crons.get("/api/cron/eod-report.js") === "0 23,0 * * *", "Hosted EOD cron must cover New York EST/EDT UTC ticks", {
    schedule: crons.get("/api/cron/eod-report.js"),
  });
  assert(crons.get("/api/cron/truth-audit.js") === "*/15 * * * *", "Hosted source/canonical/production truth audit must run every fifteen minutes", {
    schedule: crons.get("/api/cron/truth-audit.js"),
  });
  assert(crons.get("/api/cron/truth-shadow-refresh.js") === "2,7,12,17,22,27,32,37,42,47,52,57 * * * *", "Hosted mailbox-first truth shadow must run every five minutes offset from legacy Gmail refresh", {
    schedule: crons.get("/api/cron/truth-shadow-refresh.js"),
  });

  const morning = readFile(MORNING_CRON_PATH);
  assert(morning.includes("authorized(request)"), "Hosted morning endpoint must require CRON_SECRET authorization");
  assert(morning.includes('const TIME_ZONE = "America/New_York"'), "Hosted morning endpoint must gate by New York time");
  assert(morning.includes("const MORNING_REFRESH_HOUR = 6"), "Hosted morning endpoint must queue only for 6am New York");
  assert(morning.includes("local.hour !== MORNING_REFRESH_HOUR"), "Hosted morning endpoint must reject off-hour cron wakes");
  assert(morning.includes('"full_refresh"'), "Hosted morning endpoint must queue full_refresh only");
  assert(morning.includes("betaDraftModeContract"), "Hosted morning endpoint must stamp queued jobs with the beta contract");

  const morningOperatorReport = readFile(MORNING_OPERATOR_REPORT_CRON_PATH);
  assert(morningOperatorReport.includes("authorized(request)"), "Hosted morning operator report endpoint must require CRON_SECRET authorization");
  assert(morningOperatorReport.includes('const MORNING_REPORT_HOUR = 7'), "Hosted morning operator report endpoint must gate at 7am New York");
  assert(morningOperatorReport.includes("buildMorningOperatorReport"), "Hosted morning operator report endpoint must use the shared report builder");
  assert(morningOperatorReport.includes("upsertOperatorEvents"), "Hosted morning operator report endpoint must persist a durable operator event");
  assert(morningOperatorReport.includes("deliverPendingOperatorPushes"), "Hosted morning operator report endpoint must drain the push outbox after queueing");

  const eod = readFile(EOD_CRON_PATH);
  assert(eod.includes("authorized(request)"), "Hosted EOD endpoint must require CRON_SECRET authorization");
  assert(eod.includes('const TIME_ZONE = "America/New_York"'), "Hosted EOD endpoint must gate by New York time");
  assert(eod.includes("const EOD_REPORT_HOUR = 19"), "Hosted EOD endpoint must queue only for 7pm New York");
  assert(eod.includes("local.hour !== EOD_REPORT_HOUR"), "Hosted EOD endpoint must reject off-hour cron wakes");
  assert(eod.includes('"eod_report"'), "Hosted EOD endpoint must queue eod_report only");
  assert(eod.includes("betaDraftModeContract"), "Hosted EOD endpoint must stamp queued jobs with the beta contract");

  const gmail = readFile(GMAIL_CRON_PATH);
  assert(gmail.includes("authorized(request)"), "Hosted Gmail endpoint must require CRON_SECRET authorization");
  assert(gmail.includes('const TIME_ZONE = "America/New_York"'), "Hosted Gmail endpoint must gate by New York time");
  assert(gmail.includes('PQ_GMAIL_REFRESH_ACTIVE_HOURS !== "1"'), "Hosted Gmail endpoint must refresh all day unless concept active hours are explicitly enabled");
  assert(gmail.includes("ACTIVE_HOURS_START = 5"), "Hosted Gmail endpoint must keep optional concept-mode start hour");
  assert(gmail.includes("ACTIVE_HOURS_END_EXCLUSIVE = 18"), "Hosted Gmail endpoint must keep optional concept-mode stop hour");
  assert(gmail.includes("DEFAULT_INTERVAL_MINUTES = 5"), "Hosted Gmail endpoint must default to five-minute freshness while Supabase IO is constrained");
  assert(gmail.includes("Math.max(DEFAULT_INTERVAL_MINUTES, value)"), "Hosted Gmail endpoint must clamp stale production interval env overrides to at least five minutes");
  assert(
    gmail.includes('loadAppSnapshot("gmail-direct-state"') &&
      gmail.includes("Last direct Gmail refresh is newer than") &&
      gmail.includes("forcedRefresh"),
    "Hosted Gmail endpoint must skip duplicate heavy refreshes from the small direct-state preflight without blocking force runs",
  );
  assert(gmail.includes("PQ_GMAIL_REFRESH_DISABLED"), "Hosted Gmail endpoint must expose an emergency pause switch before Supabase reads");
  assert(gmail.includes('FRESHNESS_POLICY = "production-five-minute-refresh"'), "Hosted Gmail endpoint must stamp the five-minute production freshness policy");
  assert(gmail.includes("gmailDirectAvailable"), "Hosted Gmail endpoint must require direct Gmail OAuth availability");
  assert(gmail.includes("runDirectGmailRefresh"), "Hosted Gmail endpoint must run direct Gmail ingestion in Vercel");
  assert(gmail.includes("direct-gmail-refresh-never-runs-tms-or-carrier-tracking"), "Direct Gmail refresh must stamp the no-TMS/carrier policy");
  assert(!gmail.includes('"email_refresh"'), "Hosted Gmail cron must not queue Codex email_refresh jobs");
  assert(!gmail.includes("queueAgentJob"), "Hosted Gmail cron must not depend on the Codex Gmail queue");
  assert(
    !gmail.includes('"full_refresh"') &&
      gmail.includes("direct-gmail-refresh-never-runs-tms-or-carrier-tracking"),
    "Hosted Gmail cron must not queue TMS/carrier full_refresh jobs",
  );

  const brainChat = readFile(path.join(ROOT_DIR, "api", "brain", "chat.js"));
  assert(brainChat.includes("questionFromBody(body)"), "Brain chat endpoint must normalize ChatGPT-style message bodies");
  assert(brainChat.includes("historyFromBody(body)"), "Brain chat endpoint must pass prior chat messages as companion context");
  assert(brainChat.includes("body.messages"), "Brain chat endpoint must accept messages[] payloads, not only a flat question");

  const autonomousDrafts = readFile(AUTONOMOUS_DRAFTS_CRON_PATH);
  assert(autonomousDrafts.includes("authorized(request)"), "Hosted autonomous draft endpoint must require CRON_SECRET authorization");
  assert(autonomousDrafts.includes("PQ_AUTONOMOUS_DRAFTS_DISABLED"), "Hosted autonomous draft endpoint must expose an emergency pause switch before Supabase reads");
  assert(autonomousDrafts.includes('"draft_gmail_email"') || autonomousDrafts.includes("preview.draftPlan.jobType"), "Hosted autonomous draft endpoint must queue Gmail draft jobs");
  assert(autonomousDrafts.includes("selectAutonomousDraftActions"), "Hosted autonomous draft endpoint must use the shared autonomous action selector");
  assert(
    autonomousDrafts.includes("persistencePausedResult") &&
      autonomousDrafts.includes("SNAPSHOT_TIMEOUT_MS") &&
      autonomousDrafts.includes("retryDelaysMs: []"),
    "Hosted autonomous draft endpoint must fail closed with a persistence-paused result instead of queueing from partial snapshot state",
  );
  assert(autonomousDrafts.includes('queuedBy: "ai-operator"') || autonomousDrafts.includes("applyAutonomousDraftResults"), "Hosted autonomous draft endpoint must stamp AI-operator draft metadata");
  assert(!/send_gmail_email|send_tms_agt_alert|complete_tms_pod_closeout/.test(`${morning}\n${morningOperatorReport}\n${eod}\n${gmail}\n${autonomousDrafts}`), "Hosted cron endpoints must not queue live send jobs");

  const truthAudit = readFile(TRUTH_AUDIT_CRON_PATH);
  assert(truthAudit.includes("secretMatches(request, env.CRON_SECRET)"), "Truth-audit cron must require CRON_SECRET authorization");
  assert(
    truthAudit.includes("PQ_TRUTH_AUDIT_DISABLED") &&
      truthAudit.includes("PQ_CRON_SUPABASE_PAUSED") &&
      truthAudit.includes("PQ_SUPABASE_WRITES_DISABLED"),
    "Truth-audit cron must honor lane, global cron, and global Supabase write pause switches",
  );
  assert(
    truthAudit.includes("PQ_SUPABASE_ANON_KEY") &&
      truthAudit.includes("PQ_TRUTH_AUDIT_TOKEN") &&
      truthAudit.includes("PQ_TRUTH_PRODUCTION_WITNESS_TOKEN") &&
      truthAudit.includes("VERCEL_AUTOMATION_BYPASS_SECRET"),
    "Truth-audit cron must use separate narrow audit-ledger and production-witness credentials through protected Vercel production",
  );
  assert(!/SERVICE_ROLE|PQ_SUPABASE_SYNC_TOKEN|runDirectGmailRefresh|runOpsSync|queueAgentJob/.test(truthAudit), "Truth-audit cron must not import broad writers or source mutators");
  assert(truthAudit.includes("mutatesOperationalState: false"), "Truth-audit cron must stamp its read-only operational boundary");
  const productionWitness = readFile(TRUTH_PRODUCTION_WITNESS_PATH);
  assert(
    productionWitness.includes("PQ_TRUTH_PRODUCTION_WITNESS_TOKEN") &&
      productionWitness.includes('SNAPSHOT_KEY = "shipment-truth-packets"') &&
      productionWitness.includes('"private, no-store"') &&
      !/gmail-proof-snapshot|tms-detail-snapshot|tracking-snapshot|money-memory/.test(productionWitness),
    "Production comparison must use one dedicated token-gated, no-store shipment-truth witness",
  );
  const truthShadow = readFile(TRUTH_SHADOW_CRON_PATH);
  assert(truthShadow.includes("secretMatches(request, env.CRON_SECRET)"), "Truth-shadow cron must require CRON_SECRET authorization");
  assert(truthShadow.includes("PQ_TRUTH_SHADOW_DISABLED") && truthShadow.includes("PQ_CRON_SUPABASE_PAUSED") && truthShadow.includes("PQ_SUPABASE_WRITES_DISABLED"), "Truth-shadow cron must honor lane, global, and database pause switches");
  assert(truthShadow.includes("createHostedTruthShadowRuntime"), "Truth-shadow cron must invoke the hosted mailbox/source truth runtime");
  assert(truthShadow.includes("productionPublicationAttempted: false"), "Truth-shadow cron must stamp that production publication is forbidden");
  assert(!/runDirectGmailRefresh|runOpsSync|queueAgentJob/.test(truthShadow), "Truth-shadow cron must not call legacy reducers, packet writers, or job queues");
  assert(!/send_gmail_email|send_tms_agt_alert|complete_tms_pod_closeout/.test(`${morning}\n${morningOperatorReport}\n${eod}\n${gmail}\n${autonomousDrafts}\n${truthAudit}\n${truthShadow}`), "Hosted cron endpoints must not queue live send jobs");

  const worker = readFile(AGENT_WORKER_PATH);
  assert(worker.includes("HEAVY_REFRESH_WINDOWS"), "Local worker must define bounded heavy-refresh windows");
  assert(worker.includes("heavyRefreshWindow()"), "Local worker full_refresh must check the heavy-refresh window");
  assert(worker.includes("full_refresh outside heavy refresh window"), "Local worker must skip off-hour full_refresh jobs instead of opening TMS");

  const gmailQueue = readFile(GMAIL_QUEUE_PATH);
  assert(gmailQueue.includes("assertBetaSafeJobType"), "Local gmail:queue must use the shared beta job-type guard");
  assert(gmailQueue.includes("betaDraftModeContract"), "Local gmail:queue must stamp queued jobs with the beta contract");
  assert(
    gmailQueue.includes("isStaleInFlightJob") && gmailQueue.includes("staleJobThresholdMs"),
    "Local gmail:queue must ignore stale queued/running refresh jobs instead of freezing Gmail enrichment",
  );
  assert(gmailQueue.includes("priority: 5"), "Local gmail:queue must create refresh jobs ahead of Gmail draft priority");
  assert(!gmailQueue.includes("runOpsSync"), "Local gmail:queue must not run TMS/carrier refresh");
  assert(gmailQueue.includes("gmail-queue-never-runs-tms-or-carrier-tracking"), "Local gmail:queue must stamp the no-TMS-refresh policy");
  assert(!/job_type:\s*["']send_gmail_email["']|job_type:\s*["']send_tms_agt_alert["']|job_type:\s*["']complete_tms_pod_closeout["']/.test(gmailQueue), "Local gmail:queue must not create live send jobs");

  const gmailRefreshClaim = readFile(GMAIL_REFRESH_CLAIM_PATH);
  assert(gmailRefreshClaim.includes("No claimable email_refresh job"), "Local gmail:claim-refresh must skip drafts when no refresh is claimable");
  assert(gmailRefreshClaim.includes("refresh-only-claim-released-non-refresh-job"), "Local gmail:claim-refresh must release unexpected non-refresh claims");
  assert(
    gmailRefreshClaim.includes("writeContextArtifact") &&
      gmailRefreshClaim.includes("summarizeClaim") &&
      gmailRefreshClaim.includes("--context-file"),
    "Local gmail:claim-refresh must support compact claim receipts with full context artifacts",
  );
  assert(!gmailRefreshClaim.includes("runOpsSync"), "Local gmail:claim-refresh must not run TMS/carrier refresh");

  const claimPriority = readFile(GMAIL_CLAIM_PRIORITY_MIGRATION_PATH);
  assert(
    claimPriority.includes("create or replace function public.claim_gmail_agent_job") &&
      claimPriority.includes("payload->>'sourceBackfill' = 'true'") &&
      claimPriority.includes("payload->>'reason' = 'email-proof-stale'") &&
      claimPriority.includes("payload->>'source' in ('dashboard', 'dashboard-auto', 'dashboard-manual')") &&
      claimPriority.includes("created_at asc") &&
      claimPriority.includes("end desc") &&
      claimPriority.includes("'draft_gmail_email'"),
    "Gmail job claim order must prioritize source backfills and stale dashboard email proof before routine backlog or drafts",
  );

  const autonomousQueue = readFile(AUTONOMOUS_DRAFTS_QUEUE_PATH);
  assert(autonomousQueue.includes("selectAutonomousDraftActions"), "Local autodraft command must use the shared autonomous action selector");
  assert(autonomousQueue.includes("queueAgentJob(preview.draftPlan.jobType"), "Local autodraft command must queue the draft plan job type");
  assert(!/job_type:\s*["']send_gmail_email["']|job_type:\s*["']send_tms_agt_alert["']|job_type:\s*["']complete_tms_pod_closeout["']|send_tms_agt_alert|complete_tms_pod_closeout/.test(autonomousQueue), "Local autodraft command must not create live send jobs");

  return {
    gmailRefresh: crons.get("/api/cron/gmail-refresh.js"),
    autonomousDrafts: crons.get("/api/cron/autonomous-drafts.js"),
    morningRefresh: crons.get("/api/cron/morning-refresh.js"),
    eodReport: crons.get("/api/cron/eod-report.js"),
    morningOperatorReport: crons.get("/api/cron/morning-operator-report.js"),
    truthAudit: crons.get("/api/cron/truth-audit.js"),
    truthShadow: crons.get("/api/cron/truth-shadow-refresh.js"),
    betaContract,
  };
}

async function verifyCronAuthBehavior() {
  const previousSecret = process.env.CRON_SECRET;
  const previousGlobalPause = process.env.PQ_CRON_SUPABASE_PAUSED;
  process.env.CRON_SECRET = "verify-cron-secret";
  try {
    const checks = [
      ["autonomousDrafts", cronHandlers.autonomousDrafts, "/api/cron/autonomous-drafts.js"],
      ["gmail", cronHandlers.gmail, "/api/cron/gmail-refresh.js"],
      ["morning", cronHandlers.morning, "/api/cron/morning-refresh.js"],
      ["morningOperatorReport", cronHandlers.morningOperatorReport, "/api/cron/morning-operator-report.js"],
      ["eod", cronHandlers.eod, "/api/cron/eod-report.js"],
      ["truthAudit", cronHandlers.truthAudit, "/api/cron/truth-audit.js"],
      ["truthShadow", cronHandlers.truthShadow, "/api/cron/truth-shadow-refresh.js"],
    ];
    const results = {};
    for (const [name, handler, url] of checks) {
      const response = await callCronHandler(handler, url);
      assert(response.statusCode === 401, "Hosted cron endpoint must reject missing Authorization before queuing", {
        name,
        response,
      });
      results[name] = response.statusCode;
    }
    process.env.PQ_CRON_SUPABASE_PAUSED = "1";
    for (const [name, handler, url] of checks) {
      const response = await callCronHandler(handler, url);
      assert(response.statusCode === 401, "Hosted cron endpoint must reject missing Authorization even while globally paused", {
        name,
        response,
      });
      results[`${name}Paused`] = response.statusCode;
    }
    return results;
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousGlobalPause === undefined) delete process.env.PQ_CRON_SUPABASE_PAUSED;
    else process.env.PQ_CRON_SUPABASE_PAUSED = previousGlobalPause;
  }
}

async function main() {
  verifyLocalMorningRefreshContract();
  const hostedCrons = verifyVercelCronContracts();
  const hostedCronAuth = await verifyCronAuthBehavior();
  if (!fs.existsSync(AUTOMATION_DIR)) {
    console.log(JSON.stringify({
      ok: true,
      automationContracts: "skipped",
      hostedCrons,
      hostedCronAuth,
      reason: "No local Codex automation directory is present in this environment.",
    }, null, 2));
    return;
  }

  const gmail = verifyGmailProcessor();
  const pikiioBuilder = verifyPikiioBuilderHeartbeat();
  const morning = verifyDailyCron(
    "pq-morning-shipment-refresh",
    "FREQ=DAILY;BYHOUR=06;BYMINUTE=0;BYSECOND=0",
    [
      "6:00 AM America/New_York",
      "recurring Codex TMS/carrier tracking",
      "Live Gmail freshness primarily belongs to the hosted direct Gmail lane",
      "npm run morning:refresh",
      "draft-only",
      "send Gmail",
    ],
  );
  const eod = verifyDailyCron(
    "pq-end-of-day-operations-report",
    "FREQ=DAILY;BYHOUR=21;BYMINUTE=0;BYSECOND=0",
    [
      "5:00 PM America/New_York",
      "shipment truth audit/fix loop",
      "npm run tms:access:json",
      "npm run morning:refresh",
      "verify:production-truth-readiness",
      "Do not send Gmail",
      "explicit user approval",
    ],
    "ACTIVE",
    { optional: true },
  );
  verifyFixPushCleanContract(morning);
  if (!eod.optional) verifyFixPushCleanContract(eod);

  console.log(JSON.stringify({
    ok: true,
    automationContracts: true,
    gmailProcessor: { rrule: gmail.rrule, status: gmail.status },
    pikiioBuilder,
    morningRefresh: { rrule: morning.rrule, status: morning.status },
    eodReport: { rrule: eod.rrule, status: eod.status },
    hostedCrons,
    hostedCronAuth,
    tmsExperienceEmail: TMS_REVIEW_EMAIL,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => fail("Automation contract verification crashed", {
    detail: error instanceof Error ? error.message : String(error),
  }));
}

module.exports = {
  PIKIIO_HEARTBEAT_ID,
  PIKIIO_HEARTBEAT_LEASE_COMMANDS,
  PIKIIO_HEARTBEAT_PROMPT_PATH,
  comparePikiioHeartbeatPrompt,
  extractPikiioHeartbeatLeaseCommands,
  readCanonicalPikiioHeartbeatPrompt,
  validatePikiioHeartbeatPrompt,
  validatePikiioHeartbeatLedgerContract,
  verifyPikiioBuilderHeartbeat,
};

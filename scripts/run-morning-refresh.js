#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  sendControlRequest,
} = require("./pikiio-agent-writer-lease");

const ROOT_DIR = path.resolve(__dirname, "..");
let activeWriterHandle = "";

function hasFlag(name) {
  return process.argv.includes(name);
}

function tail(value, maxLength = 5000) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function parseLastJsonObject(value) {
  const text = String(value || "");
  const starts = [];
  if (text.startsWith("{")) starts.push(0);
  for (let index = text.indexOf("\n{"); index !== -1; index = text.indexOf("\n{", index + 2)) {
    starts.push(index + 1);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(text.slice(starts[index]).trim());
    } catch {
      // Continue to the previous line-aligned JSON object.
    }
  }
  return null;
}

function validateTruthLedgerReceipt(result) {
  const receipt = result?.truthLedger || {};
  const tms = receipt.tms || {};
  const scope = receipt.trackingScope || {};
  const tracking = receipt.tracking || {};
  const reasons = [];
  if (result?.ok !== true) reasons.push("source-sync-not-ok");
  if (receipt.enabled !== true) reasons.push("truth-ledger-disabled");
  if (receipt.status !== "committed") reasons.push("truth-ledger-not-committed");
  if (!tms.payloadIdentity || !tms.committedCursorValue) reasons.push("tms-ingest-identity-missing");
  if (!scope.tmsCursorValue || !Number.isSafeInteger(scope.expectedAwbCount)
      || scope.expectedAwbCount < 1) {
    reasons.push("tracking-scope-receipt-missing");
  }
  if (!tracking.payloadIdentity || !tracking.committedCursorValue) {
    reasons.push("tracking-ingest-identity-missing");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    receipt: {
      enabled: receipt.enabled === true,
      status: receipt.status || "",
      tms: {
        payloadIdentity: tms.payloadIdentity || null,
        committedCursorValue: tms.committedCursorValue || null,
        observationCount: Number(tms.observationCount || 0),
        jobCount: Number(tms.jobCount || 0),
        recovered: tms.recovered === true,
      },
      trackingScope: {
        tmsCursorValue: scope.tmsCursorValue || null,
        expectedAwbCount: Number(scope.expectedAwbCount || 0),
        expiresAt: scope.expiresAt || null,
      },
      tracking: {
        payloadIdentity: tracking.payloadIdentity || null,
        committedCursorValue: tracking.committedCursorValue || null,
        observationCount: Number(tracking.observationCount || 0),
        jobCount: Number(tracking.jobCount || 0),
        recovered: tracking.recovered === true,
      },
      publishesTruth: receipt.publishesTruth === true,
      mutatesOperationalState: receipt.mutatesOperationalState === true,
    },
  };
}

function skippedStep(name, reason) {
  return {
    name,
    ok: true,
    skipped: true,
    reason,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

function runCommand(name, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs || 300000,
  });
  const finishedAt = new Date().toISOString();
  const parsedOutput = parseLastJsonObject(result.stdout);
  const step = {
    name,
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal || "",
    startedAt,
    finishedAt,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr || (result.error ? result.error.message : "")),
  };
  Object.defineProperty(step, "parsedOutput", {
    value: parsedOutput,
    enumerable: false,
  });
  if (!step.ok && options.required !== false) {
    const error = new Error(`${name} failed`);
    error.step = step;
    throw error;
  }
  return step;
}

function acquireMorningWriterLease() {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/pikiio-agent-writer-lease.js",
      "acquire",
      "--lease-class=morning",
      `--supervised-pid=${process.pid}`,
      "--automation-id=pq-morning-shipment-refresh",
      `--run-id=morning-${new Date().toISOString()}-${process.pid}`,
      `--lease-ms=${3 * 60 * 60 * 1000}`,
    ],
    {
      cwd: ROOT_DIR,
      env: process.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  let payload = null;
  try {
    payload = JSON.parse(String(result.stdout || "").trim());
  } catch {
    // The normalized failure below includes the original output.
  }
  if (result.status !== 0 || payload?.ok !== true || !payload.handlePath) {
    const error = new Error(
      payload?.error ||
      String(result.stderr || result.stdout || "Morning writer lease acquisition failed").trim(),
    );
    error.code = payload?.code || "MORNING_WRITER_LEASE_ACQUIRE_FAILED";
    throw error;
  }
  return payload;
}

function runNpmScript(scriptName, options = {}) {
  return runCommand(`npm run ${scriptName}`, "npm", ["run", scriptName], options);
}

function dryRunPlan() {
  return {
    ok: true,
    dryRun: true,
    contract: "Morning refresh commits TMS/tracking to the truth ledger, waits read-only for the exact relational production publication, then proves draft safety and automation contracts.",
    steps: [
      "npm run tms:access:json",
      "npm run live-refresh",
      "npm run supabase:sync:sources",
      "validate truthLedger status=committed",
      "npm run truth:wait:relational-morning",
      "npm run verify:draft-safety",
      "npm run verify:automations",
    ],
  };
}

function runMorningRefresh() {
  if (hasFlag("--dry-run")) return dryRunPlan();

  const steps = [];
  steps.push(
    hasFlag("--skip-tms-access")
      ? skippedStep("npm run tms:access:json", "skip-tms-access flag")
      : runNpmScript("tms:access:json", { timeoutMs: 90000 }),
  );
  steps.push(
    hasFlag("--skip-live-refresh")
      ? skippedStep("npm run live-refresh", "skip-live-refresh flag")
      : runNpmScript("live-refresh", { timeoutMs: 900000 }),
  );
  steps.push(
    hasFlag("--skip-source-sync")
      ? skippedStep("npm run supabase:sync:sources", "skip-source-sync flag")
      : runNpmScript("supabase:sync:sources", { timeoutMs: 120000, required: false }),
  );
  const sourceSyncStep = steps[steps.length - 1];
  const ledgerValidation = validateTruthLedgerReceipt(sourceSyncStep.parsedOutput);
  sourceSyncStep.truthLedger = ledgerValidation.receipt;
  if (!ledgerValidation.ok) {
    sourceSyncStep.ok = false;
    sourceSyncStep.receiptErrors = ledgerValidation.reasons;
  }
  if (!sourceSyncStep.ok || sourceSyncStep.skipped) {
    return {
      ok: false,
      truthPublished: false,
      blockedAt: "source-sync",
      reason: "Source sync failed, was skipped, or did not return a committed TMS/tracking truth-ledger receipt.",
      actionSafety: {
        ok: false,
        skipped: true,
        raised: false,
        step: "relational publication read-back",
        reason: "Skipped because source truth was not durably committed.",
      },
      automationContracts: {
        ok: false,
        skipped: true,
        raised: false,
        step: "npm run verify:automations",
        reason: "Skipped because source truth was not durably committed.",
      },
      steps,
      finishedAt: new Date().toISOString(),
    };
  }
  steps.push(
    hasFlag("--skip-canonical-refresh") || hasFlag("--skip-hosted-canonical-refresh")
      ? skippedStep("npm run truth:wait:relational-morning", "skip-canonical-refresh flag")
      : runNpmScript("truth:wait:relational-morning", {
          timeoutMs: 25 * 60 * 1000,
          required: false,
        }),
  );
  const canonicalPublishStep = steps[steps.length - 1];
  if (!canonicalPublishStep.ok || canonicalPublishStep.skipped) {
    return {
      ok: false,
      truthPublished: false,
      blockedAt: "canonical-publisher",
      reason: "The hosted relational publisher did not expose the exact fresh TMS cut on live certified production surfaces.",
      actionSafety: {
        ok: false,
        skipped: true,
        raised: false,
        step: "relational publication read-back",
        reason: "Relational publication/read-back failed.",
      },
      automationContracts: {
        ok: false,
        skipped: true,
        raised: false,
        step: "npm run verify:automations",
        reason: "Relational publication/read-back failed.",
      },
      steps,
      finishedAt: new Date().toISOString(),
    };
  }

  const draftSafety = hasFlag("--skip-draft-safety")
    ? skippedStep("npm run verify:draft-safety", "skip-draft-safety flag")
    : runNpmScript("verify:draft-safety", { timeoutMs: 120000, required: false });
  steps.push(draftSafety);

  const automationContracts = hasFlag("--skip-automation-check")
    ? skippedStep("npm run verify:automations", "skip-automation-check flag")
    : runNpmScript("verify:automations", { timeoutMs: 120000, required: false });
  steps.push(automationContracts);

  const truthPublished = Boolean(canonicalPublishStep.ok && !canonicalPublishStep.skipped);
  const actionSafetyOk = Boolean(draftSafety.ok && !draftSafety.skipped);
  const automationContractsOk = Boolean(automationContracts.ok && !automationContracts.skipped);
  const failures = steps.filter((step) => !step.ok);
  return {
    ok: failures.length === 0,
    truthPublished,
    actionSafety: {
      ok: actionSafetyOk,
      raised: truthPublished && !actionSafetyOk,
      step: draftSafety.name,
      reason: actionSafetyOk
        ? "Draft/action safety passed after canonical publication."
        : "Canonical truth was published, but draft/action safety failed or was skipped.",
    },
    automationContracts: {
      ok: automationContractsOk,
      raised: truthPublished && !automationContractsOk,
      step: automationContracts.name,
    },
    steps,
    finishedAt: new Date().toISOString(),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  let leaseResponse = null;
  let result = null;
  let terminalRecorded = false;
  try {
    if (!hasFlag("--dry-run")) {
      leaseResponse = acquireMorningWriterLease();
      activeWriterHandle = leaseResponse.handlePath;
    }
    result = runMorningRefresh();
    if (leaseResponse) {
      result.writerLease = {
        runId: leaseResponse.lease.runId,
        fence: leaseResponse.lease.fence,
        phaseId: leaseResponse.lease.phaseId,
        lane: leaseResponse.lease.lane,
      };
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = result.truthPublished ? 2 : 1;
  } catch (error) {
    result = {
      ok: false,
      truthPublished: false,
      blockedAt: error.step?.name || "morning-refresh",
      reason: error instanceof Error ? error.message : String(error),
      step: error.step || null,
      finishedAt: new Date().toISOString(),
    };
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (leaseResponse) {
      const terminal = {
        result: result?.ok
          ? "succeeded"
          : result?.blockedAt
            ? "blocked"
            : "failed",
        truthPublished: result?.truthPublished === true,
        startedAt,
        finishedAt: result?.finishedAt || new Date().toISOString(),
        detail: result?.ok
          ? "Morning refresh reached its terminal success state."
          : `${result?.blockedAt || "unknown"}: ${result?.reason || "morning refresh failed"}`,
      };
      try {
        await sendControlRequest(
          leaseResponse.handlePath,
          "morning-terminal",
          { terminal },
        );
        terminalRecorded = true;
      } catch (error) {
        console.error(JSON.stringify({
          ok: false,
          code: error.code || "MORNING_TERMINAL_RECEIPT_FAILED",
          error: error instanceof Error ? error.message : String(error),
        }, null, 2));
        process.exitCode = 1;
      }
      if (terminalRecorded) {
        try {
          await sendControlRequest(leaseResponse.handlePath, "release");
        } catch (error) {
          console.error(JSON.stringify({
            ok: false,
            code: error.code || "MORNING_WRITER_LEASE_RELEASE_FAILED",
            error: error instanceof Error ? error.message : String(error),
          }, null, 2));
          process.exitCode = 1;
        }
      }
    }
    activeWriterHandle = "";
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: error.code || "MORNING_REFRESH_MAIN_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  dryRunPlan,
  acquireMorningWriterLease,
  parseLastJsonObject,
  runMorningRefresh,
  validateTruthLedgerReceipt,
};

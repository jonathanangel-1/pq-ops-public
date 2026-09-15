#!/usr/bin/env node
"use strict";

const {
  evaluateProductionGate,
  loadPhaseLedger,
  readLease,
} = require("../lib/pikiio-agent-governance");
const {
  loadHandle,
} = require("./pikiio-agent-writer-lease");

function valueArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function resultFor(action) {
  const ledger = loadPhaseLedger();
  const handlePath =
    valueArg("handle") || process.env.PIKIIO_WRITER_HANDLE || "";
  let handle = null;
  let lease = null;
  if (handlePath) {
    handle = loadHandle(handlePath);
    lease = readLease();
  }
  return evaluateProductionGate({
    ledger,
    goalObjective:
      valueArg("goal-objective") ||
      process.env.PIKIIO_CODEX_GOAL_OBJECTIVE ||
      "",
    goalThreadId:
      valueArg("goal-thread-id") ||
      process.env.PIKIIO_CODEX_GOAL_THREAD_ID ||
      "",
    lease,
    capability: handle?.capability || "",
    action,
    migrationPath: valueArg("migration"),
  });
}

function main() {
  const command = process.argv[2] || "";
  try {
    if (command === "preflight-refusal") {
      const result = resultFor("deploy");
      if (result.ok || result.code !== "PRODUCTION_AUTHORITY_DISABLED") {
        const error = new Error(
          `Expected disabled production authority, found ${result.code || "allowed"}`,
        );
        error.code = "PRODUCTION_REFUSAL_PROBE_FAILED";
        throw error;
      }
      console.log(JSON.stringify({
        ok: true,
        probe: "production-authority-default-deny",
        refusalCode: result.code,
      }, null, 2));
      return;
    }
    if (!["migrate", "deploy"].includes(command)) {
      throw new Error("Command must be preflight-refusal, migrate, or deploy");
    }
    const result = resultFor(command);
    if (!result.ok) {
      const error = new Error(result.error);
      error.code = result.code;
      error.details = result.details;
      throw error;
    }
    const error = new Error(
      "The grant passed, but no production executor is configured for this phase",
    );
    error.code = "PRODUCTION_EXECUTOR_NOT_CONFIGURED";
    error.details = result;
    throw error;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      code: error.code || "PRODUCTION_WRAPPER_FAILED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    }, null, 2));
    process.exitCode = 1;
  }
}

main();

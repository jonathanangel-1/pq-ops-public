#!/usr/bin/env node
"use strict";

const {
  evaluateGoalGuard,
  loadPhaseLedger,
} = require("../lib/pikiio-agent-governance");

function valueArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function main() {
  let result;
  try {
    if (valueArg("ledger")) {
      const error = new Error("Alternate phase ledgers are not autonomous authority");
      error.code = "ALTERNATE_PHASE_LEDGER_REFUSED";
      throw error;
    }
    const ledger = loadPhaseLedger();
    result = evaluateGoalGuard({
      ledger,
      goalObjective:
        valueArg("goal-objective") ||
        process.env.PIKIIO_CODEX_GOAL_OBJECTIVE ||
        "",
      goalThreadId:
        valueArg("goal-thread-id") ||
        process.env.PIKIIO_CODEX_GOAL_THREAD_ID ||
        "",
      productionAction: valueArg("production-action"),
    });
  } catch (error) {
    result = {
      ok: false,
      code: error.code || "GOAL_GUARD_CRASHED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main();

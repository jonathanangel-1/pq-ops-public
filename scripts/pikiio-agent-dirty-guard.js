#!/usr/bin/env node
"use strict";

const {
  evaluateDirtyGuard,
  loadPhaseLedger,
  selectActivePhase,
} = require("../lib/pikiio-agent-governance");

function valueArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function main() {
  try {
    if (valueArg("ledger")) {
      const error = new Error("Alternate phase ledgers are not autonomous authority");
      error.code = "ALTERNATE_PHASE_LEDGER_REFUSED";
      throw error;
    }
    const ledger = loadPhaseLedger();
    const phase = selectActivePhase(ledger);
    const result = evaluateDirtyGuard({ ledger, phase });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      code: error.code || "DIRTY_GUARD_CRASHED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    }, null, 2));
    process.exitCode = 1;
  }
}

main();

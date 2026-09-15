#!/usr/bin/env node
"use strict";

const {
  issueHeartbeatActivationReceipt,
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

function main() {
  try {
    if (process.argv[2] !== "issue") {
      const error = new Error("Command must be issue");
      error.code = "ACTIVATION_COMMAND_UNKNOWN";
      throw error;
    }
    const handlePath =
      valueArg("handle") || process.env.PIKIIO_WRITER_HANDLE || "";
    const handle = loadHandle(handlePath);
    const lease = readLease();
    if (
      !lease ||
      lease.runId !== handle.runId ||
      lease.fence !== handle.fence
    ) {
      const error = new Error("Writer handle does not match the live lease");
      error.code = "ACTIVATION_LEASE_MISMATCH";
      throw error;
    }
    const receipt = issueHeartbeatActivationReceipt({
      ledger: loadPhaseLedger(),
      lease,
      capability: handle.capability,
    });
    console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      code: error.code || "ACTIVATION_RECEIPT_FAILED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    }, null, 2));
    process.exitCode = 1;
  }
}

main();

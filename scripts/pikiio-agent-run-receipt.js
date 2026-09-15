#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const {
  appendRunReceipt,
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

function readStdin() {
  return fs.readFileSync(0, "utf8").trim();
}

function main() {
  try {
    const source = readStdin();
    if (!source) throw new Error("Run receipt JSON is required on stdin");
    const input = JSON.parse(source);
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
      error.code = "RUN_RECEIPT_LEASE_MISMATCH";
      throw error;
    }
    const receipt = appendRunReceipt(input, {
      ledger: loadPhaseLedger(),
      lease,
      capability: handle.capability,
    });
    console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      code: error.code || "RUN_RECEIPT_FAILED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    }, null, 2));
    process.exitCode = 1;
  }
}

main();

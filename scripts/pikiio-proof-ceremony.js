#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ceremony = require("../lib/pikiio-proof-ceremony");

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MODES = new Set(["inspect", "dry-run", "live"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArguments(argv) {
  const values = {
    mode: "inspect",
    root: "",
    intentPath: "",
    capabilityPath: "",
  };
  let modeSeen = false;
  for (const argument of argv) {
    if (!argument.startsWith("--")) {
      if (modeSeen || !MODES.has(argument)) {
        fail("CEREMONY_ARGUMENT_INVALID", "unexpected ceremony argument");
      }
      values.mode = argument;
      modeSeen = true;
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator < 3) {
      fail(
        "CEREMONY_ARGUMENT_INVALID",
        "ceremony flags require --name=value",
      );
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!value || !["root", "intent", "capability"].includes(name)) {
      fail("CEREMONY_ARGUMENT_INVALID", "unknown or empty ceremony flag");
    }
    const key = {
      root: "root",
      intent: "intentPath",
      capability: "capabilityPath",
    }[name];
    if (values[key]) {
      fail("CEREMONY_ARGUMENT_DUPLICATE", `--${name} was supplied twice`);
    }
    values[key] = value;
  }
  if (!values.root || !values.intentPath) {
    fail(
      "CEREMONY_INPUT_REQUIRED",
      "--root and --intent are required for every ceremony inspection",
    );
  }
  if (values.mode !== "live" && values.capabilityPath) {
    fail(
      "CEREMONY_CAPABILITY_REFUSED",
      "inspect and dry-run refuse live capability material",
    );
  }
  if (values.mode === "live" && !values.capabilityPath) {
    fail(
      "CEREMONY_CAPABILITY_REQUIRED",
      "live dispatch/push requires an exact ceremony capability object",
    );
  }
  return values;
}

function readJsonFile(filePath, label) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath
  ) {
    fail("CEREMONY_PATH_INVALID", `${label} path must be normalized and absolute`);
  }
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size < 3n ||
    stat.size > BigInt(MAX_INPUT_BYTES) ||
    (stat.mode & 0o022n) !== 0n
  ) {
    fail("CEREMONY_INPUT_UNSAFE", `${label} must be a bounded regular file`);
  }
  const bytes = fs.readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("CEREMONY_INPUT_INVALID", `${label} is not UTF-8 JSON`);
  }
  return value;
}

async function main({
  argv = process.argv.slice(2),
  write = (text) => process.stdout.write(text),
  nowMs = Date.now(),
} = {}) {
  try {
    const args = parseArguments(argv);
    const intent = ceremony.validateIntent(
      readJsonFile(args.intentPath, "intent"),
    );
    let result;
    if (args.mode === "inspect") {
      result = ceremony.inspectCeremony({
        root: args.root,
        intent,
      });
    } else if (args.mode === "dry-run") {
      result = {
        ...ceremony.planCeremony(intent),
        status: "plan_only",
        executable: false,
        reason:
          "Execution requires typed in-process controller adapters; no shell or module-path escape hatch is accepted.",
      };
    } else {
      const capability = readJsonFile(
        args.capabilityPath,
        "ceremony capability",
      );
      ceremony.validateCapability(capability, intent, nowMs);
      fail(
        "CANONICAL_V3_TRANSITION_ADAPTER_UNAVAILABLE",
        "live ceremony is disabled until the canonical v3 transition and separated-phase activation adapters are installed",
      );
    }
    write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    write(
      `${JSON.stringify(
        {
          ok: false,
          code: error.code || "PIKIIO_PROOF_CEREMONY_FAILED",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = Object.freeze({
  main,
  parseArguments,
  readJsonFile,
});

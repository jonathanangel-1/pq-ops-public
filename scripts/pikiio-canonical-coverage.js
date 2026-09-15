#!/usr/bin/env node
"use strict";

const {
  CanonicalCoverageError,
  reduceCanonicalCoverage,
  validateCanonicalCoverageReport,
} = require("../lib/pikiio-canonical-coverage");

const USAGE =
  "usage: pikiio-canonical-coverage --raw-dir <canonical-directory> " +
  "--target <logical-id>=<canonical-source-path> [--target ...] [--pretty]";

function cliFailure(message) {
  throw new CanonicalCoverageError("CLI_ARGUMENT_INVALID", message);
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function writeStdout(stdout, value) {
  try {
    stdout.write(value);
  } catch (error) {
    throw new CanonicalCoverageError(
      "CLI_STDOUT_WRITE_FAILED",
      "stdout refused canonical coverage output",
      { cause: error?.code || error?.name || "UNKNOWN" },
    );
  }
}

function writeFailure(stderr, failure) {
  if (!stderr || typeof stderr.write !== "function") return false;
  try {
    stderr.write(`${JSON.stringify(failure)}\n`);
    return true;
  } catch {
    return false;
  }
}

function internalFailureMessage(error) {
  try {
    return String(error && error.message ? error.message : error);
  } catch {
    return "unprintable internal error";
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    cliFailure("argv must be an explicit array");
  }
  for (const argument of argv) {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      argument.includes("\n") ||
      argument.includes("\r")
    ) {
      cliFailure("arguments must be single-line NUL-free strings");
    }
  }
  if (argv.includes("--help")) {
    if (argv.length !== 1 || argv[0] !== "--help") {
      cliFailure("--help is valid only as the sole argument");
    }
    return { help: true };
  }

  let rawDirectory;
  let pretty = false;
  const targets = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--raw-dir") {
      if (rawDirectory !== undefined || index + 1 >= argv.length) {
        cliFailure("--raw-dir must occur exactly once with a value");
      }
      rawDirectory = argv[++index];
      if (rawDirectory.length === 0) {
        cliFailure("--raw-dir value must not be empty");
      }
      continue;
    }
    if (argument === "--target") {
      if (index + 1 >= argv.length) {
        cliFailure("--target requires a value");
      }
      const value = argv[++index];
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        cliFailure("--target must use <logical-id>=<source-path>");
      }
      targets.push({
        id: value.slice(0, separator),
        sourcePath: value.slice(separator + 1),
      });
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) {
        cliFailure("--pretty must not be repeated");
      }
      pretty = true;
      continue;
    }
    cliFailure(`unsupported argument: ${argument}`);
  }

  if (rawDirectory === undefined || targets.length === 0) {
    cliFailure("--raw-dir and at least one --target are required");
  }
  return { help: false, pretty, rawDirectory, targets };
}

function main(input = {}) {
  let argv = process.argv.slice(2);
  let stdout = process.stdout;
  let stderr = process.stderr;
  try {
    if (!isPlainRecord(input)) {
      cliFailure("main input must be a plain record");
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => !["argv", "stderr", "stdout"].includes(key))
    ) {
      cliFailure("main input contains unsupported fields");
    }
    if (Object.prototype.hasOwnProperty.call(input, "stderr")) {
      stderr = input.stderr;
    }
    if (Object.prototype.hasOwnProperty.call(input, "stdout")) {
      stdout = input.stdout;
    }
    if (
      !stderr ||
      typeof stderr.write !== "function" ||
      !stdout ||
      typeof stdout.write !== "function"
    ) {
      cliFailure("stdout and stderr must expose write functions");
    }
    if (Object.prototype.hasOwnProperty.call(input, "argv")) {
      argv = input.argv;
    }
    const options = parseArguments(argv);
    if (options.help) {
      writeStdout(stdout, `${USAGE}\n`);
      return 0;
    }
    const report = reduceCanonicalCoverage({
      rawDirectory: options.rawDirectory,
      targets: options.targets,
    });
    validateCanonicalCoverageReport(report);
    writeStdout(
      stdout,
      `${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`,
    );
    return 0;
  } catch (error) {
    const failure =
      error instanceof CanonicalCoverageError
        ? {
            status: "refused",
            code: error.code,
            message: error.message,
          }
        : {
            status: "refused",
            code: "CANONICAL_COVERAGE_INTERNAL_ERROR",
            message: internalFailureMessage(error),
          };
    writeFailure(stderr, failure);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  USAGE,
  main,
  parseArguments,
};

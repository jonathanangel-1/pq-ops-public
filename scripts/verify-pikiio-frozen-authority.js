#!/usr/bin/env node
"use strict";

const {
  FrozenAuthorityError,
  issueFrozenAuthorityCertification,
  readFrozenAuthorityCertification,
  stableJson,
  validateFrozenAuthorityCertification,
} = require("../lib/pikiio-frozen-authority-verifier");

const ISSUE_FLAGS = Object.freeze([
  "--candidate-repo",
  "--collector-receipt",
  "--expected-scope-base",
  "--phase-proof-bundle",
  "--quality-receipt",
]);
const VALIDATE_FLAGS = Object.freeze([
  "--candidate-repo",
  "--certification",
  "--expected-scope-base",
  "--phase-proof-bundle",
  "--quality-receipt",
]);

function parseExactArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 13) {
    throw new FrozenAuthorityError(
      "CLI_ARGUMENTS_INVALID",
      "usage: verify-pikiio-frozen-authority.js <issue|validate> with five exact flag/value pairs",
    );
  }
  const command = argv[2];
  const expected = command === "issue"
    ? ISSUE_FLAGS
    : command === "validate"
      ? VALIDATE_FLAGS
      : null;
  if (!expected) {
    throw new FrozenAuthorityError(
      "CLI_COMMAND_INVALID",
      "command must be exactly issue or validate",
    );
  }
  const values = {};
  for (let index = 3; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !expected.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      throw new FrozenAuthorityError(
        "CLI_ARGUMENTS_INVALID",
        "CLI flags must appear exactly once with non-empty values",
      );
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== expected.length ||
    expected.some((flag) => !Object.hasOwn(values, flag))
  ) {
    throw new FrozenAuthorityError(
      "CLI_ARGUMENTS_INVALID",
      "CLI requires the complete exact flag set",
    );
  }
  return { command, values };
}

function readCertification(filePath) {
  try {
    return readFrozenAuthorityCertification(filePath);
  } catch (error) {
    if (error instanceof FrozenAuthorityError) throw error;
    throw new FrozenAuthorityError(
      "CERTIFICATION_JSON_INVALID",
      "Certification file is not valid bounded UTF-8 JSON",
      { cause: error.message },
    );
  }
}

function execute(parsed, implementations = {}) {
  const issue =
    implementations.issue || issueFrozenAuthorityCertification;
  const validate =
    implementations.validate || validateFrozenAuthorityCertification;
  const common = {
    candidateRepo: parsed.values["--candidate-repo"],
    expectedScopeBaseCommit: parsed.values["--expected-scope-base"],
    phaseProofBundlePath: parsed.values["--phase-proof-bundle"],
    qualityReceiptPath: parsed.values["--quality-receipt"],
  };
  if (parsed.command === "issue") {
    return issue({
      ...common,
      collectorReceiptPath: parsed.values["--collector-receipt"],
    });
  }
  return validate({
    ...common,
    certification: readCertification(parsed.values["--certification"]),
  });
}

function main({
  argv = process.argv,
  stdout = process.stdout,
  implementations,
} = {}) {
  const parsed = parseExactArguments(argv);
  const result = execute(parsed, implementations);
  stdout.write(`${stableJson(result)}\n`);
  return result;
}

function boundedFailure(error) {
  const code =
    error instanceof FrozenAuthorityError
      ? error.code
      : "FROZEN_AUTHORITY_INTERNAL_FAILURE";
  const message =
    error instanceof FrozenAuthorityError
      ? error.message
      : "Frozen authority verification failed closed";
  return stableJson({ ok: false, code, error: message });
}

function runCli({
  mainImpl = main,
  stderr = process.stderr,
} = {}) {
  try {
    mainImpl();
  } catch (error) {
    stderr.write(`${boundedFailure(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  ISSUE_FLAGS,
  VALIDATE_FLAGS,
  boundedFailure,
  execute,
  main,
  parseExactArguments,
  readCertification,
  runCli,
};

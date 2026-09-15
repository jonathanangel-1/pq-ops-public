#!/usr/bin/env node
"use strict";

const {
  acceptanceCases,
  assertProfileId,
  clone,
  createOracleAdapter,
  loadProductAdapter,
  validateAction01,
  validateAction02,
  validateAction03,
} = require("../scripts/verify-pikiio-action-phase-gherkin");
const {
  MUTANTS,
  validateMutationDefinitions,
} = require("../scripts/mutate-pikiio-action-phase");

async function main(argv = process.argv.slice(2), options = {}) {
  const profileIndex = argv.indexOf("--profile");
  const mutantIndex = argv.indexOf("--mutant");
  const product = argv.includes("--product");
  const controlSurvivor = argv.includes("--control-survivor");
  if (profileIndex < 0 || (!controlSurvivor && mutantIndex < 0)) {
    const error = new Error(
      "Use --profile ACTION-01|ACTION-02|ACTION-03 and --mutant ID, or --control-survivor",
    );
    error.code = "PIKIIO_ACTION_MUTANT_ARGUMENT_INVALID";
    throw error;
  }
  const profile = assertProfileId(argv[profileIndex + 1]);
  const mutantId = String(argv[mutantIndex + 1] || "");
  const mutants = (
    options.validateMutationDefinitionsFn || validateMutationDefinitions
  )(profile);
  const mutant = controlSurvivor
    ? {
        id: "classifier-control",
        fingerprint: "no-mutation",
        caseNeedle:
          profile === "ACTION-01"
            ? "scheduled-never-delivered"
            : profile === "ACTION-02"
              ? "action-queue-byte-parity"
              : "flag-off-parity",
      }
    : mutants.find((row) => row.id === mutantId);
  if (!mutant) {
    const error = new Error(`${profile}: unknown mutant ${JSON.stringify(mutantId)}`);
    error.code = "PIKIIO_ACTION_MUTANT_UNKNOWN";
    throw error;
  }
  const caseRows = (options.acceptanceCasesFn || acceptanceCases)(profile);
  const caseRow = caseRows.find((row) =>
    row.id.includes(mutant.caseNeedle),
  );
  if (!caseRow) {
    const error = new Error(
      `${profile}/${mutant.id}: targeted domain case ${mutant.caseNeedle} is missing`,
    );
    error.code = "PIKIIO_ACTION_MUTANT_TARGET_MISSING";
    throw error;
  }
  const adapter =
    options.adapter ||
    (product
      ? (options.loadProductAdapterFn || loadProductAdapter)(profile)
      : (options.createOracleAdapterFn || createOracleAdapter)(profile));
  const output = await adapter.evaluate(clone(caseRow.input));
  const repeated = await adapter.evaluate(clone(caseRow.input));
  if (typeof mutant.mutate === "function") {
    mutant.mutate({ input: caseRow.input, output, repeated });
    mutant.mutate({ input: caseRow.input, output: repeated, repeated });
  }
  if (typeof mutant.mutateRepeated === "function") {
    mutant.mutateRepeated({ input: caseRow.input, output, repeated });
  }
  let classification = "survived";
  let errorMessage = null;
  try {
    if (profile === "ACTION-01") {
      validateAction01(caseRow.input, output, repeated, caseRow.expected);
    } else if (profile === "ACTION-02") {
      validateAction02(caseRow.input, output, repeated, caseRow.expected);
    } else {
      validateAction03(caseRow.input, output, repeated, caseRow.expected);
    }
  } catch (error) {
    classification = "killed";
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const receipt = {
    schema: "pikiio-action-mutant-classification-v1",
    profile,
    mutantId: mutant.id,
    fingerprint: mutant.fingerprint,
    classification,
    error: errorMessage,
  };
  return {
    exitCode: classification === "killed" ? 0 : 1,
    receipt,
  };
}

async function runCli(argv = process.argv.slice(2), options = {}) {
  const writeStdout =
    options.writeStdout || ((value) => process.stdout.write(String(value)));
  const writeStderr =
    options.writeStderr || ((value) => process.stderr.write(String(value)));
  const setExitCode =
    options.setExitCode || ((value) => {
      process.exitCode = value;
    });
  try {
    const result = await main(argv, options);
    writeStdout(`${JSON.stringify(result.receipt)}\n`);
    setExitCode(result.exitCode);
    return result;
  } catch (error) {
    const receipt = {
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || null,
      };
    writeStderr(`${JSON.stringify(receipt)}\n`);
    setExitCode(2);
    return { exitCode: 2, receipt };
  }
}

if (require.main === module) {
  runCli();
}

module.exports = { main, runCli };

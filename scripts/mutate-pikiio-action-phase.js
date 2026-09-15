#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  PROFILE_IDS,
  acceptanceCases,
  assertProfileId,
  loadProductAdapter,
} = require("./verify-pikiio-action-phase-gherkin");

const ROOT = path.resolve(__dirname, "..");
const PROBE_PATH = path.join(ROOT, "tests", "pikiio-action-phase-mutant-probe.js");
const CRITICAL_MUTATION_POPULATION = 20;
const PROBE_TIMEOUT_MS = 20_000;

function setEffect(name) {
  return ({ output }) => {
    output.effects[name] = 1;
  };
}

const MUTANTS = Object.freeze({
  "ACTION-01": Object.freeze([
    { id: "scheduled-arms-pod", fingerprint: "scheduled-delivery-acted", caseNeedle: "scheduled-never-delivered", mutate: ({ output }) => { output.decision = "act"; } },
    { id: "promise-mints-pod-received", fingerprint: "pod-promise-became-receipt", caseNeedle: "promise-not-receipt", mutate: ({ output }) => { output.podStatus = "received"; } },
    { id: "terminal-hides-open-pod", fingerprint: "open-pod-not-actionable", caseNeedle: "terminal-open-pod-actionable", mutate: ({ output }) => { output.actionable = false; } },
    { id: "fabricated-claim-citation", fingerprint: "unaccepted-claim-cited", caseNeedle: "accepted-claim-citations", mutate: ({ output }) => { output.basedOnClaimVersionIds[0] = "fabricated:claim"; } },
    { id: "empty-claim-citations", fingerprint: "decision-has-no-claim-receipts", caseNeedle: "accepted-claim-citations", mutate: ({ output }) => { output.basedOnClaimVersionIds = []; } },
    { id: "wrong-owner-claim", fingerprint: "recipient-owner-claim-forged", caseNeedle: "owner-resolves-recipient", mutate: ({ output }) => { output.counterpartyResolution.claimVersionId = "wrong:owner"; } },
    { id: "wrong-owner-email", fingerprint: "recipient-not-from-owner", caseNeedle: "owner-email-provenance", mutate: ({ output }) => { output.counterpartyResolution.email = "client@example.com"; } },
    { id: "wrong-owner-thread", fingerprint: "thread-not-from-owner", caseNeedle: "owner-thread-provenance", mutate: ({ output }) => { output.counterpartyResolution.threadId = "unrelated-thread"; } },
    { id: "execution-becomes-gmail-draft", fingerprint: "proposal-created-gmail-draft", caseNeedle: "no-gmail-draft-effect", mutate: ({ output }) => { output.execution = "draft_gmail_email"; } },
    { id: "production-default-enabled", fingerprint: "claim-native-mode-enabled", caseNeedle: "default-off-zero-writes", mutate: ({ output }) => { output.productionEnabled = true; } },
    { id: "action-queue-write", fingerprint: "action-queue-mutated", caseNeedle: "default-off-zero-writes", mutate: setEffect("actionQueueWrites") },
    { id: "draft-queue-write", fingerprint: "draft-queue-mutated", caseNeedle: "no-gmail-draft-effect", mutate: setEffect("draftQueueWrites") },
    { id: "send-queue-write", fingerprint: "send-queue-mutated", caseNeedle: "no-send-effect", mutate: setEffect("sendQueueWrites") },
    { id: "gmail-api-call", fingerprint: "gmail-api-invoked", caseNeedle: "no-gmail-draft-effect", mutate: setEffect("gmailApiCalls") },
    { id: "tms-write", fingerprint: "tms-mutated", caseNeedle: "no-tms-effect", mutate: setEffect("tmsWrites") },
    { id: "truth-write", fingerprint: "truth-mutated-by-planner", caseNeedle: "no-truth-write-effect", mutate: setEffect("truthWrites") },
    { id: "nondeterministic-action-id-format", fingerprint: "action-id-not-content-addressed", caseNeedle: "deterministic-identifiers", mutate: ({ output }) => { output.actionId = `random-${Date.now()}`; } },
    { id: "nondeterministic-repeat", fingerprint: "repeat-output-drift", caseNeedle: "repeat-full-output-parity", mutateRepeated: ({ repeated }) => { repeated.actionId = "pikiio:ffffffffffffffffffffffffffffffff"; } },
    { id: "fresh-promise-wait-reason-removed", fingerprint: "promise-wait-has-no-reason", caseNeedle: "fresh-promise-wait", mutate: ({ output }) => { output.waitCondition = ""; output.reason = ""; } },
    { id: "delivered-open-pod-completed", fingerprint: "terminal-lifecycle-closed-open-gate", caseNeedle: "delivered-open-role-active", mutate: ({ output }) => { output.decision = "completed"; } },
  ]),
  "ACTION-02": Object.freeze([
    { id: "action-queue-hash-drift", fingerprint: "shadow-action-queue-drift", caseNeedle: "action-queue-byte-parity", mutate: ({ output }) => { output.afterHashes.actionQueue = "0".repeat(64); } },
    { id: "draft-queue-hash-drift", fingerprint: "shadow-draft-queue-drift", caseNeedle: "draft-queue-byte-parity", mutate: ({ output }) => { output.afterHashes.draftQueue = "0".repeat(64); } },
    { id: "send-queue-hash-drift", fingerprint: "shadow-send-queue-drift", caseNeedle: "send-queue-byte-parity", mutate: ({ output }) => { output.afterHashes.sendQueue = "0".repeat(64); } },
    { id: "action-queue-write", fingerprint: "shadow-action-queue-write", caseNeedle: "zero-gmail-api-calls", mutate: setEffect("actionQueueWrites") },
    { id: "draft-queue-write", fingerprint: "shadow-draft-queue-write", caseNeedle: "zero-gmail-api-calls", mutate: setEffect("draftQueueWrites") },
    { id: "send-queue-write", fingerprint: "shadow-send-queue-write", caseNeedle: "zero-gmail-api-calls", mutate: setEffect("sendQueueWrites") },
    { id: "gmail-api-call", fingerprint: "shadow-gmail-api-call", caseNeedle: "zero-gmail-api-calls", mutate: setEffect("gmailApiCalls") },
    { id: "tms-write", fingerprint: "shadow-tms-write", caseNeedle: "zero-tms-writes", mutate: setEffect("tmsWrites") },
    { id: "truth-write", fingerprint: "shadow-truth-write", caseNeedle: "zero-truth-writes", mutate: setEffect("truthWrites") },
    { id: "corpus-receipt-removed", fingerprint: "shadow-case-skipped", caseNeedle: "exact-corpus-receipts", mutate: ({ output }) => { output.comparisons.pop(); } },
    { id: "corpus-receipt-duplicated", fingerprint: "shadow-case-duplicated", caseNeedle: "exact-corpus-receipts", mutate: ({ output }) => { output.comparisons.push({ ...output.comparisons[0] }); } },
    { id: "accepted-claims-removed", fingerprint: "shadow-claim-provenance-lost", caseNeedle: "claim-provenance-preserved", mutate: ({ output }) => { output.comparisons[0].basedOnClaimVersionIds = []; } },
    { id: "action-id-removed", fingerprint: "shadow-action-id-lost", caseNeedle: "action-id-present", mutate: ({ output }) => { output.comparisons[0].actionId = ""; } },
    { id: "wait-cohort-member-removed", fingerprint: "shadow-wait-cohort-under-count", caseNeedle: "wait-cohort-exact", mutate: ({ output }) => { output.cohorts.wait.pop(); } },
    { id: "unknown-cohort-added", fingerprint: "shadow-unknown-cohort-admitted", caseNeedle: "no-unknown-cohort", mutate: ({ output }) => { output.cohorts.unknown = ["AB-001"]; } },
    { id: "unsafe-status-passes", fingerprint: "shadow-unsafe-batch-passed", caseNeedle: "unsafe-recipient-fails", mutate: ({ output }) => { output.status = "passed"; } },
    { id: "unsafe-finding-removed", fingerprint: "shadow-unsafe-finding-hidden", caseNeedle: "unsafe-recipient-fails", mutate: ({ output }) => { output.findings = []; } },
    { id: "write-surface-production", fingerprint: "shadow-wrote-production-surface", caseNeedle: "audit-surface-only", mutate: ({ output }) => { output.writeSurface = "action-queue"; } },
    { id: "receipt-hash-forged", fingerprint: "shadow-receipt-not-content-addressed", caseNeedle: "comparison-hash-bound", mutate: ({ output }) => { output.receiptHash = "f".repeat(64); } },
    { id: "repeat-receipt-drift", fingerprint: "shadow-repeat-nondeterministic", caseNeedle: "receipt-deterministic", mutateRepeated: ({ repeated }) => { repeated.receiptHash = "e".repeat(64); } },
  ]),
  "ACTION-03": Object.freeze([
    { id: "flag-off-proposal-leak", fingerprint: "flag-off-surface-changed", caseNeedle: "flag-off-parity", mutate: ({ output }) => { output.operatorSurface.proposals.push({ id: "leaked" }); } },
    { id: "api-proposal-removed", fingerprint: "api-proposal-missing", caseNeedle: "api-view-id-parity", mutate: ({ output }) => { output.api.proposal = null; } },
    { id: "view-proposal-removed", fingerprint: "view-proposal-missing", caseNeedle: "api-view-id-parity", mutate: ({ output }) => { output.viewModel.proposal = null; } },
    { id: "view-id-diverges", fingerprint: "api-view-id-mismatch", caseNeedle: "api-view-id-parity", mutate: ({ output }) => { output.viewModel.proposal.id = "wrong"; } },
    { id: "view-evidence-diverges", fingerprint: "api-view-evidence-mismatch", caseNeedle: "api-view-evidence-parity", mutate: ({ output }) => { output.viewModel.proposal.basedOnClaimVersionIds = []; } },
    { id: "view-recipient-diverges", fingerprint: "api-view-recipient-mismatch", caseNeedle: "api-view-recipient-parity", mutate: ({ output }) => { output.viewModel.proposal.recipient = "client@example.com"; } },
    { id: "view-thread-diverges", fingerprint: "api-view-thread-mismatch", caseNeedle: "api-view-thread-parity", mutate: ({ output }) => { output.viewModel.proposal.threadId = "unrelated-thread"; } },
    { id: "promise-renders-received", fingerprint: "pod-promise-rendered-received", caseNeedle: "promise-renders-pending", mutate: ({ output }) => { output.api.proposal.status = "POD received"; output.viewModel.proposal.status = "POD received"; } },
    { id: "non-pod-family-visible", fingerprint: "non-pod-family-exposed", caseNeedle: "pod-family-only", mutate: ({ output }) => { output.api.proposal.family = "customs-followup"; output.viewModel.proposal.family = "customs-followup"; } },
    { id: "proposal-becomes-draft", fingerprint: "proposal-created-draft", caseNeedle: "inspect-only-execution", mutate: ({ output }) => { output.api.proposal.execution = "draft_gmail_email"; output.viewModel.proposal.execution = "draft_gmail_email"; } },
    { id: "action-queue-write", fingerprint: "proposal-action-queue-write", caseNeedle: "zero-action-queue-write", mutate: setEffect("actionQueueWrites") },
    { id: "draft-queue-write", fingerprint: "proposal-draft-queue-write", caseNeedle: "zero-draft-queue-write", mutate: setEffect("draftQueueWrites") },
    { id: "send-queue-write", fingerprint: "proposal-send-queue-write", caseNeedle: "zero-send-queue-write", mutate: setEffect("sendQueueWrites") },
    { id: "gmail-api-call", fingerprint: "proposal-gmail-api-call", caseNeedle: "no-gmail-draft", mutate: setEffect("gmailApiCalls") },
    { id: "tms-write", fingerprint: "proposal-tms-write", caseNeedle: "no-tms-freight-mutation", mutate: setEffect("tmsWrites") },
    { id: "truth-write", fingerprint: "proposal-truth-write", caseNeedle: "zero-truth-write", mutate: setEffect("truthWrites") },
    { id: "execution-control-clicked", fingerprint: "proposal-execution-clicked", caseNeedle: "no-click-control", mutate: ({ output }) => { output.interactions.clickedExecutionControl = true; } },
    { id: "dismiss-rewrites-truth", fingerprint: "proposal-dismiss-mutated-truth", caseNeedle: "dismiss-does-not-rewrite-truth", mutate: ({ output }) => { output.truthPacketHashAfter = "0".repeat(64); } },
    { id: "multiple-proposals-visible", fingerprint: "proposal-family-duplicated", caseNeedle: "single-visible-proposal", mutate: ({ output }) => { output.operatorSurface.proposals.push({ ...output.operatorSurface.proposals[0], id: "duplicate" }); } },
    { id: "repeat-projection-drift", fingerprint: "proposal-repeat-nondeterministic", caseNeedle: "deterministic-projection", mutateRepeated: ({ repeated }) => { repeated.truthPacketHashAfter = "f".repeat(64); } },
  ]),
});

function validateMutationDefinitions(profile) {
  assertProfileId(profile);
  const mutants = MUTANTS[profile];
  assert.equal(
    mutants.length,
    CRITICAL_MUTATION_POPULATION,
    `${profile}: critical mutation population changed`,
  );
  for (const field of ["id", "fingerprint"]) {
    assert.equal(
      new Set(mutants.map((row) => row[field])).size,
      mutants.length,
      `${profile}: duplicate ${field} makes mutation classification ambiguous`,
    );
  }
  for (const mutant of mutants) {
    assert.match(mutant.id, /^[a-z0-9-]+$/);
    assert.match(mutant.fingerprint, /^[a-z0-9-]+$/);
    assert.ok(
      typeof mutant.mutate === "function" ||
        typeof mutant.mutateRepeated === "function",
      `${profile}/${mutant.id}: mutation operator missing`,
    );
  }
  return mutants;
}

function classifyProbe(result, expected) {
  if (result?.error?.code === "ETIMEDOUT") {
    const error = new Error(`${expected.id}: mutant probe timed out`);
    error.code = "PIKIIO_ACTION_MUTANT_PROBE_TIMEOUT";
    throw error;
  }
  if (result?.error || result?.signal) {
    const error = new Error(
      `${expected.id}: mutant probe crashed${
        result.signal ? ` with ${result.signal}` : ""
      }`,
    );
    error.code = "PIKIIO_ACTION_MUTANT_PROBE_CRASHED";
    throw error;
  }
  const lines = String(result.stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(lines.length, 1, `${expected.id}: probe must emit one JSON receipt`);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.profile, expected.profile);
  assert.equal(receipt.mutantId, expected.id);
  assert.equal(receipt.fingerprint, expected.fingerprint);
  assert.ok(
    ["killed", "survived"].includes(receipt.classification),
    `${expected.id}: ambiguous classifier output`,
  );
  assert.equal(
    result.status,
    receipt.classification === "killed" ? 0 : 1,
    `${expected.id}: exit status and classifier disagree`,
  );
  return receipt;
}

function runProbe(profile, mutant, options = {}) {
  const args = [
    PROBE_PATH,
    "--profile",
    profile,
    "--mutant",
    mutant.id,
  ];
  if (options.product) args.push("--product");
  const spawn = options.spawnSyncFn || spawnSync;
  return spawn(process.execPath, args, {
    cwd: options.root || ROOT,
    encoding: "utf8",
    timeout: options.timeoutMs || PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      PIKIIO_ACTION_MUTATION_CLASSIFIER: "v1",
    },
  });
}

function runClassifierMetaTests(profile, options = {}) {
  const controlArgs = [
    PROBE_PATH,
    "--profile",
    profile,
    "--control-survivor",
  ];
  if (options.product) controlArgs.push("--product");
  const spawn = options.spawnSyncFn || spawnSync;
  const controlResult = spawn(process.execPath, controlArgs, {
    cwd: options.root || ROOT,
    encoding: "utf8",
    timeout: options.timeoutMs || PROBE_TIMEOUT_MS,
  });
  const control = classifyProbe(controlResult, {
    profile,
    id: "classifier-control",
    fingerprint: "no-mutation",
  });
  assert.equal(
    control.classification,
    "survived",
    `${profile}: no-mutation classifier control was falsely killed`,
  );
  const unknownResult = spawn(
    process.execPath,
    [
      PROBE_PATH,
      "--profile",
      profile,
      "--mutant",
      "unknown-mutant",
    ],
    {
      cwd: options.root || ROOT,
      encoding: "utf8",
      timeout: options.timeoutMs || PROBE_TIMEOUT_MS,
    },
  );
  assert.equal(unknownResult.status, 2);
  const unknown = JSON.parse(String(unknownResult.stderr || "").trim());
  assert.equal(unknown.code, "PIKIIO_ACTION_MUTANT_UNKNOWN");
  return {
    survivorControlRecognized: true,
    unknownMutantRejected: true,
    ambiguityCount: 0,
  };
}

function runMutationProfile(profile, options = {}) {
  assertProfileId(profile);
  const mutants = validateMutationDefinitions(profile);
  if (options.product) {
    // Fail before counting mutants when the real surface does not exist.
    try {
      const productAdapter = (
        options.loadProductAdapterFn || loadProductAdapter
      )(profile, options.root || ROOT);
      const preflightCases = (
        options.acceptanceCasesFn || acceptanceCases
      )(profile);
      assert.ok(
        preflightCases.length > 0,
        `${profile}: product preflight requires at least one acceptance case`,
      );
      productAdapter.evaluate(preflightCases[0].input);
    } catch (error) {
      const gap = new Error(
        `${profile}: product mutation surface is unavailable: ${error.message}`,
      );
      gap.code = "PIKIIO_ACTION_MUTATION_SURFACE_MISSING";
      gap.summary = {
        schema: "pikiio-action-mutation-result-v1",
        profile,
        mode: "product-acceptance",
        requiredCriticalPopulation: mutants.length,
        executed: 0,
        killed: 0,
        survived: 0,
        classifierAmbiguityCount: 0,
        status: "failed",
        productSurfaceGap: error.message,
      };
      throw gap;
    }
  }
  const classifierMeta = runClassifierMetaTests(profile, options);
  const probeRunner = options.runProbeFn || runProbe;
  const results = [];
  for (const mutant of mutants) {
    const first = classifyProbe(
      probeRunner(profile, mutant, options),
      { ...mutant, profile },
    );
    const second = classifyProbe(
      probeRunner(profile, mutant, options),
      { ...mutant, profile },
    );
    assert.deepEqual(
      { ...second, error: undefined },
      { ...first, error: undefined },
      `${profile}/${mutant.id}: classifier is nondeterministic`,
    );
    results.push(first);
  }
  const killed = results.filter((row) => row.classification === "killed").length;
  const survived = results.length - killed;
  const summary = {
    schema: "pikiio-action-mutation-result-v1",
    profile,
    mode: options.product ? "product-acceptance" : "harness-self-test",
    total: results.length,
    criticalTotal: results.length,
    killed,
    criticalKilled: killed,
    survived,
    survivedCritical: survived,
    scorePercent: (killed / results.length) * 100,
    criticalKillPercent: (killed / results.length) * 100,
    classifierAmbiguityCount: 0,
    classifierMeta,
    metaTestsPassed: true,
    results,
  };
  if (survived) {
    const error = new Error(
      `${profile}: ${survived}/${results.length} critical mutants survived`,
    );
    error.code = "PIKIIO_ACTION_MUTANTS_SURVIVED";
    error.summary = summary;
    throw error;
  }
  return summary;
}

function main(argv = process.argv.slice(2), options = {}) {
  const selfTest = argv.includes("--self-test");
  const profileIndex = argv.indexOf("--profile");
  if (selfTest && profileIndex >= 0) {
    throw new Error("--self-test and --profile are mutually exclusive");
  }
  if (!selfTest && profileIndex < 0) {
    throw new Error("Use --self-test or --profile ACTION-01|ACTION-02|ACTION-03");
  }
  if (selfTest) {
    const profileRunner = options.runMutationProfileFn || runMutationProfile;
    const profiles = PROFILE_IDS.map((profile) =>
      profileRunner(profile, { ...options, product: false }),
    );
    assert.throws(
      () => validateMutationDefinitions("ACTION-99"),
      { code: "PIKIIO_ACTION_PROOF_PROFILE_UNKNOWN" },
    );
    return {
      schema: "pikiio-action-mutation-self-test-v1",
      populationPerProfile: CRITICAL_MUTATION_POPULATION,
      profiles,
      classifierAmbiguityCount: 0,
      metaTestsPassed: true,
    };
  }
  const profileRunner = options.runMutationProfileFn || runMutationProfile;
  return profileRunner(assertProfileId(argv[profileIndex + 1]), {
    ...options,
    product: true,
  });
}

function runCli(argv = process.argv.slice(2), options = {}) {
  const writeStdout =
    options.writeStdout || ((value) => process.stdout.write(String(value)));
  const writeStderr =
    options.writeStderr || ((value) => process.stderr.write(String(value)));
  const setExitCode =
    options.setExitCode || ((value) => {
      process.exitCode = value;
    });
  try {
    const summary = main(argv, options);
    writeStdout(`${JSON.stringify(summary)}\n`);
    setExitCode(0);
    return { exitCode: 0, summary };
  } catch (error) {
    const summary = error?.summary || {
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    };
    writeStderr(`${JSON.stringify(summary)}\n`);
    setExitCode(1);
    return { exitCode: 1, summary };
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  CRITICAL_MUTATION_POPULATION,
  MUTANTS,
  classifyProbe,
  main,
  runMutationProfile,
  runClassifierMetaTests,
  runCli,
  runProbe,
  validateMutationDefinitions,
};

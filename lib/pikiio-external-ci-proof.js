"use strict";

const crypto = require("node:crypto");

const REQUEST_SCHEMA = "pikiio-external-ci-request-v3";
const MATERIALIZATION_SCHEMA = "pikiio-external-ci-materialization-v3";
const JUDGE_SCHEMA = "pikiio-external-ci-judge-v3";
const PLATFORM_RECEIPT_SCHEMA = "pikiio-external-ci-platform-receipt-v3";
const MACOS_LINEAGE_SCHEMA = "pikiio-external-ci-macos-lineage-v3";
const VERDICT_SCHEMA = "pikiio-external-ci-verdict-v3";
const ATTESTATION_BODY_SCHEMA = "pikiio-external-ci-attestation-body-v3";
const CERTIFICATION_SCHEMA = "pikiio-external-ci-certification-v3";
const PACKAGE_SCHEMA = "pikiio-external-ci-package-v3";
const COMMAND_PLAN_SCHEMA = "pikiio-external-ci-command-plan-v3";
const MACOS_IDENTITY_BODY_SCHEMA =
  "pikiio-external-ci-macos-identity-body-v1";
const MACOS_IDENTITY_EVIDENCE_SCHEMA =
  "pikiio-external-ci-macos-identity-evidence-v1";
const EXPECTED_REPOSITORY = "demo-maintainer/Pikiio-app-";
const EXPECTED_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
const AUTHORITY_WORKFLOW_PATH =
  ".github/workflows/pikiio-proof-collector-v3.yml";
const AUTHORITY_WORKFLOW_REF = "pikiio-proof-authority-v3";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_COMMANDS = 512;
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MINIMUM_COVERAGE = Object.freeze({
  lines: 95,
  branches: 90,
  functions: 95,
});
const MINIMUM_MUTATION_SCORE = 90;
const MINIMUM_UNIT_TESTS = 1;
const MINIMUM_GHERKIN_SCENARIOS = 1;
const MINIMUM_MUTANTS = 1;
const MINIMUM_CRITICAL_MUTANTS = 1;
const REQUIRED_REPEAT_COUNT = 3;
const REQUIRED_COMMAND_GROUPS = Object.freeze([
  "syntax",
  "unit",
  "gherkin",
  "mutation",
  "focused",
  "neighbor",
  "broad",
  "production-shaped",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_PATTERN = /^(?:GOV|TRUTH|ACTION)-[0-9]{2}$/;
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_RELATIVE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/@+:-]+(?:\/[A-Za-z0-9._@+:-]+)*$/;

const REQUEST_KEYS = Object.freeze([
  "schema",
  "phaseId",
  "phaseScopeBaseCommit",
  "candidateCommit",
  "requestNonce",
]);
const MATERIALIZATION_KEYS = Object.freeze([
  "schema",
  "repository",
  "run",
  "authority",
  "phase",
  "candidate",
  "sourceManifestSha256",
  "receiptHash",
]);
const RUN_KEYS = Object.freeze(["runId", "runAttempt", "requestNonce"]);
const AUTHORITY_KEYS = Object.freeze([
  "ref",
  "commit",
  "tree",
  "workflowPath",
  "workflowBlobSha256",
  "phaseProofRegistrySha256",
  "jwksRegistrySha256",
  "toolchainSha256",
  "judgeImageDigest",
  "toolchainCommissioned",
  "ancestorOfScopeVerified",
]);
const PHASE_KEYS = Object.freeze([
  "phaseId",
  "scopeBaseCommit",
  "scopeBaseTree",
  "scopeLedgerSha256",
  "candidateLedgerRevision",
  "candidateLedgerSha256",
  "qualityPlanSha256",
  "populationFloors",
  "commandPlan",
  "commandPlanSha256",
  "testAuthorityTree",
  "frozenAuthorityPathsSha256",
  "ledgerDeltaSha256",
  "activePhaseVerified",
  "dependenciesVerified",
  "allowedPathsVerified",
  "antiWeakeningVerified",
]);
const CANDIDATE_KEYS = Object.freeze([
  "commit",
  "tree",
  "parent",
  "changedPathsSha256",
  "diffSha256",
  "authoritySnapshotSha256",
  "scopeParentVerified",
]);
const JUDGE_KEYS = Object.freeze([
  "schema",
  "role",
  "materializationReceiptHash",
  "authorityCommit",
  "phaseId",
  "phaseScopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "phaseProofRegistrySha256",
  "qualityPlanSha256",
  "populationFloors",
  "commandPlanSha256",
  "sourceManifestSha256",
  "executedCommandCount",
  "executedCommandNamesSha256",
  "executionReceiptsSha256",
  "macosReceiptHash",
  "sandbox",
  "evidence",
  "metrics",
  "outcome",
  "receiptHash",
]);
const SANDBOX_KEYS = Object.freeze([
  "imageDigest",
  "toolchainSha256",
  "uid",
  "network",
  "capabilities",
  "readOnlyRoot",
  "authorityMount",
  "candidateMount",
  "credentialKeysPresent",
  "githubOutputPresent",
  "freshState",
  "freshContainerPerCommand",
  "childProtocol",
  "workspaceBeforeSha256",
  "workspaceAfterSha256",
]);
const EVIDENCE_KEYS = Object.freeze([
  "unitCoverage",
  "gherkin",
  "mutation",
  "layers",
  "macosUnit",
  "stdout",
  "stderr",
]);
const CAS_KEYS = Object.freeze(["address", "sha256", "byteLength"]);
const METRICS_KEYS = Object.freeze([
  "unit",
  "coverage",
  "gherkin",
  "mutation",
]);
const UNIT_KEYS = Object.freeze([
  "repeats",
  "tests",
  "passed",
  "failed",
  "cancelled",
  "skipped",
  "todo",
]);
const COVERAGE_KEYS = Object.freeze([
  "perFileProofSha256",
  "lines",
  "branches",
  "functions",
]);
const GHERKIN_KEYS = Object.freeze([
  "scenarios",
  "passed",
  "failed",
  "skipped",
  "undefined",
  "ambiguous",
  "pending",
]);
const MUTATION_KEYS = Object.freeze([
  "total",
  "killed",
  "survived",
  "score",
  "criticalTotal",
  "criticalKilled",
  "survivedCritical",
  "criticalIdsSha256",
  "classifierMetaTestsPassed",
]);
const VERDICT_KEYS = Object.freeze([
  "schema",
  "materializationReceiptHash",
  "judgeReceiptHashes",
  "macosReceiptHash",
  "populationFloors",
  "evidenceManifestSha256",
  "metrics",
  "passed",
  "productionAuthority",
  "receiptHash",
]);
const JUDGE_HASH_KEYS = Object.freeze(["primary", "independent"]);
const BODY_KEYS = Object.freeze([
  "schema",
  "repository",
  "run",
  "authority",
  "phase",
  "candidate",
  "macosLineage",
  "evidence",
  "productionAuthority",
]);
const BODY_AUTHORITY_KEYS = Object.freeze([
  "ref",
  "commit",
  "tree",
  "workflowPath",
  "workflowBlobSha256",
  "phaseProofRegistrySha256",
  "jwksRegistrySha256",
  "toolchainSha256",
  "judgeImageDigest",
]);
const BODY_EVIDENCE_KEYS = Object.freeze([
  "materializationReceiptHash",
  "primaryJudgeReceiptHash",
  "independentJudgeReceiptHash",
  "macosReceiptHash",
  "qualityVerdictHash",
  "evidenceManifestSha256",
  "primaryUnitCoverageRawSha256",
  "primaryGherkinRawSha256",
  "primaryMutationRawSha256",
  "primaryLayersRawSha256",
  "independentUnitCoverageRawSha256",
  "independentGherkinRawSha256",
  "independentMutationRawSha256",
  "independentLayersRawSha256",
  "macosUnitCoverageRawSha256",
  "macosLineageReceiptHash",
  "authorityWorkflowRawSha256",
]);
const CERTIFICATION_KEYS = Object.freeze([
  "schema",
  "attestationBody",
  "attestationBodySha256",
  "collectorReceipt",
  "collectorReceiptSha256",
  "evidenceManifest",
  "replay",
  "verifiedAt",
  "productionAuthority",
  "certificationHash",
]);
const REPLAY_KEYS = Object.freeze([
  "issuer",
  "jti",
  "replayKeySha256",
  "multiHostSafe",
]);
const TRUSTED_AUTHORITY_KEYS = Object.freeze([
  "ref",
  "commit",
  "workflowPath",
  "workflowBlobSha256",
  "phaseProofRegistrySha256",
  "jwksRegistrySha256",
  "toolchainSha256",
  "judgeImageDigest",
]);
const POPULATION_KEYS = Object.freeze([
  "unitTests",
  "criticalMutants",
  "gherkinScenarios",
]);
const COMMAND_PLAN_KEYS = Object.freeze([
  "schema",
  "repeats",
  "requiredCoverageFiles",
  "commands",
]);
const COMMAND_KEYS = Object.freeze([
  "name",
  "group",
  "platform",
  "repeat",
  "executable",
  "args",
  "definitionSha256",
]);
const SOURCE_HISTORY_KEYS = Object.freeze([
  "phaseId",
  "authorityCommit",
  "scopeParentCommit",
  "scopeCommit",
  "candidateCommit",
  "scopeParent",
  "candidateParent",
  "authorityAncestorOfScopeParent",
  "scopeLedgerBaseCommit",
  "candidateLedgerBaseCommit",
  "scopeLedgerSha256",
  "candidateLedgerSha256",
  "priorLedger",
  "scopeLedger",
  "candidateLedger",
  "scopeDeclarationChangedPaths",
  "candidateChangedPaths",
  "candidatePathsAllowed",
  "frozenAuthorityPathsVerified",
  "frozenPhaseContractVerified",
]);
const MACOS_IDENTITY_BODY_KEYS = Object.freeze([
  "schema",
  "repository",
  "run",
  "authority",
  "phase",
  "candidate",
  "runner",
  "result",
  "productionAuthority",
]);
const MACOS_IDENTITY_AUTHORITY_KEYS = Object.freeze([
  "ref",
  "commit",
  "workflowPath",
  "workflowBlobSha256",
  "jwksRegistrySha256",
  "toolchainSha256",
]);
const MACOS_IDENTITY_PHASE_KEYS = Object.freeze([
  "phaseId",
  "scopeBaseCommit",
  "commandPlanSha256",
  "materializationReceiptHash",
]);
const MACOS_IDENTITY_CANDIDATE_KEYS = Object.freeze(["commit", "tree"]);
const MACOS_IDENTITY_RUNNER_KEYS = Object.freeze([
  "jobName",
  "runsOn",
  "platform",
  "runnerImage",
  "nodeVersion",
  "nodeSha256",
  "npmVersion",
  "npmCliSha256",
]);
const MACOS_IDENTITY_RESULT_KEYS = Object.freeze([
  "executedCommandCount",
  "executedCommandNamesSha256",
  "executionReceiptsSha256",
  "unitCoverageRawSha256",
  "unitCoverageRawByteLength",
  "stdoutRawSha256",
  "stdoutRawByteLength",
  "semanticStderrSha256",
  "semanticStderrByteLength",
  "outcome",
]);
const MACOS_IDENTITY_EVIDENCE_KEYS = Object.freeze([
  "schema",
  "identityBody",
  "identityBodySha256",
  "collectorReceipt",
  "collectorReceiptSha256",
  "semanticStderrBase64",
]);
const PHASE_LEDGER_PATH =
  "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json";
const CHILD_EXECUTION_KEYS = Object.freeze([
  "protocol",
  "commandName",
  "commandSha256",
  "definitionSha256",
  "platform",
  "repeat",
  "status",
  "signal",
  "errorCode",
  "timedOut",
  "elapsedMs",
  "stdoutSha256",
  "stdoutByteLength",
  "stdoutBase64",
  "stderrSha256",
  "stderrByteLength",
  "stderrBase64",
]);
const PLATFORM_RECEIPT_KEYS = Object.freeze([
  "schema",
  "role",
  "materializationReceiptHash",
  "authorityCommit",
  "phaseId",
  "phaseScopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "populationFloors",
  "commandPlanSha256",
  "toolchainSha256",
  "platform",
  "runnerImage",
  "nodeVersion",
  "nodeSha256",
  "npmVersion",
  "npmCliSha256",
  "executedCommandCount",
  "executedCommandNamesSha256",
  "executionReceiptsSha256",
  "evidence",
  "metrics",
  "outcome",
  "receiptHash",
]);
const PLATFORM_EVIDENCE_KEYS = Object.freeze([
  "unitCoverage",
  "stdout",
  "stderr",
]);
const PLATFORM_METRICS_KEYS = Object.freeze(["unit", "coverage"]);
const MACOS_LINEAGE_KEYS = Object.freeze([
  "schema",
  "repository",
  "run",
  "authority",
  "materializationArtifact",
  "macosArtifact",
  "macosUnitNeeds",
  "judgeNeeds",
  "reducerNeeds",
  "collectorNeeds",
  "authorityWorkflow",
  "productionAuthority",
  "receiptHash",
]);
const MACOS_LINEAGE_AUTHORITY_KEYS = Object.freeze([
  "commit",
  "workflowPath",
  "workflowBlobSha256",
]);
const MACOS_LINEAGE_ARTIFACT_KEYS = Object.freeze([
  "artifactId",
  "artifactDigest",
  "receiptHash",
]);
const PACKAGE_KEYS = Object.freeze([
  "schema",
  "request",
  "materialization",
  "macosLineage",
  "macosJudge",
  "primaryJudge",
  "independentJudge",
  "verdict",
  "certification",
  "evidenceManifest",
  "packageHash",
]);

class ExternalCiProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExternalCiProofError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ExternalCiProofError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(stableValue(value));
  } catch (error) {
    fail("NON_CANONICAL_JSON", "value cannot be canonically serialized", {
      cause: error.message,
    });
  }
  if (typeof serialized !== "string") {
    fail("NON_CANONICAL_JSON", "value cannot be canonically serialized");
  }
  return serialized;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function requireExactKeys(value, expected, label) {
  if (!exactKeys(value, expected)) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`);
  }
}

function requireString(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    value.includes("\u0000")
  ) {
    fail("INVALID_STRING", `${label} must be a bounded non-empty string`);
  }
}

function requirePattern(value, pattern, label, code) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, `${label} is invalid`);
  }
}

function requireSha(value, label) {
  requirePattern(value, SHA256_PATTERN, label, "INVALID_SHA256");
}

function requireCommit(value, label) {
  requirePattern(value, COMMIT_PATTERN, label, "INVALID_COMMIT");
}

function requireInteger(value, label, { minimum = 0, maximum = 1e9 } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail("INVALID_INTEGER", `${label} is outside its integer bounds`);
  }
}

function requireFalse(value, label) {
  if (value !== false) {
    fail("PRODUCTION_AUTHORITY_FORBIDDEN", `${label} must be false`);
  }
}

function requireTrue(value, label) {
  if (value !== true) {
    fail("REQUIRED_PROOF_MISSING", `${label} must be true`);
  }
}

function requireJsonBound(value, label, maximum = MAX_JSON_BYTES) {
  const bytes = Buffer.byteLength(stableJson(value), "utf8");
  if (bytes > maximum) {
    fail("SIZE_LIMIT_EXCEEDED", `${label} exceeds its byte limit`, {
      bytes,
      maximum,
    });
  }
}

function hashWithoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function clone(value) {
  return JSON.parse(stableJson(value));
}

function validatePopulationFloors(floors, label = "populationFloors") {
  requireExactKeys(floors, POPULATION_KEYS, label);
  for (const key of POPULATION_KEYS) {
    requireInteger(floors[key], `${label}.${key}`, { minimum: 1 });
  }
  return clone(floors);
}

function commandNamesSha256(commandPlan, platform) {
  const plan = validateCommandPlan(commandPlan);
  if (!["linux", "macos"].includes(platform)) {
    fail("INVALID_PLATFORM", "command platform is invalid");
  }
  return sha256(
    stableJson(
      plan.commands
        .filter((command) => command.platform === platform)
        .map((command) => command.name)
        .sort(),
    ),
  );
}

function commandDefinitionSha256(command) {
  if (!isPlainObject(command)) {
    fail("INVALID_COMMAND_PLAN", "command definition must be an object");
  }
  const definition = {};
  for (const key of COMMAND_KEYS) {
    if (key !== "definitionSha256") definition[key] = command[key];
  }
  return sha256(stableJson(definition));
}

function validateCommandPlan(commandPlan) {
  requireExactKeys(commandPlan, COMMAND_PLAN_KEYS, "commandPlan");
  if (commandPlan.schema !== COMMAND_PLAN_SCHEMA) {
    fail("INVALID_SCHEMA", "command plan schema is not v3");
  }
  requireInteger(commandPlan.repeats, "commandPlan.repeats", {
    minimum: REQUIRED_REPEAT_COUNT,
    maximum: REQUIRED_REPEAT_COUNT,
  });
  if (
    !Array.isArray(commandPlan.requiredCoverageFiles) ||
    commandPlan.requiredCoverageFiles.length === 0 ||
    commandPlan.requiredCoverageFiles.length > MAX_COMMANDS
  ) {
    fail("INVALID_COMMAND_PLAN", "required coverage files are invalid");
  }
  const coverageFiles = new Set();
  for (const [index, relativePath] of
    commandPlan.requiredCoverageFiles.entries()) {
    requirePattern(
      relativePath,
      SAFE_RELATIVE_PATH_PATTERN,
      `commandPlan.requiredCoverageFiles[${index}]`,
      "INVALID_PATH",
    );
    if (!relativePath.endsWith(".js") || coverageFiles.has(relativePath)) {
      fail(
        "INVALID_COMMAND_PLAN",
        "required coverage files must be unique JavaScript paths",
      );
    }
    coverageFiles.add(relativePath);
  }
  if (
    !Array.isArray(commandPlan.commands) ||
    commandPlan.commands.length === 0 ||
    commandPlan.commands.length > MAX_COMMANDS
  ) {
    fail("INVALID_COMMAND_PLAN", "command plan has invalid cardinality");
  }
  const names = new Set();
  const byGroupAndRepeat = new Map();
  for (const [index, command] of commandPlan.commands.entries()) {
    requireExactKeys(command, COMMAND_KEYS, `commandPlan.commands[${index}]`);
    requireString(command.name, `commandPlan.commands[${index}].name`, 256);
    if (names.has(command.name)) {
      fail("INVALID_COMMAND_PLAN", "command names must be unique");
    }
    names.add(command.name);
    if (!REQUIRED_COMMAND_GROUPS.includes(command.group)) {
      fail("INVALID_COMMAND_PLAN", "command group is not part of the gauntlet");
    }
    const expectedPlatform = command.group === "unit" ? "macos" : "linux";
    if (command.platform !== expectedPlatform) {
      fail(
        "INVALID_COMMAND_PLAN",
        `${command.group} must run on ${expectedPlatform}`,
      );
    }
    requireInteger(command.repeat, `commandPlan.commands[${index}].repeat`, {
      minimum: 1,
      maximum:
        command.group === "syntax" ? 1 : commandPlan.repeats,
    });
    if (!["node", "npm", "git"].includes(command.executable)) {
      fail("INVALID_COMMAND_PLAN", "command executable is not approved");
    }
    if (!Array.isArray(command.args) || command.args.length > 128) {
      fail("INVALID_COMMAND_PLAN", "command arguments are invalid");
    }
    for (const [argumentIndex, argument] of command.args.entries()) {
      requireString(
        argument,
        `commandPlan.commands[${index}].args[${argumentIndex}]`,
        2048,
      );
      if (/[\r\n\u0000]/.test(argument)) {
        fail("INVALID_COMMAND_PLAN", "command arguments cannot contain controls");
      }
    }
    requireSha(
      command.definitionSha256,
      `commandPlan.commands[${index}].definitionSha256`,
    );
    if (command.definitionSha256 !== commandDefinitionSha256(command)) {
      fail(
        "COMMAND_DEFINITION_MISMATCH",
        "command definition digest does not bind its exact fields",
      );
    }
    const countKey = `${command.group}:${command.repeat}`;
    byGroupAndRepeat.set(
      countKey,
      (byGroupAndRepeat.get(countKey) || 0) + 1,
    );
  }
  for (const group of REQUIRED_COMMAND_GROUPS) {
    const repeatCounts = [];
    const maximumRepeat = group === "syntax" ? 1 : commandPlan.repeats;
    for (let repeat = 1; repeat <= maximumRepeat; repeat += 1) {
      repeatCounts.push(byGroupAndRepeat.get(`${group}:${repeat}`) || 0);
    }
    if (
      repeatCounts.some((count) => count === 0) ||
      repeatCounts.some((count) => count !== repeatCounts[0])
    ) {
      fail(
        "INCOMPLETE_COMMAND_PLAN",
        `${group} commands are missing or differ between repeats`,
      );
    }
  }
  requireJsonBound(commandPlan, "commandPlan");
  return clone(commandPlan);
}

function validateConstructibleSourceHistory(history) {
  requireExactKeys(history, SOURCE_HISTORY_KEYS, "source history");
  requirePattern(
    history.phaseId,
    PHASE_PATTERN,
    "source history.phaseId",
    "INVALID_PHASE",
  );
  for (const key of [
    "authorityCommit",
    "scopeParentCommit",
    "scopeCommit",
    "candidateCommit",
    "scopeParent",
    "candidateParent",
    "scopeLedgerBaseCommit",
    "candidateLedgerBaseCommit",
  ]) {
    requireCommit(history[key], `source history.${key}`);
  }
  for (const key of ["scopeLedgerSha256", "candidateLedgerSha256"]) {
    requireSha(history[key], `source history.${key}`);
  }
  if (
    new Set([
      history.authorityCommit,
      history.scopeParentCommit,
      history.scopeCommit,
      history.candidateCommit,
    ]).size !== 4
  ) {
    fail(
      "COMMIT_ROLE_COLLISION",
      "authority A, scope parent B, scope declaration S, and candidate C must be distinct",
    );
  }
  if (
    history.scopeParent !== history.scopeParentCommit ||
    history.candidateParent !== history.scopeCommit
  ) {
    fail(
      "COMMIT_BINDING_MISMATCH",
      "constructible history must be A..B -> S -> C",
    );
  }
  requireTrue(
    history.authorityAncestorOfScopeParent,
    "source history.authorityAncestorOfScopeParent",
  );
  if (
    history.scopeLedgerBaseCommit !== history.scopeParentCommit ||
    history.candidateLedgerBaseCommit !== history.scopeParentCommit
  ) {
    fail(
      "SCOPE_DECLARATION_MISMATCH",
      "both S and C ledgers must bind the actual pre-scope parent B",
    );
  }
  if (history.scopeLedgerSha256 !== history.candidateLedgerSha256) {
    fail(
      "LEDGER_MUTATED_BY_CANDIDATE",
      "candidate C must preserve the exact scope declaration ledger from S",
    );
  }
  for (const key of ["priorLedger", "scopeLedger", "candidateLedger"]) {
    if (!isPlainObject(history[key])) {
      fail("INVALID_LEDGER", `source history.${key} must be an object`);
    }
  }
  const expectedScopeLedger = clone(history.priorLedger);
  if (!Array.isArray(expectedScopeLedger.phases)) {
    fail("INVALID_LEDGER", "source history.priorLedger has no phase list");
  }
  const matchingPhases = expectedScopeLedger.phases.filter(
    (phase) => isPlainObject(phase) && phase.id === history.phaseId,
  );
  if (matchingPhases.length !== 1) {
    fail(
      "SCOPE_DECLARATION_MISMATCH",
      "B must contain exactly one target phase",
    );
  }
  matchingPhases[0].scopeBaseCommit = history.scopeParentCommit;
  if (stableJson(expectedScopeLedger) !== stableJson(history.scopeLedger)) {
    fail(
      "SCOPE_DECLARATION_MISMATCH",
      "B to S may mutate only the target phase scopeBaseCommit to B",
    );
  }
  if (stableJson(history.scopeLedger) !== stableJson(history.candidateLedger)) {
    fail(
      "LEDGER_MUTATED_BY_CANDIDATE",
      "candidate C must preserve the semantic S ledger",
    );
  }
  for (const [key, paths] of [
    ["scopeDeclarationChangedPaths", history.scopeDeclarationChangedPaths],
    ["candidateChangedPaths", history.candidateChangedPaths],
  ]) {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_COMMANDS) {
      fail("INVALID_PATH_SET", `source history.${key} is invalid`);
    }
    const unique = new Set();
    for (const [index, relativePath] of paths.entries()) {
      requirePattern(
        relativePath,
        SAFE_RELATIVE_PATH_PATTERN,
        `source history.${key}[${index}]`,
        "INVALID_PATH",
      );
      if (unique.has(relativePath)) {
        fail("INVALID_PATH_SET", `source history.${key} has duplicates`);
      }
      unique.add(relativePath);
    }
    if (stableJson(paths) !== stableJson([...unique].sort())) {
      fail("INVALID_PATH_SET", `source history.${key} must be sorted`);
    }
  }
  if (
    history.scopeDeclarationChangedPaths.length !== 1 ||
    history.scopeDeclarationChangedPaths[0] !== PHASE_LEDGER_PATH
  ) {
    fail(
      "SCOPE_DECLARATION_MISMATCH",
      "S must be a ledger-only scope declaration commit",
    );
  }
  if (history.candidateChangedPaths.includes(PHASE_LEDGER_PATH)) {
    fail(
      "LEDGER_MUTATED_BY_CANDIDATE",
      "candidate C cannot rewrite the scope declaration ledger",
    );
  }
  requireTrue(
    history.candidatePathsAllowed,
    "source history.candidatePathsAllowed",
  );
  requireTrue(
    history.frozenAuthorityPathsVerified,
    "source history.frozenAuthorityPathsVerified",
  );
  requireTrue(
    history.frozenPhaseContractVerified,
    "source history.frozenPhaseContractVerified",
  );
  requireJsonBound(history, "source history", 64 * 1024);
  return clone(history);
}

function commandCount(commandPlan, platform) {
  return validateCommandPlan(commandPlan).commands.filter(
    (command) => command.platform === platform,
  ).length;
}

function validateRun(run, label = "run") {
  requireExactKeys(run, RUN_KEYS, label);
  requirePattern(run.runId, RUN_ID_PATTERN, `${label}.runId`, "INVALID_RUN");
  requirePattern(
    run.runAttempt,
    RUN_ID_PATTERN,
    `${label}.runAttempt`,
    "INVALID_RUN",
  );
  requirePattern(
    run.requestNonce,
    NONCE_PATTERN,
    `${label}.requestNonce`,
    "INVALID_NONCE",
  );
}

function validateCertificationRequest(request) {
  requireExactKeys(request, REQUEST_KEYS, "request");
  if (request.schema !== REQUEST_SCHEMA) {
    fail("INVALID_SCHEMA", "request schema is not v3");
  }
  requirePattern(request.phaseId, PHASE_PATTERN, "request.phaseId", "INVALID_PHASE");
  requireCommit(request.phaseScopeBaseCommit, "request.phaseScopeBaseCommit");
  requireCommit(request.candidateCommit, "request.candidateCommit");
  if (request.phaseScopeBaseCommit === request.candidateCommit) {
    fail("COMMIT_ROLE_COLLISION", "scope S and candidate C must differ");
  }
  requirePattern(
    request.requestNonce,
    NONCE_PATTERN,
    "request.requestNonce",
    "INVALID_NONCE",
  );
  requireJsonBound(request, "request", 8 * 1024);
  return clone(request);
}

function validateAuthority(authority, { body = false } = {}) {
  requireExactKeys(
    authority,
    body ? BODY_AUTHORITY_KEYS : AUTHORITY_KEYS,
    "authority",
  );
  if (authority.ref !== AUTHORITY_WORKFLOW_REF) {
    fail("INVALID_AUTHORITY_REF", "authority.ref is not the frozen v3 tag");
  }
  requireCommit(authority.commit, "authority.commit");
  requireCommit(authority.tree, "authority.tree");
  if (authority.workflowPath !== AUTHORITY_WORKFLOW_PATH) {
    fail("INVALID_AUTHORITY_PATH", "authority.workflowPath is not v3");
  }
  for (const key of [
    "workflowBlobSha256",
    "phaseProofRegistrySha256",
    "jwksRegistrySha256",
    "toolchainSha256",
  ]) {
    requireSha(authority[key], `authority.${key}`);
  }
  requirePattern(
    authority.judgeImageDigest,
    /^sha256:[a-f0-9]{64}$/,
    "authority.judgeImageDigest",
    "INVALID_IMAGE_DIGEST",
  );
  if (!body) {
    requireTrue(
      authority.toolchainCommissioned,
      "authority.toolchainCommissioned",
    );
    requireTrue(
      authority.ancestorOfScopeVerified,
      "authority.ancestorOfScopeVerified",
    );
  }
}

function validateTrustedAuthority(trustedAuthority) {
  requireExactKeys(
    trustedAuthority,
    TRUSTED_AUTHORITY_KEYS,
    "trustedAuthority",
  );
  if (
    trustedAuthority.ref !== AUTHORITY_WORKFLOW_REF ||
    trustedAuthority.workflowPath !== AUTHORITY_WORKFLOW_PATH
  ) {
    fail("UNTRUSTED_AUTHORITY", "trusted authority ref or workflow path is invalid");
  }
  requireCommit(trustedAuthority.commit, "trustedAuthority.commit");
  for (const key of [
    "workflowBlobSha256",
    "phaseProofRegistrySha256",
    "jwksRegistrySha256",
    "toolchainSha256",
  ]) {
    requireSha(trustedAuthority[key], `trustedAuthority.${key}`);
  }
  requirePattern(
    trustedAuthority.judgeImageDigest,
    /^sha256:[a-f0-9]{64}$/,
    "trustedAuthority.judgeImageDigest",
    "INVALID_IMAGE_DIGEST",
  );
}

function validatePhase(phase) {
  requireExactKeys(phase, PHASE_KEYS, "phase");
  requirePattern(phase.phaseId, PHASE_PATTERN, "phase.phaseId", "INVALID_PHASE");
  requireCommit(phase.scopeBaseCommit, "phase.scopeBaseCommit");
  requireCommit(phase.scopeBaseTree, "phase.scopeBaseTree");
  requireSha(phase.scopeLedgerSha256, "phase.scopeLedgerSha256");
  requireInteger(phase.candidateLedgerRevision, "phase.candidateLedgerRevision", {
    minimum: 1,
  });
  for (const key of [
    "candidateLedgerSha256",
    "qualityPlanSha256",
    "commandPlanSha256",
    "frozenAuthorityPathsSha256",
    "ledgerDeltaSha256",
  ]) {
    requireSha(phase[key], `phase.${key}`);
  }
  validatePopulationFloors(phase.populationFloors, "phase.populationFloors");
  validateCommandPlan(phase.commandPlan);
  if (
    phase.commandPlanSha256 !== sha256(stableJson(phase.commandPlan))
  ) {
    fail("HASH_MISMATCH", "phase command plan digest does not match");
  }
  requireCommit(phase.testAuthorityTree, "phase.testAuthorityTree");
  for (const key of [
    "activePhaseVerified",
    "dependenciesVerified",
    "allowedPathsVerified",
    "antiWeakeningVerified",
  ]) {
    requireTrue(phase[key], `phase.${key}`);
  }
}

function validateCandidate(candidate) {
  requireExactKeys(candidate, CANDIDATE_KEYS, "candidate");
  requireCommit(candidate.commit, "candidate.commit");
  requireCommit(candidate.tree, "candidate.tree");
  requireCommit(candidate.parent, "candidate.parent");
  for (const key of [
    "changedPathsSha256",
    "diffSha256",
    "authoritySnapshotSha256",
  ]) {
    requireSha(candidate[key], `candidate.${key}`);
  }
  requireTrue(candidate.scopeParentVerified, "candidate.scopeParentVerified");
}

function validateMaterializationReceipt(receipt) {
  requireExactKeys(receipt, MATERIALIZATION_KEYS, "materialization");
  if (receipt.schema !== MATERIALIZATION_SCHEMA) {
    fail("INVALID_SCHEMA", "materialization schema is not v3");
  }
  if (receipt.repository !== EXPECTED_REPOSITORY) {
    fail("INVALID_REPOSITORY", "materialization repository is not Pikiio");
  }
  validateRun(receipt.run);
  validateAuthority(receipt.authority);
  validatePhase(receipt.phase);
  validateCandidate(receipt.candidate);
  requireSha(receipt.sourceManifestSha256, "materialization.sourceManifestSha256");
  requireSha(receipt.receiptHash, "materialization.receiptHash");
  if (receipt.candidate.parent !== receipt.phase.scopeBaseCommit) {
    fail("COMMIT_BINDING_MISMATCH", "candidate C is not a child of scope S");
  }
  if (receipt.candidate.commit === receipt.phase.scopeBaseCommit) {
    fail("COMMIT_ROLE_COLLISION", "scope S and candidate C must differ");
  }
  if (receipt.authority.commit === receipt.phase.scopeBaseCommit) {
    fail("COMMIT_ROLE_COLLISION", "authority A and scope S must differ");
  }
  if (receipt.receiptHash !== hashWithoutField(receipt, "receiptHash")) {
    fail("HASH_MISMATCH", "materialization receipt hash does not match");
  }
  requireJsonBound(receipt, "materialization");
  return clone(receipt);
}

function sealMaterializationReceipt(fields) {
  const receipt = {
    ...clone(fields),
    schema: MATERIALIZATION_SCHEMA,
    receiptHash: "0".repeat(64),
  };
  receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
  return validateMaterializationReceipt(receipt);
}

function validateCasReference(reference, label = "CAS reference") {
  requireExactKeys(reference, CAS_KEYS, label);
  requireSha(reference.sha256, `${label}.sha256`);
  if (reference.address !== `sha256:${reference.sha256}`) {
    fail("INVALID_CAS_ADDRESS", `${label}.address is not content-addressed`);
  }
  requireInteger(reference.byteLength, `${label}.byteLength`, {
    minimum: 1,
    maximum: MAX_ARTIFACT_BYTES,
  });
}

function validateSandbox(sandbox) {
  requireExactKeys(sandbox, SANDBOX_KEYS, "sandbox");
  requirePattern(
    sandbox.imageDigest,
    /^sha256:[a-f0-9]{64}$/,
    "sandbox.imageDigest",
    "INVALID_IMAGE_DIGEST",
  );
  requireSha(sandbox.toolchainSha256, "sandbox.toolchainSha256");
  requireInteger(sandbox.uid, "sandbox.uid", { minimum: 1, maximum: 65535 });
  if (
    sandbox.network !== "none" ||
    sandbox.capabilities !== "none" ||
    sandbox.readOnlyRoot !== true ||
    sandbox.authorityMount !== "read_only" ||
    sandbox.candidateMount !== "read_only" ||
    sandbox.githubOutputPresent !== false ||
    sandbox.freshState !== true ||
    sandbox.freshContainerPerCommand !== true ||
    sandbox.childProtocol !== "pikiio-external-ci-child-v3"
  ) {
    fail("UNSAFE_SANDBOX", "judge sandbox is not fail-closed");
  }
  if (
    !Array.isArray(sandbox.credentialKeysPresent) ||
    sandbox.credentialKeysPresent.length !== 0
  ) {
    fail("CREDENTIAL_EXPOSURE", "judge sandbox contains credential keys");
  }
  requireSha(sandbox.workspaceBeforeSha256, "sandbox.workspaceBeforeSha256");
  requireSha(sandbox.workspaceAfterSha256, "sandbox.workspaceAfterSha256");
  if (sandbox.workspaceBeforeSha256 !== sandbox.workspaceAfterSha256) {
    fail("CANDIDATE_MUTATION", "candidate workspace changed during judgment");
  }
}

function validateMetrics(metrics, populationFloors) {
  const floors = validatePopulationFloors(populationFloors);
  requireExactKeys(metrics, METRICS_KEYS, "metrics");
  requireExactKeys(metrics.unit, UNIT_KEYS, "metrics.unit");
  for (const key of UNIT_KEYS) {
    requireInteger(metrics.unit[key], `metrics.unit.${key}`, {
      minimum: key === "repeats" || key === "tests" ? 1 : 0,
    });
  }
  if (
    metrics.unit.repeats !== REQUIRED_REPEAT_COUNT ||
    metrics.unit.tests < floors.unitTests ||
    metrics.unit.passed !== metrics.unit.tests ||
    metrics.unit.failed !== 0 ||
    metrics.unit.cancelled !== 0 ||
    metrics.unit.skipped !== 0 ||
    metrics.unit.todo !== 0
  ) {
    fail("UNIT_GAUNTLET_FAILED", "unit test metrics do not prove a clean repeat");
  }

  requireExactKeys(metrics.coverage, COVERAGE_KEYS, "metrics.coverage");
  requireSha(
    metrics.coverage.perFileProofSha256,
    "metrics.coverage.perFileProofSha256",
  );
  for (const key of ["lines", "branches", "functions"]) {
    if (
      typeof metrics.coverage[key] !== "number" ||
      !Number.isFinite(metrics.coverage[key]) ||
      metrics.coverage[key] < MINIMUM_COVERAGE[key] ||
      metrics.coverage[key] > 100
    ) {
      fail("COVERAGE_GAUNTLET_FAILED", `coverage ${key} is below its threshold`);
    }
  }

  requireExactKeys(metrics.gherkin, GHERKIN_KEYS, "metrics.gherkin");
  for (const key of GHERKIN_KEYS) {
    requireInteger(metrics.gherkin[key], `metrics.gherkin.${key}`, {
      minimum: key === "scenarios" ? 1 : 0,
    });
  }
  if (
    metrics.gherkin.scenarios < floors.gherkinScenarios ||
    metrics.gherkin.passed !== metrics.gherkin.scenarios ||
    metrics.gherkin.failed !== 0 ||
    metrics.gherkin.skipped !== 0 ||
    metrics.gherkin.undefined !== 0 ||
    metrics.gherkin.ambiguous !== 0 ||
    metrics.gherkin.pending !== 0
  ) {
    fail("GHERKIN_GAUNTLET_FAILED", "Gherkin scenarios are not fully green");
  }

  requireExactKeys(metrics.mutation, MUTATION_KEYS, "metrics.mutation");
  for (const key of [
    "total",
    "killed",
    "survived",
    "criticalTotal",
    "criticalKilled",
    "survivedCritical",
  ]) {
    requireInteger(metrics.mutation[key], `metrics.mutation.${key}`, {
      minimum: key === "total" || key === "criticalTotal" ? 1 : 0,
    });
  }
  if (
    metrics.mutation.total < floors.criticalMutants ||
    metrics.mutation.criticalTotal < floors.criticalMutants ||
    typeof metrics.mutation.score !== "number" ||
    !Number.isFinite(metrics.mutation.score) ||
    metrics.mutation.score < MINIMUM_MUTATION_SCORE ||
    metrics.mutation.score > 100 ||
    metrics.mutation.score !==
      Number(
        (
          (metrics.mutation.killed / metrics.mutation.total) *
          100
        ).toFixed(2),
      ) ||
    metrics.mutation.killed + metrics.mutation.survived !==
      metrics.mutation.total ||
    metrics.mutation.criticalKilled !== metrics.mutation.criticalTotal ||
    metrics.mutation.survivedCritical !== 0 ||
    metrics.mutation.classifierMetaTestsPassed !== true
  ) {
    fail("MUTATION_GAUNTLET_FAILED", "mutation metrics do not meet the gate");
  }
  requireSha(
    metrics.mutation.criticalIdsSha256,
    "metrics.mutation.criticalIdsSha256",
  );
}

function validateJudgeReceipt(receipt, expectedRole) {
  requireExactKeys(receipt, JUDGE_KEYS, "judge");
  if (receipt.schema !== JUDGE_SCHEMA) {
    fail("INVALID_SCHEMA", "judge schema is not v3");
  }
  if (!["primary", "independent"].includes(receipt.role)) {
    fail("INVALID_JUDGE_ROLE", "judge role is not recognized");
  }
  if (expectedRole && receipt.role !== expectedRole) {
    fail("INVALID_JUDGE_ROLE", `expected ${expectedRole} judge`);
  }
  for (const key of [
    "materializationReceiptHash",
    "phaseProofRegistrySha256",
    "qualityPlanSha256",
    "commandPlanSha256",
    "sourceManifestSha256",
    "executedCommandNamesSha256",
    "executionReceiptsSha256",
    "macosReceiptHash",
    "receiptHash",
  ]) {
    requireSha(receipt[key], `judge.${key}`);
  }
  requireCommit(receipt.authorityCommit, "judge.authorityCommit");
  requirePattern(receipt.phaseId, PHASE_PATTERN, "judge.phaseId", "INVALID_PHASE");
  requireCommit(receipt.phaseScopeBaseCommit, "judge.phaseScopeBaseCommit");
  requireCommit(receipt.candidateCommit, "judge.candidateCommit");
  requireCommit(receipt.candidateTree, "judge.candidateTree");
  validatePopulationFloors(receipt.populationFloors, "judge.populationFloors");
  requireInteger(receipt.executedCommandCount, "judge.executedCommandCount", {
    minimum: 1,
    maximum: MAX_COMMANDS,
  });
  validateSandbox(receipt.sandbox);
  requireExactKeys(receipt.evidence, EVIDENCE_KEYS, "judge.evidence");
  for (const key of EVIDENCE_KEYS) {
    validateCasReference(receipt.evidence[key], `judge.evidence.${key}`);
  }
  validateMetrics(receipt.metrics, receipt.populationFloors);
  if (receipt.outcome !== "pass") {
    fail("JUDGE_FAILED", "judge outcome is not pass");
  }
  if (receipt.receiptHash !== hashWithoutField(receipt, "receiptHash")) {
    fail("HASH_MISMATCH", "judge receipt hash does not match");
  }
  requireJsonBound(receipt, "judge");
  return clone(receipt);
}

function sealJudgeReceipt(fields) {
  const receipt = {
    ...clone(fields),
    schema: JUDGE_SCHEMA,
    receiptHash: "0".repeat(64),
  };
  receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
  return validateJudgeReceipt(receipt);
}

function validatePlatformReceipt(receipt) {
  requireExactKeys(receipt, PLATFORM_RECEIPT_KEYS, "platform receipt");
  if (receipt.schema !== PLATFORM_RECEIPT_SCHEMA) {
    fail("INVALID_SCHEMA", "platform receipt schema is not v3");
  }
  if (receipt.role !== "macos-unit" || receipt.platform !== "darwin") {
    fail("INVALID_PLATFORM", "platform receipt is not the macOS unit authority");
  }
  for (const key of [
    "materializationReceiptHash",
    "commandPlanSha256",
    "toolchainSha256",
    "nodeSha256",
    "npmCliSha256",
    "executedCommandNamesSha256",
    "executionReceiptsSha256",
    "receiptHash",
  ]) {
    requireSha(receipt[key], `platformReceipt.${key}`);
  }
  requireCommit(receipt.authorityCommit, "platformReceipt.authorityCommit");
  requirePattern(
    receipt.phaseId,
    PHASE_PATTERN,
    "platformReceipt.phaseId",
    "INVALID_PHASE",
  );
  requireCommit(
    receipt.phaseScopeBaseCommit,
    "platformReceipt.phaseScopeBaseCommit",
  );
  requireCommit(receipt.candidateCommit, "platformReceipt.candidateCommit");
  requireCommit(receipt.candidateTree, "platformReceipt.candidateTree");
  validatePopulationFloors(
    receipt.populationFloors,
    "platformReceipt.populationFloors",
  );
  requireString(receipt.runnerImage, "platformReceipt.runnerImage", 128);
  requirePattern(
    receipt.nodeVersion,
    /^v(?:2[2-9]|[3-9][0-9])\.(?:[0-9]+)\.(?:[0-9]+)$/,
    "platformReceipt.nodeVersion",
    "UNSUPPORTED_NODE_VERSION",
  );
  const [nodeMajor, nodeMinor] = receipt.nodeVersion
    .slice(1)
    .split(".")
    .map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 8)) {
    fail("UNSUPPORTED_NODE_VERSION", "macOS judge requires Node 22.8 or newer");
  }
  requireString(receipt.npmVersion, "platformReceipt.npmVersion", 64);
  requireInteger(
    receipt.executedCommandCount,
    "platformReceipt.executedCommandCount",
    { minimum: REQUIRED_REPEAT_COUNT, maximum: MAX_COMMANDS },
  );
  requireExactKeys(
    receipt.evidence,
    PLATFORM_EVIDENCE_KEYS,
    "platformReceipt.evidence",
  );
  for (const key of PLATFORM_EVIDENCE_KEYS) {
    validateCasReference(
      receipt.evidence[key],
      `platformReceipt.evidence.${key}`,
    );
  }
  requireExactKeys(
    receipt.metrics,
    PLATFORM_METRICS_KEYS,
    "platformReceipt.metrics",
  );
  validateMetrics(
    {
      unit: receipt.metrics.unit,
      coverage: receipt.metrics.coverage,
      gherkin: {
        scenarios: receipt.populationFloors.gherkinScenarios,
        passed: receipt.populationFloors.gherkinScenarios,
        failed: 0,
        skipped: 0,
        undefined: 0,
        ambiguous: 0,
        pending: 0,
      },
      mutation: {
        total: receipt.populationFloors.criticalMutants,
        killed: receipt.populationFloors.criticalMutants,
        survived: 0,
        score: 100,
        criticalTotal: receipt.populationFloors.criticalMutants,
        criticalKilled: receipt.populationFloors.criticalMutants,
        survivedCritical: 0,
        criticalIdsSha256: "0".repeat(64),
        classifierMetaTestsPassed: true,
      },
    },
    receipt.populationFloors,
  );
  if (receipt.outcome !== "pass") {
    fail("JUDGE_FAILED", "macOS platform outcome is not pass");
  }
  if (receipt.receiptHash !== hashWithoutField(receipt, "receiptHash")) {
    fail("HASH_MISMATCH", "platform receipt hash does not match");
  }
  requireJsonBound(receipt, "platform receipt");
  return clone(receipt);
}

function sealPlatformReceipt(fields) {
  const receipt = {
    ...clone(fields),
    schema: PLATFORM_RECEIPT_SCHEMA,
    receiptHash: "0".repeat(64),
  };
  receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
  return validatePlatformReceipt(receipt);
}

function validateMacosIdentityBody(body) {
  requireExactKeys(body, MACOS_IDENTITY_BODY_KEYS, "macOS identity body");
  if (body.schema !== MACOS_IDENTITY_BODY_SCHEMA) {
    fail("INVALID_SCHEMA", "macOS identity body schema is not v1");
  }
  if (body.repository !== EXPECTED_REPOSITORY) {
    fail("INVALID_REPOSITORY", "macOS identity repository is not trusted");
  }
  validateRun(body.run, "macOS identity run");
  requireExactKeys(
    body.authority,
    MACOS_IDENTITY_AUTHORITY_KEYS,
    "macOS identity authority",
  );
  if (
    body.authority.ref !== AUTHORITY_WORKFLOW_REF ||
    body.authority.workflowPath !== AUTHORITY_WORKFLOW_PATH
  ) {
    fail("INVALID_AUTHORITY_PATH", "macOS identity authority is not v3");
  }
  requireCommit(body.authority.commit, "macOS identity authority.commit");
  for (const key of [
    "workflowBlobSha256",
    "jwksRegistrySha256",
    "toolchainSha256",
  ]) {
    requireSha(
      body.authority[key],
      `macOS identity authority.${key}`,
    );
  }
  requireExactKeys(
    body.phase,
    MACOS_IDENTITY_PHASE_KEYS,
    "macOS identity phase",
  );
  requirePattern(
    body.phase.phaseId,
    PHASE_PATTERN,
    "macOS identity phase.phaseId",
    "INVALID_PHASE",
  );
  requireCommit(
    body.phase.scopeBaseCommit,
    "macOS identity phase.scopeBaseCommit",
  );
  requireSha(
    body.phase.commandPlanSha256,
    "macOS identity phase.commandPlanSha256",
  );
  requireSha(
    body.phase.materializationReceiptHash,
    "macOS identity phase.materializationReceiptHash",
  );
  requireExactKeys(
    body.candidate,
    MACOS_IDENTITY_CANDIDATE_KEYS,
    "macOS identity candidate",
  );
  requireCommit(body.candidate.commit, "macOS identity candidate.commit");
  requireCommit(body.candidate.tree, "macOS identity candidate.tree");
  requireExactKeys(
    body.runner,
    MACOS_IDENTITY_RUNNER_KEYS,
    "macOS identity runner",
  );
  if (
    body.runner.jobName !== "macos_unit" ||
    body.runner.runsOn !== "macos-14" ||
    body.runner.platform !== "darwin"
  ) {
    fail(
      "MACOS_IDENTITY_RUNNER_INVALID",
      "macOS identity does not bind the frozen macos_unit runner",
    );
  }
  requireString(body.runner.runnerImage, "macOS identity runner.runnerImage", 128);
  requirePattern(
    body.runner.nodeVersion,
    /^v(?:2[2-9]|[3-9][0-9])\.(?:[0-9]+)\.(?:[0-9]+)$/,
    "macOS identity runner.nodeVersion",
    "UNSUPPORTED_NODE_VERSION",
  );
  requireSha(body.runner.nodeSha256, "macOS identity runner.nodeSha256");
  requireString(body.runner.npmVersion, "macOS identity runner.npmVersion", 64);
  requireSha(
    body.runner.npmCliSha256,
    "macOS identity runner.npmCliSha256",
  );
  requireExactKeys(
    body.result,
    MACOS_IDENTITY_RESULT_KEYS,
    "macOS identity result",
  );
  requireInteger(
    body.result.executedCommandCount,
    "macOS identity result.executedCommandCount",
    { minimum: REQUIRED_REPEAT_COUNT, maximum: MAX_COMMANDS },
  );
  for (const key of [
    "executedCommandNamesSha256",
    "executionReceiptsSha256",
    "unitCoverageRawSha256",
    "stdoutRawSha256",
    "semanticStderrSha256",
  ]) {
    requireSha(body.result[key], `macOS identity result.${key}`);
  }
  for (const key of [
    "unitCoverageRawByteLength",
    "stdoutRawByteLength",
    "semanticStderrByteLength",
  ]) {
    requireInteger(body.result[key], `macOS identity result.${key}`, {
      minimum: 1,
      maximum: MAX_ARTIFACT_BYTES,
    });
  }
  if (body.result.outcome !== "pass") {
    fail("JUDGE_FAILED", "macOS identity result is not pass");
  }
  requireFalse(
    body.productionAuthority,
    "macOS identity productionAuthority",
  );
  requireJsonBound(body, "macOS identity body", MAX_ARTIFACT_BYTES);
  return clone(body);
}

function buildMacosIdentityBody({
  materialization,
  runner,
  executedCommandCount,
  executedCommandNamesSha256,
  executionReceiptsSha256,
  unitCoverage,
  stdout,
  semanticStderrSha256,
  semanticStderrByteLength,
}) {
  const bounded = validateMaterializationReceipt(materialization);
  validateCasReference(unitCoverage, "macOS identity unitCoverage");
  validateCasReference(stdout, "macOS identity stdout");
  const body = {
    schema: MACOS_IDENTITY_BODY_SCHEMA,
    repository: bounded.repository,
    run: clone(bounded.run),
    authority: {
      ref: bounded.authority.ref,
      commit: bounded.authority.commit,
      workflowPath: bounded.authority.workflowPath,
      workflowBlobSha256: bounded.authority.workflowBlobSha256,
      jwksRegistrySha256: bounded.authority.jwksRegistrySha256,
      toolchainSha256: bounded.authority.toolchainSha256,
    },
    phase: {
      phaseId: bounded.phase.phaseId,
      scopeBaseCommit: bounded.phase.scopeBaseCommit,
      commandPlanSha256: bounded.phase.commandPlanSha256,
      materializationReceiptHash: bounded.receiptHash,
    },
    candidate: {
      commit: bounded.candidate.commit,
      tree: bounded.candidate.tree,
    },
    runner: {
      jobName: "macos_unit",
      runsOn: "macos-14",
      platform: "darwin",
      ...clone(runner),
    },
    result: {
      executedCommandCount,
      executedCommandNamesSha256,
      executionReceiptsSha256,
      unitCoverageRawSha256: unitCoverage.sha256,
      unitCoverageRawByteLength: unitCoverage.byteLength,
      stdoutRawSha256: stdout.sha256,
      stdoutRawByteLength: stdout.byteLength,
      semanticStderrSha256,
      semanticStderrByteLength,
      outcome: "pass",
    },
    productionAuthority: false,
  };
  return validateMacosIdentityBody(body);
}

function validateMacosIdentityEvidence(evidence) {
  requireExactKeys(
    evidence,
    MACOS_IDENTITY_EVIDENCE_KEYS,
    "macOS identity evidence",
  );
  if (evidence.schema !== MACOS_IDENTITY_EVIDENCE_SCHEMA) {
    fail("INVALID_SCHEMA", "macOS identity evidence schema is not v1");
  }
  const body = validateMacosIdentityBody(evidence.identityBody);
  requireSha(evidence.identityBodySha256, "macOS identity body digest");
  if (evidence.identityBodySha256 !== sha256(stableJson(body))) {
    fail("MACOS_IDENTITY_BODY_MISMATCH", "macOS identity body digest diverges");
  }
  if (!isPlainObject(evidence.collectorReceipt)) {
    fail("MACOS_IDENTITY_INVALID", "macOS identity collector receipt is absent");
  }
  requireSha(
    evidence.collectorReceiptSha256,
    "macOS identity collector receipt digest",
  );
  if (
    evidence.collectorReceiptSha256 !==
      sha256(stableJson(evidence.collectorReceipt))
  ) {
    fail(
      "MACOS_IDENTITY_RECEIPT_MISMATCH",
      "macOS identity collector receipt digest diverges",
    );
  }
  if (
    !Array.isArray(evidence.semanticStderrBase64) ||
    evidence.semanticStderrBase64.length < REQUIRED_REPEAT_COUNT ||
    evidence.semanticStderrBase64.length > MAX_COMMANDS
  ) {
    fail("MACOS_IDENTITY_INVALID", "macOS semantic stderr population is invalid");
  }
  for (const [index, value] of evidence.semanticStderrBase64.entries()) {
    decodeCanonicalBase64(value, `macOS semantic stderr[${index}]`);
  }
  requireJsonBound(evidence, "macOS identity evidence", MAX_ARTIFACT_BYTES);
  return clone(evidence);
}

function workflowJobSection(workflowText, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflowText.indexOf(marker);
  if (
    start < 0 ||
    workflowText.indexOf(marker, start + marker.length) !== -1
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `authority workflow must contain exactly one ${jobName} job`,
    );
  }
  const remainder = workflowText.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_]+:\n/m);
  return workflowText.slice(
    start,
    nextJob < 0
      ? workflowText.length
      : start + marker.length + nextJob,
  );
}

function requireWorkflowLine(section, line, label) {
  const occurrences = section
    .split(/\r?\n/)
    .filter((candidate) => candidate === line).length;
  if (occurrences !== 1) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `${label} must contain exactly one immutable lineage expression`,
    );
  }
}

function requireWorkflowKeyCount(section, indentation, key, label) {
  const prefix = `${" ".repeat(indentation)}${key}:`;
  const occurrences = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix)).length;
  if (occurrences !== 1) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `${label} must contain exactly one ${key} key`,
    );
  }
}

function workflowStepSection(jobSection, name) {
  const marker = `      - name: ${name}\n`;
  const start = jobSection.indexOf(marker);
  if (
    start < 0 ||
    jobSection.indexOf(marker, start + marker.length) !== -1
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `authority workflow must contain exactly one ${name} step`,
    );
  }
  const remainder = jobSection.slice(start + marker.length);
  const nextStep = remainder.search(/^      - name: /m);
  return jobSection.slice(
    start,
    nextStep < 0
      ? jobSection.length
      : start + marker.length + nextStep,
  );
}

function workflowMappingSection(section, indentation, key, label) {
  const marker = `${" ".repeat(indentation)}${key}:\n`;
  const start = section.indexOf(marker);
  if (
    start < 0 ||
    section.indexOf(marker, start + marker.length) !== -1
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `${label} must contain exactly one ${key} mapping`,
    );
  }
  const remainder = section.slice(start + marker.length);
  const nextPeer = remainder.search(
    new RegExp(`^${" ".repeat(indentation)}[^ \\n]`, "m"),
  );
  return section.slice(
    start,
    nextPeer < 0
      ? section.length
      : start + marker.length + nextPeer,
  );
}

function requireExactWorkflowMapping(section, expectedLines, label) {
  const actual = section
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (stableJson(actual) !== stableJson(expectedLines)) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `${label} mapping differs from the frozen authority`,
    );
  }
}

function workflowStructuralText(section) {
  const structural = [];
  let blockIndent = null;
  for (const line of section.split(/\r?\n/)) {
    const indentation = line.match(/^ */)[0].length;
    if (blockIndent !== null) {
      if (line.trim().length === 0 || indentation > blockIndent) continue;
      blockIndent = null;
    }
    structural.push(line);
    if (/:\s*[|>][-+0-9]*\s*$/.test(line)) {
      blockIndent = indentation;
    }
  }
  return structural.join("\n");
}

function requireExactWorkflowStepNames(section, expected, label) {
  const stepLines = workflowStructuralText(section)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("      - "));
  const names = stepLines
    .filter((line) => line.startsWith("      - name: "))
    .map((line) => line.slice("      - name: ".length));
  if (
    stepLines.length !== names.length ||
    stableJson(names) !== stableJson(expected)
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      `${label} step sequence differs from the frozen authority`,
    );
  }
}

function validateAuthorityWorkflowForMacosLineage(workflowBytes) {
  if (
    !Buffer.isBuffer(workflowBytes) ||
    workflowBytes.length === 0 ||
    workflowBytes.length > MAX_ARTIFACT_BYTES
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      "archived authority workflow bytes are absent or outside bounds",
    );
  }
  const workflowText = workflowBytes.toString("utf8");
  if (
    workflowText.includes("\u0000") ||
    !Buffer.from(workflowText, "utf8").equals(workflowBytes)
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      "archived authority workflow is not canonical UTF-8 text",
    );
  }
  for (const key of ["name", "on", "jobs"]) {
    requireWorkflowKeyCount(workflowText, 0, key, "authority workflow");
  }
  const macos = workflowJobSection(workflowText, "macos_unit");
  const primary = workflowJobSection(workflowText, "judge_primary");
  const independent = workflowJobSection(workflowText, "judge_independent");
  const reduce = workflowJobSection(workflowText, "reduce");
  const collect = workflowJobSection(workflowText, "collect");
  for (const [section, label] of [
    [macos, "macos_unit"],
    [collect, "collect"],
  ]) {
    for (const key of [
      "needs",
      "runs-on",
      "timeout-minutes",
      "permissions",
      "outputs",
      "steps",
    ]) {
      requireWorkflowKeyCount(section, 4, key, label);
    }
    requireWorkflowKeyCount(section, 6, "id-token", `${label} permissions`);
    if (/(?:^|[\s:[{,-])[&*][A-Za-z0-9_-]+(?:$|[\s}\],])/m.test(
      workflowStructuralText(section),
    )) {
      fail(
        "MACOS_LINEAGE_WORKFLOW_INVALID",
        `${label} cannot satisfy authority through YAML anchors`,
      );
    }
  }
  requireExactWorkflowMapping(
    workflowMappingSection(macos, 4, "permissions", "macos_unit"),
    [
      "    permissions:",
      "      actions: read",
      "      contents: read",
      "      id-token: write",
    ],
    "macos_unit permissions",
  );
  requireExactWorkflowMapping(
    workflowMappingSection(collect, 4, "permissions", "collect"),
    [
      "    permissions:",
      "      actions: read",
      "      id-token: write",
    ],
    "collector permissions",
  );
  requireExactWorkflowStepNames(
    macos,
    [
      "Download only the exact materialization artifact ID",
      "Acquire the private digest-bound macOS dependency bundle",
      "Execute every macOS unit command in a fresh sealed checkout",
      "Seal independently authenticated macOS identity and receipt",
      "Upload separately certified macOS unit receipt",
    ],
    "macos_unit",
  );
  requireExactWorkflowStepNames(
    collect,
    [
      "Download exact upstream artifact IDs",
      "Fresh collector verifies raw CAS, requests one OIDC token, and seals the offline package",
      "Upload bounded complete offline certification package",
    ],
    "collector",
  );
  const exactMaterializationDownload =
    "          artifact-ids: ${{ needs.materialize.outputs.artifact_id }}";
  const exactJudgeDownload =
    "          artifact-ids: ${{ needs.materialize.outputs.artifact_id }},${{ needs.macos_unit.outputs.artifact_id }}";
  const exactReduceDownload =
    "          artifact-ids: ${{ needs.materialize.outputs.artifact_id }},${{ needs.macos_unit.outputs.artifact_id }},${{ needs.judge_primary.outputs.artifact_id }},${{ needs.judge_independent.outputs.artifact_id }}";
  const exactCollectDownload =
    "          artifact-ids: ${{ needs.materialize.outputs.artifact_id }},${{ needs.macos_unit.outputs.artifact_id }},${{ needs.judge_primary.outputs.artifact_id }},${{ needs.judge_independent.outputs.artifact_id }},${{ needs.reduce.outputs.artifact_id }}";
  requireWorkflowLine(macos, "    runs-on: macos-14", "macos_unit runner");
  requireWorkflowLine(macos, "    needs: [materialize]", "macos_unit");
  requireWorkflowLine(macos, exactMaterializationDownload, "macos_unit");
  for (const [section, label] of [
    [primary, "judge_primary"],
    [independent, "judge_independent"],
  ]) {
    requireWorkflowLine(
      section,
      "    needs: [materialize, macos_unit]",
      label,
    );
    requireWorkflowLine(section, exactJudgeDownload, label);
    requireWorkflowKeyCount(section, 4, "needs", label);
    requireWorkflowKeyCount(section, 10, "artifact-ids", label);
  }
  requireWorkflowLine(
    reduce,
    "    needs: [materialize, macos_unit, judge_primary, judge_independent]",
    "reduce",
  );
  requireWorkflowLine(reduce, exactReduceDownload, "reduce");
  requireWorkflowKeyCount(reduce, 4, "needs", "reduce");
  requireWorkflowKeyCount(reduce, 10, "artifact-ids", "reduce");
  requireWorkflowLine(
    collect,
    "    needs: [materialize, macos_unit, judge_primary, judge_independent, reduce]",
    "collect",
  );
  requireWorkflowLine(collect, exactCollectDownload, "collect");
  for (const [section, label] of [
    [macos, "macos_unit"],
    [collect, "collect"],
  ]) {
    requireWorkflowKeyCount(section, 10, "artifact-ids", label);
  }
  const reduceReceiptStep = workflowStepSection(
    reduce,
    "Recompute every raw CAS byte and reconcile three judges",
  );
  const collectReceiptStep = workflowStepSection(
    collect,
    "Fresh collector verifies raw CAS, requests one OIDC token, and seals the offline package",
  );
  const stepHeader = (section, label) => {
    const runStart = section.search(/^        run:/m);
    if (runStart < 0) {
      fail(
        "MACOS_LINEAGE_WORKFLOW_INVALID",
        `${label} must contain one explicit run body`,
      );
    }
    const header = section.slice(0, runStart);
    requireWorkflowKeyCount(section, 8, "env", `${label} step`);
    requireWorkflowKeyCount(section, 8, "run", `${label} step`);
    return header;
  };
  const reduceReceiptHeader = stepHeader(
    reduceReceiptStep,
    "reduce receipt",
  );
  const collectReceiptHeader = stepHeader(
    collectReceiptStep,
    "collector receipt",
  );
  const lineageBindings = [
    "          PIKIIO_MATERIALIZATION_ARTIFACT_ID: ${{ needs.materialize.outputs.artifact_id }}",
    "          PIKIIO_MATERIALIZATION_ARTIFACT_DIGEST: ${{ needs.materialize.outputs.artifact_digest }}",
    "          PIKIIO_MACOS_ARTIFACT_ID: ${{ needs.macos_unit.outputs.artifact_id }}",
    "          PIKIIO_MACOS_ARTIFACT_DIGEST: ${{ needs.macos_unit.outputs.artifact_digest }}",
    "          PIKIIO_MACOS_HASH: ${{ needs.macos_unit.outputs.receipt_hash }}",
  ];
  for (const section of [reduceReceiptHeader, collectReceiptHeader]) {
    for (const binding of lineageBindings) {
      requireWorkflowLine(section, binding, "final macOS lineage consumer");
      requireWorkflowKeyCount(
        section,
        10,
        binding.trimStart().split(":")[0],
        "final macOS lineage consumer",
      );
    }
  }
  for (const section of [reduce, collect]) {
    if (
      /continue-on-error\s*:|if\s*:\s*.*(?:always|failure|cancelled)\s*\(/i.test(
        section,
      )
    ) {
      fail(
        "MACOS_LINEAGE_WORKFLOW_INVALID",
        "final lineage jobs cannot bypass successful needs",
      );
    }
  }
  for (const binding of [
    "      receipt_hash: ${{ steps.judge.outputs.receipt_hash }}",
    "      artifact_id: ${{ steps.upload.outputs.artifact-id }}",
    "      artifact_digest: sha256:${{ steps.upload.outputs.artifact-digest }}",
  ]) {
    requireWorkflowLine(macos, binding, "macos_unit output");
    requireWorkflowKeyCount(
      macos,
      6,
      binding.trimStart().split(":")[0],
      "macos_unit output",
    );
  }
  requireWorkflowLine(
    macos,
    "      id-token: write",
    "macos_unit OIDC permission",
  );
  requireWorkflowLine(
    collect,
    "      id-token: write",
    "collector OIDC permission",
  );
  const macIdentityStep =
    "Seal independently authenticated macOS identity and receipt";
  const executeStep =
    "Execute every macOS unit command in a fresh sealed checkout";
  const candidateSection = workflowStepSection(macos, executeStep);
  const identitySection = workflowStepSection(macos, macIdentityStep);
  const candidateHeader = stepHeader(
    candidateSection,
    "macos_unit candidate execution",
  );
  const identityHeader = stepHeader(
    identitySection,
    "macos_unit identity collection",
  );
  requireWorkflowLine(
    candidateHeader,
    "          PIKIIO_HOST_CREDENTIAL_CANARY: must-not-enter-candidate",
    "macos_unit credential canary",
  );
  for (const line of [
    "          PIKIIO_OIDC_REQUEST_URL: ${{ env.ACTIONS_ID_TOKEN_REQUEST_URL }}",
    "          PIKIIO_OIDC_REQUEST_TOKEN: ${{ env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }}",
  ]) {
    requireWorkflowLine(identityHeader, line, "macos_unit identity credential");
    requireWorkflowLine(
      collectReceiptHeader,
      line,
      "collector identity credential",
    );
    const key = line.trimStart().split(":")[0];
    requireWorkflowKeyCount(
      identityHeader,
      10,
      key,
      "macos_unit identity credential",
    );
    requireWorkflowKeyCount(
      collectReceiptHeader,
      10,
      key,
      "collector identity credential",
    );
  }
  if (
    !candidateSection.includes("/usr/bin/sandbox-exec -f \"$profile\" /usr/bin/env -i") ||
    /(?:ACTIONS_ID_TOKEN|PIKIIO_OIDC_REQUEST)/.test(candidateSection) ||
    /(?:sandbox-exec|PIKIIO_COMMAND_B64)/.test(identitySection) ||
    workflowText.split("id-token: write").length - 1 !== 2 ||
    workflowText.split("ACTIONS_ID_TOKEN_REQUEST_URL").length - 1 !== 2 ||
    workflowText.split("ACTIONS_ID_TOKEN_REQUEST_TOKEN").length - 1 !== 2
  ) {
    fail(
      "MACOS_LINEAGE_WORKFLOW_INVALID",
      "only the isolated macOS identity step and final collector may mint OIDC",
    );
  }
  return Object.freeze({
    workflowBlobSha256: sha256(workflowBytes),
    macosUnitNeeds: Object.freeze(["materialize"]),
    judgeNeeds: Object.freeze(["materialize", "macos_unit"]),
    reducerNeeds: Object.freeze([
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
    ]),
    collectorNeeds: Object.freeze([
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
      "reduce",
    ]),
  });
}

function validateArtifactLineageDescriptor(descriptor, label) {
  requireExactKeys(descriptor, MACOS_LINEAGE_ARTIFACT_KEYS, label);
  requirePattern(
    descriptor.artifactId,
    RUN_ID_PATTERN,
    `${label}.artifactId`,
    "INVALID_ARTIFACT_ID",
  );
  requirePattern(
    descriptor.artifactDigest,
    /^sha256:[a-f0-9]{64}$/,
    `${label}.artifactDigest`,
    "INVALID_ARTIFACT_DIGEST",
  );
  requireSha(descriptor.receiptHash, `${label}.receiptHash`);
}

function validateMacosLineage(lineage) {
  requireExactKeys(lineage, MACOS_LINEAGE_KEYS, "macOS lineage");
  if (lineage.schema !== MACOS_LINEAGE_SCHEMA) {
    fail("INVALID_SCHEMA", "macOS lineage schema is not v3");
  }
  if (lineage.repository !== EXPECTED_REPOSITORY) {
    fail("INVALID_REPOSITORY", "macOS lineage repository is not Pikiio");
  }
  validateRun(lineage.run);
  requireExactKeys(
    lineage.authority,
    MACOS_LINEAGE_AUTHORITY_KEYS,
    "macOS lineage authority",
  );
  requireCommit(lineage.authority.commit, "macOS lineage authority.commit");
  if (lineage.authority.workflowPath !== AUTHORITY_WORKFLOW_PATH) {
    fail(
      "INVALID_WORKFLOW_PATH",
      "macOS lineage does not name the frozen collector workflow",
    );
  }
  requireSha(
    lineage.authority.workflowBlobSha256,
    "macOS lineage authority.workflowBlobSha256",
  );
  validateArtifactLineageDescriptor(
    lineage.materializationArtifact,
    "macOS lineage materializationArtifact",
  );
  validateArtifactLineageDescriptor(
    lineage.macosArtifact,
    "macOS lineage macosArtifact",
  );
  const expectedNeeds = {
    macosUnitNeeds: ["materialize"],
    judgeNeeds: ["materialize", "macos_unit"],
    reducerNeeds: [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
    ],
    collectorNeeds: [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
      "reduce",
    ],
  };
  for (const [key, expected] of Object.entries(expectedNeeds)) {
    if (stableJson(lineage[key]) !== stableJson(expected)) {
      fail(
        "MACOS_LINEAGE_INVALID",
        `macOS lineage ${key} is not the frozen successful-needs chain`,
      );
    }
  }
  validateCasReference(
    lineage.authorityWorkflow,
    "macOS lineage authorityWorkflow",
  );
  requireFalse(
    lineage.productionAuthority,
    "macOS lineage.productionAuthority",
  );
  requireSha(lineage.receiptHash, "macOS lineage.receiptHash");
  if (lineage.receiptHash !== hashWithoutField(lineage, "receiptHash")) {
    fail("HASH_MISMATCH", "macOS lineage receipt hash does not match");
  }
  if (
    lineage.materializationArtifact.artifactId ===
      lineage.macosArtifact.artifactId ||
    lineage.materializationArtifact.artifactDigest ===
      lineage.macosArtifact.artifactDigest
  ) {
    fail(
      "MACOS_LINEAGE_INVALID",
      "materialization and macOS artifacts must have distinct immutable identities",
    );
  }
  requireJsonBound(lineage, "macOS lineage");
  return clone(lineage);
}

function assertMacosLineageBindings({
  lineage,
  materialization,
  macosJudge,
  authorityWorkflowBytes,
}) {
  const bounded = validateMacosLineage(lineage);
  const workflow = validateAuthorityWorkflowForMacosLineage(
    authorityWorkflowBytes,
  );
  if (
    bounded.repository !== materialization.repository ||
    stableJson(bounded.run) !== stableJson(materialization.run) ||
    bounded.authority.commit !== materialization.authority.commit ||
    bounded.authority.workflowPath !== materialization.authority.workflowPath ||
    bounded.authority.workflowBlobSha256 !==
      materialization.authority.workflowBlobSha256 ||
    bounded.authority.workflowBlobSha256 !== workflow.workflowBlobSha256 ||
    bounded.authorityWorkflow.sha256 !== workflow.workflowBlobSha256 ||
    bounded.authorityWorkflow.address !==
      `sha256:${workflow.workflowBlobSha256}` ||
    bounded.authorityWorkflow.byteLength !== authorityWorkflowBytes.length ||
    bounded.materializationArtifact.receiptHash !== materialization.receiptHash ||
    bounded.macosArtifact.receiptHash !== macosJudge.receiptHash ||
    stableJson(bounded.macosUnitNeeds) !== stableJson(workflow.macosUnitNeeds) ||
    stableJson(bounded.judgeNeeds) !== stableJson(workflow.judgeNeeds) ||
    stableJson(bounded.reducerNeeds) !== stableJson(workflow.reducerNeeds) ||
    stableJson(bounded.collectorNeeds) !== stableJson(workflow.collectorNeeds)
  ) {
    fail(
      "MACOS_LINEAGE_BINDING_MISMATCH",
      "macOS artifact lineage is not bound to archived A workflow and receipts",
    );
  }
  return bounded;
}

function buildMacosLineage({
  materialization,
  macosJudge,
  materializationArtifact,
  macosArtifact,
  authorityWorkflowBytes,
}) {
  const materialized = validateMaterializationReceipt(materialization);
  const macos = validatePlatformReceipt(macosJudge);
  const workflow = validateAuthorityWorkflowForMacosLineage(
    authorityWorkflowBytes,
  );
  const lineage = {
    schema: MACOS_LINEAGE_SCHEMA,
    repository: materialized.repository,
    run: clone(materialized.run),
    authority: {
      commit: materialized.authority.commit,
      workflowPath: materialized.authority.workflowPath,
      workflowBlobSha256: materialized.authority.workflowBlobSha256,
    },
    materializationArtifact: clone(materializationArtifact),
    macosArtifact: clone(macosArtifact),
    macosUnitNeeds: [...workflow.macosUnitNeeds],
    judgeNeeds: [...workflow.judgeNeeds],
    reducerNeeds: [...workflow.reducerNeeds],
    collectorNeeds: [...workflow.collectorNeeds],
    authorityWorkflow: {
      address: `sha256:${workflow.workflowBlobSha256}`,
      sha256: workflow.workflowBlobSha256,
      byteLength: authorityWorkflowBytes.length,
    },
    productionAuthority: false,
    receiptHash: "0".repeat(64),
  };
  lineage.receiptHash = hashWithoutField(lineage, "receiptHash");
  return assertMacosLineageBindings({
    lineage,
    materialization: materialized,
    macosJudge: macos,
    authorityWorkflowBytes,
  });
}

function evidenceReferences(
  primary,
  independent,
  macosJudge = null,
  macosLineage = null,
) {
  const sources = [primary, independent];
  if (macosJudge) sources.push(macosJudge);
  const references = sources
    .flatMap((judge) =>
      Object.keys(judge.evidence).map((key) => clone(judge.evidence[key])),
    );
  if (macosLineage) {
    references.push(clone(validateMacosLineage(macosLineage).authorityWorkflow));
  }
  references.sort((left, right) => left.address.localeCompare(right.address));
  const unique = new Map();
  for (const reference of references) {
    const prior = unique.get(reference.address);
    if (prior && stableJson(prior) !== stableJson(reference)) {
      fail("CAS_REFERENCE_COLLISION", "one CAS address has conflicting metadata");
    }
    unique.set(reference.address, reference);
  }
  return [...unique.values()];
}

function evidenceManifestSha256(manifest) {
  if (!Array.isArray(manifest)) {
    fail("INVALID_EVIDENCE_MANIFEST", "evidence manifest must be an array");
  }
  return sha256(stableJson(manifest));
}

function validateQualityVerdict(verdict) {
  requireExactKeys(verdict, VERDICT_KEYS, "verdict");
  if (verdict.schema !== VERDICT_SCHEMA) {
    fail("INVALID_SCHEMA", "verdict schema is not v3");
  }
  requireSha(
    verdict.materializationReceiptHash,
    "verdict.materializationReceiptHash",
  );
  requireExactKeys(
    verdict.judgeReceiptHashes,
    JUDGE_HASH_KEYS,
    "verdict.judgeReceiptHashes",
  );
  requireSha(verdict.judgeReceiptHashes.primary, "verdict primary judge hash");
  requireSha(
    verdict.judgeReceiptHashes.independent,
    "verdict independent judge hash",
  );
  requireSha(verdict.macosReceiptHash, "verdict.macosReceiptHash");
  validatePopulationFloors(
    verdict.populationFloors,
    "verdict.populationFloors",
  );
  requireSha(verdict.evidenceManifestSha256, "verdict.evidenceManifestSha256");
  validateMetrics(verdict.metrics, verdict.populationFloors);
  if (verdict.passed !== true) {
    fail("VERDICT_FAILED", "quality verdict is not pass");
  }
  requireFalse(verdict.productionAuthority, "verdict.productionAuthority");
  requireSha(verdict.receiptHash, "verdict.receiptHash");
  if (verdict.receiptHash !== hashWithoutField(verdict, "receiptHash")) {
    fail("HASH_MISMATCH", "verdict receipt hash does not match");
  }
  requireJsonBound(verdict, "verdict");
  return clone(verdict);
}

function sealQualityVerdict(fields) {
  const verdict = {
    ...clone(fields),
    schema: VERDICT_SCHEMA,
    productionAuthority: false,
    receiptHash: "0".repeat(64),
  };
  verdict.receiptHash = hashWithoutField(verdict, "receiptHash");
  return validateQualityVerdict(verdict);
}

function assertReceiptBindings(
  materialization,
  macosLineage,
  macosJudge,
  primary,
  independent,
  verdict,
) {
  const lineage = validateMacosLineage(macosLineage);
  const macos = validatePlatformReceipt(macosJudge);
  const linuxCommandCount = commandCount(
    materialization.phase.commandPlan,
    "linux",
  );
  const macosCommandCount = commandCount(
    materialization.phase.commandPlan,
    "macos",
  );
  const linuxNamesSha256 = commandNamesSha256(
    materialization.phase.commandPlan,
    "linux",
  );
  const macosNamesSha256 = commandNamesSha256(
    materialization.phase.commandPlan,
    "macos",
  );
  for (const judge of [primary, independent]) {
    const bindings = [
      [judge.materializationReceiptHash, materialization.receiptHash],
      [judge.authorityCommit, materialization.authority.commit],
      [judge.phaseId, materialization.phase.phaseId],
      [judge.phaseScopeBaseCommit, materialization.phase.scopeBaseCommit],
      [judge.candidateCommit, materialization.candidate.commit],
      [judge.candidateTree, materialization.candidate.tree],
      [
        judge.phaseProofRegistrySha256,
        materialization.authority.phaseProofRegistrySha256,
      ],
      [judge.qualityPlanSha256, materialization.phase.qualityPlanSha256],
      [judge.commandPlanSha256, materialization.phase.commandPlanSha256],
      [judge.sourceManifestSha256, materialization.sourceManifestSha256],
      [
        stableJson(judge.populationFloors),
        stableJson(materialization.phase.populationFloors),
      ],
      [judge.executedCommandCount, linuxCommandCount],
      [judge.executedCommandNamesSha256, linuxNamesSha256],
      [judge.macosReceiptHash, macos.receiptHash],
      [judge.sandbox.toolchainSha256, materialization.authority.toolchainSha256],
      [judge.sandbox.imageDigest, materialization.authority.judgeImageDigest],
    ];
    if (bindings.some(([actual, expected]) => actual !== expected)) {
      fail("RECEIPT_BINDING_MISMATCH", `${judge.role} judge is not bound to A/S/C`);
    }
  }
  const macosBindings = [
    [macos.materializationReceiptHash, materialization.receiptHash],
    [macos.authorityCommit, materialization.authority.commit],
    [macos.phaseId, materialization.phase.phaseId],
    [macos.phaseScopeBaseCommit, materialization.phase.scopeBaseCommit],
    [macos.candidateCommit, materialization.candidate.commit],
    [macos.candidateTree, materialization.candidate.tree],
    [
      stableJson(macos.populationFloors),
      stableJson(materialization.phase.populationFloors),
    ],
    [macos.commandPlanSha256, materialization.phase.commandPlanSha256],
    [macos.toolchainSha256, materialization.authority.toolchainSha256],
    [macos.executedCommandCount, macosCommandCount],
    [macos.executedCommandNamesSha256, macosNamesSha256],
  ];
  if (macosBindings.some(([actual, expected]) => actual !== expected)) {
    fail(
      "RECEIPT_BINDING_MISMATCH",
      "macOS unit authority is not bound to A/S/C and the command plan",
    );
  }
  if (
    lineage.repository !== materialization.repository ||
    stableJson(lineage.run) !== stableJson(materialization.run) ||
    lineage.authority.commit !== materialization.authority.commit ||
    lineage.authority.workflowPath !== materialization.authority.workflowPath ||
    lineage.authority.workflowBlobSha256 !==
      materialization.authority.workflowBlobSha256 ||
    lineage.authorityWorkflow.sha256 !==
      materialization.authority.workflowBlobSha256 ||
    lineage.materializationArtifact.receiptHash !==
      materialization.receiptHash ||
    lineage.macosArtifact.receiptHash !== macos.receiptHash
  ) {
    fail(
      "MACOS_LINEAGE_BINDING_MISMATCH",
      "macOS lineage does not bind the materialization and platform receipt",
    );
  }
  if (
    stableJson(primary.metrics) !== stableJson(independent.metrics) ||
    stableJson(verdict.metrics) !== stableJson(primary.metrics) ||
    stableJson(verdict.populationFloors) !==
      stableJson(materialization.phase.populationFloors) ||
    stableJson(primary.metrics.unit) !== stableJson(macos.metrics.unit) ||
    stableJson(primary.metrics.coverage) !== stableJson(macos.metrics.coverage) ||
    verdict.macosReceiptHash !== macos.receiptHash ||
    primary.sandbox.imageDigest !== independent.sandbox.imageDigest
  ) {
    fail("JUDGE_DIVERGENCE", "judge metrics do not reconcile exactly");
  }
  const expectedManifest = evidenceReferences(
    primary,
    independent,
    macos,
    lineage,
  );
  if (
    verdict.materializationReceiptHash !== materialization.receiptHash ||
    verdict.judgeReceiptHashes.primary !== primary.receiptHash ||
    verdict.judgeReceiptHashes.independent !== independent.receiptHash ||
    verdict.evidenceManifestSha256 !==
      evidenceManifestSha256(expectedManifest)
  ) {
    fail("VERDICT_BINDING_MISMATCH", "verdict does not bind all proof receipts");
  }
  return expectedManifest;
}

function buildExternalCiAttestationBody({
  materialization,
  macosLineage,
  macosJudge,
  primaryJudge,
  independentJudge,
  verdict,
}) {
  const materialized = validateMaterializationReceipt(materialization);
  const lineage = validateMacosLineage(macosLineage);
  const macos = validatePlatformReceipt(macosJudge);
  const primary = validateJudgeReceipt(primaryJudge, "primary");
  const independent = validateJudgeReceipt(independentJudge, "independent");
  const quality = validateQualityVerdict(verdict);
  assertReceiptBindings(
    materialized,
    lineage,
    macos,
    primary,
    independent,
    quality,
  );
  const body = {
    schema: ATTESTATION_BODY_SCHEMA,
    repository: materialized.repository,
    run: clone(materialized.run),
    authority: Object.fromEntries(
      BODY_AUTHORITY_KEYS.map((key) => [key, materialized.authority[key]]),
    ),
    phase: clone(materialized.phase),
    candidate: clone(materialized.candidate),
    macosLineage: clone(lineage),
    evidence: {
      materializationReceiptHash: materialized.receiptHash,
      primaryJudgeReceiptHash: primary.receiptHash,
      independentJudgeReceiptHash: independent.receiptHash,
      macosReceiptHash: macos.receiptHash,
      qualityVerdictHash: quality.receiptHash,
      evidenceManifestSha256: quality.evidenceManifestSha256,
      primaryUnitCoverageRawSha256: primary.evidence.unitCoverage.sha256,
      primaryGherkinRawSha256: primary.evidence.gherkin.sha256,
      primaryMutationRawSha256: primary.evidence.mutation.sha256,
      primaryLayersRawSha256: primary.evidence.layers.sha256,
      independentUnitCoverageRawSha256:
        independent.evidence.unitCoverage.sha256,
      independentGherkinRawSha256: independent.evidence.gherkin.sha256,
      independentMutationRawSha256: independent.evidence.mutation.sha256,
      independentLayersRawSha256: independent.evidence.layers.sha256,
      macosUnitCoverageRawSha256: macos.evidence.unitCoverage.sha256,
      macosLineageReceiptHash: lineage.receiptHash,
      authorityWorkflowRawSha256: lineage.authorityWorkflow.sha256,
    },
    productionAuthority: false,
  };
  return validateExternalCiAttestationBody(body);
}

function validateExternalCiAttestationBody(body) {
  requireExactKeys(body, BODY_KEYS, "attestation body");
  if (body.schema !== ATTESTATION_BODY_SCHEMA) {
    fail("INVALID_SCHEMA", "attestation body schema is not v3");
  }
  if (body.repository !== EXPECTED_REPOSITORY) {
    fail("INVALID_REPOSITORY", "attestation body repository is not Pikiio");
  }
  validateRun(body.run);
  validateAuthority(body.authority, { body: true });
  validatePhase(body.phase);
  validateCandidate(body.candidate);
  validateMacosLineage(body.macosLineage);
  requireExactKeys(body.evidence, BODY_EVIDENCE_KEYS, "attestation body evidence");
  for (const key of BODY_EVIDENCE_KEYS) {
    requireSha(body.evidence[key], `attestation body evidence.${key}`);
  }
  requireFalse(body.productionAuthority, "attestationBody.productionAuthority");
  if (body.candidate.parent !== body.phase.scopeBaseCommit) {
    fail("COMMIT_BINDING_MISMATCH", "attestation body does not bind S as C parent");
  }
  if (
    body.macosLineage.repository !== body.repository ||
    stableJson(body.macosLineage.run) !== stableJson(body.run) ||
    body.macosLineage.authority.commit !== body.authority.commit ||
    body.macosLineage.authority.workflowPath !== body.authority.workflowPath ||
    body.macosLineage.authority.workflowBlobSha256 !==
      body.authority.workflowBlobSha256 ||
    body.evidence.macosLineageReceiptHash !==
      body.macosLineage.receiptHash ||
    body.evidence.authorityWorkflowRawSha256 !==
      body.macosLineage.authorityWorkflow.sha256
  ) {
    fail(
      "MACOS_LINEAGE_BINDING_MISMATCH",
      "attestation body does not bind exact macOS artifact lineage",
    );
  }
  requireJsonBound(body, "attestation body");
  return clone(body);
}

function validateReplay(replay) {
  requireExactKeys(replay, REPLAY_KEYS, "replay");
  if (replay.issuer !== EXPECTED_OIDC_ISSUER) {
    fail("INVALID_OIDC_ISSUER", "replay issuer is not GitHub Actions OIDC");
  }
  requirePattern(replay.jti, UUID_PATTERN, "replay.jti", "INVALID_JTI");
  requireSha(replay.replayKeySha256, "replay.replayKeySha256");
  if (replay.multiHostSafe !== false) {
    fail("REPLAY_SCOPE_UNSUPPORTED", "v3 replay persistence is not multi-host safe");
  }
}

function validateEvidenceManifest(manifest) {
  if (
    !Array.isArray(manifest) ||
    manifest.length === 0 ||
    manifest.length > MAX_ARTIFACTS
  ) {
    fail("INVALID_EVIDENCE_MANIFEST", "evidence manifest has invalid cardinality");
  }
  let prior = "";
  const addresses = new Set();
  for (const [index, reference] of manifest.entries()) {
    validateCasReference(reference, `evidenceManifest[${index}]`);
    if (reference.address <= prior || addresses.has(reference.address)) {
      fail("NON_CANONICAL_MANIFEST", "evidence manifest must be sorted and unique");
    }
    prior = reference.address;
    addresses.add(reference.address);
  }
}

function validateExternalCiCertification(certification) {
  requireExactKeys(certification, CERTIFICATION_KEYS, "certification");
  if (certification.schema !== CERTIFICATION_SCHEMA) {
    fail("INVALID_SCHEMA", "certification schema is not v3");
  }
  validateExternalCiAttestationBody(certification.attestationBody);
  requireSha(
    certification.attestationBodySha256,
    "certification.attestationBodySha256",
  );
  if (
    certification.attestationBodySha256 !==
    sha256(stableJson(certification.attestationBody))
  ) {
    fail("HASH_MISMATCH", "attestation body digest does not match");
  }
  if (!isPlainObject(certification.collectorReceipt)) {
    fail("INVALID_COLLECTOR_RECEIPT", "collector receipt must be an object");
  }
  requireJsonBound(certification.collectorReceipt, "collector receipt", 128 * 1024);
  requireSha(
    certification.collectorReceiptSha256,
    "certification.collectorReceiptSha256",
  );
  if (
    certification.collectorReceiptSha256 !==
    sha256(stableJson(certification.collectorReceipt))
  ) {
    fail("HASH_MISMATCH", "collector receipt digest does not match");
  }
  validateEvidenceManifest(certification.evidenceManifest);
  validateReplay(certification.replay);
  requireString(certification.verifiedAt, "certification.verifiedAt", 64);
  if (!Number.isFinite(Date.parse(certification.verifiedAt))) {
    fail("INVALID_TIMESTAMP", "certification.verifiedAt is invalid");
  }
  requireFalse(
    certification.productionAuthority,
    "certification.productionAuthority",
  );
  requireSha(certification.certificationHash, "certification.certificationHash");
  if (
    certification.certificationHash !==
    hashWithoutField(certification, "certificationHash")
  ) {
    fail("HASH_MISMATCH", "certification hash does not match");
  }
  requireJsonBound(certification, "certification");
  return clone(certification);
}

function sealExternalCiCertification(fields) {
  const certification = {
    ...clone(fields),
    schema: CERTIFICATION_SCHEMA,
    attestationBodySha256: sha256(stableJson(fields.attestationBody)),
    collectorReceiptSha256: sha256(stableJson(fields.collectorReceipt)),
    productionAuthority: false,
    certificationHash: "0".repeat(64),
  };
  certification.certificationHash = hashWithoutField(
    certification,
    "certificationHash",
  );
  return validateExternalCiCertification(certification);
}

function artifactBytes(artifacts, address) {
  let value;
  if (artifacts instanceof Map) {
    value = artifacts.get(address);
  } else if (isPlainObject(artifacts)) {
    value = artifacts[address];
  } else {
    fail("INVALID_ARTIFACT_STORE", "artifacts must be a Map or exact-key object");
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  fail("MISSING_ARTIFACT", `raw CAS artifact ${address} is missing`);
}

function parseJsonArtifact(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) {
    fail("RAW_EVIDENCE_INVALID", `${label} is not a bounded raw artifact`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("RAW_EVIDENCE_INVALID", `${label} is not JSON`);
  }
  return value;
}

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((MAX_ARTIFACT_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    fail("RAW_EVIDENCE_INVALID", `${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_ARTIFACT_BYTES || bytes.toString("base64") !== value) {
    fail("RAW_EVIDENCE_INVALID", `${label} is not canonical base64`);
  }
  return bytes;
}

function parseTapEvidence(value) {
  const text = String(value || "");
  const number = (name) => {
    const match = text.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const coverage = text.match(
    /^# all\s+\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m,
  );
  const coverageFiles = {};
  const coveragePath = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("# ") || !line.includes("|")) continue;
    const columns = line
      .slice(2)
      .split("|")
      .map((column) => column.replace(/\s+$/g, ""));
    if (columns.length < 4) continue;
    const rawName = columns[0];
    const name = rawName.trim();
    if (!name || name === "file" || name === "all") continue;
    const indent = rawName.length - rawName.trimStart().length;
    const values = columns.slice(1, 4).map((column) =>
      /^\s*[\d.]+\s*$/.test(column) ? Number(column.trim()) : null,
    );
    if (values.every((metric) => metric === null)) {
      coveragePath[indent] = name;
      coveragePath.length = indent + 1;
      continue;
    }
    if (values.some((metric) => !Number.isFinite(metric))) continue;
    const relativePath = [...coveragePath.slice(0, indent), name].join("/");
    coverageFiles[relativePath] = {
      lines: values[0],
      branches: values[1],
      functions: values[2],
    };
  }
  return {
    tests: number("tests"),
    passed: number("pass"),
    failed: number("fail"),
    cancelled: number("cancelled"),
    skipped: number("skipped"),
    todo: number("todo"),
    coverage: coverage
      ? {
          lines: Number(coverage[1]),
          branches: Number(coverage[2]),
          functions: Number(coverage[3]),
        }
      : null,
    coverageFiles,
  };
}

function parseLastJsonEvidence(value, label) {
  const text = String(value || "").trim();
  const starts = [];
  if (text.startsWith("{")) starts.push(0);
  for (
    let index = text.indexOf("\n{");
    index !== -1;
    index = text.indexOf("\n{", index + 2)
  ) {
    starts.push(index + 1);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(text.slice(starts[index]));
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Continue to the preceding line-aligned object.
    }
  }
  fail("RAW_EVIDENCE_INVALID", `${label} lacks a final JSON object`);
}

function validateChildExecution(receipt, command, label) {
  requireExactKeys(receipt, CHILD_EXECUTION_KEYS, label);
  if (
    receipt.protocol !== "pikiio-external-ci-child-v3" ||
    receipt.commandName !== command.name ||
    receipt.commandSha256 !== sha256(stableJson(command)) ||
    receipt.definitionSha256 !== command.definitionSha256 ||
    receipt.platform !== command.platform ||
    receipt.repeat !== command.repeat ||
    receipt.status !== 0 ||
    receipt.signal !== null ||
    receipt.errorCode !== null ||
    receipt.timedOut !== false
  ) {
    fail("EXECUTION_RECEIPT_MISMATCH", `${label} does not bind a passing command`);
  }
  requireInteger(receipt.elapsedMs, `${label}.elapsedMs`, {
    minimum: 0,
    maximum: 20 * 60 * 1000,
  });
  const streams = {};
  for (const stream of ["stdout", "stderr"]) {
    requireSha(receipt[`${stream}Sha256`], `${label}.${stream}Sha256`);
    requireInteger(receipt[`${stream}ByteLength`], `${label}.${stream}ByteLength`, {
      minimum: 0,
      maximum: MAX_ARTIFACT_BYTES,
    });
    const bytes = decodeCanonicalBase64(
      receipt[`${stream}Base64`],
      `${label}.${stream}Base64`,
    );
    if (
      bytes.length !== receipt[`${stream}ByteLength`] ||
      sha256(bytes) !== receipt[`${stream}Sha256`]
    ) {
      fail("RAW_EVIDENCE_MISMATCH", `${label} ${stream} bytes do not match`);
    }
    streams[stream] = bytes;
  }
  return streams;
}

function validateExecutionArtifact(bytes, commands, label) {
  const receipts = parseJsonArtifact(bytes, label);
  if (!Array.isArray(receipts) || receipts.length !== commands.length) {
    fail("EXECUTION_COUNT_MISMATCH", `${label} does not contain every command`);
  }
  const streams = receipts.map((receipt, index) =>
    validateChildExecution(receipt, commands[index], `${label}[${index}]`),
  );
  return { receipts, streams };
}

function validateStreamIndexArtifact(bytes, receipts, stream, label) {
  const values = parseJsonArtifact(bytes, label);
  if (
    !Array.isArray(values) ||
    stableJson(values) !==
      stableJson(receipts.map((receipt) => receipt[`${stream}Base64`]))
  ) {
    fail("RAW_EVIDENCE_MISMATCH", `${label} diverges from execution receipts`);
  }
}

function requireMetricInteger(value, label) {
  requireInteger(value, label, { minimum: 0 });
  return value;
}

function deriveMacosMetrics({ executions, streams, commandPlan }) {
  const parsed = streams.map((entry) =>
    parseTapEvidence(entry.stdout.toString("utf8")),
  );
  const semantic = parsed.map(
    ({ tests, passed, failed, cancelled, skipped, todo, coverage, coverageFiles }) => ({
      tests,
      passed,
      failed,
      cancelled,
      skipped,
      todo,
      coverage,
      coverageFiles,
    }),
  );
  if (
    parsed.length !== REQUIRED_REPEAT_COUNT ||
    semantic.some((entry) => stableJson(entry) !== stableJson(semantic[0]))
  ) {
    fail("DETERMINISM_FAILED", "macOS unit repeats diverged");
  }
  for (const [repeatIndex, repeat] of parsed.entries()) {
    for (const key of [
      "tests",
      "passed",
      "failed",
      "cancelled",
      "skipped",
      "todo",
    ]) {
      requireMetricInteger(repeat[key], `macOS repeat ${repeatIndex}.${key}`);
    }
    if (!isPlainObject(repeat.coverage)) {
      fail("COVERAGE_GAUNTLET_FAILED", "macOS TAP lacks aggregate coverage");
    }
    for (const relativePath of commandPlan.requiredCoverageFiles) {
      const file = repeat.coverageFiles[relativePath];
      if (
        !isPlainObject(file) ||
        Object.keys(file).length !== 3 ||
        ["lines", "branches", "functions"].some(
          (key) =>
            typeof file[key] !== "number" ||
            !Number.isFinite(file[key]) ||
            file[key] < MINIMUM_COVERAGE[key] ||
            file[key] > 100,
        )
      ) {
        fail(
          "COVERAGE_GAUNTLET_FAILED",
          `raw per-file coverage is below threshold for ${relativePath}`,
        );
      }
    }
  }
  const minimum = (values) => Math.min(...values);
  const maximum = (values) => Math.max(...values);
  return {
    unit: {
      repeats: executions.length,
      tests: minimum(parsed.map((entry) => entry.tests)),
      passed: minimum(parsed.map((entry) => entry.passed)),
      failed: maximum(parsed.map((entry) => entry.failed)),
      cancelled: maximum(parsed.map((entry) => entry.cancelled)),
      skipped: maximum(parsed.map((entry) => entry.skipped)),
      todo: maximum(parsed.map((entry) => entry.todo)),
    },
    coverage: {
      perFileProofSha256: sha256(
        stableJson(parsed.map((entry) => entry.coverageFiles)),
      ),
      lines: minimum(parsed.map((entry) => entry.coverage.lines)),
      branches: minimum(parsed.map((entry) => entry.coverage.branches)),
      functions: minimum(parsed.map((entry) => entry.coverage.functions)),
    },
  };
}

function validateGherkinRaw(entry, label) {
  for (const key of [
    "scenarios",
    "passed",
    "failed",
    "skipped",
    "undefined",
    "ambiguous",
    "pending",
  ]) {
    requireMetricInteger(entry[key], `${label}.${key}`);
  }
  if (
    entry.ok !== true ||
    typeof entry.passPercent !== "number" ||
    entry.passPercent !== 100
  ) {
    fail("GHERKIN_GAUNTLET_FAILED", `${label} is not a passing Gherkin result`);
  }
  return {
    ok: entry.ok,
    scenarios: entry.scenarios,
    passed: entry.passed,
    failed: entry.failed,
    skipped: entry.skipped,
    undefined: entry.undefined,
    ambiguous: entry.ambiguous,
    pending: entry.pending,
    passPercent: entry.passPercent,
  };
}

function validateMutationRaw(entry, label) {
  for (const key of [
    "total",
    "killed",
    "survived",
    "criticalTotal",
    "criticalKilled",
    "survivedCritical",
  ]) {
    requireMetricInteger(entry[key], `${label}.${key}`);
  }
  if (
    entry.ok !== true ||
    typeof entry.scorePercent !== "number" ||
    !Number.isFinite(entry.scorePercent) ||
    typeof entry.criticalMutantKillPercent !== "number" ||
    entry.criticalMutantKillPercent !== 100 ||
    !Array.isArray(entry.metaTests) ||
    entry.metaTests.length === 0 ||
    !entry.metaTests.every(
      (meta) => isPlainObject(meta) && meta.passed === true,
    ) ||
    !Array.isArray(entry.mutants) ||
    entry.mutants.length === 0
  ) {
    fail("MUTATION_GAUNTLET_FAILED", `${label} is not a passing mutation result`);
  }
  return {
    ok: entry.ok,
    total: entry.total,
    killed: entry.killed,
    survived: entry.survived,
    criticalTotal: entry.criticalTotal,
    criticalKilled: entry.criticalKilled,
    survivedCritical: entry.survivedCritical,
    scorePercent: entry.scorePercent,
    criticalMutantKillPercent: entry.criticalMutantKillPercent,
    metaTests: clone(entry.metaTests),
    mutants: clone(entry.mutants),
  };
}

function deriveLinuxMetrics(executions, streams, commands) {
  const byGroup = (group) =>
    executions
      .map((execution, index) => ({ execution, stream: streams[index], command: commands[index] }))
      .filter((entry) => entry.command.group === group);
  const gherkin = byGroup("gherkin").map((entry, index) =>
    validateGherkinRaw(
      parseLastJsonEvidence(entry.stream.stdout.toString("utf8"), `gherkin ${index}`),
      `gherkin ${index}`,
    ),
  );
  const mutation = byGroup("mutation").map((entry, index) =>
    validateMutationRaw(
      parseLastJsonEvidence(entry.stream.stdout.toString("utf8"), `mutation ${index}`),
      `mutation ${index}`,
    ),
  );
  for (const [label, values] of [
    ["Gherkin", gherkin],
    ["mutation", mutation],
  ]) {
    if (
      values.length !== REQUIRED_REPEAT_COUNT ||
      values.some((entry) => stableJson(entry) !== stableJson(values[0]))
    ) {
      fail("DETERMINISM_FAILED", `${label} repeats diverged`);
    }
  }
  const minimum = (values) => Math.min(...values);
  const maximum = (values) => Math.max(...values);
  const firstMutation = mutation[0];
  return {
    gherkinExecutions: byGroup("gherkin").map((entry) => entry.execution),
    mutationExecutions: byGroup("mutation").map((entry) => entry.execution),
    metrics: {
      gherkin: {
        scenarios: minimum(gherkin.map((entry) => entry.scenarios)),
        passed: minimum(gherkin.map((entry) => entry.passed)),
        failed: maximum(gherkin.map((entry) => entry.failed)),
        skipped: maximum(gherkin.map((entry) => entry.skipped)),
        undefined: maximum(gherkin.map((entry) => entry.undefined)),
        ambiguous: maximum(gherkin.map((entry) => entry.ambiguous)),
        pending: maximum(gherkin.map((entry) => entry.pending)),
      },
      mutation: {
        total: minimum(mutation.map((entry) => entry.total)),
        killed: minimum(mutation.map((entry) => entry.killed)),
        survived: maximum(mutation.map((entry) => entry.survived)),
        score: minimum(mutation.map((entry) => entry.scorePercent)),
        criticalTotal: minimum(
          mutation.map((entry) => entry.criticalTotal),
        ),
        criticalKilled: minimum(
          mutation.map((entry) => entry.criticalKilled),
        ),
        survivedCritical: maximum(
          mutation.map((entry) => entry.survivedCritical),
        ),
        criticalIdsSha256: sha256(stableJson(firstMutation.mutants)),
        classifierMetaTestsPassed: mutation.every((entry) =>
          entry.metaTests.every((meta) => meta.passed === true),
        ),
      },
    },
  };
}

function reconcileRawEvidence({
  materialization,
  macos,
  primary,
  independent,
  artifacts,
}) {
  const plan = materialization.phase.commandPlan;
  const macCommands = plan.commands.filter((command) => command.platform === "macos");
  const linuxCommands = plan.commands.filter((command) => command.platform === "linux");
  const macExecutionBytes = artifactBytes(
    artifacts,
    macos.evidence.unitCoverage.address,
  );
  const macExecution = validateExecutionArtifact(
    macExecutionBytes,
    macCommands,
    "macOS unit execution evidence",
  );
  if (
    macos.executionReceiptsSha256 !==
    sha256(stableJson(macExecution.receipts))
  ) {
    fail("RAW_EVIDENCE_MISMATCH", "macOS execution receipt digest diverges");
  }
  validateStreamIndexArtifact(
    artifactBytes(artifacts, macos.evidence.stdout.address),
    macExecution.receipts,
    "stdout",
    "macOS stdout index",
  );
  const macosIdentity = validateMacosIdentityEvidence(
    parseJsonArtifact(
      artifactBytes(artifacts, macos.evidence.stderr.address),
      "macOS independently authenticated identity evidence",
    ),
  );
  const semanticStderrBytes = Buffer.from(
    stableJson(macosIdentity.semanticStderrBase64),
    "utf8",
  );
  validateStreamIndexArtifact(
    semanticStderrBytes,
    macExecution.receipts,
    "stderr",
    "macOS semantic stderr index",
  );
  const expectedMacosIdentityBody = buildMacosIdentityBody({
    materialization,
    runner: {
      runnerImage: macos.runnerImage,
      nodeVersion: macos.nodeVersion,
      nodeSha256: macos.nodeSha256,
      npmVersion: macos.npmVersion,
      npmCliSha256: macos.npmCliSha256,
    },
    executedCommandCount: macos.executedCommandCount,
    executedCommandNamesSha256: macos.executedCommandNamesSha256,
    executionReceiptsSha256: macos.executionReceiptsSha256,
    unitCoverage: macos.evidence.unitCoverage,
    stdout: macos.evidence.stdout,
    semanticStderrSha256: sha256(semanticStderrBytes),
    semanticStderrByteLength: semanticStderrBytes.length,
  });
  if (
    stableJson(macosIdentity.identityBody) !==
      stableJson(expectedMacosIdentityBody)
  ) {
    fail(
      "MACOS_IDENTITY_BODY_MISMATCH",
      "signed macOS identity body does not derive from raw execution evidence",
    );
  }
  const macMetrics = deriveMacosMetrics({
    executions: macExecution.receipts,
    streams: macExecution.streams,
    commandPlan: plan,
  });
  if (stableJson(macMetrics) !== stableJson(macos.metrics)) {
    fail("RAW_METRICS_MISMATCH", "macOS raw evidence does not produce its metrics");
  }

  for (const judge of [primary, independent]) {
    if (
      stableJson(judge.evidence.unitCoverage) !==
      stableJson(macos.evidence.unitCoverage)
    ) {
      fail("RAW_EVIDENCE_MISMATCH", `${judge.role} does not reuse macOS unit evidence`);
    }
    const layers = validateExecutionArtifact(
      artifactBytes(artifacts, judge.evidence.layers.address),
      linuxCommands,
      `${judge.role} layer evidence`,
    );
    if (
      judge.executionReceiptsSha256 !== sha256(stableJson(layers.receipts))
    ) {
      fail("RAW_EVIDENCE_MISMATCH", `${judge.role} execution digest diverges`);
    }
    validateStreamIndexArtifact(
      artifactBytes(artifacts, judge.evidence.stdout.address),
      layers.receipts,
      "stdout",
      `${judge.role} stdout index`,
    );
    validateStreamIndexArtifact(
      artifactBytes(artifacts, judge.evidence.stderr.address),
      layers.receipts,
      "stderr",
      `${judge.role} stderr index`,
    );
    const derived = deriveLinuxMetrics(
      layers.receipts,
      layers.streams,
      linuxCommands,
    );
    for (const [key, expected] of [
      ["gherkin", derived.gherkinExecutions],
      ["mutation", derived.mutationExecutions],
    ]) {
      const actual = parseJsonArtifact(
        artifactBytes(artifacts, judge.evidence[key].address),
        `${judge.role} ${key} evidence`,
      );
      if (stableJson(actual) !== stableJson(expected)) {
        fail("RAW_EVIDENCE_MISMATCH", `${judge.role} ${key} subset diverges`);
      }
    }
    const macosRaw = parseJsonArtifact(
      artifactBytes(artifacts, judge.evidence.macosUnit.address),
      `${judge.role} macOS receipt evidence`,
    );
    if (stableJson(macosRaw) !== stableJson(macos)) {
      fail("RAW_EVIDENCE_MISMATCH", `${judge.role} macOS receipt bytes diverge`);
    }
    const expectedMetrics = {
      unit: macMetrics.unit,
      coverage: macMetrics.coverage,
      gherkin: derived.metrics.gherkin,
      mutation: derived.metrics.mutation,
    };
    if (stableJson(expectedMetrics) !== stableJson(judge.metrics)) {
      fail("RAW_METRICS_MISMATCH", `${judge.role} raw evidence does not produce metrics`);
    }
  }
  return Object.freeze({
    macosIdentity: Object.freeze(macosIdentity),
    macMetrics: Object.freeze(macMetrics),
  });
}

function extractBoundedOidcIdentity(receipt, label) {
  if (
    !isPlainObject(receipt) ||
    typeof receipt.oidcToken !== "string" ||
    Buffer.byteLength(receipt.oidcToken, "utf8") > 48 * 1024
  ) {
    fail("OIDC_CRYPTO_INVALID", `${label} lacks a bounded compact token`);
  }
  const segments = receipt.oidcToken.split(".");
  if (
    segments.length !== 3 ||
    !/^[A-Za-z0-9_-]+$/.test(segments[1]) ||
    segments[1].length > 32768
  ) {
    fail("OIDC_CRYPTO_INVALID", `${label} token payload is not bounded base64url`);
  }
  let payload;
  try {
    const bytes = Buffer.from(segments[1], "base64url");
    if (bytes.toString("base64url") !== segments[1]) {
      throw new Error("non-canonical base64url");
    }
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("OIDC_CRYPTO_INVALID", `${label} token payload is invalid`);
  }
  if (
    !isPlainObject(payload) ||
    payload.iss !== EXPECTED_OIDC_ISSUER ||
    typeof payload.jti !== "string" ||
    !UUID_PATTERN.test(payload.jti)
  ) {
    fail("OIDC_CRYPTO_INVALID", `${label} token identity is invalid`);
  }
  return Object.freeze({ issuer: payload.iss, jti: payload.jti });
}

function verifyMacosJobIdentity({
  identityEvidence,
  materialization,
  finalCollectorReceipt,
  jwksRegistry,
  nowMs = Date.now(),
}) {
  const identity = validateMacosIdentityEvidence(identityEvidence);
  const materialized = validateMaterializationReceipt(materialization);
  const macIdentityReceipt = identity.collectorReceipt;
  const macTokenIdentity = extractBoundedOidcIdentity(
    macIdentityReceipt,
    "macOS identity",
  );
  const finalTokenIdentity = extractBoundedOidcIdentity(
    finalCollectorReceipt,
    "final collector",
  );
  const macReplayKeySha256 = sha256(
    stableJson({
      issuer: macTokenIdentity.issuer,
      jti: macTokenIdentity.jti,
      repository: materialized.repository,
      runId: materialized.run.runId,
      runAttempt: materialized.run.runAttempt,
    }),
  );
  const {
    verifyGithubOidcCollectorV3,
  } = require("./pikiio-github-oidc-collector-v3");
  let macOidc;
  try {
    macOidc = verifyGithubOidcCollectorV3({
      collectorReceipt: clone(macIdentityReceipt),
      jwksRegistry,
      expectedAttestationBody: clone(identity.identityBody),
      expectedAttestationBodySha256: identity.identityBodySha256,
      expectedAuthorityCommit: materialized.authority.commit,
      expectedPhaseScopeBaseCommit: materialized.phase.scopeBaseCommit,
      expectedCandidateCommit: materialized.candidate.commit,
      expectedRun: clone(materialized.run),
      expectedIssuer: macTokenIdentity.issuer,
      expectedJti: macTokenIdentity.jti,
      expectedReplayKeySha256: macReplayKeySha256,
      expectedJwksRegistrySha256:
        materialized.authority.jwksRegistrySha256,
      nowMs,
    });
  } catch (error) {
    fail(
      "MACOS_IDENTITY_CRYPTO_INVALID",
      "macOS job identity failed cryptographic verification",
      { causeCode: error?.code || "UNKNOWN_OIDC_FAILURE" },
    );
  }
  if (
    !isPlainObject(macOidc) ||
    macOidc.valid !== true ||
    macOidc.attestationBodySha256 !== identity.identityBodySha256 ||
    macOidc.collectorReceiptSha256 !== identity.collectorReceiptSha256 ||
    macOidc.authorityCommit !== materialized.authority.commit ||
    macOidc.phaseScopeBaseCommit !== materialized.phase.scopeBaseCommit ||
    macOidc.candidateCommit !== materialized.candidate.commit ||
    macOidc.runId !== materialized.run.runId ||
    macOidc.runAttempt !== materialized.run.runAttempt ||
    macOidc.requestNonce !== materialized.run.requestNonce ||
    macOidc.issuer !== macTokenIdentity.issuer ||
    macOidc.jti !== macTokenIdentity.jti ||
    macOidc.replayKeySha256 !== macReplayKeySha256 ||
    macOidc.productionAuthority !== false
  ) {
    fail(
      "MACOS_IDENTITY_BINDING_MISMATCH",
      "macOS job identity does not bind A/S/C/run/raw result",
    );
  }
  if (
    macTokenIdentity.jti === finalTokenIdentity.jti ||
    macIdentityReceipt.oidcToken === finalCollectorReceipt.oidcToken ||
    identity.collectorReceiptSha256 ===
      sha256(stableJson(finalCollectorReceipt))
  ) {
    fail(
      "MACOS_IDENTITY_NOT_INDEPENDENT",
      "macOS identity and final collector must use distinct signed receipts",
    );
  }
  return Object.freeze({
    valid: true,
    identityBodySha256: identity.identityBodySha256,
    collectorReceiptSha256: identity.collectorReceiptSha256,
    jti: macOidc.jti,
    replayKeySha256: macOidc.replayKeySha256,
    productionAuthority: false,
  });
}

function verifyExternalCiCertification({
  request,
  trustedAuthority,
  materialization,
  macosLineage,
  macosJudge,
  primaryJudge,
  independentJudge,
  verdict,
  certification,
  artifacts,
  jwksRegistry,
  nowMs = Date.now(),
}) {
  const boundedRequest = validateCertificationRequest(request);
  validateTrustedAuthority(trustedAuthority);
  const materialized = validateMaterializationReceipt(materialization);
  const lineage = validateMacosLineage(macosLineage);
  const macos = validatePlatformReceipt(macosJudge);
  const primary = validateJudgeReceipt(primaryJudge, "primary");
  const independent = validateJudgeReceipt(independentJudge, "independent");
  const quality = validateQualityVerdict(verdict);
  const certified = validateExternalCiCertification(certification);
  const materializedAuthority = Object.fromEntries(
    TRUSTED_AUTHORITY_KEYS.map((key) => [
      key,
      materialized.authority[key],
    ]),
  );
  if (stableJson(materializedAuthority) !== stableJson(trustedAuthority)) {
    fail("UNTRUSTED_AUTHORITY", "materialized authority does not match local policy");
  }

  if (
    boundedRequest.phaseId !== materialized.phase.phaseId ||
    boundedRequest.phaseScopeBaseCommit !==
      materialized.phase.scopeBaseCommit ||
    boundedRequest.candidateCommit !== materialized.candidate.commit ||
    boundedRequest.requestNonce !== materialized.run.requestNonce
  ) {
    fail("REQUEST_BINDING_MISMATCH", "materialization is not bound to the request");
  }

  const expectedManifest = assertReceiptBindings(
    materialized,
    lineage,
    macos,
    primary,
    independent,
    quality,
  );
  if (
    stableJson(certified.evidenceManifest) !== stableJson(expectedManifest)
  ) {
    fail("MANIFEST_BINDING_MISMATCH", "certification omits or adds raw CAS evidence");
  }
  const expectedBody = buildExternalCiAttestationBody({
    materialization: materialized,
    macosLineage: lineage,
    macosJudge: macos,
    primaryJudge: primary,
    independentJudge: independent,
    verdict: quality,
  });
  if (stableJson(certified.attestationBody) !== stableJson(expectedBody)) {
    fail("ATTESTATION_SUBSTITUTION", "collector body was not derived from receipts");
  }
  const expectedReplayKeySha256 = sha256(
    stableJson({
      issuer: certified.replay.issuer,
      jti: certified.replay.jti,
      repository: materialized.repository,
      runId: materialized.run.runId,
      runAttempt: materialized.run.runAttempt,
    }),
  );
  if (certified.replay.replayKeySha256 !== expectedReplayKeySha256) {
    fail("REPLAY_BINDING_MISMATCH", "replay key does not bind issuer, JTI, and run");
  }

  let totalBytes = 0;
  for (const reference of certified.evidenceManifest) {
    const bytes = artifactBytes(artifacts, reference.address);
    totalBytes += bytes.length;
    if (
      bytes.length !== reference.byteLength ||
      sha256(bytes) !== reference.sha256
    ) {
      fail("CAS_ARTIFACT_MISMATCH", `raw artifact ${reference.address} is invalid`);
    }
  }
  if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
    fail("SIZE_LIMIT_EXCEEDED", "raw CAS artifacts exceed their aggregate limit");
  }
  const authorityWorkflowBytes = artifactBytes(
    artifacts,
    lineage.authorityWorkflow.address,
  );
  assertMacosLineageBindings({
    lineage,
    materialization: materialized,
    macosJudge: macos,
    authorityWorkflowBytes,
  });
  const raw = reconcileRawEvidence({
    materialization: materialized,
    macos,
    primary,
    independent,
    artifacts,
  });

  verifyMacosJobIdentity({
    identityEvidence: raw.macosIdentity,
    materialization: materialized,
    finalCollectorReceipt: certified.collectorReceipt,
    jwksRegistry,
    nowMs,
  });
  const {
    verifyGithubOidcCollectorV3,
  } = require("./pikiio-github-oidc-collector-v3");
  let oidc;
  try {
    oidc = verifyGithubOidcCollectorV3({
      collectorReceipt: clone(certified.collectorReceipt),
      jwksRegistry,
      expectedAttestationBody: clone(expectedBody),
      expectedAttestationBodySha256: certified.attestationBodySha256,
      expectedAuthorityCommit: materialized.authority.commit,
      expectedPhaseScopeBaseCommit: materialized.phase.scopeBaseCommit,
      expectedCandidateCommit: materialized.candidate.commit,
      expectedRun: clone(materialized.run),
      expectedIssuer: certified.replay.issuer,
      expectedJti: certified.replay.jti,
      expectedReplayKeySha256: certified.replay.replayKeySha256,
      expectedJwksRegistrySha256:
        materialized.authority.jwksRegistrySha256,
      nowMs,
    });
  } catch (error) {
    fail(
      "OIDC_CRYPTO_INVALID",
      "GitHub OIDC collector failed cryptographic verification",
      { causeCode: error?.code || "UNKNOWN_OIDC_FAILURE" },
    );
  }
  if (
    !isPlainObject(oidc) ||
    oidc.valid !== true ||
    oidc.attestationBodySha256 !== certified.attestationBodySha256 ||
    oidc.collectorReceiptSha256 !== certified.collectorReceiptSha256 ||
    oidc.authorityCommit !== materialized.authority.commit ||
    oidc.phaseScopeBaseCommit !== materialized.phase.scopeBaseCommit ||
    oidc.candidateCommit !== materialized.candidate.commit ||
    oidc.runId !== materialized.run.runId ||
    oidc.runAttempt !== materialized.run.runAttempt ||
    oidc.requestNonce !== materialized.run.requestNonce ||
    oidc.issuer !== certified.replay.issuer ||
    oidc.jti !== certified.replay.jti ||
    oidc.replayKeySha256 !== certified.replay.replayKeySha256 ||
    oidc.productionAuthority !== false
  ) {
    fail("OIDC_BINDING_MISMATCH", "OIDC collector result does not bind A/S/C");
  }
  const collectedAt = Date.parse(certified.collectorReceipt.receivedAt);
  const verifiedAt = Date.parse(certified.verifiedAt);
  if (
    !Number.isFinite(collectedAt) ||
    verifiedAt < collectedAt ||
    verifiedAt > collectedAt + 30 * 1000 ||
    verifiedAt > nowMs + 30 * 1000
  ) {
    fail(
      "CERTIFICATION_TIME_INVALID",
      "certification time is not bound to the signed collection window",
    );
  }
  return Object.freeze({
    valid: true,
    phaseId: materialized.phase.phaseId,
    authorityCommit: materialized.authority.commit,
    phaseScopeBaseCommit: materialized.phase.scopeBaseCommit,
    scopeBaseCommit: materialized.phase.scopeBaseCommit,
    candidateCommit: materialized.candidate.commit,
    requestNonce: materialized.run.requestNonce,
    qualityVerdictHash: quality.receiptHash,
    evidenceManifestSha256: quality.evidenceManifestSha256,
    replayKeySha256: certified.replay.replayKeySha256,
    attestationBodySha256: certified.attestationBodySha256,
    certificationHash: certified.certificationHash,
    productionAuthority: false,
  });
}

function validateExternalCiPackage(bundle) {
  requireExactKeys(bundle, PACKAGE_KEYS, "external CI package");
  if (bundle.schema !== PACKAGE_SCHEMA) {
    fail("INVALID_SCHEMA", "external CI package schema is not v3");
  }
  validateCertificationRequest(bundle.request);
  validateMaterializationReceipt(bundle.materialization);
  validateMacosLineage(bundle.macosLineage);
  validatePlatformReceipt(bundle.macosJudge);
  validateJudgeReceipt(bundle.primaryJudge, "primary");
  validateJudgeReceipt(bundle.independentJudge, "independent");
  validateQualityVerdict(bundle.verdict);
  validateExternalCiCertification(bundle.certification);
  validateEvidenceManifest(bundle.evidenceManifest);
  requireSha(bundle.packageHash, "external CI package.packageHash");
  if (bundle.packageHash !== hashWithoutField(bundle, "packageHash")) {
    fail("HASH_MISMATCH", "external CI package hash does not match");
  }
  requireJsonBound(
    bundle,
    "external CI package",
    MAX_PACKAGE_JSON_BYTES,
  );
  return clone(bundle);
}

function sealExternalCiPackage({
  request,
  materialization,
  macosLineage,
  macosJudge,
  primaryJudge,
  independentJudge,
  verdict,
  certification,
}) {
  const bundle = {
    schema: PACKAGE_SCHEMA,
    request: clone(request),
    materialization: clone(materialization),
    macosLineage: clone(macosLineage),
    macosJudge: clone(macosJudge),
    primaryJudge: clone(primaryJudge),
    independentJudge: clone(independentJudge),
    verdict: clone(verdict),
    certification: clone(certification),
    evidenceManifest: evidenceReferences(
      primaryJudge,
      independentJudge,
      macosJudge,
      macosLineage,
    ),
    packageHash: "0".repeat(64),
  };
  bundle.packageHash = hashWithoutField(bundle, "packageHash");
  return validateExternalCiPackage(bundle);
}

function verifyExternalCiPackage({
  bundle,
  trustedAuthority,
  jwksRegistry,
  artifacts,
  nowMs = Date.now(),
}) {
  const packaged = validateExternalCiPackage(bundle);
  if (
    stableJson(packaged.evidenceManifest) !==
    stableJson(packaged.certification.evidenceManifest)
  ) {
    fail(
      "MANIFEST_BINDING_MISMATCH",
      "package evidence manifest differs from certification",
    );
  }
  return verifyExternalCiCertification({
    request: packaged.request,
    trustedAuthority,
    materialization: packaged.materialization,
    macosLineage: packaged.macosLineage,
    macosJudge: packaged.macosJudge,
    primaryJudge: packaged.primaryJudge,
    independentJudge: packaged.independentJudge,
    verdict: packaged.verdict,
    certification: packaged.certification,
    artifacts,
    jwksRegistry,
    nowMs,
  });
}

module.exports = {
  ATTESTATION_BODY_SCHEMA,
  AUTHORITY_WORKFLOW_PATH,
  AUTHORITY_WORKFLOW_REF,
  CERTIFICATION_SCHEMA,
  COMMAND_PLAN_SCHEMA,
  EXPECTED_REPOSITORY,
  EXPECTED_OIDC_ISSUER,
  ExternalCiProofError,
  JUDGE_SCHEMA,
  MACOS_LINEAGE_SCHEMA,
  MATERIALIZATION_SCHEMA,
  MACOS_IDENTITY_BODY_SCHEMA,
  MACOS_IDENTITY_EVIDENCE_SCHEMA,
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
  MINIMUM_COVERAGE,
  MINIMUM_CRITICAL_MUTANTS,
  MINIMUM_GHERKIN_SCENARIOS,
  MINIMUM_MUTANTS,
  MINIMUM_MUTATION_SCORE,
  MINIMUM_UNIT_TESTS,
  PACKAGE_SCHEMA,
  PLATFORM_RECEIPT_SCHEMA,
  REQUEST_SCHEMA,
  VERDICT_SCHEMA,
  buildExternalCiAttestationBody,
  buildMacosIdentityBody,
  buildMacosLineage,
  commandDefinitionSha256,
  commandNamesSha256,
  evidenceManifestSha256,
  evidenceReferences,
  hashWithoutField,
  sealExternalCiCertification,
  sealJudgeReceipt,
  sealMaterializationReceipt,
  sealPlatformReceipt,
  sealQualityVerdict,
  sealExternalCiPackage,
  sha256,
  stableJson,
  validateCertificationRequest,
  validateCommandPlan,
  validateConstructibleSourceHistory,
  validateExternalCiAttestationBody,
  validateExternalCiCertification,
  validateExternalCiPackage,
  validateJudgeReceipt,
  validateMacosLineage,
  validateMacosIdentityBody,
  validateMacosIdentityEvidence,
  validateMaterializationReceipt,
  validatePlatformReceipt,
  validateQualityVerdict,
  validateTrustedAuthority,
  validateAuthorityWorkflowForMacosLineage,
  reconcileRawEvidence,
  verifyExternalCiCertification,
  verifyExternalCiPackage,
  verifyMacosJobIdentity,
};

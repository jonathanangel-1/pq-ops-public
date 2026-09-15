#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const governance = require("../lib/pikiio-agent-governance");
const phaseProof = require("../lib/pikiio-phase-proof");
const oidcCollector = require("../lib/pikiio-github-oidc-collector");
const hostDurability = require("../lib/pikiio-host-durability");
const phaseAttestation = require("../lib/pikiio-phase-attestation");
const phaseProofEnvelope = require("../lib/pikiio-phase-proof-envelope");
const {
  SEALED_ENVIRONMENT,
  createSealedGit,
  resolveTrustedGitExecutable,
} = require("../lib/pikiio-sealed-git");
const writerLease = require("./pikiio-agent-writer-lease");
const qualityCanonical = require("../lib/pikiio-quality-canonical");
const {
  comparePikiioHeartbeatPrompt,
  readCanonicalPikiioHeartbeatPrompt,
} = require("./verify-automation-contracts");

// The only substituted external-proof validator below is confined to a
// hermetic alternate Git repository. Canonical-repository substitution remains
// unconditionally refused by the governance runtime.
process.env.NODE_ENV = "test";

const ROOT = path.resolve(__dirname, "..");
const TRUSTED_GIT = resolveTrustedGitExecutable();
const FIXTURE_GIT_PREFIX = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesfile=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
]);
const FIXTURE_GIT_ENVIRONMENT = Object.freeze({
  ...SEALED_ENVIRONMENT,
  GIT_AUTHOR_NAME: "Pikiio Gherkin",
  GIT_AUTHOR_EMAIL: "pikiio-gherkin@example.invalid",
  GIT_COMMITTER_NAME: "Pikiio Gherkin",
  GIT_COMMITTER_EMAIL: "pikiio-gherkin@example.invalid",
  GIT_AUTHOR_DATE: "2026-07-24T08:00:00Z",
  GIT_COMMITTER_DATE: "2026-07-24T08:00:00Z",
});
const FEATURE_PATH = path.join(
  ROOT,
  "tests",
  "features",
  "pikiio-governed-heartbeat.feature",
);
const AUTOMATION_PATH = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "automations",
  "pikiio-governed-builder-heartbeat",
  "automation.toml",
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const CANONICAL_LEDGER = governance.loadPhaseLedger();

function governanceLedgerFixture(source = CANONICAL_LEDGER) {
  const ledger = clone(source);
  for (const phase of ledger.phases) {
    if (phase.id === "GOV-00") {
      phase.status = "active";
      if (!/^[a-f0-9]{40}$/.test(phase.scopeBaseCommit)) {
        phase.scopeBaseCommit = ledger.baseline.startCommit;
      }
    } else if (governance.ACTIVE_STATUSES.has(phase.status)) {
      phase.status = "planned";
    }
  }
  ledger.activePhaseId = "GOV-00";
  return ledger;
}

const LEDGER = governanceLedgerFixture();

function signReceipt(value) {
  const signed = clone(value);
  delete signed.receiptHash;
  signed.receiptHash = governance.sha256(governance.stableJson(signed));
  return signed;
}

function tempDirectory(prefix) {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
}

function fixtureGitArgumentsAreAllowed(args) {
  const safeRepositoryPath = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    !value.startsWith("-") &&
    !path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== ".." &&
    !value.startsWith(`..${path.sep}`);
  if (
    args.length === 3 &&
    args[0] === "init" &&
    args[1] === "-b"
  ) {
    return /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(args[2]);
  }
  if (args.length === 2 && args[0] === "add") {
    return args[1] === "." || safeRepositoryPath(args[1]);
  }
  if (
    args.length === 3 &&
    args[0] === "commit" &&
    args[1] === "-m"
  ) {
    return (
      typeof args[2] === "string" &&
      args[2].length > 0 &&
      args[2].length <= 256 &&
      !args[2].includes("\0") &&
      !args[2].includes("\n")
    );
  }
  if (
    args.length === 3 &&
    args[0] === "commit" &&
    args[1] === "--amend" &&
    args[2] === "--no-edit"
  ) {
    return true;
  }
  if (args.length === 2 && args[0] === "rev-parse") {
    return (
      args[1] === "HEAD" ||
      /^[a-f0-9]{40}\^\{tree\}$/u.test(args[1])
    );
  }
  return false;
}

function trustedFixtureGit(repoRoot, args, options = {}) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native(repoRoot);
  } catch {
    canonicalRoot = null;
  }
  if (
    canonicalRoot !== repoRoot ||
    !Array.isArray(args) ||
    args.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.includes("\0") ||
        entry.length > 4096,
    ) ||
    !fixtureGitArgumentsAreAllowed(args) ||
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).some(
      (key) => !["encoding", "stdio"].includes(key),
    ) ||
    (Object.hasOwn(options, "encoding") &&
      options.encoding !== "utf8") ||
    (Object.hasOwn(options, "stdio") &&
      options.stdio !== "ignore")
  ) {
    const error = new Error(
      "Gherkin fixture Git requires a canonical repository and one exact mutation shape",
    );
    error.code = "GHERKIN_FIXTURE_GIT_INVALID";
    throw error;
  }
  return execFileSync(
    TRUSTED_GIT,
    [...FIXTURE_GIT_PREFIX, ...args],
    {
      cwd: canonicalRoot,
      env: { ...FIXTURE_GIT_ENVIRONMENT },
      encoding: options.encoding ?? "utf8",
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

function parseFeature(source) {
  const scenarios = [];
  let current = null;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("Feature:")) continue;
    if (line.startsWith("Scenario:")) {
      current = { name: line.slice("Scenario:".length).trim(), steps: [] };
      scenarios.push(current);
      continue;
    }
    if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      assert.ok(current, `Step appears before a Scenario: ${line}`);
      current.steps.push(line);
    }
  }
  return scenarios;
}

function exactScenarioContracts(scenarios, definitions) {
  const names = new Set(scenarios.map((scenario) => scenario.name));
  assert.deepEqual(
    [...names].sort(),
    Object.keys(definitions).sort(),
    "Every scenario must have exactly one executable contract",
  );
  for (const scenario of scenarios) {
    assert.deepEqual(
      scenario.steps,
      definitions[scenario.name].steps,
      `${scenario.name}: undefined, reordered, or ambiguous step contract`,
    );
  }
}

function fixedNewYorkEpoch(hour, minute, second = 0) {
  return governance.zonedDateTimeToEpoch(
    { year: 2026, month: 7, day: 24, hour, minute, second },
    "America/New_York",
  );
}

function dependencyManifestFixture() {
  const manifest = {
    packageJsonSha256: "1".repeat(64),
    packageLockSha256: "2".repeat(64),
    installedLockSha256: "3".repeat(64),
    name: "pikiio-gherkin-fixture",
    version: "1.0.0",
    dependencies: [],
    problemCount: 0,
    defectCount: 0,
  };
  return {
    ...manifest,
    manifestSha256: governance.sha256(governance.stableJson(manifest)),
  };
}

function rawJudgeArtifactFixture(layerCount, fill) {
  const artifactSha256 = fill.repeat(64);
  return {
    schema: "pikiio-quality-judge-raw-artifact-v1",
    artifactPath: path.join(
      os.tmpdir(),
      "pikiio-quality-judge-artifacts",
      `${artifactSha256}.json`,
    ),
    artifactSha256,
    byteLength: 1024,
    layerCount,
  };
}

function minimalQualityReceipt(
  ledger,
  phase,
  head,
  workspaceDigest,
  options = {},
) {
  const profile = governance.effectiveQualityProfile(
    ledger.qualityPolicy.profiles[phase.qualityProfile],
    phase.id,
  );
  const requiredCoverageFiles = [
    ...governance.QUALITY_TEST_SUITE_REGISTRY[
      phase.qualityPlan.testSuiteId
    ].coverageIncludes,
  ].sort();
  const layerPlan = governance.expectedQualityLayerPlan(phase, profile, {
    requiredCoverageFiles,
  });
  const dependencyManifest = dependencyManifestFixture();
  const candidateTree = options.candidateTree || head;
  const automationSnapshotSha256 = "4".repeat(64);
  const populations = {
    unit: Array.from({ length: profile.deterministicRepeatCount }, () => ({
      tests: profile.minimumUnitTestsPerRun,
      passed: profile.minimumUnitTestsPerRun,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    })),
    mutation: Array.from({ length: profile.deterministicRepeatCount }, () => ({
      total: profile.minimumMutationPopulation,
      killed: profile.minimumMutationPopulation,
      survived: 0,
      criticalTotal: profile.minimumCriticalMutationPopulation,
      criticalKilled: profile.minimumCriticalMutationPopulation,
      survivedCritical: 0,
      scorePercent: 100,
      criticalKillPercent: 100,
      metaTestsPassed: true,
    })),
    gherkin: Array.from({ length: profile.deterministicRepeatCount }, () => ({
      scenarios: profile.minimumGherkinScenarioPopulation,
      passed: profile.minimumGherkinScenarioPopulation,
      failed: 0,
      skipped: 0,
      undefined: 0,
      ambiguous: 0,
      pending: 0,
      passPercent: 100,
    })),
  };
  return {
    recordedAt: "2026-07-24T04:30:00.000Z",
    ledgerRevision: ledger.revision,
    ledgerSha256: governance.sha256(governance.stableJson(ledger)),
    goalObjectiveSha256: ledger.codexGoal.objectiveSha256,
    phaseId: phase.id,
    phaseProofRegistrySha256: governance.CANONICAL_REGISTRY_SHA256,
    qualityProfile: phase.qualityProfile,
    qualityPlanSha256: governance.sha256(
      governance.stableJson(phase.qualityPlan),
    ),
    commandPlanSha256: governance.sha256(governance.stableJson(layerPlan)),
    scopeBaseCommit: phase.scopeBaseCommit,
    head,
    candidateTree,
    workspaceDigest,
    operationalCheckout: {
      schema: "pikiio-operational-git-visible-evidence-v1",
      scope: "git-visible-worktree-and-index",
      beforeSha256: "5".repeat(64),
      afterSha256: "5".repeat(64),
      unchanged: true,
    },
    automationSnapshotSha256,
    dependencyManifest,
    qualityToolchain: JSON.parse(
      JSON.stringify(ledger.qualityPolicy.approvedToolchain),
    ),
    primaryJudge: {
      worktreeHead: head,
      worktreeTree: candidateTree,
      workspaceUnchanged: true,
      installIsolation: "macos-sandbox-deny-network",
      auditIsolation: "macos-sandbox-deny-network",
      rawArtifact: rawJudgeArtifactFixture(layerPlan.length, "d"),
    },
    thresholds: JSON.parse(JSON.stringify(profile)),
    requiredCoverageFiles,
    metrics: {
      requiredLayersPassed: layerPlan.length,
      testRuns: profile.deterministicRepeatCount,
      testsPerRun: profile.minimumUnitTestsPerRun,
      minimumMutationPopulation: profile.minimumMutationPopulation,
      minimumCriticalMutationPopulation:
        profile.minimumCriticalMutationPopulation,
      minimumGherkinScenarioPopulation:
        profile.minimumGherkinScenarioPopulation,
      mutationClassifierMetaTestsPassed: true,
      deterministicRepeatCount: profile.deterministicRepeatCount,
      failedTests: 0,
      skippedRequiredTests: 0,
      flakyTests: 0,
      newWarnings: 0,
      undefinedGherkinSteps: 0,
      survivedCriticalMutants: 0,
      minimumObservedCoverage: {
        lines: profile.minimumLineCoveragePercent,
        branches: profile.minimumBranchCoveragePercent,
        functions: profile.minimumFunctionCoveragePercent,
      },
      perFileCoverage: (() => {
        const body = {
          requiredFiles: requiredCoverageFiles,
          repeats: Array.from(
            { length: profile.deterministicRepeatCount },
            (_, index) => ({
              repeat: index + 1,
              files: requiredCoverageFiles.map((relativePath) => ({
                path: relativePath,
                lines: profile.minimumLineCoveragePercent,
                branches: profile.minimumBranchCoveragePercent,
                functions: profile.minimumFunctionCoveragePercent,
              })),
            }),
          ),
        };
        return {
          schema: "pikiio-per-file-coverage-proof-v1",
          ...body,
          proofSha256: governance.sha256(governance.stableJson(body)),
        };
      })(),
      minimumObservedMutationScore: 100,
      criticalMutantKillPercent: 100,
      gherkinPassPercent: 100,
      cleanCheckoutReproduced: true,
    },
    populations,
    antiWeakening: {
      scopeBaseCommit: phase.scopeBaseCommit,
      candidateHead: head,
      sliceDiffSha256:
        options.sliceDiffSha256 || governance.sha256(Buffer.from("")),
      worktreeChangedPaths: [],
      sliceChangedPaths: options.sliceChangedPaths || [],
      auditedPaths: options.sliceChangedPaths || [],
      protectedChanged: (options.sliceChangedPaths || []).filter(
        (relativePath) =>
          ledger.qualityPolicy.trustedGatePaths.includes(relativePath),
      ),
      weakeningFindings: [],
      baselineCounts: { tests: 1, assertions: 1, scenarios: 1, mutants: 1 },
      currentCounts: { tests: 1, assertions: 1, scenarios: 1, mutants: 1 },
    },
    cleanJudge: {
      reproduced: true,
      worktreeHead: head,
      worktreeTree: candidateTree,
      automationSnapshotSha256,
      dependencyManifest: clone(dependencyManifest),
      rawArtifact: rawJudgeArtifactFixture(layerPlan.length, "e"),
      workspaceUnchanged: true,
      semanticSha256: "c".repeat(64),
    },
    layers: layerPlan.map((layer, index) => ({
      ...layer,
      isolation: "macos-sandbox-deny-network",
      status: 0,
      signal: null,
      timedOut: false,
      semanticSha256: String(index).padStart(64, "0").slice(-64),
    })),
  };
}

function embedRawQualityEvidence(
  inputReceipt,
  artifactDirectory = path.join(
    os.tmpdir(),
    "pikiio-quality-judge-artifacts",
  ),
) {
  let receipt = clone(inputReceipt);
  const rawArtifactBytes = new Map();
  for (const [label, holder] of [
    ["primary", receipt.primaryJudge],
    ["independent", receipt.cleanJudge],
  ]) {
    const rawLayers = receipt.layers.map((layer) => {
      const rawLayer = {
        name: layer.name,
        checkId: layer.checkId,
        definitionSha256: layer.definitionSha256,
        command: layer.command,
        isolation: layer.isolation,
        startedAt: "2026-07-24T04:29:00.000Z",
        finishedAt: "2026-07-24T04:29:01.000Z",
        status: layer.status,
        signal: layer.signal,
        timedOut: layer.timedOut,
        stdout: "",
        stderr: "",
        parsed: null,
        normalizationRoots: ["/disposable/judge"],
      };
      rawLayer.semanticSha256 =
        qualityCanonical.semanticReceiptSha256(rawLayer);
      layer.semanticSha256 = rawLayer.semanticSha256;
      return rawLayer;
    });
    const raw = {
      schema: "pikiio-quality-judge-raw-artifact-v1",
      label,
      candidateCommit: receipt.head,
      candidateTree: receipt.candidateTree,
      automationSnapshotSha256: receipt.automationSnapshotSha256,
      dependencyManifestSha256: receipt.dependencyManifest.manifestSha256,
      toolchainSha256: receipt.qualityToolchain.toolchainSha256,
      layers: rawLayers,
    };
    const bytes = Buffer.from(governance.stableJson(raw), "utf8");
    const digest = governance.sha256(bytes);
    holder.rawArtifact = {
      schema: "pikiio-quality-judge-raw-artifact-v1",
      artifactPath: path.join(artifactDirectory, `${digest}.json`),
      artifactSha256: digest,
      byteLength: bytes.length,
      layerCount: rawLayers.length,
    };
    rawArtifactBytes.set(`sha256:${digest}`, bytes);
  }
  receipt = signReceipt(receipt);
  return { receipt, rawArtifactBytes };
}

function readyHostReceipt(overrides = {}) {
  const expectedPath =
    `/workspace/demo/Library/LaunchAgents/${hostDurability.HOST_SERVICE_LABEL}.plist`;
  const servicePlistEvidence = {
    expectedPath,
    resolvedPath: expectedPath,
    readable: true,
    regular: true,
    symlink: false,
    byteLength: hostDurability.HOST_SERVICE_PLIST_BYTE_LENGTH,
    sha256: hostDurability.HOST_SERVICE_PLIST_SHA256,
    maximumBytes: hostDurability.MAXIMUM_HOST_SERVICE_PLIST_BYTES,
    errorCode: null,
    ...(overrides.servicePlistEvidence || {}),
  };
  const launchctl = [
    `gui/501/${hostDurability.HOST_SERVICE_LABEL} = {`,
    `\tpath = ${expectedPath}`,
    `\tstate = ${overrides.serviceState || "running"}`,
    `\tprogram = ${hostDurability.HOST_SERVICE_PROGRAM}`,
    "\targuments = {",
    ...hostDurability.HOST_SERVICE_ARGUMENTS.map(
      (argument) => `\t\t${argument}`,
    ),
    "\t}",
    "\tpid = 4242",
    "\tlast exit code = 0",
    "}",
    "",
  ].join("\n");
  return hostDurability.buildHostDurabilityReceipt({
    observedAt: "2026-07-24T08:00:00.000Z",
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    batteryOutput: "Now drawing from 'AC Power'\n100%; charged;",
    pmsetOutput:
      overrides.pmsetOutput ||
      "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n",
    assertionsOutput:
      overrides.assertionsOutput ||
      [
        "PreventSystemSleep 1",
        "PreventUserIdleSystemSleep 1",
        "pid 4242(caffeinate): PreventSystemSleep",
        "pid 4242(caffeinate): PreventUserIdleSystemSleep",
      ].join("\n"),
    clamshellOutput: '"AppleClamshellState" = No',
    launchctlOutput: launchctl,
    expectedPlistPath: expectedPath,
    servicePlistEvidence,
  });
}

function governanceAuthorityFiles() {
  const registry = phaseProof.loadPhaseProofRegistry();
  return registry.phases["GOV-00"].authorityFiles;
}

function proofIdentity(id, kind) {
  const identity = { id, kind, version: "1.0.0" };
  identity.identitySha256 = phaseProof.sha256(
    phaseProof.stableJson(identity),
  );
  return identity;
}

function proofAssertions(phase, evidence = null) {
  const assertions = phaseProof.expectedAssertions(phase, evidence);
  for (const assertion of phase.promotionAssertions) {
    if (evidence !== null && assertion.evidence !== evidence) continue;
    if (assertion.operator === "gte" || assertion.operator === "lte") {
      assertions[assertion.id] = assertion.expected;
    }
  }
  return assertions;
}

function addPhaseProofArtifact(artifacts, value) {
  const bytes = Buffer.from(phaseProof.stableJson(value), "utf8");
  const digest = phaseProof.sha256(bytes);
  const address = `sha256:${digest}`;
  artifacts.set(address, bytes);
  return { address, sha256: digest };
}

function finishPhaseProofReceipt(receipt) {
  receipt.receiptHash = phaseProof.hashWithoutField(receipt);
  return receipt;
}

function buildGovernancePhaseProofBundle({
  ledger,
  phase,
  qualityReceipt,
  repoRoot,
  candidateCommit,
  observedAtMs,
}) {
  const registry = phaseProof.loadPhaseProofRegistry();
  const proofPhase = phaseProof.phaseProofForId(registry, phase.id);
  const proofGit = createSealedGit({
    repoRoot: fs.realpathSync.native(repoRoot),
  });
  const candidateTree = proofGit.tree({ commit: candidateCommit });
  const baselineSnapshot = phaseProof.computeAuthoritySnapshot({
    registry,
    phaseId: phase.id,
    repoRoot,
    commit: phase.scopeBaseCommit,
  });
  const authoritySnapshot = phaseProof.computeAuthoritySnapshot({
    registry,
    phaseId: phase.id,
    repoRoot,
    commit: candidateCommit,
  });
  const changedPaths = [
    ...new Set(
      governance
        .parseGitNameStatus(
          proofGit.diff({
            from: phase.scopeBaseCommit,
            to: candidateCommit,
            format: "name-status-z-renames",
          }),
        )
        .flatMap((entry) => entry.paths),
    ),
  ].sort();
  const changedPathCoverage = phaseProof.classifyChangedPaths({
    registry,
    phaseId: phase.id,
    changedPaths,
  });
  const artifacts = new Map();
  const common = (observedAt) => ({
    phaseId: phase.id,
    registryRevision: registry.revision,
    registrySha256: governance.CANONICAL_REGISTRY_SHA256,
    ledgerRevision: ledger.revision,
    candidateCommit,
    candidateTree,
    observedAt,
    controller: proofIdentity("controller-alpha", "controller"),
    collector: proofIdentity("collector-beta", "collector"),
  });
  const candidateObservedAt = new Date(observedAtMs).toISOString();
  const candidate = {
    schema: "pikiio-phase-candidate-quality-receipt-v1",
    ...common(candidateObservedAt),
    status: "passed",
    previousReceiptHash: null,
    qualityIds: proofPhase.qualityIds,
    populations: {
      unitTests: Math.max(
        proofPhase.populationFloors.unitTests,
        qualityReceipt.metrics.testsPerRun,
      ),
      criticalMutants: Math.max(
        proofPhase.populationFloors.criticalMutants,
        qualityReceipt.metrics.minimumCriticalMutationPopulation,
      ),
      gherkinScenarios: Math.max(
        proofPhase.populationFloors.gherkinScenarios,
        qualityReceipt.metrics.minimumGherkinScenarioPopulation,
      ),
    },
    authorityBaselineCommit: phase.scopeBaseCommit,
    authorityBaselineSnapshotHash: baselineSnapshot.snapshotHash,
    authoritySnapshot,
    changedPaths,
    changedPathCoverage,
    assertions: proofAssertions(proofPhase, "candidate"),
  };
  candidate.rawArtifact = addPhaseProofArtifact(artifacts, {
    schema: "pikiio-candidate-quality-raw-artifact-v1",
    ...common(candidateObservedAt),
    authorityBaselineCommit: phase.scopeBaseCommit,
    authorityBaselineSnapshotHash: baselineSnapshot.snapshotHash,
    authoritySetSha256: authoritySnapshot.authoritySetSha256,
    changedPathCoverageSha256: changedPathCoverage.coverageSha256,
    qualityIds: proofPhase.qualityIds,
    populations: candidate.populations,
    assertions: candidate.assertions,
  });
  finishPhaseProofReceipt(candidate);
  const makeNotApplicableProductionReceipt = (
    kind,
    previousReceiptHash,
    at,
  ) =>
    finishPhaseProofReceipt({
      schema:
        kind === "rehearsal"
          ? "pikiio-phase-production-rehearsal-receipt-v1"
          : "pikiio-phase-production-change-receipt-v1",
      ...common(new Date(at).toISOString()),
      previousReceiptHash,
      disposition: "not_applicable",
      deploymentId: "none",
      reason: "phase policy forbids this production operation",
      rawArtifact: null,
    });
  const rehearsal = makeNotApplicableProductionReceipt(
    "rehearsal",
    candidate.receiptHash,
    observedAtMs + 1_000,
  );
  const change = makeNotApplicableProductionReceipt(
    "change",
    rehearsal.receiptHash,
    observedAtMs + 2_000,
  );
  const promotionObservedAt = new Date(observedAtMs + 3_000).toISOString();
  const promotion = {
    schema: "pikiio-phase-promotion-evidence-receipt-v1",
    ...common(promotionObservedAt),
    previousReceiptHash: change.receiptHash,
    disposition: "passed",
    deploymentId: "none",
    sourceCuts: [],
    sourceCutSetSha256: phaseProof.sourceCutSetSha256([]),
    assertions: proofAssertions(proofPhase),
    naturalEvidence: [],
    browserEvidence: [],
  };
  promotion.rawArtifact = addPhaseProofArtifact(artifacts, {
    schema: "pikiio-promotion-raw-artifact-v1",
    ...common(promotionObservedAt),
    deploymentId: "none",
    sourceCuts: [],
    sourceCutSetSha256: promotion.sourceCutSetSha256,
    naturalEvidenceReceiptHashes: [],
    browserEvidenceReceiptHashes: [],
    assertions: promotion.assertions,
  });
  finishPhaseProofReceipt(promotion);
  const chain = { candidate, rehearsal, change, promotion };
  for (const receipt of Object.values(chain)) {
    const unsigned = { ...receipt };
    delete unsigned.receiptHash;
    artifacts.set(
      `sha256:${receipt.receiptHash}`,
      Buffer.from(phaseProof.stableJson(unsigned), "utf8"),
    );
  }
  for (const judge of [
    qualityReceipt.primaryJudge,
    qualityReceipt.cleanJudge,
  ]) {
    artifacts.set(
      `sha256:${judge.rawArtifact.artifactSha256}`,
      fs.readFileSync(judge.rawArtifact.artifactPath),
    );
  }
  const bundle = {
    schema: "pikiio-phase-proof-bundle-v1",
    phaseId: phase.id,
    ledgerRevision: ledger.revision,
    candidateCommit,
    qualityReceiptHash: qualityReceipt.receiptHash,
    chain,
    artifacts: [...artifacts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([address, bytes]) => ({
        address,
        bytes: bytes.toString("base64"),
        encoding: "base64",
        sha256: address.slice("sha256:".length),
      })),
  };
  bundle.bundleHash = governance.sha256(governance.stableJson(bundle));
  return bundle;
}

function buildSyntheticExternalEnvelope(fixture) {
  const signingKeys = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const signingJwk = signingKeys.publicKey.export({ format: "jwk" });
  const kid = "pikiio-gherkin-envelope-key";
  const x5t = crypto
    .createHash("sha1")
    .update("pikiio-governance-gherkin-envelope")
    .digest("base64url");
  const jwksRegistry = {
    schema: oidcCollector.JWKS_REGISTRY_SCHEMA,
    revision: 1,
    issuer: oidcCollector.GITHUB_OIDC_ISSUER,
    keys: [{
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid,
      n: signingJwk.n,
      e: signingJwk.e,
      x5t,
    }],
    registrySha256: "0".repeat(64),
  };
  jwksRegistry.registrySha256 = oidcCollector.hashWithoutField(
    jwksRegistry,
    "registrySha256",
  );
  const authorityRegistry = {
    schema: phaseProofEnvelope.ATTESTATION_AUTHORITY_SCHEMA,
    revision: 1,
    mode: "external_collector_required",
    bodySchema: phaseAttestation.ATTESTATION_BODY_SCHEMA,
    controller: {
      kind: "local_content_addressed_evidence",
      cryptographicSignature: "optional_non_authorizing",
      localCollectorPrivateKeyAllowed: false,
    },
    collector: {
      kind: "github_actions_oidc",
      issuer: oidcCollector.GITHUB_OIDC_ISSUER,
      repository: oidcCollector.EXPECTED_REPOSITORY,
      repositoryVisibility:
        oidcCollector.EXPECTED_REPOSITORY_VISIBILITY,
      runnerEnvironment: oidcCollector.EXPECTED_RUNNER_ENVIRONMENT,
      workflowPath: oidcCollector.REUSABLE_WORKFLOW_PATH,
      workflowRef: oidcCollector.REUSABLE_WORKFLOW_REF,
      jwksRegistryPath:
        "YLYI/00_Product_Contract/Pikiio_GitHub_OIDC_JWKS.json",
      jwksRegistrySha256: jwksRegistry.registrySha256,
    },
    authoritySha256: "0".repeat(64),
  };
  authorityRegistry.authoritySha256 = governance.sha256(
    governance.stableJson(
      Object.fromEntries(
        Object.entries(authorityRegistry).filter(
          ([key]) => key !== "authoritySha256",
        ),
      ),
    ),
  );
  const core = fixture.phaseProofBundle;
  const candidateReceipt = core.chain.candidate;
  const receiptHashes = Object.fromEntries(
    Object.entries(core.chain).map(([role, receipt]) => [
      role,
      receipt.receiptHash,
    ]),
  );
  const expected = {
    phaseId: core.phaseId,
    scopeBaseCommit: fixture.before.phases.find(
      (phase) => phase.id === "GOV-00",
    ).scopeBaseCommit,
    candidateCommit: core.candidateCommit,
    candidateTree: fixture.qualityReceipt.candidateTree,
    ledgerRevision: fixture.before.revision,
    ledgerSha256: governance.sha256(
      governance.stableJson(fixture.before),
    ),
    phaseProofRegistrySha256: governance.CANONICAL_REGISTRY_SHA256,
    strictQualityReceiptHash: fixture.qualityReceipt.receiptHash,
    coreBundleHash: core.bundleHash,
  };
  const attestationBody =
    oidcCollector.reconstructAttestationBodyFromProofInputs({
      schema: oidcCollector.COLLECTOR_PROOF_INPUT_SCHEMA,
      phase: {
        phaseId: expected.phaseId,
        issuerRegistrySha256: authorityRegistry.authoritySha256,
        ledgerRevision: expected.ledgerRevision,
        ledgerSha256: expected.ledgerSha256,
      },
      candidate: {
        commit: expected.candidateCommit,
        tree: expected.candidateTree,
      },
      quality: {
        strictReceiptHash: expected.strictQualityReceiptHash,
        commandPlanHash: fixture.qualityReceipt.commandPlanSha256,
        primaryRawArtifactHash:
          fixture.qualityReceipt.primaryJudge.rawArtifact.artifactSha256,
        independentRawArtifactHash:
          fixture.qualityReceipt.cleanJudge.rawArtifact.artifactSha256,
      },
      receiptHashes,
    });
  const issuedAt = Math.floor(
    Date.parse("2026-07-24T08:05:00.000Z") / 1000,
  );
  const ref = "refs/heads/codex/proof-candidate";
  const jti = "123e4567-e89b-42d3-a456-426614174038";
  const payload = {
    actor: "demo-maintainer",
    actor_id: "12345",
    aud: oidcCollector.expectedAudience(
      governance.sha256(governance.stableJson(attestationBody)),
    ),
    base_ref: "",
    check_run_id: "90038",
    event_name: "workflow_call",
    exp: issuedAt + 600,
    head_ref: "",
    iat: issuedAt,
    iss: oidcCollector.GITHUB_OIDC_ISSUER,
    job_workflow_ref: oidcCollector.expectedReusableWorkflowRef(),
    job_workflow_sha: expected.scopeBaseCommit,
    jti,
    nbf: issuedAt - 60,
    ref,
    ref_protected: "true",
    ref_type: "branch",
    repository: oidcCollector.EXPECTED_REPOSITORY,
    repository_id: "123456789",
    repository_owner: oidcCollector.EXPECTED_REPOSITORY_OWNER,
    repository_owner_id: "12345",
    repository_visibility:
      oidcCollector.EXPECTED_REPOSITORY_VISIBILITY,
    run_attempt: "1",
    run_id: "80038",
    run_number: "38",
    runner_environment: oidcCollector.EXPECTED_RUNNER_ENVIRONMENT,
    sha: expected.candidateCommit,
    sub: `repo:${oidcCollector.EXPECTED_REPOSITORY}:ref:${ref}`,
    workflow: "Pikiio proof caller",
    workflow_ref:
      `${oidcCollector.EXPECTED_REPOSITORY}/.github/workflows/` +
      `pikiio-proof-request.yml@${ref}`,
    workflow_sha: expected.candidateCommit,
  };
  const header = {
    alg: "RS256",
    kid,
    typ: "JWT",
    x5t,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), signingKeys.privateKey)
    .toString("base64url");
  const oidcToken = `${signingInput}.${signature}`;
  const requestedAt = new Date(issuedAt * 1000).toISOString();
  const receivedAt = new Date((issuedAt + 1) * 1000).toISOString();
  const collectorReceipt = oidcCollector.buildGithubOidcCollectorReceipt({
    body: attestationBody,
    scopeBaseCommit: expected.scopeBaseCommit,
    jwksRegistrySha256: jwksRegistry.registrySha256,
    oidcToken,
    requestedAt,
    receivedAt,
  });
  const collectorBytes = Buffer.from(
    governance.stableJson(collectorReceipt),
    "utf8",
  );
  const replayKey = `${oidcCollector.GITHUB_OIDC_ISSUER}:${jti}`;
  const externalCertification = {
    schema: phaseProofEnvelope.FROZEN_CERTIFICATION_SCHEMA,
    phaseId: expected.phaseId,
    scopeBaseCommit: expected.scopeBaseCommit,
    candidateCommit: expected.candidateCommit,
    candidateTree: expected.candidateTree,
    ledgerRevision: expected.ledgerRevision,
    ledgerSha256: expected.ledgerSha256,
    phaseProofRegistrySha256: expected.phaseProofRegistrySha256,
    attestationAuthoritySha256: authorityRegistry.authoritySha256,
    jwksRegistrySha256: jwksRegistry.registrySha256,
    baselineAuthoritySnapshotHash:
      candidateReceipt.authorityBaselineSnapshotHash,
    candidateAuthoritySnapshotHash:
      candidateReceipt.authoritySnapshot.snapshotHash,
    authoritySetSha256:
      candidateReceipt.authoritySnapshot.authoritySetSha256,
    strictQualityReceiptHash: expected.strictQualityReceiptHash,
    phaseProofBundleHash: core.bundleHash,
    receiptHashes,
    attestationBody,
    attestationBodySha256: governance.sha256(
      governance.stableJson(attestationBody),
    ),
    githubRun: {
      schema: phaseProofEnvelope.GITHUB_RUN_SCHEMA,
      eventName: "workflow_call",
      runId: "80038",
      runNumber: "38",
      runAttempt: "1",
      checkRunId: "90038",
      repository: oidcCollector.EXPECTED_REPOSITORY,
      runnerEnvironment: oidcCollector.EXPECTED_RUNNER_ENVIRONMENT,
      githubSha: expected.candidateCommit,
    },
    collectorEvidence: {
      schema: phaseProofEnvelope.COLLECTOR_EVIDENCE_SCHEMA,
      encoding: "base64",
      byteLength: collectorBytes.length,
      rawSha256: governance.sha256(collectorBytes),
      bytes: collectorBytes.toString("base64"),
      receiptHash: collectorReceipt.receiptHash,
    },
    replayProtection: {
      schema: phaseProofEnvelope.REPLAY_PROTECTION_SCHEMA,
      replayKey,
      replayKeySha256: governance.sha256(replayKey),
      consumptionScope: "single-controller-local-runtime",
      multiHostSafe: false,
    },
    verifiedAt: receivedAt,
    certificationHash: "0".repeat(64),
  };
  const unsignedCertification = { ...externalCertification };
  delete unsignedCertification.certificationHash;
  externalCertification.certificationHash = governance.sha256(
    governance.stableJson(unsignedCertification),
  );
  return {
    authorityRegistry,
    expected,
    externalCertification,
    jwksRegistry,
    nowMs: (issuedAt + 2) * 1000,
    envelope: phaseProofEnvelope.assemblePhaseProofEnvelope({
      proofBundle: core,
      externalCertification,
    }),
  };
}

function transitionRecoveryFixture(options = {}) {
  const repoRoot = tempDirectory("pikiio-gherkin-transition-recovery-");
  const ledgerPath = path.join(repoRoot, governance.PHASE_LEDGER_RELATIVE_PATH);
  const journalPath = path.join(repoRoot, "transition-journal.json");
  const completionPath =
    `YLYI/09_Proof_Receipts/phase-completions/${"1".repeat(64)}.json`;
  const bundlePath =
    `YLYI/09_Proof_Receipts/phase-proofs/${"2".repeat(64)}.json`;
  const before = { revision: 1, activePhaseId: "GOV-00" };
  const after = { revision: 2, activePhaseId: "TRUTH-01" };
  const actual = options.divergent
    ? { revision: 99, activePhaseId: "DIVERGED" }
    : before;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(actual, null, 2)}\n`);
  const completionBytes = Buffer.from('{"completion":"exact"}\n');
  const bundleBytes = Buffer.from('{"bundle":"exact"}\n');
  for (const [relativePath, bytes] of [
    [
      completionPath,
      options.tamperCompletion
        ? Buffer.from('{"completion":"evil!"}\n')
        : completionBytes,
    ],
    [bundlePath, bundleBytes],
  ]) {
    const target = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const body = {
    schema: "pikiio-phase-transition-journal-v1",
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    recordedAt: "2026-07-24T08:00:00.000Z",
    ledgerPath: governance.PHASE_LEDGER_RELATIVE_PATH,
    beforeLedgerSha256: governance.sha256(governance.stableJson(before)),
    afterLedgerSha256: governance.sha256(governance.stableJson(after)),
    completion: {
      path: completionPath,
      bytesSha256: governance.sha256(completionBytes),
      preexisting: options.preexisting === true,
    },
    bundle: {
      path: bundlePath,
      bytesSha256: governance.sha256(bundleBytes),
      preexisting: options.preexisting === true,
    },
  };
  const journal = {
    ...body,
    journalHash: governance.sha256(governance.stableJson(body)),
  };
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return {
    repoRoot,
    journalPath,
    completionPath: path.join(repoRoot, completionPath),
    bundlePath: path.join(repoRoot, bundlePath),
    cleanup() {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

function activationFixture() {
  const repoRoot = tempDirectory("pikiio-gherkin-activation-");
  const runtime = tempDirectory("pikiio-gherkin-activation-runtime-");
  trustedFixtureGit(repoRoot, ["init", "-b", LEDGER.baseline.branch]);
  for (const relativePath of governanceAuthorityFiles()) {
    const destination = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), destination);
  }
  fs.writeFileSync(path.join(repoRoot, "bootstrap.txt"), "bootstrap\n");
  trustedFixtureGit(repoRoot, ["add", "."]);
  trustedFixtureGit(repoRoot, ["commit", "-m", "bootstrap"]);
  const base = governance.currentHead(repoRoot);
  const before = clone(LEDGER);
  before.baseline.startCommit = base;
  before.baseline.preExistingDirty = [];
  before.automationContract =
    governance.expectedHeartbeatAutomationContract(before.codexGoal.threadId);
  const governancePhase = governance.selectActivePhase(before);
  governancePhase.scopeBaseCommit = base;
  const ledgerPath = path.join(
    repoRoot,
    governance.PHASE_LEDGER_RELATIVE_PATH,
  );
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(before, null, 2)}\n`);
  trustedFixtureGit(repoRoot, ["add", "."]);
  trustedFixtureGit(repoRoot, ["commit", "-m", "candidate"]);
  const candidate = governance.currentHead(repoRoot);
  const candidateTree = trustedFixtureGit(
    repoRoot,
    ["rev-parse", `${candidate}^{tree}`],
    { encoding: "utf8" },
  ).trim();
  const sliceChangedPaths = [governance.PHASE_LEDGER_RELATIVE_PATH];
  const sliceDiffSha256 = governance.sha256(
    createSealedGit({ repoRoot }).diff({
      from: base,
      to: candidate,
      format: "binary",
    }),
  );
  const qualityArtifactDirectory = path.join(
    fs.realpathSync(runtime),
    "quality-artifacts",
  );
  let qualityReceipt = {
    ...minimalQualityReceipt(
      before,
      governancePhase,
      candidate,
      governance.cleanWorkspaceEvidenceDigest(),
      { candidateTree, sliceChangedPaths, sliceDiffSha256 },
    ),
    schema: "pikiio-quality-gauntlet-receipt-v5",
  };
  const embedded = embedRawQualityEvidence(
    qualityReceipt,
    qualityArtifactDirectory,
  );
  fs.mkdirSync(qualityArtifactDirectory, { recursive: true });
  for (const [address, bytes] of embedded.rawArtifactBytes) {
    fs.writeFileSync(
      path.join(qualityArtifactDirectory, `${address.slice(7)}.json`),
      bytes,
    );
  }
  qualityReceipt = governance.writeQualityReceipt(embedded.receipt, {
    receiptPath: path.join(runtime, "quality.json"),
  });
  const phaseProofBundle = buildGovernancePhaseProofBundle({
    ledger: before,
    phase: governancePhase,
    qualityReceipt,
    repoRoot,
    candidateCommit: candidate,
    observedAtMs: Date.parse("2026-07-24T07:59:50.000Z"),
  });
  const syntheticExternalProof = buildSyntheticExternalEnvelope({
    before,
    phaseProofBundle,
    qualityReceipt,
  });
  const phaseProofEnvelopeValue = syntheticExternalProof.envelope;
  const externalProofValidator = ({ envelope, expected }) =>
    phaseProofEnvelope.validatePhaseProofEnvelope({
      envelope,
      authorityRegistry: syntheticExternalProof.authorityRegistry,
      expectedAuthoritySha256:
        syntheticExternalProof.authorityRegistry.authoritySha256,
      jwksRegistry: syntheticExternalProof.jwksRegistry,
      expectedJwksRegistrySha256:
        syntheticExternalProof.jwksRegistry.registrySha256,
      expected,
      nowMs: syntheticExternalProof.nowMs,
    });
  const ledger = clone(before);
  ledger.revision += 1;
  ledger.activePhaseId = "TRUTH-01";
  const completed = ledger.phases.find((phase) => phase.id === "GOV-00");
  const phase = ledger.phases.find((candidatePhase) =>
    candidatePhase.id === "TRUTH-01"
  );
  const qualityReceiptPath =
    `YLYI/09_Proof_Receipts/phase-completions/${qualityReceipt.receiptHash}.json`;
  completed.status = "complete";
  completed.lastResult = {
    schema: "pikiio-phase-completion-v3",
    result: "passed",
    head: candidate,
    qualityReceiptHash: qualityReceipt.receiptHash,
    qualityReceiptPath,
    phaseProofBundleHash: phaseProofBundle.bundleHash,
    phaseProofEnvelopeHash: phaseProofEnvelopeValue.envelopeHash,
    externalCertificationHash:
      phaseProofEnvelopeValue.externalCertification.certificationHash,
    phaseProofBundlePath: governance.phaseProofBundleRelativePath(
      phaseProofEnvelopeValue.envelopeHash,
    ),
    phaseProofReceiptHashes: Object.fromEntries(
      Object.entries(phaseProofBundle.chain).map(([role, receipt]) => [
        role,
        receipt.receiptHash,
      ]),
    ),
    completedAt: phaseProofBundle.chain.promotion.observedAt,
  };
  phase.status = "active";
  phase.scopeBaseCommit = candidate;
  fs.mkdirSync(path.dirname(path.join(repoRoot, qualityReceiptPath)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repoRoot, qualityReceiptPath),
    `${JSON.stringify(qualityReceipt, null, 2)}\n`,
  );
  fs.mkdirSync(
    path.dirname(path.join(repoRoot, completed.lastResult.phaseProofBundlePath)),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(repoRoot, completed.lastResult.phaseProofBundlePath),
    `${JSON.stringify(phaseProofEnvelopeValue, null, 2)}\n`,
  );
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  trustedFixtureGit(repoRoot, ["add", "."]);
  trustedFixtureGit(repoRoot, ["commit", "-m", "transition"]);
  const head = governance.currentHead(repoRoot);
  const receipt = signReceipt({
    schema: "pikiio-heartbeat-activation-receipt-v3",
    recordedAt: "2026-07-24T08:00:00.000Z",
    expiresAt: "2026-07-31T08:00:00.000Z",
    ledgerRevision: ledger.revision,
    ledgerSha256: governance.sha256(governance.stableJson(ledger)),
    phaseId: phase.id,
    transitionCommit: head,
    transitionParent: candidate,
    qualityReceiptHash: qualityReceipt.receiptHash,
    hostDurability: readyHostReceipt(),
    automationContractSha256: governance.sha256(
      governance.stableJson(ledger.automationContract),
    ),
    issuerRunId: "gherkin-activation",
    issuerLeaseFence: 1,
  });
  return {
    repoRoot,
    before,
    candidate,
    ledger,
    phase,
    head,
    qualityReceipt,
    phaseProofBundle,
    phaseProofEnvelope: phaseProofEnvelopeValue,
    externalProofValidator,
    receipt,
    nowMs: Date.parse("2026-07-24T08:30:00.000Z"),
    localHost: "operator-mac",
    cleanup() {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function safetyConfirmations() {
  return Object.fromEntries(
    governance.REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS.map((effect) => [
      effect,
      { preserved: true, evidence: "negative boundary probe passed" },
    ]),
  );
}

function proof(status = "not_applicable") {
  return status === "passed"
    ? { status, receipts: [{ receiptHash: "a".repeat(64) }] }
    : { status, receipts: [], reason: "not exercised in governance scenario" };
}

function receiptFixture() {
  const temp = tempDirectory("pikiio-gherkin-receipt-");
  const runtime = tempDirectory("pikiio-gherkin-receipt-runtime-");
  trustedFixtureGit(temp, ["init", "-b", LEDGER.baseline.branch]);
  fs.writeFileSync(path.join(temp, "x"), "x\n");
  trustedFixtureGit(temp, ["add", "x"]);
  trustedFixtureGit(temp, ["commit", "-m", "fixture"]);
  const head = governance.currentHead(temp);
  const ledger = clone(LEDGER);
  ledger.baseline.startCommit = head;
  ledger.baseline.preExistingDirty = [];
  ledger.phases[0].scopeBaseCommit = head;
  const phase = governance.selectActivePhase(ledger);
  const leasePath = path.join(runtime, "lease.json");
  const fencePath = path.join(runtime, "fence.json");
  const receiptPath = path.join(runtime, "receipts.jsonl");
  const qualityReceiptPath = path.join(runtime, "quality.json");
  // Bind the fixture to the canonical directory path used by the runtime's
  // no-escape check. On macOS os.tmpdir() may traverse /var -> /private/var;
  // persisting the unresolved alias would correctly fail that exact-path
  // boundary even though the bytes live in the intended directory.
  const qualityArtifactDirectory = path.join(
    fs.realpathSync(runtime),
    "quality-artifacts",
  );
  const receiptNow = "2026-07-24T04:35:00.000Z";
  const capability = "a".repeat(64);
  const lease = governance.acquireWriterLease({
    runId: "gherkin-receipt",
    automationId: "gherkin",
    goalId: ledger.codexGoal.objectiveSha256,
    phaseId: phase.id,
    lane: phase.lane,
    branch: ledger.baseline.branch,
    startHead: head,
    allowedPaths: phase.allowedPaths,
    capability,
    leasePath,
    fencePath,
    morningReceiptDir: path.join(runtime, "morning"),
    nowMs: fixedNewYorkEpoch(0, 30),
    leaseMs: 10 * 60 * 1000,
  });
  const workspaceDigest = governance.workspaceEvidenceDigest(temp);
  const candidateTree = trustedFixtureGit(
    temp,
    ["rev-parse", `${head}^{tree}`],
    { encoding: "utf8" },
  ).trim();
  let qualityReceipt = minimalQualityReceipt(
    ledger,
    phase,
    head,
    workspaceDigest,
    { candidateTree },
  );
  qualityReceipt.schema = "pikiio-quality-gauntlet-receipt-v5";
  qualityReceipt = signReceipt(qualityReceipt);
  const embedded = embedRawQualityEvidence(
    qualityReceipt,
    qualityArtifactDirectory,
  );
  fs.mkdirSync(qualityArtifactDirectory, { recursive: true });
  for (const [address, bytes] of embedded.rawArtifactBytes) {
    fs.writeFileSync(
      path.join(qualityArtifactDirectory, `${address.slice(7)}.json`),
      bytes,
    );
  }
  governance.writeQualityReceipt(
    embedded.receipt,
    { receiptPath: qualityReceiptPath },
  );
  const input = {
    commands: ["node tests"],
    changedPaths: [],
    localProof: [{ name: "governance", status: "passed" }],
    productionProof: proof(),
    sourceCutProof: proof(),
    migrationProof: proof(),
    deploymentProof: proof(),
    browserProof: proof(),
    modelCostDeltaUsd: 0,
    safetyConfirmations: safetyConfirmations(),
    result: "completed",
    nextAction: "continue only after receipt verification",
  };
  return {
    temp,
    head,
    ledger,
    phase,
    leasePath,
    receiptPath,
    qualityReceiptPath,
    qualityArtifactDirectory,
    capability,
    lease,
    receiptNow,
    input,
    cleanup() {
      try {
        governance.releaseWriterLease(lease, { capability, leasePath });
      } catch {
        // The chain-tamper scenario may intentionally leave receipt state broken only.
      }
      fs.rmSync(temp, { recursive: true, force: true });
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };
}

const definitions = {
  "Missing controller goal is refused": {
    steps: [
      "Given the canonical Pikiio phase ledger",
      "When no controller goal objective or task ID is supplied",
      "Then the goal guard returns CODEX_GOAL_REQUIRED",
    ],
    execute() {
      const result = governance.evaluateGoalGuard({
        ledger: LEDGER,
        repoRoot: ROOT,
      });
      assert.equal(result.code, "CODEX_GOAL_REQUIRED");
    },
  },
  "A mismatched controller goal is refused": {
    steps: [
      "Given the canonical Pikiio phase ledger",
      "When the controller goal objective differs from the ledger",
      "Then the goal guard returns CODEX_GOAL_MISMATCH",
    ],
    execute() {
      const result = governance.evaluateGoalGuard({
        ledger: LEDGER,
        repoRoot: ROOT,
        goalObjective: "wrong",
        goalThreadId: LEDGER.codexGoal.threadId,
      });
      assert.equal(result.code, "CODEX_GOAL_MISMATCH");
    },
  },
  "Unsafe policy mutation is refused": {
    steps: [
      "Given the canonical immutable safety policy",
      "When oneWriter is false or Gmail send is removed",
      "Then phase ledger validation fails",
    ],
    execute() {
      for (const mutate of [
        (ledger) => {
          ledger.policy.oneWriter = false;
        },
        (ledger) => {
          ledger.policy.forbiddenExternalEffects.shift();
        },
      ]) {
        const ledger = clone(LEDGER);
        mutate(ledger);
        assert.equal(governance.validatePhaseLedger(ledger).valid, false);
      }
    },
  },
  "Two active phases are refused": {
    steps: [
      "Given the canonical Pikiio phase ledger",
      "When a second phase is marked active",
      "Then phase ledger validation fails",
    ],
    execute() {
      const ledger = clone(LEDGER);
      ledger.phases[1].status = "active";
      ledger.phases[1].scopeBaseCommit = ledger.phases[0].scopeBaseCommit;
      ledger.phases[1].qualityPlan = clone(ledger.phases[0].qualityPlan);
      assert.equal(governance.validatePhaseLedger(ledger).valid, false);
    },
  },
  "A rename from a forbidden path is refused": {
    steps: [
      "Given the active phase allows a governance destination",
      "When an operational send path is renamed into that destination",
      "Then the dirty guard checks both rename paths and refuses",
    ],
    execute() {
      const ledger = clone(LEDGER);
      ledger.baseline.preExistingDirty = [];
      const result = governance.evaluateDirtyGuard({
        ledger,
        phase: ledger.phases[0],
        repoRoot: ROOT,
        statusOutput:
          "R  api/actions/send.js -> lib/pikiio-agent-governance.js\n",
        committedOutput: "",
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.blocked[0].paths, [
        "api/actions/send.js",
        "lib/pikiio-agent-governance.js",
      ]);
    },
  },
  "A committed forbidden path is refused": {
    steps: [
      "Given the active phase has a committed scope base",
      "When committed history changes an operational send path",
      "Then the dirty guard refuses the committed delta",
    ],
    execute() {
      const ledger = clone(LEDGER);
      ledger.baseline.preExistingDirty = [];
      const result = governance.evaluateDirtyGuard({
        ledger,
        phase: ledger.phases[0],
        repoRoot: ROOT,
        statusOutput: "",
        committedOutput: "M\tapi/actions/send.js\n",
      });
      assert.equal(result.ok, false);
      assert.equal(result.committed.blocked[0].path, "api/actions/send.js");
    },
  },
  "A changed pinned evidence tree is refused": {
    steps: [
      "Given a digest-pinned pre-existing evidence tree",
      "When one byte of its content changes",
      "Then the dirty guard refuses write authority",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-pinned-");
      try {
        fs.mkdirSync(path.join(temp, "evidence"));
        fs.writeFileSync(path.join(temp, "evidence", "receipt"), "before");
        const expected = governance.digestTree(temp, "evidence");
        const ledger = clone(LEDGER);
        ledger.baseline.preExistingDirty = [{
          path: "evidence/",
          algorithm: expected.algorithm,
          treeDigest: expected.treeDigest,
          fileCount: expected.fileCount,
          preserve: true,
          excludeFromGit: true,
          excludeFromDeploy: true,
        }];
        fs.writeFileSync(path.join(temp, "evidence", "receipt"), "after");
        const result = governance.evaluateDirtyGuard({
          ledger,
          phase: ledger.phases[0],
          repoRoot: temp,
          statusOutput: "",
          committedOutput: "",
        });
        assert.equal(result.ok, false);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "A live writer capability cannot be guessed": {
    steps: [
      "Given a writer lease protected by a random capability",
      "When another client presents only its public run ID",
      "Then renew and release are refused",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-capability-");
      const leasePath = path.join(temp, "lease.json");
      const fencePath = path.join(temp, "fence.json");
      const capability = "a".repeat(64);
      try {
        const lease = governance.acquireWriterLease({
          runId: "public-run-id",
          goalId: LEDGER.codexGoal.objectiveSha256,
          phaseId: "GOV-00",
          lane: "morning-refresh",
          capability,
          leasePath,
          fencePath,
          leaseMs: 10_000,
        });
        assert.throws(
          () => governance.renewWriterLease(lease, {
            capability: "b".repeat(64),
            leasePath,
            leaseMs: 10_000,
          }),
          (error) => error.code === "WRITER_LEASE_LOST",
        );
        assert.throws(
          () => governance.releaseWriterLease(lease, {
            capability: "b".repeat(64),
            leasePath,
          }),
          (error) => error.code === "WRITER_LEASE_LOST",
        );
        governance.releaseWriterLease(lease, { capability, leasePath });
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "A live expired writer lease cannot be stolen": {
    steps: [
      "Given a same-host writer lease whose holder PID is alive",
      "When another run tries to acquire it after its expiry timestamp",
      "Then the second run remains read-only",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-live-lease-");
      const leasePath = path.join(temp, "lease.json");
      const fencePath = path.join(temp, "fence.json");
      const firstCapability = "a".repeat(64);
      try {
        const first = governance.acquireWriterLease({
          runId: "one",
          goalId: LEDGER.codexGoal.objectiveSha256,
          phaseId: "GOV-00",
          lane: "morning-refresh",
          capability: firstCapability,
          leasePath,
          fencePath,
          host: "same-host",
          ownerPid: 101,
          nowMs: 1_000,
          leaseMs: 1_000,
          isPidAlive: () => true,
        });
        assert.throws(
          () => governance.acquireWriterLease({
            runId: "two",
            goalId: LEDGER.codexGoal.objectiveSha256,
            phaseId: "GOV-00",
            lane: "morning-refresh",
            capability: "b".repeat(64),
            leasePath,
            fencePath,
            host: "same-host",
            ownerPid: 202,
            nowMs: 5_000,
            leaseMs: 1_000,
            isPidAlive: () => true,
          }),
          (error) => error.code === "WRITER_LEASE_BUSY",
        );
        governance.releaseWriterLease(first, {
          capability: firstCapability,
          leasePath,
        });
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "A dead expired local lease can be reclaimed": {
    steps: [
      "Given a same-host writer lease whose holder PID is dead",
      "When another run acquires it after expiry under serialization",
      "Then the fence increments and the stale receipt is preserved",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-dead-lease-");
      const leasePath = path.join(temp, "lease.json");
      const fencePath = path.join(temp, "fence.json");
      try {
        const first = governance.acquireWriterLease({
          runId: "one",
          goalId: LEDGER.codexGoal.objectiveSha256,
          phaseId: "GOV-00",
          lane: "morning-refresh",
          capability: "a".repeat(64),
          leasePath,
          fencePath,
          host: "same-host",
          ownerPid: 101,
          nowMs: 1_000,
          leaseMs: 1_000,
          isPidAlive: () => false,
        });
        const second = governance.acquireWriterLease({
          runId: "two",
          goalId: LEDGER.codexGoal.objectiveSha256,
          phaseId: "GOV-00",
          lane: "morning-refresh",
          capability: "b".repeat(64),
          leasePath,
          fencePath,
          host: "same-host",
          ownerPid: 202,
          nowMs: 5_000,
          leaseMs: 1_000,
          isPidAlive: () => false,
        });
        assert.equal(second.fence, first.fence + 1);
        assert.equal(
          fs.readdirSync(temp).some((name) =>
            name.startsWith("lease.json.stale-fence-"),
          ),
          true,
        );
        governance.releaseWriterLease(second, {
          capability: "b".repeat(64),
          leasePath,
        });
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "Morning priority begins exactly at 05:45 New York": {
    steps: [
      "Given no valid terminal receipt for the New York service date",
      "When a builder requests a lease at 05:45:00",
      "Then lease admission returns MORNING_PRIORITY_WINDOW_ACTIVE",
    ],
    execute() {
      const result = governance.evaluateMorningPriority({
        lane: "autonomy-governance",
        requestedLeaseMs: 60_000,
        nowMs: fixedNewYorkEpoch(5, 45),
        morningReceiptDir: tempDirectory("pikiio-gherkin-no-receipt-"),
      });
      assert.equal(result.allowed, false);
      assert.equal(result.code, "MORNING_PRIORITY_WINDOW_ACTIVE");
      fs.rmSync(result.terminalReceipt.receiptDirectory, {
        recursive: true,
        force: true,
      });
    },
  },
  "A builder lease cannot cross the morning boundary": {
    steps: [
      "Given a builder requests a lease before the New York morning boundary",
      "When its requested expiry crosses 05:45",
      "Then its expiry is capped at the boundary",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-cap-");
      try {
        const nowMs = fixedNewYorkEpoch(5, 0);
        const result = governance.evaluateMorningPriority({
          lane: "autonomy-governance",
          requestedLeaseMs: 2 * 60 * 60 * 1000,
          nowMs,
          morningReceiptDir: temp,
        });
        assert.equal(result.allowed, true);
        assert.equal(result.leaseMs, 45 * 60 * 1000);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "A tampered morning receipt does not end priority": {
    steps: [
      "Given a morning terminal receipt with a mismatched hash",
      "When builder admission checks the service date",
      "Then morning priority remains active",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-tampered-morning-");
      try {
        const nowMs = fixedNewYorkEpoch(6, 0);
        const dateKey = governance.zonedParts(
          nowMs,
          "America/New_York",
        ).dateKey;
        const directory = governance.morningReceiptPathForDate(dateKey, temp);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "tampered.json"), JSON.stringify({
          schema: "pikiio-morning-terminal-receipt-v1",
          dateKey,
          timeZone: "America/New_York",
          terminal: true,
          result: "succeeded",
          finishedAt: new Date(nowMs).toISOString(),
          receiptHash: "0".repeat(64),
        }));
        const result = governance.evaluateMorningPriority({
          lane: "autonomy-governance",
          requestedLeaseMs: 60_000,
          nowMs,
          morningReceiptDir: temp,
        });
        assert.equal(result.allowed, false);
        assert.equal(result.code, "MORNING_PRIORITY_WINDOW_ACTIVE");
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "A future morning receipt does not end priority": {
    steps: [
      "Given a correctly hashed morning receipt dated after the current time",
      "When builder admission checks the service date",
      "Then morning priority remains active",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-future-morning-");
      try {
        const nowMs = fixedNewYorkEpoch(6, 0);
        const dateKey = "2026-07-24";
        const directory = governance.morningReceiptPathForDate(dateKey, temp);
        fs.mkdirSync(directory, { recursive: true });
        const receipt = signReceipt({
          schema: "pikiio-morning-terminal-receipt-v1",
          dateKey,
          timeZone: "America/New_York",
          terminal: true,
          runId: "future",
          leaseFence: 1,
          result: "succeeded",
          truthPublished: true,
          startedAt: new Date(nowMs - 60_000).toISOString(),
          finishedAt: new Date(nowMs + 60_000).toISOString(),
          detail: "future-dated receipt",
        });
        fs.writeFileSync(
          path.join(directory, "future.json"),
          `${JSON.stringify(receipt)}\n`,
        );
        const result = governance.evaluateMorningPriority({
          lane: "autonomy-governance",
          requestedLeaseMs: 60_000,
          nowMs,
          morningReceiptDir: temp,
        });
        assert.equal(result.code, "MORNING_PRIORITY_WINDOW_ACTIVE");
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "Caller lease metadata cannot forge persisted scope": {
    steps: [
      "Given a capability-bound persisted writer lease",
      "When the caller changes only its phase metadata",
      "Then receipt append returns WRITER_LEASE_LOST",
    ],
    execute() {
      const fixture = receiptFixture();
      try {
        assert.throws(
          () => governance.appendRunReceipt(fixture.input, {
            ledger: fixture.ledger,
            lease: { ...fixture.lease, phaseId: "TRUTH-01" },
            capability: fixture.capability,
            repoRoot: fixture.temp,
            leasePath: fixture.leasePath,
            receiptPath: fixture.receiptPath,
            qualityReceiptPath: fixture.qualityReceiptPath,
            qualityArtifactDirectory: fixture.qualityArtifactDirectory,
            now: fixture.receiptNow,
          }),
          (error) => error.code === "WRITER_LEASE_LOST",
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "An expired lease cannot authorize a run receipt": {
    steps: [
      "Given a capability-bound writer lease past its expiry",
      "When a run receipt is appended",
      "Then receipt append returns WRITER_LEASE_EXPIRED",
    ],
    execute() {
      const fixture = receiptFixture();
      try {
        assert.throws(
          () => governance.appendRunReceipt(fixture.input, {
            ledger: fixture.ledger,
            lease: fixture.lease,
            capability: fixture.capability,
            repoRoot: fixture.temp,
            leasePath: fixture.leasePath,
            receiptPath: fixture.receiptPath,
            qualityReceiptPath: fixture.qualityReceiptPath,
            qualityArtifactDirectory: fixture.qualityArtifactDirectory,
            now: "2026-07-24T04:41:00.000Z",
          }),
          (error) => error.code === "WRITER_LEASE_EXPIRED",
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "Signed quality evidence below threshold is refused": {
    steps: [
      "Given a correctly hashed quality receipt",
      "When its measured line coverage is below the active profile",
      "Then quality receipt validation fails",
    ],
    execute() {
      const phase = governance.selectActivePhase(LEDGER);
      let receipt = {
        ...minimalQualityReceipt(
          LEDGER,
          phase,
          "a".repeat(40),
          "b".repeat(64),
        ),
        schema: "pikiio-quality-gauntlet-receipt-v5",
      };
      receipt.metrics.minimumObservedCoverage.lines = 0;
      receipt = signReceipt(receipt);
      assert.equal(
        governance.validateQualityReceipt(receipt, {
          ledger: LEDGER,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid,
        false,
      );
    },
  },
  "Asynchronous work cannot use the synchronous operation lock": {
    steps: [
      "Given the serialized synchronous operation lock",
      "When its callback returns a Promise",
      "Then the lock returns ASYNC_OPERATION_LOCK_CALLBACK_REFUSED",
    ],
    execute() {
      const temp = tempDirectory("pikiio-gherkin-operation-");
      try {
        assert.throws(
          () => governance.withOperationLock(
            path.join(temp, "operation.lock"),
            () => Promise.resolve(),
          ),
          (error) =>
            error.code === "ASYNC_OPERATION_LOCK_CALLBACK_REFUSED",
        );
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  "Production mutation requires the sole wrapper": {
    steps: [
      "Given the governance phase has production authority disabled",
      "When a direct production action is requested from the goal guard",
      "Then the request returns PRODUCTION_WRAPPER_REQUIRED",
    ],
    execute() {
      const result = governance.evaluateGoalGuard({
        ledger: LEDGER,
        repoRoot: ROOT,
        goalObjective: LEDGER.codexGoal.objective,
        goalThreadId: LEDGER.codexGoal.threadId,
        productionAction: "migrate",
      });
      assert.equal(result.code, "PRODUCTION_WRAPPER_REQUIRED");
    },
  },
  "Run receipt callers cannot forge authority fields": {
    steps: [
      "Given a capability-bound live writer lease and quality receipt",
      "When caller payload includes a false goal hash and starting commit",
      "Then the appended receipt uses reconstructed trusted values",
    ],
    execute() {
      const fixture = receiptFixture();
      try {
        const receipt = governance.appendRunReceipt({
          ...fixture.input,
          goalObjectiveSha256: "0".repeat(64),
          startingCommit: "0".repeat(40),
        }, {
          ledger: fixture.ledger,
          lease: fixture.lease,
          capability: fixture.capability,
          repoRoot: fixture.temp,
          leasePath: fixture.leasePath,
          receiptPath: fixture.receiptPath,
          qualityReceiptPath: fixture.qualityReceiptPath,
          qualityArtifactDirectory: fixture.qualityArtifactDirectory,
          now: fixture.receiptNow,
        });
        assert.equal(
          receipt.goalObjectiveSha256,
          fixture.ledger.codexGoal.objectiveSha256,
        );
        assert.equal(receipt.startingCommit, fixture.head);
      } finally {
        fixture.cleanup();
      }
    },
  },
  "A tampered receipt chain blocks append": {
    steps: [
      "Given a valid two-entry hash-chained receipt log",
      "When the first receipt content is changed",
      "Then full-chain verification and the next append fail",
    ],
    execute() {
      const fixture = receiptFixture();
      try {
        governance.appendRunReceipt(fixture.input, {
          ledger: fixture.ledger,
          lease: fixture.lease,
          capability: fixture.capability,
          repoRoot: fixture.temp,
          leasePath: fixture.leasePath,
          receiptPath: fixture.receiptPath,
          qualityReceiptPath: fixture.qualityReceiptPath,
          qualityArtifactDirectory: fixture.qualityArtifactDirectory,
          now: fixture.receiptNow,
        });
        governance.appendRunReceipt(
          { ...fixture.input, result: "completed-again" },
          {
            ledger: fixture.ledger,
            lease: fixture.lease,
            capability: fixture.capability,
            repoRoot: fixture.temp,
            leasePath: fixture.leasePath,
            receiptPath: fixture.receiptPath,
            qualityReceiptPath: fixture.qualityReceiptPath,
            qualityArtifactDirectory: fixture.qualityArtifactDirectory,
            now: "2026-07-24T04:36:00.000Z",
          },
        );
        const lines = fs.readFileSync(fixture.receiptPath, "utf8").split("\n");
        const first = JSON.parse(lines[0]);
        first.result = "tampered";
        lines[0] = JSON.stringify(first);
        fs.writeFileSync(fixture.receiptPath, lines.join("\n"));
        assert.equal(
          governance.verifyReceiptChain(fixture.receiptPath).valid,
          false,
        );
        assert.throws(
          () => governance.appendRunReceipt(fixture.input, {
            ledger: fixture.ledger,
            lease: fixture.lease,
            capability: fixture.capability,
            repoRoot: fixture.temp,
            leasePath: fixture.leasePath,
            receiptPath: fixture.receiptPath,
            qualityReceiptPath: fixture.qualityReceiptPath,
            qualityArtifactDirectory: fixture.qualityArtifactDirectory,
            now: "2026-07-24T04:37:00.000Z",
          }),
          (error) => error.code === "RUN_RECEIPT_CHAIN_INVALID",
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "Quality thresholds cannot be weakened with behavior": {
    steps: [
      "Given the critical Pikiio quality profile",
      "When any threshold is reduced or a required evidence layer is removed",
      "Then phase ledger validation fails",
    ],
    execute() {
      const threshold = clone(LEDGER);
      threshold.qualityPolicy.profiles.critical.minimumLineCoveragePercent = 0;
      assert.equal(governance.validatePhaseLedger(threshold).valid, false);
      const evidence = clone(LEDGER);
      evidence.qualityPolicy.requiredEvidence.pop();
      assert.equal(governance.validatePhaseLedger(evidence).valid, false);
    },
  },
  "Gherkin step text is executable contract": {
    steps: [
      "Given an exact scenario and exact registered steps",
      "When any Given When or Then text is changed",
      "Then the Gherkin verifier reports an undefined contract",
    ],
    execute() {
      const scenarios = parseFeature(fs.readFileSync(FEATURE_PATH, "utf8"));
      const changed = clone(scenarios);
      changed[0].steps[0] = "Given vague policy text";
      assert.throws(
        () => exactScenarioContracts(changed, definitions),
        /undefined, reordered, or ambiguous/,
      );
    },
  },
  "External freight actions remain forbidden": {
    steps: [
      "Given any autonomous Pikiio phase",
      "When its external effect policy is validated",
      "Then every canonical Gmail and freight mutation remains denied",
    ],
    execute() {
      assert.deepEqual(
        LEDGER.policy.forbiddenExternalEffects,
        governance.REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS,
      );
      for (const phase of LEDGER.phases) {
        assert.equal(phase.externalEffects.inheritsGlobalForbidden, true);
      }
    },
  },
  "Missing or stale activation receipt refuses an active heartbeat": {
    steps: [
      "Given a post-governance phase with exact quality evidence",
      "When its activation receipt is absent or expired",
      "Then activation validation fails",
    ],
    execute() {
      const fixture = activationFixture();
      try {
        const context = {
          ledger: fixture.ledger,
          phase: fixture.phase,
          head: fixture.head,
          repoRoot: fixture.repoRoot,
          nowMs: fixture.nowMs,
          localHost: fixture.localHost,
          externalProofValidator: fixture.externalProofValidator,
        };
        assert.equal(
          governance.validateHeartbeatActivationReceipt(null, context).valid,
          false,
        );
        const expired = signReceipt({
          ...fixture.receipt,
          expiresAt: "2026-07-24T04:59:59.000Z",
        });
        assert.equal(
          governance.validateHeartbeatActivationReceipt(expired, context).valid,
          false,
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "Exact activation receipt permits a post-governance heartbeat": {
    steps: [
      "Given a post-governance phase with exact quality evidence",
      "When its phase head ledger and quality receipt all match",
      "Then activation validation passes",
    ],
    execute() {
      const fixture = activationFixture();
      try {
        assert.equal(
          governance.validateHeartbeatActivationReceipt(fixture.receipt, {
            ledger: fixture.ledger,
            phase: fixture.phase,
            head: fixture.head,
            repoRoot: fixture.repoRoot,
            nowMs: fixture.nowMs,
            localHost: fixture.localHost,
            externalProofValidator: fixture.externalProofValidator,
          }).valid,
          true,
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "A planned phase receipt cannot activate the heartbeat": {
    steps: [
      "Given a ledger whose active phase differs from a planned phase receipt",
      "When the otherwise valid activation receipt names the planned phase",
      "Then activation validation fails on active phase identity",
    ],
    execute() {
      const fixture = activationFixture();
      try {
        const planned = fixture.ledger.phases.find(
          (phase) => phase.id === "TRUTH-02",
        );
        const receipt = signReceipt({
          ...fixture.receipt,
          phaseId: planned.id,
        });
        assert.equal(
          governance.validateHeartbeatActivationReceipt(receipt, {
            ledger: fixture.ledger,
            phase: planned,
            head: fixture.head,
            repoRoot: fixture.repoRoot,
            nowMs: fixture.nowMs,
            localHost: fixture.localHost,
            externalProofValidator: fixture.externalProofValidator,
          }).valid,
          false,
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "A phase transition requires its complete quality receipt": {
    steps: [
      "Given an otherwise canonical phase transition with an invented receipt hash",
      "When committed transition history is validated",
      "Then transition history refuses the fabricated completion evidence",
    ],
    execute() {
      const fixture = activationFixture();
      try {
        const receiptPath = fixture.ledger.phases.find(
          (phase) => phase.id === "GOV-00",
        ).lastResult.qualityReceiptPath;
        fs.writeFileSync(
          path.join(fixture.repoRoot, receiptPath),
          `${JSON.stringify({ receiptHash: "0".repeat(64) })}\n`,
        );
        trustedFixtureGit(fixture.repoRoot, ["add", receiptPath]);
        trustedFixtureGit(fixture.repoRoot, ["commit", "--amend", "--no-edit"], {
          stdio: "ignore",
        });
        assert.equal(
          governance.validatePhaseTransitionHistory({
            ledger: fixture.ledger,
            phase: fixture.phase,
            repoRoot: fixture.repoRoot,
            externalProofValidator: fixture.externalProofValidator,
          }).ok,
          false,
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "Perfect percentages cannot hide a collapsed test population": {
    steps: [
      "Given a correctly hashed quality receipt with perfect percentages",
      "When its unit mutant or Gherkin population falls below the pinned floor",
      "Then quality receipt validation fails on population evidence",
    ],
    execute() {
      const fixture = activationFixture();
      try {
        const phase = governance.selectActivePhase(fixture.before);
        const collapsed = clone(fixture.qualityReceipt);
        collapsed.metrics.testsPerRun = 1;
        collapsed.metrics.minimumMutationPopulation = 1;
        collapsed.metrics.minimumCriticalMutationPopulation = 1;
        collapsed.metrics.minimumGherkinScenarioPopulation = 1;
        for (const unit of collapsed.populations.unit) {
          Object.assign(unit, {
            tests: 1,
            passed: 1,
            failed: 0,
            cancelled: 0,
            skipped: 0,
            todo: 0,
          });
        }
        for (const mutation of collapsed.populations.mutation) {
          Object.assign(mutation, {
            total: 1,
            killed: 1,
            survived: 0,
            criticalTotal: 1,
            criticalKilled: 1,
            survivedCritical: 0,
            scorePercent: 100,
            criticalKillPercent: 100,
            metaTestsPassed: true,
          });
        }
        for (const gherkin of collapsed.populations.gherkin) {
          Object.assign(gherkin, {
            scenarios: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            undefined: 0,
            ambiguous: 0,
            pending: 0,
            passPercent: 100,
          });
        }
        const signed = signReceipt(collapsed);
        assert.equal(
          governance.validateQualityReceipt(signed, {
            ledger: fixture.before,
            phase,
            head: fixture.candidate,
            workspaceDigest: governance.cleanWorkspaceEvidenceDigest(),
            repoRoot: fixture.repoRoot,
          }).valid,
          false,
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "Heartbeat state follows governed phase readiness": {
    steps: [
      "Given the canonical phase ledger and heartbeat state",
      "When the heartbeat automation contract is inspected",
      "Then a paused heartbeat is safe and an active heartbeat requires completed governance",
    ],
    execute() {
      const automation = fs.readFileSync(AUTOMATION_PATH, "utf8");
      const status = automation.match(/^status = "(ACTIVE|PAUSED)"$/m)?.[1];
      assert.ok(status, "Heartbeat status must be ACTIVE or PAUSED");
      if (status === "ACTIVE") {
        assert.notEqual(CANONICAL_LEDGER.activePhaseId, "GOV-00");
        const governancePhase = CANONICAL_LEDGER.phases.find(
          (phase) => phase.id === "GOV-00",
        );
        assert.ok(
          ["complete", "promoted"].includes(governancePhase?.status),
          "ACTIVE requires terminal GOV-00",
        );
      }
    },
  },
  "Heartbeat prompt drift cannot acquire authority": {
    steps: [
      "Given the exact checked-in heartbeat prompt",
      "When the configured heartbeat prompt differs by one byte",
      "Then automation contract validation refuses the drift",
    ],
    execute() {
      const canonical = readCanonicalPikiioHeartbeatPrompt();
      assert.equal(
        comparePikiioHeartbeatPrompt(canonical, canonical).valid,
        true,
      );
      const changed = `X${canonical.slice(1)}`;
      const comparison = comparePikiioHeartbeatPrompt(changed, canonical);
      assert.equal(comparison.valid, false);
      assert.match(
        comparison.errors.join("\n"),
        /configured heartbeat prompt differs/,
      );
    },
  },
  "Candidate-owned authority cannot certify itself": {
    steps: [
      "Given the frozen external phase authority registry",
      "When every phase changes its authority baseline to candidate",
      "Then the phase proof registry refuses self-certification",
    ],
    execute() {
      const candidateOwned = clone(phaseProof.loadPhaseProofRegistry());
      for (const phase of Object.values(candidateOwned.phases)) {
        phase.receiptPolicy.authorityBaseline = "candidate";
      }
      const validation = phaseProof.validatePhaseProofRegistry(
        candidateOwned,
        { requireCanonical: false },
      );
      assert.equal(validation.valid, false);
      assert.match(validation.errors.join("\n"), /authorityBaseline/);
    },
  },
  "Core phase proof cannot substitute for external certification": {
    steps: [
      "Given a valid core phase proof and synthetic external collector authority",
      "When the signed envelope and exact expected context are validated",
      "Then external certification passes and a core-only substitute is refused",
    ],
    execute() {
      const fixture = activationFixture();
      try {
        const phase = governance.selectActivePhase(fixture.before);
        const coreValidation = governance.validatePhaseProofBundle(
          fixture.phaseProofBundle,
          {
            ledger: fixture.before,
            phase,
            qualityReceipt: fixture.qualityReceipt,
            repoRoot: fixture.repoRoot,
            requireFullChain: true,
          },
        );
        assert.equal(
          coreValidation.valid,
          true,
          coreValidation.errors.join("\n"),
        );
        const synthetic = buildSyntheticExternalEnvelope(fixture);
        const validation = phaseProofEnvelope.validatePhaseProofEnvelope({
          envelope: synthetic.envelope,
          authorityRegistry: synthetic.authorityRegistry,
          expectedAuthoritySha256:
            synthetic.authorityRegistry.authoritySha256,
          jwksRegistry: synthetic.jwksRegistry,
          expectedJwksRegistrySha256:
            synthetic.jwksRegistry.registrySha256,
          expected: synthetic.expected,
          nowMs: synthetic.nowMs,
        });
        assert.equal(validation.valid, true);
        assert.equal(validation.externallyCertified, true);
        assert.equal(validation.replayConsumed, false);
        assert.equal(
          validation.coreBundleHash,
          fixture.phaseProofBundle.bundleHash,
        );
        assert.throws(
          () =>
            phaseProofEnvelope.validatePhaseProofEnvelope({
              envelope: fixture.phaseProofBundle,
              authorityRegistry: synthetic.authorityRegistry,
              expectedAuthoritySha256:
                synthetic.authorityRegistry.authoritySha256,
              jwksRegistry: synthetic.jwksRegistry,
              expectedJwksRegistrySha256:
                synthetic.jwksRegistry.registrySha256,
              expected: synthetic.expected,
              nowMs: synthetic.nowMs,
            }),
          (error) =>
            error instanceof phaseProofEnvelope.PhaseProofEnvelopeError &&
            error.code === "UNEXPECTED_FIELDS",
        );
      } finally {
        fixture.cleanup();
      }
    },
  },
  "A substituted GitHub signing registry is refused": {
    steps: [
      "Given the independently pinned GitHub OIDC JWKS registry",
      "When a different internally consistent registry is substituted",
      "Then the external collector refuses the substituted signing authority",
    ],
    execute() {
      const canonical = JSON.parse(
        fs.readFileSync(
          path.join(
            ROOT,
            "YLYI",
            "00_Product_Contract",
            "Pikiio_GitHub_OIDC_JWKS.json",
          ),
          "utf8",
        ),
      );
      const keyPair = require("node:crypto").generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicExponent: 0x10001,
      });
      const jwk = keyPair.publicKey.export({ format: "jwk" });
      const substituted = clone(canonical);
      substituted.keys.push({
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid: "zzzz-gherkin-substitution",
        n: jwk.n,
        e: jwk.e,
        x5t: null,
      });
      substituted.keys.sort((left, right) =>
        left.kid.localeCompare(right.kid));
      substituted.registrySha256 = oidcCollector.hashWithoutField(
        substituted,
        "registrySha256",
      );
      assert.throws(
        () =>
          oidcCollector.validatePinnedJwksRegistry(substituted, {
            expectedRegistrySha256: canonical.registrySha256,
          }),
        (error) => error?.code === "JWKS_REGISTRY_HASH_MISMATCH",
      );
    },
  },
  "Durable raw evidence survives runtime artifact deletion": {
    steps: [
      "Given a strict quality receipt with embedded content-addressed judge bytes",
      "When no runtime artifact file exists",
      "Then quality validation replays the exact embedded evidence and rejects tampering",
    ],
    execute() {
      const phase = governance.selectActivePhase(LEDGER);
      let receipt = minimalQualityReceipt(
        LEDGER,
        phase,
        "a".repeat(40),
        "b".repeat(64),
      );
      receipt.schema = "pikiio-quality-gauntlet-receipt-v5";
      receipt = signReceipt(receipt);
      const embedded = embedRawQualityEvidence(receipt);
      for (const holder of [
        embedded.receipt.primaryJudge,
        embedded.receipt.cleanJudge,
      ]) {
        assert.equal(fs.existsSync(holder.rawArtifact.artifactPath), false);
      }
      const valid = governance.validateQualityReceipt(embedded.receipt, {
        ledger: LEDGER,
        phase,
        head: embedded.receipt.head,
        workspaceDigest: embedded.receipt.workspaceDigest,
        verifyRawArtifacts: true,
        rawArtifactBytes: embedded.rawArtifactBytes,
      });
      assert.equal(valid.valid, true, valid.errors.join("\n"));
      const tampered = new Map(embedded.rawArtifactBytes);
      const [address, bytes] = tampered.entries().next().value;
      const reordered = Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(JSON.parse(bytes.toString("utf8"))).reverse(),
          ),
        ),
        "utf8",
      );
      assert.equal(reordered.length, bytes.length);
      tampered.set(address, reordered);
      const refused = governance.validateQualityReceipt(embedded.receipt, {
        ledger: LEDGER,
        phase,
        head: embedded.receipt.head,
        workspaceDigest: embedded.receipt.workspaceDigest,
        verifyRawArtifacts: true,
        rawArtifactBytes: tampered,
      });
      assert.equal(refused.valid, false);
      assert.match(refused.errors.join("\n"), /bytes do not match their address/);
    },
  },
  "Host durability requires exact live keep-awake evidence": {
    steps: [
      "Given a fresh ready host durability receipt",
      "When service state plist bytes sleep policy or assertions differ",
      "Then every altered host receipt is refused",
    ],
    execute() {
      const nowMs = Date.parse("2026-07-24T08:00:00.000Z");
      assert.equal(
        hostDurability.validateHostDurabilityReceipt(readyHostReceipt(), {
          nowMs,
          localHost: "operator-mac",
        }).valid,
        true,
      );
      const altered = [
        readyHostReceipt({ serviceState: "stopped" }),
        readyHostReceipt({
          servicePlistEvidence: { sha256: "f".repeat(64) },
        }),
        readyHostReceipt({
          pmsetOutput: "Battery Power:\n sleep 1\nAC Power:\n powernap 1\n",
        }),
        readyHostReceipt({
          assertionsOutput: [
            "PreventSystemSleep 0",
            "PreventUserIdleSystemSleep 0",
            "pid 4242(caffeinate): PreventSystemSleep",
            "pid 4242(caffeinate): PreventUserIdleSystemSleep",
          ].join("\n"),
        }),
      ];
      for (const receipt of altered) {
        assert.equal(
          hostDurability.validateHostDurabilityReceipt(receipt, {
            nowMs,
            localHost: "operator-mac",
          }).valid,
          false,
        );
      }
    },
  },
  "Every post-governance lease samples fresh host durability": {
    steps: [
      "Given a valid post-governance activation and clean checkpoint",
      "When the live host durability sample is invalid",
      "Then lease admission refuses before creating bootstrap state",
    ],
    async execute() {
      const ledger = clone(LEDGER);
      ledger.activePhaseId = "TRUTH-01";
      for (const phase of ledger.phases) {
        phase.status =
          phase.id === "TRUTH-01" ? "active" :
            phase.id === "GOV-00" ? "complete" : "planned";
      }
      const phase = ledger.phases.find((entry) => entry.id === "TRUTH-01");
      let bootstrapReached = false;
      await assert.rejects(
        () =>
          writerLease.acquireCommand({
            argv: [
              process.argv[0],
              "pikiio-agent-writer-lease.js",
              "acquire",
              "--lease-class=builder",
            ],
            loadPhaseLedgerImpl: () => ledger,
            selectActivePhaseImpl: () => phase,
            evaluateGoalGuardImpl: () => ({ ok: true }),
            validateHeartbeatActivationReceiptImpl: () => ({ valid: true }),
            evaluateDirtyGuardImpl: () => ({
              ok: true,
              working: { allowed: [], blocked: [] },
            }),
            currentHeadImpl: () => "a".repeat(40),
            currentBranchImpl: () => ledger.baseline.branch,
            readActivationReceipt: () => ({}),
            collectHostDurability: () => ({
              sleep: { acSleepMinutes: 1 },
              blockers: ["HOST_KEEP_AWAKE_SERVICE_NOT_RUNNING"],
            }),
            validateHostDurability: () => ({
              valid: false,
              errors: ["stopped"],
            }),
            nowMs: Date.parse("2026-07-24T08:00:00.000Z"),
            fsImpl: {
              mkdirSync() {
                bootstrapReached = true;
              },
            },
          }),
        (error) => error?.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
      );
      assert.equal(bootstrapReached, false);
    },
  },
  "Interrupted phase transition is recovered or refused atomically": {
    steps: [
      "Given a durable transition intent with an uncommitted artifact pair",
      "When recovery sees exact divergent or tampered transition state",
      "Then exact orphans roll back and divergent or tampered state fails closed",
    ],
    execute() {
      const exact = transitionRecoveryFixture();
      const divergent = transitionRecoveryFixture({ divergent: true });
      const tampered = transitionRecoveryFixture({
        tamperCompletion: true,
        preexisting: true,
      });
      try {
        const rolledBack = governance.recoverPhaseTransition({
          repoRoot: exact.repoRoot,
          journalPath: exact.journalPath,
        });
        assert.equal(rolledBack.status, "rolled_back");
        assert.equal(fs.existsSync(exact.completionPath), false);
        assert.equal(fs.existsSync(exact.bundlePath), false);
        assert.equal(fs.existsSync(exact.journalPath), false);
        assert.throws(
          () =>
            governance.recoverPhaseTransition({
              repoRoot: divergent.repoRoot,
              journalPath: divergent.journalPath,
            }),
          (error) => error?.code === "PHASE_TRANSITION_LEDGER_DIVERGED",
        );
        assert.throws(
          () =>
            governance.recoverPhaseTransition({
              repoRoot: tampered.repoRoot,
              journalPath: tampered.journalPath,
            }),
          (error) =>
            error?.code === "PHASE_TRANSITION_ARTIFACT_HASH_MISMATCH",
        );
      } finally {
        exact.cleanup();
        divergent.cleanup();
        tampered.cleanup();
      }
    },
  },
  "Content-addressed proof writes never overwrite an existing receipt": {
    steps: [
      "Given an existing content-addressed proof receipt",
      "When a competing writer targets the same immutable path",
      "Then the exclusive writer refuses and preserves the original bytes",
    ],
    execute() {
      const directory = tempDirectory("pikiio-gherkin-exclusive-write-");
      const receiptPath = path.join(directory, `${"a".repeat(64)}.json`);
      const original = { schema: "proof-v1", receipt: "original" };
      try {
        governance.writeJsonExclusiveAtomic(receiptPath, original);
        const originalBytes = fs.readFileSync(receiptPath);
        assert.throws(
          () =>
            governance.writeJsonExclusiveAtomic(receiptPath, {
              schema: "proof-v1",
              receipt: "competing",
            }),
          (error) =>
            error?.code === "CONTENT_ADDRESSED_DESTINATION_EXISTS",
        );
        assert.deepEqual(fs.readFileSync(receiptPath), originalBytes);
        assert.deepEqual(JSON.parse(originalBytes.toString("utf8")), original);
        assert.equal(
          fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
          false,
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
};

async function main() {
  const scenarios = parseFeature(fs.readFileSync(FEATURE_PATH, "utf8"));
  assert.ok(scenarios.length > 0, "Feature must contain scenarios");
  exactScenarioContracts(scenarios, definitions);
  const results = [];
  for (const scenario of scenarios) {
    await definitions[scenario.name].execute();
    results.push({
      scenario: scenario.name,
      steps: scenario.steps.length,
      status: "passed",
    });
  }
  console.log(JSON.stringify({
    ok: true,
    feature: path.relative(ROOT, FEATURE_PATH),
    scenarios: results.length,
    passed: results.length,
    failed: 0,
    skipped: 0,
    undefined: 0,
    ambiguous: 0,
    pending: 0,
    passPercent: 100,
    results,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : "",
      undefined: 1,
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  definitions,
  exactScenarioContracts,
  parseFeature,
  trustedFixtureGit,
};

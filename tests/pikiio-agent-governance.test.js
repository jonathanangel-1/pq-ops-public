"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const test = require("node:test");
const { promisify } = require("node:util");

const governance = require("../lib/pikiio-agent-governance");
const phaseProof = require("../lib/pikiio-phase-proof");
const {
  assemblePhaseProofEnvelope,
} = require("../lib/pikiio-phase-proof-envelope");
const {
  createSealedGit,
} = require("../lib/pikiio-sealed-git");

// External-proof substitution exists only for hermetic alternate-repository
// fixtures and is rejected by the canonical checkout even in test mode.
process.env.NODE_ENV = "test";
const {
  semanticReceiptSha256,
} = require("../lib/pikiio-quality-canonical");
const {
  buildHostDurabilityReceipt,
  HOST_SERVICE_LABEL,
  HOST_SERVICE_PLIST_BYTE_LENGTH,
  HOST_SERVICE_PLIST_SHA256,
  MAXIMUM_HOST_SERVICE_PLIST_BYTES,
} = require("../lib/pikiio-host-durability");
const {
  definitions,
  exactScenarioContracts,
  parseFeature,
} = require("../scripts/verify-pikiio-governance-gherkin");
const {
  __testOnly: mutationHarness,
} = require("../scripts/mutate-pikiio-agent-governance");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

function loadGovernanceMutant(name, search, replacement) {
  const libraryPath = path.join(ROOT, "lib", "pikiio-agent-governance.js");
  const source = fs.readFileSync(libraryPath, "utf8");
  assert.equal(
    source.split(search).length - 1,
    1,
    `${name}: mutation target must occur exactly once`,
  );
  const mutantFilename = `${libraryPath}?mutant=${name}`;
  const mutantModule = new Module(mutantFilename, module);
  mutantModule.filename = mutantFilename;
  mutantModule.paths = Module._nodeModulePaths(path.dirname(libraryPath));
  mutantModule._compile(
    source.replace(search, replacement),
    mutantFilename,
  );
  return mutantModule.exports;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const CHECKED_IN_LEDGER = governance.loadPhaseLedger();

function governanceLedgerFixture(source = CHECKED_IN_LEDGER) {
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
const GOAL = LEDGER.codexGoal.objective;
const TASK_ID = LEDGER.codexGoal.threadId;

function resign(value, hashField = "receiptHash") {
  const signed = clone(value);
  delete signed[hashField];
  signed[hashField] = governance.sha256(governance.stableJson(signed));
  return signed;
}

function tempDirectory(prefix) {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
}

function withEnvironment(overrides, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(
      key,
      Object.hasOwn(process.env, key) ? process.env[key] : undefined,
    );
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function initializeGitRepository({
  branch = LEDGER.baseline.branch,
  files = { x: "x\n" },
} = {}) {
  const root = tempDirectory("pikiio-governance-git-");
  execFileSync("git", ["init", "-b", branch], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Pikiio Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: root });
  for (const [relativePath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

function validSafetyConfirmations() {
  return Object.fromEntries(
    governance.REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS.map((effect) => [
      effect,
      { preserved: true, evidence: "network-boundary denial verified" },
    ]),
  );
}

function readyHostDurabilityReceipt({
  nowMs = Date.parse("2026-07-24T04:30:00.000Z"),
  hostname = "test-host",
  pid = 4242,
} = {}) {
  const expectedPlistPath =
    `/workspace/demo/Library/LaunchAgents/${HOST_SERVICE_LABEL}.plist`;
  return buildHostDurabilityReceipt({
    observedAt: new Date(nowMs).toISOString(),
    hostname,
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    batteryOutput:
      "Now drawing from 'AC Power'\n -InternalBattery-0\t100%; charged;",
    pmsetOutput:
      "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n",
    assertionsOutput: [
      "Assertion status system-wide:",
      "   PreventSystemSleep             1",
      "   PreventUserIdleSystemSleep     1",
      "Listed by owning process:",
      `   pid ${pid}(caffeinate): [0x1] PreventSystemSleep named: "caffeinate command-line tool"`,
      `   pid ${pid}(caffeinate): [0x2] PreventUserIdleSystemSleep named: "caffeinate command-line tool"`,
    ].join("\n"),
    clamshellOutput: '  |   "AppleClamshellState" = No\n',
    launchctlOutput: [
      `gui/501/${HOST_SERVICE_LABEL} = {`,
      `\tpath = ${expectedPlistPath}`,
      "\tstate = running",
      "\tprogram = /usr/bin/caffeinate",
      "\targuments = {",
      "\t\t/usr/bin/caffeinate",
      "\t\t-is",
      "\t}",
      `\tpid = ${pid}`,
      "\tlast exit code = 0",
      "}",
      "",
    ].join("\n"),
    expectedPlistPath,
    servicePlistEvidence: {
      expectedPath: expectedPlistPath,
      resolvedPath: expectedPlistPath,
      readable: true,
      regular: true,
      symlink: false,
      byteLength: HOST_SERVICE_PLIST_BYTE_LENGTH,
      sha256: HOST_SERVICE_PLIST_SHA256,
      maximumBytes: MAXIMUM_HOST_SERVICE_PLIST_BYTES,
      errorCode: null,
    },
  });
}

function proof(status = "not_applicable") {
  if (status === "passed") {
    return {
      status,
      receipts: [{ receiptHash: "a".repeat(64) }],
      reason: "proof completed",
    };
  }
  return {
    status,
    receipts: [],
    reason: "not exercised by this governance test",
  };
}

function dependencyManifestFixture() {
  const manifest = {
    packageJsonSha256: "1".repeat(64),
    packageLockSha256: "2".repeat(64),
    installedLockSha256: "3".repeat(64),
    name: "pikiio-quality-fixture",
    version: "1.0.0",
    dependencies: [
      {
        name: "fixture-dependency",
        version: "1.0.0",
        resolved: null,
        overridden: false,
      },
    ],
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

function qualityLayerFixture(layer, index) {
  const raw = {
    ...layer,
    isolation: "macos-sandbox-deny-network",
    startedAt: "2026-07-24T10:00:00.000Z",
    finishedAt: "2026-07-24T10:00:01.000Z",
    status: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    normalizationRoots: [],
    parsed: { status: "passed", repeat: index + 1 },
  };
  raw.semanticSha256 = semanticReceiptSha256(raw);
  return {
    raw,
    projected: {
      ...layer,
      isolation: raw.isolation,
      status: raw.status,
      signal: raw.signal,
      timedOut: raw.timedOut,
      semanticSha256: raw.semanticSha256,
    },
  };
}

function materializeRawJudgeArtifact({
  artifactDirectory,
  label,
  candidateCommit,
  candidateTree,
  automationSnapshotSha256,
  dependencyManifestSha256,
  toolchainSha256,
  layers,
}) {
  const body = {
    schema: "pikiio-quality-judge-raw-artifact-v1",
    label,
    candidateCommit,
    candidateTree,
    automationSnapshotSha256,
    dependencyManifestSha256,
    toolchainSha256,
    layers,
  };
  const bytes = Buffer.from(`${governance.stableJson(body)}\n`);
  const artifactSha256 = governance.sha256(bytes);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const canonicalArtifactDirectory = fs.realpathSync(artifactDirectory);
  const artifactPath = path.join(
    canonicalArtifactDirectory,
    `${artifactSha256}.json`,
  );
  fs.writeFileSync(artifactPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    schema: "pikiio-quality-judge-raw-artifact-v1",
    artifactPath,
    artifactSha256,
    byteLength: bytes.length,
    layerCount: layers.length,
  };
}

function qualityInput(
  ledger,
  phase,
  head,
  workspaceDigest,
  options = {},
) {
  const candidateTree = options.candidateTree || head;
  const sliceChangedPaths = options.sliceChangedPaths || [];
  const sliceDiffSha256 =
    options.sliceDiffSha256 || governance.sha256(Buffer.from(""));
  const profile = governance.effectiveQualityProfile(
    ledger.qualityPolicy.profiles[phase.qualityProfile],
    phase.id,
  );
  const requiredCoverageFiles = [
    ...(options.requiredCoverageFiles ||
      governance.QUALITY_TEST_SUITE_REGISTRY[
        phase.qualityPlan.testSuiteId
      ].coverageIncludes),
  ].sort();
  const layerPlan = governance.expectedQualityLayerPlan(phase, profile, {
    requiredCoverageFiles,
  });
  const dependencyManifest = dependencyManifestFixture();
  const automationSnapshotSha256 = "4".repeat(64);
  const layerFixtures = layerPlan.map(qualityLayerFixture);
  const rawArtifactOptions = {
    candidateCommit: head,
    candidateTree,
    automationSnapshotSha256,
    dependencyManifestSha256: dependencyManifest.manifestSha256,
    toolchainSha256:
      ledger.qualityPolicy.approvedToolchain.toolchainSha256,
    layers: layerFixtures.map(({ raw }) => raw),
  };
  const primaryRawArtifact = options.qualityArtifactDirectory
    ? materializeRawJudgeArtifact({
        ...rawArtifactOptions,
        artifactDirectory: options.qualityArtifactDirectory,
        label: "primary",
      })
    : rawJudgeArtifactFixture(layerPlan.length, "d");
  const independentRawArtifact = options.qualityArtifactDirectory
    ? materializeRawJudgeArtifact({
        ...rawArtifactOptions,
        artifactDirectory: options.qualityArtifactDirectory,
        label: "independent",
      })
    : rawJudgeArtifactFixture(layerPlan.length, "e");
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
    recordedAt: "2026-07-24T10:00:00.000Z",
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
    qualityToolchain: clone(ledger.qualityPolicy.approvedToolchain),
    primaryJudge: {
      worktreeHead: head,
      worktreeTree: candidateTree,
      workspaceUnchanged: true,
      installIsolation: "macos-sandbox-deny-network",
      auditIsolation: "macos-sandbox-deny-network",
      rawArtifact: primaryRawArtifact,
    },
    thresholds: clone(profile),
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
      sliceDiffSha256,
      worktreeChangedPaths: [],
      sliceChangedPaths,
      auditedPaths: [...sliceChangedPaths],
      protectedChanged: sliceChangedPaths.filter((relativePath) =>
        ledger.qualityPolicy.trustedGatePaths.includes(relativePath),
      ),
      weakeningFindings: [],
      baselineCounts: { tests: 1, assertions: 1, scenarios: 1, mutants: 1 },
      currentCounts: { tests: 1, assertions: 1, scenarios: 1, mutants: 1 },
      ...(options.canonicalTransition
        ? { canonicalTransition: clone(options.canonicalTransition) }
        : {}),
    },
    cleanJudge: {
      reproduced: true,
      worktreeHead: head,
      worktreeTree: candidateTree,
      automationSnapshotSha256,
      dependencyManifest: clone(dependencyManifest),
      rawArtifact: independentRawArtifact,
      workspaceUnchanged: true,
      semanticSha256: "c".repeat(64),
    },
    layers: layerFixtures.map(({ projected }) => projected),
  };
}

function receiptInput() {
  return {
    commands: ["node --test"],
    changedPaths: [],
    localProof: [{ name: "unit", status: "passed" }],
    productionProof: proof(),
    sourceCutProof: proof(),
    migrationProof: proof(),
    deploymentProof: proof(),
    browserProof: proof(),
    modelCostDeltaUsd: 0,
    safetyConfirmations: validSafetyConfirmations(),
    result: "completed",
    nextAction: "advance only after independent reproduction",
  };
}

function activationLedgerFixture() {
  const ledger = clone(LEDGER);
  const governancePhase = ledger.phases.find((phase) => phase.id === "GOV-00");
  const truthPhase = ledger.phases.find((phase) => phase.id === "TRUTH-01");
  governancePhase.status = "complete";
  truthPhase.status = "active";
  truthPhase.scopeBaseCommit = ledger.baseline.startCommit;
  ledger.activePhaseId = truthPhase.id;
  return { ledger, phase: truthPhase };
}

function activationReceiptFixture(ledger, phase, qualityReceipt, head) {
  return resign({
    schema: "pikiio-heartbeat-activation-receipt-v1",
    recordedAt: "2026-07-24T04:30:00.000Z",
    expiresAt: "2026-07-24T05:30:00.000Z",
    ledgerRevision: ledger.revision,
    ledgerSha256: governance.sha256(governance.stableJson(ledger)),
    phaseId: phase.id,
    head,
    qualityReceiptHash: qualityReceipt.receiptHash,
    runId: "activation-owner",
    leaseFence: 1,
  });
}

function automationContractFixture() {
  return governance.expectedHeartbeatAutomationContract(TASK_ID);
}

function governanceAuthorityFileFixture() {
  const registry = phaseProof.loadPhaseProofRegistry();
  const requiredRuntimeFiles = [
    "lib/pikiio-phase-proof-envelope.js",
  ];
  return Object.fromEntries([
    ["bootstrap.txt", "bootstrap\n"],
    [
      "YLYI/00_Product_Contract/Pikiio_Phase_Proof_Registry.json",
      fs.readFileSync(
        path.join(
          ROOT,
          "YLYI/00_Product_Contract/Pikiio_Phase_Proof_Registry.json",
        ),
      ),
    ],
    ...[
      ...new Set(
        [
          ...Object.values(registry.phases).flatMap(
            (phase) => phase.authorityFiles,
          ),
          ...requiredRuntimeFiles,
        ],
      ),
    ].map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(ROOT, relativePath)),
    ]),
  ]);
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

function testPhaseProofEnvelope(proofBundle) {
  return assemblePhaseProofEnvelope({
    proofBundle,
    externalCertification: {
      schema: "pikiio-frozen-authority-verification-receipt-v1",
      certificationHash: governance.sha256(
        `test-external-certification:${proofBundle.bundleHash}`,
      ),
    },
  });
}

function testExternalProofValidator({ envelope, expected }) {
  return {
    valid: true,
    externallyCertified: true,
    replayConsumed: false,
    envelopeHash: envelope.envelopeHash,
    coreBundleHash: envelope.proofBundle.bundleHash,
    certificationHash:
      envelope.externalCertification.certificationHash,
    phaseId: expected.phaseId,
    candidateCommit: expected.candidateCommit,
    candidateTree: expected.candidateTree,
  };
}

function buildGovernancePhaseProofBundle({
  ledger,
  phase,
  qualityReceipt,
  repoRoot,
  candidateCommit,
  observedAtMs = Date.now() - 10_000,
}) {
  const registry = phaseProof.loadPhaseProofRegistry();
  const proofPhase = phaseProof.phaseProofForId(registry, phase.id);
  const candidateTree = execFileSync(
    "git",
    ["rev-parse", `${candidateCommit}^{tree}`],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
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
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${phase.scopeBaseCommit}..${candidateCommit}`],
    { cwd: repoRoot },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
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
      unitTests: Math.max(proofPhase.populationFloors.unitTests, 123),
      criticalMutants: Math.max(
        proofPhase.populationFloors.criticalMutants,
        63,
      ),
      gherkinScenarios: Math.max(
        proofPhase.populationFloors.gherkinScenarios,
        31,
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
  const makeNotApplicableProductionReceipt = (kind, previousReceiptHash, at) =>
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
    const artifactPath = judge.rawArtifact.artifactPath;
    artifacts.set(
      `sha256:${judge.rawArtifact.artifactSha256}`,
      fs.readFileSync(artifactPath),
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
  bundle.bundleHash = governance.sha256(
    governance.stableJson(bundle),
  );
  return bundle;
}

function buildPrechangePhaseProofBundle({
  ledger,
  phase,
  qualityReceipt,
  repoRoot,
  candidateCommit,
  observedAtMs = Date.now() - 10_000,
}) {
  const registry = phaseProof.loadPhaseProofRegistry();
  const proofPhase = phaseProof.phaseProofForId(registry, phase.id);
  assert.equal(proofPhase.receiptPolicy.productionMode, "change_gated");
  const candidateTree = execFileSync(
    "git",
    ["rev-parse", `${candidateCommit}^{tree}`],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
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
  const changedPaths = [...qualityReceipt.antiWeakening.sliceChangedPaths];
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
      unitTests: qualityReceipt.metrics.testsPerRun,
      criticalMutants:
        qualityReceipt.metrics.minimumCriticalMutationPopulation,
      gherkinScenarios:
        qualityReceipt.metrics.minimumGherkinScenarioPopulation,
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
  const rehearsalObservedAt = new Date(observedAtMs + 1_000).toISOString();
  const rehearsal = {
    schema: "pikiio-phase-production-rehearsal-receipt-v1",
    ...common(rehearsalObservedAt),
    previousReceiptHash: candidate.receiptHash,
    disposition: "passed",
    deploymentId: "rehearsal-deployment-123",
    rollbackVerified: true,
    externalEffects: [],
  };
  rehearsal.rawArtifact = addPhaseProofArtifact(artifacts, {
    schema: "pikiio-production-rehearsal-raw-artifact-v1",
    ...common(rehearsalObservedAt),
    deploymentId: rehearsal.deploymentId,
    rollbackVerified: true,
    externalEffects: [],
  });
  finishPhaseProofReceipt(rehearsal);
  const chain = {
    candidate,
    rehearsal,
    change: null,
    promotion: null,
  };
  for (const receipt of [candidate, rehearsal]) {
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

function createTransitionedActivationContext({
  branch = LEDGER.baseline.branch,
} = {}) {
  const root = initializeGitRepository({
    branch,
    files: governanceAuthorityFileFixture(),
  });
  const runtime = tempDirectory("pikiio-transition-runtime-");
  const ledgerPath = path.join(root, governance.PHASE_LEDGER_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const base = governance.currentHead(root);
  const before = clone(LEDGER);
  before.baseline.branch = branch;
  before.baseline.startCommit = base;
  before.baseline.preExistingDirty = [];
  before.automationContract = automationContractFixture();
  const previous = governance.selectActivePhase(before);
  previous.scopeBaseCommit = base;
  fs.writeFileSync(ledgerPath, `${JSON.stringify(before, null, 2)}\n`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "governance candidate"], {
    cwd: root,
    stdio: "ignore",
  });
  const candidate = governance.currentHead(root);
  const candidateTree = execFileSync(
    "git",
    ["rev-parse", `${candidate}^{tree}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const sliceChangedPaths = [governance.PHASE_LEDGER_RELATIVE_PATH];
  const sliceDiffSha256 = governance.sha256(
    createSealedGit({ repoRoot: root }).diff({
      from: base,
      to: candidate,
      format: "binary",
    }),
  );
  const qualityReceiptPath = path.join(runtime, "quality.json");
  const qualityArtifactDirectory = path.join(runtime, "quality-artifacts");
  const qualityReceipt = governance.writeQualityReceipt(
    qualityInput(
      before,
      previous,
      candidate,
      governance.cleanWorkspaceEvidenceDigest(),
      {
        candidateTree,
        sliceChangedPaths,
        sliceDiffSha256,
        qualityArtifactDirectory,
      },
    ),
    { receiptPath: qualityReceiptPath },
  );
  const phaseProofBundle = buildGovernancePhaseProofBundle({
    ledger: before,
    phase: previous,
    qualityReceipt,
    repoRoot: root,
    candidateCommit: candidate,
    observedAtMs: Date.parse("2026-07-24T03:50:00.000Z"),
  });
  const phaseProofEnvelope = testPhaseProofEnvelope(phaseProofBundle);
  const phaseProofBundlePath = path.join(runtime, "phase-proof-bundle.json");
  fs.writeFileSync(
    phaseProofBundlePath,
    `${JSON.stringify(phaseProofEnvelope, null, 2)}\n`,
  );
  const after = clone(before);
  after.revision += 1;
  after.activePhaseId = "TRUTH-01";
  const afterPrevious = after.phases.find((phase) => phase.id === previous.id);
  const afterNext = after.phases.find((phase) => phase.id === "TRUTH-01");
  const receiptPath =
    `YLYI/09_Proof_Receipts/phase-completions/${qualityReceipt.receiptHash}.json`;
  afterPrevious.status = "complete";
  afterPrevious.lastResult = {
    schema: "pikiio-phase-completion-v3",
    result: "passed",
    head: candidate,
    qualityReceiptHash: qualityReceipt.receiptHash,
    qualityReceiptPath: receiptPath,
    phaseProofBundleHash: phaseProofBundle.bundleHash,
    phaseProofEnvelopeHash: phaseProofEnvelope.envelopeHash,
    externalCertificationHash:
      phaseProofEnvelope.externalCertification.certificationHash,
    phaseProofBundlePath: governance.phaseProofBundleRelativePath(
      phaseProofEnvelope.envelopeHash,
    ),
    phaseProofReceiptHashes: Object.fromEntries(
      Object.entries(phaseProofBundle.chain).map(([role, receipt]) => [
        role,
        receipt.receiptHash,
      ]),
    ),
    completedAt: phaseProofBundle.chain.promotion.observedAt,
  };
  afterNext.status = "active";
  afterNext.scopeBaseCommit = candidate;
  fs.mkdirSync(path.dirname(path.join(root, receiptPath)), { recursive: true });
  fs.writeFileSync(
    path.join(root, receiptPath),
    `${JSON.stringify(qualityReceipt, null, 2)}\n`,
  );
  fs.mkdirSync(
    path.dirname(path.join(root, afterPrevious.lastResult.phaseProofBundlePath)),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(root, afterPrevious.lastResult.phaseProofBundlePath),
    `${JSON.stringify(phaseProofEnvelope, null, 2)}\n`,
  );
  fs.writeFileSync(ledgerPath, `${JSON.stringify(after, null, 2)}\n`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "canonical phase transition"], {
    cwd: root,
    stdio: "ignore",
  });
  const transitionCommit = governance.currentHead(root);
  const phase = governance.selectActivePhase(after);
  const nowMs = Date.parse("2026-07-24T05:00:00.000Z");
  const activationReceipt = resign({
    schema: "pikiio-heartbeat-activation-receipt-v3",
    recordedAt: "2026-07-24T04:30:00.000Z",
    expiresAt: "2026-07-31T04:30:00.000Z",
    ledgerRevision: after.revision,
    ledgerSha256: governance.sha256(governance.stableJson(after)),
    phaseId: phase.id,
    transitionCommit,
    transitionParent: candidate,
    qualityReceiptHash: qualityReceipt.receiptHash,
    hostDurability: readyHostDurabilityReceipt({
      nowMs: Date.parse("2026-07-24T04:30:00.000Z"),
      hostname: "test-host",
    }),
    automationContractSha256: governance.sha256(
      governance.stableJson(after.automationContract),
    ),
    issuerRunId: "activation-owner",
    issuerLeaseFence: 1,
  });
  return {
    root,
    runtime,
    before,
    ledger: after,
    phase,
    previous,
    base,
    candidate,
    transitionCommit,
    qualityReceipt,
    qualityReceiptPath,
    qualityArtifactDirectory,
    phaseProofBundle,
    phaseProofEnvelope,
    phaseProofBundlePath,
    externalProofValidator: testExternalProofValidator,
    activationReceipt,
    nowMs,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function createActivationIssuerContext() {
  const fixture = createTransitionedActivationContext();
  const leasePath = path.join(fixture.runtime, "activation-lease.json");
  const fencePath = path.join(fixture.runtime, "activation-fence.json");
  const activationReceiptPath = path.join(
    fixture.runtime,
    "issued-activation.json",
  );
  const capability = "9".repeat(64);
  const lease = governance.acquireWriterLease({
    runId: "activation-race-owner",
    automationId: "pikiio-governed-builder-heartbeat",
    goalId: fixture.ledger.codexGoal.objectiveSha256,
    phaseId: fixture.previous.id,
    lane: fixture.previous.lane,
    capability,
    leasePath,
    fencePath,
    startHead: fixture.candidate,
    branch: fixture.ledger.baseline.branch,
    allowedPaths: fixture.previous.allowedPaths,
    nowMs: fixture.nowMs - 30 * 60 * 1000,
    leaseMs: 60 * 60 * 1000,
    morningReceiptDir: path.join(fixture.runtime, "morning"),
    host: "test-host",
    isPidAlive: () => true,
  });
  const issue = (overrides = {}) =>
    governance.issueHeartbeatActivationReceipt({
      ledger: fixture.ledger,
      lease,
      capability,
      repoRoot: fixture.root,
      leasePath,
      qualityReceiptPath: fixture.qualityReceiptPath,
      activationReceiptPath,
      nowMs: fixture.nowMs,
      isPidAlive: () => true,
      localHost: "test-host",
      collectHostDurability: () =>
        readyHostDurabilityReceipt({
          nowMs: fixture.nowMs,
          hostname: "test-host",
        }),
      externalProofValidator: fixture.externalProofValidator,
      mutationBoundaryNowMs: fixture.nowMs,
      ...overrides,
    });
  return {
    ...fixture,
    activationReceiptPath,
    capability,
    fencePath,
    issue,
    lease,
    leasePath,
  };
}

function createReceiptContext({ withPinnedBaseline = false } = {}) {
  const repoRoot = initializeGitRepository({
    files: withPinnedBaseline
      ? { x: "x\n", "baseline/receipt.json": "{\"frozen\":true}\n" }
      : { x: "x\n" },
  });
  const runtime = tempDirectory("pikiio-governance-runtime-");
  const head = governance.currentHead(repoRoot);
  const ledger = clone(LEDGER);
  ledger.baseline.startCommit = head;
  ledger.baseline.preExistingDirty = withPinnedBaseline
    ? [{
        path: "baseline/",
        ...governance.digestTree(repoRoot, "baseline/"),
        preserve: true,
        excludeFromGit: true,
        excludeFromDeploy: true,
      }]
    : [];
  ledger.phases[0].scopeBaseCommit = head;
  const phase = governance.selectActivePhase(ledger);
  const leasePath = path.join(runtime, "lease.json");
  const fencePath = path.join(runtime, "fence.json");
  const receiptPath = path.join(runtime, "receipts.jsonl");
  const qualityReceiptPath = path.join(runtime, "quality.json");
  const qualityArtifactDirectory = path.join(runtime, "quality-artifacts");
  const receiptNow = "2026-07-24T04:05:00.000Z";
  const capability = "a".repeat(64);
  const lease = governance.acquireWriterLease({
    runId: "receipt-owner",
    automationId: "unit",
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
    nowMs: governance.zonedDateTimeToEpoch(
      { year: 2026, month: 7, day: 24, hour: 0, minute: 0 },
      "America/New_York",
    ),
    leaseMs: 10 * 60 * 1000,
  });
  const workspaceDigest = governance.workspaceEvidenceDigest(repoRoot);
  const candidateTree = execFileSync(
    "git",
    ["rev-parse", `${head}^{tree}`],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  governance.writeQualityReceipt(
    qualityInput(ledger, phase, head, workspaceDigest, {
      candidateTree,
      qualityArtifactDirectory,
    }),
    { receiptPath: qualityReceiptPath },
  );
  return {
    repoRoot,
    runtime,
    ledger,
    phase,
    head,
    leasePath,
    receiptPath,
    qualityReceiptPath,
    qualityArtifactDirectory,
    capability,
    lease,
    receiptNow,
    cleanup() {
      try {
        governance.releaseWriterLease(lease, { capability, leasePath });
      } catch {
        // Individual tests may deliberately remove or replace the lease.
      }
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function createProductionContext() {
  const transitionFixture = createTransitionedActivationContext({
    branch: "main",
  });
  const root = transitionFixture.root;
  const bare = tempDirectory("pikiio-production-context-remote-");
  const runtime = tempDirectory("pikiio-production-context-runtime-");
  execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
  execFileSync(
    "git",
    ["checkout", "-B", "main", transitionFixture.transitionCommit],
    { cwd: root, stdio: "ignore" },
  );
  const candidateLedger = clone(transitionFixture.ledger);
  const candidatePhase = governance.selectActivePhase(candidateLedger);
  const base = candidatePhase.scopeBaseCommit;
  fs.mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  const ledgerPath = path.join(
    root,
    governance.PHASE_LEDGER_RELATIVE_PATH,
  );
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const migrationPath = "supabase/migrations/authorized.sql";
  fs.writeFileSync(path.join(root, migrationPath), "select 1;\n");
  fs.writeFileSync(
    path.join(root, "lib", "truth-attachment-production-fixture.js"),
    "module.exports = true;\n",
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "candidate"], {
    cwd: root,
    stdio: "ignore",
  });
  const candidate = governance.currentHead(root);
  const candidateTree = execFileSync(
    "git",
    ["rev-parse", `${candidate}^{tree}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const migrationHash = governance.sha256(
    fs.readFileSync(path.join(root, migrationPath)),
  );
  const sliceEntries = governance.parseGitNameStatus(
    createSealedGit({ repoRoot: root }).diff({
      from: base,
      to: candidate,
      format: "name-status-z-renames",
    }),
  );
  const sliceChangedPaths = [
    ...new Set(sliceEntries.flatMap((entry) => entry.paths)),
  ].sort();
  const sliceDiffSha256 = governance.sha256(
    createSealedGit({ repoRoot: root }).diff({
      from: base,
      to: candidate,
      format: "binary",
    }),
  );
  const qualityReceiptPath = path.join(runtime, "quality.json");
  const qualityArtifactDirectory = path.join(runtime, "quality-artifacts");
  const requiredCoverageFiles = governance.requiredCoverageFilesForPhase({
    phase: candidatePhase,
    repoRoot: root,
    externalProofValidator: transitionFixture.externalProofValidator,
    head: candidate,
  });
  const canonicalTransition = governance.validatePhaseTransitionHistory({
    ledger: candidateLedger,
    phase: candidatePhase,
    repoRoot: root,
    externalProofValidator: transitionFixture.externalProofValidator,
  });
  assert.equal(
    canonicalTransition.ok,
    true,
    JSON.stringify(canonicalTransition),
  );
  const qualityReceipt = governance.writeQualityReceipt(
    qualityInput(
      candidateLedger,
      candidatePhase,
      candidate,
      governance.cleanWorkspaceEvidenceDigest(),
      {
        candidateTree,
        sliceChangedPaths,
        sliceDiffSha256,
        requiredCoverageFiles,
        qualityArtifactDirectory,
        canonicalTransition,
      },
    ),
    { receiptPath: qualityReceiptPath },
  );
  const phaseProofBundle = buildPrechangePhaseProofBundle({
    ledger: candidateLedger,
    phase: candidatePhase,
    qualityReceipt,
    repoRoot: root,
    candidateCommit: candidate,
    observedAtMs: Date.parse("2026-07-24T03:59:00.000Z"),
  });
  const phaseProofBundlePath = path.join(runtime, "phase-proof-bundle.json");
  fs.writeFileSync(
    phaseProofBundlePath,
    `${JSON.stringify(phaseProofBundle, null, 2)}\n`,
  );
  const ledger = clone(candidateLedger);
  ledger.revision += 1;
  const phase = governance.selectActivePhase(ledger);
  phase.productionAuthority = {
    enabled: true,
    allowedLiveProbes: [],
    grant: {
      schema: "pikiio-production-grant-v3",
      candidateCommit: candidate,
      branch: "main",
      qualityReceiptSha256: qualityReceipt.receiptHash,
      phaseProofBundleSha256: phaseProofBundle.bundleHash,
      phaseCandidateReceiptSha256:
        phaseProofBundle.chain.candidate.receiptHash,
      phaseRehearsalReceiptSha256:
        phaseProofBundle.chain.rehearsal.receiptHash,
      expiresAt: "2026-07-25T00:00:00.000Z",
      migrations: [{ path: migrationPath, sha256: migrationHash }],
      deployment: { enabled: true, tree: candidateTree },
    },
  };
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  execFileSync("git", ["add", governance.PHASE_LEDGER_RELATIVE_PATH], {
    cwd: root,
  });
  execFileSync("git", ["commit", "-m", "authorization"], {
    cwd: root,
    stdio: "ignore",
  });
  const authorization = governance.currentHead(root);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: root });
  execFileSync("git", ["push", "-u", "origin", "main"], {
    cwd: root,
    stdio: "ignore",
  });
  const leasePath = path.join(runtime, "lease.json");
  const capability = "a".repeat(64);
  const lease = governance.acquireWriterLease({
    runId: "production-context",
    goalId: ledger.codexGoal.objectiveSha256,
    phaseId: phase.id,
    lane: phase.lane,
    capability,
    leasePath,
    fencePath: path.join(runtime, "fence.json"),
    startHead: authorization,
    branch: "main",
    allowedPaths: phase.allowedPaths,
    nowMs: newYorkEpoch({ hour: 0, minute: 0 }),
    leaseMs: 60_000,
    morningReceiptDir: path.join(runtime, "morning"),
  });
  const gate = (overrides = {}) => governance.evaluateProductionGate({
    ledger,
    repoRoot: root,
    goalObjective: ledger.codexGoal.objective,
    goalThreadId: ledger.codexGoal.threadId,
    lease,
    capability,
    leasePath,
    action: "deploy",
    qualityReceiptPath,
    phaseProofBundlePath,
    nowMs: Date.parse("2026-07-24T04:00:30.000Z"),
    externalProofValidator: transitionFixture.externalProofValidator,
    ...overrides,
  });
  return {
    root,
    bare,
    runtime,
    ledger,
    phase,
    candidate,
    authorization,
    candidateTree,
    migrationPath,
    migrationHash,
    qualityReceiptPath,
    qualityArtifactDirectory,
    phaseProofBundlePath,
    phaseProofBundle,
    qualityReceipt,
    leasePath,
    capability,
    lease,
    gate,
    cleanup() {
      try {
        governance.releaseWriterLease(lease, { capability, leasePath });
      } catch {
        // Failure cases may intentionally replace the lease scope.
      }
      transitionFixture.cleanup();
      fs.rmSync(bare, { recursive: true, force: true });
      fs.rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function newYorkEpoch({
  year = 2026,
  month = 7,
  day = 24,
  hour,
  minute,
  second = 0,
}) {
  return governance.zonedDateTimeToEpoch(
    { year, month, day, hour, minute, second },
    "America/New_York",
  );
}

test("checked-in ledger validates with one active phase and a typed quality plan", () => {
  const validation = governance.validatePhaseLedger(CHECKED_IN_LEDGER);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  const phase = governance.selectActivePhase(CHECKED_IN_LEDGER);
  assert.equal(phase.id, CHECKED_IN_LEDGER.activePhaseId);
  assert.equal(phase.qualityPlan.schema, "pikiio-phase-quality-plan-v2");
});

test("ledger validation rejects malformed root contracts", () => {
  assert.deepEqual(governance.validatePhaseLedger(null), {
    valid: false,
    errors: ["ledger must be an object"],
  });
  const malformed = clone(LEDGER);
  malformed.schema = "wrong";
  malformed.revision = 1;
  malformed.mission = "";
  malformed.activePhaseId = "";
  malformed.codexGoal = {};
  malformed.policy = {};
  malformed.qualityPolicy = {};
  malformed.baseline = {};
  malformed.phases = [];
  const result = governance.validatePhaseLedger(malformed);
  for (const fragment of [
    "schema",
    "revision",
    "mission",
    "activePhaseId",
    "codexGoal",
    "policy.oneWriter",
    "qualityPolicy",
    "baseline.branch",
    "baseline.startCommit",
    "phases",
  ]) {
    assert.ok(result.errors.some((message) => message.includes(fragment)), fragment);
  }
});

test("every immutable policy boolean and external-effect denial fails closed", () => {
  for (const key of Object.keys(governance.REQUIRED_POLICY_VALUES)) {
    const ledger = clone(LEDGER);
    ledger.policy[key] = !ledger.policy[key];
    const result = governance.validatePhaseLedger(ledger);
    assert.equal(result.valid, false, key);
    assert.ok(result.errors.some((message) => message.includes(`policy.${key}`)));
  }
  for (const effect of governance.REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS) {
    const ledger = clone(LEDGER);
    ledger.policy.forbiddenExternalEffects =
      ledger.policy.forbiddenExternalEffects.filter(
        (candidate) => candidate !== effect,
      );
    assert.equal(governance.validatePhaseLedger(ledger).valid, false, effect);
  }
  const reordered = clone(LEDGER);
  reordered.policy.forbiddenExternalEffects.reverse();
  assert.equal(governance.validatePhaseLedger(reordered).valid, false);
});

test("morning policy and per-phase external inheritance are immutable", () => {
  for (const mutate of [
    (ledger) => {
      ledger.policy.morningRefreshPriorityWindow.timeZone = "UTC";
    },
    (ledger) => {
      ledger.policy.morningRefreshPriorityWindow.startsAt = "06:00";
    },
    (ledger) => {
      ledger.policy.morningRefreshPriorityWindow.endsOnTerminalReceipt = false;
    },
    (ledger) => {
      ledger.policy.morningRefreshPriorityWindow.minimumBuilderSliceMinutes = 1;
    },
    (ledger) => {
      ledger.phases[0].externalEffects.inheritsGlobalForbidden = false;
    },
    (ledger) => {
      ledger.phases[0].externalEffects.allowedReadOnly = "anything";
    },
  ]) {
    const ledger = clone(LEDGER);
    mutate(ledger);
    assert.equal(governance.validatePhaseLedger(ledger).valid, false);
  }
});

test("quality evidence, trusted gates, and numerical thresholds cannot decrease", () => {
  const evidence = clone(LEDGER);
  evidence.qualityPolicy.requiredEvidence.pop();
  assert.equal(governance.validatePhaseLedger(evidence).valid, false);
  const gates = clone(LEDGER);
  gates.qualityPolicy.trustedGatePaths.pop();
  assert.equal(governance.validatePhaseLedger(gates).valid, false);
  const toolchain = clone(LEDGER);
  toolchain.qualityPolicy.approvedToolchain.nodeVersion = "v0.0.0";
  assert.equal(governance.validatePhaseLedger(toolchain).valid, false);
  for (const [key, required] of Object.entries(
    governance.REQUIRED_CRITICAL_PROFILE,
  )) {
    const ledger = clone(LEDGER);
    ledger.qualityPolicy.profiles.critical[key] = key.startsWith("maximum")
      ? required + 1
      : required - 1;
    assert.equal(governance.validatePhaseLedger(ledger).valid, false, key);
  }
  for (const key of [
    "noThresholdChangeWithBehaviorChange",
    "noTestWeakeningWithBehaviorChange",
  ]) {
    const ledger = clone(LEDGER);
    ledger.qualityPolicy[key] = false;
    assert.equal(governance.validatePhaseLedger(ledger).valid, false, key);
  }
});

test("phase registry population floors conjunctively harden the shared profile", () => {
  const base = clone(governance.REQUIRED_CRITICAL_PROFILE);
  const proofRegistry = phaseProof.loadPhaseProofRegistry();
  const governanceProfile = governance.effectiveQualityProfile(base, "GOV-00");
  const governanceFloors = proofRegistry.phases["GOV-00"].populationFloors;
  assert.equal(
    governanceProfile.minimumUnitTestsPerRun,
    Math.max(base.minimumUnitTestsPerRun, governanceFloors.unitTests),
  );
  assert.equal(
    governanceProfile.minimumMutationPopulation,
    Math.max(
      base.minimumMutationPopulation,
      governanceFloors.criticalMutants,
    ),
  );
  assert.equal(
    governanceProfile.minimumCriticalMutationPopulation,
    Math.max(
      base.minimumCriticalMutationPopulation,
      governanceFloors.criticalMutants,
    ),
  );
  assert.equal(
    governanceProfile.minimumGherkinScenarioPopulation,
    Math.max(
      base.minimumGherkinScenarioPopulation,
      governanceFloors.gherkinScenarios,
    ),
  );

  const actionProfile = governance.effectiveQualityProfile(base, "ACTION-01");
  const actionFloors = proofRegistry.phases["ACTION-01"].populationFloors;
  assert.equal(
    actionProfile.minimumUnitTestsPerRun,
    Math.max(base.minimumUnitTestsPerRun, actionFloors.unitTests),
  );
  assert.equal(
    actionProfile.minimumMutationPopulation,
    Math.max(base.minimumMutationPopulation, actionFloors.criticalMutants),
  );
  assert.equal(
    actionProfile.minimumCriticalMutationPopulation,
    Math.max(
      base.minimumCriticalMutationPopulation,
      actionFloors.criticalMutants,
    ),
  );
  assert.equal(
    actionProfile.minimumGherkinScenarioPopulation,
    Math.max(
      base.minimumGherkinScenarioPopulation,
      actionFloors.gherkinScenarios,
    ),
  );
  assert.throws(
    () => governance.effectiveQualityProfile(base, "UNKNOWN"),
    /UNKNOWN/,
  );
});

test("changed safety runtime is measured per file and deletions or symlinks fail closed", () => {
  const makePhase = (root) => {
    const phase = clone(
      LEDGER.phases.find((candidate) => candidate.id === "GOV-00"),
    );
    phase.scopeBaseCommit = governance.currentHead(root);
    return phase;
  };

  const changedRoot = initializeGitRepository({
    files: { "scripts/live-refresh.js": '"use strict";\nmodule.exports = 1;\n' },
  });
  try {
    const phase = makePhase(changedRoot);
    fs.writeFileSync(
      path.join(changedRoot, "scripts/live-refresh.js"),
      '"use strict";\nmodule.exports = 2;\n',
    );
    execFileSync("git", ["add", "."], { cwd: changedRoot });
    execFileSync("git", ["commit", "-m", "change runtime"], {
      cwd: changedRoot,
      stdio: "ignore",
    });
    const required = governance.requiredCoverageFilesForPhase({
      phase,
      repoRoot: changedRoot,
      head: governance.currentHead(changedRoot),
    });
    assert.ok(required.includes("scripts/live-refresh.js"));
    for (const staticPath of governance.QUALITY_TEST_SUITE_REGISTRY[
      phase.qualityPlan.testSuiteId
    ].coverageIncludes) {
      assert.ok(required.includes(staticPath));
    }
  } finally {
    fs.rmSync(changedRoot, { recursive: true, force: true });
  }

  for (const mode of ["deleted", "symlink"]) {
    const root = initializeGitRepository({
      files: { "scripts/live-refresh.js": '"use strict";\nmodule.exports = 1;\n' },
    });
    try {
      const phase = makePhase(root);
      fs.unlinkSync(path.join(root, "scripts/live-refresh.js"));
      if (mode === "symlink") {
        fs.symlinkSync("missing-target.js", path.join(root, "scripts/live-refresh.js"));
      }
      execFileSync("git", ["add", "-A"], { cwd: root });
      execFileSync("git", ["commit", "-m", mode], {
        cwd: root,
        stdio: "ignore",
      });
      assert.throws(
        () =>
          governance.requiredCoverageFilesForPhase({
            phase,
            repoRoot: root,
            head: governance.currentHead(root),
          }),
        (error) => error.code === "QUALITY_REQUIRED_COVERAGE_FILE_MISSING",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("validator rejects malformed nested quality, baseline, phase, and proof fields", () => {
  const ledger = clone(LEDGER);
  ledger.qualityPolicy.profiles.critical = "bad";
  ledger.baseline.preExistingDirty = [
    null,
    {
      path: "",
      algorithm: "bad",
      treeDigest: "bad",
      fileCount: -1,
      preserve: false,
      excludeFromGit: false,
      excludeFromDeploy: false,
    },
  ];
  ledger.phases[0] = {
    id: "",
    name: "",
    scopeBaseCommit: "",
    status: "bad",
    priority: "bad",
    dependsOn: "bad",
    lane: "",
    qualityProfile: "missing",
    objective: "",
    allowedActions: [],
    forbiddenActions: [],
    allowedPaths: ["../escape", "bad*middle"],
    externalEffects: null,
    stopConditions: [],
    verification: null,
    qualityPlan: null,
    productionAuthority: null,
    promotion: null,
    rollback: null,
  };
  ledger.phases.push(null);
  const result = governance.validatePhaseLedger(ledger);
  assert.equal(result.valid, false);
  for (const fragment of [
    "profiles.critical",
    "preExistingDirty[0]",
    "algorithm",
    "treeDigest",
    "fileCount",
    "phases[0].scopeBaseCommit",
    "phases[0].status",
    "allowedPaths",
    "externalEffects",
    "verification",
    "productionAuthority",
    "promotion",
    "rollback",
    "phases[6]",
  ]) {
    assert.ok(result.errors.some((message) => message.includes(fragment)), fragment);
  }
});

test("active quality plan requires every typed command and evidence field", () => {
  const cases = [
    (plan) => {
      plan.schema = "wrong";
    },
    (plan) => {
      plan.syntaxFiles = [];
    },
    (plan) => {
      plan.syntaxFiles = ["../escape.js"];
    },
    (plan) => {
      plan.testSuiteId = "arbitrary-test";
    },
    (plan) => {
      plan.gherkinCheckId = "arbitrary-check";
    },
    (plan) => {
      plan.mutationCheckId = "";
    },
    (plan) => {
      plan.focusedCheckIds = "bad";
    },
    (plan) => {
      plan.neighborCheckIds = [""];
    },
    (plan) => {
      plan.broadCheckIds = "bad";
    },
    (plan) => {
      plan.productionShapedCheckIds = ["node-arbitrary-script"];
    },
    (plan) => {
      plan.focusedCheckIds.push(plan.gherkinCheckId);
    },
    (plan) => {
      plan.naturalEvidenceRequired = "yes";
    },
    (plan) => {
      plan.browserEvidenceRequired = "yes";
    },
  ];
  for (const mutate of cases) {
    const ledger = clone(LEDGER);
    mutate(ledger.phases[0].qualityPlan);
    assert.equal(governance.validatePhaseLedger(ledger).valid, false);
  }
});

test("typed quality execution refuses unknown suite and check identifiers", () => {
  assert.throws(
    () =>
      governance.qualityUnitArgs("unknown-suite", {
        minimumLineCoveragePercent: 95,
        minimumBranchCoveragePercent: 90,
        minimumFunctionCoveragePercent: 95,
      }),
    (error) => error.code === "QUALITY_TEST_SUITE_UNKNOWN",
  );
  assert.throws(
    () =>
      governance.qualityUnitShardArgs(
        "unknown-suite",
        "unknown-shard",
        {
          minimumLineCoveragePercent: 95,
          minimumBranchCoveragePercent: 90,
          minimumFunctionCoveragePercent: 95,
        },
      ),
    (error) => error.code === "QUALITY_TEST_SUITE_UNKNOWN",
  );
  assert.throws(
    () => governance.qualityCheckCommand("unknown-check"),
    (error) => error.code === "QUALITY_CHECK_UNKNOWN",
  );
});

test("governance unit shards are immutable, exact, complete, and non-overlapping", () => {
  const suite =
    governance.QUALITY_TEST_SUITE_REGISTRY["governance-unit-v1"];
  assert.equal(
    governance.validateQualityTestSuiteShards(
      "governance-unit-v1",
      suite,
    ),
    true,
  );
  const selectedProfile = {
    minimumLineCoveragePercent: 95,
    minimumBranchCoveragePercent: 90,
    minimumFunctionCoveragePercent: 95,
  };
  for (const shard of suite.shards) {
    const args = governance.qualityUnitShardArgs(
      "governance-unit-v1",
      shard.id,
      selectedProfile,
      suite.coverageIncludes,
    );
    for (const relativePath of shard.files) {
      assert.ok(args.includes(relativePath), `${shard.id}:${relativePath}`);
    }
    for (const relativePath of shard.coverageIncludes) {
      assert.ok(
        args.includes(`--test-coverage-include=${relativePath}`),
        `${shard.id}:${relativePath}`,
      );
    }
  }

  const mutations = [
    {
      name: "tamper",
      mutate(copy) {
        copy.shards[0].unexpected = true;
      },
    },
    {
      name: "omission",
      mutate(copy) {
        copy.shards[0].files.pop();
      },
    },
    {
      name: "overlap",
      mutate(copy) {
        copy.shards[1].files.push(copy.shards[0].files[0]);
        copy.shards[1].files.sort();
      },
    },
    {
      name: "duplicate",
      mutate(copy) {
        copy.shards[0].coverageIncludes.push(
          copy.shards[0].coverageIncludes[0],
        );
      },
    },
    {
      name: "reordered",
      mutate(copy) {
        copy.shards.reverse();
      },
    },
    {
      name: "reordered suite files",
      mutate(copy) {
        copy.files.reverse();
      },
    },
    {
      name: "reordered shard files",
      mutate(copy) {
        copy.shards[0].files.reverse();
      },
    },
    {
      name: "empty",
      mutate(copy) {
        copy.shards[0].files = [];
      },
    },
    {
      name: "uncovered",
      mutate(copy) {
        copy.coverageIncludes.push("lib/unassigned-safety.js");
      },
    },
  ];
  for (const { name, mutate } of mutations) {
    const copy = clone(suite);
    mutate(copy);
    assert.throws(
      () =>
        governance.validateQualityTestSuiteShards(
          "governance-unit-v1",
          copy,
        ),
      (error) =>
        error.code === "QUALITY_TEST_SHARD_REGISTRY_INVALID",
      name,
    );
  }
  assert.throws(
    () =>
      governance.qualityUnitShardArgs(
        "governance-unit-v1",
        "missing-shard",
        selectedProfile,
        suite.coverageIncludes,
      ),
    (error) => error.code === "QUALITY_TEST_SHARD_UNKNOWN",
  );
  assert.throws(
    () =>
      governance.qualityUnitShardArgs(
        "governance-unit-v1",
        suite.shards[0].id,
        selectedProfile,
        [...suite.coverageIncludes, "lib/unassigned-safety.js"],
      ),
    (error) =>
      error.code === "QUALITY_TEST_SHARD_COVERAGE_UNASSIGNED",
  );
});

test("phase cardinality, identity, dependencies, profiles, and path rules fail closed", () => {
  const multiple = clone(LEDGER);
  multiple.phases[1].status = "active";
  multiple.phases[1].scopeBaseCommit = multiple.phases[0].scopeBaseCommit;
  multiple.phases[1].qualityPlan = clone(multiple.phases[0].qualityPlan);
  assert.equal(governance.validatePhaseLedger(multiple).valid, false);

  const wrongId = clone(LEDGER);
  wrongId.activePhaseId = "TRUTH-01";
  assert.equal(governance.validatePhaseLedger(wrongId).valid, false);

  const duplicate = clone(LEDGER);
  duplicate.phases.push(clone(duplicate.phases[0]));
  assert.equal(governance.validatePhaseLedger(duplicate).valid, false);

  const unknownDependency = clone(LEDGER);
  unknownDependency.phases[1].dependsOn = ["missing"];
  unknownDependency.phases[1].qualityProfile = "missing";
  const dependencyValidation = governance.validatePhaseLedger(unknownDependency);
  assert.equal(dependencyValidation.valid, false);
  assert.ok(
    dependencyValidation.errors.some((message) =>
      message.includes("depends on missing"),
    ),
  );

  const activeDependency = clone(LEDGER);
  activeDependency.phases[0].status = "planned";
  activeDependency.phases[1].status = "active";
  activeDependency.phases[1].scopeBaseCommit =
    activeDependency.phases[0].scopeBaseCommit;
  activeDependency.activePhaseId = "TRUTH-01";
  assert.throws(
    () => governance.selectActivePhase(activeDependency),
    (error) => error.code === "PHASE_DEPENDENCY_UNMET",
  );
  activeDependency.phases[0].status = "complete";
  assert.equal(governance.selectActivePhase(activeDependency).id, "TRUTH-01");
});

test("phase transitions advance one dependency-safe phase and change only canonical state fields", () => {
  const fixture = createTransitionedActivationContext();
  try {
    const before = clone(fixture.before);
    const previous = governance.selectActivePhase(before);
    const baseCommit = fixture.candidate;
    const qualityReceipt = fixture.qualityReceipt;
    const phaseProofEnvelope = fixture.phaseProofEnvelope;
    const externalProofValidation =
      governance.validateExternallyCertifiedPhaseProofEnvelope(
        phaseProofEnvelope,
        {
          ledger: before,
          phase: previous,
          qualityReceipt,
          repoRoot: fixture.root,
          externalProofValidator: fixture.externalProofValidator,
        },
      );
    assert.equal(
      externalProofValidation.valid,
      true,
      externalProofValidation.errors.join("\n"),
    );
    const after = clone(before);
    after.revision += 1;
    after.activePhaseId = "TRUTH-01";
    const afterPrevious = after.phases.find(
      (phase) => phase.id === previous.id,
    );
    const afterNext = after.phases.find((phase) => phase.id === "TRUTH-01");
    afterPrevious.status = "complete";
    afterPrevious.lastResult = clone(
      fixture.ledger.phases.find((phase) => phase.id === previous.id)
        .lastResult,
    );
    afterNext.status = "active";
    afterNext.scopeBaseCommit = baseCommit;
    const exact = governance.validatePhaseTransition({
      before,
      after,
      baseCommit,
      qualityReceipt,
      phaseProofEnvelope,
      externalProofValidation,
      repoRoot: fixture.root,
    });
    assert.equal(exact.valid, true, exact.errors.join("\n"));
    assert.equal(
      governance.validatePhaseTransition({
        before,
        after: before,
        baseCommit: "invalid",
        qualityReceipt: null,
        phaseProofEnvelope: null,
        externalProofValidation: null,
        repoRoot: fixture.root,
      }).valid,
      false,
    );
    const invalidBefore = clone(before);
    invalidBefore.activePhaseId = "UNKNOWN";
    assert.equal(
      governance.validatePhaseTransition({
        before: invalidBefore,
        after,
        baseCommit,
        qualityReceipt,
        phaseProofEnvelope,
        externalProofValidation,
        repoRoot: fixture.root,
      }).valid,
      false,
    );
    const invalidAfter = clone(after);
    invalidAfter.activePhaseId = "UNKNOWN";
    assert.equal(
      governance.validatePhaseTransition({
        before,
        after: invalidAfter,
        baseCommit,
        qualityReceipt,
        phaseProofEnvelope,
        externalProofValidation,
        repoRoot: fixture.root,
      }).valid,
      false,
    );

    for (const mutate of [
      (ledger) => {
        ledger.revision += 1;
      },
      (ledger) => {
        ledger.phases.find((phase) => phase.id === "TRUTH-01").allowedPaths.push(
          "unauthorized.js",
        );
      },
      (ledger) => {
        ledger.phases.find((phase) => phase.id === "GOV-00").lastResult.head =
          "b".repeat(40);
      },
    ]) {
      const changed = clone(after);
      mutate(changed);
      assert.equal(
        governance.validatePhaseTransition({
          before,
          after: changed,
          baseCommit,
          qualityReceipt,
          phaseProofEnvelope,
          externalProofValidation,
          repoRoot: fixture.root,
        }).valid,
        false,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("external proof substitution refuses every canonical repository alias", () => {
  const fixture = createTransitionedActivationContext();
  const aliasParent = tempDirectory("pikiio-canonical-alias-parent-");
  const alias = path.join(aliasParent, "canonical-repository");
  let validatorCalls = 0;
  try {
    fs.symlinkSync(ROOT, alias, "dir");
    const result =
      governance.validateExternallyCertifiedPhaseProofEnvelope(
        fixture.phaseProofEnvelope,
        {
          ledger: fixture.before,
          phase: fixture.previous,
          qualityReceipt: fixture.qualityReceipt,
          repoRoot: alias,
          externalProofValidator(input) {
            validatorCalls += 1;
            return testExternalProofValidator(input);
          },
        },
      );
    assert.equal(result.valid, false);
    assert.equal(validatorCalls, 0);
    assert.match(
      result.errors.join("\n"),
      /substitution is forbidden on canonical authority/,
    );
    const aliasGuardMutant = loadGovernanceMutant(
      "external-validator-canonical-alias-refusal",
      "identity.canonical ||",
      "false ||",
    );
    let mutantValidatorCalls = 0;
    aliasGuardMutant.validateExternallyCertifiedPhaseProofEnvelope(
      fixture.phaseProofEnvelope,
      {
        ledger: fixture.before,
        phase: fixture.previous,
        qualityReceipt: fixture.qualityReceipt,
        repoRoot: alias,
        externalProofValidator(input) {
          mutantValidatorCalls += 1;
          return testExternalProofValidator(input);
        },
      },
    );
    assert.equal(
      mutantValidatorCalls,
      1,
      "the exact alias-guard mutant must invoke substituted authority",
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(aliasParent, { recursive: true, force: true });
  }
});

test("phase transition history rejects extra commits, files, unreadable receipts, and runtime divergence", () => {
  const fixture = createTransitionedActivationContext();
  const receiptRelativePath =
    fixture.ledger.phases.find((phase) => phase.id === "GOV-00").lastResult
      .qualityReceiptPath;
  const ledgerPath = path.join(
    fixture.root,
    governance.PHASE_LEDGER_RELATIVE_PATH,
  );
  const receiptPath = path.join(fixture.root, receiptRelativePath);
  const reset = () => {
    execFileSync("git", ["reset", "--hard", fixture.transitionCommit], {
      cwd: fixture.root,
      stdio: "ignore",
    });
  };
  const amend = () => {
    execFileSync("git", ["add", "-A"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--amend", "--no-edit"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
  };
  const validate = (ledger = fixture.ledger) =>
    governance.validatePhaseTransitionHistory({
      ledger,
      phase: ledger.phases.find((phase) => phase.id === "TRUTH-01"),
      repoRoot: fixture.root,
      externalProofValidator: fixture.externalProofValidator,
    });
  try {
    assert.equal(validate().ok, true);

    fs.writeFileSync(path.join(fixture.root, "smuggled.txt"), "smuggled\n");
    amend();
    assert.equal(validate().ok, false);

    reset();
    fs.writeFileSync(receiptPath, "{not-json\n");
    amend();
    assert.equal(validate().ok, false);

    reset();
    const wrongHash = clone(fixture.qualityReceipt);
    wrongHash.receiptHash = "0".repeat(64);
    fs.writeFileSync(receiptPath, `${JSON.stringify(wrongHash, null, 2)}\n`);
    amend();
    assert.equal(validate().ok, false);

    reset();
    const divergent = clone(fixture.ledger);
    divergent.revision += 1;
    assert.equal(validate(divergent).ok, false);

    reset();
    fs.appendFileSync(ledgerPath, "\n");
    execFileSync("git", ["add", governance.PHASE_LEDGER_RELATIVE_PATH], {
      cwd: fixture.root,
    });
    execFileSync("git", ["commit", "-m", "forbidden second ledger commit"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    assert.equal(validate().ok, false);

    reset();
    const noCompletion = clone(fixture.ledger);
    noCompletion.phases.find(
      (phase) => phase.id === "GOV-00",
    ).lastResult = null;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(noCompletion, null, 2)}\n`);
    amend();
    assert.equal(validate(noCompletion).ok, false);
  } finally {
    fixture.cleanup();
  }
});

test("phase transition and activation issuers create one content-addressed, history-verifiable handoff", () => {
  const fixture = createTransitionedActivationContext();
  const previousNodeEnv = process.env.NODE_ENV;
  const leasePath = path.join(fixture.runtime, "lease.json");
  const fencePath = path.join(fixture.runtime, "fence.json");
  const activationReceiptPath = path.join(fixture.runtime, "activation.json");
  const capability = "e".repeat(64);
  let lease = null;
  try {
    process.env.NODE_ENV = "test";
    execFileSync("git", ["checkout", "--detach", fixture.candidate], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const before = JSON.parse(
      fs.readFileSync(
        path.join(fixture.root, governance.PHASE_LEDGER_RELATIVE_PATH),
        "utf8",
      ),
    );
    const previous = governance.selectActivePhase(before);
    const nowMs = Date.parse("2026-07-24T04:00:00.000Z");
    lease = governance.acquireWriterLease({
      runId: "transition-issuer",
      automationId: "governance-test",
      goalId: before.codexGoal.objectiveSha256,
      phaseId: previous.id,
      lane: previous.lane,
      branch: before.baseline.branch,
      startHead: fixture.candidate,
      allowedPaths: previous.allowedPaths,
      capability,
      leasePath,
      fencePath,
      nowMs,
      leaseMs: 120_000,
      ownerPid: process.pid,
    });
    const transition = governance.issuePhaseTransition({
      ledger: before,
      nextPhaseId: "TRUTH-01",
      lease,
      capability,
      repoRoot: fixture.root,
      leasePath,
      qualityReceiptPath: fixture.qualityReceiptPath,
      qualityArtifactDirectory: fixture.qualityArtifactDirectory,
      phaseProofBundlePath: fixture.phaseProofBundlePath,
      nowMs: nowMs + 1_000,
      isPidAlive: () => true,
      localHost: lease.host,
      externalProofValidator: fixture.externalProofValidator,
      mutationBoundaryNowMs: nowMs + 1_000,
    });
    assert.deepEqual(
      transition.changedPaths,
      [
        governance.PHASE_LEDGER_RELATIVE_PATH,
        `YLYI/09_Proof_Receipts/phase-completions/${fixture.qualityReceipt.receiptHash}.json`,
        governance.phaseProofBundleRelativePath(
          fixture.phaseProofEnvelope.envelopeHash,
        ),
      ],
    );
    execFileSync("git", ["add", ...transition.changedPaths], {
      cwd: fixture.root,
    });
    execFileSync("git", ["commit", "-m", "issued transition"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const issuedLedger = JSON.parse(
      fs.readFileSync(
        path.join(fixture.root, governance.PHASE_LEDGER_RELATIVE_PATH),
        "utf8",
      ),
    );
    const phase = governance.selectActivePhase(issuedLedger);
    const history = governance.validatePhaseTransitionHistory({
      ledger: issuedLedger,
      phase,
      repoRoot: fixture.root,
      externalProofValidator: fixture.externalProofValidator,
    });
    assert.equal(history.ok, true, JSON.stringify(history));
    assert.equal(history.qualityReceiptHash, fixture.qualityReceipt.receiptHash);
    assert.deepEqual(
      Object.keys(history).sort(),
      [
        "externalCertificationHash",
        "nextPhaseId",
        "ok",
        "parent",
        "phaseProofBundleHash",
        "phaseProofEnvelopeHash",
        "phaseProofReceiptHashes",
        "previousPhaseId",
        "qualityReceiptHash",
        "transitionCommit",
      ].sort(),
    );
    assert.ok(
      Buffer.byteLength(governance.stableJson(history), "utf8") < 2_048,
      "transition projection must stay bounded and non-recursive",
    );
    assert.equal(
      governance.stableJson(history).includes('"phaseProofBundle"'),
      false,
    );
    assert.equal(
      governance.stableJson(history).includes('"qualityReceipt"'),
      false,
    );
    const activation = governance.issueHeartbeatActivationReceipt({
      ledger: issuedLedger,
      lease,
      capability,
      repoRoot: fixture.root,
      leasePath,
      qualityReceiptPath: fixture.qualityReceiptPath,
      activationReceiptPath,
      nowMs: nowMs + 2_000,
      isPidAlive: () => true,
      localHost: lease.host,
      collectHostDurability: () =>
        readyHostDurabilityReceipt({
          nowMs: nowMs + 2_000,
          hostname: lease.host,
        }),
      externalProofValidator: fixture.externalProofValidator,
      mutationBoundaryNowMs: nowMs + 2_000,
    });
    assert.equal(
      governance.validateHeartbeatActivationReceipt(activation, {
        ledger: issuedLedger,
        phase,
        head: governance.currentHead(fixture.root),
        repoRoot: fixture.root,
        nowMs: nowMs + 3_000,
        localHost: lease.host,
        externalProofValidator: fixture.externalProofValidator,
      }).valid,
      true,
    );
    governance.releaseWriterLease(lease, {
      capability,
      leasePath,
      operationLockPath: `${leasePath}.operation-lock`,
    });
    lease = null;
  } finally {
    if (lease && fs.existsSync(leasePath)) {
      try {
        governance.releaseWriterLease(lease, {
          capability,
          leasePath,
          operationLockPath: `${leasePath}.operation-lock`,
        });
      } catch {
        // The test already reports the primary assertion.
      }
    }
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fixture.cleanup();
  }
});

test("production authority is null when disabled and strictly typed when enabled", () => {
  const nonNull = clone(LEDGER);
  nonNull.phases[0].productionAuthority.grant = {};
  assert.equal(governance.validatePhaseLedger(nonNull).valid, false);

  const malformed = clone(LEDGER);
  malformed.phases[0].productionAuthority = {
    enabled: true,
    allowedLiveProbes: [],
    grant: {
      schema: "bad",
    },
  };
  assert.equal(governance.validatePhaseLedger(malformed).valid, false);

  const base = clone(LEDGER);
  base.phases[0].productionAuthority = {
    enabled: true,
    allowedLiveProbes: [],
    grant: {
      schema: "pikiio-production-grant-v3",
      candidateCommit: "a".repeat(40),
      branch: "main",
      qualityReceiptSha256: "c".repeat(64),
      phaseProofBundleSha256: "f".repeat(64),
      phaseCandidateReceiptSha256: "1".repeat(64),
      phaseRehearsalReceiptSha256: "2".repeat(64),
      expiresAt: "2026-07-25T00:00:00.000Z",
      migrations: [{ path: "supabase/migrations/x.sql", sha256: "d".repeat(64) }],
      deployment: { enabled: true, tree: "e".repeat(40) },
    },
  };
  assert.equal(governance.validatePhaseLedger(base).valid, true);
  for (const mutate of [
    (grant) => {
      grant.candidateCommit = "bad";
    },
    (grant) => {
      grant.schema = "pikiio-production-grant-v1";
    },
    (grant) => {
      grant.branch = "feature";
    },
    (grant) => {
      grant.qualityReceiptSha256 = "bad";
    },
    (grant) => {
      grant.expiresAt = "bad";
    },
    (grant) => {
      grant.migrations = "bad";
    },
    (grant) => {
      grant.migrations = [{}];
    },
    (grant) => {
      grant.deployment = {};
    },
  ]) {
    const ledger = clone(base);
    mutate(ledger.phases[0].productionAuthority.grant);
    assert.equal(governance.validatePhaseLedger(ledger).valid, false);
  }
});

test("validator covers null roots, malformed scalars, active scope, paths, and production types", () => {
  const mutations = [
    (ledger) => {
      ledger.codexGoal = null;
    },
    (ledger) => {
      ledger.policy = null;
    },
    (ledger) => {
      ledger.qualityPolicy.profiles.critical.minimumLineCoveragePercent = "95";
    },
    (ledger) => {
      ledger.phases[0].allowedPaths[0] = "";
    },
    (ledger) => {
      ledger.phases[0].scopeBaseCommit = "bad";
    },
    (ledger) => {
      ledger.phases[0].allowedPaths = [];
    },
    (ledger) => {
      ledger.phases[0].allowedPaths = ["*"];
    },
    (ledger) => {
      ledger.baseline.preExistingDirty[0].path = "../outside/";
    },
    (ledger) => {
      ledger.phases[0].qualityPlan.focusedCheckIds = [];
    },
    (ledger) => {
      ledger.phases[0].productionAuthority.enabled = "yes";
    },
    (ledger) => {
      ledger.phases[0].productionAuthority.allowedLiveProbes = "none";
    },
  ];
  for (const mutate of mutations) {
    const ledger = clone(LEDGER);
    mutate(ledger);
    assert.equal(governance.validatePhaseLedger(ledger).valid, false);
  }
});

test("canonical ledger loading and alternate-ledger authority fail closed", () => {
  assert.equal(governance.loadPhaseLedger().schema, LEDGER.schema);
  const missing = path.join(os.tmpdir(), `pikiio-ledger-${Date.now()}.json`);
  assert.throws(
    () => governance.loadPhaseLedger(missing),
    (error) =>
      ["ALTERNATE_PHASE_LEDGER_REFUSED", "PHASE_LEDGER_MISSING"].includes(
        error.code,
      ),
  );
  const invalid = clone(LEDGER);
  invalid.schema = "invalid";
  assert.throws(
    () => governance.selectActivePhase(invalid),
    (error) => error.code === "PHASE_LEDGER_INVALID",
  );

  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.throws(
      () => governance.loadPhaseLedger(missing),
      (error) => error.code === "PHASE_LEDGER_MISSING",
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("goal guard requires exact external objective and task ID before branch checks", () => {
  const missing = governance.evaluateGoalGuard({
    ledger: LEDGER,
    repoRoot: ROOT,
  });
  assert.equal(missing.code, "CODEX_GOAL_REQUIRED");

  for (const input of [
    { goalObjective: "wrong", goalThreadId: TASK_ID },
    { goalObjective: GOAL, goalThreadId: "wrong-task" },
  ]) {
    const result = governance.evaluateGoalGuard({
      ledger: LEDGER,
      repoRoot: ROOT,
      ...input,
    });
    assert.equal(result.code, "CODEX_GOAL_MISMATCH");
  }

  const repoRoot = initializeGitRepository();
  try {
    const happy = governance.evaluateGoalGuard({
      ledger: LEDGER,
      repoRoot,
      goalObjective: GOAL,
      goalThreadId: TASK_ID,
    });
    assert.equal(happy.ok, true);
    assert.equal(happy.phase.id, LEDGER.activePhaseId);
    const direct = governance.evaluateGoalGuard({
      ledger: LEDGER,
      repoRoot,
      goalObjective: GOAL,
      goalThreadId: TASK_ID,
      productionAction: "migrate",
    });
    assert.equal(direct.code, "PRODUCTION_WRAPPER_REQUIRED");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("goal guard rejects a correct goal on the wrong branch", () => {
  const repoRoot = initializeGitRepository({ branch: "wrong" });
  try {
    const result = governance.evaluateGoalGuard({
      ledger: LEDGER,
      repoRoot,
      goalObjective: GOAL,
      goalThreadId: TASK_ID,
    });
    assert.equal(result.code, "BRANCH_MISMATCH");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("governance Git authority ignores inherited PATH and Git redirection", () => {
  const repoRoot = initializeGitRepository();
  const foreignRoot = initializeGitRepository({ branch: "foreign" });
  const fakeBin = tempDirectory("pikiio-governance-fake-git-");
  const marker = path.join(fakeBin, "executed");
  fs.writeFileSync(
    path.join(fakeBin, "git"),
    `#!/bin/sh\nprintf poison > ${JSON.stringify(marker)}\nexit 98\n`,
    { mode: 0o755 },
  );
  try {
    const result = withEnvironment(
      {
        PATH: fakeBin,
        GIT_DIR: path.join(foreignRoot, ".git"),
        GIT_OBJECT_DIRECTORY: path.join(foreignRoot, ".git", "objects"),
        GIT_WORK_TREE: foreignRoot,
        GIT_INDEX_FILE: path.join(foreignRoot, ".git", "index"),
        GIT_CONFIG_GLOBAL: path.join(fakeBin, "missing-config"),
        GIT_REPLACE_REF_BASE: "refs/poison/",
      },
      () => ({
        goal: governance.evaluateGoalGuard({
          ledger: LEDGER,
          repoRoot,
          goalObjective: GOAL,
          goalThreadId: TASK_ID,
        }),
        workspaceDigest: governance.workspaceEvidenceDigest(repoRoot),
      }),
    );
    assert.equal(result.goal.ok, true);
    assert.match(result.workspaceDigest, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(foreignRoot, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("ancestry normalizes only an exact missing commit and propagates other Git failures", () => {
  const repoRoot = initializeGitRepository();
  const configPath = path.join(repoRoot, ".git", "config");
  try {
    const head = governance.currentHead(repoRoot);
    assert.equal(
      governance.commitIsAncestor("0".repeat(40), head, repoRoot),
      false,
    );
    const originalConfig = fs.readFileSync(configPath);
    fs.writeFileSync(configPath, "[invalid git config\n");
    assert.throws(
      () => governance.commitIsAncestor(head, head, repoRoot),
      (error) =>
        error.code === "SEALED_GIT_COMMAND_FAILED" &&
        error.details?.operation === "repository-root",
    );
    fs.writeFileSync(configPath, originalConfig);
    assert.equal(governance.commitIsAncestor(head, head, repoRoot), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("tree digest is deterministic and rejects missing or non-file entries", () => {
  const root = tempDirectory("pikiio-tree-");
  try {
    fs.mkdirSync(path.join(root, "tree", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "tree", "b"), "two");
    fs.writeFileSync(path.join(root, "tree", "a"), "one");
    fs.writeFileSync(path.join(root, "tree", "nested", "c"), "three");
    const first = governance.digestTree(root, "tree/");
    assert.deepEqual(first, governance.digestTree(root, "tree"));
    assert.equal(first.fileCount, 3);
    fs.writeFileSync(path.join(root, "tree", "a"), "changed");
    assert.notEqual(governance.digestTree(root, "tree").treeDigest, first.treeDigest);
    assert.throws(
      () => governance.digestTree(root, "missing"),
      (error) => error.code === "PINNED_TREE_MISSING",
    );
    assert.throws(
      () => governance.digestTree(root, "../"),
      (error) => error.code === "PINNED_TREE_MISSING",
    );
    fs.symlinkSync(path.join(root, "tree", "a"), path.join(root, "tree", "link"));
    assert.throws(
      () => governance.digestTree(root, "tree"),
      (error) => error.code === "PINNED_TREE_UNSUPPORTED_ENTRY",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git status parser preserves both rename paths in text and NUL formats", () => {
  assert.deepEqual(
    governance.parseGitStatus(" M one.js\nR  old.js -> new.js\n?? dir/x\n"),
    [
      { status: " M", path: "one.js", paths: ["one.js"], raw: " M one.js" },
      {
        status: "R ",
        path: "new.js",
        paths: ["old.js", "new.js"],
        raw: "R  old.js -> new.js",
      },
      { status: "??", path: "dir/x", paths: ["dir/x"], raw: "?? dir/x" },
    ],
  );
  assert.deepEqual(
    governance.parseGitStatus("R  new.js\0old.js\0 M one.js\0"),
    [
      {
        status: "R ",
        path: "new.js",
        paths: ["old.js", "new.js"],
        raw: "R  old.js -> new.js",
      },
      { status: " M", path: "one.js", paths: ["one.js"], raw: " M one.js" },
    ],
  );
  assert.throws(
    () => governance.parseGitStatus("R  new.js\0"),
    (error) => error.code === "GIT_STATUS_INVALID",
  );
  assert.equal(
    governance.parseGitStatus(' M "space\\tname.js"\n')[0].path,
    "space\tname.js",
  );
  assert.equal(
    governance.parseGitStatus(' M "bad\\q"\n')[0].path,
    '"bad\\q"',
  );
});

test("Git name-status parser covers modification, rename, copy, malformed, and text", () => {
  assert.deepEqual(
    governance.parseGitNameStatus("M\0one.js\0R100\0old.js\0new.js\0"),
    [
      { status: "M", path: "one.js", paths: ["one.js"], raw: "M\tone.js" },
      {
        status: "R100",
        path: "new.js",
        paths: ["old.js", "new.js"],
        raw: "R100\told.js\tnew.js",
      },
    ],
  );
  assert.deepEqual(governance.parseGitNameStatus("C100\told\tnew\n"), [
    {
      status: "C100",
      path: "new",
      paths: ["old", "new"],
      raw: "C100\told\tnew",
    },
  ]);
  assert.throws(
    () => governance.parseGitNameStatus("M\0"),
    (error) => error.code === "GIT_DIFF_STATUS_INVALID",
  );
  assert.throws(
    () => governance.parseGitNameStatus("R100\0old\0"),
    (error) => error.code === "GIT_DIFF_STATUS_INVALID",
  );
});

test("path rules distinguish exact, directory, and explicit prefix wildcard", () => {
  const rules = ["exact.js", "directory/", "lib/truth-*"];
  assert.equal(governance.pathAllowed("exact.js", rules), true);
  assert.equal(governance.pathAllowed("exact.js/child", rules), false);
  assert.equal(governance.pathAllowed("directory/child", rules), true);
  assert.equal(governance.pathAllowed("lib/truth-x.js", rules), true);
  assert.equal(governance.pathAllowed("lib/other.js", rules), false);
  assert.equal(
    governance.entryAllowed(
      { paths: ["forbidden.js", "exact.js"] },
      rules,
    ),
    false,
  );
});

test("dirty guard checks pinned data, working paths, rename sources, and committed history", () => {
  const root = tempDirectory("pikiio-dirty-");
  try {
    fs.mkdirSync(path.join(root, "baseline"));
    fs.writeFileSync(path.join(root, "baseline", "receipt"), "frozen");
    const digest = governance.digestTree(root, "baseline");
    const ledger = clone(LEDGER);
    ledger.baseline.preExistingDirty = [{
      path: "baseline/",
      algorithm: digest.algorithm,
      treeDigest: digest.treeDigest,
      fileCount: digest.fileCount,
      preserve: true,
      excludeFromGit: true,
      excludeFromDeploy: true,
    }];
    const phase = clone(ledger.phases[0]);
    phase.allowedPaths = ["allowed.js", "allowed/"];
    const clean = governance.evaluateDirtyGuard({
      ledger,
      phase,
      repoRoot: root,
      statusOutput: " M allowed.js\n?? allowed/x\n",
      committedOutput: "M\tallowed.js\n",
    });
    assert.equal(clean.ok, true);
    const blocked = governance.evaluateDirtyGuard({
      ledger,
      phase,
      repoRoot: root,
      statusOutput: "R  forbidden.js -> allowed.js\n",
      committedOutput: "M\tforbidden.js\n",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.working.blocked.length, 1);
    assert.equal(blocked.committed.blocked.length, 1);
    fs.writeFileSync(path.join(root, "baseline", "receipt"), "mutated");
    const changed = governance.evaluateDirtyGuard({
      ledger,
      phase,
      repoRoot: root,
      statusOutput: "",
      committedOutput: "",
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.baselineErrors.length, 1);
    fs.rmSync(path.join(root, "baseline"), { recursive: true });
    const missing = governance.evaluateDirtyGuard({
      ledger,
      phase,
      repoRoot: root,
      statusOutput: "",
      committedOutput: "",
    });
    assert.match(missing.baselineErrors[0].error, /missing/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-governance phases cannot mutate trusted quality gates", () => {
  const ledger = clone(LEDGER);
  ledger.baseline.preExistingDirty = [];
  const phase = clone(ledger.phases[0]);
  phase.lane = "truth";
  phase.allowedPaths = ["lib/pikiio-agent-governance.js"];
  const result = governance.evaluateDirtyGuard({
    ledger,
    phase,
    repoRoot: ROOT,
    statusOutput: " M lib/pikiio-agent-governance.js\n",
    committedOutput: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.trustedGateMutations.length, 1);
});

test("workspace evidence digest changes for unstaged, staged, and untracked content", () => {
  const root = initializeGitRepository();
  try {
    const clean = governance.workspaceEvidenceDigest(root);
    fs.writeFileSync(path.join(root, "x"), "changed\n");
    const unstaged = governance.workspaceEvidenceDigest(root);
    assert.notEqual(unstaged, clean);
    execFileSync("git", ["add", "x"], { cwd: root });
    const staged = governance.workspaceEvidenceDigest(root);
    assert.notEqual(staged, clean);
    fs.writeFileSync(path.join(root, "new"), "new\n");
    const untracked = governance.workspaceEvidenceDigest(root);
    assert.notEqual(untracked, staged);
    fs.symlinkSync(path.join(root, "x"), path.join(root, "untracked-link"));
    const nonFile = governance.workspaceEvidenceDigest(root);
    assert.notEqual(nonFile, untracked);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PID liveness and nested TMS lock precedence fail closed", () => {
  assert.equal(governance.pidAlive(0), false);
  assert.equal(governance.pidAlive(123, () => {}), true);
  assert.equal(governance.pidAlive(123, () => {
    const error = new Error("gone");
    error.code = "ESRCH";
    throw error;
  }), false);
  assert.equal(governance.pidAlive(123, () => {
    const error = new Error("denied");
    error.code = "EPERM";
    throw error;
  }), true);
  assert.throws(() => governance.pidAlive(123, () => {
    const error = new Error("unknown");
    error.code = "EIO";
    throw error;
  }), /unknown/);
  assert.equal(governance.shouldReclaimNestedTmsLock({
    ageExpired: true,
    pidPresent: true,
    pidIsAlive: true,
  }), false);
  assert.equal(governance.shouldReclaimNestedTmsLock({
    ageExpired: false,
    pidPresent: true,
    pidIsAlive: false,
  }), true);
  assert.equal(governance.shouldReclaimNestedTmsLock({
    ageExpired: true,
    pidPresent: false,
    pidIsAlive: false,
  }), true);
  assert.equal(governance.shouldReclaimNestedTmsLock({
    ageExpired: false,
    pidPresent: false,
    pidIsAlive: false,
  }), false);
});

test("serialized operation lock refuses overlap and detects ownership replacement", () => {
  const root = tempDirectory("pikiio-operation-lock-");
  const lockPath = path.join(root, "operation.lock");
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ lockId: "existing" }), {
      mode: 0o600,
    });
    assert.throws(
      () => governance.withOperationLock(lockPath, () => {}),
      (error) => error.code === "WRITER_OPERATION_BUSY",
    );
    fs.unlinkSync(lockPath);
    assert.throws(
      () => governance.withOperationLock(lockPath, () => {
        fs.writeFileSync(lockPath, JSON.stringify({ lockId: "intruder" }));
      }),
      (error) => error.code === "WRITER_OPERATION_LOCK_LOST",
    );
    fs.unlinkSync(lockPath);
    assert.throws(
      () => governance.withOperationLock(lockPath, () => {
        fs.unlinkSync(lockPath);
      }),
      (error) => error.code === "WRITER_OPERATION_LOCK_LOST",
    );
    assert.throws(
      () => governance.withOperationLock(lockPath, () => Promise.resolve()),
      (error) => error.code === "ASYNC_OPERATION_LOCK_CALLBACK_REFUSED",
    );
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("New York conversion is exact across ordinary and DST transition dates", () => {
  for (const sample of [
    { year: 2026, month: 7, day: 24, hour: 5, minute: 45 },
    { year: 2026, month: 3, day: 8, hour: 5, minute: 45 },
    { year: 2026, month: 11, day: 1, hour: 5, minute: 45 },
  ]) {
    const epoch = governance.zonedDateTimeToEpoch(
      sample,
      "America/New_York",
    );
    const parts = governance.zonedParts(epoch, "America/New_York");
    for (const key of ["year", "month", "day", "hour", "minute"]) {
      assert.equal(parts[key], sample[key], `${JSON.stringify(sample)} ${key}`);
    }
  }
  assert.throws(
    () => governance.zonedDateTimeToEpoch(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    ),
    (error) => error.code === "TIME_ZONE_CONVERSION_FAILED",
  );
});

test("morning priority handles 05:44:59, 05:45:00, minimum slice, cap, and exemption", () => {
  const root = tempDirectory("pikiio-morning-priority-");
  try {
    const atBoundary = governance.evaluateMorningPriority({
      lane: "builder",
      requestedLeaseMs: 60_000,
      nowMs: newYorkEpoch({ hour: 5, minute: 45 }),
      morningReceiptDir: root,
    });
    assert.equal(atBoundary.code, "MORNING_PRIORITY_WINDOW_ACTIVE");

    const oneSecondBefore = governance.evaluateMorningPriority({
      lane: "builder",
      requestedLeaseMs: 60_000,
      nowMs: newYorkEpoch({ hour: 5, minute: 44, second: 59 }),
      morningReceiptDir: root,
    });
    assert.equal(oneSecondBefore.code, "MORNING_PRIORITY_TOO_CLOSE");

    const capped = governance.evaluateMorningPriority({
      lane: "builder",
      requestedLeaseMs: 3 * 60 * 60 * 1000,
      nowMs: newYorkEpoch({ hour: 5, minute: 0 }),
      morningReceiptDir: root,
    });
    assert.equal(capped.allowed, true);
    assert.equal(capped.leaseMs, 45 * 60 * 1000);

    const ordinary = governance.evaluateMorningPriority({
      lane: "builder",
      requestedLeaseMs: 10 * 60 * 1000,
      nowMs: newYorkEpoch({ hour: 1, minute: 0 }),
      morningReceiptDir: root,
    });
    assert.equal(ordinary.allowed, true);
    assert.equal(ordinary.leaseMs, 10 * 60 * 1000);

    const morning = governance.evaluateMorningPriority({
      lane: "morning-refresh",
      requestedLeaseMs: 3 * 60 * 60 * 1000,
      nowMs: newYorkEpoch({ hour: 6, minute: 0 }),
      morningReceiptDir: root,
    });
    assert.equal(morning.allowed, true);
    assert.equal(morning.reason, "morning-refresh-exempt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("valid failed morning receipt ends exclusivity while malformed receipts do not", () => {
  const root = tempDirectory("pikiio-morning-receipt-");
  const nowMs = newYorkEpoch({ hour: 6, minute: 0 });
  try {
    const receipt = governance.writeMorningTerminalReceipt({
      runId: "morning",
      leaseFence: 3,
      result: "failed",
      truthPublished: false,
      startedAt: new Date(newYorkEpoch({ hour: 5, minute: 50 })).toISOString(),
      finishedAt: new Date(nowMs).toISOString(),
      detail: "truth remains degraded",
    }, { nowMs, morningReceiptDir: root });
    assert.equal(
      governance.validateMorningTerminalReceipt(receipt, "2026-07-24", {
        nowMs,
      }),
      true,
    );
    const futureDated = resign({
      ...receipt,
      finishedAt: new Date(nowMs + 60_000).toISOString(),
    });
    assert.equal(
      governance.validateMorningTerminalReceipt(futureDated, "2026-07-24", {
        nowMs,
      }),
      false,
    );
    const inverted = resign({
      ...receipt,
      startedAt: new Date(nowMs + 1).toISOString(),
    });
    assert.equal(
      governance.validateMorningTerminalReceipt(inverted, "2026-07-24", {
        nowMs,
      }),
      false,
    );
    const allowed = governance.evaluateMorningPriority({
      lane: "builder",
      requestedLeaseMs: 60_000,
      nowMs,
      morningReceiptDir: root,
    });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, "morning-terminal-receipt-present");

    const stored = governance.readMorningTerminalReceipt({
      nowMs,
      morningReceiptDir: root,
    });
    const tampered = { ...stored.receipt, detail: "tampered" };
    fs.writeFileSync(stored.receiptPath, JSON.stringify(tampered));
    const refused = governance.evaluateMorningPriority({
      lane: "builder",
      requestedLeaseMs: 60_000,
      nowMs,
      morningReceiptDir: root,
    });
    assert.equal(refused.allowed, false);
    assert.equal(refused.code, "MORNING_PRIORITY_WINDOW_ACTIVE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-boundary and wrong-date morning receipts never authorize a builder", () => {
  const root = tempDirectory("pikiio-morning-invalid-");
  try {
    const before = newYorkEpoch({ hour: 5, minute: 30 });
    const receipt = governance.writeMorningTerminalReceipt({
      runId: "early",
      leaseFence: 1,
      result: "succeeded",
      truthPublished: true,
      startedAt: new Date(before - 60_000).toISOString(),
      finishedAt: new Date(before).toISOString(),
      detail: "too early",
    }, { nowMs: before, morningReceiptDir: root });
    assert.equal(
      governance.validateMorningTerminalReceipt(receipt, "2026-07-24"),
      false,
    );
    const after = newYorkEpoch({ hour: 6, minute: 0 });
    assert.equal(
      governance.evaluateMorningPriority({
        lane: "builder",
        requestedLeaseMs: 60_000,
        nowMs: after,
        morningReceiptDir: root,
      }).allowed,
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("morning receipt store is append-like, validates JSON, and refuses incomplete evidence", () => {
  const root = tempDirectory("pikiio-morning-store-");
  const nowMs = newYorkEpoch({ hour: 6, minute: 15 });
  const input = {
    runId: "morning-store",
    leaseFence: 9,
    result: "blocked",
    truthPublished: false,
    startedAt: new Date(nowMs - 60_000).toISOString(),
    finishedAt: new Date(nowMs).toISOString(),
    detail: "external service refused access",
  };
  try {
    const first = governance.writeMorningTerminalReceipt(input, {
      nowMs,
      morningReceiptDir: root,
    });
    const second = governance.writeMorningTerminalReceipt(
      { ...input, detail: "attempted overwrite" },
      { nowMs, morningReceiptDir: root },
    );
    assert.deepEqual(second, first);

    const stored = governance.readMorningTerminalReceipt({
      nowMs,
      morningReceiptDir: root,
    });
    fs.writeFileSync(stored.receiptPath, "{bad");
    const invalidJson = governance.readMorningTerminalReceipt({
      nowMs,
      morningReceiptDir: root,
    });
    assert.equal(invalidJson.valid, false);
    assert.equal(invalidJson.invalidReceipts.length, 1);
    assert.throws(
      () => governance.writeMorningTerminalReceipt(input, {
        nowMs,
        morningReceiptDir: root,
      }),
      (error) => error instanceof SyntaxError,
    );
    fs.rmSync(stored.receiptPath);
    assert.throws(
      () => governance.writeMorningTerminalReceipt({
        ...input,
        runId: "future",
        finishedAt: new Date(nowMs + 60_000).toISOString(),
      }, {
        nowMs,
        morningReceiptDir: root,
      }),
      (error) => error.code === "MORNING_TERMINAL_RECEIPT_INCOMPLETE",
    );
    assert.throws(
      () => governance.writeMorningTerminalReceipt({
        ...input,
        runId: "inverted",
        startedAt: new Date(nowMs + 1).toISOString(),
      }, {
        nowMs,
        morningReceiptDir: root,
      }),
      (error) => error.code === "MORNING_TERMINAL_RECEIPT_INCOMPLETE",
    );
    assert.throws(
      () => governance.writeMorningTerminalReceipt({
        runId: "",
        leaseFence: 0,
        result: "",
        startedAt: "",
      }, {
        nowMs,
        morningReceiptDir: root,
      }),
      (error) => error.code === "MORNING_TERMINAL_RECEIPT_INCOMPLETE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writer lease validates scope, goal, capability, duration, renewal, and release", () => {
  const root = tempDirectory("pikiio-lease-contract-");
  const leasePath = path.join(root, "lease.json");
  const fencePath = path.join(root, "fence.json");
  const capability = "a".repeat(64);
  try {
    for (const operation of [
      () => governance.acquireWriterLease({
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "",
        lane: "",
        capability,
        leasePath,
        fencePath,
      }),
      () => governance.acquireWriterLease({
        goalId: "bad",
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability,
        leasePath,
        fencePath,
      }),
      () => governance.acquireWriterLease({
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability: "bad",
        leasePath,
        fencePath,
      }),
      () => governance.acquireWriterLease({
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability,
        leasePath,
        fencePath,
        leaseMs: 1,
      }),
      () => governance.acquireWriterLease({
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability,
        leasePath,
        fencePath,
        leaseMs: 5 * 60 * 60 * 1000,
      }),
      () => governance.acquireWriterLease({
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability,
        leasePath,
        fencePath,
        leaseMs: 1_000,
        maximumLeaseMs: governance.MAXIMUM_LEASE_MS + 1,
      }),
    ]) {
      assert.throws(operation);
    }
    const lease = governance.acquireWriterLease({
      runId: "owner",
      goalId: LEDGER.codexGoal.objectiveSha256,
      phaseId: "GOV-00",
      lane: "morning-refresh",
      capability,
      leasePath,
      fencePath,
      nowMs: 1_000,
      leaseMs: 2_000,
      maximumLeaseMs: 10_000,
    });
    assert.equal(lease.schema, "pikiio-writer-lease-v2");
    assert.equal(lease.capabilitySha256, governance.sha256(capability));
    assert.equal(governance.validateWriterLease(lease).valid, true);
    assert.throws(
      () => governance.releaseWriterLease(
        { ...lease, phaseId: "forged" },
        { capability, leasePath },
      ),
      (error) => error.code === "WRITER_LEASE_LOST",
    );
    const renewed = governance.renewWriterLease(lease, {
      capability,
      leasePath,
      nowMs: 2_000,
      leaseMs: 5_000,
    });
    assert.equal(renewed.expiresAt, new Date(7_000).toISOString());
    assert.throws(
      () => governance.renewWriterLease(lease, {
        capability: "b".repeat(64),
        leasePath,
        nowMs: 3_000,
        leaseMs: 1_000,
      }),
      (error) => error.code === "WRITER_LEASE_LOST",
    );
    assert.deepEqual(
      governance.releaseWriterLease(lease, { capability, leasePath }),
      { released: true, runId: "owner", fence: 1 },
    );
    assert.throws(
      () => governance.releaseWriterLease(lease, { capability, leasePath }),
      (error) => error.code === "WRITER_LEASE_MISSING_ON_RELEASE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writer lease schema and time bounds fail closed before ownership checks", () => {
  assert.equal(governance.validateWriterLease(null).valid, false);
  const malformed = {
    schema: "wrong",
    runId: "run",
    host: "host",
    automationId: "automation",
    phaseId: "GOV-00",
    lane: "autonomy-governance",
    fence: 1,
    ownerPid: 1,
    goalId: "a".repeat(64),
    capabilitySha256: "b".repeat(64),
    branch: "branch",
    startHead: "c".repeat(40),
    allowedPaths: [],
    morningPriority: {},
    acquiredAt: "2026-07-24T06:00:00.000Z",
    lastRenewedAt: "2026-07-24T05:00:00.000Z",
    expiresAt: "2026-07-24T04:00:00.000Z",
    maxExpiresAt: "2026-07-24T03:00:00.000Z",
  };
  const validation = governance.validateWriterLease(malformed);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("writer lease schema is invalid"));
  assert.ok(validation.errors.includes("writer lease time bounds are invalid"));
});

test("builder acquisition and renewal are both refused by morning priority", () => {
  const root = tempDirectory("pikiio-lease-morning-refusal-");
  const leasePath = path.join(root, "lease.json");
  const fencePath = path.join(root, "fence.json");
  const morningReceiptDir = path.join(root, "morning");
  const capability = "a".repeat(64);
  try {
    assert.throws(
      () => governance.acquireWriterLease({
        runId: "at-boundary",
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "autonomous-governance",
        capability,
        leasePath,
        fencePath,
        morningReceiptDir,
        nowMs: newYorkEpoch({ hour: 5, minute: 45 }),
        leaseMs: 60_000,
      }),
      (error) => error.code === "MORNING_PRIORITY_WINDOW_ACTIVE",
    );
    const lease = governance.acquireWriterLease({
      runId: "before-boundary",
      goalId: LEDGER.codexGoal.objectiveSha256,
      phaseId: "GOV-00",
      lane: "autonomous-governance",
      capability,
      leasePath,
      fencePath,
      morningReceiptDir,
      nowMs: newYorkEpoch({ hour: 5, minute: 0 }),
      leaseMs: (44 * 60 + 30) * 1000,
    });
    assert.throws(
      () => governance.renewWriterLease(lease, {
        capability,
        leasePath,
        morningReceiptDir,
        nowMs: newYorkEpoch({ hour: 5, minute: 44 }),
        leaseMs: 60_000,
      }),
      (error) => error.code === "MORNING_PRIORITY_TOO_CLOSE",
    );
    governance.releaseWriterLease(lease, { capability, leasePath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live holder wins over timestamp; dead holder reclaims only after expiry with new fence", () => {
  const root = tempDirectory("pikiio-lease-liveness-");
  const leasePath = path.join(root, "lease.json");
  const fencePath = path.join(root, "fence.json");
  try {
    const first = governance.acquireWriterLease({
      runId: "first",
      goalId: LEDGER.codexGoal.objectiveSha256,
      phaseId: "GOV-00",
      lane: "morning-refresh",
      capability: "a".repeat(64),
      leasePath,
      fencePath,
      host: "same",
      ownerPid: 101,
      nowMs: 1_000,
      leaseMs: 2_000,
      isPidAlive: () => true,
    });
    assert.throws(
      () => governance.acquireWriterLease({
        runId: "live-contender",
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability: "b".repeat(64),
        leasePath,
        fencePath,
        host: "same",
        ownerPid: 202,
        nowMs: 4_000,
        leaseMs: 2_000,
        isPidAlive: () => true,
      }),
      (error) => error.code === "WRITER_LEASE_BUSY" && error.details.pidAlive,
    );
    fs.writeFileSync(leasePath, `${JSON.stringify({
      ...first,
      ownerPid: 101,
    })}\n`);
    assert.throws(
      () => governance.acquireWriterLease({
        runId: "early",
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability: "b".repeat(64),
        leasePath,
        fencePath,
        host: "same",
        ownerPid: 202,
        nowMs: 2_000,
        leaseMs: 2_000,
        isPidAlive: () => false,
      }),
      (error) => error.code === "WRITER_LEASE_BUSY",
    );
    const reclaimed = governance.acquireWriterLease({
      runId: "reclaimed",
      goalId: LEDGER.codexGoal.objectiveSha256,
      phaseId: "GOV-00",
      lane: "morning-refresh",
      capability: "b".repeat(64),
      leasePath,
      fencePath,
      host: "same",
      ownerPid: 202,
      nowMs: 4_000,
      leaseMs: 2_000,
      isPidAlive: () => false,
    });
    assert.equal(reclaimed.fence, first.fence + 1);
    governance.releaseWriterLease(reclaimed, {
      capability: "b".repeat(64),
      leasePath,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("foreign, malformed, corrupt-fence, and maximum-lifetime lease states fail closed", () => {
  const root = tempDirectory("pikiio-lease-fail-closed-");
  const leasePath = path.join(root, "lease.json");
  const fencePath = path.join(root, "fence.json");
  const capability = "a".repeat(64);
  try {
    governance.acquireWriterLease({
      runId: "foreign",
      goalId: LEDGER.codexGoal.objectiveSha256,
      phaseId: "GOV-00",
      lane: "morning-refresh",
      capability,
      leasePath,
      fencePath,
      host: "host-a",
      ownerPid: 101,
      nowMs: 1_000,
      leaseMs: 1_000,
      isPidAlive: () => false,
    });
    assert.throws(
      () => governance.acquireWriterLease({
        runId: "local",
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability: "b".repeat(64),
        leasePath,
        fencePath,
        host: "host-b",
        ownerPid: 202,
        nowMs: 5_000,
        leaseMs: 1_000,
        isPidAlive: () => false,
      }),
      (error) => error.code === "WRITER_LEASE_BUSY",
    );
    fs.writeFileSync(leasePath, "{bad");
    assert.throws(
      () => governance.readLease(leasePath),
      (error) => error.code === "WRITER_LEASE_INVALID",
    );
    fs.writeFileSync(leasePath, `${JSON.stringify({
      schema: "pikiio-writer-lease-v2",
      runId: "malformed",
      expiresAt: new Date(0).toISOString(),
    })}\n`);
    assert.throws(
      () => governance.readLease(leasePath),
      (error) =>
        error.code === "WRITER_LEASE_INVALID" &&
        Array.isArray(error.details.errors),
    );
    fs.unlinkSync(leasePath);
    fs.writeFileSync(fencePath, JSON.stringify({ fence: -1 }));
    assert.throws(
      () => governance.acquireWriterLease({
        runId: "bad-fence",
        goalId: LEDGER.codexGoal.objectiveSha256,
        phaseId: "GOV-00",
        lane: "morning-refresh",
        capability,
        leasePath,
        fencePath,
        leaseMs: 1_000,
      }),
      (error) => error.code === "WRITER_FENCE_INVALID",
    );
    assert.equal(fs.existsSync(leasePath), false);

    fs.writeFileSync(fencePath, JSON.stringify({ fence: 0 }));
    const lease = governance.acquireWriterLease({
      runId: "maximum",
      goalId: LEDGER.codexGoal.objectiveSha256,
      phaseId: "GOV-00",
      lane: "morning-refresh",
      capability,
      leasePath,
      fencePath,
      nowMs: 1_000,
      leaseMs: 1_000,
      maximumLeaseMs: 2_000,
    });
    assert.throws(
      () => governance.renewWriterLease(lease, {
        capability,
        leasePath,
        nowMs: 3_000,
        leaseMs: 1_000,
      }),
      (error) => error.code === "WRITER_LEASE_EXPIRED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality receipt hashes contents and validates every binding and metric", () => {
  const root = tempDirectory("pikiio-quality-receipt-");
  const receiptPath = path.join(root, "quality.json");
  const phase = governance.selectActivePhase(LEDGER);
  try {
    const input = qualityInput(
      LEDGER,
      phase,
      "a".repeat(40),
      "b".repeat(64),
    );
    const receipt = governance.writeQualityReceipt(input, { receiptPath });
    assert.equal(
      governance.validateQualityReceipt(receipt, {
        ledger: LEDGER,
        phase,
        head: "a".repeat(40),
        workspaceDigest: "b".repeat(64),
      }).valid,
      true,
    );
    let attackerControlledRoot = clone(receipt);
    attackerControlledRoot.attackerControlledRoot = {
      acceptedByRehashedReceipt: true,
    };
    attackerControlledRoot = resign(attackerControlledRoot);
    assert.equal(
      governance.validateQualityReceipt(attackerControlledRoot, {
        ledger: LEDGER,
        phase,
        head: "a".repeat(40),
        workspaceDigest: "b".repeat(64),
      }).valid,
      false,
      "unrelated rehashed quality-receipt roots must be refused",
    );
    const missingRoot = clone(receipt);
    delete missingRoot.recordedAt;
    const missingRehashed = resign(missingRoot);
    const prototypeBearing = Object.assign(
      Object.create({ attackerControlledRoot: true }),
      clone(receipt),
    );
    const arrayRoot = Object.assign([], clone(receipt));
    const invalidRoots = [
      ["extra rehashed root", attackerControlledRoot],
      ["missing rehashed root", missingRehashed],
      ["prototype-bearing root", prototypeBearing],
      ["array root", arrayRoot],
      ["null root", null],
    ];
    for (const [name, invalidRoot] of invalidRoots) {
      assert.deepEqual(
        governance.validateQualityReceipt(invalidRoot, {
          ledger: LEDGER,
          phase,
          head: "a".repeat(40),
          workspaceDigest: "b".repeat(64),
        }),
        {
          valid: false,
          errors: ["quality receipt must have the exact plain v5 root"],
        },
        name,
      );
    }
    for (const invalidHash of ["bad", "0".repeat(64)]) {
      const changed = clone(receipt);
      changed.receiptHash = invalidHash;
      assert.equal(
        governance.validateQualityReceipt(changed, {
          ledger: LEDGER,
          phase,
          head: "a".repeat(40),
          workspaceDigest: "b".repeat(64),
        }).valid,
        false,
      );
    }
    for (const mutate of [
      (value) => {
        value.schema = "wrong";
      },
      (value) => {
        value.phaseProofRegistrySha256 = "0".repeat(64);
      },
      (value) => {
        value.ledgerRevision += 1;
      },
      (value) => {
        value.goalObjectiveSha256 = "0".repeat(64);
      },
      (value) => {
        value.phaseId = "OTHER";
      },
      (value) => {
        value.qualityProfile = "other";
      },
      (value) => {
        value.head = "0".repeat(40);
      },
      (value) => {
        value.workspaceDigest = "0".repeat(64);
      },
      (value) => {
        value.metrics = null;
      },
      (value) => {
        value.thresholds.minimumLineCoveragePercent -= 1;
      },
      (value) => {
        value.requiredCoverageFiles = value.requiredCoverageFiles.slice(1);
      },
      (value) => {
        value.metrics.perFileCoverage.repeats[0].files[0].branches = 0;
        const body = {
          requiredFiles: value.metrics.perFileCoverage.requiredFiles,
          repeats: value.metrics.perFileCoverage.repeats,
        };
        value.metrics.perFileCoverage.proofSha256 = governance.sha256(
          governance.stableJson(body),
        );
      },
      (value) => {
        value.metrics.failedTests = 1;
      },
      (value) => {
        value.metrics.skippedRequiredTests = 1;
      },
      (value) => {
        value.metrics.flakyTests = 1;
      },
      (value) => {
        value.metrics.newWarnings = 1;
      },
      (value) => {
        value.metrics.undefinedGherkinSteps = 1;
      },
      (value) => {
        value.metrics.survivedCriticalMutants = 1;
      },
      (value) => {
        value.metrics.cleanCheckoutReproduced = false;
      },
      (value) => {
        value.metrics.minimumObservedCoverage.lines = 94;
      },
      (value) => {
        value.metrics.minimumObservedMutationScore = 89;
      },
      (value) => {
        value.metrics.criticalMutantKillPercent = 99;
      },
      (value) => {
        value.metrics.gherkinPassPercent = 99;
      },
      (value) => {
        value.metrics.deterministicRepeatCount = 2;
      },
      (value) => {
        value.metrics.testsPerRun = 0;
      },
      (value) => {
        value.layers = [];
      },
      (value) => {
        value.layers[0].status = 1;
      },
      (value) => {
        value.layers.reverse();
      },
      (value) => {
        value.cleanJudge.reproduced = false;
      },
      (value) => {
        value.operationalCheckout.afterSha256 = "0".repeat(64);
      },
      (value) => {
        value.operationalCheckout.schema = "generic-checkout";
      },
      (value) => {
        value.operationalCheckout.scope = "all-files";
      },
      (value) => {
        value.automationSnapshotSha256 = "invalid";
      },
      (value) => {
        value.qualityToolchain.nodeVersion = "v0.0.0";
      },
      (value) => {
        value.qualityToolchain.toolchainSha256 = "0".repeat(64);
      },
      (value) => {
        value.dependencyManifest.manifestSha256 = "0".repeat(64);
      },
      (value) => {
        value.dependencyManifest.problemCount = 1;
      },
      (value) => {
        value.dependencyManifest.dependencies[0].overridden = "no";
      },
      (value) => {
        value.primaryJudge.worktreeHead = "0".repeat(40);
      },
      (value) => {
        value.primaryJudge.installIsolation = "none";
      },
      (value) => {
        value.primaryJudge.rawArtifact.layerCount -= 1;
      },
      (value) => {
        value.primaryJudge.rawArtifact.artifactPath = "/tmp/not-addressed.json";
      },
      (value) => {
        value.cleanJudge.worktreeTree = "0".repeat(40);
      },
      (value) => {
        value.cleanJudge.dependencyManifest.dependencies = [];
      },
      (value) => {
        value.cleanJudge.rawArtifact.byteLength = 0;
      },
      (value) => {
        value.antiWeakening.worktreeChangedPaths = ["forged.js"];
      },
      (value) => {
        value.developmentOnly = true;
      },
    ]) {
      let changed = clone(receipt);
      mutate(changed);
      changed = resign(changed);
      assert.equal(
        governance.validateQualityReceipt(changed, {
          ledger: LEDGER,
          phase,
          head: "a".repeat(40),
          workspaceDigest: "b".repeat(64),
        }).valid,
        false,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate quality stays independent from post-change natural and browser proof", () => {
  const root = tempDirectory("pikiio-candidate-quality-boundary-");
  const receiptPath = path.join(root, "quality.json");
  try {
    const { ledger, phase } = activationLedgerFixture();
    const head = "a".repeat(40);
    const workspaceDigest = "b".repeat(64);
    const input = qualityInput(ledger, phase, head, workspaceDigest);
    const receipt = governance.writeQualityReceipt(input, { receiptPath });
    const context = { ledger, phase, head, workspaceDigest };
    assert.equal(
      governance.validateQualityReceipt(receipt, context).valid,
      true,
    );
    for (const field of ["naturalEvidence", "browserEvidence"]) {
      let changed = clone(receipt);
      changed[field] = {
        status: "passed",
        receipts: [{ receiptHash: "1".repeat(64) }],
      };
      changed = resign(changed);
      assert.equal(
        governance.validateQualityReceipt(changed, context).valid,
        false,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat activation requires the exact active phase, canonical transition, automation, and time window", () => {
  const fixture = createTransitionedActivationContext();
  try {
    const context = {
      ledger: fixture.ledger,
      phase: fixture.phase,
      head: fixture.transitionCommit,
      repoRoot: fixture.root,
      nowMs: fixture.nowMs,
      localHost: "test-host",
      externalProofValidator: fixture.externalProofValidator,
    };
    const activationValidation =
      governance.validateHeartbeatActivationReceipt(
        fixture.activationReceipt,
        context,
      );
    assert.equal(
      activationValidation.valid,
      true,
      activationValidation.errors.join("\n"),
    );
    for (const mutate of [
      (receipt) => {
        receipt.expiresAt = "2026-07-24T04:59:59.000Z";
      },
      (receipt) => {
        receipt.phaseId = "ACTION-01";
      },
      (receipt) => {
        receipt.qualityReceiptHash = "0".repeat(64);
      },
      (receipt) => {
        receipt.issuerLeaseFence = 0;
      },
      (receipt) => {
        receipt.transitionCommit = fixture.candidate;
      },
      (receipt) => {
        receipt.automationContractSha256 = "0".repeat(64);
      },
      (receipt) => {
        receipt.hostDurability.ready = false;
        receipt.hostDurability.blockers = ["HOST_SERVICE_NOT_RUNNING"];
      },
    ]) {
      let changed = clone(fixture.activationReceipt);
      mutate(changed);
      changed = resign(changed);
      assert.equal(
        governance.validateHeartbeatActivationReceipt(changed, context).valid,
        false,
      );
    }
    const wrongPhase = fixture.ledger.phases.find(
      (candidate) => candidate.id === "TRUTH-02",
    );
    assert.equal(
      governance.validateHeartbeatActivationReceipt(
        fixture.activationReceipt,
        { ...context, phase: wrongPhase },
      ).valid,
      false,
    );
    const governanceActive = clone(fixture.ledger);
    governanceActive.phases.find(
      (candidate) => candidate.id === "TRUTH-01",
    ).status = "planned";
    governanceActive.phases.find(
      (candidate) => candidate.id === "GOV-00",
    ).status = "active";
    governanceActive.activePhaseId = "GOV-00";
    assert.equal(
      governance.validateHeartbeatActivationReceipt(fixture.activationReceipt, {
        ...context,
        ledger: governanceActive,
        phase: governanceActive.phases.find(
          (candidate) => candidate.id === "GOV-00",
        ),
      }).valid,
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test("activation issuance rechecks lease, expiry, HEAD, and worktree at its mutation boundary", () => {
  for (const race of [
    {
      name: "lease replacement",
      expectedCode: "WRITER_LEASE_LOST",
      apply(context) {
        return {
          mutationBoundaryHook() {
            fs.writeFileSync(
              context.leasePath,
              `${JSON.stringify({
                ...context.lease,
                fence: context.lease.fence + 1,
              })}\n`,
            );
          },
        };
      },
    },
    {
      name: "lease expiry",
      expectedCode: "WRITER_LEASE_EXPIRED",
      apply(context) {
        return {
          mutationBoundaryNowMs:
            Date.parse(context.lease.expiresAt) + 1,
        };
      },
    },
    {
      name: "HEAD change",
      expectedCode: "ACTIVATION_HEAD_CHANGED",
      apply(context) {
        return {
          mutationBoundaryHook() {
            execFileSync("git", ["commit", "--allow-empty", "-m", "race"], {
              cwd: context.root,
              stdio: "ignore",
            });
          },
        };
      },
    },
    {
      name: "worktree change",
      expectedCode: "ACTIVATION_WORKTREE_CHANGED",
      apply(context) {
        return {
          mutationBoundaryHook() {
            fs.writeFileSync(path.join(context.root, "race.txt"), "race\n");
          },
        };
      },
    },
  ]) {
    const context = createActivationIssuerContext();
    try {
      const overrides = race.apply(context);
      assert.throws(
        () => context.issue(overrides),
        (error) => error.code === race.expectedCode,
        race.name,
      );
      assert.equal(fs.existsSync(context.activationReceiptPath), false);
    } finally {
      context.cleanup();
    }
  }
});

test("post-governance CLI acquisition refuses missing or stale activation before creating authority", () => {
  const fixture = createTransitionedActivationContext();
  const codexHome = tempDirectory("pikiio-activation-preflight-home-");
  const tempLib = path.join(fixture.root, "lib");
  const tempScripts = path.join(fixture.root, "scripts");
  fs.mkdirSync(tempLib, { recursive: true });
  fs.mkdirSync(tempScripts, { recursive: true });
  for (const library of [
    "pikiio-agent-governance.js",
    "pikiio-github-oidc-collector.js",
    "pikiio-host-durability.js",
    "pikiio-phase-attestation.js",
    "pikiio-phase-proof.js",
    "pikiio-phase-proof-envelope.js",
    "pikiio-quality-canonical.js",
    "pikiio-sealed-git.js",
  ]) {
    fs.copyFileSync(
      path.join(ROOT, "lib", library),
      path.join(tempLib, library),
    );
  }
  fs.copyFileSync(
    path.join(ROOT, "scripts", "pikiio-agent-writer-lease.js"),
    path.join(tempScripts, "pikiio-agent-writer-lease.js"),
  );
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    PIKIIO_CODEX_GOAL_OBJECTIVE: fixture.ledger.codexGoal.objective,
    PIKIIO_CODEX_GOAL_THREAD_ID: fixture.ledger.codexGoal.threadId,
  };
  const runAcquire = () => {
    try {
      execFileSync(
        process.execPath,
        [
          "scripts/pikiio-agent-writer-lease.js",
          "acquire",
          "--run-id=activation-preflight",
          "--automation-id=pikiio-governed-builder-heartbeat",
          "--lease-ms=120000",
        ],
        { cwd: fixture.root, env, encoding: "utf8" },
      );
      assert.fail("activation-less acquisition unexpectedly succeeded");
    } catch (error) {
      return JSON.parse(String(error.stdout || "{}"));
    }
  };
  const runtime = path.join(codexHome, "runtime", "pikiio-agent");
  try {
    const missing = runAcquire();
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "HEARTBEAT_ACTIVATION_RECEIPT_REQUIRED");
    assert.equal(fs.existsSync(path.join(runtime, "writer-lease.json")), false);

    fs.mkdirSync(runtime, { recursive: true });
    let stale = clone(fixture.activationReceipt);
    stale.recordedAt = "2020-01-01T00:00:00.000Z";
    stale.expiresAt = "2020-01-02T00:00:00.000Z";
    stale = resign(stale);
    fs.writeFileSync(
      path.join(runtime, "heartbeat-activation-receipt.json"),
      `${JSON.stringify(stale, null, 2)}\n`,
      { mode: 0o600 },
    );
    const expired = runAcquire();
    assert.equal(expired.ok, false);
    assert.equal(expired.code, "HEARTBEAT_ACTIVATION_INVALID");
    assert.equal(fs.existsSync(path.join(runtime, "writer-lease.json")), false);
    assert.deepEqual(
      fs.readdirSync(runtime).filter((name) => name.startsWith("writer-handle-")),
      [],
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("run receipt validator requires exact safety, proof dispositions, commits, and quality", () => {
  assert.deepEqual(governance.validateRunReceipt(null), {
    valid: false,
    errors: ["receipt must be an object"],
  });
  const invalid = governance.validateRunReceipt({
    schema: "bad",
    runId: "",
    phaseRevision: 0,
    leaseFence: 0,
    host: null,
    dirtyBaseline: null,
    commands: [],
    changedPaths: "bad",
    localProof: [],
    productionProof: {},
    sourceCutProof: {},
    migrationProof: {},
    deploymentProof: {},
    browserProof: {},
    modelCostDeltaUsd: -1,
    safetyConfirmations: {},
    qualityProof: null,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length > 20);
});

test("proof dispositions require one plain exact root before content is read", () => {
  const valid = [
    proof("passed"),
    { status: "failed", receipts: [], reason: "proof failed" },
    { status: "blocked", receipts: [], reason: "external blocker" },
    proof("not_applicable"),
  ];
  for (const [index, value] of valid.entries()) {
    const errors = [];
    governance.validateProofDisposition(
      value,
      `validProof${index}`,
      errors,
    );
    assert.deepEqual(errors, []);
  }

  let contentReads = 0;
  const duplicateAlias = {
    get status() {
      contentReads += 1;
      return "passed";
    },
    receipts: [{ receiptHash: "a".repeat(64) }],
    reason: "proof completed",
    Status: "passed",
  };
  const prototypeBearing = Object.assign(
    Object.create({ inherited: "hostile" }),
    proof("passed"),
  );
  const symbolBearing = {
    ...proof("passed"),
    [Symbol("status")]: "passed",
  };
  const nonenumerableExtra = proof("passed");
  Object.defineProperty(nonenumerableExtra, "shadowStatus", {
    value: "passed",
  });
  const invalid = [
    ["null", null],
    ["array", ["passed", [], "reason"]],
    ["missing status", { receipts: [], reason: "missing" }],
    ["missing receipts", { status: "blocked", reason: "missing" }],
    ["missing reason", { status: "passed", receipts: [{}] }],
    ["unknown extra", { ...proof("passed"), extra: true }],
    ["duplicate-equivalent alias", duplicateAlias],
    ["prototype-bearing", prototypeBearing],
    ["symbol-bearing", symbolBearing],
    ["nonenumerable extra", nonenumerableExtra],
  ];
  for (const [name, value] of invalid) {
    const errors = [];
    governance.validateProofDisposition(value, "productionProof", errors);
    assert.deepEqual(
      errors,
      [
        "productionProof must be a plain object with exactly reason, receipts, and status",
      ],
      name,
    );
  }
  assert.equal(
    contentReads,
    0,
    "duplicate-equivalent roots must refuse before content getters run",
  );
});

test("critical mutant M-PROOF-DISPOSITION-EXACT-ROOT-GUARD-REMOVED is killed", () => {
  const search = "  if (!exactRoot) {";
  const mutant = loadGovernanceMutant(
    "M-PROOF-DISPOSITION-EXACT-ROOT-GUARD-REMOVED",
    search,
    "  if (false) {",
  );

  const hostile = {
    ...proof("passed"),
    Status: "passed",
  };
  const originalErrors = [];
  governance.validateProofDisposition(
    hostile,
    "productionProof",
    originalErrors,
  );
  const mutantErrors = [];
  mutant.validateProofDisposition(
    hostile,
    "productionProof",
    mutantErrors,
  );
  assert.deepEqual(originalErrors, [
    "productionProof must be a plain object with exactly reason, receipts, and status",
  ]);
  assert.deepEqual(
    mutantErrors,
    [],
    "removed exact-root guard must be observably unsafe",
  );
});

test("critical mutant quality-layer-definition-binding weakens both projections", () => {
  const mutant = loadGovernanceMutant(
    "quality-layer-definition-binding",
    "definitionSha256: layerPlanEntry.definitionSha256,",
    "",
  );
  const phase = governance.selectActivePhase(LEDGER);
  const head = "a".repeat(40);
  const workspaceDigest = "b".repeat(64);
  let forged = {
    ...qualityInput(LEDGER, phase, head, workspaceDigest),
    schema: "pikiio-quality-gauntlet-receipt-v5",
  };
  forged.layers[0].definitionSha256 = "0".repeat(64);
  forged = resign(forged);
  const context = {
    ledger: LEDGER,
    phase,
    head,
    workspaceDigest,
  };
  assert.equal(
    governance.validateQualityReceipt(forged, context).valid,
    false,
  );
  assert.equal(
    mutant.validateQualityReceipt(forged, context).valid,
    true,
    "the shared-projection mutant must expose the forged definition",
  );
});

test("mutation anchors ignore formatting only and refuse missing or ambiguous semantics", () => {
  const governanceSource = fs.readFileSync(
    path.join(ROOT, "lib", "pikiio-agent-governance.js"),
    "utf8",
  );
  const legacyByteAnchor = [
    "if (",
    "        stableJson(",
    "          receipt.layers.map(({ name, checkId, command, definitionSha256 }) => ({",
    "            name,",
    "            checkId,",
    "            command,",
    "            definitionSha256,",
    "          })),",
    "        ) !== stableJson(expectedLayers)",
    "      ) {",
  ].join("\n");
  assert.equal(
    governanceSource.includes(legacyByteAnchor),
    false,
    "the old byte-coupled anchor must reproduce its formatting failure",
  );
  const formattingTarget = [
    "        const qualityLayerPlanMatches =",
    "          stableJson(projectedLayers) ===",
    "          stableJson(projectedExpectedLayers);",
  ].join("\n");
  assert.equal(
    governanceSource.split(formattingTarget).length - 1,
    1,
  );
  const reformattedSource = governanceSource.replace(
    formattingTarget,
    [
      "        const qualityLayerPlanMatches =",
      "          stableJson(projectedLayers) === stableJson(projectedExpectedLayers);",
    ].join("\n"),
  );
  const replacement = "if (false) {";
  assert.equal(mutationHarness.qualityLayerPlanAnchors.length, 2);
  for (const [index, anchor] of
    mutationHarness.qualityLayerPlanAnchors.entries()) {
    assert.equal(governanceSource.split(anchor).length - 1, 1);
    assert.equal(reformattedSource.split(anchor).length - 1, 1);
    assert.notEqual(
      mutationHarness.replaceExactlyOnce(
        reformattedSource,
        anchor,
        replacement,
        `quality-layer-anchor-${index}`,
      ),
      reformattedSource,
    );
    assert.throws(
      () =>
        mutationHarness.replaceExactlyOnce(
          governanceSource.replace(anchor, ""),
          anchor,
          replacement,
          `quality-layer-anchor-${index}-missing`,
        ),
      (error) => error.code === "MUTATION_ANCHOR_MISSING",
    );
    assert.throws(
      () =>
        mutationHarness.replaceExactlyOnce(
          `${governanceSource}\n${anchor}`,
          anchor,
          replacement,
          `quality-layer-anchor-${index}-ambiguous`,
        ),
      (error) => error.code === "MUTATION_ANCHOR_AMBIGUOUS",
    );
  }
});

test("mutation probes use canonical repository roots while explicit aliases still refuse", () => {
  const probeOutput = execFileSync(
    process.execPath,
    [
      path.join(
        ROOT,
        "tests",
        "pikiio-agent-governance-mutant-probe.js",
      ),
      path.join(ROOT, "lib", "pikiio-agent-governance.js"),
      path.join(
        ROOT,
        "YLYI",
        "00_Product_Contract",
        "Pikiio_Agent_Phases.json",
      ),
      ROOT,
      "quality-canonical-transition-recomputation",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(probeOutput), {
    ok: true,
    checkId: "quality-canonical-transition-recomputation",
  });

  const canonicalRoot = initializeGitRepository();
  const aliasParent = tempDirectory("pikiio-mutant-alias-");
  const aliasRoot = path.join(aliasParent, "repository-alias");
  try {
    fs.symlinkSync(canonicalRoot, aliasRoot, "dir");
    assert.throws(
      () => createSealedGit({ repoRoot: aliasRoot }),
      (error) => error.code === "SEALED_GIT_REPOSITORY_ALIAS",
    );
  } finally {
    fs.rmSync(aliasParent, { recursive: true, force: true });
    fs.rmSync(canonicalRoot, { recursive: true, force: true });
  }
});

test("run receipt trusted fields are reconstructed and full chain is verified", () => {
  const context = createReceiptContext();
  try {
    const first = governance.appendRunReceipt({
      ...receiptInput(),
      runId: "forged",
      goalObjectiveSha256: "0".repeat(64),
      phaseRevision: 999,
      startingCommit: "0".repeat(40),
      host: { hostname: "forged" },
    }, {
      ledger: context.ledger,
      lease: context.lease,
      capability: context.capability,
      repoRoot: context.repoRoot,
      leasePath: context.leasePath,
      receiptPath: context.receiptPath,
      qualityReceiptPath: context.qualityReceiptPath,
      qualityArtifactDirectory: context.qualityArtifactDirectory,
      now: context.receiptNow,
    });
    assert.equal(first.runId, context.lease.runId);
    assert.equal(first.startingCommit, context.head);
    assert.equal(first.goalObjectiveSha256, context.ledger.codexGoal.objectiveSha256);
    assert.notEqual(first.host.hostname, "forged");
    const second = governance.appendRunReceipt(
      { ...receiptInput(), result: "completed-again" },
      {
        ledger: context.ledger,
        lease: context.lease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: "2026-07-24T04:06:00.000Z",
      },
    );
    assert.equal(second.previousReceiptHash, first.receiptHash);
    const chain = governance.verifyReceiptChain(context.receiptPath);
    assert.equal(chain.valid, true);
    assert.equal(chain.count, 2);
  } finally {
    context.cleanup();
  }
});

test("tampered, truncated, concurrent, wrong-capability, and missing receipt contexts refuse", () => {
  const context = createReceiptContext();
  try {
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {}),
      (error) => error.code === "RUN_RECEIPT_CONTEXT_REQUIRED",
    );
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: context.lease,
        capability: "b".repeat(64),
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
      }),
      (error) => error.code === "WRITER_LEASE_LOST",
    );
    governance.appendRunReceipt(receiptInput(), {
      ledger: context.ledger,
      lease: context.lease,
      capability: context.capability,
      repoRoot: context.repoRoot,
      leasePath: context.leasePath,
      receiptPath: context.receiptPath,
      qualityReceiptPath: context.qualityReceiptPath,
      qualityArtifactDirectory: context.qualityArtifactDirectory,
      now: context.receiptNow,
    });
    const source = fs.readFileSync(context.receiptPath, "utf8");
    fs.writeFileSync(context.receiptPath, source.trimEnd());
    assert.equal(
      governance.verifyReceiptChain(context.receiptPath).valid,
      false,
    );
    fs.writeFileSync(context.receiptPath, source);
    const lines = source.trim().split("\n");
    const receipt = JSON.parse(lines[0]);
    receipt.result = "tampered";
    fs.writeFileSync(context.receiptPath, `${JSON.stringify(receipt)}\n`);
    assert.equal(
      governance.verifyReceiptChain(context.receiptPath).valid,
      false,
    );
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: context.lease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
      }),
      (error) => error.code === "RUN_RECEIPT_CHAIN_INVALID",
    );
    fs.writeFileSync(
      `${context.receiptPath}.operation-lock`,
      JSON.stringify({ lockId: "concurrent" }),
    );
    assert.throws(
      () => governance.withOperationLock(
        `${context.receiptPath}.operation-lock`,
        () => {},
      ),
      (error) => error.code === "WRITER_OPERATION_BUSY",
    );
  } finally {
    context.cleanup();
  }
});

test("proof and safety validation rejects empty passed proof, missing reason, and partial effect map", () => {
  const context = createReceiptContext();
  try {
    const invalidInputs = [
      {
        ...receiptInput(),
        productionProof: { status: "passed", receipts: [], reason: "" },
      },
      {
        ...receiptInput(),
        productionProof: {
          status: "not_applicable",
          receipts: [],
          reason: "",
        },
      },
      {
        ...receiptInput(),
        productionProof: {
          status: "passed",
          receipts: "not-an-array",
          reason: "",
        },
      },
      {
        ...receiptInput(),
        productionProof: { status: "passed", receipts: null, reason: "" },
      },
      {
        ...receiptInput(),
        safetyConfirmations: null,
      },
      {
        ...receiptInput(),
        safetyConfirmations: {
          gmail_send: { preserved: true, evidence: "only one" },
        },
      },
      {
        ...receiptInput(),
        safetyConfirmations: Object.fromEntries(
          governance.REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS.map((effect) => [
            effect,
            { preserved: false, evidence: "" },
          ]),
        ),
      },
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => governance.appendRunReceipt(input, {
          ledger: context.ledger,
          lease: context.lease,
          capability: context.capability,
          repoRoot: context.repoRoot,
          leasePath: context.leasePath,
          receiptPath: context.receiptPath,
          qualityReceiptPath: context.qualityReceiptPath,
          qualityArtifactDirectory: context.qualityArtifactDirectory,
          now: context.receiptNow,
        }),
        (error) => error.code === "RUN_RECEIPT_INVALID",
      );
    }
  } finally {
    context.cleanup();
  }
});

test("run receipt ledger, lease, baseline, and chain bindings reject targeted forgery", () => {
  const context = createReceiptContext({ withPinnedBaseline: true });
  try {
    const receipt = governance.appendRunReceipt(receiptInput(), {
      ledger: context.ledger,
      lease: context.lease,
      capability: context.capability,
      repoRoot: context.repoRoot,
      leasePath: context.leasePath,
      receiptPath: context.receiptPath,
      qualityReceiptPath: context.qualityReceiptPath,
      qualityArtifactDirectory: context.qualityArtifactDirectory,
      now: context.receiptNow,
    });
    assert.equal(receipt.dirtyBaseline.entries.length, 1);
    assert.equal(receipt.dirtyBaseline.entries[0].path, "baseline/");

    for (const mutate of [
      (value) => {
        value.goalThreadId = "forged-thread";
      },
      (value) => {
        value.goalObjectiveSha256 = "0".repeat(64);
      },
      (value) => {
        value.phaseRevision += 1;
      },
      (value) => {
        value.phaseId = "TRUTH-01";
      },
      (value) => {
        value.runId = "foreign-run";
      },
    ]) {
      const forged = clone(receipt);
      mutate(forged);
      assert.equal(
        governance.validateRunReceipt(forged, {
          ledger: context.ledger,
          lease: context.lease,
        }).valid,
        false,
      );
    }

    fs.writeFileSync(
      path.join(context.repoRoot, "baseline", "receipt.json"),
      "{\"frozen\":false}\n",
    );
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: context.lease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: path.join(context.runtime, "changed-baseline.jsonl"),
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
      }),
      (error) => error.code === "PINNED_BASELINE_CHANGED",
    );
    fs.writeFileSync(
      path.join(context.repoRoot, "baseline", "receipt.json"),
      "{\"frozen\":true}\n",
    );

    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: { ...context.lease, phaseId: "ACTION-01" },
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: path.join(context.runtime, "scope-mismatch.jsonl"),
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
      }),
      (error) => error.code === "WRITER_LEASE_LOST",
    );

    fs.writeFileSync(
      context.leasePath,
      `${JSON.stringify({ ...context.lease, phaseId: "TRUTH-01" })}\n`,
    );
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: { ...context.lease, phaseId: "TRUTH-01" },
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: path.join(context.runtime, "persisted-scope-mismatch.jsonl"),
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
      }),
      (error) => error.code === "RUN_RECEIPT_LEASE_SCOPE_MISMATCH",
    );

    const invalidJsonPath = path.join(context.runtime, "invalid-json.jsonl");
    fs.writeFileSync(invalidJsonPath, "{bad}\n");
    const invalidJson = governance.verifyReceiptChain(invalidJsonPath);
    assert.equal(invalidJson.valid, false);
    assert.match(invalidJson.errors[0], /invalid JSON/);

    const first = {
      previousReceiptHash: null,
      result: "first",
    };
    first.receiptHash = governance.sha256(governance.stableJson(first));
    const second = {
      previousReceiptHash: "0".repeat(64),
      result: "second",
    };
    second.receiptHash = governance.sha256(governance.stableJson(second));
    const wrongPreviousPath = path.join(context.runtime, "wrong-previous.jsonl");
    fs.writeFileSync(
      wrongPreviousPath,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );
    const wrongPrevious = governance.verifyReceiptChain(wrongPreviousPath);
    assert.equal(wrongPrevious.valid, false);
    assert.ok(
      wrongPrevious.errors.some((message) => message.includes("previous hash")),
    );
  } finally {
    context.cleanup();
  }
});

test("run receipt boundary requires valid time and a live unexpired lease", () => {
  const context = createReceiptContext();
  try {
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: context.lease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: "not-a-time",
      }),
      (error) => error.code === "RUN_RECEIPT_TIME_INVALID",
    );
    const futureLease = {
      ...context.lease,
      acquiredAt: "2026-07-24T04:06:00.000Z",
      lastRenewedAt: "2026-07-24T04:06:00.000Z",
      expiresAt: "2026-07-24T04:07:00.000Z",
    };
    fs.writeFileSync(context.leasePath, `${JSON.stringify(futureLease)}\n`);
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: futureLease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
      }),
      (error) => error.code === "WRITER_LEASE_NOT_YET_VALID",
    );
    fs.writeFileSync(context.leasePath, `${JSON.stringify(context.lease)}\n`);
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: context.lease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: "2026-07-24T04:11:00.000Z",
      }),
      (error) => error.code === "WRITER_LEASE_EXPIRED",
    );
    assert.throws(
      () => governance.appendRunReceipt(receiptInput(), {
        ledger: context.ledger,
        lease: context.lease,
        capability: context.capability,
        repoRoot: context.repoRoot,
        leasePath: context.leasePath,
        receiptPath: context.receiptPath,
        qualityReceiptPath: context.qualityReceiptPath,
        qualityArtifactDirectory: context.qualityArtifactDirectory,
        now: context.receiptNow,
        isPidAlive: () => false,
      }),
      (error) => error.code === "WRITER_LEASE_OWNER_NOT_LIVE",
    );
  } finally {
    context.cleanup();
  }
});

test("host receipt exposes real topology without claiming an always-on Mac mini", () => {
  const host = governance.hostPowerReceipt();
  assert.equal(typeof host.hostname, "string");
  assert.match(host.claimedTopology, /not-certified-mac-mini-service/);
  assert.ok(["ac", "battery", "unknown"].includes(host.power));
});

test("stable JSON and SHA ignore object insertion order", () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(governance.stableJson(left), governance.stableJson(right));
  assert.equal(
    governance.sha256(governance.stableJson(left)),
    governance.sha256(governance.stableJson(right)),
  );
  assert.match(governance.createCapability(), /^[a-f0-9]{64}$/);
});

test("atomic JSON writers preserve complete bytes and refuse replacement collisions", () => {
  const root = tempDirectory("pikiio-atomic-json-");
  try {
    const replaceable = path.join(root, "replaceable.json");
    governance.writeJsonAtomic(replaceable, { generation: 1 });
    governance.writeJsonAtomic(replaceable, { generation: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(replaceable, "utf8")), {
      generation: 2,
    });
    const exclusive = path.join(root, "exclusive.json");
    governance.writeJsonExclusiveAtomic(exclusive, { authority: "first" });
    assert.throws(
      () =>
        governance.writeJsonExclusiveAtomic(exclusive, {
          authority: "second",
        }),
      (error) => error.code === "CONTENT_ADDRESSED_DESTINATION_EXISTS",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(exclusive, "utf8")), {
      authority: "first",
    });
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ["exclusive.json", "replaceable.json"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function transitionRecoveryFixture({ committed = false } = {}) {
  const repoRoot = tempDirectory("pikiio-transition-recovery-");
  const ledgerPath = path.join(
    repoRoot,
    governance.PHASE_LEDGER_RELATIVE_PATH,
  );
  const journalPath = path.join(repoRoot, ".git", "transition-journal.json");
  const completionPath =
    `YLYI/09_Proof_Receipts/phase-completions/${"a".repeat(64)}.json`;
  const bundlePath =
    `YLYI/09_Proof_Receipts/phase-proofs/${"b".repeat(64)}.json`;
  const before = { schema: "recovery-ledger", revision: 1 };
  const after = { schema: "recovery-ledger", revision: 2 };
  const current = committed ? after : before;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(current, null, 2)}\n`);
  const artifacts = [
    {
      path: completionPath,
      value: { schema: "completion", receiptHash: "a".repeat(64) },
    },
    {
      path: bundlePath,
      value: { schema: "bundle", bundleHash: "b".repeat(64) },
    },
  ];
  for (const artifact of artifacts) {
    const absolute = path.join(repoRoot, artifact.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(artifact.value, null, 2)}\n`);
    artifact.bytesSha256 = governance.sha256(fs.readFileSync(absolute));
    artifact.absolute = absolute;
  }
  const journal = resign(
    {
      schema: "pikiio-phase-transition-journal-v1",
      transactionId: "12345678-1234-4123-8123-123456789abc",
      recordedAt: "2026-07-24T04:30:00.000Z",
      beforeLedgerSha256: governance.sha256(
        governance.stableJson(before),
      ),
      afterLedgerSha256: governance.sha256(governance.stableJson(after)),
      ledgerPath: governance.PHASE_LEDGER_RELATIVE_PATH,
      completion: {
        path: completionPath,
        bytesSha256: artifacts[0].bytesSha256,
        preexisting: false,
      },
      bundle: {
        path: bundlePath,
        bytesSha256: artifacts[1].bytesSha256,
        preexisting: false,
      },
    },
    "journalHash",
  );
  governance.writeJsonExclusiveAtomic(journalPath, journal, 0o600);
  return {
    repoRoot,
    journalPath,
    ledgerPath,
    artifacts,
    cleanup() {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

test("transition journal restart recovery removes exact uncommitted artifacts", () => {
  const fixture = transitionRecoveryFixture();
  try {
    const result = governance.recoverPhaseTransition(fixture);
    assert.equal(result.status, "rolled_back");
    assert.equal(fs.existsSync(fixture.journalPath), false);
    for (const artifact of fixture.artifacts) {
      assert.equal(fs.existsSync(artifact.absolute), false);
    }
  } finally {
    fixture.cleanup();
  }
});

test("transition journal restart recovery preserves and verifies committed artifacts", () => {
  const fixture = transitionRecoveryFixture({ committed: true });
  try {
    const result = governance.recoverPhaseTransition(fixture);
    assert.equal(result.status, "committed");
    assert.equal(fs.existsSync(fixture.journalPath), false);
    for (const artifact of fixture.artifacts) {
      assert.equal(fs.existsSync(artifact.absolute), true);
    }
  } finally {
    fixture.cleanup();
  }
});

test("transition recovery fails closed on tampered artifact or divergent ledger", () => {
  const tampered = transitionRecoveryFixture();
  try {
    fs.writeFileSync(tampered.artifacts[0].absolute, "tampered\n");
    assert.throws(
      () => governance.recoverPhaseTransition(tampered),
      (error) =>
        error.code === "PHASE_TRANSITION_RECOVERY_REQUIRED" ||
        error.code === "PHASE_TRANSITION_ARTIFACT_UNSAFE" ||
        error.code === "PHASE_TRANSITION_PREEXISTING_ARTIFACT_CHANGED" ||
        /artifact/i.test(error.message),
    );
    assert.equal(fs.existsSync(tampered.journalPath), true);
  } finally {
    tampered.cleanup();
  }

  const diverged = transitionRecoveryFixture();
  try {
    fs.writeFileSync(
      diverged.ledgerPath,
      `${JSON.stringify({ schema: "recovery-ledger", revision: 99 })}\n`,
    );
    assert.throws(
      () => governance.recoverPhaseTransition(diverged),
      (error) => error.code === "PHASE_TRANSITION_LEDGER_DIVERGED",
    );
    assert.equal(fs.existsSync(diverged.journalPath), true);
  } finally {
    diverged.cleanup();
  }
});

test("all exact Gherkin contracts execute and altered step text is undefined", () => {
  const featurePath = path.join(
    ROOT,
    "tests",
    "features",
    "pikiio-governed-heartbeat.feature",
  );
  const scenarios = parseFeature(fs.readFileSync(featurePath, "utf8"));
  exactScenarioContracts(scenarios, definitions);
  withEnvironment(
    { TMPDIR: fs.realpathSync.native(os.tmpdir()) },
    () => {
      for (const scenario of scenarios) {
        definitions[scenario.name].execute();
      }
    },
  );
  const changed = clone(scenarios);
  changed[0].steps[0] = "Given altered semantics";
  assert.throws(
    () => exactScenarioContracts(changed, definitions),
    /undefined, reordered, or ambiguous/,
  );
});

test("production gate proves two-commit origin-main grant, migration hash, tree, lease, and quality", () => {
  const context = createProductionContext();
  try {
    const migrate = context.gate({
      action: "migrate",
      migrationPath: context.migrationPath,
    });
    assert.equal(migrate.ok, true, JSON.stringify(migrate));
    const deploy = context.gate({ action: "deploy" });
    assert.equal(deploy.ok, true, JSON.stringify(deploy));
    assert.equal(
      governance.commitIsAncestor(
        context.candidate,
        context.authorization,
        context.root,
      ),
      true,
    );
  } finally {
    context.cleanup();
  }
});

test("production gate rejects disabled, expired, unknown, dirty, wrong migration, and wrong grant state", () => {
  const disabled = governance.evaluateProductionGate({
    ledger: LEDGER,
    repoRoot: ROOT,
    goalObjective: GOAL,
    goalThreadId: TASK_ID,
    action: "deploy",
  });
  assert.equal(
    ["PRODUCTION_AUTHORITY_DISABLED", "BRANCH_MISMATCH"].includes(disabled.code),
    true,
  );

  const context = createProductionContext();
  try {
    assert.equal(
      context.gate({ goalObjective: undefined }).code,
      "CODEX_GOAL_REQUIRED",
    );
    assert.equal(
      context.gate({ nowMs: Date.parse("2026-07-25T00:00:01.000Z") }).code,
      "PRODUCTION_GRANT_EXPIRED",
    );
    assert.equal(
      context.gate({
        lease: { ...context.lease, phaseId: "ACTION-01" },
      }).code,
      "WRITER_LEASE_LOST",
    );
    const wrongScopedLease = {
      ...context.lease,
      phaseId: "ACTION-01",
    };
    fs.writeFileSync(
      context.leasePath,
      `${JSON.stringify(wrongScopedLease)}\n`,
    );
    assert.equal(
      context.gate({ lease: wrongScopedLease }).code,
      "PRODUCTION_LEASE_SCOPE_MISMATCH",
    );
    fs.writeFileSync(
      context.leasePath,
      `${JSON.stringify(context.lease)}\n`,
    );
    assert.equal(
      context.gate({
        nowMs: Date.parse("2026-07-24T04:01:01.000Z"),
      }).code,
      "WRITER_LEASE_EXPIRED",
    );
    assert.equal(
      context.gate({ isPidAlive: () => false }).code,
      "WRITER_LEASE_OWNER_NOT_LIVE",
    );

    fs.writeFileSync(
      path.join(context.root, "lib", "truth-attachment-production-fixture.js"),
      "dirty\n",
    );
    assert.equal(context.gate().code, "PRODUCTION_WORKTREE_NOT_CLEAN");
    fs.writeFileSync(
      path.join(context.root, "lib", "truth-attachment-production-fixture.js"),
      "module.exports = true;\n",
    );

    execFileSync(
      "git",
      ["update-ref", "refs/remotes/origin/main", context.candidate],
      { cwd: context.root },
    );
    assert.equal(
      context.gate().code,
      "PRODUCTION_AUTHORIZATION_NOT_ON_ORIGIN_MAIN",
    );
    execFileSync(
      "git",
      ["update-ref", "refs/remotes/origin/main", context.authorization],
      { cwd: context.root },
    );

    const unrelatedCandidate = clone(context.ledger);
    unrelatedCandidate.phases
      .find((phase) => phase.id === context.phase.id)
      .productionAuthority.grant.candidateCommit = "0".repeat(40);
    assert.equal(
      context.gate({ ledger: unrelatedCandidate }).code,
      "PRODUCTION_CANDIDATE_NOT_AUTHORIZED",
    );

    const storedQuality = fs.readFileSync(context.qualityReceiptPath, "utf8");
    const tamperedQuality = JSON.parse(storedQuality);
    tamperedQuality.metrics.failedTests = 1;
    fs.writeFileSync(
      context.qualityReceiptPath,
      `${JSON.stringify(tamperedQuality)}\n`,
    );
    assert.equal(
      context.gate().code,
      "PRODUCTION_QUALITY_RECEIPT_INVALID",
    );
    fs.writeFileSync(context.qualityReceiptPath, storedQuality);

    assert.equal(
      context.gate({
        action: "migrate",
        migrationPath: "supabase/migrations/not-authorized.sql",
      }).code,
      "MIGRATION_NOT_AUTHORIZED",
    );
    const wrongMigrationHash = clone(context.ledger);
    wrongMigrationHash.phases
      .find((phase) => phase.id === context.phase.id)
      .productionAuthority.grant.migrations[0].sha256 = "0".repeat(64);
    assert.equal(
      context.gate({
        ledger: wrongMigrationHash,
        action: "migrate",
        migrationPath: context.migrationPath,
      }).code,
      "PRODUCTION_AUTHORIZATION_LEDGER_MISMATCH",
    );

    const disabledDeploy = clone(context.ledger);
    disabledDeploy.phases
      .find((phase) => phase.id === context.phase.id)
      .productionAuthority.grant.deployment.enabled = false;
    assert.equal(
      context.gate({ ledger: disabledDeploy }).code,
      "PHASE_LEDGER_INVALID",
    );
    const wrongTree = clone(context.ledger);
    wrongTree.phases
      .find((phase) => phase.id === context.phase.id)
      .productionAuthority.grant.deployment.tree = "0".repeat(40);
    assert.equal(
      context.gate({ ledger: wrongTree }).code,
      "PRODUCTION_AUTHORIZATION_LEDGER_MISMATCH",
    );
    assert.equal(
      context.gate({ action: "unknown" }).code,
      "PRODUCTION_ACTION_UNKNOWN",
    );
  } finally {
    context.cleanup();
  }
});

test("governance edge contracts reject malformed proof bundles and untyped quality plans", () => {
  assert.throws(
    () => governance.phaseProofBundleRelativePath("not-a-digest"),
    (error) => error.code === "PHASE_PROOF_BUNDLE_HASH_INVALID",
  );
  assert.throws(
    () => governance.effectiveQualityProfile(null, "GOV-00"),
    (error) => error.code === "QUALITY_PROFILE_INVALID",
  );

  const phase = clone(governance.selectActivePhase(LEDGER));
  const missingSuite = clone(phase);
  missingSuite.qualityPlan.testSuiteId = "missing-suite";
  assert.throws(
    () =>
      governance.requiredCoverageFilesForPhase({
        phase: missingSuite,
        head: "a".repeat(40),
        changedPaths: [],
      }),
    (error) => error.code === "QUALITY_TEST_SUITE_UNKNOWN",
  );
  assert.throws(
    () =>
      governance.requiredCoverageFilesForPhase({
        phase,
        head: "a".repeat(40),
        changedPaths: "not-an-array",
      }),
    (error) => error.code === "QUALITY_CHANGED_PATHS_INVALID",
  );
  const names = governance.expectedQualityLayerNames(phase, 2);
  const suite =
    governance.QUALITY_TEST_SUITE_REGISTRY[
      phase.qualityPlan.testSuiteId
    ];
  for (const repeat of [1, 2]) {
    for (const shard of suite.shards) {
      assert.ok(
        names.includes(
          `unit-contract-property-negative-${shard.id}-repeat-${repeat}`,
        ),
      );
    }
  }
  assert.equal(
    names.includes("unit-contract-property-negative-repeat-1"),
    false,
  );

  assert.deepEqual(governance.validatePhaseProofBundle(null), {
    valid: false,
    productionChangeAuthorized: false,
    errors: ["phase proof bundle must be an object"],
  });

  const storedBytes = Buffer.from("stored proof bytes", "utf8");
  const storedSha256 = governance.sha256(storedBytes);
  const base = resign(
    {
      schema: "pikiio-phase-proof-bundle-v1",
      phaseId: "GOV-00",
      ledgerRevision: LEDGER.revision,
      candidateCommit: "a".repeat(40),
      qualityReceiptHash: "b".repeat(64),
      chain: {
        candidate: {
          receiptHash: storedSha256,
          candidateCommit: "0".repeat(40),
          candidateTree: "0".repeat(40),
          populations: {},
          changedPaths: [],
        },
        rehearsal: null,
        change: null,
        promotion: null,
      },
      artifacts: [
        {
          address: `sha256:${storedSha256}`,
          bytes: storedBytes.toString("base64"),
          encoding: "base64",
          sha256: storedSha256,
        },
      ],
    },
    "bundleHash",
  );
  const validate = (bundle, options = {}) =>
    governance.validatePhaseProofBundle(bundle, options);

  const unexpected = resign(
    { ...clone(base), unexpected: true },
    "bundleHash",
  );
  assert.match(validate(unexpected).errors.join("\n"), /unexpected fields/);

  const wrongSchema = resign(
    { ...clone(base), schema: "wrong" },
    "bundleHash",
  );
  assert.match(validate(wrongSchema).errors.join("\n"), /schema is invalid/);

  const wrongHash = clone(base);
  wrongHash.bundleHash = "0".repeat(64);
  assert.match(validate(wrongHash).errors.join("\n"), /hash does not match/);

  const wrongBinding = resign(
    { ...clone(base), phaseId: "OTHER" },
    "bundleHash",
  );
  assert.match(
    validate(wrongBinding, {
      ledger: LEDGER,
      phase,
      qualityReceipt: { head: "a".repeat(40), receiptHash: "b".repeat(64) },
    }).errors.join("\n"),
    /binding is invalid/,
  );

  const wrongChain = resign(
    { ...clone(base), chain: { candidate: null } },
    "bundleHash",
  );
  assert.match(
    validate(wrongChain, { requireFullChain: true }).errors.join("\n"),
    /exactly four|complete four-receipt/,
  );

  const prechangeWithChange = clone(base);
  prechangeWithChange.chain.change = {};
  prechangeWithChange.bundleHash = governance.sha256(
    governance.stableJson(
      Object.fromEntries(
        Object.entries(prechangeWithChange).filter(
          ([key]) => key !== "bundleHash",
        ),
      ),
    ),
  );
  assert.match(
    validate(prechangeWithChange).errors.join("\n"),
    /pre-change phase proof bundle/,
  );

  const missingArtifacts = resign(
    { ...clone(base), artifacts: null },
    "bundleHash",
  );
  assert.match(
    validate(missingArtifacts).errors.join("\n"),
    /artifacts are missing/,
  );

  const malformedArtifact = clone(base);
  malformedArtifact.artifacts[0].encoding = "hex";
  malformedArtifact.bundleHash = governance.sha256(
    governance.stableJson(
      Object.fromEntries(
        Object.entries(malformedArtifact).filter(
          ([key]) => key !== "bundleHash",
        ),
      ),
    ),
  );
  assert.match(
    validate(malformedArtifact).errors.join("\n"),
    /artifact 1 is invalid/,
  );

  const mismatchedArtifact = clone(base);
  mismatchedArtifact.artifacts[0].bytes =
    Buffer.from("different", "utf8").toString("base64");
  mismatchedArtifact.bundleHash = governance.sha256(
    governance.stableJson(
      Object.fromEntries(
        Object.entries(mismatchedArtifact).filter(
          ([key]) => key !== "bundleHash",
        ),
      ),
    ),
  );
  assert.match(
    validate(mismatchedArtifact).errors.join("\n"),
    /hash-mismatched/,
  );

  const absentArtifactSet = resign(
    { ...clone(base), artifacts: [] },
    "bundleHash",
  );
  assert.match(
    validate(absentArtifactSet).errors.join("\n"),
    /artifact set does not exactly match/,
  );
  assert.match(
    validate(base).errors.join("\n"),
    /candidate receipt artifact does not match/,
  );

  const sparseQuality = {
    head: "f".repeat(40),
    candidateTree: "e".repeat(40),
    receiptHash: "d".repeat(64),
    metrics: {},
    antiWeakening: { sliceChangedPaths: ["different.js"] },
  };
  assert.match(
    validate(base, { qualityReceipt: sparseQuality }).errors.join("\n"),
    /does not derive from strict quality evidence/,
  );
});

test("bounded governance files and transition journals fail closed at every durable boundary", () => {
  const emptyRoot = tempDirectory("pikiio-empty-transition-journal-");
  try {
    const absentPath = path.join(emptyRoot, "absent.json");
    assert.deepEqual(
      governance.recoverPhaseTransition({
        repoRoot: emptyRoot,
        journalPath: absentPath,
      }),
      { status: "none" },
    );

    const emptyPath = path.join(emptyRoot, "empty.json");
    fs.writeFileSync(emptyPath, "");
    assert.throws(
      () =>
        governance.recoverPhaseTransition({
          repoRoot: emptyRoot,
          journalPath: emptyPath,
        }),
      (error) => error.code === "BOUNDED_JSON_INPUT_INVALID",
    );

    const alternateLedger = path.join(emptyRoot, "ledger.json");
    fs.writeFileSync(alternateLedger, "{}\n");
    withEnvironment({ NODE_ENV: "production" }, () => {
      assert.throws(
        () => governance.loadPhaseLedger(alternateLedger),
        (error) => error.code === "ALTERNATE_PHASE_LEDGER_REFUSED",
      );
    });

    const replaceable = path.join(emptyRoot, "rename-failure.json");
    const originalRenameSync = fs.renameSync;
    try {
      fs.renameSync = () => {
        const error = new Error("synthetic rename refusal");
        error.code = "EIO";
        throw error;
      };
      assert.throws(
        () => governance.writeJsonAtomic(replaceable, { durable: false }),
        /synthetic rename refusal/,
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.equal(fs.existsSync(replaceable), false);
    assert.deepEqual(
      fs.readdirSync(emptyRoot).filter((name) =>
        name.startsWith("rename-failure.json."),
      ),
      [],
    );

    const exclusive = path.join(emptyRoot, "link-failure.json");
    const originalLinkSync = fs.linkSync;
    try {
      fs.linkSync = () => {
        const error = new Error("synthetic link refusal");
        error.code = "EIO";
        throw error;
      };
      assert.throws(
        () =>
          governance.writeJsonExclusiveAtomic(exclusive, {
            durable: false,
          }),
        /synthetic link refusal/,
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
    assert.equal(fs.existsSync(exclusive), false);

    const retained = path.join(emptyRoot, "unlink-cleanup-refusal.json");
    const originalUnlinkSync = fs.unlinkSync;
    try {
      fs.unlinkSync = () => {
        const error = new Error("synthetic temporary unlink refusal");
        error.code = "EIO";
        throw error;
      };
      governance.writeJsonExclusiveAtomic(retained, { durable: true });
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(retained, "utf8")), {
      durable: true,
    });

    assert.throws(
      () =>
        governance.acquireWriterLease({
          runId: "invalid-persisted-shape",
          goalId: LEDGER.codexGoal.objectiveSha256,
          phaseId: "GOV-00",
          lane: "morning-refresh",
          capability: "a".repeat(64),
          allowedPaths: null,
          leasePath: path.join(emptyRoot, "invalid-lease.json"),
          fencePath: path.join(emptyRoot, "invalid-fence.json"),
          nowMs: Date.parse("2026-07-24T10:00:00.000Z"),
          leaseMs: 60_000,
        }),
      (error) => error.code === "WRITER_LEASE_INVALID",
    );
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  const malformed = transitionRecoveryFixture();
  try {
    const validJournal = JSON.parse(
      fs.readFileSync(malformed.journalPath, "utf8"),
    );
    assert.equal(
      governance.validatePhaseTransitionJournal(
        validJournal,
        malformed.repoRoot,
      ).valid,
      true,
    );
    for (const mutate of [
      (journal) => {
        journal.extra = true;
      },
      (journal) => {
        journal.schema = "wrong";
      },
      (journal) => {
        journal.beforeLedgerSha256 = journal.afterLedgerSha256;
      },
      (journal) => {
        journal.completion = null;
      },
      (journal) => {
        journal.completion.path = "../escape.json";
      },
    ]) {
      let journal = clone(validJournal);
      mutate(journal);
      journal = resign(journal, "journalHash");
      assert.equal(
        governance.validatePhaseTransitionJournal(
          journal,
          malformed.repoRoot,
        ).valid,
        false,
      );
    }
    fs.writeFileSync(malformed.journalPath, "{}\n");
    assert.throws(
      () => governance.recoverPhaseTransition(malformed),
      (error) => error.code === "PHASE_TRANSITION_JOURNAL_INVALID",
    );
  } finally {
    malformed.cleanup();
  }

  const committedMissing = transitionRecoveryFixture({ committed: true });
  try {
    fs.unlinkSync(committedMissing.artifacts[0].absolute);
    assert.throws(
      () => governance.recoverPhaseTransition(committedMissing),
      (error) =>
        error.code === "PHASE_TRANSITION_COMMITTED_ARTIFACT_MISSING",
    );
  } finally {
    committedMissing.cleanup();
  }

  const preexistingChanged = transitionRecoveryFixture();
  try {
    let journal = JSON.parse(
      fs.readFileSync(preexistingChanged.journalPath, "utf8"),
    );
    journal.completion.preexisting = true;
    journal = resign(journal, "journalHash");
    governance.writeJsonAtomic(preexistingChanged.journalPath, journal);
    fs.unlinkSync(preexistingChanged.artifacts[0].absolute);
    assert.throws(
      () => governance.recoverPhaseTransition(preexistingChanged),
      (error) =>
        error.code === "PHASE_TRANSITION_PREEXISTING_ARTIFACT_CHANGED",
    );
  } finally {
    preexistingChanged.cleanup();
  }

  const unsafeArtifact = transitionRecoveryFixture({ committed: true });
  try {
    fs.unlinkSync(unsafeArtifact.artifacts[0].absolute);
    fs.mkdirSync(unsafeArtifact.artifacts[0].absolute);
    assert.throws(
      () => governance.recoverPhaseTransition(unsafeArtifact),
      (error) => error.code === "PHASE_TRANSITION_ARTIFACT_UNSAFE",
    );
  } finally {
    unsafeArtifact.cleanup();
  }

  const changedWhileOpening = transitionRecoveryFixture({ committed: true });
  const originalFstatSync = fs.fstatSync;
  let fstatCalls = 0;
  try {
    fs.fstatSync = (...args) => {
      const stat = originalFstatSync(...args);
      fstatCalls += 1;
      if (fstatCalls === 3) {
        return {
          ...stat,
          ino:
            typeof stat.ino === "bigint"
              ? stat.ino + 1n
              : stat.ino + 1,
          isFile: () => true,
        };
      }
      return stat;
    };
    assert.throws(
      () => governance.recoverPhaseTransition(changedWhileOpening),
      (error) => error.code === "PHASE_TRANSITION_ARTIFACT_CHANGED",
    );
  } finally {
    fs.fstatSync = originalFstatSync;
    changedWhileOpening.cleanup();
  }
});

test("quality evidence validates raw bytes and refuses every unbound representation", () => {
  const root = tempDirectory("pikiio-quality-byte-evidence-");
  const artifactDirectory = path.join(root, "artifacts");
  const receiptPath = path.join(root, "quality.json");
  const phase = governance.selectActivePhase(LEDGER);
  const head = "a".repeat(40);
  const workspaceDigest = "b".repeat(64);
  try {
    const receipt = governance.writeQualityReceipt(
      qualityInput(LEDGER, phase, head, workspaceDigest, {
        qualityArtifactDirectory: artifactDirectory,
      }),
      { receiptPath },
    );
    const context = {
      ledger: LEDGER,
      phase,
      head,
      workspaceDigest,
      verifyRawArtifacts: true,
      qualityArtifactDirectory: artifactDirectory,
    };
    const rawBytes = (judge) =>
      fs.readFileSync(judge.rawArtifact.artifactPath);
    const rawMap = (value = receipt) =>
      new Map(
        [value.primaryJudge, value.cleanJudge].map((judge) => [
          `sha256:${judge.rawArtifact.artifactSha256}`,
          rawBytes(
            judge === value.primaryJudge
              ? receipt.primaryJudge
              : receipt.cleanJudge,
          ),
        ]),
      );

    const typedBytes = new Map(
      [...rawMap().entries()].map(([address, bytes]) => [
        address,
        Uint8Array.from(bytes),
      ]),
    );
    assert.equal(
      governance.validateQualityReceipt(receipt, {
        ...context,
        rawArtifactBytes: typedBytes,
      }).valid,
      true,
    );

    assert.match(
      governance
        .validateQualityReceipt(receipt, {
          ...context,
          rawArtifactBytes: new Map(),
        })
        .errors.join("\n"),
      /embedded artifact bytes are unavailable/,
    );

    const readdressPrimary = (mutateRaw) => {
      const changed = clone(receipt);
      const raw = JSON.parse(
        fs.readFileSync(receipt.primaryJudge.rawArtifact.artifactPath, "utf8"),
      );
      mutateRaw(raw);
      const bytes = Buffer.from(`${governance.stableJson(raw)}\n`, "utf8");
      const digest = governance.sha256(bytes);
      changed.primaryJudge.rawArtifact = {
        ...changed.primaryJudge.rawArtifact,
        artifactPath: path.join(artifactDirectory, `${digest}.json`),
        artifactSha256: digest,
        byteLength: bytes.length,
      };
      const bytesByAddress = new Map([
        [`sha256:${digest}`, bytes],
        [
          `sha256:${changed.cleanJudge.rawArtifact.artifactSha256}`,
          rawBytes(receipt.cleanJudge),
        ],
      ]);
      return {
        receipt: resign(changed),
        rawArtifactBytes: bytesByAddress,
      };
    };

    for (const [name, mutateRaw, expected] of [
      [
        "body binding",
        (raw) => {
          raw.label = "wrong";
        },
        /body does not match/,
      ],
      [
        "malformed layer",
        (raw) => {
          raw.layers[0].startedAt = "not-a-time";
        },
        /malformed or forged layer/,
      ],
      [
        "signed projection",
        (raw) => {
          raw.layers[0].status = 1;
          raw.layers[0].semanticSha256 = semanticReceiptSha256(raw.layers[0]);
        },
        /layers diverge/,
      ],
    ]) {
      const changed = readdressPrimary(mutateRaw);
      const validation = governance.validateQualityReceipt(changed.receipt, {
        ...context,
        rawArtifactBytes: changed.rawArtifactBytes,
      });
      assert.match(validation.errors.join("\n"), expected, name);
    }

    const wrongBytes = rawMap();
    wrongBytes.set(
      `sha256:${receipt.primaryJudge.rawArtifact.artifactSha256}`,
      Buffer.from("wrong bytes", "utf8"),
    );
    assert.match(
      governance
        .validateQualityReceipt(receipt, {
          ...context,
          rawArtifactBytes: wrongBytes,
        })
        .errors.join("\n"),
      /bytes do not match their address/,
    );

    const otherDirectory = path.join(root, "other-artifacts");
    fs.mkdirSync(otherDirectory);
    assert.match(
      governance
        .validateQualityReceipt(receipt, {
          ...context,
          qualityArtifactDirectory: otherDirectory,
          rawArtifactBytes: null,
        })
        .errors.join("\n"),
      /escapes the approved content-addressed root/,
    );

    const originalFstatSync = fs.fstatSync;
    let firstFstat = true;
    try {
      fs.fstatSync = (...args) => {
        const stat = originalFstatSync(...args);
        if (!firstFstat) return stat;
        firstFstat = false;
        return {
          ...stat,
          ino:
            typeof stat.ino === "bigint"
              ? stat.ino + 1n
              : stat.ino + 1,
          isFile: () => true,
        };
      };
      assert.match(
        governance
          .validateQualityReceipt(receipt, {
            ...context,
            rawArtifactBytes: null,
          })
          .errors.join("\n"),
        /changed while it was being opened/,
      );
    } finally {
      fs.fstatSync = originalFstatSync;
    }

    const primaryPath = receipt.primaryJudge.rawArtifact.artifactPath;
    const primaryBytes = fs.readFileSync(primaryPath);
    try {
      fs.writeFileSync(primaryPath, "short\n");
      assert.match(
        governance
          .validateQualityReceipt(receipt, {
            ...context,
            rawArtifactBytes: null,
          })
          .errors.join("\n"),
        /not a bounded exact regular file/,
      );
    } finally {
      fs.writeFileSync(primaryPath, primaryBytes);
    }

    for (const [name, mutate, expected] of [
      [
        "toolchain",
        (value) => {
          value.qualityToolchain = null;
        },
        /approved toolchain evidence is missing/,
      ],
      [
        "dependency manifest",
        (value) => {
          value.dependencyManifest = null;
        },
        /dependency manifest is missing/,
      ],
      [
        "candidate tree",
        (value) => {
          value.candidateTree = "bad";
        },
        /candidate tree is invalid/,
      ],
      [
        "raw populations",
        (value) => {
          value.populations = null;
        },
        /raw populations are missing/,
      ],
      [
        "population reconciliation",
        (value) => {
          value.populations.unit[0].tests += 1;
        },
        /raw populations do not reconcile/,
      ],
    ]) {
      let changed = clone(receipt);
      mutate(changed);
      changed = resign(changed);
      assert.match(
        governance
          .validateQualityReceipt(changed, {
            ledger: LEDGER,
            phase,
            head,
            workspaceDigest,
          })
          .errors.join("\n"),
        expected,
        name,
      );
    }

    const unknownPhase = { ...clone(phase), id: "UNKNOWN" };
    assert.match(
      governance
        .validateQualityReceipt(receipt, {
          ledger: LEDGER,
          phase: unknownPhase,
          head,
          workspaceDigest,
        })
        .errors.join("\n"),
      /no immutable population policy/,
    );

    const missingPlan = { ...clone(phase), qualityPlan: null };
    assert.match(
      governance
        .validateQualityReceipt(receipt, {
          ledger: LEDGER,
          phase: missingPlan,
          head,
          workspaceDigest,
        })
        .errors.join("\n"),
      /coverage set cannot be reproduced|lacks an executable quality plan/,
    );

    const missingRepository = path.join(root, "missing-repository");
    const unreproducible = governance.validateQualityReceipt(receipt, {
      ...context,
      repoRoot: missingRepository,
      verifyRawArtifacts: false,
    });
    assert.match(
      unreproducible.errors.join("\n"),
      /candidate tree cannot be reproduced/,
    );

    const activation = activationLedgerFixture();
    const protectedReceipt = governance.writeQualityReceipt(
      qualityInput(
        activation.ledger,
        activation.phase,
        head,
        workspaceDigest,
        {
          sliceChangedPaths: [governance.PHASE_LEDGER_RELATIVE_PATH],
          canonicalTransition: { ok: true },
        },
      ),
      { receiptPath: path.join(root, "protected-quality.json") },
    );
    assert.match(
      governance
        .validateQualityReceipt(protectedReceipt, {
          ledger: activation.ledger,
          phase: activation.phase,
          head,
          workspaceDigest,
        })
        .errors.join("\n"),
      /cannot be proven without Git history/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external proof authority and transition mutation hooks remain repository-bound", () => {
  const fixture = createTransitionedActivationContext();
  const aliasParent = tempDirectory("pikiio-transition-alias-");
  const alias = path.join(aliasParent, "canonical");
  const alternate = initializeGitRepository();
  try {
    assert.deepEqual(
      governance.validateExternallyCertifiedPhaseProofEnvelope(null, {
        ledger: fixture.before,
        phase: fixture.previous,
        qualityReceipt: fixture.qualityReceipt,
        repoRoot: fixture.root,
      }),
      {
        valid: false,
        errors: ["externally certified phase-proof envelope is malformed"],
      },
    );

    const pinned =
      governance.validateExternallyCertifiedPhaseProofEnvelope(
        fixture.phaseProofEnvelope,
        {
          ledger: fixture.before,
          phase: fixture.previous,
          qualityReceipt: fixture.qualityReceipt,
          repoRoot: fixture.root,
        },
      );
    assert.equal(pinned.valid, false);
    assert.doesNotMatch(
      pinned.errors.join("\n"),
      /PINNED_AUTHORITY|authority path or commit is invalid|absent or unreadable/,
    );

    let unreadableValidatorCalls = 0;
    const unreadable =
      governance.validateExternallyCertifiedPhaseProofEnvelope(
        fixture.phaseProofEnvelope,
        {
          ledger: fixture.before,
          phase: fixture.previous,
          qualityReceipt: fixture.qualityReceipt,
          repoRoot: path.join(aliasParent, "missing"),
          externalProofValidator() {
            unreadableValidatorCalls += 1;
            return {};
          },
        },
      );
    assert.equal(unreadable.valid, false);
    assert.equal(unreadableValidatorCalls, 0);
    assert.match(
      unreadable.errors.join("\n"),
      /substitution is forbidden on canonical authority/,
    );

    const activationContext = {
      ledger: fixture.ledger,
      phase: fixture.phase,
      head: fixture.transitionCommit,
      repoRoot: fixture.root,
      nowMs: fixture.nowMs,
      localHost: "test-host",
      externalProofValidator: fixture.externalProofValidator,
    };
    const wrongActivationSchema = resign({
      ...clone(fixture.activationReceipt),
      schema: "wrong",
    });
    assert.match(
      governance
        .validateHeartbeatActivationReceipt(
          wrongActivationSchema,
          activationContext,
        )
        .errors.join("\n"),
      /schema is invalid/,
    );
    const invalidActivationLedger = clone(fixture.ledger);
    invalidActivationLedger.activePhaseId = "UNKNOWN";
    assert.match(
      governance
        .validateHeartbeatActivationReceipt(fixture.activationReceipt, {
          ...activationContext,
          ledger: invalidActivationLedger,
          repoRoot: null,
        })
        .errors.join("\n"),
      /ledger is invalid/,
    );
    const noAutomationLedger = clone(fixture.ledger);
    delete noAutomationLedger.automationContract;
    assert.match(
      governance
        .validateHeartbeatActivationReceipt(fixture.activationReceipt, {
          ...activationContext,
          ledger: noAutomationLedger,
          repoRoot: null,
        })
        .errors.join("\n"),
      /checked-in automation contract/,
    );
    assert.match(
      governance
        .validateHeartbeatActivationReceipt(fixture.activationReceipt, {
          ...activationContext,
          head: fixture.candidate,
        })
        .errors.join("\n"),
      /head is not descended/,
    );
    assert.throws(
      () =>
        governance.issueHeartbeatActivationReceipt({
          ledger: fixture.ledger,
          repoRoot: fixture.root,
          mutationBoundaryHook: "not-a-function",
        }),
      (error) => error.code === "ACTIVATION_TEST_HOOK_REFUSED",
    );

    assert.throws(
      () =>
        governance.issuePhaseTransition({
          repoRoot: path.join(aliasParent, "missing"),
        }),
      (error) => error.code === "PHASE_REPOSITORY_UNREADABLE",
    );

    fs.symlinkSync(ROOT, alias, "dir");
    assert.throws(
      () => governance.issuePhaseTransition({ repoRoot: alias }),
      (error) => error.code === "CANONICAL_REPOSITORY_ALIAS_REFUSED",
    );

    withEnvironment({ NODE_ENV: "production" }, () => {
      assert.throws(
        () => governance.issuePhaseTransition({ repoRoot: alternate }),
        (error) => error.code === "ALTERNATE_PHASE_REPOSITORY_REFUSED",
      );
    });

    assert.throws(
      () =>
        governance.issuePhaseTransition({
          ledger: LEDGER,
          repoRoot: alternate,
          mutationBoundaryHook: "not-a-function",
        }),
      (error) => error.code === "PHASE_TRANSITION_TEST_HOOK_REFUSED",
    );
    assert.throws(
      () =>
        governance.issuePhaseTransition({
          ledger: LEDGER,
          nextPhaseId: "UNKNOWN",
          repoRoot: alternate,
        }),
      (error) => error.code === "PHASE_TRANSITION_TARGET_INVALID",
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(aliasParent, { recursive: true, force: true });
    fs.rmSync(alternate, { recursive: true, force: true });
  }
});

test("OS advisory-lock holder survives acquire client and one contender wins", async () => {
  if (process.platform !== "darwin") {
    const root = initializeGitRepository();
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const ownedSocketRoot = !process.env.PIKIIO_QUALITY_SOCKET_ROOT;
  const qualitySocketRoot =
    process.env.PIKIIO_QUALITY_SOCKET_ROOT ||
    fs.mkdtempSync("/private/tmp/pikiio-quality-ipc-");
  assert.match(
    qualitySocketRoot,
    /^\/private\/tmp\/pikiio-quality-ipc-/,
    "OS lock integration requires the dedicated quality IPC sandbox",
  );
  const codexHome = fs.mkdtempSync(
    path.join(qualitySocketRoot, "pikiio-holder-home-"),
  );
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    PIKIIO_CODEX_GOAL_OBJECTIVE: GOAL,
    PIKIIO_CODEX_GOAL_THREAD_ID: TASK_ID,
  };
  const runtimeDir = path.join(codexHome, "runtime", "pikiio-agent");
  try {
    const morningScript = [
      "const g=require('./lib/pikiio-agent-governance');",
      "const now=Date.now();",
      "g.writeMorningTerminalReceipt({",
      "runId:'test-morning',leaseFence:1,result:'failed',truthPublished:false,",
      "startedAt:new Date(now-1000).toISOString(),",
      "finishedAt:new Date(now).toISOString(),detail:'test-only runtime'},",
      "{nowMs:now});",
    ].join("");
    execFileSync(process.execPath, ["-e", morningScript], {
      cwd: ROOT,
      env,
      stdio: "ignore",
    });
    const contenders = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        execFileAsync(
          process.execPath,
          [
            "scripts/pikiio-agent-writer-lease.js",
            "acquire",
            `--run-id=race-${index}`,
            "--lease-ms=120000",
          ],
          { cwd: ROOT, env },
        ).then(
          ({ stdout }) => ({ ok: true, payload: JSON.parse(stdout) }),
          (error) => ({
            ok: false,
            payload: JSON.parse(String(error.stdout || "{}")),
          }),
        ),
      ),
    );
    const winners = contenders.filter(
      (result) => result.ok && result.payload.ok === true,
    );
    assert.equal(winners.length, 1, JSON.stringify(contenders));
    const winner = winners[0].payload;
    assert.ok(fs.existsSync(winner.handlePath));
    assert.equal((fs.statSync(winner.handlePath).mode & 0o077), 0);
    assert.equal(governance.pidAlive(winner.lease.ownerPid), true);
    for (const operation of ["assert", "renew", "assert"]) {
      const controlled = execFileSync(
        process.execPath,
        [
          "scripts/pikiio-agent-writer-lease.js",
          operation,
          `--handle=${winner.handlePath}`,
        ],
        { cwd: ROOT, env, encoding: "utf8" },
      );
      const payload = JSON.parse(controlled);
      assert.equal(payload.ok, true);
      assert.equal(payload.lease.runId, winner.lease.runId);
      assert.equal(payload.lease.phaseId, "GOV-00");
      assert.equal(payload.lease.lane, "autonomy-governance");
      assert.doesNotMatch(controlled, /capability/i);
    }
    const status = execFileSync(
      process.execPath,
      ["scripts/pikiio-agent-writer-lease.js", "status"],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    assert.doesNotMatch(status, /capability/i);
    const released = execFileSync(
      process.execPath,
      [
        "scripts/pikiio-agent-writer-lease.js",
        "release",
        `--handle=${winner.handlePath}`,
      ],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    assert.equal(JSON.parse(released).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(winner.handlePath), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, "writer-lease.json")), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (ownedSocketRoot) {
      fs.rmSync(qualitySocketRoot, { recursive: true, force: true });
    }
  }
});

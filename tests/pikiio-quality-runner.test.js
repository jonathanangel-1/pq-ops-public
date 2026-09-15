"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const governance = require("../lib/pikiio-agent-governance");
const runner = require("../lib/pikiio-quality-runner");

const TEMPORARY_ROOTS = [];

function temporaryDirectory(prefix) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  TEMPORARY_ROOTS.push(root);
  return root;
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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function initializeRepository() {
  const root = temporaryDirectory("pikiio-quality-runner-repo-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "quality@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Quality Runner"], {
    cwd: root,
  });
  writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  writeFile(
    path.join(root, "package-lock.json"),
    '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture"}}}\n',
  );
  writeFile(
    path.join(root, "tests", "authority.test.js"),
    'test("authority",()=>assert.ok(true));\n',
  );
  writeFile(
    path.join(root, "tests", "authority.feature"),
    "Feature: Authority\n  Scenario: safe\n",
  );
  writeFile(
    path.join(root, "scripts", "mutate-authority.js"),
    'const mutants=[{id:"M-1"}];\n',
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

after(() => {
  for (const root of TEMPORARY_ROOTS.reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function profile(overrides = {}) {
  return {
    deterministicRepeatCount: 2,
    maximumSkippedRequiredTests: 0,
    maximumFlakyTests: 0,
    maximumNewWarnings: 0,
    minimumLineCoveragePercent: 95,
    minimumBranchCoveragePercent: 90,
    minimumFunctionCoveragePercent: 95,
    minimumMutationScorePercent: 100,
    minimumCriticalMutantKillPercent: 100,
    minimumGherkinPassPercent: 100,
    minimumUnitTestsPerRun: 10,
    minimumMutationPopulation: 3,
    minimumCriticalMutationPopulation: 2,
    minimumGherkinScenarioPopulation: 4,
    ...overrides,
  };
}

function phaseFixture(id = "GOV-00", overrides = {}) {
  return {
    id,
    lane: id === "GOV-00" ? "autonomy-governance" : "truth-liveness",
    qualityProfile: "hardcore",
    scopeBaseCommit: "a".repeat(40),
    qualityPlan: {
      syntaxFiles: ["lib/one.js", "scripts/two.js"],
      testSuiteId: "governance-unit-v1",
      gherkinCheckId: "governance-gherkin-v1",
      mutationCheckId: "governance-mutation-v1",
      focusedCheckIds: ["governance-focused"],
      neighborCheckIds: ["automation-contracts"],
      broadCheckIds: ["git-diff-check"],
      productionShapedCheckIds: ["production-default-deny"],
    },
    ...overrides,
  };
}

function ledgerFixture(phase = phaseFixture(), overrides = {}) {
  return {
    revision: "test-revision",
    codexGoal: { objectiveSha256: "1".repeat(64) },
    qualityPolicy: {
      trustedGatePaths: [],
      profiles: { hardcore: profile() },
    },
    phases: [phase],
    ...overrides,
  };
}

function expectedLayerDefinitions(phase, selectedProfile) {
  const layers = phase.qualityPlan.syntaxFiles.map((relativePath) => ({
    name: `syntax:${relativePath}`,
    definitionSha256: "a".repeat(64),
  }));
  const suite =
    governance.QUALITY_TEST_SUITE_REGISTRY[
      phase.qualityPlan.testSuiteId
    ];
  for (let repeat = 1; repeat <= selectedProfile.deterministicRepeatCount; repeat += 1) {
    for (const shard of suite.shards || [{ id: null }]) {
      layers.push({
        name: shard.id
          ? `unit-contract-property-negative-${shard.id}-repeat-${repeat}`
          : `unit-contract-property-negative-repeat-${repeat}`,
        definitionSha256: "b".repeat(64),
      });
    }
  }
  return layers;
}

function coverageFiles(value = 100, paths = null) {
  return Object.fromEntries(
    (paths ||
      governance.QUALITY_TEST_SUITE_REGISTRY[
        "governance-unit-v1"
      ].coverageIncludes).map(
      (relativePath) => [
        relativePath,
        { lines: value, branches: value, functions: value },
      ],
    ),
  );
}

function qualityReceipts({ repeatCount = 2, semanticDrift = false } = {}) {
  const receipts = [];
  const shards =
    governance.QUALITY_TEST_SUITE_REGISTRY[
      "governance-unit-v1"
    ].shards;
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const suffix = `repeat-${repeat}`;
    for (const [shardIndex, shard] of shards.entries()) {
      receipts.push({
        name:
          `unit-contract-property-negative-${shard.id}-${suffix}`,
        stdout: "",
        stderr: "",
        semanticSha256:
          semanticDrift && repeat === 2 && shardIndex === 0
            ? "9".repeat(64)
            : `${(shardIndex % 8) + 1}`.repeat(64),
        parsed: {
          tests: 1,
          passed: 1,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
          coverage: { lines: 100, branches: 100, functions: 100 },
          coverageFiles: coverageFiles(100, shard.coverageIncludes),
        },
      });
    }
    receipts.push({
      name: `executable-gherkin-${suffix}`,
      stdout: "",
      stderr: "",
      semanticSha256: "2".repeat(64),
      parsed: {
        ok: true,
        scenarios: 4,
        passed: 4,
        failed: 0,
        skipped: 0,
        undefined: 0,
        ambiguous: 0,
        pending: 0,
        passPercent: 100,
      },
    });
    receipts.push({
      name: `critical-mutation-${suffix}`,
      stdout: "",
      stderr: "",
      semanticSha256: "3".repeat(64),
      parsed: {
        ok: true,
        total: 3,
        killed: 3,
        survived: 0,
        criticalTotal: 2,
        criticalKilled: 2,
        survivedCritical: 0,
        scorePercent: 100,
        criticalMutantKillPercent: 100,
        metaTests: [{ passed: true }],
      },
    });
    for (const name of [
      "focused-1",
      "neighbor-1",
      "broad-1",
      "production-shaped-1",
    ]) {
      receipts.push({
        name: `${name}-${suffix}`,
        stdout: "",
        stderr: "",
        semanticSha256: `${name.length}`.repeat(64).slice(0, 64),
        parsed: { ok: true },
      });
    }
  }
  return receipts;
}

function judgeFixture(label = "primary") {
  return {
    label,
    candidateCommit: "a".repeat(40),
    candidateTree: "b".repeat(40),
    automationSnapshotSha256: "c".repeat(64),
    dependencies: {
      install: {
        isolation: "macos-sandbox-deny-network",
        semanticSha256: "d".repeat(64),
      },
      audit: {
        isolation: "macos-sandbox-deny-network",
        semanticSha256: "e".repeat(64),
      },
      manifest: { manifestSha256: "f".repeat(64) },
      toolchain: { toolchainSha256: "1".repeat(64) },
    },
    receipts: [
      {
        name: "layer",
        checkId: "check",
        definitionSha256: "2".repeat(64),
        command: "node check",
        isolation: "macos-sandbox-deny-network",
        startedAt: "2026-07-24T01:00:00.000Z",
        finishedAt: "2026-07-24T01:00:01.000Z",
        status: 0,
        signal: null,
        timedOut: false,
        stdout: "raw",
        stderr: "",
        parsed: { ok: true },
        semanticSha256: "3".repeat(64),
      },
    ],
    summary: {
      metrics: {
        failedTests: 0,
        cleanCheckoutReproduced: false,
      },
      populations: { unit: [], mutation: [], gherkin: [] },
      layerDigests: [
        { name: "layer", semanticSha256: "3".repeat(64) },
      ],
    },
    worktreeHead: "a".repeat(40),
    worktreeTree: "b".repeat(40),
    workspaceUnchanged: true,
    rawArtifact: {
      schema: "pikiio-quality-judge-raw-artifact-v1",
      artifactPath: "/tmp/raw.json",
      artifactSha256: "4".repeat(64),
      byteLength: 100,
      layerCount: 1,
    },
  };
}

test("thin launcher delegates without owning quality decisions", () => {
  const launcherPath = path.join(
    __dirname,
    "..",
    "scripts",
    "run-pikiio-quality-gauntlet.js",
  );
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.doesNotMatch(source, /\bfunction\b|spawnSync|execFileSync|writeQualityReceipt/);
  assert.match(source, /bootstrapQualityGauntlet/);
  const exported = require(launcherPath);
  assert.equal(exported.runQualityGauntlet, runner.runQualityGauntlet);
});

test("parsers retain structured output and deterministic domain evidence", () => {
  assert.equal(runner.parseLastJsonObject("noise\n{\"ok\":true}").ok, true);
  assert.equal(runner.parseLastJsonObject("{\"first\":1}\nnot-json"), null);
  assert.equal(runner.parseLastJsonObject(""), null);
  const tap = runner.parseTap([
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# nested                         |        |          |         |",
    "#  deeper                        |        |          |         |",
    "#   file.js                       | 100.00 |    95.00 |   99.00 |",
    "# malformed | no | metrics | here",
    "# all                            | 100.00 |    95.00 |   99.00 |",
  ].join("\n"));
  assert.deepEqual(tap.coverageFiles["nested/deeper/file.js"], {
    lines: 100,
    branches: 95,
    functions: 99,
  });
  assert.equal(tap.tests, 1);
  const normalized = runner.normalizedOutput(
    "/tmp/run duration_ms: 12.5 took 8 ms shipment=014-80000010",
    ["/tmp/run", "/tmp"],
  );
  assert.match(normalized, /<QUALITY_ROOT_0>/);
  assert.match(normalized, /duration=<N>/);
  assert.match(normalized, /shipment=014-80000010/);
  const receipt = {
    name: "layer",
    checkId: "check",
    command: "node check",
    definitionSha256: "a".repeat(64),
    isolation: "sandbox",
    status: 0,
    signal: null,
    parsed: { ok: true },
    stdout: "durationMs=99",
    stderr: "",
    normalizationRoots: [],
  };
  assert.equal(runner.semanticReceipt(receipt).stdout, "duration=<N>");
});

test("immutable command lookup binds registry, package scripts, and executables", () => {
  const nodeCheck = runner.qualityCheckInvocation("governance-focused");
  assert.equal(nodeCheck.command, process.execPath);
  assert.match(nodeCheck.definitionSha256, /^[a-f0-9]{64}$/);
  const npmCheck = runner.qualityCheckInvocation("beta-contract");
  assert.equal(npmCheck.command, process.execPath);
  assert.match(npmCheck.args[0], /npm-cli\.js$/);
  const gitCheck = runner.qualityCheckInvocation("git-diff-check");
  assert.match(gitCheck.command, /(?:^git$|\/git$)/);
  assert.ok(
    runner.unitArgs(
      { testSuiteId: "governance-unit-v1" },
      profile(),
    ).includes("--experimental-test-coverage"),
  );
  assert.throws(
    () => runner.qualityCheckInvocation("not-registered"),
    (error) => error.code === "QUALITY_CHECK_UNKNOWN",
  );
  const root = temporaryDirectory("pikiio-quality-package-script-");
  try {
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { "verify:beta": "poison" } }),
    );
    assert.throws(
      () => runner.qualityCheckInvocation("beta-contract", root),
      (error) => error.code === "QUALITY_PACKAGE_SCRIPT_MISMATCH",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registered check execution uses the same immutable invocation", () => {
  const root = initializeRepository();
  try {
    const receipt = runner.executeCheck("git-check", "git-diff-check", {
      cwd: root,
      env: runner.scrubQualityEnvironment(process.env),
    });
    assert.equal(receipt.status, 0);
    assert.equal(receipt.checkId, "git-diff-check");
    assert.match(receipt.definitionSha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("environment and isolation boundaries reject caller widening", () => {
  assert.equal(runner.hasFlag("--development", ["node", "--development"]), true);
  assert.equal(runner.hasFlag("--development", ["node"]), false);
  const safe = runner.scrubQualityEnvironment(
    {
      PIKIIO_CODEX_GOAL_OBJECTIVE: "goal",
      PIKIIO_CODEX_GOAL_THREAD_ID: "thread",
      OPENAI_API_KEY: "must-disappear",
    },
    { TZ: "UTC" },
  );
  assert.equal(safe.TZ, "UTC");
  assert.equal(Object.hasOwn(safe, "OPENAI_API_KEY"), false);
  assert.throws(
    () => runner.scrubQualityEnvironment({}, { OPENAI_API_KEY: "poison" }),
    (error) => error.code === "QUALITY_ENVIRONMENT_OVERRIDE_INVALID",
  );
  const socketRoot = fs.mkdtempSync("/private/tmp/pikiio-quality-ipc-");
  try {
    assert.throws(
      () =>
        runner.isolatedCommand(process.execPath, ["-e", ""], {
          socketRoot,
          writableRoots: [path.resolve(__dirname, "..")],
        }),
      (error) => error.code === "QUALITY_WRITABLE_ROOT_INVALID",
    );
    assert.throws(
      () =>
        runner.isolatedCommand(process.execPath, ["-e", ""], {
          socketRoot: "/private/tmp/not-quality",
        }),
      (error) =>
        process.platform !== "darwin" ||
        error.code === "QUALITY_IPC_ROOT_INVALID",
    );
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
      const isolated = runner.isolatedCommand(process.execPath, ["-e", ""], {
        socketRoot,
      });
      assert.equal(isolated.command, "/usr/bin/sandbox-exec");
      assert.equal(isolated.isolation, "macos-sandbox-deny-network");
      assert.match(isolated.args[1], /\(deny network\*\)/);
    }
  } finally {
    fs.rmSync(socketRoot, { recursive: true, force: true });
  }
});

test("Git config parser refuses unknown, executable, and credential-bearing entries", () => {
  const root = temporaryDirectory("pikiio-quality-git-config-cases-");
  try {
    const cases = [
      "[core]\nunknown = value\n",
      "[credential]\nhelper = store\n",
      "[core]\nrepositoryformatversion = $(touch poison)\n",
      "[remote \"origin\"]\nurl = https://token@example.invalid/repo\n",
      "orphan = value\n",
    ];
    for (const [index, source] of cases.entries()) {
      const filePath = path.join(root, `${index}.config`);
      fs.writeFileSync(filePath, source);
      assert.throws(
        () => runner.assertOperationalGitConfigSafe(filePath),
        (error) => error.code === "QUALITY_GIT_CONFIG_UNSAFE",
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("layer execution records success and fail-closes every child failure", () => {
  const root = temporaryDirectory("pikiio-quality-layer-");
  try {
    const success = runner.runLayer({
      name: "success",
      command: process.execPath,
      args: ["-e", 'console.log("prefix"); console.log(JSON.stringify({ok:true}))'],
      cwd: root,
      env: { TMPDIR: root },
      checkId: "success",
      definitionSha256: "a".repeat(64),
    });
    assert.equal(success.parsed.ok, true);
    assert.match(success.semanticSha256, /^[a-f0-9]{64}$/);
    assert.throws(
      () =>
        runner.runLayer({
          name: "failure",
          command: process.execPath,
          args: ["-e", 'console.error("failed"); process.exit(7)'],
          cwd: root,
          env: { TMPDIR: root },
          checkId: "failure",
          definitionSha256: "b".repeat(64),
        }),
      (error) =>
        error.code === "QUALITY_LAYER_FAILED" &&
        error.receipt.status === 7 &&
        /failed/.test(error.receipt.stderr),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("anti-weakening audit measures committed and worktree surfaces", () => {
  const root = initializeRepository();
  try {
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const protectedPaths = [
      "tests/authority.test.js",
      "tests/authority.feature",
      "scripts/mutate-authority.js",
    ];
    const phase = phaseFixture("GOV-00", {
      scopeBaseCommit: base,
      lane: "autonomy-governance",
    });
    const ledger = ledgerFixture(phase, {
      qualityPolicy: {
        trustedGatePaths: protectedPaths,
        profiles: { hardcore: profile() },
      },
    });
    writeFile(path.join(root, "lib", "product.js"), "module.exports=true;\n");
    let result = runner.antiWeakeningAudit(ledger, phase, { repoRoot: root });
    assert.deepEqual(result.worktreeChangedPaths, ["lib/product.js"]);
    assert.equal(result.baselineCounts.tests, 1);
    assert.equal(result.baselineCounts.assertions, 1);
    assert.equal(result.baselineCounts.scenarios, 1);
    assert.equal(result.baselineCounts.mutants, 1);
    assert.deepEqual(result.baselineCounts, result.currentCounts);

    writeFile(
      path.join(root, "lib", "product.js"),
      'test.skip("weakened",()=>{});\n',
    );
    assert.throws(
      () => runner.antiWeakeningAudit(ledger, phase, { repoRoot: root }),
      (error) => error.code === "TEST_WEAKENING_DETECTED",
    );

    fs.rmSync(path.join(root, "lib"), { recursive: true, force: true });
    writeFile(
      path.join(root, "tests", "authority.test.js"),
      'test("changed",()=>assert.ok(true));\n',
    );
    const nonGovernance = { ...phase, id: "TRUTH-01", lane: "truth-liveness" };
    assert.throws(
      () =>
        runner.antiWeakeningAudit(ledger, nonGovernance, { repoRoot: root }),
      (error) => error.code === "TRUSTED_QUALITY_GATE_CHANGED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical ledger-only transition is the sole non-governance gate edit", () => {
  const root = initializeRepository();
  try {
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const ledgerPath = governance.PHASE_LEDGER_RELATIVE_PATH;
    writeFile(path.join(root, ledgerPath), '{"revision":1}\n');
    execFileSync("git", ["add", ledgerPath], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base-ledger"], { cwd: root });
    const scopeBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFile(path.join(root, ledgerPath), '{"revision":2}\n');
    execFileSync("git", ["add", ledgerPath], { cwd: root });
    execFileSync("git", ["commit", "-qm", "transition"], { cwd: root });
    const phase = phaseFixture("TRUTH-01", {
      scopeBaseCommit,
      lane: "truth-liveness",
    });
    const ledger = ledgerFixture(phase, {
      qualityPolicy: {
        trustedGatePaths: [ledgerPath],
        profiles: { hardcore: profile() },
      },
    });
    let validatorCalls = 0;
    const result = runner.antiWeakeningAudit(ledger, phase, {
      repoRoot: root,
      transitionValidator: () => {
        validatorCalls += 1;
        return { ok: true, receiptHash: "a".repeat(64) };
      },
    });
    assert.equal(validatorCalls, 1);
    assert.equal(result.canonicalTransition.ok, true);
    assert.equal(result.protectedChanged[0], ledgerPath);
    assert.notEqual(base, scopeBaseCommit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plan executor pins order, repeats, profiles, seeds, and acceptance scope", () => {
  for (const phaseId of ["GOV-00", "TRUTH-01", "ACTION-01"]) {
    const phase = phaseFixture(phaseId);
    const selectedProfile = profile();
    const ledger = ledgerFixture(phase, {
      qualityPolicy: {
        trustedGatePaths: [],
        profiles: { hardcore: selectedProfile },
      },
    });
    const calls = [];
    const operations = {
      expectedQualityLayerPlan: expectedLayerDefinitions,
      unitArgs: () => ["--test", "fixture.test.js"],
      unitShardArgs: (_suite, shardId) => [
        "--test",
        `${shardId}.test.js`,
      ],
      runLayer: (input) => {
        calls.push({ type: "layer", ...input });
        return { name: input.name };
      },
      executeCheck: (name, checkId, options) => {
        calls.push({ type: "check", name, checkId, options });
        return { name };
      },
    };
    const receipts = runner.executePlan({
      root: "/tmp/pikiio-quality-fixture",
      ledger,
      phase,
      baseEnvironment: {},
      effectiveProfile: selectedProfile,
      requiredCoverageFiles: Object.keys(coverageFiles()),
      operations,
    });
    const shardCount =
      governance.QUALITY_TEST_SUITE_REGISTRY[
        "governance-unit-v1"
      ].shards.length;
    assert.equal(receipts.length, 2 + 2 * (6 + shardCount));
    assert.equal(calls[0].name, "syntax:lib/one.js");
    const unitCalls = calls.filter((call) =>
      call.name?.startsWith("unit-contract-property-negative-"),
    );
    assert.equal(unitCalls.length, 2 * shardCount);
    assert.equal(unitCalls[0].env.TZ, "UTC");
    assert.equal(
      unitCalls[shardCount].env.TZ,
      "America/New_York",
    );
    assert.equal(unitCalls[0].env.PIKIIO_PHASE_PROOF_PROFILE, phaseId);
    assert.equal(
      Object.hasOwn(unitCalls[0].env, "PIKIIO_TRUTH_PHASE_ACCEPTANCE"),
      phaseId.startsWith("TRUTH-"),
    );
    assert.equal(
      Object.hasOwn(unitCalls[0].env, "PIKIIO_ACTION_PHASE_ACCEPTANCE"),
      phaseId.startsWith("ACTION-"),
    );
    assert.equal(calls.at(-1).name, "production-shaped-1-repeat-2");
  }
});

test("receipt summary enforces per-file coverage and exact populations", () => {
  const phase = phaseFixture();
  const ledger = ledgerFixture(phase);
  const receipts = qualityReceipts();
  const result = runner.summarizeReceipts(
    receipts,
    ledger,
    phase,
    false,
    {
      effectiveProfile: profile(),
      requiredCoverageFiles: Object.keys(coverageFiles()),
    },
  );
  assert.equal(result.metrics.testsPerRun, 10);
  assert.equal(result.metrics.minimumObservedCoverage.branches, 100);
  assert.equal(result.metrics.minimumMutationPopulation, 3);
  assert.equal(result.metrics.minimumCriticalMutationPopulation, 2);
  assert.equal(result.metrics.minimumGherkinScenarioPopulation, 4);
  assert.equal(result.metrics.cleanCheckoutReproduced, false);
  assert.deepEqual(runner.warningFindings(receipts), []);
  assert.deepEqual(runner.repeatConsistency(receipts, 2), []);
  const warnings = runner.warningFindings([
    { name: "one", stdout: "WARNING: first", stderr: "npm WARN second" },
  ]);
  assert.equal(warnings.length, 2);
  assert.equal(runner.repeatConsistency(qualityReceipts({ semanticDrift: true }), 2).length, 1);
});

test("receipt summary refuses malformed and below-profile evidence", async (t) => {
  const phase = phaseFixture();
  const cases = [
    {
      name: "missing unit shard receipt",
      mutate: (receipts) => {
        const index = receipts.findIndex((entry) =>
          entry.name.startsWith("unit-contract-property-negative-")
        );
        receipts.splice(index, 1);
      },
      code: "QUALITY_UNIT_SHARD_RECEIPTS_INVALID",
    },
    {
      name: "duplicate unit shard receipt",
      mutate: (receipts) => {
        const receipt = receipts.find((entry) =>
          entry.name.startsWith("unit-contract-property-negative-")
        );
        receipts.push(structuredClone(receipt));
      },
      code: "QUALITY_UNIT_SHARD_RECEIPTS_INVALID",
    },
    {
      name: "unexpected unit shard receipt",
      mutate: (receipts) => {
        const receipt = receipts.find((entry) =>
          entry.name.startsWith("unit-contract-property-negative-")
        );
        receipt.name =
          "unit-contract-property-negative-unknown-repeat-1";
      },
      code: "QUALITY_UNIT_SHARD_RECEIPTS_INVALID",
    },
    {
      name: "missing aggregate coverage",
      mutate: (receipts) => {
        receipts[0].parsed.coverage = null;
      },
      code: "QUALITY_UNIT_SHARD_COVERAGE_INVALID",
    },
    {
      name: "missing per-file coverage",
      mutate: (receipts) => {
        receipts[0].parsed.coverageFiles = {};
      },
      code: "QUALITY_UNIT_SHARD_COVERAGE_INVALID",
    },
    {
      name: "extra per-file coverage",
      mutate: (receipts) => {
        receipts[0].parsed.coverageFiles["lib/unassigned.js"] = {
          lines: 100,
          branches: 100,
          functions: 100,
        };
      },
      code: "QUALITY_UNIT_SHARD_COVERAGE_INVALID",
    },
    {
      name: "inconsistent unit population",
      mutate: (receipts) => {
        receipts[0].parsed.passed = 9;
      },
      code: "QUALITY_POPULATION_INVALID",
    },
    {
      name: "empty mutation population",
      mutate: (receipts) => {
        const receipt = receipts.find((entry) =>
          entry.name.startsWith("critical-mutation-")
        );
        receipt.parsed.total = 0;
        receipt.parsed.killed = 0;
      },
      code: "QUALITY_POPULATION_INVALID",
    },
    {
      name: "inconsistent mutation score",
      mutate: (receipts) => {
        receipts.find((entry) =>
          entry.name.startsWith("critical-mutation-")
        ).parsed.scorePercent = 99;
      },
      code: "QUALITY_POPULATION_INVALID",
    },
    {
      name: "failed classifier meta-test",
      mutate: (receipts) => {
        receipts.find((entry) =>
          entry.name.startsWith("critical-mutation-")
        ).parsed.metaTests[0].passed = false;
      },
      code: "QUALITY_POPULATION_INVALID",
    },
    {
      name: "undefined Gherkin",
      mutate: (receipts) => {
        const receipt = receipts.find((entry) =>
          entry.name.startsWith("executable-gherkin-")
        );
        receipt.parsed.ok = false;
        receipt.parsed.passed = 3;
        receipt.parsed.undefined = 1;
      },
      code: "QUALITY_POPULATION_INVALID",
    },
    {
      name: "valid but too-small unit population",
      mutate: () => {},
      profile: { minimumUnitTestsPerRun: 11 },
      code: "QUALITY_METRICS_FAILED",
    },
    {
      name: "warning budget",
      mutate: (receipts) => {
        receipts.find((entry) =>
          entry.name.startsWith("focused-")
        ).stdout = "warning: new warning";
      },
      code: "QUALITY_METRICS_FAILED",
    },
    {
      name: "deterministic drift",
      mutate: (receipts) => {
        receipts.at(-1).semanticSha256 = "0".repeat(64);
      },
      code: "QUALITY_METRICS_FAILED",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const receipts = qualityReceipts();
      item.mutate(receipts);
      const ledger = ledgerFixture(phase, {
        qualityPolicy: {
          trustedGatePaths: [],
          profiles: { hardcore: profile(item.profile) },
        },
      });
      assert.throws(
        () =>
          runner.summarizeReceipts(receipts, ledger, phase, true, {
            effectiveProfile: profile(item.profile),
            requiredCoverageFiles: Object.keys(coverageFiles()),
          }),
        (error) => error.code === item.code,
      );
    });
  }
});

test("dependency environment uses a bounded offline cache", () => {
  const priorCache = process.env.PIKIIO_QUALITY_NPM_CACHE;
  const invalid = temporaryDirectory("ordinary-cache-");
  const valid = temporaryDirectory("pikiio-quality-cache-");
  const temporaryRoot = temporaryDirectory("pikiio-quality-env-");
  try {
    process.env.PIKIIO_QUALITY_NPM_CACHE = invalid;
    assert.throws(
      () => runner.dependencyCachePath(),
      (error) => error.code === "QUALITY_NPM_CACHE_INVALID",
    );
    process.env.PIKIIO_QUALITY_NPM_CACHE = valid;
    assert.equal(runner.dependencyCachePath(), fs.realpathSync(valid));
    const environment = runner.disposableJudgeEnvironment({
      codexHome: path.join(temporaryRoot, "home"),
      npmUserConfigPath: path.join(temporaryRoot, ".npmrc"),
      temporaryRoot,
      sourceEnvironment: {},
      cachePath: valid,
    });
    assert.equal(environment.npm_config_cache, valid);
    assert.equal(environment.npm_config_offline, "true");
    assert.equal(environment.npm_config_ignore_scripts, "true");
    assert.equal(environment.HOME, path.join(temporaryRoot, "home"));
  } finally {
    if (priorCache === undefined) {
      delete process.env.PIKIIO_QUALITY_NPM_CACHE;
    } else {
      process.env.PIKIIO_QUALITY_NPM_CACHE = priorCache;
    }
    fs.rmSync(invalid, { recursive: true, force: true });
    fs.rmSync(valid, { recursive: true, force: true });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("dependency installation binds unchanged package inputs and audit output", () => {
  const root = temporaryDirectory("pikiio-quality-install-");
  try {
    writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
    writeFile(
      path.join(root, "package-lock.json"),
      '{"lockfileVersion":3}\n',
    );
    const packageJsonSha256 = governance.sha256(
      fs.readFileSync(path.join(root, "package.json")),
    );
    const packageLockSha256 = governance.sha256(
      fs.readFileSync(path.join(root, "package-lock.json")),
    );
    const calls = [];
    const operations = {
      runLayer: (input) => {
        calls.push(input);
        return {
          stdout: '{"dependencies":{}}',
          stderr: "",
          status: 0,
          isolation: "sandbox",
          semanticSha256: `${calls.length}`.repeat(64),
        };
      },
      verifyDependencyAudit: () => ({
        packageJsonSha256,
        packageLockSha256,
        manifestSha256: "a".repeat(64),
      }),
      qualityToolchainEvidence: () => ({ toolchainSha256: "b".repeat(64) }),
    };
    const result = runner.installAndAuditDependencies({
      worktree: root,
      environment: {},
      operations,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].allowWorkspaceWrites, true);
    assert.equal(calls[1].allowWorkspaceWrites, undefined);
    assert.equal(result.manifest.manifestSha256, "a".repeat(64));
    assert.equal(result.toolchain.toolchainSha256, "b".repeat(64));

    operations.verifyDependencyAudit = () => ({
      packageJsonSha256: "0".repeat(64),
      packageLockSha256,
    });
    assert.throws(
      () =>
        runner.installAndAuditDependencies({
          worktree: root,
          environment: {},
          operations,
        }),
      (error) => error.code === "DEPENDENCY_INPUT_CHANGED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disposable judge proves immutable detached execution and always cleans up", () => {
  const root = initializeRepository();
  const foreignRoot = initializeRepository();
  const fakeBin = temporaryDirectory("pikiio-quality-fake-git-");
  const marker = path.join(fakeBin, "executed");
  fs.writeFileSync(
    path.join(fakeBin, "git"),
    `#!/bin/sh\nprintf poison > ${JSON.stringify(marker)}\nexit 99\n`,
    { mode: 0o755 },
  );
  try {
    const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const candidateTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const operations = {
      materializeAutomationInputs: (_snapshot, codexHome) => ({
        codexHome,
        npmUserConfigPath: path.join(codexHome, ".npmrc"),
        digest: "c".repeat(64),
      }),
      disposableJudgeEnvironment: () => ({ TMPDIR: "/tmp" }),
      installAndAuditDependencies: () => judgeFixture().dependencies,
      executePlan: () => [
        { name: "layer", semanticSha256: "d".repeat(64) },
      ],
      summarizeReceipts: () => ({
        metrics: { failedTests: 0 },
        populations: { unit: [], mutation: [], gherkin: [] },
      }),
    };
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
      () =>
        runner.runDisposableJudge({
          label: "unit",
          candidateCommit,
          candidateTree,
          automationSnapshot: {},
          ledger: {},
          phase: {},
          cleanJudge: false,
          repoRoot: root,
          operations,
        }),
    );
    assert.equal(result.workspaceUnchanged, true);
    assert.equal(result.worktreeHead, candidateCommit);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(result.summary.layerDigests, [
      { name: "layer", semanticSha256: "d".repeat(64) },
    ]);
    assert.doesNotMatch(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }),
      /pikiio-quality-unit-/,
    );

    assert.throws(
      () =>
        runner.runDisposableJudge({
          label: "mismatch",
          candidateCommit,
          candidateTree: "0".repeat(40),
          automationSnapshot: {},
          ledger: {},
          phase: {},
          cleanJudge: false,
          repoRoot: root,
          operations,
        }),
      (error) => error.code === "DISPOSABLE_JUDGE_CANDIDATE_MISMATCH",
    );

    const mutatingOperations = {
      ...operations,
      executePlan: ({ root: worktree }) => {
        fs.writeFileSync(path.join(worktree, "mutated.txt"), "mutation\n");
        return [{ name: "layer", semanticSha256: "d".repeat(64) }];
      },
    };
    assert.throws(
      () =>
        runner.runDisposableJudge({
          label: "mutation",
          candidateCommit,
          candidateTree,
          automationSnapshot: {},
          ledger: {},
          phase: {},
          cleanJudge: false,
          repoRoot: root,
          operations: mutatingOperations,
        }),
      (error) => error.code === "DISPOSABLE_JUDGE_WORKTREE_CHANGED",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(foreignRoot, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("judge cleanup refuses leaked registrations and preserves the primary error", async (t) => {
  const worktree = "/tmp/pikiio-quality-cleanup/repo";
  assert.equal(
    runner.worktreeIsRegistered(
      `worktree /tmp/other\n\nworktree ${worktree}\n`,
      worktree,
    ),
    true,
  );
  assert.equal(runner.worktreeIsRegistered("", worktree), false);

  await t.test("registered success", () => {
    const calls = [];
    const listings = [
      `worktree ${worktree}\n`,
      "worktree /tmp/other\n",
    ];
    const result = runner.cleanupDisposableJudge({
      label: "success",
      repoRoot: "/tmp/repo",
      worktree,
      temporaryRoot: "/tmp/pikiio-quality-cleanup",
      operations: {
        listWorktrees: () => listings.shift(),
        removeWorktree: () => calls.push("worktree"),
        removeDirectory: () => calls.push("directory"),
      },
    });
    assert.deepEqual(result, { cleaned: true });
    assert.deepEqual(calls, ["worktree", "directory"]);
  });

  await t.test("registration leak", () => {
    assert.throws(
      () =>
        runner.cleanupDisposableJudge({
          label: "leak",
          repoRoot: "/tmp/repo",
          worktree,
          temporaryRoot: "/tmp/pikiio-quality-cleanup",
          operations: {
            listWorktrees: () => `worktree ${worktree}\n`,
            removeWorktree: () => {},
            removeDirectory: () => {},
          },
        }),
      (error) =>
        error.code === "DISPOSABLE_JUDGE_CLEANUP_FAILED" &&
        error.cause.code === "DISPOSABLE_JUDGE_REGISTRATION_LEAK",
    );
  });

  await t.test("primary error retains cleanup failure", () => {
    const primary = new Error("primary");
    const result = runner.cleanupDisposableJudge({
      label: "attached",
      repoRoot: "/tmp/repo",
      worktree,
      temporaryRoot: "/tmp/pikiio-quality-cleanup",
      executionError: primary,
      operations: {
        listWorktrees: () => {
          throw new Error("list failed");
        },
        removeWorktree: () => {},
        removeDirectory: () => {
          throw new Error("remove failed");
        },
      },
    });
    assert.deepEqual(result, { cleaned: false, attached: true });
    assert.match(primary.cleanupError, /list failed|remove failed/);
  });

  await t.test("worktree removal failure is not hidden", () => {
    const listings = [`worktree ${worktree}\n`, "worktree /tmp/other\n"];
    assert.throws(
      () =>
        runner.cleanupDisposableJudge({
          label: "remove",
          repoRoot: "/tmp/repo",
          worktree,
          temporaryRoot: "/tmp/pikiio-quality-cleanup",
          operations: {
            listWorktrees: () => listings.shift(),
            removeWorktree: () => {
              throw new Error("worktree removal failed");
            },
            removeDirectory: () => {},
          },
        }),
      (error) =>
        error.code === "DISPOSABLE_JUDGE_CLEANUP_FAILED" &&
        /worktree removal failed/.test(error.cause.message),
    );
  });
});

test("raw artifacts are immutable content addresses and collisions fail closed", () => {
  const root = temporaryDirectory("pikiio-quality-artifacts-");
  try {
    const judge = judgeFixture();
    const first = runner.persistJudgeArtifacts(judge, {
      artifactDirectory: root,
    });
    const repeated = runner.persistJudgeArtifacts(judge, {
      artifactDirectory: root,
    });
    assert.deepEqual(repeated, first);
    fs.writeFileSync(first.artifactPath, "collision\n");
    assert.throws(
      () =>
        runner.persistJudgeArtifacts(judge, {
          artifactDirectory: root,
        }),
      (error) => error.code === "QUALITY_RAW_ARTIFACT_COLLISION",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function orchestrationFixture({ dirty = false, goalOk = true } = {}) {
  const repoRoot = initializeRepository();
  const selectedPhase = phaseFixture();
  const ledger = ledgerFixture(selectedPhase);
  const before = {
    head: "a".repeat(40),
    tree: "b".repeat(40),
    workspaceDigest: "c".repeat(64),
    receiptHash: "d".repeat(64),
  };
  let judgeCount = 0;
  const persisted = [];
  const services = {
    captureOperationalCheckout: () => structuredClone(before),
    assertOperationalCheckoutUnchanged: () => true,
    loadPhaseLedger: () => ledger,
    selectActivePhase: () => selectedPhase,
    evaluateGoalGuard: () =>
      goalOk
        ? { ok: true }
        : { ok: false, code: "CODEX_GOAL_REQUIRED", error: "goal missing" },
    antiWeakeningAudit: () => ({
      worktreeChangedPaths: dirty ? ["lib/dirty.js"] : [],
      sliceChangedPaths: ["lib/slice.js"],
    }),
    captureAutomationInputs: () => ({ digest: "e".repeat(64) }),
    runDisposableJudge: ({ label }) => {
      judgeCount += 1;
      return judgeFixture(label);
    },
    persistJudgeArtifacts: (judge) => {
      persisted.push(judge.label);
      return judge.rawArtifact;
    },
    assertIndependentJudge: () => ({
      reproduced: true,
      semanticSha256: "f".repeat(64),
    }),
    effectiveQualityProfile: (value) => value,
    expectedQualityLayerPlan: () => [{ name: "layer" }],
    requiredCoverageFilesForPhase: () => ["lib/one.js"],
  };
  return {
    repoRoot,
    ledger,
    selectedPhase,
    before,
    services,
    persisted,
    judgeCount: () => judgeCount,
  };
}

test("gauntlet orchestration separates development and strict receipts", () => {
  const development = orchestrationFixture();
  const developmentResult = withEnvironment({ NODE_ENV: "test" }, () =>
    runner.runQualityGauntletForTest({
      development: true,
      repoRoot: development.repoRoot,
      environment: {
        PIKIIO_CODEX_GOAL_OBJECTIVE: "goal",
        PIKIIO_CODEX_GOAL_THREAD_ID: "thread",
        CODEX_HOME: "/tmp/codex",
      },
      now: () => "2026-07-24T01:00:00.000Z",
      services: development.services,
    }));
  assert.equal(developmentResult.ok, true);
  assert.equal(developmentResult.receipt.developmentOnly, true);
  assert.equal(development.judgeCount(), 1);
  assert.deepEqual(development.persisted, ["primary"]);

  const strict = orchestrationFixture();
  let writtenReceipt;
  strict.services.writeQualityReceipt = (report) => {
    writtenReceipt = {
      ...report,
      receiptHash: governance.sha256(governance.stableJson(report)),
    };
    return writtenReceipt;
  };
  strict.services.readQualityReceipt = () => structuredClone(writtenReceipt);
  strict.services.validateQualityReceipt = () => ({ valid: true });
  const strictResult = withEnvironment({ NODE_ENV: "test" }, () =>
    runner.runQualityGauntletForTest({
      development: false,
      repoRoot: strict.repoRoot,
      environment: {},
      services: strict.services,
    }));
  assert.equal(strictResult.ok, true);
  assert.equal(strict.judgeCount(), 2);
  assert.deepEqual(strict.persisted, ["primary", "independent"]);
  assert.equal(strictResult.receipt.cleanJudge.reproduced, true);
  assert.equal(strictResult.receipt.metrics.cleanCheckoutReproduced, true);
});

test("gauntlet orchestration refuses missing goal, dirty candidates, and forged receipts", async (t) => {
  const invoke = (fixture) =>
    withEnvironment({ NODE_ENV: "test" }, () =>
      runner.runQualityGauntletForTest({
        repoRoot: fixture.repoRoot,
        services: fixture.services,
      }));
  await t.test("goal", () => {
    const fixture = orchestrationFixture({ goalOk: false });
    assert.throws(
      () => invoke(fixture),
      (error) => error.code === "CODEX_GOAL_REQUIRED",
    );
  });
  await t.test("dirty candidate", () => {
    const fixture = orchestrationFixture({ dirty: true });
    assert.throws(
      () => invoke(fixture),
      (error) => error.code === "QUALITY_CANDIDATE_NOT_COMMITTED",
    );
  });
  await t.test("read-back mismatch", () => {
    const fixture = orchestrationFixture();
    fixture.services.writeQualityReceipt = (report) => ({
      ...report,
      receiptHash: "a".repeat(64),
    });
    fixture.services.readQualityReceipt = () => ({ forged: true });
    assert.throws(
      () => invoke(fixture),
      (error) => error.code === "QUALITY_RECEIPT_READBACK_MISMATCH",
    );
  });
  await t.test("canonical validation", () => {
    const fixture = orchestrationFixture();
    let receipt;
    fixture.services.writeQualityReceipt = (report) => {
      receipt = { ...report, receiptHash: "a".repeat(64) };
      return receipt;
    };
    fixture.services.readQualityReceipt = () => receipt;
    fixture.services.validateQualityReceipt = () => ({
      valid: false,
      reason: "forged",
    });
    assert.throws(
      () => invoke(fixture),
      (error) =>
        error.code === "QUALITY_RECEIPT_POSTWRITE_INVALID" &&
        error.details.validation.reason === "forged",
    );
  });
  await t.test("integrity failure is attached to the primary error", () => {
    const fixture = orchestrationFixture({ goalOk: false });
    let assertions = 0;
    fixture.services.assertOperationalCheckoutUnchanged = () => {
      assertions += 1;
      const error = new Error("changed");
      error.code = "OPERATIONAL_CHECKOUT_CHANGED";
      throw error;
    };
    assert.throws(
      () => invoke(fixture),
      (error) =>
        error.code === "CODEX_GOAL_REQUIRED" &&
        error.operationalIntegrityError.code ===
          "OPERATIONAL_CHECKOUT_CHANGED",
    );
    assert.equal(assertions, 1);
  });
});

test("public gauntlet refuses service injection and test harness is alternate-repository only", () => {
  const fixture = orchestrationFixture();
  for (const options of [null, [], { unsupported: true }]) {
    assert.throws(
      () => runner.runQualityGauntlet(options),
      (error) => error.code === "QUALITY_GAUNTLET_OPTIONS_INVALID",
    );
  }
  assert.throws(
    () => runner.runQualityGauntlet({ services: fixture.services }),
    (error) => error.code === "QUALITY_SERVICE_OVERRIDE_FORBIDDEN",
  );
  withEnvironment({ NODE_ENV: "production" }, () => {
    assert.throws(
      () =>
        runner.runQualityGauntletForTest({
          repoRoot: fixture.repoRoot,
          services: fixture.services,
        }),
      (error) => error.code === "QUALITY_TEST_HARNESS_DISABLED",
    );
  });
  withEnvironment({ NODE_ENV: "test" }, () => {
    assert.throws(
      () =>
        runner.runQualityGauntletForTest({
          repoRoot: fixture.repoRoot,
        }),
      (error) => error.code === "QUALITY_TEST_SERVICES_REQUIRED",
    );
    assert.throws(
      () =>
        runner.runQualityGauntletForTest({
          repoRoot: path.join(
            os.tmpdir(),
            "pikiio-quality-runner-repo-does-not-exist",
          ),
          services: fixture.services,
        }),
      (error) => error.code === "QUALITY_TEST_REPOSITORY_INVALID",
    );
    assert.throws(
      () =>
        runner.runQualityGauntletForTest({
          repoRoot: path.resolve(__dirname, ".."),
          services: fixture.services,
        }),
      (error) => error.code === "QUALITY_TEST_REPOSITORY_INVALID",
    );
    const alias = path.join(
      temporaryDirectory("pikiio-quality-runner-alias-"),
      "repo",
    );
    fs.symlinkSync(fixture.repoRoot, alias, "dir");
    assert.throws(
      () =>
        runner.runQualityGauntletForTest({
          repoRoot: alias,
          services: fixture.services,
        }),
      (error) => error.code === "QUALITY_TEST_REPOSITORY_INVALID",
    );
  });
});

test("receipt-stage failures always trigger a fresh final integrity sample", async (t) => {
  for (const stage of ["write", "read", "validate"]) {
    await t.test(stage, () => {
      const fixture = orchestrationFixture();
      let changed = false;
      let captureCount = 0;
      fixture.services.captureOperationalCheckout = () => {
        captureCount += 1;
        return {
          ...fixture.before,
          ...(changed ? { receiptHash: "0".repeat(64) } : {}),
        };
      };
      fixture.services.assertOperationalCheckoutUnchanged = (before, after) => {
        if (before.receiptHash !== after.receiptHash) {
          const error = new Error("checkout changed");
          error.code = "OPERATIONAL_CHECKOUT_CHANGED";
          error.details = { stage };
          throw error;
        }
      };
      let receipt;
      fixture.services.writeQualityReceipt = (report) => {
        if (stage === "write") {
          changed = true;
          const error = new Error("write failed");
          error.code = "QUALITY_RECEIPT_WRITE_FAILED";
          throw error;
        }
        receipt = {
          ...report,
          receiptHash: governance.sha256(governance.stableJson(report)),
        };
        return receipt;
      };
      fixture.services.readQualityReceipt = () => {
        if (stage === "read") {
          changed = true;
          const error = new Error("read failed");
          error.code = "QUALITY_RECEIPT_READ_FAILED";
          throw error;
        }
        return receipt;
      };
      fixture.services.validateQualityReceipt = () => {
        if (stage === "validate") {
          changed = true;
          const error = new Error("validation failed");
          error.code = "QUALITY_RECEIPT_VALIDATION_FAILED";
          throw error;
        }
        return { valid: true };
      };
      assert.throws(
        () =>
          withEnvironment({ NODE_ENV: "test" }, () =>
            runner.runQualityGauntletForTest({
              repoRoot: fixture.repoRoot,
              services: fixture.services,
            })),
        (error) =>
          error.code === {
            write: "QUALITY_RECEIPT_WRITE_FAILED",
            read: "QUALITY_RECEIPT_READ_FAILED",
            validate: "QUALITY_RECEIPT_VALIDATION_FAILED",
          }[stage] &&
          error.operationalIntegrityError?.code ===
            "OPERATIONAL_CHECKOUT_CHANGED",
      );
      assert.ok(captureCount >= 3);
    });
  }
});

test("bootstrap and error serialization never hide refusal evidence", () => {
  assert.deepEqual(
    runner.bootstrapQualityGauntlet({ isMain: false }),
    { executed: false },
  );
  let development;
  const success = runner.bootstrapQualityGauntlet({
    isMain: true,
    argv: ["node", "script", "--development"],
    execute: (input) => {
      development = input.development;
    },
  });
  assert.equal(success.ok, true);
  assert.equal(development, true);

  const error = new Error("layer failed");
  error.code = "QUALITY_LAYER_FAILED";
  error.details = { layer: "unit" };
  error.receipt = { status: 1 };
  error.operationalIntegrityError = { code: "OPERATIONAL_CHECKOUT_CHANGED" };
  error.cleanupError = "cleanup failed";
  let output;
  let exitCode;
  const failure = runner.bootstrapQualityGauntlet({
    isMain: true,
    argv: [],
    execute: () => {
      throw error;
    },
    logError: (value) => {
      output = JSON.parse(value);
    },
    setExitCode: (value) => {
      exitCode = value;
    },
  });
  assert.equal(failure.ok, false);
  assert.equal(output.code, "QUALITY_LAYER_FAILED");
  assert.equal(output.receipt.status, 1);
  assert.equal(output.cleanupError, "cleanup failed");
  assert.equal(exitCode, 1);
  assert.equal(
    runner.qualityFailurePayload("plain").code,
    "QUALITY_GAUNTLET_FAILED",
  );
  let logged;
  const mainResult = runner.main({
    development: true,
    execute: ({ development }) => ({
      ok: true,
      developmentOnly: development,
    }),
    log: (value) => {
      logged = JSON.parse(value);
    },
  });
  assert.equal(mainResult.developmentOnly, true);
  assert.deepEqual(logged, mainResult);
});

test("surface counters and independent evidence comparison bind exact semantics", () => {
  assert.deepEqual(
    runner.countTestSurface(
      'test("x",()=>assert.ok(true));\n',
      "tests/x.test.js",
    ),
    { tests: 1, assertions: 1, scenarios: 0, mutants: 0 },
  );
  assert.deepEqual(
    runner.countTestSurface("Scenario: one\nScenario: two\n", "x.feature"),
    { tests: 0, assertions: 0, scenarios: 2, mutants: 0 },
  );
  assert.deepEqual(
    runner.countTestSurface('const m=[{id:"M-1"}];', "mutate-x.js"),
    { tests: 0, assertions: 0, scenarios: 0, mutants: 1 },
  );
  assert.deepEqual(
    runner.addCounts(
      { tests: 1, assertions: 2, scenarios: 3, mutants: 4 },
      { tests: 4, assertions: 3, scenarios: 2, mutants: 1 },
    ),
    { tests: 5, assertions: 5, scenarios: 5, mutants: 5 },
  );
  const judge = judgeFixture();
  assert.equal(runner.judgeSemantic(judge).candidateCommit, "a".repeat(40));
  assert.equal(
    runner.assertIndependentJudge(
      structuredClone(judge),
      structuredClone(judge),
    ).reproduced,
    true,
  );
  const divergent = structuredClone(judge);
  divergent.dependencies.toolchain.toolchainSha256 = "0".repeat(64);
  assert.throws(
    () => runner.assertIndependentJudge(judge, divergent),
    (error) => error.code === "CLEAN_CHECKOUT_REPRODUCTION_MISMATCH",
  );
});

test("source lookup distinguishes present and missing committed authority", () => {
  const root = initializeRepository();
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    assert.match(
      runner.sourceAtCommit(commit, "tests/authority.test.js", root),
      /authority/,
    );
    assert.equal(runner.sourceAtCommit(commit, "missing.js", root), "");
    assert.throws(
      () =>
        runner.sourceAtCommit(
          commit,
          "tests/authority.test.js",
          path.join(root, "not-a-repository"),
        ),
      (error) => error.code === "SEALED_GIT_REPOSITORY_UNREADABLE",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source lookup fatally decodes verified Git blobs without replacement characters", () => {
  const root = initializeRepository();
  const invalidSources = new Map([
    ["tests/invalid-c3-28.js", Buffer.from([0xc3, 0x28])],
    ["tests/invalid-truncated.js", Buffer.from([0xe2, 0x82])],
    ["tests/invalid-overlong.js", Buffer.from([0xc0, 0xaf])],
    ["tests/invalid-surrogate.js", Buffer.from([0xed, 0xa0, 0x80])],
  ]);
  const validSource = `${String.fromCodePoint(
    0x00,
    0x7f,
    0x80,
    0x7ff,
    0x800,
    0xd7ff,
    0xe000,
    0xffff,
    0x10000,
    0x10ffff,
  )}\n`;
  try {
    for (const [relativePath, bytes] of invalidSources) {
      writeFile(path.join(root, relativePath), bytes);
    }
    writeFile(
      path.join(root, "tests", "valid-utf8-boundaries.js"),
      Buffer.from(validSource, "utf8"),
    );
    execFileSync("git", ["add", "tests"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "raw UTF-8 fixtures"], {
      cwd: root,
    });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    assert.equal(
      runner.sourceAtCommit(
        commit,
        "tests/valid-utf8-boundaries.js",
        root,
      ),
      validSource,
    );
    for (const relativePath of invalidSources.keys()) {
      assert.throws(
        () => runner.sourceAtCommit(commit, relativePath, root),
        (error) => {
          assert.equal(error.name, "QualitySourceEncodingError");
          assert.equal(error.code, "QUALITY_SOURCE_ENCODING_INVALID");
          assert.equal(error.details.commit, commit);
          assert.equal(error.details.relativePath, relativePath);
          assert.equal(error.message.includes("\ufffd"), false);
          return true;
        },
        relativePath,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("toolchain evidence is content-addressed and cached", () => {
  const first = runner.qualityToolchainEvidence();
  const second = runner.qualityToolchainEvidence();
  assert.equal(second, first);
  assert.match(first.nodeSha256, /^[a-f0-9]{64}$/);
  assert.match(first.npmCliSha256, /^[a-f0-9]{64}$/);
  assert.match(first.toolchainSha256, /^[a-f0-9]{64}$/);
});

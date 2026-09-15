#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const governance = require("../lib/pikiio-agent-governance");

const ROOT = path.resolve(__dirname, "..");
const INVARIANT_JUDGE =
  process.env.PIKIIO_QUALITY_INVARIANT_JUDGE === "1";
const REQUIRED_SCRIPTS = [
  "scripts/pikiio-agent-goal-guard.js",
  "scripts/pikiio-agent-dirty-guard.js",
  "scripts/pikiio-agent-writer-lease.js",
  "scripts/pikiio-agent-lease-holder.js",
  "scripts/pikiio-agent-run-receipt.js",
  "scripts/pikiio-agent-production-command.js",
  "scripts/pikiio-agent-activation-receipt.js",
  "scripts/pikiio-agent-phase-transition.js",
  "scripts/run-pikiio-quality-gauntlet.js",
  "scripts/mutate-pikiio-agent-governance.js",
  "scripts/verify-pikiio-governance-gherkin.js",
  "scripts/verify-pikiio-agent-governance.js",
  "lib/pikiio-live-refresh-lock.js",
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireText(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(
      source.includes(fragment),
      `${label} is missing required enforcement text: ${fragment}`,
    );
  }
}

function initializeGoalFixture(branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-goal-verifier-"));
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Pikiio Governance Verifier"], {
    cwd: root,
  });
  fs.writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
  execFileSync("git", ["add", "fixture.txt"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "goal fixture"], { cwd: root });
  return root;
}

function verifyGoalAndProductionDenials(ledger) {
  const goalRepo = INVARIANT_JUDGE
    ? initializeGoalFixture(ledger.baseline.branch)
    : ROOT;
  try {
    const missing = governance.evaluateGoalGuard({
      ledger,
      repoRoot: goalRepo,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "CODEX_GOAL_REQUIRED");

    const mismatch = governance.evaluateGoalGuard({
      ledger,
      repoRoot: goalRepo,
      goalObjective: `${ledger.codexGoal.objective} altered`,
      goalThreadId: ledger.codexGoal.threadId,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, "CODEX_GOAL_MISMATCH");

    const exact = governance.evaluateGoalGuard({
      ledger,
      repoRoot: goalRepo,
      goalObjective: ledger.codexGoal.objective,
      goalThreadId: ledger.codexGoal.threadId,
    });
    assert.equal(exact.ok, true, exact.error);

    const directProduction = governance.evaluateGoalGuard({
      ledger,
      repoRoot: goalRepo,
      goalObjective: ledger.codexGoal.objective,
      goalThreadId: ledger.codexGoal.threadId,
      productionAction: "deploy",
    });
    assert.equal(directProduction.ok, false);
    assert.equal(directProduction.code, "PRODUCTION_WRAPPER_REQUIRED");

    const phase = governance.selectActivePhase(ledger);
    if (!phase.productionAuthority.enabled) {
      const disabled = governance.evaluateProductionGate({
        ledger,
        repoRoot: goalRepo,
        goalObjective: ledger.codexGoal.objective,
        goalThreadId: ledger.codexGoal.threadId,
        action: "deploy",
      });
      assert.equal(disabled.ok, false);
      assert.equal(disabled.code, "PRODUCTION_AUTHORITY_DISABLED");
    }
    return {
      missingGoal: missing.code,
      mismatchedGoal: mismatch.code,
      directProduction: directProduction.code,
      wrapperDefault:
        phase.productionAuthority.enabled
          ? "phase-authority-enabled"
          : "PRODUCTION_AUTHORITY_DISABLED",
    };
  } finally {
    if (goalRepo !== ROOT) {
      fs.rmSync(goalRepo, { recursive: true, force: true });
    }
  }
}

function verifyDirtyScope(ledger, phase) {
  if (INVARIANT_JUDGE) {
    const pinnedRuntimeEvidence = [];
    for (const entry of ledger.baseline.preExistingDirty) {
      assert.equal(entry.preserve, true);
      assert.equal(entry.excludeFromGit, true);
      assert.equal(entry.excludeFromDeploy, true);
      const absolute = path.join(ROOT, entry.path);
      if (fs.existsSync(absolute)) {
        const actual = governance.digestTree(ROOT, entry.path);
        assert.equal(actual.treeDigest, entry.treeDigest);
        assert.equal(actual.fileCount, entry.fileCount);
        pinnedRuntimeEvidence.push({ path: entry.path, state: "present-and-exact" });
      } else {
        pinnedRuntimeEvidence.push({ path: entry.path, state: "absent-from-clean-checkout" });
      }
    }
    const cleanLedger = clone(ledger);
    cleanLedger.baseline.preExistingDirty = [];
    const result = governance.evaluateDirtyGuard({
      ledger: cleanLedger,
      phase,
      repoRoot: ROOT,
      statusOutput: "",
      committedOutput: "",
    });
    assert.equal(result.ok, true);
    return {
      scopeEvaluatorPassed: true,
      pinnedContractEntries: pinnedRuntimeEvidence.length,
    };
  }

  const result = governance.evaluateDirtyGuard({ ledger, phase, repoRoot: ROOT });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({
      baselineErrors: result.baselineErrors,
      blockedWorking: result.working.blocked,
      blockedCommitted: result.committed.blocked,
      trustedGateMutations: result.trustedGateMutations,
    }),
  );
  return {
    scopeEvaluatorPassed: true,
    pinnedContractEntries: result.baseline.length,
  };
}

function effectiveIgnoreProbe(ignoreSource, relativePaths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-ignore-verifier-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ignoreSource);
    for (const relativePath of relativePaths) {
      const absolute = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "probe\n");
      const result = spawnSync(
        "git",
        ["check-ignore", "--no-index", "--quiet", "--", relativePath],
        { cwd: root },
      );
      assert.equal(
        result.status,
        0,
        `${relativePath} is not effectively excluded by the ignore rules`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function candidatePaths() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 30 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

function artifactFingerprints(artifactRoot) {
  if (!fs.existsSync(artifactRoot)) return [];
  return fs
    .readdirSync(artifactRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = path.join(entry.parentPath || entry.path, entry.name);
      const stat = fs.statSync(absolute);
      return {
        relativePath: path.relative(ROOT, absolute).split(path.sep).join("/"),
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
      };
    });
}

function verifyDeploymentExclusion(ledger) {
  const probePaths = [
    ".ceremony-artifacts/probe.txt",
    ".ceremony-artifacts/deep/probe.txt",
    ...ledger.baseline.preExistingDirty.flatMap((entry) => [
      `${entry.path.replace(/\/+$/, "")}/probe.txt`,
      `${entry.path.replace(/\/+$/, "")}/deep/probe.txt`,
    ]),
  ];
  effectiveIgnoreProbe(read(".gitignore"), probePaths);
  effectiveIgnoreProbe(read(".vercelignore"), probePaths);

  const candidates = candidatePaths();
  assert.equal(
    candidates.some((relativePath) =>
      relativePath === ".ceremony-artifacts" ||
      relativePath.startsWith(".ceremony-artifacts/"),
    ),
    false,
    "Ceremony evidence entered the Git/deployment candidate manifest",
  );

  const fingerprints = artifactFingerprints(path.join(ROOT, ".ceremony-artifacts"));
  const bySize = new Map();
  for (const fingerprint of fingerprints) {
    if (!bySize.has(fingerprint.size)) bySize.set(fingerprint.size, []);
    bySize.get(fingerprint.size).push(fingerprint);
  }
  const leaks = [];
  for (const relativePath of candidates) {
    const absolute = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      let target = "";
      try {
        target = fs.realpathSync(absolute);
      } catch {
        leaks.push({ relativePath, reason: "broken deployment symlink" });
        continue;
      }
      const artifactRoot = path.join(ROOT, ".ceremony-artifacts");
      if (target === artifactRoot || target.startsWith(`${artifactRoot}${path.sep}`)) {
        leaks.push({ relativePath, reason: "symlink resolves into ceremony evidence" });
      }
      continue;
    }
    if (!stat.isFile() || !bySize.has(stat.size)) continue;
    const sameSize = bySize.get(stat.size);
    if (sameSize.some((entry) => entry.dev === stat.dev && entry.ino === stat.ino)) {
      leaks.push({ relativePath, reason: "hardlink aliases ceremony evidence" });
      continue;
    }
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(absolute))
      .digest("hex");
    if (sameSize.some((entry) => entry.sha256 === digest)) {
      leaks.push({ relativePath, reason: "content duplicates ceremony evidence" });
    }
  }
  assert.deepEqual(leaks, [], `Deployment candidate contains ceremony evidence: ${JSON.stringify(leaks)}`);
  return {
    effectiveGitIgnore: true,
    effectiveVercelIgnore: true,
    aliasesOrCopies: leaks.length,
  };
}

function verifyStaticBoundaries() {
  for (const relativePath of REQUIRED_SCRIPTS) {
    assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} is missing`);
  }

  const writer = read("scripts/pikiio-agent-writer-lease.js");
  const holder = read("scripts/pikiio-agent-lease-holder.js");
  const morning = read("scripts/run-morning-refresh.js");
  const liveRefresh = read("scripts/live-refresh.js");
  const liveRefreshLock = read("lib/pikiio-live-refresh-lock.js");
  const receipt = read("scripts/pikiio-agent-run-receipt.js");
  const production = read("scripts/pikiio-agent-production-command.js");
  const qualityLauncher = read("scripts/run-pikiio-quality-gauntlet.js");
  const quality = read("lib/pikiio-quality-runner.js");

  requireText(
    writer,
    [
      '"/usr/bin/lockf"',
      '"/usr/bin/flock"',
      "createCapability()",
      "mode: 0o600",
      "sendControlRequest(handlePath",
    ],
    "writer lease client",
  );
  assert.equal(
    holder.includes("archiveStaleOperationLock"),
    false,
    "Lease holder may not delete or archive another operation lock",
  );
  requireText(
    holder,
    [
      "capabilitySha256",
      "mode: 0o600",
      'request.operation === "morning-terminal"',
      "MORNING_TERMINAL_REQUIRED",
      "Date.now() >= Date.parse(current.expiresAt)",
      "pidAlive(config.supervisedPid)",
    ],
    "writer lease holder",
  );
  const terminalIndex = morning.indexOf('"morning-terminal"');
  const releaseIndex = morning.indexOf('"release"', terminalIndex);
  assert.ok(
    terminalIndex !== -1 && releaseIndex > terminalIndex,
    "Morning refresh must record a terminal receipt before releasing its lease",
  );
  requireText(
    morning,
    [
      '"--lease-class=morning"',
      "`--supervised-pid=${process.pid}`",
      "acquireMorningWriterLease()",
      "terminalRecorded",
    ],
    "morning refresh",
  );
  requireText(
    liveRefresh,
    [
      "LOCK_OPERATION_PATH",
      "LOCK_STALE_MS",
      "acquireNestedRunLock",
      "operationPath: LOCK_OPERATION_PATH",
    ],
    "live-refresh nested-lock wrapper",
  );
  requireText(
    liveRefreshLock,
    [
      "OPERATION_SCHEMA",
      "RUN_LOCK_SCHEMA",
      "removePathStillOwned",
      "shouldReclaimNestedTmsLock",
      "LIVE_REFRESH_OPERATION_FOREIGN_HOST",
      "LIVE_REFRESH_OPERATION_OWNERSHIP_CHANGED",
      "LIVE_REFRESH_LOCK_FOREIGN_HOST",
      "LIVE_REFRESH_LOCK_OWNERSHIP_CHANGED",
      "isPidAlive(current.payload.pid)",
      "isPidAlive(payload.pid)",
      "fs.rename(operationPath, stalePath)",
      "fs.rename(lockPath, stalePath)",
    ],
    "nested TMS lock authority",
  );
  requireText(
    receipt,
    ["loadHandle(handlePath)", "appendRunReceipt(input", "handle.capability"],
    "run receipt wrapper",
  );
  requireText(
    production,
    ["evaluateProductionGate", "loadHandle", "PRODUCTION_EXECUTOR_NOT_CONFIGURED"],
    "production wrapper",
  );
  requireText(
    quality,
    [
      "antiWeakeningAudit",
      "runDisposableJudge",
      "persistJudgeArtifacts",
      "assertIndependentJudge",
      "qualityToolchainEvidence",
      "minimumObservedCoverage",
      "criticalMutantKillPercent",
      "gherkinPassPercent",
      "deterministicRepeatCount",
    ],
    "quality gauntlet",
  );
  requireText(
    qualityLauncher,
    [
      "bootstrapQualityGauntlet",
      "module.exports = runner",
    ],
    "decision-free quality launcher",
  );
  assert.equal(
    /\bfunction\b|spawnSync|execFileSync|writeQualityReceipt|minimumObservedCoverage/.test(
      qualityLauncher,
    ),
    false,
    "Quality launcher must remain a decision-free delegate",
  );

  const operationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-operation-verifier-"));
  try {
    assert.throws(
      () =>
        governance.withOperationLock(
          path.join(operationRoot, "operation.lock"),
          async () => true,
        ),
      (error) => error.code === "ASYNC_OPERATION_LOCK_CALLBACK_REFUSED",
    );
  } finally {
    fs.rmSync(operationRoot, { recursive: true, force: true });
  }

  return {
    requiredScripts: REQUIRED_SCRIPTS.length,
    osAdvisoryLock: true,
    privateCapabilityHandle: true,
    morningTerminalBeforeRelease: true,
    nestedTmsLockOwnership: true,
    receiptCapabilityBinding: true,
    soleProductionWrapper: true,
    synchronousOperationLock: true,
  };
}

function verifyQualityContract(ledger, phase) {
  const profile = ledger.qualityPolicy.profiles[phase.qualityProfile];
  const expected = governance.expectedQualityLayerNames(
    phase,
    profile.deterministicRepeatCount,
  );
  assert.ok(expected.length > phase.qualityPlan.syntaxFiles.length);
  assert.equal(new Set(expected).size, expected.length, "Quality layer names must be unique");
  for (const gatePath of governance.REQUIRED_TRUSTED_GATE_PATHS) {
    assert.ok(
      ledger.qualityPolicy.trustedGatePaths.includes(gatePath),
      `Trusted quality gate is missing: ${gatePath}`,
    );
  }
  return {
    profile: phase.qualityProfile,
    deterministicRepeats: profile.deterministicRepeatCount,
    expectedLayerCount: expected.length,
    minimumCoverage: {
      lines: profile.minimumLineCoveragePercent,
      branches: profile.minimumBranchCoveragePercent,
      functions: profile.minimumFunctionCoveragePercent,
    },
    minimumMutationScore: profile.minimumMutationScorePercent,
    minimumCriticalMutantKill: profile.minimumCriticalMutantKillPercent,
    minimumGherkinPass: profile.minimumGherkinPassPercent,
  };
}

function main() {
  const ledger = governance.loadPhaseLedger();
  const validation = governance.validatePhaseLedger(ledger);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  const phase = governance.selectActivePhase(ledger);
  assert.equal(phase.id, ledger.activePhaseId);

  const report = {
    ok: true,
    schema: ledger.schema,
    ledgerRevision: ledger.revision,
    activePhaseId: phase.id,
    invariantJudge: INVARIANT_JUDGE,
    goalAndProduction: verifyGoalAndProductionDenials(ledger),
    dirtyScope: verifyDirtyScope(ledger, phase),
    deploymentExclusion: verifyDeploymentExclusion(ledger),
    staticBoundaries: verifyStaticBoundaries(),
    qualityContract: verifyQualityContract(ledger, phase),
  };
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "PIKIIO_AGENT_GOVERNANCE_VERIFICATION_FAILED",
    error: error instanceof Error ? error.message : String(error),
    details: error.details || {},
  }, null, 2));
  process.exit(1);
}

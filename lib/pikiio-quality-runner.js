#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  CANONICAL_REGISTRY_SHA256,
  DEFAULT_QUALITY_RECEIPT_PATH,
  PHASE_LEDGER_RELATIVE_PATH,
  QUALITY_CHECK_REGISTRY,
  QUALITY_TEST_SUITE_REGISTRY,
  effectiveQualityProfile,
  evaluateGoalGuard,
  expectedQualityLayerPlan,
  loadPhaseLedger,
  parseGitNameStatus,
  parseGitStatus,
  qualityCheckCommand,
  qualityUnitArgs,
  qualityUnitShardArgs,
  requiredCoverageFilesForPhase,
  selectActivePhase,
  sha256,
  stableJson,
  validateQualityReceipt,
  validatePhaseTransitionHistory,
  workspaceEvidenceDigest,
  writeQualityReceipt,
} = require("./pikiio-agent-governance");
const {
  DEPENDENCY_AUDIT_ARGS,
  LOCKED_INSTALL_ARGS,
  assertOperationalCheckoutUnchanged,
  captureAutomationInputs,
  captureOperationalCheckout,
  materializeAutomationInputs,
  verifyDependencyAudit,
} = require("./pikiio-quality-execution");
const {
  normalizedOutput,
  semanticReceipt,
  semanticReceiptSha256,
} = require("./pikiio-quality-canonical");
const {
  SEALED_ENVIRONMENT,
  SealedGitError,
  createSealedGit,
  resolveTrustedGitExecutable,
} = require("./pikiio-sealed-git");

const ROOT = path.resolve(__dirname, "..");
const TIME_ZONES = ["UTC", "America/New_York", "Pacific/Honolulu"];
const SEEDS = ["11441155601", "20260724", "8675309"];
const TIMEOUT_MS = 20 * 60 * 1000;
const GIT_CONTROL_TIMEOUT_MS = 60 * 1000;
const TRUSTED_GIT = resolveTrustedGitExecutable();
const TRUSTED_GIT_MUTATION_PREFIX = Object.freeze([
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
const FORBIDDEN_TEST_WEAKENING = [
  /\b(?:test|it|describe)\.skip\s*\(/,
  /\b(?:test|it|describe)\.todo\s*\(/,
  /\b(?:test|it|describe)\.only\s*\(/,
  /\b(?:xit|xdescribe)\s*\(/,
  /(?:c8|istanbul)\s+ignore/i,
  /\b(?:jest|vitest|mocha|test|it|describe)\.(?:retry|retries)\s*\(/i,
  /--(?:test-)?retries(?:=|\s)/i,
  /\b(?:jest|vitest|mocha|test|it|describe)\.(?:setTimeout|timeout)\s*\(/,
  new RegExp(["--test", "timeout(?:=|\\\\s)"].join("-")),
];
const QUALITY_ENVIRONMENT_OVERRIDE_KEYS = new Set([
  "CODEX_HOME",
  "HOME",
  "TMPDIR",
  "TZ",
  "PIKIIO_TEST_SEED",
  "PIKIIO_QUALITY_INVARIANT_JUDGE",
  "PIKIIO_PHASE_PROOF_PROFILE",
  "PIKIIO_TRUTH_PHASE_ACCEPTANCE",
  "PIKIIO_ACTION_PHASE_ACCEPTANCE",
  "npm_config_audit",
  "npm_config_cache",
  "npm_config_fund",
  "npm_config_ignore_scripts",
  "npm_config_include",
  "npm_config_logs_dir",
  "npm_config_offline",
  "npm_config_omit",
  "npm_config_update_notifier",
  "npm_config_userconfig",
  "npm_config_workspaces",
]);

function hasFlag(name, argv = process.argv) {
  return argv.includes(name);
}

function scrubQualityEnvironment(source = process.env, overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!QUALITY_ENVIRONMENT_OVERRIDE_KEYS.has(key)) {
      const error = new Error(`Unsupported quality environment override: ${key}`);
      error.code = "QUALITY_ENVIRONMENT_OVERRIDE_INVALID";
      throw error;
    }
  }
  const safePath = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(path.delimiter);
  return {
    CI: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    LOGNAME: "pikiio-quality",
    NO_COLOR: "1",
    NODE_ENV: "test",
    PATH: safePath,
    PIKIIO_QUALITY_NETWORK_MODE: "deny",
    SHELL: "/bin/sh",
    USER: "pikiio-quality",
    ...(source.PIKIIO_CODEX_GOAL_OBJECTIVE
      ? { PIKIIO_CODEX_GOAL_OBJECTIVE: source.PIKIIO_CODEX_GOAL_OBJECTIVE }
      : {}),
    ...(source.PIKIIO_CODEX_GOAL_THREAD_ID
      ? { PIKIIO_CODEX_GOAL_THREAD_ID: source.PIKIIO_CODEX_GOAL_THREAD_ID }
      : {}),
    ...overrides,
  };
}

function trustedNpmCliPath() {
  const cellarMarker = `${path.sep}Cellar${path.sep}`;
  const cellarIndex = process.execPath.indexOf(cellarMarker);
  const candidates = [
    cellarIndex > 0
      ? path.join(
          process.execPath.slice(0, cellarIndex),
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        )
      : "",
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue through the finite, deterministic trusted locations.
    }
  }
  const error = new Error("A trusted npm CLI could not be resolved");
  error.code = "QUALITY_NPM_RUNTIME_UNAVAILABLE";
  throw error;
}

const NPM_CLI_PATH = trustedNpmCliPath();
let cachedToolchainEvidence = null;

function qualityToolchainEvidence() {
  if (cachedToolchainEvidence) return cachedToolchainEvidence;
  const npmPackagePath = path.resolve(
    path.dirname(NPM_CLI_PATH),
    "..",
    "package.json",
  );
  const npmPackage = JSON.parse(fs.readFileSync(npmPackagePath, "utf8"));
  const evidence = {
    platform: process.platform,
    arch: process.arch,
    nodePath: fs.realpathSync(process.execPath),
    nodeVersion: process.version,
    nodeSha256: sha256(fs.readFileSync(process.execPath)),
    npmCliPath: NPM_CLI_PATH,
    npmVersion: npmPackage.version,
    npmCliSha256: sha256(fs.readFileSync(NPM_CLI_PATH)),
  };
  cachedToolchainEvidence = {
    ...evidence,
    toolchainSha256: sha256(stableJson(evidence)),
  };
  return cachedToolchainEvidence;
}

function assertOperationalGitConfigSafe(configPath) {
  const source = fs.readFileSync(configPath, "utf8");
  let section = "";
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(
      /^\[(core|user|remote\s+"[^"]+"|branch\s+"[^"]+")\]$/,
    );
    if (sectionMatch) {
      section = sectionMatch[1].split(/\s/)[0];
      continue;
    }
    const keyMatch = line.match(/^([a-zA-Z0-9.-]+)\s*=\s*(.*)$/);
    const allowedKeys = {
      core: new Set([
        "repositoryformatversion",
        "filemode",
        "bare",
        "logallrefupdates",
        "ignorecase",
        "precomposeunicode",
      ]),
      remote: new Set(["url", "fetch"]),
      branch: new Set(["remote", "merge"]),
      user: new Set(["name", "email"]),
    };
    if (
      !keyMatch ||
      !allowedKeys[section]?.has(keyMatch[1].toLowerCase()) ||
      /(?:[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@|extraheader|credential|oauth|gh[opsu]_|token|password|secret|`|\$\(|\n|\r)/i.test(
        keyMatch[2],
      )
    ) {
      const error = new Error(
        "Operational Git config contains a non-data or credential-bearing entry",
      );
      error.code = "QUALITY_GIT_CONFIG_UNSAFE";
      throw error;
    }
  }
  return sha256(source);
}

function isolatedCommand(
  command,
  args,
  { socketRoot = "", writableRoots = [] } = {},
) {
  const normalizedWritableRoots = writableRoots
    .filter(Boolean)
    .map((candidate) => fs.realpathSync(candidate));
  for (const writableRoot of normalizedWritableRoots) {
    if (
      writableRoot === ROOT ||
      ROOT.startsWith(`${writableRoot}${path.sep}`) ||
      writableRoot === path.parse(writableRoot).root ||
      !writableRoot
        .split(path.sep)
        .some((segment) => segment.startsWith("pikiio-quality-"))
    ) {
      const error = new Error(
        `Quality writable root is too broad: ${writableRoot}`,
      );
      error.code = "QUALITY_WRITABLE_ROOT_INVALID";
      throw error;
    }
  }
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    if (!socketRoot.startsWith("/private/tmp/pikiio-quality-ipc-")) {
      const error = new Error("Quality IPC root is outside the dedicated sandbox");
      error.code = "QUALITY_IPC_ROOT_INVALID";
      throw error;
    }
    const escapedSocketRoot = socketRoot
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"');
    const escapeSandboxPath = (value) =>
      value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const deniedReadRoots = [
      fs.realpathSync(os.homedir()),
      fs.realpathSync(
        process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      ),
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .map(escapeSandboxPath);
    const operationalGitRoot = fs.realpathSync(path.join(ROOT, ".git"));
    const operationalGitConfig = path.join(operationalGitRoot, "config");
    assertOperationalGitConfigSafe(operationalGitConfig);
    const realUserHome = fs.realpathSync(os.homedir());
    const operationalMetadataPaths = [realUserHome];
    let metadataCursor = realUserHome;
    for (const segment of path
      .relative(realUserHome, operationalGitRoot)
      .split(path.sep)
      .filter(Boolean)) {
      metadataCursor = path.join(metadataCursor, segment);
      operationalMetadataPaths.push(metadataCursor);
    }
    const allowedReadRoots = [
      path.join(operationalGitRoot, "objects"),
      path.join(operationalGitRoot, "refs"),
      path.join(operationalGitRoot, "worktrees"),
      operationalGitConfig,
      path.join(operationalGitRoot, "HEAD"),
      path.join(operationalGitRoot, "packed-refs"),
      path.join(operationalGitRoot, "info", "exclude"),
      dependencyCachePath(),
    ]
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => escapeSandboxPath(fs.realpathSync(candidate)));
    const writableRules = normalizedWritableRoots.map((writableRoot) => {
      const escaped = writableRoot
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
      return `(allow file-write* (subpath "${escaped}"))`;
    });
    return {
      command: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        [
          "(version 1)",
          "(allow default)",
          "(deny network*)",
          "(deny file-write*)",
          ...deniedReadRoots.map(
            (readRoot) => `(deny file-read* (subpath "${readRoot}"))`,
          ),
          ...allowedReadRoots.map(
            (readRoot) => `(allow file-read* (subpath "${readRoot}"))`,
          ),
          ...operationalMetadataPaths.map(
            (metadataPath) =>
              `(allow file-read-metadata (literal "${escapeSandboxPath(metadataPath)}"))`,
          ),
          '(allow file-write* (literal "/dev/null"))',
          ...writableRules,
          `(allow file-write* (subpath "${escapedSocketRoot}"))`,
          `(allow network-bind (subpath "${escapedSocketRoot}"))`,
          `(allow network-outbound (subpath "${escapedSocketRoot}"))`,
        ].join(""),
        command,
        ...args,
      ],
      isolation: "macos-sandbox-deny-network",
    };
  }
  if (process.platform === "linux" && fs.existsSync("/usr/bin/bwrap")) {
    const error = new Error(
      "Linux quality isolation is disabled until HOME and CODEX_HOME read masking is proven",
    );
    error.code = "QUALITY_READ_ISOLATION_UNPROVEN";
    throw error;
  }
  const error = new Error("No fail-closed network isolation runtime is available");
  error.code = "QUALITY_NETWORK_ISOLATION_UNAVAILABLE";
  throw error;
}

function qualityCheckInvocation(checkId, root = ROOT) {
  const check = QUALITY_CHECK_REGISTRY[checkId];
  if (!check) {
    const error = new Error(`Unknown immutable quality check ${checkId}`);
    error.code = "QUALITY_CHECK_UNKNOWN";
    throw error;
  }
  if (check.packageScript) {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const script = packageJson.scripts?.[check.packageScript.name];
    if (
      typeof script !== "string" ||
      sha256(script) !== check.packageScript.sha256
    ) {
      const error = new Error(
        `Immutable package script ${check.packageScript.name} changed`,
      );
      error.code = "QUALITY_PACKAGE_SCRIPT_MISMATCH";
      throw error;
    }
  }
  return {
    command:
      check.executable === "node" || check.executable === "npm"
        ? process.execPath
        : check.executable === "git" && fs.existsSync("/usr/bin/git")
          ? "/usr/bin/git"
          : check.executable,
    args:
      check.executable === "npm"
        ? [NPM_CLI_PATH, ...check.args]
        : [...check.args],
    displayCommand: qualityCheckCommand(checkId),
    definitionSha256: sha256(stableJson(check)),
  };
}

function parseLastJsonObject(value) {
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
      return JSON.parse(text.slice(starts[index]));
    } catch {
      // Continue to the preceding line-aligned object.
    }
  }
  return null;
}

function parseTap(value) {
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
    const metrics = columns.slice(1, 4).map((column) =>
      /^\s*[\d.]+\s*$/.test(column) ? Number(column.trim()) : null,
    );
    if (metrics.every((metric) => metric === null)) {
      coveragePath[indent] = name;
      coveragePath.length = indent + 1;
      continue;
    }
    if (metrics.some((metric) => !Number.isFinite(metric))) continue;
    const relativePath = [...coveragePath.slice(0, indent), name].join("/");
    coverageFiles[relativePath] = {
      lines: metrics[0],
      branches: metrics[1],
      functions: metrics[2],
    };
  }
  return {
    tests: number("tests"),
    suites: number("suites"),
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

function runLayer({
  name,
  command,
  args,
  cwd = ROOT,
  env = process.env,
  parser = null,
  checkId,
  definitionSha256,
  displayCommand = [command, ...args].join(" "),
  allowWorkspaceWrites = false,
}) {
  const startedAt = new Date().toISOString();
  const socketRoot =
    process.platform === "darwin"
      ? fs.mkdtempSync("/private/tmp/pikiio-quality-ipc-")
      : fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-quality-ipc-"));
  let isolated;
  let result;
  try {
    isolated = isolatedCommand(command, args, {
      socketRoot,
      writableRoots: [
        allowWorkspaceWrites ? cwd : "",
        env.TMPDIR,
      ].filter(Boolean),
    });
    result = spawnSync(isolated.command, isolated.args, {
      cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: {
        ...env,
        PIKIIO_QUALITY_SOCKET_ROOT: socketRoot,
      },
      maxBuffer: 30 * 1024 * 1024,
    });
  } finally {
    if (socketRoot) {
      fs.rmSync(socketRoot, { recursive: true, force: true });
    }
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const parsed = parser ? parser(stdout) : parseLastJsonObject(stdout);
  const receipt = {
    name,
    checkId,
    definitionSha256,
    command: displayCommand,
    isolation: isolated.isolation,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout,
    stderr,
    parsed,
    normalizationRoots: [
      cwd,
      env.TMPDIR,
      socketRoot,
    ].filter(Boolean),
  };
  if (
    result.error ||
    result.status !== 0 ||
    result.signal ||
    receipt.timedOut
  ) {
    const error = new Error(`${name} failed`);
    error.code = "QUALITY_LAYER_FAILED";
    error.receipt = {
      ...receipt,
      stdout: stdout.slice(-12000),
      stderr: stderr.slice(-12000),
      spawnError: result.error?.message || null,
    };
    throw error;
  }
  receipt.semanticSha256 = semanticReceiptSha256(receipt);
  return receipt;
}

function sourceAtCommit(commit, relativePath, repoRoot = ROOT) {
  let bytes;
  try {
    bytes = createSealedGit({
      repoRoot: path.resolve(repoRoot),
    }).show({ commit, path: relativePath });
  } catch (error) {
    if (
      error instanceof SealedGitError &&
      error.code === "SEALED_GIT_PATH_MISSING"
    ) {
      return "";
    }
    throw error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const sourceError = new Error(
      `Committed source is not valid UTF-8: ${relativePath}`,
    );
    sourceError.name = "QualitySourceEncodingError";
    sourceError.code = "QUALITY_SOURCE_ENCODING_INVALID";
    sourceError.details = {
      commit,
      relativePath,
      cause: error instanceof Error ? error.message : String(error),
    };
    throw sourceError;
  }
}

function countTestSurface(source, relativePath) {
  const isFeature = relativePath.endsWith(".feature");
  const isMutation = relativePath.includes("mutate-");
  return {
    tests: (source.match(/\btest\s*\(/g) || []).length,
    assertions: (source.match(/\bassert(?:\.|\s*\()/g) || []).length,
    scenarios: isFeature ? (source.match(/^\s*Scenario:/gm) || []).length : 0,
    mutants: isMutation ? (source.match(/\bid:\s*["']/g) || []).length : 0,
  };
}

function addCounts(left, right) {
  return {
    tests: left.tests + right.tests,
    assertions: left.assertions + right.assertions,
    scenarios: left.scenarios + right.scenarios,
    mutants: left.mutants + right.mutants,
  };
}

function antiWeakeningAudit(ledger, phase, {
  repoRoot = ROOT,
  transitionValidator = validatePhaseTransitionHistory,
} = {}) {
  const sealedGit = createSealedGit({
    repoRoot: path.resolve(repoRoot),
    maxStdoutBytes: 32 * 1024 * 1024,
  });
  const candidateHead = sealedGit.head();
  const statusOutput = sealedGit.status();
  const committedOutput = sealedGit.diff({
    from: phase.scopeBaseCommit,
    to: candidateHead,
    format: "name-status-z-renames",
  });
  const sliceDiff = sealedGit.diff({
    from: phase.scopeBaseCommit,
    to: candidateHead,
    format: "binary",
  });
  const workingEntries = parseGitStatus(statusOutput);
  const sliceEntries = parseGitNameStatus(committedOutput);
  const worktreeChangedPaths = [
    ...new Set(workingEntries.flatMap((entry) => entry.paths)),
  ].sort();
  const sliceChangedPaths = [
    ...new Set(sliceEntries.flatMap((entry) => entry.paths)),
  ].sort();
  const auditedPaths = [
    ...new Set([...worktreeChangedPaths, ...sliceChangedPaths]),
  ].sort();
  const protectedChanged = auditedPaths.filter((changedPath) =>
    ledger.qualityPolicy.trustedGatePaths.includes(changedPath),
  );
  let canonicalTransition = null;
  if (phase.lane !== "autonomy-governance" && protectedChanged.length) {
    const protectedWorktree = protectedChanged.filter((relativePath) =>
      worktreeChangedPaths.includes(relativePath),
    );
    const protectedSlice = protectedChanged.filter((relativePath) =>
      sliceChangedPaths.includes(relativePath),
    );
    if (
      protectedWorktree.length === 0 &&
      protectedSlice.length === 1 &&
      protectedSlice[0] === PHASE_LEDGER_RELATIVE_PATH
    ) {
      canonicalTransition = transitionValidator({
        ledger,
        phase,
        repoRoot,
      });
    }
    if (!canonicalTransition?.ok) {
      const error = new Error("A non-governance phase changed a trusted quality gate");
      error.code = "TRUSTED_QUALITY_GATE_CHANGED";
      error.details = { protectedChanged, canonicalTransition };
      throw error;
    }
  }

  const inspected = auditedPaths.filter((changedPath) =>
    /\.(?:js|feature|json)$/.test(changedPath) &&
    fs.existsSync(path.join(repoRoot, changedPath)) &&
    fs.statSync(path.join(repoRoot, changedPath)).isFile(),
  );
  const weakeningFindings = [];
  for (const relativePath of inspected) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    for (const pattern of FORBIDDEN_TEST_WEAKENING) {
      if (pattern.test(source)) {
        weakeningFindings.push({ relativePath, pattern: String(pattern) });
      }
    }
  }
  if (weakeningFindings.length) {
    const error = new Error("Behavior slice contains forbidden test weakening");
    error.code = "TEST_WEAKENING_DETECTED";
    error.details = { weakeningFindings };
    throw error;
  }

  const protectedPaths = ledger.qualityPolicy.trustedGatePaths.filter((relativePath) =>
    /\.(?:js|feature)$/.test(relativePath),
  );
  let baselineCounts = { tests: 0, assertions: 0, scenarios: 0, mutants: 0 };
  let currentCounts = { tests: 0, assertions: 0, scenarios: 0, mutants: 0 };
  for (const relativePath of protectedPaths) {
    baselineCounts = addCounts(
      baselineCounts,
      countTestSurface(
        sourceAtCommit(phase.scopeBaseCommit, relativePath, repoRoot),
        relativePath,
      ),
    );
    const absolute = path.join(repoRoot, relativePath);
    const currentSource = fs.existsSync(absolute)
      ? fs.readFileSync(absolute, "utf8")
      : "";
    currentCounts = addCounts(
      currentCounts,
      countTestSurface(currentSource, relativePath),
    );
  }
  if (
    phase.lane !== "autonomy-governance" &&
    Object.keys(currentCounts).some(
      (key) => currentCounts[key] < baselineCounts[key],
    )
  ) {
    const error = new Error("Trusted test, scenario, mutant, or assertion count decreased");
    error.code = "QUALITY_SURFACE_DECREASED";
    error.details = { baselineCounts, currentCounts };
    throw error;
  }
  return {
    scopeBaseCommit: phase.scopeBaseCommit,
    candidateHead,
    sliceDiffSha256: sha256(sliceDiff),
    worktreeChangedPaths,
    sliceChangedPaths,
    auditedPaths,
    protectedChanged,
    canonicalTransition,
    weakeningFindings,
    baselineCounts,
    currentCounts,
  };
}

function unitArgs(plan, profile, requiredCoverageFiles = null) {
  return qualityUnitArgs(
    plan.testSuiteId,
    profile,
    requiredCoverageFiles,
  );
}

function executeCheck(name, checkId, options = {}) {
  const parsed = qualityCheckInvocation(checkId, options.cwd || ROOT);
  return runLayer({
    name,
    command: parsed.command,
    args: parsed.args,
    checkId,
    definitionSha256: parsed.definitionSha256,
    displayCommand: parsed.displayCommand,
    ...options,
  });
}

function warningFindings(receipts) {
  const findings = [];
  for (const receipt of receipts) {
    const combined = `${receipt.stdout}\n${receipt.stderr}`;
    const lines = combined
      .split("\n")
      .filter(
        (line) =>
          /\b(?:warning|warn)\s*:/i.test(line) ||
          /^\s*npm\s+warn\b/i.test(line),
      );
    for (const line of lines) {
      findings.push({ layer: receipt.name, line: line.slice(0, 500) });
    }
  }
  return findings;
}

function repeatConsistency(receipts, repeatCount) {
  const byBaseName = new Map();
  for (const receipt of receipts) {
    const baseName = receipt.name.replace(/-repeat-\d+$/, "");
    if (!byBaseName.has(baseName)) byBaseName.set(baseName, []);
    byBaseName.get(baseName).push(receipt);
  }
  const flaky = [];
  for (const [name, group] of byBaseName) {
    if (group.length !== repeatCount) continue;
    const hashes = new Set(group.map((receipt) => receipt.semanticSha256));
    if (hashes.size !== 1) flaky.push({ name, hashes: [...hashes] });
  }
  return flaky;
}

function requirePerFileCoverage(
  unitReceipts,
  requiredCoverageFiles,
  profile,
) {
  const perFileCoverage = unitReceipts.map((receipt) =>
    requiredCoverageFiles.map((relativePath) => ({
      relativePath,
      metrics: receipt.parsed?.coverageFiles?.[relativePath] || null,
    })),
  );
  const invalidFileCoverage = perFileCoverage.flat().filter(
    ({ metrics }) =>
      !metrics ||
      metrics.lines < profile.minimumLineCoveragePercent ||
      metrics.branches < profile.minimumBranchCoveragePercent ||
      metrics.functions < profile.minimumFunctionCoveragePercent,
  );
  if (invalidFileCoverage.length > 0) {
    const error = new Error(
      "One or more safety-bearing files lack per-file coverage proof",
    );
    error.code = "QUALITY_PER_FILE_COVERAGE_FAILED";
    error.details = { invalidFileCoverage };
    throw error;
  }
  return perFileCoverage;
}

function aggregateUnitShardReceipts(
  unitReceipts,
  suite,
  repeatCount,
) {
  if (!suite.shards) return unitReceipts;
  const expectedNames = new Set();
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    for (const shard of suite.shards) {
      expectedNames.add(
        `unit-contract-property-negative-${shard.id}-repeat-${repeat}`,
      );
    }
  }
  if (
    unitReceipts.length !== expectedNames.size ||
    unitReceipts.some(
      (receipt) =>
        !expectedNames.has(receipt.name) ||
        unitReceipts.filter((entry) => entry.name === receipt.name).length !==
          1,
    )
  ) {
    const error = new Error(
      "Unit shard receipts do not match the immutable repeat plan",
    );
    error.code = "QUALITY_UNIT_SHARD_RECEIPTS_INVALID";
    throw error;
  }
  const byName = new Map(
    unitReceipts.map((receipt) => [receipt.name, receipt]),
  );
  const aggregates = [];
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const shardReceipts = suite.shards.map((shard) => {
      const receipt = byName.get(
        `unit-contract-property-negative-${shard.id}-repeat-${repeat}`,
      );
      const observedCoverageFiles = Object.keys(
        receipt?.parsed?.coverageFiles || {},
      ).sort();
      if (
        stableJson(observedCoverageFiles) !==
          stableJson([...shard.coverageIncludes].sort()) ||
        !receipt?.parsed?.coverage
      ) {
        const error = new Error(
          "Unit shard coverage does not match its immutable file partition",
        );
        error.code = "QUALITY_UNIT_SHARD_COVERAGE_INVALID";
        error.details = {
          shardId: shard.id,
          repeat,
          expectedCoverageFiles: [...shard.coverageIncludes],
          observedCoverageFiles,
        };
        throw error;
      }
      return { shard, receipt };
    });
    const coverageFiles = {};
    for (const { receipt } of shardReceipts) {
      Object.assign(coverageFiles, receipt.parsed.coverageFiles);
    }
    const coverageMetrics = Object.values(coverageFiles);
    const sum = (field) =>
      shardReceipts.reduce(
        (total, { receipt }) =>
          total + Number(receipt.parsed?.[field]),
        0,
      );
    aggregates.push({
      name: `unit-contract-property-negative-repeat-${repeat}`,
      semanticSha256: sha256(
        stableJson(
          shardReceipts.map(({ shard, receipt }) => ({
            shardId: shard.id,
            semanticSha256: receipt.semanticSha256,
          })),
        ),
      ),
      parsed: {
        tests: sum("tests"),
        passed: sum("passed"),
        failed: sum("failed"),
        cancelled: sum("cancelled"),
        skipped: sum("skipped"),
        todo: sum("todo"),
        coverage: {
          lines: Math.min(
            ...coverageMetrics.map((entry) => entry.lines),
          ),
          branches: Math.min(
            ...coverageMetrics.map((entry) => entry.branches),
          ),
          functions: Math.min(
            ...coverageMetrics.map((entry) => entry.functions),
          ),
        },
        coverageFiles,
      },
    });
  }
  return aggregates;
}

const DEFAULT_PLAN_OPERATIONS = Object.freeze({
  runLayer,
  executeCheck,
  scrubQualityEnvironment,
  unitArgs,
  unitShardArgs: qualityUnitShardArgs,
  expectedQualityLayerPlan,
});

function executePlan({
  root = ROOT,
  ledger,
  phase,
  baseEnvironment = process.env,
  effectiveProfile = null,
  requiredCoverageFiles = null,
  operations = {},
}) {
  const runtime = { ...DEFAULT_PLAN_OPERATIONS, ...operations };
  const run = runtime.runLayer;
  const runCheck = runtime.executeCheck;
  const scrubEnvironment = runtime.scrubQualityEnvironment;
  const buildUnitArgs = runtime.unitArgs;
  const buildUnitShardArgs = runtime.unitShardArgs;
  const buildExpectedPlan = runtime.expectedQualityLayerPlan;
  const plan = phase.qualityPlan;
  const profile =
    effectiveProfile ||
    effectiveQualityProfile(
      ledger.qualityPolicy.profiles[phase.qualityProfile],
      phase.id,
    );
  const coverageFiles =
    requiredCoverageFiles ||
    [...QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId].coverageIncludes].sort();
  const receipts = [];
  const repeatCount = profile.deterministicRepeatCount;
  const exactPlan = new Map(
    buildExpectedPlan(phase, profile, {
      requiredCoverageFiles: coverageFiles,
    }).map((layer) => [layer.name, layer]),
  );

  for (const relativePath of plan.syntaxFiles) {
    const name = `syntax:${relativePath}`;
    receipts.push(run({
      name,
      command: process.execPath,
      args: ["-c", relativePath],
      checkId: `syntax:${relativePath}`,
      definitionSha256: exactPlan.get(name).definitionSha256,
      displayCommand: `node -c ${relativePath}`,
      cwd: root,
      env: scrubEnvironment(baseEnvironment),
    }));
  }

  for (let repeat = 0; repeat < repeatCount; repeat += 1) {
    const suffix = `repeat-${repeat + 1}`;
    const env = scrubEnvironment(baseEnvironment, {
      TZ: TIME_ZONES[repeat % TIME_ZONES.length],
      PIKIIO_TEST_SEED: SEEDS[repeat % SEEDS.length],
      PIKIIO_QUALITY_INVARIANT_JUDGE: "1",
      PIKIIO_PHASE_PROOF_PROFILE: phase.id,
      ...(phase.id.startsWith("TRUTH-")
        ? { PIKIIO_TRUTH_PHASE_ACCEPTANCE: phase.id }
        : {}),
      ...(phase.id.startsWith("ACTION-")
        ? { PIKIIO_ACTION_PHASE_ACCEPTANCE: phase.id }
        : {}),
    });
    const suite = QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId];
    if (suite.shards) {
      for (const shard of suite.shards) {
        const unitName =
          `unit-contract-property-negative-${shard.id}-${suffix}`;
        const args = buildUnitShardArgs(
          plan.testSuiteId,
          shard.id,
          profile,
          coverageFiles,
        );
        receipts.push(run({
          name: unitName,
          command: process.execPath,
          args,
          checkId: `${plan.testSuiteId}:${shard.id}`,
          definitionSha256: exactPlan.get(unitName).definitionSha256,
          displayCommand: ["node", ...args].join(" "),
          cwd: root,
          env,
          parser: parseTap,
        }));
      }
    } else {
      const unitName = `unit-contract-property-negative-${suffix}`;
      const args = buildUnitArgs(plan, profile, coverageFiles);
      receipts.push(run({
        name: unitName,
        command: process.execPath,
        args,
        checkId: plan.testSuiteId,
        definitionSha256: exactPlan.get(unitName).definitionSha256,
        displayCommand: ["node", ...args].join(" "),
        cwd: root,
        env,
        parser: parseTap,
      }));
    }
    receipts.push(runCheck(
      `executable-gherkin-${suffix}`,
      plan.gherkinCheckId,
      { cwd: root, env },
    ));
    receipts.push(runCheck(
      `critical-mutation-${suffix}`,
      plan.mutationCheckId,
      { cwd: root, env },
    ));
    for (const [groupName, checkIds] of [
      ["focused", plan.focusedCheckIds],
      ["neighbor", plan.neighborCheckIds],
      ["broad", plan.broadCheckIds],
      ["production-shaped", plan.productionShapedCheckIds],
    ]) {
      checkIds.forEach((checkId, index) => {
        receipts.push(runCheck(
          `${groupName}-${index + 1}-${suffix}`,
          checkId,
          { cwd: root, env },
        ));
      });
    }
  }
  return receipts;
}

function summarizeReceipts(
  receipts,
  ledger,
  phase,
  cleanCheckoutReproduced,
  {
    effectiveProfile = null,
    requiredCoverageFiles = null,
  } = {},
) {
  const profile =
    effectiveProfile ||
    effectiveQualityProfile(
      ledger.qualityPolicy.profiles[phase.qualityProfile],
      phase.id,
    );
  const repeatCount = profile.deterministicRepeatCount;
  const rawUnitReceipts = receipts.filter((receipt) =>
    receipt.name.startsWith("unit-contract-property-negative-"),
  );
  const suite =
    QUALITY_TEST_SUITE_REGISTRY[phase.qualityPlan.testSuiteId];
  const unitReceipts = aggregateUnitShardReceipts(
    rawUnitReceipts,
    suite,
    repeatCount,
  );
  const gherkinReceipts = receipts.filter((receipt) =>
    receipt.name.startsWith("executable-gherkin-"),
  );
  const mutationReceipts = receipts.filter((receipt) =>
    receipt.name.startsWith("critical-mutation-"),
  );
  const failedTests = unitReceipts.reduce(
    (sum, receipt) => sum + Number(receipt.parsed?.failed || 0),
    0,
  );
  const skippedRequiredTests = unitReceipts.reduce(
    (sum, receipt) =>
      sum +
      Number(receipt.parsed?.skipped || 0) +
      Number(receipt.parsed?.todo || 0) +
      Number(receipt.parsed?.cancelled || 0),
    0,
  );
  const undefinedGherkinSteps = gherkinReceipts.reduce(
    (sum, receipt) => sum + Number(receipt.parsed?.undefined || 0),
    0,
  );
  const survivedCriticalMutants = mutationReceipts.reduce(
    (sum, receipt) => sum + Number(receipt.parsed?.survivedCritical || 0),
    0,
  );
  const flaky = repeatConsistency(receipts, profile.deterministicRepeatCount);
  const warnings = warningFindings(receipts);
  const coverage = unitReceipts.map((receipt) => receipt.parsed?.coverage);
  if (coverage.some((entry) => !entry)) {
    const error = new Error("One or more unit runs did not emit parsed coverage");
    error.code = "QUALITY_COVERAGE_MISSING";
    throw error;
  }
  const coverageFiles =
    requiredCoverageFiles ||
    [...QUALITY_TEST_SUITE_REGISTRY[phase.qualityPlan.testSuiteId]
      .coverageIncludes].sort();
  const perFileCoverage = requirePerFileCoverage(
    unitReceipts,
    coverageFiles,
    profile,
  );
  const perFileCoverageBody = {
    requiredFiles: coverageFiles,
    repeats: perFileCoverage.map((repeatFiles, index) => ({
      repeat: index + 1,
      files: repeatFiles.map(({ relativePath, metrics }) => ({
        path: relativePath,
        lines: metrics.lines,
        branches: metrics.branches,
        functions: metrics.functions,
      })),
    })),
  };
  const perFileCoverageProof = {
    schema: "pikiio-per-file-coverage-proof-v1",
    ...perFileCoverageBody,
    proofSha256: sha256(stableJson(perFileCoverageBody)),
  };
  const mutationScores = mutationReceipts.map((receipt) => ({
    ok: receipt.parsed?.ok === true,
    total: Number(receipt.parsed?.total),
    killed: Number(receipt.parsed?.killed),
    survived: Number(receipt.parsed?.survived),
    criticalTotal: Number(receipt.parsed?.criticalTotal),
    criticalKilled: Number(receipt.parsed?.criticalKilled),
    survivedCritical: Number(receipt.parsed?.survivedCritical),
    score: Number(receipt.parsed?.scorePercent),
    critical: Number(receipt.parsed?.criticalMutantKillPercent),
    metaTests: receipt.parsed?.metaTests,
  }));
  const gherkinScores = gherkinReceipts.map((receipt) => ({
    ok: receipt.parsed?.ok === true,
    scenarios: Number(receipt.parsed?.scenarios),
    passed: Number(receipt.parsed?.passed),
    failed: Number(receipt.parsed?.failed),
    skipped: Number(receipt.parsed?.skipped),
    undefined: Number(receipt.parsed?.undefined),
    ambiguous: Number(receipt.parsed?.ambiguous),
    pending: Number(receipt.parsed?.pending),
    score: Number(receipt.parsed?.passPercent),
  }));
  const populations = {
    unit: unitReceipts.map((receipt) => ({
      tests: Number(receipt.parsed?.tests),
      passed: Number(receipt.parsed?.passed),
      failed: Number(receipt.parsed?.failed),
      cancelled: Number(receipt.parsed?.cancelled),
      skipped: Number(receipt.parsed?.skipped),
      todo: Number(receipt.parsed?.todo),
    })),
    mutation: mutationScores.map((entry) => ({
      total: entry.total,
      killed: entry.killed,
      survived: entry.survived,
      criticalTotal: entry.criticalTotal,
      criticalKilled: entry.criticalKilled,
      survivedCritical: entry.survivedCritical,
      scorePercent: entry.score,
      criticalKillPercent: entry.critical,
      metaTestsPassed:
        Array.isArray(entry.metaTests) &&
        entry.metaTests.length > 0 &&
        entry.metaTests.every((metaTest) => metaTest?.passed === true),
    })),
    gherkin: gherkinScores.map((entry) => ({
      scenarios: entry.scenarios,
      passed: entry.passed,
      failed: entry.failed,
      skipped: entry.skipped,
      undefined: entry.undefined,
      ambiguous: entry.ambiguous,
      pending: entry.pending,
      passPercent: entry.score,
    })),
  };
  const unitPopulationsValid =
    unitReceipts.length === repeatCount &&
    unitReceipts.every((receipt) => {
    const parsed = receipt.parsed;
    return (
      Number.isSafeInteger(parsed?.tests) &&
      parsed.tests > 0 &&
      Number.isSafeInteger(parsed?.passed) &&
      Number.isSafeInteger(parsed?.failed) &&
      Number.isSafeInteger(parsed?.cancelled) &&
      Number.isSafeInteger(parsed?.skipped) &&
      Number.isSafeInteger(parsed?.todo) &&
      parsed.passed +
        parsed.failed +
        parsed.cancelled +
        parsed.skipped +
        parsed.todo ===
        parsed.tests
    );
    });
  const mutationPopulationsValid =
    mutationScores.length === repeatCount &&
    mutationScores.every(
    (entry) =>
      entry.ok &&
      Number.isSafeInteger(entry.total) &&
      entry.total > 0 &&
      Number.isSafeInteger(entry.killed) &&
      Number.isSafeInteger(entry.survived) &&
      entry.killed + entry.survived === entry.total &&
      Number.isSafeInteger(entry.criticalTotal) &&
      entry.criticalTotal > 0 &&
      Number.isSafeInteger(entry.criticalKilled) &&
      Number.isSafeInteger(entry.survivedCritical) &&
      entry.criticalKilled + entry.survivedCritical === entry.criticalTotal &&
      Number(((entry.killed / entry.total) * 100).toFixed(2)) === entry.score &&
      Number(
        ((entry.criticalKilled / entry.criticalTotal) * 100).toFixed(2),
      ) === entry.critical &&
      Array.isArray(entry.metaTests) &&
      entry.metaTests.length > 0 &&
      entry.metaTests.every((metaTest) => metaTest?.passed === true),
    );
  const gherkinPopulationsValid =
    gherkinScores.length === repeatCount &&
    gherkinScores.every(
    (entry) =>
      entry.ok &&
      Number.isSafeInteger(entry.scenarios) &&
      entry.scenarios > 0 &&
      entry.passed === entry.scenarios &&
      entry.failed === 0 &&
      entry.skipped === 0 &&
      entry.undefined === 0 &&
      entry.ambiguous === 0 &&
      entry.pending === 0 &&
      entry.score === 100,
    );
  if (
    !unitPopulationsValid ||
    !mutationPopulationsValid ||
    !gherkinPopulationsValid ||
    mutationScores.some(
      (entry) => !Number.isFinite(entry.score) || !Number.isFinite(entry.critical),
    ) ||
    gherkinScores.some((entry) => !Number.isFinite(entry.score))
  ) {
    const error = new Error(
      "Unit, mutation, or Gherkin output has an empty or inconsistent population",
    );
    error.code = "QUALITY_POPULATION_INVALID";
    throw error;
  }
  const metrics = {
    requiredLayersPassed: receipts.length,
    testRuns: unitReceipts.length,
    testsPerRun: Math.min(...populations.unit.map((entry) => entry.tests)),
    minimumMutationPopulation: Math.min(
      ...mutationScores.map((entry) => entry.total),
    ),
    minimumCriticalMutationPopulation: Math.min(
      ...mutationScores.map((entry) => entry.criticalTotal),
    ),
    minimumGherkinScenarioPopulation: Math.min(
      ...gherkinScores.map((entry) => entry.scenarios),
    ),
    mutationClassifierMetaTestsPassed: mutationScores.every((entry) =>
      entry.metaTests.every((metaTest) => metaTest.passed === true),
    ),
    deterministicRepeatCount: repeatCount,
    failedTests,
    skippedRequiredTests,
    flakyTests: flaky.length,
    newWarnings: warnings.length,
    undefinedGherkinSteps,
    survivedCriticalMutants,
    minimumObservedCoverage: {
      lines: Math.min(
        ...perFileCoverage.flat().map((entry) => entry.metrics.lines),
      ),
      branches: Math.min(
        ...perFileCoverage.flat().map((entry) => entry.metrics.branches),
      ),
      functions: Math.min(
        ...perFileCoverage.flat().map((entry) => entry.metrics.functions),
      ),
    },
    perFileCoverage: perFileCoverageProof,
    minimumObservedMutationScore: Math.min(
      ...mutationScores.map((entry) => entry.score),
    ),
    criticalMutantKillPercent: Math.min(
      ...mutationScores.map((entry) => entry.critical),
    ),
    gherkinPassPercent: Math.min(
      ...gherkinScores.map((entry) => entry.score),
    ),
    cleanCheckoutReproduced,
  };
  if (
    failedTests > 0 ||
    skippedRequiredTests > profile.maximumSkippedRequiredTests ||
    flaky.length > profile.maximumFlakyTests ||
    warnings.length > profile.maximumNewWarnings ||
    undefinedGherkinSteps > 0 ||
    survivedCriticalMutants > 0 ||
    metrics.minimumObservedCoverage.lines < profile.minimumLineCoveragePercent ||
    metrics.minimumObservedCoverage.branches <
      profile.minimumBranchCoveragePercent ||
    metrics.minimumObservedCoverage.functions <
      profile.minimumFunctionCoveragePercent ||
    metrics.minimumObservedMutationScore <
      profile.minimumMutationScorePercent ||
    metrics.criticalMutantKillPercent <
      profile.minimumCriticalMutantKillPercent ||
    metrics.gherkinPassPercent < profile.minimumGherkinPassPercent ||
    metrics.testsPerRun < profile.minimumUnitTestsPerRun ||
    metrics.minimumMutationPopulation < profile.minimumMutationPopulation ||
    metrics.minimumCriticalMutationPopulation <
      profile.minimumCriticalMutationPopulation ||
    metrics.minimumGherkinScenarioPopulation <
      profile.minimumGherkinScenarioPopulation ||
    metrics.mutationClassifierMetaTestsPassed !== true ||
    metrics.deterministicRepeatCount !== profile.deterministicRepeatCount ||
    metrics.testRuns !== profile.deterministicRepeatCount
  ) {
    const error = new Error("Parsed quality metrics violate the active profile");
    error.code = "QUALITY_METRICS_FAILED";
    error.details = { metrics, flaky, warnings };
    throw error;
  }
  return { metrics, populations, flaky, warnings };
}

function dependencyCachePath() {
  const requested =
    process.env.PIKIIO_QUALITY_NPM_CACHE ||
    process.env.npm_config_cache ||
    path.join(os.homedir(), ".npm");
  const resolved = fs.realpathSync(requested);
  if (
    !fs.statSync(resolved).isDirectory() ||
    (path.basename(resolved) !== ".npm" &&
      !resolved
        .split(path.sep)
        .some((segment) => segment.startsWith("pikiio-quality-")))
  ) {
    const error = new Error("Offline npm cache is not a directory");
    error.code = "QUALITY_NPM_CACHE_INVALID";
    throw error;
  }
  return resolved;
}

function disposableJudgeEnvironment({
  codexHome,
  npmUserConfigPath,
  temporaryRoot,
  sourceEnvironment = process.env,
  cachePath = dependencyCachePath(),
}) {
  const scratchRoot = path.join(temporaryRoot, "scratch");
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const npmLogsRoot = path.join(scratchRoot, "npm-logs");
  fs.mkdirSync(npmLogsRoot, { recursive: true, mode: 0o700 });
  return scrubQualityEnvironment(sourceEnvironment, {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    TMPDIR: scratchRoot,
    npm_config_audit: "false",
    npm_config_cache: cachePath,
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_include: "dev optional peer",
    npm_config_logs_dir: npmLogsRoot,
    npm_config_offline: "true",
    npm_config_omit: "",
    npm_config_update_notifier: "false",
    npm_config_userconfig: npmUserConfigPath,
    npm_config_workspaces: "false",
  });
}

const DEFAULT_DEPENDENCY_OPERATIONS = Object.freeze({
  runLayer,
  verifyDependencyAudit,
  qualityToolchainEvidence,
});

function installAndAuditDependencies({
  worktree,
  environment,
  operations = {},
}) {
  const runtime = { ...DEFAULT_DEPENDENCY_OPERATIONS, ...operations };
  const run = runtime.runLayer;
  const audit = runtime.verifyDependencyAudit;
  const toolchain = runtime.qualityToolchainEvidence;
  const packageJsonBefore = sha256(
    fs.readFileSync(path.join(worktree, "package.json")),
  );
  const packageLockBefore = sha256(
    fs.readFileSync(path.join(worktree, "package-lock.json")),
  );
  const installReceipt = run({
    name: "locked-offline-dependency-install",
    command: process.execPath,
    args: [NPM_CLI_PATH, ...LOCKED_INSTALL_ARGS],
    checkId: "locked-offline-dependency-install",
    definitionSha256: sha256(stableJson({
      command: process.execPath,
      npmCliPath: NPM_CLI_PATH,
      args: LOCKED_INSTALL_ARGS,
    })),
    displayCommand: `npm ${LOCKED_INSTALL_ARGS.join(" ")}`,
    cwd: worktree,
    env: environment,
    allowWorkspaceWrites: true,
  });
  const auditReceipt = run({
    name: "dependency-tree-audit",
    command: process.execPath,
    args: [NPM_CLI_PATH, ...DEPENDENCY_AUDIT_ARGS],
    checkId: "dependency-tree-audit",
    definitionSha256: sha256(stableJson({
      command: process.execPath,
      npmCliPath: NPM_CLI_PATH,
      args: DEPENDENCY_AUDIT_ARGS,
    })),
    displayCommand: `npm ${DEPENDENCY_AUDIT_ARGS.join(" ")}`,
    cwd: worktree,
    env: environment,
  });
  const dependencyManifest = audit({
    repoRoot: worktree,
    stdout: auditReceipt.stdout,
    status: auditReceipt.status,
    stderr: auditReceipt.stderr,
  });
  if (
    dependencyManifest.packageJsonSha256 !== packageJsonBefore ||
    dependencyManifest.packageLockSha256 !== packageLockBefore
  ) {
    const error = new Error("npm ci changed a candidate dependency input");
    error.code = "DEPENDENCY_INPUT_CHANGED";
    error.details = {
      packageJsonBefore,
      packageJsonAfter: dependencyManifest.packageJsonSha256,
      packageLockBefore,
      packageLockAfter: dependencyManifest.packageLockSha256,
    };
    throw error;
  }
  return {
    install: {
      isolation: installReceipt.isolation,
      semanticSha256: installReceipt.semanticSha256,
    },
    audit: {
      isolation: auditReceipt.isolation,
      semanticSha256: auditReceipt.semanticSha256,
    },
    manifest: dependencyManifest,
    toolchain: toolchain(),
  };
}

const DEFAULT_JUDGE_OPERATIONS = Object.freeze({
  workspaceEvidenceDigest,
  materializeAutomationInputs,
  disposableJudgeEnvironment,
  installAndAuditDependencies,
  executePlan,
  summarizeReceipts,
});

const DEFAULT_JUDGE_CLEANUP_OPERATIONS = Object.freeze({
  listWorktrees: (repoRoot) =>
    createSealedGit({
      repoRoot: path.resolve(repoRoot),
      timeoutMs: 30_000,
    }).worktrees(),
  removeWorktree: (repoRoot, worktree) =>
    removeDetachedWorktree(repoRoot, worktree),
  removeDirectory: (temporaryRoot) =>
    fs.rmSync(temporaryRoot, { recursive: true, force: true }),
});

function worktreeIsRegistered(listing, worktree) {
  if (Array.isArray(listing)) {
    return listing.some((entry) => entry?.path === worktree);
  }
  return String(listing)
    .split("\n")
    .some((line) => line === `worktree ${worktree}`);
}

function requireDetachedWorktreePath(worktree) {
  if (
    typeof worktree !== "string" ||
    worktree.length === 0 ||
    worktree.length > 4096 ||
    worktree.includes("\0") ||
    !path.isAbsolute(worktree) ||
    path.normalize(worktree) !== worktree
  ) {
    const error = new Error("Disposable judge worktree path is invalid");
    error.code = "DISPOSABLE_JUDGE_WORKTREE_PATH_INVALID";
    throw error;
  }
  return worktree;
}

function runTrustedWorktreeMutation(repoRoot, args) {
  const sealedGit = createSealedGit({
    repoRoot: path.resolve(repoRoot),
    timeoutMs: 30_000,
  });
  return execFileSync(
    TRUSTED_GIT,
    [...TRUSTED_GIT_MUTATION_PREFIX, ...args],
    {
      cwd: sealedGit.repoRoot,
      env: { ...SEALED_ENVIRONMENT },
      stdio: "pipe",
      timeout: GIT_CONTROL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
}

function addDetachedWorktree(repoRoot, worktree, candidateCommit) {
  requireDetachedWorktreePath(worktree);
  if (!/^[a-f0-9]{40}$/u.test(String(candidateCommit || ""))) {
    const error = new Error("Disposable judge candidate commit is invalid");
    error.code = "DISPOSABLE_JUDGE_COMMIT_INVALID";
    throw error;
  }
  runTrustedWorktreeMutation(repoRoot, [
    "worktree",
    "add",
    "--detach",
    worktree,
    candidateCommit,
  ]);
  const worktrees = createSealedGit({
    repoRoot: path.resolve(repoRoot),
  }).worktrees();
  if (!worktreeIsRegistered(worktrees, worktree)) {
    const error = new Error("Disposable judge worktree add lacked read-back");
    error.code = "DISPOSABLE_JUDGE_REGISTRATION_MISSING";
    throw error;
  }
}

function removeDetachedWorktree(repoRoot, worktree) {
  requireDetachedWorktreePath(worktree);
  runTrustedWorktreeMutation(repoRoot, [
    "worktree",
    "remove",
    "--force",
    worktree,
  ]);
  const worktrees = createSealedGit({
    repoRoot: path.resolve(repoRoot),
  }).worktrees();
  if (worktreeIsRegistered(worktrees, worktree)) {
    const error = new Error("Disposable judge worktree removal lacked read-back");
    error.code = "DISPOSABLE_JUDGE_REGISTRATION_LEAK";
    throw error;
  }
}

function cleanupDisposableJudge({
  label,
  repoRoot,
  worktree,
  temporaryRoot,
  executionError = null,
  operations = {},
}) {
  const runtime = {
    ...DEFAULT_JUDGE_CLEANUP_OPERATIONS,
    ...operations,
  };
  let cleanupError = null;
  let registered = false;
  try {
    registered = worktreeIsRegistered(
      runtime.listWorktrees(repoRoot),
      worktree,
    );
  } catch (error) {
    cleanupError = error;
  }
  if (registered) {
    try {
      runtime.removeWorktree(repoRoot, worktree);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    runtime.removeDirectory(temporaryRoot);
  } catch (error) {
    cleanupError ||= error;
  }
  try {
    if (
      worktreeIsRegistered(
        runtime.listWorktrees(repoRoot),
        worktree,
      )
    ) {
      const error = new Error(
        `${label} judge remains registered after cleanup`,
      );
      error.code = "DISPOSABLE_JUDGE_REGISTRATION_LEAK";
      cleanupError ||= error;
    }
  } catch (error) {
    cleanupError ||= error;
  }
  if (!cleanupError) return { cleaned: true };
  if (executionError) {
    executionError.cleanupError = cleanupError.message;
    return { cleaned: false, attached: true };
  }
  const error = new Error(`${label} judge cleanup failed`);
  error.code = "DISPOSABLE_JUDGE_CLEANUP_FAILED";
  error.cause = cleanupError;
  throw error;
}

function runDisposableJudge({
  label,
  candidateCommit,
  candidateTree,
  automationSnapshot,
  ledger,
  phase,
  effectiveProfile,
  requiredCoverageFiles,
  cleanJudge,
  repoRoot = ROOT,
  operations = {},
}) {
  const runtime = { ...DEFAULT_JUDGE_OPERATIONS, ...operations };
  const captureWorkspace = runtime.workspaceEvidenceDigest;
  const materialize = runtime.materializeAutomationInputs;
  const buildEnvironment = runtime.disposableJudgeEnvironment;
  const installDependencies = runtime.installAndAuditDependencies;
  const runPlan = runtime.executePlan;
  const summarize = runtime.summarizeReceipts;
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `pikiio-quality-${label}-`),
  );
  const canonicalTemporaryRoot = fs.realpathSync(temporaryRoot);
  const worktree = path.join(canonicalTemporaryRoot, "repo");
  const codexHome = path.join(canonicalTemporaryRoot, "codex-home");
  let executionError = null;
  try {
    addDetachedWorktree(repoRoot, worktree, candidateCommit);
    const worktreeGit = createSealedGit({
      repoRoot: worktree,
      maxStdoutBytes: 32 * 1024 * 1024,
    });
    const worktreeHead = worktreeGit.head();
    const worktreeTree = worktreeGit.tree({ commit: worktreeHead });
    const initialWorkspaceDigest = captureWorkspace(worktree);
    if (
      worktreeHead !== candidateCommit ||
      worktreeTree !== candidateTree ||
      worktreeGit.status().length !== 0
    ) {
      const error = new Error(
        `${label} judge did not start at the immutable clean candidate`,
      );
      error.code = "DISPOSABLE_JUDGE_CANDIDATE_MISMATCH";
      error.details = {
        candidateCommit,
        candidateTree,
        worktreeHead,
        worktreeTree,
      };
      throw error;
    }
    const syntheticCodex = materialize(
      automationSnapshot,
      codexHome,
    );
    const environment = buildEnvironment({
      ...syntheticCodex,
      temporaryRoot: canonicalTemporaryRoot,
    });
    const dependencies = installDependencies({
      worktree,
      environment,
    });
    const receipts = runPlan({
      root: worktree,
      ledger,
      phase,
      baseEnvironment: environment,
      effectiveProfile,
      requiredCoverageFiles,
    });
    const summary = summarize(
      receipts,
      ledger,
      phase,
      cleanJudge,
      {
        effectiveProfile,
        requiredCoverageFiles,
      },
    );
    summary.layerDigests = receipts.map((receipt) => ({
      name: receipt.name,
      semanticSha256: receipt.semanticSha256,
    }));
    const finalWorkspaceDigest = captureWorkspace(worktree);
    if (finalWorkspaceDigest !== initialWorkspaceDigest) {
      const error = new Error(
        `${label} judge changed Git-visible candidate content`,
      );
      error.code = "DISPOSABLE_JUDGE_WORKTREE_CHANGED";
      error.details = {
        initialWorkspaceDigest,
        finalWorkspaceDigest,
        status: createSealedGit({ repoRoot: worktree })
          .status()
          .toString("utf8"),
      };
      throw error;
    }
    return {
      label,
      candidateCommit,
      candidateTree,
      automationSnapshotSha256: syntheticCodex.digest,
      dependencies,
      receipts,
      summary,
      worktreeHead,
      worktreeTree,
      workspaceUnchanged: true,
    };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    cleanupDisposableJudge({
      label,
      repoRoot,
      worktree,
      temporaryRoot,
      executionError,
      operations: operations.cleanup,
    });
  }
}

function judgeSemantic(judge) {
  return {
    candidateCommit: judge.candidateCommit,
    candidateTree: judge.candidateTree,
    automationSnapshotSha256: judge.automationSnapshotSha256,
    dependencyManifestSha256: judge.dependencies.manifest.manifestSha256,
    toolchainSha256: judge.dependencies.toolchain.toolchainSha256,
    metrics: {
      ...judge.summary.metrics,
      cleanCheckoutReproduced: true,
    },
    populations: judge.summary.populations,
    layerDigests: judge.summary.layerDigests,
  };
}

function persistJudgeArtifacts(judge, {
  artifactDirectory = path.join(
    path.dirname(DEFAULT_QUALITY_RECEIPT_PATH),
    "quality-judge-artifacts",
  ),
} = {}) {
  const bundle = {
    schema: "pikiio-quality-judge-raw-artifact-v1",
    label: judge.label,
    candidateCommit: judge.candidateCommit,
    candidateTree: judge.candidateTree,
    automationSnapshotSha256: judge.automationSnapshotSha256,
    dependencyManifestSha256:
      judge.dependencies.manifest.manifestSha256,
    toolchainSha256: judge.dependencies.toolchain.toolchainSha256,
    layers: judge.receipts.map((receipt) => ({
      name: receipt.name,
      checkId: receipt.checkId,
      definitionSha256: receipt.definitionSha256,
      command: receipt.command,
      isolation: receipt.isolation,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      status: receipt.status,
      signal: receipt.signal,
      timedOut: receipt.timedOut,
      stdout: receipt.stdout,
      stderr: receipt.stderr,
      normalizationRoots: receipt.normalizationRoots,
      parsed: receipt.parsed,
      semanticSha256: receipt.semanticSha256,
    })),
  };
  const bytes = Buffer.from(`${stableJson(bundle)}\n`);
  const artifactSha256 = sha256(bytes);
  const artifactPath = path.join(
    artifactDirectory,
    `${artifactSha256}.json`,
  );
  fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(artifactPath)) {
    if (sha256(fs.readFileSync(artifactPath)) !== artifactSha256) {
      const error = new Error(
        "Existing quality judge artifact does not match its address",
      );
      error.code = "QUALITY_RAW_ARTIFACT_COLLISION";
      throw error;
    }
  } else {
    const temporaryPath = path.join(
      artifactDirectory,
      `.${artifactSha256}.${process.pid}.tmp`,
    );
    try {
      fs.writeFileSync(temporaryPath, bytes, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, artifactPath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
  const readBack = fs.readFileSync(artifactPath);
  if (
    sha256(readBack) !== artifactSha256 ||
    stableJson(JSON.parse(readBack.toString("utf8"))) !== stableJson(bundle)
  ) {
    const error = new Error("Quality judge artifact failed read-back");
    error.code = "QUALITY_RAW_ARTIFACT_READBACK_FAILED";
    throw error;
  }
  const receipt = {
    schema: bundle.schema,
    artifactPath,
    artifactSha256,
    byteLength: readBack.length,
    layerCount: bundle.layers.length,
  };
  judge.rawArtifact = receipt;
  return receipt;
}

function assertIndependentJudge(primaryJudge, independentJudge) {
  const primarySemantic = judgeSemantic(primaryJudge);
  const independentSemantic = judgeSemantic(independentJudge);
  if (
    sha256(stableJson(primarySemantic)) !==
    sha256(stableJson(independentSemantic))
  ) {
    const error = new Error(
      "Independent disposable judge did not reproduce primary evidence",
    );
    error.code = "CLEAN_CHECKOUT_REPRODUCTION_MISMATCH";
    error.details = { primarySemantic, independentSemantic };
    throw error;
  }
  return {
    reproduced: true,
    worktreeHead: independentJudge.worktreeHead,
    worktreeTree: independentJudge.worktreeTree,
    automationSnapshotSha256:
      independentJudge.automationSnapshotSha256,
    dependencyManifest:
      independentJudge.dependencies.manifest,
    rawArtifact: independentJudge.rawArtifact,
    workspaceUnchanged: independentJudge.workspaceUnchanged,
    semanticSha256: sha256(stableJson(independentSemantic)),
  };
}

const DEFAULT_GAUNTLET_SERVICES = Object.freeze({
  captureOperationalCheckout,
  assertOperationalCheckoutUnchanged,
  loadPhaseLedger,
  selectActivePhase,
  evaluateGoalGuard,
  antiWeakeningAudit,
  captureAutomationInputs,
  runDisposableJudge,
  persistJudgeArtifacts,
  assertIndependentJudge,
  effectiveQualityProfile,
  expectedQualityLayerPlan,
  requiredCoverageFilesForPhase,
  writeQualityReceipt,
  validateQualityReceipt,
  readQualityReceipt: (targetPath) =>
    JSON.parse(fs.readFileSync(targetPath, "utf8")),
});

function runQualityGauntletInternal({
  development = false,
  repoRoot = ROOT,
  environment = process.env,
  receiptPath = DEFAULT_QUALITY_RECEIPT_PATH,
  now = () => new Date().toISOString(),
  services = {},
} = {}) {
  const runtime = { ...DEFAULT_GAUNTLET_SERVICES, ...services };
  const captureCheckout = runtime.captureOperationalCheckout;
  const assertCheckout = runtime.assertOperationalCheckoutUnchanged;
  const loadLedger = runtime.loadPhaseLedger;
  const selectPhase = runtime.selectActivePhase;
  const evaluateGoal = runtime.evaluateGoalGuard;
  const auditWeakening = runtime.antiWeakeningAudit;
  const captureAutomation = runtime.captureAutomationInputs;
  const runJudge = runtime.runDisposableJudge;
  const persistArtifacts = runtime.persistJudgeArtifacts;
  const compareJudges = runtime.assertIndependentJudge;
  const buildEffectiveProfile = runtime.effectiveQualityProfile;
  const expectedPlan = runtime.expectedQualityLayerPlan;
  const resolveRequiredCoverageFiles =
    runtime.requiredCoverageFilesForPhase;
  const writeReceipt = runtime.writeQualityReceipt;
  const validateReceipt = runtime.validateQualityReceipt;
  const readReceipt = runtime.readQualityReceipt;
  const operationalBefore = captureCheckout(repoRoot);
  let executionError = null;
  let operationalAfter = null;
  try {
  const ledger = loadLedger();
  const phase = selectPhase(ledger);
  const goal = evaluateGoal({
    ledger,
    repoRoot,
    goalObjective: environment.PIKIIO_CODEX_GOAL_OBJECTIVE || "",
    goalThreadId: environment.PIKIIO_CODEX_GOAL_THREAD_ID || "",
  });
  if (!goal.ok) {
    const error = new Error(goal.error);
    error.code = goal.code;
    error.details = goal.details;
    throw error;
  }
  const antiWeakening = auditWeakening(ledger, phase, { repoRoot });
  const workspaceDigest = operationalBefore.workspaceDigest;
  if (antiWeakening.worktreeChangedPaths.length !== 0) {
    const error = new Error(
      "Disposable quality judges require an immutable committed candidate",
    );
    error.code = "QUALITY_CANDIDATE_NOT_COMMITTED";
    error.details = {
      worktreeChangedPaths: antiWeakening.worktreeChangedPaths,
      sliceChangedPaths: antiWeakening.sliceChangedPaths,
      development,
    };
    throw error;
  }

  const candidateCommit = operationalBefore.head;
  const candidateTree = operationalBefore.tree;
  const effectiveProfile = buildEffectiveProfile(
    ledger.qualityPolicy.profiles[phase.qualityProfile],
    phase.id,
  );
  const requiredCoverageFiles = resolveRequiredCoverageFiles({
    phase,
    repoRoot,
    head: candidateCommit,
  });
  const exactLayerPlan = expectedPlan(phase, effectiveProfile, {
    repoRoot,
    head: candidateCommit,
    requiredCoverageFiles,
  });
  const sourceCodexHome =
    environment.CODEX_HOME || path.join(os.homedir(), ".codex");
  const automationSnapshot = captureAutomation(sourceCodexHome);
  const primaryJudge = runJudge({
    label: "primary",
    candidateCommit,
    candidateTree,
    automationSnapshot,
    ledger,
    phase,
    effectiveProfile,
    requiredCoverageFiles,
    cleanJudge: false,
    repoRoot,
  });
  persistArtifacts(primaryJudge);
  const primary = primaryJudge.summary;
  let cleanJudge = { reproduced: false, reason: "development mode" };
  if (!development) {
    const independentJudge = runJudge({
      label: "independent",
      candidateCommit,
      candidateTree,
      automationSnapshot,
      ledger,
      phase,
      effectiveProfile,
      requiredCoverageFiles,
      cleanJudge: true,
      repoRoot,
    });
    persistArtifacts(independentJudge);
    cleanJudge = compareJudges(primaryJudge, independentJudge);
    primary.metrics.cleanCheckoutReproduced = true;
  }
  operationalAfter = captureCheckout(repoRoot);
  assertCheckout(operationalBefore, operationalAfter);
  const report = {
    schema: "pikiio-quality-gauntlet-receipt-v5",
    recordedAt: now(),
    ledgerRevision: ledger.revision,
    ledgerSha256: sha256(stableJson(ledger)),
    goalObjectiveSha256: ledger.codexGoal.objectiveSha256,
    phaseId: phase.id,
    phaseProofRegistrySha256: CANONICAL_REGISTRY_SHA256,
    qualityProfile: phase.qualityProfile,
    qualityPlanSha256: sha256(stableJson(phase.qualityPlan)),
    commandPlanSha256: sha256(stableJson(exactLayerPlan)),
    scopeBaseCommit: phase.scopeBaseCommit,
    head: candidateCommit,
    candidateTree,
    workspaceDigest,
    operationalCheckout: {
      schema: "pikiio-operational-git-visible-evidence-v1",
      scope: "git-visible-worktree-and-index",
      beforeSha256: operationalBefore.receiptHash,
      afterSha256: operationalAfter.receiptHash,
      unchanged: true,
    },
    automationSnapshotSha256: automationSnapshot.digest,
    dependencyManifest: primaryJudge.dependencies.manifest,
    qualityToolchain: primaryJudge.dependencies.toolchain,
    primaryJudge: {
      worktreeHead: primaryJudge.worktreeHead,
      worktreeTree: primaryJudge.worktreeTree,
      workspaceUnchanged: primaryJudge.workspaceUnchanged,
      installIsolation: primaryJudge.dependencies.install.isolation,
      auditIsolation: primaryJudge.dependencies.audit.isolation,
      rawArtifact: primaryJudge.rawArtifact,
    },
    thresholds: effectiveProfile,
    requiredCoverageFiles,
    metrics: primary.metrics,
    populations: primary.populations,
    antiWeakening,
    cleanJudge,
    layers: primaryJudge.receipts.map((receipt) => ({
      name: receipt.name,
      checkId: receipt.checkId,
      command: receipt.command,
      definitionSha256: receipt.definitionSha256,
      isolation: receipt.isolation,
      status: receipt.status,
      signal: receipt.signal,
      timedOut: receipt.timedOut,
      semanticSha256: receipt.semanticSha256,
    })),
  };
  let receipt;
  if (development) {
    receipt = {
      ...report,
      receiptHash: sha256(stableJson(report)),
      developmentOnly: true,
    };
  } else {
    receipt = writeReceipt(report, {
      receiptPath,
    });
    const readBack = readReceipt(receiptPath);
    if (stableJson(readBack) !== stableJson(receipt)) {
      const error = new Error("Strict quality receipt failed read-back");
      error.code = "QUALITY_RECEIPT_READBACK_MISMATCH";
      throw error;
    }
    const validation = validateReceipt(readBack, {
      ledger,
      phase,
      head: candidateCommit,
      workspaceDigest,
      repoRoot,
    });
    if (!validation.valid) {
      const error = new Error(
        "Strict quality receipt failed canonical validation after write",
      );
      error.code = "QUALITY_RECEIPT_POSTWRITE_INVALID";
      error.details = { validation };
      throw error;
    }
  }
  const postWriteOperational = captureCheckout(repoRoot);
  assertCheckout(
    operationalBefore,
    postWriteOperational,
  );
  return {
    ok: true,
    developmentOnly: development,
    receipt,
  };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    try {
      operationalAfter = captureCheckout(repoRoot);
      assertCheckout(
        operationalBefore,
        operationalAfter,
      );
    } catch (integrityError) {
      if (executionError) {
        executionError.operationalIntegrityError = {
          code: integrityError.code || "OPERATIONAL_CHECKOUT_CHANGED",
          message: integrityError.message,
          details: integrityError.details || {},
        };
      } else {
        throw integrityError;
      }
    }
  }
}

const GAUNTLET_OPTION_KEYS = Object.freeze([
  "development",
  "environment",
  "now",
  "receiptPath",
  "repoRoot",
]);

function exactOptionKeys(options, allowedKeys, label) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    const error = new Error(`${label} requires one plain options object`);
    error.code = "QUALITY_GAUNTLET_OPTIONS_INVALID";
    throw error;
  }
  const unexpected = Object.keys(options)
    .filter((key) => !allowedKeys.includes(key))
    .sort();
  if (unexpected.length > 0) {
    const error = new Error(`${label} received unsupported options`);
    error.code = Object.hasOwn(options, "services")
      ? "QUALITY_SERVICE_OVERRIDE_FORBIDDEN"
      : "QUALITY_GAUNTLET_OPTIONS_INVALID";
    error.details = { unexpected };
    throw error;
  }
}

function runQualityGauntlet(options = {}) {
  exactOptionKeys(options, GAUNTLET_OPTION_KEYS, "Quality gauntlet");
  return runQualityGauntletInternal(options);
}

function assertTestHarnessRepository(repoRoot) {
  if (process.env.NODE_ENV !== "test") {
    const error = new Error(
      "Quality service substitution is available only in explicit test mode",
    );
    error.code = "QUALITY_TEST_HARNESS_DISABLED";
    throw error;
  }
  let canonicalRoot;
  let canonicalTemp;
  try {
    canonicalRoot = fs.realpathSync.native(repoRoot);
    canonicalTemp = fs.realpathSync.native(os.tmpdir());
  } catch {
    const error = new Error(
      "Quality test harness requires an existing canonical repository",
    );
    error.code = "QUALITY_TEST_REPOSITORY_INVALID";
    throw error;
  }
  if (
    canonicalRoot !== repoRoot ||
    canonicalRoot === ROOT ||
    !canonicalRoot.startsWith(
      `${canonicalTemp}${path.sep}pikiio-quality-runner-repo-`,
    )
  ) {
    const error = new Error(
      "Quality test harness requires a canonical disposable alternate repository",
    );
    error.code = "QUALITY_TEST_REPOSITORY_INVALID";
    throw error;
  }
  const operational = createSealedGit({ repoRoot: ROOT });
  const alternate = createSealedGit({ repoRoot: canonicalRoot });
  if (
    alternate.repositoryIdentitySha256 ===
    operational.repositoryIdentitySha256
  ) {
    const error = new Error(
      "Quality test harness cannot target the operational repository identity",
    );
    error.code = "QUALITY_TEST_REPOSITORY_INVALID";
    throw error;
  }
  return canonicalRoot;
}

function runQualityGauntletForTest(options = {}) {
  exactOptionKeys(
    options,
    [...GAUNTLET_OPTION_KEYS, "services"],
    "Quality gauntlet test harness",
  );
  if (!Object.hasOwn(options, "services")) {
    const error = new Error(
      "Quality gauntlet test harness requires explicit substituted services",
    );
    error.code = "QUALITY_TEST_SERVICES_REQUIRED";
    throw error;
  }
  const repoRoot = assertTestHarnessRepository(options.repoRoot);
  return runQualityGauntletInternal({
    ...options,
    repoRoot,
  });
}

function main({
  development = hasFlag("--development"),
  log = console.log,
  execute = runQualityGauntlet,
} = {}) {
  const result = execute({ development });
  log(JSON.stringify(result, null, 2));
  return result;
}

function qualityFailurePayload(error) {
  return {
    ok: false,
    code: error.code || "QUALITY_GAUNTLET_FAILED",
    error: error instanceof Error ? error.message : String(error),
    details: error.details || {},
    receipt: error.receipt || null,
    operationalIntegrityError: error.operationalIntegrityError || null,
    cleanupError: error.cleanupError || null,
  };
}

function bootstrapQualityGauntlet({
  isMain,
  argv = process.argv,
  execute = main,
  logError = console.error,
  setExitCode = (code) => {
    process.exit(code);
  },
} = {}) {
  if (!isMain) return { executed: false };
  try {
    execute({ development: hasFlag("--development", argv) });
    return { executed: true, ok: true };
  } catch (error) {
    const payload = qualityFailurePayload(error);
    logError(JSON.stringify(payload, null, 2));
    setExitCode(1);
    return { executed: true, ok: false, payload };
  }
}

module.exports = {
  aggregateUnitShardReceipts,
  antiWeakeningAudit,
  addCounts,
  assertOperationalGitConfigSafe,
  assertIndependentJudge,
  bootstrapQualityGauntlet,
  cleanupDisposableJudge,
  countTestSurface,
  dependencyCachePath,
  disposableJudgeEnvironment,
  executeCheck,
  executePlan,
  hasFlag,
  installAndAuditDependencies,
  isolatedCommand,
  judgeSemantic,
  main,
  normalizedOutput,
  persistJudgeArtifacts,
  parseLastJsonObject,
  parseTap,
  qualityCheckInvocation,
  qualityFailurePayload,
  requirePerFileCoverage,
  qualityToolchainEvidence,
  repeatConsistency,
  runDisposableJudge,
  runQualityGauntlet,
  runQualityGauntletForTest,
  runLayer,
  sourceAtCommit,
  scrubQualityEnvironment,
  semanticReceipt,
  summarizeReceipts,
  unitArgs,
  warningFindings,
  worktreeIsRegistered,
};

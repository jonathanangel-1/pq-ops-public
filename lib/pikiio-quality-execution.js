"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  sha256,
  stableJson,
  workspaceEvidenceDigest,
} = require("./pikiio-agent-governance");

const REQUIRED_AUTOMATION_IDS = Object.freeze([
  "pikiio-governed-builder-heartbeat",
  "pq-gmail-job-processor",
  "pq-morning-shipment-refresh",
]);
const OPTIONAL_AUTOMATION_IDS = Object.freeze([
  "pq-end-of-day-operations-report",
]);
const REQUIRED_AUXILIARY_RELATIVE_PATHS = Object.freeze([
  path.join(
    "automations",
    "pikiio-governed-builder-heartbeat",
    "memory.md",
  ),
]);
const OPTIONAL_RUNTIME_RELATIVE_PATHS = Object.freeze([
  path.join(
    "runtime",
    "pikiio-agent",
    "heartbeat-activation-receipt.json",
  ),
  path.join("runtime", "pikiio-agent", "quality-receipt.json"),
]);
const LOCKED_INSTALL_ARGS = Object.freeze([
  "ci",
  "--ignore-scripts",
  "--offline",
  "--no-audit",
  "--no-fund",
  "--include=dev",
  "--include=optional",
  "--include=peer",
  "--workspaces=false",
]);
const DEPENDENCY_AUDIT_ARGS = Object.freeze([
  "ls",
  "--all",
  "--json",
  "--long",
]);

function commandOutput(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    ...options,
  }).trim();
}

function assertRegularFile(filePath, code) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (cause) {
    const error = new Error(`Required file is missing: ${filePath}`);
    error.code = code;
    error.cause = cause;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error(`Required input is not a regular file: ${filePath}`);
    error.code = code;
    throw error;
  }
  return stat;
}

function readContainedRegularFile(
  sourceRoot,
  relativePath,
  {
    missingCode,
    invalidCode,
    maximumBytes,
    tooLargeCode,
  },
) {
  const normalized = path.normalize(relativePath);
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized !== relativePath
  ) {
    const error = new Error(`Unsafe snapshot input path: ${relativePath}`);
    error.code = "AUTOMATION_SNAPSHOT_PATH_INVALID";
    throw error;
  }
  let cursor = sourceRoot;
  for (const segment of normalized.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (cause) {
      const error = new Error(`Required file is missing: ${cursor}`);
      error.code = missingCode;
      error.cause = cause;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const error = new Error(`Snapshot input traverses a symlink: ${cursor}`);
      error.code = invalidCode;
      throw error;
    }
  }
  const realPath = fs.realpathSync(cursor);
  if (
    realPath !== sourceRoot &&
    !realPath.startsWith(`${sourceRoot}${path.sep}`)
  ) {
    const error = new Error(`Snapshot input escaped its source root: ${relativePath}`);
    error.code = invalidCode;
    throw error;
  }
  const descriptor = fs.openSync(
    realPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      const error = new Error(`Snapshot input is not a regular file: ${relativePath}`);
      error.code = invalidCode;
      throw error;
    }
    if (before.size > maximumBytes) {
      const error = new Error(`Snapshot input is unexpectedly large: ${relativePath}`);
      error.code = tooLargeCode;
      throw error;
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length !== after.size
    ) {
      const error = new Error(`Snapshot input changed while being read: ${relativePath}`);
      error.code = "AUTOMATION_SNAPSHOT_INPUT_CHANGED";
      throw error;
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function snapshotDigestInput(snapshot) {
  const publicEntries = snapshot.entries
    .map(({ content, ...entry }) => entry)
    .sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  return {
    entries: publicEntries,
    requiredIds: [...snapshot.requiredIds].sort(),
    optionalIds: [...snapshot.optionalIds].sort(),
    requiredAuxiliaryPaths: [...snapshot.requiredAuxiliaryPaths].sort(),
    optionalRuntimePaths: [...snapshot.optionalRuntimePaths].sort(),
  };
}

function computeAutomationSnapshotDigest(snapshot) {
  return sha256(stableJson(snapshotDigestInput(snapshot)));
}

function gitVisibleManifest(repoRoot) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot },
  ).toString("utf8");
  const paths = output.split("\0").filter(Boolean).sort();
  return paths.map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      return {
        path: relativePath,
        type: "symlink",
        targetSha256: sha256(fs.readlinkSync(absolutePath)),
      };
    }
    if (!stat.isFile()) {
      return {
        path: relativePath,
        type: "non-file",
      };
    }
    return {
      path: relativePath,
      type: "file",
      size: stat.size,
      contentSha256: sha256(fs.readFileSync(absolutePath)),
    };
  });
}

function captureOperationalCheckout(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const evidence = {
    root,
    head: commandOutput("git", ["rev-parse", "HEAD"], root),
    tree: commandOutput("git", ["rev-parse", "HEAD^{tree}"], root),
    workspaceDigest: workspaceEvidenceDigest(root),
    gitVisibleManifest: gitVisibleManifest(root),
  };
  return {
    ...evidence,
    receiptHash: sha256(stableJson(evidence)),
  };
}

function assertOperationalCheckoutUnchanged(before, after) {
  if (
    !before ||
    !after ||
    before.receiptHash !== after.receiptHash ||
    sha256(stableJson(before)) !== sha256(stableJson(after))
  ) {
    const error = new Error(
      "The operational checkout changed while disposable judges were running",
    );
    error.code = "OPERATIONAL_CHECKOUT_CHANGED";
    error.details = {
      before: before || null,
      after: after || null,
    };
    throw error;
  }
  return true;
}

function captureAutomationInputs(
  sourceCodexHome,
  {
    requiredIds = REQUIRED_AUTOMATION_IDS,
    optionalIds = OPTIONAL_AUTOMATION_IDS,
    requiredAuxiliaryPaths = REQUIRED_AUXILIARY_RELATIVE_PATHS,
    optionalRuntimePaths = OPTIONAL_RUNTIME_RELATIVE_PATHS,
  } = {},
) {
  const sourceRoot = fs.realpathSync(sourceCodexHome);
  const entries = [];
  for (const [required, ids] of [
    [true, requiredIds],
    [false, optionalIds],
  ]) {
    for (const id of ids) {
      if (!/^[a-z0-9-]+$/.test(id)) {
        const error = new Error(`Unsafe automation id: ${id}`);
        error.code = "AUTOMATION_SNAPSHOT_ID_INVALID";
        throw error;
      }
      const relativePath = path.join("automations", id, "automation.toml");
      const absolutePath = path.join(sourceRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        if (required) {
          const error = new Error(`Required automation input is missing: ${id}`);
          error.code = "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING";
          throw error;
        }
        continue;
      }
      const content = readContainedRegularFile(sourceRoot, relativePath, {
        missingCode: required
          ? "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING"
          : "AUTOMATION_SNAPSHOT_INPUT_INVALID",
        invalidCode: "AUTOMATION_SNAPSHOT_INPUT_INVALID",
        maximumBytes: 2 * 1024 * 1024,
        tooLargeCode: "AUTOMATION_SNAPSHOT_INPUT_TOO_LARGE",
      });
      entries.push({
        id,
        relativePath,
        content,
        size: content.length,
        contentSha256: sha256(content),
      });
    }
  }
  for (const relativePath of requiredAuxiliaryPaths) {
    const normalized = path.normalize(relativePath);
    const content = readContainedRegularFile(sourceRoot, relativePath, {
      missingCode: "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING",
      invalidCode: "AUTOMATION_SNAPSHOT_INPUT_INVALID",
      maximumBytes: 2 * 1024 * 1024,
      tooLargeCode: "AUTOMATION_SNAPSHOT_INPUT_TOO_LARGE",
    });
    entries.push({
      id: `auxiliary:${normalized.split(path.sep).join("/")}`,
      relativePath: normalized,
      content,
      size: content.length,
      contentSha256: sha256(content),
    });
  }
  for (const relativePath of optionalRuntimePaths) {
    const normalized = path.normalize(relativePath);
    if (
      path.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`) ||
      normalized !== relativePath
    ) {
      const error = new Error(`Unsafe snapshot input path: ${relativePath}`);
      error.code = "AUTOMATION_SNAPSHOT_PATH_INVALID";
      throw error;
    }
    const absolutePath = path.join(sourceRoot, normalized);
    if (!fs.existsSync(absolutePath)) continue;
    const content = readContainedRegularFile(sourceRoot, relativePath, {
      missingCode: "AUTOMATION_SNAPSHOT_INPUT_INVALID",
      invalidCode: "AUTOMATION_SNAPSHOT_INPUT_INVALID",
      maximumBytes: 5 * 1024 * 1024,
      tooLargeCode: "AUTOMATION_SNAPSHOT_INPUT_TOO_LARGE",
    });
    entries.push({
      id: `runtime:${normalized.split(path.sep).join("/")}`,
      relativePath: normalized,
      content,
      size: content.length,
      contentSha256: sha256(content),
    });
  }
  entries.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const snapshot = {
    entries,
    requiredIds: [...requiredIds].sort(),
    optionalIds: [...optionalIds].sort(),
    requiredAuxiliaryPaths: [...requiredAuxiliaryPaths].sort(),
    optionalRuntimePaths: [...optionalRuntimePaths].sort(),
  };
  snapshot.digest = computeAutomationSnapshotDigest(snapshot);
  return snapshot;
}

function materializeAutomationInputs(snapshot, targetCodexHome) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.entries) ||
    !/^[a-f0-9]{64}$/.test(snapshot.digest || "")
  ) {
    const error = new Error("Automation snapshot is invalid");
    error.code = "AUTOMATION_SNAPSHOT_INVALID";
    throw error;
  }
  for (const key of [
    "requiredIds",
    "optionalIds",
    "requiredAuxiliaryPaths",
    "optionalRuntimePaths",
  ]) {
    if (!Array.isArray(snapshot[key])) {
      const error = new Error(`Automation snapshot ${key} is invalid`);
      error.code = "AUTOMATION_SNAPSHOT_INVALID";
      throw error;
    }
  }
  const seenPaths = new Set();
  const requiredPaths = new Set([
    ...snapshot.requiredIds.map((id) =>
      path.join("automations", id, "automation.toml"),
    ),
    ...snapshot.requiredAuxiliaryPaths,
  ]);
  const allowedPaths = new Set([
    ...requiredPaths,
    ...snapshot.optionalIds.map((id) =>
      path.join("automations", id, "automation.toml"),
    ),
    ...snapshot.optionalRuntimePaths,
  ]);
  for (const entry of snapshot.entries) {
    const normalized = path.normalize(entry.relativePath);
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      path.isAbsolute(normalized) ||
      normalized !== entry.relativePath ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`) ||
      seenPaths.has(normalized) ||
      !allowedPaths.has(normalized) ||
      entry.size !== entry.content?.length
    ) {
      const error = new Error("Automation snapshot manifest is invalid");
      error.code = "AUTOMATION_SNAPSHOT_INVALID";
      throw error;
    }
    seenPaths.add(normalized);
  }
  if ([...requiredPaths].some((relativePath) => !seenPaths.has(relativePath))) {
    const error = new Error("Automation snapshot omits a required input");
    error.code = "AUTOMATION_SNAPSHOT_REQUIRED_INPUT_MISSING";
    throw error;
  }
  if (computeAutomationSnapshotDigest(snapshot) !== snapshot.digest) {
    const error = new Error("Automation snapshot digest does not match its manifest");
    error.code = "AUTOMATION_SNAPSHOT_DIGEST_MISMATCH";
    throw error;
  }
  const targetRoot = path.resolve(targetCodexHome);
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of snapshot.entries) {
    if (
      !Buffer.isBuffer(entry.content) ||
      sha256(entry.content) !== entry.contentSha256
    ) {
      const error = new Error(
        `Automation snapshot content changed: ${entry.relativePath}`,
      );
      error.code = "AUTOMATION_SNAPSHOT_CONTENT_CHANGED";
      throw error;
    }
    const targetPath = path.join(targetRoot, entry.relativePath);
    const resolvedParent = path.resolve(path.dirname(targetPath));
    fs.mkdirSync(resolvedParent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(targetPath, entry.content, {
      flag: "wx",
      mode: 0o400,
    });
  }
  const npmRcPath = path.join(targetRoot, ".npmrc");
  fs.writeFileSync(npmRcPath, "audit=false\nfund=false\nignore-scripts=true\noffline=true\n", {
    flag: "wx",
    mode: 0o400,
  });
  return {
    codexHome: targetRoot,
    digest: snapshot.digest,
    files: snapshot.entries.map(({ content, ...entry }) => entry),
    npmUserConfigPath: npmRcPath,
  };
}

function collectDependencyDefects(node, logicalPath = "root", defects = []) {
  if (!node || typeof node !== "object") return defects;
  for (const marker of ["extraneous", "invalid", "missing"]) {
    if (node[marker] === true) {
      defects.push({ path: logicalPath, marker });
    }
  }
  for (const [name, dependency] of Object.entries(node.dependencies || {})) {
    collectDependencyDefects(
      dependency,
      `${logicalPath}>${name}`,
      defects,
    );
  }
  return defects;
}

function dependencyEntryManifest(tree) {
  return Object.entries(tree.dependencies || {})
    .map(([name, value]) => ({
      name,
      version: value?.version || null,
      resolved: value?.resolved || null,
      overridden: value?.overridden === true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parseDependencyJson(filePath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    const error = new Error(`Dependency evidence JSON is invalid: ${filePath}`);
    error.code = "DEPENDENCY_LOCK_EVIDENCE_INVALID";
    error.cause = cause;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`Dependency evidence is not an object: ${filePath}`);
    error.code = "DEPENDENCY_LOCK_EVIDENCE_INVALID";
    throw error;
  }
  return value;
}

function declaredDependencyNames(packageJson) {
  const names = new Set();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const declarations = packageJson[field] || {};
    if (
      !declarations ||
      typeof declarations !== "object" ||
      Array.isArray(declarations)
    ) {
      const error = new Error(`package.json ${field} is invalid`);
      error.code = "DEPENDENCY_LOCK_EVIDENCE_INVALID";
      throw error;
    }
    for (const name of Object.keys(declarations)) names.add(name);
  }
  return [...names].sort();
}

function verifyDependencyAudit({
  repoRoot,
  stdout,
  status = 0,
  stderr = "",
}) {
  if (status !== 0) {
    const error = new Error("npm dependency audit returned a non-zero status");
    error.code = "DEPENDENCY_AUDIT_COMMAND_FAILED";
    error.details = { status, stderr: String(stderr).slice(-4000) };
    throw error;
  }
  let tree;
  try {
    tree = JSON.parse(String(stdout));
  } catch (cause) {
    const error = new Error("npm dependency audit did not return JSON");
    error.code = "DEPENDENCY_AUDIT_JSON_INVALID";
    error.cause = cause;
    throw error;
  }
  const problems = Array.isArray(tree.problems) ? tree.problems : [];
  const defects = collectDependencyDefects(tree);
  if (problems.length || defects.length) {
    const error = new Error(
      "Lockfile installation contains dependency problems or extraneous packages",
    );
    error.code = "DEPENDENCY_AUDIT_FAILED";
    error.details = { problems, defects };
    throw error;
  }
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageLockPath = path.join(repoRoot, "package-lock.json");
  const installedLockPath = path.join(
    repoRoot,
    "node_modules",
    ".package-lock.json",
  );
  for (const filePath of [
    packageJsonPath,
    packageLockPath,
    installedLockPath,
  ]) {
    assertRegularFile(filePath, "DEPENDENCY_LOCK_EVIDENCE_MISSING");
  }
  const packageJson = parseDependencyJson(packageJsonPath);
  const packageLock = parseDependencyJson(packageLockPath);
  const installedLock = parseDependencyJson(installedLockPath);
  if (
    packageLock.lockfileVersion !== 3 ||
    installedLock.lockfileVersion !== 3 ||
    !packageLock.packages ||
    typeof packageLock.packages !== "object" ||
    Array.isArray(packageLock.packages) ||
    !installedLock.packages ||
    typeof installedLock.packages !== "object" ||
    Array.isArray(installedLock.packages) ||
    !packageLock.packages[""]
  ) {
    const error = new Error("Dependency lock evidence schema is invalid");
    error.code = "DEPENDENCY_LOCK_EVIDENCE_INVALID";
    throw error;
  }
  const expectedDependencyNames = declaredDependencyNames(packageJson);
  const auditedDependencyNames = Object.keys(tree.dependencies || {}).sort();
  const installedDependencyNames = expectedDependencyNames.filter(
    (name) => installedLock.packages[`node_modules/${name}`],
  );
  const lockedRoot = packageLock.packages[""];
  const lockedDependencyNames = declaredDependencyNames(lockedRoot);
  if (
    stableJson(auditedDependencyNames) !==
      stableJson(expectedDependencyNames) ||
    stableJson(installedDependencyNames) !==
      stableJson(expectedDependencyNames) ||
    stableJson(lockedDependencyNames) !==
      stableJson(expectedDependencyNames)
  ) {
    const error = new Error(
      "Dependency audit does not match package and lock declarations",
    );
    error.code = "DEPENDENCY_AUDIT_ROOT_MISMATCH";
    error.details = {
      expectedDependencyNames,
      auditedDependencyNames,
      installedDependencyNames,
      lockedDependencyNames,
    };
    throw error;
  }
  const manifest = {
    packageJsonSha256: sha256(fs.readFileSync(packageJsonPath)),
    packageLockSha256: sha256(fs.readFileSync(packageLockPath)),
    installedLockSha256: sha256(fs.readFileSync(installedLockPath)),
    name: tree.name || null,
    version: tree.version || null,
    dependencies: dependencyEntryManifest(tree),
    expectedDependencyNames,
    problemCount: 0,
    defectCount: 0,
  };
  return {
    ...manifest,
    manifestSha256: sha256(stableJson(manifest)),
  };
}

module.exports = {
  DEPENDENCY_AUDIT_ARGS,
  LOCKED_INSTALL_ARGS,
  OPTIONAL_AUTOMATION_IDS,
  OPTIONAL_RUNTIME_RELATIVE_PATHS,
  REQUIRED_AUXILIARY_RELATIVE_PATHS,
  REQUIRED_AUTOMATION_IDS,
  assertOperationalCheckoutUnchanged,
  captureAutomationInputs,
  captureOperationalCheckout,
  collectDependencyDefects,
  computeAutomationSnapshotDigest,
  materializeAutomationInputs,
  verifyDependencyAudit,
};

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { types: utilTypes } = require("node:util");

const TRUSTED_GIT_CANDIDATES = Object.freeze(["/usr/bin/git"]);
const TRUSTED_BROKER_CANDIDATES = Object.freeze(["/usr/bin/perl"]);
const TRUSTED_COPY_CANDIDATES = Object.freeze(["/bin/cp"]);
const NEUTRAL_CHILD_DIRECTORY = "/var/empty";
const AUTHORITY_DESCRIPTOR = 3;
const AUTHORITY_BROKER_SOURCE = [
  "use strict;",
  "use warnings;",
  'open(my $authority, "<&=3") or die "authority-open:$!";',
  'chdir($authority) or die "authority-chdir:$!";',
  'close($authority) or die "authority-close:$!";',
  'exec {$ARGV[0]} @ARGV or die "git-exec:$!";',
].join(" ");
const AUTHORITY_BROKER_SHA256 =
  "945c16adf7985f98117dd5cdfec65ff3ff39dd45a1374333c14b8612e14b7520";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAXIMUM_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REMOTE_REF_PREFIX = "refs/heads/";
const MAXIMUM_METADATA_BYTES = 1024 * 1024;
const MAXIMUM_OBJECT_AUTHORITY_ENTRIES = 20_000;
const MAXIMUM_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const FORBIDDEN_OBJECT_ENVIRONMENT = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_OBJECT_DIRECTORY",
]);

const SEALED_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1", // SEALED_GIT_CRITICAL_ANCHOR_NO_LAZY_FETCH
  GIT_NO_REPLACE_OBJECTS: "1", // SEALED_GIT_CRITICAL_ANCHOR_NO_REPLACE
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const FIXED_GIT_PREFIX = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
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
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
]);

class SealedGitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SealedGitError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SealedGitError(code, message, details);
}

function snapshotDataObject(value, label, invalidCode) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) || // SEALED_GIT_CRITICAL_ANCHOR_INPUT_PROXY
    Object.getPrototypeOf(value) !== Object.prototype // SEALED_GIT_CRITICAL_ANCHOR_INPUT_PROTOTYPE
  ) {
    fail(
      invalidCode,
      `${label} requires one exact request object`,
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) { // SEALED_GIT_CRITICAL_ANCHOR_INPUT_SYMBOL
    fail(invalidCode, `${label} refuses symbol-bearing input`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = {};
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") || // SEALED_GIT_CRITICAL_ANCHOR_INPUT_ACCESSOR
      descriptor.enumerable !== true
    ) {
      fail(
        invalidCode,
        `${label} requires enumerable own data properties`,
        { key },
      );
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function requireRequest(value, expectedKeys, label) {
  const snapshot = snapshotDataObject(
    value,
    label,
    "SEALED_GIT_REQUEST_INVALID",
  );
  const actualKeys = Reflect.ownKeys(snapshot).sort();
  const canonicalExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalExpected.length ||
    actualKeys.some((key, index) => key !== canonicalExpected[index])
  ) {
    fail(
      "SEALED_GIT_UNEXPECTED_ARGUMENT",
      `${label} request contains missing or unexpected fields`,
      { expectedKeys: canonicalExpected, actualKeys },
    );
  }
  return snapshot;
}

function requireOptions(value) {
  const snapshot = snapshotDataObject(
    value,
    "Sealed Git options",
    "SEALED_GIT_OPTIONS_INVALID",
  );
  const allowedOptionKeys = new Set([
    "repoRoot",
    "timeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
  ]);
  const unexpected = Reflect.ownKeys(snapshot)
    .filter((key) => !allowedOptionKeys.has(key))
    .sort();
  if (unexpected.length > 0 || !Object.hasOwn(snapshot, "repoRoot")) {
    fail(
      "SEALED_GIT_UNEXPECTED_OPTION",
      "Sealed Git options contain missing or unexpected fields",
      { unexpected },
    );
  }
  return snapshot;
}

function requireNoArguments(actualArguments, label) {
  if (actualArguments.length !== 0) {
    fail(
      "SEALED_GIT_UNEXPECTED_ARGUMENT",
      `${label} does not accept arguments`,
      { argumentCount: actualArguments.length },
    );
  }
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    fail(
      "SEALED_GIT_COMMIT_INVALID",
      `${label} must be one full lowercase SHA-1 commit identifier`,
    );
  }
  return value;
}

function requirePositiveInteger(value, label, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    fail(
      "SEALED_GIT_LIMIT_INVALID",
      `${label} must be a positive integer within its hard maximum`,
      { maximum },
    );
  }
  return value;
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function gitBlobObjectId(bytes) {
  return crypto
    .createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function repositoryIdentitySha256(identity) {
  return digest(
    Buffer.from(
      JSON.stringify({
        rootDev: String(identity.rootDev),
        rootIno: String(identity.rootIno),
        rootMode: identity.rootMode,
        dotGitDev: String(identity.dotGitDev),
        dotGitIno: String(identity.dotGitIno),
        dotGitKind: identity.dotGitKind,
        dotGitMode: identity.dotGitMode,
        dotGitNlink: String(identity.dotGitNlink),
        dotGitSize: String(identity.dotGitSize),
        dotGitSha256: identity.dotGitSha256,
        gitDirectoryPath: identity.gitDirectoryPath,
        gitDirectoryDev: String(identity.gitDirectoryDev),
        gitDirectoryIno: String(identity.gitDirectoryIno),
        gitDirectoryMode: identity.gitDirectoryMode,
        commonDirectoryPath: identity.commonDirectoryPath,
        commonDirectoryDev: String(identity.commonDirectoryDev),
        commonDirectoryIno: String(identity.commonDirectoryIno),
        commonDirectoryMode: identity.commonDirectoryMode,
        commonDirPointerDev:
          identity.commonDirPointerDev === null
            ? null
            : String(identity.commonDirPointerDev),
        commonDirPointerIno:
          identity.commonDirPointerIno === null
            ? null
            : String(identity.commonDirPointerIno),
        commonDirPointerMode: identity.commonDirPointerMode,
        commonDirPointerNlink:
          identity.commonDirPointerNlink === null
            ? null
            : String(identity.commonDirPointerNlink),
        commonDirPointerSize:
          identity.commonDirPointerSize === null
            ? null
            : String(identity.commonDirPointerSize),
        commonDirPointerSha256: identity.commonDirPointerSha256,
        objectDirectoryDev: String(identity.objectDirectoryDev),
        objectDirectoryIno: String(identity.objectDirectoryIno),
        objectDirectoryMode: identity.objectDirectoryMode,
        objectDirectoryPath: identity.objectDirectoryPath,
        configDev: String(identity.configDev),
        configIno: String(identity.configIno),
        configMode: identity.configMode,
        configNlink: String(identity.configNlink),
        configSize: String(identity.configSize),
        configSha256: identity.configSha256,
      }),
      "utf8",
    ),
  );
}

function trustedExecutableIdentity(candidate) {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    return null;
  }
  try {
    const realpath = fs.realpathSync.native(candidate);
    const statBefore = fs.statSync(realpath, { bigint: true });
    const mode = Number(statBefore.mode & 0o777n);
    if (
      realpath !== candidate ||
      !statBefore.isFile() ||
      statBefore.uid !== 0n ||
      (mode & 0o022) !== 0 ||
      (mode & 0o111) === 0
    ) {
      return null;
    }
    fs.accessSync(realpath, fs.constants.X_OK);
    const descriptor = fs.openSync(
      realpath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let bytes;
    let descriptorStatBefore;
    let descriptorStatAfter;
    try {
      descriptorStatBefore = fs.fstatSync(descriptor, { bigint: true });
      bytes = fs.readFileSync(descriptor);
      descriptorStatAfter = fs.fstatSync(descriptor, { bigint: true });
    } finally {
      fs.closeSync(descriptor);
    }
    const statAfter = fs.statSync(realpath, { bigint: true });
    if (
      descriptorStatBefore.dev !== statBefore.dev ||
      descriptorStatBefore.ino !== statBefore.ino ||
      descriptorStatBefore.mode !== statBefore.mode ||
      descriptorStatBefore.size !== statBefore.size ||
      descriptorStatAfter.dev !== descriptorStatBefore.dev ||
      descriptorStatAfter.ino !== descriptorStatBefore.ino ||
      descriptorStatAfter.mode !== descriptorStatBefore.mode ||
      descriptorStatAfter.size !== descriptorStatBefore.size ||
      statAfter.dev !== statBefore.dev ||
      statAfter.ino !== statBefore.ino ||
      statAfter.mode !== statBefore.mode ||
      statAfter.size !== statBefore.size ||
      BigInt(bytes.length) !== statBefore.size
    ) {
      return null;
    }
    return Object.freeze({
      path: realpath,
      dev: statBefore.dev,
      ino: statBefore.ino,
      mode,
      size: statBefore.size,
      mtimeNs: statBefore.mtimeNs,
      ctimeNs: statBefore.ctimeNs,
      sha256: digest(bytes),
    });
  } catch {
    return null;
  }
}

function resolveTrustedGitExecutable() {
  requireNoArguments(arguments, "resolveTrustedGitExecutable");
  for (const candidate of TRUSTED_GIT_CANDIDATES) {
    const identity = trustedExecutableIdentity(candidate);
    if (identity) return identity.path;
  }
  fail(
    "SEALED_GIT_EXECUTABLE_UNAVAILABLE",
    "No root-owned immutable system Git executable is available",
    { candidates: [...TRUSTED_GIT_CANDIDATES] },
  );
}

function resolveTrustedBrokerExecutable() {
  for (const candidate of TRUSTED_BROKER_CANDIDATES) {
    const identity = trustedExecutableIdentity(candidate);
    if (identity) return identity.path;
  }
  fail(
    "SEALED_GIT_AUTHORITY_BINDING_UNAVAILABLE",
    "No root-owned immutable authority broker is available",
    { candidates: [...TRUSTED_BROKER_CANDIDATES] },
  );
}

function resolveTrustedCopyExecutable() {
  for (const candidate of TRUSTED_COPY_CANDIDATES) {
    const identity = trustedExecutableIdentity(candidate);
    if (identity) return identity.path;
  }
  fail(
    "SEALED_GIT_AUTHORITY_BINDING_UNAVAILABLE",
    "No root-owned immutable metadata copier is available",
    { candidates: [...TRUSTED_COPY_CANDIDATES] },
  );
}

const TRUSTED_GIT = resolveTrustedGitExecutable();
const TRUSTED_GIT_IDENTITY = trustedExecutableIdentity(TRUSTED_GIT);
const TRUSTED_BROKER = resolveTrustedBrokerExecutable();
const TRUSTED_BROKER_IDENTITY =
  trustedExecutableIdentity(TRUSTED_BROKER);
const TRUSTED_COPY = resolveTrustedCopyExecutable();
const TRUSTED_COPY_IDENTITY = trustedExecutableIdentity(TRUSTED_COPY);

function requireTrustedExecutableUnchanged() {
  for (const [executable, expected] of [
    [TRUSTED_GIT, TRUSTED_GIT_IDENTITY],
    [TRUSTED_BROKER, TRUSTED_BROKER_IDENTITY],
    [TRUSTED_COPY, TRUSTED_COPY_IDENTITY],
  ]) {
    const current = trustedExecutableIdentity(executable);
    if (
      !current ||
      !expected ||
      current.path !== expected.path ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.mode !== expected.mode ||
      current.size !== expected.size ||
      current.mtimeNs !== expected.mtimeNs ||
      current.ctimeNs !== expected.ctimeNs ||
      current.sha256 !== expected.sha256
    ) {
      fail(
        "SEALED_GIT_EXECUTABLE_CHANGED",
        "A trusted system executable changed after initialization",
        { executable },
      );
    }
  }
}

function fullMode(stat) {
  return Number(stat.mode);
}

function requireCanonicalDirectory(directoryPath, label) {
  let realpath;
  let stat;
  try {
    realpath = fs.realpathSync.native(directoryPath);
    stat = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      `${label} is unreadable`,
      { cause: error.code || error.message },
    );
  }
  if (
    realpath !== directoryPath ||
    stat.isSymbolicLink() ||
    !stat.isDirectory()
  ) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      `${label} must be one canonical ordinary directory`,
    );
  }
  return Object.freeze({
    path: directoryPath,
    dev: stat.dev,
    ino: stat.ino,
    mode: fullMode(stat),
  });
}

function readMetadataFile(
  filePath,
  label,
  {
    minimumBytes = 0,
    maximumBytes = MAXIMUM_METADATA_BYTES,
    requireSingleLink = true,
  } = {},
) {
  let statBefore;
  let bytes;
  let statAfter;
  try {
    statBefore = fs.lstatSync(filePath, { bigint: true });
    if (
      statBefore.isSymbolicLink() ||
      !statBefore.isFile() ||
      (requireSingleLink && statBefore.nlink !== 1n) || // SEALED_GIT_CRITICAL_ANCHOR_METADATA_NLINK
      statBefore.size < BigInt(minimumBytes) ||
      statBefore.size > BigInt(maximumBytes)
    ) {
      fail(
        "SEALED_GIT_METADATA_ALIAS",
        `${label} is not one bounded unaliased regular file`,
      );
    }
    const flags =
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = fs.openSync(filePath, flags);
    try {
      const descriptorStatBefore = fs.fstatSync(descriptor, {
        bigint: true,
      });
      bytes = fs.readFileSync(descriptor);
      const descriptorStatAfter = fs.fstatSync(descriptor, {
        bigint: true,
      });
      if (
        descriptorStatBefore.dev !== statBefore.dev ||
        descriptorStatBefore.ino !== statBefore.ino ||
        descriptorStatBefore.mode !== statBefore.mode ||
        descriptorStatBefore.nlink !== statBefore.nlink ||
        descriptorStatBefore.size !== statBefore.size ||
        descriptorStatAfter.dev !== descriptorStatBefore.dev ||
        descriptorStatAfter.ino !== descriptorStatBefore.ino ||
        descriptorStatAfter.mode !== descriptorStatBefore.mode ||
        descriptorStatAfter.nlink !== descriptorStatBefore.nlink ||
        descriptorStatAfter.size !== descriptorStatBefore.size ||
        BigInt(bytes.length) !== descriptorStatBefore.size
      ) {
        fail(
          "SEALED_GIT_METADATA_ALIAS",
          `${label} changed during its bounded read`,
        );
      }
    } finally {
      fs.closeSync(descriptor);
    }
    statAfter = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error instanceof SealedGitError) throw error;
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      `${label} is unreadable`,
      { cause: error.code || error.message },
    );
  }
  if (
    statAfter.dev !== statBefore.dev ||
    statAfter.ino !== statBefore.ino ||
    statAfter.mode !== statBefore.mode ||
    statAfter.nlink !== statBefore.nlink ||
    statAfter.size !== statBefore.size
  ) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      `${label} changed during its bounded read`,
    );
  }
  return Object.freeze({
    dev: statBefore.dev,
    ino: statBefore.ino,
    mode: fullMode(statBefore),
    nlink: statBefore.nlink,
    size: statBefore.size,
    bytes: Buffer.from(bytes),
    sha256: digest(bytes),
  });
}

function decodeCanonicalUtf8(bytes, label) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      `${label} is not canonical UTF-8`,
    );
  }
  return text;
}

function resolveCommonDirectory(gitDirectory) {
  const pointerPath = path.join(gitDirectory.path, "commondir");
  let pointerStat;
  try {
    pointerStat = fs.lstatSync(pointerPath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return Object.freeze({
        directory: gitDirectory,
        pointer: null,
      });
    }
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      "Git common-directory pointer is unreadable",
      { cause: error.code || error.message },
    );
  }
  if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      "Git common-directory pointer must be one regular file",
    );
  }
  const pointer = readMetadataFile(
    pointerPath,
    "Git common-directory pointer",
    { minimumBytes: 2, maximumBytes: 4096 },
  );
  const text = decodeCanonicalUtf8(
    pointer.bytes,
    "Git common-directory pointer",
  );
  const match = text.match(/^([^\0\r\n]+)\n$/u);
  if (!match || path.normalize(match[1]) !== match[1]) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      "Git common-directory pointer is not canonical",
    );
  }
  if (path.isAbsolute(match[1])) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      "Git common-directory pointers must remain relative to opened Git authority",
    );
  }
  const resolved = path.resolve(gitDirectory.path, match[1]);
  if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      "Git common-directory pointer is not canonical",
    );
  }
  return Object.freeze({
    directory: requireCanonicalDirectory(
      resolved,
      "Resolved common Git directory",
    ),
    pointer,
  });
}

function canonicalRepositoryIdentity(repoRoot) {
  if (
    typeof repoRoot !== "string" ||
    repoRoot.length === 0 ||
    repoRoot.includes("\0") ||
    !path.isAbsolute(repoRoot) ||
    path.normalize(repoRoot) !== repoRoot
  ) {
    fail(
      "SEALED_GIT_REPOSITORY_PATH_INVALID",
      "Repository root must be one normalized absolute path",
    );
  }
  let realpath;
  let rootStat;
  let dotGitStat;
  try {
    realpath = fs.realpathSync.native(repoRoot);
    rootStat = fs.lstatSync(repoRoot, { bigint: true });
    dotGitStat = fs.lstatSync(path.join(repoRoot, ".git"), { bigint: true });
  } catch (error) {
    fail(
      "SEALED_GIT_REPOSITORY_UNREADABLE",
      "Repository root and Git metadata must already exist",
      { cause: error.code || error.message },
    );
  }
  if (
    realpath !== repoRoot ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory()
  ) {
    fail(
      "SEALED_GIT_REPOSITORY_ALIAS",
      "Repository aliases and symlinked roots are refused",
    );
  }
  if (
    dotGitStat.isSymbolicLink() ||
    (!dotGitStat.isDirectory() && !dotGitStat.isFile())
  ) {
    fail(
      "SEALED_GIT_METADATA_ALIAS",
      "Git metadata must be an ordinary directory or worktree gitfile",
    );
  }
  let dotGitMetadata = null;
  let gitDirectory;
  if (dotGitStat.isFile()) {
    dotGitMetadata = readMetadataFile(
      path.join(repoRoot, ".git"),
      "Worktree gitfile",
      { minimumBytes: 10, maximumBytes: 4096 },
    );
    if (
      dotGitMetadata.dev !== dotGitStat.dev ||
      dotGitMetadata.ino !== dotGitStat.ino ||
      BigInt(dotGitMetadata.mode) !== dotGitStat.mode ||
      dotGitMetadata.nlink !== dotGitStat.nlink ||
      dotGitMetadata.size !== dotGitStat.size
    ) {
      fail(
        "SEALED_GIT_METADATA_ALIAS",
        "Worktree gitfile changed during identity capture",
      );
    }
    const text = decodeCanonicalUtf8(
      dotGitMetadata.bytes,
      "Worktree gitfile",
    );
    const match = text.match(/^gitdir: (\/[^\0\r\n]+)\n$/u);
    if (!match || path.normalize(match[1]) !== match[1]) {
      fail(
        "SEALED_GIT_METADATA_ALIAS",
        "Worktree gitfile is not one canonical absolute Git directory pointer",
      );
    }
    gitDirectory = requireCanonicalDirectory(
      match[1],
      "Worktree Git directory",
    );
  } else {
    gitDirectory = requireCanonicalDirectory(
      path.join(repoRoot, ".git"),
      "Git directory",
    );
  }
  const common = resolveCommonDirectory(gitDirectory);
  const objectDirectory = requireCanonicalDirectory(
    path.join(common.directory.path, "objects"),
    "Git object directory",
  );
  const config = readMetadataFile(
    path.join(common.directory.path, "config"),
    "Repository Git config",
    { maximumBytes: MAXIMUM_METADATA_BYTES },
  );
  return Object.freeze({
    root: repoRoot,
    rootDev: rootStat.dev,
    rootIno: rootStat.ino,
    rootMode: fullMode(rootStat),
    dotGitDev: dotGitStat.dev,
    dotGitIno: dotGitStat.ino,
    dotGitKind: dotGitStat.isDirectory() ? "directory" : "file",
    dotGitMode: fullMode(dotGitStat),
    dotGitNlink: dotGitStat.nlink,
    dotGitSize: dotGitStat.size,
    dotGitSha256: dotGitMetadata?.sha256 || null,
    gitDirectoryPath: gitDirectory.path,
    gitDirectoryDev: gitDirectory.dev,
    gitDirectoryIno: gitDirectory.ino,
    gitDirectoryMode: gitDirectory.mode,
    commonDirectoryPath: common.directory.path,
    commonDirectoryDev: common.directory.dev,
    commonDirectoryIno: common.directory.ino,
    commonDirectoryMode: common.directory.mode,
    commonDirPointerDev: common.pointer?.dev || null,
    commonDirPointerIno: common.pointer?.ino || null,
    commonDirPointerMode: common.pointer?.mode || null,
    commonDirPointerNlink: common.pointer?.nlink || null,
    commonDirPointerSize: common.pointer?.size || null,
    commonDirPointerSha256: common.pointer?.sha256 || null,
    objectDirectoryDev: objectDirectory.dev,
    objectDirectoryIno: objectDirectory.ino,
    objectDirectoryMode: objectDirectory.mode,
    objectDirectoryPath: objectDirectory.path,
    configDev: config.dev,
    configIno: config.ino,
    configMode: config.mode,
    configNlink: config.nlink,
    configSize: config.size,
    configSha256: config.sha256,
  });
}

function requireRepositoryIdentity(identity) {
  let current;
  try {
    current = canonicalRepositoryIdentity(identity.root);
  } catch (error) {
    fail(
      "SEALED_GIT_REPOSITORY_CHANGED",
      "Repository identity could not be revalidated",
      {
        cause:
          error instanceof SealedGitError
            ? error.code
            : error.code || error.message,
      },
    );
  }
  if (repositoryIdentitySha256(current) !== repositoryIdentitySha256(identity)) {
    fail(
      "SEALED_GIT_REPOSITORY_CHANGED",
      "Repository or Git metadata identity changed after initialization",
    );
  }
}

function fileExistsWithoutFollowing(filePath) {
  try {
    fs.lstatSync(filePath, { bigint: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    fail(
      "SEALED_GIT_OBJECT_SOURCE_INVALID",
      "Git object-source metadata is unreadable",
      { path: filePath, cause: error.code || error.message },
    );
  }
}

function isObjectDescendantAlias(stat, realpath, entryPath, root) {
  return (
    stat.isSymbolicLink() ||
    realpath !== entryPath ||
    stat.dev !== root.dev
  );
}

function captureObjectDescendantAuthority(identity) {
  const root = requireCanonicalDirectory(
    identity.objectDirectoryPath,
    "Git object directory",
  );
  if (
    root.dev !== identity.objectDirectoryDev ||
    root.ino !== identity.objectDirectoryIno ||
    root.mode !== identity.objectDirectoryMode
  ) {
    fail(
      "SEALED_GIT_OBJECT_SOURCE_INVALID",
      "Git object authority changed before descendant sealing",
    );
  }
  const records = [];
  let observedEntries = 0;

  function captureEntry(entryPath, relativePath, depth, family) {
    observedEntries += 1;
    if (observedEntries > MAXIMUM_OBJECT_AUTHORITY_ENTRIES) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git object authority exceeds its bounded entry allowance",
        { maximumEntries: MAXIMUM_OBJECT_AUTHORITY_ENTRIES },
      );
    }
    let stat;
    let realpath;
    try {
      stat = fs.lstatSync(entryPath, { bigint: true });
      realpath = fs.realpathSync.native(entryPath);
    } catch (error) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git object descendant is unreadable",
        { path: relativePath, cause: error.code || error.message },
      );
    }
    if (isObjectDescendantAlias(stat, realpath, entryPath, root)) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git object descendants must remain local canonical entries",
        { path: relativePath },
      );
    }
    const kind = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : "other";
    if (
      kind === "other" ||
      (kind === "file" && stat.nlink !== 1n)
    ) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git object descendants must be unaliased files or directories",
        { path: relativePath, kind },
      );
    }
    records.push({
      path: relativePath,
      kind,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: Number(stat.mode),
      nlink: String(stat.nlink),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    });
    if (kind !== "directory") return;

    const mayDescend =
      (family === "loose" && depth === 0) ||
      (family === "pack" && depth === 0) ||
      (family === "info" && depth < 3);
    if (!mayDescend) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git object descendants exceed their canonical directory shape",
        { path: relativePath },
      );
    }
    let names;
    try {
      names = fs.readdirSync(entryPath).sort();
    } catch (error) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git object descendant directory is unreadable",
        { path: relativePath, cause: error.code || error.message },
      );
    }
    for (const name of names) {
      if (
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\0")
      ) {
        fail(
          "SEALED_GIT_OBJECT_SOURCE_INVALID",
          "Git object descendant name is not canonical",
          { path: relativePath },
        );
      }
      captureEntry(
        path.join(entryPath, name),
        `${relativePath}/${name}`,
        depth + 1,
        family,
      );
    }
  }

  let rootNames;
  try {
    rootNames = fs.readdirSync(root.path).sort();
  } catch (error) {
    fail(
      "SEALED_GIT_OBJECT_SOURCE_INVALID",
      "Git object authority is unreadable",
      { cause: error.code || error.message },
    );
  }
  for (const name of rootNames) {
    let family = null;
    if (/^[a-f0-9]{2}$/u.test(name)) family = "loose";
    else if (name === "pack") family = "pack";
    else if (name === "info") family = "info";
    if (family === null) continue;
    captureEntry(path.join(root.path, name), name, 0, family);
  }
  return digest(Buffer.from(JSON.stringify(records), "utf8"));
}

function requireObjectDescendantAuthority(identity) {
  return captureObjectDescendantAuthority(identity); // SEALED_GIT_CRITICAL_ANCHOR_OBJECT_DESCENDANT_ALIAS
}

function parseConfigEntries(bytes, label) {
  const source = decodeCanonicalUtf8(bytes, label);
  if (source.includes("\0") || source.includes("\r")) {
    fail(
      "SEALED_GIT_OBJECT_SOURCE_INVALID",
      `${label} contains non-canonical bytes`,
    );
  }
  let section = null;
  let subsection = null;
  const entries = [];
  for (const [index, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (/\\\s*$/u.test(rawLine)) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        `${label} contains an unsupported continued value`,
        { line: index + 1 },
      );
    }
    const sectionMatch = line.match(
      /^\[([A-Za-z][A-Za-z0-9.-]*)(?:\s+"([A-Za-z0-9._/-]+)")?\](?:\s*[#;].*)?$/u,
    );
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      subsection = sectionMatch[2]?.toLowerCase() || null;
      if (section === "include" || section === "includeif") {
        fail(
          "SEALED_GIT_OBJECT_SOURCE_INVALID",
          "External Git config includes are refused",
          { label, line: index + 1 },
        );
      }
      continue;
    }
    const entryMatch = rawLine.match(
      /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*?))?\s*$/u,
    );
    if (!entryMatch || section === null) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        `${label} is not one bounded canonical Git config`,
        { line: index + 1 },
      );
    }
    entries.push(
      Object.freeze({
        section,
        subsection,
        name: entryMatch[1].toLowerCase(),
        value: entryMatch[2] ?? "true",
      }),
    );
  }
  return Object.freeze(entries);
}

function isForbiddenObjectConfigEntry(entry) {
  return ( // SEALED_GIT_CRITICAL_ANCHOR_LAZY_CONFIG
    (entry.section === "extensions" &&
      entry.subsection === null &&
      entry.name === "partialclone") ||
    (entry.section === "core" &&
      entry.subsection === null &&
      (
        entry.name === "alternaterefscommand" ||
        entry.name === "alternaterefsprefixes"
      )) ||
    (
      entry.section === "remote" &&
      entry.subsection !== null &&
      (
        entry.name === "promisor" ||
        entry.name === "partialclonefilter"
      )
    )
  );
}

function requireNoExternalObjectSources(identity) {
  for (const name of FORBIDDEN_OBJECT_ENVIRONMENT) {
    if (Object.hasOwn(process.env, name)) { // SEALED_GIT_CRITICAL_ANCHOR_OBJECT_ENV
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Ambient Git object/config redirection is refused",
        { name },
      );
    }
  }
  if (
    Object.keys(process.env).some(
      (name) =>
        /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/u.test(name),
    )
  ) {
    fail(
      "SEALED_GIT_OBJECT_SOURCE_INVALID",
      "Ambient counted Git config is refused",
    );
  }

  const informationDirectory = path.join(
    identity.commonDirectoryPath,
    "objects",
    "info",
  );
  for (const name of ["alternates", "http-alternates"]) {
    const sourcePath = path.join(informationDirectory, name);
    if (fileExistsWithoutFollowing(sourcePath)) { // SEALED_GIT_CRITICAL_ANCHOR_ALTERNATE_FILE
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Repository-local alternate object sources are refused",
        { path: sourcePath },
      );
    }
  }

  const packDirectory = path.join(
    identity.commonDirectoryPath,
    "objects",
    "pack",
  );
  let packNames;
  try {
    packNames = fs.readdirSync(packDirectory);
  } catch (error) {
    if (error.code !== "ENOENT") {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_INVALID",
        "Git pack directory is unreadable",
        { cause: error.code || error.message },
      );
    }
    packNames = [];
  }
  if (packNames.some((name) => name.endsWith(".promisor"))) { // SEALED_GIT_CRITICAL_ANCHOR_PROMISOR_PACK
    fail(
      "SEALED_GIT_OBJECT_SOURCE_INVALID",
      "Lazy promisor object packs are refused",
    );
  }

  const configPaths = [
    path.join(identity.commonDirectoryPath, "config"),
    path.join(identity.gitDirectoryPath, "config.worktree"),
  ];
  for (const configPath of configPaths) {
    if (!fileExistsWithoutFollowing(configPath)) continue;
    const config = readMetadataFile(
      configPath,
      "Repository Git config",
      { maximumBytes: MAXIMUM_METADATA_BYTES },
    );
    const entries = parseConfigEntries(
      config.bytes,
      "Repository Git config",
    );
    for (const entry of entries) {
      if (isForbiddenObjectConfigEntry(entry)) {
        fail(
          "SEALED_GIT_OBJECT_SOURCE_INVALID",
          "Alternate or lazy external object configuration is refused",
          {
            section: entry.section,
            subsection: entry.subsection,
            name: entry.name,
          },
        );
      }
    }
  }
}

function requireRepositoryPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "SEALED_GIT_PATH_INVALID",
      "Repository path is not a bounded canonical relative path",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    fail(
      "SEALED_GIT_PATH_INVALID",
      "Repository path may not traverse or contain empty components",
    );
  }
  return value;
}

function topLevelLiteralPathspec(value) {
  return `:(top,literal)${value}`;
}

function requireRepositoryPaths(value) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype || // SEALED_GIT_CRITICAL_ANCHOR_ARRAY_PROTOTYPE
    value.length < 1 ||
    value.length > 512
  ) {
    fail(
      "SEALED_GIT_PATHS_INVALID",
      "Repository path collection must contain between 1 and 512 paths",
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ];
  const denseKeysValid =
    !ownKeys.some((key) => typeof key !== "string") &&
    ownKeys.length === expectedKeys.length &&
    !ownKeys.some((key) => !expectedKeys.includes(key));
  if (
    !denseKeysValid
  ) { // SEALED_GIT_CRITICAL_ANCHOR_DENSE_ARRAY
    fail(
      "SEALED_GIT_PATHS_INVALID",
      "Repository paths must be one dense canonical array",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const canonical = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") || // SEALED_GIT_CRITICAL_ANCHOR_ARRAY_ACCESSOR
      descriptor.enumerable !== true
    ) {
      fail(
        "SEALED_GIT_PATHS_INVALID",
        "Repository path entries must be enumerable own data properties",
        { index },
      );
    }
    canonical.push(requireRepositoryPath(descriptor.value));
  }
  if (
    canonical.some(
      (relativePath, index) =>
        index > 0 && canonical[index - 1] >= relativePath,
    )
  ) { // SEALED_GIT_CRITICAL_ANCHOR_CANONICAL_ARRAY
    fail(
      "SEALED_GIT_PATHS_INVALID",
      "Repository paths must be strictly sorted without duplicates",
    );
  }
  return Object.freeze(canonical);
}

function requireLocalTrackingRef(value) {
  if (
    typeof value !== "string" ||
    value.length < "refs/remotes/a/b".length ||
    value.length > 255 ||
    !value.startsWith("refs/remotes/") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/u.test(value)
  ) {
    fail(
      "SEALED_GIT_TRACKING_REF_INVALID",
      "Local tracking ref must be one exact refs/remotes branch",
    );
  }
  return value;
}

function requireRemoteRef(value) {
  if (
    typeof value !== "string" ||
    value.length <= REMOTE_REF_PREFIX.length ||
    value.length > 255 ||
    !value.startsWith(REMOTE_REF_PREFIX) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/u.test(value)
  ) {
    fail(
      "SEALED_GIT_REMOTE_REF_INVALID",
      "Remote read-back requires one canonical branch ref",
    );
  }
  return value;
}

function requireHttpsRemote(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 2048 ||
    value.includes("\0")
  ) {
    fail(
      "SEALED_GIT_REMOTE_URL_INVALID",
      "Remote read-back requires one bounded HTTPS URL",
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "SEALED_GIT_REMOTE_URL_INVALID",
      "Remote read-back URL is invalid",
    );
  }
  if (
    parsed.protocol !== "https:" || // SEALED_GIT_CRITICAL_ANCHOR_HTTPS_ONLY
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname !== parsed.hostname.toLowerCase() ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(parsed.hostname) ||
    !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/u.test(parsed.pathname) ||
    parsed.pathname.includes("..") ||
    parsed.toString() !== value
  ) {
    fail(
      "SEALED_GIT_REMOTE_URL_INVALID",
      "Remote read-back permits only canonical HTTPS Git repository URLs",
    );
  }
  return value;
}

function openBoundDirectoryAuthority(
  directoryPath,
  expectedDev,
  expectedIno,
  expectedMode,
  label,
) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      directoryPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.dev !== expectedDev ||
      stat.ino !== expectedIno ||
      Number(stat.mode) !== expectedMode
    ) {
      fail(
        "SEALED_GIT_AUTHORITY_BINDING_FAILED",
        `Opened ${label} authority does not match the sealed repository`,
      );
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof SealedGitError) throw error;
    fail(
      "SEALED_GIT_AUTHORITY_BINDING_FAILED",
      `${label} authority could not be opened without following aliases`,
      { label, cause: error.code || error.message },
    );
  }
}

function openBoundGitAuthority(repository) {
  return openBoundDirectoryAuthority(
    repository.gitDirectoryPath,
    repository.gitDirectoryDev,
    repository.gitDirectoryIno,
    repository.gitDirectoryMode,
    "Git",
  );
}

function openBoundCommonAuthority(repository) {
  return openBoundDirectoryAuthority(
    repository.commonDirectoryPath,
    repository.commonDirectoryDev,
    repository.commonDirectoryIno,
    repository.commonDirectoryMode,
    "common Git",
  );
}

function openBoundWorktreeAuthority(repository) {
  return openBoundDirectoryAuthority(
    repository.root,
    repository.rootDev,
    repository.rootIno,
    repository.rootMode,
    "worktree",
  );
}

function requireSupportedSnapshotIndex(gitDirectoryPath) {
  const indexPath = path.join(gitDirectoryPath, "index");
  if (!fileExistsWithoutFollowing(indexPath)) return;
  const index = readMetadataFile(
    indexPath,
    "Snapshot Git index",
    { maximumBytes: MAXIMUM_METADATA_BYTES * 64 },
  ).bytes;
  if (index.length < 32 || index.subarray(0, 4).toString("ascii") !== "DIRC") {
    fail(
      "SEALED_GIT_INDEX_UNSUPPORTED",
      "Snapshot index does not have a canonical Git index header",
    );
  }
  const version = index.readUInt32BE(4);
  const entryCount = index.readUInt32BE(8);
  if ((version !== 2 && version !== 3) || entryCount > 1_000_000) {
    fail(
      "SEALED_GIT_INDEX_UNSUPPORTED",
      "Split, sparse, v4, or oversized Git indexes are refused",
      { version, entryCount },
    );
  }
  const payloadEnd = index.length - 20;
  const expectedChecksum = index.subarray(payloadEnd);
  const observedChecksum = crypto
    .createHash("sha1")
    .update(index.subarray(0, payloadEnd))
    .digest();
  if (!observedChecksum.equals(expectedChecksum)) {
    fail(
      "SEALED_GIT_INDEX_UNSUPPORTED",
      "Snapshot index checksum is invalid",
    );
  }
  let offset = 12;
  for (let entry = 0; entry < entryCount; entry += 1) {
    const entryStart = offset;
    if (offset + 62 > payloadEnd) {
      fail("SEALED_GIT_INDEX_UNSUPPORTED", "Snapshot index is truncated");
    }
    const flags = index.readUInt16BE(offset + 60);
    offset += 62;
    if ((flags & 0x4000) !== 0) {
      if (version !== 3 || offset + 2 > payloadEnd) {
        fail(
          "SEALED_GIT_INDEX_UNSUPPORTED",
          "Snapshot index has invalid extended flags",
        );
      }
      offset += 2;
    }
    const declaredLength = flags & 0x0fff;
    const nul = index.indexOf(0, offset);
    if (
      nul < offset ||
      nul >= payloadEnd ||
      (declaredLength < 0x0fff && nul - offset !== declaredLength)
    ) {
      fail(
        "SEALED_GIT_INDEX_UNSUPPORTED",
        "Snapshot index path framing is invalid",
      );
    }
    offset = nul + 1;
    while ((offset - entryStart) % 8 !== 0) offset += 1;
    if (offset > payloadEnd) {
      fail("SEALED_GIT_INDEX_UNSUPPORTED", "Snapshot index is truncated");
    }
  }
  while (offset < payloadEnd) {
    if (offset + 8 > payloadEnd) {
      fail(
        "SEALED_GIT_INDEX_UNSUPPORTED",
        "Snapshot index extension framing is invalid",
      );
    }
    const signature = index.subarray(offset, offset + 4).toString("ascii");
    const size = index.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > payloadEnd) {
      fail(
        "SEALED_GIT_INDEX_UNSUPPORTED",
        "Snapshot index extension is truncated",
      );
    }
    if (signature === "link" || signature === "sdir") {
      fail(
        "SEALED_GIT_INDEX_UNSUPPORTED",
        "Split and sparse Git indexes are refused",
        { signature },
      );
    }
    offset += size;
  }
}

function validatePrivateSnapshot(gitDirectoryPath) {
  let entries = 0;
  let totalBytes = 0n;
  const stack = [gitDirectoryPath];
  while (stack.length > 0) {
    const directoryPath = stack.pop();
    const names = fs.readdirSync(directoryPath).sort();
    for (const name of names) {
      entries += 1;
      if (entries > MAXIMUM_OBJECT_AUTHORITY_ENTRIES) {
        fail(
          "SEALED_GIT_SNAPSHOT_INVALID",
          "Private Git snapshot exceeds its bounded entry allowance",
        );
      }
      if (name.endsWith(".lock")) {
        fail(
          "SEALED_GIT_SNAPSHOT_INVALID",
          "Private Git snapshot contains an in-progress lock",
          { name },
        );
      }
      const entryPath = path.join(directoryPath, name);
      const stat = fs.lstatSync(entryPath, { bigint: true });
      const realpath = fs.realpathSync.native(entryPath);
      if (
        stat.isSymbolicLink() ||
        realpath !== entryPath ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1n)
      ) {
        fail(
          "SEALED_GIT_SNAPSHOT_INVALID",
          "Private Git snapshot contains an aliased or special entry",
          { name },
        );
      }
      totalBytes += stat.isFile() ? stat.size : 0n;
      if (totalBytes > BigInt(MAXIMUM_SNAPSHOT_BYTES)) {
        fail(
          "SEALED_GIT_SNAPSHOT_INVALID",
          "Private Git snapshot exceeds its byte allowance",
        );
      }
      if (stat.isDirectory()) stack.push(entryPath);
    }
  }
  requireSupportedSnapshotIndex(gitDirectoryPath);
}

function createSealedGit(options) {
  options = requireOptions(options);
  const timeoutMs = requirePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    MAXIMUM_TIMEOUT_MS,
  );
  const maxStdoutBytes = requirePositiveInteger(
    options.maxStdoutBytes ?? DEFAULT_STDOUT_BYTES,
    "maxStdoutBytes",
    MAXIMUM_OUTPUT_BYTES,
  );
  const maxStderrBytes = requirePositiveInteger(
    options.maxStderrBytes ?? DEFAULT_STDERR_BYTES,
    "maxStderrBytes",
    MAXIMUM_OUTPUT_BYTES,
  );
  const repository = canonicalRepositoryIdentity(options.repoRoot);
  const primaryWorktreeRoot =
    path.basename(repository.commonDirectoryPath) === ".git"
      ? path.dirname(repository.commonDirectoryPath)
      : repository.root;
  requireNoExternalObjectSources(repository);
  requireObjectDescendantAuthority(repository);
  if (
    digest(Buffer.from(AUTHORITY_BROKER_SOURCE, "utf8")) !==
    AUTHORITY_BROKER_SHA256
  ) {
    fail(
      "SEALED_GIT_AUTHORITY_BINDING_UNAVAILABLE",
      "The fixed authority broker source does not match its sealed digest",
    );
  }
  function copyBoundDirectory(
    descriptor,
    destinationPath,
    label,
  ) {
    let result;
    try {
      result = spawnSync(
        TRUSTED_BROKER,
        [
          "-e",
          AUTHORITY_BROKER_SOURCE,
          TRUSTED_COPY,
          "-R",
          "-P",
          ".",
          destinationPath,
        ],
        {
          cwd: NEUTRAL_CHILD_DIRECTORY,
          env: { ...SEALED_ENVIRONMENT },
          encoding: null,
          timeout: timeoutMs,
          maxBuffer: maxStderrBytes,
          stdio: ["ignore", "pipe", "pipe", descriptor],
          windowsHide: true,
        },
      );
    } finally {
      fs.closeSync(descriptor);
    }
    if (
      result.error ||
      result.signal !== null ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.length !== 0 ||
      !Buffer.isBuffer(result.stderr) ||
      result.stderr.length !== 0
    ) {
      fail(
        "SEALED_GIT_SNAPSHOT_FAILED",
        `Private ${label} snapshot could not be materialized`,
        {
          status: result.status,
          signal: result.signal || null,
          cause: result.error?.code || null,
          stdoutBytes: Buffer.isBuffer(result.stdout)
            ? result.stdout.length
            : 0,
          stderrSha256: digest(
            Buffer.isBuffer(result.stderr)
              ? result.stderr
              : Buffer.alloc(0),
          ),
        },
      );
    }
  }

  function materializePrivateSnapshot() {
    const rawParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-sealed-git-snapshot-"),
    );
    const parent = fs.realpathSync.native(rawParent);
    fs.chmodSync(parent, 0o700);
    const gitDirectoryPath = path.join(parent, "git");
    try {
      copyBoundDirectory(
        openBoundCommonAuthority(repository),
        gitDirectoryPath,
        "common Git metadata",
      );
      if (
        repository.gitDirectoryDev !== repository.commonDirectoryDev ||
        repository.gitDirectoryIno !== repository.commonDirectoryIno
      ) {
        const linkedPath = path.join(parent, "linked");
        copyBoundDirectory(
          openBoundGitAuthority(repository),
          linkedPath,
          "linked-worktree Git metadata",
        );
        for (const name of [
          "HEAD",
          "index",
          "ORIG_HEAD",
          "config.worktree",
        ]) {
          const sourcePath = path.join(linkedPath, name);
          if (!fileExistsWithoutFollowing(sourcePath)) continue;
          const source = readMetadataFile(
            sourcePath,
            `Snapshot linked-worktree ${name}`,
            { maximumBytes: MAXIMUM_METADATA_BYTES * 64 },
          );
          fs.writeFileSync(
            path.join(gitDirectoryPath, name),
            source.bytes,
            { flag: "w", mode: source.mode & 0o777 },
          );
        }
      }
      for (const name of ["commondir", "gitdir"]) {
        const pointerPath = path.join(gitDirectoryPath, name);
        if (fileExistsWithoutFollowing(pointerPath)) {
          const stat = fs.lstatSync(pointerPath, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink()) {
            fail(
              "SEALED_GIT_SNAPSHOT_INVALID",
              "Private Git snapshot pointer is not a regular file",
              { name },
            );
          }
          fs.unlinkSync(pointerPath);
        }
      }
      validatePrivateSnapshot(gitDirectoryPath);
      const objectDirectory = requireCanonicalDirectory(
        path.join(gitDirectoryPath, "objects"),
        "Private snapshot object directory",
      );
      const snapshotIdentity = {
        commonDirectoryPath: gitDirectoryPath,
        gitDirectoryPath,
        objectDirectoryPath: objectDirectory.path,
        objectDirectoryDev: objectDirectory.dev,
        objectDirectoryIno: objectDirectory.ino,
        objectDirectoryMode: objectDirectory.mode,
      };
      requireNoExternalObjectSources(snapshotIdentity);
      requireObjectDescendantAuthority(snapshotIdentity);
      const snapshotDescriptor = fs.openSync(
        gitDirectoryPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      let verification;
      try {
        verification = spawnSync(
          TRUSTED_BROKER,
          [
            "-e",
            AUTHORITY_BROKER_SOURCE,
            TRUSTED_GIT,
            ...FIXED_GIT_PREFIX,
            "-c",
            "core.bare=false",
            "--git-dir=.",
            "--work-tree=.",
            "fsck",
            "--full",
            "--strict",
            "--no-dangling",
            "--no-reflogs",
          ],
          {
            cwd: NEUTRAL_CHILD_DIRECTORY,
            env: { ...SEALED_ENVIRONMENT },
            encoding: null,
            timeout: timeoutMs,
            maxBuffer: maxStderrBytes,
            stdio: ["ignore", "pipe", "pipe", snapshotDescriptor],
            windowsHide: true,
          },
        );
      } finally {
        fs.closeSync(snapshotDescriptor);
      }
      if (
        verification.error ||
        verification.signal !== null ||
        verification.status !== 0 ||
        !Buffer.isBuffer(verification.stdout) ||
        verification.stdout.length !== 0 ||
        !Buffer.isBuffer(verification.stderr) ||
        verification.stderr.length !== 0
      ) {
        fail(
          "SEALED_GIT_SNAPSHOT_OBJECTS_INVALID",
          "Private Git snapshot failed strict object-integrity verification",
          {
            status: verification.status,
            signal: verification.signal || null,
            cause: verification.error?.code || null,
            stdoutSha256: digest(
              Buffer.isBuffer(verification.stdout)
                ? verification.stdout
                : Buffer.alloc(0),
            ),
            stderrSha256: digest(
              Buffer.isBuffer(verification.stderr)
                ? verification.stderr
                : Buffer.alloc(0),
            ),
          },
        );
      }
      return Object.freeze({ parent, gitDirectoryPath });
    } catch (error) {
      fs.rmSync(parent, { recursive: true, force: true });
      throw error;
    }
  }

  function requirePreOperationFence() {
    requireTrustedExecutableUnchanged(); // SEALED_GIT_CRITICAL_ANCHOR_PRE_EXECUTABLE_FENCE
    requireRepositoryIdentity(repository); // SEALED_GIT_CRITICAL_ANCHOR_PRE_REPOSITORY_FENCE
    requireNoExternalObjectSources(repository); // SEALED_GIT_CRITICAL_ANCHOR_PRE_OBJECT_SOURCE_FENCE
    return requireObjectDescendantAuthority(repository);
  }

  function requirePostOperationFence(expectedObjectAuthority) {
    requireTrustedExecutableUnchanged(); // SEALED_GIT_CRITICAL_ANCHOR_POST_EXECUTABLE_FENCE
    requireRepositoryIdentity(repository); // SEALED_GIT_CRITICAL_ANCHOR_POST_REPOSITORY_FENCE
    requireNoExternalObjectSources(repository); // SEALED_GIT_CRITICAL_ANCHOR_POST_OBJECT_SOURCE_FENCE
    const observedObjectAuthority =
      requireObjectDescendantAuthority(repository);
    if (observedObjectAuthority !== expectedObjectAuthority) {
      fail(
        "SEALED_GIT_OBJECT_SOURCE_CHANGED",
        "Git object descendants changed during a sealed operation",
      );
    }
  }

  let activeSnapshot = null;
  let operationDepth = 0;

  function inSnapshotScope(operation) {
    return function sealedOperation(...args) {
      operationDepth += 1;
      try {
        return Reflect.apply(operation, null, args);
      } finally {
        operationDepth -= 1;
        if (operationDepth === 0 && activeSnapshot !== null) {
          fs.rmSync(activeSnapshot.parent, {
            recursive: true,
            force: true,
          });
          activeSnapshot = null;
        }
      }
    };
  }

  function execute(operation, args, {
    maximumStdoutBytes = maxStdoutBytes,
    acceptedStatuses = [0],
    remote = false,
    input = null,
  } = {}) {
    const effectiveStdoutBytes = Math.min(
      maximumStdoutBytes,
      maxStdoutBytes,
    );
    const requiresWorktreeAuthority =
      operation === "status" || operation === "working-diff";
    let commandArgs = [
      ...FIXED_GIT_PREFIX,
      "-c",
      "core.bare=false",
      ...(remote
        ? ["--git-dir=/dev/null"]
        : ["--git-dir=.", "--work-tree=."]),
      ...args,
    ];
    let primaryError = null;
    let receipt = null;
    let expectedObjectAuthority = null;
    let authorityDescriptor = null;
    let snapshot = null;
    try {
      expectedObjectAuthority = requirePreOperationFence();
      if (!remote) {
        if (activeSnapshot === null) {
          activeSnapshot = materializePrivateSnapshot();
        }
        snapshot = activeSnapshot;
        if (requiresWorktreeAuthority) {
          authorityDescriptor = openBoundWorktreeAuthority(repository);
          commandArgs = [
            ...FIXED_GIT_PREFIX,
            "-c",
            "core.bare=false",
            `--git-dir=${snapshot.gitDirectoryPath}`,
            "--work-tree=.",
            ...args,
          ];
        } else {
          authorityDescriptor = fs.openSync(
            snapshot.gitDirectoryPath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
          );
          commandArgs = [
            ...FIXED_GIT_PREFIX,
            "-c",
            "core.bare=false",
            "--git-dir=.",
            "--work-tree=.",
            ...args,
          ];
        }
      }
      const command = remote ? TRUSTED_GIT : TRUSTED_BROKER;
      const effectiveArgs = remote
        ? commandArgs
        : [
            "-e",
            AUTHORITY_BROKER_SOURCE,
            TRUSTED_GIT,
            ...commandArgs,
          ];
      const stdio = [
        input === null ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ];
      if (!remote) stdio[AUTHORITY_DESCRIPTOR] = authorityDescriptor;
      let result;
      try {
        result = spawnSync(command, effectiveArgs, {
          cwd: NEUTRAL_CHILD_DIRECTORY,
          env: { ...SEALED_ENVIRONMENT },
          encoding: null,
          input,
          timeout: timeoutMs,
          maxBuffer: Math.max(effectiveStdoutBytes, maxStderrBytes),
          stdio,
          windowsHide: true,
        });
      } finally {
        if (authorityDescriptor !== null) {
          fs.closeSync(authorityDescriptor);
          authorityDescriptor = null;
        }
      }
      const stdout = Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.alloc(0);
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.alloc(0);
      if (result.error?.code === "ETIMEDOUT") { // SEALED_GIT_CRITICAL_ANCHOR_TIMEOUT
        fail(
          "SEALED_GIT_TIMEOUT",
          "Bounded Git inspection exceeded its deadline",
          { operation, timeoutMs },
        );
      }
      if (
        result.error?.code === "ENOBUFS" ||
        stdout.length > effectiveStdoutBytes // SEALED_GIT_CRITICAL_ANCHOR_STDOUT_LIMIT
      ) {
        fail(
          "SEALED_GIT_OUTPUT_LIMIT",
          "Bounded Git inspection exceeded its stdout allowance",
          {
            operation,
            stdoutBytes: stdout.length,
            maximumStdoutBytes: effectiveStdoutBytes,
          },
        );
      }
      if (stderr.length > maxStderrBytes) { // SEALED_GIT_CRITICAL_ANCHOR_STDERR_LIMIT
        fail(
          "SEALED_GIT_OUTPUT_LIMIT",
          "Bounded Git inspection exceeded its stderr allowance",
          {
            operation,
            stderrBytes: stderr.length,
            maximumStderrBytes: maxStderrBytes,
          },
        );
      }
      if (
        result.error ||
        result.signal !== null ||
        result.status === null ||
        !acceptedStatuses.includes(result.status) // SEALED_GIT_CRITICAL_ANCHOR_COMMAND_STATUS
      ) {
        if (
          !remote &&
          stderr.toString("utf8").startsWith("authority-")
        ) {
          fail(
            "SEALED_GIT_AUTHORITY_BINDING_FAILED",
            "The authority broker refused the local Git child",
            {
              operation,
              status: result.status,
              signal: result.signal || null,
              cause: result.error?.code || null,
              stderrSha256: digest(stderr),
            },
          );
        }
        fail(
          "SEALED_GIT_COMMAND_FAILED",
          "A sealed read-only Git operation failed",
          {
            operation,
            status: result.status,
            signal: result.signal || null,
            cause: result.error?.code || null,
            stderrBytes: stderr.length,
            stderrSha256: digest(stderr),
          },
        );
      }
      receipt = { stdout, stderr, status: result.status };
    } catch (error) {
      if (authorityDescriptor !== null) {
        fs.closeSync(authorityDescriptor);
        authorityDescriptor = null;
      }
      primaryError = error;
    }

    try {
      requirePostOperationFence(expectedObjectAuthority);
    } catch (fenceError) {
      if (primaryError && fenceError instanceof SealedGitError) {
        fenceError.details = {
          ...fenceError.details,
          primaryCode: primaryError.code || primaryError.name || "Error",
        };
      }
      throw fenceError;
    }
    if (primaryError) throw primaryError;
    return receipt;
  }

  function text(operation, args, options) {
    const { stdout } = execute(operation, args, options);
    const value = stdout.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(stdout)) { // SEALED_GIT_CRITICAL_ANCHOR_OUTPUT_UTF8
      fail(
        "SEALED_GIT_OUTPUT_INVALID",
        "Git text output is not canonical UTF-8",
        { operation },
      );
    }
    return value.trim();
  }

  function linkedHeadAuthority() {
    const parent = fs.realpathSync.native(
      fs.mkdtempSync(
        path.join(os.tmpdir(), "pikiio-sealed-git-head-"),
      ),
    );
    fs.chmodSync(parent, 0o700);
    const copiedGitDirectory = path.join(parent, "git");
    try {
      copyBoundDirectory(
        openBoundGitAuthority(repository),
        copiedGitDirectory,
        "linked-worktree control metadata",
      );
      validatePrivateSnapshot(copiedGitDirectory);
      const head = readMetadataFile(
        path.join(copiedGitDirectory, "HEAD"),
        "Linked-worktree HEAD",
        { minimumBytes: 6, maximumBytes: 4096 },
      ).bytes.toString("utf8");
      const detached = head.match(/^([a-f0-9]{40})\n$/u);
      if (detached) {
        return Object.freeze({ commit: detached[1], branch: null });
      }
      const symbolic = head.match(
        /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\n$/u,
      );
      if (
        !symbolic ||
        symbolic[1].includes("..") ||
        symbolic[1].includes("@{") ||
        symbolic[1].includes("//") ||
        symbolic[1].endsWith("/") ||
        symbolic[1].endsWith(".") ||
        symbolic[1].endsWith(".lock")
      ) {
        fail(
          "SEALED_GIT_HEAD_INVALID",
          "Linked-worktree HEAD is not one canonical detached or branch identity",
        );
      }
      return Object.freeze({
        commit: null,
        branch: symbolic[1].slice("refs/heads/".length),
        ref: symbolic[1],
      });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }

  function exactCommitObject(value, label) {
    const expected = requireCommit(value, label);
    const result = execute(
      `${label}-type`,
      ["cat-file", "-t", expected],
      {
        maximumStdoutBytes: 16,
        acceptedStatuses: [0, 128],
      },
    );
    const objectType = result.stdout.toString("utf8").trim();
    if (
      !Buffer.from(`${objectType}${result.stdout.length === 0 ? "" : "\n"}`, "utf8")
        .equals(result.stdout) ||
      result.status !== 0 ||
      objectType !== "commit"
    ) { // SEALED_GIT_CRITICAL_ANCHOR_COMMIT_TYPE
      fail(
        "SEALED_GIT_COMMIT_OBJECT_INVALID",
        `${label} must resolve to that exact commit object`,
        {
          expected,
          status: result.status,
          observedType: objectType || null,
        },
      );
    }
    return expected;
  }

  function head() {
    requireNoArguments(arguments, "head");
    if (
      repository.gitDirectoryDev !== repository.commonDirectoryDev ||
      repository.gitDirectoryIno !== repository.commonDirectoryIno
    ) {
      const authority = linkedHeadAuthority();
      const value = authority.commit || text(
        "linked-head-ref",
        ["rev-parse", "--verify", `${authority.ref}^{commit}`],
        { maximumStdoutBytes: 128 },
      );
      return exactCommitObject(value, "HEAD");
    }
    const value = text(
      "head",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { maximumStdoutBytes: 128 },
    );
    return exactCommitObject(value, "HEAD");
  }

  function branch() {
    requireNoArguments(arguments, "branch");
    if (
      repository.gitDirectoryDev !== repository.commonDirectoryDev ||
      repository.gitDirectoryIno !== repository.commonDirectoryIno
    ) {
      return linkedHeadAuthority().branch;
    }
    const value = text(
      "branch",
      ["branch", "--show-current"],
      { maximumStdoutBytes: 512 },
    );
    if (value === "") return null;
    if (
      value.length > 255 ||
      value.startsWith("-") ||
      value.includes("..") ||
      value.includes("@{") ||
      value.includes("\\") ||
      value.includes("//") ||
      value.endsWith("/") ||
      value.endsWith(".") ||
      value.endsWith(".lock") ||
      /[\u0000-\u0020\u007f~^:?*[\\]/u.test(value)
    ) {
      fail(
        "SEALED_GIT_BRANCH_INVALID",
        "Current branch output is not one canonical short branch name",
      );
    }
    return value;
  }

  function tree(request) {
    request = requireRequest(request, ["commit"], "tree");
    const commit = exactCommitObject(request.commit, "tree commit");
    const value = text(
      "tree",
      ["rev-parse", "--verify", `${commit}^{tree}`],
      { maximumStdoutBytes: 128 },
    );
    return requireCommit(value, "tree");
  }

  function commit(request) {
    request = requireRequest(request, ["commit"], "commit");
    return exactCommitObject(request.commit, "commit object");
  }

  function status() {
    requireNoArguments(arguments, "status");
    return Buffer.from(
      execute(
        "status",
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
          "--no-renames",
        ],
      ).stdout,
    );
  }

  function parent(request) {
    request = requireRequest(request, ["commit"], "parent");
    const commit = exactCommitObject(request.commit, "parent commit");
    const line = text(
      "parent",
      ["rev-list", "--parents", "--max-count=1", commit],
      { maximumStdoutBytes: 256 },
    );
    const parts = line.split(" ");
    if (
      parts.length !== 2 ||
      parts[0] !== commit ||
      !COMMIT_PATTERN.test(parts[1])
    ) {
      fail(
        "SEALED_GIT_PARENT_CARDINALITY",
        "Governance parent lookup requires exactly one parent",
        { fieldCount: parts.length },
      );
    }
    return parts[1];
  }

  function history(request) {
    request = requireRequest(
      request,
      ["fromExclusive", "maximum", "path", "toInclusive"],
      "history",
    );
    const fromExclusive = exactCommitObject(
      request.fromExclusive,
      "history lower bound",
    );
    const toInclusive = exactCommitObject(
      request.toInclusive,
      "history upper bound",
    );
    const relativePath = requireRepositoryPath(request.path);
    const maximum = requirePositiveInteger(
      request.maximum,
      "history maximum",
      512,
    );
    const output = text(
      "history",
      [
        "log",
        "--reverse",
        "--format=%H",
        `--max-count=${maximum + 1}`,
        `${fromExclusive}..${toInclusive}`,
        "--",
        topLevelLiteralPathspec(relativePath),
      ],
      { maximumStdoutBytes: (maximum + 1) * 41 },
    );
    const commits = output === "" ? [] : output.split("\n");
    if (
      commits.length > maximum ||
      commits.some((commit) => !COMMIT_PATTERN.test(commit))
    ) {
      fail(
        "SEALED_GIT_HISTORY_BOUND_EXCEEDED",
        "Path history exceeded its caller-declared commit boundary",
        { maximum, observed: commits.length },
      );
    }
    return Object.freeze([...commits]);
  }

  function commitCount(request) {
    request = requireRequest(
      request,
      ["fromExclusive", "toInclusive"],
      "commitCount",
    );
    const fromExclusive = exactCommitObject(
      request.fromExclusive,
      "commit-count lower bound",
    );
    const toInclusive = exactCommitObject(
      request.toInclusive,
      "commit-count upper bound",
    );
    const value = text(
      "commit-count",
      ["rev-list", "--count", `${fromExclusive}..${toInclusive}`],
      { maximumStdoutBytes: 32 },
    );
    if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
      fail(
        "SEALED_GIT_COMMIT_COUNT_INVALID",
        "Commit count output is not one bounded integer",
      );
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count)) {
      fail(
        "SEALED_GIT_COMMIT_COUNT_INVALID",
        "Commit count exceeds the safe integer boundary",
      );
    }
    return count;
  }

  function isAncestor(request) {
    request = requireRequest(
      request,
      ["ancestor", "descendant"],
      "isAncestor",
    );
    const ancestor = exactCommitObject(request.ancestor, "ancestor");
    const descendant = exactCommitObject(
      request.descendant,
      "descendant",
    );
    const result = execute(
      "ancestry",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { maximumStdoutBytes: 1, acceptedStatuses: [0, 1] },
    );
    if (result.stdout.length !== 0 || result.stderr.length !== 0) {
      fail(
        "SEALED_GIT_OUTPUT_INVALID",
        "Ancestry check emitted unexpected output",
      );
    }
    return result.status === 0;
  }

  function readBlob(entry, maximumBytes, operation) {
    const sizeText = text(
      `${operation}-size`,
      ["cat-file", "-s", entry.objectId],
      { maximumStdoutBytes: 64 },
    );
    if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(sizeText)) {
      fail(
        "SEALED_GIT_OBJECT_SIZE_INVALID",
        "Git object declared an invalid byte length",
      );
    }
    const size = Number(sizeText);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > maximumBytes
    ) {
      fail(
        "SEALED_GIT_OUTPUT_LIMIT",
        "Git object exceeds the sealed stdout allowance",
        { operation, size, maximumStdoutBytes: maximumBytes },
      );
    }
    const bytes = execute(
      operation,
      ["cat-file", "blob", entry.objectId],
      { maximumStdoutBytes: Math.max(1, size) },
    ).stdout;
    if (bytes.length !== size) {
      fail(
        "SEALED_GIT_OBJECT_CHANGED",
        "Git object bytes did not match the preflighted object size",
        { expectedBytes: size, actualBytes: bytes.length },
      );
    }
    const readBackObjectId = gitBlobObjectId(bytes);
    if (readBackObjectId !== entry.objectId) { // SEALED_GIT_CRITICAL_ANCHOR_BLOB_IDENTITY
      fail(
        "SEALED_GIT_OBJECT_CHANGED",
        "Git blob bytes do not reproduce their exact tree object identity",
        {
          path: entry.path,
          mode: entry.mode,
          type: entry.type,
          expectedObjectId: entry.objectId,
          readBackObjectId,
        },
      );
    }
    return Buffer.from(bytes);
  }

  function show(request) {
    request = requireRequest(request, ["commit", "path"], "show");
    const relativePath = requireRepositoryPath(request.path);
    const commit = exactCommitObject(request.commit, "show commit");
    const entry = objectAtPath({ commit, path: relativePath });
    if (entry.type !== "blob") {
      fail(
        "SEALED_GIT_SHOW_OBJECT_INVALID",
        "Show requires one exact blob tree entry",
        { relativePath, mode: entry.mode, type: entry.type },
      );
    }
    return readBlob(entry, maxStdoutBytes, "show");
  }

  function objectsAtPaths(request) {
    request = requireRequest(
      request,
      ["commit", "paths"],
      "objectsAtPaths",
    );
    const paths = requireRepositoryPaths(request.paths);
    const commit = exactCommitObject(
      request.commit,
      "tree-entry commit",
    );
    const bytes = execute(
      "objects-at-paths",
      [
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        commit,
        "--",
        ...paths.map(topLevelLiteralPathspec),
      ],
    ).stdout;
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) {
      fail(
        "SEALED_GIT_TREE_OUTPUT_INVALID",
        "Tree-entry output is not canonical UTF-8",
      );
    }
    const entries = value
      .split("\0")
      .filter(Boolean)
      .map((raw) => {
        const match = raw.match(
          /^([0-9]{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/u,
        );
        if (!match) {
          fail(
            "SEALED_GIT_TREE_OUTPUT_INVALID",
            "Tree-entry output contains a malformed object",
          );
        }
        const relativePath = requireRepositoryPath(match[4]);
        const allowedMode =
          (match[2] === "blob" &&
            ["100644", "100755", "120000"].includes(match[1])) ||
          (match[2] === "tree" && match[1] === "040000") ||
          (match[2] === "commit" && match[1] === "160000");
        if (!allowedMode) {
          fail(
            "SEALED_GIT_TREE_OUTPUT_INVALID",
            "Tree-entry mode and type are not one canonical Git pairing",
            { mode: match[1], type: match[2], path: relativePath },
          );
        }
        return Object.freeze({
          mode: match[1],
          type: match[2],
          objectId: match[3],
          path: relativePath,
        });
      });
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].path >= entries[index].path) {
        fail(
          "SEALED_GIT_TREE_OUTPUT_INVALID",
          "Tree-entry output is duplicated or non-canonical",
        );
      }
    }
    return Object.freeze(entries);
  }

  function objectAtPath(request) {
    request = requireRequest(
      request,
      ["commit", "path"],
      "objectAtPath",
    );
    const relativePath = requireRepositoryPath(request.path);
    const commit = exactCommitObject(
      request.commit,
      "tree-entry commit",
    );
    const entries = objectsAtPaths({
      commit,
      paths: [relativePath],
    });
    if (entries.length === 0) {
      fail(
        "SEALED_GIT_PATH_MISSING",
        "Exact path is absent from the immutable Git tree",
        { commit, relativePath },
      );
    }
    if (entries.length !== 1 || entries[0].path !== relativePath) {
      fail(
        "SEALED_GIT_OBJECT_AT_PATH_INVALID",
        "Exact path did not resolve to exactly one Git object",
        { relativePath, observed: entries.length },
      );
    }
    return entries[0];
  }

  function blobsAtPaths(request) {
    request = requireRequest(
      request,
      ["commit", "maximumTotalBytes", "paths"],
      "blobsAtPaths",
    );
    const paths = requireRepositoryPaths(request.paths);
    const maximumTotalBytes = requirePositiveInteger(
      request.maximumTotalBytes,
      "blob collection maximumTotalBytes",
      maxStdoutBytes,
    );
    const commit = exactCommitObject(
      request.commit,
      "blob collection commit",
    );
    const entries = objectsAtPaths({ commit, paths });
    if (
      entries.length !== paths.length ||
      entries.some(
        (entry, index) =>
          entry.path !== paths[index] || entry.type !== "blob",
      )
    ) {
      fail(
        "SEALED_GIT_BLOBS_AT_PATHS_INVALID",
        "Blob collection did not resolve every exact requested path",
        { requested: paths.length, observed: entries.length },
      );
    }
    let totalBytes = 0;
    const blobs = entries.map((entry) => {
      const bytes = readBlob(
        entry,
        maximumTotalBytes - totalBytes,
        "blobs-at-paths",
      );
      totalBytes += bytes.length;
      return Object.freeze({ ...entry, bytes });
    });
    return Object.freeze(blobs);
  }

  function batchBlobsAtPaths(request) {
    request = requireRequest(
      request,
      ["commit", "maximumTotalBytes", "paths"],
      "batchBlobsAtPaths",
    );
    const paths = requireRepositoryPaths(request.paths);
    const maximumTotalBytes = requirePositiveInteger(
      request.maximumTotalBytes,
      "batch blob collection maximumTotalBytes",
      maxStdoutBytes,
    );
    const commit = exactCommitObject(
      request.commit,
      "batch blob collection commit",
    );
    const entries = objectsAtPaths({ commit, paths });
    if (
      entries.length !== paths.length ||
      entries.some(
        (entry, index) =>
          entry.path !== paths[index] || entry.type !== "blob",
      )
    ) {
      fail(
        "SEALED_GIT_BATCH_BLOBS_AT_PATHS_INVALID",
        "Batch blob collection did not resolve every exact requested path",
        { requested: paths.length, observed: entries.length },
      );
    }
    const framingAllowance = entries.length * 96;
    const maximumBatchOutputBytes =
      maximumTotalBytes + framingAllowance;
    if (
      !Number.isSafeInteger(maximumBatchOutputBytes) ||
      maximumBatchOutputBytes > maxStdoutBytes
    ) {
      fail(
        "SEALED_GIT_OUTPUT_LIMIT",
        "Batch blob framing exceeds the sealed stdout allowance",
        {
          maximumTotalBytes,
          framingAllowance,
          maximumStdoutBytes: maxStdoutBytes,
        },
      );
    }
    const input = Buffer.from(
      `${entries.map((entry) => entry.objectId).join("\n")}\n`,
      "ascii",
    );
    if (input.length !== entries.length * 41) {
      fail(
        "SEALED_GIT_BATCH_INPUT_INVALID",
        "Batch blob request framing is not canonical",
      );
    }
    const output = execute(
      "batch-blobs-at-paths",
      ["cat-file", "--batch"],
      {
        maximumStdoutBytes: maximumBatchOutputBytes,
        input,
      },
    ).stdout;
    const blobs = [];
    let offset = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < 0) {
        fail(
          "SEALED_GIT_BATCH_OUTPUT_INVALID",
          "Batch blob output ended before its next header",
          { path: entry.path },
        );
      }
      const headerBytes = output.subarray(offset, newline);
      const header = headerBytes.toString("ascii");
      if (!Buffer.from(header, "ascii").equals(headerBytes)) {
        fail(
          "SEALED_GIT_BATCH_OUTPUT_INVALID",
          "Batch blob header is not canonical ASCII",
          { path: entry.path },
        );
      }
      const match = header.match(
        /^([a-f0-9]{40}) blob (0|[1-9][0-9]{0,15})$/u,
      );
      if (!match || match[1] !== entry.objectId) {
        fail(
          "SEALED_GIT_BATCH_OUTPUT_INVALID",
          "Batch blob header changed object identity or type",
          { path: entry.path },
        );
      }
      const byteLength = Number(match[2]);
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        byteLength > maximumTotalBytes - totalBytes
      ) {
        fail(
          "SEALED_GIT_OUTPUT_LIMIT",
          "Batch blob bytes exceed the caller-declared total allowance",
          {
            path: entry.path,
            byteLength,
            totalBytes,
            maximumTotalBytes,
          },
        );
      }
      const contentStart = newline + 1;
      const contentEnd = contentStart + byteLength;
      if (
        contentEnd >= output.length ||
        output[contentEnd] !== 0x0a
      ) {
        fail(
          "SEALED_GIT_BATCH_OUTPUT_INVALID",
          "Batch blob content framing is truncated or ambiguous",
          { path: entry.path, byteLength },
        );
      }
      const bytes = Buffer.from(output.subarray(contentStart, contentEnd));
      const readBackObjectId = gitBlobObjectId(bytes);
      if (readBackObjectId !== entry.objectId) { // SEALED_GIT_CRITICAL_ANCHOR_BATCH_IDENTITY
        fail(
          "SEALED_GIT_BATCH_OBJECT_CHANGED",
          "Batch blob bytes do not reproduce their exact Git object identity",
          {
            path: entry.path,
            expectedObjectId: entry.objectId,
            readBackObjectId,
          },
        );
      }
      totalBytes += byteLength;
      blobs.push(Object.freeze({ ...entry, bytes }));
      offset = contentEnd + 1;
    }
    if (offset !== output.length) {
      fail(
        "SEALED_GIT_BATCH_OUTPUT_INVALID",
        "Batch blob output contains trailing or duplicate evidence",
        { expectedBytes: offset, actualBytes: output.length },
      );
    }
    return Object.freeze(blobs);
  }

  function diff(request) {
    request = requireRequest(
      request,
      ["format", "from", "to"],
      "diff",
    );
    const from = exactCommitObject(request.from, "diff from");
    const to = exactCommitObject(request.to, "diff to");
    if (
      request.format !== "name-status-z" &&
      request.format !== "name-status-z-renames" &&
      request.format !== "binary"
    ) {
      fail(
        "SEALED_GIT_DIFF_FORMAT_INVALID",
        "Diff format must be name-status-z, name-status-z-renames, or binary",
      );
    }
    let formatArgs;
    let renameArgs;
    if (request.format === "binary") {
      formatArgs = ["--binary", "--full-index"];
      renameArgs = ["--no-renames"];
    } else {
      formatArgs = ["--name-status", "-z"];
      renameArgs =
        request.format === "name-status-z-renames"
          ? ["--find-renames"]
          : ["--no-renames"];
    }
    return Buffer.from(
      execute(
        "diff",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--ignore-submodules=none",
          ...renameArgs,
          ...formatArgs,
          from,
          to,
          "--",
        ],
      ).stdout,
    );
  }

  function workingDiff(request) {
    request = requireRequest(request, ["base"], "workingDiff");
    const base = exactCommitObject(request.base, "working diff base");
    return Buffer.from(
      execute(
        "working-diff",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--ignore-submodules=none",
          "--no-renames",
          "--binary",
          "--full-index",
          base,
          "--",
        ],
      ).stdout,
    );
  }

  function indexDiff(request) {
    request = requireRequest(request, ["base"], "indexDiff");
    const base = exactCommitObject(request.base, "index diff base");
    return Buffer.from(
      execute(
        "index-diff",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--ignore-submodules=none",
          "--no-renames",
          "--binary",
          "--full-index",
          "--cached",
          base,
          "--",
        ],
      ).stdout,
    );
  }

  function localTrackingRef(request) {
    request = requireRequest(request, ["ref"], "localTrackingRef");
    const ref = requireLocalTrackingRef(request.ref);
    const value = text(
      "local-tracking-ref",
      ["rev-parse", "--verify", `${ref}^{commit}`],
      { maximumStdoutBytes: 128 },
    );
    return exactCommitObject(value, "local tracking commit");
  }

  function worktrees() {
    requireNoArguments(arguments, "worktrees");
    const bytes = execute(
      "worktrees",
      ["worktree", "list", "--porcelain", "-z"],
    ).stdout;
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) {
      fail(
        "SEALED_GIT_WORKTREE_OUTPUT_INVALID",
        "Worktree output is not canonical UTF-8",
      );
    }
    const records = value
      .split("\0\0")
      .filter(Boolean)
      .map((record, recordIndex) => {
        const fields = record.split("\0");
        if (!fields[0]?.startsWith("worktree ")) {
          fail(
            "SEALED_GIT_WORKTREE_OUTPUT_INVALID",
            "Worktree record lacks its exact path header",
          );
        }
        const reportedWorktreePath =
          fields[0].slice("worktree ".length);
        const worktreePath =
          recordIndex === 0
            ? primaryWorktreeRoot
            : reportedWorktreePath;
        if (
          reportedWorktreePath.length === 0 ||
          reportedWorktreePath.length > 4096 ||
          !path.isAbsolute(reportedWorktreePath) ||
          path.normalize(reportedWorktreePath) !== reportedWorktreePath
        ) {
          fail(
            "SEALED_GIT_WORKTREE_OUTPUT_INVALID",
            "Worktree path is not one normalized absolute path",
          );
        }
        const entry = {
          path: worktreePath,
          head: null,
          branch: null,
          detached: false,
          bare: false,
          locked: null,
          prunable: null,
        };
        for (const field of fields.slice(1)) {
          if (field.startsWith("HEAD ") && entry.head === null) {
            entry.head = requireCommit(field.slice(5), "worktree HEAD");
          } else if (
            field.startsWith("branch refs/heads/") &&
            entry.branch === null
          ) {
            entry.branch = field.slice("branch ".length);
          } else if (field === "detached" && entry.detached === false) {
            entry.detached = true;
          } else if (field === "bare" && entry.bare === false) {
            entry.bare = true;
          } else if (field.startsWith("locked") && entry.locked === null) {
            entry.locked = field.slice("locked".length).trim() || true;
          } else if (
            field.startsWith("prunable") &&
            entry.prunable === null
          ) {
            entry.prunable =
              field.slice("prunable".length).trim() || true;
          } else {
            fail(
              "SEALED_GIT_WORKTREE_OUTPUT_INVALID",
              "Worktree record contains duplicate or unknown fields",
            );
          }
        }
        if (entry.head === null || (entry.branch === null) === !entry.detached) {
          fail(
            "SEALED_GIT_WORKTREE_OUTPUT_INVALID",
            "Worktree record lacks one exact branch or detached identity",
          );
        }
        return Object.freeze(entry);
      });
    return Object.freeze(records);
  }

  function remoteReadback(request) {
    request = requireRequest(
      request,
      ["ref", "url"],
      "remoteReadback",
    );
    const url = requireHttpsRemote(request.url);
    const ref = requireRemoteRef(request.ref);
    const output = text(
      "remote-readback",
      ["ls-remote", "--exit-code", "--refs", "--heads", url, ref],
      { maximumStdoutBytes: 1024, remote: true },
    );
    const match = output.match(/^([a-f0-9]{40})\t([^\r\n]+)$/u);
    if (!match || match[2] !== ref) {
      fail(
        "SEALED_GIT_REMOTE_OUTPUT_INVALID",
        "Remote read-back did not return exactly one matching branch",
      );
    }
    return match[1];
  }

  return Object.freeze({
    repoRoot: repository.root,
    gitPath: TRUSTED_GIT,
    repositoryIdentitySha256: repositoryIdentitySha256(repository),
    head: inSnapshotScope(head),
    branch: inSnapshotScope(branch),
    commit: inSnapshotScope(commit),
    tree: inSnapshotScope(tree),
    status: inSnapshotScope(status),
    parent: inSnapshotScope(parent),
    history: inSnapshotScope(history),
    commitCount: inSnapshotScope(commitCount),
    isAncestor: inSnapshotScope(isAncestor),
    show: inSnapshotScope(show),
    objectAtPath: inSnapshotScope(objectAtPath),
    objectsAtPaths: inSnapshotScope(objectsAtPaths),
    blobsAtPaths: inSnapshotScope(blobsAtPaths),
    batchBlobsAtPaths: inSnapshotScope(batchBlobsAtPaths),
    diff: inSnapshotScope(diff),
    workingDiff: inSnapshotScope(workingDiff),
    indexDiff: inSnapshotScope(indexDiff),
    localTrackingRef: inSnapshotScope(localTrackingRef),
    worktrees: inSnapshotScope(worktrees),
    remoteReadback: inSnapshotScope(remoteReadback),
  });
}

module.exports = Object.freeze({
  SealedGitError,
  SEALED_ENVIRONMENT,
  createSealedGit,
  resolveTrustedGitExecutable,
});

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STORE_SCHEMA = "pikiio-proof-store-v1";
const GENESIS_SCHEMA = "pikiio-proof-store-genesis-v1";
const LAYOUT_SCHEMA = "pikiio-proof-store-layout-v1";
const BLOB_REFERENCE_SCHEMA = "pikiio-proof-blob-reference-v1";
const ARCHIVE_ROOT_SCHEMA = "pikiio-external-proof-archive-v1";
const IMPORT_INDEX_SCHEMA = "pikiio-proof-import-index-v1";
const OFFLINE_MATERIALIZATION_SCHEMA =
  "pikiio-proof-offline-materialization-v1";

const CANONICAL_RELATIVE_COMPONENTS = Object.freeze([
  ".codex",
  "runtime",
  "pikiio-agent",
  "proof-store-v1",
]);
const OBJECT_DIRECTORY_COMPONENTS = Object.freeze(["objects", "sha256"]);
const IMPORT_DIRECTORY_COMPONENTS = Object.freeze(["indexes", "import"]);

const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RAW_ARTIFACTS = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_PATTERN = /^(?:GOV|TRUTH|ACTION)-[0-9]{2}$/;
const DIGIT_STRING_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MEDIA_TYPE_PATTERN =
  /^(?:application|text)\/[a-z0-9][a-z0-9.+-]{0,126}$/;
const SCHEMA_PATTERN = /^[a-z][a-z0-9-]{0,126}$/;
const PUBLICATION_WAIT_MILLISECONDS = 5_000;
const PUBLICATION_POLL_MILLISECONDS = 2;
const PUBLICATION_WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));
const GENESIS_MAXIMUM_BYTES = 64 * 1024;

const ARCHIVE_ROLE_TABLE = deepFreeze({
  request: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-request-v3",
  },
  materialization: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-materialization-v3",
  },
  macosJudge: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-platform-receipt-v3",
  },
  macosAuthorityAttestation: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-macos-authority-v1",
  },
  primaryJudge: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-judge-v3",
  },
  independentJudge: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-judge-v3",
  },
  verdict: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-verdict-v3",
  },
  certification: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-certification-v3",
  },
  externalPackage: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-package-v3",
  },
  evidenceManifest: {
    mediaType: "application/json",
    payloadSchema: null,
  },
  trustedAuthority: {
    mediaType: "application/json",
    payloadSchema: null,
  },
  jwksRegistry: {
    mediaType: "application/json",
    payloadSchema: "pikiio-github-oidc-jwks-registry-v1",
  },
  toolchainProvenance: {
    mediaType: "application/json",
    payloadSchema: "pikiio-proof-v3-toolchain-provenance-v1",
  },
  sourceManifest: {
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-source-manifest-v3",
  },
  authorityWorkflow: {
    mediaType: "text/plain",
    payloadSchema: null,
  },
  requestWorkflow: {
    mediaType: "text/plain",
    payloadSchema: null,
  },
  externalVerifierSource: {
    mediaType: "application/javascript",
    payloadSchema: null,
  },
  oidcVerifierSource: {
    mediaType: "application/javascript",
    payloadSchema: null,
  },
  phaseProofRegistry: {
    mediaType: "application/json",
    payloadSchema: "pikiio-phase-proof-registry-v1",
  },
  toolchainCommissioningReceipt: {
    mediaType: "application/json",
    payloadSchema: "pikiio-proof-v3-toolchain-commissioning-receipt-v1",
  },
  toolchainSbom: {
    mediaType: "application/json",
    payloadSchema: null,
  },
  toolchainDependencyManifest: {
    mediaType: "application/json",
    payloadSchema: null,
  },
  judgeDockerfile: {
    mediaType: "text/plain",
    payloadSchema: null,
  },
  childRunner: {
    mediaType: "application/javascript",
    payloadSchema: null,
  },
  packageLock: {
    mediaType: "application/json",
    payloadSchema: null,
  },
  authorityGitObjectProof: {
    mediaType: "application/octet-stream",
    payloadSchema: null,
  },
  packageManifest: {
    mediaType: "text/plain",
    payloadSchema: null,
  },
  transportArchive: {
    mediaType: "application/zip",
    payloadSchema: null,
  },
});

const ARCHIVE_ROLE_NAMES = Object.freeze(Object.keys(ARCHIVE_ROLE_TABLE));

const LAYOUT = deepFreeze({
  schema: LAYOUT_SCHEMA,
  revision: 1,
  objectAlgorithm: "sha256",
  objectFanoutCharacters: 2,
  objectDirectory: "objects/sha256",
  importIndexDirectory: "indexes/import",
  archiveRoleNames: ARCHIVE_ROLE_NAMES,
  archiveRoleTable: ARCHIVE_ROLE_TABLE,
  importIndexesAreContentAddressed: false,
  productionAuthority: false,
});

const GENESIS_KEYS = Object.freeze([
  "schema",
  "layoutSchema",
  "layoutSha256",
  "absoluteCanonicalPath",
  "hostname",
  "ownerUid",
  "device",
  "inode",
  "nonce",
  "createdAt",
]);
const BLOB_REFERENCE_KEYS = Object.freeze([
  "schema",
  "address",
  "byteLength",
  "mediaType",
  "payloadSchema",
]);
const ARCHIVE_KEYS = Object.freeze([
  "schema",
  "proofStoreIdentitySha256",
  "repository",
  "phaseId",
  "authorityCommit",
  "scopeBaseCommit",
  "candidateCommit",
  "requestNonce",
  "run",
  "roles",
  "rawArtifacts",
  "bindings",
  "transport",
  "productionAuthority",
]);
const RUN_KEYS = Object.freeze(["runId", "runAttempt"]);
const BINDING_KEYS = Object.freeze([
  "externalPackageHash",
  "certificationHash",
  "attestationBodySha256",
  "qualityVerdictHash",
  "evidenceManifestSha256",
  "rawArtifactSetSha256",
  "replayKeySha256",
  "trustedAuthoritySha256",
  "jwksRegistrySha256",
  "toolchainSha256",
  "authorityPolicySha256",
]);
const TRANSPORT_KEYS = Object.freeze([
  "artifactId",
  "artifactDigest",
  "runId",
  "runAttempt",
]);
const IMPORT_INDEX_KEYS = Object.freeze([
  "schema",
  "importKeySha256",
  "proofStoreIdentitySha256",
  "archiveRootObjectSha256",
  "externalPackageHash",
  "certificationHash",
  "productionAuthority",
  "builderAuthority",
]);
const EXTERNAL_EVIDENCE_REFERENCE_KEYS = Object.freeze([
  "address",
  "sha256",
  "byteLength",
]);

const STORE_STATE = new WeakMap();
const FOUNDATION_WRITER_CAPABILITY = Object.freeze({
  kind: "proof_store_foundation_writer",
});
const READ_ONLY_CAPABILITY = Object.freeze({
  kind: "proof_store_read_only",
});
const STORE_HANDLE_FINALIZER = new FinalizationRegistry((descriptor) => {
  try {
    fs.closeSync(descriptor);
  } catch {
    // The descriptor is an internal identity anchor. Finalization is best-effort.
  }
});

class ProofStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProofStoreError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProofStoreError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, keys, label) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`);
  }
}

function stableJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("NON_CANONICAL_JSON", "JSON number is not canonical");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || seen.has(value)) {
    fail("NON_CANONICAL_JSON", "value is not canonical JSON");
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => stableJson(entry, seen)).join(",")}]`;
  } else {
    if (!isPlainObject(value)) {
      fail("NON_CANONICAL_JSON", "only plain JSON objects are accepted");
    }
    result = `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(value[key], seen)}`,
      )
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function canonicalJsonBytes(value, maximumBytes = MAX_JSON_BYTES) {
  const bytes = Buffer.from(`${stableJson(value)}\n`, "utf8");
  if (bytes.length < 2 || bytes.length > maximumBytes) {
    fail("JSON_SIZE_INVALID", "canonical JSON bytes exceed their bound");
  }
  return bytes;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const LAYOUT_SHA256 = sha256(canonicalJsonBytes(LAYOUT));

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_SHA256", `${label} must be lowercase SHA-256`);
  }
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    fail("INVALID_COMMIT", `${label} must be one full Git commit`);
  }
}

function requireCanonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("INVALID_TIMESTAMP", `${label} must be a canonical ISO timestamp`);
  }
}

function requireAbsoluteCanonicalPath(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    fail("INVALID_PATH", `${label} must be an absolute normalized path`);
  }
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function publicationStageName(target, pid, nonce) {
  return `.${path.basename(target)}.publish-stage.${pid}.${nonce}.tmp`;
}

function parsePublicationStageName(target, name) {
  const prefix = `.${path.basename(target)}.publish-stage.`;
  const suffix = ".tmp";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const identity = name.slice(prefix.length, -suffix.length);
  const separator = identity.indexOf(".");
  if (separator < 1 || identity.indexOf(".", separator + 1) !== -1) return null;
  const pid = identity.slice(0, separator);
  const nonce = identity.slice(separator + 1);
  if (
    !/^[1-9][0-9]{0,19}$/.test(pid) ||
    !Number.isSafeInteger(Number(pid)) ||
    !UUID_PATTERN.test(nonce)
  ) {
    return null;
  }
  return Object.freeze({
    name,
    pid: Number(pid),
    nonce,
  });
}

function lstatIfPresent(filePath, label) {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("FILE_UNREADABLE", `${label} cannot be inspected`, {
      cause: error.code || error.message,
    });
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    fail("PUBLICATION_PROCESS_CHECK_FAILED", "publisher cannot be inspected", {
      cause: error.code || error.message,
    });
  }
}

function matchingPublicationStage(target, targetStat, label) {
  const directory = path.dirname(target);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    fail("DIRECTORY_UNREADABLE", `${label} parent cannot be enumerated`, {
      cause: error.code || error.message,
    });
  }
  const matches = [];
  for (const name of names) {
    const identity = parsePublicationStageName(target, name);
    if (identity === null) continue;
    const candidatePath = path.join(directory, name);
    const candidateStat = lstatIfPresent(candidatePath, `${label} stage`);
    if (
      candidateStat === null ||
      candidateStat.dev !== targetStat.dev ||
      candidateStat.ino !== targetStat.ino
    ) {
      continue;
    }
    if (
      !candidateStat.isFile() ||
      candidateStat.isSymbolicLink() ||
      candidateStat.nlink !== 2n ||
      (candidateStat.mode & 0o777n) !== 0o400n ||
      (typeof process.getuid === "function" &&
        candidateStat.uid !== BigInt(process.getuid())) ||
      !sameStat(targetStat, candidateStat)
    ) {
      fail(
        "FILE_IDENTITY_INVALID",
        `${label} publication stage identity is invalid`,
      );
    }
    matches.push({
      ...identity,
      path: candidatePath,
      stat: candidateStat,
    });
  }
  return matches[0] || null;
}

/*
 * Immutable publication crash contract:
 * - Before link(2), a crash can leave only an unreferenced nlink=1 stage. It is
 *   never treated as stored truth and cannot authorize anything.
 * - Between no-clobber link(2) and stage cleanup, target and the strictly named
 *   owner-only stage are the same nlink=2 inode. Readers never accept that
 *   state: they wait only for its live PID, or require recovery if it is dead.
 * - A writer may recover a dead publisher only by revalidating both directory
 *   entries as the unchanged same inode and unlinking the stage. The target is
 *   then read and byte-verified normally. Unrecognized hardlinks are never
 *   removed, retried, or accepted.
 * - After stage cleanup, the nlink=1 target is the sole published object.
 */
function settleImmutablePublication(target, {
  label,
  allowRecovery = false,
} = {}) {
  const directory = path.dirname(target);
  validateOwnerDirectory(directory, `${label} parent`);
  const deadline = Date.now() + PUBLICATION_WAIT_MILLISECONDS;
  while (true) {
    const targetStat = lstatIfPresent(target, label);
    if (targetStat === null || targetStat.nlink === 1n) return;
    if (
      !targetStat.isFile() ||
      targetStat.isSymbolicLink() ||
      targetStat.nlink !== 2n ||
      (targetStat.mode & 0o777n) !== 0o400n ||
      (typeof process.getuid === "function" &&
        targetStat.uid !== BigInt(process.getuid()))
    ) {
      fail("FILE_IDENTITY_INVALID", `${label} link identity is invalid`);
    }
    const stage = matchingPublicationStage(target, targetStat, label);
    if (stage === null) {
      const current = lstatIfPresent(target, label);
      if (current !== null && current.nlink === 1n) continue;
      fail(
        "FILE_IDENTITY_INVALID",
        `${label} has an unrecognized persistent hardlink`,
      );
    }
    if (!processIsAlive(stage.pid)) {
      if (!allowRecovery) {
        fail(
          "PUBLICATION_RECOVERY_REQUIRED",
          `${label} has a crash-interrupted publication`,
        );
      }
      const targetAgain = lstatIfPresent(target, label);
      const stageAgain = lstatIfPresent(stage.path, `${label} stage`);
      if (
        targetAgain === null ||
        stageAgain === null ||
        !sameStat(targetStat, targetAgain) ||
        !sameStat(targetStat, stageAgain)
      ) {
        fail(
          "FILE_IDENTITY_INVALID",
          `${label} crash recovery identity changed`,
        );
      }
      try {
        fs.unlinkSync(stage.path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        fail("PUBLICATION_RECOVERY_FAILED", `${label} stage cannot be removed`, {
          cause: error.code || error.message,
        });
      }
      fsyncDirectory(directory);
      continue;
    }
    if (Date.now() >= deadline) {
      fail(
        "PUBLICATION_BUSY",
        `${label} publication did not settle within its bound`,
      );
    }
    Atomics.wait(
      PUBLICATION_WAIT_WORD,
      0,
      0,
      PUBLICATION_POLL_MILLISECONDS,
    );
  }
}

function validateUnchangedDirectory(directory, expected, label) {
  const current = validateOwnerDirectory(directory, label);
  if (!sameDirectoryIdentity(expected, current)) {
    fail("ROOT_CHANGED", `${label} changed during initialization`);
  }
  return current;
}

/*
 * Genesis is the only immutable file whose parent must initially contain
 * nothing else. A sealed nlink=1 publication stage is not genesis and is never
 * read or adopted. A live publisher gets one bounded opportunity to finish. A
 * writer may remove one dead publisher's exact, unchanged, owner-only stage,
 * but only while the root is still the same directory and the stage remains
 * the sole entry. Every ambiguous preimage is left byte-for-byte untouched.
 */
function settleGenesisPreimage(root, expectedRootStat) {
  const target = storePaths(root).genesis;
  const targetName = path.basename(target);
  const deadline = Date.now() + PUBLICATION_WAIT_MILLISECONDS;
  while (true) {
    validateUnchangedDirectory(
      root,
      expectedRootStat,
      "proof-store root",
    );
    settleImmutablePublication(target, {
      label: "proof-store genesis",
      allowRecovery: true,
    });
    if (lstatIfPresent(target, "proof-store genesis") !== null) {
      return "published";
    }

    let entries;
    try {
      entries = fs.readdirSync(root).sort();
    } catch (error) {
      fail("DIRECTORY_UNREADABLE", "proof-store root cannot be enumerated", {
        cause: error.code || error.message,
      });
    }
    if (entries.includes(targetName)) continue;
    if (entries.length === 0) return "empty";
    if (entries.length !== 1) {
      fail(
        "GENESIS_PREIMAGE_NOT_EMPTY",
        "new proof-store root has an ambiguous genesis preimage",
      );
    }

    const identity = parsePublicationStageName(target, entries[0]);
    if (identity === null) {
      fail(
        "GENESIS_PREIMAGE_NOT_EMPTY",
        "new proof-store root must be empty",
      );
    }
    const stagePath = path.join(root, identity.name);
    const stageStat = lstatIfPresent(stagePath, "proof-store genesis stage");
    if (
      stageStat === null ||
      !stageStat.isFile() ||
      stageStat.isSymbolicLink() ||
      stageStat.nlink !== 1n ||
      (stageStat.mode & 0o777n) !== 0o400n ||
      (typeof process.getuid === "function" &&
        stageStat.uid !== BigInt(process.getuid())) ||
      stageStat.size < 1n ||
      stageStat.size > BigInt(GENESIS_MAXIMUM_BYTES)
    ) {
      fail(
        "GENESIS_PREIMAGE_NOT_EMPTY",
        "genesis publication stage identity is invalid",
      );
    }

    if (processIsAlive(identity.pid)) {
      if (Date.now() >= deadline) {
        fail(
          "PUBLICATION_BUSY",
          "proof-store genesis publication did not settle within its bound",
        );
      }
      Atomics.wait(
        PUBLICATION_WAIT_WORD,
        0,
        0,
        PUBLICATION_POLL_MILLISECONDS,
      );
      continue;
    }

    validateUnchangedDirectory(
      root,
      expectedRootStat,
      "proof-store root",
    );
    if (lstatIfPresent(target, "proof-store genesis") !== null) continue;
    let entriesAgain;
    try {
      entriesAgain = fs.readdirSync(root).sort();
    } catch (error) {
      fail("DIRECTORY_UNREADABLE", "proof-store root cannot be enumerated", {
        cause: error.code || error.message,
      });
    }
    const stageAgain = lstatIfPresent(
      stagePath,
      "proof-store genesis stage",
    );
    if (
      entriesAgain.length !== 1 ||
      entriesAgain[0] !== identity.name ||
      stageAgain === null ||
      !sameStat(stageStat, stageAgain) ||
      processIsAlive(identity.pid)
    ) {
      fail(
        "GENESIS_PREIMAGE_NOT_EMPTY",
        "genesis crash recovery identity changed",
      );
    }
    try {
      fs.unlinkSync(stagePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      fail(
        "PUBLICATION_RECOVERY_FAILED",
        "proof-store genesis stage cannot be removed",
        { cause: error.code || error.message },
      );
    }
    fsyncDirectory(root);
  }
}

function validateOwnerDirectory(directory, label) {
  requireAbsoluteCanonicalPath(directory, label);
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    fail("DIRECTORY_UNREADABLE", `${label} cannot be read`, {
      cause: error.code || error.message,
    });
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    fail(
      "DIRECTORY_IDENTITY_INVALID",
      `${label} must be an owner-only real directory`,
    );
  }
  let real;
  try {
    real = fs.realpathSync(directory);
  } catch (error) {
    fail("DIRECTORY_UNREADABLE", `${label} cannot be resolved`, {
      cause: error.code || error.message,
    });
  }
  if (real !== directory) {
    fail("DIRECTORY_ALIAS_REFUSED", `${label} cannot be an alias`);
  }
  return stat;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readOwnerFile(filePath, {
  maximumBytes = MAX_BLOB_BYTES,
  label = "proof-store file",
} = {}) {
  requireAbsoluteCanonicalPath(filePath, label);
  const parent = path.dirname(filePath);
  validateOwnerDirectory(parent, `${label} parent`);
  settleImmutablePublication(filePath, { label });
  const parentBefore = validateOwnerDirectory(parent, `${label} parent`);
  let before;
  let descriptor = null;
  try {
    before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o400n ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid())) ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      fail(
        "FILE_IDENTITY_INVALID",
        `${label} must be a bounded immutable owner file`,
      );
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, opened)) {
      fail("FILE_CHANGED", `${label} changed while opening`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(opened, after) || bytes.length !== Number(opened.size)) {
      fail("FILE_CHANGED", `${label} changed while reading`);
    }
    const parentAfter = validateOwnerDirectory(parent, `${label} parent`);
    if (!sameDirectoryIdentity(parentBefore, parentAfter)) {
      fail("DIRECTORY_CHANGED", `${label} parent changed while reading`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ProofStoreError) throw error;
    fail("FILE_UNREADABLE", `${label} cannot be read`, {
      cause: error.code || error.message,
    });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writeImmutableFile(target, bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) {
    fail("INVALID_BYTES", `${label} bytes are invalid`);
  }
  const directory = path.dirname(target);
  validateOwnerDirectory(directory, `${label} parent`);
  settleImmutablePublication(target, { label, allowRecovery: true });
  const temporary = path.join(
    directory,
    publicationStageName(target, process.pid, crypto.randomUUID()),
  );
  let descriptor = null;
  let linked = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o400);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, target);
      linked = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fsyncDirectory(directory);
  return linked;
}

function parseCanonicalJson(bytes, label, maximumBytes = MAX_JSON_BYTES) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 2 ||
    bytes.length > maximumBytes
  ) {
    fail("JSON_SIZE_INVALID", `${label} JSON bytes exceed their bound`);
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail("INVALID_JSON", `${label} is not UTF-8 JSON`, {
      cause: error.message,
    });
  }
  if (!bytes.equals(canonicalJsonBytes(value, maximumBytes))) {
    fail("NON_CANONICAL_JSON_BYTES", `${label} is not canonical JSON bytes`);
  }
  return value;
}

function canonicalProofStoreRoot() {
  const userHome = os.userInfo().homedir;
  requireAbsoluteCanonicalPath(userHome, "account home");
  const realHome = fs.realpathSync(userHome);
  if (realHome !== userHome) {
    fail("ACCOUNT_HOME_ALIAS_REFUSED", "account home cannot be an alias");
  }
  return path.join(realHome, ...CANONICAL_RELATIVE_COMPONENTS);
}

function stateFor(store) {
  const state = STORE_STATE.get(store);
  if (!state) {
    fail("INVALID_STORE_HANDLE", "proof-store handle is not authentic");
  }
  return state;
}

function validateBoundRoot(state) {
  let descriptorStat;
  try {
    descriptorStat = fs.fstatSync(state.rootDescriptor, { bigint: true });
  } catch (error) {
    fail("ROOT_HANDLE_INVALID", "proof-store root handle cannot be inspected", {
      cause: error.code || error.message,
    });
  }
  const pathStat = validateOwnerDirectory(state.root, "proof-store root");
  if (
    !descriptorStat.isDirectory() ||
    descriptorStat.isSymbolicLink() ||
    !sameDirectoryIdentity(state.rootStat, descriptorStat) ||
    !sameDirectoryIdentity(state.rootStat, pathStat)
  ) {
    fail(
      "ROOT_CHANGED",
      "proof-store root no longer matches its open handle",
    );
  }
  return Object.freeze({ descriptorStat, pathStat });
}

function validateRootForState(state) {
  validateBoundRoot(state);
  const validated = validateRoot(state.root);
  validateBoundRoot(state);
  if (
    validated.identitySha256 !== state.identitySha256 ||
    !sameDirectoryIdentity(validated.rootStat, state.rootStat)
  ) {
    fail("ROOT_CHANGED", "proof-store identity changed after handle creation");
  }
  return validated;
}

function writerStateFor(store) {
  const state = stateFor(store);
  if (state.capability !== FOUNDATION_WRITER_CAPABILITY) {
    fail(
      "PROOF_STORE_READ_ONLY",
      "read-only proof-store handles categorically refuse mutation and recovery",
    );
  }
  return state;
}

function makeStoreHandle(root, mode, capability, binding) {
  const store = Object.freeze({
    schema: STORE_SCHEMA,
    mode,
    builderAuthority: false,
    productionAuthority: false,
  });
  STORE_STATE.set(
    store,
    Object.freeze({
      root,
      mode,
      capability,
      rootDescriptor: binding.rootDescriptor,
      rootStat: binding.rootStat,
      identitySha256: binding.identitySha256,
    }),
  );
  STORE_HANDLE_FINALIZER.register(store, binding.rootDescriptor);
  return store;
}

function storePaths(root) {
  return {
    genesis: path.join(root, "genesis.json"),
    objects: path.join(root, ...OBJECT_DIRECTORY_COMPONENTS),
    imports: path.join(root, ...IMPORT_DIRECTORY_COMPONENTS),
  };
}

function createOwnerDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  validateOwnerDirectory(directory, "proof-store directory");
  fsyncDirectory(path.dirname(directory));
}

function initializeRoot(root) {
  requireAbsoluteCanonicalPath(root, "proof-store root");
  const rootStat = validateOwnerDirectory(root, "proof-store root");
  const paths = storePaths(root);
  const preimage = settleGenesisPreimage(root, rootStat);
  if (preimage === "empty") {
    const genesis = {
      schema: GENESIS_SCHEMA,
      layoutSchema: LAYOUT_SCHEMA,
      layoutSha256: LAYOUT_SHA256,
      absoluteCanonicalPath: root,
      hostname: os.hostname(),
      ownerUid: rootStat.uid.toString(),
      device: rootStat.dev.toString(),
      inode: rootStat.ino.toString(),
      nonce: crypto.randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    writeImmutableFile(
      paths.genesis,
      canonicalJsonBytes(genesis),
      "proof-store genesis",
    );
  }
  validateGenesis(root);
  const objectsParent = path.dirname(paths.objects);
  const indexesParent = path.dirname(paths.imports);
  for (const directory of [
    objectsParent,
    paths.objects,
    indexesParent,
    paths.imports,
  ]) {
    if (!fs.existsSync(directory)) createOwnerDirectory(directory);
    else validateOwnerDirectory(directory, "proof-store layout directory");
  }
  validateRoot(root);
}

function validateGenesis(root) {
  const rootStat = validateOwnerDirectory(root, "proof-store root");
  const bytes = readOwnerFile(storePaths(root).genesis, {
    maximumBytes: 64 * 1024,
    label: "proof-store genesis",
  });
  const genesis = parseCanonicalJson(bytes, "proof-store genesis", 64 * 1024);
  requireExactKeys(genesis, GENESIS_KEYS, "proof-store genesis");
  if (
    genesis.schema !== GENESIS_SCHEMA ||
    genesis.layoutSchema !== LAYOUT_SCHEMA ||
    genesis.layoutSha256 !== LAYOUT_SHA256
  ) {
    fail("GENESIS_LAYOUT_MISMATCH", "proof-store genesis layout is invalid");
  }
  for (const [value, label] of [
    [genesis.ownerUid, "ownerUid"],
    [genesis.device, "device"],
    [genesis.inode, "inode"],
  ]) {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
      fail("GENESIS_IDENTITY_INVALID", `genesis ${label} is invalid`);
    }
  }
  if (
    genesis.absoluteCanonicalPath !== root ||
    genesis.hostname !== os.hostname() ||
    genesis.ownerUid !== rootStat.uid.toString() ||
    genesis.device !== rootStat.dev.toString() ||
    genesis.inode !== rootStat.ino.toString() ||
    typeof genesis.nonce !== "string" ||
    !SHA256_PATTERN.test(genesis.nonce)
  ) {
    fail(
      "GENESIS_IDENTITY_MISMATCH",
      "proof-store genesis does not match this root and host",
    );
  }
  requireCanonicalTimestamp(genesis.createdAt, "genesis.createdAt");
  return Object.freeze({
    genesis,
    bytes,
    identitySha256: sha256(bytes),
    rootStat,
  });
}

function validateRoot(root) {
  const before = validateGenesis(root);
  const paths = storePaths(root);
  for (const directory of [
    path.dirname(paths.objects),
    paths.objects,
    path.dirname(paths.imports),
    paths.imports,
  ]) {
    validateOwnerDirectory(directory, "proof-store layout directory");
  }
  const after = validateGenesis(root);
  if (
    before.identitySha256 !== after.identitySha256 ||
    before.rootStat.dev !== after.rootStat.dev ||
    before.rootStat.ino !== after.rootStat.ino
  ) {
    fail("ROOT_CHANGED", "proof-store root changed during validation");
  }
  return after;
}

function openHandle(root, mode, capability) {
  requireAbsoluteCanonicalPath(root, "proof-store root");
  const before = validateRoot(root);
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_DIRECTORY || 0),
    );
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const after = validateRoot(root);
    if (
      before.identitySha256 !== after.identitySha256 ||
      !sameDirectoryIdentity(before.rootStat, after.rootStat) ||
      !sameDirectoryIdentity(after.rootStat, descriptorStat)
    ) {
      fail("ROOT_CHANGED", "proof-store root changed while opening a handle");
    }
    const store = makeStoreHandle(root, mode, capability, {
      rootDescriptor: descriptor,
      rootStat: after.rootStat,
      identitySha256: after.identitySha256,
    });
    descriptor = null;
    return store;
  } catch (error) {
    if (error instanceof ProofStoreError) throw error;
    fail("ROOT_HANDLE_INVALID", "proof-store root handle cannot be opened", {
      cause: error.code || error.message,
    });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function initializeCanonicalProofStoreFoundation() {
  const root = canonicalProofStoreRoot();
  const parent = path.dirname(root);
  validateOwnerDirectory(parent, "canonical proof-store parent");
  if (!fs.existsSync(root)) createOwnerDirectory(root);
  initializeRoot(root);
  return openHandle(
    root,
    "canonical_foundation_writer_non_authorizing",
    FOUNDATION_WRITER_CAPABILITY,
  );
}

function openCanonicalProofStoreReadOnly() {
  return openHandle(
    canonicalProofStoreRoot(),
    "canonical_read_only_non_authorizing",
    READ_ONLY_CAPABILITY,
  );
}

function initializeIsolatedNonAuthorizingTestStore(root) {
  requireAbsoluteCanonicalPath(root, "isolated test proof-store root");
  initializeRoot(root);
  return openHandle(
    root,
    "isolated_test_foundation_writer_non_authorizing",
    FOUNDATION_WRITER_CAPABILITY,
  );
}

function openIsolatedNonAuthorizingTestStoreReadOnly(root) {
  requireAbsoluteCanonicalPath(root, "isolated test proof-store root");
  return openHandle(
    root,
    "isolated_test_read_only_non_authorizing",
    READ_ONLY_CAPABILITY,
  );
}

function proofStoreIdentitySha256(store) {
  const state = stateFor(store);
  return validateRootForState(state).identitySha256;
}

function describeProofStore(store) {
  const state = stateFor(store);
  return Object.freeze({
    schema: STORE_SCHEMA,
    mode: state.mode,
    proofStoreIdentitySha256: proofStoreIdentitySha256(store),
    builderAuthority: false,
    productionAuthority: false,
  });
}

function validateBlobReference(reference, label = "blob reference") {
  requireExactKeys(reference, BLOB_REFERENCE_KEYS, label);
  if (reference.schema !== BLOB_REFERENCE_SCHEMA) {
    fail("BLOB_REFERENCE_SCHEMA_INVALID", `${label} schema is invalid`);
  }
  if (
    typeof reference.address !== "string" ||
    !reference.address.startsWith("sha256:")
  ) {
    fail("BLOB_ADDRESS_INVALID", `${label} address is invalid`);
  }
  requireSha256(reference.address.slice(7), `${label} address`);
  if (
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 1 ||
    reference.byteLength > MAX_BLOB_BYTES
  ) {
    fail("BLOB_LENGTH_INVALID", `${label} byteLength is invalid`);
  }
  if (
    typeof reference.mediaType !== "string" ||
    !MEDIA_TYPE_PATTERN.test(reference.mediaType)
  ) {
    fail("BLOB_MEDIA_TYPE_INVALID", `${label} mediaType is invalid`);
  }
  if (
    reference.payloadSchema !== null &&
    (typeof reference.payloadSchema !== "string" ||
      !SCHEMA_PATTERN.test(reference.payloadSchema))
  ) {
    fail("BLOB_PAYLOAD_SCHEMA_INVALID", `${label} payloadSchema is invalid`);
  }
  return Object.freeze({ ...reference });
}

function blobObjectPath(root, digest) {
  requireSha256(digest, "blob digest");
  return path.join(
    storePaths(root).objects,
    digest.slice(0, 2),
    digest,
  );
}

function ensureFanout(root, digest) {
  const objects = storePaths(root).objects;
  const fanout = path.join(objects, digest.slice(0, 2));
  if (!fs.existsSync(fanout)) createOwnerDirectory(fanout);
  else validateOwnerDirectory(fanout, "proof-store object fanout");
  return fanout;
}

function storeBlob(store, input = {}) {
  const state = writerStateFor(store);
  const { root } = state;
  const {
    bytes,
    mediaType,
    payloadSchema = null,
    expectedSha256 = null,
  } = input || {};
  validateRootForState(state);
  if (
    !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > MAX_BLOB_BYTES
  ) {
    fail("INVALID_BYTES", "blob bytes are outside their bound");
  }
  const exactBytes = Buffer.from(bytes);
  const digest = sha256(exactBytes);
  if (expectedSha256 !== null) {
    requireSha256(expectedSha256, "expected blob SHA-256");
    if (expectedSha256 !== digest) {
      fail(
        "BYTE_ADDRESS_MISMATCH",
        "caller address does not equal the exact persisted byte digest",
      );
    }
  }
  const reference = validateBlobReference({
    schema: BLOB_REFERENCE_SCHEMA,
    address: `sha256:${digest}`,
    byteLength: exactBytes.length,
    mediaType,
    payloadSchema,
  });
  ensureFanout(root, digest);
  const target = blobObjectPath(root, digest);
  settleImmutablePublication(target, {
    label: "proof-store object",
    allowRecovery: true,
  });
  let created = false;
  if (fs.existsSync(target)) {
    const existing = readOwnerFile(target, {
      maximumBytes: MAX_BLOB_BYTES,
      label: "proof-store object",
    });
    if (!existing.equals(exactBytes)) {
      fail(
        "BYTE_CAS_COLLISION",
        "byte-CAS address contains different bytes",
      );
    }
  } else {
    created = writeImmutableFile(
      target,
      exactBytes,
      "proof-store object",
    );
  }
  const readBack = readOwnerFile(target, {
    maximumBytes: MAX_BLOB_BYTES,
    label: "proof-store object",
  });
  if (
    !readBack.equals(exactBytes) ||
    readBack.length !== reference.byteLength ||
    sha256(readBack) !== digest
  ) {
    fail("BYTE_CAS_READBACK_MISMATCH", "byte-CAS read-back is invalid");
  }
  validateRootForState(state);
  return Object.freeze({
    reference,
    created,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function readBlob(store, reference) {
  const state = stateFor(store);
  const { root } = state;
  const bounded = validateBlobReference(reference);
  validateRootForState(state);
  try {
    const digest = bounded.address.slice(7);
    const bytes = readOwnerFile(blobObjectPath(root, digest), {
      maximumBytes: MAX_BLOB_BYTES,
      label: "proof-store object",
    });
    if (bytes.length !== bounded.byteLength || sha256(bytes) !== digest) {
      fail(
        "BYTE_CAS_OBJECT_MISMATCH",
        "stored bytes do not match their reference",
      );
    }
    return Buffer.from(bytes);
  } finally {
    validateRootForState(state);
  }
}

function validateRoleReference(role, reference) {
  const policy = ARCHIVE_ROLE_TABLE[role];
  if (!policy) fail("ARCHIVE_ROLE_UNKNOWN", `archive role ${role} is unknown`);
  const bounded = validateBlobReference(reference, `archive role ${role}`);
  if (
    bounded.mediaType !== policy.mediaType ||
    bounded.payloadSchema !== policy.payloadSchema
  ) {
    fail(
      "ARCHIVE_ROLE_TYPE_MISMATCH",
      `archive role ${role} has the wrong media type or schema`,
    );
  }
  return bounded;
}

function validateExternalEvidenceManifest(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_RAW_ARTIFACTS
  ) {
    fail(
      "EVIDENCE_MANIFEST_INVALID",
      "evidence manifest cardinality is invalid",
    );
  }
  let previous = "";
  const values = [];
  for (const [index, reference] of value.entries()) {
    requireExactKeys(
      reference,
      EXTERNAL_EVIDENCE_REFERENCE_KEYS,
      `evidence manifest entry ${index}`,
    );
    requireSha256(reference.sha256, `evidence manifest entry ${index} sha256`);
    if (
      reference.address !== `sha256:${reference.sha256}` ||
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength < 1 ||
      reference.byteLength > MAX_BLOB_BYTES ||
      reference.address <= previous
    ) {
      fail(
        "EVIDENCE_MANIFEST_INVALID",
        "evidence manifest must be exact, sorted, and unique",
      );
    }
    previous = reference.address;
    values.push({ ...reference });
  }
  return values;
}

function externalReferenceProjection(reference) {
  const bounded = validateBlobReference(reference);
  return {
    address: bounded.address,
    sha256: bounded.address.slice(7),
    byteLength: bounded.byteLength,
  };
}

function rawArtifactSetSha256(rawArtifacts) {
  if (!Array.isArray(rawArtifacts)) {
    fail("RAW_ARTIFACT_SET_INVALID", "raw artifact set must be an array");
  }
  const projection = rawArtifacts.map(externalReferenceProjection);
  return sha256(Buffer.from(stableJson(projection), "utf8"));
}

function validateArchiveShape(manifest) {
  requireExactKeys(manifest, ARCHIVE_KEYS, "archive root");
  if (
    manifest.schema !== ARCHIVE_ROOT_SCHEMA ||
    manifest.repository !== "demo-maintainer/Pikiio-app-" ||
    manifest.productionAuthority !== false
  ) {
    fail("ARCHIVE_AUTHORITY_INVALID", "archive root identity is invalid");
  }
  requireSha256(
    manifest.proofStoreIdentitySha256,
    "archive proofStoreIdentitySha256",
  );
  if (
    typeof manifest.phaseId !== "string" ||
    !PHASE_PATTERN.test(manifest.phaseId)
  ) {
    fail("ARCHIVE_PHASE_INVALID", "archive phaseId is invalid");
  }
  requireCommit(manifest.authorityCommit, "archive authorityCommit");
  requireCommit(manifest.scopeBaseCommit, "archive scopeBaseCommit");
  requireCommit(manifest.candidateCommit, "archive candidateCommit");
  if (
    manifest.authorityCommit === manifest.scopeBaseCommit ||
    manifest.scopeBaseCommit === manifest.candidateCommit ||
    manifest.authorityCommit === manifest.candidateCommit
  ) {
    fail("ARCHIVE_COMMIT_ROLE_COLLISION", "archive A, S, and C must differ");
  }
  requireSha256(manifest.requestNonce, "archive requestNonce");
  requireExactKeys(manifest.run, RUN_KEYS, "archive run");
  for (const key of RUN_KEYS) {
    if (
      typeof manifest.run[key] !== "string" ||
      !DIGIT_STRING_PATTERN.test(manifest.run[key])
    ) {
      fail("ARCHIVE_RUN_INVALID", `archive run.${key} is invalid`);
    }
  }
  requireExactKeys(manifest.roles, ARCHIVE_ROLE_NAMES, "archive roles");
  for (const role of ARCHIVE_ROLE_NAMES) {
    validateRoleReference(role, manifest.roles[role]);
  }
  if (
    !Array.isArray(manifest.rawArtifacts) ||
    manifest.rawArtifacts.length < 1 ||
    manifest.rawArtifacts.length > MAX_RAW_ARTIFACTS
  ) {
    fail("RAW_ARTIFACT_SET_INVALID", "archive raw artifact count is invalid");
  }
  let previous = "";
  for (const [index, reference] of manifest.rawArtifacts.entries()) {
    const bounded = validateBlobReference(
      reference,
      `archive raw artifact ${index}`,
    );
    if (
      bounded.mediaType !== "application/octet-stream" ||
      bounded.payloadSchema !== null ||
      bounded.address <= previous
    ) {
      fail(
        "RAW_ARTIFACT_SET_INVALID",
        "raw artifacts must be sorted, unique, and untyped bytes",
      );
    }
    previous = bounded.address;
  }
  requireExactKeys(manifest.bindings, BINDING_KEYS, "archive bindings");
  for (const key of BINDING_KEYS) {
    requireSha256(manifest.bindings[key], `archive bindings.${key}`);
  }
  requireExactKeys(manifest.transport, TRANSPORT_KEYS, "archive transport");
  if (
    typeof manifest.transport.artifactId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(manifest.transport.artifactId) ||
    typeof manifest.transport.artifactDigest !== "string" ||
    !manifest.transport.artifactDigest.startsWith("sha256:")
  ) {
    fail("ARCHIVE_TRANSPORT_INVALID", "archive transport identity is invalid");
  }
  requireSha256(
    manifest.transport.artifactDigest.slice(7),
    "archive transport artifactDigest",
  );
  for (const key of ["runId", "runAttempt"]) {
    if (
      typeof manifest.transport[key] !== "string" ||
      !DIGIT_STRING_PATTERN.test(manifest.transport[key]) ||
      manifest.transport[key] !== manifest.run[key]
    ) {
      fail("ARCHIVE_TRANSPORT_INVALID", "archive transport run is invalid");
    }
  }
  if (
    manifest.bindings.rawArtifactSetSha256 !==
    rawArtifactSetSha256(manifest.rawArtifacts)
  ) {
    fail(
      "RAW_ARTIFACT_SET_HASH_MISMATCH",
      "archive raw artifact set digest is invalid",
    );
  }
  return manifest;
}

function parseJsonRole(bytes, role, expectedSchema) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail("ARCHIVE_ROLE_JSON_INVALID", `${role} is not UTF-8 JSON`, {
      cause: error.message,
    });
  }
  if (
    expectedSchema !== null &&
    (!isPlainObject(value) || value.schema !== expectedSchema)
  ) {
    fail(
      "ARCHIVE_ROLE_PAYLOAD_SCHEMA_MISMATCH",
      `${role} payload schema is invalid`,
    );
  }
  return value;
}

function validateArchiveRootManifest(store, manifest) {
  const identity = proofStoreIdentitySha256(store);
  validateArchiveShape(manifest);
  if (manifest.proofStoreIdentitySha256 !== identity) {
    fail(
      "ARCHIVE_STORE_IDENTITY_MISMATCH",
      "archive root belongs to another proof store",
    );
  }
  const roleBytes = {};
  for (const role of ARCHIVE_ROLE_NAMES) {
    const reference = manifest.roles[role];
    const bytes = readBlob(store, reference);
    roleBytes[role] = bytes;
    if (reference.mediaType === "application/json") {
      parseJsonRole(bytes, role, ARCHIVE_ROLE_TABLE[role].payloadSchema);
    }
  }
  const evidenceManifest = validateExternalEvidenceManifest(
    parseJsonRole(roleBytes.evidenceManifest, "evidenceManifest", null),
  );
  const expectedProjection = manifest.rawArtifacts.map(
    externalReferenceProjection,
  );
  if (stableJson(evidenceManifest) !== stableJson(expectedProjection)) {
    fail(
      "RAW_ARTIFACT_SET_MISMATCH",
      "archive raw artifacts do not exactly equal the evidence manifest",
    );
  }
  if (
    manifest.bindings.evidenceManifestSha256 !==
    sha256(Buffer.from(stableJson(evidenceManifest), "utf8"))
  ) {
    fail(
      "EVIDENCE_MANIFEST_HASH_MISMATCH",
      "archive evidence manifest semantic digest is invalid",
    );
  }
  for (const reference of manifest.rawArtifacts) readBlob(store, reference);
  return Object.freeze({
    manifest,
    roleBytes,
    evidenceManifest,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function storeArchiveRoot(store, manifest) {
  writerStateFor(store);
  validateArchiveRootManifest(store, manifest);
  const stored = storeBlob(store, {
    bytes: canonicalJsonBytes(manifest),
    mediaType: "application/json",
    payloadSchema: ARCHIVE_ROOT_SCHEMA,
  });
  return Object.freeze({
    archiveRoot: stored.reference,
    created: stored.created,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function readArchiveRoot(store, archiveRoot) {
  const bounded = validateBlobReference(archiveRoot, "archive root reference");
  if (
    bounded.mediaType !== "application/json" ||
    bounded.payloadSchema !== ARCHIVE_ROOT_SCHEMA
  ) {
    fail("ARCHIVE_ROOT_TYPE_INVALID", "archive root reference type is invalid");
  }
  const bytes = readBlob(store, bounded);
  const manifest = parseCanonicalJson(bytes, "archive root");
  validateArchiveRootManifest(store, manifest);
  return Object.freeze({
    reference: bounded,
    bytes,
    manifest,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function deriveImportKeySha256(manifest) {
  validateArchiveShape(manifest);
  return sha256(
    Buffer.from(
      stableJson({
        schema: IMPORT_INDEX_SCHEMA,
        repository: manifest.repository,
        runId: manifest.run.runId,
        runAttempt: manifest.run.runAttempt,
        requestNonce: manifest.requestNonce,
      }),
      "utf8",
    ),
  );
}

function validateImportIndex(index, expectedIdentity = null) {
  requireExactKeys(index, IMPORT_INDEX_KEYS, "proof import index");
  if (
    index.schema !== IMPORT_INDEX_SCHEMA ||
    index.productionAuthority !== false ||
    index.builderAuthority !== false
  ) {
    fail("IMPORT_INDEX_AUTHORITY_INVALID", "proof import index is invalid");
  }
  for (const key of [
    "importKeySha256",
    "proofStoreIdentitySha256",
    "archiveRootObjectSha256",
    "externalPackageHash",
    "certificationHash",
  ]) {
    requireSha256(index[key], `proof import index.${key}`);
  }
  if (
    expectedIdentity !== null &&
    index.proofStoreIdentitySha256 !== expectedIdentity
  ) {
    fail(
      "IMPORT_STORE_IDENTITY_MISMATCH",
      "proof import index belongs to another store",
    );
  }
  return index;
}

function importIndexPath(root, importKeySha256) {
  requireSha256(importKeySha256, "proof import key");
  return path.join(storePaths(root).imports, `${importKeySha256}.json`);
}

function adoptArchiveImport(store, archiveRoot) {
  const state = writerStateFor(store);
  const { root } = state;
  const archive = readArchiveRoot(store, archiveRoot);
  const identity = proofStoreIdentitySha256(store);
  const importKeySha256 = deriveImportKeySha256(archive.manifest);
  const index = {
    schema: IMPORT_INDEX_SCHEMA,
    importKeySha256,
    proofStoreIdentitySha256: identity,
    archiveRootObjectSha256: archive.reference.address.slice(7),
    externalPackageHash: archive.manifest.bindings.externalPackageHash,
    certificationHash: archive.manifest.bindings.certificationHash,
    productionAuthority: false,
    builderAuthority: false,
  };
  validateImportIndex(index, identity);
  const bytes = canonicalJsonBytes(index, 64 * 1024);
  const target = importIndexPath(root, importKeySha256);
  settleImmutablePublication(target, {
    label: "proof import index",
    allowRecovery: true,
  });
  let created = false;
  if (fs.existsSync(target)) {
    const existingBytes = readOwnerFile(target, {
      maximumBytes: 64 * 1024,
      label: "proof import index",
    });
    if (!existingBytes.equals(bytes)) {
      fail(
        "IMPORT_DIVERGENCE",
        "one proof import key cannot adopt two archive roots",
      );
    }
  } else {
    created = writeImmutableFile(target, bytes, "proof import index");
  }
  const readBack = readOwnerFile(target, {
    maximumBytes: 64 * 1024,
    label: "proof import index",
  });
  if (!readBack.equals(bytes)) {
    if (!created) {
      fail(
        "IMPORT_DIVERGENCE",
        "one proof import key cannot adopt two archive roots",
      );
    }
    fail("IMPORT_READBACK_MISMATCH", "proof import index read-back failed");
  }
  validateRootForState(state);
  return Object.freeze({
    index: Object.freeze(index),
    indexByteSha256: sha256(bytes),
    created,
    idempotent: !created,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function readImportIndex(store, importKeySha256) {
  const state = stateFor(store);
  const { root } = state;
  const before = validateRootForState(state);
  const identity = before.identitySha256;
  try {
    const bytes = readOwnerFile(importIndexPath(root, importKeySha256), {
      maximumBytes: 64 * 1024,
      label: "proof import index",
    });
    const index = parseCanonicalJson(bytes, "proof import index", 64 * 1024);
    validateImportIndex(index, identity);
    if (index.importKeySha256 !== importKeySha256) {
      fail("IMPORT_KEY_MISMATCH", "proof import index key is invalid");
    }
    return Object.freeze({
      index: Object.freeze(index),
      bytes,
      indexByteSha256: sha256(bytes),
      builderAuthority: false,
      productionAuthority: false,
    });
  } finally {
    /*
     * This fence runs on success and every refusal path. A same-UID
     * swap-away-and-back wholly between both handle checks remains the explicit
     * platform ABA assumption until Node exposes portable openat(2).
     */
    validateRootForState(state);
  }
}

function materializeArchiveOffline(store, archiveRoot) {
  const archive = readArchiveRoot(store, archiveRoot);
  const roles = {};
  for (const role of ARCHIVE_ROLE_NAMES) {
    roles[role] = Object.freeze({
      reference: archive.manifest.roles[role],
      bytes: readBlob(store, archive.manifest.roles[role]),
    });
  }
  const rawArtifacts = archive.manifest.rawArtifacts.map((reference) =>
    Object.freeze({
      reference,
      bytes: readBlob(store, reference),
    }),
  );
  return Object.freeze({
    schema: OFFLINE_MATERIALIZATION_SCHEMA,
    archiveRoot: Object.freeze({
      reference: archive.reference,
      bytes: archive.bytes,
    }),
    roles: Object.freeze(roles),
    rawArtifacts: Object.freeze(rawArtifacts),
    historicalEvidenceOnly: true,
    builderAuthority: false,
    productionAuthority: false,
  });
}

module.exports = Object.freeze({
  ARCHIVE_ROLE_NAMES,
  ARCHIVE_ROLE_TABLE,
  ARCHIVE_ROOT_SCHEMA,
  BLOB_REFERENCE_SCHEMA,
  GENESIS_SCHEMA,
  IMPORT_INDEX_SCHEMA,
  LAYOUT,
  LAYOUT_SCHEMA,
  LAYOUT_SHA256,
  MAX_BLOB_BYTES,
  MAX_RAW_ARTIFACTS,
  OFFLINE_MATERIALIZATION_SCHEMA,
  ProofStoreError,
  STORE_SCHEMA,
  adoptArchiveImport,
  canonicalJsonBytes,
  canonicalProofStoreRoot,
  deriveImportKeySha256,
  describeProofStore,
  initializeCanonicalProofStoreFoundation,
  initializeIsolatedNonAuthorizingTestStore,
  materializeArchiveOffline,
  openCanonicalProofStoreReadOnly,
  openIsolatedNonAuthorizingTestStoreReadOnly,
  proofStoreIdentitySha256,
  rawArtifactSetSha256,
  readArchiveRoot,
  readBlob,
  readImportIndex,
  sha256,
  stableJson,
  storeArchiveRoot,
  storeBlob,
  validateArchiveRootManifest,
  validateBlobReference,
});

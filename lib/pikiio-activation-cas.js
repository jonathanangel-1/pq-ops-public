"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ACTIVATION_RECEIPT_SCHEMA = "pikiio-heartbeat-activation-receipt-v4";
const ACTIVATION_INTENT_SCHEMA = "pikiio-activation-transition-intent-v1";
const ACTIVATION_POINTER_SCHEMA = "pikiio-activation-current-pointer-v1";
const ACTIVATION_ADVANCE_SCHEMA = "pikiio-activation-pointer-advance-v1";
const REPLAY_MARKER_SCHEMA = "pikiio-external-certification-consumption-v1";
const AUTHORITY_CLASS = "repository_builder_only";
const VALIDITY_CLASS = "until_phase_or_contract_change";
const CAS_SCHEMA = "pikiio-activation-cas-v1";
const CAS_ROOT_IDENTITY_SCHEMA = "pikiio-activation-cas-root-identity-v1";
const CAS_GENESIS_SCHEMA = "pikiio-activation-cas-genesis-v1";
const CAS_GENESIS_FILE = ".pikiio-activation-cas-genesis-v1.json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]{2}$/;
const SAFE_CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ACTIVE_LEDGER_PHASE_STATUSES = new Set([
  "active",
  "verifying",
  "locally_proven",
  "deployed_disabled",
  "observing",
  "promotable",
  "promoted",
]);
const TERMINAL_LEDGER_PHASE_STATUSES = new Set(["complete", "promoted"]);
const CAS_CATEGORIES = Object.freeze([
  "activations",
  "advances",
  "certifications",
  "intents",
  "pointers",
  "replay",
]);
const TRANSITION_READBACK_KEYS = Object.freeze([
  "commit",
  "parent",
  "tree",
  "transitionReceiptHash",
  "completedPhaseId",
  "activatedPhaseId",
  "ledgerRevision",
  "ledgerSha256",
  "externalCertificationHash",
  "controllerHost",
  "controllerLeaseFence",
]);
const GENESIS_KEYS = Object.freeze([
  "schema",
  "absoluteCanonicalPath",
  "hostname",
  "ownerUid",
  "device",
  "inode",
  "nonce",
  "createdAt",
  "genesisHash",
]);

const INTENT_KEYS = Object.freeze([
  "schema",
  "completedPhaseId",
  "activatedPhaseId",
  "ledgerRevision",
  "ledgerSha256",
  "scopeBaseCommit",
  "candidateCommit",
  "transitionCommit",
  "transitionParent",
  "transitionTree",
  "transitionReceiptHash",
  "remoteRef",
  "externalCertificationHash",
  "attestationBodySha256",
  "qualityVerdictHash",
  "evidenceManifestSha256",
  "requestNonce",
  "automationContractSha256",
  "allowedPathsSha256",
  "authorityCommit",
  "casRootIdentitySha256",
  "controllerHost",
  "controllerLeaseFence",
  "createdAt",
  "intentHash",
]);
const REPLAY_KEYS = Object.freeze([
  "schema",
  "replayKeySha256",
  "externalCertificationHash",
  "activationIntentHash",
  "completedPhaseId",
  "activatedPhaseId",
  "candidateCommit",
  "transitionCommit",
  "remoteRef",
  "consumptionScope",
  "multiHostSafe",
  "consumedAt",
  "markerHash",
]);
const RECEIPT_KEYS = Object.freeze([
  "schema",
  "authorityClass",
  "productionAuthority",
  "validity",
  "completedPhaseId",
  "activatedPhaseId",
  "ledgerRevision",
  "ledgerSha256",
  "scopeBaseCommit",
  "candidateCommit",
  "transitionCommit",
  "transitionParent",
  "transitionTree",
  "transitionReceiptHash",
  "remoteRef",
  "remoteReadbackCommit",
  "authorityCommit",
  "externalCertificationHash",
  "externalReplayKeySha256",
  "attestationBodySha256",
  "qualityVerdictHash",
  "evidenceManifestSha256",
  "requestNonce",
  "activationIntentHash",
  "replayMarkerHash",
  "automationContractSha256",
  "allowedPathsSha256",
  "hostDurabilityReceiptHash",
  "casRootIdentitySha256",
  "controllerHost",
  "controllerLeaseFence",
  "intentCreatedAt",
  "issuedAt",
  "receiptHash",
]);
const POINTER_KEYS = Object.freeze([
  "schema",
  "sequence",
  "phaseId",
  "ledgerRevision",
  "activationReceiptHash",
  "previousPointerHash",
  "updatedAt",
  "pointerHash",
]);
const ADVANCE_KEYS = Object.freeze([
  "schema",
  "slotKeySha256",
  "previousPointerHash",
  "nextPointerHash",
  "sequence",
  "advancedAt",
  "advanceHash",
]);

class ActivationCasError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ActivationCasError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ActivationCasError(code, message, details);
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

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("NON_CANONICAL_JSON", "JSON numbers must be finite and canonical");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    fail("NON_CANONICAL_JSON", "Only plain JSON objects are accepted");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashWithoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function requireHash(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_HASH", `${label} must be a lowercase SHA-256 digest`);
  }
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    fail("INVALID_COMMIT", `${label} must be one full Git commit`);
  }
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("INVALID_TIMESTAMP", `${label} must be a canonical ISO timestamp`);
  }
}

function requirePhase(value) {
  if (typeof value !== "string" || !PHASE_PATTERN.test(value)) {
    fail("INVALID_PHASE", "phaseId is invalid");
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

function ensureRealDirectory(directory, { create = false } = {}) {
  requireAbsoluteCanonicalPath(directory, "CAS directory");
  if (create) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    fail("CAS_DIRECTORY_UNREADABLE", "CAS directory cannot be read", {
      cause: error.code || error.message,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("CAS_DIRECTORY_INVALID", "CAS directory must be a real directory");
  }
  if (
    (stat.mode & 0o022n) !== 0n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    fail(
      "CAS_DIRECTORY_PERMISSIONS_INVALID",
      "CAS directory must be owner-controlled",
    );
  }
  const real = fs.realpathSync(directory);
  if (real !== directory) {
    fail("CAS_DIRECTORY_ALIAS_REFUSED", "CAS directory cannot use an alias");
  }
  return directory;
}

function ensureCasRoot(casRoot) {
  requireAbsoluteCanonicalPath(casRoot, "CAS root");
  ensureRealDirectory(casRoot);
  initializeCasRootIdentity(casRoot);
  for (const category of CAS_CATEGORIES) {
    const directory = path.join(casRoot, category);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    ensureRealDirectory(directory);
  }
  return casRoot;
}

function requireCasRoot(casRoot) {
  requireAbsoluteCanonicalPath(casRoot, "CAS root");
  ensureRealDirectory(casRoot);
  readCasRootIdentity(casRoot);
  for (const category of CAS_CATEGORIES) {
    ensureRealDirectory(path.join(casRoot, category));
  }
  return casRoot;
}

function validateCasRootIdentity(identity, casRoot) {
  requireExactKeys(identity, GENESIS_KEYS, "CAS root identity");
  if (identity.schema !== CAS_GENESIS_SCHEMA) {
    fail("CAS_GENESIS_INVALID", "CAS root identity schema is invalid");
  }
  requireAbsoluteCanonicalPath(casRoot, "CAS root");
  ensureRealDirectory(casRoot);
  const stat = fs.lstatSync(casRoot, { bigint: true });
  for (const [value, label] of [
    [identity.ownerUid, "ownerUid"],
    [identity.device, "device"],
    [identity.inode, "inode"],
  ]) {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
      fail("CAS_GENESIS_INVALID", `CAS root identity ${label} is invalid`);
    }
  }
  if (
    identity.absoluteCanonicalPath !== casRoot ||
    identity.hostname !== os.hostname() ||
    identity.ownerUid !== stat.uid.toString() ||
    identity.device !== stat.dev.toString() ||
    identity.inode !== stat.ino.toString() ||
    typeof identity.nonce !== "string" ||
    !SHA256_PATTERN.test(identity.nonce)
  ) {
    fail(
      "CAS_GENESIS_IDENTITY_MISMATCH",
      "CAS root identity does not match this host and directory",
    );
  }
  requireTimestamp(identity.createdAt, "CAS root identity createdAt");
  requireHash(identity.genesisHash, "CAS root identity genesisHash");
  if (hashWithoutField(identity, "genesisHash") !== identity.genesisHash) {
    fail("CAS_GENESIS_HASH_INVALID", "CAS root identity hash is invalid");
  }
  return identity;
}

function casGenesisPath(casRoot) {
  requireAbsoluteCanonicalPath(casRoot, "CAS root");
  ensureRealDirectory(casRoot);
  return path.join(casRoot, CAS_GENESIS_FILE);
}

function readCasRootIdentity(casRoot) {
  const target = casGenesisPath(casRoot);
  if (!fs.existsSync(target)) {
    fail("CAS_GENESIS_MISSING", "CAS root identity is missing");
  }
  return validateCasRootIdentity(
    parseCanonicalJsonBytes(
      readRegularBytes(target),
      "CAS root identity",
    ),
    casRoot,
  );
}

function initializeCasRootIdentity(casRoot) {
  const target = casGenesisPath(casRoot);
  if (fs.existsSync(target)) return readCasRootIdentity(casRoot);
  const stat = fs.lstatSync(casRoot, { bigint: true });
  const body = {
    schema: CAS_GENESIS_SCHEMA,
    absoluteCanonicalPath: casRoot,
    hostname: os.hostname(),
    ownerUid: stat.uid.toString(),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    nonce: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  const identity = {
    ...body,
    genesisHash: hashWithoutField(body, "genesisHash"),
  };
  validateCasRootIdentity(identity, casRoot);
  const bytes = canonicalBytes(identity);
  const temporary = path.join(
    casRoot,
    `.${CAS_GENESIS_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    fsyncDirectory(casRoot);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return readCasRootIdentity(casRoot);
}

function casRootIdentitySha256(casRoot) {
  const identity = readCasRootIdentity(casRoot);
  return sha256(
    stableJson({
      schema: CAS_ROOT_IDENTITY_SCHEMA,
      genesisHash: identity.genesisHash,
    }),
  );
}

function canonicalBytes(value) {
  const bytes = Buffer.from(`${stableJson(value)}\n`, "utf8");
  if (bytes.length < 3 || bytes.length > MAX_JSON_BYTES) {
    fail("CAS_OBJECT_SIZE_INVALID", "CAS object exceeds its byte bound");
  }
  return bytes;
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

function readRegularBytes(filePath, maximumBytes = MAX_JSON_BYTES) {
  requireAbsoluteCanonicalPath(filePath, "CAS object");
  ensureRealDirectory(path.dirname(filePath));
  let before;
  let descriptor = null;
  try {
    before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.mode & 0o022n) !== 0n ||
      (typeof process.getuid === "function" &&
        before.uid !== BigInt(process.getuid())) ||
      before.size < 2n ||
      before.size > BigInt(maximumBytes)
    ) {
      fail("CAS_OBJECT_INVALID", "CAS object must be a bounded regular file");
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, opened)) {
      fail("CAS_OBJECT_CHANGED", "CAS object changed while opening");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(opened, after) || bytes.length !== Number(opened.size)) {
      fail("CAS_OBJECT_CHANGED", "CAS object changed while reading");
    }
    return bytes;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function parseCanonicalJsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail("CAS_JSON_INVALID", `${label} is not valid UTF-8 JSON`, {
      cause: error.message,
    });
  }
  if (!isPlainObject(value) || !bytes.equals(canonicalBytes(value))) {
    fail("CAS_JSON_NON_CANONICAL", `${label} bytes are not canonical`);
  }
  return value;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function casPath(casRoot, category, objectHash) {
  if (
    !SAFE_CATEGORY_PATTERN.test(category) ||
    !CAS_CATEGORIES.includes(category)
  ) {
    fail("CAS_CATEGORY_INVALID", "CAS category is invalid");
  }
  requireCasRoot(casRoot);
  requireHash(objectHash, "CAS address");
  return path.join(casRoot, category, `${objectHash}.json`);
}

function writeCasObject(casRoot, category, objectHash, value) {
  requireHash(objectHash, "CAS address");
  const bytes = canonicalBytes(value);
  ensureCasRoot(casRoot);
  const target = casPath(casRoot, category, objectHash);
  const directory = path.dirname(target);
  if (fs.existsSync(target)) {
    const existing = readRegularBytes(target);
    if (!existing.equals(bytes)) {
      fail("CAS_COLLISION", "CAS address is occupied by different bytes", {
        category,
        objectHash,
      });
    }
    return { path: target, created: false, sha256: sha256(bytes) };
  }
  const temporary = path.join(
    directory,
    `.${objectHash}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readRegularBytes(target);
      if (!existing.equals(bytes)) {
        fail("CAS_COLLISION", "Concurrent CAS bytes disagree", {
          category,
          objectHash,
        });
      }
    }
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const readBack = readRegularBytes(target);
  if (!readBack.equals(bytes)) {
    fail("CAS_READBACK_MISMATCH", "CAS read-back bytes differ");
  }
  return { path: target, created: true, sha256: sha256(bytes) };
}

function readCasObject(casRoot, category, objectHash) {
  const value = parseCanonicalJsonBytes(
    readRegularBytes(casPath(casRoot, category, objectHash)),
    `${category} object`,
  );
  return value;
}

function validateIntent(intent) {
  const errors = [];
  try {
    requireExactKeys(intent, INTENT_KEYS, "activation intent");
    if (intent.schema !== ACTIVATION_INTENT_SCHEMA) {
      fail("INTENT_SCHEMA_INVALID", "activation intent schema is invalid");
    }
    requirePhase(intent.completedPhaseId);
    requirePhase(intent.activatedPhaseId);
    if (intent.completedPhaseId === intent.activatedPhaseId) {
      fail(
        "INTENT_PHASE_TRANSITION_INVALID",
        "completed and activated phases must differ",
      );
    }
    if (!Number.isSafeInteger(intent.ledgerRevision) || intent.ledgerRevision < 1) {
      fail("INTENT_LEDGER_INVALID", "ledger revision is invalid");
    }
    for (const field of [
      "ledgerSha256",
      "externalCertificationHash",
      "attestationBodySha256",
      "qualityVerdictHash",
      "evidenceManifestSha256",
      "requestNonce",
      "automationContractSha256",
      "allowedPathsSha256",
      "casRootIdentitySha256",
      "transitionReceiptHash",
    ]) {
      requireHash(intent[field], field);
    }
    for (const field of [
      "scopeBaseCommit",
      "candidateCommit",
      "transitionCommit",
      "transitionParent",
      "transitionTree",
      "authorityCommit",
    ]) {
      requireCommit(intent[field], field);
    }
    if (intent.transitionParent !== intent.candidateCommit) {
      fail(
        "INTENT_TRANSITION_PARENT_INVALID",
        "transition must directly follow the certified candidate",
      );
    }
    if (
      typeof intent.remoteRef !== "string" ||
      !/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/.test(intent.remoteRef)
    ) {
      fail("INTENT_REMOTE_REF_INVALID", "remote ref is invalid");
    }
    if (
      typeof intent.controllerHost !== "string" ||
      intent.controllerHost.length < 1 ||
      intent.controllerHost.length > 255 ||
      !Number.isSafeInteger(intent.controllerLeaseFence) ||
      intent.controllerLeaseFence < 1
    ) {
      fail("INTENT_CONTROLLER_INVALID", "controller binding is invalid");
    }
    requireTimestamp(intent.createdAt, "intent createdAt");
    requireHash(intent.intentHash, "intent hash");
    if (hashWithoutField(intent, "intentHash") !== intent.intentHash) {
      fail("INTENT_HASH_INVALID", "activation intent hash is invalid");
    }
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateReplayMarker(marker) {
  const errors = [];
  try {
    requireExactKeys(marker, REPLAY_KEYS, "replay marker");
    if (marker.schema !== REPLAY_MARKER_SCHEMA) {
      fail("REPLAY_SCHEMA_INVALID", "replay marker schema is invalid");
    }
    for (const field of [
      "replayKeySha256",
      "externalCertificationHash",
      "activationIntentHash",
    ]) {
      requireHash(marker[field], field);
    }
    requirePhase(marker.completedPhaseId);
    requirePhase(marker.activatedPhaseId);
    if (marker.completedPhaseId === marker.activatedPhaseId) {
      fail(
        "REPLAY_PHASE_TRANSITION_INVALID",
        "replay marker must bind two distinct transition phases",
      );
    }
    requireCommit(marker.candidateCommit, "candidateCommit");
    requireCommit(marker.transitionCommit, "transitionCommit");
    if (
      marker.consumptionScope !== "single-controller-transition" ||
      marker.multiHostSafe !== false
    ) {
      fail("REPLAY_SCOPE_INVALID", "replay scope must remain local and one-use");
    }
    requireTimestamp(marker.consumedAt, "replay consumedAt");
    requireHash(marker.markerHash, "replay marker hash");
    if (hashWithoutField(marker, "markerHash") !== marker.markerHash) {
      fail("REPLAY_HASH_INVALID", "replay marker hash is invalid");
    }
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateActivationReceipt(receipt) {
  const errors = [];
  try {
    requireExactKeys(receipt, RECEIPT_KEYS, "activation receipt");
    if (
      receipt.schema !== ACTIVATION_RECEIPT_SCHEMA ||
      receipt.authorityClass !== AUTHORITY_CLASS ||
      receipt.productionAuthority !== false ||
      receipt.validity !== VALIDITY_CLASS
    ) {
      fail("ACTIVATION_AUTHORITY_INVALID", "activation authority class is invalid");
    }
    requirePhase(receipt.completedPhaseId);
    requirePhase(receipt.activatedPhaseId);
    if (receipt.completedPhaseId === receipt.activatedPhaseId) {
      fail(
        "ACTIVATION_PHASE_TRANSITION_INVALID",
        "activation must bind distinct completed and activated phases",
      );
    }
    if (!Number.isSafeInteger(receipt.ledgerRevision) || receipt.ledgerRevision < 1) {
      fail("ACTIVATION_LEDGER_INVALID", "activation ledger revision is invalid");
    }
    for (const field of [
      "ledgerSha256",
      "externalCertificationHash",
      "externalReplayKeySha256",
      "attestationBodySha256",
      "qualityVerdictHash",
      "evidenceManifestSha256",
      "requestNonce",
      "activationIntentHash",
      "replayMarkerHash",
      "automationContractSha256",
      "allowedPathsSha256",
      "hostDurabilityReceiptHash",
      "casRootIdentitySha256",
      "transitionReceiptHash",
    ]) {
      requireHash(receipt[field], field);
    }
    for (const field of [
      "scopeBaseCommit",
      "candidateCommit",
      "transitionCommit",
      "transitionParent",
      "transitionTree",
      "remoteReadbackCommit",
      "authorityCommit",
    ]) {
      requireCommit(receipt[field], field);
    }
    if (receipt.transitionParent !== receipt.candidateCommit) {
      fail(
        "ACTIVATION_TRANSITION_PARENT_INVALID",
        "activation transition must directly follow the certified candidate",
      );
    }
    if (receipt.remoteReadbackCommit !== receipt.transitionCommit) {
      fail("ACTIVATION_REMOTE_MISMATCH", "remote read-back does not match transition");
    }
    if (
      typeof receipt.remoteRef !== "string" ||
      !receipt.remoteRef.startsWith("refs/heads/")
    ) {
      fail("ACTIVATION_REMOTE_REF_INVALID", "activation remote ref is invalid");
    }
    if (
      typeof receipt.controllerHost !== "string" ||
      receipt.controllerHost.length < 1 ||
      receipt.controllerHost.length > 255 ||
      !Number.isSafeInteger(receipt.controllerLeaseFence) ||
      receipt.controllerLeaseFence < 1
    ) {
      fail("ACTIVATION_CONTROLLER_INVALID", "activation controller is invalid");
    }
    requireTimestamp(receipt.intentCreatedAt, "activation intentCreatedAt");
    requireTimestamp(receipt.issuedAt, "activation issuedAt");
    if (receipt.intentCreatedAt !== receipt.issuedAt) {
      fail(
        "ACTIVATION_TIME_MISMATCH",
        "activation issuance must preserve the stable ceremony timestamp",
      );
    }
    requireHash(receipt.receiptHash, "activation receipt hash");
    if (hashWithoutField(receipt, "receiptHash") !== receipt.receiptHash) {
      fail("ACTIVATION_HASH_INVALID", "activation receipt hash is invalid");
    }
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function validatePointer(pointer) {
  const errors = [];
  try {
    requireExactKeys(pointer, POINTER_KEYS, "activation pointer");
    if (pointer.schema !== ACTIVATION_POINTER_SCHEMA) {
      fail("POINTER_SCHEMA_INVALID", "activation pointer schema is invalid");
    }
    if (!Number.isSafeInteger(pointer.sequence) || pointer.sequence < 1) {
      fail("POINTER_SEQUENCE_INVALID", "activation pointer sequence is invalid");
    }
    requirePhase(pointer.phaseId);
    if (!Number.isSafeInteger(pointer.ledgerRevision) || pointer.ledgerRevision < 1) {
      fail("POINTER_LEDGER_INVALID", "activation pointer ledger is invalid");
    }
    requireHash(pointer.activationReceiptHash, "activation receipt hash");
    if (
      pointer.previousPointerHash !== null &&
      !SHA256_PATTERN.test(String(pointer.previousPointerHash))
    ) {
      fail("POINTER_PREVIOUS_INVALID", "previous pointer hash is invalid");
    }
    requireTimestamp(pointer.updatedAt, "pointer updatedAt");
    requireHash(pointer.pointerHash, "pointer hash");
    if (hashWithoutField(pointer, "pointerHash") !== pointer.pointerHash) {
      fail("POINTER_HASH_INVALID", "activation pointer hash is invalid");
    }
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function advanceSlotKey(previousPointerHash) {
  if (previousPointerHash !== null) {
    requireHash(previousPointerHash, "previous pointer hash");
  }
  return sha256(
    stableJson({
      schema: ACTIVATION_ADVANCE_SCHEMA,
      previousPointerHash,
    }),
  );
}

function validateAdvance(advance) {
  const errors = [];
  try {
    requireExactKeys(advance, ADVANCE_KEYS, "activation pointer advance");
    if (advance.schema !== ACTIVATION_ADVANCE_SCHEMA) {
      fail("ADVANCE_SCHEMA_INVALID", "activation advance schema is invalid");
    }
    requireHash(advance.slotKeySha256, "activation advance slot key");
    if (advance.previousPointerHash !== null) {
      requireHash(advance.previousPointerHash, "previous pointer hash");
    }
    requireHash(advance.nextPointerHash, "next pointer hash");
    if (!Number.isSafeInteger(advance.sequence) || advance.sequence < 1) {
      fail("ADVANCE_SEQUENCE_INVALID", "activation advance sequence is invalid");
    }
    requireTimestamp(advance.advancedAt, "activation advancedAt");
    requireHash(advance.advanceHash, "activation advance hash");
    if (
      advance.slotKeySha256 !==
      advanceSlotKey(advance.previousPointerHash)
    ) {
      fail("ADVANCE_SLOT_INVALID", "activation advance slot is invalid");
    }
    if (hashWithoutField(advance, "advanceHash") !== advance.advanceHash) {
      fail("ADVANCE_HASH_INVALID", "activation advance hash is invalid");
    }
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function readAdvance(casRoot, previousPointerHash) {
  const slotKeySha256 = advanceSlotKey(previousPointerHash);
  const target = casPath(casRoot, "advances", slotKeySha256);
  if (!fs.existsSync(target)) return null;
  const advance = readCasObject(
    casRoot,
    "advances",
    slotKeySha256,
  );
  const validation = validateAdvance(advance);
  if (!validation.valid) {
    fail("CURRENT_ADVANCE_INVALID", "activation advance is invalid", {
      errors: validation.errors,
    });
  }
  if (advance.previousPointerHash !== previousPointerHash) {
    fail("CURRENT_ADVANCE_MISMATCH", "activation advance has the wrong parent");
  }
  return advance;
}

function readCurrentPointer(casRoot, maximumDepth = 1024) {
  if (
    !Number.isSafeInteger(maximumDepth) ||
    maximumDepth < 1 ||
    maximumDepth > 100_000
  ) {
    fail("POINTER_DEPTH_INVALID", "current pointer depth is invalid");
  }
  requireCasRoot(casRoot);
  let previousPointerHash = null;
  let current = null;
  for (let depth = 0; depth < maximumDepth; depth += 1) {
    const advance = readAdvance(casRoot, previousPointerHash);
    if (!advance) return current;
    const pointer = readCasObject(
      casRoot,
      "pointers",
      advance.nextPointerHash,
    );
    const validation = validatePointer(pointer);
    if (
      !validation.valid ||
      pointer.pointerHash !== advance.nextPointerHash ||
      pointer.previousPointerHash !== previousPointerHash ||
      pointer.sequence !== advance.sequence ||
      pointer.sequence !== (current?.sequence || 0) + 1
    ) {
      fail("CURRENT_POINTER_INVALID", "activation pointer chain is invalid", {
        errors: validation.errors,
      });
    }
    current = pointer;
    previousPointerHash = pointer.pointerHash;
  }
  if (readAdvance(casRoot, previousPointerHash)) {
    fail("POINTER_HISTORY_TOO_DEEP", "activation pointer history is unbounded");
  }
  return current;
}

function validatePointerHistory(casRoot, currentPointer, maximumDepth = 1024) {
  const errors = [];
  try {
    if (
      !Number.isSafeInteger(maximumDepth) ||
      maximumDepth < 1 ||
      maximumDepth > 100_000
    ) {
      fail("POINTER_DEPTH_INVALID", "pointer history depth is invalid");
    }
    let pointer = currentPointer;
    let expectedSequence = currentPointer.sequence;
    let expectedPointerHash = currentPointer.pointerHash;
    const seen = new Set();
    for (let depth = 0; pointer; depth += 1) {
      if (depth >= maximumDepth) {
        fail("POINTER_HISTORY_TOO_DEEP", "activation pointer history is unbounded");
      }
      const validation = validatePointer(pointer);
      if (!validation.valid) {
        fail("POINTER_HISTORY_INVALID", "activation pointer history is invalid", {
          errors: validation.errors,
        });
      }
      if (
        pointer.pointerHash !== expectedPointerHash ||
        pointer.sequence !== expectedSequence ||
        seen.has(pointer.pointerHash)
      ) {
        fail(
          "POINTER_HISTORY_DISCONTINUOUS",
          "activation pointer history is cyclic or discontinuous",
        );
      }
      seen.add(pointer.pointerHash);
      const immutable = readCasObject(casRoot, "pointers", pointer.pointerHash);
      if (stableJson(immutable) !== stableJson(pointer)) {
        fail(
          "POINTER_HISTORY_MISMATCH",
          "current pointer differs from immutable pointer history",
        );
      }
      if (pointer.previousPointerHash === null) {
        if (pointer.sequence !== 1) {
          fail(
            "POINTER_HISTORY_DISCONTINUOUS",
            "first activation pointer must have sequence one",
          );
        }
        pointer = null;
      } else {
        expectedPointerHash = pointer.previousPointerHash;
        pointer = readCasObject(
          casRoot,
          "pointers",
          pointer.previousPointerHash,
        );
        expectedSequence -= 1;
      }
    }
    if (seen.size !== currentPointer.sequence) {
      fail(
        "POINTER_HISTORY_DISCONTINUOUS",
        "activation pointer history length does not match its sequence",
      );
    }
    return { valid: true, errors: [], depth: seen.size };
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
    return { valid: false, errors, depth: 0 };
  }
}

function replaceCurrentPointer(casRoot, pointer, expectedPreviousPointerHash) {
  const validation = validatePointer(pointer);
  if (!validation.valid) {
    fail("POINTER_INVALID", "replacement pointer is invalid", {
      errors: validation.errors,
    });
  }
  const existing = readCurrentPointer(casRoot);
  const actualPrevious = existing?.pointerHash || null;
  if (actualPrevious === pointer.pointerHash) {
    if (expectedPreviousPointerHash !== pointer.previousPointerHash) {
      fail("POINTER_CAS_MISMATCH", "activation retry precondition is stale", {
        expectedPreviousPointerHash,
        actualPrevious,
      });
    }
    return existing;
  }
  if (actualPrevious !== expectedPreviousPointerHash) {
    fail("POINTER_CAS_MISMATCH", "activation pointer changed concurrently", {
      expectedPreviousPointerHash,
      actualPrevious,
    });
  }
  if (
    pointer.previousPointerHash !== actualPrevious ||
    pointer.sequence !== (existing?.sequence || 0) + 1
  ) {
    fail(
      "POINTER_ADVANCE_MISMATCH",
      "activation pointer does not extend the exact current pointer",
    );
  }
  writeCasObject(casRoot, "pointers", pointer.pointerHash, pointer);
  const advanceBody = {
    schema: ACTIVATION_ADVANCE_SCHEMA,
    slotKeySha256: advanceSlotKey(actualPrevious),
    previousPointerHash: actualPrevious,
    nextPointerHash: pointer.pointerHash,
    sequence: pointer.sequence,
    advancedAt: pointer.updatedAt,
  };
  const advance = {
    ...advanceBody,
    advanceHash: hashWithoutField(advanceBody, "advanceHash"),
  };
  const advanceValidation = validateAdvance(advance);
  if (!advanceValidation.valid) {
    fail("POINTER_ADVANCE_INVALID", "activation pointer advance is invalid", {
      errors: advanceValidation.errors,
    });
  }
  writeCasObject(
    casRoot,
    "advances",
    advance.slotKeySha256,
    advance,
  );
  const readBack = readCurrentPointer(casRoot);
  if (!readBack || readBack.pointerHash !== pointer.pointerHash) {
    fail("POINTER_READBACK_MISMATCH", "current pointer read-back failed");
  }
  return readBack;
}

function normalizeExternalValidation(result, expected) {
  if (
    !isPlainObject(result) ||
    result.valid !== true ||
    result.productionAuthority !== false
  ) {
    fail(
      "EXTERNAL_CERTIFICATION_INVALID",
      "external certification is not valid repository-builder evidence",
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (result[key] !== value) {
      fail(
        "EXTERNAL_CERTIFICATION_BINDING_MISMATCH",
        `external certification does not bind ${key}`,
      );
    }
  }
  requireHash(result.replayKeySha256, "external replay key");
  return result;
}

function normalizeTransitionReadback(result, expected) {
  requireExactKeys(
    result,
    TRANSITION_READBACK_KEYS,
    "transition read-back",
  );
  for (const field of ["commit", "parent", "tree"]) {
    requireCommit(result[field], `transition read-back ${field}`);
  }
  for (const field of [
    "transitionReceiptHash",
    "ledgerSha256",
    "externalCertificationHash",
  ]) {
    requireHash(result[field], `transition read-back ${field}`);
  }
  requirePhase(result.completedPhaseId);
  requirePhase(result.activatedPhaseId);
  if (
    result.completedPhaseId === result.activatedPhaseId ||
    !Number.isSafeInteger(result.ledgerRevision) ||
    result.ledgerRevision < 1 ||
    typeof result.controllerHost !== "string" ||
    result.controllerHost.length < 1 ||
    result.controllerHost.length > 255 ||
    !Number.isSafeInteger(result.controllerLeaseFence) ||
    result.controllerLeaseFence < 1
  ) {
    fail(
      "TRANSITION_READBACK_INVALID",
      "transition read-back phase, ledger, or controller binding is invalid",
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (result[key] !== value) {
      fail(
        "TRANSITION_READBACK_MISMATCH",
        `transition read-back does not bind ${key}`,
      );
    }
  }
  return result;
}

function validateLedgerTransition(ledger, binding, previousPointer = null) {
  const errors = [];
  try {
    if (
      !isPlainObject(ledger) ||
      !Number.isSafeInteger(ledger.revision) ||
      ledger.revision < 1 ||
      typeof ledger.activePhaseId !== "string" ||
      !Array.isArray(ledger.phases)
    ) {
      fail("LEDGER_TRANSITION_INVALID", "activation ledger shape is invalid");
    }
    requirePhase(binding?.completedPhaseId);
    requirePhase(binding?.activatedPhaseId);
    if (
      binding.completedPhaseId === binding.activatedPhaseId ||
      ledger.revision !== binding.ledgerRevision ||
      ledger.activePhaseId !== binding.activatedPhaseId ||
      sha256(stableJson(ledger)) !== binding.ledgerSha256
    ) {
      fail(
        "LEDGER_TRANSITION_BINDING_MISMATCH",
        "activation ledger does not bind the exact phase transition",
      );
    }
    const byId = new Map();
    for (const phase of ledger.phases) {
      if (
        !isPlainObject(phase) ||
        typeof phase.id !== "string" ||
        byId.has(phase.id)
      ) {
        fail(
          "LEDGER_TRANSITION_INVALID",
          "activation ledger phases are malformed or duplicated",
        );
      }
      byId.set(phase.id, phase);
    }
    const completed = byId.get(binding.completedPhaseId);
    const activated = byId.get(binding.activatedPhaseId);
    if (
      !completed ||
      !activated ||
      !TERMINAL_LEDGER_PHASE_STATUSES.has(completed.status) ||
      !ACTIVE_LEDGER_PHASE_STATUSES.has(activated.status) ||
      !Array.isArray(activated.dependsOn) ||
      !activated.dependsOn.includes(completed.id)
    ) {
      fail(
        "LEDGER_SUCCESSOR_INVALID",
        "activated phase is not a direct successor of the completed phase",
      );
    }
    for (const dependencyId of activated.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (
        !dependency ||
        !TERMINAL_LEDGER_PHASE_STATUSES.has(dependency.status)
      ) {
        fail(
          "LEDGER_DEPENDENCY_UNMET",
          "activated phase has an unmet ledger dependency",
        );
      }
    }
    if (previousPointer === null) {
      if (binding.completedPhaseId !== "GOV-00") {
        fail(
          "ACTIVATION_CHAIN_ORIGIN_INVALID",
          "the first activation must complete GOV-00",
        );
      }
    } else {
      const pointerValidation = validatePointer(previousPointer);
      const advancesCurrent =
        binding.completedPhaseId === previousPointer.phaseId &&
        binding.ledgerRevision === previousPointer.ledgerRevision + 1;
      const retriesCurrent =
        binding.activatedPhaseId === previousPointer.phaseId &&
        binding.ledgerRevision === previousPointer.ledgerRevision;
      if (
        !pointerValidation.valid ||
        (!advancesCurrent && !retriesCurrent)
      ) {
        fail(
          "ACTIVATION_CHAIN_DISCONTINUOUS",
          "activation must extend the exact current phase and ledger revision",
        );
      }
    }
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

function issueActivation({
  casRoot,
  certification,
  ledger,
  intentInput,
  expectedPreviousPointerHash = null,
  validateExternalCertification,
  resolveTransitionReadback,
  validateHostDurability,
  hostDurabilityReceipt,
  nowMs = Date.now(),
  faultAfter = null,
} = {}) {
  if (typeof validateExternalCertification !== "function") {
    fail("EXTERNAL_VALIDATOR_REQUIRED", "external certification validator is required");
  }
  if (typeof resolveTransitionReadback !== "function") {
    fail(
      "TRANSITION_READBACK_REQUIRED",
      "typed transition read-back resolver is required",
    );
  }
  if (typeof validateHostDurability !== "function") {
    fail("HOST_VALIDATOR_REQUIRED", "host durability validator is required");
  }
  if (!Number.isFinite(nowMs)) fail("NOW_INVALID", "nowMs is invalid");
  if (
    !isPlainObject(intentInput) ||
    Object.hasOwn(intentInput, "casRootIdentitySha256")
  ) {
    fail(
      "CAS_ROOT_IDENTITY_CALLER_FORBIDDEN",
      "CAS-root identity is derived only from the canonical store",
    );
  }
  initializeCasRootIdentity(casRoot);
  const actualCasRootIdentitySha256 = casRootIdentitySha256(casRoot);
  const issuedAt = intentInput?.createdAt;
  const unsignedIntent = {
    schema: ACTIVATION_INTENT_SCHEMA,
    ...intentInput,
    casRootIdentitySha256: actualCasRootIdentitySha256,
  };
  delete unsignedIntent.intentHash;
  const intent = {
    ...unsignedIntent,
    intentHash: hashWithoutField(unsignedIntent, "intentHash"),
  };
  const intentValidation = validateIntent(intent);
  if (!intentValidation.valid) {
    fail("ACTIVATION_INTENT_INVALID", "activation intent is invalid", {
      errors: intentValidation.errors,
    });
  }
  if (Date.parse(intent.createdAt) > nowMs) {
    fail("ACTIVATION_INTENT_FUTURE", "activation intent cannot be future-dated");
  }
  const certificationHash = certification?.certificationHash;
  requireHash(certificationHash, "certification hash");
  if (certificationHash !== intent.externalCertificationHash) {
    fail("CERTIFICATION_INTENT_MISMATCH", "certification hash does not match intent");
  }
  const hostDurabilityReceiptHash = hostDurabilityReceipt?.receiptHash;
  requireHash(hostDurabilityReceiptHash, "host durability receipt hash");
  const external = normalizeExternalValidation(
    validateExternalCertification(certification, {
      phaseId: intent.completedPhaseId,
      scopeBaseCommit: intent.scopeBaseCommit,
      candidateCommit: intent.candidateCommit,
      authorityCommit: intent.authorityCommit,
    }),
    {
      certificationHash: intent.externalCertificationHash,
      attestationBodySha256: intent.attestationBodySha256,
      qualityVerdictHash: intent.qualityVerdictHash,
      evidenceManifestSha256: intent.evidenceManifestSha256,
      requestNonce: intent.requestNonce,
      phaseId: intent.completedPhaseId,
      scopeBaseCommit: intent.scopeBaseCommit,
      candidateCommit: intent.candidateCommit,
      authorityCommit: intent.authorityCommit,
    },
  );
  const transitionReadback = normalizeTransitionReadback(
    resolveTransitionReadback(intent.remoteRef),
    {
      commit: intent.transitionCommit,
      parent: intent.transitionParent,
      tree: intent.transitionTree,
      transitionReceiptHash: intent.transitionReceiptHash,
      completedPhaseId: intent.completedPhaseId,
      activatedPhaseId: intent.activatedPhaseId,
      ledgerRevision: intent.ledgerRevision,
      ledgerSha256: intent.ledgerSha256,
      externalCertificationHash: intent.externalCertificationHash,
      controllerHost: intent.controllerHost,
      controllerLeaseFence: intent.controllerLeaseFence,
    },
  );
  const hostValidation = validateHostDurability(hostDurabilityReceipt, {
    nowMs,
    localHost: intent.controllerHost,
  });
  if (!isPlainObject(hostValidation) || hostValidation.valid !== true) {
    fail("HOST_DURABILITY_INVALID", "fresh host durability is invalid", {
      errors: hostValidation?.errors || [],
    });
  }
  ensureCasRoot(casRoot);
  const existingPointer = readCurrentPointer(casRoot);
  const actualPointerHash = existingPointer?.pointerHash || null;
  const ledgerTransition = validateLedgerTransition(
    ledger,
    intent,
    existingPointer,
  );
  if (!ledgerTransition.valid) {
    fail(
      "ACTIVATION_LEDGER_TRANSITION_INVALID",
      "activation does not extend the canonical phase ledger",
      { errors: ledgerTransition.errors },
    );
  }
  const unsignedMarker = {
    schema: REPLAY_MARKER_SCHEMA,
    replayKeySha256: external.replayKeySha256,
    externalCertificationHash: certificationHash,
    activationIntentHash: intent.intentHash,
    completedPhaseId: intent.completedPhaseId,
    activatedPhaseId: intent.activatedPhaseId,
    candidateCommit: intent.candidateCommit,
    transitionCommit: intent.transitionCommit,
    remoteRef: intent.remoteRef,
    consumptionScope: "single-controller-transition",
    multiHostSafe: false,
    consumedAt: issuedAt,
  };
  const marker = {
    ...unsignedMarker,
    markerHash: hashWithoutField(unsignedMarker, "markerHash"),
  };
  const markerValidation = validateReplayMarker(marker);
  if (!markerValidation.valid) {
    fail("REPLAY_MARKER_INVALID", "replay marker is invalid", {
      errors: markerValidation.errors,
    });
  }
  const unsignedReceipt = {
    schema: ACTIVATION_RECEIPT_SCHEMA,
    authorityClass: AUTHORITY_CLASS,
    productionAuthority: false,
    validity: VALIDITY_CLASS,
    completedPhaseId: intent.completedPhaseId,
    activatedPhaseId: intent.activatedPhaseId,
    ledgerRevision: intent.ledgerRevision,
    ledgerSha256: intent.ledgerSha256,
    scopeBaseCommit: intent.scopeBaseCommit,
    candidateCommit: intent.candidateCommit,
    transitionCommit: intent.transitionCommit,
    transitionParent: intent.transitionParent,
    transitionTree: intent.transitionTree,
    transitionReceiptHash: intent.transitionReceiptHash,
    remoteRef: intent.remoteRef,
    remoteReadbackCommit: transitionReadback.commit,
    authorityCommit: intent.authorityCommit,
    externalCertificationHash: certificationHash,
    externalReplayKeySha256: external.replayKeySha256,
    attestationBodySha256: intent.attestationBodySha256,
    qualityVerdictHash: intent.qualityVerdictHash,
    evidenceManifestSha256: intent.evidenceManifestSha256,
    requestNonce: intent.requestNonce,
    activationIntentHash: intent.intentHash,
    replayMarkerHash: marker.markerHash,
    automationContractSha256: intent.automationContractSha256,
    allowedPathsSha256: intent.allowedPathsSha256,
    hostDurabilityReceiptHash,
    casRootIdentitySha256: intent.casRootIdentitySha256,
    controllerHost: intent.controllerHost,
    controllerLeaseFence: intent.controllerLeaseFence,
    intentCreatedAt: intent.createdAt,
    issuedAt,
  };
  const receipt = {
    ...unsignedReceipt,
    receiptHash: hashWithoutField(unsignedReceipt, "receiptHash"),
  };
  const receiptValidation = validateActivationReceipt(receipt);
  if (!receiptValidation.valid) {
    fail("ACTIVATION_RECEIPT_INVALID", "activation receipt is invalid", {
      errors: receiptValidation.errors,
    });
  }
  if (
    existingPointer &&
    existingPointer.activationReceiptHash === receipt.receiptHash
  ) {
    const existingReceipt = readCasObject(
      casRoot,
      "activations",
      receipt.receiptHash,
    );
    if (stableJson(existingReceipt) !== stableJson(receipt)) {
      fail(
        "ACTIVATION_RESUME_MISMATCH",
        "completed activation differs during resume",
      );
    }
    return {
      ok: true,
      schema: CAS_SCHEMA,
      activationReceipt: receipt,
      pointer: existingPointer,
      replayMarker: marker,
      resumed: true,
    };
  }
  if (actualPointerHash !== expectedPreviousPointerHash) {
    fail("POINTER_CAS_MISMATCH", "activation pointer precondition failed", {
      expectedPreviousPointerHash,
      actualPointerHash,
    });
  }
  const intentPreexisted = fs.existsSync(
    casPath(casRoot, "intents", intent.intentHash),
  );
  const markerPreexisted = fs.existsSync(
    casPath(casRoot, "replay", marker.replayKeySha256),
  );
  const receiptPreexisted = fs.existsSync(
    casPath(casRoot, "activations", receipt.receiptHash),
  );
  writeCasObject(
    casRoot,
    "certifications",
    certificationHash,
    certification,
  );
  writeCasObject(casRoot, "intents", intent.intentHash, intent);
  writeCasObject(casRoot, "replay", marker.replayKeySha256, marker);
  if (faultAfter === "replay") {
    fail("INJECTED_CRASH_AFTER_REPLAY", "injected crash after replay");
  }
  writeCasObject(casRoot, "activations", receipt.receiptHash, receipt);
  if (faultAfter === "receipt") {
    fail("INJECTED_CRASH_AFTER_RECEIPT", "injected crash after receipt");
  }
  const pointerBody = {
    schema: ACTIVATION_POINTER_SCHEMA,
    sequence: (existingPointer?.sequence || 0) + 1,
    phaseId: receipt.activatedPhaseId,
    ledgerRevision: receipt.ledgerRevision,
    activationReceiptHash: receipt.receiptHash,
    previousPointerHash: actualPointerHash,
    updatedAt: issuedAt,
  };
  const pointer = {
    ...pointerBody,
    pointerHash: hashWithoutField(pointerBody, "pointerHash"),
  };
  replaceCurrentPointer(casRoot, pointer, actualPointerHash);
  if (faultAfter === "advance") {
    fail("INJECTED_CRASH_AFTER_ADVANCE", "injected crash after advance");
  }
  return {
    ok: true,
    schema: CAS_SCHEMA,
    activationReceipt: receipt,
    pointer,
    replayMarker: marker,
    resumed: intentPreexisted || markerPreexisted || receiptPreexisted,
  };
}

function validateCurrentActivation({
  casRoot,
  ledger,
  phase,
  automationContractSha256,
  allowedPathsSha256,
  resolveTransitionReadback,
  validateExternalCertification,
  validateHostDurability,
  freshHostDurabilityReceipt,
  nowMs = Date.now(),
} = {}) {
  const errors = [];
  try {
    if (
      typeof resolveTransitionReadback !== "function" ||
      typeof validateExternalCertification !== "function" ||
      typeof validateHostDurability !== "function"
    ) {
      fail("ACTIVATION_DEPENDENCY_MISSING", "activation dependencies are missing");
    }
    const pointer = readCurrentPointer(casRoot);
    if (!pointer) fail("ACTIVATION_POINTER_MISSING", "activation pointer is missing");
    const receipt = readCasObject(
      casRoot,
      "activations",
      pointer.activationReceiptHash,
    );
    const receiptValidation = validateActivationReceipt(receipt);
    if (!receiptValidation.valid) {
      fail("ACTIVATION_RECEIPT_INVALID", "activation receipt is invalid", {
        errors: receiptValidation.errors,
      });
    }
    const freshHostValidation = validateHostDurability(
      freshHostDurabilityReceipt,
      {
        nowMs,
        localHost: receipt.controllerHost,
      },
    );
    if (!isPlainObject(freshHostValidation) || freshHostValidation.valid !== true) {
      fail("FRESH_HOST_REQUIRED", "every wake requires a fresh host receipt");
    }
    if (
      pointer.phaseId !== receipt.activatedPhaseId ||
      pointer.ledgerRevision !== receipt.ledgerRevision ||
      pointer.activationReceiptHash !== receipt.receiptHash ||
      phase?.id !== receipt.activatedPhaseId ||
      ledger?.activePhaseId !== receipt.activatedPhaseId ||
      ledger?.revision !== receipt.ledgerRevision ||
      receipt.ledgerSha256 !== sha256(stableJson(ledger)) ||
      receipt.automationContractSha256 !== automationContractSha256 ||
      receipt.allowedPathsSha256 !== allowedPathsSha256 ||
      receipt.casRootIdentitySha256 !== casRootIdentitySha256(casRoot)
    ) {
      fail("ACTIVATION_STATE_MISMATCH", "activation does not match current phase");
    }
    const previousPointer =
      pointer.previousPointerHash === null
        ? null
        : readCasObject(
            casRoot,
            "pointers",
            pointer.previousPointerHash,
          );
    const ledgerTransition = validateLedgerTransition(
      ledger,
      receipt,
      previousPointer,
    );
    if (!ledgerTransition.valid) {
      fail(
        "ACTIVATION_LEDGER_TRANSITION_INVALID",
        "current activation is not a legal ledger successor",
        { errors: ledgerTransition.errors },
      );
    }
    const certification = readCasObject(
      casRoot,
      "certifications",
      receipt.externalCertificationHash,
    );
    const external = normalizeExternalValidation(
      validateExternalCertification(certification, {
        phaseId: receipt.completedPhaseId,
        scopeBaseCommit: receipt.scopeBaseCommit,
        candidateCommit: receipt.candidateCommit,
        authorityCommit: receipt.authorityCommit,
      }),
      {
        certificationHash: receipt.externalCertificationHash,
        attestationBodySha256: receipt.attestationBodySha256,
        qualityVerdictHash: receipt.qualityVerdictHash,
        evidenceManifestSha256: receipt.evidenceManifestSha256,
        requestNonce: receipt.requestNonce,
        phaseId: receipt.completedPhaseId,
        scopeBaseCommit: receipt.scopeBaseCommit,
        candidateCommit: receipt.candidateCommit,
        authorityCommit: receipt.authorityCommit,
      },
    );
    if (external.replayKeySha256 !== receipt.externalReplayKeySha256) {
      fail("ACTIVATION_REPLAY_KEY_MISMATCH", "activation replay key is invalid");
    }
    const intent = readCasObject(
      casRoot,
      "intents",
      receipt.activationIntentHash,
    );
    const intentValidation = validateIntent(intent);
    const intentBindings = {
      completedPhaseId: receipt.completedPhaseId,
      activatedPhaseId: receipt.activatedPhaseId,
      ledgerRevision: receipt.ledgerRevision,
      ledgerSha256: receipt.ledgerSha256,
      scopeBaseCommit: receipt.scopeBaseCommit,
      candidateCommit: receipt.candidateCommit,
      transitionCommit: receipt.transitionCommit,
      transitionParent: receipt.transitionParent,
      transitionTree: receipt.transitionTree,
      transitionReceiptHash: receipt.transitionReceiptHash,
      remoteRef: receipt.remoteRef,
      authorityCommit: receipt.authorityCommit,
      externalCertificationHash: receipt.externalCertificationHash,
      attestationBodySha256: receipt.attestationBodySha256,
      qualityVerdictHash: receipt.qualityVerdictHash,
      evidenceManifestSha256: receipt.evidenceManifestSha256,
      requestNonce: receipt.requestNonce,
      automationContractSha256: receipt.automationContractSha256,
      allowedPathsSha256: receipt.allowedPathsSha256,
      casRootIdentitySha256: receipt.casRootIdentitySha256,
      controllerHost: receipt.controllerHost,
      controllerLeaseFence: receipt.controllerLeaseFence,
      createdAt: receipt.intentCreatedAt,
    };
    if (
      !intentValidation.valid ||
      intent.intentHash !== receipt.activationIntentHash ||
      Object.entries(intentBindings).some(
        ([key, value]) => intent[key] !== value,
      )
    ) {
      fail("ACTIVATION_INTENT_MISMATCH", "activation intent is invalid", {
        errors: intentValidation.errors,
      });
    }
    const marker = readCasObject(
      casRoot,
      "replay",
      receipt.externalReplayKeySha256,
    );
    const markerValidation = validateReplayMarker(marker);
    if (
      !markerValidation.valid ||
      marker.markerHash !== receipt.replayMarkerHash ||
      marker.replayKeySha256 !== receipt.externalReplayKeySha256 ||
      marker.externalCertificationHash !== receipt.externalCertificationHash ||
      marker.activationIntentHash !== receipt.activationIntentHash ||
      marker.completedPhaseId !== receipt.completedPhaseId ||
      marker.activatedPhaseId !== receipt.activatedPhaseId ||
      marker.candidateCommit !== receipt.candidateCommit ||
      marker.transitionCommit !== receipt.transitionCommit ||
      marker.remoteRef !== receipt.remoteRef
    ) {
      fail("ACTIVATION_REPLAY_INVALID", "activation replay marker is invalid");
    }
    normalizeTransitionReadback(
      resolveTransitionReadback(receipt.remoteRef),
      {
        commit: receipt.transitionCommit,
        parent: receipt.transitionParent,
        tree: receipt.transitionTree,
        transitionReceiptHash: receipt.transitionReceiptHash,
        completedPhaseId: receipt.completedPhaseId,
        activatedPhaseId: receipt.activatedPhaseId,
        ledgerRevision: receipt.ledgerRevision,
        ledgerSha256: receipt.ledgerSha256,
        externalCertificationHash: receipt.externalCertificationHash,
        controllerHost: receipt.controllerHost,
        controllerLeaseFence: receipt.controllerLeaseFence,
      },
    );
    return {
      valid: true,
      errors: [],
      builderAuthority: true,
      productionAuthority: false,
      phaseId: receipt.activatedPhaseId,
      completedPhaseId: receipt.completedPhaseId,
      activationReceiptHash: receipt.receiptHash,
      pointerHash: pointer.pointerHash,
    };
  } catch (error) {
    if (!(error instanceof ActivationCasError)) throw error;
    errors.push(`${error.code}: ${error.message}`);
    return {
      valid: false,
      errors,
      builderAuthority: false,
      productionAuthority: false,
    };
  }
}

module.exports = {
  ACTIVATION_ADVANCE_SCHEMA,
  ACTIVATION_INTENT_SCHEMA,
  ACTIVATION_POINTER_SCHEMA,
  ACTIVATION_RECEIPT_SCHEMA,
  AUTHORITY_CLASS,
  CAS_SCHEMA,
  CAS_GENESIS_FILE,
  CAS_GENESIS_SCHEMA,
  REPLAY_MARKER_SCHEMA,
  VALIDITY_CLASS,
  ActivationCasError,
  advanceSlotKey,
  casPath,
  casRootIdentitySha256,
  ensureCasRoot,
  hashWithoutField,
  issueActivation,
  initializeCasRootIdentity,
  readAdvance,
  readCasObject,
  readCasRootIdentity,
  readCurrentPointer,
  requireCasRoot,
  replaceCurrentPointer,
  sha256,
  stableJson,
  validateActivationReceipt,
  validateAdvance,
  validateCurrentActivation,
  validateIntent,
  validateLedgerTransition,
  validatePointer,
  validatePointerHistory,
  validateReplayMarker,
  writeCasObject,
};

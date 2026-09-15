"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const activationCas = require("./pikiio-activation-cas");
const externalCi = require("./pikiio-external-ci-proof");

const INTENT_SCHEMA = "pikiio-proof-ceremony-intent-v1";
const CAPABILITY_SCHEMA = "pikiio-proof-ceremony-capability-v1";
const JOURNAL_SCHEMA = "pikiio-proof-ceremony-journal-v1";
const STAGE_RECEIPT_SCHEMA = "pikiio-proof-ceremony-stage-receipt-v1";
const STAGE_SLOT_SCHEMA = "pikiio-proof-ceremony-stage-slot-v1";
const PACKAGE_SCHEMA = "pikiio-external-ci-package-v3";
const ARTIFACT_SCHEMA = "pikiio-external-ci-package-artifact-v1";
const ENVELOPE_SCHEMA = "pikiio-proof-ceremony-envelope-v1";
const REPLAY_SCHEMA = "pikiio-proof-ceremony-replay-consumption-v1";
const TRANSITION_SCHEMA = "pikiio-proof-ceremony-transition-result-v1";
const PUSH_SCHEMA = "pikiio-proof-ceremony-push-result-v1";
const DISPATCH_SCHEMA = "pikiio-proof-ceremony-dispatch-v1";
const TRANSITION_REQUEST_SCHEMA =
  "pikiio-proof-ceremony-transition-request-v1";
const PUSH_REQUEST_SCHEMA = "pikiio-proof-ceremony-push-request-v1";
const RESULT_SCHEMA = "pikiio-proof-ceremony-result-v1";
const TRANSITION_ADAPTER_SCHEMA =
  "pikiio-proof-ceremony-transition-adapter-v3";

const MAX_JSON_BYTES = 80 * 1024 * 1024;
const MAX_SMALL_JSON_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_PATTERN = /^(?:GOV|TRUTH|ACTION)-[0-9]{2}$/;
const REMOTE_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const STAGES = Object.freeze([
  "candidate",
  "request",
  "external_package",
  "verified",
  "envelope",
  "replay",
  "transition",
  "commit_push",
  "remote_readback",
  "activation",
]);

const INTENT_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "controllerId",
  "completedPhaseId",
  "activatedPhaseId",
  "authorityCommit",
  "scopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "transitionAdapterSha256",
  "requestNonce",
  "remoteUrl",
  "remoteRef",
  "ledgerRevision",
  "ledgerSha256",
  "automationContractSha256",
  "allowedPathsSha256",
  "expectedTransitionPaths",
  "commitMessage",
  "controllerHost",
  "controllerLeaseFence",
  "activationCasRoot",
  "activationCasRootIdentitySha256",
  "expectedPreviousActivationPointerHash",
  "createdAt",
  "productionAuthority",
  "intentHash",
]);
const CAPABILITY_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "controllerId",
  "intentHash",
  "allowExternalDispatch",
  "allowCanonicalTransition",
  "allowCommitPush",
  "allowActivation",
  "expiresAt",
  "productionAuthority",
  "capabilityHash",
]);
const JOURNAL_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "intentHash",
  "intentObjectSha256",
  "revision",
  "completedStages",
  "stageReceiptHashes",
  "stageReceiptObjectSha256s",
  "currentReceiptHash",
  "updatedAt",
  "productionAuthority",
  "journalHash",
]);
const RECEIPT_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "intentHash",
  "stage",
  "stageIndex",
  "previousReceiptHash",
  "payload",
  "payloadSha256",
  "recordedAt",
  "productionAuthority",
  "receiptHash",
]);
const SLOT_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "intentHash",
  "stage",
  "stageIndex",
  "receiptHash",
  "receiptObjectSha256",
  "slotHash",
]);
const PACKAGE_KEYS = Object.freeze([
  "schema",
  "materialization",
  "primaryJudge",
  "independentJudge",
  "verdict",
  "certification",
  "artifacts",
  "productionAuthority",
]);
const ARTIFACT_KEYS = Object.freeze([
  "schema",
  "address",
  "encoding",
  "byteLength",
  "sha256",
  "bytes",
]);
const ENVELOPE_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "intentHash",
  "requestReceiptHash",
  "externalPackageReceiptHash",
  "verificationReceiptHash",
  "completedPhaseId",
  "activatedPhaseId",
  "authorityCommit",
  "scopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "certificationHash",
  "qualityVerdictHash",
  "evidenceManifestSha256",
  "attestationBodySha256",
  "replayKeySha256",
  "productionAuthority",
  "envelopeHash",
]);
const REPLAY_KEYS = Object.freeze([
  "schema",
  "replayKeySha256",
  "certificationHash",
  "ceremonyId",
  "controllerId",
  "intentHash",
  "envelopeHash",
  "consumptionScope",
  "consumedAt",
  "productionAuthority",
  "markerHash",
]);
const TRANSITION_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "idempotencyKey",
  "transitionAdapterSha256",
  "completedPhaseId",
  "activatedPhaseId",
  "baseCommit",
  "ledgerRevision",
  "changedPaths",
  "envelopeHash",
  "replayMarkerHash",
  "productionAuthority",
]);
const TRANSITION_ADAPTER_KEYS = Object.freeze([
  "schema",
  "adapterSha256",
  "canonicalIntegration",
  "simulationOnly",
  "productionAuthority",
]);
const PUSH_KEYS = Object.freeze([
  "schema",
  "ceremonyId",
  "idempotencyKey",
  "baseCommit",
  "commit",
  "tree",
  "parent",
  "remoteRef",
  "changedPaths",
  "transitionReceiptHash",
  "pushed",
  "productionAuthority",
]);

class ProofCeremonyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProofCeremonyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProofCeremonyError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
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
      fail("NON_CANONICAL_JSON", "numbers must be finite canonical JSON values");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    fail("NON_CANONICAL_JSON", "only plain JSON values are permitted");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function clone(value) {
  return JSON.parse(stableJson(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
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
    fail("INVALID_COMMIT", `${label} must be one full lowercase Git commit`);
  }
}

function requirePhase(value, label) {
  if (typeof value !== "string" || !PHASE_PATTERN.test(value)) {
    fail("INVALID_PHASE", `${label} is not a canonical phase`);
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

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("INVALID_INTEGER", `${label} must be a safe integer at least ${minimum}`);
  }
}

function requireFalse(value, label) {
  if (value !== false) {
    fail(
      "PRODUCTION_AUTHORITY_FORBIDDEN",
      `${label} must remain categorically false`,
    );
  }
}

function requireBoundedString(value, label, maximum = 1024) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    value.includes("\0")
  ) {
    fail("INVALID_STRING", `${label} must be a bounded non-empty string`);
  }
}

function requireRemoteUrl(value) {
  requireBoundedString(value, "remoteUrl", 2048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("INVALID_REMOTE_URL", "remoteUrl must be canonical HTTPS");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== value ||
    !parsed.hostname ||
    !parsed.pathname.endsWith(".git")
  ) {
    fail("INVALID_REMOTE_URL", "remoteUrl must be canonical credential-free HTTPS");
  }
}

function requireRemoteRef(value) {
  if (
    typeof value !== "string" ||
    !REMOTE_REF_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    fail("INVALID_REMOTE_REF", "remoteRef must be one canonical branch ref");
  }
}

function requireRelativePath(value, label) {
  requireBoundedString(value, label, 1024);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\n") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("INVALID_REPOSITORY_PATH", `${label} is not a canonical relative path`);
  }
}

function validatePathList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    fail("INVALID_PATH_SET", `${label} must be a bounded non-empty path array`);
  }
  let prior = "";
  for (const [index, entry] of value.entries()) {
    requireRelativePath(entry, `${label}[${index}]`);
    if (entry <= prior) {
      fail("NON_CANONICAL_PATH_SET", `${label} must be sorted and unique`);
    }
    prior = entry;
  }
}

function validateIntent(intent) {
  exactKeys(intent, INTENT_KEYS, "ceremony intent");
  if (intent.schema !== INTENT_SCHEMA) {
    fail("INVALID_SCHEMA", "ceremony intent schema is invalid");
  }
  for (const key of [
    "ceremonyId",
    "controllerId",
    "requestNonce",
    "ledgerSha256",
    "automationContractSha256",
    "allowedPathsSha256",
    "transitionAdapterSha256",
    "intentHash",
  ]) {
    requireHash(intent[key], `intent.${key}`);
  }
  requirePhase(intent.completedPhaseId, "intent.completedPhaseId");
  requirePhase(intent.activatedPhaseId, "intent.activatedPhaseId");
  if (intent.completedPhaseId === intent.activatedPhaseId) {
    fail(
      "PHASE_TRANSITION_EMPTY",
      "completedPhaseId and activatedPhaseId must differ",
    );
  }
  for (const key of [
    "authorityCommit",
    "scopeBaseCommit",
    "candidateCommit",
    "candidateTree",
  ]) {
    requireCommit(intent[key], `intent.${key}`);
  }
  if (
    new Set([
      intent.authorityCommit,
      intent.scopeBaseCommit,
      intent.candidateCommit,
    ]).size !== 3
  ) {
    fail("COMMIT_ROLE_COLLISION", "authority A, scope S, and candidate C differ");
  }
  requireRemoteUrl(intent.remoteUrl);
  requireRemoteRef(intent.remoteRef);
  requireInteger(intent.ledgerRevision, "intent.ledgerRevision", 1);
  validatePathList(intent.expectedTransitionPaths, "expectedTransitionPaths");
  requireBoundedString(intent.commitMessage, "intent.commitMessage", 512);
  if (/[\r\n]/u.test(intent.commitMessage)) {
    fail("INVALID_COMMIT_MESSAGE", "commitMessage must be one line");
  }
  requireBoundedString(intent.controllerHost, "intent.controllerHost", 255);
  requireInteger(
    intent.controllerLeaseFence,
    "intent.controllerLeaseFence",
    1,
  );
  if (
    typeof intent.activationCasRoot !== "string" ||
    !path.isAbsolute(intent.activationCasRoot) ||
    path.resolve(intent.activationCasRoot) !== intent.activationCasRoot
  ) {
    fail(
      "ACTIVATION_CAS_ROOT_INVALID",
      "activationCasRoot must be one exact absolute path",
    );
  }
  requireHash(
    intent.activationCasRootIdentitySha256,
    "intent.activationCasRootIdentitySha256",
  );
  if (
    activationCas.casRootIdentitySha256(intent.activationCasRoot) !==
    intent.activationCasRootIdentitySha256
  ) {
    fail(
      "ACTIVATION_CAS_ROOT_IDENTITY_MISMATCH",
      "activation CAS root identity differs from the intent",
    );
  }
  if (intent.expectedPreviousActivationPointerHash !== null) {
    requireHash(
      intent.expectedPreviousActivationPointerHash,
      "intent.expectedPreviousActivationPointerHash",
    );
  }
  requireTimestamp(intent.createdAt, "intent.createdAt");
  requireFalse(intent.productionAuthority, "intent.productionAuthority");
  if (intent.intentHash !== hashWithoutField(intent, "intentHash")) {
    fail("HASH_MISMATCH", "ceremony intent hash does not match");
  }
  if (Buffer.byteLength(stableJson(intent), "utf8") > 64 * 1024) {
    fail("SIZE_LIMIT_EXCEEDED", "ceremony intent is oversized");
  }
  return clone(intent);
}

function sealCeremonyIntent(fields) {
  const source = { ...fields };
  delete source.schema;
  delete source.productionAuthority;
  delete source.intentHash;
  delete source.activationCasRootIdentitySha256;
  const intent = {
    ...clone(source),
    schema: INTENT_SCHEMA,
    activationCasRootIdentitySha256:
      activationCas.casRootIdentitySha256(source.activationCasRoot),
    productionAuthority: false,
    intentHash: "0".repeat(64),
  };
  intent.intentHash = hashWithoutField(intent, "intentHash");
  return validateIntent(intent);
}

function validateCapability(capability, intent, nowMs) {
  exactKeys(capability, CAPABILITY_KEYS, "ceremony capability");
  if (capability.schema !== CAPABILITY_SCHEMA) {
    fail("INVALID_SCHEMA", "ceremony capability schema is invalid");
  }
  for (const key of [
    "ceremonyId",
    "controllerId",
    "intentHash",
    "capabilityHash",
  ]) {
    requireHash(capability[key], `capability.${key}`);
  }
  if (
    capability.ceremonyId !== intent.ceremonyId ||
    capability.controllerId !== intent.controllerId ||
    capability.intentHash !== intent.intentHash
  ) {
    fail("CAPABILITY_SCOPE_MISMATCH", "capability does not bind the ceremony");
  }
  for (const key of [
    "allowExternalDispatch",
    "allowCanonicalTransition",
    "allowCommitPush",
    "allowActivation",
  ]) {
    if (capability[key] !== true) {
      fail("CAPABILITY_INCOMPLETE", `capability.${key} must be true`);
    }
  }
  requireTimestamp(capability.expiresAt, "capability.expiresAt");
  if (Date.parse(capability.expiresAt) < nowMs) {
    fail("CAPABILITY_EXPIRED", "ceremony capability is expired");
  }
  requireFalse(capability.productionAuthority, "capability.productionAuthority");
  if (
    capability.capabilityHash !==
    hashWithoutField(capability, "capabilityHash")
  ) {
    fail("HASH_MISMATCH", "ceremony capability hash does not match");
  }
  return clone(capability);
}

function sealCeremonyCapability(fields) {
  const capability = {
    ...clone(fields),
    schema: CAPABILITY_SCHEMA,
    productionAuthority: false,
    capabilityHash: "0".repeat(64),
  };
  capability.capabilityHash = hashWithoutField(
    capability,
    "capabilityHash",
  );
  return capability;
}

function validateTransitionAdapter(adapter, intent, mode) {
  exactKeys(adapter, TRANSITION_ADAPTER_KEYS, "transition adapter");
  if (adapter.schema !== TRANSITION_ADAPTER_SCHEMA) {
    fail("TRANSITION_ADAPTER_INVALID", "transition adapter schema is invalid");
  }
  requireHash(adapter.adapterSha256, "transitionAdapter.adapterSha256");
  requireFalse(
    adapter.productionAuthority,
    "transitionAdapter.productionAuthority",
  );
  if (
    adapter.adapterSha256 !==
      hashWithoutField(adapter, "adapterSha256") ||
    adapter.adapterSha256 !== intent.transitionAdapterSha256
  ) {
    fail(
      "TRANSITION_ADAPTER_IDENTITY_MISMATCH",
      "transition adapter identity differs from the intent",
    );
  }
  if (mode === "dry-run") {
    if (
      adapter.canonicalIntegration !== false ||
      adapter.simulationOnly !== true
    ) {
      fail(
        "DRY_RUN_ADAPTER_INVALID",
        "dry-run requires an explicitly simulation-only adapter",
      );
    }
  } else if (
    adapter.canonicalIntegration !== true ||
    adapter.simulationOnly !== false
  ) {
    fail(
      "CANONICAL_V3_TRANSITION_ADAPTER_REQUIRED",
      "live mode requires a canonical v3 transition adapter",
    );
  }
  return clone(adapter);
}

function sealTransitionAdapter(fields) {
  const adapter = {
    ...clone(fields),
    schema: TRANSITION_ADAPTER_SCHEMA,
    productionAuthority: false,
    adapterSha256: "0".repeat(64),
  };
  adapter.adapterSha256 = hashWithoutField(adapter, "adapterSha256");
  return adapter;
}

function requireCanonicalRoot(root, { initialize = false } = {}) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root.includes("\0")
  ) {
    fail("INVALID_ROOT", "ceremony root must be one normalized absolute path");
  }
  let stat;
  let real;
  try {
    stat = fs.lstatSync(root, { bigint: true });
    real = fs.realpathSync.native(root);
  } catch (error) {
    fail("ROOT_UNREADABLE", "ceremony root must already exist", {
      cause: error.code || error.message,
    });
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    real !== root ||
    (stat.mode & 0o022n) !== 0n ||
    (typeof process.getuid === "function" &&
      stat.uid !== BigInt(process.getuid()))
  ) {
    fail("ROOT_UNSAFE", "ceremony root must be a real owner-controlled directory");
  }
  for (const name of ["objects", "journals", "slots", "replay", "locks"]) {
    const directory = path.join(root, name);
    if (!fs.existsSync(directory)) {
      if (!initialize) continue;
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const child = fs.lstatSync(directory, { bigint: true });
    if (
      !child.isDirectory() ||
      child.isSymbolicLink() ||
      fs.realpathSync.native(directory) !== directory ||
      (child.mode & 0o022n) !== 0n
    ) {
      fail("ROOT_UNSAFE", `${name} must be a real owner-controlled directory`);
    }
  }
  return root;
}

function canonicalBytes(value, maximum = MAX_JSON_BYTES) {
  const bytes = Buffer.from(`${stableJson(value)}\n`, "utf8");
  if (bytes.length < 3 || bytes.length > maximum) {
    fail("SIZE_LIMIT_EXCEEDED", "canonical object exceeds its size boundary");
  }
  return bytes;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRegular(filePath, maximum = MAX_JSON_BYTES) {
  let before;
  let descriptor;
  try {
    before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size < 3n ||
      before.size > BigInt(maximum) ||
      (before.mode & 0o022n) !== 0n
    ) {
      fail("OBJECT_UNSAFE", "ceremony object is not a bounded regular file");
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      fail("OBJECT_CHANGED", "ceremony object changed while opening");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      bytes.length !== Number(opened.size)
    ) {
      fail("OBJECT_CHANGED", "ceremony object changed while reading");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseCanonical(bytes, label, maximum = MAX_JSON_BYTES) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail("INVALID_JSON", `${label} is not UTF-8 JSON`, {
      cause: error.message,
    });
  }
  if (!isPlainObject(value) || !bytes.equals(canonicalBytes(value, maximum))) {
    fail("NON_CANONICAL_JSON", `${label} is not canonical JSON`);
  }
  return value;
}

function atomicCreate(filePath, bytes) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, filePath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readRegular(filePath, bytes.length);
      if (!existing.equals(bytes)) {
        fail("CAS_COLLISION", "fixed ceremony address contains different bytes");
      }
    }
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function atomicReplace(filePath, bytes) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function objectPath(root, objectSha256) {
  requireHash(objectSha256, "objectSha256");
  return path.join(root, "objects", `${objectSha256}.json`);
}

function writeObject(root, value, maximum = MAX_JSON_BYTES) {
  requireCanonicalRoot(root, { initialize: true });
  const bytes = canonicalBytes(value, maximum);
  const objectSha256 = sha256(bytes);
  atomicCreate(objectPath(root, objectSha256), bytes);
  const readBack = readRegular(objectPath(root, objectSha256), maximum);
  if (!readBack.equals(bytes)) {
    fail("CAS_READBACK_MISMATCH", "ceremony CAS read-back differs");
  }
  return { objectSha256, byteLength: bytes.length };
}

function readObject(root, objectSha256, maximum = MAX_JSON_BYTES) {
  requireCanonicalRoot(root);
  const bytes = readRegular(objectPath(root, objectSha256), maximum);
  if (sha256(bytes) !== objectSha256) {
    fail("CAS_HASH_MISMATCH", "ceremony CAS object digest differs");
  }
  return parseCanonical(bytes, "ceremony CAS object", maximum);
}

function stageSlotPath(
  root,
  ceremonyId,
  stageIndex,
  { initialize = false } = {},
) {
  requireHash(ceremonyId, "ceremonyId");
  requireInteger(stageIndex, "stageIndex");
  const directory = path.join(root, "slots", ceremonyId);
  if (!fs.existsSync(directory) && initialize) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return path.join(directory, `${String(stageIndex).padStart(2, "0")}.json`);
}

function journalPath(root, ceremonyId) {
  requireHash(ceremonyId, "ceremonyId");
  return path.join(root, "journals", `${ceremonyId}.json`);
}

function lockPath(root, ceremonyId) {
  return path.join(root, "locks", `${ceremonyId}.lock`);
}

function withCeremonyLock(root, ceremonyId, operation) {
  const target = lockPath(root, ceremonyId);
  const lockId = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(target, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${stableJson({
        schema: "pikiio-proof-ceremony-lock-v1",
        ceremonyId,
        lockId,
        pid: process.pid,
      })}\n`,
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error.code === "EEXIST") {
      fail("CEREMONY_BUSY", "another controller holds the ceremony lock");
    }
    throw error;
  }
  return Promise.resolve()
    .then(operation)
    .finally(() => {
      let current;
      try {
        current = parseCanonical(
          readRegular(target, 16 * 1024),
          "ceremony lock",
          16 * 1024,
        );
      } catch (error) {
        fail("CEREMONY_LOCK_LOST", "ceremony lock became unreadable", {
          cause: error.code || error.message,
        });
      }
      if (current.lockId !== lockId) {
        fail("CEREMONY_LOCK_LOST", "ceremony lock ownership changed");
      }
      fs.unlinkSync(target);
    });
}

function stageTimestamp(intent, stageIndex) {
  return new Date(Date.parse(intent.createdAt) + stageIndex).toISOString();
}

function initialJournal(intent, intentObjectSha256) {
  const body = {
    schema: JOURNAL_SCHEMA,
    ceremonyId: intent.ceremonyId,
    intentHash: intent.intentHash,
    intentObjectSha256,
    revision: 0,
    completedStages: [],
    stageReceiptHashes: [],
    stageReceiptObjectSha256s: [],
    currentReceiptHash: null,
    updatedAt: intent.createdAt,
    productionAuthority: false,
  };
  return { ...body, journalHash: hashWithoutField(body, "journalHash") };
}

function validateJournal(journal, intent) {
  exactKeys(journal, JOURNAL_KEYS, "ceremony journal");
  if (journal.schema !== JOURNAL_SCHEMA) {
    fail("INVALID_SCHEMA", "ceremony journal schema is invalid");
  }
  for (const key of [
    "ceremonyId",
    "intentHash",
    "intentObjectSha256",
    "journalHash",
  ]) {
    requireHash(journal[key], `journal.${key}`);
  }
  if (
    journal.ceremonyId !== intent.ceremonyId ||
    journal.intentHash !== intent.intentHash
  ) {
    fail("JOURNAL_FORK_REFUSED", "journal binds a different ceremony intent");
  }
  requireInteger(journal.revision, "journal.revision");
  if (
    !Array.isArray(journal.completedStages) ||
    !Array.isArray(journal.stageReceiptHashes) ||
    !Array.isArray(journal.stageReceiptObjectSha256s) ||
    journal.completedStages.length !== journal.revision ||
    journal.stageReceiptHashes.length !== journal.revision ||
    journal.stageReceiptObjectSha256s.length !== journal.revision ||
    journal.revision > STAGES.length ||
    journal.completedStages.some((stage, index) => stage !== STAGES[index])
  ) {
    fail("JOURNAL_SEQUENCE_INVALID", "journal stages are not one exact prefix");
  }
  for (const hash of journal.stageReceiptHashes) {
    requireHash(hash, "journal stage receipt hash");
  }
  for (const hash of journal.stageReceiptObjectSha256s) {
    requireHash(hash, "journal stage receipt object hash");
  }
  if (
    journal.currentReceiptHash !==
    (journal.stageReceiptHashes.at(-1) || null)
  ) {
    fail("JOURNAL_SEQUENCE_INVALID", "journal current receipt is inconsistent");
  }
  requireTimestamp(journal.updatedAt, "journal.updatedAt");
  requireFalse(journal.productionAuthority, "journal.productionAuthority");
  if (journal.journalHash !== hashWithoutField(journal, "journalHash")) {
    fail("HASH_MISMATCH", "journal hash does not match");
  }
  return clone(journal);
}

function writeJournal(root, journal) {
  atomicReplace(
    journalPath(root, journal.ceremonyId),
    canonicalBytes(journal, MAX_SMALL_JSON_BYTES),
  );
}

function loadOrCreateJournal(root, intent) {
  requireCanonicalRoot(root, { initialize: true });
  const target = journalPath(root, intent.ceremonyId);
  if (!fs.existsSync(target)) {
    const intentObject = writeObject(root, intent, MAX_SMALL_JSON_BYTES);
    const journal = initialJournal(intent, intentObject.objectSha256);
    atomicCreate(target, canonicalBytes(journal, MAX_SMALL_JSON_BYTES));
    return journal;
  }
  const journal = validateJournal(
    parseCanonical(
      readRegular(target, MAX_SMALL_JSON_BYTES),
      "ceremony journal",
      MAX_SMALL_JSON_BYTES,
    ),
    intent,
  );
  const storedIntent = readObject(
    root,
    journal.intentObjectSha256,
    MAX_SMALL_JSON_BYTES,
  );
  if (stableJson(storedIntent) !== stableJson(intent)) {
    fail("JOURNAL_FORK_REFUSED", "stored intent bytes differ from this retry");
  }
  return journal;
}

function validateStagePayload(stage, payload, intent) {
  if (!isPlainObject(payload)) {
    fail("STAGE_PAYLOAD_INVALID", `${stage} payload must be an object`);
  }
  requireFalse(payload.productionAuthority, `${stage}.productionAuthority`);
  switch (stage) {
    case "candidate":
      exactKeys(
        payload,
        [
          "authorityCommit",
          "scopeBaseCommit",
          "candidateCommit",
          "candidateTree",
          "candidateParent",
          "headCommit",
          "clean",
          "statusSha256",
          "productionAuthority",
        ],
        "candidate payload",
      );
      for (const key of [
        "authorityCommit",
        "scopeBaseCommit",
        "candidateCommit",
        "candidateTree",
        "candidateParent",
        "headCommit",
      ]) {
        requireCommit(payload[key], `candidate.${key}`);
      }
      requireHash(payload.statusSha256, "candidate.statusSha256");
      if (
        payload.authorityCommit !== intent.authorityCommit ||
        payload.scopeBaseCommit !== intent.scopeBaseCommit ||
        payload.candidateCommit !== intent.candidateCommit ||
        payload.candidateTree !== intent.candidateTree ||
        payload.candidateParent !== intent.scopeBaseCommit ||
        payload.headCommit !== intent.candidateCommit ||
        payload.clean !== true ||
        payload.statusSha256 !== sha256(Buffer.alloc(0))
      ) {
        fail("CANDIDATE_BINDING_MISMATCH", "candidate preflight does not bind A/S/C");
      }
      break;
    case "request":
      exactKeys(
        payload,
        ["request", "requestSha256", "productionAuthority"],
        "request payload",
      );
      externalCi.validateCertificationRequest(payload.request);
      requireHash(payload.requestSha256, "request.requestSha256");
      if (
        payload.requestSha256 !== sha256(externalCi.stableJson(payload.request)) ||
        payload.request.phaseId !== intent.completedPhaseId ||
        payload.request.phaseScopeBaseCommit !== intent.scopeBaseCommit ||
        payload.request.candidateCommit !== intent.candidateCommit ||
        payload.request.requestNonce !== intent.requestNonce
      ) {
        fail("REQUEST_BINDING_MISMATCH", "external request does not bind the intent");
      }
      break;
    case "external_package":
      exactKeys(
        payload,
        [
          "packageObjectSha256",
          "packageByteLength",
          "packageSha256",
          "productionAuthority",
        ],
        "external package payload",
      );
      requireHash(payload.packageObjectSha256, "packageObjectSha256");
      requireHash(payload.packageSha256, "packageSha256");
      requireInteger(payload.packageByteLength, "packageByteLength", 1);
      if (payload.packageObjectSha256 !== payload.packageSha256) {
        fail("PACKAGE_ADDRESS_MISMATCH", "external package address is inconsistent");
      }
      break;
    case "verified":
      exactKeys(
        payload,
        [
          "valid",
          "completedPhaseId",
          "authorityCommit",
          "scopeBaseCommit",
          "candidateCommit",
          "requestNonce",
          "qualityVerdictHash",
          "evidenceManifestSha256",
          "replayKeySha256",
          "attestationBodySha256",
          "certificationHash",
          "productionAuthority",
        ],
        "verified payload",
      );
      if (payload.valid !== true) {
        fail("EXTERNAL_VERIFICATION_FAILED", "external verification is not valid");
      }
      for (const key of [
        "qualityVerdictHash",
        "evidenceManifestSha256",
        "replayKeySha256",
        "attestationBodySha256",
        "certificationHash",
      ]) {
        requireHash(payload[key], `verified.${key}`);
      }
      if (
        payload.completedPhaseId !== intent.completedPhaseId ||
        payload.authorityCommit !== intent.authorityCommit ||
        payload.scopeBaseCommit !== intent.scopeBaseCommit ||
        payload.candidateCommit !== intent.candidateCommit ||
        payload.requestNonce !== intent.requestNonce
      ) {
        fail("VERIFICATION_BINDING_MISMATCH", "verified proof does not bind A/S/C");
      }
      break;
    case "envelope":
      exactKeys(
        payload,
        [
          "envelopeObjectSha256",
          "envelopeByteLength",
          "envelopeHash",
          "productionAuthority",
        ],
        "envelope payload",
      );
      requireHash(payload.envelopeObjectSha256, "envelopeObjectSha256");
      requireHash(payload.envelopeHash, "envelopeHash");
      requireInteger(payload.envelopeByteLength, "envelopeByteLength", 1);
      break;
    case "replay":
      exactKeys(payload, REPLAY_KEYS, "replay payload");
      validateReplayMarker(payload, intent);
      break;
    case "transition":
      exactKeys(payload, TRANSITION_KEYS, "transition payload");
      validateTransitionResult(payload, intent);
      break;
    case "commit_push":
      exactKeys(payload, PUSH_KEYS, "push payload");
      validatePushResult(payload, intent);
      break;
    case "remote_readback":
      exactKeys(
        payload,
        [
          "remoteUrl",
          "remoteRef",
          "expectedCommit",
          "observedCommit",
          "readBackAt",
          "productionAuthority",
        ],
        "remote readback payload",
      );
      requireCommit(payload.expectedCommit, "readback.expectedCommit");
      requireCommit(payload.observedCommit, "readback.observedCommit");
      requireTimestamp(payload.readBackAt, "readback.readBackAt");
      if (
        payload.remoteUrl !== intent.remoteUrl ||
        payload.remoteRef !== intent.remoteRef ||
        payload.expectedCommit !== payload.observedCommit
      ) {
        fail("REMOTE_READBACK_MISMATCH", "remote ref does not contain exact commit");
      }
      break;
    case "activation":
      exactKeys(
        payload,
        [
          "activationReceiptHash",
          "pointerHash",
          "replayMarkerHash",
          "activationCasRootIdentitySha256",
          "completedPhaseId",
          "activatedPhaseId",
          "builderAuthority",
          "productionAuthority",
        ],
        "activation payload",
      );
      for (const key of [
        "activationReceiptHash",
        "pointerHash",
        "replayMarkerHash",
        "activationCasRootIdentitySha256",
      ]) {
        requireHash(payload[key], `activation.${key}`);
      }
      if (
        payload.activationCasRootIdentitySha256 !==
          intent.activationCasRootIdentitySha256 ||
        payload.completedPhaseId !== intent.completedPhaseId ||
        payload.activatedPhaseId !== intent.activatedPhaseId ||
        payload.builderAuthority !== true
      ) {
        fail("ACTIVATION_BINDING_MISMATCH", "activation is not target-phase builder authority");
      }
      break;
    default:
      fail("UNKNOWN_STAGE", `unknown ceremony stage ${stage}`);
  }
}

function validateStageReceipt(receipt, intent, expectedIndex, previousHash) {
  exactKeys(receipt, RECEIPT_KEYS, "stage receipt");
  if (receipt.schema !== STAGE_RECEIPT_SCHEMA) {
    fail("INVALID_SCHEMA", "stage receipt schema is invalid");
  }
  requireHash(receipt.ceremonyId, "receipt.ceremonyId");
  requireHash(receipt.intentHash, "receipt.intentHash");
  requireHash(receipt.payloadSha256, "receipt.payloadSha256");
  requireHash(receipt.receiptHash, "receipt.receiptHash");
  requireInteger(receipt.stageIndex, "receipt.stageIndex");
  if (
    receipt.ceremonyId !== intent.ceremonyId ||
    receipt.intentHash !== intent.intentHash ||
    receipt.stageIndex !== expectedIndex ||
    receipt.stage !== STAGES[expectedIndex] ||
    receipt.previousReceiptHash !== previousHash
  ) {
    fail("STAGE_CHAIN_MISMATCH", "stage receipt is not the exact next chain link");
  }
  if (previousHash !== null) requireHash(previousHash, "previousReceiptHash");
  requireTimestamp(receipt.recordedAt, "receipt.recordedAt");
  requireFalse(receipt.productionAuthority, "receipt.productionAuthority");
  validateStagePayload(receipt.stage, receipt.payload, intent);
  if (receipt.payloadSha256 !== sha256(stableJson(receipt.payload))) {
    fail("HASH_MISMATCH", "stage payload digest does not match");
  }
  if (receipt.receiptHash !== hashWithoutField(receipt, "receiptHash")) {
    fail("HASH_MISMATCH", "stage receipt hash does not match");
  }
  return clone(receipt);
}

function validateSlot(slot, intent, stageIndex) {
  exactKeys(slot, SLOT_KEYS, "stage slot");
  if (slot.schema !== STAGE_SLOT_SCHEMA) {
    fail("INVALID_SCHEMA", "stage slot schema is invalid");
  }
  if (
    slot.ceremonyId !== intent.ceremonyId ||
    slot.intentHash !== intent.intentHash ||
    slot.stage !== STAGES[stageIndex] ||
    slot.stageIndex !== stageIndex
  ) {
    fail("STAGE_SLOT_FORK", "stage slot belongs to a divergent ceremony");
  }
  requireHash(slot.receiptHash, "slot.receiptHash");
  requireHash(slot.receiptObjectSha256, "slot.receiptObjectSha256");
  requireHash(slot.slotHash, "slot.slotHash");
  if (slot.slotHash !== hashWithoutField(slot, "slotHash")) {
    fail("HASH_MISMATCH", "stage slot hash does not match");
  }
  return clone(slot);
}

function readStageSlot(root, intent, stageIndex) {
  const target = stageSlotPath(root, intent.ceremonyId, stageIndex);
  if (!fs.existsSync(target)) return null;
  return validateSlot(
    parseCanonical(
      readRegular(target, 64 * 1024),
      "stage slot",
      64 * 1024,
    ),
    intent,
    stageIndex,
  );
}

function auditHistory(root, journal, intent) {
  validateJournal(journal, intent);
  const storedIntent = readObject(
    root,
    journal.intentObjectSha256,
    MAX_SMALL_JSON_BYTES,
  );
  if (stableJson(storedIntent) !== stableJson(intent)) {
    fail("JOURNAL_FORK_REFUSED", "journal intent object was substituted");
  }
  let previous = null;
  const receipts = [];
  for (let index = 0; index < journal.revision; index += 1) {
    const hash = journal.stageReceiptHashes[index];
    const objectSha256 = journal.stageReceiptObjectSha256s[index];
    const receipt = validateStageReceipt(
      readObject(root, objectSha256, MAX_JSON_BYTES),
      intent,
      index,
      previous,
    );
    const slot = readStageSlot(root, intent, index);
    if (
      !slot ||
      slot.receiptHash !== hash ||
      slot.receiptObjectSha256 !== objectSha256
    ) {
      fail("STAGE_SLOT_MISSING", "journaled stage lacks its exact durable slot");
    }
    receipts.push(receipt);
    previous = hash;
  }
  return receipts;
}

function appendReceipt(root, journal, intent, receipt, receiptObjectSha256) {
  requireHash(receiptObjectSha256, "receiptObjectSha256");
  const next = {
    schema: JOURNAL_SCHEMA,
    ceremonyId: journal.ceremonyId,
    intentHash: journal.intentHash,
    intentObjectSha256: journal.intentObjectSha256,
    revision: journal.revision + 1,
    completedStages: [...journal.completedStages, receipt.stage],
    stageReceiptHashes: [
      ...journal.stageReceiptHashes,
      receipt.receiptHash,
    ],
    stageReceiptObjectSha256s: [
      ...journal.stageReceiptObjectSha256s,
      receiptObjectSha256,
    ],
    currentReceiptHash: receipt.receiptHash,
    updatedAt: receipt.recordedAt,
    productionAuthority: false,
  };
  next.journalHash = hashWithoutField(next, "journalHash");
  validateJournal(next, intent);
  writeJournal(root, next);
  return next;
}

function persistStage({
  root,
  journal,
  intent,
  payload,
  faultAfterStage,
}) {
  const stageIndex = journal.revision;
  const stage = STAGES[stageIndex];
  validateStagePayload(stage, payload, intent);
  const body = {
    schema: STAGE_RECEIPT_SCHEMA,
    ceremonyId: intent.ceremonyId,
    intentHash: intent.intentHash,
    stage,
    stageIndex,
    previousReceiptHash: journal.currentReceiptHash,
    payload: clone(payload),
    payloadSha256: sha256(stableJson(payload)),
    recordedAt: stageTimestamp(intent, stageIndex),
    productionAuthority: false,
  };
  const receipt = {
    ...body,
    receiptHash: hashWithoutField(body, "receiptHash"),
  };
  validateStageReceipt(
    receipt,
    intent,
    stageIndex,
    journal.currentReceiptHash,
  );
  const storedReceipt = writeObject(root, receipt, MAX_JSON_BYTES);
  const slotBody = {
    schema: STAGE_SLOT_SCHEMA,
    ceremonyId: intent.ceremonyId,
    intentHash: intent.intentHash,
    stage,
    stageIndex,
    receiptHash: receipt.receiptHash,
    receiptObjectSha256: storedReceipt.objectSha256,
  };
  const slot = {
    ...slotBody,
    slotHash: hashWithoutField(slotBody, "slotHash"),
  };
  atomicCreate(
    stageSlotPath(root, intent.ceremonyId, stageIndex, { initialize: true }),
    canonicalBytes(slot, 64 * 1024),
  );
  if (faultAfterStage === stage) {
    fail("INJECTED_STAGE_CRASH", `injected crash after durable ${stage} stage`, {
      stage,
      receiptHash: receipt.receiptHash,
    });
  }
  return appendReceipt(
    root,
    journal,
    intent,
    receipt,
    storedReceipt.objectSha256,
  );
}

function resumeOrphanStage(root, journal, intent, faultAfterStage) {
  const slot = readStageSlot(root, intent, journal.revision);
  if (!slot) return null;
  const receipt = validateStageReceipt(
    readObject(root, slot.receiptObjectSha256, MAX_JSON_BYTES),
    intent,
    journal.revision,
    journal.currentReceiptHash,
  );
  if (faultAfterStage === receipt.stage) {
    fail("INJECTED_STAGE_CRASH", `injected crash after durable ${receipt.stage} stage`);
  }
  return appendReceipt(
    root,
    journal,
    intent,
    receipt,
    slot.receiptObjectSha256,
  );
}

function requireSealedGit(adapter) {
  if (!isPlainObject(adapter)) {
    fail("SEALED_GIT_REQUIRED", "one typed sealed Git adapter is required");
  }
  const required = [
    "head",
    "tree",
    "status",
    "parent",
    "isAncestor",
    "diff",
    "remoteReadback",
  ];
  for (const name of required) {
    if (typeof adapter[name] !== "function") {
      fail("SEALED_GIT_REQUIRED", `sealed Git adapter is missing ${name}`);
    }
  }
  for (const forbidden of ["exec", "execute", "run", "spawn", "command"]) {
    if (Object.hasOwn(adapter, forbidden)) {
      fail("GENERIC_COMMAND_ESCAPE_REFUSED", `sealed Git exposes ${forbidden}`);
    }
  }
  return adapter;
}

function invokeSync(name, callback, request) {
  if (typeof callback !== "function") {
    fail("CALLBACK_REQUIRED", `${name} callback is required`);
  }
  const result = callback(deepFreeze(clone(request)));
  if (result && typeof result.then === "function") {
    fail("ASYNC_CALLBACK_REFUSED", `${name} callback must be synchronous`);
  }
  return result;
}

function parseNameStatus(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail("SEALED_GIT_OUTPUT_INVALID", "Git diff must return bytes");
  }
  const fields = Buffer.from(bytes).toString("utf8").split("\0");
  if (fields.at(-1) !== "") {
    fail("SEALED_GIT_OUTPUT_INVALID", "Git name-status output is not NUL terminated");
  }
  fields.pop();
  if (fields.length % 2 !== 0) {
    fail("SEALED_GIT_OUTPUT_INVALID", "Git name-status output has invalid arity");
  }
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!/^[AMDTCUXB]$/u.test(fields[index])) {
      fail("SEALED_GIT_OUTPUT_INVALID", "Git diff status is not canonical");
    }
    requireRelativePath(fields[index + 1], "Git diff path");
    paths.push(fields[index + 1]);
  }
  return paths.sort();
}

function parseStatusPaths(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail("SEALED_GIT_OUTPUT_INVALID", "Git status must return bytes");
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0) return [];
  const records = buffer.toString("utf8").split("\0");
  if (records.at(-1) !== "") {
    fail("SEALED_GIT_OUTPUT_INVALID", "Git status output is not NUL terminated");
  }
  records.pop();
  return records
    .map((record) => {
      if (record.length < 4 || record[2] !== " ") {
        fail("SEALED_GIT_OUTPUT_INVALID", "Git status record is invalid");
      }
      const relative = record.slice(3);
      requireRelativePath(relative, "Git status path");
      return relative;
    })
    .sort();
}

function assertPathSet(actual, expected, code) {
  if (stableJson([...actual].sort()) !== stableJson([...expected].sort())) {
    fail(code, "repository path set does not match the ceremony intent", {
      actual: [...actual].sort(),
      expected: [...expected].sort(),
    });
  }
}

function candidatePayload(intent, git) {
  const headCommit = git.head();
  const status = Buffer.from(git.status());
  const candidateParent = git.parent({ commit: intent.candidateCommit });
  const candidateTree = git.tree({ commit: intent.candidateCommit });
  if (
    headCommit !== intent.candidateCommit ||
    status.length !== 0 ||
    candidateParent !== intent.scopeBaseCommit ||
    candidateTree !== intent.candidateTree ||
    git.isAncestor({
      ancestor: intent.authorityCommit,
      descendant: intent.scopeBaseCommit,
    }) !== true
  ) {
    fail("CANDIDATE_PREFLIGHT_FAILED", "candidate is stale, dirty, or unbound");
  }
  return {
    authorityCommit: intent.authorityCommit,
    scopeBaseCommit: intent.scopeBaseCommit,
    candidateCommit: intent.candidateCommit,
    candidateTree,
    candidateParent,
    headCommit,
    clean: true,
    statusSha256: sha256(status),
    productionAuthority: false,
  };
}

function assertCandidateStillClean(intent, git) {
  if (git.head() !== intent.candidateCommit) {
    fail("STALE_HEAD", "candidate HEAD moved before the next ceremony stage");
  }
  const status = Buffer.from(git.status());
  if (status.length !== 0) {
    fail("CANDIDATE_DIRTY", "candidate became dirty before transition");
  }
}

function validatePackageArtifact(artifact) {
  exactKeys(artifact, ARTIFACT_KEYS, "external package artifact");
  if (
    artifact.schema !== ARTIFACT_SCHEMA ||
    artifact.encoding !== "base64"
  ) {
    fail("PACKAGE_ARTIFACT_INVALID", "external package artifact encoding is invalid");
  }
  requireHash(artifact.sha256, "artifact.sha256");
  if (artifact.address !== `sha256:${artifact.sha256}`) {
    fail("PACKAGE_ARTIFACT_INVALID", "artifact address is not content-addressed");
  }
  requireInteger(artifact.byteLength, "artifact.byteLength", 1);
  if (
    typeof artifact.bytes !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      artifact.bytes,
    )
  ) {
    fail("PACKAGE_ARTIFACT_INVALID", "artifact bytes are not canonical base64");
  }
  const bytes = Buffer.from(artifact.bytes, "base64");
  if (
    bytes.toString("base64") !== artifact.bytes ||
    bytes.length !== artifact.byteLength ||
    sha256(bytes) !== artifact.sha256
  ) {
    fail("PACKAGE_ARTIFACT_INVALID", "artifact byte identity differs");
  }
  return bytes;
}

function validateExternalPackage(packageValue) {
  exactKeys(packageValue, PACKAGE_KEYS, "external package");
  if (packageValue.schema !== PACKAGE_SCHEMA) {
    fail("INVALID_SCHEMA", "external package schema is invalid");
  }
  requireFalse(
    packageValue.productionAuthority,
    "externalPackage.productionAuthority",
  );
  externalCi.validateMaterializationReceipt(packageValue.materialization);
  externalCi.validateJudgeReceipt(packageValue.primaryJudge, "primary");
  externalCi.validateJudgeReceipt(packageValue.independentJudge, "independent");
  externalCi.validateQualityVerdict(packageValue.verdict);
  externalCi.validateExternalCiCertification(packageValue.certification);
  if (
    !Array.isArray(packageValue.artifacts) ||
    packageValue.artifacts.length === 0 ||
    packageValue.artifacts.length > externalCi.MAX_ARTIFACTS
  ) {
    fail("PACKAGE_ARTIFACT_INVALID", "artifact array has invalid cardinality");
  }
  let prior = "";
  const map = new Map();
  for (const artifact of packageValue.artifacts) {
    const bytes = validatePackageArtifact(artifact);
    if (artifact.address <= prior || map.has(artifact.address)) {
      fail("PACKAGE_ARTIFACT_INVALID", "artifact array must be sorted and unique");
    }
    prior = artifact.address;
    map.set(artifact.address, bytes);
  }
  if (Buffer.byteLength(stableJson(packageValue), "utf8") > MAX_JSON_BYTES) {
    fail("SIZE_LIMIT_EXCEEDED", "external package is oversized");
  }
  return { packageValue: clone(packageValue), artifactMap: map };
}

function packageArtifact(bytes) {
  const buffer = Buffer.from(bytes);
  const digest = sha256(buffer);
  return {
    schema: ARTIFACT_SCHEMA,
    address: `sha256:${digest}`,
    encoding: "base64",
    byteLength: buffer.length,
    sha256: digest,
    bytes: buffer.toString("base64"),
  };
}

function requestPayload(intent) {
  const request = externalCi.validateCertificationRequest({
    schema: externalCi.REQUEST_SCHEMA,
    phaseId: intent.completedPhaseId,
    phaseScopeBaseCommit: intent.scopeBaseCommit,
    candidateCommit: intent.candidateCommit,
    requestNonce: intent.requestNonce,
  });
  return {
    request,
    requestSha256: sha256(externalCi.stableJson(request)),
    productionAuthority: false,
  };
}

function stageReceipt(receipts, stage) {
  const receipt = receipts[STAGES.indexOf(stage)];
  if (!receipt || receipt.stage !== stage) {
    fail("PRIOR_STAGE_MISSING", `required ${stage} receipt is missing`);
  }
  return receipt;
}

function buildEnvelope(intent, receipts) {
  const request = stageReceipt(receipts, "request");
  const externalPackage = stageReceipt(receipts, "external_package");
  const verified = stageReceipt(receipts, "verified");
  const body = {
    schema: ENVELOPE_SCHEMA,
    ceremonyId: intent.ceremonyId,
    intentHash: intent.intentHash,
    requestReceiptHash: request.receiptHash,
    externalPackageReceiptHash: externalPackage.receiptHash,
    verificationReceiptHash: verified.receiptHash,
    completedPhaseId: intent.completedPhaseId,
    activatedPhaseId: intent.activatedPhaseId,
    authorityCommit: intent.authorityCommit,
    scopeBaseCommit: intent.scopeBaseCommit,
    candidateCommit: intent.candidateCommit,
    candidateTree: intent.candidateTree,
    certificationHash: verified.payload.certificationHash,
    qualityVerdictHash: verified.payload.qualityVerdictHash,
    evidenceManifestSha256: verified.payload.evidenceManifestSha256,
    attestationBodySha256: verified.payload.attestationBodySha256,
    replayKeySha256: verified.payload.replayKeySha256,
    productionAuthority: false,
  };
  return { ...body, envelopeHash: hashWithoutField(body, "envelopeHash") };
}

function validateEnvelope(envelope, intent, receipts) {
  exactKeys(envelope, ENVELOPE_KEYS, "ceremony envelope");
  if (envelope.schema !== ENVELOPE_SCHEMA) {
    fail("INVALID_SCHEMA", "ceremony envelope schema is invalid");
  }
  requireFalse(envelope.productionAuthority, "envelope.productionAuthority");
  requireHash(envelope.envelopeHash, "envelope.envelopeHash");
  const expected = buildEnvelope(intent, receipts);
  if (stableJson(envelope) !== stableJson(expected)) {
    fail("ENVELOPE_BINDING_MISMATCH", "envelope does not bind all prior receipts");
  }
  return clone(envelope);
}

function replayMarker(intent, envelope) {
  const body = {
    schema: REPLAY_SCHEMA,
    replayKeySha256: envelope.replayKeySha256,
    certificationHash: envelope.certificationHash,
    ceremonyId: intent.ceremonyId,
    controllerId: intent.controllerId,
    intentHash: intent.intentHash,
    envelopeHash: envelope.envelopeHash,
    consumptionScope: "canonical-phase-transition",
    consumedAt: stageTimestamp(intent, STAGES.indexOf("replay")),
    productionAuthority: false,
  };
  return { ...body, markerHash: hashWithoutField(body, "markerHash") };
}

function validateReplayMarker(marker, intent) {
  exactKeys(marker, REPLAY_KEYS, "replay marker");
  if (
    marker.schema !== REPLAY_SCHEMA ||
    marker.consumptionScope !== "canonical-phase-transition"
  ) {
    fail("INVALID_SCHEMA", "replay marker schema or scope is invalid");
  }
  for (const key of [
    "replayKeySha256",
    "certificationHash",
    "ceremonyId",
    "controllerId",
    "intentHash",
    "envelopeHash",
    "markerHash",
  ]) {
    requireHash(marker[key], `replay.${key}`);
  }
  requireTimestamp(marker.consumedAt, "replay.consumedAt");
  requireFalse(marker.productionAuthority, "replay.productionAuthority");
  if (
    marker.ceremonyId !== intent.ceremonyId ||
    marker.controllerId !== intent.controllerId ||
    marker.intentHash !== intent.intentHash ||
    marker.markerHash !== hashWithoutField(marker, "markerHash")
  ) {
    fail("REPLAY_BINDING_MISMATCH", "replay marker does not bind the controller");
  }
  return clone(marker);
}

function consumeReplay(root, intent, envelope) {
  const marker = replayMarker(intent, envelope);
  validateReplayMarker(marker, intent);
  const target = path.join(root, "replay", `${marker.replayKeySha256}.json`);
  atomicCreate(target, canonicalBytes(marker, MAX_SMALL_JSON_BYTES));
  const readBack = validateReplayMarker(
    parseCanonical(
      readRegular(target, MAX_SMALL_JSON_BYTES),
      "replay marker",
      MAX_SMALL_JSON_BYTES,
    ),
    intent,
  );
  if (stableJson(readBack) !== stableJson(marker)) {
    fail("REPLAY_ALREADY_CONSUMED", "replay identity belongs to another ceremony");
  }
  return marker;
}

function idempotencyKey(intent, stage) {
  return sha256(
    stableJson({
      schema: "pikiio-proof-ceremony-idempotency-v1",
      ceremonyId: intent.ceremonyId,
      intentHash: intent.intentHash,
      stage,
    }),
  );
}

function validateTransitionResult(result, intent) {
  exactKeys(result, TRANSITION_KEYS, "transition result");
  if (result.schema !== TRANSITION_SCHEMA) {
    fail("INVALID_SCHEMA", "transition result schema is invalid");
  }
  requireHash(result.ceremonyId, "transition.ceremonyId");
  requireHash(result.idempotencyKey, "transition.idempotencyKey");
  requireHash(
    result.transitionAdapterSha256,
    "transition.transitionAdapterSha256",
  );
  requireCommit(result.baseCommit, "transition.baseCommit");
  requireInteger(result.ledgerRevision, "transition.ledgerRevision", 1);
  validatePathList(result.changedPaths, "transition.changedPaths");
  requireHash(result.envelopeHash, "transition.envelopeHash");
  requireHash(result.replayMarkerHash, "transition.replayMarkerHash");
  requireFalse(result.productionAuthority, "transition.productionAuthority");
  if (
    result.ceremonyId !== intent.ceremonyId ||
    result.idempotencyKey !== idempotencyKey(intent, "transition") ||
    result.transitionAdapterSha256 !== intent.transitionAdapterSha256 ||
    result.completedPhaseId !== intent.completedPhaseId ||
    result.activatedPhaseId !== intent.activatedPhaseId ||
    result.baseCommit !== intent.candidateCommit ||
    result.ledgerRevision !== intent.ledgerRevision ||
    stableJson(result.changedPaths) !==
      stableJson(intent.expectedTransitionPaths)
  ) {
    fail("TRANSITION_BINDING_MISMATCH", "transition result is not exact");
  }
  return clone(result);
}

function validatePushResult(result, intent) {
  exactKeys(result, PUSH_KEYS, "push result");
  if (result.schema !== PUSH_SCHEMA) {
    fail("INVALID_SCHEMA", "push result schema is invalid");
  }
  for (const key of [
    "ceremonyId",
    "idempotencyKey",
    "transitionReceiptHash",
  ]) {
    requireHash(result[key], `push.${key}`);
  }
  for (const key of ["baseCommit", "commit", "tree", "parent"]) {
    requireCommit(result[key], `push.${key}`);
  }
  requireRemoteRef(result.remoteRef);
  validatePathList(result.changedPaths, "push.changedPaths");
  requireFalse(result.productionAuthority, "push.productionAuthority");
  if (
    result.ceremonyId !== intent.ceremonyId ||
    result.idempotencyKey !== idempotencyKey(intent, "commit_push") ||
    result.baseCommit !== intent.candidateCommit ||
    result.parent !== intent.candidateCommit ||
    result.commit === intent.candidateCommit ||
    result.remoteRef !== intent.remoteRef ||
    stableJson(result.changedPaths) !==
      stableJson(intent.expectedTransitionPaths) ||
    result.pushed !== true
  ) {
    fail("PUSH_BINDING_MISMATCH", "commit/push result is not exact");
  }
  return clone(result);
}

function verifyCommittedGit(intent, git, push) {
  if (
    git.head() !== push.commit ||
    git.parent({ commit: push.commit }) !== push.parent ||
    git.tree({ commit: push.commit }) !== push.tree ||
    Buffer.from(git.status()).length !== 0
  ) {
    fail("COMMIT_READBACK_MISMATCH", "local committed Git state is not exact");
  }
  const changedPaths = parseNameStatus(
    git.diff({
      format: "name-status-z",
      from: intent.candidateCommit,
      to: push.commit,
    }),
  );
  assertPathSet(
    changedPaths,
    intent.expectedTransitionPaths,
    "COMMIT_DIFF_MISMATCH",
  );
}

function packageFromReceipts(root, receipts) {
  const payload = stageReceipt(receipts, "external_package").payload;
  const packageValue = readObject(
    root,
    payload.packageObjectSha256,
    MAX_JSON_BYTES,
  );
  const validated = validateExternalPackage(packageValue);
  const bytes = canonicalBytes(packageValue, MAX_JSON_BYTES);
  if (
    bytes.length !== payload.packageByteLength ||
    sha256(bytes) !== payload.packageSha256
  ) {
    fail("PACKAGE_READBACK_MISMATCH", "external package CAS bytes differ");
  }
  return validated;
}

function envelopeFromReceipts(root, intent, receipts) {
  const payload = stageReceipt(receipts, "envelope").payload;
  const envelope = readObject(
    root,
    payload.envelopeObjectSha256,
    MAX_SMALL_JSON_BYTES,
  );
  if (
    canonicalBytes(envelope, MAX_SMALL_JSON_BYTES).length !==
      payload.envelopeByteLength ||
    envelope.envelopeHash !== payload.envelopeHash
  ) {
    fail("ENVELOPE_READBACK_MISMATCH", "envelope CAS bytes differ");
  }
  return validateEnvelope(envelope, intent, receipts);
}

function planCeremony(intentValue) {
  const intent = validateIntent(intentValue);
  return {
    schema: "pikiio-proof-ceremony-plan-v1",
    ceremonyId: intent.ceremonyId,
    intentHash: intent.intentHash,
    authorityCommit: intent.authorityCommit,
    scopeBaseCommit: intent.scopeBaseCommit,
    candidateCommit: intent.candidateCommit,
    transition: `${intent.completedPhaseId}->${intent.activatedPhaseId}`,
    stages: [...STAGES],
    liveExternalDispatch: false,
    liveCommitPush: false,
    builderAuthorityOnly: true,
    productionAuthority: false,
  };
}

function inspectCeremony({ root, intent: intentValue } = {}) {
  const intent = validateIntent(intentValue);
  requireCanonicalRoot(root);
  const target = journalPath(root, intent.ceremonyId);
  if (!fs.existsSync(target)) {
    return {
      schema: RESULT_SCHEMA,
      ceremonyId: intent.ceremonyId,
      status: "not_started",
      completedStages: [],
      nextStage: STAGES[0],
      activationReceiptHash: null,
      pointerHash: null,
      builderAuthority: false,
      productionAuthority: false,
    };
  }
  const journal = validateJournal(
    parseCanonical(
      readRegular(target, MAX_SMALL_JSON_BYTES),
      "ceremony journal",
      MAX_SMALL_JSON_BYTES,
    ),
    intent,
  );
  const receipts = auditHistory(root, journal, intent);
  const activation = receipts.find((receipt) => receipt.stage === "activation");
  return {
    schema: RESULT_SCHEMA,
    ceremonyId: intent.ceremonyId,
    status: journal.revision === STAGES.length ? "complete" : "in_progress",
    completedStages: [...journal.completedStages],
    nextStage: STAGES[journal.revision] || null,
    activationReceiptHash:
      activation?.payload.activationReceiptHash || null,
    pointerHash: activation?.payload.pointerHash || null,
    builderAuthority: Boolean(activation?.payload.builderAuthority),
    productionAuthority: false,
  };
}

function requireRunOptions(options) {
  const allowed = new Set([
    "root",
    "intent",
    "mode",
    "capability",
    "sealedGit",
    "collectExternalPackage",
    "verifyOidcCollector",
    "transitionAdapter",
    "canonicalTransition",
    "commitAndPush",
    "activationCasRoot",
    "validateHostDurability",
    "hostDurabilityReceipt",
    "nowMs",
    "faultAfterStage",
  ]);
  if (!isPlainObject(options)) {
    fail("OPTIONS_INVALID", "ceremony requires one exact options object");
  }
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("UNEXPECTED_FIELDS", "ceremony options contain unexpected fields", {
      unexpected,
    });
  }
}

async function runCeremony(options = {}) {
  requireRunOptions(options);
  const intent = validateIntent(options.intent);
  const mode = options.mode ?? "inspect";
  if (mode === "inspect") {
    return inspectCeremony({ root: options.root, intent });
  }
  if (!["dry-run", "live"].includes(mode)) {
    fail("MODE_INVALID", "mode must be inspect, dry-run, or live");
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < Date.parse(intent.createdAt)) {
    fail("NOW_INVALID", "nowMs must be a safe time at or after ceremony creation");
  }
  if (options.faultAfterStage !== null && options.faultAfterStage !== undefined) {
    if (!STAGES.includes(options.faultAfterStage)) {
      fail("FAULT_STAGE_INVALID", "faultAfterStage is not a ceremony stage");
    }
  }
  if (mode === "live") {
    validateCapability(options.capability, intent, nowMs);
  } else if (options.capability !== null && options.capability !== undefined) {
    fail("DRY_RUN_CAPABILITY_REFUSED", "dry-run must not carry a live capability");
  }
  validateTransitionAdapter(options.transitionAdapter, intent, mode);
  if (mode === "live") {
    fail(
      "CANONICAL_V3_TRANSITION_ADAPTER_UNAVAILABLE",
      "live ceremony remains disabled until the canonical v3 transition adapter is installed",
    );
  }
  const git = requireSealedGit(options.sealedGit);
  requireCanonicalRoot(options.root, { initialize: true });
  if (
    options.activationCasRoot !== intent.activationCasRoot ||
    activationCas.casRootIdentitySha256(options.activationCasRoot) !==
      intent.activationCasRootIdentitySha256
  ) {
    fail(
      "ACTIVATION_CAS_ROOT_IDENTITY_MISMATCH",
      "runtime activation CAS root differs from the sealed intent",
    );
  }
  const relativeActivationRoot = path.relative(
    options.root,
    options.activationCasRoot,
  );
  if (
    mode === "dry-run" &&
    (relativeActivationRoot === "" ||
      relativeActivationRoot === ".." ||
      relativeActivationRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeActivationRoot))
  ) {
    fail(
      "DRY_RUN_ACTIVATION_ROOT_UNSAFE",
      "dry-run activation CAS must remain beneath the ceremony root",
    );
  }
  return withCeremonyLock(options.root, intent.ceremonyId, async () => {
    let journal = loadOrCreateJournal(options.root, intent);
    let receipts = auditHistory(options.root, journal, intent);
    while (journal.revision < STAGES.length) {
      const resumed = resumeOrphanStage(
        options.root,
        journal,
        intent,
        options.faultAfterStage,
      );
      if (resumed) {
        journal = resumed;
        receipts = auditHistory(options.root, journal, intent);
        continue;
      }
      const stage = STAGES[journal.revision];
      let payload;
      if (
        [
          "candidate",
          "request",
          "external_package",
          "verified",
          "envelope",
          "replay",
          "transition",
        ].includes(stage)
      ) {
        assertCandidateStillClean(intent, git);
      }
      if (stage === "candidate") {
        payload = candidatePayload(intent, git);
      } else if (stage === "request") {
        payload = requestPayload(intent);
      } else if (stage === "external_package") {
        const request = stageReceipt(receipts, "request").payload.request;
        const packageValue = invokeSync(
          "collectExternalPackage",
          options.collectExternalPackage,
          {
            schema: DISPATCH_SCHEMA,
            ceremonyId: intent.ceremonyId,
            idempotencyKey: idempotencyKey(intent, "external_package"),
            mode,
            request,
            productionAuthority: false,
          },
        );
        const validated = validateExternalPackage(packageValue);
        const stored = writeObject(
          options.root,
          validated.packageValue,
          MAX_JSON_BYTES,
        );
        payload = {
          packageObjectSha256: stored.objectSha256,
          packageByteLength: stored.byteLength,
          packageSha256: stored.objectSha256,
          productionAuthority: false,
        };
      } else if (stage === "verified") {
        const request = stageReceipt(receipts, "request").payload.request;
        const packageData = packageFromReceipts(options.root, receipts);
        const verification = await externalCi.verifyExternalCiCertification({
          request,
          trustedAuthority: {
            ref: packageData.packageValue.materialization.authority.ref,
            commit: intent.authorityCommit,
            workflowPath:
              packageData.packageValue.materialization.authority.workflowPath,
            workflowBlobSha256:
              packageData.packageValue.materialization.authority.workflowBlobSha256,
            phaseProofRegistrySha256:
              packageData.packageValue.materialization.authority.phaseProofRegistrySha256,
            jwksRegistrySha256:
              packageData.packageValue.materialization.authority.jwksRegistrySha256,
            toolchainSha256:
              packageData.packageValue.materialization.authority.toolchainSha256,
          },
          materialization: packageData.packageValue.materialization,
          primaryJudge: packageData.packageValue.primaryJudge,
          independentJudge: packageData.packageValue.independentJudge,
          verdict: packageData.packageValue.verdict,
          certification: packageData.packageValue.certification,
          artifacts: packageData.artifactMap,
          verifyOidcCollector: (requestValue) =>
            invokeSync(
              "verifyOidcCollector",
              options.verifyOidcCollector,
              requestValue,
            ),
        });
        requireFalse(
          verification.productionAuthority,
          "verification.productionAuthority",
        );
        payload = {
          valid: true,
          completedPhaseId: verification.phaseId,
          authorityCommit: verification.authorityCommit,
          scopeBaseCommit: verification.scopeBaseCommit,
          candidateCommit: verification.candidateCommit,
          requestNonce: verification.requestNonce,
          qualityVerdictHash: verification.qualityVerdictHash,
          evidenceManifestSha256: verification.evidenceManifestSha256,
          replayKeySha256: verification.replayKeySha256,
          attestationBodySha256: verification.attestationBodySha256,
          certificationHash: verification.certificationHash,
          productionAuthority: false,
        };
      } else if (stage === "envelope") {
        const envelope = buildEnvelope(intent, receipts);
        validateEnvelope(envelope, intent, receipts);
        const stored = writeObject(
          options.root,
          envelope,
          MAX_SMALL_JSON_BYTES,
        );
        payload = {
          envelopeObjectSha256: stored.objectSha256,
          envelopeByteLength: stored.byteLength,
          envelopeHash: envelope.envelopeHash,
          productionAuthority: false,
        };
      } else if (stage === "replay") {
        const envelope = envelopeFromReceipts(options.root, intent, receipts);
        payload = consumeReplay(options.root, intent, envelope);
      } else if (stage === "transition") {
        const envelope = envelopeFromReceipts(options.root, intent, receipts);
        const replay = stageReceipt(receipts, "replay").payload;
        payload = invokeSync(
          "canonicalTransition",
          options.canonicalTransition,
          {
            schema: TRANSITION_REQUEST_SCHEMA,
            ceremonyId: intent.ceremonyId,
            idempotencyKey: idempotencyKey(intent, "transition"),
            transitionAdapterSha256: intent.transitionAdapterSha256,
            mode,
            completedPhaseId: intent.completedPhaseId,
            activatedPhaseId: intent.activatedPhaseId,
            baseCommit: intent.candidateCommit,
            ledgerRevision: intent.ledgerRevision,
            expectedTransitionPaths: clone(intent.expectedTransitionPaths),
            envelope,
            replayMarker: clone(replay),
            productionAuthority: false,
          },
        );
        validateTransitionResult(payload, intent);
        if (
          payload.envelopeHash !== envelope.envelopeHash ||
          payload.replayMarkerHash !== replay.markerHash
        ) {
          fail("TRANSITION_BINDING_MISMATCH", "transition omitted envelope or replay");
        }
        if (git.head() !== intent.candidateCommit) {
          fail("STALE_HEAD", "transition callback moved HEAD before exact commit");
        }
        assertPathSet(
          parseStatusPaths(git.status()),
          intent.expectedTransitionPaths,
          "TRANSITION_WORKTREE_MISMATCH",
        );
      } else if (stage === "commit_push") {
        const transition = stageReceipt(receipts, "transition");
        if (git.head() !== intent.candidateCommit) {
          fail("STALE_HEAD", "candidate HEAD moved before exact commit/push");
        }
        assertPathSet(
          parseStatusPaths(git.status()),
          intent.expectedTransitionPaths,
          "TRANSITION_WORKTREE_MISMATCH",
        );
        payload = invokeSync(
          "commitAndPush",
          options.commitAndPush,
          {
            schema: PUSH_REQUEST_SCHEMA,
            ceremonyId: intent.ceremonyId,
            idempotencyKey: idempotencyKey(intent, "commit_push"),
            mode,
            baseCommit: intent.candidateCommit,
            remoteUrl: intent.remoteUrl,
            remoteRef: intent.remoteRef,
            commitMessage: intent.commitMessage,
            expectedChangedPaths: clone(intent.expectedTransitionPaths),
            transitionReceiptHash: transition.receiptHash,
            productionAuthority: false,
          },
        );
        validatePushResult(payload, intent);
        if (payload.transitionReceiptHash !== transition.receiptHash) {
          fail("PUSH_BINDING_MISMATCH", "push omitted the exact transition receipt");
        }
        verifyCommittedGit(intent, git, payload);
      } else if (stage === "remote_readback") {
        const push = stageReceipt(receipts, "commit_push").payload;
        verifyCommittedGit(intent, git, push);
        const observedCommit = git.remoteReadback({
          url: intent.remoteUrl,
          ref: intent.remoteRef,
        });
        requireCommit(observedCommit, "remote read-back commit");
        if (observedCommit !== push.commit) {
          fail("REMOTE_READBACK_MISMATCH", "remote ref differs from pushed commit");
        }
        payload = {
          remoteUrl: intent.remoteUrl,
          remoteRef: intent.remoteRef,
          expectedCommit: push.commit,
          observedCommit,
          readBackAt: stageTimestamp(
            intent,
            STAGES.indexOf("remote_readback"),
          ),
          productionAuthority: false,
        };
      } else if (stage === "activation") {
        const push = stageReceipt(receipts, "commit_push").payload;
        const transition = stageReceipt(receipts, "transition");
        const readback = stageReceipt(receipts, "remote_readback").payload;
        const verified = stageReceipt(receipts, "verified").payload;
        const packageData = packageFromReceipts(options.root, receipts);
        verifyCommittedGit(intent, git, push);
        if (readback.observedCommit !== push.commit) {
          fail("REMOTE_READBACK_MISMATCH", "activation lacks exact remote read-back");
        }
        const certification = packageData.packageValue.certification;
        const activation = activationCas.issueActivation({
          casRoot: intent.activationCasRoot,
          certification,
          intentInput: {
            completedPhaseId: intent.completedPhaseId,
            activatedPhaseId: intent.activatedPhaseId,
            ledgerRevision: intent.ledgerRevision,
            ledgerSha256: intent.ledgerSha256,
            scopeBaseCommit: intent.scopeBaseCommit,
            candidateCommit: intent.candidateCommit,
            transitionCommit: push.commit,
            transitionParent: push.parent,
            transitionTree: push.tree,
            transitionReceiptHash: transition.receiptHash,
            remoteRef: intent.remoteRef,
            externalCertificationHash: verified.certificationHash,
            attestationBodySha256: verified.attestationBodySha256,
            qualityVerdictHash: verified.qualityVerdictHash,
            evidenceManifestSha256: verified.evidenceManifestSha256,
            requestNonce: intent.requestNonce,
            automationContractSha256: intent.automationContractSha256,
            allowedPathsSha256: intent.allowedPathsSha256,
            authorityCommit: intent.authorityCommit,
            controllerHost: intent.controllerHost,
            controllerLeaseFence: intent.controllerLeaseFence,
            createdAt: intent.createdAt,
          },
          expectedPreviousPointerHash:
            intent.expectedPreviousActivationPointerHash,
          validateExternalCertification: (value) => {
            if (stableJson(value) !== stableJson(certification)) {
              fail("CERTIFICATION_SUBSTITUTION", "activation certification differs");
            }
            return {
              ...clone(verified),
              phaseId: verified.completedPhaseId,
            };
          },
          resolveTransitionReadback: (remoteRef) => {
            if (remoteRef !== intent.remoteRef) {
              fail("REMOTE_REF_SUBSTITUTION", "activation requested another ref");
            }
            const remoteCommit = git.remoteReadback({
              url: intent.remoteUrl,
              ref: intent.remoteRef,
            });
            return {
              commit: remoteCommit,
              parent: push.parent,
              tree: push.tree,
              transitionReceiptHash: transition.receiptHash,
              completedPhaseId: intent.completedPhaseId,
              activatedPhaseId: intent.activatedPhaseId,
              ledgerRevision: intent.ledgerRevision,
              ledgerSha256: intent.ledgerSha256,
              externalCertificationHash: verified.certificationHash,
              controllerHost: intent.controllerHost,
              controllerLeaseFence: intent.controllerLeaseFence,
            };
          },
          validateHostDurability: (receipt, context) =>
            invokeSync(
              "validateHostDurability",
              options.validateHostDurability,
              { receipt, context },
            ),
          hostDurabilityReceipt: clone(options.hostDurabilityReceipt),
          nowMs,
        });
        if (
          activation.ok !== true ||
          activation.activationReceipt.completedPhaseId !==
            intent.completedPhaseId ||
          activation.activationReceipt.activatedPhaseId !==
            intent.activatedPhaseId ||
          activation.activationReceipt.casRootIdentitySha256 !==
            intent.activationCasRootIdentitySha256 ||
          activation.activationReceipt.productionAuthority !== false
        ) {
          fail("ACTIVATION_FAILED", "activation did not grant repository builder");
        }
        payload = {
          activationReceiptHash:
            activation.activationReceipt.receiptHash,
          pointerHash: activation.pointer.pointerHash,
          replayMarkerHash: activation.replayMarker.markerHash,
          activationCasRootIdentitySha256:
            intent.activationCasRootIdentitySha256,
          completedPhaseId: activation.activationReceipt.completedPhaseId,
          activatedPhaseId: activation.activationReceipt.activatedPhaseId,
          builderAuthority: true,
          productionAuthority: false,
        };
      }
      journal = persistStage({
        root: options.root,
        journal,
        intent,
        payload,
        faultAfterStage: options.faultAfterStage,
      });
      receipts = auditHistory(options.root, journal, intent);
    }
    return inspectCeremony({ root: options.root, intent });
  });
}

module.exports = Object.freeze({
  ARTIFACT_SCHEMA,
  CAPABILITY_SCHEMA,
  DISPATCH_SCHEMA,
  ENVELOPE_SCHEMA,
  INTENT_SCHEMA,
  JOURNAL_SCHEMA,
  PACKAGE_SCHEMA,
  PUSH_REQUEST_SCHEMA,
  PUSH_SCHEMA,
  REPLAY_SCHEMA,
  RESULT_SCHEMA,
  STAGES,
  STAGE_RECEIPT_SCHEMA,
  STAGE_SLOT_SCHEMA,
  TRANSITION_REQUEST_SCHEMA,
  TRANSITION_ADAPTER_SCHEMA,
  TRANSITION_SCHEMA,
  ProofCeremonyError,
  hashWithoutField,
  inspectCeremony,
  packageArtifact,
  planCeremony,
  runCeremony,
  sealCeremonyCapability,
  sealCeremonyIntent,
  sealTransitionAdapter,
  sha256,
  stableJson,
  validateCapability,
  validateExternalPackage,
  validateIntent,
});

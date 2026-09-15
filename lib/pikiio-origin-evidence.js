"use strict";

const crypto = require("node:crypto");

const AUTHORITY_REGISTRY_SCHEMA =
  "pikiio-origin-evidence-authority-registry-v1";
const RECEIPT_SCHEMA = "pikiio-origin-evidence-receipt-v1";
const REPLAY_KEY_SCHEMA = "pikiio-origin-evidence-replay-key-v1";
const SIGNATURE_ALGORITHM = "Ed25519";
const SIGNATURE_DOMAIN = Buffer.from(
  "PIKIIO_ORIGIN_EVIDENCE_RECEIPT_V1\u0000",
  "utf8",
);

const EVIDENCE_CLASSES = Object.freeze([
  "natural-cycle",
  "deployed-api",
  "browser-capture",
  "change",
  "promotion-readback",
]);

const CLASS_CONFIG = Object.freeze({
  "natural-cycle": Object.freeze({
    schema: "pikiio-origin-natural-cycle-v1",
    maximumAgeMs: 30 * 60 * 1000,
    specificKeys: Object.freeze([
      "cycleId",
      "hostedWorkerExecutionId",
      "databaseObservationId",
      "sourceCutSha256",
      "workerArtifactSha256",
      "databaseReadbackSha256",
    ]),
  }),
  "deployed-api": Object.freeze({
    schema: "pikiio-origin-deployed-api-v1",
    maximumAgeMs: 15 * 60 * 1000,
    specificKeys: Object.freeze([
      "requestId",
      "requestUrl",
      "requestMethod",
      "responseStatus",
      "responseHeadersSha256",
      "responseBodySha256",
      "deploymentReadbackSha256",
    ]),
  }),
  "browser-capture": Object.freeze({
    schema: "pikiio-origin-browser-capture-v1",
    maximumAgeMs: 15 * 60 * 1000,
    specificKeys: Object.freeze([
      "captureId",
      "pageUrl",
      "viewport",
      "normalizedDomSha256",
      "screenshotSha256",
      "observedApiBodySha256",
      "browserBuildSha256",
    ]),
  }),
  change: Object.freeze({
    schema: "pikiio-origin-change-v1",
    maximumAgeMs: 30 * 60 * 1000,
    specificKeys: Object.freeze([
      "changeId",
      "authorizationReceiptSha256",
      "preimageSha256",
      "appliedArtifactSha256",
      "remoteCommitReadbackSha256",
      "deploymentReadbackSha256",
      "rollbackPointerSha256",
      "oneUseCapabilityConsumptionSha256",
    ]),
  }),
  "promotion-readback": Object.freeze({
    schema: "pikiio-origin-promotion-readback-v1",
    maximumAgeMs: 30 * 60 * 1000,
    specificKeys: Object.freeze([
      "promotionId",
      "changeReceiptHash",
      "naturalCycleReceiptHashes",
      "deployedApiReceiptHash",
      "browserCaptureReceiptHash",
      "soakStartedAt",
      "soakEndedAt",
      "remoteReadbackSha256",
      "rollbackReadinessSha256",
    ]),
  }),
});

const MAX_REGISTRY_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_STRING_BYTES = 2048;
const MAX_FUTURE_SKEW_MS = 30 * 1000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_ID_PATTERN = /^(?:GOV|TRUTH|ACTION)-[0-9]{2}$/;
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const ISSUER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const REGISTRY_KEYS = Object.freeze([
  "schema",
  "revision",
  "authorities",
  "registryHash",
]);
const AUTHORITY_KEYS = Object.freeze([
  "evidenceClass",
  "issuerId",
  "keyAlgorithm",
  "publicKeySpkiBase64",
  "publicKeySha256",
  "authorityIdentitySha256",
]);
const COMMON_BODY_KEYS = Object.freeze([
  "schema",
  "evidenceClass",
  "phaseId",
  "ledgerRevision",
  "candidateCommit",
  "candidateTree",
  "deploymentId",
  "sourceId",
  "observedAt",
  "nonce",
]);
const VIEWPORT_KEYS = Object.freeze([
  "width",
  "height",
  "deviceScaleFactor",
]);
const EXPECTED_CONTEXT_KEYS = Object.freeze([
  "evidenceClass",
  "phaseId",
  "ledgerRevision",
  "candidateCommit",
  "candidateTree",
  "deploymentId",
  "sourceId",
  "observedAt",
  "nonce",
  "authorityRegistrySha256",
]);
const RECEIPT_KEYS = Object.freeze([
  "schema",
  "evidenceClass",
  "authorityRegistrySha256",
  "issuerId",
  "publicKeySha256",
  "body",
  "bodySha256",
  "signatureAlgorithm",
  "signatureBase64",
  "replayKeySha256",
  "productionAuthority",
  "receiptHash",
]);
const UNSIGNED_RECEIPT_KEYS = Object.freeze(
  RECEIPT_KEYS.filter(
    (key) => key !== "signatureBase64" && key !== "receiptHash",
  ),
);
const SIGNABLE_RECEIPT_KEYS = UNSIGNED_RECEIPT_KEYS;
const VERIFY_OPTIONS_KEYS = Object.freeze(["registry", "expected", "nowMs"]);
const CONSUME_OPTIONS_KEYS = Object.freeze([
  "registry",
  "expected",
  "nowMs",
  "replayStore",
]);
const REPLAY_CONSUMPTION_KEYS = Object.freeze([
  "replayKeySha256",
  "receiptHash",
  "evidenceClass",
  "nonce",
]);

class OriginEvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OriginEvidenceError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new OriginEvidenceError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, seen = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      fail("NON_CANONICAL_JSON", "canonical JSON cannot contain a cycle");
    }
    seen.add(value);
    const result = value.map((entry) => canonicalValue(entry, seen));
    seen.delete(value);
    return result;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      fail("NON_CANONICAL_JSON", "canonical JSON cannot contain a cycle");
    }
    seen.add(value);
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (key.length === 0 || key.includes("\u0000")) {
        fail("NON_CANONICAL_JSON", "canonical JSON contains an invalid key");
      }
      result[key] = canonicalValue(value[key], seen);
    }
    seen.delete(value);
    return result;
  }
  fail(
    "NON_CANONICAL_JSON",
    "canonical JSON supports only null, strings, booleans, safe integers, arrays, and plain objects",
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalJson(value, label, maximumBytes) {
  let json;
  try {
    json = stableJson(value);
  } catch (error) {
    if (error instanceof OriginEvidenceError) throw error;
    fail("NON_CANONICAL_JSON", `${label} cannot be canonically serialized`, {
      cause: error.message,
    });
  }
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > maximumBytes) {
    fail("SIZE_LIMIT_EXCEEDED", `${label} exceeds its byte limit`, {
      byteLength,
      maximumBytes,
    });
  }
  return json;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashWithoutField(value, field, label, maximumBytes) {
  const copy = { ...value };
  delete copy[field];
  return sha256(canonicalJson(copy, label, maximumBytes));
}

function exactKeys(value, expected) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function requireExactKeys(value, expected, label) {
  if (!exactKeys(value, expected)) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`);
  }
}

function requireString(value, label, maximumBytes = MAX_STRING_BYTES) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail("INVALID_STRING", `${label} must be a bounded non-empty string`);
  }
}

function requirePattern(value, pattern, label, code) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, `${label} is invalid`);
  }
}

function requireSha256(value, label) {
  requirePattern(value, SHA256_PATTERN, label, "INVALID_SHA256");
}

function requireGitObject(value, label) {
  requirePattern(value, GIT_OBJECT_PATTERN, label, "INVALID_GIT_OBJECT");
}

function requireIdentifier(value, label) {
  requirePattern(value, IDENTIFIER_PATTERN, label, "INVALID_IDENTIFIER");
}

function requirePositiveInteger(value, label, maximum = 1_000_000_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INVALID_INTEGER", `${label} must be a bounded positive integer`);
  }
}

function parseCanonicalIso(value, label) {
  if (typeof value !== "string") {
    fail("INVALID_TIMESTAMP", `${label} must be a canonical UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("INVALID_TIMESTAMP", `${label} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function requireCanonicalHttpsUrl(value, label) {
  requireString(value, label, MAX_STRING_BYTES);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    fail("INVALID_URL", `${label} must be a canonical HTTPS URL`, {
      cause: error.message,
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.toString() !== value
  ) {
    fail("INVALID_URL", `${label} must be a canonical credential-free HTTPS URL`);
  }
}

function decodeCanonicalBase64(value, label, maximumBytes, exactBytes = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    fail("INVALID_BASE64", `${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maximumBytes ||
    (exactBytes !== null && bytes.length !== exactBytes) ||
    bytes.toString("base64") !== value
  ) {
    fail("INVALID_BASE64", `${label} must be canonical base64`);
  }
  return bytes;
}

function importEd25519PublicKey(authority, label) {
  const der = decodeCanonicalBase64(
    authority.publicKeySpkiBase64,
    `${label}.publicKeySpkiBase64`,
    128,
  );
  let key;
  try {
    key = crypto.createPublicKey({
      key: der,
      format: "der",
      type: "spki",
    });
  } catch (error) {
    fail("INVALID_PUBLIC_KEY", `${label} public key is invalid`, {
      cause: error.message,
    });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("INVALID_PUBLIC_KEY", `${label} must pin an Ed25519 public key`);
  }
  const canonicalDer = key.export({ format: "der", type: "spki" });
  if (
    canonicalDer.length !== der.length ||
    !crypto.timingSafeEqual(canonicalDer, der)
  ) {
    fail("NON_CANONICAL_PUBLIC_KEY", `${label} public key is not canonical`);
  }
  return { key, der };
}

function authorityIdentityValue(authority) {
  return {
    evidenceClass: authority.evidenceClass,
    issuerId: authority.issuerId,
    keyAlgorithm: authority.keyAlgorithm,
    publicKeySpkiBase64: authority.publicKeySpkiBase64,
    publicKeySha256: authority.publicKeySha256,
  };
}

function buildAuthorityRecord({ evidenceClass, issuerId, publicKey }) {
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) {
    fail("INVALID_EVIDENCE_CLASS", "evidenceClass is not supported");
  }
  requirePattern(issuerId, ISSUER_ID_PATTERN, "issuerId", "INVALID_ISSUER_ID");
  let key;
  try {
    key =
      publicKey instanceof crypto.KeyObject && publicKey.type === "public"
        ? publicKey
        : crypto.createPublicKey(publicKey);
  } catch (error) {
    fail("INVALID_PUBLIC_KEY", "publicKey cannot be imported", {
      cause: error.message,
    });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("INVALID_PUBLIC_KEY", "publicKey must be an Ed25519 public key");
  }
  const der = key.export({ format: "der", type: "spki" });
  if (der.length > 128) {
    fail("SIZE_LIMIT_EXCEEDED", "public key exceeds its byte limit");
  }
  const authority = {
    evidenceClass,
    issuerId,
    keyAlgorithm: SIGNATURE_ALGORITHM,
    publicKeySpkiBase64: der.toString("base64"),
    publicKeySha256: sha256(der),
  };
  authority.authorityIdentitySha256 = sha256(
    canonicalJson(
      authorityIdentityValue(authority),
      "authority identity",
      MAX_REGISTRY_BYTES,
    ),
  );
  return authority;
}

function validateAuthorityRegistry(registry) {
  canonicalJson(registry, "authority registry", MAX_REGISTRY_BYTES);
  requireExactKeys(registry, REGISTRY_KEYS, "authority registry");
  if (
    registry.schema !== AUTHORITY_REGISTRY_SCHEMA ||
    registry.revision !== 1
  ) {
    fail("INVALID_REGISTRY", "authority registry schema or revision is invalid");
  }
  requireExactKeys(
    registry.authorities,
    EVIDENCE_CLASSES,
    "authority registry authorities",
  );

  const issuerIds = new Set();
  const publicKeyHashes = new Set();
  const authorityIdentityHashes = new Set();
  for (const evidenceClass of EVIDENCE_CLASSES) {
    const authority = registry.authorities[evidenceClass];
    const label = `authority ${evidenceClass}`;
    requireExactKeys(authority, AUTHORITY_KEYS, label);
    if (authority.evidenceClass !== evidenceClass) {
      fail(
        "AUTHORITY_CLASS_MISMATCH",
        `${label} does not match its registry class`,
      );
    }
    requirePattern(
      authority.issuerId,
      ISSUER_ID_PATTERN,
      `${label}.issuerId`,
      "INVALID_ISSUER_ID",
    );
    if (authority.keyAlgorithm !== SIGNATURE_ALGORITHM) {
      fail("INVALID_KEY_ALGORITHM", `${label} must use Ed25519`);
    }
    const { der } = importEd25519PublicKey(authority, label);
    requireSha256(authority.publicKeySha256, `${label}.publicKeySha256`);
    if (authority.publicKeySha256 !== sha256(der)) {
      fail("PUBLIC_KEY_HASH_MISMATCH", `${label} public key hash is invalid`);
    }
    requireSha256(
      authority.authorityIdentitySha256,
      `${label}.authorityIdentitySha256`,
    );
    const expectedIdentityHash = sha256(
      canonicalJson(
        authorityIdentityValue(authority),
        `${label} identity`,
        MAX_REGISTRY_BYTES,
      ),
    );
    if (authority.authorityIdentitySha256 !== expectedIdentityHash) {
      fail("AUTHORITY_IDENTITY_MISMATCH", `${label} identity hash is invalid`);
    }
    if (
      issuerIds.has(authority.issuerId) ||
      publicKeyHashes.has(authority.publicKeySha256) ||
      authorityIdentityHashes.has(authority.authorityIdentitySha256)
    ) {
      fail(
        "AUTHORITY_NOT_DISTINCT",
        "every evidence class must have a distinct issuer and Ed25519 key",
      );
    }
    issuerIds.add(authority.issuerId);
    publicKeyHashes.add(authority.publicKeySha256);
    authorityIdentityHashes.add(authority.authorityIdentitySha256);
  }

  requireSha256(registry.registryHash, "authority registry hash");
  const expectedRegistryHash = hashWithoutField(
    registry,
    "registryHash",
    "authority registry content",
    MAX_REGISTRY_BYTES,
  );
  if (registry.registryHash !== expectedRegistryHash) {
    fail("REGISTRY_HASH_MISMATCH", "authority registry hash is invalid");
  }
  return {
    ok: true,
    registryHash: registry.registryHash,
    authorityCount: EVIDENCE_CLASSES.length,
  };
}

function buildAuthorityRegistry(authorities) {
  requireExactKeys(authorities, EVIDENCE_CLASSES, "authorities");
  const registry = {
    schema: AUTHORITY_REGISTRY_SCHEMA,
    revision: 1,
    authorities,
  };
  registry.registryHash = sha256(
    canonicalJson(registry, "authority registry content", MAX_REGISTRY_BYTES),
  );
  validateAuthorityRegistry(registry);
  return registry;
}

function validateCommonBody(body, evidenceClass) {
  const config = CLASS_CONFIG[evidenceClass];
  if (!config) {
    fail("INVALID_EVIDENCE_CLASS", "evidenceClass is not supported");
  }
  requireExactKeys(
    body,
    [...COMMON_BODY_KEYS, ...config.specificKeys],
    `${evidenceClass} body`,
  );
  canonicalJson(body, `${evidenceClass} body`, MAX_BODY_BYTES);
  if (body.schema !== config.schema || body.evidenceClass !== evidenceClass) {
    fail(
      "BODY_SCHEMA_MISMATCH",
      `${evidenceClass} body schema or class is invalid`,
    );
  }
  requirePattern(body.phaseId, PHASE_ID_PATTERN, "body.phaseId", "INVALID_PHASE_ID");
  requirePositiveInteger(body.ledgerRevision, "body.ledgerRevision");
  requireGitObject(body.candidateCommit, "body.candidateCommit");
  requireGitObject(body.candidateTree, "body.candidateTree");
  requireIdentifier(body.deploymentId, "body.deploymentId");
  requireIdentifier(body.sourceId, "body.sourceId");
  parseCanonicalIso(body.observedAt, "body.observedAt");
  requirePattern(body.nonce, NONCE_PATTERN, "body.nonce", "INVALID_NONCE");
}

function requireDistinctIdentifiers(values, label) {
  if (new Set(values).size !== values.length) {
    fail("IDENTIFIERS_NOT_DISTINCT", `${label} must be distinct`);
  }
}

function validateNaturalCycleBody(body) {
  for (const field of [
    "cycleId",
    "hostedWorkerExecutionId",
    "databaseObservationId",
  ]) {
    requireIdentifier(body[field], `body.${field}`);
  }
  requireDistinctIdentifiers(
    [
      body.cycleId,
      body.hostedWorkerExecutionId,
      body.databaseObservationId,
    ],
    "natural-cycle execution identifiers",
  );
  for (const field of [
    "sourceCutSha256",
    "workerArtifactSha256",
    "databaseReadbackSha256",
  ]) {
    requireSha256(body[field], `body.${field}`);
  }
}

function validateDeployedApiBody(body) {
  requireIdentifier(body.requestId, "body.requestId");
  requireCanonicalHttpsUrl(body.requestUrl, "body.requestUrl");
  if (!["GET", "HEAD"].includes(body.requestMethod)) {
    fail("UNSAFE_API_METHOD", "deployed API evidence must use GET or HEAD");
  }
  if (
    !Number.isSafeInteger(body.responseStatus) ||
    body.responseStatus < 100 ||
    body.responseStatus > 599
  ) {
    fail("INVALID_HTTP_STATUS", "body.responseStatus is invalid");
  }
  for (const field of [
    "responseHeadersSha256",
    "responseBodySha256",
    "deploymentReadbackSha256",
  ]) {
    requireSha256(body[field], `body.${field}`);
  }
}

function validateBrowserCaptureBody(body) {
  requireIdentifier(body.captureId, "body.captureId");
  requireCanonicalHttpsUrl(body.pageUrl, "body.pageUrl");
  requireExactKeys(body.viewport, VIEWPORT_KEYS, "body.viewport");
  requirePositiveInteger(body.viewport.width, "body.viewport.width", 16_384);
  requirePositiveInteger(body.viewport.height, "body.viewport.height", 16_384);
  requirePositiveInteger(
    body.viewport.deviceScaleFactor,
    "body.viewport.deviceScaleFactor",
    8,
  );
  for (const field of [
    "normalizedDomSha256",
    "screenshotSha256",
    "observedApiBodySha256",
    "browserBuildSha256",
  ]) {
    requireSha256(body[field], `body.${field}`);
  }
}

function validateChangeBody(body) {
  requireIdentifier(body.changeId, "body.changeId");
  for (const field of [
    "authorizationReceiptSha256",
    "preimageSha256",
    "appliedArtifactSha256",
    "remoteCommitReadbackSha256",
    "deploymentReadbackSha256",
    "rollbackPointerSha256",
    "oneUseCapabilityConsumptionSha256",
  ]) {
    requireSha256(body[field], `body.${field}`);
  }
}

function validatePromotionReadbackBody(body) {
  requireIdentifier(body.promotionId, "body.promotionId");
  for (const field of [
    "changeReceiptHash",
    "deployedApiReceiptHash",
    "browserCaptureReceiptHash",
    "remoteReadbackSha256",
    "rollbackReadinessSha256",
  ]) {
    requireSha256(body[field], `body.${field}`);
  }
  if (
    !Array.isArray(body.naturalCycleReceiptHashes) ||
    body.naturalCycleReceiptHashes.length < 2 ||
    body.naturalCycleReceiptHashes.length > 8
  ) {
    fail(
      "INVALID_NATURAL_CYCLE_SET",
      "promotion must bind two to eight natural-cycle receipts",
    );
  }
  for (const [index, hash] of body.naturalCycleReceiptHashes.entries()) {
    requireSha256(hash, `body.naturalCycleReceiptHashes[${index}]`);
  }
  if (
    new Set(body.naturalCycleReceiptHashes).size !==
    body.naturalCycleReceiptHashes.length
  ) {
    fail(
      "DUPLICATE_NATURAL_CYCLE",
      "promotion natural-cycle receipt hashes must be distinct",
    );
  }
  const soakStartedAt = parseCanonicalIso(
    body.soakStartedAt,
    "body.soakStartedAt",
  );
  const soakEndedAt = parseCanonicalIso(body.soakEndedAt, "body.soakEndedAt");
  const observedAt = parseCanonicalIso(body.observedAt, "body.observedAt");
  if (
    soakStartedAt >= soakEndedAt ||
    soakEndedAt !== observedAt
  ) {
    fail(
      "INVALID_SOAK_WINDOW",
      "promotion soak must end exactly at observedAt after a positive interval",
    );
  }
}

function validateEvidenceBody(body, evidenceClass) {
  validateCommonBody(body, evidenceClass);
  switch (evidenceClass) {
    case "natural-cycle":
      validateNaturalCycleBody(body);
      break;
    case "deployed-api":
      validateDeployedApiBody(body);
      break;
    case "browser-capture":
      validateBrowserCaptureBody(body);
      break;
    case "change":
      validateChangeBody(body);
      break;
    case "promotion-readback":
      validatePromotionReadbackBody(body);
      break;
    default:
      fail("INVALID_EVIDENCE_CLASS", "evidenceClass is not supported");
  }
  return true;
}

function validateExpectedContext(expected) {
  requireExactKeys(expected, EXPECTED_CONTEXT_KEYS, "expected context");
  if (!EVIDENCE_CLASSES.includes(expected.evidenceClass)) {
    fail("INVALID_EVIDENCE_CLASS", "expected evidenceClass is not supported");
  }
  requirePattern(
    expected.phaseId,
    PHASE_ID_PATTERN,
    "expected.phaseId",
    "INVALID_PHASE_ID",
  );
  requirePositiveInteger(expected.ledgerRevision, "expected.ledgerRevision");
  requireGitObject(expected.candidateCommit, "expected.candidateCommit");
  requireGitObject(expected.candidateTree, "expected.candidateTree");
  requireIdentifier(expected.deploymentId, "expected.deploymentId");
  requireIdentifier(expected.sourceId, "expected.sourceId");
  parseCanonicalIso(expected.observedAt, "expected.observedAt");
  requirePattern(
    expected.nonce,
    NONCE_PATTERN,
    "expected.nonce",
    "INVALID_NONCE",
  );
  requireSha256(
    expected.authorityRegistrySha256,
    "expected.authorityRegistrySha256",
  );
}

function replayKeyForNonce(nonce) {
  requirePattern(nonce, NONCE_PATTERN, "nonce", "INVALID_NONCE");
  return sha256(
    canonicalJson(
      { schema: REPLAY_KEY_SCHEMA, nonce },
      "replay identity",
      1024,
    ),
  );
}

function signableReceiptValue(receipt) {
  const signable = {};
  for (const key of SIGNABLE_RECEIPT_KEYS) {
    signable[key] = receipt[key];
  }
  return signable;
}

function originEvidenceSigningBytes(receipt) {
  if (
    !exactKeys(receipt, RECEIPT_KEYS) &&
    !exactKeys(receipt, UNSIGNED_RECEIPT_KEYS)
  ) {
    fail(
      "UNEXPECTED_FIELDS",
      "receipt signing input must contain exactly the receipt fields",
    );
  }
  const canonical = canonicalJson(
    signableReceiptValue(receipt),
    "receipt signing payload",
    MAX_RECEIPT_BYTES,
  );
  return Buffer.concat([SIGNATURE_DOMAIN, Buffer.from(canonical, "utf8")]);
}

function importEd25519PrivateKey(privateKey) {
  let key;
  try {
    key =
      privateKey instanceof crypto.KeyObject && privateKey.type === "private"
        ? privateKey
        : crypto.createPrivateKey(privateKey);
  } catch (error) {
    fail("INVALID_PRIVATE_KEY", "private key cannot be imported", {
      cause: error.message,
    });
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("INVALID_PRIVATE_KEY", "private key must be an Ed25519 private key");
  }
  return key;
}

function issueOriginEvidenceReceipt({
  registry,
  evidenceClass,
  body,
  privateKey,
}) {
  validateAuthorityRegistry(registry);
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) {
    fail("INVALID_EVIDENCE_CLASS", "evidenceClass is not supported");
  }
  validateEvidenceBody(body, evidenceClass);
  const authority = registry.authorities[evidenceClass];
  const signingKey = importEd25519PrivateKey(privateKey);
  const signerDer = crypto
    .createPublicKey(signingKey)
    .export({ format: "der", type: "spki" });
  const pinnedDer = Buffer.from(authority.publicKeySpkiBase64, "base64");
  if (
    signerDer.length !== pinnedDer.length ||
    !crypto.timingSafeEqual(signerDer, pinnedDer)
  ) {
    fail(
      "UNPINNED_SIGNING_KEY",
      "private key does not match the pinned class authority",
    );
  }

  const unsignedReceipt = {
    schema: RECEIPT_SCHEMA,
    evidenceClass,
    authorityRegistrySha256: registry.registryHash,
    issuerId: authority.issuerId,
    publicKeySha256: authority.publicKeySha256,
    body,
    bodySha256: sha256(
      canonicalJson(body, `${evidenceClass} body`, MAX_BODY_BYTES),
    ),
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    replayKeySha256: replayKeyForNonce(body.nonce),
    productionAuthority: false,
  };
  const signature = crypto.sign(
    null,
    originEvidenceSigningBytes(unsignedReceipt),
    signingKey,
  );
  const receipt = {
    ...unsignedReceipt,
    signatureBase64: signature.toString("base64"),
  };
  receipt.receiptHash = sha256(
    canonicalJson(receipt, "origin evidence receipt content", MAX_RECEIPT_BYTES),
  );
  return receipt;
}

function validateReceiptStructure(receipt, registry, expected, nowMs) {
  canonicalJson(receipt, "origin evidence receipt", MAX_RECEIPT_BYTES);
  requireExactKeys(receipt, RECEIPT_KEYS, "origin evidence receipt");
  if (receipt.schema !== RECEIPT_SCHEMA) {
    fail("INVALID_RECEIPT_SCHEMA", "origin evidence receipt schema is invalid");
  }
  if (receipt.evidenceClass !== expected.evidenceClass) {
    fail(
      "EVIDENCE_CLASS_MISMATCH",
      "receipt evidence class does not match the expected class",
    );
  }
  if (
    receipt.authorityRegistrySha256 !== expected.authorityRegistrySha256 ||
    receipt.authorityRegistrySha256 !== registry.registryHash
  ) {
    fail(
      "REGISTRY_BINDING_MISMATCH",
      "receipt does not bind the pinned authority registry",
    );
  }

  const authority = registry.authorities[receipt.evidenceClass];
  if (
    receipt.issuerId !== authority.issuerId ||
    receipt.publicKeySha256 !== authority.publicKeySha256
  ) {
    fail(
      "ISSUER_SUBSTITUTION",
      "receipt issuer does not match the pinned class authority",
    );
  }
  if (receipt.signatureAlgorithm !== SIGNATURE_ALGORITHM) {
    fail("INVALID_SIGNATURE_ALGORITHM", "receipt must use Ed25519");
  }
  if (receipt.productionAuthority !== false) {
    fail(
      "PRODUCTION_AUTHORITY_FORBIDDEN",
      "origin evidence never grants production authority",
    );
  }

  validateEvidenceBody(receipt.body, receipt.evidenceClass);
  requireSha256(receipt.bodySha256, "receipt.bodySha256");
  const expectedBodyHash = sha256(
    canonicalJson(
      receipt.body,
      `${receipt.evidenceClass} body`,
      MAX_BODY_BYTES,
    ),
  );
  if (receipt.bodySha256 !== expectedBodyHash) {
    fail("BODY_HASH_MISMATCH", "receipt body hash is invalid");
  }

  for (const field of [
    "phaseId",
    "ledgerRevision",
    "candidateCommit",
    "candidateTree",
    "deploymentId",
    "sourceId",
    "observedAt",
    "nonce",
  ]) {
    if (receipt.body[field] !== expected[field]) {
      fail(
        "EXPECTED_CONTEXT_MISMATCH",
        `receipt body ${field} does not match the expected context`,
        { field },
      );
    }
  }

  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail("INVALID_VERIFICATION_TIME", "nowMs must be a nonnegative safe integer");
  }
  const observedAtMs = parseCanonicalIso(
    receipt.body.observedAt,
    "receipt.body.observedAt",
  );
  if (observedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    fail("FUTURE_EVIDENCE", "origin evidence is too far in the future");
  }
  const maximumAgeMs = CLASS_CONFIG[receipt.evidenceClass].maximumAgeMs;
  if (nowMs - observedAtMs > maximumAgeMs) {
    fail("STALE_EVIDENCE", "origin evidence is stale", {
      maximumAgeMs,
      ageMs: nowMs - observedAtMs,
    });
  }

  requireSha256(receipt.replayKeySha256, "receipt.replayKeySha256");
  const expectedReplayKey = replayKeyForNonce(receipt.body.nonce);
  if (receipt.replayKeySha256 !== expectedReplayKey) {
    fail("REPLAY_KEY_MISMATCH", "receipt replay key is invalid");
  }

  decodeCanonicalBase64(
    receipt.signatureBase64,
    "receipt.signatureBase64",
    64,
    64,
  );
  requireSha256(receipt.receiptHash, "receipt.receiptHash");
  const expectedReceiptHash = hashWithoutField(
    receipt,
    "receiptHash",
    "origin evidence receipt content",
    MAX_RECEIPT_BYTES,
  );
  if (receipt.receiptHash !== expectedReceiptHash) {
    fail("RECEIPT_HASH_MISMATCH", "origin evidence receipt hash is invalid");
  }
  return authority;
}

function verifyOriginEvidence(receipt, options) {
  requireExactKeys(options, VERIFY_OPTIONS_KEYS, "verification options");
  const { registry, expected, nowMs } = options;
  validateAuthorityRegistry(registry);
  validateExpectedContext(expected);
  if (expected.authorityRegistrySha256 !== registry.registryHash) {
    fail(
      "REGISTRY_BINDING_MISMATCH",
      "expected context does not pin the supplied authority registry",
    );
  }
  const authority = validateReceiptStructure(
    receipt,
    registry,
    expected,
    nowMs,
  );
  const signature = Buffer.from(receipt.signatureBase64, "base64");
  const { key } = importEd25519PublicKey(
    authority,
    `authority ${receipt.evidenceClass}`,
  );
  const verified = crypto.verify(
    null,
    originEvidenceSigningBytes(receipt),
    key,
    signature,
  );
  if (!verified) {
    fail(
      "INVALID_ORIGIN_SIGNATURE",
      "origin evidence signature does not verify under the pinned class key",
    );
  }
  return Object.freeze({
    ok: true,
    evidenceClass: receipt.evidenceClass,
    issuerId: receipt.issuerId,
    authorityIdentitySha256: authority.authorityIdentitySha256,
    phaseId: receipt.body.phaseId,
    candidateCommit: receipt.body.candidateCommit,
    candidateTree: receipt.body.candidateTree,
    deploymentId: receipt.body.deploymentId,
    sourceId: receipt.body.sourceId,
    observedAt: receipt.body.observedAt,
    nonce: receipt.body.nonce,
    replayKeySha256: receipt.replayKeySha256,
    receiptHash: receipt.receiptHash,
    productionAuthority: false,
  });
}

function createInMemoryReplayStore() {
  const consumed = new Map();
  return Object.freeze({
    consume(consumption) {
      requireExactKeys(
        consumption,
        REPLAY_CONSUMPTION_KEYS,
        "replay consumption",
      );
      requireSha256(
        consumption.replayKeySha256,
        "replay consumption replayKeySha256",
      );
      requireSha256(consumption.receiptHash, "replay consumption receiptHash");
      if (!EVIDENCE_CLASSES.includes(consumption.evidenceClass)) {
        fail(
          "INVALID_EVIDENCE_CLASS",
          "replay consumption evidenceClass is invalid",
        );
      }
      requirePattern(
        consumption.nonce,
        NONCE_PATTERN,
        "replay consumption nonce",
        "INVALID_NONCE",
      );
      if (
        replayKeyForNonce(consumption.nonce) !==
        consumption.replayKeySha256
      ) {
        fail(
          "REPLAY_KEY_MISMATCH",
          "replay consumption nonce does not match its replay key",
        );
      }
      if (consumed.has(consumption.replayKeySha256)) {
        return false;
      }
      consumed.set(consumption.replayKeySha256, Object.freeze({ ...consumption }));
      return true;
    },
    has(replayKeySha256) {
      return consumed.has(replayKeySha256);
    },
    size() {
      return consumed.size;
    },
  });
}

function verifyAndConsumeOriginEvidence(receipt, options) {
  requireExactKeys(options, CONSUME_OPTIONS_KEYS, "consumption options");
  const { registry, expected, nowMs, replayStore } = options;
  if (!replayStore || typeof replayStore.consume !== "function") {
    fail(
      "INVALID_REPLAY_STORE",
      "replayStore must expose a synchronous atomic consume operation",
    );
  }
  const verified = verifyOriginEvidence(receipt, {
    registry,
    expected,
    nowMs,
  });
  let consumed;
  try {
    consumed = replayStore.consume({
      replayKeySha256: verified.replayKeySha256,
      receiptHash: verified.receiptHash,
      evidenceClass: verified.evidenceClass,
      nonce: verified.nonce,
    });
  } catch (error) {
    if (error instanceof OriginEvidenceError) throw error;
    fail("REPLAY_STORE_FAILURE", "replay store failed closed", {
      cause: error.message,
    });
  }
  if (consumed !== true) {
    fail(
      "REPLAY_DETECTED",
      "origin evidence nonce has already been consumed",
    );
  }
  return Object.freeze({ ...verified, replayConsumed: true });
}

module.exports = {
  AUTHORITY_REGISTRY_SCHEMA,
  CLASS_CONFIG,
  EVIDENCE_CLASSES,
  MAX_BODY_BYTES,
  MAX_FUTURE_SKEW_MS,
  MAX_RECEIPT_BYTES,
  MAX_REGISTRY_BYTES,
  RECEIPT_SCHEMA,
  REPLAY_KEY_SCHEMA,
  SIGNATURE_ALGORITHM,
  OriginEvidenceError,
  buildAuthorityRecord,
  buildAuthorityRegistry,
  createInMemoryReplayStore,
  issueOriginEvidenceReceipt,
  originEvidenceSigningBytes,
  replayKeyForNonce,
  sha256,
  stableJson,
  validateAuthorityRegistry,
  validateEvidenceBody,
  verifyAndConsumeOriginEvidence,
  verifyOriginEvidence,
};

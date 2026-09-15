"use strict";

const crypto = require("node:crypto");

const COLLECTOR_RECEIPT_SCHEMA =
  "pikiio-github-oidc-collector-receipt-v3";
const JWKS_REGISTRY_SCHEMA = "pikiio-github-oidc-jwks-registry-v1";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_REPOSITORY = "demo-maintainer/Pikiio-app-";
const EXPECTED_REPOSITORY_ID = "1256222775";
const EXPECTED_REPOSITORY_OWNER = "demo-maintainer";
const EXPECTED_REPOSITORY_OWNER_ID = "255220455";
const EXPECTED_REPOSITORY_VISIBILITY = "private";
const EXPECTED_RUNNER_ENVIRONMENT = "github-hosted";
const AUTHORITY_REF = "pikiio-proof-authority-v3";
const AUTHORITY_GIT_REF = `refs/tags/${AUTHORITY_REF}`;
const REQUEST_WORKFLOW_PATH =
  ".github/workflows/pikiio-proof-request-v3.yml";
const COLLECTOR_WORKFLOW_PATH =
  ".github/workflows/pikiio-proof-collector-v3.yml";
const MAX_JWT_BYTES = 48 * 1024;
const MAX_RECEIPT_BYTES = 96 * 1024;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;
const MAX_COLLECTION_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 30;
const MAX_SIGNATURE_BYTES = 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DIGIT_STRING_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const REGISTRY_KEYS = Object.freeze([
  "schema",
  "revision",
  "issuer",
  "keys",
  "registrySha256",
]);
const JWK_KEYS = Object.freeze([
  "kty",
  "alg",
  "use",
  "kid",
  "n",
  "e",
  "x5t",
]);
const RECEIPT_KEYS = Object.freeze([
  "schema",
  "attestationBodySha256",
  "audience",
  "oidcToken",
  "authorityCommit",
  "phaseScopeBaseCommit",
  "candidateCommit",
  "run",
  "requestedAt",
  "receivedAt",
  "productionAuthority",
]);
const RUN_KEYS = Object.freeze(["runId", "runAttempt", "requestNonce"]);

class GithubOidcCollectorV3Error extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GithubOidcCollectorV3Error";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new GithubOidcCollectorV3Error(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(stableValue(value));
  } catch (error) {
    fail("NON_CANONICAL_JSON", "value cannot be canonically serialized", {
      cause: error.message,
    });
  }
  if (typeof serialized !== "string") {
    fail("NON_CANONICAL_JSON", "value cannot be canonically serialized");
  }
  return serialized;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function requireBoundedString(
  value,
  label,
  { maximum = 2048, allowEmpty = false } = {},
) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maximum ||
    value.includes("\u0000")
  ) {
    fail("INVALID_STRING", `${label} is not a bounded string`);
  }
}

function requirePattern(value, pattern, label, code) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, `${label} is invalid`);
  }
}

function requireCommit(value, label) {
  requirePattern(value, COMMIT_PATTERN, label, "INVALID_COMMIT");
}

function requireSha(value, label) {
  requirePattern(value, SHA256_PATTERN, label, "INVALID_SHA256");
}

function requireDigitString(value, label) {
  requirePattern(value, DIGIT_STRING_PATTERN, label, "INVALID_RUN");
}

function boundedBytes(value, label, maximum) {
  const bytes = Buffer.from(stableJson(value), "utf8");
  if (bytes.length > maximum) {
    fail("SIZE_LIMIT_EXCEEDED", `${label} exceeds its byte limit`, {
      bytes: bytes.length,
      maximum,
    });
  }
  return bytes;
}

function hashWithoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function validatePinnedJwksRegistryV3(registry, expectedSha256) {
  boundedBytes(registry, "JWKS registry", MAX_REGISTRY_BYTES);
  requireExactKeys(registry, REGISTRY_KEYS, "JWKS registry");
  if (
    registry.schema !== JWKS_REGISTRY_SCHEMA ||
    registry.revision !== 1 ||
    registry.issuer !== GITHUB_OIDC_ISSUER
  ) {
    fail("INVALID_JWKS_REGISTRY", "JWKS registry authority is invalid");
  }
  requireSha(registry.registrySha256, "JWKS registry.registrySha256");
  if (
    registry.registrySha256 !==
      hashWithoutField(registry, "registrySha256") ||
    registry.registrySha256 !== expectedSha256
  ) {
    fail("JWKS_REGISTRY_MISMATCH", "JWKS registry is not the trusted snapshot");
  }
  if (
    !Array.isArray(registry.keys) ||
    registry.keys.length === 0 ||
    registry.keys.length > 16
  ) {
    fail("INVALID_JWKS_REGISTRY", "JWKS key population is invalid");
  }
  const kids = new Set();
  for (const [index, key] of registry.keys.entries()) {
    requireExactKeys(key, JWK_KEYS, `JWKS key ${index}`);
    if (
      key.kty !== "RSA" ||
      key.alg !== "RS256" ||
      key.use !== "sig" ||
      !KID_PATTERN.test(String(key.kid || "")) ||
      !BASE64URL_PATTERN.test(String(key.n || "")) ||
      !BASE64URL_PATTERN.test(String(key.e || "")) ||
      (key.x5t !== null &&
        !BASE64URL_PATTERN.test(String(key.x5t || ""))) ||
      kids.has(key.kid)
    ) {
      fail("INVALID_JWKS_KEY", "JWKS contains an unsafe or duplicate key");
    }
    const modulusBytes = Buffer.from(key.n, "base64url").length;
    if (modulusBytes < 256 || modulusBytes > 1024) {
      fail("INVALID_JWKS_KEY", "JWKS RSA modulus is outside its bounds");
    }
    kids.add(key.kid);
  }
  return registry;
}

function validateRun(run) {
  requireExactKeys(run, RUN_KEYS, "collector run");
  requireDigitString(run.runId, "collector run.runId");
  requireDigitString(run.runAttempt, "collector run.runAttempt");
  requirePattern(
    run.requestNonce,
    SHA256_PATTERN,
    "collector run.requestNonce",
    "INVALID_NONCE",
  );
}

function validateCollectorReceiptV3(receipt) {
  boundedBytes(receipt, "collector receipt", MAX_RECEIPT_BYTES);
  requireExactKeys(receipt, RECEIPT_KEYS, "collector receipt");
  if (receipt.schema !== COLLECTOR_RECEIPT_SCHEMA) {
    fail("INVALID_SCHEMA", "collector receipt schema is not v3");
  }
  requireSha(
    receipt.attestationBodySha256,
    "collector receipt.attestationBodySha256",
  );
  requireBoundedString(receipt.audience, "collector receipt.audience", {
    maximum: 128,
  });
  if (
    receipt.audience !==
      `pikiio-proof-v3:${receipt.attestationBodySha256}`
  ) {
    fail("AUDIENCE_MISMATCH", "collector audience does not bind the body");
  }
  requireBoundedString(receipt.oidcToken, "collector receipt.oidcToken", {
    maximum: MAX_JWT_BYTES,
  });
  requireCommit(receipt.authorityCommit, "collector receipt.authorityCommit");
  requireCommit(
    receipt.phaseScopeBaseCommit,
    "collector receipt.phaseScopeBaseCommit",
  );
  requireCommit(receipt.candidateCommit, "collector receipt.candidateCommit");
  validateRun(receipt.run);
  for (const key of ["requestedAt", "receivedAt"]) {
    requireBoundedString(receipt[key], `collector receipt.${key}`, {
      maximum: 64,
    });
    if (!Number.isFinite(Date.parse(receipt[key]))) {
      fail("INVALID_TIMESTAMP", `collector receipt.${key} is invalid`);
    }
  }
  const collectionMs =
    Date.parse(receipt.receivedAt) - Date.parse(receipt.requestedAt);
  if (
    collectionMs < 0 ||
    collectionMs > MAX_COLLECTION_SECONDS * 1000
  ) {
    fail("COLLECTION_WINDOW_INVALID", "OIDC collection window is invalid");
  }
  if (receipt.productionAuthority !== false) {
    fail("PRODUCTION_AUTHORITY_FORBIDDEN", "collector cannot grant production");
  }
  return receipt;
}

function decodeJsonSegment(segment, label, maximum) {
  if (
    typeof segment !== "string" ||
    segment.length === 0 ||
    segment.length > maximum ||
    !BASE64URL_PATTERN.test(segment)
  ) {
    fail("INVALID_JWT", `${label} is not bounded base64url`);
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    fail("INVALID_JWT", `${label} is not JSON`);
  }
  if (!isPlainObject(value)) {
    fail("INVALID_JWT", `${label} must be an object`);
  }
  return value;
}

function parseAndVerifyToken(token, registry) {
  if (Buffer.byteLength(token, "utf8") > MAX_JWT_BYTES) {
    fail("SIZE_LIMIT_EXCEEDED", "OIDC token exceeds its byte limit");
  }
  const segments = token.split(".");
  if (segments.length !== 3) {
    fail("INVALID_JWT", "OIDC token is not compact JWT");
  }
  if (
    segments[2].length === 0 ||
    segments[2].length > Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) ||
    !BASE64URL_PATTERN.test(segments[2])
  ) {
    fail("INVALID_JWT", "OIDC signature is not bounded base64url");
  }
  const signature = Buffer.from(segments[2], "base64url");
  if (
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_BYTES ||
    signature.toString("base64url") !== segments[2]
  ) {
    fail("INVALID_JWT", "OIDC signature is not canonical base64url");
  }
  const header = decodeJsonSegment(segments[0], "JWT header", 4096);
  const payload = decodeJsonSegment(segments[1], "JWT payload", 32768);
  const headerKeys = Object.keys(header).sort();
  const allowedHeaderKeys = [
    ["alg", "kid", "typ"],
    ["alg", "kid", "typ", "x5t"],
  ];
  if (
    !allowedHeaderKeys.some(
      (keys) => stableJson(keys) === stableJson(headerKeys),
    ) ||
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    !KID_PATTERN.test(String(header.kid || ""))
  ) {
    fail("INVALID_JWT_HEADER", "JWT header is not pinned RS256");
  }
  const jwk = registry.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    fail("UNKNOWN_SIGNING_KEY", "JWT signing key is absent from the registry");
  }
  if (
    Object.hasOwn(header, "x5t") &&
    header.x5t !== jwk.x5t
  ) {
    fail("SIGNING_KEY_MISMATCH", "JWT x5t does not match the pinned key");
  }
  let keyObject;
  try {
    keyObject = crypto.createPublicKey({
      key: {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
      },
      format: "jwk",
    });
  } catch {
    fail("INVALID_JWKS_KEY", "JWT public key cannot be constructed");
  }
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"),
    keyObject,
    signature,
  );
  if (!valid) {
    fail("INVALID_SIGNATURE", "JWT signature verification failed");
  }
  return { header, payload };
}

function requireClaimString(payload, key, maximum = 2048) {
  requireBoundedString(payload[key], `JWT ${key}`, { maximum });
}

function validateClaims(payload, {
  expectedAudience,
  authorityCommit,
  expectedRun,
  expectedJti,
  collectionMs,
}) {
  for (const key of [
    "iss",
    "aud",
    "repository",
    "repository_id",
    "repository_owner",
    "repository_owner_id",
    "repository_visibility",
    "runner_environment",
    "event_name",
    "ref",
    "ref_type",
    "ref_protected",
    "sha",
    "workflow_ref",
    "workflow_sha",
    "job_workflow_ref",
    "job_workflow_sha",
    "run_id",
    "run_attempt",
    "jti",
    "sub",
  ]) {
    requireClaimString(payload, key);
  }
  for (const key of ["iat", "nbf", "exp"]) {
    if (!Number.isSafeInteger(payload[key]) || payload[key] < 1) {
      fail("INVALID_TOKEN_TIME", `JWT ${key} must be a positive integer`);
    }
  }
  requirePattern(payload.jti, UUID_PATTERN, "JWT jti", "INVALID_JTI");
  requireCommit(payload.sha, "JWT sha");
  requireCommit(payload.workflow_sha, "JWT workflow_sha");
  requireCommit(payload.job_workflow_sha, "JWT job_workflow_sha");
  requireDigitString(payload.run_id, "JWT run_id");
  requireDigitString(payload.run_attempt, "JWT run_attempt");

  const expectedRequestWorkflowRef =
    `${EXPECTED_REPOSITORY}/${REQUEST_WORKFLOW_PATH}@${AUTHORITY_GIT_REF}`;
  const expectedCollectorWorkflowRef =
    `${EXPECTED_REPOSITORY}/${COLLECTOR_WORKFLOW_PATH}@${AUTHORITY_GIT_REF}`;
  const expectedSubject =
    `repo:${EXPECTED_REPOSITORY}:ref:${AUTHORITY_GIT_REF}`;
  const exactBindings = [
    [payload.iss, GITHUB_OIDC_ISSUER],
    [payload.aud, expectedAudience],
    [payload.repository, EXPECTED_REPOSITORY],
    [payload.repository_id, EXPECTED_REPOSITORY_ID],
    [payload.repository_owner, EXPECTED_REPOSITORY_OWNER],
    [payload.repository_owner_id, EXPECTED_REPOSITORY_OWNER_ID],
    [payload.repository_visibility, EXPECTED_REPOSITORY_VISIBILITY],
    [payload.runner_environment, EXPECTED_RUNNER_ENVIRONMENT],
    [payload.event_name, "workflow_dispatch"],
    [payload.ref, AUTHORITY_GIT_REF],
    [payload.ref_type, "tag"],
    [payload.sha, authorityCommit],
    [payload.workflow_ref, expectedRequestWorkflowRef],
    [payload.workflow_sha, authorityCommit],
    [payload.job_workflow_ref, expectedCollectorWorkflowRef],
    [payload.job_workflow_sha, authorityCommit],
    [payload.run_id, expectedRun.runId],
    [payload.run_attempt, expectedRun.runAttempt],
    [payload.jti, expectedJti],
    [payload.sub, expectedSubject],
  ];
  if (exactBindings.some(([actual, expected]) => actual !== expected)) {
    fail("OIDC_IDENTITY_MISMATCH", "JWT does not bind the exact v3 authority");
  }
  if (payload.ref_protected !== "true") {
    fail(
      "OIDC_IDENTITY_MISMATCH",
      "the frozen authority tag must be protected",
    );
  }
  if (
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS ||
    payload.nbf > payload.iat + CLOCK_SKEW_SECONDS
  ) {
    fail("INVALID_TOKEN_TIME", "JWT signed lifetime is invalid");
  }
  const collectionSeconds = Math.floor(collectionMs / 1000);
  if (
    collectionSeconds < payload.nbf - CLOCK_SKEW_SECONDS ||
    collectionSeconds > payload.exp + CLOCK_SKEW_SECONDS
  ) {
    fail("TOKEN_NOT_CURRENT", "JWT was not current when collected");
  }
  return payload;
}

function verifyGithubOidcCollectorV3({
  collectorReceipt,
  jwksRegistry,
  expectedAttestationBody,
  expectedAttestationBodySha256,
  expectedAuthorityCommit,
  expectedPhaseScopeBaseCommit,
  expectedCandidateCommit,
  expectedRun,
  expectedIssuer,
  expectedJti,
  expectedReplayKeySha256,
  expectedJwksRegistrySha256,
  nowMs = Date.now(),
}) {
  const receipt = validateCollectorReceiptV3(collectorReceipt);
  if (
    Date.parse(receipt.receivedAt) >
    nowMs + CLOCK_SKEW_SECONDS * 1000
  ) {
    fail("FUTURE_EVIDENCE", "collector receipt is future-dated");
  }
  boundedBytes(expectedAttestationBody, "expected attestation body", 512 * 1024);
  requireSha(
    expectedAttestationBodySha256,
    "expectedAttestationBodySha256",
  );
  if (
    sha256(stableJson(expectedAttestationBody)) !==
      expectedAttestationBodySha256 ||
    receipt.attestationBodySha256 !== expectedAttestationBodySha256
  ) {
    fail("ATTESTATION_BODY_MISMATCH", "collector body digest is not expected");
  }
  for (const [actual, expected, label] of [
    [receipt.authorityCommit, expectedAuthorityCommit, "authority A"],
    [
      receipt.phaseScopeBaseCommit,
      expectedPhaseScopeBaseCommit,
      "scope S",
    ],
    [receipt.candidateCommit, expectedCandidateCommit, "candidate C"],
    [receipt.run.runId, expectedRun.runId, "run ID"],
    [receipt.run.runAttempt, expectedRun.runAttempt, "run attempt"],
    [receipt.run.requestNonce, expectedRun.requestNonce, "request nonce"],
  ]) {
    if (actual !== expected) {
      fail("COLLECTOR_BINDING_MISMATCH", `collector ${label} is not expected`);
    }
  }
  if (expectedIssuer !== GITHUB_OIDC_ISSUER) {
    fail("INVALID_OIDC_ISSUER", "expected issuer is not GitHub Actions");
  }
  requirePattern(expectedJti, UUID_PATTERN, "expectedJti", "INVALID_JTI");
  requireSha(expectedReplayKeySha256, "expectedReplayKeySha256");
  const registry = validatePinnedJwksRegistryV3(
    jwksRegistry,
    expectedJwksRegistrySha256,
  );
  const { payload } = parseAndVerifyToken(receipt.oidcToken, registry);
  validateClaims(payload, {
    expectedAudience: receipt.audience,
    authorityCommit: expectedAuthorityCommit,
    expectedRun,
    expectedJti,
    collectionMs: Date.parse(receipt.receivedAt),
  });
  const requestedSeconds = Math.floor(
    Date.parse(receipt.requestedAt) / 1000,
  );
  const receivedSeconds = Math.floor(
    Date.parse(receipt.receivedAt) / 1000,
  );
  if (
    payload.iat < requestedSeconds - CLOCK_SKEW_SECONDS ||
    payload.iat > receivedSeconds + CLOCK_SKEW_SECONDS
  ) {
    fail("COLLECTION_WINDOW_INVALID", "JWT issue time is outside collection");
  }
  const replayKeySha256 = sha256(
    stableJson({
      issuer: payload.iss,
      jti: payload.jti,
      repository: EXPECTED_REPOSITORY,
      runId: receipt.run.runId,
      runAttempt: receipt.run.runAttempt,
    }),
  );
  if (replayKeySha256 !== expectedReplayKeySha256) {
    fail("REPLAY_BINDING_MISMATCH", "JWT replay key is not expected");
  }
  return Object.freeze({
    valid: true,
    attestationBodySha256: expectedAttestationBodySha256,
    collectorReceiptSha256: sha256(stableJson(receipt)),
    authorityCommit: expectedAuthorityCommit,
    phaseScopeBaseCommit: expectedPhaseScopeBaseCommit,
    candidateCommit: expectedCandidateCommit,
    runId: expectedRun.runId,
    runAttempt: expectedRun.runAttempt,
    requestNonce: expectedRun.requestNonce,
    issuer: payload.iss,
    jti: payload.jti,
    replayKeySha256,
    repositoryId: payload.repository_id,
    repositoryOwnerId: payload.repository_owner_id,
    productionAuthority: false,
  });
}

module.exports = {
  AUTHORITY_GIT_REF,
  AUTHORITY_REF,
  CLOCK_SKEW_SECONDS,
  COLLECTOR_RECEIPT_SCHEMA,
  COLLECTOR_WORKFLOW_PATH,
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_ID,
  EXPECTED_REPOSITORY_OWNER,
  EXPECTED_REPOSITORY_OWNER_ID,
  EXPECTED_REPOSITORY_VISIBILITY,
  EXPECTED_RUNNER_ENVIRONMENT,
  GITHUB_OIDC_ISSUER,
  GithubOidcCollectorV3Error,
  JWKS_REGISTRY_SCHEMA,
  MAX_COLLECTION_SECONDS,
  MAX_JWT_BYTES,
  MAX_RECEIPT_BYTES,
  MAX_SIGNATURE_BYTES,
  MAX_REGISTRY_BYTES,
  MAX_TOKEN_LIFETIME_SECONDS,
  REQUEST_WORKFLOW_PATH,
  hashWithoutField,
  sha256,
  stableJson,
  validateCollectorReceiptV3,
  validatePinnedJwksRegistryV3,
  verifyGithubOidcCollectorV3,
};

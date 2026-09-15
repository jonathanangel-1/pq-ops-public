"use strict";

const crypto = require("node:crypto");

const {
  buildAttestationBody,
  sha256,
  stableJson,
  validateAttestationBody,
} = require("./pikiio-phase-attestation");

const COLLECTOR_RECEIPT_SCHEMA =
  "pikiio-github-oidc-collector-receipt-v1";
const COLLECTOR_PROOF_INPUT_SCHEMA =
  "pikiio-github-oidc-collector-proof-input-v1";
const JWKS_REGISTRY_SCHEMA = "pikiio-github-oidc-jwks-registry-v1";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_REPOSITORY = "demo-maintainer/Pikiio-app-";
const EXPECTED_REPOSITORY_OWNER = "demo-maintainer";
const EXPECTED_REPOSITORY_VISIBILITY = "private";
const EXPECTED_RUNNER_ENVIRONMENT = "github-hosted";
const REUSABLE_WORKFLOW_PATH =
  ".github/workflows/pikiio-proof-collector.yml";
const REUSABLE_WORKFLOW_REF = "pikiio-proof-authority-v1";

const MAX_JWT_BYTES = 48 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;
const MAX_NOT_BEFORE_LEAD_SECONDS = 5 * 60;
const MAX_COLLECTION_SECONDS = 30;
const CLOCK_SKEW_SECONDS = 30;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DIGIT_STRING_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]+)$/;

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
  "bodySha256",
  "audience",
  "candidateCommit",
  "scopeBaseCommit",
  "reusableWorkflowRef",
  "jwksRegistrySha256",
  "requestedAt",
  "receivedAt",
  "oidc",
  "oidcToken",
  "receiptHash",
]);
const OIDC_PROJECTION_KEYS = Object.freeze([
  "issuer",
  "eventName",
  "runId",
  "runNumber",
  "runAttempt",
  "checkRunId",
  "jti",
  "issuedAt",
  "notBefore",
  "expiresAt",
]);
const EXPECTED_RUN_KEYS = Object.freeze([
  "eventName",
  "runId",
  "runNumber",
  "runAttempt",
  "checkRunId",
]);
const PROOF_INPUT_KEYS = Object.freeze([
  "schema",
  "phase",
  "candidate",
  "quality",
  "receiptHashes",
]);
const PROOF_PHASE_KEYS = Object.freeze([
  "phaseId",
  "issuerRegistrySha256",
  "ledgerRevision",
  "ledgerSha256",
]);
const PROOF_CANDIDATE_KEYS = Object.freeze(["commit", "tree"]);
const PROOF_QUALITY_KEYS = Object.freeze([
  "strictReceiptHash",
  "commandPlanHash",
  "primaryRawArtifactHash",
  "independentRawArtifactHash",
]);
const PROOF_RECEIPT_KEYS = Object.freeze([
  "candidate",
  "rehearsal",
  "change",
  "promotion",
]);
const JWT_CLAIM_KEYS = Object.freeze([
  "actor",
  "actor_id",
  "aud",
  "base_ref",
  "check_run_id",
  "event_name",
  "exp",
  "head_ref",
  "iat",
  "iss",
  "job_workflow_ref",
  "job_workflow_sha",
  "jti",
  "nbf",
  "ref",
  "ref_protected",
  "ref_type",
  "repository",
  "repository_id",
  "repository_owner",
  "repository_owner_id",
  "repository_visibility",
  "run_attempt",
  "run_id",
  "run_number",
  "runner_environment",
  "sha",
  "sub",
  "workflow",
  "workflow_ref",
  "workflow_sha",
]);

class GithubOidcCollectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GithubOidcCollectorError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new GithubOidcCollectorError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_SHA256", `${label} must be a lowercase SHA-256 digest`);
  }
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    fail("INVALID_COMMIT", `${label} must be a full lowercase commit SHA`);
  }
}

function requireBoundedString(value, label, { allowEmpty = false, max = 1024 } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > max ||
    value.includes("\u0000")
  ) {
    fail("INVALID_STRING", `${label} is not a bounded string`);
  }
}

function canonicalJsonBytes(value, label, maximum) {
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

function decodeBase64url(value, label, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("=") ||
    !BASE64URL_PATTERN.test(value)
  ) {
    fail("INVALID_BASE64URL", `${label} must be unpadded canonical base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > maximumBytes ||
    bytes.toString("base64url") !== value
  ) {
    fail("INVALID_BASE64URL", `${label} must be unpadded canonical base64url`);
  }
  return bytes;
}

function parseJsonSegment(segment, label, maximumBytes) {
  const bytes = decodeBase64url(segment, label, maximumBytes);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("INVALID_UTF8", `${label} is not valid UTF-8`, {
      cause: error.message,
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("INVALID_JSON", `${label} is not valid JSON`, {
      cause: error.message,
    });
  }
  if (!isPlainObject(value)) {
    fail("INVALID_JSON_OBJECT", `${label} must decode to a plain object`);
  }
  return value;
}

function parseGithubOidcToken(token) {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") > MAX_JWT_BYTES
  ) {
    fail("INVALID_JWT", "GitHub OIDC token is missing or oversized");
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    fail("INVALID_JWT", "GitHub OIDC token must have exactly three segments");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseJsonSegment(encodedHeader, "JWT header", 4 * 1024);
  const payload = parseJsonSegment(encodedPayload, "JWT payload", 32 * 1024);
  const signature = decodeBase64url(
    encodedSignature,
    "JWT signature",
    1024,
  );
  return {
    header,
    payload,
    signature,
    signingInput: Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
  };
}

function expectedReusableWorkflowRef() {
  return `${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_REF}`;
}

function expectedAudience(bodySha256) {
  requireSha256(bodySha256, "bodySha256");
  return `pikiio-proof:${bodySha256}`;
}

function artifactReference(value) {
  return { address: `sha256:${value}`, sha256: value };
}

function reconstructAttestationBodyFromProofInputs(inputs) {
  canonicalJsonBytes(inputs, "collector proof inputs", 32 * 1024);
  requireExactKeys(inputs, PROOF_INPUT_KEYS, "collector proof inputs");
  if (inputs.schema !== COLLECTOR_PROOF_INPUT_SCHEMA) {
    fail("INVALID_PROOF_INPUT_SCHEMA", "collector proof input schema is invalid");
  }
  requireExactKeys(inputs.phase, PROOF_PHASE_KEYS, "collector proof phase");
  requireExactKeys(
    inputs.candidate,
    PROOF_CANDIDATE_KEYS,
    "collector proof candidate",
  );
  requireExactKeys(
    inputs.quality,
    PROOF_QUALITY_KEYS,
    "collector proof quality",
  );
  requireExactKeys(
    inputs.receiptHashes,
    PROOF_RECEIPT_KEYS,
    "collector proof receipt hashes",
  );
  const body = {
    phaseId: inputs.phase.phaseId,
    issuerRegistrySha256: inputs.phase.issuerRegistrySha256,
    ledgerRevision: inputs.phase.ledgerRevision,
    ledgerSha256: inputs.phase.ledgerSha256,
    candidateCommit: inputs.candidate.commit,
    candidateTree: inputs.candidate.tree,
    strictQualityReceiptHash: inputs.quality.strictReceiptHash,
    commandPlanHash: inputs.quality.commandPlanHash,
    primaryRawArtifactHash: inputs.quality.primaryRawArtifactHash,
    independentRawArtifactHash: inputs.quality.independentRawArtifactHash,
    receiptHashes: { ...inputs.receiptHashes },
    artifacts: {
      primaryRaw: artifactReference(inputs.quality.primaryRawArtifactHash),
      independentRaw: artifactReference(
        inputs.quality.independentRawArtifactHash,
      ),
      candidateReceipt: artifactReference(inputs.receiptHashes.candidate),
      rehearsalReceipt: artifactReference(inputs.receiptHashes.rehearsal),
      changeReceipt: artifactReference(inputs.receiptHashes.change),
      promotionReceipt: artifactReference(inputs.receiptHashes.promotion),
    },
  };
  return buildAttestationBody(body);
}

function validateRegistryKey(key, priorKid) {
  requireExactKeys(key, JWK_KEYS, "JWKS registry key");
  if (
    key.kty !== "RSA" ||
    key.alg !== "RS256" ||
    key.use !== "sig" ||
    typeof key.kid !== "string" ||
    !KID_PATTERN.test(key.kid)
  ) {
    fail("INVALID_JWK", "JWKS registry key metadata is invalid");
  }
  if (key.kid <= priorKid) {
    fail("NON_CANONICAL_JWKS", "JWKS registry keys must be uniquely sorted");
  }
  const modulus = decodeBase64url(key.n, "JWK modulus", 1024);
  const exponent = decodeBase64url(key.e, "JWK exponent", 8);
  if (
    modulus.length < 256 ||
    modulus.length > 512 ||
    modulus[0] === 0 ||
    exponent.toString("hex") !== "010001"
  ) {
    fail(
      "INVALID_JWK",
      "JWKS registry permits only 2048-4096 bit RSA keys with exponent 65537",
    );
  }
  if (key.x5t !== null) {
    const thumbprint = decodeBase64url(key.x5t, "JWK x5t", 20);
    if (thumbprint.length !== 20) {
      fail("INVALID_JWK", "JWK x5t must be a SHA-1 thumbprint");
    }
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: {
        kty: key.kty,
        n: key.n,
        e: key.e,
      },
      format: "jwk",
    });
  } catch (error) {
    fail("INVALID_JWK", "JWKS registry key cannot be imported", {
      cause: error.message,
    });
  }
  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "rsa" ||
    publicKey.asymmetricKeyDetails?.modulusLength < 2048 ||
    publicKey.asymmetricKeyDetails?.modulusLength > 4096
  ) {
    fail("INVALID_JWK", "JWKS registry key is not an approved RSA key");
  }
  return { publicKey, modulusBytes: modulus.length };
}

function validatePinnedJwksRegistry(
  registry,
  { expectedRegistrySha256 } = {},
) {
  canonicalJsonBytes(registry, "JWKS registry", MAX_REGISTRY_BYTES);
  requireExactKeys(registry, REGISTRY_KEYS, "JWKS registry");
  requireSha256(expectedRegistrySha256, "expectedRegistrySha256");
  if (
    registry.schema !== JWKS_REGISTRY_SCHEMA ||
    registry.revision !== 1 ||
    registry.issuer !== GITHUB_OIDC_ISSUER
  ) {
    fail("INVALID_JWKS_REGISTRY", "JWKS registry identity is invalid");
  }
  requireSha256(registry.registrySha256, "JWKS registry registrySha256");
  const computed = hashWithoutField(registry, "registrySha256");
  if (
    registry.registrySha256 !== computed ||
    registry.registrySha256 !== expectedRegistrySha256
  ) {
    fail(
      "JWKS_REGISTRY_HASH_MISMATCH",
      "JWKS registry is not the independently pinned registry",
    );
  }
  if (
    !Array.isArray(registry.keys) ||
    registry.keys.length < 1 ||
    registry.keys.length > 8
  ) {
    fail("INVALID_JWKS_REGISTRY", "JWKS registry must pin one to eight keys");
  }
  const keysById = new Map();
  let priorKid = "";
  for (const key of registry.keys) {
    const validated = validateRegistryKey(key, priorKid);
    priorKid = key.kid;
    keysById.set(key.kid, { ...validated, record: key });
  }
  return {
    registrySha256: computed,
    keysById,
  };
}

function requireDigitString(value, label) {
  if (typeof value !== "string" || !DIGIT_STRING_PATTERN.test(value)) {
    fail("INVALID_RUN_CLAIM", `${label} must be a canonical decimal string`);
  }
}

function requireEpoch(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_TIME_CLAIM", `${label} must be a positive epoch second`);
  }
}

function parseExactIso(value, label) {
  if (typeof value !== "string") {
    fail("INVALID_TIMESTAMP", `${label} must be an ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail("INVALID_TIMESTAMP", `${label} must be canonical UTC ISO-8601`);
  }
  return milliseconds;
}

function validateExpectedRun(expectedRun) {
  requireExactKeys(expectedRun, EXPECTED_RUN_KEYS, "expected run");
  requireBoundedString(expectedRun.eventName, "expected run eventName", {
    max: 64,
  });
  for (const field of ["runId", "runNumber", "runAttempt", "checkRunId"]) {
    requireDigitString(expectedRun[field], `expected run ${field}`);
  }
}

function validateJwtHeader(header, key) {
  const expectedKeys =
    key.x5t === null
      ? ["alg", "kid", "typ"]
      : ["alg", "kid", "typ", "x5t"];
  requireExactKeys(header, expectedKeys, "JWT header");
  if (
    header.alg !== "RS256" ||
    header.kid !== key.kid ||
    header.typ !== "JWT" ||
    (key.x5t !== null && header.x5t !== key.x5t)
  ) {
    fail("INVALID_JWT_HEADER", "JWT header does not match the pinned JWK");
  }
}

function validateStringClaims(payload) {
  for (const [field, maximum, allowEmpty] of [
    ["actor", 256, false],
    ["base_ref", 1024, true],
    ["head_ref", 1024, true],
    ["event_name", 64, false],
    ["ref", 1024, false],
    ["ref_type", 32, false],
    ["repository", 256, false],
    ["repository_owner", 256, false],
    ["repository_visibility", 32, false],
    ["runner_environment", 32, false],
    ["sub", 2048, false],
    ["workflow", 256, false],
    ["workflow_ref", 2048, false],
    ["job_workflow_ref", 2048, false],
  ]) {
    requireBoundedString(payload[field], `JWT ${field}`, {
      max: maximum,
      allowEmpty,
    });
  }
  for (const field of [
    "actor_id",
    "check_run_id",
    "repository_id",
    "repository_owner_id",
    "run_attempt",
    "run_id",
    "run_number",
  ]) {
    requireDigitString(payload[field], `JWT ${field}`);
  }
}

function validateGithubClaims(
  payload,
  {
    bodySha256,
    candidateCommit,
    scopeBaseCommit,
    expectedRun,
    requestedAt,
    receivedAt,
    nowMs,
  },
) {
  requireExactKeys(payload, JWT_CLAIM_KEYS, "JWT payload");
  validateExpectedRun(expectedRun);
  validateStringClaims(payload);
  requireEpoch(payload.iat, "JWT iat");
  requireEpoch(payload.nbf, "JWT nbf");
  requireEpoch(payload.exp, "JWT exp");
  requireBoundedString(payload.jti, "JWT jti", { max: 64 });
  if (!UUID_PATTERN.test(payload.jti)) {
    fail("INVALID_JTI", "JWT jti must be a canonical UUID");
  }
  requireCommit(payload.sha, "JWT sha");
  requireCommit(payload.workflow_sha, "JWT workflow_sha");
  requireCommit(payload.job_workflow_sha, "JWT job_workflow_sha");

  const audience = expectedAudience(bodySha256);
  const workflowRef = expectedReusableWorkflowRef();
  if (
    payload.iss !== GITHUB_OIDC_ISSUER ||
    payload.aud !== audience ||
    payload.repository !== EXPECTED_REPOSITORY ||
    payload.repository_owner !== EXPECTED_REPOSITORY_OWNER ||
    payload.repository_visibility !== EXPECTED_REPOSITORY_VISIBILITY ||
    payload.runner_environment !== EXPECTED_RUNNER_ENVIRONMENT ||
    payload.sha !== candidateCommit ||
    payload.workflow_sha !== candidateCommit ||
    payload.job_workflow_sha !== scopeBaseCommit ||
    payload.job_workflow_ref !== workflowRef
  ) {
    fail(
      "OIDC_IDENTITY_MISMATCH",
      "GitHub OIDC identity does not match the exact proof authority",
    );
  }
  if (
    payload.event_name !== expectedRun.eventName ||
    payload.run_id !== expectedRun.runId ||
    payload.run_number !== expectedRun.runNumber ||
    payload.run_attempt !== expectedRun.runAttempt ||
    payload.check_run_id !== expectedRun.checkRunId
  ) {
    fail("RUN_CONTEXT_MISMATCH", "GitHub run context is not the expected run");
  }
  if (
    !["branch", "tag"].includes(payload.ref_type) ||
    !["true", "false"].includes(payload.ref_protected)
  ) {
    fail("INVALID_REF_CONTEXT", "GitHub ref context is invalid");
  }
  const refPrefix =
    payload.ref_type === "branch" ? "refs/heads/" : "refs/tags/";
  if (!payload.ref.startsWith(refPrefix)) {
    fail("INVALID_REF_CONTEXT", "GitHub ref does not match its ref type");
  }
  const expectedSubject = `repo:${EXPECTED_REPOSITORY}:ref:${payload.ref.replaceAll(
    ":",
    "%3A",
  )}`;
  if (payload.sub !== expectedSubject) {
    fail("SUBJECT_MISMATCH", "GitHub OIDC subject is not the exact ref subject");
  }
  if (
    !payload.workflow_ref.startsWith(
      `${EXPECTED_REPOSITORY}/.github/workflows/`,
    ) ||
    !payload.workflow_ref.endsWith(`@${payload.ref}`) ||
    payload.workflow_ref.includes("\\") ||
    payload.workflow_ref.includes("/../")
  ) {
    fail("CALLER_WORKFLOW_MISMATCH", "caller workflow ref is not canonical");
  }

  if (
    payload.nbf > payload.iat ||
    payload.iat - payload.nbf > MAX_NOT_BEFORE_LEAD_SECONDS ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    fail("INVALID_TOKEN_WINDOW", "GitHub OIDC token lifetime is invalid");
  }
  const requestedMs = parseExactIso(requestedAt, "requestedAt");
  const receivedMs = parseExactIso(receivedAt, "receivedAt");
  if (
    requestedMs > receivedMs ||
    receivedMs - requestedMs > MAX_COLLECTION_SECONDS * 1000 ||
    requestedMs < (payload.nbf - CLOCK_SKEW_SECONDS) * 1000 ||
    receivedMs > (payload.exp + CLOCK_SKEW_SECONDS) * 1000 ||
    payload.iat * 1000 < requestedMs - CLOCK_SKEW_SECONDS * 1000 ||
    payload.iat * 1000 > receivedMs + CLOCK_SKEW_SECONDS * 1000 ||
    receivedMs > nowMs + CLOCK_SKEW_SECONDS * 1000
  ) {
    fail("COLLECTION_WINDOW_MISMATCH", "collector timestamps are inconsistent");
  }
}

function oidcProjection(payload) {
  return {
    issuer: payload.iss,
    eventName: payload.event_name,
    runId: payload.run_id,
    runNumber: payload.run_number,
    runAttempt: payload.run_attempt,
    checkRunId: payload.check_run_id,
    jti: payload.jti,
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    notBefore: new Date(payload.nbf * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

function buildGithubOidcCollectorReceipt({
  body,
  scopeBaseCommit,
  jwksRegistrySha256,
  oidcToken,
  requestedAt,
  receivedAt,
}) {
  const bodyReport = validateAttestationBody(body);
  requireCommit(scopeBaseCommit, "scopeBaseCommit");
  requireSha256(jwksRegistrySha256, "jwksRegistrySha256");
  parseExactIso(requestedAt, "requestedAt");
  parseExactIso(receivedAt, "receivedAt");
  const parsed = parseGithubOidcToken(oidcToken);
  const receipt = {
    schema: COLLECTOR_RECEIPT_SCHEMA,
    bodySha256: bodyReport.bodySha256,
    audience: expectedAudience(bodyReport.bodySha256),
    candidateCommit: body.candidateCommit,
    scopeBaseCommit,
    reusableWorkflowRef: expectedReusableWorkflowRef(),
    jwksRegistrySha256,
    requestedAt,
    receivedAt,
    oidc: oidcProjection(parsed.payload),
    oidcToken,
  };
  receipt.receiptHash = sha256(stableJson(receipt));
  canonicalJsonBytes(receipt, "collector receipt", MAX_RECEIPT_BYTES);
  return receipt;
}

function validateGithubOidcCollectorReceipt({
  receipt,
  expectedBody,
  scopeBaseCommit,
  jwksRegistry,
  expectedJwksRegistrySha256,
  expectedRun,
  nowMs = Date.now(),
}) {
  canonicalJsonBytes(receipt, "collector receipt", MAX_RECEIPT_BYTES);
  requireExactKeys(receipt, RECEIPT_KEYS, "collector receipt");
  if (receipt.schema !== COLLECTOR_RECEIPT_SCHEMA) {
    fail("INVALID_RECEIPT_SCHEMA", "collector receipt schema is invalid");
  }
  requireSha256(receipt.receiptHash, "receiptHash");
  if (hashWithoutField(receipt, "receiptHash") !== receipt.receiptHash) {
    fail("RECEIPT_HASH_MISMATCH", "collector receipt hash is invalid");
  }
  const bodyReport = validateAttestationBody(expectedBody);
  requireCommit(scopeBaseCommit, "scopeBaseCommit");
  const workflowRef = expectedReusableWorkflowRef();
  const audience = expectedAudience(bodyReport.bodySha256);
  if (
    receipt.bodySha256 !== bodyReport.bodySha256 ||
    receipt.audience !== audience ||
    receipt.candidateCommit !== expectedBody.candidateCommit ||
    receipt.scopeBaseCommit !== scopeBaseCommit ||
    receipt.reusableWorkflowRef !== workflowRef ||
    receipt.jwksRegistrySha256 !== expectedJwksRegistrySha256
  ) {
    fail("RECEIPT_BINDING_MISMATCH", "collector receipt proof binding is invalid");
  }
  const registry = validatePinnedJwksRegistry(jwksRegistry, {
    expectedRegistrySha256: expectedJwksRegistrySha256,
  });
  const parsed = parseGithubOidcToken(receipt.oidcToken);
  const pinned = registry.keysById.get(parsed.header.kid);
  if (!pinned) {
    fail("UNPINNED_SIGNING_KEY", "JWT kid is absent from the pinned registry");
  }
  validateJwtHeader(parsed.header, pinned.record);
  if (parsed.signature.length !== pinned.modulusBytes) {
    fail("INVALID_SIGNATURE", "JWT signature size does not match its RSA key");
  }
  const signatureValid = crypto.verify(
    "RSA-SHA256",
    parsed.signingInput,
    pinned.publicKey,
    parsed.signature,
  );
  if (!signatureValid) {
    fail("SIGNATURE_VERIFICATION_FAILED", "GitHub OIDC signature is invalid");
  }
  validateGithubClaims(parsed.payload, {
    bodySha256: bodyReport.bodySha256,
    candidateCommit: expectedBody.candidateCommit,
    scopeBaseCommit,
    expectedRun,
    requestedAt: receipt.requestedAt,
    receivedAt: receipt.receivedAt,
    nowMs,
  });
  requireExactKeys(receipt.oidc, OIDC_PROJECTION_KEYS, "collector OIDC projection");
  if (stableJson(receipt.oidc) !== stableJson(oidcProjection(parsed.payload))) {
    fail("OIDC_PROJECTION_MISMATCH", "collector OIDC projection is invalid");
  }
  return {
    valid: true,
    receiptHash: receipt.receiptHash,
    bodySha256: bodyReport.bodySha256,
    candidateCommit: expectedBody.candidateCommit,
    scopeBaseCommit,
    jti: parsed.payload.jti,
    replayKey: `${parsed.payload.iss}:${parsed.payload.jti}`,
    runId: parsed.payload.run_id,
    runAttempt: parsed.payload.run_attempt,
    collectedAt: receipt.receivedAt,
  };
}

module.exports = {
  CLOCK_SKEW_SECONDS,
  COLLECTOR_PROOF_INPUT_SCHEMA,
  COLLECTOR_RECEIPT_SCHEMA,
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_OWNER,
  EXPECTED_REPOSITORY_VISIBILITY,
  EXPECTED_RUNNER_ENVIRONMENT,
  GITHUB_OIDC_ISSUER,
  GithubOidcCollectorError,
  JWKS_REGISTRY_SCHEMA,
  MAX_COLLECTION_SECONDS,
  MAX_JWT_BYTES,
  MAX_NOT_BEFORE_LEAD_SECONDS,
  MAX_RECEIPT_BYTES,
  MAX_REGISTRY_BYTES,
  MAX_TOKEN_LIFETIME_SECONDS,
  REUSABLE_WORKFLOW_PATH,
  REUSABLE_WORKFLOW_REF,
  buildGithubOidcCollectorReceipt,
  expectedAudience,
  expectedReusableWorkflowRef,
  hashWithoutField,
  parseGithubOidcToken,
  reconstructAttestationBodyFromProofInputs,
  validateGithubOidcCollectorReceipt,
  validatePinnedJwksRegistry,
};

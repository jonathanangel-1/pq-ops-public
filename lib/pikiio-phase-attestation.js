"use strict";

const crypto = require("node:crypto");

const ISSUER_REGISTRY_SCHEMA =
  "pikiio-phase-attestation-issuer-registry-v1";
const ATTESTATION_BODY_SCHEMA = "pikiio-phase-attestation-body-v1";
const DUAL_ATTESTATION_SCHEMA = "pikiio-phase-dual-attestation-v1";
const SIGNATURE_ALGORITHM = "Ed25519";

const MAX_REGISTRY_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_ID_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]{2}$/;
const ISSUER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ROLES = Object.freeze(["controller", "collector"]);
const ARTIFACT_ROLES = Object.freeze([
  "primaryRaw",
  "independentRaw",
  "candidateReceipt",
  "rehearsalReceipt",
  "changeReceipt",
  "promotionReceipt",
]);
const RECEIPT_ROLES = Object.freeze([
  "candidate",
  "rehearsal",
  "change",
  "promotion",
]);

const REGISTRY_KEYS = Object.freeze(["schema", "revision", "issuers"]);
const ISSUER_KEYS = Object.freeze([
  "role",
  "issuerId",
  "keyAlgorithm",
  "publicKeySpkiBase64",
  "publicKeySha256",
  "identitySha256",
]);
const BODY_KEYS = Object.freeze([
  "schema",
  "phaseId",
  "issuerRegistrySha256",
  "ledgerRevision",
  "ledgerSha256",
  "candidateCommit",
  "candidateTree",
  "strictQualityReceiptHash",
  "commandPlanHash",
  "primaryRawArtifactHash",
  "independentRawArtifactHash",
  "receiptHashes",
  "artifacts",
]);
const ARTIFACT_KEYS = Object.freeze(["address", "sha256"]);
const ATTESTATION_KEYS = Object.freeze([
  "schema",
  "body",
  "bodySha256",
  "signatures",
]);
const SIGNATURE_KEYS = Object.freeze([
  "role",
  "issuerId",
  "algorithm",
  "signatureBase64",
]);

class PhaseAttestationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PhaseAttestationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PhaseAttestationError(code, message, details);
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
  try {
    const serialized = JSON.stringify(stableValue(value));
    if (typeof serialized !== "string") {
      fail("NON_CANONICAL_JSON", "value cannot be canonically serialized");
    }
    return serialized;
  } catch (error) {
    fail("NON_CANONICAL_JSON", "value cannot be canonically serialized", {
      cause: error.message,
    });
  }
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

function jsonByteLength(value, label, maximum) {
  const bytes = Buffer.byteLength(stableJson(value), "utf8");
  if (bytes > maximum) {
    fail("SIZE_LIMIT_EXCEEDED", `${label} exceeds its byte limit`, {
      bytes,
      maximum,
    });
  }
  return bytes;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_SHA256", `${label} must be a lowercase SHA-256 digest`);
  }
}

function requireGitObject(value, label) {
  if (typeof value !== "string" || !GIT_OBJECT_PATTERN.test(value)) {
    fail("INVALID_GIT_OBJECT", `${label} must be a lowercase Git object ID`);
  }
}

function decodeCanonicalBase64(value, label, maximumBytes) {
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
    bytes.toString("base64") !== value
  ) {
    fail("INVALID_BASE64", `${label} must be canonical base64`);
  }
  return bytes;
}

function publicKeyFromIssuer(issuer, label) {
  const der = decodeCanonicalBase64(
    issuer.publicKeySpkiBase64,
    `${label}.publicKeySpkiBase64`,
    128,
  );
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (error) {
    fail("INVALID_PUBLIC_KEY", `${label} public key is not valid SPKI DER`, {
      cause: error.message,
    });
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("INVALID_PUBLIC_KEY", `${label} must pin an Ed25519 public key`);
  }
  const exported = key.export({ format: "der", type: "spki" });
  if (
    exported.length !== der.length ||
    !crypto.timingSafeEqual(exported, der)
  ) {
    fail("NON_CANONICAL_PUBLIC_KEY", `${label} public key is not canonical`);
  }
  return { key, der };
}

function issuerIdentityValue(issuer) {
  return {
    role: issuer.role,
    issuerId: issuer.issuerId,
    keyAlgorithm: issuer.keyAlgorithm,
    publicKeySpkiBase64: issuer.publicKeySpkiBase64,
    publicKeySha256: issuer.publicKeySha256,
  };
}

function buildIssuerRecord({ role, issuerId, publicKey }) {
  if (!ROLES.includes(role)) {
    fail("INVALID_ROLE", "issuer role must be controller or collector");
  }
  if (typeof issuerId !== "string" || !ISSUER_ID_PATTERN.test(issuerId)) {
    fail("INVALID_ISSUER_ID", "issuerId is invalid");
  }
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
  const issuer = {
    role,
    issuerId,
    keyAlgorithm: SIGNATURE_ALGORITHM,
    publicKeySpkiBase64: der.toString("base64"),
    publicKeySha256: sha256(der),
  };
  issuer.identitySha256 = sha256(stableJson(issuerIdentityValue(issuer)));
  return issuer;
}

function validateIssuerRegistry(registry) {
  jsonByteLength(registry, "issuer registry", MAX_REGISTRY_BYTES);
  requireExactKeys(registry, REGISTRY_KEYS, "issuer registry");
  if (registry.schema !== ISSUER_REGISTRY_SCHEMA || registry.revision !== 1) {
    fail("INVALID_REGISTRY", "issuer registry schema or revision is invalid");
  }
  requireExactKeys(registry.issuers, ROLES, "issuer registry issuers");

  const observed = {};
  for (const role of ROLES) {
    const issuer = registry.issuers[role];
    const label = `issuer registry issuers.${role}`;
    requireExactKeys(issuer, ISSUER_KEYS, label);
    if (issuer.role !== role) {
      fail("ROLE_MISMATCH", `${label}.role does not match its registry slot`);
    }
    if (
      typeof issuer.issuerId !== "string" ||
      !ISSUER_ID_PATTERN.test(issuer.issuerId)
    ) {
      fail("INVALID_ISSUER_ID", `${label}.issuerId is invalid`);
    }
    if (issuer.keyAlgorithm !== SIGNATURE_ALGORITHM) {
      fail("INVALID_ALGORITHM", `${label} must use Ed25519`);
    }
    const { key, der } = publicKeyFromIssuer(issuer, label);
    requireSha256(issuer.publicKeySha256, `${label}.publicKeySha256`);
    if (issuer.publicKeySha256 !== sha256(der)) {
      fail("PUBLIC_KEY_HASH_MISMATCH", `${label} public key hash is invalid`);
    }
    requireSha256(issuer.identitySha256, `${label}.identitySha256`);
    const expectedIdentitySha256 = sha256(
      stableJson(issuerIdentityValue(issuer)),
    );
    if (issuer.identitySha256 !== expectedIdentitySha256) {
      fail("IDENTITY_HASH_MISMATCH", `${label} identity hash is invalid`);
    }
    observed[role] = { issuer, key, der };
  }

  if (
    observed.controller.issuer.issuerId ===
      observed.collector.issuer.issuerId ||
    observed.controller.issuer.publicKeySha256 ===
      observed.collector.issuer.publicKeySha256 ||
    observed.controller.issuer.identitySha256 ===
      observed.collector.issuer.identitySha256
  ) {
    fail(
      "ISSUER_IDENTITY_COLLISION",
      "controller and collector identities and public keys must be distinct",
    );
  }

  return {
    schema: ISSUER_REGISTRY_SCHEMA,
    revision: 1,
    registrySha256: sha256(stableJson(registry)),
    controllerIssuerId: observed.controller.issuer.issuerId,
    collectorIssuerId: observed.collector.issuer.issuerId,
  };
}

function validateArtifactReference(reference, label) {
  requireExactKeys(reference, ARTIFACT_KEYS, label);
  requireSha256(reference.sha256, `${label}.sha256`);
  if (reference.address !== `sha256:${reference.sha256}`) {
    fail(
      "ARTIFACT_ADDRESS_MISMATCH",
      `${label}.address must be the content address for its hash`,
    );
  }
}

function validateAttestationBody(body) {
  jsonByteLength(body, "attestation body", MAX_BODY_BYTES);
  requireExactKeys(body, BODY_KEYS, "attestation body");
  if (body.schema !== ATTESTATION_BODY_SCHEMA) {
    fail("INVALID_BODY_SCHEMA", "attestation body schema is invalid");
  }
  if (
    typeof body.phaseId !== "string" ||
    !PHASE_ID_PATTERN.test(body.phaseId)
  ) {
    fail("INVALID_PHASE_ID", "attestation body phaseId is invalid");
  }
  requireSha256(
    body.issuerRegistrySha256,
    "attestation body issuerRegistrySha256",
  );
  if (
    !Number.isSafeInteger(body.ledgerRevision) ||
    body.ledgerRevision < 1
  ) {
    fail(
      "INVALID_LEDGER_REVISION",
      "attestation body ledgerRevision must be a positive safe integer",
    );
  }
  requireSha256(body.ledgerSha256, "attestation body ledgerSha256");
  requireGitObject(body.candidateCommit, "attestation body candidateCommit");
  requireGitObject(body.candidateTree, "attestation body candidateTree");
  requireSha256(
    body.strictQualityReceiptHash,
    "attestation body strictQualityReceiptHash",
  );
  requireSha256(body.commandPlanHash, "attestation body commandPlanHash");
  requireSha256(
    body.primaryRawArtifactHash,
    "attestation body primaryRawArtifactHash",
  );
  requireSha256(
    body.independentRawArtifactHash,
    "attestation body independentRawArtifactHash",
  );
  if (body.primaryRawArtifactHash === body.independentRawArtifactHash) {
    fail(
      "JUDGE_ARTIFACT_COLLISION",
      "primary and independent raw artifact hashes must be distinct",
    );
  }

  requireExactKeys(body.receiptHashes, RECEIPT_ROLES, "receiptHashes");
  for (const role of RECEIPT_ROLES) {
    requireSha256(body.receiptHashes[role], `receiptHashes.${role}`);
  }
  if (new Set(Object.values(body.receiptHashes)).size !== RECEIPT_ROLES.length) {
    fail("RECEIPT_HASH_COLLISION", "all four receipt hashes must be distinct");
  }

  requireExactKeys(body.artifacts, ARTIFACT_ROLES, "artifacts");
  for (const role of ARTIFACT_ROLES) {
    validateArtifactReference(body.artifacts[role], `artifacts.${role}`);
  }
  if (
    new Set(
      ARTIFACT_ROLES.map((role) => body.artifacts[role].address),
    ).size !== ARTIFACT_ROLES.length
  ) {
    fail("ARTIFACT_COLLISION", "artifact addresses must be distinct");
  }

  const expectedHashes = {
    primaryRaw: body.primaryRawArtifactHash,
    independentRaw: body.independentRawArtifactHash,
    candidateReceipt: body.receiptHashes.candidate,
    rehearsalReceipt: body.receiptHashes.rehearsal,
    changeReceipt: body.receiptHashes.change,
    promotionReceipt: body.receiptHashes.promotion,
  };
  for (const role of ARTIFACT_ROLES) {
    if (body.artifacts[role].sha256 !== expectedHashes[role]) {
      fail(
        "ARTIFACT_HASH_MISMATCH",
        `artifacts.${role} does not match its bound proof hash`,
      );
    }
  }

  return {
    bodySha256: sha256(stableJson(body)),
    bodyBytes: Buffer.byteLength(stableJson(body), "utf8"),
  };
}

function buildAttestationBody(fields) {
  const body = { ...fields, schema: ATTESTATION_BODY_SCHEMA };
  validateAttestationBody(body);
  return JSON.parse(stableJson(body));
}

function privateKeyForSigning(privateKey) {
  if (!(privateKey instanceof crypto.KeyObject)) {
    fail("INVALID_PRIVATE_KEY", "privateKey must be a Node.js KeyObject");
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    fail("INVALID_PRIVATE_KEY", "privateKey must be an Ed25519 private key");
  }
  return privateKey;
}

function issuerForRole(registry, role, issuerId) {
  validateIssuerRegistry(registry);
  if (!ROLES.includes(role)) {
    fail("INVALID_ROLE", "signature role must be controller or collector");
  }
  const issuer = registry.issuers[role];
  if (issuer.issuerId !== issuerId) {
    fail("ISSUER_MISMATCH", "signature issuer does not match the pinned role");
  }
  return issuer;
}

function signAttestationBody({
  body,
  registry,
  role,
  issuerId,
  privateKey,
}) {
  validateAttestationBody(body);
  const registryReport = validateIssuerRegistry(registry);
  if (body.issuerRegistrySha256 !== registryReport.registrySha256) {
    fail(
      "ISSUER_REGISTRY_HASH_MISMATCH",
      "attestation body does not bind the supplied issuer registry",
    );
  }
  const issuer = issuerForRole(registry, role, issuerId);
  const signingKey = privateKeyForSigning(privateKey);
  const derivedDer = crypto
    .createPublicKey(signingKey)
    .export({ format: "der", type: "spki" });
  const pinnedDer = Buffer.from(issuer.publicKeySpkiBase64, "base64");
  if (
    derivedDer.length !== pinnedDer.length ||
    !crypto.timingSafeEqual(derivedDer, pinnedDer)
  ) {
    fail(
      "SIGNING_KEY_MISMATCH",
      "private key does not match the pinned issuer public key",
    );
  }
  const signature = crypto.sign(null, Buffer.from(stableJson(body)), signingKey);
  return {
    role,
    issuerId,
    algorithm: SIGNATURE_ALGORITHM,
    signatureBase64: signature.toString("base64"),
  };
}

function assembleDualAttestation({
  body,
  controllerSignature,
  collectorSignature,
}) {
  const bodyReport = validateAttestationBody(body);
  const attestation = {
    schema: DUAL_ATTESTATION_SCHEMA,
    body: JSON.parse(stableJson(body)),
    bodySha256: bodyReport.bodySha256,
    signatures: {
      controller: { ...controllerSignature },
      collector: { ...collectorSignature },
    },
  };
  jsonByteLength(attestation, "dual attestation", MAX_ATTESTATION_BYTES);
  return attestation;
}

function validateSignatureRecord(record, role, issuer, bodyBytes) {
  requireExactKeys(record, SIGNATURE_KEYS, `signatures.${role}`);
  if (record.role !== role) {
    fail("ROLE_MISMATCH", `signatures.${role}.role is invalid`);
  }
  if (record.issuerId !== issuer.issuerId) {
    fail("ISSUER_MISMATCH", `signatures.${role}.issuerId is invalid`);
  }
  if (record.algorithm !== SIGNATURE_ALGORITHM) {
    fail("INVALID_ALGORITHM", `signatures.${role}.algorithm must be Ed25519`);
  }
  const signature = decodeCanonicalBase64(
    record.signatureBase64,
    `signatures.${role}.signatureBase64`,
    64,
  );
  if (signature.length !== 64) {
    fail("INVALID_SIGNATURE", `signatures.${role} must be a 64-byte signature`);
  }
  const { key } = publicKeyFromIssuer(issuer, `issuers.${role}`);
  if (!crypto.verify(null, bodyBytes, key, signature)) {
    fail("SIGNATURE_VERIFICATION_FAILED", `${role} signature is invalid`);
  }
}

function validateDualSignatures({ registry, attestation }) {
  const registryReport = validateIssuerRegistry(registry);
  jsonByteLength(attestation, "dual attestation", MAX_ATTESTATION_BYTES);
  requireExactKeys(attestation, ATTESTATION_KEYS, "dual attestation");
  if (attestation.schema !== DUAL_ATTESTATION_SCHEMA) {
    fail("INVALID_ATTESTATION_SCHEMA", "dual attestation schema is invalid");
  }
  const bodyReport = validateAttestationBody(attestation.body);
  if (attestation.body.issuerRegistrySha256 !== registryReport.registrySha256) {
    fail(
      "ISSUER_REGISTRY_HASH_MISMATCH",
      "attestation body does not bind the supplied issuer registry",
    );
  }
  requireSha256(attestation.bodySha256, "dual attestation bodySha256");
  if (attestation.bodySha256 !== bodyReport.bodySha256) {
    fail("BODY_HASH_MISMATCH", "dual attestation body hash is invalid");
  }
  requireExactKeys(attestation.signatures, ROLES, "dual attestation signatures");
  const bodyBytes = Buffer.from(stableJson(attestation.body), "utf8");
  for (const role of ROLES) {
    validateSignatureRecord(
      attestation.signatures[role],
      role,
      registry.issuers[role],
      bodyBytes,
    );
  }
  if (
    attestation.signatures.controller.issuerId ===
    attestation.signatures.collector.issuerId
  ) {
    fail("ISSUER_IDENTITY_COLLISION", "dual signatures must use distinct issuers");
  }
  return {
    valid: true,
    bodySha256: bodyReport.bodySha256,
    registrySha256: registryReport.registrySha256,
    phaseId: attestation.body.phaseId,
    ledgerRevision: attestation.body.ledgerRevision,
    candidateCommit: attestation.body.candidateCommit,
  };
}

function validateDualAttestation({ registry, attestation, expectedBody }) {
  if (expectedBody === undefined) {
    fail(
      "EXPECTED_BODY_REQUIRED",
      "expectedBody is required for contextual attestation validation",
    );
  }
  validateAttestationBody(expectedBody);
  const result = validateDualSignatures({ registry, attestation });
  if (stableJson(attestation.body) !== stableJson(expectedBody)) {
    fail(
      "ATTESTED_BODY_MISMATCH",
      "signed attestation body does not match the expected proof bundle",
    );
  }
  return result;
}

module.exports = {
  ARTIFACT_ROLES,
  ATTESTATION_BODY_SCHEMA,
  DUAL_ATTESTATION_SCHEMA,
  ISSUER_REGISTRY_SCHEMA,
  MAX_ATTESTATION_BYTES,
  MAX_BODY_BYTES,
  MAX_REGISTRY_BYTES,
  PhaseAttestationError,
  ROLES,
  SIGNATURE_ALGORITHM,
  assembleDualAttestation,
  buildAttestationBody,
  buildIssuerRecord,
  sha256,
  signAttestationBody,
  stableJson,
  validateAttestationBody,
  validateDualAttestation,
  validateDualSignatures,
  validateIssuerRegistry,
};

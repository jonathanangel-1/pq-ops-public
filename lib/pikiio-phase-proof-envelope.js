"use strict";

const crypto = require("node:crypto");

const {
  ATTESTATION_BODY_SCHEMA,
  sha256,
  stableJson,
  validateAttestationBody,
} = require("./pikiio-phase-attestation");
const {
  COLLECTOR_PROOF_INPUT_SCHEMA,
  COLLECTOR_RECEIPT_SCHEMA,
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_VISIBILITY,
  EXPECTED_RUNNER_ENVIRONMENT,
  GITHUB_OIDC_ISSUER,
  REUSABLE_WORKFLOW_PATH,
  REUSABLE_WORKFLOW_REF,
  expectedReusableWorkflowRef,
  reconstructAttestationBodyFromProofInputs,
  validateGithubOidcCollectorReceipt,
  validatePinnedJwksRegistry,
} = require("./pikiio-github-oidc-collector");

const PHASE_PROOF_ENVELOPE_SCHEMA = "pikiio-phase-proof-envelope-v2";
const CORE_PHASE_PROOF_SCHEMA = "pikiio-phase-proof-bundle-v1";
const FROZEN_CERTIFICATION_SCHEMA =
  "pikiio-frozen-authority-verification-receipt-v1";
const ATTESTATION_AUTHORITY_SCHEMA =
  "pikiio-phase-attestation-authority-registry-v1";
const GITHUB_RUN_SCHEMA = "pikiio-github-run-context-v1";
const COLLECTOR_EVIDENCE_SCHEMA =
  "pikiio-embedded-github-oidc-collector-receipt-v1";
const REPLAY_PROTECTION_SCHEMA =
  "pikiio-frozen-authority-replay-protection-v1";

const MAX_ENVELOPE_BYTES = 66 * 1024 * 1024;
const MAX_CORE_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_CERTIFICATION_BYTES = 256 * 1024;
const MAX_COLLECTOR_RECEIPT_BYTES = 64 * 1024;
const MAX_ARTIFACT_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_ENCODED_BYTES = 48 * 1024 * 1024;
const MAX_ARTIFACT_COUNT = 512;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_ID_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]{2}$/;
const DIGIT_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ENVELOPE_KEYS = Object.freeze([
  "schema",
  "proofBundle",
  "externalCertification",
  "envelopeHash",
]);
const CORE_BUNDLE_KEYS = Object.freeze([
  "schema",
  "phaseId",
  "ledgerRevision",
  "candidateCommit",
  "qualityReceiptHash",
  "chain",
  "artifacts",
  "bundleHash",
]);
const CHAIN_KEYS = Object.freeze([
  "candidate",
  "rehearsal",
  "change",
  "promotion",
]);
const ARTIFACT_KEYS = Object.freeze([
  "address",
  "bytes",
  "encoding",
  "sha256",
]);
const CERTIFICATION_KEYS = Object.freeze([
  "schema",
  "phaseId",
  "scopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "ledgerRevision",
  "ledgerSha256",
  "phaseProofRegistrySha256",
  "attestationAuthoritySha256",
  "jwksRegistrySha256",
  "baselineAuthoritySnapshotHash",
  "candidateAuthoritySnapshotHash",
  "authoritySetSha256",
  "strictQualityReceiptHash",
  "phaseProofBundleHash",
  "receiptHashes",
  "attestationBody",
  "attestationBodySha256",
  "githubRun",
  "collectorEvidence",
  "replayProtection",
  "verifiedAt",
  "certificationHash",
]);
const RECEIPT_HASH_KEYS = Object.freeze([
  "candidate",
  "rehearsal",
  "change",
  "promotion",
]);
const GITHUB_RUN_KEYS = Object.freeze([
  "schema",
  "eventName",
  "runId",
  "runNumber",
  "runAttempt",
  "checkRunId",
  "repository",
  "runnerEnvironment",
  "githubSha",
]);
const COLLECTOR_EVIDENCE_KEYS = Object.freeze([
  "schema",
  "encoding",
  "byteLength",
  "rawSha256",
  "bytes",
  "receiptHash",
]);
const REPLAY_PROTECTION_KEYS = Object.freeze([
  "schema",
  "replayKey",
  "replayKeySha256",
  "consumptionScope",
  "multiHostSafe",
]);
const EXPECTED_CONTEXT_KEYS = Object.freeze([
  "phaseId",
  "scopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "ledgerRevision",
  "ledgerSha256",
  "phaseProofRegistrySha256",
  "strictQualityReceiptHash",
  "coreBundleHash",
]);
const AUTHORITY_KEYS = Object.freeze([
  "schema",
  "revision",
  "mode",
  "bodySchema",
  "controller",
  "collector",
  "authoritySha256",
]);
const AUTHORITY_CONTROLLER_KEYS = Object.freeze([
  "kind",
  "cryptographicSignature",
  "localCollectorPrivateKeyAllowed",
]);
const AUTHORITY_COLLECTOR_KEYS = Object.freeze([
  "kind",
  "issuer",
  "repository",
  "repositoryVisibility",
  "runnerEnvironment",
  "workflowPath",
  "workflowRef",
  "jwksRegistryPath",
  "jwksRegistrySha256",
]);

class PhaseProofEnvelopeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PhaseProofEnvelopeError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PhaseProofEnvelopeError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, label) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  ) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`);
  }
}

function canonicalJson(value, label, maximumBytes) {
  let json;
  try {
    json = stableJson(value);
  } catch (error) {
    fail("NON_CANONICAL_JSON", `${label} is not canonical JSON`, {
      cause: error.code || error.message,
    });
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maximumBytes) {
    fail("SIZE_LIMIT_EXCEEDED", `${label} exceeds its byte limit`, {
      bytes,
      maximumBytes,
    });
  }
  return json;
}

function hashWithoutField(value, field, label, maximumBytes) {
  const copy = { ...value };
  delete copy[field];
  return sha256(canonicalJson(copy, label, maximumBytes));
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

function requirePhaseId(value, label) {
  if (typeof value !== "string" || !PHASE_ID_PATTERN.test(value)) {
    fail("INVALID_PHASE_ID", `${label} must be a canonical phase ID`);
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

function validateExpectedContext(expected) {
  requireExactKeys(expected, EXPECTED_CONTEXT_KEYS, "expected proof context");
  requirePhaseId(expected.phaseId, "expected phaseId");
  requireCommit(expected.scopeBaseCommit, "expected scopeBaseCommit");
  requireCommit(expected.candidateCommit, "expected candidateCommit");
  requireCommit(expected.candidateTree, "expected candidateTree");
  if (
    !Number.isSafeInteger(expected.ledgerRevision) ||
    expected.ledgerRevision < 1
  ) {
    fail(
      "INVALID_LEDGER_REVISION",
      "expected ledgerRevision must be a positive safe integer",
    );
  }
  for (const field of [
    "ledgerSha256",
    "phaseProofRegistrySha256",
    "strictQualityReceiptHash",
    "coreBundleHash",
  ]) {
    requireSha256(expected[field], `expected ${field}`);
  }
}

function validateAuthorityRegistry({
  authorityRegistry,
  expectedAuthoritySha256,
  expectedJwksRegistrySha256,
}) {
  canonicalJson(
    authorityRegistry,
    "attestation authority registry",
    MAX_CERTIFICATION_BYTES,
  );
  requireExactKeys(
    authorityRegistry,
    AUTHORITY_KEYS,
    "attestation authority registry",
  );
  requireExactKeys(
    authorityRegistry.controller,
    AUTHORITY_CONTROLLER_KEYS,
    "attestation authority controller",
  );
  requireExactKeys(
    authorityRegistry.collector,
    AUTHORITY_COLLECTOR_KEYS,
    "attestation authority collector",
  );
  requireSha256(expectedAuthoritySha256, "expectedAuthoritySha256");
  requireSha256(
    expectedJwksRegistrySha256,
    "expectedJwksRegistrySha256",
  );
  requireSha256(
    authorityRegistry.authoritySha256,
    "attestation authority authoritySha256",
  );
  requireSha256(
    authorityRegistry.collector.jwksRegistrySha256,
    "attestation authority collector jwksRegistrySha256",
  );
  const computed = hashWithoutField(
    authorityRegistry,
    "authoritySha256",
    "attestation authority registry",
    MAX_CERTIFICATION_BYTES,
  );
  const expectedWorkflowRef = expectedReusableWorkflowRef();
  if (
    authorityRegistry.schema !== ATTESTATION_AUTHORITY_SCHEMA ||
    authorityRegistry.revision !== 1 ||
    authorityRegistry.mode !== "external_collector_required" ||
    authorityRegistry.bodySchema !== ATTESTATION_BODY_SCHEMA ||
    authorityRegistry.controller.kind !==
      "local_content_addressed_evidence" ||
    authorityRegistry.controller.cryptographicSignature !==
      "optional_non_authorizing" ||
    authorityRegistry.controller.localCollectorPrivateKeyAllowed !== false ||
    authorityRegistry.collector.kind !== "github_actions_oidc" ||
    authorityRegistry.collector.issuer !== GITHUB_OIDC_ISSUER ||
    authorityRegistry.collector.repository !== EXPECTED_REPOSITORY ||
    authorityRegistry.collector.repositoryVisibility !==
      EXPECTED_REPOSITORY_VISIBILITY ||
    authorityRegistry.collector.runnerEnvironment !==
      EXPECTED_RUNNER_ENVIRONMENT ||
    authorityRegistry.collector.workflowPath !== REUSABLE_WORKFLOW_PATH ||
    authorityRegistry.collector.workflowRef !== REUSABLE_WORKFLOW_REF ||
    expectedWorkflowRef !==
      `${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_REF}` ||
    authorityRegistry.collector.jwksRegistryPath !==
      "YLYI/00_Product_Contract/Pikiio_GitHub_OIDC_JWKS.json" ||
    authorityRegistry.collector.jwksRegistrySha256 !==
      expectedJwksRegistrySha256 ||
    authorityRegistry.authoritySha256 !== computed ||
    authorityRegistry.authoritySha256 !== expectedAuthoritySha256
  ) {
    fail(
      "ATTESTATION_AUTHORITY_MISMATCH",
      "attestation authority does not match the pinned external-only authority",
    );
  }
  return computed;
}

function decodeCanonicalBase64(value, label, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    fail("INVALID_BASE64", `${label} must be nonempty canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > maximumBytes ||
    bytes.toString("base64") !== value
  ) {
    fail("INVALID_BASE64", `${label} must be nonempty canonical base64`);
  }
  return bytes;
}

function parseJsonBytes(bytes, label) {
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
    fail("INVALID_JSON_OBJECT", `${label} must contain one JSON object`);
  }
  return value;
}

function validateArtifactSet(bundle) {
  if (
    !Array.isArray(bundle.artifacts) ||
    bundle.artifacts.length < 1 ||
    bundle.artifacts.length > MAX_ARTIFACT_COUNT
  ) {
    fail(
      "CORE_ARTIFACT_SET_INVALID",
      "core proof artifacts must be a bounded nonempty array",
    );
  }
  const artifacts = new Map();
  let priorAddress = "";
  let decodedBytes = 0;
  let encodedBytes = 0;
  for (const [index, artifact] of bundle.artifacts.entries()) {
    const label = `core proof artifact ${index + 1}`;
    requireExactKeys(artifact, ARTIFACT_KEYS, label);
    requireSha256(artifact.sha256, `${label}.sha256`);
    if (
      artifact.encoding !== "base64" ||
      artifact.address !== `sha256:${artifact.sha256}` ||
      artifact.address <= priorAddress
    ) {
      fail(
        "CORE_ARTIFACT_INVALID",
        `${label} has invalid identity, encoding, or ordering`,
      );
    }
    const bytes = decodeCanonicalBase64(
      artifact.bytes,
      `${label}.bytes`,
      MAX_ARTIFACT_DECODED_BYTES,
    );
    if (sha256(bytes) !== artifact.sha256 || artifacts.has(artifact.address)) {
      fail(
        "CORE_ARTIFACT_HASH_MISMATCH",
        `${label} is duplicated or hash-mismatched`,
      );
    }
    priorAddress = artifact.address;
    decodedBytes += bytes.length;
    encodedBytes += Buffer.byteLength(artifact.bytes, "utf8");
    if (
      decodedBytes > MAX_ARTIFACT_DECODED_BYTES ||
      encodedBytes > MAX_ARTIFACT_ENCODED_BYTES
    ) {
      fail(
        "CORE_ARTIFACT_SET_OVERSIZED",
        "core proof artifact bytes exceed their aggregate bound",
      );
    }
    artifacts.set(artifact.address, bytes);
  }
  return artifacts;
}

function receiptArtifactAddress(receipt, role) {
  requireSha256(receipt.receiptHash, `core proof ${role} receiptHash`);
  if (
    hashWithoutField(
      receipt,
      "receiptHash",
      `core proof ${role} receipt`,
      MAX_CORE_BUNDLE_BYTES,
    ) !== receipt.receiptHash
  ) {
    fail(
      "CORE_RECEIPT_HASH_MISMATCH",
      `core proof ${role} receipt hash is invalid`,
    );
  }
  return `sha256:${receipt.receiptHash}`;
}

function collectNestedRawArtifactAddresses(bundle, attestationBody) {
  const addresses = new Set();
  const add = (value, label) => {
    if (value === null || value === undefined) return;
    if (
      !isPlainObject(value) ||
      typeof value.address !== "string" ||
      typeof value.sha256 !== "string" ||
      value.address !== `sha256:${value.sha256}` ||
      !SHA256_PATTERN.test(value.sha256)
    ) {
      fail("RAW_ARTIFACT_REFERENCE_INVALID", `${label} is invalid`);
    }
    addresses.add(value.address);
  };
  for (const role of CHAIN_KEYS) {
    add(bundle.chain[role].rawArtifact, `${role}.rawArtifact`);
  }
  for (const [field, evidence] of [
    ["naturalEvidence", bundle.chain.promotion.naturalEvidence],
    ["browserEvidence", bundle.chain.promotion.browserEvidence],
  ]) {
    if (evidence === undefined) continue;
    if (!Array.isArray(evidence)) {
      fail(
        "CORE_CHAIN_INVALID",
        `promotion.${field} must be an array when present`,
      );
    }
    for (const [index, receipt] of evidence.entries()) {
      if (!isPlainObject(receipt)) {
        fail(
          "CORE_CHAIN_INVALID",
          `promotion.${field}[${index}] must be an object`,
        );
      }
      add(
        receipt.rawArtifact,
        `promotion.${field}[${index}].rawArtifact`,
      );
    }
  }
  add(attestationBody.artifacts.primaryRaw, "attestation primaryRaw");
  add(attestationBody.artifacts.independentRaw, "attestation independentRaw");
  return addresses;
}

function validateCoreBundleShape(bundle) {
  canonicalJson(bundle, "core phase proof bundle", MAX_CORE_BUNDLE_BYTES);
  requireExactKeys(bundle, CORE_BUNDLE_KEYS, "core phase proof bundle");
  requireExactKeys(bundle.chain, CHAIN_KEYS, "core phase proof chain");
  for (const role of CHAIN_KEYS) {
    if (!isPlainObject(bundle.chain[role])) {
      fail(
        "CORE_CHAIN_INVALID",
        `core proof ${role} receipt must be an object`,
      );
    }
  }
}

function validateCoreBundle(bundle, expected, attestationBody) {
  validateCoreBundleShape(bundle);
  if (bundle.schema !== CORE_PHASE_PROOF_SCHEMA) {
    fail("CORE_BUNDLE_SCHEMA_INVALID", "core phase proof schema is invalid");
  }
  requireSha256(bundle.bundleHash, "core phase proof bundleHash");
  if (
    hashWithoutField(
      bundle,
      "bundleHash",
      "core phase proof bundle",
      MAX_CORE_BUNDLE_BYTES,
    ) !== bundle.bundleHash
  ) {
    fail(
      "CORE_BUNDLE_HASH_MISMATCH",
      "core phase proof bundle hash is invalid",
    );
  }
  requireExactKeys(bundle.chain, CHAIN_KEYS, "core phase proof chain");
  requirePhaseId(bundle.phaseId, "core phase proof phaseId");
  requireCommit(bundle.candidateCommit, "core phase proof candidateCommit");
  requireSha256(
    bundle.qualityReceiptHash,
    "core phase proof qualityReceiptHash",
  );
  if (
    !Number.isSafeInteger(bundle.ledgerRevision) ||
    bundle.ledgerRevision < 1
  ) {
    fail(
      "INVALID_LEDGER_REVISION",
      "core phase proof ledgerRevision must be a positive safe integer",
    );
  }
  if (
    bundle.phaseId !== expected.phaseId ||
    bundle.candidateCommit !== expected.candidateCommit ||
    bundle.ledgerRevision !== expected.ledgerRevision ||
    bundle.qualityReceiptHash !== expected.strictQualityReceiptHash ||
    bundle.bundleHash !== expected.coreBundleHash
  ) {
    fail(
      "CORE_BUNDLE_CONTEXT_MISMATCH",
      "core phase proof does not match the expected immutable context",
    );
  }

  const artifacts = validateArtifactSet(bundle);
  for (const role of ["primaryRaw", "independentRaw"]) {
    const reference = attestationBody.artifacts[role];
    if (!artifacts.has(reference.address)) {
      fail(
        "SIGNED_RAW_ARTIFACT_MISSING",
        `signed ${role} bytes are absent from the core proof`,
      );
    }
  }
  const expectedAddresses = collectNestedRawArtifactAddresses(
    bundle,
    attestationBody,
  );
  for (const role of CHAIN_KEYS) {
    const receipt = bundle.chain[role];
    const address = receiptArtifactAddress(receipt, role);
    expectedAddresses.add(address);
    const unsigned = { ...receipt };
    delete unsigned.receiptHash;
    const expectedBytes = Buffer.from(
      canonicalJson(
        unsigned,
        `core proof ${role} receipt body`,
        MAX_CORE_BUNDLE_BYTES,
      ),
      "utf8",
    );
    const actualBytes = artifacts.get(address);
    if (
      !Buffer.isBuffer(actualBytes) ||
      actualBytes.length !== expectedBytes.length ||
      !crypto.timingSafeEqual(actualBytes, expectedBytes)
    ) {
      fail(
        "CORE_RECEIPT_ARTIFACT_MISMATCH",
        `core proof ${role} receipt raw bytes are missing or invalid`,
      );
    }
  }
  const actualAddresses = [...artifacts.keys()].sort();
  const requiredAddresses = [...expectedAddresses].sort();
  if (
    actualAddresses.length !== requiredAddresses.length ||
    actualAddresses.some(
      (address, index) => address !== requiredAddresses[index],
    )
  ) {
    fail(
      "CORE_ARTIFACT_SET_MISMATCH",
      "core proof artifacts do not exactly match signed proof references",
    );
  }
  return artifacts;
}

function validateGithubRun(run, expectedCandidateCommit) {
  requireExactKeys(run, GITHUB_RUN_KEYS, "certified GitHub run");
  requireCommit(run.githubSha, "certified GitHub run githubSha");
  if (
    run.schema !== GITHUB_RUN_SCHEMA ||
    run.repository !== EXPECTED_REPOSITORY ||
    run.runnerEnvironment !== EXPECTED_RUNNER_ENVIRONMENT ||
    run.githubSha !== expectedCandidateCommit ||
    typeof run.eventName !== "string" ||
    !/^[A-Za-z0-9_]{1,64}$/.test(run.eventName) ||
    [run.runId, run.runNumber, run.runAttempt, run.checkRunId].some(
      (value) => typeof value !== "string" || !DIGIT_PATTERN.test(value),
    )
  ) {
    fail(
      "GITHUB_RUN_CONTEXT_INVALID",
      "certified GitHub run context is invalid",
    );
  }
  return {
    eventName: run.eventName,
    runId: run.runId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
    checkRunId: run.checkRunId,
  };
}

function decodeCollectorEvidence(evidence) {
  requireExactKeys(
    evidence,
    COLLECTOR_EVIDENCE_KEYS,
    "embedded collector evidence",
  );
  requireSha256(evidence.rawSha256, "embedded collector rawSha256");
  requireSha256(evidence.receiptHash, "embedded collector receiptHash");
  if (
    evidence.schema !== COLLECTOR_EVIDENCE_SCHEMA ||
    evidence.encoding !== "base64" ||
    !Number.isSafeInteger(evidence.byteLength) ||
    evidence.byteLength < 1 ||
    evidence.byteLength > MAX_COLLECTOR_RECEIPT_BYTES
  ) {
    fail(
      "COLLECTOR_EVIDENCE_INVALID",
      "embedded collector evidence metadata is invalid",
    );
  }
  const bytes = decodeCanonicalBase64(
    evidence.bytes,
    "embedded collector evidence bytes",
    MAX_COLLECTOR_RECEIPT_BYTES,
  );
  if (
    bytes.length !== evidence.byteLength ||
    sha256(bytes) !== evidence.rawSha256
  ) {
    fail(
      "COLLECTOR_EVIDENCE_HASH_MISMATCH",
      "embedded collector raw bytes are missing or hash-mismatched",
    );
  }
  const receipt = parseJsonBytes(bytes, "embedded collector receipt");
  if (
    receipt.schema !== COLLECTOR_RECEIPT_SCHEMA ||
    receipt.receiptHash !== evidence.receiptHash
  ) {
    fail(
      "COLLECTOR_EVIDENCE_RECEIPT_MISMATCH",
      "embedded collector receipt identity is invalid",
    );
  }
  return { bytes, receipt };
}

function validateCertificationShape(certification) {
  canonicalJson(
    certification,
    "external frozen certification",
    MAX_CERTIFICATION_BYTES,
  );
  requireExactKeys(
    certification,
    CERTIFICATION_KEYS,
    "external frozen certification",
  );
  if (certification.schema !== FROZEN_CERTIFICATION_SCHEMA) {
    fail(
      "CERTIFICATION_SCHEMA_INVALID",
      "external frozen certification schema is invalid",
    );
  }
  requirePhaseId(certification.phaseId, "external certification phaseId");
  requireCommit(
    certification.scopeBaseCommit,
    "external certification scopeBaseCommit",
  );
  requireCommit(
    certification.candidateCommit,
    "external certification candidateCommit",
  );
  requireCommit(
    certification.candidateTree,
    "external certification candidateTree",
  );
  if (
    !Number.isSafeInteger(certification.ledgerRevision) ||
    certification.ledgerRevision < 1
  ) {
    fail(
      "INVALID_LEDGER_REVISION",
      "external certification ledgerRevision must be a positive safe integer",
    );
  }
  for (const field of [
    "ledgerSha256",
    "phaseProofRegistrySha256",
    "attestationAuthoritySha256",
    "jwksRegistrySha256",
    "baselineAuthoritySnapshotHash",
    "candidateAuthoritySnapshotHash",
    "authoritySetSha256",
    "strictQualityReceiptHash",
    "phaseProofBundleHash",
    "attestationBodySha256",
    "certificationHash",
  ]) {
    requireSha256(certification[field], `external certification ${field}`);
  }
  requireExactKeys(
    certification.receiptHashes,
    RECEIPT_HASH_KEYS,
    "external certification receiptHashes",
  );
  for (const role of RECEIPT_HASH_KEYS) {
    requireSha256(
      certification.receiptHashes[role],
      `external certification receiptHashes.${role}`,
    );
  }
  if (
    hashWithoutField(
      certification,
      "certificationHash",
      "external frozen certification",
      MAX_CERTIFICATION_BYTES,
    ) !== certification.certificationHash
  ) {
    fail(
      "CERTIFICATION_HASH_MISMATCH",
      "external frozen certification hash is invalid",
    );
  }
}

function validateReplayProtection(replayProtection, collectorResult) {
  requireExactKeys(
    replayProtection,
    REPLAY_PROTECTION_KEYS,
    "external certification replay protection",
  );
  requireSha256(
    replayProtection.replayKeySha256,
    "external certification replayKeySha256",
  );
  if (
    replayProtection.schema !== REPLAY_PROTECTION_SCHEMA ||
    replayProtection.consumptionScope !==
      "single-controller-local-runtime" ||
    replayProtection.multiHostSafe !== false ||
    typeof replayProtection.replayKey !== "string" ||
    replayProtection.replayKey.length < 2 ||
    replayProtection.replayKey.length > 512 ||
    replayProtection.replayKey !== collectorResult.replayKey ||
    sha256(replayProtection.replayKey) !==
      replayProtection.replayKeySha256
  ) {
    fail(
      "REPLAY_PROTECTION_INVALID",
      "external certification replay protection was weakened or detached",
    );
  }
}

function candidateAuthorityBindings(bundle) {
  const candidate = bundle.chain.candidate;
  const snapshot = candidate.authoritySnapshot;
  if (
    !isPlainObject(snapshot) ||
    typeof snapshot.snapshotHash !== "string" ||
    typeof snapshot.authoritySetSha256 !== "string"
  ) {
    fail(
      "CORE_AUTHORITY_BINDING_MISSING",
      "core candidate receipt lacks authority snapshot bindings",
    );
  }
  requireSha256(
    candidate.registrySha256,
    "core candidate registrySha256",
  );
  requireSha256(
    candidate.authorityBaselineSnapshotHash,
    "core candidate authorityBaselineSnapshotHash",
  );
  requireSha256(snapshot.snapshotHash, "core candidate snapshotHash");
  requireSha256(
    snapshot.authoritySetSha256,
    "core candidate authoritySetSha256",
  );
  requireCommit(candidate.candidateTree, "core candidate candidateTree");
  return {
    registrySha256: candidate.registrySha256,
    baselineSnapshotHash: candidate.authorityBaselineSnapshotHash,
    candidateSnapshotHash: snapshot.snapshotHash,
    authoritySetSha256: snapshot.authoritySetSha256,
    candidateTree: candidate.candidateTree,
  };
}

function receiptHashesFromBundle(bundle) {
  return Object.fromEntries(
    RECEIPT_HASH_KEYS.map((role) => [
      role,
      bundle.chain[role].receiptHash,
    ]),
  );
}

function buildExpectedAttestationBody({
  certification,
  expected,
  authoritySha256,
  receiptHashes,
}) {
  const suppliedBody = certification.attestationBody;
  validateAttestationBody(suppliedBody);
  const inputs = {
    schema: COLLECTOR_PROOF_INPUT_SCHEMA,
    phase: {
      phaseId: expected.phaseId,
      issuerRegistrySha256: authoritySha256,
      ledgerRevision: expected.ledgerRevision,
      ledgerSha256: expected.ledgerSha256,
    },
    candidate: {
      commit: expected.candidateCommit,
      tree: expected.candidateTree,
    },
    quality: {
      strictReceiptHash: expected.strictQualityReceiptHash,
      commandPlanHash: suppliedBody.commandPlanHash,
      primaryRawArtifactHash: suppliedBody.primaryRawArtifactHash,
      independentRawArtifactHash: suppliedBody.independentRawArtifactHash,
    },
    receiptHashes,
  };
  return reconstructAttestationBodyFromProofInputs(inputs);
}

function assemblePhaseProofEnvelope({ proofBundle, externalCertification }) {
  if (!isPlainObject(proofBundle) || !isPlainObject(externalCertification)) {
    fail(
      "ENVELOPE_INPUT_INVALID",
      "proofBundle and externalCertification must be plain objects",
    );
  }
  const clonedBundle = JSON.parse(
    canonicalJson(
      proofBundle,
      "core phase proof bundle",
      MAX_CORE_BUNDLE_BYTES,
    ),
  );
  const clonedCertification = JSON.parse(
    canonicalJson(
      externalCertification,
      "external frozen certification",
      MAX_CERTIFICATION_BYTES,
    ),
  );
  const envelope = {
    schema: PHASE_PROOF_ENVELOPE_SCHEMA,
    proofBundle: clonedBundle,
    externalCertification: clonedCertification,
  };
  envelope.envelopeHash = sha256(
    canonicalJson(envelope, "phase proof envelope", MAX_ENVELOPE_BYTES),
  );
  canonicalJson(envelope, "phase proof envelope", MAX_ENVELOPE_BYTES);
  return envelope;
}

function validatePhaseProofEnvelope({
  envelope,
  authorityRegistry,
  expectedAuthoritySha256,
  jwksRegistry,
  expectedJwksRegistrySha256,
  expected,
  nowMs,
}) {
  canonicalJson(envelope, "phase proof envelope", MAX_ENVELOPE_BYTES);
  requireExactKeys(envelope, ENVELOPE_KEYS, "phase proof envelope");
  if (envelope.schema !== PHASE_PROOF_ENVELOPE_SCHEMA) {
    fail("ENVELOPE_SCHEMA_INVALID", "phase proof envelope schema is invalid");
  }
  requireSha256(envelope.envelopeHash, "phase proof envelopeHash");
  if (
    hashWithoutField(
      envelope,
      "envelopeHash",
      "phase proof envelope",
      MAX_ENVELOPE_BYTES,
    ) !== envelope.envelopeHash
  ) {
    fail("ENVELOPE_HASH_MISMATCH", "phase proof envelope hash is invalid");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail("INVALID_NOW", "nowMs must be a non-negative safe integer");
  }
  validateExpectedContext(expected);
  const authoritySha256 = validateAuthorityRegistry({
    authorityRegistry,
    expectedAuthoritySha256,
    expectedJwksRegistrySha256,
  });
  try {
    validatePinnedJwksRegistry(jwksRegistry, {
      expectedRegistrySha256: expectedJwksRegistrySha256,
    });
  } catch (error) {
    fail(
      "JWKS_REGISTRY_INVALID",
      "pinned GitHub JWKS registry is invalid",
      { cause: error.code || error.message },
    );
  }

  const certification = envelope.externalCertification;
  validateCertificationShape(certification);
  validateCoreBundleShape(envelope.proofBundle);
  const receiptHashes = receiptHashesFromBundle(envelope.proofBundle);
  const expectedBody = buildExpectedAttestationBody({
    certification,
    expected,
    authoritySha256,
    receiptHashes,
  });
  const authorityBindings = candidateAuthorityBindings(envelope.proofBundle);
  validateCoreBundle(envelope.proofBundle, expected, expectedBody);
  const bodyReport = validateAttestationBody(expectedBody);

  if (
    certification.phaseId !== expected.phaseId ||
    certification.scopeBaseCommit !== expected.scopeBaseCommit ||
    certification.candidateCommit !== expected.candidateCommit ||
    certification.candidateTree !== expected.candidateTree ||
    certification.ledgerRevision !== expected.ledgerRevision ||
    certification.ledgerSha256 !== expected.ledgerSha256 ||
    certification.phaseProofRegistrySha256 !==
      expected.phaseProofRegistrySha256 ||
    certification.attestationAuthoritySha256 !== authoritySha256 ||
    certification.jwksRegistrySha256 !== expectedJwksRegistrySha256 ||
    certification.baselineAuthoritySnapshotHash !==
      authorityBindings.baselineSnapshotHash ||
    certification.candidateAuthoritySnapshotHash !==
      authorityBindings.candidateSnapshotHash ||
    certification.authoritySetSha256 !==
      authorityBindings.authoritySetSha256 ||
    certification.strictQualityReceiptHash !==
      expected.strictQualityReceiptHash ||
    certification.phaseProofBundleHash !== expected.coreBundleHash ||
    authorityBindings.registrySha256 !==
      expected.phaseProofRegistrySha256 ||
    authorityBindings.candidateTree !== expected.candidateTree ||
    stableJson(certification.receiptHashes) !== stableJson(receiptHashes) ||
    stableJson(certification.attestationBody) !== stableJson(expectedBody) ||
    certification.attestationBodySha256 !== bodyReport.bodySha256
  ) {
    fail(
      "CERTIFICATION_BINDING_MISMATCH",
      "external certification does not bind the exact core proof and authority",
    );
  }

  const expectedRun = validateGithubRun(
    certification.githubRun,
    expected.candidateCommit,
  );
  const decoded = decodeCollectorEvidence(certification.collectorEvidence);
  let collectorResult;
  try {
    collectorResult = validateGithubOidcCollectorReceipt({
      receipt: decoded.receipt,
      expectedBody,
      scopeBaseCommit: expected.scopeBaseCommit,
      jwksRegistry,
      expectedJwksRegistrySha256,
      expectedRun,
      nowMs,
    });
  } catch (error) {
    fail(
      "COLLECTOR_RECEIPT_INVALID",
      "embedded GitHub OIDC collector receipt is invalid",
      { cause: error.code || error.message },
    );
  }
  parseCanonicalIso(
    certification.verifiedAt,
    "external certification verifiedAt",
  );
  if (
    collectorResult?.valid !== true ||
    collectorResult.receiptHash !==
      certification.collectorEvidence.receiptHash ||
    collectorResult.bodySha256 !== bodyReport.bodySha256 ||
    collectorResult.candidateCommit !== expected.candidateCommit ||
    collectorResult.scopeBaseCommit !== expected.scopeBaseCommit ||
    collectorResult.runId !== certification.githubRun.runId ||
    collectorResult.runAttempt !== certification.githubRun.runAttempt ||
    collectorResult.collectedAt !== certification.verifiedAt
  ) {
    fail(
      "COLLECTOR_RESULT_BINDING_MISMATCH",
      "GitHub collector result does not bind the certification",
    );
  }
  validateReplayProtection(
    certification.replayProtection,
    collectorResult,
  );

  return {
    valid: true,
    schema: PHASE_PROOF_ENVELOPE_SCHEMA,
    envelopeHash: envelope.envelopeHash,
    coreBundleHash: envelope.proofBundle.bundleHash,
    certificationHash: certification.certificationHash,
    phaseId: expected.phaseId,
    candidateCommit: expected.candidateCommit,
    candidateTree: expected.candidateTree,
    attestationBodySha256: bodyReport.bodySha256,
    collectorReceiptHash: collectorResult.receiptHash,
    replayKeySha256: certification.replayProtection.replayKeySha256,
    replayConsumed: false,
    externallyCertified: true,
  };
}

module.exports = {
  ATTESTATION_AUTHORITY_SCHEMA,
  COLLECTOR_EVIDENCE_SCHEMA,
  CORE_PHASE_PROOF_SCHEMA,
  FROZEN_CERTIFICATION_SCHEMA,
  GITHUB_RUN_SCHEMA,
  MAX_CERTIFICATION_BYTES,
  MAX_COLLECTOR_RECEIPT_BYTES,
  MAX_CORE_BUNDLE_BYTES,
  MAX_ENVELOPE_BYTES,
  PHASE_PROOF_ENVELOPE_SCHEMA,
  PhaseProofEnvelopeError,
  REPLAY_PROTECTION_SCHEMA,
  assemblePhaseProofEnvelope,
  validatePhaseProofEnvelope,
};

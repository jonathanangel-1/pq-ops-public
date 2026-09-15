#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const external = require("../lib/pikiio-external-ci-proof");
const proofStore = require("../lib/pikiio-proof-store");

const REQUEST_SCHEMA = "pikiio-proof-offline-verification-request-v5";
const RESULT_SCHEMA = "pikiio-proof-offline-verification-result-v5";
const HISTORICAL_VERIFICATION_CLASS =
  "archive_supplied_policy_self_consistency_only";
const MAX_STDIN_BYTES = 64 * 1024;
const VERIFICATION_KEYS = Object.freeze([
  "valid",
  "phaseId",
  "authorityCommit",
  "phaseScopeBaseCommit",
  "scopeBaseCommit",
  "candidateCommit",
  "requestNonce",
  "qualityVerdictHash",
  "evidenceManifestSha256",
  "replayKeySha256",
  "attestationBodySha256",
  "certificationHash",
  "productionAuthority",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseJsonBytes(bytes, label) {
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("OFFLINE_JSON_INVALID", `${label} is not UTF-8 JSON`);
  }
  if (decoded.includes("\uFFFD")) {
    fail("OFFLINE_JSON_INVALID", `${label} contains a replacement character`);
  }
  try {
    return JSON.parse(decoded);
  } catch {
    fail("OFFLINE_JSON_INVALID", `${label} is not UTF-8 JSON`);
  }
}

function readRequest() {
  const bounded = Buffer.allocUnsafe(MAX_STDIN_BYTES + 1);
  let offset = 0;
  while (offset < bounded.length) {
    const count = fs.readSync(
      0,
      bounded,
      offset,
      bounded.length - offset,
      null,
    );
    if (count === 0) break;
    offset += count;
  }
  const bytes = bounded.subarray(0, offset);
  if (bytes.length < 3 || bytes.length > MAX_STDIN_BYTES) {
    fail("OFFLINE_REQUEST_SIZE_INVALID", "offline request is not bounded");
  }
  return validateRequest(parseJsonBytes(bytes, "offline request"));
}

function validateIsolatedStoreRoot(root) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root
  ) {
    fail(
      "OFFLINE_STORE_INVALID",
      "isolated store root must use one normalized absolute spelling",
    );
  }
  let temporaryRoot;
  let realRoot;
  let rootStat;
  try {
    temporaryRoot = fs.realpathSync(os.tmpdir());
    realRoot = fs.realpathSync(root);
    rootStat = fs.lstatSync(root, { bigint: true });
  } catch {
    fail("OFFLINE_STORE_INVALID", "isolated store root is unavailable");
  }
  const basename = path.basename(root);
  const ownerUid =
    typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (
    path.dirname(root) !== temporaryRoot ||
    realRoot !== root ||
    !basename.startsWith("pikiio-proof-v5-test-") ||
    basename.length === "pikiio-proof-v5-test-".length ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    (ownerUid !== null && rootStat.uid !== ownerUid) ||
    Number(rootStat.mode & 0o777n) !== 0o700
  ) {
    fail(
      "OFFLINE_STORE_INVALID",
      "isolated store root must be one canonical owner-only temporary directory",
    );
  }
  return root;
}

function validateRequest(request) {
  if (
    !exactKeys(request, ["archiveRoot", "schema", "store"]) ||
    request.schema !== REQUEST_SCHEMA ||
    !exactKeys(request.store, ["mode", "root"])
  ) {
    fail("OFFLINE_REQUEST_INVALID", "offline request shape is invalid");
  }
  if (request.store.mode === "canonical") {
    if (request.store.root !== null) {
      fail("OFFLINE_STORE_INVALID", "canonical store refuses a supplied root");
    }
  } else if (request.store.mode === "isolated_test_non_authorizing") {
    validateIsolatedStoreRoot(request.store.root);
  } else {
    fail("OFFLINE_STORE_INVALID", "offline proof-store selector is invalid");
  }
  try {
    proofStore.validateBlobReference(
      request.archiveRoot,
      "offline archive root",
    );
  } catch {
    fail(
      "OFFLINE_ARCHIVE_REFERENCE_INVALID",
      "offline archive reference is invalid",
    );
  }
  return request;
}

function openStore(storeSpec) {
  try {
    if (storeSpec.mode === "canonical") {
      return proofStore.openCanonicalProofStoreReadOnly();
    }
    return proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(
      storeSpec.root,
    );
  } catch {
    fail(
      "OFFLINE_STORE_INVALID",
      "offline proof store could not be opened read-only",
    );
  }
}

function requireLocalSource(roleBytes, modulePath, code) {
  let local;
  try {
    local = fs.readFileSync(modulePath);
  } catch {
    fail(code, "executing verifier source is unreadable");
  }
  if (!local.equals(roleBytes)) {
    fail(code, "archived verifier source differs from the executing source");
  }
}

function assertVerificationBindings(materialized, verification) {
  const { manifest } = proofStore.readArchiveRoot(
    materialized.store,
    materialized.archiveRoot,
  );
  const packageValue = materialized.packageValue;
  const bindings = manifest.bindings;
  if (!exactKeys(verification, VERIFICATION_KEYS)) {
    fail(
      "OFFLINE_VERIFICATION_RESULT_INVALID",
      "external verification result shape is invalid",
    );
  }
  const exact = [
    [verification.phaseId, manifest.phaseId],
    [verification.authorityCommit, manifest.authorityCommit],
    [verification.phaseScopeBaseCommit, manifest.scopeBaseCommit],
    [verification.scopeBaseCommit, manifest.scopeBaseCommit],
    [verification.candidateCommit, manifest.candidateCommit],
    [verification.requestNonce, manifest.requestNonce],
    [verification.qualityVerdictHash, bindings.qualityVerdictHash],
    [verification.evidenceManifestSha256, bindings.evidenceManifestSha256],
    [verification.replayKeySha256, bindings.replayKeySha256],
    [verification.attestationBodySha256, bindings.attestationBodySha256],
    [verification.certificationHash, bindings.certificationHash],
    [packageValue.packageHash, bindings.externalPackageHash],
    [
      packageValue.materialization.authority.jwksRegistrySha256,
      bindings.jwksRegistrySha256,
    ],
    [
      packageValue.materialization.authority.toolchainSha256,
      bindings.toolchainSha256,
    ],
  ];
  if (exact.some(([left, right]) => left !== right)) {
    fail("OFFLINE_ARCHIVE_BINDING_MISMATCH", "archive bindings do not match verification");
  }
}

function verify(request) {
  const boundedRequest = validateRequest(request);
  const store = openStore(boundedRequest.store);
  const archiveRoot = proofStore.validateBlobReference(
    boundedRequest.archiveRoot,
    "offline archive root",
  );
  const offline = proofStore.materializeArchiveOffline(store, archiveRoot);
  requireLocalSource(
    offline.roles.externalVerifierSource.bytes,
    require.resolve("../lib/pikiio-external-ci-proof"),
    "OFFLINE_EXTERNAL_VERIFIER_SOURCE_MISMATCH",
  );
  requireLocalSource(
    offline.roles.oidcVerifierSource.bytes,
    require.resolve("../lib/pikiio-github-oidc-collector-v3"),
    "OFFLINE_OIDC_VERIFIER_SOURCE_MISMATCH",
  );
  const packageValue = parseJsonBytes(
    offline.roles.externalPackage.bytes,
    "external package",
  );
  const trustedAuthority = parseJsonBytes(
    offline.roles.trustedAuthority.bytes,
    "trusted authority",
  );
  const jwksRegistry = parseJsonBytes(
    offline.roles.jwksRegistry.bytes,
    "JWKS registry",
  );
  const artifacts = new Map(
    offline.rawArtifacts.map((artifact) => [
      artifact.reference.address,
      artifact.bytes,
    ]),
  );
  const nowMs = Date.parse(packageValue?.certification?.verifiedAt);
  if (!Number.isFinite(nowMs)) {
    fail("OFFLINE_VERIFICATION_TIME_INVALID", "certification has no bounded verification time");
  }
  const verification = external.verifyExternalCiPackage({
    bundle: packageValue,
    trustedAuthority,
    jwksRegistry,
    artifacts,
    nowMs,
  });
  assertVerificationBindings(
    {
      store,
      archiveRoot,
      packageValue,
    },
    verification,
  );
  return {
    schema: RESULT_SCHEMA,
    ok: true,
    processId: process.pid,
    archiveRoot,
    verification,
    verificationClass: HISTORICAL_VERIFICATION_CLASS,
    archiveSuppliedTrustPolicy: true,
    controllerAuthorityPinned: false,
    historicalEvidenceOnly: true,
    builderAuthority: false,
    productionAuthority: false,
  };
}

function execute(requestReader, writer) {
  try {
    writer(`${JSON.stringify(verify(requestReader()))}\n`);
    return 0;
  } catch (error) {
    writer(
      `${JSON.stringify({
        schema: RESULT_SCHEMA,
        ok: false,
        code:
          typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code)
            ? error.code
            : "OFFLINE_VERIFICATION_FAILED",
        error: String(
          error instanceof Error ? error.message : error,
        ).slice(0, 2_048) || "offline verification failed",
        verificationClass: HISTORICAL_VERIFICATION_CLASS,
        archiveSuppliedTrustPolicy: true,
        controllerAuthorityPinned: false,
        historicalEvidenceOnly: true,
        builderAuthority: false,
        productionAuthority: false,
      })}\n`,
    );
    return 1;
  }
}

function main() {
  return execute(readRequest, (value) => process.stdout.write(value));
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = Object.freeze({
  HISTORICAL_VERIFICATION_CLASS,
  RESULT_SCHEMA,
  execute,
  main,
  validateRequest,
  verify,
});

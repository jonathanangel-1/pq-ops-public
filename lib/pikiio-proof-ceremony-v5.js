"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const proofStore = require("./pikiio-proof-store");

const CEREMONY_SCHEMA = "pikiio-proof-ceremony-v5";
const INSPECTION_SCHEMA = "pikiio-proof-ceremony-inspection-v5";
const PLAN_SCHEMA = "pikiio-proof-ceremony-plan-v5";
const ADOPTION_RECEIPT_SCHEMA =
  "pikiio-proof-ceremony-audit-adoption-receipt-v5";
const OFFLINE_RESULT_SCHEMA = "pikiio-proof-offline-verification-result-v5";
const HISTORICAL_VERIFICATION_CLASS =
  "archive_supplied_policy_self_consistency_only";
const REQUIRED_EXTERNAL_AUTHORITY_STATE =
  "corrected_external_lane_frozen_hashes_and_hosted_evidence";
const CURRENT_EXTERNAL_AUTHORITY_STATE = "uncommissioned";
const PROOF_STORE_SOURCE_SHA256 =
  "77ad821b9b1c8d6829c3514a9a6071ccd670ec547d110a6d3041e2f8cc0534b8";
const PROOF_STORE_TEST_SOURCE_SHA256 =
  "2ea06d450c2c2173de8d4dc395962a656a795d02be96d9775ba97219efb6bd5f";
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
const OFFLINE_TIMEOUT_MILLISECONDS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_PATTERN = /^[A-Z]+-[0-9]{2}$/;
const CHILD_SUCCESS_KEYS = Object.freeze([
  "schema",
  "ok",
  "processId",
  "archiveRoot",
  "verification",
  "verificationClass",
  "archiveSuppliedTrustPolicy",
  "controllerAuthorityPinned",
  "historicalEvidenceOnly",
  "builderAuthority",
  "productionAuthority",
]);
const CHILD_FAILURE_KEYS = Object.freeze([
  "schema",
  "ok",
  "code",
  "error",
  "verificationClass",
  "archiveSuppliedTrustPolicy",
  "controllerAuthorityPinned",
  "historicalEvidenceOnly",
  "builderAuthority",
  "productionAuthority",
]);
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

const CHILD_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "pikiio-proof-v5-offline-verify-child.js",
);
const PROOF_STORE_SOURCE_PATH = require.resolve("./pikiio-proof-store");
const PROOF_STORE_TEST_SOURCE_PATH = path.join(
  __dirname,
  "..",
  "tests",
  "pikiio-proof-store.test.js",
);

class ProofCeremonyV5Error extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProofCeremonyV5Error";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ProofCeremonyV5Error(code, message, details);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireExactKeys(value, expected, label) {
  if (
    !isPlainObject(value) ||
    Reflect.ownKeys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  ) {
    fail("V5_SHAPE_INVALID", `${label} must contain exactly ${expected.join(", ")}`);
  }
  return value;
}

function assertFrozenProofStore() {
  const pins = [
    {
      path: PROOF_STORE_SOURCE_PATH,
      expected: PROOF_STORE_SOURCE_SHA256,
      unreadableCode: "PROOF_STORE_SOURCE_UNREADABLE",
      mismatchCode: "PROOF_STORE_FREEZE_MISMATCH",
      label: "proof-store source",
    },
    {
      path: PROOF_STORE_TEST_SOURCE_PATH,
      expected: PROOF_STORE_TEST_SOURCE_SHA256,
      unreadableCode: "PROOF_STORE_TEST_SOURCE_UNREADABLE",
      mismatchCode: "PROOF_STORE_TEST_FREEZE_MISMATCH",
      label: "proof-store test source",
    },
  ];
  for (const pin of pins) {
    let bytes;
    try {
      bytes = fs.readFileSync(pin.path);
    } catch (error) {
      fail(pin.unreadableCode, `frozen ${pin.label} is unreadable`, {
        causeCode: error?.code || "UNKNOWN",
      });
    }
    const actual = proofStore.sha256(bytes);
    if (actual !== pin.expected) {
      fail(pin.mismatchCode, `frozen ${pin.label} hash changed`, {
        expected: pin.expected,
        actual,
      });
    }
  }
  return PROOF_STORE_SOURCE_SHA256;
}

function validateArchiveReference(reference) {
  const validated = proofStore.validateBlobReference(
    requireExactKeys(
      reference,
      ["schema", "address", "byteLength", "mediaType", "payloadSchema"],
      "archive root reference",
    ),
    "archive root reference",
  );
  return Object.freeze({ ...validated });
}

function archiveReference(input) {
  requireExactKeys(input, ["address", "byteLength"], "archive reference input");
  const { address, byteLength } = input;
  return validateArchiveReference({
    schema: proofStore.BLOB_REFERENCE_SCHEMA,
    address,
    byteLength,
    mediaType: "application/json",
    payloadSchema: proofStore.ARCHIVE_ROOT_SCHEMA,
  });
}

function validateStoreSpec(storeSpec) {
  requireExactKeys(storeSpec, ["mode", "root"], "proof-store spec");
  if (storeSpec.mode === "canonical") {
    if (storeSpec.root !== null) {
      fail("CANONICAL_ROOT_INJECTION_REFUSED", "canonical mode refuses a supplied root");
    }
    return Object.freeze({ mode: "canonical", root: null });
  }
  if (storeSpec.mode !== "isolated_test_non_authorizing") {
    fail("STORE_MODE_INVALID", "proof-store mode is invalid");
  }
  validateIsolatedStoreRoot(storeSpec.root);
  return Object.freeze({ mode: storeSpec.mode, root: storeSpec.root });
}

function validateIsolatedStoreRoot(root) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root
  ) {
    fail(
      "TEST_STORE_ROOT_INVALID",
      "isolated test root must use one normalized absolute spelling",
    );
  }
  let temporaryRoot;
  let realRoot;
  let rootStat;
  try {
    temporaryRoot = fs.realpathSync(os.tmpdir());
    realRoot = fs.realpathSync(root);
    rootStat = fs.lstatSync(root, { bigint: true });
  } catch (error) {
    fail("TEST_STORE_ROOT_UNAVAILABLE", "isolated test root is unavailable", {
      causeCode: error?.code || "UNKNOWN",
    });
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
      "TEST_STORE_ROOT_INVALID",
      "isolated test root must be one canonical owner-only temporary directory",
    );
  }
  return root;
}

function openStoreReadOnly(storeSpec) {
  try {
    return storeSpec.mode === "canonical"
      ? proofStore.openCanonicalProofStoreReadOnly()
      : proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(storeSpec.root);
  } catch (error) {
    fail(
      storeSpec.mode === "canonical"
        ? "CANONICAL_PROOF_STORE_UNAVAILABLE"
        : "TEST_STORE_ROOT_CHANGED",
      "proof store could not be opened read-only",
      { causeCode: error?.code || "UNKNOWN" },
    );
  }
}

function openStoreWritable(storeSpec) {
  try {
    return storeSpec.mode === "canonical"
      ? proofStore.initializeCanonicalProofStoreFoundation()
      : proofStore.initializeIsolatedNonAuthorizingTestStore(storeSpec.root);
  } catch (error) {
    fail(
      storeSpec.mode === "canonical"
        ? "CANONICAL_PROOF_STORE_UNAVAILABLE"
        : "TEST_STORE_ROOT_CHANGED",
      "proof store could not be opened for explicit audit adoption",
      { causeCode: error?.code || "UNKNOWN" },
    );
  }
}

function parseChildOutput(output) {
  if (
    !Buffer.isBuffer(output) ||
    output.length < 2 ||
    output.length > MAX_CHILD_OUTPUT_BYTES
  ) {
    fail("OFFLINE_VERIFIER_PROTOCOL_INVALID", "offline verifier output is not bounded");
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    fail(
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
      "offline verifier output is not fatal UTF-8",
    );
  }
  if (decoded.includes("\uFFFD")) {
    fail(
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
      "offline verifier output contains a replacement character",
    );
  }
  let value;
  try {
    value = JSON.parse(decoded);
  } catch {
    fail("OFFLINE_VERIFIER_PROTOCOL_INVALID", "offline verifier did not return JSON");
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("OFFLINE_VERIFIER_PROTOCOL_INVALID", `${label} is not SHA-256`);
  }
}

function validateVerification(value) {
  try {
    requireExactKeys(value, VERIFICATION_KEYS, "offline verification");
  } catch (error) {
    if (error instanceof ProofCeremonyV5Error) {
      fail(
        "OFFLINE_VERIFIER_PROTOCOL_INVALID",
        "offline verification shape is invalid",
      );
    }
    throw error;
  }
  if (
    value.valid !== true ||
    typeof value.phaseId !== "string" ||
    !PHASE_PATTERN.test(value.phaseId) ||
    typeof value.authorityCommit !== "string" ||
    !COMMIT_PATTERN.test(value.authorityCommit) ||
    typeof value.phaseScopeBaseCommit !== "string" ||
    !COMMIT_PATTERN.test(value.phaseScopeBaseCommit) ||
    typeof value.scopeBaseCommit !== "string" ||
    !COMMIT_PATTERN.test(value.scopeBaseCommit) ||
    value.phaseScopeBaseCommit !== value.scopeBaseCommit ||
    typeof value.candidateCommit !== "string" ||
    !COMMIT_PATTERN.test(value.candidateCommit) ||
    value.productionAuthority !== false
  ) {
    fail(
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
      "offline verification identity is invalid",
    );
  }
  for (const key of [
    "requestNonce",
    "qualityVerdictHash",
    "evidenceManifestSha256",
    "replayKeySha256",
    "attestationBodySha256",
    "certificationHash",
  ]) {
    requireSha256(value[key], `offline verification.${key}`);
  }
  return Object.freeze({ ...value });
}

function validateChildSuccess(payload, reference) {
  try {
    requireExactKeys(payload, CHILD_SUCCESS_KEYS, "offline verifier result");
  } catch (error) {
    if (error instanceof ProofCeremonyV5Error) {
      fail(
        "OFFLINE_VERIFIER_PROTOCOL_INVALID",
        "offline verifier result shape is invalid",
      );
    }
    throw error;
  }
  let archiveRoot;
  try {
    archiveRoot = validateArchiveReference(payload.archiveRoot);
  } catch {
    fail(
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
      "offline verifier archive reference is invalid",
    );
  }
  const verification = validateVerification(payload.verification);
  if (
    payload.schema !== OFFLINE_RESULT_SCHEMA ||
    payload.ok !== true ||
    !Number.isSafeInteger(payload.processId) ||
    payload.processId <= 0 ||
    payload.processId === process.pid ||
    proofStore.stableJson(archiveRoot) !== proofStore.stableJson(reference) ||
    payload.verificationClass !== HISTORICAL_VERIFICATION_CLASS ||
    payload.archiveSuppliedTrustPolicy !== true ||
    payload.controllerAuthorityPinned !== false ||
    payload.historicalEvidenceOnly !== true ||
    payload.builderAuthority !== false ||
    payload.productionAuthority !== false
  ) {
    fail("OFFLINE_VERIFIER_PROTOCOL_INVALID", "offline verifier result is not bound");
  }
  return Object.freeze({
    ...payload,
    archiveRoot: Object.freeze({ ...archiveRoot }),
    verification,
  });
}

function validateChildFailure(payload) {
  try {
    requireExactKeys(payload, CHILD_FAILURE_KEYS, "offline verifier failure");
  } catch (error) {
    if (error instanceof ProofCeremonyV5Error) {
      fail(
        "OFFLINE_VERIFIER_PROTOCOL_INVALID",
        "offline verifier failure shape is invalid",
      );
    }
    throw error;
  }
  if (
    payload.schema !== OFFLINE_RESULT_SCHEMA ||
    payload.ok !== false ||
    typeof payload.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{2,79}$/.test(payload.code) ||
    typeof payload.error !== "string" ||
    payload.error.length < 1 ||
    payload.error.length > 2_048 ||
    payload.verificationClass !== HISTORICAL_VERIFICATION_CLASS ||
    payload.archiveSuppliedTrustPolicy !== true ||
    payload.controllerAuthorityPinned !== false ||
    payload.historicalEvidenceOnly !== true ||
    payload.builderAuthority !== false ||
    payload.productionAuthority !== false
  ) {
    fail(
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
      "offline verifier failure identity is invalid",
    );
  }
  return payload;
}

function runOfflineVerification(storeSpec, reference) {
  const request = proofStore.canonicalJsonBytes({
    schema: "pikiio-proof-offline-verification-request-v5",
    store: storeSpec,
    archiveRoot: reference,
  });
  let temporaryRoot;
  if (storeSpec.mode === "isolated_test_non_authorizing") {
    // validateStoreSpec already proved this parent is the canonical real
    // operating-system temporary root. Preserve that identity across the
    // deliberately scrubbed process boundary without inheriting ambient env.
    temporaryRoot = path.dirname(storeSpec.root);
  } else {
    try {
      temporaryRoot = fs.realpathSync(os.tmpdir());
    } catch (error) {
      fail(
        "OFFLINE_VERIFIER_ENVIRONMENT_INVALID",
        "canonical temporary root is unavailable for the offline verifier",
        { causeCode: error?.code || "UNKNOWN" },
      );
    }
  }
  const result = childProcess.spawnSync(process.execPath, [CHILD_PATH], {
    cwd: path.join(__dirname, ".."),
    // This is a new exact own-key object, not an ambient-environment copy.
    // It intentionally remains extensible so Node's instrumented test runner
    // can attach its private coverage transport inside child_process.
    env: {
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: temporaryRoot,
    },
    input: request,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout: OFFLINE_TIMEOUT_MILLISECONDS,
    windowsHide: true,
  });
  if (result.error) {
    fail("OFFLINE_VERIFIER_PROCESS_FAILED", "offline verifier process failed", {
      causeCode: result.error.code || "UNKNOWN",
    });
  }
  if (result.signal) {
    fail("OFFLINE_VERIFIER_PROCESS_KILLED", "offline verifier was killed", {
      signal: result.signal,
    });
  }
  if (!Buffer.isBuffer(result.stderr) || result.stderr.length !== 0) {
    fail("OFFLINE_VERIFIER_PROTOCOL_INVALID", "offline verifier wrote to stderr");
  }
  const payload = parseChildOutput(result.stdout);
  if (result.status === 1) {
    const failure = validateChildFailure(payload);
    fail(
      "OFFLINE_ARCHIVE_VERIFICATION_FAILED",
      "fresh-process offline archive verification failed",
      {
        causeCode: failure.code,
      },
    );
  }
  if (result.status !== 0) {
    fail("OFFLINE_VERIFIER_PROCESS_FAILED", "offline verifier exited unexpectedly", {
      exitStatus: result.status,
    });
  }
  return validateChildSuccess(payload, reference);
}

function inspectionFor(storeSpec, reference) {
  assertFrozenProofStore();
  const store = openStoreReadOnly(storeSpec);
  const archive = proofStore.readArchiveRoot(store, reference);
  const offline = runOfflineVerification(storeSpec, reference);
  if (
    offline.verification.phaseId !== archive.manifest.phaseId ||
    offline.verification.authorityCommit !== archive.manifest.authorityCommit ||
    offline.verification.scopeBaseCommit !== archive.manifest.scopeBaseCommit ||
    offline.verification.candidateCommit !== archive.manifest.candidateCommit ||
    offline.verification.requestNonce !== archive.manifest.requestNonce ||
    offline.verification.qualityVerdictHash !==
      archive.manifest.bindings.qualityVerdictHash ||
    offline.verification.evidenceManifestSha256 !==
      archive.manifest.bindings.evidenceManifestSha256 ||
    offline.verification.replayKeySha256 !==
      archive.manifest.bindings.replayKeySha256 ||
    offline.verification.attestationBodySha256 !==
      archive.manifest.bindings.attestationBodySha256 ||
    offline.verification.certificationHash !==
      archive.manifest.bindings.certificationHash
  ) {
    fail("ARCHIVE_VERIFICATION_BINDING_MISMATCH", "offline result does not bind the archive");
  }
  return Object.freeze({
    schema: INSPECTION_SCHEMA,
    archiveRoot: reference,
    archiveRootByteSha256: proofStore.sha256(archive.bytes),
    proofStoreIdentitySha256: proofStore.proofStoreIdentitySha256(store),
    phaseId: archive.manifest.phaseId,
    authorityCommit: archive.manifest.authorityCommit,
    scopeBaseCommit: archive.manifest.scopeBaseCommit,
    candidateCommit: archive.manifest.candidateCommit,
    externalPackageHash: archive.manifest.bindings.externalPackageHash,
    externalVerification:
      "archive_self_consistency_checked_historical_non_authorizing",
    verificationClass: HISTORICAL_VERIFICATION_CLASS,
    archiveSuppliedTrustPolicy: true,
    controllerAuthorityPinned: false,
    externalAuthorityState: CURRENT_EXTERNAL_AUTHORITY_STATE,
    requiredExternalAuthorityState: REQUIRED_EXTERNAL_AUTHORITY_STATE,
    freshProcessId: offline.processId,
    historicalEvidenceOnly: true,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function planFromInspection(inspection) {
  return Object.freeze({
    schema: PLAN_SCHEMA,
    ceremonySchema: CEREMONY_SCHEMA,
    archiveRoot: inspection.archiveRoot,
    phaseId: inspection.phaseId,
    decision: "blocked",
    reasonCode: "EXTERNAL_AUTHORITY_CONTRACT_UNCOMMISSIONED",
    requiredExternalAuthorityState: REQUIRED_EXTERNAL_AUTHORITY_STATE,
    irreversibleSideEffectBoundaries: Object.freeze([]),
    filesystemWritesPlanned: 0,
    gitWritesPlanned: 0,
    remoteWritesPlanned: 0,
    ledgerWritesPlanned: 0,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function adoptionReceipt(store, archive, adopted) {
  const body = {
    schema: ADOPTION_RECEIPT_SCHEMA,
    proofStoreIdentitySha256: proofStore.proofStoreIdentitySha256(store),
    archiveRoot: archive.reference,
    archiveRootByteSha256: proofStore.sha256(archive.bytes),
    importKeySha256: adopted.index.importKeySha256,
    importIndexByteSha256: adopted.indexByteSha256,
    externalPackageHash: archive.manifest.bindings.externalPackageHash,
    certificationHash: archive.manifest.bindings.certificationHash,
    verificationClass: HISTORICAL_VERIFICATION_CLASS,
    archiveSuppliedTrustPolicy: true,
    controllerAuthorityPinned: false,
    historicalEvidenceOnly: true,
    builderAuthority: false,
    productionAuthority: false,
  };
  const stored = proofStore.storeBlob(store, {
    bytes: proofStore.canonicalJsonBytes(body),
    mediaType: "application/json",
    payloadSchema: ADOPTION_RECEIPT_SCHEMA,
  });
  return Object.freeze({
    receipt: Object.freeze(body),
    receiptReference: stored.reference,
    created: stored.created,
    builderAuthority: false,
    productionAuthority: false,
  });
}

function validateTestHooks(testHooks) {
  if (testHooks === null) return null;
  requireExactKeys(testHooks, ["afterImport"], "isolated test hooks");
  if (typeof testHooks.afterImport !== "function") {
    fail("TEST_HOOKS_INVALID", "isolated test hook must be callable");
  }
  return Object.freeze({ afterImport: testHooks.afterImport });
}

function createController(storeSpecInput, testHooksInput = null) {
  requireExactKeys(storeSpecInput, ["mode", "root"], "proof-store spec");
  const declaredStoreSpec = Object.freeze({ ...storeSpecInput });
  const testHooks = validateTestHooks(testHooksInput);
  if (declaredStoreSpec.mode === "canonical" && testHooks !== null) {
    fail("TEST_HOOKS_INVALID", "canonical ceremony refuses test hooks");
  }
  return Object.freeze({
    inspect(referenceInput) {
      const storeSpec = validateStoreSpec(declaredStoreSpec);
      return inspectionFor(storeSpec, validateArchiveReference(referenceInput));
    },
    plan(referenceInput) {
      const storeSpec = validateStoreSpec(declaredStoreSpec);
      return planFromInspection(
        inspectionFor(storeSpec, validateArchiveReference(referenceInput)),
      );
    },
    dryRun(referenceInput) {
      const storeSpec = validateStoreSpec(declaredStoreSpec);
      const plan = planFromInspection(
        inspectionFor(storeSpec, validateArchiveReference(referenceInput)),
      );
      return Object.freeze({
        ...plan,
        dryRun: true,
        authorizing: false,
      });
    },
    adoptAudit(referenceInput) {
      const storeSpec = validateStoreSpec(declaredStoreSpec);
      const reference = validateArchiveReference(referenceInput);
      const inspection = inspectionFor(storeSpec, reference);
      const store = openStoreWritable(storeSpec);
      const archive = proofStore.readArchiveRoot(store, reference);
      const adopted = proofStore.adoptArchiveImport(store, reference);
      if (testHooks !== null) testHooks.afterImport();
      const receipt = adoptionReceipt(store, archive, adopted);
      return Object.freeze({
        schema: CEREMONY_SCHEMA,
        operation: "audit_adoption",
        inspection,
        importIndex: adopted.index,
        receipt: receipt.receipt,
        receiptReference: receipt.receiptReference,
        idempotent: adopted.idempotent && !receipt.created,
        recoveredAfterPartialAdoption: adopted.idempotent && receipt.created,
        historicalEvidenceOnly: true,
        builderAuthority: false,
        productionAuthority: false,
      });
    },
    live() {
      fail(
        "EXTERNAL_AUTHORITY_CONTRACT_UNCOMMISSIONED",
        "live ceremony is blocked until corrected frozen external authority has hosted proof",
        {
          currentExternalAuthorityState: CURRENT_EXTERNAL_AUTHORITY_STATE,
          requiredExternalAuthorityState: REQUIRED_EXTERNAL_AUTHORITY_STATE,
        },
      );
    },
  });
}

const canonicalController = createController({
  mode: "canonical",
  root: null,
});

function createIsolatedAuditControllerForTests(root, testHooks = null) {
  return createController({
    mode: "isolated_test_non_authorizing",
    root,
  }, testHooks);
}

module.exports = Object.freeze({
  ADOPTION_RECEIPT_SCHEMA,
  CEREMONY_SCHEMA,
  CURRENT_EXTERNAL_AUTHORITY_STATE,
  HISTORICAL_VERIFICATION_CLASS,
  INSPECTION_SCHEMA,
  OFFLINE_RESULT_SCHEMA,
  PLAN_SCHEMA,
  PROOF_STORE_SOURCE_SHA256,
  PROOF_STORE_TEST_SOURCE_SHA256,
  ProofCeremonyV5Error,
  REQUIRED_EXTERNAL_AUTHORITY_STATE,
  adoptCanonicalAuditArchive:
    canonicalController.adoptAudit,
  archiveReference,
  createIsolatedAuditControllerForTests,
  dryRunCanonicalCeremony: canonicalController.dryRun,
  inspectCanonicalArchive: canonicalController.inspect,
  planCanonicalCeremony: canonicalController.plan,
  runCanonicalLiveCeremony: canonicalController.live,
  validateArchiveReference,
});

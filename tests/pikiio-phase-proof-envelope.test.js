"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  ATTESTATION_BODY_SCHEMA,
  sha256,
  stableJson,
} = require("../lib/pikiio-phase-attestation");
const {
  COLLECTOR_PROOF_INPUT_SCHEMA,
  COLLECTOR_RECEIPT_SCHEMA,
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_OWNER,
  EXPECTED_REPOSITORY_VISIBILITY,
  EXPECTED_RUNNER_ENVIRONMENT,
  GITHUB_OIDC_ISSUER,
  JWKS_REGISTRY_SCHEMA,
  REUSABLE_WORKFLOW_PATH,
  REUSABLE_WORKFLOW_REF,
  buildGithubOidcCollectorReceipt,
  expectedAudience,
  expectedReusableWorkflowRef,
  hashWithoutField: oidcHashWithoutField,
  reconstructAttestationBodyFromProofInputs,
} = require("../lib/pikiio-github-oidc-collector");
const {
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
} = require("../lib/pikiio-phase-proof-envelope");

const signingKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const attackerKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const signingJwk = signingKeys.publicKey.export({ format: "jwk" });
const attackerJwk = attackerKeys.publicKey.export({ format: "jwk" });

const FIXED_IAT = 1_783_000_000;
const FIXED_NOW = (FIXED_IAT + 2) * 1000;
const CANDIDATE = "b".repeat(40);
const TREE = "c".repeat(40);
const SCOPE_BASE = "a".repeat(40);
const REF = "refs/heads/codex/proof-candidate";
const JTI = "123e4567-e89b-42d3-a456-426614174000";
const X5T = crypto
  .createHash("sha1")
  .update("phase-proof-envelope-test")
  .digest("base64url");

function clone(value) {
  return structuredClone(value);
}

function digest(value) {
  return sha256(Buffer.isBuffer(value) ? value : String(value));
}

function withoutFieldHash(value, field) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function rehashCertification(certification) {
  certification.certificationHash = withoutFieldHash(
    certification,
    "certificationHash",
  );
}

function rehashBundle(bundle) {
  bundle.bundleHash = withoutFieldHash(bundle, "bundleHash");
}

function rehashEnvelope(envelope) {
  envelope.envelopeHash = withoutFieldHash(envelope, "envelopeHash");
}

function selfHashReceipt(fields) {
  const receipt = { ...fields };
  receipt.receiptHash = withoutFieldHash(receipt, "receiptHash");
  return receipt;
}

function artifact(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hash = sha256(buffer);
  return {
    address: `sha256:${hash}`,
    bytes: buffer.toString("base64"),
    encoding: "base64",
    sha256: hash,
  };
}

function receiptArtifact(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receiptHash;
  return artifact(Buffer.from(stableJson(unsigned)));
}

function artifactReference(hash) {
  return { address: `sha256:${hash}`, sha256: hash };
}

function makeJwks({
  kid = "github-envelope-test-key",
  jwk = signingJwk,
  x5t = X5T,
  issuer = GITHUB_OIDC_ISSUER,
} = {}) {
  const registry = {
    schema: JWKS_REGISTRY_SCHEMA,
    revision: 1,
    issuer,
    keys: [
      {
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid,
        n: jwk.n,
        e: jwk.e,
        x5t,
      },
    ],
    registrySha256: "0".repeat(64),
  };
  registry.registrySha256 = oidcHashWithoutField(
    registry,
    "registrySha256",
  );
  return registry;
}

function makeAuthority(jwksHash) {
  const registry = {
    schema: ATTESTATION_AUTHORITY_SCHEMA,
    revision: 1,
    mode: "external_collector_required",
    bodySchema: ATTESTATION_BODY_SCHEMA,
    controller: {
      kind: "local_content_addressed_evidence",
      cryptographicSignature: "optional_non_authorizing",
      localCollectorPrivateKeyAllowed: false,
    },
    collector: {
      kind: "github_actions_oidc",
      issuer: GITHUB_OIDC_ISSUER,
      repository: EXPECTED_REPOSITORY,
      repositoryVisibility: EXPECTED_REPOSITORY_VISIBILITY,
      runnerEnvironment: EXPECTED_RUNNER_ENVIRONMENT,
      workflowPath: REUSABLE_WORKFLOW_PATH,
      workflowRef: REUSABLE_WORKFLOW_REF,
      jwksRegistryPath:
        "YLYI/00_Product_Contract/Pikiio_GitHub_OIDC_JWKS.json",
      jwksRegistrySha256: jwksHash,
    },
    authoritySha256: "0".repeat(64),
  };
  registry.authoritySha256 = withoutFieldHash(
    registry,
    "authoritySha256",
  );
  return registry;
}

function makeJwtPayload({
  body,
  candidateCommit,
  scopeBaseCommit,
  overrides = {},
}) {
  return {
    actor: "demo-maintainer",
    actor_id: "12345",
    aud: expectedAudience(sha256(stableJson(body))),
    base_ref: "",
    check_run_id: "90001",
    event_name: "workflow_call",
    exp: FIXED_IAT + 600,
    head_ref: "",
    iat: FIXED_IAT,
    iss: GITHUB_OIDC_ISSUER,
    job_workflow_ref: expectedReusableWorkflowRef(),
    job_workflow_sha: scopeBaseCommit,
    jti: JTI,
    nbf: FIXED_IAT - 60,
    ref: REF,
    ref_protected: "true",
    ref_type: "branch",
    repository: EXPECTED_REPOSITORY,
    repository_id: "123456789",
    repository_owner: EXPECTED_REPOSITORY_OWNER,
    repository_owner_id: "12345",
    repository_visibility: EXPECTED_REPOSITORY_VISIBILITY,
    run_attempt: "1",
    run_id: "80001",
    run_number: "41",
    runner_environment: EXPECTED_RUNNER_ENVIRONMENT,
    sha: candidateCommit,
    sub: `repo:${EXPECTED_REPOSITORY}:ref:${REF}`,
    workflow: "Pikiio proof caller",
    workflow_ref:
      `${EXPECTED_REPOSITORY}/.github/workflows/` +
      `pikiio-proof-request.yml@${REF}`,
    workflow_sha: candidateCommit,
    ...overrides,
  };
}

function signJwt({
  payload,
  privateKey = signingKeys.privateKey,
  header = {
    alg: "RS256",
    kid: "github-envelope-test-key",
    typ: "JWT",
    x5t: X5T,
  },
}) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function makeFixture({
  phaseId = "GOV-00",
  candidateCommit = CANDIDATE,
  candidateTree = TREE,
  scopeBaseCommit = SCOPE_BASE,
  ledgerRevision = 2,
  salt = "a",
} = {}) {
  const jwksRegistry = makeJwks();
  const authorityRegistry = makeAuthority(jwksRegistry.registrySha256);
  const phaseProofRegistrySha256 = digest(`phase-registry:${salt}`);
  const ledgerSha256 = digest(`ledger:${salt}`);
  const qualityReceiptHash = digest(`quality:${salt}`);
  const commandPlanHash = digest(`commands:${salt}`);
  const baselineSnapshotHash = digest(`baseline-snapshot:${salt}`);
  const candidateSnapshotHash = digest(`candidate-snapshot:${salt}`);
  const authoritySetSha256 = digest(`authority-set:${salt}`);
  const primaryRaw = artifact(`primary raw judge:${salt}`);
  const independentRaw = artifact(`independent raw judge:${salt}`);

  const candidate = selfHashReceipt({
    role: "candidate",
    phaseId,
    registrySha256: phaseProofRegistrySha256,
    candidateCommit,
    candidateTree,
    authorityBaselineSnapshotHash: baselineSnapshotHash,
    authoritySnapshot: {
      snapshotHash: candidateSnapshotHash,
      authoritySetSha256,
    },
    rawArtifact: null,
  });
  const rehearsal = selfHashReceipt({
    role: "rehearsal",
    phaseId,
    candidateCommit,
    candidateTree,
    rawArtifact: null,
  });
  const change = selfHashReceipt({
    role: "change",
    phaseId,
    candidateCommit,
    candidateTree,
    rawArtifact: null,
  });
  const promotion = selfHashReceipt({
    role: "promotion",
    phaseId,
    candidateCommit,
    candidateTree,
    rawArtifact: null,
    naturalEvidence: [],
    browserEvidence: [],
  });
  const chain = { candidate, rehearsal, change, promotion };
  const receiptHashes = Object.fromEntries(
    Object.entries(chain).map(([role, receipt]) => [
      role,
      receipt.receiptHash,
    ]),
  );
  const attestationBody = reconstructAttestationBodyFromProofInputs({
    schema: COLLECTOR_PROOF_INPUT_SCHEMA,
    phase: {
      phaseId,
      issuerRegistrySha256: authorityRegistry.authoritySha256,
      ledgerRevision,
      ledgerSha256,
    },
    candidate: {
      commit: candidateCommit,
      tree: candidateTree,
    },
    quality: {
      strictReceiptHash: qualityReceiptHash,
      commandPlanHash,
      primaryRawArtifactHash: primaryRaw.sha256,
      independentRawArtifactHash: independentRaw.sha256,
    },
    receiptHashes,
  });

  const artifacts = [
    primaryRaw,
    independentRaw,
    ...Object.values(chain).map(receiptArtifact),
  ].sort((left, right) => left.address.localeCompare(right.address));
  const proofBundle = {
    schema: CORE_PHASE_PROOF_SCHEMA,
    phaseId,
    ledgerRevision,
    candidateCommit,
    qualityReceiptHash,
    chain,
    artifacts,
    bundleHash: "0".repeat(64),
  };
  rehashBundle(proofBundle);

  const payload = makeJwtPayload({
    body: attestationBody,
    candidateCommit,
    scopeBaseCommit,
  });
  const oidcToken = signJwt({ payload });
  const requestedAt = new Date(FIXED_IAT * 1000).toISOString();
  const receivedAt = new Date((FIXED_IAT + 1) * 1000).toISOString();
  const collectorReceipt = buildGithubOidcCollectorReceipt({
    body: attestationBody,
    scopeBaseCommit,
    jwksRegistrySha256: jwksRegistry.registrySha256,
    oidcToken,
    requestedAt,
    receivedAt,
  });
  const collectorBytes = Buffer.from(stableJson(collectorReceipt));
  const replayKey = `${GITHUB_OIDC_ISSUER}:${JTI}`;
  const externalCertification = {
    schema: FROZEN_CERTIFICATION_SCHEMA,
    phaseId,
    scopeBaseCommit,
    candidateCommit,
    candidateTree,
    ledgerRevision,
    ledgerSha256,
    phaseProofRegistrySha256,
    attestationAuthoritySha256: authorityRegistry.authoritySha256,
    jwksRegistrySha256: jwksRegistry.registrySha256,
    baselineAuthoritySnapshotHash: baselineSnapshotHash,
    candidateAuthoritySnapshotHash: candidateSnapshotHash,
    authoritySetSha256,
    strictQualityReceiptHash: qualityReceiptHash,
    phaseProofBundleHash: proofBundle.bundleHash,
    receiptHashes,
    attestationBody,
    attestationBodySha256: sha256(stableJson(attestationBody)),
    githubRun: {
      schema: GITHUB_RUN_SCHEMA,
      eventName: "workflow_call",
      runId: "80001",
      runNumber: "41",
      runAttempt: "1",
      checkRunId: "90001",
      repository: EXPECTED_REPOSITORY,
      runnerEnvironment: EXPECTED_RUNNER_ENVIRONMENT,
      githubSha: candidateCommit,
    },
    collectorEvidence: {
      schema: COLLECTOR_EVIDENCE_SCHEMA,
      encoding: "base64",
      byteLength: collectorBytes.length,
      rawSha256: sha256(collectorBytes),
      bytes: collectorBytes.toString("base64"),
      receiptHash: collectorReceipt.receiptHash,
    },
    replayProtection: {
      schema: REPLAY_PROTECTION_SCHEMA,
      replayKey,
      replayKeySha256: sha256(replayKey),
      consumptionScope: "single-controller-local-runtime",
      multiHostSafe: false,
    },
    verifiedAt: receivedAt,
    certificationHash: "0".repeat(64),
  };
  rehashCertification(externalCertification);
  const envelope = assemblePhaseProofEnvelope({
    proofBundle,
    externalCertification,
  });
  const expected = {
    phaseId,
    scopeBaseCommit,
    candidateCommit,
    candidateTree,
    ledgerRevision,
    ledgerSha256,
    phaseProofRegistrySha256,
    strictQualityReceiptHash: qualityReceiptHash,
    coreBundleHash: proofBundle.bundleHash,
  };
  return {
    authorityRegistry,
    expectedAuthoritySha256: authorityRegistry.authoritySha256,
    jwksRegistry,
    expectedJwksRegistrySha256: jwksRegistry.registrySha256,
    expected,
    envelope,
    proofBundle,
    externalCertification,
    attestationBody,
    collectorReceipt,
    payload,
    primaryRaw,
    independentRaw,
  };
}

function validationInput(fixture) {
  return {
    envelope: fixture.envelope,
    authorityRegistry: fixture.authorityRegistry,
    expectedAuthoritySha256: fixture.expectedAuthoritySha256,
    jwksRegistry: fixture.jwksRegistry,
    expectedJwksRegistrySha256: fixture.expectedJwksRegistrySha256,
    expected: fixture.expected,
    nowMs: FIXED_NOW,
  };
}

function validate(fixture) {
  return validatePhaseProofEnvelope(validationInput(fixture));
}

function expectCode(code, callback, cause) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof PhaseProofEnvelopeError, true);
    assert.equal(error.code, code);
    if (cause !== undefined) assert.equal(error.details.cause, cause);
    return true;
  });
}

function mutateCertification(fixture, callback) {
  callback(fixture.envelope.externalCertification);
  rehashCertification(fixture.envelope.externalCertification);
  rehashEnvelope(fixture.envelope);
}

function syncBundleContainerIdentity(fixture) {
  rehashBundle(fixture.envelope.proofBundle);
  fixture.expected.coreBundleHash = fixture.envelope.proofBundle.bundleHash;
  fixture.envelope.externalCertification.phaseProofBundleHash =
    fixture.expected.coreBundleHash;
  rehashCertification(fixture.envelope.externalCertification);
  rehashEnvelope(fixture.envelope);
}

function replaceCollectorReceipt(fixture, payloadOverrides, options = {}) {
  const certification = fixture.envelope.externalCertification;
  const body = certification.attestationBody;
  const payload = makeJwtPayload({
    body,
    candidateCommit: fixture.expected.candidateCommit,
    scopeBaseCommit: fixture.expected.scopeBaseCommit,
    overrides: payloadOverrides,
  });
  const token = signJwt({
    payload,
    privateKey: options.privateKey || signingKeys.privateKey,
    header: options.header || {
      alg: "RS256",
      kid: "github-envelope-test-key",
      typ: "JWT",
      x5t: X5T,
    },
  });
  const receipt = buildGithubOidcCollectorReceipt({
    body,
    scopeBaseCommit: fixture.expected.scopeBaseCommit,
    jwksRegistrySha256: fixture.expectedJwksRegistrySha256,
    oidcToken: token,
    requestedAt: new Date(FIXED_IAT * 1000).toISOString(),
    receivedAt: new Date((FIXED_IAT + 1) * 1000).toISOString(),
  });
  const bytes = Buffer.from(stableJson(receipt));
  certification.collectorEvidence = {
    schema: COLLECTOR_EVIDENCE_SCHEMA,
    encoding: "base64",
    byteLength: bytes.length,
    rawSha256: sha256(bytes),
    bytes: bytes.toString("base64"),
    receiptHash: receipt.receiptHash,
  };
  rehashCertification(certification);
  rehashEnvelope(fixture.envelope);
}

describe("phase proof envelope positive external authority", () => {
  test("schema constants and conservative bounds are frozen", () => {
    assert.equal(PHASE_PROOF_ENVELOPE_SCHEMA, "pikiio-phase-proof-envelope-v2");
    assert.equal(CORE_PHASE_PROOF_SCHEMA, "pikiio-phase-proof-bundle-v1");
    assert.equal(
      FROZEN_CERTIFICATION_SCHEMA,
      "pikiio-frozen-authority-verification-receipt-v1",
    );
    assert.equal(
      ATTESTATION_AUTHORITY_SCHEMA,
      "pikiio-phase-attestation-authority-registry-v1",
    );
    assert.equal(
      COLLECTOR_EVIDENCE_SCHEMA,
      "pikiio-embedded-github-oidc-collector-receipt-v1",
    );
    assert.equal(
      REPLAY_PROTECTION_SCHEMA,
      "pikiio-frozen-authority-replay-protection-v1",
    );
    assert.equal(GITHUB_RUN_SCHEMA, "pikiio-github-run-context-v1");
    assert.equal(MAX_ENVELOPE_BYTES, 66 * 1024 * 1024);
    assert.equal(MAX_CORE_BUNDLE_BYTES, 64 * 1024 * 1024);
    assert.equal(MAX_CERTIFICATION_BYTES, 256 * 1024);
    assert.equal(MAX_COLLECTOR_RECEIPT_BYTES, 64 * 1024);
  });

  test("valid envelope proves exact external certification without consuming replay", () => {
    const fixture = makeFixture();
    const before = stableJson(validationInput(fixture));
    const result = validate(fixture);
    assert.equal(result.valid, true);
    assert.equal(result.externallyCertified, true);
    assert.equal(result.replayConsumed, false);
    assert.equal(result.phaseId, fixture.expected.phaseId);
    assert.equal(result.candidateCommit, fixture.expected.candidateCommit);
    assert.equal(result.candidateTree, fixture.expected.candidateTree);
    assert.equal(result.envelopeHash, fixture.envelope.envelopeHash);
    assert.equal(result.coreBundleHash, fixture.proofBundle.bundleHash);
    assert.equal(
      result.certificationHash,
      fixture.externalCertification.certificationHash,
    );
    assert.equal(
      result.collectorReceiptHash,
      fixture.collectorReceipt.receiptHash,
    );
    assert.equal(stableJson(validationInput(fixture)), before);
    assert.deepEqual(validate(fixture), result);
  });

  test("assembly clones both inputs and content-addresses the exact envelope", () => {
    const fixture = makeFixture();
    const assembled = assemblePhaseProofEnvelope({
      proofBundle: fixture.proofBundle,
      externalCertification: fixture.externalCertification,
    });
    fixture.proofBundle.phaseId = "TRUTH-01";
    fixture.externalCertification.phaseId = "TRUTH-01";
    assert.equal(assembled.proofBundle.phaseId, "GOV-00");
    assert.equal(assembled.externalCertification.phaseId, "GOV-00");
    assert.equal(
      assembled.envelopeHash,
      withoutFieldHash(assembled, "envelopeHash"),
    );
  });

  test("the immutable workflow tag and scope-base SHA are separate bindings", () => {
    const fixture = makeFixture();
    assert.equal(
      fixture.collectorReceipt.reusableWorkflowRef,
      `${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_REF}`,
    );
    assert.equal(
      fixture.collectorReceipt.scopeBaseCommit,
      fixture.expected.scopeBaseCommit,
    );
    assert.equal(validate(fixture).valid, true);
  });
});

describe("phase proof envelope refuses substitution and rehashing", () => {
  test("swapped certification and core proof are rejected", () => {
    const left = makeFixture({ salt: "left" });
    const right = makeFixture({
      salt: "right",
      candidateCommit: "d".repeat(40),
      candidateTree: "e".repeat(40),
    });
    left.envelope.externalCertification = clone(
      right.envelope.externalCertification,
    );
    rehashEnvelope(left.envelope);
    expectCode("SIGNED_RAW_ARTIFACT_MISSING", () => validate(left));
  });

  test("a rehashed attestation-field change cannot reuse the OIDC proof", () => {
    const fixture = makeFixture();
    mutateCertification(fixture, (certification) => {
      certification.attestationBody.commandPlanHash = digest("substituted");
      certification.attestationBodySha256 = sha256(
        stableJson(certification.attestationBody),
      );
    });
    expectCode(
      "COLLECTOR_RECEIPT_INVALID",
      () => validate(fixture),
      "RECEIPT_BINDING_MISMATCH",
    );
  });

  test("certification and envelope hashes are independently mandatory", () => {
    const certification = makeFixture();
    certification.envelope.externalCertification.certificationHash =
      "0".repeat(64);
    rehashEnvelope(certification.envelope);
    expectCode("CERTIFICATION_HASH_MISMATCH", () => validate(certification));

    const envelope = makeFixture();
    envelope.envelope.envelopeHash = "0".repeat(64);
    expectCode("ENVELOPE_HASH_MISMATCH", () => validate(envelope));
  });

  test("valid proof from another expected context cannot be replayed", () => {
    for (const [field, replacement] of [
      ["phaseId", "TRUTH-01"],
      ["scopeBaseCommit", "f".repeat(40)],
      ["candidateCommit", "e".repeat(40)],
      ["candidateTree", "d".repeat(40)],
      ["ledgerRevision", 3],
      ["ledgerSha256", digest("other ledger")],
      ["phaseProofRegistrySha256", digest("other registry")],
      ["strictQualityReceiptHash", digest("other quality")],
      ["coreBundleHash", digest("other bundle")],
    ]) {
      const fixture = makeFixture();
      fixture.expected[field] = replacement;
      assert.throws(
        () => validate(fixture),
        (error) =>
          error instanceof PhaseProofEnvelopeError &&
          [
            "CORE_BUNDLE_CONTEXT_MISMATCH",
            "CERTIFICATION_BINDING_MISMATCH",
            "COLLECTOR_RECEIPT_INVALID",
          ].includes(error.code),
        field,
      );
    }
  });

  test("envelope, certification, and core bundle permit no extra fields", () => {
    for (const target of [
      (fixture) => fixture.envelope,
      (fixture) => fixture.envelope.externalCertification,
      (fixture) => fixture.envelope.proofBundle,
    ]) {
      const fixture = makeFixture();
      target(fixture).unexpected = true;
      if (target(fixture) !== fixture.envelope) {
        if (target(fixture) === fixture.envelope.externalCertification) {
          rehashCertification(target(fixture));
        } else {
          rehashBundle(target(fixture));
          fixture.expected.coreBundleHash = target(fixture).bundleHash;
          fixture.envelope.externalCertification.phaseProofBundleHash =
            target(fixture).bundleHash;
          rehashCertification(fixture.envelope.externalCertification);
        }
      }
      rehashEnvelope(fixture.envelope);
      expectCode("UNEXPECTED_FIELDS", () => validate(fixture));
    }
  });
});

describe("embedded GitHub OIDC is cryptographically and contextually exact", () => {
  for (const [name, overrides] of [
    ["issuer", { iss: "https://attacker.invalid" }],
    ["audience", { aud: "pikiio-proof:" + "0".repeat(64) }],
    [
      "reusable workflow",
      {
        job_workflow_ref:
          `${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@attacker-tag`,
      },
    ],
    ["scope-base workflow SHA", { job_workflow_sha: "f".repeat(40) }],
    ["candidate SHA", { sha: "e".repeat(40) }],
    ["caller workflow SHA", { workflow_sha: "e".repeat(40) }],
    ["repository", { repository: "attacker/Pikiio-app-" }],
    ["runner environment", { runner_environment: "self-hosted" }],
  ]) {
    test(`wrong signed ${name} is rejected`, () => {
      const fixture = makeFixture();
      replaceCollectorReceipt(fixture, overrides);
      expectCode(
        "COLLECTOR_RECEIPT_INVALID",
        () => validate(fixture),
        "OIDC_IDENTITY_MISMATCH",
      );
    });
  }

  test("valid-looking token signed by an unpinned key is rejected", () => {
    const fixture = makeFixture();
    replaceCollectorReceipt(
      fixture,
      {},
      { privateKey: attackerKeys.privateKey },
    );
    expectCode(
      "COLLECTOR_RECEIPT_INVALID",
      () => validate(fixture),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  test("unpinned key ID and non-RS256 header are rejected", () => {
    for (const header of [
      {
        alg: "RS256",
        kid: "attacker-key",
        typ: "JWT",
        x5t: X5T,
      },
      {
        alg: "RS512",
        kid: "github-envelope-test-key",
        typ: "JWT",
        x5t: X5T,
      },
    ]) {
      const fixture = makeFixture();
      replaceCollectorReceipt(fixture, {}, { header });
      expectCode("COLLECTOR_RECEIPT_INVALID", () => validate(fixture));
    }
  });

  test("GitHub run projection cannot be changed independently of the token", () => {
    for (const [field, value] of [
      ["eventName", "workflow_dispatch"],
      ["runId", "80002"],
      ["runNumber", "42"],
      ["runAttempt", "2"],
      ["checkRunId", "90002"],
      ["repository", "attacker/Pikiio-app-"],
      ["runnerEnvironment", "self-hosted"],
      ["githubSha", "e".repeat(40)],
    ]) {
      const fixture = makeFixture();
      mutateCertification(fixture, (certification) => {
        certification.githubRun[field] = value;
      });
      assert.throws(
        () => validate(fixture),
        (error) =>
          error instanceof PhaseProofEnvelopeError &&
          [
            "GITHUB_RUN_CONTEXT_INVALID",
            "COLLECTOR_RECEIPT_INVALID",
          ].includes(error.code),
        field,
      );
    }
  });

  test("collector raw bytes and their internal receipt hash are inseparable", () => {
    const missing = makeFixture();
    mutateCertification(missing, (certification) => {
      delete certification.collectorEvidence.bytes;
    });
    expectCode("UNEXPECTED_FIELDS", () => validate(missing));

    const empty = makeFixture();
    mutateCertification(empty, (certification) => {
      certification.collectorEvidence.bytes = "";
      certification.collectorEvidence.byteLength = 0;
      certification.collectorEvidence.rawSha256 = sha256(Buffer.alloc(0));
    });
    expectCode("COLLECTOR_EVIDENCE_INVALID", () => validate(empty));

    const changed = makeFixture();
    mutateCertification(changed, (certification) => {
      certification.collectorEvidence.rawSha256 = digest("wrong raw");
    });
    expectCode("COLLECTOR_EVIDENCE_HASH_MISMATCH", () => validate(changed));

    const internal = makeFixture();
    const body = Buffer.from(
      stableJson({
        ...internal.collectorReceipt,
        receiptHash: "f".repeat(64),
      }),
    );
    mutateCertification(internal, (certification) => {
      certification.collectorEvidence.bytes = body.toString("base64");
      certification.collectorEvidence.byteLength = body.length;
      certification.collectorEvidence.rawSha256 = sha256(body);
    });
    expectCode(
      "COLLECTOR_EVIDENCE_RECEIPT_MISMATCH",
      () => validate(internal),
    );
  });

  test("collector evidence rejects malformed base64, UTF-8, and JSON", () => {
    const cases = [
      {
        bytes: "***",
        raw: null,
        code: "INVALID_BASE64",
      },
      {
        bytes: Buffer.from([0xff]).toString("base64"),
        raw: Buffer.from([0xff]),
        code: "INVALID_UTF8",
      },
      {
        bytes: Buffer.from("{").toString("base64"),
        raw: Buffer.from("{"),
        code: "INVALID_JSON",
      },
      {
        bytes: Buffer.from("[]").toString("base64"),
        raw: Buffer.from("[]"),
        code: "INVALID_JSON_OBJECT",
      },
    ];
    for (const item of cases) {
      const fixture = makeFixture();
      mutateCertification(fixture, (certification) => {
        certification.collectorEvidence.bytes = item.bytes;
        if (item.raw) {
          certification.collectorEvidence.byteLength = item.raw.length;
          certification.collectorEvidence.rawSha256 = sha256(item.raw);
        }
      });
      expectCode(item.code, () => validate(fixture));
    }
  });
});

describe("core raw evidence and replay metadata fail closed", () => {
  test("signed judge bytes cannot be removed, replaced, or supplemented", () => {
    for (const operation of ["remove", "replace", "extra"]) {
      const fixture = makeFixture();
      const bundle = fixture.envelope.proofBundle;
      const index = bundle.artifacts.findIndex(
        (entry) => entry.sha256 === fixture.primaryRaw.sha256,
      );
      if (operation === "remove") bundle.artifacts.splice(index, 1);
      if (operation === "replace") {
        bundle.artifacts[index] = artifact("forged primary raw");
        bundle.artifacts.sort((left, right) =>
          left.address.localeCompare(right.address),
        );
      }
      if (operation === "extra") {
        bundle.artifacts.push(artifact("unreferenced raw"));
        bundle.artifacts.sort((left, right) =>
          left.address.localeCompare(right.address),
        );
      }
      rehashBundle(bundle);
      fixture.expected.coreBundleHash = bundle.bundleHash;
      fixture.envelope.externalCertification.phaseProofBundleHash =
        bundle.bundleHash;
      rehashCertification(fixture.envelope.externalCertification);
      rehashEnvelope(fixture.envelope);
      assert.throws(
        () => validate(fixture),
        (error) =>
          error instanceof PhaseProofEnvelopeError &&
          [
            "SIGNED_RAW_ARTIFACT_MISSING",
            "CORE_ARTIFACT_SET_MISMATCH",
          ].includes(error.code),
        operation,
      );
    }
  });

  test("receipt raw bytes cannot be detached from the signed receipt hash", () => {
    const fixture = makeFixture();
    const bundle = fixture.envelope.proofBundle;
    const address = `sha256:${bundle.chain.candidate.receiptHash}`;
    const index = bundle.artifacts.findIndex(
      (entry) => entry.address === address,
    );
    bundle.artifacts[index] = artifact("wrong receipt bytes");
    bundle.artifacts.sort((left, right) =>
      left.address.localeCompare(right.address),
    );
    rehashBundle(bundle);
    fixture.expected.coreBundleHash = bundle.bundleHash;
    fixture.envelope.externalCertification.phaseProofBundleHash =
      bundle.bundleHash;
    rehashCertification(fixture.envelope.externalCertification);
    rehashEnvelope(fixture.envelope);
    expectCode("CORE_RECEIPT_ARTIFACT_MISMATCH", () => validate(fixture));
  });

  test("a receipt body cannot be changed behind a reused receipt hash", () => {
    const fixture = makeFixture();
    fixture.envelope.proofBundle.chain.candidate.role = "forged";
    rehashBundle(fixture.envelope.proofBundle);
    fixture.expected.coreBundleHash =
      fixture.envelope.proofBundle.bundleHash;
    fixture.envelope.externalCertification.phaseProofBundleHash =
      fixture.expected.coreBundleHash;
    rehashCertification(fixture.envelope.externalCertification);
    rehashEnvelope(fixture.envelope);
    expectCode("CORE_RECEIPT_HASH_MISMATCH", () => validate(fixture));
  });

  for (const [name, mutate] of [
    [
      "multi-host safety claim",
      (replay) => {
        replay.multiHostSafe = true;
      },
    ],
    [
      "consumption scope",
      (replay) => {
        replay.consumptionScope = "global";
      },
    ],
    [
      "replay key",
      (replay) => {
        replay.replayKey = `${GITHUB_OIDC_ISSUER}:forged`;
        replay.replayKeySha256 = sha256(replay.replayKey);
      },
    ],
    [
      "replay key hash",
      (replay) => {
        replay.replayKeySha256 = digest("forged replay");
      },
    ],
    [
      "replay schema",
      (replay) => {
        replay.schema = "pikiio-frozen-authority-replay-protection-v2";
      },
    ],
  ]) {
    test(`replay metadata weakening (${name}) is rejected`, () => {
      const fixture = makeFixture();
      mutateCertification(fixture, (certification) => {
        mutate(certification.replayProtection);
      });
      expectCode("REPLAY_PROTECTION_INVALID", () => validate(fixture));
    });
  }
});

describe("pinned authority and JWKS cannot be locally weakened", () => {
  test("local collector private-key trust remains categorically false", () => {
    const fixture = makeFixture();
    fixture.authorityRegistry.controller.localCollectorPrivateKeyAllowed = true;
    fixture.authorityRegistry.authoritySha256 = withoutFieldHash(
      fixture.authorityRegistry,
      "authoritySha256",
    );
    fixture.expectedAuthoritySha256 =
      fixture.authorityRegistry.authoritySha256;
    expectCode("ATTESTATION_AUTHORITY_MISMATCH", () => validate(fixture));
  });

  test("authority registry path traversal and workflow substitution fail closed", () => {
    for (const [field, value] of [
      ["jwksRegistryPath", "../keys.json"],
      ["workflowPath", ".github/workflows/attacker.yml"],
      ["workflowRef", "moving-main"],
      ["issuer", "https://attacker.invalid"],
      ["repository", "attacker/Pikiio-app-"],
      ["repositoryVisibility", "public"],
      ["runnerEnvironment", "self-hosted"],
      ["kind", "local_private_key"],
    ]) {
      const fixture = makeFixture();
      fixture.authorityRegistry.collector[field] = value;
      fixture.authorityRegistry.authoritySha256 = withoutFieldHash(
        fixture.authorityRegistry,
        "authoritySha256",
      );
      fixture.expectedAuthoritySha256 =
        fixture.authorityRegistry.authoritySha256;
      expectCode("ATTESTATION_AUTHORITY_MISMATCH", () => validate(fixture));
    }
  });

  test("authority self-hash and independent expected hash are both required", () => {
    const selfHash = makeFixture();
    selfHash.authorityRegistry.authoritySha256 = "0".repeat(64);
    expectCode("ATTESTATION_AUTHORITY_MISMATCH", () => validate(selfHash));

    const pinned = makeFixture();
    pinned.expectedAuthoritySha256 = digest("other authority");
    expectCode("ATTESTATION_AUTHORITY_MISMATCH", () => validate(pinned));
  });

  test("JWKS issuer, key, and independent digest substitution are rejected", () => {
    const issuer = makeFixture();
    issuer.jwksRegistry.issuer = "https://attacker.invalid";
    issuer.jwksRegistry.registrySha256 = oidcHashWithoutField(
      issuer.jwksRegistry,
      "registrySha256",
    );
    issuer.expectedJwksRegistrySha256 =
      issuer.jwksRegistry.registrySha256;
    issuer.authorityRegistry.collector.jwksRegistrySha256 =
      issuer.expectedJwksRegistrySha256;
    issuer.authorityRegistry.authoritySha256 = withoutFieldHash(
      issuer.authorityRegistry,
      "authoritySha256",
    );
    issuer.expectedAuthoritySha256 = issuer.authorityRegistry.authoritySha256;
    expectCode("JWKS_REGISTRY_INVALID", () => validate(issuer));

    const key = makeFixture();
    key.jwksRegistry.keys[0].n = attackerJwk.n;
    key.jwksRegistry.registrySha256 = oidcHashWithoutField(
      key.jwksRegistry,
      "registrySha256",
    );
    key.expectedJwksRegistrySha256 = key.jwksRegistry.registrySha256;
    key.authorityRegistry.collector.jwksRegistrySha256 =
      key.expectedJwksRegistrySha256;
    key.authorityRegistry.authoritySha256 = withoutFieldHash(
      key.authorityRegistry,
      "authoritySha256",
    );
    key.expectedAuthoritySha256 = key.authorityRegistry.authoritySha256;
    const keyReceipt = buildGithubOidcCollectorReceipt({
      body: key.externalCertification.attestationBody,
      scopeBaseCommit: key.expected.scopeBaseCommit,
      jwksRegistrySha256: key.expectedJwksRegistrySha256,
      oidcToken: key.collectorReceipt.oidcToken,
      requestedAt: key.collectorReceipt.requestedAt,
      receivedAt: key.collectorReceipt.receivedAt,
    });
    const keyReceiptBytes = Buffer.from(stableJson(keyReceipt));
    key.envelope.externalCertification.jwksRegistrySha256 =
      key.expectedJwksRegistrySha256;
    key.envelope.externalCertification.collectorEvidence = {
      schema: COLLECTOR_EVIDENCE_SCHEMA,
      encoding: "base64",
      byteLength: keyReceiptBytes.length,
      rawSha256: sha256(keyReceiptBytes),
      bytes: keyReceiptBytes.toString("base64"),
      receiptHash: keyReceipt.receiptHash,
    };
    rehashCertification(key.envelope.externalCertification);
    rehashEnvelope(key.envelope);
    expectCode("CERTIFICATION_BINDING_MISMATCH", () => validate(key));

    const digestMismatch = makeFixture();
    digestMismatch.expectedJwksRegistrySha256 = digest("other jwks");
    expectCode("ATTESTATION_AUTHORITY_MISMATCH", () =>
      validate(digestMismatch),
    );
  });
});

describe("malformed envelope surfaces deterministic refusals", () => {
  test("assembly rejects non-object, cyclic, and oversized inputs", () => {
    expectCode("ENVELOPE_INPUT_INVALID", () =>
      assemblePhaseProofEnvelope({
        proofBundle: [],
        externalCertification: {},
      }),
    );
    const cyclic = {};
    cyclic.self = cyclic;
    expectCode("NON_CANONICAL_JSON", () =>
      assemblePhaseProofEnvelope({
        proofBundle: cyclic,
        externalCertification: {},
      }),
    );
    const oversized = { bytes: "x".repeat(MAX_CERTIFICATION_BYTES + 1) };
    expectCode("SIZE_LIMIT_EXCEEDED", () =>
      assemblePhaseProofEnvelope({
        proofBundle: {},
        externalCertification: oversized,
      }),
    );
  });

  test("expected context validates every exact scalar", () => {
    const cases = [
      ["phaseId", "bad"],
      ["scopeBaseCommit", "short"],
      ["candidateCommit", "short"],
      ["candidateTree", "short"],
      ["ledgerRevision", 0],
      ["ledgerSha256", "bad"],
      ["phaseProofRegistrySha256", "bad"],
      ["strictQualityReceiptHash", "bad"],
      ["coreBundleHash", "bad"],
    ];
    for (const [field, value] of cases) {
      const fixture = makeFixture();
      fixture.expected[field] = value;
      assert.throws(
        () => validate(fixture),
        (error) => error instanceof PhaseProofEnvelopeError,
        field,
      );
    }
    const extra = makeFixture();
    extra.expected.extra = true;
    expectCode("UNEXPECTED_FIELDS", () => validate(extra));
  });

  test("invalid now, phase schema, chain shape, and bundle identity fail closed", () => {
    const now = makeFixture();
    const input = validationInput(now);
    input.nowMs = -1;
    expectCode("INVALID_NOW", () => validatePhaseProofEnvelope(input));

    const schema = makeFixture();
    schema.envelope.schema = "pikiio-phase-proof-envelope-v1";
    rehashEnvelope(schema.envelope);
    expectCode("ENVELOPE_SCHEMA_INVALID", () => validate(schema));

    const bundleSchema = makeFixture();
    bundleSchema.envelope.proofBundle.schema =
      "pikiio-phase-proof-bundle-v2";
    rehashBundle(bundleSchema.envelope.proofBundle);
    bundleSchema.expected.coreBundleHash =
      bundleSchema.envelope.proofBundle.bundleHash;
    bundleSchema.envelope.externalCertification.phaseProofBundleHash =
      bundleSchema.expected.coreBundleHash;
    rehashCertification(bundleSchema.envelope.externalCertification);
    rehashEnvelope(bundleSchema.envelope);
    expectCode("CORE_BUNDLE_SCHEMA_INVALID", () => validate(bundleSchema));

    const chain = makeFixture();
    delete chain.envelope.proofBundle.chain.change;
    rehashBundle(chain.envelope.proofBundle);
    chain.expected.coreBundleHash = chain.envelope.proofBundle.bundleHash;
    chain.envelope.externalCertification.phaseProofBundleHash =
      chain.expected.coreBundleHash;
    rehashCertification(chain.envelope.externalCertification);
    rehashEnvelope(chain.envelope);
    expectCode("UNEXPECTED_FIELDS", () => validate(chain));
  });

  test("artifact identity, order, encoding, hash, and aggregate contract refuse", () => {
    for (const [name, mutate, codes] of [
      [
        "order",
        (bundle) => bundle.artifacts.reverse(),
        ["CORE_ARTIFACT_INVALID"],
      ],
      [
        "encoding",
        (bundle) => {
          bundle.artifacts[0].encoding = "hex";
        },
        ["CORE_ARTIFACT_INVALID"],
      ],
      [
        "address",
        (bundle) => {
          bundle.artifacts[0].address = `sha256:${"f".repeat(64)}`;
        },
        ["CORE_ARTIFACT_INVALID"],
      ],
      [
        "base64",
        (bundle) => {
          bundle.artifacts[0].bytes = "***";
        },
        ["INVALID_BASE64"],
      ],
      [
        "hash",
        (bundle) => {
          bundle.artifacts[0].sha256 = "f".repeat(64);
          bundle.artifacts[0].address = `sha256:${"f".repeat(64)}`;
        },
        ["CORE_ARTIFACT_HASH_MISMATCH"],
      ],
      [
        "extra field",
        (bundle) => {
          bundle.artifacts[0].path = "/tmp/forged";
        },
        ["UNEXPECTED_FIELDS"],
      ],
    ]) {
      const fixture = makeFixture();
      mutate(fixture.envelope.proofBundle);
      rehashBundle(fixture.envelope.proofBundle);
      fixture.expected.coreBundleHash =
        fixture.envelope.proofBundle.bundleHash;
      fixture.envelope.externalCertification.phaseProofBundleHash =
        fixture.expected.coreBundleHash;
      rehashCertification(fixture.envelope.externalCertification);
      rehashEnvelope(fixture.envelope);
      assert.throws(
        () => validate(fixture),
        (error) =>
          error instanceof PhaseProofEnvelopeError &&
          codes.includes(error.code),
        name,
      );
    }
  });

  test("authority, certification, and replay nested objects require exact fields", () => {
    for (const path of [
      ["authorityRegistry", "controller"],
      ["authorityRegistry", "collector"],
      ["envelope", "externalCertification", "receiptHashes"],
      ["envelope", "externalCertification", "githubRun"],
      ["envelope", "externalCertification", "collectorEvidence"],
      ["envelope", "externalCertification", "replayProtection"],
    ]) {
      const fixture = makeFixture();
      let target = fixture;
      for (const key of path) target = target[key];
      target.extra = true;
      if (path[0] === "authorityRegistry") {
        fixture.authorityRegistry.authoritySha256 = withoutFieldHash(
          fixture.authorityRegistry,
          "authoritySha256",
        );
        fixture.expectedAuthoritySha256 =
          fixture.authorityRegistry.authoritySha256;
      } else {
        rehashCertification(fixture.envelope.externalCertification);
        rehashEnvelope(fixture.envelope);
      }
      expectCode("UNEXPECTED_FIELDS", () => validate(fixture));
    }
  });

  test("non-canonical certification timestamps and run numbers are refused", () => {
    const timestamp = makeFixture();
    mutateCertification(timestamp, (certification) => {
      certification.verifiedAt = "2026-01-01";
    });
    expectCode("INVALID_TIMESTAMP", () => validate(timestamp));

    const detachedTimestamp = makeFixture();
    mutateCertification(detachedTimestamp, (certification) => {
      certification.verifiedAt = new Date(
        (FIXED_IAT + 2) * 1000,
      ).toISOString();
    });
    expectCode("COLLECTOR_RESULT_BINDING_MISMATCH", () =>
      validate(detachedTimestamp),
    );

    for (const [field, value] of [
      ["eventName", ""],
      ["runId", "01"],
      ["runNumber", "-1"],
      ["runAttempt", "x"],
      ["checkRunId", ""],
    ]) {
      const fixture = makeFixture();
      mutateCertification(fixture, (certification) => {
        certification.githubRun[field] = value;
      });
      expectCode("GITHUB_RUN_CONTEXT_INVALID", () => validate(fixture));
    }
  });

  test("uncovered malformed core and certification branches stay fail-closed", () => {
    const timestampType = makeFixture();
    mutateCertification(timestampType, (certification) => {
      certification.verifiedAt = null;
    });
    expectCode("INVALID_TIMESTAMP", () => validate(timestampType));

    const noArtifacts = makeFixture();
    noArtifacts.envelope.proofBundle.artifacts = [];
    syncBundleContainerIdentity(noArtifacts);
    expectCode("CORE_ARTIFACT_SET_INVALID", () => validate(noArtifacts));

    const chainObject = makeFixture();
    chainObject.envelope.proofBundle.chain.change = null;
    syncBundleContainerIdentity(chainObject);
    expectCode("CORE_CHAIN_INVALID", () => validate(chainObject));

    const bundleHash = makeFixture();
    bundleHash.envelope.proofBundle.bundleHash = "0".repeat(64);
    rehashEnvelope(bundleHash.envelope);
    expectCode("CORE_BUNDLE_HASH_MISMATCH", () => validate(bundleHash));

    const bundleLedger = makeFixture();
    bundleLedger.envelope.proofBundle.ledgerRevision = 0;
    syncBundleContainerIdentity(bundleLedger);
    expectCode("INVALID_LEDGER_REVISION", () => validate(bundleLedger));

    const certificationSchema = makeFixture();
    mutateCertification(certificationSchema, (certification) => {
      certification.schema =
        "pikiio-frozen-authority-verification-receipt-v2";
    });
    expectCode("CERTIFICATION_SCHEMA_INVALID", () =>
      validate(certificationSchema),
    );

    const certificationLedger = makeFixture();
    mutateCertification(certificationLedger, (certification) => {
      certification.ledgerRevision = 0;
    });
    expectCode("INVALID_LEDGER_REVISION", () =>
      validate(certificationLedger),
    );

    const missingSnapshot = makeFixture();
    missingSnapshot.envelope.proofBundle.chain.candidate.authoritySnapshot =
      null;
    missingSnapshot.envelope.proofBundle.chain.candidate.receiptHash =
      withoutFieldHash(
        missingSnapshot.envelope.proofBundle.chain.candidate,
        "receiptHash",
      );
    syncBundleContainerIdentity(missingSnapshot);
    expectCode("CORE_AUTHORITY_BINDING_MISSING", () =>
      validate(missingSnapshot),
    );
  });

  test("malformed nested raw-evidence declarations refuse before receipt use", () => {
    const rawReference = makeFixture();
    rawReference.envelope.proofBundle.chain.candidate.rawArtifact = {
      address: "../escape",
      sha256: "f".repeat(64),
    };
    rawReference.envelope.proofBundle.chain.candidate.receiptHash =
      withoutFieldHash(
        rawReference.envelope.proofBundle.chain.candidate,
        "receiptHash",
      );
    syncBundleContainerIdentity(rawReference);
    expectCode("RAW_ARTIFACT_REFERENCE_INVALID", () =>
      validate(rawReference),
    );

    const evidenceArray = makeFixture();
    evidenceArray.envelope.proofBundle.chain.promotion.naturalEvidence = {};
    evidenceArray.envelope.proofBundle.chain.promotion.receiptHash =
      withoutFieldHash(
        evidenceArray.envelope.proofBundle.chain.promotion,
        "receiptHash",
      );
    syncBundleContainerIdentity(evidenceArray);
    expectCode("CORE_CHAIN_INVALID", () => validate(evidenceArray));

    const evidenceObject = makeFixture();
    evidenceObject.envelope.proofBundle.chain.promotion.browserEvidence = [
      null,
    ];
    evidenceObject.envelope.proofBundle.chain.promotion.receiptHash =
      withoutFieldHash(
        evidenceObject.envelope.proofBundle.chain.promotion,
        "receiptHash",
      );
    syncBundleContainerIdentity(evidenceObject);
    expectCode("CORE_CHAIN_INVALID", () => validate(evidenceObject));
  });
});

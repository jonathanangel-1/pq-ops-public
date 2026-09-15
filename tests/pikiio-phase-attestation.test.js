"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  ATTESTATION_BODY_SCHEMA,
  DUAL_ATTESTATION_SCHEMA,
  ISSUER_REGISTRY_SCHEMA,
  MAX_ATTESTATION_BYTES,
  MAX_BODY_BYTES,
  MAX_REGISTRY_BYTES,
  PhaseAttestationError,
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
} = require("../lib/pikiio-phase-attestation");

const controllerKeys = crypto.generateKeyPairSync("ed25519");
const collectorKeys = crypto.generateKeyPairSync("ed25519");
const attackerKeys = crypto.generateKeyPairSync("ed25519");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hash(character) {
  return character.repeat(64);
}

function artifact(character) {
  const digest = hash(character);
  return { address: `sha256:${digest}`, sha256: digest };
}

function makeRegistry() {
  return {
    schema: ISSUER_REGISTRY_SCHEMA,
    revision: 1,
    issuers: {
      controller: buildIssuerRecord({
        role: "controller",
        issuerId: "controller-primary",
        publicKey: controllerKeys.publicKey,
      }),
      collector: buildIssuerRecord({
        role: "collector",
        issuerId: "collector-independent",
        publicKey: collectorKeys.publicKey,
      }),
    },
  };
}

function makeBody(overrides = {}) {
  const registry = makeRegistry();
  return buildAttestationBody({
    phaseId: "TRUTH-01",
    issuerRegistrySha256: sha256(stableJson(registry)),
    ledgerRevision: 7,
    ledgerSha256: hash("a"),
    candidateCommit: "b".repeat(40),
    candidateTree: "c".repeat(40),
    strictQualityReceiptHash: hash("d"),
    commandPlanHash: hash("e"),
    primaryRawArtifactHash: hash("f"),
    independentRawArtifactHash: hash("1"),
    receiptHashes: {
      candidate: hash("2"),
      rehearsal: hash("3"),
      change: hash("4"),
      promotion: hash("5"),
    },
    artifacts: {
      primaryRaw: artifact("f"),
      independentRaw: artifact("1"),
      candidateReceipt: artifact("2"),
      rehearsalReceipt: artifact("3"),
      changeReceipt: artifact("4"),
      promotionReceipt: artifact("5"),
    },
    ...overrides,
  });
}

function makeFixture(body = makeBody(), registry = makeRegistry()) {
  const controllerSignature = signAttestationBody({
    body,
    registry,
    role: "controller",
    issuerId: registry.issuers.controller.issuerId,
    privateKey: controllerKeys.privateKey,
  });
  const collectorSignature = signAttestationBody({
    body,
    registry,
    role: "collector",
    issuerId: registry.issuers.collector.issuerId,
    privateKey: collectorKeys.privateKey,
  });
  const attestation = assembleDualAttestation({
    body,
    controllerSignature,
    collectorSignature,
  });
  return { registry, body, attestation };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof PhaseAttestationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function rehashIssuer(issuer) {
  issuer.identitySha256 = sha256(
    stableJson({
      role: issuer.role,
      issuerId: issuer.issuerId,
      keyAlgorithm: issuer.keyAlgorithm,
      publicKeySpkiBase64: issuer.publicKeySpkiBase64,
      publicKeySha256: issuer.publicKeySha256,
    }),
  );
}

describe("phase attestation positive contract", () => {
  test("schema constants are versioned and exact", () => {
    assert.equal(
      ISSUER_REGISTRY_SCHEMA,
      "pikiio-phase-attestation-issuer-registry-v1",
    );
    assert.equal(ATTESTATION_BODY_SCHEMA, "pikiio-phase-attestation-body-v1");
    assert.equal(DUAL_ATTESTATION_SCHEMA, "pikiio-phase-dual-attestation-v1");
  });

  test("issuer records pin canonical Ed25519 SPKI bytes", () => {
    const record = buildIssuerRecord({
      role: "controller",
      issuerId: "controller-primary",
      publicKey: controllerKeys.publicKey,
    });
    assert.equal(record.keyAlgorithm, "Ed25519");
    assert.equal(
      record.publicKeySha256,
      sha256(Buffer.from(record.publicKeySpkiBase64, "base64")),
    );
    assert.match(record.identitySha256, /^[a-f0-9]{64}$/);
  });

  test("valid issuer registry returns its content hash and identities", () => {
    const registry = makeRegistry();
    const result = validateIssuerRegistry(registry);
    assert.equal(result.registrySha256, sha256(stableJson(registry)));
    assert.equal(result.controllerIssuerId, "controller-primary");
    assert.equal(result.collectorIssuerId, "collector-independent");
  });

  test("body builder canonicalizes key order and binds all artifacts", () => {
    const body = makeBody();
    assert.equal(Object.keys(body)[0], "artifacts");
    assert.equal(body.schema, ATTESTATION_BODY_SCHEMA);
    assert.equal(validateAttestationBody(body).bodySha256, sha256(stableJson(body)));
  });

  test("both pinned issuers validate one identical canonical body", () => {
    const fixture = makeFixture();
    const result = validateDualSignatures(fixture);
    assert.equal(result.valid, true);
    assert.equal(result.phaseId, "TRUTH-01");
    assert.equal(result.ledgerRevision, 7);
  });

  test("contextual validation requires and matches the expected body", () => {
    const fixture = makeFixture();
    const result = validateDualAttestation({
      ...fixture,
      expectedBody: clone(fixture.body),
    });
    assert.equal(result.bodySha256, fixture.attestation.bodySha256);
  });

  test("stable JSON makes object insertion order irrelevant", () => {
    assert.equal(
      stableJson({ z: 1, a: { y: 2, b: 3 } }),
      stableJson({ a: { b: 3, y: 2 }, z: 1 }),
    );
  });

  test("limits are explicit and bounded", () => {
    assert.equal(MAX_REGISTRY_BYTES, 32768);
    assert.equal(MAX_BODY_BYTES, 65536);
    assert.equal(MAX_ATTESTATION_BYTES, 131072);
  });
});

describe("issuer registry refuses malformed or colliding authority", () => {
  test("registry extra fields are refused", () => {
    const registry = makeRegistry();
    registry.extra = true;
    expectCode("UNEXPECTED_FIELDS", () => validateIssuerRegistry(registry));
  });

  test("registry schema is exact", () => {
    const registry = makeRegistry();
    registry.schema = "pikiio-phase-attestation-issuer-registry-v2";
    expectCode("INVALID_REGISTRY", () => validateIssuerRegistry(registry));
  });

  test("registry revision is exact", () => {
    const registry = makeRegistry();
    registry.revision = 2;
    expectCode("INVALID_REGISTRY", () => validateIssuerRegistry(registry));
  });

  test("issuer entries permit no extra fields", () => {
    const registry = makeRegistry();
    registry.issuers.controller.extra = true;
    expectCode("UNEXPECTED_FIELDS", () => validateIssuerRegistry(registry));
  });

  test("issuer role must match its pinned slot", () => {
    const registry = makeRegistry();
    registry.issuers.controller.role = "collector";
    rehashIssuer(registry.issuers.controller);
    expectCode("ROLE_MISMATCH", () => validateIssuerRegistry(registry));
  });

  test("issuer IDs reject whitespace and unsafe characters", () => {
    const registry = makeRegistry();
    registry.issuers.controller.issuerId = "controller primary";
    rehashIssuer(registry.issuers.controller);
    expectCode("INVALID_ISSUER_ID", () => validateIssuerRegistry(registry));
  });

  test("algorithm substitution is refused", () => {
    const registry = makeRegistry();
    registry.issuers.controller.keyAlgorithm = "ECDSA";
    rehashIssuer(registry.issuers.controller);
    expectCode("INVALID_ALGORITHM", () => validateIssuerRegistry(registry));
  });

  test("malformed public-key base64 is refused", () => {
    const registry = makeRegistry();
    registry.issuers.controller.publicKeySpkiBase64 = "not base64";
    rehashIssuer(registry.issuers.controller);
    expectCode("INVALID_BASE64", () => validateIssuerRegistry(registry));
  });

  test("non-SPKI bytes are refused", () => {
    const registry = makeRegistry();
    registry.issuers.controller.publicKeySpkiBase64 =
      Buffer.from("not-spki").toString("base64");
    rehashIssuer(registry.issuers.controller);
    expectCode("INVALID_PUBLIC_KEY", () => validateIssuerRegistry(registry));
  });

  test("public-key digest tampering is refused", () => {
    const registry = makeRegistry();
    registry.issuers.controller.publicKeySha256 = hash("9");
    rehashIssuer(registry.issuers.controller);
    expectCode("PUBLIC_KEY_HASH_MISMATCH", () =>
      validateIssuerRegistry(registry),
    );
  });

  test("identity digest tampering is refused", () => {
    const registry = makeRegistry();
    registry.issuers.controller.identitySha256 = hash("9");
    expectCode("IDENTITY_HASH_MISMATCH", () =>
      validateIssuerRegistry(registry),
    );
  });

  test("controller and collector issuer IDs must differ", () => {
    const registry = makeRegistry();
    registry.issuers.collector.issuerId =
      registry.issuers.controller.issuerId;
    rehashIssuer(registry.issuers.collector);
    expectCode("ISSUER_IDENTITY_COLLISION", () =>
      validateIssuerRegistry(registry),
    );
  });

  test("controller and collector public keys must differ", () => {
    const registry = makeRegistry();
    registry.issuers.collector = buildIssuerRecord({
      role: "collector",
      issuerId: "collector-independent",
      publicKey: controllerKeys.publicKey,
    });
    expectCode("ISSUER_IDENTITY_COLLISION", () =>
      validateIssuerRegistry(registry),
    );
  });

  test("non-Ed25519 public keys cannot create issuer records", () => {
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    expectCode("INVALID_PUBLIC_KEY", () =>
      buildIssuerRecord({
        role: "controller",
        issuerId: "controller-primary",
        publicKey: rsa.publicKey,
      }),
    );
  });

  test("registry size is bounded before key processing", () => {
    const registry = makeRegistry();
    registry.issuers.controller.issuerId = `x${"a".repeat(MAX_REGISTRY_BYTES)}`;
    expectCode("SIZE_LIMIT_EXCEEDED", () => validateIssuerRegistry(registry));
  });
});

describe("attestation body refuses substitutions and ambiguity", () => {
  test("body requires its exact field set", () => {
    const body = makeBody();
    body.extra = true;
    expectCode("UNEXPECTED_FIELDS", () => validateAttestationBody(body));
  });

  test("body schema cannot be relabeled", () => {
    const body = makeBody();
    body.schema = "pikiio-phase-attestation-body-v2";
    expectCode("INVALID_BODY_SCHEMA", () => validateAttestationBody(body));
  });

  test("phase ID is constrained", () => {
    const body = makeBody();
    body.phaseId = "../TRUTH-01";
    expectCode("INVALID_PHASE_ID", () => validateAttestationBody(body));
  });

  test("ledger revision must be positive and integral", () => {
    const body = makeBody();
    body.ledgerRevision = 0;
    expectCode("INVALID_LEDGER_REVISION", () =>
      validateAttestationBody(body),
    );
  });

  test("candidate commit must be a Git object ID", () => {
    const body = makeBody();
    body.candidateCommit = "b".repeat(39);
    expectCode("INVALID_GIT_OBJECT", () => validateAttestationBody(body));
  });

  test("candidate tree must be a Git object ID", () => {
    const body = makeBody();
    body.candidateTree = "C".repeat(40);
    expectCode("INVALID_GIT_OBJECT", () => validateAttestationBody(body));
  });

  test("all hashes are lowercase SHA-256", () => {
    const body = makeBody();
    body.commandPlanHash = "E".repeat(64);
    expectCode("INVALID_SHA256", () => validateAttestationBody(body));
  });

  test("judge artifacts must be independently produced", () => {
    const body = makeBody();
    body.independentRawArtifactHash = body.primaryRawArtifactHash;
    body.artifacts.independentRaw = clone(body.artifacts.primaryRaw);
    expectCode("JUDGE_ARTIFACT_COLLISION", () =>
      validateAttestationBody(body),
    );
  });

  test("four receipt hashes must be distinct", () => {
    const body = makeBody();
    body.receiptHashes.promotion = body.receiptHashes.change;
    body.artifacts.promotionReceipt = clone(body.artifacts.changeReceipt);
    expectCode("RECEIPT_HASH_COLLISION", () => validateAttestationBody(body));
  });

  test("receipt hash object permits no missing role", () => {
    const body = makeBody();
    delete body.receiptHashes.change;
    expectCode("UNEXPECTED_FIELDS", () => validateAttestationBody(body));
  });

  test("artifact manifest permits no additional role", () => {
    const body = makeBody();
    body.artifacts.unbound = artifact("6");
    expectCode("UNEXPECTED_FIELDS", () => validateAttestationBody(body));
  });

  test("artifact entries permit no metadata smuggling", () => {
    const body = makeBody();
    body.artifacts.primaryRaw.path = "/tmp/proof";
    expectCode("UNEXPECTED_FIELDS", () => validateAttestationBody(body));
  });

  test("artifact address must exactly match its digest", () => {
    const body = makeBody();
    body.artifacts.primaryRaw.address = `sha256:${hash("8")}`;
    expectCode("ARTIFACT_ADDRESS_MISMATCH", () =>
      validateAttestationBody(body),
    );
  });

  test("all artifact addresses must be distinct", () => {
    const body = makeBody();
    body.artifacts.promotionReceipt = clone(body.artifacts.changeReceipt);
    expectCode("ARTIFACT_COLLISION", () => validateAttestationBody(body));
  });

  test("artifact digest must match the explicitly bound proof hash", () => {
    const body = makeBody();
    body.artifacts.primaryRaw = artifact("8");
    expectCode("ARTIFACT_HASH_MISMATCH", () =>
      validateAttestationBody(body),
    );
  });

  test("body size is bounded before semantic parsing", () => {
    const body = makeBody();
    body.phaseId = `A-${"1".repeat(MAX_BODY_BYTES)}`;
    expectCode("SIZE_LIMIT_EXCEEDED", () => validateAttestationBody(body));
  });
});

describe("dual signature validation defeats tampering and impersonation", () => {
  test("contextual validation fails closed without expected body", () => {
    const fixture = makeFixture();
    expectCode("EXPECTED_BODY_REQUIRED", () =>
      validateDualAttestation(fixture),
    );
  });

  test("signer role must exist", () => {
    const fixture = makeFixture();
    expectCode("INVALID_ROLE", () =>
      signAttestationBody({
        body: fixture.body,
        registry: fixture.registry,
        role: "operator",
        issuerId: "operator",
        privateKey: controllerKeys.privateKey,
      }),
    );
  });

  test("signer identity must match the pinned role", () => {
    const fixture = makeFixture();
    expectCode("ISSUER_MISMATCH", () =>
      signAttestationBody({
        body: fixture.body,
        registry: fixture.registry,
        role: "controller",
        issuerId: "collector-independent",
        privateKey: controllerKeys.privateKey,
      }),
    );
  });

  test("signing helper refuses a private key for another identity", () => {
    const fixture = makeFixture();
    expectCode("SIGNING_KEY_MISMATCH", () =>
      signAttestationBody({
        body: fixture.body,
        registry: fixture.registry,
        role: "collector",
        issuerId: "collector-independent",
        privateKey: controllerKeys.privateKey,
      }),
    );
  });

  test("signing helper accepts only private KeyObjects", () => {
    const fixture = makeFixture();
    expectCode("INVALID_PRIVATE_KEY", () =>
      signAttestationBody({
        body: fixture.body,
        registry: fixture.registry,
        role: "controller",
        issuerId: "controller-primary",
        privateKey: "not-a-key",
      }),
    );
  });

  test("signing helper rejects a public key", () => {
    const fixture = makeFixture();
    expectCode("INVALID_PRIVATE_KEY", () =>
      signAttestationBody({
        body: fixture.body,
        registry: fixture.registry,
        role: "controller",
        issuerId: "controller-primary",
        privateKey: controllerKeys.publicKey,
      }),
    );
  });

  test("dual attestation permits no top-level extras", () => {
    const fixture = makeFixture();
    fixture.attestation.extra = true;
    expectCode("UNEXPECTED_FIELDS", () => validateDualSignatures(fixture));
  });

  test("dual attestation schema is exact", () => {
    const fixture = makeFixture();
    fixture.attestation.schema = "pikiio-phase-dual-attestation-v2";
    expectCode("INVALID_ATTESTATION_SCHEMA", () =>
      validateDualSignatures(fixture),
    );
  });

  test("body hash tampering is refused", () => {
    const fixture = makeFixture();
    fixture.attestation.bodySha256 = hash("9");
    expectCode("BODY_HASH_MISMATCH", () => validateDualSignatures(fixture));
  });

  test("body field tampering is refused by the bound body hash", () => {
    const fixture = makeFixture();
    fixture.attestation.body.phaseId = "ACTION-01";
    expectCode("BODY_HASH_MISMATCH", () => validateDualSignatures(fixture));
  });

  test("signature role swapping is refused", () => {
    const fixture = makeFixture();
    const controller = clone(fixture.attestation.signatures.controller);
    fixture.attestation.signatures.controller = clone(
      fixture.attestation.signatures.collector,
    );
    fixture.attestation.signatures.collector = controller;
    expectCode("ROLE_MISMATCH", () => validateDualSignatures(fixture));
  });

  test("signature records permit no extra fields", () => {
    const fixture = makeFixture();
    fixture.attestation.signatures.controller.note = "trusted";
    expectCode("UNEXPECTED_FIELDS", () => validateDualSignatures(fixture));
  });

  test("signature algorithm substitution is refused", () => {
    const fixture = makeFixture();
    fixture.attestation.signatures.controller.algorithm = "Ed448";
    expectCode("INVALID_ALGORITHM", () => validateDualSignatures(fixture));
  });

  test("signature base64 must be canonical", () => {
    const fixture = makeFixture();
    fixture.attestation.signatures.controller.signatureBase64 += "\n";
    expectCode("INVALID_BASE64", () => validateDualSignatures(fixture));
  });

  test("truncated signatures are refused", () => {
    const fixture = makeFixture();
    fixture.attestation.signatures.controller.signatureBase64 =
      Buffer.alloc(63).toString("base64");
    expectCode("INVALID_SIGNATURE", () => validateDualSignatures(fixture));
  });

  test("cryptographically tampered signatures are refused", () => {
    const fixture = makeFixture();
    const bytes = Buffer.from(
      fixture.attestation.signatures.controller.signatureBase64,
      "base64",
    );
    bytes[0] ^= 1;
    fixture.attestation.signatures.controller.signatureBase64 =
      bytes.toString("base64");
    expectCode("SIGNATURE_VERIFICATION_FAILED", () =>
      validateDualSignatures(fixture),
    );
  });

  test("one controller key cannot impersonate the collector", () => {
    const fixture = makeFixture();
    const forged = clone(fixture.attestation.signatures.controller);
    forged.role = "collector";
    forged.issuerId = "collector-independent";
    fixture.attestation.signatures.collector = forged;
    expectCode("SIGNATURE_VERIFICATION_FAILED", () =>
      validateDualSignatures(fixture),
    );
  });

  test("registry key substitution invalidates existing signatures", () => {
    const fixture = makeFixture();
    fixture.registry.issuers.controller = buildIssuerRecord({
      role: "controller",
      issuerId: "controller-primary",
      publicKey: attackerKeys.publicKey,
    });
    expectCode("ISSUER_REGISTRY_HASH_MISMATCH", () =>
      validateDualSignatures(fixture),
    );
  });

  test("signing refuses a body bound to another issuer registry", () => {
    const registry = makeRegistry();
    const body = makeBody();
    body.issuerRegistrySha256 = hash("9");
    expectCode("ISSUER_REGISTRY_HASH_MISMATCH", () =>
      signAttestationBody({
        body,
        registry,
        role: "controller",
        issuerId: "controller-primary",
        privateKey: controllerKeys.privateKey,
      }),
    );
  });

  test("a separately dual-signed wrong body fails expected-body binding", () => {
    const expected = makeBody();
    const wrong = makeBody({
      ledgerRevision: 8,
      ledgerSha256: hash("8"),
    });
    const fixture = makeFixture(wrong);
    expectCode("ATTESTED_BODY_MISMATCH", () =>
      validateDualAttestation({
        ...fixture,
        expectedBody: expected,
      }),
    );
  });

  test("dual attestation total size is bounded", () => {
    const fixture = makeFixture();
    fixture.attestation.signatures.controller.signatureBase64 = "A".repeat(
      MAX_ATTESTATION_BYTES,
    );
    expectCode("SIZE_LIMIT_EXCEEDED", () => validateDualSignatures(fixture));
  });
});

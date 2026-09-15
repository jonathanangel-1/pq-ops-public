"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  AUTHORITY_GIT_REF,
  AUTHORITY_REF,
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
  MAX_SIGNATURE_BYTES,
  REQUEST_WORKFLOW_PATH,
  hashWithoutField,
  sha256,
  stableJson,
  validateCollectorReceiptV3,
  validatePinnedJwksRegistryV3,
  verifyGithubOidcCollectorV3,
} = require("../lib/pikiio-github-oidc-collector-v3");

const signing = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const attacker = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const weak = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicExponent: 0x10001,
});
const publicJwk = signing.publicKey.export({ format: "jwk" });
const attackerJwk = attacker.publicKey.export({ format: "jwk" });
const weakJwk = weak.publicKey.export({ format: "jwk" });
const A = "a".repeat(40);
const S = "b".repeat(40);
const C = "c".repeat(40);
const IAT = 1_784_877_600;
const JTI = "123e4567-e89b-42d3-a456-426614174000";
const KID = "v3-test-key";
const NONCE = sha256("nonce");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registry({ jwk = publicJwk, kid = KID, x5t = null } = {}) {
  const value = {
    schema: "pikiio-github-oidc-jwks-registry-v1",
    revision: 1,
    issuer: GITHUB_OIDC_ISSUER,
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
  value.registrySha256 = hashWithoutField(value, "registrySha256");
  return value;
}

function body() {
  return {
    schema: "pikiio-external-ci-attestation-body-v3",
    authority: { commit: A },
    phase: { scopeBaseCommit: S },
    candidate: { commit: C },
  };
}

function run() {
  return {
    runId: "8192",
    runAttempt: "2",
    requestNonce: NONCE,
  };
}

function audience() {
  return `pikiio-proof-v3:${sha256(stableJson(body()))}`;
}

function payload(overrides = {}) {
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: audience(),
    repository: EXPECTED_REPOSITORY,
    repository_id: EXPECTED_REPOSITORY_ID,
    repository_owner: EXPECTED_REPOSITORY_OWNER,
    repository_owner_id: EXPECTED_REPOSITORY_OWNER_ID,
    repository_visibility: EXPECTED_REPOSITORY_VISIBILITY,
    runner_environment: EXPECTED_RUNNER_ENVIRONMENT,
    event_name: "workflow_dispatch",
    ref: AUTHORITY_GIT_REF,
    ref_type: "tag",
    ref_protected: "true",
    sha: A,
    workflow_ref:
      `${EXPECTED_REPOSITORY}/${REQUEST_WORKFLOW_PATH}@${AUTHORITY_GIT_REF}`,
    workflow_sha: A,
    job_workflow_ref:
      `${EXPECTED_REPOSITORY}/${COLLECTOR_WORKFLOW_PATH}@${AUTHORITY_GIT_REF}`,
    job_workflow_sha: A,
    run_id: run().runId,
    run_attempt: run().runAttempt,
    jti: JTI,
    sub: `repo:${EXPECTED_REPOSITORY}:ref:${AUTHORITY_GIT_REF}`,
    iat: IAT,
    nbf: IAT - 5,
    exp: IAT + 600,
    ...overrides,
  };
}

function token({
  claims = payload(),
  privateKey = signing.privateKey,
  header = { alg: "RS256", kid: KID, typ: "JWT" },
} = {}) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function receipt(overrides = {}) {
  return {
    schema: COLLECTOR_RECEIPT_SCHEMA,
    attestationBodySha256: sha256(stableJson(body())),
    audience: audience(),
    oidcToken: token(),
    authorityCommit: A,
    phaseScopeBaseCommit: S,
    candidateCommit: C,
    run: run(),
    requestedAt: new Date(IAT * 1000).toISOString(),
    receivedAt: new Date((IAT + 1) * 1000).toISOString(),
    productionAuthority: false,
    ...overrides,
  };
}

function replayKey() {
  return sha256(
    stableJson({
      issuer: GITHUB_OIDC_ISSUER,
      jti: JTI,
      repository: EXPECTED_REPOSITORY,
      runId: run().runId,
      runAttempt: run().runAttempt,
    }),
  );
}

function verification(overrides = {}) {
  const pinned = registry();
  return {
    collectorReceipt: receipt(),
    jwksRegistry: pinned,
    expectedAttestationBody: body(),
    expectedAttestationBodySha256: sha256(stableJson(body())),
    expectedAuthorityCommit: A,
    expectedPhaseScopeBaseCommit: S,
    expectedCandidateCommit: C,
    expectedRun: run(),
    expectedIssuer: GITHUB_OIDC_ISSUER,
    expectedJti: JTI,
    expectedReplayKeySha256: replayKey(),
    expectedJwksRegistrySha256: pinned.registrySha256,
    nowMs: (IAT + 2) * 1000,
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof GithubOidcCollectorV3Error, true);
    assert.equal(error.code, code);
    return true;
  });
}

describe("v3 pinned GitHub OIDC verification", () => {
  test("validates a genuine RS256 token synchronously and remains historical", () => {
    for (const days of [0, 1, 30]) {
      const result = verifyGithubOidcCollectorV3({
        ...verification(),
        nowMs: (IAT + 2 + days * 86400) * 1000,
      });
      assert.deepEqual(result, {
        valid: true,
        attestationBodySha256: sha256(stableJson(body())),
        collectorReceiptSha256: sha256(stableJson(receipt())),
        authorityCommit: A,
        phaseScopeBaseCommit: S,
        candidateCommit: C,
        runId: run().runId,
        runAttempt: run().runAttempt,
        requestNonce: NONCE,
        issuer: GITHUB_OIDC_ISSUER,
        jti: JTI,
        replayKeySha256: replayKey(),
        repositoryId: EXPECTED_REPOSITORY_ID,
        repositoryOwnerId: EXPECTED_REPOSITORY_OWNER_ID,
        productionAuthority: false,
      });
      assert.equal(Object.isFrozen(result), true);
    }
  });

  test("registry is exact, hashed, bounded, unique, and cryptographically strong", () => {
    const valid = registry();
    const emptyRegistry = { ...valid, keys: [] };
    emptyRegistry.registrySha256 = hashWithoutField(
      emptyRegistry,
      "registrySha256",
    );
    const oversizedRegistry = {
      ...valid,
      keys: Array.from({ length: 17 }, () => valid.keys[0]),
    };
    oversizedRegistry.registrySha256 = hashWithoutField(
      oversizedRegistry,
      "registrySha256",
    );
    assert.equal(
      validatePinnedJwksRegistryV3(valid, valid.registrySha256),
      valid,
    );
    const cases = [
      [{ ...valid, extra: true }, "UNEXPECTED_FIELDS"],
      [{ ...valid, schema: "v2" }, "INVALID_JWKS_REGISTRY"],
      [{ ...valid, revision: 2 }, "INVALID_JWKS_REGISTRY"],
      [{ ...valid, issuer: "https://attacker.invalid" }, "INVALID_JWKS_REGISTRY"],
      [{ ...valid, registrySha256: "0".repeat(64) }, "JWKS_REGISTRY_MISMATCH"],
      [valid, "JWKS_REGISTRY_MISMATCH", "f".repeat(64)],
      [emptyRegistry, "INVALID_JWKS_REGISTRY"],
      [oversizedRegistry, "INVALID_JWKS_REGISTRY"],
    ];
    for (const [value, code, expected = value.registrySha256] of cases) {
      expectCode(
        () => validatePinnedJwksRegistryV3(value, expected),
        code,
      );
    }
    for (const mutate of [
      (key) => {
        key.kty = "EC";
      },
      (key) => {
        key.alg = "none";
      },
      (key) => {
        key.use = "enc";
      },
      (key) => {
        key.kid = " bad";
      },
      (key) => {
        key.n = "*";
      },
      (key) => {
        key.e = "*";
      },
      (key) => {
        key.x5t = "*";
      },
    ]) {
      const changed = clone(valid);
      mutate(changed.keys[0]);
      changed.registrySha256 = hashWithoutField(changed, "registrySha256");
      expectCode(
        () =>
          validatePinnedJwksRegistryV3(
            changed,
            changed.registrySha256,
          ),
        "INVALID_JWKS_KEY",
      );
    }
    const duplicate = clone(valid);
    duplicate.keys.push(clone(duplicate.keys[0]));
    duplicate.registrySha256 = hashWithoutField(
      duplicate,
      "registrySha256",
    );
    expectCode(
      () =>
        validatePinnedJwksRegistryV3(
          duplicate,
          duplicate.registrySha256,
        ),
      "INVALID_JWKS_KEY",
    );
    const weakRegistry = registry({ jwk: weakJwk });
    expectCode(
      () =>
        validatePinnedJwksRegistryV3(
          weakRegistry,
          weakRegistry.registrySha256,
        ),
      "INVALID_JWKS_KEY",
    );
    const circular = {};
    circular.self = circular;
    expectCode(() => stableJson(circular), "NON_CANONICAL_JSON");
    expectCode(() => stableJson(undefined), "NON_CANONICAL_JSON");
  });

  test("collector receipt is exact and binds A S C run body audience and time", () => {
    const valid = receipt();
    assert.equal(validateCollectorReceiptV3(valid), valid);
    const cases = [
      [{ ...valid, extra: true }, "UNEXPECTED_FIELDS"],
      [{ ...valid, schema: "v2" }, "INVALID_SCHEMA"],
      [{ ...valid, attestationBodySha256: "bad" }, "INVALID_SHA256"],
      [{ ...valid, audience: "wrong" }, "AUDIENCE_MISMATCH"],
      [{ ...valid, oidcToken: "" }, "INVALID_STRING"],
      [{ ...valid, authorityCommit: "bad" }, "INVALID_COMMIT"],
      [{ ...valid, phaseScopeBaseCommit: "bad" }, "INVALID_COMMIT"],
      [{ ...valid, candidateCommit: "bad" }, "INVALID_COMMIT"],
      [{ ...valid, run: { ...valid.run, runId: "-1" } }, "INVALID_RUN"],
      [{ ...valid, run: { ...valid.run, requestNonce: "bad" } }, "INVALID_NONCE"],
      [{ ...valid, requestedAt: "never" }, "INVALID_TIMESTAMP"],
      [
        {
          ...valid,
          receivedAt: new Date((IAT + 31) * 1000).toISOString(),
        },
        "COLLECTION_WINDOW_INVALID",
      ],
      [{ ...valid, productionAuthority: true }, "PRODUCTION_AUTHORITY_FORBIDDEN"],
    ];
    for (const [value, code] of cases) {
      expectCode(() => validateCollectorReceiptV3(value), code);
    }
  });

  test("rejects JWT structural, header, key, and signature attacks", () => {
    const base = verification();
    const validSegments = token().split(".");
    const invalidJson = Buffer.from("{", "utf8").toString("base64url");
    const nullJson = Buffer.from("null", "utf8").toString("base64url");
    for (const [oidcToken, code] of [
      ["not-a-jwt", "INVALID_JWT"],
      ["*.e30.signature", "INVALID_JWT"],
      [[invalidJson, validSegments[1], validSegments[2]].join("."), "INVALID_JWT"],
      [[nullJson, validSegments[1], validSegments[2]].join("."), "INVALID_JWT"],
      [[validSegments[0], invalidJson, validSegments[2]].join("."), "INVALID_JWT"],
      [[validSegments[0], nullJson, validSegments[2]].join("."), "INVALID_JWT"],
      [[validSegments[0], validSegments[1], ""].join("."), "INVALID_JWT"],
      [[validSegments[0], validSegments[1], "*"].join("."), "INVALID_JWT"],
      [[validSegments[0], validSegments[1], "A"].join("."), "INVALID_JWT"],
      [
        [
          validSegments[0],
          validSegments[1],
          "A".repeat(Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 1),
        ].join("."),
        "INVALID_JWT",
      ],
      [
        token({ header: { alg: "none", kid: KID, typ: "JWT" } }),
        "INVALID_JWT_HEADER",
      ],
      [
        token({ header: { alg: "RS256", kid: KID, typ: "JWT", jku: "https://attacker.invalid" } }),
        "INVALID_JWT_HEADER",
      ],
      [
        token({ header: { alg: "RS256", kid: "unknown", typ: "JWT" } }),
        "UNKNOWN_SIGNING_KEY",
      ],
      [
        token({ header: { alg: "RS256", kid: KID, typ: "JWT", x5t: "wrong" } }),
        "SIGNING_KEY_MISMATCH",
      ],
      [
        token({ privateKey: attacker.privateKey }),
        "INVALID_SIGNATURE",
      ],
    ]) {
      expectCode(
        () =>
          verifyGithubOidcCollectorV3({
            ...base,
            collectorReceipt: receipt({ oidcToken }),
          }),
        code,
      );
    }
  });

  test("rejects every identity, run, subject, and token-time substitution", () => {
    const identityCases = [
      ["iss", "https://attacker.invalid"],
      ["aud", "wrong"],
      ["repository", "attacker/repo"],
      ["repository_id", "1"],
      ["repository_owner", "attacker"],
      ["repository_owner_id", "1"],
      ["repository_visibility", "public"],
      ["runner_environment", "self-hosted"],
      ["event_name", "push"],
      ["ref", "refs/heads/main"],
      ["ref_type", "branch"],
      ["ref_protected", "false"],
      ["sha", C],
      ["workflow_ref", "wrong"],
      ["workflow_sha", C],
      ["job_workflow_ref", "wrong"],
      ["job_workflow_sha", S],
      ["run_id", "999"],
      ["run_attempt", "9"],
      ["jti", "123e4567-e89b-42d3-a456-426614174999"],
      ["sub", "repo:attacker/repo:ref:refs/heads/main"],
    ];
    for (const [field, value] of identityCases) {
      expectCode(
        () =>
          verifyGithubOidcCollectorV3({
            ...verification(),
            collectorReceipt: receipt({
              oidcToken: token({ claims: payload({ [field]: value }) }),
            }),
          }),
        "OIDC_IDENTITY_MISMATCH",
      );
    }
    for (const [claims, code] of [
      [payload({ ref_protected: "maybe" }), "OIDC_IDENTITY_MISMATCH"],
      [payload({ exp: IAT }), "INVALID_TOKEN_TIME"],
      [payload({ exp: IAT + 601 }), "INVALID_TOKEN_TIME"],
      [payload({ nbf: IAT + 31 }), "INVALID_TOKEN_TIME"],
      [payload({ nbf: IAT + 100, exp: IAT + 600 }), "INVALID_TOKEN_TIME"],
      [payload({ iat: "now" }), "INVALID_TOKEN_TIME"],
      [
        payload({
          iat: IAT - 1000,
          nbf: IAT - 1005,
          exp: IAT - 400,
        }),
        "TOKEN_NOT_CURRENT",
      ],
      [
        payload({
          iat: IAT + 40,
          nbf: IAT - 5,
          exp: IAT + 600,
        }),
        "COLLECTION_WINDOW_INVALID",
      ],
    ]) {
      expectCode(
        () =>
          verifyGithubOidcCollectorV3({
            ...verification(),
            collectorReceipt: receipt({ oidcToken: token({ claims }) }),
          }),
        code,
      );
    }
  });

  test("rejects caller/body/replay/JWKS substitutions and future evidence", () => {
    const base = verification();
    const cases = [
      [{ ...base, expectedAttestationBody: { changed: true } }, "ATTESTATION_BODY_MISMATCH"],
      [{ ...base, expectedAttestationBodySha256: "0".repeat(64) }, "ATTESTATION_BODY_MISMATCH"],
      [{ ...base, expectedAuthorityCommit: C }, "COLLECTOR_BINDING_MISMATCH"],
      [{ ...base, expectedPhaseScopeBaseCommit: A }, "COLLECTOR_BINDING_MISMATCH"],
      [{ ...base, expectedCandidateCommit: A }, "COLLECTOR_BINDING_MISMATCH"],
      [{ ...base, expectedRun: { ...base.expectedRun, runId: "999" } }, "COLLECTOR_BINDING_MISMATCH"],
      [{ ...base, expectedRun: { ...base.expectedRun, requestNonce: sha256("wrong") } }, "COLLECTOR_BINDING_MISMATCH"],
      [{ ...base, expectedIssuer: "https://attacker.invalid" }, "INVALID_OIDC_ISSUER"],
      [{ ...base, expectedJti: "bad" }, "INVALID_JTI"],
      [{ ...base, expectedReplayKeySha256: sha256("wrong") }, "REPLAY_BINDING_MISMATCH"],
      [{ ...base, expectedJwksRegistrySha256: sha256("wrong") }, "JWKS_REGISTRY_MISMATCH"],
      [
        {
          ...base,
          nowMs: (IAT - 3600) * 1000,
        },
        "FUTURE_EVIDENCE",
      ],
    ];
    for (const [value, code] of cases) {
      expectCode(() => verifyGithubOidcCollectorV3(value), code);
    }
  });
});

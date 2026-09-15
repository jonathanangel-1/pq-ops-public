"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildAttestationBody,
  sha256,
  stableJson,
} = require("../lib/pikiio-phase-attestation");
const {
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
} = require("../lib/pikiio-github-oidc-collector");
const {
  MAX_INPUT_BASE64_BYTES,
  REQUEST_TIMEOUT_MS,
  collect,
  main,
  parseCanonicalProofInputs,
  reportCliFailure,
  requestOidcToken,
  runCli,
} = require("../scripts/pikiio-github-oidc-collector-command");

const signingKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const attackerKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const weakKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicExponent: 0x10001,
});
const publicJwk = signingKeys.publicKey.export({ format: "jwk" });
const attackerJwk = attackerKeys.publicKey.export({ format: "jwk" });
const FIXED_IAT = 1_783_000_000;
const CANDIDATE = "b".repeat(40);
const SCOPE_BASE = "a".repeat(40);
const REF = "refs/heads/codex/proof-candidate";
const JTI = "123e4567-e89b-42d3-a456-426614174000";
const X5T = crypto.createHash("sha1").update("ephemeral-test").digest("base64url");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(character) {
  return character.repeat(64);
}

function artifact(character) {
  const value = digest(character);
  return { address: `sha256:${value}`, sha256: value };
}

function makeBody(overrides = {}) {
  return buildAttestationBody({
    phaseId: "TRUTH-01",
    issuerRegistrySha256: digest("1"),
    ledgerRevision: 9,
    ledgerSha256: digest("2"),
    candidateCommit: CANDIDATE,
    candidateTree: "c".repeat(40),
    strictQualityReceiptHash: digest("3"),
    commandPlanHash: digest("4"),
    primaryRawArtifactHash: digest("5"),
    independentRawArtifactHash: digest("6"),
    receiptHashes: {
      candidate: digest("7"),
      rehearsal: digest("8"),
      change: digest("9"),
      promotion: digest("d"),
    },
    artifacts: {
      primaryRaw: artifact("5"),
      independentRaw: artifact("6"),
      candidateReceipt: artifact("7"),
      rehearsalReceipt: artifact("8"),
      changeReceipt: artifact("9"),
      promotionReceipt: artifact("d"),
    },
    ...overrides,
  });
}

function makeProofInputs(body = makeBody()) {
  return {
    schema: COLLECTOR_PROOF_INPUT_SCHEMA,
    phase: {
      phaseId: body.phaseId,
      issuerRegistrySha256: body.issuerRegistrySha256,
      ledgerRevision: body.ledgerRevision,
      ledgerSha256: body.ledgerSha256,
    },
    candidate: {
      commit: body.candidateCommit,
      tree: body.candidateTree,
    },
    quality: {
      strictReceiptHash: body.strictQualityReceiptHash,
      commandPlanHash: body.commandPlanHash,
      primaryRawArtifactHash: body.primaryRawArtifactHash,
      independentRawArtifactHash: body.independentRawArtifactHash,
    },
    receiptHashes: { ...body.receiptHashes },
  };
}

function makeRegistry({
  kid = "github-ephemeral-2026",
  jwk = publicJwk,
  x5t = X5T,
  extraKeys = [],
} = {}) {
  const registry = {
    schema: JWKS_REGISTRY_SCHEMA,
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
      ...extraKeys,
    ].sort((left, right) => left.kid.localeCompare(right.kid)),
    registrySha256: digest("0"),
  };
  registry.registrySha256 = hashWithoutField(registry, "registrySha256");
  return registry;
}

function expectedRun(overrides = {}) {
  return {
    eventName: "workflow_dispatch",
    runId: "10001",
    runNumber: "77",
    runAttempt: "1",
    checkRunId: "90001",
    ...overrides,
  };
}

function makePayload(overrides = {}) {
  return {
    actor: "demo-maintainer",
    actor_id: "12345",
    aud: expectedAudience(sha256(stableJson(makeBody()))),
    base_ref: "",
    check_run_id: "90001",
    event_name: "workflow_dispatch",
    exp: FIXED_IAT + 600,
    head_ref: "",
    iat: FIXED_IAT,
    iss: GITHUB_OIDC_ISSUER,
    job_workflow_ref: expectedReusableWorkflowRef(),
    job_workflow_sha: SCOPE_BASE,
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
    run_id: "10001",
    run_number: "77",
    runner_environment: EXPECTED_RUNNER_ENVIRONMENT,
    sha: CANDIDATE,
    sub: `repo:${EXPECTED_REPOSITORY}:ref:${REF}`,
    workflow: "Pikiio proof caller",
    workflow_ref: `${EXPECTED_REPOSITORY}/.github/workflows/pikiio-proof-caller.yml@${REF}`,
    workflow_sha: CANDIDATE,
    ...overrides,
  };
}

function jwt({
  payload = makePayload(),
  privateKey = signingKeys.privateKey,
  header = {
    alg: "RS256",
    kid: "github-ephemeral-2026",
    typ: "JWT",
    x5t: X5T,
  },
} = {}) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function makeReceipt({
  body = makeBody(),
  token = jwt(),
  registry = makeRegistry(),
  requestedAt = new Date(FIXED_IAT * 1000).toISOString(),
  receivedAt = new Date((FIXED_IAT + 1) * 1000).toISOString(),
} = {}) {
  return buildGithubOidcCollectorReceipt({
    body,
    scopeBaseCommit: SCOPE_BASE,
    jwksRegistrySha256: registry.registrySha256,
    oidcToken: token,
    requestedAt,
    receivedAt,
  });
}

function validateFixture({
  receipt = makeReceipt(),
  body = makeBody(),
  registry = makeRegistry(),
  run = expectedRun(),
  nowMs = (FIXED_IAT + 2) * 1000,
} = {}) {
  return validateGithubOidcCollectorReceipt({
    receipt,
    expectedBody: body,
    scopeBaseCommit: SCOPE_BASE,
    jwksRegistry: registry,
    expectedJwksRegistrySha256: registry.registrySha256,
    expectedRun: run,
    nowMs,
  });
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof GithubOidcCollectorError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function resignPayload(overrides) {
  return jwt({ payload: makePayload(overrides) });
}

function rebuildReceiptForPayload(overrides) {
  return makeReceipt({ token: resignPayload(overrides) });
}

function rehashReceipt(receipt) {
  receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
  return receipt;
}

async function withEnvironment(values, callback) {
  const prior = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("GitHub OIDC collector positive authority", () => {
  test("constants pin the external authority contract", () => {
    assert.equal(
      COLLECTOR_RECEIPT_SCHEMA,
      "pikiio-github-oidc-collector-receipt-v1",
    );
    assert.equal(
      COLLECTOR_PROOF_INPUT_SCHEMA,
      "pikiio-github-oidc-collector-proof-input-v1",
    );
    assert.equal(JWKS_REGISTRY_SCHEMA, "pikiio-github-oidc-jwks-registry-v1");
    assert.equal(GITHUB_OIDC_ISSUER, "https://token.actions.githubusercontent.com");
    assert.equal(EXPECTED_REPOSITORY, "demo-maintainer/Pikiio-app-");
    assert.equal(EXPECTED_REPOSITORY_VISIBILITY, "private");
    assert.equal(EXPECTED_RUNNER_ENVIRONMENT, "github-hosted");
    assert.equal(
      REUSABLE_WORKFLOW_PATH,
      ".github/workflows/pikiio-proof-collector.yml",
    );
    assert.equal(REUSABLE_WORKFLOW_REF, "pikiio-proof-authority-v1");
  });

  test("bounds are explicit and conservative", () => {
    assert.equal(MAX_JWT_BYTES, 49152);
    assert.equal(MAX_RECEIPT_BYTES, 65536);
    assert.equal(MAX_REGISTRY_BYTES, 65536);
    assert.equal(MAX_TOKEN_LIFETIME_SECONDS, 600);
    assert.equal(MAX_NOT_BEFORE_LEAD_SECONDS, 300);
    assert.equal(MAX_COLLECTION_SECONDS, 30);
    assert.equal(CLOCK_SKEW_SECONDS, 30);
    assert.equal(MAX_INPUT_BASE64_BYTES, 49152);
    assert.equal(REQUEST_TIMEOUT_MS, 15000);
  });

  test("audience is uniquely bound to the canonical phase body", () => {
    const body = makeBody();
    assert.equal(
      expectedAudience(sha256(stableJson(body))),
      `pikiio-proof:${sha256(stableJson(body))}`,
    );
  });

  test("frozen semantics reconstruct the only canonical body from proof inputs", () => {
    const body = makeBody();
    assert.deepEqual(
      reconstructAttestationBodyFromProofInputs(makeProofInputs(body)),
      body,
    );
  });

  test("proof input nesting permits no ready-body or metadata smuggling", () => {
    const inputs = makeProofInputs();
    inputs.candidate.body = makeBody();
    expectCode("UNEXPECTED_FIELDS", () =>
      reconstructAttestationBodyFromProofInputs(inputs),
    );
  });

  test("proof input schema is exact", () => {
    const inputs = makeProofInputs();
    inputs.schema = "pikiio-github-oidc-collector-proof-input-v2";
    expectCode("INVALID_PROOF_INPUT_SCHEMA", () =>
      reconstructAttestationBodyFromProofInputs(inputs),
    );
  });

  test("reusable workflow ref is pinned to the immutable authority tag", () => {
    assert.equal(
      expectedReusableWorkflowRef(),
      `${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_REF}`,
    );
  });

  test("pinned ephemeral RSA registry validates offline", () => {
    const registry = makeRegistry();
    const result = validatePinnedJwksRegistry(registry, {
      expectedRegistrySha256: registry.registrySha256,
    });
    assert.equal(result.registrySha256, registry.registrySha256);
    assert.equal(result.keysById.size, 1);
  });

  test("valid GitHub-hosted receipt verifies and yields a replay key", () => {
    const result = validateFixture();
    assert.equal(result.valid, true);
    assert.equal(result.candidateCommit, CANDIDATE);
    assert.equal(result.scopeBaseCommit, SCOPE_BASE);
    assert.equal(result.jti, JTI);
    assert.equal(
      result.replayKey,
      `${GITHUB_OIDC_ISSUER}:${JTI}`,
    );
    assert.equal(result.runId, "10001");
  });

  test("collector receipt content-addresses its exact bytes", () => {
    const receipt = makeReceipt();
    assert.equal(
      receipt.receiptHash,
      hashWithoutField(receipt, "receiptHash"),
    );
    assert.equal(receipt.oidc.issuedAt, new Date(FIXED_IAT * 1000).toISOString());
    assert.equal(receipt.oidc.notBefore, new Date((FIXED_IAT - 60) * 1000).toISOString());
    assert.equal(receipt.oidc.expiresAt, new Date((FIXED_IAT + 600) * 1000).toISOString());
  });

  test("GitHub JWT parsing returns signed segments without trusting them", () => {
    const parsed = parseGithubOidcToken(jwt());
    assert.equal(parsed.header.alg, "RS256");
    assert.equal(parsed.payload.sha, CANDIDATE);
    assert.equal(parsed.signature.length, 256);
    assert.match(parsed.signingInput.toString("ascii"), /^[^.]+\.[^.]+$/);
  });
});

describe("pinned JWKS registry rejects authority substitution", () => {
  test("registry requires exact fields", () => {
    const registry = makeRegistry();
    registry.extra = true;
    expectCode("UNEXPECTED_FIELDS", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry schema and issuer are exact", () => {
    const registry = makeRegistry();
    registry.issuer = "https://attacker.invalid";
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("INVALID_JWKS_REGISTRY", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry must match an independently supplied digest", () => {
    const registry = makeRegistry();
    expectCode("JWKS_REGISTRY_HASH_MISMATCH", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: digest("f"),
      }),
    );
  });

  test("registry self-hash cannot be forged", () => {
    const registry = makeRegistry();
    registry.registrySha256 = digest("f");
    expectCode("JWKS_REGISTRY_HASH_MISMATCH", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: digest("f"),
      }),
    );
  });

  test("registry must contain a bounded nonempty key set", () => {
    const registry = makeRegistry();
    registry.keys = [];
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("INVALID_JWKS_REGISTRY", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry keys require exact JWK fields", () => {
    const registry = makeRegistry();
    registry.keys[0].x5c = ["certificate"];
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("UNEXPECTED_FIELDS", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry refuses algorithm substitution", () => {
    const registry = makeRegistry();
    registry.keys[0].alg = "PS256";
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("INVALID_JWK", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry refuses weak RSA keys", () => {
    const weakJwk = weakKeys.publicKey.export({ format: "jwk" });
    const registry = makeRegistry({ jwk: weakJwk });
    expectCode("INVALID_JWK", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry refuses noncanonical modulus and exponent", () => {
    const registry = makeRegistry();
    registry.keys[0].e = Buffer.from([3]).toString("base64url");
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("INVALID_JWK", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry refuses malformed thumbprints", () => {
    const registry = makeRegistry();
    registry.keys[0].x5t = Buffer.alloc(19).toString("base64url");
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("INVALID_JWK", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("registry keys are unique and lexically sorted", () => {
    const registry = makeRegistry({
      extraKeys: [
        {
          kty: "RSA",
          alg: "RS256",
          use: "sig",
          kid: "aaa-earlier",
          n: attackerJwk.n,
          e: attackerJwk.e,
          x5t: null,
        },
      ],
    });
    registry.keys.reverse();
    registry.registrySha256 = hashWithoutField(registry, "registrySha256");
    expectCode("NON_CANONICAL_JWKS", () =>
      validatePinnedJwksRegistry(registry, {
        expectedRegistrySha256: registry.registrySha256,
      }),
    );
  });

  test("nullable x5t pins the exact three-field GitHub header variant", () => {
    const registry = makeRegistry({ x5t: null });
    const token = jwt({
      header: {
        alg: "RS256",
        kid: "github-ephemeral-2026",
        typ: "JWT",
      },
    });
    const receipt = makeReceipt({ token, registry });
    assert.equal(
      validateFixture({ receipt, registry }).valid,
      true,
    );
  });
});

describe("JWT cryptography and structure fail closed", () => {
  test("JWT requires exactly three canonical segments", () => {
    expectCode("INVALID_JWT", () => parseGithubOidcToken("a.b"));
    expectCode("INVALID_JWT", () => parseGithubOidcToken("a.b.c.d"));
  });

  test("JWT refuses padded base64url", () => {
    expectCode("INVALID_BASE64URL", () =>
      parseGithubOidcToken(
        `${Buffer.from("{}").toString("base64")}.e30.eA`,
      ),
    );
  });

  test("JWT refuses non-JSON objects", () => {
    const array = Buffer.from("[]").toString("base64url");
    expectCode("INVALID_JSON_OBJECT", () =>
      parseGithubOidcToken(`${array}.${array}.eA`),
    );
  });

  test("JWT refuses malformed JSON", () => {
    const bad = Buffer.from("{").toString("base64url");
    expectCode("INVALID_JSON", () =>
      parseGithubOidcToken(`${bad}.${bad}.eA`),
    );
  });

  test("JWT token size is bounded", () => {
    expectCode("INVALID_JWT", () =>
      parseGithubOidcToken("a".repeat(MAX_JWT_BYTES + 1)),
    );
  });

  test("unrecognized kid is refused before signature verification", () => {
    const token = jwt({
      header: {
        alg: "RS256",
        kid: "unknown-kid",
        typ: "JWT",
        x5t: X5T,
      },
    });
    expectCode("UNPINNED_SIGNING_KEY", () =>
      validateFixture({ receipt: makeReceipt({ token }) }),
    );
  });

  test("header algorithm confusion is refused", () => {
    const token = jwt({
      header: {
        alg: "PS256",
        kid: "github-ephemeral-2026",
        typ: "JWT",
        x5t: X5T,
      },
    });
    expectCode("INVALID_JWT_HEADER", () =>
      validateFixture({ receipt: makeReceipt({ token }) }),
    );
  });

  test("header permits no extra fields", () => {
    const token = jwt({
      header: {
        alg: "RS256",
        kid: "github-ephemeral-2026",
        typ: "JWT",
        x5t: X5T,
        trusted: true,
      },
    });
    expectCode("UNEXPECTED_FIELDS", () =>
      validateFixture({ receipt: makeReceipt({ token }) }),
    );
  });

  test("header thumbprint must match the pinned JWK", () => {
    const token = jwt({
      header: {
        alg: "RS256",
        kid: "github-ephemeral-2026",
        typ: "JWT",
        x5t: Buffer.alloc(20).toString("base64url"),
      },
    });
    expectCode("INVALID_JWT_HEADER", () =>
      validateFixture({ receipt: makeReceipt({ token }) }),
    );
  });

  test("signature from an attacker key cannot impersonate GitHub", () => {
    const token = jwt({ privateKey: attackerKeys.privateKey });
    expectCode("SIGNATURE_VERIFICATION_FAILED", () =>
      validateFixture({ receipt: makeReceipt({ token }) }),
    );
  });

  test("truncated RSA signature is refused", () => {
    const token = jwt();
    const segments = token.split(".");
    segments[2] = Buffer.alloc(255).toString("base64url");
    expectCode("INVALID_SIGNATURE", () =>
      validateFixture({
        receipt: makeReceipt({ token: segments.join(".") }),
      }),
    );
  });
});

describe("signed GitHub claims cannot be widened or substituted", () => {
  for (const [name, override, code] of [
    ["issuer", { iss: "https://attacker.invalid" }, "OIDC_IDENTITY_MISMATCH"],
    ["audience", { aud: "pikiio-proof:attacker" }, "OIDC_IDENTITY_MISMATCH"],
    ["repository", { repository: "attacker/repo" }, "OIDC_IDENTITY_MISMATCH"],
    ["owner", { repository_owner: "attacker" }, "OIDC_IDENTITY_MISMATCH"],
    ["visibility", { repository_visibility: "public" }, "OIDC_IDENTITY_MISMATCH"],
    ["runner", { runner_environment: "self-hosted" }, "OIDC_IDENTITY_MISMATCH"],
    ["candidate", { sha: "e".repeat(40) }, "OIDC_IDENTITY_MISMATCH"],
    ["caller workflow SHA", { workflow_sha: "e".repeat(40) }, "OIDC_IDENTITY_MISMATCH"],
    [
      "moved authority tag commit",
      {
        job_workflow_ref: expectedReusableWorkflowRef(),
        job_workflow_sha: "e".repeat(40),
      },
      "OIDC_IDENTITY_MISMATCH",
    ],
    [
      "reusable workflow tag",
      {
        job_workflow_ref:
          `${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@main`,
      },
      "OIDC_IDENTITY_MISMATCH",
    ],
    [
      "reusable workflow repository",
      {
        job_workflow_ref:
          `attacker/repository/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_REF}`,
      },
      "OIDC_IDENTITY_MISMATCH",
    ],
    [
      "reusable workflow path",
      {
        job_workflow_ref:
          `${EXPECTED_REPOSITORY}/.github/workflows/attacker.yml@${REUSABLE_WORKFLOW_REF}`,
      },
      "OIDC_IDENTITY_MISMATCH",
    ],
    ["event", { event_name: "push" }, "RUN_CONTEXT_MISMATCH"],
    ["run id", { run_id: "20002" }, "RUN_CONTEXT_MISMATCH"],
    ["run number", { run_number: "78" }, "RUN_CONTEXT_MISMATCH"],
    ["run attempt", { run_attempt: "2" }, "RUN_CONTEXT_MISMATCH"],
    ["check run", { check_run_id: "90002" }, "RUN_CONTEXT_MISMATCH"],
    ["subject", { sub: "repo:attacker/repo:ref:refs/heads/main" }, "SUBJECT_MISMATCH"],
    ["caller workflow", { workflow_ref: "attacker/repo/.github/workflows/x.yml@refs/heads/main" }, "CALLER_WORKFLOW_MISMATCH"],
  ]) {
    test(`signed ${name} substitution is refused`, () => {
      expectCode(code, () =>
        validateFixture({
          receipt: rebuildReceiptForPayload(override),
        }),
      );
    });
  }

  test("payload permits no new GitHub or attacker-defined claims", () => {
    const payload = makePayload();
    payload.environment = "production";
    expectCode("UNEXPECTED_FIELDS", () =>
      validateFixture({
        receipt: makeReceipt({ token: jwt({ payload }) }),
      }),
    );
  });

  test("run identifiers are canonical decimal strings", () => {
    expectCode("INVALID_RUN_CLAIM", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ run_id: "001" }),
      }),
    );
  });

  test("jti must be a canonical UUID", () => {
    expectCode("INVALID_JTI", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ jti: "not-a-jti" }),
      }),
    );
  });

  test("branch and tag ref types must match their refs", () => {
    expectCode("INVALID_REF_CONTEXT", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ ref_type: "tag" }),
      }),
    );
  });

  test("ref protection is a canonical GitHub string boolean", () => {
    expectCode("INVALID_REF_CONTEXT", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ ref_protected: false }),
      }),
    );
  });
});

describe("event times, run identity, and replay identity are exact", () => {
  test("not-before cannot follow issued-at", () => {
    expectCode("INVALID_TOKEN_WINDOW", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ nbf: FIXED_IAT + 1 }),
      }),
    );
  });

  test("not-before lead is bounded", () => {
    expectCode("INVALID_TOKEN_WINDOW", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ nbf: FIXED_IAT - 301 }),
      }),
    );
  });

  test("token lifetime is positive and at most ten minutes", () => {
    expectCode("INVALID_TOKEN_WINDOW", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ exp: FIXED_IAT + 601 }),
      }),
    );
    expectCode("INVALID_TOKEN_WINDOW", () =>
      validateFixture({
        receipt: rebuildReceiptForPayload({ exp: FIXED_IAT }),
      }),
    );
  });

  test("collection duration is bounded", () => {
    const receipt = makeReceipt({
      receivedAt: new Date((FIXED_IAT + 31) * 1000).toISOString(),
    });
    expectCode("COLLECTION_WINDOW_MISMATCH", () =>
      validateFixture({ receipt, nowMs: (FIXED_IAT + 32) * 1000 }),
    );
  });

  test("collection receipt cannot come from the future", () => {
    const receipt = makeReceipt({
      requestedAt: new Date((FIXED_IAT + 100) * 1000).toISOString(),
      receivedAt: new Date((FIXED_IAT + 101) * 1000).toISOString(),
    });
    expectCode("COLLECTION_WINDOW_MISMATCH", () =>
      validateFixture({ receipt, nowMs: FIXED_IAT * 1000 }),
    );
  });

  test("historical verification remains valid after token expiry", () => {
    assert.equal(
      validateFixture({ nowMs: (FIXED_IAT + 10_000_000) * 1000 }).valid,
      true,
    );
  });

  test("expected run object permits no missing or extra context", () => {
    const run = expectedRun();
    run.actor = "nobody";
    expectCode("UNEXPECTED_FIELDS", () =>
      validateFixture({ run }),
    );
  });

  test("expected run values must be canonical", () => {
    expectCode("INVALID_RUN_CLAIM", () =>
      validateFixture({ run: expectedRun({ runAttempt: "01" }) }),
    );
  });
});

describe("receipt structure and body binding are immutable", () => {
  test("receipt permits no extra fields", () => {
    const receipt = makeReceipt();
    receipt.note = "trusted";
    expectCode("UNEXPECTED_FIELDS", () => validateFixture({ receipt }));
  });

  test("receipt schema is exact", () => {
    const receipt = makeReceipt();
    receipt.schema = "pikiio-github-oidc-collector-receipt-v2";
    rehashReceipt(receipt);
    expectCode("INVALID_RECEIPT_SCHEMA", () => validateFixture({ receipt }));
  });

  test("receipt hash detects any mutation", () => {
    const receipt = makeReceipt();
    receipt.audience = "changed";
    expectCode("RECEIPT_HASH_MISMATCH", () => validateFixture({ receipt }));
  });

  test("receipt body hash must match the independently reconstructed body", () => {
    const receipt = makeReceipt();
    receipt.bodySha256 = digest("f");
    rehashReceipt(receipt);
    expectCode("RECEIPT_BINDING_MISMATCH", () =>
      validateFixture({ receipt }),
    );
  });

  test("receipt cannot substitute the frozen scope base", () => {
    const receipt = makeReceipt();
    receipt.scopeBaseCommit = "e".repeat(40);
    rehashReceipt(receipt);
    expectCode("RECEIPT_BINDING_MISMATCH", () =>
      validateFixture({ receipt }),
    );
  });

  test("receipt must bind the exact pinned JWKS registry", () => {
    const receipt = makeReceipt();
    receipt.jwksRegistrySha256 = digest("f");
    rehashReceipt(receipt);
    expectCode("RECEIPT_BINDING_MISMATCH", () =>
      validateFixture({ receipt }),
    );
  });

  test("OIDC projection permits no extra fields", () => {
    const receipt = makeReceipt();
    receipt.oidc.actor = "nobody";
    rehashReceipt(receipt);
    expectCode("UNEXPECTED_FIELDS", () => validateFixture({ receipt }));
  });

  test("OIDC projection must exactly match signed claims", () => {
    const receipt = makeReceipt();
    receipt.oidc.jti = "223e4567-e89b-42d3-a456-426614174000";
    rehashReceipt(receipt);
    expectCode("OIDC_PROJECTION_MISMATCH", () =>
      validateFixture({ receipt }),
    );
  });

  test("receipt byte size is bounded", () => {
    const receipt = makeReceipt();
    receipt.oidcToken = "a".repeat(MAX_RECEIPT_BYTES);
    expectCode("SIZE_LIMIT_EXCEEDED", () => validateFixture({ receipt }));
  });
});

describe("frozen collector command is deterministic and bounded", () => {
  test("canonical body is reconstructed using frozen phase semantics", () => {
    const body = makeBody();
    const encoded = Buffer.from(stableJson(makeProofInputs(body))).toString(
      "base64",
    );
    assert.deepEqual(parseCanonicalProofInputs(encoded), body);
  });

  test("proof body must be canonical base64 and bounded", () => {
    assert.throws(() => parseCanonicalProofInputs("not base64"));
    assert.throws(() =>
      parseCanonicalProofInputs("A".repeat(MAX_INPUT_BASE64_BYTES + 4)),
    );
  });

  test("proof body must be an exact valid attestation body", () => {
    const inputs = makeProofInputs();
    inputs.extra = true;
    assert.throws(() =>
      parseCanonicalProofInputs(
        Buffer.from(JSON.stringify(inputs)).toString("base64"),
      ),
    );
  });

  test("proof body JSON bytes must already be canonical", () => {
    const noncanonical = JSON.stringify(makeProofInputs(), null, 2);
    assert.throws(() =>
      parseCanonicalProofInputs(Buffer.from(noncanonical).toString("base64")),
    );
  });

  test("OIDC request uses only the Actions HTTPS endpoint and exact audience", async () => {
    let observed;
    await withEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token?api-version=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-bearer",
      },
      async () => {
        const value = await requestOidcToken({
          audience: "pikiio-proof:body",
          fetchImpl: async (url, options) => {
            observed = { url: String(url), options };
            return {
              ok: true,
              status: 200,
              json: async () => ({ value: "signed.jwt.token" }),
            };
          },
        });
        assert.equal(value, "signed.jwt.token");
      },
    );
    assert.match(observed.url, /audience=pikiio-proof%3Abody/);
    assert.equal(observed.options.method, "GET");
    assert.equal(observed.options.redirect, "error");
    assert.equal(observed.options.headers.Authorization, "bearer ephemeral-bearer");
  });

  test("OIDC request refuses non-Actions hosts", async () => {
    await withEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.invalid/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-bearer",
      },
      async () => {
        await assert.rejects(() =>
          requestOidcToken({
            audience: "pikiio-proof:body",
            fetchImpl: async () => {
              throw new Error("must not run");
            },
          }),
        );
      },
    );
  });

  test("OIDC request requires an injected or global fetch implementation", async () => {
    await withEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-bearer",
      },
      async () => {
        await assert.rejects(() =>
          requestOidcToken({
            audience: "pikiio-proof:body",
            fetchImpl: null,
          }),
        );
      },
    );
  });

  test("OIDC timeout aborts the request and always clears its timer", async () => {
    let cleared = false;
    await withEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-bearer",
      },
      async () => {
        await assert.rejects(() =>
          requestOidcToken({
            audience: "pikiio-proof:body",
            setTimeoutImpl: (callback) => {
              callback();
              return 42;
            },
            clearTimeoutImpl: (value) => {
              assert.equal(value, 42);
              cleared = true;
            },
            fetchImpl: async (_url, options) => {
              assert.equal(options.signal.aborted, true);
              throw new Error("aborted");
            },
          }),
        );
      },
    );
    assert.equal(cleared, true);
  });

  test("OIDC request refuses failed and structurally widened responses", async () => {
    await withEnvironment(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-bearer",
      },
      async () => {
        await assert.rejects(() =>
          requestOidcToken({
            audience: "pikiio-proof:body",
            fetchImpl: async () => ({
              ok: false,
              status: 403,
            }),
          }),
        );
        await assert.rejects(() =>
          requestOidcToken({
            audience: "pikiio-proof:body",
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              json: async () => ({ value: "jwt", extra: true }),
            }),
          }),
        );
      },
    );
  });

  test("collection matches body, checked-out candidate, and GitHub run SHA", async () => {
    const body = makeBody();
    const registry = makeRegistry();
    const encoded = Buffer.from(stableJson(makeProofInputs(body))).toString(
      "base64",
    );
    let clock = FIXED_IAT * 1000;
    await withEnvironment(
      {
        PIKIIO_PROOF_INPUTS_BASE64: encoded,
        PIKIIO_CANDIDATE_SHA: CANDIDATE,
        PIKIIO_CHECKED_OUT_CANDIDATE_SHA: CANDIDATE,
        PIKIIO_SCOPE_BASE_SHA: SCOPE_BASE,
        PIKIIO_JWKS_REGISTRY_SHA256: registry.registrySha256,
        GITHUB_SHA: CANDIDATE,
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-bearer",
      },
      async () => {
        const receipt = await collect({
          now: () => clock++,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ value: jwt() }),
          }),
        });
        assert.equal(receipt.candidateCommit, CANDIDATE);
        assert.equal(receipt.scopeBaseCommit, SCOPE_BASE);
      },
    );
  });

  test("collection refuses candidate mismatch before requesting OIDC", async () => {
    const body = makeBody();
    const registry = makeRegistry();
    await withEnvironment(
      {
        PIKIIO_PROOF_INPUTS_BASE64: Buffer.from(
          stableJson(makeProofInputs(body)),
        ).toString("base64"),
        PIKIIO_CANDIDATE_SHA: CANDIDATE,
        PIKIIO_CHECKED_OUT_CANDIDATE_SHA: "e".repeat(40),
        PIKIIO_SCOPE_BASE_SHA: SCOPE_BASE,
        PIKIIO_JWKS_REGISTRY_SHA256: registry.registrySha256,
        GITHUB_SHA: CANDIDATE,
      },
      async () => {
        await assert.rejects(() =>
          collect({
            fetchImpl: async () => {
              throw new Error("must not request token");
            },
          }),
        );
      },
    );
  });

  test("collection fails closed when a required environment value is absent", async () => {
    await withEnvironment(
      { PIKIIO_PROOF_INPUTS_BASE64: undefined },
      async () => {
        await assert.rejects(() =>
          collect({
            fetchImpl: async () => {
              throw new Error("must not request token");
            },
          }),
        );
      },
    );
  });

  test("decision-free main writes once inside the workspace", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-oidc-main-"));
    const outputPath = path.join(directory, "receipt.json");
    const receipt = makeReceipt();
    try {
      await withEnvironment(
        { PIKIIO_RECEIPT_OUTPUT_PATH: outputPath },
        async () => {
          await main({
            argv: ["node", "collector", "collect"],
            cwd: directory,
            collectImpl: async () => receipt,
          });
        },
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(outputPath, "utf8")),
        receipt,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("decision-free main refuses other commands and out-of-workspace output", async () => {
    await assert.rejects(() =>
      main({ argv: ["node", "collector", "status"] }),
    );
    await withEnvironment(
      { PIKIIO_RECEIPT_OUTPUT_PATH: "/tmp/outside.json" },
      async () => {
        await assert.rejects(() =>
          main({
            argv: ["node", "collector", "collect"],
            cwd: "/workspace",
            collectImpl: async () => makeReceipt(),
          }),
        );
      },
    );
  });

  test("CLI failure reporter is bounded and testable without process execution", async () => {
    let message = "";
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      reportCliFailure(new Error("refused"), {
        write(value) {
          message += value;
        },
      });
      assert.equal(message, "refused\n");
      assert.equal(process.exitCode, 1);

      let reported;
      await runCli({
        mainImpl: async () => {
          throw new Error("blocked");
        },
        reportFailure(error) {
          reported = error.message;
        },
      });
      assert.equal(reported, "blocked");
      await runCli({ mainImpl: async () => {} });
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});

describe("reusable workflow is frozen, minimal, and mutation-free", () => {
  const workflowPath = path.join(
    __dirname,
    "../.github/workflows/pikiio-proof-collector.yml",
  );
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const gauntletBlock = workflow.slice(
    workflow.indexOf("  gauntlet:\n"),
    workflow.indexOf("\n  collect:\n"),
  );
  const collectBlock = workflow.slice(workflow.indexOf("  collect:\n"));

  test("workflow is callable and exposes only receipt outputs", () => {
    assert.match(workflow, /^\s{2}workflow_call:/m);
    assert.match(workflow, /receipt_base64:/);
    assert.match(workflow, /receipt_sha256:/);
    assert.doesNotMatch(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /schedule:/);
  });

  test("workflow default and gauntlet permissions cannot mint an identity token", () => {
    const permissions = workflow.match(
      /^permissions:\n((?: {2}.+\n)+)\n/m,
    );
    assert.ok(permissions);
    assert.equal(permissions[1], "  contents: read\n");
    assert.equal((workflow.match(/^permissions:/gm) || []).length, 1);
    assert.match(
      gauntletBlock,
      /^    permissions:\n      contents: read\n/m,
    );
    assert.doesNotMatch(gauntletBlock, /id-token:/);
  });

  test("only the fresh collector job can mint identity after gauntlet success", () => {
    assert.match(collectBlock, /^    needs: gauntlet$/m);
    assert.match(
      collectBlock,
      /^    if: \$\{\{ needs\.gauntlet\.result == 'success' \}\}$/m,
    );
    assert.match(
      collectBlock,
      /^    permissions:\n      contents: read\n      id-token: write\n/m,
    );
    assert.equal((workflow.match(/id-token: write/g) || []).length, 1);
  });

  test("workflow uses no third-party or floating actions", () => {
    assert.doesNotMatch(workflow, /^\s*uses:/m);
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    assert.match(workflow, /timeout-minutes: 60/);
  });

  test("workflow fetches both exact SHAs and compares candidate with GITHUB_SHA", () => {
    assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
    assert.match(workflow, /PIKIIO_CANDIDATE_SHA" == "\$GITHUB_SHA/);
    assert.match(workflow, /refs\/pikiio\/candidate/);
    assert.match(workflow, /refs\/pikiio\/authority/);
    assert.match(workflow, /rev-parse refs\/pikiio\/candidate\^\{commit\}/);
    assert.match(workflow, /rev-parse refs\/pikiio\/authority\^\{commit\}/);
    assert.match(workflow, /checkout --quiet --detach refs\/pikiio\/candidate/);
    assert.match(
      workflow,
      /git -C "\$repo" status --porcelain=v1 --untracked-files=all/,
    );
  });

  test("privileged collector rematerializes exact trees and one-ledger-only child", () => {
    assert.match(
      collectBlock,
      /rev-parse refs\/pikiio\/candidate\^\)" == "\$PIKIIO_SCOPE_BASE_SHA/,
    );
    assert.match(
      collectBlock,
      /rev-list --count refs\/pikiio\/authority\.\.refs\/pikiio\/candidate\)" == "1"/,
    );
    assert.match(
      collectBlock,
      /"\$\{changed_paths\[0\]\}" == "YLYI\/00_Product_Contract\/Pikiio_Agent_Phases\.json"/,
    );
    assert.match(
      collectBlock,
      /"\$candidate_tree" == "\$PIKIIO_EXPECTED_CANDIDATE_TREE"/,
    );
    assert.match(
      collectBlock,
      /"\$authority_tree" == "\$PIKIIO_EXPECTED_AUTHORITY_TREE"/,
    );
    assert.match(
      collectBlock,
      /PIKIIO_GAUNTLET_SHA256: \$\{\{ needs\.gauntlet\.outputs\.gauntlet_sha256 \}\}/,
    );
  });

  test("workflow runs unit coverage, Gherkin, and fingerprinted mutation before OIDC", () => {
    const gauntlet = workflow.indexOf(
      "- name: Run frozen independent GOV gauntlet",
    );
    const oidc = workflow.indexOf(
      "- name: Request body-bound GitHub OIDC identity",
    );
    assert.ok(gauntlet > 0);
    assert.ok(oidc > gauntlet);
    assert.match(workflow, /governance-unit-v1/);
    assert.match(workflow, /--experimental-test-coverage/);
    assert.match(workflow, /--test-coverage-lines=95/);
    assert.match(workflow, /--test-coverage-branches=90/);
    assert.match(workflow, /--test-coverage-functions=95/);
    assert.match(
      workflow,
      /node scripts\/verify-pikiio-governance-gherkin\.js/,
    );
    assert.match(
      workflow,
      /node scripts\/mutate-pikiio-agent-governance\.js/,
    );
    assert.match(workflow, /timeout: 40 \* 60 \* 1000/);
    assert.doesNotMatch(workflow, /continue-on-error:/);
  });

  test("workflow executes collector only from the frozen authority checkout", () => {
    assert.match(collectBlock, /steps\.checkout\.outputs\.authority/);
    assert.match(
      collectBlock,
      /node scripts\/pikiio-github-oidc-collector-command\.js collect/,
    );
    assert.match(collectBlock, /PIKIIO_SCOPE_BASE_SHA:/);
    assert.match(collectBlock, /PIKIIO_CHECKED_OUT_CANDIDATE_SHA:/);
    assert.doesNotMatch(collectBlock, /governance-unit-v1/);
    assert.doesNotMatch(
      collectBlock,
      /verify-pikiio-governance-gherkin\.js/,
    );
    assert.doesNotMatch(
      collectBlock,
      /mutate-pikiio-agent-governance\.js/,
    );
    assert.doesNotMatch(collectBlock, /cd "\$PIKIIO_CANDIDATE"/);
  });

  test("workflow output is bounded and uses the internal receipt hash", () => {
    assert.match(workflow, /stat -c '%s'.*65536/);
    assert.match(workflow, /\$\{#receipt_base64\}.*87384/);
    assert.match(workflow, /r\.receiptHash/);
  });
});

describe("manual proof request delegates only to immutable authority", () => {
  const requestPath = path.join(
    __dirname,
    "../.github/workflows/pikiio-proof-request.yml",
  );
  const request = fs.readFileSync(requestPath, "utf8");

  test("workflow_dispatch is the sole trigger with three exact typed inputs", () => {
    assert.match(request, /^on:\n  workflow_dispatch:\n    inputs:\n/m);
    assert.doesNotMatch(request, /^\s{2}(?:push|pull_request|schedule|workflow_call):/m);
    const inputBlock = request.slice(
      request.indexOf("    inputs:\n"),
      request.indexOf("\npermissions:\n"),
    );
    assert.deepEqual(
      [...inputBlock.matchAll(/^      ([a-z0-9_]+):$/gm)].map(
        (match) => match[1],
      ),
      [
        "scope_base_sha",
        "proof_inputs_base64",
        "jwks_registry_sha256",
      ],
    );
    assert.equal((inputBlock.match(/required: true/g) || []).length, 3);
    assert.equal((inputBlock.match(/type: string/g) || []).length, 3);
  });

  test("caller derives the candidate SHA and invokes only the fixed authority tag", () => {
    const expectedUse =
      `uses: ${EXPECTED_REPOSITORY}/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_REF}`;
    assert.equal((request.match(/^\s{4}uses:/gm) || []).length, 1);
    assert.match(request, new RegExp(`^    ${expectedUse}$`, "m"));
    assert.match(request, /candidate_sha: \$\{\{ github\.sha \}\}/);
    assert.match(request, /scope_base_sha: \$\{\{ inputs\.scope_base_sha \}\}/);
    assert.match(
      request,
      /proof_inputs_base64: \$\{\{ inputs\.proof_inputs_base64 \}\}/,
    );
    assert.match(
      request,
      /jwks_registry_sha256: \$\{\{ inputs\.jwks_registry_sha256 \}\}/,
    );
    assert.doesNotMatch(request, /uses:\s+actions\//);
  });

  test("only the called collector job receives id-token authority", () => {
    const rootPermissions = request.match(
      /^permissions:\n((?: {2}.+\n)+)\n/m,
    );
    assert.ok(rootPermissions);
    assert.equal(rootPermissions[1], "  contents: read\n");
    const collectBlock = request.slice(
      request.indexOf("  collect:\n"),
      request.indexOf("\n  report:\n"),
    );
    assert.match(
      collectBlock,
      /^    permissions:\n      contents: read\n      id-token: write\n/m,
    );
    const reportBlock = request.slice(request.indexOf("  report:\n"));
    assert.match(
      reportBlock,
      /^    permissions:\n      contents: read\n/m,
    );
    assert.doesNotMatch(reportBlock, /id-token:/);
    assert.doesNotMatch(request, /secrets:|\$\{\{\s*secrets\.|github\.token/);
  });

  test("receipt output is canonical, size-bounded, and emitted for retrieval", () => {
    assert.match(request, /\$\{#PIKIIO_RECEIPT_BASE64\}.*87384/);
    assert.match(request, /stat -c '%s'.*65536/);
    assert.match(request, /base64 --decode/);
    assert.match(request, /base64 -w0/);
    assert.match(request, /receipt\.receiptHash !== expectedHash/);
    assert.match(request, /receipt_sha256=%s/);
    assert.match(request, /receipt_base64=%s/);
    assert.match(request, /GITHUB_STEP_SUMMARY/);
  });
});

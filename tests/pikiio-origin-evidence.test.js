"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const origin = require("../lib/pikiio-origin-evidence");

const NOW_MS = Date.parse("2026-07-24T12:00:00.000Z");
const OBSERVED_AT = "2026-07-24T11:59:00.000Z";
const CANDIDATE_COMMIT = "a".repeat(40);
const CANDIDATE_TREE = "b".repeat(40);
const DEPLOYMENT_ID = "dpl_01JTESTEXACT";

function digest(label) {
  return origin.sha256(Buffer.from(label, "utf8"));
}

function nonce(label) {
  return digest(`nonce:${label}`);
}

function clone(value) {
  return structuredClone(value);
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.name, "OriginEvidenceError");
    assert.equal(error.code, code);
    return true;
  });
}

function authorityRegistryHash(registry) {
  const content = { ...registry };
  delete content.registryHash;
  return origin.sha256(origin.stableJson(content));
}

function receiptHash(receipt) {
  const content = { ...receipt };
  delete content.receiptHash;
  return origin.sha256(origin.stableJson(content));
}

function rehashRegistry(registry) {
  registry.registryHash = authorityRegistryHash(registry);
  return registry;
}

function rehashReceipt(receipt) {
  receipt.receiptHash = receiptHash(receipt);
  return receipt;
}

function resignReceipt(receipt, privateKey) {
  receipt.signatureBase64 = crypto
    .sign(null, origin.originEvidenceSigningBytes(receipt), privateKey)
    .toString("base64");
  return rehashReceipt(receipt);
}

function rebindBody(receipt, privateKey) {
  receipt.bodySha256 = origin.sha256(origin.stableJson(receipt.body));
  return resignReceipt(receipt, privateKey);
}

function buildHarness() {
  const keyPairs = {};
  const authorities = {};
  origin.EVIDENCE_CLASSES.forEach((evidenceClass, index) => {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    keyPairs[evidenceClass] = keyPair;
    authorities[evidenceClass] = origin.buildAuthorityRecord({
      evidenceClass,
      issuerId: `independent.${index + 1}.${evidenceClass}`,
      publicKey: keyPair.publicKey,
    });
  });
  const registry = origin.buildAuthorityRegistry(authorities);
  return { keyPairs, registry };
}

function commonBody(evidenceClass, overrides = {}) {
  return {
    schema: origin.CLASS_CONFIG[evidenceClass].schema,
    evidenceClass,
    phaseId: "TRUTH-01",
    ledgerRevision: 7,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    deploymentId: DEPLOYMENT_ID,
    sourceId: `independent/${evidenceClass}`,
    observedAt: OBSERVED_AT,
    nonce: nonce(evidenceClass),
    ...overrides,
  };
}

function bodyFor(evidenceClass, overrides = {}) {
  const common = commonBody(evidenceClass);
  let specific;
  switch (evidenceClass) {
    case "natural-cycle":
      specific = {
        cycleId: "cycle.20260724.1159",
        hostedWorkerExecutionId: "worker.991",
        databaseObservationId: "database.442",
        sourceCutSha256: digest("natural-source-cut"),
        workerArtifactSha256: digest("natural-worker-artifact"),
        databaseReadbackSha256: digest("natural-database-readback"),
      };
      break;
    case "deployed-api":
      specific = {
        requestId: "api.request.991",
        requestUrl:
          "https://pq-ops-demo.example/api/truth/health?diagnostic=1",
        requestMethod: "GET",
        responseStatus: 200,
        responseHeadersSha256: digest("api-headers"),
        responseBodySha256: digest("api-body"),
        deploymentReadbackSha256: digest("api-deployment-readback"),
      };
      break;
    case "browser-capture":
      specific = {
        captureId: "browser.capture.991",
        pageUrl: "https://pq-ops-demo.example/",
        viewport: {
          width: 1440,
          height: 900,
          deviceScaleFactor: 2,
        },
        normalizedDomSha256: digest("browser-dom"),
        screenshotSha256: digest("browser-screenshot"),
        observedApiBodySha256: digest("browser-api"),
        browserBuildSha256: digest("browser-build"),
      };
      break;
    case "change":
      specific = {
        changeId: "change.991",
        authorizationReceiptSha256: digest("change-authorization"),
        preimageSha256: digest("change-preimage"),
        appliedArtifactSha256: digest("change-applied-artifact"),
        remoteCommitReadbackSha256: digest("change-remote-commit"),
        deploymentReadbackSha256: digest("change-deployment-readback"),
        rollbackPointerSha256: digest("change-rollback"),
        oneUseCapabilityConsumptionSha256: digest("change-capability"),
      };
      break;
    case "promotion-readback":
      specific = {
        promotionId: "promotion.991",
        changeReceiptHash: digest("promotion-change-receipt"),
        naturalCycleReceiptHashes: [
          digest("promotion-natural-one"),
          digest("promotion-natural-two"),
        ],
        deployedApiReceiptHash: digest("promotion-api"),
        browserCaptureReceiptHash: digest("promotion-browser"),
        soakStartedAt: "2026-07-24T09:59:00.000Z",
        soakEndedAt: OBSERVED_AT,
        remoteReadbackSha256: digest("promotion-remote-readback"),
        rollbackReadinessSha256: digest("promotion-rollback-readiness"),
      };
      break;
    default:
      throw new Error(`unsupported test class ${evidenceClass}`);
  }
  return { ...common, ...specific, ...overrides };
}

function expectedFor(body, registry, overrides = {}) {
  return {
    evidenceClass: body.evidenceClass,
    phaseId: body.phaseId,
    ledgerRevision: body.ledgerRevision,
    candidateCommit: body.candidateCommit,
    candidateTree: body.candidateTree,
    deploymentId: body.deploymentId,
    sourceId: body.sourceId,
    observedAt: body.observedAt,
    nonce: body.nonce,
    authorityRegistrySha256: registry.registryHash,
    ...overrides,
  };
}

function issue(harness, evidenceClass, overrides = {}) {
  const body = bodyFor(evidenceClass, overrides);
  const receipt = origin.issueOriginEvidenceReceipt({
    registry: harness.registry,
    evidenceClass,
    body,
    privateKey: harness.keyPairs[evidenceClass].privateKey,
  });
  return {
    body,
    receipt,
    expected: expectedFor(body, harness.registry),
  };
}

test("authority registry pins five pairwise-distinct Ed25519 authorities", () => {
  const harness = buildHarness();
  const validation = origin.validateAuthorityRegistry(harness.registry);
  assert.deepEqual(validation, {
    ok: true,
    registryHash: harness.registry.registryHash,
    authorityCount: 5,
  });
  assert.equal(
    new Set(
      Object.values(harness.registry.authorities).map(
        (authority) => authority.publicKeySha256,
      ),
    ).size,
    5,
  );
});

test("all independent evidence classes verify offline and consume once", async (t) => {
  const harness = buildHarness();
  const replayStore = origin.createInMemoryReplayStore();
  for (const evidenceClass of origin.EVIDENCE_CLASSES) {
    await t.test(evidenceClass, () => {
      const { receipt, expected } = issue(harness, evidenceClass);
      const verified = origin.verifyAndConsumeOriginEvidence(receipt, {
        registry: harness.registry,
        expected,
        nowMs: NOW_MS,
        replayStore,
      });
      assert.equal(verified.ok, true);
      assert.equal(verified.evidenceClass, evidenceClass);
      assert.equal(
        verified.issuerId,
        harness.registry.authorities[evidenceClass].issuerId,
      );
      assert.equal(verified.candidateCommit, CANDIDATE_COMMIT);
      assert.equal(verified.candidateTree, CANDIDATE_TREE);
      assert.equal(verified.deploymentId, DEPLOYMENT_ID);
      assert.equal(verified.productionAuthority, false);
      assert.equal(verified.replayConsumed, true);
      assert.equal(replayStore.has(verified.replayKeySha256), true);
    });
  }
  assert.equal(replayStore.size(), 5);
});

test("two valid receipts prove distinct authorities cannot substitute for each other", () => {
  const harness = buildHarness();
  const natural = issue(harness, "natural-cycle");
  const browser = issue(harness, "browser-capture");
  const first = origin.verifyOriginEvidence(natural.receipt, {
    registry: harness.registry,
    expected: natural.expected,
    nowMs: NOW_MS,
  });
  const second = origin.verifyOriginEvidence(browser.receipt, {
    registry: harness.registry,
    expected: browser.expected,
    nowMs: NOW_MS,
  });
  assert.notEqual(first.issuerId, second.issuerId);
  assert.notEqual(
    first.authorityIdentitySha256,
    second.authorityIdentitySha256,
  );
});

test("registry rejects reused keys, issuer IDs, identities, and wrong class slots", async (t) => {
  const harness = buildHarness();

  await t.test("reused key", () => {
    const registry = clone(harness.registry);
    registry.authorities["deployed-api"] = {
      ...registry.authorities["natural-cycle"],
      evidenceClass: "deployed-api",
      issuerId: "independent.reused-key-only",
    };
    registry.authorities["deployed-api"].authorityIdentitySha256 = origin.sha256(
      origin.stableJson({
        evidenceClass: "deployed-api",
        issuerId: registry.authorities["deployed-api"].issuerId,
        keyAlgorithm: "Ed25519",
        publicKeySpkiBase64:
          registry.authorities["deployed-api"].publicKeySpkiBase64,
        publicKeySha256:
          registry.authorities["deployed-api"].publicKeySha256,
      }),
    );
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "AUTHORITY_NOT_DISTINCT",
    );
  });

  await t.test("reused issuer", () => {
    const registry = clone(harness.registry);
    registry.authorities["deployed-api"].issuerId =
      registry.authorities["natural-cycle"].issuerId;
    registry.authorities["deployed-api"].authorityIdentitySha256 = origin.sha256(
      origin.stableJson({
        evidenceClass: "deployed-api",
        issuerId: registry.authorities["deployed-api"].issuerId,
        keyAlgorithm: "Ed25519",
        publicKeySpkiBase64:
          registry.authorities["deployed-api"].publicKeySpkiBase64,
        publicKeySha256:
          registry.authorities["deployed-api"].publicKeySha256,
      }),
    );
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "AUTHORITY_NOT_DISTINCT",
    );
  });

  await t.test("wrong class slot", () => {
    const registry = clone(harness.registry);
    registry.authorities["deployed-api"].evidenceClass = "natural-cycle";
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "AUTHORITY_CLASS_MISMATCH",
    );
  });
});

test("issuer substitution is refused before a foreign class key can be trusted", () => {
  const harness = buildHarness();
  const sample = issue(harness, "natural-cycle");
  const forged = clone(sample.receipt);
  forged.issuerId = harness.registry.authorities["deployed-api"].issuerId;
  forged.publicKeySha256 =
    harness.registry.authorities["deployed-api"].publicKeySha256;
  resignReceipt(forged, harness.keyPairs["deployed-api"].privateKey);
  expectCode(
    () =>
      origin.verifyOriginEvidence(forged, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
      }),
    "ISSUER_SUBSTITUTION",
  );
});

test("a structurally perfect receipt re-signed by an unpinned local key fails", () => {
  const harness = buildHarness();
  const sample = issue(harness, "deployed-api");
  const wrongKey = crypto.generateKeyPairSync("ed25519");
  const forged = resignReceipt(clone(sample.receipt), wrongKey.privateKey);
  assert.equal(forged.receiptHash, receiptHash(forged));
  expectCode(
    () =>
      origin.verifyOriginEvidence(forged, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
      }),
    "INVALID_ORIGIN_SIGNATURE",
  );
});

test("a self-hashed receipt with invented signature bytes fails", () => {
  const harness = buildHarness();
  const sample = issue(harness, "browser-capture");
  const forged = clone(sample.receipt);
  forged.signatureBase64 = Buffer.alloc(64, 17).toString("base64");
  rehashReceipt(forged);
  expectCode(
    () =>
      origin.verifyOriginEvidence(forged, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
      }),
    "INVALID_ORIGIN_SIGNATURE",
  );
});

test("the signer refuses a private key that is not pinned for the class", () => {
  const harness = buildHarness();
  const body = bodyFor("natural-cycle");
  expectCode(
    () =>
      origin.issueOriginEvidenceReceipt({
        registry: harness.registry,
        evidenceClass: "natural-cycle",
        body,
        privateKey: harness.keyPairs["change"].privateKey,
      }),
    "UNPINNED_SIGNING_KEY",
  );
});

test("one nonce is globally one-use across evidence classes", () => {
  const harness = buildHarness();
  const sharedNonce = nonce("cross-class");
  const natural = issue(harness, "natural-cycle", { nonce: sharedNonce });
  const api = issue(harness, "deployed-api", { nonce: sharedNonce });
  const replayStore = origin.createInMemoryReplayStore();

  origin.verifyAndConsumeOriginEvidence(natural.receipt, {
    registry: harness.registry,
    expected: natural.expected,
    nowMs: NOW_MS,
    replayStore,
  });
  expectCode(
    () =>
      origin.verifyAndConsumeOriginEvidence(api.receipt, {
        registry: harness.registry,
        expected: api.expected,
        nowMs: NOW_MS,
        replayStore,
      }),
    "REPLAY_DETECTED",
  );
  assert.equal(
    origin.replayKeyForNonce(natural.body.nonce),
    origin.replayKeyForNonce(api.body.nonce),
  );
});

test("the same receipt and nonce cannot be consumed twice", () => {
  const harness = buildHarness();
  const sample = issue(harness, "change");
  const replayStore = origin.createInMemoryReplayStore();
  const options = {
    registry: harness.registry,
    expected: sample.expected,
    nowMs: NOW_MS,
    replayStore,
  };
  origin.verifyAndConsumeOriginEvidence(sample.receipt, options);
  expectCode(
    () => origin.verifyAndConsumeOriginEvidence(sample.receipt, options),
    "REPLAY_DETECTED",
  );
  assert.equal(replayStore.size(), 1);
});

test("stale and future origin observations fail with exact temporal boundaries", async (t) => {
  const harness = buildHarness();

  await t.test("stale", () => {
    const observedAt = new Date(
      NOW_MS - origin.CLASS_CONFIG["deployed-api"].maximumAgeMs - 1,
    ).toISOString();
    const sample = issue(harness, "deployed-api", { observedAt });
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "STALE_EVIDENCE",
    );
  });

  await t.test("future", () => {
    const observedAt = new Date(
      NOW_MS + origin.MAX_FUTURE_SKEW_MS + 1,
    ).toISOString();
    const sample = issue(harness, "browser-capture", { observedAt });
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "FUTURE_EVIDENCE",
    );
  });

  await t.test("age boundary", () => {
    const observedAt = new Date(
      NOW_MS - origin.CLASS_CONFIG.change.maximumAgeMs,
    ).toISOString();
    const sample = issue(harness, "change", { observedAt });
    assert.equal(
      origin.verifyOriginEvidence(sample.receipt, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
      }).ok,
      true,
    );
  });

  await t.test("future-skew boundary", () => {
    const observedAt = new Date(
      NOW_MS + origin.MAX_FUTURE_SKEW_MS,
    ).toISOString();
    const sample = issue(harness, "natural-cycle", { observedAt });
    assert.equal(
      origin.verifyOriginEvidence(sample.receipt, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
      }).ok,
      true,
    );
  });
});

test("expected context binds commit, tree, deployment, source, time, nonce, and phase", () => {
  const harness = buildHarness();
  const sample = issue(harness, "natural-cycle");
  const substitutions = {
    phaseId: "TRUTH-02",
    ledgerRevision: 8,
    candidateCommit: "c".repeat(40),
    candidateTree: "d".repeat(40),
    deploymentId: "dpl_01JOTHER",
    sourceId: "different/source",
    observedAt: "2026-07-24T11:58:59.000Z",
    nonce: nonce("different"),
  };
  for (const [field, value] of Object.entries(substitutions)) {
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: harness.registry,
          expected: { ...sample.expected, [field]: value },
          nowMs: NOW_MS,
        }),
      "EXPECTED_CONTEXT_MISMATCH",
    );
  }
});

test("wrong class and wrong pinned registry are refused", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "deployed-api");

  await t.test("wrong class", () => {
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: harness.registry,
          expected: {
            ...sample.expected,
            evidenceClass: "browser-capture",
          },
          nowMs: NOW_MS,
        }),
      "EVIDENCE_CLASS_MISMATCH",
    );
  });

  await t.test("wrong registry", () => {
    const foreign = buildHarness();
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: foreign.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "REGISTRY_BINDING_MISMATCH",
    );
  });
});

test("envelope, body, expected-context, and registry field injection fail closed", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "natural-cycle");

  await t.test("envelope", () => {
    const receipt = { ...sample.receipt, locallyTrusted: true };
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "UNEXPECTED_FIELDS",
    );
  });

  await t.test("body", () => {
    const receipt = clone(sample.receipt);
    receipt.body.locallyObserved = true;
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "UNEXPECTED_FIELDS",
    );
  });

  await t.test("expected context", () => {
    const expected = { ...sample.expected, trustLocalHash: true };
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: harness.registry,
          expected,
          nowMs: NOW_MS,
        }),
      "UNEXPECTED_FIELDS",
    );
  });

  await t.test("registry", () => {
    const registry = { ...harness.registry, localSignerAllowed: true };
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "UNEXPECTED_FIELDS",
    );
  });

  await t.test("nested authority", () => {
    const registry = clone(harness.registry);
    registry.authorities["natural-cycle"].privateKey = "forbidden";
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "UNEXPECTED_FIELDS",
    );
  });
});

test("body mutation cannot survive its body hash or pinned signature", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "deployed-api");

  await t.test("body hash catches direct mutation", () => {
    const receipt = clone(sample.receipt);
    receipt.body.responseBodySha256 = digest("mutated-api-body");
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "BODY_HASH_MISMATCH",
    );
  });

  await t.test("signature catches fully rehashed body mutation", () => {
    const receipt = clone(sample.receipt);
    receipt.body.responseBodySha256 = digest("mutated-and-rehashed-api-body");
    receipt.bodySha256 = origin.sha256(origin.stableJson(receipt.body));
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "INVALID_ORIGIN_SIGNATURE",
    );
  });
});

test("signature, receipt hash, replay key, algorithm, and authority bits are immutable", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "browser-capture");

  await t.test("signature mutation", () => {
    const receipt = clone(sample.receipt);
    const signature = Buffer.from(receipt.signatureBase64, "base64");
    signature[0] ^= 0x01;
    receipt.signatureBase64 = signature.toString("base64");
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "INVALID_ORIGIN_SIGNATURE",
    );
  });

  await t.test("receipt hash mutation", () => {
    const receipt = clone(sample.receipt);
    receipt.receiptHash = digest("wrong-receipt-hash");
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "RECEIPT_HASH_MISMATCH",
    );
  });

  await t.test("replay key mutation", () => {
    const receipt = clone(sample.receipt);
    receipt.replayKeySha256 = digest("wrong-replay-key");
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "REPLAY_KEY_MISMATCH",
    );
  });

  await t.test("algorithm mutation", () => {
    const receipt = clone(sample.receipt);
    receipt.signatureAlgorithm = "self-hash";
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "INVALID_SIGNATURE_ALGORITHM",
    );
  });

  await t.test("production authority mutation", () => {
    const receipt = clone(sample.receipt);
    receipt.productionAuthority = true;
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "PRODUCTION_AUTHORITY_FORBIDDEN",
    );
  });

  await t.test("noncanonical signature", () => {
    const receipt = clone(sample.receipt);
    receipt.signatureBase64 = "not base64";
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "INVALID_BASE64",
    );
  });
});

test("class-specific schemas reject unsafe or incomplete evidence", async (t) => {
  const harness = buildHarness();

  await t.test("natural identifiers must be independent", () => {
    const body = bodyFor("natural-cycle");
    body.databaseObservationId = body.hostedWorkerExecutionId;
    expectCode(
      () =>
        origin.issueOriginEvidenceReceipt({
          registry: harness.registry,
          evidenceClass: "natural-cycle",
          body,
          privateKey: harness.keyPairs["natural-cycle"].privateKey,
        }),
      "IDENTIFIERS_NOT_DISTINCT",
    );
  });

  await t.test("API evidence is read-only", () => {
    const body = bodyFor("deployed-api", { requestMethod: "POST" });
    expectCode(
      () =>
        origin.issueOriginEvidenceReceipt({
          registry: harness.registry,
          evidenceClass: "deployed-api",
          body,
          privateKey: harness.keyPairs["deployed-api"].privateKey,
        }),
      "UNSAFE_API_METHOD",
    );
  });

  await t.test("API status is bounded", () => {
    const body = bodyFor("deployed-api", { responseStatus: 999 });
    expectCode(
      () => origin.validateEvidenceBody(body, "deployed-api"),
      "INVALID_HTTP_STATUS",
    );
  });

  await t.test("API and browser URLs are canonical credential-free HTTPS", () => {
    const api = bodyFor("deployed-api", {
      requestUrl: "https://user:secret@example.com/api",
    });
    expectCode(
      () => origin.validateEvidenceBody(api, "deployed-api"),
      "INVALID_URL",
    );
    const browser = bodyFor("browser-capture", {
      pageUrl: "http://pq-ops-demo.example/",
    });
    expectCode(
      () => origin.validateEvidenceBody(browser, "browser-capture"),
      "INVALID_URL",
    );
  });

  await t.test("browser viewport is exact and positive", () => {
    const body = bodyFor("browser-capture");
    body.viewport.width = 0;
    expectCode(
      () => origin.validateEvidenceBody(body, "browser-capture"),
      "INVALID_INTEGER",
    );
    body.viewport.width = 1440;
    body.viewport.localOnly = true;
    expectCode(
      () => origin.validateEvidenceBody(body, "browser-capture"),
      "UNEXPECTED_FIELDS",
    );
  });

  await t.test("change hashes are real lowercase SHA-256 values", () => {
    const body = bodyFor("change", { preimageSha256: "0".repeat(63) });
    expectCode(
      () => origin.validateEvidenceBody(body, "change"),
      "INVALID_SHA256",
    );
  });

  await t.test("promotion requires two distinct natural cycles", () => {
    const one = bodyFor("promotion-readback", {
      naturalCycleReceiptHashes: [digest("one")],
    });
    expectCode(
      () => origin.validateEvidenceBody(one, "promotion-readback"),
      "INVALID_NATURAL_CYCLE_SET",
    );
    const duplicateHash = digest("duplicate");
    const duplicate = bodyFor("promotion-readback", {
      naturalCycleReceiptHashes: [duplicateHash, duplicateHash],
    });
    expectCode(
      () => origin.validateEvidenceBody(duplicate, "promotion-readback"),
      "DUPLICATE_NATURAL_CYCLE",
    );
  });

  await t.test("promotion soak ends exactly at observation", () => {
    const body = bodyFor("promotion-readback", {
      soakEndedAt: "2026-07-24T11:58:00.000Z",
    });
    expectCode(
      () => origin.validateEvidenceBody(body, "promotion-readback"),
      "INVALID_SOAK_WINDOW",
    );
  });
});

test("bounded canonical encoding refuses oversized, cyclic, and unsupported data", () => {
  const harness = buildHarness();
  const oversized = bodyFor("deployed-api", {
    requestId: `x${"y".repeat(origin.MAX_BODY_BYTES)}`,
  });
  expectCode(
    () => origin.validateEvidenceBody(oversized, "deployed-api"),
    "SIZE_LIMIT_EXCEEDED",
  );

  const cyclic = {};
  cyclic.self = cyclic;
  expectCode(() => origin.stableJson(cyclic), "NON_CANONICAL_JSON");
  expectCode(() => origin.stableJson({ invalid: 1.5 }), "NON_CANONICAL_JSON");
  expectCode(() => origin.stableJson({ invalid: undefined }), "NON_CANONICAL_JSON");

  const sample = issue(harness, "natural-cycle");
  const oversizedReceipt = {
    ...sample.receipt,
    extra: "x".repeat(origin.MAX_RECEIPT_BYTES),
  };
  expectCode(
    () =>
      origin.verifyOriginEvidence(oversizedReceipt, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
      }),
    "SIZE_LIMIT_EXCEEDED",
  );
});

test("replay consumption fails closed for missing, asynchronous, throwing, or malformed stores", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "change");
  const base = {
    registry: harness.registry,
    expected: sample.expected,
    nowMs: NOW_MS,
  };

  await t.test("missing", () => {
    expectCode(
      () =>
        origin.verifyAndConsumeOriginEvidence(sample.receipt, {
          ...base,
          replayStore: null,
        }),
      "INVALID_REPLAY_STORE",
    );
  });

  await t.test("async result", () => {
    expectCode(
      () =>
        origin.verifyAndConsumeOriginEvidence(sample.receipt, {
          ...base,
          replayStore: {
            consume() {
              return Promise.resolve(true);
            },
          },
        }),
      "REPLAY_DETECTED",
    );
  });

  await t.test("throwing store", () => {
    expectCode(
      () =>
        origin.verifyAndConsumeOriginEvidence(sample.receipt, {
          ...base,
          replayStore: {
            consume() {
              throw new Error("storage unavailable");
            },
          },
        }),
      "REPLAY_STORE_FAILURE",
    );
  });

  await t.test("store mutation validation", () => {
    const store = origin.createInMemoryReplayStore();
    expectCode(
      () =>
        store.consume({
          replayKeySha256: digest("wrong-key"),
          receiptHash: digest("receipt"),
          evidenceClass: "change",
          nonce: nonce("not-the-key"),
        }),
      "REPLAY_KEY_MISMATCH",
    );
  });
});

test("verification options and verification time are exact", () => {
  const harness = buildHarness();
  const sample = issue(harness, "natural-cycle");
  expectCode(
    () =>
      origin.verifyOriginEvidence(sample.receipt, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: NOW_MS,
        allowStale: true,
      }),
    "UNEXPECTED_FIELDS",
  );
  expectCode(
    () =>
      origin.verifyOriginEvidence(sample.receipt, {
        registry: harness.registry,
        expected: sample.expected,
        nowMs: -1,
      }),
    "INVALID_VERIFICATION_TIME",
  );
});

test("registry hashes and key identities are recomputed, not trusted strings", async (t) => {
  const harness = buildHarness();

  await t.test("registry hash", () => {
    const registry = clone(harness.registry);
    registry.registryHash = digest("invented-registry-hash");
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "REGISTRY_HASH_MISMATCH",
    );
  });

  await t.test("key hash", () => {
    const registry = clone(harness.registry);
    registry.authorities["natural-cycle"].publicKeySha256 =
      digest("invented-key-hash");
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "PUBLIC_KEY_HASH_MISMATCH",
    );
  });

  await t.test("authority identity", () => {
    const registry = clone(harness.registry);
    registry.authorities["natural-cycle"].authorityIdentitySha256 =
      digest("invented-authority-identity");
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "AUTHORITY_IDENTITY_MISMATCH",
    );
  });
});

test("HEAD-style API evidence and canonical signing bytes are deterministic", () => {
  const harness = buildHarness();
  const sample = issue(harness, "deployed-api", { requestMethod: "HEAD" });
  const first = origin.originEvidenceSigningBytes(sample.receipt);
  const second = origin.originEvidenceSigningBytes(clone(sample.receipt));
  assert.deepEqual(first, second);
  assert.equal(
    origin.verifyOriginEvidence(sample.receipt, {
      registry: harness.registry,
      expected: sample.expected,
      nowMs: NOW_MS,
    }).ok,
    true,
  );
});

test("malformed canonical values and timestamp or URL encodings fail closed", async (t) => {
  await t.test("cyclic array", () => {
    const cyclic = [];
    cyclic.push(cyclic);
    expectCode(() => origin.stableJson(cyclic), "NON_CANONICAL_JSON");
  });

  await t.test("invalid object key", () => {
    expectCode(() => origin.stableJson({ "": 1 }), "NON_CANONICAL_JSON");
    expectCode(
      () => origin.stableJson({ "bad\u0000key": 1 }),
      "NON_CANONICAL_JSON",
    );
  });

  await t.test("proxy serialization trap", () => {
    const trapped = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype unavailable");
        },
      },
    );
    expectCode(
      () => origin.validateAuthorityRegistry(trapped),
      "NON_CANONICAL_JSON",
    );
  });

  await t.test("canonical primitive array remains stable", () => {
    assert.equal(
      origin.stableJson(["value", 1, true, false, null]),
      '["value",1,true,false,null]',
    );
  });

  await t.test("timestamp type and spelling", () => {
    const nonString = bodyFor("change", { observedAt: 7 });
    expectCode(
      () => origin.validateEvidenceBody(nonString, "change"),
      "INVALID_TIMESTAMP",
    );
    const nonCanonical = bodyFor("change", {
      observedAt: "2026-07-24T11:59:00Z",
    });
    expectCode(
      () => origin.validateEvidenceBody(nonCanonical, "change"),
      "INVALID_TIMESTAMP",
    );
  });

  await t.test("unparseable and empty URL", () => {
    const invalid = bodyFor("deployed-api", { requestUrl: "not-a-url" });
    expectCode(
      () => origin.validateEvidenceBody(invalid, "deployed-api"),
      "INVALID_URL",
    );
    const empty = bodyFor("deployed-api", { requestUrl: "" });
    expectCode(
      () => origin.validateEvidenceBody(empty, "deployed-api"),
      "INVALID_STRING",
    );
  });
});

test("authority constructors and registries reject unsupported cryptographic material", async (t) => {
  const harness = buildHarness();
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

  await t.test("unsupported class", () => {
    expectCode(
      () =>
        origin.buildAuthorityRecord({
          evidenceClass: "production-approval",
          issuerId: "unsupported.class",
          publicKey: harness.keyPairs.change.publicKey,
        }),
      "INVALID_EVIDENCE_CLASS",
    );
  });

  await t.test("invalid public key import", () => {
    expectCode(
      () =>
        origin.buildAuthorityRecord({
          evidenceClass: "change",
          issuerId: "invalid.public.key",
          publicKey: "not a key",
        }),
      "INVALID_PUBLIC_KEY",
    );
  });

  await t.test("non-Ed25519 public key", () => {
    expectCode(
      () =>
        origin.buildAuthorityRecord({
          evidenceClass: "change",
          issuerId: "rsa.public.key",
          publicKey: rsa.publicKey,
        }),
      "INVALID_PUBLIC_KEY",
    );
  });

  await t.test("wrong registry schema", () => {
    const registry = clone(harness.registry);
    registry.schema = "pikiio-origin-evidence-authority-registry-v0";
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "INVALID_REGISTRY",
    );
  });

  await t.test("wrong declared algorithm", () => {
    const registry = clone(harness.registry);
    registry.authorities.change.keyAlgorithm = "RSA";
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "INVALID_KEY_ALGORITHM",
    );
  });

  await t.test("malformed SPKI", () => {
    const registry = clone(harness.registry);
    const malformed = Buffer.from("not-spki", "utf8");
    registry.authorities.change.publicKeySpkiBase64 =
      malformed.toString("base64");
    registry.authorities.change.publicKeySha256 = origin.sha256(malformed);
    registry.authorities.change.authorityIdentitySha256 = origin.sha256(
      origin.stableJson({
        evidenceClass: "change",
        issuerId: registry.authorities.change.issuerId,
        keyAlgorithm: "Ed25519",
        publicKeySpkiBase64:
          registry.authorities.change.publicKeySpkiBase64,
        publicKeySha256: registry.authorities.change.publicKeySha256,
      }),
    );
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "INVALID_PUBLIC_KEY",
    );
  });

  await t.test("non-Ed25519 SPKI", () => {
    const registry = clone(harness.registry);
    const der = rsa.publicKey.export({ format: "der", type: "spki" });
    registry.authorities.change.publicKeySpkiBase64 = der.toString("base64");
    registry.authorities.change.publicKeySha256 = origin.sha256(der);
    registry.authorities.change.authorityIdentitySha256 = origin.sha256(
      origin.stableJson({
        evidenceClass: "change",
        issuerId: registry.authorities.change.issuerId,
        keyAlgorithm: "Ed25519",
        publicKeySpkiBase64:
          registry.authorities.change.publicKeySpkiBase64,
        publicKeySha256: registry.authorities.change.publicKeySha256,
      }),
    );
    rehashRegistry(registry);
    expectCode(
      () => origin.validateAuthorityRegistry(registry),
      "INVALID_BASE64",
    );
  });

  await t.test("invalid private key import", () => {
    expectCode(
      () =>
        origin.issueOriginEvidenceReceipt({
          registry: harness.registry,
          evidenceClass: "change",
          body: bodyFor("change"),
          privateKey: "not a private key",
        }),
      "INVALID_PRIVATE_KEY",
    );
  });

  await t.test("non-Ed25519 private key", () => {
    expectCode(
      () =>
        origin.issueOriginEvidenceReceipt({
          registry: harness.registry,
          evidenceClass: "change",
          body: bodyFor("change"),
          privateKey: rsa.privateKey,
        }),
      "INVALID_PRIVATE_KEY",
    );
  });
});

test("unsupported classes and body or receipt schema substitutions are rejected", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "natural-cycle");

  await t.test("body class", () => {
    expectCode(
      () => origin.validateEvidenceBody({}, "production-approval"),
      "INVALID_EVIDENCE_CLASS",
    );
  });

  await t.test("body schema", () => {
    const body = bodyFor("natural-cycle", {
      schema: "pikiio-origin-natural-cycle-v0",
    });
    expectCode(
      () => origin.validateEvidenceBody(body, "natural-cycle"),
      "BODY_SCHEMA_MISMATCH",
    );
  });

  await t.test("expected class", () => {
    const expected = {
      ...sample.expected,
      evidenceClass: "production-approval",
    };
    expectCode(
      () =>
        origin.verifyOriginEvidence(sample.receipt, {
          registry: harness.registry,
          expected,
          nowMs: NOW_MS,
        }),
      "INVALID_EVIDENCE_CLASS",
    );
  });

  await t.test("issuer class", () => {
    expectCode(
      () =>
        origin.issueOriginEvidenceReceipt({
          registry: harness.registry,
          evidenceClass: "production-approval",
          body: {},
          privateKey: harness.keyPairs.change.privateKey,
        }),
      "INVALID_EVIDENCE_CLASS",
    );
  });

  await t.test("receipt schema", () => {
    const receipt = clone(sample.receipt);
    receipt.schema = "pikiio-origin-evidence-receipt-v0";
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "INVALID_RECEIPT_SCHEMA",
    );
  });

  await t.test("receipt registry binding", () => {
    const receipt = clone(sample.receipt);
    receipt.authorityRegistrySha256 = digest("different-registry");
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "REGISTRY_BINDING_MISMATCH",
    );
  });

  await t.test("invalid signing shape", () => {
    expectCode(
      () => origin.originEvidenceSigningBytes({ schema: "incomplete" }),
      "UNEXPECTED_FIELDS",
    );
  });
});

test("signature lengths and replay-store classes are exact", async (t) => {
  const harness = buildHarness();
  const sample = issue(harness, "change");

  await t.test("short signature", () => {
    const receipt = clone(sample.receipt);
    receipt.signatureBase64 = Buffer.alloc(32).toString("base64");
    rehashReceipt(receipt);
    expectCode(
      () =>
        origin.verifyOriginEvidence(receipt, {
          registry: harness.registry,
          expected: sample.expected,
          nowMs: NOW_MS,
        }),
      "INVALID_BASE64",
    );
  });

  await t.test("unknown replay class", () => {
    const store = origin.createInMemoryReplayStore();
    const testNonce = nonce("unknown-replay-class");
    expectCode(
      () =>
        store.consume({
          replayKeySha256: origin.replayKeyForNonce(testNonce),
          receiptHash: digest("unknown-replay-receipt"),
          evidenceClass: "production-approval",
          nonce: testNonce,
        }),
      "INVALID_EVIDENCE_CLASS",
    );
  });

  await t.test("replay field injection", () => {
    const store = origin.createInMemoryReplayStore();
    const testNonce = nonce("replay-injection");
    expectCode(
      () =>
        store.consume({
          replayKeySha256: origin.replayKeyForNonce(testNonce),
          receiptHash: digest("replay-injection-receipt"),
          evidenceClass: "change",
          nonce: testNonce,
          allowDuplicate: true,
        }),
      "UNEXPECTED_FIELDS",
    );
  });
});

"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const quality = require("../lib/pikiio-quality-contract-v3");
const binding = require("../lib/pikiio-quality-contract-binding-v1");
const policy = require("../lib/pikiio-quality-artifact-policy");

const POLICY_PATH = path.resolve(
  __dirname,
  "../lib/pikiio-quality-artifact-policy.js",
);
const CONTRACT_PATH = path.resolve(
  __dirname,
  "../lib/pikiio-quality-contract-v3.js",
);
const CONTRACT_TEST_PATH = path.resolve(
  __dirname,
  "./pikiio-quality-contract-v3.test.js",
);
const BINDING_PATH = path.resolve(
  __dirname,
  "../lib/pikiio-quality-contract-binding-v1.js",
);

function digest(seed) {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(seed) ? seed : String(seed))
    .digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function role(root, pathValue) {
  return {
    schema: policy.ROLE_SCHEMA,
    root,
    path: pathValue,
  };
}

function enumeration(root, value) {
  return {
    schema: policy.ENUMERATION_SCHEMA,
    root,
    value,
  };
}

function artifactFor(root, pathValue, seed, overrides = {}) {
  const rolePolicy = policy.lookupArtifactRole(role(root, pathValue));
  const sha256 = digest(seed);
  return {
    schema: quality.SCHEMAS.artifactRef,
    address: `sha256:${sha256}`,
    sha256,
    byteLength: 128,
    mediaType: rolePolicy.mediaType,
    ...overrides,
  };
}

function expectCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function makeLayerPass(root, sourcePrefix, layerId, seedPrefix = root) {
  const rolePrefix =
    root === "quality_receipt" ? ["layerResults"] : ["layers"];
  const specializedOutputs = Object.entries(
    binding.SPECIALIZED_ARTIFACT_PROVENANCE,
  ).filter(
    ([, provenance]) =>
      provenance.kind === "layer_output" &&
      provenance.layerId === layerId,
  );
  const outputCardinality =
    specializedOutputs.length === 0
      ? 1
      : specializedOutputs[0][1].outputCardinality;
  return {
    schema: quality.SCHEMAS.layerPass,
    layerId,
    executions: [
      artifactFor(
        root,
        [...rolePrefix, layerId, "executions", 0],
        `${seedPrefix}-${sourcePrefix}-execution`,
      ),
    ],
    rawPopulationArtifact: artifactFor(
      root,
      [...rolePrefix, layerId, "rawPopulationArtifact"],
      `${seedPrefix}-${sourcePrefix}-population`,
    ),
    outputArtifacts: Array.from({ length: outputCardinality }, (_, index) =>
      artifactFor(
        root,
        [...rolePrefix, layerId, "outputArtifacts", index],
        `${seedPrefix}-${sourcePrefix}-output-${index}`,
      ),
    ),
  };
}

function setPath(value, pathValue, next) {
  let cursor = value;
  for (const segment of pathValue.slice(0, -1)) {
    if (
      cursor[segment] === null ||
      typeof cursor[segment] !== "object"
    ) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[pathValue.at(-1)] = next;
}

function makeQualityReceipt(seedPrefix = "quality") {
  const layerResults = {};
  for (const layerId of policy.EXPECTED_LAYER_IDS) {
    layerResults[layerId] = makeLayerPass(
      "quality_receipt",
      layerId,
      layerId,
      seedPrefix,
    );
  }
  const value = {
    schema: quality.SCHEMAS.qualityReceipt,
    layerResults,
  };

  for (const [roleName, provenance] of Object.entries(
    binding.SPECIALIZED_ARTIFACT_PROVENANCE,
  )) {
    const pathByRole = {
      coverage: ["coverage"],
      mutation: ["mutation"],
      executionMatrix: ["executionMatrix", "artifact"],
      operationalBeforeManifest: [
        "operationalIntegrity",
        "beforeManifest",
      ],
      operationalAfterManifest: [
        "operationalIntegrity",
        "afterManifest",
      ],
      operationalAutomationInputs: [
        "operationalIntegrity",
        "automationInputs",
      ],
      crashRestart: ["crashRestart"],
      concurrencyLinearizability: ["concurrencyLinearizability"],
      schemaParserRobustness: ["schemaParserRobustness"],
      independentFrozenHashReview: [
        "independentFrozenHashReview",
        "artifact",
      ],
      antiWeakening: ["antiWeakening"],
      primaryJudge: ["primaryJudge"],
      independentJudge: ["independentJudge"],
      rawEvidenceManifest: ["rawEvidenceManifest"],
    };
    const pathValue = pathByRole[roleName];
    const artifact =
      provenance.kind === "layer_output"
        ? clone(
            layerResults[provenance.layerId].outputArtifacts[
              provenance.outputIndex
            ],
          )
        : artifactFor(
            "quality_receipt",
            pathValue,
            `${seedPrefix}-${roleName}`,
          );
    setPath(value, pathValue, artifact);
  }
  Object.assign(value.executionMatrix, {
    matrixSha256: digest(`${seedPrefix}-matrix`),
    expectedExecutionCount: 1,
    observedExecutionCount: 1,
    missingCoordinateCount: 0,
    duplicateCoordinateCount: 0,
    divergentCoordinateCount: 0,
  });
  value.independentFrozenHashReview.receiptHash =
    value.independentFrozenHashReview.artifact.sha256;
  return value;
}

function makeExecutionObservation(
  seedPrefix = "execution",
  overrides = {},
) {
  const layerId = overrides.layerId || "unit";
  const value = {
    schema: quality.SCHEMAS.executionObservation,
    executionId: `${seedPrefix}-id`,
    layerId,
    checkId: `${seedPrefix}-check`,
    definitionSha256: digest(`${seedPrefix}-definition`),
    repeat: 1,
    seed: `${seedPrefix}-seed`,
    timeZone: "America/New_York",
    orderId: "forward",
    fixtureManifestSha256: digest(`${seedPrefix}-fixture`),
    stdoutArtifact: artifactFor(
      "execution_observation",
      ["layers", layerId, "stdoutArtifact"],
      `${seedPrefix}-stdout`,
    ),
    stderrArtifact: artifactFor(
      "execution_observation",
      ["layers", layerId, "stderrArtifact"],
      `${seedPrefix}-stderr`,
    ),
    parsedOutputArtifact: artifactFor(
      "execution_observation",
      ["layers", layerId, "parsedOutputArtifact"],
      `${seedPrefix}-parsed`,
    ),
  };
  Object.assign(value, overrides);
  return value;
}

function makeCandidateReceipt(seedPrefix = "candidate") {
  const value = { schema: quality.SCHEMAS.candidateReceipt };
  for (const field of [
    "authoritySnapshot",
    "changedPathsManifest",
    "changedPathCoverage",
    "assertions",
    "rawArtifact",
  ]) {
    value[field] = artifactFor(
      "candidate_receipt",
      [field],
      `${seedPrefix}-${field}`,
    );
  }
  return value;
}

function makeAttestationBody(seedPrefix = "attestation") {
  const artifacts = {};
  for (const field of [
    "sourceManifest",
    "qualityReceipt",
    "candidateReceipt",
    "frozenReviewReceipt",
    "evidenceManifest",
    "primaryRaw",
    "independentRaw",
    "rehearsalReceipt",
    "changeReceipt",
    "promotionReceipt",
  ]) {
    artifacts[field] = artifactFor(
      "attestation_body",
      ["artifacts", field],
      `${seedPrefix}-${field}`,
    );
  }
  return { schema: quality.SCHEMAS.attestationBody, artifacts };
}

function representativeEnumerations() {
  const reviewed = artifactFor(
    "frozen_review",
    ["reviewedManifest"],
    "frozen-manifest",
  );
  return [
    enumeration("quality_policy", {
      schema: quality.SCHEMAS.qualityPolicy,
      approvedToolchains: [
        artifactFor(
          "quality_policy",
          ["approvedToolchains", 0],
          "approved-toolchain",
        ),
      ],
      phaseProofRegistry: artifactFor(
        "quality_policy",
        ["phaseProofRegistry"],
        "phase-proof-registry",
      ),
    }),
    enumeration(
      "execution_observation",
      makeExecutionObservation("representative"),
    ),
    enumeration("verifier_output", {
      schema: quality.SCHEMAS.verifierOutput,
      layerId: "focused_verifier",
      rawResultArtifact: artifactFor(
        "verifier_output",
        ["layers", "focused_verifier", "rawResultArtifact"],
        "verifier-raw",
      ),
    }),
    enumeration(
      "layer_pass",
      makeLayerPass("layer_pass", "standalone", "unit", "layer"),
    ),
    enumeration("coverage_input_manifest", {
      schema: quality.SCHEMAS.coverageInputManifest,
      orderedInputs: [
        {
          artifact: artifactFor(
            "coverage_input_manifest",
            ["orderedInputs", 0, "artifact"],
            "coverage-input",
          ),
        },
      ],
    }),
    enumeration("coverage_proof", {
      schema: quality.SCHEMAS.coverageProof,
      inputManifest: {
        orderedInputs: [
          {
            artifact: artifactFor(
              "coverage_proof",
              ["inputManifest", "orderedInputs", 0, "artifact"],
              "coverage-proof-input",
            ),
          },
        ],
      },
      files: [
        {
          uncoveredRangesArtifact: artifactFor(
            "coverage_proof",
            ["files", 0, "uncoveredRangesArtifact"],
            "uncovered-ranges",
          ),
        },
      ],
    }),
    enumeration("operational_manifest", {
      schema: quality.SCHEMAS.operationalManifest,
      automationInputsArtifact: artifactFor(
        "operational_manifest",
        ["automationInputsArtifact"],
        "operational-automation",
      ),
      dependencyManifestArtifact: artifactFor(
        "operational_manifest",
        ["dependencyManifestArtifact"],
        "operational-dependency",
      ),
      toolchainManifestArtifact: artifactFor(
        "operational_manifest",
        ["toolchainManifestArtifact"],
        "operational-toolchain",
      ),
    }),
    enumeration("crash_population", {
      schema: quality.SCHEMAS.crashPopulation,
      cases: [
        {
          preStateArtifact: artifactFor(
            "crash_population",
            ["cases", 0, "preStateArtifact"],
            "crash-pre",
          ),
          postCrashStateArtifact: artifactFor(
            "crash_population",
            ["cases", 0, "postCrashStateArtifact"],
            "crash-post",
          ),
          recoveryArtifact: artifactFor(
            "crash_population",
            ["cases", 0, "recoveryArtifact"],
            "crash-recovery",
          ),
        },
      ],
    }),
    enumeration("concurrency_population", {
      schema: quality.SCHEMAS.concurrencyPopulation,
      cases: [
        {
          scheduleArtifact: artifactFor(
            "concurrency_population",
            ["cases", 0, "scheduleArtifact"],
            "concurrency-schedule",
          ),
          operationsArtifact: artifactFor(
            "concurrency_population",
            ["cases", 0, "operationsArtifact"],
            "concurrency-operations",
          ),
          acceptedOrderingArtifact: artifactFor(
            "concurrency_population",
            ["cases", 0, "acceptedOrderingArtifact"],
            "concurrency-order",
          ),
        },
      ],
    }),
    enumeration("parser_population", {
      schema: quality.SCHEMAS.parserPopulation,
      cases: [
        {
          inputArtifact: artifactFor(
            "parser_population",
            ["cases", 0, "inputArtifact"],
            "parser-input",
          ),
        },
      ],
    }),
    enumeration("frozen_review", {
      schema: quality.SCHEMAS.frozenReview,
      reviewedManifest: reviewed,
      postReviewManifest: clone(reviewed),
      findings: [
        {
          locationArtifact: artifactFor(
            "frozen_review",
            ["findings", 0, "locationArtifact"],
            "finding-location",
          ),
          findingArtifact: artifactFor(
            "frozen_review",
            ["findings", 0, "findingArtifact"],
            "finding-body",
          ),
        },
      ],
      closureReceipts: [
        artifactFor(
          "frozen_review",
          ["closureReceipts", 0],
          "closure-receipt",
        ),
      ],
      certifierRuns: [
        artifactFor(
          "frozen_review",
          ["certifierRuns", 0],
          "certifier-run",
        ),
      ],
      coordinatorRerun: artifactFor(
        "frozen_review",
        ["coordinatorRerun"],
        "coordinator-rerun",
      ),
    }),
    enumeration("quality_receipt", makeQualityReceipt()),
    enumeration("candidate_receipt", makeCandidateReceipt()),
    enumeration("attestation_body", makeAttestationBody()),
  ];
}

test("policy is stable, frozen, dormant, and pinned to the exact 21-layer contract", () => {
  assert.deepEqual(policy.EXPECTED_LAYER_IDS, quality.EVIDENCE_LAYER_IDS);
  assert.equal(policy.EXPECTED_LAYER_IDS.length, 21);
  assert.equal(policy.ARTIFACT_POLICY.schema, policy.POLICY_SCHEMA);
  const body = clone(policy.ARTIFACT_POLICY);
  delete body.policySha256;
  assert.equal(
    digest(quality.stableJson(body)),
    policy.ARTIFACT_POLICY_SHA256,
  );
  assert.equal(
    policy.ARTIFACT_POLICY_SHA256,
    "4dcaf23f3d7e794fee4a121052176d6401059b9b91063d2f7898289b440aa88a",
  );
  assert.equal(policy.ARTIFACT_POLICY.policySha256, policy.ARTIFACT_POLICY_SHA256);
  assert.equal(Object.isFrozen(policy.ARTIFACT_POLICY), true);
  assert.equal(Object.isFrozen(policy.ARTIFACT_POLICY.roleTemplates), true);
  assert.equal(Object.isFrozen(policy.ALLOWED_ALIAS_PAIRS), true);

  const booleans = [];
  const forbiddenKeys = [];
  function inspect(value, pathValue = []) {
    if (typeof value === "boolean") booleans.push(pathValue.join("."));
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (/authoriz|productionAuthority|builderAuthority/i.test(key)) {
        forbiddenKeys.push([...pathValue, key].join("."));
      }
      inspect(value[key], [...pathValue, key]);
    }
  }
  inspect(policy.ARTIFACT_POLICY);
  assert.deepEqual(booleans, []);
  assert.deepEqual(forbiddenKeys, []);

  const first = quality.stableJson(policy.ARTIFACT_POLICY);
  const second = quality.stableJson(policy.ARTIFACT_POLICY);
  const third = quality.stableJson(policy.ARTIFACT_POLICY);
  assert.equal(first, second);
  assert.equal(second, third);
});

test("generated contract binding pins exact bytes, sites, provenance, and has no ambient fallback", () => {
  assert.equal(binding.CONTRACT_SOURCE_SHA256, digest(fs.readFileSync(CONTRACT_PATH)));
  assert.equal(
    binding.CONTRACT_TEST_SHA256,
    digest(fs.readFileSync(CONTRACT_TEST_PATH)),
  );
  assert.equal(
    binding.CONTRACT_BINDING.contractSourceSha256,
    "1176f76d90a03cbd80a4416fc452667c49c9fd6338554f500fa76385818c5c83",
  );
  assert.equal(
    binding.CONTRACT_BINDING.contractTestSha256,
    "385da8cc2a35f6d5d0a912d40b0c62ca024c5494d3bce5a2656133d4fa1e32f0",
  );
  const bindingBody = clone(binding.CONTRACT_BINDING);
  delete bindingBody.bindingSha256;
  assert.equal(
    digest(canonicalJson(bindingBody)),
    binding.CONTRACT_BINDING_SHA256,
  );
  assert.equal(
    binding.CONTRACT_BINDING.bindingSha256,
    binding.CONTRACT_BINDING_SHA256,
  );
  assert.equal(
    binding.CONTRACT_BINDING_SHA256,
    "8c459c26275d099387c672cf2bd535041634a56063cfa34a844da3efa54e379d",
  );
  assert.equal(
    digest(canonicalJson(binding.ARTIFACT_REF_SITE_MANIFEST)),
    binding.ARTIFACT_REF_SITE_MANIFEST_SHA256,
  );
  assert.equal(binding.stableJson, undefined);
  assert.equal(binding.EVIDENCE_LAYER_IDS.length, 21);
  assert.deepEqual(binding.EVIDENCE_LAYER_IDS, quality.EVIDENCE_LAYER_IDS);
  assert.deepEqual(
    binding.SPECIALIZED_ARTIFACT_PROVENANCE,
    quality.SPECIALIZED_ARTIFACT_PROVENANCE,
  );
  assert.equal(
    Object.keys(binding.SPECIALIZED_ARTIFACT_PROVENANCE).length,
    14,
  );
  assert.equal(binding.ARTIFACT_REF_SITE_MANIFEST.length, 61);
  assert.equal(Object.isFrozen(binding.CONTRACT_BINDING), true);
  assert.equal(Object.isFrozen(binding.CONTRACT_BINDING.artifactRefSites), true);
  assert.equal(Object.isFrozen(binding.SCHEMAS), true);
  assert.equal(Object.isFrozen(binding.EVIDENCE_LAYER_IDS), true);

  const policySource = fs.readFileSync(POLICY_PATH, "utf8");
  assert.equal(policySource.includes('require("./pikiio-quality-contract-v3")'), false);
  assert.equal(policySource.includes("node:fs"), false);
  assert.equal(
    policy.ARTIFACT_POLICY.contractBindingSha256,
    binding.CONTRACT_BINDING_SHA256,
  );
  assert.equal(
    policy.ARTIFACT_POLICY.contractSourceSha256,
    binding.CONTRACT_SOURCE_SHA256,
  );
  assert.equal(
    policy.ARTIFACT_POLICY.contractTestSha256,
    binding.CONTRACT_TEST_SHA256,
  );
});

test("binding ArtifactRef validator is exact, content-addressed, positive, and media-typed", () => {
  const valid = {
    schema: binding.SCHEMAS.artifactRef,
    address: `sha256:${digest("binding-ref")}`,
    sha256: digest("binding-ref"),
    byteLength: 1,
    mediaType: "application/json",
  };
  assert.deepEqual(binding.validateArtifactRef(valid), valid);
  assert.equal(Object.isFrozen(binding.validateArtifactRef(valid)), true);
  const cases = [
    [null, "EXACT_OBJECT_REQUIRED"],
    [[], "EXACT_OBJECT_REQUIRED"],
    [Object.create(null), "EXACT_OBJECT_REQUIRED"],
    [{ ...valid, extra: true }, "EXACT_KEYS_REQUIRED"],
    [{ ...valid, schema: "wrong" }, "SCHEMA_INVALID"],
    [{ ...valid, sha256: "x" }, "INVALID_SHA256"],
    [{ ...valid, address: `sha256:${digest("other")}` }, "ARTIFACT_ADDRESS_MISMATCH"],
    [{ ...valid, byteLength: 0 }, "INVALID_COUNTER"],
    [{ ...valid, byteLength: 0.5 }, "INVALID_COUNTER"],
    [{ ...valid, mediaType: "INVALID" }, "INVALID_STRING"],
  ];
  for (const [value, code] of cases) {
    expectCode(() => binding.validateArtifactRef(value), code);
  }

  let traps = 0;
  const proxy = new Proxy(valid, {
    getPrototypeOf() {
      traps += 1;
      return Object.prototype;
    },
    ownKeys(target) {
      traps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      traps += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  expectCode(() => binding.validateArtifactRef(proxy), "PROXY_REFUSED");
  assert.equal(traps, 0);
  const throwingProxy = new Proxy(valid, {
    getPrototypeOf() {
      throw new Error("must not execute");
    },
  });
  expectCode(
    () => binding.validateArtifactRef(throwingProxy),
    "PROXY_REFUSED",
  );
  const callableProxy = new Proxy(function callable() {}, {});
  expectCode(
    () => binding.validateArtifactRef(callableProxy),
    "PROXY_REFUSED",
  );
  const revoked = Proxy.revocable(valid, {});
  revoked.revoke();
  expectCode(
    () => binding.validateArtifactRef(revoked.proxy),
    "PROXY_REFUSED",
  );

  let getterCalls = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, "schema", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return binding.SCHEMAS.artifactRef;
    },
  });
  expectCode(
    () => binding.validateArtifactRef(accessor),
    "ACCESSOR_PROPERTY_REFUSED",
  );
  assert.equal(getterCalls, 0);
  const nonEnumerable = { ...valid };
  Object.defineProperty(nonEnumerable, "schema", {
    value: binding.SCHEMAS.artifactRef,
    enumerable: false,
  });
  expectCode(
    () => binding.validateArtifactRef(nonEnumerable),
    "ACCESSOR_PROPERTY_REFUSED",
  );
  const symbol = { ...valid };
  symbol[Symbol("hidden")] = true;
  expectCode(
    () => binding.validateArtifactRef(symbol),
    "SYMBOL_PROPERTY_REFUSED",
  );

});

test("every exported role template resolves exactly and exposes the agreed public shape", () => {
  const seen = new Set();
  for (const entry of policy.ARTIFACT_POLICY.roleTemplates) {
    const pathValue = entry.path.map((segment) =>
      segment && typeof segment === "object" && segment.kind === "index"
        ? 0
        : segment,
    );
    const canonical = policy.canonicalizeArtifactRole(
      role(entry.root, pathValue),
    );
    const lookedUp = policy.lookupArtifactRole(role(entry.root, pathValue));
    assert.equal(seen.has(canonical.roleId), false);
    seen.add(canonical.roleId);
    assert.deepEqual(Object.keys(lookedUp), [
      "roleId",
      "mediaType",
      "payloadSchema",
      "encoding",
      "maximumBytes",
      "validatorId",
      "selfHashField",
      "emission",
      "aliasRuleIds",
    ]);
    assert.equal(Object.isFrozen(canonical), true);
    assert.equal(Object.isFrozen(canonical.path), true);
    assert.equal(Object.isFrozen(lookedUp), true);
    assert.equal(lookedUp.maximumBytes > 0, true);
    assert.equal(
      lookedUp.maximumBytes <= policy.MAX_POLICY_ARTIFACT_BYTES,
      true,
    );
  }
  assert.equal(seen.size, policy.ARTIFACT_POLICY.roleTemplates.length);
});

test("parsed producer output and verifier raw output remain separate fixed roles", () => {
  const parsed = policy.lookupArtifactRole(
    role("execution_observation", [
      "layers",
      "focused_verifier",
      "parsedOutputArtifact",
    ]),
  );
  const verifier = policy.lookupArtifactRole(
    role("verifier_output", [
      "layers",
      "focused_verifier",
      "rawResultArtifact",
    ]),
  );
  assert.notEqual(parsed.roleId, verifier.roleId);
  assert.notEqual(parsed.payloadSchema, verifier.payloadSchema);
  assert.notEqual(parsed.validatorId, verifier.validatorId);
  assert.equal(parsed.encoding, policy.ENCODINGS.CANONICAL_JSON);
  assert.equal(verifier.encoding, policy.ENCODINGS.CANONICAL_JSON);
  assert.equal(parsed.selfHashField, null);
  assert.equal(verifier.selfHashField, null);
});

test("every published top-level body has a closed policy role", () => {
  const bodies = [
    ["quality_policy", quality.SCHEMAS.qualityPolicy, "policySha256"],
    ["quality_plan", quality.SCHEMAS.qualityPlan, "planSha256"],
    ["population_floor", quality.SCHEMAS.populationFloor, "floorHash"],
    ["layer_pass", quality.SCHEMAS.layerPass, "receiptHash"],
    ["frozen_review", quality.SCHEMAS.frozenReview, "receiptHash"],
    ["quality_receipt", quality.SCHEMAS.qualityReceipt, "receiptHash"],
    ["candidate_receipt", quality.SCHEMAS.candidateReceipt, "receiptHash"],
    ["attestation_body", quality.SCHEMAS.attestationBody, "bodySha256"],
  ];
  for (const [root, payloadSchema, selfHashField] of bodies) {
    const bodyPolicy = policy.lookupArtifactRole(role(root, ["body"]));
    assert.equal(bodyPolicy.payloadSchema, payloadSchema);
    assert.equal(bodyPolicy.encoding, policy.ENCODINGS.CANONICAL_HASH_BODY);
    assert.equal(bodyPolicy.selfHashField, selfHashField);
    assert.equal(bodyPolicy.emission, "lookup_only");
    assert.deepEqual(bodyPolicy.aliasRuleIds, []);
  }
  assert.equal(
    policy.REQUIRED_ALIAS_PAIRS.some((pair) =>
      pair.leftRoleId.endsWith(":body") ||
      pair.rightRoleId.endsWith(":body"),
    ),
    false,
  );
});

test("behavioral completeness covers every current validateArtifactRef family and all 21 layer roles", () => {
  const contractSource = fs.readFileSync(CONTRACT_PATH, "utf8");
  const contractTestSource = fs.readFileSync(CONTRACT_TEST_PATH, "utf8");
  assert.equal(digest(contractSource), binding.CONTRACT_SOURCE_SHA256);
  assert.equal(digest(contractTestSource), binding.CONTRACT_TEST_SHA256);
  assert.equal(binding.ARTIFACT_REF_SITE_MANIFEST.length, 61);
  assert.equal(
    new Set(
      binding.ARTIFACT_REF_SITE_MANIFEST.map((site) => site.siteId),
    ).size,
    61,
  );
  assert.equal(
    digest(canonicalJson(binding.ARTIFACT_REF_SITE_MANIFEST)),
    binding.ARTIFACT_REF_SITE_MANIFEST_SHA256,
  );
  assert.equal(
    (contractSource.match(/validateArtifactRef\s*\(/g) || []).length,
    29,
    "contract ArtifactRef validation sites drifted; revise the policy fixture",
  );
  for (const field of [
    "stdoutArtifact",
    "stderrArtifact",
    "parsedOutputArtifact",
    "rawResultArtifact",
    "rawPopulationArtifact",
    "outputArtifacts",
    "orderedInputs",
    "uncoveredRangesArtifact",
    "automationInputsArtifact",
    "dependencyManifestArtifact",
    "toolchainManifestArtifact",
    "preStateArtifact",
    "postCrashStateArtifact",
    "recoveryArtifact",
    "scheduleArtifact",
    "operationsArtifact",
    "acceptedOrderingArtifact",
    "inputArtifact",
    "approvedToolchains",
    "phaseProofRegistry",
    "reviewedManifest",
    "postReviewManifest",
    "locationArtifact",
    "findingArtifact",
    "closureReceipts",
    "certifierRuns",
    "coordinatorRerun",
    "operationalIntegrity",
    "independentFrozenHashReview",
    "authoritySnapshot",
    "changedPathsManifest",
    "changedPathCoverage",
    "assertions",
    "rawArtifact",
    "attestation body.artifacts",
  ]) {
    assert.equal(
      contractSource.includes(field),
      true,
      `contract ArtifactRef family ${field} disappeared`,
    );
  }

  const fixtures = representativeEnumerations();
  const expectedCounts = {
    quality_policy: 2,
    execution_observation: 3,
    verifier_output: 1,
    layer_pass: 3,
    coverage_input_manifest: 1,
    coverage_proof: 2,
    operational_manifest: 3,
    crash_population: 3,
    concurrency_population: 3,
    parser_population: 1,
    frozen_review: 7,
    quality_receipt: 79,
    candidate_receipt: 5,
    attestation_body: 10,
  };
  for (const fixture of fixtures) {
    const claims = policy.enumerateArtifactClaims(fixture);
    assert.equal(claims.length, expectedCounts[fixture.root], fixture.root);
    assert.equal(Object.isFrozen(claims), true);
    assert.equal(claims.every(Object.isFrozen), true);
    assert.equal(
      new Set(claims.map((claim) => claim.role.roleId)).size,
      claims.length,
    );
  }
  const observedSiteIds = new Set(
    fixtures.flatMap((fixture) =>
      policy
        .enumerateArtifactClaims(fixture)
        .map((claim) => claim.siteId),
    ),
  );
  assert.deepEqual(
    [...observedSiteIds].sort(),
    binding.ARTIFACT_REF_SITE_MANIFEST.map((site) => site.siteId).sort(),
  );
  const qualityClaims = policy.enumerateArtifactClaims(
    fixtures.find((fixture) => fixture.root === "quality_receipt"),
  );
  for (const layerId of policy.EXPECTED_LAYER_IDS) {
    assert.equal(
      qualityClaims.some((claim) =>
        claim.role.roleId.startsWith(
          `quality_receipt:layerResults.${layerId}.`,
        ),
      ),
      true,
      layerId,
    );
  }
});

test("claim enumeration is deterministic across three runs and sorted by canonical role", () => {
  const fixture = enumeration("quality_receipt", makeQualityReceipt("repeat"));
  const runs = [1, 2, 3].map(() =>
    quality.stableJson(policy.enumerateArtifactClaims(fixture)),
  );
  assert.equal(new Set(runs).size, 1);
  const claims = policy.enumerateArtifactClaims(fixture);
  const ids = claims.map((claim) => claim.role.roleId);
  assert.deepEqual(ids, [...ids].sort());
});

test("execution claims derive collision-free identity from executionId and every Cartesian coordinate", () => {
  const first = makeExecutionObservation("instance-a");
  const second = makeExecutionObservation("instance-b", {
    repeat: 2,
    seed: "seed-b",
    timeZone: "UTC",
    orderId: "reverse",
  });
  const claims = policy.enumerateArtifactClaimSet([
    enumeration("execution_observation", first),
    enumeration("execution_observation", second),
  ]);
  assert.equal(claims.length, 6);
  assert.equal(new Set(claims.map((claim) => claim.claimId)).size, 6);
  assert.equal(new Set(claims.map((claim) => claim.role.roleId)).size, 6);
  assert.equal(
    new Set(
      claims.map((claim) => claim.role.instance.instanceSha256),
    ).size,
    2,
  );
  for (const claim of claims) {
    assert.equal(
      claim.role.instance.schema,
      policy.EXECUTION_INSTANCE_SCHEMA,
    );
    assert.deepEqual(
      Object.keys(claim.role.instance.coordinate),
      [
        "layerId",
        "checkId",
        "definitionSha256",
        "repeat",
        "seed",
        "timeZone",
        "orderId",
        "fixtureManifestSha256",
      ],
    );
    assert.equal(
      claim.role.roleId.includes(
        claim.role.instance.instanceSha256,
      ),
      true,
    );
  }

  const baselineInstance = policy.enumerateArtifactClaims(
    enumeration("execution_observation", first),
  )[0].role.instance;
  for (const [field, next] of [
    ["layerId", "contract"],
    ["checkId", "different-check"],
    ["definitionSha256", digest("different-definition")],
    ["repeat", 3],
    ["seed", "different-seed"],
    ["timeZone", "Europe/London"],
    ["orderId", "different-order"],
    ["fixtureManifestSha256", digest("different-fixture")],
  ]) {
    const changed = makeExecutionObservation(`coordinate-${field}`, {
      executionId: first.executionId,
      layerId: first.layerId,
      checkId: first.checkId,
      definitionSha256: first.definitionSha256,
      repeat: first.repeat,
      seed: first.seed,
      timeZone: first.timeZone,
      orderId: first.orderId,
      fixtureManifestSha256: first.fixtureManifestSha256,
      [field]: next,
    });
    const instance = policy.enumerateArtifactClaims(
      enumeration("execution_observation", changed),
    )[0].role.instance;
    assert.notEqual(
      instance.coordinateSha256,
      baselineInstance.coordinateSha256,
      field,
    );
    assert.notEqual(
      instance.instanceSha256,
      baselineInstance.instanceSha256,
      field,
    );
  }
  const changedExecutionId = makeExecutionObservation("changed-id", {
    executionId: "changed-execution-id",
    layerId: first.layerId,
    checkId: first.checkId,
    definitionSha256: first.definitionSha256,
    repeat: first.repeat,
    seed: first.seed,
    timeZone: first.timeZone,
    orderId: first.orderId,
    fixtureManifestSha256: first.fixtureManifestSha256,
  });
  const changedIdInstance = policy.enumerateArtifactClaims(
    enumeration("execution_observation", changedExecutionId),
  )[0].role.instance;
  assert.equal(
    changedIdInstance.coordinateSha256,
    baselineInstance.coordinateSha256,
  );
  assert.notEqual(
    changedIdInstance.instanceSha256,
    baselineInstance.instanceSha256,
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaimSet([
        enumeration("execution_observation", first),
        enumeration("execution_observation", changedExecutionId),
      ]),
    "DUPLICATE_EXECUTION_COORDINATE",
  );

  const reusedExecutionId = makeExecutionObservation("reused-id", {
    executionId: first.executionId,
    seed: "different-coordinate",
  });
  expectCode(
    () =>
      policy.enumerateArtifactClaimSet([
        enumeration("execution_observation", first),
        enumeration("execution_observation", reusedExecutionId),
      ]),
    "EXECUTION_ID_COORDINATE_COLLISION",
  );
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        ...role("execution_observation", [
          "layers",
          "unit",
          "stdoutArtifact",
        ]),
        instance: "caller-decoration",
      }),
    "EXACT_KEYS_REQUIRED",
  );
});

test("exact alias pairs permit required identity and refuse broad or unrelated reuse", () => {
  const frozen = representativeEnumerations().find(
    (fixture) => fixture.root === "frozen_review",
  );
  const qualityValue = makeQualityReceipt("alias-quality");
  const witnesses = new Map([
    [
      "quality_receipt",
      policy.enumerateArtifactClaims(
        enumeration("quality_receipt", qualityValue),
      ),
    ],
    ["frozen_review", policy.enumerateArtifactClaims(frozen)],
  ]);
  assert.equal(policy.REQUIRED_SPECIALIZED_ALIAS_PAIRS.length, 10);
  assert.equal(policy.REQUIRED_ALIAS_PAIRS.length, 11);
  for (const pair of policy.REQUIRED_ALIAS_PAIRS) {
    const claims = witnesses.get(pair.witnessRoot);
    const left = claims.find(
      (claim) => claim.role.roleId === pair.leftRoleId,
    );
    const right = claims.find(
      (claim) => claim.role.roleId === pair.rightRoleId,
    );
    assert.ok(left, `${pair.ruleId} left endpoint`);
    assert.ok(right, `${pair.ruleId} right endpoint`);
    assert.deepEqual(left.artifact, right.artifact, pair.ruleId);
  }

  expectCode(
    () =>
      policy.lookupArtifactRole(
        role("quality_receipt", ["executionMatrix"]),
      ),
    "UNKNOWN_ARTIFACT_ROLE",
  );

  const wrongPair = clone(qualityValue);
  wrongPair.coverage = artifactFor(
    "quality_receipt",
    ["coverage"],
    "wrong-required-coverage",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("quality_receipt", wrongPair),
      ),
    "REQUIRED_ARTIFACT_ALIAS_MISMATCH",
  );

  const wrongIndex = clone(qualityValue);
  wrongIndex.operationalIntegrity.beforeManifest = clone(
    wrongIndex.layerResults.operational_integrity.outputArtifacts[1],
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("quality_receipt", wrongIndex),
      ),
    "REQUIRED_ARTIFACT_ALIAS_MISMATCH",
  );

  const candidate = makeCandidateReceipt("unauthorized-alias");
  candidate.assertions = clone(candidate.authoritySnapshot);
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("candidate_receipt", candidate),
      ),
    "ARTIFACT_ALIAS_REFUSED",
  );
  assert.equal(
    policy.REQUIRED_ALIAS_PAIRS.every(
      (pair) =>
        pair.leftRoleId !== pair.rightRoleId &&
        pair.kind === "required_equal" &&
        !pair.leftRoleId.endsWith(":body") &&
        !pair.rightRoleId.endsWith(":body"),
    ),
    true,
  );
});

test("role descriptors refuse missing, unknown, wildcard, payload-selected, and unsafe shapes", () => {
  const valid = role("quality_policy", ["phaseProofRegistry"]);
  const hostile = [
    [null, "EXACT_OBJECT_REQUIRED"],
    [{ root: "quality_policy", path: ["phaseProofRegistry"] }, "EXACT_KEYS_REQUIRED"],
    [{ ...valid, extra: "x" }, "EXACT_KEYS_REQUIRED"],
    [{ ...valid, schema: "wrong" }, "ROLE_SCHEMA_INVALID"],
    [{ ...valid, root: "unknown" }, "UNKNOWN_ARTIFACT_ROOT"],
    [{ ...valid, path: [] }, "ROLE_PATH_INVALID"],
    [{ ...valid, path: ["missing"] }, "UNKNOWN_ARTIFACT_ROLE"],
    [{ ...valid, path: ["*"] }, "WILDCARD_ROLE_REFUSED"],
    [{ ...valid, path: ["phase*"] }, "WILDCARD_ROLE_REFUSED"],
    [{ ...valid, path: [-1] }, "ROLE_PATH_INVALID"],
    [{ ...valid, path: [0.5] }, "UNSAFE_NUMBER"],
    [{ ...valid, path: Array.from({ length: 17 }, () => "x") }, "ROLE_PATH_LIMIT"],
    [{ ...valid, validatorId: "caller" }, "EXACT_KEYS_REQUIRED"],
    [{ ...valid, payloadSchema: "caller" }, "EXACT_KEYS_REQUIRED"],
  ];
  for (const [descriptorValue, code] of hostile) {
    expectCode(() => policy.canonicalizeArtifactRole(descriptorValue), code);
  }

  const sparse = role("quality_policy", new Array(1));
  expectCode(() => policy.canonicalizeArtifactRole(sparse), "UNSAFE_ARRAY_SHAPE");

  const extraArray = role("quality_policy", ["phaseProofRegistry"]);
  extraArray.path.extra = true;
  expectCode(
    () => policy.canonicalizeArtifactRole(extraArray),
    "UNSAFE_ARRAY_SHAPE",
  );

  const getter = {};
  Object.defineProperty(getter, "schema", {
    enumerable: true,
    get() {
      return policy.ROLE_SCHEMA;
    },
  });
  getter.root = "quality_policy";
  getter.path = ["phaseProofRegistry"];
  expectCode(() => policy.canonicalizeArtifactRole(getter), "ACCESSOR_PROPERTY_REFUSED");

  const symbol = { ...valid };
  symbol[Symbol("hidden")] = true;
  expectCode(() => policy.canonicalizeArtifactRole(symbol), "SYMBOL_PROPERTY_REFUSED");

  const nonEnumerable = { ...valid };
  Object.defineProperty(nonEnumerable, "hidden", { value: true });
  expectCode(
    () => policy.canonicalizeArtifactRole(nonEnumerable),
    "ACCESSOR_PROPERTY_REFUSED",
  );

  const foreignPrototype = Object.create({ inherited: true });
  Object.assign(foreignPrototype, valid);
  expectCode(
    () => policy.canonicalizeArtifactRole(foreignPrototype),
    "UNSAFE_PROTOTYPE",
  );

  let rootProxyTraps = 0;
  const rootProxy = new Proxy(valid, {
    getPrototypeOf() {
      rootProxyTraps += 1;
      return Object.prototype;
    },
    ownKeys(target) {
      rootProxyTraps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      rootProxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      rootProxyTraps += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  expectCode(
    () => policy.canonicalizeArtifactRole(rootProxy),
    "PROXY_REFUSED",
  );
  assert.equal(rootProxyTraps, 0);

  let descendantProxyTraps = 0;
  const descendantProxy = new Proxy(["phaseProofRegistry"], {
    getPrototypeOf() {
      descendantProxyTraps += 1;
      return Array.prototype;
    },
    ownKeys(target) {
      descendantProxyTraps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      descendantProxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      descendantProxyTraps += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        ...valid,
        path: descendantProxy,
      }),
    "PROXY_REFUSED",
  );
  assert.equal(descendantProxyTraps, 0);

  const throwingProxy = new Proxy(valid, {
    getPrototypeOf() {
      throw new Error("must not execute");
    },
  });
  expectCode(
    () => policy.canonicalizeArtifactRole(throwingProxy),
    "PROXY_REFUSED",
  );
  const callableProxy = new Proxy(function callable() {}, {});
  expectCode(
    () => policy.canonicalizeArtifactRole(callableProxy),
    "PROXY_REFUSED",
  );
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        ...valid,
        path: callableProxy,
      }),
    "PROXY_REFUSED",
  );
  const revokedRoot = Proxy.revocable(valid, {});
  revokedRoot.revoke();
  expectCode(
    () => policy.canonicalizeArtifactRole(revokedRoot.proxy),
    "PROXY_REFUSED",
  );
  const revokedDescendant = Proxy.revocable(
    ["phaseProofRegistry"],
    {},
  );
  revokedDescendant.revoke();
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        ...valid,
        path: revokedDescendant.proxy,
      }),
    "PROXY_REFUSED",
  );

  const cyclic = { ...valid };
  cyclic.path = [];
  cyclic.path.push(cyclic.path);
  expectCode(() => policy.canonicalizeArtifactRole(cyclic), "CYCLIC_GRAPH");

  for (const dangerous of ["__proto__", "constructor", "prototype"]) {
    const dangerousDescriptor = JSON.parse(
      `{"schema":${JSON.stringify(policy.ROLE_SCHEMA)},"root":"quality_policy","path":["phaseProofRegistry"],${JSON.stringify(dangerous)}:1}`,
    );
    expectCode(
      () => policy.canonicalizeArtifactRole(dangerousDescriptor),
      "UNSAFE_PROPERTY_NAME",
    );
    assert.equal(Object.prototype.polluted, undefined);
  }
});

test("enumeration refuses root drift, unclassified refs, wrong media, oversize, and malformed graphs", () => {
  const base = makeExecutionObservation("hostile");
  expectCode(
    () =>
      policy.enumerateArtifactClaims({
        root: "execution_observation",
        value: base,
      }),
    "EXACT_KEYS_REQUIRED",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", {
          ...base,
          schema: quality.SCHEMAS.verifierOutput,
        }),
      ),
    "ROOT_SCHEMA_MISMATCH",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", { ...base, layerId: "unknown" }),
      ),
    "UNKNOWN_LAYER_ID",
  );

  const unclassified = clone(base);
  unclassified.extraArtifact = artifactFor(
    "quality_policy",
    ["phaseProofRegistry"],
    "hidden-ref",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", unclassified),
      ),
    "UNDECLARED_ARTIFACT_REFERENCE",
  );

  const missing = clone(base);
  delete missing.stderrArtifact;
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", missing),
      ),
    "ARTIFACT_REFERENCE_INVALID",
  );

  const wrongMedia = clone(base);
  wrongMedia.stderrArtifact.mediaType = "text/plain";
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", wrongMedia),
      ),
    "ARTIFACT_MEDIA_TYPE_MISMATCH",
  );

  const oversized = clone(base);
  oversized.stderrArtifact.byteLength =
    policy.lookupArtifactRole(
      role("execution_observation", [
        "layers",
        "unit",
        "stderrArtifact",
      ]),
    ).maximumBytes + 1;
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", oversized),
      ),
    "ARTIFACT_SIZE_LIMIT",
  );

  const malformedRef = clone(base);
  malformedRef.stderrArtifact.address = `sha256:${digest("not-the-ref")}`;
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("execution_observation", malformedRef),
      ),
    "ARTIFACT_REFERENCE_INVALID",
  );

  const deep = { schema: policy.ENUMERATION_SCHEMA, root: "candidate_receipt" };
  let cursor = {};
  deep.value = cursor;
  for (let index = 0; index < 66; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  expectCode(() => policy.enumerateArtifactClaims(deep), "GRAPH_DEPTH_LIMIT");

  expectCode(() => policy.enumerateArtifactClaimSet([]), "ENUMERATION_SET_INVALID");
});

test("byte-stream envelopes preserve empty stderr without empty CAS blobs", () => {
  const stderrRole = role("execution_observation", [
    "layers",
    "unit",
    "stderrArtifact",
  ]);
  const stderrPolicy = policy.lookupArtifactRole(stderrRole);
  assert.deepEqual(
    {
      mediaType: stderrPolicy.mediaType,
      payloadSchema: stderrPolicy.payloadSchema,
      encoding: stderrPolicy.encoding,
      validatorId: stderrPolicy.validatorId,
    },
    {
      mediaType: "application/json",
      payloadSchema: "pikiio-byte-stream-envelope-v1",
      encoding: policy.ENCODINGS.CANONICAL_JSON,
      validatorId: "byte_stream_envelope_v1",
    },
  );

  const emptyEnvelope = {
    schema: "pikiio-byte-stream-envelope-v1",
    encoding: "base64",
    decodedByteLength: 0,
    base64: "",
  };
  const emptyBytes = Buffer.from(quality.stableJson(emptyEnvelope), "utf8");
  const empty = policy.validateArtifactPayload(stderrRole, emptyBytes);
  assert.equal(empty.byteLength > 0, true);
  assert.equal(empty.decodedByteLength, 0);

  const message = Buffer.from("diagnostic\n", "utf8");
  const populatedEnvelope = {
    schema: "pikiio-byte-stream-envelope-v1",
    encoding: "base64",
    decodedByteLength: message.length,
    base64: message.toString("base64"),
  };
  const populated = policy.validateArtifactPayload(
    stderrRole,
    Buffer.from(quality.stableJson(populatedEnvelope), "utf8"),
  );
  assert.equal(populated.decodedByteLength, message.length);
  assert.equal(populated.computedSelfHash, null);

  expectCode(
    () => policy.validateArtifactPayload(stderrRole, Buffer.alloc(0)),
    "ARTIFACT_BYTES_EMPTY",
  );
});

test("byte-stream validator is canonical, bounded, single-pass, and typed on large hostility", () => {
  const stderrRole = role("execution_observation", [
    "layers",
    "unit",
    "stderrArtifact",
  ]);
  const fixture = {
    schema: "pikiio-byte-stream-envelope-v1",
    encoding: "base64",
    decodedByteLength: 1,
    base64: "YQ==",
  };
  const hostile = [
    [{ ...fixture, schema: "wrong" }, "PAYLOAD_SCHEMA_MISMATCH"],
    [{ ...fixture, encoding: "base64url" }, "BYTE_STREAM_ENCODING_INVALID"],
    [{ ...fixture, decodedByteLength: -1 }, "BYTE_STREAM_DECODED_SIZE_INVALID"],
    [{ ...fixture, decodedByteLength: 2 }, "BYTE_STREAM_LENGTH_MISMATCH"],
    [{ ...fixture, base64: "YQ=" }, "BYTE_STREAM_BASE64_INVALID"],
    [{ ...fixture, base64: "Y===" }, "BYTE_STREAM_BASE64_INVALID"],
    [{ ...fixture, base64: "Y Q=" }, "BYTE_STREAM_BASE64_INVALID"],
    [{ ...fixture, base64: "YQ=A" }, "BYTE_STREAM_BASE64_INVALID"],
    [{ ...fixture, extra: true }, "EXACT_KEYS_REQUIRED"],
  ];
  for (const [value, code] of hostile) {
    expectCode(
      () =>
        policy.validateArtifactPayload(
          stderrRole,
          Buffer.from(quality.stableJson(value), "utf8"),
        ),
      code,
    );
  }

  const largeMalformed = {
    schema: "pikiio-byte-stream-envelope-v1",
    encoding: "base64",
    decodedByteLength: 450_003,
    base64: `${"A".repeat(600_003)}!`,
  };
  expectCode(
    () =>
      policy.validateArtifactPayload(
        stderrRole,
        Buffer.from(canonicalJson(largeMalformed), "utf8"),
      ),
    "BYTE_STREAM_BASE64_INVALID",
  );

  const tooLongBase64 = {
    schema: "pikiio-byte-stream-envelope-v1",
    encoding: "base64",
    decodedByteLength: 0,
    base64: "A".repeat(
      4 * Math.ceil(policy.BYTE_STREAM_DECODED_MAX_BYTES / 3) + 4,
    ),
  };
  expectCode(
    () =>
      policy.validateArtifactPayload(
        stderrRole,
        Buffer.from(canonicalJson(tooLongBase64), "utf8"),
      ),
    "BYTE_STREAM_BASE64_INVALID",
  );

  const maximum = policy.lookupArtifactRole(stderrRole).maximumBytes;
  assert.equal(maximum, policy.BYTE_STREAM_ENVELOPE_MAX_BYTES);
  assert.equal(
    maximum -
      4 * Math.ceil(policy.BYTE_STREAM_DECODED_MAX_BYTES / 3) >=
      256,
    true,
  );
  const exactDecoded = Buffer.alloc(
    policy.BYTE_STREAM_DECODED_MAX_BYTES,
    0x61,
  );
  const exactEnvelope = Buffer.from(
    canonicalJson({
      schema: "pikiio-byte-stream-envelope-v1",
      encoding: "base64",
      decodedByteLength: exactDecoded.length,
      base64: exactDecoded.toString("base64"),
    }),
    "utf8",
  );
  assert.equal(exactEnvelope.length <= maximum, true);
  assert.equal(
    policy.validateArtifactPayload(stderrRole, exactEnvelope)
      .decodedByteLength,
    policy.BYTE_STREAM_DECODED_MAX_BYTES,
  );

  const overDecoded = Buffer.alloc(
    policy.BYTE_STREAM_DECODED_MAX_BYTES + 1,
    0x61,
  );
  const overDecodedEnvelope = Buffer.from(
    canonicalJson({
      schema: "pikiio-byte-stream-envelope-v1",
      encoding: "base64",
      decodedByteLength: overDecoded.length,
      base64: overDecoded.toString("base64"),
    }),
    "utf8",
  );
  assert.equal(overDecodedEnvelope.length <= maximum, true);
  expectCode(
    () => policy.validateArtifactPayload(stderrRole, overDecodedEnvelope),
    "BYTE_STREAM_DECODED_SIZE_INVALID",
  );
  expectCode(
    () =>
      policy.validateArtifactPayload(
        stderrRole,
        Buffer.alloc(maximum + 1, 0x20),
      ),
    "ARTIFACT_SIZE_LIMIT",
  );
});

test("fixed encoding validators refuse newline JSON, schema substitution, and self-hash confusion", () => {
  const jsonRole = role("quality_policy", ["phaseProofRegistry"]);
  const jsonValue = {
    schema: "pikiio-phase-proof-registry-v1",
    revision: 1,
  };
  const jsonBytes = Buffer.from(quality.stableJson(jsonValue), "utf8");
  assert.equal(
    policy.validateArtifactPayload(jsonRole, jsonBytes).encoding,
    policy.ENCODINGS.CANONICAL_JSON,
  );
  expectCode(
    () =>
      policy.validateArtifactPayload(
        jsonRole,
        Buffer.from(`${quality.stableJson(jsonValue)}\n`, "utf8"),
      ),
    "NON_CANONICAL_JSON_BYTES",
  );
  expectCode(
    () =>
      policy.validateArtifactPayload(
        jsonRole,
        Buffer.from(
          quality.stableJson({ ...jsonValue, schema: "payload-selected" }),
          "utf8",
        ),
      ),
    "PAYLOAD_SCHEMA_MISMATCH",
  );
  expectCode(
    () => policy.validateArtifactPayload(jsonRole, Buffer.from("{", "utf8")),
    "JSON_PARSE_INVALID",
  );
  expectCode(
    () =>
      policy.validateArtifactPayload(
        jsonRole,
        Buffer.from([0xff, 0xfe, 0xfd]),
      ),
    "JSON_UTF8_INVALID",
  );
  expectCode(
    () =>
      policy.validateArtifactPayload(
        jsonRole,
        Buffer.from([0xef, 0xbb, 0xbf, ...jsonBytes]),
      ),
    "JSON_BOM_REFUSED",
  );
  expectCode(
    () => policy.validateArtifactPayload(jsonRole, "not-bytes"),
    "ARTIFACT_BYTES_REQUIRED",
  );
  for (const bytes of [
    Buffer.from("{}", "utf8"),
    new Uint8Array([123, 125]),
  ]) {
    let traps = 0;
    const proxiedBytes = new Proxy(bytes, {
      getPrototypeOf() {
        traps += 1;
        return Reflect.getPrototypeOf(bytes);
      },
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expectCode(
      () => policy.validateArtifactPayload(jsonRole, proxiedBytes),
      "PROXY_REFUSED",
    );
    assert.equal(traps, 0);
  }
  const throwingBytes = new Proxy(Buffer.from("{}", "utf8"), {
    getPrototypeOf() {
      throw new Error("must not execute");
    },
  });
  expectCode(
    () => policy.validateArtifactPayload(jsonRole, throwingBytes),
    "PROXY_REFUSED",
  );

  for (const dangerous of ["__proto__", "constructor", "prototype"]) {
    const dangerousBytes = Buffer.from(
      `{"schema":"pikiio-phase-proof-registry-v1",${JSON.stringify(dangerous)}:{"polluted":true}}`,
      "utf8",
    );
    expectCode(
      () => policy.validateArtifactPayload(jsonRole, dangerousBytes),
      "UNSAFE_PROPERTY_NAME",
    );
    assert.equal(Object.prototype.polluted, undefined);
  }

  const hashBodyRole = role("attestation_body", [
    "artifacts",
    "qualityReceipt",
  ]);
  const body = {
    schema: quality.SCHEMAS.qualityReceipt,
    phase: "GOV-00",
  };
  const bodyBytes = Buffer.from(quality.stableJson(body), "utf8");
  const validated = policy.validateArtifactPayload(hashBodyRole, bodyBytes);
  assert.equal(validated.encoding, policy.ENCODINGS.CANONICAL_HASH_BODY);
  assert.equal(validated.computedSelfHash, digest(bodyBytes));
  expectCode(
    () =>
      policy.validateArtifactPayload(
        hashBodyRole,
        Buffer.from(
          quality.stableJson({ ...body, receiptHash: digest("forged") }),
          "utf8",
        ),
      ),
    "SELF_HASH_FIELD_PRESENT",
  );

  const opaqueRole = role("parser_population", [
    "cases",
    0,
    "inputArtifact",
  ]);
  const opaque = policy.validateArtifactPayload(
    opaqueRole,
    Buffer.from([0, 255, 1]),
  );
  assert.equal(opaque.encoding, policy.ENCODINGS.OPAQUE_BYTES);
  assert.equal(opaque.decodedByteLength, null);
});

test("semantic-hash contract objects are retained as canonical JSON, never hash bodies", () => {
  const semanticRoles = [
    role("layer_pass", ["layers", "unit", "executions", 0]),
    role("verifier_output", [
      "layers",
      "focused_verifier",
      "rawResultArtifact",
    ]),
    role("quality_receipt", ["coverage"]),
    role("quality_receipt", ["operationalIntegrity", "beforeManifest"]),
  ];
  for (const descriptorValue of semanticRoles) {
    const result = policy.lookupArtifactRole(descriptorValue);
    assert.equal(result.encoding, policy.ENCODINGS.CANONICAL_JSON);
    assert.equal(result.selfHashField, null);
  }
  const frozen = policy.lookupArtifactRole(
    role("quality_receipt", [
      "independentFrozenHashReview",
      "artifact",
    ]),
  );
  assert.equal(frozen.encoding, policy.ENCODINGS.CANONICAL_HASH_BODY);
  assert.equal(frozen.selfHashField, "receiptHash");
});

test("remaining hostile graph and branch boundaries fail closed with typed errors", () => {
  const validRole = role("quality_policy", ["phaseProofRegistry"]);

  const foreignArray = ["phaseProofRegistry"];
  Object.setPrototypeOf(foreignArray, {});
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        schema: policy.ROLE_SCHEMA,
        root: "quality_policy",
        path: foreignArray,
      }),
    "UNSAFE_PROTOTYPE",
  );

  const oversizedArray = Array.from({ length: 10_001 }, () => "x");
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        schema: policy.ROLE_SCHEMA,
        root: "quality_policy",
        path: oversizedArray,
      }),
    "ARRAY_LENGTH_LIMIT",
  );

  const accessorArray = ["phaseProofRegistry"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      return "phaseProofRegistry";
    },
  });
  expectCode(
    () =>
      policy.canonicalizeArtifactRole({
        schema: policy.ROLE_SCHEMA,
        root: "quality_policy",
        path: accessorArray,
      }),
    "ACCESSOR_PROPERTY_REFUSED",
  );

  for (const unsafe of [undefined, () => "x", 1n]) {
    expectCode(
      () =>
        policy.canonicalizeArtifactRole({
          schema: policy.ROLE_SCHEMA,
          root: unsafe,
          path: ["phaseProofRegistry"],
        }),
      "UNSAFE_VALUE",
    );
  }

  const nodeFlood = {
    schema: policy.ROLE_SCHEMA,
    root: "quality_policy",
    path: ["phaseProofRegistry"],
    flood: {},
  };
  for (let index = 0; index < 50_001; index += 1) {
    nodeFlood.flood[`k${index}`] = index;
  }
  expectCode(
    () => policy.canonicalizeArtifactRole(nodeFlood),
    "GRAPH_NODE_LIMIT",
  );

  expectCode(
    () =>
      policy.enumerateArtifactClaims({
        schema: "wrong",
        root: "quality_plan",
        value: { schema: quality.SCHEMAS.qualityPlan },
      }),
    "ENUMERATION_SCHEMA_INVALID",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims({
        schema: policy.ENUMERATION_SCHEMA,
        root: "unknown",
        value: { schema: "unknown" },
      }),
    "UNKNOWN_ARTIFACT_ROOT",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims({
        schema: policy.ENUMERATION_SCHEMA,
        root: "quality_plan",
        value: [],
      }),
    "OBJECT_REQUIRED",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("quality_policy", {
          schema: quality.SCHEMAS.qualityPolicy,
          approvedToolchains: {},
          phaseProofRegistry: artifactFor(
            "quality_policy",
            ["phaseProofRegistry"],
            "array-required",
          ),
        }),
      ),
    "ARRAY_REQUIRED",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("verifier_output", {
          schema: quality.SCHEMAS.verifierOutput,
          layerId: "unit",
          rawResultArtifact: artifactFor(
            "verifier_output",
            ["layers", "focused_verifier", "rawResultArtifact"],
            "invalid-verifier-layer",
          ),
        }),
      ),
    "UNKNOWN_LAYER_ID",
  );
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("layer_pass", {
          ...makeLayerPass("layer_pass", "bad-layer", "unit"),
          layerId: "unknown",
        }),
      ),
    "UNKNOWN_LAYER_ID",
  );

  for (const [field, invalid, code] of [
    ["executionId", "", "EXECUTION_IDENTITY_INVALID"],
    ["definitionSha256", "not-a-sha", "EXECUTION_IDENTITY_INVALID"],
    ["repeat", 0, "EXECUTION_IDENTITY_INVALID"],
    ["layerId", "unknown", "UNKNOWN_LAYER_ID"],
  ]) {
    const observation = makeExecutionObservation(
      `coverage-refusal-${field}`,
    );
    observation[field] = invalid;
    expectCode(
      () =>
        policy.enumerateArtifactClaims(
          enumeration("execution_observation", observation),
        ),
      code,
    );
  }

  for (const root of [
    "quality_plan",
    "population_floor",
    "source_manifest",
    "evidence_manifest",
    "primary_judge_raw",
    "independent_judge_raw",
    "frozen_source_manifest",
    "rehearsal_receipt",
    "change_receipt",
    "promotion_receipt",
  ]) {
    assert.deepEqual(
      policy.enumerateArtifactClaims(
        enumeration(root, { schema: policy.ROOT_SCHEMAS[root] }),
      ),
      [],
    );
  }

  const notApplicable = makeQualityReceipt("not-applicable");
  notApplicable.layerResults.natural_cycle_qa = {
    schema: quality.SCHEMAS.notApplicable,
  };
  assert.equal(
    policy.enumerateArtifactClaims(
      enumeration("quality_receipt", notApplicable),
    ).length,
    76,
  );
  const invalidResult = makeQualityReceipt("invalid-result");
  invalidResult.layerResults.natural_cycle_qa = { schema: "wrong" };
  expectCode(
    () =>
      policy.enumerateArtifactClaims(
        enumeration("quality_receipt", invalidResult),
      ),
    "LAYER_RESULT_SCHEMA_INVALID",
  );

  expectCode(
    () =>
      policy.enumerateArtifactClaimSet([
        enumeration("candidate_receipt", makeCandidateReceipt("duplicate-root")),
        enumeration("candidate_receipt", makeCandidateReceipt("duplicate-root")),
      ]),
    "DUPLICATE_ARTIFACT_ROLE",
  );

  const richJson = {
    schema: "pikiio-phase-proof-registry-v1",
    array: [null, true, false, 1, "x"],
  };
  assert.equal(
    policy.validateArtifactPayload(
      validRole,
      Buffer.from(canonicalJson(richJson), "utf8"),
    ).payloadSchema,
    richJson.schema,
  );
  expectCode(
    () =>
      policy.validateArtifactPayload(
        validRole,
        Buffer.from(canonicalJson([1, 2, 3]), "utf8"),
      ),
    "OBJECT_REQUIRED",
  );
});

const MUTATION_CHILD_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

function compile(source, filename, overrides = {}) {
  const target = new Module(filename, module);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = target.require.bind(target);
  target.require = (request) =>
    Object.prototype.hasOwnProperty.call(overrides, request)
      ? overrides[request]
      : originalRequire(request);
  target._compile(source, filename);
  return target.exports;
}

function observe(operation) {
  try {
    return { code: "NO_REFUSAL", value: operation() };
  } catch (error) {
    return {
      code:
        error && typeof error.code === "string"
          ? error.code
          : "UNTYPED_HARNESS_EXCEPTION",
      diagnostic:
        error && typeof error.message === "string"
          ? error.message
          : String(error),
    };
  }
}

function execute(moduleValue, probe) {
  switch (probe.kind) {
    case "noop":
      return { pass: true, observed: "PASS" };
    case "expect_error": {
      const operation = () => {
        switch (probe.operation) {
          case "canonicalize":
            return moduleValue.canonicalizeArtifactRole(probe.value);
          case "lookup":
            return moduleValue.lookupArtifactRole(probe.value);
          case "enumerate":
            return moduleValue.enumerateArtifactClaims(probe.value);
          case "enumerate_set":
            return moduleValue.enumerateArtifactClaimSet(probe.value);
          case "payload":
            return moduleValue.validateArtifactPayload(
              probe.role,
              Buffer.from(probe.bytesBase64, "base64"),
            );
          case "binding_ref":
            return moduleValue.validateArtifactRef(probe.value);
          default:
            throw Object.assign(new Error("unknown mutation operation"), {
              code: "MUTATION_HARNESS_OPERATION_UNKNOWN",
            });
        }
      };
      const observed = observe(operation);
      return {
        pass: observed.code === probe.expectedCode,
        observed: observed.code,
        expected: probe.expectedCode,
      };
    }
    case "expect_property": {
      let cursor = moduleValue;
      for (const segment of probe.path) cursor = cursor[segment];
      const observed = JSON.stringify(cursor);
      const expected = JSON.stringify(probe.expected);
      return { pass: observed === expected, observed, expected };
    }
    case "compare_role_payloads": {
      const left = moduleValue.lookupArtifactRole(probe.left).payloadSchema;
      const right = moduleValue.lookupArtifactRole(probe.right).payloadSchema;
      return {
        pass: probe.relation === "different" ? left !== right : left === right,
        observed: left + "|" + right,
        expected: probe.relation,
      };
    }
    case "compare_execution_identity": {
      const left = moduleValue.enumerateArtifactClaims(probe.left)[0]
        .role.instance[probe.field];
      const right = moduleValue.enumerateArtifactClaims(probe.right)[0]
        .role.instance[probe.field];
      return {
        pass: left !== right,
        observed: left + "|" + right,
        expected: "different",
      };
    }
    case "expect_proxy_refusal": {
      let traps = 0;
      const handler = {
        getPrototypeOf(target) {
          traps += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          traps += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          traps += 1;
          return Reflect.get(target, key, receiver);
        },
      };
      let operation;
      if (probe.operation === "binding_ref") {
        const proxy = new Proxy(probe.value, handler);
        operation = () => moduleValue.validateArtifactRef(proxy);
      } else {
        const descriptor = { ...probe.value };
        if (probe.location === "descendant") {
          descriptor.path = new Proxy(descriptor.path, handler);
          operation = () => moduleValue.canonicalizeArtifactRole(descriptor);
        } else {
          const proxy = new Proxy(descriptor, handler);
          operation = () => moduleValue.canonicalizeArtifactRole(proxy);
        }
      }
      const observed = observe(operation);
      return {
        pass: observed.code === "PROXY_REFUSED" && traps === 0,
        observed: observed.code + "/traps:" + traps,
        expected: "PROXY_REFUSED/traps:0",
      };
    }
    case "expect_payload_proxy_refusal": {
      let traps = 0;
      const bytes = Buffer.from(probe.bytesBase64, "base64");
      const proxy = new Proxy(bytes, {
        getPrototypeOf(target) {
          traps += 1;
          return Reflect.getPrototypeOf(target);
        },
        get(target, key, receiver) {
          traps += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const observed = observe(() =>
        moduleValue.validateArtifactPayload(probe.role, proxy),
      );
      return {
        pass: observed.code === "PROXY_REFUSED" && traps === 0,
        observed: observed.code + "/traps:" + traps,
        expected: "PROXY_REFUSED/traps:0",
      };
    }
    default:
      return {
        pass: false,
        observed: "UNKNOWN_PROBE",
        expected: probe.kind,
      };
  }
}

const input = JSON.parse(fs.readFileSync(0, "utf8"));
let moduleValue;
try {
  if (input.moduleKind === "binding") {
    moduleValue = compile(input.source, input.filename);
  } else {
    let bindingOverride;
    if (typeof input.bindingSource === "string") {
      bindingOverride = compile(input.bindingSource, input.bindingFilename);
    }
    moduleValue = compile(
      input.source,
      input.filename,
      bindingOverride === undefined
        ? {}
        : { "./pikiio-quality-contract-binding-v1": bindingOverride },
    );
  }
} catch (error) {
  const code =
    error && typeof error.code === "string"
      ? error.code
      : "UNTYPED_MODULE_INIT_EXCEPTION";
  process.stdout.write(
    JSON.stringify({
      schema: "pikiio-quality-causal-mutation-receipt-v1",
      mutantId: input.mutantId,
      outcome: "init_refusal",
      code,
      fingerprint: "init:" + code,
      diagnostic:
        error && typeof error.message === "string"
          ? error.message
          : String(error),
    }),
  );
  process.exit(0);
}

const result = execute(moduleValue, input.probe);
process.stdout.write(
  JSON.stringify({
    schema: "pikiio-quality-causal-mutation-receipt-v1",
    mutantId: input.mutantId,
    outcome: result.pass ? "probe_pass" : "causal_refusal",
    code: result.pass ? "PASS" : "MUTATION_CAUSAL_FINGERPRINT",
    fingerprint: result.pass
      ? "probe:pass"
      : String(result.expected) + "->" + String(result.observed),
    diagnostic: result.pass
      ? "baseline contract retained"
      : "named probe changed its exact observable result",
  }),
);
`;

function replaceExactlyOnce(source, before, after, mutantId) {
  assert.equal(
    source.split(before).length - 1,
    1,
    `${mutantId} mutation anchor must occur exactly once`,
  );
  return source.replace(before, after);
}

function applyMutation(source, mutation) {
  return mutation.replacements.reduce(
    (current, replacement) =>
      replaceExactlyOnce(
        current,
        replacement.before,
        replacement.after,
        mutation.mutantId,
      ),
    source,
  );
}

function runMutationChild(input) {
  const result = spawnSync(process.execPath, ["-e", MUTATION_CHILD_SOURCE], {
    cwd: path.dirname(POLICY_PATH),
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${input.mutantId} process error`);
  assert.equal(result.signal, null, `${input.mutantId} signal`);
  assert.equal(Number.isSafeInteger(result.status), true, `${input.mutantId} null status`);
  assert.equal(result.status, 0, `${input.mutantId} exit status`);
  assert.equal(result.stderr, "", `${input.mutantId} unexpected stderr`);
  assert.notEqual(result.stdout.trim(), "", `${input.mutantId} empty receipt`);
  let receipt;
  assert.doesNotThrow(() => {
    receipt = JSON.parse(result.stdout);
  }, `${input.mutantId} malformed receipt`);
  assert.deepEqual(
    Object.keys(receipt),
    [
      "schema",
      "mutantId",
      "outcome",
      "code",
      "fingerprint",
      "diagnostic",
    ],
  );
  assert.equal(
    receipt.schema,
    "pikiio-quality-causal-mutation-receipt-v1",
  );
  assert.equal(receipt.mutantId, input.mutantId);
  assert.equal(typeof receipt.diagnostic, "string");
  assert.notEqual(receipt.diagnostic, "");
  assert.equal(receipt.code.startsWith("UNTYPED_"), false);
  return receipt;
}

function policyProbeInput(mutantId, source, probe, bindingSource = null) {
  return {
    mutantId,
    moduleKind: "policy",
    source,
    filename: path.join(
      path.dirname(POLICY_PATH),
      `.pikiio-quality-artifact-policy-mutant-${mutantId}.js`,
    ),
    bindingSource,
    bindingFilename: path.join(
      path.dirname(BINDING_PATH),
      `.pikiio-quality-contract-binding-mutant-${mutantId}.js`,
    ),
    probe,
  };
}

function bindingProbeInput(mutantId, source, probe) {
  return {
    mutantId,
    moduleKind: "binding",
    source,
    filename: path.join(
      path.dirname(BINDING_PATH),
      `.pikiio-quality-contract-binding-mutant-${mutantId}.js`,
    ),
    probe,
  };
}

test(
  "named critical policy mutations emit exact causal receipts at 100 percent",
  { skip: process.env.PIKIIO_SKIP_MUTATION === "1" },
  () => {
  const source = fs.readFileSync(POLICY_PATH, "utf8");
  const validRole = role("quality_policy", ["phaseProofRegistry"]);
  const wrongMedia = makeExecutionObservation("mutation-media");
  wrongMedia.stderrArtifact.mediaType = "text/plain";
  const oversized = {
    schema: quality.SCHEMAS.parserPopulation,
    cases: [
      {
        inputArtifact: {
          ...artifactFor(
            "parser_population",
            ["cases", 0, "inputArtifact"],
            "mutation-size",
          ),
          byteLength: 16 * 1024 * 1024 + 1,
        },
      },
    ],
  };
  const wrongAlias = makeQualityReceipt("mutation-alias");
  wrongAlias.coverage = artifactFor(
    "quality_receipt",
    ["coverage"],
    "mutation-wrong-coverage",
  );
  const wrongCardinality = makeQualityReceipt("mutation-cardinality");
  wrongCardinality.layerResults.coverage.outputArtifacts.push(
    clone(wrongCardinality.layerResults.coverage.outputArtifacts[0]),
  );
  const controllerAlias = makeQualityReceipt("mutation-controller");
  controllerAlias.primaryJudge = clone(
    controllerAlias.layerResults.unit.outputArtifacts[0],
  );
  const hiddenSite = makeExecutionObservation("mutation-hidden-site");
  hiddenSite.extraArtifact = artifactFor(
    "quality_policy",
    ["phaseProofRegistry"],
    "mutation-hidden-ref",
  );
  const unauthorizedCandidate = makeCandidateReceipt("mutation-closed-alias");
  unauthorizedCandidate.assertions = clone(
    unauthorizedCandidate.authoritySnapshot,
  );
  const firstIdentity = makeExecutionObservation("mutation-identity-a");
  const changedExecutionId = makeExecutionObservation("mutation-identity-b", {
    executionId: "mutation-different-id",
    layerId: firstIdentity.layerId,
    checkId: firstIdentity.checkId,
    definitionSha256: firstIdentity.definitionSha256,
    repeat: firstIdentity.repeat,
    seed: firstIdentity.seed,
    timeZone: firstIdentity.timeZone,
    orderId: firstIdentity.orderId,
    fixtureManifestSha256: firstIdentity.fixtureManifestSha256,
  });
  const changedCoordinate = makeExecutionObservation(
    "mutation-coordinate-b",
    {
      executionId: firstIdentity.executionId,
      layerId: firstIdentity.layerId,
      checkId: firstIdentity.checkId,
      definitionSha256: firstIdentity.definitionSha256,
      repeat: firstIdentity.repeat,
      seed: "mutation-different-seed",
      timeZone: firstIdentity.timeZone,
      orderId: firstIdentity.orderId,
      fixtureManifestSha256: firstIdentity.fixtureManifestSha256,
    },
  );

  const errorProbe = (operation, value, expectedCode) => ({
    kind: "expect_error",
    operation,
    value,
    expectedCode,
  });
  const payloadProbe = (roleValue, bytes, expectedCode) => ({
    kind: "expect_error",
    operation: "payload",
    role: roleValue,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    expectedCode,
  });
  const mutations = [
    {
      mutantId: "policy-frozen-binding-guard",
      replacements: [{
        before:
          "quality.CONTRACT_BINDING_SHA256 !== EXPECTED_CONTRACT_BINDING_SHA256",
        after:
          "quality.CONTRACT_BINDING_SHA256 === EXPECTED_CONTRACT_BINDING_SHA256",
      }],
      probe: { kind: "noop" },
      expected: {
        outcome: "init_refusal",
        code: "QUALITY_CONTRACT_BINDING_DRIFT",
        fingerprint: "init:QUALITY_CONTRACT_BINDING_DRIFT",
      },
    },
    {
      mutantId: "policy-proxy-refusal",
      replacements: [{
        before:
          "if (isProxy(value)) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_PROXY",
        after:
          "if (false) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_PROXY",
      }],
      probe: {
        kind: "expect_proxy_refusal",
        operation: "canonicalize",
        location: "root",
        value: validRole,
      },
      fingerprint: "PROXY_REFUSED/traps:0->",
      fingerprintPrefix: true,
    },
    {
      mutantId: "policy-payload-proxy-refusal",
      replacements: [{
        before:
          "if (isProxy(bytes)) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_PAYLOAD_PROXY",
        after:
          "if (false) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_PAYLOAD_PROXY",
      }],
      probe: {
        kind: "expect_payload_proxy_refusal",
        role: validRole,
        bytesBase64: Buffer.from(
          quality.stableJson({
            schema: "pikiio-phase-proof-registry-v1",
          }),
          "utf8",
        ).toString("base64"),
      },
      fingerprint: "PROXY_REFUSED/traps:0->",
      fingerprintPrefix: true,
    },
    {
      mutantId: "policy-wildcard-role",
      replacements: [{
        before:
          'segment.includes("*") || // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_WILDCARD\n        !/^[A-Za-z][A-Za-z0-9_]*$/.test(segment)',
        after: "false",
      }],
      probe: errorProbe(
        "canonicalize",
        { ...validRole, path: ["*"] },
        "WILDCARD_ROLE_REFUSED",
      ),
      fingerprint: "WILDCARD_ROLE_REFUSED->UNKNOWN_ARTIFACT_ROLE",
    },
    {
      mutantId: "policy-media-binding",
      replacements: [{
        before:
          "validated.mediaType !== policy.mediaType) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_MEDIA",
        after:
          "false) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_MEDIA",
      }],
      probe: errorProbe(
        "enumerate",
        enumeration("execution_observation", wrongMedia),
        "ARTIFACT_MEDIA_TYPE_MISMATCH",
      ),
      fingerprint: "ARTIFACT_MEDIA_TYPE_MISMATCH->NO_REFUSAL",
    },
    {
      mutantId: "policy-size-binding",
      replacements: [{
        before:
          "validated.byteLength > policy.maximumBytes) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_SIZE",
        after:
          "false) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_SIZE",
      }],
      probe: errorProbe(
        "enumerate",
        enumeration("parser_population", oversized),
        "ARTIFACT_SIZE_LIMIT",
      ),
      fingerprint: "ARTIFACT_SIZE_LIMIT->NO_REFUSAL",
    },
    {
      mutantId: "policy-payload-schema",
      replacements: [{
        before: "if (parsed.schema !== policy.payloadSchema) {",
        after: "if (false) {",
      }],
      probe: payloadProbe(
        validRole,
        quality.stableJson({ schema: "wrong" }),
        "PAYLOAD_SCHEMA_MISMATCH",
      ),
      fingerprint: "PAYLOAD_SCHEMA_MISMATCH->NO_REFUSAL",
    },
    {
      mutantId: "policy-canonical-json",
      replacements: [{
        before: "if (canonicalJson(parsed) !== text) {",
        after: "if (false) {",
      }],
      probe: payloadProbe(
        validRole,
        `${quality.stableJson({
          schema: "pikiio-phase-proof-registry-v1",
        })}\n`,
        "NON_CANONICAL_JSON_BYTES",
      ),
      fingerprint: "NON_CANONICAL_JSON_BYTES->NO_REFUSAL",
    },
    {
      mutantId: "policy-byte-envelope-validator",
      replacements: [{
        before: 'if (policy.validatorId === "byte_stream_envelope_v1") {',
        after: "if (false) {",
      }],
      probe: payloadProbe(
        role("execution_observation", [
          "layers",
          "unit",
          "stderrArtifact",
        ]),
        quality.stableJson({
          schema: "pikiio-byte-stream-envelope-v1",
          encoding: "wrong",
          decodedByteLength: 0,
          base64: "",
        }),
        "BYTE_STREAM_ENCODING_INVALID",
      ),
      fingerprint: "BYTE_STREAM_ENCODING_INVALID->NO_REFUSAL",
    },
    {
      mutantId: "policy-hash-body-field",
      replacements: [{
        before:
          "if (Object.prototype.hasOwnProperty.call(parsed, policy.selfHashField)) {",
        after: "if (false) {",
      }],
      probe: payloadProbe(
        role("attestation_body", ["artifacts", "qualityReceipt"]),
        quality.stableJson({
          schema: quality.SCHEMAS.qualityReceipt,
          receiptHash: digest("mutation-forged-body"),
        }),
        "SELF_HASH_FIELD_PRESENT",
      ),
      fingerprint: "SELF_HASH_FIELD_PRESENT->NO_REFUSAL",
    },
    {
      mutantId: "policy-verifier-producer-separation",
      replacements: [{
        before: 'layerPayloadSchema(layerId, "verifier-raw-result")',
        after: 'layerPayloadSchema(layerId, "producer-parsed-output")',
      }],
      probe: {
        kind: "compare_role_payloads",
        left: role("execution_observation", [
          "layers",
          "focused_verifier",
          "parsedOutputArtifact",
        ]),
        right: role("verifier_output", [
          "layers",
          "focused_verifier",
          "rawResultArtifact",
        ]),
        relation: "different",
      },
      fingerprint:
        "different->pikiio-quality-focused-verifier-producer-parsed-output-v1|pikiio-quality-focused-verifier-producer-parsed-output-v1",
    },
    {
      mutantId: "policy-required-alias-defenses",
      replacements: [
        {
          before:
            "canonicalJson(reference) !==\n        canonicalJson(outputs[provenance.outputIndex])",
          after: "false",
        },
        {
          before:
            "canonicalJson(left.artifact) !==\n      canonicalJson(right.artifact)",
          after: "false",
        },
      ],
      probe: errorProbe(
        "enumerate",
        enumeration("quality_receipt", wrongAlias),
        "REQUIRED_ARTIFACT_ALIAS_MISMATCH",
      ),
      fingerprint: "REQUIRED_ARTIFACT_ALIAS_MISMATCH->NO_REFUSAL",
    },
    {
      mutantId: "policy-specialized-cardinality",
      replacements: [{
        before: "outputs.length !== provenance.outputCardinality",
        after: "false",
      }],
      probe: errorProbe(
        "enumerate",
        enumeration("quality_receipt", wrongCardinality),
        "SPECIALIZED_ARTIFACT_CARDINALITY_MISMATCH",
      ),
      fingerprint:
        "SPECIALIZED_ARTIFACT_CARDINALITY_MISMATCH->UNKNOWN_ARTIFACT_ROLE",
    },
    {
      mutantId: "policy-controller-only",
      replacements: [{
        before:
          "layerOutputAddresses.has(address) ||\n        controllerAddresses.has(address)",
        after: "false",
      }],
      probe: errorProbe(
        "enumerate",
        enumeration("quality_receipt", controllerAlias),
        "CONTROLLER_ONLY_ARTIFACT_ALIAS",
      ),
      fingerprint:
        "CONTROLLER_ONLY_ARTIFACT_ALIAS->ARTIFACT_ALIAS_REFUSED",
    },
    {
      mutantId: "policy-closed-alias",
      replacements: [{
        before:
          "!ALLOWED_ALIAS_PAIR_KEYS.has(pairKey) // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_CLOSED_ALIAS",
        after:
          "false // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_CLOSED_ALIAS",
      }],
      probe: errorProbe(
        "enumerate",
        enumeration("candidate_receipt", unauthorizedCandidate),
        "ARTIFACT_ALIAS_REFUSED",
      ),
      fingerprint: "ARTIFACT_ALIAS_REFUSED->NO_REFUSAL",
    },
    {
      mutantId: "policy-undeclared-site",
      replacements: [{
        before:
          "new Set(expectedPathKeys).size !== expectedPathKeys.length ||\n    expectedPathKeys.length !== discoveredPathKeys.length ||\n    [...expectedPathKeys].sort(compareCodeUnits).some(\n      (entry, index) =>\n        entry !== [...discoveredPathKeys].sort(compareCodeUnits)[index],\n    )",
        after: "false",
      }],
      probe: errorProbe(
        "enumerate",
        enumeration("execution_observation", hiddenSite),
        "UNDECLARED_ARTIFACT_REFERENCE",
      ),
      fingerprint: "UNDECLARED_ARTIFACT_REFERENCE->NO_REFUSAL",
    },
    {
      mutantId: "policy-matrix-wrapper",
      replacements: [{
        before: 'executionMatrix: ["executionMatrix", "artifact"],',
        after: 'executionMatrix: ["executionMatrix"],',
      }],
      probe: errorProbe(
        "lookup",
        role("quality_receipt", ["executionMatrix"]),
        "UNKNOWN_ARTIFACT_ROLE",
      ),
      fingerprint: "UNKNOWN_ARTIFACT_ROLE->NO_REFUSAL",
    },
    {
      mutantId: "policy-caller-instance-decoration",
      replacements: [{
        before:
          'exactKeys(descriptor, ["schema", "root", "path"], "artifact role descriptor");',
        after:
          'exactKeys(descriptor, ["schema", "root", "path", "instance"], "artifact role descriptor");',
      }],
      probe: errorProbe(
        "canonicalize",
        { ...validRole, instance: "caller" },
        "EXACT_KEYS_REQUIRED",
      ),
      fingerprint: "EXACT_KEYS_REQUIRED->NO_REFUSAL",
    },
    {
      mutantId: "policy-binding-digest-omission",
      replacements: [{
        before:
          "contractBindingSha256: quality.CONTRACT_BINDING_SHA256,",
        after: 'contractBindingSha256: "0".repeat(64),',
      }],
      probe: {
        kind: "expect_property",
        path: ["ARTIFACT_POLICY", "contractBindingSha256"],
        expected: binding.CONTRACT_BINDING_SHA256,
      },
      fingerprint:
        `${JSON.stringify(binding.CONTRACT_BINDING_SHA256)}->${JSON.stringify("0".repeat(64))}`,
    },
    {
      mutantId: "policy-execution-id-instance-hash",
      replacements: [{
        before:
          "canonicalJson({ executionId, ...coordinate })",
        after: "canonicalJson(coordinate)",
      }],
      probe: {
        kind: "compare_execution_identity",
        left: enumeration("execution_observation", firstIdentity),
        right: enumeration("execution_observation", changedExecutionId),
        field: "instanceSha256",
      },
      fingerprint: "different->",
      fingerprintPrefix: true,
    },
    {
      mutantId: "policy-execution-id-uniqueness",
      replacements: [{
        before:
          "priorCoordinate !== undefined &&\n      priorCoordinate !== instance.coordinateSha256",
        after: "false",
      }],
      probe: errorProbe(
        "enumerate_set",
        [
          enumeration("execution_observation", firstIdentity),
          enumeration("execution_observation", changedCoordinate),
        ],
        "EXECUTION_ID_COORDINATE_COLLISION",
      ),
      fingerprint: "EXECUTION_ID_COORDINATE_COLLISION->NO_REFUSAL",
    },
    {
      mutantId: "policy-coordinate-uniqueness",
      replacements: [{
        before:
          "priorExecution !== undefined &&\n      priorExecution !== instance.executionId",
        after: "false",
      }],
      probe: errorProbe(
        "enumerate_set",
        [
          enumeration("execution_observation", firstIdentity),
          enumeration("execution_observation", changedExecutionId),
        ],
        "DUPLICATE_EXECUTION_COORDINATE",
      ),
      fingerprint: "DUPLICATE_EXECUTION_COORDINATE->NO_REFUSAL",
    },
  ];

  for (const field of [
    "layerId",
    "checkId",
    "definitionSha256",
    "repeat",
    "seed",
    "timeZone",
    "orderId",
    "fixtureManifestSha256",
  ]) {
    const changed = makeExecutionObservation(`mutation-tuple-${field}`, {
      executionId: firstIdentity.executionId,
      layerId: firstIdentity.layerId,
      checkId: firstIdentity.checkId,
      definitionSha256: firstIdentity.definitionSha256,
      repeat: firstIdentity.repeat,
      seed: firstIdentity.seed,
      timeZone: firstIdentity.timeZone,
      orderId: firstIdentity.orderId,
      fixtureManifestSha256: firstIdentity.fixtureManifestSha256,
      [field]:
        field.endsWith("Sha256")
          ? digest(`mutation-${field}`)
          : field === "repeat"
            ? 2
            : field === "layerId"
              ? "contract"
              : `mutation-${field}`,
    });
    mutations.push({
      mutantId: `policy-coordinate-hash-${field}`,
      replacements: [{
        before:
          "const coordinateSha256 = sha256(canonicalJson(coordinate));",
        after:
          `const coordinateSha256 = sha256(canonicalJson(Object.fromEntries(Object.entries(coordinate).filter(([key]) => key !== ${JSON.stringify(field)}))));`,
      }],
      probe: {
        kind: "compare_execution_identity",
        left: enumeration("execution_observation", firstIdentity),
        right: enumeration("execution_observation", changed),
        field: "coordinateSha256",
      },
      fingerprint: "different->",
      fingerprintPrefix: true,
    });
  }

  assert.equal(mutations.length, 30);
  assert.equal(
    new Set(mutations.map((mutation) => mutation.mutantId)).size,
    30,
  );
  const receipts = [];
  for (const mutation of mutations) {
    const baseline = runMutationChild(
      policyProbeInput(
        `${mutation.mutantId}:baseline`,
        source,
        mutation.probe,
      ),
    );
    assert.equal(baseline.outcome, "probe_pass", mutation.mutantId);
    assert.equal(baseline.code, "PASS", mutation.mutantId);
    assert.equal(baseline.fingerprint, "probe:pass", mutation.mutantId);

    const mutantSource = applyMutation(source, mutation);
    assert.notEqual(digest(mutantSource), digest(source), mutation.mutantId);
    const receipt = runMutationChild(
      policyProbeInput(
        mutation.mutantId,
        mutantSource,
        mutation.probe,
      ),
    );
    if (mutation.expected) {
      assert.equal(receipt.outcome, mutation.expected.outcome, mutation.mutantId);
      assert.equal(receipt.code, mutation.expected.code, mutation.mutantId);
      assert.equal(
        receipt.fingerprint,
        mutation.expected.fingerprint,
        mutation.mutantId,
      );
    } else {
      assert.equal(receipt.outcome, "causal_refusal", mutation.mutantId);
      assert.equal(
        receipt.code,
        "MUTATION_CAUSAL_FINGERPRINT",
        mutation.mutantId,
      );
      if (mutation.fingerprintPrefix) {
        assert.equal(
          receipt.fingerprint.startsWith(mutation.fingerprint),
          true,
          `${mutation.mutantId}: ${receipt.fingerprint}`,
        );
        assert.notEqual(
          receipt.fingerprint,
          `${mutation.fingerprint}${baseline.fingerprint}`,
          mutation.mutantId,
        );
      } else {
        assert.equal(
          receipt.fingerprint,
          mutation.fingerprint,
          mutation.mutantId,
        );
      }
    }
    receipts.push(receipt);
  }
  assert.equal(
    new Set(receipts.map((receipt) => receipt.mutantId)).size,
    mutations.length,
  );
  assert.equal(receipts.length, mutations.length);
  assert.equal(
    receipts.every(
      (receipt) =>
        receipt.outcome === "causal_refusal" ||
        receipt.outcome === "init_refusal",
    ),
    true,
  );
  },
);

test(
  "binding drift and validator mutations emit exact causal receipts at 100 percent",
  { skip: process.env.PIKIIO_SKIP_MUTATION === "1" },
  () => {
  const bindingSource = fs.readFileSync(BINDING_PATH, "utf8");
  const policySource = fs.readFileSync(POLICY_PATH, "utf8");
  const driftMutations = [
    {
      mutantId: "binding-contract-source-sha",
      before: binding.CONTRACT_SOURCE_SHA256,
      after:
        `${binding.CONTRACT_SOURCE_SHA256[0] === "0" ? "1" : "0"}` +
        binding.CONTRACT_SOURCE_SHA256.slice(1),
    },
    {
      mutantId: "binding-contract-test-sha",
      before: binding.CONTRACT_TEST_SHA256,
      after:
        `${binding.CONTRACT_TEST_SHA256[0] === "0" ? "1" : "0"}` +
        binding.CONTRACT_TEST_SHA256.slice(1),
    },
    {
      mutantId: "binding-layer-registry",
      before: '  "independent_frozen_hash_review",\n]);',
      after: "]);",
    },
    {
      mutantId: "binding-provenance-index",
      before:
        '  operationalAfterManifest: {\n    kind: "layer_output",\n    layerId: "operational_integrity",\n    outputIndex: 1,',
      after:
        '  operationalAfterManifest: {\n    kind: "layer_output",\n    layerId: "operational_integrity",\n    outputIndex: 0,',
    },
    {
      mutantId: "binding-artifact-site-manifest",
      before: '"quality_receipt.execution_matrix"',
      after: '"quality_receipt.coverage"',
    },
  ];
  const driftReceipts = [];
  for (const mutation of driftMutations) {
    const mutantBinding = replaceExactlyOnce(
      bindingSource,
      mutation.before,
      mutation.after,
      mutation.mutantId,
    );
    const baseline = runMutationChild(
      policyProbeInput(
        `${mutation.mutantId}:baseline`,
        policySource,
        { kind: "noop" },
        bindingSource,
      ),
    );
    assert.equal(baseline.outcome, "probe_pass", mutation.mutantId);
    const receipt = runMutationChild(
      policyProbeInput(
        mutation.mutantId,
        policySource,
        { kind: "noop" },
        mutantBinding,
      ),
    );
    assert.equal(receipt.outcome, "init_refusal", mutation.mutantId);
    assert.equal(receipt.code, "QUALITY_CONTRACT_BINDING_DRIFT", mutation.mutantId);
    assert.equal(
      receipt.fingerprint,
      "init:QUALITY_CONTRACT_BINDING_DRIFT",
      mutation.mutantId,
    );
    driftReceipts.push(receipt);
  }

  const valid = {
    schema: binding.SCHEMAS.artifactRef,
    address: `sha256:${digest("binding-mutation-valid")}`,
    sha256: digest("binding-mutation-valid"),
    byteLength: 1,
    mediaType: "application/json",
  };
  const validatorMutations = [
    {
      mutantId: "binding-ref-proxy",
      before:
        "if (isProxy(value)) { // QUALITY_CONTRACT_BINDING_MUTATION_ANCHOR_PROXY",
      after:
        "if (false) { // QUALITY_CONTRACT_BINDING_MUTATION_ANCHOR_PROXY",
      probe: {
        kind: "expect_proxy_refusal",
        operation: "binding_ref",
        value: valid,
      },
      expectedFingerprint: "PROXY_REFUSED/traps:0->",
      fingerprintPrefix: true,
    },
    {
      mutantId: "binding-ref-schema",
      before: "if (value.schema !== SCHEMAS.artifactRef) {",
      after: "if (false) {",
      value: { ...valid, schema: "wrong" },
      expectedCode: "SCHEMA_INVALID",
    },
    {
      mutantId: "binding-ref-sha",
      before:
        'if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {',
      after: "if (false) {",
      value: { ...valid, sha256: "x", address: "sha256:x" },
      expectedCode: "INVALID_SHA256",
    },
    {
      mutantId: "binding-ref-address",
      before: "if (value.address !== `sha256:${value.sha256}`) {",
      after: "if (false) {",
      value: { ...valid, address: `sha256:${digest("wrong-address")}` },
      expectedCode: "ARTIFACT_ADDRESS_MISMATCH",
    },
    {
      mutantId: "binding-ref-size",
      before:
        "if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) {",
      after: "if (false) {",
      value: { ...valid, byteLength: 0 },
      expectedCode: "INVALID_COUNTER",
    },
    {
      mutantId: "binding-ref-media",
      before:
        'typeof value.mediaType !== "string" ||\n    !/^[a-z0-9][a-z0-9.+-]+\\/[a-z0-9][a-z0-9.+-]+$/.test(value.mediaType)',
      after: "false",
      value: { ...valid, mediaType: "INVALID" },
      expectedCode: "INVALID_STRING",
    },
  ];
  const validatorReceipts = [];
  for (const mutation of validatorMutations) {
    const probe =
      mutation.probe || {
        kind: "expect_error",
        operation: "binding_ref",
        value: mutation.value,
        expectedCode: mutation.expectedCode,
      };
    const baseline = runMutationChild(
      bindingProbeInput(
        `${mutation.mutantId}:baseline`,
        bindingSource,
        probe,
      ),
    );
    assert.equal(baseline.outcome, "probe_pass", mutation.mutantId);
    const mutantSource = replaceExactlyOnce(
      bindingSource,
      mutation.before,
      mutation.after,
      mutation.mutantId,
    );
    const receipt = runMutationChild(
      bindingProbeInput(mutation.mutantId, mutantSource, probe),
    );
    assert.equal(receipt.outcome, "causal_refusal", mutation.mutantId);
    assert.equal(receipt.code, "MUTATION_CAUSAL_FINGERPRINT", mutation.mutantId);
    if (mutation.fingerprintPrefix) {
      assert.equal(
        receipt.fingerprint.startsWith(mutation.expectedFingerprint),
        true,
        `${mutation.mutantId}: ${receipt.fingerprint}`,
      );
    } else {
      assert.equal(
        receipt.fingerprint,
        `${mutation.expectedCode}->NO_REFUSAL`,
        mutation.mutantId,
      );
    }
    validatorReceipts.push(receipt);
  }
  assert.equal(driftReceipts.length, driftMutations.length);
  assert.equal(validatorReceipts.length, validatorMutations.length);
  assert.equal(driftMutations.length, 5);
  assert.equal(validatorMutations.length, 6);
  assert.equal(
    new Set(
      [...driftMutations, ...validatorMutations].map(
        (mutation) => mutation.mutantId,
      ),
    ).size,
    11,
  );
  },
);

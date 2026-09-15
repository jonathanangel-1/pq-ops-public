"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const contract = require("../lib/pikiio-quality-contract-v3");

const {
  CONDITIONAL_LAYER_IDS,
  EVIDENCE_LAYER_IDS,
  EXECUTION_ZERO_FAILURE_KEYS,
  IDENTITY_ROLE_VALUES,
  IMMUTABLE_RESOURCE_CEILINGS,
  LEGACY_REFUSALS,
  PRODUCER_OUTPUT_SCHEMAS,
  ROLE_NAMES,
  SCHEMAS,
  SPECIALIZED_ARTIFACT_PROVENANCE,
  ZERO_FAILURE_KEYS,
  builders,
  hashWithoutField,
  layerSemanticHash,
  semanticHashWithoutField,
  sha256,
  stableJson,
  validateArtifactRef,
  validateAttestationBodyV3,
  validateAuthorityIdentity,
  validateCandidateReceiptV3,
  validateConcurrencyPopulation,
  validateCoverageInputManifest,
  validateCoverageProofV2,
  validateCrashPopulation,
  validateExecutionObservationV3,
  validateFrozenReviewReceiptV1,
  validateLayerPassV2,
  validateNotApplicableResult,
  validateOperationalManifestV2,
  validateParserPopulation,
  validatePhaseQualityPlanV4,
  validatePopulationFloorV3,
  validateQualityPolicyV4,
  validateQualityReceiptV7,
  validateVerifierOutput,
} = contract;

const NOW = "2026-07-25T12:00:00.000Z";
const LATER = "2026-07-25T12:00:01.000Z";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);

function clone(value) {
  return structuredClone(value);
}

function digest(seed) {
  return sha256(`fixture:${seed}`);
}

function artifact(seed, mediaType = "application/json") {
  const hash = digest(seed);
  return builders.artifactRef({
    address: `sha256:${hash}`,
    sha256: hash,
    byteLength: Buffer.byteLength(seed) || 1,
    mediaType,
  });
}

function artifactFromHash(hash, seed = "bound") {
  return builders.artifactRef({
    address: `sha256:${hash}`,
    sha256: hash,
    byteLength: Buffer.byteLength(seed) || 1,
    mediaType: "application/json",
  });
}

function matrix(fields) {
  const value = { ...fields };
  value.matrixSha256 = contract.hashWithoutField(value, "matrixSha256");
  return value;
}

function identity(role, seed, authorizing = true, credentialKind = "github_oidc_receipt") {
  return builders.authorityIdentity({
    role,
    issuer: `issuer-${seed}`,
    subject: `subject-${seed}`,
    credentialKind,
    credentialSha256: digest(`credential-${seed}`),
    authorizing,
  });
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "QualityContractV4Error");
    assert.equal(error.code, code);
    return true;
  });
}

function assertContractError(fn) {
  assert.throws(fn, (error) => error?.name === "QualityContractV4Error");
}

const PROXY_TRAP_NAMES = Object.freeze([
  "apply",
  "construct",
  "defineProperty",
  "deleteProperty",
  "get",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
  "setPrototypeOf",
]);

function instrumentedProxy(target, { throwing = false, revoked = false } = {}) {
  const counter = { count: 0 };
  const handler = Object.fromEntries(
    PROXY_TRAP_NAMES.map((trapName) => [
      trapName,
      (...args) => {
        counter.count += 1;
        if (throwing) {
          throw new Error(`proxy trap executed: ${trapName}`);
        }
        return Reflect[trapName](...args);
      },
    ]),
  );
  if (revoked) {
    const revocable = Proxy.revocable(target, handler);
    revocable.revoke();
    return { value: revocable.proxy, counter };
  }
  return { value: new Proxy(target, handler), counter };
}

function assertProxyRefusedWithoutTrap(invoke, value, counter, label) {
  const didNotReturn = Symbol("did-not-return");
  let returned = didNotReturn;
  assert.throws(
    () => {
      returned = invoke(value);
    },
    (error) => {
      assert.equal(error?.name, "QualityContractV4Error", label);
      assert.equal(error?.code, "PROXY_REFUSED", label);
      return true;
    },
    label,
  );
  assert.equal(returned, didNotReturn, `${label} returned a partial result`);
  assert.equal(counter.count, 0, `${label} executed a proxy trap`);
}

function rootProxyVariants(target) {
  return [
    ["transparent object", instrumentedProxy(target)],
    ["throwing object", instrumentedProxy(target, { throwing: true })],
    ["callable", instrumentedProxy(function proxyCallable() {})],
    [
      "revoked object",
      instrumentedProxy({}, { throwing: true, revoked: true }),
    ],
    [
      "revoked array",
      instrumentedProxy([], { throwing: true, revoked: true }),
    ],
    [
      "revoked callable",
      instrumentedProxy(
        function revokedProxyCallable() {},
        { throwing: true, revoked: true },
      ),
    ],
  ];
}

function unsealBuilderInput(value, ...derivedFields) {
  const fields = clone(value);
  delete fields.schema;
  for (const field of derivedFields) delete fields[field];
  return fields;
}

function rootShapeGauntlet(value, validate) {
  for (const key of Object.keys(value)) {
    const missing = clone(value);
    delete missing[key];
    assertContractError(() => validate(missing));
  }
  const unknown = clone(value);
  unknown.unexpected = true;
  assertContractError(() => validate(unknown));

  const wrongPrototype = clone(value);
  Object.setPrototypeOf(wrongPrototype, { polluted: true });
  assertCode(() => validate(wrongPrototype), "INVALID_PROTOTYPE");

  const symbol = clone(value);
  symbol[Symbol("hidden")] = true;
  assertCode(() => validate(symbol), "SYMBOL_FIELD_REFUSED");

  const accessor = clone(value);
  const firstKey = Object.keys(accessor)[0];
  Object.defineProperty(accessor, firstKey, {
    enumerable: true,
    get() {
      return value[firstKey];
    },
  });
  assertCode(() => validate(accessor), "ACCESSOR_FIELD_REFUSED");
}

function hostileAuthorityValue(base, nestedKey, kind, authorizing) {
  const value = clone(base);
  value.authorizing = authorizing;
  if (kind === "missing_context") return value;
  if (kind === "malformed_ref") {
    value[nestedKey] = {};
    return value;
  }
  if (kind === "accessor") {
    Object.defineProperty(value[nestedKey], "hostileAccessor", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("nested getter must never execute");
      },
    });
    return value;
  }
  if (kind === "cycle") {
    value[nestedKey].hostileCycle = value;
    return value;
  }
  if (kind === "depth_20000") {
    let cursor = {};
    value[nestedKey].hostileDepth = cursor;
    for (let depth = 0; depth < 20000; depth += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    return value;
  }
  throw new Error(`unsupported hostile kind: ${kind}`);
}

function unsealLayerPass(value) {
  const fields = clone(value);
  delete fields.schema;
  delete fields.semanticSha256;
  delete fields.receiptHash;
  return fields;
}

function unsealQualityReceipt(value) {
  const fields = clone(value);
  delete fields.schema;
  delete fields.receiptHash;
  return fields;
}

function makeFixture() {
  const shared = artifact("shared");
  const artifactPolicySha256 = digest("artifact-policy-v1");
  const crosswalk = Object.fromEntries(
    EVIDENCE_LAYER_IDS.map((layerId, index) => [
      layerId,
      {
        ordinal: index + 1,
        planKey: layerId,
        producerOutputSchema: PRODUCER_OUTPUT_SCHEMAS[layerId],
        layerResultSchema: SCHEMAS.layerPass,
        populationKey: layerId,
        rawArtifactRequired: true,
        notApplicableReasonCodes:
          layerId === "production_shaped_rehearsal"
            ? ["phase_has_no_production_surface"]
            : layerId === "natural_cycle_qa"
              ? [
                  "candidate_stage_precedes_natural_cycles",
                  "phase_has_no_natural_cycle_surface",
                ]
              : layerId === "api_browser_parity"
                ? [
                    "candidate_stage_precedes_browser_observation",
                    "phase_has_no_browser_surface",
                  ]
                : [],
      },
    ]),
  );
  const policy = builders.qualityPolicy({
    revision: 4,
    bootstrapRevision: 1,
    artifactPolicySha256,
    noThresholdChangeWithBehaviorChange: true,
    noTestWeakeningWithBehaviorChange: true,
    supportedEvidenceOrder: [...EVIDENCE_LAYER_IDS],
    evidenceCrosswalk: crosswalk,
    profiles: {
      critical: {
        lineCoveragePercent: 95,
        branchCoveragePercent: 90,
        functionCoveragePercent: 95,
        mutationScorePercent: 90,
        criticalMutationKillPercent: 100,
        gherkinPassPercent: 100,
        deterministicRepeatCount: 3,
      },
    },
    zeroFailureFloors: Object.fromEntries(
      ZERO_FAILURE_KEYS.map((key) => [key, 0]),
    ),
    approvedToolchains: [artifact("toolchain")],
    trustedGatePaths: ["lib/pikiio-quality-contract-v3.js"],
    authorityPaths: ["YLYI/05_Agent_Runbooks/Pikiio_Quality_Gauntlet.md"],
    phaseProofRegistry: artifact("phase-proof-registry"),
    receiptSchemas: {
      qualityPlan: SCHEMAS.qualityPlan,
      populationFloor: SCHEMAS.populationFloor,
      qualityReceipt: SCHEMAS.qualityReceipt,
      candidateReceipt: SCHEMAS.candidateReceipt,
      attestationBody: SCHEMAS.attestationBody,
      frozenReview: SCHEMAS.frozenReview,
    },
    resourceCeilings: { ...IMMUTABLE_RESOURCE_CEILINGS },
  });

  const conditionalNa = new Set(["natural_cycle_qa", "api_browser_parity"]);
  const layerMinimums = Object.fromEntries(
    EVIDENCE_LAYER_IDS.map((layerId) => [
      layerId,
      {
        minimumCases: conditionalNa.has(layerId) ? 0 : 1,
        minimumAssertions: conditionalNa.has(layerId) ? 0 : 1,
      },
    ]),
  );
  const floor = builders.populationFloor({
    layerMinimums,
    coverage: { minimumRequiredFiles: 1 },
    mutation: { minimumTotalMutants: 1, minimumCriticalMutants: 1 },
    deterministicRepeat: { minimumRuns: 3 },
    crashRestart: { minimumFaultPoints: 1 },
    concurrency: {
      minimumIdenticalCases: 1,
      minimumDivergentCases: 1,
      minimumStaleOwnerCases: 1,
    },
    parserRobustness: {
      minimumMalformedCases: 1,
      minimumBoundaryCases: 1,
    },
    independentReview: {
      minimumCertifierRuns: 1,
      minimumCoordinatorReruns: 1,
    },
    zeroFailure: Object.fromEntries(ZERO_FAILURE_KEYS.map((key) => [key, 0])),
  });

  const layers = Object.fromEntries(
    EVIDENCE_LAYER_IDS.map((layerId) => {
      const na = conditionalNa.has(layerId);
      const reasonCode =
        layerId === "natural_cycle_qa"
          ? "candidate_stage_precedes_natural_cycles"
          : "candidate_stage_precedes_browser_observation";
      return [
        layerId,
        {
          layerId,
          disposition: na
            ? {
                kind: "not_applicable",
                reasonCode,
                policyRuleId: `rule-${layerId}`,
                policyRuleSha256: digest(`rule-${layerId}`),
              }
            : { kind: "required" },
          checkIds: na ? [] : [`check-${layerId}`],
          definitionManifestSha256: na ? null : digest(`definition-${layerId}`),
          producerOutputSchema: na
            ? null
            : PRODUCER_OUTPUT_SCHEMAS[layerId],
          layerResultSchema: na
            ? SCHEMAS.notApplicable
            : SCHEMAS.layerPass,
        },
      ];
    }),
  );
  const plannedExecutionMatrix = matrix({
    mode: "cartesian_product",
    repeatsPerCell: 3,
    seeds: ["seed-a", "seed-b"],
    timeZones: ["America/New_York", "UTC"],
    orders: ["forward", "reverse"],
    fixtureManifestSha256: digest("fixtures"),
    expectedExecutionCount: 24,
  });
  const plan = builders.qualityPlan(
    {
      phaseId: "GOV-01",
      policySha256: policy.policySha256,
      artifactPolicySha256,
      populationFloorSha256: floor.floorHash,
      syntaxFiles: [
        "lib/pikiio-quality-contract-v3.js",
        "tests/pikiio-quality-contract-v3.test.js",
      ],
      layers,
      executionMatrix: plannedExecutionMatrix,
      coveragePlan: {
        selectorId: "changed-files-v2",
        requiredFileRules: ["lib/pikiio-quality-contract-v3.js"],
        rawInputOrder: "semantic_payload_sha_with_multiplicity",
        collectorDefinitionSha256: digest("coverage-collector"),
        lineFloorPercent: 95,
        branchFloorPercent: 90,
        functionFloorPercent: 95,
      },
      mutationPlan: {
        classifierId: "critical-boundary-v1",
        profileIds: ["arithmetic", "boolean", "hash-binding"],
        criticalIdsSha256: digest("critical-mutants"),
        scoreFloorPercent: 90,
        criticalKillFloorPercent: 100,
      },
      operationalIntegrityPlan: {
        manifestSchema: SCHEMAS.operationalManifest,
        automationInputSchema: "pikiio-automation-input-manifest-v1",
        candidateReadOnly: true,
        completePrePostObjectsRequired: true,
      },
      resourceLimits: {
        timeoutMsPerExecution: 120000,
        maximumStdoutBytes: 1048576,
        maximumStderrBytes: 1048576,
        maximumPeakRssBytes: 1073741824,
        maximumProcessCount: 16,
        maximumRetries: 0,
      },
    },
    policy,
  );

  const layerResults = Object.fromEntries(
    EVIDENCE_LAYER_IDS.map((layerId) => {
      if (conditionalNa.has(layerId)) {
        const disposition = plan.layers[layerId].disposition;
        return [
          layerId,
          builders.notApplicable({
            layerId,
            status: "not_applicable",
            reasonCode: disposition.reasonCode,
            policyRuleId: disposition.policyRuleId,
            policyRuleSha256: disposition.policyRuleSha256,
            policySha256: policy.policySha256,
            qualityPlanSha256: plan.planSha256,
            observedAt: NOW,
          }),
        ];
      }
      return [
        layerId,
        builders.layerPass({
          layerId,
          status: "passed",
          checkIds: [...plan.layers[layerId].checkIds],
          definitionManifestSha256:
            plan.layers[layerId].definitionManifestSha256,
          executions:
            layerId === "deterministic_repeat"
              ? Array.from(
                  {
                    length: plan.executionMatrix.expectedExecutionCount,
                  },
                  (_, index) =>
                    artifact(`execution-${layerId}-${index + 1}`),
                )
              : [artifact(`execution-${layerId}`)],
          rawPopulationArtifact: artifact(`population-${layerId}`),
          outputArtifacts:
            layerId === "operational_integrity"
              ? [
                  artifact("operational-before"),
                  artifact("operational-after"),
                  artifact("automation-inputs"),
                ]
              : [artifact(`output-${layerId}`)],
          minimumCasesObserved:
            layerId === "deterministic_repeat"
              ? plan.executionMatrix.expectedExecutionCount
              : 1,
          minimumAssertionsObserved: 1,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
          flaky: 0,
          warnings: 0,
          timeouts: 0,
          signals: 0,
          retries: 0,
        }),
      ];
    }),
  );

  const identities = Object.fromEntries(
    ROLE_NAMES.map((key) => [
      key,
      identity(IDENTITY_ROLE_VALUES[key], `quality-${key}`, false),
    ]),
  );
  const implementer = identity("implementer", "review-implementer", false);
  const certifier = identity("certifier", "review-certifier", false);
  const coordinator = identity("coordinator", "review-coordinator", false);
  const reviewedManifest = artifact("reviewed-manifest");
  const frozenReview = builders.frozenReview({
    authorizing: false,
    reviewId: "review-1",
    phaseId: "GOV-01",
    candidateCommit: COMMIT_B,
    candidateTree: COMMIT_C,
    policySha256: policy.policySha256,
    qualityPlanSha256: plan.planSha256,
    registrySha256: digest("registry"),
    implementer,
    certifier,
    coordinator,
    reviewedManifest,
    findings: [],
    closureReceipts: [],
    certifierRuns: [artifact("certifier-run")],
    coordinatorRerun: artifact("coordinator-rerun"),
    postReviewManifest: clone(reviewedManifest),
    changedByteCount: 0,
    unresolvedBySeverity: {
      severity0: 0,
      severity1: 0,
      severity2: 0,
      severity3: 0,
    },
    status: "passed",
    recordedAt: NOW,
    priorReviewReceiptHash: null,
  });
  const frozenReviewLayerFields = unsealLayerPass(
    layerResults.independent_frozen_hash_review,
  );
  frozenReviewLayerFields.outputArtifacts = [
    artifactFromHash(frozenReview.receiptHash),
  ];
  layerResults.independent_frozen_hash_review =
    builders.layerPass(frozenReviewLayerFields);

  const operationalSemantic = digest("operational-semantic");
  const phaseRegistryRevision = 1;
  const qualityContext = {
    policy,
    qualityPlan: plan,
    populationFloor: floor,
    phaseRegistryRevision,
  };
  const quality = builders.qualityReceipt(
    {
      authorizing: false,
      recordedAt: NOW,
      artifactPolicySha256,
      ledgerBinding: {
        revision: 1,
        ledgerSha256: digest("ledger"),
        goalObjectiveSha256: digest("goal"),
      },
      phaseBinding: {
        phaseId: "GOV-01",
        phaseProofRegistrySha256: policy.phaseProofRegistry.sha256,
        qualityPolicySha256: policy.policySha256,
        qualityPlanSha256: plan.planSha256,
        populationFloorSha256: floor.floorHash,
        commandPlanSha256: digest("command-plan"),
        scopeBaseCommit: COMMIT_A,
        candidateCommit: COMMIT_B,
        candidateTree: COMMIT_C,
        workspaceDigest: digest("workspace"),
      },
      identities,
      thresholds: {
        ...policy.profiles.critical,
        populationFloorSha256: floor.floorHash,
      },
      layerResults,
      coverage: clone(layerResults.coverage.outputArtifacts[0]),
      mutation: clone(layerResults.mutation.outputArtifacts[0]),
      executionMatrix: {
        artifact: clone(
          layerResults.deterministic_repeat.outputArtifacts[0],
        ),
        matrixSha256: plan.executionMatrix.matrixSha256,
        expectedExecutionCount: plan.executionMatrix.expectedExecutionCount,
        observedExecutionCount: plan.executionMatrix.expectedExecutionCount,
        missingCoordinateCount: 0,
        duplicateCoordinateCount: 0,
        divergentCoordinateCount: 0,
      },
      operationalIntegrity: {
        beforeManifest: clone(
          layerResults.operational_integrity.outputArtifacts[0],
        ),
        afterManifest: clone(
          layerResults.operational_integrity.outputArtifacts[1],
        ),
        beforeSemanticSha256: operationalSemantic,
        afterSemanticSha256: operationalSemantic,
        automationInputs: clone(
          layerResults.operational_integrity.outputArtifacts[2],
        ),
        unchanged: true,
      },
      crashRestart: clone(layerResults.crash_restart.outputArtifacts[0]),
      concurrencyLinearizability: clone(
        layerResults.concurrency_linearizability.outputArtifacts[0],
      ),
      schemaParserRobustness: clone(
        layerResults.schema_parser_robustness.outputArtifacts[0],
      ),
      independentFrozenHashReview: {
        receiptHash: frozenReview.receiptHash,
        artifact: clone(
          layerResults.independent_frozen_hash_review.outputArtifacts[0],
        ),
      },
      antiWeakening: artifact("anti-weakening"),
      primaryJudge: artifact("primary-judge"),
      independentJudge: artifact("independent-judge"),
      rawEvidenceManifest: artifact("raw-evidence"),
      specializedArtifactProvenance: clone(
        SPECIALIZED_ARTIFACT_PROVENANCE,
      ),
    },
    qualityContext,
  );

  const candidate = builders.candidateReceipt(
    {
      authorizing: false,
      phaseId: "GOV-01",
      registryRevision: phaseRegistryRevision,
      registrySha256: quality.phaseBinding.phaseProofRegistrySha256,
      ledgerRevision: 1,
      ledgerSha256: quality.ledgerBinding.ledgerSha256,
      qualityPolicySha256: policy.policySha256,
      qualityPlanSha256: plan.planSha256,
      populationFloorSha256: floor.floorHash,
      artifactPolicySha256,
      scopeBaseCommit: COMMIT_A,
      candidateCommit: COMMIT_B,
      candidateTree: COMMIT_C,
      observedAt: NOW,
      status: "passed",
      previousReceiptHash: null,
      controller: builders.authorityIdentity({
        ...clone(identities.coordinator),
        role: "controller",
      }),
      collector: builders.authorityIdentity({
        ...clone(identities.collector),
        role: "collector",
      }),
      qualityReceiptHash: quality.receiptHash,
      frozenReviewReceiptHash: frozenReview.receiptHash,
      layerReceiptHashes: Object.fromEntries(
        EVIDENCE_LAYER_IDS.map((layerId) => [
          layerId,
          quality.layerResults[layerId].receiptHash,
        ]),
      ),
      rawEvidenceManifestSha256: quality.rawEvidenceManifest.sha256,
      authorityBaselineCommit: COMMIT_A,
      authorityBaselineSnapshotHash: digest("authority-baseline"),
      authoritySnapshot: artifact("authority-snapshot"),
      changedPathsManifest: artifact("changed-paths"),
      changedPathCoverage: artifact("changed-path-coverage"),
      assertions: artifact("assertions"),
      rawArtifact: artifact("candidate-raw"),
    },
    { ...qualityContext, qualityReceipt: quality },
  );

  const judgeHashes = {
    primary: quality.primaryJudge.sha256,
    independent: quality.independentJudge.sha256,
    collector: candidate.rawArtifact.sha256,
  };
  const phaseReceiptHashes = {
    candidate: candidate.receiptHash,
    rehearsal: digest("rehearsal"),
    change: digest("change"),
    promotion: digest("promotion"),
  };
  const sourceManifestSha256 = digest("source-manifest");
  const evidenceManifestSha256 = quality.rawEvidenceManifest.sha256;
  const attestationEvidence = {
    issuerRegistrySha256: digest("issuer-registry"),
    sourceManifestSha256,
    rehearsalReceiptHash: phaseReceiptHashes.rehearsal,
    changeReceiptHash: phaseReceiptHashes.change,
    promotionReceiptHash: phaseReceiptHashes.promotion,
  };
  const attestationContext = {
    ...qualityContext,
    qualityReceipt: quality,
    candidateReceipt: candidate,
    attestationEvidence,
  };
  const attestation = builders.attestationBody(
    {
      authorizing: false,
      phaseId: "GOV-01",
      issuerRegistrySha256: attestationEvidence.issuerRegistrySha256,
      ledgerRevision: 1,
      ledgerSha256: quality.ledgerBinding.ledgerSha256,
      phaseProofRegistrySha256: quality.phaseBinding.phaseProofRegistrySha256,
      qualityPolicySha256: policy.policySha256,
      qualityPlanSha256: plan.planSha256,
      populationFloorSha256: floor.floorHash,
      artifactPolicySha256,
      candidateCommit: COMMIT_B,
      candidateTree: COMMIT_C,
      sourceManifestSha256,
      strictQualityReceiptHash: quality.receiptHash,
      candidateReceiptHash: candidate.receiptHash,
      frozenReviewReceiptHash: frozenReview.receiptHash,
      commandPlanHash: quality.phaseBinding.commandPlanSha256,
      evidenceManifestSha256,
      judgeReceiptHashes: judgeHashes,
      rolePrincipalHashes: Object.fromEntries(
        ROLE_NAMES.map((key) => [key, identities[key].principalSha256]),
      ),
      phaseReceiptHashes,
      artifacts: {
        sourceManifest: artifactFromHash(sourceManifestSha256),
        qualityReceipt: artifactFromHash(quality.receiptHash),
        candidateReceipt: artifactFromHash(candidate.receiptHash),
        frozenReviewReceipt: artifactFromHash(frozenReview.receiptHash),
        evidenceManifest: artifactFromHash(evidenceManifestSha256),
        primaryRaw: artifactFromHash(judgeHashes.primary),
        independentRaw: artifactFromHash(judgeHashes.independent),
        rehearsalReceipt: artifactFromHash(phaseReceiptHashes.rehearsal),
        changeReceipt: artifactFromHash(phaseReceiptHashes.change),
        promotionReceipt: artifactFromHash(phaseReceiptHashes.promotion),
      },
      productionAuthority: false,
    },
    attestationContext,
  );

  return {
    shared,
    policy,
    floor,
    plan,
    layerResults,
    identities,
    frozenReview,
    qualityContext,
    quality,
    candidate,
    attestation,
    attestationContext,
  };
}

function makeAuxiliaryFixtures() {
  const a = artifact("auxiliary");
  const observation = builders.executionObservation({
    executionId: "aux-execution",
    layerId: "unit",
    checkId: "aux-check",
    definitionSha256: digest("aux-definition"),
    repeat: 1,
    seed: "seed",
    timeZone: "UTC",
    orderId: "forward",
    fixtureManifestSha256: digest("aux-fixtures"),
    runtime: {
      platform: "darwin",
      arch: "arm64",
      executableSha256: digest("aux-executable"),
      nodeVersion: "v25.0.0",
      nodeSha256: digest("aux-node"),
      npmVersion: "11.0.0",
      npmCliSha256: digest("aux-npm"),
      toolchainSha256: digest("aux-toolchain"),
      sandboxIdentitySha256: digest("aux-sandbox"),
    },
    process: {
      startedAt: NOW,
      finishedAt: LATER,
      elapsedMs: 1000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      retryCount: 0,
    },
    resources: {
      peakRssBytes: 1,
      userCpuMicros: 1,
      systemCpuMicros: 1,
      readBytes: 0,
      writeBytes: 0,
      maximumObservedProcessCount: 1,
    },
    population: {
      cases: 1,
      assertions: 1,
      passed: 1,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      warnings: 0,
    },
    stdoutArtifact: clone(a),
    stderrArtifact: clone(a),
    parsedOutputArtifact: clone(a),
  });
  const verifier = builders.verifierOutput({
    layerId: "focused_verifier",
    checkId: "aux-focused",
    ok: true,
    cases: 1,
    assertions: 1,
    passed: 1,
    failures: [],
    skips: [],
    warnings: [],
    timeoutCount: 0,
    signalCount: 0,
    retryCount: 0,
    executionObservationSha256: observation.semanticSha256,
    rawResultArtifact: clone(a),
  });
  const inputManifest = builders.coverageInputManifest({
    reducerSha256: digest("aux-reducer"),
    orderedInputs: [
      {
        ordinal: 1,
        semanticPayloadSha256: digest("aux-input"),
        occurrence: 1,
        artifact: clone(a),
      },
    ],
  });
  const coverage = builders.coverageProof({
    inputManifest,
    repeat: 1,
    files: [
      {
        path: "lib/a.js",
        sourceSha256: digest("aux-source"),
        lines: { covered: 1, total: 1 },
        branches: { covered: 1, total: 1 },
        functions: { covered: 1, total: 1 },
        uncoveredRangesArtifact: clone(a),
      },
    ],
    requiredFiles: ["lib/a.js"],
    uncoveredRequiredFiles: [],
  });
  const operational = builders.operationalManifest({
    capturedAt: NOW,
    gitHead: COMMIT_A,
    gitTree: COMMIT_B,
    indexSha256: digest("aux-index"),
    entries: [
      {
        path: "lib/a.js",
        type: "file",
        mode: "100644",
        byteLength: 1,
        contentSha256: digest("aux-file"),
        indexState: "tracked",
        worktreeState: "clean",
      },
    ],
    automationInputsArtifact: clone(a),
    dependencyManifestArtifact: clone(a),
    toolchainManifestArtifact: clone(a),
  });
  const crash = builders.crashPopulation({
    boundaryManifestSha256: digest("aux-boundaries"),
    cases: [
      {
        pointId: "point-a",
        position: "before",
        repeat: 1,
        preStateArtifact: clone(a),
        postCrashStateArtifact: clone(a),
        recoveryArtifact: clone(a),
        outcome: "no_state",
        failures: [],
      },
    ],
    unrecoveredCount: 0,
  });
  const concurrency = builders.concurrencyPopulation({
    cases: [
      {
        caseId: "case-a",
        kind: "identical",
        seed: "seed",
        scheduleArtifact: clone(a),
        operationsArtifact: clone(a),
        acceptedOrderingArtifact: clone(a),
        outcome: "converged",
        failures: [],
      },
    ],
    nonconvergentIdenticalCount: 0,
    acceptedDivergentCount: 0,
    staleOwnerWinCount: 0,
  });
  const parser = builders.parserPopulation({
    cases: [
      {
        caseId: "parser-a",
        class: "duplicate_key",
        inputArtifact: clone(a),
        expectedCode: "TYPED_REFUSAL",
        observedCode: "TYPED_REFUSAL",
        partialAcceptance: false,
      },
    ],
    untypedRefusalCount: 0,
    partialAcceptanceCount: 0,
  });
  return {
    a,
    observation,
    verifier,
    inputManifest,
    coverage,
    operational,
    crash,
    concurrency,
    parser,
  };
}

test("valid full authority graph is immutable, dormant, and internally bound", () => {
  const f = makeFixture();
  assert.deepEqual(
    {
      policySha256: f.policy.policySha256,
      floorHash: f.floor.floorHash,
      planSha256: f.plan.planSha256,
      frozenReviewReceiptHash: f.frozenReview.receiptHash,
      qualityReceiptHash: f.quality.receiptHash,
      candidateReceiptHash: f.candidate.receiptHash,
      attestationBodySha256: f.attestation.bodySha256,
    },
    {
      policySha256:
        "23d1551d6e010b08d0d586f0ee3b87a131f59e522d5736ae5fd1d906102a658f",
      floorHash:
        "30ca4c035658d35afbcb5e101492370e2a9fc90ddf2c7f5b158025bc655fe752",
      planSha256:
        "e0cf9469859e00ebc31ee491324e73a55bb0e50caa31c439e6bbe9125d99de70",
      frozenReviewReceiptHash:
        "814cc2630f20026acd3bbac39cdcacd03c09b7b6ad7aae3d26a92e3a92a30e5a",
      qualityReceiptHash:
        "1d816cffd87217d55956eb22168d7108ba618558461724cc1da515d37f725646",
      candidateReceiptHash:
        "445696d22c715302d898a8dd23aab9fcd9cdf0e39efc8e4f9621d717da5ff40c",
      attestationBodySha256:
        "61628323dfb762655ad440333b40bfe21b746693a99300dbde976aa92726b164",
    },
  );
  assert.equal(validateQualityPolicyV4(f.policy).policySha256, f.policy.policySha256);
  assert.equal(
    validatePopulationFloorV3(f.floor).floorHash,
    f.floor.floorHash,
  );
  assert.equal(
    validatePhaseQualityPlanV4(f.plan, f.policy).planSha256,
    f.plan.planSha256,
  );
  assert.equal(
    validateFrozenReviewReceiptV1(f.frozenReview).receiptHash,
    f.frozenReview.receiptHash,
  );
  assert.equal(
    validateQualityReceiptV7(f.quality, f.qualityContext).receiptHash,
    f.quality.receiptHash,
  );
  assert.equal(
    validateCandidateReceiptV3(f.candidate, {
      ...f.qualityContext,
      qualityReceipt: f.quality,
    }).receiptHash,
    f.candidate.receiptHash,
  );
  assert.equal(
    validateAttestationBodyV3(f.attestation, f.attestationContext).bodySha256,
    f.attestation.bodySha256,
  );
  assert.equal(f.attestation.productionAuthority, false);
  assert.equal(Object.isFrozen(f.quality), true);
  assert.deepEqual(
    Object.keys(contract).filter((key) =>
      /activate|persist|publish|promote|mutate|write/i.test(key),
    ),
    [],
  );
});

test("authority graph semantic receipts are identical across three independent builds", () => {
  const runs = Array.from({ length: 3 }, () => {
    const f = makeFixture();
    return {
      policySha256: f.policy.policySha256,
      populationFloorSha256: f.floor.floorHash,
      qualityPlanSha256: f.plan.planSha256,
      frozenReviewReceiptHash: f.frozenReview.receiptHash,
      qualityReceiptHash: f.quality.receiptHash,
      candidateReceiptHash: f.candidate.receiptHash,
      attestationBodySha256: f.attestation.bodySha256,
    };
  });
  assert.equal(new Set(runs.map((entry) => stableJson(entry))).size, 1);
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
});

test("all exported builders generate objects accepted by their paired validators", () => {
  const a = artifact("builder-pair");
  const observation = builders.executionObservation({
    executionId: "execution-1",
    layerId: "unit",
    checkId: "unit-contract",
    definitionSha256: digest("unit-definition"),
    repeat: 1,
    seed: "seed",
    timeZone: "UTC",
    orderId: "forward",
    fixtureManifestSha256: digest("fixtures"),
    runtime: {
      platform: "darwin",
      arch: "arm64",
      executableSha256: digest("executable"),
      nodeVersion: "v25.0.0",
      nodeSha256: digest("node"),
      npmVersion: "11.0.0",
      npmCliSha256: digest("npm"),
      toolchainSha256: digest("toolchain"),
      sandboxIdentitySha256: digest("sandbox"),
    },
    process: {
      startedAt: NOW,
      finishedAt: LATER,
      elapsedMs: 1000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      retryCount: 0,
    },
    resources: {
      peakRssBytes: 1,
      userCpuMicros: 1,
      systemCpuMicros: 1,
      readBytes: 0,
      writeBytes: 0,
      maximumObservedProcessCount: 1,
    },
    population: {
      cases: 1,
      assertions: 1,
      passed: 1,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      warnings: 0,
    },
    stdoutArtifact: clone(a),
    stderrArtifact: clone(a),
    parsedOutputArtifact: clone(a),
  });
  assert.equal(
    validateExecutionObservationV3(observation).semanticSha256,
    observation.semanticSha256,
  );

  const verifier = builders.verifierOutput({
    layerId: "focused_verifier",
    checkId: "focused",
    ok: true,
    cases: 1,
    assertions: 2,
    passed: 1,
    failures: [],
    skips: [],
    warnings: [],
    timeoutCount: 0,
    signalCount: 0,
    retryCount: 0,
    executionObservationSha256: observation.semanticSha256,
    rawResultArtifact: clone(a),
  });
  assert.equal(validateVerifierOutput(verifier).resultHash, verifier.resultHash);

  const semanticA = digest("semantic-a");
  const semanticB = digest("semantic-b");
  const [semanticLow, semanticHigh] =
    semanticA < semanticB
      ? [semanticA, semanticB]
      : [semanticB, semanticA];
  const inputManifest = builders.coverageInputManifest({
    reducerSha256: digest("coverage-reducer"),
    orderedInputs: [
      {
        ordinal: 1,
        semanticPayloadSha256: semanticLow,
        occurrence: 1,
        artifact: artifact("coverage-input-z-path"),
      },
      {
        ordinal: 2,
        semanticPayloadSha256: semanticLow,
        occurrence: 2,
        artifact: artifact("coverage-input-a-path"),
      },
      {
        ordinal: 3,
        semanticPayloadSha256: semanticHigh,
        occurrence: 1,
        artifact: artifact("coverage-input-b"),
      },
    ],
  });
  validateCoverageInputManifest(inputManifest);
  const coverage = builders.coverageProof({
    inputManifest,
    repeat: 3,
    files: [
      {
        path: "lib/pikiio-quality-contract-v3.js",
        sourceSha256: digest("source"),
        lines: { covered: 99, total: 100 },
        branches: { covered: 95, total: 100 },
        functions: { covered: 100, total: 100 },
        uncoveredRangesArtifact: clone(a),
      },
    ],
    requiredFiles: ["lib/pikiio-quality-contract-v3.js"],
    uncoveredRequiredFiles: [],
  });
  validateCoverageProofV2(coverage);

  const operational = builders.operationalManifest({
    capturedAt: NOW,
    gitHead: COMMIT_A,
    gitTree: COMMIT_B,
    indexSha256: digest("index"),
    entries: [
      {
        path: "lib/a.js",
        type: "file",
        mode: "100644",
        byteLength: 1,
        contentSha256: digest("a"),
        indexState: "tracked",
        worktreeState: "clean",
      },
    ],
    automationInputsArtifact: clone(a),
    dependencyManifestArtifact: clone(a),
    toolchainManifestArtifact: clone(a),
  });
  validateOperationalManifestV2(operational);

  const crash = builders.crashPopulation({
    boundaryManifestSha256: digest("boundaries"),
    cases: [
      {
        pointId: "before-commit",
        position: "before",
        repeat: 1,
        preStateArtifact: clone(a),
        postCrashStateArtifact: clone(a),
        recoveryArtifact: clone(a),
        outcome: "no_state",
        failures: [],
      },
      {
        pointId: "after-commit",
        position: "after",
        repeat: 2,
        preStateArtifact: clone(a),
        postCrashStateArtifact: clone(a),
        recoveryArtifact: clone(a),
        outcome: "resumed_idempotently",
        failures: [],
      },
    ],
    unrecoveredCount: 0,
  });
  validateCrashPopulation(crash);

  const concurrency = builders.concurrencyPopulation({
    cases: [
      {
        caseId: "divergent",
        kind: "divergent",
        seed: "a",
        scheduleArtifact: clone(a),
        operationsArtifact: clone(a),
        acceptedOrderingArtifact: clone(a),
        outcome: "refused",
        failures: [],
      },
      {
        caseId: "identical",
        kind: "identical",
        seed: "b",
        scheduleArtifact: clone(a),
        operationsArtifact: clone(a),
        acceptedOrderingArtifact: clone(a),
        outcome: "converged",
        failures: [],
      },
      {
        caseId: "stale-owner",
        kind: "stale_owner",
        seed: "c",
        scheduleArtifact: clone(a),
        operationsArtifact: clone(a),
        acceptedOrderingArtifact: clone(a),
        outcome: "stale_owner_refused",
        failures: [],
      },
    ],
    nonconvergentIdenticalCount: 0,
    acceptedDivergentCount: 0,
    staleOwnerWinCount: 0,
  });
  validateConcurrencyPopulation(concurrency);

  const parser = builders.parserPopulation({
    cases: [
      "boundary_value",
      "duplicate_key",
      "oversized",
      "reordered",
      "truncated",
      "unknown_field",
      "wrong_encoding",
      "wrong_version",
    ].map((kind, index) => ({
      caseId: `parser-${index}`,
      class: kind,
      inputArtifact: clone(a),
      expectedCode: "TYPED_REFUSAL",
      observedCode: "TYPED_REFUSAL",
      partialAcceptance: false,
    })),
    untypedRefusalCount: 0,
    partialAcceptanceCount: 0,
  });
  validateParserPopulation(parser);
});

test("root exact-shape gauntlet rejects missing, unknown, prototype, symbol, and accessor input", () => {
  const f = makeFixture();
  rootShapeGauntlet(f.policy, (value) => validateQualityPolicyV4(value));
  rootShapeGauntlet(f.floor, (value) => validatePopulationFloorV3(value));
  rootShapeGauntlet(f.plan, (value) =>
    validatePhaseQualityPlanV4(value, f.policy),
  );
  rootShapeGauntlet(f.frozenReview, (value) =>
    validateFrozenReviewReceiptV1(value),
  );
  rootShapeGauntlet(f.quality, (value) =>
    validateQualityReceiptV7(value, f.qualityContext),
  );
  rootShapeGauntlet(f.candidate, (value) =>
    validateCandidateReceiptV3(value, {
      ...f.qualityContext,
      qualityReceipt: f.quality,
    }),
  );
  rootShapeGauntlet(f.attestation, (value) =>
    validateAttestationBodyV3(value, f.attestationContext),
  );
});

test("the exact 21-layer order is mandatory and clean-checkout is layer 16", () => {
  const f = makeFixture();
  assert.equal(EVIDENCE_LAYER_IDS.length, 21);
  assert.equal(EVIDENCE_LAYER_IDS[15], "clean_checkout_reproduction");
  assert.deepEqual(CONDITIONAL_LAYER_IDS, [
    "production_shaped_rehearsal",
    "natural_cycle_qa",
    "api_browser_parity",
  ]);

  const omitted = clone(f.policy);
  omitted.supportedEvidenceOrder.splice(4, 1);
  assertCode(() => validateQualityPolicyV4(omitted), "EVIDENCE_ORDER_INVALID");

  const duplicate = clone(f.policy);
  duplicate.supportedEvidenceOrder[5] = duplicate.supportedEvidenceOrder[4];
  assertCode(() => validateQualityPolicyV4(duplicate), "EVIDENCE_ORDER_INVALID");

  const reordered = clone(f.policy);
  [reordered.supportedEvidenceOrder[0], reordered.supportedEvidenceOrder[1]] = [
    reordered.supportedEvidenceOrder[1],
    reordered.supportedEvidenceOrder[0],
  ];
  assertCode(() => validateQualityPolicyV4(reordered), "EVIDENCE_ORDER_INVALID");

  const layerMapReordered = clone(f.plan);
  const reversed = Object.fromEntries(Object.entries(layerMapReordered.layers).reverse());
  layerMapReordered.layers = reversed;
  assertCode(
    () => validatePhaseQualityPlanV4(layerMapReordered, f.policy),
    "UNEXPECTED_FIELDS",
  );
});

test("required quality layers cannot reuse checks, definitions, or artifact populations", () => {
  const f = makeFixture();
  const fiveCoreLayers = [
    "unit",
    "contract",
    "integration",
    "property",
    "negative_safety",
  ];

  const checkReuse = clone(f.plan);
  delete checkReuse.planSha256;
  for (const layerId of fiveCoreLayers) {
    checkReuse.layers[layerId].checkIds = ["check-shared-five-layer"];
  }
  assertCode(
    () => builders.qualityPlan(checkReuse, f.policy),
    "LAYER_CHECK_ID_COLLISION",
  );

  const definitionReuse = clone(f.plan);
  delete definitionReuse.planSha256;
  const sharedDefinition = digest("shared-five-layer-definition");
  for (const layerId of fiveCoreLayers) {
    definitionReuse.layers[layerId].definitionManifestSha256 =
      sharedDefinition;
  }
  assertCode(
    () => builders.qualityPlan(definitionReuse, f.policy),
    "LAYER_DEFINITION_MANIFEST_COLLISION",
  );

  for (const role of [
    "executions",
    "rawPopulationArtifact",
    "outputArtifacts",
  ]) {
    const qualityFields = unsealQualityReceipt(f.quality);
    const unit = f.quality.layerResults.unit;
    const contractFields = unsealLayerPass(
      f.quality.layerResults.contract,
    );
    contractFields[role] = clone(unit[role]);
    qualityFields.layerResults.contract =
      builders.layerPass(contractFields);
    assertCode(
      () => builders.qualityReceipt(qualityFields, f.qualityContext),
      "LAYER_ARTIFACT_ADDRESS_COLLISION",
    );
  }

  const fiveLayerPopulationReuse = unsealQualityReceipt(f.quality);
  const sharedPopulation = clone(
    f.quality.layerResults.unit.rawPopulationArtifact,
  );
  for (const layerId of fiveCoreLayers) {
    const layerFields = unsealLayerPass(
      fiveLayerPopulationReuse.layerResults[layerId],
    );
    layerFields.rawPopulationArtifact = clone(sharedPopulation);
    fiveLayerPopulationReuse.layerResults[layerId] =
      builders.layerPass(layerFields);
  }
  assertCode(
    () =>
      builders.qualityReceipt(
        fiveLayerPopulationReuse,
        f.qualityContext,
      ),
    "LAYER_ARTIFACT_ADDRESS_COLLISION",
  );

  for (const mutate of [
    (value) => {
      value.rawPopulationArtifact = clone(value.executions[0]);
    },
    (value) => {
      value.outputArtifacts = [clone(value.executions[0])];
    },
    (value) => {
      value.executions = [
        clone(value.executions[0]),
        clone(value.executions[0]),
      ];
    },
  ]) {
    const layerFields = unsealLayerPass(f.quality.layerResults.unit);
    mutate(layerFields);
    assertCode(
      () => builders.layerPass(layerFields),
      "LAYER_ARTIFACT_ADDRESS_COLLISION",
    );
  }
});

test("typed N/A is limited to three conditional surfaces and binds exact policy reasons", () => {
  const f = makeFixture();
  for (const layerId of EVIDENCE_LAYER_IDS.filter(
    (entry) => !CONDITIONAL_LAYER_IDS.includes(entry),
  )) {
    const invalid = clone(f.plan);
    invalid.layers[layerId] = {
      layerId,
      disposition: {
        kind: "not_applicable",
        reasonCode: "phase_has_no_production_surface",
        policyRuleId: "illegal",
        policyRuleSha256: digest("illegal"),
      },
      checkIds: [],
      definitionManifestSha256: null,
      producerOutputSchema: null,
      layerResultSchema: SCHEMAS.notApplicable,
    };
    assertCode(
      () => validatePhaseQualityPlanV4(invalid, f.policy),
      "NOT_APPLICABLE_LOCAL_LAYER_REFUSED",
    );
  }

  const untyped = clone(f.plan);
  untyped.layers.natural_cycle_qa.disposition = "not_applicable";
  assertCode(
    () => validatePhaseQualityPlanV4(untyped, f.policy),
    "UNTYPED_NOT_APPLICABLE_REFUSED",
  );

  const wrongReason = clone(f.plan);
  wrongReason.layers.natural_cycle_qa.disposition.reasonCode =
    "phase_has_no_browser_surface";
  assertCode(
    () => validatePhaseQualityPlanV4(wrongReason, f.policy),
    "NOT_APPLICABLE_REASON_REFUSED",
  );

  const stale = clone(f.layerResults.natural_cycle_qa);
  stale.qualityPlanSha256 = digest("stale-plan");
  stale.receiptHash = contract.hashWithoutField(stale, "receiptHash");
  const quality = clone(f.quality);
  quality.layerResults.natural_cycle_qa = stale;
  quality.receiptHash = contract.hashWithoutField(quality, "receiptHash");
  assertCode(
    () => validateQualityReceiptV7(quality, f.qualityContext),
    "NOT_APPLICABLE_BINDING_MISMATCH",
  );
});

test("required layers cannot use zero populations and N/A layers cannot claim populations", () => {
  const f = makeFixture();
  const zeroRequiredFloorFields = clone(f.floor);
  delete zeroRequiredFloorFields.floorHash;
  zeroRequiredFloorFields.layerMinimums.unit.minimumCases = 0;
  const zeroRequiredFloor = builders.populationFloor(zeroRequiredFloorFields);
  const zeroContext = {
    ...f.qualityContext,
    populationFloor: zeroRequiredFloor,
  };
  const receipt = clone(f.quality);
  receipt.phaseBinding.populationFloorSha256 = zeroRequiredFloor.floorHash;
  receipt.thresholds.populationFloorSha256 = zeroRequiredFloor.floorHash;
  receipt.receiptHash = contract.hashWithoutField(receipt, "receiptHash");
  assertCode(
    () => validateQualityReceiptV7(receipt, zeroContext),
    "QUALITY_BINDING_MISMATCH",
  );

  const nonzeroNaFloorFields = clone(f.floor);
  delete nonzeroNaFloorFields.floorHash;
  nonzeroNaFloorFields.layerMinimums.natural_cycle_qa.minimumCases = 1;
  const nonzeroNaFloor = builders.populationFloor(nonzeroNaFloorFields);
  const reboundPlanFields = clone(f.plan);
  delete reboundPlanFields.planSha256;
  reboundPlanFields.populationFloorSha256 = nonzeroNaFloor.floorHash;
  const reboundPlan = builders.qualityPlan(reboundPlanFields, f.policy);
  const reboundContext = {
    policy: f.policy,
    qualityPlan: reboundPlan,
    populationFloor: nonzeroNaFloor,
  };
  const rebound = clone(f.quality);
  rebound.phaseBinding.qualityPlanSha256 = reboundPlan.planSha256;
  rebound.phaseBinding.populationFloorSha256 = nonzeroNaFloor.floorHash;
  rebound.thresholds.populationFloorSha256 = nonzeroNaFloor.floorHash;
  for (const layerId of ["natural_cycle_qa", "api_browser_parity"]) {
    const result = clone(rebound.layerResults[layerId]);
    result.qualityPlanSha256 = reboundPlan.planSha256;
    result.receiptHash = contract.hashWithoutField(result, "receiptHash");
    rebound.layerResults[layerId] = result;
  }
  rebound.receiptHash = contract.hashWithoutField(rebound, "receiptHash");
  assertCode(
    () => validateQualityReceiptV7(rebound, reboundContext),
    "NOT_APPLICABLE_POPULATION_NONZERO",
  );

  const underFloorFields = clone(f.floor);
  delete underFloorFields.floorHash;
  underFloorFields.layerMinimums.unit.minimumCases = 2;
  const underFloor = builders.populationFloor(underFloorFields);
  const underPlanFields = clone(f.plan);
  delete underPlanFields.planSha256;
  underPlanFields.populationFloorSha256 = underFloor.floorHash;
  const underPlan = builders.qualityPlan(underPlanFields, f.policy);
  const underContext = {
    policy: f.policy,
    qualityPlan: underPlan,
    populationFloor: underFloor,
  };
  const underReceipt = clone(f.quality);
  underReceipt.phaseBinding.qualityPlanSha256 = underPlan.planSha256;
  underReceipt.phaseBinding.populationFloorSha256 = underFloor.floorHash;
  underReceipt.thresholds.populationFloorSha256 = underFloor.floorHash;
  for (const layerId of ["natural_cycle_qa", "api_browser_parity"]) {
    const result = clone(underReceipt.layerResults[layerId]);
    result.qualityPlanSha256 = underPlan.planSha256;
    result.receiptHash = contract.hashWithoutField(result, "receiptHash");
    underReceipt.layerResults[layerId] = result;
  }
  underReceipt.receiptHash = contract.hashWithoutField(
    underReceipt,
    "receiptHash",
  );
  assertCode(
    () => validateQualityReceiptV7(underReceipt, underContext),
    "LAYER_POPULATION_FLOOR_UNMET",
  );
});

test("authority roles are pairwise distinct and local task receipts never authorize", () => {
  const f = makeFixture();
  const local = identity(
    "coordinator",
    "local-task",
    false,
    "controller_task_receipt",
  );
  assert.equal(validateAuthorityIdentity(local).authorizing, false);
  const illegalLocal = clone(local);
  illegalLocal.authorizing = true;
  illegalLocal.principalSha256 = sha256(
    stableJson({
      issuer: illegalLocal.issuer,
      subject: illegalLocal.subject,
      credentialKind: illegalLocal.credentialKind,
      credentialSha256: illegalLocal.credentialSha256,
      authorizing: illegalLocal.authorizing,
    }),
  );
  assertCode(
    () => validateAuthorityIdentity(illegalLocal),
    "LOCAL_IDENTITY_CANNOT_AUTHORIZE",
  );

  const collision = clone(f.quality);
  collision.identities.certifier = clone(collision.identities.implementer);
  collision.receiptHash = contract.hashWithoutField(collision, "receiptHash");
  assertCode(
    () => validateQualityReceiptV7(collision, f.qualityContext),
    "IDENTITY_ROLE_MISMATCH",
  );

  const samePrincipal = clone(f.attestation);
  samePrincipal.rolePrincipalHashes.certifier =
    samePrincipal.rolePrincipalHashes.implementer;
  samePrincipal.bodySha256 = contract.hashWithoutField(
    samePrincipal,
    "bodySha256",
  );
  assertCode(
    () => validateAttestationBodyV3(samePrincipal, f.attestationContext),
    "IDENTITY_COLLISION",
  );
});

test("all four authority-bearing APIs refuse fabricated authorizing inputs while dormant", () => {
  const f = makeFixture();

  const quality = clone(f.quality);
  quality.authorizing = true;
  quality.identities = Object.fromEntries(
    ROLE_NAMES.map((key) => [
      key,
      identity(IDENTITY_ROLE_VALUES[key], `fabricated-${key}`, true),
    ]),
  );
  quality.receiptHash = contract.hashWithoutField(quality, "receiptHash");
  assert.equal(
    new Set(
      Object.values(quality.identities).map((entry) => entry.principalSha256),
    ).size,
    6,
  );
  assertCode(
    () => validateQualityReceiptV7(quality, f.qualityContext),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );
  quality.coverage = {};
  assertCode(
    () => validateQualityReceiptV7(quality, {}),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );

  const review = clone(f.frozenReview);
  review.authorizing = true;
  review.implementer = identity("implementer", "fabricated-review-a", true);
  review.certifier = identity("certifier", "fabricated-review-b", true);
  review.coordinator = identity("coordinator", "fabricated-review-c", true);
  review.receiptHash = contract.hashWithoutField(review, "receiptHash");
  assertCode(
    () => validateFrozenReviewReceiptV1(review),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );
  review.implementer = {};
  assertCode(
    () => validateFrozenReviewReceiptV1(review),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );

  const candidate = clone(f.candidate);
  candidate.authorizing = true;
  candidate.controller = identity("controller", "fabricated-controller", true);
  candidate.collector = identity("collector", "fabricated-collector", true);
  candidate.receiptHash = contract.hashWithoutField(candidate, "receiptHash");
  assertCode(
    () =>
      validateCandidateReceiptV3(candidate, {
        ...f.qualityContext,
        qualityReceipt: f.quality,
      }),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );
  candidate.rawArtifact = {};
  assertCode(
    () => validateCandidateReceiptV3(candidate, {}),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );

  const attestation = clone(f.attestation);
  attestation.authorizing = true;
  attestation.bodySha256 = contract.hashWithoutField(
    attestation,
    "bodySha256",
  );
  assertCode(
    () => validateAttestationBodyV3(attestation),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );
  attestation.artifacts = {};
  assertCode(
    () => validateAttestationBodyV3(attestation),
    "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
  );
});

test("authority preflight dominates hostile nested graphs in all validators and builders", () => {
  const f = makeFixture();
  const candidateContext = {
    ...f.qualityContext,
    qualityReceipt: f.quality,
  };
  const cases = [
    {
      label: "review",
      base: f.frozenReview,
      nestedKey: "reviewedManifest",
      validateWithoutContext: (value) => validateFrozenReviewReceiptV1(value),
      validateWithContext: (value) => validateFrozenReviewReceiptV1(value),
      buildWithoutContext: (value) => builders.frozenReview(value),
      buildWithContext: (value) => builders.frozenReview(value),
    },
    {
      label: "quality",
      base: f.quality,
      nestedKey: "coverage",
      validateWithoutContext: (value) => validateQualityReceiptV7(value),
      validateWithContext: (value) =>
        validateQualityReceiptV7(value, f.qualityContext),
      buildWithoutContext: (value) => builders.qualityReceipt(value),
      buildWithContext: (value) =>
        builders.qualityReceipt(value, f.qualityContext),
    },
    {
      label: "candidate",
      base: f.candidate,
      nestedKey: "authoritySnapshot",
      validateWithoutContext: (value) => validateCandidateReceiptV3(value),
      validateWithContext: (value) =>
        validateCandidateReceiptV3(value, candidateContext),
      buildWithoutContext: (value) => builders.candidateReceipt(value),
      buildWithContext: (value) =>
        builders.candidateReceipt(value, candidateContext),
    },
    {
      label: "attestation",
      base: f.attestation,
      nestedKey: "artifacts",
      validateWithoutContext: (value) => validateAttestationBodyV3(value),
      validateWithContext: (value) =>
        validateAttestationBodyV3(value, f.attestationContext),
      buildWithoutContext: (value) => builders.attestationBody(value),
      buildWithContext: (value) =>
        builders.attestationBody(value, f.attestationContext),
    },
  ];

  for (const entry of cases) {
    for (const kind of [
      "accessor",
      "cycle",
      "depth_20000",
      "missing_context",
      "malformed_ref",
    ]) {
      for (const invoke of [
        entry.validateWithoutContext,
        entry.buildWithoutContext,
      ]) {
        const value = hostileAuthorityValue(
          entry.base,
          entry.nestedKey,
          kind,
          true,
        );
        assertCode(
          () => invoke(value),
          "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
        );
      }
    }

    for (const [kind, expectedCode] of [
      ["accessor", "ACCESSOR_FIELD_REFUSED"],
      ["cycle", "CYCLIC_VALUE"],
      ["depth_20000", "GRAPH_DEPTH_LIMIT_EXCEEDED"],
      ["malformed_ref", "UNEXPECTED_FIELDS"],
    ]) {
      for (const invoke of [entry.validateWithContext, entry.buildWithContext]) {
        const value = hostileAuthorityValue(
          entry.base,
          entry.nestedKey,
          kind,
          false,
        );
        assertCode(() => invoke(value), expectedCode);
      }
    }

    const rootAccessor = clone(entry.base);
    rootAccessor.authorizing = true;
    Object.defineProperty(rootAccessor, entry.nestedKey, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error(`${entry.label} root getter must never execute`);
      },
    });
    assertCode(
      () => entry.validateWithoutContext(rootAccessor),
      "ACCESSOR_FIELD_REFUSED",
    );
    assertCode(
      () => entry.buildWithoutContext(rootAccessor),
      "ACCESSOR_FIELD_REFUSED",
    );

    const wrongPrototype = clone(entry.base);
    wrongPrototype.authorizing = true;
    Object.setPrototypeOf(wrongPrototype, { polluted: true });
    assertCode(
      () => entry.validateWithoutContext(wrongPrototype),
      "INVALID_PROTOTYPE",
    );
    assertCode(
      () => entry.buildWithoutContext(wrongPrototype),
      "INVALID_PROTOTYPE",
    );
  }

  for (const entry of cases.filter((value) => value.label === "quality")) {
    const value = hostileAuthorityValue(
      entry.base,
      entry.nestedKey,
      "missing_context",
      false,
    );
    assertCode(
      () => entry.validateWithoutContext(value),
      "QUALITY_CONTEXT_REQUIRED",
    );
    assertCode(
      () => entry.buildWithoutContext(value),
      "QUALITY_CONTEXT_REQUIRED",
    );
  }
});

test("canonical ordering uses exact code units and has no locale-sensitive reducer", () => {
  const canonical = stableJson({ "\u00e4": 1, z: 2, A: 3 });
  assert.equal(canonical, '{"A":3,"z":2,"\u00e4":1}');
  const reverseInsertion = {};
  reverseInsertion.A = 3;
  reverseInsertion.z = 2;
  reverseInsertion["\u00e4"] = 1;
  assert.equal(stableJson(reverseInsertion), canonical);
});

test("canonical graph depth and node budgets fail with typed errors", () => {
  const deep = {};
  let cursor = deep;
  for (let depth = 0; depth < 20000; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assertCode(
    () => stableJson(deep),
    "GRAPH_DEPTH_LIMIT_EXCEEDED",
  );
  assertCode(
    () => semanticHashWithoutField({ payload: deep }, "receiptHash"),
    "GRAPH_DEPTH_LIMIT_EXCEEDED",
  );

  const tooManyNodes = Array.from(
    { length: 6000 },
    () => Array(9).fill(null),
  );
  assertCode(
    () => stableJson(tooManyNodes),
    "GRAPH_NODE_LIMIT_EXCEEDED",
  );
});

test("diagnostic timestamps do not alter semantic hashes but evidence changes do", () => {
  const a = artifact("semantic-artifact");
  const first = builders.operationalManifest({
    capturedAt: NOW,
    gitHead: COMMIT_A,
    gitTree: COMMIT_B,
    indexSha256: digest("index"),
    entries: [],
    automationInputsArtifact: clone(a),
    dependencyManifestArtifact: clone(a),
    toolchainManifestArtifact: clone(a),
  });
  const fields = clone(first);
  delete fields.manifestHash;
  fields.capturedAt = LATER;
  const second = builders.operationalManifest(fields);
  assert.equal(first.manifestHash, second.manifestHash);

  fields.indexSha256 = digest("changed-index");
  const changed = builders.operationalManifest(fields);
  assert.notEqual(first.manifestHash, changed.manifestHash);
  assert.equal(
    semanticHashWithoutField(
      { capturedAt: NOW, evidence: "same", semanticSha256: digest("x") },
      "semanticSha256",
    ),
    semanticHashWithoutField(
      { capturedAt: LATER, evidence: "same", semanticSha256: digest("y") },
      "semanticSha256",
    ),
  );
});

test("calendar-exact UTC timestamp admission covers all six receipt surfaces", () => {
  const f = makeFixture();
  const auxiliary = makeAuxiliaryFixtures();
  const candidateContext = {
    ...f.qualityContext,
    qualityReceipt: f.quality,
  };
  const surfaces = [
    {
      label: "not-applicable",
      base: f.quality.layerResults.natural_cycle_qa,
      paths: [["observedAt"]],
      validate: validateNotApplicableResult,
      build: builders.notApplicable,
    },
    {
      label: "execution-observation",
      base: auxiliary.observation,
      paths: [["process", "startedAt"], ["process", "finishedAt"]],
      validate: validateExecutionObservationV3,
      build: builders.executionObservation,
    },
    {
      label: "operational-manifest",
      base: auxiliary.operational,
      paths: [["capturedAt"]],
      validate: validateOperationalManifestV2,
      build: builders.operationalManifest,
    },
    {
      label: "frozen-review",
      base: f.frozenReview,
      paths: [["recordedAt"]],
      validate: validateFrozenReviewReceiptV1,
      build: builders.frozenReview,
    },
    {
      label: "quality-receipt",
      base: f.quality,
      paths: [["recordedAt"]],
      validate: (value) => validateQualityReceiptV7(value, f.qualityContext),
      build: (value) => builders.qualityReceipt(value, f.qualityContext),
    },
    {
      label: "candidate-receipt",
      base: f.candidate,
      paths: [["observedAt"]],
      validate: (value) => validateCandidateReceiptV3(value, candidateContext),
      build: (value) => builders.candidateReceipt(value, candidateContext),
    },
  ];
  const invalidTimestamps = [
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-07-00T00:00:00Z",
    "2026-07-25T24:00:00Z",
    "2026-07-25T23:60:00Z",
    "2026-07-25T23:59:60Z",
    "2026-07-25T23:59:59+00:00",
    "2026-07-25T23:59:59.1Z",
    "2026-07-25T23:59:59.12Z",
    "2026-07-25T23:59:59.1234Z",
  ];
  const setPath = (value, pathParts, timestamp) => {
    let cursor = value;
    for (const key of pathParts.slice(0, -1)) cursor = cursor[key];
    cursor[pathParts.at(-1)] = timestamp;
  };

  for (const surface of surfaces) {
    for (const timestamp of [
      "2024-02-29T23:59:59Z",
      "2024-02-29T23:59:59.123Z",
    ]) {
      const valid = clone(surface.base);
      if (surface.label === "execution-observation") {
        valid.process.startedAt =
          timestamp.endsWith(".123Z")
            ? "2024-02-29T23:59:58.123Z"
            : "2024-02-29T23:59:58Z";
        valid.process.finishedAt = timestamp;
      } else {
        setPath(valid, surface.paths[0], timestamp);
      }
      const built = surface.build(valid);
      assert.doesNotThrow(() => surface.validate(built), surface.label);
    }
    for (const timestampPath of surface.paths) {
      for (const timestamp of invalidTimestamps) {
        const invalid = clone(surface.base);
        setPath(invalid, timestampPath, timestamp);
        assertCode(() => surface.validate(invalid), "INVALID_TIMESTAMP");
        assertCode(() => surface.build(invalid), "INVALID_TIMESTAMP");
      }
    }
  }
});

test("coverage reduction is ordered by semantic payload SHA with explicit multiplicity", () => {
  const a = artifact("coverage");
  const high = "f".repeat(64);
  const low = "0".repeat(64);
  const valid = builders.coverageInputManifest({
    reducerSha256: digest("reducer"),
    orderedInputs: [
      {
        ordinal: 1,
        semanticPayloadSha256: low,
        occurrence: 1,
        artifact: clone(a),
      },
      {
        ordinal: 2,
        semanticPayloadSha256: low,
        occurrence: 2,
        artifact: clone(a),
      },
      {
        ordinal: 3,
        semanticPayloadSha256: high,
        occurrence: 1,
        artifact: clone(a),
      },
    ],
  });
  validateCoverageInputManifest(valid);

  const filenameOrdered = clone(valid);
  [filenameOrdered.orderedInputs[0], filenameOrdered.orderedInputs[2]] = [
    filenameOrdered.orderedInputs[2],
    filenameOrdered.orderedInputs[0],
  ];
  filenameOrdered.orderedInputs.forEach((entry, index) => {
    entry.ordinal = index + 1;
    entry.occurrence = 1;
  });
  filenameOrdered.manifestHash = contract.hashWithoutField(
    filenameOrdered,
    "manifestHash",
  );
  assertCode(
    () => validateCoverageInputManifest(filenameOrdered),
    "COVERAGE_ORDER_INVALID",
  );

  const missingOccurrence = clone(valid);
  missingOccurrence.orderedInputs[1].occurrence = 1;
  missingOccurrence.manifestHash = contract.hashWithoutField(
    missingOccurrence,
    "manifestHash",
  );
  assertCode(
    () => validateCoverageInputManifest(missingOccurrence),
    "COVERAGE_MULTIPLICITY_INVALID",
  );

  const staleMultiplicity = clone(valid);
  staleMultiplicity.multiplicitySha256 = digest("stale");
  staleMultiplicity.manifestHash = contract.hashWithoutField(
    staleMultiplicity,
    "manifestHash",
  );
  assertCode(
    () => validateCoverageInputManifest(staleMultiplicity),
    "COVERAGE_MULTIPLICITY_MISMATCH",
  );
});

test("all legacy authority schemas fail closed with exact refusal codes", () => {
  const f = makeFixture();
  const auxiliary = makeAuxiliaryFixtures();
  const cases = new Map([
    ...["pikiio-quality-gauntlet-v3", "pikiio-quality-gauntlet-v2"].map(
      (schema) => [
        schema,
        [f.policy, validateQualityPolicyV4, builders.qualityPolicy],
      ],
    ),
    ...["pikiio-phase-quality-plan-v3", "pikiio-phase-quality-plan-v2"].map(
      (schema) => [
        schema,
        [
          f.plan,
          (value) => validatePhaseQualityPlanV4(value, f.policy),
          (value) => builders.qualityPlan(value, f.policy),
        ],
      ],
    ),
    ...["pikiio-population-floor-v2", "pikiio-population-floor-v1"].map(
      (schema) => [
        schema,
        [f.floor, validatePopulationFloorV3, builders.populationFloor],
      ],
    ),
    [
      "pikiio-quality-execution-observation-v2",
      [
        auxiliary.observation,
        validateExecutionObservationV3,
        builders.executionObservation,
      ],
    ],
    [
      "pikiio-quality-layer-pass-receipt-v1",
      [f.layerResults.unit, validateLayerPassV2, builders.layerPass],
    ],
    ...[
      "pikiio-quality-gauntlet-receipt-v6",
      "pikiio-quality-gauntlet-receipt-v5",
    ].map((schema) => [
      schema,
      [
        f.quality,
        (value) => validateQualityReceiptV7(value, f.qualityContext),
        (value) => builders.qualityReceipt(value, f.qualityContext),
      ],
    ]),
    ...[
      "pikiio-phase-candidate-quality-receipt-v2",
      "pikiio-phase-candidate-quality-receipt-v1",
    ].map((schema) => [
      schema,
      [
        f.candidate,
        (value) =>
          validateCandidateReceiptV3(value, {
            ...f.qualityContext,
            qualityReceipt: f.quality,
          }),
        (value) =>
          builders.candidateReceipt(value, {
            ...f.qualityContext,
            qualityReceipt: f.quality,
          }),
      ],
    ]),
    ...[
      "pikiio-phase-attestation-body-v2",
      "pikiio-phase-attestation-body-v1",
    ].map((schema) => [
      schema,
      [
        f.attestation,
        (value) => validateAttestationBodyV3(value, f.attestationContext),
        (value) => builders.attestationBody(value, f.attestationContext),
      ],
    ]),
  ]);
  for (const [legacySchema, code] of Object.entries(LEGACY_REFUSALS)) {
    const [value, validate, build] = cases.get(legacySchema);
    const legacy = clone(value);
    legacy.schema = legacySchema;
    assertCode(() => validate(legacy), code);
    assertCode(() => validate({ schema: legacySchema }), code);
    assertCode(() => build(legacy), code);
    assertCode(() => build({ schema: legacySchema }), code);
  }
});

test("vNext schema family is atomic and producer schemas are closed per layer", () => {
  assert.deepEqual(
    {
      qualityPolicy: SCHEMAS.qualityPolicy,
      qualityPlan: SCHEMAS.qualityPlan,
      populationFloor: SCHEMAS.populationFloor,
      executionObservation: SCHEMAS.executionObservation,
      layerPass: SCHEMAS.layerPass,
      qualityReceipt: SCHEMAS.qualityReceipt,
      candidateReceipt: SCHEMAS.candidateReceipt,
      attestationBody: SCHEMAS.attestationBody,
    },
    {
      qualityPolicy: "pikiio-quality-gauntlet-v4",
      qualityPlan: "pikiio-phase-quality-plan-v4",
      populationFloor: "pikiio-population-floor-v3",
      executionObservation: "pikiio-quality-execution-observation-v3",
      layerPass: "pikiio-quality-layer-pass-receipt-v2",
      qualityReceipt: "pikiio-quality-gauntlet-receipt-v7",
      candidateReceipt: "pikiio-phase-candidate-quality-receipt-v3",
      attestationBody: "pikiio-phase-attestation-body-v3",
    },
  );
  assert.deepEqual(
    {
      artifactRef: SCHEMAS.artifactRef,
      verifierOutput: SCHEMAS.verifierOutput,
      notApplicable: SCHEMAS.notApplicable,
      coverageProof: SCHEMAS.coverageProof,
      operationalManifest: SCHEMAS.operationalManifest,
      crashPopulation: SCHEMAS.crashPopulation,
      concurrencyPopulation: SCHEMAS.concurrencyPopulation,
      parserPopulation: SCHEMAS.parserPopulation,
      frozenReview: SCHEMAS.frozenReview,
    },
    {
      artifactRef: "pikiio-cas-reference-v1",
      verifierOutput: "pikiio-quality-verifier-output-v2",
      notApplicable: "pikiio-quality-layer-not-applicable-v1",
      coverageProof: "pikiio-per-file-coverage-proof-v2",
      operationalManifest: "pikiio-operational-manifest-v2",
      crashPopulation: "pikiio-crash-restart-population-v1",
      concurrencyPopulation:
        "pikiio-concurrency-linearizability-population-v1",
      parserPopulation: "pikiio-schema-parser-population-v1",
      frozenReview:
        "pikiio-independent-frozen-hash-review-receipt-v1",
    },
  );
  assert.equal(Object.keys(PRODUCER_OUTPUT_SCHEMAS).length, 21);
  assert.equal(
    new Set(Object.values(PRODUCER_OUTPUT_SCHEMAS)).size,
    EVIDENCE_LAYER_IDS.length,
  );
  assert.equal(
    Object.values(PRODUCER_OUTPUT_SCHEMAS).includes(SCHEMAS.layerPass),
    false,
  );

  const f = makeFixture();
  for (const layerId of EVIDENCE_LAYER_IDS) {
    const crosswalk = f.policy.evidenceCrosswalk[layerId];
    assert.equal(
      crosswalk.producerOutputSchema,
      PRODUCER_OUTPUT_SCHEMAS[layerId],
    );
    assert.equal(crosswalk.layerResultSchema, SCHEMAS.layerPass);
    assert.notEqual(
      crosswalk.producerOutputSchema,
      crosswalk.layerResultSchema,
    );
    const planned = f.plan.layers[layerId];
    if (planned.disposition.kind === "required") {
      assert.equal(
        planned.producerOutputSchema,
        crosswalk.producerOutputSchema,
      );
      assert.equal(planned.layerResultSchema, crosswalk.layerResultSchema);
    } else {
      assert.equal(planned.producerOutputSchema, null);
      assert.equal(planned.layerResultSchema, SCHEMAS.notApplicable);
    }
  }

  const wrongProducerPolicy = clone(f.policy);
  wrongProducerPolicy.evidenceCrosswalk.unit.producerOutputSchema =
    PRODUCER_OUTPUT_SCHEMAS.contract;
  assertCode(
    () => validateQualityPolicyV4(wrongProducerPolicy),
    "EVIDENCE_SCHEMA_BOUNDARY_INVALID",
  );
  const producerCanNeverBeResult = clone(f.policy);
  producerCanNeverBeResult.evidenceCrosswalk.unit.producerOutputSchema =
    SCHEMAS.layerPass;
  assertCode(
    () => validateQualityPolicyV4(producerCanNeverBeResult),
    "EVIDENCE_SCHEMA_BOUNDARY_INVALID",
  );
  const wrongProducerPlan = clone(f.plan);
  wrongProducerPlan.layers.unit.producerOutputSchema =
    PRODUCER_OUTPUT_SCHEMAS.contract;
  assertCode(
    () => validatePhaseQualityPlanV4(wrongProducerPlan, f.policy),
    "LAYER_SCHEMA_BOUNDARY_MISMATCH",
  );
  const producerAuthoredPass = clone(f.plan);
  producerAuthoredPass.layers.unit.producerOutputSchema = SCHEMAS.layerPass;
  assertCode(
    () => validatePhaseQualityPlanV4(producerAuthoredPass, f.policy),
    "LAYER_SCHEMA_BOUNDARY_MISMATCH",
  );
  const notApplicableProducer = clone(f.plan);
  notApplicableProducer.layers.natural_cycle_qa.producerOutputSchema =
    PRODUCER_OUTPUT_SCHEMAS.natural_cycle_qa;
  assertCode(
    () => validatePhaseQualityPlanV4(notApplicableProducer, f.policy),
    "NOT_APPLICABLE_EXECUTION_REFUSED",
  );
});

test("cancelled is explicit and zero at observation, layer, floor, and policy", () => {
  const f = makeFixture();
  const x = makeAuxiliaryFixtures();
  assert.equal(x.observation.population.cancelled, 0);
  assert.equal(f.layerResults.unit.cancelled, 0);
  assert.equal(f.floor.zeroFailure.cancelled, 0);
  assert.equal(f.policy.zeroFailureFloors.cancelled, 0);
  assert.deepEqual(
    EXECUTION_ZERO_FAILURE_KEYS,
    [
      "failed",
      "cancelled",
      "skipped",
      "todo",
      "flaky",
      "warnings",
      "timeouts",
      "signals",
      "retries",
    ],
  );

  const missing = clone(x.observation);
  delete missing.population.cancelled;
  assertCode(
    () => validateExecutionObservationV3(missing),
    "UNEXPECTED_FIELDS",
  );
  const cancelledObservation = clone(x.observation);
  cancelledObservation.population.cancelled = 1;
  assertCode(
    () => validateExecutionObservationV3(cancelledObservation),
    "EXECUTION_CANCELLED_REFUSED",
  );
  const cancelledLayer = clone(f.layerResults.unit);
  cancelledLayer.cancelled = 1;
  assertCode(
    () => validateLayerPassV2(cancelledLayer),
    "LAYER_ZERO_FAILURE_VIOLATION",
  );
  const cancelledFloor = clone(f.floor);
  cancelledFloor.zeroFailure.cancelled = 1;
  assertCode(
    () => validatePopulationFloorV3(cancelledFloor),
    "ZERO_FAILURE_FLOOR_WEAKENED",
  );
  const cancelledPolicy = clone(f.policy);
  cancelledPolicy.zeroFailureFloors.cancelled = 1;
  assertCode(
    () => validateQualityPolicyV4(cancelledPolicy),
    "ZERO_FAILURE_FLOOR_WEAKENED",
  );
});

test("unsafe counters, percentages, paths, strings, arrays, cycles, and hashes fail closed", () => {
  const f = makeFixture();
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -0]) {
    const floor = clone(f.floor);
    floor.coverage.minimumRequiredFiles = invalid;
    assertContractError(() => validatePopulationFloorV3(floor));
  }

  for (const invalid of [94, 101, 1.5, NaN]) {
    const policy = clone(f.policy);
    policy.profiles.critical.lineCoveragePercent = invalid;
    assertContractError(() => validateQualityPolicyV4(policy));
  }

  const unsafePath = clone(f.policy);
  unsafePath.trustedGatePaths = ["../escape"];
  assertCode(() => validateQualityPolicyV4(unsafePath), "UNSAFE_PATH");

  const nul = clone(f.policy);
  nul.trustedGatePaths = ["bad\u0000path"];
  assertContractError(() => validateQualityPolicyV4(nul));

  const sparse = clone(f.policy);
  sparse.supportedEvidenceOrder = new Array(21);
  sparse.supportedEvidenceOrder[0] = "unit";
  assertCode(() => validateQualityPolicyV4(sparse), "INVALID_ARRAY");

  const cyclic = clone(f.policy);
  cyclic.profiles.loop = cyclic;
  assertCode(() => validateQualityPolicyV4(cyclic), "CYCLIC_VALUE");

  const staleHash = clone(f.policy);
  staleHash.policySha256 = digest("wrong");
  assertCode(() => validateQualityPolicyV4(staleHash), "HASH_MISMATCH");
});

test("descriptor-safe graph admission rejects every non-canonical host shape before access", () => {
  assertCode(
    () => stableJson({ nested: { value: undefined } }),
    "UNDEFINED_VALUE_REFUSED",
  );
  assertCode(
    () => stableJson({ nested: { value() {} } }),
    "NON_JSON_VALUE",
  );

  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", {
    value: true,
    enumerable: false,
  });
  assertCode(
    () => stableJson({ nested: hidden }),
    "NON_ENUMERABLE_FIELD_REFUSED",
  );

  let getterRuns = 0;
  const accessor = {};
  Object.defineProperty(accessor, "hostile", {
    enumerable: true,
    get() {
      getterRuns += 1;
      throw new Error("getter executed");
    },
  });
  assertCode(
    () => stableJson({ nested: accessor }),
    "ACCESSOR_FIELD_REFUSED",
  );
  assert.equal(getterRuns, 0);

  const symbol = { visible: true };
  symbol[Symbol("hidden")] = true;
  assertCode(
    () => stableJson({ nested: symbol }),
    "SYMBOL_FIELD_REFUSED",
  );

  const sparse = [];
  sparse.length = 1;
  assertCode(() => stableJson(sparse), "INVALID_ARRAY");
  const accessorArray = [true];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      getterRuns += 1;
      return true;
    },
  });
  assertCode(() => stableJson(accessorArray), "ACCESSOR_FIELD_REFUSED");
  assert.equal(getterRuns, 0);
  const extraArray = [true];
  extraArray.extra = true;
  assertCode(() => stableJson(extraArray), "INVALID_ARRAY");
  const wrongArrayPrototype = [true];
  Object.setPrototypeOf(wrongArrayPrototype, {});
  assertCode(
    () => stableJson(wrongArrayPrototype),
    "INVALID_PROTOTYPE",
  );

  const wrongObjectPrototype = { value: true };
  Object.setPrototypeOf(wrongObjectPrototype, null);
  assertCode(
    () => stableJson(wrongObjectPrototype),
    "INVALID_PROTOTYPE",
  );
  const pollutedKey = {};
  Object.defineProperty(pollutedKey, "__proto__", {
    value: {},
    enumerable: true,
  });
  assertCode(
    () => stableJson(pollutedKey),
    "PROTOTYPE_POLLUTION_KEY_REFUSED",
  );

  const cycle = {};
  cycle.self = cycle;
  assertCode(() => stableJson(cycle), "CYCLIC_VALUE");
  const shared = { value: true };
  assertCode(
    () => stableJson({ first: shared, second: shared }),
    "SHARED_REFERENCE_REFUSED",
  );
});

test("every public validator and builder refuses root proxies without executing traps", () => {
  const f = makeFixture();
  const x = makeAuxiliaryFixtures();
  const candidateContext = {
    ...f.qualityContext,
    qualityReceipt: f.quality,
  };

  const validatorSurfaces = [
    ["validateArtifactRef", f.shared, (value) => validateArtifactRef(value)],
    [
      "validateAttestationBodyV3",
      f.attestation,
      (value) => validateAttestationBodyV3(value, f.attestationContext),
    ],
    [
      "validateAuthorityIdentity",
      f.identities.implementer,
      (value) => validateAuthorityIdentity(value),
    ],
    [
      "validateCandidateReceiptV3",
      f.candidate,
      (value) => validateCandidateReceiptV3(value, candidateContext),
    ],
    [
      "validateConcurrencyPopulation",
      x.concurrency,
      (value) => validateConcurrencyPopulation(value),
    ],
    [
      "validateCoverageInputManifest",
      x.inputManifest,
      (value) => validateCoverageInputManifest(value),
    ],
    [
      "validateCoverageProofV2",
      x.coverage,
      (value) => validateCoverageProofV2(value),
    ],
    [
      "validateCrashPopulation",
      x.crash,
      (value) => validateCrashPopulation(value),
    ],
    [
      "validateExecutionObservationV3",
      x.observation,
      (value) => validateExecutionObservationV3(value),
    ],
    [
      "validateFrozenReviewReceiptV1",
      f.frozenReview,
      (value) => validateFrozenReviewReceiptV1(value),
    ],
    [
      "validateLayerPassV2",
      f.layerResults.unit,
      (value) => validateLayerPassV2(value),
    ],
    [
      "validateNotApplicableResult",
      f.layerResults.natural_cycle_qa,
      (value) => validateNotApplicableResult(value),
    ],
    [
      "validateOperationalManifestV2",
      x.operational,
      (value) => validateOperationalManifestV2(value),
    ],
    [
      "validateParserPopulation",
      x.parser,
      (value) => validateParserPopulation(value),
    ],
    [
      "validatePhaseQualityPlanV4",
      f.plan,
      (value) => validatePhaseQualityPlanV4(value, f.policy),
    ],
    [
      "validatePopulationFloorV3",
      f.floor,
      (value) => validatePopulationFloorV3(value),
    ],
    [
      "validateQualityPolicyV4",
      f.policy,
      (value) => validateQualityPolicyV4(value),
    ],
    [
      "validateQualityReceiptV7",
      f.quality,
      (value) => validateQualityReceiptV7(value, f.qualityContext),
    ],
    [
      "validateVerifierOutput",
      x.verifier,
      (value) => validateVerifierOutput(value),
    ],
  ];

  const builderSurfaces = [
    [
      "builders.artifactRef",
      unsealBuilderInput(f.shared),
      (value) => builders.artifactRef(value),
    ],
    [
      "builders.attestationBody",
      unsealBuilderInput(f.attestation, "bodySha256"),
      (value) => builders.attestationBody(value, f.attestationContext),
    ],
    [
      "builders.authorityIdentity",
      unsealBuilderInput(f.identities.implementer, "principalSha256"),
      (value) => builders.authorityIdentity(value),
    ],
    [
      "builders.candidateReceipt",
      unsealBuilderInput(f.candidate, "receiptHash"),
      (value) => builders.candidateReceipt(value, candidateContext),
    ],
    [
      "builders.concurrencyPopulation",
      unsealBuilderInput(x.concurrency, "populationHash"),
      (value) => builders.concurrencyPopulation(value),
    ],
    [
      "builders.coverageInputManifest",
      unsealBuilderInput(x.inputManifest, "manifestHash"),
      (value) => builders.coverageInputManifest(value),
    ],
    [
      "builders.coverageProof",
      unsealBuilderInput(x.coverage, "semanticSha256"),
      (value) => builders.coverageProof(value),
    ],
    [
      "builders.crashPopulation",
      unsealBuilderInput(x.crash, "populationHash"),
      (value) => builders.crashPopulation(value),
    ],
    [
      "builders.executionObservation",
      unsealBuilderInput(x.observation, "semanticSha256"),
      (value) => builders.executionObservation(value),
    ],
    [
      "builders.frozenReview",
      unsealBuilderInput(f.frozenReview, "receiptHash"),
      (value) => builders.frozenReview(value),
    ],
    [
      "builders.layerPass",
      unsealBuilderInput(
        f.layerResults.unit,
        "semanticSha256",
        "receiptHash",
      ),
      (value) => builders.layerPass(value),
    ],
    [
      "builders.notApplicable",
      unsealBuilderInput(
        f.layerResults.natural_cycle_qa,
        "receiptHash",
      ),
      (value) => builders.notApplicable(value),
    ],
    [
      "builders.operationalManifest",
      unsealBuilderInput(x.operational, "manifestHash"),
      (value) => builders.operationalManifest(value),
    ],
    [
      "builders.parserPopulation",
      unsealBuilderInput(x.parser, "populationHash"),
      (value) => builders.parserPopulation(value),
    ],
    [
      "builders.qualityPlan",
      unsealBuilderInput(f.plan, "planSha256"),
      (value) => builders.qualityPlan(value, f.policy),
    ],
    [
      "builders.populationFloor",
      unsealBuilderInput(f.floor, "floorHash"),
      (value) => builders.populationFloor(value),
    ],
    [
      "builders.qualityPolicy",
      unsealBuilderInput(f.policy, "policySha256"),
      (value) => builders.qualityPolicy(value),
    ],
    [
      "builders.qualityReceipt",
      unsealBuilderInput(f.quality, "receiptHash"),
      (value) => builders.qualityReceipt(value, f.qualityContext),
    ],
    [
      "builders.verifierOutput",
      unsealBuilderInput(x.verifier, "resultHash"),
      (value) => builders.verifierOutput(value),
    ],
  ];

  assert.equal(validatorSurfaces.length, 19);
  assert.equal(builderSurfaces.length, 19);
  for (const [label, validInput, invoke] of [
    ...validatorSurfaces,
    ...builderSurfaces,
  ]) {
    assert.doesNotThrow(() => invoke(validInput), `${label} baseline`);
    for (const [variant, proxied] of rootProxyVariants(validInput)) {
      assertProxyRefusedWithoutTrap(
        invoke,
        proxied.value,
        proxied.counter,
        `${label}: ${variant}`,
      );
    }
  }
});

test("recursive, context, canonical-hash, and byte boundaries are proxy fail-first", () => {
  const f = makeFixture();
  for (const [label, childTarget, makeGraph] of [
    ["object child in object", {}, (child) => ({ child })],
    ["array child in object", [], (child) => ({ child })],
    ["object child in array", {}, (child) => [child]],
    ["array child in array", [], (child) => [child]],
  ]) {
    const nested = instrumentedProxy(childTarget, { throwing: true });
    assertProxyRefusedWithoutTrap(
      (value) => stableJson(value),
      makeGraph(nested.value),
      nested.counter,
      label,
    );
  }

  const nestedCases = [
    ["stableJson", (value) => stableJson(value)],
    [
      "hashWithoutField",
      (value) => hashWithoutField(value, "omitted"),
    ],
    [
      "semanticHashWithoutField",
      (value) => semanticHashWithoutField(value, "omitted"),
    ],
    ["layerSemanticHash", (value) => layerSemanticHash(value)],
  ];
  for (const [label, invoke] of nestedCases) {
    const nested = instrumentedProxy({ value: true }, { throwing: true });
    assertProxyRefusedWithoutTrap(
      invoke,
      { retained: nested.value },
      nested.counter,
      `${label}: nested proxy`,
    );
    for (const [variant, proxied] of rootProxyVariants({ retained: true })) {
      assertProxyRefusedWithoutTrap(
        invoke,
        proxied.value,
        proxied.counter,
        `${label}: ${variant}`,
      );
    }
  }

  for (const [label, invoke] of [
    [
      "hashWithoutField",
      (field) => hashWithoutField({ retained: true }, field),
    ],
    [
      "semanticHashWithoutField",
      (field) => semanticHashWithoutField({ retained: true }, field),
    ],
  ]) {
    for (const [variant, proxied] of rootProxyVariants({})) {
      assertProxyRefusedWithoutTrap(
        invoke,
        proxied.value,
        proxied.counter,
        `${label} field: ${variant}`,
      );
    }
  }

  for (const [label, bytes] of [
    ["Proxy(Buffer)", Buffer.from("proxy-buffer")],
    ["Proxy(Uint8Array)", new Uint8Array([1, 2, 3])],
  ]) {
    for (const [variant, options] of [
      ["transparent", {}],
      ["throwing", { throwing: true }],
      ["revoked", { throwing: true, revoked: true }],
    ]) {
      const proxied = instrumentedProxy(bytes, options);
      assertProxyRefusedWithoutTrap(
        (value) => sha256(value),
        proxied.value,
        proxied.counter,
        `sha256 ${label}: ${variant}`,
      );
    }
  }
  for (const [variant, proxied] of rootProxyVariants(function byteCallable() {})) {
    assertProxyRefusedWithoutTrap(
      (value) => sha256(value),
      proxied.value,
      proxied.counter,
      `sha256: ${variant}`,
    );
  }

  const candidateContext = {
    ...f.qualityContext,
    qualityReceipt: f.quality,
  };
  const contextSurfaces = [
    [
      "plan validator",
      f.policy,
      (context) => validatePhaseQualityPlanV4(f.plan, context),
    ],
    [
      "plan builder",
      f.policy,
      (context) =>
        builders.qualityPlan(
          unsealBuilderInput(f.plan, "planSha256"),
          context,
        ),
    ],
    [
      "quality validator",
      f.qualityContext,
      (context) => validateQualityReceiptV7(f.quality, context),
    ],
    [
      "quality builder",
      f.qualityContext,
      (context) =>
        builders.qualityReceipt(
          unsealBuilderInput(f.quality, "receiptHash"),
          context,
        ),
    ],
    [
      "candidate validator",
      candidateContext,
      (context) => validateCandidateReceiptV3(f.candidate, context),
    ],
    [
      "candidate builder",
      candidateContext,
      (context) =>
        builders.candidateReceipt(
          unsealBuilderInput(f.candidate, "receiptHash"),
          context,
        ),
    ],
    [
      "attestation validator",
      f.attestationContext,
      (context) => validateAttestationBodyV3(f.attestation, context),
    ],
    [
      "attestation builder",
      f.attestationContext,
      (context) =>
        builders.attestationBody(
          unsealBuilderInput(f.attestation, "bodySha256"),
          context,
        ),
    ],
  ];
  for (const [label, validContext, invoke] of contextSurfaces) {
    for (const [variant, proxied] of rootProxyVariants(validContext)) {
      assertProxyRefusedWithoutTrap(
        invoke,
        proxied.value,
        proxied.counter,
        `${label}: ${variant}`,
      );
    }
  }

  for (const [label, context, invoke] of [
    [
      "plan nested context",
      clone(f.policy),
      (value) => validatePhaseQualityPlanV4(f.plan, value),
    ],
    [
      "quality nested context",
      clone(f.qualityContext),
      (value) => validateQualityReceiptV7(f.quality, value),
    ],
    [
      "candidate nested context",
      clone(candidateContext),
      (value) => validateCandidateReceiptV3(f.candidate, value),
    ],
    [
      "attestation nested context",
      clone(f.attestationContext),
      (value) => validateAttestationBodyV3(f.attestation, value),
    ],
  ]) {
    const nested = instrumentedProxy(
      label.startsWith("plan")
        ? context.profiles
        : label.startsWith("attestation")
          ? context.attestationEvidence
          : context.policy,
      { throwing: true },
    );
    if (label.startsWith("plan")) context.profiles = nested.value;
    else if (label.startsWith("attestation")) {
      context.attestationEvidence = nested.value;
    } else {
      context.policy = nested.value;
    }
    assertProxyRefusedWithoutTrap(
      invoke,
      context,
      nested.counter,
      label,
    );
  }

  let artifactTrapCount = 0;
  const timeVaryingArtifact = new Proxy(clone(f.shared), {
    getPrototypeOf(target) {
      artifactTrapCount += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      artifactTrapCount += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      artifactTrapCount += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      artifactTrapCount += 1;
      if (key === "sha256") return artifactTrapCount % 2 === 0
        ? digest("time-a")
        : digest("time-b");
      if (key === "address") return `sha256:${digest("time-c")}`;
      if (key === "byteLength") return -1;
      return Reflect.get(target, key, receiver);
    },
  });
  assertCode(
    () => validateArtifactRef(timeVaryingArtifact),
    "PROXY_REFUSED",
  );
  assert.equal(artifactTrapCount, 0);

  let getterRuns = 0;
  const accessor = {};
  Object.defineProperty(accessor, "hostile", {
    enumerable: true,
    get() {
      getterRuns += 1;
      throw new Error("getter executed");
    },
  });
  for (const invoke of [
    (value) => stableJson(value),
    (value) => hashWithoutField(value, "omitted"),
    (value) => semanticHashWithoutField(value, "omitted"),
    (value) => layerSemanticHash(value),
  ]) {
    assertCode(() => invoke(accessor), "ACCESSOR_FIELD_REFUSED");
  }
  assert.equal(getterRuns, 0);
});

test("public diagnostic and role arguments are admitted before receipt access", () => {
  const f = makeFixture();
  const coercibleLabel = (value) => ({
    [Symbol.toPrimitive]() {
      return value;
    },
  });

  for (const [variant, proxied] of rootProxyVariants(
    coercibleLabel("artifact-label"),
  )) {
    assertProxyRefusedWithoutTrap(
      (label) => validateArtifactRef(f.shared, label),
      proxied.value,
      proxied.counter,
      `artifact label: ${variant}`,
    );

    const invalidArtifact = clone(f.shared);
    invalidArtifact.byteLength = 0;
    assertProxyRefusedWithoutTrap(
      (label) => validateArtifactRef(invalidArtifact, label),
      proxied.value,
      proxied.counter,
      `invalid artifact label: ${variant}`,
    );
  }

  for (const [variant, proxied] of rootProxyVariants(
    coercibleLabel(f.identities.implementer.role),
  )) {
    assertProxyRefusedWithoutTrap(
      (expectedRole) =>
        validateAuthorityIdentity(
          f.identities.implementer,
          expectedRole,
          "identity",
        ),
      proxied.value,
      proxied.counter,
      `identity expectedRole: ${variant}`,
    );
  }

  for (const [variant, proxied] of rootProxyVariants(
    coercibleLabel("identity-label"),
  )) {
    assertProxyRefusedWithoutTrap(
      (label) =>
        validateAuthorityIdentity(
          f.identities.implementer,
          f.identities.implementer.role,
          label,
        ),
      proxied.value,
      proxied.counter,
      `identity label: ${variant}`,
    );

    const invalidIdentity = clone(f.identities.implementer);
    invalidIdentity.role = "";
    assertProxyRefusedWithoutTrap(
      (label) => validateAuthorityIdentity(invalidIdentity, null, label),
      proxied.value,
      proxied.counter,
      `invalid identity label: ${variant}`,
    );
  }

  const rootArtifact = instrumentedProxy(clone(f.shared), {
    throwing: true,
  });
  const artifactLabel = instrumentedProxy(
    coercibleLabel("combined-artifact-label"),
    { throwing: true },
  );
  assertProxyRefusedWithoutTrap(
    (label) => validateArtifactRef(rootArtifact.value, label),
    artifactLabel.value,
    artifactLabel.counter,
    "combined artifact root and label",
  );
  assert.equal(rootArtifact.counter.count, 0);

  const rootIdentity = instrumentedProxy(
    clone(f.identities.implementer),
    { throwing: true },
  );
  const expectedRole = instrumentedProxy(
    coercibleLabel(f.identities.implementer.role),
    { throwing: true },
  );
  const identityLabel = instrumentedProxy(
    coercibleLabel("combined-identity-label"),
    { throwing: true },
  );
  assert.throws(
    () =>
      validateAuthorityIdentity(
        rootIdentity.value,
        expectedRole.value,
        identityLabel.value,
      ),
    (error) => {
      assert.equal(error?.name, "QualityContractV4Error");
      assert.equal(error?.code, "PROXY_REFUSED");
      return true;
    },
  );
  assert.equal(rootIdentity.counter.count, 0);
  assert.equal(expectedRole.counter.count, 0);
  assert.equal(identityLabel.counter.count, 0);

  assert.doesNotThrow(() =>
    validateArtifactRef(f.shared, "artifact label"),
  );
  assert.doesNotThrow(() =>
    validateAuthorityIdentity(f.identities.implementer),
  );
  assert.doesNotThrow(() =>
    validateAuthorityIdentity(
      f.identities.implementer,
      f.identities.implementer.role,
      "implementer identity",
    ),
  );
});

test("hash and artifact binding failures cannot be hidden by recomputing outer receipts", () => {
  const f = makeFixture();
  const badArtifact = clone(f.shared);
  badArtifact.address = `sha256:${digest("other")}`;
  assertCode(() => validateArtifactRef(badArtifact), "ARTIFACT_ADDRESS_MISMATCH");

  const attestation = clone(f.attestation);
  attestation.artifacts.sourceManifest = artifact("misbound-source");
  attestation.bodySha256 = contract.hashWithoutField(attestation, "bodySha256");
  assertCode(
    () => validateAttestationBodyV3(attestation, f.attestationContext),
    "ATTESTATION_ARTIFACT_MISMATCH",
  );

  const candidatePhase = clone(f.attestation);
  candidatePhase.phaseReceiptHashes.candidate = digest("other-candidate");
  candidatePhase.bodySha256 = contract.hashWithoutField(
    candidatePhase,
    "bodySha256",
  );
  assertCode(
    () => validateAttestationBodyV3(candidatePhase, f.attestationContext),
    "ATTESTATION_PHASE_RECEIPT_MISMATCH",
  );

  const staleLayer = clone(f.quality);
  staleLayer.layerResults.unit.definitionManifestSha256 = digest("stale-definition");
  staleLayer.layerResults.unit.semanticSha256 = layerSemanticHash(
    staleLayer.layerResults.unit,
  );
  staleLayer.layerResults.unit.receiptHash = contract.hashWithoutField(
    staleLayer.layerResults.unit,
    "receiptHash",
  );
  staleLayer.receiptHash = contract.hashWithoutField(staleLayer, "receiptHash");
  assertCode(
    () => validateQualityReceiptV7(staleLayer, f.qualityContext),
    "LAYER_RESULT_BINDING_MISMATCH",
  );
});

test("quality receipt binds the frozen review CAS role and policy registry after outer rehash", () => {
  const f = makeFixture();
  const rejectQualityMutation = (mutate, code) => {
    const value = clone(f.quality);
    mutate(value);
    value.receiptHash = contract.hashWithoutField(value, "receiptHash");
    assertCode(
      () => validateQualityReceiptV7(value, f.qualityContext),
      code,
    );
  };

  rejectQualityMutation((value) => {
    value.independentFrozenHashReview.receiptHash = digest(
      "unrelated-review-receipt",
    );
  }, "FROZEN_REVIEW_ARTIFACT_BINDING_MISMATCH");
  rejectQualityMutation((value) => {
    value.independentFrozenHashReview.artifact = artifact(
      "unrelated-review-artifact",
    );
  }, "FROZEN_REVIEW_ARTIFACT_BINDING_MISMATCH");
  rejectQualityMutation((value) => {
    value.independentFrozenHashReview.artifact.address =
      `sha256:${digest("address-only")}`;
  }, "ARTIFACT_ADDRESS_MISMATCH");
  rejectQualityMutation((value) => {
    value.independentFrozenHashReview.artifact.mediaType = "text/plain";
  }, "FROZEN_REVIEW_ARTIFACT_BINDING_MISMATCH");
  rejectQualityMutation((value) => {
    value.phaseBinding.phaseProofRegistrySha256 = digest(
      "unrelated-phase-proof-registry",
    );
  }, "QUALITY_BINDING_MISMATCH");
});

test("candidate receipt binds every duplicated quality-context field after outer rehash", () => {
  const f = makeFixture();
  const context = {
    ...f.qualityContext,
    qualityReceipt: f.quality,
  };
  const mutations = [
    ["qualityReceiptHash", (value) => {
      value.qualityReceiptHash = digest("unrelated-quality-receipt");
    }],
    ["phaseId", (value) => {
      value.phaseId = "TRUTH-01";
    }],
    ["ledgerRevision", (value) => {
      value.ledgerRevision += 1;
    }],
    ["ledgerSha256", (value) => {
      value.ledgerSha256 = digest("unrelated-ledger");
    }],
    ["registrySha256", (value) => {
      value.registrySha256 = digest("unrelated-registry");
    }],
    ["scopeBaseCommit", (value) => {
      value.scopeBaseCommit = COMMIT_B;
    }],
    ["candidateCommit", (value) => {
      value.candidateCommit = COMMIT_A;
    }],
    ["candidateTree", (value) => {
      value.candidateTree = COMMIT_A;
    }],
    ["qualityPolicySha256", (value) => {
      value.qualityPolicySha256 = digest("unrelated-policy");
    }],
    ["qualityPlanSha256", (value) => {
      value.qualityPlanSha256 = digest("unrelated-plan");
    }],
    ["populationFloorSha256", (value) => {
      value.populationFloorSha256 = digest("unrelated-floor");
    }],
    ["artifactPolicySha256", (value) => {
      value.artifactPolicySha256 = digest("unrelated-artifact-policy");
    }],
    ["frozenReviewReceiptHash", (value) => {
      value.frozenReviewReceiptHash = digest("unrelated-frozen-review");
    }],
    ["rawEvidenceManifestSha256", (value) => {
      value.rawEvidenceManifestSha256 = digest(
        "unrelated-raw-evidence-manifest",
      );
    }],
  ];

  for (const [label, mutate] of mutations) {
    const value = clone(f.candidate);
    mutate(value);
    value.receiptHash = contract.hashWithoutField(value, "receiptHash");
    assertCode(
      () => validateCandidateReceiptV3(value, context),
      "CANDIDATE_QUALITY_BINDING_MISMATCH",
    );
    assert.ok(label);
  }

  for (const layerId of EVIDENCE_LAYER_IDS) {
    const value = clone(f.candidate);
    value.layerReceiptHashes[layerId] = digest(`unrelated-layer-${layerId}`);
    value.receiptHash = contract.hashWithoutField(value, "receiptHash");
    assertCode(
      () => validateCandidateReceiptV3(value, context),
      "CANDIDATE_LAYER_BINDING_MISMATCH",
    );
  }
});

test("candidate binds the resolved registry revision and exact upstream principals", () => {
  const f = makeFixture();
  const context = {
    ...f.qualityContext,
    qualityReceipt: f.quality,
  };
  assert.equal(
    f.candidate.registryRevision,
    context.phaseRegistryRevision,
  );
  assert.equal(
    f.candidate.controller.principalSha256,
    f.quality.identities.coordinator.principalSha256,
  );
  assert.equal(
    f.candidate.collector.principalSha256,
    f.quality.identities.collector.principalSha256,
  );

  const missingRevisionContext = { ...context };
  delete missingRevisionContext.phaseRegistryRevision;
  assertCode(
    () =>
      validateCandidateReceiptV3(
        f.candidate,
        missingRevisionContext,
      ),
    "CANDIDATE_REGISTRY_CONTEXT_REQUIRED",
  );
  assertCode(
    () =>
      builders.candidateReceipt(
        f.candidate,
        missingRevisionContext,
      ),
    "CANDIDATE_REGISTRY_CONTEXT_REQUIRED",
  );
  assertCode(
    () =>
      validateCandidateReceiptV3(f.candidate, {
        ...context,
        phaseRegistryRevision: 0,
      }),
    "INVALID_COUNTER",
  );
  assertCode(
    () =>
      validateCandidateReceiptV3(f.candidate, {
        ...context,
        phaseRegistryRevision: 2,
      }),
    "CANDIDATE_REGISTRY_REVISION_MISMATCH",
  );
  const staleRevision = clone(f.candidate);
  staleRevision.registryRevision = 999999;
  staleRevision.receiptHash = contract.hashWithoutField(
    staleRevision,
    "receiptHash",
  );
  assertCode(
    () => validateCandidateReceiptV3(staleRevision, context),
    "CANDIDATE_REGISTRY_REVISION_MISMATCH",
  );

  const substitutions = [
    {
      label: "controller-only",
      expectedCode: "CANDIDATE_CONTROLLER_IDENTITY_MISMATCH",
      mutate(value) {
        value.controller = identity(
          "controller",
          "forged-controller-only",
          false,
        );
      },
    },
    {
      label: "collector-only",
      expectedCode: "CANDIDATE_COLLECTOR_IDENTITY_MISMATCH",
      mutate(value) {
        value.collector = identity(
          "collector",
          "forged-collector-only",
          false,
        );
      },
    },
    {
      label: "controller-and-collector",
      expectedCode: "CANDIDATE_CONTROLLER_IDENTITY_MISMATCH",
      mutate(value) {
        value.controller = identity(
          "controller",
          "forged-controller-both",
          false,
        );
        value.collector = identity(
          "collector",
          "forged-collector-both",
          false,
        );
      },
    },
  ];

  for (const substitution of substitutions) {
    const candidate = clone(f.candidate);
    substitution.mutate(candidate);
    candidate.receiptHash = contract.hashWithoutField(
      candidate,
      "receiptHash",
    );
    assertCode(
      () => validateCandidateReceiptV3(candidate, context),
      substitution.expectedCode,
    );
    assertCode(
      () => builders.candidateReceipt(candidate, context),
      substitution.expectedCode,
    );

    const attestation = clone(f.attestation);
    attestation.candidateReceiptHash = candidate.receiptHash;
    attestation.phaseReceiptHashes.candidate = candidate.receiptHash;
    attestation.artifacts.candidateReceipt = artifactFromHash(
      candidate.receiptHash,
      substitution.label,
    );
    attestation.bodySha256 = contract.hashWithoutField(
      attestation,
      "bodySha256",
    );
    assertCode(
      () =>
        validateAttestationBodyV3(attestation, {
          ...f.attestationContext,
          candidateReceipt: candidate,
        }),
      substitution.expectedCode,
    );
  }
});

test("attestation duplicates only exact upstream principals, judges, and manifest", () => {
  const f = makeFixture();
  assert.deepEqual(
    f.attestation.rolePrincipalHashes,
    Object.fromEntries(
      ROLE_NAMES.map((role) => [
        role,
        f.quality.identities[role].principalSha256,
      ]),
    ),
  );
  assert.deepEqual(f.attestation.judgeReceiptHashes, {
    primary: f.quality.primaryJudge.sha256,
    independent: f.quality.independentJudge.sha256,
    collector: f.candidate.rawArtifact.sha256,
  });
  assert.equal(
    f.attestation.evidenceManifestSha256,
    f.candidate.rawEvidenceManifestSha256,
  );
  assert.equal(
    f.attestation.evidenceManifestSha256,
    f.quality.rawEvidenceManifest.sha256,
  );

  for (const role of ROLE_NAMES) {
    const value = clone(f.attestation);
    value.rolePrincipalHashes[role] = digest(
      `forged-attestation-role-${role}`,
    );
    value.bodySha256 = contract.hashWithoutField(value, "bodySha256");
    assert.equal(
      new Set(Object.values(value.rolePrincipalHashes)).size,
      ROLE_NAMES.length,
    );
    assertCode(
      () => validateAttestationBodyV3(value, f.attestationContext),
      "ATTESTATION_ROLE_PRINCIPAL_BINDING_MISMATCH",
    );
    assertCode(
      () => builders.attestationBody(value, f.attestationContext),
      "ATTESTATION_ROLE_PRINCIPAL_BINDING_MISMATCH",
    );
  }

  const judgeForgeries = [
    {
      key: "primary",
      mutate(value, forgedHash) {
        value.artifacts.primaryRaw = artifactFromHash(
          forgedHash,
          "forged-primary",
        );
      },
    },
    {
      key: "independent",
      mutate(value, forgedHash) {
        value.artifacts.independentRaw = artifactFromHash(
          forgedHash,
          "forged-independent",
        );
      },
    },
    {
      key: "collector",
      mutate() {},
    },
  ];
  for (const forgery of judgeForgeries) {
    const value = clone(f.attestation);
    const forgedHash = digest(`forged-judge-${forgery.key}`);
    value.judgeReceiptHashes[forgery.key] = forgedHash;
    forgery.mutate(value, forgedHash);
    value.bodySha256 = contract.hashWithoutField(value, "bodySha256");
    assert.equal(
      new Set(Object.values(value.judgeReceiptHashes)).size,
      3,
    );
    assertCode(
      () => validateAttestationBodyV3(value, f.attestationContext),
      "ATTESTATION_JUDGE_RECEIPT_BINDING_MISMATCH",
    );
    assertCode(
      () => builders.attestationBody(value, f.attestationContext),
      "ATTESTATION_JUDGE_RECEIPT_BINDING_MISMATCH",
    );
  }

  const manifestForgery = clone(f.attestation);
  manifestForgery.evidenceManifestSha256 = digest(
    "forged-attestation-evidence-manifest",
  );
  manifestForgery.artifacts.evidenceManifest = artifactFromHash(
    manifestForgery.evidenceManifestSha256,
    "forged-manifest",
  );
  manifestForgery.bodySha256 = contract.hashWithoutField(
    manifestForgery,
    "bodySha256",
  );
  assertCode(
    () =>
      validateAttestationBodyV3(
        manifestForgery,
        f.attestationContext,
      ),
    "ATTESTATION_EVIDENCE_MANIFEST_BINDING_MISMATCH",
  );
  assertCode(
    () =>
      builders.attestationBody(
        manifestForgery,
        f.attestationContext,
      ),
    "ATTESTATION_EVIDENCE_MANIFEST_BINDING_MISMATCH",
  );
});

test("attestation-only evidence requires exact trusted external context", () => {
  const f = makeFixture();
  assert.deepEqual(f.attestationContext.attestationEvidence, {
    issuerRegistrySha256: f.attestation.issuerRegistrySha256,
    sourceManifestSha256: f.attestation.sourceManifestSha256,
    rehearsalReceiptHash: f.attestation.phaseReceiptHashes.rehearsal,
    changeReceiptHash: f.attestation.phaseReceiptHashes.change,
    promotionReceiptHash: f.attestation.phaseReceiptHashes.promotion,
  });

  const missing = { ...f.attestationContext };
  delete missing.attestationEvidence;
  assertCode(
    () => validateAttestationBodyV3(f.attestation, missing),
    "ATTESTATION_EVIDENCE_CONTEXT_REQUIRED",
  );
  assertCode(
    () => builders.attestationBody(f.attestation, missing),
    "ATTESTATION_EVIDENCE_CONTEXT_REQUIRED",
  );

  const extra = clone(f.attestationContext);
  extra.attestationEvidence.unexpected = digest("unexpected-context");
  assertCode(
    () => validateAttestationBodyV3(f.attestation, extra),
    "UNEXPECTED_FIELDS",
  );
  const malformedShape = {
    ...f.attestationContext,
    attestationEvidence: [],
  };
  assertCode(
    () => validateAttestationBodyV3(f.attestation, malformedShape),
    "INVALID_OBJECT",
  );
  const malformedHash = clone(f.attestationContext);
  malformedHash.attestationEvidence.sourceManifestSha256 = "bad";
  assertCode(
    () => validateAttestationBodyV3(f.attestation, malformedHash),
    "INVALID_STRING",
  );

  const externalForgeries = [
    {
      key: "issuerRegistrySha256",
      mutate(value, forgedHash) {
        value.issuerRegistrySha256 = forgedHash;
      },
    },
    {
      key: "sourceManifestSha256",
      mutate(value, forgedHash) {
        value.sourceManifestSha256 = forgedHash;
        value.artifacts.sourceManifest = artifactFromHash(
          forgedHash,
          "forged-source-manifest",
        );
      },
    },
    {
      key: "rehearsalReceiptHash",
      mutate(value, forgedHash) {
        value.phaseReceiptHashes.rehearsal = forgedHash;
        value.artifacts.rehearsalReceipt = artifactFromHash(
          forgedHash,
          "forged-rehearsal",
        );
      },
    },
    {
      key: "changeReceiptHash",
      mutate(value, forgedHash) {
        value.phaseReceiptHashes.change = forgedHash;
        value.artifacts.changeReceipt = artifactFromHash(
          forgedHash,
          "forged-change",
        );
      },
    },
    {
      key: "promotionReceiptHash",
      mutate(value, forgedHash) {
        value.phaseReceiptHashes.promotion = forgedHash;
        value.artifacts.promotionReceipt = artifactFromHash(
          forgedHash,
          "forged-promotion",
        );
      },
    },
  ];

  for (const forgery of externalForgeries) {
    const value = clone(f.attestation);
    forgery.mutate(
      value,
      digest(`forged-external-${forgery.key}`),
    );
    value.bodySha256 = contract.hashWithoutField(value, "bodySha256");
    assertCode(
      () => validateAttestationBodyV3(value, f.attestationContext),
      "ATTESTATION_EVIDENCE_CONTEXT_MISMATCH",
    );
    assertCode(
      () => builders.attestationBody(value, f.attestationContext),
      "ATTESTATION_EVIDENCE_CONTEXT_MISMATCH",
    );
  }
});

test("attestation binds every remaining duplicated quality-candidate field", () => {
  const f = makeFixture();
  const mutations = [
    (value) => {
      value.phaseId = "TRUTH-01";
    },
    (value) => {
      value.ledgerRevision += 1;
    },
    (value) => {
      value.ledgerSha256 = digest("forged-attestation-ledger");
    },
    (value) => {
      value.phaseProofRegistrySha256 = digest(
        "forged-attestation-registry",
      );
    },
    (value) => {
      value.qualityPolicySha256 = digest(
        "forged-attestation-policy",
      );
    },
    (value) => {
      value.qualityPlanSha256 = digest("forged-attestation-plan");
    },
    (value) => {
      value.populationFloorSha256 = digest(
        "forged-attestation-floor",
      );
    },
    (value) => {
      value.artifactPolicySha256 = digest(
        "forged-attestation-artifact-policy",
      );
    },
    (value) => {
      value.candidateCommit = COMMIT_A;
    },
    (value) => {
      value.candidateTree = COMMIT_A;
    },
    (value) => {
      value.strictQualityReceiptHash = digest(
        "forged-attestation-quality-receipt",
      );
      value.artifacts.qualityReceipt = artifactFromHash(
        value.strictQualityReceiptHash,
        "forged-quality-receipt",
      );
    },
    (value) => {
      value.candidateReceiptHash = digest(
        "forged-attestation-candidate-receipt",
      );
      value.phaseReceiptHashes.candidate =
        value.candidateReceiptHash;
      value.artifacts.candidateReceipt = artifactFromHash(
        value.candidateReceiptHash,
        "forged-candidate-receipt",
      );
    },
    (value) => {
      value.frozenReviewReceiptHash = digest(
        "forged-attestation-review-receipt",
      );
      value.artifacts.frozenReviewReceipt = artifactFromHash(
        value.frozenReviewReceiptHash,
        "forged-review-receipt",
      );
    },
    (value) => {
      value.commandPlanHash = digest(
        "forged-attestation-command-plan",
      );
    },
  ];

  for (const mutate of mutations) {
    const value = clone(f.attestation);
    mutate(value);
    value.bodySha256 = contract.hashWithoutField(value, "bodySha256");
    assertCode(
      () => validateAttestationBodyV3(value, f.attestationContext),
      "ATTESTATION_QUALITY_BINDING_MISMATCH",
    );
    assertCode(
      () => builders.attestationBody(value, f.attestationContext),
      "ATTESTATION_QUALITY_BINDING_MISMATCH",
    );
  }
});

test("artifact-policy digest is conjunctively bound through the full quality chain", () => {
  const f = makeFixture();
  assert.equal(f.policy.artifactPolicySha256, f.plan.artifactPolicySha256);
  assert.equal(
    f.plan.artifactPolicySha256,
    f.quality.artifactPolicySha256,
  );
  assert.equal(
    f.quality.artifactPolicySha256,
    f.candidate.artifactPolicySha256,
  );
  assert.equal(
    f.candidate.artifactPolicySha256,
    f.attestation.artifactPolicySha256,
  );

  const alternatePolicyFields = clone(f.policy);
  alternatePolicyFields.artifactPolicySha256 = digest(
    "alternate-artifact-policy",
  );
  const alternatePolicy = builders.qualityPolicy(alternatePolicyFields);
  const stalePlanFields = clone(f.plan);
  stalePlanFields.policySha256 = alternatePolicy.policySha256;
  assertCode(
    () => builders.qualityPlan(stalePlanFields, alternatePolicy),
    "ARTIFACT_POLICY_BINDING_MISMATCH",
  );

  const staleQuality = clone(f.quality);
  staleQuality.artifactPolicySha256 = digest("stale-quality-artifact-policy");
  staleQuality.receiptHash = contract.hashWithoutField(
    staleQuality,
    "receiptHash",
  );
  assertCode(
    () => validateQualityReceiptV7(staleQuality, f.qualityContext),
    "ARTIFACT_POLICY_BINDING_MISMATCH",
  );

  const staleCandidate = clone(f.candidate);
  staleCandidate.artifactPolicySha256 = digest(
    "stale-candidate-artifact-policy",
  );
  staleCandidate.receiptHash = contract.hashWithoutField(
    staleCandidate,
    "receiptHash",
  );
  assertCode(
    () =>
      validateCandidateReceiptV3(staleCandidate, {
        ...f.qualityContext,
        qualityReceipt: f.quality,
      }),
    "CANDIDATE_QUALITY_BINDING_MISMATCH",
  );

  const staleAttestation = clone(f.attestation);
  staleAttestation.artifactPolicySha256 = digest(
    "stale-attestation-artifact-policy",
  );
  staleAttestation.bodySha256 = contract.hashWithoutField(
    staleAttestation,
    "bodySha256",
  );
  assertCode(
    () =>
      validateAttestationBodyV3(
        staleAttestation,
        f.attestationContext,
      ),
    "ATTESTATION_QUALITY_BINDING_MISMATCH",
  );
  assertCode(
    () => validateCandidateReceiptV3(f.candidate),
    "QUALITY_CONTEXT_REQUIRED",
  );
  assertCode(
    () => validateAttestationBodyV3(f.attestation),
    "QUALITY_CONTEXT_REQUIRED",
  );
});

test("resource ceilings are immutable, narrowable, and envelope-capacity safe", () => {
  const f = makeFixture();
  assert.deepEqual(f.policy.resourceCeilings, IMMUTABLE_RESOURCE_CEILINGS);
  assert.deepEqual(
    f.plan.resourceLimits,
    Object.fromEntries(
      Object.keys(f.plan.resourceLimits).map((key) => [
        key,
        IMMUTABLE_RESOURCE_CEILINGS[key],
      ]),
    ),
  );
  const maximumBase64Characters =
    4 * Math.ceil(IMMUTABLE_RESOURCE_CEILINGS.maximumStdoutBytes / 3);
  const envelopeWithoutPayload = stableJson({
    base64: "",
    decodedByteLength:
      IMMUTABLE_RESOURCE_CEILINGS.maximumStdoutBytes,
    encoding: "base64",
    schema: "pikiio-byte-stream-envelope-v1",
  });
  const exactMaximumEnvelopeBytes =
    Buffer.byteLength(envelopeWithoutPayload, "utf8") +
    maximumBase64Characters;
  assert.equal(exactMaximumEnvelopeBytes, 1398207);
  assert.ok(
    exactMaximumEnvelopeBytes <=
      IMMUTABLE_RESOURCE_CEILINGS.maximumByteStreamEnvelopeBytes,
  );

  for (const key of Object.keys(IMMUTABLE_RESOURCE_CEILINGS)) {
    const policy = clone(f.policy);
    policy.resourceCeilings[key] += 1;
    assertCode(
      () => validateQualityPolicyV4(policy),
      "RESOURCE_CEILING_MUTATED",
    );
  }
  const undersizedEnvelope = clone(f.policy);
  undersizedEnvelope.resourceCeilings.maximumByteStreamEnvelopeBytes =
    exactMaximumEnvelopeBytes - 1;
  assertCode(
    () => validateQualityPolicyV4(undersizedEnvelope),
    "BYTE_STREAM_ENVELOPE_CAPACITY_EXCEEDED",
  );

  for (const key of Object.keys(f.plan.resourceLimits)) {
    const plan = clone(f.plan);
    plan.resourceLimits[key] += 1;
    assertCode(
      () => validatePhaseQualityPlanV4(plan, f.policy),
      key === "maximumRetries"
        ? "RESOURCE_LIMIT_INVALID"
        : "RESOURCE_CEILING_EXCEEDED",
    );
  }
  const narrowPlanFields = clone(f.plan);
  Object.assign(narrowPlanFields.resourceLimits, {
    timeoutMsPerExecution: 60000,
    maximumStdoutBytes: 524288,
    maximumStderrBytes: 262144,
    maximumPeakRssBytes: 536870912,
    maximumProcessCount: 8,
    maximumRetries: 0,
  });
  const narrowPlan = builders.qualityPlan(narrowPlanFields, f.policy);
  assert.equal(narrowPlan.resourceLimits.maximumStdoutBytes, 524288);
  assert.equal(
    validatePhaseQualityPlanV4(narrowPlan, f.policy).planSha256,
    narrowPlan.planSha256,
  );
});

test("execution matrix is an exact Cartesian plan with complete zero-defect proof", () => {
  const f = makeFixture();
  assert.deepEqual(f.plan.executionMatrix, {
    mode: "cartesian_product",
    repeatsPerCell: 3,
    seeds: ["seed-a", "seed-b"],
    timeZones: ["America/New_York", "UTC"],
    orders: ["forward", "reverse"],
    fixtureManifestSha256: digest("fixtures"),
    expectedExecutionCount: 24,
    matrixSha256: f.plan.executionMatrix.matrixSha256,
  });
  assert.equal(
    f.plan.executionMatrix.matrixSha256,
    contract.hashWithoutField(f.plan.executionMatrix, "matrixSha256"),
  );
  const retainedExecutionAddresses =
    f.quality.layerResults.deterministic_repeat.executions.map(
      (entry) => entry.address,
    );
  const exactRetainedAddressSet = Array.from(
    { length: f.plan.executionMatrix.expectedExecutionCount },
    (_, index) =>
      `sha256:${digest(`execution-deterministic_repeat-${index + 1}`)}`,
  ).sort();
  assert.equal(
    retainedExecutionAddresses.length,
    f.plan.executionMatrix.expectedExecutionCount,
  );
  assert.equal(
    new Set(retainedExecutionAddresses).size,
    f.plan.executionMatrix.expectedExecutionCount,
  );
  assert.deepEqual(
    [...new Set(retainedExecutionAddresses)].sort(),
    exactRetainedAddressSet,
  );

  const rejectPlan = (mutate, code) => {
    const value = clone(f.plan);
    mutate(value.executionMatrix);
    assertCode(() => validatePhaseQualityPlanV4(value, f.policy), code);
  };
  rejectPlan(
    (value) => {
      value.mode = "zip";
    },
    "EXECUTION_MATRIX_MODE_INVALID",
  );
  rejectPlan(
    (value) => {
      value.expectedExecutionCount -= 1;
    },
    "EXECUTION_MATRIX_COUNT_MISMATCH",
  );
  rejectPlan(
    (value) => {
      value.matrixSha256 = digest("stale-matrix");
    },
    "EXECUTION_MATRIX_HASH_MISMATCH",
  );
  rejectPlan(
    (value) => {
      value.seeds = ["seed-a", "seed-a"];
    },
    "INVALID_STRING_SET",
  );

  const rejectProof = (mutate) => {
    const value = clone(f.quality);
    mutate(value);
    value.receiptHash = contract.hashWithoutField(value, "receiptHash");
    assertCode(
      () => validateQualityReceiptV7(value, f.qualityContext),
      "EXECUTION_MATRIX_PROOF_INVALID",
    );
  };
  for (const key of [
    "missingCoordinateCount",
    "duplicateCoordinateCount",
    "divergentCoordinateCount",
  ]) {
    rejectProof((value) => {
      value.executionMatrix[key] = 1;
    });
  }
  rejectProof((value) => {
    value.executionMatrix.observedExecutionCount -= 1;
  });
  rejectProof((value) => {
    value.executionMatrix.expectedExecutionCount -= 1;
  });
  rejectProof((value) => {
    value.executionMatrix.matrixSha256 = digest("other-matrix");
  });
  rejectProof((value) => {
    const fields = unsealLayerPass(
      value.layerResults.deterministic_repeat,
    );
    fields.minimumCasesObserved -= 1;
    value.layerResults.deterministic_repeat = builders.layerPass(fields);
  });
  rejectProof((value) => {
    const fields = unsealLayerPass(
      value.layerResults.deterministic_repeat,
    );
    fields.executions.pop();
    value.layerResults.deterministic_repeat = builders.layerPass(fields);
  });

  const duplicateRetainedReference = clone(f.quality);
  const deterministic =
    duplicateRetainedReference.layerResults.deterministic_repeat;
  deterministic.executions[deterministic.executions.length - 1] =
    clone(deterministic.executions[0]);
  deterministic.semanticSha256 = layerSemanticHash(deterministic);
  deterministic.receiptHash = contract.hashWithoutField(
    deterministic,
    "receiptHash",
  );
  duplicateRetainedReference.receiptHash = contract.hashWithoutField(
    duplicateRetainedReference,
    "receiptHash",
  );
  assert.equal(
    duplicateRetainedReference.executionMatrix.missingCoordinateCount,
    0,
  );
  assert.equal(
    duplicateRetainedReference.executionMatrix.duplicateCoordinateCount,
    0,
  );
  assert.equal(
    duplicateRetainedReference.executionMatrix.divergentCoordinateCount,
    0,
  );
  assertCode(
    () =>
      validateQualityReceiptV7(
        duplicateRetainedReference,
        f.qualityContext,
      ),
    "LAYER_ARTIFACT_ADDRESS_COLLISION",
  );
});

test("specialized artifacts have exact layer provenance or controller-only isolation", () => {
  const f = makeFixture();
  assert.deepEqual(
    f.quality.specializedArtifactProvenance,
    SPECIALIZED_ARTIFACT_PROVENANCE,
  );
  const expectedBindings = [
    [f.quality.coverage, "coverage", 0],
    [f.quality.mutation, "mutation", 0],
    [
      f.quality.executionMatrix.artifact,
      "deterministic_repeat",
      0,
    ],
    [
      f.quality.operationalIntegrity.beforeManifest,
      "operational_integrity",
      0,
    ],
    [
      f.quality.operationalIntegrity.afterManifest,
      "operational_integrity",
      1,
    ],
    [
      f.quality.operationalIntegrity.automationInputs,
      "operational_integrity",
      2,
    ],
    [f.quality.crashRestart, "crash_restart", 0],
    [
      f.quality.concurrencyLinearizability,
      "concurrency_linearizability",
      0,
    ],
    [
      f.quality.schemaParserRobustness,
      "schema_parser_robustness",
      0,
    ],
    [
      f.quality.independentFrozenHashReview.artifact,
      "independent_frozen_hash_review",
      0,
    ],
  ];
  for (const [reference, layerId, index] of expectedBindings) {
    assert.deepEqual(
      reference,
      f.quality.layerResults[layerId].outputArtifacts[index],
    );
  }

  const rejectQuality = (mutate, code) => {
    const value = clone(f.quality);
    mutate(value);
    value.receiptHash = contract.hashWithoutField(value, "receiptHash");
    assertCode(
      () => validateQualityReceiptV7(value, f.qualityContext),
      code,
    );
  };
  rejectQuality((value) => {
    value.specializedArtifactProvenance.coverage.outputIndex = 1;
  }, "SPECIALIZED_ARTIFACT_PROVENANCE_INVALID");
  rejectQuality((value) => {
    value.coverage = artifact("unrelated-coverage");
  }, "SPECIALIZED_ARTIFACT_BINDING_MISMATCH");
  rejectQuality((value) => {
    value.operationalIntegrity.afterManifest = clone(
      value.operationalIntegrity.beforeManifest,
    );
  }, "SPECIALIZED_ARTIFACT_BINDING_MISMATCH");
  rejectQuality((value) => {
    const fields = unsealLayerPass(value.layerResults.coverage);
    fields.outputArtifacts.push(artifact("extra-coverage-output"));
    value.layerResults.coverage = builders.layerPass(fields);
  }, "SPECIALIZED_ARTIFACT_CARDINALITY_MISMATCH");
  rejectQuality((value) => {
    value.antiWeakening = clone(
      value.layerResults.unit.outputArtifacts[0],
    );
  }, "CONTROLLER_ONLY_ARTIFACT_ALIAS");
  rejectQuality((value) => {
    value.primaryJudge = clone(value.antiWeakening);
  }, "CONTROLLER_ONLY_ARTIFACT_ALIAS");
  rejectQuality((value) => {
    value.specializedArtifactProvenance.rawEvidenceManifest.outputCardinality =
      1;
  }, "SPECIALIZED_ARTIFACT_PROVENANCE_INVALID");
});

test("typed not-applicable results bind the exact policy-plan disposition tuple", () => {
  const f = makeFixture();
  const layerId = "natural_cycle_qa";
  const rejectTupleMutation = (mutate, code = "NOT_APPLICABLE_BINDING_MISMATCH") => {
    const quality = clone(f.quality);
    const result = quality.layerResults[layerId];
    mutate(result);
    result.receiptHash = contract.hashWithoutField(result, "receiptHash");
    quality.receiptHash = contract.hashWithoutField(quality, "receiptHash");
    assertCode(
      () => validateQualityReceiptV7(quality, f.qualityContext),
      code,
    );
  };

  rejectTupleMutation((result) => {
    result.policySha256 = digest("unrelated-na-policy");
  });
  rejectTupleMutation((result) => {
    result.qualityPlanSha256 = digest("unrelated-na-plan");
  });
  rejectTupleMutation((result) => {
    result.policyRuleId = "rule-unrelated";
  });
  rejectTupleMutation((result) => {
    result.policyRuleSha256 = digest("unrelated-na-rule");
  });
  rejectTupleMutation((result) => {
    result.reasonCode = "phase_has_no_natural_cycle_surface";
  });
  rejectTupleMutation((result) => {
    result.layerId = "api_browser_parity";
  }, "NOT_APPLICABLE_REASON_REFUSED");

  const quality = clone(f.quality);
  const browserDisposition = f.plan.layers.api_browser_parity.disposition;
  quality.layerResults[layerId] = builders.notApplicable({
    layerId: "api_browser_parity",
    status: "not_applicable",
    reasonCode: browserDisposition.reasonCode,
    policyRuleId: browserDisposition.policyRuleId,
    policyRuleSha256: browserDisposition.policyRuleSha256,
    policySha256: f.policy.policySha256,
    qualityPlanSha256: f.plan.planSha256,
    observedAt: NOW,
  });
  quality.receiptHash = contract.hashWithoutField(quality, "receiptHash");
  assertCode(
    () => validateQualityReceiptV7(quality, f.qualityContext),
    "NOT_APPLICABLE_BINDING_MISMATCH",
  );
});

test("adversarial leaf matrix traverses every specialized refusal family", () => {
  const f = makeFixture();
  const x = makeAuxiliaryFixtures();
  const reject = (base, validate, mutations) => {
    for (const mutate of mutations) {
      const value = clone(base);
      mutate(value);
      assertContractError(() => validate(value));
    }
  };

  reject(x.observation, validateExecutionObservationV3, [
    (value) => {
      value.layerId = "unknown";
    },
    (value) => {
      value.process.finishedAt = "2026-07-25T11:59:59.000Z";
    },
    (value) => {
      value.process.exitCode = -1;
    },
    (value) => {
      value.population.passed = 0;
    },
    (value) => {
      value.process.timedOut = "false";
    },
    (value) => {
      value.runtime.nodeSha256 = "bad";
    },
  ]);
  const signaledFields = clone(x.observation);
  delete signaledFields.semanticSha256;
  signaledFields.process.signal = "SIGTERM";
  validateExecutionObservationV3(builders.executionObservation(signaledFields));

  reject(x.verifier, validateVerifierOutput, [
    (value) => {
      value.layerId = "unit";
    },
    (value) => {
      value.ok = false;
    },
    (value) => {
      value.passed = 2;
    },
    (value) => {
      value.failures = ["failure"];
    },
    (value) => {
      value.timeoutCount = 1;
    },
    (value) => {
      value.cases = 0;
    },
  ]);

  const layer = f.layerResults.unit;
  reject(layer, validateLayerPassV2, [
    (value) => {
      value.status = "failed";
    },
    (value) => {
      value.executions = [];
    },
    (value) => {
      value.outputArtifacts = {};
    },
    (value) => {
      value.minimumCasesObserved = 0;
    },
    (value) => {
      value.failed = 1;
    },
    (value) => {
      value.semanticSha256 = digest("stale-semantic");
    },
  ]);

  const na = f.layerResults.natural_cycle_qa;
  reject(na, validateNotApplicableResult, [
    (value) => {
      value.layerId = "unit";
    },
    (value) => {
      value.status = "passed";
    },
    (value) => {
      value.reasonCode = "phase_has_no_browser_surface";
    },
    (value) => {
      value.observedAt = "yesterday";
    },
  ]);

  reject(x.inputManifest, validateCoverageInputManifest, [
    (value) => {
      value.orderedInputs = [];
    },
    (value) => {
      value.orderedInputs[0].ordinal = 2;
    },
  ]);
  reject(x.coverage, validateCoverageProofV2, [
    (value) => {
      value.uncoveredRequiredFiles = ["lib/a.js"];
    },
    (value) => {
      value.files = [];
    },
    (value) => {
      value.files[0].path = "../escape";
    },
    (value) => {
      value.files[0].lines.covered = 2;
    },
    (value) => {
      value.requiredFiles = ["lib/b.js"];
    },
  ]);

  reject(x.operational, validateOperationalManifestV2, [
    (value) => {
      value.entries = {};
    },
    (value) => {
      value.entries[0].path = "/absolute";
    },
    (value) => {
      value.entries[0].type = "symlink";
    },
    (value) => {
      value.entries.push({ ...value.entries[0], path: "lib/a.js" });
    },
  ]);

  reject(x.crash, validateCrashPopulation, [
    (value) => {
      value.cases = [];
    },
    (value) => {
      value.cases[0].position = "during";
    },
    (value) => {
      value.cases[0].outcome = "lost";
    },
    (value) => {
      value.cases[0].failures = ["failure"];
    },
    (value) => {
      value.cases.push(clone(value.cases[0]));
    },
    (value) => {
      value.unrecoveredCount = 1;
    },
  ]);

  reject(x.concurrency, validateConcurrencyPopulation, [
    (value) => {
      value.cases = [];
    },
    (value) => {
      value.cases[0].kind = "race";
    },
    (value) => {
      value.cases[0].outcome = "refused";
    },
    (value) => {
      value.cases[0].failures = ["failure"];
    },
    (value) => {
      value.cases.push(clone(value.cases[0]));
    },
    (value) => {
      value.nonconvergentIdenticalCount = 1;
    },
  ]);

  reject(x.parser, validateParserPopulation, [
    (value) => {
      value.cases = [];
    },
    (value) => {
      value.cases[0].class = "xml";
    },
    (value) => {
      value.cases[0].observedCode = "OTHER_REFUSAL";
    },
    (value) => {
      value.cases[0].partialAcceptance = true;
    },
    (value) => {
      value.cases.push(clone(value.cases[0]));
    },
    (value) => {
      value.untypedRefusalCount = 1;
    },
  ]);

  reject(f.policy, validateQualityPolicyV4, [
    (value) => {
      value.noTestWeakeningWithBehaviorChange = false;
    },
    (value) => {
      value.evidenceCrosswalk.unit.ordinal = 99;
    },
    (value) => {
      value.evidenceCrosswalk.unit.notApplicableReasonCodes = ["illegal"];
    },
    (value) => {
      value.zeroFailureFloors.failed = 1;
    },
    (value) => {
      value.approvedToolchains = [];
    },
    (value) => {
      value.receiptSchemas.qualityPlan = "legacy";
    },
  ]);

  reject(f.plan, (value) => validatePhaseQualityPlanV4(value, f.policy), [
    (value) => {
      value.policySha256 = digest("other-policy");
    },
    (value) => {
      value.syntaxFiles = ["README.md"];
    },
    (value) => {
      value.layers.unit.layerId = "contract";
    },
    (value) => {
      value.layers.natural_cycle_qa.checkIds = ["illegal"];
    },
    (value) => {
      value.executionMatrix.repeatsPerCell = 4;
    },
    (value) => {
      value.coveragePlan.rawInputOrder = "filename";
    },
    (value) => {
      value.coveragePlan.lineFloorPercent = 96;
    },
    (value) => {
      value.mutationPlan.scoreFloorPercent = 91;
    },
    (value) => {
      value.operationalIntegrityPlan.candidateReadOnly = false;
    },
    (value) => {
      value.resourceLimits.maximumProcessCount = 0;
    },
  ]);

  const sameCredential = {
    issuer: "same-issuer",
    subject: "same-subject",
    credentialKind: "github_oidc_receipt",
    credentialSha256: digest("same-credential"),
    authorizing: false,
  };
  const collisionReview = clone(f.frozenReview);
  collisionReview.implementer = builders.authorityIdentity({
    role: "implementer",
    ...sameCredential,
  });
  collisionReview.certifier = builders.authorityIdentity({
    role: "certifier",
    ...sameCredential,
  });
  assertCode(
    () => validateFrozenReviewReceiptV1(collisionReview),
    "IDENTITY_COLLISION",
  );
  reject(f.frozenReview, validateFrozenReviewReceiptV1, [
    (value) => {
      value.postReviewManifest = artifact("different-review");
    },
    (value) => {
      value.certifierRuns = [];
    },
    (value) => {
      value.changedByteCount = 1;
    },
    (value) => {
      value.unresolvedBySeverity.severity2 = 1;
    },
    (value) => {
      value.status = "failed";
    },
    (value) => {
      value.recordedAt = "invalid";
    },
    (value) => {
      value.priorReviewReceiptHash = "bad";
    },
  ]);

  reject(
    f.quality,
    (value) => validateQualityReceiptV7(value, f.qualityContext),
    [
      (value) => {
        value.phaseBinding.qualityPlanSha256 = digest("stale-plan");
      },
      (value) => {
        value.thresholds.lineCoveragePercent = 96;
      },
      (value) => {
        value.layerResults.natural_cycle_qa =
          value.layerResults.production_shaped_rehearsal;
      },
      (value) => {
        value.operationalIntegrity.unchanged = false;
      },
    ],
  );
  assertCode(
    () => validateQualityReceiptV7(f.quality, {}),
    "QUALITY_CONTEXT_REQUIRED",
  );

  reject(
    f.candidate,
    (value) =>
      validateCandidateReceiptV3(value, {
        ...f.qualityContext,
        qualityReceipt: f.quality,
      }),
    [
      (value) => {
        value.previousReceiptHash = digest("previous");
      },
      (value) => {
        value.collector = value.controller;
      },
      (value) => {
        value.candidateTree = COMMIT_A;
      },
      (value) => {
        value.layerReceiptHashes.unit = digest("stale-layer");
      },
    ],
  );

  reject(
    f.attestation,
    (value) => validateAttestationBodyV3(value, f.attestationContext),
    [
    (value) => {
      value.judgeReceiptHashes.collector = value.judgeReceiptHashes.primary;
    },
    (value) => {
      value.productionAuthority = true;
    },
    ],
  );
});

test("mutation guard probes kill authority weakening at critical boundaries", () => {
  const f = makeFixture();
  const mutants = [
    () => {
      const value = clone(f.policy);
      value.noThresholdChangeWithBehaviorChange = false;
      return () => validateQualityPolicyV4(value);
    },
    () => {
      const value = clone(f.plan);
      value.resourceLimits.maximumRetries = 1;
      return () => validatePhaseQualityPlanV4(value, f.policy);
    },
    () => {
      const value = clone(f.quality);
      value.operationalIntegrity.unchanged = false;
      value.receiptHash = contract.hashWithoutField(value, "receiptHash");
      return () => validateQualityReceiptV7(value, f.qualityContext);
    },
    () => {
      const value = clone(f.attestation);
      value.productionAuthority = true;
      value.bodySha256 = contract.hashWithoutField(value, "bodySha256");
      return () => validateAttestationBodyV3(value, f.attestationContext);
    },
    () => {
      const value = clone(f.frozenReview);
      value.changedByteCount = 1;
      value.receiptHash = contract.hashWithoutField(value, "receiptHash");
      return () => validateFrozenReviewReceiptV1(value);
    },
    () => {
      const value = clone(f.candidate);
      value.previousReceiptHash = digest("previous");
      value.receiptHash = contract.hashWithoutField(value, "receiptHash");
      return () =>
        validateCandidateReceiptV3(value, {
          ...f.qualityContext,
          qualityReceipt: f.quality,
        });
    },
  ];
  assert.equal(mutants.length, 6);
  mutants.forEach((makeMutant) => assertContractError(makeMutant()));
});

test("source-level critical mutation gauntlet kills every named guard removal", () => {
  const f = makeFixture();
  const sourcePath = path.resolve(
    __dirname,
    "../lib/pikiio-quality-contract-v3.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pikiio-quality-v3-mutants-"),
  );

  const specs = [
    {
      id: "authority-preflight-removal",
      from:
        "if (value.authorizing === true) { // QUALITY_V3_MUTATION_ANCHOR_AUTHORITY_PREFLIGHT",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_AUTHORITY_PREFLIGHT",
      probe(moduleUnderTest) {
        const value = hostileAuthorityValue(
          f.quality,
          "coverage",
          "accessor",
          true,
        );
        assertCode(
          () => moduleUnderTest.validateQualityReceiptV7(value),
          "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
        );
      },
    },
    {
      id: "graph-depth-guard-removal",
      from:
        "if (depth > MAX_GRAPH_DEPTH) { // QUALITY_V3_MUTATION_ANCHOR_GRAPH_DEPTH",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_GRAPH_DEPTH",
      probe(moduleUnderTest) {
        const value = hostileAuthorityValue(
          f.quality,
          "coverage",
          "depth_20000",
          false,
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              value,
              f.qualityContext,
            ),
          "GRAPH_DEPTH_LIMIT_EXCEEDED",
        );
      },
    },
    {
      id: "calendar-timestamp-guard-removal",
      from:
        "if (calendarComponentsMismatch) { // QUALITY_V4_MUTATION_ANCHOR_CALENDAR_TIMESTAMP",
      to:
        "if (false) { // QUALITY_V4_MUTATION_ANCHOR_CALENDAR_TIMESTAMP",
      probe(moduleUnderTest) {
        const value = clone(
          f.quality.layerResults.natural_cycle_qa,
        );
        value.observedAt = "2026-02-30T00:00:00Z";
        assertCode(
          () => moduleUnderTest.builders.notApplicable(value),
          "INVALID_TIMESTAMP",
        );
      },
    },
    {
      id: "plan-disjointness-removal",
      from:
        "if (claims.has(value)) { // QUALITY_V3_MUTATION_ANCHOR_PLAN_DISJOINTNESS",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_PLAN_DISJOINTNESS",
      probe(moduleUnderTest) {
        const fields = clone(f.plan);
        delete fields.planSha256;
        fields.layers.contract.checkIds = clone(
          fields.layers.unit.checkIds,
        );
        assertCode(
          () => moduleUnderTest.builders.qualityPlan(fields, f.policy),
          "LAYER_CHECK_ID_COLLISION",
        );
      },
    },
    {
      id: "artifact-consumption-removal",
      from:
        "if (prior !== undefined) { // QUALITY_V3_MUTATION_ANCHOR_ARTIFACT_CONSUMPTION",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_ARTIFACT_CONSUMPTION",
      probe(moduleUnderTest) {
        const qualityFields = unsealQualityReceipt(f.quality);
        const layerFields = unsealLayerPass(
          f.quality.layerResults.contract,
        );
        layerFields.rawPopulationArtifact = clone(
          f.quality.layerResults.unit.rawPopulationArtifact,
        );
        qualityFields.layerResults.contract =
          moduleUnderTest.builders.layerPass(layerFields);
        assertCode(
          () =>
            moduleUnderTest.builders.qualityReceipt(
              qualityFields,
              f.qualityContext,
            ),
          "LAYER_ARTIFACT_ADDRESS_COLLISION",
        );
      },
    },
    {
      id: "frozen-review-artifact-binding-removal",
      from:
        "if (frozenReviewArtifactBindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_FROZEN_REVIEW_ARTIFACT_BINDING",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_FROZEN_REVIEW_ARTIFACT_BINDING",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        quality.independentFrozenHashReview.artifact = artifact(
          "mutant-unrelated-frozen-review",
        );
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "FROZEN_REVIEW_ARTIFACT_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "phase-registry-binding-removal",
      from:
        "if (phaseRegistryBindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_PHASE_REGISTRY_BINDING",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_PHASE_REGISTRY_BINDING",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        quality.phaseBinding.phaseProofRegistrySha256 = digest(
          "mutant-unrelated-phase-registry",
        );
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "QUALITY_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "candidate-quality-binding-removal",
      from:
        "if (candidateQualityBindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_CANDIDATE_QUALITY_BINDING",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_CANDIDATE_QUALITY_BINDING",
      probe(moduleUnderTest) {
        const candidate = clone(f.candidate);
        candidate.ledgerRevision += 1;
        candidate.receiptHash = moduleUnderTest.hashWithoutField(
          candidate,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateCandidateReceiptV3(candidate, {
              ...f.qualityContext,
              qualityReceipt: f.quality,
            }),
          "CANDIDATE_QUALITY_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "candidate-registry-revision-binding-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_REGISTRY_REVISION_BINDING",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_REGISTRY_REVISION_BINDING",
      probe(moduleUnderTest) {
        const candidate = clone(f.candidate);
        candidate.registryRevision = 999999;
        candidate.receiptHash = moduleUnderTest.hashWithoutField(
          candidate,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateCandidateReceiptV3(candidate, {
              ...f.qualityContext,
              qualityReceipt: f.quality,
            }),
          "CANDIDATE_REGISTRY_REVISION_MISMATCH",
        );
      },
    },
    {
      id: "candidate-controller-identity-binding-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_CONTROLLER_IDENTITY_BINDING",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_CONTROLLER_IDENTITY_BINDING",
      probe(moduleUnderTest) {
        const candidate = clone(f.candidate);
        candidate.controller = identity(
          "controller",
          "mutant-controller",
          false,
        );
        candidate.receiptHash = moduleUnderTest.hashWithoutField(
          candidate,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateCandidateReceiptV3(candidate, {
              ...f.qualityContext,
              qualityReceipt: f.quality,
            }),
          "CANDIDATE_CONTROLLER_IDENTITY_MISMATCH",
        );
      },
    },
    {
      id: "candidate-collector-identity-binding-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_COLLECTOR_IDENTITY_BINDING",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_COLLECTOR_IDENTITY_BINDING",
      probe(moduleUnderTest) {
        const candidate = clone(f.candidate);
        candidate.collector = identity(
          "collector",
          "mutant-collector",
          false,
        );
        candidate.receiptHash = moduleUnderTest.hashWithoutField(
          candidate,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateCandidateReceiptV3(candidate, {
              ...f.qualityContext,
              qualityReceipt: f.quality,
            }),
          "CANDIDATE_COLLECTOR_IDENTITY_MISMATCH",
        );
      },
    },
    {
      id: "not-applicable-tuple-binding-removal",
      from:
        "if (bindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_NA_TUPLE_BINDING",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_NA_TUPLE_BINDING",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        const result = quality.layerResults.natural_cycle_qa;
        result.policyRuleId = "rule-mutant-unrelated";
        result.receiptHash = moduleUnderTest.hashWithoutField(
          result,
          "receiptHash",
        );
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "NOT_APPLICABLE_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "not-applicable-restriction-removal",
      from: [
        "  if (!CONDITIONAL_LAYER_IDS.includes(layerId)) { // QUALITY_V3_MUTATION_ANCHOR_NA_RESTRICTION",
        "    fail(",
        '      "NOT_APPLICABLE_LOCAL_LAYER_REFUSED",',
        "      `${layerId} is a required local safety layer`,",
        "    );",
        "  }",
      ].join("\n"),
      to: [
        "  if (!CONDITIONAL_LAYER_IDS.includes(layerId)) { // QUALITY_V3_MUTATION_ANCHOR_NA_RESTRICTION",
        "    return;",
        "  }",
      ].join("\n"),
      probe(moduleUnderTest) {
        const fields = clone(
          f.quality.layerResults.natural_cycle_qa,
        );
        delete fields.schema;
        delete fields.receiptHash;
        fields.layerId = "unit";
        assertCode(
          () => moduleUnderTest.builders.notApplicable(fields),
          "NOT_APPLICABLE_LOCAL_LAYER_REFUSED",
        );
      },
    },
    {
      id: "legacy-refusal-removal",
      from:
        "if (code !== null) { // QUALITY_V3_MUTATION_ANCHOR_LEGACY_REFUSAL",
      to:
        "if (false) { // QUALITY_V3_MUTATION_ANCHOR_LEGACY_REFUSAL",
      probe(moduleUnderTest) {
        assertCode(
          () =>
            moduleUnderTest.validateQualityPolicyV4({
              schema: "pikiio-quality-gauntlet-v2",
            }),
          "QUALITY_POLICY_V2_REFUSED",
        );
      },
    },
    {
      id: "envelope-capacity-removal",
      from:
        "    ) { // QUALITY_V4_MUTATION_ANCHOR_ENVELOPE_CAPACITY",
      to:
        "      && false\n    ) { // QUALITY_V4_MUTATION_ANCHOR_ENVELOPE_CAPACITY",
      probe(moduleUnderTest) {
        const policy = clone(f.policy);
        policy.resourceCeilings.maximumByteStreamEnvelopeBytes = 1398206;
        assertCode(
          () => moduleUnderTest.validateQualityPolicyV4(policy),
          "BYTE_STREAM_ENVELOPE_CAPACITY_EXCEEDED",
        );
      },
    },
    {
      id: "cartesian-count-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_CARTESIAN_COUNT",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_CARTESIAN_COUNT",
      probe(moduleUnderTest) {
        const plan = clone(f.plan);
        plan.executionMatrix.expectedExecutionCount -= 1;
        assertCode(
          () => moduleUnderTest.validatePhaseQualityPlanV4(plan, f.policy),
          "EXECUTION_MATRIX_COUNT_MISMATCH",
        );
      },
    },
    {
      id: "plan-artifact-policy-binding-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_PLAN_ARTIFACT_POLICY_BINDING",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_PLAN_ARTIFACT_POLICY_BINDING",
      probe(moduleUnderTest) {
        const policyFields = clone(f.policy);
        policyFields.artifactPolicySha256 = digest(
          "mutant-alternate-artifact-policy",
        );
        const policy = moduleUnderTest.builders.qualityPolicy(policyFields);
        const plan = clone(f.plan);
        plan.policySha256 = policy.policySha256;
        assertCode(
          () => moduleUnderTest.builders.qualityPlan(plan, policy),
          "ARTIFACT_POLICY_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "producer-result-boundary-removal",
      from: [
        "      if (",
        "        entry.producerOutputSchema !== crosswalk.producerOutputSchema ||",
        "        entry.layerResultSchema !== crosswalk.layerResultSchema ||",
        "        entry.producerOutputSchema === entry.layerResultSchema",
        "      ) { // QUALITY_V4_MUTATION_ANCHOR_PRODUCER_RESULT_BOUNDARY",
      ].join("\n"),
      to:
        "      if (false) { // QUALITY_V4_MUTATION_ANCHOR_PRODUCER_RESULT_BOUNDARY",
      probe(moduleUnderTest) {
        const plan = clone(f.plan);
        plan.layers.unit.producerOutputSchema =
          moduleUnderTest.PRODUCER_OUTPUT_SCHEMAS.contract;
        assertCode(
          () => moduleUnderTest.validatePhaseQualityPlanV4(plan, f.policy),
          "LAYER_SCHEMA_BOUNDARY_MISMATCH",
        );
      },
    },
    {
      id: "resource-ceiling-removal",
      from:
        "    ) { // QUALITY_V4_MUTATION_ANCHOR_RESOURCE_CEILING",
      to:
        "      && false\n    ) { // QUALITY_V4_MUTATION_ANCHOR_RESOURCE_CEILING",
      probe(moduleUnderTest) {
        const plan = clone(f.plan);
        plan.resourceLimits.maximumProcessCount += 1;
        assertCode(
          () => moduleUnderTest.validatePhaseQualityPlanV4(plan, f.policy),
          "RESOURCE_CEILING_EXCEEDED",
        );
      },
    },
    {
      id: "specialized-artifact-equality-removal",
      from:
        "      ) { // QUALITY_V4_MUTATION_ANCHOR_SPECIALIZED_ARTIFACT_EQUALITY",
      to:
        "        && false\n      ) { // QUALITY_V4_MUTATION_ANCHOR_SPECIALIZED_ARTIFACT_EQUALITY",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        quality.coverage = artifact("mutant-unrelated-coverage");
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "SPECIALIZED_ARTIFACT_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "controller-only-alias-removal",
      from: [
        "      if (",
        "        layerOutputAddresses.has(reference.address) ||",
        "        controllerAddresses.has(reference.address)",
        "      ) { // QUALITY_V4_MUTATION_ANCHOR_CONTROLLER_ONLY_ALIAS",
      ].join("\n"),
      to:
        "      if (false) { // QUALITY_V4_MUTATION_ANCHOR_CONTROLLER_ONLY_ALIAS",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        quality.antiWeakening = clone(
          quality.layerResults.unit.outputArtifacts[0],
        );
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "CONTROLLER_ONLY_ARTIFACT_ALIAS",
        );
      },
    },
    {
      id: "quality-artifact-policy-binding-removal",
      from: [
        "  if (",
        "    value.artifactPolicySha256 !== policy.artifactPolicySha256 ||",
        "    value.artifactPolicySha256 !== plan.artifactPolicySha256",
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_QUALITY_ARTIFACT_POLICY_BINDING",
      ].join("\n"),
      to:
        "  if (false) { // QUALITY_V4_MUTATION_ANCHOR_QUALITY_ARTIFACT_POLICY_BINDING",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        quality.artifactPolicySha256 = digest(
          "mutant-quality-artifact-policy",
        );
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "ARTIFACT_POLICY_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "cartesian-proof-removal",
      from: [
        "  if (",
        "    value.executionMatrix.matrixSha256 !== plan.executionMatrix.matrixSha256 ||",
        "    value.executionMatrix.expectedExecutionCount !==",
        "      plan.executionMatrix.expectedExecutionCount ||",
        "    value.executionMatrix.observedExecutionCount !==",
        "      value.executionMatrix.expectedExecutionCount ||",
        "    value.executionMatrix.missingCoordinateCount !== 0 ||",
        "    value.executionMatrix.duplicateCoordinateCount !== 0 ||",
        "    value.executionMatrix.divergentCoordinateCount !== 0 ||",
        "    value.layerResults.deterministic_repeat.executions.length !==",
        "      value.executionMatrix.observedExecutionCount ||",
        "    value.layerResults.deterministic_repeat.minimumCasesObserved !==",
        "      value.executionMatrix.observedExecutionCount",
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_CARTESIAN_PROOF",
      ].join("\n"),
      to:
        "  if (false) { // QUALITY_V4_MUTATION_ANCHOR_CARTESIAN_PROOF",
      probe(moduleUnderTest) {
        const quality = clone(f.quality);
        quality.executionMatrix.missingCoordinateCount = 1;
        quality.receiptHash = moduleUnderTest.hashWithoutField(
          quality,
          "receiptHash",
        );
        assertCode(
          () =>
            moduleUnderTest.validateQualityReceiptV7(
              quality,
              f.qualityContext,
            ),
          "EXECUTION_MATRIX_PROOF_INVALID",
        );
      },
    },
    {
      id: "attestation-artifact-policy-binding-removal",
      from:
        "  if (attestationChainMismatch) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_ARTIFACT_POLICY_BINDING",
      to:
        "  if (false) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_ARTIFACT_POLICY_BINDING",
      probe(moduleUnderTest) {
        const attestation = clone(f.attestation);
        attestation.artifactPolicySha256 = digest(
          "mutant-attestation-artifact-policy",
        );
        attestation.bodySha256 = moduleUnderTest.hashWithoutField(
          attestation,
          "bodySha256",
        );
        assertCode(
          () =>
            moduleUnderTest.validateAttestationBodyV3(
              attestation,
              f.attestationContext,
            ),
          "ATTESTATION_QUALITY_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "attestation-role-principal-binding-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_ROLE_PRINCIPAL_BINDING",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_ROLE_PRINCIPAL_BINDING",
      probe(moduleUnderTest) {
        const attestation = clone(f.attestation);
        attestation.rolePrincipalHashes.implementer = digest(
          "mutant-attestation-implementer",
        );
        attestation.bodySha256 = moduleUnderTest.hashWithoutField(
          attestation,
          "bodySha256",
        );
        assertCode(
          () =>
            moduleUnderTest.validateAttestationBodyV3(
              attestation,
              f.attestationContext,
            ),
          "ATTESTATION_ROLE_PRINCIPAL_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "attestation-judge-receipt-binding-removal",
      from:
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_JUDGE_RECEIPT_BINDING",
      to:
        "    && false\n  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_JUDGE_RECEIPT_BINDING",
      probe(moduleUnderTest) {
        const attestation = clone(f.attestation);
        const forgedHash = digest("mutant-attestation-primary");
        attestation.judgeReceiptHashes.primary = forgedHash;
        attestation.artifacts.primaryRaw = artifactFromHash(
          forgedHash,
          "mutant-primary",
        );
        attestation.bodySha256 = moduleUnderTest.hashWithoutField(
          attestation,
          "bodySha256",
        );
        assertCode(
          () =>
            moduleUnderTest.validateAttestationBodyV3(
              attestation,
              f.attestationContext,
            ),
          "ATTESTATION_JUDGE_RECEIPT_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "attestation-evidence-manifest-binding-removal",
      from: [
        "  if (",
        "    value.evidenceManifestSha256 !==",
        "      candidate.rawEvidenceManifestSha256 ||",
        "    value.evidenceManifestSha256 !== quality.rawEvidenceManifest.sha256",
        "  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_EVIDENCE_MANIFEST_BINDING",
      ].join("\n"),
      to:
        "  if (false) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_EVIDENCE_MANIFEST_BINDING",
      probe(moduleUnderTest) {
        const attestation = clone(f.attestation);
        const forgedHash = digest(
          "mutant-attestation-evidence-manifest",
        );
        attestation.evidenceManifestSha256 = forgedHash;
        attestation.artifacts.evidenceManifest = artifactFromHash(
          forgedHash,
          "mutant-evidence-manifest",
        );
        attestation.bodySha256 = moduleUnderTest.hashWithoutField(
          attestation,
          "bodySha256",
        );
        assertCode(
          () =>
            moduleUnderTest.validateAttestationBodyV3(
              attestation,
              f.attestationContext,
            ),
          "ATTESTATION_EVIDENCE_MANIFEST_BINDING_MISMATCH",
        );
      },
    },
    {
      id: "attestation-external-evidence-binding-removal",
      from:
        "if (attestationEvidenceContextMismatch) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_EXTERNAL_EVIDENCE_BINDING",
      to:
        "if (false) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_EXTERNAL_EVIDENCE_BINDING",
      probe(moduleUnderTest) {
        const attestation = clone(f.attestation);
        const forgedHash = digest("mutant-attestation-source-manifest");
        attestation.sourceManifestSha256 = forgedHash;
        attestation.artifacts.sourceManifest = artifactFromHash(
          forgedHash,
          "mutant-source-manifest",
        );
        attestation.bodySha256 = moduleUnderTest.hashWithoutField(
          attestation,
          "bodySha256",
        );
        assertCode(
          () =>
            moduleUnderTest.validateAttestationBodyV3(
              attestation,
              f.attestationContext,
            ),
          "ATTESTATION_EVIDENCE_CONTEXT_MISMATCH",
        );
      },
    },
    {
      id: "central-proxy-refusal-removal",
      from:
        "if (isProxy(value)) { // QUALITY_V4_MUTATION_ANCHOR_PROXY_REFUSAL",
      to:
        "if (false) { // QUALITY_V4_MUTATION_ANCHOR_PROXY_REFUSAL",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          function centralProxyCallable() {},
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (value) => moduleUnderTest.stableJson(value),
          proxied.value,
          proxied.counter,
          "central proxy guard mutant",
        );
      },
    },
    {
      id: "recursive-proxy-guard-removal",
      from:
        "  refuseProxy(value, label); // QUALITY_V4_MUTATION_ANCHOR_RECURSIVE_PROXY_GUARD",
      to:
        "  void value; // QUALITY_V4_MUTATION_ANCHOR_RECURSIVE_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          function recursiveProxyCallable() {},
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (value) => moduleUnderTest.stableJson({ nested: value }),
          proxied.value,
          proxied.counter,
          "recursive proxy guard mutant",
        );
      },
    },
    {
      id: "shallow-root-proxy-guard-removal",
      from: [
        "  refuseProxy(",
        "    value,",
        "    label,",
        "  ); // QUALITY_V4_MUTATION_ANCHOR_SHALLOW_ROOT_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void value; // QUALITY_V4_MUTATION_ANCHOR_SHALLOW_ROOT_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(clone(f.quality), {
          throwing: true,
        });
        assertProxyRefusedWithoutTrap(
          (value) =>
            moduleUnderTest.validateQualityReceiptV7(
              value,
              f.qualityContext,
            ),
          proxied.value,
          proxied.counter,
          "shallow root proxy guard mutant",
        );
      },
    },
    {
      id: "quality-context-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    context,",
        '    "quality receipt validation context",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_QUALITY_CONTEXT_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void context; // QUALITY_V4_MUTATION_ANCHOR_QUALITY_CONTEXT_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy({}, { throwing: true });
        const context = {
          ...f.qualityContext,
          ignoredProxy: proxied.value,
        };
        assertProxyRefusedWithoutTrap(
          (value) =>
            moduleUnderTest.validateQualityReceiptV7(f.quality, value),
          context,
          proxied.counter,
          "quality context proxy guard mutant",
        );
      },
    },
    {
      id: "candidate-context-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    context,",
        '    "candidate validation context",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_CONTEXT_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void context; // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_CONTEXT_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy([], { throwing: true });
        const context = {
          ...f.qualityContext,
          qualityReceipt: f.quality,
          ignoredProxy: proxied.value,
        };
        assertProxyRefusedWithoutTrap(
          (value) =>
            moduleUnderTest.validateCandidateReceiptV3(
              f.candidate,
              value,
            ),
          context,
          proxied.counter,
          "candidate context proxy guard mutant",
        );
      },
    },
    {
      id: "attestation-context-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    context,",
        '    "attestation validation context",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_CONTEXT_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void context; // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_CONTEXT_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy({}, { throwing: true });
        const context = {
          ...f.attestationContext,
          ignoredProxy: proxied.value,
        };
        assertProxyRefusedWithoutTrap(
          (value) =>
            moduleUnderTest.validateAttestationBodyV3(
              f.attestation,
              value,
            ),
          context,
          proxied.counter,
          "attestation context proxy guard mutant",
        );
      },
    },
    {
      id: "hash-without-field-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    value,",
        '    "hashWithoutField input",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_HASH_WITHOUT_FIELD_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void value; // QUALITY_V4_MUTATION_ANCHOR_HASH_WITHOUT_FIELD_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          { retained: true },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (value) => moduleUnderTest.hashWithoutField(value, "omitted"),
          proxied.value,
          proxied.counter,
          "hashWithoutField proxy guard mutant",
        );
      },
    },
    {
      id: "semantic-hash-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    value,",
        '    "semanticHashWithoutField input",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_SEMANTIC_HASH_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void value; // QUALITY_V4_MUTATION_ANCHOR_SEMANTIC_HASH_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          { retained: true },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (value) =>
            moduleUnderTest.semanticHashWithoutField(value, "omitted"),
          proxied.value,
          proxied.counter,
          "semanticHashWithoutField proxy guard mutant",
        );
      },
    },
    {
      id: "layer-hash-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    value,",
        '    "layerSemanticHash input",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_LAYER_HASH_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void value; // QUALITY_V4_MUTATION_ANCHOR_LAYER_HASH_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          { retained: true },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (value) => moduleUnderTest.layerSemanticHash(value),
          proxied.value,
          proxied.counter,
          "layerSemanticHash proxy guard mutant",
        );
      },
    },
    {
      id: "sha256-byte-proxy-guard-removal",
      from:
        '  refuseProxy(value, "sha256 input"); // QUALITY_V4_MUTATION_ANCHOR_SHA256_PROXY_GUARD',
      to:
        "  void value; // QUALITY_V4_MUTATION_ANCHOR_SHA256_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          Buffer.from("sha256-mutant"),
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (value) => moduleUnderTest.sha256(value),
          proxied.value,
          proxied.counter,
          "sha256 byte proxy guard mutant",
        );
      },
    },
    {
      id: "hash-field-proxy-guard-removal",
      from: [
        '  refuseProxy(field, "hashWithoutField field");',
        "  requireString(",
        "    field,",
        '    "hashWithoutField field",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_HASH_FIELD_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void field; // QUALITY_V4_MUTATION_ANCHOR_HASH_FIELD_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          {
            [Symbol.toPrimitive]() {
              return "omitted";
            },
          },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (field) =>
            moduleUnderTest.hashWithoutField(
              { retained: true },
              field,
            ),
          proxied.value,
          proxied.counter,
          "hashWithoutField field proxy guard mutant",
        );
      },
    },
    {
      id: "semantic-hash-field-proxy-guard-removal",
      from: [
        '  refuseProxy(field, "semanticHashWithoutField field");',
        "  requireString(",
        "    field,",
        '    "semanticHashWithoutField field",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_SEMANTIC_HASH_FIELD_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void field; // QUALITY_V4_MUTATION_ANCHOR_SEMANTIC_HASH_FIELD_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          {
            [Symbol.toPrimitive]() {
              return "omitted";
            },
          },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (field) =>
            moduleUnderTest.semanticHashWithoutField(
              { retained: true },
              field,
            ),
          proxied.value,
          proxied.counter,
          "semanticHashWithoutField field proxy guard mutant",
        );
      },
    },
    {
      id: "quality-plan-context-proxy-guard-removal",
      from: [
        "  assertPlainGraph(",
        "    policy,",
        '    "quality plan policy context",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_QUALITY_PLAN_CONTEXT_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void policy; // QUALITY_V4_MUTATION_ANCHOR_QUALITY_PLAN_CONTEXT_PROXY_GUARD",
      probe(moduleUnderTest) {
        const hostilePlan = clone(f.plan);
        Object.defineProperty(hostilePlan, "phaseId", {
          enumerable: true,
          configurable: true,
          get() {
            throw new Error("hostile plan getter executed");
          },
        });
        const proxied = instrumentedProxy(
          clone(f.policy),
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (policy) =>
            moduleUnderTest.validatePhaseQualityPlanV4(
              hostilePlan,
              policy,
            ),
          proxied.value,
          proxied.counter,
          "quality plan context proxy guard mutant",
        );
      },
    },
    {
      id: "artifact-label-proxy-guard-removal",
      from: [
        '  refuseProxy(label, "artifact reference label");',
        "  requireString(",
        "    label,",
        '    "artifact reference label",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_ARTIFACT_LABEL_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void label; // QUALITY_V4_MUTATION_ANCHOR_ARTIFACT_LABEL_PROXY_GUARD",
      probe(moduleUnderTest) {
        const invalidArtifact = clone(f.shared);
        invalidArtifact.byteLength = 0;
        const proxied = instrumentedProxy(
          {
            [Symbol.toPrimitive]() {
              return "mutant-artifact-label";
            },
          },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (label) =>
            moduleUnderTest.validateArtifactRef(invalidArtifact, label),
          proxied.value,
          proxied.counter,
          "artifact label proxy guard mutant",
        );
      },
    },
    {
      id: "identity-expected-role-proxy-guard-removal",
      from: [
        '  refuseProxy(expectedRole, "identity expectedRole");',
        "  if (expectedRole !== null) {",
        '    requireString(expectedRole, "identity expectedRole", {',
        "      pattern: SAFE_ID_PATTERN,",
        "    });",
        "  } // QUALITY_V4_MUTATION_ANCHOR_IDENTITY_EXPECTED_ROLE_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void expectedRole; // QUALITY_V4_MUTATION_ANCHOR_IDENTITY_EXPECTED_ROLE_PROXY_GUARD",
      probe(moduleUnderTest) {
        const proxied = instrumentedProxy(
          {
            [Symbol.toPrimitive]() {
              return f.identities.implementer.role;
            },
          },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (expectedRole) =>
            moduleUnderTest.validateAuthorityIdentity(
              f.identities.implementer,
              expectedRole,
              "identity",
            ),
          proxied.value,
          proxied.counter,
          "identity expectedRole proxy guard mutant",
        );
      },
    },
    {
      id: "identity-label-proxy-guard-removal",
      from: [
        '  refuseProxy(label, "identity label");',
        "  requireString(",
        "    label,",
        '    "identity label",',
        "  ); // QUALITY_V4_MUTATION_ANCHOR_IDENTITY_LABEL_PROXY_GUARD",
      ].join("\n"),
      to:
        "  void label; // QUALITY_V4_MUTATION_ANCHOR_IDENTITY_LABEL_PROXY_GUARD",
      probe(moduleUnderTest) {
        const invalidIdentity = clone(f.identities.implementer);
        invalidIdentity.role = "";
        const proxied = instrumentedProxy(
          {
            [Symbol.toPrimitive]() {
              return "mutant-identity-label";
            },
          },
          { throwing: true },
        );
        assertProxyRefusedWithoutTrap(
          (label) =>
            moduleUnderTest.validateAuthorityIdentity(
              invalidIdentity,
              null,
              label,
            ),
          proxied.value,
          proxied.counter,
          "identity label proxy guard mutant",
        );
      },
    },
  ];

  const namedAnchors =
    source.match(/QUALITY_(?:V3|V4)_MUTATION_ANCHOR_[A-Z0-9_]+/g) || [];
  assert.equal(namedAnchors.length, specs.length);
  assert.equal(new Set(namedAnchors).size, namedAnchors.length);
  assert.equal(specs.length, 44);
  const killed = [];
  const survived = [];
  try {
    for (const spec of specs) {
      assert.doesNotThrow(() => spec.probe(contract));
      assert.equal(
        source.split(spec.from).length - 1,
        1,
        `${spec.id} must have exactly one source anchor`,
      );
      const mutantPath = path.join(
        temporaryDirectory,
        `${spec.id}.js`,
      );
      fs.writeFileSync(mutantPath, source.replace(spec.from, spec.to));
      const mutant = require(mutantPath);
      try {
        spec.probe(mutant);
        survived.push(spec.id);
      } catch (error) {
        assert.equal(
          error?.code,
          "ERR_ASSERTION",
          `${spec.id} produced a non-causal mutation failure`,
        );
        assert.match(
          String(error?.stack || ""),
          /assertCode|assertProxyRefusedWithoutTrap/,
          `${spec.id} failed outside its exact behavioral fingerprint`,
        );
        killed.push(spec.id);
      }
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  assert.deepEqual(survived, []);
  assert.deepEqual(
    killed,
    specs.map((spec) => spec.id),
  );
  assert.equal((killed.length * 100) / specs.length, 100);
});

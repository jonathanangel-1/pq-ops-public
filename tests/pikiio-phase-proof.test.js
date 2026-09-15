"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { after, before, describe, test } = require("node:test");

const {
  CANONICAL_REGISTRY_SHA256,
  PHASE_IDS,
  PhaseProofError,
  classifyChangedPaths,
  computeAuthoritySnapshot,
  expectedAssertions,
  hashWithoutField,
  loadPhaseProofRegistry,
  phaseProofForId,
  sha256,
  sourceCutSetSha256,
  stableJson,
  validatePhaseCandidateReceipt,
  validatePhaseProofChain,
  validatePhaseProofRegistry,
  validatePhaseRehearsalAuthorization,
  validateReferencedPhaseAuthorities,
} = require("../lib/pikiio-phase-proof");

const BASE_PROFILE = Object.freeze({
  minimumUnitTestsPerRun: 123,
  minimumCriticalMutationPopulation: 63,
  minimumGherkinScenarioPopulation: 31,
});
const REGISTRY_PATH = path.join(
  __dirname,
  "..",
  "YLYI",
  "00_Product_Contract",
  "Pikiio_Phase_Proof_Registry.json",
);
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
const temporaryRoots = [];
const fixtures = new Map();

function runGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commitAll(root, message) {
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function makeIdentity(id, kind) {
  const identity = { id, kind, version: "1.0.0" };
  identity.identitySha256 = sha256(stableJson(identity));
  return identity;
}

function addArtifact(artifacts, value) {
  const bytes = Buffer.from(stableJson(value), "utf8");
  const digest = sha256(bytes);
  const address = `sha256:${digest}`;
  artifacts.set(address, bytes);
  return { address, sha256: digest };
}

function finishReceipt(receipt) {
  receipt.receiptHash = hashWithoutField(receipt);
  return receipt;
}

function commonReceipt(context, observedAt) {
  return {
    phaseId: context.phaseId,
    registryRevision: registry.revision,
    registrySha256: CANONICAL_REGISTRY_SHA256,
    ledgerRevision: context.ledgerRevision,
    candidateCommit: context.candidateCommit,
    candidateTree: context.candidateTree,
    observedAt,
    controller: makeIdentity("controller-alpha", "controller"),
    collector: makeIdentity("collector-beta", "collector"),
  };
}

function truthyAssertionValues(phase, evidence = null) {
  const values = expectedAssertions(phase, evidence);
  for (const assertion of phase.promotionAssertions) {
    if (evidence !== null && assertion.evidence !== evidence) continue;
    if (assertion.operator === "gte") values[assertion.id] = assertion.expected;
    if (assertion.operator === "lte") values[assertion.id] = assertion.expected;
  }
  return values;
}

function classifiedRuntimePath(phaseId) {
  return {
    "GOV-00": "scripts/live-refresh.js",
    "TRUTH-01": "lib/truth-candidate-runtime.js",
    "TRUTH-02": "lib/truth-soak-runtime.js",
    "ACTION-01": "lib/action-planner.js",
    "ACTION-02": "lib/action-shadow-runtime.js",
    "ACTION-03": "app.js",
  }[phaseId];
}

function makeRepository(phaseId, { changeAuthority = false } = {}) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-phase-proof-")),
  );
  temporaryRoots.push(root);
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "proof@example.invalid"]);
  runGit(root, ["config", "user.name", "Pikiio Proof"]);
  const phase = registry.phases[phaseId];
  for (const relativePath of phase.authorityFiles) {
    write(root, relativePath, `judge:${phaseId}:${relativePath}\n`);
  }
  write(root, "README.md", `${phaseId} fixture\n`);
  const baseCommit = commitAll(root, "authority baseline");
  if (changeAuthority) {
    write(
      root,
      phase.authorityFiles[0],
      `mutated-judge:${phaseId}:${phase.authorityFiles[0]}\n`,
    );
  }
  const runtimePath = classifiedRuntimePath(phaseId);
  write(root, runtimePath, `candidate:${phaseId}\n`);
  const candidateCommit = commitAll(root, "candidate runtime");
  const candidateTree = runGit(root, ["rev-parse", `${candidateCommit}^{tree}`]);
  return { root, baseCommit, candidateCommit, candidateTree, runtimePath };
}

function makeProductionReceipt(
  context,
  kind,
  previousReceiptHash,
  observedAt,
  deploymentId,
) {
  const policyKey =
    kind === "rehearsal" ? "productionRehearsal" : "productionChange";
  const required = context.phase.receiptPolicy[policyKey] === "required";
  const receipt = {
    schema:
      kind === "rehearsal"
        ? "pikiio-phase-production-rehearsal-receipt-v1"
        : "pikiio-phase-production-change-receipt-v1",
    ...commonReceipt(context, observedAt),
    previousReceiptHash,
    disposition: required ? "passed" : "not_applicable",
    deploymentId,
  };
  if (!required) {
    receipt.reason = "phase policy forbids this production operation";
    receipt.rawArtifact = null;
    return finishReceipt(receipt);
  }
  receipt.rollbackVerified = true;
  receipt.externalEffects = [];
  if (kind === "change") {
    receipt.deployedCommit = context.candidateCommit;
    receipt.deployedTree = context.candidateTree;
    receipt.rollbackReference = "rollback:immutable-prior-deployment";
  }
  receipt.rawArtifact = addArtifact(context.artifacts, {
    schema:
      kind === "rehearsal"
        ? "pikiio-production-rehearsal-raw-artifact-v1"
        : "pikiio-production-change-raw-artifact-v1",
    ...commonReceipt(context, observedAt),
    deploymentId,
    rollbackVerified: true,
    externalEffects: [],
    ...(kind === "change"
      ? {
          deployedCommit: context.candidateCommit,
          deployedTree: context.candidateTree,
          rollbackReference: receipt.rollbackReference,
        }
      : {}),
  });
  return finishReceipt(receipt);
}

function makeNaturalEvidence(
  context,
  sourceCuts,
  deploymentId,
  observedAt,
  index,
) {
  const receipt = {
    schema: "pikiio-phase-natural-evidence-v1",
    ...commonReceipt(context, observedAt),
    deploymentId,
    sourceCuts,
    sourceCutSetSha256: sourceCutSetSha256(sourceCuts),
    evidenceId: `natural-${index}`,
    cycleId: `cycle-${index}`,
    natural: true,
    result: "passed",
    assertions: truthyAssertionValues(context.phase, "natural"),
  };
  receipt.rawArtifact = addArtifact(context.artifacts, {
    schema: "pikiio-natural-raw-artifact-v1",
    ...commonReceipt(context, observedAt),
    deploymentId,
    sourceCuts,
    sourceCutSetSha256: receipt.sourceCutSetSha256,
    assertions: receipt.assertions,
    evidenceId: receipt.evidenceId,
    cycleId: receipt.cycleId,
    natural: true,
    result: "passed",
  });
  return finishReceipt(receipt);
}

function makeBrowserEvidence(
  context,
  sourceCuts,
  deploymentId,
  observedAt,
  index,
) {
  const state = { shipments: [{ awb: "014-80000010", phase: "delivered" }] };
  const stateSha256 = sha256(stableJson(state));
  const receipt = {
    schema: "pikiio-phase-browser-evidence-v1",
    ...commonReceipt(context, observedAt),
    deploymentId,
    sourceCuts,
    sourceCutSetSha256: sourceCutSetSha256(sourceCuts),
    evidenceId: `browser-${index}`,
    agrees: true,
    assertions: truthyAssertionValues(context.phase, "browser"),
    apiStateSha256: stateSha256,
    browserStateSha256: stateSha256,
  };
  receipt.rawArtifact = addArtifact(context.artifacts, {
    schema: "pikiio-browser-raw-artifact-v1",
    ...commonReceipt(context, observedAt),
    deploymentId,
    sourceCuts,
    sourceCutSetSha256: receipt.sourceCutSetSha256,
    assertions: receipt.assertions,
    evidenceId: receipt.evidenceId,
    agrees: true,
    apiState: state,
    browserState: state,
  });
  return finishReceipt(receipt);
}

function makeFixture(
  phaseId,
  { changeAuthority = false, observationSpanMs = null } = {},
) {
  const repository = makeRepository(phaseId, { changeAuthority });
  const phase = registry.phases[phaseId];
  const ledgerRevision = 7;
  const artifacts = new Map();
  const authoritySnapshot = computeAuthoritySnapshot({
    repoRoot: repository.root,
    commit: repository.candidateCommit,
    phaseId,
    registry,
  });
  const baselineCommit = repository.baseCommit;
  const baselineSnapshot = computeAuthoritySnapshot({
    repoRoot: repository.root,
    commit: baselineCommit,
    phaseId,
    registry,
  });
  const coverage = classifyChangedPaths({
    registry,
    phaseId,
    changedPaths: [repository.runtimePath],
  });
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const context = {
    phaseId,
    phase,
    ledgerRevision,
    candidateCommit: repository.candidateCommit,
    candidateTree: repository.candidateTree,
    artifacts,
  };
  const candidate = {
    schema: "pikiio-phase-candidate-quality-receipt-v1",
    ...commonReceipt(context, new Date(start).toISOString()),
    status: "passed",
    previousReceiptHash: null,
    qualityIds: phase.qualityIds,
    populations: {
      unitTests: Math.max(phase.populationFloors.unitTests, 123),
      criticalMutants: Math.max(phase.populationFloors.criticalMutants, 63),
      gherkinScenarios: Math.max(phase.populationFloors.gherkinScenarios, 31),
    },
    authorityBaselineCommit: baselineCommit,
    authorityBaselineSnapshotHash: baselineSnapshot.snapshotHash,
    authoritySnapshot,
    changedPaths: [repository.runtimePath],
    changedPathCoverage: coverage,
    assertions: truthyAssertionValues(phase, "candidate"),
  };
  candidate.rawArtifact = addArtifact(artifacts, {
    schema: "pikiio-candidate-quality-raw-artifact-v1",
    ...commonReceipt(context, candidate.observedAt),
    authorityBaselineCommit: baselineCommit,
    authorityBaselineSnapshotHash: baselineSnapshot.snapshotHash,
    authoritySetSha256: authoritySnapshot.authoritySetSha256,
    changedPathCoverageSha256: coverage.coverageSha256,
    qualityIds: phase.qualityIds,
    populations: candidate.populations,
    assertions: candidate.assertions,
  });
  finishReceipt(candidate);

  const rehearsalDeployment =
    phase.receiptPolicy.productionMode === "none" ? "none" : "deployment-123";
  const rehearsal = makeProductionReceipt(
    context,
    "rehearsal",
    candidate.receiptHash,
    new Date(start + 1000).toISOString(),
    rehearsalDeployment,
  );
  const changeDeployment =
    phase.receiptPolicy.deploymentBinding === "change"
      ? rehearsalDeployment
      : phase.receiptPolicy.deploymentBinding === "rehearsal"
        ? rehearsalDeployment
        : "none";
  const change = makeProductionReceipt(
    context,
    "change",
    rehearsal.receiptHash,
    new Date(start + 2000).toISOString(),
    changeDeployment,
  );

  const requiredSpan =
    observationSpanMs ?? phase.receiptPolicy.minimumObservationSpanMs;
  const sourceCuts =
    phase.receiptPolicy.minimumNaturalEvidence > 0 ||
    phase.receiptPolicy.minimumBrowserEvidence > 0
      ? [
          {
            source: "tms",
            id: "cut-tms-1",
            sha256: "a".repeat(64),
            capturedAt: new Date(start).toISOString(),
          },
          {
            source: "tracking",
            id: "cut-tracking-1",
            sha256: "b".repeat(64),
            capturedAt: new Date(start).toISOString(),
          },
        ]
      : [];
  const evidenceStart = start + 3000;
  const naturalEvidence = [];
  for (let index = 0; index < phase.receiptPolicy.minimumNaturalEvidence; index += 1) {
    const offset =
      index === phase.receiptPolicy.minimumNaturalEvidence - 1
        ? requiredSpan
        : 0;
    naturalEvidence.push(
      makeNaturalEvidence(
        context,
        sourceCuts,
        changeDeployment,
        new Date(evidenceStart + offset).toISOString(),
        index,
      ),
    );
  }
  const browserEvidence = [];
  for (let index = 0; index < phase.receiptPolicy.minimumBrowserEvidence; index += 1) {
    browserEvidence.push(
      makeBrowserEvidence(
        context,
        sourceCuts,
        changeDeployment,
        new Date(evidenceStart + requiredSpan).toISOString(),
        index,
      ),
    );
  }
  const promotionObservedAt = new Date(
    evidenceStart + requiredSpan + 1000,
  ).toISOString();
  const promotion = {
    schema: "pikiio-phase-promotion-evidence-receipt-v1",
    ...commonReceipt(context, promotionObservedAt),
    previousReceiptHash: change.receiptHash,
    disposition: "passed",
    deploymentId: changeDeployment,
    sourceCuts,
    sourceCutSetSha256: sourceCutSetSha256(sourceCuts),
    assertions: truthyAssertionValues(phase),
    naturalEvidence,
    browserEvidence,
  };
  promotion.rawArtifact = addArtifact(artifacts, {
    schema: "pikiio-promotion-raw-artifact-v1",
    ...commonReceipt(context, promotionObservedAt),
    deploymentId: changeDeployment,
    sourceCuts,
    sourceCutSetSha256: promotion.sourceCutSetSha256,
    naturalEvidenceReceiptHashes: naturalEvidence.map(
      (evidence) => evidence.receiptHash,
    ),
    browserEvidenceReceiptHashes: browserEvidence.map(
      (evidence) => evidence.receiptHash,
    ),
    assertions: promotion.assertions,
  });
  finishReceipt(promotion);
  return {
    repository,
    phase,
    artifacts,
    chain: { candidate, rehearsal, change, promotion },
    options: {
      registry,
      repoRoot: repository.root,
      ledgerRevision,
      scopeBaseCommit: repository.baseCommit,
      baseQualityProfile: BASE_PROFILE,
      artifacts,
      nowMs: Date.parse(promotionObservedAt) + 1000,
    },
  };
}

function cloneFixture(fixture) {
  return {
    ...fixture,
    artifacts: new Map(fixture.artifacts),
    chain: structuredClone(fixture.chain),
    options: {
      ...fixture.options,
      artifacts: new Map(fixture.artifacts),
    },
  };
}

function rehashChain(chain) {
  for (const evidence of chain.promotion.naturalEvidence || []) {
    evidence.receiptHash = hashWithoutField(evidence);
  }
  for (const evidence of chain.promotion.browserEvidence || []) {
    evidence.receiptHash = hashWithoutField(evidence);
  }
  chain.candidate.receiptHash = hashWithoutField(chain.candidate);
  chain.rehearsal.previousReceiptHash = chain.candidate.receiptHash;
  chain.rehearsal.receiptHash = hashWithoutField(chain.rehearsal);
  chain.change.previousReceiptHash = chain.rehearsal.receiptHash;
  chain.change.receiptHash = hashWithoutField(chain.change);
  chain.promotion.previousReceiptHash = chain.change.receiptHash;
  chain.promotion.receiptHash = hashWithoutField(chain.promotion);
}

function makeReferencedAuthorityRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pikiio-phase-authority-"),
  );
  temporaryRoots.push(root);
  for (const reference of [
    registry.attestationAuthority,
    registry.githubOidcJwks,
  ]) {
    write(
      root,
      reference.path,
      fs.readFileSync(path.join(__dirname, "..", reference.path)),
    );
  }
  return root;
}

function rehashReferenced(value, field) {
  const unsigned = structuredClone(value);
  delete unsigned[field];
  value[field] = sha256(stableJson(unsigned));
  return value[field];
}

before(() => {
  for (const phaseId of PHASE_IDS) {
    fixtures.set(phaseId, makeFixture(phaseId));
  }
});

after(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("canonical phase-proof registry", () => {
  test("loads and validates the exact immutable registry", () => {
    const loaded = loadPhaseProofRegistry();
    const validation = validatePhaseProofRegistry(loaded);
    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.equal(validation.registrySha256, CANONICAL_REGISTRY_SHA256);
    assert.deepEqual(Object.keys(loaded.phases), PHASE_IDS);
  });

  test("loads exact external authority and pinned GitHub keys from bounded regular files", () => {
    const root = makeReferencedAuthorityRoot();
    const result = validateReferencedPhaseAuthorities(registry, {
      repoRoot: root,
    });
    assert.equal(result.authority.mode, "external_collector_required");
    assert.equal(
      result.authority.controller.localCollectorPrivateKeyAllowed,
      false,
    );
    assert.equal(
      result.authority.collector.jwksRegistrySha256,
      result.jwks.registrySha256,
    );
    assert.equal(
      result.authority.collector.workflowRef,
      "pikiio-proof-authority-v1",
    );
  });

  test("external authority semantics reject every rehashed privilege substitution", () => {
    const mutations = [
      (authority) => {
        authority.mode = "local_or_external";
      },
      (authority) => {
        authority.controller.localCollectorPrivateKeyAllowed = true;
      },
      (authority) => {
        authority.controller.cryptographicSignature = "authorizing";
      },
      (authority) => {
        authority.collector.repository = "attacker/repository";
      },
      (authority) => {
        authority.collector.repositoryVisibility = "public";
      },
      (authority) => {
        authority.collector.runnerEnvironment = "self-hosted";
      },
      (authority) => {
        authority.collector.workflowPath = ".github/workflows/attacker.yml";
      },
      (authority) => {
        authority.collector.workflowRef = "main";
      },
      (authority) => {
        authority.collector.jwksRegistrySha256 = "f".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const root = makeReferencedAuthorityRoot();
      const alteredRegistry = structuredClone(registry);
      const authorityPath = path.join(
        root,
        alteredRegistry.attestationAuthority.path,
      );
      const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
      mutate(authority);
      alteredRegistry.attestationAuthority.sha256 = rehashReferenced(
        authority,
        "authoritySha256",
      );
      fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`);
      assert.throws(
        () =>
          validateReferencedPhaseAuthorities(alteredRegistry, {
            repoRoot: root,
          }),
        /attestation authority contract is not canonical/,
      );
    }
  });

  test("referenced authority refuses swapped, escaping, symlinked, and oversized files", () => {
    const swapped = structuredClone(registry);
    swapped.attestationAuthority.path = swapped.githubOidcJwks.path;
    assert.equal(
      validatePhaseProofRegistry(swapped, { requireCanonical: false }).valid,
      false,
    );

    const escaped = structuredClone(registry);
    escaped.attestationAuthority.path = "../authority.json";
    assert.throws(
      () =>
        validateReferencedPhaseAuthorities(escaped, {
          repoRoot: makeReferencedAuthorityRoot(),
        }),
      /escapes the repository/,
    );

    const symlinkRoot = makeReferencedAuthorityRoot();
    const authorityPath = path.join(
      symlinkRoot,
      registry.attestationAuthority.path,
    );
    const movedPath = `${authorityPath}.real`;
    fs.renameSync(authorityPath, movedPath);
    fs.symlinkSync(movedPath, authorityPath);
    assert.throws(
      () =>
        validateReferencedPhaseAuthorities(registry, {
          repoRoot: symlinkRoot,
        }),
      /bounded regular file/,
    );

    const oversizedRoot = makeReferencedAuthorityRoot();
    fs.writeFileSync(
      path.join(oversizedRoot, registry.attestationAuthority.path),
      Buffer.alloc(256 * 1024 + 1, 0x61),
    );
    assert.throws(
      () =>
        validateReferencedPhaseAuthorities(registry, {
          repoRoot: oversizedRoot,
        }),
      /bounded regular file/,
    );
  });

  test("referenced authority detects an inode swap between metadata and open", () => {
    const root = makeReferencedAuthorityRoot();
    const authorityPath = path.join(
      root,
      registry.attestationAuthority.path,
    );
    let swapped = false;
    const fsImpl = Object.create(fs);
    fsImpl.openSync = (target, flags) => {
      if (!swapped && target === authorityPath) {
        swapped = true;
        const bytes = fs.readFileSync(target);
        fs.renameSync(target, `${target}.prior`);
        fs.writeFileSync(target, bytes);
      }
      return fs.openSync(target, flags);
    };
    assert.throws(
      () =>
        validateReferencedPhaseAuthorities(registry, {
          repoRoot: root,
          fsImpl,
        }),
      /changed while opening/,
    );
  });

  test("rehashed JWKS algorithm or key substitution remains invalid", () => {
    for (const mutate of [
      (jwks) => {
        jwks.keys[0].alg = "none";
      },
      (jwks) => {
        jwks.keys[0].e = "Aw";
      },
      (jwks) => {
        jwks.issuer = "https://attacker.invalid";
      },
    ]) {
      const root = makeReferencedAuthorityRoot();
      const alteredRegistry = structuredClone(registry);
      const jwksPath = path.join(root, alteredRegistry.githubOidcJwks.path);
      const jwks = JSON.parse(fs.readFileSync(jwksPath, "utf8"));
      mutate(jwks);
      alteredRegistry.githubOidcJwks.sha256 = rehashReferenced(
        jwks,
        "registrySha256",
      );
      const authorityPath = path.join(
        root,
        alteredRegistry.attestationAuthority.path,
      );
      const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
      authority.collector.jwksRegistrySha256 =
        alteredRegistry.githubOidcJwks.sha256;
      alteredRegistry.attestationAuthority.sha256 = rehashReferenced(
        authority,
        "authoritySha256",
      );
      fs.writeFileSync(jwksPath, `${JSON.stringify(jwks, null, 2)}\n`);
      fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`);
      assert.throws(() =>
        validateReferencedPhaseAuthorities(alteredRegistry, {
          repoRoot: root,
        }),
      );
    }
  });

  test("binds complete v1 quality plans and domain populations", () => {
    for (const phaseId of PHASE_IDS) {
      const phase = phaseProofForId(registry, phaseId);
      assert.match(phase.qualityIds.suite, /-v1$/);
      assert.match(phase.qualityIds.gherkin, /-v1$/);
      assert.match(phase.qualityIds.mutation, /-v1$/);
      assert.equal(phase.qualityPlan.suiteId, phase.qualityIds.suite);
      assert.equal(phase.qualityPlan.gherkinId, phase.qualityIds.gherkin);
      assert.equal(phase.qualityPlan.mutationId, phase.qualityIds.mutation);
      assert.ok(phase.qualityPlan.syntaxFiles.length > 0);
      assert.ok(phase.qualityPlan.focusedCheckIds.length > 0);
      if (phaseId !== "GOV-00") {
        assert.equal(phase.populationFloors.unitTests, 65);
        assert.equal(phase.populationFloors.criticalMutants, 20);
        assert.equal(phase.populationFloors.gherkinScenarios, 15);
      }
    }
  });

  test("rejects every single-phase canonical mutation property-style", () => {
    for (const phaseId of PHASE_IDS) {
      for (const field of [
        "qualityIds",
        "populationFloors",
        "qualityPlan",
        "authorityFiles",
        "runtimePathRules",
        "measuredRuntimeRules",
        "promotionAssertions",
        "receiptPolicy",
      ]) {
        const altered = structuredClone(registry);
        altered.phases[phaseId][field] = structuredClone(
          altered.phases[phaseId][field],
        );
        if (Array.isArray(altered.phases[phaseId][field])) {
          altered.phases[phaseId][field].reverse();
        } else {
          altered.phases[phaseId][field].__tampered = true;
        }
        const result = validatePhaseProofRegistry(altered);
        assert.equal(result.valid, false, `${phaseId}.${field}`);
        assert.ok(result.errors.length > 0);
      }
    }
  });

  test("fails closed across malformed structural fields property-style", () => {
    const mutations = [
      (copy) => {
        copy.schema = "wrong";
      },
      (copy) => {
        copy.revision = 0;
      },
      (copy) => {
        copy.phaseOrder = [...copy.phaseOrder].reverse();
      },
      (copy) => {
        copy.phases["GOV-00"] = null;
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityIds.suite = "";
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityIds.suite =
          copy.phases["GOV-00"].qualityIds.suite;
      },
      (copy) => {
        copy.phases["GOV-00"].populationFloors.unitTests = 122;
      },
      (copy) => {
        copy.phases["TRUTH-01"].populationFloors.unitTests = 64;
      },
      (copy) => {
        copy.phases["TRUTH-01"].populationFloors.criticalMutants = 0;
      },
      (copy) => {
        copy.phases["TRUTH-01"].authorityFiles = [];
      },
      (copy) => {
        copy.phases["TRUTH-01"].authorityFiles[0] = "../escape";
      },
      (copy) => {
        copy.phases["TRUTH-01"].authorityFiles.push(
          copy.phases["TRUTH-01"].authorityFiles[0],
        );
      },
      (copy) => {
        copy.phases["TRUTH-01"].authorityFiles.reverse();
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityPlan.syntaxFiles = [];
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityPlan.syntaxFiles[0] = "../bad.js";
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityPlan.suiteId = "wrong-v1";
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityPlan.focusedCheckIds = [];
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityPlan.neighborCheckIds.push(
          copy.phases["TRUTH-01"].qualityPlan.focusedCheckIds[0],
        );
      },
      (copy) => {
        copy.phases["TRUTH-01"].qualityPlan.naturalEvidenceRequired = false;
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules = [];
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[0].id = "";
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[0].match = "glob";
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[0].pattern = "/absolute";
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[0].pattern = "lib/truth";
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[0].classification = "";
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[0].proofRequired = "yes";
      },
      (copy) => {
        copy.phases["TRUTH-01"].runtimePathRules[1].id =
          copy.phases["TRUTH-01"].runtimePathRules[0].id;
      },
      (copy) => {
        copy.phases["TRUTH-01"].measuredRuntimeRules = [];
      },
      (copy) => {
        copy.phases["TRUTH-01"].measuredRuntimeRules[0].metric = "";
      },
      (copy) => {
        copy.phases["TRUTH-01"].measuredRuntimeRules[0].operator = "contains";
      },
      (copy) => {
        copy.phases["TRUTH-01"].measuredRuntimeRules[0].expected = null;
      },
      (copy) => {
        copy.phases["TRUTH-01"].promotionAssertions[0].evidence = "foreign";
      },
      (copy) => {
        copy.phases["TRUTH-01"].promotionAssertions[0].operator = "gte";
      },
      (copy) => {
        copy.phases["TRUTH-01"].promotionAssertions[0].id =
          copy.phases["TRUTH-01"].promotionAssertions[1].id;
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.authorityBaseline = "candidate";
      },
      (copy) => {
        copy.phases["GOV-00"].receiptPolicy.authorityBaseline = "candidate";
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.productionMode = "none";
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.candidateQuality = "optional";
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.productionChange = "maybe";
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.promotion = "optional";
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.minimumNaturalEvidence = -1;
      },
      (copy) => {
        copy.phases["TRUTH-01"].receiptPolicy.deploymentBinding = "none";
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const copy = structuredClone(registry);
      mutate(copy);
      const result = validatePhaseProofRegistry(copy, {
        requireCanonical: false,
      });
      assert.equal(result.valid, false, `structural mutation ${index}`);
      assert.ok(result.errors.length > 0);
    }
  });

  test("rejects unknown phases and unreadable/invalid registry files", () => {
    assert.throws(
      () => phaseProofForId(registry, "UNKNOWN"),
      (error) => error.code === "PHASE_PROOF_UNKNOWN",
    );
    assert.throws(
      () => loadPhaseProofRegistry("/definitely/missing/registry.json"),
      (error) => error.code === "PHASE_PROOF_REGISTRY_UNREADABLE",
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-registry-"));
    temporaryRoots.push(root);
    const invalidPath = path.join(root, "invalid.json");
    fs.writeFileSync(invalidPath, "{}\n");
    assert.throws(
      () => loadPhaseProofRegistry(invalidPath),
      (error) =>
        error instanceof PhaseProofError &&
        error.code === "PHASE_PROOF_REGISTRY_INVALID",
    );
    assert.throws(
      () => phaseProofForId({}, "GOV-00"),
      (error) => error.code === "PHASE_PROOF_REGISTRY_INVALID",
    );
  });
});

describe("immutable authority and changed-path classification", () => {
  test("reads judge bytes from the immutable commit, not the worktree", () => {
    const fixture = fixtures.get("TRUTH-01");
    const beforeSnapshot = computeAuthoritySnapshot({
      repoRoot: fixture.repository.root,
      commit: fixture.repository.candidateCommit,
      phaseId: "TRUTH-01",
      registry,
    });
    const first = fixture.phase.authorityFiles[0];
    write(fixture.repository.root, first, "uncommitted judge tamper\n");
    const afterSnapshot = computeAuthoritySnapshot({
      repoRoot: fixture.repository.root,
      commit: fixture.repository.candidateCommit,
      phaseId: "TRUTH-01",
      registry,
    });
    assert.deepEqual(afterSnapshot, beforeSnapshot);
  });

  test("rejects short commits, missing authority blobs, and symlinked judges", () => {
    const fixture = fixtures.get("TRUTH-02");
    assert.throws(
      () =>
        computeAuthoritySnapshot({
          repoRoot: fixture.repository.root,
          commit: fixture.repository.candidateCommit.slice(0, 12),
          phaseId: "TRUTH-02",
          registry,
        }),
      (error) => error.code === "PHASE_PROOF_COMMIT_INVALID",
    );
    const root = makeRepository("TRUTH-02").root;
    const authority = registry.phases["TRUTH-02"].authorityFiles[0];
    fs.unlinkSync(path.join(root, authority));
    const missingCommit = commitAll(root, "remove judge");
    assert.throws(
      () =>
        computeAuthoritySnapshot({
          repoRoot: root,
          commit: missingCommit,
          phaseId: "TRUTH-02",
          registry,
        }),
      (error) => error.code === "PHASE_PROOF_AUTHORITY_TREE_INVALID",
    );
    assert.throws(
      () =>
        computeAuthoritySnapshot({
          repoRoot: "/definitely/not/a/git/repository",
          commit: fixture.repository.candidateCommit,
          phaseId: "TRUTH-02",
          registry,
        }),
      (error) => error.code === "SEALED_GIT_REPOSITORY_UNREADABLE",
    );
    write(root, "target.txt", "target\n");
    fs.symlinkSync("target.txt", path.join(root, authority));
    const symlinkCommit = commitAll(root, "symlink judge");
    assert.throws(
      () =>
        computeAuthoritySnapshot({
          repoRoot: root,
          commit: symlinkCommit,
          phaseId: "TRUTH-02",
          registry,
        }),
      (error) => error.code === "PHASE_PROOF_AUTHORITY_FILE_INVALID",
    );
  });

  test("authority snapshots ignore inherited PATH and Git authority variables", () => {
    const target = makeRepository("TRUTH-01");
    const foreign = makeRepository("TRUTH-01");
    const fakeBin = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-fake-git-")),
    );
    temporaryRoots.push(fakeBin);
    const marker = path.join(fakeBin, "executed");
    fs.writeFileSync(
      path.join(fakeBin, "git"),
      `#!/bin/sh\nprintf poison > ${JSON.stringify(marker)}\nexit 97\n`,
      { mode: 0o755 },
    );
    const poison = {
      PATH: fakeBin,
      GIT_DIR: path.join(foreign.root, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(foreign.root, ".git", "objects"),
      GIT_WORK_TREE: foreign.root,
      GIT_INDEX_FILE: path.join(foreign.root, ".git", "index"),
      GIT_CONFIG_GLOBAL: path.join(fakeBin, "missing-config"),
      GIT_REPLACE_REF_BASE: "refs/poison/",
    };
    const previous = new Map();
    for (const [key, value] of Object.entries(poison)) {
      previous.set(
        key,
        Object.hasOwn(process.env, key) ? process.env[key] : undefined,
      );
      process.env[key] = value;
    }
    try {
      const snapshot = computeAuthoritySnapshot({
        repoRoot: target.root,
        commit: target.candidateCommit,
        phaseId: "TRUTH-01",
        registry,
      });
      assert.equal(snapshot.commit, target.candidateCommit);
      assert.equal(snapshot.files.length, registry.phases["TRUTH-01"].authorityFiles.length);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal(fs.existsSync(marker), false);
  });

  test("classifies every authority and runtime path exactly once", () => {
    for (const phaseId of PHASE_IDS) {
      const phase = registry.phases[phaseId];
      const paths = [phase.authorityFiles[0], classifiedRuntimePath(phaseId)].sort();
      const coverage = classifyChangedPaths({
        registry,
        phaseId,
        changedPaths: paths,
      });
      assert.equal(coverage.entries.length, 2);
      assert.equal(coverage.entries[0].path, paths[0]);
      assert.match(coverage.coverageSha256, /^[a-f0-9]{64}$/);
      assert.ok(coverage.proofRequiredPaths.length >= 1);
    }
  });

  test("fails closed on empty, unsafe, duplicate, unsorted, or uncovered paths", () => {
    const cases = [
      [],
      ["../escape.js"],
      ["lib/truth-a.js", "lib/truth-a.js"],
      ["lib/truth-z.js", "lib/truth-a.js"],
    ];
    for (const changedPaths of cases) {
      assert.throws(() =>
        classifyChangedPaths({
          registry,
          phaseId: "TRUTH-01",
          changedPaths,
        }),
      );
    }
    assert.throws(
      () =>
        classifyChangedPaths({
          registry,
          phaseId: "TRUTH-01",
          changedPaths: ["totally/uncovered.js"],
        }),
      (error) => error.code === "PHASE_PROOF_PATH_UNCLASSIFIED",
    );
  });
});

describe("four-receipt phase proof chain", () => {
  test("validates candidate proof independently before any production rehearsal", () => {
    for (const phaseId of PHASE_IDS) {
      const fixture = fixtures.get(phaseId);
      const result = validatePhaseCandidateReceipt(
        fixture.chain.candidate,
        fixture.options,
      );
      assert.equal(result.valid, true, `${phaseId}\n${result.errors.join("\n")}`);
      assert.equal(
        result.receiptHashes.candidate,
        fixture.chain.candidate.receiptHash,
      );
      assert.equal(
        result.authoritySnapshot.authoritySetSha256,
        result.baselineAuthoritySnapshot.authoritySetSha256,
      );
    }
  });

  test("candidate-only validation fails closed on forged proof or missing context", () => {
    const fixture = cloneFixture(fixtures.get("TRUTH-01"));
    fixture.chain.candidate.qualityIds.suite = "forged-v1";
    rehashChain(fixture.chain);
    let result = validatePhaseCandidateReceipt(
      fixture.chain.candidate,
      fixture.options,
    );
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /quality IDs/);

    result = validatePhaseCandidateReceipt(
      { phaseId: "UNKNOWN" },
      fixture.options,
    );
    assert.equal(result.valid, false);
    assert.equal(result.authoritySnapshot, null);
  });

  test("candidate plus rehearsal grants change authority only to change-gated phases", () => {
    for (const [phaseId, authorized] of [
      ["GOV-00", false],
      ["TRUTH-01", true],
      ["TRUTH-02", false],
      ["ACTION-01", false],
      ["ACTION-02", true],
      ["ACTION-03", true],
    ]) {
      const fixture = fixtures.get(phaseId);
      const result = validatePhaseRehearsalAuthorization(
        {
          candidate: fixture.chain.candidate,
          rehearsal: fixture.chain.rehearsal,
        },
        fixture.options,
      );
      assert.equal(result.valid, true, `${phaseId}\n${result.errors.join("\n")}`);
      assert.equal(result.productionChangeAuthorized, authorized, phaseId);
    }
  });

  test("rehearsal authorization rejects placeholders, forged links, and invalid candidates", () => {
    const fixture = fixtures.get("TRUTH-01");
    let result = validatePhaseRehearsalAuthorization(
      { candidate: fixture.chain.candidate },
      fixture.options,
    );
    assert.equal(result.valid, false);
    assert.equal(result.productionChangeAuthorized, false);

    const forged = cloneFixture(fixture);
    forged.chain.rehearsal.previousReceiptHash = "0".repeat(64);
    result = validatePhaseRehearsalAuthorization(
      {
        candidate: forged.chain.candidate,
        rehearsal: forged.chain.rehearsal,
      },
      forged.options,
    );
    assert.equal(result.valid, false);
    assert.equal(result.productionChangeAuthorized, false);

    result = validatePhaseRehearsalAuthorization(
      {
        candidate: { phaseId: "UNKNOWN" },
        rehearsal: forged.chain.rehearsal,
      },
      forged.options,
    );
    assert.equal(result.valid, false);
    assert.equal(result.productionChangeAuthorized, false);
  });

  test("public validators fail closed on omitted and sparse receipt shapes", () => {
    assert.equal(validatePhaseCandidateReceipt().valid, false);
    assert.equal(validatePhaseRehearsalAuthorization().valid, false);
    assert.equal(validatePhaseProofChain().valid, false);
    assert.throws(() => computeAuthoritySnapshot());
    assert.throws(() => classifyChangedPaths());

    const fixture = cloneFixture(fixtures.get("TRUTH-01"));
    let result = validatePhaseProofChain(
      {
        candidate: fixture.chain.candidate,
        rehearsal: null,
        change: null,
        promotion: null,
      },
      fixture.options,
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 10);

    const sparse = cloneFixture(fixtures.get("TRUTH-01"));
    sparse.chain.candidate.populations = null;
    sparse.chain.candidate.authoritySnapshot = null;
    sparse.chain.candidate.changedPathCoverage = null;
    sparse.chain.candidate.assertions = null;
    sparse.chain.candidate.rawArtifact = null;
    sparse.chain.candidate.controller = null;
    sparse.chain.candidate.collector = null;
    sparse.chain.promotion.sourceCuts = null;
    sparse.chain.promotion.assertions = null;
    sparse.chain.promotion.naturalEvidence = null;
    sparse.chain.promotion.browserEvidence = null;
    sparse.chain.promotion.rawArtifact = null;
    result = validatePhaseProofChain(sparse.chain, sparse.options);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 10);
  });

  test("accepts exact candidate, rehearsal, change, and promotion evidence for every phase", () => {
    for (const phaseId of PHASE_IDS) {
      const fixture = fixtures.get(phaseId);
      const result = validatePhaseProofChain(fixture.chain, fixture.options);
      assert.equal(
        result.valid,
        true,
        `${phaseId}\n${result.errors.join("\n")}`,
      );
      assert.equal(result.phaseId, phaseId);
      assert.equal(result.receiptHashes.promotion, fixture.chain.promotion.receiptHash);
    }
  });

  test("every receipt family rejects rehashed extra and missing root fields", () => {
    const receiptCases = [
      {
        name: "candidate",
        fixture: "TRUTH-01",
        select: (chain) => chain.candidate,
        missing: "status",
      },
      {
        name: "rehearsal",
        fixture: "TRUTH-01",
        select: (chain) => chain.rehearsal,
        missing: "rollbackVerified",
      },
      {
        name: "change",
        fixture: "TRUTH-01",
        select: (chain) => chain.change,
        missing: "deployedCommit",
      },
      {
        name: "natural",
        fixture: "TRUTH-01",
        select: (chain) => chain.promotion.naturalEvidence[0],
        missing: "cycleId",
      },
      {
        name: "browser",
        fixture: "ACTION-03",
        select: (chain) => chain.promotion.browserEvidence[0],
        missing: "agrees",
      },
      {
        name: "promotion",
        fixture: "TRUTH-01",
        select: (chain) => chain.promotion,
        missing: "disposition",
      },
    ];
    for (const receiptCase of receiptCases) {
      for (const mutation of ["extra", "missing"]) {
        const fixture = cloneFixture(fixtures.get(receiptCase.fixture));
        const receipt = receiptCase.select(fixture.chain);
        if (mutation === "extra") receipt.rehashedUnknownRoot = true;
        else delete receipt[receiptCase.missing];
        rehashChain(fixture.chain);
        const result = validatePhaseProofChain(
          fixture.chain,
          fixture.options,
        );
        assert.equal(
          result.valid,
          false,
          `${receiptCase.name} ${mutation}`,
        );
        assert.match(
          result.errors.join("\n"),
          /unexpected root fields/,
          `${receiptCase.name} ${mutation}`,
        );
      }
    }

    for (const role of ["rehearsal", "change"]) {
      const fixture = cloneFixture(fixtures.get("GOV-00"));
      fixture.chain[role].rehashedUnknownRoot = true;
      rehashChain(fixture.chain);
      const result = validatePhaseProofChain(
        fixture.chain,
        fixture.options,
      );
      assert.equal(result.valid, false, `${role} not-applicable extra`);
      assert.match(result.errors.join("\n"), /unexpected root fields/);
    }
  });

  test("warmed authority cache revalidates repository, commit, tree, and exact objects", async (t) => {
    const removeLooseObject = (root, objectId) => {
      fs.rmSync(
        path.join(
          root,
          ".git",
          "objects",
          objectId.slice(0, 2),
          objectId.slice(2),
        ),
      );
    };
    for (const target of ["repository", "commit", "tree", "blob"]) {
      await t.test(target, () => {
        const repository = makeRepository("GOV-00");
        const first = computeAuthoritySnapshot({
          repoRoot: repository.root,
          commit: repository.candidateCommit,
          phaseId: "GOV-00",
          registry,
        });
        if (target === "repository") {
          const gitDirectory = path.join(repository.root, ".git");
          const prior = path.join(repository.root, ".git-prior");
          fs.renameSync(gitDirectory, prior);
          fs.cpSync(prior, gitDirectory, { recursive: true });
        } else if (target === "commit") {
          removeLooseObject(repository.root, repository.candidateCommit);
        } else if (target === "tree") {
          removeLooseObject(repository.root, repository.candidateTree);
        } else {
          removeLooseObject(repository.root, first.files[0].blob);
        }
        assert.throws(() =>
          computeAuthoritySnapshot({
            repoRoot: repository.root,
            commit: repository.candidateCommit,
            phaseId: "GOV-00",
            registry,
          }),
        );
      });
    }
  });

  test("Gherkin fixture mutations ignore PATH, inherited config, hooks, and replacement objects", () => {
    const priorNodeEnvironment = process.env.NODE_ENV;
    const { trustedFixtureGit } = require(
      "../scripts/verify-pikiio-governance-gherkin"
    );
    if (priorNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnvironment;

    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-gherkin-git-test-")),
    );
    temporaryRoots.push(root);
    const poison = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-gherkin-git-poison-")),
    );
    temporaryRoots.push(poison);
    const fakeGitMarker = path.join(poison, "fake-git-ran");
    const hookMarker = path.join(poison, "hook-ran");
    fs.writeFileSync(
      path.join(poison, "git"),
      `#!/bin/sh\nprintf poison > ${JSON.stringify(fakeGitMarker)}\nexit 97\n`,
      { mode: 0o755 },
    );
    const hook = path.join(poison, "pre-commit");
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nprintf hook > ${JSON.stringify(hookMarker)}\nexit 98\n`,
      { mode: 0o755 },
    );
    const config = path.join(poison, "gitconfig");
    fs.writeFileSync(
      config,
      `[core]\n\thooksPath = ${poison}\n[credential]\n\thelper = !exit 99\n`,
    );
    const prior = Object.fromEntries(
      [
        "PATH",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_REPLACE_REF_BASE",
      ].map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      PATH: poison,
      GIT_CONFIG: config,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_DIR: path.join(poison, "foreign.git"),
      GIT_OBJECT_DIRECTORY: path.join(poison, "objects"),
      GIT_REPLACE_REF_BASE: "refs/replace-poison/",
    });
    try {
      trustedFixtureGit(root, ["init", "-b", "main"]);
      fs.writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
      trustedFixtureGit(root, ["add", "fixture.txt"]);
      trustedFixtureGit(root, ["commit", "-m", "fixture"]);
      assert.match(
        trustedFixtureGit(root, ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        /^[a-f0-9]{40}$/,
      );
      for (const [args, options] of [
        [["-c", `core.hooksPath=${poison}`, "status"], {}],
        [["--config-env=core.hooksPath=PATH", "status"], {}],
        [["status"], { env: process.env }],
      ]) {
        assert.throws(
          () => trustedFixtureGit(root, args, options),
          (error) => error.code === "GHERKIN_FIXTURE_GIT_INVALID",
        );
      }
      assert.equal(fs.existsSync(fakeGitMarker), false);
      assert.equal(fs.existsSync(hookMarker), false);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("requires the exact four receipts and a known phase", () => {
    const fixture = cloneFixture(fixtures.get("GOV-00"));
    delete fixture.chain.change;
    assert.equal(
      validatePhaseProofChain(fixture.chain, fixture.options).valid,
      false,
    );
    const unknown = cloneFixture(fixtures.get("GOV-00"));
    unknown.chain.candidate.phaseId = "UNKNOWN";
    assert.equal(validatePhaseProofChain(unknown.chain, unknown.options).valid, false);
  });

  test("makes domain population floors conjunctive with the base profile", () => {
    const fixture = cloneFixture(fixtures.get("ACTION-01"));
    fixture.chain.candidate.populations.unitTests = 65;
    rehashChain(fixture.chain);
    let result = validatePhaseProofChain(fixture.chain, fixture.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /conjunctive floor 123/);

    const withoutBase = {
      ...fixture.options,
      baseQualityProfile: null,
    };
    result = validatePhaseProofChain(
      fixtures.get("ACTION-01").chain,
      withoutBase,
    );
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /base quality profile is required/);
  });

  test("detects judge authority drift between scope base and candidate", () => {
    const drifted = makeFixture("TRUTH-01", { changeAuthority: true });
    const result = validatePhaseProofChain(drifted.chain, drifted.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /changed immutable judge authority/);
  });

  test("rejects quality ID, coverage, population, baseline, and candidate artifact forgery", () => {
    const mutations = [
      (copy) => {
        copy.chain.candidate.qualityIds.suite = "foreign-suite-v1";
      },
      (copy) => {
        copy.chain.candidate.populations.criticalMutants = 1;
      },
      (copy) => {
        copy.chain.candidate.authorityBaselineCommit = "f".repeat(40);
      },
      (copy) => {
        copy.chain.candidate.changedPathCoverage.coverageSha256 = "e".repeat(64);
      },
      (copy) => {
        copy.chain.candidate.rawArtifact.sha256 = "d".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const copy = cloneFixture(fixtures.get("GOV-00"));
      mutate(copy);
      rehashChain(copy.chain);
      const result = validatePhaseProofChain(copy.chain, copy.options);
      assert.equal(result.valid, false);
    }
  });

  test("rejects broken receipt links, hashes, identities, and non-monotonic time", () => {
    const mutations = [
      (copy) => {
        copy.chain.rehearsal.previousReceiptHash = "0".repeat(64);
      },
      (copy) => {
        copy.chain.change.receiptHash = "0".repeat(64);
      },
      (copy) => {
        copy.chain.promotion.controller.identitySha256 = "1".repeat(64);
      },
      (copy) => {
        copy.chain.promotion.collector = copy.chain.promotion.controller;
      },
      (copy) => {
        copy.chain.change.observedAt = "2025-01-01T00:00:00.000Z";
      },
    ];
    for (const mutate of mutations) {
      const copy = cloneFixture(fixtures.get("GOV-00"));
      mutate(copy);
      const result = validatePhaseProofChain(copy.chain, copy.options);
      assert.equal(result.valid, false);
    }
  });

  test("permits not-applicable production only where phase policy says none", () => {
    const truth = cloneFixture(fixtures.get("TRUTH-01"));
    truth.chain.rehearsal.disposition = "not_applicable";
    truth.chain.rehearsal.reason = "attempted bypass";
    truth.chain.rehearsal.rawArtifact = null;
    rehashChain(truth.chain);
    let result = validatePhaseProofChain(truth.chain, truth.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /disposition must be passed/);

    const gov = fixtures.get("GOV-00");
    result = validatePhaseProofChain(gov.chain, gov.options);
    assert.equal(result.valid, true, result.errors.join("\n"));
    assert.equal(gov.chain.rehearsal.disposition, "not_applicable");
    assert.equal(gov.chain.change.disposition, "not_applicable");
  });

  test("observe-only phases require rehearsal but prohibit a production change", () => {
    const fixture = fixtures.get("TRUTH-02");
    assert.equal(fixture.chain.rehearsal.disposition, "passed");
    assert.equal(fixture.chain.change.disposition, "not_applicable");
    assert.equal(
      fixture.chain.change.deploymentId,
      fixture.chain.rehearsal.deploymentId,
    );
    const result = validatePhaseProofChain(fixture.chain, fixture.options);
    assert.equal(result.valid, true, result.errors.join("\n"));
  });

  test("recomputes content-addressed artifact bytes instead of trusting their labels", () => {
    const fixture = cloneFixture(fixtures.get("TRUTH-01"));
    const address = fixture.chain.promotion.naturalEvidence[0].rawArtifact.address;
    fixture.options.artifacts.set(address, Buffer.from('{"tampered":true}', "utf8"));
    const result = validatePhaseProofChain(fixture.chain, fixture.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /bytes do not match sha256/);
  });

  test("accepts map, object, string, buffer, and Uint8Array artifact carriers", () => {
    const source = fixtures.get("GOV-00");
    const carriers = [
      Object.fromEntries(
        [...source.artifacts].map(([key, value]) => [key, value.toString("utf8")]),
      ),
      Object.fromEntries(
        [...source.artifacts].map(([key, value]) => [key, new Uint8Array(value)]),
      ),
      new Map(source.artifacts),
    ];
    for (const artifacts of carriers) {
      const result = validatePhaseProofChain(source.chain, {
        ...source.options,
        artifacts,
      });
      assert.equal(result.valid, true, result.errors.join("\n"));
    }
  });

  test("rejects absent and non-JSON raw artifact bytes", () => {
    const absent = cloneFixture(fixtures.get("GOV-00"));
    absent.options.artifacts.delete(absent.chain.candidate.rawArtifact.address);
    let result = validatePhaseProofChain(absent.chain, absent.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /bytes are unavailable/);

    const invalid = cloneFixture(fixtures.get("GOV-00"));
    const bytes = Buffer.from("not-json", "utf8");
    const digest = sha256(bytes);
    invalid.chain.candidate.rawArtifact = {
      address: `sha256:${digest}`,
      sha256: digest,
    };
    invalid.options.artifacts.set(`sha256:${digest}`, bytes);
    rehashChain(invalid.chain);
    result = validatePhaseProofChain(invalid.chain, invalid.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /is not valid JSON/);
  });

  test("returns fail-closed validation for invalid commits, trees, scope bases, and paths", () => {
    const invalidCommit = cloneFixture(fixtures.get("TRUTH-01"));
    invalidCommit.chain.candidate.candidateCommit = "short";
    let result = validatePhaseProofChain(
      invalidCommit.chain,
      invalidCommit.options,
    );
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /candidate commit/);

    const invalidTree = cloneFixture(fixtures.get("TRUTH-01"));
    invalidTree.chain.candidate.candidateTree = "short";
    result = validatePhaseProofChain(invalidTree.chain, invalidTree.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /candidate tree/);

    const invalidScope = cloneFixture(fixtures.get("TRUTH-01"));
    result = validatePhaseProofChain(invalidScope.chain, {
      ...invalidScope.options,
      scopeBaseCommit: "short",
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /scope-base commit/);

    const invalidPath = cloneFixture(fixtures.get("TRUTH-01"));
    invalidPath.chain.candidate.changedPaths = ["unclassified/path.js"];
    rehashChain(invalidPath.chain);
    result = validatePhaseProofChain(invalidPath.chain, invalidPath.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /classification/);
  });

  test("rejects natural evidence binding and assertion drift even with rehashed receipts", () => {
    const mutations = [
      (copy) => {
        copy.chain.promotion.naturalEvidence[0].phaseId = "TRUTH-02";
      },
      (copy) => {
        copy.chain.promotion.naturalEvidence[0].deploymentId = "foreign";
      },
      (copy) => {
        copy.chain.promotion.naturalEvidence[0].sourceCutSetSha256 =
          "0".repeat(64);
      },
      (copy) => {
        copy.chain.promotion.naturalEvidence[0].natural = false;
      },
      (copy) => {
        copy.chain.promotion.naturalEvidence[0].result = "failed";
      },
      (copy) => {
        const key = Object.keys(
          copy.chain.promotion.naturalEvidence[0].assertions,
        )[0];
        copy.chain.promotion.naturalEvidence[0].assertions[key] = false;
      },
    ];
    for (const mutate of mutations) {
      const copy = cloneFixture(fixtures.get("TRUTH-01"));
      mutate(copy);
      rehashChain(copy.chain);
      const result = validatePhaseProofChain(copy.chain, copy.options);
      assert.equal(result.valid, false);
    }
  });

  test("recomputes browser/API state hashes and requires parity", () => {
    const fixture = cloneFixture(fixtures.get("ACTION-03"));
    const evidence = fixture.chain.promotion.browserEvidence[0];
    const oldAddress = evidence.rawArtifact.address;
    const raw = JSON.parse(
      fixture.options.artifacts.get(oldAddress).toString("utf8"),
    );
    raw.browserState = { shipments: [] };
    evidence.rawArtifact = addArtifact(fixture.options.artifacts, raw);
    evidence.browserStateSha256 = sha256(stableJson(raw.browserState));
    rehashChain(fixture.chain);
    const result = validatePhaseProofChain(fixture.chain, fixture.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /raw API and browser states disagree/);
  });

  test("enforces natural/browser populations, unique evidence IDs, source cuts, and soak span", () => {
    const mutations = [
      (copy) => {
        copy.chain.promotion.naturalEvidence.pop();
      },
      (copy) => {
        copy.chain.promotion.browserEvidence = [];
      },
      (copy) => {
        copy.chain.promotion.naturalEvidence[1].evidenceId =
          copy.chain.promotion.naturalEvidence[0].evidenceId;
      },
      (copy) => {
        copy.chain.promotion.sourceCuts = [];
      },
      (copy) => {
        copy.chain.promotion.sourceCutSetSha256 = "f".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const copy = cloneFixture(fixtures.get("TRUTH-02"));
      mutate(copy);
      rehashChain(copy.chain);
      const result = validatePhaseProofChain(copy.chain, copy.options);
      assert.equal(result.valid, false);
    }
    const short = makeFixture("TRUTH-02", { observationSpanMs: 1000 });
    const result = validatePhaseProofChain(short.chain, short.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /observation span is below policy/);
  });

  test("rejects promotion assertion and raw evidence-set forgery", () => {
    const fixture = cloneFixture(fixtures.get("ACTION-02"));
    fixture.chain.promotion.assertions["unsafe-shadow-zero"] = 1;
    rehashChain(fixture.chain);
    let result = validatePhaseProofChain(fixture.chain, fixture.options);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /failed eq/);

    const artifactForgery = cloneFixture(fixtures.get("ACTION-02"));
    artifactForgery.chain.promotion.rawArtifact.address =
      `sha256:${"a".repeat(64)}`;
    rehashChain(artifactForgery.chain);
    result = validatePhaseProofChain(artifactForgery.chain, artifactForgery.options);
    assert.equal(result.valid, false);
  });

  test("semantic refusal gauntlet covers every receipt binding family", () => {
    const mutations = [
      (chain) => {
        chain.candidate.schema = "wrong";
      },
      (chain) => {
        chain.candidate.status = "failed";
      },
      (chain) => {
        chain.candidate.previousReceiptHash = "0".repeat(64);
      },
      (chain) => {
        chain.candidate.registryRevision = 99;
      },
      (chain) => {
        chain.candidate.registrySha256 = "0".repeat(64);
      },
      (chain) => {
        chain.candidate.ledgerRevision = 99;
      },
      (chain) => {
        chain.candidate.candidateTree = "f".repeat(40);
      },
      (chain) => {
        chain.candidate.populations.extra = 1;
      },
      (chain) => {
        chain.candidate.authoritySnapshot.snapshotHash = "0".repeat(64);
      },
      (chain) => {
        chain.candidate.authorityBaselineSnapshotHash = "0".repeat(64);
      },
      (chain) => {
        chain.candidate.assertions.extra = true;
      },
      (chain) => {
        chain.candidate.controller = null;
      },
      (chain) => {
        chain.candidate.controller.id = "";
      },
      (chain) => {
        chain.candidate.controller.kind = "collector";
      },
      (chain) => {
        chain.candidate.controller.version = "";
      },
      (chain) => {
        chain.candidate.observedAt = "not-a-time";
      },
      (chain, options) => {
        chain.candidate.observedAt = new Date(options.nowMs + 600000).toISOString();
      },
      (chain) => {
        chain.rehearsal.schema = "wrong";
      },
      (chain) => {
        chain.rehearsal.deploymentId = "none";
      },
      (chain) => {
        chain.rehearsal.rollbackVerified = false;
      },
      (chain) => {
        chain.rehearsal.externalEffects = ["gmail_send"];
      },
      (chain) => {
        chain.change.deployedCommit = "0".repeat(40);
      },
      (chain) => {
        chain.change.deployedTree = "0".repeat(40);
      },
      (chain) => {
        chain.change.rollbackReference = "";
      },
      (chain) => {
        chain.promotion.schema = "wrong";
      },
      (chain) => {
        chain.promotion.disposition = "failed";
      },
      (chain) => {
        chain.promotion.deploymentId = "foreign";
      },
      (chain) => {
        chain.promotion.sourceCuts[0].source = "";
      },
      (chain) => {
        chain.promotion.sourceCuts[0].id = "";
      },
      (chain) => {
        chain.promotion.sourceCuts[0].sha256 = "short";
      },
      (chain) => {
        chain.promotion.sourceCuts[0].capturedAt = "not-a-time";
      },
      (chain) => {
        chain.promotion.sourceCuts.reverse();
      },
      (chain) => {
        chain.promotion.sourceCuts.push(
          structuredClone(chain.promotion.sourceCuts[0]),
        );
      },
      (chain) => {
        chain.promotion.naturalEvidence[0].evidenceId = "";
      },
      (chain) => {
        chain.promotion.naturalEvidence[0].cycleId = "";
      },
      (chain) => {
        chain.promotion.naturalEvidence[0].controller.id =
          chain.promotion.naturalEvidence[0].collector.id;
      },
      (chain) => {
        chain.promotion.browserEvidence[0].evidenceId = "";
      },
      (chain) => {
        chain.promotion.browserEvidence[0].agrees = false;
      },
      (chain) => {
        chain.promotion.browserEvidence[0].apiStateSha256 = "0".repeat(64);
      },
      (chain) => {
        chain.promotion.browserEvidence[0].browserStateSha256 = "0".repeat(64);
      },
      (chain) => {
        chain.promotion.rawArtifact.extra = true;
      },
      (chain) => {
        chain.promotion.rawArtifact.address = "not-content-addressed";
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const fixture = cloneFixture(fixtures.get("TRUTH-01"));
      mutate(fixture.chain, fixture.options);
      rehashChain(fixture.chain);
      const result = validatePhaseProofChain(fixture.chain, fixture.options);
      assert.equal(result.valid, false, `receipt mutation ${index}`);
      assert.ok(result.errors.length > 0);
    }

    const noProduction = cloneFixture(fixtures.get("GOV-00"));
    noProduction.chain.rehearsal.reason = "";
    noProduction.chain.rehearsal.rawArtifact = {
      address: `sha256:${"0".repeat(64)}`,
      sha256: "0".repeat(64),
    };
    noProduction.chain.rehearsal.deploymentId = "foreign";
    rehashChain(noProduction.chain);
    const result = validatePhaseProofChain(
      noProduction.chain,
      noProduction.options,
    );
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /reason is required/);
  });
});

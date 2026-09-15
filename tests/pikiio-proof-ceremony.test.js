"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const activationCas = require("../lib/pikiio-activation-cas");
const ceremony = require("../lib/pikiio-proof-ceremony");
const externalCi = require("../lib/pikiio-external-ci-proof");
const ceremonyCli = require("../scripts/pikiio-proof-ceremony");

const BASE_TIME = Date.parse("2026-07-24T01:00:00.000Z");
const REMOTE_URL = "https://github.com/demo-maintainer/Pikiio-app-.git";
const REMOTE_REF =
  "refs/heads/codex/truth-foundation-single-authority";

function digest(value) {
  return ceremony.sha256(String(value));
}

function commit(value) {
  return digest(value).slice(0, 40);
}

function temporaryRoot(label = "pikiio-proof-ceremony-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
  fs.chmodSync(root, 0o700);
  const activationRoot = path.join(root, "activation-dry-run");
  fs.mkdirSync(activationRoot, { mode: 0o700 });
  return { root, activationRoot };
}

function filesystemWriteSnapshot(root) {
  const entries = [];
  function visit(target, relative) {
    const stat = fs.lstatSync(target, { bigint: true });
    entries.push({
      path: relative || ".",
      kind: stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other",
      mode: stat.mode.toString(),
      size: stat.size.toString(),
      nlink: stat.nlink.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      }
    }
  }
  visit(root, "");
  return entries;
}

function metrics() {
  return {
    unit: {
      repeats: 3,
      tests: 65,
      passed: 65,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    },
    coverage: {
      perFileProofSha256: digest("per-file-coverage"),
      lines: 100,
      branches: 100,
      functions: 100,
    },
    gherkin: {
      scenarios: 15,
      passed: 15,
      failed: 0,
      skipped: 0,
      undefined: 0,
      ambiguous: 0,
      pending: 0,
    },
    mutation: {
      total: 20,
      killed: 20,
      survived: 0,
      score: 100,
      criticalTotal: 20,
      criticalKilled: 20,
      survivedCritical: 0,
      criticalIdsSha256: digest("critical-ids"),
      classifierMetaTestsPassed: true,
    },
  };
}

function makeExternalPackage(intent, label = intent.ceremonyId) {
  const run = {
    runId: String((parseInt(label.slice(0, 6), 16) % 900000) + 1),
    runAttempt: "1",
    requestNonce: intent.requestNonce,
  };
  const authority = {
    ref: externalCi.AUTHORITY_WORKFLOW_REF,
    commit: intent.authorityCommit,
    tree: commit(`authority-tree:${intent.authorityCommit}`),
    workflowPath: externalCi.AUTHORITY_WORKFLOW_PATH,
    workflowBlobSha256: digest("workflow-blob"),
    phaseProofRegistrySha256: digest("proof-registry"),
    jwksRegistrySha256: digest("jwks-registry"),
    toolchainSha256: digest("toolchain"),
    ancestorOfScopeVerified: true,
  };
  const phase = {
    phaseId: intent.completedPhaseId,
    scopeBaseCommit: intent.scopeBaseCommit,
    scopeBaseTree: commit(`scope-tree:${intent.scopeBaseCommit}`),
    scopeLedgerSha256: digest(`scope-ledger:${intent.completedPhaseId}`),
    candidateLedgerRevision: intent.ledgerRevision,
    candidateLedgerSha256: digest(`candidate-ledger:${intent.candidateCommit}`),
    qualityPlanSha256: digest(`quality-plan:${intent.completedPhaseId}`),
    commandPlanSha256: digest(`command-plan:${intent.completedPhaseId}`),
  };
  const candidate = {
    commit: intent.candidateCommit,
    tree: intent.candidateTree,
    parent: intent.scopeBaseCommit,
    changedPathsSha256: digest(`changed:${intent.candidateCommit}`),
    diffSha256: digest(`diff:${intent.candidateCommit}`),
    authoritySnapshotSha256: digest(`authority:${intent.authorityCommit}`),
    scopeParentVerified: true,
  };
  const materialization = externalCi.sealMaterializationReceipt({
    repository: externalCi.EXPECTED_REPOSITORY,
    run,
    authority,
    phase,
    candidate,
    sourceManifestSha256: digest(`source-manifest:${label}`),
  });
  const artifactMap = new Map();
  function reference(role, kind) {
    const bytes = Buffer.from(`${role}:${kind}:${label}`, "utf8");
    const artifact = ceremony.packageArtifact(bytes);
    artifactMap.set(artifact.address, artifact);
    return {
      address: artifact.address,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    };
  }
  function judge(role) {
    const evidence = Object.fromEntries(
      ["unitCoverage", "gherkin", "mutation", "stdout", "stderr"].map(
        (kind) => [kind, reference(role, kind)],
      ),
    );
    return externalCi.sealJudgeReceipt({
      role,
      materializationReceiptHash: materialization.receiptHash,
      authorityCommit: intent.authorityCommit,
      phaseId: intent.completedPhaseId,
      phaseScopeBaseCommit: intent.scopeBaseCommit,
      candidateCommit: intent.candidateCommit,
      candidateTree: intent.candidateTree,
      phaseProofRegistrySha256: authority.phaseProofRegistrySha256,
      qualityPlanSha256: phase.qualityPlanSha256,
      commandPlanSha256: phase.commandPlanSha256,
      sourceManifestSha256: materialization.sourceManifestSha256,
      sandbox: {
        imageDigest: `sha256:${digest("judge-image")}`,
        uid: 1000,
        network: "none",
        capabilities: "none",
        readOnlyRoot: true,
        authorityMount: "read_only",
        candidateMount: "read_only",
        credentialKeysPresent: [],
        githubOutputPresent: false,
        freshState: true,
        workspaceBeforeSha256: digest(`${role}:workspace`),
        workspaceAfterSha256: digest(`${role}:workspace`),
      },
      evidence,
      metrics: metrics(),
      outcome: "pass",
    });
  }
  const primaryJudge = judge("primary");
  const independentJudge = judge("independent");
  const manifest = externalCi.evidenceReferences(
    primaryJudge,
    independentJudge,
  );
  const verdict = externalCi.sealQualityVerdict({
    materializationReceiptHash: materialization.receiptHash,
    judgeReceiptHashes: {
      primary: primaryJudge.receiptHash,
      independent: independentJudge.receiptHash,
    },
    evidenceManifestSha256:
      externalCi.evidenceManifestSha256(manifest),
    metrics: metrics(),
    passed: true,
  });
  const attestationBody = externalCi.buildExternalCiAttestationBody({
    materialization,
    primaryJudge,
    independentJudge,
    verdict,
  });
  const jti = `${label.slice(0, 8)}-${label.slice(8, 12)}-4${label.slice(
    13,
    16,
  )}-8${label.slice(17, 20)}-${label.slice(20, 32)}`.replace(
    /[^a-f0-9-]/g,
    "a",
  );
  const replayKeySha256 = externalCi.sha256(
    externalCi.stableJson({
      issuer: externalCi.EXPECTED_OIDC_ISSUER,
      jti,
      repository: externalCi.EXPECTED_REPOSITORY,
      runId: run.runId,
      runAttempt: run.runAttempt,
    }),
  );
  const certification = externalCi.sealExternalCiCertification({
    attestationBody,
    collectorReceipt: {
      schema: "test-github-oidc-receipt-v1",
      runId: run.runId,
      opaqueProof: digest(`oidc:${label}`),
    },
    evidenceManifest: manifest,
    replay: {
      issuer: externalCi.EXPECTED_OIDC_ISSUER,
      jti,
      replayKeySha256,
      multiHostSafe: false,
    },
    verifiedAt: new Date(BASE_TIME).toISOString(),
  });
  return {
    schema: ceremony.PACKAGE_SCHEMA,
    materialization,
    primaryJudge,
    independentJudge,
    verdict,
    certification,
    artifacts: [...artifactMap.values()].sort((left, right) =>
      left.address.localeCompare(right.address),
    ),
    productionAuthority: false,
  };
}

function makeIntent({
  roots,
  label = "phase-one",
  authorityCommit = commit("bootstrap-authority"),
  scopeBaseCommit = commit(`${label}:scope`),
  candidateCommit = commit(`${label}:candidate`),
  completedPhaseId = "GOV-00",
  activatedPhaseId = "TRUTH-01",
  ledgerRevision = 2,
  expectedPreviousActivationPointerHash = null,
  ceremonyId = digest(`${label}:ceremony`),
  controllerId = digest("controller-one"),
  transitionAdapter = ceremony.sealTransitionAdapter({
    canonicalIntegration: false,
    simulationOnly: true,
  }),
} = {}) {
  return {
    intent: ceremony.sealCeremonyIntent({
      ceremonyId,
      controllerId,
      completedPhaseId,
      activatedPhaseId,
      authorityCommit,
      scopeBaseCommit,
      candidateCommit,
      candidateTree: commit(`${label}:candidate-tree`),
      transitionAdapterSha256: transitionAdapter.adapterSha256,
      requestNonce: digest(`${label}:nonce`),
      remoteUrl: REMOTE_URL,
      remoteRef: REMOTE_REF,
      ledgerRevision,
      ledgerSha256: digest(`${label}:ledger`),
      automationContractSha256: digest("automation-contract"),
      allowedPathsSha256: digest(`${activatedPhaseId}:allowed-paths`),
      expectedTransitionPaths: [
        "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json",
        `artifacts/phase-proof/${label}.json`,
      ],
      commitMessage: `Advance ${completedPhaseId} to ${activatedPhaseId}`,
      controllerHost: "pikiio-test-controller",
      controllerLeaseFence: ledgerRevision + 10,
      activationCasRoot: roots.activationRoot,
      expectedPreviousActivationPointerHash,
      createdAt: new Date(BASE_TIME).toISOString(),
    }),
    transitionAdapter,
  };
}

function makeFakeGit(intent) {
  const state = {
    head: intent.candidateCommit,
    dirty: [],
    remote: null,
    commits: new Map([
      [
        intent.candidateCommit,
        {
          parent: intent.scopeBaseCommit,
          tree: intent.candidateTree,
        },
      ],
    ]),
    diffPaths: new Map(),
  };
  return {
    state,
    head: () => state.head,
    tree: ({ commit: commitValue }) => state.commits.get(commitValue)?.tree,
    status: () =>
      Buffer.from(
        state.dirty.map((entry) => ` M ${entry}\0`).join(""),
        "utf8",
      ),
    parent: ({ commit: commitValue }) =>
      state.commits.get(commitValue)?.parent,
    isAncestor: ({ ancestor, descendant }) =>
      ancestor === intent.authorityCommit &&
      descendant === intent.scopeBaseCommit,
    diff: ({ format, from, to }) => {
      assert.equal(format, "name-status-z");
      assert.equal(from, intent.candidateCommit);
      return Buffer.from(
        (state.diffPaths.get(to) || [])
          .map((entry) => `M\0${entry}\0`)
          .join(""),
        "utf8",
      );
    },
    remoteReadback: ({ url, ref }) => {
      assert.equal(url, REMOTE_URL);
      assert.equal(ref, REMOTE_REF);
      return state.remote;
    },
  };
}

function oidcVerifier(packageValue) {
  return (request) => ({
    valid: true,
    attestationBodySha256: request.expectedAttestationBodySha256,
    collectorReceiptSha256:
      packageValue.certification.collectorReceiptSha256,
    authorityCommit: request.expectedAuthorityCommit,
    phaseScopeBaseCommit: request.expectedPhaseScopeBaseCommit,
    candidateCommit: request.expectedCandidateCommit,
    runId: request.expectedRun.runId,
    runAttempt: request.expectedRun.runAttempt,
    requestNonce: request.expectedRun.requestNonce,
    issuer: request.expectedIssuer,
    jti: request.expectedJti,
    replayKeySha256: request.expectedReplayKeySha256,
    productionAuthority: false,
  });
}

function runtimeFor({ roots, intent, transitionAdapter, packageValue, git }) {
  const counts = {
    package: 0,
    oidc: 0,
    transition: 0,
    push: 0,
    host: 0,
  };
  const runtime = {
    root: roots.root,
    intent,
    mode: "dry-run",
    transitionAdapter,
    capability: null,
    sealedGit: git,
    collectExternalPackage: (request) => {
      counts.package += 1;
      assert.equal(request.schema, ceremony.DISPATCH_SCHEMA);
      assert.equal(request.mode, "dry-run");
      assert.equal(request.productionAuthority, false);
      return structuredClone(packageValue);
    },
    verifyOidcCollector: (request) => {
      counts.oidc += 1;
      return oidcVerifier(packageValue)(request);
    },
    canonicalTransition: (request) => {
      counts.transition += 1;
      assert.equal(request.schema, ceremony.TRANSITION_REQUEST_SCHEMA);
      assert.equal(request.completedPhaseId, intent.completedPhaseId);
      assert.equal(request.activatedPhaseId, intent.activatedPhaseId);
      assert.equal(request.productionAuthority, false);
      git.state.dirty = [...intent.expectedTransitionPaths];
      return {
        schema: ceremony.TRANSITION_SCHEMA,
        ceremonyId: request.ceremonyId,
        idempotencyKey: request.idempotencyKey,
        transitionAdapterSha256: request.transitionAdapterSha256,
        completedPhaseId: request.completedPhaseId,
        activatedPhaseId: request.activatedPhaseId,
        baseCommit: request.baseCommit,
        ledgerRevision: request.ledgerRevision,
        changedPaths: [...request.expectedTransitionPaths],
        envelopeHash: request.envelope.envelopeHash,
        replayMarkerHash: request.replayMarker.markerHash,
        productionAuthority: false,
      };
    },
    commitAndPush: (request) => {
      counts.push += 1;
      assert.equal(request.schema, ceremony.PUSH_REQUEST_SCHEMA);
      assert.equal(request.productionAuthority, false);
      const transitionCommit = commit(
        `${intent.ceremonyId}:transition-commit`,
      );
      const transitionTree = commit(
        `${intent.ceremonyId}:transition-tree`,
      );
      git.state.commits.set(transitionCommit, {
        parent: intent.candidateCommit,
        tree: transitionTree,
      });
      git.state.diffPaths.set(
        transitionCommit,
        [...intent.expectedTransitionPaths],
      );
      git.state.head = transitionCommit;
      git.state.dirty = [];
      git.state.remote = transitionCommit;
      return {
        schema: ceremony.PUSH_SCHEMA,
        ceremonyId: request.ceremonyId,
        idempotencyKey: request.idempotencyKey,
        baseCommit: request.baseCommit,
        commit: transitionCommit,
        tree: transitionTree,
        parent: request.baseCommit,
        remoteRef: request.remoteRef,
        changedPaths: [...request.expectedChangedPaths],
        transitionReceiptHash: request.transitionReceiptHash,
        pushed: true,
        productionAuthority: false,
      };
    },
    activationCasRoot: roots.activationRoot,
    validateHostDurability: ({ receipt, context }) => {
      counts.host += 1;
      return {
        valid:
          receipt.schema === "test-host-durability-v1" &&
          receipt.hostname === context.localHost &&
          context.nowMs === BASE_TIME + 5_000,
      };
    },
    hostDurabilityReceipt: {
      schema: "test-host-durability-v1",
      hostname: intent.controllerHost,
      observedAt: new Date(BASE_TIME + 4_000).toISOString(),
      receiptHash: digest(`${intent.ceremonyId}:host`),
    },
    nowMs: BASE_TIME + 5_000,
    faultAfterStage: null,
  };
  return { runtime, counts };
}

function fixture(options = {}) {
  const roots = options.roots || temporaryRoot();
  const built = makeIntent({ roots, ...options });
  const packageValue = makeExternalPackage(built.intent);
  const git = makeFakeGit(built.intent);
  const prepared = runtimeFor({
    roots,
    intent: built.intent,
    transitionAdapter: built.transitionAdapter,
    packageValue,
    git,
  });
  return {
    roots,
    ...built,
    packageValue,
    git,
    ...prepared,
  };
}

async function expectReject(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function resignIntent(intent, patch) {
  const value = { ...intent, ...patch };
  value.intentHash = ceremony.hashWithoutField(value, "intentHash");
  return value;
}

function validCapability(intent) {
  return ceremony.sealCeremonyCapability({
    ceremonyId: intent.ceremonyId,
    controllerId: intent.controllerId,
    intentHash: intent.intentHash,
    allowExternalDispatch: true,
    allowCanonicalTransition: true,
    allowCommitPush: true,
    allowActivation: true,
    expiresAt: new Date(BASE_TIME + 60_000).toISOString(),
  });
}

test("dry-run ceremony completes every typed stage with builder-only authority", async () => {
  const value = fixture();
  const result = await ceremony.runCeremony(value.runtime);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.completedStages, [...ceremony.STAGES]);
  assert.equal(result.builderAuthority, true);
  assert.equal(result.productionAuthority, false);
  assert.match(result.activationReceiptHash, /^[a-f0-9]{64}$/);
  assert.match(result.pointerHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(value.counts, {
    package: 1,
    oidc: 1,
    transition: 1,
    push: 1,
    host: 1,
  });

  const pointer = activationCas.readCurrentPointer(value.roots.activationRoot);
  const receipt = activationCas.readCasObject(
    value.roots.activationRoot,
    "activations",
    pointer.activationReceiptHash,
  );
  assert.equal(receipt.completedPhaseId, "GOV-00");
  assert.equal(receipt.activatedPhaseId, "TRUTH-01");
  assert.equal(receipt.productionAuthority, false);
  assert.equal(
    receipt.casRootIdentitySha256,
    activationCas.casRootIdentitySha256(value.roots.activationRoot),
  );
});

test("every stage crash resumes from its durable slot without repeating callbacks", async () => {
  for (const stage of ceremony.STAGES) {
    const value = fixture();
    await expectReject(
      () =>
        ceremony.runCeremony({
          ...value.runtime,
          faultAfterStage: stage,
        }),
      "INJECTED_STAGE_CRASH",
    );
    const result = await ceremony.runCeremony(value.runtime);
    assert.equal(result.status, "complete", stage);
    assert.deepEqual(
      value.counts,
      {
        package: 1,
        oidc: 1,
        transition: 1,
        push: 1,
        host: 1,
      },
      `callback repeated after ${stage}`,
    );
  }
});

test("the exact completed ceremony repeats three times without drift", async () => {
  const value = fixture();
  const results = [];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    results.push(await ceremony.runCeremony(value.runtime));
  }
  assert.equal(ceremony.stableJson(results[0]), ceremony.stableJson(results[1]));
  assert.equal(ceremony.stableJson(results[1]), ceremony.stableJson(results[2]));
  assert.deepEqual(value.counts, {
    package: 1,
    oidc: 1,
    transition: 1,
    push: 1,
    host: 1,
  });
});

test("one immutable A advances two consecutive S/C phase ceremonies", async () => {
  const roots = temporaryRoot("pikiio-two-phase-");
  const authorityCommit = commit("one-bootstrap-A");
  const first = fixture({
    roots,
    authorityCommit,
    label: "gov-to-truth-one",
    completedPhaseId: "GOV-00",
    activatedPhaseId: "TRUTH-01",
    ledgerRevision: 2,
  });
  const firstResult = await ceremony.runCeremony(first.runtime);
  const firstTransitionCommit = first.git.state.head;

  const second = fixture({
    roots,
    authorityCommit,
    label: "truth-one-to-truth-two",
    scopeBaseCommit: firstTransitionCommit,
    candidateCommit: commit("truth-two-candidate"),
    completedPhaseId: "TRUTH-01",
    activatedPhaseId: "TRUTH-02",
    ledgerRevision: 3,
    expectedPreviousActivationPointerHash: firstResult.pointerHash,
  });
  const secondResult = await ceremony.runCeremony(second.runtime);
  assert.equal(secondResult.status, "complete");
  const pointer = activationCas.readCurrentPointer(roots.activationRoot);
  assert.equal(pointer.sequence, 2);
  assert.equal(pointer.previousPointerHash, firstResult.pointerHash);
  const receipt = activationCas.readCasObject(
    roots.activationRoot,
    "activations",
    pointer.activationReceiptHash,
  );
  assert.equal(receipt.authorityCommit, authorityCommit);
  assert.equal(receipt.completedPhaseId, "TRUTH-01");
  assert.equal(receipt.activatedPhaseId, "TRUTH-02");
  assert.equal(receipt.productionAuthority, false);
});

test("replay is refused for a competing controller and divergent retry forks", async () => {
  const roots = temporaryRoot("pikiio-replay-race-");
  const first = fixture({ roots, label: "replay-anchor" });
  await ceremony.runCeremony(first.runtime);

  const competitorBuilt = makeIntent({
    roots,
    label: "replay-anchor",
    authorityCommit: first.intent.authorityCommit,
    scopeBaseCommit: first.intent.scopeBaseCommit,
    candidateCommit: first.intent.candidateCommit,
    ceremonyId: digest("competitor-ceremony"),
    controllerId: digest("controller-two"),
    expectedPreviousActivationPointerHash:
      activationCas.readCurrentPointer(roots.activationRoot).pointerHash,
  });
  const competitorGit = makeFakeGit(competitorBuilt.intent);
  const competitorRuntime = runtimeFor({
    roots,
    intent: competitorBuilt.intent,
    transitionAdapter: competitorBuilt.transitionAdapter,
    packageValue: first.packageValue,
    git: competitorGit,
  }).runtime;
  await expectReject(
    () => ceremony.runCeremony(competitorRuntime),
    "CAS_COLLISION",
  );

  const fork = ceremony.sealCeremonyIntent({
    ...first.intent,
    commitMessage: "Divergent retry",
    intentHash: undefined,
    productionAuthority: undefined,
    schema: undefined,
    activationCasRootIdentitySha256: undefined,
  });
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...first.runtime,
        intent: fork,
      }),
    "JOURNAL_FORK_REFUSED",
  );
});

test("stale head, injected package fields, and async callbacks fail closed", async () => {
  const stale = fixture();
  stale.git.state.head = commit("moved-head");
  await expectReject(
    () => ceremony.runCeremony(stale.runtime),
    "STALE_HEAD",
  );

  const injected = fixture();
  injected.runtime.collectExternalPackage = () => ({
    ...injected.packageValue,
    forgedVerdict: true,
  });
  await expectReject(
    () => ceremony.runCeremony(injected.runtime),
    "UNEXPECTED_FIELDS",
  );

  const asynchronous = fixture();
  asynchronous.runtime.collectExternalPackage = async () =>
    asynchronous.packageValue;
  await expectReject(
    () => ceremony.runCeremony(asynchronous.runtime),
    "ASYNC_CALLBACK_REFUSED",
  );
});

test("production authority and generic command adapters are always refused", async () => {
  const value = fixture();
  const forgedIntent = {
    ...value.intent,
    productionAuthority: true,
  };
  forgedIntent.intentHash = ceremony.hashWithoutField(
    forgedIntent,
    "intentHash",
  );
  assert.throws(
    () => ceremony.validateIntent(forgedIntent),
    (error) => error.code === "PRODUCTION_AUTHORITY_FORBIDDEN",
  );

  const forgedPackage = {
    ...value.packageValue,
    productionAuthority: true,
  };
  assert.throws(
    () => ceremony.validateExternalPackage(forgedPackage),
    (error) => error.code === "PRODUCTION_AUTHORITY_FORBIDDEN",
  );

  const escaped = fixture();
  escaped.runtime.sealedGit = {
    ...escaped.git,
    exec: () => {},
  };
  await expectReject(
    () => ceremony.runCeremony(escaped.runtime),
    "GENERIC_COMMAND_ESCAPE_REFUSED",
  );
});

test("CAS root identity and transition adapter identity cannot be substituted", async () => {
  const value = fixture();
  const other = temporaryRoot("pikiio-other-cas-");
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        activationCasRoot: other.activationRoot,
      }),
    "ACTIVATION_CAS_ROOT_IDENTITY_MISMATCH",
  );

  const otherAdapter = ceremony.sealTransitionAdapter({
    canonicalIntegration: false,
    simulationOnly: true,
    label: "injected",
  });
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        transitionAdapter: otherAdapter,
      }),
    "UNEXPECTED_FIELDS",
  );
});

test("live mode requires exact capability then refuses absent canonical integration", async () => {
  const value = fixture();
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        mode: "live",
        capability: null,
      }),
    "UNEXPECTED_FIELDS",
  );

  const liveAdapter = ceremony.sealTransitionAdapter({
    canonicalIntegration: true,
    simulationOnly: false,
  });
  const liveIntent = ceremony.sealCeremonyIntent({
    ...value.intent,
    transitionAdapterSha256: liveAdapter.adapterSha256,
    intentHash: undefined,
    productionAuthority: undefined,
    schema: undefined,
    activationCasRootIdentitySha256: undefined,
  });
  const capability = ceremony.sealCeremonyCapability({
    ceremonyId: liveIntent.ceremonyId,
    controllerId: liveIntent.controllerId,
    intentHash: liveIntent.intentHash,
    allowExternalDispatch: true,
    allowCanonicalTransition: true,
    allowCommitPush: true,
    allowActivation: true,
    expiresAt: new Date(BASE_TIME + 60_000).toISOString(),
  });
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        intent: liveIntent,
        transitionAdapter: liveAdapter,
        mode: "live",
        capability,
      }),
    "CANONICAL_V3_TRANSITION_ADAPTER_UNAVAILABLE",
  );
});

test("inspect is filesystem-exact and creates no ceremony state", async () => {
  const roots = temporaryRoot("pikiio-proof-inspect-only-");
  const { intent } = makeIntent({ roots, label: "inspect-only" });
  const intentPath = path.join(roots.root, "intent.json");
  fs.writeFileSync(intentPath, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
  const before = filesystemWriteSnapshot(roots.root);

  assert.deepEqual(
    ceremony.inspectCeremony({ root: roots.root, intent }),
    {
      schema: ceremony.RESULT_SCHEMA,
      ceremonyId: intent.ceremonyId,
      status: "not_started",
      completedStages: [],
      nextStage: ceremony.STAGES[0],
      activationReceiptHash: null,
      pointerHash: null,
      builderAuthority: false,
      productionAuthority: false,
    },
  );
  assert.deepEqual(filesystemWriteSnapshot(roots.root), before);

  const output = [];
  const code = await ceremonyCli.main({
    argv: [`--root=${roots.root}`, `--intent=${intentPath}`],
    write: (text) => output.push(text),
    nowMs: BASE_TIME + 5_000,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(output.pop()).result.status, "not_started");
  assert.deepEqual(filesystemWriteSnapshot(roots.root), before);
  for (const directory of ["objects", "journals", "slots", "replay", "locks"]) {
    assert.equal(fs.existsSync(path.join(roots.root, directory)), false);
  }
});

test("CLI defaults to inspect, dry-run is plan-only, and live needs capability", async () => {
  const value = fixture();
  const intentPath = path.join(value.roots.root, "intent.json");
  fs.writeFileSync(intentPath, `${JSON.stringify(value.intent)}\n`, {
    mode: 0o600,
  });
  const output = [];
  const inspectCode = await ceremonyCli.main({
    argv: [
      `--root=${value.roots.root}`,
      `--intent=${intentPath}`,
    ],
    write: (text) => output.push(text),
    nowMs: BASE_TIME + 5_000,
  });
  assert.equal(inspectCode, 0);
  assert.equal(JSON.parse(output.pop()).result.status, "not_started");

  const dryCode = await ceremonyCli.main({
    argv: [
      "dry-run",
      `--root=${value.roots.root}`,
      `--intent=${intentPath}`,
    ],
    write: (text) => output.push(text),
    nowMs: BASE_TIME + 5_000,
  });
  assert.equal(dryCode, 0);
  const dry = JSON.parse(output.pop());
  assert.equal(dry.result.status, "plan_only");
  assert.equal(dry.result.productionAuthority, false);

  const liveCode = await ceremonyCli.main({
    argv: [
      "live",
      `--root=${value.roots.root}`,
      `--intent=${intentPath}`,
    ],
    write: (text) => output.push(text),
    nowMs: BASE_TIME + 5_000,
  });
  assert.equal(liveCode, 1);
  assert.equal(
    JSON.parse(output.pop()).code,
    "CEREMONY_CAPABILITY_REQUIRED",
  );
});

test("planning and external package validation are exact and non-authorizing", () => {
  const value = fixture();
  const plan = ceremony.planCeremony(value.intent);
  assert.deepEqual(plan.stages, [...ceremony.STAGES]);
  assert.equal(plan.transition, "GOV-00->TRUTH-01");
  assert.equal(plan.builderAuthorityOnly, true);
  assert.equal(plan.productionAuthority, false);
  assert.equal(
    ceremony.validateExternalPackage(value.packageValue).packageValue
      .productionAuthority,
    false,
  );
});

test("intent primitives and phase bindings reject every malformed class", () => {
  const value = fixture();
  const invalidCases = [
    [{ ceremonyId: "bad" }, "INVALID_HASH"],
    [{ authorityCommit: "bad" }, "INVALID_COMMIT"],
    [{ completedPhaseId: "BAD" }, "INVALID_PHASE"],
    [{ activatedPhaseId: value.intent.completedPhaseId }, "PHASE_TRANSITION_EMPTY"],
    [{ scopeBaseCommit: value.intent.authorityCommit }, "COMMIT_ROLE_COLLISION"],
    [{ remoteUrl: "not a URL" }, "INVALID_REMOTE_URL"],
    [{ remoteUrl: "http://example.com/repo.git" }, "INVALID_REMOTE_URL"],
    [{ remoteRef: "refs/heads/bad..ref" }, "INVALID_REMOTE_REF"],
    [{ ledgerRevision: 0 }, "INVALID_INTEGER"],
    [{ expectedTransitionPaths: [] }, "INVALID_PATH_SET"],
    [
      {
        expectedTransitionPaths: [
          value.intent.expectedTransitionPaths[0],
          value.intent.expectedTransitionPaths[0],
        ],
      },
      "NON_CANONICAL_PATH_SET",
    ],
    [{ expectedTransitionPaths: ["../escape"] }, "INVALID_REPOSITORY_PATH"],
    [{ commitMessage: "" }, "INVALID_STRING"],
    [{ commitMessage: "two\nlines" }, "INVALID_COMMIT_MESSAGE"],
    [{ controllerHost: "" }, "INVALID_STRING"],
    [{ controllerLeaseFence: 0 }, "INVALID_INTEGER"],
    [{ activationCasRoot: "relative" }, "ACTIVATION_CAS_ROOT_INVALID"],
    [
      { activationCasRootIdentitySha256: digest("wrong-root") },
      "ACTIVATION_CAS_ROOT_IDENTITY_MISMATCH",
    ],
    [{ expectedPreviousActivationPointerHash: "bad" }, "INVALID_HASH"],
    [{ createdAt: "yesterday" }, "INVALID_TIMESTAMP"],
  ];
  for (const [patch, code] of invalidCases) {
    assert.throws(
      () => ceremony.validateIntent(resignIntent(value.intent, patch)),
      (error) => error.code === code,
      code,
    );
  }
  assert.throws(
    () => ceremony.stableJson(Number.NaN),
    (error) => error.code === "NON_CANONICAL_JSON",
  );
  assert.throws(
    () => ceremony.stableJson(undefined),
    (error) => error.code === "NON_CANONICAL_JSON",
  );
  const wrongSchema = resignIntent(value.intent, { schema: "v0" });
  assert.throws(
    () => ceremony.validateIntent(wrongSchema),
    (error) => error.code === "INVALID_SCHEMA",
  );
  assert.throws(
    () => ceremony.validateIntent({ ...value.intent, extra: true }),
    (error) => error.code === "UNEXPECTED_FIELDS",
  );
  assert.throws(
    () => ceremony.validateIntent({ ...value.intent, intentHash: digest("bad") }),
    (error) => error.code === "HASH_MISMATCH",
  );
});

test("live capability validation is exact, scoped, fresh, and non-production", () => {
  const value = fixture();
  const base = validCapability(value.intent);
  assert.equal(
    ceremony.validateCapability(base, value.intent, BASE_TIME + 5_000)
      .productionAuthority,
    false,
  );
  const cases = [
    [{ schema: "v0" }, "INVALID_SCHEMA"],
    [{ ceremonyId: digest("other") }, "CAPABILITY_SCOPE_MISMATCH"],
    [{ allowExternalDispatch: false }, "CAPABILITY_INCOMPLETE"],
    [{ expiresAt: "bad" }, "INVALID_TIMESTAMP"],
    [
      { expiresAt: new Date(BASE_TIME - 1).toISOString() },
      "CAPABILITY_EXPIRED",
    ],
    [{ productionAuthority: true }, "PRODUCTION_AUTHORITY_FORBIDDEN"],
  ];
  for (const [patch, code] of cases) {
    const candidate = { ...base, ...patch };
    candidate.capabilityHash = ceremony.hashWithoutField(
      candidate,
      "capabilityHash",
    );
    assert.throws(
      () =>
        ceremony.validateCapability(
          candidate,
          value.intent,
          BASE_TIME + 5_000,
        ),
      (error) => error.code === code,
      code,
    );
  }
  assert.throws(
    () =>
      ceremony.validateCapability(
        { ...base, capabilityHash: digest("wrong") },
        value.intent,
        BASE_TIME,
      ),
    (error) => error.code === "HASH_MISMATCH",
  );
});

test("external package artifact transport rejects omission, corruption, and order attacks", () => {
  const value = fixture();
  const first = value.packageValue.artifacts[0];
  const packageCases = [
    [{ schema: "v0" }, "INVALID_SCHEMA"],
    [{ artifacts: [] }, "PACKAGE_ARTIFACT_INVALID"],
    [
      {
        artifacts: value.packageValue.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, schema: "v0" } : artifact,
        ),
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
    [
      {
        artifacts: value.packageValue.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, encoding: "hex" } : artifact,
        ),
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
    [
      {
        artifacts: value.packageValue.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, address: `sha256:${digest("other")}` } : artifact,
        ),
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
    [
      {
        artifacts: value.packageValue.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, bytes: "*" } : artifact,
        ),
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
    [
      {
        artifacts: value.packageValue.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, byteLength: artifact.byteLength + 1 } : artifact,
        ),
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
    [
      {
        artifacts: [first, first],
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
    [
      {
        artifacts: [...value.packageValue.artifacts].reverse(),
      },
      "PACKAGE_ARTIFACT_INVALID",
    ],
  ];
  for (const [patch, code] of packageCases) {
    assert.throws(
      () =>
        ceremony.validateExternalPackage({
          ...value.packageValue,
          ...patch,
        }),
      (error) => error.code === code,
      code,
    );
  }
});

test("typed transition, push, readback, and host boundaries refuse substitutions", async () => {
  const transitionExtra = fixture();
  const originalTransition = transitionExtra.runtime.canonicalTransition;
  transitionExtra.runtime.canonicalTransition = (request) => ({
    ...originalTransition(request),
    injected: true,
  });
  await expectReject(
    () => ceremony.runCeremony(transitionExtra.runtime),
    "UNEXPECTED_FIELDS",
  );

  const transitionBinding = fixture();
  const bindingTransition = transitionBinding.runtime.canonicalTransition;
  transitionBinding.runtime.canonicalTransition = (request) => ({
    ...bindingTransition(request),
    envelopeHash: digest("other-envelope"),
  });
  await expectReject(
    () => ceremony.runCeremony(transitionBinding.runtime),
    "TRANSITION_BINDING_MISMATCH",
  );

  const transitionHead = fixture();
  const headTransition = transitionHead.runtime.canonicalTransition;
  transitionHead.runtime.canonicalTransition = (request) => {
    const result = headTransition(request);
    transitionHead.git.state.head = commit("transition-moved-head");
    return result;
  };
  await expectReject(
    () => ceremony.runCeremony(transitionHead.runtime),
    "STALE_HEAD",
  );

  const pushExtra = fixture();
  const originalPush = pushExtra.runtime.commitAndPush;
  pushExtra.runtime.commitAndPush = (request) => ({
    ...originalPush(request),
    injected: true,
  });
  await expectReject(
    () => ceremony.runCeremony(pushExtra.runtime),
    "UNEXPECTED_FIELDS",
  );

  const remote = fixture();
  const originalRemote = remote.git.remoteReadback;
  remote.git.remoteReadback = (request) => {
    originalRemote(request);
    return commit("remote-diverged");
  };
  await expectReject(
    () => ceremony.runCeremony(remote.runtime),
    "REMOTE_READBACK_MISMATCH",
  );

  const host = fixture();
  host.runtime.validateHostDurability = () => ({ valid: false });
  await assert.rejects(
    () => ceremony.runCeremony(host.runtime),
    (error) => error.code === "HOST_DURABILITY_INVALID",
  );
});

test("run mode, options, fault stage, adapter, and dry-run roots are fail-closed", async () => {
  const value = fixture();
  await expectReject(
    () => ceremony.runCeremony(null),
    "OPTIONS_INVALID",
  );
  await expectReject(
    () => ceremony.runCeremony({ ...value.runtime, unexpected: true }),
    "UNEXPECTED_FIELDS",
  );
  await expectReject(
    () => ceremony.runCeremony({ ...value.runtime, mode: "magic" }),
    "MODE_INVALID",
  );
  await expectReject(
    () => ceremony.runCeremony({ ...value.runtime, nowMs: BASE_TIME - 1 }),
    "NOW_INVALID",
  );
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        faultAfterStage: "unknown",
      }),
    "FAULT_STAGE_INVALID",
  );
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        capability: validCapability(value.intent),
      }),
    "DRY_RUN_CAPABILITY_REFUSED",
  );

  const unsafeAdapter = ceremony.sealTransitionAdapter({
    canonicalIntegration: true,
    simulationOnly: false,
  });
  const unsafeIntent = ceremony.sealCeremonyIntent({
    ...value.intent,
    transitionAdapterSha256: unsafeAdapter.adapterSha256,
  });
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        intent: unsafeIntent,
        transitionAdapter: unsafeAdapter,
      }),
    "DRY_RUN_ADAPTER_INVALID",
  );

  const outside = temporaryRoot("outside-activation-");
  const outsideBuilt = makeIntent({
    roots: outside,
    label: "outside-root",
  });
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...value.runtime,
        intent: outsideBuilt.intent,
        transitionAdapter: outsideBuilt.transitionAdapter,
        activationCasRoot: outside.activationRoot,
      }),
    "DRY_RUN_ACTIVATION_ROOT_UNSAFE",
  );
});

test("journal and lock tampering is detected before any callback resumes", async () => {
  const busy = fixture();
  ceremony.inspectCeremony({
    root: busy.roots.root,
    intent: busy.intent,
  });
  const locks = path.join(busy.roots.root, "locks");
  fs.writeFileSync(
    path.join(locks, `${busy.intent.ceremonyId}.lock`),
    `${JSON.stringify({ lockId: "foreign" })}\n`,
    { mode: 0o600 },
  );
  await expectReject(
    () => ceremony.runCeremony(busy.runtime),
    "CEREMONY_BUSY",
  );

  const tampered = fixture();
  await expectReject(
    () =>
      ceremony.runCeremony({
        ...tampered.runtime,
        faultAfterStage: "candidate",
      }),
    "INJECTED_STAGE_CRASH",
  );
  const journalFile = path.join(
    tampered.roots.root,
    "journals",
    `${tampered.intent.ceremonyId}.json`,
  );
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  journal.revision = 2;
  journal.journalHash = ceremony.hashWithoutField(journal, "journalHash");
  fs.writeFileSync(journalFile, `${ceremony.stableJson(journal)}\n`, {
    mode: 0o600,
  });
  assert.throws(
    () =>
      ceremony.inspectCeremony({
        root: tampered.roots.root,
        intent: tampered.intent,
      }),
    (error) => error.code === "JOURNAL_SEQUENCE_INVALID",
  );
});

test("CLI argument and file safety contracts refuse ambiguous invocation", async () => {
  assert.throws(
    () => ceremonyCli.parseArguments([]),
    (error) => error.code === "CEREMONY_INPUT_REQUIRED",
  );
  assert.throws(
    () => ceremonyCli.parseArguments(["unknown"]),
    (error) => error.code === "CEREMONY_ARGUMENT_INVALID",
  );
  assert.throws(
    () =>
      ceremonyCli.parseArguments([
        "--root=/tmp/a",
        "--root=/tmp/b",
        "--intent=/tmp/i",
      ]),
    (error) => error.code === "CEREMONY_ARGUMENT_DUPLICATE",
  );
  assert.throws(
    () =>
      ceremonyCli.parseArguments([
        "dry-run",
        "--root=/tmp/a",
        "--intent=/tmp/i",
        "--capability=/tmp/c",
      ]),
    (error) => error.code === "CEREMONY_CAPABILITY_REFUSED",
  );
  assert.throws(
    () => ceremonyCli.readJsonFile("relative", "input"),
    (error) => error.code === "CEREMONY_PATH_INVALID",
  );
});

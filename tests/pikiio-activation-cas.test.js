"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const activationCas = require("../lib/pikiio-activation-cas");

const BASE_TIME = Date.parse("2026-07-23T12:00:00.000Z");
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function digest(label) {
  return activationCas.sha256(String(label));
}

function commit(character) {
  return character.repeat(40);
}

function commitFrom(label) {
  return digest(label).slice(0, 40);
}

function temporaryDirectory(prefix = "pikiio-activation-cas-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function hostReceipt({
  observedAt = new Date(BASE_TIME).toISOString(),
  hostname = "pikiio-controller",
  label = observedAt,
} = {}) {
  return {
    schema: "test-host-durability-v1",
    observedAt,
    hostname,
    receiptHash: digest(`host:${hostname}:${label}`),
  };
}

function validateHost(receipt, { nowMs, localHost }) {
  const observedAt = Date.parse(receipt?.observedAt);
  return {
    valid:
      receipt?.schema === "test-host-durability-v1" &&
      receipt?.hostname === localHost &&
      /^[a-f0-9]{64}$/.test(String(receipt?.receiptHash || "")) &&
      Number.isFinite(observedAt) &&
      observedAt <= nowMs &&
      nowMs - observedAt <= FIVE_MINUTES_MS,
    errors: ["test host receipt is invalid"],
  };
}

function buildPhaseFixture({
  completedPhaseId = "GOV-00",
  activatedPhaseId = "TRUTH-01",
  ledgerRevision = 2,
  character = "b",
  createdAt = new Date(BASE_TIME).toISOString(),
  controllerLeaseFence = 9,
} = {}) {
  const ledger = {
    schema: "test-phase-ledger-v1",
    revision: ledgerRevision,
    activePhaseId: activatedPhaseId,
    phases: [
      {
        id: completedPhaseId,
        status: "complete",
        dependsOn: [],
      },
      {
        id: activatedPhaseId,
        status: "active",
        dependsOn: [completedPhaseId],
      },
    ],
  };
  const certification = {
    schema: "test-external-certification-v1",
    phaseId: completedPhaseId,
    scopeBaseCommit: commitFrom(`${completedPhaseId}:${character}:scope`),
    candidateCommit: commitFrom(`${completedPhaseId}:${character}:candidate`),
    authorityCommit: commit("a"),
    attestationBodySha256: digest(`${completedPhaseId}:attestation`),
    qualityVerdictHash: digest(`${completedPhaseId}:quality`),
    evidenceManifestSha256: digest(`${completedPhaseId}:evidence`),
    requestNonce: digest(`${completedPhaseId}:nonce`),
    replayKeySha256: digest(`${completedPhaseId}:replay`),
    productionAuthority: false,
    certificationHash: digest(`${completedPhaseId}:certification`),
  };
  const transitionCommit = commitFrom(
    `${completedPhaseId}:${activatedPhaseId}:${character}:transition`,
  );
  const intentInput = {
    completedPhaseId,
    activatedPhaseId,
    ledgerRevision,
    ledgerSha256: activationCas.sha256(activationCas.stableJson(ledger)),
    scopeBaseCommit: certification.scopeBaseCommit,
    candidateCommit: certification.candidateCommit,
    transitionCommit,
    transitionParent: certification.candidateCommit,
    transitionTree: commitFrom(
      `${completedPhaseId}:${activatedPhaseId}:${character}:tree`,
    ),
    transitionReceiptHash: digest(
      `${completedPhaseId}:${activatedPhaseId}:${character}:transition-receipt`,
    ),
    remoteRef: "refs/heads/codex/truth-foundation-single-authority",
    externalCertificationHash: certification.certificationHash,
    attestationBodySha256: certification.attestationBodySha256,
    qualityVerdictHash: certification.qualityVerdictHash,
    evidenceManifestSha256: certification.evidenceManifestSha256,
    requestNonce: certification.requestNonce,
    automationContractSha256: digest("automation-contract"),
    allowedPathsSha256: digest(`${activatedPhaseId}:allowed-paths`),
    authorityCommit: certification.authorityCommit,
    controllerHost: "pikiio-controller",
    controllerLeaseFence,
    createdAt,
  };
  return {
    phase: { id: activatedPhaseId },
    ledger,
    certification,
    intentInput,
    transitionCommit,
  };
}

function validateCertification(certification) {
  return {
    valid:
      certification?.schema === "test-external-certification-v1" &&
      certification?.productionAuthority === false,
    productionAuthority: certification?.productionAuthority,
    certificationHash: certification?.certificationHash,
    attestationBodySha256: certification?.attestationBodySha256,
    qualityVerdictHash: certification?.qualityVerdictHash,
    evidenceManifestSha256: certification?.evidenceManifestSha256,
    requestNonce: certification?.requestNonce,
    replayKeySha256: certification?.replayKeySha256,
    phaseId: certification?.phaseId,
    scopeBaseCommit: certification?.scopeBaseCommit,
    candidateCommit: certification?.candidateCommit,
    authorityCommit: certification?.authorityCommit,
  };
}

function transitionReadback(fixture, overrides = {}) {
  return {
    commit: fixture.intentInput.transitionCommit,
    parent: fixture.intentInput.transitionParent,
    tree: fixture.intentInput.transitionTree,
    transitionReceiptHash: fixture.intentInput.transitionReceiptHash,
    completedPhaseId: fixture.intentInput.completedPhaseId,
    activatedPhaseId: fixture.intentInput.activatedPhaseId,
    ledgerRevision: fixture.intentInput.ledgerRevision,
    ledgerSha256: fixture.intentInput.ledgerSha256,
    externalCertificationHash:
      fixture.intentInput.externalCertificationHash,
    controllerHost: fixture.intentInput.controllerHost,
    controllerLeaseFence: fixture.intentInput.controllerLeaseFence,
    ...overrides,
  };
}

function issueArguments(casRoot, fixture, overrides = {}) {
  return {
    casRoot,
    certification: fixture.certification,
    ledger: fixture.ledger,
    intentInput: fixture.intentInput,
    validateExternalCertification: validateCertification,
    resolveTransitionReadback: () => transitionReadback(fixture),
    validateHostDurability: validateHost,
    hostDurabilityReceipt: hostReceipt(),
    nowMs: BASE_TIME,
    ...overrides,
  };
}

function validateArguments(casRoot, fixture, nowMs = BASE_TIME) {
  return {
    casRoot,
    ledger: fixture.ledger,
    phase: fixture.phase,
    automationContractSha256: fixture.intentInput.automationContractSha256,
    allowedPathsSha256: fixture.intentInput.allowedPathsSha256,
    resolveTransitionReadback: () => transitionReadback(fixture),
    validateExternalCertification: validateCertification,
    validateHostDurability: validateHost,
    freshHostDurabilityReceipt: hostReceipt({
      observedAt: new Date(nowMs).toISOString(),
      label: `wake:${nowMs}`,
    }),
    nowMs,
  };
}

function expectCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function resign(value, hashField) {
  const copy = { ...value };
  copy[hashField] = activationCas.hashWithoutField(copy, hashField);
  return copy;
}

function overwriteCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${activationCas.stableJson(value)}\n`, {
    mode: 0o600,
  });
}

function recursiveFilesystemSnapshot(root) {
  const entries = [];
  function visit(current, relative) {
    const stat = fs.lstatSync(current, { bigint: true });
    entries.push({
      path: relative || ".",
      mode: stat.mode.toString(),
      nlink: stat.nlink.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current).sort()) {
      visit(path.join(current, name), relative ? `${relative}/${name}` : name);
    }
  }
  visit(root, "");
  return entries;
}

test("CAS identity and read validation never initialize an empty store", () => {
  const casRoot = temporaryDirectory("pikiio-activation-read-only-");
  const fixture = buildPhaseFixture();
  const before = recursiveFilesystemSnapshot(casRoot);

  expectCode(
    () => activationCas.casRootIdentitySha256(casRoot),
    "CAS_GENESIS_MISSING",
  );
  assert.deepEqual(recursiveFilesystemSnapshot(casRoot), before);
  activationCas.initializeCasRootIdentity(casRoot);
  const initialized = recursiveFilesystemSnapshot(casRoot);
  assert.match(
    activationCas.casRootIdentitySha256(casRoot),
    /^[a-f0-9]{64}$/,
  );
  assert.deepEqual(recursiveFilesystemSnapshot(casRoot), initialized);
  expectCode(
    () => activationCas.requireCasRoot(casRoot),
    "CAS_DIRECTORY_UNREADABLE",
  );
  assert.deepEqual(recursiveFilesystemSnapshot(casRoot), initialized);

  const validation = activationCas.validateCurrentActivation(
    validateArguments(casRoot, fixture),
  );
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /CAS_DIRECTORY_UNREADABLE/);
  assert.deepEqual(recursiveFilesystemSnapshot(casRoot), initialized);

  const issued = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );
  assert.equal(issued.ok, true);
  assert.deepEqual(
    fs.readdirSync(casRoot).sort(),
    [
      activationCas.CAS_GENESIS_FILE,
      "activations",
      "advances",
      "certifications",
      "intents",
      "pointers",
      "replay",
    ],
  );
});

test("CAS genesis distinguishes a replaced store at the same absolute path", () => {
  const casRoot = temporaryDirectory("pikiio-activation-genesis-");
  activationCas.ensureCasRoot(casRoot);
  const identity = activationCas.readCasRootIdentity(casRoot);
  const identityHash = activationCas.casRootIdentitySha256(casRoot);
  const originalStat = fs.lstatSync(casRoot, { bigint: true });
  const genesisBytes = fs.readFileSync(
    path.join(casRoot, activationCas.CAS_GENESIS_FILE),
  );
  const displaced = `${casRoot}-displaced`;
  fs.renameSync(casRoot, displaced);
  fs.mkdirSync(casRoot, { mode: 0o700 });
  const replacementStat = fs.lstatSync(casRoot, { bigint: true });
  assert.notEqual(replacementStat.ino, originalStat.ino);

  expectCode(
    () => activationCas.casRootIdentitySha256(casRoot),
    "CAS_GENESIS_MISSING",
  );
  fs.writeFileSync(
    path.join(casRoot, activationCas.CAS_GENESIS_FILE),
    genesisBytes,
    { mode: 0o600, flag: "wx" },
  );
  expectCode(
    () => activationCas.casRootIdentitySha256(casRoot),
    "CAS_GENESIS_IDENTITY_MISMATCH",
  );

  assert.equal(identity.absoluteCanonicalPath, casRoot);
  assert.match(identityHash, /^[a-f0-9]{64}$/);
  fs.renameSync(casRoot, `${casRoot}-replacement`);
  fs.renameSync(displaced, casRoot);
  assert.equal(
    activationCas.casRootIdentitySha256(casRoot),
    identityHash,
  );
});

test("activation is content-addressed, current, repository-only, and not time-expiring", () => {
  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  const result = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );

  assert.equal(result.ok, true);
  assert.equal(result.resumed, false);
  assert.equal(result.pointer.sequence, 1);
  assert.equal(result.pointer.previousPointerHash, null);
  assert.equal(result.activationReceipt.completedPhaseId, "GOV-00");
  assert.equal(result.activationReceipt.activatedPhaseId, "TRUTH-01");
  assert.equal(result.activationReceipt.productionAuthority, false);
  assert.equal(
    result.activationReceipt.authorityClass,
    activationCas.AUTHORITY_CLASS,
  );
  assert.equal(
    result.activationReceipt.validity,
    activationCas.VALIDITY_CLASS,
  );
  assert.equal(
    result.activationReceipt.externalReplayKeySha256,
    fixture.certification.replayKeySha256,
  );
  assert.equal(
    result.activationReceipt.casRootIdentitySha256,
    activationCas.casRootIdentitySha256(casRoot),
  );
  assert.equal(
    activationCas.readCasObject(
      casRoot,
      "activations",
      result.activationReceipt.receiptHash,
    ).receiptHash,
    result.activationReceipt.receiptHash,
  );

  const sixtyDaysLater = BASE_TIME + 60 * 24 * 60 * 60 * 1000;
  const validation = activationCas.validateCurrentActivation(
    validateArguments(casRoot, fixture, sixtyDaysLater),
  );
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.builderAuthority, true);
  assert.equal(validation.productionAuthority, false);
  assert.equal(validation.pointerHash, result.pointer.pointerHash);
});

test("replay and receipt crash points recover only the exact stable intent", () => {
  for (const faultAfter of ["replay", "receipt", "advance"]) {
    const casRoot = temporaryDirectory(`pikiio-activation-${faultAfter}-`);
    const fixture = buildPhaseFixture();
    expectCode(
      () =>
        activationCas.issueActivation(
          issueArguments(casRoot, fixture, { faultAfter }),
        ),
      {
        replay: "INJECTED_CRASH_AFTER_REPLAY",
        receipt: "INJECTED_CRASH_AFTER_RECEIPT",
        advance: "INJECTED_CRASH_AFTER_ADVANCE",
      }[faultAfter],
    );

    const recovered = activationCas.issueActivation(
      issueArguments(casRoot, fixture, { nowMs: BASE_TIME + 60_000 }),
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.resumed, true);
    assert.equal(recovered.pointer.sequence, 1);

    const repeated = activationCas.issueActivation(
      issueArguments(casRoot, fixture, { nowMs: BASE_TIME + 120_000 }),
    );
    assert.equal(repeated.ok, true);
    assert.equal(repeated.resumed, true);
    assert.equal(repeated.pointer.pointerHash, recovered.pointer.pointerHash);
  }

  const divergentRoot = temporaryDirectory("pikiio-activation-divergent-");
  const original = buildPhaseFixture();
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(divergentRoot, original, { faultAfter: "replay" }),
      ),
    "INJECTED_CRASH_AFTER_REPLAY",
  );
  const divergent = buildPhaseFixture({
    createdAt: new Date(BASE_TIME + 1_000).toISOString(),
  });
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(divergentRoot, divergent, {
          nowMs: BASE_TIME + 1_000,
        }),
      ),
    "CAS_COLLISION",
  );
});

test("two consecutive phase activations retain a complete immutable pointer chain", () => {
  const casRoot = temporaryDirectory();
  const firstFixture = buildPhaseFixture({
    completedPhaseId: "GOV-00",
    activatedPhaseId: "TRUTH-01",
    ledgerRevision: 2,
    character: "b",
  });
  const first = activationCas.issueActivation(
    issueArguments(casRoot, firstFixture),
  );
  const secondFixture = buildPhaseFixture({
    completedPhaseId: "TRUTH-01",
    activatedPhaseId: "TRUTH-02",
    ledgerRevision: 3,
    character: "f",
    createdAt: new Date(BASE_TIME + 60_000).toISOString(),
    controllerLeaseFence: 10,
  });
  const second = activationCas.issueActivation(
    issueArguments(casRoot, secondFixture, {
      expectedPreviousPointerHash: first.pointer.pointerHash,
      hostDurabilityReceipt: hostReceipt({
        observedAt: new Date(BASE_TIME + 60_000).toISOString(),
        label: "second",
      }),
      nowMs: BASE_TIME + 60_000,
    }),
  );

  assert.equal(second.pointer.sequence, 2);
  assert.equal(
    second.pointer.previousPointerHash,
    first.pointer.pointerHash,
  );
  const history = activationCas.validatePointerHistory(
    casRoot,
    second.pointer,
  );
  assert.deepEqual(history, { valid: true, errors: [], depth: 2 });
  assert.equal(
    activationCas.readCasObject(
      casRoot,
      "activations",
      first.activationReceipt.receiptHash,
    ).activatedPhaseId,
    "TRUTH-01",
  );
  const validation = activationCas.validateCurrentActivation(
    validateArguments(casRoot, secondFixture, BASE_TIME + 120_000),
  );
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.phaseId, "TRUTH-02");
});

test("activation chain refuses off-path phases, ledger downgrade, and undeclared successors", () => {
  const casRoot = temporaryDirectory();
  const firstFixture = buildPhaseFixture({
    completedPhaseId: "GOV-00",
    activatedPhaseId: "TRUTH-01",
    ledgerRevision: 7,
  });
  const first = activationCas.issueActivation(
    issueArguments(casRoot, firstFixture),
  );
  const pointerBefore = activationCas.readCurrentPointer(casRoot);
  const common = {
    expectedPreviousPointerHash: first.pointer.pointerHash,
    hostDurabilityReceipt: hostReceipt({
      observedAt: new Date(BASE_TIME + 60_000).toISOString(),
      label: "illegal-successor",
    }),
    nowMs: BASE_TIME + 60_000,
  };

  for (const fixture of [
    buildPhaseFixture({
      completedPhaseId: "ACTION-99",
      activatedPhaseId: "GOV-01",
      ledgerRevision: 1,
      character: "c",
      createdAt: new Date(BASE_TIME + 60_000).toISOString(),
    }),
    buildPhaseFixture({
      completedPhaseId: "TRUTH-01",
      activatedPhaseId: "TRUTH-02",
      ledgerRevision: 7,
      character: "d",
      createdAt: new Date(BASE_TIME + 60_000).toISOString(),
    }),
  ]) {
    expectCode(
      () =>
        activationCas.issueActivation(
          issueArguments(casRoot, fixture, common),
        ),
      "ACTIVATION_LEDGER_TRANSITION_INVALID",
    );
    assert.deepEqual(activationCas.readCurrentPointer(casRoot), pointerBefore);
  }

  const undeclared = buildPhaseFixture({
    completedPhaseId: "TRUTH-01",
    activatedPhaseId: "TRUTH-02",
    ledgerRevision: 8,
    character: "e",
    createdAt: new Date(BASE_TIME + 60_000).toISOString(),
  });
  undeclared.ledger.phases[1].dependsOn = [];
  undeclared.intentInput.ledgerSha256 = activationCas.sha256(
    activationCas.stableJson(undeclared.ledger),
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(casRoot, undeclared, common),
      ),
    "ACTIVATION_LEDGER_TRANSITION_INVALID",
  );
  assert.deepEqual(activationCas.readCurrentPointer(casRoot), pointerBefore);

  const wrongOriginRoot = temporaryDirectory();
  const wrongOrigin = buildPhaseFixture({
    completedPhaseId: "TRUTH-01",
    activatedPhaseId: "TRUTH-02",
    ledgerRevision: 2,
    character: "f",
  });
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(wrongOriginRoot, wrongOrigin),
      ),
    "ACTIVATION_LEDGER_TRANSITION_INVALID",
  );
  assert.deepEqual(
    fs.readdirSync(wrongOriginRoot).sort(),
    [
      activationCas.CAS_GENESIS_FILE,
      "activations",
      "advances",
      "certifications",
      "intents",
      "pointers",
      "replay",
    ],
  );
  assert.equal(
    [
      "activations",
      "advances",
      "certifications",
      "intents",
      "pointers",
      "replay",
    ]
      .flatMap((name) =>
        fs.readdirSync(path.join(wrongOriginRoot, name)),
      ).length,
    0,
  );
});

test("pointer compare-and-swap refuses stale controllers without partial writes", () => {
  const casRoot = temporaryDirectory();
  const firstFixture = buildPhaseFixture();
  const first = activationCas.issueActivation(
    issueArguments(casRoot, firstFixture),
  );
  const secondFixture = buildPhaseFixture({
    completedPhaseId: "TRUTH-01",
    activatedPhaseId: "TRUTH-02",
    ledgerRevision: 3,
    character: "f",
    createdAt: new Date(BASE_TIME + 60_000).toISOString(),
  });
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(casRoot, secondFixture, {
          expectedPreviousPointerHash: null,
          hostDurabilityReceipt: hostReceipt({
            observedAt: new Date(BASE_TIME + 60_000).toISOString(),
            label: "stale-controller",
          }),
          nowMs: BASE_TIME + 60_000,
        }),
      ),
    "POINTER_CAS_MISMATCH",
  );
  assert.equal(
    fs.existsSync(
      activationCas.casPath(
        casRoot,
        "certifications",
        secondFixture.certification.certificationHash,
      ),
    ),
    false,
  );
  assert.equal(
    activationCas.readCurrentPointer(casRoot).pointerHash,
    first.pointer.pointerHash,
  );
});

test("external certification and production-authority substitutions fail closed", () => {
  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(casRoot, fixture, {
          validateExternalCertification: (certification) => ({
            ...validateCertification(certification),
            productionAuthority: true,
          }),
        }),
    ),
    "EXTERNAL_CERTIFICATION_INVALID",
  );
  assert.deepEqual(fs.readdirSync(casRoot), [
    activationCas.CAS_GENESIS_FILE,
  ]);

  const issued = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );
  const receiptPath = activationCas.casPath(
    casRoot,
    "activations",
    issued.activationReceipt.receiptHash,
  );
  const forgedBody = {
    ...issued.activationReceipt,
    productionAuthority: true,
  };
  forgedBody.receiptHash = activationCas.hashWithoutField(
    forgedBody,
    "receiptHash",
  );
  fs.writeFileSync(
    receiptPath,
    `${activationCas.stableJson(forgedBody)}\n`,
  );
  const validation = activationCas.validateCurrentActivation(
    validateArguments(casRoot, fixture),
  );
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /ACTIVATION_RECEIPT_INVALID/);
  assert.equal(validation.builderAuthority, false);
  assert.equal(validation.productionAuthority, false);
});

test("remote divergence and stale host evidence revoke current builder authority", () => {
  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  activationCas.issueActivation(issueArguments(casRoot, fixture));

  const remoteDiverged = activationCas.validateCurrentActivation({
    ...validateArguments(casRoot, fixture),
    resolveTransitionReadback: () =>
      transitionReadback(fixture, { commit: commit("e") }),
  });
  assert.equal(remoteDiverged.valid, false);
  assert.match(
    remoteDiverged.errors.join("\n"),
    /TRANSITION_READBACK_MISMATCH/,
  );

  const staleHost = activationCas.validateCurrentActivation({
    ...validateArguments(casRoot, fixture, BASE_TIME + 24 * 60 * 60 * 1000),
    freshHostDurabilityReceipt: hostReceipt({
      observedAt: new Date(BASE_TIME).toISOString(),
      label: "stale",
    }),
  });
  assert.equal(staleHost.valid, false);
  assert.match(staleHost.errors.join("\n"), /FRESH_HOST_REQUIRED/);

  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          resolveTransitionReadback: () =>
            transitionReadback(fixture, { commit: commit("e") }),
        }),
      ),
    "TRANSITION_READBACK_MISMATCH",
  );
});

test("CAS roots, category directories, object files, and pointer history reject aliases and tamper", () => {
  const realRoot = temporaryDirectory();
  const aliasParent = temporaryDirectory();
  const rootAlias = path.join(aliasParent, "activation-alias");
  fs.symlinkSync(realRoot, rootAlias);
  expectCode(
    () => activationCas.ensureCasRoot(rootAlias),
    "CAS_DIRECTORY_INVALID",
  );

  const categoryRoot = temporaryDirectory();
  activationCas.ensureCasRoot(categoryRoot);
  const outside = temporaryDirectory();
  fs.rmSync(path.join(categoryRoot, "replay"), { recursive: true });
  fs.symlinkSync(outside, path.join(categoryRoot, "replay"));
  expectCode(
    () => activationCas.ensureCasRoot(categoryRoot),
    "CAS_DIRECTORY_INVALID",
  );

  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  const issued = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );
  const firstAdvancePath = activationCas.casPath(
    casRoot,
    "advances",
    activationCas.advanceSlotKey(null),
  );
  const firstAdvanceBytes = fs.readFileSync(firstAdvancePath);
  fs.unlinkSync(firstAdvancePath);
  fs.symlinkSync(
    activationCas.casPath(
      casRoot,
      "pointers",
      issued.pointer.pointerHash,
    ),
    firstAdvancePath,
  );
  expectCode(
    () => activationCas.readCurrentPointer(casRoot),
    "CAS_OBJECT_INVALID",
  );
  fs.unlinkSync(firstAdvancePath);
  fs.writeFileSync(firstAdvancePath, firstAdvanceBytes, { mode: 0o600 });

  const previousPointerPath = activationCas.casPath(
    casRoot,
    "pointers",
    issued.pointer.pointerHash,
  );
  const tamperedPointer = {
    ...issued.pointer,
    sequence: 2,
  };
  tamperedPointer.pointerHash = activationCas.hashWithoutField(
    tamperedPointer,
    "pointerHash",
  );
  fs.writeFileSync(
    previousPointerPath,
    `${activationCas.stableJson(tamperedPointer)}\n`,
  );
  expectCode(
    () => activationCas.readCurrentPointer(casRoot),
    "CURRENT_POINTER_INVALID",
  );
  const history = activationCas.validatePointerHistory(
    casRoot,
    issued.pointer,
  );
  assert.equal(history.valid, false);
  assert.match(history.errors.join("\n"), /POINTER_HISTORY_MISMATCH/);
});

test("validators reject unexpected fields and hashes that are merely recomputed", () => {
  const fixture = buildPhaseFixture();
  const casRoot = temporaryDirectory();
  const issued = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );

  const extraIntent = {
    ...activationCas.readCasObject(
      casRoot,
      "intents",
      issued.activationReceipt.activationIntentHash,
    ),
    surprise: true,
  };
  extraIntent.intentHash = activationCas.hashWithoutField(
    extraIntent,
    "intentHash",
  );
  const intentValidation = activationCas.validateIntent(extraIntent);
  assert.equal(intentValidation.valid, false);
  assert.match(intentValidation.errors.join("\n"), /UNEXPECTED_FIELDS/);

  const permissiveReceipt = {
    ...issued.activationReceipt,
    productionAuthority: true,
  };
  permissiveReceipt.receiptHash = activationCas.hashWithoutField(
    permissiveReceipt,
    "receiptHash",
  );
  const receiptValidation =
    activationCas.validateActivationReceipt(permissiveReceipt);
  assert.equal(receiptValidation.valid, false);
  assert.match(
    receiptValidation.errors.join("\n"),
    /ACTIVATION_AUTHORITY_INVALID/,
  );
});

test("canonical JSON and CAS filesystem primitives fail closed on malformed inputs", () => {
  assert.equal(activationCas.stableJson(null), "null");
  assert.equal(
    activationCas.stableJson([true, false, "x", 3]),
    '[true,false,"x",3]',
  );
  expectCode(() => activationCas.stableJson(Number.NaN), "NON_CANONICAL_JSON");
  expectCode(() => activationCas.stableJson(-0), "NON_CANONICAL_JSON");
  expectCode(() => activationCas.stableJson(new Date()), "NON_CANONICAL_JSON");

  expectCode(
    () => activationCas.ensureCasRoot("relative/path"),
    "INVALID_PATH",
  );
  const missingRoot = path.join(temporaryDirectory(), "missing");
  expectCode(
    () => activationCas.ensureCasRoot(missingRoot),
    "CAS_DIRECTORY_UNREADABLE",
  );
  const permissiveRoot = temporaryDirectory();
  fs.chmodSync(permissiveRoot, 0o777);
  expectCode(
    () => activationCas.ensureCasRoot(permissiveRoot),
    "CAS_DIRECTORY_PERMISSIONS_INVALID",
  );
  fs.chmodSync(permissiveRoot, 0o700);

  const casRoot = temporaryDirectory();
  activationCas.ensureCasRoot(casRoot);
  expectCode(
    () => activationCas.casPath(casRoot, "../escape", digest("address")),
    "CAS_CATEGORY_INVALID",
  );
  expectCode(
    () => activationCas.casPath(casRoot, "intents", "not-a-hash"),
    "INVALID_HASH",
  );
  expectCode(
    () =>
      activationCas.writeCasObject(
        casRoot,
        "intents",
        digest("oversized"),
        { data: "x".repeat(2 * 1024 * 1024) },
      ),
    "CAS_OBJECT_SIZE_INVALID",
  );

  const invalidJsonHash = digest("invalid-json");
  const invalidJsonPath = activationCas.casPath(
    casRoot,
    "intents",
    invalidJsonHash,
  );
  fs.writeFileSync(invalidJsonPath, "{\n", { mode: 0o600 });
  expectCode(
    () => activationCas.readCasObject(casRoot, "intents", invalidJsonHash),
    "CAS_JSON_INVALID",
  );
  const nonCanonicalHash = digest("noncanonical-json");
  const nonCanonicalPath = activationCas.casPath(
    casRoot,
    "intents",
    nonCanonicalHash,
  );
  fs.writeFileSync(nonCanonicalPath, '{ "a": 1 }\n', { mode: 0o600 });
  expectCode(
    () => activationCas.readCasObject(casRoot, "intents", nonCanonicalHash),
    "CAS_JSON_NON_CANONICAL",
  );
  const shortHash = digest("short");
  fs.writeFileSync(
    activationCas.casPath(casRoot, "intents", shortHash),
    "",
    { mode: 0o600 },
  );
  expectCode(
    () => activationCas.readCasObject(casRoot, "intents", shortHash),
    "CAS_OBJECT_INVALID",
  );
  const hardLinkHash = digest("hard-link");
  activationCas.writeCasObject(
    casRoot,
    "intents",
    hardLinkHash,
    { safe: true },
  );
  fs.linkSync(
    activationCas.casPath(casRoot, "intents", hardLinkHash),
    path.join(casRoot, "hard-link-copy.json"),
  );
  expectCode(
    () => activationCas.readCasObject(casRoot, "intents", hardLinkHash),
    "CAS_OBJECT_INVALID",
  );
});

test("every activation object validator rejects its typed malformed variants", () => {
  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  const issued = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );
  const intent = activationCas.readCasObject(
    casRoot,
    "intents",
    issued.activationReceipt.activationIntentHash,
  );
  const marker = issued.replayMarker;
  const receipt = issued.activationReceipt;
  const pointer = issued.pointer;
  const cases = [
    [
      activationCas.validateIntent,
      resign({ ...intent, schema: "wrong" }, "intentHash"),
      "INTENT_SCHEMA_INVALID",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, completedPhaseId: "bad" }, "intentHash"),
      "INVALID_PHASE",
    ],
    [
      activationCas.validateIntent,
      resign(
        { ...intent, activatedPhaseId: intent.completedPhaseId },
        "intentHash",
      ),
      "INTENT_PHASE_TRANSITION_INVALID",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, ledgerRevision: 0 }, "intentHash"),
      "INTENT_LEDGER_INVALID",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, ledgerSha256: "bad" }, "intentHash"),
      "INVALID_HASH",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, candidateCommit: "bad" }, "intentHash"),
      "INVALID_COMMIT",
    ],
    [
      activationCas.validateIntent,
      resign(
        { ...intent, transitionParent: commit("f") },
        "intentHash",
      ),
      "INTENT_TRANSITION_PARENT_INVALID",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, remoteRef: "main" }, "intentHash"),
      "INTENT_REMOTE_REF_INVALID",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, controllerLeaseFence: 0 }, "intentHash"),
      "INTENT_CONTROLLER_INVALID",
    ],
    [
      activationCas.validateIntent,
      resign({ ...intent, createdAt: "yesterday" }, "intentHash"),
      "INVALID_TIMESTAMP",
    ],
    [
      activationCas.validateIntent,
      { ...intent, intentHash: digest("wrong-intent") },
      "INTENT_HASH_INVALID",
    ],
    [
      activationCas.validateReplayMarker,
      resign({ ...marker, schema: "wrong" }, "markerHash"),
      "REPLAY_SCHEMA_INVALID",
    ],
    [
      activationCas.validateReplayMarker,
      resign({ ...marker, replayKeySha256: "bad" }, "markerHash"),
      "INVALID_HASH",
    ],
    [
      activationCas.validateReplayMarker,
      resign({ ...marker, activatedPhaseId: "bad" }, "markerHash"),
      "INVALID_PHASE",
    ],
    [
      activationCas.validateReplayMarker,
      resign(
        { ...marker, activatedPhaseId: marker.completedPhaseId },
        "markerHash",
      ),
      "REPLAY_PHASE_TRANSITION_INVALID",
    ],
    [
      activationCas.validateReplayMarker,
      resign({ ...marker, candidateCommit: "bad" }, "markerHash"),
      "INVALID_COMMIT",
    ],
    [
      activationCas.validateReplayMarker,
      resign({ ...marker, multiHostSafe: true }, "markerHash"),
      "REPLAY_SCOPE_INVALID",
    ],
    [
      activationCas.validateReplayMarker,
      resign({ ...marker, consumedAt: "bad" }, "markerHash"),
      "INVALID_TIMESTAMP",
    ],
    [
      activationCas.validateReplayMarker,
      { ...marker, markerHash: digest("wrong-marker") },
      "REPLAY_HASH_INVALID",
    ],
    [
      activationCas.validateActivationReceipt,
      resign({ ...receipt, ledgerRevision: 0 }, "receiptHash"),
      "ACTIVATION_LEDGER_INVALID",
    ],
    [
      activationCas.validateActivationReceipt,
      resign(
        {
          ...receipt,
          activatedPhaseId: receipt.completedPhaseId,
        },
        "receiptHash",
      ),
      "ACTIVATION_PHASE_TRANSITION_INVALID",
    ],
    [
      activationCas.validateActivationReceipt,
      resign({ ...receipt, qualityVerdictHash: "bad" }, "receiptHash"),
      "INVALID_HASH",
    ],
    [
      activationCas.validateActivationReceipt,
      resign({ ...receipt, transitionTree: "bad" }, "receiptHash"),
      "INVALID_COMMIT",
    ],
    [
      activationCas.validateActivationReceipt,
      resign(
        { ...receipt, transitionParent: commit("f") },
        "receiptHash",
      ),
      "ACTIVATION_TRANSITION_PARENT_INVALID",
    ],
    [
      activationCas.validateActivationReceipt,
      resign(
        { ...receipt, remoteReadbackCommit: commit("e") },
        "receiptHash",
      ),
      "ACTIVATION_REMOTE_MISMATCH",
    ],
    [
      activationCas.validateActivationReceipt,
      resign({ ...receipt, remoteRef: "main" }, "receiptHash"),
      "ACTIVATION_REMOTE_REF_INVALID",
    ],
    [
      activationCas.validateActivationReceipt,
      resign({ ...receipt, controllerHost: "" }, "receiptHash"),
      "ACTIVATION_CONTROLLER_INVALID",
    ],
    [
      activationCas.validateActivationReceipt,
      resign({ ...receipt, intentCreatedAt: "bad" }, "receiptHash"),
      "INVALID_TIMESTAMP",
    ],
    [
      activationCas.validateActivationReceipt,
      resign(
        {
          ...receipt,
          issuedAt: new Date(BASE_TIME + 1_000).toISOString(),
        },
        "receiptHash",
      ),
      "ACTIVATION_TIME_MISMATCH",
    ],
    [
      activationCas.validateActivationReceipt,
      { ...receipt, receiptHash: digest("wrong-receipt") },
      "ACTIVATION_HASH_INVALID",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, schema: "wrong" }, "pointerHash"),
      "POINTER_SCHEMA_INVALID",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, sequence: 0 }, "pointerHash"),
      "POINTER_SEQUENCE_INVALID",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, phaseId: "bad" }, "pointerHash"),
      "INVALID_PHASE",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, ledgerRevision: 0 }, "pointerHash"),
      "POINTER_LEDGER_INVALID",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, activationReceiptHash: "bad" }, "pointerHash"),
      "INVALID_HASH",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, previousPointerHash: "bad" }, "pointerHash"),
      "POINTER_PREVIOUS_INVALID",
    ],
    [
      activationCas.validatePointer,
      resign({ ...pointer, updatedAt: "bad" }, "pointerHash"),
      "INVALID_TIMESTAMP",
    ],
    [
      activationCas.validatePointer,
      { ...pointer, pointerHash: digest("wrong-pointer") },
      "POINTER_HASH_INVALID",
    ],
  ];
  for (const [validator, value, expectedCode] of cases) {
    const validation = validator(value);
    assert.equal(validation.valid, false, expectedCode);
    assert.match(validation.errors.join("\n"), new RegExp(expectedCode));
  }
});

test("issuance dependencies and every external binding check fail closed", () => {
  const fixture = buildPhaseFixture();
  expectCode(
    () => activationCas.issueActivation(),
    "EXTERNAL_VALIDATOR_REQUIRED",
  );
  expectCode(
    () =>
      activationCas.issueActivation({
        validateExternalCertification: validateCertification,
      }),
    "TRANSITION_READBACK_REQUIRED",
  );
  expectCode(
    () =>
      activationCas.issueActivation({
        validateExternalCertification: validateCertification,
        resolveTransitionReadback: () => transitionReadback(fixture),
      }),
    "HOST_VALIDATOR_REQUIRED",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, { nowMs: Number.NaN }),
      ),
    "NOW_INVALID",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          intentInput: {
            ...fixture.intentInput,
            casRootIdentitySha256: digest("caller-root"),
          },
        }),
      ),
    "CAS_ROOT_IDENTITY_CALLER_FORBIDDEN",
  );
  const invalidIntentFixture = buildPhaseFixture();
  invalidIntentFixture.intentInput.completedPhaseId = "bad";
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), invalidIntentFixture),
      ),
    "ACTIVATION_INTENT_INVALID",
  );
  const samePhaseFixture = buildPhaseFixture();
  samePhaseFixture.intentInput.activatedPhaseId =
    samePhaseFixture.intentInput.completedPhaseId;
  samePhaseFixture.ledger.activePhaseId =
    samePhaseFixture.intentInput.completedPhaseId;
  samePhaseFixture.intentInput.ledgerSha256 = activationCas.sha256(
    activationCas.stableJson(samePhaseFixture.ledger),
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), samePhaseFixture),
      ),
    "ACTIVATION_INTENT_INVALID",
  );
  const futureFixture = buildPhaseFixture({
    createdAt: new Date(BASE_TIME + 1).toISOString(),
  });
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), futureFixture),
      ),
    "ACTIVATION_INTENT_FUTURE",
  );
  const mismatchedCertification = {
    ...fixture,
    certification: {
      ...fixture.certification,
      certificationHash: digest("different-certification"),
    },
  };
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), mismatchedCertification),
      ),
    "CERTIFICATION_INTENT_MISMATCH",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          hostDurabilityReceipt: { receiptHash: "bad" },
        }),
      ),
    "INVALID_HASH",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          validateExternalCertification: (certification) => ({
            ...validateCertification(certification),
            requestNonce: digest("wrong-nonce"),
          }),
        }),
      ),
    "EXTERNAL_CERTIFICATION_BINDING_MISMATCH",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          resolveTransitionReadback: () =>
            transitionReadback(fixture, { commit: "bad" }),
        }),
      ),
    "INVALID_COMMIT",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          resolveTransitionReadback: () => ({
            ...transitionReadback(fixture),
            extra: true,
          }),
        }),
      ),
    "UNEXPECTED_FIELDS",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          resolveTransitionReadback: () =>
            transitionReadback(fixture, { controllerLeaseFence: 0 }),
        }),
      ),
    "TRANSITION_READBACK_INVALID",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          resolveTransitionReadback: () =>
            transitionReadback(fixture, { controllerLeaseFence: 10 }),
        }),
      ),
    "TRANSITION_READBACK_MISMATCH",
  );
  expectCode(
    () =>
      activationCas.issueActivation(
        issueArguments(temporaryDirectory(), fixture, {
          validateHostDurability: () => ({ valid: false, errors: ["no"] }),
        }),
      ),
    "HOST_DURABILITY_INVALID",
  );

  expectCode(
    () =>
      activationCas.casPath(
        temporaryDirectory(),
        "unknown-valid-category",
        digest("unknown-category"),
      ),
    "CAS_CATEGORY_INVALID",
  );
});

test("current activation validation refuses missing dependencies and every bound-object divergence", () => {
  const emptyRoot = temporaryDirectory();
  activationCas.ensureCasRoot(emptyRoot);
  let validation = activationCas.validateCurrentActivation({
    casRoot: emptyRoot,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /ACTIVATION_DEPENDENCY_MISSING/);

  validation = activationCas.validateCurrentActivation({
    casRoot: emptyRoot,
    resolveTransitionReadback: () => transitionReadback(fixture),
    validateExternalCertification: validateCertification,
    validateHostDurability: validateHost,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /ACTIVATION_POINTER_MISSING/);

  const stateRoot = temporaryDirectory();
  const stateFixture = buildPhaseFixture();
  activationCas.issueActivation(issueArguments(stateRoot, stateFixture));
  validation = activationCas.validateCurrentActivation({
    ...validateArguments(stateRoot, stateFixture),
    ledger: { ...stateFixture.ledger, revision: 99 },
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /ACTIVATION_STATE_MISMATCH/);

  validation = activationCas.validateCurrentActivation({
    ...validateArguments(stateRoot, stateFixture),
    validateExternalCertification: (certification) => ({
      ...validateCertification(certification),
      replayKeySha256: digest("wrong-replay-key"),
    }),
  });
  assert.equal(validation.valid, false);
  assert.match(
    validation.errors.join("\n"),
    /ACTIVATION_REPLAY_KEY_MISMATCH/,
  );

  const intentRoot = temporaryDirectory();
  const intentFixture = buildPhaseFixture();
  const intentIssued = activationCas.issueActivation(
    issueArguments(intentRoot, intentFixture),
  );
  const intentPath = activationCas.casPath(
    intentRoot,
    "intents",
    intentIssued.activationReceipt.activationIntentHash,
  );
  const alteredIntent = resign(
    {
      ...activationCas.readCasObject(
        intentRoot,
        "intents",
        intentIssued.activationReceipt.activationIntentHash,
      ),
      controllerLeaseFence: 999,
    },
    "intentHash",
  );
  overwriteCanonical(intentPath, alteredIntent);
  validation = activationCas.validateCurrentActivation(
    validateArguments(intentRoot, intentFixture),
  );
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /ACTIVATION_INTENT_MISMATCH/);

  const markerRoot = temporaryDirectory();
  const markerFixture = buildPhaseFixture();
  const markerIssued = activationCas.issueActivation(
    issueArguments(markerRoot, markerFixture),
  );
  const markerPath = activationCas.casPath(
    markerRoot,
    "replay",
    markerIssued.activationReceipt.externalReplayKeySha256,
  );
  overwriteCanonical(
    markerPath,
    resign(
      { ...markerIssued.replayMarker, remoteRef: "refs/heads/other" },
      "markerHash",
    ),
  );
  validation = activationCas.validateCurrentActivation(
    validateArguments(markerRoot, markerFixture),
  );
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /ACTIVATION_REPLAY_INVALID/);
});

test("pointer history bounds, discontinuities, and replacement preconditions are enforced", () => {
  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  const first = activationCas.issueActivation(
    issueArguments(casRoot, fixture),
  );

  let history = activationCas.validatePointerHistory(
    casRoot,
    first.pointer,
    0,
  );
  assert.equal(history.valid, false);
  assert.match(history.errors.join("\n"), /POINTER_DEPTH_INVALID/);

  const secondFixture = buildPhaseFixture({
    completedPhaseId: "TRUTH-01",
    activatedPhaseId: "TRUTH-02",
    ledgerRevision: 3,
    character: "7",
    createdAt: new Date(BASE_TIME + 60_000).toISOString(),
  });
  const second = activationCas.issueActivation(
    issueArguments(casRoot, secondFixture, {
      expectedPreviousPointerHash: first.pointer.pointerHash,
      hostDurabilityReceipt: hostReceipt({
        observedAt: new Date(BASE_TIME + 60_000).toISOString(),
        label: "second-for-depth",
      }),
      nowMs: BASE_TIME + 60_000,
    }),
  );
  history = activationCas.validatePointerHistory(casRoot, second.pointer, 1);
  assert.equal(history.valid, false);
  assert.match(history.errors.join("\n"), /POINTER_HISTORY_TOO_DEEP/);
  expectCode(
    () => activationCas.readCurrentPointer(casRoot, 0),
    "POINTER_DEPTH_INVALID",
  );
  expectCode(
    () => activationCas.readCurrentPointer(casRoot, 1),
    "POINTER_HISTORY_TOO_DEEP",
  );

  history = activationCas.validatePointerHistory(casRoot, {
    ...second.pointer,
    schema: "wrong",
  });
  assert.equal(history.valid, false);
  assert.match(history.errors.join("\n"), /POINTER_HISTORY_INVALID/);

  const impossibleFirst = resign(
    {
      ...first.pointer,
      sequence: 2,
      previousPointerHash: null,
    },
    "pointerHash",
  );
  activationCas.writeCasObject(
    casRoot,
    "pointers",
    impossibleFirst.pointerHash,
    impossibleFirst,
  );
  history = activationCas.validatePointerHistory(casRoot, impossibleFirst);
  assert.equal(history.valid, false);
  assert.match(history.errors.join("\n"), /first activation pointer/);

  expectCode(
    () =>
      activationCas.replaceCurrentPointer(
        casRoot,
        { ...second.pointer, sequence: 0 },
        second.pointer.pointerHash,
      ),
    "POINTER_INVALID",
  );
  expectCode(
    () =>
      activationCas.replaceCurrentPointer(
        casRoot,
        second.pointer,
        digest("stale-pointer"),
      ),
    "POINTER_CAS_MISMATCH",
  );

  const currentAdvancePath = activationCas.casPath(
    casRoot,
    "advances",
    activationCas.advanceSlotKey(second.pointer.previousPointerHash),
  );
  const currentAdvance = activationCas.readAdvance(
    casRoot,
    second.pointer.previousPointerHash,
  );
  overwriteCanonical(
    currentAdvancePath,
    resign({ ...currentAdvance, sequence: 0 }, "advanceHash"),
  );
  expectCode(
    () => activationCas.readCurrentPointer(casRoot),
    "CURRENT_ADVANCE_INVALID",
  );
});

test("filesystem race branches are detected and concurrent equal CAS creation is idempotent", () => {
  const raceRoot = temporaryDirectory();
  activationCas.ensureCasRoot(raceRoot);
  const raceHash = digest("race-object");
  activationCas.writeCasObject(
    raceRoot,
    "intents",
    raceHash,
    { race: "baseline" },
  );
  const originalFstatSync = fs.fstatSync;
  let fstatCalls = 0;
  fs.fstatSync = (...args) => {
    const stat = originalFstatSync(...args);
    fstatCalls += 1;
    return fstatCalls === 1 ? { ...stat, size: stat.size + 1n } : stat;
  };
  try {
    expectCode(
      () => activationCas.readCasObject(raceRoot, "intents", raceHash),
      "CAS_OBJECT_CHANGED",
    );
  } finally {
    fs.fstatSync = originalFstatSync;
  }

  fstatCalls = 0;
  fs.fstatSync = (...args) => {
    const stat = originalFstatSync(...args);
    fstatCalls += 1;
    return fstatCalls === 2 ? { ...stat, ctimeNs: stat.ctimeNs + 1n } : stat;
  };
  try {
    expectCode(
      () => activationCas.readCasObject(raceRoot, "intents", raceHash),
      "CAS_OBJECT_CHANGED",
    );
  } finally {
    fs.fstatSync = originalFstatSync;
  }

  const concurrentRoot = temporaryDirectory();
  activationCas.ensureCasRoot(concurrentRoot);
  const concurrentHash = digest("concurrent-equal");
  const originalLinkSync = fs.linkSync;
  fs.linkSync = (temporary, target) => {
    originalLinkSync(temporary, target);
    const error = new Error("simulated concurrent creator");
    error.code = "EEXIST";
    throw error;
  };
  try {
    expectCode(
      () =>
        activationCas.writeCasObject(
          concurrentRoot,
          "intents",
          concurrentHash,
          { concurrent: "equal" },
        ),
      "CAS_OBJECT_INVALID",
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }
  const retried = activationCas.writeCasObject(
    concurrentRoot,
    "intents",
    concurrentHash,
    { concurrent: "equal" },
  );
  assert.equal(retried.created, false);

  const mismatchRoot = temporaryDirectory();
  activationCas.ensureCasRoot(mismatchRoot);
  const mismatchHash = digest("readback-mismatch");
  const originalReadFileSync = fs.readFileSync;
  let descriptorReads = 0;
  fs.readFileSync = (target, ...args) => {
    const bytes = originalReadFileSync(target, ...args);
    if (typeof target === "number") {
      descriptorReads += 1;
    }
    if (typeof target === "number" && descriptorReads === 3) {
      const changed = Buffer.from(bytes);
      changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
      return changed;
    }
    return bytes;
  };
  try {
    expectCode(
      () =>
        activationCas.writeCasObject(
          mismatchRoot,
          "intents",
          mismatchHash,
          { readback: "must-match" },
        ),
      "CAS_READBACK_MISMATCH",
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("advance slots are exact, typed, and derived from their immutable parent", () => {
  const casRoot = temporaryDirectory();
  const fixture = buildPhaseFixture();
  activationCas.issueActivation(issueArguments(casRoot, fixture));
  const advance = activationCas.readAdvance(casRoot, null);
  const variants = [
    [resign({ ...advance, schema: "wrong" }, "advanceHash"), "ADVANCE_SCHEMA_INVALID"],
    [
      resign({ ...advance, slotKeySha256: "bad" }, "advanceHash"),
      "INVALID_HASH",
    ],
    [
      resign({ ...advance, previousPointerHash: "bad" }, "advanceHash"),
      "INVALID_HASH",
    ],
    [
      resign({ ...advance, nextPointerHash: "bad" }, "advanceHash"),
      "INVALID_HASH",
    ],
    [
      resign({ ...advance, sequence: 0 }, "advanceHash"),
      "ADVANCE_SEQUENCE_INVALID",
    ],
    [
      resign({ ...advance, advancedAt: "bad" }, "advanceHash"),
      "INVALID_TIMESTAMP",
    ],
    [
      resign(
        {
          ...advance,
          slotKeySha256: digest("wrong-slot"),
        },
        "advanceHash",
      ),
      "ADVANCE_SLOT_INVALID",
    ],
    [
      { ...advance, advanceHash: digest("wrong-advance") },
      "ADVANCE_HASH_INVALID",
    ],
  ];
  for (const [variant, expectedCode] of variants) {
    const validation = activationCas.validateAdvance(variant);
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), new RegExp(expectedCode));
  }
  const genesisPath = activationCas.casPath(
    casRoot,
    "advances",
    activationCas.advanceSlotKey(null),
  );
  const genesisBytes = fs.readFileSync(genesisPath);
  const differentParent = digest("different-parent");
  overwriteCanonical(
    genesisPath,
    resign(
      {
        ...advance,
        previousPointerHash: differentParent,
        slotKeySha256: activationCas.advanceSlotKey(differentParent),
      },
      "advanceHash",
    ),
  );
  expectCode(
    () => activationCas.readAdvance(casRoot, null),
    "CURRENT_ADVANCE_MISMATCH",
  );
  fs.writeFileSync(genesisPath, genesisBytes, { mode: 0o600 });

  const aliasedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pikiio-cas-alias-"),
  );
  if (fs.realpathSync(aliasedRoot) !== aliasedRoot) {
    expectCode(
      () => activationCas.ensureCasRoot(aliasedRoot),
      "CAS_DIRECTORY_ALIAS_REFUSED",
    );
  }
});

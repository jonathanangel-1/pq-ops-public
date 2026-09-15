#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const sourcePath = process.argv[2];
const ledgerPath = process.argv[3];
const repoRoot = process.argv[4];
const checkId = process.argv[5];

if (!sourcePath || !ledgerPath || !repoRoot || !checkId) process.exit(64);

const metaMode = process.env.PIKIIO_MUTANT_META_MODE || "";
if (metaMode === "crash") process.exit(7);
if (metaMode === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  process.exit(8);
}
if (metaMode === "wrong-fingerprint") {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    reason: "assertion_failed",
    checkId,
    fingerprint: "deliberately-wrong-fingerprint",
  })}\n`);
  process.exit(1);
}

class ProbeAssertion extends Error {
  constructor(fingerprint, details = {}) {
    super(fingerprint);
    this.name = "ProbeAssertion";
    this.fingerprint = fingerprint;
    this.details = details;
  }
}

function expect(value, fingerprint, details = {}) {
  if (!value) throw new ProbeAssertion(fingerprint, details);
}

function expectCode(operation, code, fingerprint) {
  try {
    operation();
  } catch (error) {
    expect(error?.code === code, fingerprint, {
      expectedCode: code,
      actualCode: error?.code || null,
      actualMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  throw new ProbeAssertion(fingerprint, {
    expectedCode: code,
    actualCode: null,
  });
}

async function captureRejection(operation) {
  try {
    return { value: await operation(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadGovernanceWithCanonicalPlanBackstopIsolated(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const canonicalBackstop =
    "  try {\n" +
    "    if (\n" +
    "      stableJson(plan) !==\n" +
    "      stableJson(canonicalLedgerQualityPlan(phaseId))\n" +
    "    ) {\n" +
    "      errors.push(`${prefix} must equal the immutable phase-proof registry plan`);\n" +
    "    }\n" +
    "  } catch {\n" +
    "    errors.push(`${prefix} names a phase absent from the phase-proof registry`);\n" +
    "  }\n";
  const first = source.indexOf(canonicalBackstop);
  if (
    first < 0 ||
    source.indexOf(canonicalBackstop, first + canonicalBackstop.length) >= 0
  ) {
    throw new Error(
      "quality-plan independent mutation probe lost its exact isolation anchor",
    );
  }
  const isolated =
    `${source.slice(0, first)}  void phaseId;\n` +
    source.slice(first + canonicalBackstop.length);
  const loaded = new Module(filePath, module);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  loaded._compile(isolated, filePath);
  return loaded.exports;
}

function tempDirectory(prefix) {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
}

function sign(governance, value, hashField = "receiptHash") {
  const signed = clone(value);
  delete signed[hashField];
  signed[hashField] = governance.sha256(governance.stableJson(signed));
  return signed;
}

function fixedEpoch(governance, hour, minute, second = 0) {
  return governance.zonedDateTimeToEpoch(
    { year: 2026, month: 7, day: 24, hour, minute, second },
    "America/New_York",
  );
}

function rawJudgeArtifactFixture(layerCount, fill) {
  const artifactSha256 = fill.repeat(64);
  return {
    schema: "pikiio-quality-judge-raw-artifact-v1",
    artifactPath: path.join(
      os.tmpdir(),
      "pikiio-quality-judge-artifacts",
      `${artifactSha256}.json`,
    ),
    artifactSha256,
    byteLength: 1024,
    layerCount,
  };
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function hostLaunchctlFixture(host, overrides = {}) {
  const args = overrides.arguments || host.HOST_SERVICE_ARGUMENTS;
  const expectedPath =
    overrides.path ||
    `/workspace/demo/Library/LaunchAgents/${host.HOST_SERVICE_LABEL}.plist`;
  return [
    `gui/501/${host.HOST_SERVICE_LABEL} = {`,
    `\tpath = ${expectedPath}`,
    `\tstate = ${overrides.state || "running"}`,
    `\tprogram = ${overrides.program || host.HOST_SERVICE_PROGRAM}`,
    "\targuments = {",
    ...args.map((argument) => `\t\t${argument}`),
    "\t}",
    `\tpid = ${overrides.pid || 4242}`,
    "\tlast exit code = 0",
    "}",
    "",
  ].join("\n");
}

function hostReceiptFixture(host, overrides = {}) {
  const nowMs = Date.parse("2026-07-24T08:00:00.000Z");
  const expectedPath =
    `/workspace/demo/Library/LaunchAgents/${host.HOST_SERVICE_LABEL}.plist`;
  const servicePlistEvidence = {
    expectedPath,
    resolvedPath: expectedPath,
    readable: true,
    regular: true,
    symlink: false,
    byteLength: host.HOST_SERVICE_PLIST_BYTE_LENGTH,
    sha256: host.HOST_SERVICE_PLIST_SHA256,
    maximumBytes: host.MAXIMUM_HOST_SERVICE_PLIST_BYTES,
    errorCode: null,
    ...(overrides.servicePlistEvidence || {}),
  };
  return host.buildHostDurabilityReceipt({
    observedAt: overrides.observedAt || new Date(nowMs).toISOString(),
    hostname: "operator-mac",
    platform: "darwin",
    architecture: "arm64",
    uid: 501,
    batteryOutput: "Now drawing from 'AC Power'\n100%; charged;",
    pmsetOutput:
      overrides.pmsetOutput ||
      "Battery Power:\n sleep 1\nAC Power:\n sleep 1\n powernap 1\n",
    assertionsOutput:
      overrides.assertionsOutput ||
      [
        "PreventSystemSleep 1",
        "PreventUserIdleSystemSleep 1",
        "pid 4242(caffeinate): PreventSystemSleep",
        "pid 4242(caffeinate): PreventUserIdleSystemSleep",
      ].join("\n"),
    clamshellOutput: '"AppleClamshellState" = No',
    launchctlOutput:
      overrides.launchctlOutput ||
      hostLaunchctlFixture(host, overrides.launchctl || {}),
    expectedPlistPath: expectedPath,
    servicePlistEvidence,
  });
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function oidcFixture(collector, options = {}) {
  const signer = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const attacker = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const publicJwk = signer.publicKey.export({ format: "jwk" });
  const attackerJwk = attacker.publicKey.export({ format: "jwk" });
  const fixedIat = 1_783_000_000;
  const candidate = options.candidate || "b".repeat(40);
  const scopeBase = options.scopeBase || "a".repeat(40);
  const candidateTree = options.candidateTree || "c".repeat(40);
  const ref = "refs/heads/codex/proof-candidate";
  const x5t = crypto
    .createHash("sha1")
    .update("mutation-ephemeral")
    .digest("base64url");
  const digest = (character) => character.repeat(64);
  const artifact = (character) => {
    const value = digest(character);
    return { address: `sha256:${value}`, sha256: value };
  };
  const makeRegistry = (jwk = publicJwk, kid = "github-mutation-2026") => {
    const registry = {
      schema: collector.JWKS_REGISTRY_SCHEMA,
      revision: 1,
      issuer: collector.GITHUB_OIDC_ISSUER,
      keys: [{
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid,
        n: jwk.n,
        e: jwk.e,
        x5t,
      }],
      registrySha256: digest("0"),
    };
    registry.registrySha256 = collector.hashWithoutField(
      registry,
      "registrySha256",
    );
    return registry;
  };
  const registry = makeRegistry();
  const body =
    typeof options.bodyFactory === "function"
      ? options.bodyFactory({ registry })
      : options.body ||
        require(
          path.join(repoRoot, "lib", "pikiio-phase-attestation.js"),
        ).buildAttestationBody({
          phaseId: "TRUTH-01",
          issuerRegistrySha256: digest("1"),
          ledgerRevision: 9,
          ledgerSha256: digest("2"),
          candidateCommit: candidate,
          candidateTree,
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
        });
  const expectedRun = options.expectedRun || {
    eventName: "workflow_dispatch",
    runId: "10001",
    runNumber: "77",
    runAttempt: "1",
    checkRunId: "90001",
  };
  const payload = {
    actor: "demo-maintainer",
    actor_id: "12345",
    aud: collector.expectedAudience(
      require(path.join(repoRoot, "lib", "pikiio-phase-attestation.js"))
        .sha256(
          require(path.join(repoRoot, "lib", "pikiio-phase-attestation.js"))
            .stableJson(body),
        ),
    ),
    base_ref: "",
    check_run_id: expectedRun.checkRunId,
    event_name: expectedRun.eventName,
    exp: fixedIat + 600,
    head_ref: "",
    iat: fixedIat,
    iss: collector.GITHUB_OIDC_ISSUER,
    job_workflow_ref: collector.expectedReusableWorkflowRef(scopeBase),
    job_workflow_sha: scopeBase,
    jti: "123e4567-e89b-42d3-a456-426614174000",
    nbf: fixedIat - 60,
    ref,
    ref_protected: "true",
    ref_type: "branch",
    repository: collector.EXPECTED_REPOSITORY,
    repository_id: "123456789",
    repository_owner: collector.EXPECTED_REPOSITORY_OWNER,
    repository_owner_id: "12345",
    repository_visibility: collector.EXPECTED_REPOSITORY_VISIBILITY,
    run_attempt: expectedRun.runAttempt,
    run_id: expectedRun.runId,
    run_number: expectedRun.runNumber,
    runner_environment: collector.EXPECTED_RUNNER_ENVIRONMENT,
    sha: candidate,
    sub: `repo:${collector.EXPECTED_REPOSITORY}:ref:${ref}`,
    workflow: "Pikiio proof caller",
    workflow_ref:
      `${collector.EXPECTED_REPOSITORY}/.github/workflows/pikiio-proof-caller.yml@${ref}`,
    workflow_sha: candidate,
    ...(options.payload || {}),
  };
  const key =
    options.privateKey === "attacker" ? attacker.privateKey : signer.privateKey;
  const header = {
    alg: "RS256",
    kid: "github-mutation-2026",
    typ: "JWT",
    x5t,
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const oidcToken = `${signingInput}.${crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), key)
    .toString("base64url")}`;
  const requestedAt = new Date(fixedIat * 1000).toISOString();
  const receivedAt = new Date((fixedIat + 1) * 1000).toISOString();
  const receipt = collector.buildGithubOidcCollectorReceipt({
    body,
    scopeBaseCommit: scopeBase,
    jwksRegistrySha256: registry.registrySha256,
    oidcToken,
    requestedAt,
    receivedAt,
  });
  return {
    body,
    candidate,
    scopeBase,
    registry,
    makeRegistry,
    attackerJwk,
    expectedRun,
    receipt,
    receivedAt,
    nowMs: (fixedIat + 2) * 1000,
  };
}

function hashWithoutField(value, field, stableJson, sha256) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function rehashEnvelopeFixture(fixture) {
  const { attestation } = fixture;
  fixture.envelope.externalCertification.certificationHash =
    hashWithoutField(
      fixture.envelope.externalCertification,
      "certificationHash",
      attestation.stableJson,
      attestation.sha256,
    );
  fixture.envelope.envelopeHash = hashWithoutField(
    fixture.envelope,
    "envelopeHash",
    attestation.stableJson,
    attestation.sha256,
  );
}

function envelopeFixture(envelopeModule, options = {}) {
  const attestation = require(path.join(
    repoRoot,
    "lib",
    "pikiio-phase-attestation.js",
  ));
  const collector = require(path.join(
    repoRoot,
    "lib",
    "pikiio-github-oidc-collector.js",
  ));
  const phaseId = "GOV-00";
  const candidateCommit = "b".repeat(40);
  const candidateTree = "c".repeat(40);
  const scopeBaseCommit = "a".repeat(40);
  const ledgerRevision = 2;
  const digest = (label) => attestation.sha256(`envelope-mutant:${label}`);
  const ledgerSha256 = digest("ledger");
  const phaseProofRegistrySha256 = digest("phase-proof-registry");
  const strictQualityReceiptHash = digest("strict-quality");
  const commandPlanHash = digest("command-plan");
  const baselineSnapshotHash = digest("baseline-snapshot");
  const candidateSnapshotHash = digest("candidate-snapshot");
  const authoritySetSha256 = digest("authority-set");
  const rawArtifact = (label) => {
    const bytes = Buffer.from(`envelope mutation raw:${label}`, "utf8");
    const sha256 = attestation.sha256(bytes);
    return {
      address: `sha256:${sha256}`,
      bytes: bytes.toString("base64"),
      encoding: "base64",
      sha256,
    };
  };
  const selfHashReceipt = (fields) => {
    const receipt = { ...fields };
    receipt.receiptHash = attestation.sha256(
      attestation.stableJson(receipt),
    );
    return receipt;
  };
  const primaryRaw = rawArtifact("primary");
  const independentRaw = rawArtifact("independent");
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
  let authorityRegistry;
  const oidc = oidcFixture(collector, {
    candidate: candidateCommit,
    candidateTree,
    scopeBase: scopeBaseCommit,
    privateKey: options.invalidOidcSignature ? "attacker" : undefined,
    bodyFactory({ registry }) {
      authorityRegistry = {
        schema: envelopeModule.ATTESTATION_AUTHORITY_SCHEMA,
        revision: 1,
        mode: "external_collector_required",
        bodySchema: attestation.ATTESTATION_BODY_SCHEMA,
        controller: {
          kind: "local_content_addressed_evidence",
          cryptographicSignature: "optional_non_authorizing",
          localCollectorPrivateKeyAllowed:
            options.localCollectorPrivateKeyAllowed === true,
        },
        collector: {
          kind: "github_actions_oidc",
          issuer: collector.GITHUB_OIDC_ISSUER,
          repository: collector.EXPECTED_REPOSITORY,
          repositoryVisibility: collector.EXPECTED_REPOSITORY_VISIBILITY,
          runnerEnvironment: collector.EXPECTED_RUNNER_ENVIRONMENT,
          workflowPath: collector.REUSABLE_WORKFLOW_PATH,
          workflowRef:
            options.authorityWorkflowRef || collector.REUSABLE_WORKFLOW_REF,
          jwksRegistryPath:
            "YLYI/00_Product_Contract/Pikiio_GitHub_OIDC_JWKS.json",
          jwksRegistrySha256: registry.registrySha256,
        },
        authoritySha256: "0".repeat(64),
      };
      authorityRegistry.authoritySha256 = hashWithoutField(
        authorityRegistry,
        "authoritySha256",
        attestation.stableJson,
        attestation.sha256,
      );
      return collector.reconstructAttestationBodyFromProofInputs({
        schema: collector.COLLECTOR_PROOF_INPUT_SCHEMA,
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
          strictReceiptHash: strictQualityReceiptHash,
          commandPlanHash,
          primaryRawArtifactHash: primaryRaw.sha256,
          independentRawArtifactHash: independentRaw.sha256,
        },
        receiptHashes,
      });
    },
  });
  const receiptArtifact = (receipt) => {
    const unsigned = { ...receipt };
    delete unsigned.receiptHash;
    const bytes = Buffer.from(attestation.stableJson(unsigned), "utf8");
    const sha256 = attestation.sha256(bytes);
    return {
      address: `sha256:${sha256}`,
      bytes: bytes.toString("base64"),
      encoding: "base64",
      sha256,
    };
  };
  const proofBundle = {
    schema: envelopeModule.CORE_PHASE_PROOF_SCHEMA,
    phaseId,
    ledgerRevision,
    candidateCommit,
    qualityReceiptHash: strictQualityReceiptHash,
    chain,
    artifacts: [
      primaryRaw,
      independentRaw,
      ...Object.values(chain).map(receiptArtifact),
    ].sort((left, right) => left.address.localeCompare(right.address)),
    bundleHash: "0".repeat(64),
  };
  proofBundle.bundleHash = hashWithoutField(
    proofBundle,
    "bundleHash",
    attestation.stableJson,
    attestation.sha256,
  );
  const collectorBytes = Buffer.from(
    attestation.stableJson(oidc.receipt),
    "utf8",
  );
  const replayKey =
    `${collector.GITHUB_OIDC_ISSUER}:` +
    "123e4567-e89b-42d3-a456-426614174000";
  const externalCertification = {
    schema: envelopeModule.FROZEN_CERTIFICATION_SCHEMA,
    phaseId,
    scopeBaseCommit,
    candidateCommit,
    candidateTree,
    ledgerRevision,
    ledgerSha256,
    phaseProofRegistrySha256,
    attestationAuthoritySha256: authorityRegistry.authoritySha256,
    jwksRegistrySha256: oidc.registry.registrySha256,
    baselineAuthoritySnapshotHash: baselineSnapshotHash,
    candidateAuthoritySnapshotHash: candidateSnapshotHash,
    authoritySetSha256,
    strictQualityReceiptHash,
    phaseProofBundleHash: proofBundle.bundleHash,
    receiptHashes,
    attestationBody: oidc.body,
    attestationBodySha256: attestation.sha256(
      attestation.stableJson(oidc.body),
    ),
    githubRun: {
      schema: envelopeModule.GITHUB_RUN_SCHEMA,
      eventName: oidc.expectedRun.eventName,
      runId: oidc.expectedRun.runId,
      runNumber: oidc.expectedRun.runNumber,
      runAttempt: oidc.expectedRun.runAttempt,
      checkRunId: oidc.expectedRun.checkRunId,
      repository: collector.EXPECTED_REPOSITORY,
      runnerEnvironment: collector.EXPECTED_RUNNER_ENVIRONMENT,
      githubSha: candidateCommit,
    },
    collectorEvidence: {
      schema: envelopeModule.COLLECTOR_EVIDENCE_SCHEMA,
      encoding: "base64",
      byteLength: collectorBytes.length,
      rawSha256: attestation.sha256(collectorBytes),
      bytes: collectorBytes.toString("base64"),
      receiptHash: oidc.receipt.receiptHash,
    },
    replayProtection: {
      schema: envelopeModule.REPLAY_PROTECTION_SCHEMA,
      replayKey,
      replayKeySha256: attestation.sha256(replayKey),
      consumptionScope: "single-controller-local-runtime",
      multiHostSafe: false,
    },
    verifiedAt: oidc.receivedAt,
    certificationHash: "0".repeat(64),
  };
  externalCertification.certificationHash = hashWithoutField(
    externalCertification,
    "certificationHash",
    attestation.stableJson,
    attestation.sha256,
  );
  const envelope = envelopeModule.assemblePhaseProofEnvelope({
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
    strictQualityReceiptHash,
    coreBundleHash: proofBundle.bundleHash,
  };
  return {
    attestation,
    authorityRegistry,
    envelope,
    expected,
    expectedAuthoritySha256: authorityRegistry.authoritySha256,
    expectedJwksRegistrySha256: oidc.registry.registrySha256,
    jwksRegistry: oidc.registry,
    nowMs: oidc.nowMs,
    input() {
      return {
        envelope,
        authorityRegistry,
        expectedAuthoritySha256: this.expectedAuthoritySha256,
        jwksRegistry: oidc.registry,
        expectedJwksRegistrySha256: oidc.registry.registrySha256,
        expected,
        nowMs: oidc.nowMs,
      };
    },
  };
}

function validateProofCollectorWorkflow(source) {
  const topPermissions = source.match(
    /^permissions:\n((?:  [^\n]+\n)+)\njobs:/m,
  );
  expect(
    topPermissions?.[1] === "  contents: read\n",
    "workflow-global-id-token-privilege-accepted",
  );
  const gauntletStart = source.indexOf("\n  gauntlet:");
  const collectStart = source.indexOf("\n  collect:");
  expect(
    gauntletStart >= 0 && collectStart > gauntletStart,
    "gauntlet-id-token-privilege-accepted",
  );
  const gauntlet = source.slice(gauntletStart, collectStart);
  const collect = source.slice(collectStart);
  expect(
    gauntlet.includes(
      "    permissions:\n      contents: read\n    outputs:",
    ) && !gauntlet.includes("id-token:"),
    "gauntlet-id-token-privilege-accepted",
  );
  expect(
    collect.includes(
      "    permissions:\n      contents: read\n      id-token: write\n    outputs:",
    ) &&
      (source.match(/^\s+id-token: write$/gm) || []).length === 1,
    "collect-without-id-token-accepted",
  );
  expect(
    collect.includes(
      '          cd "${{ steps.checkout.outputs.authority }}"',
    ) &&
      !collect.includes(
        "git -C \"$repo\" checkout --quiet --detach refs/pikiio/candidate",
      ) &&
      !collect.includes('cd "$RUNNER_TEMP/pikiio-proof-repo"'),
    "candidate-execution-in-collect-accepted",
  );
}

function validateProofRequestWorkflow(source) {
  const fixed =
    "uses: demo-maintainer/Pikiio-app-/.github/workflows/" +
    "pikiio-proof-collector.yml@pikiio-proof-authority-v1";
  expect(
    source.includes(fixed) &&
      !source.includes(
        "uses: demo-maintainer/Pikiio-app-/.github/workflows/" +
          "pikiio-proof-collector.yml@main",
      ),
    "moving-request-workflow-ref-accepted",
  );
}

function qualityReceipt(governance, ledger, phase) {
  const profile = governance.effectiveQualityProfile(
    ledger.qualityPolicy.profiles[phase.qualityProfile],
    phase.id,
  );
  const requiredCoverageFiles = [
    ...governance.QUALITY_TEST_SUITE_REGISTRY[
      phase.qualityPlan.testSuiteId
    ].coverageIncludes,
  ].sort();
  const layerPlan = governance.expectedQualityLayerPlan(phase, profile, {
    requiredCoverageFiles,
  });
  const dependencyManifestBody = {
    packageJsonSha256: "1".repeat(64),
    packageLockSha256: "2".repeat(64),
    installedLockSha256: "3".repeat(64),
    name: "mutation-fixture",
    version: "1.0.0",
    dependencies: [],
    problemCount: 0,
    defectCount: 0,
  };
  const dependencyManifest = {
    ...dependencyManifestBody,
    manifestSha256: governance.sha256(
      governance.stableJson(dependencyManifestBody),
    ),
  };
  const automationSnapshotSha256 = "4".repeat(64);
  const layers = layerPlan.map((layer, index) => ({
    ...layer,
    isolation: "macos-sandbox-deny-network",
    status: 0,
    signal: null,
    timedOut: false,
    semanticSha256: String(index).padStart(64, "0").slice(-64),
  }));
  const populations = {
    unit: Array.from({ length: profile.deterministicRepeatCount }, () => ({
      tests: profile.minimumUnitTestsPerRun,
      passed: profile.minimumUnitTestsPerRun,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    })),
    mutation: Array.from({ length: profile.deterministicRepeatCount }, () => ({
      total: profile.minimumMutationPopulation,
      killed: profile.minimumMutationPopulation,
      survived: 0,
      criticalTotal: profile.minimumCriticalMutationPopulation,
      criticalKilled: profile.minimumCriticalMutationPopulation,
      survivedCritical: 0,
      scorePercent: 100,
      criticalKillPercent: 100,
      metaTestsPassed: true,
    })),
    gherkin: Array.from({ length: profile.deterministicRepeatCount }, () => ({
      scenarios: profile.minimumGherkinScenarioPopulation,
      passed: profile.minimumGherkinScenarioPopulation,
      failed: 0,
      skipped: 0,
      undefined: 0,
      ambiguous: 0,
      pending: 0,
      passPercent: 100,
    })),
  };
  return sign(governance, {
    schema: "pikiio-quality-gauntlet-receipt-v5",
    recordedAt: "2026-07-24T04:00:00.000Z",
    ledgerRevision: ledger.revision,
    ledgerSha256: governance.sha256(governance.stableJson(ledger)),
    goalObjectiveSha256: ledger.codexGoal.objectiveSha256,
    phaseId: phase.id,
    phaseProofRegistrySha256: governance.CANONICAL_REGISTRY_SHA256,
    qualityProfile: phase.qualityProfile,
    qualityToolchain: clone(ledger.qualityPolicy.approvedToolchain),
    qualityPlanSha256: governance.sha256(
      governance.stableJson(phase.qualityPlan),
    ),
    commandPlanSha256: governance.sha256(governance.stableJson(layerPlan)),
    scopeBaseCommit: phase.scopeBaseCommit,
    head: "a".repeat(40),
    candidateTree: "a".repeat(40),
    workspaceDigest: "b".repeat(64),
    operationalCheckout: {
      schema: "pikiio-operational-git-visible-evidence-v1",
      scope: "git-visible-worktree-and-index",
      beforeSha256: "5".repeat(64),
      afterSha256: "5".repeat(64),
      unchanged: true,
    },
    automationSnapshotSha256,
    dependencyManifest,
    primaryJudge: {
      worktreeHead: "a".repeat(40),
      worktreeTree: "a".repeat(40),
      workspaceUnchanged: true,
      installIsolation: "macos-sandbox-deny-network",
      auditIsolation: "macos-sandbox-deny-network",
      rawArtifact: rawJudgeArtifactFixture(layerPlan.length, "d"),
    },
    thresholds: clone(profile),
    requiredCoverageFiles,
    metrics: {
      requiredLayersPassed: layers.length,
      testRuns: profile.deterministicRepeatCount,
      testsPerRun: profile.minimumUnitTestsPerRun,
      minimumMutationPopulation: profile.minimumMutationPopulation,
      minimumCriticalMutationPopulation:
        profile.minimumCriticalMutationPopulation,
      minimumGherkinScenarioPopulation:
        profile.minimumGherkinScenarioPopulation,
      mutationClassifierMetaTestsPassed: true,
      deterministicRepeatCount: profile.deterministicRepeatCount,
      failedTests: 0,
      skippedRequiredTests: 0,
      flakyTests: 0,
      newWarnings: 0,
      undefinedGherkinSteps: 0,
      survivedCriticalMutants: 0,
      minimumObservedCoverage: {
        lines: profile.minimumLineCoveragePercent,
        branches: profile.minimumBranchCoveragePercent,
        functions: profile.minimumFunctionCoveragePercent,
      },
      perFileCoverage: (() => {
        const body = {
          requiredFiles: requiredCoverageFiles,
          repeats: Array.from(
            { length: profile.deterministicRepeatCount },
            (_, index) => ({
              repeat: index + 1,
              files: requiredCoverageFiles.map((relativePath) => ({
                path: relativePath,
                lines: profile.minimumLineCoveragePercent,
                branches: profile.minimumBranchCoveragePercent,
                functions: profile.minimumFunctionCoveragePercent,
              })),
            }),
          ),
        };
        return {
          schema: "pikiio-per-file-coverage-proof-v1",
          ...body,
          proofSha256: governance.sha256(governance.stableJson(body)),
        };
      })(),
      minimumObservedMutationScore: 100,
      criticalMutantKillPercent: 100,
      gherkinPassPercent: 100,
      cleanCheckoutReproduced: true,
    },
    populations,
    antiWeakening: {
      scopeBaseCommit: phase.scopeBaseCommit,
      candidateHead: "a".repeat(40),
      sliceDiffSha256: governance.sha256(Buffer.from("")),
      worktreeChangedPaths: [],
      sliceChangedPaths: [],
      auditedPaths: [],
      protectedChanged: [],
      weakeningFindings: [],
      baselineCounts: { tests: 1, assertions: 1, scenarios: 1, mutants: 1 },
      currentCounts: { tests: 1, assertions: 1, scenarios: 1, mutants: 1 },
    },
    cleanJudge: {
      reproduced: true,
      worktreeHead: "a".repeat(40),
      worktreeTree: "a".repeat(40),
      automationSnapshotSha256,
      dependencyManifest: clone(dependencyManifest),
      rawArtifact: rawJudgeArtifactFixture(layerPlan.length, "e"),
      workspaceUnchanged: true,
      semanticSha256: "c".repeat(64),
    },
    layers,
  });
}

function qualityReceiptWithEmbeddedRaw(governance, ledger, phase) {
  const semantic = require(path.join(
    repoRoot,
    "lib",
    "pikiio-quality-canonical.js",
  ));
  let receipt = qualityReceipt(governance, ledger, phase);
  const rawBytes = new Map();
  for (const [label, holder] of [
    ["primary", receipt.primaryJudge],
    ["independent", receipt.cleanJudge],
  ]) {
    const layers = receipt.layers.map((layer) => {
      const rawLayer = {
        name: layer.name,
        checkId: layer.checkId,
        definitionSha256: layer.definitionSha256,
        command: layer.command,
        isolation: layer.isolation,
        startedAt: "2026-07-24T03:59:00.000Z",
        finishedAt: "2026-07-24T03:59:01.000Z",
        status: layer.status,
        signal: layer.signal,
        timedOut: layer.timedOut,
        stdout: "",
        stderr: "",
        parsed: null,
        normalizationRoots: ["/disposable/judge"],
      };
      rawLayer.semanticSha256 = semantic.semanticReceiptSha256(rawLayer);
      layer.semanticSha256 = rawLayer.semanticSha256;
      return rawLayer;
    });
    const raw = {
      schema: "pikiio-quality-judge-raw-artifact-v1",
      label,
      candidateCommit: receipt.head,
      candidateTree: receipt.candidateTree,
      automationSnapshotSha256: receipt.automationSnapshotSha256,
      dependencyManifestSha256: receipt.dependencyManifest.manifestSha256,
      toolchainSha256: receipt.qualityToolchain.toolchainSha256,
      layers,
    };
    const bytes = Buffer.from(governance.stableJson(raw), "utf8");
    const digest = governance.sha256(bytes);
    holder.rawArtifact = {
      schema: "pikiio-quality-judge-raw-artifact-v1",
      artifactPath: path.join(
        os.tmpdir(),
        "pikiio-quality-judge-artifacts",
        `${digest}.json`,
      ),
      artifactSha256: digest,
      byteLength: bytes.length,
      layerCount: layers.length,
    };
    rawBytes.set(`sha256:${digest}`, bytes);
  }
  receipt = sign(governance, receipt);
  return { receipt, rawBytes };
}

function transitionRecoveryFixture(governance, options = {}) {
  const root = tempDirectory("pikiio-transition-recovery-mutant-");
  const ledgerPath = path.join(root, governance.PHASE_LEDGER_RELATIVE_PATH);
  const journalPath = path.join(root, "transition-journal.json");
  const completionHash = "1".repeat(64);
  const bundleHash = "2".repeat(64);
  const completionPath =
    `YLYI/09_Proof_Receipts/phase-completions/${completionHash}.json`;
  const bundlePath =
    `YLYI/09_Proof_Receipts/phase-proofs/${bundleHash}.json`;
  const before = { revision: 1, activePhaseId: "GOV-00" };
  const after = { revision: 2, activePhaseId: "TRUTH-01" };
  const actualLedger = options.divergent
    ? { revision: 99, activePhaseId: "DIVERGED" }
    : before;
  writeJson(ledgerPath, actualLedger);
  const completionBytes = Buffer.from('{"completion":"exact"}\n');
  const bundleBytes = Buffer.from('{"bundle":"exact"}\n');
  if (options.artifacts !== false) {
    fs.mkdirSync(path.dirname(path.join(root, completionPath)), {
      recursive: true,
    });
    fs.mkdirSync(path.dirname(path.join(root, bundlePath)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, completionPath),
      options.tamperCompletion
        ? Buffer.from('{"completion":"evil!"}\n')
        : completionBytes,
    );
    fs.writeFileSync(path.join(root, bundlePath), bundleBytes);
  }
  const body = {
    schema: "pikiio-phase-transition-journal-v1",
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    recordedAt: "2026-07-24T08:00:00.000Z",
    ledgerPath: governance.PHASE_LEDGER_RELATIVE_PATH,
    beforeLedgerSha256: governance.sha256(governance.stableJson(before)),
    afterLedgerSha256: governance.sha256(governance.stableJson(after)),
    completion: {
      path: completionPath,
      bytesSha256: governance.sha256(completionBytes),
      preexisting: options.preexisting === true,
    },
    bundle: {
      path: bundlePath,
      bytesSha256: governance.sha256(bundleBytes),
      preexisting: options.preexisting === true,
    },
  };
  const journal = {
    ...body,
    journalHash: governance.sha256(governance.stableJson(body)),
  };
  writeJson(journalPath, journal);
  return {
    root,
    journalPath,
    completionAbsolute: path.join(root, completionPath),
    bundleAbsolute: path.join(root, bundlePath),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function phaseTransitionFixture(governance, ledger) {
  const before = clone(ledger);
  const previous = before.phases.find(
    (candidate) => candidate.id === before.activePhaseId,
  );
  const next = before.phases.find(
    (candidate) =>
      candidate.id !== previous.id &&
      candidate.status === "planned" &&
      candidate.dependsOn.includes(previous.id),
  );
  expect(Boolean(next), "transition-fixture-next-phase-missing");
  const baseCommit = "a".repeat(40);
  let receipt = qualityReceipt(governance, before, previous);
  receipt.head = baseCommit;
  receipt.candidateTree = baseCommit;
  receipt.workspaceDigest = governance.cleanWorkspaceEvidenceDigest();
  receipt = sign(governance, receipt);
  const receiptPath =
    `YLYI/09_Proof_Receipts/phase-completions/${receipt.receiptHash}.json`;
  const after = clone(before);
  after.revision += 1;
  after.activePhaseId = next.id;
  const afterPrevious = after.phases.find(
    (candidate) => candidate.id === previous.id,
  );
  const afterNext = after.phases.find(
    (candidate) => candidate.id === next.id,
  );
  afterPrevious.status = "complete";
  afterPrevious.lastResult = {
    schema: "pikiio-phase-completion-v1",
    result: "passed",
    head: baseCommit,
    qualityReceiptHash: receipt.receiptHash,
    qualityReceiptPath: receiptPath,
    completedAt: receipt.recordedAt,
  };
  afterNext.status = "active";
  afterNext.scopeBaseCommit = baseCommit;
  return {
    before,
    after,
    previous,
    next,
    baseCommit,
    receipt,
  };
}

function leaseFixture(governance, ledger, options = {}) {
  const root = tempDirectory("pikiio-mutant-lease-");
  const leasePath = path.join(root, "lease.json");
  const fencePath = path.join(root, "fence.json");
  const capability = "a".repeat(64);
  const phase = ledger.phases.find(
    (candidate) => candidate.id === ledger.activePhaseId,
  );
  const lease = governance.acquireWriterLease({
    runId: options.runId || "mutant-owner",
    automationId: "mutation-probe",
    goalId: ledger.codexGoal.objectiveSha256,
    phaseId: phase.id,
    lane: "morning-refresh",
    branch: ledger.baseline.branch,
    startHead: ledger.baseline.startCommit,
    allowedPaths: phase.allowedPaths,
    capability,
    leasePath,
    fencePath,
    nowMs: options.nowMs ?? 1_000,
    leaseMs: options.leaseMs ?? 2_000,
    maximumLeaseMs: options.maximumLeaseMs ?? 10_000,
  });
  return {
    root,
    leasePath,
    fencePath,
    capability,
    lease,
    cleanup() {
      try {
        governance.releaseWriterLease(lease, { capability, leasePath });
      } catch {
        // A targeted refusal may intentionally replace or expire lease state.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function runCheck(governance, ledger) {
  const phase = ledger.phases.find(
    (candidate) => candidate.id === ledger.activePhaseId,
  );
  switch (checkId) {
    case "policy-one-writer": {
      const unsafe = clone(ledger);
      unsafe.policy.oneWriter = false;
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "unsafe-one-writer-policy-accepted",
      );
      return;
    }
    case "forbidden-effect-set": {
      const unsafe = clone(ledger);
      unsafe.policy.forbiddenExternalEffects =
        unsafe.policy.forbiddenExternalEffects.filter(
          (effect) => effect !== "gmail_send",
        );
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "gmail-send-denial-removed",
      );
      return;
    }
    case "active-phase-cardinality": {
      const multiple = clone(ledger);
      multiple.phases[1].status = "active";
      multiple.phases[1].scopeBaseCommit = phase.scopeBaseCommit;
      expect(
        governance.validatePhaseLedger(multiple).valid === false,
        "multiple-active-phases-accepted",
      );
      return;
    }
    case "goal-required": {
      const result = governance.evaluateGoalGuard({ ledger, repoRoot });
      expect(
        result.code === "CODEX_GOAL_REQUIRED",
        "missing-controller-goal-accepted",
        { result },
      );
      return;
    }
    case "goal-mismatch": {
      const result = governance.evaluateGoalGuard({
        ledger,
        repoRoot,
        goalObjective: "wrong",
        goalThreadId: ledger.codexGoal.threadId,
      });
      expect(
        result.code === "CODEX_GOAL_MISMATCH",
        "mismatched-controller-goal-accepted",
        { result },
      );
      return;
    }
    case "repository-wide-scope": {
      const unsafe = clone(ledger);
      unsafe.phases[0].allowedPaths = ["*"];
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "repository-wide-write-scope-accepted",
      );
      return;
    }
    case "baseline-path-traversal": {
      const unsafe = clone(ledger);
      unsafe.baseline.preExistingDirty[0].path = "../outside/";
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "baseline-path-traversal-accepted",
      );
      return;
    }
    case "required-command-layer": {
      const unsafe = clone(ledger);
      unsafe.phases[0].qualityPlan.focusedCheckIds = [];
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "empty-required-command-layer-accepted",
      );
      return;
    }
    case "rename-source-scope": {
      const candidate = clone(ledger);
      candidate.baseline.preExistingDirty = [];
      const active = candidate.phases[0];
      active.allowedPaths = ["allowed.js"];
      const result = governance.evaluateDirtyGuard({
        ledger: candidate,
        phase: active,
        repoRoot,
        statusOutput: "R  forbidden.js -> allowed.js\n",
        committedOutput: "",
      });
      expect(result.ok === false, "rename-source-scope-bypassed", { result });
      return;
    }
    case "committed-scope": {
      const candidate = clone(ledger);
      candidate.baseline.preExistingDirty = [];
      const active = candidate.phases[0];
      active.allowedPaths = ["allowed.js"];
      const result = governance.evaluateDirtyGuard({
        ledger: candidate,
        phase: active,
        repoRoot,
        statusOutput: "",
        committedOutput: "M\tforbidden.js\n",
      });
      expect(result.ok === false, "committed-scope-bypassed", { result });
      return;
    }
    case "pinned-baseline-digest": {
      const root = tempDirectory("pikiio-mutant-baseline-");
      try {
        fs.mkdirSync(path.join(root, "baseline"));
        fs.writeFileSync(path.join(root, "baseline", "receipt"), "before");
        const digest = governance.digestTree(root, "baseline");
        const candidate = clone(ledger);
        candidate.baseline.preExistingDirty = [{
          path: "baseline/",
          ...digest,
          preserve: true,
          excludeFromGit: true,
          excludeFromDeploy: true,
        }];
        fs.writeFileSync(path.join(root, "baseline", "receipt"), "after");
        const result = governance.evaluateDirtyGuard({
          ledger: candidate,
          phase: candidate.phases[0],
          repoRoot: root,
          statusOutput: "",
          committedOutput: "",
        });
        expect(result.ok === false, "changed-pinned-baseline-accepted", { result });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "nested-live-pid": {
      expect(
        governance.shouldReclaimNestedTmsLock({
          ageExpired: true,
          pidPresent: true,
          pidIsAlive: true,
        }) === false,
        "live-nested-tms-owner-reclaimed",
      );
      return;
    }
    case "async-operation-lock": {
      const root = tempDirectory("pikiio-mutant-operation-");
      const lockPath = path.join(root, "operation.lock");
      try {
        expectCode(
          () => governance.withOperationLock(lockPath, () => Promise.resolve()),
          "ASYNC_OPERATION_LOCK_CALLBACK_REFUSED",
          "async-callback-released-synchronous-lock",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "morning-boundary": {
      const root = tempDirectory("pikiio-mutant-morning-");
      try {
        const result = governance.evaluateMorningPriority({
          lane: "autonomy-governance",
          requestedLeaseMs: 60_000,
          nowMs: fixedEpoch(governance, 5, 45),
          morningReceiptDir: root,
        });
        expect(
          result.code === "MORNING_PRIORITY_WINDOW_ACTIVE",
          "morning-boundary-write-admitted",
          { result },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "future-morning-receipt": {
      const nowMs = fixedEpoch(governance, 6, 0);
      const future = sign(governance, {
        schema: "pikiio-morning-terminal-receipt-v1",
        dateKey: "2026-07-24",
        timeZone: "America/New_York",
        terminal: true,
        runId: "future",
        leaseFence: 1,
        result: "succeeded",
        truthPublished: true,
        startedAt: new Date(nowMs - 60_000).toISOString(),
        finishedAt: new Date(nowMs + 60_000).toISOString(),
        detail: "future-dated",
      });
      expect(
        governance.validateMorningTerminalReceipt(
          future,
          "2026-07-24",
          { nowMs },
        ) === false,
        "future-morning-receipt-accepted",
      );
      return;
    }
    case "lease-maximum": {
      const root = tempDirectory("pikiio-mutant-max-");
      try {
        expectCode(
          () => governance.acquireWriterLease({
            goalId: ledger.codexGoal.objectiveSha256,
            phaseId: phase.id,
            lane: "morning-refresh",
            capability: "a".repeat(64),
            leasePath: path.join(root, "lease.json"),
            fencePath: path.join(root, "fence.json"),
            leaseMs: 1_000,
            maximumLeaseMs: governance.MAXIMUM_LEASE_MS + 1,
          }),
          "WRITER_LEASE_MAXIMUM_INVALID",
          "lease-maximum-ceiling-bypassed",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "lease-capability": {
      const fixture = leaseFixture(governance, ledger);
      try {
        expectCode(
          () => governance.releaseWriterLease(fixture.lease, {
            capability: "b".repeat(64),
            leasePath: fixture.leasePath,
          }),
          "WRITER_LEASE_LOST",
          "foreign-capability-released-lease",
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "lease-metadata": {
      const fixture = leaseFixture(governance, ledger);
      try {
        expectCode(
          () => governance.releaseWriterLease(
            { ...fixture.lease, phaseId: "forged" },
            {
              capability: fixture.capability,
              leasePath: fixture.leasePath,
            },
          ),
          "WRITER_LEASE_LOST",
          "caller-forged-lease-metadata-accepted",
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "lease-expiry": {
      const fixture = leaseFixture(governance, ledger, {
        leaseMs: 1_000,
        maximumLeaseMs: 2_000,
      });
      try {
        expectCode(
          () => governance.renewWriterLease(fixture.lease, {
            capability: fixture.capability,
            leasePath: fixture.leasePath,
            nowMs: 2_001,
            leaseMs: 1_000,
          }),
          "WRITER_LEASE_EXPIRED",
          "expired-lease-renewed",
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "lease-owner-liveness": {
      const fixture = leaseFixture(governance, ledger);
      try {
        expectCode(
          () => governance.renewWriterLease(fixture.lease, {
            capability: fixture.capability,
            leasePath: fixture.leasePath,
            nowMs: 1_500,
            leaseMs: 1_000,
            isPidAlive: () => false,
          }),
          "WRITER_LEASE_OWNER_NOT_LIVE",
          "dead-lease-owner-renewed",
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "proof-receipts-array": {
      const errors = [];
      governance.validateProofDisposition(
        {
          status: "not_applicable",
          receipts: "forged",
          reason: "not exercised",
        },
        "proof",
        errors,
      );
      expect(errors.length > 0, "non-array-proof-receipts-accepted");
      return;
    }
    case "quality-threshold-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.thresholds.minimumLineCoveragePercent -= 1;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "forged-quality-thresholds-accepted",
      );
      return;
    }
    case "quality-suite-registry": {
      const unsafe = clone(ledger);
      unsafe.phases[0].qualityPlan.testSuiteId =
        "unregistered-quality-suite";
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "unknown-quality-suite-accepted",
      );
      return;
    }
    case "quality-scalar-check-registry": {
      const unsafe = clone(ledger);
      unsafe.phases[0].qualityPlan.gherkinCheckId =
        "unregistered-scalar-quality-check";
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "unknown-scalar-quality-check-accepted",
      );
      return;
    }
    case "quality-array-check-registry": {
      const unsafe = clone(ledger);
      unsafe.phases[0].qualityPlan.focusedCheckIds[0] =
        "unregistered-array-quality-check";
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "unknown-array-quality-check-accepted",
      );
      return;
    }
    case "quality-ledger-digest": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.ledgerSha256 = "0".repeat(64);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "forged-quality-ledger-digest-accepted",
      );
      return;
    }
    case "quality-plan-digest": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.qualityPlanSha256 = "0".repeat(64);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "forged-quality-plan-digest-accepted",
      );
      return;
    }
    case "quality-coverage": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.metrics.minimumObservedCoverage.lines = 0;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "low-coverage-quality-receipt-accepted",
      );
      return;
    }
    case "quality-mutation": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.metrics.minimumObservedMutationScore = 0;
      receipt.populations.mutation.forEach((entry) => {
        entry.killed = 0;
        entry.survived = entry.total;
        entry.scorePercent = 0;
      });
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "low-mutation-quality-receipt-accepted",
      );
      return;
    }
    case "quality-unit-population-floor": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.populations.unit.forEach((entry) => {
        Object.assign(entry, {
          tests: 1,
          passed: 1,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          todo: 0,
        });
      });
      receipt.metrics.testsPerRun = 1;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "collapsed-unit-population-accepted",
      );
      return;
    }
    case "quality-mutation-population-floor": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.populations.mutation.forEach((entry) => {
        Object.assign(entry, {
          total: 1,
          killed: 1,
          survived: 0,
          scorePercent: 100,
        });
      });
      receipt.metrics.minimumMutationPopulation = 1;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "collapsed-mutation-population-accepted",
      );
      return;
    }
    case "quality-critical-population-floor": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.populations.mutation.forEach((entry) => {
        Object.assign(entry, {
          criticalTotal: 1,
          criticalKilled: 1,
          survivedCritical: 0,
          criticalKillPercent: 100,
        });
      });
      receipt.metrics.minimumCriticalMutationPopulation = 1;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "collapsed-critical-mutation-population-accepted",
      );
      return;
    }
    case "quality-gherkin-population-floor": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.populations.gherkin.forEach((entry) => {
        Object.assign(entry, {
          scenarios: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          undefined: 0,
          ambiguous: 0,
          pending: 0,
          passPercent: 100,
        });
      });
      receipt.metrics.minimumGherkinScenarioPopulation = 1;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "collapsed-gherkin-population-accepted",
      );
      return;
    }
    case "quality-classifier-meta-summary": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.metrics.mutationClassifierMetaTestsPassed = false;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "failed-classifier-meta-summary-accepted",
      );
      return;
    }
    case "quality-classifier-meta-raw": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.populations.mutation[0].metaTestsPassed = false;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "failed-raw-classifier-meta-test-accepted",
      );
      return;
    }
    case "quality-layer-plan": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.layers.reverse();
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "wrong-quality-layer-plan-accepted",
      );
      return;
    }
    case "quality-layer-definition-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.layers[0].definitionSha256 = "0".repeat(64);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "forged-layer-definition-digest-accepted",
      );
      return;
    }
    case "quality-command-plan-digest": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.commandPlanSha256 = "0".repeat(64);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "forged-command-plan-digest-accepted",
      );
      return;
    }
    case "automation-contract-binding": {
      const unsafe = clone(ledger);
      unsafe.automationContract.promptSha256 = "0".repeat(64);
      expect(
        governance.validatePhaseLedger(unsafe).valid === false,
        "forged-automation-contract-accepted",
      );
      return;
    }
    case "quality-operational-checkout-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.operationalCheckout.afterSha256 = "0".repeat(64);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "changed-operational-checkout-accepted",
      );
      return;
    }
    case "quality-approved-toolchain-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.qualityToolchain.nodeVersion = "v0.0.0-unapproved";
      const unsignedToolchain = clone(receipt.qualityToolchain);
      delete unsignedToolchain.toolchainSha256;
      receipt.qualityToolchain.toolchainSha256 = governance.sha256(
        governance.stableJson(unsignedToolchain),
      );
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "unapproved-quality-toolchain-accepted",
      );
      return;
    }
    case "quality-operational-scope-qualifiers": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.operationalCheckout.schema =
        "pikiio-operational-evidence-unqualified";
      receipt.operationalCheckout.scope = "unspecified";
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "unqualified-operational-evidence-accepted",
      );
      return;
    }
    case "quality-canonical-transition-recomputation": {
      const root = tempDirectory("pikiio-mutant-canonical-transition-");
      try {
        const git = (...args) =>
          execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: "2026-07-24T04:00:00Z",
              GIT_COMMITTER_DATE: "2026-07-24T04:00:00Z",
            },
          }).trim();
        git("init", "--quiet");
        git("config", "user.name", "Pikiio mutation probe");
        git("config", "user.email", "contact-f7f137f1@company-31f54836.example");
        git("config", "commit.gpgsign", "false");
        const trustedPath =
          "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json";
        writeJson(path.join(root, trustedPath), { revision: 0 });
        git("add", trustedPath);
        git("commit", "--quiet", "-m", "mutation base");
        const scopeBaseCommit = git("rev-parse", "HEAD");
        writeJson(path.join(root, trustedPath), { revision: 1 });
        git("add", trustedPath);
        git("commit", "--quiet", "-m", "noncanonical transition");
        const head = git("rev-parse", "HEAD");
        const candidateTree = git("rev-parse", "HEAD^{tree}");
        const sliceDiffSha256 = governance.sha256(
          execFileSync(
            "git",
            ["diff", "--binary", `${scopeBaseCommit}..${head}`],
            { cwd: root },
          ),
        );
        const candidateLedger = clone(ledger);
        const candidatePhase = candidateLedger.phases.find(
          (entry) => entry.lane !== "autonomy-governance",
        );
        expect(
          Boolean(candidatePhase),
          "self-asserted-canonical-transition-accepted",
          { reason: "fixture requires a non-governance phase" },
        );
        candidatePhase.scopeBaseCommit = scopeBaseCommit;
        let receipt = qualityReceipt(
          governance,
          candidateLedger,
          candidatePhase,
        );
        receipt.head = head;
        receipt.candidateTree = candidateTree;
        receipt.primaryJudge.worktreeHead = head;
        receipt.primaryJudge.worktreeTree = candidateTree;
        receipt.cleanJudge.worktreeHead = head;
        receipt.cleanJudge.worktreeTree = candidateTree;
        receipt.antiWeakening.scopeBaseCommit = scopeBaseCommit;
        receipt.antiWeakening.candidateHead = head;
        receipt.antiWeakening.sliceDiffSha256 = sliceDiffSha256;
        receipt.antiWeakening.sliceChangedPaths = [trustedPath];
        receipt.antiWeakening.auditedPaths = [trustedPath];
        receipt.antiWeakening.protectedChanged = [trustedPath];
        receipt.antiWeakening.canonicalTransition = { ok: true };
        receipt = sign(governance, receipt);
        const result = governance.validateQualityReceipt(receipt, {
          ledger: candidateLedger,
          phase: candidatePhase,
          repoRoot: root,
          verifyRawArtifacts: false,
          nowMs: Date.parse("2026-07-24T04:00:00.000Z"),
          externalProofValidator: () => {
            throw new Error("must not reach external proof validation");
          },
        });
        expect(
          result.valid === false &&
            result.errors.length === 1 &&
            result.errors[0] ===
              "quality receipt canonical transition evidence cannot be reproduced",
          "self-asserted-canonical-transition-accepted",
          { result },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "quality-raw-artifact-address-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.primaryJudge.rawArtifact.layerCount =
        receipt.layers.length + 1;
      receipt.primaryJudge.rawArtifact.artifactPath = path.join(
        os.tmpdir(),
        "pikiio-quality-judge-artifacts",
        "not-content-addressed.json",
      );
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "misaddressed-raw-artifact-accepted",
      );
      return;
    }
    case "quality-independent-raw-artifact-required": {
      let receipt = qualityReceipt(governance, ledger, phase);
      delete receipt.cleanJudge.rawArtifact;
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "missing-independent-raw-artifact-accepted",
      );
      return;
    }
    case "quality-dependency-manifest-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.dependencyManifest.name = "forged-dependency-set";
      receipt.cleanJudge.dependencyManifest.name = "forged-dependency-set";
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "forged-dependency-manifest-accepted",
      );
      return;
    }
    case "quality-primary-judge-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.primaryJudge.worktreeHead = "0".repeat(40);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "wrong-primary-judge-head-accepted",
      );
      return;
    }
    case "quality-independent-snapshot-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.cleanJudge.automationSnapshotSha256 = "0".repeat(64);
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "wrong-independent-snapshot-accepted",
      );
      return;
    }
    case "quality-independent-dependency-binding": {
      let receipt = qualityReceipt(governance, ledger, phase);
      receipt.cleanJudge.dependencyManifest.dependencies = [
        {
          name: "divergent-dependency",
          version: "9.9.9",
          resolved: null,
          overridden: false,
        },
      ];
      receipt = sign(governance, receipt);
      expect(
        governance.validateQualityReceipt(receipt, {
          ledger,
          phase,
          head: receipt.head,
          workspaceDigest: receipt.workspaceDigest,
        }).valid === false,
        "divergent-independent-dependencies-accepted",
      );
      return;
    }
    case "phase-proof-scope-base-authority": {
      const registry = JSON.parse(
        fs.readFileSync(
          path.join(
            repoRoot,
            "YLYI",
            "00_Product_Contract",
            "Pikiio_Phase_Proof_Registry.json",
          ),
          "utf8",
        ),
      );
      for (const phaseProof of Object.values(registry.phases)) {
        phaseProof.receiptPolicy.authorityBaseline = "candidate";
      }
      const result = governance.validatePhaseProofRegistry(registry, {
        requireCanonical: false,
      });
      expect(
        result.valid === false,
        "candidate-owned-authority-baseline-accepted",
        { errors: result.errors },
      );
      return;
    }
    case "oidc-jwks-registry-pin": {
      const fixture = oidcFixture(governance, { privateKey: "attacker" });
      const substituted = fixture.makeRegistry(fixture.attackerJwk);
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: substituted,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "JWKS_REGISTRY_HASH_MISMATCH",
        "substituted-jwks-registry-accepted",
      );
      return;
    }
    case "oidc-signature-verification": {
      const fixture = oidcFixture(governance, { privateKey: "attacker" });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "SIGNATURE_VERIFICATION_FAILED",
        "invalid-oidc-signature-accepted",
      );
      return;
    }
    case "oidc-audience-binding": {
      const fixture = oidcFixture(governance, {
        payload: { aud: `pikiio-proof:${"f".repeat(64)}` },
      });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "OIDC_IDENTITY_MISMATCH",
        "wrong-oidc-audience-accepted",
      );
      return;
    }
    case "oidc-candidate-binding": {
      const wrong = "f".repeat(40);
      const fixture = oidcFixture(governance, {
        payload: { sha: wrong, workflow_sha: wrong },
      });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "OIDC_IDENTITY_MISMATCH",
        "wrong-oidc-candidate-accepted",
      );
      return;
    }
    case "oidc-reusable-workflow-binding": {
      const wrong = "f".repeat(40);
      const fixture = oidcFixture(governance, {
        payload: {
          job_workflow_sha: wrong,
          job_workflow_ref: governance.expectedReusableWorkflowRef(wrong),
        },
      });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "OIDC_IDENTITY_MISMATCH",
        "wrong-frozen-workflow-authority-accepted",
      );
      return;
    }
    case "oidc-workflow-sha-scope-binding": {
      const fixture = oidcFixture(governance, {
        payload: {
          job_workflow_sha: "f".repeat(40),
        },
      });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "OIDC_IDENTITY_MISMATCH",
        "wrong-workflow-sha-scope-accepted",
      );
      return;
    }
    case "oidc-fixed-workflow-tag-binding": {
      const movingRef =
        `${governance.EXPECTED_REPOSITORY}/` +
        `${governance.REUSABLE_WORKFLOW_PATH}@main`;
      const fixture = oidcFixture(governance, {
        payload: {
          job_workflow_ref: movingRef,
        },
      });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "OIDC_IDENTITY_MISMATCH",
        "moving-workflow-ref-accepted",
      );
      return;
    }
    case "oidc-run-context-binding": {
      const fixture = oidcFixture(governance, {
        payload: { event_name: "pull_request" },
      });
      expectCode(
        () =>
          governance.validateGithubOidcCollectorReceipt({
            receipt: fixture.receipt,
            expectedBody: fixture.body,
            scopeBaseCommit: fixture.scopeBase,
            jwksRegistry: fixture.registry,
            expectedJwksRegistrySha256: fixture.registry.registrySha256,
            expectedRun: fixture.expectedRun,
            nowMs: fixture.nowMs,
          }),
        "RUN_CONTEXT_MISMATCH",
        "wrong-github-run-context-accepted",
      );
      return;
    }
    case "envelope-external-oidc-validation": {
      const fixture = envelopeFixture(governance, {
        invalidOidcSignature: true,
      });
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "COLLECTOR_RECEIPT_INVALID",
        "invalid-external-oidc-envelope-accepted",
      );
      return;
    }
    case "external-validator-canonical-alias-refusal": {
      const aliasParent = tempDirectory("pikiio-mutant-canonical-alias-");
      const alias = path.join(aliasParent, "canonical-repository");
      const moduleRoot = path.resolve(path.dirname(sourcePath), "..");
      const envelopeModule = require(path.join(
        repoRoot,
        "lib",
        "pikiio-phase-proof-envelope.js",
      ));
      const fixture = envelopeFixture(envelopeModule);
      const priorNodeEnvironment = process.env.NODE_ENV;
      let validatorCalls = 0;
      try {
        const envelopeValidation =
          envelopeModule.validatePhaseProofEnvelope(fixture.input());
        expect(
          envelopeValidation.valid === true,
          "canonical-repository-alias-validator-invoked",
          {
            reason: "canonical envelope fixture did not validate",
            envelopeValidation,
          },
        );
        fs.symlinkSync(moduleRoot, alias, "dir");
        process.env.NODE_ENV = "test";
        governance.validateExternallyCertifiedPhaseProofEnvelope(
          fixture.envelope,
          {
            ledger: null,
            phase: null,
            qualityReceipt: null,
            repoRoot: alias,
            externalProofValidator({ envelope }) {
              validatorCalls += 1;
              return {
                valid: true,
                externallyCertified: true,
                replayConsumed: false,
                envelopeHash: envelope.envelopeHash,
                coreBundleHash: envelope.proofBundle.bundleHash,
                certificationHash:
                  envelope.externalCertification.certificationHash,
                phaseId: undefined,
                candidateCommit: undefined,
                candidateTree: undefined,
              };
            },
          },
        );
        expect(
          validatorCalls === 0,
          "canonical-repository-alias-validator-invoked",
          { alias, moduleRoot, validatorCalls },
        );
      } finally {
        if (priorNodeEnvironment === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = priorNodeEnvironment;
        }
        fs.rmSync(aliasParent, { recursive: true, force: true });
      }
      return;
    }
    case "envelope-local-collector-private-key-denial": {
      const fixture = envelopeFixture(governance, {
        localCollectorPrivateKeyAllowed: true,
      });
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "ATTESTATION_AUTHORITY_MISMATCH",
        "local-collector-private-key-authority-accepted",
      );
      return;
    }
    case "envelope-authority-fixed-workflow-ref": {
      const fixture = envelopeFixture(governance, {
        authorityWorkflowRef: "main",
      });
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "ATTESTATION_AUTHORITY_MISMATCH",
        "moving-authority-workflow-ref-accepted",
      );
      return;
    }
    case "envelope-cert-core-bundle-binding": {
      const fixture = envelopeFixture(governance);
      fixture.envelope.externalCertification.phaseProofBundleHash =
        "f".repeat(64);
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "CERTIFICATION_BINDING_MISMATCH",
        "detached-certification-core-hash-accepted",
      );
      return;
    }
    case "envelope-cert-receipt-hashes-binding": {
      const fixture = envelopeFixture(governance);
      fixture.envelope.externalCertification.receiptHashes.candidate =
        "f".repeat(64);
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "CERTIFICATION_BINDING_MISMATCH",
        "detached-certification-receipt-hashes-accepted",
      );
      return;
    }
    case "envelope-cert-attestation-body-binding": {
      const fixture = envelopeFixture(governance);
      fixture.envelope.externalCertification.attestationBody
        .issuerRegistrySha256 = "f".repeat(64);
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "CERTIFICATION_BINDING_MISMATCH",
        "detached-certification-attestation-body-accepted",
      );
      return;
    }
    case "envelope-signed-raw-artifact-exact-set": {
      const fixture = envelopeFixture(governance);
      const bytes = Buffer.from("unsigned extra envelope artifact", "utf8");
      const sha256 = fixture.attestation.sha256(bytes);
      fixture.envelope.proofBundle.artifacts.push({
        address: `sha256:${sha256}`,
        bytes: bytes.toString("base64"),
        encoding: "base64",
        sha256,
      });
      fixture.envelope.proofBundle.artifacts.sort((left, right) =>
        left.address.localeCompare(right.address),
      );
      fixture.envelope.proofBundle.bundleHash = hashWithoutField(
        fixture.envelope.proofBundle,
        "bundleHash",
        fixture.attestation.stableJson,
        fixture.attestation.sha256,
      );
      fixture.expected.coreBundleHash =
        fixture.envelope.proofBundle.bundleHash;
      fixture.envelope.externalCertification.phaseProofBundleHash =
        fixture.envelope.proofBundle.bundleHash;
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "CORE_ARTIFACT_SET_MISMATCH",
        "unsigned-extra-core-artifact-accepted",
      );
      return;
    }
    case "envelope-replay-consumption-scope": {
      const fixture = envelopeFixture(governance);
      fixture.envelope.externalCertification.replayProtection
        .consumptionScope = "process-memory-only";
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "REPLAY_PROTECTION_INVALID",
        "weakened-replay-consumption-scope-accepted",
      );
      return;
    }
    case "envelope-replay-multi-host-safety": {
      const fixture = envelopeFixture(governance);
      fixture.envelope.externalCertification.replayProtection.multiHostSafe =
        true;
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "REPLAY_PROTECTION_INVALID",
        "unsafe-multi-host-replay-metadata-accepted",
      );
      return;
    }
    case "envelope-replay-key-binding": {
      const fixture = envelopeFixture(governance);
      const replayProtection =
        fixture.envelope.externalCertification.replayProtection;
      replayProtection.replayKey = `${replayProtection.replayKey}:detached`;
      replayProtection.replayKeySha256 = fixture.attestation.sha256(
        replayProtection.replayKey,
      );
      rehashEnvelopeFixture(fixture);
      expectCode(
        () => governance.validatePhaseProofEnvelope(fixture.input()),
        "REPLAY_PROTECTION_INVALID",
        "detached-replay-key-accepted",
      );
      return;
    }
    case "workflow-top-level-id-token-denial":
    case "workflow-gauntlet-id-token-denial":
    case "workflow-collect-id-token-required":
    case "workflow-collect-authority-only-execution": {
      validateProofCollectorWorkflow(fs.readFileSync(sourcePath, "utf8"));
      return;
    }
    case "workflow-request-fixed-authority-tag": {
      validateProofRequestWorkflow(fs.readFileSync(sourcePath, "utf8"));
      return;
    }
    case "quality-embedded-raw-hash": {
      const fixture = qualityReceiptWithEmbeddedRaw(
        governance,
        ledger,
        phase,
      );
      const [address, canonicalBytes] = fixture.rawBytes.entries().next().value;
      const parsed = JSON.parse(canonicalBytes.toString("utf8"));
      const reversed = Object.fromEntries(Object.entries(parsed).reverse());
      const tamperedBytes = Buffer.from(JSON.stringify(reversed), "utf8");
      expect(
        tamperedBytes.length === canonicalBytes.length,
        "tampered-embedded-quality-artifact-accepted",
        { reason: "test fixture must preserve byte length" },
      );
      fixture.rawBytes.set(address, tamperedBytes);
      const result = governance.validateQualityReceipt(fixture.receipt, {
        ledger,
        phase,
        head: fixture.receipt.head,
        workspaceDigest: fixture.receipt.workspaceDigest,
        verifyRawArtifacts: true,
        rawArtifactBytes: fixture.rawBytes,
      });
      expect(
        result.valid === false,
        "tampered-embedded-quality-artifact-accepted",
        { errors: result.errors },
      );
      return;
    }
    case "host-receipt-freshness": {
      const nowMs = Date.parse("2026-07-24T08:00:00.000Z");
      const receipt = hostReceiptFixture(governance, {
        observedAt: new Date(
          nowMs - governance.MAXIMUM_RECEIPT_AGE_MS - 1,
        ).toISOString(),
      });
      const result = governance.validateHostDurabilityReceipt(receipt, {
        nowMs,
        localHost: "operator-mac",
      });
      expect(result.valid === false, "stale-host-receipt-accepted", { result });
      return;
    }
    case "host-service-running": {
      const receipt = hostReceiptFixture(governance, {
        launchctl: { state: "stopped" },
      });
      const result = governance.validateHostDurabilityReceipt(receipt, {
        nowMs: Date.parse("2026-07-24T08:00:00.000Z"),
        localHost: "operator-mac",
      });
      expect(
        result.valid === false,
        "stopped-keep-awake-service-accepted",
        { result },
      );
      return;
    }
    case "host-exact-plist-digest": {
      const receipt = hostReceiptFixture(governance, {
        servicePlistEvidence: { sha256: "f".repeat(64) },
      });
      const result = governance.validateHostDurabilityReceipt(receipt, {
        nowMs: Date.parse("2026-07-24T08:00:00.000Z"),
        localHost: "operator-mac",
      });
      expect(result.valid === false, "wrong-keep-awake-plist-accepted", {
        result,
      });
      return;
    }
    case "host-sleep-policy-readable": {
      const receipt = hostReceiptFixture(governance, {
        pmsetOutput: "Battery Power:\n sleep 1\nAC Power:\n powernap 1\n",
      });
      const result = governance.validateHostDurabilityReceipt(receipt, {
        nowMs: Date.parse("2026-07-24T08:00:00.000Z"),
        localHost: "operator-mac",
      });
      expect(
        result.valid === false,
        "unreadable-host-sleep-policy-accepted",
        { result },
      );
      return;
    }
    case "host-sleep-assertions": {
      const receipt = hostReceiptFixture(governance, {
        assertionsOutput: [
          "PreventSystemSleep 0",
          "PreventUserIdleSystemSleep 0",
          "pid 4242(caffeinate): PreventSystemSleep",
          "pid 4242(caffeinate): PreventUserIdleSystemSleep",
        ].join("\n"),
      });
      const result = governance.validateHostDurabilityReceipt(receipt, {
        nowMs: Date.parse("2026-07-24T08:00:00.000Z"),
        localHost: "operator-mac",
      });
      expect(
        result.valid === false,
        "missing-keep-awake-assertions-accepted",
        { result },
      );
      return;
    }
    case "writer-fresh-host-admission": {
      const candidateLedger = clone(ledger);
      candidateLedger.activePhaseId = "TRUTH-01";
      for (const candidatePhase of candidateLedger.phases) {
        candidatePhase.status =
          candidatePhase.id === "TRUTH-01" ? "active" :
            candidatePhase.id === "GOV-00" ? "complete" : "planned";
      }
      const candidatePhase = candidateLedger.phases.find(
        (entry) => entry.id === "TRUTH-01",
      );
      const outcome = await captureRejection(() =>
        governance.acquireCommand({
          argv: [
            process.argv[0],
            sourcePath,
            "acquire",
            "--lease-class=builder",
          ],
          loadPhaseLedgerImpl: () => candidateLedger,
          selectActivePhaseImpl: () => candidatePhase,
          evaluateGoalGuardImpl: () => ({ ok: true }),
          validateHeartbeatActivationReceiptImpl: () => ({ valid: true }),
          evaluateDirtyGuardImpl: () => ({
            ok: true,
            working: { allowed: [], blocked: [] },
          }),
          currentHeadImpl: () => "a".repeat(40),
          currentBranchImpl: () => candidateLedger.baseline.branch,
          readActivationReceipt: () => ({}),
          collectHostDurability: () => ({
            sleep: { acSleepMinutes: 1 },
            blockers: ["HOST_KEEP_AWAKE_SERVICE_NOT_RUNNING"],
          }),
          validateHostDurability: () => ({
            valid: false,
            errors: ["stopped"],
          }),
          nowMs: Date.parse("2026-07-24T08:00:00.000Z"),
          fsImpl: {
            mkdirSync() {
              const error = new Error("bootstrap was reached");
              error.code = "BOOTSTRAP_REACHED";
              throw error;
            },
          },
        }),
      );
      expect(
        outcome.error?.code === "HEARTBEAT_HOST_DURABILITY_INVALID",
        "invalid-live-host-bypassed-to-bootstrap",
        { errorCode: outcome.error?.code || null },
      );
      return;
    }
    case "exclusive-write-no-replace": {
      const root = tempDirectory("pikiio-exclusive-mutant-");
      const target = path.join(root, "proof.json");
      try {
        fs.writeFileSync(target, "original\n");
        expectCode(
          () => governance.writeJsonExclusiveAtomic(target, { replacement: true }),
          "CONTENT_ADDRESSED_DESTINATION_EXISTS",
          "content-addressed-destination-overwritten",
        );
        expect(
          fs.readFileSync(target, "utf8") === "original\n",
          "content-addressed-destination-overwritten",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "exclusive-write-directory-fsync": {
      const root = tempDirectory("pikiio-exclusive-fsync-mutant-");
      const target = path.join(root, "proof.json");
      const originalFsync = fs.fsyncSync;
      let fsyncCalls = 0;
      fs.fsyncSync = (descriptor) => {
        fsyncCalls += 1;
        return originalFsync(descriptor);
      };
      try {
        governance.writeJsonExclusiveAtomic(target, { exact: true });
        expect(
          fsyncCalls >= 3,
          "exclusive-write-directory-not-durable",
          { fsyncCalls },
        );
      } finally {
        fs.fsyncSync = originalFsync;
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "exclusive-write-temporary-cleanup": {
      const root = tempDirectory("pikiio-exclusive-cleanup-mutant-");
      const target = path.join(root, "proof.json");
      try {
        fs.writeFileSync(target, "occupied\n");
        expectCode(
          () => governance.writeJsonExclusiveAtomic(target, { collision: true }),
          "CONTENT_ADDRESSED_DESTINATION_EXISTS",
          "exclusive-write-temporary-leaked",
        );
        expect(
          fs.readdirSync(root).length === 1,
          "exclusive-write-temporary-leaked",
          { entries: fs.readdirSync(root) },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "transition-recovery-artifact-hash": {
      const fixture = transitionRecoveryFixture(governance, {
        tamperCompletion: true,
        preexisting: true,
      });
      try {
        expectCode(
          () =>
            governance.recoverPhaseTransition({
              repoRoot: fixture.root,
              journalPath: fixture.journalPath,
            }),
          "PHASE_TRANSITION_ARTIFACT_HASH_MISMATCH",
          "tampered-transition-artifact-accepted",
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "transition-recovery-ledger-divergence": {
      const fixture = transitionRecoveryFixture(governance, {
        divergent: true,
        artifacts: false,
      });
      try {
        expectCode(
          () =>
            governance.recoverPhaseTransition({
              repoRoot: fixture.root,
              journalPath: fixture.journalPath,
            }),
          "PHASE_TRANSITION_LEDGER_DIVERGED",
          "divergent-transition-ledger-rolled-back",
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "transition-recovery-orphan-cleanup": {
      const fixture = transitionRecoveryFixture(governance);
      try {
        const result = governance.recoverPhaseTransition({
          repoRoot: fixture.root,
          journalPath: fixture.journalPath,
        });
        expect(
          result.status === "rolled_back" &&
            !fs.existsSync(fixture.completionAbsolute) &&
            !fs.existsSync(fixture.bundleAbsolute) &&
            !fs.existsSync(fixture.journalPath),
          "uncommitted-transition-artifact-survived-recovery",
          { result },
        );
      } finally {
        fixture.cleanup();
      }
      return;
    }
    case "activation-active-phase-binding": {
      const planned = ledger.phases.find(
        (candidate) => candidate.id !== ledger.activePhaseId,
      );
      const errors = [];
      const selected = governance.selectActivationPhase(
        ledger,
        planned,
        errors,
      );
      expect(
        selected.id === ledger.activePhaseId && errors.length > 0,
        "planned-phase-selected-for-activation",
        { selectedPhaseId: selected.id, errors },
      );
      return;
    }
    case "transition-quality-receipt-required": {
      const fixture = phaseTransitionFixture(governance, ledger);
      const result = governance.validatePhaseTransition({
        before: fixture.before,
        after: fixture.after,
        baseCommit: fixture.baseCommit,
      });
      expect(
        result.valid === false,
        "transition-without-quality-receipt-accepted",
        { result },
      );
      return;
    }
    case "transition-completion-path-binding": {
      const fixture = phaseTransitionFixture(governance, ledger);
      const previous = fixture.after.phases.find(
        (candidate) => candidate.id === fixture.previous.id,
      );
      previous.lastResult.qualityReceiptPath =
        "YLYI/09_Proof_Receipts/phase-completions/not-content-addressed.json";
      const result = governance.validatePhaseTransition({
        before: fixture.before,
        after: fixture.after,
        baseCommit: fixture.baseCommit,
        qualityReceipt: fixture.receipt,
      });
      expect(
        result.valid === false,
        "non-content-addressed-completion-path-accepted",
        { result },
      );
      return;
    }
    case "transition-quality-hash-binding": {
      const fixture = phaseTransitionFixture(governance, ledger);
      const previous = fixture.after.phases.find(
        (candidate) => candidate.id === fixture.previous.id,
      );
      const mismatchedHash = "0".repeat(64);
      previous.lastResult.qualityReceiptHash = mismatchedHash;
      previous.lastResult.qualityReceiptPath =
        `YLYI/09_Proof_Receipts/phase-completions/${mismatchedHash}.json`;
      const result = governance.validatePhaseTransition({
        before: fixture.before,
        after: fixture.after,
        baseCommit: fixture.baseCommit,
        qualityReceipt: fixture.receipt,
      });
      expect(
        result.valid === false,
        "mismatched-transition-quality-hash-accepted",
        { result },
      );
      return;
    }
    case "receipt-chain-link": {
      const root = tempDirectory("pikiio-mutant-chain-");
      const receiptPath = path.join(root, "receipts.jsonl");
      try {
        const first = sign(governance, {
          previousReceiptHash: null,
          result: "first",
        });
        const second = sign(governance, {
          previousReceiptHash: "0".repeat(64),
          result: "second",
        });
        fs.writeFileSync(
          receiptPath,
          `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
        );
        expect(
          governance.verifyReceiptChain(receiptPath).valid === false,
          "broken-receipt-chain-link-accepted",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "production-default-deny": {
      const result = governance.evaluateProductionGate({
        ledger,
        repoRoot,
        goalObjective: ledger.codexGoal.objective,
        goalThreadId: ledger.codexGoal.threadId,
        action: "deploy",
      });
      expect(
        result.code === "PRODUCTION_AUTHORITY_DISABLED",
        "default-production-deny-bypassed",
        { result },
      );
      return;
    }
    case "production-grant-expiry": {
      const candidate = clone(ledger);
      candidate.phases[0].productionAuthority = {
        enabled: true,
        allowedLiveProbes: [],
        grant: {
          schema: "pikiio-production-grant-v3",
          candidateCommit: "a".repeat(40),
          branch: "main",
          qualityReceiptSha256: "c".repeat(64),
          phaseProofBundleSha256: "f".repeat(64),
          phaseCandidateReceiptSha256: "1".repeat(64),
          phaseRehearsalReceiptSha256: "2".repeat(64),
          expiresAt: "2026-07-23T00:00:00.000Z",
          migrations: [{
            path: "supabase/migrations/x.sql",
            sha256: "d".repeat(64),
          }],
          deployment: { enabled: true, tree: "e".repeat(40) },
        },
      };
      const result = governance.evaluateProductionGate({
        ledger: candidate,
        repoRoot,
        goalObjective: candidate.codexGoal.objective,
        goalThreadId: candidate.codexGoal.threadId,
        action: "deploy",
        nowMs: Date.parse("2026-07-24T00:00:00.000Z"),
      });
      expect(
        result.code === "PRODUCTION_GRANT_EXPIRED",
        "expired-production-grant-accepted",
        { result },
      );
      return;
    }
    case "os-advisory-lock": {
      const source = fs.readFileSync(sourcePath, "utf8");
      expect(
        source.includes('command: "/usr/bin/lockf"') &&
          source.includes('command: "/usr/bin/flock"') &&
          !source.includes("archiveStaleOperationLock"),
        "os-advisory-lock-contract-weakened",
      );
      return;
    }
    case "live-refresh-live-serializer-owner": {
      const root = tempDirectory("pikiio-mutant-live-serializer-");
      const lockPath = path.join(root, "run.lock");
      const operationPath = path.join(root, "operation.lock");
      const host = "mutation-host";
      const ownerPid = 41_001;
      const operationId = "live-serializer-owner";
      try {
        fs.writeFileSync(
          operationPath,
          `${JSON.stringify({
            schema: governance.OPERATION_SCHEMA,
            operationId,
            purpose: "foreign-live-owner",
            pid: ownerPid,
            host,
            startedAt: "2026-07-24T00:00:00.000Z",
          })}\n`,
        );
        const outcome = await captureRejection(() =>
          governance.acquireNestedRunLock({
            lockPath,
            operationPath,
            pid: 41_002,
            host,
            nowMs: () => Date.parse("2026-07-24T01:00:00.000Z"),
            isPidAlive: () => true,
            maximumSerializationAttempts: 1,
            serializationRetryDelayMs: 0,
          }),
        );
        const preserved = fs.existsSync(operationPath)
          ? JSON.parse(fs.readFileSync(operationPath, "utf8"))
          : null;
        expect(
          outcome.error?.code === "LIVE_REFRESH_OPERATION_BUSY" &&
            preserved?.operationId === operationId &&
            !fs.existsSync(lockPath),
          "live-serializer-owner-stolen",
          { errorCode: outcome.error?.code || null, preserved },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "live-refresh-dead-serializer-recovery": {
      const root = tempDirectory("pikiio-mutant-dead-serializer-");
      const lockPath = path.join(root, "run.lock");
      const operationPath = path.join(root, "operation.lock");
      const host = "mutation-host";
      try {
        fs.writeFileSync(
          operationPath,
          `${JSON.stringify({
            schema: governance.OPERATION_SCHEMA,
            operationId: "dead-serializer-owner",
            purpose: "abandoned",
            pid: 42_001,
            host,
            startedAt: "2026-07-24T00:00:00.000Z",
          })}\n`,
        );
        const outcome = await captureRejection(() =>
          governance.acquireNestedRunLock({
            lockPath,
            operationPath,
            pid: 42_002,
            host,
            nowMs: () => Date.parse("2026-07-24T01:00:00.000Z"),
            isPidAlive: () => false,
            maximumSerializationAttempts: 2,
            serializationRetryDelayMs: 0,
          }),
        );
        if (typeof outcome.value === "function") {
          await outcome.value();
        }
        expect(
          outcome.error === null &&
            !fs.existsSync(lockPath) &&
            !fs.existsSync(operationPath),
          "dead-serializer-recovery-disabled",
          { errorCode: outcome.error?.code || null },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "live-refresh-live-run-owner": {
      const root = tempDirectory("pikiio-mutant-live-run-owner-");
      const lockPath = path.join(root, "run.lock");
      const operationPath = path.join(root, "operation.lock");
      const host = "mutation-host";
      const lockId = "live-run-owner";
      try {
        fs.writeFileSync(
          lockPath,
          `${JSON.stringify({
            schema: governance.RUN_LOCK_SCHEMA,
            lockId,
            pid: 43_001,
            host,
            startedAt: "2026-07-23T00:00:00.000Z",
          })}\n`,
        );
        fs.utimesSync(lockPath, new Date(0), new Date(0));
        const outcome = await captureRejection(() =>
          governance.acquireNestedRunLock({
            lockPath,
            operationPath,
            staleMs: 1,
            pid: 43_002,
            host,
            nowMs: () => Date.parse("2026-07-24T01:00:00.000Z"),
            isPidAlive: () => true,
            maximumSerializationAttempts: 1,
            serializationRetryDelayMs: 0,
          }),
        );
        const preserved = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        expect(
          outcome.error?.code === "LIVE_REFRESH_LOCK_BUSY" &&
            preserved.lockId === lockId &&
            !fs.existsSync(operationPath),
          "age-expired-live-run-owner-stolen",
          { errorCode: outcome.error?.code || null },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "live-refresh-run-release-identity": {
      const root = tempDirectory("pikiio-mutant-run-release-");
      const lockPath = path.join(root, "run.lock");
      const operationPath = path.join(root, "operation.lock");
      const host = "mutation-host";
      const pid = 44_001;
      const foreignLockId = "replacement-run-owner";
      try {
        const release = await governance.acquireNestedRunLock({
          lockPath,
          operationPath,
          pid,
          host,
          nowMs: () => Date.parse("2026-07-24T01:00:00.000Z"),
          isPidAlive: () => true,
          maximumSerializationAttempts: 1,
          serializationRetryDelayMs: 0,
        });
        fs.writeFileSync(
          lockPath,
          `${JSON.stringify({
            schema: governance.RUN_LOCK_SCHEMA,
            lockId: foreignLockId,
            pid,
            host,
            startedAt: "2026-07-24T01:00:00.000Z",
          })}\n`,
        );
        const outcome = await captureRejection(release);
        const preserved = fs.existsSync(lockPath)
          ? JSON.parse(fs.readFileSync(lockPath, "utf8"))
          : null;
        expect(
          outcome.error?.code === "LIVE_REFRESH_LOCK_OWNERSHIP_CHANGED" &&
            preserved?.lockId === foreignLockId,
          "foreign-run-lock-released",
          { errorCode: outcome.error?.code || null, preserved },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "live-refresh-operation-release-identity": {
      const root = tempDirectory("pikiio-mutant-operation-release-");
      const lockPath = path.join(root, "run.lock");
      const operationPath = path.join(root, "operation.lock");
      const host = "mutation-host";
      const pid = 45_001;
      const originalOpen = fsp.open;
      try {
        let outcome;
        try {
          fsp.open = async (filePath, ...args) => {
            const handle = await originalOpen(filePath, ...args);
            if (filePath === lockPath) {
              const originalWrite = handle.writeFile.bind(handle);
              handle.writeFile = async (...writeArgs) => {
                const result = await originalWrite(...writeArgs);
                fs.writeFileSync(
                  operationPath,
                  `${JSON.stringify({
                    schema: governance.OPERATION_SCHEMA,
                    operationId: "replacement-operation-owner",
                    purpose: "replacement",
                    pid,
                    host,
                    startedAt: "2026-07-24T01:00:00.000Z",
                  })}\n`,
                );
                return result;
              };
            }
            return handle;
          };
          outcome = await captureRejection(() =>
            governance.acquireNestedRunLock({
              lockPath,
              operationPath,
              pid,
              host,
              nowMs: () => Date.parse("2026-07-24T01:00:00.000Z"),
              isPidAlive: () => true,
              maximumSerializationAttempts: 1,
              serializationRetryDelayMs: 0,
            }),
          );
        } finally {
          fsp.open = originalOpen;
        }
        const preserved = fs.existsSync(operationPath)
          ? JSON.parse(fs.readFileSync(operationPath, "utf8"))
          : null;
        expect(
          outcome.error?.code ===
              "LIVE_REFRESH_OPERATION_OWNERSHIP_CHANGED" &&
            preserved?.operationId === "replacement-operation-owner",
          "foreign-operation-lock-released",
          { errorCode: outcome.error?.code || null, preserved },
        );
      } finally {
        fsp.open = originalOpen;
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "live-refresh-write-failure-cleanup": {
      const root = tempDirectory("pikiio-mutant-write-cleanup-");
      const lockPath = path.join(root, "run.lock");
      const operationPath = path.join(root, "operation.lock");
      const host = "mutation-host";
      const originalOpen = fsp.open;
      try {
        let outcome;
        try {
          fsp.open = async (filePath, ...args) => {
            const handle = await originalOpen(filePath, ...args);
            if (filePath === lockPath) {
              handle.writeFile = async () => {
                const error = new Error("forced run-lock write failure");
                error.code = "FORCED_RUN_LOCK_WRITE_FAILURE";
                throw error;
              };
            }
            return handle;
          };
          outcome = await captureRejection(() =>
            governance.acquireNestedRunLock({
              lockPath,
              operationPath,
              pid: 46_001,
              host,
              nowMs: () => Date.parse("2026-07-24T01:00:00.000Z"),
              isPidAlive: () => true,
              maximumSerializationAttempts: 1,
              serializationRetryDelayMs: 0,
            }),
          );
        } finally {
          fsp.open = originalOpen;
        }
        expect(
          outcome.error?.code === "FORCED_RUN_LOCK_WRITE_FAILURE" &&
            !fs.existsSync(lockPath) &&
            !fs.existsSync(operationPath),
          "owned-run-lock-leaked-after-write-failure",
          { errorCode: outcome.error?.code || null },
        );
      } finally {
        fsp.open = originalOpen;
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    case "live-refresh-foreign-inode-cleanup": {
      const root = tempDirectory("pikiio-mutant-foreign-inode-");
      const lockPath = path.join(root, "run.lock");
      const originalPath = path.join(root, "run.lock.original");
      let handle;
      try {
        fs.writeFileSync(lockPath, "owned");
        handle = await fsp.open(lockPath, "r+");
        fs.renameSync(lockPath, originalPath);
        fs.writeFileSync(lockPath, "foreign");
        const removed = await governance.removePathStillOwned(
          lockPath,
          handle,
        );
        expect(
          removed === false &&
            fs.existsSync(lockPath) &&
            fs.readFileSync(lockPath, "utf8") === "foreign",
          "foreign-inode-unlinked",
          { removed, foreignExists: fs.existsSync(lockPath) },
        );
      } finally {
        await handle?.close().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    default:
      throw new Error(`Unknown mutation check: ${checkId}`);
  }
}

let governance;
let ledger;
try {
  const textSourceChecks = new Set([
    "workflow-top-level-id-token-denial",
    "workflow-gauntlet-id-token-denial",
    "workflow-collect-id-token-required",
    "workflow-collect-authority-only-execution",
    "workflow-request-fixed-authority-tag",
  ]);
  const isolatedQualityPlanChecks = new Set([
    "required-command-layer",
    "quality-suite-registry",
    "quality-scalar-check-registry",
    "quality-array-check-registry",
  ]);
  if (isolatedQualityPlanChecks.has(checkId)) {
    governance =
      loadGovernanceWithCanonicalPlanBackstopIsolated(sourcePath);
  } else if (
    checkId !== "os-advisory-lock" &&
    !textSourceChecks.has(checkId)
  ) {
    governance = require(sourcePath);
  } else {
    governance = require(path.join(repoRoot, "lib", "pikiio-agent-governance.js"));
  }
  ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    reason: "module_load_failed",
    checkId,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exit(2);
}

async function executeProbe() {
  try {
    await runCheck(governance, ledger);
    process.stdout.write(`${JSON.stringify({ ok: true, checkId })}\n`);
  } catch (error) {
    if (error instanceof ProbeAssertion) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        reason: "assertion_failed",
        checkId,
        fingerprint: error.fingerprint,
        details: error.details,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: "unexpected_error",
      checkId,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    })}\n`);
    process.exitCode = 3;
  }
}

executeProbe();

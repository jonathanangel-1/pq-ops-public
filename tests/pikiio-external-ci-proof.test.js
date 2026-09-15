"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  ATTESTATION_BODY_SCHEMA,
  AUTHORITY_WORKFLOW_PATH,
  AUTHORITY_WORKFLOW_REF,
  CERTIFICATION_SCHEMA,
  COMMAND_PLAN_SCHEMA,
  EXPECTED_REPOSITORY,
  ExternalCiProofError,
  JUDGE_SCHEMA,
  MACOS_IDENTITY_BODY_SCHEMA,
  MACOS_IDENTITY_EVIDENCE_SCHEMA,
  MACOS_LINEAGE_SCHEMA,
  MATERIALIZATION_SCHEMA,
  PACKAGE_SCHEMA,
  PLATFORM_RECEIPT_SCHEMA,
  REQUEST_SCHEMA,
  VERDICT_SCHEMA,
  buildExternalCiAttestationBody,
  buildMacosIdentityBody,
  buildMacosLineage,
  commandDefinitionSha256,
  commandNamesSha256,
  evidenceManifestSha256,
  evidenceReferences,
  hashWithoutField,
  reconcileRawEvidence,
  sealExternalCiCertification,
  sealJudgeReceipt,
  sealMaterializationReceipt,
  sealPlatformReceipt,
  sealQualityVerdict,
  sealExternalCiPackage,
  sha256,
  stableJson,
  validateCertificationRequest,
  validateAuthorityWorkflowForMacosLineage,
  validateCommandPlan,
  validateConstructibleSourceHistory,
  validateExternalCiAttestationBody,
  validateExternalCiCertification,
  validateJudgeReceipt,
  validateMacosLineage,
  validateMacosIdentityBody,
  validateMacosIdentityEvidence,
  validateMaterializationReceipt,
  validatePlatformReceipt,
  validateQualityVerdict,
  verifyExternalCiCertification,
  verifyExternalCiPackage,
  verifyMacosJobIdentity,
} = require("../lib/pikiio-external-ci-proof");
const {
  COLLECTOR_RECEIPT_SCHEMA,
  hashWithoutField: oidcHashWithoutField,
  stableJson: oidcStableJson,
} = require("../lib/pikiio-github-oidc-collector-v3");

const ROOT = path.resolve(__dirname, "..");
const COLLECTOR_WORKFLOW = path.join(
  ROOT,
  ".github",
  "workflows",
  "pikiio-proof-collector-v3.yml",
);
const REQUEST_WORKFLOW = path.join(
  ROOT,
  ".github",
  "workflows",
  "pikiio-proof-request-v3.yml",
);
const CHILD_RUNNER_PATH = path.join(
  ROOT,
  "ops",
  "pikiio-proof-v3-judge",
  "child-runner.js",
);
const EXTERNAL_PROOF_PATH = path.join(
  ROOT,
  "lib",
  "pikiio-external-ci-proof.js",
);
const OIDC_COLLECTOR_PATH = path.join(
  ROOT,
  "lib",
  "pikiio-github-oidc-collector-v3.js",
);
const JUDGE_DOCKERFILE = path.join(
  ROOT,
  "ops",
  "pikiio-proof-v3-judge",
  "Dockerfile",
);
const TOOLCHAIN_PROVENANCE = path.join(
  ROOT,
  "ops",
  "pikiio-proof-v3-judge",
  "provenance.json",
);
const childRunner = require(CHILD_RUNNER_PATH);

function runProcessLifecycle(
  executable,
  args,
  options,
  { absoluteTimeoutMs = 30_000, idleTimeoutMs = 15_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const events = [];
    const stdout = [];
    const stderr = [];
    let settled = false;
    let idleTimer;
    let absoluteTimer;
    const child = spawn(executable, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        events,
      });
    };
    const terminate = (reason) => {
      if (settled) return;
      events.push(reason);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({
        status: null,
        signal: "SIGKILL",
        timedOut: true,
        timeoutReason: reason,
      });
    };
    const progress = (kind, bytes) => {
      events.push(kind);
      if (bytes) {
        const target = kind === "stdout" ? stdout : stderr;
        target.push(Buffer.from(bytes));
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate("idle-timeout"), idleTimeoutMs);
    };
    child.once("spawn", () => progress("spawn"));
    child.stdout.on("data", (bytes) => progress("stdout", bytes));
    child.stderr.on("data", (bytes) => progress("stderr", bytes));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      events.push("close");
      finish({
        status,
        signal,
        timedOut: false,
        timeoutReason: null,
      });
    });
    absoluteTimer = setTimeout(
      () => terminate("absolute-timeout"),
      absoluteTimeoutMs,
    );
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return sha256(Buffer.from(value, "utf8"));
}

function compileMutant(file, search, replacement) {
  const source = fs.readFileSync(file, "utf8");
  assert.equal(
    source.split(search).length - 1,
    1,
    `mutation target must occur exactly once: ${search}`,
  );
  const mutantFilename = path.join(
    path.dirname(file),
    `.pikiio-mutant-${path.basename(file)}`,
  );
  const mutant = new Module(mutantFilename, module);
  mutant.filename = mutantFilename;
  mutant.paths = Module._nodeModulePaths(path.dirname(file));
  mutant._compile(source.replace(search, replacement), mutantFilename);
  return mutant.exports;
}

function cas(value) {
  const bytes = Buffer.from(value, "utf8");
  const hash = sha256(bytes);
  return {
    reference: {
      address: `sha256:${hash}`,
      sha256: hash,
      byteLength: bytes.length,
    },
    bytes,
  };
}

function coverageFiles() {
  return {
    "lib/pikiio-external-ci-proof.js": {
      lines: 98.4,
      branches: 94.1,
      functions: 99.2,
    },
  };
}

function unitTap() {
  return [
    "TAP version 13",
    "# tests 127",
    "# suites 12",
    "# pass 127",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# all | 98.4 | 94.1 | 99.2",
    "# lib/pikiio-external-ci-proof.js | 98.4 | 94.1 | 99.2",
    "",
  ].join("\n");
}

function gherkinRaw() {
  return {
    ok: true,
    scenarios: 31,
    passed: 31,
    failed: 0,
    skipped: 0,
    undefined: 0,
    ambiguous: 0,
    pending: 0,
    passPercent: 100,
  };
}

function mutationRaw() {
  return {
    ok: true,
    total: 113,
    killed: 108,
    survived: 5,
    criticalTotal: 47,
    criticalKilled: 47,
    survivedCritical: 0,
    scorePercent: 95.58,
    criticalMutantKillPercent: 100,
    metaTests: [
      { id: "classifier-rejects-weak-mutants", passed: true },
    ],
    mutants: Array.from({ length: 47 }, (_, index) => ({
      id: `critical-${String(index + 1).padStart(3, "0")}`,
    })),
  };
}

function metrics() {
  const repeatCoverage = Array.from(
    { length: 3 },
    () => coverageFiles(),
  );
  const mutants = mutationRaw().mutants;
  return {
    unit: {
      repeats: 3,
      tests: 127,
      passed: 127,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    },
    coverage: {
      perFileProofSha256: sha256(stableJson(repeatCoverage)),
      lines: 98.4,
      branches: 94.1,
      functions: 99.2,
    },
    gherkin: {
      scenarios: 31,
      passed: 31,
      failed: 0,
      skipped: 0,
      undefined: 0,
      ambiguous: 0,
      pending: 0,
    },
    mutation: {
      total: 113,
      killed: 108,
      survived: 5,
      score: 95.58,
      criticalTotal: 47,
      criticalKilled: 47,
      survivedCritical: 0,
      criticalIdsSha256: sha256(stableJson(mutants)),
      classifierMetaTestsPassed: true,
    },
  };
}

const signingKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const signingJwk = signingKeys.publicKey.export({ format: "jwk" });
const OIDC_IAT = Math.floor(Date.parse("2026-07-24T06:00:00.000Z") / 1000);
const OIDC_KID = "pikiio-v3-test-key";
const OIDC_JTI = "123e4567-e89b-42d3-a456-426614174000";
const MACOS_OIDC_JTI = "223e4567-e89b-42d3-a456-426614174001";

function populationFloors() {
  return {
    unitTests: 127,
    criticalMutants: 47,
    gherkinScenarios: 31,
  };
}

function commandPlan() {
  const commands = [];
  const add = (group, repeat, platform, suffix = "") => {
    const executable = group === "broad" ? "npm" : group === "neighbor" ? "git" : "node";
    const args =
      executable === "npm"
        ? ["--ignore-scripts", "run", `verify:${group}`]
        : executable === "git"
          ? ["diff", "--check"]
          : [group === "syntax" ? "-c" : `scripts/verify-${group}.js`];
    const command = {
      name: `${group}${suffix}-repeat-${repeat}`,
      group,
      platform,
      repeat,
      executable,
      args,
      definitionSha256: "0".repeat(64),
    };
    command.definitionSha256 = commandDefinitionSha256(command);
    commands.push(command);
  };
  add("syntax", 1, "linux");
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    add("unit", repeat, "macos");
    for (const group of [
      "gherkin",
      "mutation",
      "focused",
      "neighbor",
      "broad",
      "production-shaped",
    ]) {
      add(group, repeat, "linux");
    }
  }
  return {
    schema: COMMAND_PLAN_SCHEMA,
    repeats: 3,
    requiredCoverageFiles: ["lib/pikiio-external-ci-proof.js"],
    commands,
  };
}

function childExecution(command, stdout, role, index) {
  const stdoutBytes = Buffer.from(stdout, "utf8");
  const stderrBytes = Buffer.alloc(0);
  return {
    protocol: "pikiio-external-ci-child-v3",
    commandName: command.name,
    commandSha256: sha256(stableJson(command)),
    definitionSha256: command.definitionSha256,
    platform: command.platform,
    repeat: command.repeat,
    status: 0,
    signal: null,
    errorCode: null,
    timedOut: false,
    elapsedMs: 100 + index + (role === "independent" ? 100 : 0),
    stdoutSha256: sha256(stdoutBytes),
    stdoutByteLength: stdoutBytes.length,
    stdoutBase64: stdoutBytes.toString("base64"),
    stderrSha256: sha256(stderrBytes),
    stderrByteLength: 0,
    stderrBase64: "",
  };
}

function addArtifact(artifacts, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value, "utf8");
  const hash = sha256(bytes);
  const reference = {
    address: `sha256:${hash}`,
    sha256: hash,
    byteLength: bytes.length,
  };
  artifacts.set(reference.address, bytes);
  return reference;
}

function makeRegistry() {
  const registry = {
    schema: "pikiio-github-oidc-jwks-registry-v1",
    revision: 1,
    issuer: "https://token.actions.githubusercontent.com",
    keys: [
      {
        kty: "RSA",
        alg: "RS256",
        use: "sig",
        kid: OIDC_KID,
        n: signingJwk.n,
        e: signingJwk.e,
        x5t: null,
      },
    ],
    registrySha256: "0".repeat(64),
  };
  registry.registrySha256 = oidcHashWithoutField(
    registry,
    "registrySha256",
  );
  return registry;
}

function signJwt(payload) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: OIDC_KID, typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), signingKeys.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function oidcPayload({ authorityCommit, run, audience, jti }) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    repository: EXPECTED_REPOSITORY,
    repository_id: "1256222775",
    repository_owner: "demo-maintainer",
    repository_owner_id: "255220455",
    repository_visibility: "private",
    runner_environment: "github-hosted",
    event_name: "workflow_dispatch",
    ref: `refs/tags/${AUTHORITY_WORKFLOW_REF}`,
    ref_type: "tag",
    ref_protected: "true",
    sha: authorityCommit,
    workflow_ref: `${EXPECTED_REPOSITORY}/.github/workflows/pikiio-proof-request-v3.yml@refs/tags/${AUTHORITY_WORKFLOW_REF}`,
    workflow_sha: authorityCommit,
    job_workflow_ref: `${EXPECTED_REPOSITORY}/${AUTHORITY_WORKFLOW_PATH}@refs/tags/${AUTHORITY_WORKFLOW_REF}`,
    job_workflow_sha: authorityCommit,
    run_id: run.runId,
    run_attempt: run.runAttempt,
    jti,
    sub: `repo:${EXPECTED_REPOSITORY}:ref:refs/tags/${AUTHORITY_WORKFLOW_REF}`,
    iat: OIDC_IAT,
    nbf: OIDC_IAT - 5,
    exp: OIDC_IAT + 600,
  };
}

const PHASE_COMMITS = Object.freeze({
  "GOV-00": ["1", "2", "3", "4", "5", "6"],
  "TRUTH-01": ["7", "8", "9", "a", "b", "c"],
  "ACTION-01": ["d", "e", "f", "0", "1", "2"],
});

function makeFixture(phaseId = "TRUTH-01") {
  const [authorityChar, scopeChar, candidateChar, authorityTreeChar, scopeTreeChar, candidateTreeChar] =
    PHASE_COMMITS[phaseId];
  const authorityCommit = authorityChar.repeat(40);
  const scopeCommit = scopeChar.repeat(40);
  const candidateCommit = candidateChar.repeat(40);
  const floors = populationFloors();
  const exactCommandPlan = commandPlan();
  const jwksRegistry = makeRegistry();
  const judgeImageDigest = `sha256:${digest("node-runtime-image")}`;
  const authorityWorkflowBytes = fs.readFileSync(COLLECTOR_WORKFLOW);
  const materialization = sealMaterializationReceipt({
    repository: EXPECTED_REPOSITORY,
    run: {
      runId: String(8100 + Object.keys(PHASE_COMMITS).indexOf(phaseId)),
      runAttempt: "2",
      requestNonce: digest(`nonce:${phaseId}`),
    },
    authority: {
      ref: AUTHORITY_WORKFLOW_REF,
      commit: authorityCommit,
      tree: authorityTreeChar.repeat(40),
      workflowPath: AUTHORITY_WORKFLOW_PATH,
      workflowBlobSha256: sha256(authorityWorkflowBytes),
      phaseProofRegistrySha256: digest(`registry:${phaseId}`),
      jwksRegistrySha256: jwksRegistry.registrySha256,
      toolchainSha256: digest(`toolchain:${phaseId}`),
      judgeImageDigest,
      toolchainCommissioned: true,
      ancestorOfScopeVerified: true,
    },
    phase: {
      phaseId,
      scopeBaseCommit: scopeCommit,
      scopeBaseTree: scopeTreeChar.repeat(40),
      scopeLedgerSha256: digest(`scope-ledger:${phaseId}`),
      candidateLedgerRevision: 17,
      candidateLedgerSha256: digest(`candidate-ledger:${phaseId}`),
      qualityPlanSha256: digest(`quality-plan:${phaseId}`),
      populationFloors: floors,
      commandPlan: exactCommandPlan,
      commandPlanSha256: sha256(stableJson(exactCommandPlan)),
      testAuthorityTree: digest(`test-tree:${phaseId}`).slice(0, 40),
      frozenAuthorityPathsSha256: digest(`authority-paths:${phaseId}`),
      ledgerDeltaSha256: digest(`ledger-delta:${phaseId}`),
      activePhaseVerified: true,
      dependenciesVerified: true,
      allowedPathsVerified: true,
      antiWeakeningVerified: true,
    },
    candidate: {
      commit: candidateCommit,
      tree: candidateTreeChar.repeat(40),
      parent: scopeCommit,
      changedPathsSha256: digest(`changed-paths:${phaseId}`),
      diffSha256: digest(`diff:${phaseId}`),
      authoritySnapshotSha256: digest(`authority-snapshot:${phaseId}`),
      scopeParentVerified: true,
    },
    sourceManifestSha256: digest(`source-manifest:${phaseId}`),
  });

  const artifacts = new Map();
  const macCommands = exactCommandPlan.commands.filter(
    (command) => command.platform === "macos",
  );
  const macExecutions = macCommands.map((command, index) =>
    childExecution(command, unitTap(), "macos", index),
  );
  const semanticStderrBytes = Buffer.from(
    stableJson(macExecutions.map((entry) => entry.stderrBase64)),
  );
  const macEvidence = {
    unitCoverage: addArtifact(artifacts, stableJson(macExecutions)),
    stdout: addArtifact(
      artifacts,
      stableJson(macExecutions.map((entry) => entry.stdoutBase64)),
    ),
    stderr: null,
  };
  const macosIdentityBody = buildMacosIdentityBody({
    materialization,
    runner: {
      runnerImage: "macos-15",
      nodeVersion: "v22.14.0",
      nodeSha256: digest("macos-node"),
      npmVersion: "10.9.2",
      npmCliSha256: digest("macos-npm"),
    },
    executedCommandCount: macCommands.length,
    executedCommandNamesSha256: sha256(
      stableJson(macCommands.map((command) => command.name).sort()),
    ),
    executionReceiptsSha256: sha256(stableJson(macExecutions)),
    unitCoverage: macEvidence.unitCoverage,
    stdout: macEvidence.stdout,
    semanticStderrSha256: sha256(semanticStderrBytes),
    semanticStderrByteLength: semanticStderrBytes.length,
  });
  const macosIdentityBodySha256 = sha256(stableJson(macosIdentityBody));
  const macosIdentityAudience =
    `pikiio-proof-v3:${macosIdentityBodySha256}`;
  const macosIdentityCollectorReceipt = {
    schema: COLLECTOR_RECEIPT_SCHEMA,
    attestationBodySha256: macosIdentityBodySha256,
    audience: macosIdentityAudience,
    oidcToken: signJwt(
      oidcPayload({
        authorityCommit,
        run: materialization.run,
        audience: macosIdentityAudience,
        jti: MACOS_OIDC_JTI,
      }),
    ),
    authorityCommit,
    phaseScopeBaseCommit: scopeCommit,
    candidateCommit,
    run: clone(materialization.run),
    requestedAt: new Date(OIDC_IAT * 1000).toISOString(),
    receivedAt: new Date((OIDC_IAT + 1) * 1000).toISOString(),
    productionAuthority: false,
  };
  const macosIdentityEvidence = validateMacosIdentityEvidence({
    schema: MACOS_IDENTITY_EVIDENCE_SCHEMA,
    identityBody: macosIdentityBody,
    identityBodySha256: macosIdentityBodySha256,
    collectorReceipt: macosIdentityCollectorReceipt,
    collectorReceiptSha256: sha256(
      stableJson(macosIdentityCollectorReceipt),
    ),
    semanticStderrBase64: macExecutions.map(
      (entry) => entry.stderrBase64,
    ),
  });
  macEvidence.stderr = addArtifact(
    artifacts,
    stableJson(macosIdentityEvidence),
  );
  const macosJudge = sealPlatformReceipt({
    role: "macos-unit",
    materializationReceiptHash: materialization.receiptHash,
    authorityCommit: materialization.authority.commit,
    phaseId,
    phaseScopeBaseCommit: scopeCommit,
    candidateCommit,
    candidateTree: materialization.candidate.tree,
    populationFloors: floors,
    commandPlanSha256: materialization.phase.commandPlanSha256,
    toolchainSha256: materialization.authority.toolchainSha256,
    platform: "darwin",
    runnerImage: "macos-15",
    nodeVersion: "v22.14.0",
    nodeSha256: digest("macos-node"),
    npmVersion: "10.9.2",
    npmCliSha256: digest("macos-npm"),
    executedCommandCount: macCommands.length,
    executedCommandNamesSha256: sha256(
      stableJson(
        exactCommandPlan.commands
          .filter((command) => command.platform === "macos")
          .map((command) => command.name)
          .sort(),
      ),
    ),
    executionReceiptsSha256: sha256(stableJson(macExecutions)),
    evidence: macEvidence,
    metrics: {
      unit: metrics().unit,
      coverage: metrics().coverage,
    },
    outcome: "pass",
  });
  const authorityWorkflow = addArtifact(artifacts, authorityWorkflowBytes);
  const macosLineage = buildMacosLineage({
    materialization,
    macosJudge,
    materializationArtifact: {
      artifactId: String(910000 + Object.keys(PHASE_COMMITS).indexOf(phaseId)),
      artifactDigest: `sha256:${digest(`materialization-artifact:${phaseId}`)}`,
      receiptHash: materialization.receiptHash,
    },
    macosArtifact: {
      artifactId: String(920000 + Object.keys(PHASE_COMMITS).indexOf(phaseId)),
      artifactDigest: `sha256:${digest(`macos-artifact:${phaseId}`)}`,
      receiptHash: macosJudge.receiptHash,
    },
    authorityWorkflowBytes,
  });
  assert.deepEqual(macosLineage.authorityWorkflow, authorityWorkflow);
  function judge(role) {
    const linuxCommands = exactCommandPlan.commands.filter(
      (command) => command.platform === "linux",
    );
    const executions = linuxCommands.map((command, index) => {
      let stdout = "";
      if (command.group === "gherkin") {
        stdout = `${stableJson(gherkinRaw())}\n`;
      } else if (command.group === "mutation") {
        stdout = `${stableJson(mutationRaw())}\n`;
      }
      return childExecution(command, stdout, role, index);
    });
    const evidence = {
      unitCoverage: macEvidence.unitCoverage,
      gherkin: addArtifact(
        artifacts,
        stableJson(
          executions.filter(
            (entry) =>
              linuxCommands.find(
                (command) => command.name === entry.commandName,
              ).group === "gherkin",
          ),
        ),
      ),
      mutation: addArtifact(
        artifacts,
        stableJson(
          executions.filter(
            (entry) =>
              linuxCommands.find(
                (command) => command.name === entry.commandName,
              ).group === "mutation",
          ),
        ),
      ),
      layers: addArtifact(artifacts, stableJson(executions)),
      macosUnit: addArtifact(
        artifacts,
        `${stableJson(macosJudge)}\n`,
      ),
      stdout: addArtifact(
        artifacts,
        stableJson(executions.map((entry) => entry.stdoutBase64)),
      ),
      stderr: addArtifact(
        artifacts,
        stableJson(executions.map((entry) => entry.stderrBase64)),
      ),
    };
    return sealJudgeReceipt({
      role,
      materializationReceiptHash: materialization.receiptHash,
      authorityCommit: materialization.authority.commit,
      phaseId,
      phaseScopeBaseCommit: scopeCommit,
      candidateCommit,
      candidateTree: materialization.candidate.tree,
      phaseProofRegistrySha256:
        materialization.authority.phaseProofRegistrySha256,
      qualityPlanSha256: materialization.phase.qualityPlanSha256,
      populationFloors: floors,
      commandPlanSha256: materialization.phase.commandPlanSha256,
      sourceManifestSha256: materialization.sourceManifestSha256,
      executedCommandCount: linuxCommands.length,
      executedCommandNamesSha256: sha256(
        stableJson(
          exactCommandPlan.commands
            .filter((command) => command.platform === "linux")
            .map((command) => command.name)
            .sort(),
        ),
      ),
      executionReceiptsSha256: sha256(stableJson(executions)),
      macosReceiptHash: macosJudge.receiptHash,
      sandbox: {
        imageDigest: judgeImageDigest,
        toolchainSha256: materialization.authority.toolchainSha256,
        uid: role === "primary" ? 65532 : 65531,
        network: "none",
        capabilities: "none",
        readOnlyRoot: true,
        authorityMount: "read_only",
        candidateMount: "read_only",
        credentialKeysPresent: [],
        githubOutputPresent: false,
        freshState: true,
        freshContainerPerCommand: true,
        childProtocol: "pikiio-external-ci-child-v3",
        workspaceBeforeSha256: digest(`${phaseId}:${role}:workspace`),
        workspaceAfterSha256: digest(`${phaseId}:${role}:workspace`),
      },
      evidence,
      metrics: metrics(),
      outcome: "pass",
    });
  }

  const primaryJudge = judge("primary");
  const independentJudge = judge("independent");
  const manifest = evidenceReferences(
    primaryJudge,
    independentJudge,
    macosJudge,
    macosLineage,
  );
  const verdict = sealQualityVerdict({
    materializationReceiptHash: materialization.receiptHash,
    judgeReceiptHashes: {
      primary: primaryJudge.receiptHash,
      independent: independentJudge.receiptHash,
    },
    macosReceiptHash: macosJudge.receiptHash,
    populationFloors: floors,
    evidenceManifestSha256: evidenceManifestSha256(manifest),
    metrics: metrics(),
    passed: true,
  });
  const attestationBody = buildExternalCiAttestationBody({
    materialization,
    macosLineage,
    macosJudge,
    primaryJudge,
    independentJudge,
    verdict,
  });
  const replayJti = OIDC_JTI;
  const audience = `pikiio-proof-v3:${sha256(stableJson(attestationBody))}`;
  const oidcToken = signJwt(
    oidcPayload({
      authorityCommit,
      run: materialization.run,
      audience,
      jti: replayJti,
    }),
  );
  const collectorReceipt = {
    schema: COLLECTOR_RECEIPT_SCHEMA,
    attestationBodySha256: sha256(stableJson(attestationBody)),
    audience,
    oidcToken,
    authorityCommit,
    phaseScopeBaseCommit: scopeCommit,
    candidateCommit,
    run: clone(materialization.run),
    requestedAt: new Date(OIDC_IAT * 1000).toISOString(),
    receivedAt: new Date((OIDC_IAT + 1) * 1000).toISOString(),
    productionAuthority: false,
  };
  const replay = {
    issuer: "https://token.actions.githubusercontent.com",
    jti: replayJti,
    replayKeySha256: sha256(
      stableJson({
        issuer: "https://token.actions.githubusercontent.com",
        jti: replayJti,
        repository: EXPECTED_REPOSITORY,
        runId: materialization.run.runId,
        runAttempt: materialization.run.runAttempt,
      }),
    ),
    multiHostSafe: false,
  };
  const certification = sealExternalCiCertification({
    attestationBody,
    collectorReceipt,
    evidenceManifest: manifest,
    replay,
    verifiedAt: "2026-07-24T06:00:02.000Z",
  });
  const request = {
    schema: REQUEST_SCHEMA,
    phaseId,
    phaseScopeBaseCommit: scopeCommit,
    candidateCommit,
    requestNonce: materialization.run.requestNonce,
  };
  const trustedAuthority = {
    ref: materialization.authority.ref,
    commit: materialization.authority.commit,
    workflowPath: materialization.authority.workflowPath,
    workflowBlobSha256: materialization.authority.workflowBlobSha256,
    phaseProofRegistrySha256:
      materialization.authority.phaseProofRegistrySha256,
    jwksRegistrySha256: materialization.authority.jwksRegistrySha256,
    toolchainSha256: materialization.authority.toolchainSha256,
    judgeImageDigest: materialization.authority.judgeImageDigest,
  };
  const bundle = sealExternalCiPackage({
    request,
    materialization,
    macosLineage,
    macosJudge,
    primaryJudge,
    independentJudge,
    verdict,
    certification,
  });
  return {
    request,
    trustedAuthority,
    materialization,
    macosLineage,
    macosJudge,
    macosIdentityBody,
    macosIdentityEvidence,
    primaryJudge,
    independentJudge,
    verdict,
    attestationBody,
    certification,
    artifacts,
    jwksRegistry,
    nowMs: (OIDC_IAT + 2) * 1000,
    bundle,
  };
}

function rebindMacosIdentityEvidence({
  materialization,
  macos,
  artifacts,
  jti = MACOS_OIDC_JTI,
}) {
  const executions = JSON.parse(
    artifacts.get(macos.evidence.unitCoverage.address).toString("utf8"),
  );
  const semanticStderrBase64 = executions.map(
    (entry) => entry.stderrBase64,
  );
  const semanticStderrBytes = Buffer.from(
    stableJson(semanticStderrBase64),
  );
  const identityBody = buildMacosIdentityBody({
    materialization,
    runner: {
      runnerImage: macos.runnerImage,
      nodeVersion: macos.nodeVersion,
      nodeSha256: macos.nodeSha256,
      npmVersion: macos.npmVersion,
      npmCliSha256: macos.npmCliSha256,
    },
    executedCommandCount: macos.executedCommandCount,
    executedCommandNamesSha256: macos.executedCommandNamesSha256,
    executionReceiptsSha256: macos.executionReceiptsSha256,
    unitCoverage: macos.evidence.unitCoverage,
    stdout: macos.evidence.stdout,
    semanticStderrSha256: sha256(semanticStderrBytes),
    semanticStderrByteLength: semanticStderrBytes.length,
  });
  const identityBodySha256 = sha256(stableJson(identityBody));
  const audience = `pikiio-proof-v3:${identityBodySha256}`;
  const collectorReceipt = {
    schema: COLLECTOR_RECEIPT_SCHEMA,
    attestationBodySha256: identityBodySha256,
    audience,
    oidcToken: signJwt(
      oidcPayload({
        authorityCommit: materialization.authority.commit,
        run: materialization.run,
        audience,
        jti,
      }),
    ),
    authorityCommit: materialization.authority.commit,
    phaseScopeBaseCommit: materialization.phase.scopeBaseCommit,
    candidateCommit: materialization.candidate.commit,
    run: clone(materialization.run),
    requestedAt: new Date(OIDC_IAT * 1000).toISOString(),
    receivedAt: new Date((OIDC_IAT + 1) * 1000).toISOString(),
    productionAuthority: false,
  };
  const identityEvidence = validateMacosIdentityEvidence({
    schema: MACOS_IDENTITY_EVIDENCE_SCHEMA,
    identityBody,
    identityBodySha256,
    collectorReceipt,
    collectorReceiptSha256: sha256(stableJson(collectorReceipt)),
    semanticStderrBase64,
  });
  macos.evidence.stderr = addArtifact(
    artifacts,
    stableJson(identityEvidence),
  );
  return identityEvidence;
}

function signMacosIdentityEvidence({
  body,
  materialization,
  semanticStderrBase64,
  jti = MACOS_OIDC_JTI,
}) {
  const identityBodySha256 = sha256(stableJson(body));
  const audience = `pikiio-proof-v3:${identityBodySha256}`;
  const collectorReceipt = {
    schema: COLLECTOR_RECEIPT_SCHEMA,
    attestationBodySha256: identityBodySha256,
    audience,
    oidcToken: signJwt(
      oidcPayload({
        authorityCommit: materialization.authority.commit,
        run: materialization.run,
        audience,
        jti,
      }),
    ),
    authorityCommit: materialization.authority.commit,
    phaseScopeBaseCommit: materialization.phase.scopeBaseCommit,
    candidateCommit: materialization.candidate.commit,
    run: clone(materialization.run),
    requestedAt: new Date(OIDC_IAT * 1000).toISOString(),
    receivedAt: new Date((OIDC_IAT + 1) * 1000).toISOString(),
    productionAuthority: false,
  };
  return validateMacosIdentityEvidence({
    schema: MACOS_IDENTITY_EVIDENCE_SCHEMA,
    identityBody: body,
    identityBodySha256,
    collectorReceipt,
    collectorReceiptSha256: sha256(stableJson(collectorReceipt)),
    semanticStderrBase64,
  });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof ExternalCiProofError, true);
    assert.equal(error.code, code);
    return true;
  });
}

async function expectCodeAsync(fn, code) {
  await assert.rejects(Promise.resolve().then(fn), (error) => {
    assert.equal(error instanceof ExternalCiProofError, true);
    assert.equal(error.code, code);
    return true;
  });
}

describe("v3 exact and bounded schemas", () => {
  test("request is the only caller-controlled object and cannot smuggle proof material", () => {
    const { request } = makeFixture();
    assert.deepEqual(validateCertificationRequest(request), request);
    assert.equal(request.phaseScopeBaseCommit === request.candidateCommit, false);

    for (const [field, value] of [
      ["attestationBody", {}],
      ["proofInputs", "caller-controlled"],
      ["jwksRegistrySha256", digest("caller-jwks")],
      ["metrics", metrics()],
      ["authorityCommit", "1".repeat(40)],
      ["evidenceManifest", []],
    ]) {
      expectCode(
        () => validateCertificationRequest({ ...request, [field]: value }),
        "UNEXPECTED_FIELDS",
      );
    }
  });

  test("request validates schema, phase, commit roles, nonce, and byte bound", () => {
    const { request } = makeFixture();
    const cases = [
      [{ ...request, schema: "v2" }, "INVALID_SCHEMA"],
      [{ ...request, phaseId: "MAIL-01" }, "INVALID_PHASE"],
      [{ ...request, phaseScopeBaseCommit: "bad" }, "INVALID_COMMIT"],
      [{ ...request, candidateCommit: "bad" }, "INVALID_COMMIT"],
      [
        { ...request, candidateCommit: request.phaseScopeBaseCommit },
        "COMMIT_ROLE_COLLISION",
      ],
      [{ ...request, requestNonce: "bad" }, "INVALID_NONCE"],
    ];
    for (const [value, code] of cases) {
      expectCode(() => validateCertificationRequest(value), code);
    }
  });

  test("all receipt schemas self-hash and categorically deny production authority", () => {
    const fixture = makeFixture();
    assert.equal(fixture.materialization.schema, MATERIALIZATION_SCHEMA);
    assert.equal(fixture.primaryJudge.schema, JUDGE_SCHEMA);
    assert.equal(fixture.macosJudge.schema, PLATFORM_RECEIPT_SCHEMA);
    assert.equal(fixture.verdict.schema, VERDICT_SCHEMA);
    assert.equal(fixture.attestationBody.schema, ATTESTATION_BODY_SCHEMA);
    assert.equal(fixture.certification.schema, CERTIFICATION_SCHEMA);
    assert.equal(fixture.bundle.schema, PACKAGE_SCHEMA);
    assert.equal(fixture.verdict.productionAuthority, false);
    assert.equal(fixture.attestationBody.productionAuthority, false);
    assert.equal(fixture.certification.productionAuthority, false);
    assert.equal(
      fixture.materialization.receiptHash,
      hashWithoutField(fixture.materialization, "receiptHash"),
    );
    assert.equal(
      fixture.primaryJudge.receiptHash,
      hashWithoutField(fixture.primaryJudge, "receiptHash"),
    );
    assert.equal(
      fixture.verdict.receiptHash,
      hashWithoutField(fixture.verdict, "receiptHash"),
    );
    assert.equal(
      fixture.certification.certificationHash,
      hashWithoutField(fixture.certification, "certificationHash"),
    );
  });

  test("command plan contains every exact group and refuses omission, platform swaps, and duplicate names", () => {
    const plan = commandPlan();
    assert.deepEqual(validateCommandPlan(plan), plan);
    for (const mutate of [
      (value) => {
        value.commands = value.commands.filter(
          (command) => command.group !== "production-shaped",
        );
      },
      (value) => {
        value.commands.find((command) => command.group === "unit").platform =
          "linux";
      },
      (value) => {
        value.commands[1].name = value.commands[0].name;
      },
      (value) => {
        const command = value.commands.find(
          (command) =>
            command.group === "gherkin" && command.repeat === 3,
        );
        command.repeat = 2;
        command.definitionSha256 = commandDefinitionSha256(command);
      },
    ]) {
      const changed = clone(plan);
      mutate(changed);
      expectCode(
        () => validateCommandPlan(changed),
        changed.commands.some(
          (command, index) =>
            changed.commands.findIndex(
              (candidate) => candidate.name === command.name,
            ) !== index,
        )
          ? "INVALID_COMMAND_PLAN"
          : changed.commands.some(
                (command) =>
                  command.group === "unit" && command.platform !== "macos",
              )
            ? "INVALID_COMMAND_PLAN"
            : "INCOMPLETE_COMMAND_PLAN",
      );
    }
    const redefined = clone(plan);
    redefined.commands[0].args.push("attacker.js");
    expectCode(
      () => validateCommandPlan(redefined),
      "COMMAND_DEFINITION_MISMATCH",
    );
  });

  test("command plan rejects every schema, path, cardinality, executable, and argument weakening", () => {
    const plan = commandPlan();
    assert.match(commandNamesSha256(plan, "linux"), /^[a-f0-9]{64}$/);
    assert.match(commandNamesSha256(plan, "macos"), /^[a-f0-9]{64}$/);
    expectCode(() => commandNamesSha256(plan, "windows"), "INVALID_PLATFORM");
    expectCode(
      () => commandDefinitionSha256(null),
      "INVALID_COMMAND_PLAN",
    );
    const cases = [
      [(value) => {
        value.schema = "v2";
      }, "INVALID_SCHEMA"],
      [(value) => {
        value.repeats = 2;
      }, "INVALID_INTEGER"],
      [(value) => {
        value.requiredCoverageFiles = null;
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.requiredCoverageFiles = [];
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.requiredCoverageFiles = ["README.md"];
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.requiredCoverageFiles.push(
          value.requiredCoverageFiles[0],
        );
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.commands = null;
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.commands = [];
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.commands[0].name = "unsafe\u0000name";
      }, "INVALID_STRING"],
      [(value) => {
        value.commands[0].group = "shell";
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.commands[0].executable = "bash";
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.commands[0].args = "not-an-array";
      }, "INVALID_COMMAND_PLAN"],
      [(value) => {
        value.commands[0].args = ["unsafe\nargument"];
      }, "INVALID_COMMAND_PLAN"],
    ];
    for (const [mutate, code] of cases) {
      const changed = clone(plan);
      mutate(changed);
      expectCode(() => validateCommandPlan(changed), code);
    }
  });

  test("stable JSON is deterministic and refuses cycles and undefined top-level values", () => {
    assert.equal(
      stableJson({ z: [{ b: 2, a: 1 }], a: true }),
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
    const circular = {};
    circular.self = circular;
    expectCode(() => stableJson(circular), "NON_CANONICAL_JSON");
    expectCode(() => stableJson(undefined), "NON_CANONICAL_JSON");
  });
});

describe("A, S, and C are independent, cross-bound identities", () => {
  test("a disposable SHA-1 repository constructs A..B -> S -> C without a fixed-point commit", () => {
    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-source-history-"),
    );
    const ledgerPath =
      "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json";
    const runGit = (args) => {
      const result = spawnSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        0,
        `${args.join(" ")}: ${result.stderr}`,
      );
      return result.stdout.trim();
    };
    const writeLedger = (value) => {
      const absolutePath = path.join(repository, ledgerPath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, `${stableJson(value)}\n`);
    };
    const commit = (message) => {
      runGit(["add", "--all"]);
      runGit(["commit", "--quiet", "-m", message]);
      return runGit(["rev-parse", "HEAD"]);
    };
    try {
      spawnSync("git", ["init", "--quiet", "--object-format=sha1", repository], {
        encoding: "utf8",
      });
      runGit(["config", "user.name", "Pikiio Proof"]);
      runGit(["config", "user.email", "proof@invalid.example"]);
      const priorLedger = {
        schema: "test-ledger-v1",
        mission: "frozen",
        activePhaseId: "ACTION-01",
        qualityPolicy: {
          profiles: { critical: { lines: 95, branches: 90, functions: 95 } },
        },
        phases: [
          {
            id: "ACTION-01",
            scopeBaseCommit: "0".repeat(40),
            objective: "frozen mission",
          },
        ],
        automationContract: { liveWrites: false },
      };
      writeLedger(priorLedger);
      fs.mkdirSync(path.join(repository, "ops"), { recursive: true });
      fs.writeFileSync(
        path.join(repository, "ops", "authority.js"),
        '"use strict";\n',
      );
      fs.mkdirSync(path.join(repository, "lib"), { recursive: true });
      fs.writeFileSync(path.join(repository, "lib", "product.js"), "module.exports = 1;\n");
      const A = commit("authority");
      fs.mkdirSync(path.join(repository, "docs"), { recursive: true });
      fs.writeFileSync(path.join(repository, "docs", "prelude.md"), "prepared\n");
      const B = commit("prepare active scope");
      const scopeLedger = clone(priorLedger);
      scopeLedger.phases[0].scopeBaseCommit = B;
      writeLedger(scopeLedger);
      const S = commit("declare scope parent");
      fs.writeFileSync(path.join(repository, "lib", "product.js"), "module.exports = 2;\n");
      const C = commit("candidate behavior");
      const ledgerAt = (revision) =>
        JSON.parse(runGit(["show", `${revision}:${ledgerPath}`]));
      const ledgerBytesAt = (revision) =>
        Buffer.from(runGit(["show", `${revision}:${ledgerPath}`]) + "\n");
      const changedPaths = (from, to) =>
        runGit(["diff", "--name-only", from, to])
          .split("\n")
          .filter(Boolean)
          .sort();
      const authorityBlob = (revision) =>
        runGit(["rev-parse", `${revision}:ops/authority.js`]);
      const facts = {
        phaseId: "ACTION-01",
        authorityCommit: A,
        scopeParentCommit: B,
        scopeCommit: S,
        candidateCommit: C,
        scopeParent: runGit(["rev-parse", `${S}^`]),
        candidateParent: runGit(["rev-parse", `${C}^`]),
        authorityAncestorOfScopeParent:
          spawnSync("git", [
            "-C",
            repository,
            "merge-base",
            "--is-ancestor",
            A,
            B,
          ]).status === 0,
        scopeLedgerBaseCommit: ledgerAt(S).phases[0].scopeBaseCommit,
        candidateLedgerBaseCommit: ledgerAt(C).phases[0].scopeBaseCommit,
        scopeLedgerSha256: sha256(ledgerBytesAt(S)),
        candidateLedgerSha256: sha256(ledgerBytesAt(C)),
        priorLedger: ledgerAt(B),
        scopeLedger: ledgerAt(S),
        candidateLedger: ledgerAt(C),
        scopeDeclarationChangedPaths: changedPaths(B, S),
        candidateChangedPaths: changedPaths(S, C),
        candidatePathsAllowed: true,
        frozenAuthorityPathsVerified:
          new Set([authorityBlob(A), authorityBlob(S), authorityBlob(C)]).size ===
          1,
        frozenPhaseContractVerified: true,
      };
      assert.deepEqual(validateConstructibleSourceHistory(facts), facts);
      assert.deepEqual(facts.scopeDeclarationChangedPaths, [ledgerPath]);
      assert.deepEqual(facts.candidateChangedPaths, ["lib/product.js"]);

      const extraScopeField = clone(facts);
      extraScopeField.scopeLedger.mission = "attacker";
      expectCode(
        () => validateConstructibleSourceHistory(extraScopeField),
        "SCOPE_DECLARATION_MISMATCH",
      );
      const emptyCandidate = clone(facts);
      emptyCandidate.candidateChangedPaths = [];
      expectCode(
        () => validateConstructibleSourceHistory(emptyCandidate),
        "INVALID_PATH_SET",
      );
      const candidateLedgerMutation = clone(facts);
      candidateLedgerMutation.candidateLedger.automationContract.liveWrites =
        true;
      expectCode(
        () => validateConstructibleSourceHistory(candidateLedgerMutation),
        "LEDGER_MUTATED_BY_CANDIDATE",
      );
      const forbiddenCandidateLedgerPath = clone(facts);
      forbiddenCandidateLedgerPath.candidateChangedPaths = [
        ledgerPath,
        "lib/product.js",
      ].sort();
      expectCode(
        () => validateConstructibleSourceHistory(forbiddenCandidateLedgerPath),
        "LEDGER_MUTATED_BY_CANDIDATE",
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  for (const phaseId of ["GOV-00", "TRUTH-01", "ACTION-01"]) {
    test(`${phaseId} verifies offline with A != S and S as the sole parent of C`, async () => {
      const fixture = makeFixture(phaseId);
      assert.notEqual(
        fixture.materialization.authority.commit,
        fixture.materialization.phase.scopeBaseCommit,
      );
      const result = await verifyExternalCiCertification(fixture);
      assert.deepEqual(result, {
        valid: true,
        phaseId,
        authorityCommit: fixture.materialization.authority.commit,
        phaseScopeBaseCommit:
          fixture.materialization.phase.scopeBaseCommit,
        scopeBaseCommit: fixture.materialization.phase.scopeBaseCommit,
        candidateCommit: fixture.materialization.candidate.commit,
        requestNonce: fixture.materialization.run.requestNonce,
        qualityVerdictHash: fixture.verdict.receiptHash,
        evidenceManifestSha256:
          fixture.verdict.evidenceManifestSha256,
        replayKeySha256:
          fixture.certification.replay.replayKeySha256,
        attestationBodySha256:
          fixture.certification.attestationBodySha256,
        certificationHash: fixture.certification.certificationHash,
        productionAuthority: false,
      });
      assert.equal(Object.isFrozen(result), true);
    });
  }

  test("request/materialization substitution is rejected before OIDC verification", async () => {
    const fixture = makeFixture();
    for (const mutate of [
      (value) => {
        value.request.phaseId = "ACTION-01";
      },
      (value) => {
        value.request.phaseScopeBaseCommit = "f".repeat(40);
      },
      (value) => {
        value.request.candidateCommit = "f".repeat(40);
      },
      (value) => {
        value.request.requestNonce = digest("wrong nonce");
      },
    ]) {
      const changed = { ...fixture, request: clone(fixture.request) };
      mutate(changed);
      await expectCodeAsync(
        () => verifyExternalCiCertification(changed),
        "REQUEST_BINDING_MISMATCH",
      );
    }
  });

  test("offline verification requires a local A/toolchain trust anchor", async () => {
    const fixture = makeFixture();
    for (const [trustedAuthority, code] of [
      [undefined, "UNEXPECTED_FIELDS"],
      [
        { ...fixture.trustedAuthority, commit: "f".repeat(40) },
        "UNTRUSTED_AUTHORITY",
      ],
      [
        {
          ...fixture.trustedAuthority,
          toolchainSha256: digest("unapproved-toolchain"),
        },
        "UNTRUSTED_AUTHORITY",
      ],
      [
        { ...fixture.trustedAuthority, callerOverride: true },
        "UNEXPECTED_FIELDS",
      ],
      [
        { ...fixture.trustedAuthority, ref: "main" },
        "UNTRUSTED_AUTHORITY",
      ],
    ]) {
      await expectCodeAsync(
        () =>
          verifyExternalCiCertification({
            ...fixture,
            trustedAuthority,
          }),
        code,
      );
    }
  });

  test("every A/S/C judge binding is enforced", () => {
    const fixture = makeFixture();
    const mutations = [
      ["materializationReceiptHash", digest("wrong-materialization")],
      ["authorityCommit", "f".repeat(40)],
      ["phaseId", "ACTION-01"],
      ["phaseScopeBaseCommit", "f".repeat(40)],
      ["candidateCommit", "f".repeat(40)],
      ["candidateTree", "f".repeat(40)],
      ["phaseProofRegistrySha256", digest("wrong-registry")],
      ["qualityPlanSha256", digest("wrong-quality-plan")],
      ["commandPlanSha256", digest("wrong-command-plan")],
      ["sourceManifestSha256", digest("wrong-source-manifest")],
    ];
    for (const [field, value] of mutations) {
      const independent = clone(fixture.independentJudge);
      independent[field] = value;
      independent.receiptHash = hashWithoutField(independent, "receiptHash");
      expectCode(
        () =>
          buildExternalCiAttestationBody({
            materialization: fixture.materialization,
            macosLineage: fixture.macosLineage,
            macosJudge: fixture.macosJudge,
            primaryJudge: fixture.primaryJudge,
            independentJudge: independent,
            verdict: fixture.verdict,
          }),
        "RECEIPT_BINDING_MISMATCH",
      );
    }
  });
});

describe("immutable macOS artifact lineage", () => {
  test("the signed lineage binds exact artifact identities to archived A workflow bytes", () => {
    const fixture = makeFixture();
    const lineage = validateMacosLineage(fixture.macosLineage);
    assert.equal(lineage.schema, MACOS_LINEAGE_SCHEMA);
    assert.equal(
      lineage.authorityWorkflow.sha256,
      fixture.materialization.authority.workflowBlobSha256,
    );
    assert.equal(
      lineage.materializationArtifact.receiptHash,
      fixture.materialization.receiptHash,
    );
    assert.equal(
      lineage.macosArtifact.receiptHash,
      fixture.macosJudge.receiptHash,
    );
    assert.deepEqual(lineage.macosUnitNeeds, ["materialize"]);
    assert.deepEqual(lineage.judgeNeeds, ["materialize", "macos_unit"]);
    assert.deepEqual(lineage.reducerNeeds, [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
    ]);
    assert.deepEqual(lineage.collectorNeeds, [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
      "reduce",
    ]);
    assert.equal(
      fixture.attestationBody.evidence.macosLineageReceiptHash,
      lineage.receiptHash,
    );
    assert.equal(
      fixture.attestationBody.evidence.authorityWorkflowRawSha256,
      lineage.authorityWorkflow.sha256,
    );
  });

  test("lineage schema, artifact, needs, CAS, and authority sabotage fail closed", () => {
    const fixture = makeFixture();
    const mutations = [
      [(value) => {
        value.extra = true;
      }, "UNEXPECTED_FIELDS"],
      [(value) => {
        value.schema = "pikiio-external-ci-macos-lineage-v2";
      }, "INVALID_SCHEMA"],
      [(value) => {
        value.repository = "attacker/repo";
      }, "INVALID_REPOSITORY"],
      [(value) => {
        value.authority.commit = "x";
      }, "INVALID_COMMIT"],
      [(value) => {
        value.authority.workflowPath = ".github/workflows/attacker.yml";
      }, "INVALID_WORKFLOW_PATH"],
      [(value) => {
        value.materializationArtifact.artifactId = "0";
      }, "INVALID_ARTIFACT_ID"],
      [(value) => {
        value.macosArtifact.artifactDigest = `sha512:${digest("wrong")}`;
      }, "INVALID_ARTIFACT_DIGEST"],
      [(value) => {
        value.macosArtifact.receiptHash = "bad";
      }, "INVALID_SHA256"],
      [(value) => {
        value.macosUnitNeeds = ["candidate"];
      }, "MACOS_LINEAGE_INVALID"],
      [(value) => {
        value.judgeNeeds = ["materialize"];
      }, "MACOS_LINEAGE_INVALID"],
      [(value) => {
        value.reducerNeeds = ["macos_unit"];
      }, "MACOS_LINEAGE_INVALID"],
      [(value) => {
        value.collectorNeeds = ["reduce"];
      }, "MACOS_LINEAGE_INVALID"],
      [(value) => {
        value.authorityWorkflow.address = "artifact-name";
      }, "INVALID_CAS_ADDRESS"],
      [(value) => {
        value.productionAuthority = true;
      }, "PRODUCTION_AUTHORITY_FORBIDDEN"],
      [(value) => {
        value.receiptHash = digest("forged");
      }, "HASH_MISMATCH"],
    ];
    for (const [mutate, code] of mutations) {
      const changed = clone(fixture.macosLineage);
      mutate(changed);
      if (
        ![
          "INVALID_SHA256",
          "PRODUCTION_AUTHORITY_FORBIDDEN",
          "HASH_MISMATCH",
        ].includes(code)
      ) {
        changed.receiptHash = hashWithoutField(changed, "receiptHash");
      }
      expectCode(() => validateMacosLineage(changed), code);
    }
    const duplicate = clone(fixture.macosLineage);
    duplicate.macosArtifact.artifactId =
      duplicate.materializationArtifact.artifactId;
    duplicate.receiptHash = hashWithoutField(duplicate, "receiptHash");
    expectCode(() => validateMacosLineage(duplicate), "MACOS_LINEAGE_INVALID");
  });

  test("archived workflow substitutions cannot weaken successful-needs lineage", () => {
    const fixture = makeFixture();
    const original = fs.readFileSync(COLLECTOR_WORKFLOW);
    const mutations = [
      original.toString("utf8").replace(
        "    needs: [materialize, macos_unit, judge_primary, judge_independent]\n",
        "    needs: [materialize, judge_primary, judge_independent]\n",
      ),
      original.toString("utf8").replace(
        "    needs: [materialize]\n    runs-on: macos-14",
        "    needs: [candidate]\n    needs: [materialize]\n    runs-on: macos-14",
      ),
      original.toString("utf8").replace(
        "          artifact-ids: ${{ needs.materialize.outputs.artifact_id }}",
        "          artifact-ids: attacker\n          artifact-ids: ${{ needs.materialize.outputs.artifact_id }}",
      ),
      original.toString("utf8").replace(
        "          PIKIIO_MACOS_ARTIFACT_ID: ${{ needs.macos_unit.outputs.artifact_id }}",
        "          PIKIIO_MACOS_ARTIFACT_ID: ${{ inputs.candidate_sha }}",
      ),
      original.toString("utf8").replace(
        "          PIKIIO_MACOS_ARTIFACT_ID: ${{ needs.macos_unit.outputs.artifact_id }}",
        "          PIKIIO_MACOS_ARTIFACT_ID: ${{ inputs.candidate_sha }}\n          PIKIIO_MACOS_ARTIFACT_ID: ${{ needs.macos_unit.outputs.artifact_id }}",
      ),
      original.toString("utf8").replace(
        "  collect:\n    needs:",
        "  collect:\n    if: always()\n    needs:",
      ),
      original.toString("utf8").replace(
        "      id-token: write",
        "      id-token: read",
      ),
      original.toString("utf8").replace(
        "    permissions:\n      actions: read\n      contents: read\n      id-token: write",
        "    permissions:\n      actions: read\n      contents: write\n      id-token: write",
      ),
      original.toString("utf8").replace(
        "    runs-on: macos-14",
        "    runs-on: ubuntu-24.04",
      ),
      original.toString("utf8").replace(
        "    runs-on: macos-14",
        "    runs-on: ubuntu-24.04\n    # runs-on: macos-14",
      ),
      original.toString("utf8").replace(
        "    runs-on: macos-14",
        "    runs-on: macos-14\n    runs-on: ubuntu-24.04",
      ),
      original.toString("utf8").replace(
        "    runs-on: macos-14",
        "    runs-on: &trusted_runner macos-14",
      ),
      original.toString("utf8").replace(
        "      - name: Upload separately certified macOS unit receipt",
        "      - *candidate_controlled_step\n      - name: Upload separately certified macOS unit receipt",
      ),
      original.toString("utf8").replace(
        "      - name: Upload separately certified macOS unit receipt",
        "      - name: Exfiltrate parent identity\n        run: env\n      - name: Upload separately certified macOS unit receipt",
      ),
      original.toString("utf8").replace(
        "      - name: Upload separately certified macOS unit receipt",
        "      - run: env\n      - name: Upload separately certified macOS unit receipt",
      ),
      original.toString("utf8").replace(
        "          PIKIIO_OIDC_REQUEST_TOKEN: ${{ env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }}",
        "          PIKIIO_OIDC_REQUEST_TOKEN: attacker\n          PIKIIO_OIDC_REQUEST_TOKEN: ${{ env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }}",
      ),
      original.toString("utf8").replace(
        "          PIKIIO_HOST_CREDENTIAL_CANARY: must-not-enter-candidate",
        "          PIKIIO_HOST_CREDENTIAL_CANARY: must-not-enter-candidate\n          PIKIIO_OIDC_REQUEST_TOKEN: ${{ env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }}",
      ),
      original.toString("utf8").replace(
        "  judge_primary:\n    needs:",
        "  judge_primary:\n    permissions:\n      id-token: write\n    needs:",
      ),
      `${original.toString("utf8")}\njobs:\n  attacker:\n    runs-on: ubuntu-latest\n`,
      `${original.toString("utf8")}\n  macos_unit:\n    needs: [materialize]\n`,
    ];
    for (const workflow of mutations) {
      expectCode(
        () =>
          buildMacosLineage({
            materialization: fixture.materialization,
            macosJudge: fixture.macosJudge,
            materializationArtifact:
              fixture.macosLineage.materializationArtifact,
            macosArtifact: fixture.macosLineage.macosArtifact,
            authorityWorkflowBytes: Buffer.from(workflow),
          }),
        "MACOS_LINEAGE_WORKFLOW_INVALID",
      );
    }
  });

  test("offline package refuses artifact substitution and missing archived workflow", () => {
    const fixture = makeFixture();
    const changedLineage = clone(fixture.macosLineage);
    changedLineage.macosArtifact.artifactId = "999999";
    changedLineage.macosArtifact.artifactDigest =
      `sha256:${digest("substituted-macos-artifact")}`;
    changedLineage.receiptHash =
      hashWithoutField(changedLineage, "receiptHash");
    const changedBundle = clone(fixture.bundle);
    changedBundle.macosLineage = changedLineage;
    changedBundle.packageHash =
      hashWithoutField(changedBundle, "packageHash");
    expectCode(
      () =>
        verifyExternalCiPackage({
          bundle: changedBundle,
          trustedAuthority: fixture.trustedAuthority,
          jwksRegistry: fixture.jwksRegistry,
          artifacts: fixture.artifacts,
          nowMs: fixture.nowMs,
        }),
      "ATTESTATION_SUBSTITUTION",
    );

    const missing = new Map(fixture.artifacts);
    missing.delete(fixture.macosLineage.authorityWorkflow.address);
    expectCode(
      () =>
        verifyExternalCiPackage({
          bundle: fixture.bundle,
          trustedAuthority: fixture.trustedAuthority,
          jwksRegistry: fixture.jwksRegistry,
          artifacts: missing,
          nowMs: fixture.nowMs,
        }),
      "MISSING_ARTIFACT",
    );

    const tampered = new Map(fixture.artifacts);
    tampered.set(
      fixture.macosLineage.authorityWorkflow.address,
      Buffer.from("candidate-controlled workflow\n"),
    );
    expectCode(
      () =>
        verifyExternalCiPackage({
          bundle: fixture.bundle,
          trustedAuthority: fixture.trustedAuthority,
          jwksRegistry: fixture.jwksRegistry,
          artifacts: tampered,
          nowMs: fixture.nowMs,
        }),
      "CAS_ARTIFACT_MISMATCH",
    );
  });
});

describe("independently authenticated macOS job identity", () => {
  test("the inner body binds A/S/C/run/toolchain/runner/raw results without self-reference", () => {
    const fixture = makeFixture();
    const body = validateMacosIdentityBody(fixture.macosIdentityBody);
    const evidence = validateMacosIdentityEvidence(
      fixture.macosIdentityEvidence,
    );
    assert.equal(body.schema, MACOS_IDENTITY_BODY_SCHEMA);
    assert.equal(evidence.schema, MACOS_IDENTITY_EVIDENCE_SCHEMA);
    assert.equal(
      evidence.identityBodySha256,
      sha256(stableJson(evidence.identityBody)),
    );
    assert.equal(
      Object.values(body.result).includes(
        fixture.macosJudge.evidence.stderr.sha256,
      ),
      false,
    );
    assert.equal(body.authority.commit, fixture.materialization.authority.commit);
    assert.equal(
      body.phase.scopeBaseCommit,
      fixture.materialization.phase.scopeBaseCommit,
    );
    assert.equal(body.candidate.commit, fixture.materialization.candidate.commit);
    assert.equal(body.runner.jobName, "macos_unit");
    assert.equal(body.runner.runsOn, "macos-14");
    const result = verifyMacosJobIdentity({
      identityEvidence: evidence,
      materialization: fixture.materialization,
      finalCollectorReceipt: fixture.certification.collectorReceipt,
      jwksRegistry: fixture.jwksRegistry,
      nowMs: fixture.nowMs,
    });
    assert.deepEqual(result, {
      valid: true,
      identityBodySha256: evidence.identityBodySha256,
      collectorReceiptSha256: evidence.collectorReceiptSha256,
      jti: MACOS_OIDC_JTI,
      replayKeySha256: result.replayKeySha256,
      productionAuthority: false,
    });
    assert.match(result.replayKeySha256, /^[a-f0-9]{64}$/);
  });

  test("runner, signed body, wrapper, and semantic stderr sabotage fail closed", () => {
    const fixture = makeFixture();
    const semantic = fixture.macosIdentityEvidence.semanticStderrBase64;
    const cases = [
      [
        (body) => {
          body.runner.runnerImage = "ubuntu-24.04";
        },
        "MACOS_IDENTITY_BODY_MISMATCH",
      ],
      [
        (body) => {
          body.result.executionReceiptsSha256 = digest("forged-execution");
        },
        "MACOS_IDENTITY_BODY_MISMATCH",
      ],
      [
        (body) => {
          body.authority.toolchainSha256 = digest("forged-toolchain");
        },
        "MACOS_IDENTITY_BODY_MISMATCH",
      ],
    ];
    for (const [mutate, code] of cases) {
      const body = clone(fixture.macosIdentityBody);
      mutate(body);
      const identity = signMacosIdentityEvidence({
        body,
        materialization: fixture.materialization,
        semanticStderrBase64: semantic,
      });
      const artifacts = new Map(fixture.artifacts);
      const macos = clone(fixture.macosJudge);
      macos.evidence.stderr = addArtifact(artifacts, stableJson(identity));
      expectCode(
        () =>
          reconcileRawEvidence({
            materialization: fixture.materialization,
            macos,
            primary: fixture.primaryJudge,
            independent: fixture.independentJudge,
            artifacts,
          }),
        code,
      );
    }

    const changedSemantic = clone(fixture.macosIdentityEvidence);
    changedSemantic.semanticStderrBase64[0] =
      Buffer.from("forged stderr").toString("base64");
    const artifacts = new Map(fixture.artifacts);
    const macos = clone(fixture.macosJudge);
    macos.evidence.stderr = addArtifact(
      artifacts,
      stableJson(changedSemantic),
    );
    expectCode(
      () =>
        reconcileRawEvidence({
          materialization: fixture.materialization,
          macos,
          primary: fixture.primaryJudge,
          independent: fixture.independentJudge,
          artifacts,
        }),
      "RAW_EVIDENCE_MISMATCH",
    );

    const extra = clone(fixture.macosIdentityEvidence);
    extra.callerOverride = true;
    expectCode(
      () => validateMacosIdentityEvidence(extra),
      "UNEXPECTED_FIELDS",
    );
  });

  test("forged token, unpinned JWKS, and reused final identity are refused", () => {
    const fixture = makeFixture();
    const forged = clone(fixture.macosIdentityEvidence);
    const tokenSegments = forged.collectorReceipt.oidcToken.split(".");
    tokenSegments[2] =
      `${tokenSegments[2][0] === "A" ? "B" : "A"}${tokenSegments[2].slice(1)}`;
    forged.collectorReceipt.oidcToken = tokenSegments.join(".");
    forged.collectorReceiptSha256 = sha256(
      stableJson(forged.collectorReceipt),
    );
    expectCode(
      () =>
        verifyMacosJobIdentity({
          identityEvidence: forged,
          materialization: fixture.materialization,
          finalCollectorReceipt: fixture.certification.collectorReceipt,
          jwksRegistry: fixture.jwksRegistry,
          nowMs: fixture.nowMs,
        }),
      "MACOS_IDENTITY_CRYPTO_INVALID",
    );

    const wrongRegistry = clone(fixture.jwksRegistry);
    wrongRegistry.registrySha256 = digest("not-the-pinned-registry");
    expectCode(
      () =>
        verifyMacosJobIdentity({
          identityEvidence: fixture.macosIdentityEvidence,
          materialization: fixture.materialization,
          finalCollectorReceipt: fixture.certification.collectorReceipt,
          jwksRegistry: wrongRegistry,
          nowMs: fixture.nowMs,
        }),
      "MACOS_IDENTITY_CRYPTO_INVALID",
    );

    const reused = signMacosIdentityEvidence({
      body: fixture.macosIdentityBody,
      materialization: fixture.materialization,
      semanticStderrBase64:
        fixture.macosIdentityEvidence.semanticStderrBase64,
      jti: OIDC_JTI,
    });
    expectCode(
      () =>
        verifyMacosJobIdentity({
          identityEvidence: reused,
          materialization: fixture.materialization,
          finalCollectorReceipt: fixture.certification.collectorReceipt,
          jwksRegistry: fixture.jwksRegistry,
          nowMs: fixture.nowMs,
        }),
      "MACOS_IDENTITY_NOT_INDEPENDENT",
    );
  });

  test("an otherwise valid macOS identity cannot replay across run, request, or A/S/C tuples", () => {
    const fixture = makeFixture("TRUTH-01");
    const otherRun = clone(fixture.materialization);
    otherRun.run.runId = String(Number(otherRun.run.runId) + 100);
    otherRun.run.requestNonce = digest("different-request-nonce");
    otherRun.receiptHash = hashWithoutField(otherRun, "receiptHash");
    const semanticStderrBytes = Buffer.from(
      stableJson(
        fixture.macosIdentityEvidence.semanticStderrBase64,
      ),
    );
    const otherRunBody = buildMacosIdentityBody({
      materialization: otherRun,
      runner: {
        runnerImage: fixture.macosJudge.runnerImage,
        nodeVersion: fixture.macosJudge.nodeVersion,
        nodeSha256: fixture.macosJudge.nodeSha256,
        npmVersion: fixture.macosJudge.npmVersion,
        npmCliSha256: fixture.macosJudge.npmCliSha256,
      },
      executedCommandCount: fixture.macosJudge.executedCommandCount,
      executedCommandNamesSha256:
        fixture.macosJudge.executedCommandNamesSha256,
      executionReceiptsSha256:
        fixture.macosJudge.executionReceiptsSha256,
      unitCoverage: fixture.macosJudge.evidence.unitCoverage,
      stdout: fixture.macosJudge.evidence.stdout,
      semanticStderrSha256: sha256(semanticStderrBytes),
      semanticStderrByteLength: semanticStderrBytes.length,
    });
    const otherRunIdentity = signMacosIdentityEvidence({
      body: otherRunBody,
      materialization: otherRun,
      semanticStderrBase64:
        fixture.macosIdentityEvidence.semanticStderrBase64,
    });
    expectCode(
      () =>
        verifyMacosJobIdentity({
          identityEvidence: otherRunIdentity,
          materialization: fixture.materialization,
          finalCollectorReceipt: fixture.certification.collectorReceipt,
          jwksRegistry: fixture.jwksRegistry,
          nowMs: fixture.nowMs,
        }),
      "MACOS_IDENTITY_CRYPTO_INVALID",
    );

    const foreignTuple = makeFixture("ACTION-01");
    expectCode(
      () =>
        verifyMacosJobIdentity({
          identityEvidence: foreignTuple.macosIdentityEvidence,
          materialization: fixture.materialization,
          finalCollectorReceipt: fixture.certification.collectorReceipt,
          jwksRegistry: fixture.jwksRegistry,
          nowMs: fixture.nowMs,
        }),
      "MACOS_IDENTITY_CRYPTO_INVALID",
    );
  });
});

describe("critical source-level mutation meta-test", () => {
  test("every authority, identity, signature, and credential weakening mutant is killed", (context) => {
    const fixture = makeFixture();
    const originalWorkflow = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    let killed = 0;
    const total = 6;

    const extraGrantWorkflow = originalWorkflow.replace(
      "  judge_primary:\n    needs:",
      "  judge_primary:\n    permissions:\n      id-token: write\n    needs:",
    );
    expectCode(
      () =>
        validateAuthorityWorkflowForMacosLineage(
          Buffer.from(extraGrantWorkflow),
        ),
      "MACOS_LINEAGE_WORKFLOW_INVALID",
    );
    const extraGrantMutant = compileMutant(
      EXTERNAL_PROOF_PATH,
      'workflowText.split("id-token: write").length - 1 !== 2 ||',
      "false ||",
    );
    assert.doesNotThrow(() =>
      extraGrantMutant.validateAuthorityWorkflowForMacosLineage(
        Buffer.from(extraGrantWorkflow),
      ),
    );
    killed += 1;

    const candidateCredentialWorkflow = originalWorkflow.replace(
      "          PIKIIO_HOST_CREDENTIAL_CANARY: must-not-enter-candidate",
      "          PIKIIO_HOST_CREDENTIAL_CANARY: must-not-enter-candidate\n          PIKIIO_OIDC_REQUEST_TOKEN: exfiltration-canary",
    );
    expectCode(
      () =>
        validateAuthorityWorkflowForMacosLineage(
          Buffer.from(candidateCredentialWorkflow),
        ),
      "MACOS_LINEAGE_WORKFLOW_INVALID",
    );
    const candidateCredentialMutant = compileMutant(
      EXTERNAL_PROOF_PATH,
      "/(?:ACTIONS_ID_TOKEN|PIKIIO_OIDC_REQUEST)/.test(candidateSection) ||",
      "false ||",
    );
    assert.doesNotThrow(() =>
      candidateCredentialMutant.validateAuthorityWorkflowForMacosLineage(
        Buffer.from(candidateCredentialWorkflow),
      ),
    );
    killed += 1;

    const wrongRunnerBody = clone(fixture.macosIdentityBody);
    wrongRunnerBody.runner.runsOn = "ubuntu-24.04";
    expectCode(
      () => validateMacosIdentityBody(wrongRunnerBody),
      "MACOS_IDENTITY_RUNNER_INVALID",
    );
    const runnerMutant = compileMutant(
      EXTERNAL_PROOF_PATH,
      'body.runner.runsOn !== "macos-14" ||',
      "false ||",
    );
    assert.doesNotThrow(() =>
      runnerMutant.validateMacosIdentityBody(wrongRunnerBody),
    );
    killed += 1;

    const reused = signMacosIdentityEvidence({
      body: fixture.macosIdentityBody,
      materialization: fixture.materialization,
      semanticStderrBase64:
        fixture.macosIdentityEvidence.semanticStderrBase64,
      jti: OIDC_JTI,
    });
    expectCode(
      () =>
        verifyMacosJobIdentity({
          identityEvidence: reused,
          materialization: fixture.materialization,
          finalCollectorReceipt: fixture.certification.collectorReceipt,
          jwksRegistry: fixture.jwksRegistry,
          nowMs: fixture.nowMs,
        }),
      "MACOS_IDENTITY_NOT_INDEPENDENT",
    );
    const replayMutant = compileMutant(
      EXTERNAL_PROOF_PATH,
      "macTokenIdentity.jti === finalTokenIdentity.jti ||",
      "false ||",
    );
    assert.doesNotThrow(() =>
      replayMutant.verifyMacosJobIdentity({
        identityEvidence: reused,
        materialization: fixture.materialization,
        finalCollectorReceipt: fixture.certification.collectorReceipt,
        jwksRegistry: fixture.jwksRegistry,
        nowMs: fixture.nowMs,
      }),
    );
    killed += 1;

    const forgedReceipt = clone(fixture.certification.collectorReceipt);
    const forgedSegments = forgedReceipt.oidcToken.split(".");
    forgedSegments[2] =
      `${forgedSegments[2][0] === "A" ? "B" : "A"}${forgedSegments[2].slice(1)}`;
    forgedReceipt.oidcToken = forgedSegments.join(".");
    const oidcArguments = {
      collectorReceipt: forgedReceipt,
      jwksRegistry: fixture.jwksRegistry,
      expectedAttestationBody: fixture.attestationBody,
      expectedAttestationBodySha256:
        fixture.certification.attestationBodySha256,
      expectedAuthorityCommit: fixture.materialization.authority.commit,
      expectedPhaseScopeBaseCommit:
        fixture.materialization.phase.scopeBaseCommit,
      expectedCandidateCommit: fixture.materialization.candidate.commit,
      expectedRun: fixture.materialization.run,
      expectedIssuer: fixture.certification.replay.issuer,
      expectedJti: fixture.certification.replay.jti,
      expectedReplayKeySha256:
        fixture.certification.replay.replayKeySha256,
      expectedJwksRegistrySha256:
        fixture.materialization.authority.jwksRegistrySha256,
      nowMs: fixture.nowMs,
    };
    const originalOidc = require("../lib/pikiio-github-oidc-collector-v3");
    assert.throws(() =>
      originalOidc.verifyGithubOidcCollectorV3(oidcArguments),
    );
    const signatureMutant = compileMutant(
      OIDC_COLLECTOR_PATH,
      "if (!valid) {",
      "if (false && !valid) {",
    );
    assert.doesNotThrow(() =>
      signatureMutant.verifyGithubOidcCollectorV3(oidcArguments),
    );
    killed += 1;

    assert.throws(
      () =>
        childRunner.assertCredentialIsolation({
          PIKIIO_HOST_CREDENTIAL_CANARY: "secret",
        }),
      /forbidden credentials/,
    );
    const credentialMutant = compileMutant(
      CHILD_RUNNER_PATH,
      "if (present.length > 0) {",
      "if (present.length < 0) {",
    );
    assert.doesNotThrow(() =>
      credentialMutant.assertCredentialIsolation({
        PIKIIO_HOST_CREDENTIAL_CANARY: "secret",
      }),
    );
    killed += 1;

    assert.equal(killed, total);
    context.diagnostic(
      `critical mutation score ${killed}/${total} (100.00%)`,
    );
  });
});

describe("quality gauntlet receipts fail closed", () => {
  test("judge sandbox proves isolation and refuses every unsafe capability", () => {
    const { primaryJudge } = makeFixture();
    const mutations = [
      ["imageDigest", "node:latest", "INVALID_IMAGE_DIGEST"],
      ["uid", 0, "INVALID_INTEGER"],
      ["network", "bridge", "UNSAFE_SANDBOX"],
      ["capabilities", "ALL", "UNSAFE_SANDBOX"],
      ["readOnlyRoot", false, "UNSAFE_SANDBOX"],
      ["authorityMount", "read_write", "UNSAFE_SANDBOX"],
      ["candidateMount", "read_write", "UNSAFE_SANDBOX"],
      ["githubOutputPresent", true, "UNSAFE_SANDBOX"],
      ["freshState", false, "UNSAFE_SANDBOX"],
      ["credentialKeysPresent", ["GITHUB_TOKEN"], "CREDENTIAL_EXPOSURE"],
      ["workspaceAfterSha256", digest("changed"), "CANDIDATE_MUTATION"],
    ];
    for (const [field, value, code] of mutations) {
      const receipt = clone(primaryJudge);
      receipt.sandbox[field] = value;
      receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
      expectCode(() => validateJudgeReceipt(receipt), code);
    }
  });

  test("unit, per-file coverage, Gherkin, and mutation gates are exact", () => {
    const { primaryJudge } = makeFixture();
    const mutations = [
      ["unit", "repeats", 2, "UNIT_GAUNTLET_FAILED"],
      ["unit", "passed", 126, "UNIT_GAUNTLET_FAILED"],
      ["unit", "failed", 1, "UNIT_GAUNTLET_FAILED"],
      ["unit", "cancelled", 1, "UNIT_GAUNTLET_FAILED"],
      ["unit", "skipped", 1, "UNIT_GAUNTLET_FAILED"],
      ["unit", "todo", 1, "UNIT_GAUNTLET_FAILED"],
      ["unit", "tests", 64, "UNIT_GAUNTLET_FAILED"],
      ["coverage", "lines", 94.99, "COVERAGE_GAUNTLET_FAILED"],
      ["coverage", "branches", 89.99, "COVERAGE_GAUNTLET_FAILED"],
      ["coverage", "functions", 94.99, "COVERAGE_GAUNTLET_FAILED"],
      ["coverage", "lines", Number.POSITIVE_INFINITY, "COVERAGE_GAUNTLET_FAILED"],
      ["gherkin", "passed", 30, "GHERKIN_GAUNTLET_FAILED"],
      ["gherkin", "failed", 1, "GHERKIN_GAUNTLET_FAILED"],
      ["gherkin", "skipped", 1, "GHERKIN_GAUNTLET_FAILED"],
      ["gherkin", "undefined", 1, "GHERKIN_GAUNTLET_FAILED"],
      ["gherkin", "ambiguous", 1, "GHERKIN_GAUNTLET_FAILED"],
      ["gherkin", "pending", 1, "GHERKIN_GAUNTLET_FAILED"],
      ["gherkin", "scenarios", 14, "GHERKIN_GAUNTLET_FAILED"],
      ["mutation", "score", 89.99, "MUTATION_GAUNTLET_FAILED"],
      ["mutation", "score", 95.57, "MUTATION_GAUNTLET_FAILED"],
      ["mutation", "total", 19, "MUTATION_GAUNTLET_FAILED"],
      ["mutation", "criticalTotal", 19, "MUTATION_GAUNTLET_FAILED"],
      ["mutation", "survived", 6, "MUTATION_GAUNTLET_FAILED"],
      ["mutation", "criticalKilled", 46, "MUTATION_GAUNTLET_FAILED"],
      ["mutation", "survivedCritical", 1, "MUTATION_GAUNTLET_FAILED"],
      [
        "mutation",
        "classifierMetaTestsPassed",
        false,
        "MUTATION_GAUNTLET_FAILED",
      ],
    ];
    for (const [section, field, value, code] of mutations) {
      const receipt = clone(primaryJudge);
      receipt.metrics[section][field] = value;
      receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
      expectCode(() => validateJudgeReceipt(receipt), code);
    }
  });

  test("judge roles, outcomes, exact fields, CAS references, and self-hashes are sealed", () => {
    const { primaryJudge } = makeFixture();
    const cases = [
      [{ ...primaryJudge, schema: "v2" }, "INVALID_SCHEMA"],
      [{ ...primaryJudge, role: "advisory" }, "INVALID_JUDGE_ROLE"],
      [{ ...primaryJudge, outcome: "warn" }, "JUDGE_FAILED"],
      [{ ...primaryJudge, receiptHash: digest("tampered") }, "HASH_MISMATCH"],
      [{ ...primaryJudge, callerBody: {} }, "UNEXPECTED_FIELDS"],
    ];
    for (const [value, code] of cases) {
      expectCode(() => validateJudgeReceipt(value), code);
    }
    expectCode(
      () => validateJudgeReceipt(primaryJudge, "independent"),
      "INVALID_JUDGE_ROLE",
    );
    for (const [field, value, code] of [
      ["address", "artifact-name", "INVALID_CAS_ADDRESS"],
      ["sha256", "bad", "INVALID_SHA256"],
      ["byteLength", 0, "INVALID_INTEGER"],
    ]) {
      const receipt = clone(primaryJudge);
      receipt.evidence.gherkin[field] = value;
      receipt.receiptHash = hashWithoutField(receipt, "receiptHash");
      expectCode(() => validateJudgeReceipt(receipt), code);
    }
  });

  test("judge disagreement and verdict receipt substitution are rejected", () => {
    const fixture = makeFixture();
    const divergent = clone(fixture.independentJudge);
    divergent.metrics.unit.tests = 128;
    divergent.metrics.unit.passed = 128;
    divergent.receiptHash = hashWithoutField(divergent, "receiptHash");
    expectCode(
      () =>
        buildExternalCiAttestationBody({
          materialization: fixture.materialization,
          macosLineage: fixture.macosLineage,
          macosJudge: fixture.macosJudge,
          primaryJudge: fixture.primaryJudge,
          independentJudge: divergent,
          verdict: fixture.verdict,
        }),
      "JUDGE_DIVERGENCE",
    );
    const differentImage = clone(fixture.independentJudge);
    differentImage.sandbox.imageDigest = `sha256:${digest("other-image")}`;
    differentImage.receiptHash = hashWithoutField(
      differentImage,
      "receiptHash",
    );
    expectCode(
      () =>
        buildExternalCiAttestationBody({
          materialization: fixture.materialization,
          macosLineage: fixture.macosLineage,
          macosJudge: fixture.macosJudge,
          primaryJudge: fixture.primaryJudge,
          independentJudge: differentImage,
          verdict: fixture.verdict,
        }),
      "RECEIPT_BINDING_MISMATCH",
    );
    for (const [field, value] of [
      ["materializationReceiptHash", digest("wrong")],
      ["evidenceManifestSha256", digest("wrong")],
    ]) {
      const verdict = clone(fixture.verdict);
      verdict[field] = value;
      verdict.receiptHash = hashWithoutField(verdict, "receiptHash");
      expectCode(
        () =>
          buildExternalCiAttestationBody({
            materialization: fixture.materialization,
            macosLineage: fixture.macosLineage,
            macosJudge: fixture.macosJudge,
            primaryJudge: fixture.primaryJudge,
            independentJudge: fixture.independentJudge,
            verdict,
          }),
        "VERDICT_BINDING_MISMATCH",
      );
    }
    const verdict = clone(fixture.verdict);
    verdict.judgeReceiptHashes.primary = digest("wrong");
    verdict.receiptHash = hashWithoutField(verdict, "receiptHash");
    expectCode(
      () =>
        buildExternalCiAttestationBody({
          materialization: fixture.materialization,
          macosLineage: fixture.macosLineage,
          macosJudge: fixture.macosJudge,
          primaryJudge: fixture.primaryJudge,
          independentJudge: fixture.independentJudge,
          verdict,
        }),
      "VERDICT_BINDING_MISMATCH",
    );
  });

  test("CAS manifests deduplicate identical bytes but reject conflicting metadata", () => {
    const fixture = makeFixture();
    const independent = clone(fixture.independentJudge);
    independent.evidence.unitCoverage = clone(
      fixture.primaryJudge.evidence.unitCoverage,
    );
    independent.receiptHash = hashWithoutField(independent, "receiptHash");
    const deduplicated = evidenceReferences(
      fixture.primaryJudge,
      independent,
      fixture.macosJudge,
    );
    assert.equal(deduplicated.length, 12);
    assert.equal(
      new Set(deduplicated.map((reference) => reference.address)).size,
      deduplicated.length,
    );

    independent.evidence.unitCoverage.byteLength += 1;
    independent.receiptHash = hashWithoutField(independent, "receiptHash");
    expectCode(
      () =>
        evidenceReferences(
          fixture.primaryJudge,
          independent,
          fixture.macosJudge,
        ),
      "CAS_REFERENCE_COLLISION",
    );
  });
});

describe("raw gauntlet evidence is independently reconstructed", () => {
  test("self-reported metrics cannot diverge from canonical raw outputs", () => {
    const fixture = makeFixture();
    const primary = clone(fixture.primaryJudge);
    primary.metrics.gherkin.scenarios += 1;
    expectCode(
      () =>
        reconcileRawEvidence({
          materialization: fixture.materialization,
          macos: fixture.macosJudge,
          primary,
          independent: fixture.independentJudge,
          artifacts: fixture.artifacts,
        }),
      "RAW_METRICS_MISMATCH",
    );
  });

  test("a missing execution fails even when counts, indexes, and digests are forged together", () => {
    const fixture = makeFixture();
    const artifacts = new Map(fixture.artifacts);
    const primary = clone(fixture.primaryJudge);
    const layers = JSON.parse(
      artifacts.get(primary.evidence.layers.address).toString("utf8"),
    );
    layers.pop();
    primary.evidence.layers = addArtifact(artifacts, stableJson(layers));
    primary.evidence.stdout = addArtifact(
      artifacts,
      stableJson(layers.map((entry) => entry.stdoutBase64)),
    );
    primary.evidence.stderr = addArtifact(
      artifacts,
      stableJson(layers.map((entry) => entry.stderrBase64)),
    );
    primary.executionReceiptsSha256 = sha256(stableJson(layers));
    primary.executedCommandCount = layers.length;
    expectCode(
      () =>
        reconcileRawEvidence({
          materialization: fixture.materialization,
          macos: fixture.macosJudge,
          primary,
          independent: fixture.independentJudge,
          artifacts,
        }),
      "EXECUTION_COUNT_MISMATCH",
    );
  });

  test("one hash-valid but malformed raw byte fails before signed metrics are trusted", () => {
    const fixture = makeFixture();
    const artifacts = new Map(fixture.artifacts);
    const primary = clone(fixture.primaryJudge);
    const bytes = Buffer.from(
      artifacts.get(primary.evidence.layers.address),
    );
    bytes[0] = "!".charCodeAt(0);
    primary.evidence.layers = addArtifact(artifacts, bytes);
    expectCode(
      () =>
        reconcileRawEvidence({
          materialization: fixture.materialization,
          macos: fixture.macosJudge,
          primary,
          independent: fixture.independentJudge,
          artifacts,
        }),
      "RAW_EVIDENCE_INVALID",
    );
  });

  test("aggregate coverage cannot conceal one required file below 95/90/95", () => {
    const fixture = makeFixture();
    const artifacts = new Map(fixture.artifacts);
    const macos = clone(fixture.macosJudge);
    const primary = clone(fixture.primaryJudge);
    const independent = clone(fixture.independentJudge);
    const executions = JSON.parse(
      artifacts.get(macos.evidence.unitCoverage.address).toString("utf8"),
    );
    const weakenedTap = unitTap().replace(
      "# lib/pikiio-external-ci-proof.js | 98.4 | 94.1 | 99.2",
      "# lib/pikiio-external-ci-proof.js | 94.9 | 94.1 | 99.2",
    );
    for (const execution of executions) {
      const bytes = Buffer.from(weakenedTap, "utf8");
      execution.stdoutSha256 = sha256(bytes);
      execution.stdoutByteLength = bytes.length;
      execution.stdoutBase64 = bytes.toString("base64");
    }
    macos.evidence.unitCoverage = addArtifact(
      artifacts,
      stableJson(executions),
    );
    macos.evidence.stdout = addArtifact(
      artifacts,
      stableJson(executions.map((entry) => entry.stdoutBase64)),
    );
    macos.executionReceiptsSha256 = sha256(stableJson(executions));
    primary.evidence.unitCoverage = clone(macos.evidence.unitCoverage);
    independent.evidence.unitCoverage = clone(macos.evidence.unitCoverage);
    rebindMacosIdentityEvidence({
      materialization: fixture.materialization,
      macos,
      artifacts,
    });
    expectCode(
      () =>
        reconcileRawEvidence({
          materialization: fixture.materialization,
          macos,
          primary,
          independent,
          artifacts,
        }),
      "COVERAGE_GAUNTLET_FAILED",
    );
  });

  test("raw receipt digests, stream indexes, child status, subsets, and mac reuse all reconcile exactly", () => {
    const cases = [
      [
        ({ macos }) => {
          macos.executionReceiptsSha256 = digest("wrong-mac-executions");
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ macos, artifacts }) => {
          macos.evidence.stdout = addArtifact(artifacts, "[]");
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ macos }) => {
          macos.metrics.unit.tests += 1;
        },
        "RAW_METRICS_MISMATCH",
      ],
      [
        ({ macos, primary }) => {
          primary.evidence.unitCoverage = clone(macos.evidence.stderr);
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ primary }) => {
          primary.executionReceiptsSha256 = digest("wrong-linux-executions");
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ primary, artifacts }) => {
          primary.evidence.stderr = addArtifact(artifacts, "[]");
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ primary, artifacts }) => {
          primary.evidence.gherkin = addArtifact(artifacts, "[]");
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ primary, artifacts }) => {
          primary.evidence.macosUnit = addArtifact(
            artifacts,
            stableJson({ forged: true }),
          );
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
      [
        ({ primary }) => {
          primary.metrics.mutation.total += 1;
        },
        "RAW_METRICS_MISMATCH",
      ],
      [
        ({ primary, artifacts }) => {
          const executions = JSON.parse(
            artifacts.get(primary.evidence.layers.address).toString("utf8"),
          );
          executions[0].status = 1;
          primary.evidence.layers = addArtifact(
            artifacts,
            stableJson(executions),
          );
        },
        "EXECUTION_RECEIPT_MISMATCH",
      ],
      [
        ({ macos, artifacts }) => {
          const executions = JSON.parse(
            artifacts.get(macos.evidence.unitCoverage.address).toString("utf8"),
          );
          executions[0].stdoutBase64 = "*";
          macos.evidence.unitCoverage = addArtifact(
            artifacts,
            stableJson(executions),
          );
        },
        "RAW_EVIDENCE_INVALID",
      ],
      [
        ({ macos, artifacts }) => {
          const executions = JSON.parse(
            artifacts.get(macos.evidence.unitCoverage.address).toString("utf8"),
          );
          executions[0].stdoutByteLength += 1;
          macos.evidence.unitCoverage = addArtifact(
            artifacts,
            stableJson(executions),
          );
        },
        "RAW_EVIDENCE_MISMATCH",
      ],
    ];
    for (const [mutate, code] of cases) {
      const fixture = makeFixture();
      const state = {
        materialization: fixture.materialization,
        macos: clone(fixture.macosJudge),
        primary: clone(fixture.primaryJudge),
        independent: clone(fixture.independentJudge),
        artifacts: new Map(fixture.artifacts),
      };
      mutate(state);
      expectCode(() => reconcileRawEvidence(state), code);
    }
  });

  test("raw Gherkin and mutation JSON must pass and remain deterministic", () => {
    const cases = [
      ["gherkin", { ...gherkinRaw(), ok: false }, "GHERKIN_GAUNTLET_FAILED"],
      [
        "mutation",
        { ...mutationRaw(), metaTests: [] },
        "MUTATION_GAUNTLET_FAILED",
      ],
      [
        "gherkin",
        { ...gherkinRaw(), scenarios: 30, passed: 30 },
        "DETERMINISM_FAILED",
      ],
    ];
    for (const [group, raw, code] of cases) {
      const fixture = makeFixture();
      const artifacts = new Map(fixture.artifacts);
      const primary = clone(fixture.primaryJudge);
      const executions = JSON.parse(
        artifacts.get(primary.evidence.layers.address).toString("utf8"),
      );
      const commands = fixture.materialization.phase.commandPlan.commands.filter(
        (command) => command.platform === "linux",
      );
      const index = commands.findIndex((command) => command.group === group);
      const bytes = Buffer.from(`${stableJson(raw)}\n`, "utf8");
      executions[index].stdoutBase64 = bytes.toString("base64");
      executions[index].stdoutByteLength = bytes.length;
      executions[index].stdoutSha256 = sha256(bytes);
      primary.evidence.layers = addArtifact(artifacts, stableJson(executions));
      primary.evidence.stdout = addArtifact(
        artifacts,
        stableJson(executions.map((entry) => entry.stdoutBase64)),
      );
      primary.executionReceiptsSha256 = sha256(stableJson(executions));
      expectCode(
        () =>
          reconcileRawEvidence({
            materialization: fixture.materialization,
            macos: fixture.macosJudge,
            primary,
            independent: fixture.independentJudge,
            artifacts,
          }),
        code,
      );
    }
  });
});

describe("judge child protocol and immutable provenance", () => {
  function childCommand(overrides = {}) {
    const command = {
      name: "unit-repeat-1",
      group: "unit",
      platform: "macos",
      repeat: 1,
      executable: "node",
      args: ["-e", "process.stdout.write('child-ok')"],
      definitionSha256: "0".repeat(64),
      ...overrides,
    };
    command.definitionSha256 = commandDefinitionSha256(command);
    return command;
  }

  function encodeCommand(command) {
    return Buffer.from(stableJson(command)).toString("base64url");
  }

  function expectChildCode(fn, code) {
    assert.throws(fn, (error) => {
      assert.equal(error.code, code);
      return true;
    });
  }

  test("child envelope is exact, field-bound, platform-bound, and control-safe", () => {
    const command = childCommand();
    assert.deepEqual(
      childRunner.parseCommand(encodeCommand(command)),
      command,
    );
    assert.equal(
      childRunner.executableFor(command, "macos"),
      process.execPath,
    );
    assert.equal(
      childRunner.executableFor(
        childCommand({
          name: "syntax-repeat-1",
          group: "syntax",
          platform: "linux",
          executable: "node",
          args: ["-c", "lib/example.js"],
        }),
        "linux",
      ),
      "/usr/local/bin/node",
    );
    expectChildCode(
      () => childRunner.parseCommand("not*base64url"),
      "INVALID_COMMAND_ENVELOPE",
    );
    for (const mutate of [
      (value) => {
        value.extra = true;
      },
      (value) => {
        value.executable = "bash";
      },
      (value) => {
        value.repeat = 4;
      },
      (value) => {
        value.args = ["unsafe\nargument"];
      },
      (value) => {
        value.platform = "linux";
      },
      (value) => {
        value.definitionSha256 = digest("forged");
      },
    ]) {
      const changed = clone(command);
      mutate(changed);
      expectChildCode(
        () => childRunner.parseCommand(encodeCommand(changed)),
        changed.definitionSha256 === digest("forged")
          ? "COMMAND_DEFINITION_MISMATCH"
          : "INVALID_COMMAND",
      );
    }
    expectChildCode(
      () => childRunner.executableFor(command, "linux"),
      "PLATFORM_MISMATCH",
    );
    const macosNpm = childCommand({ executable: "npm" });
    expectChildCode(
      () => childRunner.executableFor(macosNpm, "macos"),
      "EXECUTABLE_FORBIDDEN",
    );
    assert.equal(
      childRunner.executableFor(
        childCommand({
          name: "neighbor-repeat-1",
          group: "neighbor",
          platform: "linux",
          executable: "git",
          args: ["diff", "--check"],
        }),
        "linux",
      ),
      "/usr/bin/git",
    );
    assert.equal(
      childRunner.executableFor(
        childCommand({
          name: "broad-repeat-1",
          group: "broad",
          platform: "linux",
          executable: "npm",
          args: ["--ignore-scripts", "test"],
        }),
        "linux",
      ),
      "/usr/local/bin/npm",
    );
  });

  test("candidate and preloaded product children dynamically reject OIDC and credential canaries", () => {
    assert.equal(childRunner.assertCredentialIsolation({}), true);
    for (const key of childRunner.FORBIDDEN_CREDENTIAL_KEYS) {
      expectChildCode(
        () => childRunner.assertCredentialIsolation({ [key]: "canary" }),
        "CREDENTIAL_ISOLATION_FAILED",
      );
    }
    expectChildCode(
      () => childRunner.assertCredentialIsolation(null),
      "CREDENTIAL_ENV_INVALID",
    );
    const result = spawnSync(process.execPath, [CHILD_RUNNER_PATH], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PIKIIO_HOST_CREDENTIAL_CANARY: "must-not-enter-candidate",
      },
    });
    assert.equal(result.status, 98);
    assert.match(result.stderr, /CREDENTIAL_ISOLATION_FAILED/);
    assert.doesNotMatch(result.stdout, /must-not-enter-candidate/);
  });

  test("phase environments are exact and survive explicit-env product child isolation", () => {
    assert.deepEqual(childRunner.phaseEnvironment("ACTION-01", 2), {
      TZ: "America/New_York",
      PIKIIO_TEST_SEED: "20260724",
      PIKIIO_QUALITY_INVARIANT_JUDGE: "1",
      PIKIIO_QUALITY_NETWORK_MODE: "deny",
      PIKIIO_PHASE_PROOF_PROFILE: "ACTION-01",
      PIKIIO_ACTION_PHASE_ACCEPTANCE: "ACTION-01",
    });
    assert.deepEqual(childRunner.phaseEnvironment("TRUTH-01", 3), {
      TZ: "Pacific/Honolulu",
      PIKIIO_TEST_SEED: "8675309",
      PIKIIO_QUALITY_INVARIANT_JUDGE: "1",
      PIKIIO_QUALITY_NETWORK_MODE: "deny",
      PIKIIO_PHASE_PROOF_PROFILE: "TRUTH-01",
      PIKIIO_TRUTH_PHASE_ACCEPTANCE: "TRUTH-01",
    });
    assert.deepEqual(childRunner.phaseEnvironment("GOV-00", 1), {
      TZ: "UTC",
      PIKIIO_TEST_SEED: "11441155601",
      PIKIIO_QUALITY_INVARIANT_JUDGE: "1",
      PIKIIO_QUALITY_NETWORK_MODE: "deny",
      PIKIIO_PHASE_PROOF_PROFILE: "GOV-00",
    });
    expectChildCode(
      () => childRunner.phaseEnvironment("ACTION-XX", 1),
      "PHASE_INVALID",
    );
    expectChildCode(
      () => childRunner.phaseEnvironment("ACTION-01", 4),
      "REPEAT_INVALID",
    );

    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-child-bridge-"),
    );
    try {
      const nestedScript = [
        "const {spawnSync}=require('node:child_process');",
        "const child=spawnSync(process.execPath,['-e',",
        JSON.stringify(
          "process.stdout.write(JSON.stringify({phase:process.env.PIKIIO_ACTION_PHASE_ACCEPTANCE,profile:process.env.PIKIIO_PHASE_PROOF_PROFILE,coverage:process.env.NODE_V8_COVERAGE,tmp:process.env.TMPDIR}))",
        ),
        "],{encoding:'utf8',env:{PATH:process.env.PATH}});",
        "if(child.status!==0)process.exit(7);",
        "process.stdout.write(child.stdout);",
      ].join("");
      const bridged = spawnSync(
        process.execPath,
        ["--require", CHILD_RUNNER_PATH, "-e", nestedScript],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            PIKIIO_EXTERNAL_CI_PRELOAD: "1",
            PIKIIO_ACTION_PHASE_ACCEPTANCE: "ACTION-01",
            PIKIIO_PHASE_PROOF_PROFILE: "ACTION-01",
            NODE_V8_COVERAGE: temporary,
            TMPDIR: temporary,
          },
        },
      );
      assert.equal(bridged.status, 0, bridged.stderr);
      assert.deepEqual(JSON.parse(bridged.stdout), {
        phase: "ACTION-01",
        profile: "ACTION-01",
        coverage: temporary,
        tmp: temporary,
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("path, sandbox, and spawn bridge refusal branches fail closed", () => {
    for (const value of [
      null,
      "relative",
      "/tmp/../escape",
      "/tmp/unsafe\u0000path",
      "/tmp/back\\slash",
    ]) {
      expectChildCode(
        () =>
          childRunner.requireAbsolutePath(
            value,
            "TEST_PATH_INVALID",
            "test path",
          ),
        "TEST_PATH_INVALID",
      );
    }
    const missing = path.join(
      os.tmpdir(),
      `pikiio-missing-${crypto.randomUUID()}`,
    );
    expectChildCode(
      () =>
        childRunner.macosSandboxProfile({
          workspace: missing,
          dependencyRoot: missing,
          authorityRoot: missing,
          scratch: missing,
          nodeRuntimeRoot: missing,
        }),
      "SANDBOX_PATH_INVALID",
    );

    assert.equal(childRunner.installSpawnSyncEnvironmentBridge(), true);
    assert.equal(childRunner.installSpawnSyncEnvironmentBridge(), false);
    const bridgedSpawnSync = require("node:child_process").spawnSync;
    const twoArgument = bridgedSpawnSync(process.execPath, {
      encoding: "utf8",
      input: "",
      env: { PATH: process.env.PATH },
    });
    assert.equal(twoArgument.status, 0, twoArgument.stderr);
    const noEnvironment = bridgedSpawnSync(
      process.execPath,
      ["-e", ""],
      { encoding: "utf8" },
    );
    assert.equal(noEnvironment.status, 0, noEnvironment.stderr);
    const noOptions = bridgedSpawnSync("/usr/bin/true");
    assert.equal(noOptions.status, 0);
  });

  test("coverage bridge counts a product module executed only in an explicit-env child", {
    timeout: 30_000,
  }, () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-child-coverage-"),
    );
    try {
      const productPath = path.join(temporary, "product.js");
      const testPath = path.join(temporary, "bridge.test.js");
      fs.writeFileSync(
        productPath,
        [
          '"use strict";',
          "function evaluate() {",
          '  return "covered";',
          "}",
          "module.exports = { evaluate };",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        testPath,
        [
          '"use strict";',
          'const assert = require("node:assert/strict");',
          'const test = require("node:test");',
          'const { spawnSync } = require("node:child_process");',
          'test("product child", () => {',
          "  const child = spawnSync(process.execPath, [",
          '    "-e",',
          `    ${JSON.stringify(
            `const product=require(${JSON.stringify(productPath)});process.stdout.write(JSON.stringify({value:product.evaluate(),phase:process.env.PIKIIO_ACTION_PHASE_ACCEPTANCE}))`,
          )},`,
          "  ], { encoding: \"utf8\", env: { PATH: process.env.PATH } });",
          "  assert.equal(child.status, 0, child.stderr);",
          '  assert.deepEqual(JSON.parse(child.stdout), { value: "covered", phase: "ACTION-01" });',
          "});",
          "",
        ].join("\n"),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          CHILD_RUNNER_PATH,
          "--test",
          "--test-reporter=tap",
          "--experimental-test-coverage",
          "--test-coverage-include=product.js",
          "--test-coverage-lines=95",
          "--test-coverage-branches=90",
          "--test-coverage-functions=95",
          testPath,
        ],
        {
          cwd: temporary,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            HOME: temporary,
            TMPDIR: temporary,
            PIKIIO_EXTERNAL_CI_PRELOAD: "1",
            PIKIIO_ACTION_PHASE_ACCEPTANCE: "ACTION-01",
            PIKIIO_PHASE_PROOF_PROFILE: "ACTION-01",
          },
        },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /product\.js\s+\|\s+100\.00\s+\|\s+100\.00\s+\|\s+100\.00/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("macOS sandbox permits only fresh scratch writes and denies source, authority, sibling, and network mutation", {
    skip: process.platform !== "darwin",
    timeout: 20_000,
  }, () => {
    const rawRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-macos-sandbox-"),
    );
    const root = fs.realpathSync(rawRoot);
    try {
      for (const relativePath of [
        "workspace",
        "dependencies",
        "authority",
        "scratch",
        "sibling",
      ]) {
        fs.mkdirSync(path.join(root, relativePath));
      }
      for (const relativePath of [
        "workspace/source.txt",
        "dependencies/module.txt",
        "authority/runner.txt",
        "sibling/secret.txt",
      ]) {
        fs.writeFileSync(path.join(root, relativePath), "sealed\n");
      }
      const nodeBinary = fs.realpathSync(process.execPath);
      const profile = childRunner.macosSandboxProfile({
        workspace: path.join(root, "workspace"),
        dependencyRoot: path.join(root, "dependencies"),
        authorityRoot: path.join(root, "authority"),
        scratch: path.join(root, "scratch"),
        nodeRuntimeRoot: path.dirname(path.dirname(nodeBinary)),
      });
      const profilePath = path.join(root, "profile.sb");
      fs.writeFileSync(profilePath, profile);
      assert.match(profile, /\(deny network\*\)/);
      assert.match(profile, /\(deny process-info\*\)/);
      assert.doesNotMatch(profile, new RegExp(path.join(root, "sibling")));
      const probe = `
        const fs = require("node:fs");
        const net = require("node:net");
        const { spawnSync } = require("node:child_process");
        const result = {};
        result.credentialEnvAbsent =
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL === undefined &&
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined &&
          process.env.PIKIIO_HOST_CREDENTIAL_CANARY === undefined;
        const parentProbe = spawnSync("/bin/ps", ["eww", "-p", String(process.ppid)], { encoding: "utf8" });
        result.parentCredential =
          String(parentProbe.stdout || "").includes("must-not-enter-candidate")
            ? "leaked"
            : parentProbe.status === 0 ? "hidden" : "denied";
        for (const [key, target] of Object.entries(${JSON.stringify({
          scratch: path.join(root, "scratch", "write.txt"),
          workspace: path.join(root, "workspace", "write.txt"),
          dependency: path.join(root, "dependencies", "write.txt"),
          authority: path.join(root, "authority", "write.txt"),
          siblingWrite: path.join(root, "sibling", "write.txt"),
        })})) {
          try { fs.writeFileSync(target, "candidate"); result[key] = "written"; }
          catch (error) { result[key] = error.code; }
        }
        try {
          fs.readFileSync(${JSON.stringify(path.join(root, "sibling", "secret.txt"))});
          result.sibling = "read";
        } catch (error) { result.sibling = error.code; }
        try {
          const link = ${JSON.stringify(path.join(root, "scratch", "escape-link"))};
          fs.symlinkSync(${JSON.stringify(path.join(root, "sibling"))}, link);
          fs.writeFileSync(link + "/escaped.txt", "candidate");
          result.symlinkEscape = "written";
        } catch (error) { result.symlinkEscape = error.code; }
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          process.stdout.write(JSON.stringify(result));
        };
        const socket = net.connect({ host: "1.1.1.1", port: 53 });
        socket.once("connect", () => { result.network = "connected"; socket.destroy(); finish(); });
        socket.once("error", (error) => { result.network = error.code; finish(); });
        setTimeout(() => { result.network = "timeout"; socket.destroy(); finish(); }, 2000);
      `;
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-f",
          profilePath,
          "/usr/bin/env",
          "-i",
          "CI=1",
          `HOME=${path.join(root, "scratch")}`,
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          `PATH=${path.dirname(nodeBinary)}:/usr/bin:/bin`,
          `TMPDIR=${path.join(root, "scratch")}`,
          nodeBinary,
          "-e",
          probe,
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/canary",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-enter-candidate",
            PIKIIO_HOST_CREDENTIAL_CANARY: "must-not-enter-candidate",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const assessment = JSON.parse(result.stdout);
      assert.equal(assessment.credentialEnvAbsent, true);
      assert.equal(assessment.parentCredential, "denied");
      assert.equal(assessment.scratch, "written");
      for (const key of [
        "workspace",
        "dependency",
        "authority",
        "siblingWrite",
        "sibling",
        "symlinkEscape",
        "network",
      ]) {
        assert.ok(
          ["EPERM", "EACCES"].includes(assessment[key]),
          `${key}: ${assessment[key]}`,
        );
      }
    } finally {
      fs.rmSync(rawRoot, { recursive: true, force: true });
    }
  });

  test("every child envelope and execute boundary has a refusal receipt", () => {
    const valid = childCommand();
    for (const [encoded, code] of [
      [undefined, "INVALID_COMMAND_ENVELOPE"],
      ["", "INVALID_COMMAND_ENVELOPE"],
      ["A", "INVALID_COMMAND_ENVELOPE"],
      [
        Buffer.from("{", "utf8").toString("base64url"),
        "INVALID_COMMAND_ENVELOPE",
      ],
      [
        Buffer.alloc(childRunner.MAX_COMMAND_BYTES + 1, 0x20).toString(
          "base64url",
        ),
        "INVALID_COMMAND_ENVELOPE",
      ],
      [
        Buffer.from("null", "utf8").toString("base64url"),
        "INVALID_COMMAND",
      ],
      [
        Buffer.from("[]", "utf8").toString("base64url"),
        "INVALID_COMMAND",
      ],
    ]) {
      expectChildCode(() => childRunner.parseCommand(encoded), code);
    }
    const fieldMutations = [
      (value) => {
        value.name = "";
      },
      (value) => {
        value.name = "x".repeat(257);
      },
      (value) => {
        value.group = "shell";
      },
      (value) => {
        value.platform = "windows";
      },
      (value) => {
        value.repeat = 1.5;
      },
      (value) => {
        value.repeat = 0;
      },
      (value) => {
        value.executable = "sh";
      },
      (value) => {
        value.args = "not-an-array";
      },
      (value) => {
        value.args = Array.from({ length: 129 }, () => "x");
      },
      (value) => {
        value.definitionSha256 = null;
      },
      (value) => {
        value.args = [7];
      },
      (value) => {
        value.args = ["x".repeat(2049)];
      },
      (value) => {
        value.args = ["unsafe\u0000argument"];
      },
    ];
    for (const mutate of fieldMutations) {
      const changed = clone(valid);
      mutate(changed);
      expectChildCode(
        () => childRunner.parseCommand(encodeCommand(changed)),
        "INVALID_COMMAND",
      );
    }
    const syntaxRepeat = childCommand({
      name: "syntax-repeat-2",
      group: "syntax",
      platform: "linux",
      repeat: 2,
      args: ["-c", "lib/example.js"],
    });
    expectChildCode(
      () => childRunner.parseCommand(encodeCommand(syntaxRepeat)),
      "INVALID_COMMAND",
    );

    const savedArgv = [...process.argv];
    const priorProtocol = process.env.PIKIIO_CHILD_PROTOCOL;
    const priorNodePath = process.env.PIKIIO_MACOS_NODE_PATH;
    const priorScratch = process.env.PIKIIO_MACOS_SCRATCH_PATH;
    try {
      process.argv.splice(2);
      process.env.PIKIIO_CHILD_PROTOCOL = childRunner.PROTOCOL;
      process.env.PIKIIO_MACOS_NODE_PATH = "/tmp/node_modules";
      process.env.PIKIIO_MACOS_SCRATCH_PATH = "/tmp";
      process.argv.push("forbidden");
      expectChildCode(
        () =>
          childRunner.execute({
            encodedCommand: encodeCommand(valid),
            platform: "macos",
            workdir: "/tmp",
          }),
        "ARGUMENTS_FORBIDDEN",
      );
      process.argv.pop();
      process.env.PIKIIO_CHILD_PROTOCOL = "v2";
      expectChildCode(
        () =>
          childRunner.execute({
            encodedCommand: encodeCommand(valid),
            platform: "macos",
            workdir: "/tmp",
          }),
        "PROTOCOL_MISMATCH",
      );
      process.env.PIKIIO_CHILD_PROTOCOL = childRunner.PROTOCOL;
      expectChildCode(
        () =>
          childRunner.execute({
            encodedCommand: encodeCommand(valid),
            platform: "windows",
            workdir: "/tmp",
          }),
        "PLATFORM_MISMATCH",
      );
      expectChildCode(
        () =>
          childRunner.execute({
            encodedCommand: encodeCommand(valid),
            platform: "macos",
            workdir: "relative",
          }),
        "INVALID_WORKDIR",
      );
      process.env.PIKIIO_MACOS_NODE_PATH = "../candidate/node_modules";
      expectChildCode(
        () =>
          childRunner.execute({
            encodedCommand: encodeCommand(valid),
            platform: "macos",
            workdir: "/tmp",
          }),
        "DEPENDENCY_PATH_INVALID",
      );
    } finally {
      process.argv.splice(0, process.argv.length, ...savedArgv);
      if (priorProtocol === undefined) {
        delete process.env.PIKIIO_CHILD_PROTOCOL;
      } else {
        process.env.PIKIIO_CHILD_PROTOCOL = priorProtocol;
      }
      if (priorNodePath === undefined) {
        delete process.env.PIKIIO_MACOS_NODE_PATH;
      } else {
        process.env.PIKIIO_MACOS_NODE_PATH = priorNodePath;
      }
      if (priorScratch === undefined) {
        delete process.env.PIKIIO_MACOS_SCRATCH_PATH;
      } else {
        process.env.PIKIIO_MACOS_SCRATCH_PATH = priorScratch;
      }
    }
  });

  test("child lifecycle emits bounded receipts, tolerates real progress, and kills genuine hangs", {
    timeout: 45_000,
  }, async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-child-test-"),
    );
    try {
      const run = (command, protocol = childRunner.PROTOCOL) =>
        runProcessLifecycle(process.execPath, [CHILD_RUNNER_PATH], {
          cwd: temporary,
          env: {
            PIKIIO_CHILD_PROTOCOL: protocol,
            PIKIIO_COMMAND_B64: encodeCommand(command),
            PIKIIO_PLATFORM: "macos",
            PIKIIO_PHASE_ID: "ACTION-01",
            PIKIIO_WORKDIR: temporary,
            PIKIIO_MACOS_NODE_PATH: path.join(temporary, "node_modules"),
            PIKIIO_MACOS_SCRATCH_PATH: temporary,
          },
        });
      const passed = await run(childCommand());
      assert.equal(passed.status, 0);
      assert.equal(passed.stderr, "");
      assert.equal(passed.events[0], "spawn");
      assert.ok(passed.events.includes("stdout"));
      assert.equal(passed.events.at(-1), "close");
      const receipt = JSON.parse(passed.stdout);
      assert.equal(receipt.protocol, childRunner.PROTOCOL);
      assert.equal(
        Buffer.from(receipt.stdoutBase64, "base64").toString("utf8"),
        "child-ok",
      );
      assert.equal(receipt.status, 0);
      assert.equal(receipt.timedOut, false);

      const failedCommand = childCommand({
        args: ["-e", "process.exit(7)"],
      });
      const failed = await run(failedCommand);
      assert.equal(failed.status, 97);
      assert.equal(JSON.parse(failed.stdout).status, 7);

      const refused = await run(childCommand(), "v2");
      assert.equal(refused.status, 98);
      assert.equal(JSON.parse(refused.stderr).error, "PROTOCOL_MISMATCH");

      const slow = await run(
        childCommand({
          args: [
            "-e",
            "setTimeout(() => process.stdout.write('slow-ok'), 5500)",
          ],
        }),
      );
      assert.equal(slow.status, 0);
      const slowReceipt = JSON.parse(slow.stdout);
      assert.equal(
        Buffer.from(slowReceipt.stdoutBase64, "base64").toString("utf8"),
        "slow-ok",
      );
      assert.ok(slowReceipt.elapsedMs >= 5_000);

      const hung = await runProcessLifecycle(
        process.execPath,
        [CHILD_RUNNER_PATH],
        {
          cwd: temporary,
          env: {
            PIKIIO_CHILD_PROTOCOL: childRunner.PROTOCOL,
            PIKIIO_COMMAND_B64: encodeCommand(
              childCommand({
                args: ["-e", "setInterval(() => {}, 1000)"],
              }),
            ),
            PIKIIO_PLATFORM: "macos",
            PIKIIO_PHASE_ID: "ACTION-01",
            PIKIIO_WORKDIR: temporary,
            PIKIIO_MACOS_NODE_PATH: path.join(temporary, "node_modules"),
            PIKIIO_MACOS_SCRATCH_PATH: temporary,
          },
        },
        { absoluteTimeoutMs: 2_000, idleTimeoutMs: 1_000 },
      );
      assert.equal(hung.timedOut, true);
      assert.equal(hung.timeoutReason, "idle-timeout");
      assert.equal(hung.signal, "SIGKILL");

      const stressRuns = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const [stressPass, stressFail, stressRefusal] = await Promise.all([
            run(childCommand()),
            run(failedCommand),
            run(childCommand(), "v2"),
          ]);
          return { stressPass, stressFail, stressRefusal };
        }),
      );
      for (const {
        stressPass,
        stressFail,
        stressRefusal,
      } of stressRuns) {
        assert.equal(stressPass.status, 0);
        assert.equal(stressFail.status, 97);
        assert.equal(stressRefusal.status, 98);
        assert.equal(stressPass.timedOut, false);
        assert.equal(stressFail.timedOut, false);
        assert.equal(stressRefusal.timedOut, false);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("toolchain is structurally pinned and currently hard-refuses as uncommissioned", () => {
    const provenance = JSON.parse(
      fs.readFileSync(TOOLCHAIN_PROVENANCE, "utf8"),
    );
    const dockerfile = fs.readFileSync(JUDGE_DOCKERFILE, "utf8");
    const workflow = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    assert.equal(
      provenance.schema,
      "pikiio-proof-v3-toolchain-provenance-v1",
    );
    assert.ok(["commissioned", "uncommissioned"].includes(provenance.status));
    if (provenance.status === "uncommissioned") {
      for (const key of [
        "judgeImageRef",
        "judgeImageDigest",
        "judgeImageSbomSha256",
        "judgeImageDependencyManifestSha256",
        "dockerfileSha256",
        "childRunnerSha256",
        "packageLockSha256",
        "commissioningReceiptSha256",
      ]) {
        assert.equal(provenance[key], null);
      }
      assert.ok(provenance.reason.length > 100);
    }
    assert.match(workflow, /provenance\.status !== "commissioned"/);
    assert.match(workflow, /TOOLCHAIN_UNCOMMISSIONED/);
    assert.doesNotMatch(workflow, /vars\.PIKIIO_JUDGE_IMAGE/);
    assert.match(dockerfile, /^ARG NODE_BASE_IMAGE$/m);
    assert.match(dockerfile, /^FROM \$\{NODE_BASE_IMAGE\}$/m);
    assert.doesNotMatch(dockerfile, /^FROM\s+\S+:(?:latest|[0-9])/m);
    assert.match(dockerfile, /npm ci --ignore-scripts/);
    assert.match(dockerfile, /^USER 65532:65532$/m);
  });
});

describe("offline CAS and injected OIDC verification", () => {
  test("all raw artifacts must exist with exact bytes, length, digest, and manifest", async () => {
    const fixture = makeFixture();
    const first = fixture.certification.evidenceManifest[0];

    const missing = new Map(fixture.artifacts);
    missing.delete(first.address);
    await expectCodeAsync(
      () => verifyExternalCiCertification({ ...fixture, artifacts: missing }),
      "MISSING_ARTIFACT",
    );

    const changed = new Map(fixture.artifacts);
    changed.set(first.address, Buffer.from("tampered", "utf8"));
    await expectCodeAsync(
      () => verifyExternalCiCertification({ ...fixture, artifacts: changed }),
      "CAS_ARTIFACT_MISMATCH",
    );

    const omittedCertification = clone(fixture.certification);
    omittedCertification.evidenceManifest.pop();
    omittedCertification.certificationHash = hashWithoutField(
      omittedCertification,
      "certificationHash",
    );
    await expectCodeAsync(
      () =>
        verifyExternalCiCertification({
          ...fixture,
          certification: omittedCertification,
        }),
      "MANIFEST_BINDING_MISMATCH",
    );
  });

  test("manifest order, uniqueness, cardinality, timestamps, and categorical authority are bounded", () => {
    const { certification } = makeFixture();
    const values = [];
    const reversed = clone(certification);
    reversed.evidenceManifest.reverse();
    reversed.certificationHash = hashWithoutField(reversed, "certificationHash");
    values.push([reversed, "NON_CANONICAL_MANIFEST"]);
    const duplicate = clone(certification);
    duplicate.evidenceManifest[1] = clone(duplicate.evidenceManifest[0]);
    duplicate.certificationHash = hashWithoutField(
      duplicate,
      "certificationHash",
    );
    values.push([duplicate, "NON_CANONICAL_MANIFEST"]);
    const empty = clone(certification);
    empty.evidenceManifest = [];
    empty.certificationHash = hashWithoutField(empty, "certificationHash");
    values.push([empty, "INVALID_EVIDENCE_MANIFEST"]);
    const badDate = clone(certification);
    badDate.verifiedAt = "not-a-date";
    badDate.certificationHash = hashWithoutField(badDate, "certificationHash");
    values.push([badDate, "INVALID_TIMESTAMP"]);
    const authority = clone(certification);
    authority.productionAuthority = true;
    authority.certificationHash = hashWithoutField(
      authority,
      "certificationHash",
    );
    values.push([authority, "PRODUCTION_AUTHORITY_FORBIDDEN"]);
    const replay = clone(certification);
    replay.replay.multiHostSafe = true;
    replay.certificationHash = hashWithoutField(replay, "certificationHash");
    values.push([replay, "REPLAY_SCOPE_UNSUPPORTED"]);
    const issuer = clone(certification);
    issuer.replay.issuer = "https://attacker.example";
    issuer.certificationHash = hashWithoutField(issuer, "certificationHash");
    values.push([issuer, "INVALID_OIDC_ISSUER"]);
    const jti = clone(certification);
    jti.replay.jti = "not-a-uuid";
    jti.certificationHash = hashWithoutField(jti, "certificationHash");
    values.push([jti, "INVALID_JTI"]);
    for (const [value, code] of values) {
      expectCode(() => validateExternalCiCertification(value), code);
    }
  });

  test("certification and body digests prevent arbitrary caller-body substitution", async () => {
    const fixture = makeFixture();
    const body = clone(fixture.certification.attestationBody);
    body.candidate.diffSha256 = digest("caller-selected-diff");
    const changed = clone(fixture.certification);
    changed.attestationBody = body;
    changed.attestationBodySha256 = sha256(stableJson(body));
    changed.certificationHash = hashWithoutField(
      changed,
      "certificationHash",
    );
    await expectCodeAsync(
      () =>
        verifyExternalCiCertification({
          ...fixture,
          certification: changed,
        }),
      "ATTESTATION_SUBSTITUTION",
    );

    for (const [field, value] of [
      ["attestationBodySha256", digest("wrong-body")],
      ["collectorReceiptSha256", digest("wrong-collector")],
      ["certificationHash", digest("wrong-certification")],
    ]) {
      const invalid = clone(fixture.certification);
      invalid[field] = value;
      expectCode(
        () => validateExternalCiCertification(invalid),
        "HASH_MISMATCH",
      );
    }
  });

  test("OIDC crypto is mandatory, synchronous, and cannot be replaced by an echo validator", async () => {
    const fixture = makeFixture();
    const replaySubstitution = clone(fixture.certification);
    replaySubstitution.replay.replayKeySha256 = digest("wrong-replay-key");
    replaySubstitution.certificationHash = hashWithoutField(
      replaySubstitution,
      "certificationHash",
    );
    await expectCodeAsync(
      () =>
        verifyExternalCiCertification({
          ...fixture,
          certification: replaySubstitution,
        }),
      "REPLAY_BINDING_MISMATCH",
    );
    const tampered = clone(fixture.certification);
    const segments = tampered.collectorReceipt.oidcToken.split(".");
    segments[2] = `${
      segments[2].startsWith("A") ? "B" : "A"
    }${segments[2].slice(1)}`;
    tampered.collectorReceipt.oidcToken = segments.join(".");
    tampered.collectorReceiptSha256 = sha256(
      stableJson(tampered.collectorReceipt),
    );
    tampered.certificationHash = hashWithoutField(
      tampered,
      "certificationHash",
    );
    await expectCodeAsync(
      () =>
        verifyExternalCiCertification({
          ...fixture,
          certification: tampered,
          verifyOidcCollector: () => ({
            valid: true,
          }),
        }),
      "OIDC_CRYPTO_INVALID",
    );
    const result = verifyExternalCiCertification(fixture);
    assert.equal(result.valid, true);
    assert.equal(result.authorityCommit, fixture.materialization.authority.commit);
  });

  test("the full package verifies synchronously long after token expiry but rejects future or forged ceremony time", () => {
    const fixture = makeFixture();
    for (const days of [1, 30]) {
      const result = verifyExternalCiPackage({
        bundle: fixture.bundle,
        trustedAuthority: fixture.trustedAuthority,
        jwksRegistry: fixture.jwksRegistry,
        artifacts: fixture.artifacts,
        nowMs: fixture.nowMs + days * 24 * 60 * 60 * 1000,
      });
      assert.equal(result.valid, true);
    }

    const changed = clone(fixture.bundle);
    changed.certification.verifiedAt = "2026-07-24T06:01:00.000Z";
    changed.certification.certificationHash = hashWithoutField(
      changed.certification,
      "certificationHash",
    );
    changed.packageHash = hashWithoutField(changed, "packageHash");
    expectCode(
      () =>
        verifyExternalCiPackage({
          bundle: changed,
          trustedAuthority: fixture.trustedAuthority,
          jwksRegistry: fixture.jwksRegistry,
          artifacts: fixture.artifacts,
          nowMs: fixture.nowMs + 24 * 60 * 60 * 1000,
        }),
      "CERTIFICATION_TIME_INVALID",
    );

    const future = clone(fixture.bundle);
    future.certification.collectorReceipt.requestedAt =
      "2026-08-24T06:00:00.000Z";
    future.certification.collectorReceipt.receivedAt =
      "2026-08-24T06:00:01.000Z";
    future.certification.collectorReceiptSha256 = sha256(
      stableJson(future.certification.collectorReceipt),
    );
    future.certification.verifiedAt = "2026-08-24T06:00:02.000Z";
    future.certification.certificationHash = hashWithoutField(
      future.certification,
      "certificationHash",
    );
    future.packageHash = hashWithoutField(future, "packageHash");
    expectCode(
      () =>
        verifyExternalCiPackage({
          bundle: future,
          trustedAuthority: fixture.trustedAuthority,
          jwksRegistry: fixture.jwksRegistry,
          artifacts: fixture.artifacts,
          nowMs: fixture.nowMs,
        }),
      "OIDC_CRYPTO_INVALID",
    );
  });

  test("offline package is framed and rejects missing receipts, altered manifests, and package hashes", () => {
    const fixture = makeFixture();
    for (const [mutate, code] of [
      [
        (value) => {
          delete value.macosJudge;
        },
        "UNEXPECTED_FIELDS",
      ],
      [
        (value) => {
          value.evidenceManifest.pop();
          value.packageHash = hashWithoutField(value, "packageHash");
        },
        "MANIFEST_BINDING_MISMATCH",
      ],
      [
        (value) => {
          value.packageHash = digest("tampered-package");
        },
        "HASH_MISMATCH",
      ],
    ]) {
      const changed = clone(fixture.bundle);
      mutate(changed);
      expectCode(
        () =>
          verifyExternalCiPackage({
            bundle: changed,
            trustedAuthority: fixture.trustedAuthority,
            jwksRegistry: fixture.jwksRegistry,
            artifacts: fixture.artifacts,
            nowMs: fixture.nowMs,
          }),
        code,
      );
    }
  });
});

describe("schema sabotage tests", () => {
  test("materialization exact fields, authority lineage, parentage, and hashes fail closed", () => {
    const { materialization } = makeFixture();
    const cases = [
      [{ ...materialization, schema: "v2" }, "INVALID_SCHEMA"],
      [{ ...materialization, repository: "attacker/repo" }, "INVALID_REPOSITORY"],
      [
        {
          ...materialization,
          authority: { ...materialization.authority, ref: "main" },
        },
        "INVALID_AUTHORITY_REF",
      ],
      [
        {
          ...materialization,
          authority: {
            ...materialization.authority,
            workflowPath: ".github/workflows/attacker.yml",
          },
        },
        "INVALID_AUTHORITY_PATH",
      ],
      [
        {
          ...materialization,
          authority: {
            ...materialization.authority,
            ancestorOfScopeVerified: false,
          },
        },
        "REQUIRED_PROOF_MISSING",
      ],
      [
        {
          ...materialization,
          candidate: {
            ...materialization.candidate,
            scopeParentVerified: false,
          },
        },
        "REQUIRED_PROOF_MISSING",
      ],
      [
        {
          ...materialization,
          candidate: {
            ...materialization.candidate,
            parent: "f".repeat(40),
          },
        },
        "COMMIT_BINDING_MISMATCH",
      ],
      [{ ...materialization, receiptHash: digest("wrong") }, "HASH_MISMATCH"],
      [{ ...materialization, callerField: "forbidden" }, "UNEXPECTED_FIELDS"],
    ];
    for (const [value, code] of cases) {
      if (value.receiptHash === materialization.receiptHash) {
        value.receiptHash = hashWithoutField(value, "receiptHash");
      }
      expectCode(() => validateMaterializationReceipt(value), code);
    }
  });

  test("materialization roles, command hash, and macOS platform receipt cannot be weakened", () => {
    const fixture = makeFixture();
    const badPlanHash = clone(fixture.materialization);
    badPlanHash.phase.commandPlanSha256 = digest("wrong-command-plan");
    badPlanHash.receiptHash =
      hashWithoutField(badPlanHash, "receiptHash");
    expectCode(
      () => validateMaterializationReceipt(badPlanHash),
      "HASH_MISMATCH",
    );
    const cEqualsS = clone(fixture.materialization);
    cEqualsS.candidate.commit = cEqualsS.phase.scopeBaseCommit;
    cEqualsS.receiptHash = hashWithoutField(cEqualsS, "receiptHash");
    expectCode(
      () => validateMaterializationReceipt(cEqualsS),
      "COMMIT_ROLE_COLLISION",
    );
    const aEqualsS = clone(fixture.materialization);
    aEqualsS.authority.commit = aEqualsS.phase.scopeBaseCommit;
    aEqualsS.receiptHash = hashWithoutField(aEqualsS, "receiptHash");
    expectCode(
      () => validateMaterializationReceipt(aEqualsS),
      "COMMIT_ROLE_COLLISION",
    );

    const platformCases = [
      [(value) => {
        value.schema = "v2";
      }, "INVALID_SCHEMA"],
      [(value) => {
        value.role = "linux-unit";
      }, "INVALID_PLATFORM"],
      [(value) => {
        value.platform = "linux";
      }, "INVALID_PLATFORM"],
      [(value) => {
        value.runnerImage = "";
      }, "INVALID_STRING"],
      [(value) => {
        value.nodeVersion = "v22.7.9";
      }, "UNSUPPORTED_NODE_VERSION"],
      [(value) => {
        value.npmVersion = "10\u0000.9";
      }, "INVALID_STRING"],
      [(value) => {
        value.outcome = "warn";
      }, "JUDGE_FAILED"],
      [(value) => {
        value.receiptHash = digest("forged");
      }, "HASH_MISMATCH"],
    ];
    for (const [mutate, code] of platformCases) {
      const changed = clone(fixture.macosJudge);
      mutate(changed);
      if (code !== "HASH_MISMATCH") {
        changed.receiptHash = hashWithoutField(changed, "receiptHash");
      }
      expectCode(() => validatePlatformReceipt(changed), code);
    }
  });

  test("verdict and attestation bodies reject schema, authority, extras, and bad self-hashes", () => {
    const fixture = makeFixture();
    for (const [value, code] of [
      [{ ...fixture.verdict, schema: "v2" }, "INVALID_SCHEMA"],
      [{ ...fixture.verdict, passed: false }, "VERDICT_FAILED"],
      [
        { ...fixture.verdict, productionAuthority: true },
        "PRODUCTION_AUTHORITY_FORBIDDEN",
      ],
      [{ ...fixture.verdict, receiptHash: digest("wrong") }, "HASH_MISMATCH"],
      [{ ...fixture.verdict, callerField: true }, "UNEXPECTED_FIELDS"],
    ]) {
      expectCode(() => validateQualityVerdict(value), code);
    }
    for (const [value, code] of [
      [{ ...fixture.attestationBody, schema: "v2" }, "INVALID_SCHEMA"],
      [
        { ...fixture.attestationBody, repository: "attacker/repo" },
        "INVALID_REPOSITORY",
      ],
      [
        { ...fixture.attestationBody, productionAuthority: true },
        "PRODUCTION_AUTHORITY_FORBIDDEN",
      ],
      [{ ...fixture.attestationBody, callerBody: true }, "UNEXPECTED_FIELDS"],
    ]) {
      expectCode(() => validateExternalCiAttestationBody(value), code);
    }
  });

  test("run identity and scalar type boundaries reject malformed data", () => {
    const { materialization } = makeFixture();
    for (const [field, value, code] of [
      ["runId", "0", "INVALID_RUN"],
      ["runAttempt", "01", "INVALID_RUN"],
      ["requestNonce", "A".repeat(64), "INVALID_NONCE"],
    ]) {
      const changed = clone(materialization);
      changed.run[field] = value;
      changed.receiptHash = hashWithoutField(changed, "receiptHash");
      expectCode(() => validateMaterializationReceipt(changed), code);
    }
    const invalidRevision = clone(materialization);
    invalidRevision.phase.candidateLedgerRevision = 0;
    invalidRevision.receiptHash = hashWithoutField(
      invalidRevision,
      "receiptHash",
    );
    expectCode(
      () => validateMaterializationReceipt(invalidRevision),
      "INVALID_INTEGER",
    );
  });
});

describe("workflow files are static security contracts", () => {
  test("request exposes exactly phase/S/C/nonce and calls only frozen v3 authority", () => {
    const text = fs.readFileSync(REQUEST_WORKFLOW, "utf8");
    const inputNames = [...text.matchAll(/^      ([a-z_]+):$/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(inputNames, [
      "phase_id",
      "phase_scope_base_sha",
      "candidate_sha",
      "request_nonce",
    ]);
    assert.match(
      text,
      /demo-maintainer\/Pikiio-app-\/\.github\/workflows\/pikiio-proof-collector-v3\.yml@pikiio-proof-authority-v3/,
    );
    assert.match(
      text,
      /\[\[ "\$GITHUB_REF" == "refs\/tags\/pikiio-proof-authority-v3" \]\]/,
    );
    assert.match(text, /\[\[ "\$GITHUB_REF_TYPE" == "tag" \]\]/);
    assert.match(text, /\[\[ "\$GITHUB_REF_PROTECTED" == "true" \]\]/);
    assert.doesNotMatch(
      text,
      /proof_inputs|attestation_body|caller_body|jwks|metrics|evidence_manifest/i,
    );
    assert.doesNotMatch(
      text,
      /pull_request_target|workflow_run|repository_dispatch|schedule:/,
    );
    assert.doesNotMatch(text, /secrets:\s*inherit/);
  });

  test("collector has isolated macOS and final OIDC identities and no candidate credential path", () => {
    const text = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    for (const job of [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
      "reduce",
      "collect",
      "report",
    ]) {
      assert.match(text, new RegExp(`^  ${job}:$`, "m"));
    }
    assert.equal((text.match(/id-token:\s*write/g) || []).length, 2);
    const blocks = {};
    const matches = [...text.matchAll(/^  ([a-z_]+):$/gm)];
    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index;
      const end =
        index + 1 < matches.length ? matches[index + 1].index : text.length;
      blocks[matches[index][1]] = text.slice(start, end);
    }
    for (const job of [
      "materialize",
      "judge_primary",
      "judge_independent",
      "reduce",
      "report",
    ]) {
      assert.doesNotMatch(blocks[job], /id-token|ACTIONS_ID_TOKEN/);
    }
    assert.match(blocks.macos_unit, /runs-on:\s*macos-14/);
    assert.match(blocks.macos_unit, /id-token:\s*write/);
    const macExecute = blocks.macos_unit.match(
      /- name: Execute every macOS unit command[\s\S]*?(?=- name: Seal independently authenticated macOS identity)/,
    )?.[0];
    const macIdentity = blocks.macos_unit.match(
      /- name: Seal independently authenticated macOS identity[\s\S]*/,
    )?.[0];
    assert.ok(macExecute);
    assert.ok(macIdentity);
    assert.match(macExecute, /sandbox-exec[\s\S]*\/usr\/bin\/env -i/);
    assert.doesNotMatch(macExecute, /ACTIONS_ID_TOKEN|PIKIIO_OIDC_REQUEST/);
    assert.match(macIdentity, /ACTIONS_ID_TOKEN_REQUEST_URL/);
    assert.match(macIdentity, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
    assert.equal(
      (text.match(/header = "Authorization: bearer %s"/g) || []).length,
      2,
    );
    assert.doesNotMatch(
      text,
      /--header "Authorization: bearer \$PIKIIO_OIDC_REQUEST_TOKEN"/,
    );
    assert.match(macIdentity, /unset oidc_token OIDC_TOKEN/);
    assert.doesNotMatch(macIdentity, /PIKIIO_COMMAND_B64|sandbox-exec/);
    assert.match(blocks.collect, /id-token:\s*write/);
    assert.match(
      blocks.collect,
      /needs:\s*\[materialize, macos_unit, judge_primary, judge_independent, reduce\]/,
    );
    assert.doesNotMatch(blocks.collect, /docker run|npm |candidate\/|eval /);
    assert.doesNotMatch(text, /continue-on-error|always\(\)|secrets:\s*inherit/);
  });

  test("both Linux judges reuse one frozen script that creates one hostile container per command", () => {
    const text = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    const primary = text.match(
      /^  judge_primary:\n([\s\S]*?)(?=^  judge_independent:\n)/m,
    )?.[0];
    const independent = text.match(
      /^  judge_independent:\n([\s\S]*?)(?=^  reduce:\n)/m,
    )?.[0];
    assert.ok(primary);
    assert.ok(independent);
    assert.match(primary, /PIKIIO_ROLE: primary/);
    assert.match(primary, /run: &linux_judge \|/);
    assert.match(independent, /PIKIIO_ROLE: independent/);
    assert.match(independent, /run: \*linux_judge/);
    for (const token of [
      'for encoded in "${commands[@]}"',
      "docker run --rm",
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--user 65532:65532",
      "--pids-limit 256",
      "--memory 4g",
      "--cpus 2",
      "--tmpfs /tmp:rw,nosuid,nodev,noexec,size=1g",
      "--entrypoint /usr/bin/env",
      "freshContainerPerCommand: true",
      'childProtocol: "pikiio-external-ci-child-v3"',
      "credentialKeysPresent: []",
      "githubOutputPresent: false",
    ]) {
      assert.match(
        primary,
        new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    assert.doesNotMatch(
      primary,
      /(?:GITHUB_OUTPUT|GITHUB_STEP_SUMMARY|TOKEN|SECRET)=/,
    );
    assert.doesNotMatch(`${primary}\n${independent}`, /github\.token|secrets\./);
    assert.doesNotMatch(text, /vars\.PIKIIO_JUDGE_IMAGE|continue-on-error|\|\| true/);
  });

  test("macOS is a separate non-skippable authority and every gauntlet group is materialized from A", () => {
    const text = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    const macos = text.match(
      /^  macos_unit:\n([\s\S]*?)(?=^  judge_primary:\n)/m,
    )?.[0];
    assert.ok(macos);
    assert.match(macos, /runs-on: macos-14/);
    assert.match(macos, /platform === "macos"/);
    assert.match(macos, /unit deterministic repeats diverged/);
    assert.match(macos, /per-file coverage gate failed/);
    assert.match(macos, /sealPlatformReceipt/);
    assert.match(macos, /executedCommandNamesSha256/);
    assert.match(macos, /\/usr\/bin\/sandbox-exec -f/);
    assert.match(
      fs.readFileSync(CHILD_RUNNER_PATH, "utf8"),
      /\(deny network\*\)/,
    );
    assert.match(macos, /PIKIIO_MACOS_SCRATCH_PATH/);
    assert.match(macos, /PIKIIO_PHASE_ID="\$phase_id"/);
    assert.match(macos, /sealed_digest/);
    assert.match(macos, /workspace_before/);
    assert.match(macos, /contents:\s*read/);
    assert.match(
      macos,
      /api\\\.github\\\.com\/repos\/demo-maintainer\/Pikiio-app-\/releases\/assets/,
    );
    assert.match(macos, /Authorization: Bearer %s/);
    assert.doesNotMatch(macos, /continue-on-error|todo:\s*[1-9]/i);
    const executionStep = macos.slice(
      macos.indexOf("Execute every macOS unit command"),
    );
    assert.doesNotMatch(
      executionStep,
      /PIKIIO_GITHUB_TOKEN|Authorization: Bearer|github\.token/,
    );
    for (const group of [
      "syntax",
      "unit",
      "gherkin",
      "mutation",
      "focused",
      "neighbor",
      "broad",
      "production-shaped",
    ]) {
      assert.match(text, new RegExp(`group = "${group}"`));
    }
    assert.match(text, /populationFloors: phasePlan\.populationFloors/);
    assert.match(text, /requiredCoverageFiles/);
  });

  test("macOS receipt lineage has one immutable successful-needs path into the OIDC body", () => {
    const bytes = fs.readFileSync(COLLECTOR_WORKFLOW);
    const lineage = validateAuthorityWorkflowForMacosLineage(bytes);
    assert.equal(lineage.workflowBlobSha256, sha256(bytes));
    assert.deepEqual([...lineage.macosUnitNeeds], ["materialize"]);
    assert.deepEqual([...lineage.judgeNeeds], ["materialize", "macos_unit"]);
    assert.deepEqual([...lineage.reducerNeeds], [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
    ]);
    assert.deepEqual([...lineage.collectorNeeds], [
      "materialize",
      "macos_unit",
      "judge_primary",
      "judge_independent",
      "reduce",
    ]);
    const text = bytes.toString("utf8");
    assert.match(text, /const authorityWorkflowBytes = show\(A,/);
    assert.match(text, /"authority-workflow\.yml"/);
    assert.match(text, /proof\.buildMacosLineage\(\{/);
    assert.match(text, /fresh collector lineage differs from reducer lineage/);
    assert.match(text, /macosLineage: input\.macosLineage/);
    assert.match(text, /"macos-lineage\.json": input\.macosLineage/);
    assert.equal(
      (
        text.match(
          /PIKIIO_MACOS_ARTIFACT_ID: \$\{\{ needs\.macos_unit\.outputs\.artifact_id \}\}/g,
        ) || []
      ).length,
      2,
    );
    assert.equal(
      (
        text.match(
          /PIKIIO_MACOS_ARTIFACT_DIGEST: \$\{\{ needs\.macos_unit\.outputs\.artifact_digest \}\}/g,
        ) || []
      ).length,
      2,
    );
    assert.equal(
      (
        text.match(
          /PIKIIO_MACOS_HASH: \$\{\{ needs\.macos_unit\.outputs\.receipt_hash \}\}/g,
        ) || []
      ).length,
      2,
    );
    assert.doesNotMatch(
      text,
      /PIKIIO_MACOS_(?:ARTIFACT_ID|ARTIFACT_DIGEST|HASH):\s*\$\{\{\s*inputs\./,
    );
  });

  test("workflow proves bootstrap lineage, active scope, allowed paths, and anti-weakening before execution", () => {
    const text = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    for (const token of [
      "pikiio-proof-authority-v3",
      "merge-base --is-ancestor",
      "rev-list --parents -n1",
      "prior_scope",
      "scope-declaration-paths.nul",
      "validateConstructibleSourceHistory",
      "candidateLedgerBaseCommit",
      "A-owned phase profile, thresholds, policy, or mission contract drifted",
      "active phase quality plan differs from frozen registry",
      "governance.selectActivePhase",
      "governance.entryAllowed",
      "frozenAuthorityPaths",
      "activePhaseVerified: true",
      "dependenciesVerified: true",
      "allowedPathsVerified: true",
      "antiWeakeningVerified: true",
      "toolchainCommissioned: true",
      "TOOLCHAIN_UNCOMMISSIONED",
      "scopeParentVerified",
      "ancestorOfScopeVerified",
      "sourceManifestSha256",
      "evidenceManifestSha256",
      "collectorReceipt",
      "productionAuthority",
      "sha256sum",
    ]) {
      assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(
      text,
      /inputs\.(?:authority|proof|body|jwks|metrics|artifact|verdict)/,
    );
    assert.doesNotMatch(text, /receipt_base64|oidcToken.*GITHUB_OUTPUT/);
  });

  test("transport actions are immutable and the package is bounded, raw-CAS-complete, and self-verifying", () => {
    const collector = fs.readFileSync(COLLECTOR_WORKFLOW, "utf8");
    const request = fs.readFileSync(REQUEST_WORKFLOW, "utf8");
    const uses = [...`${collector}\n${request}`.matchAll(/^\s+uses:\s+(\S+)$/gm)]
      .map((match) => match[1]);
    assert.ok(uses.length >= 2);
    for (const value of uses) {
      if (
        value ===
        "demo-maintainer/Pikiio-app-/.github/workflows/pikiio-proof-collector-v3.yml@pikiio-proof-authority-v3"
      ) {
        continue;
      }
      assert.match(
        value,
        /^actions\/(?:upload|download)-artifact@[a-f0-9]{40}$/,
      );
    }
    assert.match(
      collector,
      /path\.join\(process\.env\.PIKIIO_OUTPUT, "cas", "sha256", reference\.sha256\)/,
    );
    assert.match(collector, /raw CAS mismatch/);
    assert.match(collector, /per-file coverage gate failed/);
    assert.match(collector, /deterministic repeats diverged/);
    assert.match(collector, /differs from frozen authority/);
    assert.match(collector, /sealExternalCiPackage/);
    assert.match(collector, /verifyExternalCiPackage/);
    assert.match(collector, /external-ci-package\.json/);
    assert.match(collector, /package-manifest\.sha256/);
    assert.match(collector, /total_bytes/);
    assert.match(collector, /file_count/);
    assert.match(collector, /source tree file-count bound failed/);
    assert.match(collector, /source tree byte bound failed/);
    assert.match(collector, /^permissions: \{\}$/m);
    assert.doesNotMatch(
      collector,
      /runs-on:\s*(?:self-hosted|\[.*self-hosted)|\bcache:|services:|environment:/,
    );
  });
});

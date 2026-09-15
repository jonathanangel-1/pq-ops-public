"use strict";

process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { after, describe, test } = require("node:test");

const verifier = require("../lib/pikiio-frozen-authority-verifier");
const phaseProof = require("../lib/pikiio-phase-proof");
const phaseAttestation = require("../lib/pikiio-phase-attestation");
const githubCollector = require("../lib/pikiio-github-oidc-collector");
const cli = require("../scripts/verify-pikiio-frozen-authority");

const REPO_ROOT = path.resolve(__dirname, "..");
const LIBRARY_PATH = path.join(
  REPO_ROOT,
  "lib",
  "pikiio-frozen-authority-verifier.js",
);
const CLI_PATH = require.resolve(
  "../scripts/verify-pikiio-frozen-authority",
);
const TEMP_ROOTS = [];
const FIXED_NOW = Date.parse("2026-07-24T12:00:10.000Z");
const MAX_PHASE_ARTIFACT_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_PHASE_ARTIFACT_ENCODED_BYTES = 45 * 1024 * 1024;
const ZERO_HASH_CHUNK = Buffer.alloc(1024 * 1024);
let REPOSITORY_TEMPLATE = null;
let CUMULATIVE_BOUNDARY_ARTIFACTS = null;
let SINGLE_OVERSIZED_ARTIFACT = null;

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function git(repo, args, options = {}) {
  return execFileSync("/usr/bin/git", args, {
    cwd: repo,
    encoding: options.encoding ?? "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: os.homedir(),
      LANG: "C",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Pikiio Test",
      GIT_AUTHOR_EMAIL: "pikiio-test@example.invalid",
      GIT_COMMITTER_NAME: "Pikiio Test",
      GIT_COMMITTER_EMAIL: "pikiio-test@example.invalid",
      GIT_AUTHOR_DATE: "2026-07-24T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-24T12:00:00Z",
    },
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function actualRegistry() {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        REPO_ROOT,
        "YLYI/00_Product_Contract/Pikiio_Phase_Proof_Registry.json",
      ),
      "utf8",
    ),
  );
}

function activeLedger(scopeBaseCommit = "0".repeat(40), phaseId = "GOV-00") {
  return {
    schema: "test-ledger",
    revision: 2,
    activePhaseId: phaseId,
    phases: [
      {
        id: phaseId,
        lane: phaseId === "GOV-00" ? "autonomy-governance" : "other",
        scopeBaseCommit,
      },
    ],
  };
}

function makeTempRoot() {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), "pikiio-frozen-verifier-"),
    ),
  );
  TEMP_ROOTS.push(root);
  return root;
}

function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

function initializeAuthority(root) {
  const authorityRoot = path.join(root, "authority");
  fs.mkdirSync(authorityRoot, { recursive: true });
  git(authorityRoot, ["init", "--quiet", "--initial-branch=authority"]);
  writeJson(
    path.join(authorityRoot, verifier.LEDGER_RELATIVE_PATH),
    activeLedger(),
  );
  for (const relativePath of [
    verifier.AUTHORITY_RELATIVE_PATH,
    verifier.JWKS_RELATIVE_PATH,
  ]) {
    const destination = path.join(authorityRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relativePath), destination);
  }
  fs.writeFileSync(
    path.join(authorityRoot, "README.md"),
    "frozen authority fixture\n",
  );
  git(authorityRoot, ["add", "."]);
  git(authorityRoot, ["commit", "--quiet", "-m", "frozen authority"]);
  return {
    authorityRoot,
    scopeBaseCommit: git(authorityRoot, ["rev-parse", "HEAD"]),
  };
}

function initializeCandidate(root, authorityRoot, scopeBaseCommit) {
  const candidateRepo = path.join(root, "candidate");
  git(root, ["-c", "protocol.file.allow=always", "clone", "--quiet", authorityRoot, candidateRepo]);
  writeJson(
    path.join(candidateRepo, verifier.LEDGER_RELATIVE_PATH),
    activeLedger(scopeBaseCommit),
  );
  git(candidateRepo, ["add", verifier.LEDGER_RELATIVE_PATH]);
  git(candidateRepo, ["commit", "--quiet", "-m", "bind scope base"]);
  return {
    candidateRepo,
    candidateCommit: git(candidateRepo, ["rev-parse", "HEAD"]),
    candidateTree: git(candidateRepo, ["rev-parse", "HEAD^{tree}"]),
  };
}

function repositoryTemplate() {
  if (REPOSITORY_TEMPLATE) return REPOSITORY_TEMPLATE;
  const templateRoot = makeTempRoot();
  const authority = initializeAuthority(templateRoot);
  const candidate = initializeCandidate(
    templateRoot,
    authority.authorityRoot,
    authority.scopeBaseCommit,
  );
  REPOSITORY_TEMPLATE = {
    ...authority,
    ...candidate,
    authorityTree: git(authority.authorityRoot, [
      "rev-parse",
      `${authority.scopeBaseCommit}^{tree}`,
    ]),
  };
  return REPOSITORY_TEMPLATE;
}

function copyTemplateRepositories(root) {
  const template = repositoryTemplate();
  const authorityRoot = path.join(root, "authority");
  const candidateRepo = path.join(root, "candidate");
  fs.cpSync(template.authorityRoot, authorityRoot, { recursive: true });
  fs.cpSync(template.candidateRepo, candidateRepo, { recursive: true });
  return {
    authorityRoot,
    candidateRepo,
    scopeBaseCommit: template.scopeBaseCommit,
    candidateCommit: template.candidateCommit,
    candidateTree: template.candidateTree,
    authorityTree: template.authorityTree,
  };
}

function artifact(bytes) {
  const buffer = Buffer.from(bytes);
  const hash = digest(buffer);
  return {
    address: `sha256:${hash}`,
    bytes: buffer.toString("base64"),
    encoding: "base64",
    sha256: hash,
  };
}

function zeroSha256(byteLength) {
  const hash = crypto.createHash("sha256");
  let remaining = byteLength;
  while (remaining > 0) {
    const size = Math.min(remaining, ZERO_HASH_CHUNK.length);
    hash.update(ZERO_HASH_CHUNK.subarray(0, size));
    remaining -= size;
  }
  return hash.digest("hex");
}

function canonicalZeroBase64(decodedLength) {
  const encodedLength = Math.ceil(decodedLength / 3) * 4;
  const padding = (3 - (decodedLength % 3)) % 3;
  return `${"A".repeat(encodedLength - padding)}${"=".repeat(padding)}`;
}

function zeroArtifact(decodedLength) {
  const hash = zeroSha256(decodedLength);
  return {
    address: `sha256:${hash}`,
    bytes: canonicalZeroBase64(decodedLength),
    encoding: "base64",
    sha256: hash,
  };
}

function cumulativeBoundaryArtifacts() {
  if (CUMULATIVE_BOUNDARY_ARTIFACTS === null) {
    CUMULATIVE_BOUNDARY_ARTIFACTS = [
      zeroArtifact(16 * 1024 * 1024),
      zeroArtifact(16 * 1024 * 1024 + 1),
    ]
      .sort((left, right) => left.address.localeCompare(right.address))
      .map((entry) => Object.freeze(entry));
    Object.freeze(CUMULATIVE_BOUNDARY_ARTIFACTS);
  }
  return CUMULATIVE_BOUNDARY_ARTIFACTS;
}

function singleOversizedArtifact() {
  if (SINGLE_OVERSIZED_ARTIFACT === null) {
    SINGLE_OVERSIZED_ARTIFACT = Object.freeze(
      zeroArtifact(MAX_PHASE_ARTIFACT_DECODED_BYTES + 1),
    );
  }
  return SINGLE_OVERSIZED_ARTIFACT;
}

function base64DecodeProbe(encodedValues) {
  const observed = new Set(encodedValues);
  const calls = [];
  const original = Buffer.from;
  Buffer.from = function (value, encoding, ...rest) {
    if (encoding === "base64" && observed.has(value)) calls.push(value);
    return original.call(Buffer, value, encoding, ...rest);
  };
  return {
    calls,
    restore() {
      Buffer.from = original;
    },
  };
}

function fixture(options = {}) {
  const root = makeTempRoot();
  const repositories = copyTemplateRepositories(root);
  const authority = {
    authorityRoot: repositories.authorityRoot,
    scopeBaseCommit: repositories.scopeBaseCommit,
    authorityTree: repositories.authorityTree,
  };
  const candidate = {
    candidateRepo: repositories.candidateRepo,
    candidateCommit: repositories.candidateCommit,
    candidateTree: repositories.candidateTree,
  };
  const primaryArtifact = artifact("primary judge bytes");
  const independentArtifact = artifact("independent judge bytes");
  const artifacts = [primaryArtifact, independentArtifact].sort((left, right) =>
    left.address.localeCompare(right.address),
  );
  const qualityReceipt = {
    receiptHash: digest("quality"),
    commandPlanSha256: digest("command-plan"),
    primaryJudge: {
      rawArtifact: { artifactSha256: primaryArtifact.sha256 },
    },
    cleanJudge: {
      rawArtifact: { artifactSha256: independentArtifact.sha256 },
    },
  };
  const receiptHashes = {
    candidate: digest("candidate receipt"),
    rehearsal: digest("rehearsal receipt"),
    change: digest("change receipt"),
    promotion: digest("promotion receipt"),
  };
  const bundle = {
    bundleHash: digest("phase bundle"),
    artifacts,
    chain: Object.fromEntries(
      Object.entries(receiptHashes).map(([role, receiptHash]) => [
        role,
        { receiptHash },
      ]),
    ),
  };
  const collectorReceipt = {
    receiptHash: digest("collector receipt"),
    oidc: { checkRunId: "90001" },
  };
  const qualityReceiptPath = path.join(root, "quality.json");
  const phaseProofBundlePath = path.join(root, "bundle.json");
  const collectorReceiptPath = path.join(root, "collector.json");
  writeJson(qualityReceiptPath, qualityReceipt);
  writeJson(phaseProofBundlePath, bundle);
  writeJson(collectorReceiptPath, collectorReceipt);
  const registry = actualRegistry();
  const registrySha256 = phaseProof.sha256(phaseProof.stableJson(registry));
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: githubCollector.EXPECTED_REPOSITORY,
    RUNNER_ENVIRONMENT: githubCollector.EXPECTED_RUNNER_ENVIRONMENT,
    GITHUB_SHA: candidate.candidateCommit,
    GITHUB_EVENT_NAME: "workflow_call",
    GITHUB_RUN_ID: "80001",
    GITHUB_RUN_NUMBER: "41",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const dependencyCalls = {
    quality: 0,
    bundle: 0,
    collector: 0,
    jwks: 0,
    snapshots: [],
  };
  const dependencies = {
    CANONICAL_REGISTRY_SHA256: registrySha256,
    COLLECTOR_PROOF_INPUT_SCHEMA:
      githubCollector.COLLECTOR_PROOF_INPUT_SCHEMA,
    cleanWorkspaceEvidenceDigest() {
      return digest("clean workspace");
    },
    computeAuthoritySnapshot({ repoRoot, commit, phaseId }) {
      dependencyCalls.snapshots.push({ repoRoot, commit, phaseId });
      return {
        schema: "pikiio-phase-authority-snapshot-v1",
        phaseId,
        registrySha256,
        commit,
        tree:
          repoRoot === candidate.candidateRepo
            ? candidate.candidateTree
            : authority.authorityTree,
        files: [],
        authoritySetSha256:
          options.divergentSnapshot && repoRoot === candidate.candidateRepo
            ? digest("divergent authority")
            : digest("frozen authority set"),
        snapshotHash: digest(`snapshot:${commit}`),
      };
    },
    loadPhaseProofRegistry() {
      return registry;
    },
    phaseProofForId: phaseProof.phaseProofForId,
    reconstructAttestationBodyFromProofInputs:
      githubCollector.reconstructAttestationBodyFromProofInputs,
    selectActivePhase(ledger) {
      return ledger.phases[0];
    },
    validateAttestationBody: phaseAttestation.validateAttestationBody,
    validateGithubOidcCollectorReceipt(input) {
      dependencyCalls.collector += 1;
      if (options.invalidCollector) {
        const error = new Error("collector refused");
        error.code = "COLLECTOR_REFUSED";
        throw error;
      }
      assert.equal(
        input.expectedJwksRegistrySha256,
        registry.githubOidcJwks.sha256,
      );
      assert.equal(input.expectedRun.runId, environment.GITHUB_RUN_ID);
      assert.equal(input.expectedRun.checkRunId, "90001");
      const body = phaseAttestation.validateAttestationBody(
        input.expectedBody,
      );
      return {
        valid: options.invalidCollectorResult ? false : true,
        receiptHash: collectorReceipt.receiptHash,
        bodySha256: body.bodySha256,
        candidateCommit: candidate.candidateCommit,
        scopeBaseCommit: authority.scopeBaseCommit,
        replayKey:
          "https://token.actions.githubusercontent.com:" +
          "123e4567-e89b-12d3-a456-426614174000",
        runId: environment.GITHUB_RUN_ID,
        runAttempt: environment.GITHUB_RUN_ATTEMPT,
        collectedAt: "2026-07-24T12:00:05.000Z",
      };
    },
    validatePhaseLedger() {
      return options.invalidLedger
        ? { valid: false, errors: ["ledger refused"] }
        : { valid: true, errors: [] };
    },
    validatePhaseProofBundle(_bundle, input) {
      dependencyCalls.bundle += 1;
      assert.equal(input.repoRoot, candidate.candidateRepo);
      assert.equal(input.requireFullChain, true);
      return options.invalidBundle
        ? { valid: false, errors: ["bundle refused"] }
        : { valid: true, errors: [] };
    },
    validatePinnedJwksRegistry(_jwks, input) {
      dependencyCalls.jwks += 1;
      assert.equal(
        input.expectedRegistrySha256,
        registry.githubOidcJwks.sha256,
      );
      if (options.invalidJwks) throw new Error("JWKS refused");
      return { registrySha256: input.expectedRegistrySha256 };
    },
    validateQualityReceipt(_receipt, input) {
      dependencyCalls.quality += 1;
      assert.equal(input.repoRoot, candidate.candidateRepo);
      assert.equal(input.head, candidate.candidateCommit);
      assert.equal(input.verifyRawArtifacts, true);
      assert.ok(
        input.rawArtifactBytes.has(`sha256:${primaryArtifact.sha256}`),
      );
      return options.invalidQuality
        ? { valid: false, errors: ["quality refused"] }
        : { valid: true, errors: [] };
    },
  };
  const runtime = {
    authorityRoot: authority.authorityRoot,
    replayRoot: path.join(root, "replay"),
    environment,
    now: () => FIXED_NOW,
    dependencies,
    readCommitBlob(repoRoot, _commit, relativePath, maximumBytes) {
      const bytes = fs.readFileSync(path.join(repoRoot, relativePath));
      assert.ok(bytes.length <= maximumBytes);
      return bytes;
    },
    verifyGit:
      options.realGit === true
        ? verifier.__testOnly.verifyFrozenAndCandidateGit
        : () => ({
            rootHead: authority.scopeBaseCommit,
            candidateHead: candidate.candidateCommit,
            candidateTree: candidate.candidateTree,
          }),
  };
  const input = {
    candidateRepo: candidate.candidateRepo,
    collectorReceiptPath,
    expectedScopeBaseCommit: authority.scopeBaseCommit,
    phaseProofBundlePath,
    qualityReceiptPath,
  };
  return {
    root,
    _candidateState: candidate,
    ...authority,
    ...candidate,
    qualityReceipt,
    bundle,
    collectorReceipt,
    qualityReceiptPath,
    phaseProofBundlePath,
    collectorReceiptPath,
    primaryArtifact,
    independentArtifact,
    receiptHashes,
    registry,
    registrySha256,
    environment,
    dependencies,
    dependencyCalls,
    runtime,
    input,
  };
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(error?.name, "FrozenAuthorityError");
    assert.equal(error?.code, code);
    return true;
  });
}

function issue(value) {
  return verifier.__testOnly.issue(value.input, value.runtime);
}

function validate(value, certification) {
  return verifier.__testOnly.validate(
    {
      candidateRepo: value.candidateRepo,
      expectedScopeBaseCommit: value.scopeBaseCommit,
      phaseProofBundlePath: value.phaseProofBundlePath,
      qualityReceiptPath: value.qualityReceiptPath,
      certification,
    },
    value.runtime,
  );
}

function rehashCertification(certification) {
  certification.certificationHash = digest(
    verifier.stableJson(
      Object.fromEntries(
        Object.entries(certification).filter(
          ([key]) => key !== "certificationHash",
        ),
      ),
    ),
  );
  return certification;
}

function amendCandidate(value, relativePath, contents) {
  const filePath = path.join(value.candidateRepo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  git(value.candidateRepo, ["add", relativePath]);
  git(value.candidateRepo, [
    "commit",
    "--quiet",
    "--amend",
    "--no-edit",
  ]);
  value.candidateCommit = git(value.candidateRepo, ["rev-parse", "HEAD"]);
  value.candidateTree = git(value.candidateRepo, ["rev-parse", "HEAD^{tree}"]);
  value._candidateState.candidateCommit = value.candidateCommit;
  value._candidateState.candidateTree = value.candidateTree;
  value.environment.GITHUB_SHA = value.candidateCommit;
}

after(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("frozen authority certification positive contract", () => {
  test("issues one content-addressed certification and consumes replay once", () => {
    const value = fixture();
    const certification = issue(value);
    assert.equal(
      certification.schema,
      "pikiio-frozen-authority-verification-receipt-v1",
    );
    assert.equal(certification.scopeBaseCommit, value.scopeBaseCommit);
    assert.equal(certification.candidateCommit, value.candidateCommit);
    assert.equal(certification.candidateTree, value.candidateTree);
    assert.equal(
      certification.phaseProofRegistrySha256,
      value.registrySha256,
    );
    assert.equal(
      certification.attestationAuthoritySha256,
      value.registry.attestationAuthority.sha256,
    );
    assert.equal(
      certification.jwksRegistrySha256,
      value.registry.githubOidcJwks.sha256,
    );
    assert.equal(
      certification.attestationBody.issuerRegistrySha256,
      value.registry.attestationAuthority.sha256,
    );
    assert.equal(
      certification.certificationHash,
      digest(
        verifier.stableJson(
          Object.fromEntries(
            Object.entries(certification).filter(
              ([key]) => key !== "certificationHash",
            ),
          ),
        ),
      ),
    );
    assert.equal(value.dependencyCalls.quality, 1);
    assert.equal(value.dependencyCalls.bundle, 1);
    assert.equal(value.dependencyCalls.collector, 1);
    assert.equal(value.dependencyCalls.jwks, 1);
    assert.equal(value.dependencyCalls.snapshots.length, 2);
    expectCode("REPLAY_ALREADY_CONSUMED", () => issue(value));
  });

  test("historical validation is deterministic and does not consume replay", () => {
    const value = fixture();
    const certification = issue(value);
    const first = validate(value, certification);
    const second = validate(value, certification);
    assert.deepEqual(second, first);
    assert.equal(first.valid, true);
    assert.equal(first.certificationHash, certification.certificationHash);
    assert.equal(first.replayKeySha256, certification.replayProtection.replayKeySha256);
  });

  test("embedded collector bytes preserve the raw receipt exactly", () => {
    const value = fixture();
    const raw = fs.readFileSync(value.collectorReceiptPath);
    const certification = issue(value);
    assert.deepEqual(
      Buffer.from(certification.collectorEvidence.bytes, "base64"),
      raw,
    );
    assert.equal(certification.collectorEvidence.rawSha256, digest(raw));
    assert.equal(
      certification.collectorEvidence.receiptHash,
      value.collectorReceipt.receiptHash,
    );
  });

  test("certification body binds all four receipts and both judge artifacts", () => {
    const value = fixture();
    const certification = issue(value);
    assert.deepEqual(certification.receiptHashes, value.receiptHashes);
    assert.deepEqual(
      certification.attestationBody.receiptHashes,
      value.receiptHashes,
    );
    assert.equal(
      certification.attestationBody.primaryRawArtifactHash,
      value.primaryArtifact.sha256,
    );
    assert.equal(
      certification.attestationBody.independentRawArtifactHash,
      value.independentArtifact.sha256,
    );
    assert.equal(
      certification.attestationBody.commandPlanHash,
      value.qualityReceipt.commandPlanSha256,
    );
  });
});

describe("frozen checkout and candidate Git boundary", () => {
  test("exact one-ledger candidate commit passes the real frozen Git and committed-blob boundary", () => {
    const value = fixture({ realGit: true });
    const runtime = { ...value.runtime };
    delete runtime.readCommitBlob;
    const certification = verifier.__testOnly.issue(value.input, runtime);
    assert.equal(certification.scopeBaseCommit, value.scopeBaseCommit);
    assert.equal(certification.candidateCommit, value.candidateCommit);
    assert.equal(certification.candidateTree, value.candidateTree);
  });

  test("missing committed ledger object fails through the real bounded blob reader", () => {
    const value = fixture();
    const missingCommit = "f".repeat(40);
    value.environment.GITHUB_SHA = missingCommit;
    const runtime = {
      ...value.runtime,
      verifyGit: () => ({
        rootHead: value.scopeBaseCommit,
        candidateHead: missingCommit,
        candidateTree: value.candidateTree,
      }),
    };
    delete runtime.readCommitBlob;
    expectCode("GIT_COMMAND_REFUSED", () =>
      verifier.__testOnly.issue(value.input, runtime),
    );
  });

  test("oversized committed ledger fails at the real Git object size bound", () => {
    const value = fixture();
    amendCandidate(
      value,
      verifier.LEDGER_RELATIVE_PATH,
      `${"x".repeat(4 * 1024 * 1024)}\n`,
    );
    const runtime = { ...value.runtime };
    delete runtime.readCommitBlob;
    expectCode("GIT_BLOB_SIZE_INVALID", () =>
      verifier.__testOnly.issue(value.input, runtime),
    );
  });

  test("root HEAD must equal the expected scope base", () => {
    const value = fixture({ realGit: true });
    value.input.expectedScopeBaseCommit = "f".repeat(40);
    expectCode("FROZEN_AUTHORITY_HEAD_MISMATCH", () => issue(value));
  });

  test("candidate must have exactly one parent", () => {
    const value = fixture({ realGit: true });
    git(value.candidateRepo, [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "second candidate commit",
    ]);
    value.environment.GITHUB_SHA = git(value.candidateRepo, ["rev-parse", "HEAD"]);
    expectCode("CANDIDATE_PARENT_INVALID", () => issue(value));
  });

  test("candidate commit may modify only the canonical ledger", () => {
    const value = fixture({ realGit: true });
    amendCandidate(
      value,
      "lib/pikiio-agent-governance.js",
      "throw new Error('candidate module executed');\n",
    );
    expectCode("GOV_BOOTSTRAP_NOT_LEDGER_ONLY", () => issue(value));
  });

  test("hostile candidate modules are never imported or executed", () => {
    const value = fixture({ realGit: true });
    const sentinel = path.join(value.root, "candidate-code-executed");
    amendCandidate(
      value,
      "lib/pikiio-agent-governance.js",
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "bad");\n`,
    );
    expectCode("GOV_BOOTSTRAP_NOT_LEDGER_ONLY", () => issue(value));
    assert.equal(fs.existsSync(sentinel), false);
  });

  test("hostile candidate registry changes are rejected before parsing", () => {
    const value = fixture({ realGit: true });
    amendCandidate(
      value,
      "YLYI/00_Product_Contract/Pikiio_Phase_Proof_Registry.json",
      '{"schema":"hostile"}\n',
    );
    expectCode("GOV_BOOTSTRAP_NOT_LEDGER_ONLY", () => issue(value));
  });

  test("untracked candidate code makes the checkout ineligible", () => {
    const value = fixture({ realGit: true });
    const hostile = path.join(value.candidateRepo, "hostile.js");
    fs.writeFileSync(hostile, "throw new Error('no');\n");
    expectCode("DIRTY_CHECKOUT", () => issue(value));
  });

  test("modified frozen verifier authority makes the root ineligible", () => {
    const value = fixture({ realGit: true });
    fs.appendFileSync(path.join(value.authorityRoot, "README.md"), "dirty\n");
    expectCode("DIRTY_CHECKOUT", () => issue(value));
  });

  test("candidate and authority cannot be the same checkout", () => {
    const value = fixture();
    expectCode("CHECKOUT_SEPARATION_REQUIRED", () =>
      verifier.__testOnly.verifyFrozenAndCandidateGit({
        authorityRoot: value.authorityRoot,
        candidateRepo: value.authorityRoot,
        expectedScopeBaseCommit: value.scopeBaseCommit,
      }),
    );
  });

  test("a symlinked candidate repository is refused", () => {
    const value = fixture({ realGit: true });
    const alias = path.join(value.root, "candidate-alias");
    fs.symlinkSync(value.candidateRepo, alias);
    value.input.candidateRepo = alias;
    expectCode("DIRECTORY_INVALID", () => issue(value));
  });
});

describe("frozen proof and authority validation", () => {
  for (const [name, option, code] of [
    ["invalid ledger", "invalidLedger", "CANDIDATE_LEDGER_INVALID"],
    [
      "invalid quality receipt",
      "invalidQuality",
      "STRICT_QUALITY_RECEIPT_INVALID",
    ],
    [
      "invalid phase bundle",
      "invalidBundle",
      "PHASE_PROOF_BUNDLE_INVALID",
    ],
    ["invalid JWKS", "invalidJwks", "JWKS_REGISTRY_INVALID"],
    [
      "invalid collector",
      "invalidCollector",
      "GITHUB_COLLECTOR_RECEIPT_INVALID",
    ],
    [
      "invalid collector result",
      "invalidCollectorResult",
      "GITHUB_COLLECTOR_RESULT_INVALID",
    ],
  ]) {
    test(`${name} fails closed`, () => {
      const value = fixture({ [option]: true });
      expectCode(code, () => issue(value));
    });
  }

  test("candidate authority snapshot must equal frozen authority", () => {
    const value = fixture({ divergentSnapshot: true });
    expectCode("AUTHORITY_SNAPSHOT_DIVERGENCE", () => issue(value));
  });

  test("active phase is mechanically restricted to GOV-00", () => {
    const value = fixture();
    writeJson(
      path.join(value.candidateRepo, verifier.LEDGER_RELATIVE_PATH),
      activeLedger(value.scopeBaseCommit, "ACTION-01"),
    );
    git(value.candidateRepo, ["add", verifier.LEDGER_RELATIVE_PATH]);
    git(value.candidateRepo, ["commit", "--quiet", "--amend", "--no-edit"]);
    value.environment.GITHUB_SHA = git(value.candidateRepo, ["rev-parse", "HEAD"]);
    expectCode("GOV_BOOTSTRAP_PHASE_INVALID", () => issue(value));
  });

  test("authority registry substitution is rejected from immutable bytes", () => {
    const value = fixture();
    const authorityPath = path.join(
      value.authorityRoot,
      verifier.AUTHORITY_RELATIVE_PATH,
    );
    const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
    authority.mode = "local";
    writeJson(authorityPath, authority);
    expectCode("ATTESTATION_AUTHORITY_INVALID", () => issue(value));
  });

  test("artifact bytes must be canonical and content addressed", () => {
    const value = fixture();
    value.bundle.artifacts[0].bytes =
      Buffer.from("forged bytes").toString("base64");
    writeJson(value.phaseProofBundlePath, value.bundle);
    expectCode("PHASE_BUNDLE_ARTIFACT_HASH_MISMATCH", () => issue(value));
  });

  test("artifact list must be sorted and unique", () => {
    const value = fixture();
    value.bundle.artifacts.reverse();
    writeJson(value.phaseProofBundlePath, value.bundle);
    expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () => issue(value));
  });

  test("primary and independent judge artifacts must be distinct", () => {
    const value = fixture();
    value.qualityReceipt.cleanJudge.rawArtifact.artifactSha256 =
      value.primaryArtifact.sha256;
    writeJson(value.qualityReceiptPath, value.qualityReceipt);
    expectCode("QUALITY_RAW_ARTIFACT_BINDING_INVALID", () => issue(value));
  });

  test("all four phase receipt hashes must be distinct", () => {
    const value = fixture();
    value.bundle.chain.promotion.receiptHash =
      value.bundle.chain.change.receiptHash;
    writeJson(value.phaseProofBundlePath, value.bundle);
    expectCode("PHASE_RECEIPT_HASH_COLLISION", () => issue(value));
  });
});

describe("GitHub run and replay authority", () => {
  for (const [field, replacement] of [
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_REPOSITORY", "attacker/repository"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_SHA", "f".repeat(40)],
    ["GITHUB_EVENT_NAME", "bad event"],
    ["GITHUB_RUN_ID", "01"],
    ["GITHUB_RUN_NUMBER", "-1"],
    ["GITHUB_RUN_ATTEMPT", "0x1"],
  ]) {
    test(`refuses substituted ${field}`, () => {
      const value = fixture();
      value.environment[field] = replacement;
      expectCode(
        field === "GITHUB_EVENT_NAME" ||
          field.startsWith("GITHUB_RUN_")
          ? "GITHUB_RUN_CONTEXT_INVALID"
          : "GITHUB_AUTHORITY_CONTEXT_MISMATCH",
        () => issue(value),
      );
    });
  }

  test("signed check-run identity must be a canonical decimal", () => {
    const value = fixture();
    value.collectorReceipt.oidc.checkRunId = "090001";
    writeJson(value.collectorReceiptPath, value.collectorReceipt);
    expectCode("GITHUB_RUN_CONTEXT_INVALID", () => issue(value));
  });

  test("replay marker is content addressed and contains no raw replay key", () => {
    const value = fixture();
    const certification = issue(value);
    const names = fs.readdirSync(value.runtime.replayRoot);
    assert.deepEqual(names, [
      `${certification.replayProtection.replayKeySha256}.json`,
    ]);
    const marker = fs.readFileSync(
      path.join(value.runtime.replayRoot, names[0]),
      "utf8",
    );
    assert.doesNotMatch(marker, /token\.actions\.githubusercontent\.com/);
    assert.match(marker, new RegExp(certification.certificationHash));
  });

  test("pure validation does not require or alter the replay directory", () => {
    const value = fixture();
    const certification = issue(value);
    fs.rmSync(value.runtime.replayRoot, { recursive: true, force: true });
    assert.equal(validate(value, certification).valid, true);
    assert.equal(fs.existsSync(value.runtime.replayRoot), false);
  });
});

describe("bounded file and certification refusal paths", () => {
  test("symlinked quality receipt is rejected", () => {
    const value = fixture();
    const alias = path.join(value.root, "quality-alias.json");
    fs.symlinkSync(value.qualityReceiptPath, alias);
    value.input.qualityReceiptPath = alias;
    expectCode("FILE_INVALID", () => issue(value));
  });

  test("non-absolute input paths are rejected", () => {
    const value = fixture();
    value.input.qualityReceiptPath = "quality.json";
    expectCode("INVALID_ABSOLUTE_PATH", () => issue(value));
  });

  test("every malformed absolute-path primitive is refused before I/O", () => {
    for (const [name, filePath] of [
      ["non-string", null],
      ["empty", ""],
      ["NUL", "/tmp/quality\u0000.json"],
      ["oversized", `/${"a".repeat(4_097)}`],
      ["non-canonical", "/tmp/../tmp/quality.json"],
    ]) {
      expectCode("INVALID_ABSOLUTE_PATH", () =>
        verifier.__testOnly.readBoundedRegularFile(filePath, {
          label: name,
          maximumBytes: 1024,
        }),
      );
    }
  });

  test("input path collisions are rejected", () => {
    const value = fixture();
    value.input.phaseProofBundlePath = value.qualityReceiptPath;
    expectCode("INPUT_PATH_COLLISION", () => issue(value));
  });

  test("empty and malformed JSON receipts fail closed", () => {
    const value = fixture();
    fs.writeFileSync(value.qualityReceiptPath, "");
    expectCode("FILE_INVALID", () => issue(value));
    fs.writeFileSync(value.qualityReceiptPath, "{broken");
    expectCode("INVALID_JSON", () => issue(value));
  });

  test("certification hash substitution is rejected before replay", () => {
    const value = fixture();
    const certification = issue(value);
    certification.certificationHash = "0".repeat(64);
    expectCode("CERTIFICATION_HASH_MISMATCH", () =>
      validate(value, certification),
    );
  });

  test("certification unexpected fields are rejected", () => {
    const value = fixture();
    const certification = issue(value);
    certification.unexpected = true;
    expectCode("UNEXPECTED_FIELDS", () => validate(value, certification));
  });

  test("embedded collector receipt mutation is rejected", () => {
    const value = fixture();
    const certification = issue(value);
    certification.collectorEvidence.bytes =
      Buffer.from('{"receiptHash":"bad"}\n').toString("base64");
    certification.certificationHash = digest(
      verifier.stableJson(
        Object.fromEntries(
          Object.entries(certification).filter(
            ([key]) => key !== "certificationHash",
          ),
        ),
      ),
    );
    expectCode("COLLECTOR_EVIDENCE_HASH_MISMATCH", () =>
      validate(value, certification),
    );
  });

  test("replay-key binding mutation is rejected", () => {
    const value = fixture();
    const certification = issue(value);
    certification.replayProtection.replayKey += "-forged";
    certification.certificationHash = digest(
      verifier.stableJson(
        Object.fromEntries(
          Object.entries(certification).filter(
            ([key]) => key !== "certificationHash",
          ),
        ),
      ),
    );
    expectCode("REPLAY_PROTECTION_INVALID", () =>
      validate(value, certification),
    );
  });

  test("test dependency injection is refused outside test mode", () => {
    const value = fixture();
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expectCode("TEST_RUNTIME_REFUSED", () =>
        verifier.__testOnly.issue(value.input, value.runtime),
      );
    } finally {
      process.env.NODE_ENV = prior;
    }
  });
});

describe("malformed authority, provenance, and replay refusal depth", () => {
  test("invalid commit and digest primitives fail before authority evaluation", () => {
    const value = fixture();
    value.input.expectedScopeBaseCommit = "not-a-commit";
    expectCode("INVALID_COMMIT", () => issue(value));

    const valid = fixture();
    const certification = issue(valid);
    certification.certificationHash = "NOT-A-DIGEST";
    expectCode("INVALID_SHA256", () =>
      verifier.__testOnly.validateCertificationShape(certification),
    );
  });

  test("invalid UTF-8 and non-object JSON receipts fail closed", () => {
    const invalidUtf8 = fixture();
    fs.writeFileSync(
      invalidUtf8.qualityReceiptPath,
      Buffer.from([0xc3, 0x28]),
    );
    expectCode("INVALID_UTF8", () => issue(invalidUtf8));

    const nonObject = fixture();
    fs.writeFileSync(nonObject.qualityReceiptPath, "[]\n");
    expectCode("INVALID_JSON_OBJECT", () => issue(nonObject));
  });

  test("an unreadable regular file is refused without leaking the OS error", () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "unreadable.json");
    fs.writeFileSync(filePath, "{}\n", { mode: 0o600 });
    fs.chmodSync(filePath, 0o000);
    try {
      expectCode("FILE_UNREADABLE", () =>
        verifier.__testOnly.readBoundedRegularFile(filePath, {
          label: "unreadable receipt",
          maximumBytes: 1024,
        }),
      );
    } finally {
      fs.chmodSync(filePath, 0o600);
    }
  });

  test("a regular file changed during bounded inspection is refused", async (t) => {
    const root = makeTempRoot();
    const filePath = path.join(root, "changing.json");
    const readyPath = path.join(root, "mutator-ready");
    fs.writeFileSync(filePath, Buffer.alloc(8 * 1024 * 1024, 0x61));
    const mutator = spawn(
      process.execPath,
      [
        "-e",
        [
          'const fs = require("node:fs");',
          "const [filePath, readyPath] = process.argv.slice(1);",
          'fs.writeFileSync(readyPath, "ready");',
          "const deadline = Date.now() + 5000;",
          "let tick = 0;",
          "while (Date.now() < deadline) {",
          "  const stamp = new Date(Date.now() + (++tick));",
          "  fs.utimesSync(filePath, stamp, stamp);",
          "}",
        ].join("\n"),
        filePath,
        readyPath,
      ],
      { stdio: "ignore" },
    );
    t.after(() => {
      try {
        mutator.kill("SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    await waitForPath(readyPath);
    let refusal = null;
    for (let attempt = 0; attempt < 100 && !refusal; attempt += 1) {
      try {
        verifier.__testOnly.readBoundedRegularFile(filePath, {
          label: "changing receipt",
          maximumBytes: 16 * 1024 * 1024,
        });
      } catch (error) {
        if (error.code !== "FILE_CHANGED") throw error;
        refusal = error;
      }
    }
    assert.equal(refusal?.code, "FILE_CHANGED");
  });

  test("missing and aliased receipt directories are refused", () => {
    const missing = fixture();
    missing.input.qualityReceiptPath = path.join(
      missing.root,
      "missing-parent",
      "quality.json",
    );
    expectCode("DIRECTORY_UNREADABLE", () => issue(missing));

    const aliased = fixture();
    const aliasPath = aliased.qualityReceiptPath.replace(
      /^\/private\/tmp\//,
      "/tmp/",
    );
    if (aliasPath !== aliased.qualityReceiptPath) {
      aliased.input.qualityReceiptPath = aliasPath;
      expectCode("DIRECTORY_ALIAS_REFUSED", () => issue(aliased));
    } else {
      assert.equal(
        fs.realpathSync(path.dirname(aliased.qualityReceiptPath)),
        path.dirname(aliased.qualityReceiptPath),
      );
    }

    const tmpAliasRoot = fs.mkdtempSync(
      "/tmp/pikiio-frozen-alias-",
    );
    TEMP_ROOTS.push(fs.realpathSync(tmpAliasRoot));
    const tmpAliasFile = path.join(tmpAliasRoot, "receipt.json");
    fs.writeFileSync(tmpAliasFile, "{}\n");
    expectCode("DIRECTORY_ALIAS_REFUSED", () =>
      verifier.__testOnly.readBoundedRegularFile(tmpAliasFile, {
        label: "aliased tmp receipt",
        maximumBytes: 1024,
      }),
    );
  });

  test("a non-repository authority path fails through bounded Git inspection", () => {
    const root = makeTempRoot();
    const candidate = path.join(root, "candidate");
    const authority = path.join(root, "authority");
    fs.mkdirSync(candidate);
    fs.mkdirSync(authority);
    expectCode("GIT_COMMAND_REFUSED", () =>
      verifier.__testOnly.verifyFrozenAndCandidateGit({
        authorityRoot: authority,
        candidateRepo: candidate,
        expectedScopeBaseCommit: "a".repeat(40),
      }),
    );
  });

  test("candidate must advance and retain an ordinary ledger blob", () => {
    const noAdvanceRoot = makeTempRoot();
    const authority = initializeAuthority(noAdvanceRoot);
    const candidateRepo = path.join(noAdvanceRoot, "candidate-no-advance");
    git(noAdvanceRoot, [
      "-c",
      "protocol.file.allow=always",
      "clone",
      "--quiet",
      authority.authorityRoot,
      candidateRepo,
    ]);
    expectCode("CANDIDATE_ADVANCE_REQUIRED", () =>
      verifier.__testOnly.verifyFrozenAndCandidateGit({
        authorityRoot: authority.authorityRoot,
        candidateRepo,
        expectedScopeBaseCommit: authority.scopeBaseCommit,
      }),
    );

    const symlinkedLedger = fixture({ realGit: true });
    const ledgerPath = path.join(
      symlinkedLedger.candidateRepo,
      verifier.LEDGER_RELATIVE_PATH,
    );
    fs.unlinkSync(ledgerPath);
    fs.symlinkSync("../../../README.md", ledgerPath);
    git(symlinkedLedger.candidateRepo, [
      "add",
      verifier.LEDGER_RELATIVE_PATH,
    ]);
    git(symlinkedLedger.candidateRepo, [
      "commit",
      "--quiet",
      "--amend",
      "--no-edit",
    ]);
    symlinkedLedger.environment.GITHUB_SHA = git(
      symlinkedLedger.candidateRepo,
      ["rev-parse", "HEAD"],
    );
    expectCode("GOV_BOOTSTRAP_NOT_LEDGER_ONLY", () =>
      issue(symlinkedLedger),
    );
  });

  test("authority hash, frozen API, and JWKS provenance bindings fail independently", () => {
    const authorityHash = fixture();
    const authorityPath = path.join(
      authorityHash.authorityRoot,
      verifier.AUTHORITY_RELATIVE_PATH,
    );
    const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
    authority.authoritySha256 = digest("substituted authority digest");
    writeJson(authorityPath, authority);
    expectCode("ATTESTATION_AUTHORITY_HASH_MISMATCH", () =>
      issue(authorityHash),
    );

    const frozenApi = fixture();
    frozenApi.runtime.dependencies.validateAttestationBody = null;
    expectCode("FROZEN_API_INVALID", () => issue(frozenApi));

    const jwksBinding = fixture();
    const jwksPath = path.join(
      jwksBinding.authorityRoot,
      verifier.JWKS_RELATIVE_PATH,
    );
    const jwks = JSON.parse(fs.readFileSync(jwksPath, "utf8"));
    jwks.registrySha256 = digest("substituted jwks digest");
    writeJson(jwksPath, jwks);
    expectCode("JWKS_REGISTRY_BINDING_MISMATCH", () =>
      issue(jwksBinding),
    );
  });

  test("phase registry, phase selection, and proof selection fail at their own boundaries", () => {
    const registry = fixture();
    registry.runtime.dependencies.CANONICAL_REGISTRY_SHA256 =
      digest("wrong canonical registry");
    expectCode("PHASE_PROOF_REGISTRY_MISMATCH", () => issue(registry));

    const phaseSelection = fixture();
    phaseSelection.runtime.dependencies.selectActivePhase = () => {
      throw Object.assign(new Error("phase selection failed"), {
        code: "PHASE_SELECTION_FAILED",
      });
    };
    expectCode("CANDIDATE_PHASE_INVALID", () => issue(phaseSelection));

    const proofSelection = fixture();
    proofSelection.runtime.dependencies.phaseProofForId = () => {
      throw Object.assign(new Error("proof selection failed"), {
        code: "PROOF_SELECTION_FAILED",
      });
    };
    expectCode("CANDIDATE_PHASE_PROOF_INVALID", () =>
      issue(proofSelection),
    );
  });

  test("malformed bundle and snapshot structures cannot reach the collector", () => {
    const bundle = fixture();
    bundle.bundle.artifacts = null;
    writeJson(bundle.phaseProofBundlePath, bundle.bundle);
    expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () => issue(bundle));

    const snapshot = fixture();
    snapshot.runtime.dependencies.computeAuthoritySnapshot = () => ({
      schema: "wrong",
    });
    expectCode("AUTHORITY_SNAPSHOT_INVALID", () => issue(snapshot));
  });

  test("every artifact addressing field is enforced by the frozen bundle decoder", () => {
    const base = artifact("artifact branch coverage");
    const cases = [
      ["extra field", (entry) => { entry.extra = true; }],
      ["encoding", (entry) => { entry.encoding = "hex"; }],
      ["digest", (entry) => { entry.sha256 = "bad"; }],
      ["address", (entry) => { entry.address = `sha256:${digest("other")}`; }],
      ["bytes type", (entry) => { entry.bytes = 42; }],
      ["empty bytes", (entry) => { entry.bytes = ""; }],
      ["base64 alphabet", (entry) => { entry.bytes = "%%%="; }],
    ];
    for (const [name, mutate] of cases) {
      const entry = structuredClone(base);
      mutate(entry);
      expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () =>
        verifier.__testOnly.artifactBytesFromBundle({
          artifacts: [entry],
        }),
      );
      assert.ok(name);
    }
    expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () =>
      verifier.__testOnly.artifactBytesFromBundle({ artifacts: null }),
    );
    expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () =>
      verifier.__testOnly.artifactBytesFromBundle({
        artifacts: Array.from({ length: 513 }, () =>
          structuredClone(base)),
      }),
    );

    const noncanonical = structuredClone(base);
    noncanonical.bytes = "AB==";
    const decoded = Buffer.from(noncanonical.bytes, "base64");
    noncanonical.sha256 = digest(decoded);
    noncanonical.address = `sha256:${noncanonical.sha256}`;
    expectCode("PHASE_BUNDLE_ARTIFACT_HASH_MISMATCH", () =>
      verifier.__testOnly.artifactBytesFromBundle({
        artifacts: [noncanonical],
      }),
    );
  });

  test("artifact decoder admits exactly 32 MiB of canonical decoded bytes", () => {
    const entry = zeroArtifact(MAX_PHASE_ARTIFACT_DECODED_BYTES);
    assert.ok(entry.bytes.length <= MAX_PHASE_ARTIFACT_ENCODED_BYTES);
    const artifacts = verifier.__testOnly.artifactBytesFromBundle({
      artifacts: [entry],
    });
    assert.equal(artifacts.size, 1);
    assert.equal(
      artifacts.get(entry.address).length,
      MAX_PHASE_ARTIFACT_DECODED_BYTES,
    );
    assert.equal(
      zeroSha256(artifacts.get(entry.address).length),
      entry.sha256,
    );
  });

  test("one decoded byte above 32 MiB is refused before base64 decode", () => {
    const entry = singleOversizedArtifact();
    assert.ok(entry.bytes.length <= MAX_PHASE_ARTIFACT_ENCODED_BYTES);
    const probe = base64DecodeProbe([entry.bytes]);
    let adopted = null;
    try {
      expectCode("PHASE_BUNDLE_ARTIFACTS_OVERSIZED", () => {
        adopted = verifier.__testOnly.artifactBytesFromBundle({
          artifacts: [entry],
        });
      });
    } finally {
      probe.restore();
    }
    assert.equal(adopted, null);
    assert.equal(probe.calls.length, 0);
  });

  test("cumulative decoded byte above 32 MiB is refused before second decode", () => {
    const entries = cumulativeBoundaryArtifacts();
    const probe = base64DecodeProbe(entries.map((entry) => entry.bytes));
    let adopted = null;
    try {
      expectCode("PHASE_BUNDLE_ARTIFACTS_OVERSIZED", () => {
        adopted = verifier.__testOnly.artifactBytesFromBundle({
          artifacts: entries,
        });
      });
    } finally {
      probe.restore();
    }
    assert.equal(adopted, null);
    assert.equal(probe.calls.length, 1);
  });

  test("huge malformed base64 alphabet is invalid before size or decode", () => {
    const hash = digest("huge malformed base64 alphabet");
    const entry = {
      address: `sha256:${hash}`,
      bytes: `${"A".repeat(MAX_PHASE_ARTIFACT_ENCODED_BYTES - 1)}!`,
      encoding: "base64",
      sha256: hash,
    };
    const probe = base64DecodeProbe([entry.bytes]);
    try {
      expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () =>
        verifier.__testOnly.artifactBytesFromBundle({
          artifacts: [entry],
        }),
      );
    } finally {
      probe.restore();
    }
    assert.equal(probe.calls.length, 0);
  });

  test("huge malformed base64 padding is invalid before size or decode", () => {
    const hash = digest("huge malformed base64 padding");
    const entry = {
      address: `sha256:${hash}`,
      bytes:
        `${"A".repeat(MAX_PHASE_ARTIFACT_ENCODED_BYTES - 2)}=A`,
      encoding: "base64",
      sha256: hash,
    };
    const probe = base64DecodeProbe([entry.bytes]);
    try {
      expectCode("PHASE_BUNDLE_ARTIFACTS_INVALID", () =>
        verifier.__testOnly.artifactBytesFromBundle({
          artifacts: [entry],
        }),
      );
    } finally {
      probe.restore();
    }
    assert.equal(probe.calls.length, 0);
  });

  test("oversized cumulative bundle exposes no partial downstream adoption", () => {
    const value = fixture();
    const entries = cumulativeBoundaryArtifacts();
    value.bundle.artifacts = entries;
    value.qualityReceipt.primaryJudge.rawArtifact.artifactSha256 =
      entries[0].sha256;
    value.qualityReceipt.cleanJudge.rawArtifact.artifactSha256 =
      entries[1].sha256;
    writeJson(value.qualityReceiptPath, value.qualityReceipt);
    writeJson(value.phaseProofBundlePath, value.bundle);
    const probe = base64DecodeProbe(entries.map((entry) => entry.bytes));
    try {
      expectCode("PHASE_BUNDLE_ARTIFACTS_OVERSIZED", () => issue(value));
    } finally {
      probe.restore();
    }
    assert.equal(probe.calls.length, 1);
    assert.equal(value.dependencyCalls.quality, 0);
    assert.equal(value.dependencyCalls.bundle, 0);
    assert.equal(value.dependencyCalls.collector, 0);
    assert.equal(value.dependencyCalls.snapshots.length, 0);
    assert.equal(fs.existsSync(value.runtime.replayRoot), false);
  });

  test("collector evidence encoding refuses every malformed primitive", () => {
    const value = fixture();
    const certification = issue(value);
    for (const [name, mutate] of [
      ["schema", (evidence) => { evidence.schema = "other"; }],
      ["encoding", (evidence) => { evidence.encoding = "hex"; }],
      ["fractional length", (evidence) => { evidence.byteLength = 1.5; }],
      ["empty length", (evidence) => { evidence.byteLength = 0; }],
      ["oversized length", (evidence) => { evidence.byteLength = 65_537; }],
      ["bytes type", (evidence) => { evidence.bytes = 42; }],
      ["base64 alphabet", (evidence) => { evidence.bytes = "***"; }],
    ]) {
      const evidence = structuredClone(certification.collectorEvidence);
      mutate(evidence);
      expectCode("COLLECTOR_EVIDENCE_INVALID", () =>
        verifier.__testOnly.decodeCollectorEvidence(evidence),
      );
      assert.ok(name);
    }
  });

  test("replay protection enforces each exact authority field", () => {
    const value = fixture();
    const certification = issue(value);
    for (const [name, mutate] of [
      ["schema", (replay) => { replay.schema = "other"; }],
      ["scope", (replay) => { replay.consumptionScope = "global"; }],
      ["multi-host", (replay) => { replay.multiHostSafe = true; }],
      ["key type", (replay) => { replay.replayKey = null; }],
      ["key digest", (replay) => {
        replay.replayKeySha256 = digest("wrong replay key");
      }],
    ]) {
      const changed = structuredClone(certification);
      mutate(changed.replayProtection);
      rehashCertification(changed);
      expectCode("REPLAY_PROTECTION_INVALID", () =>
        verifier.__testOnly.validateCertificationShape(changed),
      );
      assert.ok(name);
    }

    const nullPrototype = Object.assign(
      Object.create(null),
      certification,
    );
    assert.doesNotThrow(() =>
      verifier.__testOnly.validateCertificationShape(nullPrototype),
    );
  });

  test("production replay policy refuses directories outside the current home", () => {
    const value = fixture();
    const certification = issue(value);
    const outsideHome = makeTempRoot();
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expectCode("REPLAY_DIRECTORY_INVALID", () =>
        verifier.__testOnly.consumeReplayKey(
          certification,
          outsideHome,
        ),
      );
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test("replay creation refuses unwritable and symlinked home components", (t) => {
    const value = fixture();
    const certification = issue(value);
    const priorNodeEnv = process.env.NODE_ENV;
    const unwritable = fs.mkdtempSync(
      path.join(os.homedir(), ".pikiio-replay-unwritable-"),
    );
    const symlink = path.join(
      os.homedir(),
      `.pikiio-replay-symlink-${crypto.randomUUID()}`,
    );
    const symlinkTarget = makeTempRoot();
    fs.symlinkSync(symlinkTarget, symlink);
    t.after(() => {
      fs.chmodSync(unwritable, 0o700);
      fs.rmSync(unwritable, { recursive: true, force: true });
      try {
        fs.unlinkSync(symlink);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
    process.env.NODE_ENV = "production";
    try {
      fs.chmodSync(unwritable, 0o000);
      expectCode("REPLAY_DIRECTORY_UNAVAILABLE", () =>
        verifier.__testOnly.consumeReplayKey(
          certification,
          path.join(unwritable, "child"),
        ),
      );
      expectCode("REPLAY_DIRECTORY_INVALID", () =>
        verifier.__testOnly.consumeReplayKey(
          certification,
          path.join(symlink, "child"),
        ),
      );
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test("replay marker creation fails closed when its safe directory is read-only", (t) => {
    const value = fixture();
    const certification = issue(value);
    const replayRoot = fs.mkdtempSync(
      path.join(os.homedir(), ".pikiio-replay-readonly-"),
    );
    const priorNodeEnv = process.env.NODE_ENV;
    t.after(() => {
      fs.chmodSync(replayRoot, 0o700);
      fs.rmSync(replayRoot, { recursive: true, force: true });
    });
    fs.chmodSync(replayRoot, 0o500);
    process.env.NODE_ENV = "production";
    try {
      expectCode("REPLAY_CONSUME_FAILED", () =>
        verifier.__testOnly.consumeReplayKey(
          certification,
          replayRoot,
        ),
      );
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test("collector result must bind every proof, run, and replay identity field", () => {
    const value = fixture();
    const original =
      value.runtime.dependencies.validateGithubOidcCollectorReceipt;
    for (const [name, mutate] of [
      ["body", (result) => { result.bodySha256 = digest("wrong body"); }],
      ["candidate", (result) => {
        result.candidateCommit = "f".repeat(40);
      }],
      ["scope base", (result) => {
        result.scopeBaseCommit = "e".repeat(40);
      }],
      ["run", (result) => { result.runId = "999"; }],
      ["attempt", (result) => { result.runAttempt = "999"; }],
      ["replay type", (result) => { result.replayKey = null; }],
      ["replay empty", (result) => { result.replayKey = "x"; }],
      ["replay oversized", (result) => {
        result.replayKey = "x".repeat(513);
      }],
    ]) {
      value.runtime.dependencies.validateGithubOidcCollectorReceipt =
        (input) => {
          const result = original(input);
          mutate(result);
          return result;
        };
      expectCode("GITHUB_COLLECTOR_RESULT_INVALID", () => issue(value));
      assert.ok(name);
    }
    value.runtime.dependencies.validateGithubOidcCollectorReceipt =
      original;
  });

  test("certified run and embedded collector provenance are independently content addressed", () => {
    const run = fixture();
    const runCertification = issue(run);
    runCertification.githubRun.eventName = "bad event";
    rehashCertification(runCertification);
    expectCode("GITHUB_RUN_CONTEXT_INVALID", () =>
      validate(run, runCertification),
    );

    const encoding = fixture();
    const encodingCertification = issue(encoding);
    encodingCertification.collectorEvidence.encoding = "hex";
    rehashCertification(encodingCertification);
    expectCode("COLLECTOR_EVIDENCE_INVALID", () =>
      validate(encoding, encodingCertification),
    );

    const internal = fixture();
    const internalCertification = issue(internal);
    const changedReceipt = Buffer.from(
      `${JSON.stringify({ receiptHash: digest("different receipt") })}\n`,
    );
    internalCertification.collectorEvidence.bytes =
      changedReceipt.toString("base64");
    internalCertification.collectorEvidence.byteLength =
      changedReceipt.length;
    internalCertification.collectorEvidence.rawSha256 =
      digest(changedReceipt);
    rehashCertification(internalCertification);
    expectCode("COLLECTOR_EVIDENCE_HASH_MISMATCH", () =>
      validate(internal, internalCertification),
    );
  });

  test("validation refuses a certified GitHub SHA that no longer names candidate HEAD", () => {
    const value = fixture();
    const certification = issue(value);
    certification.githubRun.githubSha = "f".repeat(40);
    rehashCertification(certification);
    expectCode("GITHUB_RUN_CONTEXT_MISMATCH", () =>
      validate(value, certification),
    );
  });

  test("schema, size, and deterministic reproduction are separate certification gates", () => {
    const schema = fixture();
    const schemaCertification = issue(schema);
    schemaCertification.schema = "other";
    rehashCertification(schemaCertification);
    expectCode("CERTIFICATION_SCHEMA_INVALID", () =>
      verifier.__testOnly.validateCertificationShape(
        schemaCertification,
      ),
    );

    const oversized = fixture();
    const oversizedCertification = issue(oversized);
    oversizedCertification.collectorEvidence.bytes = "A".repeat(300_000);
    rehashCertification(oversizedCertification);
    expectCode("CERTIFICATION_OVERSIZED", () =>
      verifier.__testOnly.validateCertificationShape(
        oversizedCertification,
      ),
    );

    const mismatch = fixture();
    const mismatchCertification = issue(mismatch);
    const originalSnapshot =
      mismatch.runtime.dependencies.computeAuthoritySnapshot;
    mismatch.runtime.dependencies.computeAuthoritySnapshot = (input) => ({
      ...originalSnapshot(input),
      snapshotHash: digest(`changed:${input.commit}`),
    });
    expectCode("CERTIFICATION_CONTENT_MISMATCH", () =>
      validate(mismatch, mismatchCertification),
    );
  });

  test("sanitized Git variables are restored and the home-scoped replay path is durable", (t) => {
    const value = fixture();
    const prior = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_NOSYSTEM = "prior-value";
    try {
      issue(value);
      assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "prior-value");
    } finally {
      if (prior === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prior;
    }

    const replayValue = fixture();
    const certification = issue(replayValue);
    const replayRoot = fs.mkdtempSync(
      path.join(os.homedir(), ".pikiio-frozen-replay-test-"),
    );
    t.after(() => fs.rmSync(replayRoot, { recursive: true, force: true }));
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const consumed = verifier.__testOnly.consumeReplayKey(
        certification,
        replayRoot,
      );
      assert.equal(fs.existsSync(consumed.markerPath), true);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test("public issue and validate wrappers preserve fail-closed input validation", () => {
    const value = fixture();
    const certification = issue(value);
    const input = {
      candidateRepo: "/tmp",
      expectedScopeBaseCommit: "invalid",
      phaseProofBundlePath: "/tmp/bundle.json",
      qualityReceiptPath: "/tmp/quality.json",
      collectorReceiptPath: "/tmp/collector.json",
    };
    expectCode("INVALID_COMMIT", () =>
      verifier.issueFrozenAuthorityCertification(input),
    );
    expectCode("INVALID_COMMIT", () =>
      verifier.validateFrozenAuthorityCertification({
        ...input,
        certification,
      }),
    );
  });
});

describe("decision-free CLI", () => {
  function issueArgv(value) {
    return [
      "node",
      "verify-pikiio-frozen-authority.js",
      "issue",
      "--candidate-repo",
      value.candidateRepo,
      "--collector-receipt",
      value.collectorReceiptPath,
      "--expected-scope-base",
      value.scopeBaseCommit,
      "--phase-proof-bundle",
      value.phaseProofBundlePath,
      "--quality-receipt",
      value.qualityReceiptPath,
    ];
  }

  test("exact issue CLI maps only the five typed inputs", () => {
    const value = fixture();
    const parsed = cli.parseExactArguments(issueArgv(value));
    let observed;
    const result = cli.execute(parsed, {
      issue(input) {
        observed = input;
        return { ok: true };
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(observed, value.input);
  });

  test("exact validate CLI reads a bounded certification", () => {
    const value = fixture();
    const certification = issue(value);
    const certificationPath = path.join(value.root, "certification.json");
    writeJson(certificationPath, certification);
    const argv = [
      "node",
      "verify-pikiio-frozen-authority.js",
      "validate",
      "--candidate-repo",
      value.candidateRepo,
      "--certification",
      certificationPath,
      "--expected-scope-base",
      value.scopeBaseCommit,
      "--phase-proof-bundle",
      value.phaseProofBundlePath,
      "--quality-receipt",
      value.qualityReceiptPath,
    ];
    const parsed = cli.parseExactArguments(argv);
    let observed;
    cli.execute(parsed, {
      validate(input) {
        observed = input;
        return { valid: true };
      },
    });
    assert.equal(observed.certification.certificationHash, certification.certificationHash);
    assert.equal(observed.collectorReceiptPath, undefined);
  });

  for (const [name, mutate] of [
    ["unknown command", (argv) => { argv[2] = "sign"; }],
    ["missing flag", (argv) => { argv.splice(3, 2); }],
    ["duplicate flag", (argv) => { argv[5] = "--candidate-repo"; }],
    ["unknown flag", (argv) => { argv[3] = "--anything"; }],
    ["empty value", (argv) => { argv[4] = ""; }],
    ["extra argument", (argv) => { argv.push("--extra"); }],
  ]) {
    test(`CLI rejects ${name}`, () => {
      const value = fixture();
      const argv = issueArgv(value);
      mutate(argv);
      assert.throws(() => cli.parseExactArguments(argv));
    });
  }

  test("main emits exactly one canonical JSON line", () => {
    const value = fixture();
    let output = "";
    cli.main({
      argv: issueArgv(value),
      stdout: { write(chunk) { output += chunk; } },
      implementations: { issue: () => ({ z: 2, a: 1 }) },
    });
    assert.equal(output, '{"a":1,"z":2}\n');
  });

  test("failure output is bounded and hides unexpected internals", () => {
    assert.equal(
      cli.boundedFailure(
        new verifier.FrozenAuthorityError("REFUSED", "safe refusal"),
      ),
      '{"code":"REFUSED","error":"safe refusal","ok":false}',
    );
    assert.equal(
      cli.boundedFailure(new Error("secret stack detail")),
      '{"code":"FROZEN_AUTHORITY_INTERNAL_FAILURE","error":"Frozen authority verification failed closed","ok":false}',
    );
  });

  test("runCli sets failure status without throwing", () => {
    const prior = process.exitCode;
    let output = "";
    process.exitCode = undefined;
    try {
      cli.runCli({
        mainImpl() {
          throw new verifier.FrozenAuthorityError("STOP", "refused");
        },
        stderr: { write(chunk) { output += chunk; } },
      });
      assert.equal(process.exitCode, 1);
      assert.equal(output, '{"code":"STOP","error":"refused","ok":false}\n');
    } finally {
      process.exitCode = prior;
    }
  });

  test("certification reader bounds unexpected canonicalization failures", () => {
    const value = fixture();
    const certification = issue(value);
    certification.attestationBody = "__DEEPLY_NESTED_BODY__";
    const depth = 20_000;
    const source = JSON.stringify(certification).replace(
      '"__DEEPLY_NESTED_BODY__"',
      `${'{"x":'.repeat(depth)}0${"}".repeat(depth)}`,
    );
    const certificationPath = path.join(
      value.root,
      "deep-certification.json",
    );
    fs.writeFileSync(certificationPath, source);
    assert.throws(
      () => cli.readCertification(certificationPath),
      (error) => {
        assert.equal(error.code, "CERTIFICATION_JSON_INVALID");
        assert.equal(
          error.message,
          "Certification file is not valid bounded UTF-8 JSON",
        );
        assert.doesNotMatch(error.message, /call stack|canonical/i);
        return true;
      },
    );
  });

  test("CLI module entrypoint executes its bounded failure contract", () => {
    const priorArgv = process.argv;
    const priorExitCode = process.exitCode;
    const priorWrite = process.stderr.write;
    const priorMainModule = process.mainModule;
    const cached = require.cache[CLI_PATH];
    let output = "";
    process.argv = [process.execPath, CLI_PATH, "issue"];
    process.exitCode = undefined;
    process.stderr.write = (chunk) => {
      output += String(chunk);
      return true;
    };
    delete require.cache[CLI_PATH];
    try {
      Module._load(CLI_PATH, null, true);
      assert.equal(process.exitCode, 1);
      assert.match(output, /"code":"CLI_ARGUMENTS_INVALID"/);
    } finally {
      process.argv = priorArgv;
      process.exitCode = priorExitCode;
      process.stderr.write = priorWrite;
      process.mainModule = priorMainModule;
      delete require.cache[CLI_PATH];
      if (cached) require.cache[CLI_PATH] = cached;
    }
  });
});

const GHERKIN_SCENARIOS = [
  ["Frozen authority differs from scope base", (v) => {
    v.runtime.verifyGit = verifier.__testOnly.verifyFrozenAndCandidateGit;
    v.input.expectedScopeBaseCommit = "f".repeat(40);
  }, "FROZEN_AUTHORITY_HEAD_MISMATCH"],
  ["Candidate contains two commits", (v) => {
    v.runtime.verifyGit = verifier.__testOnly.verifyFrozenAndCandidateGit;
    git(v.candidateRepo, ["commit", "--quiet", "--allow-empty", "-m", "extra"]);
  }, "CANDIDATE_PARENT_INVALID"],
  ["Candidate changes a judge", (v) => {
    v.runtime.verifyGit = verifier.__testOnly.verifyFrozenAndCandidateGit;
    amendCandidate(v, "lib/judge.js", "module.exports = false;\n");
  }, "GOV_BOOTSTRAP_NOT_LEDGER_ONLY"],
  ["Candidate has untracked code", (v) => {
    v.runtime.verifyGit = verifier.__testOnly.verifyFrozenAndCandidateGit;
    fs.writeFileSync(path.join(v.candidateRepo, "untracked.js"), "bad\n");
  }, "DIRTY_CHECKOUT"],
  ["Quality receipt is red", (v) => {
    v.runtime.dependencies.validateQualityReceipt = () => ({ valid: false, errors: ["red"] });
  }, "STRICT_QUALITY_RECEIPT_INVALID"],
  ["Proof bundle is red", (v) => {
    v.runtime.dependencies.validatePhaseProofBundle = () => ({ valid: false, errors: ["red"] });
  }, "PHASE_PROOF_BUNDLE_INVALID"],
  ["Judge artifact is forged", (v) => {
    v.bundle.artifacts[0].bytes = Buffer.from("forged").toString("base64");
    writeJson(v.phaseProofBundlePath, v.bundle);
  }, "PHASE_BUNDLE_ARTIFACT_HASH_MISMATCH"],
  ["Authority snapshots diverge", (v) => {
    const original = v.runtime.dependencies.computeAuthoritySnapshot;
    v.runtime.dependencies.computeAuthoritySnapshot = (input) => {
      const result = original(input);
      if (input.repoRoot === v.candidateRepo) result.authoritySetSha256 = digest("bad");
      return result;
    };
  }, "AUTHORITY_SNAPSHOT_DIVERGENCE"],
  ["GitHub repository is substituted", (v) => {
    v.environment.GITHUB_REPOSITORY = "evil/repo";
  }, "GITHUB_AUTHORITY_CONTEXT_MISMATCH"],
  ["GitHub run is substituted", (v) => {
    v.environment.GITHUB_RUN_ID = "01";
  }, "GITHUB_RUN_CONTEXT_INVALID"],
  ["Collector signature is invalid", (v) => {
    v.runtime.dependencies.validateGithubOidcCollectorReceipt = () => {
      throw Object.assign(new Error("bad signature"), { code: "BAD_SIGNATURE" });
    };
  }, "GITHUB_COLLECTOR_RECEIPT_INVALID"],
  ["Collector result is unbound", (v) => {
    v.runtime.dependencies.validateGithubOidcCollectorReceipt = () => ({ valid: false });
  }, "GITHUB_COLLECTOR_RESULT_INVALID"],
  ["Replay key is reused", (v) => {
    issue(v);
  }, "REPLAY_ALREADY_CONSUMED"],
  ["Certification is changed", (v) => {
    const c = issue(v);
    c.phaseId = "ACTION-01";
    v.gherkinCertification = c;
  }, "CERTIFICATION_HASH_MISMATCH"],
  ["Historical verification replays without consuming", (v) => {
    v.gherkinCertification = issue(v);
    validate(v, v.gherkinCertification);
  }, null],
];

for (const [name, arrange, expectedCode] of GHERKIN_SCENARIOS) {
  test(`Gherkin: ${name}`, () => {
    const value = fixture();
    arrange(value);
    if (name === "Certification is changed") {
      expectCode(expectedCode, () =>
        validate(value, value.gherkinCertification),
      );
    } else if (expectedCode) {
      expectCode(expectedCode, () => issue(value));
    } else {
      assert.equal(validate(value, value.gherkinCertification).valid, true);
    }
  });
}

function loadMutant(replacements) {
  let source = fs.readFileSync(LIBRARY_PATH, "utf8");
  for (const [find, replacement] of replacements) {
    const count = source.split(find).length - 1;
    assert.equal(count, 1, `mutation target must be unique: ${find}`);
    source = source.replace(find, replacement);
  }
  const mutantFilename =
    `${LIBRARY_PATH}?mutant=${digest(source).slice(0, 16)}`;
  const mutant = new Module(mutantFilename, module);
  mutant.filename = mutantFilename;
  mutant.paths = Module._nodeModulePaths(path.dirname(LIBRARY_PATH));
  mutant._compile(source, mutantFilename);
  return mutant.exports;
}

const CRITICAL_MUTANTS = [
  {
    name: "dirty checkout accepted",
    replacements: [["if (status.length !== 0) {", "if (false) {"]],
    probe(mutant, value) {
      value.runtime.verifyGit = mutant.__testOnly.verifyFrozenAndCandidateGit;
      fs.writeFileSync(path.join(value.candidateRepo, "hostile.js"), "bad\n");
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "non-ledger candidate accepted",
    replacements: [[
      "if (\n    changed.length !== exactLedgerChange.length ||\n    !changed.equals(exactLedgerChange)\n  ) {",
      "if (false) {",
    ]],
    probe(mutant, value) {
      value.runtime.verifyGit = mutant.__testOnly.verifyFrozenAndCandidateGit;
      amendCandidate(value, "lib/hostile.js", "module.exports = true;\n");
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "extra candidate commit accepted",
    replacements: [[
      "if (\n    parents.length !== 2 ||\n    parents[0] !== candidateHead ||\n    parents[1] !== rootHead\n  ) {",
      "if (false) {",
    ]],
    probe(mutant, value) {
      value.runtime.verifyGit = mutant.__testOnly.verifyFrozenAndCandidateGit;
      git(value.candidateRepo, ["commit", "--quiet", "--allow-empty", "-m", "extra"]);
      value.candidateCommit = git(value.candidateRepo, ["rev-parse", "HEAD"]);
      value.candidateTree = git(value.candidateRepo, ["rev-parse", "HEAD^{tree}"]);
      value._candidateState.candidateCommit = value.candidateCommit;
      value._candidateState.candidateTree = value.candidateTree;
      value.environment.GITHUB_SHA = value.candidateCommit;
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "snapshot divergence accepted",
    replacements: [[
      "baseline.authoritySetSha256 !== candidate.authoritySetSha256",
      "false",
    ]],
    probe(mutant, value) {
      const original = value.runtime.dependencies.computeAuthoritySnapshot;
      value.runtime.dependencies.computeAuthoritySnapshot = (input) => {
        const result = original(input);
        if (input.repoRoot === value.candidateRepo) {
          result.authoritySetSha256 = digest("mutated set");
        }
        return result;
      };
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "invalid verifier report accepted",
    replacements: [["if (!report?.valid) {", "if (false) {"]],
    probe(mutant, value) {
      value.runtime.dependencies.validateQualityReceipt = () => ({
        valid: false,
        errors: ["red"],
      });
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "artifact ordering accepted",
    replacements: [["artifact.address <= previous", "false"]],
    probe(mutant, value) {
      value.bundle.artifacts.reverse();
      writeJson(value.phaseProofBundlePath, value.bundle);
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "decoded artifact boundary removed",
    replacements: [[
      "if (decodedLength > MAX_PHASE_ARTIFACT_DECODED_BYTES - total) {",
      "if (false) {",
    ]],
    probe(mutant) {
      return () =>
        mutant.__testOnly.artifactBytesFromBundle({
          artifacts: [singleOversizedArtifact()],
        });
    },
  },
  {
    name: "artifact hash substitution accepted",
    replacements: [["sha256(bytes) !== artifact.sha256", "false"]],
    probe(mutant, value) {
      value.bundle.artifacts[0].bytes =
        Buffer.from("substituted").toString("base64");
      writeJson(value.phaseProofBundlePath, value.bundle);
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "certification hash substitution accepted",
    replacements: [[
      "hashWithoutField(certification, \"certificationHash\") !==\n      certification.certificationHash",
      "false",
    ]],
    probe(mutant, value) {
      const certification = issue(value);
      certification.certificationHash = "0".repeat(64);
      return () => mutant.__testOnly.validateCertificationShape(certification);
    },
  },
  {
    name: "unexpected certification fields accepted",
    replacements: [[
      "Object.keys(value).length === expected.length &&",
      "true &&",
    ]],
    probe(mutant, value) {
      const certification = issue(value);
      certification.extra = true;
      certification.certificationHash = digest(
        verifier.stableJson(
          Object.fromEntries(
            Object.entries(certification).filter(
              ([key]) => key !== "certificationHash",
            ),
          ),
        ),
      );
      return () => mutant.__testOnly.validateCertificationShape(certification);
    },
  },
  {
    name: "GitHub authority context accepted",
    replacements: [[
      "requiredGithubEnvironment(environment, \"GITHUB_ACTIONS\") !== \"true\" ||\n    requiredGithubEnvironment(environment, \"GITHUB_REPOSITORY\") !==\n      githubCollector.EXPECTED_REPOSITORY ||\n    requiredGithubEnvironment(environment, \"RUNNER_ENVIRONMENT\") !==\n      githubCollector.EXPECTED_RUNNER_ENVIRONMENT ||\n    requiredGithubEnvironment(\n      environment,\n      \"GITHUB_SHA\",\n      COMMIT_PATTERN,\n    ) !== candidateCommit",
      "false",
    ]],
    probe(mutant, value) {
      value.environment.GITHUB_REPOSITORY = "attacker/repo";
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "collector result binding accepted",
    replacements: [[
      "collectorResult?.valid !== true ||",
      "false ||",
    ], [
      "collectorResult.bodySha256 !== bodyReport.bodySha256 ||",
      "false ||",
    ], [
      "collectorResult.candidateCommit !== gitState.candidateHead ||",
      "false ||",
    ], [
      "collectorResult.scopeBaseCommit !== gitState.rootHead ||",
      "false ||",
    ], [
      "collectorResult.runId !== githubRun.runId ||",
      "false ||",
    ], [
      "collectorResult.runAttempt !== githubRun.runAttempt ||",
      "false ||",
    ]],
    probe(mutant, value) {
      const original =
        value.runtime.dependencies.validateGithubOidcCollectorReceipt;
      value.runtime.dependencies.validateGithubOidcCollectorReceipt = (input) => ({
        ...original(input),
        valid: false,
        bodySha256: digest("wrong body"),
        candidateCommit: "f".repeat(40),
        scopeBaseCommit: "e".repeat(40),
        runId: "999",
        runAttempt: "999",
      });
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
  {
    name: "replay marker exclusivity removed",
    replacements: [["fs.constants.O_EXCL |", "0 |"]],
    probe(mutant, value) {
      mutant.__testOnly.issue(value.input, value.runtime);
      return () => mutant.__testOnly.issue(value.input, value.runtime);
    },
  },
];

for (const mutation of CRITICAL_MUTANTS) {
  test(`Mutation killed: ${mutation.name}`, () => {
    const mutant = loadMutant(mutation.replacements);
    const value = fixture();
    const operation = mutation.probe(mutant, value);
    assert.doesNotThrow(operation);
  });
}

test("mutation population is non-trivial and all named controls are unique", () => {
  assert.ok(CRITICAL_MUTANTS.length >= 12);
  assert.equal(
    new Set(CRITICAL_MUTANTS.map((mutation) => mutation.name)).size,
    CRITICAL_MUTANTS.length,
  );
  assert.equal(GHERKIN_SCENARIOS.length, 15);
});

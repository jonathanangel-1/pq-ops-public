"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const governance = require("./pikiio-agent-governance");
const phaseProof = require("./pikiio-phase-proof");
const phaseAttestation = require("./pikiio-phase-attestation");
const githubCollector = require("./pikiio-github-oidc-collector");

const ROOT = path.resolve(__dirname, "..");
const GIT = "/usr/bin/git";
const LEDGER_RELATIVE_PATH =
  "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json";
const AUTHORITY_RELATIVE_PATH =
  "YLYI/00_Product_Contract/Pikiio_Phase_Attestation_Authority.json";
const JWKS_RELATIVE_PATH =
  "YLYI/00_Product_Contract/Pikiio_GitHub_OIDC_JWKS.json";
const DEFAULT_REPLAY_ROOT = path.join(
  os.homedir(),
  ".codex",
  "runtime",
  "pikiio-agent",
  "frozen-authority-replay-v1",
);

const CERTIFICATION_SCHEMA =
  "pikiio-frozen-authority-verification-receipt-v1";
const REPLAY_MARKER_SCHEMA = "pikiio-frozen-authority-replay-marker-v1";
const GITHUB_RUN_SCHEMA = "pikiio-github-run-context-v1";
const REPLAY_PROTECTION_SCHEMA =
  "pikiio-frozen-authority-replay-protection-v1";
const COLLECTOR_EVIDENCE_SCHEMA =
  "pikiio-embedded-github-oidc-collector-receipt-v1";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGIT_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_QUALITY_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_PHASE_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTOR_RECEIPT_BYTES = 64 * 1024;
const MAX_CERTIFICATION_BYTES = 256 * 1024;
const MAX_GIT_OUTPUT_BYTES = 72 * 1024 * 1024;
const MAX_PHASE_ARTIFACT_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_PHASE_ARTIFACT_ENCODED_BYTES = 45 * 1024 * 1024;

const CERTIFICATION_KEYS = Object.freeze([
  "schema",
  "phaseId",
  "scopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "ledgerRevision",
  "ledgerSha256",
  "phaseProofRegistrySha256",
  "attestationAuthoritySha256",
  "jwksRegistrySha256",
  "baselineAuthoritySnapshotHash",
  "candidateAuthoritySnapshotHash",
  "authoritySetSha256",
  "strictQualityReceiptHash",
  "phaseProofBundleHash",
  "receiptHashes",
  "attestationBody",
  "attestationBodySha256",
  "githubRun",
  "collectorEvidence",
  "replayProtection",
  "verifiedAt",
  "certificationHash",
]);

class FrozenAuthorityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FrozenAuthorityError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new FrozenAuthorityError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function requireExactKeys(value, expected, label) {
  if (!exactKeys(value, expected)) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_SHA256", `${label} must be a lowercase SHA-256 digest`);
  }
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    fail("INVALID_COMMIT", `${label} must be a full lowercase commit SHA`);
  }
}

function stableJson(value) {
  return phaseAttestation.stableJson(value);
}

function sha256(value) {
  return phaseAttestation.sha256(value);
}

function hashWithoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function boundedUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("INVALID_UTF8", `${label} is not valid UTF-8`, {
      cause: error.message,
    });
  }
}

function canonicalAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    fail("INVALID_ABSOLUTE_PATH", `${label} must be an exact absolute path`);
  }
  return value;
}

function ensureDirectory(directory, label) {
  canonicalAbsolutePath(directory, label);
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    fail("DIRECTORY_UNREADABLE", `${label} is unavailable`, {
      cause: error.code || error.message,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("DIRECTORY_INVALID", `${label} must be a real directory`);
  }
  let real;
  try {
    real = fs.realpathSync(directory);
  } catch (error) {
    fail("DIRECTORY_UNREADABLE", `${label} cannot be resolved`, {
      cause: error.code || error.message,
    });
  }
  if (real !== directory) {
    fail("DIRECTORY_ALIAS_REFUSED", `${label} cannot use a symlinked path`);
  }
  return directory;
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedRegularFile(filePath, { label, maximumBytes }) {
  canonicalAbsolutePath(filePath, label);
  const parent = path.dirname(filePath);
  ensureDirectory(parent, `${label} parent`);
  let before;
  let descriptor = null;
  try {
    before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      fail(
        "FILE_INVALID",
        `${label} must be a bounded non-symlink regular file`,
      );
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) {
      fail("FILE_CHANGED", `${label} changed while it was opened`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !sameStat(opened, after) ||
      bytes.length !== Number(opened.size)
    ) {
      fail("FILE_CHANGED", `${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof FrozenAuthorityError) throw error;
    fail("FILE_UNREADABLE", `${label} cannot be read safely`, {
      cause: error.code || error.message,
    });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function parseJsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(boundedUtf8(bytes, label));
  } catch (error) {
    if (error instanceof FrozenAuthorityError) throw error;
    fail("INVALID_JSON", `${label} is not valid JSON`, {
      cause: error.message,
    });
  }
  if (!isPlainObject(value)) {
    fail("INVALID_JSON_OBJECT", `${label} must contain one JSON object`);
  }
  return value;
}

function readBoundedJson(filePath, options) {
  const bytes = readBoundedRegularFile(filePath, options);
  return {
    bytes,
    value: parseJsonBytes(bytes, options.label),
  };
}

function gitEnvironment() {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function git(repoRoot, args, { maximumBytes = MAX_GIT_OUTPUT_BYTES } = {}) {
  ensureDirectory(repoRoot, "Git repository");
  const result = spawnSync(
    GIT,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "diff.external=",
      "-c",
      "protocol.file.allow=never",
      ...args,
    ],
    {
      cwd: repoRoot,
      env: gitEnvironment(),
      encoding: null,
      timeout: 20 * 1000,
      maxBuffer: maximumBytes,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    result.error ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > maximumBytes
  ) {
    fail("GIT_COMMAND_REFUSED", "A bounded local Git inspection failed", {
      operation: args[0] || "",
      status: result.status,
      signal: result.signal,
      cause: result.error?.code || null,
      stderr: Buffer.isBuffer(result.stderr)
        ? result.stderr.subarray(0, 1024).toString("utf8").trim()
        : "",
    });
  }
  return result.stdout;
}

function gitText(repoRoot, args, options) {
  return boundedUtf8(git(repoRoot, args, options), "Git output").trim();
}

function requireCleanRepository(repoRoot, label) {
  const status = git(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.length !== 0) {
    fail("DIRTY_CHECKOUT", `${label} must be completely clean`, {
      statusSha256: sha256(status),
      statusBytes: status.length,
    });
  }
}

function readCommitBlob(repoRoot, commit, relativePath, maximumBytes) {
  requireCommit(commit, "blob commit");
  const object = `${commit}:${relativePath}`;
  const sizeText = gitText(repoRoot, ["cat-file", "-s", object], {
    maximumBytes: 128,
  });
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(sizeText)) {
    fail("GIT_BLOB_SIZE_INVALID", "Git blob size is invalid");
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 2 || size > maximumBytes) {
    fail("GIT_BLOB_SIZE_INVALID", "Git blob exceeds its exact size bound", {
      size,
      maximumBytes,
    });
  }
  const bytes = git(repoRoot, ["cat-file", "blob", object], {
    maximumBytes,
  });
  if (bytes.length !== size) {
    fail("GIT_BLOB_CHANGED", "Git blob length does not match its object header");
  }
  return bytes;
}

function verifyFrozenAndCandidateGit({
  authorityRoot,
  candidateRepo,
  expectedScopeBaseCommit,
}) {
  ensureDirectory(authorityRoot, "frozen authority root");
  ensureDirectory(candidateRepo, "candidate repository");
  if (authorityRoot === candidateRepo) {
    fail(
      "CHECKOUT_SEPARATION_REQUIRED",
      "Frozen authority and candidate must be separate checkouts",
    );
  }
  requireCleanRepository(authorityRoot, "Frozen authority checkout");
  requireCleanRepository(candidateRepo, "Candidate checkout");

  const rootHead = gitText(authorityRoot, ["rev-parse", "--verify", "HEAD"]);
  requireCommit(rootHead, "frozen authority HEAD");
  if (rootHead !== expectedScopeBaseCommit) {
    fail(
      "FROZEN_AUTHORITY_HEAD_MISMATCH",
      "Frozen authority HEAD is not the expected scope base",
      { expectedScopeBaseCommit, rootHead },
    );
  }

  const candidateHead = gitText(candidateRepo, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  requireCommit(candidateHead, "candidate HEAD");
  if (candidateHead === rootHead) {
    fail(
      "CANDIDATE_ADVANCE_REQUIRED",
      "Candidate must be one ledger-only commit after the scope base",
    );
  }
  const parents = gitText(candidateRepo, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    candidateHead,
  ]).split(" ");
  if (
    parents.length !== 2 ||
    parents[0] !== candidateHead ||
    parents[1] !== rootHead
  ) {
    fail(
      "CANDIDATE_PARENT_INVALID",
      "GOV bootstrap candidate must have exactly the scope base as its one parent",
      { parents },
    );
  }
  const changed = git(candidateRepo, [
    "diff-tree",
    "--no-commit-id",
    "--no-renames",
    "--name-status",
    "-r",
    "-z",
    rootHead,
    candidateHead,
    "--",
  ]);
  const exactLedgerChange = Buffer.from(`M\0${LEDGER_RELATIVE_PATH}\0`, "utf8");
  if (
    changed.length !== exactLedgerChange.length ||
    !changed.equals(exactLedgerChange)
  ) {
    fail(
      "GOV_BOOTSTRAP_NOT_LEDGER_ONLY",
      "GOV bootstrap certification permits exactly one modified ledger blob",
      { changedSha256: sha256(changed), changedBytes: changed.length },
    );
  }
  const ledgerEntry = gitText(candidateRepo, [
    "ls-tree",
    candidateHead,
    "--",
    LEDGER_RELATIVE_PATH,
  ]);
  if (
    !/^100(?:644|755) blob [a-f0-9]{40}\tYLYI\/00_Product_Contract\/Pikiio_Agent_Phases\.json$/.test(
      ledgerEntry,
    )
  ) {
    fail(
      "CANDIDATE_LEDGER_BLOB_INVALID",
      "Candidate ledger must be one ordinary Git blob",
    );
  }
  const candidateTree = gitText(candidateRepo, [
    "rev-parse",
    "--verify",
    `${candidateHead}^{tree}`,
  ]);
  requireCommit(candidateTree, "candidate tree");
  return { rootHead, candidateHead, candidateTree };
}

function validateAuthorityRegistry(authority, registry, dependencies) {
  requireExactKeys(
    authority,
    [
      "schema",
      "revision",
      "mode",
      "bodySchema",
      "controller",
      "collector",
      "authoritySha256",
    ],
    "attestation authority registry",
  );
  requireExactKeys(
    authority.controller,
    [
      "kind",
      "cryptographicSignature",
      "localCollectorPrivateKeyAllowed",
    ],
    "attestation authority controller",
  );
  requireExactKeys(
    authority.collector,
    [
      "kind",
      "issuer",
      "repository",
      "repositoryVisibility",
      "runnerEnvironment",
      "workflowPath",
      "workflowRef",
      "jwksRegistryPath",
      "jwksRegistrySha256",
    ],
    "attestation authority collector",
  );
  if (
    authority.schema !==
      "pikiio-phase-attestation-authority-registry-v1" ||
    authority.revision !== 1 ||
    authority.mode !== "external_collector_required" ||
    authority.bodySchema !== phaseAttestation.ATTESTATION_BODY_SCHEMA ||
    authority.controller.kind !== "local_content_addressed_evidence" ||
    authority.controller.cryptographicSignature !==
      "optional_non_authorizing" ||
    authority.controller.localCollectorPrivateKeyAllowed !== false ||
    authority.collector.kind !== "github_actions_oidc" ||
    authority.collector.issuer !== githubCollector.GITHUB_OIDC_ISSUER ||
    authority.collector.repository !== githubCollector.EXPECTED_REPOSITORY ||
    authority.collector.repositoryVisibility !==
      githubCollector.EXPECTED_REPOSITORY_VISIBILITY ||
    authority.collector.runnerEnvironment !==
      githubCollector.EXPECTED_RUNNER_ENVIRONMENT ||
    authority.collector.workflowPath !==
      githubCollector.REUSABLE_WORKFLOW_PATH ||
    authority.collector.workflowRef !==
      githubCollector.REUSABLE_WORKFLOW_REF ||
    authority.collector.jwksRegistryPath !== JWKS_RELATIVE_PATH
  ) {
    fail(
      "ATTESTATION_AUTHORITY_INVALID",
      "Frozen attestation authority contract is invalid",
    );
  }
  requireSha256(authority.authoritySha256, "authoritySha256");
  requireSha256(
    authority.collector.jwksRegistrySha256,
    "authority collector JWKS digest",
  );
  if (
    hashWithoutField(authority, "authoritySha256") !==
      authority.authoritySha256 ||
    registry.attestationAuthority?.path !== AUTHORITY_RELATIVE_PATH ||
    registry.attestationAuthority?.sha256 !== authority.authoritySha256
  ) {
    fail(
      "ATTESTATION_AUTHORITY_HASH_MISMATCH",
      "Frozen authority bytes are not pinned by the phase proof registry",
    );
  }
  if (typeof dependencies.validateAttestationBody !== "function") {
    fail("FROZEN_API_INVALID", "Attestation body validator is unavailable");
  }
}

function validateJwksRegistry(jwks, authority, registry, dependencies) {
  if (
    registry.githubOidcJwks?.path !== JWKS_RELATIVE_PATH ||
    registry.githubOidcJwks?.sha256 !== jwks.registrySha256 ||
    authority.collector.jwksRegistrySha256 !== jwks.registrySha256
  ) {
    fail(
      "JWKS_REGISTRY_BINDING_MISMATCH",
      "Pinned authority, proof registry, and JWKS registry diverge",
    );
  }
  try {
    dependencies.validatePinnedJwksRegistry(jwks, {
      expectedRegistrySha256: registry.githubOidcJwks.sha256,
    });
  } catch (error) {
    fail("JWKS_REGISTRY_INVALID", "Frozen GitHub JWKS registry is invalid", {
      cause: error.code || error.message,
    });
  }
}

function canonicalBase64DecodedLength(encoded) {
  /*
   * This pass is deliberately structural and linear. Terminal unused-bit
   * canonicality remains enforced by the decode/re-encode equality below so
   * its established HASH_MISMATCH classification does not change.
   */
  const encodedLength = encoded.length;
  if (encodedLength === 0 || encodedLength % 4 !== 0) return null;

  let padding = 0;
  if (encoded.charCodeAt(encodedLength - 1) === 0x3d) {
    padding = 1;
    if (encoded.charCodeAt(encodedLength - 2) === 0x3d) padding = 2;
  }
  const alphabetLength = encodedLength - padding;
  for (let index = 0; index < alphabetLength; index += 1) {
    const code = encoded.charCodeAt(index);
    if (
      !(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2b ||
        code === 0x2f
      )
    ) {
      return null;
    }
  }
  for (let index = alphabetLength; index < encodedLength; index += 1) {
    if (encoded.charCodeAt(index) !== 0x3d) return null;
  }

  const quartets = encodedLength / 4;
  if (quartets > Math.floor(Number.MAX_SAFE_INTEGER / 3)) {
    return Number.POSITIVE_INFINITY;
  }
  const decodedLength = quartets * 3 - padding;
  return Number.isSafeInteger(decodedLength) && decodedLength >= 1
    ? decodedLength
    : null;
}

function artifactBytesFromBundle(bundle) {
  if (!Array.isArray(bundle?.artifacts) || bundle.artifacts.length > 512) {
    fail("PHASE_BUNDLE_ARTIFACTS_INVALID", "Phase bundle artifacts are invalid");
  }
  const artifacts = new Map();
  let total = 0;
  let previous = "";
  for (const artifact of bundle.artifacts) {
    if (
      !exactKeys(artifact, ["address", "bytes", "encoding", "sha256"]) ||
      artifact.encoding !== "base64" ||
      !SHA256_PATTERN.test(String(artifact.sha256 || "")) ||
      artifact.address !== `sha256:${artifact.sha256}` ||
      typeof artifact.bytes !== "string" ||
      artifact.bytes.length === 0 ||
      artifact.bytes.length > MAX_PHASE_ARTIFACT_ENCODED_BYTES ||
      artifact.address <= previous
    ) {
      fail(
        "PHASE_BUNDLE_ARTIFACTS_INVALID",
        "Phase bundle artifact addressing is invalid",
      );
    }
    const decodedLength = canonicalBase64DecodedLength(artifact.bytes);
    if (decodedLength === null) {
      fail(
        "PHASE_BUNDLE_ARTIFACTS_INVALID",
        "Phase bundle artifact addressing is invalid",
      );
    }
    if (decodedLength > MAX_PHASE_ARTIFACT_DECODED_BYTES - total) {
      fail(
        "PHASE_BUNDLE_ARTIFACTS_OVERSIZED",
        "Phase bundle decoded artifacts exceed 32 MiB",
      );
    }
    const bytes = Buffer.from(artifact.bytes, "base64");
    if (
      bytes.length !== decodedLength ||
      bytes.toString("base64") !== artifact.bytes ||
      sha256(bytes) !== artifact.sha256 ||
      artifacts.has(artifact.address)
    ) {
      fail(
        "PHASE_BUNDLE_ARTIFACT_HASH_MISMATCH",
        "Phase bundle artifact bytes do not match their content address",
      );
    }
    total += decodedLength;
    previous = artifact.address;
    artifacts.set(artifact.address, bytes);
  }
  return artifacts;
}

function validateActiveGovPhase(
  ledger,
  expectedScopeBaseCommit,
  registry,
  dependencies,
) {
  const validation = dependencies.validatePhaseLedger(ledger);
  if (!validation?.valid) {
    fail("CANDIDATE_LEDGER_INVALID", "Candidate phase ledger is invalid", {
      errors: validation?.errors || [],
    });
  }
  let phase;
  try {
    phase = dependencies.selectActivePhase(ledger);
  } catch (error) {
    fail("CANDIDATE_PHASE_INVALID", "Candidate active phase cannot be selected", {
      cause: error.code || error.message,
    });
  }
  let proofPhase;
  try {
    proofPhase = dependencies.phaseProofForId(registry, phase?.id);
  } catch (error) {
    fail(
      "CANDIDATE_PHASE_PROOF_INVALID",
      "Candidate phase has no frozen proof authority",
      { cause: error.code || error.message },
    );
  }
  if (
    phase?.id !== "GOV-00" ||
    ledger.activePhaseId !== "GOV-00" ||
    phase.scopeBaseCommit !== expectedScopeBaseCommit ||
    proofPhase?.receiptPolicy?.authorityBaseline !== "scope_base"
  ) {
    fail(
      "GOV_BOOTSTRAP_PHASE_INVALID",
      "Frozen bootstrap certification is restricted to scope-base GOV-00",
    );
  }
  return phase;
}

function requireValidReport(report, code, message) {
  if (!report?.valid) {
    fail(code, message, { errors: report?.errors || [] });
  }
}

function qualityRawHashes(qualityReceipt, artifacts) {
  const primary =
    qualityReceipt?.primaryJudge?.rawArtifact?.artifactSha256;
  const independent =
    qualityReceipt?.cleanJudge?.rawArtifact?.artifactSha256;
  requireSha256(primary, "primary raw artifact hash");
  requireSha256(independent, "independent raw artifact hash");
  if (
    primary === independent ||
    !artifacts.has(`sha256:${primary}`) ||
    !artifacts.has(`sha256:${independent}`)
  ) {
    fail(
      "QUALITY_RAW_ARTIFACT_BINDING_INVALID",
      "Distinct primary and independent raw judge bytes are required",
    );
  }
  return { primary, independent };
}

function receiptHashesFromBundle(bundle) {
  const hashes = {};
  for (const role of ["candidate", "rehearsal", "change", "promotion"]) {
    const hash = bundle?.chain?.[role]?.receiptHash;
    requireSha256(hash, `${role} receipt hash`);
    hashes[role] = hash;
  }
  if (new Set(Object.values(hashes)).size !== 4) {
    fail(
      "PHASE_RECEIPT_HASH_COLLISION",
      "The four phase receipt hashes must be distinct",
    );
  }
  return hashes;
}

function validateSnapshots({
  baseline,
  candidate,
  registrySha256,
  scopeBaseCommit,
  candidateCommit,
  candidateTree,
}) {
  for (const [label, snapshot] of Object.entries({ baseline, candidate })) {
    if (
      !isPlainObject(snapshot) ||
      snapshot.schema !== "pikiio-phase-authority-snapshot-v1" ||
      snapshot.phaseId !== "GOV-00" ||
      snapshot.registrySha256 !== registrySha256 ||
      !SHA256_PATTERN.test(String(snapshot.snapshotHash || "")) ||
      !SHA256_PATTERN.test(String(snapshot.authoritySetSha256 || ""))
    ) {
      fail(
        "AUTHORITY_SNAPSHOT_INVALID",
        `${label} authority snapshot is invalid`,
      );
    }
  }
  if (
    baseline.commit !== scopeBaseCommit ||
    candidate.commit !== candidateCommit ||
    candidate.tree !== candidateTree ||
    baseline.authoritySetSha256 !== candidate.authoritySetSha256
  ) {
    fail(
      "AUTHORITY_SNAPSHOT_DIVERGENCE",
      "Candidate judge authority diverges from the frozen scope base",
    );
  }
}

function requiredGithubEnvironment(environment, name, pattern = null) {
  const value = environment?.[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.includes("\u0000") ||
    (pattern && !pattern.test(value))
  ) {
    fail(
      "GITHUB_RUN_CONTEXT_INVALID",
      `GitHub run context ${name} is missing or invalid`,
    );
  }
  return value;
}

function deriveGithubRun(environment, collectorReceipt, candidateCommit) {
  if (
    requiredGithubEnvironment(environment, "GITHUB_ACTIONS") !== "true" ||
    requiredGithubEnvironment(environment, "GITHUB_REPOSITORY") !==
      githubCollector.EXPECTED_REPOSITORY ||
    requiredGithubEnvironment(environment, "RUNNER_ENVIRONMENT") !==
      githubCollector.EXPECTED_RUNNER_ENVIRONMENT ||
    requiredGithubEnvironment(
      environment,
      "GITHUB_SHA",
      COMMIT_PATTERN,
    ) !== candidateCommit
  ) {
    fail(
      "GITHUB_AUTHORITY_CONTEXT_MISMATCH",
      "Verifier is not running in the exact GitHub-hosted candidate context",
    );
  }
  const eventName = requiredGithubEnvironment(
    environment,
    "GITHUB_EVENT_NAME",
    /^[A-Za-z0-9_]{1,64}$/,
  );
  const runId = requiredGithubEnvironment(
    environment,
    "GITHUB_RUN_ID",
    DIGIT_PATTERN,
  );
  const runNumber = requiredGithubEnvironment(
    environment,
    "GITHUB_RUN_NUMBER",
    DIGIT_PATTERN,
  );
  const runAttempt = requiredGithubEnvironment(
    environment,
    "GITHUB_RUN_ATTEMPT",
    DIGIT_PATTERN,
  );
  const checkRunId = collectorReceipt?.oidc?.checkRunId;
  if (typeof checkRunId !== "string" || !DIGIT_PATTERN.test(checkRunId)) {
    fail(
      "GITHUB_RUN_CONTEXT_INVALID",
      "Signed collector check-run identity is invalid",
    );
  }
  return {
    schema: GITHUB_RUN_SCHEMA,
    eventName,
    runId,
    runNumber,
    runAttempt,
    checkRunId,
    repository: githubCollector.EXPECTED_REPOSITORY,
    runnerEnvironment: githubCollector.EXPECTED_RUNNER_ENVIRONMENT,
    githubSha: candidateCommit,
  };
}

function expectedRunFromCertification(run) {
  requireExactKeys(
    run,
    [
      "schema",
      "eventName",
      "runId",
      "runNumber",
      "runAttempt",
      "checkRunId",
      "repository",
      "runnerEnvironment",
      "githubSha",
    ],
    "GitHub run context",
  );
  if (
    run.schema !== GITHUB_RUN_SCHEMA ||
    run.repository !== githubCollector.EXPECTED_REPOSITORY ||
    run.runnerEnvironment !== githubCollector.EXPECTED_RUNNER_ENVIRONMENT ||
    !COMMIT_PATTERN.test(String(run.githubSha || "")) ||
    typeof run.eventName !== "string" ||
    !/^[A-Za-z0-9_]{1,64}$/.test(run.eventName) ||
    [run.runId, run.runNumber, run.runAttempt, run.checkRunId].some(
      (value) => typeof value !== "string" || !DIGIT_PATTERN.test(value),
    )
  ) {
    fail("GITHUB_RUN_CONTEXT_INVALID", "Certified GitHub run context is invalid");
  }
  return {
    eventName: run.eventName,
    runId: run.runId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
    checkRunId: run.checkRunId,
  };
}

function collectorEvidenceFromBytes(bytes, collectorResult) {
  const encoded = bytes.toString("base64");
  return {
    schema: COLLECTOR_EVIDENCE_SCHEMA,
    encoding: "base64",
    byteLength: bytes.length,
    rawSha256: sha256(bytes),
    bytes: encoded,
    receiptHash: collectorResult.receiptHash,
  };
}

function decodeCollectorEvidence(evidence) {
  requireExactKeys(
    evidence,
    [
      "schema",
      "encoding",
      "byteLength",
      "rawSha256",
      "bytes",
      "receiptHash",
    ],
    "embedded collector evidence",
  );
  if (
    evidence.schema !== COLLECTOR_EVIDENCE_SCHEMA ||
    evidence.encoding !== "base64" ||
    !Number.isSafeInteger(evidence.byteLength) ||
    evidence.byteLength < 1 ||
    evidence.byteLength > MAX_COLLECTOR_RECEIPT_BYTES ||
    typeof evidence.bytes !== "string" ||
    !CANONICAL_BASE64_PATTERN.test(evidence.bytes)
  ) {
    fail(
      "COLLECTOR_EVIDENCE_INVALID",
      "Embedded collector receipt encoding is invalid",
    );
  }
  requireSha256(evidence.rawSha256, "collector raw receipt hash");
  requireSha256(evidence.receiptHash, "collector receipt hash");
  const bytes = Buffer.from(evidence.bytes, "base64");
  if (
    bytes.length !== evidence.byteLength ||
    bytes.toString("base64") !== evidence.bytes ||
    sha256(bytes) !== evidence.rawSha256
  ) {
    fail(
      "COLLECTOR_EVIDENCE_HASH_MISMATCH",
      "Embedded collector receipt bytes are not content-addressed",
    );
  }
  const receipt = parseJsonBytes(bytes, "embedded collector receipt");
  if (receipt.receiptHash !== evidence.receiptHash) {
    fail(
      "COLLECTOR_EVIDENCE_HASH_MISMATCH",
      "Embedded collector receipt internal hash diverges",
    );
  }
  return { bytes, receipt };
}

function proofInputs({
  phase,
  authority,
  ledger,
  ledgerSha256,
  candidateCommit,
  candidateTree,
  qualityReceipt,
  rawHashes,
  receiptHashes,
  dependencies,
}) {
  const inputs = {
    schema: dependencies.COLLECTOR_PROOF_INPUT_SCHEMA,
    phase: {
      phaseId: phase.id,
      issuerRegistrySha256: authority.authoritySha256,
      ledgerRevision: ledger.revision,
      ledgerSha256,
    },
    candidate: {
      commit: candidateCommit,
      tree: candidateTree,
    },
    quality: {
      strictReceiptHash: qualityReceipt.receiptHash,
      commandPlanHash: qualityReceipt.commandPlanSha256,
      primaryRawArtifactHash: rawHashes.primary,
      independentRawArtifactHash: rawHashes.independent,
    },
    receiptHashes,
  };
  return dependencies.reconstructAttestationBodyFromProofInputs(inputs);
}

function withSanitizedGitEnvironment(callback) {
  const replacements = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "diff.external",
    GIT_CONFIG_VALUE_2: "",
  };
  const prior = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of prior.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function evaluateFrozenAuthority(input, runtime, mode) {
  requireCommit(input.expectedScopeBaseCommit, "expected scope base");
  const candidateRepo = canonicalAbsolutePath(
    input.candidateRepo,
    "candidate repository",
  );
  const qualityPath = canonicalAbsolutePath(
    input.qualityReceiptPath,
    "strict quality receipt",
  );
  const bundlePath = canonicalAbsolutePath(
    input.phaseProofBundlePath,
    "phase proof bundle",
  );
  const paths = [candidateRepo, qualityPath, bundlePath];
  if (mode === "issue") {
    paths.push(
      canonicalAbsolutePath(
        input.collectorReceiptPath,
        "GitHub collector receipt",
      ),
    );
  }
  if (new Set(paths).size !== paths.length) {
    fail("INPUT_PATH_COLLISION", "Verifier input paths must be distinct");
  }

  const gitState = runtime.verifyGit({
    authorityRoot: runtime.authorityRoot,
    candidateRepo,
    expectedScopeBaseCommit: input.expectedScopeBaseCommit,
  });
  const ledger = parseJsonBytes(
    runtime.readCommitBlob(
      candidateRepo,
      gitState.candidateHead,
      LEDGER_RELATIVE_PATH,
      MAX_LEDGER_BYTES,
    ),
    "candidate ledger blob",
  );
  const registry = runtime.dependencies.loadPhaseProofRegistry();
  const registrySha256 = sha256(stableJson(registry));
  if (
    registrySha256 !== runtime.dependencies.CANONICAL_REGISTRY_SHA256 ||
    registrySha256 !== governance.CANONICAL_REGISTRY_SHA256
  ) {
    fail(
      "PHASE_PROOF_REGISTRY_MISMATCH",
      "Frozen phase proof registry is not the canonical authority",
    );
  }
  const phase = validateActiveGovPhase(
    ledger,
    input.expectedScopeBaseCommit,
    registry,
    runtime.dependencies,
  );

  const authority = parseJsonBytes(
    runtime.readCommitBlob(
      runtime.authorityRoot,
      gitState.rootHead,
      AUTHORITY_RELATIVE_PATH,
      256 * 1024,
    ),
    "frozen attestation authority blob",
  );
  const jwks = parseJsonBytes(
    runtime.readCommitBlob(
      runtime.authorityRoot,
      gitState.rootHead,
      JWKS_RELATIVE_PATH,
      256 * 1024,
    ),
    "frozen JWKS registry blob",
  );
  validateAuthorityRegistry(
    authority,
    registry,
    runtime.dependencies,
  );
  validateJwksRegistry(jwks, authority, registry, runtime.dependencies);

  const qualityRead = readBoundedJson(qualityPath, {
    label: "strict quality receipt",
    maximumBytes: MAX_QUALITY_RECEIPT_BYTES,
  });
  const bundleRead = readBoundedJson(bundlePath, {
    label: "phase proof bundle",
    maximumBytes: MAX_PHASE_BUNDLE_BYTES,
  });
  const qualityReceipt = qualityRead.value;
  const bundle = bundleRead.value;
  const artifacts = artifactBytesFromBundle(bundle);

  const qualityReport = withSanitizedGitEnvironment(() =>
    runtime.dependencies.validateQualityReceipt(qualityReceipt, {
      ledger,
      phase,
      head: gitState.candidateHead,
      workspaceDigest:
        runtime.dependencies.cleanWorkspaceEvidenceDigest(),
      repoRoot: candidateRepo,
      verifyRawArtifacts: true,
      rawArtifactBytes: artifacts,
    }),
  );
  requireValidReport(
    qualityReport,
    "STRICT_QUALITY_RECEIPT_INVALID",
    "Frozen strict quality validation failed",
  );
  const bundleReport = withSanitizedGitEnvironment(() =>
    runtime.dependencies.validatePhaseProofBundle(bundle, {
      ledger,
      phase,
      qualityReceipt,
      repoRoot: candidateRepo,
      requireFullChain: true,
      nowMs: runtime.now(),
    }),
  );
  requireValidReport(
    bundleReport,
    "PHASE_PROOF_BUNDLE_INVALID",
    "Frozen phase proof bundle validation failed",
  );

  const baselineSnapshot = withSanitizedGitEnvironment(() =>
    runtime.dependencies.computeAuthoritySnapshot({
      repoRoot: runtime.authorityRoot,
      commit: gitState.rootHead,
      phaseId: phase.id,
      registry,
    }),
  );
  const candidateSnapshot = withSanitizedGitEnvironment(() =>
    runtime.dependencies.computeAuthoritySnapshot({
      repoRoot: candidateRepo,
      commit: gitState.candidateHead,
      phaseId: phase.id,
      registry,
    }),
  );
  validateSnapshots({
    baseline: baselineSnapshot,
    candidate: candidateSnapshot,
    registrySha256,
    scopeBaseCommit: gitState.rootHead,
    candidateCommit: gitState.candidateHead,
    candidateTree: gitState.candidateTree,
  });

  const rawHashes = qualityRawHashes(qualityReceipt, artifacts);
  const receiptHashes = receiptHashesFromBundle(bundle);
  const ledgerSha256 = sha256(stableJson(ledger));
  const body = proofInputs({
    phase,
    authority,
    ledger,
    ledgerSha256,
    candidateCommit: gitState.candidateHead,
    candidateTree: gitState.candidateTree,
    qualityReceipt,
    rawHashes,
    receiptHashes,
    dependencies: runtime.dependencies,
  });
  const bodyReport = runtime.dependencies.validateAttestationBody(body);

  let collectorBytes;
  let collectorReceipt;
  let githubRun;
  if (mode === "issue") {
    const collectorRead = readBoundedJson(input.collectorReceiptPath, {
      label: "GitHub collector receipt",
      maximumBytes: MAX_COLLECTOR_RECEIPT_BYTES,
    });
    collectorBytes = collectorRead.bytes;
    collectorReceipt = collectorRead.value;
    githubRun = deriveGithubRun(
      runtime.environment,
      collectorReceipt,
      gitState.candidateHead,
    );
  } else {
    const decoded = decodeCollectorEvidence(input.certification.collectorEvidence);
    collectorBytes = decoded.bytes;
    collectorReceipt = decoded.receipt;
    githubRun = input.certification.githubRun;
    if (githubRun.githubSha !== gitState.candidateHead) {
      fail(
        "GITHUB_RUN_CONTEXT_MISMATCH",
        "Certified GitHub run does not match candidate HEAD",
      );
    }
  }
  const expectedRun = expectedRunFromCertification(githubRun);
  let collectorResult;
  try {
    collectorResult =
      runtime.dependencies.validateGithubOidcCollectorReceipt({
        receipt: collectorReceipt,
        expectedBody: body,
        scopeBaseCommit: gitState.rootHead,
        jwksRegistry: jwks,
        expectedJwksRegistrySha256: jwks.registrySha256,
        expectedRun,
        nowMs: runtime.now(),
      });
  } catch (error) {
    fail(
      "GITHUB_COLLECTOR_RECEIPT_INVALID",
      "Frozen GitHub OIDC collector validation failed",
      { cause: error.code || error.message },
    );
  }
  if (
    collectorResult?.valid !== true ||
    collectorResult.bodySha256 !== bodyReport.bodySha256 ||
    collectorResult.candidateCommit !== gitState.candidateHead ||
    collectorResult.scopeBaseCommit !== gitState.rootHead ||
    collectorResult.runId !== githubRun.runId ||
    collectorResult.runAttempt !== githubRun.runAttempt ||
    typeof collectorResult.replayKey !== "string" ||
    collectorResult.replayKey.length < 2 ||
    collectorResult.replayKey.length > 512
  ) {
    fail(
      "GITHUB_COLLECTOR_RESULT_INVALID",
      "Collector result does not bind the frozen proof and run",
    );
  }

  return {
    phase,
    ledger,
    ledgerSha256,
    registrySha256,
    authority,
    jwks,
    qualityReceipt,
    bundle,
    rawHashes,
    receiptHashes,
    baselineSnapshot,
    candidateSnapshot,
    body,
    bodySha256: bodyReport.bodySha256,
    collectorBytes,
    collectorResult,
    githubRun,
    gitState,
  };
}

function buildCertification(evidence) {
  const certification = {
    schema: CERTIFICATION_SCHEMA,
    phaseId: evidence.phase.id,
    scopeBaseCommit: evidence.gitState.rootHead,
    candidateCommit: evidence.gitState.candidateHead,
    candidateTree: evidence.gitState.candidateTree,
    ledgerRevision: evidence.ledger.revision,
    ledgerSha256: evidence.ledgerSha256,
    phaseProofRegistrySha256: evidence.registrySha256,
    attestationAuthoritySha256: evidence.authority.authoritySha256,
    jwksRegistrySha256: evidence.jwks.registrySha256,
    baselineAuthoritySnapshotHash:
      evidence.baselineSnapshot.snapshotHash,
    candidateAuthoritySnapshotHash:
      evidence.candidateSnapshot.snapshotHash,
    authoritySetSha256: evidence.baselineSnapshot.authoritySetSha256,
    strictQualityReceiptHash: evidence.qualityReceipt.receiptHash,
    phaseProofBundleHash: evidence.bundle.bundleHash,
    receiptHashes: evidence.receiptHashes,
    attestationBody: evidence.body,
    attestationBodySha256: evidence.bodySha256,
    githubRun: evidence.githubRun,
    collectorEvidence: collectorEvidenceFromBytes(
      evidence.collectorBytes,
      evidence.collectorResult,
    ),
    replayProtection: {
      schema: REPLAY_PROTECTION_SCHEMA,
      replayKey: evidence.collectorResult.replayKey,
      replayKeySha256: sha256(evidence.collectorResult.replayKey),
      consumptionScope: "single-controller-local-runtime",
      multiHostSafe: false,
    },
    verifiedAt: evidence.collectorResult.collectedAt,
  };
  certification.certificationHash = hashWithoutField(
    certification,
    "certificationHash",
  );
  if (
    Buffer.byteLength(stableJson(certification), "utf8") >
    MAX_CERTIFICATION_BYTES
  ) {
    fail(
      "CERTIFICATION_OVERSIZED",
      "Frozen authority certification exceeds its byte bound",
    );
  }
  return certification;
}

function validateCertificationShape(certification) {
  requireExactKeys(
    certification,
    CERTIFICATION_KEYS,
    "frozen authority certification",
  );
  if (certification.schema !== CERTIFICATION_SCHEMA) {
    fail(
      "CERTIFICATION_SCHEMA_INVALID",
      "Frozen authority certification schema is invalid",
    );
  }
  requireSha256(certification.certificationHash, "certification hash");
  if (
    hashWithoutField(certification, "certificationHash") !==
      certification.certificationHash
  ) {
    fail(
      "CERTIFICATION_HASH_MISMATCH",
      "Frozen authority certification hash is invalid",
    );
  }
  if (
    Buffer.byteLength(stableJson(certification), "utf8") >
    MAX_CERTIFICATION_BYTES
  ) {
    fail(
      "CERTIFICATION_OVERSIZED",
      "Frozen authority certification exceeds its byte bound",
    );
  }
  requireExactKeys(
    certification.replayProtection,
    [
      "schema",
      "replayKey",
      "replayKeySha256",
      "consumptionScope",
      "multiHostSafe",
    ],
    "replay protection",
  );
  if (
    certification.replayProtection.schema !== REPLAY_PROTECTION_SCHEMA ||
    certification.replayProtection.consumptionScope !==
      "single-controller-local-runtime" ||
    certification.replayProtection.multiHostSafe !== false ||
    typeof certification.replayProtection.replayKey !== "string" ||
    sha256(certification.replayProtection.replayKey) !==
      certification.replayProtection.replayKeySha256
  ) {
    fail(
      "REPLAY_PROTECTION_INVALID",
      "Frozen authority replay protection is invalid",
    );
  }
}

function ensureReplayDirectory(replayRoot) {
  canonicalAbsolutePath(replayRoot, "replay directory");
  const home = fs.realpathSync(os.homedir());
  if (process.env.NODE_ENV === "test" && !replayRoot.startsWith(`${home}${path.sep}`)) {
    fs.mkdirSync(replayRoot, { recursive: true, mode: 0o700 });
    ensureDirectory(replayRoot, "replay directory");
    return replayRoot;
  }
  if (
    replayRoot === home ||
    !replayRoot.startsWith(`${home}${path.sep}`)
  ) {
    fail(
      "REPLAY_DIRECTORY_INVALID",
      "Replay directory must remain under the current user home",
    );
  }
  const relative = path.relative(home, replayRoot);
  let cursor = home;
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") {
      fail("REPLAY_DIRECTORY_INVALID", "Replay directory is not canonical");
    }
    cursor = path.join(cursor, part);
    try {
      fs.mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") {
        fail("REPLAY_DIRECTORY_UNAVAILABLE", "Replay directory cannot be created", {
          cause: error.code || error.message,
        });
      }
    }
    const stat = fs.lstatSync(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      fail(
        "REPLAY_DIRECTORY_INVALID",
        "Replay directory contains an unsafe component",
      );
    }
  }
  ensureDirectory(replayRoot, "replay directory");
  return replayRoot;
}

function consumeReplayKey(certification, replayRoot) {
  const directory = ensureReplayDirectory(replayRoot);
  const markerName =
    `${certification.replayProtection.replayKeySha256}.json`;
  const markerPath = path.join(directory, markerName);
  const marker = {
    schema: REPLAY_MARKER_SCHEMA,
    replayKeySha256: certification.replayProtection.replayKeySha256,
    collectorReceiptHash: certification.collectorEvidence.receiptHash,
    attestationBodySha256: certification.attestationBodySha256,
    candidateCommit: certification.candidateCommit,
    scopeBaseCommit: certification.scopeBaseCommit,
    certificationHash: certification.certificationHash,
  };
  marker.markerHash = hashWithoutField(marker, "markerHash");
  const bytes = Buffer.from(`${stableJson(marker)}\n`, "utf8");
  let descriptor = null;
  let directoryDescriptor = null;
  let created = false;
  try {
    descriptor = fs.openSync(
      markerPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
      );
      if (!Number.isSafeInteger(written) || written < 1) {
        fail("REPLAY_CONSUME_FAILED", "Replay marker write made no progress");
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(directoryDescriptor);
    fs.closeSync(directoryDescriptor);
    directoryDescriptor = null;
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
    if (error.code === "EEXIST") {
      fail(
        "REPLAY_ALREADY_CONSUMED",
        "GitHub collector replay key was already consumed",
        { replayKeySha256: certification.replayProtection.replayKeySha256 },
      );
    }
    if (created) {
      try {
        fs.unlinkSync(markerPath);
      } catch {
        // A failed marker remains fail-closed if it cannot be removed.
      }
    }
    fail("REPLAY_CONSUME_FAILED", "Replay key could not be durably consumed", {
      cause: error.code || error.message,
    });
  }
  return {
    markerPath,
    markerHash: marker.markerHash,
  };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  CANONICAL_REGISTRY_SHA256: phaseProof.CANONICAL_REGISTRY_SHA256,
  COLLECTOR_PROOF_INPUT_SCHEMA:
    githubCollector.COLLECTOR_PROOF_INPUT_SCHEMA,
  cleanWorkspaceEvidenceDigest: governance.cleanWorkspaceEvidenceDigest,
  computeAuthoritySnapshot: phaseProof.computeAuthoritySnapshot,
  loadPhaseProofRegistry: phaseProof.loadPhaseProofRegistry,
  phaseProofForId: phaseProof.phaseProofForId,
  reconstructAttestationBodyFromProofInputs:
    githubCollector.reconstructAttestationBodyFromProofInputs,
  selectActivePhase: governance.selectActivePhase,
  validateAttestationBody: phaseAttestation.validateAttestationBody,
  validateGithubOidcCollectorReceipt:
    githubCollector.validateGithubOidcCollectorReceipt,
  validatePhaseLedger: governance.validatePhaseLedger,
  validatePhaseProofBundle: governance.validatePhaseProofBundle,
  validatePinnedJwksRegistry: githubCollector.validatePinnedJwksRegistry,
  validateQualityReceipt: governance.validateQualityReceipt,
});

function defaultRuntime() {
  return {
    authorityRoot: ROOT,
    replayRoot: DEFAULT_REPLAY_ROOT,
    environment: process.env,
    now: Date.now,
    readCommitBlob,
    dependencies: DEFAULT_DEPENDENCIES,
    verifyGit: verifyFrozenAndCandidateGit,
  };
}

function issueWithRuntime(input, runtime) {
  const evidence = evaluateFrozenAuthority(input, runtime, "issue");
  const certification = buildCertification(evidence);
  consumeReplayKey(certification, runtime.replayRoot);
  return certification;
}

function validateWithRuntime(input, runtime) {
  validateCertificationShape(input.certification);
  const evidence = evaluateFrozenAuthority(input, runtime, "validate");
  const expected = buildCertification(evidence);
  if (stableJson(expected) !== stableJson(input.certification)) {
    fail(
      "CERTIFICATION_CONTENT_MISMATCH",
      "Certification does not reproduce under frozen authority semantics",
    );
  }
  return {
    valid: true,
    certificationHash: expected.certificationHash,
    candidateCommit: expected.candidateCommit,
    scopeBaseCommit: expected.scopeBaseCommit,
    attestationBodySha256: expected.attestationBodySha256,
    collectorReceiptHash: expected.collectorEvidence.receiptHash,
    replayKeySha256: expected.replayProtection.replayKeySha256,
  };
}

function issueFrozenAuthorityCertification(input) {
  return issueWithRuntime(input, defaultRuntime());
}

function validateFrozenAuthorityCertification(input) {
  return validateWithRuntime(input, defaultRuntime());
}

function readFrozenAuthorityCertification(filePath) {
  const read = readBoundedJson(filePath, {
    label: "frozen authority certification",
    maximumBytes: MAX_CERTIFICATION_BYTES,
  });
  validateCertificationShape(read.value);
  return read.value;
}

function testRuntime(overrides = {}) {
  if (process.env.NODE_ENV !== "test") {
    fail(
      "TEST_RUNTIME_REFUSED",
      "Frozen verifier dependency injection is test-only",
    );
  }
  const base = defaultRuntime();
  return {
    ...base,
    ...overrides,
    dependencies: {
      ...base.dependencies,
      ...(overrides.dependencies || {}),
    },
  };
}

const testOnly = Object.freeze({
  artifactBytesFromBundle,
  consumeReplayKey,
  decodeCollectorEvidence,
  deriveGithubRun,
  issue(input, overrides = {}) {
    return issueWithRuntime(input, testRuntime(overrides));
  },
  readBoundedRegularFile,
  validate(input, overrides = {}) {
    return validateWithRuntime(input, testRuntime(overrides));
  },
  validateCertificationShape,
  verifyFrozenAndCandidateGit,
});

module.exports = {
  AUTHORITY_RELATIVE_PATH,
  CERTIFICATION_SCHEMA,
  COLLECTOR_EVIDENCE_SCHEMA,
  DEFAULT_REPLAY_ROOT,
  FrozenAuthorityError,
  GITHUB_RUN_SCHEMA,
  JWKS_RELATIVE_PATH,
  LEDGER_RELATIVE_PATH,
  REPLAY_PROTECTION_SCHEMA,
  issueFrozenAuthorityCertification,
  readFrozenAuthorityCertification,
  stableJson,
  validateFrozenAuthorityCertification,
  __testOnly: testOnly,
};

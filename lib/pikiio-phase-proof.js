"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  validatePinnedJwksRegistry,
} = require("./pikiio-github-oidc-collector");
const {
  createSealedGit,
} = require("./pikiio-sealed-git");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_REGISTRY_PATH = path.join(
  ROOT,
  "YLYI",
  "00_Product_Contract",
  "Pikiio_Phase_Proof_Registry.json",
);
const CANONICAL_REGISTRY_SHA256 =
  "6a6c9cc42b89197f147a56fd5afe9fb5137d75bb472e28cb48ae70ca8e7c0f94";
const PHASE_IDS = Object.freeze([
  "GOV-00",
  "TRUTH-01",
  "TRUTH-02",
  "ACTION-01",
  "ACTION-02",
  "ACTION-03",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const RECEIPT_SCHEMAS = Object.freeze({
  candidate: "pikiio-phase-candidate-quality-receipt-v1",
  rehearsal: "pikiio-phase-production-rehearsal-receipt-v1",
  change: "pikiio-phase-production-change-receipt-v1",
  promotion: "pikiio-phase-promotion-evidence-receipt-v1",
  natural: "pikiio-phase-natural-evidence-v1",
  browser: "pikiio-phase-browser-evidence-v1",
});
const PHASE_KEYS = Object.freeze([
  "qualityIds",
  "populationFloors",
  "qualityPlan",
  "authorityFiles",
  "runtimePathRules",
  "measuredRuntimeRules",
  "promotionAssertions",
  "receiptPolicy",
]);
const REGISTRY_ROOT_KEYS = Object.freeze([
  "schema",
  "revision",
  "attestationAuthority",
  "githubOidcJwks",
  "phaseOrder",
  "phases",
]);
const REFERENCED_REGISTRY_KEYS = Object.freeze([
  "schema",
  "revision",
  "path",
  "sha256",
]);
const ATTESTATION_AUTHORITY_KEYS = Object.freeze([
  "schema",
  "revision",
  "mode",
  "bodySchema",
  "controller",
  "collector",
  "authoritySha256",
]);
const ATTESTATION_CONTROLLER_KEYS = Object.freeze([
  "kind",
  "cryptographicSignature",
  "localCollectorPrivateKeyAllowed",
]);
const ATTESTATION_COLLECTOR_KEYS = Object.freeze([
  "kind",
  "issuer",
  "repository",
  "repositoryVisibility",
  "runnerEnvironment",
  "workflowPath",
  "workflowRef",
  "jwksRegistryPath",
  "jwksRegistrySha256",
]);
const RECEIPT_POLICY_KEYS = Object.freeze([
  "authorityBaseline",
  "productionMode",
  "candidateQuality",
  "productionRehearsal",
  "productionChange",
  "promotion",
  "minimumNaturalEvidence",
  "minimumBrowserEvidence",
  "minimumObservationSpanMs",
  "deploymentBinding",
]);
const IDENTITY_KEYS = Object.freeze(["id", "kind", "version", "identitySha256"]);
const COMMON_RECEIPT_KEYS = Object.freeze([
  "schema",
  "phaseId",
  "registryRevision",
  "registrySha256",
  "ledgerRevision",
  "candidateCommit",
  "candidateTree",
  "observedAt",
  "controller",
  "collector",
]);
const CANDIDATE_RECEIPT_KEYS = Object.freeze([
  ...COMMON_RECEIPT_KEYS,
  "status",
  "previousReceiptHash",
  "qualityIds",
  "populations",
  "authorityBaselineCommit",
  "authorityBaselineSnapshotHash",
  "authoritySnapshot",
  "changedPaths",
  "changedPathCoverage",
  "assertions",
  "rawArtifact",
  "receiptHash",
]);
const NATURAL_RECEIPT_KEYS = Object.freeze([
  ...COMMON_RECEIPT_KEYS,
  "deploymentId",
  "sourceCuts",
  "sourceCutSetSha256",
  "evidenceId",
  "cycleId",
  "natural",
  "result",
  "assertions",
  "rawArtifact",
  "receiptHash",
]);
const BROWSER_RECEIPT_KEYS = Object.freeze([
  ...COMMON_RECEIPT_KEYS,
  "deploymentId",
  "sourceCuts",
  "sourceCutSetSha256",
  "evidenceId",
  "agrees",
  "assertions",
  "apiStateSha256",
  "browserStateSha256",
  "rawArtifact",
  "receiptHash",
]);
const PROMOTION_RECEIPT_KEYS = Object.freeze([
  ...COMMON_RECEIPT_KEYS,
  "previousReceiptHash",
  "disposition",
  "deploymentId",
  "sourceCuts",
  "sourceCutSetSha256",
  "assertions",
  "naturalEvidence",
  "browserEvidence",
  "rawArtifact",
  "receiptHash",
]);
const ALLOWED_OPERATORS = new Set(["eq", "gte", "lte"]);
const ALLOWED_EVIDENCE = new Set([
  "candidate",
  "natural",
  "browser",
  "promotion",
]);
const authoritySnapshotCache = new Map();
const QUALITY_PLAN_KEYS = Object.freeze([
  "syntaxFiles",
  "suiteId",
  "gherkinId",
  "mutationId",
  "focusedCheckIds",
  "neighborCheckIds",
  "broadCheckIds",
  "productionShapedCheckIds",
  "naturalEvidenceRequired",
  "browserEvidenceRequired",
]);

class PhaseProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PhaseProofError";
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashWithoutField(value, field = "receiptHash") {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function exactKeys(value, expected) {
  return (
    isObject(value) &&
    stableJson(Object.keys(value).sort()) === stableJson([...expected].sort())
  );
}

function safeRelativePath(value) {
  return (
    nonemptyString(value) &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..") &&
    path.posix.normalize(value) === value
  );
}

function canonicalIso(value) {
  if (!nonemptyString(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function exactStable(left, right) {
  return stableJson(left) === stableJson(right);
}

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

function validateRule(rule, prefix, errors) {
  push(
    errors,
    exactKeys(rule, [
      "id",
      "match",
      "pattern",
      "classification",
      "proofRequired",
    ]),
    `${prefix} has unexpected fields`,
  );
  push(errors, nonemptyString(rule?.id), `${prefix}.id is required`);
  push(
    errors,
    rule?.match === "exact" || rule?.match === "prefix",
    `${prefix}.match is invalid`,
  );
  push(
    errors,
    safeRelativePath(rule?.pattern),
    `${prefix}.pattern is not a safe repository path`,
  );
  push(
    errors,
    nonemptyString(rule?.classification),
    `${prefix}.classification is required`,
  );
  push(
    errors,
    typeof rule?.proofRequired === "boolean",
    `${prefix}.proofRequired must be boolean`,
  );
  if (rule?.match === "prefix") {
    push(
      errors,
      rule.pattern.endsWith("/") || rule.pattern.endsWith("-"),
      `${prefix}.prefix must end in slash or hyphen`,
    );
  }
}

function validateAssertion(assertion, prefix, errors, measured = false) {
  const keys = measured
    ? ["id", "evidence", "metric", "operator", "expected"]
    : ["id", "evidence", "operator", "expected"];
  push(errors, exactKeys(assertion, keys), `${prefix} has unexpected fields`);
  push(errors, nonemptyString(assertion?.id), `${prefix}.id is required`);
  push(
    errors,
    ALLOWED_EVIDENCE.has(assertion?.evidence),
    `${prefix}.evidence is invalid`,
  );
  if (measured) {
    push(
      errors,
      nonemptyString(assertion?.metric),
      `${prefix}.metric is required`,
    );
  }
  push(
    errors,
    ALLOWED_OPERATORS.has(assertion?.operator),
    `${prefix}.operator is invalid`,
  );
  push(
    errors,
    ["string", "number", "boolean"].includes(typeof assertion?.expected) &&
      (typeof assertion?.expected !== "number" ||
        Number.isFinite(assertion.expected)),
    `${prefix}.expected must be a finite scalar`,
  );
  if (assertion?.operator !== "eq") {
    push(
      errors,
      typeof assertion?.expected === "number",
      `${prefix}.${assertion?.operator} requires a number`,
    );
  }
}

function validateReceiptPolicy(policy, phaseId, errors) {
  const prefix = `phases.${phaseId}.receiptPolicy`;
  push(errors, exactKeys(policy, RECEIPT_POLICY_KEYS), `${prefix} has unexpected fields`);
  push(
    errors,
    policy?.authorityBaseline === "scope_base",
    `${prefix}.authorityBaseline is invalid`,
  );
  push(
    errors,
    ["none", "observe_only", "change_gated"].includes(policy?.productionMode),
    `${prefix}.productionMode is invalid`,
  );
  push(
    errors,
    policy?.candidateQuality === "required",
    `${prefix}.candidateQuality must be required`,
  );
  push(
    errors,
    ["required", "not_applicable"].includes(policy?.productionRehearsal),
    `${prefix}.productionRehearsal is invalid`,
  );
  push(
    errors,
    ["required", "not_applicable"].includes(policy?.productionChange),
    `${prefix}.productionChange is invalid`,
  );
  push(
    errors,
    policy?.promotion === "required",
    `${prefix}.promotion must be required`,
  );
  for (const key of [
    "minimumNaturalEvidence",
    "minimumBrowserEvidence",
    "minimumObservationSpanMs",
  ]) {
    push(
      errors,
      Number.isSafeInteger(policy?.[key]) && policy[key] >= 0,
      `${prefix}.${key} must be a non-negative integer`,
    );
  }
  const expected = {
    none: {
      productionRehearsal: "not_applicable",
      productionChange: "not_applicable",
      deploymentBinding: "none",
    },
    observe_only: {
      productionRehearsal: "required",
      productionChange: "not_applicable",
      deploymentBinding: "rehearsal",
    },
    change_gated: {
      productionRehearsal: "required",
      productionChange: "required",
      deploymentBinding: "change",
    },
  }[policy?.productionMode];
  if (expected) {
    for (const [key, value] of Object.entries(expected)) {
      push(errors, policy[key] === value, `${prefix}.${key} must be ${value}`);
    }
  }
}

function validateQualityPlan(plan, phase, prefix, errors) {
  push(errors, exactKeys(plan, QUALITY_PLAN_KEYS), `${prefix} has unexpected fields`);
  push(
    errors,
    Array.isArray(plan?.syntaxFiles) &&
      plan.syntaxFiles.length > 0 &&
      plan.syntaxFiles.every(
        (entry) => safeRelativePath(entry) && entry.endsWith(".js"),
      ) &&
      new Set(plan.syntaxFiles).size === plan.syntaxFiles.length,
    `${prefix}.syntaxFiles must be unique repository JavaScript paths`,
  );
  push(
    errors,
    plan?.suiteId === phase?.qualityIds?.suite &&
      plan?.gherkinId === phase?.qualityIds?.gherkin &&
      plan?.mutationId === phase?.qualityIds?.mutation,
    `${prefix} quality IDs must exactly match qualityIds`,
  );
  for (const key of [
    "focusedCheckIds",
    "neighborCheckIds",
    "broadCheckIds",
    "productionShapedCheckIds",
  ]) {
    push(
      errors,
      Array.isArray(plan?.[key]) &&
        plan[key].length > 0 &&
        plan[key].every(nonemptyString) &&
        new Set(plan[key]).size === plan[key].length,
      `${prefix}.${key} must be a non-empty unique ID list`,
    );
  }
  const checks = [
    ...(plan?.focusedCheckIds || []),
    ...(plan?.neighborCheckIds || []),
    ...(plan?.broadCheckIds || []),
    ...(plan?.productionShapedCheckIds || []),
  ];
  push(
    errors,
    new Set(checks).size === checks.length,
    `${prefix} cannot repeat a check across layers`,
  );
  push(
    errors,
    typeof plan?.naturalEvidenceRequired === "boolean" &&
      typeof plan?.browserEvidenceRequired === "boolean",
    `${prefix} evidence requirements must be boolean`,
  );
  push(
    errors,
    plan?.naturalEvidenceRequired ===
      (phase?.receiptPolicy?.minimumNaturalEvidence > 0) &&
      plan?.browserEvidenceRequired ===
        (phase?.receiptPolicy?.minimumBrowserEvidence > 0),
    `${prefix} evidence requirements must match receipt policy`,
  );
}

function validatePhaseProofRegistry(
  registry,
  { requireCanonical = true } = {},
) {
  const errors = [];
  push(
    errors,
    exactKeys(registry, REGISTRY_ROOT_KEYS),
    "registry has unexpected fields",
  );
  push(
    errors,
    registry?.schema === "pikiio-phase-proof-registry-v1",
    "registry schema is invalid",
  );
  push(errors, registry?.revision === 1, "registry revision must be one");
  for (const [field, expected] of Object.entries({
    attestationAuthority: {
      schema: "pikiio-phase-attestation-authority-registry-v1",
      path:
        "YLYI/00_Product_Contract/Pikiio_Phase_Attestation_Authority.json",
    },
    githubOidcJwks: {
      schema: "pikiio-github-oidc-jwks-registry-v1",
      path: "YLYI/00_Product_Contract/Pikiio_GitHub_OIDC_JWKS.json",
    },
  })) {
    const reference = registry?.[field];
    push(
      errors,
      exactKeys(reference, REFERENCED_REGISTRY_KEYS),
      `registry.${field} has unexpected fields`,
    );
    push(
      errors,
      reference?.schema === expected.schema &&
        reference?.revision === 1 &&
        reference?.path === expected.path &&
        safeRelativePath(reference?.path) &&
        SHA256_PATTERN.test(String(reference?.sha256 || "")),
      `registry.${field} contract is invalid`,
    );
  }
  push(
    errors,
    registry?.attestationAuthority?.sha256 !==
      registry?.githubOidcJwks?.sha256,
    "registry authority and JWKS digests must be distinct",
  );
  push(
    errors,
    exactStable(registry?.phaseOrder, PHASE_IDS),
    "registry phase order is not canonical",
  );
  push(
    errors,
    isObject(registry?.phases) &&
      exactStable(Object.keys(registry.phases), PHASE_IDS),
    "registry phases are not exact or ordered",
  );

  const qualityIds = new Set();
  for (const phaseId of PHASE_IDS) {
    const phase = registry?.phases?.[phaseId];
    const prefix = `phases.${phaseId}`;
    push(errors, exactKeys(phase, PHASE_KEYS), `${prefix} has unexpected fields`);
    push(
      errors,
      exactKeys(phase?.qualityIds, ["suite", "gherkin", "mutation"]),
      `${prefix}.qualityIds has unexpected fields`,
    );
    for (const key of ["suite", "gherkin", "mutation"]) {
      const id = phase?.qualityIds?.[key];
      push(errors, nonemptyString(id), `${prefix}.qualityIds.${key} is required`);
      push(
        errors,
        !qualityIds.has(id),
        `${prefix}.qualityIds.${key} must be phase-specific`,
      );
      qualityIds.add(id);
    }

    push(
      errors,
      exactKeys(phase?.populationFloors, [
        "unitTests",
        "criticalMutants",
        "gherkinScenarios",
      ]),
      `${prefix}.populationFloors has unexpected fields`,
    );
    for (const key of ["unitTests", "criticalMutants", "gherkinScenarios"]) {
      push(
        errors,
        Number.isSafeInteger(phase?.populationFloors?.[key]) &&
          phase.populationFloors[key] > 0,
        `${prefix}.populationFloors.${key} must be a positive integer`,
      );
    }
    if (phaseId === "GOV-00") {
      push(
        errors,
        exactStable(phase?.populationFloors, {
          unitTests: 655,
          criticalMutants: 102,
          gherkinScenarios: 39,
        }),
        "GOV-00 population floors must equal the observed baseline",
      );
    } else {
      push(
        errors,
        phase?.populationFloors?.unitTests >= 65,
        `${prefix} must require at least 65 domain unit tests`,
      );
    }
    validateQualityPlan(phase?.qualityPlan, phase, `${prefix}.qualityPlan`, errors);

    const authorities = phase?.authorityFiles;
    push(
      errors,
      Array.isArray(authorities) &&
        authorities.length > 0 &&
        authorities.every(safeRelativePath) &&
        new Set(authorities).size === authorities.length &&
        exactStable(authorities, [...authorities].sort()),
      `${prefix}.authorityFiles must be unique, safe, sorted, and non-empty`,
    );

    const pathRules = phase?.runtimePathRules;
    push(
      errors,
      Array.isArray(pathRules) && pathRules.length > 0,
      `${prefix}.runtimePathRules must be non-empty`,
    );
    const ruleIds = new Set();
    for (const [index, rule] of (pathRules || []).entries()) {
      validateRule(rule, `${prefix}.runtimePathRules[${index}]`, errors);
      push(
        errors,
        !ruleIds.has(rule?.id),
        `${prefix}.runtimePathRules has duplicate id ${rule?.id}`,
      );
      ruleIds.add(rule?.id);
    }

    const measured = phase?.measuredRuntimeRules;
    const assertions = phase?.promotionAssertions;
    push(
      errors,
      Array.isArray(measured) && measured.length > 0,
      `${prefix}.measuredRuntimeRules must be non-empty`,
    );
    push(
      errors,
      Array.isArray(assertions) && assertions.length > 0,
      `${prefix}.promotionAssertions must be non-empty`,
    );
    const measuredIds = new Set();
    for (const [index, rule] of (measured || []).entries()) {
      validateAssertion(
        rule,
        `${prefix}.measuredRuntimeRules[${index}]`,
        errors,
        true,
      );
      push(
        errors,
        !measuredIds.has(rule?.id),
        `${prefix}.measuredRuntimeRules has duplicate id ${rule?.id}`,
      );
      measuredIds.add(rule?.id);
    }
    const assertionIds = new Set();
    for (const [index, assertion] of (assertions || []).entries()) {
      validateAssertion(
        assertion,
        `${prefix}.promotionAssertions[${index}]`,
        errors,
      );
      push(
        errors,
        !assertionIds.has(assertion?.id),
        `${prefix}.promotionAssertions has duplicate id ${assertion?.id}`,
      );
      assertionIds.add(assertion?.id);
    }
    for (const rule of measured || []) {
      const matching = (assertions || []).find(
        (assertion) => assertion.id === rule.id,
      );
      push(
        errors,
        Boolean(matching) &&
          matching.evidence === rule.evidence &&
          matching.operator === rule.operator &&
          exactStable(matching.expected, rule.expected),
        `${prefix}.measuredRuntimeRules.${rule.id} is not promotion-bound`,
      );
    }
    validateReceiptPolicy(phase?.receiptPolicy, phaseId, errors);
  }

  const registrySha256 = isObject(registry)
    ? sha256(stableJson(registry))
    : null;
  if (requireCanonical) {
    push(
      errors,
      registrySha256 === CANONICAL_REGISTRY_SHA256,
      "registry content does not match the immutable canonical registry",
    );
  }
  return {
    valid: errors.length === 0,
    errors,
    registrySha256,
  };
}

function loadReferencedRegistry(
  reference,
  hashField,
  { repoRoot = ROOT, fsImpl = fs } = {},
) {
  const resolvedRoot = path.resolve(repoRoot);
  const target = path.resolve(resolvedRoot, reference.path);
  if (
    !safeRelativePath(reference.path) ||
    (target !== resolvedRoot &&
      !target.startsWith(`${resolvedRoot}${path.sep}`))
  ) {
    throw new Error("referenced registry path escapes the repository");
  }
  let descriptor = null;
  try {
    const before = fsImpl.lstatSync(target);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 2 ||
      before.size > 256 * 1024
    ) {
      throw new Error("referenced registry is not a bounded regular file");
    }
    descriptor = fsImpl.openSync(
      target,
      fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0),
    );
    const opened = fsImpl.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("referenced registry changed while opening");
    }
    const bytes = fsImpl.readFileSync(descriptor);
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      !isObject(value) ||
      value.schema !== reference.schema ||
      value.revision !== reference.revision ||
      value[hashField] !== reference.sha256 ||
      hashWithoutField(value, hashField) !== reference.sha256
    ) {
      throw new Error("referenced registry digest or contract mismatch");
    }
    return value;
  } finally {
    if (descriptor !== null) fsImpl.closeSync(descriptor);
  }
}

function validateReferencedPhaseAuthorities(
  registry,
  { repoRoot = ROOT, fsImpl = fs } = {},
) {
  const authority = loadReferencedRegistry(
    registry.attestationAuthority,
    "authoritySha256",
    { repoRoot, fsImpl },
  );
  const jwks = loadReferencedRegistry(
    registry.githubOidcJwks,
    "registrySha256",
    { repoRoot, fsImpl },
  );
  if (
    !exactKeys(authority, ATTESTATION_AUTHORITY_KEYS) ||
    !exactKeys(authority.controller, ATTESTATION_CONTROLLER_KEYS) ||
    !exactKeys(authority.collector, ATTESTATION_COLLECTOR_KEYS) ||
    authority.schema !==
      "pikiio-phase-attestation-authority-registry-v1" ||
    authority.revision !== 1 ||
    authority.mode !== "external_collector_required" ||
    authority.bodySchema !== "pikiio-phase-attestation-body-v1" ||
    authority.controller.kind !== "local_content_addressed_evidence" ||
    authority.controller.cryptographicSignature !==
      "optional_non_authorizing" ||
    authority.controller.localCollectorPrivateKeyAllowed !== false ||
    authority.collector.kind !== "github_actions_oidc" ||
    authority.collector.issuer !==
      "https://token.actions.githubusercontent.com" ||
    authority.collector.repository !== "demo-maintainer/Pikiio-app-" ||
    authority.collector.repositoryVisibility !== "private" ||
    authority.collector.runnerEnvironment !== "github-hosted" ||
    authority.collector.workflowPath !==
      ".github/workflows/pikiio-proof-collector.yml" ||
    authority.collector.workflowRef !== "pikiio-proof-authority-v1" ||
    authority.collector.jwksRegistryPath !==
      registry.githubOidcJwks.path ||
    authority.collector.jwksRegistrySha256 !==
      registry.githubOidcJwks.sha256 ||
    authority.collector.issuer !== jwks.issuer
  ) {
    throw new Error("attestation authority contract is not canonical");
  }
  validatePinnedJwksRegistry(jwks, {
    expectedRegistrySha256: registry.githubOidcJwks.sha256,
  });
  return { authority, jwks };
}

function loadPhaseProofRegistry(filePath = DEFAULT_REGISTRY_PATH) {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new PhaseProofError(
      "PHASE_PROOF_REGISTRY_UNREADABLE",
      "Phase proof registry could not be read",
      { filePath, cause: error.message },
    );
  }
  const validation = validatePhaseProofRegistry(registry);
  if (!validation.valid) {
    throw new PhaseProofError(
      "PHASE_PROOF_REGISTRY_INVALID",
      "Phase proof registry failed closed",
      { filePath, errors: validation.errors },
    );
  }
  if (path.resolve(filePath) === DEFAULT_REGISTRY_PATH) {
    try {
      validateReferencedPhaseAuthorities(registry);
    } catch (error) {
      throw new PhaseProofError(
        "PHASE_PROOF_REFERENCED_AUTHORITY_INVALID",
        "Phase proof registry referenced authority failed closed",
        { cause: error.message },
      );
    }
  }
  return registry;
}

function phaseProofForId(registry, phaseId) {
  const validation = validatePhaseProofRegistry(registry);
  if (!validation.valid) {
    throw new PhaseProofError(
      "PHASE_PROOF_REGISTRY_INVALID",
      "Cannot select a phase from an invalid registry",
      { errors: validation.errors },
    );
  }
  const phase = registry.phases[phaseId];
  if (!phase) {
    throw new PhaseProofError(
      "PHASE_PROOF_UNKNOWN",
      `Unknown phase proof ${phaseId}`,
      { phaseId },
    );
  }
  return phase;
}

function readAuthorityTreeEntries(sealedGit, commit, authorityFiles) {
  const output = sealedGit.objectsAtPaths({
    commit,
    paths: authorityFiles,
  });
  if (output.length !== authorityFiles.length) {
    throw new PhaseProofError(
      "PHASE_PROOF_AUTHORITY_TREE_INVALID",
      "Authority tree does not contain the exact configured object set",
      {
        expected: authorityFiles.length,
        observed: output.length,
      },
    );
  }
  const entries = new Map();
  for (const entry of output) {
    if (entry.type !== "blob" || entries.has(entry.path)) {
      throw new PhaseProofError(
        "PHASE_PROOF_AUTHORITY_TREE_INVALID",
        "Authority tree contains a non-blob or ambiguous judge path",
        { entry },
      );
    }
    entries.set(entry.path, {
      mode: entry.mode,
      blob: entry.objectId,
    });
  }
  return entries;
}

function readAuthorityBlobs(sealedGit, commit, authorityFiles) {
  const blobs = sealedGit.batchBlobsAtPaths({
    commit,
    paths: authorityFiles,
    maximumTotalBytes: 32 * 1024 * 1024,
  });
  const byPath = new Map(
    blobs.map((entry) => [
      entry.path,
      { blob: entry.objectId, content: entry.bytes },
    ]),
  );
  return authorityFiles.map((relativePath) => byPath.get(relativePath));
}

function computeAuthoritySnapshot({
  repoRoot = ROOT,
  commit,
  phaseId,
  registry = loadPhaseProofRegistry(),
} = {}) {
  const phase = phaseProofForId(registry, phaseId);
  if (!COMMIT_PATTERN.test(String(commit || ""))) {
    throw new PhaseProofError(
      "PHASE_PROOF_COMMIT_INVALID",
      "Authority evidence requires a full immutable Git commit",
      { commit },
    );
  }
  const resolvedRoot = path.resolve(repoRoot);
  const cacheKey = stableJson({
    repoRoot: resolvedRoot,
    commit,
    phaseId,
    registrySha256: sha256(stableJson(registry)),
  });
  const sealedGit = createSealedGit({
    repoRoot: resolvedRoot,
    maxStdoutBytes: 33 * 1024 * 1024,
  });
  sealedGit.commit({ commit });
  const tree = sealedGit.tree({ commit });

  const treeEntries = readAuthorityTreeEntries(
    sealedGit,
    commit,
    phase.authorityFiles,
  );
  for (const relativePath of phase.authorityFiles) {
    const entry = treeEntries.get(relativePath);
    if (!entry || entry.mode === "120000") {
      throw new PhaseProofError(
        "PHASE_PROOF_AUTHORITY_FILE_INVALID",
        "Authority file is missing, non-blob, symlinked, or path-ambiguous",
        { phaseId, relativePath, treeEntry: entry || null },
      );
    }
  }
  const blobs = readAuthorityBlobs(
    sealedGit,
    commit,
    phase.authorityFiles,
  );
  const files = phase.authorityFiles.map((relativePath, index) => {
    const entry = treeEntries.get(relativePath);
    const blob = blobs[index];
    if (blob.blob !== entry.blob) {
      throw new PhaseProofError(
        "PHASE_PROOF_AUTHORITY_FILE_INVALID",
        "Authority file is missing, non-blob, symlinked, or path-ambiguous",
        { phaseId, relativePath, treeEntry: entry || null },
      );
    }
    return {
      path: relativePath,
      mode: entry.mode,
      blob: entry.blob,
      bytes: blob.content.length,
      sha256: sha256(blob.content),
    };
  });
  const snapshot = {
    schema: "pikiio-phase-authority-snapshot-v1",
    phaseId,
    registrySha256: sha256(stableJson(registry)),
    commit,
    tree,
    files,
    authoritySetSha256: sha256(stableJson(files)),
  };
  snapshot.snapshotHash = hashWithoutField(snapshot, "snapshotHash");
  const cached = authoritySnapshotCache.get(cacheKey);
  if (cached) {
    if (
      cached.repositoryIdentitySha256 !==
        sealedGit.repositoryIdentitySha256 ||
      cached.snapshot !== stableJson(snapshot)
    ) {
      throw new PhaseProofError(
        "PHASE_PROOF_AUTHORITY_CACHE_INVALID",
        "Cached authority content no longer matches revalidated repository evidence",
        {
          phaseId,
          commit,
          repositoryIdentityChanged:
            cached.repositoryIdentitySha256 !==
            sealedGit.repositoryIdentitySha256,
        },
      );
    }
    return JSON.parse(cached.snapshot);
  }
  authoritySnapshotCache.set(cacheKey, {
    repositoryIdentitySha256: sealedGit.repositoryIdentitySha256,
    snapshot: stableJson(snapshot),
  });
  return snapshot;
}

function classifyChangedPaths({
  registry,
  phaseId,
  changedPaths,
} = {}) {
  const phase = phaseProofForId(registry, phaseId);
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some((entry) => !safeRelativePath(entry)) ||
    new Set(changedPaths).size !== changedPaths.length ||
    !exactStable(changedPaths, [...changedPaths].sort())
  ) {
    throw new PhaseProofError(
      "PHASE_PROOF_CHANGED_PATHS_INVALID",
      "Changed paths must be a non-empty, unique, sorted safe path list",
      { changedPaths },
    );
  }
  const authoritySet = new Set(phase.authorityFiles);
  const coverage = [];
  for (const relativePath of changedPaths) {
    if (authoritySet.has(relativePath)) {
      coverage.push({
        path: relativePath,
        ruleId: "immutable-authority-file",
        classification: "authority_runtime",
        proofRequired: true,
      });
      continue;
    }
    const matches = phase.runtimePathRules.filter((rule) =>
      rule.match === "exact"
        ? relativePath === rule.pattern
        : relativePath.startsWith(rule.pattern),
    );
    if (matches.length !== 1) {
      throw new PhaseProofError(
        matches.length === 0
          ? "PHASE_PROOF_PATH_UNCLASSIFIED"
          : "PHASE_PROOF_PATH_AMBIGUOUS",
        "Every changed path must have one exact phase-proof classification",
        {
          phaseId,
          relativePath,
          matchingRuleIds: matches.map((rule) => rule.id),
        },
      );
    }
    coverage.push({
      path: relativePath,
      ruleId: matches[0].id,
      classification: matches[0].classification,
      proofRequired: matches[0].proofRequired,
    });
  }
  return {
    schema: "pikiio-phase-changed-path-coverage-v1",
    phaseId,
    changedPaths,
    entries: coverage,
    proofRequiredPaths: coverage
      .filter((entry) => entry.proofRequired)
      .map((entry) => entry.path),
    coverageSha256: sha256(stableJson(coverage)),
  };
}

function identityBody(identity) {
  return {
    id: identity.id,
    kind: identity.kind,
    version: identity.version,
  };
}

function validateIdentity(identity, expectedKind, prefix, errors) {
  push(errors, exactKeys(identity, IDENTITY_KEYS), `${prefix} has unexpected fields`);
  push(errors, nonemptyString(identity?.id), `${prefix}.id is required`);
  push(
    errors,
    identity?.kind === expectedKind,
    `${prefix}.kind must be ${expectedKind}`,
  );
  push(errors, nonemptyString(identity?.version), `${prefix}.version is required`);
  push(
    errors,
    SHA256_PATTERN.test(String(identity?.identitySha256 || "")) &&
      identity.identitySha256 === sha256(stableJson(identityBody(identity))),
    `${prefix}.identitySha256 is invalid`,
  );
}

function validateTimestamp(value, prefix, errors, nowMs) {
  push(errors, canonicalIso(value), `${prefix} must be a canonical ISO timestamp`);
  const time = Date.parse(value);
  push(
    errors,
    Number.isFinite(time) && time <= nowMs + 5 * 60 * 1000,
    `${prefix} cannot be in the future`,
  );
  return time;
}

function validateReceiptHash(receipt, prefix, errors) {
  push(
    errors,
    SHA256_PATTERN.test(String(receipt?.receiptHash || "")) &&
      receipt.receiptHash === hashWithoutField(receipt),
    `${prefix}.receiptHash does not match the receipt`,
  );
}

function sourceCutSetSha256(sourceCuts) {
  return sha256(stableJson(sourceCuts));
}

function validateSourceCuts(sourceCuts, observedAt, prefix, errors) {
  push(
    errors,
    Array.isArray(sourceCuts) &&
      new Set(
        (sourceCuts || []).map((cut) => `${cut?.source}\0${cut?.id}`),
      ).size === sourceCuts?.length,
    `${prefix} must be a unique array`,
  );
  let priorKey = "";
  for (const [index, cut] of (sourceCuts || []).entries()) {
    const itemPrefix = `${prefix}[${index}]`;
    push(
      errors,
      exactKeys(cut, ["source", "id", "sha256", "capturedAt"]),
      `${itemPrefix} has unexpected fields`,
    );
    push(errors, nonemptyString(cut?.source), `${itemPrefix}.source is required`);
    push(errors, nonemptyString(cut?.id), `${itemPrefix}.id is required`);
    push(
      errors,
      SHA256_PATTERN.test(String(cut?.sha256 || "")),
      `${itemPrefix}.sha256 is invalid`,
    );
    push(
      errors,
      canonicalIso(cut?.capturedAt) &&
        Date.parse(cut.capturedAt) <= Date.parse(observedAt),
      `${itemPrefix}.capturedAt is invalid`,
    );
    const key = `${cut?.source}\0${cut?.id}`;
    push(errors, key > priorKey, `${prefix} must be sorted by source and id`);
    priorKey = key;
  }
}

function artifactBytes(artifacts, address) {
  let value;
  if (artifacts instanceof Map) {
    value = artifacts.get(address);
  } else if (isObject(artifacts) && Object.hasOwn(artifacts, address)) {
    value = artifacts[address];
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function validateRawArtifact(ref, artifacts, prefix, errors) {
  push(
    errors,
    exactKeys(ref, ["address", "sha256"]),
    `${prefix} has unexpected fields`,
  );
  const digest = String(ref?.sha256 || "");
  push(errors, SHA256_PATTERN.test(digest), `${prefix}.sha256 is invalid`);
  push(
    errors,
    ref?.address === `sha256:${digest}`,
    `${prefix}.address must be content-addressed`,
  );
  const bytes = artifactBytes(artifacts, ref?.address);
  push(errors, Boolean(bytes), `${prefix} bytes are unavailable`);
  push(
    errors,
    Boolean(bytes) && sha256(bytes) === digest,
    `${prefix} bytes do not match sha256`,
  );
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    errors.push(`${prefix} is not valid JSON`);
    return null;
  }
}

function assertionPass(assertion, value) {
  if (assertion.operator === "eq") return exactStable(value, assertion.expected);
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return assertion.operator === "gte"
    ? value >= assertion.expected
    : value <= assertion.expected;
}

function expectedAssertions(phase, evidence = null) {
  return Object.fromEntries(
    phase.promotionAssertions
      .filter((assertion) => evidence === null || assertion.evidence === evidence)
      .map((assertion) => [assertion.id, assertion.expected]),
  );
}

function validateAssertionValues(values, phase, evidence, prefix, errors) {
  const rules = phase.promotionAssertions.filter(
    (assertion) => evidence === null || assertion.evidence === evidence,
  );
  push(
    errors,
    isObject(values) &&
      exactStable(Object.keys(values).sort(), rules.map((rule) => rule.id).sort()),
    `${prefix} must contain the exact ${evidence || "promotion"} assertions`,
  );
  for (const rule of rules) {
    push(
      errors,
      assertionPass(rule, values?.[rule.id]),
      `${prefix}.${rule.id} failed ${rule.operator}`,
    );
  }
}

function validateCommonBinding(
  receipt,
  schema,
  context,
  prefix,
  errors,
) {
  push(errors, receipt?.schema === schema, `${prefix}.schema is invalid`);
  push(errors, receipt?.phaseId === context.phaseId, `${prefix}.phaseId mismatch`);
  push(
    errors,
    receipt?.registryRevision === context.registry.revision,
    `${prefix}.registryRevision mismatch`,
  );
  push(
    errors,
    receipt?.registrySha256 === context.registrySha256,
    `${prefix}.registrySha256 mismatch`,
  );
  push(
    errors,
    receipt?.ledgerRevision === context.ledgerRevision,
    `${prefix}.ledgerRevision mismatch`,
  );
  push(
    errors,
    receipt?.candidateCommit === context.candidateCommit,
    `${prefix}.candidateCommit mismatch`,
  );
  push(
    errors,
    receipt?.candidateTree === context.candidateTree,
    `${prefix}.candidateTree mismatch`,
  );
  validateIdentity(receipt?.controller, "controller", `${prefix}.controller`, errors);
  validateIdentity(receipt?.collector, "collector", `${prefix}.collector`, errors);
  push(
    errors,
    receipt?.controller?.id !== receipt?.collector?.id,
    `${prefix} controller and collector must be independent`,
  );
  return validateTimestamp(receipt?.observedAt, `${prefix}.observedAt`, errors, context.nowMs);
}

function effectivePopulationFloors(phase, baseQualityProfile, errors) {
  if (!isObject(baseQualityProfile)) {
    errors.push("base quality profile is required");
    return null;
  }
  const base = {
    unitTests: baseQualityProfile.minimumUnitTestsPerRun,
    criticalMutants: baseQualityProfile.minimumCriticalMutationPopulation,
    gherkinScenarios: baseQualityProfile.minimumGherkinScenarioPopulation,
  };
  for (const [key, value] of Object.entries(base)) {
    push(
      errors,
      Number.isSafeInteger(value) && value > 0,
      `base quality profile ${key} floor is invalid`,
    );
  }
  if (errors.length > 0) return null;
  return Object.fromEntries(
    Object.keys(base).map((key) => [
      key,
      Math.max(base[key], phase.populationFloors[key]),
    ]),
  );
}

function validateCandidate(candidate, context, artifacts, errors) {
  const phase = context.phase;
  push(
    errors,
    exactKeys(candidate, CANDIDATE_RECEIPT_KEYS),
    "candidate has unexpected root fields",
  );
  const observedAt = validateCommonBinding(
    candidate,
    RECEIPT_SCHEMAS.candidate,
    context,
    "candidate",
    errors,
  );
  push(errors, candidate?.status === "passed", "candidate.status must be passed");
  push(
    errors,
    candidate?.previousReceiptHash === null,
    "candidate must start the receipt chain",
  );
  push(
    errors,
    exactStable(candidate?.qualityIds, phase.qualityIds),
    "candidate quality IDs do not match the phase registry",
  );
  const floors = effectivePopulationFloors(
    phase,
    context.baseQualityProfile,
    errors,
  );
  push(
    errors,
    exactKeys(candidate?.populations, [
      "unitTests",
      "criticalMutants",
      "gherkinScenarios",
    ]),
    "candidate populations have unexpected fields",
  );
  if (floors) {
    for (const [key, floor] of Object.entries(floors)) {
      push(
        errors,
        Number.isSafeInteger(candidate?.populations?.[key]) &&
          candidate.populations[key] >= floor,
        `candidate population ${key} is below the conjunctive floor ${floor}`,
      );
    }
  }
  push(
    errors,
    exactStable(candidate?.authoritySnapshot, context.authoritySnapshot),
    "candidate authority snapshot mismatch",
  );
  push(
    errors,
    candidate?.authorityBaselineCommit === context.authorityBaselineCommit,
    "candidate authority baseline commit mismatch",
  );
  push(
    errors,
    candidate?.authorityBaselineSnapshotHash ===
      context.baselineAuthoritySnapshot.snapshotHash,
    "candidate authority baseline snapshot mismatch",
  );
  push(
    errors,
    context.authoritySnapshot.authoritySetSha256 ===
      context.baselineAuthoritySnapshot.authoritySetSha256,
    "candidate changed immutable judge authority",
  );
  let expectedCoverage = null;
  try {
    expectedCoverage = classifyChangedPaths({
      registry: context.registry,
      phaseId: context.phaseId,
      changedPaths: candidate?.changedPaths,
    });
  } catch (error) {
    errors.push(error.message);
  }
  push(
    errors,
    Boolean(expectedCoverage) &&
      exactStable(candidate?.changedPathCoverage, expectedCoverage),
    "candidate changed-path coverage mismatch",
  );
  validateAssertionValues(
    candidate?.assertions,
    phase,
    "candidate",
    "candidate.assertions",
    errors,
  );
  const raw = validateRawArtifact(
    candidate?.rawArtifact,
    artifacts,
    "candidate.rawArtifact",
    errors,
  );
  const expectedRaw = {
    schema: "pikiio-candidate-quality-raw-artifact-v1",
    phaseId: context.phaseId,
    registryRevision: context.registry.revision,
    registrySha256: context.registrySha256,
    ledgerRevision: context.ledgerRevision,
    candidateCommit: context.candidateCommit,
    candidateTree: context.candidateTree,
    authorityBaselineCommit: context.authorityBaselineCommit,
    authorityBaselineSnapshotHash:
      context.baselineAuthoritySnapshot.snapshotHash,
    authoritySetSha256: context.authoritySnapshot.authoritySetSha256,
    changedPathCoverageSha256: expectedCoverage?.coverageSha256 || null,
    qualityIds: phase.qualityIds,
    populations: candidate?.populations,
    assertions: candidate?.assertions,
    observedAt: candidate?.observedAt,
    controller: candidate?.controller,
    collector: candidate?.collector,
  };
  push(
    errors,
    exactStable(raw, expectedRaw),
    "candidate raw artifact does not bind the candidate proof",
  );
  validateReceiptHash(candidate, "candidate", errors);
  return observedAt;
}

function validateProductionReceipt(
  receipt,
  kind,
  previousHash,
  context,
  artifacts,
  errors,
) {
  const prefix = kind;
  const policyKey = kind === "rehearsal" ? "productionRehearsal" : "productionChange";
  const requiredDisposition =
    context.phase.receiptPolicy[policyKey] === "required"
      ? "passed"
      : "not_applicable";
  const productionKeys =
    requiredDisposition === "not_applicable"
      ? [
          ...COMMON_RECEIPT_KEYS,
          "previousReceiptHash",
          "disposition",
          "deploymentId",
          "reason",
          "rawArtifact",
          "receiptHash",
        ]
      : [
          ...COMMON_RECEIPT_KEYS,
          "previousReceiptHash",
          "disposition",
          "deploymentId",
          "rollbackVerified",
          "externalEffects",
          ...(kind === "change"
            ? ["deployedCommit", "deployedTree", "rollbackReference"]
            : []),
          "rawArtifact",
          "receiptHash",
        ];
  push(
    errors,
    exactKeys(receipt, productionKeys),
    `${prefix} has unexpected root fields`,
  );
  const observedAt = validateCommonBinding(
    receipt,
    RECEIPT_SCHEMAS[kind],
    context,
    prefix,
    errors,
  );
  push(
    errors,
    receipt?.previousReceiptHash === previousHash,
    `${prefix}.previousReceiptHash mismatch`,
  );
  push(
    errors,
    receipt?.disposition === requiredDisposition,
    `${prefix}.disposition must be ${requiredDisposition}`,
  );

  if (requiredDisposition === "not_applicable") {
    push(
      errors,
      context.phase.receiptPolicy.productionMode !== "change_gated",
      `${prefix} cannot be not-applicable for a change-gated phase`,
    );
    push(
      errors,
      nonemptyString(receipt?.reason),
      `${prefix}.reason is required when not applicable`,
    );
    push(
      errors,
      receipt?.rawArtifact === null,
      `${prefix}.rawArtifact must be null when not applicable`,
    );
    const expectedDeployment =
      context.phase.receiptPolicy.deploymentBinding === "rehearsal" &&
      kind === "change"
        ? context.rehearsalDeploymentId
        : "none";
    push(
      errors,
      receipt?.deploymentId === expectedDeployment,
      `${prefix}.deploymentId is invalid for not-applicable evidence`,
    );
  } else {
    push(
      errors,
      nonemptyString(receipt?.deploymentId) && receipt.deploymentId !== "none",
      `${prefix}.deploymentId is required`,
    );
    push(
      errors,
      receipt?.rollbackVerified === true,
      `${prefix}.rollbackVerified must be true`,
    );
    push(
      errors,
      Array.isArray(receipt?.externalEffects) &&
        receipt.externalEffects.length === 0,
      `${prefix}.externalEffects must be empty`,
    );
    if (kind === "change") {
      push(
        errors,
        receipt?.deployedCommit === context.candidateCommit,
        "change.deployedCommit mismatch",
      );
      push(
        errors,
        receipt?.deployedTree === context.candidateTree,
        "change.deployedTree mismatch",
      );
      push(
        errors,
        nonemptyString(receipt?.rollbackReference),
        "change.rollbackReference is required",
      );
    }
    const raw = validateRawArtifact(
      receipt?.rawArtifact,
      artifacts,
      `${prefix}.rawArtifact`,
      errors,
    );
    const expectedRaw = {
      schema:
        kind === "rehearsal"
          ? "pikiio-production-rehearsal-raw-artifact-v1"
          : "pikiio-production-change-raw-artifact-v1",
      phaseId: context.phaseId,
      registryRevision: context.registry.revision,
      registrySha256: context.registrySha256,
      ledgerRevision: context.ledgerRevision,
      candidateCommit: context.candidateCommit,
      candidateTree: context.candidateTree,
      deploymentId: receipt?.deploymentId,
      observedAt: receipt?.observedAt,
      controller: receipt?.controller,
      collector: receipt?.collector,
      rollbackVerified: receipt?.rollbackVerified,
      externalEffects: receipt?.externalEffects,
      ...(kind === "change"
        ? {
            deployedCommit: receipt?.deployedCommit,
            deployedTree: receipt?.deployedTree,
            rollbackReference: receipt?.rollbackReference,
          }
        : {}),
    };
    push(
      errors,
      exactStable(raw, expectedRaw),
      `${prefix} raw artifact does not bind the production proof`,
    );
  }
  validateReceiptHash(receipt, prefix, errors);
  return observedAt;
}

function evidenceRawBase(receipt) {
  return {
    phaseId: receipt.phaseId,
    registryRevision: receipt.registryRevision,
    registrySha256: receipt.registrySha256,
    ledgerRevision: receipt.ledgerRevision,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    deploymentId: receipt.deploymentId,
    sourceCuts: receipt.sourceCuts,
    sourceCutSetSha256: receipt.sourceCutSetSha256,
    observedAt: receipt.observedAt,
    controller: receipt.controller,
    collector: receipt.collector,
    assertions: receipt.assertions,
  };
}

function validateNaturalEvidence(
  receipt,
  context,
  sourceCuts,
  deploymentId,
  artifacts,
  errors,
  index,
) {
  const prefix = `promotion.naturalEvidence[${index}]`;
  push(
    errors,
    exactKeys(receipt, NATURAL_RECEIPT_KEYS),
    `${prefix} has unexpected root fields`,
  );
  const observedAt = validateCommonBinding(
    receipt,
    RECEIPT_SCHEMAS.natural,
    context,
    prefix,
    errors,
  );
  push(
    errors,
    receipt?.deploymentId === deploymentId,
    `${prefix}.deploymentId mismatch`,
  );
  push(
    errors,
    exactStable(receipt?.sourceCuts, sourceCuts),
    `${prefix}.sourceCuts mismatch`,
  );
  push(
    errors,
    receipt?.sourceCutSetSha256 === sourceCutSetSha256(sourceCuts),
    `${prefix}.sourceCutSetSha256 mismatch`,
  );
  push(errors, nonemptyString(receipt?.evidenceId), `${prefix}.evidenceId is required`);
  push(errors, nonemptyString(receipt?.cycleId), `${prefix}.cycleId is required`);
  push(errors, receipt?.natural === true, `${prefix}.natural must be true`);
  push(errors, receipt?.result === "passed", `${prefix}.result must be passed`);
  validateAssertionValues(
    receipt?.assertions,
    context.phase,
    "natural",
    `${prefix}.assertions`,
    errors,
  );
  const raw = validateRawArtifact(
    receipt?.rawArtifact,
    artifacts,
    `${prefix}.rawArtifact`,
    errors,
  );
  push(
    errors,
    exactStable(raw, {
      schema: "pikiio-natural-raw-artifact-v1",
      ...evidenceRawBase(receipt || {}),
      evidenceId: receipt?.evidenceId,
      cycleId: receipt?.cycleId,
      natural: receipt?.natural,
      result: receipt?.result,
    }),
    `${prefix} raw artifact does not bind the natural evidence`,
  );
  validateReceiptHash(receipt, prefix, errors);
  return observedAt;
}

function validateBrowserEvidence(
  receipt,
  context,
  sourceCuts,
  deploymentId,
  artifacts,
  errors,
  index,
) {
  const prefix = `promotion.browserEvidence[${index}]`;
  push(
    errors,
    exactKeys(receipt, BROWSER_RECEIPT_KEYS),
    `${prefix} has unexpected root fields`,
  );
  const observedAt = validateCommonBinding(
    receipt,
    RECEIPT_SCHEMAS.browser,
    context,
    prefix,
    errors,
  );
  push(
    errors,
    receipt?.deploymentId === deploymentId,
    `${prefix}.deploymentId mismatch`,
  );
  push(
    errors,
    exactStable(receipt?.sourceCuts, sourceCuts),
    `${prefix}.sourceCuts mismatch`,
  );
  push(
    errors,
    receipt?.sourceCutSetSha256 === sourceCutSetSha256(sourceCuts),
    `${prefix}.sourceCutSetSha256 mismatch`,
  );
  push(errors, nonemptyString(receipt?.evidenceId), `${prefix}.evidenceId is required`);
  push(errors, receipt?.agrees === true, `${prefix}.agrees must be true`);
  validateAssertionValues(
    receipt?.assertions,
    context.phase,
    "browser",
    `${prefix}.assertions`,
    errors,
  );
  const raw = validateRawArtifact(
    receipt?.rawArtifact,
    artifacts,
    `${prefix}.rawArtifact`,
    errors,
  );
  const apiStateSha256 = raw?.apiState
    ? sha256(stableJson(raw.apiState))
    : null;
  const browserStateSha256 = raw?.browserState
    ? sha256(stableJson(raw.browserState))
    : null;
  push(
    errors,
    SHA256_PATTERN.test(String(receipt?.apiStateSha256 || "")) &&
      receipt.apiStateSha256 === apiStateSha256,
    `${prefix}.apiStateSha256 is not recomputed from raw evidence`,
  );
  push(
    errors,
    SHA256_PATTERN.test(String(receipt?.browserStateSha256 || "")) &&
      receipt.browserStateSha256 === browserStateSha256,
    `${prefix}.browserStateSha256 is not recomputed from raw evidence`,
  );
  push(
    errors,
    apiStateSha256 === browserStateSha256,
    `${prefix} raw API and browser states disagree`,
  );
  push(
    errors,
    exactStable(raw, {
      schema: "pikiio-browser-raw-artifact-v1",
      ...evidenceRawBase(receipt || {}),
      evidenceId: receipt?.evidenceId,
      agrees: receipt?.agrees,
      apiState: raw?.apiState,
      browserState: raw?.browserState,
    }),
    `${prefix} raw artifact does not bind the browser evidence`,
  );
  validateReceiptHash(receipt, prefix, errors);
  return observedAt;
}

function validatePromotion(
  promotion,
  previousHash,
  context,
  artifacts,
  errors,
) {
  push(
    errors,
    exactKeys(promotion, PROMOTION_RECEIPT_KEYS),
    "promotion has unexpected root fields",
  );
  const observedAt = validateCommonBinding(
    promotion,
    RECEIPT_SCHEMAS.promotion,
    context,
    "promotion",
    errors,
  );
  push(
    errors,
    promotion?.previousReceiptHash === previousHash,
    "promotion.previousReceiptHash mismatch",
  );
  push(
    errors,
    promotion?.disposition === "passed",
    "promotion.disposition must be passed",
  );
  const deploymentId = {
    none: "none",
    rehearsal: context.rehearsalDeploymentId,
    change: context.changeDeploymentId,
  }[context.phase.receiptPolicy.deploymentBinding];
  push(
    errors,
    promotion?.deploymentId === deploymentId,
    "promotion.deploymentId mismatch",
  );
  validateSourceCuts(
    promotion?.sourceCuts,
    promotion?.observedAt,
    "promotion.sourceCuts",
    errors,
  );
  push(
    errors,
    promotion?.sourceCutSetSha256 ===
      sourceCutSetSha256(promotion?.sourceCuts || []),
    "promotion.sourceCutSetSha256 mismatch",
  );
  const evidenceRequired =
    context.phase.receiptPolicy.minimumNaturalEvidence > 0 ||
    context.phase.receiptPolicy.minimumBrowserEvidence > 0;
  push(
    errors,
    !evidenceRequired || (promotion?.sourceCuts || []).length > 0,
    "promotion source cuts are required for observed evidence",
  );
  validateAssertionValues(
    promotion?.assertions,
    context.phase,
    null,
    "promotion.assertions",
    errors,
  );
  push(
    errors,
    Array.isArray(promotion?.naturalEvidence) &&
      promotion.naturalEvidence.length >=
        context.phase.receiptPolicy.minimumNaturalEvidence,
    "promotion natural evidence population is below policy",
  );
  push(
    errors,
    Array.isArray(promotion?.browserEvidence) &&
      promotion.browserEvidence.length >=
        context.phase.receiptPolicy.minimumBrowserEvidence,
    "promotion browser evidence population is below policy",
  );

  const ids = new Set();
  const times = [];
  for (const [index, evidence] of (promotion?.naturalEvidence || []).entries()) {
    push(
      errors,
      !ids.has(evidence?.evidenceId),
      "promotion evidence IDs must be unique",
    );
    ids.add(evidence?.evidenceId);
    times.push(
      validateNaturalEvidence(
        evidence,
        context,
        promotion?.sourceCuts || [],
        deploymentId,
        artifacts,
        errors,
        index,
      ),
    );
  }
  for (const [index, evidence] of (promotion?.browserEvidence || []).entries()) {
    push(
      errors,
      !ids.has(evidence?.evidenceId),
      "promotion evidence IDs must be unique",
    );
    ids.add(evidence?.evidenceId);
    times.push(
      validateBrowserEvidence(
        evidence,
        context,
        promotion?.sourceCuts || [],
        deploymentId,
        artifacts,
        errors,
        index,
      ),
    );
  }
  if (times.length > 0) {
    const finiteTimes = times.filter(Number.isFinite);
    push(
      errors,
      finiteTimes.length === times.length &&
        Math.max(...finiteTimes) - Math.min(...finiteTimes) >=
          context.phase.receiptPolicy.minimumObservationSpanMs,
      "promotion observation span is below policy",
    );
    push(
      errors,
      finiteTimes.every((time) => time <= observedAt),
      "promotion evidence cannot postdate the promotion receipt",
    );
  } else {
    push(
      errors,
      context.phase.receiptPolicy.minimumObservationSpanMs === 0,
      "promotion evidence is missing for a non-zero observation span",
    );
  }
  const raw = validateRawArtifact(
    promotion?.rawArtifact,
    artifacts,
    "promotion.rawArtifact",
    errors,
  );
  push(
    errors,
    exactStable(raw, {
      schema: "pikiio-promotion-raw-artifact-v1",
      phaseId: context.phaseId,
      registryRevision: context.registry.revision,
      registrySha256: context.registrySha256,
      ledgerRevision: context.ledgerRevision,
      candidateCommit: context.candidateCommit,
      candidateTree: context.candidateTree,
      deploymentId,
      sourceCuts: promotion?.sourceCuts,
      sourceCutSetSha256: promotion?.sourceCutSetSha256,
      naturalEvidenceReceiptHashes: (promotion?.naturalEvidence || []).map(
        (evidence) => evidence.receiptHash,
      ),
      browserEvidenceReceiptHashes: (promotion?.browserEvidence || []).map(
        (evidence) => evidence.receiptHash,
      ),
      assertions: promotion?.assertions,
      observedAt: promotion?.observedAt,
      controller: promotion?.controller,
      collector: promotion?.collector,
    }),
    "promotion raw artifact does not bind the evidence set",
  );
  validateReceiptHash(promotion, "promotion", errors);
  return observedAt;
}

function prepareCandidateContext(
  candidate,
  {
    registry = loadPhaseProofRegistry(),
    repoRoot = ROOT,
    ledgerRevision,
    baseQualityProfile,
    scopeBaseCommit,
    artifacts,
    nowMs = Date.now(),
  } = {},
) {
  const errors = [];
  const phaseId = candidate?.phaseId;
  let phase;
  try {
    phase = phaseProofForId(registry, phaseId);
  } catch (error) {
    return {
      errors: [error.message, ...(error.details?.errors || [])],
      context: null,
    };
  }
  push(
    errors,
    Number.isSafeInteger(ledgerRevision) && ledgerRevision >= 1,
    "ledgerRevision must be a positive integer",
  );
  push(
    errors,
    candidate?.ledgerRevision === ledgerRevision,
    "candidate ledger revision mismatch",
  );
  push(
    errors,
    COMMIT_PATTERN.test(String(candidate?.candidateCommit || "")),
    "candidate commit must be a full Git commit",
  );
  push(
    errors,
    COMMIT_PATTERN.test(String(candidate?.candidateTree || "")),
    "candidate tree must be a full Git tree",
  );
  let authoritySnapshot = null;
  let baselineAuthoritySnapshot = null;
  let authorityBaselineCommit = null;
  if (errors.length === 0) {
    try {
      authoritySnapshot = computeAuthoritySnapshot({
        repoRoot,
        commit: candidate.candidateCommit,
        phaseId,
        registry,
      });
      authorityBaselineCommit =
        phase.receiptPolicy.authorityBaseline === "candidate"
          ? candidate.candidateCommit
          : scopeBaseCommit;
      if (!COMMIT_PATTERN.test(String(authorityBaselineCommit || ""))) {
        throw new PhaseProofError(
          "PHASE_PROOF_BASELINE_COMMIT_INVALID",
          "Phase judge authority requires a full immutable scope-base commit",
          { phaseId, scopeBaseCommit },
        );
      }
      baselineAuthoritySnapshot = computeAuthoritySnapshot({
        repoRoot,
        commit: authorityBaselineCommit,
        phaseId,
        registry,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!authoritySnapshot || !baselineAuthoritySnapshot) {
    return { errors, context: null };
  }
  push(
    errors,
    candidate.candidateTree === authoritySnapshot.tree,
    "candidate tree does not match the immutable commit",
  );
  const context = {
    registry,
    registrySha256: sha256(stableJson(registry)),
    phase,
    phaseId,
    ledgerRevision,
    candidateCommit: candidate.candidateCommit,
    candidateTree: candidate.candidateTree,
    authoritySnapshot,
    baselineAuthoritySnapshot,
    authorityBaselineCommit,
    baseQualityProfile,
    artifacts,
    nowMs,
  };
  return { errors, context };
}

function partialValidationResult(errors, context, receiptHashes) {
  return {
    valid: errors.length === 0,
    errors,
    phaseId: context?.phaseId || null,
    registrySha256: context?.registrySha256 || null,
    authoritySnapshot: context?.authoritySnapshot || null,
    baselineAuthoritySnapshot: context?.baselineAuthoritySnapshot || null,
    receiptHashes,
  };
}

function validatePhaseCandidateReceipt(candidate, options = {}) {
  const prepared = prepareCandidateContext(candidate, options);
  if (!prepared.context) {
    return partialValidationResult(prepared.errors, null, {
      candidate: candidate?.receiptHash || null,
    });
  }
  const { context, errors } = prepared;
  const candidateTime = validateCandidate(
    candidate,
    context,
    context.artifacts,
    errors,
  );
  push(
    errors,
    Number.isFinite(candidateTime),
    "candidate receipt time must be valid",
  );
  return partialValidationResult(errors, context, {
    candidate: candidate?.receiptHash || null,
  });
}

function validatePhaseRehearsalAuthorization(receipts, options = {}) {
  if (!exactKeys(receipts, ["candidate", "rehearsal"])) {
    return {
      valid: false,
      errors: [
        "rehearsal authorization must contain exactly candidate and rehearsal receipts",
      ],
      productionChangeAuthorized: false,
    };
  }
  const prepared = prepareCandidateContext(receipts.candidate, options);
  if (!prepared.context) {
    return {
      ...partialValidationResult(prepared.errors, null, {
        candidate: receipts.candidate?.receiptHash || null,
        rehearsal: receipts.rehearsal?.receiptHash || null,
      }),
      productionChangeAuthorized: false,
    };
  }
  const { context, errors } = prepared;
  context.rehearsalDeploymentId = receipts.rehearsal?.deploymentId;
  const candidateTime = validateCandidate(
    receipts.candidate,
    context,
    context.artifacts,
    errors,
  );
  const rehearsalTime = validateProductionReceipt(
    receipts.rehearsal,
    "rehearsal",
    receipts.candidate?.receiptHash,
    context,
    context.artifacts,
    errors,
  );
  push(
    errors,
    Number.isFinite(candidateTime) &&
      Number.isFinite(rehearsalTime) &&
      rehearsalTime >= candidateTime,
    "candidate and rehearsal receipt times must be monotonic",
  );
  const result = partialValidationResult(errors, context, {
    candidate: receipts.candidate?.receiptHash || null,
    rehearsal: receipts.rehearsal?.receiptHash || null,
  });
  return {
    ...result,
    productionChangeAuthorized:
      result.valid &&
      context.phase.receiptPolicy.productionMode === "change_gated" &&
      receipts.rehearsal?.disposition === "passed",
  };
}

function validatePhaseProofChain(chain, options = {}) {
  if (!exactKeys(chain, ["candidate", "rehearsal", "change", "promotion"])) {
    return {
      valid: false,
      errors: ["phase proof chain must contain exactly four receipts"],
    };
  }
  const prepared = prepareCandidateContext(chain.candidate, options);
  if (!prepared.context) {
    return partialValidationResult(prepared.errors, null, {
      candidate: chain.candidate?.receiptHash || null,
      rehearsal: chain.rehearsal?.receiptHash || null,
      change: chain.change?.receiptHash || null,
      promotion: chain.promotion?.receiptHash || null,
    });
  }
  const { context, errors } = prepared;
  context.rehearsalDeploymentId = chain.rehearsal?.deploymentId;
  context.changeDeploymentId = chain.change?.deploymentId;
  const candidateTime = validateCandidate(
    chain.candidate,
    context,
    context.artifacts,
    errors,
  );
  const rehearsalTime = validateProductionReceipt(
    chain.rehearsal,
    "rehearsal",
    chain.candidate?.receiptHash,
    context,
    context.artifacts,
    errors,
  );
  const changeTime = validateProductionReceipt(
    chain.change,
    "change",
    chain.rehearsal?.receiptHash,
    context,
    context.artifacts,
    errors,
  );
  const promotionTime = validatePromotion(
    chain.promotion,
    chain.change?.receiptHash,
    context,
    context.artifacts,
    errors,
  );
  const times = [candidateTime, rehearsalTime, changeTime, promotionTime];
  push(
    errors,
    times.every(Number.isFinite) &&
      times.every((time, index) => index === 0 || time >= times[index - 1]),
    "phase proof receipt times must be monotonic",
  );
  return partialValidationResult(errors, context, {
    candidate: chain.candidate?.receiptHash || null,
    rehearsal: chain.rehearsal?.receiptHash || null,
    change: chain.change?.receiptHash || null,
    promotion: chain.promotion?.receiptHash || null,
  });
}

module.exports = {
  CANONICAL_REGISTRY_SHA256,
  DEFAULT_REGISTRY_PATH,
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
};

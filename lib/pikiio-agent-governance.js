"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  CANONICAL_REGISTRY_SHA256,
  classifyChangedPaths,
  loadPhaseProofRegistry,
  phaseProofForId,
  validatePhaseCandidateReceipt,
  validatePhaseProofChain,
  validatePhaseRehearsalAuthorization,
} = require("./pikiio-phase-proof");
const {
  semanticReceiptSha256,
} = require("./pikiio-quality-canonical");
const {
  collectHostDurabilityReceipt,
  validateHostDurabilityReceipt,
} = require("./pikiio-host-durability");
const {
  PHASE_PROOF_ENVELOPE_SCHEMA,
  validatePhaseProofEnvelope,
} = require("./pikiio-phase-proof-envelope");
const {
  SealedGitError,
  createSealedGit,
} = require("./pikiio-sealed-git");

const ROOT = path.resolve(__dirname, "..");
const CANONICAL_ROOT_REALPATH = fs.realpathSync(ROOT);
const CANONICAL_ROOT_STAT = fs.statSync(CANONICAL_ROOT_REALPATH, {
  bigint: true,
});

function repositoryIdentity(repoRoot) {
  const resolved = path.resolve(repoRoot);
  try {
    const realpath = fs.realpathSync(resolved);
    const stat = fs.statSync(realpath, { bigint: true });
    return {
      resolved,
      realpath,
      readable: true,
      canonical:
        realpath === CANONICAL_ROOT_REALPATH ||
        (stat.dev === CANONICAL_ROOT_STAT.dev &&
          stat.ino === CANONICAL_ROOT_STAT.ino),
    };
  } catch {
    return {
      resolved,
      realpath: null,
      readable: false,
      canonical: resolved === ROOT,
    };
  }
}

const DEFAULT_LEDGER_PATH = path.join(
  ROOT,
  "YLYI",
  "00_Product_Contract",
  "Pikiio_Agent_Phases.json",
);
const DEFAULT_RUNTIME_DIR = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "runtime",
  "pikiio-agent",
);
const DEFAULT_LEASE_PATH = path.join(DEFAULT_RUNTIME_DIR, "writer-lease.json");
const DEFAULT_FENCE_PATH = path.join(DEFAULT_RUNTIME_DIR, "writer-fence.json");
const DEFAULT_RECEIPT_PATH = path.join(DEFAULT_RUNTIME_DIR, "run-receipts.jsonl");
const DEFAULT_QUALITY_RECEIPT_PATH = path.join(
  DEFAULT_RUNTIME_DIR,
  "quality-receipt.json",
);
const DEFAULT_QUALITY_ARTIFACT_DIR = path.join(
  DEFAULT_RUNTIME_DIR,
  "quality-judge-artifacts",
);
const DEFAULT_ACTIVATION_RECEIPT_PATH = path.join(
  DEFAULT_RUNTIME_DIR,
  "heartbeat-activation-receipt.json",
);
const DEFAULT_PHASE_PROOF_BUNDLE_PATH = path.join(
  DEFAULT_RUNTIME_DIR,
  "phase-proof-bundle.json",
);
const DEFAULT_PHASE_TRANSITION_JOURNAL_PATH = path.join(
  DEFAULT_RUNTIME_DIR,
  "phase-transition-journal.json",
);
const DEFAULT_MORNING_RECEIPT_DIR = path.join(
  DEFAULT_RUNTIME_DIR,
  "morning-receipts",
);
const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_MORNING_START = "05:45";
const MINIMUM_BUILDER_SLICE_MS = 15 * 60 * 1000;
const MAXIMUM_LEASE_MS = 4 * 60 * 60 * 1000;
const OPERATION_LOCK_SUFFIX = ".operation-lock";
const PHASE_LEDGER_RELATIVE_PATH =
  "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json";
const PHASE_PROOF_REGISTRY_RELATIVE_PATH =
  "YLYI/00_Product_Contract/Pikiio_Phase_Proof_Registry.json";
const PHASE_COMPLETION_RECEIPT_DIR_RELATIVE_PATH =
  "YLYI/09_Proof_Receipts/phase-completions";
const PHASE_PROOF_BUNDLE_DIR_RELATIVE_PATH =
  "YLYI/09_Proof_Receipts/phase-proofs";
const CANONICAL_PHASE_PROOF_REGISTRY = loadPhaseProofRegistry(
  path.join(ROOT, PHASE_PROOF_REGISTRY_RELATIVE_PATH),
);
const REQUIRED_PHASE_PROOF_REGISTRY_CONTRACT = Object.freeze({
  schema: CANONICAL_PHASE_PROOF_REGISTRY.schema,
  revision: CANONICAL_PHASE_PROOF_REGISTRY.revision,
  path: PHASE_PROOF_REGISTRY_RELATIVE_PATH,
  sha256: CANONICAL_REGISTRY_SHA256,
});

const ACTIVE_STATUSES = new Set([
  "active",
  "verifying",
  "locally_proven",
  "deployed_disabled",
  "observing",
  "promotable",
  "promoted",
]);
const TERMINAL_DEPENDENCY_STATUSES = new Set(["complete", "promoted"]);
const ALLOWED_PHASE_STATUSES = new Set([
  "planned",
  "active",
  "verifying",
  "locally_proven",
  "deployed_disabled",
  "observing",
  "promotable",
  "promoted",
  "complete",
  "blocked",
]);
const ALLOWED_PROOF_STATUSES = new Set([
  "passed",
  "failed",
  "blocked",
  "not_applicable",
]);
const EXACT_PROOF_DISPOSITION_KEYS = Object.freeze([
  "reason",
  "receipts",
  "status",
]);
const EXACT_QUALITY_RECEIPT_V5_KEYS = Object.freeze([
  "antiWeakening",
  "automationSnapshotSha256",
  "candidateTree",
  "cleanJudge",
  "commandPlanSha256",
  "dependencyManifest",
  "goalObjectiveSha256",
  "head",
  "layers",
  "ledgerRevision",
  "ledgerSha256",
  "metrics",
  "operationalCheckout",
  "phaseId",
  "phaseProofRegistrySha256",
  "populations",
  "primaryJudge",
  "qualityPlanSha256",
  "qualityProfile",
  "qualityToolchain",
  "receiptHash",
  "recordedAt",
  "requiredCoverageFiles",
  "schema",
  "scopeBaseCommit",
  "thresholds",
  "workspaceDigest",
]);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_HEARTBEAT_PROMPT_PATH =
  "YLYI/05_Agent_Runbooks/Pikiio_Governed_Builder_Heartbeat_Prompt.md";
const CANONICAL_HEARTBEAT_PROMPT_SHA256 =
  "3511d46536d00136915ca3ef6bf1ee3de6458f322e1c888eddf194a07b258432";

const REQUIRED_POLICY_VALUES = Object.freeze({
  oneWriter: true,
  onePhaseSlicePerRun: true,
  defaultProductionAuthority: false,
  defaultModelSpendAuthority: false,
  truthRegressionPreemptsFeatures: true,
});
const REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS = Object.freeze([
  "gmail_send",
  "gmail_live_draft_creation",
  "tms_mutation",
  "freight_approval",
  "cargo_release",
  "carrier_booking",
  "driver_approval",
  "operational_document_upload",
  "operator_truth_fabrication",
  "ambiguous_claim_auto_acceptance",
  "evidence_deletion",
]);
const REQUIRED_QUALITY_EVIDENCE = Object.freeze([
  "executable_gherkin",
  "unit",
  "contract",
  "integration",
  "property",
  "negative_safety",
  "coverage",
  "mutation",
  "deterministic_repeat",
  "focused_verifier",
  "neighbor_verifier",
  "broad_verifier",
  "production_shaped_rehearsal",
  "natural_cycle_qa",
  "api_browser_parity",
  "clean_checkout_reproduction",
]);
const REQUIRED_CRITICAL_PROFILE = Object.freeze({
  minimumLineCoveragePercent: 95,
  minimumBranchCoveragePercent: 90,
  minimumFunctionCoveragePercent: 95,
  minimumMutationScorePercent: 90,
  minimumCriticalMutantKillPercent: 100,
  minimumGherkinPassPercent: 100,
  minimumUnitTestsPerRun: 65,
  minimumMutationPopulation: 20,
  minimumCriticalMutationPopulation: 20,
  minimumGherkinScenarioPopulation: 15,
  deterministicRepeatCount: 3,
  maximumFlakyTests: 0,
  maximumNewWarnings: 0,
  maximumSkippedRequiredTests: 0,
});
const REQUIRED_QUALITY_TOOLCHAIN = Object.freeze({
  platform: "darwin",
  arch: "arm64",
  nodePath: "/opt/homebrew/Cellar/node/25.5.0/bin/node",
  nodeVersion: "v25.5.0",
  nodeSha256:
    "0c45beedbde68e147083ffed066aadbab5df99a9fa661e62bd2950cfee36c6e9",
  npmCliPath: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
  npmVersion: "11.10.0",
  npmCliSha256:
    "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
  toolchainSha256:
    "02ae0a74e720231a01c106d554f45f9815028c3d647555acf3823881898deced",
});
const PHASE_PROOF_AUTHORITY_PATHS = Object.freeze([
  ...new Set(
    Object.values(CANONICAL_PHASE_PROOF_REGISTRY.phases).flatMap(
      (phase) => phase.authorityFiles,
    ),
  ),
].sort());
const REQUIRED_TRUSTED_GATE_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "YLYI/00_Product_Contract/Pikiio_Agent_Phases.json",
  PHASE_PROOF_REGISTRY_RELATIVE_PATH,
  CANONICAL_HEARTBEAT_PROMPT_PATH,
  "lib/pikiio-agent-governance.js",
  "lib/pikiio-frozen-authority-verifier.js",
  "lib/pikiio-host-durability.js",
  "lib/pikiio-live-refresh-lock.js",
  "lib/pikiio-phase-attestation.js",
  "lib/pikiio-phase-proof.js",
  "lib/pikiio-phase-proof-envelope.js",
  "lib/pikiio-quality-canonical.js",
  "lib/pikiio-quality-execution.js",
  "lib/pikiio-quality-runner.js",
  "scripts/pikiio-agent-goal-guard.js",
  "scripts/pikiio-agent-host-durability.js",
  "scripts/pikiio-agent-dirty-guard.js",
  "scripts/pikiio-agent-writer-lease.js",
  "scripts/pikiio-agent-run-receipt.js",
  "scripts/pikiio-agent-production-command.js",
  "scripts/pikiio-agent-activation-receipt.js",
  "scripts/pikiio-agent-phase-transition.js",
  "scripts/pikiio-phase-attestation-signer.js",
  "scripts/run-pikiio-quality-gauntlet.js",
  "scripts/mutate-pikiio-agent-governance.js",
  "scripts/verify-automation-contracts.js",
  "scripts/verify-pikiio-frozen-authority.js",
  "scripts/verify-pikiio-governance-gherkin.js",
  "scripts/verify-pikiio-agent-governance.js",
  "tests/pikiio-agent-governance.test.js",
  "tests/pikiio-agent-governance-mutant-probe.js",
  "tests/pikiio-frozen-authority-verifier.test.js",
  "tests/pikiio-heartbeat-automation-contract.test.js",
  "tests/pikiio-host-durability.test.js",
  "tests/pikiio-live-refresh-lock.test.js",
  "tests/pikiio-phase-proof.test.js",
  "tests/pikiio-phase-proof-envelope.test.js",
  "tests/pikiio-quality-execution.test.js",
  "tests/pikiio-quality-runner.test.js",
  "tests/pikiio-writer-lease-host-gate.test.js",
  "tests/features/pikiio-governed-heartbeat.feature",
  ".github/workflows/pikiio-proof-request.yml",
  ...PHASE_PROOF_AUTHORITY_PATHS,
].filter((value, index, values) => values.indexOf(value) === index));
const QUALITY_TEST_SUITE_REGISTRY = Object.freeze({
  "governance-unit-v1": Object.freeze({
    files: Object.freeze([
      "tests/pikiio-agent-governance.test.js",
      "tests/pikiio-frozen-authority-verifier.test.js",
      "tests/pikiio-github-oidc-collector.test.js",
      "tests/pikiio-heartbeat-automation-contract.test.js",
      "tests/pikiio-host-durability.test.js",
      "tests/pikiio-live-refresh-lock.test.js",
      "tests/pikiio-phase-attestation-signer.test.js",
      "tests/pikiio-phase-attestation.test.js",
      "tests/pikiio-phase-proof-envelope.test.js",
      "tests/pikiio-phase-proof.test.js",
      "tests/pikiio-quality-execution.test.js",
      "tests/pikiio-quality-runner.test.js",
      "tests/pikiio-sealed-git.test.js",
      "tests/pikiio-writer-lease-host-gate.test.js",
    ]),
    coverageIncludes: Object.freeze([
      "lib/pikiio-agent-governance.js",
      "lib/pikiio-frozen-authority-verifier.js",
      "lib/pikiio-github-oidc-collector.js",
      "lib/pikiio-host-durability.js",
      "lib/pikiio-live-refresh-lock.js",
      "lib/pikiio-phase-attestation.js",
      "lib/pikiio-phase-proof-envelope.js",
      "lib/pikiio-phase-proof.js",
      "lib/pikiio-quality-canonical.js",
      "lib/pikiio-quality-execution.js",
      "lib/pikiio-quality-runner.js",
      "lib/pikiio-sealed-git.js",
      "scripts/pikiio-agent-writer-lease.js",
      "scripts/pikiio-github-oidc-collector-command.js",
      "scripts/pikiio-phase-attestation-signer.js",
      "scripts/verify-pikiio-frozen-authority.js",
    ]),
    shards: Object.freeze([
      Object.freeze({
        id: "agent-governance",
        files: Object.freeze([
          "tests/pikiio-agent-governance.test.js",
          "tests/pikiio-heartbeat-automation-contract.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-agent-governance.js",
        ]),
      }),
      Object.freeze({
        id: "frozen-authority",
        files: Object.freeze([
          "tests/pikiio-frozen-authority-verifier.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-frozen-authority-verifier.js",
          "scripts/verify-pikiio-frozen-authority.js",
        ]),
      }),
      Object.freeze({
        id: "github-oidc",
        files: Object.freeze([
          "tests/pikiio-github-oidc-collector.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-github-oidc-collector.js",
          "scripts/pikiio-github-oidc-collector-command.js",
        ]),
      }),
      Object.freeze({
        id: "host-and-lease",
        files: Object.freeze([
          "tests/pikiio-host-durability.test.js",
          "tests/pikiio-writer-lease-host-gate.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-host-durability.js",
          "scripts/pikiio-agent-writer-lease.js",
        ]),
      }),
      Object.freeze({
        id: "live-refresh-lock",
        files: Object.freeze([
          "tests/pikiio-live-refresh-lock.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-live-refresh-lock.js",
        ]),
      }),
      Object.freeze({
        id: "phase-attestation",
        files: Object.freeze([
          "tests/pikiio-phase-attestation-signer.test.js",
          "tests/pikiio-phase-attestation.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-phase-attestation.js",
          "scripts/pikiio-phase-attestation-signer.js",
        ]),
      }),
      Object.freeze({
        id: "phase-proof",
        files: Object.freeze([
          "tests/pikiio-phase-proof.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-phase-proof.js",
        ]),
      }),
      Object.freeze({
        id: "phase-proof-envelope",
        files: Object.freeze([
          "tests/pikiio-phase-proof-envelope.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-phase-proof-envelope.js",
        ]),
      }),
      Object.freeze({
        id: "quality-runner",
        files: Object.freeze([
          "tests/pikiio-quality-execution.test.js",
          "tests/pikiio-quality-runner.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-quality-canonical.js",
          "lib/pikiio-quality-execution.js",
          "lib/pikiio-quality-runner.js",
        ]),
      }),
      Object.freeze({
        id: "sealed-git",
        files: Object.freeze([
          "tests/pikiio-sealed-git.test.js",
        ]),
        coverageIncludes: Object.freeze([
          "lib/pikiio-sealed-git.js",
        ]),
      }),
    ]),
  }),
  "truth-liveness-unit-v1": Object.freeze({
    files: Object.freeze([
      "tests/truth/pikiio-truth-liveness.test.js",
    ]),
    coverageIncludes: Object.freeze([
      "scripts/verify-pikiio-truth-phase-gherkin.js",
    ]),
  }),
  "truth-soak-unit-v1": Object.freeze({
    files: Object.freeze([
      "tests/truth/pikiio-truth-soak.test.js",
    ]),
    coverageIncludes: Object.freeze([
      "scripts/verify-pikiio-truth-phase-gherkin.js",
    ]),
  }),
  "action-claim-native-v1": Object.freeze({
    files: Object.freeze([
      "tests/action/pikiio-claim-native-planner.test.js",
    ]),
    coverageIncludes: Object.freeze([
      "scripts/verify-pikiio-action-phase-gherkin.js",
    ]),
  }),
  "action-shadow-v1": Object.freeze({
    files: Object.freeze([
      "tests/action/pikiio-action-shadow.test.js",
    ]),
    coverageIncludes: Object.freeze([
      "scripts/verify-pikiio-action-phase-gherkin.js",
    ]),
  }),
  "action-pod-proposal-v1": Object.freeze({
    files: Object.freeze([
      "tests/action/pikiio-pod-proposal.test.js",
    ]),
    coverageIncludes: Object.freeze([
      "scripts/verify-pikiio-action-phase-gherkin.js",
    ]),
  }),
});
const QUALITY_CHECK_REGISTRY = Object.freeze({
  "governance-gherkin-v1": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-pikiio-governance-gherkin.js"]),
  }),
  "governance-mutation-v1": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/mutate-pikiio-agent-governance.js"]),
  }),
  "truth-liveness-gherkin-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-pikiio-truth-phase-gherkin.js",
      "--profile=truth-liveness-gherkin-v1",
    ]),
  }),
  "truth-soak-gherkin-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-pikiio-truth-phase-gherkin.js",
      "--profile=truth-soak-gherkin-v1",
    ]),
  }),
  "truth-liveness-mutation-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/mutate-pikiio-truth-phase.js",
      "--profile=truth-liveness-mutation-v1",
    ]),
  }),
  "truth-soak-mutation-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/mutate-pikiio-truth-phase.js",
      "--profile=truth-soak-mutation-v1",
    ]),
  }),
  "action-claim-native-gherkin-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-pikiio-action-phase-gherkin.js",
      "--profile",
      "ACTION-01",
    ]),
  }),
  "action-shadow-gherkin-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-pikiio-action-phase-gherkin.js",
      "--profile",
      "ACTION-02",
    ]),
  }),
  "action-pod-proposal-gherkin-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-pikiio-action-phase-gherkin.js",
      "--profile",
      "ACTION-03",
    ]),
  }),
  "action-claim-native-mutation-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/mutate-pikiio-action-phase.js",
      "--profile",
      "ACTION-01",
    ]),
  }),
  "action-shadow-mutation-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/mutate-pikiio-action-phase.js",
      "--profile",
      "ACTION-02",
    ]),
  }),
  "action-pod-proposal-mutation-v1": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/mutate-pikiio-action-phase.js",
      "--profile",
      "ACTION-03",
    ]),
  }),
  "governance-focused": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-pikiio-agent-governance.js"]),
  }),
  "automation-contracts": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-automation-contracts.js"]),
  }),
  "protected-origin-auth": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-protected-origin-auth.js"]),
  }),
  "morning-relational-contract": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-morning-relational-refresh.js"]),
  }),
  "ylyi-contract": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-ylyi-production-proof.js"]),
  }),
  "beta-contract": Object.freeze({
    executable: "npm",
    args: Object.freeze(["--ignore-scripts", "run", "verify:beta"]),
    packageScript: Object.freeze({
      name: "verify:beta",
      sha256:
        "febba7524ee8db7da5a9202eb1d75df9e71deb9368665295f6cb300287783567",
    }),
  }),
  "git-diff-check": Object.freeze({
    executable: "git",
    args: Object.freeze(["diff", "--check"]),
  }),
  "production-default-deny": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/pikiio-agent-production-command.js",
      "preflight-refusal",
    ]),
  }),
  "truth-generic-acceptance-readiness": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-truth-generic-acceptance-readiness.js",
    ]),
  }),
  "truth-generic-source-acceptance-epochs": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-truth-full-migration-stack.js",
      "--generic-source-acceptance-only",
    ]),
  }),
  "truth-full-migration-stack": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-truth-full-migration-stack.js"]),
  }),
  "hosted-truth-shadow-runtime": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-hosted-truth-shadow-runtime.js"]),
  }),
  "truth-gmail-attachment-invalid-authority": Object.freeze({
    executable: "node",
    args: Object.freeze([
      "scripts/verify-truth-gmail-attachment-invalid-first-exhaustion-authority.js",
    ]),
  }),
  "primary-attachment-invalid-drain": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-primary-attachment-invalid-drain.js"]),
  }),
  "truth-audit-status": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-truth-audit-status.js"]),
  }),
  "production-truth-readiness": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-production-truth-readiness.js"]),
  }),
  "truth-agreement": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-truth-agreement.js"]),
  }),
  "truth-operator-browser-runtime": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-truth-operator-browser-runtime.js"]),
  }),
  "truth-operator-browser-api": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-truth-operator-browser-api.js"]),
  }),
  "truth-operator-browser-ui": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-truth-operator-browser-ui.js"]),
  }),
  "action-brain": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-action-brain.js"]),
  }),
  "brain-companion": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-ops-brain-companion.js"]),
  }),
  "control-room-trust": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-control-room-trust.js"]),
  }),
  "historical-replay": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-historical-shipment-replay.js"]),
  }),
  "platform-actions": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-platform-actions.js"]),
  }),
  "draft-safety": Object.freeze({
    executable: "node",
    args: Object.freeze(["scripts/verify-draft-safety.js"]),
  }),
});

class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GovernanceError";
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

function nonemptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonemptyString);
}

function exactStringArray(actual, required) {
  return (
    Array.isArray(actual) &&
    actual.length === required.length &&
    actual.every((value, index) => value === required[index])
  );
}

function expectedHeartbeatAutomationContract(threadId) {
  return {
    schema: "pikiio-heartbeat-automation-contract-v1",
    id: "pikiio-governed-builder-heartbeat",
    kind: "heartbeat",
    rrule: "FREQ=MINUTELY;INTERVAL=20",
    targetThreadId: threadId,
    promptPath: CANONICAL_HEARTBEAT_PROMPT_PATH,
    promptSha256: CANONICAL_HEARTBEAT_PROMPT_SHA256,
    statusBeforeActivation: "PAUSED",
    exactPromptRequired: true,
    activationRequired: true,
    productionEnabled: false,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createCapability() {
  return crypto.randomBytes(32).toString("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readBoundedRegularJson(filePath, maximumBytes = 48 * 1024 * 1024) {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maximumBytes
  ) {
    throw new GovernanceError(
      "BOUNDED_JSON_INPUT_INVALID",
      "Receipt input must be a bounded regular non-symlink file",
      { filePath, byteLength: stat.size, maximumBytes },
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size
    ) {
      throw new GovernanceError(
        "BOUNDED_JSON_INPUT_CHANGED",
        "Receipt input changed while it was being opened",
        { filePath },
      );
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncContainingDirectory(filePath) {
  const directory = path.dirname(filePath);
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  ensureRuntimeDirectory(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      mode,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    fsyncContainingDirectory(filePath);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A successful rename consumes the temporary name.
    }
    throw error;
  }
}

function writeJsonExclusiveAtomic(filePath, value, mode = 0o644) {
  ensureRuntimeDirectory(filePath);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      mode,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // link(2) creates the final name only if it does not already exist.
    // Unlike rename(2), this cannot replace a competing content address.
    fs.linkSync(temporary, filePath);
    fsyncContainingDirectory(filePath);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error?.code === "EEXIST") {
      throw new GovernanceError(
        "CONTENT_ADDRESSED_DESTINATION_EXISTS",
        "Content-addressed destination appeared during the atomic write",
        { filePath },
      );
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporary);
      fsyncContainingDirectory(filePath);
    } catch {
      // The final hard link, when created, owns the durable bytes.
    }
  }
}

function exactTransitionArtifactBytes(filePath, expectedSha256) {
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 2 ||
    before.size > 48 * 1024 * 1024
  ) {
    throw new GovernanceError(
      "PHASE_TRANSITION_ARTIFACT_UNSAFE",
      "Transition recovery found an unsafe artifact",
      { filePath },
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new GovernanceError(
        "PHASE_TRANSITION_ARTIFACT_CHANGED",
        "Transition artifact changed while recovery opened it",
        { filePath },
      );
    }
    const actualSha256 = sha256(fs.readFileSync(descriptor));
    if (actualSha256 !== expectedSha256) {
      throw new GovernanceError(
        "PHASE_TRANSITION_ARTIFACT_HASH_MISMATCH",
        "Transition recovery found artifact bytes that do not match the journal",
        { filePath, expectedSha256, actualSha256 },
      );
    }
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function transitionArtifactPath(repoRoot, relativePath, kind) {
  const pattern =
    kind === "completion"
      ? /^YLYI\/09_Proof_Receipts\/phase-completions\/[a-f0-9]{64}\.json$/
      : /^YLYI\/09_Proof_Receipts\/phase-proofs\/[a-f0-9]{64}\.json$/;
  if (!pattern.test(String(relativePath || ""))) {
    throw new GovernanceError(
      "PHASE_TRANSITION_JOURNAL_INVALID",
      "Transition journal artifact path is outside its exact proof namespace",
      { relativePath, kind },
    );
  }
  const resolvedRoot = path.resolve(repoRoot);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new GovernanceError(
      "PHASE_TRANSITION_JOURNAL_INVALID",
      "Transition journal artifact path escapes the repository",
      { relativePath, kind },
    );
  }
  return target;
}

function validatePhaseTransitionJournal(journal, repoRoot) {
  const errors = [];
  if (
    !isObject(journal) ||
    !exactStringArray(Object.keys(journal).sort(), [
      "afterLedgerSha256",
      "beforeLedgerSha256",
      "bundle",
      "completion",
      "journalHash",
      "ledgerPath",
      "recordedAt",
      "schema",
      "transactionId",
    ])
  ) {
    errors.push("transition journal has unexpected fields");
  }
  if (journal?.schema !== "pikiio-phase-transition-journal-v1") {
    errors.push("transition journal schema is invalid");
  }
  if (
    typeof journal?.transactionId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      journal.transactionId,
    ) ||
    !Number.isFinite(Date.parse(journal?.recordedAt)) ||
    new Date(Date.parse(journal?.recordedAt)).toISOString() !==
      journal.recordedAt ||
    journal?.ledgerPath !== PHASE_LEDGER_RELATIVE_PATH ||
    !SHA256_PATTERN.test(String(journal?.beforeLedgerSha256 || "")) ||
    !SHA256_PATTERN.test(String(journal?.afterLedgerSha256 || "")) ||
    journal?.beforeLedgerSha256 === journal?.afterLedgerSha256 ||
    !SHA256_PATTERN.test(String(journal?.journalHash || "")) ||
    computeHashWithoutField(journal, "journalHash") !== journal?.journalHash
  ) {
    errors.push("transition journal identity or hash is invalid");
  }
  for (const [kind, record] of Object.entries({
    completion: journal?.completion,
    bundle: journal?.bundle,
  })) {
    if (
      !isObject(record) ||
      !exactStringArray(Object.keys(record).sort(), [
        "bytesSha256",
        "path",
        "preexisting",
      ]) ||
      !SHA256_PATTERN.test(String(record?.bytesSha256 || "")) ||
      typeof record?.preexisting !== "boolean"
    ) {
      errors.push(`transition journal ${kind} record is invalid`);
      continue;
    }
    try {
      transitionArtifactPath(repoRoot, record.path, kind);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { valid: errors.length === 0, errors };
}

function removeTransitionJournal(journalPath) {
  fs.unlinkSync(journalPath);
  fsyncContainingDirectory(journalPath);
}

function recoverPhaseTransition({
  repoRoot = ROOT,
  journalPath = DEFAULT_PHASE_TRANSITION_JOURNAL_PATH,
} = {}) {
  if (!fs.existsSync(journalPath)) return { status: "none" };
  const journal = readBoundedRegularJson(journalPath, 64 * 1024);
  const validation = validatePhaseTransitionJournal(journal, repoRoot);
  if (!validation.valid) {
    throw new GovernanceError(
      "PHASE_TRANSITION_JOURNAL_INVALID",
      "Phase transition recovery journal failed closed",
      { errors: validation.errors, journalPath },
    );
  }
  const ledgerPath = path.join(repoRoot, PHASE_LEDGER_RELATIVE_PATH);
  const ledgerSha256 = sha256(stableJson(readBoundedRegularJson(ledgerPath)));
  const artifacts = [
    {
      ...journal.completion,
      absolutePath: transitionArtifactPath(
        repoRoot,
        journal.completion.path,
        "completion",
      ),
    },
    {
      ...journal.bundle,
      absolutePath: transitionArtifactPath(
        repoRoot,
        journal.bundle.path,
        "bundle",
      ),
    },
  ];
  if (ledgerSha256 === journal.afterLedgerSha256) {
    for (const artifact of artifacts) {
      if (
        !exactTransitionArtifactBytes(
          artifact.absolutePath,
          artifact.bytesSha256,
        )
      ) {
        throw new GovernanceError(
          "PHASE_TRANSITION_COMMITTED_ARTIFACT_MISSING",
          "Committed transition is missing its exact durable artifact",
          { path: artifact.path },
        );
      }
      fsyncContainingDirectory(artifact.absolutePath);
    }
    fsyncContainingDirectory(ledgerPath);
    removeTransitionJournal(journalPath);
    return { status: "committed", transactionId: journal.transactionId };
  }
  if (ledgerSha256 !== journal.beforeLedgerSha256) {
    throw new GovernanceError(
      "PHASE_TRANSITION_LEDGER_DIVERGED",
      "Transition recovery ledger matches neither side of the journal",
      { ledgerSha256 },
    );
  }
  for (const artifact of artifacts) {
    if (artifact.preexisting) {
      if (
        !exactTransitionArtifactBytes(
          artifact.absolutePath,
          artifact.bytesSha256,
        )
      ) {
        throw new GovernanceError(
          "PHASE_TRANSITION_PREEXISTING_ARTIFACT_CHANGED",
          "A pre-existing transition artifact changed during recovery",
          { path: artifact.path },
        );
      }
      continue;
    }
    const present = exactTransitionArtifactBytes(
      artifact.absolutePath,
      artifact.bytesSha256,
    );
    if (present) {
      fs.unlinkSync(artifact.absolutePath);
      fsyncContainingDirectory(artifact.absolutePath);
    }
  }
  removeTransitionJournal(journalPath);
  return { status: "rolled_back", transactionId: journal.transactionId };
}

function loadPhaseLedger(filePath = DEFAULT_LEDGER_PATH) {
  if (filePath !== DEFAULT_LEDGER_PATH && process.env.NODE_ENV !== "test") {
    throw new GovernanceError(
      "ALTERNATE_PHASE_LEDGER_REFUSED",
      "Autonomous authority may only use the checked-in canonical phase ledger",
      { requested: filePath, canonical: DEFAULT_LEDGER_PATH },
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new GovernanceError(
      "PHASE_LEDGER_MISSING",
      "Pikiio phase ledger is missing",
      { filePath },
    );
  }
  return readJson(filePath);
}

function validateQualityProfile(profileId, profile, errors) {
  if (!isObject(profile)) {
    errors.push(`qualityPolicy.profiles.${profileId} must be an object`);
    return;
  }
  for (const [key, minimum] of Object.entries(REQUIRED_CRITICAL_PROFILE)) {
    const value = profile[key];
    if (!Number.isFinite(value)) {
      errors.push(`qualityPolicy.profiles.${profileId}.${key} must be numeric`);
      continue;
    }
    if (key.startsWith("maximum")) {
      if (value !== 0) {
        errors.push(`qualityPolicy.profiles.${profileId}.${key} must remain zero`);
      }
    } else if (value < minimum) {
      errors.push(
        `qualityPolicy.profiles.${profileId}.${key} cannot be below ${minimum}`,
      );
    }
  }
}

function validateAllowedPathRule(rule, prefix, errors) {
  if (!nonemptyString(rule)) {
    errors.push(`${prefix} must be a non-empty path rule`);
    return;
  }
  if (path.isAbsolute(rule) || rule.includes("\\") || rule.includes("..")) {
    errors.push(`${prefix} must be a repository-relative POSIX path rule`);
  }
  const wildcardCount = [...rule].filter((character) => character === "*").length;
  if (wildcardCount > 1 || (wildcardCount === 1 && !rule.endsWith("*"))) {
    errors.push(`${prefix} may only use one trailing prefix wildcard`);
  }
  if (rule === "*") {
    errors.push(`${prefix} cannot grant repository-wide write authority`);
  }
}

function canonicalLedgerQualityPlan(phaseId) {
  const registryPlan = phaseProofForId(
    CANONICAL_PHASE_PROOF_REGISTRY,
    phaseId,
  ).qualityPlan;
  return {
    schema: "pikiio-phase-quality-plan-v2",
    syntaxFiles: [...registryPlan.syntaxFiles],
    testSuiteId: registryPlan.suiteId,
    gherkinCheckId: registryPlan.gherkinId,
    mutationCheckId: registryPlan.mutationId,
    focusedCheckIds: [...registryPlan.focusedCheckIds],
    neighborCheckIds: [...registryPlan.neighborCheckIds],
    broadCheckIds: [...registryPlan.broadCheckIds],
    productionShapedCheckIds: [...registryPlan.productionShapedCheckIds],
    naturalEvidenceRequired: registryPlan.naturalEvidenceRequired,
    browserEvidenceRequired: registryPlan.browserEvidenceRequired,
  };
}

function validateQualityPlan(plan, phaseId, prefix, errors) {
  if (!isObject(plan) || plan.schema !== "pikiio-phase-quality-plan-v2") {
    errors.push(`${prefix} must be a pikiio-phase-quality-plan-v2 object`);
    return;
  }
  if (!nonemptyStringArray(plan.syntaxFiles)) {
    errors.push(`${prefix}.syntaxFiles must be non-empty`);
  } else {
    plan.syntaxFiles.forEach((relativePath, index) => {
      if (
        path.isAbsolute(relativePath) ||
        relativePath.includes("\\") ||
        relativePath.split("/").includes("..") ||
        !relativePath.endsWith(".js")
      ) {
        errors.push(`${prefix}.syntaxFiles[${index}] must be a repository JavaScript path`);
      }
    });
  }
  if (!isObject(QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId])) {
    errors.push(`${prefix}.testSuiteId must name an immutable test suite`);
  }
  for (const key of ["gherkinCheckId", "mutationCheckId"]) {
    if (!isObject(QUALITY_CHECK_REGISTRY[plan[key]])) {
      errors.push(`${prefix}.${key} must name an immutable quality check`);
    }
  }
  for (const key of [
    "focusedCheckIds",
    "neighborCheckIds",
    "broadCheckIds",
    "productionShapedCheckIds",
  ]) {
    if (!nonemptyStringArray(plan[key])) {
      errors.push(`${prefix}.${key} must be a non-empty string array`);
    } else {
      plan[key].forEach((checkId, index) => {
        if (!isObject(QUALITY_CHECK_REGISTRY[checkId])) {
          errors.push(`${prefix}.${key}[${index}] names an unknown quality check`);
        }
      });
    }
  }
  const allCheckIds = [
    plan.gherkinCheckId,
    plan.mutationCheckId,
    ...(Array.isArray(plan.focusedCheckIds) ? plan.focusedCheckIds : []),
    ...(Array.isArray(plan.neighborCheckIds) ? plan.neighborCheckIds : []),
    ...(Array.isArray(plan.broadCheckIds) ? plan.broadCheckIds : []),
    ...(Array.isArray(plan.productionShapedCheckIds)
      ? plan.productionShapedCheckIds
      : []),
  ].filter(nonemptyString);
  if (new Set(allCheckIds).size !== allCheckIds.length) {
    errors.push(`${prefix} cannot execute the same quality check in multiple layers`);
  }
  if (typeof plan.naturalEvidenceRequired !== "boolean") {
    errors.push(`${prefix}.naturalEvidenceRequired must be boolean`);
  }
  if (typeof plan.browserEvidenceRequired !== "boolean") {
    errors.push(`${prefix}.browserEvidenceRequired must be boolean`);
  }
  try {
    if (
      stableJson(plan) !==
      stableJson(canonicalLedgerQualityPlan(phaseId))
    ) {
      errors.push(`${prefix} must equal the immutable phase-proof registry plan`);
    }
  } catch {
    errors.push(`${prefix} names a phase absent from the phase-proof registry`);
  }
}

function validateProductionAuthority(authority, prefix, errors) {
  if (!isObject(authority)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (typeof authority.enabled !== "boolean") {
    errors.push(`${prefix}.enabled must be boolean`);
    return;
  }
  if (!Array.isArray(authority.allowedLiveProbes)) {
    errors.push(`${prefix}.allowedLiveProbes must be an array`);
  }
  if (!authority.enabled) {
    if (authority.grant !== null) {
      errors.push(`${prefix}.grant must be null while authority is disabled`);
    }
    return;
  }
  const grant = authority.grant;
  if (
    !isObject(grant) ||
    grant.schema !== "pikiio-production-grant-v3" ||
    !exactStringArray(Object.keys(grant).sort(), [
      "branch",
      "candidateCommit",
      "deployment",
      "expiresAt",
      "migrations",
      "phaseCandidateReceiptSha256",
      "phaseProofBundleSha256",
      "phaseRehearsalReceiptSha256",
      "qualityReceiptSha256",
      "schema",
    ])
  ) {
    errors.push(`${prefix}.grant must be the exact pikiio-production-grant-v3`);
    return;
  }
  if (!COMMIT_PATTERN.test(String(grant.candidateCommit || ""))) {
    errors.push(`${prefix}.grant.candidateCommit must be a full Git commit`);
  }
  if (grant.branch !== "main") {
    errors.push(`${prefix}.grant.branch must be main`);
  }
  if (!SHA256_PATTERN.test(String(grant.qualityReceiptSha256 || ""))) {
    errors.push(`${prefix}.grant.qualityReceiptSha256 must be sha256`);
  }
  if (!SHA256_PATTERN.test(String(grant.phaseProofBundleSha256 || ""))) {
    errors.push(`${prefix}.grant.phaseProofBundleSha256 must be sha256`);
  }
  for (const field of [
    "phaseCandidateReceiptSha256",
    "phaseRehearsalReceiptSha256",
  ]) {
    if (!SHA256_PATTERN.test(String(grant[field] || ""))) {
      errors.push(`${prefix}.grant.${field} must be sha256`);
    }
  }
  if (!nonemptyString(grant.expiresAt) || !Number.isFinite(Date.parse(grant.expiresAt))) {
    errors.push(`${prefix}.grant.expiresAt must be an ISO timestamp`);
  }
  if (!Array.isArray(grant.migrations)) {
    errors.push(`${prefix}.grant.migrations must be an array`);
  } else {
    const seenMigrationPaths = new Set();
    grant.migrations.forEach((migration, index) => {
      if (
        !isObject(migration) ||
        !exactStringArray(Object.keys(migration).sort(), ["path", "sha256"]) ||
        !nonemptyString(migration.path) ||
        path.isAbsolute(migration.path) ||
        migration.path.includes("\\") ||
        migration.path.split("/").includes("..") ||
        path.posix.normalize(migration.path) !== migration.path ||
        seenMigrationPaths.has(migration.path) ||
        !SHA256_PATTERN.test(String(migration.sha256 || ""))
      ) {
        errors.push(`${prefix}.grant.migrations[${index}] is invalid`);
      }
      seenMigrationPaths.add(migration?.path);
    });
  }
  if (
    !isObject(grant.deployment) ||
    !exactStringArray(Object.keys(grant.deployment).sort(), [
      "enabled",
      "tree",
    ]) ||
    typeof grant.deployment.enabled !== "boolean" ||
    (grant.deployment.enabled &&
      !/^[a-f0-9]{40}$/.test(String(grant.deployment.tree || ""))) ||
    (!grant.deployment.enabled && grant.deployment.tree !== null)
  ) {
    errors.push(`${prefix}.grant.deployment is invalid`);
  }
}

function validatePhaseLedger(ledger) {
  const errors = [];
  if (!isObject(ledger)) {
    return { valid: false, errors: ["ledger must be an object"] };
  }
  if (ledger.schema !== "pikiio-agent-phase-ledger-v2") {
    errors.push("schema must be pikiio-agent-phase-ledger-v2");
  }
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 2) {
    errors.push("revision must be an integer at or above two");
  }
  if (!nonemptyString(ledger.mission)) errors.push("mission must be a non-empty string");
  if (!nonemptyString(ledger.activePhaseId)) {
    errors.push("activePhaseId must be a non-empty string");
  }
  if (!isObject(ledger.codexGoal)) {
    errors.push("codexGoal must be an object");
  } else {
    if (!nonemptyString(ledger.codexGoal.threadId)) {
      errors.push("codexGoal.threadId must be a non-empty string");
    }
    if (!nonemptyString(ledger.codexGoal.objective)) {
      errors.push("codexGoal.objective must be a non-empty string");
    }
    if (
      !SHA256_PATTERN.test(String(ledger.codexGoal.objectiveSha256 || "")) ||
      sha256(String(ledger.codexGoal.objective || "")) !==
        ledger.codexGoal.objectiveSha256
    ) {
      errors.push("codexGoal objective hash does not match its objective");
    }
  }
  const expectedAutomation = expectedHeartbeatAutomationContract(
    ledger.codexGoal?.threadId,
  );
  if (
    !isObject(ledger.automationContract) ||
    stableJson(ledger.automationContract) !== stableJson(expectedAutomation)
  ) {
    errors.push(
      "automationContract must equal the immutable checked-in heartbeat contract",
    );
  }

  if (!isObject(ledger.policy)) {
    errors.push("policy must be an object");
  } else {
    for (const [key, required] of Object.entries(REQUIRED_POLICY_VALUES)) {
      if (ledger.policy[key] !== required) {
        errors.push(`policy.${key} must remain ${required}`);
      }
    }
    if (
      !exactStringArray(
        ledger.policy.forbiddenExternalEffects,
        REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS,
      )
    ) {
      errors.push("policy.forbiddenExternalEffects must equal the canonical deny set");
    }
    const morning = ledger.policy.morningRefreshPriorityWindow;
    if (
      !isObject(morning) ||
      morning.timeZone !== DEFAULT_TIME_ZONE ||
      morning.startsAt !== DEFAULT_MORNING_START ||
      morning.endsOnTerminalReceipt !== true ||
      morning.minimumBuilderSliceMinutes !== 15
    ) {
      errors.push("policy.morningRefreshPriorityWindow must equal the canonical policy");
    }
  }

  const quality = ledger.qualityPolicy;
  if (
    !isObject(quality) ||
    quality.schema !== "pikiio-quality-gauntlet-v2" ||
    quality.bootstrapRevision !== 1 ||
    quality.noThresholdChangeWithBehaviorChange !== true ||
    quality.noTestWeakeningWithBehaviorChange !== true ||
    stableJson(quality.phaseProofRegistry) !==
      stableJson(REQUIRED_PHASE_PROOF_REGISTRY_CONTRACT) ||
    !exactStringArray(quality.requiredEvidence, REQUIRED_QUALITY_EVIDENCE) ||
    !exactStringArray(quality.trustedGatePaths, REQUIRED_TRUSTED_GATE_PATHS) ||
    stableJson(quality.approvedToolchain) !==
      stableJson(REQUIRED_QUALITY_TOOLCHAIN) ||
    !isObject(quality.profiles)
  ) {
    errors.push("qualityPolicy must equal the immutable Pikiio quality contract");
  } else {
    for (const [profileId, profile] of Object.entries(quality.profiles)) {
      validateQualityProfile(profileId, profile, errors);
    }
    if (!isObject(quality.profiles.critical)) {
      errors.push("qualityPolicy.profiles.critical is required");
    }
  }

  if (!isObject(ledger.baseline) || !nonemptyString(ledger.baseline.branch)) {
    errors.push("baseline.branch must be a non-empty string");
  }
  if (!COMMIT_PATTERN.test(String(ledger.baseline?.startCommit || ""))) {
    errors.push("baseline.startCommit must be a full Git commit");
  }
  if (!Array.isArray(ledger.baseline?.preExistingDirty)) {
    errors.push("baseline.preExistingDirty must be an array");
  } else {
    ledger.baseline.preExistingDirty.forEach((entry, index) => {
      if (!isObject(entry)) {
        errors.push(`baseline.preExistingDirty[${index}] must be an object`);
        return;
      }
      if (!nonemptyString(entry.path)) {
        errors.push(`baseline.preExistingDirty[${index}].path is required`);
      } else if (
        path.isAbsolute(entry.path) ||
        entry.path.includes("\\") ||
        entry.path.includes("..") ||
        entry.path.includes("*")
      ) {
        errors.push(
          `baseline.preExistingDirty[${index}].path must remain repository-relative`,
        );
      }
      if (entry.algorithm !== "sha256-v1-path-content") {
        errors.push(`baseline.preExistingDirty[${index}].algorithm is unsupported`);
      }
      if (!SHA256_PATTERN.test(String(entry.treeDigest || ""))) {
        errors.push(`baseline.preExistingDirty[${index}].treeDigest must be sha256`);
      }
      if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount < 0) {
        errors.push(
          `baseline.preExistingDirty[${index}].fileCount must be a non-negative integer`,
        );
      }
      if (
        entry.preserve !== true ||
        entry.excludeFromGit !== true ||
        entry.excludeFromDeploy !== true
      ) {
        errors.push(`baseline.preExistingDirty[${index}] must remain preserved and excluded`);
      }
    });
  }

  if (!Array.isArray(ledger.phases) || ledger.phases.length === 0) {
    errors.push("phases must be a non-empty array");
    return { valid: false, errors };
  }

  const byId = new Map();
  ledger.phases.forEach((phase, index) => {
    const prefix = `phases[${index}]`;
    if (!isObject(phase)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!nonemptyString(phase.id)) errors.push(`${prefix}.id is required`);
    if (byId.has(phase.id)) errors.push(`duplicate phase id ${phase.id}`);
    byId.set(phase.id, phase);
    if (!nonemptyString(phase.name)) errors.push(`${prefix}.name is required`);
    if (
      ACTIVE_STATUSES.has(phase.status) &&
      !COMMIT_PATTERN.test(String(phase.scopeBaseCommit || ""))
    ) {
      errors.push(`${prefix}.scopeBaseCommit must be a full commit while active`);
    } else if (!nonemptyString(phase.scopeBaseCommit)) {
      errors.push(`${prefix}.scopeBaseCommit is required`);
    }
    if (!ALLOWED_PHASE_STATUSES.has(phase.status)) {
      errors.push(`${prefix}.status is invalid`);
    }
    if (!Number.isFinite(phase.priority)) errors.push(`${prefix}.priority must be numeric`);
    if (!Array.isArray(phase.dependsOn)) errors.push(`${prefix}.dependsOn must be an array`);
    if (!nonemptyString(phase.lane)) errors.push(`${prefix}.lane is required`);
    if (
      !nonemptyString(phase.qualityProfile) ||
      !isObject(quality?.profiles?.[phase.qualityProfile])
    ) {
      errors.push(`${prefix}.qualityProfile must name a defined profile`);
    }
    if (!nonemptyString(phase.objective)) errors.push(`${prefix}.objective is required`);
    for (const key of ["allowedActions", "forbiddenActions", "stopConditions"]) {
      if (!nonemptyStringArray(phase[key])) {
        errors.push(`${prefix}.${key} must be a non-empty string array`);
      }
    }
    if (!nonemptyStringArray(phase.allowedPaths)) {
      errors.push(`${prefix}.allowedPaths must be a non-empty string array`);
    } else {
      phase.allowedPaths.forEach((rule, ruleIndex) => {
        validateAllowedPathRule(rule, `${prefix}.allowedPaths[${ruleIndex}]`, errors);
      });
    }
    if (
      !isObject(phase.externalEffects) ||
      phase.externalEffects.inheritsGlobalForbidden !== true ||
      !Array.isArray(phase.externalEffects.allowedReadOnly) ||
      !phase.externalEffects.allowedReadOnly.every(nonemptyString)
    ) {
      errors.push(`${prefix}.externalEffects must inherit the global deny set`);
    }
    if (
      !isObject(phase.verification) ||
      !nonemptyStringArray(phase.verification.focused) ||
      !nonemptyStringArray(phase.verification.broad)
    ) {
      errors.push(`${prefix}.verification must contain focused and broad commands`);
    }
    validateQualityPlan(
      phase.qualityPlan,
      phase.id,
      `${prefix}.qualityPlan`,
      errors,
    );
    validateProductionAuthority(
      phase.productionAuthority,
      `${prefix}.productionAuthority`,
      errors,
    );
    if (
      !isObject(phase.promotion) ||
      !Number.isSafeInteger(phase.promotion.requiredNaturalCycles) ||
      phase.promotion.requiredNaturalCycles < 0 ||
      !Number.isFinite(phase.promotion.minimumSoakHours) ||
      phase.promotion.minimumSoakHours < 0 ||
      !nonemptyStringArray(phase.promotion.criteria)
    ) {
      errors.push(`${prefix}.promotion is incomplete`);
    } else {
      if (
        (phase.promotion.requiredNaturalCycles > 0 ||
          phase.promotion.minimumSoakHours > 0) &&
        phase.qualityPlan?.naturalEvidenceRequired !== true
      ) {
        errors.push(`${prefix}.qualityPlan must require natural-cycle evidence`);
      }
      if (
        phase.promotion.criteria.some((criterion) =>
          /\b(?:browser|visible|operator-visible)\b/i.test(criterion),
        ) &&
        phase.qualityPlan?.browserEvidenceRequired !== true
      ) {
        errors.push(`${prefix}.qualityPlan must require browser evidence`);
      }
    }
    if (!isObject(phase.rollback) || !nonemptyString(phase.rollback.strategy)) {
      errors.push(`${prefix}.rollback.strategy is required`);
    }
  });

  const active = ledger.phases.filter(
    (phase) => isObject(phase) && ACTIVE_STATUSES.has(phase.status),
  );
  if (active.length !== 1) {
    errors.push(`exactly one phase must be active; found ${active.length}`);
  } else if (active[0].id !== ledger.activePhaseId) {
    errors.push("activePhaseId does not name the only active phase");
  }

  for (const phase of ledger.phases) {
    if (!isObject(phase)) continue;
    for (const dependency of phase.dependsOn || []) {
      if (!byId.has(dependency)) {
        errors.push(`${phase.id} depends on missing phase ${dependency}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function selectActivePhase(ledger) {
  const validation = validatePhaseLedger(ledger);
  if (!validation.valid) {
    throw new GovernanceError(
      "PHASE_LEDGER_INVALID",
      "Pikiio phase ledger is invalid",
      { errors: validation.errors },
    );
  }
  const phase = ledger.phases.find((candidate) => candidate.id === ledger.activePhaseId);
  const unmet = phase.dependsOn.filter((id) => {
    const dependency = ledger.phases.find((candidate) => candidate.id === id);
    return !dependency || !TERMINAL_DEPENDENCY_STATUSES.has(dependency.status);
  });
  if (unmet.length) {
    throw new GovernanceError(
      "PHASE_DEPENDENCY_UNMET",
      `Active phase ${phase.id} has unmet dependencies`,
      { unmet },
    );
  }
  return phase;
}

function phaseCompletionReceiptRelativePath(receiptHash) {
  if (!SHA256_PATTERN.test(String(receiptHash || ""))) {
    throw new GovernanceError(
      "PHASE_COMPLETION_RECEIPT_HASH_INVALID",
      "Phase completion receipt hash must be a SHA-256 digest",
    );
  }
  return `${PHASE_COMPLETION_RECEIPT_DIR_RELATIVE_PATH}/${receiptHash}.json`;
}

function phaseProofBundleRelativePath(bundleHash) {
  if (!SHA256_PATTERN.test(String(bundleHash || ""))) {
    throw new GovernanceError(
      "PHASE_PROOF_BUNDLE_HASH_INVALID",
      "Phase proof bundle hash must be a SHA-256 digest",
    );
  }
  return `${PHASE_PROOF_BUNDLE_DIR_RELATIVE_PATH}/${bundleHash}.json`;
}

function collectPhaseProofArtifactAddresses(chain, qualityReceipt = null) {
  const addresses = [];
  const add = (receipt) => {
    if (isObject(receipt?.rawArtifact)) {
      addresses.push(receipt.rawArtifact.address);
    }
  };
  add(chain?.candidate);
  add(chain?.rehearsal);
  add(chain?.change);
  add(chain?.promotion);
  for (const receipt of chain?.promotion?.naturalEvidence || []) add(receipt);
  for (const receipt of chain?.promotion?.browserEvidence || []) add(receipt);
  for (const judge of [
    qualityReceipt?.primaryJudge,
    qualityReceipt?.cleanJudge,
  ]) {
    const digest = judge?.rawArtifact?.artifactSha256;
    if (SHA256_PATTERN.test(String(digest || ""))) {
      addresses.push(`sha256:${digest}`);
    }
  }
  for (const receipt of [
    chain?.candidate,
    chain?.rehearsal,
    chain?.change,
    chain?.promotion,
  ]) {
    if (SHA256_PATTERN.test(String(receipt?.receiptHash || ""))) {
      addresses.push(`sha256:${receipt.receiptHash}`);
    }
  }
  return [...new Set(addresses)].sort();
}

function validatePhaseProofBundle(
  bundle,
  {
    ledger,
    phase,
    qualityReceipt,
    repoRoot = ROOT,
    requireFullChain = false,
    nowMs = Date.now(),
  } = {},
) {
  const errors = [];
  if (!isObject(bundle)) {
    return {
      valid: false,
      productionChangeAuthorized: false,
      errors: ["phase proof bundle must be an object"],
    };
  }
  if (
    !exactStringArray(Object.keys(bundle).sort(), [
      "artifacts",
      "bundleHash",
      "candidateCommit",
      "chain",
      "ledgerRevision",
      "phaseId",
      "qualityReceiptHash",
      "schema",
    ])
  ) {
    errors.push("phase proof bundle has unexpected fields");
  }
  if (bundle.schema !== "pikiio-phase-proof-bundle-v1") {
    errors.push("phase proof bundle schema is invalid");
  }
  if (
    !SHA256_PATTERN.test(String(bundle.bundleHash || "")) ||
    computeHashWithoutField(bundle, "bundleHash") !== bundle.bundleHash
  ) {
    errors.push("phase proof bundle hash does not match its contents");
  }
  if (
    !ledger ||
    !phase ||
    bundle.phaseId !== phase?.id ||
    bundle.ledgerRevision !== ledger?.revision ||
    bundle.candidateCommit !== qualityReceipt?.head ||
    bundle.qualityReceiptHash !== qualityReceipt?.receiptHash
  ) {
    errors.push("phase proof bundle ledger, phase, candidate, or quality binding is invalid");
  }
  if (
    !isObject(bundle.chain) ||
    !exactStringArray(Object.keys(bundle.chain).sort(), [
      "candidate",
      "change",
      "promotion",
      "rehearsal",
    ])
  ) {
    errors.push("phase proof bundle chain must contain exactly four receipt slots");
  }
  if (
    requireFullChain &&
    ["candidate", "rehearsal", "change", "promotion"].some(
      (field) => !isObject(bundle.chain?.[field]),
    )
  ) {
    errors.push("phase proof bundle lacks the complete four-receipt chain");
  }
  if (
    !requireFullChain &&
    (!isObject(bundle.chain?.candidate) ||
      !isObject(bundle.chain?.rehearsal) ||
      bundle.chain?.change !== null ||
      bundle.chain?.promotion !== null)
  ) {
    errors.push(
      "pre-change phase proof bundle must contain only candidate and rehearsal receipts",
    );
  }

  const artifacts = new Map();
  if (
    !Array.isArray(bundle.artifacts) ||
    bundle.artifacts.length > 512
  ) {
    errors.push("phase proof bundle artifacts are missing or exceed the bound");
  } else {
    let totalBytes = 0;
    let totalEncodedBytes = 0;
    let priorAddress = "";
    for (const [index, artifact] of bundle.artifacts.entries()) {
      const prefix = `phase proof artifact ${index + 1}`;
      if (
        !isObject(artifact) ||
        !exactStringArray(Object.keys(artifact).sort(), [
          "address",
          "bytes",
          "encoding",
          "sha256",
        ]) ||
        artifact.encoding !== "base64" ||
        !SHA256_PATTERN.test(String(artifact.sha256 || "")) ||
        artifact.address !== `sha256:${artifact.sha256}` ||
        typeof artifact.bytes !== "string" ||
        Buffer.byteLength(artifact.bytes, "utf8") > 45 * 1024 * 1024 ||
        artifact.address <= priorAddress
      ) {
        errors.push(`${prefix} is invalid`);
        continue;
      }
      priorAddress = artifact.address;
      totalEncodedBytes += Buffer.byteLength(artifact.bytes, "utf8");
      const bytes = Buffer.from(artifact.bytes, "base64");
      totalBytes += bytes.length;
      if (
        bytes.toString("base64") !== artifact.bytes ||
        sha256(bytes) !== artifact.sha256 ||
        artifacts.has(artifact.address)
      ) {
        errors.push(`${prefix} is non-canonical, duplicated, or hash-mismatched`);
        continue;
      }
      artifacts.set(artifact.address, bytes);
    }
    if (totalBytes > 32 * 1024 * 1024) {
      errors.push("phase proof artifact bytes exceed the 32 MiB bundle bound");
    }
    if (totalEncodedBytes > 48 * 1024 * 1024) {
      errors.push("phase proof encoded artifacts exceed the 48 MiB bundle bound");
    }
    const expectedAddresses = collectPhaseProofArtifactAddresses(
      bundle.chain,
      qualityReceipt,
    );
    if (
      !exactStringArray([...artifacts.keys()].sort(), expectedAddresses)
    ) {
      errors.push("phase proof bundle artifact set does not exactly match its receipts");
    }
    for (const [role, receipt] of Object.entries({
      candidate: bundle.chain?.candidate,
      rehearsal: bundle.chain?.rehearsal,
      change: bundle.chain?.change,
      promotion: bundle.chain?.promotion,
    })) {
      if (!isObject(receipt)) continue;
      const unsigned = { ...receipt };
      delete unsigned.receiptHash;
      const expectedBytes = Buffer.from(stableJson(unsigned), "utf8");
      const stored = artifacts.get(`sha256:${receipt.receiptHash}`);
      if (
        !Buffer.isBuffer(stored) ||
        stored.length !== expectedBytes.length ||
        !crypto.timingSafeEqual(stored, expectedBytes)
      ) {
        errors.push(
          `phase proof ${role} receipt artifact does not match its canonical body`,
        );
      }
    }
  }

  let proof = {
    valid: false,
    productionChangeAuthorized: false,
    errors: [],
  };
  if (ledger && phase && isObject(bundle.chain)) {
    const options = {
      registry: CANONICAL_PHASE_PROOF_REGISTRY,
      repoRoot,
      ledgerRevision: ledger.revision,
      baseQualityProfile:
        ledger.qualityPolicy?.profiles?.[phase.qualityProfile],
      scopeBaseCommit: phase.scopeBaseCommit,
      artifacts,
      nowMs,
    };
    proof = requireFullChain
      ? validatePhaseProofChain(bundle.chain, options)
      : validatePhaseRehearsalAuthorization(
          {
            candidate: bundle.chain.candidate,
            rehearsal: bundle.chain.rehearsal,
          },
          options,
        );
    if (!proof.valid) {
      errors.push(
        ...proof.errors.map((error) => `phase proof: ${error}`),
      );
    }
  }

  const expectedPopulations = {
    unitTests: qualityReceipt?.metrics?.testsPerRun,
    criticalMutants:
      qualityReceipt?.metrics?.minimumCriticalMutationPopulation,
    gherkinScenarios:
      qualityReceipt?.metrics?.minimumGherkinScenarioPopulation,
  };
  if (
    !qualityReceipt ||
    bundle.chain?.candidate?.candidateCommit !== qualityReceipt.head ||
    bundle.chain?.candidate?.candidateTree !== qualityReceipt.candidateTree ||
    stableJson(bundle.chain?.candidate?.populations) !==
      stableJson(expectedPopulations) ||
    stableJson(bundle.chain?.candidate?.changedPaths) !==
      stableJson(qualityReceipt.antiWeakening?.sliceChangedPaths)
  ) {
    errors.push("phase candidate receipt does not derive from strict quality evidence");
  }
  if (qualityReceipt) {
    const durableQualityErrors = [];
    validateQualityExecutionEvidence(
      qualityReceipt,
      qualityReceipt.head,
      ledger,
      durableQualityErrors,
      {
        verifyRawArtifacts: true,
        rawArtifactBytes: artifacts,
      },
    );
    errors.push(
      ...durableQualityErrors.map(
        (error) => `durable quality evidence: ${error}`,
      ),
    );
  }
  return {
    valid: errors.length === 0,
    productionChangeAuthorized:
      errors.length === 0 && proof.productionChangeAuthorized === true,
    errors,
    receiptHashes: proof.receiptHashes || null,
    bundleHash: bundle.bundleHash,
  };
}

function pinnedJsonAtCommit(
  repoRoot,
  commit,
  relativePath,
  maximumBytes = 128 * 1024,
) {
  if (
    !COMMIT_PATTERN.test(String(commit || "")) ||
    !nonemptyString(relativePath) ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").includes("..")
  ) {
    throw new GovernanceError(
      "PHASE_PROOF_PINNED_AUTHORITY_PATH_INVALID",
      "Pinned phase-proof authority path or commit is invalid",
    );
  }
  const sealedGit = sealedGitFor(repoRoot);
  const entry = sealedGit.objectAtPath({
    commit,
    path: relativePath,
  });
  if (
    entry.type !== "blob" ||
    !["100644", "100755"].includes(entry.mode) ||
    entry.path !== relativePath
  ) {
    throw new GovernanceError(
      "PHASE_PROOF_PINNED_AUTHORITY_BLOB_INVALID",
      "Pinned phase-proof authority must be one ordinary Git blob",
      { commit, relativePath, entry },
    );
  }
  const bytes = sealedGit.show({ commit, path: relativePath });
  if (bytes.length < 2 || bytes.length > maximumBytes) {
    throw new GovernanceError(
      "PHASE_PROOF_PINNED_AUTHORITY_SIZE_INVALID",
      "Pinned phase-proof authority exceeds its exact byte bound",
      { relativePath, byteLength: bytes.length, maximumBytes },
    );
  }
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value)) throw new Error("root is not an object");
    return value;
  } catch (error) {
    throw new GovernanceError(
      "PHASE_PROOF_PINNED_AUTHORITY_JSON_INVALID",
      "Pinned phase-proof authority is not one JSON object",
      { relativePath, cause: error.message },
    );
  }
}

function validateExternallyCertifiedPhaseProofEnvelope(
  envelope,
  {
    ledger,
    phase,
    qualityReceipt,
    repoRoot = ROOT,
    nowMs = Date.now(),
    externalProofValidator = null,
  } = {},
) {
  const errors = [];
  const coreBundle = envelope?.proofBundle;
  if (
    !isObject(envelope) ||
    envelope.schema !== PHASE_PROOF_ENVELOPE_SCHEMA ||
    !SHA256_PATTERN.test(String(envelope.envelopeHash || "")) ||
    !isObject(envelope.externalCertification) ||
    !SHA256_PATTERN.test(
      String(envelope.externalCertification.certificationHash || ""),
    )
  ) {
    return {
      valid: false,
      errors: ["externally certified phase-proof envelope is malformed"],
    };
  }
  const coreValidation = validatePhaseProofBundle(coreBundle, {
    ledger,
    phase,
    qualityReceipt,
    repoRoot,
    requireFullChain: true,
    nowMs,
  });
  if (!coreValidation.valid) {
    errors.push(
      ...coreValidation.errors.map((error) => `core phase proof: ${error}`),
    );
  }
  const expected = {
    phaseId: phase?.id,
    scopeBaseCommit: phase?.scopeBaseCommit,
    candidateCommit: qualityReceipt?.head,
    candidateTree: qualityReceipt?.candidateTree,
    ledgerRevision: ledger?.revision,
    ledgerSha256: ledger ? sha256(stableJson(ledger)) : null,
    phaseProofRegistrySha256: CANONICAL_REGISTRY_SHA256,
    strictQualityReceiptHash: qualityReceipt?.receiptHash,
    coreBundleHash: coreBundle?.bundleHash,
  };
  let externalValidation = null;
  try {
    if (externalProofValidator !== null) {
      const identity = repositoryIdentity(repoRoot);
      if (
        process.env.NODE_ENV !== "test" ||
        !identity.readable ||
        identity.canonical ||
        typeof externalProofValidator !== "function"
      ) {
        throw new GovernanceError(
          "PHASE_PROOF_TEST_VALIDATOR_REFUSED",
          "External proof-validator substitution is forbidden on canonical authority",
        );
      }
      externalValidation = externalProofValidator({
        envelope,
        expected: JSON.parse(JSON.stringify(expected)),
      });
    } else {
      const authorityReference =
        CANONICAL_PHASE_PROOF_REGISTRY.attestationAuthority;
      const jwksReference = CANONICAL_PHASE_PROOF_REGISTRY.githubOidcJwks;
      const authorityRegistry = pinnedJsonAtCommit(
        repoRoot,
        phase.scopeBaseCommit,
        authorityReference.path,
      );
      const jwksRegistry = pinnedJsonAtCommit(
        repoRoot,
        phase.scopeBaseCommit,
        jwksReference.path,
      );
      externalValidation = validatePhaseProofEnvelope({
        envelope,
        authorityRegistry,
        expectedAuthoritySha256: authorityReference.sha256,
        jwksRegistry,
        expectedJwksRegistrySha256: jwksReference.sha256,
        expected,
        nowMs,
      });
    }
  } catch (error) {
    errors.push(
      `external phase proof: ${error.code || error.name || "ERROR"}: ${
        error.message
      }`,
    );
  }
  if (
    externalValidation?.valid !== true ||
    externalValidation?.externallyCertified !== true ||
    externalValidation?.replayConsumed !== false ||
    externalValidation?.envelopeHash !== envelope.envelopeHash ||
    externalValidation?.coreBundleHash !== coreBundle?.bundleHash ||
    externalValidation?.certificationHash !==
      envelope.externalCertification.certificationHash ||
    externalValidation?.phaseId !== phase?.id ||
    externalValidation?.candidateCommit !== qualityReceipt?.head ||
    externalValidation?.candidateTree !== qualityReceipt?.candidateTree
  ) {
    errors.push(
      "external phase-proof result does not bind the exact envelope, core, phase, and candidate",
    );
  }
  return {
    valid: errors.length === 0,
    errors,
    envelopeHash: envelope.envelopeHash,
    coreBundleHash: coreBundle?.bundleHash || null,
    certificationHash:
      envelope.externalCertification?.certificationHash || null,
    externalValidation,
    coreValidation,
  };
}

function validatePhaseTransition({
  before,
  after,
  baseCommit,
  qualityReceipt,
  phaseProofEnvelope,
  externalProofValidation,
  repoRoot = null,
} = {}) {
  const errors = [];
  const beforeValidation = validatePhaseLedger(before);
  const afterValidation = validatePhaseLedger(after);
  if (!beforeValidation.valid) {
    errors.push("transition source ledger is invalid");
  }
  if (!afterValidation.valid) {
    errors.push("transition destination ledger is invalid");
  }
  if (errors.length) return { valid: false, errors };

  const previous = selectActivePhase(before);
  const next = selectActivePhase(after);
  if (previous.id === next.id) {
    errors.push("phase transition must advance to a different phase");
  }
  if (after.revision !== before.revision + 1) {
    errors.push("phase transition must increment ledger revision by exactly one");
  }
  if (!COMMIT_PATTERN.test(String(baseCommit || ""))) {
    errors.push("phase transition base commit is invalid");
  }
  const completion = after.phases.find(
    (candidate) => candidate.id === previous.id,
  )?.lastResult;
  const phaseProofBundle = phaseProofEnvelope?.proofBundle;
  if (
    !isObject(completion) ||
    completion.schema !== "pikiio-phase-completion-v3" ||
    completion.result !== "passed" ||
    completion.head !== baseCommit ||
    !SHA256_PATTERN.test(String(completion.qualityReceiptHash || "")) ||
    completion.qualityReceiptPath !==
      phaseCompletionReceiptRelativePath(completion.qualityReceiptHash) ||
    !SHA256_PATTERN.test(String(completion.phaseProofBundleHash || "")) ||
    completion.phaseProofBundlePath !==
      phaseProofBundleRelativePath(completion.phaseProofEnvelopeHash) ||
    !SHA256_PATTERN.test(String(completion.phaseProofEnvelopeHash || "")) ||
    !SHA256_PATTERN.test(
      String(completion.externalCertificationHash || ""),
    ) ||
    !isObject(completion.phaseProofReceiptHashes) ||
    !nonemptyString(completion.completedAt) ||
    !Number.isFinite(Date.parse(completion.completedAt))
  ) {
    errors.push("previous phase lacks an exact completion receipt");
  }
  if (!isObject(qualityReceipt)) {
    errors.push("phase transition requires the complete strict quality receipt");
  } else {
    const qualityValidation = validateQualityReceipt(qualityReceipt, {
      ledger: before,
      phase: previous,
      head: baseCommit,
      workspaceDigest: cleanWorkspaceEvidenceDigest(),
      repoRoot,
      // The committed phase bundle is the durable source for raw judge bytes.
      // Its validator below replays both exact artifacts from embedded bytes.
      verifyRawArtifacts: false,
    });
    if (
      !qualityValidation.valid ||
      completion?.qualityReceiptHash !== qualityReceipt.receiptHash ||
      completion?.phaseProofBundleHash !== phaseProofBundle?.bundleHash ||
      completion?.phaseProofEnvelopeHash !==
        phaseProofEnvelope?.envelopeHash ||
      completion?.externalCertificationHash !==
        phaseProofEnvelope?.externalCertification?.certificationHash ||
      externalProofValidation?.valid !== true ||
      externalProofValidation?.envelopeHash !==
        phaseProofEnvelope?.envelopeHash ||
      externalProofValidation?.coreBundleHash !== phaseProofBundle?.bundleHash ||
      externalProofValidation?.certificationHash !==
        phaseProofEnvelope?.externalCertification?.certificationHash ||
      stableJson(completion?.phaseProofReceiptHashes) !==
        stableJson({
          candidate: phaseProofBundle?.chain?.candidate?.receiptHash,
          rehearsal: phaseProofBundle?.chain?.rehearsal?.receiptHash,
          change: phaseProofBundle?.chain?.change?.receiptHash,
          promotion: phaseProofBundle?.chain?.promotion?.receiptHash,
        }) ||
      completion?.completedAt !==
        phaseProofBundle?.chain?.promotion?.observedAt
    ) {
      errors.push("phase completion does not match strict quality and phase proof");
    }
    const phaseProofValidation = validatePhaseProofBundle(phaseProofBundle, {
      ledger: before,
      phase: previous,
      qualityReceipt,
      repoRoot: repoRoot || ROOT,
      requireFullChain: true,
    });
    if (!phaseProofValidation.valid) {
      errors.push(
        ...phaseProofValidation.errors.map(
          (error) => `phaseProofBundle: ${error}`,
        ),
      );
    }
  }
  const expected = JSON.parse(JSON.stringify(before));
  expected.revision = after.revision;
  expected.activePhaseId = next.id;
  const expectedPrevious = expected.phases.find(
    (candidate) => candidate.id === previous.id,
  );
  const expectedNext = expected.phases.find(
    (candidate) => candidate.id === next.id,
  );
  if (!expectedNext) {
    errors.push("next phase does not exist in the source ledger");
  } else {
    expectedPrevious.status = "complete";
    expectedPrevious.lastResult = JSON.parse(JSON.stringify(completion));
    expectedNext.status = "active";
    expectedNext.scopeBaseCommit = baseCommit;
    if (stableJson(expected) !== stableJson(after)) {
      errors.push("phase transition changed fields outside the canonical state delta");
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    previousPhaseId: previous.id,
    nextPhaseId: next.id,
  };
}

function validatePhaseTransitionHistory({
  ledger,
  phase,
  repoRoot = ROOT,
  nowMs = Date.now(),
  externalProofValidator = null,
  throughCommit = "HEAD",
} = {}) {
  try {
    if (
      throughCommit !== "HEAD" &&
      !COMMIT_PATTERN.test(String(throughCommit || ""))
    ) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Phase-transition history bound must be HEAD or one full commit SHA",
        { throughCommit },
      );
    }
    const sealedGit = sealedGitFor(repoRoot);
    const historyHead =
      throughCommit === "HEAD" ? sealedGit.head() : throughCommit;
    const commits = sealedGit.history({
      fromExclusive: phase.scopeBaseCommit,
      toInclusive: historyHead,
      path: PHASE_LEDGER_RELATIVE_PATH,
      maximum: 512,
    });
    if (commits.length !== 1) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Active non-governance slice must contain exactly one canonical ledger transition",
        { commits },
      );
    }
    const transitionCommit = commits[0];
    const parent = sealedGit.parent({ commit: transitionCommit });
    if (parent !== phase.scopeBaseCommit) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Phase transition commit must directly follow its declared scope base",
        { parent, scopeBaseCommit: phase.scopeBaseCommit },
      );
    }
    const changed = parseGitNameStatus(
      sealedGit.diff({
        from: parent,
        to: transitionCommit,
        format: "name-status-z-renames",
      }),
    );
    const before = JSON.parse(
      sealedGit.show({
        commit: parent,
        path: PHASE_LEDGER_RELATIVE_PATH,
      }).toString("utf8"),
    );
    const after = JSON.parse(
      sealedGit.show({
        commit: transitionCommit,
        path: PHASE_LEDGER_RELATIVE_PATH,
      }).toString("utf8"),
    );
    const previous = selectActivePhase(before);
    const completion = after.phases.find(
      (candidate) => candidate.id === previous.id,
    )?.lastResult;
    if (
      !isObject(completion) ||
      completion.schema !== "pikiio-phase-completion-v3" ||
      !SHA256_PATTERN.test(String(completion.qualityReceiptHash || "")) ||
      completion.qualityReceiptPath !==
        phaseCompletionReceiptRelativePath(completion.qualityReceiptHash) ||
      !SHA256_PATTERN.test(String(completion.phaseProofBundleHash || "")) ||
      !SHA256_PATTERN.test(String(completion.phaseProofEnvelopeHash || "")) ||
      !SHA256_PATTERN.test(
        String(completion.externalCertificationHash || ""),
      ) ||
      completion.phaseProofBundlePath !==
        phaseProofBundleRelativePath(completion.phaseProofEnvelopeHash)
    ) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Transition commit lacks a content-addressed completion receipt",
      );
    }
    const changedByPath = new Map(
      changed.flatMap((entry) =>
        entry.paths.map((relativePath) => [relativePath, entry.status]),
      ),
    );
    if (
      changedByPath.size !== 3 ||
      changedByPath.get(PHASE_LEDGER_RELATIVE_PATH) !== "M" ||
      changedByPath.get(completion.qualityReceiptPath) !== "A" ||
      changedByPath.get(completion.phaseProofBundlePath) !== "A"
    ) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Phase transition commit may modify only the ledger and its content-addressed completion receipt",
        { changed, receiptPath: completion.qualityReceiptPath },
      );
    }
    let qualityReceipt;
    let phaseProofEnvelope;
    try {
      qualityReceipt = JSON.parse(
        sealedGit.show({
          commit: transitionCommit,
          path: completion.qualityReceiptPath,
        }).toString("utf8"),
      );
      phaseProofEnvelope = JSON.parse(
        sealedGit.show({
          commit: transitionCommit,
          path: completion.phaseProofBundlePath,
        }).toString("utf8"),
      );
    } catch {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Transition completion receipt is absent or unreadable",
        { receiptPath: completion.qualityReceiptPath },
      );
    }
    if (qualityReceipt.receiptHash !== completion.qualityReceiptHash) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Transition completion receipt hash does not match the ledger",
      );
    }
    if (
      phaseProofEnvelope.envelopeHash !== completion.phaseProofEnvelopeHash ||
      phaseProofEnvelope.proofBundle?.bundleHash !==
        completion.phaseProofBundleHash ||
      phaseProofEnvelope.externalCertification?.certificationHash !==
        completion.externalCertificationHash
    ) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Transition phase-proof envelope does not match the ledger",
      );
    }
    const externalProofValidation =
      validateExternallyCertifiedPhaseProofEnvelope(phaseProofEnvelope, {
        ledger: before,
        phase: previous,
        qualityReceipt,
        repoRoot,
        nowMs,
        externalProofValidator,
      });
    if (!externalProofValidation.valid) {
      throw new GovernanceError(
        "PHASE_TRANSITION_EXTERNAL_PROOF_INVALID",
        "Transition external proof certification is invalid",
        { errors: externalProofValidation.errors },
      );
    }
    const transition = validatePhaseTransition({
      before,
      after,
      baseCommit: parent,
      qualityReceipt,
      phaseProofEnvelope,
      externalProofValidation,
      repoRoot,
    });
    if (!transition.valid || stableJson(after) !== stableJson(ledger)) {
      throw new GovernanceError(
        "PHASE_TRANSITION_HISTORY_INVALID",
        "Checked-in active ledger is not the canonical transition result",
        { errors: transition.errors },
      );
    }
    return {
      ok: true,
      transitionCommit,
      parent,
      previousPhaseId: transition.previousPhaseId,
      nextPhaseId: transition.nextPhaseId,
      qualityReceiptHash: qualityReceipt.receiptHash,
      phaseProofBundleHash: phaseProofEnvelope.proofBundle.bundleHash,
      phaseProofEnvelopeHash: phaseProofEnvelope.envelopeHash,
      externalCertificationHash:
        phaseProofEnvelope.externalCertification.certificationHash,
      phaseProofReceiptHashes: Object.fromEntries(
        Object.entries(phaseProofEnvelope.proofBundle.chain).map(
          ([role, receipt]) => [role, receipt.receiptHash],
        ),
      ),
    };
  } catch (error) {
    if (!(error instanceof GovernanceError)) throw error;
    return {
      ok: false,
      code: error.code,
      error: error.message,
      details: error.details,
    };
  }
}

function sealedGitFor(repoRoot = ROOT) {
  return createSealedGit({
    repoRoot: path.resolve(repoRoot),
    maxStdoutBytes: 32 * 1024 * 1024,
  });
}

function currentBranch(repoRoot = ROOT) {
  return sealedGitFor(repoRoot).branch() || "";
}

function currentHead(repoRoot = ROOT) {
  return sealedGitFor(repoRoot).head();
}

function evaluateGoalGuard({
  ledger,
  repoRoot = ROOT,
  goalObjective,
  goalThreadId,
  productionAction = "",
} = {}) {
  try {
    if (!nonemptyString(goalObjective) || !nonemptyString(goalThreadId)) {
      throw new GovernanceError(
        "CODEX_GOAL_REQUIRED",
        "The controller-provided Codex goal objective and thread ID are required",
      );
    }
    const phase = selectActivePhase(ledger);
    if (
      goalThreadId !== ledger.codexGoal.threadId ||
      sha256(goalObjective) !== ledger.codexGoal.objectiveSha256
    ) {
      throw new GovernanceError(
        "CODEX_GOAL_MISMATCH",
        "The controller-provided Codex goal does not match the phase ledger",
      );
    }
    const branch = currentBranch(repoRoot);
    if (branch !== ledger.baseline.branch) {
      throw new GovernanceError(
        "BRANCH_MISMATCH",
        `Expected branch ${ledger.baseline.branch}, found ${branch}`,
      );
    }
    if (productionAction) {
      throw new GovernanceError(
        "PRODUCTION_WRAPPER_REQUIRED",
        "Production authority is available only through the capability-bound wrapper",
        { productionAction },
      );
    }
    return {
      ok: true,
      schema: ledger.schema,
      revision: ledger.revision,
      goalThreadId: ledger.codexGoal.threadId,
      goalObjectiveSha256: ledger.codexGoal.objectiveSha256,
      phase,
      branch,
      head: currentHead(repoRoot),
    };
  } catch (error) {
    if (!(error instanceof GovernanceError)) throw error;
    return {
      ok: false,
      code: error.code,
      error: error.message,
      details: error.details,
    };
  }
}

function walkFiles(rootPath, relativeRoot, output = []) {
  const entries = fs
    .readdirSync(rootPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    const relativePath = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolutePath, relativePath, output);
    } else if (entry.isFile()) {
      output.push({ absolutePath, relativePath });
    } else {
      throw new GovernanceError(
        "PINNED_TREE_UNSUPPORTED_ENTRY",
        `Pinned tree contains a non-file entry: ${relativePath}`,
      );
    }
  }
  return output;
}

function digestTree(repoRoot, relativePath) {
  const normalized = String(relativePath).replace(/\/+$/, "");
  const resolvedRoot = path.resolve(repoRoot);
  const absolute = path.resolve(resolvedRoot, normalized);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.includes("\\") ||
    normalized.split("/").includes("..") ||
    !absolute.startsWith(`${resolvedRoot}${path.sep}`) ||
    !fs.existsSync(absolute) ||
    !fs.lstatSync(absolute).isDirectory()
  ) {
    throw new GovernanceError(
      "PINNED_TREE_MISSING",
      `Pinned dirty tree is missing: ${relativePath}`,
    );
  }
  const files = walkFiles(absolute, normalized);
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    const contentDigest = sha256(fs.readFileSync(file.absolutePath));
    digest.update(`${file.relativePath}\0${contentDigest}\n`);
  }
  return {
    algorithm: "sha256-v1-path-content",
    treeDigest: digest.digest("hex"),
    fileCount: files.length,
  };
}

function unquoteGitPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseGitStatus(output) {
  const source = String(output || "");
  if (!source) return [];
  if (source.includes("\0")) {
    const tokens = source.split("\0").filter((token) => token.length > 0);
    const entries = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const status = token.slice(0, 2);
      const destination = token.slice(3);
      if (/^[RC]/.test(status)) {
        const origin = tokens[index + 1];
        if (origin === undefined) {
          throw new GovernanceError(
            "GIT_STATUS_INVALID",
            "Rename/copy status is missing its source path",
          );
        }
        index += 1;
        entries.push({
          status,
          path: destination,
          paths: [origin, destination],
          raw: `${status} ${origin} -> ${destination}`,
        });
      } else {
        entries.push({
          status,
          path: destination,
          paths: [destination],
          raw: token,
        });
      }
    }
    return entries;
  }
  return source
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      if (rawPath.includes(" -> ")) {
        const [originRaw, destinationRaw] = rawPath.split(" -> ");
        const origin = unquoteGitPath(originRaw);
        const destination = unquoteGitPath(destinationRaw);
        return {
          status,
          path: destination,
          paths: [origin, destination],
          raw: line,
        };
      }
      const changedPath = unquoteGitPath(rawPath);
      return {
        status,
        path: changedPath,
        paths: [changedPath],
        raw: line,
      };
    });
}

function parseGitNameStatus(output) {
  const source = String(output || "");
  if (!source) return [];
  if (!source.includes("\0")) {
    return source
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...paths] = line.split("\t");
        return {
          status,
          path: paths.at(-1),
          paths,
          raw: line,
        };
      });
  }
  const tokens = source.split("\0").filter((token) => token.length > 0);
  const entries = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    index += 1;
    if (/^[RC]/.test(status)) {
      const origin = tokens[index];
      const destination = tokens[index + 1];
      if (origin === undefined || destination === undefined) {
        throw new GovernanceError(
          "GIT_DIFF_STATUS_INVALID",
          "Rename/copy diff is missing a path",
        );
      }
      index += 2;
      entries.push({
        status,
        path: destination,
        paths: [origin, destination],
        raw: `${status}\t${origin}\t${destination}`,
      });
    } else {
      const changedPath = tokens[index];
      if (changedPath === undefined) {
        throw new GovernanceError(
          "GIT_DIFF_STATUS_INVALID",
          "Diff status is missing a path",
        );
      }
      index += 1;
      entries.push({
        status,
        path: changedPath,
        paths: [changedPath],
        raw: `${status}\t${changedPath}`,
      });
    }
  }
  return entries;
}

function pathAllowed(changedPath, allowedPaths) {
  return allowedPaths.some((allowed) => {
    if (allowed.endsWith("*")) {
      return changedPath.startsWith(allowed.slice(0, -1));
    }
    if (allowed.endsWith("/")) return changedPath.startsWith(allowed);
    return changedPath === allowed;
  });
}

function entryAllowed(entry, allowedPaths) {
  return entry.paths.every((changedPath) => pathAllowed(changedPath, allowedPaths));
}

function entryTouchesTrustedGate(entry, trustedGatePaths) {
  return entry.paths.some((changedPath) =>
    trustedGatePaths.some((gatePath) => changedPath === gatePath),
  );
}

function evaluateDirtyGuard({
  ledger,
  phase,
  repoRoot = ROOT,
  statusOutput = null,
  committedOutput = null,
  nowMs = Date.now(),
  externalProofValidator = null,
} = {}) {
  const baseline = [];
  const baselineErrors = [];
  for (const entry of ledger.baseline.preExistingDirty) {
    try {
      const actual = digestTree(repoRoot, entry.path);
      baseline.push({ path: entry.path, expected: entry.treeDigest, ...actual });
      if (
        actual.treeDigest !== entry.treeDigest ||
        actual.fileCount !== entry.fileCount
      ) {
        baselineErrors.push({
          path: entry.path,
          expectedDigest: entry.treeDigest,
          actualDigest: actual.treeDigest,
          expectedFileCount: entry.fileCount,
          actualFileCount: actual.fileCount,
        });
      }
    } catch (error) {
      baselineErrors.push({
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const workingOutput =
    statusOutput === null
      ? sealedGitFor(repoRoot).status()
      : statusOutput;
  const historyOutput =
    committedOutput === null
      ? (() => {
          const sealedGit = sealedGitFor(repoRoot);
          return sealedGit.diff({
            from: phase.scopeBaseCommit,
            to: sealedGit.head(),
            format: "name-status-z-renames",
          });
        })()
      : committedOutput;
  const workingEntries = parseGitStatus(workingOutput);
  const committedEntries = parseGitNameStatus(historyOutput);
  const allowedWorking = workingEntries.filter((entry) =>
    entryAllowed(entry, phase.allowedPaths),
  );
  const blockedWorking = workingEntries.filter(
    (entry) => !entryAllowed(entry, phase.allowedPaths),
  );
  const allowedCommitted = committedEntries.filter((entry) =>
    entryAllowed(entry, phase.allowedPaths),
  );
  const blockedCommitted = committedEntries.filter(
    (entry) => !entryAllowed(entry, phase.allowedPaths),
  );
  let canonicalTransition = null;
  let trustedGateMutations = [];
  if (phase.lane !== "autonomy-governance") {
    const trustedWorking = workingEntries.filter((entry) =>
      entryTouchesTrustedGate(entry, ledger.qualityPolicy.trustedGatePaths),
    );
    let trustedCommitted = committedEntries.filter((entry) =>
      entryTouchesTrustedGate(entry, ledger.qualityPolicy.trustedGatePaths),
    );
    const onlyCanonicalLedger =
      trustedCommitted.length > 0 &&
      trustedCommitted.every((entry) =>
        exactStringArray(entry.paths, [PHASE_LEDGER_RELATIVE_PATH]),
      );
    if (committedOutput === null && onlyCanonicalLedger) {
      canonicalTransition = validatePhaseTransitionHistory({
        ledger,
        phase,
        repoRoot,
        nowMs,
        externalProofValidator,
      });
      if (canonicalTransition.ok) trustedCommitted = [];
    }
    trustedGateMutations = [...trustedWorking, ...trustedCommitted];
  }

  return {
    ok:
      baselineErrors.length === 0 &&
      blockedWorking.length === 0 &&
      blockedCommitted.length === 0 &&
      trustedGateMutations.length === 0,
    phaseId: phase.id,
    scopeBaseCommit: phase.scopeBaseCommit,
    baseline,
    baselineErrors,
    working: {
      allowed: allowedWorking,
      blocked: blockedWorking,
    },
    committed: {
      allowed: allowedCommitted,
      blocked: blockedCommitted,
    },
    trustedGateMutations,
    canonicalTransition,
    allowed: allowedWorking,
    blocked: blockedWorking,
  };
}

function workspaceEvidenceDigest(repoRoot = ROOT) {
  const sealedGit = sealedGitFor(repoRoot);
  const head = sealedGit.head();
  const status = sealedGit.status();
  const diff = sealedGit.workingDiff({ base: head });
  const indexDiff = sealedGit.indexDiff({ base: head });
  const parsed = parseGitStatus(status.toString("utf8"));
  const untracked = parsed
    .filter((entry) => entry.status === "??")
    .flatMap((entry) => entry.paths)
    .sort()
    .map((relativePath) => {
      const absolute = path.join(repoRoot, relativePath);
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile()) {
        return `${relativePath}\0non-file`;
      }
      return `${relativePath}\0${sha256(fs.readFileSync(absolute))}`;
    })
    .join("\n");
  return sha256(
    Buffer.concat([
      status,
      Buffer.from("\n--WORKTREE--\n"),
      diff,
      Buffer.from("\n--INDEX--\n"),
      indexDiff,
      Buffer.from(`\n--UNTRACKED--\n${untracked}`),
    ]),
  );
}

function cleanWorkspaceEvidenceDigest() {
  return sha256(
    Buffer.concat([
      Buffer.from(""),
      Buffer.from("\n--WORKTREE--\n"),
      Buffer.from(""),
      Buffer.from("\n--INDEX--\n"),
      Buffer.from(""),
      Buffer.from("\n--UNTRACKED--\n"),
    ]),
  );
}

function pidAlive(pid, killProcess = process.kill.bind(process)) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function shouldReclaimNestedTmsLock({ ageExpired, pidPresent, pidIsAlive }) {
  if (pidPresent && pidIsAlive) return false;
  if (pidPresent && !pidIsAlive) return true;
  return ageExpired === true;
}

function ensureRuntimeDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
}

function withOperationLock(
  lockPath,
  operation,
  {
    host = os.hostname(),
    pid = process.pid,
    now = new Date().toISOString(),
  } = {},
) {
  ensureRuntimeDirectory(lockPath);
  const lockId = crypto.randomUUID();
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(
      handle,
      `${JSON.stringify({
        schema: "pikiio-operation-lock-v1",
        lockId,
        host,
        pid,
        acquiredAt: now,
      })}\n`,
    );
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // The original exclusive-lock error remains authoritative.
      }
    }
    if (error.code === "EEXIST") {
      let existing = null;
      try {
        existing = readJson(lockPath);
      } catch {
        // An empty or torn lock is still a lock. It must be recovered manually.
      }
      throw new GovernanceError(
        "WRITER_OPERATION_BUSY",
        "A serialized Pikiio writer operation is already in progress",
        { lockPath, existing },
      );
    }
    throw error;
  }

  let operationError = null;
  try {
    const result = operation();
    if (result && typeof result.then === "function") {
      throw new GovernanceError(
        "ASYNC_OPERATION_LOCK_CALLBACK_REFUSED",
        "The synchronous operation-lock primitive cannot guard asynchronous work",
      );
    }
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let current = null;
    try {
      current = readJson(lockPath);
    } catch (error) {
      if (!operationError) {
        throw new GovernanceError(
          "WRITER_OPERATION_LOCK_LOST",
          "The serialized operation lock became unreadable",
          { lockPath, detail: error.message },
        );
      }
    }
    if (current?.lockId !== lockId) {
      if (!operationError) {
        throw new GovernanceError(
          "WRITER_OPERATION_LOCK_LOST",
          "The serialized operation lock changed ownership",
          { lockPath, expectedLockId: lockId, actualLockId: current?.lockId },
        );
      }
    } else {
      fs.unlinkSync(lockPath);
    }
  }
}

function nextFence(fencePath) {
  let current = 0;
  if (fs.existsSync(fencePath)) {
    const payload = readJson(fencePath);
    if (!Number.isSafeInteger(payload.fence) || payload.fence < 0) {
      throw new GovernanceError(
        "WRITER_FENCE_INVALID",
        "Writer fence file is invalid",
      );
    }
    current = payload.fence;
  }
  const fence = current + 1;
  writeJsonAtomic(fencePath, { fence });
  return fence;
}

function validateWriterLease(lease) {
  const errors = [];
  if (!isObject(lease)) {
    return { valid: false, errors: ["writer lease must be an object"] };
  }
  if (lease.schema !== "pikiio-writer-lease-v2") {
    errors.push("writer lease schema is invalid");
  }
  for (const key of ["runId", "host", "automationId", "phaseId", "lane"]) {
    if (!nonemptyString(lease[key])) errors.push(`writer lease ${key} is required`);
  }
  if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) {
    errors.push("writer lease fence must be a positive integer");
  }
  if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid < 1) {
    errors.push("writer lease ownerPid must be a positive integer");
  }
  if (!SHA256_PATTERN.test(String(lease.goalId || ""))) {
    errors.push("writer lease goalId must be sha256");
  }
  if (!SHA256_PATTERN.test(String(lease.capabilitySha256 || ""))) {
    errors.push("writer lease capability hash must be sha256");
  }
  if (typeof lease.branch !== "string" || typeof lease.startHead !== "string") {
    errors.push("writer lease branch and startHead must be strings");
  }
  if (
    !Array.isArray(lease.allowedPaths) ||
    !lease.allowedPaths.every(nonemptyString)
  ) {
    errors.push("writer lease allowedPaths must be a string array");
  }
  if (!isObject(lease.morningPriority)) {
    errors.push("writer lease morningPriority must be an object");
  }
  const times = Object.fromEntries(
    ["acquiredAt", "lastRenewedAt", "expiresAt", "maxExpiresAt"].map((key) => [
      key,
      Date.parse(lease[key]),
    ]),
  );
  for (const [key, value] of Object.entries(times)) {
    if (!Number.isFinite(value)) errors.push(`writer lease ${key} is invalid`);
  }
  if (
    Object.values(times).every(Number.isFinite) &&
    (
      times.lastRenewedAt < times.acquiredAt ||
      times.expiresAt < times.lastRenewedAt ||
      times.expiresAt > times.maxExpiresAt ||
      times.maxExpiresAt - times.acquiredAt > MAXIMUM_LEASE_MS
    )
  ) {
    errors.push("writer lease time bounds are invalid");
  }
  return { valid: errors.length === 0, errors };
}

function readLease(leasePath = DEFAULT_LEASE_PATH) {
  if (!fs.existsSync(leasePath)) return null;
  let lease;
  try {
    lease = readJson(leasePath);
  } catch (error) {
    throw new GovernanceError(
      "WRITER_LEASE_INVALID",
      "Writer lease exists but is unreadable; refusing to steal it",
      { leasePath, detail: error.message },
    );
  }
  const validation = validateWriterLease(lease);
  if (!validation.valid) {
    throw new GovernanceError(
      "WRITER_LEASE_INVALID",
      "Writer lease exists but is malformed; refusing to steal it",
      { leasePath, errors: validation.errors },
    );
  }
  return lease;
}

function zonedParts(nowMs, timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = {};
  for (const part of formatter.formatToParts(new Date(nowMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    dateKey: `${values.year}-${values.month}-${values.day}`,
  };
}

function zonedDateTimeToEpoch(
  { year, month, day, hour, minute, second = 0 },
  timeZone = DEFAULT_TIME_ZONE,
) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(guess, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = desiredAsUtc - actualAsUtc;
    if (delta === 0) return guess;
    guess += delta;
  }
  const finalParts = zonedParts(guess, timeZone);
  if (
    finalParts.year !== year ||
    finalParts.month !== month ||
    finalParts.day !== day ||
    finalParts.hour !== hour ||
    finalParts.minute !== minute
  ) {
    throw new GovernanceError(
      "TIME_ZONE_CONVERSION_FAILED",
      "Could not resolve the morning priority boundary",
      { timeZone, desired: { year, month, day, hour, minute, second }, finalParts },
    );
  }
  return guess;
}

function morningReceiptPathForDate(
  dateKey,
  morningReceiptDir = DEFAULT_MORNING_RECEIPT_DIR,
) {
  return path.join(morningReceiptDir, dateKey);
}

function computeHashWithoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function validateMorningTerminalReceipt(
  receipt,
  dateKey,
  { timeZone = DEFAULT_TIME_ZONE, nowMs = Date.now() } = {},
) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const boundaryMs = zonedDateTimeToEpoch(
    { year, month, day, hour: 5, minute: 45, second: 0 },
    timeZone,
  );
  const startedAt = Date.parse(receipt?.startedAt);
  const finishedAt = Date.parse(receipt?.finishedAt);
  return (
    isObject(receipt) &&
    receipt.schema === "pikiio-morning-terminal-receipt-v1" &&
    receipt.dateKey === dateKey &&
    receipt.timeZone === timeZone &&
    receipt.terminal === true &&
    nonemptyString(receipt.runId) &&
    Number.isSafeInteger(receipt.leaseFence) &&
    receipt.leaseFence >= 1 &&
    ["succeeded", "failed", "blocked"].includes(receipt.result) &&
    Number.isFinite(startedAt) &&
    nonemptyString(receipt.finishedAt) &&
    Number.isFinite(finishedAt) &&
    startedAt <= finishedAt &&
    finishedAt >= boundaryMs &&
    finishedAt <= nowMs &&
    SHA256_PATTERN.test(String(receipt.receiptHash || "")) &&
    computeHashWithoutField(receipt, "receiptHash") === receipt.receiptHash
  );
}

function readMorningTerminalReceipt({
  nowMs = Date.now(),
  timeZone = DEFAULT_TIME_ZONE,
  morningReceiptDir = DEFAULT_MORNING_RECEIPT_DIR,
} = {}) {
  const dateKey = zonedParts(nowMs, timeZone).dateKey;
  const receiptDirectory = morningReceiptPathForDate(dateKey, morningReceiptDir);
  if (!fs.existsSync(receiptDirectory)) {
    return {
      exists: false,
      valid: false,
      dateKey,
      receiptDirectory,
      receipt: null,
      invalidReceipts: [],
    };
  }
  const validReceipts = [];
  const invalidReceipts = [];
  for (const name of fs.readdirSync(receiptDirectory).sort()) {
    if (!name.endsWith(".json")) continue;
    const receiptPath = path.join(receiptDirectory, name);
    try {
      const receipt = readJson(receiptPath);
      if (validateMorningTerminalReceipt(receipt, dateKey, { timeZone, nowMs })) {
        validReceipts.push({ receiptPath, receipt });
      } else {
        invalidReceipts.push({ receiptPath, error: "validation failed" });
      }
    } catch (error) {
      invalidReceipts.push({ receiptPath, error: error.message });
    }
  }
  validReceipts.sort(
    (left, right) =>
      Date.parse(left.receipt.finishedAt) - Date.parse(right.receipt.finishedAt),
  );
  const latest = validReceipts.at(-1) || null;
  return {
    exists: validReceipts.length + invalidReceipts.length > 0,
    valid: Boolean(latest),
    dateKey,
    receiptDirectory,
    receiptPath: latest?.receiptPath || null,
    receipt: latest?.receipt || null,
    invalidReceipts,
  };
}

function writeMorningTerminalReceipt(
  input,
  {
    nowMs = Date.now(),
    timeZone = DEFAULT_TIME_ZONE,
    morningReceiptDir = DEFAULT_MORNING_RECEIPT_DIR,
  } = {},
) {
  const parts = zonedParts(nowMs, timeZone);
  const receiptDirectory = morningReceiptPathForDate(
    parts.dateKey,
    morningReceiptDir,
  );
  fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const safeRunId = String(input.runId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const receiptPath = path.join(
    receiptDirectory,
    `${safeRunId}-fence-${Number(input.leaseFence || 0)}.json`,
  );
  const lockPath = `${receiptPath}${OPERATION_LOCK_SUFFIX}`;
  return withOperationLock(lockPath, () => {
    if (fs.existsSync(receiptPath)) {
      const existing = readJson(receiptPath);
      if (
        !validateMorningTerminalReceipt(existing, parts.dateKey, {
          timeZone,
          nowMs,
        })
      ) {
        throw new GovernanceError(
          "MORNING_TERMINAL_RECEIPT_INVALID",
          "Existing morning terminal receipt is invalid",
          { receiptPath },
        );
      }
      return existing;
    }
    const receipt = {
      schema: "pikiio-morning-terminal-receipt-v1",
      dateKey: parts.dateKey,
      timeZone,
      terminal: true,
      runId: String(input.runId || ""),
      leaseFence: Number(input.leaseFence || 0),
      result: String(input.result || ""),
      truthPublished: input.truthPublished === true,
      startedAt: String(input.startedAt || ""),
      finishedAt: String(input.finishedAt || new Date(nowMs).toISOString()),
      detail: String(input.detail || ""),
    };
    if (
      !nonemptyString(receipt.runId) ||
      !Number.isSafeInteger(receipt.leaseFence) ||
      receipt.leaseFence < 1 ||
      !["succeeded", "failed", "blocked"].includes(receipt.result) ||
      !nonemptyString(receipt.startedAt) ||
      !Number.isFinite(Date.parse(receipt.startedAt)) ||
      !Number.isFinite(Date.parse(receipt.finishedAt)) ||
      Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt) ||
      Date.parse(receipt.finishedAt) > nowMs
    ) {
      throw new GovernanceError(
        "MORNING_TERMINAL_RECEIPT_INCOMPLETE",
        "Morning terminal receipt is incomplete",
      );
    }
    receipt.receiptHash = computeHashWithoutField(receipt, "receiptHash");
    writeJsonAtomic(receiptPath, receipt);
    return receipt;
  });
}

function evaluateMorningPriority({
  lane,
  requestedLeaseMs,
  nowMs = Date.now(),
  timeZone = DEFAULT_TIME_ZONE,
  morningReceiptDir = DEFAULT_MORNING_RECEIPT_DIR,
  minimumBuilderSliceMs = MINIMUM_BUILDER_SLICE_MS,
} = {}) {
  if (lane === "morning-refresh") {
    return {
      allowed: true,
      leaseMs: requestedLeaseMs,
      reason: "morning-refresh-exempt",
    };
  }
  const parts = zonedParts(nowMs, timeZone);
  const terminal = readMorningTerminalReceipt({
    nowMs,
    timeZone,
    morningReceiptDir,
  });
  if (terminal.valid) {
    return {
      allowed: true,
      leaseMs: requestedLeaseMs,
      reason: "morning-terminal-receipt-present",
      terminalReceiptHash: terminal.receipt.receiptHash,
    };
  }
  const boundaryMs = zonedDateTimeToEpoch(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 5,
      minute: 45,
      second: 0,
    },
    timeZone,
  );
  if (nowMs >= boundaryMs) {
    return {
      allowed: false,
      code: "MORNING_PRIORITY_WINDOW_ACTIVE",
      reason: "The 05:45 America/New_York morning priority window is active",
      dateKey: parts.dateKey,
      terminalReceipt: terminal,
    };
  }
  const remainingMs = boundaryMs - nowMs;
  if (remainingMs < minimumBuilderSliceMs) {
    return {
      allowed: false,
      code: "MORNING_PRIORITY_TOO_CLOSE",
      reason: "Too little time remains before the morning priority window",
      remainingMs,
    };
  }
  return {
    allowed: true,
    leaseMs: Math.min(requestedLeaseMs, remainingMs),
    reason:
      requestedLeaseMs > remainingMs
        ? "lease-capped-at-morning-boundary"
        : "before-morning-boundary",
    boundaryAt: new Date(boundaryMs).toISOString(),
  };
}

function requireCapability(capability) {
  if (!/^[a-f0-9]{64}$/.test(String(capability || ""))) {
    throw new GovernanceError(
      "WRITER_CAPABILITY_REQUIRED",
      "A 256-bit writer capability is required",
    );
  }
}

function assertLeaseOwner(lease, current, capability) {
  requireCapability(capability);
  if (
    !current ||
    current.schema !== "pikiio-writer-lease-v2" ||
    current.runId !== lease.runId ||
    current.fence !== lease.fence ||
    current.capabilitySha256 !== sha256(capability) ||
    stableJson(current) !== stableJson(lease)
  ) {
    throw new GovernanceError(
      "WRITER_LEASE_LOST",
      "Writer lease ownership or capability changed",
      {
        expectedRunId: lease.runId,
        expectedFence: lease.fence,
        actualRunId: current?.runId,
        actualFence: current?.fence,
      },
    );
  }
}

function assertLeaseLive(
  lease,
  {
    nowMs = Date.now(),
    isPidAlive = pidAlive,
    localHost = os.hostname(),
  } = {},
) {
  const acquiredAt = Date.parse(lease?.acquiredAt);
  const renewedAt = Date.parse(lease?.lastRenewedAt);
  const expiresAt = Date.parse(lease?.expiresAt);
  if (
    !Number.isFinite(acquiredAt) ||
    !Number.isFinite(renewedAt) ||
    acquiredAt > nowMs ||
    renewedAt > nowMs
  ) {
    throw new GovernanceError(
      "WRITER_LEASE_NOT_YET_VALID",
      "Writer lease carries a future acquisition or renewal timestamp",
      {
        acquiredAt: lease?.acquiredAt,
        lastRenewedAt: lease?.lastRenewedAt,
        now: new Date(nowMs).toISOString(),
      },
    );
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    throw new GovernanceError(
      "WRITER_LEASE_EXPIRED",
      "Writer lease is expired at the guarded execution boundary",
      { expiresAt: lease?.expiresAt, now: new Date(nowMs).toISOString() },
    );
  }
  if (lease.host !== localHost || !isPidAlive(Number(lease.ownerPid))) {
    throw new GovernanceError(
      "WRITER_LEASE_OWNER_NOT_LIVE",
      "Writer lease owner is not live on the local guarded host",
      {
        leaseHost: lease.host,
        localHost,
        ownerPid: lease.ownerPid,
      },
    );
  }
}

function acquireWriterLease({
  runId = crypto.randomUUID(),
  automationId = "interactive-codex",
  goalId,
  phaseId,
  lane,
  branch = "",
  startHead = "",
  allowedPaths = [],
  capability,
  leaseMs = 90 * 60 * 1000,
  maximumLeaseMs = MAXIMUM_LEASE_MS,
  leasePath = DEFAULT_LEASE_PATH,
  fencePath = DEFAULT_FENCE_PATH,
  operationLockPath = `${leasePath}${OPERATION_LOCK_SUFFIX}`,
  morningReceiptDir = DEFAULT_MORNING_RECEIPT_DIR,
  host = os.hostname(),
  ownerPid = process.pid,
  nowMs = Date.now(),
  isPidAlive = pidAlive,
} = {}) {
  requireCapability(capability);
  if (!nonemptyString(goalId) || !SHA256_PATTERN.test(goalId)) {
    throw new GovernanceError(
      "WRITER_LEASE_GOAL_MISSING",
      "Writer lease requires the exact goal objective hash",
    );
  }
  if (!nonemptyString(phaseId) || !nonemptyString(lane)) {
    throw new GovernanceError(
      "WRITER_LEASE_SCOPE_MISSING",
      "Writer lease requires phaseId and lane",
    );
  }
  if (
    !Number.isFinite(maximumLeaseMs) ||
    maximumLeaseMs < 1000 ||
    maximumLeaseMs > MAXIMUM_LEASE_MS
  ) {
    throw new GovernanceError(
      "WRITER_LEASE_MAXIMUM_INVALID",
      `Writer lease maximum cannot exceed ${MAXIMUM_LEASE_MS}ms`,
    );
  }
  if (
    !Number.isFinite(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > maximumLeaseMs
  ) {
    throw new GovernanceError(
      "WRITER_LEASE_DURATION_INVALID",
      `Writer lease duration must be between one second and ${maximumLeaseMs}ms`,
    );
  }
  const morning = evaluateMorningPriority({
    lane,
    requestedLeaseMs: leaseMs,
    nowMs,
    morningReceiptDir,
  });
  if (!morning.allowed) {
    throw new GovernanceError(morning.code, morning.reason, morning);
  }
  const effectiveLeaseMs = morning.leaseMs;
  ensureRuntimeDirectory(leasePath);
  ensureRuntimeDirectory(fencePath);
  return withOperationLock(
    operationLockPath,
    () => {
      const existing = readLease(leasePath);
      if (existing) {
        const expiresAt = Date.parse(existing.expiresAt);
        const sameHost = existing.host === host;
        const alive = sameHost ? isPidAlive(Number(existing.ownerPid)) : null;
        const expired = Number.isFinite(expiresAt) && expiresAt <= nowMs;
        if (!sameHost || alive || !expired) {
          throw new GovernanceError(
            "WRITER_LEASE_BUSY",
            "Another Pikiio writer lease is active; remain read-only",
            {
              runId: existing.runId,
              fence: existing.fence,
              host: existing.host,
              ownerPid: existing.ownerPid,
              phaseId: existing.phaseId,
              lane: existing.lane,
              expiresAt: existing.expiresAt,
              sameHost,
              pidAlive: alive,
            },
          );
        }
        const stalePath =
          `${leasePath}.stale-fence-${existing.fence || "unknown"}-${nowMs}.json`;
        fs.renameSync(leasePath, stalePath);
      }
      const fence = nextFence(fencePath);
      const now = new Date(nowMs).toISOString();
      const lease = {
        schema: "pikiio-writer-lease-v2",
        runId,
        fence,
        host,
        ownerPid,
        automationId,
        goalId,
        phaseId,
        lane,
        branch,
        startHead,
        allowedPaths,
        capabilitySha256: sha256(capability),
        acquiredAt: now,
        lastRenewedAt: now,
        expiresAt: new Date(nowMs + effectiveLeaseMs).toISOString(),
        maxExpiresAt: new Date(nowMs + maximumLeaseMs).toISOString(),
        morningPriority: morning,
      };
      const validation = validateWriterLease(lease);
      if (!validation.valid) {
        throw new GovernanceError(
          "WRITER_LEASE_INVALID",
          "Refusing to persist a malformed writer lease",
          { errors: validation.errors },
        );
      }
      fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      return lease;
    },
    { host, pid: ownerPid, now: new Date(nowMs).toISOString() },
  );
}

function renewWriterLease(
  lease,
  {
    capability,
    leaseMs = 90 * 60 * 1000,
    leasePath = DEFAULT_LEASE_PATH,
    operationLockPath = `${leasePath}${OPERATION_LOCK_SUFFIX}`,
    morningReceiptDir = DEFAULT_MORNING_RECEIPT_DIR,
    nowMs = Date.now(),
    isPidAlive = pidAlive,
  } = {},
) {
  return withOperationLock(operationLockPath, () => {
    const current = readLease(leasePath);
    assertLeaseOwner(lease, current, capability);
    assertLeaseLive(current, { nowMs, isPidAlive });
    const morning = evaluateMorningPriority({
      lane: current.lane,
      requestedLeaseMs: leaseMs,
      nowMs,
      morningReceiptDir,
    });
    if (!morning.allowed) {
      throw new GovernanceError(morning.code, morning.reason, morning);
    }
    const maxExpiresAt = Date.parse(current.maxExpiresAt);
    const expiresAt = Math.min(
      nowMs + morning.leaseMs,
      Number.isFinite(maxExpiresAt) ? maxExpiresAt : nowMs,
    );
    if (expiresAt <= nowMs) {
      throw new GovernanceError(
        "WRITER_LEASE_MAXIMUM_REACHED",
        "Writer lease reached its non-renewable maximum lifetime",
      );
    }
    const renewed = {
      ...current,
      lastRenewedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      morningPriority: morning,
    };
    writeJsonAtomic(leasePath, renewed);
    Object.assign(lease, renewed);
    return renewed;
  });
}

function releaseWriterLease(
  lease,
  {
    capability,
    leasePath = DEFAULT_LEASE_PATH,
    operationLockPath = `${leasePath}${OPERATION_LOCK_SUFFIX}`,
  } = {},
) {
  return withOperationLock(operationLockPath, () => {
    const current = readLease(leasePath);
    if (!current) {
      throw new GovernanceError(
        "WRITER_LEASE_MISSING_ON_RELEASE",
        "Writer lease vanished before release",
      );
    }
    assertLeaseOwner(lease, current, capability);
    fs.unlinkSync(leasePath);
    return { released: true, runId: lease.runId, fence: lease.fence };
  });
}

function hostPowerReceipt() {
  const receipt = {
    hostname: os.hostname(),
    platform: process.platform,
    architecture: process.arch,
    claimedTopology: "local-codex-host-not-certified-mac-mini-service",
    power: "unknown",
    batteryPercent: null,
    rawSummary: "",
  };
  if (process.platform !== "darwin") return receipt;
  const result = spawnSync("pmset", ["-g", "batt"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const output = String(result.stdout || "").trim();
  receipt.rawSummary = output.slice(0, 500);
  if (/AC Power/i.test(output)) receipt.power = "ac";
  else if (/Battery Power/i.test(output)) receipt.power = "battery";
  const percent = output.match(/(\d+)%/);
  if (percent) receipt.batteryPercent = Number(percent[1]);
  return receipt;
}

function validateProofDisposition(value, field, errors) {
  let exactRoot = false;
  if (isObject(value)) {
    try {
      const keys = Reflect.ownKeys(value);
      exactRoot =
        Object.getPrototypeOf(value) === Object.prototype &&
        keys.every((key) => typeof key === "string") &&
        exactStringArray(keys.slice().sort(), EXACT_PROOF_DISPOSITION_KEYS);
    } catch {
      exactRoot = false;
    }
  }
  if (!exactRoot) {
    errors.push(
      `${field} must be a plain object with exactly reason, receipts, and status`,
    );
    return;
  }
  if (!ALLOWED_PROOF_STATUSES.has(value.status)) {
    errors.push(`${field} must have an explicit proof status`);
    return;
  }
  if (!Array.isArray(value.receipts)) {
    errors.push(`${field}.receipts must be an array`);
  } else if (value.status === "passed" && value.receipts.length === 0) {
    errors.push(`${field}.receipts cannot be empty when passed`);
  }
  if (value.status === "not_applicable" && !nonemptyString(value.reason)) {
    errors.push(`${field}.reason is required when not applicable`);
  }
}

function validateSafetyConfirmations(confirmations, errors) {
  if (!isObject(confirmations)) {
    errors.push("safetyConfirmations must be an object");
    return;
  }
  const keys = Object.keys(confirmations);
  if (!exactStringArray(keys, REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS)) {
    errors.push("safetyConfirmations must cover the exact external-effect deny set");
    return;
  }
  for (const effect of REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS) {
    const confirmation = confirmations[effect];
    if (
      !isObject(confirmation) ||
      confirmation.preserved !== true ||
      !nonemptyString(confirmation.evidence)
    ) {
      errors.push(`safetyConfirmations.${effect} must be preserved with evidence`);
    }
  }
}

function effectiveQualityProfile(profile, phaseId) {
  if (!isObject(profile)) {
    throw new GovernanceError(
      "QUALITY_PROFILE_INVALID",
      "An immutable base quality profile is required",
    );
  }
  const floors = phaseProofForId(
    CANONICAL_PHASE_PROOF_REGISTRY,
    phaseId,
  ).populationFloors;
  return {
    ...profile,
    minimumUnitTestsPerRun: Math.max(
      profile.minimumUnitTestsPerRun,
      floors.unitTests,
    ),
    minimumMutationPopulation: Math.max(
      profile.minimumMutationPopulation,
      floors.criticalMutants,
    ),
    minimumCriticalMutationPopulation: Math.max(
      profile.minimumCriticalMutationPopulation,
      floors.criticalMutants,
    ),
    minimumGherkinScenarioPopulation: Math.max(
      profile.minimumGherkinScenarioPopulation,
      floors.gherkinScenarios,
    ),
  };
}

function requiredCoverageFilesForPhase({
  phase,
  repoRoot = ROOT,
  head = null,
  changedPaths = null,
} = {}) {
  const suite = QUALITY_TEST_SUITE_REGISTRY[phase?.qualityPlan?.testSuiteId];
  if (!suite) {
    throw new GovernanceError(
      "QUALITY_TEST_SUITE_UNKNOWN",
      `Unknown immutable quality test suite ${phase?.qualityPlan?.testSuiteId}`,
    );
  }
  let paths = changedPaths;
  const candidateHead = head || currentHead(repoRoot);
  if (paths === null) {
    const sealedGit = sealedGitFor(repoRoot);
    const entries = parseGitNameStatus(
      sealedGit.diff({
        from: phase.scopeBaseCommit,
        to: candidateHead,
        format: "name-status-z-renames",
      }),
    );
    paths = [...new Set(entries.flatMap((entry) => entry.paths))].sort();
  }
  if (!Array.isArray(paths)) {
    throw new GovernanceError(
      "QUALITY_CHANGED_PATHS_INVALID",
      "Changed paths must be an array",
    );
  }
  let proofRequired = [];
  if (paths.length > 0) {
    proofRequired = classifyChangedPaths({
      registry: CANONICAL_PHASE_PROOF_REGISTRY,
      phaseId: phase.id,
      changedPaths: [...paths].sort(),
    }).entries
      .filter(
        (entry) =>
          entry.proofRequired === true &&
          entry.classification !== "authority_runtime" &&
          entry.path.endsWith(".js"),
      )
      .map((entry) => entry.path);
  }
  const coverageGit =
    proofRequired.length > 0 ? sealedGitFor(repoRoot) : null;
  for (const relativePath of proofRequired) {
    let treeEntry = null;
    try {
      treeEntry = coverageGit.objectAtPath({
        commit: candidateHead,
        path: relativePath,
      });
    } catch {
      // The canonical refusal below intentionally normalizes absent objects.
    }
    if (
      treeEntry?.type !== "blob" ||
      treeEntry.mode === "120000" ||
      treeEntry.path !== relativePath
    ) {
      throw new GovernanceError(
        "QUALITY_REQUIRED_COVERAGE_FILE_MISSING",
        `Changed safety-bearing file cannot be measured: ${relativePath}`,
      );
    }
  }
  return [
    ...new Set([...suite.coverageIncludes, ...proofRequired]),
  ].sort();
}

function validateQualityTestSuiteShards(testSuiteId, suite) {
  const invalid = (reason, details = {}) => {
    throw new GovernanceError(
      "QUALITY_TEST_SHARD_REGISTRY_INVALID",
      `Immutable quality shard registry is invalid: ${reason}`,
      { testSuiteId, ...details },
    );
  };
  if (
    !isObject(suite) ||
    !exactStringArray(Object.keys(suite).sort(), [
      "coverageIncludes",
      "files",
      "shards",
    ]) ||
    !Array.isArray(suite.files) ||
    suite.files.length < 1 ||
    !Array.isArray(suite.coverageIncludes) ||
    suite.coverageIncludes.length < 1 ||
    !Array.isArray(suite.shards) ||
    suite.shards.length < 2
  ) {
    invalid("suite shape");
  }
  const assertUniqueStrings = (values, label, { sorted = false } = {}) => {
    if (
      values.some(
        (value) =>
          !nonemptyString(value) ||
          value.includes("\0") ||
          value.startsWith("/") ||
          value.includes(".."),
      ) ||
      new Set(values).size !== values.length ||
      (sorted &&
        stableJson(values) !== stableJson([...values].sort()))
    ) {
      invalid(label);
    }
  };
  assertUniqueStrings(suite.files, "suite files", { sorted: true });
  assertUniqueStrings(suite.coverageIncludes, "suite coverage", {
    sorted: true,
  });
  const shardIds = [];
  const assignedFiles = [];
  const assignedCoverage = [];
  for (const [index, shard] of suite.shards.entries()) {
    if (
      !isObject(shard) ||
      !exactStringArray(Object.keys(shard).sort(), [
        "coverageIncludes",
        "files",
        "id",
      ]) ||
      !/^[a-z][a-z0-9-]{1,63}$/u.test(String(shard.id || "")) ||
      !Array.isArray(shard.files) ||
      shard.files.length < 1 ||
      !Array.isArray(shard.coverageIncludes) ||
      shard.coverageIncludes.length < 1
    ) {
      invalid("shard shape", { index });
    }
    assertUniqueStrings(shard.files, `shard ${shard.id} files`, {
      sorted: true,
    });
    assertUniqueStrings(
      shard.coverageIncludes,
      `shard ${shard.id} coverage`,
      { sorted: true },
    );
    shardIds.push(shard.id);
    assignedFiles.push(...shard.files);
    assignedCoverage.push(...shard.coverageIncludes);
  }
  if (
    new Set(shardIds).size !== shardIds.length ||
    stableJson(shardIds) !== stableJson([...shardIds].sort())
  ) {
    invalid("shard IDs must be unique and ordered");
  }
  if (
    assignedFiles.length !== suite.files.length ||
    new Set(assignedFiles).size !== assignedFiles.length ||
    stableJson([...assignedFiles].sort()) !==
      stableJson([...suite.files].sort())
  ) {
    invalid("shard file partition");
  }
  if (
    assignedCoverage.length !== suite.coverageIncludes.length ||
    new Set(assignedCoverage).size !== assignedCoverage.length ||
    stableJson([...assignedCoverage].sort()) !==
      stableJson([...suite.coverageIncludes].sort())
  ) {
    invalid("shard coverage partition");
  }
  return true;
}

function qualityUnitShardArgs(
  testSuiteId,
  shardId,
  profile,
  requiredCoverageFiles = null,
) {
  const suite = QUALITY_TEST_SUITE_REGISTRY[testSuiteId];
  if (!suite) {
    throw new GovernanceError(
      "QUALITY_TEST_SUITE_UNKNOWN",
      `Unknown immutable quality test suite ${testSuiteId}`,
    );
  }
  validateQualityTestSuiteShards(testSuiteId, suite);
  const coverageFiles = [
    ...(requiredCoverageFiles || suite.coverageIncludes),
  ].sort();
  if (
    stableJson(coverageFiles) !==
    stableJson([...suite.coverageIncludes].sort())
  ) {
    throw new GovernanceError(
      "QUALITY_TEST_SHARD_COVERAGE_UNASSIGNED",
      "Required coverage contains a file outside the immutable shard registry",
      {
        testSuiteId,
        requiredCoverageFiles: coverageFiles,
      },
    );
  }
  const shard = suite.shards.find((candidate) => candidate.id === shardId);
  if (!shard) {
    throw new GovernanceError(
      "QUALITY_TEST_SHARD_UNKNOWN",
      `Unknown immutable quality test shard ${shardId}`,
      { testSuiteId },
    );
  }
  return [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    "--experimental-test-coverage",
    ...shard.coverageIncludes.map(
      (relativePath) => `--test-coverage-include=${relativePath}`,
    ),
    `--test-coverage-lines=${profile.minimumLineCoveragePercent}`,
    `--test-coverage-branches=${profile.minimumBranchCoveragePercent}`,
    `--test-coverage-functions=${profile.minimumFunctionCoveragePercent}`,
    ...shard.files,
  ];
}

function qualityUnitArgs(
  testSuiteId,
  profile,
  requiredCoverageFiles = null,
) {
  const suite = QUALITY_TEST_SUITE_REGISTRY[testSuiteId];
  if (!suite) {
    throw new GovernanceError(
      "QUALITY_TEST_SUITE_UNKNOWN",
      `Unknown immutable quality test suite ${testSuiteId}`,
    );
  }
  if (suite.shards) {
    validateQualityTestSuiteShards(testSuiteId, suite);
  }
  return [
    "--test",
    "--test-reporter=tap",
    "--experimental-test-coverage",
    ...(requiredCoverageFiles || suite.coverageIncludes).map(
      (relativePath) => `--test-coverage-include=${relativePath}`,
    ),
    `--test-coverage-lines=${profile.minimumLineCoveragePercent}`,
    `--test-coverage-branches=${profile.minimumBranchCoveragePercent}`,
    `--test-coverage-functions=${profile.minimumFunctionCoveragePercent}`,
    ...suite.files,
  ];
}

function qualityCheckCommand(checkId) {
  const check = QUALITY_CHECK_REGISTRY[checkId];
  if (!check) {
    throw new GovernanceError(
      "QUALITY_CHECK_UNKNOWN",
      `Unknown immutable quality check ${checkId}`,
    );
  }
  return [check.executable, ...check.args].join(" ");
}

function qualityCheckDefinitionSha256(checkId) {
  const check = QUALITY_CHECK_REGISTRY[checkId];
  if (!check) {
    throw new GovernanceError(
      "QUALITY_CHECK_UNKNOWN",
      `Unknown immutable quality check ${checkId}`,
    );
  }
  return sha256(stableJson(check));
}

function expectedQualityLayerPlan(
  phase,
  profile,
  {
    repoRoot = null,
    head = null,
    requiredCoverageFiles = null,
  } = {},
) {
  const plan = phase.qualityPlan;
  const coverageFiles =
    requiredCoverageFiles ||
    (repoRoot
      ? requiredCoverageFilesForPhase({
          phase,
          repoRoot,
          head,
        })
      : QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId].coverageIncludes);
  const layers = plan.syntaxFiles.map((relativePath) => ({
    name: `syntax:${relativePath}`,
    checkId: `syntax:${relativePath}`,
    command: `node -c ${relativePath}`,
    definitionSha256: sha256(
      stableJson({ executable: "node", args: ["-c", relativePath] }),
    ),
  }));
  for (let repeat = 1; repeat <= profile.deterministicRepeatCount; repeat += 1) {
    const suffix = `repeat-${repeat}`;
    const suite = QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId];
    if (suite.shards) {
      validateQualityTestSuiteShards(plan.testSuiteId, suite);
      for (const shard of suite.shards) {
        const args = qualityUnitShardArgs(
          plan.testSuiteId,
          shard.id,
          profile,
          coverageFiles,
        );
        layers.push({
          name:
            `unit-contract-property-negative-${shard.id}-${suffix}`,
          checkId: `${plan.testSuiteId}:${shard.id}`,
          command: ["node", ...args].join(" "),
          definitionSha256: sha256(
            stableJson({
              suite,
              shard,
              requiredCoverageFiles: coverageFiles,
              args,
            }),
          ),
        });
      }
    } else {
      layers.push({
        name: `unit-contract-property-negative-${suffix}`,
        checkId: plan.testSuiteId,
        command: [
          "node",
          ...qualityUnitArgs(plan.testSuiteId, profile, coverageFiles),
        ].join(" "),
        definitionSha256: sha256(
          stableJson({
            suite,
            requiredCoverageFiles: coverageFiles,
            args: qualityUnitArgs(
              plan.testSuiteId,
              profile,
              coverageFiles,
            ),
          }),
        ),
      });
    }
    layers.push({
      name: `executable-gherkin-${suffix}`,
      checkId: plan.gherkinCheckId,
      command: qualityCheckCommand(plan.gherkinCheckId),
      definitionSha256: qualityCheckDefinitionSha256(plan.gherkinCheckId),
    });
    layers.push({
      name: `critical-mutation-${suffix}`,
      checkId: plan.mutationCheckId,
      command: qualityCheckCommand(plan.mutationCheckId),
      definitionSha256: qualityCheckDefinitionSha256(plan.mutationCheckId),
    });
    for (const [groupName, checkIds] of [
      ["focused", plan.focusedCheckIds],
      ["neighbor", plan.neighborCheckIds],
      ["broad", plan.broadCheckIds],
      ["production-shaped", plan.productionShapedCheckIds],
    ]) {
      checkIds.forEach((checkId, index) => {
        layers.push({
          name: `${groupName}-${index + 1}-${suffix}`,
          checkId,
          command: qualityCheckCommand(checkId),
          definitionSha256: qualityCheckDefinitionSha256(checkId),
        });
      });
    }
  }
  return layers;
}

function expectedQualityLayerNames(phase, repeatCount) {
  const profile = { deterministicRepeatCount: repeatCount };
  for (const key of [
    "minimumLineCoveragePercent",
    "minimumBranchCoveragePercent",
    "minimumFunctionCoveragePercent",
  ]) {
    profile[key] = 0;
  }
  return expectedQualityLayerPlan(phase, profile).map((layer) => layer.name);
}

function validateDependencyManifest(manifest, errors, prefix) {
  if (!isObject(manifest)) {
    errors.push(`${prefix} is missing`);
    return;
  }
  const {
    manifestSha256,
    packageJsonSha256,
    packageLockSha256,
    installedLockSha256,
    dependencies,
    problemCount,
    defectCount,
    ...rest
  } = manifest;
  if (
    !SHA256_PATTERN.test(String(manifestSha256 || "")) ||
    !SHA256_PATTERN.test(String(packageJsonSha256 || "")) ||
    !SHA256_PATTERN.test(String(packageLockSha256 || "")) ||
    !SHA256_PATTERN.test(String(installedLockSha256 || "")) ||
    problemCount !== 0 ||
    defectCount !== 0 ||
    !Array.isArray(dependencies) ||
    dependencies.some(
      (entry) =>
        !isObject(entry) ||
        !nonemptyString(entry.name) ||
        (entry.version !== null && typeof entry.version !== "string") ||
        (entry.resolved !== null && typeof entry.resolved !== "string") ||
        typeof entry.overridden !== "boolean",
    )
  ) {
    errors.push(`${prefix} is invalid`);
    return;
  }
  const unsigned = {
    packageJsonSha256,
    packageLockSha256,
    installedLockSha256,
    ...rest,
    dependencies,
    problemCount,
    defectCount,
  };
  if (sha256(stableJson(unsigned)) !== manifestSha256) {
    errors.push(`${prefix} digest does not match its contents`);
  }
}

function validateJudgeRawArtifact(
  artifact,
  layerCount,
  errors,
  prefix,
  {
    verifyBytes = false,
    artifactDirectory = DEFAULT_QUALITY_ARTIFACT_DIR,
    rawArtifactBytes = null,
    expectedLabel = null,
    receipt = null,
  } = {},
) {
  if (
    !isObject(artifact) ||
    artifact.schema !== "pikiio-quality-judge-raw-artifact-v1" ||
    !nonemptyString(artifact.artifactPath) ||
    !SHA256_PATTERN.test(String(artifact.artifactSha256 || "")) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 1 ||
    !Number.isSafeInteger(artifact.layerCount) ||
    artifact.layerCount !== layerCount ||
    path.basename(artifact.artifactPath) !==
      `${artifact.artifactSha256}.json`
  ) {
    errors.push(`${prefix} is invalid`);
    return null;
  }
  if (!verifyBytes) return null;
  let descriptor = null;
  try {
    let bytes;
    if (rawArtifactBytes instanceof Map) {
      bytes = rawArtifactBytes.get(`sha256:${artifact.artifactSha256}`);
      if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
      if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) {
        bytes = Buffer.from(bytes);
      }
      if (!Buffer.isBuffer(bytes)) {
        throw new Error("embedded artifact bytes are unavailable");
      }
    } else {
      const canonicalDirectory = fs.realpathSync(artifactDirectory);
      const canonicalParent = fs.realpathSync(path.dirname(artifact.artifactPath));
      if (
        canonicalParent !== canonicalDirectory ||
        path.resolve(artifact.artifactPath) !==
          path.join(canonicalDirectory, `${artifact.artifactSha256}.json`)
      ) {
        throw new Error("artifact path escapes the approved content-addressed root");
      }
      const before = fs.lstatSync(artifact.artifactPath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size < 1 ||
        before.size > 64 * 1024 * 1024 ||
        before.size !== artifact.byteLength
      ) {
        throw new Error("artifact is not a bounded exact regular file");
      }
      descriptor = fs.openSync(
        artifact.artifactPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new Error("artifact changed while it was being opened");
      }
      bytes = fs.readFileSync(descriptor);
    }
    if (
      bytes.length !== artifact.byteLength ||
      sha256(bytes) !== artifact.artifactSha256
    ) {
      throw new Error("artifact bytes do not match their address");
    }
    const raw = JSON.parse(bytes.toString("utf8"));
    if (
      !isObject(raw) ||
      !exactStringArray(Object.keys(raw).sort(), [
        "automationSnapshotSha256",
        "candidateCommit",
        "candidateTree",
        "dependencyManifestSha256",
        "label",
        "layers",
        "schema",
        "toolchainSha256",
      ]) ||
      raw.schema !== "pikiio-quality-judge-raw-artifact-v1" ||
      raw.label !== expectedLabel ||
      raw.candidateCommit !== receipt?.head ||
      raw.candidateTree !== receipt?.candidateTree ||
      raw.automationSnapshotSha256 !== receipt?.automationSnapshotSha256 ||
      raw.dependencyManifestSha256 !==
        receipt?.dependencyManifest?.manifestSha256 ||
      raw.toolchainSha256 !== receipt?.qualityToolchain?.toolchainSha256 ||
      !Array.isArray(raw.layers) ||
      raw.layers.length !== layerCount
    ) {
      throw new Error("artifact body does not match the quality receipt");
    }
    const exactLayerKeys = [
      "checkId",
      "command",
      "definitionSha256",
      "finishedAt",
      "isolation",
      "name",
      "normalizationRoots",
      "parsed",
      "semanticSha256",
      "signal",
      "startedAt",
      "status",
      "stderr",
      "stdout",
      "timedOut",
    ];
    const projected = [];
    for (const layer of raw.layers) {
      if (
        !isObject(layer) ||
        !exactStringArray(Object.keys(layer).sort(), exactLayerKeys) ||
        !Array.isArray(layer.normalizationRoots) ||
        !layer.normalizationRoots.every(nonemptyString) ||
        !Number.isFinite(Date.parse(layer.startedAt)) ||
        !Number.isFinite(Date.parse(layer.finishedAt)) ||
        Date.parse(layer.finishedAt) < Date.parse(layer.startedAt) ||
        semanticReceiptSha256(layer) !== layer.semanticSha256
      ) {
        throw new Error("artifact contains a malformed or forged layer");
      }
      projected.push({
        name: layer.name,
        checkId: layer.checkId,
        command: layer.command,
        definitionSha256: layer.definitionSha256,
        isolation: layer.isolation,
        status: layer.status,
        signal: layer.signal,
        timedOut: layer.timedOut,
        semanticSha256: layer.semanticSha256,
      });
    }
    if (stableJson(projected) !== stableJson(receipt?.layers)) {
      throw new Error("artifact layers diverge from the signed receipt");
    }
    return raw;
  } catch (error) {
    errors.push(`${prefix} bytes are invalid: ${error.message}`);
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function validateQualityExecutionEvidence(
  receipt,
  head,
  ledger,
  errors,
  {
    verifyRawArtifacts = false,
    qualityArtifactDirectory = DEFAULT_QUALITY_ARTIFACT_DIR,
    rawArtifactBytes = null,
  } = {},
) {
  const operational = receipt.operationalCheckout;
  if (
    !isObject(operational) ||
    operational.schema !== "pikiio-operational-git-visible-evidence-v1" ||
    operational.scope !== "git-visible-worktree-and-index" ||
    operational.unchanged !== true ||
    !SHA256_PATTERN.test(String(operational.beforeSha256 || "")) ||
    operational.afterSha256 !== operational.beforeSha256
  ) {
    errors.push("quality receipt operational-checkout evidence is invalid");
  }
  if (!SHA256_PATTERN.test(String(receipt.automationSnapshotSha256 || ""))) {
    errors.push("quality receipt automation snapshot digest is invalid");
  }
  const toolchain = receipt.qualityToolchain;
  if (!isObject(toolchain)) {
    errors.push("quality receipt approved toolchain evidence is missing");
  } else {
    const { toolchainSha256, ...unsignedToolchain } = toolchain;
    if (
      !SHA256_PATTERN.test(String(toolchainSha256 || "")) ||
      sha256(stableJson(unsignedToolchain)) !== toolchainSha256 ||
      stableJson(toolchain) !==
        stableJson(
          ledger?.qualityPolicy?.approvedToolchain ||
            REQUIRED_QUALITY_TOOLCHAIN,
        )
    ) {
      errors.push("quality receipt approved toolchain evidence is invalid");
    }
  }
  validateDependencyManifest(
    receipt.dependencyManifest,
    errors,
    "quality receipt dependency manifest",
  );
  const allowedIsolation = new Set([
    "macos-sandbox-deny-network",
    "bubblewrap-unshare-network",
  ]);
  const primary = receipt.primaryJudge;
  if (
    !isObject(primary) ||
    primary.worktreeHead !== head ||
    primary.worktreeTree !== receipt.candidateTree ||
    primary.workspaceUnchanged !== true ||
    !allowedIsolation.has(primary.installIsolation) ||
    !allowedIsolation.has(primary.auditIsolation)
  ) {
    errors.push("quality receipt primary disposable judge evidence is invalid");
  }
  validateJudgeRawArtifact(
    primary?.rawArtifact,
    Array.isArray(receipt.layers) ? receipt.layers.length : -1,
    errors,
    "quality receipt primary raw artifact",
    {
      verifyBytes: verifyRawArtifacts,
      artifactDirectory: qualityArtifactDirectory,
      rawArtifactBytes,
      expectedLabel: "primary",
      receipt,
    },
  );
  const clean = receipt.cleanJudge;
  if (
    !isObject(clean) ||
    clean.reproduced !== true ||
    clean.worktreeHead !== head ||
    clean.worktreeTree !== receipt.candidateTree ||
    clean.workspaceUnchanged !== true ||
    clean.automationSnapshotSha256 !== receipt.automationSnapshotSha256 ||
    !SHA256_PATTERN.test(String(clean.semanticSha256 || ""))
  ) {
    errors.push("quality receipt independent disposable judge evidence is invalid");
  } else if (
    stableJson(clean.dependencyManifest) !==
    stableJson(receipt.dependencyManifest)
  ) {
    errors.push("quality receipt independent dependency evidence diverges");
  }
  validateJudgeRawArtifact(
    clean?.rawArtifact,
    Array.isArray(receipt.layers) ? receipt.layers.length : -1,
    errors,
    "quality receipt independent raw artifact",
    {
      verifyBytes: verifyRawArtifacts,
      artifactDirectory: qualityArtifactDirectory,
      rawArtifactBytes,
      expectedLabel: "independent",
      receipt,
    },
  );
}

function qualityLayerPlanEntry(layerPlanEntry) {
  return {
    name: layerPlanEntry.name,
    checkId: layerPlanEntry.checkId,
    command: layerPlanEntry.command,
    definitionSha256: layerPlanEntry.definitionSha256,
  };
}

function validateQualityReceipt(
  receipt,
  {
    ledger,
    phase,
    head,
    workspaceDigest,
    repoRoot = null,
    verifyRawArtifacts = repoRoot !== null,
    qualityArtifactDirectory = DEFAULT_QUALITY_ARTIFACT_DIR,
    rawArtifactBytes = null,
    nowMs = Date.now(),
    externalProofValidator = null,
  } = {},
) {
  const errors = [];
  let exactQualityRoot = false;
  if (isObject(receipt)) {
    try {
      const keys = Reflect.ownKeys(receipt);
      exactQualityRoot =
        Object.getPrototypeOf(receipt) === Object.prototype &&
        keys.every((key) => typeof key === "string") &&
        exactStringArray(
          keys.slice().sort(),
          EXACT_QUALITY_RECEIPT_V5_KEYS,
        );
    } catch {
      exactQualityRoot = false;
    }
  }
  if (!exactQualityRoot) {
    return {
      valid: false,
      errors: ["quality receipt must have the exact plain v5 root"],
    };
  }
  if (receipt.schema !== "pikiio-quality-gauntlet-receipt-v5") {
    errors.push("quality receipt schema is invalid");
  }
  if (receipt.phaseProofRegistrySha256 !== CANONICAL_REGISTRY_SHA256) {
    errors.push("quality receipt phase-proof registry digest mismatch");
  }
  if (!SHA256_PATTERN.test(String(receipt.receiptHash || ""))) {
    errors.push("quality receipt hash is invalid");
  } else if (computeHashWithoutField(receipt, "receiptHash") !== receipt.receiptHash) {
    errors.push("quality receipt hash does not match its contents");
  }
  if (ledger) {
    if (receipt.ledgerRevision !== ledger.revision) {
      errors.push("quality receipt ledger revision mismatch");
    }
    if (receipt.goalObjectiveSha256 !== ledger.codexGoal.objectiveSha256) {
      errors.push("quality receipt goal mismatch");
    }
    if (receipt.ledgerSha256 !== sha256(stableJson(ledger))) {
      errors.push("quality receipt ledger digest mismatch");
    }
  }
  if (phase) {
    if (receipt.phaseId !== phase.id) errors.push("quality receipt phase mismatch");
    if (receipt.qualityProfile !== phase.qualityProfile) {
      errors.push("quality receipt profile mismatch");
    }
    if (receipt.qualityPlanSha256 !== sha256(stableJson(phase.qualityPlan))) {
      errors.push("quality receipt quality-plan digest mismatch");
    }
    if (receipt.scopeBaseCommit !== phase.scopeBaseCommit) {
      errors.push("quality receipt scope base mismatch");
    }
  }
  if (head && receipt.head !== head) errors.push("quality receipt head mismatch");
  if (!COMMIT_PATTERN.test(String(receipt.candidateTree || ""))) {
    errors.push("quality receipt candidate tree is invalid");
  } else if (repoRoot && head) {
    try {
      const candidateTree = sealedGitFor(repoRoot).tree({ commit: head });
      if (receipt.candidateTree !== candidateTree) {
        errors.push("quality receipt candidate tree mismatch");
      }
    } catch {
      errors.push("quality receipt candidate tree cannot be reproduced");
    }
  }
  if (workspaceDigest && receipt.workspaceDigest !== workspaceDigest) {
    errors.push("quality receipt workspace digest mismatch");
  }
  const baseProfile =
    ledger && phase
      ? ledger.qualityPolicy?.profiles?.[phase.qualityProfile]
      : null;
  let profile = baseProfile;
  if (baseProfile && phase) {
    try {
      profile = effectiveQualityProfile(baseProfile, phase.id);
    } catch {
      errors.push("quality receipt phase has no immutable population policy");
      profile = null;
    }
  }
  if (profile && stableJson(receipt.thresholds) !== stableJson(profile)) {
    errors.push("quality receipt thresholds do not match the active profile");
  }
  let expectedCoverageFiles = [];
  if (phase) {
    try {
      expectedCoverageFiles =
        repoRoot && head
          ? requiredCoverageFilesForPhase({
              phase,
              repoRoot,
              head,
            })
          : [...QUALITY_TEST_SUITE_REGISTRY[phase.qualityPlan.testSuiteId]
              .coverageIncludes].sort();
    } catch {
      errors.push("quality receipt required coverage set cannot be reproduced");
    }
    if (
      !exactStringArray(
        receipt.requiredCoverageFiles,
        expectedCoverageFiles,
      )
    ) {
      errors.push("quality receipt required coverage set mismatch");
    }
  }
  if (!isObject(receipt.metrics)) {
    errors.push("quality receipt metrics are missing");
  } else {
    const metrics = receipt.metrics;
    if (metrics.failedTests !== 0) errors.push("quality receipt has failed tests");
    if (
      metrics.skippedRequiredTests !==
      (profile?.maximumSkippedRequiredTests ?? 0)
    ) {
      errors.push("quality receipt has skipped required tests");
    }
    if (metrics.flakyTests !== (profile?.maximumFlakyTests ?? 0)) {
      errors.push("quality receipt has flaky tests");
    }
    if (metrics.newWarnings !== (profile?.maximumNewWarnings ?? 0)) {
      errors.push("quality receipt has warnings");
    }
    if (metrics.undefinedGherkinSteps !== 0) {
      errors.push("quality receipt has undefined Gherkin steps");
    }
    if (metrics.survivedCriticalMutants !== 0) {
      errors.push("quality receipt has surviving critical mutants");
    }
    if (metrics.cleanCheckoutReproduced !== true) {
      errors.push("quality receipt lacks clean-checkout reproduction");
    }
    if (profile) {
      const coverage = metrics.minimumObservedCoverage;
      if (
        !isObject(coverage) ||
        !Number.isFinite(coverage.lines) ||
        coverage.lines < profile.minimumLineCoveragePercent ||
        !Number.isFinite(coverage.branches) ||
        coverage.branches < profile.minimumBranchCoveragePercent ||
        !Number.isFinite(coverage.functions) ||
        coverage.functions < profile.minimumFunctionCoveragePercent
      ) {
        errors.push("quality receipt coverage is below the active profile");
      }
      if (
        !Number.isFinite(metrics.minimumObservedMutationScore) ||
        metrics.minimumObservedMutationScore <
          profile.minimumMutationScorePercent
      ) {
        errors.push("quality receipt mutation score is below the active profile");
      }
      if (
        !Number.isFinite(metrics.criticalMutantKillPercent) ||
        metrics.criticalMutantKillPercent <
          profile.minimumCriticalMutantKillPercent
      ) {
        errors.push("quality receipt critical-mutant score is below the active profile");
      }
      if (
        !Number.isFinite(metrics.gherkinPassPercent) ||
        metrics.gherkinPassPercent < profile.minimumGherkinPassPercent
      ) {
        errors.push("quality receipt Gherkin score is below the active profile");
      }
      if (
        metrics.deterministicRepeatCount !== profile.deterministicRepeatCount ||
        metrics.testRuns !== profile.deterministicRepeatCount
      ) {
        errors.push("quality receipt deterministic repeats are incomplete");
      }
      const perFile = metrics.perFileCoverage;
      const proofBody = isObject(perFile)
        ? {
            requiredFiles: perFile.requiredFiles,
            repeats: perFile.repeats,
          }
        : null;
      if (
        !isObject(perFile) ||
        perFile.schema !== "pikiio-per-file-coverage-proof-v1" ||
        !exactStringArray(perFile.requiredFiles, expectedCoverageFiles) ||
        !Array.isArray(perFile.repeats) ||
        perFile.repeats.length !== profile.deterministicRepeatCount ||
        perFile.proofSha256 !== sha256(stableJson(proofBody))
      ) {
        errors.push("quality receipt per-file coverage proof is invalid");
      } else {
        perFile.repeats.forEach((repeat, index) => {
          const exactFiles =
            isObject(repeat) &&
            repeat.repeat === index + 1 &&
            Array.isArray(repeat.files) &&
            exactStringArray(
              repeat.files.map((entry) => entry?.path),
              expectedCoverageFiles,
            );
          if (
            !exactFiles ||
            repeat.files.some(
              (entry) =>
                !isObject(entry) ||
                !exactStringArray(
                  Object.keys(entry).sort(),
                  ["branches", "functions", "lines", "path"],
                ) ||
                !Number.isFinite(entry.lines) ||
                entry.lines < profile.minimumLineCoveragePercent ||
                !Number.isFinite(entry.branches) ||
                entry.branches < profile.minimumBranchCoveragePercent ||
                !Number.isFinite(entry.functions) ||
                entry.functions < profile.minimumFunctionCoveragePercent,
            )
          ) {
            errors.push(
              `quality receipt per-file coverage repeat ${index + 1} is invalid`,
            );
          }
        });
      }
    }
    if (!Number.isSafeInteger(metrics.testsPerRun) || metrics.testsPerRun < 1) {
      errors.push("quality receipt has no executed tests");
    }
    if (
      !Number.isSafeInteger(metrics.minimumMutationPopulation) ||
      metrics.minimumMutationPopulation <
        (profile?.minimumMutationPopulation ?? 1) ||
      !Number.isSafeInteger(metrics.minimumCriticalMutationPopulation) ||
      metrics.minimumCriticalMutationPopulation <
        (profile?.minimumCriticalMutationPopulation ?? 1) ||
      !Number.isSafeInteger(metrics.minimumGherkinScenarioPopulation) ||
      metrics.minimumGherkinScenarioPopulation <
        (profile?.minimumGherkinScenarioPopulation ?? 1) ||
      !Number.isSafeInteger(metrics.testsPerRun) ||
      metrics.testsPerRun < (profile?.minimumUnitTestsPerRun ?? 1) ||
      metrics.mutationClassifierMetaTestsPassed !== true
    ) {
      errors.push("quality receipt has an empty or unproven test population");
    }
  }
  const populations = receipt.populations;
  if (
    !isObject(populations) ||
    !Array.isArray(populations.unit) ||
    !Array.isArray(populations.mutation) ||
    !Array.isArray(populations.gherkin) ||
    (profile &&
      [populations.unit, populations.mutation, populations.gherkin].some(
        (entries) => entries.length !== profile.deterministicRepeatCount,
      ))
  ) {
    errors.push("quality receipt raw populations are missing or incomplete");
  } else {
    const unitValid = populations.unit.every(
      (entry) =>
        isObject(entry) &&
        ["tests", "passed", "failed", "cancelled", "skipped", "todo"].every(
          (key) => Number.isSafeInteger(entry[key]) && entry[key] >= 0,
        ) &&
        entry.tests ===
          entry.passed +
            entry.failed +
            entry.cancelled +
            entry.skipped +
            entry.todo,
    );
    const mutationValid = populations.mutation.every(
      (entry) =>
        isObject(entry) &&
        ["total", "killed", "survived", "criticalTotal", "criticalKilled", "survivedCritical"].every(
          (key) => Number.isSafeInteger(entry[key]) && entry[key] >= 0,
        ) &&
        entry.total === entry.killed + entry.survived &&
        entry.criticalTotal ===
          entry.criticalKilled + entry.survivedCritical &&
        entry.total > 0 &&
        entry.criticalTotal > 0 &&
        entry.scorePercent ===
          Number(((entry.killed / entry.total) * 100).toFixed(2)) &&
        entry.criticalKillPercent ===
          Number(
            ((entry.criticalKilled / entry.criticalTotal) * 100).toFixed(2),
          ) &&
        entry.metaTestsPassed === true,
    );
    const gherkinValid = populations.gherkin.every(
      (entry) =>
        isObject(entry) &&
        ["scenarios", "passed", "failed", "skipped", "undefined", "ambiguous", "pending"].every(
          (key) => Number.isSafeInteger(entry[key]) && entry[key] >= 0,
        ) &&
        entry.scenarios ===
          entry.passed +
            entry.failed +
            entry.skipped +
            entry.undefined +
            entry.ambiguous +
            entry.pending &&
        entry.scenarios > 0 &&
        entry.passPercent ===
          Number(((entry.passed / entry.scenarios) * 100).toFixed(2)),
    );
    if (!unitValid || !mutationValid || !gherkinValid) {
      errors.push("quality receipt raw populations do not reconcile");
    } else if (isObject(receipt.metrics)) {
      const rawMetrics = {
        testsPerRun: Math.min(...populations.unit.map((entry) => entry.tests)),
        minimumMutationPopulation: Math.min(
          ...populations.mutation.map((entry) => entry.total),
        ),
        minimumCriticalMutationPopulation: Math.min(
          ...populations.mutation.map((entry) => entry.criticalTotal),
        ),
        minimumGherkinScenarioPopulation: Math.min(
          ...populations.gherkin.map((entry) => entry.scenarios),
        ),
        minimumObservedMutationScore: Math.min(
          ...populations.mutation.map((entry) => entry.scorePercent),
        ),
        criticalMutantKillPercent: Math.min(
          ...populations.mutation.map((entry) => entry.criticalKillPercent),
        ),
        gherkinPassPercent: Math.min(
          ...populations.gherkin.map((entry) => entry.passPercent),
        ),
      };
      for (const [key, value] of Object.entries(rawMetrics)) {
        if (receipt.metrics[key] !== value) {
          errors.push(`quality receipt ${key} does not match raw populations`);
        }
      }
    }
  }
  if (!Array.isArray(receipt.layers) || receipt.layers.length === 0) {
    errors.push("quality receipt layers are missing");
  } else {
    if (
      receipt.layers.some(
        (layer) =>
          !isObject(layer) ||
          !nonemptyString(layer.name) ||
          !nonemptyString(layer.checkId) ||
          !nonemptyString(layer.command) ||
          !SHA256_PATTERN.test(String(layer.definitionSha256 || "")) ||
          ![
            "macos-sandbox-deny-network",
            "bubblewrap-unshare-network",
          ].includes(layer.isolation) ||
          layer.status !== 0 ||
          layer.signal !== null ||
          layer.timedOut !== false ||
          !SHA256_PATTERN.test(String(layer.semanticSha256 || "")),
      )
    ) {
      errors.push("quality receipt contains an invalid or failed layer");
    }
    if (
      receipt.metrics?.requiredLayersPassed !== receipt.layers.length
    ) {
      errors.push("quality receipt layer count does not match its metrics");
    }
    if (profile && isObject(phase?.qualityPlan)) {
      let expectedLayers = null;
      try {
        expectedLayers = expectedQualityLayerPlan(phase, profile, {
          repoRoot,
          head,
          requiredCoverageFiles: expectedCoverageFiles,
        });
      } catch {
        errors.push("quality receipt exact phase layer plan cannot be reproduced");
      }
      if (expectedLayers) {
        const projectedLayers =
          receipt.layers.map(qualityLayerPlanEntry);
        const projectedExpectedLayers =
          expectedLayers.map(qualityLayerPlanEntry);
        const qualityLayerPlanMatches =
          stableJson(projectedLayers) ===
          stableJson(projectedExpectedLayers);
        if (!qualityLayerPlanMatches) {
          errors.push("quality receipt does not contain the exact phase layer plan");
        }
        if (
          receipt.commandPlanSha256 !== sha256(stableJson(expectedLayers))
        ) {
          errors.push("quality receipt command-plan digest mismatch");
        }
      }
    } else if (profile && phase) {
      errors.push("quality receipt phase lacks an executable quality plan");
    }
  }
  validateQualityExecutionEvidence(
    receipt,
    head || receipt.head,
    ledger,
    errors,
    {
      verifyRawArtifacts,
      qualityArtifactDirectory,
      rawArtifactBytes,
    },
  );
  const expectedProtectedChanged =
    isObject(receipt.antiWeakening) &&
    Array.isArray(receipt.antiWeakening.sliceChangedPaths) &&
    Array.isArray(ledger?.qualityPolicy?.trustedGatePaths)
      ? [
          ...new Set(
            receipt.antiWeakening.sliceChangedPaths.filter((relativePath) =>
              ledger.qualityPolicy.trustedGatePaths.includes(relativePath),
            ),
          ),
        ].sort()
      : null;
  if (
    !isObject(receipt.antiWeakening) ||
    receipt.antiWeakening.scopeBaseCommit !== phase?.scopeBaseCommit ||
    receipt.antiWeakening.candidateHead !== receipt.head ||
    !SHA256_PATTERN.test(String(receipt.antiWeakening.sliceDiffSha256 || "")) ||
    !Array.isArray(receipt.antiWeakening.worktreeChangedPaths) ||
    receipt.antiWeakening.worktreeChangedPaths.length !== 0 ||
    !Array.isArray(receipt.antiWeakening.sliceChangedPaths) ||
    !Array.isArray(receipt.antiWeakening.auditedPaths) ||
    stableJson(receipt.antiWeakening.auditedPaths) !==
      stableJson(
        [...new Set(receipt.antiWeakening.sliceChangedPaths)].sort(),
      ) ||
    !Array.isArray(receipt.antiWeakening.protectedChanged) ||
    expectedProtectedChanged === null ||
    stableJson(receipt.antiWeakening.protectedChanged) !==
      stableJson(expectedProtectedChanged) ||
    (phase?.lane !== "autonomy-governance" &&
      receipt.antiWeakening.protectedChanged?.length > 0 &&
      receipt.antiWeakening.canonicalTransition?.ok !== true) ||
    !Array.isArray(receipt.antiWeakening.weakeningFindings) ||
    receipt.antiWeakening.weakeningFindings.length !== 0
  ) {
    errors.push("quality receipt anti-weakening evidence is invalid");
  }
  if (
    phase?.lane !== "autonomy-governance" &&
    expectedProtectedChanged?.length > 0
  ) {
    if (!repoRoot) {
      errors.push(
        "quality receipt protected transition cannot be proven without Git history",
      );
    } else {
      const canonicalTransition = validatePhaseTransitionHistory({
        ledger,
        phase,
        repoRoot,
        nowMs,
        externalProofValidator,
        throughCommit: head,
      });
      if (
        !canonicalTransition.ok ||
        stableJson(receipt.antiWeakening?.canonicalTransition) !==
          stableJson(canonicalTransition)
      ) {
        errors.push(
          "quality receipt canonical transition evidence cannot be reproduced",
        );
      }
    }
  }
  if (repoRoot && phase && head) {
    try {
      const sealedGit = sealedGitFor(repoRoot);
      const expectedEntries = parseGitNameStatus(
        sealedGit.diff({
          from: phase.scopeBaseCommit,
          to: head,
          format: "name-status-z-renames",
        }),
      );
      const expectedPaths = [
        ...new Set(expectedEntries.flatMap((entry) => entry.paths)),
      ].sort();
      const expectedDiff = sealedGit.diff({
        from: phase.scopeBaseCommit,
        to: head,
        format: "binary",
      });
      if (
        stableJson(receipt.antiWeakening?.sliceChangedPaths) !==
          stableJson(expectedPaths) ||
        receipt.antiWeakening?.sliceDiffSha256 !== sha256(expectedDiff)
      ) {
        errors.push("quality receipt committed-slice evidence cannot be reproduced");
      }
    } catch {
      errors.push("quality receipt committed slice cannot be inspected");
    }
  }
  if (receipt.developmentOnly === true) {
    errors.push("development-only quality evidence cannot authorize promotion");
  }
  if (
    Object.hasOwn(receipt, "naturalEvidence") ||
    Object.hasOwn(receipt, "browserEvidence")
  ) {
    errors.push(
      "candidate quality receipt cannot carry post-change natural or browser evidence",
    );
  }
  return { valid: errors.length === 0, errors };
}

function writeQualityReceipt(
  input,
  { receiptPath = DEFAULT_QUALITY_RECEIPT_PATH } = {},
) {
  const receipt = {
    ...input,
    schema: "pikiio-quality-gauntlet-receipt-v5",
  };
  delete receipt.receiptHash;
  receipt.receiptHash = computeHashWithoutField(receipt, "receiptHash");
  writeJsonAtomic(receiptPath, receipt);
  return receipt;
}

function selectActivationPhase(ledger, phase, errors = []) {
  const selected = selectActivePhase(ledger);
  if (phase && phase.id !== selected.id) {
    errors.push("activation phase argument does not match activePhaseId");
  }
  return selected;
}

function validateHeartbeatActivationReceipt(
  receipt,
  {
    ledger,
    phase = null,
    head,
    repoRoot = ROOT,
    nowMs = Date.now(),
    localHost = os.hostname(),
    externalProofValidator = null,
  } = {},
) {
  const errors = [];
  if (!isObject(receipt)) {
    return { valid: false, errors: ["activation receipt must be an object"] };
  }
  if (receipt.schema !== "pikiio-heartbeat-activation-receipt-v3") {
    errors.push("activation receipt schema is invalid");
  }
  if (
    !SHA256_PATTERN.test(String(receipt.receiptHash || "")) ||
    computeHashWithoutField(receipt, "receiptHash") !== receipt.receiptHash
  ) {
    errors.push("activation receipt hash is invalid");
  }
  const recordedAt = Date.parse(receipt.recordedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (
    !Number.isFinite(recordedAt) ||
    !Number.isFinite(expiresAt) ||
    recordedAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt - recordedAt > 14 * 24 * 60 * 60 * 1000
  ) {
    errors.push("activation receipt time window is invalid");
  }
  let selected = null;
  if (ledger) {
    const validation = validatePhaseLedger(ledger);
    if (!validation.valid) {
      errors.push("activation receipt ledger is invalid");
    } else {
      selected = selectActivationPhase(ledger, phase, errors);
      const governancePhase = ledger.phases.find(
        (candidate) => candidate.id === "GOV-00",
      );
      if (
        selected.id === "GOV-00" ||
        !governancePhase ||
        !TERMINAL_DEPENDENCY_STATUSES.has(governancePhase.status)
      ) {
        errors.push("activation requires terminal GOV-00 and a later active phase");
      }
      if (
        receipt.ledgerRevision !== ledger.revision ||
        receipt.ledgerSha256 !== sha256(stableJson(ledger))
      ) {
        errors.push("activation receipt ledger binding is invalid");
      }
    }
  }
  if (selected && receipt.phaseId !== selected.id) {
    errors.push("activation receipt phase mismatch");
  }
  if (
    !Number.isSafeInteger(receipt.issuerLeaseFence) ||
    receipt.issuerLeaseFence < 1 ||
    !nonemptyString(receipt.issuerRunId)
  ) {
    errors.push("activation receipt lease binding is invalid");
  }
  const hostDurabilityValidation = validateHostDurabilityReceipt(
    receipt.hostDurability,
    // This receipt proves the host was durable when activation was issued.
    // Every later lease acquisition performs a separate fresh live probe.
    { nowMs: recordedAt, localHost },
  );
  if (!hostDurabilityValidation.valid) {
    errors.push(
      ...hostDurabilityValidation.errors.map(
        (error) => `activation host durability: ${error}`,
      ),
    );
  }
  if (ledger?.automationContract) {
    if (
      receipt.automationContractSha256 !==
      sha256(stableJson(ledger.automationContract))
    ) {
      errors.push("activation receipt automation contract binding is invalid");
    }
  } else {
    errors.push("activation requires a checked-in automation contract");
  }
  if (selected && repoRoot) {
    const transition = validatePhaseTransitionHistory({
      ledger,
      phase: selected,
      repoRoot,
      nowMs,
      externalProofValidator,
    });
    if (
      !transition.ok ||
      receipt.transitionCommit !== transition.transitionCommit ||
      receipt.transitionParent !== transition.parent ||
      receipt.qualityReceiptHash !== transition.qualityReceiptHash
    ) {
      errors.push("activation receipt phase-transition evidence is invalid");
    } else if (
      head &&
      (!COMMIT_PATTERN.test(String(head)) ||
        !commitIsAncestor(transition.transitionCommit, head, repoRoot))
    ) {
      errors.push("activation receipt head is not descended from its transition");
    }
  }
  return { valid: errors.length === 0, errors };
}

function issueHeartbeatActivationReceipt({
  ledger,
  lease,
  capability,
  repoRoot = ROOT,
  leasePath = DEFAULT_LEASE_PATH,
  qualityReceiptPath = DEFAULT_QUALITY_RECEIPT_PATH,
  activationReceiptPath = DEFAULT_ACTIVATION_RECEIPT_PATH,
  nowMs = Date.now(),
  isPidAlive = pidAlive,
  localHost = os.hostname(),
  collectHostDurability = collectHostDurabilityReceipt,
  validateHostDurability = validateHostDurabilityReceipt,
  externalProofValidator = null,
  mutationBoundaryHook = null,
  mutationBoundaryNowMs = null,
} = {}) {
  const repository = repositoryIdentity(repoRoot);
  if (
    (mutationBoundaryHook !== null || mutationBoundaryNowMs !== null) &&
    (process.env.NODE_ENV !== "test" ||
      !repository.readable ||
      repository.canonical ||
      (mutationBoundaryHook !== null &&
        typeof mutationBoundaryHook !== "function") ||
      (mutationBoundaryNowMs !== null &&
        (!Number.isFinite(mutationBoundaryNowMs) ||
          mutationBoundaryNowMs < nowMs)))
  ) {
    throw new GovernanceError(
      "ACTIVATION_TEST_HOOK_REFUSED",
      "Mutation-boundary hooks are restricted to alternate test repositories",
    );
  }
  const phase = selectActivePhase(ledger);
  const current = readLease(leasePath);
  assertLeaseOwner(lease, current, capability);
  assertLeaseLive(current, { nowMs, isPidAlive, localHost });
  const head = currentHead(repoRoot);
  const transition = validatePhaseTransitionHistory({
    ledger,
    phase,
    repoRoot,
    nowMs,
    externalProofValidator,
  });
  if (!transition.ok || head !== transition.transitionCommit) {
    throw new GovernanceError(
      "ACTIVATION_TRANSITION_INVALID",
      "Activation requires the exact committed canonical phase transition",
      { transition, head },
    );
  }
  if (
    current.phaseId !== transition.previousPhaseId ||
    current.goalId !== ledger.codexGoal.objectiveSha256 ||
    current.branch !== ledger.baseline.branch ||
    current.startHead !== transition.parent
  ) {
    throw new GovernanceError(
      "ACTIVATION_LEASE_SCOPE_MISMATCH",
      "Activation requires a live writer lease bound to the exact active phase and head",
    );
  }
  const dirty = evaluateDirtyGuard({
    ledger,
    phase,
    repoRoot,
    nowMs,
    externalProofValidator,
  });
  if (
    dirty.baselineErrors.length !== 0 ||
    dirty.working.allowed.length !== 0 ||
    dirty.working.blocked.length !== 0 ||
    dirty.committed.blocked.length !== 0
  ) {
    throw new GovernanceError(
      "ACTIVATION_WORKTREE_NOT_CLEAN",
      "Activation requires a clean scoped checkout",
      { dirty },
    );
  }
  const qualityReceipt = readJson(qualityReceiptPath);
  if (qualityReceipt.receiptHash !== transition.qualityReceiptHash) {
    throw new GovernanceError(
      "ACTIVATION_QUALITY_RECEIPT_MISMATCH",
      "Activation requires the exact transition completion receipt",
    );
  }
  return withOperationLock(
    `${activationReceiptPath}${OPERATION_LOCK_SUFFIX}`,
    () => {
      if (mutationBoundaryHook) mutationBoundaryHook();
      const boundaryNowMs =
        mutationBoundaryNowMs ?? Math.max(nowMs, Date.now());
      const boundaryLease = readLease(leasePath);
      assertLeaseOwner(lease, boundaryLease, capability);
      assertLeaseLive(boundaryLease, {
        nowMs: boundaryNowMs,
        isPidAlive,
        localHost,
      });
      const boundaryHead = currentHead(repoRoot);
      if (boundaryHead !== head) {
        throw new GovernanceError(
          "ACTIVATION_HEAD_CHANGED",
          "Repository HEAD changed before the activation mutation boundary",
          { expected: head, actual: boundaryHead },
        );
      }
      const boundaryDirty = evaluateDirtyGuard({
        ledger,
        phase,
        repoRoot,
        nowMs: boundaryNowMs,
        externalProofValidator,
      });
      if (
        boundaryDirty.baselineErrors.length !== 0 ||
        boundaryDirty.working.allowed.length !== 0 ||
        boundaryDirty.working.blocked.length !== 0 ||
        boundaryDirty.committed.blocked.length !== 0
      ) {
        throw new GovernanceError(
          "ACTIVATION_WORKTREE_CHANGED",
          "Repository state changed before the activation mutation boundary",
          { dirty: boundaryDirty },
        );
      }
      const boundaryQualityReceipt = readJson(qualityReceiptPath);
      if (
        stableJson(boundaryQualityReceipt) !== stableJson(qualityReceipt) ||
        boundaryQualityReceipt.receiptHash !== transition.qualityReceiptHash
      ) {
        throw new GovernanceError(
          "ACTIVATION_QUALITY_RECEIPT_CHANGED",
          "Quality evidence changed before the activation mutation boundary",
        );
      }
      const hostDurability = collectHostDurability();
      const hostDurabilityValidation = validateHostDurability(hostDurability, {
        nowMs: boundaryNowMs,
        localHost,
      });
      if (!hostDurabilityValidation.valid) {
        throw new GovernanceError(
          "ACTIVATION_HOST_DURABILITY_INVALID",
          "Heartbeat activation requires a fresh live keep-awake service receipt",
          {
            errors: hostDurabilityValidation.errors,
            blockers: hostDurability?.blockers || [],
          },
        );
      }
      const recordedAt = new Date(boundaryNowMs).toISOString();
      const unsigned = {
        schema: "pikiio-heartbeat-activation-receipt-v3",
        recordedAt,
        expiresAt: new Date(
          boundaryNowMs + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        ledgerRevision: ledger.revision,
        ledgerSha256: sha256(stableJson(ledger)),
        phaseId: phase.id,
        transitionCommit: transition.transitionCommit,
        transitionParent: transition.parent,
        qualityReceiptHash: qualityReceipt.receiptHash,
        hostDurability,
        automationContractSha256: sha256(stableJson(ledger.automationContract)),
        issuerRunId: boundaryLease.runId,
        issuerLeaseFence: boundaryLease.fence,
      };
      const receipt = {
        ...unsigned,
        receiptHash: computeHashWithoutField(unsigned, "receiptHash"),
      };
      const validation = validateHeartbeatActivationReceipt(receipt, {
        ledger,
        phase,
        head,
        repoRoot,
        nowMs: boundaryNowMs,
        externalProofValidator,
      });
      if (!validation.valid) {
        throw new GovernanceError(
          "ACTIVATION_RECEIPT_INVALID",
          "Heartbeat activation receipt failed validation",
          { errors: validation.errors },
        );
      }
      writeJsonExclusiveAtomic(activationReceiptPath, receipt);
      return receipt;
    },
  );
}

function issuePhaseTransition({
  ledger,
  nextPhaseId,
  lease,
  capability,
  repoRoot = ROOT,
  leasePath = DEFAULT_LEASE_PATH,
  qualityReceiptPath = DEFAULT_QUALITY_RECEIPT_PATH,
  qualityArtifactDirectory = DEFAULT_QUALITY_ARTIFACT_DIR,
  phaseProofBundlePath = DEFAULT_PHASE_PROOF_BUNDLE_PATH,
  transitionJournalPath = null,
  nowMs = Date.now(),
  isPidAlive = pidAlive,
  localHost = os.hostname(),
  externalProofValidator = null,
  mutationBoundaryHook = null,
  mutationBoundaryNowMs = null,
} = {}) {
  const repository = repositoryIdentity(repoRoot);
  const resolvedRepoRoot = repository.resolved;
  if (!repository.readable) {
    throw new GovernanceError(
      "PHASE_REPOSITORY_UNREADABLE",
      "Phase-transition repository identity cannot be established",
    );
  }
  if (repository.canonical && resolvedRepoRoot !== ROOT) {
    throw new GovernanceError(
      "CANONICAL_REPOSITORY_ALIAS_REFUSED",
      "Phase transitions cannot address the canonical repository through an alias",
    );
  }
  const resolvedJournalPath =
    transitionJournalPath ||
    (resolvedRepoRoot === ROOT
      ? DEFAULT_PHASE_TRANSITION_JOURNAL_PATH
      : path.join(
          resolvedRepoRoot,
          ".git",
          "pikiio-phase-transition-journal.json",
        ));
  if (!repository.canonical && process.env.NODE_ENV !== "test") {
    throw new GovernanceError(
      "ALTERNATE_PHASE_REPOSITORY_REFUSED",
      "Phase transitions may only target the canonical repository",
      { requested: resolvedRepoRoot, canonical: ROOT },
    );
  }
  if (
    (mutationBoundaryHook !== null || mutationBoundaryNowMs !== null) &&
    (process.env.NODE_ENV !== "test" ||
      repository.canonical ||
      (mutationBoundaryHook !== null &&
        typeof mutationBoundaryHook !== "function") ||
      (mutationBoundaryNowMs !== null &&
        (!Number.isFinite(mutationBoundaryNowMs) ||
          mutationBoundaryNowMs < nowMs)))
  ) {
    throw new GovernanceError(
      "PHASE_TRANSITION_TEST_HOOK_REFUSED",
      "Mutation-boundary hooks are restricted to alternate test repositories",
    );
  }
  const previous = selectActivePhase(ledger);
  const next = ledger.phases.find((candidate) => candidate.id === nextPhaseId);
  if (!next || next.status !== "planned") {
    throw new GovernanceError(
      "PHASE_TRANSITION_TARGET_INVALID",
      "Next phase must exist and remain planned",
      { nextPhaseId, status: next?.status || null },
    );
  }
  const current = readLease(leasePath);
  assertLeaseOwner(lease, current, capability);
  assertLeaseLive(current, { nowMs, isPidAlive, localHost });
  recoverPhaseTransition({
    repoRoot: resolvedRepoRoot,
    journalPath: resolvedJournalPath,
  });
  const head = currentHead(repoRoot);
  if (
    current.phaseId !== previous.id ||
    current.goalId !== ledger.codexGoal.objectiveSha256 ||
    current.lane !== previous.lane ||
    current.branch !== ledger.baseline.branch ||
    current.startHead !== head ||
    stableJson(current.allowedPaths) !== stableJson(previous.allowedPaths)
  ) {
    throw new GovernanceError(
      "PHASE_TRANSITION_LEASE_SCOPE_MISMATCH",
      "Phase transition requires the exact live phase lease and starting head",
    );
  }
  const dirty = evaluateDirtyGuard({ ledger, phase: previous, repoRoot });
  if (
    !dirty.ok ||
    dirty.working.allowed.length !== 0 ||
    dirty.working.blocked.length !== 0
  ) {
    throw new GovernanceError(
      "PHASE_TRANSITION_WORKTREE_NOT_CLEAN",
      "Phase transition requires a completely clean scoped checkout",
      { dirty },
    );
  }
  const qualityReceipt = readJson(qualityReceiptPath);
  const qualityValidation = validateQualityReceipt(qualityReceipt, {
    ledger,
    phase: previous,
    head,
    workspaceDigest: cleanWorkspaceEvidenceDigest(),
    repoRoot,
    qualityArtifactDirectory,
    nowMs,
    externalProofValidator,
  });
  if (!qualityValidation.valid) {
    throw new GovernanceError(
      "PHASE_TRANSITION_QUALITY_INVALID",
      "Phase transition requires exact strict quality evidence",
      { errors: qualityValidation.errors },
    );
  }
  const phaseProofEnvelope = readBoundedRegularJson(phaseProofBundlePath);
  const phaseProofBundle = phaseProofEnvelope?.proofBundle;
  const externalProofValidation =
    validateExternallyCertifiedPhaseProofEnvelope(phaseProofEnvelope, {
      ledger,
      phase: previous,
      qualityReceipt,
      repoRoot,
      nowMs,
      externalProofValidator,
    });
  if (!externalProofValidation.valid) {
    throw new GovernanceError(
      "PHASE_TRANSITION_EXTERNAL_PROOF_INVALID",
      "Phase transition requires an externally certified immutable proof envelope",
      { errors: externalProofValidation.errors },
    );
  }
  const after = JSON.parse(JSON.stringify(ledger));
  after.revision += 1;
  after.activePhaseId = next.id;
  const afterPrevious = after.phases.find(
    (candidate) => candidate.id === previous.id,
  );
  const afterNext = after.phases.find((candidate) => candidate.id === next.id);
  afterPrevious.status = "complete";
  afterPrevious.lastResult = {
    schema: "pikiio-phase-completion-v3",
    result: "passed",
    head,
    qualityReceiptHash: qualityReceipt.receiptHash,
    qualityReceiptPath: phaseCompletionReceiptRelativePath(
      qualityReceipt.receiptHash,
    ),
    phaseProofBundleHash: phaseProofBundle.bundleHash,
    phaseProofEnvelopeHash: phaseProofEnvelope.envelopeHash,
    externalCertificationHash:
      phaseProofEnvelope.externalCertification.certificationHash,
    phaseProofBundlePath: phaseProofBundleRelativePath(
      phaseProofEnvelope.envelopeHash,
    ),
    phaseProofReceiptHashes: {
      candidate: phaseProofBundle.chain.candidate.receiptHash,
      rehearsal: phaseProofBundle.chain.rehearsal.receiptHash,
      change: phaseProofBundle.chain.change.receiptHash,
      promotion: phaseProofBundle.chain.promotion.receiptHash,
    },
    completedAt: phaseProofBundle.chain.promotion.observedAt,
  };
  afterNext.status = "active";
  afterNext.scopeBaseCommit = head;
  const transition = validatePhaseTransition({
    before: ledger,
    after,
    baseCommit: head,
    qualityReceipt,
    phaseProofEnvelope,
    externalProofValidation,
    repoRoot,
  });
  if (!transition.valid) {
    throw new GovernanceError(
      "PHASE_TRANSITION_INVALID",
      "Canonical phase transition failed validation",
      { errors: transition.errors },
    );
  }
  const ledgerPath = path.join(resolvedRepoRoot, PHASE_LEDGER_RELATIVE_PATH);
  const completionReceiptPath = path.join(
    resolvedRepoRoot,
    afterPrevious.lastResult.qualityReceiptPath,
  );
  const committedPhaseProofBundlePath = path.join(
    resolvedRepoRoot,
    afterPrevious.lastResult.phaseProofBundlePath,
  );
  return withOperationLock(
    `${resolvedJournalPath}${OPERATION_LOCK_SUFFIX}`,
    () => {
      if (mutationBoundaryHook) mutationBoundaryHook();
      const boundaryNowMs =
        mutationBoundaryNowMs ?? Math.max(nowMs, Date.now());
      const boundaryLease = readLease(leasePath);
      assertLeaseOwner(lease, boundaryLease, capability);
      assertLeaseLive(boundaryLease, {
        nowMs: boundaryNowMs,
        isPidAlive,
        localHost,
      });
      const boundaryHead = currentHead(repoRoot);
      if (boundaryHead !== head) {
        throw new GovernanceError(
          "PHASE_TRANSITION_HEAD_CHANGED",
          "Repository HEAD changed before the transition mutation boundary",
          { expected: head, actual: boundaryHead },
        );
      }
      const boundaryDirty = evaluateDirtyGuard({
        ledger,
        phase: previous,
        repoRoot,
        nowMs: boundaryNowMs,
        externalProofValidator,
      });
      if (
        !boundaryDirty.ok ||
        boundaryDirty.working.allowed.length !== 0 ||
        boundaryDirty.working.blocked.length !== 0
      ) {
        throw new GovernanceError(
          "PHASE_TRANSITION_WORKTREE_CHANGED",
          "Repository state changed before the transition mutation boundary",
          { dirty: boundaryDirty },
        );
      }
  // Preflight every content-addressed destination before creating anything.
  // A collision must leave the repository byte-for-byte unchanged.
  const completionReceiptPreexisting = fs.existsSync(completionReceiptPath);
  const phaseProofBundlePreexisting = fs.existsSync(
    committedPhaseProofBundlePath,
  );
  if (completionReceiptPreexisting) {
    const existing = readBoundedRegularJson(completionReceiptPath);
    if (stableJson(existing) !== stableJson(qualityReceipt)) {
      throw new GovernanceError(
        "PHASE_COMPLETION_RECEIPT_COLLISION",
        "A different receipt already occupies the content-addressed completion path",
        { completionReceiptPath },
      );
    }
  }
  if (phaseProofBundlePreexisting) {
    const existing = readBoundedRegularJson(committedPhaseProofBundlePath);
    if (stableJson(existing) !== stableJson(phaseProofEnvelope)) {
      throw new GovernanceError(
        "PHASE_PROOF_BUNDLE_COLLISION",
        "A different proof envelope already occupies the content-addressed phase path",
        { committedPhaseProofBundlePath },
      );
    }
  }
  const completionReceiptBytes = Buffer.from(
    `${JSON.stringify(qualityReceipt, null, 2)}\n`,
    "utf8",
  );
  const phaseProofBundleBytes = Buffer.from(
    `${JSON.stringify(phaseProofEnvelope, null, 2)}\n`,
    "utf8",
  );
  const journalBody = {
    schema: "pikiio-phase-transition-journal-v1",
    transactionId: crypto.randomUUID(),
    recordedAt: new Date(boundaryNowMs).toISOString(),
    beforeLedgerSha256: sha256(stableJson(ledger)),
    afterLedgerSha256: sha256(stableJson(after)),
    ledgerPath: PHASE_LEDGER_RELATIVE_PATH,
    completion: {
      path: afterPrevious.lastResult.qualityReceiptPath,
      bytesSha256: sha256(completionReceiptBytes),
      preexisting: completionReceiptPreexisting,
    },
    bundle: {
      path: afterPrevious.lastResult.phaseProofBundlePath,
      bytesSha256: sha256(phaseProofBundleBytes),
      preexisting: phaseProofBundlePreexisting,
    },
  };
  const journal = {
    ...journalBody,
    journalHash: computeHashWithoutField(journalBody, "journalHash"),
  };
  writeJsonExclusiveAtomic(resolvedJournalPath, journal, 0o600);
  try {
    if (!completionReceiptPreexisting) {
      writeJsonExclusiveAtomic(completionReceiptPath, qualityReceipt, 0o644);
    }
    if (!phaseProofBundlePreexisting) {
      writeJsonExclusiveAtomic(
        committedPhaseProofBundlePath,
        phaseProofEnvelope,
        0o644,
      );
    }
    writeJsonAtomic(ledgerPath, after, 0o644);
    const recovery = recoverPhaseTransition({
      repoRoot: resolvedRepoRoot,
      journalPath: resolvedJournalPath,
    });
    if (recovery.status !== "committed") {
      throw new GovernanceError(
        "PHASE_TRANSITION_DURABILITY_UNPROVEN",
        "Transition journal did not confirm a durable commit",
        { recovery },
      );
    }
  } catch (error) {
    let recovery;
    try {
      recovery = recoverPhaseTransition({
        repoRoot: resolvedRepoRoot,
        journalPath: resolvedJournalPath,
      });
    } catch (recoveryError) {
      throw new GovernanceError(
        "PHASE_TRANSITION_RECOVERY_REQUIRED",
        "Transition failed and deterministic journal recovery did not complete",
        {
          cause: error instanceof Error ? error.message : String(error),
          recoveryCause:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
          journalPath: resolvedJournalPath,
        },
      );
    }
    if (recovery.status !== "committed") throw error;
  }
      return {
        ok: true,
        previousPhaseId: previous.id,
        nextPhaseId: next.id,
        baseCommit: head,
        ledgerRevision: after.revision,
        qualityReceiptHash: qualityReceipt.receiptHash,
        phaseProofBundleHash: phaseProofBundle.bundleHash,
        phaseProofEnvelopeHash: phaseProofEnvelope.envelopeHash,
        externalCertificationHash:
          phaseProofEnvelope.externalCertification.certificationHash,
        changedPaths: [
          PHASE_LEDGER_RELATIVE_PATH,
          afterPrevious.lastResult.qualityReceiptPath,
          afterPrevious.lastResult.phaseProofBundlePath,
        ],
      };
    },
  );
}

function validateRunReceipt(
  receipt,
  {
    ledger = null,
    lease = null,
    repoRoot = null,
    qualityArtifactDirectory = DEFAULT_QUALITY_ARTIFACT_DIR,
  } = {},
) {
  const errors = [];
  if (!isObject(receipt)) {
    return { valid: false, errors: ["receipt must be an object"] };
  }
  if (receipt.schema !== "pikiio-agent-run-receipt-v2") {
    errors.push("schema must be pikiio-agent-run-receipt-v2");
  }
  for (const key of [
    "runId",
    "goalThreadId",
    "goalObjectiveSha256",
    "phaseId",
    "lane",
    "startingCommit",
    "endingCommit",
    "workspaceDigest",
    "result",
    "nextAction",
    "recordedAt",
  ]) {
    if (!nonemptyString(receipt[key])) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  for (const key of ["startingCommit", "endingCommit"]) {
    if (!COMMIT_PATTERN.test(String(receipt[key] || ""))) {
      errors.push(`${key} must be a full Git commit`);
    }
  }
  for (const key of ["goalObjectiveSha256", "workspaceDigest"]) {
    if (!SHA256_PATTERN.test(String(receipt[key] || ""))) {
      errors.push(`${key} must be sha256`);
    }
  }
  if (!Number.isSafeInteger(receipt.phaseRevision) || receipt.phaseRevision < 2) {
    errors.push("phaseRevision must be an integer at or above two");
  }
  if (!Number.isSafeInteger(receipt.leaseFence) || receipt.leaseFence < 1) {
    errors.push("leaseFence must be a positive integer");
  }
  if (!isObject(receipt.host)) errors.push("host must be an object");
  if (!isObject(receipt.dirtyBaseline)) errors.push("dirtyBaseline must be an object");
  if (!nonemptyStringArray(receipt.commands)) {
    errors.push("commands must be a non-empty string array");
  }
  if (!Array.isArray(receipt.changedPaths)) {
    errors.push("changedPaths must be an array");
  }
  if (!Array.isArray(receipt.localProof) || receipt.localProof.length === 0) {
    errors.push("localProof must contain at least one receipt");
  }
  for (const key of [
    "productionProof",
    "sourceCutProof",
    "migrationProof",
    "deploymentProof",
    "browserProof",
  ]) {
    validateProofDisposition(receipt[key], key, errors);
  }
  if (!Number.isFinite(receipt.modelCostDeltaUsd) || receipt.modelCostDeltaUsd < 0) {
    errors.push("modelCostDeltaUsd must be a non-negative number");
  }
  validateSafetyConfirmations(receipt.safetyConfirmations, errors);
  const qualityValidation = validateQualityReceipt(receipt.qualityProof, {
    ledger,
    phase: ledger
      ? ledger.phases.find((candidate) => candidate.id === receipt.phaseId)
      : null,
    head: receipt.endingCommit,
    workspaceDigest: receipt.workspaceDigest,
    repoRoot,
    qualityArtifactDirectory,
  });
  if (!qualityValidation.valid) {
    errors.push(...qualityValidation.errors.map((error) => `qualityProof: ${error}`));
  }
  if (ledger) {
    if (receipt.goalThreadId !== ledger.codexGoal.threadId) {
      errors.push("goalThreadId does not match the ledger");
    }
    if (receipt.goalObjectiveSha256 !== ledger.codexGoal.objectiveSha256) {
      errors.push("goalObjectiveSha256 does not match the ledger");
    }
    if (receipt.phaseRevision !== ledger.revision) {
      errors.push("phaseRevision does not match the ledger");
    }
    if (receipt.phaseId !== ledger.activePhaseId) {
      errors.push("phaseId does not match the active phase");
    }
  }
  if (lease) {
    if (
      receipt.runId !== lease.runId ||
      receipt.leaseFence !== lease.fence ||
      receipt.phaseId !== lease.phaseId ||
      receipt.lane !== lease.lane ||
      receipt.startingCommit !== lease.startHead
    ) {
      errors.push("receipt does not match the writer lease");
    }
  }
  return { valid: errors.length === 0, errors };
}

function verifyReceiptChain(receiptPath = DEFAULT_RECEIPT_PATH) {
  if (!fs.existsSync(receiptPath)) {
    return { valid: true, count: 0, lastHash: null, receipts: [] };
  }
  const source = fs.readFileSync(receiptPath, "utf8");
  if (!source.endsWith("\n")) {
    return {
      valid: false,
      count: 0,
      lastHash: null,
      errors: ["receipt chain ends with a truncated line"],
    };
  }
  const lines = source.split("\n").filter(Boolean);
  const receipts = [];
  const errors = [];
  let previousHash = null;
  lines.forEach((line, index) => {
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch (error) {
      errors.push(`line ${index + 1} is invalid JSON: ${error.message}`);
      return;
    }
    const expectedHash = computeHashWithoutField(receipt, "receiptHash");
    if (receipt.receiptHash !== expectedHash) {
      errors.push(`line ${index + 1} receipt hash mismatch`);
    }
    if (receipt.previousReceiptHash !== previousHash) {
      errors.push(`line ${index + 1} previous hash mismatch`);
    }
    previousHash = receipt.receiptHash;
    receipts.push(receipt);
  });
  return {
    valid: errors.length === 0,
    count: receipts.length,
    lastHash: previousHash,
    receipts,
    errors,
  };
}

function baselineReceipt(ledger, repoRoot) {
  const entries = ledger.baseline.preExistingDirty.map((entry) => ({
      path: entry.path,
      expectedTreeDigest: entry.treeDigest,
      expectedFileCount: entry.fileCount,
      ...digestTree(repoRoot, entry.path),
    }));
  const changed = entries.filter(
    (entry) =>
      entry.treeDigest !== entry.expectedTreeDigest ||
      entry.fileCount !== entry.expectedFileCount,
  );
  if (changed.length) {
    throw new GovernanceError(
      "PINNED_BASELINE_CHANGED",
      "Pinned pre-existing evidence changed before run receipt append",
      { changed },
    );
  }
  return { entries };
}

function appendRunReceipt(
  input,
  {
    ledger,
    lease,
    capability,
    repoRoot = ROOT,
    leasePath = DEFAULT_LEASE_PATH,
    receiptPath = DEFAULT_RECEIPT_PATH,
    qualityReceiptPath = DEFAULT_QUALITY_RECEIPT_PATH,
    qualityArtifactDirectory = DEFAULT_QUALITY_ARTIFACT_DIR,
    now = new Date().toISOString(),
    operationLockPath = `${receiptPath}${OPERATION_LOCK_SUFFIX}`,
    isPidAlive = pidAlive,
    localHost = os.hostname(),
  } = {},
) {
  if (!ledger || !lease) {
    throw new GovernanceError(
      "RUN_RECEIPT_CONTEXT_REQUIRED",
      "A live ledger and writer lease are required to append a receipt",
    );
  }
  const currentLease = readLease(leasePath);
  assertLeaseOwner(lease, currentLease, capability);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new GovernanceError(
      "RUN_RECEIPT_TIME_INVALID",
      "Run receipt time must be a valid ISO timestamp",
    );
  }
  assertLeaseLive(currentLease, { nowMs, isPidAlive, localHost });
  const phase = selectActivePhase(ledger);
  if (
    currentLease.phaseId !== phase.id ||
    currentLease.goalId !== ledger.codexGoal.objectiveSha256 ||
    currentLease.lane !== phase.lane ||
    currentLease.branch !== ledger.baseline.branch ||
    stableJson(currentLease.allowedPaths) !== stableJson(phase.allowedPaths)
  ) {
    throw new GovernanceError(
      "RUN_RECEIPT_LEASE_SCOPE_MISMATCH",
      "The live lease does not match the active phase and goal",
    );
  }
  const endingCommit = currentHead(repoRoot);
  const workspaceDigest = workspaceEvidenceDigest(repoRoot);
  const qualityProof = readBoundedRegularJson(qualityReceiptPath);
  const receipt = {
    schema: "pikiio-agent-run-receipt-v2",
    recordedAt: now,
    runId: currentLease.runId,
    goalThreadId: ledger.codexGoal.threadId,
    goalObjectiveSha256: ledger.codexGoal.objectiveSha256,
    phaseRevision: ledger.revision,
    phaseId: phase.id,
    lane: currentLease.lane,
    leaseFence: currentLease.fence,
    startingCommit: currentLease.startHead,
    endingCommit,
    workspaceDigest,
    host: hostPowerReceipt(),
    dirtyBaseline: baselineReceipt(ledger, repoRoot),
    commands: input.commands,
    changedPaths: input.changedPaths,
    localProof: input.localProof,
    qualityProof,
    productionProof: input.productionProof,
    sourceCutProof: input.sourceCutProof,
    migrationProof: input.migrationProof,
    deploymentProof: input.deploymentProof,
    browserProof: input.browserProof,
    modelCostDeltaUsd: input.modelCostDeltaUsd,
    safetyConfirmations: input.safetyConfirmations,
    result: input.result,
    nextAction: input.nextAction,
  };
  const validation = validateRunReceipt(receipt, {
    ledger,
    lease: currentLease,
    repoRoot,
    qualityArtifactDirectory,
  });
  if (!validation.valid) {
    throw new GovernanceError(
      "RUN_RECEIPT_INVALID",
      "Pikiio run receipt is incomplete or inconsistent",
      { errors: validation.errors },
    );
  }
  ensureRuntimeDirectory(receiptPath);
  return withOperationLock(operationLockPath, () => {
    const chain = verifyReceiptChain(receiptPath);
    if (!chain.valid) {
      throw new GovernanceError(
        "RUN_RECEIPT_CHAIN_INVALID",
        "Existing run receipt chain is invalid",
        { errors: chain.errors },
      );
    }
    receipt.previousReceiptHash = chain.lastHash;
    receipt.receiptHash = computeHashWithoutField(receipt, "receiptHash");
    fs.appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return receipt;
  });
}

function commitIsAncestor(ancestor, descendant, repoRoot = ROOT) {
  const sealedGit = sealedGitFor(repoRoot);
  sealedGit.commit({ commit: descendant });
  try {
    sealedGit.commit({ commit: ancestor });
  } catch (error) {
    const exactMissingObject = Buffer.from(
      "fatal: Needed a single revision\n",
      "utf8",
    );
    if (
      error instanceof SealedGitError &&
      error.code === "SEALED_GIT_COMMAND_FAILED" &&
      error.details?.operation === "commit" &&
      error.details?.status === 128 &&
      error.details?.signal === null &&
      error.details?.cause === null &&
      error.details?.stderrBytes === exactMissingObject.length &&
      error.details?.stderrSha256 === sha256(exactMissingObject)
    ) {
      return false;
    }
    throw error;
  }
  return sealedGit.isAncestor({ ancestor, descendant });
}

function fileAtCommit(repoRoot, commit, relativePath) {
  return sealedGitFor(repoRoot).show({ commit, path: relativePath });
}

function validateProductionAuthorizationHistory({
  ledger,
  phase,
  grant,
  repoRoot = ROOT,
  authorizationCommit,
}) {
  try {
    if (!commitIsAncestor(grant.candidateCommit, authorizationCommit, repoRoot)) {
      throw new GovernanceError(
        "PRODUCTION_CANDIDATE_NOT_AUTHORIZED",
        "Candidate commit is not an ancestor of the authorization commit",
      );
    }
    const sealedGit = sealedGitFor(repoRoot);
    const commitCount = sealedGit.commitCount({
      fromExclusive: grant.candidateCommit,
      toInclusive: authorizationCommit,
    });
    if (commitCount !== 1) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORIZATION_DELTA_INVALID",
        "Production authorization must be exactly one commit after the tested candidate",
        { commitCount },
      );
    }
    const changed = parseGitNameStatus(
      sealedGit.diff({
        from: grant.candidateCommit,
        to: authorizationCommit,
        format: "name-status-z-renames",
      }),
    );
    if (
      changed.length !== 1 ||
      changed[0].status !== "M" ||
      !exactStringArray(changed[0].paths, [PHASE_LEDGER_RELATIVE_PATH])
    ) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORIZATION_DELTA_INVALID",
        "Authorization commit may modify only the canonical phase ledger",
        { changed },
      );
    }
    const candidateLedger = JSON.parse(
      sealedGit.show({
        commit: grant.candidateCommit,
        path: PHASE_LEDGER_RELATIVE_PATH,
      }).toString("utf8"),
    );
    const authorizationLedger = JSON.parse(
      sealedGit.show({
        commit: authorizationCommit,
        path: PHASE_LEDGER_RELATIVE_PATH,
      }).toString("utf8"),
    );
    const candidateValidation = validatePhaseLedger(candidateLedger);
    if (!candidateValidation.valid) {
      throw new GovernanceError(
        "PRODUCTION_CANDIDATE_LEDGER_INVALID",
        "Candidate ledger is invalid",
        { errors: candidateValidation.errors },
      );
    }
    if (stableJson(authorizationLedger) !== stableJson(ledger)) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORIZATION_LEDGER_MISMATCH",
        "Runtime authority does not equal the authorization commit ledger",
      );
    }
    const candidatePhase = selectActivePhase(candidateLedger);
    if (
      candidateLedger.activePhaseId !== ledger.activePhaseId ||
      candidatePhase.id !== phase.id ||
      candidatePhase.productionAuthority.enabled !== false ||
      candidatePhase.productionAuthority.grant !== null ||
      ledger.revision !== candidateLedger.revision + 1
    ) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORIZATION_TRANSITION_INVALID",
        "Authorization must only enable production on the same tested phase",
      );
    }
    const expected = JSON.parse(JSON.stringify(candidateLedger));
    expected.revision = ledger.revision;
    const expectedPhase = expected.phases.find(
      (candidate) => candidate.id === phase.id,
    );
    expectedPhase.productionAuthority = JSON.parse(
      JSON.stringify(phase.productionAuthority),
    );
    if (stableJson(expected) !== stableJson(ledger)) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORIZATION_TRANSITION_INVALID",
        "Authorization commit changed fields outside revision and exact production authority",
      );
    }
    return {
      ok: true,
      candidateLedger,
      candidatePhase,
      authorizationCommit,
      changed,
    };
  } catch (error) {
    if (!(error instanceof GovernanceError)) throw error;
    return {
      ok: false,
      code: error.code,
      error: error.message,
      details: error.details,
    };
  }
}

function evaluateProductionGate({
  ledger,
  repoRoot = ROOT,
  goalObjective,
  goalThreadId,
  lease,
  capability,
  action,
  migrationPath = "",
  leasePath = DEFAULT_LEASE_PATH,
  qualityReceiptPath = DEFAULT_QUALITY_RECEIPT_PATH,
  phaseProofBundlePath = DEFAULT_PHASE_PROOF_BUNDLE_PATH,
  nowMs = Date.now(),
  isPidAlive = pidAlive,
  localHost = os.hostname(),
  externalProofValidator = null,
} = {}) {
  try {
    const goal = evaluateGoalGuard({
      ledger,
      repoRoot,
      goalObjective,
      goalThreadId,
    });
    if (!goal.ok) {
      throw new GovernanceError(goal.code, goal.error, goal.details);
    }
    const phase = goal.phase;
    const authority = phase.productionAuthority;
    if (!authority.enabled) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORITY_DISABLED",
        `Production authority is disabled for ${phase.id}`,
      );
    }
    const grant = authority.grant;
    if (Date.parse(grant.expiresAt) <= nowMs) {
      throw new GovernanceError(
        "PRODUCTION_GRANT_EXPIRED",
        "The production authorization grant expired",
      );
    }
    const currentLease = readLease(leasePath);
    assertLeaseOwner(lease, currentLease, capability);
    assertLeaseLive(currentLease, { nowMs, isPidAlive, localHost });
    if (
      currentLease.phaseId !== phase.id ||
      currentLease.goalId !== ledger.codexGoal.objectiveSha256 ||
      currentLease.lane !== phase.lane ||
      currentLease.branch !== "main" ||
      stableJson(currentLease.allowedPaths) !== stableJson(phase.allowedPaths)
    ) {
      throw new GovernanceError(
        "PRODUCTION_LEASE_SCOPE_MISMATCH",
        "The writer lease does not match the active production phase",
      );
    }
    const dirty = evaluateDirtyGuard({
      ledger,
      phase,
      repoRoot,
      nowMs,
      externalProofValidator,
    });
    if (
      dirty.baselineErrors.length !== 0 ||
      dirty.working.allowed.length !== 0 ||
      dirty.working.blocked.length !== 0 ||
      dirty.committed.blocked.length !== 0
    ) {
      throw new GovernanceError(
        "PRODUCTION_WORKTREE_NOT_CLEAN",
        "Production commands require a completely clean worktree",
        { dirty },
      );
    }
    const branch = currentBranch(repoRoot);
    const head = currentHead(repoRoot);
    const originMain = sealedGitFor(repoRoot).localTrackingRef({
      ref: "refs/remotes/origin/main",
    });
    if (
      branch !== "main" ||
      originMain !== head ||
      currentLease.startHead !== head
    ) {
      throw new GovernanceError(
        "PRODUCTION_AUTHORIZATION_NOT_ON_ORIGIN_MAIN",
        "Authorization commit must be the clean synchronized origin/main head",
        { branch, head, originMain, leaseStartHead: currentLease.startHead },
      );
    }
    const authorization = validateProductionAuthorizationHistory({
      ledger,
      phase,
      grant,
      repoRoot,
      authorizationCommit: head,
    });
    if (!authorization.ok) {
      throw new GovernanceError(
        authorization.code,
        authorization.error,
        authorization.details,
      );
    }
    const qualityReceipt = readJson(qualityReceiptPath);
    const qualityValidation = validateQualityReceipt(qualityReceipt, {
      ledger: authorization.candidateLedger,
      phase: authorization.candidatePhase,
      head: grant.candidateCommit,
      workspaceDigest: cleanWorkspaceEvidenceDigest(),
      repoRoot,
      nowMs,
      externalProofValidator,
      // Raw judge bytes are replayed from the exact phase bundle below so
      // production authorization remains reproducible on a fresh checkout.
      verifyRawArtifacts: false,
    });
    if (
      !qualityValidation.valid ||
      qualityReceipt.receiptHash !== grant.qualityReceiptSha256
    ) {
      throw new GovernanceError(
        "PRODUCTION_QUALITY_RECEIPT_INVALID",
        "Candidate quality receipt is missing, stale, or mismatched",
        { errors: qualityValidation.errors },
      );
    }
    const phaseProofBundle = readBoundedRegularJson(phaseProofBundlePath);
    const phaseProofValidation = validatePhaseProofBundle(phaseProofBundle, {
      ledger: authorization.candidateLedger,
      phase: authorization.candidatePhase,
      qualityReceipt,
      repoRoot,
      requireFullChain: false,
      nowMs,
    });
    if (
      !phaseProofValidation.valid ||
      phaseProofValidation.productionChangeAuthorized !== true ||
      phaseProofBundle.bundleHash !== grant.phaseProofBundleSha256 ||
      phaseProofBundle.chain.candidate.receiptHash !==
        grant.phaseCandidateReceiptSha256 ||
      phaseProofBundle.chain.rehearsal.receiptHash !==
        grant.phaseRehearsalReceiptSha256
    ) {
      throw new GovernanceError(
        "PRODUCTION_PHASE_PROOF_INVALID",
        "Production requires an exact candidate-to-rehearsal proof chain authorized for change",
        { errors: phaseProofValidation.errors },
      );
    }
    if (action === "migrate") {
      const migration = grant.migrations.find(
        (candidate) => candidate.path === migrationPath,
      );
      if (!migration) {
        throw new GovernanceError(
          "MIGRATION_NOT_AUTHORIZED",
          "Migration is not named by the production grant",
          { migrationPath },
        );
      }
      const contentHash = sha256(
        fileAtCommit(repoRoot, grant.candidateCommit, migration.path),
      );
      if (contentHash !== migration.sha256) {
        throw new GovernanceError(
          "MIGRATION_CONTENT_MISMATCH",
          "Migration content does not match the authorized candidate",
          { expected: migration.sha256, actual: contentHash },
        );
      }
    } else if (action === "deploy") {
      if (!grant.deployment.enabled) {
        throw new GovernanceError(
          "DEPLOYMENT_NOT_AUTHORIZED",
          "Deployment is disabled by the production grant",
        );
      }
      const candidateTree = sealedGitFor(repoRoot).tree({
        commit: grant.candidateCommit,
      });
      if (candidateTree !== grant.deployment.tree) {
        throw new GovernanceError(
          "DEPLOYMENT_TREE_MISMATCH",
          "Candidate tree does not match the authorized deployment tree",
          { expected: grant.deployment.tree, actual: candidateTree },
        );
      }
    } else {
      throw new GovernanceError(
        "PRODUCTION_ACTION_UNKNOWN",
        `Unknown production action ${action}`,
      );
    }
    return {
      ok: true,
      phaseId: phase.id,
      action,
      candidateCommit: grant.candidateCommit,
      authorizationCommit: head,
      qualityReceiptHash: qualityReceipt.receiptHash,
      migrationPath: migrationPath || null,
    };
  } catch (error) {
    if (!(error instanceof GovernanceError)) throw error;
    return {
      ok: false,
      code: error.code,
      error: error.message,
      details: error.details,
    };
  }
}

module.exports = {
  ACTIVE_STATUSES,
  CANONICAL_HEARTBEAT_PROMPT_PATH,
  CANONICAL_HEARTBEAT_PROMPT_SHA256,
  CANONICAL_REGISTRY_SHA256,
  DEFAULT_ACTIVATION_RECEIPT_PATH,
  DEFAULT_FENCE_PATH,
  DEFAULT_LEDGER_PATH,
  DEFAULT_LEASE_PATH,
  DEFAULT_MORNING_RECEIPT_DIR,
  DEFAULT_PHASE_PROOF_BUNDLE_PATH,
  DEFAULT_PHASE_TRANSITION_JOURNAL_PATH,
  DEFAULT_QUALITY_ARTIFACT_DIR,
  DEFAULT_QUALITY_RECEIPT_PATH,
  DEFAULT_RECEIPT_PATH,
  DEFAULT_TIME_ZONE,
  GovernanceError,
  MAXIMUM_LEASE_MS,
  MINIMUM_BUILDER_SLICE_MS,
  PHASE_LEDGER_RELATIVE_PATH,
  QUALITY_CHECK_REGISTRY,
  QUALITY_TEST_SUITE_REGISTRY,
  REQUIRED_CRITICAL_PROFILE,
  REQUIRED_FORBIDDEN_EXTERNAL_EFFECTS,
  REQUIRED_POLICY_VALUES,
  REQUIRED_QUALITY_TOOLCHAIN,
  REQUIRED_QUALITY_EVIDENCE,
  REQUIRED_TRUSTED_GATE_PATHS,
  acquireWriterLease,
  appendRunReceipt,
  commitIsAncestor,
  cleanWorkspaceEvidenceDigest,
  createCapability,
  currentBranch,
  currentHead,
  digestTree,
  entryAllowed,
  effectiveQualityProfile,
  expectedHeartbeatAutomationContract,
  evaluateDirtyGuard,
  evaluateGoalGuard,
  evaluateMorningPriority,
  evaluateProductionGate,
  expectedQualityLayerNames,
  expectedQualityLayerPlan,
  hostPowerReceipt,
  issueHeartbeatActivationReceipt,
  issuePhaseTransition,
  loadPhaseLedger,
  morningReceiptPathForDate,
  parseGitNameStatus,
  parseGitStatus,
  pathAllowed,
  phaseProofBundleRelativePath,
  pidAlive,
  qualityCheckCommand,
  qualityUnitArgs,
  qualityUnitShardArgs,
  requiredCoverageFilesForPhase,
  validateQualityTestSuiteShards,
  readLease,
  readMorningTerminalReceipt,
  recoverPhaseTransition,
  releaseWriterLease,
  renewWriterLease,
  selectActivePhase,
  selectActivationPhase,
  sha256,
  shouldReclaimNestedTmsLock,
  stableJson,
  validateMorningTerminalReceipt,
  validateHeartbeatActivationReceipt,
  validateExternallyCertifiedPhaseProofEnvelope,
  validatePhaseLedger,
  validatePhaseProofBundle,
  validatePhaseTransition,
  validatePhaseTransitionHistory,
  validatePhaseTransitionJournal,
  validateProductionAuthorizationHistory,
  validateProofDisposition,
  validateQualityReceipt,
  validateRunReceipt,
  validateWriterLease,
  verifyReceiptChain,
  withOperationLock,
  workspaceEvidenceDigest,
  writeMorningTerminalReceipt,
  writeJsonAtomic,
  writeJsonExclusiveAtomic,
  writeQualityReceipt,
  zonedDateTimeToEpoch,
  zonedParts,
};

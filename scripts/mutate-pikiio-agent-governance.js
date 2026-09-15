#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCES = {
  governance: path.join(ROOT, "lib", "pikiio-agent-governance.js"),
  phaseProof: path.join(ROOT, "lib", "pikiio-phase-proof.js"),
  phaseProofEnvelope: path.join(
    ROOT,
    "lib",
    "pikiio-phase-proof-envelope.js",
  ),
  oidcCollector: path.join(ROOT, "lib", "pikiio-github-oidc-collector.js"),
  hostDurability: path.join(ROOT, "lib", "pikiio-host-durability.js"),
  liveRefreshLock: path.join(ROOT, "lib", "pikiio-live-refresh-lock.js"),
  writerClient: path.join(ROOT, "scripts", "pikiio-agent-writer-lease.js"),
  proofCollectorWorkflow: path.join(
    ROOT,
    ".github",
    "workflows",
    "pikiio-proof-collector.yml",
  ),
  proofRequestWorkflow: path.join(
    ROOT,
    ".github",
    "workflows",
    "pikiio-proof-request.yml",
  ),
};
const PROBE_PATH = path.join(
  ROOT,
  "tests",
  "pikiio-agent-governance-mutant-probe.js",
);
const LEDGER_PATH = path.join(
  ROOT,
  "YLYI",
  "00_Product_Contract",
  "Pikiio_Agent_Phases.json",
);
const PROBE_TIMEOUT_MS = 20_000;
const QUALITY_LAYER_PLAN_GUARD_ANCHOR =
  "if (!qualityLayerPlanMatches) {";
const QUALITY_LAYER_DEFINITION_ANCHOR =
  "definitionSha256: layerPlanEntry.definitionSha256,";

const mutants = [
  {
    id: "policy-one-writer",
    checkId: "policy-one-writer",
    fingerprint: "unsafe-one-writer-policy-accepted",
    source: "governance",
    from: "oneWriter: true,",
    to: "oneWriter: false,",
  },
  {
    id: "forbidden-effect-set",
    checkId: "forbidden-effect-set",
    fingerprint: "gmail-send-denial-removed",
    source: "governance",
    from: '  "gmail_send",\n',
    to: "",
  },
  {
    id: "active-phase-cardinality",
    checkId: "active-phase-cardinality",
    fingerprint: "multiple-active-phases-accepted",
    source: "governance",
    from: "if (active.length !== 1) {",
    to: "if (active.length < 1) {",
  },
  {
    id: "goal-required",
    checkId: "goal-required",
    fingerprint: "missing-controller-goal-accepted",
    source: "governance",
    from:
      "if (!nonemptyString(goalObjective) || !nonemptyString(goalThreadId)) {",
    to:
      "if (false && (!nonemptyString(goalObjective) || !nonemptyString(goalThreadId))) {",
  },
  {
    id: "goal-mismatch",
    checkId: "goal-mismatch",
    fingerprint: "mismatched-controller-goal-accepted",
    source: "governance",
    from:
      "goalThreadId !== ledger.codexGoal.threadId ||\n      sha256(goalObjective) !== ledger.codexGoal.objectiveSha256",
    to: "false",
  },
  {
    id: "repository-wide-scope",
    checkId: "repository-wide-scope",
    fingerprint: "repository-wide-write-scope-accepted",
    source: "governance",
    from: 'if (rule === "*") {',
    to: 'if (false && rule === "*") {',
  },
  {
    id: "baseline-path-traversal",
    checkId: "baseline-path-traversal",
    fingerprint: "baseline-path-traversal-accepted",
    source: "governance",
    from: 'entry.path.includes("..") ||\n        entry.path.includes("*")',
    to: 'false ||\n        entry.path.includes("*")',
  },
  {
    id: "required-command-layer",
    checkId: "required-command-layer",
    fingerprint: "empty-required-command-layer-accepted",
    source: "governance",
    from: "if (!nonemptyStringArray(plan[key])) {",
    to: "if (!Array.isArray(plan[key])) {",
  },
  {
    id: "rename-source-scope",
    checkId: "rename-source-scope",
    fingerprint: "rename-source-scope-bypassed",
    source: "governance",
    from:
      "return entry.paths.every((changedPath) => pathAllowed(changedPath, allowedPaths));",
    to: "return pathAllowed(entry.path, allowedPaths);",
  },
  {
    id: "committed-scope",
    checkId: "committed-scope",
    fingerprint: "committed-scope-bypassed",
    source: "governance",
    from:
      "const blockedCommitted = committedEntries.filter(\n    (entry) => !entryAllowed(entry, phase.allowedPaths),\n  );",
    to: "const blockedCommitted = [];",
  },
  {
    id: "pinned-baseline-digest",
    checkId: "pinned-baseline-digest",
    fingerprint: "changed-pinned-baseline-accepted",
    source: "governance",
    from: "actual.treeDigest !== entry.treeDigest ||",
    to: "false ||",
  },
  {
    id: "nested-live-pid",
    checkId: "nested-live-pid",
    fingerprint: "live-nested-tms-owner-reclaimed",
    source: "governance",
    from: "if (pidPresent && pidIsAlive) return false;",
    to: "if (false && pidPresent && pidIsAlive) return false;",
  },
  {
    id: "async-operation-lock",
    checkId: "async-operation-lock",
    fingerprint: "async-callback-released-synchronous-lock",
    source: "governance",
    from: 'if (result && typeof result.then === "function") {',
    to: 'if (false && result && typeof result.then === "function") {',
  },
  {
    id: "morning-boundary",
    checkId: "morning-boundary",
    fingerprint: "morning-boundary-write-admitted",
    source: "governance",
    from: "if (nowMs >= boundaryMs) {",
    to: "if (false && nowMs >= boundaryMs) {",
  },
  {
    id: "future-morning-receipt",
    checkId: "future-morning-receipt",
    fingerprint: "future-morning-receipt-accepted",
    source: "governance",
    from: "finishedAt <= nowMs &&",
    to: "true &&",
  },
  {
    id: "lease-maximum",
    checkId: "lease-maximum",
    fingerprint: "lease-maximum-ceiling-bypassed",
    source: "governance",
    from: "maximumLeaseMs > MAXIMUM_LEASE_MS",
    to: "false",
  },
  {
    id: "lease-capability",
    checkId: "lease-capability",
    fingerprint: "foreign-capability-released-lease",
    source: "governance",
    from: "current.capabilitySha256 !== sha256(capability) ||",
    to: "false ||",
  },
  {
    id: "lease-metadata",
    checkId: "lease-metadata",
    fingerprint: "caller-forged-lease-metadata-accepted",
    source: "governance",
    from: "stableJson(current) !== stableJson(lease)",
    to: "false",
  },
  {
    id: "lease-expiry",
    checkId: "lease-expiry",
    fingerprint: "expired-lease-renewed",
    source: "governance",
    from: "if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {",
    to: "if (!Number.isFinite(expiresAt)) {",
  },
  {
    id: "lease-owner-liveness",
    checkId: "lease-owner-liveness",
    fingerprint: "dead-lease-owner-renewed",
    source: "governance",
    from: "!isPidAlive(Number(lease.ownerPid))",
    to: "false",
  },
  {
    id: "proof-receipts-array",
    checkId: "proof-receipts-array",
    fingerprint: "non-array-proof-receipts-accepted",
    source: "governance",
    from: "if (!Array.isArray(value.receipts)) {",
    to: "if (false && !Array.isArray(value.receipts)) {",
  },
  {
    id: "quality-threshold-binding",
    checkId: "quality-threshold-binding",
    fingerprint: "forged-quality-thresholds-accepted",
    source: "governance",
    from: "profile && stableJson(receipt.thresholds) !== stableJson(profile)",
    to: "false",
  },
  {
    id: "quality-suite-registry",
    checkId: "quality-suite-registry",
    fingerprint: "unknown-quality-suite-accepted",
    source: "governance",
    from: "if (!isObject(QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId])) {",
    to: "if (false && !isObject(QUALITY_TEST_SUITE_REGISTRY[plan.testSuiteId])) {",
  },
  {
    id: "quality-scalar-check-registry",
    checkId: "quality-scalar-check-registry",
    fingerprint: "unknown-scalar-quality-check-accepted",
    source: "governance",
    from: "if (!isObject(QUALITY_CHECK_REGISTRY[plan[key]])) {",
    to: "if (false && !isObject(QUALITY_CHECK_REGISTRY[plan[key]])) {",
  },
  {
    id: "quality-array-check-registry",
    checkId: "quality-array-check-registry",
    fingerprint: "unknown-array-quality-check-accepted",
    source: "governance",
    from: "if (!isObject(QUALITY_CHECK_REGISTRY[checkId])) {",
    to: "if (false && !isObject(QUALITY_CHECK_REGISTRY[checkId])) {",
  },
  {
    id: "quality-ledger-digest",
    checkId: "quality-ledger-digest",
    fingerprint: "forged-quality-ledger-digest-accepted",
    source: "governance",
    from: "if (receipt.ledgerSha256 !== sha256(stableJson(ledger))) {",
    to: "if (false && receipt.ledgerSha256 !== sha256(stableJson(ledger))) {",
  },
  {
    id: "quality-plan-digest",
    checkId: "quality-plan-digest",
    fingerprint: "forged-quality-plan-digest-accepted",
    source: "governance",
    from:
      "if (receipt.qualityPlanSha256 !== sha256(stableJson(phase.qualityPlan))) {",
    to:
      "if (false && receipt.qualityPlanSha256 !== sha256(stableJson(phase.qualityPlan))) {",
  },
  {
    id: "quality-coverage",
    checkId: "quality-coverage",
    fingerprint: "low-coverage-quality-receipt-accepted",
    source: "governance",
    from: "coverage.lines < profile.minimumLineCoveragePercent",
    to: "false",
  },
  {
    id: "quality-mutation",
    checkId: "quality-mutation",
    fingerprint: "low-mutation-quality-receipt-accepted",
    source: "governance",
    from:
      "metrics.minimumObservedMutationScore <\n          profile.minimumMutationScorePercent",
    to: "false",
  },
  {
    id: "quality-unit-population-floor",
    checkId: "quality-unit-population-floor",
    fingerprint: "collapsed-unit-population-accepted",
    source: "governance",
    from:
      "metrics.testsPerRun < (profile?.minimumUnitTestsPerRun ?? 1) ||",
    to: "false ||",
  },
  {
    id: "quality-mutation-population-floor",
    checkId: "quality-mutation-population-floor",
    fingerprint: "collapsed-mutation-population-accepted",
    source: "governance",
    from:
      "metrics.minimumMutationPopulation <\n        (profile?.minimumMutationPopulation ?? 1) ||",
    to: "false ||",
  },
  {
    id: "quality-critical-population-floor",
    checkId: "quality-critical-population-floor",
    fingerprint: "collapsed-critical-mutation-population-accepted",
    source: "governance",
    from:
      "metrics.minimumCriticalMutationPopulation <\n        (profile?.minimumCriticalMutationPopulation ?? 1) ||",
    to: "false ||",
  },
  {
    id: "quality-gherkin-population-floor",
    checkId: "quality-gherkin-population-floor",
    fingerprint: "collapsed-gherkin-population-accepted",
    source: "governance",
    from:
      "metrics.minimumGherkinScenarioPopulation <\n        (profile?.minimumGherkinScenarioPopulation ?? 1) ||",
    to: "false ||",
  },
  {
    id: "quality-classifier-meta-summary",
    checkId: "quality-classifier-meta-summary",
    fingerprint: "failed-classifier-meta-summary-accepted",
    source: "governance",
    from: "metrics.mutationClassifierMetaTestsPassed !== true",
    to: "false",
  },
  {
    id: "quality-classifier-meta-raw",
    checkId: "quality-classifier-meta-raw",
    fingerprint: "failed-raw-classifier-meta-test-accepted",
    source: "governance",
    from: "entry.metaTestsPassed === true,",
    to: "true,",
  },
  {
    id: "quality-layer-plan",
    checkId: "quality-layer-plan",
    fingerprint: "wrong-quality-layer-plan-accepted",
    source: "governance",
    from: QUALITY_LAYER_PLAN_GUARD_ANCHOR,
    to: "if (false) {",
  },
  {
    id: "quality-layer-definition-binding",
    checkId: "quality-layer-definition-binding",
    fingerprint: "forged-layer-definition-digest-accepted",
    source: "governance",
    from: QUALITY_LAYER_DEFINITION_ANCHOR,
    to: "",
  },
  {
    id: "quality-command-plan-digest",
    checkId: "quality-command-plan-digest",
    fingerprint: "forged-command-plan-digest-accepted",
    source: "governance",
    from:
      "receipt.commandPlanSha256 !== sha256(stableJson(expectedLayers))",
    to: "false",
  },
  {
    id: "automation-contract-binding",
    checkId: "automation-contract-binding",
    fingerprint: "forged-automation-contract-accepted",
    source: "governance",
    from:
      "stableJson(ledger.automationContract) !== stableJson(expectedAutomation)",
    to: "false",
  },
  {
    id: "quality-operational-checkout-binding",
    checkId: "quality-operational-checkout-binding",
    fingerprint: "changed-operational-checkout-accepted",
    source: "governance",
    from: "operational.afterSha256 !== operational.beforeSha256",
    to: "false",
  },
  {
    id: "quality-approved-toolchain-binding",
    checkId: "quality-approved-toolchain-binding",
    fingerprint: "unapproved-quality-toolchain-accepted",
    source: "governance",
    from:
      "stableJson(toolchain) !==\n        stableJson(\n          ledger?.qualityPolicy?.approvedToolchain ||\n            REQUIRED_QUALITY_TOOLCHAIN,\n        )",
    to: "false",
  },
  {
    id: "quality-operational-scope-qualifiers",
    checkId: "quality-operational-scope-qualifiers",
    fingerprint: "unqualified-operational-evidence-accepted",
    source: "governance",
    from:
      "operational.schema !== \"pikiio-operational-git-visible-evidence-v1\" ||\n    operational.scope !== \"git-visible-worktree-and-index\" ||",
    to: "false ||",
  },
  {
    id: "quality-canonical-transition-recomputation",
    checkId: "quality-canonical-transition-recomputation",
    fingerprint: "self-asserted-canonical-transition-accepted",
    source: "governance",
    from:
      "const canonicalTransition = validatePhaseTransitionHistory({\n" +
      "        ledger,\n" +
      "        phase,\n" +
      "        repoRoot,\n" +
      "        nowMs,\n" +
      "        externalProofValidator,\n" +
      "        throughCommit: head,\n" +
      "      });\n" +
      "      if (\n" +
      "        !canonicalTransition.ok ||\n" +
      "        stableJson(receipt.antiWeakening?.canonicalTransition) !==\n" +
      "          stableJson(canonicalTransition)",
    to:
      "const canonicalTransition =\n" +
      "        receipt.antiWeakening.canonicalTransition;\n" +
      "      if (\n" +
      "        !canonicalTransition.ok ||\n" +
      "        stableJson(receipt.antiWeakening?.canonicalTransition) !==\n" +
      "          stableJson(canonicalTransition)",
  },
  {
    id: "quality-raw-artifact-address-binding",
    checkId: "quality-raw-artifact-address-binding",
    fingerprint: "misaddressed-raw-artifact-accepted",
    source: "governance",
    from:
      "artifact.layerCount !== layerCount ||\n    path.basename(artifact.artifactPath) !==\n      `${artifact.artifactSha256}.json`",
    to: "false",
  },
  {
    id: "quality-independent-raw-artifact-required",
    checkId: "quality-independent-raw-artifact-required",
    fingerprint: "missing-independent-raw-artifact-accepted",
    source: "governance",
    from:
      "validateJudgeRawArtifact(\n    clean?.rawArtifact,\n    Array.isArray(receipt.layers) ? receipt.layers.length : -1,\n    errors,\n    \"quality receipt independent raw artifact\",\n    {\n      verifyBytes: verifyRawArtifacts,\n      artifactDirectory: qualityArtifactDirectory,\n      rawArtifactBytes,\n      expectedLabel: \"independent\",\n      receipt,\n    },\n  );",
    to: "void clean;",
  },
  {
    id: "quality-dependency-manifest-binding",
    checkId: "quality-dependency-manifest-binding",
    fingerprint: "forged-dependency-manifest-accepted",
    source: "governance",
    from: "if (sha256(stableJson(unsigned)) !== manifestSha256) {",
    to: "if (false) {",
  },
  {
    id: "quality-primary-judge-binding",
    checkId: "quality-primary-judge-binding",
    fingerprint: "wrong-primary-judge-head-accepted",
    source: "governance",
    from: "primary.worktreeHead !== head ||",
    to: "false ||",
  },
  {
    id: "quality-independent-snapshot-binding",
    checkId: "quality-independent-snapshot-binding",
    fingerprint: "wrong-independent-snapshot-accepted",
    source: "governance",
    from:
      "clean.automationSnapshotSha256 !== receipt.automationSnapshotSha256 ||",
    to: "false ||",
  },
  {
    id: "quality-independent-dependency-binding",
    checkId: "quality-independent-dependency-binding",
    fingerprint: "divergent-independent-dependencies-accepted",
    source: "governance",
    from:
      "stableJson(clean.dependencyManifest) !==\n    stableJson(receipt.dependencyManifest)",
    to: "false",
  },
  {
    id: "phase-proof-scope-base-authority",
    checkId: "phase-proof-scope-base-authority",
    fingerprint: "candidate-owned-authority-baseline-accepted",
    source: "phaseProof",
    from: 'policy?.authorityBaseline === "scope_base",',
    to: 'policy?.authorityBaseline === "candidate",',
  },
  {
    id: "oidc-jwks-registry-pin",
    checkId: "oidc-jwks-registry-pin",
    fingerprint: "substituted-jwks-registry-accepted",
    source: "oidcCollector",
    from: "registry.registrySha256 !== expectedRegistrySha256",
    to: "false",
  },
  {
    id: "oidc-signature-verification",
    checkId: "oidc-signature-verification",
    fingerprint: "invalid-oidc-signature-accepted",
    source: "oidcCollector",
    from: "if (!signatureValid) {",
    to: "if (false && !signatureValid) {",
  },
  {
    id: "oidc-audience-binding",
    checkId: "oidc-audience-binding",
    fingerprint: "wrong-oidc-audience-accepted",
    source: "oidcCollector",
    from: "payload.aud !== audience ||",
    to: "false ||",
  },
  {
    id: "oidc-candidate-binding",
    checkId: "oidc-candidate-binding",
    fingerprint: "wrong-oidc-candidate-accepted",
    source: "oidcCollector",
    from:
      "payload.sha !== candidateCommit ||\n    payload.workflow_sha !== candidateCommit ||",
    to: "false ||",
  },
  {
    id: "oidc-reusable-workflow-binding",
    checkId: "oidc-reusable-workflow-binding",
    fingerprint: "wrong-frozen-workflow-authority-accepted",
    source: "oidcCollector",
    from:
      "payload.job_workflow_sha !== scopeBaseCommit ||\n    payload.job_workflow_ref !== workflowRef",
    to: "false",
  },
  {
    id: "oidc-workflow-sha-scope-binding",
    checkId: "oidc-workflow-sha-scope-binding",
    fingerprint: "wrong-workflow-sha-scope-accepted",
    source: "oidcCollector",
    from: "payload.job_workflow_sha !== scopeBaseCommit ||",
    to: "false ||",
  },
  {
    id: "oidc-fixed-workflow-tag-binding",
    checkId: "oidc-fixed-workflow-tag-binding",
    fingerprint: "moving-workflow-ref-accepted",
    source: "oidcCollector",
    from: "payload.job_workflow_ref !== workflowRef",
    to: "false",
  },
  {
    id: "oidc-run-context-binding",
    checkId: "oidc-run-context-binding",
    fingerprint: "wrong-github-run-context-accepted",
    source: "oidcCollector",
    from: "payload.event_name !== expectedRun.eventName ||",
    to: "false ||",
  },
  {
    id: "envelope-external-oidc-validation",
    checkId: "envelope-external-oidc-validation",
    fingerprint: "invalid-external-oidc-envelope-accepted",
    source: "phaseProofEnvelope",
    from: "collectorResult = validateGithubOidcCollectorReceipt({",
    to:
      "collectorResult = {\n" +
      "      valid: true,\n" +
      "      receiptHash: decoded.receipt.receiptHash,\n" +
      "      bodySha256: bodyReport.bodySha256,\n" +
      "      candidateCommit: expected.candidateCommit,\n" +
      "      scopeBaseCommit: expected.scopeBaseCommit,\n" +
      "      runId: certification.githubRun.runId,\n" +
      "      runAttempt: certification.githubRun.runAttempt,\n" +
      "      collectedAt: certification.verifiedAt,\n" +
      "      replayKey: certification.replayProtection.replayKey,\n" +
      "    };\n" +
      "    void ({",
  },
  {
    id: "external-validator-canonical-alias-refusal",
    checkId: "external-validator-canonical-alias-refusal",
    fingerprint: "canonical-repository-alias-validator-invoked",
    source: "governance",
    from: "identity.canonical ||",
    to: "false ||",
  },
  {
    id: "envelope-local-collector-private-key-denial",
    checkId: "envelope-local-collector-private-key-denial",
    fingerprint: "local-collector-private-key-authority-accepted",
    source: "phaseProofEnvelope",
    from:
      "authorityRegistry.controller.localCollectorPrivateKeyAllowed !== false ||",
    to:
      "authorityRegistry.controller.localCollectorPrivateKeyAllowed !== true ||",
  },
  {
    id: "envelope-authority-fixed-workflow-ref",
    checkId: "envelope-authority-fixed-workflow-ref",
    fingerprint: "moving-authority-workflow-ref-accepted",
    source: "phaseProofEnvelope",
    from:
      "authorityRegistry.collector.workflowRef !== REUSABLE_WORKFLOW_REF ||",
    to: "false ||",
  },
  {
    id: "envelope-cert-core-bundle-binding",
    checkId: "envelope-cert-core-bundle-binding",
    fingerprint: "detached-certification-core-hash-accepted",
    source: "phaseProofEnvelope",
    from:
      "certification.phaseProofBundleHash !== expected.coreBundleHash ||",
    to: "false ||",
  },
  {
    id: "envelope-cert-receipt-hashes-binding",
    checkId: "envelope-cert-receipt-hashes-binding",
    fingerprint: "detached-certification-receipt-hashes-accepted",
    source: "phaseProofEnvelope",
    from:
      "stableJson(certification.receiptHashes) !== stableJson(receiptHashes) ||",
    to: "false ||",
  },
  {
    id: "envelope-cert-attestation-body-binding",
    checkId: "envelope-cert-attestation-body-binding",
    fingerprint: "detached-certification-attestation-body-accepted",
    source: "phaseProofEnvelope",
    from:
      "stableJson(certification.attestationBody) !== stableJson(expectedBody) ||",
    to: "false ||",
  },
  {
    id: "envelope-signed-raw-artifact-exact-set",
    checkId: "envelope-signed-raw-artifact-exact-set",
    fingerprint: "unsigned-extra-core-artifact-accepted",
    source: "phaseProofEnvelope",
    from:
      "actualAddresses.length !== requiredAddresses.length ||\n    actualAddresses.some(\n      (address, index) => address !== requiredAddresses[index],\n    )",
    to: "false",
  },
  {
    id: "envelope-replay-consumption-scope",
    checkId: "envelope-replay-consumption-scope",
    fingerprint: "weakened-replay-consumption-scope-accepted",
    source: "phaseProofEnvelope",
    from:
      'replayProtection.consumptionScope !==\n      "single-controller-local-runtime" ||',
    to: "false ||",
  },
  {
    id: "envelope-replay-multi-host-safety",
    checkId: "envelope-replay-multi-host-safety",
    fingerprint: "unsafe-multi-host-replay-metadata-accepted",
    source: "phaseProofEnvelope",
    from: "replayProtection.multiHostSafe !== false ||",
    to: "false ||",
  },
  {
    id: "envelope-replay-key-binding",
    checkId: "envelope-replay-key-binding",
    fingerprint: "detached-replay-key-accepted",
    source: "phaseProofEnvelope",
    from: "replayProtection.replayKey !== collectorResult.replayKey ||",
    to: "false ||",
  },
  {
    id: "workflow-top-level-id-token-denial",
    checkId: "workflow-top-level-id-token-denial",
    fingerprint: "workflow-global-id-token-privilege-accepted",
    source: "proofCollectorWorkflow",
    from: "permissions:\n  contents: read\n\njobs:",
    to: "permissions:\n  contents: read\n  id-token: write\n\njobs:",
  },
  {
    id: "workflow-gauntlet-id-token-denial",
    checkId: "workflow-gauntlet-id-token-denial",
    fingerprint: "gauntlet-id-token-privilege-accepted",
    source: "proofCollectorWorkflow",
    from:
      "  gauntlet:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 60\n    permissions:\n      contents: read",
    to:
      "  gauntlet:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 60\n    permissions:\n      contents: read\n      id-token: write",
  },
  {
    id: "workflow-collect-id-token-required",
    checkId: "workflow-collect-id-token-required",
    fingerprint: "collect-without-id-token-accepted",
    source: "proofCollectorWorkflow",
    from:
      "    permissions:\n      contents: read\n      id-token: write\n    outputs:",
    to: "    permissions:\n      contents: read\n    outputs:",
  },
  {
    id: "workflow-collect-authority-only-execution",
    checkId: "workflow-collect-authority-only-execution",
    fingerprint: "candidate-execution-in-collect-accepted",
    source: "proofCollectorWorkflow",
    from: '          cd "${{ steps.checkout.outputs.authority }}"',
    to: '          cd "$RUNNER_TEMP/pikiio-proof-repo"',
  },
  {
    id: "workflow-request-fixed-authority-tag",
    checkId: "workflow-request-fixed-authority-tag",
    fingerprint: "moving-request-workflow-ref-accepted",
    source: "proofRequestWorkflow",
    from:
      "uses: demo-maintainer/Pikiio-app-/.github/workflows/pikiio-proof-collector.yml@pikiio-proof-authority-v1",
    to:
      "uses: demo-maintainer/Pikiio-app-/.github/workflows/pikiio-proof-collector.yml@main",
  },
  {
    id: "quality-embedded-raw-hash",
    checkId: "quality-embedded-raw-hash",
    fingerprint: "tampered-embedded-quality-artifact-accepted",
    source: "governance",
    from:
      "bytes.length !== artifact.byteLength ||\n      sha256(bytes) !== artifact.artifactSha256",
    to: "bytes.length !== artifact.byteLength ||\n      false",
  },
  {
    id: "host-receipt-freshness",
    checkId: "host-receipt-freshness",
    fingerprint: "stale-host-receipt-accepted",
    source: "hostDurability",
    from:
      "observedAt > nowMs ||\n    nowMs - observedAt > MAXIMUM_RECEIPT_AGE_MS",
    to: "false",
  },
  {
    id: "host-service-running",
    checkId: "host-service-running",
    fingerprint: "stopped-keep-awake-service-accepted",
    source: "hostDurability",
    from: 'if (receipt.service.state !== "running") {',
    to: 'if (false && receipt.service.state !== "running") {',
  },
  {
    id: "host-exact-plist-digest",
    checkId: "host-exact-plist-digest",
    fingerprint: "wrong-keep-awake-plist-accepted",
    source: "hostDurability",
    from:
      "receipt.servicePlist.sha256 !== HOST_SERVICE_PLIST_SHA256 ||",
    to: "false ||",
  },
  {
    id: "host-sleep-policy-readable",
    checkId: "host-sleep-policy-readable",
    fingerprint: "unreadable-host-sleep-policy-accepted",
    source: "hostDurability",
    from:
      "!Number.isSafeInteger(receipt.sleep.acSleepMinutes) ||\n    receipt.sleep.acSleepMinutes < 0",
    to: "false",
  },
  {
    id: "host-sleep-assertions",
    checkId: "host-sleep-assertions",
    fingerprint: "missing-keep-awake-assertions-accepted",
    source: "hostDurability",
    from:
      "receipt.assertions.preventSystemSleep !== true ||\n    receipt.assertions.preventIdleSystemSleep !== true",
    to: "false",
  },
  {
    id: "writer-fresh-host-admission",
    checkId: "writer-fresh-host-admission",
    fingerprint: "invalid-live-host-bypassed-to-bootstrap",
    source: "writerClient",
    from: "if (hostGateRequired(phaseId)) {",
    to: "if (false && hostGateRequired(phaseId)) {",
  },
  {
    id: "exclusive-write-no-replace",
    checkId: "exclusive-write-no-replace",
    fingerprint: "content-addressed-destination-overwritten",
    source: "governance",
    from: "fs.linkSync(temporary, filePath);",
    to: "fs.renameSync(temporary, filePath);",
  },
  {
    id: "exclusive-write-directory-fsync",
    checkId: "exclusive-write-directory-fsync",
    fingerprint: "exclusive-write-directory-not-durable",
    source: "governance",
    from:
      "fs.linkSync(temporary, filePath);\n    fsyncContainingDirectory(filePath);",
    to: "fs.linkSync(temporary, filePath);",
  },
  {
    id: "exclusive-write-temporary-cleanup",
    checkId: "exclusive-write-temporary-cleanup",
    fingerprint: "exclusive-write-temporary-leaked",
    source: "governance",
    from:
      "fs.unlinkSync(temporary);\n      fsyncContainingDirectory(filePath);",
    to: "void temporary;",
  },
  {
    id: "transition-recovery-artifact-hash",
    checkId: "transition-recovery-artifact-hash",
    fingerprint: "tampered-transition-artifact-accepted",
    source: "governance",
    from: "if (actualSha256 !== expectedSha256) {",
    to: "if (false && actualSha256 !== expectedSha256) {",
  },
  {
    id: "transition-recovery-ledger-divergence",
    checkId: "transition-recovery-ledger-divergence",
    fingerprint: "divergent-transition-ledger-rolled-back",
    source: "governance",
    from: "if (ledgerSha256 !== journal.beforeLedgerSha256) {",
    to: "if (false && ledgerSha256 !== journal.beforeLedgerSha256) {",
  },
  {
    id: "transition-recovery-orphan-cleanup",
    checkId: "transition-recovery-orphan-cleanup",
    fingerprint: "uncommitted-transition-artifact-survived-recovery",
    source: "governance",
    from: "if (present) {\n      fs.unlinkSync(artifact.absolutePath);",
    to: "if (false && present) {\n      fs.unlinkSync(artifact.absolutePath);",
  },
  {
    id: "activation-active-phase-binding",
    checkId: "activation-active-phase-binding",
    fingerprint: "planned-phase-selected-for-activation",
    source: "governance",
    from: "if (phase && phase.id !== selected.id) {",
    to: "if (false && phase && phase.id !== selected.id) {",
  },
  {
    id: "transition-quality-receipt-required",
    checkId: "transition-quality-receipt-required",
    fingerprint: "transition-without-quality-receipt-accepted",
    source: "governance",
    from:
      "if (!isObject(qualityReceipt)) {\n    errors.push(\"phase transition requires the complete strict quality receipt\");",
    to:
      "if (!isObject(qualityReceipt)) {\n    return { valid: true, errors: [] };",
  },
  {
    id: "transition-completion-path-binding",
    checkId: "transition-completion-path-binding",
    fingerprint: "non-content-addressed-completion-path-accepted",
    source: "governance",
    from:
      'errors.push("previous phase lacks an exact completion receipt");',
    to: "return { valid: true, errors: [] };",
  },
  {
    id: "transition-quality-hash-binding",
    checkId: "transition-quality-hash-binding",
    fingerprint: "mismatched-transition-quality-hash-accepted",
    source: "governance",
    from:
      'errors.push("phase completion does not match strict quality and phase proof");',
    to: "return { valid: true, errors: [] };",
  },
  {
    id: "receipt-chain-link",
    checkId: "receipt-chain-link",
    fingerprint: "broken-receipt-chain-link-accepted",
    source: "governance",
    from: "if (receipt.previousReceiptHash !== previousHash) {",
    to: "if (false && receipt.previousReceiptHash !== previousHash) {",
  },
  {
    id: "production-default-deny",
    checkId: "production-default-deny",
    fingerprint: "default-production-deny-bypassed",
    source: "governance",
    from:
      "const authority = phase.productionAuthority;\n    if (!authority.enabled) {\n      throw new GovernanceError(\n        \"PRODUCTION_AUTHORITY_DISABLED\",\n        `Production authority is disabled for ${phase.id}`,\n      );\n    }",
    to:
      "const authority = phase.productionAuthority;\n    if (!authority.enabled) {\n      return { ok: true, phaseId: phase.id, action };\n    }",
  },
  {
    id: "production-grant-expiry",
    checkId: "production-grant-expiry",
    fingerprint: "expired-production-grant-accepted",
    source: "governance",
    from: "if (Date.parse(grant.expiresAt) <= nowMs) {",
    to: "if (false && Date.parse(grant.expiresAt) <= nowMs) {",
  },
  {
    id: "os-advisory-lock",
    checkId: "os-advisory-lock",
    fingerprint: "os-advisory-lock-contract-weakened",
    source: "writerClient",
    from: 'command: "/usr/bin/lockf",',
    to: "command: process.execPath,",
  },
  {
    id: "live-refresh-live-serializer-owner",
    checkId: "live-refresh-live-serializer-owner",
    fingerprint: "live-serializer-owner-stolen",
    source: "liveRefreshLock",
    from: "if (isPidAlive(current.payload.pid)) {",
    to: "if (false && isPidAlive(current.payload.pid)) {",
  },
  {
    id: "live-refresh-dead-serializer-recovery",
    checkId: "live-refresh-dead-serializer-recovery",
    fingerprint: "dead-serializer-recovery-disabled",
    source: "liveRefreshLock",
    from: "if (isPidAlive(current.payload.pid)) {",
    to: "if (true || isPidAlive(current.payload.pid)) {",
  },
  {
    id: "live-refresh-live-run-owner",
    checkId: "live-refresh-live-run-owner",
    fingerprint: "age-expired-live-run-owner-stolen",
    source: "liveRefreshLock",
    from: "pidIsAlive: ownerAlive,",
    to: "pidIsAlive: false,",
  },
  {
    id: "live-refresh-run-release-identity",
    checkId: "live-refresh-run-release-identity",
    fingerprint: "foreign-run-lock-released",
    source: "liveRefreshLock",
    from: "current.payload.lockId !== lockId ||",
    to: "false ||",
  },
  {
    id: "live-refresh-operation-release-identity",
    checkId: "live-refresh-operation-release-identity",
    fingerprint: "foreign-operation-lock-released",
    source: "liveRefreshLock",
    from: "current.payload.operationId !== operationId ||",
    to: "false ||",
  },
  {
    id: "live-refresh-write-failure-cleanup",
    checkId: "live-refresh-write-failure-cleanup",
    fingerprint: "owned-run-lock-leaked-after-write-failure",
    source: "liveRefreshLock",
    from:
      "await removePathStillOwned(lockPath, handle).catch(() => {});",
    to: "void handle;",
  },
  {
    id: "live-refresh-foreign-inode-cleanup",
    checkId: "live-refresh-foreign-inode-cleanup",
    fingerprint: "foreign-inode-unlinked",
    source: "liveRefreshLock",
    from:
      "if (opened.dev !== current.dev || opened.ino !== current.ino) return false;",
    to: "if (false) return false;",
  },
].map((mutant) => ({ ...mutant, critical: true }));

function replaceExactlyOnce(source, from, to, id) {
  const first = source.indexOf(from);
  if (first === -1) {
    const error = new Error(`${id}: mutation anchor missing`);
    error.code = "MUTATION_ANCHOR_MISSING";
    throw error;
  }
  if (source.indexOf(from, first + from.length) !== -1) {
    const error = new Error(`${id}: mutation anchor is ambiguous`);
    error.code = "MUTATION_ANCHOR_AMBIGUOUS";
    throw error;
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

function parseLastJson(value) {
  const lines = String(value || "").trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Probe output is deliberately one compact JSON object on its last line.
    }
  }
  return null;
}

function runProbe(
  sourcePath,
  checkId,
  { metaMode = "", timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  return spawnSync(
    process.execPath,
    [PROBE_PATH, sourcePath, LEDGER_PATH, ROOT, checkId],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        PIKIIO_MUTANT_META_MODE: metaMode,
      },
      maxBuffer: 5 * 1024 * 1024,
    },
  );
}

function classifyKill(result, mutant) {
  const payload = parseLastJson(result.stdout);
  const killed =
    result.status === 1 &&
    !result.signal &&
    !result.error &&
    payload?.ok === false &&
    payload?.reason === "assertion_failed" &&
    payload?.checkId === mutant.checkId &&
    payload?.fingerprint === mutant.fingerprint;
  return {
    killed,
    payload,
    exitCode: result.status,
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT",
    spawnError: result.error?.message || null,
  };
}

function assertBaseline(mutant) {
  const result = runProbe(SOURCES[mutant.source], mutant.checkId);
  const payload = parseLastJson(result.stdout);
  if (
    result.status !== 0 ||
    result.signal ||
    result.error ||
    payload?.ok !== true ||
    payload?.checkId !== mutant.checkId
  ) {
    const error = new Error(
      `${mutant.id}: baseline probe failed before mutation`,
    );
    error.code = "MUTATION_BASELINE_FAILED";
    error.details = {
      exitCode: result.status,
      signal: result.signal || null,
      error: result.error?.message || null,
      stdout: String(result.stdout || "").slice(-4000),
      stderr: String(result.stderr || "").slice(-4000),
    };
    throw error;
  }
}

function runMetaTests() {
  const sample = mutants[0];
  const crash = classifyKill(
    runProbe(SOURCES[sample.source], sample.checkId, { metaMode: "crash" }),
    sample,
  );
  const timeout = classifyKill(
    runProbe(SOURCES[sample.source], sample.checkId, {
      metaMode: "timeout",
      timeoutMs: 200,
    }),
    sample,
  );
  const wrongFingerprint = classifyKill(
    runProbe(SOURCES[sample.source], sample.checkId, {
      metaMode: "wrong-fingerprint",
    }),
    sample,
  );
  const results = [
    { name: "crash-is-not-a-kill", passed: crash.killed === false, ...crash },
    {
      name: "timeout-is-not-a-kill",
      passed: timeout.killed === false && timeout.timedOut === true,
      ...timeout,
    },
    {
      name: "wrong-fingerprint-is-not-a-kill",
      passed: wrongFingerprint.killed === false,
      ...wrongFingerprint,
    },
  ];
  if (results.some((result) => !result.passed)) {
    const error = new Error("Mutation classifier meta-tests failed");
    error.code = "MUTATION_CLASSIFIER_UNSAFE";
    error.details = { results };
    throw error;
  }
  return results;
}

function main() {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  const phase = ledger.phases.find(
    (candidate) => candidate.id === ledger.activePhaseId,
  );
  const profile = ledger.qualityPolicy.profiles[phase.qualityProfile];
  const sourceCache = Object.fromEntries(
    Object.entries(SOURCES).map(([key, sourcePath]) => [
      key,
      fs.readFileSync(sourcePath, "utf8"),
    ]),
  );
  if (process.argv.includes("--anchors-only")) {
    for (const mutant of mutants) {
      replaceExactlyOnce(
        sourceCache[mutant.source],
        mutant.from,
        mutant.to,
        mutant.id,
      );
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "source-anchors-only",
      total: mutants.length,
      criticalTotal: mutants.filter((mutant) => mutant.critical).length,
      skipped: 0,
      ids: mutants.map((mutant) => mutant.id),
    }, null, 2)}\n`);
    return;
  }
  const metaTests = runMetaTests();
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pikiio-governance-mutants-"),
  );
  const temporaryLib = path.join(temporaryRoot, "lib");
  const temporaryScripts = path.join(temporaryRoot, "scripts");
  fs.mkdirSync(temporaryLib);
  fs.mkdirSync(temporaryScripts);
  fs.symlinkSync(path.join(ROOT, "YLYI"), path.join(temporaryRoot, "YLYI"));
  for (const fileName of fs.readdirSync(path.join(ROOT, "lib"))) {
    fs.symlinkSync(
      path.join(ROOT, "lib", fileName),
      path.join(temporaryLib, fileName),
    );
  }
  for (const fileName of [
    "pikiio-agent-lease-holder.js",
    "pikiio-agent-writer-lease.js",
  ]) {
    fs.symlinkSync(
      path.join(ROOT, "scripts", fileName),
      path.join(temporaryScripts, fileName),
    );
  }
  const results = [];
  try {
    for (const mutant of mutants) {
      assertBaseline(mutant);
      const mutated = replaceExactlyOnce(
        sourceCache[mutant.source],
        mutant.from,
        mutant.to,
        mutant.id,
      );
      const sourceExtension =
        path.extname(SOURCES[mutant.source]) || ".js";
      const mutantDirectory =
        mutant.source === "writerClient"
          ? temporaryScripts
          : mutant.source === "proofCollectorWorkflow" ||
              mutant.source === "proofRequestWorkflow"
            ? temporaryRoot
            : temporaryLib;
      const mutantPath = path.join(
        mutantDirectory,
        `${mutant.id}${sourceExtension}`,
      );
      fs.writeFileSync(mutantPath, mutated, { mode: 0o600 });
      const classification = classifyKill(
        runProbe(mutantPath, mutant.checkId),
        mutant,
      );
      results.push({
        id: mutant.id,
        critical: mutant.critical,
        checkId: mutant.checkId,
        expectedFingerprint: mutant.fingerprint,
        ...classification,
      });
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const killed = results.filter((result) => result.killed).length;
  const critical = results.filter((result) => result.critical);
  const criticalKilled = critical.filter((result) => result.killed).length;
  const scorePercent = Number(
    ((killed / Math.max(results.length, 1)) * 100).toFixed(2),
  );
  const criticalMutantKillPercent = Number(
    ((criticalKilled / Math.max(critical.length, 1)) * 100).toFixed(2),
  );
  const survived = results.length - killed;
  const survivedCritical = critical.length - criticalKilled;
  const metaTestsPassed =
    metaTests.length > 0 && metaTests.every((metaTest) => metaTest.passed);
  const report = {
    ok:
      results.length > 0 &&
      critical.length > 0 &&
      metaTestsPassed &&
      scorePercent >= profile.minimumMutationScorePercent &&
      criticalMutantKillPercent >=
        profile.minimumCriticalMutantKillPercent &&
      survivedCritical === 0,
    mutationEngine: "pikiio-fingerprinted-critical-mutants-v2",
    classifierPolicy:
      "Only the expected assertion fingerprint at exit 1 counts as a kill; crashes, load failures, signals, timeouts, and unrelated exits survive.",
    thresholds: {
      minimumMutationScorePercent: profile.minimumMutationScorePercent,
      minimumCriticalMutantKillPercent:
        profile.minimumCriticalMutantKillPercent,
    },
    total: results.length,
    killed,
    survived,
    skipped: 0,
    criticalTotal: critical.length,
    criticalKilled,
    survivedCritical,
    criticalSkipped: 0,
    scorePercent,
    criticalMutantKillPercent,
    metaTestsPassed,
    metaTests,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code || "MUTATION_GAUNTLET_FAILED",
      error: error instanceof Error ? error.message : String(error),
      details: error.details || {},
    }, null, 2)}\n`);
    process.exit(1);
  }
}

module.exports = {
  __testOnly: Object.freeze({
    qualityLayerPlanAnchors: Object.freeze([
      QUALITY_LAYER_PLAN_GUARD_ANCHOR,
      QUALITY_LAYER_DEFINITION_ANCHOR,
    ]),
    replaceExactlyOnce,
  }),
};

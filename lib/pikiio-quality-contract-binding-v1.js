"use strict";

/*
 * Generated, filesystem-free binding for the independently frozen quality
 * contract pair. This module is the artifact policy's only runtime contract
 * authority. It intentionally does not load pikiio-quality-contract-v3.
 */

const crypto = require("node:crypto");
const { types: { isProxy } } = require("node:util");

const BINDING_SCHEMA = "pikiio-quality-contract-binding-v1";
const CONTRACT_SOURCE_SHA256 =
  "1176f76d90a03cbd80a4416fc452667c49c9fd6338554f500fa76385818c5c83";
const CONTRACT_TEST_SHA256 =
  "385da8cc2a35f6d5d0a912d40b0c62ca024c5494d3bce5a2656133d4fa1e32f0";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (isProxy(value)) { // QUALITY_CONTRACT_BINDING_MUTATION_ANCHOR_STABLE_JSON_PROXY
    const error = new Error("canonical JSON proxy is refused");
    error.code = "PROXY_REFUSED";
    throw error;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
  );
}

function deepFreeze(value, seen = new Set()) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

const SCHEMAS = deepFreeze({
  artifactRef: "pikiio-cas-reference-v1",
  authorityIdentity: "pikiio-authority-identity-v1",
  qualityPolicy: "pikiio-quality-gauntlet-v4",
  qualityPlan: "pikiio-phase-quality-plan-v4",
  populationFloor: "pikiio-population-floor-v3",
  notApplicable: "pikiio-quality-layer-not-applicable-v1",
  layerPass: "pikiio-quality-layer-pass-receipt-v2",
  executionObservation: "pikiio-quality-execution-observation-v3",
  verifierOutput: "pikiio-quality-verifier-output-v2",
  coverageInputManifest: "pikiio-coverage-input-manifest-v1",
  coverageProof: "pikiio-per-file-coverage-proof-v2",
  operationalManifest: "pikiio-operational-manifest-v2",
  crashPopulation: "pikiio-crash-restart-population-v1",
  concurrencyPopulation:
    "pikiio-concurrency-linearizability-population-v1",
  parserPopulation: "pikiio-schema-parser-population-v1",
  frozenReview:
    "pikiio-independent-frozen-hash-review-receipt-v1",
  qualityReceipt: "pikiio-quality-gauntlet-receipt-v7",
  candidateReceipt: "pikiio-phase-candidate-quality-receipt-v3",
  attestationBody: "pikiio-phase-attestation-body-v3",
});

const EVIDENCE_LAYER_IDS = deepFreeze([
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
  "operational_integrity",
  "crash_restart",
  "concurrency_linearizability",
  "schema_parser_robustness",
  "independent_frozen_hash_review",
]);

const SPECIALIZED_ARTIFACT_PROVENANCE = deepFreeze({
  coverage: {
    kind: "layer_output",
    layerId: "coverage",
    outputIndex: 0,
    outputCardinality: 1,
  },
  mutation: {
    kind: "layer_output",
    layerId: "mutation",
    outputIndex: 0,
    outputCardinality: 1,
  },
  executionMatrix: {
    kind: "layer_output",
    layerId: "deterministic_repeat",
    outputIndex: 0,
    outputCardinality: 1,
  },
  operationalBeforeManifest: {
    kind: "layer_output",
    layerId: "operational_integrity",
    outputIndex: 0,
    outputCardinality: 3,
  },
  operationalAfterManifest: {
    kind: "layer_output",
    layerId: "operational_integrity",
    outputIndex: 1,
    outputCardinality: 3,
  },
  operationalAutomationInputs: {
    kind: "layer_output",
    layerId: "operational_integrity",
    outputIndex: 2,
    outputCardinality: 3,
  },
  crashRestart: {
    kind: "layer_output",
    layerId: "crash_restart",
    outputIndex: 0,
    outputCardinality: 1,
  },
  concurrencyLinearizability: {
    kind: "layer_output",
    layerId: "concurrency_linearizability",
    outputIndex: 0,
    outputCardinality: 1,
  },
  schemaParserRobustness: {
    kind: "layer_output",
    layerId: "schema_parser_robustness",
    outputIndex: 0,
    outputCardinality: 1,
  },
  independentFrozenHashReview: {
    kind: "layer_output",
    layerId: "independent_frozen_hash_review",
    outputIndex: 0,
    outputCardinality: 1,
  },
  antiWeakening: {
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  },
  primaryJudge: {
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  },
  independentJudge: {
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  },
  rawEvidenceManifest: {
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  },
});

const INDEX = deepFreeze({ kind: "index" });
const LAYER = deepFreeze({ kind: "layer_id" });

function site(siteId, root, path, cardinality) {
  return { siteId, root, path, cardinality };
}

/*
 * One entry per structurally distinct ArtifactRef site in the frozen contract.
 * INDEX and LAYER are closed typed coordinates, not wildcard role grants.
 */
const ARTIFACT_REF_SITE_MANIFEST = deepFreeze(
  [
    site(
      "quality_policy.approved_toolchains",
      "quality_policy",
      ["approvedToolchains", INDEX],
      "array",
    ),
    site(
      "quality_policy.phase_proof_registry",
      "quality_policy",
      ["phaseProofRegistry"],
      "single",
    ),
    site(
      "execution_observation.stdout",
      "execution_observation",
      ["stdoutArtifact"],
      "single",
    ),
    site(
      "execution_observation.stderr",
      "execution_observation",
      ["stderrArtifact"],
      "single",
    ),
    site(
      "execution_observation.parsed_output",
      "execution_observation",
      ["parsedOutputArtifact"],
      "single",
    ),
    site(
      "verifier_output.raw_result",
      "verifier_output",
      ["rawResultArtifact"],
      "single",
    ),
    site(
      "layer_pass.executions",
      "layer_pass",
      ["executions", INDEX],
      "nonempty_array",
    ),
    site(
      "layer_pass.raw_population",
      "layer_pass",
      ["rawPopulationArtifact"],
      "single",
    ),
    site(
      "layer_pass.output_artifacts",
      "layer_pass",
      ["outputArtifacts", INDEX],
      "array",
    ),
    site(
      "coverage_input_manifest.ordered_inputs",
      "coverage_input_manifest",
      ["orderedInputs", INDEX, "artifact"],
      "array",
    ),
    site(
      "coverage_proof.ordered_inputs",
      "coverage_proof",
      ["inputManifest", "orderedInputs", INDEX, "artifact"],
      "array",
    ),
    site(
      "coverage_proof.uncovered_ranges",
      "coverage_proof",
      ["files", INDEX, "uncoveredRangesArtifact"],
      "array",
    ),
    site(
      "operational_manifest.automation_inputs",
      "operational_manifest",
      ["automationInputsArtifact"],
      "single",
    ),
    site(
      "operational_manifest.dependency_manifest",
      "operational_manifest",
      ["dependencyManifestArtifact"],
      "single",
    ),
    site(
      "operational_manifest.toolchain_manifest",
      "operational_manifest",
      ["toolchainManifestArtifact"],
      "single",
    ),
    site(
      "crash_population.pre_state",
      "crash_population",
      ["cases", INDEX, "preStateArtifact"],
      "array",
    ),
    site(
      "crash_population.post_crash_state",
      "crash_population",
      ["cases", INDEX, "postCrashStateArtifact"],
      "array",
    ),
    site(
      "crash_population.recovery",
      "crash_population",
      ["cases", INDEX, "recoveryArtifact"],
      "array",
    ),
    site(
      "concurrency_population.schedule",
      "concurrency_population",
      ["cases", INDEX, "scheduleArtifact"],
      "array",
    ),
    site(
      "concurrency_population.operations",
      "concurrency_population",
      ["cases", INDEX, "operationsArtifact"],
      "array",
    ),
    site(
      "concurrency_population.accepted_ordering",
      "concurrency_population",
      ["cases", INDEX, "acceptedOrderingArtifact"],
      "array",
    ),
    site(
      "parser_population.input",
      "parser_population",
      ["cases", INDEX, "inputArtifact"],
      "array",
    ),
    site(
      "frozen_review.reviewed_manifest",
      "frozen_review",
      ["reviewedManifest"],
      "single",
    ),
    site(
      "frozen_review.post_review_manifest",
      "frozen_review",
      ["postReviewManifest"],
      "single",
    ),
    site(
      "frozen_review.finding_location",
      "frozen_review",
      ["findings", INDEX, "locationArtifact"],
      "array",
    ),
    site(
      "frozen_review.finding",
      "frozen_review",
      ["findings", INDEX, "findingArtifact"],
      "array",
    ),
    site(
      "frozen_review.closure_receipts",
      "frozen_review",
      ["closureReceipts", INDEX],
      "array",
    ),
    site(
      "frozen_review.certifier_runs",
      "frozen_review",
      ["certifierRuns", INDEX],
      "nonempty_array",
    ),
    site(
      "frozen_review.coordinator_rerun",
      "frozen_review",
      ["coordinatorRerun"],
      "single",
    ),
    site(
      "quality_receipt.layer_executions",
      "quality_receipt",
      ["layerResults", LAYER, "executions", INDEX],
      "per_applicable_layer_nonempty_array",
    ),
    site(
      "quality_receipt.layer_raw_population",
      "quality_receipt",
      ["layerResults", LAYER, "rawPopulationArtifact"],
      "per_applicable_layer",
    ),
    site(
      "quality_receipt.layer_output_artifacts",
      "quality_receipt",
      ["layerResults", LAYER, "outputArtifacts", INDEX],
      "per_applicable_layer_array",
    ),
    site(
      "quality_receipt.coverage",
      "quality_receipt",
      ["coverage"],
      "single",
    ),
    site(
      "quality_receipt.mutation",
      "quality_receipt",
      ["mutation"],
      "single",
    ),
    site(
      "quality_receipt.execution_matrix",
      "quality_receipt",
      ["executionMatrix", "artifact"],
      "single",
    ),
    site(
      "quality_receipt.operational_before",
      "quality_receipt",
      ["operationalIntegrity", "beforeManifest"],
      "single",
    ),
    site(
      "quality_receipt.operational_after",
      "quality_receipt",
      ["operationalIntegrity", "afterManifest"],
      "single",
    ),
    site(
      "quality_receipt.operational_automation",
      "quality_receipt",
      ["operationalIntegrity", "automationInputs"],
      "single",
    ),
    site(
      "quality_receipt.crash_restart",
      "quality_receipt",
      ["crashRestart"],
      "single",
    ),
    site(
      "quality_receipt.concurrency",
      "quality_receipt",
      ["concurrencyLinearizability"],
      "single",
    ),
    site(
      "quality_receipt.parser",
      "quality_receipt",
      ["schemaParserRobustness"],
      "single",
    ),
    site(
      "quality_receipt.independent_frozen_review",
      "quality_receipt",
      ["independentFrozenHashReview", "artifact"],
      "single",
    ),
    site(
      "quality_receipt.anti_weakening",
      "quality_receipt",
      ["antiWeakening"],
      "single",
    ),
    site(
      "quality_receipt.primary_judge",
      "quality_receipt",
      ["primaryJudge"],
      "single",
    ),
    site(
      "quality_receipt.independent_judge",
      "quality_receipt",
      ["independentJudge"],
      "single",
    ),
    site(
      "quality_receipt.raw_evidence_manifest",
      "quality_receipt",
      ["rawEvidenceManifest"],
      "single",
    ),
    site(
      "candidate_receipt.authority_snapshot",
      "candidate_receipt",
      ["authoritySnapshot"],
      "single",
    ),
    site(
      "candidate_receipt.changed_paths_manifest",
      "candidate_receipt",
      ["changedPathsManifest"],
      "single",
    ),
    site(
      "candidate_receipt.changed_path_coverage",
      "candidate_receipt",
      ["changedPathCoverage"],
      "single",
    ),
    site(
      "candidate_receipt.assertions",
      "candidate_receipt",
      ["assertions"],
      "single",
    ),
    site(
      "candidate_receipt.raw_artifact",
      "candidate_receipt",
      ["rawArtifact"],
      "single",
    ),
    ...[
      "sourceManifest",
      "qualityReceipt",
      "candidateReceipt",
      "frozenReviewReceipt",
      "evidenceManifest",
      "primaryRaw",
      "independentRaw",
      "rehearsalReceipt",
      "changeReceipt",
      "promotionReceipt",
    ].map((field) =>
      site(
        `attestation_body.${field}`,
        "attestation_body",
        ["artifacts", field],
        "single",
      ),
    ),
  ].sort((left, right) => compareCodeUnits(left.siteId, right.siteId)),
);

const ARTIFACT_REF_SITE_MANIFEST_SHA256 = sha256(
  stableJson(ARTIFACT_REF_SITE_MANIFEST),
);

const CONTRACT_BINDING_BODY = deepFreeze({
  schema: BINDING_SCHEMA,
  contractSourcePath: "lib/pikiio-quality-contract-v3.js",
  contractSourceSha256: CONTRACT_SOURCE_SHA256,
  contractTestPath: "tests/pikiio-quality-contract-v3.test.js",
  contractTestSha256: CONTRACT_TEST_SHA256,
  schemas: clone(SCHEMAS),
  evidenceLayerIds: clone(EVIDENCE_LAYER_IDS),
  specializedArtifactProvenance: clone(SPECIALIZED_ARTIFACT_PROVENANCE),
  artifactRefSiteManifestSha256: ARTIFACT_REF_SITE_MANIFEST_SHA256,
  artifactRefSites: clone(ARTIFACT_REF_SITE_MANIFEST),
});

const CONTRACT_BINDING_SHA256 = sha256(stableJson(CONTRACT_BINDING_BODY));
const CONTRACT_BINDING = deepFreeze({
  ...clone(CONTRACT_BINDING_BODY),
  bindingSha256: CONTRACT_BINDING_SHA256,
});

function validateArtifactRef(value) {
  if (isProxy(value)) { // QUALITY_CONTRACT_BINDING_MUTATION_ANCHOR_PROXY
    const error = new Error("artifact reference proxy is refused");
    error.code = "PROXY_REFUSED";
    throw error;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    const error = new Error("artifact reference must be an exact plain object");
    error.code = "EXACT_OBJECT_REQUIRED";
    throw error;
  }
  const expected = ["address", "byteLength", "mediaType", "schema", "sha256"];
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    const error = new Error("artifact reference contains symbol properties");
    error.code = "SYMBOL_PROPERTY_REFUSED";
    throw error;
  }
  const actual = Object.getOwnPropertyNames(value).sort(compareCodeUnits);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    const error = new Error("artifact reference has missing or extra fields");
    error.code = "EXACT_KEYS_REQUIRED";
    throw error;
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.enumerable !== true
    ) { // QUALITY_CONTRACT_BINDING_MUTATION_ANCHOR_DATA_DESCRIPTOR
      const error = new Error(
        "artifact reference fields must be enumerable own data properties",
      );
      error.code = "ACCESSOR_PROPERTY_REFUSED";
      throw error;
    }
  }
  if (value.schema !== SCHEMAS.artifactRef) {
    const error = new Error("artifact reference schema is invalid");
    error.code = "SCHEMA_INVALID";
    throw error;
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    const error = new Error("artifact reference sha256 is invalid");
    error.code = "INVALID_SHA256";
    throw error;
  }
  if (value.address !== `sha256:${value.sha256}`) {
    const error = new Error("artifact reference address is invalid");
    error.code = "ARTIFACT_ADDRESS_MISMATCH";
    throw error;
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) {
    const error = new Error("artifact reference byteLength is invalid");
    error.code = "INVALID_COUNTER";
    throw error;
  }
  if (
    typeof value.mediaType !== "string" ||
    !/^[a-z0-9][a-z0-9.+-]+\/[a-z0-9][a-z0-9.+-]+$/.test(value.mediaType)
  ) {
    const error = new Error("artifact reference mediaType is invalid");
    error.code = "INVALID_STRING";
    throw error;
  }
  return deepFreeze(clone(value));
}

module.exports = deepFreeze({
  ARTIFACT_REF_SITE_MANIFEST,
  ARTIFACT_REF_SITE_MANIFEST_SHA256,
  BINDING_SCHEMA,
  CONTRACT_BINDING,
  CONTRACT_BINDING_SHA256,
  CONTRACT_SOURCE_SHA256,
  CONTRACT_TEST_SHA256,
  EVIDENCE_LAYER_IDS,
  SCHEMAS,
  SPECIALIZED_ARTIFACT_PROVENANCE,
  validateArtifactRef,
});

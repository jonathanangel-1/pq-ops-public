"use strict";

/*
 * Dormant, filesystem-free policy for interpreting CAS references emitted by
 * the independently frozen quality-contract-v3 evidence graph. This module
 * names bytes; it neither reads, writes, certifies, nor authorizes those bytes.
 *
 * The policy deliberately imports only the generated frozen binding. It never
 * loads an ambient/latest quality-contract implementation at runtime.
 */

const crypto = require("node:crypto");
const { types: { isProxy } } = require("node:util");
const quality = require("./pikiio-quality-contract-binding-v1");

const POLICY_SCHEMA = "pikiio-quality-artifact-policy-v2";
const ROLE_SCHEMA = "pikiio-quality-artifact-role-v2";
const ENUMERATION_SCHEMA = "pikiio-quality-artifact-enumeration-v2";
const CLAIM_SCHEMA = "pikiio-quality-artifact-claim-v2";
const EXECUTION_INSTANCE_SCHEMA =
  "pikiio-quality-execution-claim-instance-v1";
const EXPECTED_CONTRACT_BINDING_SHA256 =
  "8c459c26275d099387c672cf2bd535041634a56063cfa34a844da3efa54e379d";
const EXPECTED_CONTRACT_SOURCE_SHA256 =
  "1176f76d90a03cbd80a4416fc452667c49c9fd6338554f500fa76385818c5c83";
const EXPECTED_CONTRACT_TEST_SHA256 =
  "385da8cc2a35f6d5d0a912d40b0c62ca024c5494d3bce5a2656133d4fa1e32f0";
const MAX_POLICY_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_DEPTH = 64;
const MAX_GRAPH_NODES = 50_000;
const MAX_ARRAY_ENTRIES = 10_000;
const BYTE_STREAM_DECODED_MAX_BYTES = 1024 * 1024;
const BYTE_STREAM_BASE64_MAX_CHARS =
  4 * Math.ceil(BYTE_STREAM_DECODED_MAX_BYTES / 3);
const BYTE_STREAM_ENVELOPE_OVERHEAD_BYTES = 256;
const BYTE_STREAM_ENVELOPE_MAX_BYTES =
  BYTE_STREAM_BASE64_MAX_CHARS + BYTE_STREAM_ENVELOPE_OVERHEAD_BYTES;
const INDEX_SEGMENT = Object.freeze({ kind: "index" });
const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
if (
  quality.CONTRACT_BINDING_SHA256 !== EXPECTED_CONTRACT_BINDING_SHA256 ||
  quality.CONTRACT_SOURCE_SHA256 !== EXPECTED_CONTRACT_SOURCE_SHA256 ||
  quality.CONTRACT_TEST_SHA256 !== EXPECTED_CONTRACT_TEST_SHA256 ||
  quality.CONTRACT_BINDING.bindingSha256 !==
    EXPECTED_CONTRACT_BINDING_SHA256
) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_FROZEN_BINDING
  const error = new Error(
    "artifact policy loaded against an unrecognized quality-contract binding",
  );
  error.code = "QUALITY_CONTRACT_BINDING_DRIFT";
  throw error;
}
if (
  BYTE_STREAM_ENVELOPE_MAX_BYTES <
    BYTE_STREAM_BASE64_MAX_CHARS + BYTE_STREAM_ENVELOPE_OVERHEAD_BYTES ||
  BYTE_STREAM_ENVELOPE_MAX_BYTES > MAX_POLICY_ARTIFACT_BYTES
) {
  throw new Error("byte stream envelope bounds are internally inconsistent");
}

const ENCODINGS = Object.freeze({
  CANONICAL_JSON: "canonical_json",
  CANONICAL_HASH_BODY: "canonical_hash_body",
  OPAQUE_BYTES: "opaque_bytes",
});

const EXPECTED_LAYER_IDS = Object.freeze([
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

const VERIFIER_LAYER_IDS = Object.freeze([
  "focused_verifier",
  "neighbor_verifier",
  "broad_verifier",
  "production_shaped_rehearsal",
]);

const ROOT_SCHEMAS = Object.freeze({
  quality_policy: quality.SCHEMAS.qualityPolicy,
  quality_plan: quality.SCHEMAS.qualityPlan,
  population_floor: quality.SCHEMAS.populationFloor,
  execution_observation: quality.SCHEMAS.executionObservation,
  verifier_output: quality.SCHEMAS.verifierOutput,
  layer_pass: quality.SCHEMAS.layerPass,
  coverage_input_manifest: quality.SCHEMAS.coverageInputManifest,
  coverage_proof: quality.SCHEMAS.coverageProof,
  operational_manifest: quality.SCHEMAS.operationalManifest,
  crash_population: quality.SCHEMAS.crashPopulation,
  concurrency_population: quality.SCHEMAS.concurrencyPopulation,
  parser_population: quality.SCHEMAS.parserPopulation,
  frozen_review: quality.SCHEMAS.frozenReview,
  quality_receipt: quality.SCHEMAS.qualityReceipt,
  candidate_receipt: quality.SCHEMAS.candidateReceipt,
  attestation_body: quality.SCHEMAS.attestationBody,
  source_manifest: "pikiio-source-manifest-v1",
  evidence_manifest: "pikiio-quality-artifact-manifest-v1",
  primary_judge_raw: "pikiio-quality-judge-raw-artifact-v2",
  independent_judge_raw: "pikiio-quality-judge-raw-artifact-v2",
  frozen_source_manifest: "pikiio-frozen-source-manifest-v1",
  rehearsal_receipt: "pikiio-production-rehearsal-receipt-v1",
  change_receipt: "pikiio-change-receipt-v1",
  promotion_receipt: "pikiio-promotion-receipt-v1",
});

class QualityArtifactPolicyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "QualityArtifactPolicyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new QualityArtifactPolicyError(code, message, details);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
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

function safeClone(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      copy.push(safeClone(value[index], seen));
    }
  } else {
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: safeClone(value[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return copy;
}

function assertSafeGraph(root, label) {
  const active = new Set();
  let nodes = 0;

  function visit(value, depth, path) {
    nodes += 1;
    if (nodes > MAX_GRAPH_NODES) {
      fail("GRAPH_NODE_LIMIT", `${label} exceeds the graph node limit`);
    }
    if (depth > MAX_GRAPH_DEPTH) {
      fail("GRAPH_DEPTH_LIMIT", `${label} exceeds the graph depth limit`);
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    ) {
      if (typeof value === "string" && value.length > MAX_POLICY_ARTIFACT_BYTES) {
        fail("STRING_LENGTH_LIMIT", `${path} exceeds the string length limit`);
      }
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
        fail("UNSAFE_NUMBER", `${path} must be a finite safe integer`);
      }
      return;
    }
    if (isProxy(value)) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_PROXY
      fail("PROXY_REFUSED", `${path} contains a Proxy`);
    }
    if (typeof value !== "object") {
      fail("UNSAFE_VALUE", `${path} contains an unsupported value`);
    }
    if (active.has(value)) fail("CYCLIC_GRAPH", `${path} contains a cycle`);
    active.add(value);
    try {
      const symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length !== 0) {
        fail("SYMBOL_PROPERTY_REFUSED", `${path} contains symbol properties`);
      }
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          fail("UNSAFE_PROTOTYPE", `${path} has an unsafe array prototype`);
        }
        if (value.length > MAX_ARRAY_ENTRIES) {
          fail("ARRAY_LENGTH_LIMIT", `${path} exceeds the array length limit`);
        }
        const ownNames = Object.getOwnPropertyNames(value);
        const expectedNames = [
          ...Array.from({ length: value.length }, (_, index) => String(index)),
          "length",
        ];
        if (
          ownNames.length !== expectedNames.length ||
          ownNames.some((name, index) => name !== expectedNames[index])
        ) {
          fail("UNSAFE_ARRAY_SHAPE", `${path} must be dense with no extra keys`);
        }
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            !descriptor ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            descriptor.enumerable !== true
          ) {
            fail("ACCESSOR_PROPERTY_REFUSED", `${path}[${index}] is not data`);
          }
          visit(descriptor.value, depth + 1, `${path}[${index}]`);
        }
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_SAFE_PROTOTYPE
        fail("UNSAFE_PROTOTYPE", `${path} must be a plain object`);
      }
      for (const key of Object.getOwnPropertyNames(value)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
          fail("UNSAFE_PROPERTY_NAME", `${path}.${key} is forbidden`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !descriptor ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true
        ) {
          fail("ACCESSOR_PROPERTY_REFUSED", `${path}.${key} is not enumerable data`);
        }
        visit(descriptor.value, depth + 1, `${path}.${key}`);
      }
    } finally {
      active.delete(value);
    }
  }

  visit(root, 0, label);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("EXACT_OBJECT_REQUIRED", `${label} must be an exact plain object`);
  }
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail("EXACT_KEYS_REQUIRED", `${label} has missing or extra fields`, {
      actual,
      expected: wanted,
    });
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail("ARRAY_REQUIRED", `${label} must be an array`);
  return value;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("OBJECT_REQUIRED", `${label} must be an object`);
  }
  return value;
}

function jsonPolicy(
  payloadSchema,
  validatorId,
  {
    maxBytes = 2 * 1024 * 1024,
    selfHashField = null,
    encoding = ENCODINGS.CANONICAL_JSON,
  } = {},
) {
  return {
    mediaType: "application/json",
    payloadSchema,
    encoding,
    maximumBytes: maxBytes,
    validatorId,
    selfHashField,
  };
}

function opaquePolicy(
  mediaType,
  validatorId,
  {
    payloadSchema = null,
    maxBytes = 1024 * 1024,
  } = {},
) {
  return {
    mediaType,
    payloadSchema,
    encoding: ENCODINGS.OPAQUE_BYTES,
    maximumBytes: maxBytes,
    validatorId,
    selfHashField: null,
  };
}

function template(root, path, policy) {
  return {
    root,
    path,
    emission:
      path.length === 1 && path[0] === "body"
        ? "lookup_only"
        : "reference_site",
    ...policy,
  };
}

function isIndexSegment(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    value.kind === "index"
  );
}

function layerPayloadSchema(layerId, suffix) {
  return `pikiio-quality-${layerId.replaceAll("_", "-")}-${suffix}-v1`;
}

function specializedArtifactPolicy(role) {
  switch (role) {
    case "coverage":
      return jsonPolicy(
        quality.SCHEMAS.coverageProof,
        "per_file_coverage_proof_v2",
        { maxBytes: 32 * 1024 * 1024 },
      );
    case "mutation":
      return jsonPolicy("pikiio-mutation-report-v1", "mutation_report_v1", {
        maxBytes: 32 * 1024 * 1024,
      });
    case "executionMatrix":
      return jsonPolicy(
        "pikiio-quality-execution-matrix-report-v1",
        "quality_execution_matrix_report_v1",
        { maxBytes: 32 * 1024 * 1024 },
      );
    case "operationalBeforeManifest":
    case "operationalAfterManifest":
      return jsonPolicy(
        quality.SCHEMAS.operationalManifest,
        "operational_manifest_v2",
      );
    case "operationalAutomationInputs":
      return jsonPolicy(
        "pikiio-automation-input-manifest-v1",
        "automation_input_manifest_v1",
      );
    case "crashRestart":
      return jsonPolicy(
        quality.SCHEMAS.crashPopulation,
        "crash_restart_population_v1",
        { maxBytes: 32 * 1024 * 1024 },
      );
    case "concurrencyLinearizability":
      return jsonPolicy(
        quality.SCHEMAS.concurrencyPopulation,
        "concurrency_linearizability_population_v1",
        { maxBytes: 32 * 1024 * 1024 },
      );
    case "schemaParserRobustness":
      return jsonPolicy(
        quality.SCHEMAS.parserPopulation,
        "schema_parser_population_v1",
        { maxBytes: 32 * 1024 * 1024 },
      );
    case "independentFrozenHashReview":
      return jsonPolicy(
        quality.SCHEMAS.frozenReview,
        "independent_frozen_hash_review_receipt_v1",
        {
          encoding: ENCODINGS.CANONICAL_HASH_BODY,
          selfHashField: "receiptHash",
          maxBytes: 16 * 1024 * 1024,
        },
      );
    case "antiWeakening":
      return jsonPolicy(
        "pikiio-quality-anti-weakening-report-v1",
        "quality_anti_weakening_report_v1",
        { maxBytes: 32 * 1024 * 1024 },
      );
    case "primaryJudge":
      return jsonPolicy(
        "pikiio-quality-judge-raw-artifact-v2",
        "quality_primary_judge_raw_v2",
        { maxBytes: MAX_POLICY_ARTIFACT_BYTES },
      );
    case "independentJudge":
      return jsonPolicy(
        "pikiio-quality-judge-raw-artifact-v2",
        "quality_independent_judge_raw_v2",
        { maxBytes: MAX_POLICY_ARTIFACT_BYTES },
      );
    case "rawEvidenceManifest":
      return jsonPolicy(
        "pikiio-quality-artifact-manifest-v1",
        "quality_artifact_manifest_v1",
        { maxBytes: 32 * 1024 * 1024 },
      );
    default:
      fail(
        "SPECIALIZED_ARTIFACT_ROLE_UNKNOWN",
        `specialized artifact role ${role} is unknown`,
      );
  }
}

const SPECIALIZED_TOP_LEVEL_PATHS = deepFreeze({
  coverage: ["coverage"],
  mutation: ["mutation"],
  executionMatrix: ["executionMatrix", "artifact"],
  operationalBeforeManifest: ["operationalIntegrity", "beforeManifest"],
  operationalAfterManifest: ["operationalIntegrity", "afterManifest"],
  operationalAutomationInputs: ["operationalIntegrity", "automationInputs"],
  crashRestart: ["crashRestart"],
  concurrencyLinearizability: ["concurrencyLinearizability"],
  schemaParserRobustness: ["schemaParserRobustness"],
  independentFrozenHashReview: ["independentFrozenHashReview", "artifact"],
  antiWeakening: ["antiWeakening"],
  primaryJudge: ["primaryJudge"],
  independentJudge: ["independentJudge"],
  rawEvidenceManifest: ["rawEvidenceManifest"],
});

const SPECIALIZED_OUTPUTS_BY_LAYER = deepFreeze(
  Object.fromEntries(
    Object.entries(quality.SPECIALIZED_ARTIFACT_PROVENANCE)
      .filter(([, provenance]) => provenance.kind === "layer_output")
      .reduce((entries, [role, provenance]) => {
        const current = entries.get(provenance.layerId) || [];
        current.push({
          role,
          outputIndex: provenance.outputIndex,
          outputCardinality: provenance.outputCardinality,
        });
        entries.set(provenance.layerId, current);
        return entries;
      }, new Map()),
  ),
);

function buildRoleTemplates() {
  const entries = [
    template(
      "quality_policy",
      ["body"],
      jsonPolicy(quality.SCHEMAS.qualityPolicy, "quality_policy_v4", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "policySha256",
      }),
    ),
    template(
      "quality_plan",
      ["body"],
      jsonPolicy(quality.SCHEMAS.qualityPlan, "quality_plan_v4", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "planSha256",
      }),
    ),
    template(
      "population_floor",
      ["body"],
      jsonPolicy(quality.SCHEMAS.populationFloor, "population_floor_v3", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "floorHash",
      }),
    ),
    template(
      "execution_observation",
      ["body"],
      jsonPolicy(
        quality.SCHEMAS.executionObservation,
        "quality_execution_observation_v3",
        { maxBytes: 16 * 1024 * 1024 },
      ),
    ),
    template(
      "verifier_output",
      ["body"],
      jsonPolicy(quality.SCHEMAS.verifierOutput, "quality_verifier_output_v2", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "layer_pass",
      ["body"],
      jsonPolicy(quality.SCHEMAS.layerPass, "quality_layer_pass_receipt_v2", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "coverage_input_manifest",
      ["body"],
      jsonPolicy(
        quality.SCHEMAS.coverageInputManifest,
        "coverage_input_manifest_v1",
        {
          encoding: ENCODINGS.CANONICAL_HASH_BODY,
          selfHashField: "manifestHash",
          maxBytes: 16 * 1024 * 1024,
        },
      ),
    ),
    template(
      "coverage_proof",
      ["body"],
      jsonPolicy(quality.SCHEMAS.coverageProof, "per_file_coverage_proof_v2", {
        maxBytes: 32 * 1024 * 1024,
      }),
    ),
    template(
      "operational_manifest",
      ["body"],
      jsonPolicy(quality.SCHEMAS.operationalManifest, "operational_manifest_v2", {
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "operational_manifest_identity",
      }),
    ),
    template(
      "crash_population",
      ["body"],
      jsonPolicy(quality.SCHEMAS.crashPopulation, "crash_restart_population_v1", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "populationHash",
        maxBytes: 32 * 1024 * 1024,
      }),
    ),
    template(
      "concurrency_population",
      ["body"],
      jsonPolicy(
        quality.SCHEMAS.concurrencyPopulation,
        "concurrency_linearizability_population_v1",
        {
          encoding: ENCODINGS.CANONICAL_HASH_BODY,
          selfHashField: "populationHash",
          maxBytes: 32 * 1024 * 1024,
        },
      ),
    ),
    template(
      "parser_population",
      ["body"],
      jsonPolicy(quality.SCHEMAS.parserPopulation, "schema_parser_population_v1", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "populationHash",
        maxBytes: 32 * 1024 * 1024,
      }),
    ),
    template(
      "frozen_review",
      ["body"],
      jsonPolicy(
        quality.SCHEMAS.frozenReview,
        "independent_frozen_hash_review_receipt_v1",
        {
          encoding: ENCODINGS.CANONICAL_HASH_BODY,
          selfHashField: "receiptHash",
          maxBytes: 16 * 1024 * 1024,
          aliasClass: "frozen_review_receipt_body_identity",
        },
      ),
    ),
    template(
      "quality_receipt",
      ["body"],
      jsonPolicy(quality.SCHEMAS.qualityReceipt, "quality_gauntlet_receipt_v7", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 32 * 1024 * 1024,
        aliasClass: "quality_receipt_body_identity",
      }),
    ),
    template(
      "candidate_receipt",
      ["body"],
      jsonPolicy(
        quality.SCHEMAS.candidateReceipt,
        "phase_candidate_quality_receipt_v3",
        {
          encoding: ENCODINGS.CANONICAL_HASH_BODY,
          selfHashField: "receiptHash",
          maxBytes: 16 * 1024 * 1024,
          aliasClass: "candidate_receipt_body_identity",
        },
      ),
    ),
    template(
      "attestation_body",
      ["body"],
      jsonPolicy(quality.SCHEMAS.attestationBody, "phase_attestation_body_v3", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "bodySha256",
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "source_manifest",
      ["body"],
      jsonPolicy("pikiio-source-manifest-v1", "source_manifest_v1", {
        aliasClass: "source_manifest_body_identity",
      }),
    ),
    template(
      "evidence_manifest",
      ["body"],
      jsonPolicy(
        "pikiio-quality-artifact-manifest-v1",
        "quality_artifact_manifest_v1",
        {
          maxBytes: 32 * 1024 * 1024,
          aliasClass: "evidence_manifest_body_identity",
        },
      ),
    ),
    template(
      "primary_judge_raw",
      ["body"],
      jsonPolicy(
        "pikiio-quality-judge-raw-artifact-v2",
        "quality_primary_judge_raw_v2",
        {
          maxBytes: MAX_POLICY_ARTIFACT_BYTES,
          aliasClass: "primary_judge_body_identity",
        },
      ),
    ),
    template(
      "independent_judge_raw",
      ["body"],
      jsonPolicy(
        "pikiio-quality-judge-raw-artifact-v2",
        "quality_independent_judge_raw_v2",
        {
          maxBytes: MAX_POLICY_ARTIFACT_BYTES,
          aliasClass: "independent_judge_body_identity",
        },
      ),
    ),
    template(
      "frozen_source_manifest",
      ["body"],
      jsonPolicy("pikiio-frozen-source-manifest-v1", "frozen_source_manifest_v1", {
        aliasClass: "frozen_manifest_identity",
      }),
    ),
    template(
      "rehearsal_receipt",
      ["body"],
      jsonPolicy(
        "pikiio-production-rehearsal-receipt-v1",
        "production_rehearsal_receipt_v1",
        {
          encoding: ENCODINGS.CANONICAL_HASH_BODY,
          selfHashField: "receiptHash",
          maxBytes: 16 * 1024 * 1024,
          aliasClass: "rehearsal_receipt_body_identity",
        },
      ),
    ),
    template(
      "change_receipt",
      ["body"],
      jsonPolicy("pikiio-change-receipt-v1", "change_receipt_v1", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "change_receipt_body_identity",
      }),
    ),
    template(
      "promotion_receipt",
      ["body"],
      jsonPolicy("pikiio-promotion-receipt-v1", "promotion_receipt_v1", {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "promotion_receipt_body_identity",
      }),
    ),
    template(
      "quality_policy",
      ["approvedToolchains", INDEX_SEGMENT],
      jsonPolicy("pikiio-approved-toolchain-v1", "approved_toolchain_v1"),
    ),
    template(
      "quality_policy",
      ["phaseProofRegistry"],
      jsonPolicy("pikiio-phase-proof-registry-v1", "phase_proof_registry_v1"),
    ),
    template(
      "coverage_input_manifest",
      ["orderedInputs", INDEX_SEGMENT, "artifact"],
      jsonPolicy("pikiio-coverage-input-artifact-v1", "coverage_input_artifact_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "coverage_proof",
      ["inputManifest", "orderedInputs", INDEX_SEGMENT, "artifact"],
      jsonPolicy("pikiio-coverage-input-artifact-v1", "coverage_input_artifact_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "coverage_proof",
      ["files", INDEX_SEGMENT, "uncoveredRangesArtifact"],
      jsonPolicy("pikiio-uncovered-ranges-v1", "uncovered_ranges_v1"),
    ),
    template(
      "operational_manifest",
      ["automationInputsArtifact"],
      jsonPolicy("pikiio-automation-input-manifest-v1", "automation_input_manifest_v1"),
    ),
    template(
      "operational_manifest",
      ["dependencyManifestArtifact"],
      jsonPolicy("pikiio-dependency-manifest-v1", "dependency_manifest_v1"),
    ),
    template(
      "operational_manifest",
      ["toolchainManifestArtifact"],
      jsonPolicy("pikiio-toolchain-manifest-v1", "toolchain_manifest_v1"),
    ),
    template(
      "crash_population",
      ["cases", INDEX_SEGMENT, "preStateArtifact"],
      jsonPolicy("pikiio-crash-pre-state-v1", "crash_pre_state_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "crash_population",
      ["cases", INDEX_SEGMENT, "postCrashStateArtifact"],
      jsonPolicy("pikiio-crash-post-state-v1", "crash_post_state_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "crash_population",
      ["cases", INDEX_SEGMENT, "recoveryArtifact"],
      jsonPolicy("pikiio-crash-recovery-state-v1", "crash_recovery_state_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "concurrency_population",
      ["cases", INDEX_SEGMENT, "scheduleArtifact"],
      jsonPolicy("pikiio-concurrency-schedule-v1", "concurrency_schedule_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "concurrency_population",
      ["cases", INDEX_SEGMENT, "operationsArtifact"],
      jsonPolicy("pikiio-concurrency-operations-v1", "concurrency_operations_v1", {
        maxBytes: 16 * 1024 * 1024,
      }),
    ),
    template(
      "concurrency_population",
      ["cases", INDEX_SEGMENT, "acceptedOrderingArtifact"],
      jsonPolicy(
        "pikiio-concurrency-accepted-ordering-v1",
        "concurrency_accepted_ordering_v1",
        { maxBytes: 16 * 1024 * 1024 },
      ),
    ),
    template(
      "parser_population",
      ["cases", INDEX_SEGMENT, "inputArtifact"],
      opaquePolicy(
        "application/octet-stream",
        "schema_parser_hostile_input_bytes_v1",
        {
          payloadSchema: "pikiio-schema-parser-hostile-input-v1",
          maxBytes: 16 * 1024 * 1024,
        },
      ),
    ),
    template(
      "frozen_review",
      ["reviewedManifest"],
      jsonPolicy("pikiio-frozen-source-manifest-v1", "frozen_source_manifest_v1", {
        aliasClass: "frozen_manifest_identity",
      }),
    ),
    template(
      "frozen_review",
      ["postReviewManifest"],
      jsonPolicy("pikiio-frozen-source-manifest-v1", "frozen_source_manifest_v1", {
        aliasClass: "frozen_manifest_identity",
      }),
    ),
    template(
      "frozen_review",
      ["findings", INDEX_SEGMENT, "locationArtifact"],
      jsonPolicy("pikiio-review-finding-location-v1", "review_finding_location_v1"),
    ),
    template(
      "frozen_review",
      ["findings", INDEX_SEGMENT, "findingArtifact"],
      jsonPolicy("pikiio-review-finding-v1", "review_finding_v1"),
    ),
    template(
      "frozen_review",
      ["closureReceipts", INDEX_SEGMENT],
      jsonPolicy("pikiio-review-closure-receipt-v1", "review_closure_receipt_v1"),
    ),
    template(
      "frozen_review",
      ["certifierRuns", INDEX_SEGMENT],
      jsonPolicy("pikiio-quality-certifier-run-v1", "quality_certifier_run_v1"),
    ),
    template(
      "frozen_review",
      ["coordinatorRerun"],
      jsonPolicy("pikiio-quality-coordinator-rerun-v1", "quality_coordinator_rerun_v1"),
    ),
  ];

  for (const layerId of EXPECTED_LAYER_IDS) {
    entries.push(
      template(
        "execution_observation",
        ["layers", layerId, "stdoutArtifact"],
        jsonPolicy("pikiio-byte-stream-envelope-v1", "byte_stream_envelope_v1", {
          maxBytes: BYTE_STREAM_ENVELOPE_MAX_BYTES,
        }),
      ),
      template(
        "execution_observation",
        ["layers", layerId, "stderrArtifact"],
        jsonPolicy("pikiio-byte-stream-envelope-v1", "byte_stream_envelope_v1", {
          maxBytes: BYTE_STREAM_ENVELOPE_MAX_BYTES,
        }),
      ),
      template(
        "execution_observation",
        ["layers", layerId, "parsedOutputArtifact"],
        jsonPolicy(
          layerPayloadSchema(layerId, "producer-parsed-output"),
          `producer_parsed_output_${layerId}_v1`,
          { maxBytes: 16 * 1024 * 1024 },
        ),
      ),
      template(
        "layer_pass",
        ["layers", layerId, "executions", INDEX_SEGMENT],
        jsonPolicy(
          quality.SCHEMAS.executionObservation,
          "quality_execution_observation_v3",
          { maxBytes: 16 * 1024 * 1024 },
        ),
      ),
      template(
        "layer_pass",
        ["layers", layerId, "rawPopulationArtifact"],
        jsonPolicy(
          layerPayloadSchema(layerId, "raw-population"),
          `raw_population_${layerId}_v1`,
          { maxBytes: 32 * 1024 * 1024 },
        ),
      ),
      template(
        "layer_pass",
        ["layers", layerId, "outputArtifacts", INDEX_SEGMENT],
        jsonPolicy(
          layerPayloadSchema(layerId, "output"),
          `layer_output_${layerId}_v1`,
          { maxBytes: 32 * 1024 * 1024 },
        ),
      ),
      template(
        "quality_receipt",
        ["layerResults", layerId, "executions", INDEX_SEGMENT],
        jsonPolicy(
          quality.SCHEMAS.executionObservation,
          "quality_execution_observation_v3",
          { maxBytes: 16 * 1024 * 1024 },
        ),
      ),
      template(
        "quality_receipt",
        ["layerResults", layerId, "rawPopulationArtifact"],
        jsonPolicy(
          layerPayloadSchema(layerId, "raw-population"),
          `raw_population_${layerId}_v1`,
          { maxBytes: 32 * 1024 * 1024 },
        ),
      ),
      template(
        "quality_receipt",
        ["layerResults", layerId, "outputArtifacts", INDEX_SEGMENT],
        jsonPolicy(
          layerPayloadSchema(layerId, "output"),
          `layer_output_${layerId}_v1`,
          { maxBytes: 32 * 1024 * 1024 },
        ),
      ),
    );
  }

  for (const layerId of VERIFIER_LAYER_IDS) {
    entries.push(
      template(
        "verifier_output",
        ["layers", layerId, "rawResultArtifact"],
        jsonPolicy(
          layerPayloadSchema(layerId, "verifier-raw-result"),
          `verifier_raw_result_${layerId}_v1`,
          { maxBytes: 32 * 1024 * 1024 },
        ),
      ),
    );
  }

  for (const [role, path] of Object.entries(SPECIALIZED_TOP_LEVEL_PATHS)) {
    entries.push(
      template(
        "quality_receipt",
        path,
        specializedArtifactPolicy(role),
      ),
    );
  }

  const candidateRoles = {
    authoritySnapshot: jsonPolicy(
      "pikiio-candidate-authority-snapshot-v1",
      "candidate_authority_snapshot_v1",
    ),
    changedPathsManifest: jsonPolicy(
      "pikiio-candidate-changed-paths-manifest-v1",
      "candidate_changed_paths_manifest_v1",
    ),
    changedPathCoverage: jsonPolicy(
      "pikiio-candidate-changed-path-coverage-v1",
      "candidate_changed_path_coverage_v1",
    ),
    assertions: jsonPolicy(
      "pikiio-candidate-assertions-v1",
      "candidate_assertions_v1",
    ),
    rawArtifact: jsonPolicy(
      "pikiio-candidate-raw-artifact-v1",
      "candidate_raw_artifact_v1",
      { maxBytes: MAX_POLICY_ARTIFACT_BYTES },
    ),
  };
  for (const [field, policy] of Object.entries(candidateRoles)) {
    entries.push(template("candidate_receipt", [field], policy));
  }

  const attestationRoles = {
    sourceManifest: jsonPolicy(
      "pikiio-source-manifest-v1",
      "source_manifest_v1",
      { aliasClass: "source_manifest_body_identity" },
    ),
    qualityReceipt: jsonPolicy(
      quality.SCHEMAS.qualityReceipt,
      "quality_gauntlet_receipt_v7",
      {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 32 * 1024 * 1024,
        aliasClass: "quality_receipt_body_identity",
      },
    ),
    candidateReceipt: jsonPolicy(
      quality.SCHEMAS.candidateReceipt,
      "phase_candidate_quality_receipt_v3",
      {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "candidate_receipt_body_identity",
      },
    ),
    frozenReviewReceipt: jsonPolicy(
      quality.SCHEMAS.frozenReview,
      "independent_frozen_hash_review_receipt_v1",
      {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "frozen_review_receipt_body_identity",
      },
    ),
    evidenceManifest: jsonPolicy(
      "pikiio-quality-artifact-manifest-v1",
      "quality_artifact_manifest_v1",
      {
        maxBytes: 32 * 1024 * 1024,
        aliasClass: "evidence_manifest_body_identity",
      },
    ),
    primaryRaw: jsonPolicy(
      "pikiio-quality-judge-raw-artifact-v2",
      "quality_primary_judge_raw_v2",
      {
        maxBytes: MAX_POLICY_ARTIFACT_BYTES,
        aliasClass: "primary_judge_body_identity",
      },
    ),
    independentRaw: jsonPolicy(
      "pikiio-quality-judge-raw-artifact-v2",
      "quality_independent_judge_raw_v2",
      {
        maxBytes: MAX_POLICY_ARTIFACT_BYTES,
        aliasClass: "independent_judge_body_identity",
      },
    ),
    rehearsalReceipt: jsonPolicy(
      "pikiio-production-rehearsal-receipt-v1",
      "production_rehearsal_receipt_v1",
      {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "rehearsal_receipt_body_identity",
      },
    ),
    changeReceipt: jsonPolicy(
      "pikiio-change-receipt-v1",
      "change_receipt_v1",
      {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "change_receipt_body_identity",
      },
    ),
    promotionReceipt: jsonPolicy(
      "pikiio-promotion-receipt-v1",
      "promotion_receipt_v1",
      {
        encoding: ENCODINGS.CANONICAL_HASH_BODY,
        selfHashField: "receiptHash",
        maxBytes: 16 * 1024 * 1024,
        aliasClass: "promotion_receipt_body_identity",
      },
    ),
  };
  for (const [field, policy] of Object.entries(attestationRoles)) {
    entries.push(template("attestation_body", ["artifacts", field], policy));
  }

  const rootsWithLayerOutputs = new Set(["layer_pass", "quality_receipt"]);
  const genericOutputRemoved = entries.filter((entry) => {
    if (!rootsWithLayerOutputs.has(entry.root)) return true;
    const layerOffset = entry.root === "layer_pass" ? 1 : 1;
    const layerId =
      entry.root === "layer_pass" ? entry.path[1] : entry.path[1];
    return !(
      entry.path[layerOffset + 1] === "outputArtifacts" &&
      isIndexSegment(entry.path[layerOffset + 2]) &&
      Object.prototype.hasOwnProperty.call(
        SPECIALIZED_OUTPUTS_BY_LAYER,
        layerId,
      )
    );
  });

  for (const [layerId, outputs] of Object.entries(
    SPECIALIZED_OUTPUTS_BY_LAYER,
  )) {
    for (const output of outputs) {
      genericOutputRemoved.push(
        template(
          "layer_pass",
          ["layers", layerId, "outputArtifacts", output.outputIndex],
          specializedArtifactPolicy(output.role),
        ),
        template(
          "quality_receipt",
          [
            "layerResults",
            layerId,
            "outputArtifacts",
            output.outputIndex,
          ],
          specializedArtifactPolicy(output.role),
        ),
      );
    }
  }
  return genericOutputRemoved;
}

function templateRoleKey(entry) {
  let rendered = "";
  for (const segment of entry.path) {
    if (isIndexSegment(segment)) rendered += "[#]";
    else if (typeof segment === "number") rendered += `[${segment}]`;
    else rendered += `${rendered.length === 0 ? "" : "."}${segment}`;
  }
  return `${entry.root}:${rendered}`;
}

function validateRoleTemplate(entry, index) {
  exactKeys(
    entry,
    [
      "root",
      "path",
      "emission",
      "mediaType",
      "payloadSchema",
      "encoding",
      "maximumBytes",
      "validatorId",
      "selfHashField",
    ],
    `role template ${index}`,
  );
  if (!Object.prototype.hasOwnProperty.call(ROOT_SCHEMAS, entry.root)) {
    fail("POLICY_ROOT_INVALID", `role template ${index} root is unknown`);
  }
  if (!Array.isArray(entry.path) || entry.path.length === 0) {
    fail("POLICY_PATH_INVALID", `role template ${index} path is empty`);
  }
  for (const segment of entry.path) {
    if (
      !isIndexSegment(segment) &&
      !(
        typeof segment === "string" &&
        /^[A-Za-z][A-Za-z0-9_]*$/.test(segment)
      ) &&
      !(Number.isSafeInteger(segment) && segment >= 0)
    ) {
      fail("POLICY_PATH_INVALID", `role template ${index} path is unsafe`);
    }
  }
  if (!["lookup_only", "reference_site"].includes(entry.emission)) {
    fail(
      "POLICY_EMISSION_INVALID",
      `role template ${index} emission is invalid`,
    );
  }
  if (!/^[a-z0-9][a-z0-9.+-]+\/[a-z0-9][a-z0-9.+-]+$/.test(entry.mediaType)) {
    fail("POLICY_MEDIA_TYPE_INVALID", `role template ${index} media type is invalid`);
  }
  if (
    entry.payloadSchema !== null &&
    (typeof entry.payloadSchema !== "string" ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(entry.payloadSchema))
  ) {
    fail("POLICY_PAYLOAD_SCHEMA_INVALID", `role template ${index} schema is invalid`);
  }
  if (!Object.values(ENCODINGS).includes(entry.encoding)) {
    fail("POLICY_ENCODING_INVALID", `role template ${index} encoding is invalid`);
  }
  if (
    !Number.isSafeInteger(entry.maximumBytes) ||
    entry.maximumBytes <= 0 ||
    entry.maximumBytes > MAX_POLICY_ARTIFACT_BYTES
  ) {
    fail("POLICY_SIZE_INVALID", `role template ${index} maximum is invalid`);
  }
  for (const [field, value] of [["validatorId", entry.validatorId]]) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value)) {
      fail("POLICY_IDENTIFIER_INVALID", `role template ${index}.${field} is invalid`);
    }
  }
  if (
    entry.selfHashField !== null &&
    (typeof entry.selfHashField !== "string" ||
      !/^[A-Za-z][A-Za-z0-9]*$/.test(entry.selfHashField))
  ) {
    fail("POLICY_SELF_HASH_INVALID", `role template ${index} self hash is invalid`);
  }
  if (
    entry.encoding === ENCODINGS.CANONICAL_HASH_BODY &&
    entry.selfHashField === null
  ) {
    fail("POLICY_SELF_HASH_MISSING", `role template ${index} lacks its self hash`);
  }
  if (
    entry.encoding !== ENCODINGS.CANONICAL_HASH_BODY &&
    entry.selfHashField !== null
  ) {
    fail("POLICY_SELF_HASH_UNEXPECTED", `role template ${index} has a self hash`);
  }
}

const ROLE_TEMPLATES_MUTABLE = buildRoleTemplates();
assertSafeGraph(ROLE_TEMPLATES_MUTABLE, "role templates");
ROLE_TEMPLATES_MUTABLE.forEach(validateRoleTemplate);
const roleKeys = ROLE_TEMPLATES_MUTABLE.map(templateRoleKey);
if (new Set(roleKeys).size !== roleKeys.length) {
  fail("POLICY_ROLE_COLLISION", "role templates are not unique");
}
if (
  canonicalJson(quality.EVIDENCE_LAYER_IDS) !==
  canonicalJson(EXPECTED_LAYER_IDS)
) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_LAYER_EXHAUSTIVENESS
  fail(
    "QUALITY_CONTRACT_LAYER_DRIFT",
    "artifact policy must be revised when the quality layer registry changes",
  );
}

const ROLE_TEMPLATES = deepFreeze(
  ROLE_TEMPLATES_MUTABLE
    .map((entry) => safeClone(entry))
    .sort((left, right) =>
      compareCodeUnits(templateRoleKey(left), templateRoleKey(right)),
    ),
);

function concreteRoleId(root, path) {
  return templateRoleKey({ root, path });
}

function exactAliasRule(
  ruleId,
  witnessRoot,
  leftPath,
  rightPath,
  { outputCardinality = null } = {},
) {
  const [leftRoleId, rightRoleId] = [
    concreteRoleId(witnessRoot, leftPath),
    concreteRoleId(witnessRoot, rightPath),
  ].sort(compareCodeUnits);
  return {
    ruleId,
    kind: "required_equal",
    witnessRoot,
    leftRoleId,
    rightRoleId,
    outputCardinality,
  };
}

const REQUIRED_SPECIALIZED_ALIAS_PAIRS = Object.entries(
  quality.SPECIALIZED_ARTIFACT_PROVENANCE,
)
  .filter(([, provenance]) => provenance.kind === "layer_output")
  .map(([role, provenance]) =>
    exactAliasRule(
      `specialized_${role}`,
      "quality_receipt",
      SPECIALIZED_TOP_LEVEL_PATHS[role],
      [
        "layerResults",
        provenance.layerId,
        "outputArtifacts",
        provenance.outputIndex,
      ],
      { outputCardinality: provenance.outputCardinality },
    ),
  );

const REQUIRED_ALIAS_PAIRS = deepFreeze(
  [
    ...REQUIRED_SPECIALIZED_ALIAS_PAIRS,
    exactAliasRule(
      "frozen_review_manifest_unchanged",
      "frozen_review",
      ["reviewedManifest"],
      ["postReviewManifest"],
    ),
  ].sort((left, right) => compareCodeUnits(left.ruleId, right.ruleId)),
);

function matchingRoleTemplate(root, path) {
  const matches = ROLE_TEMPLATES.filter((entry) => {
    if (entry.root !== root || entry.path.length !== path.length) return false;
    return entry.path.every((segment, index) =>
      isIndexSegment(segment)
        ? Number.isSafeInteger(path[index]) && path[index] >= 0
        : segment === path[index],
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function parseConcreteRoleId(roleId) {
  const separator = roleId.indexOf(":");
  const root = roleId.slice(0, separator);
  const rendered = roleId.slice(separator + 1);
  const path = [];
  for (const token of rendered.match(/[A-Za-z][A-Za-z0-9_]*|\[[0-9]+\]/g) || []) {
    path.push(token.startsWith("[") ? Number(token.slice(1, -1)) : token);
  }
  return { root, path };
}

const aliasPairKeys = REQUIRED_ALIAS_PAIRS.map(
  (entry) => `${entry.leftRoleId}\u0000${entry.rightRoleId}`,
);
if (
  new Set(aliasPairKeys).size !== aliasPairKeys.length ||
  new Set(REQUIRED_ALIAS_PAIRS.map((entry) => entry.ruleId)).size !==
    REQUIRED_ALIAS_PAIRS.length
) {
  fail("POLICY_ALIAS_PAIR_COLLISION", "required alias pairs must be unique");
}
for (const pair of REQUIRED_ALIAS_PAIRS) {
  if (pair.leftRoleId === pair.rightRoleId) {
    fail("POLICY_ALIAS_SELF_PAIR", "an alias pair cannot name one role twice");
  }
  const endpoints = [pair.leftRoleId, pair.rightRoleId].map((roleId) => {
    const parsed = parseConcreteRoleId(roleId);
    return matchingRoleTemplate(parsed.root, parsed.path);
  });
  if (
    endpoints.some(
      (entry) => entry === null || entry.emission !== "reference_site",
    )
  ) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_ALIAS_REACHABILITY
    fail(
      "POLICY_ALIAS_ROLE_UNREACHABLE",
      `${pair.ruleId} does not bind two emitted reference roles`,
    );
  }
  const signatures = endpoints.map((entry) =>
    canonicalJson({
      mediaType: entry.mediaType,
      payloadSchema: entry.payloadSchema,
      encoding: entry.encoding,
      maximumBytes: entry.maximumBytes,
      validatorId: entry.validatorId,
      selfHashField: entry.selfHashField,
    }),
  );
  if (signatures[0] !== signatures[1]) {
    fail(
      "POLICY_ALIAS_PAYLOAD_CONFLICT",
      `${pair.ruleId} assigns incompatible payload policies`,
    );
  }
}
if (REQUIRED_SPECIALIZED_ALIAS_PAIRS.length !== 10) {
  fail(
    "SPECIALIZED_ALIAS_CARDINALITY_INVALID",
    "the frozen v7 map must define exactly ten layer-output aliases",
  );
}
const ALLOWED_ALIAS_PAIR_KEYS = new Set(aliasPairKeys);

const POLICY_BODY = {
  schema: POLICY_SCHEMA,
  contractBindingSha256: quality.CONTRACT_BINDING_SHA256,
  contractSourceSha256: quality.CONTRACT_SOURCE_SHA256,
  contractTestSha256: quality.CONTRACT_TEST_SHA256,
  artifactRefSiteManifestSha256:
    quality.ARTIFACT_REF_SITE_MANIFEST_SHA256,
  contractSchema: quality.SCHEMAS.qualityReceipt,
  contractLayerIds: [...EXPECTED_LAYER_IDS],
  specializedArtifactProvenance: safeClone(
    quality.SPECIALIZED_ARTIFACT_PROVENANCE,
  ),
  rootSchemas: safeClone(ROOT_SCHEMAS),
  encodings: Object.values(ENCODINGS),
  maximumArtifactBytes: MAX_POLICY_ARTIFACT_BYTES,
  byteStreamLimits: {
    decodedMaximumBytes: BYTE_STREAM_DECODED_MAX_BYTES,
    base64MaximumCharacters: BYTE_STREAM_BASE64_MAX_CHARS,
    canonicalOverheadBytes: BYTE_STREAM_ENVELOPE_OVERHEAD_BYTES,
    envelopeMaximumBytes: BYTE_STREAM_ENVELOPE_MAX_BYTES,
  },
  requiredAliasPairs: REQUIRED_ALIAS_PAIRS,
  roleTemplates: ROLE_TEMPLATES,
};
const ARTIFACT_POLICY_SHA256 = sha256(canonicalJson(POLICY_BODY));
const ARTIFACT_POLICY = deepFreeze({
  ...safeClone(POLICY_BODY),
  policySha256: ARTIFACT_POLICY_SHA256,
});

function canonicalizeArtifactRole(descriptor) {
  assertSafeGraph(descriptor, "artifact role descriptor");
  exactKeys(descriptor, ["schema", "root", "path"], "artifact role descriptor");
  if (descriptor.schema !== ROLE_SCHEMA) {
    fail("ROLE_SCHEMA_INVALID", `role descriptor schema must be ${ROLE_SCHEMA}`);
  }
  if (!Object.prototype.hasOwnProperty.call(ROOT_SCHEMAS, descriptor.root)) {
    fail("UNKNOWN_ARTIFACT_ROOT", "role descriptor root is unknown");
  }
  if (!Array.isArray(descriptor.path) || descriptor.path.length === 0) {
    fail("ROLE_PATH_INVALID", "role descriptor path must be non-empty");
  }
  if (descriptor.path.length > 16) {
    fail("ROLE_PATH_LIMIT", "role descriptor path is too deep");
  }
  for (const segment of descriptor.path) {
    if (typeof segment === "string") {
      if (
        segment.includes("*") || // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_WILDCARD
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(segment)
      ) {
        fail("WILDCARD_ROLE_REFUSED", "role path strings must be exact identifiers");
      }
    } else if (!Number.isSafeInteger(segment) || segment < 0) {
      fail("ROLE_PATH_INVALID", "role path indexes must be non-negative integers");
    }
  }

  const matches = ROLE_TEMPLATES.filter((entry) => {
    if (entry.root !== descriptor.root || entry.path.length !== descriptor.path.length) {
      return false;
    }
    return entry.path.every((segment, index) =>
      isIndexSegment(segment)
        ? Number.isSafeInteger(descriptor.path[index]) && descriptor.path[index] >= 0
        : descriptor.path[index] === segment,
    );
  });
  if (matches.length === 0) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_UNKNOWN_ROLE
    fail("UNKNOWN_ARTIFACT_ROLE", "artifact role is not in the closed policy");
  }
  if (matches.length !== 1) {
    fail("AMBIGUOUS_ARTIFACT_ROLE", "artifact role resolves ambiguously");
  }
  let rendered = "";
  for (const segment of descriptor.path) {
    rendered +=
      typeof segment === "number"
        ? `[${segment}]`
        : `${rendered.length === 0 ? "" : "."}${segment}`;
  }
  return deepFreeze({
    schema: ROLE_SCHEMA,
    root: descriptor.root,
    path: [...descriptor.path],
    roleId: `${descriptor.root}:${rendered}`,
  });
}

function lookupArtifactRole(descriptor) {
  const role = canonicalizeArtifactRole(descriptor);
  const matched = ROLE_TEMPLATES.find((entry) => {
    if (entry.root !== role.root || entry.path.length !== role.path.length) return false;
    return entry.path.every((segment, index) =>
      isIndexSegment(segment) ? typeof role.path[index] === "number" : segment === role.path[index],
    );
  });
  if (matched === undefined) {
    fail("POLICY_LOOKUP_INCONSISTENT", "canonical role has no policy");
  }
  return deepFreeze({
    roleId: role.roleId,
    mediaType: matched.mediaType,
    payloadSchema: matched.payloadSchema,
    encoding: matched.encoding,
    maximumBytes: matched.maximumBytes,
    validatorId: matched.validatorId,
    selfHashField: matched.selfHashField,
    emission: matched.emission,
    aliasRuleIds: REQUIRED_ALIAS_PAIRS.filter(
      (pair) =>
        pair.leftRoleId === role.roleId ||
        pair.rightRoleId === role.roleId,
    ).map((pair) => pair.ruleId),
  });
}

function requirePayloadBytes(bytes) {
  if (isProxy(bytes)) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_PAYLOAD_PROXY
    fail("PROXY_REFUSED", "artifact payload bytes cannot be a Proxy");
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail("ARTIFACT_BYTES_REQUIRED", "artifact payload must be Buffer or Uint8Array");
  }
  const copy = Buffer.from(bytes);
  if (copy.byteLength === 0) {
    fail("ARTIFACT_BYTES_EMPTY", "CAS artifact payload bytes must be non-empty");
  }
  return copy;
}

function parseCanonicalJsonBytes(bytes, policy) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    fail("JSON_BOM_REFUSED", "canonical JSON must not contain a UTF-8 BOM");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("JSON_UTF8_INVALID", "artifact JSON is not valid UTF-8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("JSON_PARSE_INVALID", "artifact JSON cannot be parsed");
  }
  assertSafeGraph(parsed, "artifact JSON");
  if (canonicalJson(parsed) !== text) {
    fail(
      "NON_CANONICAL_JSON_BYTES",
      "artifact JSON must be stable canonical JSON with no trailing newline",
    );
  }
  requireObject(parsed, "artifact JSON");
  if (parsed.schema !== policy.payloadSchema) {
    fail("PAYLOAD_SCHEMA_MISMATCH", "artifact JSON schema does not match its role");
  }
  return parsed;
}

function validateByteStreamEnvelope(parsed, policy) {
  exactKeys(
    parsed,
    ["schema", "encoding", "decodedByteLength", "base64"],
    "byte stream envelope",
  );
  if (parsed.encoding !== "base64") {
    fail("BYTE_STREAM_ENCODING_INVALID", "byte stream envelope encoding must be base64");
  }
  if (
    !Number.isSafeInteger(parsed.decodedByteLength) ||
    parsed.decodedByteLength < 0 ||
    parsed.decodedByteLength > BYTE_STREAM_DECODED_MAX_BYTES
  ) {
    fail(
      "BYTE_STREAM_DECODED_SIZE_INVALID",
      "byte stream decoded length exceeds its role bound",
    );
  }
  if (
    typeof parsed.base64 !== "string" ||
    parsed.base64.length > BYTE_STREAM_BASE64_MAX_CHARS
  ) {
    fail("BYTE_STREAM_BASE64_INVALID", "byte stream base64 is not canonical");
  }
  if (parsed.base64.length % 4 !== 0) {
    fail("BYTE_STREAM_BASE64_INVALID", "byte stream base64 length is invalid");
  }
  let padding = 0;
  let paddingStarted = false;
  for (let index = 0; index < parsed.base64.length; index += 1) {
    const code = parsed.base64.charCodeAt(index);
    const alphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (code === 61) {
      paddingStarted = true;
      padding += 1;
      if (padding > 2 || index < parsed.base64.length - 2) {
        fail("BYTE_STREAM_BASE64_INVALID", "byte stream base64 padding is invalid");
      }
    } else if (!alphabet || paddingStarted) {
      fail("BYTE_STREAM_BASE64_INVALID", "byte stream base64 alphabet is invalid");
    }
  }
  const decodedByteLength =
    parsed.base64.length === 0
      ? 0
      : (parsed.base64.length / 4) * 3 - padding;
  if (
    !Number.isSafeInteger(decodedByteLength) ||
    decodedByteLength !== parsed.decodedByteLength ||
    decodedByteLength > BYTE_STREAM_DECODED_MAX_BYTES
  ) {
    fail(
      "BYTE_STREAM_LENGTH_MISMATCH",
      "byte stream decoded length does not match canonical base64",
    );
  }
  const decoded = Buffer.from(parsed.base64, "base64");
  if (
    decoded.byteLength !== decodedByteLength ||
    decoded.toString("base64") !== parsed.base64
  ) {
    fail("BYTE_STREAM_BASE64_INVALID", "byte stream base64 is not canonical");
  }
  return decodedByteLength;
}

function validateArtifactPayload(roleDescriptor, bytes) {
  const role = canonicalizeArtifactRole(roleDescriptor);
  const policy = lookupArtifactRole(roleDescriptor);
  const payload = requirePayloadBytes(bytes);
  if (payload.byteLength > policy.maximumBytes) {
    fail("ARTIFACT_SIZE_LIMIT", `${role.roleId} exceeds its byte limit`);
  }

  let decodedByteLength = null;
  let computedSelfHash = null;
  if (policy.encoding === ENCODINGS.OPAQUE_BYTES) {
    // Opaque roles have no parser. Their role and byte limit remain closed.
  } else {
    const parsed = parseCanonicalJsonBytes(payload, policy);
    if (policy.validatorId === "byte_stream_envelope_v1") {
      decodedByteLength = validateByteStreamEnvelope(parsed, policy);
    }
    if (policy.encoding === ENCODINGS.CANONICAL_HASH_BODY) {
      if (Object.prototype.hasOwnProperty.call(parsed, policy.selfHashField)) {
        fail(
          "SELF_HASH_FIELD_PRESENT",
          "canonical hash-body bytes must omit their derived self-hash field",
        );
      }
      computedSelfHash = sha256(payload);
    }
  }
  return deepFreeze({
    schema: "pikiio-quality-artifact-payload-validation-v1",
    roleId: role.roleId,
    mediaType: policy.mediaType,
    payloadSchema: policy.payloadSchema,
    encoding: policy.encoding,
    validatorId: policy.validatorId,
    byteLength: payload.byteLength,
    decodedByteLength,
    sha256: sha256(payload),
    computedSelfHash,
  });
}

function descriptor(root, path) {
  return { schema: ROLE_SCHEMA, root, path };
}

function valueAtPath(value, path) {
  return path.reduce(
    (cursor, segment) =>
      cursor !== null && typeof cursor === "object"
        ? cursor[segment]
        : undefined,
    value,
  );
}

function validateSpecializedArtifactBindings(value) {
  const layerResults = requireObject(
    value.layerResults,
    "quality receipt.layerResults",
  );
  const layerOutputAddresses = new Set();
  for (const layerId of EXPECTED_LAYER_IDS) {
    const result = requireObject(
      layerResults[layerId],
      `quality receipt.layerResults.${layerId}`,
    );
    if (result.schema !== quality.SCHEMAS.layerPass) continue;
    for (const artifact of requireArray(
      result.outputArtifacts,
      `quality receipt.layerResults.${layerId}.outputArtifacts`,
    )) {
      if (artifact && typeof artifact === "object") {
        layerOutputAddresses.add(artifact.address);
      }
    }
  }

  const controllerAddresses = new Set();
  for (const [role, provenance] of Object.entries(
    quality.SPECIALIZED_ARTIFACT_PROVENANCE,
  )) {
    const reference = valueAtPath(value, SPECIALIZED_TOP_LEVEL_PATHS[role]);
    if (provenance.kind === "layer_output") {
      const result = requireObject(
        layerResults[provenance.layerId],
        `quality receipt.layerResults.${provenance.layerId}`,
      );
      const outputs = requireArray(
        result.outputArtifacts,
        `quality receipt.layerResults.${provenance.layerId}.outputArtifacts`,
      );
      if (
        result.schema !== quality.SCHEMAS.layerPass ||
        outputs.length !== provenance.outputCardinality
      ) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_SPECIALIZED_CARDINALITY
        fail(
          "SPECIALIZED_ARTIFACT_CARDINALITY_MISMATCH",
          `${role} producing layer has the wrong output cardinality`,
        );
      }
      if (
        canonicalJson(reference) !==
        canonicalJson(outputs[provenance.outputIndex])
      ) {
        fail(
          "REQUIRED_ARTIFACT_ALIAS_MISMATCH",
          `${role} differs from its fixed producing-layer output`,
        );
      }
    } else {
      const address =
        reference && typeof reference === "object"
          ? reference.address
          : undefined;
      if (
        typeof address !== "string" ||
        layerOutputAddresses.has(address) ||
        controllerAddresses.has(address)
      ) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_CONTROLLER_ONLY
        fail(
          "CONTROLLER_ONLY_ARTIFACT_ALIAS",
          `${role} must be controller-only and address-distinct`,
        );
      }
      controllerAddresses.add(address);
    }
  }
}

function requireExecutionString(value, label, { identifier = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > (identifier ? 256 : 4096) ||
    (identifier && !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value))
  ) {
    fail("EXECUTION_IDENTITY_INVALID", `${label} is invalid`);
  }
  return value;
}

function requireExecutionSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("EXECUTION_IDENTITY_INVALID", `${label} is not a SHA-256`);
  }
  return value;
}

function deriveExecutionClaimInstance(value) {
  const executionId = requireExecutionString(
    value.executionId,
    "execution observation.executionId",
    { identifier: true },
  );
  if (!EXPECTED_LAYER_IDS.includes(value.layerId)) {
    fail("UNKNOWN_LAYER_ID", "execution observation layer is unknown");
  }
  const coordinate = {
    layerId: value.layerId,
    checkId: requireExecutionString(
      value.checkId,
      "execution observation.checkId",
      { identifier: true },
    ),
    definitionSha256: requireExecutionSha(
      value.definitionSha256,
      "execution observation.definitionSha256",
    ),
    repeat: value.repeat,
    seed: requireExecutionString(
      value.seed,
      "execution observation.seed",
    ),
    timeZone: requireExecutionString(
      value.timeZone,
      "execution observation.timeZone",
    ),
    orderId: requireExecutionString(
      value.orderId,
      "execution observation.orderId",
    ),
    fixtureManifestSha256: requireExecutionSha(
      value.fixtureManifestSha256,
      "execution observation.fixtureManifestSha256",
    ),
  };
  if (!Number.isSafeInteger(coordinate.repeat) || coordinate.repeat <= 0) {
    fail(
      "EXECUTION_IDENTITY_INVALID",
      "execution observation.repeat must be a positive safe integer",
    );
  }
  const coordinateSha256 = sha256(canonicalJson(coordinate));
  const instanceSha256 = sha256(
    canonicalJson({ executionId, ...coordinate }),
  );
  return deepFreeze({
    schema: EXECUTION_INSTANCE_SCHEMA,
    executionId,
    coordinate,
    coordinateSha256,
    instanceSha256,
  });
}

function claimRole(canonicalRole, instance) {
  const templateRoleId = canonicalRole.roleId;
  return deepFreeze({
    schema: ROLE_SCHEMA,
    root: canonicalRole.root,
    path: [...canonicalRole.path],
    templateRoleId,
    roleId:
      instance === null
        ? templateRoleId
        : `${canonicalRole.root}:instances[${instance.instanceSha256}].${canonicalRole.path.at(-1)}`,
    instance: instance === null ? null : safeClone(instance),
  });
}

function enforceExecutionInstanceUniqueness(claims) {
  const byInstance = new Map();
  for (const claim of claims) {
    const instance = claim.role.instance;
    if (instance === null) continue;
    const prior = byInstance.get(instance.instanceSha256);
    if (prior === undefined) {
      byInstance.set(instance.instanceSha256, instance);
    } else if (canonicalJson(prior) !== canonicalJson(instance)) {
      fail(
        "EXECUTION_INSTANCE_HASH_COLLISION",
        "one execution instance hash describes divergent coordinates",
      );
    }
  }
  const executionIds = new Map();
  const coordinates = new Map();
  for (const instance of byInstance.values()) {
    const priorCoordinate = executionIds.get(instance.executionId);
    if (
      priorCoordinate !== undefined &&
      priorCoordinate !== instance.coordinateSha256
    ) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_EXECUTION_ID_UNIQUENESS
      fail(
        "EXECUTION_ID_COORDINATE_COLLISION",
        "one executionId describes multiple Cartesian coordinates",
      );
    }
    executionIds.set(instance.executionId, instance.coordinateSha256);
    const priorExecution = coordinates.get(instance.coordinateSha256);
    if (
      priorExecution !== undefined &&
      priorExecution !== instance.executionId
    ) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_COORDINATE_UNIQUENESS
      fail(
        "DUPLICATE_EXECUTION_COORDINATE",
        "one Cartesian coordinate was claimed by multiple executionIds",
      );
    }
    coordinates.set(instance.coordinateSha256, instance.executionId);
  }
}

function enforceExactAliasPairs(claims) {
  const byRole = new Map(
    claims.map((claim) => [claim.role.roleId, claim]),
  );
  for (const pair of REQUIRED_ALIAS_PAIRS) {
    const witnessPresent = claims.some(
      (claim) => claim.role.root === pair.witnessRoot,
    );
    if (!witnessPresent) continue;
    const left = byRole.get(pair.leftRoleId);
    const right = byRole.get(pair.rightRoleId);
    if (!left || !right) {
      fail(
        "REQUIRED_ALIAS_ENDPOINT_MISSING",
        `${pair.ruleId} is not reachable in its declared witness graph`,
      );
    }
    if (
      canonicalJson(left.artifact) !==
      canonicalJson(right.artifact)
    ) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_REQUIRED_ALIAS
      fail(
        "REQUIRED_ARTIFACT_ALIAS_MISMATCH",
        `${pair.ruleId} does not bind one exact ArtifactRef`,
        {
          leftRoleId: pair.leftRoleId,
          rightRoleId: pair.rightRoleId,
        },
      );
    }
  }

  const byAddress = new Map();
  for (const claim of claims) {
    const prior = byAddress.get(claim.artifact.address) || [];
    prior.push(claim);
    byAddress.set(claim.artifact.address, prior);
  }
  for (const [address, addressClaims] of byAddress) {
    if (addressClaims.length < 2) continue;
    for (let left = 0; left < addressClaims.length; left += 1) {
      for (let right = left + 1; right < addressClaims.length; right += 1) {
        const leftClaim = addressClaims[left];
        const rightClaim = addressClaims[right];
        const [leftRoleId, rightRoleId] = [
          leftClaim.role.roleId,
          rightClaim.role.roleId,
        ].sort(compareCodeUnits);
        const pairKey = `${leftRoleId}\u0000${rightRoleId}`;
        if (
          !ALLOWED_ALIAS_PAIR_KEYS.has(pairKey) // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_CLOSED_ALIAS
        ) {
          fail("ARTIFACT_ALIAS_REFUSED", "same-address roles lack an exact alias pair", {
            address,
            leftRoleId,
            rightRoleId,
          });
        }
      }
    }
  }
}

const ARTIFACT_SITE_BY_ID = new Map(
  quality.ARTIFACT_REF_SITE_MANIFEST.map((site) => [site.siteId, site]),
);
if (
  ARTIFACT_SITE_BY_ID.size !== quality.ARTIFACT_REF_SITE_MANIFEST.length ||
  quality.ARTIFACT_REF_SITE_MANIFEST.some(
    (site) =>
      !Object.prototype.hasOwnProperty.call(ROOT_SCHEMAS, site.root),
  )
) { // QUALITY_ARTIFACT_POLICY_V2_MUTATION_ANCHOR_SITE_MANIFEST
  fail(
    "ARTIFACT_SITE_MANIFEST_INVALID",
    "frozen ArtifactRef sites must be unique and name known roots",
  );
}

function sitePathMatches(pattern, sourcePath) {
  if (pattern.length !== sourcePath.length) return false;
  return pattern.every((segment, index) => {
    if (
      segment !== null &&
      typeof segment === "object" &&
      !Array.isArray(segment)
    ) {
      if (segment.kind === "index") {
        return Number.isSafeInteger(sourcePath[index]) && sourcePath[index] >= 0;
      }
      if (segment.kind === "layer_id") {
        return EXPECTED_LAYER_IDS.includes(sourcePath[index]);
      }
      return false;
    }
    return segment === sourcePath[index];
  });
}

function lookupArtifactSite(root, sourcePath) {
  const matches = quality.ARTIFACT_REF_SITE_MANIFEST.filter(
    (site) =>
      site.root === root &&
      sitePathMatches(site.path, sourcePath),
  );
  if (matches.length !== 1) {
    fail(
      "UNDECLARED_ARTIFACT_REFERENCE",
      "artifact reference does not map to one frozen contract site",
      { root, sourcePath, matchCount: matches.length },
    );
  }
  return matches[0];
}

function enumerateArtifactClaims(envelope) {
  assertSafeGraph(envelope, "artifact enumeration");
  exactKeys(envelope, ["schema", "root", "value"], "artifact enumeration");
  if (envelope.schema !== ENUMERATION_SCHEMA) {
    fail("ENUMERATION_SCHEMA_INVALID", `enumeration schema must be ${ENUMERATION_SCHEMA}`);
  }
  if (!Object.prototype.hasOwnProperty.call(ROOT_SCHEMAS, envelope.root)) {
    fail("UNKNOWN_ARTIFACT_ROOT", "enumeration root is unknown");
  }
  const value = requireObject(envelope.value, "artifact enumeration.value");
  if (value.schema !== ROOT_SCHEMAS[envelope.root]) {
    fail("ROOT_SCHEMA_MISMATCH", "enumeration root and payload schema disagree");
  }
  const executionInstance =
    envelope.root === "execution_observation"
      ? deriveExecutionClaimInstance(value)
      : null;

  const pending = [];
  function add(rolePath, sourcePath, artifact) {
    const site = lookupArtifactSite(envelope.root, sourcePath);
    const canonicalRole = canonicalizeArtifactRole(
      descriptor(envelope.root, rolePath),
    );
    const role = claimRole(canonicalRole, executionInstance);
    const policy = lookupArtifactRole(descriptor(envelope.root, rolePath));
    let validated;
    try {
      validated = quality.validateArtifactRef(
        artifact,
        `artifact claim ${role.roleId}`,
      );
    } catch (error) {
      fail("ARTIFACT_REFERENCE_INVALID", `artifact claim ${role.roleId} is invalid`, {
        causeCode: error && error.code ? error.code : "UNKNOWN",
      });
    }
    if (validated.mediaType !== policy.mediaType) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_MEDIA
      fail("ARTIFACT_MEDIA_TYPE_MISMATCH", `${role.roleId} has the wrong media type`);
    }
    if (validated.byteLength > policy.maximumBytes) { // QUALITY_ARTIFACT_POLICY_MUTATION_ANCHOR_SIZE
      fail("ARTIFACT_SIZE_LIMIT", `${role.roleId} exceeds its byte limit`);
    }
    pending.push({
      sourcePath: [...sourcePath],
      claim: {
        schema: CLAIM_SCHEMA,
        claimId: sha256(
          canonicalJson({
            policySha256: ARTIFACT_POLICY_SHA256,
            siteId: site.siteId,
            roleId: role.roleId,
            sourcePath,
            artifactAddress: validated.address,
          }),
        ),
        siteId: site.siteId,
        sourcePath: [...sourcePath],
        role,
        policy,
        artifact: safeClone(validated),
      },
    });
  }

  function addIndexed(entries, sourcePrefix, rolePrefix, field) {
    requireArray(entries, sourcePrefix.join(".")).forEach((entry, index) => {
      const object = requireObject(entry, `${sourcePrefix.join(".")}[${index}]`);
      add(
        [...rolePrefix, index, field],
        [...sourcePrefix, index, field],
        object[field],
      );
    });
  }

  function addLayerPass(result, layerId, sourcePrefix, rolePrefix) {
    requireObject(result, sourcePrefix.join("."));
    requireArray(result.executions, `${sourcePrefix.join(".")}.executions`).forEach(
      (artifact, index) =>
        add(
          [...rolePrefix, layerId, "executions", index],
          [...sourcePrefix, "executions", index],
          artifact,
        ),
    );
    add(
      [...rolePrefix, layerId, "rawPopulationArtifact"],
      [...sourcePrefix, "rawPopulationArtifact"],
      result.rawPopulationArtifact,
    );
    requireArray(
      result.outputArtifacts,
      `${sourcePrefix.join(".")}.outputArtifacts`,
    ).forEach((artifact, index) =>
      add(
        [...rolePrefix, layerId, "outputArtifacts", index],
        [...sourcePrefix, "outputArtifacts", index],
        artifact,
      ),
    );
  }

  switch (envelope.root) {
    case "quality_policy":
      requireArray(value.approvedToolchains, "approvedToolchains").forEach(
        (artifact, index) =>
          add(
            ["approvedToolchains", index],
            ["approvedToolchains", index],
            artifact,
          ),
      );
      add(["phaseProofRegistry"], ["phaseProofRegistry"], value.phaseProofRegistry);
      break;
    case "quality_plan":
    case "population_floor":
    case "source_manifest":
    case "evidence_manifest":
    case "primary_judge_raw":
    case "independent_judge_raw":
    case "frozen_source_manifest":
    case "rehearsal_receipt":
    case "change_receipt":
    case "promotion_receipt":
      break;
    case "execution_observation":
      if (!EXPECTED_LAYER_IDS.includes(value.layerId)) {
        fail("UNKNOWN_LAYER_ID", "execution observation layer is unknown");
      }
      for (const field of [
        "stdoutArtifact",
        "stderrArtifact",
        "parsedOutputArtifact",
      ]) {
        add(["layers", value.layerId, field], [field], value[field]);
      }
      break;
    case "verifier_output":
      if (!VERIFIER_LAYER_IDS.includes(value.layerId)) {
        fail("UNKNOWN_LAYER_ID", "verifier output layer is unknown");
      }
      add(
        ["layers", value.layerId, "rawResultArtifact"],
        ["rawResultArtifact"],
        value.rawResultArtifact,
      );
      break;
    case "layer_pass":
      if (!EXPECTED_LAYER_IDS.includes(value.layerId)) {
        fail("UNKNOWN_LAYER_ID", "layer pass layer is unknown");
      }
      addLayerPass(value, value.layerId, [], ["layers"]);
      break;
    case "coverage_input_manifest":
      addIndexed(
        value.orderedInputs,
        ["orderedInputs"],
        ["orderedInputs"],
        "artifact",
      );
      break;
    case "coverage_proof":
      addIndexed(
        requireObject(value.inputManifest, "inputManifest").orderedInputs,
        ["inputManifest", "orderedInputs"],
        ["inputManifest", "orderedInputs"],
        "artifact",
      );
      addIndexed(
        value.files,
        ["files"],
        ["files"],
        "uncoveredRangesArtifact",
      );
      break;
    case "operational_manifest":
      for (const field of [
        "automationInputsArtifact",
        "dependencyManifestArtifact",
        "toolchainManifestArtifact",
      ]) {
        add([field], [field], value[field]);
      }
      break;
    case "crash_population":
      for (const [index, entry] of requireArray(value.cases, "cases").entries()) {
        requireObject(entry, `cases[${index}]`);
        for (const field of [
          "preStateArtifact",
          "postCrashStateArtifact",
          "recoveryArtifact",
        ]) {
          add(["cases", index, field], ["cases", index, field], entry[field]);
        }
      }
      break;
    case "concurrency_population":
      for (const [index, entry] of requireArray(value.cases, "cases").entries()) {
        requireObject(entry, `cases[${index}]`);
        for (const field of [
          "scheduleArtifact",
          "operationsArtifact",
          "acceptedOrderingArtifact",
        ]) {
          add(["cases", index, field], ["cases", index, field], entry[field]);
        }
      }
      break;
    case "parser_population":
      for (const [index, entry] of requireArray(value.cases, "cases").entries()) {
        requireObject(entry, `cases[${index}]`);
        add(
          ["cases", index, "inputArtifact"],
          ["cases", index, "inputArtifact"],
          entry.inputArtifact,
        );
      }
      break;
    case "frozen_review":
      for (const field of ["reviewedManifest", "postReviewManifest"]) {
        add([field], [field], value[field]);
      }
      for (const [index, entry] of requireArray(value.findings, "findings").entries()) {
        requireObject(entry, `findings[${index}]`);
        for (const field of ["locationArtifact", "findingArtifact"]) {
          add(["findings", index, field], ["findings", index, field], entry[field]);
        }
      }
      requireArray(value.closureReceipts, "closureReceipts").forEach(
        (artifact, index) =>
          add(["closureReceipts", index], ["closureReceipts", index], artifact),
      );
      requireArray(value.certifierRuns, "certifierRuns").forEach(
        (artifact, index) =>
          add(["certifierRuns", index], ["certifierRuns", index], artifact),
      );
      add(["coordinatorRerun"], ["coordinatorRerun"], value.coordinatorRerun);
      break;
    case "quality_receipt": {
      validateSpecializedArtifactBindings(value);
      const layerResults = requireObject(value.layerResults, "layerResults");
      for (const layerId of EXPECTED_LAYER_IDS) {
        const result = requireObject(layerResults[layerId], `layerResults.${layerId}`);
        if (result.schema === quality.SCHEMAS.layerPass) {
          addLayerPass(
            result,
            layerId,
            ["layerResults", layerId],
            ["layerResults"],
          );
        } else if (result.schema !== quality.SCHEMAS.notApplicable) {
          fail("LAYER_RESULT_SCHEMA_INVALID", `${layerId} result schema is invalid`);
        }
      }
      for (const field of [
        "coverage",
        "mutation",
        "crashRestart",
        "concurrencyLinearizability",
        "schemaParserRobustness",
        "antiWeakening",
        "primaryJudge",
        "independentJudge",
        "rawEvidenceManifest",
      ]) {
        add([field], [field], value[field]);
      }
      add(
        ["executionMatrix", "artifact"],
        ["executionMatrix", "artifact"],
        requireObject(value.executionMatrix, "executionMatrix").artifact,
      );
      const operational = requireObject(
        value.operationalIntegrity,
        "operationalIntegrity",
      );
      for (const field of ["beforeManifest", "afterManifest", "automationInputs"]) {
        add(
          ["operationalIntegrity", field],
          ["operationalIntegrity", field],
          operational[field],
        );
      }
      add(
        ["independentFrozenHashReview", "artifact"],
        ["independentFrozenHashReview", "artifact"],
        requireObject(
          value.independentFrozenHashReview,
          "independentFrozenHashReview",
        ).artifact,
      );
      break;
    }
    case "candidate_receipt":
      for (const field of [
        "authoritySnapshot",
        "changedPathsManifest",
        "changedPathCoverage",
        "assertions",
        "rawArtifact",
      ]) {
        add([field], [field], value[field]);
      }
      break;
    case "attestation_body": {
      const artifacts = requireObject(value.artifacts, "artifacts");
      for (const field of [
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
      ]) {
        add(["artifacts", field], ["artifacts", field], artifacts[field]);
      }
      break;
    }
    default:
      fail("UNKNOWN_ARTIFACT_ROOT", "enumeration root is not implemented");
  }

  const discoveredPaths = [];
  function discover(node, path) {
    if (node === null || typeof node !== "object") return;
    if (!Array.isArray(node) && node.schema === quality.SCHEMAS.artifactRef) {
      discoveredPaths.push(path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => discover(entry, [...path, index]));
      return;
    }
    for (const key of Object.keys(node)) discover(node[key], [...path, key]);
  }
  discover(value, []);
  const expectedPathKeys = pending.map((entry) => canonicalJson(entry.sourcePath));
  const discoveredPathKeys = discoveredPaths.map((path) => canonicalJson(path));
  if (
    new Set(expectedPathKeys).size !== expectedPathKeys.length ||
    expectedPathKeys.length !== discoveredPathKeys.length ||
    [...expectedPathKeys].sort(compareCodeUnits).some(
      (entry, index) =>
        entry !== [...discoveredPathKeys].sort(compareCodeUnits)[index],
    )
  ) {
    fail(
      "UNDECLARED_ARTIFACT_REFERENCE",
      "payload contains a missing, duplicate, or unclassified artifact reference",
      {
        expectedPaths: [...expectedPathKeys].sort(compareCodeUnits),
        discoveredPaths: [...discoveredPathKeys].sort(compareCodeUnits),
      },
    );
  }

  const claims = pending
    .map((entry) => entry.claim)
    .sort((left, right) => compareCodeUnits(left.role.roleId, right.role.roleId));
  if (new Set(claims.map((claim) => claim.role.roleId)).size !== claims.length) {
    fail("DUPLICATE_ARTIFACT_ROLE", "enumeration emitted a duplicate role");
  }
  enforceExecutionInstanceUniqueness(claims);
  enforceExactAliasPairs(claims);
  return deepFreeze(claims.map((claim) => safeClone(claim)));
}

function enumerateArtifactClaimSet(envelopes) {
  assertSafeGraph(envelopes, "artifact enumeration set");
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    fail("ENUMERATION_SET_INVALID", "artifact enumeration set must be non-empty");
  }
  const claims = envelopes.flatMap((envelope) => enumerateArtifactClaims(envelope));
  const roleIds = claims.map((claim) => claim.role.roleId);
  if (new Set(roleIds).size !== roleIds.length) {
    fail("DUPLICATE_ARTIFACT_ROLE", "enumeration set contains a duplicate role");
  }
  enforceExecutionInstanceUniqueness(claims);
  enforceExactAliasPairs(claims);
  return deepFreeze(
    claims
      .map((claim) => safeClone(claim))
      .sort((left, right) => compareCodeUnits(left.role.roleId, right.role.roleId)),
  );
}

module.exports = deepFreeze({
  ARTIFACT_POLICY,
  ARTIFACT_POLICY_SHA256,
  BYTE_STREAM_DECODED_MAX_BYTES,
  BYTE_STREAM_ENVELOPE_MAX_BYTES,
  CLAIM_SCHEMA,
  CONTRACT_BINDING_SHA256: quality.CONTRACT_BINDING_SHA256,
  ENCODINGS,
  ENUMERATION_SCHEMA,
  EXECUTION_INSTANCE_SCHEMA,
  EXPECTED_LAYER_IDS,
  MAX_POLICY_ARTIFACT_BYTES,
  POLICY_SCHEMA,
  REQUIRED_ALIAS_PAIRS,
  REQUIRED_SPECIALIZED_ALIAS_PAIRS,
  ROLE_SCHEMA,
  ROOT_SCHEMAS,
  QualityArtifactPolicyError,
  canonicalizeArtifactRole,
  enumerateArtifactClaimSet,
  enumerateArtifactClaims,
  lookupArtifactRole,
  validateArtifactPayload,
});

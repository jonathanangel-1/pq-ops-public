"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { types: { isProxy } } = require("node:util");

const SCHEMAS = Object.freeze({
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

const EVIDENCE_LAYER_IDS = Object.freeze([
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

const CONDITIONAL_LAYER_IDS = Object.freeze([
  "production_shaped_rehearsal",
  "natural_cycle_qa",
  "api_browser_parity",
]);

const CONDITIONAL_REASON_CODES = Object.freeze({
  production_shaped_rehearsal: Object.freeze([
    "phase_has_no_production_surface",
  ]),
  natural_cycle_qa: Object.freeze([
    "candidate_stage_precedes_natural_cycles",
    "phase_has_no_natural_cycle_surface",
  ]),
  api_browser_parity: Object.freeze([
    "candidate_stage_precedes_browser_observation",
    "phase_has_no_browser_surface",
  ]),
});

const ZERO_FAILURE_KEYS = Object.freeze([
  "failed",
  "cancelled",
  "skipped",
  "todo",
  "flaky",
  "warnings",
  "timeouts",
  "signals",
  "retries",
  "undefinedGherkinSteps",
  "survivingCriticalMutants",
  "uncoveredRequiredFiles",
  "unrecoveredCrashPoints",
  "nonconvergentIdenticalCases",
  "acceptedDivergentCases",
  "staleOwnerWins",
  "untypedParserRefusals",
  "unresolvedSeverity0",
  "unresolvedSeverity1",
  "postCertificationChangedBytes",
  "missingRawArtifacts",
]);

const EXECUTION_ZERO_FAILURE_KEYS = Object.freeze([
  "failed",
  "cancelled",
  "skipped",
  "todo",
  "flaky",
  "warnings",
  "timeouts",
  "signals",
  "retries",
]);

const PRODUCER_OUTPUT_SCHEMAS = Object.freeze(
  Object.fromEntries(
    EVIDENCE_LAYER_IDS.map((layerId) => [
      layerId,
      `pikiio-${layerId.replaceAll("_", "-")}-producer-output-v1`,
    ]),
  ),
);

const IMMUTABLE_RESOURCE_CEILINGS = Object.freeze({
  timeoutMsPerExecution: 120000,
  maximumStdoutBytes: 1048576,
  maximumStderrBytes: 1048576,
  maximumPeakRssBytes: 1073741824,
  maximumProcessCount: 16,
  maximumRetries: 0,
  maximumByteStreamEnvelopeBytes: 1398360,
});

const SPECIALIZED_ARTIFACT_PROVENANCE = Object.freeze({
  coverage: Object.freeze({
    kind: "layer_output",
    layerId: "coverage",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  mutation: Object.freeze({
    kind: "layer_output",
    layerId: "mutation",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  executionMatrix: Object.freeze({
    kind: "layer_output",
    layerId: "deterministic_repeat",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  operationalBeforeManifest: Object.freeze({
    kind: "layer_output",
    layerId: "operational_integrity",
    outputIndex: 0,
    outputCardinality: 3,
  }),
  operationalAfterManifest: Object.freeze({
    kind: "layer_output",
    layerId: "operational_integrity",
    outputIndex: 1,
    outputCardinality: 3,
  }),
  operationalAutomationInputs: Object.freeze({
    kind: "layer_output",
    layerId: "operational_integrity",
    outputIndex: 2,
    outputCardinality: 3,
  }),
  crashRestart: Object.freeze({
    kind: "layer_output",
    layerId: "crash_restart",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  concurrencyLinearizability: Object.freeze({
    kind: "layer_output",
    layerId: "concurrency_linearizability",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  schemaParserRobustness: Object.freeze({
    kind: "layer_output",
    layerId: "schema_parser_robustness",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  independentFrozenHashReview: Object.freeze({
    kind: "layer_output",
    layerId: "independent_frozen_hash_review",
    outputIndex: 0,
    outputCardinality: 1,
  }),
  antiWeakening: Object.freeze({
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  }),
  primaryJudge: Object.freeze({
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  }),
  independentJudge: Object.freeze({
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  }),
  rawEvidenceManifest: Object.freeze({
    kind: "controller_only",
    layerId: null,
    outputIndex: null,
    outputCardinality: 0,
  }),
});

const ROLE_NAMES = Object.freeze([
  "implementer",
  "certifier",
  "coordinator",
  "primaryJudge",
  "independentJudge",
  "collector",
]);

const IDENTITY_ROLE_VALUES = Object.freeze({
  implementer: "implementer",
  certifier: "certifier",
  coordinator: "coordinator",
  primaryJudge: "primary_judge",
  independentJudge: "independent_judge",
  collector: "collector",
});

const LEGACY_REFUSALS = Object.freeze({
  "pikiio-quality-gauntlet-v3": "QUALITY_POLICY_V3_REFUSED",
  "pikiio-quality-gauntlet-v2": "QUALITY_POLICY_V2_REFUSED",
  "pikiio-phase-quality-plan-v3": "QUALITY_PLAN_V3_REFUSED",
  "pikiio-phase-quality-plan-v2": "QUALITY_PLAN_V2_REFUSED",
  "pikiio-population-floor-v2": "POPULATION_FLOOR_V2_REFUSED",
  "pikiio-population-floor-v1": "POPULATION_FLOOR_V1_REFUSED",
  "pikiio-quality-execution-observation-v2":
    "EXECUTION_OBSERVATION_V2_REFUSED",
  "pikiio-quality-layer-pass-receipt-v1": "LAYER_PASS_V1_REFUSED",
  "pikiio-quality-gauntlet-receipt-v6": "QUALITY_RECEIPT_V6_REFUSED",
  "pikiio-quality-gauntlet-receipt-v5": "QUALITY_RECEIPT_V5_REFUSED",
  "pikiio-phase-candidate-quality-receipt-v2":
    "CANDIDATE_RECEIPT_V2_REFUSED",
  "pikiio-phase-candidate-quality-receipt-v1":
    "CANDIDATE_RECEIPT_V1_REFUSED",
  "pikiio-phase-attestation-body-v2": "ATTESTATION_BODY_V2_REFUSED",
  "pikiio-phase-attestation-body-v1": "ATTESTATION_BODY_V1_REFUSED",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PHASE_PATTERN = /^(?:GOV|TRUTH|ACTION)-[0-9]{2}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_ARRAY_ITEMS = 10000;
const MAX_STRING_BYTES = 8192;
const MAX_GRAPH_DEPTH = 128;
const MAX_GRAPH_NODES = 50000;
const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const DIAGNOSTIC_TIMESTAMP_KEYS = new Set([
  "capturedAt",
  "startedAt",
  "finishedAt",
  "recordedAt",
  "observedAt",
]);

const FROZEN_REVIEW_ROOT_KEYS = Object.freeze([
  "schema",
  "authorizing",
  "reviewId",
  "phaseId",
  "candidateCommit",
  "candidateTree",
  "policySha256",
  "qualityPlanSha256",
  "registrySha256",
  "implementer",
  "certifier",
  "coordinator",
  "reviewedManifest",
  "findings",
  "closureReceipts",
  "certifierRuns",
  "coordinatorRerun",
  "postReviewManifest",
  "changedByteCount",
  "unresolvedBySeverity",
  "status",
  "recordedAt",
  "priorReviewReceiptHash",
  "receiptHash",
]);

const QUALITY_RECEIPT_ROOT_KEYS = Object.freeze([
  "schema",
  "authorizing",
  "recordedAt",
  "artifactPolicySha256",
  "ledgerBinding",
  "phaseBinding",
  "identities",
  "thresholds",
  "layerResults",
  "coverage",
  "mutation",
  "executionMatrix",
  "operationalIntegrity",
  "crashRestart",
  "concurrencyLinearizability",
  "schemaParserRobustness",
  "independentFrozenHashReview",
  "antiWeakening",
  "primaryJudge",
  "independentJudge",
  "rawEvidenceManifest",
  "specializedArtifactProvenance",
  "receiptHash",
]);

const CANDIDATE_RECEIPT_ROOT_KEYS = Object.freeze([
  "schema",
  "authorizing",
  "phaseId",
  "registryRevision",
  "registrySha256",
  "ledgerRevision",
  "ledgerSha256",
  "qualityPolicySha256",
  "qualityPlanSha256",
  "populationFloorSha256",
  "artifactPolicySha256",
  "scopeBaseCommit",
  "candidateCommit",
  "candidateTree",
  "observedAt",
  "status",
  "previousReceiptHash",
  "controller",
  "collector",
  "qualityReceiptHash",
  "frozenReviewReceiptHash",
  "layerReceiptHashes",
  "rawEvidenceManifestSha256",
  "authorityBaselineCommit",
  "authorityBaselineSnapshotHash",
  "authoritySnapshot",
  "changedPathsManifest",
  "changedPathCoverage",
  "assertions",
  "rawArtifact",
  "receiptHash",
]);

const ATTESTATION_BODY_ROOT_KEYS = Object.freeze([
  "schema",
  "authorizing",
  "phaseId",
  "issuerRegistrySha256",
  "ledgerRevision",
  "ledgerSha256",
  "phaseProofRegistrySha256",
  "qualityPolicySha256",
  "qualityPlanSha256",
  "populationFloorSha256",
  "artifactPolicySha256",
  "candidateCommit",
  "candidateTree",
  "sourceManifestSha256",
  "strictQualityReceiptHash",
  "candidateReceiptHash",
  "frozenReviewReceiptHash",
  "commandPlanHash",
  "evidenceManifestSha256",
  "judgeReceiptHashes",
  "rolePrincipalHashes",
  "phaseReceiptHashes",
  "artifacts",
  "productionAuthority",
  "bodySha256",
]);

const ATTESTATION_EVIDENCE_CONTEXT_KEYS = Object.freeze([
  "issuerRegistrySha256",
  "sourceManifestSha256",
  "rehearsalReceiptHash",
  "changeReceiptHash",
  "promotionReceiptHash",
]);

class QualityContractV4Error extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "QualityContractV4Error";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new QualityContractV4Error(code, message, details);
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function refuseProxy(value, label = "value") {
  if (isProxy(value)) { // QUALITY_V4_MUTATION_ANCHOR_PROXY_REFUSAL
    fail("PROXY_REFUSED", `${label} cannot be a Proxy`);
  }
}

function isPlainObject(value) {
  refuseProxy(value);
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertPlainGraph(
  value,
  label = "value",
  state = { seen: new Set(), active: new Set(), nodes: 0 },
  depth = 0,
) {
  refuseProxy(value, label); // QUALITY_V4_MUTATION_ANCHOR_RECURSIVE_PROXY_GUARD
  if (depth > MAX_GRAPH_DEPTH) { // QUALITY_V3_MUTATION_ANCHOR_GRAPH_DEPTH
    fail(
      "GRAPH_DEPTH_LIMIT_EXCEEDED",
      `${label} exceeds the maximum canonical graph depth`,
      { maximumDepth: MAX_GRAPH_DEPTH },
    );
  }
  state.nodes += 1;
  if (state.nodes > MAX_GRAPH_NODES) {
    fail(
      "GRAPH_NODE_LIMIT_EXCEEDED",
      `${label} exceeds the maximum canonical graph node count`,
      { maximumNodes: MAX_GRAPH_NODES },
    );
  }
  if (value === null) return;
  if (typeof value === "string") {
    if (
      value.includes("\u0000") ||
      Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES
    ) {
      fail("INVALID_STRING", `${label} is not a bounded string`);
    }
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value === "undefined") {
    fail("UNDEFINED_VALUE_REFUSED", `${label} is undefined`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("INVALID_NUMBER", `${label} is not a canonical finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    fail("NON_JSON_VALUE", `${label} is not canonical JSON data`);
  }
  if (state.active.has(value)) fail("CYCLIC_VALUE", `${label} is cyclic`);
  if (state.seen.has(value)) {
    fail("SHARED_REFERENCE_REFUSED", `${label} reuses an object reference`);
  }
  state.seen.add(value);
  state.active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("INVALID_PROTOTYPE", `${label} must have Array.prototype`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      fail("SYMBOL_FIELD_REFUSED", `${label} contains a symbol field`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      value.length > MAX_ARRAY_ITEMS ||
      ownKeys.length !== value.length + 1 ||
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      lengthDescriptor.enumerable !== false
    ) {
      fail("INVALID_ARRAY", `${label} is not a dense bounded array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        fail("SPARSE_ARRAY", `${label} contains a sparse element`);
      }
      if (
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        fail("ACCESSOR_FIELD_REFUSED", `${label}[${index}] is not a data field`);
      }
      assertPlainGraph(
        descriptor.value,
        `${label}[${index}]`,
        state,
        depth + 1,
      );
    }
  } else {
    if (!isPlainObject(value)) {
      fail("INVALID_PROTOTYPE", `${label} must have Object.prototype`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      fail("SYMBOL_FIELD_REFUSED", `${label} contains a symbol field`);
    }
    for (const key of ownKeys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        fail("PROTOTYPE_POLLUTION_KEY_REFUSED", `${label}.${key} is forbidden`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function"
      ) {
        fail("ACCESSOR_FIELD_REFUSED", `${label}.${key} is an accessor`);
      }
      if (descriptor.enumerable !== true) {
        fail(
          "NON_ENUMERABLE_FIELD_REFUSED",
          `${label}.${key} is not enumerable`,
        );
      }
      assertPlainGraph(
        descriptor.value,
        `${label}.${key}`,
        state,
        depth + 1,
      );
    }
  }
  state.active.delete(value);
}

function stableValueUnchecked(value) {
  if (Array.isArray(value)) return value.map(stableValueUnchecked);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, stableValueUnchecked(value[key])]),
  );
}

function stableJson(value) {
  assertPlainGraph(value);
  const serialized = JSON.stringify(stableValueUnchecked(value));
  if (typeof serialized !== "string") {
    fail("NON_CANONICAL_JSON", "value cannot be serialized");
  }
  return serialized;
}

function sha256(value) {
  refuseProxy(value, "sha256 input"); // QUALITY_V4_MUTATION_ANCHOR_SHA256_PROXY_GUARD
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashWithoutField(value, field) {
  refuseProxy(field, "hashWithoutField field");
  requireString(
    field,
    "hashWithoutField field",
  ); // QUALITY_V4_MUTATION_ANCHOR_HASH_FIELD_PROXY_GUARD
  assertPlainGraph(
    value,
    "hashWithoutField input",
  ); // QUALITY_V4_MUTATION_ANCHOR_HASH_WITHOUT_FIELD_PROXY_GUARD
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(copy));
}

function semanticValueUnchecked(value) {
  if (Array.isArray(value)) return value.map(semanticValueUnchecked);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !DIAGNOSTIC_TIMESTAMP_KEYS.has(key))
      .sort(compareCodeUnits)
      .map((key) => [key, semanticValueUnchecked(value[key])]),
  );
}

function semanticValue(value) {
  assertPlainGraph(value);
  return semanticValueUnchecked(value);
}

function semanticHashWithoutField(value, field) {
  refuseProxy(field, "semanticHashWithoutField field");
  requireString(
    field,
    "semanticHashWithoutField field",
  ); // QUALITY_V4_MUTATION_ANCHOR_SEMANTIC_HASH_FIELD_PROXY_GUARD
  assertPlainGraph(
    value,
    "semanticHashWithoutField input",
  ); // QUALITY_V4_MUTATION_ANCHOR_SEMANTIC_HASH_PROXY_GUARD
  const copy = { ...value };
  delete copy[field];
  return sha256(stableJson(semanticValue(copy)));
}

function layerSemanticHash(value) {
  assertPlainGraph(
    value,
    "layerSemanticHash input",
  ); // QUALITY_V4_MUTATION_ANCHOR_LAYER_HASH_PROXY_GUARD
  const copy = { ...value };
  delete copy.receiptHash;
  return semanticHashWithoutField(copy, "semanticSha256");
}

function cloneUnchecked(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneUnchecked(entry));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, cloneUnchecked(value[key])]),
    );
  }
  return value;
}

function clone(value) {
  assertPlainGraph(value);
  return cloneUnchecked(value);
}

function deepFreeze(value) {
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (
      !current ||
      typeof current !== "object" ||
      seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    Object.freeze(current);
    for (const child of Object.values(current)) stack.push(child);
  }
  return value;
}

function exactKeys(value, keys, label, { ordered = false } = {}) {
  assertPlainGraph(value, label);
  if (!isPlainObject(value)) {
    fail("INVALID_OBJECT", `${label} must be a plain object`);
  }
  const observed = Object.keys(value);
  const matches = ordered
    ? observed.length === keys.length &&
      observed.every((key, index) => key === keys[index])
    : observed.length === keys.length &&
      [...observed]
        .sort(compareCodeUnits)
        .every(
          (key, index) =>
            key === [...keys].sort(compareCodeUnits)[index],
        );
  if (!matches) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`, {
      expected: keys,
      observed,
      ordered,
    });
  }
}

function shallowRootKeys(value, label) {
  refuseProxy(
    value,
    label,
  ); // QUALITY_V4_MUTATION_ANCHOR_SHALLOW_ROOT_PROXY_GUARD
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail("INVALID_OBJECT", `${label} must be a plain object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_PROTOTYPE", `${label} must have Object.prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("SYMBOL_FIELD_REFUSED", `${label} contains a symbol field`);
  }
  const names = Object.getOwnPropertyNames(value);
  for (const key of names) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      fail("PROTOTYPE_POLLUTION_KEY_REFUSED", `${label}.${key} is forbidden`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) {
      fail("ACCESSOR_FIELD_REFUSED", `${label}.${key} is an accessor`);
    }
    if (descriptor.enumerable !== true) {
      fail(
        "NON_ENUMERABLE_FIELD_REFUSED",
        `${label}.${key} must be an enumerable canonical field`,
      );
    }
  }
  return names;
}

function keySetsMatch(observed, expected) {
  return (
    observed.length === expected.length &&
    [...observed]
      .sort(compareCodeUnits)
      .every(
        (key, index) =>
          key === [...expected].sort(compareCodeUnits)[index],
      )
  );
}

function refuseObservedLegacySchema(observed, label) {
  const code = Object.hasOwn(LEGACY_REFUSALS, observed)
    ? LEGACY_REFUSALS[observed]
    : null;
  if (code !== null) { // QUALITY_V3_MUTATION_ANCHOR_LEGACY_REFUSAL
    fail(code, `${label} uses a refused legacy schema`);
  }
}

function admitBuilderSchema(fields, schema, label) {
  assertPlainGraph(fields, label);
  if (!isPlainObject(fields)) {
    fail("INVALID_OBJECT", `${label} must be a plain object`);
  }
  if (!Object.hasOwn(fields, "schema")) return;
  refuseObservedLegacySchema(fields.schema, label);
  if (fields.schema !== schema) {
    fail("INVALID_SCHEMA", `${label} schema must be ${schema}`, {
      expected: schema,
      observed: fields.schema,
    });
  }
}

function preflightDormantAuthorityRoot(
  value,
  {
    keys,
    schema,
    label,
    authorityLabel,
    builderHashField = null,
  },
) {
  const observed = shallowRootKeys(value, label);
  if (Object.hasOwn(value, "schema")) {
    refuseObservedLegacySchema(value.schema, label);
  }
  const effective = [...observed];
  if (builderHashField !== null) {
    if (!effective.includes("schema")) effective.push("schema");
    if (!effective.includes(builderHashField)) effective.push(builderHashField);
  }
  if (!keySetsMatch(effective, keys)) {
    fail("UNEXPECTED_FIELDS", `${label} must contain only its exact fields`, {
      expected: keys,
      observed,
      ordered: false,
    });
  }
  if (Object.hasOwn(value, "schema")) {
    requireSchema(value, schema, label);
  } else if (builderHashField === null) {
    fail("INVALID_SCHEMA", `${label} schema must be ${schema}`, {
      expected: schema,
      observed: undefined,
    });
  }
  requireBoolean(value.authorizing, `${label}.authorizing`);
  if (value.authorizing === true) { // QUALITY_V3_MUTATION_ANCHOR_AUTHORITY_PREFLIGHT
    fail(
      "QUALITY_CONTRACT_AUTHORITY_UNCOMMISSIONED",
      `the dormant quality contract cannot authorize ${authorityLabel}`,
    );
  }
}

function requireSchema(value, expected, label) {
  if (!isPlainObject(value)) {
    fail("INVALID_OBJECT", `${label} must be a plain object`);
  }
  const observed = value.schema;
  refuseObservedLegacySchema(observed, label);
  if (observed !== expected) {
    fail("INVALID_SCHEMA", `${label} schema must be ${expected}`, {
      expected,
      observed,
    });
  }
}

function refuseLegacySchema(value, label) {
  assertPlainGraph(value, label);
  if (isPlainObject(value)) {
    refuseObservedLegacySchema(value.schema, label);
  }
}

function requireString(value, label, { pattern = null, allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES ||
    (pattern && !pattern.test(value))
  ) {
    fail("INVALID_STRING", `${label} is invalid`);
  }
}

function requireSha(value, label) {
  requireString(value, label, { pattern: SHA256_PATTERN });
}

function requireCommit(value, label) {
  requireString(value, label, { pattern: COMMIT_PATTERN });
}

function requirePhase(value, label) {
  requireString(value, label, { pattern: PHASE_PATTERN });
}

function requireTimestamp(value, label) {
  requireString(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(
      value,
    );
  if (match === null) {
    fail("INVALID_TIMESTAMP", `${label} must be an RFC3339 UTC timestamp`);
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText,
  ] = match;
  const expected = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText),
    millisecond:
      millisecondText === undefined ? 0 : Number(millisecondText),
  };
  const parsed = Date.parse(value);
  const instant = Number.isFinite(parsed) ? new Date(parsed) : null;
  const calendarComponentsMismatch =
    instant === null ||
    instant.getUTCFullYear() !== expected.year ||
    instant.getUTCMonth() + 1 !== expected.month ||
    instant.getUTCDate() !== expected.day ||
    instant.getUTCHours() !== expected.hour ||
    instant.getUTCMinutes() !== expected.minute ||
    instant.getUTCSeconds() !== expected.second ||
    instant.getUTCMilliseconds() !== expected.millisecond;
  if (calendarComponentsMismatch) { // QUALITY_V4_MUTATION_ANCHOR_CALENDAR_TIMESTAMP
    fail(
      "INVALID_TIMESTAMP",
      `${label} must be a calendar-exact RFC3339 UTC timestamp`,
    );
  }
}

function requireCounter(value, label, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (positive && value === 0)
  ) {
    fail("INVALID_COUNTER", `${label} must be a safe ${positive ? "positive" : "non-negative"} integer`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail("INVALID_BOOLEAN", `${label} must be boolean`);
}

function requireSortedUniqueStrings(
  value,
  label,
  { allowEmpty = false, safePaths = false } = {},
) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length ||
    stableJson(value) !== stableJson([...value].sort(compareCodeUnits))
  ) {
    fail("INVALID_STRING_SET", `${label} must be a sorted unique string set`);
  }
  if (
    safePaths &&
    value.some(
      (entry) =>
        path.posix.isAbsolute(entry) ||
        entry.includes("\\") ||
        entry.split("/").includes(".."),
    )
  ) {
    fail("UNSAFE_PATH", `${label} contains an unsafe path`);
  }
}

function requireSelfHash(value, field, label, { semantic = false } = {}) {
  requireSha(value[field], `${label}.${field}`);
  const expected = semantic
    ? semanticHashWithoutField(value, field)
    : hashWithoutField(value, field);
  if (value[field] !== expected) {
    fail("HASH_MISMATCH", `${label}.${field} does not match its contents`);
  }
}

function seal(fields, schema, hashField, validator, options = {}) {
  admitBuilderSchema(fields, schema, `${schema} builder input`);
  for (const timestamp of options.timestamps || []) {
    const observed = timestamp.path.reduce(
      (cursor, key) =>
        cursor !== null && typeof cursor === "object"
          ? cursor[key]
          : undefined,
      fields,
    );
    requireTimestamp(observed, timestamp.label);
  }
  const value = { ...clone(fields), schema };
  delete value[hashField];
  value[hashField] = options.semantic
    ? semanticHashWithoutField(value, hashField)
    : hashWithoutField(value, hashField);
  validator(value, options.context);
  return deepFreeze(clone(value));
}

function validateArtifactRef(value, label = "artifact reference") {
  refuseProxy(label, "artifact reference label");
  requireString(
    label,
    "artifact reference label",
  ); // QUALITY_V4_MUTATION_ANCHOR_ARTIFACT_LABEL_PROXY_GUARD
  exactKeys(
    value,
    ["schema", "address", "sha256", "byteLength", "mediaType"],
    label,
  );
  requireSchema(value, SCHEMAS.artifactRef, label);
  requireSha(value.sha256, `${label}.sha256`);
  if (value.address !== `sha256:${value.sha256}`) {
    fail("ARTIFACT_ADDRESS_MISMATCH", `${label}.address is not content addressed`);
  }
  requireCounter(value.byteLength, `${label}.byteLength`, { positive: true });
  requireString(value.mediaType, `${label}.mediaType`, {
    pattern: /^[a-z0-9][a-z0-9.+-]+\/[a-z0-9][a-z0-9.+-]+$/,
  });
  return deepFreeze(clone(value));
}

function validateAuthorityIdentity(value, expectedRole = null, label = "identity") {
  refuseProxy(expectedRole, "identity expectedRole");
  if (expectedRole !== null) {
    requireString(expectedRole, "identity expectedRole", {
      pattern: SAFE_ID_PATTERN,
    });
  } // QUALITY_V4_MUTATION_ANCHOR_IDENTITY_EXPECTED_ROLE_PROXY_GUARD
  refuseProxy(label, "identity label");
  requireString(
    label,
    "identity label",
  ); // QUALITY_V4_MUTATION_ANCHOR_IDENTITY_LABEL_PROXY_GUARD
  exactKeys(
    value,
    [
      "schema",
      "role",
      "issuer",
      "subject",
      "credentialKind",
      "credentialSha256",
      "authorizing",
      "principalSha256",
    ],
    label,
  );
  requireSchema(value, SCHEMAS.authorityIdentity, label);
  requireString(value.role, `${label}.role`, { pattern: SAFE_ID_PATTERN });
  if (expectedRole !== null && value.role !== expectedRole) {
    fail("IDENTITY_ROLE_MISMATCH", `${label}.role must be ${expectedRole}`);
  }
  requireString(value.issuer, `${label}.issuer`, { pattern: SAFE_ID_PATTERN });
  requireString(value.subject, `${label}.subject`, { pattern: SAFE_ID_PATTERN });
  if (
    ![
      "ed25519_public_key",
      "github_oidc_receipt",
      "controller_task_receipt",
    ].includes(value.credentialKind)
  ) {
    fail("IDENTITY_CREDENTIAL_INVALID", `${label}.credentialKind is invalid`);
  }
  requireSha(value.credentialSha256, `${label}.credentialSha256`);
  requireBoolean(value.authorizing, `${label}.authorizing`);
  if (
    value.credentialKind === "controller_task_receipt" &&
    value.authorizing !== false
  ) {
    fail(
      "LOCAL_IDENTITY_CANNOT_AUTHORIZE",
      "controller_task_receipt identities must be non-authorizing",
    );
  }
  const expectedPrincipal = sha256(
    stableJson({
      issuer: value.issuer,
      subject: value.subject,
      credentialKind: value.credentialKind,
      credentialSha256: value.credentialSha256,
      authorizing: value.authorizing,
    }),
  );
  requireSha(value.principalSha256, `${label}.principalSha256`);
  if (value.principalSha256 !== expectedPrincipal) {
    fail("IDENTITY_HASH_MISMATCH", `${label}.principalSha256 is invalid`);
  }
  return deepFreeze(clone(value));
}

function validateIdentitySet(value, { authorizing = true } = {}) {
  exactKeys(value, ROLE_NAMES, "identities");
  const principals = [];
  for (const key of ROLE_NAMES) {
    const identity = validateAuthorityIdentity(
      value[key],
      IDENTITY_ROLE_VALUES[key],
      `identities.${key}`,
    );
    if (authorizing && identity.authorizing !== true) {
      fail(
        "NON_AUTHORIZING_IDENTITY_REFUSED",
        `identities.${key} cannot satisfy an authorizing receipt`,
      );
    }
    if (!authorizing && identity.authorizing !== false) {
      fail(
        "UNAUTHENTICATED_IDENTITY_REFUSED",
        `identities.${key} cannot claim authority in a dormant receipt`,
      );
    }
    principals.push(identity.principalSha256);
  }
  if (new Set(principals).size !== principals.length) {
    fail(
      "IDENTITY_COLLISION",
      "all six authorizing principal hashes must be pairwise unequal",
    );
  }
  return deepFreeze(clone(value));
}

function validateLayerId(value, label) {
  if (!EVIDENCE_LAYER_IDS.includes(value)) {
    fail("INVALID_LAYER_ID", `${label} is not a supported evidence layer`);
  }
}

function validateNotApplicableAuthorization(
  layerId,
  reasonCode,
  allowedReasons,
) {
  if (!CONDITIONAL_LAYER_IDS.includes(layerId)) { // QUALITY_V3_MUTATION_ANCHOR_NA_RESTRICTION
    fail(
      "NOT_APPLICABLE_LOCAL_LAYER_REFUSED",
      `${layerId} is a required local safety layer`,
    );
  }
  if (!allowedReasons.includes(reasonCode)) {
    fail("NOT_APPLICABLE_REASON_REFUSED", `${layerId} reason is not allowed`);
  }
}

function validateNotApplicableResult(value) {
  exactKeys(
    value,
    [
      "schema",
      "layerId",
      "status",
      "reasonCode",
      "policyRuleId",
      "policyRuleSha256",
      "policySha256",
      "qualityPlanSha256",
      "observedAt",
      "receiptHash",
    ],
    "not-applicable result",
  );
  requireSchema(value, SCHEMAS.notApplicable, "not-applicable result");
  validateLayerId(value.layerId, "not-applicable result.layerId");
  if (value.status !== "not_applicable") {
    fail("INVALID_DISPOSITION", "not-applicable status is invalid");
  }
  validateNotApplicableAuthorization(
    value.layerId,
    value.reasonCode,
    CONDITIONAL_REASON_CODES[value.layerId] || [],
  );
  requireString(value.policyRuleId, "not-applicable result.policyRuleId", {
    pattern: SAFE_ID_PATTERN,
  });
  for (const key of [
    "policyRuleSha256",
    "policySha256",
    "qualityPlanSha256",
  ]) {
    requireSha(value[key], `not-applicable result.${key}`);
  }
  requireTimestamp(value.observedAt, "not-applicable result.observedAt");
  requireSelfHash(value, "receiptHash", "not-applicable result");
  return deepFreeze(clone(value));
}

function validatePopulation(value, label = "population") {
  exactKeys(
    value,
    [
      "cases",
      "assertions",
      "passed",
      "failed",
      "cancelled",
      "skipped",
      "todo",
      "warnings",
    ],
    label,
  );
  for (const key of Object.keys(value)) {
    requireCounter(value[key], `${label}.${key}`);
  }
  if (value.cancelled !== 0) {
    fail(
      "EXECUTION_CANCELLED_REFUSED",
      `${label}.cancelled must remain zero`,
    );
  }
  if (
    value.cases !==
    value.passed +
      value.failed +
      value.cancelled +
      value.skipped +
      value.todo
  ) {
    fail("POPULATION_MISMATCH", `${label}.cases does not reconcile`);
  }
}

function validateRuntime(value) {
  exactKeys(
    value,
    [
      "platform",
      "arch",
      "executableSha256",
      "nodeVersion",
      "nodeSha256",
      "npmVersion",
      "npmCliSha256",
      "toolchainSha256",
      "sandboxIdentitySha256",
    ],
    "execution runtime",
  );
  for (const key of ["platform", "arch", "nodeVersion", "npmVersion"]) {
    requireString(value[key], `execution runtime.${key}`, {
      pattern: SAFE_ID_PATTERN,
    });
  }
  for (const key of [
    "executableSha256",
    "nodeSha256",
    "npmCliSha256",
    "toolchainSha256",
    "sandboxIdentitySha256",
  ]) {
    requireSha(value[key], `execution runtime.${key}`);
  }
}

function validateExecutionObservationV3(value) {
  refuseLegacySchema(value, "execution observation");
  exactKeys(
    value,
    [
      "schema",
      "executionId",
      "layerId",
      "checkId",
      "definitionSha256",
      "repeat",
      "seed",
      "timeZone",
      "orderId",
      "fixtureManifestSha256",
      "runtime",
      "process",
      "resources",
      "population",
      "stdoutArtifact",
      "stderrArtifact",
      "parsedOutputArtifact",
      "semanticSha256",
    ],
    "execution observation",
  );
  requireSchema(value, SCHEMAS.executionObservation, "execution observation");
  requireString(value.executionId, "execution observation.executionId", {
    pattern: SAFE_ID_PATTERN,
  });
  validateLayerId(value.layerId, "execution observation.layerId");
  requireString(value.checkId, "execution observation.checkId", {
    pattern: SAFE_ID_PATTERN,
  });
  requireSha(value.definitionSha256, "execution observation.definitionSha256");
  requireCounter(value.repeat, "execution observation.repeat", { positive: true });
  for (const key of ["seed", "timeZone", "orderId"]) {
    requireString(value[key], `execution observation.${key}`);
  }
  requireSha(
    value.fixtureManifestSha256,
    "execution observation.fixtureManifestSha256",
  );
  validateRuntime(value.runtime);
  exactKeys(
    value.process,
    [
      "startedAt",
      "finishedAt",
      "elapsedMs",
      "exitCode",
      "signal",
      "timedOut",
      "retryCount",
    ],
    "execution observation.process",
  );
  requireTimestamp(value.process.startedAt, "execution observation.process.startedAt");
  requireTimestamp(value.process.finishedAt, "execution observation.process.finishedAt");
  if (Date.parse(value.process.finishedAt) < Date.parse(value.process.startedAt)) {
    fail("TIME_ORDER_INVALID", "execution finished before it started");
  }
  requireCounter(value.process.elapsedMs, "execution observation.process.elapsedMs");
  if (
    value.process.exitCode !== null &&
    (!Number.isSafeInteger(value.process.exitCode) || value.process.exitCode < 0)
  ) {
    fail("INVALID_EXIT_CODE", "execution exitCode is invalid");
  }
  if (value.process.signal !== null) {
    requireString(value.process.signal, "execution observation.process.signal");
  }
  requireBoolean(value.process.timedOut, "execution observation.process.timedOut");
  requireCounter(value.process.retryCount, "execution observation.process.retryCount");
  exactKeys(
    value.resources,
    [
      "peakRssBytes",
      "userCpuMicros",
      "systemCpuMicros",
      "readBytes",
      "writeBytes",
      "maximumObservedProcessCount",
    ],
    "execution observation.resources",
  );
  for (const key of Object.keys(value.resources)) {
    requireCounter(value.resources[key], `execution observation.resources.${key}`);
  }
  validatePopulation(value.population, "execution observation.population");
  validateArtifactRef(value.stdoutArtifact, "execution observation.stdoutArtifact");
  validateArtifactRef(value.stderrArtifact, "execution observation.stderrArtifact");
  validateArtifactRef(
    value.parsedOutputArtifact,
    "execution observation.parsedOutputArtifact",
  );
  requireSelfHash(value, "semanticSha256", "execution observation", {
    semantic: true,
  });
  return deepFreeze(clone(value));
}

function validateVerifierOutput(value) {
  exactKeys(
    value,
    [
      "schema",
      "layerId",
      "checkId",
      "ok",
      "cases",
      "assertions",
      "passed",
      "failures",
      "skips",
      "warnings",
      "timeoutCount",
      "signalCount",
      "retryCount",
      "executionObservationSha256",
      "rawResultArtifact",
      "resultHash",
    ],
    "verifier output",
  );
  requireSchema(value, SCHEMAS.verifierOutput, "verifier output");
  if (
    ![
      "focused_verifier",
      "neighbor_verifier",
      "broad_verifier",
      "production_shaped_rehearsal",
    ].includes(value.layerId)
  ) {
    fail("VERIFIER_LAYER_INVALID", "verifier output layer is invalid");
  }
  requireString(value.checkId, "verifier output.checkId", {
    pattern: SAFE_ID_PATTERN,
  });
  if (value.ok !== true) fail("VERIFIER_FAILED", "verifier output must be ok");
  for (const key of ["cases", "assertions", "passed"]) {
    requireCounter(value[key], `verifier output.${key}`, { positive: true });
  }
  if (value.cases !== value.passed) {
    fail("VERIFIER_POPULATION_MISMATCH", "verifier cases must all pass");
  }
  for (const key of ["failures", "skips", "warnings"]) {
    requireSortedUniqueStrings(value[key], `verifier output.${key}`, {
      allowEmpty: true,
    });
    if (value[key].length !== 0) {
      fail("VERIFIER_ZERO_FAILURE_VIOLATION", `verifier output.${key} is nonzero`);
    }
  }
  for (const key of ["timeoutCount", "signalCount", "retryCount"]) {
    requireCounter(value[key], `verifier output.${key}`);
    if (value[key] !== 0) {
      fail("VERIFIER_ZERO_FAILURE_VIOLATION", `verifier output.${key} is nonzero`);
    }
  }
  requireSha(
    value.executionObservationSha256,
    "verifier output.executionObservationSha256",
  );
  validateArtifactRef(value.rawResultArtifact, "verifier output.rawResultArtifact");
  requireSelfHash(value, "resultHash", "verifier output", { semantic: true });
  return deepFreeze(clone(value));
}

function consumeLayerArtifactAddresses(value, claims) {
  const uses = [
    ...value.executions.map((artifact, index) => ({
      artifact,
      role: `executions[${index}]`,
    })),
    {
      artifact: value.rawPopulationArtifact,
      role: "rawPopulationArtifact",
    },
    ...value.outputArtifacts.map((artifact, index) => ({
      artifact,
      role: `outputArtifacts[${index}]`,
    })),
  ];
  for (const use of uses) {
    const prior = claims.get(use.artifact.address);
    if (prior !== undefined) { // QUALITY_V3_MUTATION_ANCHOR_ARTIFACT_CONSUMPTION
      fail(
        "LAYER_ARTIFACT_ADDRESS_COLLISION",
        "quality-layer artifacts must be single-use across execution, population, and output roles",
        {
          address: use.artifact.address,
          firstLayerId: prior.layerId,
          firstRole: prior.role,
          secondLayerId: value.layerId,
          secondRole: use.role,
        },
      );
    }
    claims.set(use.artifact.address, {
      layerId: value.layerId,
      role: use.role,
    });
  }
}

function validateLayerPassV2(value) {
  refuseLegacySchema(value, "layer pass receipt");
  exactKeys(
    value,
    [
      "schema",
      "layerId",
      "status",
      "checkIds",
      "definitionManifestSha256",
      "executions",
      "rawPopulationArtifact",
      "outputArtifacts",
      "minimumCasesObserved",
      "minimumAssertionsObserved",
      ...EXECUTION_ZERO_FAILURE_KEYS,
      "semanticSha256",
      "receiptHash",
    ],
    "layer pass receipt",
  );
  requireSchema(value, SCHEMAS.layerPass, "layer pass receipt");
  validateLayerId(value.layerId, "layer pass receipt.layerId");
  if (value.status !== "passed") fail("LAYER_NOT_PASSED", "layer status must pass");
  requireSortedUniqueStrings(value.checkIds, "layer pass receipt.checkIds");
  requireSha(
    value.definitionManifestSha256,
    "layer pass receipt.definitionManifestSha256",
  );
  if (!Array.isArray(value.executions) || value.executions.length === 0) {
    fail("EXECUTION_POPULATION_EMPTY", "layer must retain execution artifacts");
  }
  value.executions.forEach((entry, index) =>
    validateArtifactRef(entry, `layer pass receipt.executions[${index}]`),
  );
  validateArtifactRef(
    value.rawPopulationArtifact,
    "layer pass receipt.rawPopulationArtifact",
  );
  if (!Array.isArray(value.outputArtifacts)) {
    fail("OUTPUT_ARTIFACTS_INVALID", "outputArtifacts must be an array");
  }
  value.outputArtifacts.forEach((entry, index) =>
    validateArtifactRef(entry, `layer pass receipt.outputArtifacts[${index}]`),
  );
  consumeLayerArtifactAddresses(value, new Map());
  requireCounter(
    value.minimumCasesObserved,
    "layer pass receipt.minimumCasesObserved",
    { positive: true },
  );
  requireCounter(
    value.minimumAssertionsObserved,
    "layer pass receipt.minimumAssertionsObserved",
    { positive: true },
  );
  for (const key of EXECUTION_ZERO_FAILURE_KEYS) {
    requireCounter(value[key], `layer pass receipt.${key}`);
    if (value[key] !== 0) {
      fail("LAYER_ZERO_FAILURE_VIOLATION", `${key} must remain zero`);
    }
  }
  requireSha(value.semanticSha256, "layer pass receipt.semanticSha256");
  if (value.semanticSha256 !== layerSemanticHash(value)) {
    fail(
      "HASH_MISMATCH",
      "layer pass receipt.semanticSha256 does not match its contents",
    );
  }
  requireSelfHash(value, "receiptHash", "layer pass receipt");
  return deepFreeze(clone(value));
}

function validateCoverageMetric(value, label) {
  exactKeys(value, ["covered", "total"], label);
  requireCounter(value.covered, `${label}.covered`);
  requireCounter(value.total, `${label}.total`, { positive: true });
  if (value.covered > value.total) {
    fail("COVERAGE_NUMERATOR_INVALID", `${label}.covered exceeds total`);
  }
}

function validateCoverageInputManifest(value) {
  exactKeys(
    value,
    [
      "schema",
      "reducerSha256",
      "orderedInputs",
      "multiplicitySha256",
      "manifestHash",
    ],
    "coverage input manifest",
  );
  requireSchema(
    value,
    SCHEMAS.coverageInputManifest,
    "coverage input manifest",
  );
  requireSha(value.reducerSha256, "coverage input manifest.reducerSha256");
  if (!Array.isArray(value.orderedInputs) || value.orderedInputs.length === 0) {
    fail("COVERAGE_INPUTS_EMPTY", "coverage orderedInputs must be non-empty");
  }
  const multiplicity = new Map();
  let prior = null;
  value.orderedInputs.forEach((entry, index) => {
    exactKeys(
      entry,
      ["ordinal", "semanticPayloadSha256", "occurrence", "artifact"],
      `coverage orderedInputs[${index}]`,
    );
    if (entry.ordinal !== index + 1) {
      fail("COVERAGE_ORDER_INVALID", "coverage ordinals must be contiguous");
    }
    requireSha(
      entry.semanticPayloadSha256,
      `coverage orderedInputs[${index}].semanticPayloadSha256`,
    );
    if (prior !== null && prior > entry.semanticPayloadSha256) {
      fail(
        "COVERAGE_ORDER_INVALID",
        "coverage order must use semantic payload SHA, never filename",
      );
    }
    const expectedOccurrence =
      (multiplicity.get(entry.semanticPayloadSha256) || 0) + 1;
    if (entry.occurrence !== expectedOccurrence) {
      fail("COVERAGE_MULTIPLICITY_INVALID", "coverage occurrence is invalid");
    }
    multiplicity.set(entry.semanticPayloadSha256, expectedOccurrence);
    validateArtifactRef(entry.artifact, `coverage orderedInputs[${index}].artifact`);
    prior = entry.semanticPayloadSha256;
  });
  const expectedMultiplicity = sha256(
    stableJson(
      [...multiplicity.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([semanticPayloadSha256, count]) => ({
          semanticPayloadSha256,
          count,
        })),
    ),
  );
  if (value.multiplicitySha256 !== expectedMultiplicity) {
    fail("COVERAGE_MULTIPLICITY_MISMATCH", "coverage multiplicity hash is invalid");
  }
  requireSelfHash(value, "manifestHash", "coverage input manifest");
}

function validateCoverageProofV2(value) {
  exactKeys(
    value,
    [
      "schema",
      "inputManifest",
      "repeat",
      "files",
      "requiredFiles",
      "uncoveredRequiredFiles",
      "semanticSha256",
    ],
    "coverage proof",
  );
  requireSchema(value, SCHEMAS.coverageProof, "coverage proof");
  validateCoverageInputManifest(value.inputManifest);
  requireCounter(value.repeat, "coverage proof.repeat", { positive: true });
  requireSortedUniqueStrings(value.requiredFiles, "coverage proof.requiredFiles", {
    safePaths: true,
  });
  requireSortedUniqueStrings(
    value.uncoveredRequiredFiles,
    "coverage proof.uncoveredRequiredFiles",
    { allowEmpty: true, safePaths: true },
  );
  if (value.uncoveredRequiredFiles.length !== 0) {
    fail("UNCOVERED_REQUIRED_FILES", "coverage proof has uncovered required files");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    fail("COVERAGE_FILES_EMPTY", "coverage files must be non-empty");
  }
  const paths = [];
  value.files.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "path",
        "sourceSha256",
        "lines",
        "branches",
        "functions",
        "uncoveredRangesArtifact",
      ],
      `coverage proof.files[${index}]`,
    );
    requireString(entry.path, `coverage proof.files[${index}].path`);
    if (
      path.posix.isAbsolute(entry.path) ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..")
    ) {
      fail("UNSAFE_PATH", "coverage file path is unsafe");
    }
    paths.push(entry.path);
    requireSha(entry.sourceSha256, `coverage proof.files[${index}].sourceSha256`);
    validateCoverageMetric(entry.lines, `coverage proof.files[${index}].lines`);
    validateCoverageMetric(
      entry.branches,
      `coverage proof.files[${index}].branches`,
    );
    validateCoverageMetric(
      entry.functions,
      `coverage proof.files[${index}].functions`,
    );
    validateArtifactRef(
      entry.uncoveredRangesArtifact,
      `coverage proof.files[${index}].uncoveredRangesArtifact`,
    );
  });
  if (
    new Set(paths).size !== paths.length ||
    stableJson(paths) !== stableJson([...paths].sort(compareCodeUnits)) ||
    stableJson(paths) !== stableJson(value.requiredFiles)
  ) {
    fail("COVERAGE_FILE_SET_MISMATCH", "coverage file set is not exact");
  }
  requireSelfHash(value, "semanticSha256", "coverage proof", {
    semantic: true,
  });
  return deepFreeze(clone(value));
}

function validateOperationalManifestV2(value) {
  exactKeys(
    value,
    [
      "schema",
      "capturedAt",
      "gitHead",
      "gitTree",
      "indexSha256",
      "entries",
      "automationInputsArtifact",
      "dependencyManifestArtifact",
      "toolchainManifestArtifact",
      "manifestHash",
    ],
    "operational manifest",
  );
  requireSchema(value, SCHEMAS.operationalManifest, "operational manifest");
  requireTimestamp(value.capturedAt, "operational manifest.capturedAt");
  requireCommit(value.gitHead, "operational manifest.gitHead");
  requireCommit(value.gitTree, "operational manifest.gitTree");
  requireSha(value.indexSha256, "operational manifest.indexSha256");
  if (!Array.isArray(value.entries)) {
    fail("OPERATIONAL_ENTRIES_INVALID", "operational entries must be an array");
  }
  const paths = [];
  value.entries.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "path",
        "type",
        "mode",
        "byteLength",
        "contentSha256",
        "indexState",
        "worktreeState",
      ],
      `operational entries[${index}]`,
    );
    requireString(entry.path, `operational entries[${index}].path`);
    if (
      path.posix.isAbsolute(entry.path) ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..")
    ) {
      fail("UNSAFE_PATH", "operational manifest contains an unsafe path");
    }
    paths.push(entry.path);
    if (!["file", "directory"].includes(entry.type)) {
      fail("OPERATIONAL_TYPE_INVALID", "operational entry type is invalid");
    }
    requireString(entry.mode, `operational entries[${index}].mode`, {
      pattern: /^[0-7]{6}$/,
    });
    requireCounter(entry.byteLength, `operational entries[${index}].byteLength`);
    requireSha(entry.contentSha256, `operational entries[${index}].contentSha256`);
    for (const key of ["indexState", "worktreeState"]) {
      requireString(entry[key], `operational entries[${index}].${key}`, {
        pattern: SAFE_ID_PATTERN,
      });
    }
  });
  if (
    new Set(paths).size !== paths.length ||
    stableJson(paths) !== stableJson([...paths].sort(compareCodeUnits))
  ) {
    fail("OPERATIONAL_PATH_ORDER_INVALID", "operational paths must be sorted and unique");
  }
  for (const key of [
    "automationInputsArtifact",
    "dependencyManifestArtifact",
    "toolchainManifestArtifact",
  ]) {
    validateArtifactRef(value[key], `operational manifest.${key}`);
  }
  requireSelfHash(value, "manifestHash", "operational manifest", {
    semantic: true,
  });
  return deepFreeze(clone(value));
}

function validateCrashPopulation(value) {
  exactKeys(
    value,
    [
      "schema",
      "boundaryManifestSha256",
      "cases",
      "unrecoveredCount",
      "populationHash",
    ],
    "crash population",
  );
  requireSchema(value, SCHEMAS.crashPopulation, "crash population");
  requireSha(value.boundaryManifestSha256, "crash population.boundaryManifestSha256");
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    fail("CRASH_POPULATION_EMPTY", "crash cases must be non-empty");
  }
  const ids = [];
  value.cases.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "pointId",
        "position",
        "repeat",
        "preStateArtifact",
        "postCrashStateArtifact",
        "recoveryArtifact",
        "outcome",
        "failures",
      ],
      `crash cases[${index}]`,
    );
    requireString(entry.pointId, `crash cases[${index}].pointId`, {
      pattern: SAFE_ID_PATTERN,
    });
    ids.push(entry.pointId);
    if (!["before", "after"].includes(entry.position)) {
      fail("CRASH_POSITION_INVALID", "crash position is invalid");
    }
    requireCounter(entry.repeat, `crash cases[${index}].repeat`, { positive: true });
    for (const key of [
      "preStateArtifact",
      "postCrashStateArtifact",
      "recoveryArtifact",
    ]) {
      validateArtifactRef(entry[key], `crash cases[${index}].${key}`);
    }
    if (
      !["no_state", "resumed_idempotently", "typed_refusal"].includes(
        entry.outcome,
      )
    ) {
      fail("CRASH_OUTCOME_INVALID", "crash outcome is invalid");
    }
    requireSortedUniqueStrings(entry.failures, `crash cases[${index}].failures`, {
      allowEmpty: true,
    });
    if (entry.failures.length !== 0) {
      fail("CRASH_FAILURE", "crash case contains failures");
    }
  });
  if (new Set(ids).size !== ids.length) {
    fail("CRASH_POINT_DUPLICATE", "crash point IDs must be unique");
  }
  requireCounter(value.unrecoveredCount, "crash population.unrecoveredCount");
  if (value.unrecoveredCount !== 0) {
    fail("CRASH_RECOVERY_INCOMPLETE", "unrecovered crash points must be zero");
  }
  requireSelfHash(value, "populationHash", "crash population");
  return deepFreeze(clone(value));
}

function validateConcurrencyPopulation(value) {
  exactKeys(
    value,
    [
      "schema",
      "cases",
      "nonconvergentIdenticalCount",
      "acceptedDivergentCount",
      "staleOwnerWinCount",
      "populationHash",
    ],
    "concurrency population",
  );
  requireSchema(
    value,
    SCHEMAS.concurrencyPopulation,
    "concurrency population",
  );
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    fail("CONCURRENCY_POPULATION_EMPTY", "concurrency cases must be non-empty");
  }
  const ids = [];
  value.cases.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "caseId",
        "kind",
        "seed",
        "scheduleArtifact",
        "operationsArtifact",
        "acceptedOrderingArtifact",
        "outcome",
        "failures",
      ],
      `concurrency cases[${index}]`,
    );
    requireString(entry.caseId, `concurrency cases[${index}].caseId`, {
      pattern: SAFE_ID_PATTERN,
    });
    ids.push(entry.caseId);
    if (!["identical", "divergent", "stale_owner"].includes(entry.kind)) {
      fail("CONCURRENCY_KIND_INVALID", "concurrency kind is invalid");
    }
    requireString(entry.seed, `concurrency cases[${index}].seed`);
    for (const key of [
      "scheduleArtifact",
      "operationsArtifact",
      "acceptedOrderingArtifact",
    ]) {
      validateArtifactRef(entry[key], `concurrency cases[${index}].${key}`);
    }
    const expected = {
      identical: "converged",
      divergent: "refused",
      stale_owner: "stale_owner_refused",
    }[entry.kind];
    if (entry.outcome !== expected) {
      fail("CONCURRENCY_OUTCOME_INVALID", "concurrency outcome is invalid");
    }
    requireSortedUniqueStrings(
      entry.failures,
      `concurrency cases[${index}].failures`,
      { allowEmpty: true },
    );
    if (entry.failures.length !== 0) {
      fail("CONCURRENCY_FAILURE", "concurrency case contains failures");
    }
  });
  if (new Set(ids).size !== ids.length) {
    fail("CONCURRENCY_CASE_DUPLICATE", "concurrency case IDs must be unique");
  }
  for (const key of [
    "nonconvergentIdenticalCount",
    "acceptedDivergentCount",
    "staleOwnerWinCount",
  ]) {
    requireCounter(value[key], `concurrency population.${key}`);
    if (value[key] !== 0) {
      fail("CONCURRENCY_ZERO_FAILURE_VIOLATION", `${key} must remain zero`);
    }
  }
  requireSelfHash(value, "populationHash", "concurrency population");
  return deepFreeze(clone(value));
}

function validateParserPopulation(value) {
  exactKeys(
    value,
    [
      "schema",
      "cases",
      "untypedRefusalCount",
      "partialAcceptanceCount",
      "populationHash",
    ],
    "parser population",
  );
  requireSchema(value, SCHEMAS.parserPopulation, "parser population");
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    fail("PARSER_POPULATION_EMPTY", "parser cases must be non-empty");
  }
  const ids = [];
  const classes = new Set([
    "truncated",
    "oversized",
    "duplicate_key",
    "reordered",
    "unknown_field",
    "wrong_version",
    "wrong_encoding",
    "boundary_value",
  ]);
  value.cases.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "caseId",
        "class",
        "inputArtifact",
        "expectedCode",
        "observedCode",
        "partialAcceptance",
      ],
      `parser cases[${index}]`,
    );
    requireString(entry.caseId, `parser cases[${index}].caseId`, {
      pattern: SAFE_ID_PATTERN,
    });
    ids.push(entry.caseId);
    if (!classes.has(entry.class)) {
      fail("PARSER_CLASS_INVALID", "parser case class is invalid");
    }
    validateArtifactRef(entry.inputArtifact, `parser cases[${index}].inputArtifact`);
    requireString(entry.expectedCode, `parser cases[${index}].expectedCode`, {
      pattern: /^[A-Z][A-Z0-9_]{2,127}$/,
    });
    if (entry.observedCode !== entry.expectedCode) {
      fail("PARSER_CODE_MISMATCH", "parser refusal code does not match");
    }
    if (entry.partialAcceptance !== false) {
      fail("PARSER_PARTIAL_ACCEPTANCE", "parser partially accepted malformed input");
    }
  });
  if (new Set(ids).size !== ids.length) {
    fail("PARSER_CASE_DUPLICATE", "parser case IDs must be unique");
  }
  for (const key of ["untypedRefusalCount", "partialAcceptanceCount"]) {
    requireCounter(value[key], `parser population.${key}`);
    if (value[key] !== 0) {
      fail("PARSER_ZERO_FAILURE_VIOLATION", `${key} must remain zero`);
    }
  }
  requireSelfHash(value, "populationHash", "parser population");
  return deepFreeze(clone(value));
}

function validatePopulationFloorV3(value) {
  refuseLegacySchema(value, "population floor");
  exactKeys(
    value,
    [
      "schema",
      "layerMinimums",
      "coverage",
      "mutation",
      "deterministicRepeat",
      "crashRestart",
      "concurrency",
      "parserRobustness",
      "independentReview",
      "zeroFailure",
      "floorHash",
    ],
    "population floor",
  );
  requireSchema(value, SCHEMAS.populationFloor, "population floor");
  exactKeys(
    value.layerMinimums,
    EVIDENCE_LAYER_IDS,
    "population floor.layerMinimums",
    { ordered: true },
  );
  for (const layerId of EVIDENCE_LAYER_IDS) {
    exactKeys(
      value.layerMinimums[layerId],
      ["minimumCases", "minimumAssertions"],
      `population floor.layerMinimums.${layerId}`,
    );
    for (const key of ["minimumCases", "minimumAssertions"]) {
      requireCounter(
        value.layerMinimums[layerId][key],
        `population floor.layerMinimums.${layerId}.${key}`,
      );
    }
  }
  const nested = {
    coverage: ["minimumRequiredFiles"],
    mutation: ["minimumTotalMutants", "minimumCriticalMutants"],
    deterministicRepeat: ["minimumRuns"],
    crashRestart: ["minimumFaultPoints"],
    concurrency: [
      "minimumIdenticalCases",
      "minimumDivergentCases",
      "minimumStaleOwnerCases",
    ],
    parserRobustness: ["minimumMalformedCases", "minimumBoundaryCases"],
    independentReview: ["minimumCertifierRuns", "minimumCoordinatorReruns"],
  };
  for (const [section, keys] of Object.entries(nested)) {
    exactKeys(value[section], keys, `population floor.${section}`);
    for (const key of keys) {
      requireCounter(value[section][key], `population floor.${section}.${key}`, {
        positive: true,
      });
    }
  }
  exactKeys(
    value.zeroFailure,
    ZERO_FAILURE_KEYS,
    "population floor.zeroFailure",
  );
  for (const key of ZERO_FAILURE_KEYS) {
    requireCounter(value.zeroFailure[key], `population floor.zeroFailure.${key}`);
    if (value.zeroFailure[key] !== 0) {
      fail("ZERO_FAILURE_FLOOR_WEAKENED", `${key} floor must remain zero`);
    }
  }
  requireSelfHash(value, "floorHash", "population floor");
  return deepFreeze(clone(value));
}

function validateQualityPolicyV4(value) {
  refuseLegacySchema(value, "quality policy");
  exactKeys(
    value,
    [
      "schema",
      "revision",
      "bootstrapRevision",
      "artifactPolicySha256",
      "noThresholdChangeWithBehaviorChange",
      "noTestWeakeningWithBehaviorChange",
      "supportedEvidenceOrder",
      "evidenceCrosswalk",
      "profiles",
      "zeroFailureFloors",
      "approvedToolchains",
      "trustedGatePaths",
      "authorityPaths",
      "phaseProofRegistry",
      "receiptSchemas",
      "resourceCeilings",
      "policySha256",
    ],
    "quality policy",
  );
  requireSchema(value, SCHEMAS.qualityPolicy, "quality policy");
  requireCounter(value.revision, "quality policy.revision", { positive: true });
  if (value.revision !== 4) {
    fail("POLICY_REVISION_INVALID", "quality policy revision must be 4");
  }
  requireCounter(value.bootstrapRevision, "quality policy.bootstrapRevision", {
    positive: true,
  });
  requireSha(
    value.artifactPolicySha256,
    "quality policy.artifactPolicySha256",
  );
  if (
    value.noThresholdChangeWithBehaviorChange !== true ||
    value.noTestWeakeningWithBehaviorChange !== true
  ) {
    fail("ANTI_WEAKENING_POLICY_INVALID", "anti-weakening booleans must be true");
  }
  if (stableJson(value.supportedEvidenceOrder) !== stableJson(EVIDENCE_LAYER_IDS)) {
    fail(
      "EVIDENCE_ORDER_INVALID",
      "supportedEvidenceOrder must equal the exact 21-layer registry",
    );
  }
  exactKeys(
    value.evidenceCrosswalk,
    EVIDENCE_LAYER_IDS,
    "quality policy.evidenceCrosswalk",
    { ordered: true },
  );
  for (const [index, layerId] of EVIDENCE_LAYER_IDS.entries()) {
    const entry = value.evidenceCrosswalk[layerId];
    exactKeys(
      entry,
      [
        "ordinal",
        "planKey",
        "producerOutputSchema",
        "layerResultSchema",
        "populationKey",
        "rawArtifactRequired",
        "notApplicableReasonCodes",
      ],
      `quality policy.evidenceCrosswalk.${layerId}`,
    );
    if (
      entry.ordinal !== index + 1 ||
      entry.planKey !== layerId ||
      entry.populationKey !== layerId ||
      entry.rawArtifactRequired !== true
    ) {
      fail("EVIDENCE_CROSSWALK_INVALID", `${layerId} crosswalk is invalid`);
    }
    for (const key of ["producerOutputSchema", "layerResultSchema"]) {
      requireString(
        entry[key],
        `quality policy.evidenceCrosswalk.${layerId}.${key}`,
        { pattern: SAFE_ID_PATTERN },
      );
    }
    if (
      entry.producerOutputSchema !== PRODUCER_OUTPUT_SCHEMAS[layerId] ||
      entry.layerResultSchema !== SCHEMAS.layerPass ||
      entry.producerOutputSchema === entry.layerResultSchema
    ) {
      fail(
        "EVIDENCE_SCHEMA_BOUNDARY_INVALID",
        `${layerId} producer and layer-result schemas are not exact and distinct`,
      );
    }
    requireSortedUniqueStrings(
      entry.notApplicableReasonCodes,
      `quality policy.evidenceCrosswalk.${layerId}.notApplicableReasonCodes`,
      { allowEmpty: true },
    );
    const expected = CONDITIONAL_REASON_CODES[layerId] || [];
    if (
      stableJson(entry.notApplicableReasonCodes) !==
      stableJson([...expected].sort(compareCodeUnits))
    ) {
      fail("EVIDENCE_NA_POLICY_INVALID", `${layerId} N/A reasons are invalid`);
    }
  }
  exactKeys(value.profiles, ["critical"], "quality policy.profiles");
  exactKeys(
    value.profiles.critical,
    [
      "lineCoveragePercent",
      "branchCoveragePercent",
      "functionCoveragePercent",
      "mutationScorePercent",
      "criticalMutationKillPercent",
      "gherkinPassPercent",
      "deterministicRepeatCount",
    ],
    "quality policy.profiles.critical",
  );
  const critical = value.profiles.critical;
  const minimums = {
    lineCoveragePercent: 95,
    branchCoveragePercent: 90,
    functionCoveragePercent: 95,
    mutationScorePercent: 90,
    criticalMutationKillPercent: 100,
    gherkinPassPercent: 100,
    deterministicRepeatCount: 3,
  };
  for (const [key, minimum] of Object.entries(minimums)) {
    const maximum = key === "deterministicRepeatCount" ? Number.MAX_SAFE_INTEGER : 100;
    if (
      !Number.isSafeInteger(critical[key]) ||
      critical[key] < minimum ||
      critical[key] > maximum
    ) {
      fail("QUALITY_PROFILE_WEAKENED", `${key} is below its immutable minimum`);
    }
  }
  exactKeys(
    value.zeroFailureFloors,
    ZERO_FAILURE_KEYS,
    "quality policy.zeroFailureFloors",
  );
  for (const key of ZERO_FAILURE_KEYS) {
    if (value.zeroFailureFloors[key] !== 0) {
      fail("ZERO_FAILURE_FLOOR_WEAKENED", `${key} must remain zero`);
    }
  }
  if (
    !Array.isArray(value.approvedToolchains) ||
    value.approvedToolchains.length === 0
  ) {
    fail("TOOLCHAIN_AUTHORITY_MISSING", "approvedToolchains must be non-empty");
  }
  value.approvedToolchains.forEach((entry, index) =>
    validateArtifactRef(entry, `quality policy.approvedToolchains[${index}]`),
  );
  requireSortedUniqueStrings(
    value.trustedGatePaths,
    "quality policy.trustedGatePaths",
    { safePaths: true },
  );
  requireSortedUniqueStrings(value.authorityPaths, "quality policy.authorityPaths", {
    safePaths: true,
  });
  validateArtifactRef(
    value.phaseProofRegistry,
    "quality policy.phaseProofRegistry",
  );
  exactKeys(
    value.receiptSchemas,
    [
      "qualityPlan",
      "populationFloor",
      "qualityReceipt",
      "candidateReceipt",
      "attestationBody",
      "frozenReview",
    ],
    "quality policy.receiptSchemas",
  );
  const expectedSchemas = {
    qualityPlan: SCHEMAS.qualityPlan,
    populationFloor: SCHEMAS.populationFloor,
    qualityReceipt: SCHEMAS.qualityReceipt,
    candidateReceipt: SCHEMAS.candidateReceipt,
    attestationBody: SCHEMAS.attestationBody,
    frozenReview: SCHEMAS.frozenReview,
  };
  if (stableJson(value.receiptSchemas) !== stableJson(expectedSchemas)) {
    fail("RECEIPT_SCHEMA_REGISTRY_INVALID", "receipt schema registry is invalid");
  }
  exactKeys(
    value.resourceCeilings,
    Object.keys(IMMUTABLE_RESOURCE_CEILINGS),
    "quality policy.resourceCeilings",
    { ordered: true },
  );
  for (const key of Object.keys(IMMUTABLE_RESOURCE_CEILINGS)) {
    requireCounter(
      value.resourceCeilings[key],
      `quality policy.resourceCeilings.${key}`,
    );
  }
  validateByteStreamEnvelopeCapacity(
    value.resourceCeilings,
    value.resourceCeilings.maximumByteStreamEnvelopeBytes,
    "quality policy.resourceCeilings",
  );
  for (const key of Object.keys(IMMUTABLE_RESOURCE_CEILINGS)) {
    if (value.resourceCeilings[key] !== IMMUTABLE_RESOURCE_CEILINGS[key]) {
      fail(
        "RESOURCE_CEILING_MUTATED",
        `quality policy.resourceCeilings.${key} is not the immutable maximum`,
      );
    }
  }
  requireSelfHash(value, "policySha256", "quality policy");
  return deepFreeze(clone(value));
}

function validateDisposition(value, layerId, crosswalk) {
  if (!isPlainObject(value)) {
    fail("UNTYPED_NOT_APPLICABLE_REFUSED", `${layerId} disposition must be typed`);
  }
  if (value.kind === "required") {
    exactKeys(value, ["kind"], `${layerId} disposition`);
    return;
  }
  if (value.kind !== "not_applicable") {
    fail("INVALID_DISPOSITION", `${layerId} disposition is invalid`);
  }
  exactKeys(
    value,
    ["kind", "reasonCode", "policyRuleId", "policyRuleSha256"],
    `${layerId} disposition`,
  );
  validateNotApplicableAuthorization(
    layerId,
    value.reasonCode,
    crosswalk.notApplicableReasonCodes,
  );
  requireString(value.policyRuleId, `${layerId} disposition.policyRuleId`, {
    pattern: SAFE_ID_PATTERN,
  });
  requireSha(value.policyRuleSha256, `${layerId} disposition.policyRuleSha256`);
}

function claimRequiredLayerPlanIdentity(
  claims,
  value,
  layerId,
  collisionCode,
  label,
) {
  if (claims.has(value)) { // QUALITY_V3_MUTATION_ANCHOR_PLAN_DISJOINTNESS
    fail(
      collisionCode,
      `${label} is reused by required quality layers`,
      {
        value,
        firstLayerId: claims.get(value),
        secondLayerId: layerId,
      },
    );
  }
  claims.set(value, layerId);
}

function executionMatrixHash(value) {
  return hashWithoutField(value, "matrixSha256");
}

function canonicalByteStreamEnvelopeBytes(decodedByteLength) {
  requireCounter(decodedByteLength, "decoded byte-stream limit");
  const base64Characters = 4 * Math.ceil(decodedByteLength / 3);
  if (!Number.isSafeInteger(base64Characters)) {
    fail(
      "RESOURCE_LIMIT_INVALID",
      "decoded byte-stream limit cannot be represented safely",
    );
  }
  const canonicalEnvelopeWithoutPayload = stableJson({
    base64: "",
    decodedByteLength,
    encoding: "base64",
    schema: "pikiio-byte-stream-envelope-v1",
  });
  const envelopeBytes =
    Buffer.byteLength(canonicalEnvelopeWithoutPayload, "utf8") +
    base64Characters;
  if (!Number.isSafeInteger(envelopeBytes)) {
    fail(
      "RESOURCE_LIMIT_INVALID",
      "byte-stream envelope size cannot be represented safely",
    );
  }
  return envelopeBytes;
}

function validateByteStreamEnvelopeCapacity(
  resourceLimits,
  maximumEnvelopeBytes,
  label,
) {
  for (const key of ["maximumStdoutBytes", "maximumStderrBytes"]) {
    if (
      canonicalByteStreamEnvelopeBytes(resourceLimits[key]) >
      maximumEnvelopeBytes
    ) { // QUALITY_V4_MUTATION_ANCHOR_ENVELOPE_CAPACITY
      fail(
        "BYTE_STREAM_ENVELOPE_CAPACITY_EXCEEDED",
        `${label}.${key} cannot fit its canonical envelope`,
      );
    }
  }
}

function validateExecutionMatrix(value, policy) {
  exactKeys(
    value,
    [
      "mode",
      "repeatsPerCell",
      "seeds",
      "timeZones",
      "orders",
      "fixtureManifestSha256",
      "expectedExecutionCount",
      "matrixSha256",
    ],
    "quality plan.executionMatrix",
  );
  if (value.mode !== "cartesian_product") {
    fail(
      "EXECUTION_MATRIX_MODE_INVALID",
      "execution matrix must be the exact Cartesian product",
    );
  }
  requireCounter(
    value.repeatsPerCell,
    "quality plan.executionMatrix.repeatsPerCell",
    { positive: true },
  );
  if (
    value.repeatsPerCell !==
    policy.profiles.critical.deterministicRepeatCount
  ) {
    fail("REPEAT_COUNT_MISMATCH", "execution repeat count is not canonical");
  }
  for (const key of ["seeds", "timeZones", "orders"]) {
    requireSortedUniqueStrings(
      value[key],
      `quality plan.executionMatrix.${key}`,
    );
  }
  requireSha(
    value.fixtureManifestSha256,
    "quality plan.executionMatrix.fixtureManifestSha256",
  );
  requireCounter(
    value.expectedExecutionCount,
    "quality plan.executionMatrix.expectedExecutionCount",
    { positive: true },
  );
  const expectedExecutionCount =
    value.repeatsPerCell *
    value.seeds.length *
    value.timeZones.length *
    value.orders.length;
  if (
    !Number.isSafeInteger(expectedExecutionCount) ||
    value.expectedExecutionCount !== expectedExecutionCount
  ) { // QUALITY_V4_MUTATION_ANCHOR_CARTESIAN_COUNT
    fail(
      "EXECUTION_MATRIX_COUNT_MISMATCH",
      "execution matrix count is not the exact Cartesian product",
    );
  }
  requireSha(value.matrixSha256, "quality plan.executionMatrix.matrixSha256");
  if (value.matrixSha256 !== executionMatrixHash(value)) {
    fail(
      "EXECUTION_MATRIX_HASH_MISMATCH",
      "execution matrix hash does not match its exact Cartesian definition",
    );
  }
}

function validatePhaseQualityPlanV4(value, policy) {
  assertPlainGraph(
    policy,
    "quality plan policy context",
  ); // QUALITY_V4_MUTATION_ANCHOR_QUALITY_PLAN_CONTEXT_PROXY_GUARD
  refuseLegacySchema(value, "quality plan");
  exactKeys(
    value,
    [
      "schema",
      "phaseId",
      "policySha256",
      "artifactPolicySha256",
      "populationFloorSha256",
      "syntaxFiles",
      "layers",
      "executionMatrix",
      "coveragePlan",
      "mutationPlan",
      "operationalIntegrityPlan",
      "resourceLimits",
      "planSha256",
    ],
    "quality plan",
  );
  requireSchema(value, SCHEMAS.qualityPlan, "quality plan");
  const validatedPolicy = validateQualityPolicyV4(policy);
  requirePhase(value.phaseId, "quality plan.phaseId");
  if (value.policySha256 !== validatedPolicy.policySha256) {
    fail("POLICY_BINDING_MISMATCH", "quality plan policy hash is stale");
  }
  if (
    value.artifactPolicySha256 !== validatedPolicy.artifactPolicySha256
  ) { // QUALITY_V4_MUTATION_ANCHOR_PLAN_ARTIFACT_POLICY_BINDING
    fail(
      "ARTIFACT_POLICY_BINDING_MISMATCH",
      "quality plan artifact-policy hash is stale",
    );
  }
  requireSha(value.populationFloorSha256, "quality plan.populationFloorSha256");
  requireSortedUniqueStrings(value.syntaxFiles, "quality plan.syntaxFiles", {
    safePaths: true,
  });
  if (value.syntaxFiles.some((entry) => !entry.endsWith(".js"))) {
    fail("SYNTAX_PATH_INVALID", "syntaxFiles must contain JavaScript paths");
  }
  exactKeys(value.layers, EVIDENCE_LAYER_IDS, "quality plan.layers", {
    ordered: true,
  });
  const requiredCheckClaims = new Map();
  const requiredDefinitionClaims = new Map();
  for (const layerId of EVIDENCE_LAYER_IDS) {
    const entry = value.layers[layerId];
    exactKeys(
      entry,
      [
        "layerId",
        "disposition",
        "checkIds",
        "definitionManifestSha256",
        "producerOutputSchema",
        "layerResultSchema",
      ],
      `quality plan.layers.${layerId}`,
    );
    if (entry.layerId !== layerId) {
      fail("LAYER_BINDING_MISMATCH", `${layerId} plan entry is misbound`);
    }
    const crosswalk = validatedPolicy.evidenceCrosswalk[layerId];
    validateDisposition(entry.disposition, layerId, crosswalk);
    if (entry.disposition.kind === "required") {
      requireSortedUniqueStrings(entry.checkIds, `quality plan.layers.${layerId}.checkIds`);
      for (const checkId of entry.checkIds) {
        claimRequiredLayerPlanIdentity(
          requiredCheckClaims,
          checkId,
          layerId,
          "LAYER_CHECK_ID_COLLISION",
          "check ID",
        );
      }
      requireSha(
        entry.definitionManifestSha256,
        `quality plan.layers.${layerId}.definitionManifestSha256`,
      );
      claimRequiredLayerPlanIdentity(
        requiredDefinitionClaims,
        entry.definitionManifestSha256,
        layerId,
        "LAYER_DEFINITION_MANIFEST_COLLISION",
        "definition manifest",
      );
      if (
        entry.producerOutputSchema !== crosswalk.producerOutputSchema ||
        entry.layerResultSchema !== crosswalk.layerResultSchema ||
        entry.producerOutputSchema === entry.layerResultSchema
      ) { // QUALITY_V4_MUTATION_ANCHOR_PRODUCER_RESULT_BOUNDARY
        fail(
          "LAYER_SCHEMA_BOUNDARY_MISMATCH",
          `${layerId} producer/result schema boundary is stale`,
        );
      }
    } else if (
      entry.checkIds.length !== 0 ||
      entry.definitionManifestSha256 !== null ||
      entry.producerOutputSchema !== null ||
      entry.layerResultSchema !== SCHEMAS.notApplicable
    ) {
      fail("NOT_APPLICABLE_EXECUTION_REFUSED", `${layerId} N/A entry carries execution`);
    }
  }
  validateExecutionMatrix(value.executionMatrix, validatedPolicy);
  exactKeys(
    value.coveragePlan,
    [
      "selectorId",
      "requiredFileRules",
      "rawInputOrder",
      "collectorDefinitionSha256",
      "lineFloorPercent",
      "branchFloorPercent",
      "functionFloorPercent",
    ],
    "quality plan.coveragePlan",
  );
  requireString(value.coveragePlan.selectorId, "quality plan.coveragePlan.selectorId", {
    pattern: SAFE_ID_PATTERN,
  });
  requireSortedUniqueStrings(
    value.coveragePlan.requiredFileRules,
    "quality plan.coveragePlan.requiredFileRules",
    { safePaths: true },
  );
  if (value.coveragePlan.rawInputOrder !== "semantic_payload_sha_with_multiplicity") {
    fail(
      "COVERAGE_ORDER_POLICY_INVALID",
      "coverage order must ignore path and filename",
    );
  }
  requireSha(
    value.coveragePlan.collectorDefinitionSha256,
    "quality plan.coveragePlan.collectorDefinitionSha256",
  );
  const coverageFloors = {
    lineFloorPercent: validatedPolicy.profiles.critical.lineCoveragePercent,
    branchFloorPercent: validatedPolicy.profiles.critical.branchCoveragePercent,
    functionFloorPercent:
      validatedPolicy.profiles.critical.functionCoveragePercent,
  };
  for (const [key, expected] of Object.entries(coverageFloors)) {
    if (value.coveragePlan[key] !== expected) {
      fail("COVERAGE_FLOOR_MISMATCH", `${key} does not equal the policy`);
    }
  }
  exactKeys(
    value.mutationPlan,
    [
      "classifierId",
      "profileIds",
      "criticalIdsSha256",
      "scoreFloorPercent",
      "criticalKillFloorPercent",
    ],
    "quality plan.mutationPlan",
  );
  requireString(value.mutationPlan.classifierId, "quality plan.mutationPlan.classifierId", {
    pattern: SAFE_ID_PATTERN,
  });
  requireSortedUniqueStrings(
    value.mutationPlan.profileIds,
    "quality plan.mutationPlan.profileIds",
  );
  requireSha(
    value.mutationPlan.criticalIdsSha256,
    "quality plan.mutationPlan.criticalIdsSha256",
  );
  if (
    value.mutationPlan.scoreFloorPercent !==
      validatedPolicy.profiles.critical.mutationScorePercent ||
    value.mutationPlan.criticalKillFloorPercent !==
      validatedPolicy.profiles.critical.criticalMutationKillPercent
  ) {
    fail("MUTATION_FLOOR_MISMATCH", "mutation floors do not equal the policy");
  }
  exactKeys(
    value.operationalIntegrityPlan,
    [
      "manifestSchema",
      "automationInputSchema",
      "candidateReadOnly",
      "completePrePostObjectsRequired",
    ],
    "quality plan.operationalIntegrityPlan",
  );
  if (
    value.operationalIntegrityPlan.manifestSchema !==
      SCHEMAS.operationalManifest ||
    typeof value.operationalIntegrityPlan.automationInputSchema !== "string" ||
    value.operationalIntegrityPlan.candidateReadOnly !== true ||
    value.operationalIntegrityPlan.completePrePostObjectsRequired !== true
  ) {
    fail("OPERATIONAL_PLAN_INVALID", "operational integrity plan is invalid");
  }
  exactKeys(
    value.resourceLimits,
    [
      "timeoutMsPerExecution",
      "maximumStdoutBytes",
      "maximumStderrBytes",
      "maximumPeakRssBytes",
      "maximumProcessCount",
      "maximumRetries",
    ],
    "quality plan.resourceLimits",
  );
  for (const key of Object.keys(value.resourceLimits)) {
    requireCounter(value.resourceLimits[key], `quality plan.resourceLimits.${key}`);
  }
  if (
    value.resourceLimits.timeoutMsPerExecution === 0 ||
    value.resourceLimits.maximumStdoutBytes === 0 ||
    value.resourceLimits.maximumStderrBytes === 0 ||
    value.resourceLimits.maximumPeakRssBytes === 0 ||
    value.resourceLimits.maximumProcessCount === 0 ||
    value.resourceLimits.maximumRetries !== 0
  ) {
    fail("RESOURCE_LIMIT_INVALID", "resource limits are unsafe");
  }
  for (const key of Object.keys(value.resourceLimits)) {
    if (
      value.resourceLimits[key] >
      validatedPolicy.resourceCeilings[key]
    ) { // QUALITY_V4_MUTATION_ANCHOR_RESOURCE_CEILING
      fail(
        "RESOURCE_CEILING_EXCEEDED",
        `quality plan.resourceLimits.${key} exceeds the immutable policy ceiling`,
      );
    }
  }
  validateByteStreamEnvelopeCapacity(
    value.resourceLimits,
    validatedPolicy.resourceCeilings.maximumByteStreamEnvelopeBytes,
    "quality plan.resourceLimits",
  );
  requireSelfHash(value, "planSha256", "quality plan");
  return deepFreeze(clone(value));
}

function validateFrozenReviewReceiptV1(value) {
  preflightDormantAuthorityRoot(value, {
    keys: FROZEN_REVIEW_ROOT_KEYS,
    schema: SCHEMAS.frozenReview,
    label: "frozen review receipt",
    authorityLabel: "frozen review",
  });
  exactKeys(value, FROZEN_REVIEW_ROOT_KEYS, "frozen review receipt");
  requireSchema(value, SCHEMAS.frozenReview, "frozen review receipt");
  requireString(value.reviewId, "frozen review receipt.reviewId", {
    pattern: SAFE_ID_PATTERN,
  });
  requirePhase(value.phaseId, "frozen review receipt.phaseId");
  requireCommit(value.candidateCommit, "frozen review receipt.candidateCommit");
  requireCommit(value.candidateTree, "frozen review receipt.candidateTree");
  for (const key of ["policySha256", "qualityPlanSha256", "registrySha256"]) {
    requireSha(value[key], `frozen review receipt.${key}`);
  }
  const identities = [
    validateAuthorityIdentity(value.implementer, "implementer", "review implementer"),
    validateAuthorityIdentity(value.certifier, "certifier", "review certifier"),
    validateAuthorityIdentity(value.coordinator, "coordinator", "review coordinator"),
  ];
  if (identities.some((entry) => entry.authorizing !== value.authorizing)) {
    fail(
      "REVIEW_IDENTITY_AUTHORITY_MISMATCH",
      "review identity authority is inconsistent",
    );
  }
  if (new Set(identities.map((entry) => entry.principalSha256)).size !== 3) {
    fail("IDENTITY_COLLISION", "review roles must be pairwise unequal");
  }
  validateArtifactRef(value.reviewedManifest, "frozen review reviewedManifest");
  validateArtifactRef(value.postReviewManifest, "frozen review postReviewManifest");
  if (
    value.reviewedManifest.sha256 !== value.postReviewManifest.sha256 ||
    value.reviewedManifest.byteLength !== value.postReviewManifest.byteLength
  ) {
    fail("POST_REVIEW_BYTES_CHANGED", "reviewed bytes changed after certification");
  }
  if (!Array.isArray(value.findings)) {
    fail("FINDINGS_INVALID", "findings must be an array");
  }
  const findingIds = [];
  value.findings.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "findingId",
        "severity",
        "titleSha256",
        "locationArtifact",
        "findingArtifact",
        "status",
      ],
      `review findings[${index}]`,
    );
    requireString(entry.findingId, `review findings[${index}].findingId`, {
      pattern: SAFE_ID_PATTERN,
    });
    findingIds.push(entry.findingId);
    if (![0, 1, 2, 3].includes(entry.severity)) {
      fail("FINDING_SEVERITY_INVALID", "finding severity is invalid");
    }
    requireSha(entry.titleSha256, `review findings[${index}].titleSha256`);
    validateArtifactRef(entry.locationArtifact, `review findings[${index}].locationArtifact`);
    validateArtifactRef(entry.findingArtifact, `review findings[${index}].findingArtifact`);
    if (!["open", "closed"].includes(entry.status)) {
      fail("FINDING_STATUS_INVALID", "finding status is invalid");
    }
  });
  if (
    new Set(findingIds).size !== findingIds.length ||
    stableJson(findingIds) !==
      stableJson([...findingIds].sort(compareCodeUnits))
  ) {
    fail("FINDING_ORDER_INVALID", "finding IDs must be sorted and unique");
  }
  if (!Array.isArray(value.closureReceipts)) {
    fail("CLOSURE_RECEIPTS_INVALID", "closureReceipts must be an array");
  }
  value.closureReceipts.forEach((entry, index) =>
    validateArtifactRef(entry, `review closureReceipts[${index}]`),
  );
  if (!Array.isArray(value.certifierRuns) || value.certifierRuns.length === 0) {
    fail("CERTIFIER_RUN_MISSING", "certifierRuns must be non-empty");
  }
  value.certifierRuns.forEach((entry, index) =>
    validateArtifactRef(entry, `review certifierRuns[${index}]`),
  );
  validateArtifactRef(value.coordinatorRerun, "review coordinatorRerun");
  requireCounter(value.changedByteCount, "review changedByteCount");
  if (value.changedByteCount !== 0) {
    fail("POST_REVIEW_BYTES_CHANGED", "changedByteCount must remain zero");
  }
  exactKeys(
    value.unresolvedBySeverity,
    ["severity0", "severity1", "severity2", "severity3"],
    "review unresolvedBySeverity",
  );
  for (const key of Object.keys(value.unresolvedBySeverity)) {
    requireCounter(
      value.unresolvedBySeverity[key],
      `review unresolvedBySeverity.${key}`,
    );
  }
  const recomputed = { severity0: 0, severity1: 0, severity2: 0, severity3: 0 };
  for (const finding of value.findings) {
    if (finding.status === "open") recomputed[`severity${finding.severity}`] += 1;
  }
  if (stableJson(recomputed) !== stableJson(value.unresolvedBySeverity)) {
    fail("FINDING_SUMMARY_MISMATCH", "unresolved finding summary is invalid");
  }
  if (
    value.unresolvedBySeverity.severity0 !== 0 ||
    value.unresolvedBySeverity.severity1 !== 0
  ) {
    fail("BLOCKING_FINDINGS_OPEN", "severity 0/1 findings remain open");
  }
  if (value.status !== "passed") {
    fail("REVIEW_NOT_PASSED", "frozen review status must be passed");
  }
  requireTimestamp(value.recordedAt, "frozen review recordedAt");
  if (value.priorReviewReceiptHash !== null) {
    requireSha(value.priorReviewReceiptHash, "frozen review priorReviewReceiptHash");
  }
  requireSelfHash(value, "receiptHash", "frozen review receipt");
  return deepFreeze(clone(value));
}

function validateLayerResults(value, plan, policy) {
  exactKeys(value, EVIDENCE_LAYER_IDS, "quality receipt.layerResults", {
    ordered: true,
  });
  const artifactClaims = new Map();
  for (const layerId of EVIDENCE_LAYER_IDS) {
    const result = value[layerId];
    const disposition = plan.layers[layerId].disposition.kind;
    if (result?.schema === SCHEMAS.notApplicable) {
      if (disposition !== "not_applicable") {
        fail("UNEXPECTED_NOT_APPLICABLE", `${layerId} is required by plan`);
      }
      const validated = validateNotApplicableResult(result);
      const bindingMismatch =
        validated.layerId !== layerId ||
        validated.policySha256 !== policy.policySha256 ||
        validated.qualityPlanSha256 !== plan.planSha256 ||
        validated.reasonCode !== plan.layers[layerId].disposition.reasonCode ||
        validated.policyRuleId !==
          plan.layers[layerId].disposition.policyRuleId ||
        validated.policyRuleSha256 !==
          plan.layers[layerId].disposition.policyRuleSha256;
      if (bindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_NA_TUPLE_BINDING
        fail("NOT_APPLICABLE_BINDING_MISMATCH", `${layerId} N/A result is stale`);
      }
    } else {
      if (disposition !== "required") {
        fail("NOT_APPLICABLE_RESULT_MISSING", `${layerId} must be typed N/A`);
      }
      const validated = validateLayerPassV2(result);
      consumeLayerArtifactAddresses(validated, artifactClaims);
      if (
        validated.layerId !== layerId ||
        stableJson(validated.checkIds) !==
          stableJson(plan.layers[layerId].checkIds) ||
        validated.definitionManifestSha256 !==
          plan.layers[layerId].definitionManifestSha256
      ) {
        fail("LAYER_RESULT_BINDING_MISMATCH", `${layerId} result is stale`);
      }
    }
  }
  return artifactClaims;
}

function specializedArtifactRefs(value) {
  return {
    coverage: value.coverage,
    mutation: value.mutation,
    executionMatrix: value.executionMatrix.artifact,
    operationalBeforeManifest: value.operationalIntegrity.beforeManifest,
    operationalAfterManifest: value.operationalIntegrity.afterManifest,
    operationalAutomationInputs: value.operationalIntegrity.automationInputs,
    crashRestart: value.crashRestart,
    concurrencyLinearizability: value.concurrencyLinearizability,
    schemaParserRobustness: value.schemaParserRobustness,
    independentFrozenHashReview:
      value.independentFrozenHashReview.artifact,
    antiWeakening: value.antiWeakening,
    primaryJudge: value.primaryJudge,
    independentJudge: value.independentJudge,
    rawEvidenceManifest: value.rawEvidenceManifest,
  };
}

function validateSpecializedArtifactProvenance(value) {
  const provenanceKeys = Object.keys(SPECIALIZED_ARTIFACT_PROVENANCE);
  exactKeys(
    value.specializedArtifactProvenance,
    provenanceKeys,
    "quality receipt.specializedArtifactProvenance",
    { ordered: true },
  );
  const references = specializedArtifactRefs(value);
  const layerOutputAddresses = new Set();
  for (const layerId of EVIDENCE_LAYER_IDS) {
    const result = value.layerResults[layerId];
    if (result.schema === SCHEMAS.layerPass) {
      for (const artifact of result.outputArtifacts) {
        layerOutputAddresses.add(artifact.address);
      }
    }
  }
  const controllerAddresses = new Set();
  for (const role of provenanceKeys) {
    const observed = value.specializedArtifactProvenance[role];
    const expected = SPECIALIZED_ARTIFACT_PROVENANCE[role];
    exactKeys(
      observed,
      ["kind", "layerId", "outputIndex", "outputCardinality"],
      `quality receipt.specializedArtifactProvenance.${role}`,
      { ordered: true },
    );
    if (stableJson(observed) !== stableJson(expected)) {
      fail(
        "SPECIALIZED_ARTIFACT_PROVENANCE_INVALID",
        `${role} provenance is not the fixed v7 mapping`,
      );
    }
    const reference = references[role];
    if (expected.kind === "layer_output") {
      const result = value.layerResults[expected.layerId];
      if (
        result.schema !== SCHEMAS.layerPass ||
        result.outputArtifacts.length !== expected.outputCardinality
      ) {
        fail(
          "SPECIALIZED_ARTIFACT_CARDINALITY_MISMATCH",
          `${role} producing layer has the wrong output cardinality`,
        );
      }
      if (
        stableJson(reference) !==
        stableJson(result.outputArtifacts[expected.outputIndex])
      ) { // QUALITY_V4_MUTATION_ANCHOR_SPECIALIZED_ARTIFACT_EQUALITY
        fail(
          "SPECIALIZED_ARTIFACT_BINDING_MISMATCH",
          `${role} does not equal its declared layer output`,
        );
      }
    } else {
      if (
        layerOutputAddresses.has(reference.address) ||
        controllerAddresses.has(reference.address)
      ) { // QUALITY_V4_MUTATION_ANCHOR_CONTROLLER_ONLY_ALIAS
        fail(
          "CONTROLLER_ONLY_ARTIFACT_ALIAS",
          `${role} aliases another evidence role`,
        );
      }
      controllerAddresses.add(reference.address);
    }
  }
}

function validateQualityReceiptV7(value, context = {}) {
  preflightDormantAuthorityRoot(value, {
    keys: QUALITY_RECEIPT_ROOT_KEYS,
    schema: SCHEMAS.qualityReceipt,
    label: "quality receipt",
    authorityLabel: "a phase",
  });
  assertPlainGraph(
    context,
    "quality receipt validation context",
  ); // QUALITY_V4_MUTATION_ANCHOR_QUALITY_CONTEXT_PROXY_GUARD
  exactKeys(value, QUALITY_RECEIPT_ROOT_KEYS, "quality receipt");
  requireSchema(value, SCHEMAS.qualityReceipt, "quality receipt");
  requireTimestamp(value.recordedAt, "quality receipt.recordedAt");
  requireSha(
    value.artifactPolicySha256,
    "quality receipt.artifactPolicySha256",
  );
  if (
    !isPlainObject(context) ||
    !context.policy ||
    !context.qualityPlan ||
    !context.populationFloor
  ) {
    fail(
      "QUALITY_CONTEXT_REQUIRED",
      "structural v7 validation requires policy, plan, and population floor",
    );
  }
  const policy = validateQualityPolicyV4(context.policy);
  const plan = validatePhaseQualityPlanV4(context.qualityPlan, policy);
  const floor = validatePopulationFloorV3(context.populationFloor);
  if (
    value.artifactPolicySha256 !== policy.artifactPolicySha256 ||
    value.artifactPolicySha256 !== plan.artifactPolicySha256
  ) { // QUALITY_V4_MUTATION_ANCHOR_QUALITY_ARTIFACT_POLICY_BINDING
    fail(
      "ARTIFACT_POLICY_BINDING_MISMATCH",
      "quality receipt artifact-policy chain is stale",
    );
  }
  exactKeys(
    value.ledgerBinding,
    ["revision", "ledgerSha256", "goalObjectiveSha256"],
    "quality receipt.ledgerBinding",
  );
  requireCounter(value.ledgerBinding.revision, "quality receipt ledger revision", {
    positive: true,
  });
  requireSha(value.ledgerBinding.ledgerSha256, "quality receipt ledgerSha256");
  requireSha(
    value.ledgerBinding.goalObjectiveSha256,
    "quality receipt goalObjectiveSha256",
  );
  exactKeys(
    value.phaseBinding,
    [
      "phaseId",
      "phaseProofRegistrySha256",
      "qualityPolicySha256",
      "qualityPlanSha256",
      "populationFloorSha256",
      "commandPlanSha256",
      "scopeBaseCommit",
      "candidateCommit",
      "candidateTree",
      "workspaceDigest",
    ],
    "quality receipt.phaseBinding",
  );
  requirePhase(value.phaseBinding.phaseId, "quality receipt phaseId");
  if (
    value.phaseBinding.phaseId !== plan.phaseId ||
    value.phaseBinding.qualityPolicySha256 !== policy.policySha256 ||
    value.phaseBinding.qualityPlanSha256 !== plan.planSha256 ||
    value.phaseBinding.populationFloorSha256 !== floor.floorHash ||
    plan.populationFloorSha256 !== floor.floorHash
  ) {
    fail("QUALITY_BINDING_MISMATCH", "quality receipt authority bindings are stale");
  }
  const phaseRegistryBindingMismatch =
    value.phaseBinding.phaseProofRegistrySha256 !==
    policy.phaseProofRegistry.sha256;
  if (phaseRegistryBindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_PHASE_REGISTRY_BINDING
    fail("QUALITY_BINDING_MISMATCH", "quality receipt registry binding is stale");
  }
  for (const key of [
    "phaseProofRegistrySha256",
    "commandPlanSha256",
    "workspaceDigest",
  ]) {
    requireSha(value.phaseBinding[key], `quality receipt phaseBinding.${key}`);
  }
  for (const key of ["scopeBaseCommit", "candidateCommit", "candidateTree"]) {
    requireCommit(value.phaseBinding[key], `quality receipt phaseBinding.${key}`);
  }
  validateIdentitySet(value.identities, { authorizing: value.authorizing });
  exactKeys(
    value.thresholds,
    [
      "lineCoveragePercent",
      "branchCoveragePercent",
      "functionCoveragePercent",
      "mutationScorePercent",
      "criticalMutationKillPercent",
      "gherkinPassPercent",
      "deterministicRepeatCount",
      "populationFloorSha256",
    ],
    "quality receipt.thresholds",
  );
  const expectedThresholds = {
    ...policy.profiles.critical,
    populationFloorSha256: floor.floorHash,
  };
  if (stableJson(value.thresholds) !== stableJson(expectedThresholds)) {
    fail("THRESHOLD_BINDING_MISMATCH", "quality receipt thresholds are stale");
  }
  validateLayerResults(value.layerResults, plan, policy);
  for (const layerId of EVIDENCE_LAYER_IDS) {
    const minimum = floor.layerMinimums[layerId];
    const disposition = plan.layers[layerId].disposition.kind;
    if (
      disposition === "required" &&
      (minimum.minimumCases === 0 || minimum.minimumAssertions === 0)
    ) {
      fail(
        "REQUIRED_LAYER_POPULATION_ZERO",
        `${layerId} cannot authorize with a zero population floor`,
      );
    }
    if (
      disposition === "required" &&
      (value.layerResults[layerId].minimumCasesObserved <
        minimum.minimumCases ||
        value.layerResults[layerId].minimumAssertionsObserved <
          minimum.minimumAssertions)
    ) {
      fail(
        "LAYER_POPULATION_FLOOR_UNMET",
        `${layerId} observed population is below its immutable floor`,
      );
    }
    if (
      disposition === "not_applicable" &&
      (minimum.minimumCases !== 0 || minimum.minimumAssertions !== 0)
    ) {
      fail(
        "NOT_APPLICABLE_POPULATION_NONZERO",
        `${layerId} N/A population floor must be zero`,
      );
    }
  }
  if (
    floor.deterministicRepeat.minimumRuns <
    policy.profiles.critical.deterministicRepeatCount
  ) {
    fail(
      "DETERMINISTIC_REPEAT_FLOOR_UNMET",
      "population repeat floor is below the policy repeat count",
    );
  }
  exactKeys(
    value.executionMatrix,
    [
      "artifact",
      "matrixSha256",
      "expectedExecutionCount",
      "observedExecutionCount",
      "missingCoordinateCount",
      "duplicateCoordinateCount",
      "divergentCoordinateCount",
    ],
    "quality receipt.executionMatrix",
  );
  requireSha(
    value.executionMatrix.matrixSha256,
    "quality receipt.executionMatrix.matrixSha256",
  );
  for (const key of [
    "expectedExecutionCount",
    "observedExecutionCount",
    "missingCoordinateCount",
    "duplicateCoordinateCount",
    "divergentCoordinateCount",
  ]) {
    requireCounter(
      value.executionMatrix[key],
      `quality receipt.executionMatrix.${key}`,
    );
  }
  if (
    value.executionMatrix.matrixSha256 !== plan.executionMatrix.matrixSha256 ||
    value.executionMatrix.expectedExecutionCount !==
      plan.executionMatrix.expectedExecutionCount ||
    value.executionMatrix.observedExecutionCount !==
      value.executionMatrix.expectedExecutionCount ||
    value.executionMatrix.missingCoordinateCount !== 0 ||
    value.executionMatrix.duplicateCoordinateCount !== 0 ||
    value.executionMatrix.divergentCoordinateCount !== 0 ||
    value.layerResults.deterministic_repeat.executions.length !==
      value.executionMatrix.observedExecutionCount ||
    value.layerResults.deterministic_repeat.minimumCasesObserved !==
      value.executionMatrix.observedExecutionCount
  ) { // QUALITY_V4_MUTATION_ANCHOR_CARTESIAN_PROOF
    fail(
      "EXECUTION_MATRIX_PROOF_INVALID",
      "quality receipt does not prove the exact Cartesian execution matrix",
    );
  }
  for (const [label, artifact] of [
    ["coverage", value.coverage],
    ["mutation", value.mutation],
    ["executionMatrix.artifact", value.executionMatrix.artifact],
    ["crashRestart", value.crashRestart],
    ["concurrencyLinearizability", value.concurrencyLinearizability],
    ["schemaParserRobustness", value.schemaParserRobustness],
    ["antiWeakening", value.antiWeakening],
    ["primaryJudge", value.primaryJudge],
    ["independentJudge", value.independentJudge],
    ["rawEvidenceManifest", value.rawEvidenceManifest],
  ]) {
    validateArtifactRef(artifact, `quality receipt.${label}`);
  }
  exactKeys(
    value.operationalIntegrity,
    [
      "beforeManifest",
      "afterManifest",
      "beforeSemanticSha256",
      "afterSemanticSha256",
      "automationInputs",
      "unchanged",
    ],
    "quality receipt.operationalIntegrity",
  );
  for (const key of ["beforeManifest", "afterManifest", "automationInputs"]) {
    validateArtifactRef(
      value.operationalIntegrity[key],
      `quality receipt.operationalIntegrity.${key}`,
    );
  }
  for (const key of ["beforeSemanticSha256", "afterSemanticSha256"]) {
    requireSha(
      value.operationalIntegrity[key],
      `quality receipt.operationalIntegrity.${key}`,
    );
  }
  if (
    value.operationalIntegrity.unchanged !== true ||
    value.operationalIntegrity.beforeSemanticSha256 !==
      value.operationalIntegrity.afterSemanticSha256
  ) {
    fail("OPERATIONAL_STATE_CHANGED", "operational manifests are not semantically equal");
  }
  exactKeys(
    value.independentFrozenHashReview,
    ["receiptHash", "artifact"],
    "quality receipt.independentFrozenHashReview",
  );
  requireSha(
    value.independentFrozenHashReview.receiptHash,
    "quality receipt independent review receiptHash",
  );
  validateArtifactRef(
    value.independentFrozenHashReview.artifact,
    "quality receipt independent review artifact",
  );
  const frozenReviewArtifactBindingMismatch =
    value.independentFrozenHashReview.artifact.sha256 !==
      value.independentFrozenHashReview.receiptHash ||
    value.independentFrozenHashReview.artifact.address !==
      `sha256:${value.independentFrozenHashReview.receiptHash}` ||
    value.independentFrozenHashReview.artifact.mediaType !== "application/json";
  if (frozenReviewArtifactBindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_FROZEN_REVIEW_ARTIFACT_BINDING
    fail(
      "FROZEN_REVIEW_ARTIFACT_BINDING_MISMATCH",
      "independent frozen-review artifact is not the canonical JSON receipt body",
    );
  }
  validateSpecializedArtifactProvenance(value);
  requireSelfHash(value, "receiptHash", "quality receipt");
  return deepFreeze(clone(value));
}

function validateCandidateReceiptV3(value, context = {}) {
  preflightDormantAuthorityRoot(value, {
    keys: CANDIDATE_RECEIPT_ROOT_KEYS,
    schema: SCHEMAS.candidateReceipt,
    label: "candidate receipt",
    authorityLabel: "a candidate",
  });
  assertPlainGraph(
    context,
    "candidate validation context",
  ); // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_CONTEXT_PROXY_GUARD
  exactKeys(value, CANDIDATE_RECEIPT_ROOT_KEYS, "candidate receipt");
  requireSchema(value, SCHEMAS.candidateReceipt, "candidate receipt");
  requirePhase(value.phaseId, "candidate receipt.phaseId");
  for (const key of ["registryRevision", "ledgerRevision"]) {
    requireCounter(value[key], `candidate receipt.${key}`, { positive: true });
  }
  for (const key of [
    "registrySha256",
    "ledgerSha256",
    "qualityPolicySha256",
    "qualityPlanSha256",
    "populationFloorSha256",
    "artifactPolicySha256",
    "qualityReceiptHash",
    "frozenReviewReceiptHash",
    "rawEvidenceManifestSha256",
    "authorityBaselineSnapshotHash",
  ]) {
    requireSha(value[key], `candidate receipt.${key}`);
  }
  for (const key of [
    "scopeBaseCommit",
    "candidateCommit",
    "candidateTree",
    "authorityBaselineCommit",
  ]) {
    requireCommit(value[key], `candidate receipt.${key}`);
  }
  requireTimestamp(value.observedAt, "candidate receipt.observedAt");
  if (value.status !== "passed" || value.previousReceiptHash !== null) {
    fail("CANDIDATE_CHAIN_INVALID", "candidate must start a passed receipt chain");
  }
  const controller = validateAuthorityIdentity(
    value.controller,
    "controller",
    "candidate controller",
  );
  const collector = validateAuthorityIdentity(
    value.collector,
    "collector",
    "candidate collector",
  );
  if (
    controller.authorizing !== value.authorizing ||
    collector.authorizing !== value.authorizing ||
    controller.principalSha256 === collector.principalSha256
  ) {
      fail("CANDIDATE_IDENTITY_INVALID", "candidate controller/collector are not independent");
  }
  exactKeys(
    value.layerReceiptHashes,
    EVIDENCE_LAYER_IDS,
    "candidate receipt.layerReceiptHashes",
    { ordered: true },
  );
  for (const layerId of EVIDENCE_LAYER_IDS) {
    requireSha(
      value.layerReceiptHashes[layerId],
      `candidate receipt.layerReceiptHashes.${layerId}`,
    );
  }
  for (const key of [
    "authoritySnapshot",
    "changedPathsManifest",
    "changedPathCoverage",
    "assertions",
    "rawArtifact",
  ]) {
    validateArtifactRef(value[key], `candidate receipt.${key}`);
  }
  if (!isPlainObject(context)) {
    fail(
      "QUALITY_CONTEXT_REQUIRED",
      "candidate v3 validation requires its quality receipt and full quality context",
    );
  }
  shallowRootKeys(context, "candidate validation context");
  if (!Object.hasOwn(context, "qualityReceipt") || !context.qualityReceipt) {
    fail(
      "QUALITY_CONTEXT_REQUIRED",
      "candidate v3 validation requires its quality receipt and full quality context",
    );
  }
  if (!Object.hasOwn(context, "phaseRegistryRevision")) {
    fail(
      "CANDIDATE_REGISTRY_CONTEXT_REQUIRED",
      "candidate v3 validation requires the resolved phase-registry revision",
    );
  }
  requireCounter(
    context.phaseRegistryRevision,
    "candidate validation context.phaseRegistryRevision",
    { positive: true },
  );
  const qualityContext = {
    policy: context.policy,
    qualityPlan: context.qualityPlan,
    populationFloor: context.populationFloor,
  };
  const quality = validateQualityReceiptV7(
    context.qualityReceipt,
    qualityContext,
  );
  if (
    value.registryRevision !== context.phaseRegistryRevision
  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_REGISTRY_REVISION_BINDING
    fail(
      "CANDIDATE_REGISTRY_REVISION_MISMATCH",
      "candidate registry revision does not match resolved registry context",
    );
  }
  if (
    controller.principalSha256 !==
    quality.identities.coordinator.principalSha256
  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_CONTROLLER_IDENTITY_BINDING
    fail(
      "CANDIDATE_CONTROLLER_IDENTITY_MISMATCH",
      "candidate controller does not derive from the quality coordinator",
    );
  }
  if (
    collector.principalSha256 !==
    quality.identities.collector.principalSha256
  ) { // QUALITY_V4_MUTATION_ANCHOR_CANDIDATE_COLLECTOR_IDENTITY_BINDING
    fail(
      "CANDIDATE_COLLECTOR_IDENTITY_MISMATCH",
      "candidate collector does not derive from the quality collector",
    );
  }
  const candidateQualityBindingMismatch =
    value.qualityReceiptHash !== quality.receiptHash ||
    value.phaseId !== quality.phaseBinding.phaseId ||
    value.ledgerRevision !== quality.ledgerBinding.revision ||
    value.ledgerSha256 !== quality.ledgerBinding.ledgerSha256 ||
    value.registrySha256 !== quality.phaseBinding.phaseProofRegistrySha256 ||
    value.scopeBaseCommit !== quality.phaseBinding.scopeBaseCommit ||
    value.candidateCommit !== quality.phaseBinding.candidateCommit ||
    value.candidateTree !== quality.phaseBinding.candidateTree ||
    value.qualityPolicySha256 !== quality.phaseBinding.qualityPolicySha256 ||
    value.qualityPlanSha256 !== quality.phaseBinding.qualityPlanSha256 ||
    value.populationFloorSha256 !==
      quality.phaseBinding.populationFloorSha256 ||
    value.artifactPolicySha256 !== quality.artifactPolicySha256 ||
    value.frozenReviewReceiptHash !==
      quality.independentFrozenHashReview.receiptHash ||
    value.rawEvidenceManifestSha256 !== quality.rawEvidenceManifest.sha256;
  if (candidateQualityBindingMismatch) { // QUALITY_V3_MUTATION_ANCHOR_CANDIDATE_QUALITY_BINDING
    fail("CANDIDATE_QUALITY_BINDING_MISMATCH", "candidate does not derive from v7");
  }
  const expectedLayerHashes = Object.fromEntries(
    EVIDENCE_LAYER_IDS.map((layerId) => [
      layerId,
      quality.layerResults[layerId].receiptHash,
    ]),
  );
  if (stableJson(value.layerReceiptHashes) !== stableJson(expectedLayerHashes)) {
    fail("CANDIDATE_LAYER_BINDING_MISMATCH", "candidate layer hashes are stale");
  }
  requireSelfHash(value, "receiptHash", "candidate receipt");
  return deepFreeze(clone(value));
}

function validateAttestationBodyV3(value, context = {}) {
  preflightDormantAuthorityRoot(value, {
    keys: ATTESTATION_BODY_ROOT_KEYS,
    schema: SCHEMAS.attestationBody,
    label: "attestation body",
    authorityLabel: "an attestation",
  });
  assertPlainGraph(
    context,
    "attestation validation context",
  ); // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_CONTEXT_PROXY_GUARD
  exactKeys(value, ATTESTATION_BODY_ROOT_KEYS, "attestation body");
  requireSchema(value, SCHEMAS.attestationBody, "attestation body");
  requirePhase(value.phaseId, "attestation body.phaseId");
  requireCounter(value.ledgerRevision, "attestation body.ledgerRevision", {
    positive: true,
  });
  for (const key of [
    "issuerRegistrySha256",
    "ledgerSha256",
    "phaseProofRegistrySha256",
    "qualityPolicySha256",
    "qualityPlanSha256",
    "populationFloorSha256",
    "artifactPolicySha256",
    "sourceManifestSha256",
    "strictQualityReceiptHash",
    "candidateReceiptHash",
    "frozenReviewReceiptHash",
    "commandPlanHash",
    "evidenceManifestSha256",
  ]) {
    requireSha(value[key], `attestation body.${key}`);
  }
  requireCommit(value.candidateCommit, "attestation body.candidateCommit");
  requireCommit(value.candidateTree, "attestation body.candidateTree");
  exactKeys(
    value.judgeReceiptHashes,
    ["primary", "independent", "collector"],
    "attestation body.judgeReceiptHashes",
  );
  for (const key of Object.keys(value.judgeReceiptHashes)) {
    requireSha(
      value.judgeReceiptHashes[key],
      `attestation body.judgeReceiptHashes.${key}`,
    );
  }
  if (new Set(Object.values(value.judgeReceiptHashes)).size !== 3) {
    fail("JUDGE_RECEIPT_COLLISION", "judge receipt hashes must be distinct");
  }
  exactKeys(
    value.rolePrincipalHashes,
    ROLE_NAMES,
    "attestation body.rolePrincipalHashes",
  );
  for (const key of ROLE_NAMES) {
    requireSha(
      value.rolePrincipalHashes[key],
      `attestation body.rolePrincipalHashes.${key}`,
    );
  }
  if (new Set(Object.values(value.rolePrincipalHashes)).size !== ROLE_NAMES.length) {
    fail("IDENTITY_COLLISION", "attestation role principals must be pairwise unequal");
  }
  exactKeys(
    value.phaseReceiptHashes,
    ["candidate", "rehearsal", "change", "promotion"],
    "attestation body.phaseReceiptHashes",
  );
  for (const key of Object.keys(value.phaseReceiptHashes)) {
    requireSha(
      value.phaseReceiptHashes[key],
      `attestation body.phaseReceiptHashes.${key}`,
    );
  }
  exactKeys(
    value.artifacts,
    [
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
    ],
    "attestation body.artifacts",
  );
  for (const [key, artifact] of Object.entries(value.artifacts)) {
    validateArtifactRef(artifact, `attestation body.artifacts.${key}`);
  }
  const boundArtifacts = {
    sourceManifest: value.sourceManifestSha256,
    qualityReceipt: value.strictQualityReceiptHash,
    candidateReceipt: value.candidateReceiptHash,
    frozenReviewReceipt: value.frozenReviewReceiptHash,
    evidenceManifest: value.evidenceManifestSha256,
    primaryRaw: value.judgeReceiptHashes.primary,
    independentRaw: value.judgeReceiptHashes.independent,
    rehearsalReceipt: value.phaseReceiptHashes.rehearsal,
    changeReceipt: value.phaseReceiptHashes.change,
    promotionReceipt: value.phaseReceiptHashes.promotion,
  };
  for (const [key, hash] of Object.entries(boundArtifacts)) {
    if (value.artifacts[key].sha256 !== hash) {
      fail("ATTESTATION_ARTIFACT_MISMATCH", `${key} artifact is misbound`);
    }
  }
  if (value.phaseReceiptHashes.candidate !== value.candidateReceiptHash) {
    fail(
      "ATTESTATION_PHASE_RECEIPT_MISMATCH",
      "candidate phase receipt must equal the candidate receipt hash",
    );
  }
  if (!isPlainObject(context)) {
    fail(
      "QUALITY_CONTEXT_REQUIRED",
      "attestation v3 validation requires candidate and quality receipt context",
    );
  }
  shallowRootKeys(context, "attestation validation context");
  if (
    !Object.hasOwn(context, "candidateReceipt") ||
    !context.candidateReceipt ||
    !Object.hasOwn(context, "qualityReceipt") ||
    !context.qualityReceipt
  ) {
    fail(
      "QUALITY_CONTEXT_REQUIRED",
      "attestation v3 validation requires candidate and quality receipt context",
    );
  }
  if (!Object.hasOwn(context, "attestationEvidence")) {
    fail(
      "ATTESTATION_EVIDENCE_CONTEXT_REQUIRED",
      "attestation v3 validation requires exact external evidence context",
    );
  }
  exactKeys(
    context.attestationEvidence,
    ATTESTATION_EVIDENCE_CONTEXT_KEYS,
    "attestation validation context.attestationEvidence",
  );
  for (const key of ATTESTATION_EVIDENCE_CONTEXT_KEYS) {
    requireSha(
      context.attestationEvidence[key],
      `attestation validation context.attestationEvidence.${key}`,
    );
  }
  const qualityContext = {
    policy: context.policy,
    qualityPlan: context.qualityPlan,
    populationFloor: context.populationFloor,
  };
  const candidateContext = {
    ...qualityContext,
    phaseRegistryRevision: context.phaseRegistryRevision,
    qualityReceipt: context.qualityReceipt,
  };
  const quality = validateQualityReceiptV7(
    context.qualityReceipt,
    qualityContext,
  );
  const candidate = validateCandidateReceiptV3(
    context.candidateReceipt,
    candidateContext,
  );
  const expectedRolePrincipalHashes = Object.fromEntries(
    ROLE_NAMES.map((role) => [
      role,
      quality.identities[role].principalSha256,
    ]),
  );
  if (
    stableJson(value.rolePrincipalHashes) !==
    stableJson(expectedRolePrincipalHashes)
  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_ROLE_PRINCIPAL_BINDING
    fail(
      "ATTESTATION_ROLE_PRINCIPAL_BINDING_MISMATCH",
      "attestation role principals do not derive from the quality identities",
    );
  }
  const expectedJudgeReceiptHashes = {
    primary: quality.primaryJudge.sha256,
    independent: quality.independentJudge.sha256,
    collector: candidate.rawArtifact.sha256,
  };
  if (
    stableJson(value.judgeReceiptHashes) !==
    stableJson(expectedJudgeReceiptHashes)
  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_JUDGE_RECEIPT_BINDING
    fail(
      "ATTESTATION_JUDGE_RECEIPT_BINDING_MISMATCH",
      "attestation judge receipts do not derive from upstream artifacts",
    );
  }
  if (
    value.evidenceManifestSha256 !==
      candidate.rawEvidenceManifestSha256 ||
    value.evidenceManifestSha256 !== quality.rawEvidenceManifest.sha256
  ) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_EVIDENCE_MANIFEST_BINDING
    fail(
      "ATTESTATION_EVIDENCE_MANIFEST_BINDING_MISMATCH",
      "attestation evidence manifest does not derive from the quality candidate",
    );
  }
  const attestationEvidenceContextMismatch =
    value.issuerRegistrySha256 !==
      context.attestationEvidence.issuerRegistrySha256 ||
    value.sourceManifestSha256 !==
      context.attestationEvidence.sourceManifestSha256 ||
    value.phaseReceiptHashes.rehearsal !==
      context.attestationEvidence.rehearsalReceiptHash ||
    value.phaseReceiptHashes.change !==
      context.attestationEvidence.changeReceiptHash ||
    value.phaseReceiptHashes.promotion !==
      context.attestationEvidence.promotionReceiptHash;
  if (attestationEvidenceContextMismatch) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_EXTERNAL_EVIDENCE_BINDING
    fail(
      "ATTESTATION_EVIDENCE_CONTEXT_MISMATCH",
      "attestation-only evidence does not match trusted external context",
    );
  }
  const attestationChainMismatch =
    value.phaseId !== candidate.phaseId ||
    value.ledgerRevision !== candidate.ledgerRevision ||
    value.ledgerSha256 !== candidate.ledgerSha256 ||
    value.phaseProofRegistrySha256 !== candidate.registrySha256 ||
    value.qualityPolicySha256 !== candidate.qualityPolicySha256 ||
    value.qualityPlanSha256 !== candidate.qualityPlanSha256 ||
    value.populationFloorSha256 !== candidate.populationFloorSha256 ||
    value.artifactPolicySha256 !== candidate.artifactPolicySha256 ||
    value.artifactPolicySha256 !== quality.artifactPolicySha256 ||
    value.candidateCommit !== candidate.candidateCommit ||
    value.candidateTree !== candidate.candidateTree ||
    value.strictQualityReceiptHash !== quality.receiptHash ||
    value.candidateReceiptHash !== candidate.receiptHash ||
    value.frozenReviewReceiptHash !== candidate.frozenReviewReceiptHash ||
    value.commandPlanHash !== quality.phaseBinding.commandPlanSha256;
  if (attestationChainMismatch) { // QUALITY_V4_MUTATION_ANCHOR_ATTESTATION_ARTIFACT_POLICY_BINDING
    fail(
      "ATTESTATION_QUALITY_BINDING_MISMATCH",
      "attestation does not derive from the exact current quality chain",
    );
  }
  if (value.productionAuthority !== false) {
    fail("PRODUCTION_AUTHORITY_REFUSED", "quality attestation is never production authority");
  }
  requireSelfHash(value, "bodySha256", "attestation body");
  return deepFreeze(clone(value));
}

const builders = Object.freeze({
  artifactRef(fields) {
    const value = { ...clone(fields), schema: SCHEMAS.artifactRef };
    return validateArtifactRef(value);
  },
  authorityIdentity(fields) {
    const value = { ...clone(fields), schema: SCHEMAS.authorityIdentity };
    delete value.principalSha256;
    value.principalSha256 = sha256(
      stableJson({
        issuer: value.issuer,
        subject: value.subject,
        credentialKind: value.credentialKind,
        credentialSha256: value.credentialSha256,
        authorizing: value.authorizing,
      }),
    );
    return validateAuthorityIdentity(value);
  },
  qualityPolicy(fields) {
    return seal(
      fields,
      SCHEMAS.qualityPolicy,
      "policySha256",
      validateQualityPolicyV4,
    );
  },
  populationFloor(fields) {
    return seal(
      fields,
      SCHEMAS.populationFloor,
      "floorHash",
      validatePopulationFloorV3,
    );
  },
  qualityPlan(fields, policy) {
    assertPlainGraph(policy, "quality plan builder context");
    return seal(
      fields,
      SCHEMAS.qualityPlan,
      "planSha256",
      validatePhaseQualityPlanV4,
      { context: policy },
    );
  },
  notApplicable(fields) {
    return seal(
      fields,
      SCHEMAS.notApplicable,
      "receiptHash",
      validateNotApplicableResult,
      {
        timestamps: [
          {
            path: ["observedAt"],
            label: "not-applicable result.observedAt",
          },
        ],
      },
    );
  },
  layerPass(fields) {
    admitBuilderSchema(
      fields,
      SCHEMAS.layerPass,
      "layer pass receipt builder input",
    );
    const prepared = { ...clone(fields), schema: SCHEMAS.layerPass };
    delete prepared.semanticSha256;
    prepared.semanticSha256 = layerSemanticHash(prepared);
    return seal(
      prepared,
      SCHEMAS.layerPass,
      "receiptHash",
      validateLayerPassV2,
    );
  },
  executionObservation(fields) {
    return seal(
      fields,
      SCHEMAS.executionObservation,
      "semanticSha256",
      validateExecutionObservationV3,
      {
        semantic: true,
        timestamps: [
          {
            path: ["process", "startedAt"],
            label: "execution observation.process.startedAt",
          },
          {
            path: ["process", "finishedAt"],
            label: "execution observation.process.finishedAt",
          },
        ],
      },
    );
  },
  verifierOutput(fields) {
    return seal(
      fields,
      SCHEMAS.verifierOutput,
      "resultHash",
      validateVerifierOutput,
      { semantic: true },
    );
  },
  coverageInputManifest(fields) {
    const value = { ...clone(fields), schema: SCHEMAS.coverageInputManifest };
    const counts = new Map();
    for (const entry of value.orderedInputs || []) {
      counts.set(
        entry.semanticPayloadSha256,
        (counts.get(entry.semanticPayloadSha256) || 0) + 1,
      );
    }
    value.multiplicitySha256 = sha256(
      stableJson(
        [...counts.entries()]
          .sort(([left], [right]) => compareCodeUnits(left, right))
          .map(([semanticPayloadSha256, count]) => ({
            semanticPayloadSha256,
            count,
          })),
      ),
    );
    delete value.manifestHash;
    value.manifestHash = hashWithoutField(value, "manifestHash");
    validateCoverageInputManifest(value);
    return deepFreeze(clone(value));
  },
  coverageProof(fields) {
    return seal(
      fields,
      SCHEMAS.coverageProof,
      "semanticSha256",
      validateCoverageProofV2,
      { semantic: true },
    );
  },
  operationalManifest(fields) {
    return seal(
      fields,
      SCHEMAS.operationalManifest,
      "manifestHash",
      validateOperationalManifestV2,
      {
        semantic: true,
        timestamps: [
          {
            path: ["capturedAt"],
            label: "operational manifest.capturedAt",
          },
        ],
      },
    );
  },
  crashPopulation(fields) {
    return seal(
      fields,
      SCHEMAS.crashPopulation,
      "populationHash",
      validateCrashPopulation,
    );
  },
  concurrencyPopulation(fields) {
    return seal(
      fields,
      SCHEMAS.concurrencyPopulation,
      "populationHash",
      validateConcurrencyPopulation,
    );
  },
  parserPopulation(fields) {
    return seal(
      fields,
      SCHEMAS.parserPopulation,
      "populationHash",
      validateParserPopulation,
    );
  },
  frozenReview(fields) {
    preflightDormantAuthorityRoot(fields, {
      keys: FROZEN_REVIEW_ROOT_KEYS,
      schema: SCHEMAS.frozenReview,
      label: "frozen review builder input",
      authorityLabel: "frozen review",
      builderHashField: "receiptHash",
    });
    return seal(
      fields,
      SCHEMAS.frozenReview,
      "receiptHash",
      validateFrozenReviewReceiptV1,
      {
        timestamps: [
          {
            path: ["recordedAt"],
            label: "frozen review recordedAt",
          },
        ],
      },
    );
  },
  qualityReceipt(fields, context) {
    preflightDormantAuthorityRoot(fields, {
      keys: QUALITY_RECEIPT_ROOT_KEYS,
      schema: SCHEMAS.qualityReceipt,
      label: "quality receipt builder input",
      authorityLabel: "a phase",
      builderHashField: "receiptHash",
    });
    return seal(
      fields,
      SCHEMAS.qualityReceipt,
      "receiptHash",
      validateQualityReceiptV7,
      {
        context,
        timestamps: [
          {
            path: ["recordedAt"],
            label: "quality receipt.recordedAt",
          },
        ],
      },
    );
  },
  candidateReceipt(fields, context) {
    preflightDormantAuthorityRoot(fields, {
      keys: CANDIDATE_RECEIPT_ROOT_KEYS,
      schema: SCHEMAS.candidateReceipt,
      label: "candidate receipt builder input",
      authorityLabel: "a candidate",
      builderHashField: "receiptHash",
    });
    return seal(
      fields,
      SCHEMAS.candidateReceipt,
      "receiptHash",
      validateCandidateReceiptV3,
      {
        context,
        timestamps: [
          {
            path: ["observedAt"],
            label: "candidate receipt.observedAt",
          },
        ],
      },
    );
  },
  attestationBody(fields, context) {
    preflightDormantAuthorityRoot(fields, {
      keys: ATTESTATION_BODY_ROOT_KEYS,
      schema: SCHEMAS.attestationBody,
      label: "attestation body builder input",
      authorityLabel: "an attestation",
      builderHashField: "bodySha256",
    });
    return seal(
      fields,
      SCHEMAS.attestationBody,
      "bodySha256",
      validateAttestationBodyV3,
      { context },
    );
  },
});

module.exports = Object.freeze({
  CONDITIONAL_LAYER_IDS,
  CONDITIONAL_REASON_CODES,
  EVIDENCE_LAYER_IDS,
  EXECUTION_ZERO_FAILURE_KEYS,
  IDENTITY_ROLE_VALUES,
  IMMUTABLE_RESOURCE_CEILINGS,
  LEGACY_REFUSALS,
  PRODUCER_OUTPUT_SCHEMAS,
  QualityContractV4Error,
  ROLE_NAMES,
  SCHEMAS,
  SPECIALIZED_ARTIFACT_PROVENANCE,
  ZERO_FAILURE_KEYS,
  builders,
  hashWithoutField,
  layerSemanticHash,
  semanticHashWithoutField,
  sha256,
  stableJson,
  validateArtifactRef,
  validateAttestationBodyV3,
  validateAuthorityIdentity,
  validateCandidateReceiptV3,
  validateConcurrencyPopulation,
  validateCoverageInputManifest,
  validateCoverageProofV2,
  validateCrashPopulation,
  validateExecutionObservationV3,
  validateFrozenReviewReceiptV1,
  validateLayerPassV2,
  validateNotApplicableResult,
  validateOperationalManifestV2,
  validateParserPopulation,
  validatePhaseQualityPlanV4,
  validatePopulationFloorV3,
  validateQualityPolicyV4,
  validateQualityReceiptV7,
  validateVerifierOutput,
});

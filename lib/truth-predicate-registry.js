"use strict";

const crypto = require("node:crypto");
const RAW_REGISTRY = require("../config/truth-predicate-registry-v1.json");

const SCHEMA_VERSION = "truth-predicate-registry-v1";
const POLARITIES = Object.freeze(["positive", "negative", "requested", "neutral", "unknown"]);
const EFFECTS = new Set(["complete", "block", "request", "context"]);
const GATES = new Set(["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod", "context"]);

class TruthPredicateRegistryError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthPredicateRegistryError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason, cause) {
  return new TruthPredicateRegistryError(`Invalid truth predicate registry ${field}: ${reason}`, {
    code: "TRUTH_PREDICATE_REGISTRY_INVALID",
    field,
    cause,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function normalizedToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function exactKeys(value, keys, field) {
  if (!isPlainObject(value)) throw invalid(field, "must be an object");
  const extras = Object.keys(value).filter((key) => !keys.includes(key));
  if (extras.length) throw invalid(field, `contains unsupported keys: ${extras.sort().join(", ")}`);
}

function patternList(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw invalid(field, "must contain one through twenty regex strings");
  }
  return value.map((pattern, index) => {
    if (typeof pattern !== "string" || !pattern || Buffer.byteLength(pattern, "utf8") > 4000) {
      throw invalid(`${field}[${index}]`, "must be a bounded non-empty regex string");
    }
    try {
      return new RegExp(pattern, "iu");
    } catch (cause) {
      throw invalid(`${field}[${index}]`, "is not a valid regular expression", cause);
    }
  });
}

function unionPattern(patterns) {
  return new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"), "iu");
}

function validateRegistry(raw = RAW_REGISTRY) {
  exactKeys(raw, ["schemaVersion", "registryVersion", "predicates"], "registry");
  if (raw.schemaVersion !== SCHEMA_VERSION) throw invalid("schemaVersion", `must equal ${SCHEMA_VERSION}`);
  if (typeof raw.registryVersion !== "string" || !raw.registryVersion.trim()) {
    throw invalid("registryVersion", "must be a non-empty string");
  }
  if (!isPlainObject(raw.predicates) || Object.keys(raw.predicates).length < 1) {
    throw invalid("predicates", "must be a non-empty object");
  }
  const predicates = {};
  for (const [predicate, definition] of Object.entries(raw.predicates)) {
    if (predicate !== normalizedToken(predicate)) throw invalid(`predicates.${predicate}`, "key must be normalized snake_case");
    exactKeys(definition, [
      "gate", "description", "statuses", "effects", "topicPatterns", "positivePatterns",
      "negativePatterns", "plannedPatterns", "modelEvidencePatterns",
    ], `predicates.${predicate}`);
    if (!GATES.has(definition.gate)) throw invalid(`predicates.${predicate}.gate`, "is unsupported");
    if (typeof definition.description !== "string" || !definition.description.trim()) {
      throw invalid(`predicates.${predicate}.description`, "must be non-empty");
    }
    for (const mapName of ["statuses", "effects"]) {
      exactKeys(definition[mapName], POLARITIES, `predicates.${predicate}.${mapName}`);
      for (const polarity of POLARITIES) {
        const value = definition[mapName][polarity];
        if (typeof value !== "string" || !value || value !== normalizedToken(value)) {
          throw invalid(`predicates.${predicate}.${mapName}.${polarity}`, "must be a normalized token");
        }
        if (mapName === "effects" && !EFFECTS.has(value)) {
          throw invalid(`predicates.${predicate}.${mapName}.${polarity}`, "has an unsupported effect");
        }
      }
    }
    const topicPatterns = patternList(definition.topicPatterns, `predicates.${predicate}.topicPatterns`);
    const positivePatterns = patternList(definition.positivePatterns, `predicates.${predicate}.positivePatterns`);
    const negativePatterns = patternList(definition.negativePatterns, `predicates.${predicate}.negativePatterns`);
    const plannedPatterns = patternList(definition.plannedPatterns, `predicates.${predicate}.plannedPatterns`);
    const modelEvidencePatterns = patternList(definition.modelEvidencePatterns, `predicates.${predicate}.modelEvidencePatterns`);
    predicates[predicate] = {
      gate: definition.gate,
      description: definition.description,
      statuses: { ...definition.statuses },
      effects: { ...definition.effects },
      topic: unionPattern(topicPatterns),
      positive: unionPattern(positivePatterns),
      negative: unionPattern(negativePatterns),
      planned: unionPattern(plannedPatterns),
      modelEvidence: unionPattern(modelEvidencePatterns),
    };
  }
  const registryHash = sha256Json(raw);
  return deepFreeze({
    schemaVersion: raw.schemaVersion,
    registryVersion: raw.registryVersion,
    registryHash,
    predicates,
  });
}

// Every extractor pins the same registry identity. The source-specific view
// keeps TMS inventory membership out of Gmail/model/operator predicate
// allowlists while still committing every extractor to the v2 registry hash.
const REGISTRY = validateRegistry();
const {
  shipment_observed_in_tms: _tmsInventoryPredicate,
  ...LEGACY_PREDICATES
} = REGISTRY.predicates;
const PREDICATES = deepFreeze(LEGACY_PREDICATES);
const TMS_PREDICATES = REGISTRY.predicates;

function modelPredicateCatalog() {
  return Object.entries(PREDICATES).map(([predicate, definition]) => ({
    predicate,
    gate: definition.gate,
    description: definition.description,
    statuses: { ...definition.statuses },
    effects: { ...definition.effects },
  }));
}

module.exports = {
  PREDICATES,
  POLARITIES,
  REGISTRY,
  TMS_PREDICATES,
  SCHEMA_VERSION,
  TruthPredicateRegistryError,
  modelPredicateCatalog,
  validateRegistry,
  _test: { canonicalize, normalizedToken, sha256Json },
};

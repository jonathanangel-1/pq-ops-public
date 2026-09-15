"use strict";

const crypto = require("node:crypto");
const {
  ACCEPTANCE_POLICY_VERSION: GMAIL_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: GMAIL_EXTRACTOR_VERSION,
  PROMPT_VERSION: GMAIL_PROMPT_VERSION,
} = require("./gmail-claim-extractor");
const { LINKER_VERSION } = require("./gmail-cross-thread-linker");
const {
  ACCEPTANCE_POLICY_VERSION: OPERATOR_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: OPERATOR_EXTRACTOR_VERSION,
} = require("./operator-claim-extractor");
const { postgresJsonbText } = require("./postgres-jsonb");
const {
  ACCEPTANCE_POLICY_VERSION: TMS_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: TMS_EXTRACTOR_VERSION,
} = require("./tms-claim-extractor");
const {
  ACCEPTANCE_POLICY_VERSION: TRACKING_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: TRACKING_EXTRACTOR_VERSION,
} = require("./tracking-claim-extractor");

const PROCESSING_WATERMARK_SCHEMA_VERSION = "truth-processing-watermark-v1";
const CONFIG_SNAPSHOT_SCHEMA_VERSION = "truth-processing-config-snapshot-v1";
const CONFIG_SNAPSHOT_VERSION_PREFIX = "truth-processing-config-snapshot:v1:";
const WATERMARKED_STATUS = "watermarked";
const LEGACY_UNWATERMARKED_STATUS = "legacy_unwatermarked";
const CONFIGURED_DETERMINISTIC_IDENTITY = "deterministic-only-v1";
const OBSERVED_DETERMINISTIC_SENTINEL = "deterministic:none";
const PROCESSING_CONFIG_KEYS = Object.freeze([
  "dateOrder",
  "requireModelForAmbiguity",
  "maxModelConfidence",
  "internalDomains",
]);
const DEFAULT_PROCESSING_CONFIG = deepFreeze({
  dateOrder: "MDY",
  requireModelForAmbiguity: true,
  maxModelConfidence: 0.9,
  internalDomains: ["partner-116.example"],
});
const HASH_RE = /^[0-9a-f]{64}$/;
const EXTRACTOR_SET_RE = /^extractor-set:v2:[0-9a-f]{64}$/;
const LINKER_SET_RE = /^linker-set:v2:[0-9a-f]{64}$/;
const CONFIG_SNAPSHOT_VERSION_RE = /^truth-processing-config-snapshot:v1:[0-9a-f]{64}$/;

const CONFIGURED_KEYS = Object.freeze([
  "model",
  "promptVersion",
  "extractorVersion",
  "entityLinkerVersion",
  "acceptancePolicyVersion",
  "configSnapshotVersion",
  "configSnapshotHash",
  "reducerVersion",
  "packetBuilderVersion",
  "packetSchemaVersion",
  "precedencePolicyVersion",
  "precedencePolicyHash",
]);
const OBSERVED_KEYS = Object.freeze([
  "claimProcessors",
  "entityLinkers",
  "workgroupCreators",
  "workgroupMembershipLinkers",
  "extractorSetVersion",
  "linkerSetVersion",
]);
const EXTRACTOR_TUPLE_KEYS = Object.freeze([
  "extractionMethod",
  "extractorVersion",
  "model",
  "promptVersion",
  "acceptanceMethod",
  "acceptancePolicyVersion",
]);
const ENTITY_LINKER_TUPLE_KEYS = Object.freeze(["linkMethod", "linkerVersion"]);
const WORKGROUP_CREATOR_TUPLE_KEYS = Object.freeze(["createdMethod", "linkerVersion"]);
const WORKGROUP_MEMBERSHIP_TUPLE_KEYS = Object.freeze(["membershipMethod", "linkerVersion"]);
const WATERMARK_KEYS = Object.freeze(["schemaVersion", "configured", "observed"]);
const PROCESSING_METHODS = new Set(["deterministic", "model", "operator"]);
const ACCEPTANCE_METHODS = new Set(["policy", "operator"]);

const SOURCE_PROCESSING_IDENTITIES = Object.freeze({
  gmail: Object.freeze({
    extractorVersion: GMAIL_EXTRACTOR_VERSION,
    acceptancePolicyVersion: GMAIL_ACCEPTANCE_POLICY_VERSION,
  }),
  operator: Object.freeze({
    extractorVersion: OPERATOR_EXTRACTOR_VERSION,
    acceptancePolicyVersion: OPERATOR_ACCEPTANCE_POLICY_VERSION,
  }),
  tms: Object.freeze({
    extractorVersion: TMS_EXTRACTOR_VERSION,
    acceptancePolicyVersion: TMS_ACCEPTANCE_POLICY_VERSION,
  }),
  tracking: Object.freeze({
    extractorVersion: TRACKING_EXTRACTOR_VERSION,
    acceptancePolicyVersion: TRACKING_ACCEPTANCE_POLICY_VERSION,
  }),
});

class TruthProcessingWatermarkError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthProcessingWatermarkError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason, code = "TRUTH_PROCESSING_WATERMARK_INVALID") {
  return new TruthProcessingWatermarkError(`Invalid truth processing watermark ${field}: ${reason}`, {
    code,
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(value, keys, field) {
  if (!isPlainObject(value)) throw invalid(field, "must be an object");
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw invalid(`${field}.${key}`, "is unsupported");
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw invalid(`${field}.${key}`, "is required");
    }
  }
}

function text(value, field, { maximumBytes = 4096 } = {}) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw invalid(field, "is too long");
  return value;
}

function hash(value, field) {
  const result = text(value, field, { maximumBytes: 64 });
  if (!HASH_RE.test(result)) throw invalid(field, "must be lowercase SHA-256 hex");
  return result;
}

function normalizeProcessingConfig(value = DEFAULT_PROCESSING_CONFIG, field = "processingConfig") {
  exactKeys(value, PROCESSING_CONFIG_KEYS, field);
  const dateOrder = text(value.dateOrder, `${field}.dateOrder`, { maximumBytes: 3 }).toUpperCase();
  if (!new Set(["MDY", "DMY"]).has(dateOrder)) {
    throw invalid(`${field}.dateOrder`, "must be MDY or DMY");
  }
  if (typeof value.requireModelForAmbiguity !== "boolean") {
    throw invalid(`${field}.requireModelForAmbiguity`, "must be a boolean");
  }
  if (typeof value.maxModelConfidence !== "number" || !Number.isFinite(value.maxModelConfidence) ||
      value.maxModelConfidence <= 0 || value.maxModelConfidence > 0.95 ||
      Number(value.maxModelConfidence.toFixed(6)) !== value.maxModelConfidence) {
    throw invalid(
      `${field}.maxModelConfidence`,
      "must be a finite number greater than zero and at most 0.95 with no more than six decimals",
    );
  }
  if (!Array.isArray(value.internalDomains) || !value.internalDomains.length ||
      value.internalDomains.length > 100) {
    throw invalid(`${field}.internalDomains`, "must contain one through 100 domains");
  }
  const internalDomains = [...new Set(value.internalDomains.map((domain, index) => {
    const normalized = text(domain, `${field}.internalDomains[${index}]`, { maximumBytes: 253 })
      .toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalized)) {
      throw invalid(`${field}.internalDomains[${index}]`, "must be a normalized domain");
    }
    return normalized;
  }))].sort();
  return deepFreeze({
    dateOrder,
    requireModelForAmbiguity: value.requireModelForAmbiguity,
    maxModelConfidence: value.maxModelConfidence,
    internalDomains,
  });
}

function canonicalize(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalid(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) result[key] = canonicalize(value[key], `${field}.${key}`);
    }
    return result;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function postgresJsonbHash(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(canonicalize(value)), "utf8").digest("hex");
}

function sameJson(left, right) {
  return postgresJsonbText(canonicalize(left)) === postgresJsonbText(canonicalize(right));
}

function normalizeConfiguredProcessingWatermark(value, field = "configured") {
  exactKeys(value, CONFIGURED_KEYS, field);
  const normalized = {};
  for (const key of CONFIGURED_KEYS) {
    normalized[key] = key.endsWith("Hash")
      ? hash(value[key], `${field}.${key}`)
      : text(value[key], `${field}.${key}`);
  }
  if (!CONFIG_SNAPSHOT_VERSION_RE.test(normalized.configSnapshotVersion)) {
    throw invalid(
      `${field}.configSnapshotVersion`,
      "must be truth-processing-config-snapshot:v1:<sha256>",
    );
  }
  if (normalized.configSnapshotVersion !== `${CONFIG_SNAPSHOT_VERSION_PREFIX}${normalized.configSnapshotHash}`) {
    throw invalid(`${field}.configSnapshotVersion`, "must be content-addressed by configSnapshotHash");
  }
  return deepFreeze(normalized);
}

function normalizeExtractorTuple(value, field) {
  exactKeys(value, EXTRACTOR_TUPLE_KEYS, field);
  const tuple = Object.fromEntries(EXTRACTOR_TUPLE_KEYS.map((key) => [
    key,
    text(value[key], `${field}.${key}`),
  ]));
  if (tuple.extractionMethod === "model" && (
    tuple.model === OBSERVED_DETERMINISTIC_SENTINEL
      || tuple.promptVersion === OBSERVED_DETERMINISTIC_SENTINEL
  )) {
    throw invalid(field, "model extraction must carry real model and prompt identities");
  }
  if (!PROCESSING_METHODS.has(tuple.extractionMethod)) {
    throw invalid(`${field}.extractionMethod`, "is unsupported");
  }
  if (!ACCEPTANCE_METHODS.has(tuple.acceptanceMethod)) {
    throw invalid(`${field}.acceptanceMethod`, "is unsupported");
  }
  return Object.freeze(tuple);
}

function normalizeMethodTuple(value, keys, methodKey, field) {
  exactKeys(value, keys, field);
  const tuple = Object.fromEntries(keys.map((key) => [key, text(value[key], `${field}.${key}`)]));
  if (!PROCESSING_METHODS.has(tuple[methodKey])) {
    throw invalid(`${field}.${methodKey}`, "is unsupported");
  }
  return Object.freeze(tuple);
}

function compareExtractorTuples(left, right) {
  return compareCanonicalTuples(left, right);
}

function compareCanonicalTuples(left, right) {
  return Buffer.compare(
    Buffer.from(postgresJsonbText(left), "utf8"),
    Buffer.from(postgresJsonbText(right), "utf8"),
  );
}

function requireCanonicalTupleArray(value, field, normalizeTuple, compareTuple) {
  if (!Array.isArray(value)) throw invalid(field, "must be an array");
  const normalized = value.map((item, index) => normalizeTuple(item, `${field}[${index}]`));
  const canonical = [...normalized].sort(compareTuple);
  for (let index = 1; index < canonical.length; index += 1) {
    if (compareTuple(canonical[index - 1], canonical[index]) === 0) {
      throw invalid(field, "must not contain duplicate tuples");
    }
  }
  if (!sameJson(normalized, canonical)) throw invalid(field, "must be canonically sorted");
  return deepFreeze(normalized);
}

function normalizeObservedProcessingWatermark(value, field = "observed") {
  exactKeys(value, OBSERVED_KEYS, field);
  const claimProcessors = requireCanonicalTupleArray(
    value.claimProcessors,
    `${field}.claimProcessors`,
    normalizeExtractorTuple,
    compareExtractorTuples,
  );
  const entityLinkers = requireCanonicalTupleArray(
    value.entityLinkers,
    `${field}.entityLinkers`,
    (item, itemField) => normalizeMethodTuple(
      item,
      ENTITY_LINKER_TUPLE_KEYS,
      "linkMethod",
      itemField,
    ),
    compareCanonicalTuples,
  );
  const workgroupCreators = requireCanonicalTupleArray(
    value.workgroupCreators,
    `${field}.workgroupCreators`,
    (item, itemField) => normalizeMethodTuple(
      item,
      WORKGROUP_CREATOR_TUPLE_KEYS,
      "createdMethod",
      itemField,
    ),
    compareCanonicalTuples,
  );
  const workgroupMembershipLinkers = requireCanonicalTupleArray(
    value.workgroupMembershipLinkers,
    `${field}.workgroupMembershipLinkers`,
    (item, itemField) => normalizeMethodTuple(
      item,
      WORKGROUP_MEMBERSHIP_TUPLE_KEYS,
      "membershipMethod",
      itemField,
    ),
    compareCanonicalTuples,
  );
  const extractorSetVersion = text(value.extractorSetVersion, `${field}.extractorSetVersion`);
  const linkerSetVersion = text(value.linkerSetVersion, `${field}.linkerSetVersion`);
  if (!EXTRACTOR_SET_RE.test(extractorSetVersion)) {
    throw invalid(`${field}.extractorSetVersion`, "must be extractor-set:v2:<sha256>");
  }
  if (!LINKER_SET_RE.test(linkerSetVersion)) {
    throw invalid(`${field}.linkerSetVersion`, "must be linker-set:v2:<sha256>");
  }
  const expectedExtractorSet = `extractor-set:v2:${postgresJsonbHash(claimProcessors)}`;
  const expectedLinkerSet = `linker-set:v2:${postgresJsonbHash({
    entityLinkers,
    workgroupCreators,
    workgroupMembershipLinkers,
  })}`;
  if (extractorSetVersion !== expectedExtractorSet) {
    throw invalid(`${field}.extractorSetVersion`, "does not match the canonical extractor tuples");
  }
  if (linkerSetVersion !== expectedLinkerSet) {
    throw invalid(`${field}.linkerSetVersion`, "does not match the canonical linker tuples");
  }
  return deepFreeze({
    claimProcessors,
    entityLinkers,
    workgroupCreators,
    workgroupMembershipLinkers,
    extractorSetVersion,
    linkerSetVersion,
  });
}

function normalizeProcessingWatermark(value, field = "processingWatermark") {
  exactKeys(value, WATERMARK_KEYS, field);
  if (value.schemaVersion !== PROCESSING_WATERMARK_SCHEMA_VERSION) {
    throw invalid(`${field}.schemaVersion`, `must be ${PROCESSING_WATERMARK_SCHEMA_VERSION}`);
  }
  return deepFreeze({
    schemaVersion: PROCESSING_WATERMARK_SCHEMA_VERSION,
    configured: normalizeConfiguredProcessingWatermark(value.configured, `${field}.configured`),
    observed: normalizeObservedProcessingWatermark(value.observed, `${field}.observed`),
  });
}

function processingWatermarkHash(value) {
  return postgresJsonbHash(normalizeProcessingWatermark(value));
}

function validateProcessingWatermarkFields(value, options = {}) {
  const field = options.field || "receipt";
  const status = value?.processingWatermarkStatus;
  const watermark = value?.processingWatermark;
  const watermarkHash = value?.processingWatermarkHash;
  if (options.allowEmpty === true && status === null && watermark === null && watermarkHash === null) {
    return Object.freeze({ status: null, watermark: null, watermarkHash: null });
  }
  if (status === LEGACY_UNWATERMARKED_STATUS) {
    if (options.allowLegacy !== true) {
      throw invalid(`${field}.processingWatermarkStatus`, "legacy_unwatermarked is not valid for a new build");
    }
    if (watermark !== null || watermarkHash !== null) {
      throw invalid(field, "legacy_unwatermarked must carry null watermark fields");
    }
    return Object.freeze({ status, watermark: null, watermarkHash: null });
  }
  if (status !== WATERMARKED_STATUS) {
    throw invalid(`${field}.processingWatermarkStatus`, "must be watermarked");
  }
  const normalized = normalizeProcessingWatermark(watermark, `${field}.processingWatermark`);
  const normalizedHash = hash(watermarkHash, `${field}.processingWatermarkHash`);
  if (processingWatermarkHash(normalized) !== normalizedHash) {
    throw invalid(`${field}.processingWatermarkHash`, "does not match the full canonical watermark");
  }
  if (options.expectedConfigured && !sameJson(normalized.configured, options.expectedConfigured)) {
    throw invalid(`${field}.processingWatermark.configured`, "does not match the configured build vector");
  }
  return Object.freeze({ status, watermark: normalized, watermarkHash: normalizedHash });
}

function configuredSetIdentity(prefix, rows) {
  return `${prefix}:${postgresJsonbHash(rows)}`;
}

function createConfiguredProcessingWatermark(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const allowed = new Set([
    "model",
    "modelProvider",
    "promptVersion",
    "reducerVersion",
    "packetBuilderVersion",
    "packetSchemaVersion",
    "precedencePolicyVersion",
    "precedencePolicyHash",
    "processingConfig",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw invalid(`options.${key}`, "is unsupported");
  }
  const model = text(options.model ?? CONFIGURED_DETERMINISTIC_IDENTITY, "options.model");
  const modelProvider = text(
    options.modelProvider ?? (model === CONFIGURED_DETERMINISTIC_IDENTITY ? "deterministic" : "injected"),
    "options.modelProvider",
  );
  const promptVersion = text(
    options.promptVersion ?? CONFIGURED_DETERMINISTIC_IDENTITY,
    "options.promptVersion",
  );
  const reducerVersion = text(options.reducerVersion, "options.reducerVersion");
  const packetBuilderVersion = text(options.packetBuilderVersion, "options.packetBuilderVersion");
  const packetSchemaVersion = text(options.packetSchemaVersion, "options.packetSchemaVersion");
  const precedencePolicyVersion = text(options.precedencePolicyVersion, "options.precedencePolicyVersion");
  const precedencePolicyHash = hash(options.precedencePolicyHash, "options.precedencePolicyHash");
  const processingConfig = normalizeProcessingConfig(
    options.processingConfig ?? DEFAULT_PROCESSING_CONFIG,
    "options.processingConfig",
  );
  const sourceIdentities = Object.entries(SOURCE_PROCESSING_IDENTITIES)
    .map(([sourceSystem, identity]) => ({ sourceSystem, ...identity }))
    .sort((left, right) => left.sourceSystem.localeCompare(right.sourceSystem));
  const extractorVersion = configuredSetIdentity(
    "configured-extractor-set:v1",
    sourceIdentities.map(({ sourceSystem, extractorVersion: version }) => ({ sourceSystem, extractorVersion: version })),
  );
  const acceptancePolicyVersion = configuredSetIdentity(
    "configured-acceptance-policy-set:v1",
    sourceIdentities.map(({ sourceSystem, acceptancePolicyVersion: version }) => ({
      sourceSystem,
      acceptancePolicyVersion: version,
    })),
  );
  const configSnapshot = {
    schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION,
    mode: model === CONFIGURED_DETERMINISTIC_IDENTITY
      ? "deterministic-only"
      : "model-assisted-review-only",
    modelProvider,
    model,
    promptVersion,
    sourceIdentities,
    entityLinkerVersion: LINKER_VERSION,
    reducerVersion,
    packetBuilderVersion,
    packetSchemaVersion,
    precedencePolicyVersion,
    precedencePolicyHash,
    processingConfig,
  };
  const configSnapshotHash = postgresJsonbHash(configSnapshot);
  return normalizeConfiguredProcessingWatermark({
    model,
    promptVersion,
    extractorVersion,
    entityLinkerVersion: LINKER_VERSION,
    acceptancePolicyVersion,
    configSnapshotVersion: `${CONFIG_SNAPSHOT_VERSION_PREFIX}${configSnapshotHash}`,
    configSnapshotHash,
    reducerVersion,
    packetBuilderVersion,
    packetSchemaVersion,
    precedencePolicyVersion,
    precedencePolicyHash,
  });
}

module.exports = Object.freeze({
  CONFIGURED_KEYS,
  CONFIG_SNAPSHOT_SCHEMA_VERSION,
  CONFIG_SNAPSHOT_VERSION_PREFIX,
  CONFIGURED_DETERMINISTIC_IDENTITY,
  DEFAULT_PROCESSING_CONFIG,
  GMAIL_PROMPT_VERSION,
  LEGACY_UNWATERMARKED_STATUS,
  OBSERVED_KEYS,
  OBSERVED_DETERMINISTIC_SENTINEL,
  PROCESSING_CONFIG_KEYS,
  PROCESSING_WATERMARK_SCHEMA_VERSION,
  SOURCE_PROCESSING_IDENTITIES,
  TruthProcessingWatermarkError,
  WATERMARKED_STATUS,
  createConfiguredProcessingWatermark,
  normalizeConfiguredProcessingWatermark,
  normalizeProcessingConfig,
  normalizeObservedProcessingWatermark,
  normalizeProcessingWatermark,
  processingWatermarkHash,
  validateProcessingWatermarkFields,
  _test: Object.freeze({
    EXTRACTOR_TUPLE_KEYS,
    ENTITY_LINKER_TUPLE_KEYS,
    WORKGROUP_CREATOR_TUPLE_KEYS,
    WORKGROUP_MEMBERSHIP_TUPLE_KEYS,
    canonicalize,
    compareExtractorTuples,
    compareCanonicalTuples,
    configuredSetIdentity,
    postgresJsonbHash,
    sameJson,
  }),
});

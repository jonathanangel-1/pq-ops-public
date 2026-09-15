"use strict";

const crypto = require("node:crypto");
const DEFAULT_POLICY_JSON = require("../config/truth-precedence-policy-v1.json");

const SCHEMA_VERSION = "truth-precedence-policy-v1";
const ALLOWED_CRITERIA = new Set([
  "event_time",
  "subject_specificity",
  "responsible_actor",
  "evidence_directness",
  "source_class",
  "confidence",
  "captured_at",
  "stable_identifier",
]);
const ALLOWED_TIME_FIELDS = new Set(["occurredAt", "capturedAt", "recordedAt"]);

class TruthPrecedencePolicyError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthPrecedencePolicyError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidPolicy(field, reason) {
  return new TruthPrecedencePolicyError(`Invalid truth precedence policy ${field}: ${reason}`, {
    code: "TRUTH_PRECEDENCE_POLICY_INVALID",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, field = "policy") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalidPolicy(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) output[key] = cloneJson(value[key], `${field}.${key}`);
    }
    return output;
  }
  throw invalidPolicy(field, "must contain only JSON values");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(value, allowed, field) {
  if (!isPlainObject(value)) throw invalidPolicy(field, "must be an object");
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw invalidPolicy(field, `contains unsupported keys: ${extras.sort().join(", ")}`);
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw invalidPolicy(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > 1000) throw invalidPolicy(field, "is too long");
  return value;
}

function rankMap(value, field, { normalizedKeys = true } = {}) {
  if (!isPlainObject(value)) throw invalidPolicy(field, "must be an object");
  const output = {};
  for (const [key, rank] of Object.entries(value)) {
    const token = requiredString(key, `${field}.key`);
    if (normalizedKeys && token !== normalizedToken(token)) {
      throw invalidPolicy(`${field}.${key}`, "key must be normalized snake_case");
    }
    if (!Number.isSafeInteger(rank) || rank < 0 || rank > 1_000_000) {
      throw invalidPolicy(`${field}.${key}`, "rank must be an integer from 0 through 1000000");
    }
    output[key] = rank;
  }
  if (!Object.prototype.hasOwnProperty.call(output, "unknown")) output.unknown = 0;
  return output;
}

function aliases(value, field) {
  if (!isPlainObject(value)) throw invalidPolicy(field, "must be an object");
  const output = {};
  for (const [alias, canonical] of Object.entries(value)) {
    const normalizedAlias = normalizedToken(alias);
    const normalizedCanonical = normalizedToken(canonical);
    if (!normalizedAlias || alias !== normalizedAlias || !normalizedCanonical || canonical !== normalizedCanonical) {
      throw invalidPolicy(`${field}.${alias}`, "alias and value must be normalized snake_case tokens");
    }
    output[alias] = canonical;
  }
  return output;
}

function validatePolicy(input = DEFAULT_POLICY_JSON) {
  const policy = cloneJson(input);
  exactKeys(policy, [
    "schemaVersion",
    "policyVersion",
    "description",
    "criteria",
    "eventTime",
    "subjectSpecificity",
    "sourceClasses",
    "evidenceDirectness",
    "defaultActorRanks",
    "gateActorRanks",
    "aliases",
  ], "policy");
  if (policy.schemaVersion !== SCHEMA_VERSION) {
    throw invalidPolicy("schemaVersion", `must equal ${SCHEMA_VERSION}`);
  }
  requiredString(policy.policyVersion, "policyVersion");
  requiredString(policy.description, "description");
  if (!Array.isArray(policy.criteria) || policy.criteria.length !== ALLOWED_CRITERIA.size) {
    throw invalidPolicy("criteria", "must contain every supported criterion exactly once");
  }
  const criterionSet = new Set(policy.criteria);
  if (criterionSet.size !== policy.criteria.length || [...criterionSet].some((item) => !ALLOWED_CRITERIA.has(item))) {
    throw invalidPolicy("criteria", "contains duplicates or unsupported criteria");
  }
  for (const criterion of ALLOWED_CRITERIA) {
    if (!criterionSet.has(criterion)) throw invalidPolicy("criteria", `omits ${criterion}`);
  }

  exactKeys(policy.eventTime, ["fields", "basisRanks"], "eventTime");
  if (!Array.isArray(policy.eventTime.fields) || policy.eventTime.fields.length !== ALLOWED_TIME_FIELDS.size) {
    throw invalidPolicy("eventTime.fields", "must contain every supported time field exactly once");
  }
  const timeFields = new Set(policy.eventTime.fields);
  if (timeFields.size !== policy.eventTime.fields.length || [...timeFields].some((item) => !ALLOWED_TIME_FIELDS.has(item))) {
    throw invalidPolicy("eventTime.fields", "contains duplicates or unsupported fields");
  }
  policy.eventTime.basisRanks = rankMap(policy.eventTime.basisRanks, "eventTime.basisRanks", {
    normalizedKeys: false,
  });
  for (const field of ALLOWED_TIME_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(policy.eventTime.basisRanks, field)) {
      throw invalidPolicy("eventTime.basisRanks", `omits ${field}`);
    }
  }
  policy.subjectSpecificity = rankMap(policy.subjectSpecificity, "subjectSpecificity");
  policy.evidenceDirectness = rankMap(policy.evidenceDirectness, "evidenceDirectness");
  policy.defaultActorRanks = rankMap(policy.defaultActorRanks, "defaultActorRanks");

  if (!isPlainObject(policy.sourceClasses) || !isPlainObject(policy.sourceClasses.unknown)) {
    throw invalidPolicy("sourceClasses", "must be an object containing unknown");
  }
  for (const [sourceClass, definition] of Object.entries(policy.sourceClasses)) {
    if (sourceClass !== normalizedToken(sourceClass)) {
      throw invalidPolicy(`sourceClasses.${sourceClass}`, "key must be normalized snake_case");
    }
    exactKeys(definition, ["rank", "label"], `sourceClasses.${sourceClass}`);
    if (!Number.isSafeInteger(definition.rank) || definition.rank < 0 || definition.rank > 1_000_000) {
      throw invalidPolicy(`sourceClasses.${sourceClass}.rank`, "must be a bounded non-negative integer");
    }
    requiredString(definition.label, `sourceClasses.${sourceClass}.label`);
  }

  if (!isPlainObject(policy.gateActorRanks)) throw invalidPolicy("gateActorRanks", "must be an object");
  for (const [gate, ranks] of Object.entries(policy.gateActorRanks)) {
    if (gate !== normalizedToken(gate)) throw invalidPolicy(`gateActorRanks.${gate}`, "gate must be normalized");
    policy.gateActorRanks[gate] = rankMap(ranks, `gateActorRanks.${gate}`);
  }
  exactKeys(policy.aliases, ["actors", "directness"], "aliases");
  policy.aliases.actors = aliases(policy.aliases.actors, "aliases.actors");
  policy.aliases.directness = aliases(policy.aliases.directness, "aliases.directness");

  const policyHash = sha256Json(policy);
  return deepFreeze({ ...policy, policyHash });
}

function normalizedToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function finiteTimestamp(value) {
  if (value === null || value === undefined || value === "") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function claimEventTime(claim, policy) {
  for (const field of policy.eventTime.fields) {
    const value = finiteTimestamp(claim?.[field]);
    if (value !== Number.NEGATIVE_INFINITY) {
      return { value, basis: field, basisRank: policy.eventTime.basisRanks[field] };
    }
  }
  return { value: Number.NEGATIVE_INFINITY, basis: "unknown", basisRank: policy.eventTime.basisRanks.unknown || 0 };
}

function aliasToken(value, map) {
  const token = normalizedToken(value) || "unknown";
  return map[token] || token;
}

function inferredDirectness(claim) {
  const value = isPlainObject(claim?.normalizedValue) ? claim.normalizedValue : {};
  const explicit = value.evidenceDirectness || value.directness || claim?.evidenceDirectness;
  if (explicit) return normalizedToken(explicit);
  const evidence = Array.isArray(claim?.evidence) ? claim.evidence : [];
  const spans = [claim?.evidenceSpan, ...evidence.map((item) => item?.evidenceSpan)].filter(isPlainObject);
  if (spans.some((span) => /signature|signed|receiver/i.test(String(span.field || span.documentKind || "")))) {
    return "signed_document";
  }
  // Do not infer directness merely from transport. A TMS row may be a stale
  // summary, an email may quote somebody else, and an attachment may be an
  // instruction rather than proof. Extractors must label directness from the
  // cited content; otherwise source class remains the explicit fallback.
  return "unknown";
}

function actorForClaim(claim, policy) {
  const value = isPlainObject(claim?.normalizedValue) ? claim.normalizedValue : {};
  const raw = value.responsibleActor || value.actorRole || value.sourceActor || claim?.responsibleActor || "unknown";
  return aliasToken(raw, policy.aliases.actors);
}

function directnessForClaim(claim, policy) {
  return aliasToken(inferredDirectness(claim), policy.aliases.directness);
}

function sourceClassForPolicy(claim, policy) {
  const token = normalizedToken(claim?.sourceClass) || "unknown";
  return Object.prototype.hasOwnProperty.call(policy.sourceClasses, token) ? token : "unknown";
}

function priorityVector(claim, inputPolicy = DEFAULT_POLICY) {
  const policy = inputPolicy.policyHash ? inputPolicy : validatePolicy(inputPolicy);
  const eventTime = claimEventTime(claim, policy);
  const gate = normalizedToken(claim?.gate) || "context";
  const actor = actorForClaim(claim, policy);
  const directness = directnessForClaim(claim, policy);
  const sourceClass = sourceClassForPolicy(claim, policy);
  const gateActorRanks = policy.gateActorRanks[gate] || {};
  const actorRank = gateActorRanks[actor] ?? policy.defaultActorRanks[actor] ?? policy.defaultActorRanks.unknown ?? 0;
  const confidence = Number(claim?.confidence);
  return deepFreeze({
    event_time: eventTime.value,
    subject_specificity: policy.subjectSpecificity[normalizedToken(claim?.subjectType)]
      ?? policy.subjectSpecificity.unknown ?? 0,
    responsible_actor: actorRank,
    evidence_directness: policy.evidenceDirectness[directness] ?? policy.evidenceDirectness.unknown ?? 0,
    source_class: policy.sourceClasses[sourceClass].rank,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    captured_at: finiteTimestamp(claim?.capturedAt),
    stable_identifier: String(claim?.claimVersionId || ""),
    metadata: {
      eventTimeBasis: eventTime.basis,
      eventTimeBasisRank: eventTime.basisRank,
      actor,
      directness,
      sourceClass,
      gate,
    },
  });
}

function compareScalar(left, right) {
  if (typeof left === "string" || typeof right === "string") return String(left).localeCompare(String(right));
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareClaimPriority(left, right, inputPolicy = DEFAULT_POLICY) {
  const policy = inputPolicy.policyHash ? inputPolicy : validatePolicy(inputPolicy);
  const leftVector = priorityVector(left, policy);
  const rightVector = priorityVector(right, policy);
  for (const criterion of policy.criteria) {
    const comparison = compareScalar(leftVector[criterion], rightVector[criterion]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function explainPriority(winner, loser, inputPolicy = DEFAULT_POLICY) {
  const policy = inputPolicy.policyHash ? inputPolicy : validatePolicy(inputPolicy);
  const winnerVector = priorityVector(winner, policy);
  const loserVector = priorityVector(loser, policy);
  let decisiveCriterion = "equivalent";
  for (const criterion of policy.criteria) {
    if (compareScalar(winnerVector[criterion], loserVector[criterion]) !== 0) {
      decisiveCriterion = criterion;
      break;
    }
  }
  return deepFreeze({
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    decisiveCriterion,
    winnerClaimVersionId: String(winner?.claimVersionId || ""),
    loserClaimVersionId: String(loser?.claimVersionId || ""),
    winnerVector,
    loserVector,
  });
}

const DEFAULT_POLICY = validatePolicy(DEFAULT_POLICY_JSON);

module.exports = {
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  TruthPrecedencePolicyError,
  actorForClaim,
  claimEventTime,
  compareClaimPriority,
  directnessForClaim,
  explainPriority,
  priorityVector,
  validatePolicy,
  _test: {
    canonicalize,
    finiteTimestamp,
    normalizedToken,
    sha256Json,
    stableJson,
  },
};

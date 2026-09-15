"use strict";

// Pure evidence-to-candidate-claim boundary. This module performs no I/O and
// never accepts claims. It only returns immutable, versioned candidates that a
// separate policy/operator boundary may append to the accepted-claim ledger.

const crypto = require("node:crypto");
const { isAbortError, throwIfAborted } = require("./runtime-deadline");
const { ACTS, classifyClause } = require("./speech-acts");
const {
  PREDICATES,
  REGISTRY: PREDICATE_REGISTRY,
  modelPredicateCatalog,
} = require("./truth-predicate-registry");
const { resolveTemporalExpression } = require("./truth-temporal-resolver");
const { parseGmailInternalDate } = require("./gmail-rfc822-parser");

const SCHEMA_VERSION = "gmail-candidate-claim-v1";
const EXTRACTION_PLAN_SCHEMA_VERSION = "gmail-claim-extraction-plan-v3";
const MODEL_INPUT_SCHEMA_VERSION = "gmail-claim-extraction-model-input-v2";
const MODEL_PLAN_SCHEMA_VERSION = "gmail-model-extraction-plan-v2";
const EXTRACTOR_VERSION = `gmail-claim-extractor-v8-model-modality-signal-anchor+predicates:${PREDICATE_REGISTRY.registryHash}`;
const DETERMINISTIC_EXTRACTOR_VERSION = `gmail-claim-extractor-v7-segment-temporal-server-semantic-quote-boundary-source-chronology+predicates:${PREDICATE_REGISTRY.registryHash}`;
const PROMPT_VERSION = "gmail-claim-extraction-prompt-v4";
const MODEL_RESPONSE_SCHEMA = "gmail-model-candidate-claims-v4";
const ACCEPTANCE_POLICY_VERSION = `gmail-candidate-acceptance-v6-segment-temporal-server-semantic-quote-boundary-source-chronology+${PREDICATE_REGISTRY.registryVersion}`;
const GMAIL_SOURCE_CHRONOLOGY_SCHEMA_VERSION = "gmail-source-chronology-v1";
const MAX_GMAIL_SOURCE_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const CLAIM_VERSION_ID_RE = /^claim:v1:[0-9a-f]{64}$/;
const WORKGROUP_ID_RE = /^workgroup:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_CLAIMS = 50;
const MAX_MODEL_PLAN_RANGES = MAX_MODEL_CLAIMS;
const MAX_MODEL_PLAN_BYTES = 512 * 1024;
const QUOTE_BOUNDARY_RE = /^(?:[ \t]*>+[ \t]?|On [^\r\n]{5,} wrote:[ \t]*|From:[^\r\n]*\r?\n(?:Sent|Date):[^\r\n]*(?:\r?\n(?:To|Cc|Subject):[^\r\n]*)*|-{2,}[ \t]*(?:Forwarded message|Original Message)[ \t]*-*|Begin forwarded message:[ \t]*|(?:El|Le|Am|Op|Il|Em)[^\r\n]+(?:escribió|a écrit|schrieb|schreef|ha scritto|escreveu)[ \t]*:|בתאריך[^\r\n]+(?:כתב|כתבה|כתבו|נכתב)[ \t]*:|在[^\r\n]+写道[：:]|[^\r\n]+さんは書きました[：:]|_{10,})/im;

const MODEL_CLAIM_KEYS = Object.freeze([
  "subjectType",
  "subjectKey",
  "appliesToAwbs",
  "predicate",
  "gate",
  "polarity",
  "normalizedValue",
  "occurredAt",
  "confidence",
  "evidenceSpan",
  "ambiguityReasons",
]);

const MODEL_SPAN_KEYS = Object.freeze(["start", "end", "quote"]);
const MODEL_VALUE_KEYS = Object.freeze(["status"]);
const POLARITIES = new Set(["positive", "negative", "requested", "neutral", "unknown"]);
const REQUEST_ACTS = new Set([
  ACTS.ASKS_ABOUT_STATE,
  ACTS.REQUESTS_UPDATE,
  ACTS.REQUESTS_DOCUMENT,
  ACTS.ASKS_US_TO_VERIFY,
]);

const MODEL_RESPONSE_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "claims"],
  properties: {
    schemaVersion: { type: "string", enum: [MODEL_RESPONSE_SCHEMA] },
    claims: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MODEL_CLAIMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [...MODEL_CLAIM_KEYS],
        properties: {
          subjectType: { type: "string", enum: ["shipment", "workgroup"] },
          subjectKey: { type: "string", minLength: 1, maxLength: 256 },
          appliesToAwbs: {
            type: "array",
            minItems: 1,
            items: { type: "string", pattern: "^\\d{3}[- ]?\\d{8}$" },
          },
          predicate: { type: "string", enum: Object.keys(PREDICATES).sort() },
          gate: {
            type: "string",
            enum: [...new Set(Object.values(PREDICATES).map((item) => item.gate))].sort(),
          },
          polarity: { type: "string", enum: [...POLARITIES].sort() },
          normalizedValue: {
            type: "object",
            additionalProperties: false,
            required: [...MODEL_VALUE_KEYS],
            properties: {
              status: {
                type: "string",
                enum: [...new Set(Object.values(PREDICATES)
                  .flatMap((item) => Object.values(item.statuses)))].sort(),
              },
            },
          },
          occurredAt: { type: "null" },
          confidence: { type: "number", minimum: 0, maximum: 0.95 },
          evidenceSpan: {
            type: "object",
            additionalProperties: false,
            required: [...MODEL_SPAN_KEYS],
            properties: {
              start: { type: "integer", minimum: 0 },
              end: { type: "integer", minimum: 1 },
              quote: { type: "string", minLength: 1 },
            },
          },
          ambiguityReasons: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
  },
});

class GmailClaimExtractorError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailClaimExtractorError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailClaimExtractorError(`Invalid Gmail claim extraction argument ${field}: ${reason}`, {
    code: "GMAIL_CLAIM_INVALID_ARGUMENT",
    field,
  });
}

function rejectModel(field, reason) {
  return new GmailClaimExtractorError(`Rejected Gmail claim model output at ${field}: ${reason}`, {
    code: "GMAIL_CLAIM_MODEL_OUTPUT_REJECTED",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 20) throw invalidArgument(field, "exceeds the maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw invalidArgument(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) result[key] = cloneJson(value[key], `${field}.${key}`, depth + 1);
    }
    return result;
  }
  throw invalidArgument(field, "must contain only JSON-compatible values");
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function requireString(value, field, { allowEmpty = false, maxBytes = 1024 * 1024 } = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && !value) throw invalidArgument(field, "must not be empty");
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalidArgument(field, "is too long");
  return value;
}

function exactKeys(value, allowed, required, field, rejection = false) {
  const fail = rejection ? rejectModel : invalidArgument;
  if (!isPlainObject(value)) throw fail(field, "must be an object");
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw fail(`${field}.${key}`, "is unsupported");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw fail(`${field}.${key}`, "is required");
  }
}

function normalizeAwb(value, field = "awb", rejection = false) {
  const fail = rejection ? rejectModel : invalidArgument;
  if (typeof value !== "string") throw fail(field, "must be a string");
  const match = value.match(/^(\d{3})[-\s]?(\d{8})$/);
  if (!match) throw fail(field, "must be an exact 11-digit AWB");
  return `${match[1]}${match[2]}`;
}

function normalizeAwbList(value, field, { allowEmpty = true, rejection = false } = {}) {
  const fail = rejection ? rejectModel : invalidArgument;
  if (!Array.isArray(value)) throw fail(field, "must be an array");
  const result = [...new Set(value.map((item, index) => normalizeAwb(item, `${field}[${index}]`, rejection)))].sort();
  if (!allowEmpty && result.length === 0) throw fail(field, "must not be empty");
  if (result.length !== value.length) throw fail(field, "must contain unique AWBs");
  return result;
}

function normalizeStringList(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw invalidArgument(field, "must be an array");
  const result = [...new Set(value.map((item, index) => {
    const text = requireString(item, `${field}[${index}]`, { maxBytes: 8192 });
    if (text.trim() !== text) throw invalidArgument(`${field}[${index}]`, "must not contain surrounding whitespace");
    return text;
  }))].sort();
  if (!allowEmpty && result.length === 0) throw invalidArgument(field, "must not be empty");
  if (result.length !== value.length) throw invalidArgument(field, "must contain unique values");
  return result;
}

function normalizeTimestamp(value, field, { nullable = false, preserveMicroseconds = false } = {}) {
  if (nullable && (value === null || value === "" || value === undefined)) return null;
  const text = requireString(value, field, { maxBytes: 100 });
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw invalidArgument(field, "must be an ISO timestamp");
  const canonical = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/);
  if (preserveMicroseconds && canonical) return `${canonical[1]}.${canonical[2]}Z`;
  return new Date(time).toISOString();
}

function addressText(items) {
  return items.flatMap((item) => item?.group || [item])
    .filter(Boolean)
    .map((item) => {
      const name = String(item.name || "");
      const address = String(item.address || "");
      return [name, address].filter(Boolean).join(" <") + (name && address ? ">" : "");
    })
    .filter(Boolean)
    .join(", ");
}

function buildNormalizedText(parsed) {
  return [
    parsed.subject ? `Subject: ${parsed.subject}` : "",
    parsed.from ? `From: ${addressText([parsed.from])}` : "",
    Array.isArray(parsed.to) && parsed.to.length ? `To: ${addressText(parsed.to)}` : "",
    Array.isArray(parsed.cc) && parsed.cc.length ? `Cc: ${addressText(parsed.cc)}` : "",
    parsed.date ? `Date: ${parsed.date}` : "",
    parsed.text || "",
  ].filter(Boolean).join("\n");
}

function normalizeObservation(value) {
  if (!isPlainObject(value)) throw invalidArgument("observation", "must be an object");
  const observationId = requireString(value.observationId, "observation.observationId", { maxBytes: 80 });
  if (!OBSERVATION_ID_RE.test(observationId)) throw invalidArgument("observation.observationId", "must be an obs:v1 SHA-256 identity");
  if (value.sourceSystem !== "gmail") throw invalidArgument("observation.sourceSystem", "must equal gmail");
  if (!["gmail_message_parsed", "gmail_attachment_claim_projection"].includes(value.sourceObjectType)) {
    throw invalidArgument(
      "observation.sourceObjectType",
      "must equal gmail_message_parsed or gmail_attachment_claim_projection",
    );
  }
  if (value.operation !== undefined && value.operation !== "content") {
    throw invalidArgument("observation.operation", "must equal content");
  }
  const contentHash = requireString(value.contentHash, "observation.contentHash", { maxBytes: 64 });
  if (!HASH_RE.test(contentHash)) throw invalidArgument("observation.contentHash", "must be lowercase SHA-256 hex");
  const normalizedPayload = cloneJson(value.normalizedPayload, "observation.normalizedPayload");
  const expectedPayloadSchema = value.sourceObjectType === "gmail_message_parsed"
    ? "gmail-parsed-message-v2"
    : "gmail-attachment-claim-projection-v1";
  if (!isPlainObject(normalizedPayload) || normalizedPayload.schemaVersion !== expectedPayloadSchema) {
    throw invalidArgument(
      "observation.normalizedPayload",
      `must be a ${expectedPayloadSchema} object`,
    );
  }
  if (!isPlainObject(normalizedPayload.gmail)) {
    throw invalidArgument("observation.normalizedPayload.gmail", "must be an object");
  }
  requireString(normalizedPayload.gmail.messageId, "observation.normalizedPayload.gmail.messageId", { maxBytes: 8192 });
  requireString(normalizedPayload.gmail.threadId, "observation.normalizedPayload.gmail.threadId", { maxBytes: 8192 });
  requireString(normalizedPayload.text, "observation.normalizedPayload.text", { allowEmpty: true, maxBytes: 16 * 1024 * 1024 });
  if (sha256Json(normalizedPayload) !== contentHash) {
    throw invalidArgument("observation.contentHash", "does not match the parsed payload");
  }
  const normalizedText = requireString(value.normalizedText, "observation.normalizedText", {
    allowEmpty: true,
    maxBytes: 16 * 1024 * 1024,
  });
  const rebuiltText = buildNormalizedText(normalizedPayload);
  if (normalizedText !== rebuiltText) {
    throw invalidArgument("observation.normalizedText", "does not match the immutable parsed payload");
  }
  const body = normalizedPayload.text;
  const bodyStart = body ? normalizedText.lastIndexOf(body) : normalizedText.length;
  if (body && bodyStart < 0) throw invalidArgument("observation.normalizedText", "does not contain the parsed message body");
  const quoteMatch = body.match(QUOTE_BOUNDARY_RE);
  const currentLength = quoteMatch && quoteMatch.index !== undefined ? quoteMatch.index : body.length;
  const currentStart = bodyStart;
  const currentEnd = bodyStart + currentLength;
  const quoteBoundaryMarker = quoteMatch?.[0] || "";
  const quoteBoundaryKind = quoteBoundaryMarker && (
    /Forwarded message|Original Message|Begin forwarded message|_{10,}/i.test(quoteBoundaryMarker)
  ) ? "forwarded_or_original" : quoteBoundaryMarker ? "reply_history" : "none";
  const sourceCapturedAt = value.capturedAt === undefined || value.capturedAt === null
    ? null
    : normalizeTimestamp(value.capturedAt, "observation.capturedAt", { preserveMicroseconds: true });
  const sourceRecordedAtBinding = value.sourceRecordedAt === undefined || value.sourceRecordedAt === null
    ? null
    : normalizeTimestamp(value.sourceRecordedAt, "observation.sourceRecordedAt", {
      preserveMicroseconds: true,
    });
  const suppliedSourceRecordedAt = sourceRecordedAtBinding === null
    ? null
    : normalizeTimestamp(sourceRecordedAtBinding, "observation.sourceRecordedAt");
  const chronology = normalizedPayload.sourceChronology;
  let sourceRecordedAt = null;
  if (chronology !== undefined && chronology !== null) {
    exactKeys(
      chronology,
      [
        "schemaVersion", "sourceRecordedAt", "sourceRecordedAtBasis", "providerReceivedAt",
        "providerInternalDateMillis", "rfc5322Date",
      ],
      [
        "schemaVersion", "sourceRecordedAt", "sourceRecordedAtBasis", "providerReceivedAt",
        "providerInternalDateMillis", "rfc5322Date",
      ],
      "observation.normalizedPayload.sourceChronology",
    );
    const internalDate = parseGmailInternalDate(
      normalizedPayload.gmail.internalDate,
      "observation.normalizedPayload.gmail.internalDate",
    );
    sourceRecordedAt = normalizeTimestamp(
      chronology.sourceRecordedAt,
      "observation.normalizedPayload.sourceChronology.sourceRecordedAt",
    );
    if (chronology.schemaVersion !== GMAIL_SOURCE_CHRONOLOGY_SCHEMA_VERSION
      || chronology.sourceRecordedAtBasis !== "gmail_internal_date"
      || chronology.providerInternalDateMillis !== internalDate.raw
      || sourceRecordedAt !== internalDate.sourceRecordedAt
      || chronology.providerReceivedAt !== sourceRecordedAt
      || normalizedPayload.gmail.providerReceivedAt !== sourceRecordedAt
      || suppliedSourceRecordedAt !== sourceRecordedAt) {
      throw invalidArgument(
        "observation.sourceRecordedAt",
        "must match the immutable Gmail internalDate chronology",
      );
    }
    if (sourceCapturedAt
      && Date.parse(sourceRecordedAt) > Date.parse(sourceCapturedAt) + MAX_GMAIL_SOURCE_FUTURE_SKEW_MS) {
      throw invalidArgument("observation.sourceRecordedAt", "is impossibly ahead of capture time");
    }
  } else if (suppliedSourceRecordedAt !== null
    || normalizedPayload.gmail.providerReceivedAt !== undefined
    || /source-chronology/i.test(String(normalizedPayload.parserVersion || ""))) {
    throw invalidArgument(
      "observation.normalizedPayload.sourceChronology",
      "is required when sourceRecordedAt is supplied",
    );
  }
  return deepFreeze({
    observationId,
    contentHash,
    normalizedPayload,
    normalizedText,
    currentText: body.slice(0, currentLength),
    currentStart,
    currentEnd,
    quoteBoundaryMarker,
    quoteBoundaryKind,
    quotedTailText: body.slice(currentLength),
    messageId: normalizedPayload.gmail.messageId,
    threadId: normalizedPayload.gmail.threadId,
    subject: String(normalizedPayload.subject || ""),
    sourceRecordedAt,
    sourceRecordedAtBinding,
    sourceCapturedAt,
  });
}

function normalizeWorkgroup(value, observation) {
  if (value === undefined || value === null) return null;
  exactKeys(
    value,
    ["workgroupId", "memberAwbs", "observationAwbs", "linkedThreadIds", "linkedObservationIds"],
    ["workgroupId", "memberAwbs", "observationAwbs", "linkedThreadIds", "linkedObservationIds"],
    "workgroupContext",
  );
  const workgroupId = requireString(value.workgroupId, "workgroupContext.workgroupId", { maxBytes: 80 });
  if (!WORKGROUP_ID_RE.test(workgroupId)) throw invalidArgument("workgroupContext.workgroupId", "must be a workgroup:v1 SHA-256 identity");
  const memberAwbs = normalizeAwbList(value.memberAwbs, "workgroupContext.memberAwbs", { allowEmpty: false });
  if (memberAwbs.length < 2) throw invalidArgument("workgroupContext.memberAwbs", "must contain at least two members");
  const observationAwbs = normalizeAwbList(value.observationAwbs, "workgroupContext.observationAwbs");
  if (observationAwbs.some((awb) => !memberAwbs.includes(awb))) {
    throw invalidArgument("workgroupContext.observationAwbs", "must be a subset of memberAwbs");
  }
  const linkedThreadIds = normalizeStringList(value.linkedThreadIds, "workgroupContext.linkedThreadIds");
  const linkedObservationIds = normalizeStringList(value.linkedObservationIds, "workgroupContext.linkedObservationIds");
  if (linkedObservationIds.some((item) => !OBSERVATION_ID_RE.test(item))) {
    throw invalidArgument("workgroupContext.linkedObservationIds", "must contain only obs:v1 SHA-256 identities");
  }
  if (!linkedThreadIds.includes(observation.threadId) && !linkedObservationIds.includes(observation.observationId)) {
    throw invalidArgument("workgroupContext", "must bind the current Gmail thread or observation");
  }
  return deepFreeze({ workgroupId, memberAwbs, observationAwbs, linkedThreadIds, linkedObservationIds });
}

function extractAwbs(text) {
  const result = new Set();
  const pattern = /(?:^|\D)(\d{3})[-\s]?(\d{8})(?!\d)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) result.add(`${match[1]}${match[2]}`);
  return [...result].sort();
}

function clauseRanges(text, offset) {
  const result = [];
  const pattern = /[^\n.!?]+[.!?]?/g;
  let match;
  while ((match = pattern.exec(text))) {
    const leading = match[0].match(/^\s*/)[0].length;
    const trailing = match[0].match(/\s*$/)[0].length;
    const start = offset + match.index + leading;
    const end = offset + match.index + match[0].length - trailing;
    if (end > start) result.push({ start, end, quote: text.slice(start - offset, end - offset) });
  }
  return result;
}

function clauseSemanticSegments(clause) {
  const segments = [];
  const boundaries = [];
  const separators = /\s+(?:and|but|while|whereas|however)\s+|\s*;\s*/giu;
  const awbAnchors = /\d{3}[-\s]?\d{8}(?!\d)/gu;
  let match;
  while ((match = separators.exec(clause.quote))) {
    boundaries.push({ start: match.index, end: match.index + match[0].length });
  }
  let awbOrdinal = 0;
  while ((match = awbAnchors.exec(clause.quote))) {
    awbOrdinal += 1;
    // A later explicit AWB always starts a new semantic authority unit. This
    // covers comma/newline-list/slash formatting without letting the first
    // shipment's predicate or date leak onto the next shipment.
    if (awbOrdinal > 1) boundaries.push({ start: match.index, end: match.index });
  }
  boundaries.sort((left, right) => left.start - right.start || left.end - right.end);
  let relativeStart = 0;
  const append = (relativeEnd) => {
    const raw = clause.quote.slice(relativeStart, relativeEnd);
    const leading = raw.match(/^\s*/u)?.[0].length || 0;
    const trailing = raw.match(/\s*$/u)?.[0].length || 0;
    const start = clause.start + relativeStart + leading;
    const end = clause.start + relativeEnd - trailing;
    if (end > start) segments.push({
      start,
      end,
      quote: clause.quote.slice(relativeStart + leading, relativeEnd - trailing),
    });
  };
  for (const boundary of boundaries) {
    if (boundary.start < relativeStart) continue;
    append(boundary.start);
    relativeStart = Math.max(relativeStart, boundary.end);
  }
  append(clause.quote.length);
  return segments;
}

function groupLanguage(text) {
  const value = String(text || "");
  const match = value.match(/\b(?:all\s+(?:(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(?:shipments|loads|awbs)|both\s+(?:shipments|loads|awbs)|these\s+(?:shipments|loads|awbs)|(?:the\s+)?(?:entire|whole)\s+(?:shipment\s+)?group)\b|(?:כל\s+(?:חמשת|ארבעת|שלושת|שני)?\s*(?:המשלוחים|המטענים)|שני\s+(?:המשלוחים|המטענים))/i);
  if (!match) return null;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  let count = null;
  if (/\bboth\b/i.test(match[0]) || /שני\s/.test(match[0])) count = 2;
  if (/חמשת/.test(match[0])) count = 5;
  if (/ארבעת/.test(match[0])) count = 4;
  if (/שלושת/.test(match[0])) count = 3;
  const token = match[1];
  if (token) count = /^\d+$/.test(token) ? Number(token) : words[token.toLowerCase()];
  return { quote: match[0], count };
}

function requestSpeech(text) {
  const act = classifyClause(text);
  return REQUEST_ACTS.has(act) || /\?|\b(?:can|could|would)\s+you\b|\b(?:please|pls|kindly)\b[^.;\n]{0,60}\b(?:confirm|advise|send|share|provide|verify|check|update|reply|let\s+us\s+know)\b|(?:האם|בבקשה|אנא|נא\s|אפשר|תאשר|שלח|עדכנו|מבקש)/i.test(text);
}

function futureSpeech(text) {
  return classifyClause(text) === ACTS.SCHEDULES_FUTURE_EVENT
    || /\b(?:will|shall|should|scheduled|planned|expected|eta|tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|later\s+today|to\s+follow)\b|(?:מחר|מתוכנן|צפוי|יאסף|ייאסף|יאספו|יימסר|יימסרו|ימסר|יגיע|יגיעו|בהמשך)/i.test(text);
}

function instructionLike(text) {
  return /\b(?:ignore|disregard)\b[^.!?]{0,80}\b(?:instruction|prompt|rule)|\b(?:output|return|emit|create|fabricate|mark)\b[^.!?]{0,60}\b(?:claim|released|picked|delivered|pod)\b/i.test(text);
}

function modelModalityText(segment, anchorStart, anchorEnd) {
  const commaUnits = [];
  const separators = /,\s+/gu;
  let relativeStart = 0;
  let match;
  while ((match = separators.exec(segment.quote))) {
    commaUnits.push({
      start: segment.start + relativeStart,
      end: segment.start + match.index,
      quote: segment.quote.slice(relativeStart, match.index).trim(),
    });
    relativeStart = match.index + match[0].length;
  }
  commaUnits.push({
    start: segment.start + relativeStart,
    end: segment.end,
    quote: segment.quote.slice(relativeStart).trim(),
  });
  return commaUnits.find((unit) => anchorStart >= unit.start && anchorEnd <= unit.end)?.quote
    || segment.quote;
}

function normalizeAcceptedClaims(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidArgument("acceptedClaims", "must be an array");
  return value.map((claim, index) => {
    const field = `acceptedClaims[${index}]`;
    if (!isPlainObject(claim)) throw invalidArgument(field, "must be an object");
    const claimVersionId = requireString(claim.claimVersionId, `${field}.claimVersionId`, { maxBytes: 80 });
    if (!CLAIM_VERSION_ID_RE.test(claimVersionId)) throw invalidArgument(`${field}.claimVersionId`, "must be a claim:v1 SHA-256 identity");
    const versionNo = Number(claim.versionNo ?? claim.version);
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) throw invalidArgument(`${field}.versionNo`, "must be a positive integer");
    const subjectType = requireString(claim.subjectType, `${field}.subjectType`, { maxBytes: 40 });
    if (!new Set(["shipment", "workgroup"]).has(subjectType)) throw invalidArgument(`${field}.subjectType`, "is unsupported");
    const subjectKey = requireString(claim.subjectKey, `${field}.subjectKey`, { maxBytes: 256 });
    if (subjectType === "shipment") normalizeAwb(subjectKey, `${field}.subjectKey`);
    if (subjectType === "workgroup" && !WORKGROUP_ID_RE.test(subjectKey)) {
      throw invalidArgument(`${field}.subjectKey`, "must be a workgroup:v1 identity");
    }
    const predicate = requireString(claim.predicate, `${field}.predicate`, { maxBytes: 100 });
    if (!PREDICATES[predicate]) throw invalidArgument(`${field}.predicate`, "is unsupported");
    const gate = requireString(claim.gate, `${field}.gate`, { maxBytes: 40 });
    if (gate !== PREDICATES[predicate].gate) throw invalidArgument(`${field}.gate`, "does not match predicate");
    const polarity = requireString(claim.polarity, `${field}.polarity`, { maxBytes: 40 });
    if (!POLARITIES.has(polarity)) throw invalidArgument(`${field}.polarity`, "is unsupported");
    const normalizedValue = cloneJson(claim.normalizedValue || {}, `${field}.normalizedValue`);
    const claimKey = claim.claimKey || `${subjectType}:${subjectKey}:${predicate}`;
    const occurredAt = normalizeTimestamp(claim.occurredAt, `${field}.occurredAt`, {
      nullable: true,
      preserveMicroseconds: true,
    });
    const capturedAt = normalizeTimestamp(claim.capturedAt, `${field}.capturedAt`, {
      nullable: true,
      preserveMicroseconds: true,
    });
    const sourceRecordedAt = normalizeTimestamp(
      claim.sourceRecordedAt,
      `${field}.sourceRecordedAt`,
      { nullable: true, preserveMicroseconds: true },
    );
    return deepFreeze({
      claimVersionId,
      claimKey,
      versionNo,
      subjectType,
      subjectKey,
      predicate,
      gate,
      polarity,
      normalizedValue,
      occurredAt,
      capturedAt,
      sourceRecordedAt,
      appliesToAwbs: Array.isArray(claim.appliesToAwbs)
        ? normalizeAwbList(claim.appliesToAwbs, `${field}.appliesToAwbs`)
        : subjectType === "shipment" ? [normalizeAwb(subjectKey, `${field}.subjectKey`)] : [],
    });
  }).sort((left, right) => left.claimKey.localeCompare(right.claimKey) || left.versionNo - right.versionNo);
}

function targetsForSegment(clause, segment, segments, segmentIndex, observation, workgroup) {
  const group = groupLanguage(segment.quote);
  if (group && workgroup && (group.count === null || group.count === workgroup.memberAwbs.length)) {
    return [{ subjectType: "workgroup", subjectKey: workgroup.workgroupId, appliesToAwbs: workgroup.memberAwbs, groupScoped: true }];
  }
  // Group wording without an exactly matching, evidence-bound workgroup is an
  // unresolved entity-linking problem. Never silently downgrade it into a
  // subject-line shipment claim.
  if (group) return [];
  const localAwbs = extractAwbs(segment.quote);
  if (localAwbs.length === 1) {
    return [{ subjectType: "shipment", subjectKey: localAwbs[0], appliesToAwbs: [localAwbs[0]], groupScoped: false }];
  }
  if (localAwbs.length > 1) return [];
  const clauseAwbs = [...new Set(segments.flatMap((item) => extractAwbs(item.quote)))].sort();
  if (clauseAwbs.length === 1) {
    return [{ subjectType: "shipment", subjectKey: clauseAwbs[0], appliesToAwbs: [clauseAwbs[0]], groupScoped: false }];
  }
  const envelopeAwbs = extractAwbs(`${observation.subject}\n${observation.currentText}`);
  if (/\b(?:it|they|this|that|these|those)\b/iu.test(segment.quote)
      && (clauseAwbs.length > 1 || envelopeAwbs.length !== 1
        || segments.some((item) => groupLanguage(item.quote)))) return [];
  // A segment may inherit only the nearest earlier exact one-AWB anchor. This
  // preserves "AWB 1 picked up and delivered". An exact group anchor may also
  // be inherited by a predicate-only conjunct ("all shipments picked up and
  // delivered"), but any local AWB above wins and prevents group fan-out.
  for (let index = segmentIndex - 1; index >= 0; index -= 1) {
    const priorAwbs = extractAwbs(segments[index].quote);
    const priorGroup = groupLanguage(segments[index].quote);
    if (!priorAwbs.length && !priorGroup) continue;
    if (priorGroup) {
      if (workgroup && (priorGroup.count === null || priorGroup.count === workgroup.memberAwbs.length)) {
        return [{
          subjectType: "workgroup",
          subjectKey: workgroup.workgroupId,
          appliesToAwbs: workgroup.memberAwbs,
          groupScoped: true,
        }];
      }
      return [];
    }
    if (priorAwbs.length === 1) {
      return [{ subjectType: "shipment", subjectKey: priorAwbs[0], appliesToAwbs: [priorAwbs[0]], groupScoped: false }];
    }
    return [];
  }
  if (envelopeAwbs.length === 1) {
    return [{ subjectType: "shipment", subjectKey: envelopeAwbs[0], appliesToAwbs: [envelopeAwbs[0]], groupScoped: false }];
  }
  if (workgroup && workgroup.observationAwbs.length === 1) {
    const awb = workgroup.observationAwbs[0];
    return [{ subjectType: "shipment", subjectKey: awb, appliesToAwbs: [awb], groupScoped: false }];
  }
  return [];
}

function evidenceSpan(observation, start, end) {
  return {
    start,
    end,
    unit: "utf16_code_units",
    quote: observation.normalizedText.slice(start, end),
  };
}

function deterministicCoverageSpan(observation, clause, signalStart, signalEnd) {
  const segment = clauseSemanticSegments(clause).find(
    (item) => signalStart >= item.start && signalEnd <= item.end,
  );
  return segment
    ? evidenceSpan(observation, segment.start, segment.end)
    : evidenceSpan(observation, clause.start, clause.end);
}

function deterministicDrafts(observation, workgroup) {
  const drafts = [];
  for (const clause of clauseRanges(observation.currentText, observation.currentStart)) {
    const segments = clauseSemanticSegments(clause);
    for (const [segmentIndex, segment] of segments.entries()) {
      const group = groupLanguage(segment.quote);
      const targets = targetsForSegment(
        clause,
        segment,
        segments,
        segmentIndex,
        observation,
        workgroup,
      );
      if (!targets.length) continue;
      for (const [predicate, definition] of Object.entries(PREDICATES)) {
        if (!definition.topic.test(segment.quote)) continue;
        let polarity = null;
        let match = null;
        if (requestSpeech(segment.quote)) {
          polarity = "requested";
          match = { index: 0, 0: segment.quote };
        } else {
          match = segment.quote.match(definition.planned);
          if (match) {
            polarity = "neutral";
          } else {
            match = segment.quote.match(definition.negative);
            if (match) {
              polarity = "negative";
            } else {
              match = segment.quote.match(definition.positive);
              if (match && !futureSpeech(segment.quote) && !instructionLike(segment.quote)) polarity = "positive";
            }
          }
        }
        if (!polarity || !match) continue;
        const requestSignal = polarity === "requested"
          ? patternOccurrences(definition.modelEvidence, segment.quote, segment.start)[0]
          : null;
        const signalStart = requestSignal?.start ?? segment.start + match.index;
        const signalEnd = requestSignal?.end ?? signalStart + match[0].length;
        const coverageSpan = deterministicCoverageSpan(
          observation,
          clause,
          signalStart,
          signalEnd,
        );
        for (const target of targets) {
          const inheritedGroup = target.groupScoped && !group;
          const spanStart = inheritedGroup
            ? clause.start
            : group ? segment.start : segment.start + match.index;
          const spanEnd = inheritedGroup
            ? clause.end
            : group ? segment.end : spanStart + match[0].length;
          drafts.push({
            ...target,
            predicate,
            gate: definition.gate,
            polarity,
            normalizedValue: {
              status: definition.statuses[polarity],
              effect: definition.effects[polarity],
            },
            occurredAt: null,
            confidence: target.groupScoped ? 0.96 : polarity === "requested" ? 0.99 : 0.98,
            signalSpan: evidenceSpan(observation, signalStart, signalEnd),
            signalCoverageSpan: coverageSpan,
            evidenceSpan: evidenceSpan(observation, spanStart, spanEnd),
            extractionMethod: "deterministic",
            ambiguityReasons: [],
          });
        }
      }
    }
  }
  return drafts;
}

function applyTemporalResolution(draft, observation, dateOrder) {
  const containingClause = draft.extractionMethod === "deterministic"
    ? clauseRanges(observation.currentText, observation.currentStart)
      .find((clause) => draft.evidenceSpan.start >= clause.start && draft.evidenceSpan.end <= clause.end)
    : null;
  const temporalText = draft.signalCoverageSpan?.quote || containingClause?.quote || draft.evidenceSpan.quote;
  const temporal = resolveTemporalExpression({
    text: temporalText,
    messageDate: observation.normalizedPayload.date || null,
    capturedAt: observation.sourceCapturedAt,
    effect: draft.normalizedValue.effect,
    dateOrder,
  });
  if (temporal.status === "none") {
    return draft.extractionMethod === "deterministic" && observation.sourceRecordedAt
      ? { ...draft, occurredAt: observation.sourceRecordedAt }
      : draft;
  }
  const normalizedValue = {
    ...draft.normalizedValue,
    temporal: {
      resolverVersion: temporal.resolverVersion,
      status: temporal.status,
      occurredOn: temporal.occurredOn,
      basis: temporal.basis,
      expression: temporal.expression,
      confidence: temporal.confidence,
    },
  };
  if (draft.predicate === "last_free_day" && temporal.occurredOn) {
    normalizedValue.lastFreeDay = temporal.occurredOn;
  }
  const sourceAnchor = observation.normalizedPayload.date || observation.sourceCapturedAt;
  const sourceAnchorTimestamp = Date.parse(String(sourceAnchor || ""));
  const sourceAnchorDate = Number.isFinite(sourceAnchorTimestamp)
    ? new Date(sourceAnchorTimestamp).toISOString().slice(0, 10)
    : null;
  const futureDateReview = temporal.status === "date_only"
    && ["complete", "block"].includes(draft.normalizedValue.effect)
    && temporal.occurredOn
    && sourceAnchorDate
    && temporal.occurredOn > sourceAnchorDate;
  return {
    ...draft,
    occurredAt: temporal.occurredAt,
    normalizedValue,
    evidenceSpan: draft.extractionMethod === "deterministic" && draft.signalCoverageSpan
      ? draft.signalCoverageSpan
      : draft.evidenceSpan,
    ambiguityReasons: futureDateReview
      ? [...draft.ambiguityReasons, "temporal:future_date_after_source"]
      : temporal.status === "ambiguous" || temporal.status === "future_conflict"
        ? [...draft.ambiguityReasons, `temporal:${temporal.status}`]
      : draft.ambiguityReasons,
  };
}

function spansOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function patternOccurrences(pattern, text, offset) {
  const flags = [...new Set(String(pattern.flags || "").replace(/[gy]/g, "").split("").concat("g"))].join("");
  const matcher = new RegExp(pattern.source, flags);
  const occurrences = [];
  let match;
  while ((match = matcher.exec(text))) {
    if (!match[0].length) {
      matcher.lastIndex += 1;
      continue;
    }
    occurrences.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
      quote: match[0],
    });
  }
  return occurrences;
}

function residualOccurrenceIsShadowed(predicate, occurrence, clause) {
  const signal = String(occurrence.quote || "").toLowerCase();
  const text = String(clause.quote || "");
  if (predicate === "pickup_completed" && /^pick[\s-]?up$/.test(signal)) {
    return /\b(?:pick[\s-]?up|recovery|collection)\b[^.!?]{0,100}\b(?:schedule|appointment|planned|expected|cancel)\w*\b/iu.test(text);
  }
  if (predicate === "delivery_completed" && signal === "delivery") {
    return /\b(?:delivery\s+order|d\/?o|out\s+for\s+delivery)\b/iu.test(text)
      || /\bdelivery\b[^.!?]{0,100}\b(?:schedule|appointment|planned|expected|cancel)\w*\b/iu.test(text);
  }
  if (predicate === "dispatch_confirmed" && /^(?:driver|carrier|truck)$/.test(signal)) {
    return /\b(?:picked[\s-]?up|collected|recovered|loaded|out\s+for\s+delivery|delivered)\b/iu.test(text);
  }
  return false;
}

function unresolvedModelEvidence(observation, deterministic) {
  const deterministicSignals = deterministic.filter((draft) => draft.signalCoverageSpan);
  const ranges = [];
  const signals = [];
  for (const clause of clauseRanges(observation.currentText, observation.currentStart)) {
    const clauseSignals = [];
    for (const [predicate, definition] of Object.entries(PREDICATES)) {
      for (const occurrence of patternOccurrences(definition.modelEvidence, clause.quote, clause.start)) {
        if (residualOccurrenceIsShadowed(predicate, occurrence, clause)) continue;
        const covered = deterministicSignals.some((draft) => (
          draft.predicate === predicate && spansOverlap(draft.signalCoverageSpan, occurrence)
        ));
        if (!covered) clauseSignals.push({ predicate, ...occurrence });
      }
    }
    if (clauseSignals.length) {
      ranges.push({ start: clause.start, end: clause.end, quote: clause.quote });
      signals.push(...clauseSignals);
    }
  }
  signals.sort((left, right) =>
    left.start - right.start || left.end - right.end || left.predicate.localeCompare(right.predicate));
  return { ranges, signals };
}

function ambiguousRanges(observation, deterministic) {
  return unresolvedModelEvidence(observation, deterministic).ranges;
}

function parseModelResponse(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_MODEL_RESPONSE_BYTES) throw rejectModel("response", "is too large");
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw new GmailClaimExtractorError("Rejected Gmail claim model output: invalid JSON", {
        code: "GMAIL_CLAIM_MODEL_OUTPUT_REJECTED",
        field: "response",
        cause,
      });
    }
  }
  try {
    parsed = cloneJson(parsed, "modelResponse");
  } catch {
    throw rejectModel("response", "must contain only bounded JSON values");
  }
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_MODEL_RESPONSE_BYTES) {
    throw rejectModel("response", "is too large");
  }
  exactKeys(parsed, ["schemaVersion", "claims"], ["schemaVersion", "claims"], "response", true);
  if (parsed.schemaVersion !== MODEL_RESPONSE_SCHEMA) throw rejectModel("response.schemaVersion", `must equal ${MODEL_RESPONSE_SCHEMA}`);
  if (!Array.isArray(parsed.claims)) throw rejectModel("response.claims", "must be an array");
  if (parsed.claims.length === 0) throw rejectModel("response.claims", "must not be empty for an unresolved model plan");
  if (parsed.claims.length > MAX_MODEL_CLAIMS) throw rejectModel("response.claims", "contains too many claims");
  return parsed.claims;
}

function spanInsideRanges(span, ranges) {
  return ranges.some((range) => span.start >= range.start && span.end <= range.end);
}

function validateModelClaim(raw, index, context) {
  const field = `response.claims[${index}]`;
  exactKeys(raw, MODEL_CLAIM_KEYS, MODEL_CLAIM_KEYS, field, true);
  const subjectType = raw.subjectType;
  if (subjectType !== "shipment" && subjectType !== "workgroup") throw rejectModel(`${field}.subjectType`, "is unsupported");
  if (typeof raw.subjectKey !== "string" || !raw.subjectKey) throw rejectModel(`${field}.subjectKey`, "must be a non-empty string");
  const appliesToAwbs = normalizeAwbList(raw.appliesToAwbs, `${field}.appliesToAwbs`, { allowEmpty: false, rejection: true });
  if (subjectType === "shipment") {
    const subjectAwb = normalizeAwb(raw.subjectKey, `${field}.subjectKey`, true);
    if (appliesToAwbs.length !== 1 || appliesToAwbs[0] !== subjectAwb) {
      throw rejectModel(`${field}.appliesToAwbs`, "a shipment claim must apply only to its subject AWB");
    }
    if (!context.explicitAwbs.includes(subjectAwb) && !context.workgroup?.memberAwbs.includes(subjectAwb)) {
      throw rejectModel(`${field}.subjectKey`, "AWB is neither explicit nor a supplied workgroup member");
    }
  } else {
    if (!context.workgroup || raw.subjectKey !== context.workgroup.workgroupId) {
      throw rejectModel(`${field}.subjectKey`, "must equal the supplied workgroup identity");
    }
    if (JSON.stringify(appliesToAwbs) !== JSON.stringify(context.workgroup.memberAwbs)) {
      throw rejectModel(`${field}.appliesToAwbs`, "a workgroup claim must apply to exactly the supplied members");
    }
  }
  if (typeof raw.predicate !== "string" || !PREDICATES[raw.predicate]) throw rejectModel(`${field}.predicate`, "is unsupported");
  const definition = PREDICATES[raw.predicate];
  if (raw.gate !== definition.gate) throw rejectModel(`${field}.gate`, "does not match predicate");
  if (!POLARITIES.has(raw.polarity)) throw rejectModel(`${field}.polarity`, "is unsupported");
  exactKeys(raw.normalizedValue, MODEL_VALUE_KEYS, MODEL_VALUE_KEYS, `${field}.normalizedValue`, true);
  if (raw.normalizedValue.status !== definition.statuses[raw.polarity]) {
    throw rejectModel(`${field}.normalizedValue.status`, "does not match predicate and polarity");
  }
  if (raw.occurredAt !== null) throw rejectModel(`${field}.occurredAt`, "must be null until a deterministic temporal resolver proves it");
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > context.maxModelConfidence) {
    throw rejectModel(`${field}.confidence`, `must be between 0 and ${context.maxModelConfidence}`);
  }
  exactKeys(raw.evidenceSpan, MODEL_SPAN_KEYS, MODEL_SPAN_KEYS, `${field}.evidenceSpan`, true);
  const { start, end, quote } = raw.evidenceSpan;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > context.observation.normalizedText.length) {
    throw rejectModel(`${field}.evidenceSpan`, "has invalid character offsets");
  }
  if (typeof quote !== "string" || context.observation.normalizedText.slice(start, end) !== quote) {
    throw rejectModel(`${field}.evidenceSpan.quote`, "is not the exact normalized-text slice");
  }
  if (!spanInsideRanges({ start, end }, context.allowedRanges)) {
    throw rejectModel(`${field}.evidenceSpan`, "must cite a current, ambiguous message clause");
  }
  const clause = clauseRanges(context.observation.currentText, context.observation.currentStart)
    .find((item) => start >= item.start && end <= item.end);
  const segments = clause ? clauseSemanticSegments(clause) : [];
  const segmentIndex = segments.findIndex((item) => start >= item.start && end <= item.end);
  if (!clause || segmentIndex < 0) {
    throw rejectModel(`${field}.evidenceSpan`, "must stay within one server-derived semantic segment");
  }
  const segment = segments[segmentIndex];
  const allowedTargets = targetsForSegment(
    clause,
    segment,
    segments,
    segmentIndex,
    context.observation,
    context.workgroup,
  );
  if (allowedTargets.length !== 1) {
    throw rejectModel(`${field}.subjectKey`, "cannot be bound to one server-derived segment subject");
  }
  const expectedTarget = allowedTargets[0];
  if (subjectType !== expectedTarget.subjectType || raw.subjectKey !== expectedTarget.subjectKey
      || JSON.stringify(appliesToAwbs) !== JSON.stringify(expectedTarget.appliesToAwbs)) {
    throw rejectModel(`${field}.subjectKey`, "does not match the server-derived segment subject");
  }
  if (!definition.modelEvidence.test(quote)) throw rejectModel(`${field}.evidenceSpan.quote`, "does not mention the claimed predicate");
  const modalitySignals = context.unresolvedSignals.filter((signal) => (
    signal.predicate === raw.predicate && signal.start < end && signal.end > start
  ));
  const modalityAnchor = modalitySignals.length === 1
    ? modalitySignals[0]
    : { start, end };
  const semanticText = modelModalityText(
    segment,
    modalityAnchor.start,
    modalityAnchor.end,
  );
  if (subjectType === "shipment" && groupLanguage(semanticText)) {
    throw rejectModel(`${field}.subjectType`, "group language requires an evidence-bound workgroup subject");
  }
  const declarativeFutureDocument = /^\s*will\s+(?:send|share|provide|forward)\b/iu.test(semanticText);
  const asks = requestSpeech(semanticText) && !declarativeFutureDocument;
  const future = futureSpeech(semanticText);
  if ((asks || future || instructionLike(semanticText)) && raw.polarity === "positive") {
    throw rejectModel(`${field}.polarity`, "a request, plan, question, or instruction cannot be a completed event");
  }
  if (asks && raw.polarity !== "requested") throw rejectModel(`${field}.polarity`, "request language requires requested polarity");
  if (future && !asks && raw.polarity !== "neutral") throw rejectModel(`${field}.polarity`, "future language requires neutral polarity");
  if (subjectType === "workgroup" && !groupLanguage(semanticText)) {
    throw rejectModel(`${field}.evidenceSpan.quote`, "a workgroup claim must cite explicit group language");
  }
  if (subjectType === "workgroup") {
    const group = groupLanguage(semanticText);
    if (group.count !== null && group.count !== appliesToAwbs.length) {
      throw rejectModel(`${field}.evidenceSpan.quote`, "group count does not match workgroup membership");
    }
  }
  if (!Array.isArray(raw.ambiguityReasons) || raw.ambiguityReasons.length < 1 || raw.ambiguityReasons.length > 5) {
    throw rejectModel(`${field}.ambiguityReasons`, "must contain one through five reasons");
  }
  const ambiguityReasons = raw.ambiguityReasons.map((reason, reasonIndex) => {
    if (typeof reason !== "string" || !reason.trim() || reason.trim() !== reason || Buffer.byteLength(reason, "utf8") > 500) {
      throw rejectModel(`${field}.ambiguityReasons[${reasonIndex}]`, "must be a short trimmed string");
    }
    return reason;
  });
  return {
    subjectType,
    subjectKey: subjectType === "shipment" ? normalizeAwb(raw.subjectKey, `${field}.subjectKey`, true) : raw.subjectKey,
    appliesToAwbs,
    groupScoped: subjectType === "workgroup",
    predicate: raw.predicate,
    gate: raw.gate,
    polarity: raw.polarity,
    normalizedValue: {
      status: raw.normalizedValue.status,
      effect: definition.effects[raw.polarity],
    },
    occurredAt: null,
    confidence: Number(raw.confidence.toFixed(6)),
    evidenceSpan: { start, end, unit: "utf16_code_units", quote },
    extractionMethod: "model",
    ambiguityReasons,
  };
}

function contradictionFor(draft, acceptedClaims) {
  const exactClaimKey = `${draft.subjectType}:${draft.subjectKey}:${draft.predicate}`;
  const relevant = acceptedClaims.filter((claim) =>
    claim.predicate === draft.predicate && (
      claim.claimKey === exactClaimKey ||
      claim.appliesToAwbs.some((awb) => draft.appliesToAwbs.includes(awb))
    ));
  const same = relevant.filter((claim) =>
    claim.polarity === draft.polarity &&
    JSON.stringify(canonicalize(claim.normalizedValue)) === JSON.stringify(canonicalize(draft.normalizedValue)));
  const opposite = relevant.filter((claim) =>
    (claim.polarity === "positive" && draft.polarity === "negative") ||
    (claim.polarity === "negative" && draft.polarity === "positive"));
  if (same.length) {
    return {
      status: "none",
      acceptedClaimVersionIds: same.map((claim) => claim.claimVersionId).sort(),
      reasons: ["an equivalent accepted claim already exists"],
      duplicate: true,
      safeNewerCorrection: false,
    };
  }
  if (opposite.length) {
    const candidateTime = Date.parse(String(draft.occurredAt || ""));
    const targetTimes = opposite.map((claim) => Date.parse(String(
      claim.occurredAt || claim.sourceRecordedAt || "",
    )));
    const exactSameClaim = opposite.every((claim) => claim.claimKey === exactClaimKey);
    const safeNewerCorrection = draft.extractionMethod === "deterministic"
      && ["positive", "negative"].includes(draft.polarity)
      && exactSameClaim
      && Number.isFinite(candidateTime)
      && targetTimes.every(Number.isFinite)
      && targetTimes.every((timestamp) => candidateTime > timestamp);
    return {
      status: "known",
      acceptedClaimVersionIds: opposite.map((claim) => claim.claimVersionId).sort(),
      reasons: [safeNewerCorrection
        ? "strictly newer deterministic source evidence is eligible to correct older opposite evidence"
        : "accepted evidence asserts the opposite polarity without a strictly newer exact-subject source proof"],
      duplicate: false,
      safeNewerCorrection,
    };
  }
  return {
    status: "none",
    acceptedClaimVersionIds: [],
    reasons: [],
    duplicate: false,
    safeNewerCorrection: false,
  };
}

function finalizeDraft(draft, observation, acceptedClaims, options) {
  const claimKey = `${draft.subjectType}:${draft.subjectKey}:${draft.predicate}`;
  const chain = acceptedClaims.filter((claim) => claim.claimKey === claimKey)
    .sort((left, right) => left.versionNo - right.versionNo);
  const previous = chain.at(-1) || null;
  const contradiction = contradictionFor(draft, acceptedClaims);
  const temporalReviewReason = draft.ambiguityReasons.find((reason) => reason.startsWith("temporal:"));
  let decision = draft.extractionMethod === "model" ? "review" : "accept";
  const reasons = draft.extractionMethod === "model"
    ? ["model-extracted candidates require policy or operator review"]
    : ["explicit current-message language passed deterministic speech-act and citation checks"];
  if (temporalReviewReason) {
    decision = "review";
    reasons.splice(0, reasons.length,
      temporalReviewReason === "temporal:future_date_after_source"
        ? "future-dated completion or blocker requires operator review"
        : "candidate temporal meaning requires operator review");
  } else if (contradiction.duplicate) {
    decision = "reject";
    reasons.splice(0, reasons.length, "equivalent accepted claim already exists");
  } else if (contradiction.status === "known" && contradiction.safeNewerCorrection) {
    decision = "accept";
    reasons.splice(
      0,
      reasons.length,
      "strictly newer deterministic current-message evidence corrects older same-subject evidence",
    );
  } else if (contradiction.status === "known") {
    decision = "review";
    reasons.splice(0, reasons.length, "candidate conflicts with accepted evidence");
  }
  const base = {
    schemaVersion: SCHEMA_VERSION,
    claimKey,
    versionNo: (previous?.versionNo || 0) + 1,
    previousClaimVersionId: previous?.claimVersionId || null,
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    sourceMessageId: observation.messageId,
    sourceThreadId: observation.threadId,
    sourceCapturedAt: observation.sourceCapturedAt,
    subjectType: draft.subjectType,
    subjectKey: draft.subjectKey,
    appliesToAwbs: [...draft.appliesToAwbs].sort(),
    predicate: draft.predicate,
    gate: draft.gate,
    polarity: draft.polarity,
    normalizedValue: draft.normalizedValue,
    occurredAt: draft.occurredAt,
    confidence: draft.confidence,
    confidenceLabel: draft.confidence >= 0.9 ? "high" : draft.confidence >= 0.7 ? "medium" : "low",
    evidenceSpan: draft.evidenceSpan,
    extractionMethod: draft.extractionMethod,
    extractorVersion: draft.extractionMethod === "model"
      ? EXTRACTOR_VERSION
      : DETERMINISTIC_EXTRACTOR_VERSION,
    model: draft.extractionMethod === "model" ? options.model : "",
    promptVersion: draft.extractionMethod === "model" ? PROMPT_VERSION : "",
    ambiguity: {
      status: draft.ambiguityReasons.length ? "review" : "none",
      reasons: [...draft.ambiguityReasons],
    },
    contradiction: {
      status: contradiction.status,
      acceptedClaimVersionIds: contradiction.acceptedClaimVersionIds,
      reasons: contradiction.reasons,
    },
    acceptanceRecommendation: {
      decision,
      method: decision === "accept" ? "policy" : "operator",
      policyVersion: ACCEPTANCE_POLICY_VERSION,
      reasons,
    },
  };
  const candidateHash = sha256Json(base);
  return deepFreeze({
    candidateClaimVersionId: `candidate:v1:${candidateHash}`,
    candidateHash,
    ...base,
  });
}

function dedupeDrafts(drafts) {
  const seen = new Map();
  for (const draft of drafts) {
    const key = sha256Json({
      subjectType: draft.subjectType,
      subjectKey: draft.subjectKey,
      appliesToAwbs: draft.appliesToAwbs,
      predicate: draft.predicate,
      polarity: draft.polarity,
      normalizedValue: draft.normalizedValue,
      evidenceSpan: draft.evidenceSpan,
    });
    if (!seen.has(key)) seen.set(key, draft);
  }
  return [...seen.values()].sort((left, right) =>
    left.evidenceSpan.start - right.evidenceSpan.start ||
    left.predicate.localeCompare(right.predicate) ||
    left.subjectType.localeCompare(right.subjectType) ||
    left.subjectKey.localeCompare(right.subjectKey));
}

function deterministicCoverageWitness(draft, candidate) {
  const spanWitness = (span) => ({
    start: span.start,
    end: span.end,
    quoteHash: sha256Text(span.quote),
  });
  return deepFreeze({
    candidateClaimVersionId: candidate.candidateClaimVersionId,
    predicate: draft.predicate,
    signalSpan: spanWitness(draft.signalSpan),
    coverageSpan: spanWitness(draft.signalCoverageSpan),
  });
}

function normalizePlanConfig(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const maxModelConfidence = options.maxModelConfidence ?? 0.9;
  if (typeof maxModelConfidence !== "number" || !Number.isFinite(maxModelConfidence)
      || maxModelConfidence <= 0 || maxModelConfidence > 0.95) {
    throw invalidArgument("options.maxModelConfidence", "must be greater than zero and at most 0.95");
  }
  const dateOrder = String(options.dateOrder ?? "MDY").toUpperCase();
  if (!["MDY", "DMY"].includes(dateOrder)) {
    throw invalidArgument("options.dateOrder", "must be MDY or DMY");
  }
  return Object.freeze({ dateOrder, maxModelConfidence });
}

function workgroupPlanInput(workgroup) {
  return workgroup ? {
    workgroupId: workgroup.workgroupId,
    memberAwbs: [...workgroup.memberAwbs],
    observationAwbs: [...workgroup.observationAwbs],
    linkedThreadIds: [...workgroup.linkedThreadIds],
    linkedObservationIds: [...workgroup.linkedObservationIds],
  } : null;
}

function buildModelInput({ observation, workgroup, ranges, signals, dateOrder, maxModelConfidence }) {
  const explicitAwbs = extractAwbs(`${observation.subject}\n${observation.currentText}`);
  return deepFreeze({
    schemaVersion: MODEL_INPUT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    normalizedTextHash: sha256Text(observation.normalizedText),
    normalizedTextLength: observation.normalizedText.length,
    allowedEvidenceRanges: ranges.map((range) => ({
      start: range.start,
      end: range.end,
      quoteHash: sha256Text(range.quote),
    })),
    unresolvedSignals: signals.map((signal) => ({
      predicate: signal.predicate,
      start: signal.start,
      end: signal.end,
      quoteHash: sha256Text(signal.quote),
    })),
    explicitAwbs,
    workgroup: workgroup ? {
      workgroupId: workgroup.workgroupId,
      memberAwbs: [...workgroup.memberAwbs],
      observationAwbs: [...workgroup.observationAwbs],
    } : null,
    config: {
      dateOrder,
      maxModelConfidence,
      acceptancePolicyVersion: ACCEPTANCE_POLICY_VERSION,
    },
    rules: [
      "Return strict JSON only and cite exact start/end/quote offsets supplied in allowedEvidenceRanges.",
      "For every unresolvedSignals entry, return a same-predicate candidate whose evidenceSpan overlaps that signal.",
      "An AWB must be explicit or belong to the supplied workgroup.",
      "Questions and requests use requested polarity; plans and futures use neutral polarity; neither is completion.",
      "A workgroup claim must cite explicit group language and apply to exactly every supplied member.",
      "occurredAt must be null; temporal resolution is a separate deterministic stage.",
      `Numeric dates are interpreted by the server with tenant date order ${dateOrder}; never invent a timestamp.`,
    ],
    responseSchemaVersion: MODEL_RESPONSE_SCHEMA,
    predicateRegistry: {
      registryVersion: PREDICATE_REGISTRY.registryVersion,
      registryHash: PREDICATE_REGISTRY.registryHash,
      predicates: modelPredicateCatalog(),
    },
  });
}

function modelPlanBase({
  observation,
  workgroup,
  acceptedClaims,
  ranges,
  signals,
  dateOrder,
  maxModelConfidence,
}) {
  const modelInput = buildModelInput({
    observation,
    workgroup,
    ranges,
    signals,
    dateOrder,
    maxModelConfidence,
  });
  return {
    schemaVersion: MODEL_PLAN_SCHEMA_VERSION,
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    sourceMessageId: observation.messageId,
    sourceThreadId: observation.threadId,
    sourceCapturedAt: observation.sourceCapturedAt,
    sourceRecordedAt: observation.sourceRecordedAtBinding,
    sourceMessageDate: observation.normalizedPayload.date || null,
    extractorVersion: EXTRACTOR_VERSION,
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: MODEL_RESPONSE_SCHEMA,
    config: { dateOrder, maxModelConfidence },
    workgroupContextHash: sha256Json(workgroupPlanInput(workgroup)),
    acceptedClaimsContextHash: sha256Json(acceptedClaims),
    modelInput,
  };
}

function buildModelPlan(input) {
  const base = modelPlanBase(input);
  const ranges = input.ranges;
  const signals = input.signals;
  const planBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  if (ranges.length > MAX_MODEL_PLAN_RANGES || signals.length > MAX_MODEL_CLAIMS ||
      planBytes > MAX_MODEL_PLAN_BYTES) {
    throw new GmailClaimExtractorError("Gmail model extraction plan exceeds its durable bound", {
      code: "GMAIL_CLAIM_MODEL_PLAN_BOUNDS_EXCEEDED",
      retryable: false,
      rangeCount: ranges.length,
      maxRangeCount: MAX_MODEL_PLAN_RANGES,
      signalCount: signals.length,
      maxSignalCount: MAX_MODEL_CLAIMS,
      planBytes,
      maxPlanBytes: MAX_MODEL_PLAN_BYTES,
    });
  }
  const modelPlanHash = sha256Json(base);
  return deepFreeze({
    modelPlanId: `gmail-model-plan:v1:${modelPlanHash}`,
    modelPlanHash,
    ...base,
  });
}

function modelPlanLocalBoundsFailureCore({
  observation,
  deterministicCandidateCount,
  residualRangeCount,
  residualSignalCount,
  modelPlanBytes,
}) {
  const exceededDimensions = [];
  if (deterministicCandidateCount > MAX_MODEL_CLAIMS) exceededDimensions.push("deterministic_candidates");
  if (residualRangeCount > MAX_MODEL_PLAN_RANGES) exceededDimensions.push("residual_ranges");
  if (residualSignalCount > MAX_MODEL_CLAIMS) exceededDimensions.push("residual_signals");
  if (modelPlanBytes > MAX_MODEL_PLAN_BYTES) exceededDimensions.push("model_plan_bytes");
  return {
    schemaVersion: "gmail-model-plan-local-bounds-failure-v1",
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    deterministicCandidateCount,
    residualRangeCount,
    residualSignalCount,
    modelPlanBytes,
    exceededDimensions,
    limits: {
      deterministicCandidates: MAX_MODEL_CLAIMS,
      residualRanges: MAX_MODEL_PLAN_RANGES,
      residualSignals: MAX_MODEL_CLAIMS,
      modelPlanBytes: MAX_MODEL_PLAN_BYTES,
    },
  };
}

function modelRuntimeDisabledFailureCore({
  observation,
  deterministicCandidateCount,
  modelInput,
}) {
  return {
    schemaVersion: "gmail-model-runtime-disabled-review-v1",
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    deterministicCandidateCount,
    residual: {
      explicitAwbs: modelInput.explicitAwbs,
      allowedEvidenceRanges: modelInput.allowedEvidenceRanges,
      unresolvedSignals: modelInput.unresolvedSignals,
    },
  };
}

function forwardedProvenanceFailureCore(observation) {
  if (observation.quoteBoundaryKind !== "forwarded_or_original") return null;
  const signals = [];
  const tailPredicates = [];
  // This witness is independently rederived by the SQL plan sealer. Preserve
  // its exact full-tail, registry-ordered scan: the boundary already prevents
  // nested text from becoming a claim, so clause segmentation here created
  // only cross-runtime hash drift without adding an evidence safeguard.
  for (const [predicate, definition] of Object.entries(PREDICATES)) {
    const occurrences = patternOccurrences(
      definition.modelEvidence,
      observation.quotedTailText,
      observation.currentEnd,
    );
    if (occurrences.length) tailPredicates.push(predicate);
    for (const occurrence of occurrences) {
      signals.push({ predicate, ...occurrence });
    }
  }
  if (!signals.length) return null;
  return {
    schemaVersion: "gmail-boundary-nested-provenance-failure-v1",
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    boundaryStart: observation.currentEnd,
    boundaryMarkerHash: sha256Text(observation.quoteBoundaryMarker),
    boundaryKind: observation.quoteBoundaryKind,
    tailSignalCount: signals.length,
    tailPredicates,
  };
}

function planGmailClaimExtraction(input = {}, options = {}) {
  if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
  const { dateOrder, maxModelConfidence } = normalizePlanConfig(options);
  const modelRuntimeEnabled = options.modelRuntimeEnabled !== false;
  const observation = normalizeObservation(input.observation);
  const workgroup = normalizeWorkgroup(input.workgroupContext, observation);
  const acceptedClaims = normalizeAcceptedClaims(input.acceptedClaims);
  const deterministicDraftList = deterministicDrafts(observation, workgroup)
    .map((draft) => applyTemporalResolution(draft, observation, dateOrder));
  const unresolved = unresolvedModelEvidence(observation, deterministicDraftList);
  const deterministicDraftsForPlan = dedupeDrafts(deterministicDraftList);
  const deterministicCandidates = deterministicDraftsForPlan
    .map((draft) => finalizeDraft(draft, observation, acceptedClaims, { model: "" }));
  const deterministicCoverage = deterministicDraftsForPlan.map((draft, index) => (
    deterministicCoverageWitness(draft, deterministicCandidates[index])
  ));
  const forwardedFailure = forwardedProvenanceFailureCore(observation);
  if (forwardedFailure) {
    const failureBase = {
      schemaVersion: "gmail-claim-extraction-plan-failure-v2",
      sourceObservationId: observation.observationId,
      sourceObservationContentHash: observation.contentHash,
      extractorVersion: EXTRACTOR_VERSION,
      deterministicCandidates,
      deterministicCoverage,
      modelPlan: null,
      planningFailure: {
        code: "MODEL_NESTED_PROVENANCE_REQUIRED",
        detailHash: sha256Json(forwardedFailure),
      },
    };
    const extractionPlanHash = sha256Json(failureBase);
    return deepFreeze({
      extractionPlanId: `gmail-extraction-plan:v1:${extractionPlanHash}`,
      extractionPlanHash,
      ...failureBase,
    });
  }
  const prospectiveModelPlanBase = unresolved.signals.length ? modelPlanBase({
    observation,
    workgroup,
    acceptedClaims,
    ranges: unresolved.ranges,
    signals: unresolved.signals,
    dateOrder,
    maxModelConfidence,
  }) : null;
  const prospectiveModelPlanBytes = prospectiveModelPlanBase
    ? Buffer.byteLength(JSON.stringify(prospectiveModelPlanBase), "utf8")
    : 0;
  const localBoundsExceeded = deterministicCandidates.length > MAX_MODEL_CLAIMS
    || unresolved.ranges.length > MAX_MODEL_PLAN_RANGES
    || unresolved.signals.length > MAX_MODEL_CLAIMS
    || prospectiveModelPlanBytes > MAX_MODEL_PLAN_BYTES;
  let modelPlan = null;
  if (modelRuntimeEnabled && unresolved.signals.length && !localBoundsExceeded) {
    const modelPlanHash = sha256Json(prospectiveModelPlanBase);
    modelPlan = deepFreeze({
      modelPlanId: `gmail-model-plan:v1:${modelPlanHash}`,
      modelPlanHash,
      ...prospectiveModelPlanBase,
    });
  }
  if (localBoundsExceeded) {
    const failureCore = modelPlanLocalBoundsFailureCore({
      observation,
      deterministicCandidateCount: deterministicCandidates.length,
      residualRangeCount: unresolved.ranges.length,
      residualSignalCount: unresolved.signals.length,
      modelPlanBytes: prospectiveModelPlanBytes,
    });
    const failureBase = {
      schemaVersion: "gmail-claim-extraction-plan-failure-v2",
      sourceObservationId: observation.observationId,
      sourceObservationContentHash: observation.contentHash,
      extractorVersion: EXTRACTOR_VERSION,
      deterministicCandidates,
      deterministicCoverage,
      modelPlan: null,
      planningFailure: {
        code: "MODEL_PLAN_BOUNDS_EXCEEDED",
        detailHash: sha256Json(failureCore),
      },
    };
    const extractionPlanHash = sha256Json(failureBase);
    return deepFreeze({
      extractionPlanId: `gmail-extraction-plan:v1:${extractionPlanHash}`,
      extractionPlanHash,
      ...failureBase,
    });
  }
  if (!modelRuntimeEnabled && unresolved.signals.length) {
    const failureCore = modelRuntimeDisabledFailureCore({
      observation,
      deterministicCandidateCount: deterministicCandidates.length,
      modelInput: prospectiveModelPlanBase.modelInput,
    });
    const failureBase = {
      schemaVersion: "gmail-claim-extraction-plan-failure-v2",
      sourceObservationId: observation.observationId,
      sourceObservationContentHash: observation.contentHash,
      extractorVersion: EXTRACTOR_VERSION,
      deterministicCandidates,
      deterministicCoverage,
      modelPlan: null,
      planningFailure: {
        code: "MODEL_RUNTIME_DISABLED",
        detailHash: sha256Json(failureCore),
      },
    };
    const extractionPlanHash = sha256Json(failureBase);
    return deepFreeze({
      extractionPlanId: `gmail-extraction-plan:v1:${extractionPlanHash}`,
      extractionPlanHash,
      ...failureBase,
    });
  }
  const base = {
    schemaVersion: EXTRACTION_PLAN_SCHEMA_VERSION,
    sourceObservationId: observation.observationId,
    sourceObservationContentHash: observation.contentHash,
    extractorVersion: EXTRACTOR_VERSION,
    deterministicCandidates,
    deterministicCoverage,
    modelPlan,
  };
  const extractionPlanHash = sha256Json(base);
  return deepFreeze({
    extractionPlanId: `gmail-extraction-plan:v1:${extractionPlanHash}`,
    extractionPlanHash,
    ...base,
  });
}

function normalizeModelPlan(value, contextInput = {}) {
  const plan = cloneJson(value, "modelPlan");
  const keys = [
    "modelPlanId", "modelPlanHash", "schemaVersion", "sourceObservationId",
    "sourceObservationContentHash", "sourceMessageId", "sourceThreadId",
    "sourceCapturedAt", "sourceRecordedAt", "sourceMessageDate", "extractorVersion",
    "promptVersion", "responseSchemaVersion", "config", "workgroupContextHash",
    "acceptedClaimsContextHash", "modelInput",
  ];
  exactKeys(plan, keys, keys, "modelPlan");
  if (plan.schemaVersion !== MODEL_PLAN_SCHEMA_VERSION ||
      plan.extractorVersion !== EXTRACTOR_VERSION ||
      plan.promptVersion !== PROMPT_VERSION ||
      plan.responseSchemaVersion !== MODEL_RESPONSE_SCHEMA) {
    throw invalidArgument("modelPlan", "has an unsupported extraction identity");
  }
  if (!HASH_RE.test(plan.modelPlanHash) ||
      plan.modelPlanId !== `gmail-model-plan:v1:${plan.modelPlanHash}`) {
    throw invalidArgument("modelPlan.modelPlanId", "does not match its content hash");
  }
  const { modelPlanId: _id, modelPlanHash: _hash, ...base } = plan;
  if (sha256Json(base) !== plan.modelPlanHash) {
    throw invalidArgument("modelPlan.modelPlanHash", "does not match the immutable model plan");
  }
  const config = normalizePlanConfig(plan.config);
  exactKeys(plan.config, ["dateOrder", "maxModelConfidence"], ["dateOrder", "maxModelConfidence"], "modelPlan.config");
  if (!isPlainObject(contextInput)) throw invalidArgument("context", "must be an object");
  const observation = normalizeObservation(contextInput.observation);
  const workgroup = normalizeWorkgroup(contextInput.workgroupContext, observation);
  const acceptedClaims = normalizeAcceptedClaims(contextInput.acceptedClaims);
  if (plan.sourceObservationId !== observation.observationId ||
      plan.sourceObservationContentHash !== observation.contentHash ||
      plan.sourceMessageId !== observation.messageId ||
      plan.sourceThreadId !== observation.threadId ||
      plan.sourceCapturedAt !== observation.sourceCapturedAt ||
      plan.sourceRecordedAt !== observation.sourceRecordedAtBinding ||
      plan.sourceMessageDate !== (observation.normalizedPayload.date || null)) {
    throw invalidArgument("modelPlan", "source identity does not match its immutable observation");
  }
  if (plan.workgroupContextHash !== sha256Json(workgroupPlanInput(workgroup))) {
    throw invalidArgument("context.workgroupContext", "does not match the model plan context hash");
  }
  if (plan.acceptedClaimsContextHash !== sha256Json(acceptedClaims)) {
    throw invalidArgument("context.acceptedClaims", "does not match the model plan context hash");
  }
  const deterministicDraftList = deterministicDrafts(observation, workgroup)
    .map((draft) => applyTemporalResolution(draft, observation, config.dateOrder));
  const unresolved = unresolvedModelEvidence(observation, deterministicDraftList);
  if (!unresolved.signals.length) {
    throw invalidArgument("modelPlan", "does not contain unresolved operational signals");
  }
  const rebuilt = buildModelPlan({
    observation,
    workgroup,
    acceptedClaims,
    ranges: unresolved.ranges,
    signals: unresolved.signals,
    dateOrder: config.dateOrder,
    maxModelConfidence: config.maxModelConfidence,
  });
  if (rebuilt.modelPlanHash !== plan.modelPlanHash) {
    throw invalidArgument("modelPlan.modelInput", "does not match deterministic planning");
  }
  return {
    plan: rebuilt,
    observation,
    workgroup,
    acceptedClaims,
    ranges: unresolved.ranges,
    signals: unresolved.signals,
    config,
  };
}

function materializeGmailModelInput(input = {}) {
  if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
  exactKeys(
    input,
    ["modelPlan", "observation", "workgroupContext", "acceptedClaims"],
    ["modelPlan", "observation"],
    "input",
  );
  const context = normalizeModelPlan(input.modelPlan, input);
  return deepFreeze({
    ...context.plan.modelInput,
    allowedEvidenceRanges: context.ranges.map((range) => ({ ...range })),
    unresolvedSignals: context.signals.map((signal) => ({ ...signal })),
  });
}

function completeGmailModelExtraction(input = {}) {
  if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
  exactKeys(
    input,
    ["modelPlan", "modelResponse", "model", "observation", "workgroupContext", "acceptedClaims"],
    ["modelPlan", "modelResponse", "model", "observation"],
    "input",
  );
  const model = requireString(input.model, "input.model", { maxBytes: 200 });
  const context = normalizeModelPlan(input.modelPlan, input);
  const rawClaims = parseModelResponse(input.modelResponse);
  const explicitAwbs = context.plan.modelInput.explicitAwbs;
  const drafts = rawClaims.map((raw, index) => validateModelClaim(raw, index, {
    observation: context.observation,
    workgroup: context.workgroup,
    explicitAwbs,
    allowedRanges: context.ranges,
    unresolvedSignals: context.signals,
    maxModelConfidence: context.config.maxModelConfidence,
  }));
  const uncoveredSignals = context.signals.filter((signal) => !drafts.some((draft) => (
    draft.predicate === signal.predicate && spansOverlap(draft.evidenceSpan, signal)
  )));
  if (uncoveredSignals.length) {
    throw rejectModel(
      "response.claims",
      "must resolve every signal with a same-predicate overlapping candidate",
    );
  }
  const candidates = dedupeDrafts(drafts
    .map((draft) => applyTemporalResolution(draft, context.observation, context.config.dateOrder)))
    .map((draft) => finalizeDraft(draft, context.observation, context.acceptedClaims, { model }));
  if (!candidates.length) throw rejectModel("response.claims", "must not resolve a non-empty plan to zero candidates");
  return deepFreeze(candidates);
}

function sortedCandidates(candidates) {
  return [...candidates].sort((left, right) =>
    left.evidenceSpan.start - right.evidenceSpan.start ||
    left.predicate.localeCompare(right.predicate) ||
    left.subjectType.localeCompare(right.subjectType) ||
    left.subjectKey.localeCompare(right.subjectKey));
}

function unwrapModelExtractorResult(result, configuredModel) {
  if (isPlainObject(result) && result.schemaVersion === "openai-gmail-model-extraction-result-v1") {
    if (result.classification !== "succeeded") {
      throw new GmailClaimExtractorError(
        `Gmail claim model extraction remains unresolved: ${String(result.classification || "unknown")}`,
        {
          code: "GMAIL_CLAIM_MODEL_UNRESOLVED",
          classification: String(result.classification || "unknown"),
          retryable: result.retryable === true,
          outcomeUnknown: result.outcomeUnknown === true,
          modelResult: deepFreeze(cloneJson(result)),
        },
      );
    }
    return {
      modelResponse: result.modelResponse,
      model: requireString(result.actualModel, "modelResult.actualModel", { maxBytes: 200 }),
    };
  }
  return { modelResponse: result, model: configuredModel };
}

function createGmailClaimExtractor(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const modelExtractor = options.modelExtractor ?? null;
  if (modelExtractor !== null && typeof modelExtractor !== "function") {
    throw invalidArgument("options.modelExtractor", "must be a function or null");
  }
  const model = modelExtractor
    ? requireString(options.model, "options.model", { maxBytes: 200 })
    : String(options.model || "");
  const { maxModelConfidence, dateOrder } = normalizePlanConfig(options);
  if (options.requireModelForAmbiguity !== undefined
      && typeof options.requireModelForAmbiguity !== "boolean") {
    throw invalidArgument("options.requireModelForAmbiguity", "must be a boolean");
  }
  const requireModelForAmbiguity = options.requireModelForAmbiguity === true;

  function assertPlanned(plan) {
    if (!plan.planningFailure) return plan;
    throw new GmailClaimExtractorError(
      `Gmail claim extraction requires durable planning review: ${plan.planningFailure.code}`,
      {
        code: "GMAIL_CLAIM_PLANNING_REVIEW_REQUIRED",
        retryable: false,
        extractionPlanId: plan.extractionPlanId,
        extractionPlanHash: plan.extractionPlanHash,
        planningFailure: deepFreeze(cloneJson(plan.planningFailure)),
        reviewReason: plan.planningFailure.code,
        safeDetailHash: plan.planningFailure.detailHash,
      },
    );
  }

  // Attachment claims have a separate immutable-text boundary. They may seal
  // only the subset proved by deterministic grammar while the strict message
  // parent continues to require its durable semantic model graph. This is not
  // a non-operational verdict and never materializes a model candidate.
  async function extractDeterministic(input = {}) {
    const plan = assertPlanned(planGmailClaimExtraction(input, {
      maxModelConfidence,
      dateOrder,
    }));
    return plan.deterministicCandidates;
  }

  async function extract(input = {}) {
    const plan = assertPlanned(planGmailClaimExtraction(input, {
      maxModelConfidence,
      dateOrder,
    }));
    if (!plan.modelPlan) return plan.deterministicCandidates;
    if (!modelExtractor) {
      throw new GmailClaimExtractorError(
        "Operational language remains outside deterministic extraction and no model extractor is configured",
        {
          code: "GMAIL_CLAIM_MODEL_REQUIRED",
          retryable: false,
          ambiguousRangeCount: plan.modelPlan.modelInput.allowedEvidenceRanges.length,
          modelPlanId: plan.modelPlan.modelPlanId,
          requireModelForAmbiguity,
        },
      );
    }
    throwIfAborted(input.signal, { stage: "Gmail claim model extraction" });
    const modelInput = materializeGmailModelInput({
      modelPlan: plan.modelPlan,
      observation: input.observation,
      workgroupContext: input.workgroupContext,
      acceptedClaims: input.acceptedClaims,
    });
    let response;
    try {
      response = await modelExtractor(modelInput, {
        signal: input.signal || null,
        deadlineAtMs: input.deadlineAtMs || null,
        modelPlan: plan.modelPlan,
        observation: input.observation,
        workgroupContext: input.workgroupContext,
        acceptedClaims: input.acceptedClaims,
      });
    } catch (cause) {
      if (isAbortError(cause, input.signal)) throw cause;
      if (cause instanceof GmailClaimExtractorError) throw cause;
      throw new GmailClaimExtractorError(`Gmail claim model extractor failed: ${cause?.message || String(cause)}`, {
        code: "GMAIL_CLAIM_MODEL_FAILED",
        retryable: true,
        cause,
      });
    }
    const completion = unwrapModelExtractorResult(response, model);
    const modelCandidates = completeGmailModelExtraction({
      modelPlan: plan.modelPlan,
      modelResponse: completion.modelResponse,
      model: completion.model,
      observation: input.observation,
      workgroupContext: input.workgroupContext,
      acceptedClaims: input.acceptedClaims,
    });
    return deepFreeze(sortedCandidates([...plan.deterministicCandidates, ...modelCandidates]));
  }

  return Object.freeze({ extract, extractDeterministic });
}

module.exports = {
  ACCEPTANCE_POLICY_VERSION,
  EXTRACTION_PLAN_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  DETERMINISTIC_EXTRACTOR_VERSION,
  GmailClaimExtractorError,
  MAX_MODEL_PLAN_BYTES,
  MAX_MODEL_PLAN_RANGES,
  MODEL_INPUT_SCHEMA_VERSION,
  MODEL_PLAN_SCHEMA_VERSION,
  MODEL_RESPONSE_JSON_SCHEMA,
  MODEL_RESPONSE_SCHEMA,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  completeGmailModelExtraction,
  createGmailClaimExtractor,
  materializeGmailModelInput,
  planGmailClaimExtraction,
  _test: {
    ambiguousRanges,
    buildNormalizedText,
    canonicalize,
    clauseRanges,
    extractAwbs,
    groupLanguage,
    applyTemporalResolution,
    normalizeObservation,
    normalizeModelPlan,
    modelPlanBase,
    modelPlanLocalBoundsFailureCore,
    modelRuntimeDisabledFailureCore,
    forwardedProvenanceFailureCore,
    parseModelResponse,
    unresolvedModelEvidence,
    sha256Json,
  },
};

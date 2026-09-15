"use strict";

const crypto = require("node:crypto");
const { domainToASCII } = require("node:url");
const PostalMime = require("postal-mime");
const {
  GMAIL_AUTH_WITNESS_POLICY,
  GMAIL_AUTH_WITNESS_POLICY_HASH,
  GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
  GMAIL_PARSED_ENVELOPE_KEYS,
  GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  GMAIL_PARSER_VERSION,
} = require("./truth-candidate-contract");

const PARSER_VERSION = GMAIL_PARSER_VERSION;
const SCHEMA_VERSION = GMAIL_PARSED_MESSAGE_SCHEMA_VERSION;
const SOURCE_CHRONOLOGY_SCHEMA_VERSION = "gmail-source-chronology-v1";
const DEFAULT_MAX_RAW_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 500;
const MAX_RFC5322_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const MONTHS = Object.freeze({
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
});
const WEEKDAYS = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });
const RFC5322_DATE_RE = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|UT|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)$/i;

class GmailRfc822ParserError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailRfc822ParserError";
    this.code = fields.code || "GMAIL_RFC822_PARSE_FAILED";
    this.field = fields.field || "";
    this.retryable = Boolean(fields.retryable);
    this.cause = fields.cause || this.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailRfc822ParserError(`Invalid RFC822 parser argument ${field}: ${reason}`, {
    code: "GMAIL_RFC822_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArgument("canonicalValue", "contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw invalidArgument("canonicalValue", "contains a non-JSON value");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function asBuffer(value, field = "rawBytes") {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  throw invalidArgument(field, "must be a Buffer, Uint8Array, or ArrayBuffer");
}

function requireString(value, field, { allowEmpty = true } = {}) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not contain surrounding whitespace");
  return value;
}

function parseGmailInternalDate(value, field = "gmail.internalDate") {
  const raw = requireString(value === undefined || value === null ? "" : String(value), field, {
    allowEmpty: false,
  });
  if (!/^\d+$/.test(raw)) throw invalidArgument(field, "must be exact epoch milliseconds");
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw invalidArgument(field, "must be non-negative safe epoch milliseconds");
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.getTime() !== milliseconds) {
    throw invalidArgument(field, "is outside the supported timestamp range");
  }
  return Object.freeze({ raw, milliseconds, sourceRecordedAt: date.toISOString() });
}

function normalizeDateHeaderValue(value) {
  return String(value || "").replace(/\r?\n[\t ]+/g, " ").replace(/\s+/g, " ").trim();
}

function dateHeaderDiagnostic(headers, providerReceivedAt) {
  const dateHeaders = headers.filter((header) => header.key === "date");
  const fallback = (status, raw = "") => Object.freeze({
    raw,
    status,
    authoredAt: null,
    chronologyEligible: false,
    fallbackSource: "gmail_internal_date",
  });
  if (dateHeaders.length === 0) return fallback("missing");
  if (dateHeaders.length !== 1) {
    return fallback("invalid", dateHeaders.map((header) => normalizeDateHeaderValue(header.value)).join(" | "));
  }
  const raw = normalizeDateHeaderValue(dateHeaders[0].value);
  const match = raw.match(RFC5322_DATE_RE);
  if (!match) return fallback("invalid", raw);
  const [, weekday, dayRaw, monthRaw, yearRaw, hourRaw, minuteRaw, secondRaw = "00", zone] = match;
  const day = Number(dayRaw);
  const month = MONTHS[monthRaw.toLowerCase()];
  const year = Number(yearRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const localCalendar = new Date(Date.UTC(year, month, day));
  const calendarValid = localCalendar.getUTCFullYear() === year
    && localCalendar.getUTCMonth() === month
    && localCalendar.getUTCDate() === day;
  const numericZone = zone.match(/^([+-])(\d{2})(\d{2})$/);
  const zoneValid = !numericZone || (
    Number(numericZone[2]) <= 14
    && Number(numericZone[3]) <= 59
    && (Number(numericZone[2]) < 14 || Number(numericZone[3]) === 0)
  );
  if (!calendarValid || hour > 23 || minute > 59 || second > 59 || !zoneValid) {
    return fallback("invalid", raw);
  }
  if (weekday && WEEKDAYS[weekday.toLowerCase()] !== localCalendar.getUTCDay()) {
    return fallback("invalid", raw);
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return fallback("invalid", raw);
  const providerTimestamp = Date.parse(providerReceivedAt);
  if (!Number.isFinite(providerTimestamp)) {
    throw invalidArgument("gmail.internalDate", "did not produce a canonical provider timestamp");
  }
  if (timestamp > providerTimestamp + MAX_RFC5322_FUTURE_SKEW_MS) {
    return fallback("future_conflict", raw);
  }
  return Object.freeze({
    raw,
    status: "valid",
    authoredAt: new Date(timestamp).toISOString(),
    chronologyEligible: true,
    fallbackSource: "",
  });
}

function normalizeStringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidArgument(field, "must be an array");
  return [...new Set(value.map((item, index) => requireString(item, `${field}[${index}]`, {
    allowEmpty: false,
  })))].sort();
}

function normalizeMailbox(mailbox) {
  if (!mailbox || typeof mailbox !== "object") return null;
  if (Array.isArray(mailbox.group)) {
    return {
      name: String(mailbox.name || ""),
      group: mailbox.group.map(normalizeMailbox).filter(Boolean),
    };
  }
  return {
    name: String(mailbox.name || ""),
    address: String(mailbox.address || "").toLowerCase(),
  };
}

function normalizeAddressList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeMailbox).filter(Boolean);
}

function normalizeHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers.map((header) => ({
    key: String(header?.key || "").toLowerCase(),
    originalKey: String(header?.originalKey || header?.key || ""),
    value: String(header?.value || ""),
  }));
}

function normalizedAuthenticationResultsValue(value) {
  return String(value || "").replace(/\r?\n[\t ]+/g, " ").replace(/\s+/g, " ").trim();
}

function authservIdForHeader(value) {
  return normalizedAuthenticationResultsValue(value).split(";", 1)[0].trim().toLowerCase();
}

function mechanismResult(value, mechanism) {
  const match = normalizedAuthenticationResultsValue(value)
    .match(new RegExp(`(?:^|[;\\s])${mechanism}=([a-z_]+)`, "i"));
  if (!match) return "unknown";
  return match[1].toLowerCase() === "pass" ? "pass"
    : match[1].toLowerCase() === "fail" ? "fail" : "unknown";
}

function normalizedDomain(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw || raw.length > 253) return "";
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) return "";
  const labels = ascii.split(".");
  if (labels.some((label) => !label || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return "";
  return ascii;
}

function trustedReceiverAuthenticationWitness(headers) {
  const authenticationResults = headers.map((header, ordinal) => ({ header, ordinal }))
    .filter(({ header }) => header.key === "authentication-results")
    .map(({ header, ordinal }) => {
      const normalizedValue = normalizedAuthenticationResultsValue(header.value);
      return {
        ordinal,
        authservId: authservIdForHeader(normalizedValue),
        headerHash: sha256Bytes(Buffer.from(normalizedValue, "utf8")),
        normalizedValue,
      };
    });
  const allHeadersManifestHash = sha256Json(authenticationResults.map((item) => ({
    ordinal: item.ordinal,
    authservId: item.authservId,
    headerHash: item.headerHash,
  })));
  const trusted = authenticationResults.filter((item) => (
    GMAIL_AUTH_WITNESS_POLICY.trustedReceiverAuthservIds.includes(item.authservId)
  ));
  const selected = trusted.length === 1 ? trusted[0] : null;
  const dmarc = selected ? mechanismResult(selected.normalizedValue, "dmarc") : "unknown";
  const dkim = selected ? mechanismResult(selected.normalizedValue, "dkim") : "unknown";
  const spf = selected ? mechanismResult(selected.normalizedValue, "spf") : "unknown";
  const fromMatch = selected?.normalizedValue.match(/(?:^|[;\s])header\.from=([^;\s]+)/i);
  const headerFromDomain = normalizedDomain(String(fromMatch?.[1] || "").replace(/[.;]+$/, ""));
  const domainBoundDmarc = dmarc === "pass" && !headerFromDomain ? "unknown" : dmarc;
  const status = domainBoundDmarc === "pass" ? "pass" : domainBoundDmarc === "fail" ? "fail" : "unknown";
  const reasonCode = trusted.length === 0 ? "trusted_auth_results_missing"
    : trusted.length > 1 ? "multiple_trusted_auth_results"
      : dmarc === "pass" && !headerFromDomain ? "trusted_dmarc_pass_header_from_invalid"
      : status === "pass" ? "trusted_dmarc_pass"
        : status === "fail" ? "trusted_dmarc_fail" : "trusted_dmarc_unknown";
  const body = {
    schemaVersion: GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
    status,
    authservId: selected?.authservId || "",
    selectorPolicyVersion: GMAIL_AUTH_WITNESS_POLICY.schemaVersion,
    selectorPolicyHash: GMAIL_AUTH_WITNESS_POLICY_HASH,
    authenticationResultsHeaderCount: authenticationResults.length,
    trustedHeaderCount: trusted.length,
    allHeadersManifestHash,
    selectedHeaderOrdinal: selected?.ordinal ?? null,
    selectedHeaderHash: selected?.headerHash || "",
    dmarc: domainBoundDmarc,
    dkim,
    spf,
    headerFromDomain,
    reasonCode,
  };
  const witnessHash = sha256Json(body);
  return Object.freeze({
    schemaVersion: GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
    witnessId: `gmail-auth-witness:v1:${witnessHash}`,
    witnessHash,
    ...body,
  });
}

function normalizeHeaderLines(headerLines) {
  if (!Array.isArray(headerLines)) return [];
  return headerLines.map((header) => ({
    key: String(header?.key || "").toLowerCase(),
    line: String(header?.line || ""),
  }));
}

function attachmentBytes(attachment, index) {
  const content = attachment?.content;
  if (typeof content === "string") {
    if (attachment?.encoding === "base64") return Buffer.from(content, "base64");
    return Buffer.from(content, "utf8");
  }
  return asBuffer(content, `attachments[${index}].content`);
}

function normalizeGmailEnvelope(value = {}) {
  if (!isPlainObject(value)) throw invalidArgument("gmail", "must be an object");
  const inputKeys = GMAIL_PARSED_ENVELOPE_KEYS.filter((key) => key !== "providerReceivedAt");
  if (Object.keys(value).sort().join("|") !== [...inputKeys].sort().join("|")) {
    throw invalidArgument("gmail", "must contain the exact parsed-message-v2 lineage fields");
  }
  const internalDate = parseGmailInternalDate(value.internalDate);
  const providerHistoryId = requireString(value.providerHistoryId, "gmail.providerHistoryId", { allowEmpty: false });
  const historyId = requireString(value.historyId, "gmail.historyId", { allowEmpty: false });
  if (![providerHistoryId, historyId].every((item) => /^\d+$/.test(item))) {
    throw invalidArgument("gmail.history", "provider history and compatibility history must be decimal strings");
  }
  if (historyId !== providerHistoryId) {
    throw invalidArgument("gmail.historyId", "must be an exact compatibility alias of providerHistoryId");
  }
  const labelIds = normalizeStringList(value.labelIds, "gmail.labelIds");
  const labelIdsHash = requireString(value.labelIdsHash, "gmail.labelIdsHash", { allowEmpty: false });
  if (!SHA256_RE.test(labelIdsHash) || labelIdsHash !== sha256Json(labelIds)) {
    throw invalidArgument("gmail.labelIdsHash", "must hash the canonical sorted labelIds");
  }
  const rawObservationId = requireString(value.rawObservationId, "gmail.rawObservationId", { allowEmpty: false });
  const rawObservationContentHash = requireString(
    value.rawObservationContentHash,
    "gmail.rawObservationContentHash",
    { allowEmpty: false },
  );
  if (!OBSERVATION_ID_RE.test(rawObservationId) || !SHA256_RE.test(rawObservationContentHash)) {
    throw invalidArgument("gmail.rawObservation", "must bind an immutable raw observation identity");
  }
  return {
    messageId: requireString(value.messageId, "gmail.messageId", { allowEmpty: false }),
    threadId: requireString(value.threadId, "gmail.threadId"),
    historyId,
    providerHistoryId,
    internalDate: internalDate.raw,
    providerReceivedAt: internalDate.sourceRecordedAt,
    labelIds,
    labelIdsHash,
    rawObservationId,
    rawObservationContentHash,
  };
}

function buildNormalizedText(parsed) {
  const addressText = (items) => items.flatMap((item) => item.group || [item])
    .map((item) => [item.name, item.address].filter(Boolean).join(" <") + (item.name && item.address ? ">" : ""))
    .filter(Boolean)
    .join(", ");
  return [
    parsed.subject ? `Subject: ${parsed.subject}` : "",
    parsed.from ? `From: ${addressText([parsed.from])}` : "",
    parsed.to.length ? `To: ${addressText(parsed.to)}` : "",
    parsed.cc.length ? `Cc: ${addressText(parsed.cc)}` : "",
    parsed.date ? `Date: ${parsed.date}` : "",
    parsed.text || "",
  ].filter(Boolean).join("\n");
}

async function parseGmailRfc822(input = {}) {
  if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
  const rawBytes = asBuffer(input.rawBytes);
  const maxRawBytes = input.maxRawBytes === undefined ? DEFAULT_MAX_RAW_BYTES : Number(input.maxRawBytes);
  const maxAttachments = input.maxAttachments === undefined
    ? DEFAULT_MAX_ATTACHMENTS
    : Number(input.maxAttachments);
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0) {
    throw invalidArgument("maxRawBytes", "must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxAttachments) || maxAttachments < 0) {
    throw invalidArgument("maxAttachments", "must be a non-negative safe integer");
  }
  if (rawBytes.length === 0) throw invalidArgument("rawBytes", "must not be empty");
  if (rawBytes.length > maxRawBytes) {
    throw new GmailRfc822ParserError("RFC822 message exceeds the configured parse limit", {
      code: "GMAIL_RFC822_LIMIT_EXCEEDED",
    });
  }
  const rawSha256 = sha256Bytes(rawBytes);
  if (input.expectedRawSha256 !== undefined) {
    const expected = requireString(input.expectedRawSha256, "expectedRawSha256", { allowEmpty: false });
    if (!SHA256_RE.test(expected)) throw invalidArgument("expectedRawSha256", "must be lowercase SHA-256 hex");
    if (expected !== rawSha256) {
      throw new GmailRfc822ParserError("RFC822 bytes do not match the expected raw hash", {
        code: "GMAIL_RFC822_RAW_HASH_MISMATCH",
      });
    }
  }
  const gmail = normalizeGmailEnvelope(input.gmail);

  let email;
  try {
    email = await PostalMime.parse(rawBytes, {
      attachmentEncoding: "arraybuffer",
      rfc822Attachments: true,
      maxNestingDepth: 40,
      maxHeadersSize: 2 * 1024 * 1024,
    });
  } catch (cause) {
    throw new GmailRfc822ParserError("RFC822 MIME parsing failed", {
      code: "GMAIL_RFC822_PARSE_FAILED",
      cause,
    });
  }
  const parsedAttachments = Array.isArray(email.attachments) ? email.attachments : [];
  if (parsedAttachments.length > maxAttachments) {
    throw new GmailRfc822ParserError("RFC822 message exceeds the configured attachment limit", {
      code: "GMAIL_RFC822_LIMIT_EXCEEDED",
    });
  }

  const attachments = parsedAttachments.map((attachment, index) => {
    const bytes = attachmentBytes(attachment, index);
    const contentHash = sha256Bytes(bytes);
    const metadata = {
      ordinal: index,
      filename: attachment.filename === null || attachment.filename === undefined
        ? ""
        : String(attachment.filename),
      mimeType: String(attachment.mimeType || "application/octet-stream").toLowerCase(),
      disposition: String(attachment.disposition || ""),
      related: Boolean(attachment.related),
      description: String(attachment.description || ""),
      contentId: String(attachment.contentId || "").replace(/^<|>$/g, ""),
      method: String(attachment.method || ""),
      bytes: bytes.length,
      contentHash,
    };
    return {
      attachmentId: `gmail-attachment:v1:${sha256Json({
        gmailMessageId: gmail.messageId,
        ordinal: index,
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        contentId: metadata.contentId,
        contentHash,
      })}`,
      metadata,
      bytes,
    };
  });

  const headers = normalizeHeaders(email.headers);
  const authenticationWitness = trustedReceiverAuthenticationWitness(headers);
  const rfc5322Date = dateHeaderDiagnostic(headers, gmail.providerReceivedAt);
  const sourceChronology = {
    schemaVersion: SOURCE_CHRONOLOGY_SCHEMA_VERSION,
    sourceRecordedAt: gmail.providerReceivedAt,
    sourceRecordedAtBasis: "gmail_internal_date",
    providerReceivedAt: gmail.providerReceivedAt,
    providerInternalDateMillis: gmail.internalDate,
    rfc5322Date,
  };
  const parsedMessage = {
    schemaVersion: SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    rawSha256,
    rawBytes: rawBytes.length,
    gmail,
    sourceChronology,
    authenticationWitness,
    headers,
    headerLines: normalizeHeaderLines(email.headerLines),
    from: normalizeMailbox(email.from),
    sender: normalizeMailbox(email.sender),
    replyTo: normalizeAddressList(email.replyTo),
    deliveredTo: String(email.deliveredTo || ""),
    returnPath: String(email.returnPath || ""),
    to: normalizeAddressList(email.to),
    cc: normalizeAddressList(email.cc),
    bcc: normalizeAddressList(email.bcc),
    subject: String(email.subject || ""),
    rfcMessageId: String(email.messageId || ""),
    inReplyTo: String(email.inReplyTo || ""),
    references: String(email.references || ""),
    date: rfc5322Date.authoredAt || gmail.providerReceivedAt,
    text: String(email.text || ""),
    html: String(email.html || ""),
    attachments: attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      ...attachment.metadata,
    })),
  };
  const normalizedText = buildNormalizedText(parsedMessage);
  return Object.freeze({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    rawSha256,
    sourceRecordedAt: gmail.providerReceivedAt,
    sourceChronology,
    parsedContentHash: sha256Json(parsedMessage),
    normalizedText,
    parsedMessage,
    attachments,
  });
}

module.exports = {
  DEFAULT_MAX_ATTACHMENTS,
  DEFAULT_MAX_RAW_BYTES,
  GmailRfc822ParserError,
  MAX_RFC5322_FUTURE_SKEW_MS,
  PARSER_VERSION,
  SCHEMA_VERSION,
  SOURCE_CHRONOLOGY_SCHEMA_VERSION,
  GMAIL_AUTH_WITNESS_POLICY,
  GMAIL_AUTH_WITNESS_POLICY_HASH,
  parseGmailInternalDate,
  parseGmailRfc822,
  _test: {
    buildNormalizedText,
    canonicalize,
    dateHeaderDiagnostic,
    normalizeAddressList,
    normalizedDomain,
    normalizeHeaders,
    trustedReceiverAuthenticationWitness,
    parseGmailInternalDate,
    sha256Bytes,
    sha256Json,
    stableJson,
  },
};

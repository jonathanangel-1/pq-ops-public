"use strict";

const RESOLVER_VERSION = "truth-temporal-resolver-v1";
const MONTHS = Object.freeze({
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
});

class TruthTemporalResolverError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "TruthTemporalResolverError";
    Object.assign(this, fields);
  }
}

function invalid(field, reason) {
  return new TruthTemporalResolverError(`Invalid temporal resolver ${field}: ${reason}`, {
    code: "TRUTH_TEMPORAL_RESOLVER_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function validDateParts(year, month, day) {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return false;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isoDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseAnchor(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value).trim();
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw invalid(field, "must be an ISO/RFC timestamp");
  const explicitOffset = raw.match(/(Z|[+-]\d{2}:?\d{2})$/i)?.[1] || "Z";
  const offset = explicitOffset.toUpperCase() === "Z"
    ? "Z"
    : explicitOffset.includes(":")
      ? explicitOffset
      : `${explicitOffset.slice(0, 3)}:${explicitOffset.slice(3)}`;
  const datePrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
    || new Date(timestamp).toISOString().slice(0, 10);
  return { raw, timestamp, offset, date: datePrefix };
}

function datePlusDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function normalizeHour(hour, minute, meridiem) {
  let normalizedHour = Number(hour);
  const normalizedMinute = Number(minute || 0);
  if (!Number.isSafeInteger(normalizedHour) || !Number.isSafeInteger(normalizedMinute)
    || normalizedHour < 0 || normalizedHour > 23 || normalizedMinute < 0 || normalizedMinute > 59) return null;
  if (meridiem) {
    if (normalizedHour < 1 || normalizedHour > 12) return null;
    if (meridiem.toLowerCase() === "pm" && normalizedHour !== 12) normalizedHour += 12;
    if (meridiem.toLowerCase() === "am" && normalizedHour === 12) normalizedHour = 0;
  }
  return { hour: normalizedHour, minute: normalizedMinute };
}

function exactTimestamp(text) {
  const match = text.match(/\b(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})\b/i);
  if (!match) return null;
  const [year, month, day] = match[1].split("-").map(Number);
  const time = normalizeHour(match[2], match[3]);
  const seconds = Number(match[4] || 0);
  if (!validDateParts(year, month, day) || !time || seconds < 0 || seconds > 59) return null;
  const offset = match[5].toUpperCase() === "Z"
    ? "Z"
    : match[5].includes(":") ? match[5] : `${match[5].slice(0, 3)}:${match[5].slice(3)}`;
  const raw = `${match[1]}T${pad(time.hour)}:${pad(time.minute)}:${pad(seconds)}${offset}`;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return {
    status: "exact",
    occurredAt: new Date(timestamp).toISOString(),
    occurredOn: match[1],
    basis: "explicit_timestamp",
    expression: match[0],
    start: match.index,
    end: match.index + match[0].length,
    confidence: 1,
  };
}

function relativeExpression(text, anchor) {
  if (!anchor) return null;
  const match = text.match(/\b(today|yesterday|tomorrow)\b(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (!match) return null;
  const dayDelta = { yesterday: -1, today: 0, tomorrow: 1 }[match[1].toLowerCase()];
  const date = datePlusDays(anchor.date, dayDelta);
  let occurredAt = null;
  let basis = "relative_date";
  let confidence = 0.9;
  if (match[2]) {
    const time = normalizeHour(match[2], match[3], match[4]);
    if (!time) return null;
    const timestamp = Date.parse(`${date}T${pad(time.hour)}:${pad(time.minute)}:00${anchor.offset}`);
    if (!Number.isFinite(timestamp)) return null;
    occurredAt = new Date(timestamp).toISOString();
    basis = "relative_date_time_anchored_to_message_offset";
    confidence = 0.95;
  }
  return {
    status: occurredAt ? "exact" : "date_only",
    occurredAt,
    occurredOn: date,
    basis,
    expression: match[0],
    start: match.index,
    end: match.index + match[0].length,
    confidence,
  };
}

function explicitDate(text, dateOrder) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso && validDateParts(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
    return {
      status: "date_only",
      occurredAt: null,
      occurredOn: isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3])),
      basis: "explicit_iso_date",
      expression: iso[0],
      start: iso.index,
      end: iso.index + iso[0].length,
      confidence: 1,
    };
  }
  const monthName = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*|\s+)(\d{4})\b/i);
  if (monthName) {
    const month = MONTHS[monthName[1].replace(/\.$/, "").toLowerCase()];
    const day = Number(monthName[2]);
    const year = Number(monthName[3]);
    if (validDateParts(year, month, day)) {
      return {
        status: "date_only",
        occurredAt: null,
        occurredOn: isoDate(year, month, day),
        basis: "explicit_month_name_date",
        expression: monthName[0],
        start: monthName.index,
        end: monthName.index + monthName[0].length,
        confidence: 0.99,
      };
    }
  }
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/);
  if (!numeric) return null;
  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
  if (first <= 12 && second <= 12 && !dateOrder) {
    return {
      status: "ambiguous",
      occurredAt: null,
      occurredOn: null,
      basis: "ambiguous_numeric_date_order",
      expression: numeric[0],
      start: numeric.index,
      end: numeric.index + numeric[0].length,
      confidence: 0,
    };
  }
  const useOrder = dateOrder || (first > 12 ? "DMY" : "MDY");
  const month = useOrder === "DMY" ? second : first;
  const day = useOrder === "DMY" ? first : second;
  if (!validDateParts(year, month, day)) return null;
  return {
    status: "date_only",
    occurredAt: null,
    occurredOn: isoDate(year, month, day),
    basis: `explicit_numeric_date_${useOrder.toLowerCase()}`,
    expression: numeric[0],
    start: numeric.index,
    end: numeric.index + numeric[0].length,
    confidence: first <= 12 && second <= 12 ? 0.9 : 0.98,
  };
}

function resolveTemporalExpression(input = {}) {
  if (!isPlainObject(input)) throw invalid("input", "must be an object");
  if (typeof input.text !== "string") throw invalid("text", "must be a string");
  const text = input.text;
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw invalid("text", "is too long");
  const dateOrder = input.dateOrder === undefined || input.dateOrder === null || input.dateOrder === ""
    ? null
    : String(input.dateOrder).toUpperCase();
  if (dateOrder && !["MDY", "DMY"].includes(dateOrder)) throw invalid("dateOrder", "must be MDY, DMY, or null");
  const messageAnchor = parseAnchor(input.messageDate, "messageDate");
  const captureAnchor = parseAnchor(input.capturedAt, "capturedAt");
  const anchor = messageAnchor || captureAnchor;
  let result = exactTimestamp(text)
    || relativeExpression(text, anchor)
    || explicitDate(text, dateOrder);
  if (!result) {
    result = {
      status: "none",
      occurredAt: null,
      occurredOn: null,
      basis: "no_explicit_temporal_expression",
      expression: "",
      start: null,
      end: null,
      confidence: 0,
    };
  }
  const effect = String(input.effect || "context");
  const anchorTimestamp = anchor?.timestamp ?? Number.POSITIVE_INFINITY;
  const occurredTimestamp = result.occurredAt ? Date.parse(result.occurredAt) : Number.NEGATIVE_INFINITY;
  if (["complete", "block"].includes(effect)
    && Number.isFinite(occurredTimestamp)
    && Number.isFinite(anchorTimestamp)
    && occurredTimestamp > anchorTimestamp + 60 * 60 * 1000) {
    result = {
      ...result,
      status: "future_conflict",
      occurredAt: null,
      basis: "explicit_time_is_after_source_message",
      confidence: 0,
    };
  }
  return Object.freeze({
    resolverVersion: RESOLVER_VERSION,
    ...result,
  });
}

module.exports = {
  RESOLVER_VERSION,
  TruthTemporalResolverError,
  resolveTemporalExpression,
  _test: {
    datePlusDays,
    exactTimestamp,
    explicitDate,
    normalizeHour,
    parseAnchor,
    relativeExpression,
    validDateParts,
  },
};

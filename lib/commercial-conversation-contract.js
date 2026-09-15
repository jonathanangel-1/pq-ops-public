"use strict";

const COMMERCIAL_CLAIM_TYPES = Object.freeze([
  "quote_requested",
  "quote_received",
  "counterparty_question_open",
  "question_answered",
  "deadline_asserted",
  "commitment_made",
  "quote_accepted",
  "quote_confirmed",
  "payment_evidence",
]);

const COMMERCIAL_CLAIM_TYPE_SET = new Set(COMMERCIAL_CLAIM_TYPES);
const DEADLINE_AT_RISK_DAYS = Object.freeze({ lfd: 2, appointment: 1, cutoff: 1 });
const VALUE_SCHEMA_VERSION = "commercial-conversation-claim-value-v1";
const SECTION_SCHEMA_VERSION = "shipment-commercial-conversation-v1";
const DEADLINE_CLOCK_POLICY_VERSION = "commercial-deadline-clock-v1";

class CommercialConversationContractError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "CommercialConversationContractError";
    this.code = fields.code || "COMMERCIAL_CONVERSATION_CONTRACT_INVALID";
    this.field = fields.field || "";
  }
}

function invalid(field, reason) {
  return new CommercialConversationContractError(
    `Invalid commercial conversation ${field}: ${reason}`,
    { field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
}

function normalizedToken(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sortedUnique(values) {
  return [...new Set((values || []).map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw invalid(field, allowEmpty ? "must be a string" : "must be a non-empty string");
  }
  return value.trim();
}

function requireClaimId(value, field) {
  const id = requireString(value, field);
  if (!/^claim:v1:[0-9a-f]{64}$/.test(id)) throw invalid(field, "must be a claim:v1 identity");
  return id;
}

function requireDate(value, field) {
  const date = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid(field, "must be an ISO calendar date");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw invalid(field, "must be a real ISO calendar date");
  }
  return date;
}

function requireMoney(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
    throw invalid(field, "must be a positive amount with at most two decimal places");
  }
  return amount;
}

function normalizeOffers(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw invalid(field, "must contain one through twenty offers");
  }
  return value.map((offer, index) => {
    if (!isPlainObject(offer)) throw invalid(`${field}[${index}]`, "must be an object");
    const allowed = new Set(["amountUsd", "equipment"]);
    const extra = Object.keys(offer).filter((key) => !allowed.has(key));
    if (extra.length) throw invalid(`${field}[${index}]`, `contains unsupported keys: ${extra.join(", ")}`);
    const normalized = { amountUsd: requireMoney(offer.amountUsd, `${field}[${index}].amountUsd`) };
    if (offer.equipment !== undefined) normalized.equipment = normalizedToken(offer.equipment);
    if (offer.equipment !== undefined && !normalized.equipment) {
      throw invalid(`${field}[${index}].equipment`, "must be a normalized non-empty token");
    }
    return normalized;
  }).sort((left, right) => (
    left.amountUsd - right.amountUsd
    || text(left.equipment).localeCompare(text(right.equipment))
  ));
}

function normalizeTopics(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw invalid(field, "must contain one through twenty topics");
  }
  const topics = value.map((item, index) => {
    const topic = normalizedToken(item);
    if (!topic) throw invalid(`${field}[${index}]`, "must be a normalized non-empty topic");
    return topic;
  });
  const unique = sortedUnique(topics);
  if (unique.length !== topics.length) throw invalid(field, "must not contain duplicates");
  return unique;
}

function requireValue(claim, index) {
  const value = claim.normalizedValue;
  if (!isPlainObject(value) || value.schemaVersion !== VALUE_SCHEMA_VERSION) {
    throw invalid(`claims[${index}].normalizedValue`, `must be ${VALUE_SCHEMA_VERSION}`);
  }
  const predicate = normalizedToken(claim.predicate);
  const common = {
    claimVersionId: requireClaimId(claim.claimVersionId, `claims[${index}].claimVersionId`),
    predicate,
    occurredAt: text(claim.occurredAt),
    messageId: requireString(value.messageId, `claims[${index}].normalizedValue.messageId`),
    counterparty: text(value.counterparty).toLowerCase(),
    value,
  };
  if (!COMMERCIAL_CLAIM_TYPE_SET.has(predicate)) {
    throw invalid(`claims[${index}].predicate`, "is not a commercial claim type");
  }
  if ([
    "quote_requested", "quote_received", "counterparty_question_open",
    "commitment_made", "quote_accepted", "quote_confirmed",
  ].includes(predicate) && !common.counterparty) {
    throw invalid(`claims[${index}].normalizedValue.counterparty`, "is required");
  }
  return common;
}

function deriveCommercialConversation(claims) {
  const commercialAll = (claims || []).filter((claim) => (
    COMMERCIAL_CLAIM_TYPE_SET.has(normalizedToken(claim?.predicate))
  ));
  // Accepted claims minted before the v1 value vocabulary existed cannot
  // satisfy it and must not fail the build: they are excluded from the
  // derived section but recorded by id, and stay visible in the shipment's
  // acceptedClaimIds. New extractions always carry the v1 value schema.
  const legacyExcludedClaimVersionIds = sortedUnique(commercialAll
    .filter((claim) => !isPlainObject(claim?.normalizedValue)
      || claim.normalizedValue.schemaVersion !== VALUE_SCHEMA_VERSION)
    .map((claim, index) => requireClaimId(claim.claimVersionId, `legacyClaims[${index}].claimVersionId`)));
  const commercial = commercialAll.filter((claim) => (
    isPlainObject(claim?.normalizedValue)
    && claim.normalizedValue.schemaVersion === VALUE_SCHEMA_VERSION
  )).map(requireValue);
  const sourceClaimVersionIds = sortedUnique(commercial.map((item) => item.claimVersionId));
  const quoteRows = new Map();
  const ensureQuote = (counterparty) => {
    const key = text(counterparty).toLowerCase();
    if (!quoteRows.has(key)) {
      quoteRows.set(key, {
        counterparty: key,
        offers: [],
        status: "requested",
        requestClaimVersionIds: [],
        receivedClaimVersionIds: [],
        acceptanceClaimVersionIds: [],
        confirmationClaimVersionIds: [],
      });
    }
    return quoteRows.get(key);
  };
  const questions = new Map();
  const answeredMessageIds = new Set();
  const commitments = new Map();
  const fulfilledCommitmentMessageIds = new Set();
  const deadlines = [];
  const payments = [];

  for (const item of commercial) {
    const { claimVersionId, predicate, value, counterparty } = item;
    if (predicate === "quote_requested") {
      ensureQuote(counterparty).requestClaimVersionIds.push(claimVersionId);
    } else if (predicate === "quote_received") {
      const row = ensureQuote(counterparty);
      row.offers.push(...normalizeOffers(value.offers, `claim ${claimVersionId}.offers`).map((offer) => ({
        ...offer,
        sourceClaimVersionId: claimVersionId,
      })));
      row.receivedClaimVersionIds.push(claimVersionId);
      if (text(value.fulfillsCommitmentMessageId)) {
        fulfilledCommitmentMessageIds.add(text(value.fulfillsCommitmentMessageId));
      }
    } else if (predicate === "quote_accepted") {
      ensureQuote(counterparty).acceptanceClaimVersionIds.push(claimVersionId);
    } else if (predicate === "quote_confirmed") {
      ensureQuote(counterparty).confirmationClaimVersionIds.push(claimVersionId);
    } else if (predicate === "counterparty_question_open") {
      questions.set(item.messageId, {
        questionMessageId: item.messageId,
        topics: normalizeTopics(value.topics, `claim ${claimVersionId}.topics`),
        askedBy: counterparty,
        waitingOn: normalizedToken(value.waitingOn || "operator"),
        sourceClaimVersionIds: [claimVersionId],
      });
    } else if (predicate === "question_answered") {
      const questionMessageId = requireString(
        value.questionMessageId,
        `claim ${claimVersionId}.questionMessageId`,
      );
      answeredMessageIds.add(questionMessageId);
    } else if (predicate === "deadline_asserted") {
      const kind = normalizedToken(value.deadlineKind);
      if (!Object.hasOwn(DEADLINE_AT_RISK_DAYS, kind)) {
        throw invalid(`claim ${claimVersionId}.deadlineKind`, "must be lfd, appointment, or cutoff");
      }
      deadlines.push({
        kind,
        dueDate: requireDate(value.dueDate, `claim ${claimVersionId}.dueDate`),
        precision: "calendar_day",
        sourceClaimVersionIds: [claimVersionId],
      });
    } else if (predicate === "commitment_made") {
      commitments.set(item.messageId, {
        commitmentMessageId: item.messageId,
        counterparty,
        what: requireString(value.what, `claim ${claimVersionId}.what`),
        dueBy: text(value.dueBy) || null,
        sourceClaimVersionIds: [claimVersionId],
      });
    } else if (predicate === "payment_evidence") {
      payments.push({
        amountUsd: requireMoney(value.amountUsd, `claim ${claimVersionId}.amountUsd`),
        payee: text(value.payee),
        sourceClaimVersionIds: [claimVersionId],
      });
    }
  }

  for (const messageId of answeredMessageIds) questions.delete(messageId);
  for (const messageId of fulfilledCommitmentMessageIds) commitments.delete(messageId);

  const quotes = [...quoteRows.values()].map((row) => {
    row.offers.sort((left, right) => (
      left.amountUsd - right.amountUsd
      || text(left.equipment).localeCompare(text(right.equipment))
      || left.sourceClaimVersionId.localeCompare(right.sourceClaimVersionId)
    ));
    row.requestClaimVersionIds = sortedUnique(row.requestClaimVersionIds);
    row.receivedClaimVersionIds = sortedUnique(row.receivedClaimVersionIds);
    row.acceptanceClaimVersionIds = sortedUnique(row.acceptanceClaimVersionIds);
    row.confirmationClaimVersionIds = sortedUnique(row.confirmationClaimVersionIds);
    row.status = row.confirmationClaimVersionIds.length ? "confirmed"
      : row.acceptanceClaimVersionIds.length ? "accepted"
        : row.receivedClaimVersionIds.length ? "received" : "requested";
    return row;
  }).sort((left, right) => left.counterparty.localeCompare(right.counterparty));
  const allOffers = quotes.flatMap((row) => row.offers.map((offer) => ({
    ...offer,
    counterparty: row.counterparty,
  }))).sort((left, right) => (
    left.amountUsd - right.amountUsd
    || left.counterparty.localeCompare(right.counterparty)
    || text(left.equipment).localeCompare(text(right.equipment))
    || left.sourceClaimVersionId.localeCompare(right.sourceClaimVersionId)
  ));
  const best = allOffers[0] || null;
  const bestRate = best ? {
    counterparty: best.counterparty,
    amountUsd: best.amountUsd,
    ...(best.equipment ? { equipment: best.equipment } : {}),
    sourceClaimVersionId: best.sourceClaimVersionId,
  } : null;
  const quotesOutstanding = quotes
    .filter((row) => row.requestClaimVersionIds.length && !row.receivedClaimVersionIds.length)
    .map((row) => row.counterparty);
  const feesPaidUsd = payments.length
    ? payments.reduce((sum, payment) => sum + payment.amountUsd, 0)
    : null;

  return {
    schemaVersion: SECTION_SCHEMA_VERSION,
    status: sourceClaimVersionIds.length ? "active" : "empty",
    quotes,
    quoteCount: quotes.filter((row) => row.receivedClaimVersionIds.length).length,
    bestRate,
    quotesOutstanding,
    openQuestions: [...questions.values()].sort((left, right) => (
      left.questionMessageId.localeCompare(right.questionMessageId)
    )),
    deadlines: deadlines.sort((left, right) => (
      left.dueDate.localeCompare(right.dueDate)
      || left.kind.localeCompare(right.kind)
      || left.sourceClaimVersionIds[0].localeCompare(right.sourceClaimVersionIds[0])
    )),
    commitmentsOutstanding: [...commitments.values()].sort((left, right) => (
      left.commitmentMessageId.localeCompare(right.commitmentMessageId)
    )),
    payments: payments.sort((left, right) => (
      left.amountUsd - right.amountUsd
      || left.sourceClaimVersionIds[0].localeCompare(right.sourceClaimVersionIds[0])
    )),
    feesPaidUsd,
    sourceClaimVersionIds,
    ...(legacyExcludedClaimVersionIds.length ? { legacyExcludedClaimVersionIds } : {}),
  };
}

function utcCalendarDay(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalid(field, "must be a timestamp");
  return parsed.toISOString().slice(0, 10);
}

function calendarDaysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  return Math.round((to - from) / 86400000);
}

function evaluateDeadline(dueDate, kind, evaluatedAt) {
  const normalizedKind = normalizedToken(kind);
  if (!Object.hasOwn(DEADLINE_AT_RISK_DAYS, normalizedKind)) {
    throw invalid("deadline.kind", "must be lfd, appointment, or cutoff");
  }
  const due = requireDate(dueDate, "deadline.dueDate");
  const asOfDate = utcCalendarDay(evaluatedAt, "deadline.evaluatedAt");
  const daysRemaining = calendarDaysBetween(asOfDate, due);
  const atRiskDays = DEADLINE_AT_RISK_DAYS[normalizedKind];
  const state = daysRemaining < 0 ? "overdue"
    : daysRemaining === 0 ? "due_today"
      : daysRemaining <= atRiskDays ? "at_risk" : "upcoming";
  return {
    state,
    daysRemaining,
    atRiskDays,
    precision: "calendar_day",
    policyVersion: DEADLINE_CLOCK_POLICY_VERSION,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
  };
}

function evaluateCommercialDeadlines(section, evaluatedAt) {
  if (!isPlainObject(section) || section.schemaVersion !== SECTION_SCHEMA_VERSION) {
    throw invalid("section", `must be ${SECTION_SCHEMA_VERSION}`);
  }
  return {
    ...section,
    deadlines: (section.deadlines || []).map((deadline) => ({
      ...deadline,
      countdown: evaluateDeadline(deadline.dueDate, deadline.kind, evaluatedAt),
    })),
  };
}

module.exports = {
  COMMERCIAL_CLAIM_TYPES,
  DEADLINE_AT_RISK_DAYS,
  DEADLINE_CLOCK_POLICY_VERSION,
  SECTION_SCHEMA_VERSION,
  VALUE_SCHEMA_VERSION,
  CommercialConversationContractError,
  deriveCommercialConversation,
  evaluateCommercialDeadlines,
  evaluateDeadline,
  _test: { calendarDaysBetween, normalizeOffers, normalizeTopics },
};

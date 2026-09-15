"use strict";

const crypto = require("node:crypto");
const {
  VALUE_SCHEMA_VERSION,
} = require("./commercial-conversation-contract");

const EXTRACTOR_VERSION = "commercial-conversation-extractor-v1";
const AUTHORITY_SCHEMA_VERSION = "commercial-conversation-exchange-append-v1";

// Deterministic commercial-conversation extractor (task #50, layer-2 v1).
//
// Reconstructs the exchange graph of a shipment's commercial email threads
// from provable surface anchors only: money amounts, deadline vocabulary,
// interrogatives, reply structure, and sender/recipient identity. No model
// calls. Context-dependent reads this pass cannot prove are left OUT — the
// model lane proposes those later as edges between these anchors, under
// review. Scored by scripts/eval-commercial-conversation.js.
//
// Input per case: { messages: [{ messageId, at, from, to?, subject?, text }] }
// (chronological order not assumed; sorted internally by `at`).

const INTERNAL_DOMAINS = ["partner-116.example", "partner-120.example"];
const PAYMENT_SENDER_PATTERNS = [/cargosprint\.com$/i];
const EQUIPMENT_WORDS = [
  ["sprinter", "sprinter"],
  ["box truck", "box_truck"],
  ["boc truck", "box_truck"], // observed live typo
  ["straight truck", "straight_truck"],
  ["van", "van"],
  ["flatbed", "flatbed"],
];
const QUESTION_TOPIC_WORDS = [
  ["lfd", "lfd"],
  ["last free day", "lfd"],
  ["arriv", "arrival"],
  ["appointment", "delivery_appointment"],
  ["eta", "eta"],
  ["pod", "pod"],
  ["release", "release"],
];
const COMMITMENT_PATTERNS = [
  /\bwill circle back\b/i,
  /\bwill get back\b/i,
  /\bwill follow up\b/i,
  /\bwill (?:have|send|get) (?:a |the )?(?:rate|quote|carrier|update)[^.?]*\b(?:over|to you|shortly|soon|in the morning|later|tomorrow)\b/i,
];

function domainOf(address) {
  const at = String(address || "").lastIndexOf("@");
  return at === -1 ? "" : String(address).slice(at + 1).toLowerCase();
}

function isInternal(address) {
  const d = domainOf(address);
  return INTERNAL_DOMAINS.some((x) => d === x || d.endsWith("." + x));
}

function normalizeAwbSerial(raw) {
  return String(raw || "").replace(/[^0-9]/g, "");
}

function extractAmounts(text) {
  const out = [];
  const re = /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const amount = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) out.push({ amountUsd: amount, index: m.index });
  }
  return out;
}

function nearestEquipment(text, index) {
  const lower = text.toLowerCase();
  let best = null;
  for (const [word, tag] of EQUIPMENT_WORDS) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(word, from);
      if (i === -1) break;
      const distance = Math.abs(i - index);
      if (distance <= 24 && (best === null || distance < best.distance)) best = { tag, distance };
      from = i + word.length;
    }
  }
  return best ? best.tag : null;
}

// Strip quoted history: everything after the first inline "From:" header is
// prior-thread material, not the author's own words.
function authoredPortion(text) {
  return authoredRange(text).text;
}

function authoredRange(text) {
  const source = String(text || "");
  const boundary = source.match(/\bFrom:\s|\bOn \w{3}, /s);
  let start = 0;
  let end = boundary?.index ?? source.length;
  while (start < end && /\s/u.test(source[start])) start += 1;
  while (end > start && /\s/u.test(source[end - 1])) end -= 1;
  return { text: source.slice(start, end), start, end };
}

function evidenceSpan(text, preferredRange = null) {
  const source = String(text || "");
  let start = preferredRange?.start ?? 0;
  let end = preferredRange?.end ?? source.length;
  if (end <= start) {
    start = 0;
    end = source.length;
    while (start < end && /\s/u.test(source[start])) start += 1;
    while (end > start && /\s/u.test(source[end - 1])) end -= 1;
  }
  if (end <= start) throw new TypeError("commercial conversation evidence span cannot be empty");
  return {
    basis: "normalized_payload.text",
    unit: "utf16_code_units",
    start,
    end,
    quote: source.slice(start, end),
  };
}

function questionTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];
  for (const [word, topic] of QUESTION_TOPIC_WORDS) {
    if (lower.includes(word) && !topics.includes(topic)) topics.push(topic);
  }
  return topics;
}

// "LFD 7.20" / "LFD 07/20" / "LFD July 20" → ISO date in the message's year,
// month/day read US-style, validated against the message timestamp so the
// deadline is never in the past relative to the assertion.
function extractLfdAssertion(text, messageAtIso) {
  const m = text.match(/\bLFD[\s:]*([0-9]{1,2})[./-]([0-9]{1,2})\b/i);
  if (!m) return null;
  const at = new Date(messageAtIso);
  if (Number.isNaN(at.getTime())) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = at.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getTime() < at.getTime() - 24 * 3600 * 1000) year += 1;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return { kind: "lfd", date: `${year}-${mm}-${dd}` };
}

function classifyMessage(message) {
  const authoredEvidence = authoredRange(message.text);
  const authored = authoredEvidence.text;
  const span = evidenceSpan(message.text, authoredEvidence);
  const labels = [];
  const fromInternal = isInternal(message.from);
  const senderIsPayment = PAYMENT_SENDER_PATTERNS.some((re) => re.test(domainOf(message.from)));

  if (senderIsPayment && /payment/i.test(message.text)) {
    const amounts = extractAmounts(message.text);
    labels.push({
      type: "payment_evidence",
      amountUsd: amounts.length ? amounts[0].amountUsd : undefined,
      evidenceSpan: evidenceSpan(message.text),
    });
    return labels;
  }

  const amounts = extractAmounts(authored);
  const lfd = extractLfdAssertion(authored, message.at);
  const asksQuestion = authored.includes("?");
  const topics = asksQuestion ? questionTopics(authored) : [];

  if (fromInternal) {
    // Outbound. Rate solicitation: a short authored note around "rate?" on a
    // forwarded alert. Tolerates observed live typos (RATR?) by accepting any
    // single authored token ending in "?" alongside a forwarded alert subject.
    const recipientDomain = domainOf(Array.isArray(message.to) ? message.to[0] : message.to);
    const externalRecipient = recipientDomain && !INTERNAL_DOMAINS.some((x) => recipientDomain === x || recipientDomain.endsWith("." + x));
    const alertForward = /INBOUND ALERT|Pre Alert/i.test(message.subject || "") || /INBOUND ALERT|Pre Alert/i.test(message.text);
    const shortAsk = /\b(?:ra[te]{1,3}|quote|price)\s*\?/i.test(authored)
      || (authored.length <= 40 && authored.includes("?") && alertForward)
      // A bare forward of an inbound alert to an external counterparty IS the
      // rate solicitation — observed operator practice, no authored words.
      || (authored.length === 0 && alertForward && externalRecipient);
    if (shortAsk) {
      labels.push({
        type: "quote_request",
        counterparty: domainOf(Array.isArray(message.to) ? message.to[0] : message.to),
        evidenceSpan: span,
      });
      return labels;
    }
    if (lfd) {
      labels.push({ type: "answer", asserts: lfd, evidenceSpan: span });
      return labels;
    }
    if (/^ok\b|^confirm(?:ed)?\b|\bok confirm\b|\bbook it\b|\bgo ahead\b/i.test(authored)) {
      labels.push({ type: "acceptance", evidenceSpan: span });
      return labels;
    }
    return labels;
  }

  // Inbound from a counterparty.
  if (amounts.length > 0) {
    labels.push({
      type: "quote",
      offers: amounts.map((a) => {
        const equipment = nearestEquipment(authored, a.index);
        return equipment ? { amountUsd: a.amountUsd, equipment } : { amountUsd: a.amountUsd };
      }),
      evidenceSpan: span,
    });
    return labels;
  }
  const confirms = /^confirmed\b/i.test(authored);
  if (confirms) labels.push({ type: "confirmation", evidenceSpan: span });
  if (asksQuestion && topics.length > 0 && !confirms) {
    labels.push({ type: "question", topics, evidenceSpan: span });
    return labels;
  }
  if (asksQuestion && confirms) {
    // A confirmation that also asks something new keeps both meanings.
    const followTopics = questionTopics(authored);
    labels.push({
      type: "question",
      topics: followTopics.length ? followTopics : ["unspecified"],
      evidenceSpan: span,
    });
    return labels;
  }
  if (!confirms && COMMITMENT_PATTERNS.some((re) => re.test(authored))) {
    labels.push({ type: "commitment", what: authored.slice(0, 120), evidenceSpan: span });
  }
  return labels;
}

function buildEdges(messages, labeled, awb) {
  const edges = [];
  const byId = new Map(messages.map((m) => [m.messageId, m]));
  const sorted = [...messages].sort((a, b) => new Date(a.at) - new Date(b.at));
  const labelsOf = (id) => labeled.get(id) || [];
  const has = (id, type) => labelsOf(id).some((l) => l.type === type);

  const requestByCounterparty = new Map();
  for (const m of sorted) {
    for (const l of labelsOf(m.messageId)) {
      if (l.type === "quote_request" && l.counterparty) requestByCounterparty.set(l.counterparty, m.messageId);
    }
  }

  let lastOpenQuestion = null;
  let lastCommitmentBySender = new Map();
  let lastQuote = null;
  let lastAcceptance = null;

  for (const m of sorted) {
    const senderDomain = domainOf(m.from);
    for (const l of labelsOf(m.messageId)) {
      if ((l.type === "quote" || l.type === "question" || l.type === "commitment") && requestByCounterparty.has(senderDomain)) {
        const req = requestByCounterparty.get(senderDomain);
        if (req !== m.messageId) {
          // A counterparty's early substantive replies respond to the request
          // sent to that counterparty; once the exchange has progressed to
          // acceptance/confirmation, later messages relate to that flow, not
          // the original solicitation.
          const progressed = edges.some((e) => (e.type === "accepts" || e.type === "confirms"));
          if (!progressed && !edges.some((e) => e.type === "responds_to" && e.from === m.messageId && e.to === req)) {
            edges.push({ type: "responds_to", from: m.messageId, to: req });
          }
        }
      }
      if (l.type === "question") lastOpenQuestion = m.messageId;
      if (l.type === "answer" && lastOpenQuestion) {
        edges.push({ type: "answers", from: m.messageId, to: lastOpenQuestion });
        lastOpenQuestion = null;
      }
      if (l.type === "commitment") lastCommitmentBySender.set(senderDomain, m.messageId);
      if (l.type === "quote") {
        const commitment = lastCommitmentBySender.get(senderDomain);
        if (commitment) {
          edges.push({ type: "fulfills_commitment", from: m.messageId, to: commitment });
          lastCommitmentBySender.delete(senderDomain);
        }
        lastQuote = m.messageId;
      }
      if (l.type === "acceptance" && lastQuote) {
        edges.push({ type: "accepts", from: m.messageId, to: lastQuote });
        lastAcceptance = m.messageId;
      }
      if (l.type === "confirmation" && lastAcceptance) {
        edges.push({ type: "confirms", from: m.messageId, to: lastAcceptance });
      }
      if (l.type === "payment_evidence" && awb) {
        const serial = normalizeAwbSerial(awb).slice(-8);
        const textSerial = normalizeAwbSerial(m.text);
        if (serial && textSerial.includes(serial)) {
          edges.push({ type: "evidences_fee_payment_for", from: m.messageId, to: `awb:${awb}` });
        }
      }
    }
  }
  return edges;
}

function deriveState(messages, labeled, edges) {
  const labelsOf = (id) => labeled.get(id) || [];
  const quotes = [];
  const deadlines = [];
  let feesPaidUsd;
  const requested = new Map(); // counterparty -> requestMessageId
  const respondedCounterparties = new Set();
  const questions = new Map(); // messageId -> {topics, from}
  let accepted = false;

  for (const m of messages) {
    for (const l of labelsOf(m.messageId)) {
      if (l.type === "quote_request" && l.counterparty) requested.set(l.counterparty, m.messageId);
      if (l.type === "quote") quotes.push({ from: domainOf(m.from), offers: l.offers || [] });
      if (l.type === "answer" && l.asserts) deadlines.push(l.asserts);
      if (l.type === "question") questions.set(m.messageId, { topics: l.topics || [], from: domainOf(m.from) });
      if (l.type === "acceptance") accepted = true;
      if (l.type === "payment_evidence" && l.amountUsd !== undefined) feesPaidUsd = l.amountUsd;
    }
  }
  for (const q of quotes) respondedCounterparties.add(q.from);
  for (const e of edges) if (e.type === "answers") questions.delete(e.to);

  const allOffers = quotes.flatMap((q) => q.offers.map((o) => o.amountUsd)).filter((n) => Number.isFinite(n));
  const state = {
    quotesReceived: quotes.length,
    bestQuoteUsd: allOffers.length ? Math.min(...allOffers) : undefined,
    quotesOutstanding: [...requested.keys()].filter((c) => !respondedCounterparties.has(c)),
    openQuestions: [...questions.values()].map((q) => ({ topic: q.topics[0] || "unspecified", askedBy: q.from, waitingOn: "operator" })),
    deadlines,
  };
  if (accepted) state.quoteAccepted = true;
  if (feesPaidUsd !== undefined) state.feesPaidUsd = feesPaidUsd;
  return state;
}

function extractCase({ awb, messages }) {
  const labeled = new Map();
  for (const m of messages) labeled.set(m.messageId, classifyMessage(m));
  const edges = buildEdges(messages, labeled, awb);
  const derivedState = deriveState(messages, labeled, edges);
  return {
    messages: messages.map((m) => ({ messageId: m.messageId, labels: labeled.get(m.messageId) })),
    edges,
    derivedState,
  };
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function edgeArcKind(edge) {
  if (["answers"].includes(edge.type)) return "question";
  if (["fulfills_commitment"].includes(edge.type)) return "commitment";
  return "procurement";
}

function labelArcKind(label) {
  if (["question", "answer"].includes(label.type)) return "question";
  if (label.type === "commitment") return "commitment";
  return "procurement";
}

function labelClaimTypes(label) {
  const map = {
    quote_request: ["quote_requested"],
    quote: ["quote_received"],
    question: ["counterparty_question_open"],
    answer: ["question_answered", "deadline_asserted"],
    commitment: ["commitment_made"],
    acceptance: ["quote_accepted"],
    confirmation: ["quote_confirmed"],
    payment_evidence: ["payment_evidence"],
  };
  return map[label.type] || [];
}

function relatedMessage(edges, type, from) {
  return edges.find((edge) => edge.type === type && edge.from === from)?.to || "";
}

function messageDomain(message, direction) {
  const address = direction === "to"
    ? (Array.isArray(message.to) ? message.to[0] : message.to)
    : message.from;
  return domainOf(address);
}

function claimValue({ claimType, label, message, edges }) {
  const inboundCounterparty = isInternal(message.from)
    ? messageDomain(message, "to")
    : messageDomain(message, "from");
  const common = {
    schemaVersion: VALUE_SCHEMA_VERSION,
    messageId: message.messageId,
    threadId: String(message.threadId || ""),
    counterparty: inboundCounterparty,
  };
  if (claimType === "quote_requested") return { ...common, status: "requested", effect: "request" };
  if (claimType === "quote_received") return {
    ...common,
    status: "received",
    effect: "context",
    offers: label.offers || [],
    requestMessageId: relatedMessage(edges, "responds_to", message.messageId),
    fulfillsCommitmentMessageId: relatedMessage(edges, "fulfills_commitment", message.messageId),
  };
  if (claimType === "counterparty_question_open") return {
    ...common,
    status: "open",
    effect: "request",
    topics: label.topics || ["unspecified"],
    waitingOn: "operator",
  };
  if (claimType === "question_answered") return {
    ...common,
    status: "answered",
    effect: "context",
    questionMessageId: relatedMessage(edges, "answers", message.messageId),
  };
  if (claimType === "deadline_asserted") return {
    ...common,
    status: "asserted",
    effect: "context",
    deadlineKind: label.asserts?.kind,
    dueDate: label.asserts?.date,
  };
  if (claimType === "commitment_made") return {
    ...common,
    status: "outstanding",
    effect: "context",
    what: label.what,
    dueBy: label.impliedDueBy || null,
  };
  if (claimType === "quote_accepted") return {
    ...common,
    status: "accepted",
    effect: "context",
    quoteMessageId: relatedMessage(edges, "accepts", message.messageId),
  };
  if (claimType === "quote_confirmed") return {
    ...common,
    status: "confirmed",
    effect: "context",
    acceptanceMessageId: relatedMessage(edges, "confirms", message.messageId),
  };
  if (claimType === "payment_evidence") return {
    ...common,
    status: "paid",
    effect: "context",
    amountUsd: label.amountUsd,
    payee: label.payee || "",
  };
  throw new TypeError(`unsupported commercial claim type ${claimType}`);
}

function buildAuthorityInput({ awb, caseId, messages, observationsByMessageId, extraction = null }) {
  const extracted = extraction || extractCase({ awb, messages });
  const messageById = new Map(messages.map((message) => [message.messageId, message]));
  const anchors = [];
  const anchorByMessageAndType = new Map();
  const candidates = [];
  for (const extractedMessage of extracted.messages) {
    const message = messageById.get(extractedMessage.messageId);
    const observation = observationsByMessageId?.[extractedMessage.messageId];
    if (!message || !observation) throw new TypeError(`missing message observation ${extractedMessage.messageId}`);
    for (const [labelOrdinal, label] of extractedMessage.labels.entries()) {
      const anchorKey = `anchor:${sha256Text(`${extractedMessage.messageId}:${labelOrdinal}:${label.type}`)}`;
      const anchor = {
        anchorKey,
        observationId: observation.observationId,
        observationContentHash: observation.contentHash,
        messageId: extractedMessage.messageId,
        threadId: String(message.threadId || observation.threadId || ""),
        labelType: label.type,
        arcKind: labelArcKind(label),
        span: label.evidenceSpan,
      };
      anchors.push(anchor);
      anchorByMessageAndType.set(`${extractedMessage.messageId}:${label.type}`, anchorKey);
      for (const claimType of labelClaimTypes(label)) {
        candidates.push({
          anchorKey,
          claimType,
          identityKey: `${extractedMessage.messageId}:${claimType}`,
          subjectType: "shipment",
          subjectKey: normalizeAwbSerial(awb),
          polarity: ["quote_requested", "counterparty_question_open"].includes(claimType)
            ? "requested" : claimType === "deadline_asserted" || claimType === "commitment_made"
              ? "neutral" : "positive",
          normalizedValue: claimValue({ claimType, label, message, edges: extracted.edges }),
          occurredAt: message.at,
          confidence: 1,
          confidenceLabel: "high",
          extractionMethod: "deterministic",
          recommendation: "review",
          reviewReasons: ["commercial_conversation_v1_requires_operator_review"],
        });
      }
    }
  }
  const anchorForEdgeEndpoint = (messageId, edgeType, side) => {
    const labelTypes = side === "from"
      ? ({
        responds_to: ["quote", "question", "commitment"],
        answers: ["answer"],
        fulfills_commitment: ["quote"],
        accepts: ["acceptance"],
        confirms: ["confirmation"],
        evidences_fee_payment_for: ["payment_evidence"],
      }[edgeType] || [])
      : ({
        responds_to: ["quote_request"],
        answers: ["question"],
        fulfills_commitment: ["commitment"],
        accepts: ["quote"],
        confirms: ["acceptance"],
      }[edgeType] || []);
    for (const type of labelTypes) {
      const key = anchorByMessageAndType.get(`${messageId}:${type}`);
      if (key) return key;
    }
    return "";
  };
  const edges = extracted.edges.map((edge) => ({
    arcKind: edgeArcKind(edge),
    edgeType: edge.type,
    fromAnchorKey: anchorForEdgeEndpoint(edge.from, edge.type, "from"),
    toKind: edge.to.startsWith("awb:") ? "shipment" : "anchor",
    toAnchorKey: edge.to.startsWith("awb:") ? "" : anchorForEdgeEndpoint(edge.to, edge.type, "to"),
    toSubjectKey: edge.to.startsWith("awb:") ? normalizeAwbSerial(edge.to.slice(4)) : "",
  }));
  if (edges.some((edge) => !edge.fromAnchorKey || (edge.toKind === "anchor" && !edge.toAnchorKey))) {
    throw new TypeError("commercial conversation edge could not bind to exact label anchors");
  }
  const conversationKey = `commercial-conversation:v1:${sha256Text(`${caseId || "case"}:${normalizeAwbSerial(awb)}`)}`;
  return {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    exchange: {
      schemaVersion: "commercial-conversation-exchange-v1",
      conversationKey,
      subjectType: "shipment",
      subjectKey: normalizeAwbSerial(awb),
      extractorVersion: EXTRACTOR_VERSION,
      anchors,
      edges,
      productionPublicationAttempted: false,
    },
    candidates,
    productionPublicationAttempted: false,
  };
}

module.exports = {
  AUTHORITY_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  authoredPortion,
  authoredRange,
  buildAuthorityInput,
  classifyMessage,
  extractCase,
  extractLfdAssertion,
};

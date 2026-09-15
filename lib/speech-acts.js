"use strict";

// Speech-act / evidence-eligibility layer — understand the COMMUNICATIVE ACT
// before any message text may mint shipment truth.
//
// The product contract is semantic, not phrasal:
//   - A question about a state is not proof of that state.
//   - A request for a document/status is not proof it exists.
//   - A request to verify something is not confirmation.
//   - A scheduled/future statement is not a completed event.
//   - Quoted prior-thread text is not new proof unless the sender adopts it.
//   - Providing/attaching a document IS evidence; asking for one is not.
//   - A positive assertion by a counterparty can be evidence.
//
// Evidence classifiers call evidenceEligibility(text, topic) FIRST: if every
// clause touching the topic is a question/request/future/quoted clause, the
// classifier must not fire — regardless of which words appear. Regex lives
// inside this module as an implementation detail; the contract callers rely
// on is the act taxonomy.
//
// Anchor case (2026-07-06, 016-80000165): "Has the shipment arrived at PHL?"
// from DHL IL minted arrival-notice-received → the board showed ARRIVED from
// a question. The fix class is act-classification, not another phrase guard.

// ── Act taxonomy ─────────────────────────────────────────────────────────────
const ACTS = {
  ASKS_ABOUT_STATE: "asks_about_state",
  REQUESTS_UPDATE: "requests_update",
  REQUESTS_DOCUMENT: "requests_document",
  ASKS_US_TO_VERIFY: "asks_us_to_verify",
  ASSERTS_STATE: "asserts_state",
  DENIES_STATE: "denies_state",
  PROVIDES_DOCUMENT: "provides_document",
  SCHEDULES_FUTURE_EVENT: "schedules_future_event",
  QUOTES_PRIOR_CONTEXT: "quotes_prior_context",
  UNKNOWN: "unknown_needs_review",
};

// Topic keyword nets: which clauses are ABOUT each evidence family. These are
// deliberately loose — eligibility narrows by ACT, not by tightening topics.
const TOPICS = {
  arrival: /\barriv|on[-\s]?hand|\bnoa\b|notice of arrival|\blanded\b|availab|at (?:the )?(?:station|warehouse|terminal)\b/i,
  release: /releas|clear(?:ed|ance)?|customs|in[-\s]?bond|delivery order|\bd\/?o\b|\b1c\b|\b7501\b|entry/i,
  pickup: /pick[\s-]?up|picked|collect(?:ed|ion)?|\bloaded\b|recover(?:ed|y)?|dispatch/i,
  delivery: /deliver(?:ed|y)?|\bpod\b|proof of delivery|receiver|consignee received|offload|unload|drop(?:ped)?[-\s]?off|handed over/i,
  payment: /\bpaid\b|payment|receipt|invoice settled|fees? (?:paid|settled|received)/i,
};

// ── Clause mechanics ─────────────────────────────────────────────────────────

// Quoted-history markers: everything after these belongs to prior context.
const QUOTE_BOUNDARY_RE = /^(?:>+\s|On .{5,80} wrote:|From:\s|Sent:\s|-{4,}\s*Original Message|_{10,})/im;

function splitCurrentAndQuoted(text) {
  const value = String(text || "");
  const match = value.match(QUOTE_BOUNDARY_RE);
  if (!match || match.index === undefined || match.index < 1) {
    return { current: value, quoted: match && match.index === 0 ? value : "" };
  }
  return { current: value.slice(0, match.index), quoted: value.slice(match.index) };
}

function splitClauses(text) {
  return String(text || "")
    .split(/(?<=[.?!])\s+|\n+|(?<=\?)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 3);
}

// Interrogatives — English direct/indirect + Hebrew.
const QUESTION_LEAD_RE = /^(?:has|have|had|did|does|do|is|are|was|were|can|could|will|would|should|when|what|where|who|why|how|any (?:update|news|word|eta)|is there)\b/i;
const HEBREW_QUESTION_RE = /(?:^|\s)(?:האם|מתי|איפה|למה|כמה|מה קורה עם|יש עדכון)/;

// Announcements — polite ASSERTIONS ("please note that…", "be advised…"):
// informing, never asking. Must be recognized before request detection.
const ANNOUNCEMENT_RE = /^(?:please (?:note|be advised|be informed)|kindly (?:note|be advised)|note that|be advised|be informed|fyi|for your information|just to (?:update|inform)|לידיעתכם|שימו לב)\b/i;

// Requests — an actionable ask directed at us. A bare politeness word is not
// a request; it must pair with a request verb (or be an explicit need/await).
const REQUEST_VERB_RE = /(?:send|share|provide|advise|confirm|verify|check|update|forward|resend|supply|issue|arrange|expedite|chase|follow ?up|clarify|reply|respond|answer|contact|coordinate|let (?:us|me) know)/i;
const REQUEST_LEAD_RE = /\b(?:can you|could you|would you|need(?:ed)?|awaiting|we require|requesting|asking (?:for|about)|send (?:us|me|over)|share (?:the|an?|your)|provide|advise\b|verify|check (?:if|whether|on)|let (?:us|me) know|update (?:us|me)|מבקש|נא לעדכן|תעדכנו)\b/i;
const POLITE_REQUEST_RE = new RegExp("\\b(?:please|pls|kindly|בבקשה)\\b[^.;\\n]{0,40}" + REQUEST_VERB_RE.source, "i");

// "here is the document" — providing, never a request even with "please find".
// "see the POD", "please see POD", "find the delivery order" — pointing the reader at a
// named document IS providing it (INC-2026-07-12b: "Please see POD" was misread as a
// polite REQUEST because "please" led and "see" only matched "see attached", not
// "see <document>"). Questions ("did you see the POD?") are caught by isQuestion first,
// and "see if/whether …" never reaches a document noun, so this stays provision-only.
const PROVIDES_RE = /\b(?:attached(?: is| are| please find)?|please find (?:the |an? )?(?:attached|enclosed)|enclosed (?:is|are|please find)?|see attach|(?:see|find)\s+(?:the\s+|an?\s+|your\s+|our\s+|attached\s+|enclosed\s+|signed\s+)*(?:pods?|proof of delivery|delivery order|d\/?o|delivery receipt|receipts?|invoices?|photos?|images?|attachments?|files?|documents?|docs?|paperwork)|attaching|here (?:is|are)|sending (?:you )?(?:the|an?)|as attached|per (?:the )?attached|מצורפ|רצ"ב)\b/i;

// Future/scheduled — an expectation, not a completed event.
const FUTURE_RE = /\b(?:will (?:be |arrive|land|deliver|pick|clear)|expected (?:to|on|by)|eta\b|scheduled (?:for|to|on)|due (?:to arrive|on|by)|should (?:arrive|land|clear|deliver)|planning to|tomorrow|next (?:week|monday|tuesday|wednesday, ?thursday|friday)|later today|יגיע|צפוי)\b/i;

const NEGATION_RE = /\b(?:not|no|hasn'?t|haven'?t|didn'?t|isn'?t|aren'?t|wasn'?t|never|without|still (?:waiting|pending|open)|yet to)\b|\bלא\b|טרם/i;

// Greetings mask the real lead ("Hello When will you confirm…"): strip them
// before act detection.
const GREETING_RE = /^(?:hello|hi|hey|dear [^,.!\n]{2,40}|good (?:morning|afternoon|evening)|shalom|greetings|היי|שלום)[,!. ]*\s*/i;

function classifyClause(clause) {
  const text = String(clause || "").trim().replace(GREETING_RE, "");
  if (!text) return ACTS.UNKNOWN;
  const isQuestion = /\?\s*$/.test(text) || QUESTION_LEAD_RE.test(text) || HEBREW_QUESTION_RE.test(text);
  const provides = PROVIDES_RE.test(text);
  const announces = ANNOUNCEMENT_RE.test(text);
  const requests = !provides && !announces && (REQUEST_LEAD_RE.test(text) || POLITE_REQUEST_RE.test(text));
  if (isQuestion) return ACTS.ASKS_ABOUT_STATE;
  if (provides) return ACTS.PROVIDES_DOCUMENT;
  if (requests) {
    if (/\b(?:pod|proof of delivery|delivery order|d\/?o\b|awb copy|air ?waybill|docs?|documents?|paperwork|receipt|invoice|release (?:copy|doc))\b/i.test(text)) {
      return ACTS.REQUESTS_DOCUMENT;
    }
    if (/\b(?:verify|check|confirm|double[- ]check)\b/i.test(text)) return ACTS.ASKS_US_TO_VERIFY;
    return ACTS.REQUESTS_UPDATE;
  }
  if (FUTURE_RE.test(text) && !/\b(?:arrived|delivered|picked ?up|released|cleared|landed|received|loaded|recovered|collected|on board|offloaded)\b/i.test(text)) {
    return ACTS.SCHEDULES_FUTURE_EVENT;
  }
  if (NEGATION_RE.test(text)) return ACTS.DENIES_STATE;
  return ACTS.ASSERTS_STATE;
}

// ── Public API ───────────────────────────────────────────────────────────────

// Classify a whole message: per-clause acts for the CURRENT text, with quoted
// prior-thread content kept apart.
function classifyMessageActs(text) {
  const { current, quoted } = splitCurrentAndQuoted(text);
  const clauses = splitClauses(current).map((clause) => ({ clause, act: classifyClause(clause) }));
  return { clauses, quotedText: quoted, currentText: current };
}

const EVIDENCE_ELIGIBLE_ACTS = new Set([ACTS.ASSERTS_STATE, ACTS.PROVIDES_DOCUMENT, ACTS.DENIES_STATE]);

// May this text mint POSITIVE truth for the topic?  Eligible only when at
// least one CURRENT (non-quoted) clause about the topic is an assertion or a
// provided document. Questions, requests, verification asks, and future
// schedules about the topic are never eligible — no matter the wording.
// DENIES_STATE is eligible here only for callers that read negative evidence;
// positive classifiers must still apply their own negation logic.
function evidenceEligibility(text, topic) {
  const topicRe = TOPICS[topic];
  if (!topicRe) return { eligible: true, acts: [], reason: "unknown-topic" };
  const { clauses } = classifyMessageActs(text);
  const topical = clauses.filter(({ clause }) => topicRe.test(clause));
  if (!topical.length) {
    // Nothing in the current message speaks about the topic — the classifier's
    // own logic (e.g., attachment evidence) decides.
    return { eligible: true, acts: [], reason: "no-topical-clause" };
  }
  const acts = topical.map(({ act }) => act);
  const eligible = acts.some((act) => EVIDENCE_ELIGIBLE_ACTS.has(act));
  return {
    eligible,
    acts,
    reason: eligible ? "asserted" : `only:${[...new Set(acts)].join(",")}`,
  };
}

function evidenceEligible(text, topic) {
  return evidenceEligibility(text, topic).eligible;
}

// Does the current message ASK for a status/state update (a communication
// work item, never truth)? True for questions about shipment state and for
// explicit update/status requests.
function isStatusRequest(text) {
  const { clauses } = classifyMessageActs(text);
  return clauses.some(({ clause, act }) =>
    (act === ACTS.ASKS_ABOUT_STATE || act === ACTS.REQUESTS_UPDATE || act === ACTS.ASKS_US_TO_VERIFY) &&
    (Object.values(TOPICS).some((re) => re.test(clause)) || /\bstatus|update|עדכון\b/i.test(clause)));
}

module.exports = {
  ACTS,
  TOPICS,
  classifyMessageActs,
  classifyClause,
  evidenceEligibility,
  evidenceEligible,
  isStatusRequest,
  _test: { splitCurrentAndQuoted, splitClauses },
};

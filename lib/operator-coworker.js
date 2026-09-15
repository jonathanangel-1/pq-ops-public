"use strict";

// Operator-coworker answer layer — the companion answers like a competent
// import-ops colleague, grounded in the product's own truth, never a lookup
// bot. Every answer here derives from canonical packet rows, the Gmail proof
// evidence (message rosters), severity/urgency classification, and the
// customer-safe communication rules. When evidence is genuinely missing the
// answer names the missing source exactly.
//
// Intent classes (broad, not phrase-matched):
//   focus            "top three tasks", "what should I focus on now"
//   changed          "what changed since I last checked"
//   customer-needed  "which shipments need customer updates"
//   waiting-on       "who are we waiting on" (fleet + shipment)
//   last-outbound    "what's the last email we sent about this" (shipment)
//   missing-proof    "what proof is missing" (shipment)
//   customer-draft   "draft a customer update" (shipment)

const { assessShipmentSeverity } = require("./urgent-interrupts");
const { buildCanonicalActionPlan } = require("./action-planner");
const { isOperatorParty, parseAddressList } = require("./action-recipients");
const {
  draftCustomerReply,
  proactiveCustomerUpdate,
  detectCustomerQuestion,
  customerSafeTruth,
} = require("./customer-communication");
const { normalizeAwb } = require("./awb");
const { shipmentRootCause } = require("./root-cause");
const { statePhrase } = require("./ops-query");

const HOURS = 3600 * 1000;

function displayAwb(awb = "") {
  const clean = normalizeAwb(awb);
  return clean.length === 11 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : String(awb || "");
}

function rowState(row = {}) {
  return String(row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || "")
    .toLowerCase().replace(/[\s-]+/g, "_");
}

function rowNextAction(row = {}) {
  return String(
    row.truthPacket?.nextAction?.summary || row.opsState?.nextAction || row.nextAction || "",
  ).trim();
}

function activeRows(rows = []) {
  return rows.filter((row) =>
    !row.completed &&
    String(row.truthPacketRole || "") !== "completed" &&
    !["closed", "delivered"].includes(rowState(row)));
}

function gateStatus(row, name) {
  const gate = (row.truthPacket?.gates || []).find((g) => g.gate === name);
  return String(gate?.status || row.opsState?.gates?.[name]?.status || "").toLowerCase();
}

function gateDone(row, name) {
  return ["done", "true", "released", "cleared", "paid", "delivered", "picked-up", "recovered"].includes(gateStatus(row, name));
}

// ── Intent detection ─────────────────────────────────────────────────────────

// Narrow on purpose: "what should I handle first today?" already has a rich
// morning-queue answer in the intent router (full work queue + action
// packets); this class covers explicit RANKING asks it cannot express.
const FOCUS_RE = /\btop\s+(?:\d+|one|two|three|four|five)\b|\bfocus\b|\bpriorit|most important|biggest (?:task|item|thing|fire)/i;
const CHANGED_RE = /what(?:'s| has| is)? (?:changed|new|different)|changes? since|since i (?:last )?(?:checked|looked)|what happened (?:today|overnight|while i)/i;
const CUSTOMER_NEEDED_RE = /(?:which|what|who|any) .*customer|customers? (?:need|waiting|due|update)|need(?:s|ing)? (?:a |an )?customer update|update (?:the |our )?customers/i;
const WAITING_RE = /who (?:are we|am i|is pikiio)? ?wait|waiting on (?:whom|who)|who owes us|who (?:hasn'?t|has not) (?:replied|answered)|outstanding repl/i;
const UNANSWERED_REQUESTS_RE = /(?:which|what|show|list|any).{0,30}(?:update|status|pod|release|quote|pickup)?\s*requests?.{0,24}(?:unanswered|unfulfilled|unresolved|still open|not completed)|(?:unanswered|unfulfilled|unresolved|open)\s+(?:update|status|pod|release|quote|pickup)?\s*requests?/i;
const LAST_OUTBOUND_RE = /last (?:email|message|thing|note) (?:you|we|pikiio) (?:sent|wrote|drafted)|what did (?:you|we) (?:send|write|ask)(?: them| last)?|last outbound|latest (?:email|message) (?:we|you) sent|when did (?:you|we) last (?:email|write|ask)/i;
const MISSING_PROOF_RE = /what (?:proof|evidence|document|docs?) (?:is|are)? ?(?:still )?missing|missing (?:proof|evidence)|what(?:'s| is) (?:still )?(?:missing|unproven|open to prove)|which gates? (?:are|is) (?:open|missing|unproven)/i;
const CUSTOMER_DRAFT_RE = /draft (?:a |an |the )?(?:customer|client|consignee)|(?:customer|client|consignee) (?:update|reply|email) draft|write .*(?:customer|consignee)/i;
// Colloquial-tolerant on purpose: "why its on hold ?", "whats blocking this",
// "why cant it move" — grammar must never gate a blocker explanation.
const BLOCKER_WHY_RE = /why\b.{0,40}\b(?:hold|held|blocked?|block|stuck|delay|waiting|not (?:mov|releas|pick|clear))|what(?:'?s| is)? (?:blocking|holding|stopping|the hold ?up)|why (?:can'?t|cant|won'?t|wont|isn'?t|is\s*n?o?t) (?:it|we|this)|what happened to (?:it|this)|reason (?:for|of) the (?:hold|block|delay)/i;
const FLEET_INTENTS = new Set(["focus", "changed", "customer-needed", "waiting-on", "unanswered-requests"]);

function coworkerIntentIsFleet(intent = "") {
  return FLEET_INTENTS.has(String(intent || ""));
}

function coworkerIntent(question = "") {
  const text = String(question || "");
  // Customer-update DRAFTING already has a richer companion path (thread-
  // resolved recipient, validated payload) — leave those questions to it.
  if (CUSTOMER_DRAFT_RE.test(text)) return "";
  if (CUSTOMER_NEEDED_RE.test(text) && /which|what|who|any|list|need/i.test(text) && !/draft/i.test(text)) return "customer-needed";
  if (LAST_OUTBOUND_RE.test(text)) return "last-outbound";
  if (UNANSWERED_REQUESTS_RE.test(text)) return "unanswered-requests";
  if (WAITING_RE.test(text)) return "waiting-on";
  if (MISSING_PROOF_RE.test(text)) return "missing-proof";
  if (BLOCKER_WHY_RE.test(text)) return "blocker-why";
  if (CHANGED_RE.test(text)) return "changed";
  if (FOCUS_RE.test(text)) return "focus";
  return "";
}

// ── Evidence helpers ─────────────────────────────────────────────────────────

function proofEventsForAwb(gmailProof, awb) {
  const key = normalizeAwb(awb);
  if (!key) return [];
  const proof = (gmailProof?.proofs || []).find((p) => normalizeAwb(p.awb || p.normalizedAwb) === key);
  return [...(proof?.events || []), ...(proof?.historicalEvents || [])].filter(Boolean);
}

function eventAt(event = {}) {
  return Date.parse(event.at || event.date || "") || 0;
}

function eventIsOutbound(event = {}) {
  const from = parseAddressList(event.from || "")[0];
  return from ? isOperatorParty(from.email) : false;
}

function latestOutboundEvent(events = []) {
  return events
    .filter((event) => (event.from || event.to) && eventIsOutbound(event))
    .sort((a, b) => eventAt(b) - eventAt(a))[0] || null;
}

function counterpartyRoster(event = {}) {
  return [...parseAddressList(event.to || ""), ...parseAddressList(event.cc || "")]
    .filter((entry) => entry.email && !isOperatorParty(entry.email));
}

function shortAge(atMs, now) {
  if (!atMs) return "";
  const hours = Math.max(0, Math.round((now.getTime() - atMs) / HOURS));
  if (hours < 1) return "under an hour ago";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function quietAge(atMs, now) {
  return shortAge(atMs, now).replace(/ ago$/, "");
}

function resultItem(row, reason, action, extra = {}) {
  const stateCode = rowState(row);
  return {
    awb: displayAwb(row.awb),
    station: row.station || "",
    consignee: row.client || row.consignee || row.delivery?.consignee || "",
    state: statePhrase(stateCode),
    stateCode,
    reason,
    action,
    freshness: extra.freshness || "",
    source: "shipment-truth-packets",
    ...extra,
  };
}

// ── focus: rank the day ──────────────────────────────────────────────────────

const SEVERITY_SCORE = { critical: 100, high: 60, normal: 25, quiet: 5 };

function focusAnswer(question, rows, gmailProof, now) {
  const wanted = (() => {
    const m = String(question).match(/top\s+(\d+|one|two|three|four|five)/i);
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    if (!m) return 3;
    return Math.min(8, Number(m[1]) || words[m[1].toLowerCase()] || 3);
  })();
  const scored = activeRows(rows).map((row) => {
    const severity = assessShipmentSeverity(row, { now: now.toISOString() });
    let score = SEVERITY_SCORE[severity.level] ?? 10;
    const state = rowState(row);
    const blocker = row.truthPacket?.operationalBlocker || {};
    if (["customs_hold", "release_needed", "fees_due", "arrived_not_available"].includes(state)) score += 20;
    if (/storage|lfd|last free day/i.test(`${blocker.reason || ""} ${rowNextAction(row)}`)) score += 15;
    // Waiting-on-reply work is real but not "focus now" work.
    const outbound = latestOutboundEvent(proofEventsForAwb(gmailProof, row.awb));
    const waitingFresh = outbound && now.getTime() - eventAt(outbound) < 18 * HOURS;
    if (waitingFresh) score -= 30;
    return { row, severity, score, waitingFresh };
  }).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, wanted);
  const missingProofFor = (row) =>
    ["arrival", "customs", "pickup", "pod"].filter((g) => !gateDone(row, g)).slice(0, 2).join(" + ");
  const lines = top.map(({ row, severity, waitingFresh }, index) => {
    const rootCause = shipmentRootCause(row);
    const why = severity.reason ||
      row.truthPacket?.operationalBlocker?.reason ||
      `${statePhrase(rowState(row))}${waitingFresh ? "; our ask is already out" : ""}`;
    const cause = rootCause.cause ? ` because ${compactText(rootCause.cause, 90).replace(/[.\s]+$/g, "")}` : "";
    const next = rowNextAction(row) || "Review the shipment.";
    return `${index + 1}. ${displayAwb(row.awb)} · ${row.client || row.consignee || ""} · ${row.station || ""} — ${compactText(why, 110).replace(/[.\s]+$/g, "")}${cause}; ${compactText(next, 110)}`;
  });
  return {
    title: `Focus now — top ${top.length}`,
    subtitle: "",
    answer: lines.join("\n") || "Nothing needs attention right now.",
    facts: [],
    actions: [],
    items: top.map(({ row, severity }) => resultItem(
      row,
      severity.reason || (row.truthPacket?.operationalBlocker?.reason || statePhrase(rowState(row))),
      rowNextAction(row) || "Review the shipment",
      { urgency: severity.level, proofNeeded: missingProofFor(row) },
    )),
    shipments: top.map(({ row }) => row),
    context: { topic: "coworker-focus", list: true, shipmentIds: top.map(({ row }) => normalizeAwb(row.awb)) },
  };
}

function compactText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── changed: operational changes, not raw email noise ────────────────────────

const CHANGE_CLASS_RE = /(deliver(?:ed|y completed)|\bpod\b|proof of delivery|picked ?up|נאסף|released|release received|cleared|\b1c\b|arrival notice|notice of arrival|arrived|on hand|payment (?:received|confirmed)|fee(?:s)? paid|awarded|dispatched|pickup scheduled)/i;

function changedAnswer(rows, now, windowHours = 48) {
  const cutoff = now.getTime() - windowHours * HOURS;
  const changes = [];
  for (const row of activeRows(rows)) {
    const facts = [
      ...(row.facts || []),
      ...(row.evidencePacket?.sourceFacts || []),
      ...(row.emailValidation?.events || []),
    ];
    let best = null;
    for (const fact of facts) {
      const at = Date.parse(fact.at || fact.observedAt || "") || 0;
      if (at < cutoff) continue;
      const display = String(fact.summary || fact.claim || fact.evidence || fact.label || "").trim();
      const text = `${fact.type || ""} ${display}`;
      if (!CHANGE_CLASS_RE.test(text)) continue;
      // A CHANGE is a positive truth movement. Negated/waiting phrasing
      // ("not picked up", "POD is not applicable before delivery") and
      // contentless summaries are states, not news.
      if (/\b(?:not|no longer|isn'?t|waiting|pending|unknown|not applicable|needed after|before delivery)\b/i.test(display)) continue;
      if (display.length < 12) continue;
      if (!best || at > best.at) best = { at, text: compactText(display, 120) };
    }
    if (best) changes.push({ row, ...best });
  }
  changes.sort((a, b) => b.at - a.at);
  return {
    title: `Changed in the last ${windowHours}h — ${changes.length} shipment${changes.length === 1 ? "" : "s"}`,
    subtitle: "",
    answer: changes.length
      ? changes.slice(0, 10).map(({ row, text, at }) => `${displayAwb(row.awb)} — ${text} (${shortAge(at, now)})`).join("\n")
      : `No shipment truth changed in the last ${windowHours}h.`,
    facts: [],
    actions: [],
    items: changes.slice(0, 12).map(({ row, text, at }) => resultItem(row, text, rowNextAction(row) || "", { freshness: shortAge(at, now) })),
    shipments: changes.slice(0, 12).map(({ row }) => row),
    context: { topic: "coworker-changed", list: true, shipmentIds: changes.map(({ row }) => normalizeAwb(row.awb)).slice(0, 24) },
  };
}

// ── customer updates ─────────────────────────────────────────────────────────

// Lifecycle moments where a proactive customer update is genuinely useful.
function customerUpdateKindFor(row) {
  // Derive from the same customer-safe truth the draft bodies use, so the
  // update and its grounding can never disagree.
  const truth = customerSafeTruth(row);
  if (truth.delivered) return "delivered_pod_attached";
  if (truth.pickedUp) return "picked_up_out_for_delivery";
  if (truth.released) return "released_arranging_pickup";
  if (truth.arrived) return "arrived_release_pending";
  return "";
}

const CUSTOMER_UPDATE_PHRASES = Object.freeze({
  delivered_pod_attached: "delivered with POD attached",
  picked_up_out_for_delivery: "recovered, out for delivery",
  released_arranging_pickup: "released, arranging recovery",
  arrived_release_pending: "landed, release pending",
});

function customerNeededAnswer(rows, now) {
  const candidates = activeRows(rows)
    .map((row) => ({ row, kind: customerUpdateKindFor(row) }))
    .filter(({ kind }) => kind)
    .map(({ row, kind }) => {
      const update = proactiveCustomerUpdate(kind, row);
      return { row, kind, body: update.blocked ? "" : update.body };
    })
    .filter(({ body }) => body);
  return {
    title: `Customer updates worth sending — ${candidates.length}`,
    subtitle: "",
    answer: candidates.length
      ? candidates.slice(0, 10).map(({ row, body }) => `${displayAwb(row.awb)} · ${row.client || row.consignee || ""} — ${compactText(body, 130)}`).join("\n")
      : "No shipment is at a moment where a customer update adds value right now.",
    facts: [],
    actions: [],
    items: candidates.slice(0, 12).map(({ row, kind, body }) => resultItem(
      row,
      `Customer update ready — ${CUSTOMER_UPDATE_PHRASES[kind]}`,
      compactText(body, 140),
    )),
    shipments: candidates.slice(0, 12).map(({ row }) => row),
    context: { topic: "coworker-customer-needed", list: true, shipmentIds: candidates.map(({ row }) => normalizeAwb(row.awb)).slice(0, 24) },
  };
}

function customerDraftAnswer(row, question) {
  const kind = customerUpdateKindFor(row) || "arrived_release_pending";
  const detected = detectCustomerQuestion(question);
  const draft = detected !== "none"
    ? draftCustomerReply(detected, row)
    : proactiveCustomerUpdate(kind, row);
  const truth = customerSafeTruth(row);
  if (draft.blocked) {
    return {
      title: `${displayAwb(row.awb)} — customer draft withheld`,
      subtitle: "Customer-safe filter",
      answer: `I will not draft that: ${draft.reason} Nothing customer-safe changes hands until the internal detail is removed.`,
      facts: [], actions: [], items: [], shipments: [row],
      context: { awb: normalizeAwb(row.awb), topic: "coworker-customer-draft" },
    };
  }
  return {
    title: `${displayAwb(row.awb)} — customer update draft`,
    subtitle: "Customer-safe · draft only, nothing sends",
    answer: [
      draft.body,
      "",
      `Grounded in: ${truth.delivered ? "delivered" : truth.pickedUp ? "picked up" : truth.released ? "released" : truth.arrived ? "arrived, release in process" : "pre-arrival"} per canonical truth. Internal fees, broker costs, and operational detail are excluded by the customer-safe filter.`,
    ].join("\n"),
    facts: [],
    actions: [{
      id: `${normalizeAwb(row.awb)}-customer-update-draft`,
      type: "customer-update-draft",
      channel: "gmail",
      execution: "draft_gmail_email",
      label: `Customer update — ${displayAwb(row.awb)}`,
      targetName: row.client || row.consignee || "Customer",
      subject: `${displayAwb(row.awb)} — shipment update`,
      body: draft.body,
      status: "suggested",
    }],
    items: [], shipments: [row],
    context: { awb: normalizeAwb(row.awb), topic: "coworker-customer-draft" },
  };
}

// ── last outbound / waiting on ───────────────────────────────────────────────

function lastOutboundAnswer(row, gmailProof, now) {
  const events = proofEventsForAwb(gmailProof, row.awb);
  const outbound = latestOutboundEvent(events);
  if (!outbound) {
    const rosterEvents = events.filter((event) => event.from || event.to).length;
    return {
      title: `${displayAwb(row.awb)} — no outbound on record`,
      subtitle: "",
      answer: [
        `No outbound from us appears in this AWB's ${events.length}-event Gmail evidence${rosterEvents ? " across the captured threads" : "; no sender roster is captured"}${rowNextAction(row) ? `; ${compactText(rowNextAction(row), 140)}` : ""}.`,
        "Anything sent outside those threads or before the evidence window isn't visible here.",
      ].filter(Boolean).join("\n"),
      facts: [], actions: [], items: [], shipments: [row],
      context: { awb: normalizeAwb(row.awb), topic: "coworker-last-outbound" },
    };
  }
  const to = counterpartyRoster(outbound);
  const toText = to.length
    ? to.slice(0, 3).map((entry) => entry.name ? `${entry.name} <${entry.email}>` : entry.email).join(", ")
    : "The thread counterparty";
  const at = eventAt(outbound);
  const ask = compactText(outbound.summary || outbound.evidence || outbound.nextAction || "", 160);
  const replied = events.some((event) => eventAt(event) > at && !eventIsOutbound(event) && (event.from || event.to));
  const thread = outbound.subject
    ? `the “${compactText(outbound.subject, 110)}” thread`
    : outbound.threadId ? "the live thread" : "a thread whose ID isn't captured";
  const sentAt = at
    ? `${new Date(at).toISOString().replace("T", " ").slice(0, 16)}Z (${shortAge(at, now)})`
    : "at an unknown time";
  const askText = ask ? ` asking ${ask}` : "";
  const rosterGap = to.length ? "" : "; the recipient roster isn't captured";
  const next = compactText(rowNextAction(row), 110) || "Re-chase if it stays quiet.";
  return {
    title: `${displayAwb(row.awb)} — last email we sent`,
    subtitle: "",
    answer: replied
      ? `${toText} replied after our email in ${thread}${askText}, sent ${sentAt}; read the newer message before chasing${rosterGap}.`
      : `${toText} hasn't replied to our email in ${thread}${askText}, sent ${sentAt}; ${next}${rosterGap}.`,
    facts: [],
    actions: [],
    items: [], shipments: [row],
    context: { awb: normalizeAwb(row.awb), topic: "coworker-last-outbound", threadId: outbound.threadId || "" },
  };
}

function waitingOnAnswer(rows, gmailProof, now, scopedRow = null) {
  const scope = scopedRow ? [scopedRow] : activeRows(rows);
  const waits = [];
  for (const row of scope) {
    const events = proofEventsForAwb(gmailProof, row.awb);
    const outbound = latestOutboundEvent(events);
    if (!outbound) continue;
    const at = eventAt(outbound);
    const replied = events.some((event) => eventAt(event) > at && !eventIsOutbound(event) && (event.from || event.to));
    if (replied) continue;
    const who = counterpartyRoster(outbound)[0];
    waits.push({
      row,
      who: who ? (who.name || who.email) : "the thread counterparty",
      email: who?.email || "",
      at,
      subject: outbound.subject || "",
    });
  }
  waits.sort((a, b) => a.at - b.at); // longest-waiting first
  if (scopedRow) {
    const wait = waits[0];
    return {
      title: `${displayAwb(scopedRow.awb)} — waiting on`,
      subtitle: "",
      answer: wait
        ? `${wait.who}${wait.email ? ` <${wait.email}>` : ""} hasn't replied to our ${wait.subject ? `“${compactText(wait.subject, 90)}” ` : ""}message; ${quietAge(wait.at, now)} quiet. ${compactText(rowNextAction(scopedRow), 110) || "Re-chase if it stays quiet."}`
        : `No one owes us a reply in this shipment; ${compactText(rowNextAction(scopedRow), 120) || "the move is ours"}.`,
      facts: [], actions: [], items: [], shipments: [scopedRow],
      context: { awb: normalizeAwb(scopedRow.awb), topic: "coworker-waiting" },
    };
  }
  return {
    title: `Waiting on replies — ${waits.length} thread${waits.length === 1 ? "" : "s"}`,
    subtitle: "",
    answer: waits.length
      ? waits.slice(0, 10).map(({ row, who, at, subject }) => `${who} owes us a reply on ${displayAwb(row.awb)} — ${quietAge(at, now)} quiet${subject ? ` in “${compactText(subject, 70)}”` : ""}.`).join("\n")
      : "No unanswered outbound asks remain in the captured threads.",
    facts: [], actions: [],
    items: waits.slice(0, 12).map(({ row, who, at }) => resultItem(row, `${who} owes us a reply — ${quietAge(at, now)} quiet`, rowNextAction(row) || "")),
    shipments: waits.slice(0, 12).map(({ row }) => row),
    context: { topic: "coworker-waiting", list: true, shipmentIds: waits.map(({ row }) => normalizeAwb(row.awb)).slice(0, 24) },
  };
}

const ACTIVE_REQUEST_STATUSES = new Set(["queued", "running", "waiting_external", "waiting-external", "sent", "failed"]);
const POD_FULFILLMENT_PATTERN =
  /\b(?:signed\s+pod|pod|proof of delivery|signed delivery receipt|receiver signature)\b[^.;\n]{0,80}\b(?:attached|received|provided|included|available|signed)\b|\b(?:attached|received|provided|included|available|signed)\b[^.;\n]{0,80}\b(?:signed\s+pod|pod|proof of delivery|signed delivery receipt|receiver signature)\b/i;
const POD_STILL_PENDING_PATTERN =
  /\b(?:pod|proof of delivery|signed delivery receipt|receiver signature)\b[^.;\n]{0,60}\b(?:will follow|to follow|pending|missing|not available|not ready|later|tomorrow)\b|\b(?:no|not|without|awaiting|waiting for)\b[^.;\n]{0,40}\b(?:pod|proof of delivery|signed delivery receipt|receiver signature)\b/i;
const REQUEST_TOPIC_PATTERNS = [
  [/\b(?:customs|release|clearance|d\/?o|delivery order|entry)\b/i, /\b(?:customs|release|released|clear|cleared|hold|reject|d\/?o|delivery order|entry)\b/i],
  [/\b(?:quote|rate|price|cost)\b/i, /\b(?:quote|rate|price|cost|declin|no bid)\b/i],
  [/\b(?:pickup|driver|dispatch|broker)\b/i, /\b(?:pickup|picked|driver|dispatch|loaded|delivery|pod|block)\b/i],
  [/\b(?:arrival|arrived|on[- ]hand|available|station)\b/i, /\b(?:arrival|arrived|on[- ]hand|available|piece|station|block)\b/i],
  [/\b(?:storage|last free|lfd|fee)\b/i, /\b(?:storage|last free|lfd|fee|paid|receipt)\b/i],
];

function requestTimeMs(request = {}) {
  for (const value of [request.sentAt, request.queuedAt, request.draftedAt, request.createdAt, request.requestedAt, request.updatedAt]) {
    const at = Date.parse(value || "");
    if (Number.isFinite(at)) return at;
  }
  return 0;
}

function requestText(request = {}) {
  return [request.type, request.label, request.subject, request.reason, request.body].filter(Boolean).join(" ");
}

function inboundSatisfiesRequest(event = {}, request = {}) {
  const eventText = [event.type, event.label, event.subject, event.summary, event.evidence, event.claim].filter(Boolean).join(" ");
  const ask = requestText(request);
  if (/\b(?:pod|proof of delivery|signed delivery)\b/i.test(ask)) {
    return !POD_STILL_PENDING_PATTERN.test(eventText) && POD_FULFILLMENT_PATTERN.test(eventText);
  }
  const topic = REQUEST_TOPIC_PATTERNS.find(([askPattern]) => askPattern.test(ask));
  if (topic) return topic[1].test(eventText);
  return /\b(?:confirmed|received|attached|released|available|picked|delivered|answered|resolved|complete)\b/i.test(eventText);
}

function requestWasSatisfied(request, gmailProof) {
  const requestedAt = requestTimeMs(request);
  if (!requestedAt) return false;
  const requestThread = String(request.gmailThreadId || request.threadId || request.conversation?.threadId || "");
  return proofEventsForAwb(gmailProof, request.awb || request.shipmentId).some((event) => {
    if (!event.from || eventIsOutbound(event) || eventAt(event) <= requestedAt) return false;
    const eventThread = String(event.threadId || event.gmailThreadId || "");
    if (requestThread && requestThread !== eventThread) return false;
    return inboundSatisfiesRequest(event, request);
  });
}

function requestSnapshotWarning(requestRecords = {}, now = new Date()) {
  const sharedTime = requestRecords.snapshotTime || "";
  const sources = [
    { name: "outbox-requests", snapshot: requestRecords.outbox, roster: requestRecords.outboxRequests || requestRecords.outbox?.requests },
    { name: "action-queue", snapshot: requestRecords.actionQueue, roster: Array.isArray(requestRecords.actionQueue) ? requestRecords.actionQueue : requestRecords.actionQueue?.actions },
  ];
  const unavailable = sources.filter(({ snapshot, roster }) => !snapshot && !Array.isArray(roster)).map(({ name }) => name);
  const undated = sources.filter(({ snapshot, roster }) => (snapshot || Array.isArray(roster)) && !Number.isFinite(Date.parse(snapshot?.snapshotTime || sharedTime))).map(({ name }) => name);
  if (unavailable.length || undated.length) {
    const gaps = [
      unavailable.length ? `${unavailable.join(", ")} unavailable` : "",
      undated.length ? `${undated.join(", ")} snapshot time missing` : "",
    ].filter(Boolean).join("; ");
    return `${gaps}; check current request records before treating this list as complete`;
  }
  const times = sources.map(({ snapshot }) => Date.parse(snapshot?.snapshotTime || sharedTime)).filter(Number.isFinite);
  const oldestHours = Math.max(...times.map((at) => (now.getTime() - at) / HOURS));
  if (oldestHours < 24) return "";
  return `Request records are ${Math.round(oldestHours / 24)}d old; check for newer replies before treating this list as complete`;
}

function unansweredRequestsAnswer(rows, gmailProof, requestRecords = {}, now = new Date(), scopedRow = null) {
  const rowByAwb = new Map((scopedRow ? [scopedRow] : activeRows(rows)).map((row) => [normalizeAwb(row.awb || row.id), row]));
  const outboxSnapshot = requestRecords.outbox && !Array.isArray(requestRecords.outbox) ? requestRecords.outbox : {};
  const outbox = Array.isArray(requestRecords.outboxRequests)
    ? requestRecords.outboxRequests
    : Array.isArray(outboxSnapshot.requests) ? outboxSnapshot.requests : [];
  const queueSnapshot = requestRecords.actionQueue && !Array.isArray(requestRecords.actionQueue) ? requestRecords.actionQueue : {};
  const queue = Array.isArray(requestRecords.actionQueue)
    ? requestRecords.actionQueue
    : Array.isArray(queueSnapshot.actions) ? queueSnapshot.actions : [];
  const outboxActionIds = new Set(outbox.map((request) => String(request.actionId || request.id || "")).filter(Boolean));
  const records = [
    ...outbox.map((request) => ({ ...request, _sourceType: "outbox-requests", _sourceId: request.id || request.actionId || "record" })),
    ...queue
      .filter((action) => !outboxActionIds.has(String(action.id || action.actionId || "")))
      .map((action) => ({ ...action, _sourceType: "action-queue", _sourceId: action.id || action.actionId || "record" })),
  ];
  const outstanding = records
    .filter((request) => ACTIVE_REQUEST_STATUSES.has(String(request.status || "").toLowerCase()))
    .map((request) => ({ request, row: rowByAwb.get(normalizeAwb(request.awb || request.shipmentId)) }))
    .filter(({ row }) => row)
    .filter(({ request }) => !requestWasSatisfied(request, gmailProof))
    .sort((a, b) => (requestTimeMs(a.request) || Number.MAX_SAFE_INTEGER) - (requestTimeMs(b.request) || Number.MAX_SAFE_INTEGER));
  const warning = requestSnapshotWarning(requestRecords, now);
  const lineFor = ({ request, row }) => {
    const status = String(request.status || "open").toLowerCase();
    const internal = ["queued", "running", "drafted", "failed"].includes(status);
    const statusText = internal
      ? `${status}, so send isn't proven`
      : `${status} with no matching inbound`;
    const ask = compactText(request.label || request.subject || request.reason || request.type || "update request", 110);
    return `${ask} for ${displayAwb(row.awb)} is ${statusText}${requestTimeMs(request) ? ` — ${shortAge(requestTimeMs(request), now)}` : " — age unknown"}.`;
  };
  const caveat = [warning, outstanding.length ? "replies outside captured Gmail aren't visible here" : ""]
    .filter(Boolean)
    .join("; ");
  return {
    title: `Unfulfilled update requests — ${outstanding.length}`,
    subtitle: "",
    answer: [
      outstanding.length
        ? outstanding.slice(0, 12).map(lineFor).join("\n")
        : "No open issued or queued request appears in the captured records.",
      caveat ? `${caveat}.` : "",
    ].filter(Boolean).join("\n"),
    facts: [],
    actions: [],
    items: outstanding.slice(0, 12).map(({ request, row }) => resultItem(
      row,
      `${request.label || request.subject || request.type || "Update request"} (${request.status || "open"})`,
      rowNextAction(row),
      { source: `${request._sourceType}/${request._sourceId}`, freshness: requestTimeMs(request) ? shortAge(requestTimeMs(request), now) : "age unknown" },
    )),
    shipments: outstanding.slice(0, 12).map(({ row }) => row),
    context: { topic: "coworker-unanswered-requests", list: true, shipmentIds: outstanding.map(({ row }) => normalizeAwb(row.awb)).slice(0, 24) },
  };
}

// ── blocker explanation: cause → owner → evidence → cost → next move ─────────

// Fact snippets carry raw email noise; a cause line must read clean.
function cleanCauseText(value, max = 160) {
  return compactText(
    String(value || "")
      .replace(/<https?:[^>]*>?/gi, "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/["“”]+/g, "")
      .replace(/\s*[—-]\s*$/, ""),
    max,
  );
}

function blockedGateFor(row) {
  return (row.truthPacket?.gates || []).find((gate) =>
    ["blocked", "hold", "customs-hold", "exam-hold", "exception", "problem"].includes(String(gate.status || "").toLowerCase()));
}

// The counterparty who OWNS the blocker — customs holds belong to the customs
// broker, fee/storage blocks to the station, delivery waits to the receiver.
function blockerOwnerFor(row, blockerType, gateName) {
  const kind = String(blockerType || gateName || "").toLowerCase();
  const contact = (relation, role) => {
    const name = relation?.name || relation?.broker || relation?.company || "";
    const email = relation?.contactEmail || relation?.email || "";
    return (name || email) ? { role, name: name || email, email } : null;
  };
  if (/customs|release|clearance|inbond|exam|hold/.test(kind)) {
    return contact(row.customsBroker, "customs broker") || contact(row.contacts?.customsBroker, "customs broker");
  }
  if (/fee|storage|ground|payment/.test(kind)) {
    return contact(row.station && typeof row.station === "object" ? row.station : row.contacts?.station, "station") ||
      contact(row.stationContext, "station");
  }
  if (/receiver|consignee|delivery/.test(kind)) {
    const name = row.delivery?.consignee || row.consignee || row.client || "";
    return name ? { role: "receiver", name, email: "" } : null;
  }
  return null;
}

function canonicalPlanFor(row, gmailProof) {
  try {
    const byAwb = new Map((gmailProof?.proofs || []).map((proof) => [normalizeAwb(proof.awb || proof.normalizedAwb), proof]));
    return buildCanonicalActionPlan(row, [], { gmailProofByAwb: byAwb });
  } catch {
    return { primaryAction: null };
  }
}

function storageExposureLine(row) {
  const factText = [...(row.facts || []), ...(row.evidencePacket?.sourceFacts || [])]
    .map((fact) => `${fact.summary || fact.claim || ""}`).filter((t) => /storage|lfd|last free/i.test(t)).join(" ");
  const text = `${row.storage?.summary || ""} ${row.truthPacket?.feeLedger?.storageSummary || ""} ${JSON.stringify(row.truthPacket?.feeLedger?.storageRisk || "")} ${row.currentState || ""} ${factText}`;
  const rate = text.match(/\$\s?\d+(?:\.\d+)?\s?\/\s?day/);
  const started = /storage[^.]{0,40}(?:start|passed|accru|active)/i.test(text);
  if (rate && started) return `${rate[0].replace(/\s/g, "")} burning while it sits.`;
  if (rate) return `${rate[0].replace(/\s/g, "")} starts when free time ends.`;
  if (/last free day|lfd/i.test(text)) return "LFD pressure is live; clear it before storage starts.";
  return "";
}

function blockerWhyAnswer(row, gmailProof, now) {
  // Advisory notes and "no active blocker" reconciliation stubs are not
  // blockers — answering "why blocked" from them would invent a hold.
  const rawBlocker = row.truthPacket?.operationalBlocker || null;
  const blocker = rawBlocker &&
    String(rawBlocker.status || "") !== "advisory" &&
    !/no active blocker/i.test(String(rawBlocker.reason || ""))
    ? rawBlocker : null;
  const gate = blockedGateFor(row);
  const state = rowState(row);
  const plan = canonicalPlanFor(row, gmailProof);
  const primary = plan.primaryAction || null;
  const nextLine = primary
    ? `${primary.label || primary.type}${primary.targetEmail ? ` — reply in the live thread to ${primary.targetEmail}` : ""}`
    : compactText(rowNextAction(row), 120);
  const blocked = Boolean(blocker || gate || /hold|blocked|exception|fees_due|release_needed/.test(state));
  if (!blocked) {
    return {
      title: `${displayAwb(row.awb)} — nothing is blocking it`,
      subtitle: "",
      answer: `${statePhrase(state)}; nothing in canonical truth is blocking it${nextLine ? `; ${nextLine.replace(/[.\s]+$/g, "")}` : ""}.`,
      facts: [], actions: primary ? [primary] : [], items: [], shipments: [row],
      context: { awb: normalizeAwb(row.awb), topic: "coworker-blocker-why" },
    };
  }
  const rootCause = shipmentRootCause(row);
  const owner = blockerOwnerFor(row, blocker?.type, gate?.gate);
  const blockerState = statePhrase(blocker?.type || state);
  const ownerDisplay = owner
    ? `${owner.name}${owner.email ? ` <${owner.email}>` : ""}, the ${owner.role}`
    : "";
  // NO-BS rule: a state echo is not a cause. Either the evidence names what
  // must be solved, or the answer says exactly that gap out loud.
  const causeLine = rootCause.unexplained
    ? `${blockerState} is active, but no rejection reason, missing document, or discrepancy is in evidence${owner ? `; ask ${owner.name} for the exact reason first` : ""}.`
    : `${ownerDisplay ? `${ownerDisplay}, owns the ${blockerState}` : blockerState}: ${cleanCauseText(rootCause.cause)}${rootCause.causeAt ? ` (${shortAge(rootCause.causeAt, now).replace(/ ago$/, " old")} evidence)` : ""}.`;
  const progressLines = rootCause.progress.map(({ text, at }) =>
    `Later, ${text}${at ? ` (${shortAge(at, now)})` : ""}.`);
  const lines = [
    causeLine,
    ...progressLines,
    storageExposureLine(row),
    nextLine ? `${nextLine.replace(/[.\s]+$/g, "")}.` : "",
  ].filter(Boolean);
  return {
    title: `${displayAwb(row.awb)} — why it is ${blockerState.includes("hold") ? "on hold" : "blocked"}`,
    subtitle: "",
    answer: lines.join(" "),
    facts: [],
    actions: primary ? [primary] : [],
    items: [], shipments: [row],
    context: { awb: normalizeAwb(row.awb), topic: "coworker-blocker-why" },
  };
}

// ── missing proof ────────────────────────────────────────────────────────────

const GATE_WHY = {
  arrival: "On-hand isn't proven; dispatching recovery risks a dry run",
  customs: "Release/D/O isn't proven; the driver can be turned away",
  pickup: "Loaded/recovery proof is missing; delivery and POD promises are guesses",
  pod: "Signed POD is missing; the file stays open and billing waits",
};
const GATE_ORDER = ["arrival", "customs", "pickup", "pod"];

function missingProofAnswer(row) {
  const state = rowState(row);
  const relevant = GATE_ORDER.filter((gate) => {
    if (["picked_up", "out_for_delivery", "pod_needed", "delivered", "closed"].includes(state)) {
      return gate === "pod" || (gate === "pickup" && !gateDone(row, "pickup"));
    }
    return true;
  });
  const missing = relevant.filter((gate) => !gateDone(row, gate));
  return {
    title: `${displayAwb(row.awb)} — missing proof`,
    subtitle: "",
    answer: missing.length
      ? `${missing.map((gate) => GATE_WHY[gate]).join("; ")}.${rowNextAction(row) ? ` ${compactText(rowNextAction(row), 130)}` : ""}`
      : "Every required lifecycle gate is proven; nothing is assumed.",
    facts: [], actions: [], items: [], shipments: [row],
    context: { awb: normalizeAwb(row.awb), topic: "coworker-missing-proof" },
  };
}

// ── entry ────────────────────────────────────────────────────────────────────

function coworkerAnswer({ question = "", rows = [], gmailProof = null, requestRecords = {}, shipment = null, now = new Date(), intent: forcedIntent = "" } = {}) {
  const intent = forcedIntent || coworkerIntent(question);
  if (!intent) return null;
  // The `shipment` argument is an INTENTIONAL scope decided by the caller
  // (desktop cockpit, or an explicit context the client set). Always honor it.
  // The phone ambient-selection hijack is prevented upstream: the client clears
  // scope for fleet questions (opsBrainQuestionIsFleetScoped), and the companion
  // never derives a shipment from ambient context for a fleet intent.
  const needsShipment = ["last-outbound", "missing-proof", "customer-draft", "blocker-why"].includes(intent);
  if (needsShipment && !shipment) {
    return {
      title: "Which shipment?",
      subtitle: "Shipment-scoped question",
      answer: "That is a per-shipment question — open the shipment (or name the AWB) and ask again.",
      facts: [], actions: [], items: [], shipments: [],
      context: { topic: `coworker-${intent}-needs-awb` },
    };
  }
  switch (intent) {
    case "focus": return focusAnswer(question, rows, gmailProof, now);
    case "changed": return changedAnswer(rows, now);
    case "customer-needed": return customerNeededAnswer(rows, now);
    case "waiting-on": return waitingOnAnswer(rows, gmailProof, now, shipment);
    case "unanswered-requests": return unansweredRequestsAnswer(rows, gmailProof, requestRecords, now, shipment);
    case "last-outbound": return lastOutboundAnswer(shipment, gmailProof, now);
    case "missing-proof": return missingProofAnswer(shipment);
    case "blocker-why": return blockerWhyAnswer(shipment, gmailProof, now);
    case "customer-draft": return customerDraftAnswer(shipment, question);
    default: return null;
  }
}

module.exports = {
  coworkerAnswer,
  coworkerIntent,
  coworkerIntentIsFleet,
  _test: {
    focusAnswer,
    changedAnswer,
    customerNeededAnswer,
    waitingOnAnswer,
    unansweredRequestsAnswer,
    requestWasSatisfied,
    lastOutboundAnswer,
    missingProofAnswer,
    blockerWhyAnswer,
    customerDraftAnswer,
    latestOutboundEvent,
    customerUpdateKindFor,
  },
};
